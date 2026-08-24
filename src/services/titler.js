'use strict';
// titler role — dark-launch scaffold for out-of-process Remotion titling.
//
// WHAT IT DOES TODAY (dark launch):
//   - Boots, connects Mongo (via entrypoint), logs "alive" heartbeat.
//   - If ADGEN_TITLER_ENABLED=true, polls for the handoff filter below;
//     otherwise sleeps indefinitely, heartbeating.
//   - When it claims a row, it currently RELEASES it immediately with a
//     "handoff-not-wired" log. The renderer still titles in-process on
//     the current codebase; wiring the actual titling in this file is
//     Phase 3 and lands with the renderer's atomic release + stamp of
//     titlingNeeded=true (single flag, two readers).
//
// WHY EXTRACT AT ALL. Under REMOTION_QUEUE_CONCURRENCY=2 (measured 1.97
// GiB/slot on 8 GiB Performance-Plus, adgen CLAUDE.md §concurrency), the
// full renderer fleet caps at ~16 titling slots. To hit 2000 video/hr we
// need ~110 slots. A dedicated titler service:
//   - Gets ALL the memory budget to Chrome (no poll loop, no Atlas HTTP,
//     no static gpt-image-2/edit competition on the same instance).
//   - Autoscales independently on titling-queue depth, not overall renderer
//     load.
//   - Can safely run REMOTION_QUEUE_CONCURRENCY=4-6 on 8 GiB when nothing
//     else contends.
//
// THE HANDOFF FILTER (what the flag turns on):
//   {
//     status: 'rendering',           // reaper-safe (receipt-holding rows)
//     veoVideoUrl: { $ne: null },    // Omni master delivered
//     titlingNeeded: true,           // renderer stamped this atomic with release
//     claimedByWorker: null          // idle
//   }
// Sort by createdAt:1 — FIFO, matches renderer's own claim sort.
//
// SHUTDOWN: mirrors renderer.shutdown — drain in-flight titling promises up
// to 25s, then release any remaining claim for peer pickup. Graceful for
// Render's SIGTERM + 30s draining window.

const { POLL_MS, WORKER_ID, MAX_INFLIGHT, isTitlerEnabled } = require('../config');
const {
  isStaleTopologyError,
  reconnectAfterStaleTopology,
  resetReconnectAttempts
} = require('../db');
const Ad = require('../models/Ad');

const HEARTBEAT_MS = 30_000;
const SHUTDOWN_DRAIN_MS = 25_000;

const state = {
  running: false,
  shuttingDown: false,
  inFlight: new Set(),                 // ad._id strings currently being titled
  heartbeatTimer: null,
  pollTimer: null,
  startedAt: null,
};

function log(msg) {
  console.log(`titler[${WORKER_ID}]: ${msg}`);
}

function heartbeatOnce() {
  const uptime = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  const gate = isTitlerEnabled() ? 'ON' : 'OFF';
  log(`alive — uptime ${uptime}s, inflight ${state.inFlight.size}/${MAX_INFLIGHT}, handoff ${gate}`);
}

// Atomic claim — same shape as renderer.claimOne. FIFO by createdAt.
// Field `titlingNeeded` is not yet in the Ad schema; Mongoose strict mode
// drops undeclared writes silently, so a runtime doc missing the field
// simply won't match `titlingNeeded: true`. When Phase 3 adds the field to
// models/Ad.js and the renderer writes it, this filter picks up work
// without change here.
async function claimOne() {
  return await Ad.findOneAndUpdate(
    {
      status:          'rendering',
      veoVideoUrl:     { $ne: null },
      titlingNeeded:   true,
      claimedByWorker: null,
    },
    { $set: { claimedByWorker: WORKER_ID, claimedAt: new Date() } },
    { new: true, sort: { createdAt: 1 } }
  );
}

async function releaseClaim(adId, reason = null) {
  try {
    await Ad.updateOne(
      { _id: adId, claimedByWorker: WORKER_ID },
      { $set: { claimedByWorker: null, claimedAt: null } }
    );
    if (reason) log(`released claim on ${String(adId).slice(-6)} — ${reason}`);
  } catch (err) {
    log(`release claim failed for ${adId}: ${err.message}`);
  }
}

// Phase 2 SCAFFOLD: claim → immediately release. Phase 3 replaces the
// release with the real Remotion titling call (renderBrandScriptAndSave)
// and the terminal Ad stamp. Explicit log so a monitor sees the handoff
// fire before the wiring lands.
async function processAd(ad) {
  const shortId = String(ad._id).slice(-6);
  state.inFlight.add(String(ad._id));
  try {
    log(`SCAFFOLD claim ad=${shortId} — releasing; real titling wired in Phase 3`);
    await releaseClaim(ad._id, 'handoff-not-wired');
  } catch (err) {
    log(`processAd threw for ad=${shortId}: ${err.message}`);
    await releaseClaim(ad._id, 'scaffold-error');
  } finally {
    state.inFlight.delete(String(ad._id));
  }
}

async function pollTick() {
  if (state.shuttingDown) return;
  if (!isTitlerEnabled()) return;                     // dark launch: gate closed → skip poll
  if (state.inFlight.size >= MAX_INFLIGHT) return;    // saturated

  try {
    while (!state.shuttingDown && state.inFlight.size < MAX_INFLIGHT) {
      const ad = await claimOne();
      if (!ad) break;
      // Unawaited by design — burst-claim, process concurrently.
      processAd(ad).catch((err) => log(`unhandled processAd error: ${err.message}`));
    }
    resetReconnectAttempts();
  } catch (err) {
    if (isStaleTopologyError(err)) {
      log(`stale topology (${err.message}) — reconnecting`);
      await reconnectAfterStaleTopology().catch((e) => log(`reconnect failed: ${e.message}`));
      return;
    }
    log(`poll error: ${err.message}`);
  }
}

async function run() {
  if (state.running) throw new Error('titler.run called twice');
  state.running = true;
  state.startedAt = Date.now();
  log(`starting — poll interval ${POLL_MS}ms, max-inflight ${MAX_INFLIGHT}, handoff gate ${isTitlerEnabled() ? 'ON (claiming)' : 'OFF (idle)'}`);

  heartbeatOnce();
  state.heartbeatTimer = setInterval(heartbeatOnce, HEARTBEAT_MS);
  state.heartbeatTimer.unref?.();

  // Kick the first poll immediately, then on interval. `setInterval` fires
  // pollTick synchronously and pollTick handles its own concurrency
  // guarding, so overlapping ticks are safe.
  await pollTick();
  state.pollTimer = setInterval(pollTick, POLL_MS);
  state.pollTimer.unref?.();
}

async function shutdown() {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  log(`shutting down — inflight=${state.inFlight.size}, drain up to ${SHUTDOWN_DRAIN_MS}ms`);

  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);

  const drainDeadline = Date.now() + SHUTDOWN_DRAIN_MS;
  while (state.inFlight.size > 0 && Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 250));
  }

  if (state.inFlight.size === 0) {
    log('clean drain in 0ms — no forced release needed');
    return;
  }

  // Force-release anything still in flight so a peer titler picks it up.
  // Mirrors renderer.shutdown — the ownership condition on releaseClaim
  // means we only ever clear our own worker id.
  const remaining = [...state.inFlight];
  log(`drain window exhausted — force-releasing ${remaining.length} claim(s) for peer pickup`);
  await Promise.all(remaining.map((id) => releaseClaim(id, 'sigterm-drain-timeout')));
}

module.exports = { run, shutdown };
