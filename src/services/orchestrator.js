'use strict';
// orchestrator role — Phase 0 no-op poller, now with the distributed
// lease wired so a second instance cannot even run the read-only poll.
//
// THIS PR IS THE GATING PREREQUISITE FOR EXPANSION, NOT EXPANSION.
// Do not wire expandWizardJob, Director, Judge, mint, or brief-derivation
// here. Do not "simplify" this file by folding those in: the only new
// behaviour is acquire → heartbeat → gate the existing
// countDocuments({status:'preparing'}) log on holding → release on
// shutdown. The reason this file is touched at all is to prove the
// lease works in the real boot path.
//
// Phase 2 (not this PR) still owns:
//   1. Acquire distributed lease  ← DONE here
//   2. Poll CampaignRun.status='preparing'  ← still read-only
//   3. Expand (Director + Judge + mint Ads)
//   4. Claim ads into status='rendering'
//   5. Emit run heartbeat
//
// render.yaml's adgen-orchestrator block advertises "distributed lease
// handles failover" but never named a lease; this file picks the name.
// Do not rename it without a migration — a new name is a new lease doc,
// so during a rolling deploy an old instance holding the OLD name and a
// new instance holding the NEW one would both believe they are the
// singleton, which is exactly the two-expander case this prevents.

const { POLL_MS, WORKER_ID } = require('../config');
const {
  isStaleTopologyError,
  reconnectAfterStaleTopology,
  resetReconnectAttempts
} = require('../db');
const CampaignRun = require('../models/CampaignRun');
const { createSingletonLease } = require('./singletonLease');

const LEASE_NAME = 'adgen-orchestrator-expansion';

// Same env the renderer / titler / regenerateConsumer read. Render sends
// SIGTERM ~30s before SIGKILL; SHUTDOWN_DRAIN_MS is the station-wide
// budget those stations honour for in-flight work. We have no expansion
// to drain (Phase 0), so we must not sit on that whole window — leave
// room for entrypoint's disconnect(). The release write is raced against
// the smaller ADGEN_SHUTDOWN_ALERT_MS bound (same shape regenerateConsumer
// uses for its Slack notify). min() so an operator who sets ALERT > DRAIN
// cannot blow the SIGTERM window.
const SHUTDOWN_DRAIN_MS = Number(process.env.ADGEN_SHUTDOWN_DRAIN_MS || 25_000);
const SHUTDOWN_ALERT_MS = Number(process.env.ADGEN_SHUTDOWN_ALERT_MS || 4_000);

let stopping = false;
let lease = null;
// Local flag, NOT lease.holds(), is the poll gate. onLost flips this from
// the heartbeat timer; the poll loop is the only path that may acquire.
let holding = false;
// Standing-by is a normal outcome (Render can launch a 2nd instance).
// POLL_MS defaults to 500ms — logging it every tick is a log flood.
// Log once per transition into standby; reset on win / onLost.
let standbyAnnounced = false;

function onLeaseLost(reason) {
  // Do not re-acquire from here. This callback fires from the heartbeat
  // timer; re-entering acquire() from a timer races the poll loop and
  // can startHeartbeat twice. Flip the flag so the NEXT poll tick
  // retries — that is the only path that may call acquire().
  holding = false;
  standbyAnnounced = false;
  console.error(
    `orchestrator[${WORKER_ID}]: LEASE LOST (${reason}) — standing down; next poll will re-attempt acquire`
  );
}

async function poll() {
  if (stopping) return;
  const start = Date.now();
  try {
    if (!holding) {
      const won = await lease.acquire();
      if (won) {
        holding = true;
        standbyAnnounced = false;
        // SIGTERM can land during the acquire await. If we won on the
        // way out, do not startHeartbeat — shutdown() owns the one
        // release path and will drop this fence. Do not "fix" this by
        // releasing here (two release paths, easy to drop one).
        if (!stopping) {
          lease.startHeartbeat();
          console.log(
            `orchestrator[${WORKER_ID}]: lease acquired — fence token ${lease.fenceToken()}`
          );
        }
      } else if (!standbyAnnounced) {
        standbyAnnounced = true;
        console.log(`orchestrator[${WORKER_ID}]: standing by — lease held elsewhere`);
      }
    }

    // The whole point of the lease: the existing read-only poll body
    // runs only while we hold. A standby instance must not even log
    // preparing counts — that would make a 2nd instance look live.
    if (holding && !stopping) {
      // Read-only: count preparing runs so we log something meaningful.
      // No claim, no state change.
      const preparingCount = await CampaignRun.countDocuments({ status: 'preparing' });
      if (preparingCount > 0) {
        console.log(`orchestrator[${WORKER_ID}]: ${preparingCount} preparing run(s) — Phase 0 no-op`);
      }
    }
    // Successful query (acquire and/or countDocuments) = SDAM is healthy
    // = reconnect budget resets. Keep this even on the standby path:
    // acquire() is the Mongo contact a non-holder still makes every tick.
    resetReconnectAttempts();
  } catch (err) {
    console.warn(`orchestrator[${WORKER_ID}]: poll error — ${err.message}`);
    if (isStaleTopologyError(err)) {
      // Fire-and-forget; the reconnect guard inside db.js serialises
      // concurrent callers so this is safe from the timer loop.
      reconnectAfterStaleTopology();
    }
  }
  const elapsed = Date.now() - start;
  const wait = Math.max(50, POLL_MS - elapsed);
  if (!stopping) setTimeout(poll, wait);
}

async function run() {
  lease = createSingletonLease(LEASE_NAME, { onLost: onLeaseLost });
  console.log(
    `orchestrator[${WORKER_ID}] starting — poll interval ${POLL_MS}ms, lease ${LEASE_NAME}`
  );
  poll();
  // 30s heartbeat so an idle log stream still shows liveness.
  setInterval(() => {
    if (!stopping) {
      console.log(
        `orchestrator[${WORKER_ID}] alive — uptime ${Math.round(process.uptime())}s` +
        (holding ? ' (lease holder)' : ' (standing by)')
      );
    }
  }, 30_000).unref();
}

async function shutdown() {
  if (stopping) return;
  // Stop the poll FIRST so no new acquire can land, then release.
  // An in-flight acquire that wins after this flag flips is covered
  // by the !stopping guard around startHeartbeat; shutdown still
  // releases that fence below.
  stopping = true;
  console.log(`orchestrator[${WORKER_ID}] shutting down`);
  if (!lease) return;

  // Bound the release write. An unreleased lease is survivable but
  // undesirable: singletonLease expires on its own after ttlMs, so the
  // worst case is a delay of one TTL before a replacement instance can
  // expand — never a deadlock, and never two holders. Still, eating the
  // whole SIGTERM budget on a hung Mongo would delay disconnect() and
  // get us SIGKILL'd mid-write, so we race a smaller bound. Do not
  // "simplify" this to an unbounded await — Render sends SIGTERM ~30s
  // before SIGKILL (renderer.js SHUTDOWN_DRAIN_MS).
  const releaseBoundMs = Math.min(SHUTDOWN_ALERT_MS, SHUTDOWN_DRAIN_MS);
  let timedOut = false;
  let timer;
  try {
    await Promise.race([
      lease.release(),
      new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, releaseBoundMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) {
    console.warn(
      `orchestrator[${WORKER_ID}]: lease release timed out after ${releaseBoundMs}ms — ` +
      `unreleased lease expires on its own after ttlMs`
    );
  }
  holding = false;
}

module.exports = { run, shutdown, LEASE_NAME, SHUTDOWN_DRAIN_MS, SHUTDOWN_ALERT_MS };
