// Ads API.
//
//   POST /api/ads/generate     — wizard Step 4 endpoint. Expands the
//                                wizard payload, creates a CampaignRun,
//                                kicks off rendering in the background,
//                                returns 202 with the runId immediately.
//   GET  /api/ads/runs/:runId  — polled by the frontend to watch
//                                progress (counts + status).
//   GET  /api/ads              — ads page list. Filters by brandId,
//                                optional campaignId / status / etc.
//   GET  /api/ads/:id          — full Ad doc for the detail modal.
//
// Rendering happens in-process via setImmediate (no external queue).
// If the web service restarts mid-run, ads that already persisted
// stay; the run hangs in 'running' until the poller times out and
// surfaces it. Phase 1B: move to BullMQ for durability + concurrency.

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const Ad           = require('../models/Ad');
const CampaignRun  = require('../models/CampaignRun');
const { expandWizardJob } = require('../services/campaignAdsGenerationService');
const { renderCreative }  = require('../services/renderService');
const { deleteFromCloudinary } = require('../services/cloudinaryService');

const AD_STATUSES = ['draft', 'live', 'archived'];

// Render concurrency. Puppeteer + Cloudinary is the bottleneck;
// running too many in parallel on the small Render instance OOMs
// Chromium. 2 in flight at once is a safe starting point.
const RENDER_CONCURRENCY = parseInt(process.env.RENDER_CONCURRENCY || '2', 10);

// Hard cap on creatives per generation. Cartesian expansion
// (products × templates × supported ratios) blows up fast and a
// 20-render run takes long enough that tail renders accumulate
// Chromium memory pressure. 5 keeps a single run inside one
// Chromium-warm window.
const MAX_CREATIVES_PER_RUN = parseInt(process.env.MAX_CREATIVES_PER_RUN || '5', 10);

// POST /api/ads/generate
// Body: { campaignId, productIds, mediaIds, templateIds, cta:{text,url}, urlParams }
// Response: 202 Accepted { campaignRunId, total, status: 'running' }
router.post('/generate', async (req, res) => {
  try {
    const {
      campaignId,
      productIds  = [],
      mediaIds    = [],
      templateIds = [],
      cta         = {},
      urlParams   = '',
      refresh     = false   // wizard checkbox / smoke-test override; bypasses de-dupe + LayoutInputArtifact cache
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
      refresh,
      requestedBy: req.user?.userId || null
    });

    if (!job.creatives.length) {
      return res.status(422).json({
        error: 'No renderable creatives — no media available for the selected products / templates',
        job
      });
    }

    // Cap creatives per run. The wizard's cartesian (products ×
    // templates × supported ratios) routinely produces 20+ creatives,
    // which both blows past Chromium's warm-window and produces more
    // ads than an operator wants to triage in one batch.
    if (job.creatives.length > MAX_CREATIVES_PER_RUN) {
      console.log(
        `   ✂️  capping creatives ${job.creatives.length} → ${MAX_CREATIVES_PER_RUN} (campaign=${campaignId})`
      );
      job.creatives = job.creatives.slice(0, MAX_CREATIVES_PER_RUN);
    }

    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // 2. Mint a short-lived JWT for the render service to authenticate
    //    inside Puppeteer. Same shape as the OAuth-callback token so
    //    requireAuth resolves req.user the same way; 1h TTL is plenty
    //    for the longest batch and short enough to bound blast radius
    //    if the token leaked. Replaces the long-lived RENDER_AUTH_TOKEN
    //    env var that operators had to hand-refresh every 24h.
    const renderToken = jwt.sign(
      {
        id:     req.user?.id,
        userId: req.user?.userId,
        email:  req.user?.email,
        name:   req.user?.name,
        photo:  req.user?.photo
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // 3. Create the run doc up front so the frontend can poll
    //    immediately on the redirect.
    const run = await CampaignRun.create({
      runId,
      brandId:      job.brandId,
      campaignId:   job.campaignId,
      campaignKind: job.campaignKind,
      total:        job.creatives.length,
      status:       'running',
      requestedBy:  req.user?.userId || null,
      startedAt:    new Date()
    });

    // 3. Respond 202 — frontend redirects to /ads?campaignRunId=X and
    //    starts polling /api/ads/runs/:runId for progress.
    res.status(202).json({
      campaignRunId: runId,
      campaignId:    job.campaignId,
      brandId:       job.brandId,
      campaignKind:  job.campaignKind,
      total:         job.creatives.length,
      status:        'running'
    });

    // 5. Fire-and-forget the render loop. setImmediate yields the
    //    HTTP response first, then renders happen behind the scenes.
    setImmediate(() => {
      runRenderLoop(run, job, renderToken).catch(err => {
        console.error(`❌ campaign run ${runId} crashed:`, err);
        CampaignRun.updateOne(
          { _id: run._id },
          { status: 'failed', completedAt: new Date() }
        ).catch(() => {});
      });
    });

  } catch (err) {
    console.error('ads generate failed:', err);
    res.status(500).json({ error: err.message || 'ads generate failed' });
  }
});

// Background render loop. Runs after the response has flushed; updates
// the CampaignRun doc as each creative finishes so the frontend's
// poller can show real-time progress.
async function runRenderLoop(run, job, renderToken) {
  const t0 = Date.now();
  console.log(
    `🚀 [campaignRun ${run.runId}] start — ${job.creatives.length} creative(s) ` +
    `concurrency=${RENDER_CONCURRENCY} brand=${job.brandId} campaign=${job.campaignId} kind=${job.campaignKind || '-'}`
  );

  const queue = job.creatives.map((c, i) => ({ creative: c, index: i }));
  let inflight = 0;
  let next     = 0;

  await new Promise((resolve) => {
    const dispatch = () => {
      while (inflight < RENDER_CONCURRENCY && next < queue.length) {
        const { creative, index } = queue[next++];
        inflight++;
        renderOne(run, job, creative, index, renderToken)
          .catch(err => {
            console.error(`❌ [campaignRun ${run.runId}] #${index} dispatch crash:`, err.message || err);
          })
          .finally(() => {
            inflight--;
            if (next >= queue.length && inflight === 0) resolve();
            else dispatch();
          });
      }
    };
    dispatch();
  });

  await CampaignRun.updateOne(
    { _id: run._id },
    { status: 'done', completedAt: new Date() }
  );
  const totalMs = Date.now() - t0;
  const final = await CampaignRun.findById(run._id).select('succeeded skipped failed').lean();
  console.log(
    `🎉 [campaignRun ${run.runId}] done in ${totalMs}ms — ` +
    `${final?.succeeded || 0} succeeded · ${final?.skipped || 0} skipped · ${final?.failed || 0} failed`
  );
}

async function renderOne(run, job, creative, index, renderToken) {
  try {
    const result = await renderCreative({
      jobId:         crypto.randomBytes(8).toString('hex'),
      campaignId:    job.campaignId,
      campaignRunId: run.runId,
      brandId:       job.brandId,
      campaignKind:  job.campaignKind,
      creative,
      cta:           job.cta,
      authToken:     renderToken,
      options:       { refresh: !!job.options.refresh }
    });

    if (result.status === 'success') {
      await CampaignRun.updateOne({ _id: run._id }, { $inc: { succeeded: 1 } });
    } else if (result.status === 'skipped') {
      await CampaignRun.updateOne({ _id: run._id }, { $inc: { skipped: 1 } });
    } else {
      await CampaignRun.updateOne(
        { _id: run._id },
        {
          $inc: { failed: 1 },
          $push: { errors: buildErrorEntry(creative, index, result.stage, result.error) }
        }
      );
    }
  } catch (err) {
    await CampaignRun.updateOne(
      { _id: run._id },
      {
        $inc: { failed: 1 },
        $push: { errors: buildErrorEntry(creative, index, 'crash', err) }
      }
    );
  }
}

// Normalize an error (string | Error | {stage, message, retryable}) into a
// flat row that fits CampaignRun.errors[]. The renderService surfaces
// per-stage errors as objects, so we have to extract .message rather
// than letting Mongoose stringify the whole object (which fails the
// String cast on errors[].message).
function buildErrorEntry(creative, index, stageHint, errLike) {
  const errStage = (errLike && typeof errLike === 'object' && errLike.stage)
    ? errLike.stage
    : (stageHint || 'unknown');
  let message;
  if (errLike instanceof Error) {
    message = errLike.message || String(errLike);
  } else if (errLike && typeof errLike === 'object') {
    message = errLike.message || JSON.stringify(errLike);
  } else {
    message = errLike ? String(errLike) : 'unknown';
  }
  return {
    index,
    stage:       errStage,
    template:    creative.template,
    aspectRatio: creative.aspectRatio,
    mediaId:     creative.mediaId   ? String(creative.mediaId)   : null,
    productId:   creative.productId ? String(creative.productId) : null,
    message
  };
}

// GET /api/ads/runs/:runId — poll endpoint for the progress UI.
// Filters by brandId so a tenant can only see their own runs.
router.get('/runs/:runId', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    const run = await CampaignRun.findOne({ runId: req.params.runId, brandId }).lean();
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json({
      runId:        run.runId,
      brandId:      String(run.brandId),
      campaignId:   String(run.campaignId),
      campaignKind: run.campaignKind,
      total:        run.total,
      succeeded:    run.succeeded,
      skipped:      run.skipped,
      failed:       run.failed,
      status:       run.status,
      errors:       run.errors || [],
      startedAt:    run.startedAt,
      completedAt:  run.completedAt
    });
  } catch (err) {
    console.error('run fetch failed:', err);
    res.status(500).json({ error: err.message || 'run fetch failed' });
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

    // Tenant scoping — Ad uses brandId, not advertiserId, so the
    // generic tenantFilter() doesn't apply. The brandId filter above
    // is itself tenant-scoping (a brand belongs to exactly one
    // advertiser). Belt-and-braces verification at the brand level
    // is a separate hardening step (see backlog).
    const [rows, total] = await Promise.all([
      Ad.find(filter)
        .sort({ generatedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Ad.countDocuments(filter)
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

// PATCH /api/ads/:id — flip status. Body: { status: 'draft' | 'live' | 'archived' }.
// Caller passes ?brandId or X-Brand-Id so the lookup is tenant-scoped.
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    const { status } = req.body || {};
    if (!AD_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${AD_STATUSES.join(', ')}` });
    }
    const ad = await Ad.findOneAndUpdate(
      { _id: req.params.id, brandId },
      { status, updatedAt: new Date() },
      { new: true }
    ).lean();
    if (!ad) return res.status(404).json({ error: 'ad not found' });
    res.json({ ad: projectAd(ad, /* full */ true) });
  } catch (err) {
    console.error('ad patch failed:', err);
    res.status(500).json({ error: err.message || 'ad update failed' });
  }
});

// DELETE /api/ads/:id — remove the Ad doc and best-effort destroy
// the Cloudinary asset. Cloudinary errors are surfaced as warnings
// in the response but never block the Mongo delete; orphaned
// Cloudinary assets are easier to clean up later than orphaned Ad
// docs pointing at dead URLs.
router.delete('/:id', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    const ad = await Ad.findOneAndDelete({ _id: req.params.id, brandId }).lean();
    if (!ad) return res.status(404).json({ error: 'ad not found' });
    let cloudinary = null;
    if (ad.renderUrl) {
      cloudinary = await deleteFromCloudinary(ad.renderUrl);
    }
    res.json({ ok: true, id: String(ad._id), cloudinary });
  } catch (err) {
    console.error('ad delete failed:', err);
    res.status(500).json({ error: err.message || 'ad delete failed' });
  }
});

// GET /api/ads/:id — full doc for detail modal.
// Caller must pass ?brandId=X (or X-Brand-Id header) so we can scope
// the lookup to their tenant. Same Ad-uses-brandId-not-advertiserId
// reasoning as the list query above.
router.get('/:id', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    const ad = await Ad.findOne({ _id: req.params.id, brandId }).lean();
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
