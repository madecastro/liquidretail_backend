// Catalog post-sync chain orchestrator.
//
// PROBLEM. The 4 catalog sync services (catalogSync, shopifyPublicIngest,
// apifyIngest, genericCatalogIngest) each pushed the SAME fire-and-forget
// try/try block onto their `backgroundWork` array:
//
//   backgroundWork.push((async () => {
//     try { await ensureBrandCatalogMediaMaterialized(brandId); }
//     catch (err) { console.warn(err.message); }
//     try { await enqueueBrandProductYoloDetection(brandId); }
//     catch (err) { console.warn(err.message); }
//   })());
//
// Three failure modes it silently absorbs:
//   1. SIGTERM mid-work — a deploy during onboarding leaves the chain
//      half-done and nothing knows.
//   2. Downstream service outage — measured 2026-08-31 when the yolo
//      microservice was in a WORKER TIMEOUT loop, every catalog sync
//      logged one warning and moved on; the yolo phase never ran to
//      completion for any brand that synced during the outage.
//   3. Silent Cloudinary rate-limit — materialize succeeds partially
//      (heroes done, alts skipped), no persistent failure signal.
//
// PROOF OF THE DAMAGE. Pelagic Gear 4 Demos as inspected on 2026-09-01:
//   - 48 catalog products synced (out of 750+ actually available)
//   - Only 9/48 heroes materialized
//   - 0/53 catalog Media had yoloDetectedAt stamped — meaning the yolo
//     phase never touched a single one, ever. Every ad-gen run on this
//     brand paid the ~$0.16 outpaint tax because refined bboxes were
//     always generic 'object' from cropRefineService, never Grounding
//     DINO product labels.
//
// FIX. runPostSyncChain(brandId) wraps the two phases in a single
// OperationRun(kind='catalog-post-sync') and marks it succeeded / failed
// / partial so:
//   - The state is persistent (visible via GET /api/progress/active and
//     the setup-status endpoint).
//   - worker.js postSyncReconcileTick can find and re-fire failed /
//     partial runs (every 30 min by default), so a transient outage
//     doesn't leave a brand stranded forever.
//   - The four sync services collapse to one function call each — the
//     chain shape lives in ONE place, not four copies drifting apart.
//
// IDEMPOTENT. Both underlying services are gap-fillers by construction:
//   - ensureBrandCatalogMediaMaterialized skips products whose pointers
//     already exist (materializeImage's own idempotency).
//   - enqueueBrandProductYoloDetection with onlyGaps:true only picks up
//     products with empty refinedProducts.
// So re-running on a fully-done brand is a cheap DB read pair.

'use strict';

const OperationRun = require('../models/OperationRun');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');
const progressService = require('./progressService');

// One log prefix so post-sync chain lines are grep-able across the 4
// sync callers plus the reconcile tick.
const LOG = '🔗 post-sync';

/**
 * Run the materialize + yolo-detect chain for one brand.
 *
 * NEVER throws — the whole point is to absorb transient failure into a
 * persistent OperationRun and let the reconcile tick retry. Every caller
 * (4 sync services + worker.js tick) fires this without awaiting; a
 * throw would poison the surrounding backgroundWork.push semantics.
 *
 * @param {ObjectId|string} brandId
 * @param {object} opts
 * @param {'sync'|'reconcile'|'manual'} [opts.trigger='sync']
 *   — labels the OperationRun.meta.trigger so a post-hoc audit can tell
 *   sync-triggered runs (normal) from reconcile-triggered ones (recovery).
 * @returns {Promise<{status:'ok'|'partial'|'failed'|'skipped', phases:{materialize:string, yoloDetect:string}, runId:string|null}>}
 */
async function runPostSyncChain(brandId, { trigger = 'sync' } = {}) {
  if (!brandId) return { status: 'skipped', reason: 'no brandId', phases: {}, runId: null };

  const brand = await Brand.findById(brandId).select('advertiserId').lean();
  if (!brand) return { status: 'skipped', reason: 'brand not found', phases: {}, runId: null };

  const run = await progressService.startRun({
    kind:        'catalog-post-sync',
    advertiserId: brand.advertiserId || null,
    brandId,
    total:       2,
    cancellable: false,
    label:       'Catalog materialize + YOLO detect',
    meta:        { trigger }
  });

  const phases = { materialize: 'pending', yoloDetect: 'pending' };
  let failures = 0;

  // Phase 1 — materialize hero + top-N alts. Idempotent; running on a
  // fully-materialized brand is one lean query and returns immediately.
  try {
    const { ensureBrandCatalogMediaMaterialized } = require('./catalogMediaMaterializeService');
    await ensureBrandCatalogMediaMaterialized(brandId);
    phases.materialize = 'ok';
    run.tick(1, 2, 'materialize ok');
  } catch (err) {
    phases.materialize = `failed: ${err.message?.slice(0, 200) || 'unknown'}`;
    failures++;
    console.warn(`${LOG}[brand=${brandId}] materialize phase failed: ${err.message}`);
  }

  // Phase 2 — Grounding DINO detection on any Media with empty
  // refinedProducts. Idempotent via onlyGaps:true.
  try {
    const { enqueueBrandProductYoloDetection } = require('./catalogYoloDetectionService');
    await enqueueBrandProductYoloDetection(brandId);
    phases.yoloDetect = 'ok';
    run.tick(2, 2, 'yolo-detect ok');
  } catch (err) {
    phases.yoloDetect = `failed: ${err.message?.slice(0, 200) || 'unknown'}`;
    failures++;
    console.warn(`${LOG}[brand=${brandId}] yolo-detect phase failed: ${err.message}`);
  }

  const status = failures === 0 ? 'ok' : (failures === 2 ? 'failed' : 'partial');
  try {
    if (status === 'ok') {
      await run.succeed({ phases });
    } else {
      // Marking as failed with the phase map lets the reconcile tick
      // surface WHICH phase to focus on (or whether both need retry).
      // Not throwing — the fail() call is the persistent signal.
      await run.fail(new Error(`${status}: ${JSON.stringify(phases)}`), { phases, status });
    }
  } catch (err) {
    // OperationRun bookkeeping failed — log but don't compound the
    // failure. The next reconcile tick will see the run as stale.
    console.warn(`${LOG}[brand=${brandId}] OperationRun close failed: ${err.message}`);
  }

  // Phase 3 (fire-and-forget, 2026-09-02): trigger post-detect rematch
  // AFTER the catalog-sync detect queue drains. Only fires when phase 2
  // (yolo-detect enqueue) succeeded — no point re-matching UGC against
  // a catalog whose detects couldn't even start.
  //
  // Runs OUTSIDE this OperationRun's lifecycle by design: rematch's own
  // poll waits up to POST_REMATCH_POLL_MAX_MS (60 min default) for the
  // detect queue to drain, well past this OperationRun's ~seconds-long
  // window. Extending phase 2's total from 2→3 and holding the
  // OperationRun open through the poll would break the reconcile
  // tick's `updatedAt > STALE_MIN` heuristic. Rematch has its own
  // failure logging and no retry — a one-shot post-catalog rematch is
  // the semantic, and a re-fire would only happen on the next catalog
  // sync of this brand.
  //
  // full=<POST_DETECT_DEFER_TO_CATALOG>: deferred design skipped the
  // per-post detect at ingest, so nothing is matched yet and we need to
  // enqueue every UGC media (full=true). Legacy immediate-detect mode
  // already matched at ingest, so rematch only touches UNMATCHED posts
  // (full=false) — avoids paying twice for the same vision-match.
  if (phases.yoloDetect === 'ok') {
    setImmediate(async () => {
      try {
        const { rematchAfterCatalogDetect, isDeferPostDetectEnabled } = require('./postRematchAfterCatalogService');
        const full = isDeferPostDetectEnabled();
        await rematchAfterCatalogDetect({ brandId, full });
      } catch (err) {
        console.warn(`${LOG}[brand=${brandId}] post-rematch trigger failed: ${err.message}`);
      }
    });
  }

  return { status, phases, runId: String(run.id || run._id || '') };
}

/**
 * Sweep Brands with catalog products where the post-sync chain hasn't
 * fully landed. This is the RECONCILE side — called from worker.js on
 * an interval so a transient outage doesn't strand a brand.
 *
 * TWO signals of incomplete state, ANY of which triggers a re-fire:
 *   (a) A `catalog-post-sync` OperationRun in status 'failed' or
 *       'running' older than STALE_MIN. `failed` is a retry target;
 *       `running` older than STALE_MIN means the process holding it
 *       died mid-work.
 *   (b) NO recent `catalog-post-sync` run at all for a brand that has
 *       CatalogProducts with imageUrl but null imageMediaId. This
 *       catches brands whose sync fired BEFORE this orchestrator
 *       shipped — they never had a run written.
 *
 * Bounded per tick (BATCH default 5) so a big backlog of stranded
 * brands doesn't monopolize the worker's housekeeping window.
 *
 * @param {object} opts
 * @param {number} [opts.batchSize]  — max brands to reconcile in one call
 * @param {number} [opts.staleMinutes]  — how long a running/failed run
 *   must sit before it's a retry target (default 30 min)
 * @returns {Promise<{scanned:number, reconciled:number, skipped:number}>}
 */
async function sweepIncompleteBrands({ batchSize = 5, staleMinutes = 30 } = {}) {
  const staleBefore = new Date(Date.now() - staleMinutes * 60 * 1000);
  const brandIds = new Set();

  // Signal (a) — failed or long-running post-sync operations.
  try {
    const stale = await OperationRun.find({
      kind: 'catalog-post-sync',
      $or: [
        { status: 'failed' },
        { status: 'running', updatedAt: { $lt: staleBefore } }
      ]
    })
      .sort({ updatedAt: 1 })
      .select('brandId')
      .limit(batchSize * 2)
      .lean();
    for (const r of stale) {
      if (r.brandId) brandIds.add(String(r.brandId));
      if (brandIds.size >= batchSize) break;
    }
  } catch (err) {
    console.warn(`${LOG} sweep signal-a failed: ${err.message}`);
  }

  // Signal (b) — brands with CatalogProducts needing materialize AND
  // no successful post-sync run recorded. Cheap distinct query, bounded.
  if (brandIds.size < batchSize) {
    try {
      const pendingBrandIds = await CatalogProduct.distinct('brandId', {
        imageUrl: { $nin: [null, ''] },
        imageMediaId: null,
        deletedAt: null
      });
      for (const bid of pendingBrandIds) {
        if (brandIds.size >= batchSize) break;
        // Skip brands that already have a recent successful run — they
        // might have new products since the last sync but the periodic
        // tick's job is recovery, not routine backfill (that's the yolo
        // backfill tick's job for Media-level gaps).
        const recentOk = await OperationRun.findOne({
          kind: 'catalog-post-sync',
          brandId: bid,
          status: 'succeeded',
          updatedAt: { $gt: staleBefore }
        }).select('_id').lean();
        if (!recentOk) brandIds.add(String(bid));
      }
    } catch (err) {
      console.warn(`${LOG} sweep signal-b failed: ${err.message}`);
    }
  }

  const targets = [...brandIds].slice(0, batchSize);
  if (!targets.length) return { scanned: 0, reconciled: 0, skipped: 0 };

  console.log(`${LOG} reconcile sweep: ${targets.length} brand(s) — ${targets.join(', ')}`);
  let reconciled = 0;
  let skipped = 0;
  for (const bid of targets) {
    const r = await runPostSyncChain(bid, { trigger: 'reconcile' });
    if (r.status === 'ok' || r.status === 'partial') reconciled++;
    else skipped++;
  }
  console.log(`${LOG} reconcile sweep done: reconciled=${reconciled} skipped=${skipped}`);
  return { scanned: targets.length, reconciled, skipped };
}

module.exports = {
  runPostSyncChain,
  sweepIncompleteBrands,
  __test: {
    LOG
  }
};
