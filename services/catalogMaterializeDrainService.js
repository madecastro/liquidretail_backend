// services/catalogMaterializeDrainService.js
//
// Closes the "826 of 831 products unpickable" gap measured on a freshly
// ingested brand (Pelagic Gear, 2026-08-19 QA). Nothing at ingest time calls
// materializeMissingHero — CATALOG_DETECT_PRECOMPUTE deferral means
// `imageMediaId` stays null on every row until an operator happens to open
// THAT product's own detail page (GET /api/catalog/:id's lazy backfill,
// catalogProductDetectService.js:889-904). On a brand nobody has clicked
// through yet, that is every row but the ones already viewed.
//
// This service runs the SAME $0, no-DetectRun mirror
// (catalogProductDetectService.materializeMissingHero) proactively, at
// bounded concurrency, across an entire brand — instead of one row at a
// time gated behind a human click. It does not replace the per-product
// lazy backfill (still fine, still fires on individual detail views); it
// just means an operator doesn't have to open 826 detail pages by hand to
// make a fresh catalog generation-ready.
//
// RESUMABLE BY CONSTRUCTION, no persisted job/checklist needed: every pass
// re-queries `imageMediaId: null` fresh. A crashed process leaves every
// already-materialized row materialized (the write is per-product and
// committed before the loop moves on), so calling
// startCatalogMaterializeDrain again for the same brand — whether from a
// retry, a redeploy, or an operator re-clicking "Prepare catalog" — just
// continues from wherever it stopped. There is nothing to roll back and
// nothing to reconcile.
//
// OBSERVABLE via the EXISTING generic progress surface
// (services/progressService.js + models/OperationRun.js, kind
// 'catalog-materialize') — GET /api/progress/active?brandId= and
// GET /api/progress/:runId already work for this with no new route. Only
// the START endpoint (POST /api/catalog/materialize) is new.
//
// BOUNDED: CATALOG_MATERIALIZE_CONCURRENCY (services/concurrency.js,
// default 4) caps in-flight Cloudinary uploads — same account-level quota
// reasoning as CLOUDINARY_DELETE_CONCURRENCY. $0 cost: materializeMissingHero
// deliberately never creates a DetectRun (see that function's own comment —
// it is the hero counterpart of materializeMissingAlts and shares its cost
// profile: one idempotent Cloudinary mirror, no Gemini vision spend). This
// service paces Cloudinary + our own egress; it does not pace or gate any
// billable provider.

'use strict';

const CatalogProduct = require('../models/CatalogProduct');
const OperationRun = require('../models/OperationRun');
const Brand = require('../models/Brand');
const progressService = require('./progressService');
const { concurrency: CONC } = require('./concurrency');
const { materializeMissingHero } = require('./catalogProductDetectService');
const { isUnusableThumbnailUrl } = require('./catalogImageQuality');

// One Mongo round-trip covers this many rows; CATALOG_MATERIALIZE_CONCURRENCY
// bounds how many of them are in-flight against Cloudinary at once, not
// this number.
const BATCH_SIZE = 200;

function candidateFilter(brandId) {
  return {
    brandId,
    deletedAt: null,
    imageMediaId: null,
    imageUrl: { $nin: [null, ''] }
  };
}

/**
 * An already-running (or cancelling) drain for this brand, if any. Callers
 * use this to make "start a drain" idempotent: an operator POST, an
 * auto-trigger right after ingest, and a retry must never stack a second
 * concurrent sweep over the same brand's rows.
 */
async function findActiveMaterializeDrain(brandId) {
  if (!brandId) return null;
  return OperationRun.findOne({
    brandId,
    kind: 'catalog-materialize',
    status: { $in: ['running', 'cancelling'] }
  }).lean();
}

/**
 * Count what a drain would have to do, without doing it. Used by the route
 * to tell an operator "N products to prepare" before they click, and by
 * the drain to size its progress denominator.
 *
 * `excludedUnusable` — imageUrl is present but a known-broken thumbnail
 * (services/catalogImageQuality.js) — must be reported SEPARATELY, never
 * folded into the denominator: those rows can never materialize
 * (materializeImage refuses them at its own choke point), so counting them
 * as "pending" would make the progress bar look permanently stuck a few
 * items short of 100%.
 */
async function countMaterializeCandidates(brandId) {
  const rows = await CatalogProduct.find(candidateFilter(brandId))
    .select('imageUrl')
    .lean();

  let excludedUnusable = 0;
  let candidates = 0;
  for (const r of rows) {
    if (isUnusableThumbnailUrl(r.imageUrl)) excludedUnusable++;
    else candidates++;
  }
  return { candidates, excludedUnusable };
}

/**
 * Start (or resume-by-idempotency) the drain for one brand.
 *
 * Fire-and-forget by default: returns as soon as the OperationRun row
 * exists (fast — one count query + one insert), while the actual sweep
 * continues in the background. Pass `wait: true` to await full completion
 * (used by one-off scripts / live verification, never by an HTTP route).
 *
 * Never throws into an ingest call site — on any setup error this logs and
 * returns `{ started: false, error }` rather than breaking the caller's own
 * flow (same "best-effort, business process must not die" contract as
 * progressService.startRun itself).
 */
async function startCatalogMaterializeDrain({
  brandId,
  advertiserId = null,
  req = null,
  tenant = null,
  label = null,
  wait = false
} = {}) {
  try {
    if (!brandId) return { started: false, error: 'brandId is required' };

    const existing = await findActiveMaterializeDrain(brandId);
    if (existing) return { run: existing, started: false, alreadyRunning: true };

    const { candidates, excludedUnusable } = await countMaterializeCandidates(brandId);

    let advId = advertiserId;
    if (!advId && !req && !tenant) {
      const brand = await Brand.findById(brandId).select('advertiserId').lean();
      advId = brand?.advertiserId || null;
    }

    if (candidates === 0) {
      // Nothing to do — still worth a tiny succeeded run so the operator's
      // "Prepare catalog" click gets a real answer ("0 to prepare") instead
      // of silence, and so GET /api/progress/active shows a finished row.
      const handle = await progressService.startRun({
        kind: 'catalog-materialize',
        req, tenant, advertiserId: advId, brandId,
        total: 0,
        cancellable: true,
        label: label || 'Preparing catalog images',
        meta: { excludedUnusable }
      });
      await handle.succeed({ done: 0, failed: 0, skippedUnusable: 0, note: 'nothing to materialize' });
      return { run: { id: handle.id }, started: true, candidates: 0, excludedUnusable };
    }

    const handle = await progressService.startRun({
      kind: 'catalog-materialize',
      req, tenant, advertiserId: advId, brandId,
      total: candidates,
      cancellable: true,
      label: label || 'Preparing catalog images',
      meta: { excludedUnusable }
    });

    const runPromise = drainLoop({ brandId, handle, totalCandidates: candidates })
      .catch(err => {
        console.error(`[catalogMaterializeDrain] brand ${brandId} crashed:`, err && err.message ? err.message : err);
      });

    if (wait) {
      const result = await runPromise;
      return { run: { id: handle.id }, started: true, candidates, excludedUnusable, result };
    }

    return { run: { id: handle.id }, started: true, candidates, excludedUnusable };
  } catch (err) {
    console.warn('[catalogMaterializeDrain] startCatalogMaterializeDrain failed:', err && err.message ? err.message : err);
    return { started: false, error: err && err.message ? err.message : String(err) };
  }
}

async function drainLoop({ brandId, handle, totalCandidates }) {
  const concurrency = Math.max(1, CONC.CATALOG_MATERIALIZE_CONCURRENCY);
  let done = 0;
  let failed = 0;
  let skippedUnusable = 0;
  const timingsMs = [];

  try {
    for (;;) {
      await handle.checkpoint(); // throws CancelledError if the operator cancelled

      const batch = await CatalogProduct.find(candidateFilter(brandId))
        .select('_id brandId title imageUrl imageShotStyles')
        .limit(BATCH_SIZE)
        .lean();

      if (!batch.length) break;

      // Per-PASS delta, not cumulative — the stopping condition. A batch
      // can legitimately contain zero NEW materializations only when every
      // row in it is a known-unusable seed (never clears imageMediaId) or a
      // transient failure (materializeMissingHero didn't throw but
      // returned null, e.g. Cloudinary error swallowed to the source-URL
      // fallback path returning no media). Either way, re-querying the
      // identical filter again would just re-fetch the identical rows —
      // stop instead of hot-looping.
      let passDone = 0;

      let idx = 0;
      async function worker() {
        while (idx < batch.length) {
          const product = batch[idx++];
          if (isUnusableThumbnailUrl(product.imageUrl)) {
            skippedUnusable++;
            continue;
          }
          const startedAt = Date.now();
          try {
            const mediaId = await materializeMissingHero(product);
            timingsMs.push(Date.now() - startedAt);
            if (mediaId) { done++; passDone++; } else { failed++; }
          } catch (err) {
            failed++;
            console.warn(`   ⚠️  catalogMaterializeDrain[${product._id}]: ${err.message}`);
          }
          handle.tick(done, totalCandidates, `${done}/${totalCandidates} prepared`);
          await handle.checkpoint();
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));

      if (passDone === 0) break; // nothing changed this pass — stop, don't spin
    }

    timingsMs.sort((a, b) => a - b);
    const median = timingsMs.length ? timingsMs[Math.floor(timingsMs.length / 2)] : null;
    const p95 = timingsMs.length
      ? timingsMs[Math.min(timingsMs.length - 1, Math.floor(timingsMs.length * 0.95))]
      : null;

    await handle.succeed({
      done, failed, skippedUnusable,
      medianMaterializeMs: median,
      p95MaterializeMs: p95,
      sampleCount: timingsMs.length
    });

    return { done, failed, skippedUnusable, medianMs: median, p95Ms: p95, sampleCount: timingsMs.length };
  } catch (err) {
    if (err && err.code === 'CANCELLED') {
      // handle.checkpoint() already wrote status:'cancelled'. Whatever was
      // already materialized stays materialized — re-running the drain
      // resumes from here, same as a crash.
      return { done, failed, skippedUnusable, cancelled: true };
    }
    await handle.fail(err, { done, failed, skippedUnusable });
    throw err;
  }
}

module.exports = {
  startCatalogMaterializeDrain,
  findActiveMaterializeDrain,
  countMaterializeCandidates,
  // Exported pure helper — lets the offline harness assert the exact query
  // shape (imageMediaId: null, deletedAt: null, imageUrl usable) without a
  // live DB, same pattern as catalogImageQuality.js's exported regexes.
  candidateFilter
};
