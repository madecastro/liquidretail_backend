#!/usr/bin/env node
'use strict';
//
// Revert-proof offline harness for the false-abort bug fixed 2026-09-06 in
// processQueue()'s (and runYoloDetectionOnTargets()'s) return statement:
//
//   return {
//     processed,
//     cancelled: abortReason === 'cancelled',
//     aborted: abortReason === 'yolo-circuit-open' || yoloLoadLimiter.isOpen(),
//     abortReason
//   };
//
// The `|| yoloLoadLimiter.isOpen()` term re-sampled the PROCESS-WIDE circuit
// breaker at return time instead of trusting only the locally-tracked
// abortReason. yoloLoadLimiter is a SHARED, process-wide semaphore + breaker
// used by every concurrent catalog-YOLO chain (worker.js's yoloBackfillTick
// runs on its own independent 15-minute interval sharing the exact same
// limiter). So an UNRELATED chain tripping the breaker at the exact moment
// THIS run's own products all finished successfully caused this run to be
// misreported as aborted:true with abortReason:null (internally incoherent —
// aborted but no reason given), even though nothing about this specific run
// failed.
//
// Downstream, runYoloDetectionOnTargets() had the IDENTICAL bug pattern one
// call-frame up (`if (aborted || yoloLoadLimiter.isOpen())`), which is what
// actually produces the {ok:false, reason:'yolo-circuit-open', failed:
// processed} translation that drives catalogPostSyncOrchestrator's
// applyBackoff() + Slack paging — every SUCCESSFUL product in the run gets
// counted as failed, and backoffAfterSuccess() (the only function that would
// CLEAR an existing backoff) never runs. A brand can accumulate real backoff
// purely from unlucky timing against a completely unrelated chain, with zero
// actual failure of its own.
//
// Section [A] pins processQueue()'s own return value directly. Section [B]
// pins the same scenario one call-frame up through
// runYoloDetectionOnTargets(), which is the layer that actually drives the
// production money-adjacent consequence (backoff ratcheting + Slack paging)
// — fixing processQueue() alone does not fix the reported bug, because
// runYoloDetectionOnTargets() had its own independent re-check of the same
// process-wide flag.
//
// TWO MORE DEFECTS were found by adversarial review of the first draft of
// this fix and are pinned here too — both are mirror-image failure modes of
// the original bug (a run silently reported as a false SUCCESS instead of a
// false ABORT), which is worse: it clears earned backoff and fires a paid
// rematch job against a catalog that was never actually scanned.
//
// Section [C]: an operator cancel racing a REAL (this-run-caused) circuit
// trip must report BOTH cancelled:true AND aborted:true — the first draft's
// `!abortReason` guard let a cancel silently suppress a genuine circuit-open,
// which would have cleared backoff on a brand whose own detection really is
// failing. cancelled and aborted are now tracked independently (a dedicated
// `cancelRequested` boolean) instead of both being derived from one shared
// `abortReason` string.
//
// Section [D] (CONFIRMED DEFECT, high severity): if the breaker opens while
// EVERY product in a run is still parked waiting for a yoloLoadLimiter slot
// (none has actually run yet — reachable because worker.js's yoloBackfillTick
// records its own outcome BEFORE releasing its slot, which can open the
// breaker while a sibling chain's whole target set sits in the waiters
// queue), the only code path those products take is the early
// `{aborted:true, skipped:true}` return in the per-product IIFE — which used
// to return without ever stamping `abortReason`. With zero products actually
// dispatched to the real worker, nothing else in the function would set it
// either, so the run resolved as `aborted:false, abortReason:null` — a
// fully-refused run reporting as a clean success.
//
// No DB, no network, no Mongo — pure in-process timing against the exposed
// yoloLoadLimiter.__test surface, matching the real breaker threshold via
// recordOutcome({transient:true}) rather than reaching in and setting
// openUntil directly, so the trip is exercised through the same code path a
// genuinely concurrent chain would use.

const path = require('path');

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

// Races `promise` against a real timer so a genuine hang reports as a
// timeout instead of hanging the whole harness (and CI) forever.
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

// Trips the breaker via the SAME public API a genuinely external, unrelated
// chain would use (yoloLoadLimiter.recordOutcome), enough times to clear
// whatever threshold is currently configured.
function tripBreakerExternally(limiter) {
  const n = limiter.threshold();
  for (let i = 0; i < n; i++) {
    limiter.recordOutcome({ transient: true });
  }
}

async function testProcessQueueFalseAbort(mod, limiter) {
  console.log('\n[A] processQueue(): unrelated external breaker trip at the exact moment the last product finishes');
  // Explicit limit — deterministic regardless of wall-clock time (whether
  // this happens to run inside a nightly boost window or not).
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });

  const products = fakeProducts(5);
  let calls = 0;
  const worker = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 2));
    // Every product in THIS run succeeds cleanly — non-transient, no
    // failure of its own.
    return { detected: 1 };
  };

  // onDone fires from inside processQueue's own `.finally()` handler for
  // each completing product — AFTER that product's own `.then()` handler
  // has already run its own `yoloLoadLimiter.isOpen()` check (which sees
  // the breaker still closed, since it hasn't been tripped yet) but BEFORE
  // processQueue's resolve()/return. Tripping the breaker here, on the
  // LAST product only, deterministically reproduces "an unrelated chain
  // trips the breaker right as this run's own products all finish
  // successfully" without racing real wall-clock microtask timing.
  let trippedAt = null;
  const onDone = async (n, total) => {
    if (n === total) {
      trippedAt = Date.now();
      tripBreakerExternally(limiter);
    }
  };

  const result = await withTimeout(
    mod.processQueue(products, { worker, onDone }),
    3000,
    'processQueue-false-abort'
  );

  check('A1: processQueue() resolves (does not hang)',
    !result || !result.__timedOut,
    result && result.__timedOut ? 'timed out after 3000ms' : undefined);
  if (result && result.__timedOut) return;

  check('A2: all 5 products were dispatched and succeeded', calls === 5, `calls=${calls}`);
  check('A3: processed === 5', result.processed === 5, `processed=${result.processed}`);
  check('A4: the external trip actually happened (sanity)', trippedAt !== null);
  check('A5: breaker IS open at the moment processQueue returns (sanity — this is the race)',
    limiter.isOpen() === true, `isOpen=${limiter.isOpen()}`);
  check('A6 (THE FIX): abortReason === null — nothing about THIS run failed',
    result.abortReason === null, `abortReason=${result.abortReason}`);
  check('A7 (THE FIX): aborted === false — must NOT re-sample the process-wide breaker at return time',
    result.aborted === false, `aborted=${result.aborted}`);
  check('A8: cancelled === false', result.cancelled === false, `cancelled=${result.cancelled}`);
}

async function testRunYoloDetectionOnTargetsFalseAbort(mod, limiter) {
  console.log('\n[B] runYoloDetectionOnTargets(): the same race one call-frame up (the actual production consequence — backoff/paging)');
  // Explicit limit — deterministic regardless of wall-clock time.
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });

  const succeedCalls = [];
  const failCalls = [];
  let checkpointCalls = 0;
  mod.__test.setStartRun(async () => ({
    tick() {},
    checkpoint: async () => {
      checkpointCalls++;
      // The internal onDone wiring inside runYoloDetectionOnTargets calls
      // run.tick(), then (if brandId) touchChainHeartbeat, then
      // run.checkpoint() — in that order, once per completing product. We
      // have no brandId here (skips the heartbeat branch), so checkpoint()
      // is the last thing to run per product before processQueue's own
      // pump()/resolve() — the same "after this product's .then(), before
      // the function returns" window used in section A. Trip the breaker
      // on the LAST product's checkpoint call only.
      if (checkpointCalls === targets.length) {
        tripBreakerExternally(limiter);
      }
    },
    succeed: async (m) => { succeedCalls.push(m); },
    fail: async (err, meta) => { failCalls.push({ message: err && err.message, meta }); },
    markCancelled() {},
    id: 'false-abort-run'
  }));

  const targets = fakeProducts(5, 'target');
  const worker = async () => ({ detected: 1 });

  const result = await withTimeout(
    mod.runYoloDetectionOnTargets(targets, { worker }),
    3000,
    'runYoloDetectionOnTargets-false-abort'
  );

  check('B1: runYoloDetectionOnTargets() resolves (does not hang)',
    !result || !result.__timedOut,
    result && result.__timedOut ? 'timed out after 3000ms' : undefined);
  if (result && result.__timedOut) return;

  check('B2: breaker IS open at return time (sanity — this is the race)',
    limiter.isOpen() === true, `isOpen=${limiter.isOpen()}`);
  check('B3 (THE FIX): ok !== false / reason !== yolo-circuit-open — a clean run must not be reported as circuit-aborted',
    !(result.ok === false && result.reason === 'yolo-circuit-open'),
    `got ${JSON.stringify(result)}`);
  check('B4 (THE FIX): run.succeed() was called, run.fail() was NOT — this run must be recorded as a success',
    succeedCalls.length === 1 && failCalls.length === 0,
    `succeed=${succeedCalls.length} fail=${JSON.stringify(failCalls)}`);
  check('B5: detected === 5 (every product actually completed)',
    result.detected === 5, `detected=${result.detected}`);

  mod.__test.reset();
}

async function testCancelVsCircuitOrdering(mod, limiter) {
  console.log('\n[C] Secondary finding: operator cancel racing a GENUINE self-caused circuit trip must report BOTH — cancelled:true AND aborted:true');
  // Explicit limit — deterministic regardless of wall-clock time.
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });

  // Pre-load the shared counter to threshold-2 via OTHER (unrelated) work,
  // so THIS run's own two products are what finish crossing it — i.e. the
  // SECOND one's own recordOutcome({transient:true}) call returns
  // {opened:true} on its own merits, a genuine in-band signal, not a
  // bystander poll of ambient state. (Both of this run's products must
  // themselves be transient failures, not one success + one failure — a
  // clean success's recordOutcome({transient:false}) call RESETS the
  // shared counter to 0, which would undo the pre-load and defeat the
  // whole setup.) This is deliberately NOT an external trip (see section E
  // below for that shape, which must NOT stamp abortReason at all after
  // the fix for the mid-run false-positive).
  for (let i = 0; i < limiter.threshold() - 2; i++) limiter.recordOutcome({ transient: true });

  // Timeline:
  //   t=3ms  — operator cancel flag flips true
  //   t=5ms  — product A finishes with its OWN transient failure; its
  //            .finally() sees the cancel flag first (isCancelled runs
  //            after the .then() handler in the same finally chain — see
  //            processQueue's structure), sets cancelRequested=true and
  //            stamps abortReason='cancelled' (A's own recordOutcome call
  //            brings the counter to threshold-1, not yet open)
  //   t=20ms — product B finishes with its OWN transient failure — THIS
  //            run's own second failure, and its recordOutcome() call is
  //            the one that pushes consecutiveTransient over threshold,
  //            returning {opened:true}. That must unconditionally win the
  //            abortReason/aborted determination over the earlier
  //            'cancelled' stamp — a genuine self-caused circuit-open is
  //            money-relevant (backoff/paging) and cancelled is not.
  //            cancelRequested is untouched by this, so `cancelled` stays
  //            true: this run really was both cancelled AND genuinely hit
  //            a circuit-open of its own making, and both facts must
  //            survive to the caller. (An EARLIER draft used a
  //            `!abortReason` guard here instead, which made cancelled:true
  //            silently SUPPRESS a real circuit-open's aborted:true —
  //            verified wrong by adversarial review and reverted.)
  let cancelRequested = false;
  setTimeout(() => { cancelRequested = true; }, 3);

  const products = [
    { _id: 'cancel-a', delay: 5 },
    { _id: 'cancel-b', delay: 20 }
  ];
  const worker = async (p) => {
    await new Promise((r) => setTimeout(r, p.delay));
    return { failed: 1, transient: true };
  };

  const result = await withTimeout(
    mod.processQueue(products, { worker, isCancelled: async () => cancelRequested }),
    3000,
    'processQueue-cancel-vs-circuit'
  );

  check('C1: processQueue() resolves (does not hang)',
    !result || !result.__timedOut,
    result && result.__timedOut ? 'timed out after 3000ms' : undefined);
  if (result && result.__timedOut) return;

  check('C2: the breaker really did trip, from this run\'s own product B (sanity)',
    limiter.isOpen() === true, `isOpen=${limiter.isOpen()}`);
  check('C3 (THE FIX): abortReason === \'yolo-circuit-open\' — a genuine self-caused trip must win the money-relevant determination',
    result.abortReason === 'yolo-circuit-open', `abortReason=${result.abortReason}`);
  check('C4 (THE FIX): cancelled === true — the cancel must not be lost even though the breaker trip won abortReason',
    result.cancelled === true, `cancelled=${result.cancelled}`);
  check('C5 (THE FIX): aborted === true — the real circuit-open must be reported so backoff/paging still fires',
    result.aborted === true, `aborted=${result.aborted}`);
}

async function testUnrelatedTripDuringOwnSuccessMidRun(mod, limiter) {
  console.log('\n[E] CONFIRMED DEFECT (2nd adversarial pass): a 100%-successful run must NOT abort just because an UNRELATED chain trips the breaker WHILE this run is still executing (not at entry, not after everything is done)');
  // Explicit limit:6 — do NOT rely on the default; section D above sets
  // limit:1 and __test.reset() only overwrites limit when explicitly
  // passed, so omitting it here would silently inherit D's value and
  // serialize all 5 products instead of exercising the intended
  // "genuinely still executing concurrently" shape.
  limiter.__test.reset({ limit: 6, threshold: 5, cooldownMs: 1_800_000 });

  // 5 products, ALL succeed on their own merits — zero transient outcomes
  // recorded by this run. An unrelated external actor (simulating e.g.
  // worker.js's yoloBackfillTick, sharing the same limiter) trips the
  // breaker mid-run — after products 1-2 have already completed, while
  // products 3-5 are still genuinely executing (not parked, not finished).
  // Pre-fix (both the original bug AND the first round's incomplete fix),
  // whichever of this run's OWN clean completions happens to run its .then()
  // AFTER that moment independently re-polls isOpen() and false-stamps
  // abortReason — even though nothing about THIS run's own work ever failed
  // and every product was fully dispatched (remaining=0, nothing left to
  // protect).
  const products = fakeProducts(5, 'clean');
  const worker = async (p) => {
    // Staggered so products 0-1 finish before the trip, 2-4 are still in
    // flight when it lands.
    const delay = [5, 10, 40, 50, 60][Number(p._id.split('-')[1])];
    await new Promise((r) => setTimeout(r, delay));
    return { detected: 1 };
  };

  setTimeout(() => { tripBreakerExternally(limiter); }, 21);

  const result = await withTimeout(
    mod.processQueue(products, { worker }),
    3000,
    'processQueue-unrelated-trip-mid-run'
  );

  check('E1: processQueue() resolves (does not hang)',
    !result || !result.__timedOut,
    result && result.__timedOut ? 'timed out after 3000ms' : undefined);
  if (result && result.__timedOut) return;

  check('E2: all 5 products actually ran and succeeded (dispatched fully — nothing left to protect)',
    result.processed === 5, `processed=${result.processed}`);
  check('E3: the external trip actually happened mid-run (sanity)',
    limiter.isOpen() === true, `isOpen=${limiter.isOpen()}`);
  check('E4 (THE FIX): abortReason === null — nothing about THIS run\'s own work ever failed',
    result.abortReason === null, `abortReason=${result.abortReason}`);
  check('E5 (THE FIX): aborted === false — a fully-successful, fully-dispatched run must not read as circuit-aborted',
    result.aborted === false, `aborted=${result.aborted}`);
  check('E6: cancelled === false', result.cancelled === false, `cancelled=${result.cancelled}`);
}

async function testAllProductsRefusedAtEntry(mod, limiter) {
  console.log('\n[D] CONFIRMED DEFECT 1 (adversarial review): breaker opens while every product is still parked waiting for a limiter slot — none ever actually ran');
  limiter.__test.reset({ limit: 1, threshold: 5, cooldownMs: 1_800_000 });

  // Saturate the process-wide semaphore with a long-running "someone else's"
  // slot-holder BEFORE this run's own products ever get a chance to acquire.
  // With limit:1, every one of this run's products piles up in
  // yoloLoadLimiter's internal waiters queue.
  await limiter.acquire(); // occupies the single slot as the "other chain"

  const products = fakeProducts(3, 'parked');
  let workerCalls = 0;
  const worker = async () => { workerCalls++; return { detected: 1 }; };

  const runPromise = withTimeout(
    mod.processQueue(products, { worker }),
    3000,
    'processQueue-all-refused-at-entry'
  );

  // Give processQueue a tick to dispatch all 3 products into the waiters
  // queue (they cannot acquire — the single slot is held above), then trip
  // the breaker via the SAME mechanism worker.js's yoloBackfillTick uses:
  // recordOutcome while still holding its own slot, BEFORE releasing it.
  await new Promise((r) => setTimeout(r, 20));
  tripBreakerExternally(limiter);
  // Release the "other chain"'s slot — the first waiter wakes, sees the
  // (now-open) breaker, takes the {aborted:true,skipped:true} path, and its
  // own `finally` releases again — cascading through all 3 parked waiters
  // without this test needing to release more than once.
  limiter.release();

  const result = await runPromise;

  check('D1: processQueue() resolves (does not hang)',
    !result || !result.__timedOut,
    result && result.__timedOut ? 'timed out after 3000ms' : undefined);
  if (result && result.__timedOut) return;

  check('D2: zero products actually ran the real worker (all refused at the door)',
    workerCalls === 0, `workerCalls=${workerCalls}`);
  check('D3: processed === 0', result.processed === 0, `processed=${result.processed}`);
  check('D4 (THE FIX): abortReason === \'yolo-circuit-open\' — NOT null',
    result.abortReason === 'yolo-circuit-open', `abortReason=${result.abortReason}`);
  check('D5 (THE FIX): aborted === true — a zero-work run must NOT read as a false success',
    result.aborted === true, `aborted=${result.aborted}`);
  check('D6: cancelled === false', result.cancelled === false, `cancelled=${result.cancelled}`);
}

async function main() {
  const mod = require(path.join(__dirname, '..', 'services', 'catalogYoloDetectionService'));
  const limiter = require(path.join(__dirname, '..', 'services', 'yoloLoadLimiter'));

  await testProcessQueueFalseAbort(mod, limiter);
  limiter.__test.reset({ limit: 6 });
  await testRunYoloDetectionOnTargetsFalseAbort(mod, limiter);
  limiter.__test.reset({ limit: 6 });
  await testCancelVsCircuitOrdering(mod, limiter);
  limiter.__test.reset({ limit: 6 });
  await testAllProductsRefusedAtEntry(mod, limiter);
  limiter.__test.reset({ limit: 6 });
  await testUnrelatedTripDuringOwnSuccessMidRun(mod, limiter);

  limiter.__test.reset({ limit: 6 });
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
