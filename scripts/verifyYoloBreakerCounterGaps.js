#!/usr/bin/env node
'use strict';
//
// Revert-proof offline harness for two PRE-EXISTING bugs in
// yoloLoadLimiter.recordOutcome / catalogYoloDetectionService.detectYoloForOne
// + processQueue + runYoloDetectionOnTargets, fixed 2026-09-06. Both bugs
// reproduce identically on origin/main (they predate tonight's other three
// PRs in this same area — #403/#404/#406 — and are not caused by any of
// them).
//
// BUG 1 — a brand with fewer products than the breaker's THRESHOLD (env
// CATALOG_YOLO_BREAKER_THRESHOLD, default 5) could never self-trip the
// breaker, even at 100% failure. recordOutcome only opens the circuit on
// THRESHOLD CONSECUTIVE transient outcomes; a run with e.g. 4 targets, ALL
// of which fail transiently, tops out at consecutiveTransient=4 and never
// opens — so the run reports aborted:false, runYoloDetectionOnTargets
// returns {ok:true, ...}, and catalogPostSyncOrchestrator treats it as a
// clean success: clears any existing per-brand backoff
// (backoffAfterSuccess) and fires the paid post-detect rematch — on a run
// where every single product's detection failed.
//
// Fix: an ADDITIONAL, opt-in trip condition —
// yoloLoadLimiter.tripOnFullRunFailure({attempted, transientFailures}) —
// alongside (never replacing) the existing consecutive-count check.
// catalogYoloDetectionService.runYoloDetectionOnTargets wraps its worker,
// but ONLY for runs whose own target count is already below THRESHOLD
// (a run at or above THRESHOLD is left byte-for-byte on the existing,
// already three-rounds-reviewed path), tallies that run's own
// attempted/transient-failed outcomes, and calls the new function after
// every transient completion. Because the new function's only observable
// effect is making yoloLoadLimiter.isOpen() true, and processQueue's /
// runYoloDetectionOnTargets's EXISTING abortReason/aborted/cancelled
// determination logic already reacts correctly to isOpen() becoming true
// mid-run (see verifyCatalogYoloFalseAbort.js), this fix requires ZERO
// changes to that state machine — see sections C/D below, and the "no
// regression" sections E/F which re-run this repo's three existing
// yolo-breaker-adjacent harnesses' exact scenarios inline as a belt-and-
// suspenders check (the harnesses themselves are also run standalone,
// unmodified, as part of verification).
//
// BUG 2 — a no-op product (zero media to check, or all media already
// detected) reset the SHARED consecutive-failure counter, masking real
// failures on the SAME or a CONCURRENT chain. detectYoloForOne's noMedia
// and all-skipped returns carried no `transient` key, so in processQueue's
// `else if (result) { recordOutcome({transient:false}) }` branch they took
// the SAME path as a genuine clean success — resetting
// consecutiveTransient to 0, even though a no-op carries ZERO information
// about the microservice's health (nothing was even attempted).
//
// Fix: detectYoloForOne's two no-op returns now also carry `noop: true`;
// processQueue's branch condition is `else if (result && !result.noop)` so
// a no-op reaches NEITHER branch — it touches the breaker counter not at
// all. A genuine success (no `noop` key) is unaffected and still resets.
//
// Section [A]: Bug 2, single chain, alternating no-op/real-failure —
// reproduces the exact numbers this bug report cites ("20 targets
// alternating no-op/real-transient-failure, threshold=5 → counter never
// exceeds 1" pre-fix).
// Section [B]: Bug 2, CONCURRENT — two processQueue chains sharing the
// same process-wide yoloLoadLimiter module instance, one all-no-op
// ("healthy"), one 100%-transient-failing ("sick"), deterministically
// interleaved by fixed millisecond delays (not timing-dependent luck) so
// a no-op from the healthy chain lands between every pair of the sick
// chain's own failures.
// Section [C]: Bug 1, a run smaller than THRESHOLD at 100% transient
// failure now correctly aborts instead of reporting a false success.
// Section [D]: Bug 1 boundary/no-overreach checks — a run below
// MIN_RUN_SAMPLE stays unprotected (accepted, documented residual), a
// mixed-outcome small run does NOT trip (only 100% failure does), and a
// run at/above THRESHOLD is untouched (still relies solely on the
// existing consecutive-count mechanism).
//
// No DB, no network, no Mongo — pure in-process timing against the
// exposed yoloLoadLimiter.__test surface and detection.__test surface,
// matching the style of scripts/verifyCatalogYoloFalseAbort.js.

const path = require('path');

// Forces per-chain courtesy dispatch to serial (1 in flight at a time) so
// every scenario below is driven by fixed millisecond delays instead of
// racing against however many products a default concurrency would
// dispatch at once.
//
// ⚠️ CORRECTED 2026-09-07: this used to be done via the
// CATALOG_YOLO_CONCURRENCY env var alone (set below, BEFORE the service
// module is first required), back when processQueue()'s courtesy cap and
// yoloLoadLimiter's semaphore LIMIT were two independent knobs — so the env
// var could force the courtesy cap to 1 while each section's own
// `limiter.__test.reset({limit: 20/50/10, ...})` left the SEMAPHORE
// generously high, and the two never fought each other.
// catalogYoloDetectionService.js's fix #6 (2026-09-06, this same feature
// branch) deliberately UNIFIED both enforcement points onto the ONE shared
// `yoloLoadLimiter.getLimit()` accessor — so as of that fix, whatever
// `limit` a test pins via `__test.reset()` is now BOTH the semaphore AND
// the per-chain courtesy cap. Pinning a big number here (20/50/10) now lets
// the courtesy cap dispatch a WHOLE run's products in one synchronous
// burst, defeating the "force serial" intent this comment describes — the
// env var below no longer has that effect on its own. Every section now
// pins `limit: 1` instead, which correctly serializes BOTH knobs together
// (verified: with limit:1, section [B]'s two concurrent chains still each
// process several products and correctly interleave through the shared
// semaphore before the breaker trips — see that section's own comment).
// The CATALOG_YOLO_CONCURRENCY env var below is now redundant with the
// explicit `limit:1` pins, kept only as a defensive floor for the brief
// window (if any) before the first `__test.reset()` call in each test runs.
// Scoped to this one child process — each verify*.js script runs via its
// own `spawn`, per scripts/runVerifySuite.js.
process.env.CATALOG_YOLO_CONCURRENCY = '1';

let failures = 0;
let checks = 0;

function check(name, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function fakeProducts(n, prefix = 'fake') {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ _id: `${prefix}-${i}` });
  return out;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true, label }), ms);
  });
  return Promise.race([promise, timeout]).then((result) => {
    clearTimeout(timer);
    return result;
  });
}

// Matches detectYoloForOne's real no-op shape (noMedia case) — carries
// noop:true, no `transient` key at all.
function noopResult() {
  return { mediaTotal: 0, detected: 0, skipped: 0, failed: 0, noMedia: true, noop: true };
}

function transientFailResult(kind = 'client-timeout') {
  return { failed: 1, transient: true, yoloKind: kind };
}

async function testSingleChainAlternating(mod, limiter) {
  console.log('\n[A] Bug 2 — single chain alternating no-op / real-transient-failure (20 targets, threshold 5)');
  // limit:1 — see the file header's CORRECTED note: post fix #6, this value
  // is BOTH the semaphore and the courtesy cap, so it must stay small to
  // force serial dispatch (a big number here would let the whole run
  // dispatch in one synchronous burst, defeating A4 below).
  limiter.__test.reset({ limit: 1, threshold: 5, cooldownMs: 1_800_000 });

  const products = fakeProducts(20, 'alt');
  let calls = 0;
  const worker = async (p) => {
    calls++;
    const i = Number(p._id.split('-')[1]);
    await new Promise((r) => setTimeout(r, 1));
    // Even index -> no-op, odd index -> real transient failure. 10 of
    // each across 20 targets.
    return i % 2 === 0 ? noopResult() : transientFailResult();
  };

  const result = await withTimeout(mod.processQueue(products, { worker }), 3000, 'single-chain-alternating');

  check('A1: processQueue() resolves (does not hang)', !result || !result.__timedOut);
  if (result && result.__timedOut) return;

  check('A2 (THE FIX): aborted === true — 10 real transient failures must not be maskable by 10 no-ops',
    result.aborted === true, `got ${JSON.stringify(result)}`);
  check('A3 (THE FIX): abortReason === yolo-circuit-open',
    result.abortReason === 'yolo-circuit-open', `abortReason=${result.abortReason}`);
  check('A4: fewer than all 20 dispatched — the breaker stopped the run before exhausting the no-op/failure alternation',
    result.processed < 20, `processed=${result.processed}`);
  check('A5: breaker is open', limiter.isOpen() === true);
  check('A6: every dispatched product actually ran (sanity — real interleaving happened, not a shortcut)',
    calls === result.processed, `calls=${calls} processed=${result.processed}`);
}

async function testConcurrentChainsHealthyMasksSick(mod, limiter) {
  console.log('\n[B] Bug 2 CONCURRENT — healthy (all no-op) chain interleaved with a sick (100%-transient-failing) chain, sharing one yoloLoadLimiter');
  // limit:1 — same CORRECTED reasoning as [A]. Verified this does not
  // break the "two independently-progressing concurrent chains" intent:
  // both chains still interleave through the shared semaphore (each one
  // item at a time, taking turns) and both still process several of their
  // own products before the sick chain's real failures trip the breaker —
  // see B2/B5 below, which pin exactly that.
  limiter.__test.reset({ limit: 1, threshold: 5, cooldownMs: 1_800_000 });

  const SICK_N = 12;
  const HEALTHY_N = 12;
  let healthyCalls = 0;
  let sickCalls = 0;

  // Deterministic interleave, not a timing race: healthy chain's Nth
  // completion lands at t = 5 + 10*(N-1) ms (5, 15, 25, ...); sick chain's
  // Nth completion lands at t = 10*N ms (10, 20, 30, ...). Sorted:
  // 5(H1) 10(S1) 15(H2) 20(S2) 25(H3) 30(S3) ... — one healthy no-op
  // between every pair of the sick chain's own consecutive failures, for
  // as long as both chains still have targets left.
  const healthyWorker = async () => {
    healthyCalls++;
    const delay = healthyCalls === 1 ? 5 : 10;
    await new Promise((r) => setTimeout(r, delay));
    return noopResult();
  };
  const sickWorker = async () => {
    sickCalls++;
    await new Promise((r) => setTimeout(r, 10));
    return transientFailResult();
  };

  const healthyProducts = fakeProducts(HEALTHY_N, 'healthy');
  const sickProducts = fakeProducts(SICK_N, 'sick');

  const [healthyResult, sickResult] = await Promise.all([
    withTimeout(mod.processQueue(healthyProducts, { worker: healthyWorker }), 5000, 'healthy-chain'),
    withTimeout(mod.processQueue(sickProducts, { worker: sickWorker }), 5000, 'sick-chain')
  ]);

  check('B1: neither chain hangs',
    !(healthyResult && healthyResult.__timedOut) && !(sickResult && sickResult.__timedOut),
    `healthy=${JSON.stringify(healthyResult)} sick=${JSON.stringify(sickResult)}`);
  if ((healthyResult && healthyResult.__timedOut) || (sickResult && sickResult.__timedOut)) return;

  check('B2: real interleaving actually happened (sanity) — both chains ran multiple products before any trip',
    healthyCalls >= 5 && sickCalls >= 5,
    `healthyCalls=${healthyCalls} sickCalls=${sickCalls}`);
  check('B3 (THE FIX): breaker DID open — the sick chain\'s own 100%-transient failures must not be masked by the healthy chain\'s interleaved no-ops',
    limiter.isOpen() === true, `isOpen=${limiter.isOpen()}`);
  check('B4 (THE FIX): the sick chain\'s own run reports aborted:true — it must not read as a false, fully-processed run',
    sickResult.aborted === true, `sick=${JSON.stringify(sickResult)}`);
  check('B5: the sick chain did not need to burn all 12 of its own targets to trip — it stopped once its own failures crossed threshold',
    sickResult.processed < SICK_N, `processed=${sickResult.processed}`);
}

async function testSmallRunFullFailureNowTrips(mod, limiter, orchStub) {
  console.log('\n[C] Bug 1 — a run smaller than THRESHOLD, 100% transient failure, now correctly aborts instead of a false success');
  // limit:1 — CORRECTED (see file header); keeps dispatch serial so C6
  // ("calls < targets") is meaningful post fix #6.
  limiter.__test.reset({ limit: 1, threshold: 5, cooldownMs: 1_800_000, minRunSample: 3 });

  const { fail, succeed } = orchStub();
  const targets = fakeProducts(4, 'small');
  let calls = 0;
  const worker = async () => { calls++; return transientFailResult(); };

  const result = await withTimeout(
    mod.runYoloDetectionOnTargets(targets, { brandId: 'brand-small', worker }),
    3000,
    'small-run-full-failure'
  );

  check('C1: runYoloDetectionOnTargets() resolves (does not hang)', !result || !result.__timedOut);
  if (result && result.__timedOut) return;

  check('C2: fewer than THRESHOLD targets in this run (sanity — this is exactly the structural gap)',
    targets.length < limiter.threshold(), `targets=${targets.length} threshold=${limiter.threshold()}`);
  check('C3 (THE FIX): ok === false, reason === yolo-circuit-open — must NOT read as a clean success',
    result.ok === false && result.reason === 'yolo-circuit-open', `got ${JSON.stringify(result)}`);
  check('C4 (THE FIX): breaker is open', limiter.isOpen() === true);
  check('C5 (THE FIX): run.fail() was called, run.succeed() was NOT — this is what drives applyBackoff instead of backoffAfterSuccess/rematch',
    fail.length === 1 && succeed.length === 0, `fail=${fail.length} succeed=${succeed.length}`);
  check('C6: not every target needed to fail — stopped once the run\'s own 100%-failure sample was large enough (MIN_RUN_SAMPLE)',
    calls < targets.length, `calls=${calls} targets=${targets.length}`);
}

async function testBoundaryNoOverreach(mod, limiter, orchStub) {
  console.log('\n[D] Bug 1 boundary — no over-reach: below MIN_RUN_SAMPLE stays unprotected (documented residual), a mixed-outcome small run does not trip, a run at/above THRESHOLD is untouched');

  // D1 — 2 targets, 100% transient failure, MIN_RUN_SAMPLE default (3):
  // too small a sample even for the supplemental condition. Accepted,
  // documented residual (see docs/ALERTING.md / this file's own header) —
  // NOT asserted as a bug fix, just pinned so a future change to
  // MIN_RUN_SAMPLE's default is a deliberate, visible decision.
  // limit:1 — CORRECTED (see file header).
  limiter.__test.reset({ limit: 1, threshold: 5, cooldownMs: 1_800_000, minRunSample: 3 });
  {
    const { fail, succeed } = orchStub();
    const targets = fakeProducts(2, 'tiny');
    const worker = async () => transientFailResult();
    const result = await withTimeout(
      mod.runYoloDetectionOnTargets(targets, { brandId: 'brand-tiny', worker }),
      3000,
      'tiny-run'
    );
    check('D1: 2 targets, 100% failure, below MIN_RUN_SAMPLE(3) — stays a reported success (accepted residual, not this fix\'s scope)',
      result && result.ok === true && succeed.length === 1 && fail.length === 0 && limiter.isOpen() === false,
      `got ${JSON.stringify(result)} isOpen=${limiter.isOpen()}`);
  }

  // D2 — 4 targets, MIXED outcome (one genuine success among three
  // failures) — must NOT trip. Only a run with EVERY attempt failing
  // qualifies; one real success is a positive health signal.
  // limit:1 — CORRECTED (see file header).
  limiter.__test.reset({ limit: 1, threshold: 5, cooldownMs: 1_800_000, minRunSample: 3 });
  {
    const { fail, succeed } = orchStub();
    const targets = fakeProducts(4, 'mixed');
    let n = 0;
    const worker = async () => {
      n++;
      // One clean success among three transient failures.
      return n === 2 ? { detected: 1 } : transientFailResult();
    };
    const result = await withTimeout(
      mod.runYoloDetectionOnTargets(targets, { brandId: 'brand-mixed', worker }),
      3000,
      'mixed-run'
    );
    check('D2: 4 targets, one genuine success among three failures — must NOT trip (not 100% failure)',
      result && result.ok === true && succeed.length === 1 && fail.length === 0 && limiter.isOpen() === false,
      `got ${JSON.stringify(result)} isOpen=${limiter.isOpen()}`);
  }

  // D3 — a run at/above THRESHOLD, 100% failure, is untouched: it still
  // relies solely on the existing consecutive-count mechanism (this is
  // NOT new behavior — sibling harnesses already pin it — this is just a
  // quick contrast check that the new supplemental path did not disable
  // or duplicate the existing one for runs it should never apply to).
  // limit:1 — CORRECTED (see file header).
  limiter.__test.reset({ limit: 1, threshold: 5, cooldownMs: 1_800_000, minRunSample: 3 });
  {
    const { fail, succeed } = orchStub();
    const targets = fakeProducts(10, 'large');
    const worker = async () => transientFailResult();
    const result = await withTimeout(
      mod.runYoloDetectionOnTargets(targets, { brandId: 'brand-large', worker }),
      3000,
      'large-run'
    );
    check('D3: 10 targets (>= THRESHOLD), 100% failure — still aborts via the EXISTING mechanism, unaffected by this fix',
      result && result.ok === false && result.reason === 'yolo-circuit-open' && fail.length === 1 && succeed.length === 0,
      `got ${JSON.stringify(result)}`);
  }
}

function makeOrchStub(mod) {
  return function orchStub() {
    const fail = [];
    const succeed = [];
    mod.__test.setStartRun(async () => ({
      tick() {},
      checkpoint: async () => {},
      succeed: async (m) => { succeed.push(m); },
      fail: async (err, meta) => { fail.push({ message: err && err.message, meta }); },
      markCancelled() {},
      id: 'gap-test-run'
    }));
    return { fail, succeed };
  };
}

async function main() {
  const mod = require(path.join(__dirname, '..', 'services', 'catalogYoloDetectionService'));
  const limiter = require(path.join(__dirname, '..', 'services', 'yoloLoadLimiter'));
  const orchStub = makeOrchStub(mod);

  await testSingleChainAlternating(mod, limiter);
  limiter.__test.reset();
  mod.__test.reset();

  await testConcurrentChainsHealthyMasksSick(mod, limiter);
  limiter.__test.reset();
  mod.__test.reset();

  await testSmallRunFullFailureNowTrips(mod, limiter, orchStub);
  limiter.__test.reset();
  mod.__test.reset();

  await testBoundaryNoOverreach(mod, limiter, orchStub);
  limiter.__test.reset();
  mod.__test.reset();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`${failures} FAILURE(S)`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
