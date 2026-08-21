'use strict';
// renderer role — Phase 0 no-op poller.
//
// Phase 1 wires this to:
//   1. Claim an Ad atomically: findOneAndUpdate({status:'rendering', claimedByWorker:null, ...}, {$set:{claimedByWorker, claimedAt}})
//   2. Route by renderRoute (html_gen → directImageRenderService; veo → atlasVideoService + brandScriptExecutor)
//   3. Stamp spend receipt (Ad.imageGeneration.predictionId or Ad.veoPredictionId)
//   4. Do the actual work (Atlas submit, Remotion titling, Sharp composite, Cloudinary upload)
//   5. Vision QC (with regen cap = 1 for static)
//   6. Finalize Ad (renderUrl + status='draft')
//   7. Release claim on failure so a peer can retry
//
// Phase 0 just proves the poll loop runs + Mongo is reachable + we can
// SEE unclaimed rendering ads without touching them. No writes.

const { POLL_MS, WORKER_ID } = require('../config');
const {
  isStaleTopologyError,
  reconnectAfterStaleTopology,
  resetReconnectAttempts
} = require('../db');
const Ad = require('../models/Ad');

let stopping = false;

async function poll() {
  const start = Date.now();
  try {
    // Read-only: peek at the queue depth. Would-be claim query shape,
    // but with count() instead of findOneAndUpdate — Phase 0 never
    // writes to Ads.
    const unclaimed = await Ad.countDocuments({
      status: 'rendering',
      claimedByWorker: null,
      $or: [
        // Statics — no dependency
        { renderRoute: 'html_gen' },
        // Video masters — no dependency (no deriveFromMaster)
        { renderRoute: 'veo', deriveFromMaster: null },
        // Video derives — only claimable once master URL exists
        { renderRoute: 'veo', deriveFromMaster: { $ne: null }, veoVideoUrl: { $ne: null } }
      ]
    });
    if (unclaimed > 0) {
      console.log(`renderer[${WORKER_ID}]: ${unclaimed} claimable ad(s) in queue — Phase 0 no-op`);
    }
    // Successful query = SDAM is healthy = reconnect budget resets.
    resetReconnectAttempts();
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: poll error — ${err.message}`);
    if (isStaleTopologyError(err)) {
      reconnectAfterStaleTopology();
    }
  }
  const elapsed = Date.now() - start;
  const wait = Math.max(50, POLL_MS - elapsed);
  if (!stopping) setTimeout(poll, wait);
}

async function run() {
  console.log(`renderer[${WORKER_ID}] starting — poll interval ${POLL_MS}ms`);
  poll();
  setInterval(() => {
    if (!stopping) console.log(`renderer[${WORKER_ID}] alive — uptime ${Math.round(process.uptime())}s`);
  }, 30_000).unref();
}

function shutdown() {
  stopping = true;
  console.log(`renderer[${WORKER_ID}] shutting down`);
}

module.exports = { run, shutdown };
