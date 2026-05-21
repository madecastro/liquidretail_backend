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
// Fix: after catalog sync completes, poll until every catalog-product
// DetectRun for the brand has terminated, then re-enqueue post detects
// (priority=1) for media that don't have a strong match. Re-runs are
// idempotent at the artifact level and the partial-unique
// mediaId_in_flight_unique index swallows accidental re-fires.

const DetectRun            = require('../models/DetectRun');
const Media                = require('../models/Media');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const catalogRetroLink     = require('./catalogRetroLinkService');

const POLL_INTERVAL_MS     = 10000;
const POLL_MAX_WAIT_MS     = 10 * 60 * 1000;   // 10 min — covers a 100-product catalog at 8-way concurrency
const REMATCH_BATCH_LIMIT  = 200;

// Public entry. Caller can fire-and-forget via setImmediate; never
// throws to the caller.
async function rematchAfterCatalogDetect({ brandId }) {
  if (!brandId) return { ok: false, reason: 'brandId required' };
  try {
    const ok = await waitForCatalogDetectDrained(brandId);
    if (!ok) {
      console.warn(`🔁 rematch-after-catalog: catalog-product detects didn't drain within ${POLL_MAX_WAIT_MS / 1000}s — proceeding anyway`);
    }

    // Brand-wide retro-link pass — re-points unlinked artifacts and
    // phantom-linked artifacts onto the now-current synced rows. Runs
    // BEFORE the re-detect enqueue so the cheap subset-match path
    // resolves anything it can without paying for a fresh DetectRun.
    const retro = await catalogRetroLink.runBrandWide({ brandId });

    const result = await enqueueRematchForUnmatchedPosts({ brandId });
    console.log(
      `🔁 rematch-after-catalog: brand=${brandId} drained=${ok} ` +
      `retroLinked=${retro.linked || 0} twinCollapses=${retro.twinCollapses || 0} ` +
      `enqueued=${result.enqueued} (of ${result.candidates} candidates)`
    );
    return { ok: true, ...result, retro, drained: ok };
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
  while (Date.now() - startedAt < POLL_MAX_WAIT_MS) {
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
  // upload). source='instagram' covers every IG-ingested post; future
  // platforms (TikTok, etc.) would be added here.
  const candidateMedia = await Media.find({
    brandId, source: 'instagram'
  }).select('_id advertiserId brandId').lean();

  const targets = candidateMedia.filter(m => !strongSet.has(String(m._id))).slice(0, REMATCH_BATCH_LIMIT);
  if (!targets.length) return { enqueued: 0, candidates: candidateMedia.length };

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
  return { enqueued, candidates: candidateMedia.length };
}

module.exports = { rematchAfterCatalogDetect };
