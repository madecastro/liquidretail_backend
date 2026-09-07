#!/usr/bin/env node
'use strict';
//
// verifyYoloBackfillZeroAlert — pins the yoloBackfillTick zero-success-batch
// alert (services/yoloBackfillAlerter.js, wired from worker.js's
// yoloBackfillTick).
//
// THE GAP THIS CLOSES: yoloBackfillTick (worker.js, every
// CATALOG_YOLO_BACKFILL_INTERVAL_MIN, default 15m) absorbed every per-Media
// detect failure into ok/failed/skipped counters with only a console.log —
// a full batch where EVERY attempt failed (failed > 0 && ok === 0) had no
// Slack signal. Distinct from tonight's PR #403/#404 yolo:circuit-open fix,
// which covers the BREAKER-open path; this covers the sibling case where
// the backfill sweep itself makes zero progress without necessarily
// tripping the process-wide breaker (e.g. a non-transient error class).
//
// Fires only on the SECOND consecutive all-fail batch (~30min of continuous
// zero-success at the default interval), not the first, mirroring
// yoloLoadLimiter.consecutiveTransient's own "resets to 0 on any success"
// in-memory-counter shape.
//
// Offline: no Mongo, no HTTP, no keys. Drives the REAL
// services/yoloBackfillAlerter.js module against a stubbed alertService
// (module-singleton monkey-patch — same pattern verifyIngestStatusFeed.js
// uses for the OperationRun model, since neither module exposes its own
// dependency-injection seam for this).
//
//   node scripts/verifyYoloBackfillZeroAlert.js

const fs = require('node:fs');
const path = require('node:path');

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

// ── A. structural wiring — the call site exists AND the module it calls
// actually resolves and exports what's called (the "a regex only proves
// the call is written, not that it resolves" trap this repo's CLAUDE.md
// calls out by name — receiptFree/preferUgcMediaId/usableProofCommentsOrNone
// all shipped broken because nobody checked the import existed). ──
console.log('\nA. worker.js wiring');
const workerSrc = read('worker.js');
check('A1 worker.js requires services/yoloBackfillAlerter',
  /require\(['"]\.\/services\/yoloBackfillAlerter['"]\)/.test(workerSrc),
  'the call site below is unreachable if this require is missing/misspelled');

const backfillRegion = workerSrc.slice(
  workerSrc.indexOf('yoloBackfillTick'),
  workerSrc.indexOf('setTimeout(yoloBackfillTick')
);
check('A2 yoloBackfillTick calls recordBatchOutcome with ok/failed/batchSize/lastError',
  /yoloBackfillAlerter\.recordBatchOutcome\(\{\s*ok,\s*failed,\s*batchSize:\s*stale\.length,\s*lastError\s*\}\)/.test(backfillRegion),
  'call site must pass the real per-tick counters, not a stub shape');
check('A3 call site is INSIDE the per-batch tick, after the per-Media loop (uses the real batch counters, not module scope)',
  backfillRegion.indexOf('yolo backfill done') >= 0
    && backfillRegion.indexOf('yoloBackfillAlerter.recordBatchOutcome') > backfillRegion.indexOf('yolo backfill done'),
  'must run after ok/failed are finalized for this batch');

// Actually resolve the module the require string names (does it exist,
// does it export the function actually called above).
let alerterModule;
try {
  alerterModule = require(path.join(ROOT, 'services', 'yoloBackfillAlerter.js'));
} catch (err) {
  check('A4 services/yoloBackfillAlerter.js resolves', false, err.message);
}
if (alerterModule) {
  check('A4 services/yoloBackfillAlerter.js resolves', true);
  check('A5 exports recordBatchOutcome(fn)', typeof alerterModule.recordBatchOutcome === 'function');
  check('A6 exports __test seam (reset + consecutiveZeroBatchesNow)',
    alerterModule.__test && typeof alerterModule.__test.reset === 'function'
      && typeof alerterModule.__test.consecutiveZeroBatchesNow === 'function');
}

// ── B. stub alertService.notifyAsync (module-singleton monkeypatch — the
// SAME cached object require('./alertService') returns inside
// yoloBackfillAlerter.js, so overriding its export here reaches that
// call site) ──
console.log('\nB. behavioral — threshold, fields, reset-on-success');
const alertsModule = require(path.join(ROOT, 'services', 'alertService.js'));
const originalNotifyAsync = alertsModule.notifyAsync;
let notifyCalls = [];
alertsModule.notifyAsync = (opts) => { notifyCalls.push(opts); };

function resetHarness() {
  notifyCalls = [];
  alerterModule.__test.reset();
}

(async () => {
  // B1 — first all-fail batch: counter increments, NO alert yet.
  resetHarness();
  const r1 = alerterModule.recordBatchOutcome({ ok: 0, failed: 5, batchSize: 5, lastError: { kind: 'http-503', message: 'boom' } });
  check('B1 first all-fail batch does not alert', r1.alerted === false && r1.consecutive === 1,
    `got ${JSON.stringify(r1)}`);
  check('B1b notifyAsync not called on first occurrence', notifyCalls.length === 0);

  // B2 — SECOND consecutive all-fail batch: fires, with the right shape.
  const r2 = alerterModule.recordBatchOutcome({ ok: 0, failed: 5, batchSize: 5, lastError: { kind: 'http-503', message: 'boom' } });
  check('B2 second consecutive all-fail batch alerts', r2.alerted === true && r2.consecutive === 2,
    `got ${JSON.stringify(r2)}`);
  check('B2b notifyAsync called exactly once', notifyCalls.length === 1, `calls=${notifyCalls.length}`);
  const call = notifyCalls[0] || {};
  check('B2c level=error', call.level === 'error');
  check('B2d key=yolo:backfill-zero', call.key === 'yolo:backfill-zero');
  check('B2e fields carry batch size', call.fields && String(call.fields['batch size']) === '5',
    JSON.stringify(call.fields));
  check('B2f fields carry consecutive count', call.fields && call.fields['consecutive zero-success batches'] === 2,
    JSON.stringify(call.fields));
  check('B2g fields carry last error kind/message', call.fields
    && call.fields['last error kind'] === 'http-503'
    && call.fields['last error message'] === 'boom',
    JSON.stringify(call.fields));

  // B3 — a THIRD consecutive all-fail batch still fires (not a one-shot).
  notifyCalls = [];
  const r3 = alerterModule.recordBatchOutcome({ ok: 0, failed: 3, batchSize: 3 });
  check('B3 third consecutive batch also alerts (dedupe is alertService\'s job, not this counter\'s)',
    r3.alerted === true && r3.consecutive === 3 && notifyCalls.length === 1,
    `got ${JSON.stringify(r3)} calls=${notifyCalls.length}`);

  // B4 — ANY success resets the counter to 0, and the NEXT all-fail batch
  // is treated as a first occurrence again (no alert).
  notifyCalls = [];
  const r4 = alerterModule.recordBatchOutcome({ ok: 1, failed: 2, batchSize: 3 });
  check('B4 a batch with ok>0 resets the counter regardless of failed count',
    r4.alerted === false && r4.consecutive === 0
      && alerterModule.__test.consecutiveZeroBatchesNow() === 0,
    `got ${JSON.stringify(r4)}`);
  const r5 = alerterModule.recordBatchOutcome({ ok: 0, failed: 4, batchSize: 4 });
  check('B5 first all-fail batch AFTER a reset does not alert',
    r5.alerted === false && r5.consecutive === 1 && notifyCalls.length === 0,
    `got ${JSON.stringify(r5)}`);

  // B6 — an empty/no-target batch (worker.js's own `if (!stale.length)
  // return` guard means this shouldn't normally reach recordBatchOutcome
  // at all, but the module itself must not misinterpret it as either a
  // success-reset or a failure-increment).
  resetHarness();
  alerterModule.recordBatchOutcome({ ok: 0, failed: 5, batchSize: 5 }); // consecutive -> 1
  const before = alerterModule.__test.consecutiveZeroBatchesNow();
  const r6 = alerterModule.recordBatchOutcome({ ok: 0, failed: 0, batchSize: 0 });
  check('B6 a batch with nothing attempted/failed neither resets nor increments',
    r6.alerted === false && alerterModule.__test.consecutiveZeroBatchesNow() === before,
    `before=${before} after=${alerterModule.__test.consecutiveZeroBatchesNow()}`);

  // ── C. REVERT-PROOF sanity — the behavioral assertions above are driven
  // against the REAL module (not a re-implementation), so a regression in
  // the threshold (e.g. alerting on the first occurrence) or in the
  // reset-on-success behavior fails B1/B2/B4 directly. Demonstrate the
  // negative concretely: a naive "alert on every all-fail batch" mutant
  // would fail B1b; a "never reset" mutant would fail B5.
  console.log('\nC. revert-proof (mutation sanity, run against THIS module\'s real exports)');
  check('C1 threshold is exactly 2 (not 1, not >2) — B1 alerted=false + B2 alerted=true together pin this',
    r1.alerted === false && r2.alerted === true);
  check('C2 reset-on-success is real, not a no-op — B4 + B5 together pin this',
    r4.consecutive === 0 && r5.consecutive === 1);

  alertsModule.notifyAsync = originalNotifyAsync;
  alerterModule.__test.reset();

  console.log('');
  if (failures.length) {
    console.log(`${pass} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`${pass} passed, 0 failed`);
  process.exit(0);
})().catch((err) => {
  alertsModule.notifyAsync = originalNotifyAsync;
  console.error('harness crashed:', err);
  process.exit(1);
});
