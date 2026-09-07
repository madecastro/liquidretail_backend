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
// Overlap guard (2026-09-06): an in-process Set of brandIds plus the
// reconcile sweep consulting heartbeatAt (not "any failed ever") stop
// N overlapping chains from stacking CATALOG_YOLO_CONCURRENCY each.
//
// IDEMPOTENT. Both underlying services are gap-fillers by construction:
//   - ensureBrandCatalogMediaMaterialized skips products whose pointers
//     already exist (materializeImage's own idempotency).
//   - enqueueBrandProductYoloDetection with onlyGaps:true only picks up
//     products with empty refinedProducts (and yoloDetectedAt:null).
// So re-running on a fully-done brand is a cheap DB read pair.

'use strict';

const OperationRun = require('../models/OperationRun');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const progressService = require('./progressService');
const yoloLoadLimiter = require('./yoloLoadLimiter');
const alerts = require('./alertService');

const { STALE_HEARTBEAT_MS } = progressService;

// One log prefix so post-sync chain lines are grep-able across the 4
// sync callers plus the reconcile tick.
const LOG = '🔗 post-sync';

const LIVE_KINDS = ['catalog-post-sync', 'yolo-detect', 'materialize'];

function parsePositiveInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_INFLIGHT_CHAINS = parsePositiveInt(process.env.POST_SYNC_MAX_INFLIGHT_CHAINS, 1);
const BACKOFF_BASE_MS = parsePositiveInt(process.env.CATALOG_YOLO_BACKOFF_BASE_MS, 1_800_000);
const BACKOFF_CAP_MS = parsePositiveInt(process.env.CATALOG_YOLO_BACKOFF_CAP_MS, 28_800_000);
// Brand-level chain heartbeat stale window (minutes → ms). Independent of
// OperationRun.heartbeatAt / MAX_RUN_MS. Default 15.
const CHAIN_HEARTBEAT_STALE_MIN = parsePositiveInt(process.env.POST_SYNC_CHAIN_HEARTBEAT_STALE_MIN, 15);
const CHAIN_HEARTBEAT_STALE_MS = CHAIN_HEARTBEAT_STALE_MIN * 60 * 1000;

// Same-process registry. Empty on boot is correct (old process died).
const inFlightBrands = new Set();

let _testOverrides = {};

function nextBackoffMs(failures) {
  const n = Math.max(1, Number(failures) || 1);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2 ** (n - 1)));
}

function backoffAfterSuccessUpdate() {
  return {
    $set: {
      catalogYoloBackoffUntil: null,
      catalogYoloBackoffFailures: 0,
      catalogYoloBackoffReason: null
    }
  };
}

function backoffOnAbortUpdate(failures, now = Date.now()) {
  const delayMs = nextBackoffMs(failures);
  return {
    delayMs,
    update: {
      $set: {
        catalogYoloBackoffUntil: new Date(now + delayMs),
        catalogYoloBackoffFailures: failures,
        catalogYoloBackoffReason: 'yolo-circuit-open'
      }
    }
  };
}

function isChainHeartbeatFresh(at, now = Date.now(), staleMs = CHAIN_HEARTBEAT_STALE_MS) {
  if (!at) return false;
  const ms = at instanceof Date ? at.getTime() : Number(at);
  return Number.isFinite(ms) && ms > now - staleMs;
}

function mongoReady() {
  return !!(Brand.db && Brand.db.readyState === 1);
}

async function claimChainHeartbeat(brandId) {
  if (_testOverrides.claimChainHeartbeat) return _testOverrides.claimChainHeartbeat(brandId);
  if (!mongoReady()) return true;
  const staleBefore = new Date(Date.now() - CHAIN_HEARTBEAT_STALE_MS);
  const doc = await Brand.findOneAndUpdate(
    {
      _id: brandId,
      $or: [
        { catalogPostSyncHeartbeatAt: null },
        { catalogPostSyncHeartbeatAt: { $exists: false } },
        { catalogPostSyncHeartbeatAt: { $lt: staleBefore } }
      ]
    },
    { $set: { catalogPostSyncHeartbeatAt: new Date() } },
    { new: true }
  );
  return !!doc;
}

async function touchChainHeartbeat(brandId) {
  if (!brandId) return;
  if (_testOverrides.touchChainHeartbeat) return _testOverrides.touchChainHeartbeat(brandId);
  if (!mongoReady()) return;
  try {
    await Brand.updateOne(
      { _id: brandId },
      { $set: { catalogPostSyncHeartbeatAt: new Date() } }
    );
  } catch (err) {
    console.warn(`${LOG} chain heartbeat touch failed: ${err.message}`);
  }
}

async function clearChainHeartbeat(brandId) {
  if (!brandId) return;
  if (_testOverrides.clearChainHeartbeat) return _testOverrides.clearChainHeartbeat(brandId);
  if (!mongoReady()) return;
  try {
    await Brand.updateOne(
      { _id: brandId },
      { $set: { catalogPostSyncHeartbeatAt: null } }
    );
  } catch (err) {
    console.warn(`${LOG} chain heartbeat clear failed: ${err.message}`);
  }
}

async function applyBackoff(brandId, reason = 'yolo-circuit-open') {
  if (_testOverrides.applyBackoff) return _testOverrides.applyBackoff(brandId, reason);
  if (!mongoReady()) return { failures: 1, delayMs: nextBackoffMs(1), reason };
  const now = Date.now();
  // Single atomic pipeline: $inc-equivalent $add on failures, then derive
  // until from the NEW count. Two aborting processes cannot both write
  // failures=1 (the previous read-modify-write lost-update).
  const doc = await Brand.findOneAndUpdate(
    { _id: brandId },
    [
      {
        $set: {
          catalogYoloBackoffFailures: { $add: [{ $ifNull: ['$catalogYoloBackoffFailures', 0] }, 1] },
          catalogYoloBackoffReason: reason
        }
      },
      {
        $set: {
          catalogYoloBackoffUntil: {
            $toDate: {
              $add: [
                now,
                {
                  $min: [
                    BACKOFF_CAP_MS,
                    {
                      $multiply: [
                        BACKOFF_BASE_MS,
                        { $pow: [2, { $max: [0, { $subtract: ['$catalogYoloBackoffFailures', 1] }] }] }
                      ]
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    ],
    { new: true }
  );
  const failures = (doc && doc.catalogYoloBackoffFailures) || 1;
  return { failures, delayMs: nextBackoffMs(failures), reason };
}

async function backoffAfterSuccess(brandId) {
  if (_testOverrides.backoffAfterSuccess) return _testOverrides.backoffAfterSuccess(brandId);
  const update = backoffAfterSuccessUpdate();
  await Brand.updateOne({ _id: brandId }, update);
  return update;
}

function alertBrandChainAbort({ brandId, remaining, consecutive, backoffMs } = {}) {
  const backoffMin = Math.round((backoffMs || yoloLoadLimiter.cooldownMs()) / 60000);
  alerts.notifyAsync({
    level: 'error',
    title: `Catalog YOLO chain aborted — brand ${brandId}`,
    key: `yolo:circuit-open:brand:${brandId}`,
    fields: {
      brand: String(brandId || '-'),
      'consecutive transients': consecutive == null ? yoloLoadLimiter.consecutiveTransientNow() : consecutive,
      'remaining targets': remaining == null ? '-' : remaining,
      'backoff applied': `${backoffMin}m`,
      'operator action': 'YOLO microservice degraded; catalog detection paused; resumes automatically after cooldown'
    },
    detail: 'YOLO microservice degraded; catalog detection paused; resumes automatically after cooldown'
  });
}

// Local (non-circuit-open) chain outcome — materialize and/or yolo-detect
// threw a plain error, or both completed but at least one failed. Distinct
// from alertBrandChainAbort above (that one is the yolo-circuit-open EARLY
// RETURN, already covered by tonight's PR #403/#404). This covers the
// OTHER way the chain can end unhappy: a generic phase failure (Cloudinary
// hiccup, materialize throw, a non-transient yolo-detect error the breaker
// never opens on) that previously left the reconcile tick's own retry as
// the only signal anyone would ever see. Dedupe key is per-brand PER-STATUS
// (`catalog-post-sync:${status}:${brandId}`) so a 'partial' and a later
// 'failed' for the same brand do not fold into one dedupe slot, and two
// different brands never share one.
function alertPostSyncOutcome({ brandId, status, phases, trigger } = {}) {
  alerts.notifyAsync({
    level: 'warn',
    title: `Catalog post-sync chain ${status} — brand ${brandId}`,
    key: `catalog-post-sync:${status}:${brandId}`,
    fields: {
      brand: String(brandId || '-'),
      status,
      trigger: trigger || '-',
      materialize: (phases && phases.materialize) || '-',
      'yolo detect': (phases && phases.yoloDetect) || '-'
    },
    detail: `Catalog post-sync chain for brand ${brandId} finished '${status}'. materialize=${(phases && phases.materialize) || '-'} yoloDetect=${(phases && phases.yoloDetect) || '-'}`
  });
}

/**
 * Pure sweep predicate. latestRuns is one row per brand (already unique).
 * liveBrandIds / inFlight / backoffUntil skip a brand even if its latest
 * run is failed. Running with a fresh heartbeatAt is not selected;
 * running with heartbeatAt older than staleMs is (dead holder).
 */
function filterSweepCandidates({
  latestRuns = [],
  liveBrandIds = [],
  inFlight = [],
  backoffUntil = {},
  chainHeartbeatAt = {},
  now = Date.now(),
  staleMs = STALE_HEARTBEAT_MS,
  chainStaleMs = CHAIN_HEARTBEAT_STALE_MS
} = {}) {
  const live = new Set([...liveBrandIds].map(String));
  const flying = new Set(inFlight instanceof Set
    ? [...inFlight].map(String)
    : [...inFlight].map(String));
  const selected = [];
  const seen = new Set();
  for (const run of latestRuns) {
    const id = String(run.brandId || run._id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (flying.has(id) || live.has(id)) continue;
    if (isChainHeartbeatFresh(chainHeartbeatAt[id], now, chainStaleMs)) continue;
    const until = backoffUntil[id];
    const untilMs = until instanceof Date ? until.getTime() : until;
    if (untilMs && untilMs > now) continue;

    const status = run.lastStatus || run.status || 'none';
    if (status === 'succeeded') continue;
    if (status === 'running') {
      const hb = run.lastHeartbeatAt || run.heartbeatAt;
      const hbMs = hb instanceof Date ? hb.getTime() : Number(hb);
      if (hbMs && hbMs > now - staleMs) continue;
      selected.push(id);
      continue;
    }
    // failed / none / missing / cancelled — retry targets
    selected.push(id);
  }
  return selected;
}

/**
 * Run the materialize + yolo-detect chain for one brand.
 *
 * NEVER throws — the whole point is to absorb transient failure into a
 * persistent OperationRun and let the reconcile tick retry. The four
 * sync callers fire this without awaiting (backgroundWork.push); the
 * reconcile sweep DOES await (sweepIncompleteBrands). A throw would
 * poison the surrounding backgroundWork.push semantics.
 *
 * @param {ObjectId|string} brandId
 * @param {object} opts
 * @param {'sync'|'reconcile'|'manual'} [opts.trigger='sync']
 *   — labels the OperationRun.meta.trigger so a post-hoc audit can tell
 *   sync-triggered runs (normal) from reconcile-triggered ones (recovery).
 * @returns {Promise<{status:'ok'|'partial'|'failed'|'skipped', reason?:string, phases:{materialize:string, yoloDetect:string}, runId:string|null}>}
 */
async function runPostSyncChain(brandId, { trigger = 'sync' } = {}) {
  if (!brandId) return { status: 'skipped', reason: 'no brandId', phases: {}, runId: null };
  const id = String(brandId);
  // in-process-registry-skip (B1)
  if (inFlightBrands.has(id)) {
    console.log(`${LOG}[brand=${id}] skipped (in-process chain already running)`);
    return { status: 'skipped', reason: 'in-flight', phases: {}, runId: null };
  }
  // Cross-process gate (F1/F2): Brand heartbeat is independent of
  // OperationRun.heartbeatAt (voided at MAX_RUN_MS=4h). Atomic claim so
  // web ingest + worker reconcile cannot both start.
  const claimed = await claimChainHeartbeat(id);
  if (!claimed) {
    console.log(`${LOG}[brand=${id}] skipped (chain-alive heartbeat still fresh)`);
    return { status: 'skipped', reason: 'chain-alive', phases: {}, runId: null };
  }
  inFlightBrands.add(id);
  try {
    return await runPostSyncChainUnlocked(brandId, { trigger });
  } finally {
    inFlightBrands.delete(id);
    await clearChainHeartbeat(id);
  }
}

async function runPostSyncChainUnlocked(brandId, { trigger = 'sync' } = {}) {
  const findBrand = _testOverrides.findBrand
    || ((id) => Brand.findById(id).select('advertiserId').lean());
  const startRun = _testOverrides.startRun
    || ((args) => progressService.startRun(args));
  const doMaterialize = _testOverrides.materialize
    || (async (id) => {
      const { ensureBrandCatalogMediaMaterialized } = require('./catalogMediaMaterializeService');
      return ensureBrandCatalogMediaMaterialized(id);
    });
  const doYolo = _testOverrides.yolo
    || (async (id) => {
      const { enqueueBrandProductYoloDetection } = require('./catalogYoloDetectionService');
      return enqueueBrandProductYoloDetection(id);
    });

  const brand = await findBrand(brandId);
  if (!brand) return { status: 'skipped', reason: 'brand not found', phases: {}, runId: null };

  const run = await startRun({
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
    await doMaterialize(brandId);
    phases.materialize = 'ok';
    run.tick(1, 2, 'materialize ok');
    try { await touchChainHeartbeat(brandId); } catch { /* ignore */ }
  } catch (err) {
    phases.materialize = `failed: ${err.message?.slice(0, 200) || 'unknown'}`;
    failures++;
    console.warn(`${LOG}[brand=${brandId}] materialize phase failed: ${err.message}`);
  }

  // Phase 2 — Grounding DINO detection on any Media with empty
  // refinedProducts AND yoloDetectedAt:null. Idempotent via onlyGaps:true.
  // Phase 2 can run for hours; liveness is heartbeatAt + in-process
  // registry, not phase ticks.
  try {
    const yolo = await doYolo(brandId);
    if (yolo && yolo.ok === false && yolo.reason === 'yolo-circuit-open') {
      phases.yoloDetect = 'failed: yolo-circuit-open';
      failures++;
      const backoff = await applyBackoff(brandId, 'yolo-circuit-open');
      alertBrandChainAbort({
        brandId,
        remaining: yolo.remaining,
        consecutive: yoloLoadLimiter.consecutiveTransientNow(),
        backoffMs: backoff && backoff.delayMs
      });
      try {
        // trigger is carried in the terminal meta (not just at startRun)
        // because progressService's fail()/succeed() REPLACE doc.meta
        // wholesale rather than merging — ingestStatusFeedService's
        // reconcile-trigger guard (config/defaults.env's
        // INGEST_STATUS_SLACK_KINDS comment) reads doc.meta.trigger off
        // whatever the doc looks like AT FLUSH TIME, which can be after
        // this terminal write.
        await run.fail(new Error('failed: yolo-circuit-open'), {
          phases,
          status: 'failed',
          reason: 'yolo-circuit-open',
          trigger
        });
      } catch (err) {
        console.warn(`${LOG}[brand=${brandId}] OperationRun close failed: ${err.message}`);
      }
      return {
        status: 'failed',
        reason: 'yolo-circuit-open',
        phases,
        runId: String(run.id || run._id || '')
      };
    }
    phases.yoloDetect = 'ok';
    run.tick(2, 2, 'yolo-detect ok');
    try { await backoffAfterSuccess(brandId); } catch (err) {
      console.warn(`${LOG}[brand=${brandId}] backoff clear failed: ${err.message}`);
    }
  } catch (err) {
    phases.yoloDetect = `failed: ${err.message?.slice(0, 200) || 'unknown'}`;
    failures++;
    console.warn(`${LOG}[brand=${brandId}] yolo-detect phase failed: ${err.message}`);
  }

  const status = failures === 0 ? 'ok' : (failures === 2 ? 'failed' : 'partial');
  try {
    if (status === 'ok') {
      // trigger carried through (see the circuit-open branch's comment
      // above) so ingestStatusFeedService's reconcile-trigger guard can
      // still see it after this terminal write.
      await run.succeed({ phases, trigger });
    } else {
      // Marking as failed with the phase map lets the reconcile tick
      // surface WHICH phase to focus on (or whether both need retry).
      // Not throwing — the fail() call is the persistent signal.
      alertPostSyncOutcome({ brandId, status, phases, trigger });
      await run.fail(new Error(`${status}: ${JSON.stringify(phases)}`), { phases, status, trigger });
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
  // detect queue to drain. Phase 2 can run for hours; liveness is
  // heartbeatAt + in-process registry, not phase ticks. Extending
  // phase 2's total from 2→3 and holding the OperationRun open through
  // the poll is the wrong liveness signal. Rematch has its own failure
  // logging and no retry — a one-shot post-catalog rematch is the
  // semantic, and a re-fire would only happen on the next catalog
  // sync of this brand.
  //
  // full=<POST_DETECT_DEFER_TO_CATALOG>: deferred design skipped the
  // per-post detect at ingest, so nothing is matched yet and we need to
  // enqueue every UGC media (full=true). Legacy immediate-detect mode
  // already matched at ingest, so rematch only touches UNMATCHED posts
  // (full=false) — avoids paying twice for the same vision-match.
  if (phases.yoloDetect === 'ok' && Object.keys(_testOverrides).length === 0) {
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
 * Start at most POST_SYNC_MAX_INFLIGHT_CHAINS chains while this process
 * already holds fewer than that many in-flight (sync OR reconcile —
 * conservative: a sync-triggered chain blocks reconcile from starting
 * another brand). stats.started caps new starts this tick;
 * inFlightBrands.size counts every live holder in this process, not
 * only ones this tick started.
 * Stops the rest of the tick if a chain aborts with yolo-circuit-open
 * (process-wide circuit is open; more brands would only burn cooldown).
 */
async function reconcileSelectedBrands(targets, { runChain, maxNew = MAX_INFLIGHT_CHAINS } = {}) {
  const run = runChain || ((id) => runPostSyncChain(id, { trigger: 'reconcile' }));
  const stats = {
    scanned: targets.length,
    started: 0,
    skippedInFlight: 0,
    skippedBackoff: 0,
    reconciled: 0,
    skipped: 0
  };
  for (const bid of targets) {
    const id = String(bid);
    if (inFlightBrands.has(id)) {
      stats.skippedInFlight++;
      continue;
    }
    if (inFlightBrands.size >= maxNew || stats.started >= maxNew) break;
    const r = await run(id);
    stats.started++;
    if (r.status === 'ok' || r.status === 'partial') stats.reconciled++;
    else stats.skipped++;
    // circuit-open-stops-tick (F2)
    if (r.status === 'failed' && r.reason === 'yolo-circuit-open') break;
  }
  return stats;
}

/**
 * Sweep Brands with catalog products where the post-sync chain hasn't
 * fully landed. This is the RECONCILE side — called from worker.js on
 * an interval so a transient outage doesn't strand a brand.
 *
 * TWO signals of incomplete state, ANY of which triggers a re-fire:
 *   (a) The LATEST `catalog-post-sync` OperationRun per brand is
 *       `failed`, or `running` with heartbeatAt older than the shared
 *       STALE_HEARTBEAT_MS. Unbounded `{status:'failed'}` (any failed
 *       ever) is what stacked overlapping chains.
 *   (b) NO recent `catalog-post-sync` run at all for a brand that has
 *       CatalogProducts with imageUrl but null imageMediaId. This
 *       catches brands whose sync fired BEFORE this orchestrator
 *       shipped — they never had a run written.
 *
 * Skips in-process registry, live heartbeatAt rows, and Brand backoff.
 * BATCH is a SCAN bound; POST_SYNC_MAX_INFLIGHT_CHAINS (default 1) is
 * the start bound.
 *
 * @param {object} opts
 * @param {number} [opts.batchSize]  — max brands to scan in one call
 * @param {number} [opts.staleMinutes]  — how long a running run must
 *   sit with a stale heartbeat before it's a retry target
 * @returns {Promise<object>}
 */
async function sweepIncompleteBrands({ batchSize = 5, staleMinutes = 30 } = {}) {
  const now = Date.now();
  const staleMs = Math.max(STALE_HEARTBEAT_MS, staleMinutes * 60 * 1000);
  const latestRuns = [];

  let liveBrandIds = [];
  try {
    const distinctLive = _testOverrides.distinctLiveBrandIds
      || ((q) => OperationRun.distinct('brandId', q));
    liveBrandIds = (await distinctLive({
      kind: { $in: LIVE_KINDS },
      status: 'running',
      heartbeatAt: { $gt: new Date(now - STALE_HEARTBEAT_MS) }
    })).filter(Boolean).map(String);
  } catch (err) {
    console.warn(`${LOG} sweep live-heartbeat query failed: ${err.message}`);
  }

  // Signal (a) — latest catalog-post-sync per brand.
  try {
    const aggregateLatest = _testOverrides.aggregateLatestRuns
      || ((pipeline, opts) => OperationRun.aggregate(pipeline, opts));
    const latest = await aggregateLatest([
      { $match: { kind: 'catalog-post-sync', brandId: { $ne: null } } },
      { $sort: { updatedAt: -1 } },
      { $group: {
        _id: '$brandId',
        lastStatus: { $first: '$status' },
        lastHeartbeatAt: { $first: '$heartbeatAt' },
        lastEndedAt: { $first: '$endedAt' },
        lastId: { $first: '$_id' },
        lastUpdatedAt: { $first: '$updatedAt' }
      } }
    ], { allowDiskUse: true });
    for (const r of latest) {
      latestRuns.push({
        brandId: r._id || r.brandId,
        lastStatus: r.lastStatus,
        lastHeartbeatAt: r.lastHeartbeatAt,
        lastEndedAt: r.lastEndedAt,
        lastId: r.lastId
      });
    }
  } catch (err) {
    console.warn(`${LOG} sweep signal-a failed: ${err.message}`);
    alerts.notifyAsync({
      level: 'error',
      title: 'Post-sync reconcile latest-run query failed',
      key: 'post-sync:sweep-aggregate-failed',
      fields: { error: String(err.message || err).slice(0, 200) },
      detail: 'Reconcile signal (a) could not load latest catalog-post-sync runs. YOLO-failed brands may be skipped this tick — not the same as “nothing to do”.'
    });
  }

  // Signal (b) — brands with CatalogProducts needing materialize AND
  // no successful/live post-sync run. Cheap distinct, bounded.
  if (latestRuns.length < batchSize * 4) {
    try {
      const distinctPending = _testOverrides.distinctPendingBrandIds
        || ((q) => CatalogProduct.distinct('brandId', q));
      const pendingBrandIds = await distinctPending({
        imageUrl: { $nin: [null, ''] },
        imageMediaId: null,
        deletedAt: null
      });
      const have = new Set(latestRuns.map((r) => String(r.brandId)));
      for (const bid of pendingBrandIds) {
        const id = String(bid);
        if (have.has(id)) continue;
        latestRuns.push({ brandId: id, lastStatus: 'none' });
        have.add(id);
      }
    } catch (err) {
      console.warn(`${LOG} sweep signal-b failed: ${err.message}`);
    }
  }

  const candidateIds = latestRuns.map((r) => r.brandId).filter(Boolean);
  const backoffUntil = {};
  const chainHeartbeatAt = {};
  if (candidateIds.length) {
    try {
      const loadBrands = _testOverrides.loadBrandState
        || ((ids) => Brand.find({ _id: { $in: ids } })
          .select('catalogYoloBackoffUntil catalogPostSyncHeartbeatAt')
          .lean());
      const rows = await loadBrands(candidateIds);
      for (const b of rows) {
        const bid = String(b._id || b.brandId);
        if (b.catalogYoloBackoffUntil) backoffUntil[bid] = b.catalogYoloBackoffUntil;
        if (b.catalogPostSyncHeartbeatAt) chainHeartbeatAt[bid] = b.catalogPostSyncHeartbeatAt;
      }
    } catch (err) {
      console.warn(`${LOG} sweep backoff load failed: ${err.message}`);
    }
  }

  const filtered = filterSweepCandidates({
    latestRuns,
    liveBrandIds,
    inFlight: inFlightBrands,
    backoffUntil,
    chainHeartbeatAt,
    now,
    staleMs,
    chainStaleMs: CHAIN_HEARTBEAT_STALE_MS
  });
  const skippedBackoff = filtered.length === 0 && Object.keys(backoffUntil).length
    ? candidateIds.filter((id) => backoffUntil[String(id)] && backoffUntil[String(id)] > now).length
    : 0;
  const targets = filtered.slice(0, batchSize);
  if (!targets.length) {
    return {
      scanned: 0, reconciled: 0, skipped: 0, started: 0,
      skippedInFlight: 0, skippedBackoff,
      inFlightChains: inFlightBrands.size
    };
  }

  console.log(`${LOG} reconcile sweep: ${targets.length} brand(s) — ${targets.join(', ')}`);
  const stats = await reconcileSelectedBrands(targets, {
    runChain: _testOverrides.runChain
  });
  stats.skippedBackoff = skippedBackoff;
  stats.inFlightChains = inFlightBrands.size;
  console.log(`${LOG} reconcile sweep done: reconciled=${stats.reconciled} skipped=${stats.skipped} started=${stats.started}`);
  return stats;
}

function inFlightCount() {
  return inFlightBrands.size;
}

module.exports = {
  runPostSyncChain,
  sweepIncompleteBrands,
  filterSweepCandidates,
  reconcileSelectedBrands,
  nextBackoffMs,
  backoffAfterSuccess,
  backoffAfterSuccessUpdate,
  backoffOnAbortUpdate,
  applyBackoff,
  inFlightCount,
  MAX_INFLIGHT_CHAINS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  CHAIN_HEARTBEAT_STALE_MS,
  CHAIN_HEARTBEAT_STALE_MIN,
  isChainHeartbeatFresh,
  claimChainHeartbeat,
  touchChainHeartbeat,
  clearChainHeartbeat,
  __test: {
    LOG,
    inFlightBrands,
    resetInFlight() { inFlightBrands.clear(); },
    setOverrides(o) { _testOverrides = o || {}; },
    getOverrides() { return _testOverrides; }
  }
};
