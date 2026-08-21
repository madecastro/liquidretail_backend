'use strict';
// renderer role — Phase 1a MOCK implementation.
//
// Real claim + release loop, but the "render" itself is a 5s sleep +
// mock renderUrl stamp. Purpose: prove the atomic claim handshake works
// end-to-end between backend and adgen before any real render code
// moves. Phase 1b swaps mockRender() for the real atlasImageService /
// atlasVideoService / Remotion pipeline.
//
// Handoff gate: reads ADGEN_RENDERER_ENABLED. When false, sleeps (no
// claims). Backend's runRenderLoop reads the same flag and continues
// its own in-process render loop. Both services flip together.
//
// Claim shape (money-invariant preserved from CLAUDE.md §2 atomic claim):
//   Ad.findOneAndUpdate(
//     { status: 'rendering', claimedByWorker: null,
//       $or: [
//         { renderRoute: 'html_gen' },
//         { renderRoute: 'veo', deriveFromMaster: null },
//         { renderRoute: 'veo', deriveFromMaster: { $ne: null },
//           veoVideoUrl: { $ne: null } }
//       ] },
//     { $set: { claimedByWorker: WORKER_ID, claimedAt: new Date() } },
//     { new: true, sort: { createdAt: 1 } }
//   )
//
// The $or block gates derives on their master being complete — a derive
// worker never claims an ad whose master hasn't landed.
//
// Sort by createdAt is the Phase-1a fairness mechanism: FIFO within the
// claimable set. Proper weighted fair queuing across tenants lands later
// if we see starvation at load.

const { POLL_MS, WORKER_ID, MOCK_WORK_MS, isAdgenRendererEnabled } = require('../config');
const {
  isStaleTopologyError,
  reconnectAfterStaleTopology,
  resetReconnectAttempts
} = require('../db');
const Ad = require('../models/Ad');

let stopping = false;

// Atomic claim: races safely across N renderer instances via the
// findOneAndUpdate filter on {claimedByWorker:null}. Returns the claimed
// Ad doc or null if nothing available.
async function claimOne() {
  return Ad.findOneAndUpdate(
    {
      status:          'rendering',
      claimedByWorker: null,
      $or: [
        { renderRoute: 'html_gen' },
        { renderRoute: 'veo', deriveFromMaster: null },
        { renderRoute: 'veo', deriveFromMaster: { $ne: null }, veoVideoUrl: { $ne: null } }
      ]
    },
    {
      $set: {
        claimedByWorker: WORKER_ID,
        claimedAt:       new Date()
      }
    },
    {
      new:  true,
      sort: { createdAt: 1 }
    }
  );
}

// Phase 1a mock: sleep MOCK_WORK_MS, stamp a fake renderUrl, flip status
// to 'draft'. NO Atlas calls, NO Remotion, NO Cloudinary — this only
// proves the ownership handshake. Phase 1b replaces this function.
async function mockRender(ad) {
  const adId = String(ad._id);
  console.log(`renderer[${WORKER_ID}]: MOCK render start ad=${adId.slice(-6)} route=${ad.renderRoute} platformFormat=${ad.platformFormat}`);
  await new Promise((r) => setTimeout(r, MOCK_WORK_MS));
  const mockUrl = `mock://phase1a/${adId}.${ad.renderRoute === 'veo' ? 'mp4' : 'png'}`;
  await Ad.updateOne(
    { _id: ad._id, claimedByWorker: WORKER_ID },
    {
      $set: {
        status:      'draft',
        renderUrl:   mockUrl,
        renderedAt:  new Date(),
        // Clear the claim so recovery paths + the Ads inspector don't see
        // a ghost worker owning a terminal-state ad. Post-render, the
        // claim has served its purpose.
        claimedByWorker: null
      }
    }
  );
  console.log(`renderer[${WORKER_ID}]: MOCK render done  ad=${adId.slice(-6)} url=${mockUrl}`);
}

// Fail-safe release: if mockRender throws, unclaim so a peer worker (or
// this worker on next poll) can retry. Never leaves an ad claimed by a
// dead worker.
async function releaseClaim(adId) {
  try {
    await Ad.updateOne(
      { _id: adId, claimedByWorker: WORKER_ID },
      { $set: { claimedByWorker: null, claimedAt: null } }
    );
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: release claim failed for ${adId}: ${err.message}`);
  }
}

async function poll() {
  const start = Date.now();
  try {
    // Handoff gate — Phase 1a. If backend is still running its own
    // render loop (ADGEN_RENDERER_ENABLED=false), do not poll. Sleep
    // until the next tick and re-check the flag then.
    if (!isAdgenRendererEnabled()) {
      resetReconnectAttempts();
      scheduleNext(start);
      return;
    }

    const ad = await claimOne();
    resetReconnectAttempts();
    if (!ad) {
      // Empty queue — normal. Wait a tick.
      scheduleNext(start);
      return;
    }

    try {
      await mockRender(ad);
    } catch (err) {
      console.error(`renderer[${WORKER_ID}]: mock render failed ad=${String(ad._id).slice(-6)}: ${err.message}`);
      await releaseClaim(ad._id);
    }
  } catch (err) {
    console.warn(`renderer[${WORKER_ID}]: poll error — ${err.message}`);
    if (isStaleTopologyError(err)) {
      reconnectAfterStaleTopology();
    }
  }
  scheduleNext(start);
}

function scheduleNext(startTs) {
  const elapsed = Date.now() - startTs;
  const wait = Math.max(50, POLL_MS - elapsed);
  if (!stopping) setTimeout(poll, wait);
}

async function run() {
  const gated = isAdgenRendererEnabled();
  console.log(`renderer[${WORKER_ID}] starting — poll interval ${POLL_MS}ms, handoff gate ${gated ? 'ON (claiming)' : 'OFF (sleeping)'}, mock work ${MOCK_WORK_MS}ms`);
  poll();
  setInterval(() => {
    if (stopping) return;
    const g = isAdgenRendererEnabled();
    console.log(`renderer[${WORKER_ID}] alive — uptime ${Math.round(process.uptime())}s, handoff ${g ? 'ON' : 'OFF'}`);
  }, 30_000).unref();
}

function shutdown() {
  stopping = true;
  console.log(`renderer[${WORKER_ID}] shutting down`);
}

module.exports = { run, shutdown };
