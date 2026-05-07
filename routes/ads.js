// Ads API.
//
//   POST /api/ads/generate — wizard Step 4 endpoint. Takes operator
//                            selections, expands via campaignAdsGeneration
//                            Service, fans out renderCreative calls,
//                            returns a summary + the created Ad ids.
//   GET  /api/ads          — ads page list. Filters by brandId
//                            (required), optional campaignId / status /
//                            template / aspectRatio. Returns the
//                            on-doc copy snapshot + render URL so the
//                            UI doesn't need a second round-trip.
//   GET  /api/ads/:id      — full Ad doc for the detail modal.
//
// Generate is SYNCHRONOUS in V1 — each renderCreative call is fast
// while render + upload are stubbed. When Puppeteer + Cloudinary swap
// in, each call grows to ~5-15s and we'll move this to a queue
// (Phase 1B per the deferred render-service plan).

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const Ad = require('../models/Ad');
const { tenantFilter } = require('../middleware/tenantHelpers');
const { expandWizardJob } = require('../services/campaignAdsGenerationService');
const { renderCreative }  = require('../services/renderService');

// POST /api/ads/generate
// Body: { campaignId, productIds, mediaIds, templateIds, cta:{text,url}, urlParams }
router.post('/generate', async (req, res) => {
  try {
    const {
      campaignId,
      productIds  = [],
      mediaIds    = [],
      templateIds = [],
      cta         = {},
      urlParams   = ''
    } = req.body || {};

    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
    if (!templateIds.length) return res.status(400).json({ error: 'templateIds required (at least 1 template)' });

    // 1. Expand the wizard payload into a fully-resolved RenderCampaignJob.
    const job = await expandWizardJob({
      campaignId,
      productIds,
      mediaIds,
      templateIds,
      cta,
      urlParams,
      requestedBy: req.user?.id ? String(req.user.id) : null
    });

    if (!job.creatives.length) {
      return res.status(422).json({
        error: 'No renderable creatives — no media available for the selected products / templates',
        job
      });
    }

    const campaignRunId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // 2. Fan out renderCreative for each creative entry. Sync for V1.
    //    Bookkeeping: collect per-status counts + the full result list
    //    so the wizard can route to the ads page with knowledge of
    //    what landed vs what was skipped vs what failed.
    const results = [];
    let succeeded = 0, skipped = 0, failed = 0;

    for (const creative of job.creatives) {
      const result = await renderCreative({
        jobId:         crypto.randomBytes(8).toString('hex'),
        campaignId:    job.campaignId,
        campaignRunId,
        brandId:       job.brandId,
        campaignKind:  job.campaignKind,
        creative,
        cta:           job.cta,
        options:       { refresh: !!job.options.refresh }
      });
      results.push(result);
      if (result.status === 'success') succeeded++;
      else if (result.status === 'skipped') skipped++;
      else failed++;
    }

    res.json({
      campaignRunId,
      campaignId:   job.campaignId,
      brandId:      job.brandId,
      campaignKind: job.campaignKind,
      total:        job.creatives.length,
      succeeded,
      skipped,
      failed,
      results
    });
  } catch (err) {
    console.error('ads generate failed:', err);
    res.status(500).json({ error: err.message || 'ads generate failed' });
  }
});

// GET /api/ads?brandId=X[&campaignId=Y][&status=draft|live|archived][&template=...][&aspectRatio=...][&limit=50]
router.get('/', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    const filter = { brandId };
    if (req.query.campaignId)  filter.campaignId  = req.query.campaignId;
    if (req.query.status)      filter.status      = req.query.status;
    if (req.query.template)    filter.template    = req.query.template;
    if (req.query.aspectRatio) filter.aspectRatio = req.query.aspectRatio;

    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit  || '50', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

    const [rows, total] = await Promise.all([
      Ad.find(tenantFilter(req, filter))
        .sort({ generatedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Ad.countDocuments(tenantFilter(req, filter))
    ]);

    res.json({
      ads: rows.map(projectAd),
      total,
      limit,
      offset
    });
  } catch (err) {
    console.error('ads list failed:', err);
    res.status(500).json({ error: err.message || 'ads list failed' });
  }
});

// GET /api/ads/:id — full doc for detail modal.
router.get('/:id', async (req, res) => {
  try {
    const ad = await Ad.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!ad) return res.status(404).json({ error: 'ad not found' });
    res.json({ ad: projectAd(ad, /* full */ true) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'ad fetch failed' });
  }
});

function projectAd(ad, full = false) {
  const base = {
    id:                 String(ad._id),
    brandId:            String(ad.brandId),
    campaignId:         String(ad.campaignId),
    campaignRunId:      ad.campaignRunId,
    mediaId:            ad.mediaId   ? String(ad.mediaId)   : null,
    productId:          ad.productId ? String(ad.productId) : null,
    template:           ad.template,
    aspectRatio:        ad.aspectRatio,
    mediaSource:        ad.mediaSource,
    campaignKind:       ad.campaignKind,
    kind:               ad.kind,
    renderUrl:          ad.renderUrl,
    posterUrl:          ad.posterUrl,
    width:              ad.width,
    height:             ad.height,
    bytes:              ad.bytes,
    durationMs:         ad.durationMs,
    copy:               ad.copy || {},
    ctaUrl:             ad.ctaUrl,
    ctaUrlParams:       ad.ctaUrlParams,
    status:             ad.status,
    generatedAt:        ad.generatedAt,
    createdAt:          ad.createdAt
  };
  if (full) {
    base.layoutInputArtifactId = ad.layoutInputArtifactId ? String(ad.layoutInputArtifactId) : null;
    base.cloudinaryPublicId    = ad.cloudinaryPublicId;
    base.derivationDigest      = ad.derivationDigest;
  }
  return base;
}

module.exports = router;
