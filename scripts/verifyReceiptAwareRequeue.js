#!/usr/bin/env node
'use strict';
//
// verifyReceiptAwareRequeue — pins the ONE rule that keeps a restart from
// re-buying work we have already paid for:
//
//   AN AD HOLDING A SPEND RECEIPT IS NEVER REQUEUED.
//
// WHY THIS EXISTS (2026-08-04, measured in production):
//   There are exactly TWO places that move an ad `rendering` -> `queued`:
//     1. services/processAlerts.js  persistOrphans  — runs on EVERY SIGTERM,
//        so on every deploy. This is the dangerous one.
//     2. worker.js                  reapOrphans     — the 15-minute sweep.
//   Both were unconditional `updateMany({ status: 'rendering' }, ...)`.
//
//   An ad holding Ad.veoPredictionId (video) or Ad.imageGeneration.predictionId
//   (static) has ALREADY BEEN BILLED — the provider charges at submit, not at
//   completion. Requeuing it means the next run SUBMITS AGAIN, so we pay twice
//   for a generation Atlas may already have delivered. atlasVideoService says so
//   itself at the charge point: "without it a crash mid-poll loses the only
//   handle to work we have paid for, and the reaper re-queues the ad into a
//   second submit."
//
//   Measured: a 411s Omni master completed at 17:27:09 and persistOrphans
//   requeued its run one second later, at 17:27:10.
//
//   Receipt-FREE ads must STILL be requeued — they were never billed, so
//   re-running them costs the one charge that was always owed. A fix that
//   stopped requeuing everything would strand legitimate work, so this harness
//   pins BOTH directions.
//
// This harness is pure + offline: no DB, no network, no API key.
//   node scripts/verifyReceiptAwareRequeue.js
//
// Revert-prove (each mutation must fail this harness):
//   (a) In worker.js reapOrphans, drop the receipt clauses from the Ad
//       updateMany filter -> W* fail.
//   (b) In processAlerts persistOrphans, drop them there -> P* fail.
//   (c) Add a THIRD unconditional `status: 'rendering'` -> `queued` write
//       anywhere in worker.js / services/ -> X1 fails (the exhaustive scan).
//   Report the failing output verbatim when proving.
//
// Covered:
//   W*  worker.js reapOrphans excludes both receipt fields
//   P*  processAlerts persistOrphans excludes both receipt fields
//   R*  receipt-free ads are still requeued (the fix did not strand work)
//   X*  exhaustive: no OTHER site requeues rendering -> queued unguarded

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKER = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const ALERTS = fs.readFileSync(path.join(ROOT, 'services', 'processAlerts.js'), 'utf8');
const GUARD  = fs.readFileSync(path.join(ROOT, 'services', 'spendReceipt.js'), 'utf8');

// The ONE definition. If these field names drift from models/Ad.js, every site
// silently stops guarding — so they are pinned here, once.
const { RECEIPT_FREE, HAS_RECEIPT, receiptFree } = require('../services/spendReceipt');

let pass = 0;
const failures = [];
function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(label + (extra ? ` — ${extra}` : ''));
}

// Both receipt fields must be excluded. Checking only one would let the other
// class of paid work be re-bought: video receipts live on veoPredictionId,
// static receipts on imageGeneration.predictionId.
// After 2026-08-04 every requeue site composes ONE shared filter rather than
// carrying its own copy — five hand-written copies of a money guard is five
// chances to get it wrong. So the sites are checked for USE of the helper and
// the helper itself is checked for the actual field names.
function guardsBothReceipts(block) {
  return /receiptFree\(/.test(block);
}

// Isolate the Ad requeue write from each site so a receipt mention ELSEWHERE in
// the file cannot satisfy the check by accident.
// Must find the AD requeue, not just the first `status: 'queued'` write.
// worker.js also resets DetectRun `processing` -> `queued`, which matched the
// naive search and made these checks assert against the wrong query entirely —
// they failed while the real Ad guard was present and correct.
function adRequeueBlock(src) {
  let at = src.indexOf("$set: { status: 'queued'");
  while (at >= 0) {
    const from = src.lastIndexOf('updateMany(', at);
    if (from >= 0) {
      const block = src.slice(from, at + 60);
      if (/status: 'rendering'/.test(block)) return block;   // ads only
    }
    at = src.indexOf("$set: { status: 'queued'", at + 1);
  }
  return '';
}

// ── W: worker.js reapOrphans ─────────────────────────────────────────
const wBlock = adRequeueBlock(WORKER);
checkTrue('W0 worker.js still has an Ad rendering->queued requeue', wBlock.length > 0);
checkTrue('W1 worker reaper excludes BOTH receipt fields from the requeue',
  guardsBothReceipts(wBlock));
checkTrue('W2 worker reaper still filters on status rendering + a staleness cutoff',
  /status: 'rendering'/.test(wBlock) && /updatedAt/.test(wBlock));
// Visibility: an ad left in `rendering` on purpose must not look like a bug.
checkTrue('W3 the worker logs the ads it deliberately did NOT requeue',
  /hold a spend receipt/.test(WORKER) && /NOT requeued/.test(WORKER));

// ── P: processAlerts persistOrphans (fires on EVERY deploy) ───────────
const pBlock = adRequeueBlock(ALERTS);
checkTrue('P0 processAlerts still has an Ad rendering->queued requeue', pBlock.length > 0);
checkTrue('P1 persistOrphans excludes BOTH receipt fields from the requeue',
  guardsBothReceipts(pBlock));
checkTrue('P2 persistOrphans still scopes to this process\'s own runIds',
  /campaignRunIds/.test(pBlock));

// ── R: receipt-FREE ads must still be requeued ───────────────────────
// The guard has to be an ABSENCE test, not a blanket exclusion. `$in: [null,'']`
// plus `$exists: false` covers an unset field, an explicit null, and the empty
// string. A bare `$exists: false` alone would miss `veoPredictionId: null`,
// which is the schema DEFAULT (models/Ad.js) — i.e. it would miss almost every
// legitimately requeueable ad and strand the queue.
checkTrue('R1 the guard treats an UNSET receipt as requeueable ($exists: false)',
  /\$exists: false/.test(GUARD));
// models/Ad.js declares veoPredictionId with `default: null`, so the field
// EXISTS on essentially every ad. A bare $exists:false would match almost
// nothing and strand the whole queue.
checkTrue('R2 the guard treats a NULL/empty receipt as requeueable (schema default is null)',
  /\$in: \[null, ''\]/.test(GUARD));
checkTrue('R3 the guard names BOTH receipt fields (video AND static)',
  /veoPredictionId/.test(GUARD) && /imageGeneration\.predictionId/.test(GUARD));
checkTrue('R4 HAS_RECEIPT is the exact inverse ($nin), for the held-back count',
  /\$nin: \[null, ''\]/.test(GUARD));
// receiptFree must COMPOSE, not spread — a spread would silently drop an
// existing $and on the caller's filter and lose part of their query.
{
  const merged = receiptFree({ status: 'rendering', $and: [{ foo: 1 }] });
  checkTrue('R5 receiptFree preserves a caller\'s existing $and',
    merged.$and.length === RECEIPT_FREE.$and.length + 1
    && JSON.stringify(merged.$and[0]) === JSON.stringify({ foo: 1 }),
    JSON.stringify(merged.$and));
  checkTrue('R6 receiptFree keeps the caller\'s other keys', merged.status === 'rendering');
}

// ── X: exhaustive — no other unguarded requeue site ──────────────────
// A third site added later would silently reintroduce the double-bill, and no
// unit test would catch it because the money moves in a different file.
const SCAN_DIRS = [path.join(ROOT, 'services'), path.join(ROOT, 'routes')];
const offenders = [];
for (const dir of SCAN_DIRS) {
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const full = path.join(dir, f);
    const src = fs.readFileSync(full, 'utf8');
    let idx = src.indexOf("$set: { status: 'queued'");
    while (idx >= 0) {
      const from = src.lastIndexOf('updateMany(', idx);
      const block = from >= 0 ? src.slice(from, idx + 60) : '';
      // Only writes that move ads OUT of `rendering` are money-relevant.
      // ALLOWLIST: the claim-anomaly release takes a claim and hands it straight
      // back BEFORE any render or submit, so no receipt can exist yet and an
      // unconditional release is correct. Named, not silently skipped.
      const near = src.slice(Math.max(0, from - 900), idx);
      const isClaimAnomalyRelease = /CLAIM ANOMALY/.test(near);
      if (block && /status: 'rendering'/.test(block)
          && !guardsBothReceipts(block) && !isClaimAnomalyRelease) {
        offenders.push(`${path.relative(ROOT, full)} (offset ${idx})`);
      }
      idx = src.indexOf("$set: { status: 'queued'", idx + 1);
    }
  }
}
checkTrue('X1 no unguarded rendering->queued requeue anywhere in services/ or routes/',
  offenders.length === 0, offenders.join(', '));

const total = pass + failures.length;
if (failures.length) {
  console.error(`verifyReceiptAwareRequeue: ${pass}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error('  FAIL', f);
  process.exit(1);
}
console.log(`verifyReceiptAwareRequeue: ${pass}/${total} passed`);
process.exit(0);
