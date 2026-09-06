#!/usr/bin/env node
'use strict';
//
// Revert-proof offline harness for the processQueue() deadlock fixed
// 2026-09-06: if the catalog-YOLO circuit breaker (yoloLoadLimiter) is
// ALREADY open the very first time processQueue()'s internal pump()
// function runs -- i.e. before a single product has been dispatched --
// the old code set `stopped = true` and `break`ed out of the while loop
// without ever calling the wrapping Promise's `resolve()` again. Nothing
// re-invoked pump() (no async work had started, so no `.finally()`
// callback existed to do it), so the Promise -- and everything awaiting
// processQueue() -- hung forever.
//
// Confirmed live in production 2026-09-06: the 30-minute post-sync
// reconcile tick found the breaker open (YOLO microservice degraded) and
// called into runYoloDetection() -> processQueue() for a brand with 797
// targets. The call's own start-of-run log line printed and then NOTHING
// else logged for 6+ minutes -- no "circuit open after N consecutive
// transient batches" completion line, which the code prints immediately
// after processQueue() returns with aborted:true. That line is dead code
// while processQueue() never returns.
//
// No DB, no network, no Mongo -- pure in-process races against a real
// setTimeout so a genuine hang actually times out instead of the test
// itself hanging forever.

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

function fakeProducts(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ _id: `fake-${i}` });
  return out;
}

// Races `promise` against a real timer so a genuine deadlock reports as a
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

async function testBreakerAlreadyOpenAtEntry(mod, limiter) {
  console.log('\n[A] Breaker already open when processQueue() starts (the deadlock case)');
  limiter.__test.reset();
  // Force isOpen() === true from the very first call, before anything is
  // dispatched -- exactly today's live production scenario.
  limiter.__test.setOpenUntil(Date.now() + 60_000);

  let workerCalls = 0;
  const worker = async () => { workerCalls++; return { detected: 1 }; };

  const products = fakeProducts(5);
  const result = await withTimeout(
    mod.processQueue(products, { worker }),
    2000,
    'processQueue-breaker-open-at-entry'
  );

  check('A1: processQueue() resolves (does not hang) when breaker is open at entry',
    !result || !result.__timedOut,
    result && result.__timedOut ? 'timed out after 2000ms — deadlock reproduced' : undefined);
  if (result && result.__timedOut) return; // nothing else to assert, it hung

  check('A2: zero products dispatched to the worker (breaker blocked before any work)',
    workerCalls === 0, `workerCalls=${workerCalls}`);
  check('A3: processed === 0', result.processed === 0, `processed=${result.processed}`);
  check('A4: aborted === true', result.aborted === true, `aborted=${result.aborted}`);
  check('A5: abortReason === "yolo-circuit-open"',
    result.abortReason === 'yolo-circuit-open', `abortReason=${result.abortReason}`);
  check('A6: cancelled === false', result.cancelled === false, `cancelled=${result.cancelled}`);
}

async function testBreakerOpensMidRun(mod, limiter) {
  console.log('\n[B] Breaker starts closed, opens mid-run (must still resolve + report correctly)');
  limiter.__test.reset();

  const products = fakeProducts(10);
  let calls = 0;
  const worker = async (p) => {
    calls++;
    // Trip the breaker after the 3rd product starts, mid-batch, before any
    // more products dispatch -- this is the "opens while inflight > 0" path
    // that already worked pre-fix (relies on completion callbacks re-
    // invoking pump()) and must keep working post-fix.
    if (calls === 3) {
      limiter.__test.setOpenUntil(Date.now() + 60_000);
    }
    await new Promise((r) => setTimeout(r, 5));
    return { detected: 1 };
  };

  const result = await withTimeout(
    mod.processQueue(products, { worker }),
    3000,
    'processQueue-breaker-opens-mid-run'
  );

  check('B1: processQueue() resolves (does not hang) when breaker opens mid-run',
    !result || !result.__timedOut,
    result && result.__timedOut ? 'timed out after 3000ms' : undefined);
  if (result && result.__timedOut) return;

  check('B2: aborted === true once the breaker trips', result.aborted === true, `aborted=${result.aborted}`);
  check('B3: abortReason === "yolo-circuit-open"',
    result.abortReason === 'yolo-circuit-open', `abortReason=${result.abortReason}`);
  check('B4: fewer than all 10 products were dispatched (stopped early)',
    calls < 10, `calls=${calls}`);
  check('B5: processed <= calls (no double-counting)', result.processed <= calls,
    `processed=${result.processed} calls=${calls}`);
}

async function testHappyPathNoBreaker(mod, limiter) {
  console.log('\n[C] Ordinary run: breaker never opens, all products settle');
  limiter.__test.reset();

  const products = fakeProducts(8);
  let calls = 0;
  const worker = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 2));
    return { detected: 1 };
  };

  const result = await withTimeout(
    mod.processQueue(products, { worker }),
    3000,
    'processQueue-happy-path'
  );

  check('C1: processQueue() resolves on the ordinary happy path',
    !result || !result.__timedOut,
    result && result.__timedOut ? 'timed out after 3000ms' : undefined);
  if (result && result.__timedOut) return;

  check('C2: all 8 products dispatched to the worker', calls === 8, `calls=${calls}`);
  check('C3: processed === 8', result.processed === 8, `processed=${result.processed}`);
  check('C4: aborted === false', result.aborted === false, `aborted=${result.aborted}`);
  check('C5: abortReason === null', result.abortReason === null, `abortReason=${result.abortReason}`);
}

async function main() {
  const mod = require(path.join(__dirname, '..', 'services', 'catalogYoloDetectionService'));
  const limiter = require(path.join(__dirname, '..', 'services', 'yoloLoadLimiter'));

  await testBreakerAlreadyOpenAtEntry(mod, limiter);
  await testBreakerOpensMidRun(mod, limiter);
  await testHappyPathNoBreaker(mod, limiter);

  limiter.__test.reset();

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
