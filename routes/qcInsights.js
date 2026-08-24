'use strict';
/**
 * QC-insights HTTP surface. PLATFORM-WIDE, not tenant-scoped — gated the
 * same way /api/admin is: router.use(requireUserOnly) then
 * router.use(requireSuperAdmin), so a future route added to this file
 * cannot forget the gate. Mounted bare in index.js.
 *
 * WHY THIS IS ADMIN-ONLY, NOT JUST TENANT-AUTHENTICATED (found in review,
 * closed before it shipped — see scripts/verifyAdminSettingsAuthz.js-style
 * coverage in scripts/verifyQcInsights.js for the regression pins):
 * `qcInsightsService.collectWindowData()` deliberately has NO
 * brandId/advertiserId filter — the whole point of the aggregation is to
 * find category-level patterns ACROSS every brand's Ads, so a report can
 * and does name a specific product category that effectively identifies a
 * brand (e.g. `categoryTop='fishing shirt'` is Pelagic on this catalog).
 * Tenant-scoped `requireAuth` would let any authenticated member of ANY
 * workspace read every other workspace's QC performance data via
 * GET /latest, /history, /report, and — once QC_INSIGHTS_PROPOSALS_ENABLED
 * is turned on — trigger a real paid LLM call via POST /run with no tenant
 * restriction and no rate limit beyond the single in-process
 * `isRunning()` flag (see that function's own doc comment: it bounds
 * concurrency per web instance, not per deployment, and bounds
 * concurrency, not rate — a caller can still run it repeatedly in series).
 * Restricting the surface to super-admins is the fix for both the data-
 * exposure question and the money question at once, matching this file's
 * earlier /config removal (see git history / docs/QC-FEEDBACK-LOOP.md):
 * one platform-wide control surface, one gate, not a per-route judgment
 * call about which endpoint is "safe enough" for tenant auth.
 *
 *   GET  /latest
 *   GET  /history?limit=
 *   GET  /report?id=
 *   POST /run
 *
 * DELIBERATELY NO /config HERE. The static/video vision-QC gate's
 * read/write surface lives EXCLUSIVELY at GET/PATCH /api/admin/qc-config
 * (routes/admin.js). Two endpoints controlling the same tri-state field is
 * itself a bug (single source of truth, imported — never a second
 * implementation of the same control, even if both were equally gated).
 * Do not re-add a config route here.
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const requireUserOnly   = require('../middleware/requireUserOnly');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const QcInsightsReport = require('../models/QcInsightsReport');
const insights = require('../services/qcInsightsService');
const { buildQcInsightsHtml } = require('../services/qcInsightsPageService');

router.use(requireUserOnly);
router.use(requireSuperAdmin);

router.get('/latest', async (req, res) => {
  try {
    const doc = await QcInsightsReport.findOne({}).sort({ generatedAt: -1 }).lean();
    if (!doc) return res.status(404).json({ error: 'no qc-insights report yet' });
    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'latest failed' });
  }
});

router.get('/history', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 30;
    limit = Math.min(90, limit);
    const rows = await QcInsightsReport.find({})
      .sort({ generatedAt: -1 })
      .limit(limit)
      .select('-findingsClusters -proposalsProvenance')
      .lean();
    return res.json({ reports: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'history failed' });
  }
});

router.get('/report', async (req, res) => {
  try {
    const id = req.query.id;
    let doc = null;
    if (id) {
      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).send('invalid report id');
      }
      doc = await QcInsightsReport.findById(id).lean();
    } else {
      doc = await QcInsightsReport.findOne({}).sort({ generatedAt: -1 }).lean();
    }
    if (!doc) {
      return res.status(404).send('<!DOCTYPE html><html><body><p>No QC insights report yet.</p></body></html>');
    }
    const history = await QcInsightsReport.find({})
      .sort({ generatedAt: -1 })
      .limit(30)
      .select('generatedAt totals qcConfig')
      .lean();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(buildQcInsightsHtml({ report: doc, history }));
  } catch (err) {
    // JSON, not raw HTML interpolation — matching every other handler in
    // this file. Nothing on this route can currently put attacker/DB text
    // into err.message (the only input, ?id=, is ObjectId-validated above
    // before any query runs), but an unescaped template literal handed to
    // res.send() is a live XSS sink the moment any future error path here
    // ever echoes request- or DB-derived text. Found in review; fixed
    // rather than left as "not reachable today".
    return res.status(500).json({ error: err.message || 'report failed' });
  }
});

router.post('/run', async (req, res) => {
  try {
    if (insights.isRunning()) {
      return res.status(409).json({ error: 'qc-insights run already in flight' });
    }
    const report = await insights.runNow();
    await insights.maybeAttachProposals(report);
    return res.json({
      reportId: report._id,
      generatedAt: report.generatedAt,
      totals: report.totals
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || 'run failed' });
  }
});

module.exports = router;
