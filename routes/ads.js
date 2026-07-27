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
const mongoose = require('mongoose');
const router = express.Router();

const Ad           = require('../models/Ad');
const Media        = require('../models/Media');
const Brand        = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const CropArtifact = require('../models/CropArtifact');
const Campaign     = require('../models/Campaign');
const CampaignRun  = require('../models/CampaignRun');
const { expandWizardJob, selectAdsForRun } = require('../services/campaignAdsGenerationService');
const { renderCreative }        = require('../services/renderService');
const { generateForAd: veoGenerateForAd, prepareStoryboard: veoPrepareStoryboard } = require('../services/videoRouter');
const { buildVideoSegmentUrl, buildPromptScaffold } = require('../services/atlasVideoService');
const { loadCategoryChainForProduct } = require('../services/categoryChainService');
const { deleteFromCloudinary } = require('../services/cloudinaryService');
const { buildVideoCompositeUrl } = require('../services/videoCompositeService');
const { buildPreviewHtmlForAd }  = require('../services/adPreviewPageService');
const registry = require('../services/templateRegistry');
const { tenantFilter, assertBrandInTenant, assertCampaignInTenant } = require('../middleware/tenantHelpers');

// Shared body-field validation for /preview + /generate Phase 3 params.
// Returns { ok:true, fields } or { ok:false, status, error }.
function parsePhase3WizardFields(body = {}) {
  const {
    directorVariants = false,
    seedMediaIds = [],
    // Ordered (productId, mediaId) pairs. Supersedes seedMediaIds when present.
    // Exists because a flat mediaId list cannot express which product a related/
    // social post is seeding, nor the same post seeding TWO products — the
    // backend had to guess from matchedProducts, and that guess could flip if
    // detect rewrote its scores, changing the ad's identityDigest.
    // seedMediaIds is retained so links and clients minted before this keep
    // working (expandDeterministicVideo still resolves those by association).
    seedPicks = null,
    videoPromptGuidance = null,
    videoPromptRaw = null
  } = body;

  if (videoPromptGuidance != null && videoPromptGuidance !== '') {
    if (typeof videoPromptGuidance !== 'string' || videoPromptGuidance.length > 1000) {
      return { ok: false, status: 400, error: 'videoPromptGuidance must be a string ≤1000 characters' };
    }
  }
  if (videoPromptRaw != null && videoPromptRaw !== '') {
    if (typeof videoPromptRaw !== 'string' || videoPromptRaw.length > 4000) {
      return { ok: false, status: 400, error: 'videoPromptRaw must be a string ≤4000 characters' };
    }
  }
  if (seedMediaIds != null && seedMediaIds !== undefined) {
    if (!Array.isArray(seedMediaIds)) {
      return { ok: false, status: 400, error: 'seedMediaIds must be an array of ObjectId strings' };
    }
    for (const id of seedMediaIds) {
      if (!mongoose.isValidObjectId(id)) {
        return { ok: false, status: 400, error: `seedMediaIds entry is not a valid ObjectId: ${id}` };
      }
    }
  }

  let parsedSeedPicks = null;
  if (seedPicks != null) {
    if (!Array.isArray(seedPicks)) {
      return { ok: false, status: 400, error: 'seedPicks must be an array of { productId, mediaId }' };
    }
    // Bound the array. Spend is already capped downstream (one ad per product,
    // references clamped to the model's maxReferenceImages), so a huge array
    // cannot run up a bill — but it can bloat the request, the Ad rows and this
    // validation loop. 200 pairs is ~28 products at a full 7-reference stack,
    // far past any real run.
    if (seedPicks.length > 200) {
      return { ok: false, status: 400, error: 'seedPicks may not exceed 200 entries' };
    }
    parsedSeedPicks = [];
    const seenPairs = new Set();
    for (const p of seedPicks) {
      if (!p || typeof p !== 'object') {
        return { ok: false, status: 400, error: 'seedPicks entry must be an object with productId and mediaId' };
      }
      if (!mongoose.isValidObjectId(p.productId)) {
        return { ok: false, status: 400, error: `seedPicks productId is not a valid ObjectId: ${p.productId}` };
      }
      if (!mongoose.isValidObjectId(p.mediaId)) {
        return { ok: false, status: 400, error: `seedPicks mediaId is not a valid ObjectId: ${p.mediaId}` };
      }
      // Same media may legitimately appear under DIFFERENT products (one
      // flat-lay seeding two SKUs' videos), so dedupe on the PAIR, not on
      // mediaId. A repeated identical pair is an operator double-click, not
      // an instruction to send the image twice.
      const key = `${String(p.productId)}|${String(p.mediaId)}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      parsedSeedPicks.push({ productId: String(p.productId), mediaId: String(p.mediaId) });
    }
  }

  return {
    ok: true,
    fields: {
      directorVariants: !!directorVariants,
      seedPicks: parsedSeedPicks,
      seedMediaIds: Array.isArray(seedMediaIds) ? seedMediaIds : [],
      videoPromptGuidance: (typeof videoPromptGuidance === 'string' && videoPromptGuidance.trim())
        ? videoPromptGuidance
        : null,
      videoPromptRaw: (typeof videoPromptRaw === 'string' && videoPromptRaw.trim())
        ? videoPromptRaw
        : null
    }
  };
}

// Lifecycle states the PATCH endpoint can flip an Ad into. queued /
// rendering / failed are set by the pipeline only — operators don't
// manually drive those.
const AD_STATUSES = ['draft', 'live', 'archived'];

// Render concurrency. Puppeteer + Cloudinary is the bottleneck;
// running too many in parallel on the small Render instance OOMs
// Chromium. 2 in flight at once is a safe starting point.
const RENDER_CONCURRENCY     = parseInt(process.env.RENDER_CONCURRENCY     || '2', 10);
const VEO_CONCURRENCY        = parseInt(process.env.VEO_CONCURRENCY        || '1', 10);

// Hard cap on creatives per generation. Cartesian expansion
// (products × templates × supported ratios) blows up fast. Bumped
// from 6 to 20 after the wizard simplification — the operator no
// longer picks 1-2 templates, so the default fanout grew (all 5
// ai_* templates × 4 concepts), and a 6-cap meant only a slice of
// the seed × template × concept matrix ever rendered per run.
// 20 still fits inside Chromium's warm-render window at concurrency
// 2 in roughly 10-15 minutes — adjust POLL_TIMEOUT_MS in the Ads
// page if you push this further.
const MAX_CREATIVES_PER_RUN = parseInt(process.env.MAX_CREATIVES_PER_RUN || '20', 10);

// POST /api/ads/preview
// Same body as /generate. Runs the entire seed assembly + cartesian +
// caps WITHOUT inserting Ad docs. Returns the would-be payload counts
// grouped by productId + variantKind so the wizard can show the
// operator the expansion math before they hit Generate. Cheap relative
// to /generate (no LLM, no DB writes) but still issues the matchedMedia
// + ProductMatchArtifact reads — call once on Step 2/3 entry, not on
// every keystroke.
router.post('/preview', async (req, res) => {
  try {
    const {
      campaignId,
      productIds  = [],
      mediaIds    = [],
      templateIds = [],
      cta         = {},
      urlParams   = '',
      platformFormat = null,   // Phase 2 wizard override; null → use campaign.platformFormat
      kinds          = null,   // 'image' | 'video' | 'both'; null → use campaign.adKinds
      excludePairings = [],
      includeCategoryMatched = false,
      includeBrandMatched    = false,
      videoDurationSec = null
    } = req.body || {};
    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
    if (!templateIds.length) return res.status(400).json({ error: 'templateIds required (at least 1 template)' });

    const phase3 = parsePhase3WizardFields(req.body || {});
    if (!phase3.ok) return res.status(phase3.status).json({ error: phase3.error });

    try {
      await assertCampaignInTenant(campaignId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }

    const job = await expandWizardJob({
      campaignId,
      productIds,
      mediaIds,
      templateIds,
      cta,
      urlParams,
      platformFormat,
      kinds,
      excludePairings,
      includeCategoryMatched,
      includeBrandMatched,
      videoDurationSec,
      directorVariants: phase3.fields.directorVariants,
      seedMediaIds: phase3.fields.seedMediaIds,
      seedPicks: phase3.fields.seedPicks,
      videoPromptGuidance: phase3.fields.videoPromptGuidance,
      videoPromptRaw: phase3.fields.videoPromptRaw,
      requestedBy: req.user?.userId || null,
      dryRun: true
    });
    res.json(job);
  } catch (err) {
    console.error(`❌ POST /api/ads/preview failed: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message || 'preview failed' });
  }
});

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
      platformFormat = null,   // Phase 2 wizard override; null → use campaign.platformFormat
      kinds          = null,   // 'image' | 'video' | 'both'; null → use campaign.adKinds
      // [{ productId, mediaId }] — operator-deselected pairings from
      // the Step 2 picker. Forwarded into expandWizardJob to drop the
      // matching tuples from the cartesian.
      excludePairings = [],
      // Tier-expansion toggles from the Step 2 picker (product-kind
      // view). Default false — product campaigns only include
      // product_match (strict tier 1) UGC unless the operator clicked
      // the "Include category-matched" / "Include brand-matched"
      // expand buttons.
      includeCategoryMatched = false,
      includeBrandMatched    = false,
      refresh     = false,  // wizard checkbox / smoke-test override; bypasses de-dupe + LayoutInputArtifact cache
      videoDurationSec = null  // wizard format-selection stage; integer 1–15, null = standard 8s
    } = req.body || {};

    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
    if (!templateIds.length) return res.status(400).json({ error: 'templateIds required (at least 1 template)' });

    const phase3 = parsePhase3WizardFields(req.body || {});
    if (!phase3.ok) return res.status(phase3.status).json({ error: phase3.error });

    // Per-ad video duration from the wizard. Optional; when present must
    // be an integer 1..15. null/''/absent → service default (standard 8s).
    let parsedVideoDurationSec = null;
    if (videoDurationSec !== undefined && videoDurationSec !== null && videoDurationSec !== '') {
      const n = Number(videoDurationSec);
      if (!Number.isInteger(n) || n < 1 || n > 15) {
        return res.status(400).json({ error: 'videoDurationSec must be an integer 1–15' });
      }
      parsedVideoDurationSec = n;
    }

    // Account-setup gate — refuse generation while any connected source
    // has detect in flight or hasn't completed. Mirrors the gate on
    // POST /api/campaigns so a campaign created before the gate landed
    // still can't generate ads on a half-ingested brand. brandId is
    // resolved from the Campaign so the wizard caller doesn't have to
    // re-pass it. Tenant-scoped so cross-tenant campaignIds 404.
    const gateCampaign = await Campaign.findOne(tenantFilter(req, { _id: campaignId })).select('brandId').lean();
    if (!gateCampaign) return res.status(404).json({ error: 'campaign not found' });
    const { getAdReadiness } = require('../services/adReadinessService');
    const readiness = await getAdReadiness(gateCampaign.brandId);
    if (!readiness.ready) {
      return res.status(409).json({
        error: readiness.reason,
        code: 'account-setup-incomplete',
        blockers: readiness.blockers
      });
    }

    // expandWizardJob runs Director + Judge LLMs (~15-25s) and was previously
    // sync on the request path — that pushed past Render's edge timeout and
    // produced 504s even though the backend was healthy. The fix:
    //   1. Mint runId + renderToken + CampaignRun (status='preparing') NOW
    //      so the frontend has something to poll immediately.
    //   2. Respond 202 with status='preparing' and total=0.
    //   3. setImmediate: run expandWizardJob + selectAdsForRun, then flip
    //      the run to status='running' with total set and start the render
    //      loop. Errors land the run as status='failed' with a single
    //      error entry so the UI can surface them.
    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
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

    // Persist operator picks to the campaign (idempotent; fast). Mirrors the
    // prior behavior so the campaign's pinned strip reflects the run inputs.
    if (productIds.length || mediaIds.length) {
      const setOps = {};
      if (productIds.length) setOps.matchedProductIds = { $each: productIds };
      if (mediaIds.length)   setOps.mediaIds          = { $each: mediaIds };
      Campaign.updateOne({ _id: campaignId }, { $addToSet: setOps })
        .catch(err => console.warn(`   ⚠️  campaign pin failed for ${campaignId}: ${err.message}`));
    }

    const campaignDoc = await Campaign.findById(campaignId).select('brandId kind').lean();
    const run = await CampaignRun.create({
      runId,
      brandId:      String(campaignDoc.brandId),
      campaignId:   String(campaignId),
      campaignKind: campaignDoc.kind || 'product',
      total:        0,
      status:       'preparing',
      requestedBy:  req.user?.userId || null,
      startedAt:    new Date()
    });

    res.status(202).json({
      campaignRunId: runId,
      campaignId:    String(campaignId),
      brandId:       String(campaignDoc.brandId),
      campaignKind:  campaignDoc.kind || 'product',
      total:         0,
      queuedRemaining: 0,
      status:        'preparing'
    });

    setImmediate(async () => {
      let adIds;
      try {
        const job = await expandWizardJob({
          campaignId,
          productIds,
          mediaIds,
          templateIds,
          cta,
          urlParams,
          platformFormat,
          kinds,
          excludePairings,
          includeCategoryMatched,
          includeBrandMatched,
          videoDurationSec: parsedVideoDurationSec,
          directorVariants: phase3.fields.directorVariants,
          seedMediaIds: phase3.fields.seedMediaIds,
          seedPicks: phase3.fields.seedPicks,
          videoPromptGuidance: phase3.fields.videoPromptGuidance,
          videoPromptRaw: phase3.fields.videoPromptRaw,
          requestedBy: req.user?.userId || null
        });

        if (job.queuedCount === 0) {
          await CampaignRun.updateOne(
            { _id: run._id },
            { status: 'done', completedAt: new Date(),
              $push: { errors: { index: 0, stage: 'expand', message: 'No renderable creatives' } } }
          );
          return;
        }

        adIds = await selectAdsForRun({ campaignId, limit: MAX_CREATIVES_PER_RUN });
        if (!adIds.length) {
          await CampaignRun.updateOne(
            { _id: run._id },
            { status: 'done', completedAt: new Date(),
              $push: { errors: { index: 0, stage: 'select', message: 'Selection returned empty' } } }
          );
          return;
        }

        await Ad.updateMany(
          { _id: { $in: adIds } },
          {
            $addToSet: { campaignRunIds: runId },
            $set:      { status: 'rendering', updatedAt: new Date() }
          }
        );

        await CampaignRun.updateOne(
          { _id: run._id },
          { $set: { total: adIds.length, status: 'running' } }
        );

        await runRenderLoop(run, { ...job, platformFormat }, adIds, renderToken);
      } catch (err) {
        console.error(`❌ campaign run ${runId} prep/render crashed:`, err);
        if (adIds && adIds.length) {
          await Ad.updateMany(
            { _id: { $in: adIds }, status: 'rendering' },
            { $set: { status: 'queued', updatedAt: new Date() } }
          ).catch(() => {});
        }
        await CampaignRun.updateOne(
          { _id: run._id },
          { status: 'failed', completedAt: new Date(),
            $push: { errors: { index: 0, stage: 'expand', message: err.message || String(err) } } }
        ).catch(() => {});
      }
    });

  } catch (err) {
    console.error('ads generate failed:', err);
    res.status(500).json({ error: err.message || 'ads generate failed' });
  }
});

// POST /api/ads/runs
// Body: { campaignId }
// "Generate more from this campaign" — picks the next N queued ads
// and renders them in a new CampaignRun. No re-queueing; just drains
// inventory that expandWizardJob already created.
// Response: 202 Accepted { campaignRunId, total, queuedRemaining, status }
router.post('/runs', express.json(), async (req, res) => {
  try {
    const { campaignId } = req.body || {};
    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });

    try {
      await assertCampaignInTenant(campaignId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }

    const campaign = await Campaign.findById(campaignId).lean();
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    const adIds = await selectAdsForRun({ campaignId, limit: MAX_CREATIVES_PER_RUN });
    if (!adIds.length) {
      return res.status(422).json({ error: 'No queued ads remaining for this campaign' });
    }

    const queuedRemaining = Math.max(0,
      (await Ad.countDocuments({ campaignId, status: 'queued' })) - adIds.length
    );

    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

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

    await Ad.updateMany(
      { _id: { $in: adIds } },
      {
        $addToSet: { campaignRunIds: runId },
        $set:      { status: 'rendering', updatedAt: new Date() }
      }
    );

    const run = await CampaignRun.create({
      runId,
      brandId:      String(campaign.brandId),
      campaignId:   String(campaign._id),
      campaignKind: campaign.kind || 'promotional',
      total:        adIds.length,
      status:       'running',
      requestedBy:  req.user?.userId || null,
      startedAt:    new Date()
    });

    res.status(202).json({
      campaignRunId:   runId,
      campaignId:      String(campaign._id),
      brandId:         String(campaign.brandId),
      campaignKind:    campaign.kind || 'promotional',
      total:           adIds.length,
      queuedRemaining,
      status:          'running'
    });

    // Reuse the same runRenderLoop. job arg only carries the brand /
    // campaign metadata renderOne needs to thread into renderCreative.
    const job = {
      brandId:      String(campaign.brandId),
      campaignId:   String(campaign._id),
      campaignKind: campaign.kind || 'promotional'
    };
    setImmediate(() => {
      runRenderLoop(run, job, adIds, renderToken).catch(err => {
        console.error(`❌ campaign run ${runId} crashed:`, err);
        Ad.updateMany(
          { _id: { $in: adIds }, status: 'rendering' },
          { $set: { status: 'queued', updatedAt: new Date() } }
        ).catch(() => {});
        CampaignRun.updateOne(
          { _id: run._id },
          { status: 'failed', completedAt: new Date() }
        ).catch(() => {});
      });
    });

  } catch (err) {
    console.error('ads runs (queued drain) failed:', err);
    res.status(500).json({ error: err.message || 'ads runs failed' });
  }
});

// Background render loop. Runs after the response has flushed; updates
// the CampaignRun doc as each render finishes so the frontend's
// poller can show real-time progress.
async function runRenderLoop(run, job, adIds, renderToken) {
  const t0 = Date.now();
  // Veo calls are expensive and quota-limited — serialize them by default.
  // Derive from the actual ads (not job.platformFormat) so mixed / non-reels
  // veo batches still get VEO_CONCURRENCY.
  const veoCount    = await Ad.countDocuments({ _id: { $in: adIds }, renderRoute: 'veo' });
  const isVeoRun    = veoCount > 0;
  const concurrency = isVeoRun ? VEO_CONCURRENCY : RENDER_CONCURRENCY;
  console.log(
    `🚀 [campaignRun ${run.runId}] start — ${adIds.length} ad(s) ` +
    `concurrency=${concurrency}${isVeoRun ? ' (veo)' : ''} brand=${job.brandId} campaign=${job.campaignId} kind=${job.campaignKind || '-'}`
  );

  // Unified progress row (ActivityDock) — mirrors the CampaignRun
  // counters and adds cooperative cancel: the pool stops claiming new
  // ads, in-flight renders finish, unclaimed ads flip to skipped.
  const { startRun } = require('../services/progressService');
  const brandDoc = await require('../models/Brand').findById(job.brandId).select('advertiserId').lean().catch(() => null);
  const progressRun = await startRun({
    kind: 'ad-batch',
    advertiserId: brandDoc?.advertiserId,
    brandId: job.brandId,
    total: adIds.length,
    label: isVeoRun ? 'Video ad generation' : 'Ad generation',
  });
  progressRun.stage('rendering');

  const queue = adIds.map((adId, i) => ({ adId, index: i }));
  let inflight = 0;
  let next     = 0;
  let done     = 0;
  let cancelled = false;

  await new Promise((resolve) => {
    const dispatch = () => {
      // Refresh the cancel flag (non-throwing) before claiming more work.
      progressRun.checkpoint().catch(() => { cancelled = true; });
      while (!cancelled && inflight < concurrency && next < queue.length) {
        const { adId, index } = queue[next++];
        inflight++;
        renderOne(run, job, adId, index, renderToken)
          .catch(err => {
            console.error(`❌ [campaignRun ${run.runId}] #${index} dispatch crash:`, err.message || err);
          })
          .finally(() => {
            inflight--;
            progressRun.tick(++done, adIds.length);
            if ((next >= queue.length || cancelled) && inflight === 0) resolve();
            else dispatch();
          });
      }
      if (cancelled && inflight === 0) resolve();
    };
    dispatch();
  });

  // Cancelled mid-batch: unclaimed ads (bulk-flipped to 'rendering' at
  // claim time, before the loop) go BACK to the queue — they count as
  // skipped for this run and the next run's selectAdsForRun re-drains
  // them. Matching on status:'rendering' is load-bearing: the old
  // status:'queued' filter matched nothing post-claim, stranding
  // unclaimed ads in 'rendering' forever (adversarial-review find).
  if (cancelled && next < queue.length) {
    const remaining = queue.slice(next).map((q) => q.adId);
    await Ad.updateMany(
      { _id: { $in: remaining }, status: 'rendering' },
      { $set: { status: 'queued', updatedAt: new Date() } }
    ).catch(() => {});
    await CampaignRun.updateOne({ _id: run._id }, { $inc: { skipped: remaining.length } }).catch(() => {});
  }

  await CampaignRun.updateOne(
    { _id: run._id },
    { status: 'done', completedAt: new Date() }
  );
  const totalMs = Date.now() - t0;
  const final = await CampaignRun.findById(run._id).select('succeeded skipped failed').lean();
  if (cancelled) await progressRun.markCancelled(`Stopped — ${final?.succeeded || 0} finished, rest skipped`);
  else await progressRun.succeed({ succeeded: final?.succeeded || 0, skipped: final?.skipped || 0, failed: final?.failed || 0 });
  console.log(
    `🎉 [campaignRun ${run.runId}] done in ${totalMs}ms — ` +
    `${final?.succeeded || 0} succeeded · ${final?.skipped || 0} skipped · ${final?.failed || 0} failed${cancelled ? ' (cancelled by operator)' : ''}`
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
    mediaId:       String(ad.mediaId),
    productId:     ad.productId ? String(ad.productId) : null,
    template:      ad.template,
    aspectRatio:   ad.aspectRatio,
    matchTier:     ad.matchTier,
    variantKind:   ad.variantKind,
    paletteSource: ad.paletteSource || 'media'
  };
  // ── Veo render path ────────────────────────────────────────────────
  if (ad.renderRoute === 'veo') {
    try {
      // Load brand + source media up front. The Grok-skip check needs
      // sourceMedia.fileType; the brand-script overlay needs brandDoc.
      const sourceMedia = await Media.findById(ad.mediaId)
        .select('fileType fileUrl brandId').lean();
      const brandDoc = sourceMedia?.brandId
        ? await Brand.findById(sourceMedia.brandId)
            .select('name styleScript styleScriptVertical styleScriptLandscape styleTheme tagline logoUrl websiteUrl primaryColor secondaryColor accentColor fontFamily derivedVoice videoSettings titleStyleSpec titleStylePreset customFonts').lean()
        : null;

      // Grok-skip branch — when the seed is already a video, we keep
      // its real motion instead of asking Grok to invent new motion
      // from a still. Cloudinary picks an 8-second segment starting at
      // its saliency-derived poster frame, aspect-cropped to the ad's
      // canvas. Downstream (renderBrandScriptAndSave) doesn't need to
      // know or care whether ad.veoVideoUrl came from Grok or from a
      // Cloudinary extract — it just composites the canonical overlay
      // on top.
      const isVideoSeed = sourceMedia?.fileType === 'video';
      let veoVideoUrl, veoAspectRatio, veoPrompt = null, veoStoryboard = null, veoCloudinaryPublicId = null;
      let veoModel = null;   // stays null on the Cloudinary-segment path — no model ran
      let veoReferenceImages = [];

      if (isVideoSeed) {
        const segmentUrl = buildVideoSegmentUrl(sourceMedia.fileUrl, ad.aspectRatio || '9:16', 8);
        if (!segmentUrl) {
          console.warn(
            `⚠️  [veo] ad=${adId} seed is video but not Cloudinary-hosted (${sourceMedia.fileUrl?.slice(0, 80)}…) — ` +
            `Grok-skip requires Cloudinary /video/upload/. Falling through to Grok with picked-frame reference.`
          );
        } else {
          veoVideoUrl    = segmentUrl;
          veoAspectRatio = ad.aspectRatio || '9:16';
          console.log(
            `🎬 [veo] ad=${adId} seed=video → skip Grok, 8s Cloudinary segment ` +
            `(aspect=${veoAspectRatio}) → ${segmentUrl.slice(0, 120)}…`
          );
        }
      }

      // Grok path — fires when the seed is an image OR when the video
      // Grok-skip couldn't build a Cloudinary segment (non-Cloudinary
      // video host — rare but possible).
      if (!veoVideoUrl) {
        // Stage 1 — prepare context: resolves the per-ad model + aspect
        // and warms the layoutInput cache for the brand-script overlay.
        // storyboard is always null on the Atlas path now (the Ken Burns
        // prompt directs motion; the GPT storyboard stage is retired) —
        // the stamp below only fires for legacy/vertex storyboards.
        const { storyboard } = await veoPrepareStoryboard({ ad });
        veoStoryboard = storyboard || null;

        // Stamp the storyboard early so chrome can read it from ad.veoStoryboard
        // if the in-memory pass somehow drops, and downstream debug tools see it.
        if (storyboard) {
          await Ad.updateOne({ _id: adId }, { $set: { veoStoryboard: storyboard, updatedAt: new Date() } });
        }

        // Stage 2 — generate the base video via Grok. Chrome (if any)
        // runs after Grok completes in Stage 3.
        const veoResult = await veoGenerateForAd({ ad, storyboard });
        if (veoResult.skipped) {
          await CampaignRun.updateOne({ _id: run._id }, { $inc: { skipped: 1 } });
          await Ad.updateOne(
            { _id: adId },
            { $set: { status: 'queued', updatedAt: new Date() } }  // re-queues for next run when Veo is enabled
          );
          return;
        }
        veoVideoUrl           = veoResult.videoUrl;
        veoAspectRatio        = veoResult.aspectRatio || null;
        veoPrompt             = veoResult.prompt || null;
        veoStoryboard         = veoResult.storyboard || veoStoryboard;
        veoCloudinaryPublicId = veoResult.cloudinaryPublicId || null;
        veoModel              = veoResult.model || null;
        veoReferenceImages    = veoResult.referenceImages || [];
      }

      // Stamp the video URL + Ad state. Done BEFORE the brand-script
      // overlay so a composite failure still leaves a viewable ad
      // (raw Grok video or Cloudinary segment). Composite overwrites
      // renderUrl/posterUrl/cloudinaryPublicId on success.
      const fallbackPosterUrl = veoVideoUrl?.includes('/video/upload/')
        ? veoVideoUrl
            .replace('/video/upload/', '/video/upload/so_2,f_jpg,q_auto:good/')
            .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2')
        : null;
      await Ad.updateOne(
        { _id: adId },
        {
          $set: {
            status:             'draft',
            kind:               'video',
            veoVideoUrl,
            veoAspectRatio,
            veoPrompt,
            veoStoryboard,
            veoModel,
            veoReferenceImages,
            renderUrl:          veoVideoUrl,
            posterUrl:          fallbackPosterUrl || veoVideoUrl,
            cloudinaryPublicId: veoCloudinaryPublicId,
            sourceFileType:     'video',
            updatedAt:          new Date()
          },
          $inc: { renderAttempts: 1 }
        }
      );

      // Stage 3 — brand-script canvas overlay. Resolver picks the right
      // script based on the ad's format (vertical vs feed) and the
      // brand's per-format opt-ins. When no chrome is configured for
      // this format, the resolver returns cleanly and the raw Grok
      // video (already stamped as renderUrl in Stage 2.5) is the final
      // output. Failure is non-fatal for the same reason.
      const adFinal = await Ad.findById(adId).lean();
      if (brandDoc) {
        try {
          const { renderBrandScriptAndSave } = require('../services/brandScriptExecutor');
          await renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
        } catch (scriptErr) {
          console.warn(`⚠️ brandScript[ad=${adId}]: failed (non-fatal) — ${scriptErr.message}`);
        }
      }

      await CampaignRun.updateOne({ _id: run._id }, { $inc: { succeeded: 1 } });
    } catch (err) {
      console.error(`❌ veoReference[ad=${adId}]:`, err.message || err);
      await CampaignRun.updateOne(
        { _id: run._id },
        {
          $inc:  { failed: 1 },
          $push: { errors: buildErrorEntry(creative, index, 'veo', err) }
        }
      );
      await Ad.updateOne(
        { _id: adId },
        {
          $set: {
            status:      'failed',
            renderError: { message: err.message || String(err), stage: 'veo', at: new Date() },
            updatedAt:   new Date()
          },
          $inc: { renderAttempts: 1 }
        }
      );
    }
    return;
  }

  // ── HTML Gen render path (Feed) ─────────────────────────────────────
  try {
    const result = await renderCreative({
      jobId:         crypto.randomBytes(8).toString('hex'),
      adId:          String(ad._id),
      campaignId:    job.campaignId,
      campaignRunId: run.runId,
      brandId:       job.brandId,
      campaignKind:  job.campaignKind,
      // Promotional details ride alongside campaignKind so the
      // derivation prompt can compose offer-aware headlines for
      // kind='promotional' campaigns. Snapshot from the campaign at
      // run-start time; in-flight edits won't take effect until the
      // operator re-renders (cache key includes a hash of this).
      promotionalDetails: job.promotionalDetails || null,
      // variantKind + productId thread through so buildLayoutInput
      // can swap the product source (UGC match vs catalog product
      // direct) and gate UGC-only slots (creator, ugc, engagement).
      variantKind:   ad.variantKind,
      productId:     ad.productId ? String(ad.productId) : null,
      // paletteSource flips style bindings between hero-media palette
      // and brand colors. assembleInput reads it and overrides the
      // media.palette_* paths the templates bind to.
      paletteSource: ad.paletteSource || 'media',
      // Platform-format-aware ad generation (Phase 3). Carried from
      // the Ad row through the render pipeline so the eager-prime call
      // chain (ensureCanvasAndHtml → getOrGenerate → HTML Gen) all
      // see the same format and prompt their LLMs accordingly.
      platformFormat: ad.platformFormat || 'meta_feed_1_1',
      // Per-ad raffle prize media — set when the campaign has multiple
      // prize media (Option B per-prize variants). Null on non-raffle
      // ads + single-prize raffle ads (loadContext falls back to the
      // campaign's first prize id in those cases).
      rafflePrizeMediaId: ad.rafflePrizeMediaId ? String(ad.rafflePrizeMediaId) : null,
      // Phase A5b — concept-driven Ads carry the Director round +
      // concept id. When present, ensureCanvasAndHtml uses them
      // directly instead of running pickConceptForCell against the
      // legacy Director artifact. Null on legacy Ads — falls through
      // to the existing path.
      adConceptArtifactId: ad.conceptArtifactId ? String(ad.conceptArtifactId) : null,
      adConceptId:         ad.conceptId || null,
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
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }
    const run = await CampaignRun.findOne({ runId: req.params.runId, brandId }).lean();
    if (!run) return res.status(404).json({ error: 'run not found' });
    // queuedRemaining drives the "Generate more" affordance on the
    // Ads page — the button only makes sense when the campaign has
    // more queued inventory to drain.
    const queuedRemaining = await Ad.countDocuments({
      campaignId: run.campaignId,
      status:     'queued'
    });
    res.json({
      runId:           run.runId,
      brandId:         String(run.brandId),
      campaignId:      String(run.campaignId),
      campaignKind:    run.campaignKind,
      total:           run.total,
      succeeded:       run.succeeded,
      skipped:         run.skipped,
      failed:          run.failed,
      status:          run.status,
      queuedRemaining,
      errors:          run.errors || [],
      startedAt:       run.startedAt,
      completedAt:     run.completedAt
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
      smartCropBbox,
      sourceDims: media?.width && media?.height
        ? { w: media.width, h: media.height }
        : null
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
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }

    const filter = { brandId };
    if (req.query.campaignId)  filter.campaignId  = req.query.campaignId;
    if (req.query.status)      filter.status      = req.query.status;
    // ?rendered=true → only ads that have actually been rendered to
    // Cloudinary (status in draft|live|archived). Used by surfaces that
    // shouldn't surface the queue (campaign-detail Ads section, etc.).
    // Ignored when an explicit status= is also set.
    if (req.query.rendered === 'true' && !req.query.status) {
      filter.status = { $in: ['draft', 'live', 'archived'] };
    }
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

    // Phase B — attach photorealUrl (gpt-image-1.edit output from the
    // image-ref shadow) joined by the Ad's cache key. Also resolve the
    // Campaign-level useImageRefAsProduction flag so the frontend can
    // decide which to display. Both lookups parallelized + batched.
    const photorealMap         = await loadPhotorealUrlMap(rows);
    const useImageRefByCampaign = await loadUseImageRefMap(rows);

    res.json({
      ads: rows.map(r => projectAd(r, false, {
        photorealUrl:           photorealMap.get(String(r._id)) || null,
        useImageRefAsProduction: useImageRefByCampaign.get(String(r.campaignId)) || false
      })),
      total,
      limit,
      offset
    });
  } catch (err) {
    console.error('ads list failed:', err);
    res.status(500).json({ error: err.message || 'ads list failed' });
  }
});

// ── Meta Ads push (Phase D) ──────────────────────────────────────────
//
// Both endpoints MUST live above the `/:id` routes — Express matches
// in declaration order, and `/meta-adsets` would otherwise resolve
// against `/:id` with id='meta-adsets' (404).
//
// GET /api/ads/meta-adsets?brandId=...
//   Flat list of AdSets across the brand's synced Meta Ads campaigns.
//   Drives the "Push to Meta" modal's single dropdown — UI groups by
//   campaignName client-side.
//
// POST /api/ads/push-to-meta
//   Body: { brandId, adsetId, adIds: [string] }
//   Single-ad push is just adIds=[oneId]. Each Ad's image creative
//   is uploaded → AdCreative + Ad created on Meta as PAUSED. Per-ad
//   results returned in `perAd` so a partial failure surfaces
//   row-level errors without losing the successful pushes.
router.get('/meta-adsets', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }
    const { listAdsetsForBrand } = require('../services/metaAdsPushService');
    const adsets = await listAdsetsForBrand(brandId);
    res.json({ adsets });
  } catch (err) {
    console.error('meta-adsets list failed:', err);
    res.status(500).json({ error: err.message || 'meta-adsets list failed' });
  }
});

// GET /api/ads/video-models — the operator-selectable video generation
// models, for the Brand settings card and the regenerate dropdown.
// Derived from atlasVideoService.MODEL_CAPS (single source of truth);
// `default` marks the built-in default the resolver falls back to.
// NOTE: must stay registered above the '/:id' routes.
router.get('/video-models', async (req, res) => {
  const {
    MODEL_CAPS, BUILT_IN_DEFAULT_MODEL, estimateRenderCostUsd
  } = require('../services/atlasVideoService');
  const models = Object.entries(MODEL_CAPS)
    .filter(([, caps]) => caps.selectable)
    .map(([slug, caps]) => ({
      slug,
      label:                 caps.label || slug,
      default:               slug === BUILT_IN_DEFAULT_MODEL,
      supportedAspectRatios: caps.supportedAspectRatios || [],
      maxReferenceImages:    caps.maxReferenceImages || 1,
      requiresVideoSeed:     !!caps.requiresVideoSeed,
      estCostPer8s:          estimateRenderCostUsd({ model: slug, durationSec: caps.defaultDuration || 8 })
    }));
  res.json({ models });
});

// GET /api/ads/veo-prompt-scaffold
// Query: campaignId, productId?, platformFormat?, durationSec?
// Returns the canonical Veo prompt + resolved model/aspect/duration for
// the Advanced raw-prompt editor (Phase 4 UI). media=null; product may
// be a placeholder. NOTE: must stay registered above the '/:id' routes.
router.get('/veo-prompt-scaffold', async (req, res) => {
  try {
    const {
      campaignId,
      productId = null,
      platformFormat = null,
      durationSec = null
    } = req.query || {};

    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
    if (!mongoose.isValidObjectId(campaignId)) {
      return res.status(400).json({ error: 'campaignId must be a valid ObjectId' });
    }
    if (productId && !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ error: 'productId must be a valid ObjectId' });
    }

    let campaign;
    try {
      campaign = await assertCampaignInTenant(campaignId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }

    const brand = await Brand.findOne(
      tenantFilter(req, { _id: campaign.brandId })
    ).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    let product = null;
    let categories = [];
    if (productId) {
      product = await CatalogProduct.findOne(
        tenantFilter(req, { _id: productId, brandId: campaign.brandId })
      ).lean();
      if (!product) return res.status(404).json({ error: 'product not found' });
      categories = await loadCategoryChainForProduct(product);
    }

    const scaffold = await buildPromptScaffold({
      brand,
      product,
      categories,
      platformFormat: platformFormat || null,
      durationSec: durationSec != null && durationSec !== ''
        ? Number(durationSec)
        : null
    });
    res.json(scaffold);
  } catch (err) {
    console.error(`❌ GET /api/ads/veo-prompt-scaffold failed: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message || 'veo-prompt-scaffold failed' });
  }
});

router.post('/push-to-meta', express.json(), async (req, res) => {
  try {
    const brandId = req.body?.brandId || req.query.brandId || req.headers['x-brand-id'];
    const { adsetId, adIds } = req.body || {};
    if (!brandId)         return res.status(400).json({ error: 'brandId required' });
    if (!adsetId)         return res.status(400).json({ error: 'adsetId required' });
    if (!Array.isArray(adIds) || !adIds.length) {
      return res.status(400).json({ error: 'adIds (non-empty array) required' });
    }
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }
    const { pushAdsBatch } = require('../services/metaAdsPushService');
    const result = await pushAdsBatch({
      adIds, adsetId, brandId,
      requestedBy: req.user?.userId || null
    });
    // Always 200 — per-ad failures are in result.perAd. The whole
    // call only 4xx/5xx's when the batch couldn't even start (no
    // cred, no page, missing params).
    res.json(result);
  } catch (err) {
    console.error('push-to-meta failed:', err);
    // Surface the typed error code so the UI can render a specific
    // remediation banner ("Connect Instagram first" vs generic).
    res.status(err.code === 'no-page' || err.code === 'no-meta-ads-cred' ? 409 : 500)
       .json({ error: err.message || 'push-to-meta failed', code: err.code || null });
  }
});

// PATCH /api/ads/:id — flip status. Body: { status: 'draft' | 'live' | 'archived' }.
// Caller passes ?brandId or X-Brand-Id so the lookup is tenant-scoped.
// POST /api/ads/:id/approve — flip the operator-approval flag.
// Body: { approved: boolean }. Orthogonal to status (which tracks the
// render lifecycle); drives the Draft / Approved / Exported grouping
// on the Product Ads page. Tenant-scoped via brandId.
router.post('/:id/approve', express.json(), async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }
    const approved = req.body?.approved !== false;   // default true
    const set = {
      approved,
      approvedAt: approved ? new Date() : null,
      approvedBy: approved ? (req.user?.userId || req.user?.email || null) : null,
      updatedAt:  new Date()
    };
    const ad = await Ad.findOneAndUpdate(
      { _id: req.params.id, brandId },
      { $set: set },
      { new: true }
    ).lean();
    if (!ad) return res.status(404).json({ error: 'ad not found' });
    res.json({ ad: projectAd(ad, /* full */ true) });
  } catch (err) {
    console.error('ad approve failed:', err);
    res.status(500).json({ error: err.message || 'ad approve failed' });
  }
});

// POST /api/ads/:id/regenerate — re-run the render pipeline for this
// ad with an operator refinement prompt. Body: { prompt, mode? }.
//   prompt: required, up to ~1000 chars
//   mode:   'light' (default, video only — re-runs chrome + composite,
//                    Veo unchanged) | 'full' (re-runs Veo too).
//           Image ads always do full HTML Gen re-render; mode ignored.
// Returns 202 with a poll target. Frontend polls
// /api/catalog/:productId/ads-detail watching ad.regenerating.
router.post('/:id/regenerate', express.json(), async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    if (prompt.length > 1000) return res.status(400).json({ error: 'prompt is too long (max 1000 chars)' });
    const mode = req.body?.mode === 'full' ? 'full' : 'light';

    // Optional per-run video model override (the regenerate dropdown).
    // Only operator-selectable registry slugs are accepted — persisted
    // env/back-compat slugs aren't offered per-run.
    let videoModel = null;
    if (req.body?.videoModel != null && req.body.videoModel !== '') {
      const { MODEL_CAPS } = require('../services/atlasVideoService');
      const slug = String(req.body.videoModel);
      if (!MODEL_CAPS[slug]?.selectable) {
        return res.status(400).json({ error: `unknown video model '${slug}'` });
      }
      videoModel = slug;
    }

    const regen = require('../services/adRegenerateService');
    let ad;
    try {
      ad = await regen.preflight(req.params.id, brandId);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    const requestedBy = req.user?.userId || req.user?.email || null;

    // 202 — operator polls /api/catalog/:productId/ads-detail for stage.
    res.status(202).json({
      adId:               String(ad._id),
      regenerating:       true,
      regenerationStage:  'pending',
      mode:               ad.kind === 'image' ? 'full' : mode
    });

    setImmediate(() => {
      regen.regenerateAd({ ad, prompt, mode, requestedBy, videoModel })
        .catch(err => console.error(`❌ regenerate setImmediate crash: ${err.message}`));
    });
  } catch (err) {
    console.error('regenerate request failed:', err);
    res.status(500).json({ error: err.message || 'regenerate failed' });
  }
});

// PATCH /api/ads/:id — status and/or per-ad copy overrides.
// Body may contain status and/or copy; at least one required.
// copy keys: headline, cta_text, quote, productName, productPrice
// (string ≤300 trimmed, empty→null, or null). Unknown keys → 400.
// Dotted paths so omitted copy keys are left untouched.
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }
    const body = req.body || {};
    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
    const hasCopy = Object.prototype.hasOwnProperty.call(body, 'copy');
    if (!hasStatus && !hasCopy) {
      return res.status(400).json({ error: 'body must include status and/or copy' });
    }

    const update = { updatedAt: new Date() };

    if (hasStatus) {
      const { status } = body;
      if (!AD_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${AD_STATUSES.join(', ')}` });
      }
      update.status = status;
    }

    if (hasCopy) {
      const COPY_KEYS = new Set(['headline', 'cta_text', 'quote', 'productName', 'productPrice']);
      const copy = body.copy;
      if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) {
        return res.status(400).json({ error: 'copy must be an object' });
      }
      for (const key of Object.keys(copy)) {
        if (!COPY_KEYS.has(key)) {
          return res.status(400).json({ error: `copy: unknown key '${key}' — allowed: ${[...COPY_KEYS].join(', ')}` });
        }
        const v = copy[key];
        if (v === null) {
          update[`copy.${key}`] = null;
        } else if (typeof v === 'string') {
          const trimmed = v.trim();
          if (trimmed.length > 300) {
            return res.status(400).json({ error: `copy.${key} must be ≤300 characters` });
          }
          update[`copy.${key}`] = trimmed.length === 0 ? null : trimmed;
        } else {
          return res.status(400).json({ error: `copy.${key} must be a string or null` });
        }
      }
    }

    const ad = await Ad.findOneAndUpdate(
      { _id: req.params.id, brandId },
      { $set: update },
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
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }
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
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }
    const ad = await Ad.findOne({ _id: req.params.id, brandId }).lean();
    if (!ad) return res.status(404).json({ error: 'ad not found' });
    res.json({ ad: projectAd(ad, /* full */ true) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'ad fetch failed' });
  }
});

// GET /api/ads/:id/generation-inspector?brandId=...
// Everything that went INTO a generated ad, for operator debugging:
//   - video: the canonical prompt sent to the model, model/aspect,
//     storyboard, the RAW pre-titling video vs the final titled render,
//     and the seed image + any detected burned-in text (the usual cause
//     of garbled on-screen text — the model smears baked-in glyphs).
//   - titling: the exact resolved script elements (snapshot from the last
//     render if present, else reconstructed from ad.copy + brand spec).
//   - static: the GPT-4.1 layout prompt + spec and the gpt-image-2
//     image-ref prompt; plus artifact ids for the full spec deep-link.
router.get('/:id/generation-inspector', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }

    const ad = await Ad.findOne({ _id: req.params.id, brandId }).lean();
    if (!ad) return res.status(404).json({ error: 'ad not found' });

    const Media = require('../models/Media');
    const Brand = require('../models/Brand');
    const brand = await Brand.findById(brandId).lean();

    const out = {
      adId:        String(ad._id),
      kind:        ad.kind,
      template:    ad.template,
      aspectRatio: ad.aspectRatio,
      status:      ad.status,
      productId:   ad.productId ? String(ad.productId) : null,
      warnings:    []
    };

    // ── Seed media (the source the generation animated/composed) ──
    let seed = null;
    if (ad.mediaId) {
      const m = await Media.findById(ad.mediaId)
        .select('source fileType fileUrl text metadata.productTitle').lean();
      if (m) {
        const burnedInText = (Array.isArray(m.text) ? m.text : [])
          .map(t => (typeof t === 'string' ? t : (t?.text || t?.value || null)))
          .filter(Boolean);
        seed = {
          mediaId:     String(m._id),
          source:      m.source,
          fileType:    m.fileType,
          url:         m.fileUrl,
          burnedInText,
          seedHasText: burnedInText.length > 0
        };
        if (seed.seedHasText) {
          out.warnings.push({
            code: 'seed-has-burned-in-text',
            message: `Source image has ${burnedInText.length} detected burned-in text element(s). The video model can smear/garble baked-in text when animating (Ken Burns) — this is the usual source of garbled on-screen text, NOT the titling engine (titling is overlaid cleanly downstream).`
          });
        }
      }
    }
    out.seed = seed;

    // ── Video generation inputs ──
    if (ad.kind === 'video' || ad.veoPrompt || ad.veoVideoUrl) {
      // Reference-image stack the director actually fed the model
      // (pos 0 = seed, then product hero + alts). Persisted on newer ads;
      // reconstructed from seed + catalog product images for older ones.
      let referenceImages = Array.isArray(ad.veoReferenceImages) ? ad.veoReferenceImages.filter(Boolean) : [];
      let referenceImagesReconstructed = false;
      if (!referenceImages.length) {
        const recon = [];
        if (seed?.url) recon.push(seed.url);
        if (ad.productId) {
          const CatalogProduct = require('../models/CatalogProduct');
          const cp = await CatalogProduct.findById(ad.productId).select('imageUrl additionalImages').lean();
          if (cp?.imageUrl) recon.push(cp.imageUrl);
          for (const u of (Array.isArray(cp?.additionalImages) ? cp.additionalImages : [])) if (u) recon.push(u);
        }
        referenceImages = [...new Set(recon)];
        referenceImagesReconstructed = referenceImages.length > 0;
      }
      out.video = {
        model:       ad.veoModel || null,
        aspectRatio: ad.veoAspectRatio || null,
        prompt:      ad.veoPrompt || null,      // canonical prompt sent to the model
        storyboard:  ad.veoStoryboard || null,
        rawVideoUrl: ad.veoVideoUrl || null,    // BEFORE titling — compare vs finalUrl to locate garble
        finalUrl:    ad.renderUrl || null,       // AFTER titling overlay
        referenceImages,                         // the images the director chose (pos 0 = seed)
        referenceImagesReconstructed
      };
      if (!ad.veoPrompt) {
        out.warnings.push({ code: 'no-video-prompt', message: 'No stored video prompt — ad predates prompt persistence or was not a Veo render.' });
      }
    }

    // ── Titling script elements (snapshot preferred, else reconstruct) ──
    if (ad.titlingSnapshot) {
      out.titling = { ...ad.titlingSnapshot, reconstructed: false };
    } else if (brand) {
      try {
        const bse = require('../services/brandScriptExecutor');
        const meta = await bse.buildMetaForAd(ad, brand);
        const engine = bse.resolveTitlingEngine(brand, ad);
        out.titling = { engine: engine?.engine || null, format: engine?.format || null, meta, reconstructed: true };
        out.warnings.push({ code: 'titling-reconstructed', message: 'Titling shown is reconstructed from current ad copy + brand spec (this ad was rendered before per-render titling snapshots; values may differ from the historical render if brand settings changed since).' });
      } catch (err) {
        out.titling = { error: `could not reconstruct titling: ${err.message}` };
      }
    }

    // ── Static image generation inputs ──
    if (ad.kind === 'image' || ad.aiCanvasArtifactId) {
      const image = {
        aiCanvasArtifactId:    ad.aiCanvasArtifactId ? String(ad.aiCanvasArtifactId) : null,
        layoutInputArtifactId: ad.layoutInputArtifactId ? String(ad.layoutInputArtifactId) : null
      };
      if (ad.aiCanvasArtifactId) {
        const AiCanvasArtifact = require('../models/AiCanvasArtifact');
        const c = await AiCanvasArtifact.findById(ad.aiCanvasArtifactId)
          .select('promptSystem promptUser promptImages canvasSpec outputHtml colorPalette copyPicks').lean();
        if (c) {
          image.layoutPrompt = { system: c.promptSystem || null, user: c.promptUser || null, images: c.promptImages || [] };
          image.canvasSpec   = c.canvasSpec || null;
          image.outputHtml   = c.outputHtml || null;
          image.colorPalette = c.colorPalette || null;
          image.copyPicks    = c.copyPicks || null;
        }
      }
      // NOTE: the gpt-image-2 image-ref prompt (AiFullRenderArtifact) is
      // intentionally NOT joined here — it has no FK on the Ad and its
      // uniqueness is an 8-field cache key (mediaId+template+aspectRatio+
      // productId+variantKind+campaignContextHash+paletteSource+creativeStyle),
      // so a partial-key lookup can surface the WRONG product's/palette's
      // prompt. A wrong prompt in a diagnostic is worse than none. The full,
      // correctly-joined image-ref + creative-direction detail is available
      // via GET /api/ai-layouts/spec/by-artifact/:aiCanvasArtifactId (exposed
      // above) — the frontend can deep-link to it.
      out.image = image;
    }

    res.json({ inspector: out });
  } catch (err) {
    res.status(500).json({ error: err.message || 'generation inspector failed' });
  }
});

// GET /api/ads/:adId/preview-page
// Returns a three-column HTML page comparing LLM HTML (A) vs Puppeteer
// overlay PNG (B) vs final composite (C). Lets operators see exactly
// what the rendering pipeline is changing — most notably backdrop-
// filter glass effects silently degrading because omitBackground:true
// leaves no backdrop to blur.
//
// Browser navigation (window.open) can't send Authorization headers,
// so the token-adapter middleware in index.js lifts ?_token= from the
// query string into the Authorization header before requireAuth runs.
// requireAuth still gates the route — the URL just needs the token
// embedded.
router.get('/:adId/preview-page', async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.adId).select('brandId').lean();
    if (!ad) {
      const err = new Error('Ad not found');
      err.status = 404;
      throw err;
    }
    await assertBrandInTenant(ad.brandId, req);

    const html = await buildPreviewHtmlForAd(req.params.adId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Don't let browsers cache the preview — outputHtml / overlay /
    // composite can all change as the renderer re-runs.
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).type('text/html').send(
      `<!DOCTYPE html><html><body style="font-family:system-ui;padding:24px;color:#900;">
        <h1>Preview unavailable</h1>
        <p>${err.message || 'unknown error'}</p>
      </body></html>`
    );
  }
});

// Phase B — display-URL joins live in services/adDisplayUrlService.js
// so the product-centric Ads page (routes/catalog.js ads-detail) renders
// thumbnails identically to this flat list.
const {
  photorealCacheKey,
  loadPhotorealUrlMap,
  loadUseImageRefMap
} = require('../services/adDisplayUrlService');

function projectAd(ad, full = false, extras = {}) {
  const base = {
    id:                 String(ad._id),
    brandId:            String(ad.brandId),
    campaignId:         ad.campaignId ? String(ad.campaignId) : null,
    // Every run that has selected this Ad. Empty until first picked;
    // grows on re-render dedupe hits ($addToSet at the run-pick step).
    campaignRunIds:     Array.isArray(ad.campaignRunIds) ? ad.campaignRunIds : [],
    mediaId:            ad.mediaId   ? String(ad.mediaId)   : null,
    productId:          ad.productId ? String(ad.productId) : null,
    template:           ad.template,
    aspectRatio:        ad.aspectRatio,
    matchTier:          ad.matchTier,
    variantKind:        ad.variantKind,
    readinessScore:     ad.readinessScore,
    campaignKind:       ad.campaignKind,
    platformFormat:     ad.platformFormat || 'meta_feed_1_1',
    kind:               ad.kind,
    sourceFileType:     ad.sourceFileType || null,
    renderUrl:          ad.renderUrl,
    // Phase B — gpt-image-1 polished version (AiFullRenderArtifact.imageUrl)
    // joined by the Ad's cache key. Frontend displays this instead of
    // renderUrl when useImageRefAsProduction is true AND photorealUrl
    // is populated. Null when no image-ref shadow has completed yet.
    photorealUrl:           extras.photorealUrl || null,
    useImageRefAsProduction: !!extras.useImageRefAsProduction,
    posterUrl:          ad.posterUrl,
    width:              ad.width,
    height:             ad.height,
    bytes:              ad.bytes,
    durationMs:         ad.durationMs,
    // ctaText is the Meta CTA-button-type source (metaAdsPushService reads
    // this raw field directly) — never conflate with the on-video overlay
    // text. The overlay override is copy.cta_text, already exposed above.
    copy:               ad.copy || {},
    ctaText:            ad.ctaText,
    ctaUrl:             ad.ctaUrl,
    ctaUrlParams:       ad.ctaUrlParams,
    status:             ad.status,
    queuedAt:           ad.queuedAt,
    renderedAt:         ad.renderedAt,
    generatedAt:        ad.generatedAt,
    createdAt:          ad.createdAt,
    // Meta Ads sync — populated when the operator pushes a rendered
    // ad to Meta Marketing API. The Ads page renders a "Synced to
    // Meta" pill when status === 'synced' (link to Ads Manager via
    // the metaAdId), or "Push failed" with the error in a tooltip.
    metaAdId:           ad.metaAdId         || null,
    metaAdCreativeId:   ad.metaAdCreativeId || null,
    metaAdsetId:        ad.metaAdsetId      || null,
    metaCampaignId:     ad.metaCampaignId   || null,
    metaAdAccountId:    ad.metaAdAccountId  || null,
    metaSyncStatus:     ad.metaSyncStatus   || null,
    metaSyncError:      ad.metaSyncError    || null,
    metaSyncedAt:       ad.metaSyncedAt     || null,
    // Product Ads page state (Phase 2): operator approval + regenerate-
    // with-prompt. Polled by AdDetailModal while a regen is in flight.
    approved:           !!ad.approved,
    approvedAt:         ad.approvedAt || null,
    regenerating:       !!ad.regenerating,
    regenerationStage:  ad.regenerationStage || null,
    regenerationHistory: Array.isArray(ad.regenerationHistory)
      ? ad.regenerationHistory.map(h => ({
          prompt:      h.prompt,
          mode:        h.mode,
          requestedBy: h.requestedBy || null,
          at:          h.at ? new Date(h.at).toISOString() : null,
          status:      h.status,
          error:       h.error || null,
          durationMs:  h.durationMs || null
        }))
      : []
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
