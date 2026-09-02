// Post-detect rematch triggered after the catalog-product detect
// pipeline drains. Closes the race where post detect runs (priority=2)
// start while catalog-product detect runs (priority=1) are still
// building visual signatures — the matching phase fires too early
// and misses products whose detect hasn't completed yet.
//
// Why this exists: the worker has N loops (8 today). Priority sorting
// guarantees catalog-product DetectRuns START before post DetectRuns,
// but it doesn't guarantee they FINISH first — once a worker loop is
// in flight on a post detect, that detect runs to completion regardless
// of catalog state. Posts whose matching phase ran before the catalog
// visual index landed permanently miss those matches.
//
// Fix (2026-09-02): DEFER the initial per-post apify-sync DetectRun to
// this service entirely, and fire the full-brand rematch after catalog
// drain. Two knobs:
//   POST_DETECT_DEFER_TO_CATALOG=true   — apifyIngestService skips the
//                                          per-post detect at ingest
//                                          time; this service does the
//                                          first pass after drain.
//   POST_REMATCH_POLL_MAX_MS=3600000    — how long to wait for catalog
//                                          drain before giving up (60m
//                                          default, measured 47m on
//                                          200 products with heavy alt
//                                          fanout).
// The two knobs are coupled: catalogPostSyncOrchestrator reads the
// deferral flag and passes `full=<flag>` — deferred + full-rematch go
// together (no matches exist yet), legacy + unmatched-only go together
// (avoid re-matching what ingest-time already did).
//
// Re-runs are idempotent at the artifact level and the partial-unique
// mediaId_in_flight_unique index swallows accidental re-fires.

'use strict';

const DetectRun            = require('../models/DetectRun');
const Media                = require('../models/Media');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const catalogRetroLink     = require('./catalogRetroLinkService');

const POLL_INTERVAL_MS       = 10000;
const POST_REMATCH_POLL_MAX_MS_DEFAULT = 60 * 60 * 1000;   // 60 min — measured 47m drain on 200-product Pelagic Gear resync
const REMATCH_BATCH_LIMIT    = 200;

// UGC media source enum shared by every filter in this file — one place
// to add future platforms (TikTok, etc.) and the retro-link service
// already uses the same shape. Keeping it here rather than duplicating
// in every query stops a future add from silently missing a call site.
const UGC_SOURCES = ['instagram', 'apify-ig'];

// Read POST_DETECT_DEFER_TO_CATALOG. When true (default), the per-post
// DetectRun.create in apifyIngestService is skipped and this service
// owns the first-pass match after catalog drain. Written verbosely (not
// `!== 'false'`) so a caller who ships '0' / 'off' doesn't silently opt
// in. Two separate env reads (this + isFullRematchDefault) so an ops
// script can flip them independently, but catalogPostSyncOrchestrator
// couples them so a mixed state is rare in practice.
function isDeferPostDetectEnabled() {
  const raw = String(process.env.POST_DETECT_DEFER_TO_CATALOG || 'true')
    .toLowerCase().trim();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

// Read POST_REMATCH_POLL_MAX_MS. Clamped [60_000, 4h] — below 60s the
// poll is worthless (catalog drain never completes that fast); above 4h
// a stuck detect worker holds the rematch indefinitely and the operator
// won't notice. Fail-safe to default on any unparseable/out-of-range
// value; a runaway 24h ceiling would hide a real problem.
function postRematchPollMaxMs() {
  const raw = process.env.POST_REMATCH_POLL_MAX_MS;
  if (raw == null || raw === '') return POST_REMATCH_POLL_MAX_MS_DEFAULT;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v) || v < 60_000 || v > 4 * 60 * 60 * 1000) {
    return POST_REMATCH_POLL_MAX_MS_DEFAULT;
  }
  return v;
}

// Public entry. Caller can fire-and-forget via setImmediate; never
// throws to the caller.
//
// full: when true, enqueue rematch for EVERY UGC media in the brand
// (matches the deferred design — no initial match exists to skip).
// When false (default), skip UGC media that already have a strong
// match, preserving the pre-2026-09-02 unmatched-only behaviour so
// callers on the legacy-immediate path don't pay for a duplicate
// vision-match on already-matched posts.
async function rematchAfterCatalogDetect({ brandId, full = false } = {}) {
  if (!brandId) return { ok: false, reason: 'brandId required' };
  try {
    const ok = await waitForCatalogDetectDrained(brandId);
    if (!ok) {
      console.warn(`🔁 rematch-after-catalog: catalog-product detects didn't drain within ${postRematchPollMaxMs() / 1000}s — proceeding anyway`);
    }

    // Brand-wide retro-link pass — re-points unlinked artifacts and
    // phantom-linked artifacts onto the now-current synced rows. Runs
    // BEFORE the re-detect enqueue so the cheap subset-match path
    // resolves anything it can without paying for a fresh DetectRun.
    // Not gated on `full` because retro-link is free (no vision spend)
    // and always beneficial after a catalog delta.
    const retro = await catalogRetroLink.runBrandWide({ brandId });

    // Path selection: full=true enqueues ALL UGC media (the deferred-
    // design first pass); full=false enqueues only UGC media without a
    // strong match (the incremental-sync minimum-cost path).
    const result = full
      ? await enqueueRematchForAllPosts({ brandId })
      : await enqueueRematchForUnmatchedPosts({ brandId });
    console.log(
      `🔁 rematch-after-catalog: brand=${brandId} drained=${ok} full=${full} ` +
      `retroLinked=${retro.linked || 0} twinCollapses=${retro.twinCollapses || 0} ` +
      `enqueued=${result.enqueued} (of ${result.candidates} candidates)`
    );
    return { ok: true, ...result, retro, drained: ok, full };
  } catch (err) {
    console.warn(`🔁 rematch-after-catalog failed for brand ${brandId}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

// Poll until every catalog-product DetectRun for the brand is in a
// terminal state (completed | failed). Returns true on drain, false
// on timeout. Catalog-product runs are identified by their source
// Media (source='catalog-product').
async function waitForCatalogDetectDrained(brandId) {
  const startedAt = Date.now();
  const maxWaitMs = postRematchPollMaxMs();
  while (Date.now() - startedAt < maxWaitMs) {
    const productMediaIds = await Media.find({
      brandId, source: 'catalog-product'
    }).select('_id').lean();
    if (!productMediaIds.length) return true;
    const inFlight = await DetectRun.countDocuments({
      mediaId: { $in: productMediaIds.map(m => m._id) },
      status:  { $in: ['queued', 'processing'] }
    });
    if (inFlight === 0) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

// Enqueue DetectRuns (priority=1, trigger='manual-rematch') for any
// post Media without a strong match. "Strong match" = at least one
// ProductMatchArtifact with outcome in {product_match, product_category}.
// Capped to keep a single trigger bounded.
async function enqueueRematchForUnmatchedPosts({ brandId }) {
  const strongMatchMediaIds = await ProductMatchArtifact.distinct('mediaId', {
    brandId,
    outcome: { $in: ['product_match', 'product_category'] }
  });
  const strongSet = new Set(strongMatchMediaIds.map(id => String(id)));

  // Source filter: only post-side Media (skip catalog-product, manual
  // upload). Two IG-ingest sources exist:
  //   'instagram' — OAuth-connected real brands (routes/integrations,
  //                 instagramIngestService)
  //   'apify-ig'  — demo brands via Apify actor (apifyIngestService)
  // Measured 2026-09-01 on Pelagic Gear 4 Demos: filtering on
  // 'instagram' alone matched 0 of 30 post Media because every one
  // was stored as 'apify-ig' — this bug silently disabled the paid
  // re-detect phase for every demo brand. Future platforms (TikTok,
  // etc.) would be added here.
  const candidateMedia = await Media.find({
    brandId, source: { $in: UGC_SOURCES }
  }).select('_id advertiserId brandId').lean();

  const targets = candidateMedia.filter(m => !strongSet.has(String(m._id))).slice(0, REMATCH_BATCH_LIMIT);
  return await enqueueDetectRuns({ targets, candidatesTotal: candidateMedia.length });
}

// Enqueue DetectRuns (priority=1, trigger='manual-rematch') for EVERY
// UGC media in the brand, ignoring existing match state. This is the
// path for the deferred-detect design where the per-post apify-sync
// detect at ingest was skipped — no matches exist yet, so filtering
// by "unmatched" would exclude posts we haven't detected AT ALL.
//
// Capped identically to the unmatched-only path so a large brand
// doesn't burn the vision-match budget in one call. Ops that need a
// larger sweep can raise REMATCH_BATCH_LIMIT explicitly or re-run.
async function enqueueRematchForAllPosts({ brandId }) {
  const candidateMedia = await Media.find({
    brandId, source: { $in: UGC_SOURCES }
  }).select('_id advertiserId brandId').lean();

  const targets = candidateMedia.slice(0, REMATCH_BATCH_LIMIT);
  return await enqueueDetectRuns({ targets, candidatesTotal: candidateMedia.length });
}

// Shared enqueue implementation. Both paths bound their targets to
// REMATCH_BATCH_LIMIT before calling this — this function does no
// further filtering. Idempotent via the partial-unique
// mediaId_in_flight_unique index (E11000 → treat as no-op).
async function enqueueDetectRuns({ targets, candidatesTotal }) {
  if (!targets.length) return { enqueued: 0, candidates: candidatesTotal };
  let enqueued = 0;
  for (const m of targets) {
    try {
      await DetectRun.create({
        advertiserId: m.advertiserId,
        brandId:      m.brandId,
        mediaId:      m._id,
        trigger:      'manual-rematch',
        priority:     1
      });
      enqueued++;
    } catch (err) {
      // E11000 from the partial-unique mediaId_in_flight_unique guard
      // means a DetectRun is already queued/processing for this media —
      // a routine race when the post sync just queued one. Treat as
      // no-op rather than an error.
      if (err.code !== 11000) {
        console.warn(`   ⚠️  rematch enqueue failed for media ${m._id}: ${err.message}`);
      }
    }
  }
  return { enqueued, candidates: candidatesTotal };
}

module.exports = {
  rematchAfterCatalogDetect,
  isDeferPostDetectEnabled,
  postRematchPollMaxMs,
  // Exported for scripts/verifyPostDetectDeferral.js so the harness can
  // drive the two enqueue variants directly with in-memory stubs
  // instead of standing up Mongo. Also referenced by adjacent services
  // that want to run the full-brand path without the catalog-drain
  // poll (a future manual "rematch this brand now" capability).
  enqueueRematchForAllPosts,
  enqueueRematchForUnmatchedPosts,
  __test: {
    UGC_SOURCES,
    POST_REMATCH_POLL_MAX_MS_DEFAULT,
    POLL_INTERVAL_MS,
    REMATCH_BATCH_LIMIT
  }
};
