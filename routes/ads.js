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
const Media        = require('../models/Media');
const CropArtifact = require('../models/CropArtifact');
const Campaign     = require('../models/Campaign');
const CampaignRun  = require('../models/CampaignRun');
const { expandWizardJob, selectAdsForRun } = require('../services/campaignAdsGenerationService');
const { renderCreative }  = require('../services/renderService');
const { deleteFromCloudinary } = require('../services/cloudinaryService');
const { buildVideoCompositeUrl } = require('../services/videoCompositeService');
const registry = require('../services/templateRegistry');

// Lifecycle states the PATCH endpoint can flip an Ad into. queued /
// rendering / failed are set by the pipeline only — operators don't
// manually drive those.
const AD_STATUSES = ['draft', 'live', 'archived'];

// Render concurrency. Puppeteer + Cloudinary is the bottleneck;
// running too many in parallel on the small Render instance OOMs
// Chromium. 2 in flight at once is a safe starting point.
const RENDER_CONCURRENCY = parseInt(process.env.RENDER_CONCURRENCY || '2', 10);

// Hard cap on creatives per generation. Cartesian expansion
// (products × templates × supported ratios) blows up fast. 6 fits
// comfortably inside Chromium's warm-render window AND aligns with
// the wizard's 2 templates × 3 shipping ratios = 6 baseline output
// for a single seed.
const MAX_CREATIVES_PER_RUN = parseInt(process.env.MAX_CREATIVES_PER_RUN || '6', 10);

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

    // 1. Expand the wizard payload — bulk-queues every viable combination as
    //    Ad docs with status='queued'. Re-running with the same picks is
    //    idempotent (unique index on campaignId+identityDigest swallows dups).
    const job = await expandWizardJob({
      campaignId,
      productIds,
      mediaIds,
      templateIds,
      cta,
      urlParams,
      requestedBy: req.user?.userId || null
    });

    if (job.queuedCount === 0) {
      return res.status(422).json({
        error: 'No renderable creatives — no media available for the selected products / templates',
        job
      });
    }

    // 2. Pick the top N queued ads for this run, ranked by readinessScore.
    //    Subsequent "render more" passes will draw the next N from what
    //    remains queued.
    const adIds = await selectAdsForRun({ campaignId, limit: MAX_CREATIVES_PER_RUN });
    if (!adIds.length) {
      return res.status(422).json({
        error: 'No queued ads selected for this run (selection returned empty)',
        job
      });
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

    // 2b. Persist the operator's picks back to the campaign so the
    //     campaign's pinned strip reflects what was used. $addToSet
    //     keeps re-runs idempotent (duplicates collapse). Picks made
    //     via the wizard's deep-link entry points (Media Library +
    //     Catalog Browser → Generate Ads) wouldn't otherwise land on
    //     the campaign — only the explicit "Add to Campaign" affordance
    //     wrote to those arrays before this.
    if (productIds.length || mediaIds.length) {
      const setOps = {};
      if (productIds.length) setOps.matchedProductIds = { $each: productIds };
      if (mediaIds.length)   setOps.mediaIds          = { $each: mediaIds };
      await Campaign.updateOne(
        { _id: campaignId },
        { $addToSet: setOps }
      ).catch(err => {
        // Non-fatal — the ads still generate; we just lose the pin.
        console.warn(`   ⚠️  campaign pin failed for ${campaignId}: ${err.message}`);
      });
    }

    // 3. Mark the selected ads as picked for this run + stamp campaignRunId.
    //    Done up-front so a server restart leaves the doc in a recognizable
    //    rendering state rather than orphaned-but-queued.
    await Ad.updateMany(
      { _id: { $in: adIds } },
      { $set: { campaignRunId: runId, status: 'rendering', updatedAt: new Date() } }
    );

    // 4. Create the run doc.
    const run = await CampaignRun.create({
      runId,
      brandId:      job.brandId,
      campaignId:   job.campaignId,
      campaignKind: job.campaignKind,
      total:        adIds.length,
      status:       'running',
      requestedBy:  req.user?.userId || null,
      startedAt:    new Date()
    });

    // 5. Respond 202 — frontend redirects to /ads?campaignRunId=X and
    //    polls /api/ads/runs/:runId for progress.
    res.status(202).json({
      campaignRunId: runId,
      campaignId:    job.campaignId,
      brandId:       job.brandId,
      campaignKind:  job.campaignKind,
      total:         adIds.length,
      queuedRemaining: Math.max(0, job.queuedCount - adIds.length),
      status:        'running'
    });

    // 6. Fire-and-forget the render loop.
    setImmediate(() => {
      runRenderLoop(run, job, adIds, renderToken).catch(err => {
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
// the CampaignRun doc as each render finishes so the frontend's
// poller can show real-time progress.
async function runRenderLoop(run, job, adIds, renderToken) {
  const t0 = Date.now();
  console.log(
    `🚀 [campaignRun ${run.runId}] start — ${adIds.length} ad(s) ` +
    `concurrency=${RENDER_CONCURRENCY} brand=${job.brandId} campaign=${job.campaignId} kind=${job.campaignKind || '-'}`
  );

  const queue = adIds.map((adId, i) => ({ adId, index: i }));
  let inflight = 0;
  let next     = 0;

  await new Promise((resolve) => {
    const dispatch = () => {
      while (inflight < RENDER_CONCURRENCY && next < queue.length) {
        const { adId, index } = queue[next++];
        inflight++;
        renderOne(run, job, adId, index, renderToken)
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

async function renderOne(run, job, adId, index, renderToken) {
  // Fetch the queued Ad doc and shape it into the request the
  // render service expects. The doc carries everything the old
  // in-memory creative descriptor used to provide.
  const ad = await Ad.findById(adId).lean();
  if (!ad) {
    await CampaignRun.updateOne(
      { _id: run._id },
      { $inc: { failed: 1 }, $push: { errors: { index, stage: 'fetch', message: `Ad ${adId} not found` } } }
    );
    return;
  }
  const creative = {
    mediaId:     String(ad.mediaId),
    productId:   ad.productId ? String(ad.productId) : null,
    template:    ad.template,
    aspectRatio: ad.aspectRatio,
    matchTier:   ad.matchTier,
    variantKind: ad.variantKind
  };
  try {
    const result = await renderCreative({
      jobId:         crypto.randomBytes(8).toString('hex'),
      adId:          String(ad._id),
      campaignId:    job.campaignId,
      campaignRunId: run.runId,
      brandId:       job.brandId,
      campaignKind:  job.campaignKind,
      creative,
      cta:           { text: ad.ctaText, url: ad.ctaUrl, params: ad.ctaUrlParams },
      authToken:     renderToken,
      options:       {}
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
      // Mark the Ad failed with diagnostic context.
      const errMsg = typeof result.error === 'object' ? (result.error.message || JSON.stringify(result.error)) : String(result.error || 'unknown');
      await Ad.updateOne(
        { _id: adId },
        {
          $set: {
            status:      'failed',
            renderError: { message: errMsg, stage: result.stage || 'unknown', at: new Date() },
            updatedAt:   new Date()
          },
          $inc: { renderAttempts: 1 }
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
    await Ad.updateOne(
      { _id: adId },
      {
        $set: {
          status:      'failed',
          renderError: { message: err.message || String(err), stage: 'crash', at: new Date() },
          updatedAt:   new Date()
        },
        $inc: { renderAttempts: 1 }
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

// POST /api/ads/preview-video-composite
// Diagnostic endpoint — given a video Media + template + ratio + an
// already-uploaded transparent-slot overlay PNG URL, return the
// Cloudinary composite video URL. Useful for previewing the V1
// video render before wiring it through the full Puppeteer path.
//
// Body: { mediaId, template, aspectRatio, overlayImageUrl }
// Response: { compositeUrl, slotRect, canvasDims, smartCropBbox }
router.post('/preview-video-composite', express.json(), async (req, res) => {
  try {
    const { mediaId, template, aspectRatio, overlayImageUrl, overlayPublicId } = req.body || {};
    if (!mediaId)         return res.status(400).json({ error: 'mediaId required' });
    if (!template)        return res.status(400).json({ error: 'template required' });
    if (!aspectRatio)     return res.status(400).json({ error: 'aspectRatio required' });
    if (!overlayImageUrl && !overlayPublicId) {
      return res.status(400).json({ error: 'overlayImageUrl or overlayPublicId required' });
    }

    const media = await Media.findById(mediaId).lean();
    if (!media) return res.status(404).json({ error: `media not found: ${mediaId}` });
    if (media.fileType !== 'video') {
      return res.status(400).json({ error: `media ${mediaId} is not video (fileType=${media.fileType})` });
    }
    if (!media.fileUrl?.includes('/video/upload/')) {
      return res.status(400).json({ error: 'media.fileUrl is not a Cloudinary /video/upload/ URL' });
    }

    const canvasVariant = registry.CANVAS?.templates?.[template]?.variants?.[aspectRatio];
    if (!canvasVariant) {
      return res.status(400).json({ error: `no canvas variant for ${template}/${aspectRatio}` });
    }
    const canvasDims = { w: canvasVariant.canvas?.width, h: canvasVariant.canvas?.height };
    const slotZone = (canvasVariant.zones || []).find(z =>
      z.kind === 'media' && z.slot === 'product.hero_media');
    if (!slotZone?.rect) {
      return res.status(400).json({ error: `template ${template}/${aspectRatio} has no media slot — fall back to image render` });
    }

    // Smart-crop bbox (subject-aware framing on the source video). Pull
    // the judge winner for the SLOT'S source ratio so the cropped clip
    // matches the slot proportions.
    const cropDoc = media.latestArtifacts?.crops
      ? await CropArtifact.findById(media.latestArtifacts.crops).lean()
      : null;
    const slotRatioName = pickClosestBaseRatio(slotZone.rect);
    const winnerId = cropDoc?.winners?.[slotRatioName] || null;
    const list = cropDoc?.smartCrops?.[slotRatioName] || [];
    const winner = list.find(c => c.id === winnerId) || list[0] || null;
    const smartCropBbox = winner ? {
      x1: Number(winner.x1), y1: Number(winner.y1),
      x2: Number(winner.x2), y2: Number(winner.y2)
    } : null;

    const compositeUrl = buildVideoCompositeUrl({
      sourceVideoUrl: media.fileUrl,
      overlayPublicId,
      overlayImageUrl,
      canvasDims,
      slotRect: slotZone.rect,
      smartCropBbox
    });

    res.json({
      compositeUrl,
      sourceVideoUrl: media.fileUrl,
      canvasDims,
      slotRect: slotZone.rect,
      slotSourceRatio: slotRatioName,
      smartCropBbox
    });
  } catch (err) {
    console.error('preview-video-composite failed:', err);
    res.status(500).json({ error: err.message || 'preview failed' });
  }
});

// Pick the base smart-crop ratio (5:4, 1:1, 4:5) closest to the slot's
// shape — same logic the layout-input service uses for hero source crops.
function pickClosestBaseRatio(rect) {
  if (!rect?.w || !rect?.h) return '1:1';
  const target = rect.w / rect.h;
  const opts = [
    { name: '5:4', value: 5/4 },
    { name: '1:1', value: 1   },
    { name: '4:5', value: 4/5 }
  ];
  let best = opts[0], bestDiff = Math.abs(opts[0].value - target);
  for (const o of opts) {
    const d = Math.abs(o.value - target);
    if (d < bestDiff) { bestDiff = d; best = o; }
  }
  return best.name;
}

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
    campaignId:         ad.campaignId ? String(ad.campaignId) : null,
    campaignRunId:      ad.campaignRunId,
    mediaId:            ad.mediaId   ? String(ad.mediaId)   : null,
    productId:          ad.productId ? String(ad.productId) : null,
    template:           ad.template,
    aspectRatio:        ad.aspectRatio,
    matchTier:          ad.matchTier,
    variantKind:        ad.variantKind,
    readinessScore:     ad.readinessScore,
    campaignKind:       ad.campaignKind,
    kind:               ad.kind,
    renderUrl:          ad.renderUrl,
    posterUrl:          ad.posterUrl,
    width:              ad.width,
    height:             ad.height,
    bytes:              ad.bytes,
    durationMs:         ad.durationMs,
    copy:               ad.copy || {},
    ctaText:            ad.ctaText,
    ctaUrl:             ad.ctaUrl,
    ctaUrlParams:       ad.ctaUrlParams,
    status:             ad.status,
    queuedAt:           ad.queuedAt,
    renderedAt:         ad.renderedAt,
    generatedAt:        ad.generatedAt,
    createdAt:          ad.createdAt
  };
  if (full) {
    base.layoutInputArtifactId = ad.layoutInputArtifactId ? String(ad.layoutInputArtifactId) : null;
    base.cloudinaryPublicId    = ad.cloudinaryPublicId;
    base.identityDigest        = ad.identityDigest;
    base.renderError           = ad.renderError || null;
    base.renderAttempts        = ad.renderAttempts || 0;
  }
  return base;
}

module.exports = router;
