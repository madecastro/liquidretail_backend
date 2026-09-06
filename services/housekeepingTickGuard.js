'use strict';
//
// In-process re-entrancy guard for worker housekeeping ticks.
// One boolean per named tick. No Mongo — empty on boot is correct
// (the previous process died; a new tick may run).
//
// Used by post-sync-reconcile, yolo-backfill, queued-archive, and
// watchdog. NOT used by recoverTick / reapOrphans (money paths).

function createTickGuard(name) {
  let inFlight = false;
  return async function run(fn) {
    if (inFlight) {
      console.log(`⏭️  ${name}: skipped (already in flight)`);
      return { skipped: true, reason: 'reentrant' };
    }
    inFlight = true;
    try {
      return await fn();
    } finally {
      inFlight = false;
    }
  };
}

module.exports = { createTickGuard };
