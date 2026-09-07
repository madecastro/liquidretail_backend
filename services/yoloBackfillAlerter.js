'use strict';
//
// yoloBackfillAlerter — zero-success-batch alert for worker.js's
// yoloBackfillTick (services/catalogYoloDetectionService is the sibling
// ingest-time path; this one is the standalone Media-level sweep).
//
// THE GAP THIS CLOSES: yoloBackfillTick runs every
// CATALOG_YOLO_BACKFILL_INTERVAL_MIN (default 15m) and silently absorbs
// per-Media failures into ok/failed/skipped counters with only a
// console.log — a full batch where EVERY attempt failed (failed > 0 &&
// ok === 0) had no Slack signal at all. That is exactly the shape tonight's
// incident took before PR #403/#404's yolo:circuit-open fix covered the
// BREAKER path — this covers the sibling case where the backfill sweep
// itself is making zero progress (e.g. every detect hits a non-transient
// error the breaker never opens on) rather than the breaker being tripped.
//
// Fires only on the SECOND consecutive all-fail batch (~30 min of
// continuous zero-success at the default 15m interval), not the first —
// a single failing batch is common and often a transient blip that
// self-heals next tick; two in a row is a real signal worth paging on.
//
// Mirrors services/yoloLoadLimiter.js's consecutiveTransient pattern:
// in-memory, module-level, process-wide, resets to 0 on ANY success,
// exposed via __test for offline harnesses.

const alerts = require('./alertService');

let consecutiveZeroBatches = 0;
let lastErrorInfo = null;

/**
 * Call once per completed yoloBackfillTick batch (only when the batch
 * actually had targets — an empty tick is a no-op, not a zero-success
 * batch, and must not touch the counter).
 *
 * @param {object} o
 * @param {number} o.ok      successful detects this batch
 * @param {number} o.failed  failed detects this batch
 * @param {number} o.batchSize  targets attempted this batch
 * @param {{kind?:string, message?:string}} [o.lastError] last per-Media
 *        failure this batch, for the alert's diagnostic fields
 * @returns {{alerted:boolean, consecutive:number}}
 */
function recordBatchOutcome({ ok = 0, failed = 0, batchSize = 0, lastError = null } = {}) {
  if (ok > 0) {
    consecutiveZeroBatches = 0;
    lastErrorInfo = null;
    return { alerted: false, consecutive: 0 };
  }
  if (!(failed > 0)) {
    // Nothing attempted or nothing failed — not a zero-success SIGNAL,
    // leave the counter untouched (do not reset — a batch with zero
    // targets says nothing about whether the previous zero-success
    // streak is over).
    return { alerted: false, consecutive: consecutiveZeroBatches };
  }

  consecutiveZeroBatches += 1;
  if (lastError) lastErrorInfo = lastError;

  if (consecutiveZeroBatches < 2) {
    return { alerted: false, consecutive: consecutiveZeroBatches };
  }

  alerts.notifyAsync({
    level: 'error',
    title: `YOLO backfill — ${consecutiveZeroBatches} consecutive zero-success batches`,
    key: 'yolo:backfill-zero',
    fields: {
      'batch size': batchSize == null ? '-' : batchSize,
      'consecutive zero-success batches': consecutiveZeroBatches,
      'last error kind': (lastErrorInfo && lastErrorInfo.kind) || '-',
      'last error message': (lastErrorInfo && lastErrorInfo.message) || '-'
    },
    detail: 'Every catalog YOLO backfill detect attempt has failed for at least two consecutive ticks — the sweep is making no progress. Check the YOLO microservice.'
  });

  return { alerted: true, consecutive: consecutiveZeroBatches };
}

function resetForTest() {
  consecutiveZeroBatches = 0;
  lastErrorInfo = null;
}

module.exports = {
  recordBatchOutcome,
  __test: {
    reset: resetForTest,
    consecutiveZeroBatchesNow: () => consecutiveZeroBatches,
    lastErrorInfoNow: () => lastErrorInfo
  }
};
