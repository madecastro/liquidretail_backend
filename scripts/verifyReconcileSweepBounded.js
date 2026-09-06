#!/usr/bin/env node
'use strict';
//
// verifyReconcileSweepBounded — pins the post-sync reconcile runaway fix.
// Offline: no Mongo, no HTTP, no keys. Requires production modules
// (housekeepingTickGuard, yoloLoadLimiter, catalogPostSyncOrchestrator,
// catalogYoloDetectionService, yoloService). Does NOT require worker.js
// (that connects Mongo / starts intervals) — worker wiring is source-scanned.
//
// ── THE DEFECT ────────────────────────────────────────────────────────────
// worker.js postSyncReconcileTick had no re-entrancy guard, so a tick whose
// sweepIncompleteBrands was still awaiting a hours-long YOLO phase did not
// stop the next 30-minute interval from firing. Each tick selected the same
// brand because signal (a) treated ANY catalog-post-sync status:'failed' as
// a retry with no time bound and no live-chain skip. Each re-fire started a
// new processQueue at CATALOG_YOLO_CONCURRENCY=6, so N overlapping chains
// → 6N concurrent /detect-batch calls. detectYoloForOne never threw, so a
// 0% outage was ground to completion; transients did not stamp yoloDetectedAt,
// so the gap never closed.
//
// ── REVERT-PROVE (each mutation must fail the NAMED check) ────────────────
//    A1  delete `if (inFlight) return` in housekeepingTickGuard
//          → A1 fails
//    A2  remove the reconcile createTickGuard wrap in worker.js
//          → A2 fails
//    B1  delete `if (inFlightBrands.has)` in runPostSyncChain
//          → B1 fails
//    B2  treat any status:'failed' as selected (today's query)
//          → B2 fails
//    B3  restore unbounded failed find (ignore newer succeeded)
//          → B3 fails
//    C1  give each queue its own inflight < CONCURRENCY and no acquire()
//          → C1 fails
//    C2  backfill calls detect without acquire
//          → C2 fails
//    D1  keep going after N transients (today's catch-and-continue)
//          → D1 fails
//    D2  phases.yoloDetect='ok' on any non-throw
//          → D2 fails
//    D3  only ECONNRESET counts as breaker-transient
//          → D3 fails
//    D4  missing consecutive reset on success
//          → D4 fails
//    E1  linear or uncapped backoff
//          → E1 fails
//    E2  ignore Brand backoffUntil in filterSweepCandidates
//          → E2 fails
//    E3  leave until set on success (backoffAfterSuccessUpdate)
//          → E3 fails
//    F1  start all 5 failed brands this tick
//          → F1 fails
//    F2  continue the for after circuit-open
//          → F2 fails
//    G1  keep `for attempt <= YOLO_RETRY_ATTEMPTS` for timeout
//          → G1 fails
//    G2  restore detectBatch timeout * ceil(n/2)
//          → G2 fails
//    H1  add Brand backoff fields only in comments
//          → H1 fails
//    H2  CATALOG_YOLO_MAX_PER_RUN default 500
//          → H2 fails
//    H3  production files require adArchiveDigest / spendReceipt / atlasVideoService
//          → H3 fails
//    I1  needsYoloDetection ignores yoloDetectedAt (re-targets legit-empty)
//          → I1 fails
//
//   node scripts/verifyReconcileSweepBounded.js

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

let pass = 0;
const failures = [];
function check(id, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id}`); }
  else {
    const msg = detail ? `${id} — ${detail}` : id;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

const { createTickGuard } = require('../services/housekeepingTickGuard');
const limiter = require('../services/yoloLoadLimiter');
const orch = require('../services/catalogPostSyncOrchestrator');
const detection = require('../services/catalogYoloDetectionService');
const yoloService = require('../services/yoloService');
const Brand = require('../models/Brand');

function resetAll() {
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });
  orch.__test.resetInFlight();
  orch.__test.setOverrides({});
  detection.__test.reset();
  yoloService.__test.setDetectBatchPost(null);
}

resetAll();

const workerSrc = read('worker.js');
{
  const tickBlock = workerSrc.match(
    /const postSyncGuard = createTickGuard\(\s*['"]post-sync-reconcile['"]\s*\);[\s\S]*?setInterval\(postSyncReconcileTick/
  );
  check('A2 worker wiring — post-sync-reconcile guard',
    tickBlock
      && /postSyncGuard\(\s*async\s*\(\)\s*=>/.test(tickBlock[0])
      && /sweepIncompleteBrands\(/.test(tickBlock[0]),
    'postSyncReconcileTick must invoke the guard around a function that calls sweepIncompleteBrands');
}
check('A2b worker wiring — yolo-backfill guard',
  /createTickGuard\(\s*['"]yolo-backfill['"]\s*\)/.test(workerSrc)
    && /yoloBackfillTick/.test(workerSrc),
  'yoloBackfillTick must be wrapped in createTickGuard(\'yolo-backfill\')');
{
  const reapInterval = workerSrc.match(/setInterval\(\(\)\s*=>\s*\{[\s\S]{0,400}?REAP_INTERVAL_MIN/);
  check('A2c reapOrphans interval does NOT use this guard (R10)',
    reapInterval && !/createTickGuard/.test(reapInterval[0])
      && /reapOrphans/.test(reapInterval[0]),
    'recoverTick/reapOrphans must stay unguarded — a skip-if-running guard could delay orphan requeue');
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\nB. in-process skip + sweep predicate');
// ══════════════════════════════════════════════════════════════════════════

(async () => {
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nA. tick re-entrancy');
  // ══════════════════════════════════════════════════════════════════════════
  {
    const guard = createTickGuard('harness-tick');
    let invocations = 0;
    let release;
    const hang = new Promise((r) => { release = r; });
    const p1 = guard(async () => { invocations++; await hang; return { ok: true }; });
    await delay(10);
    const r2 = await guard(async () => { invocations++; return { ok: 'second' }; });
    check('A1 tick re-entrancy',
      r2 && r2.skipped === true && r2.reason === 'reentrant' && invocations === 1,
      `second call must skip without invoking fn (invocations=${invocations} r2=${JSON.stringify(r2)})`);
    release();
    await p1;
  }

  resetAll();
  let materializeCalls = 0;
  let releaseHang;
  const hang = new Promise((r) => { releaseHang = r; });
  orch.__test.setOverrides({
    findBrand: async () => ({ advertiserId: 'adv' }),
    startRun: async () => ({
      tick() {},
      succeed: async () => {},
      fail: async () => {},
      id: 'run-b1'
    }),
    materialize: async () => { materializeCalls++; await hang; },
    yolo: async () => ({ ok: true }),
    applyBackoff: async () => ({ failures: 1, delayMs: 1800000 }),
    backoffAfterSuccess: async () => {},
    claimChainHeartbeat: async () => true,
    touchChainHeartbeat: async () => {},
    clearChainHeartbeat: async () => {}
  });
  const p1 = orch.runPostSyncChain('brand-b1');
  await delay(30);
  const r2 = await Promise.race([
    orch.runPostSyncChain('brand-b1'),
    delay(80).then(() => ({ status: 'timeout', reason: 'hung' }))
  ]);
  const orchSrc = read('services/catalogPostSyncOrchestrator.js');
  const b1fn = (orchSrc.match(/async function runPostSyncChain[\s\S]*?async function runPostSyncChainUnlocked/) || [''])[0];
  check('B1 in-process skip',
    r2.reason === 'in-flight' && r2.status === 'skipped' && materializeCalls === 1
      && /in-process-registry-skip \(B1\)/.test(b1fn)
      && /inFlightBrands\.has\(id\)/.test(b1fn)
      && /reason:\s*'in-flight'/.test(b1fn),
    `second concurrent chain must return reason:in-flight (got ${JSON.stringify(r2)} calls=${materializeCalls})`);
  releaseHang();
  await p1;
  orch.__test.setOverrides({});
  orch.__test.resetInFlight();

  const now = Date.now();
  const staleMs = 2 * 60 * 1000;
  const fresh = now - 10_000;
  const old = now - 10 * 60 * 1000;

  const b2fresh = orch.filterSweepCandidates({
    latestRuns: [{ brandId: 'live', lastStatus: 'running', lastHeartbeatAt: fresh }],
    liveBrandIds: [],
    inFlight: [],
    backoffUntil: {},
    now, staleMs
  });
  const b2stale = orch.filterSweepCandidates({
    latestRuns: [{ brandId: 'dead', lastStatus: 'running', lastHeartbeatAt: old }],
    liveBrandIds: [],
    inFlight: [],
    backoffUntil: {},
    now, staleMs
  });
  const b2failedLive = orch.filterSweepCandidates({
    latestRuns: [{ brandId: 'sib', lastStatus: 'failed' }],
    liveBrandIds: ['sib'],
    inFlight: [],
    backoffUntil: {},
    now, staleMs
  });
  const b2failedSolo = orch.filterSweepCandidates({
    latestRuns: [{ brandId: 'solo', lastStatus: 'failed' }],
    liveBrandIds: [],
    inFlight: [],
    backoffUntil: {},
    now, staleMs
  });
  check('B2 sweep skips live heartbeat',
    b2fresh.length === 0
      && b2stale.length === 1 && b2stale[0] === 'dead'
      && b2failedLive.length === 0
      && b2failedSolo.length === 1 && b2failedSolo[0] === 'solo',
    `fresh=${JSON.stringify(b2fresh)} stale=${JSON.stringify(b2stale)} failedLive=${JSON.stringify(b2failedLive)} failedSolo=${JSON.stringify(b2failedSolo)}`);

  const b3 = orch.filterSweepCandidates({
    latestRuns: [{ brandId: 'healed', lastStatus: 'succeeded' }],
    liveBrandIds: [],
    inFlight: [],
    backoffUntil: {},
    now, staleMs
  });
  check('B3 signal (a) is latest-run (newer succeeded is not selected)',
    b3.length === 0,
    `a brand whose LATEST run succeeded must not be selected (got ${JSON.stringify(b3)})`);

  const sweepSrc = read('services/catalogPostSyncOrchestrator.js');
  const sweepFn = (sweepSrc.match(/async function sweepIncompleteBrands[\s\S]*?function inFlightCount/) || [''])[0];
  check('B2s sweepIncompleteBrands calls filterSweepCandidates',
    /filterSweepCandidates\(/.test(sweepFn) && /allowDiskUse:\s*true/.test(sweepFn),
    'production sweep must call the helper and pass allowDiskUse:true');

  resetAll();
  const sweepStarted = [];
  orch.__test.setOverrides({
    aggregateLatestRuns: async () => [
      { _id: 'healed', lastStatus: 'succeeded', lastHeartbeatAt: new Date() },
      { _id: 'needs', lastStatus: 'failed', lastHeartbeatAt: new Date(0) }
    ],
    distinctLiveBrandIds: async () => [],
    distinctPendingBrandIds: async () => [],
    loadBrandState: async () => [],
    runChain: async (id) => { sweepStarted.push(id); return { status: 'ok' }; }
  });
  await orch.sweepIncompleteBrands({ batchSize: 5, staleMinutes: 30 });
  check('B3s sweepIncompleteBrands itself skips a newer-succeeded brand',
    !sweepStarted.includes('healed') && sweepStarted.includes('needs'),
    `started ${sweepStarted.join(', ') || '(none)'} — healed must not start`);
  orch.__test.setOverrides({});

  resetAll();
  const liveStarted = [];
  orch.__test.setOverrides({
    aggregateLatestRuns: async () => [
      { _id: 'sib', lastStatus: 'failed', lastHeartbeatAt: new Date() }
    ],
    distinctLiveBrandIds: async () => ['sib'],
    distinctPendingBrandIds: async () => [],
    loadBrandState: async () => [],
    runChain: async (id) => { liveStarted.push(id); return { status: 'ok' }; }
  });
  await orch.sweepIncompleteBrands({ batchSize: 5, staleMinutes: 30 });
  check('B2b sweepIncompleteBrands skips failed latest with a live sibling',
    liveStarted.length === 0,
    `started ${liveStarted.join(', ') || '(none)'}`);
  orch.__test.setOverrides({});

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nC. shared limiter');
  // ══════════════════════════════════════════════════════════════════════════

  resetAll();
  limiter.__test.reset({ limit: 2, threshold: 50, cooldownMs: 1_800_000 });
  let current = 0;
  let maxConcurrent = 0;
  const slowWorker = async () => {
    current++;
    maxConcurrent = Math.max(maxConcurrent, current);
    await delay(60);
    current--;
    return { failed: 0, transient: false };
  };
  const products = Array.from({ length: 10 }, (_, i) => ({ _id: `p${i}` }));
  await Promise.all([
    detection.processQueue(products, { worker: slowWorker }),
    detection.processQueue(products, { worker: slowWorker })
  ]);
  check('C1 shared limiter (two queues, LIMIT=2)',
    maxConcurrent <= 2,
    `max concurrent workers must be <= limiter LIMIT (got ${maxConcurrent})`);

  const backfillRegion = workerSrc.slice(
    workerSrc.indexOf('yoloBackfillTick'),
    workerSrc.indexOf('setTimeout(yoloBackfillTick')
  );
  check('C2 backfill shares limiter (acquire in tick)',
    /yoloLoadLimiter\.acquire\(\)/.test(backfillRegion)
      && /yoloLoadLimiter\.isOpen\(\)/.test(backfillRegion),
    'yoloBackfillTick must acquire() per Media and skip the tick when the circuit is open');

  resetAll();
  limiter.__test.reset({ limit: 1, threshold: 50, cooldownMs: 1_800_000 });
  await limiter.acquire();
  let acquiredSecond = false;
  const waiting = limiter.acquire().then(() => { acquiredSecond = true; });
  await delay(40);
  const waited = acquiredSecond === false;
  limiter.release();
  await waiting;
  check('C2b acquire waits when occupancy is at LIMIT',
    waited && acquiredSecond === true,
    `second acquire must block until release (waited=${waited} acquiredSecond=${acquiredSecond})`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nD. breaker');
  // ══════════════════════════════════════════════════════════════════════════

  resetAll();
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });
  const failCalls = [];
  const succeedCalls = [];
  detection.__test.setStartRun(async () => ({
    tick() {},
    checkpoint: async () => {},
    succeed: async (m) => { succeedCalls.push(m); },
    fail: async (err, meta) => { failCalls.push({ message: err && err.message, meta }); },
    markCancelled() {},
    id: 'yolo-run'
  }));
  const d1targets = Array.from({ length: 10 }, (_, i) => ({ _id: `t${i}` }));
  const d1 = await detection.runYoloDetectionOnTargets(d1targets, {
    brandId: 'brand-d1',
    worker: async () => ({ failed: 3, transient: true, yoloKind: 'client-timeout' })
  });
  check('D1 breaker opens and runYoloDetection returns yolo-circuit-open',
    d1.ok === false && d1.reason === 'yolo-circuit-open' && limiter.isOpen() === true,
    `got ${JSON.stringify(d1)} isOpen=${limiter.isOpen()}`);
  check('D1b aborted skips are not counted as detected',
    typeof d1.detected === 'number' && typeof d1.remaining === 'number'
      && d1.detected + d1.remaining === d1targets.length
      && d1.detected < d1targets.length,
    `detected=${d1.detected} remaining=${d1.remaining} total=${d1targets.length}`);

  resetAll();
  const d2fail = [];
  const d2ok = [];
  orch.__test.setOverrides({
    findBrand: async () => ({ advertiserId: 'adv' }),
    startRun: async () => ({
      tick() {},
      succeed: async (m) => { d2ok.push(m); },
      fail: async (err, meta) => { d2fail.push({ message: err && err.message, meta }); },
      id: 'parent'
    }),
    materialize: async () => {},
    yolo: async () => ({ ok: false, reason: 'yolo-circuit-open', remaining: 8274 }),
    applyBackoff: async () => ({ failures: 1, delayMs: 1_800_000 }),
    backoffAfterSuccess: async () => {},
    claimChainHeartbeat: async () => true,
    touchChainHeartbeat: async () => {},
    clearChainHeartbeat: async () => {}
  });
  const d2 = await orch.runPostSyncChain('brand-d2');
  check('D2 parent fail reason yolo-circuit-open (succeed not called)',
    d2.status === 'failed'
      && d2.reason === 'yolo-circuit-open'
      && d2fail.length >= 1
      && d2fail.some((c) => c.meta && c.meta.reason === 'yolo-circuit-open')
      && d2ok.length === 0,
    `status=${d2.status} reason=${d2.reason} fail=${JSON.stringify(d2fail)} succeed=${d2ok.length}`);
  orch.__test.setOverrides({});
  orch.__test.resetInFlight();

  check('D3 5xx trips breaker (http-503 is transient)',
    detection.classifyDetectFailure({ yoloKind: 'http-503' }).transient === true
      && limiter.isTransientForBreaker('http-503') === true
      && limiter.isTransientForBreaker('conn-reset') === true
      && limiter.isTransientForBreaker('unidentified-image') === false,
    'http-503 must count as transient for the breaker even though isTransientYoloError is conn-only');
  check('D3b econnrefused/enotfound are breaker-transient; unknown is not',
    limiter.isTransientForBreaker('econnrefused') === true
      && limiter.isTransientForBreaker('enotfound') === true
      && limiter.isTransientForBreaker('unknown') === false,
    'setup-down kinds must trip the breaker; unknown must not');

  resetAll();
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });
  limiter.recordOutcome({ transient: true });
  limiter.recordOutcome({ transient: true });
  limiter.recordOutcome({ transient: true });
  check('D4a three transients do not open (threshold 5)',
    limiter.consecutiveTransientNow() === 3 && limiter.isOpen() === false,
    `consecutive=${limiter.consecutiveTransientNow()} open=${limiter.isOpen()}`);
  limiter.recordOutcome({ transient: false });
  check('D4 success resets consecutive, circuit stays closed',
    limiter.consecutiveTransientNow() === 0 && limiter.isOpen() === false,
    `consecutive=${limiter.consecutiveTransientNow()} open=${limiter.isOpen()}`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nE. per-brand backoff');
  // ══════════════════════════════════════════════════════════════════════════

  const expectedBackoff = [1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000, 28_800_000];
  const gotBackoff = [1, 2, 3, 4, 5, 6].map((n) => orch.nextBackoffMs(n));
  check('E1 backoff grows 30m, 1h, 2h, 4h, 8h, 8h',
    expectedBackoff.every((v, i) => v === gotBackoff[i]),
    `got ${gotBackoff.join(', ')}`);

  const nowE = Date.now();
  const e2 = orch.filterSweepCandidates({
    latestRuns: [{ brandId: 'backed', lastStatus: 'failed' }],
    liveBrandIds: [],
    inFlight: [],
    backoffUntil: { backed: nowE + 60_000 },
    now: nowE,
    staleMs: 2 * 60 * 1000
  });
  check('E2 sweep honors backoffUntil',
    e2.length === 0,
    `backoffUntil > now must skip even if latest failed (got ${JSON.stringify(e2)})`);

  const successUpdate = orch.backoffAfterSuccessUpdate();
  check('E3 success clears backoff',
    successUpdate.$set.catalogYoloBackoffUntil === null
      && successUpdate.$set.catalogYoloBackoffFailures === 0
      && successUpdate.$set.catalogYoloBackoffReason === null,
    `got ${JSON.stringify(successUpdate)}`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nF. one-at-a-time + circuit stops the tick');
  // ══════════════════════════════════════════════════════════════════════════

  resetAll();
  const f1calls = [];
  const f1 = await orch.reconcileSelectedBrands(['a', 'b', 'c', 'd', 'e'], {
    runChain: async (id) => { f1calls.push(id); return { status: 'failed' }; }
  });
  check('F1 boot one-at-a-time (MAX_INFLIGHT_CHAINS=1 starts 1 of 5)',
    f1calls.length === 1 && f1.started === 1 && orch.MAX_INFLIGHT_CHAINS === 1,
    `started ${f1calls.length} chains: ${f1calls.join(', ')} MAX=${orch.MAX_INFLIGHT_CHAINS}`);

  resetAll();
  const f2calls = [];
  const f2 = await orch.reconcileSelectedBrands(['x', 'y', 'z'], {
    maxNew: 5,
    runChain: async (id) => {
      f2calls.push(id);
      if (id === 'x') return { status: 'failed', reason: 'yolo-circuit-open' };
      return { status: 'ok' };
    }
  });
  check('F2 circuit stops rest of tick',
    f2calls.length === 1 && f2calls[0] === 'x' && f2.started === 1
      && /circuit-open-stops-tick \(F2\)/.test(read('services/catalogPostSyncOrchestrator.js')),
    `must not start remaining brands after circuit-open even when maxNew>1 (calls=${f2calls.join(', ')})`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nG. batch timeout vs retry');
  // ══════════════════════════════════════════════════════════════════════════

  resetAll();
  let batchCalls = 0;
  yoloService.__test.setDetectBatchPost(async () => {
    batchCalls++;
    const err = new Error('timeout of 120000ms exceeded');
    err.code = 'ECONNABORTED';
    throw err;
  });
  let g1threw = false;
  let g1kind = null;
  try {
    await yoloService.detectBatch([{ buffer: Buffer.from('x') }]);
  } catch (err) {
    g1threw = true;
    g1kind = err.yoloKind;
  }
  check('G1 no batch timeout retry (ECONNABORTED call count === 1)',
    g1threw && batchCalls === 1 && g1kind === 'client-timeout',
    `calls=${batchCalls} threw=${g1threw} kind=${g1kind}`);
  yoloService.__test.setDetectBatchPost(null);

  const yoloSrc = read('services/yoloService.js');
  const batchFn = yoloSrc.slice(yoloSrc.indexOf('async function detectBatch'), yoloSrc.indexOf('async function detectFromVideo') > yoloSrc.indexOf('async function detectBatch')
    ? yoloSrc.indexOf('const YOLO_RETRY_ATTEMPTS')
    : yoloSrc.length);
  check('G2 batch timeout cap is YOLO_TIMEOUT_MS (no ceil(n/2) multiplier)',
    /timeout:\s*YOLO_TIMEOUT_MS/.test(batchFn)
      && !/Math\.ceil\(\s*list\.length\s*\/\s*2\s*\)/.test(batchFn)
      && !/YOLO_TIMEOUT_MS\s*\*\s*Math\.ceil/.test(batchFn),
    'detectBatch axios timeout must be YOLO_TIMEOUT_MS, not scaled by batch size');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nH. schema + defaults + blast radius');
  // ══════════════════════════════════════════════════════════════════════════

  const untilPath = Brand.schema.path('catalogYoloBackoffUntil');
  const failPath = Brand.schema.path('catalogYoloBackoffFailures');
  const reasonPath = Brand.schema.path('catalogYoloBackoffReason');
  const hbPath = Brand.schema.path('catalogPostSyncHeartbeatAt');
  check('H1 Brand paths declared',
    untilPath && untilPath.instance === 'Date'
      && failPath && failPath.instance === 'Number'
      && reasonPath && reasonPath.instance === 'String'
      && hbPath && hbPath.instance === 'Date'
      && Brand.schema.options.strict !== false,
    'catalogYoloBackoffUntil/Failures/Reason and catalogPostSyncHeartbeatAt must be declared on the strict Brand schema');

  const at = new Date('2026-09-06T00:00:00Z');
  const doc = new Brand({
    name: 'harness-brand',
    catalogYoloBackoffUntil: at,
    catalogYoloBackoffFailures: 2,
    catalogYoloBackoffReason: 'yolo-circuit-open',
    catalogYoloBackoffUndeclared: at
  });
  check('H1b undeclared sibling is dropped (strict)',
    doc.catalogYoloBackoffUntil && doc.catalogYoloBackoffUntil.getTime() === at.getTime()
      && doc.catalogYoloBackoffUndeclared === undefined,
    'sanity: strict drops undeclared paths — that is why H1 is load-bearing');

  const envSrc = read('config/defaults.env');
  const envHas = (k, v) => envSrc.split('\n').some((line) => line.trim() === `${k}=${v}`);
  check('H2 defaults.env = code (new keys + MAX_PER_RUN still 0)',
    envHas('POST_SYNC_MAX_INFLIGHT_CHAINS', '1')
      && envHas('CATALOG_YOLO_BREAKER_THRESHOLD', '5')
      && envHas('CATALOG_YOLO_BREAKER_COOLDOWN_MS', '1800000')
      && envHas('CATALOG_YOLO_BACKOFF_BASE_MS', '1800000')
      && envHas('CATALOG_YOLO_BACKOFF_CAP_MS', '28800000')
      && envHas('YOLO_TIMEOUT_MS', '120000')
      && envHas('YOLO_RETRY_ATTEMPTS', '1')
      && envHas('YOLO_RETRY_DELAY_MS', '1000')
      && envHas('POST_SYNC_CHAIN_HEARTBEAT_STALE_MIN', '15')
      && envHas('CATALOG_YOLO_MAX_PER_RUN', '0')
      && orch.MAX_INFLIGHT_CHAINS === 1
      && orch.CHAIN_HEARTBEAT_STALE_MIN === 15
      && limiter.threshold() === 5
      && yoloService.YOLO_TIMEOUT_MS === 120000
      && detection.parseMaxPerRun(0) === Infinity
      && detection.parseMaxPerRun(undefined) === Infinity,
    'file defaults must equal code defaults; CATALOG_YOLO_MAX_PER_RUN must stay 0/uncapped');

  // worker.js already required adArchiveDigest / spendReceipt before this
  // PR (R10 reaper — do not touch). H3 pins that THIS change did not pull
  // those money paths into the new/edited catalog-YOLO files.
  const h3Files = [
    'services/housekeepingTickGuard.js',
    'services/yoloLoadLimiter.js',
    'services/catalogPostSyncOrchestrator.js',
    'services/catalogYoloDetectionService.js',
    'services/yoloService.js',
    'models/Brand.js'
  ];
  const moneyRequires = [];
  for (const rel of h3Files) {
    const src = read(rel);
    if (/require\(['"][^'"]*adArchiveDigest/.test(src)) moneyRequires.push(`${rel}:adArchiveDigest`);
    if (/require\(['"][^'"]*spendReceipt/.test(src)) moneyRequires.push(`${rel}:spendReceipt`);
    if (/require\(['"][^'"]*atlasVideoService/.test(src)) moneyRequires.push(`${rel}:atlasVideoService`);
  }
  check('H3 no adgen/ / no money-path imports in this PR\'s production files',
    moneyRequires.length === 0
      && !fs.existsSync(path.join(ROOT, 'adgen', 'src', 'services', 'yoloLoadLimiter.js')),
    `unexpected money-path requires: ${moneyRequires.join(', ') || '(none)'}`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nJ. round-2 adversarial findings');
  // ══════════════════════════════════════════════════════════════════════════

  resetAll();
  const claimedAt = new Map();
  orch.__test.setOverrides({
    findBrand: async () => ({ advertiserId: 'adv' }),
    startRun: async () => ({
      tick() {},
      succeed: async () => {},
      fail: async () => {},
      id: 'j1'
    }),
    materialize: async () => { await new Promise((r) => setTimeout(r, 200)); },
    yolo: async () => ({ ok: true }),
    applyBackoff: async () => ({ failures: 1, delayMs: 1800000 }),
    backoffAfterSuccess: async () => {},
    claimChainHeartbeat: async (id) => {
      const prev = claimedAt.get(String(id));
      if (prev && Date.now() - prev < orch.CHAIN_HEARTBEAT_STALE_MS) return false;
      claimedAt.set(String(id), Date.now());
      return true;
    },
    touchChainHeartbeat: async () => {},
    clearChainHeartbeat: async () => {}
  });
  const j1hang = new Promise(() => {});
  orch.__test.setOverrides({
    ...orch.__test.getOverrides(),
    materialize: async () => { await j1hang; }
  });
  const j1p = orch.runPostSyncChain('cross-proc');
  await delay(30);
  orch.__test.resetInFlight();
  const j1b = await Promise.race([
    orch.runPostSyncChain('cross-proc'),
    delay(80).then(() => ({ status: 'timeout', reason: 'hung' }))
  ]);
  check('J1 cross-process double-start skipped via Brand heartbeat (chain-alive)',
    j1b.status === 'skipped' && j1b.reason === 'chain-alive',
    `empty inFlightBrands must still refuse a second start (got ${JSON.stringify(j1b)})`);
  orch.__test.setOverrides({});
  orch.__test.resetInFlight();

  const j2now = Date.now();
  const j2 = orch.filterSweepCandidates({
    latestRuns: [{ brandId: 'gymshark', lastStatus: 'failed' }],
    liveBrandIds: [],
    inFlight: [],
    backoffUntil: {},
    chainHeartbeatAt: { gymshark: j2now - 10_000 },
    now: j2now,
    staleMs: 2 * 60 * 1000,
    chainStaleMs: orch.CHAIN_HEARTBEAT_STALE_MS
  });
  const j2stale = orch.filterSweepCandidates({
    latestRuns: [{ brandId: 'dead-holder', lastStatus: 'failed' }],
    liveBrandIds: [],
    inFlight: [],
    backoffUntil: {},
    chainHeartbeatAt: { 'dead-holder': j2now - orch.CHAIN_HEARTBEAT_STALE_MS - 1000 },
    now: j2now,
    staleMs: 2 * 60 * 1000,
    chainStaleMs: orch.CHAIN_HEARTBEAT_STALE_MS
  });
  check('J2 failed OperationRun with fresh Brand heartbeat is skipped; stale heartbeat is retryable',
    j2.length === 0 && j2stale.length === 1 && j2stale[0] === 'dead-holder',
    `fresh=${JSON.stringify(j2)} stale=${JSON.stringify(j2stale)}`);

  resetAll();
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });
  const j3fail = [];
  const j3ok = [];
  detection.__test.setStartRun(async () => ({
    tick() {},
    checkpoint: async () => {},
    succeed: async (m) => { j3ok.push(m); },
    fail: async (err, meta) => { j3fail.push({ message: err && err.message, meta }); },
    markCancelled() {},
    id: 'j3'
  }));
  const j3 = await detection.runYoloDetectionOnTargets(
    Array.from({ length: 10 }, (_, i) => ({ _id: `j3${i}` })),
    {
      brandId: 'brand-j3',
      worker: async () => ({ failed: 3, transient: limiter.isTransientForBreaker('econnrefused'), yoloKind: 'econnrefused' })
    }
  );
  check('J3 econnrefused trips breaker and does NOT succeed',
    j3.ok === false && j3.reason === 'yolo-circuit-open' && limiter.isOpen() === true && j3ok.length === 0,
    `got ${JSON.stringify(j3)} succeed=${j3ok.length} fail=${j3fail.length}`);

  const orchJ = read('services/catalogPostSyncOrchestrator.js');
  check('J4 latest-run aggregate uses allowDiskUse and alerts on catch',
    /allowDiskUse:\s*true/.test(orchJ)
      && /post-sync:sweep-aggregate-failed/.test(orchJ),
    'signal (a) must not silently swallow a 100MB sort cap');

  resetAll();
  let callYoloPosts = 0;
  yoloService.__test.setCallYoloPost(async () => {
    callYoloPosts++;
    const err = new Error('timeout of 120000ms exceeded');
    err.code = 'ECONNABORTED';
    throw err;
  });
  let j5threw = false;
  let j5kind = null;
  try {
    await yoloService.detectMultipleProducts(Buffer.from('x'));
  } catch (err) {
    j5threw = true;
    j5kind = err.yoloKind;
  }
  check('J5 _callYolo /detect does not retry in-flight timeout',
    j5threw && callYoloPosts === 1 && j5kind === 'client-timeout'
      && /function isInFlightYoloKind/.test(read('services/yoloService.js'))
      && (read('services/yoloService.js').match(/isInFlightYoloKind\(/g) || []).length >= 3,
    `calls=${callYoloPosts} threw=${j5threw} kind=${j5kind}`);
  yoloService.__test.setCallYoloPost(null);

  const applyFn = (orchJ.match(/async function applyBackoff[\s\S]*?async function backoffAfterSuccess/) || [''])[0];
  check('J6 applyBackoff is a single atomic findOneAndUpdate (no findById increment)',
    /findOneAndUpdate/.test(applyFn)
      && /\$add/.test(applyFn)
      && !/findById/.test(applyFn),
    'lost-update read-modify-write must not remain');

  check('J8 first-wave log does not claim threshold is exact',
    /is a floor/.test(read('services/catalogYoloDetectionService.js'))
      && /first wave may run up to concurrency/.test(read('services/catalogYoloDetectionService.js')),
    'log must not imply consecutive count equals THRESHOLD exactly');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nI. gap predicate (legit-empty exclusion)');
  // ══════════════════════════════════════════════════════════════════════════

  check('I1 needsYoloDetection skips yoloDetectedAt-stamped empty refinedProducts',
    detection.needsYoloDetection({ refinedProducts: [], yoloDetectedAt: new Date() }) === false
      && detection.needsYoloDetection({ refinedProducts: [], yoloDetectedAt: null }) === true
      && detection.needsYoloDetection({ refinedProducts: [{ id: 1 }], yoloDetectedAt: null }) === false,
    'legit-empty (refinedProducts:[] + yoloDetectedAt set) must not be re-targeted');

  const detSrc = read('services/catalogYoloDetectionService.js');
  const onlyGapsRegion = detSrc.slice(
    detSrc.indexOf('if (onlyGaps)'),
    detSrc.indexOf('const targets = applyRunCap')
  );
  check('I2 onlyGaps distinct requires yoloDetectedAt: null',
    /yoloDetectedAt:\s*null/.test(onlyGapsRegion),
    'gap distinct must match yoloBackfillTick (yoloDetectedAt:null) so legit-empty is not re-queued');

  if (failures.length) {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, 0 failed`);
  process.exit(0);
})().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});
