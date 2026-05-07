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
const router = express.Router();

const Ad           = require('../models/Ad');
const CampaignRun  = require('../models/CampaignRun');
const { tenantFilter } = require('../middleware/tenantHelpers');
const { expandWizardJob } = require('../services/campaignAdsGenerationService');
const { renderCreative }  = require('../services/renderService');

// Render concurrency. Puppeteer + Cloudinary is the bottleneck;
// running too many in parallel on the small Render instance OOMs
// Chromium. 2 in flight at once is a safe starting point.
const RENDER_CONCURRENCY = parseInt(process.env.RENDER_CONCURRENCY || '2', 10);

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

    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // 2. Create the run doc up front so the frontend can poll
    //    immediately on the redirect.
    const run = await CampaignRun.create({
      runId,
      brandId:      job.brandId,
      campaignId:   job.campaignId,
      campaignKind: job.campaignKind,
      total:        job.creatives.length,
      status:       'running',
      requestedBy:  req.user?.id || null,
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

    // 4. Fire-and-forget the render loop. setImmediate yields the
    //    HTTP response first, then renders happen behind the scenes.
    setImmediate(() => {
      runRenderLoop(run, job).catch(err => {
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
async function runRenderLoop(run, job) {
  const queue = job.creatives.map((c, i) => ({ creative: c, index: i }));
  let inflight = 0;
  let next     = 0;

  await new Promise((resolve) => {
    const dispatch = () => {
      while (inflight < RENDER_CONCURRENCY && next < queue.length) {
        const { creative, index } = queue[next++];
        inflight++;
        renderOne(run, job, creative, index)
          .catch(err => {
            console.error(`❌ render ${run.runId}#${index} crashed:`, err);
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
}

async function renderOne(run, job, creative, index) {
  try {
    const result = await renderCreative({
      jobId:         crypto.randomBytes(8).toString('hex'),
      campaignId:    job.campaignId,
      campaignRunId: run.runId,
      brandId:       job.brandId,
      campaignKind:  job.campaignKind,
      creative,
      cta:           job.cta,
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
          $push: { errors: {
            index,
            stage:       result.stage  || 'unknown',
            template:    creative.template,
            aspectRatio: creative.aspectRatio,
            mediaId:     creative.mediaId   ? String(creative.mediaId)   : null,
            productId:   creative.productId ? String(creative.productId) : null,
            message:     result.error || 'unknown'
          } }
        }
      );
    }
  } catch (err) {
    await CampaignRun.updateOne(
      { _id: run._id },
      {
        $inc: { failed: 1 },
        $push: { errors: {
          index,
          stage:       'crash',
          template:    creative.template,
          aspectRatio: creative.aspectRatio,
          mediaId:     creative.mediaId   ? String(creative.mediaId)   : null,
          productId:   creative.productId ? String(creative.productId) : null,
          message:     err.message || String(err)
        } }
      }
    );
  }
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
