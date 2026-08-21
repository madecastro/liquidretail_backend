'use strict';
// orchestrator role — Phase 0 no-op poller.
//
// Phase 2 wires this to:
//   1. Acquire distributed lease (services/singletonLease.js pattern from backend)
//   2. Poll CampaignRun.status='preparing'
//   3. Expand (Director + Judge + mint Ads)
//   4. Claim ads into status='rendering'
//   5. Emit run heartbeat
//
// Phase 0 just proves the container boots + Mongo is reachable + the poll
// loop runs on schedule. No writes. No prod impact.

const { POLL_MS, WORKER_ID } = require('../config');
const CampaignRun = require('../models/CampaignRun');

let stopping = false;

async function poll() {
  const start = Date.now();
  try {
    // Read-only: count preparing runs so we log something meaningful.
    // No claim, no state change.
    const preparingCount = await CampaignRun.countDocuments({ status: 'preparing' });
    if (preparingCount > 0) {
      console.log(`orchestrator[${WORKER_ID}]: ${preparingCount} preparing run(s) — Phase 0 no-op`);
    }
  } catch (err) {
    console.warn(`orchestrator[${WORKER_ID}]: poll error — ${err.message}`);
  }
  const elapsed = Date.now() - start;
  const wait = Math.max(50, POLL_MS - elapsed);
  if (!stopping) setTimeout(poll, wait);
}

async function run() {
  console.log(`orchestrator[${WORKER_ID}] starting — poll interval ${POLL_MS}ms`);
  poll();
  // 30s heartbeat so an idle log stream still shows liveness.
  setInterval(() => {
    if (!stopping) console.log(`orchestrator[${WORKER_ID}] alive — uptime ${Math.round(process.uptime())}s`);
  }, 30_000).unref();
}

function shutdown() {
  stopping = true;
  console.log(`orchestrator[${WORKER_ID}] shutting down`);
}

module.exports = { run, shutdown };
