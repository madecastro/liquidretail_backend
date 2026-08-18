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
// Receipt guard — a requeue must never re-submit work we have paid for.
const { receiptFree } = require('../services/spendReceipt');
const { AD_RECENCY_EXPR } = require('../services/adRecencyService');
const router = express.Router();

const Ad           = require('../models/Ad');
const Media        = require('../models/Media');
const Brand        = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const CropArtifact = require('../models/CropArtifact');
const Campaign     = require('../models/Campaign');
const CampaignRun  = require('../models/CampaignRun');
const {
  expandWizardJob,
  selectAdsForRun,
  // Google PMax derive-only constants (Phase A). Shared with expansion so
  // the mint marker and the render gate cannot drift.
  PMAX_VIDEO_DERIVE_ONLY,
  PMAX_VIDEO_DERIVE_SOURCE,
  DERIVE_FROM_MASTER_FIELD,
  // THE shared derive-only gate (money) — one definition, imported by both
  // this render loop and services/adRegenerateService. Do not re-implement.
  resolveDeriveFromMaster
} = require('../services/campaignAdsGenerationService');
const { summarizeEmptyExpansion, REASON: PER_PRODUCT_REASON } = require('../services/perProductReasons');
const { assertGeneratablePlatformFormat, resolveExplicitFormats } = require('../services/platformFormats');
const { renderCreative }        = require('../services/renderService');
const { generateForAd: veoGenerateForAd, prepareStoryboard: veoPrepareStoryboard } = require('../services/videoRouter');
const { buildVideoSegmentUrl, buildPromptScaffold } = require('../services/atlasVideoService');
const ugcVideoPipeline = require('../services/ugcVideoPipeline');

// Derive-only 1:1 ads requeue while their 9:16 master is still in flight.
// Bound waits so a permanently-missing master cannot spin forever across
// /runs claims. Each claim→wait→requeue cycle counts as one attempt
// (renderAttempts). ~30 cycles is generous vs a ~2–4 min Omni master.
const MAX_DERIVE_WAIT_ATTEMPTS = 30;
// In-render wait for the sibling master's plate. An Omni master settles in
// roughly 2 minutes; 12 minutes leaves generous headroom for a slow poll
// or a queued master behind a busy pool, while still bounding the slot.
// Waiting costs nothing — the derive path never submits.
const DERIVE_MASTER_WAIT_MS = Number(process.env.DERIVE_MASTER_WAIT_MS || 12 * 60 * 1000);
const DERIVE_MASTER_POLL_MS = Number(process.env.DERIVE_MASTER_POLL_MS || 10 * 1000);
const { loadCategoryChainForProduct } = require('../services/categoryChainService');
const { deleteFromCloudinary } = require('../services/cloudinaryService');
const { buildVideoCompositeUrl } = require('../services/videoCompositeService');
const { buildPreviewHtmlForAd }  = require('../services/adPreviewPageService');
const registry = require('../services/templateRegistry');
const alerts   = require('../services/alertService');
const inFlight = require('../services/inFlight');
const { adStage } = require('../services/adStage');
const runFeed  = require('../services/runFeedService');
const { tenantFilter, assertBrandInTenant, assertCampaignInTenant } = require('../middleware/tenantHelpers');
const {
  generationGateDecision, normalizeProductIdList, pickSupersedingRun,
  computeRequestFingerprint, renderClaimFingerprint,
  buildUnclaimedNotice
} = require('../services/generationGate');
const {
  buildTerminalDoneFilter, buildRunningFlipFilter, buildActiveRunsFilter
} = require('../services/campaignRunGuards');
const { reapStaleMin, prepareStaleMin } = require('../services/staleness');

// Operator-facing gate for a multi-select format list (preset 'explicit'),
// shared by /preview + /generate.
//
// This mirrors the two-layer rule already in force for a single
// platformFormat, and BOTH layers are load-bearing:
//   * resolvePreset's filterLiveFormats is the MONEY BELT — a coming_soon key
//     can never reach an Ad payload, whatever a caller sends.
//   * this assert is the OPERATOR GATE — it says which surface is unavailable
//     instead of silently queueing fewer sizes than were ticked, which would
//     read as "generated" while quietly delivering less.
// An UNKNOWN key deliberately falls through here (same as
// assertGeneratablePlatformFormat) and is dropped by the belt.
function assertGeneratableFormatList(list, field) {
  if (list == null) return;
  if (!Array.isArray(list)) {
    const err = new Error(`${field} must be an array of platform format keys`);
    err.status = 400;
    throw err;
  }
  for (const raw of list) {
    if (raw == null || String(raw).trim() === '') continue;
    assertGeneratablePlatformFormat(String(raw).trim());
  }
}

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

// Render / video pool sizes + per-run cap — resolved in services/concurrency.js
// (env-tunable; defaults raised 2026-08-02: RENDER 4→8, VEO 1→4).
const { concurrency: CONC } = require('../services/concurrency');
const RENDER_CONCURRENCY    = CONC.RENDER_CONCURRENCY;
const VEO_CONCURRENCY       = CONC.VEO_CONCURRENCY;
const MAX_CREATIVES_PER_RUN = CONC.MAX_CREATIVES_PER_RUN;

// MODULE-LEVEL ON PURPOSE — one permit pool for the whole process, not one per
// campaign run. A per-run semaphore would let two concurrent runs each open
// VEO_TITLING_CONCURRENCY slots. See services/semaphore.js for why in-process
// is the correct scope for a memory guard (and the wrong one for a provider
// rate limit).
//
// WHAT THIS BOUNDS, CORRECTED. It used to be described as the cap on
// simultaneous Remotion renders. It never was — remotionRenderService ran a
// concurrency-1 promise chain, so one render happened regardless. This permit
// bounds the CHEAP prep half (copy cascade, Mongo reads, font resolution); the
// memory guard is REMOTION_QUEUE_CONCURRENCY inside that service.
const { Semaphore } = require('../services/semaphore');
const veoTitlingSemaphore = new Semaphore(CONC.VEO_TITLING_CONCURRENCY, 'veo-titling');

// Live titling queue depth, read from the pool that ads ACTUALLY wait in.
//
// DIAGNOSTICS MUST BE TRUE OR THEY COST MORE THAN THEY GIVE (owner rule): a
// stage line reading "0 ahead" while an ad sits twelfth in line does not merely
// under-inform, it actively misdirects whoever is debugging a slow run. Lazy
// require keeps this route file free of Remotion's load cost at boot, and the
// fallback means a require failure degrades the message rather than the render.
function titlingQueueDepth() {
  try {
    // eslint-disable-next-line global-require
    return require('../services/remotionRenderService').renderQueueStats();
  } catch {
    return { concurrency: 1, active: 0, waiting: 0 };
  }
}

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
      // Format PRESET — supersedes the three-knob API when not 'single'.
      // Default 'single' keeps old callers byte-identical.
      preset         = 'single',
      excludePairings = [],
      includeCategoryMatched = false,
      includeBrandMatched    = false,
      videoDurationSec = null,
      // "All static formats" wizard button. See expandWizardJob for what
      // this actually does — each additional format is a separate billable
      // image generation, not a crop. Ignored for named presets.
      expandStaticFormats = false,
      // Operator multi-select surfaces — preset 'explicit' only.
      staticFormats = [],
      videoFormats  = []
    } = req.body || {};
    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
    if (!templateIds.length) return res.status(400).json({ error: 'templateIds required (at least 1 template)' });
    // Refuse an explicitly named coming_soon format with 400 (not empty/500).
    try {
      if (platformFormat) assertGeneratablePlatformFormat(platformFormat);
      assertGeneratableFormatList(staticFormats, 'staticFormats');
      assertGeneratableFormatList(videoFormats, 'videoFormats');
    } catch (e) {
      if (e.code === 'PLATFORM_FORMAT_COMING_SOON') {
        return res.status(400).json({ error: e.message, code: e.code, platformFormat: e.platformFormat });
      }
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }

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
      preset,
      excludePairings,
      includeCategoryMatched,
      includeBrandMatched,
      videoDurationSec,
      expandStaticFormats,
      staticFormats,
      videoFormats,
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
    if (err.code === 'PLATFORM_FORMAT_COMING_SOON') {
      return res.status(400).json({ error: err.message, code: err.code, platformFormat: err.platformFormat });
    }
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
      // Format PRESET — supersedes platformFormat+kinds+expandStaticFormats
      // when not 'single'. Default 'single' keeps old callers byte-identical.
      // meta_video queues ONE 9:16 master per product (one billable Veo submit);
      // meta_static fans each concept to 3 Meta static sizes (3 billable images).
      preset         = 'single',
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
      videoDurationSec = null,  // wizard format-selection stage; integer 1–15, null = standard 8s
      // "All static formats" wizard button — fans each image concept out to
      // every Meta static surface (staticFanoutForPlatformFormat) instead of
      // just platformFormat. EACH SIZE IS A SEPARATE BILLABLE GENERATION.
      // Default false: existing callers get exactly prior behavior.
      // Ignored for named presets (meta_static / meta_all already fan out).
      expandStaticFormats = false,
      // Operator MULTI-SELECT surfaces — preset 'explicit' ONLY.
      // MONEY: one billable image generation per staticFormats entry per
      // concept. videoFormats is clamped to <=1 inside resolvePreset.
      staticFormats = [],
      videoFormats  = [],
      // DUPLICATE OVERRIDE — owner 2026-08-10: an identical request is refused,
      // but *"allow them if the user wants"*. The client re-POSTs the same body
      // with confirmDuplicate:true plus the acknowledgedRunId it was handed in
      // the 409. Both are required: the runId is what makes the override
      // single-use, so a stray second click on "Generate anyway" is refused
      // against the run the first click just minted instead of billing again.
      confirmDuplicate = false,
      acknowledgedRunId = null,
      // UGC-ads Phase 3 — operator-picked UGC that MUST land at seed index 0.
      // Explicit rather than inferring "mediaIds[0] must be a UGC" because
      // mediaIds is the general operator-picked seed list (any Media, catalog
      // or UGC); a Generate Ads wizard run picking a catalog image must NOT
      // silently trip the UGC-first cascade. Passing an unrelated id here is
      // harmless — buildSeededUniverse no-ops when the id isn't in the pool
      // — but the field is the only signal that the CampaignRun should
      // persist a seedUgcIds row so regenerate can replay the pick.
      // Gated by UGC_FIRST_SEEDING inside seededUniverseService — that
      // switch OFF makes this field a no-op end-to-end.
      preferUgcMediaId = null
    } = req.body || {};

    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
    if (!templateIds.length) return res.status(400).json({ error: 'templateIds required (at least 1 template)' });
    // Refuse coming_soon before minting a CampaignRun / returning 202.
    try {
      if (platformFormat) assertGeneratablePlatformFormat(platformFormat);
      assertGeneratableFormatList(staticFormats, 'staticFormats');
      assertGeneratableFormatList(videoFormats, 'videoFormats');
    } catch (e) {
      if (e.code === 'PLATFORM_FORMAT_COMING_SOON') {
        return res.status(400).json({ error: e.message, code: e.code, platformFormat: e.platformFormat });
      }
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }

    const phase3 = parsePhase3WizardFields(req.body || {});
    if (!phase3.ok) return res.status(phase3.status).json({ error: phase3.error });

    // Normalise the multi-select lists through the SAME resolver the expansion
    // will use, and hash/forward THOSE rather than the raw body arrays.
    //
    // This is a money guard, not hygiene. The duplicate gate exists to catch a
    // repeat of the same request, and "the same request" has to mean the same
    // BILLABLE SURFACE SET — not the same JSON. Two bodies that resolve
    // identically (a video-only key sent in staticFormats and then dropped, a
    // duplicate tick, two tick orders, junk lists left on a named preset) would
    // otherwise fingerprint differently, so a genuine double-click would not
    // register as one and the second click would bill a second full set of
    // static generations. Static is the unprotected half: its identityDigest is
    // scoped to generationRunId, so nothing downstream collides.
    const isExplicitPreset = preset === 'explicit';
    const resolvedExplicit = isExplicitPreset
      ? resolveExplicitFormats({ staticFormats, videoFormats })
      : { staticFormats: [], videoFormats: [], kinds: [] };

    // An explicit selection that resolves to NOTHING must not mint a run. It
    // would 202, expand to zero and settle as terminal `done` — a run that
    // looks successful and produced no ads. Reachable whenever the client posts
    // preset:'explicit' with an empty (or entirely coming_soon / unknown)
    // selection, which is exactly what an un-ticked picker sends.
    if (isExplicitPreset
        && !resolvedExplicit.staticFormats.length
        && !resolvedExplicit.videoFormats.length) {
      return res.status(400).json({
        error: 'Select at least one ad size that is available to generate.',
        code:  'NO_GENERATABLE_FORMAT'
      });
    }

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
    // CONCURRENT GENERATIONS: allowed unless the request is IDENTICAL to one
    // already in flight (or to one that recently finished, which is refused once
    // and then allowed on explicit confirmation). Checked in the DATABASE, not
    // in memory: services/inFlight.js is per-process and this web service
    // autoscales across several Render instances, so two clicks can land on two
    // processes that cannot see each other.
    //
    // This guard is load-bearing as of 2026-08-01. Until the identityDigest was
    // scoped to the run, a double-click was silently free — the second run's ads
    // collided with the first's on the unique index and inserted nothing. That
    // accident was the only thing standing between a stray double-click and a
    // second full set of billable generations, and scoping the digest (which the
    // owner asked for, so repeat Generates actually produce new creative)
    // removed it. Note the atomic status:'queued' claim below does NOT cover
    // this case — each run claims the ads it just minted, so there is no race to
    // lose. Every generation POST is charged on submit (CLAUDE.md §2).
    //
    // It was ONE run per campaign until 2026-08-03, then PRODUCT OVERLAP until
    // 2026-08-10. Both blocked runs the team legitimately wants: overlap refused
    // a second, different request over the same product, and — because it failed
    // CLOSED on an unreadable product scope — it refused MEDIA-LIBRARY runs
    // outright, since those legitimately carry productIds:[]. The key is now the
    // REQUEST FINGERPRINT. services/generationGate.js owns the reasoning,
    // including the digest evidence that video cannot double-bill across runs at
    // all (its identity digest is run-independent, so the unique index catches
    // it) and that duplicate STATIC sets are owner-sanctioned creative rather
    // than a double charge.
    //
    // Stale runs are not allowed to lock a campaign forever: an in-flight row
    // older than its lifecycle's ceiling is treated as dead. There are TWO such
    // ceilings and they are deliberately different numbers — see
    // services/campaignRunGuards.js buildActiveRunsFilter:
    //
    //   'running'   → REAP_STALE_MIN (15) on updatedAt — the SAME number and
    //                 the SAME clock worker.js's running reaper uses, so "the
    //                 gate sees it" and "the reaper would spare it" are one
    //                 statement. A live batch heartbeats via every per-ad $inc.
    //   'preparing' → PREPARE_STALE_MIN (30) on createdAt (mint age), because a
    //                 preparing run makes no writes at all and its healthy
    //                 runtime (Director + Judge, ~18-20 min) exceeds 15. This
    //                 arm MUST equal the window buildRunningFlipFilter enforces
    //                 below, or a duplicate is admitted while the original can
    //                 still flip — double bill.
    //
    // PARSED IN ONE PLACE — services/staleness.js.
    //
    // WHAT EACH VAR IS LOAD-BEARING FOR (corrected 2026-08-18 — this block used
    // to attribute the flip's age guard to REAP_STALE_MIN, which is no longer
    // true and was the defect):
    //
    //   prepareMin (PREPARE_STALE_MIN) — load-bearing for whether generation
    //     succeeds AT ALL. '0', whitespace or a negative collapse the flip's
    //     startedAt guard to `>= now` (or a future instant), which NO real run's
    //     startedAt can satisfy, turning every Generate into "pay for
    //     Director/Judge, claim ads, discard everything" — a total silent
    //     generation outage.
    //   staleMin (REAP_STALE_MIN) — load-bearing for duplicate detection on
    //     RUNNING runs, and for the Ad/running-run reapers in worker.js. A
    //     nonsense value here does not break the flip, but it does blind the
    //     gate to in-flight billing runs, which is a double-bill.
    //
    // Both fall back to their documented default rather than being honoured,
    // which is the whole reason the shared parser exists. REAP_STALE_MIN is
    // dashboard-only; PREPARE_STALE_MIN ships in config/defaults.env. Either is
    // somewhere "set it to 0 to disable staleness" is the intuitive and
    // catastrophic move.
    //
    // It is read through the shared parser rather than clamped inline because
    // worker.js's reaper keys off the SAME bound, and the two used to parse it
    // differently — agreeing on every input except a negative, where the worker
    // resolved to 1 and got a ONE-MINUTE threshold, i.e. reaping live work
    // mid-render. The comment directly above states the invariant ("the two
    // cannot drift into disagreeing about what stale means"); one parser is
    // what actually enforces it.
    const staleMin = reapStaleMin();
    // The PREPARING-lifecycle window. Read once here and handed to BOTH the
    // gate's preparing arm and the flip's age guard, so the two are equal by
    // construction rather than by two call sites agreeing on a constant.
    // Everything the outage note above says about '0'/blank/negative applies to
    // this var identically — same parser, same fail-to-default behaviour.
    const prepareMin = prepareStaleMin();

    // The fingerprint is built from the PARSED values, not raw req.body, so the
    // hash sees exactly what the expansion will (parsedVideoDurationSec, the
    // validated phase3 fields). Anything the handler does not read must stay out
    // — see the trap note in services/generationGate.js.
    const requestFingerprint = computeRequestFingerprint({
      campaignId,
      productIds,
      mediaIds,
      templateIds,
      preset,
      platformFormat,
      // Under 'explicit' the resolver IGNORES both of these (verified: the only
      // reads of requestedKinds / expandStaticFormats in expandWizardJob are the
      // two arguments it hands to resolvePreset). Hashing a field the handler
      // ignores is the false-ALLOW half of the trap in generationGate.js — it
      // makes two identical-output requests look different and lets a real
      // double-click through — so they are zeroed on that path.
      kinds:               isExplicitPreset ? null  : kinds,
      expandStaticFormats: isExplicitPreset ? false : expandStaticFormats,
      // The RESOLVED surface sets — what will actually bill. See the
      // normalisation note above for why the raw arrays must not be hashed.
      // Empty for every non-explicit preset, which is correct: those presets
      // ignore the lists entirely, so leftover client state cannot change the
      // hash of an otherwise-identical request.
      staticFormats: resolvedExplicit.staticFormats,
      videoFormats:  resolvedExplicit.videoFormats,
      includeCategoryMatched,
      includeBrandMatched,
      excludePairings,
      cta,
      urlParams,
      videoDurationSec: parsedVideoDurationSec,
      directorVariants:     phase3.fields.directorVariants,
      seedPicks:            phase3.fields.seedPicks,
      seedMediaIds:         phase3.fields.seedMediaIds,
      videoPromptGuidance:  phase3.fields.videoPromptGuidance,
      videoPromptRaw:       phase3.fields.videoPromptRaw
      // `refresh` is intentionally not passed — it never reaches expandWizardJob,
      // so it cannot change the output. computeRequestFingerprint documents why
      // hashing a dead field would be a money bug, not a harmless extra.
    });
    const ackRunId = confirmDuplicate && acknowledgedRunId ? String(acknowledgedRunId) : null;

    const activeRuns = await CampaignRun.find(buildActiveRunsFilter({
      campaignId,
      now: Date.now(),
      runningStaleMin:   staleMin,
      preparingStaleMin: prepareMin
    })).select('runId status createdAt requestedProductIds requestFingerprint').lean();

    // The most recent FINISHED run making this exact request, for the
    // "you already ran this" notice. Bounded by DUPLICATE_LOOKBACK_MIN (default
    // 24h) so the lookup stays indexed and a month-old run does not nag forever.
    // Skipped entirely once the user has confirmed — no point querying for a
    // conflict we have already been told to ignore.
    //
    // `total: { $gt: 0 }` is load-bearing, not a tidy-up. The notice exists to say
    // "this already produced ads and cost money", so a run that minted nothing
    // must not raise it. Two kinds of row would otherwise do exactly that, and
    // both are rows THIS handler writes: the mint-then-verify loser (marked
    // 'failed' at stage 'gate', total 0, nothing generated or charged) and a run
    // that failed during expansion. Without this filter, losing a harmless
    // double-click race would make the operator's next honest attempt demand a
    // confirmation for work that never happened.
    const dupLookbackMin = Number(process.env.DUPLICATE_LOOKBACK_MIN || 1440);
    const priorRun = ackRunId ? null : await CampaignRun.findOne({
      campaignId,
      requestFingerprint,
      status: { $in: ['done', 'failed'] },
      total: { $gt: 0 },
      createdAt: { $gte: new Date(Date.now() - dupLookbackMin * 60 * 1000) }
    }).select('runId status createdAt requestFingerprint total').sort({ createdAt: -1 }).lean();

    const gate = generationGateDecision({
      activeRuns,
      priorRun,
      fingerprint: requestFingerprint,
      requestedProductIds: productIds,
      acknowledgedRunId: ackRunId
    });
    if (gate.blocked) {
      const conflict =
        activeRuns.find(r => String(r.runId) === String(gate.conflictRunId)) ||
        (priorRun && String(priorRun.runId) === String(gate.conflictRunId) ? priorRun : null);
      const error = gate.reason === 'duplicate-of-previous'
        ? 'You already ran this exact request. Generating again will produce new creative ' +
          'and will be billed again — confirm to run it anyway.'
        : 'This exact request is already generating. Wait for it to finish, or confirm to ' +
          'run it a second time — that produces new creative and is billed again.';
      return res.status(409).json({
        error,
        code: 'generation-already-running',
        reason: gate.reason,
        // The client re-POSTs the same body with confirmDuplicate:true and this
        // value as acknowledgedRunId to proceed. Single-use by construction: it
        // names the run the user was shown, so a second stray confirm collides
        // with the newly minted run instead and is refused again.
        confirmable: gate.confirmable === true,
        acknowledgeRunId: gate.acknowledgeRunId || null,
        runId: conflict?.runId || gate.conflictRunId || null,
        startedAt: conflict?.createdAt || null
      });
    }

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
      startedAt:    new Date(),
      // Scope for the concurrency gate above. MUST be written here, at mint
      // time: the gate runs while sibling runs are still 'preparing', long
      // before the expansion fills perProduct.
      requestedProductIds: normalizeProductIdList(productIds),
      // What the gate actually compares now. MUST be written at mint time for
      // the same reason, and an unstamped run is no longer safe-by-default in the
      // other direction: a run with no fingerprint cannot be proven identical to
      // anything, so it will NOT block a sibling (deliberate — see the fail-open
      // note in services/generationGate.js). Dropping this write would silently
      // disable double-click protection rather than over-block.
      requestFingerprint,
      // UGC-ads Phase 3. Persisted here (not at expansion time) so a run that
      // gets superseded by the concurrency gate still records the operator's
      // intent — matters for the wizard's "which UGC did this run seed?"
      // diagnostics. adRegenerateService reads seedUgcIds[0] as the ref-1
      // override; single-entry list is the Phase 2 wizard's MVP shape, array
      // leaves room for Phase 7's batch (one seed per expanded product).
      seedUgcIds: preferUgcMediaId ? [String(preferUgcMediaId)] : [],
      // Overlap notice is known at mint time (same object the 202 returns).
      // The unclaimed-overflow notice is stamped after claim — see the
      // $set below. Both use the { code, message, ... } shape.
      notice: gate.notice || null
    });

    // MINT-THEN-VERIFY — closes the read-then-write race in the gate above.
    // Two clicks can both read activeRuns before either row exists, both see an
    // idle campaign, and both go on to expand and bill. Now that our own run IS
    // inserted, re-read: if an EARLIER in-flight run already made this exact
    // request, we are the loser and abort here — before expandWizardJob, so
    // nothing has been minted or charged. services/generationGate.js owns the
    // ordering rule; both racers compute the same winner, so exactly one aborts.
    //
    // This is also what keeps the duplicate OVERRIDE from being a hole: two
    // simultaneous "Generate anyway" clicks both carry the same
    // acknowledgedRunId, so neither is excused from the other, and the later one
    // still aborts here.
    const superseding = pickSupersedingRun({
      selfRun: { runId, createdAt: run.createdAt },
      // Same filter builder as the pre-check above — the race check must see
      // the SAME population the pre-check did, or it protects a different set.
      activeRuns: await CampaignRun.find(buildActiveRunsFilter({
        campaignId,
        now: Date.now(),
        runningStaleMin:   staleMin,
        preparingStaleMin: prepareMin
      })).select('runId status createdAt requestedProductIds requestFingerprint').lean(),
      fingerprint: requestFingerprint,
      requestedProductIds: productIds,
      acknowledgedRunId: ackRunId
    });
    if (superseding) {
      console.warn(
        `⚠️  [campaignRun ${runId}] superseded by concurrent run ${superseding.runId} ` +
        `making the identical request — aborting before expand`
      );
      // Do NOT swallow this write. A loser left in 'preparing' is a zombie that
      // blocks its own request for the whole stale window — the exact
      // false-block this change exists to remove. If the update fails, drop the
      // row instead: it describes work that never happened, so there is nothing
      // worth keeping, and a lingering lock is the more expensive outcome.
      try {
        await CampaignRun.updateOne(
          { _id: run._id },
          { status: 'failed', completedAt: new Date(),
            $push: { errors: { index: 0, stage: 'gate',
              message: `Superseded by concurrent run ${superseding.runId}; nothing was generated.` } } }
        );
      } catch (err) {
        console.error(
          `❌ [campaignRun ${runId}] could not mark superseded run failed (${err.message}) — ` +
          `deleting the row so it cannot lock these products`
        );
        await CampaignRun.deleteOne({ _id: run._id }).catch(e =>
          console.error(`❌ [campaignRun ${runId}] delete also failed: ${e.message} — ` +
            `row may block an identical request until the stale window expires`));
      }
      return res.status(409).json({
        error: 'An identical generation started at the same moment. Nothing was generated ' +
               'or charged for this request — watch the other run.',
        code: 'generation-already-running',
        reason: 'raced-concurrent-run',
        // Deliberately NOT confirmable. The user already confirmed if they got
        // here via the override; re-offering it on a photo-finish race would just
        // invite the double-spend the race check exists to stop.
        confirmable: false,
        runId: superseding.runId,
        startedAt: superseding.createdAt
      });
    }

    res.status(202).json({
      campaignRunId: runId,
      campaignId:    String(campaignId),
      brandId:       String(campaignDoc.brandId),
      campaignKind:  campaignDoc.kind || 'product',
      total:         0,
      queuedRemaining: 0,
      status:        'preparing',
      // Non-blocking information, not a verdict. Same shape as every other
      // generate notice: { code, message, ... }. Overlap is the only entry
      // known at 202 time — expand+claim have not run yet (Director can take
      // ~28s; this 202 exists so Render's edge does not cut the request).
      // Unclaimed-overflow (minted N, claimed 20) is stamped on the run after
      // claim and returned by GET /runs/:runId in this same `notice` field,
      // matching how `total` / `perProduct` already work.
      notice: gate.notice || null
    });

    setImmediate(async () => {
      let adIds;
      try {
        // SELF-STATUS CHECK before spending a cent. The gate considers a
        // preparing run only while it is younger than PREPARE_STALE_MIN by mint
        // age (a running run is tracked separately, and stays visible for as
        // long as it keeps heartbeating within REAP_STALE_MIN). So a run wedged
        // in 'preparing' past that window stops holding its products — a sibling
        // Generate for the SAME
        // products is then allowed. If this run later wakes up and expands
        // anyway, both bill. Re-reading our own status makes that terminal: a run
        // whose row was reaped, failed, or superseded aborts instead of minting.
        // Cheap (one indexed read) and it runs before expandWizardJob, so an
        // abort costs nothing.
        const stillOurs = await CampaignRun.findOne({ _id: run._id })
          .select('status').lean();
        if (!stillOurs || stillOurs.status !== 'preparing') {
          console.warn(
            `⚠️  [campaignRun ${runId}] no longer preparing ` +
            `(status=${stillOurs?.status || 'deleted'}) — aborting before expand, nothing charged`
          );
          return;
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
          preset,
          excludePairings,
          includeCategoryMatched,
          includeBrandMatched,
          videoDurationSec: parsedVideoDurationSec,
          expandStaticFormats,
          // The SAME resolved lists that were fingerprinted. resolveExplicitFormats
          // is idempotent, so forwarding these rather than the raw arrays changes
          // nothing about what is generated — it just makes it impossible for the
          // hashed set and the generated set to drift apart.
          staticFormats: isExplicitPreset ? resolvedExplicit.staticFormats : staticFormats,
          videoFormats:  isExplicitPreset ? resolvedExplicit.videoFormats  : videoFormats,
          directorVariants: phase3.fields.directorVariants,
          seedMediaIds: phase3.fields.seedMediaIds,
          seedPicks: phase3.fields.seedPicks,
          videoPromptGuidance: phase3.fields.videoPromptGuidance,
          videoPromptRaw: phase3.fields.videoPromptRaw,
          // Scopes the static identityDigest to THIS run, so generating twice on
          // the same campaign produces two sets of ads instead of the second one
          // colliding with the first and expanding to nothing.
          generationRunId: run.runId,
          requestedBy: req.user?.userId || null,
          // UGC-ads Phase 3. Threaded through so buildSeededUniverse can
          // hoist this Media to seed index 0. Gated on UGC_FIRST_SEEDING
          // inside the service — flag OFF is byte-identical to omitting it.
          preferUgcMediaId
        });

        // `newlyQueued`, NOT `queuedCount`. queuedCount is
        // countDocuments({ campaignId, status: 'queued' }) — every queued ad in
        // the whole campaign, which is a different question entirely. It read 0
        // for any campaign whose ads had all moved on to draft/rendered/failed,
        // so a perfectly good expansion was discarded before selectAdsForRun and
        // the run finished as done/total:0 with nothing on screen. Observed in
        // production on 2026-08-01: campaign 6a6a52cd had 63 image drafts, 23
        // video drafts and zero queued, and two consecutive Generates produced
        // nothing at all.
        const newlyQueued = Array.isArray(job.newAdIds) ? job.newAdIds.length : (job.newlyQueued || 0);

        // A product that THREW is not a product that produced nothing, and the
        // two used to collapse into the same "Nothing to render" done/total:0
        // run. That is how a ReferenceError inside the Director — which broke
        // every fresh concept round — reached the operator as an empty
        // selection with no way to tell it from a hang.
        //
        // After normalizePerProductEntry, `skipped` is a boolean and the
        // machine code lives on `reason`. Accept both shapes so a partial
        // rollout or a raw expansion row cannot re-hide the error.
        const perProduct = Array.isArray(job.perProduct) ? job.perProduct : [];
        const productErrors = perProduct.filter((r) =>
          r && (r.reason === PER_PRODUCT_REASON.ERROR || r.skipped === 'error' ||
                (r.skipped === true && r.reason === PER_PRODUCT_REASON.ERROR))
        );
        const errorEntries = productErrors.map((r, i) => ({
          index: i,
          stage: 'expand',
          productId: r.productId || undefined,
          message: `${r.errorName || 'Error'}: ${r.error || r.message || 'unknown error'}` +
                   (r.productId ? ` (product=${r.productId})` : '')
        }));

        // Persist per-product outcomes on every terminal expand path so the
        // poller can show them. A reporting write failure must not abort the
        // run — catch individually on each update below is already the pattern.
        const perProductSet = { perProduct };

        if (newlyQueued === 0) {
          // Threw, so the run FAILED — it did not quietly finish with nothing.
          if (errorEntries.length) {
            await CampaignRun.updateOne(
              { _id: run._id },
              { status: 'failed', completedAt: new Date(),
                $set: perProductSet,
                $push: { errors: { $each: errorEntries } } }
            );
            return;
          }
          // Say the REAL reason. perProduct already carries machine codes;
          // summarizeEmptyExpansion turns a uniform skip into that sentence
          // and mixed skips into a count summary. The old generic line
          // ("check imagery and templates") actively misled when the
          // Director returned nothing.
          const reason = summarizeEmptyExpansion({
            perProduct,
            alreadyQueued: job.alreadyQueued
          });
          await CampaignRun.updateOne(
            { _id: run._id },
            { status: 'done', completedAt: new Date(),
              $set: perProductSet,
              $push: { errors: { index: 0, stage: 'expand', message: reason } } }
          );
          return;
        }

        // PARTIAL: some products queued, others threw. Record the throws so the
        // run is not presented as a clean success, but do not abort — the ads
        // that did queue are already paid for and must still render.
        // Always stamp perProduct so the UI can show which products skipped
        // even when the run continues into render.
        if (errorEntries.length) {
          await CampaignRun.updateOne(
            { _id: run._id },
            { $set: perProductSet, $push: { errors: { $each: errorEntries } } }
          );
        } else if (perProduct.length) {
          await CampaignRun.updateOne(
            { _id: run._id },
            { $set: perProductSet }
          ).catch(() => {});
        }

        // Scope to the product(s) the operator actually picked. Unscoped, this
        // renders the campaign's OLDEST queued ads (see selectAdsForRun), so a
        // Generate for one product filled most of its 20 slots with leftovers
        // from earlier sessions for OTHER products — and billed for them.
        // ⚠️ MONEY — scope the claim to the kinds THIS request resolved to.
        //
        // selectAdsForRun is kind-blind by default and its tier 0 drains
        // renderRoute:'veo' FIRST, so a static-only Generate used to claim and
        // render leftover queued VIDEO for the same product from an earlier
        // session — ahead of the statics just asked for, and billing an Omni
        // submit per row. That is half of the owner-reported "I selected static
        // ads for Meta and got a video"; the other half was campaign.adKinds
        // defaulting to 'both' (see requestedKinds in expandWizardJob).
        //
        // resolvedKinds comes back FROM the expansion rather than being
        // re-derived here: the route does not know campaign.platformFormat, and
        // resolveKinds intersects the request against the surface's
        // capabilities, so a second derivation would drift from the one that
        // decided what got queued. Absent (older shape / legacy path) → omit the
        // filter and keep today's behaviour rather than guessing.
        adIds = await selectAdsForRun({
          campaignId,
          limit: MAX_CREATIVES_PER_RUN,
          productIds,
          kinds: Array.isArray(job?.resolvedKinds) ? job.resolvedKinds : null
        });
        if (!adIds.length) {
          const mintedIds = Array.isArray(job.newAdIds) ? job.newAdIds.map(String) : [];
          const unclaimedNotice = buildUnclaimedNotice({
            minted: mintedIds.length, claimed: 0, unclaimed: mintedIds.length
          });
          await CampaignRun.updateOne(
            { _id: run._id },
            { status: 'done', completedAt: new Date(),
              $set: {
                mintedTotal: mintedIds.length,
                unclaimedAtStart: mintedIds.length,
                ...(unclaimedNotice ? { notice: unclaimedNotice } : {})
              },
              $push: { errors: { index: 0, stage: 'select', message: 'Selection returned empty' } } }
          );
          return;
        }

        // ATOMIC CLAIM. `status: 'queued'` in the filter is load-bearing and
        // is what makes this a claim rather than an announcement.
        //
        // selectAdsForRun reads queued ads, and this write marked them
        // rendering — with no status condition. Between the read and the write
        // another Generate could select the SAME ad and claim it too, and both
        // runs would then render it. Atlas bills image generation ON SUBMIT, so
        // that is a straight double charge for one ad, with the second result
        // overwriting the first. Two operators pressing Generate at once, or a
        // double-clicked button, is all it took.
        //
        // Conditioning on 'queued' means the loser's update matches nothing for
        // that ad, so exactly one run can own it.
        await Ad.updateMany(
          { _id: { $in: adIds }, status: 'queued' },
          {
            $addToSet: { campaignRunIds: runId },
            $set:      { status: 'rendering', updatedAt: new Date() }
          }
        );

        // Re-read what we ACTUALLY won. updateMany's modifiedCount cannot tell
        // us WHICH ids were claimed, and rendering an ad this run does not own
        // is the double-charge we just closed.
        const claimed = await Ad.find({ _id: { $in: adIds }, status: 'rendering', campaignRunIds: runId })
          .select('_id')
          .lean();
        const claimedIds = claimed.map(a => a._id);
        if (claimedIds.length !== adIds.length) {
          console.warn(
            `⚠️  [campaignRun ${runId}] claimed ${claimedIds.length}/${adIds.length} ad(s) — ` +
            `the rest were taken by a concurrent run`
          );
        }
        adIds = claimedIds;
        if (!adIds.length) {
          const mintedIds = Array.isArray(job.newAdIds) ? job.newAdIds.map(String) : [];
          const unclaimedNotice = buildUnclaimedNotice({
            minted: mintedIds.length, claimed: 0, unclaimed: mintedIds.length
          });
          await CampaignRun.updateOne(
            { _id: run._id },
            { status: 'done', completedAt: new Date(),
              $set: {
                mintedTotal: mintedIds.length,
                unclaimedAtStart: mintedIds.length,
                ...(unclaimedNotice ? { notice: unclaimedNotice } : {})
              },
              $push: { errors: { index: 0, stage: 'select', message: 'All selected ads were claimed by a concurrent run' } } }
          );
          return;
        }

        // `total` stays the CLAIM count (progress-bar denominator). Minted
        // leftovers are recorded separately so the bar does not hang at
        // 20/34 — leftovers are not in this run and will never increment
        // succeeded/failed/skipped. See models/CampaignRun.js.
        const mintedIds = Array.isArray(job.newAdIds) ? job.newAdIds.map(String) : [];
        const claimedSet = new Set(adIds.map(String));
        const mintedTotal = mintedIds.length;
        const unclaimedAtStart = mintedIds.filter((id) => !claimedSet.has(id)).length;
        const unclaimedNotice = buildUnclaimedNotice({
          minted: mintedTotal,
          claimed: mintedTotal - unclaimedAtStart,
          unclaimed: unclaimedAtStart
        });

        // COMPARE-AND-SWAP, keyed on status:'preparing' AND age. THIS is the
        // money guard — see buildRunningFlipFilter's comment for why a bare
        // status check is not enough on its own: the concurrency gate above
        // stops honoring a 'preparing' run's exclusivity once it is older than
        // prepareMin, on every request, independent of whether the worker's
        // reaper has actually ticked. Passing the SAME prepareMin here means
        // this flip refuses at the identical instant the gate already stopped
        // counting this run as active — closing the window a bare status guard
        // would leave open (a duplicate sails through as "not active", bills a
        // sibling run, and this one's slow expansion finishes minutes later
        // and would otherwise flip anyway).
        //
        // ⚠️ prepareMin, NOT staleMin. This used to pass staleMin
        // (REAP_STALE_MIN, 15) and that was the defect: 15 is the heartbeat
        // window for CLAIMED work, but a preparing run does not heartbeat and
        // its healthy runtime is ~18-20 min (worker.js). Expansions that
        // finished normally at T=18 lost this CAS and were reported to the
        // operator as crashes. The guard stays; the window it uses is now the
        // preparing one, and the gate's preparing arm above reads the SAME
        // variable so the two cannot disagree.
        const flip = await CampaignRun.updateOne(
          buildRunningFlipFilter(run._id, { now: Date.now(), staleMin: prepareMin }),
          { $set: {
            total: adIds.length,
            status: 'running',
            mintedTotal,
            unclaimedAtStart,
            ...(unclaimedNotice ? { notice: unclaimedNotice } : {})
          } }
        );
        // Defensive on the result shape, not just the value: this repo does
        // not trust matchedCount blindly elsewhere either (see
        // services/runFeedService.js's modifiedCount ?? nModified) — a
        // driver/mongoose version that ever reverted to the old {n,nModified}
        // shape would make `!flip.matchedCount` true for EVERY run, silently
        // discarding all generation. Recompute conservatively.
        const flipMatched = flip.matchedCount ?? flip.nModified ?? flip.n ?? 0;
        if (!flipMatched) {
          // Either reaped (status no longer 'preparing') or aged past
          // prepareMin while still 'preparing' (the gate-window case above —
          // this run may still get marked 'failed' by the reaper later, but
          // it must not render regardless). The Ads we just claimed are
          // receipt-free by construction — the first billable submit happens
          // inside runRenderLoop, which we are about to skip — so release
          // them back to 'queued' rather than stranding them in 'rendering'
          // with no run that will ever render them.
          //
          // Clear renderStage/renderStageAt on release: adStage() writes it
          // unconditionally on every render attempt and NOTHING ever clears
          // it, so an ad recycled from an earlier reap-and-reclaim cycle
          // would otherwise still carry a stale non-null renderStage here —
          // and services/strandedRunSweeper.js auto-requeues exactly that
          // shape (status:'queued' + campaignRunIds of a 'failed' run +
          // renderStage set) into a REAL billable re-render with no operator
          // click. A freshly-claimed ad has no renderStage yet, so this is a
          // no-op for the common case and a real guard for the recycled one.
          console.warn(
            `⚠️  [campaignRun ${runId}] lost the running-flip CAS (reaped, superseded, or aged past ${prepareMin}m) — ` +
            `releasing ${adIds.length} claimed ad(s) back to queued without rendering`
          );
          // Logged, not silently swallowed: the warn above already claims the
          // release happened, so a failed write here must not vanish — if it
          // fails, these ads are stranded in 'rendering' with no run left to
          // ever render them (worker.js's reaper still recovers them on its
          // own next pass, but that's minutes later and worth knowing about).
          await Ad.updateMany(
            receiptFree({ _id: { $in: adIds }, status: 'rendering', campaignRunIds: runId }),
            { $set: { status: 'queued', updatedAt: new Date(), renderStage: null, renderStageAt: null } }
          ).catch((err) => console.error(
            `❌ [campaignRun ${runId}] failed to release ${adIds.length} claimed ad(s) after losing the CAS: ${err.message}`
          ));
          return;
        }

        await runRenderLoop(run, { ...job, platformFormat }, adIds, renderToken);
      } catch (err) {
        console.error(`❌ campaign run ${runId} prep/render crashed:`, err);
        inFlight.untrack(runId);
        alerts.notifyAsync({
          level: 'error',
          title: 'Campaign run crashed during prep/render',
          key:   'run-crash:generate',
          fields: { run: runId, campaign: campaignId, ads: (adIds || []).length, error: err.message || String(err) },
          detail: err.stack || null
        });
        if (adIds && adIds.length) {
          await Ad.updateMany(
            receiptFree({ _id: { $in: adIds }, status: 'rendering' }),
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

// ── claimAdsForRun ────────────────────────────────────────────────────
// THE claim sequence for POST /runs. Live handler and offline harness
// both call this function. Data access is injected so the harness can
// drive the exact same code path with an in-memory fake — not a parallel
// model that drifts from production.
//
// Sequence (do not reorder; 422/anomaly before any 202):
//   1. Atomic updateMany with status:'queued' (load-bearing — Atlas bills
//      on submit; without this filter two concurrent /runs both render).
//   2. Ownership re-read: status:'rendering' + campaignRunIds: runId.
//   3. modifiedCount vs re-read cross-check (anomaly → release + error).
//   4. Outcome: empty → 422; won → claimed set as renderIds/total.
//
// ads must expose:
//   updateMany(filter, update) → Promise<{ modifiedCount: number }>
//   find(filter)               → Promise<Array<{ _id }>>
//   (optional, for harness completeness) countDocuments is NOT part of
//   this function — the route uses it after a successful claim.

/**
 * @param {{
 *   updateMany: (filter: object, update: object) => Promise<{modifiedCount?: number}>,
 *   find: (filter: object) => Promise<Array<{_id: any}>>
 * }} ads
 * @param {{ selectedIds: any[], runId: string }} args
 */
async function claimAdsForRun(ads, { selectedIds, runId }) {
  // ATOMIC CLAIM. `status: 'queued'` in the filter is load-bearing and
  // is what makes this a claim rather than an announcement.
  //
  // selectAdsForRun reads queued ads, and this write marks them
  // rendering. Without the status condition, between the read and the
  // write a concurrent /runs (or a racing /generate) can select the SAME
  // ads and claim them too — both runs then render them. Atlas bills
  // image/video generation ON SUBMIT, so that is a straight double charge
  // for one ad, with the second result overwriting the first. Two live
  // frontend callers hit this endpoint; a double-clicked "render next
  // batch" is enough.
  //
  // Conditioning on 'queued' means the loser's update matches nothing for
  // that ad, so exactly one run can own it.
  const writeResult = await ads.updateMany(
    { _id: { $in: selectedIds }, status: 'queued' },
    {
      $addToSet: { campaignRunIds: runId },
      $set:      { status: 'rendering', updatedAt: new Date() }
    }
  );
  const modifiedCount = Number(writeResult && writeResult.modifiedCount) || 0;

  // Re-read what we ACTUALLY won. updateMany's modifiedCount cannot tell
  // us WHICH ids were claimed, and rendering an ad this run does not own
  // is the double-charge we just closed. Ownership filters are load-bearing:
  // gutting them to `{ _id: { $in: selectedIds } }` re-opens double-charge
  // for the loser of a concurrent claim.
  const claimedDocs = await ads.find({
    _id: { $in: selectedIds },
    status: 'rendering',
    campaignRunIds: runId
  });
  const claimedById = new Set(
    (Array.isArray(claimedDocs) ? claimedDocs : []).map((a) => String(a._id))
  );
  // Preserve selection order so renderIds is a stable subset of selectedIds.
  const claimedIds = selectedIds
    .map((id) => String(id))
    .filter((id) => claimedById.has(id));

  // Anomaly: the write reported success but the ownership re-read found
  // nothing. Under primary reads + acknowledged writes this should never
  // fire — if it does, the ads may sit in 'rendering' with this runId while
  // the client is told "another run took them" (a lie that orphans them).
  // Release best-effort, log loudly, return a confirmation error — NOT 422.
  if (modifiedCount > 0 && claimedIds.length === 0) {
    console.error(
      `🚨 [campaignRun ${runId}] CLAIM ANOMALY: updateMany modifiedCount=${modifiedCount} ` +
      `but ownership re-read returned 0 of ${selectedIds.length} selected id(s). ` +
      `Releasing claim; client will not be told "another run took them".`
    );
    try {
      await ads.updateMany(
        { _id: { $in: selectedIds }, status: 'rendering', campaignRunIds: runId },
        { $set: { status: 'queued', updatedAt: new Date() } }
      );
    } catch (releaseErr) {
      console.error(
        `🚨 [campaignRun ${runId}] CLAIM ANOMALY: failed to release after unconfirmed claim:`,
        releaseErr
      );
    }
    return {
      kind: 'anomaly',
      httpStatus: 500,
      error: 'Claim could not be confirmed; nothing will be rendered',
      createCampaignRun: false,
      startRenderLoop: false,
      total: 0,
      renderIds: [],
      claimedIds: [],
      modifiedCount
    };
  }

  if (!claimedIds.length) {
    // Normal empty claim: write matched nothing, re-read confirms zero.
    return {
      kind: 'empty',
      httpStatus: 422,
      error: 'Selected ads were claimed by another run; nothing left to render',
      createCampaignRun: false,
      startRenderLoop: false,
      total: 0,
      renderIds: [],
      claimedIds: [],
      modifiedCount
    };
  }

  // CLAIMED count — not selectedIds.length. A partial claim must not
  // advertise or render ads this run lost. renderIds MUST come from the
  // re-read; aliasing back to selectedIds is a double-charge regression.
  return {
    kind: 'ok',
    httpStatus: 202,
    createCampaignRun: true,
    startRenderLoop: true,
    total: claimedIds.length,
    renderIds: claimedIds,
    claimedIds,
    modifiedCount
  };
}

// POST /api/ads/runs
// Body: { campaignId }
// "Generate more from this campaign" — picks the next N queued ads
// and renders them in a new CampaignRun. No re-queueing; just drains
// inventory that expandWizardJob already created.
// Response: 202 Accepted { campaignRunId, total, queuedRemaining, status }
//           422 if selection was empty OR the atomic claim won nothing
router.post('/runs', express.json(), async (req, res) => {
  // Tracks ads this request successfully claimed so the catch can release
  // them if a later step throws (countDocuments / CampaignRun.create).
  // Without that, ads sit status:'rendering' with nobody rendering them.
  let claimedIds = [];
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

    const selectedIds = await selectAdsForRun({ campaignId, limit: MAX_CREATIVES_PER_RUN });
    if (!selectedIds.length) {
      return res.status(422).json({ error: 'No queued ads remaining for this campaign' });
    }

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

    // Live Ad model adapter — same function the offline harness drives
    // with an in-memory fake. Do not inline a second claim path here.
    const claim = await claimAdsForRun(
      {
        updateMany: (filter, update) => Ad.updateMany(filter, update),
        find: (filter) => Ad.find(filter).select('_id').lean()
      },
      { selectedIds, runId }
    );

    // Claim + empty-claim 422 / anomaly MUST complete before the 202 is
    // flushed — once we respond 202 we cannot take it back.
    if (claim.kind === 'anomaly') {
      return res.status(claim.httpStatus).json({ error: claim.error });
    }
    if (claim.httpStatus === 422) {
      return res.status(422).json({ error: claim.error });
    }

    claimedIds = claim.claimedIds;
    if (claimedIds.length !== selectedIds.length) {
      console.warn(
        `⚠️  [campaignRun ${runId}] /runs claimed ${claimedIds.length}/${selectedIds.length} ad(s) — ` +
        `the rest were taken by a concurrent run`
      );
    }

    // Recompute AFTER the claim so we don't subtract ads we never owned
    // (and so concurrent winners are reflected in the remainder).
    const queuedRemaining = await Ad.countDocuments({ campaignId, status: 'queued' });

    // Declare this run's product scope for the /generate concurrency gate, so a
    // drain of pre-queued ads no longer blocks a Generate for OTHER products.
    // Read off the ads we actually claimed — that IS the scope.
    //
    // Overlap still has to block: these ads are already minted, but a /generate
    // for the same product would mint NEW ads for the same
    // (product, template, aspect) under a fresh run-scoped digest — one
    // creative, two charges. So partial knowledge is not good enough: if ANY
    // claimed ad has no productId, we cannot describe the scope honestly, and an
    // empty array is the value the gate reads as "unknown" and fails closed on.
    let claimedProductIds = [];
    try {
      const claimedAds = await Ad.find({ _id: { $in: claimedIds } })
        .select('productId').lean();
      claimedProductIds = claimedAds.some(a => !a.productId)
        ? []
        : normalizeProductIdList(claimedAds.map(a => a.productId));
    } catch (err) {
      // Unreadable → leave empty (fail closed), never guess a narrower scope.
      console.warn(`   ⚠️  [campaignRun ${runId}] could not scope claimed products: ${err.message}`);
    }

    const run = await CampaignRun.create({
      runId,
      brandId:      String(campaign.brandId),
      campaignId:   String(campaign._id),
      campaignKind: campaign.kind || 'promotional',
      total:        claim.total,
      status:       'running',
      requestedBy:  req.user?.userId || null,
      startedAt:    new Date(),
      requestedProductIds: claimedProductIds,
      // A render claim is not a generation request — it mints no ads and bills no
      // expansion, so it must never be mistaken for "the same request" as a
      // /generate and block one. Namespaced + unique per run, which is what makes
      // that true; leaving it null would fall into the product-set compat
      // comparison and refuse legitimate generates indefinitely.
      requestFingerprint: renderClaimFingerprint(runId)
    });

    res.status(202).json({
      campaignRunId:   runId,
      campaignId:      String(campaign._id),
      brandId:         String(campaign.brandId),
      campaignKind:    campaign.kind || 'promotional',
      total:           claim.total,
      queuedRemaining,
      status:          'running'
    });

    // Reuse the same runRenderLoop. job arg only carries the brand /
    // campaign metadata renderOne needs to thread into renderCreative.
    // Render ONLY claim.renderIds — never the pre-claim selection.
    // (Aliasing renderIds = selectedIds is a double-charge regression the
    // harness is designed to fail on.)
    const renderIds = claim.renderIds;
    const job = {
      brandId:      String(campaign.brandId),
      campaignId:   String(campaign._id),
      campaignKind: campaign.kind || 'promotional'
    };
    setImmediate(() => {
      runRenderLoop(run, job, renderIds, renderToken).catch(err => {
        console.error(`❌ campaign run ${runId} crashed:`, err);
        inFlight.untrack(runId);
        alerts.notifyAsync({
          level: 'error',
          title: 'Campaign run crashed (queued drain)',
          key:   'run-crash:runs',
          fields: { run: runId, campaign: String(campaign._id), ads: renderIds.length, error: err.message || String(err) },
          detail: err.stack || null
        });
        Ad.updateMany(
          receiptFree({ _id: { $in: renderIds }, status: 'rendering' }),
          { $set: { status: 'queued', updatedAt: new Date() } }
        ).catch(() => {});
        CampaignRun.updateOne(
          { _id: run._id },
          { status: 'failed', completedAt: new Date() }
        ).catch(() => {});
      });
    });

  } catch (err) {
    // Mirror /generate: a post-claim throw must release the lock this
    // request took and then failed to use. Without requeue, ads sit
    // status:'rendering' with this runId until the reaper (~15 min) flips
    // them to 'queued' — and nothing auto-drains that queue. Guard the
    // requeue so a failure there cannot mask the original error.
    console.error('ads runs (queued drain) failed:', err);
    if (claimedIds.length) {
      try {
        await Ad.updateMany(
          receiptFree({ _id: { $in: claimedIds }, status: 'rendering' }),
          { $set: { status: 'queued', updatedAt: new Date() } }
        );
      } catch (requeueErr) {
        console.error(
          `ads runs: failed to requeue ${claimedIds.length} claimed ad(s) after error ` +
          `(original: ${err && err.message ? err.message : err}):`,
          requeueErr
        );
      }
    }
    res.status(500).json({ error: err.message || 'ads runs failed' });
  }
});

// Background render loop. Runs after the response has flushed; updates
// the CampaignRun doc as each render finishes so the frontend's
// poller can show real-time progress.
async function runRenderLoop(run, job, adIds, renderToken) {
  const t0 = Date.now();
  // Partition the batch by renderRoute so veo (quota-limited) and image
  // (cheap, parallelizable) render in independent pools. A single mixed
  // batch used to fall back to VEO_CONCURRENCY for ALL ads because "any
  // veo ad ⇒ serialize everything" — which meant a 20-min Grok poll
  // starved 3 image ads that could have finished in <1 min. Two pools
  // dispatched via Promise.all restores parallelism.
  const routes = await Ad.find({ _id: { $in: adIds } }).select('_id renderRoute').lean();
  const routeById = new Map(routes.map((r) => [String(r._id), r.renderRoute || null]));
  const veoIds   = adIds.filter((id) => routeById.get(String(id)) === 'veo');
  const otherIds = adIds.filter((id) => routeById.get(String(id)) !== 'veo');
  const isVeoRun = veoIds.length > 0;
  console.log(
    `🚀 [campaignRun ${run.runId}] start — ${adIds.length} ad(s) ` +
    `concurrency=veo:${VEO_CONCURRENCY}(${veoIds.length}) image:${RENDER_CONCURRENCY}(${otherIds.length}) ` +
    `brand=${job.brandId} campaign=${job.campaignId} kind=${job.campaignKind || '-'}`
  );

  // Register with the in-flight registry so the SIGTERM handler can report
  // exactly how much work an instance replacement is about to orphan. This
  // loop lives in the web process and dies with it — see services/inFlight.js.
  inFlight.track(run.runId, { total: adIds.length, brandId: job.brandId, veo: isVeoRun });

  // Per-run Slack feed — fire-and-forget, never awaited. Registers adIds so
  // adStage can route events without a Mongo round-trip. Parent message +
  // thread posts are owned by runFeedService's detached interval.
  runFeed.startRun({
    runId:   run.runId,
    brandId: job.brandId,
    total:   adIds.length,
    adIds
  });

  // Unified progress row (ActivityDock) — mirrors the CampaignRun
  // counters and adds cooperative cancel: the pool stops claiming new
  // ads, in-flight renders finish, unclaimed ads flip to skipped.
  const { startRun } = require('../services/progressService');
  const brandDoc = await require('../models/Brand').findById(job.brandId).select('advertiserId name').lean().catch(() => null);
  if (brandDoc?.name) {
    // Best-effort label enrichment — still fire-and-forget.
    runFeed.startRun({
      runId: run.runId, brandId: job.brandId, brandName: brandDoc.name,
      total: adIds.length, adIds
    });
  }
  const progressRun = await startRun({
    kind: 'ad-batch',
    advertiserId: brandDoc?.advertiserId,
    brandId: job.brandId,
    total: adIds.length,
    // Label reflects the mix — mostly for the ActivityDock header.
    label: isVeoRun && otherIds.length ? 'Ad generation (mixed)'
         : isVeoRun ? 'Video ad generation'
         : 'Ad generation',
  });
  progressRun.stage('rendering');

  // Preserve stable "position in batch" via the shared adIds order — the
  // index gets stamped into CampaignRun.errors[] rows and log lines. Each
  // pool consumes its own slice but keeps the original index.
  const indexOf = new Map(adIds.map((id, i) => [String(id), i]));
  let done      = 0;
  let cancelled = false;
  // Each pool tracks its own remaining-work cursor so the cancel path
  // can requeue precisely what it didn't reach.
  const pools = [
    { name: 'veo',   concurrency: VEO_CONCURRENCY,    queue: veoIds.map((id) => ({ adId: id, index: indexOf.get(String(id)) })),   next: 0, inflight: 0 },
    { name: 'image', concurrency: RENDER_CONCURRENCY, queue: otherIds.map((id) => ({ adId: id, index: indexOf.get(String(id)) })), next: 0, inflight: 0 }
  ].filter((p) => p.queue.length > 0);

  await Promise.all(pools.map((pool) => new Promise((resolve) => {
    const dispatch = async () => {
      // AWAITED, not fire-and-forget. checkpoint() is async (it reads
      // cancelRequested from Mongo) and signals cancellation by THROWING, so
      // `.catch(() => cancelled = true)` could only ever run on a later
      // microtask. The synchronous while-loop below therefore ran first with a
      // stale `cancelled === false` and claimed a whole extra wave of renders
      // AFTER the operator pressed Stop — every one of them billable. Awaiting
      // costs one already-throttled read (1/s cache in progressService) per
      // dispatch cycle and makes Stop mean stop.
      try {
        await progressRun.checkpoint();
      } catch {
        cancelled = true;
      }
      if (cancelled && pool.inflight === 0) return resolve();
      while (!cancelled && pool.inflight < pool.concurrency && pool.next < pool.queue.length) {
        const { adId, index } = pool.queue[pool.next++];
        pool.inflight++;
        renderOne(run, job, adId, index, renderToken)
          .catch(err => {
            console.error(`❌ [campaignRun ${run.runId}] #${index} (${pool.name}) dispatch crash:`, err.message || err);
          })
          .finally(() => {
            pool.inflight--;
            progressRun.tick(++done, adIds.length);
            inFlight.progress(run.runId, done);
            // Liveness heartbeat for the reaper — see the comment on the
            // pre-partition version for why we refresh updatedAt on every
            // completion instead of just at claim time. Scoped to
            // status:'rendering' so it never resurrects ads the cancel
            // path already re-queued.
            Ad.updateMany(
              { _id: { $in: adIds }, status: 'rendering' },
              { $set: { updatedAt: new Date() } }
            ).catch(() => {});
            if ((pool.next >= pool.queue.length || cancelled) && pool.inflight === 0) resolve();
            else dispatch().catch(() => resolve());
          });
      }
      if (cancelled && pool.inflight === 0) resolve();
    };
    dispatch().catch(() => resolve());
  })));

  // Cancelled mid-batch: unclaimed ads (bulk-flipped to 'rendering' at claim
  // time, before the loop) are ARCHIVED — see the block below for why.
  //
  // This comment used to say they "go BACK to the queue … we requeue the
  // untouched tail", which is the OPPOSITE of what the code does and was left
  // behind when the behaviour changed. It is money-adjacent — requeued ads get
  // billed on the next Generate — so a reader who trusts the top of the block
  // and stops there gets exactly the wrong model. Corrected 2026-08-03.
  //
  // Still true and still load-bearing: match on status:'rendering'. The
  // original status:'queued' filter matched nothing post-claim and stranded
  // unclaimed ads in 'rendering' forever (adversarial-review find).
  if (cancelled) {
    // ARCHIVE, do not re-queue. Putting cancelled ads back to 'queued' meant
    // the work the operator just stopped reappeared on the next Generate and
    // billed — Stop hid the button but bought the renders anyway. 'archived'
    // is in the Ad status enum and selectAdsForRun only ever matches 'queued',
    // so archived ads are invisible to every future run while staying
    // inspectable, and reversible in bulk.
    //
    // Two scopes, because "no more generation happens" means both: this run's
    // unclaimed tail, AND the campaign's remaining queued backlog that a
    // subsequent Generate would otherwise drain.
    //
    // Renders already in flight cannot be recalled — a dispatched image or
    // video call is already paid for — so those finish and are kept.
    let archivedThisRun = 0;
    const remaining = pools.flatMap((p) => p.queue.slice(p.next).map((q) => q.adId));
    if (remaining.length) {
      const r = await Ad.updateMany(
        { _id: { $in: remaining }, status: 'rendering' },
        { $set: { status: 'archived', updatedAt: new Date() } }
      ).catch(() => null);
      archivedThisRun = r?.modifiedCount || 0;
      await CampaignRun.updateOne({ _id: run._id }, { $inc: { skipped: remaining.length } }).catch(() => {});
    }
    const backlog = await Ad.updateMany(
      { campaignId: run.campaignId, status: 'queued' },
      { $set: { status: 'archived', updatedAt: new Date() } }
    ).catch(() => null);
    const archivedBacklog = backlog?.modifiedCount || 0;
    // Recorded on the run's own error log rather than as new top-level
    // fields: CampaignRun is strict, so unknown keys would be silently
    // stripped and the record would simply not exist.
    await CampaignRun.updateOne(
      { _id: run._id },
      { $push: { errors: {
          index: -1,
          stage: 'cancel',
          message: `Stopped by operator — ${archivedThisRun + archivedBacklog} pending ad(s) archived, not re-queued`
      } } }
    ).catch(() => {});
    console.log(
      `🛑 [campaignRun ${run.runId}] stopped by operator — archived ${archivedThisRun} unclaimed + ${archivedBacklog} backlog ad(s); in-flight renders finish`
    );
  }

  // Status-guarded. The reaper (worker.js reapOrphans) flips a silent
  // running run to 'failed' after REAP_STALE_MIN. Without a status
  // predicate this write races that update and resurrects a reaped run
  // as 'done'. Allow-list is the in-flight CampaignRun statuses
  // (preparing, running) — the enum has no 'cancelled' (operator stop
  // is OperationRun.status='cancelled' via progressService; this
  // collection still lands on 'done').
  await CampaignRun.updateOne(
    buildTerminalDoneFilter(run._id),
    { status: 'done', completedAt: new Date() }
  );
  const totalMs = Date.now() - t0;
  inFlight.untrack(run.runId);
  const final = await CampaignRun.findById(run._id).select('succeeded skipped failed errors').lean();
  if (cancelled) await progressRun.markCancelled(`Stopped — ${final?.succeeded || 0} finished, rest skipped`);
  else await progressRun.succeed({ succeeded: final?.succeeded || 0, skipped: final?.skipped || 0, failed: final?.failed || 0 });
  console.log(
    `🎉 [campaignRun ${run.runId}] done in ${totalMs}ms — ` +
    `${final?.succeeded || 0} succeeded · ${final?.skipped || 0} skipped · ${final?.failed || 0} failed${cancelled ? ' (cancelled by operator)' : ''}`
  );

  // Slack feed close-out — fire-and-forget. Detached interval posts the
  // final parent update + any remaining thread events.
  runFeed.finishRun({
    runId:     run.runId,
    succeeded: final?.succeeded || 0,
    skipped:   final?.skipped || 0,
    failed:    final?.failed || 0,
    totalMs,
    cancelled
  });

  // Report batches that finished with losses. An operator-cancelled run is
  // expected, so it stays quiet; a run that failed every ad is escalated.
  const nFailed = final?.failed || 0;
  if (!cancelled && nFailed > 0) {
    const nOk = final?.succeeded || 0;
    alerts.notifyAsync({
      level: nOk === 0 ? 'error' : 'warn',
      title: nOk === 0
        ? `Campaign run failed entirely — ${nFailed} ad(s)`
        : `Campaign run finished with ${nFailed} failed ad(s)`,
      key:   `run-failed:${nOk === 0 ? 'total' : 'partial'}`,
      fields: {
        run:      run.runId,
        brand:    job.brandId,
        outcome:  `${nOk}✓ / ${nFailed}✗ / ${final?.skipped || 0}⊘ of ${adIds.length}`,
        route:    isVeoRun ? 'video' : 'static',
        took:     `${Math.round(totalMs / 1000)}s`
      },
      // The per-ad errors array is the actual diagnosis; the run counters
      // alone never say WHY. Defensive per-entry: this runs AFTER the run
      // was persisted as 'done', still inside runRenderLoop — a throw here
      // would surface in the caller's catch and falsely re-mark the run
      // 'failed'.
      detail: (Array.isArray(final?.errors) ? final.errors : []).slice(-6)
        .map((e) => `#${e?.index ?? '?'} [${e?.stage ?? '?'}] ${String(e?.message ?? '').slice(0, 200)}`)
        .join('\n') || null
    });
  }
}

/**
 * Look up the sibling master Ad for a derive-only crop / funnel retitle.
 * Prefer masters that share a campaignRunId with this ad (same run scope);
 * fall back to the newest matching master on the campaign+product.
 *
 * MUST exclude other derive-only / funnel-variant ads: funnel variants of
 * a 9:16 master share platformFormat with the master, so an unfiltered
 * query can return a sibling variant that never holds its own plate —
 * the waiter would then hang on a free surface that itself is waiting.
 * A true master has no deriveFromMaster and no funnelStage.
 */
async function findSiblingMasterAd(ad, masterPlatformFormat) {
  const base = {
    campaignId: ad.campaignId,
    productId: ad.productId,
    platformFormat: masterPlatformFormat,
    kind: 'video',
    _id: { $ne: ad._id },
    // True master only — no derive marker, no funnel retitle.
    $and: [
      { $or: [{ deriveFromMaster: null }, { deriveFromMaster: { $exists: false } }] },
      { $or: [{ funnelStage: null }, { funnelStage: { $exists: false } }] }
    ]
  };
  const runIds = Array.isArray(ad.campaignRunIds)
    ? ad.campaignRunIds.map(String).filter(Boolean)
    : [];
  if (runIds.length) {
    const inRun = await Ad.findOne({
      ...base,
      campaignRunIds: { $in: runIds }
    }).sort({ generatedAt: -1 }).lean();
    if (inRun) return inRun;
  }
  return Ad.findOne(base).sort({ generatedAt: -1 }).lean();
}

/**
 * Google PMax derive-only / funnel-variant render.
 *
 * Covers:
 *   - pmax_video_1_1 free crop of the settled 9:16 master
 *   - funnel-stage retitles of any already-paid master plate (and of the
 *     free crops) — consideration / conversion; the unstaged master IS
 *     awareness. Covers PMax and Meta.
 *
 * MONEY: zero Omni / atlasVideoService submits in this function. The base
 * plate is the sibling master's already-paid veoVideoUrl; face-safe crop
 * (only when aspect differs) + Remotion titling run against that URL.
 * Cost ledger: no video cost row for this ad (it spends nothing at Omni);
 * face-detect costs stay whatever basePlateCropService already records.
 *
 * Sequencing: do NOT rely on FIFO claim order. Concurrent VEO_CONCURRENCY
 * means the derive ad can start before the master. If master is still
 * queued/rendering without a veoVideoUrl → polite requeue (status back
 * to queued) with a bounded attempt counter. If master failed/absent →
 * fail honestly. NEVER fall back to a local Omni submit.
 *
 * Funnel preset selection is owned by brandScriptExecutor
 * (resolveFunnelPresetOverride from ad.funnelStage) so buildMetaForAd
 * and resolveSpec receive the SAME override — do not pass a second path.
 */
async function renderDeriveOnlyVideoAd({
  run, job, ad, adId, index, creative, deriveFromFmt
}) {
  // ASSERT (money): this function must not call veoGenerateForAd,
  // veoPrepareStoryboard, atlasVideoService.generateForAd, or any
  // billable video submit helper. Crop + titling only. Funnel variants
  // share this function — a separate path is how a regenerate hole
  // previously opened.
  const funnelNote = ad.funnelStage ? ` funnel=${ad.funnelStage}` : '';
  adStage(adId, `derive-only wait for master (${deriveFromFmt})${funnelNote}`);

  // ── Wait IN-RENDER for the master, don't bounce straight to 'queued' ──
  // The whole run is dispatched in one wave (VEO_CONCURRENCY defaults to
  // 12), so on EVERY first Google run the master is still 'rendering' with
  // no plate when the derive ad starts — an immediate requeue therefore
  // fired every time. And nothing drains a 'queued' ad afterwards: the
  // reaper and the stranded sweeper only look at 'rendering' ads / failed
  // runs, and pressing Generate again short-circuits ("Nothing to render")
  // because the deterministic video digest is run-independent by design.
  // The 1:1 stranded, and both operator work-arounds cost money.
  //
  // So poll here instead. This burns no billable work — it holds a render
  // slot while an already-paid master finishes (~2min typical) — and the
  // requeue below survives as the safety valve for the pathological case.
  let master = await findSiblingMasterAd(ad, deriveFromFmt);
  if (!master?.veoVideoUrl && master
      && (master.status === 'queued' || master.status === 'rendering')) {
    const deadline = Date.now() + DERIVE_MASTER_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DERIVE_MASTER_POLL_MS));
      master = await findSiblingMasterAd(ad, deriveFromFmt);
      if (master?.veoVideoUrl) break;
      // Master reached a terminal state with no plate — stop waiting and
      // let the honest-failure branch below report it.
      if (!master || (master.status !== 'queued' && master.status !== 'rendering')) break;
      adStage(adId, `derive-only: waiting for master ${deriveFromFmt} plate`);
    }
  }
  const attempts = Number(ad.renderAttempts) || 0;

  // Master settled = holds a paid plate URL. status may be draft (post-
  // master, pre/post-titling), live, or even failed-after-titling with
  // the master kept — any of those with veoVideoUrl is usable.
  if (master?.veoVideoUrl) {
    // fall through to derive below
  } else if (
    master &&
    (master.status === 'queued' || master.status === 'rendering')
  ) {
    // Polite requeue — master still in flight. Bound attempts so a
    // stuck master cannot spin forever across /runs claims.
    if (attempts >= MAX_DERIVE_WAIT_ATTEMPTS) {
      const msg =
        `derive-only: master ${deriveFromFmt} still unsettled after ` +
        `${attempts} wait(s); refusing Omni fallback`;
      console.warn(`⚠️  [derive-only ad=${adId}] ${msg}`);
      await Ad.updateOne(
        { _id: adId },
        {
          $set: {
            status: 'failed',
            renderError: { message: msg, stage: 'derive-wait-exhausted', at: new Date() },
            renderStage: 'derive-only: master wait exhausted (no Omni fallback)',
            renderStageAt: new Date(),
            updatedAt: new Date()
          },
          $inc: { renderAttempts: 1 }
        }
      );
      await CampaignRun.updateOne(
        { _id: run._id },
        {
          $inc: { failed: 1 },
          $push: { errors: buildErrorEntry(creative, index, 'derive-wait', new Error(msg)) }
        }
      );
      return;
    }
    const waitN = attempts + 1;
    const stageNote =
      `derive-only: waiting for master ${deriveFromFmt} ` +
      `(attempt ${waitN}/${MAX_DERIVE_WAIT_ATTEMPTS})`;
    console.log(`⏳ [derive-only ad=${adId}] ${stageNote} — requeue`);
    // Release claim → queued so a later selectAdsForRun /runs claim can
    // retry after the master lands. Do NOT leave status:'rendering' (reaper
    // / stranded paths) and do NOT submit Omni.
    await Ad.updateOne(
      { _id: adId },
      {
        $set: {
          status: 'queued',
          renderStage: stageNote.slice(0, 200),
          renderStageAt: new Date(),
          updatedAt: new Date()
        },
        $inc: { renderAttempts: 1 }
      }
    );
    // Count as skipped for this run (will reappear on a subsequent claim).
    await CampaignRun.updateOne(
      { _id: run._id },
      {
        $inc: { skipped: 1 },
        $push: {
          errors: {
            index,
            stage: 'derive-wait',
            message: stageNote
          }
        }
      }
    );
    return;
  } else {
    // Master absent, failed without a plate, or archived — fail honestly.
    // WHY no Omni fallback: that would be a hidden billable submit the
    // operator never asked for on a surface marketed as free derivation.
    const why = !master
      ? `no sibling master ad (${deriveFromFmt}) for product`
      : `master status=${master.status} has no veoVideoUrl`;
    const msg = `derive-only failed: ${why} — not submitting Omni`;
    console.warn(`⚠️  [derive-only ad=${adId}] ${msg}`);
    await Ad.updateOne(
      { _id: adId },
      {
        $set: {
          status: 'failed',
          renderError: { message: msg, stage: 'derive-no-master', at: new Date() },
          renderStage: 'derive-only: master missing/failed (no Omni fallback)',
          renderStageAt: new Date(),
          updatedAt: new Date()
        },
        $inc: { renderAttempts: 1 }
      }
    );
    await CampaignRun.updateOne(
      { _id: run._id },
      {
        $inc: { failed: 1 },
        $push: { errors: buildErrorEntry(creative, index, 'derive-no-master', new Error(msg)) }
      }
    );
    return;
  }

  // ── Derive from settled master plate ──────────────────────────────
  // Copy the master's paid URL as THIS ad's base plate. Titling
  // (brandScriptExecutor → basePlateCropService) face-crops 9:16 → 1:1
  // because classifyFormat(pmax_video_1_1 / aspect 1:1) → 'square'.
  const veoVideoUrl = master.veoVideoUrl;
  const veoAspectRatio = master.veoAspectRatio || '9:16';
  const fallbackPosterUrl = veoVideoUrl?.includes('/video/upload/')
    ? veoVideoUrl
        .replace('/video/upload/', '/video/upload/so_2,f_jpg,q_auto:good/')
        .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2')
    : null;

  // INHERIT THE MASTER'S FACE DETECTION (2026-08-12). Every derive-only ad —
  // the free 1:1 crop and all three funnel retitles — points at the master's
  // exact veoVideoUrl, yet each was starting with basePlate:null and paying
  // basePlateCropService for a fresh vision pass (~$0.02) on footage the
  // master had already analysed. On a PMax run that is 4x the same detection
  // per master, for identical boxes.
  //
  // Sharing is safe BY THE CACHE'S OWN CONTRACT, not by assumption:
  //   - ensureFaceDetectionForKeepOut accepts any entry whose sourceUrl equals
  //     the ad's current veoVideoUrl — and we assign that same URL below — and
  //     its comment states face boxes are "in SOURCE fraction space —
  //     independent of titling format".
  //   - the format-SPECIFIC part cannot leak: cropRect is only honoured when
  //     cached.format === the format being titled, so a 9:16 master's rect is
  //     ignored by a 1:1 derive, which recomputes its own crop as today.
  // Guarded on the master's entry actually being bound to this URL, so a
  // regenerated master with a stale plate is never inherited.
  const inheritedBasePlate =
    master.basePlate && master.basePlate.sourceUrl === veoVideoUrl
      ? master.basePlate
      : null;

  // Load brand for titling (same projection as the master path).
  const sourceMedia = await Media.findById(ad.mediaId)
    .select('fileType fileUrl brandId').lean();
  const brandDoc = sourceMedia?.brandId
    ? await Brand.findById(sourceMedia.brandId)
        .select('name styleScript styleScriptVertical styleScriptLandscape styleTheme tagline logoUrl websiteUrl primaryColor secondaryColor accentColor fontFamily fontSource curatedFields tailwindTheme websiteFontUsage customFonts derivedVoice videoSettings titleStyleSpec titleStylePreset brandReviews').lean()
    : null;

  // Stamp draft + plate BEFORE titling — same money discipline as the
  // master path: untitled is not success; reaper must not requeue a
  // mid-titling ad into a path that could bill (derive path still won't
  // bill, but draft is the shared invariant).
  await Ad.updateOne(
    { _id: adId },
    {
      $set: {
        status:             'draft',
        kind:               'video',
        veoVideoUrl,
        veoAspectRatio,
        // Audit: no model ran for this ad. Marker is explicit so cost
        // reconcilers / inspectors never attribute an Omni charge here.
        veoModel:           `derive-from:${deriveFromFmt}`,
        veoPrompt:          null,
        veoStoryboard:      null,
        veoReferenceImages: [],
        renderUrl:          veoVideoUrl,
        posterUrl:          fallbackPosterUrl || veoVideoUrl,
        sourceFileType:     'video',
        renderedAt:         new Date(),
        updatedAt:          new Date(),
        renderStage:        `derive-only plate from ${deriveFromFmt}`,
        renderStageAt:      new Date(),
        // Same titling debt as the master path. This ad is FREE (no Omni), so
        // the risk it closes is not double-spend but a silent untitled ship:
        // a derived plate stranded mid-titling is indistinguishable from a
        // finished one without this marker.
        titlingResumeState: 'claimed',
        // Only written when the master's entry is bound to this same URL; a
        // spread of {} leaves the field untouched (null) and titling detects
        // exactly as it does today.
        ...(inheritedBasePlate ? { basePlate: inheritedBasePlate } : {})
      },
      $inc: { renderAttempts: 1 }
    }
  );

  const adFinal = await Ad.findById(adId).lean();
  let titlingFailed = null;
  if (brandDoc) {
    try {
      const { renderBrandScriptAndSave } = require('../services/brandScriptExecutor');
      // Depth from the render pool, not this semaphore — see the note on the
      // master path. A diagnostic that reports 0 while twelve ads are ahead is
      // worse than no diagnostic: it sends the reader looking somewhere else.
      const q = titlingQueueDepth();
      if (q.waiting > 0 || q.active >= q.concurrency) {
        adStage(adId, `queued for titling (${q.waiting} ahead)`);
      }
      const chromeOut = await veoTitlingSemaphore.withPermit(async () => {
        adStage(adId, `titling ${adFinal.aspectRatio || ad.aspectRatio || '1:1'} (derive-only)`);
        return renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
      });
      if (chromeOut?.skipped) {
        adStage(adId, `no titling (${chromeOut.reason || 'no-chrome'}) — shipping derived plate`);
      }
    } catch (scriptErr) {
      titlingFailed = scriptErr;
      console.warn(
        `⚠️ brandScript[ad=${adId}] derive-only: titling failed — plate kept, not counted as success: ${scriptErr.message}`
      );
    }
  }

  if (titlingFailed) {
    const tmsg = `derived plate ready; titling failed: ${titlingFailed.message || titlingFailed}`;
    await Ad.updateOne(
      { _id: adId },
      {
        $set: {
          status: 'failed',
          renderError: { message: tmsg, stage: 'titling', at: new Date() },
          renderStage: 'derived plate ready; titling failed',
          renderStageAt: new Date(),
          updatedAt: new Date(),
          titlingResumeState: null
        }
      }
    );
    await CampaignRun.updateOne(
      { _id: run._id },
      {
        $inc:  { failed: 1 },
        $push: { errors: buildErrorEntry(creative, index, 'titling', titlingFailed) }
      }
    );
  } else {
    await Ad.updateOne(
      { _id: adId },
      {
        $set: {
          status:     'draft',
          renderedAt: new Date(),
          updatedAt:  new Date(),
          titlingResumeState: null
        }
      }
    );
    await CampaignRun.updateOne({ _id: run._id }, { $inc: { succeeded: 1 } });
    adStage(adId, 'done');
  }
}

async function renderOne(run, job, adId, index, renderToken) {
  // HEARTBEAT — this is a money guard, not telemetry.
  //
  // worker.js's reaper flips any Ad sitting in 'rendering' with
  // updatedAt older than REAP_STALE_MIN (15m) back to 'queued', on the
  // reasoning that a process died holding it. But nothing was refreshing
  // updatedAt during a render: it was stamped once at claim time, so the
  // clock ran against the ad's TOTAL render duration rather than against
  // its silence. A legitimately slow render — the image plate alone is
  // allowed 600s, and the Director, canvas spec and proof judge all run
  // before it — could cross 15 minutes, get reaped while its Atlas call
  // was still in flight, and be re-submitted by the next Generate.
  // Atlas bills on submit, so that is a second charge for an image we had
  // already paid for and then discarded.
  //
  // Touching updatedAt every 60s makes the reaper's "hasn't moved in 15
  // minutes" mean what it says: still claimed, still alive.
  // The 'draft' + titlingResumeState:'claimed' arm is NOT symmetry for its own
  // sake — without it this fix would cause the bug it is meant to prevent.
  //
  // The instant the paid master lands the ad flips to 'draft', so the
  // rendering-only filter above went dead for the entire titling phase. Titling
  // then queues behind VEO_TITLING_CONCURRENCY (4), and the MEASURED drain on a
  // 20-ad run was 926s — longer than titlingResumeService's CLAIM_STALE_MIN
  // (15 min). So an ad that is merely WAITING ITS TURN would look abandoned,
  // and the sweeper would start a second Remotion render of an ad already being
  // titled. Beating here makes "hasn't moved in 15 minutes" mean the process is
  // gone, which is the only thing the sweeper should act on.
  //
  // Costs nothing when there is no debt: once titling settles, the terminal
  // writes clear titlingResumeState and this filter stops matching.
  const heartbeat = setInterval(() => {
    Ad.updateOne(
      {
        _id: adId,
        $or: [
          { status: 'rendering' },
          { status: 'draft', titlingResumeState: 'claimed' }
        ]
      },
      { $set: { updatedAt: new Date() } }
    ).catch(() => {});   // a missed beat is survivable; the next one lands
  }, 60_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  try {
    return await renderOneInner(run, job, adId, index, renderToken);
  } finally {
    clearInterval(heartbeat);
  }
}

async function renderOneInner(run, job, adId, index, renderToken) {
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
      // ── DERIVE-ONLY (Google PMax 1:1) ────────────────────────────────
      // MONEY-CRITICAL: this branch must NEVER call veoGenerateForAd /
      // atlasVideoService.generateForAd / any Omni submit. A fall-through
      // to the master path below is a hidden ~$0.75–$1.20 per product.
      // ASSERT: zero atlasVideoService submit calls in this block.
      //
      // Detection (either is sufficient — belt and braces):
      //   1. platformFormat === pmax_video_1_1 (always derive-only by design)
      //   2. ad[deriveFromMaster] set at mint time (needs models/Ad.js field;
      //      until then Mongoose strict may drop it — (1) is the fail-closed gate)
      const deriveFromFmt = resolveDeriveFromMaster(ad);
      if (deriveFromFmt) {
        await renderDeriveOnlyVideoAd({
          run, job, ad, adId, index, creative, deriveFromFmt
        });
        return;
      }

      // Load brand + source media up front. The Grok-skip check needs
      // sourceMedia.fileType; the brand-script overlay needs brandDoc.
      const sourceMedia = await Media.findById(ad.mediaId)
        .select('fileType fileUrl brandId').lean();
      // brandReviews is LOAD-BEARING for the proof beat, not optional metadata:
      // buildMetaForAd reads brand.brandReviews for the atomic rating+count pair
      // (services/ratingDisplay.resolveAtomicRatingPair). Omitting it from this
      // projection made brandPair null, so resolveAtomicRatingPair returned
      // source=none and EVERY generated ad rendered with no stars and no review
      // count — including brands that clear the >4.5 gate outright (Vuori 4.58 /
      // 15,545 reviews shipped bare). The bug was invisible because a projection
      // omission looks identical to a brand with no review data, and because
      // routes/brand.js re-titles load the full doc and therefore worked.
      // Keep this list in sync with adRegenerateService.loadBrand; both are
      // pinned by scripts/verifyProofBeat.js P1.
      const brandDoc = sourceMedia?.brandId
        ? await Brand.findById(sourceMedia.brandId)
            .select('name styleScript styleScriptVertical styleScriptLandscape styleTheme tagline logoUrl websiteUrl primaryColor secondaryColor accentColor fontFamily fontSource curatedFields tailwindTheme websiteFontUsage customFonts derivedVoice videoSettings titleStyleSpec titleStylePreset brandReviews').lean()
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
      // UGC-ads Phase 5 — passthrough skip signal. Set when the ugcVideo
      // pipeline determined the ad should be skipped (mirror failed,
      // segment build failed). The dispatcher HANDLES the skip explicitly
      // below rather than falling through to Omni, because a fall-through
      // is exactly the surprise-$3-charge scenario the phase exists to
      // close. Null when passthrough succeeded OR was declined for a
      // non-fatal reason (flag off, not a UGC video, etc.) — the flag-off
      // + not-eligible cases proceed to the existing branch below.
      let ugcPassthroughSkip = null;

      // UGC-ads Phase 5 — before the existing isVideoSeed branch, ask the
      // ugcVideoPipeline whether this ad qualifies for the mirror-and-
      // passthrough short-path. The service handles:
      //   • kill switch check (UGC_VIDEO_PASSTHROUGH, default OFF)
      //   • UGC-video eligibility (fileType='video' + UGC source or
      //     operator/branding/promotional assignment)
      //   • Cloudinary mirror if URL isn't already hosted there
      //   • segment URL construction
      // Only takes effect when passthrough succeeds; otherwise flow
      // continues into the existing isVideoSeed / Grok branches below.
      if (isVideoSeed) {
        const ugcResult = await ugcVideoPipeline.preparePassthroughMaster({
          media:         sourceMedia,
          aspectRatio:   ad.aspectRatio || '9:16',
          durationSec:   8
        });
        if (ugcResult.passthrough) {
          veoVideoUrl    = ugcResult.videoUrl;
          veoAspectRatio = ugcResult.aspectRatio;
          adStage(adId, ugcResult.mirrored
            ? 'ugc-video mirrored + passthrough (no generation)'
            : 'ugc-video passthrough (no generation)');
          console.log(
            `🎬 [ugc-video] ad=${adId} passthrough → skip Omni ` +
            `(mirrored=${ugcResult.mirrored}, aspect=${veoAspectRatio})`
          );
        } else if (ugcResult.skip) {
          // Mirror failed or segment build failed — do NOT silently fall
          // through to Omni (would be a surprise ~$3 charge). Skip the
          // ad, let the operator retry.
          ugcPassthroughSkip = ugcResult;
          console.warn(
            `⚠️  [ugc-video] ad=${adId} passthrough SKIP: ${ugcResult.code} — ${ugcResult.reason}`
          );
        }
        // else: not eligible / flag off — fall through to the existing
        // Cloudinary-segment or Grok branch below.
      }

      // Existing Cloudinary-segment branch — kept as the second attempt
      // when Phase 5 declined (flag off or not a UGC video). Fires for
      // catalog-product videos and for any video-seed path that isn't
      // routed through the ugcVideoPipeline. Non-Cloudinary URL still
      // warns + falls through to Grok — that is the pre-Phase-5 behaviour
      // for non-UGC video seeds and is not something Phase 5 rewrites.
      if (!veoVideoUrl && !ugcPassthroughSkip && isVideoSeed) {
        const segmentUrl = buildVideoSegmentUrl(sourceMedia.fileUrl, ad.aspectRatio || '9:16', 8);
        if (!segmentUrl) {
          console.warn(
            `⚠️  [veo] ad=${adId} seed is video but not Cloudinary-hosted (${sourceMedia.fileUrl?.slice(0, 80)}…) — ` +
            `Grok-skip requires Cloudinary /video/upload/. Falling through to Grok with picked-frame reference.`
          );
        } else {
          veoVideoUrl    = segmentUrl;
          veoAspectRatio = ad.aspectRatio || '9:16';
          adStage(adId, 'reusing video seed segment (no generation)');
          console.log(
            `🎬 [veo] ad=${adId} seed=video → skip Grok, 8s Cloudinary segment ` +
            `(aspect=${veoAspectRatio}) → ${segmentUrl.slice(0, 120)}…`
          );
        }
      }

      // UGC passthrough skip — terminal short-circuit. Mirrors the
      // veoResult.skipped handling below (Omni provider disabled) so
      // status/renderError/renderStage are all consistent and the poller
      // sees the same shape.
      if (ugcPassthroughSkip) {
        const skipMsg = ugcPassthroughSkip.reason || 'ugc video passthrough skipped';
        await CampaignRun.updateOne({ _id: run._id }, { $inc: { skipped: 1 } });
        await Ad.updateOne(
          { _id: adId },
          {
            $set: {
              status: 'failed',
              renderError: { message: skipMsg, stage: 'ugc-passthrough-skipped', at: new Date() },
              renderStage: `skipped: ${skipMsg}`.slice(0, 200),
              renderStageAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
        return;
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
        adStage(adId, 'preparing video context');
        const { storyboard } = await veoPrepareStoryboard({ ad });
        veoStoryboard = storyboard || null;

        // Stamp the storyboard early so chrome can read it from ad.veoStoryboard
        // if the in-memory pass somehow drops, and downstream debug tools see it.
        if (storyboard) {
          await Ad.updateOne({ _id: adId }, { $set: { veoStoryboard: storyboard, updatedAt: new Date() } });
        }

        // Stage 2 — generate the base video via Grok. Chrome (if any)
        // runs after Grok completes in Stage 3.
        // The billable one. Named so the status screen says exactly what is
        // being paid for, and so a stall here is distinguishable from a stall in
        // titling or upload.
        // Submit/poll stages are owned by atlasVideoService (piggybacked on
        // the existing poll tick). This outer label is the pre-enter marker
        // so a stall before the service even runs is still visible.
        adStage(adId, `master video generation (${ad.aspectRatio || '9:16'})`);
        const veoResult = await veoGenerateForAd({ ad, storyboard });
        if (veoResult.skipped) {
          // Previously re-queued forever with no reason on the Ad — the board
          // showed "rendering" until the reaper, and the next Generate billed
          // again for a provider that is still off. Terminal + reason so the
          // operator can fix the key/config and regen deliberately.
          const skipMsg = veoResult.reason || 'video generation skipped (provider disabled or unconfigured)';
          await CampaignRun.updateOne({ _id: run._id }, { $inc: { skipped: 1 } });
          await Ad.updateOne(
            { _id: adId },
            {
              $set: {
                status: 'failed',
                renderError: { message: skipMsg, stage: 'veo-skipped', at: new Date() },
                renderStage: `skipped: ${skipMsg}`.slice(0, 200),
                renderStageAt: new Date(),
                updatedAt: new Date()
              },
              $inc: { renderAttempts: 1 }
            }
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

      // Stamp the master video URL BEFORE titling so a titling failure still
      // leaves a viewable, paid-for asset. status:'draft' here is a MONEY
      // guard (the reaper only requeues status:'rendering' — leaving the ad
      // in rendering after a paid Omni submit is a double-bill hole if the
      // process dies mid-titling). It is NOT a success claim: the run's
      // succeeded counter and the clean "done" stage only move after
      // titling finishes (or no-chrome ships the master deliberately).
      // CLAUDE.md §00 step 4: title each surface is required of the pipeline.
      const fallbackPosterUrl = veoVideoUrl?.includes('/video/upload/')
        ? veoVideoUrl
            .replace('/video/upload/', '/video/upload/so_2,f_jpg,q_auto:good/')
            .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2')
        : null;
      await Ad.updateOne(
        { _id: adId },
        {
          $set: {
            // draft = asset exists and is not requeueable. Titling still pending
            // is visible via renderStage; failure flips status to 'failed'.
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
            renderedAt:         new Date(),
            updatedAt:          new Date(),
            // TITLING DEBT — the ad now owes a title, and this is what makes
            // that debt VISIBLE to a sweeper. Without it a process death here
            // leaves {status:'draft', renderUrl === veoVideoUrl} and NOTHING
            // reclaims it: six sweepers key on 'rendering'/'queued', and
            // titlingResumeService's three arms need this field set or
            // renderUrl null — and the write above sets renderUrl.
            //
            // 'claimed' rather than 'pending' on purpose. 'pending' has no
            // staleness bound in the sweeper, so a concurrent tick would grab
            // an ad THIS process is actively titling. 'claimed' routes to the
            // arm that also requires updatedAt older than CLAIM_STALE_MIN, so
            // a live render is protected and only a dead one is reclaimed.
            titlingResumeState: 'claimed'
          },
          $inc: { renderAttempts: 1 }
        }
      );

      // Stage 3 — brand-script canvas overlay (titling). Resolver picks the
      // right script based on the ad's format. When no chrome is configured,
      // the raw master is the final deliverable and counts as success.
      // Titling failure is NO LONGER counted as success: the master is kept
      // (paid for), but the outcome is "master rendered, titling failed".
      const adFinal = await Ad.findById(adId).lean();
      let titlingFailed = null;
      if (brandDoc) {
        try {
          const { renderBrandScriptAndSave } = require('../services/brandScriptExecutor');
          // ── THE SECOND PERMIT ────────────────────────────────────────────
          // Everything above this point was remote and idle: an Omni submit and
          // a ~2 minute poll. Everything below is Remotion renderMedia —
          // headless Chrome + an ffmpeg 1080p encode, IN THIS PROCESS.
          //
          // The veo lane used to gate both halves on one number, so
          // VEO_CONCURRENCY had to be small enough for the expensive half, which
          // throttled the cheap half for nothing. The lane now dispatches wide
          // (VEO_CONCURRENCY, default 12) and only this section is narrow
          // (VEO_TITLING_CONCURRENCY, default 4 — deliberately identical to the
          // old combined value, so the split cannot increase local memory
          // pressure on its first outing).
          //
          // withPermit releases in a `finally`, so the throw handled below
          // cannot leak a permit and wedge every later titling job. The wait is
          // OUTSIDE the try's billable concern: the master is already paid for
          // and already persisted (status:'draft' + veoVideoUrl, stamped above),
          // so queueing here risks nothing but latency — and an ad waiting for a
          // titling permit is reaper-safe for exactly that reason.
          //
          // DEPTH COMES FROM THE RENDER POOL, NOT THIS SEMAPHORE. It used to read
          // veoTitlingSemaphore.waiting, which was right while the permit (4) was
          // the narrowest thing in the path. It no longer is: the permit is now
          // wide (48) and bounds only cheap prep, while the real wait is
          // remotionRenderService's bounded pool. Left as it was, this line would
          // report "0 ahead" for an ad genuinely twelfth in line — silently
          // deleting the one number that makes a slow run legible.
          const q = titlingQueueDepth();
          if (q.waiting > 0 || q.active >= q.concurrency) {
            adStage(adId, `queued for titling (${q.waiting} ahead)`);
          }
          const chromeOut = await veoTitlingSemaphore.withPermit(async () => {
            // Titling names its target aspect: this is the stage that face-crops
            // the 9:16 master down (basePlateCropService) and composites the
            // overlay, so "titling 1:1" and "master video generation" being
            // distinct is what makes a stall attributable.
            adStage(adId, `titling ${adFinal.aspectRatio || ad.aspectRatio || '9:16'}`);
            return renderBrandScriptAndSave({ ad: adFinal, brand: brandDoc });
          });
          // no-chrome is intentional success (raw master is the deliverable).
          if (chromeOut?.skipped) {
            adStage(adId, `no titling (${chromeOut.reason || 'no-chrome'}) — shipping master`);
          }
        } catch (scriptErr) {
          titlingFailed = scriptErr;
          console.warn(
            `⚠️ brandScript[ad=${adId}]: titling failed — master kept, not counted as success: ${scriptErr.message}`
          );
        }
      }

      if (titlingFailed) {
        const tmsg = `master rendered; titling failed: ${titlingFailed.message || titlingFailed}`;
        await Ad.updateOne(
          { _id: adId },
          {
            $set: {
              // Keep renderUrl = raw master. Do not delete the paid asset.
              status: 'failed',
              renderError: { message: tmsg, stage: 'titling', at: new Date() },
              renderStage: 'master rendered; titling failed',
              renderStageAt: new Date(),
              updatedAt: new Date(),
              // Debt settled: titling ran and lost. This is a TERMINAL verdict,
              // so clearing is what stops the sweeper retrying a render that
              // already failed on its merits rather than from a process death.
              titlingResumeState: null
            }
          }
        );
        await CampaignRun.updateOne(
          { _id: run._id },
          {
            $inc:  { failed: 1 },
            $push: { errors: buildErrorEntry(creative, index, 'titling', titlingFailed) }
          }
        );
      } else {
        // Title landed (or no chrome / no brand). Promote to draft now.
        // Soft notes written mid-pipeline (face-crop skip etc.) stay on
        // renderError so the board still shows "what degraded" after ship.
        await Ad.updateOne(
          { _id: adId },
          {
            $set: {
              status:     'draft',
              renderedAt: new Date(),
              updatedAt:  new Date(),
              // Debt settled: titled, or deliberately shipped bare (no-chrome /
              // no-brand). Clearing here is what keeps the no-chrome ad — whose
              // renderUrl legitimately stays equal to veoVideoUrl forever — from
              // being re-titled on every sweep for the rest of its life.
              titlingResumeState: null
            }
          }
        );
        await CampaignRun.updateOne({ _id: run._id }, { $inc: { succeeded: 1 } });
        adStage(adId, 'done');
      }
    } catch (err) {
      console.error(`❌ veoReference[ad=${adId}]:`, err.message || err);
      // Video is the expensive, slow, vendor-dependent stage — the one
      // worth a push. Deduped on the message shape, not the ad id, so a
      // vendor outage that fails 20 ads sends one alert with a count
      // rather than 20 separate ones. String() the message defensively:
      // a vendor error like {message: 429} has a truthy non-string
      // .message, and a synchronous throw HERE would skip the CampaignRun/
      // Ad failure bookkeeping below, wedging the ad in 'rendering'.
      const vmsg = String((err && err.message) || err);
      alerts.notifyAsync({
        level:  'error',
        title:  'Video generation failed',
        key:    `video-failed:${vmsg.slice(0, 60)}`,
        fields: { ad: String(adId), run: run.runId, brand: job.brandId, error: vmsg.slice(0, 300) }
      });
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
    adStage(adId, `static image generation (${ad.platformFormat || 'meta_feed_1_1'})`);
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
      // QUOTE_STAGE_AWARE: Ad.funnelStage reaches assembleInput via
      // deriveStage → quoteOpts. Flag-off the scorer ignores it.
      funnelStage:         ad.funnelStage || null,
      creative,
      cta:           { text: ad.ctaText, url: ad.ctaUrl, params: ad.ctaUrlParams },
      authToken:     renderToken,
      options:       {}
    });

    if (result.status === 'success') {
      await CampaignRun.updateOne({ _id: run._id }, { $inc: { succeeded: 1 } });
      adStage(adId, 'done');
    } else if (result.status === 'skipped') {
      // Template validation (and similar) used to leave the Ad in
      // status:'rendering' with no renderError — the run's skipped counter
      // moved but the board / reaper saw a still-in-flight asset. Terminal
      // state + reason so a human can decide what to change before a regen.
      const skipMsg = result.skipReason || 'skipped';
      await CampaignRun.updateOne({ _id: run._id }, { $inc: { skipped: 1 } });
      await Ad.updateOne(
        { _id: adId },
        {
          $set: {
            status: 'failed',
            renderError: { message: skipMsg, stage: 'validate', at: new Date() },
            renderStage: `skipped: ${skipMsg}`.slice(0, 200),
            renderStageAt: new Date(),
            updatedAt: new Date()
          },
          $inc: { renderAttempts: 1 }
        }
      );
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
            // predictionId makes an abandoned-but-paid-for render recoverable:
            // Atlas retains the asset for days, so a reclaim pass can fetch it
            // instead of re-submitting and paying twice.
            renderError: {
              message:      errMsg,
              stage:        result.stage || result.error?.stage || 'unknown',
              predictionId: result.error?.predictionId || null,
              atlasCode:    result.error?.atlasCode ?? null,
              charged:      result.error?.charged === true,
              at:           new Date()
            },
            // Keep vision QC verdict (incl. discarded paid URLs) on failure.
            ...(result.error?.visionQc ? { visionQc: result.error.visionQc } : {}),
            // Surface the last attempt's pixels when QC kept a URL.
            ...(() => {
              const attempts = result.error?.visionQc?.attempts || [];
              const lastUrl = [...attempts].reverse().find(a => a?.renderUrl)?.renderUrl;
              return lastUrl ? { renderUrl: lastUrl } : {};
            })(),
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
          // Carry the billing tags. An unexpected throw AFTER a charged Atlas
          // submit is exactly the case where the recovery handle matters most,
          // and this path recorded only the message — so the one crash that
          // cost money looked identical to one that cost nothing.
          // `err.cause` is read too: wrappers put the tags there.
          renderError: {
            message:      err.message || String(err),
            stage:        'crash',
            at:           new Date(),
            predictionId: err.predictionId || err.cause?.predictionId || null,
            charged:      err.charged === true || err.cause?.charged === true,
            atlasCode:    err.atlasCode ?? err.cause?.atlasCode ?? null
          },
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
      mintedTotal:     run.mintedTotal || 0,
      unclaimedAtStart: run.unclaimedAtStart || 0,
      // Same field / same { code, message } shape as the 202. After claim
      // this is the unclaimed-overflow notice when leftovers exist; otherwise
      // the mint-time overlap notice (or null).
      notice:          run.notice || null,
      succeeded:       run.succeeded,
      skipped:         run.skipped,
      failed:          run.failed,
      status:          run.status,
      queuedRemaining,
      errors:          run.errors || [],
      // Per-product expansion outcomes (why each product queued or skipped).
      // Empty until expandWizardJob finishes; the poller is the source of
      // truth because the 202 response flushes before expansion completes.
      perProduct:      run.perProduct || [],
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

// GET /api/ads?brandId=X[&campaignId=Y][&campaignRunId=Z][&status=draft|live|archived][&template=...][&aspectRatio=...][&limit=50]
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

    // brandId/campaignId are ObjectId-typed on Ad (models/Ad.js:29-30). Cast
    // explicitly here rather than relying on Mongoose's implicit .find() cast,
    // because this filter is also used in an aggregation $match below — the
    // driver's $match does NOT auto-cast against the schema the way .find()
    // does. brandId is already proven a valid id by assertBrandInTenant above.
    const filter = { brandId: new mongoose.Types.ObjectId(String(brandId)) };
    if (req.query.campaignId)    filter.campaignId     = new mongoose.Types.ObjectId(String(req.query.campaignId));
    // campaignRunIds is a plain [String] (models/Ad.js:39) — a bare equality
    // match against an array field is a contains-match, same convention
    // already used at /render-activity (routes/ads.js, `filter.campaignRunIds
    // = String(req.query.runId)`). This is the hard DB-level scope that a
    // freshly-generated run needs: unlike sorting, it can never be pushed off
    // a capped/sorted page by a dedupe-reused ad's stale generatedAt.
    if (req.query.campaignRunId) filter.campaignRunIds = String(req.query.campaignRunId);
    if (req.query.status)        filter.status         = req.query.status;
    // UGC-ads Phase 4 — ?mediaId=X returns the ads generated FROM this
    // source Media (used by the UGC Ads page to render per-row "ads
    // generated" groups + by the Product Ads UGC-badge deep-link).
    // Ad.mediaId is ObjectId-typed; cast explicitly for the same reason
    // brandId/campaignId are cast above ($match won't auto-cast).
    if (req.query.mediaId) {
      if (!mongoose.isValidObjectId(String(req.query.mediaId))) {
        return res.status(400).json({ error: 'mediaId is not a valid ObjectId' });
      }
      filter.mediaId = new mongoose.Types.ObjectId(String(req.query.mediaId));
    }
    // UGC-ads Phase 4 — ?variantKind=ugc|product_image splits the Product
    // Ads page into UGC vs product-shot buckets. Column typed as a string
    // on Ad; direct equality is fine.
    if (req.query.variantKind) filter.variantKind = String(req.query.variantKind);
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
    //
    // Aggregation, not .find(), because ranking must use "true" recency
    // (renderedAt, falling back to generatedAt — see adRecencyService) —
    // generatedAt alone is a creation-time-only stamp that a dedupe-reused,
    // freshly re-rendered ad never updates, so a plain .sort({generatedAt:-1})
    // can bury today's renders under old rows.
    const [rows, total] = await Promise.all([
      Ad.aggregate([
        { $match: filter },
        { $addFields: { _recencyAt: AD_RECENCY_EXPR } },
        { $sort: { _recencyAt: -1 } },
        { $skip: offset },
        { $limit: limit }
      ], { allowDiskUse: true }),
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

// GET /api/ads/render-activity — technical status board.
//
// Exists because the only way to answer "what is this asset doing / why did it
// stall" used to be an SSH session and a log grep, which meant asking whoever
// had shell access. Everything here is READ from the Ad document; nothing is
// reconstructed or inferred, so a field being absent means it was never
// recorded rather than that this endpoint could not work it out.
//
// `diagnostic` is a pre-formatted one-paste block. It is built server-side on
// purpose: a copy button that assembles its own text drifts from what is
// actually useful to hand to someone debugging, and then the paste is missing
// the one id that mattered.
//
// NOTE: must stay registered above the '/:id' routes.
router.get('/render-activity', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    // TENANT SCOPING — brandId is REQUIRED and verified, matching GET /api/ads.
    //
    // This board originally queried Ad with no tenant filter at all, which would
    // have let any authenticated user read EVERY advertiser's assets: prompts,
    // prediction ids, Cloudinary URLs, product and campaign ids. A cross-tenant
    // data leak, on a diagnostic endpoint, is not an acceptable trade for
    // convenience.
    //
    // Ad carries brandId and not advertiserId, so the generic tenantFilter()
    // does not apply; a brand belongs to exactly one advertiser, so an
    // assertBrandInTenant'd brandId IS the scope. Same reasoning and same
    // helper as the ads list route.
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }

    const filter = { brandId };
    if (req.query.runId)    filter.campaignRunIds = String(req.query.runId);
    if (req.query.status)   filter.status = String(req.query.status);

    const ads = await Ad.find(filter)
      .select('status renderStage renderStageAt kind template platformFormat aspectRatio ' +
              'renderUrl renderError renderAttempts renderStages imageGeneration ' +
              'intentResolution visionQc veoPredictionId veoAspectRatio veoVideoUrl ' +
              'campaignId campaignRunIds productId mediaId brandId conceptId ' +
              'queuedAt renderedAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    // Who asked. Resolved per run, not per ad, so a 20-ad run is one lookup.
    const runIds = [...new Set(ads.flatMap(a => a.campaignRunIds || []).map(String))];
    const runs = runIds.length
      ? await CampaignRun.find({ runId: { $in: runIds } })
          .select('runId requestedBy status startedAt completedAt total succeeded failed skipped')
          .lean()
      : [];
    const runById = new Map(runs.map(r => [String(r.runId), r]));

    // Resolve requester emails WITHOUT populate. `.populate('requestedBy')`
    // throws "Schema hasn't been registered for model User" here — routes/ads.js
    // never requires the User model, and mongoose resolves refs lazily against
    // whatever is registered in the process. That would have 500'd the entire
    // board over a cosmetic field. Verified against prod before shipping.
    //
    // The require is guarded and the lookup is best-effort for the same reason:
    // a status board must degrade to showing ids, never fail.
    const userById = new Map();
    const requesterIds = [...new Set(runs.map(r => r.requestedBy).filter(Boolean).map(String))];
    if (requesterIds.length) {
      try {
        const User = require('../models/User');
        const users = await User.find({ _id: { $in: requesterIds } }).select('email name').lean();
        users.forEach(u => userById.set(String(u._id), u));
      } catch (err) {
        console.warn(`   ⚠️  render-activity: requester lookup skipped (${err.message}) — showing ids`);
      }
    }

    const now = Date.now();
    const rows = ads.map(a => {
      const run = (a.campaignRunIds || []).map(String).map(id => runById.get(id)).find(Boolean) || null;
      const predictionId = a.imageGeneration?.predictionId || a.veoPredictionId || null;
      const stageAgeSec = a.renderStageAt ? Math.round((now - new Date(a.renderStageAt).getTime()) / 1000) : null;
      const t = a.renderStages || {};
      const row = {
        assetId:       String(a._id),
        status:        a.status,
        stage:         a.renderStage || null,
        stageAgeSec,
        // A render sitting in one stage far longer than that stage's normal cost
        // is the signal worth surfacing; 600s is the Atlas image deadline and the
        // video poll ceiling, so past that something is genuinely wrong.
        stalled:       a.status === 'rendering' && stageAgeSec != null && stageAgeSec > 600,
        kind:          a.kind,
        template:      a.template,
        platformFormat: a.platformFormat,
        aspectRatio:   a.aspectRatio,
        pipeline:      a.imageGeneration?.pipeline || (a.kind === 'video' ? 'veo' : null),
        model:         a.imageGeneration?.model || null,
        predictionId,
        // Provenance for the multi-size video story: a 1:1 or 4:5 video whose
        // veoAspectRatio is 9:16 was CROPPED from a master, not generated.
        derivedFromMaster: a.kind === 'video' && a.veoAspectRatio === '9:16' && a.aspectRatio !== '9:16',
        timingsMs:     { derive: t.deriveMs ?? null, render: t.renderMs ?? null, upload: t.uploadMs ?? null },
        intent:        a.intentResolution
          ? { requested: a.intentResolution.requested, delivered: a.intentResolution.delivered,
              fellBackFrom: a.intentResolution.fellBackFrom || null,
              dropped: a.intentResolution.droppedRoles || [] }
          : null,
        visionQc:      a.visionQc
          ? { passed: a.visionQc.passed, finalAttempt: a.visionQc.finalAttempt,
              skipped: !!a.visionQc.skipped, disabled: !!a.visionQc.disabled,
              // reason explains uninspected ships (skipped:true) — without it
              // the list reads like a benign skip with no cause.
              reason: a.visionQc.reason || null,
              attempts: (a.visionQc.attempts || []).map(t => ({
                attempt: t.attempt, pass: t.pass, summary: t.summary,
                discarded: !!t.discarded, renderUrl: t.renderUrl || null,
                discardedRenderUrl: t.discardedRenderUrl || null
              })) }
          : null,
        assetUrl:      a.renderUrl || null,
        error:         a.renderError?.message || (typeof a.renderError === 'string' ? a.renderError : null),
        attempts:      a.renderAttempts ?? null,
        ids:           {
          campaignId: a.campaignId ? String(a.campaignId) : null,
          runId:      run?.runId || (a.campaignRunIds || [])[0] || null,
          productId:  a.productId ? String(a.productId) : null,
          mediaId:    a.mediaId ? String(a.mediaId) : null,
          brandId:    a.brandId ? String(a.brandId) : null,
          conceptId:  a.conceptId || null
        },
        requestedBy:   (() => {
          const uid = run?.requestedBy ? String(run.requestedBy) : null;
          if (!uid) return null;
          const u = userById.get(uid);
          return u?.email || u?.name || uid;   // id is still useful; never blank
        })(),
        run:           run ? { status: run.status, total: run.total, succeeded: run.succeeded, failed: run.failed, skipped: run.skipped } : null,
        queuedAt:      a.queuedAt || null,
        renderedAt:    a.renderedAt || null,
        updatedAt:     a.updatedAt || null
      };
      row.diagnostic = [
        `asset=${row.assetId}`,
        `status=${row.status}${row.stalled ? ' STALLED' : ''}`,
        `stage=${row.stage || '-'}${row.stageAgeSec != null ? ` (${row.stageAgeSec}s)` : ''}`,
        `kind=${row.kind} fmt=${row.platformFormat} aspect=${row.aspectRatio}`,
        `pipeline=${row.pipeline || '-'} model=${row.model || '-'}`,
        `prediction=${row.predictionId || '-'}`,
        row.derivedFromMaster ? 'derivedFromMaster=true (cropped, not generated)' : null,
        `timings(ms) derive=${row.timingsMs.derive ?? '-'} render=${row.timingsMs.render ?? '-'} upload=${row.timingsMs.upload ?? '-'}`,
        row.intent ? `intent=${row.intent.delivered}${row.intent.fellBackFrom ? ` (fellBackFrom ${row.intent.fellBackFrom})` : ''}${row.intent.dropped.length ? ` dropped=${row.intent.dropped.join('+')}` : ''}` : null,
        `run=${row.ids.runId || '-'} by=${row.requestedBy || '-'}`,
        `product=${row.ids.productId || '-'} media=${row.ids.mediaId || '-'} concept=${row.ids.conceptId || '-'}`,
        row.error ? `error=${row.error}` : null,
        row.assetUrl ? `asset=${row.assetUrl}` : null
      ].filter(Boolean).join('\n');
      return row;
    });

    res.json({ rows, count: rows.length, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`❌ GET /api/ads/render-activity failed: ${err.message}`);
    res.status(500).json({ error: err.message || 'render-activity failed' });
  }
});

// POST /api/ads/video-ref-prewarm — wizard-triggered 9:16 reference reframe
// prewarm. Reuses buildReferenceImages (same path as the paid video run)
// so cold outpaints warm into the persistent reframe cache before
// /generate. Responds 202 immediately; work is fire-and-forget.
// Body: { brandId, productIds: [] } — brandId may also come from
// x-brand-id (same as GET /render-activity).
// Kill-switch: VIDEO_REF_PREWARM_ENABLED (default true).
//
// NOTE: must stay registered above the '/:id' routes.
router.post('/video-ref-prewarm', async (req, res) => {
  try {
    // Default ON — only the literal string 'false' disables (same shape
    // as REFRAME_ENABLED).
    if (String(process.env.VIDEO_REF_PREWARM_ENABLED ?? 'true').toLowerCase() === 'false') {
      return res.status(200).json({ accepted: false, reason: 'disabled' });
    }

    const brandId = (req.body && req.body.brandId) || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    try {
      await assertBrandInTenant(brandId, req);
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }

    const raw = (req.body && req.body.productIds) || [];
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'productIds must be an array of ObjectId strings' });
    }

    const {
      prewarmVideoRefsForProducts,
      PREWARM_MAX_PRODUCTS
    } = require('../services/videoRefPrewarmService');

    const seen = new Set();
    const productIds = [];
    for (const id of raw) {
      const s = String(id || '');
      if (!mongoose.isValidObjectId(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      productIds.push(s);
    }
    if (productIds.length > PREWARM_MAX_PRODUCTS) {
      const dropped = productIds.length - PREWARM_MAX_PRODUCTS;
      productIds.length = PREWARM_MAX_PRODUCTS;
      console.warn(
        `⚠️  video-ref-prewarm: productIds capped at ${PREWARM_MAX_PRODUCTS} (dropped ${dropped})`
      );
    }

    // 202 first — warm is opportunistic; never block the wizard on
    // outpaint latency. Background work must never surface as unhandled
    // rejection.
    res.status(202).json({ accepted: true, products: productIds.length });

    prewarmVideoRefsForProducts({ brandId: String(brandId), productIds })
      .catch(err => console.warn(
        `⚠️  video-ref-prewarm: background warm failed: ${err && err.message ? err.message : err}`
      ));
  } catch (err) {
    console.error(`❌ POST /api/ads/video-ref-prewarm failed: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'video-ref-prewarm failed' });
    }
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

// GET /api/ads/formats — platform / preset / format catalog for the wizard UI.
// Display-only and brand-agnostic: every platform, its presets, and the
// formats each preset would produce — including coming_soon stubs so the
// SPA can grey cards without hardcoding keys. resolvePreset still never
// emits coming_soon into a queue. No brandId: this exposes no tenant data.
// NOTE: must stay registered above the '/:id' routes.
router.get('/formats', async (req, res) => {
  const { formatCatalog } = require('../services/platformFormats');
  res.json(formatCatalog());
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

// Guard every /:id and /:adId param so a non-ObjectId path segment never
// reaches Mongoose's Cast. Without this, unmatched paths (e.g. GET
// /api/ads/formats before it was registered, or /api/ads/zzz-not-a-route)
// fall through to the /:id handler and return 500 with a raw CastError —
// a client miss reported as a server error, leaking model/path internals,
// and destroying the 404-vs-other deploy-verification signal.
// Prefer one param guard over per-handler checks: every /:id* route in
// this file shares the cast surface.
function requireValidAdObjectId(req, res, next, value) {
  if (!mongoose.isValidObjectId(value)) {
    return res.status(404).json({ error: 'ad not found' });
  }
  next();
}
router.param('id', requireValidAdObjectId);
router.param('adId', requireValidAdObjectId);

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
// ad with an operator refinement prompt, OR a verbatim prompt override.
// Body: { prompt?, mode?, promptOverride?, videoPromptRaw?,
//          videoPromptGuidance?, imagePromptRaw? }.
//   prompt:  a refinement note PREPENDED to the auto-composed prompt
//            (video: OPERATOR REFINEMENT header inside buildVeoPrompt;
//            image: refinement note into the live direct_image path).
//            Required UNLESS one of the override fields below is given.
//            Up to 1000 chars.
//   mode:    'light' (default, video only — re-runs chrome + composite,
//                     Veo unchanged) | 'full' (re-runs Veo too).
//            Image ads always re-run the live direct_image renderer
//            (gpt-image-2/edit); mode ignored. Note: adRegenerateService
//            currently normalises video to full regardless of mode.
//   promptOverride: { system, user } — image ads only. The operator
//            edited the EXACT prompt shown in the Generation Details
//            modal; this text replaces the auto-composed prompt
//            verbatim instead of being appended as a refinement note.
//            Image models have one flat prompt channel — system+user
//            are concatenated (see resolveImagePromptOverride).
//   videoPromptRaw: string ≤4000 — video only. FULL replacement of the
//            canonical camera prompt for THIS regenerate call. Reuses
//            the existing generateForAd raw branch (logs "canonical
//            directives bypassed"). PASS-THROUGH — not written to Ad.
//            Same length ceiling as the wizard (parsePhase3WizardFields).
//   videoPromptGuidance: string ≤1000 — video only. PREPENDS as the
//            operator refinement when `prompt` is empty and raw is not
//            set. Same ceiling as the wizard. PASS-THROUGH — not written.
//   imagePromptRaw: string ≤40000 — IMAGE ads only. FULL replacement of
//            the auto-composed static prompt for THIS regenerate call, via
//            the existing rawPromptOverride channel (which already accepts a
//            bare string). The operator loads the exact prompt that produced
//            the current render — Ad.imageGeneration.prompt, served by
//            /generation-inspector — edits it, and sends it back.
//            Cap is 40000, NOT the video 4000: the static prompt runs
//            ~7.8-8.4k chars, so 4000 would truncate it (see
//            adRegenerateService.IMAGE_PROMPT_RAW_MAX).
//            MUTUALLY EXCLUSIVE with promptOverride — both target the same
//            slot, so sending both 400s rather than picking a silent winner.
//            Replaces, so it DROPS product-fidelity, the exact-copy contract
//            and the safe-box geometry prose unless the operator keeps them;
//            gen size, delivery crop, reference stack and logo compositing
//            still come from the surface. When set, `prompt` is ignored (the
//            override wins inside renderDirectImage).
//            PASS-THROUGH — not written to the Ad, so the next regenerate
//            with an empty field reverts to the auto-composed prompt.
// Returns 202 with a poll target. Frontend polls
// /api/catalog/:productId/ads-detail (or this ad's generation-inspector)
// watching ad.regenerating.
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

    const regen = require('../services/adRegenerateService');

    const MAX_OVERRIDE_LEN = 40000;
    let promptOverride = null;
    if (req.body?.promptOverride && typeof req.body.promptOverride === 'object') {
      const sys = String(req.body.promptOverride.system || '').trim();
      const usr = String(req.body.promptOverride.user   || '').trim();
      if (!sys || !usr) return res.status(400).json({ error: 'promptOverride requires both system and user text' });
      if (sys.length > MAX_OVERRIDE_LEN || usr.length > MAX_OVERRIDE_LEN) {
        return res.status(400).json({ error: `promptOverride text is too long (max ${MAX_OVERRIDE_LEN} chars each)` });
      }
      promptOverride = { system: sys, user: usr };
    }

    // Video camera-prompt overrides — same caps as the wizard body parser.
    // Empty/whitespace collapses to null inside parseRegenVideoPromptFields.
    const videoFields = regen.parseRegenVideoPromptFields(req.body || {});
    if (!videoFields.ok) {
      return res.status(400).json({ error: videoFields.error });
    }
    const { videoPromptRaw, videoPromptGuidance } = videoFields;

    // Static raw prompt — full replacement of the auto-composed image prompt.
    // Cap is 40000 (IMAGE_PROMPT_RAW_MAX), not the video 4000: the prompt this
    // replaces is ~8k chars. Whitespace-only collapses to null inside.
    const imageFields = regen.parseRegenImagePromptField(req.body || {});
    if (!imageFields.ok) {
      return res.status(400).json({ error: imageFields.error });
    }
    const { imagePromptRaw } = imageFields;

    // Both imagePromptRaw and promptOverride land in the SAME full-replace slot
    // (runImage's promptOverride argument → resolveImagePromptOverride). Sending
    // both is a client bug: silently picking a winner would hide which text the
    // billable submit actually used.
    if (imagePromptRaw && promptOverride) {
      return res.status(400).json({
        error: 'send either imagePromptRaw or promptOverride, not both — they both replace the whole image prompt'
      });
    }

    const prompt = String(req.body?.prompt || '').trim();
    // Gate: at least ONE of prompt / promptOverride / videoPromptRaw /
    // videoPromptGuidance. Empty regenerate still 400s. Uses the pure
    // helper so the offline harness pins the same predicate.
    if (!regen.regenerateHasIntent({
      prompt, promptOverride, videoPromptRaw, videoPromptGuidance, imagePromptRaw
    })) {
      return res.status(400).json({
        error: 'prompt, promptOverride, videoPromptRaw, videoPromptGuidance, or imagePromptRaw is required'
      });
    }
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

    let ad;
    try {
      ad = await regen.preflight(req.params.id, brandId);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (promptOverride && ad.kind !== 'image') {
      return res.status(400).json({ error: 'promptOverride is only supported for image ads' });
    }
    // Video-only fields on an image ad are a client bug, not a silent no-op.
    if ((videoPromptRaw || videoPromptGuidance) && ad.kind !== 'video') {
      return res.status(400).json({
        error: 'videoPromptRaw / videoPromptGuidance are only supported for video ads'
      });
    }
    // ...and the mirror: a raw IMAGE prompt on a video ad would be silently
    // dropped by runVideoFull, which is worse than a 400.
    if (imagePromptRaw && ad.kind !== 'image') {
      return res.status(400).json({
        error: 'imagePromptRaw is only supported for image ads'
      });
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
      regen.regenerateAd({
        ad, prompt, mode, requestedBy, videoModel, promptOverride,
        videoPromptRaw, videoPromptGuidance, imagePromptRaw
      }).catch(err => console.error(`❌ regenerate setImmediate crash: ${err.message}`));
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
      // ⚠️ A derive-only ad (Google PMax 1:1) does NOT own its asset. Until
      // its own titled video is uploaded, its renderUrl IS the sibling 9:16
      // master's plate URL — destroying it here would delete the video the
      // master paid for and break that ad too. Only destroy the asset once
      // this ad has its own upload (its renderUrl no longer points at the
      // inherited plate). `veoModel` is stamped `derive-from:<fmt>` at mint
      // and is the durable marker; renderUrl === veoVideoUrl means the
      // inherited plate is still what is on the row.
      const isDerived = typeof ad.veoModel === 'string'
        && ad.veoModel.startsWith('derive-from:');
      const stillInheritedPlate = isDerived && ad.renderUrl === ad.veoVideoUrl;

      // …and the SAME relationship has to be honoured from the OTHER side.
      // The check above only asks "is the ad being deleted the child?". A
      // MASTER never carries the `derive-from:` marker, so deleting the
      // master fell straight through and destroyed the very asset its
      // derive-only sibling is still pointing at — the plate the master was
      // paid for, and the sibling's only source. That sibling cannot heal
      // itself either: regenerate is refused for derive-only ads by design.
      // Reachable whenever the 1:1 is mid-titling, or is parked in a
      // titling-failed state (that branch never rewrites renderUrl, so it
      // holds the inherited URL indefinitely).
      let masterOfLiveDerive = false;
      if (!stillInheritedPlate && ad.platformFormat === PMAX_VIDEO_DERIVE_SOURCE) {
        try {
          const dependent = await Ad.findOne({
            _id:            { $ne: ad._id },
            brandId,
            campaignId:     ad.campaignId,
            productId:      ad.productId,
            platformFormat: PMAX_VIDEO_DERIVE_ONLY,
            // Still on the inherited plate: its renderUrl is this master's asset.
            renderUrl:      ad.renderUrl
          }).select('_id').lean();
          masterOfLiveDerive = !!dependent;
        } catch (err) {
          // Cannot prove the asset is unused → keep it. An orphaned Cloudinary
          // file is cheap; destroying a paid plate another ad depends on is not.
          console.warn(`   ⚠️  ads DELETE: dependent-derive lookup failed (${err.message}) — keeping asset`);
          masterOfLiveDerive = true;
        }
      }

      if (stillInheritedPlate) {
        cloudinary = { skipped: 'derive-only ad shares its master\'s plate — asset kept' };
      } else if (masterOfLiveDerive) {
        cloudinary = { skipped: 'a derive-only sibling still points at this plate — asset kept' };
      } else {
        cloudinary = await deleteFromCloudinary(ad.renderUrl);
      }
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
      adId:               String(ad._id),
      kind:               ad.kind,
      template:           ad.template,
      aspectRatio:        ad.aspectRatio,
      status:             ad.status,
      // Prefer the moment the render actually completed. Older video
      // rows predate renderedAt persistence, so fall back to the time
      // the generation row was created rather than leaving the UI blank.
      generatedAt:        ad.renderedAt || ad.generatedAt || ad.createdAt || null,
      productId:          ad.productId ? String(ad.productId) : null,
      // Regenerate-with-prompt state — surfaced here so the Generation
      // Details modal can poll this same endpoint while a regen runs,
      // and so it can gate edit/regenerate on exported ads (read-only).
      metaSyncStatus:     ad.metaSyncStatus || null,
      regenerating:       !!ad.regenerating,
      regenerationStage:  ad.regenerationStage || null,
      // Last regen outcome (done/failed/pending) — lets a poller distinguish
      // "finished successfully" from "finished but failed" once regenerating
      // flips back to false (both look identical from that flag alone).
      lastRegeneration: (() => {
        const h = Array.isArray(ad.regenerationHistory) ? ad.regenerationHistory : [];
        const last = h.length ? h[h.length - 1] : null;
        return last ? { status: last.status, error: last.error || null, at: last.at || null } : null;
      })(),
      warnings:           []
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
      // The reference-image stack the model ACTUALLY received (pos 0 = seed),
      // exactly as persisted at submit time. This used to fall back to a guess
      // rebuilt from the seed + the product's current catalog images, which is
      // both unfaithful (catalog images drift after the render) and actively
      // misleading in a diagnostic — an operator comparing output against a
      // reconstructed input stack is debugging a request that never happened.
      // Ads rendered before this was persisted report an empty list and say so.
      const referenceImages = Array.isArray(ad.veoReferenceImages) ? ad.veoReferenceImages.filter(Boolean) : [];
      if (!referenceImages.length) {
        // Empty is ambiguous — an unrecorded render and a genuinely
        // reference-free one look identical here. State that rather than
        // picking the more flattering explanation.
        out.warnings.push({
          code: 'reference-images-not-recorded',
          message: 'No reference images are stored for this ad — either none were sent or the render predates submit-time capture. Nothing is shown, because what a past render received cannot be recovered after the fact.'
        });
      }
      out.video = {
        model:       ad.veoModel || null,
        aspectRatio: ad.veoAspectRatio || null,
        prompt:      ad.veoPrompt || null,      // canonical prompt sent to the model
        storyboard:  ad.veoStoryboard || null,
        rawVideoUrl: ad.veoVideoUrl || null,    // BEFORE titling — compare vs finalUrl to locate garble
        finalUrl:    ad.renderUrl || null,       // AFTER titling overlay
        // Omni-family models render portrait masters at 9:16. Feed and
        // square deliverables are cropped from that Cloudinary master.
        // Expose the provenance explicitly so the inspector can show a
        // linked source thumbnail without guessing from URL strings.
        derivedFrom: (
          ['1:1', '4:5'].includes(ad.aspectRatio) &&
          ad.veoAspectRatio === '9:16' &&
          typeof ad.veoVideoUrl === 'string' &&
          ad.veoVideoUrl.includes('/video/upload/')
        ) ? {
          aspectRatio:  '9:16',
          videoUrl:     ad.veoVideoUrl,
          thumbnailUrl: ad.veoVideoUrl
            .replace('/video/upload/', '/video/upload/so_2,f_jpg,q_auto:good,w_360/')
            .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2')
        } : null,
        referenceImages                           // exactly what was submitted (pos 0 = seed); never reconstructed
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
    if (ad.kind === 'image' || ad.aiCanvasArtifactId || ad.imageGeneration) {
      const image = {
        aiCanvasArtifactId:    ad.aiCanvasArtifactId ? String(ad.aiCanvasArtifactId) : null,
        layoutInputArtifactId: ad.layoutInputArtifactId ? String(ad.layoutInputArtifactId) : null,
        // WHICH PIPELINE actually delivered this ad, read from the same
        // capture as imageGeneration below rather than inferred — an operator
        // question that used to take a code-reading session ("is this the
        // direct-image path or the old HTML fallback?") now answers itself.
        // null means neither recorded a submission (pre-capture render, or a
        // pipeline that makes no image-model call at all).
        pipeline:              ad.imageGeneration?.pipeline || null,
        fontResolution:        ad.fontResolution || null,
        // THE image-model request, verbatim from the POST body at submit time.
        // Distinct from layoutPrompt below, which belongs to the *layout* LLM
        // that writes HTML — conflating the two is what made an operator read
        // "one front image" while gpt-image-2 had in fact been handed two
        // references. Never reconstructed: null means not recorded.
        imageGeneration:       ad.imageGeneration || null,
        // Which intent ran, whether it fell back, what got sacrificed to the
        // density budget. See models/Ad.js for the full field description.
        intentResolution:      ad.intentResolution || null,
        // Post-render vision QC (original product vs finished render).
        // Includes per-attempt scores/findings and discarded paid render URLs.
        visionQc:              ad.visionQc || null,
        // Per-stage wall time for THIS render (derive/render/upload ms) — the
        // direct answer to "why is this one slow" without a log search.
        renderStages:          ad.renderStages || null
      };
      if (!ad.imageGeneration) {
        // Deliberately does NOT assert a cause. An HTML/Puppeteer render makes
        // no image-model call at all, so "predates capture" would be a fresh
        // untruth in the very field that exists to stop guessing.
        out.warnings.push({
          code: 'image-generation-not-recorded',
          message: 'No image-model request is stored for this ad — either none was made (HTML layout pipeline) or the render predates submit-time capture. Any prompt or image below belongs to the layout LLM, NOT the image model.'
        });
      }
      if (ad.aiCanvasArtifactId) {
        const AiCanvasArtifact = require('../models/AiCanvasArtifact');
        const c = await AiCanvasArtifact.findById(ad.aiCanvasArtifactId)
          .select('promptSystem promptUser promptImages canvasSpec outputHtml colorPalette copyPicks modelId htmlPromptSystem htmlPromptUser')
          .lean();
        if (c) {
          // htmlPromptSystem/User is the EXACT prompt the HTML Generator
          // sent for the current outputHtml. promptSystem/User is the
          // older JSON Generator's own (different) prompt — kept as a
          // fallback for ads rendered before htmlPrompt* was captured,
          // but it does NOT necessarily match outputHtml, so flag it.
          const exact = !!(c.htmlPromptSystem && c.htmlPromptUser);
          image.layoutPrompt = {
            system: c.htmlPromptSystem || c.promptSystem || null,
            user:   c.htmlPromptUser   || c.promptUser   || null,
            images: c.promptImages || []
          };
          image.promptIsExact = exact;
          image.canvasSpec   = c.canvasSpec || null;
          image.outputHtml   = c.outputHtml || null;
          image.colorPalette = c.colorPalette || null;
          image.copyPicks    = c.copyPicks || null;
          image.model        = c.modelId || null;   // e.g. 'gpt-4.1' — the layout-generation model
          if (!exact && (image.layoutPrompt.system || image.layoutPrompt.user)) {
            out.warnings.push({
              code: 'layout-prompt-legacy',
              message: 'Shown prompt is from the legacy JSON layout generator, not the HTML generator that actually produced this render — it may not exactly match the image. Editing and regenerating will still work off your edited text going forward.'
            });
          } else if (!image.layoutPrompt.system && !image.layoutPrompt.user) {
            out.warnings.push({ code: 'layout-prompt-missing', message: 'No layout prompt captured for this ad.' });
          }
        }
      }
      // NOTE: the shadow image-ref artifact (AiFullRenderArtifact) is still
      // intentionally NOT joined here — it has no FK on the Ad and its
      // uniqueness is an 8-field cache key (mediaId+template+aspectRatio+
      // productId+variantKind+campaignContextHash+paletteSource+creativeStyle),
      // so a partial-key lookup can surface the WRONG product's/palette's
      // prompt. A wrong prompt in a diagnostic is worse than none. The full,
      // correctly-joined image-ref + creative-direction detail is available
      // via GET /api/ai-layouts/spec/by-artifact/:aiCanvasArtifactId (exposed
      // above) — the frontend can deep-link to it.
      // This is why `imageGeneration` above is captured at submit time on the
      // Ad itself: an FK-less join is guesswork, and the one thing this
      // endpoint must never do is guess about what the model was sent.
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
    // Fire-and-forget progress telemetry (services/adStage.js), already read
    // off the doc for the render-activity board — exposed here too so a video
    // ad sitting at status:'draft' can be told apart from one that's actually
    // finished. 'draft' is stamped the instant the paid master lands, BEFORE
    // titling starts (routes/ads.js §00 money-guard comment: it must not sit
    // in 'rendering', or the reaper re-submits and double-bills), so 'draft'
    // alone covers both "still titling" and "fully done." The pipeline's own
    // last step stamps renderStage:'done' right after the real completion
    // write and never on the failure path (status flips to 'failed' there
    // instead) — so `renderStage && renderStage !== 'done'` is the exact
    // "still actively processing" signal, with no extra timestamp needed.
    renderStage:        ad.renderStage || null,
    // WHEN that stage was entered. Without it the gallery can say WHAT an ad is
    // doing but not whether it has been doing it for 8 seconds or 40 minutes —
    // and "Titling" that never moves is the failure the operator most needs to
    // see. /render-activity already derives its stageAgeSec from this field;
    // omitting it here is why the honest view existed on exactly one page.
    renderStageAt:      ad.renderStageAt || null,
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
  // A failed ad in the LIST needs to say WHY. renderError itself stays behind
  // `full` (it carries the prediction id and other internals), so surface just
  // the operator-facing headline — which since 2026-08-05 leads with the policy
  // label, e.g. "Model Moderation Error: Input Prompt violates policy". Without
  // this the ads page can only render a bare "Render failed" tile, which is what
  // sent someone to the database to find out that a prompt had been rejected.
  // Only on failure, so the common payload is unchanged.
  if (ad.status === 'failed' && ad.renderError?.message) {
    base.renderErrorMessage = String(ad.renderError.message);
    base.chargeState        = ad.renderError.chargeState || null;
  }

  if (full) {
    base.layoutInputArtifactId = ad.layoutInputArtifactId ? String(ad.layoutInputArtifactId) : null;
    base.cloudinaryPublicId    = ad.cloudinaryPublicId;
    base.identityDigest        = ad.identityDigest;
    base.renderError           = ad.renderError || null;
    base.renderAttempts        = ad.renderAttempts || 0;
  }
  return base;
}

// ── STRANDED-RUN REQUEUE (2026-08-05) ────────────────────────────────────────
// The render half of services/strandedRunSweeper. It lives HERE, not in that
// module, for one reason: runRenderLoop and claimAdsForRun are defined in this
// file, and having the sweeper require this router would create a cycle through
// half the service graph — a boot-time landmine. The sweeper calls in instead.
//
// ⚠️ THIS SPENDS MONEY. Every guard below is load-bearing:
//   · claimAdsForRun is the SAME atomic claim POST /runs uses. Its
//     `status:'queued'` filter is what makes concurrent sweeps (Render runs up
//     to 3 web instances, each with its own interval) safe: the first claim wins
//     and the losers see modifiedCount 0 rather than rendering the same ad twice.
//   · The caller has ALREADY tried recovery on every ad and passes only the
//     receipt-free ones. Never call this with an unfiltered list.
//   · renderIds comes from the claim result, never from the pre-claim selection —
//     aliasing those is a known double-charge regression the harness fails on.
//
// renderToken: the sweeper has no requesting user, so this mints a system token.
// It is only ever consumed by renderViaSpec (the dead HTML path); every ai_*
// static ad returns from renderDirectImage long before that, and video never
// reaches it. So a null-identity token cannot change what a live render does.
async function requeueStrandedAds({ ads, run }) {
  if (!ads?.length || !run) return 0;
  const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const selectedIds = ads.map((a) => String(a._id));

  // claimAdsForRun takes a MODEL ADAPTER, not an array — the indirection is what
  // lets scripts/verifyRunsClaim.js drive the real claim with an in-memory fake.
  // Passing the ad array made it throw `ads.updateMany is not a function` on the
  // first live sweep. It failed SAFELY (the throw is before any submit, so
  // nothing was billed), but it stranded the ads for another cycle. Use the
  // identical adapter POST /runs passes, so there is one claim path, not two.
  const claim = await claimAdsForRun(
    {
      updateMany: (filter, update) => Ad.updateMany(filter, update),
      find:       (filter) => Ad.find(filter).select('_id').lean()
    },
    { selectedIds, runId }
  );
  if (!claim?.renderIds?.length) return 0;

  const renderToken = jwt.sign(
    { id: null, userId: null, email: 'system@stranded-sweep', name: 'stranded-sweep' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const newRun = await CampaignRun.create({
    runId,
    brandId:      String(run.brandId),
    campaignId:   String(run.campaignId),
    campaignKind: run.campaignKind || 'promotional',
    total:        claim.total,
    status:       'running',
    requestedBy:  null,
    startedAt:    new Date(),
    // Scope stamped from the CLAIMED ads, matching /runs. generationGate reads
    // this and fails closed on an unreadable scope, so a partial list would be
    // worse than an empty one.
    requestedProductIds: [...new Set(
      claim.renderIds
        .map((id) => ads.find((a) => String(a._id) === String(id))?.productId)
        .filter(Boolean)
        .map(String)
    )]
  });

  const job = {
    brandId:      String(run.brandId),
    campaignId:   String(run.campaignId),
    campaignKind: run.campaignKind || 'promotional'
  };
  console.log(`♻️  strandedSweep: requeued ${claim.renderIds.length} ad(s) as ${runId}`);
  setImmediate(() => {
    runRenderLoop(newRun, job, claim.renderIds, renderToken).catch((err) => {
      console.error(`❌ stranded requeue ${runId} crashed:`, err.message || err);
      inFlight.untrack(runId);
    });
  });
  return claim.renderIds.length;
}

module.exports = router;
// Live claim function — offline harness drives THIS (scripts/verifyRunsClaim.js).
module.exports.claimAdsForRun = claimAdsForRun;
// Consumed by services/strandedRunSweeper via index.js — see requeueStrandedAds.
module.exports.requeueStrandedAds = requeueStrandedAds;
// MONEY-CRITICAL, exported for behavioural pinning by
// scripts/verifyPmaxVideoExpansion.js. This is the gate that keeps a
// derive-only PMax 1:1 ad out of the billable Omni path; a source-text
// check alone would pass against a reimplementation that kept the name,
// so the harness calls the real function.
module.exports.resolveDeriveFromMaster = resolveDeriveFromMaster;
// Exported so scripts/verifyStageVisibility.js can assert the SERIALISED SHAPE
// by calling it, rather than regexing the object literal. The gallery can only
// show a stage it is actually sent, so "does the payload carry it" is the whole
// contract and deserves a real call.
module.exports.projectAd = projectAd;
