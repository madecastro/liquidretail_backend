// Process-lifecycle alerting: boot, crash, and shutdown.
//
// Before this module the backend had ZERO uncaughtException /
// unhandledRejection handlers. On Node 20 an unhandled rejection is fatal
// by default, so any stray rejection inside a fire-and-forget render loop
// killed the whole web process — taking every in-flight video generation
// with it — and the only trace was a stack in the Render log that nobody
// was watching.
//
// EXIT SEMANTICS ARE PRESERVED. Node's defaults are: uncaught exception →
// print + exit(1); unhandled rejection → same; SIGTERM/SIGINT → die by the
// signal. Installing a listener SUPPRESSES the default, so termination is
// re-established explicitly: crashes exit(1) from a finally (unconditional,
// even if the handler throws), and signals re-raise so co-resident cleanup
// handlers (puppeteer closes Chrome on SIGTERM) still run — backed by a
// hard 1s exit timer, because those handlers do NOT exit and re-raise alone
// would leave the process alive until Render SIGKILLs it.
//
// Inside the ~FLUSH_MS shutdown window (default 2.5s) we do two things in
// parallel: send the Slack alert AND persist a diagnostic for any ads
// this process had in flight (requeue rendering→queued, stamp a shutdown
// row on CampaignRun.errors[], flip the run failed). Without the persist
// step the reaper would eventually notice ~15 min later, but with an
// empty errors[] and 0/0/0 counters — the "silent stall" pattern we hit
// on the Allbirds 2026-07-28 20:07 UTC run.

const alerts   = require('./alertService');
const inFlight = require('./inFlight');
// Load-bearing: persistOrphans is the only requeue site that runs on every
// SIGTERM, so losing this import silently disables both the requeue and the
// run-failure diagnostic (ReferenceError aborts the Promise.all array eval).
const { receiptFree } = require('./spendReceipt');

const FLUSH_MS = () => Math.max(250, Math.min(parseInt(process.env.ALERT_EXIT_FLUSH_MS || '2500', 10), 10000));

let installed = false;
let terminating = false;   // re-entrancy guard: a second signal must not re-run the handler

// Bound how long we hold the process open to deliver a message. Never
// rejects, never exceeds the cap.
function flush(promise) {
  return Promise.race([
    Promise.resolve(promise).catch(() => false),
    new Promise((r) => setTimeout(() => r(false), FLUSH_MS()))
  ]).catch(() => false);
}

function inFlightFields() {
  const s = inFlight.snapshot();
  if (s.runCount === 0) return { fields: { 'in flight': 'nothing' }, detail: null };
  return {
    fields: {
      'runs in flight':  s.runCount,
      'ads orphaned':    s.adsRemaining,
      'oldest run':      `${Math.round(s.oldestAgeMs / 1000)}s`
    },
    detail: s.lines.join('\n')
  };
}

// Persist a diagnostic for ads left in-flight when the process is going
// down. Two writes, both scoped to THIS process's runIds:
//   1. Requeue rendering ads back to queued so a subsequent worker cycle
//      (or the queued-drain endpoint) picks them up without waiting on
//      the 15-min reaper.
//   2. Push a synthetic shutdown row onto CampaignRun.errors[] and mark
//      the run failed — the run itself is over, and the empty errors[]
//      + 0/0/0 counts pattern we saw on the Allbirds 20:07 UTC failure
//      leaves operators with no signal to debug from.
//
// This runs inside the shutdown flush window (~FLUSH_MS, default 2.5s),
// in parallel with the Slack alert. Skipped entirely if Mongoose
// isn't connected — e.g. a crash during boot before the DB came up —
// so the shutdown path never blocks on a dead connection.
async function persistOrphans({ signal, role }) {
  const s = inFlight.snapshot();
  if (s.adsRemaining === 0) return;

  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    console.warn(`⚠️  ${signal} orphan persist skipped — mongoose not connected (readyState=${mongoose.connection.readyState})`);
    return;
  }

  const Ad = require('../models/Ad');
  const CampaignRun = require('../models/CampaignRun');
  const now = new Date();
  const stage = 'shutdown';
  const message = `${role} process ${signal} at ${now.toISOString()} — ${s.adsRemaining} ad(s) requeued`;

  try {
    const [adRes, runRes] = await Promise.all([
      // RECEIPT-AWARE (2026-08-04). This requeue runs on EVERY SIGTERM, so it
      // fires on every deploy — which makes it the more dangerous of the two
      // requeue sites (the worker reaper only sweeps every 15 minutes).
      //
      // An ad holding a spend receipt (Ad.veoPredictionId for video,
      // imageGeneration.predictionId for static) has ALREADY been billed —
      // the provider charged at submit. Requeuing it means the next run
      // SUBMITS AGAIN and we pay twice for a generation Atlas may have
      // already delivered. Measured today: a 411s Omni master completed at
      // 17:27:09 and this path requeued its run one second later.
      //
      // Receipt-FREE ads are requeued exactly as before: they were never
      // billed, so re-running them costs the one charge that was always owed.
      // Receipt-holding ads stay in `rendering` on purpose — honest (the
      // outcome is genuinely unknown until the receipt is polled), still
      // visible to ALERT_RENDERING_STALE_MIN, and the receipt survives so the
      // asset can be recovered for free instead of re-bought.
      Ad.updateMany(
        receiptFree({ campaignRunIds: { $in: s.runIds }, status: 'rendering' }),
        { $set: { status: 'queued', updatedAt: now, wasRendering: true } }
      ),
      CampaignRun.updateMany(
        { runId: { $in: s.runIds }, status: { $nin: ['done', 'failed'] } },
        {
          $set: { status: 'failed', completedAt: now },
          $push: { errors: { stage, message } }
        }
      )
    ]);
    console.log(`🛑 orphan persist: requeued ${adRes.modifiedCount} ad(s), marked ${runRes.modifiedCount} run(s) failed`);
  } catch (err) {
    // Best-effort — the alert is still going out with the orphan count,
    // and the reaper will eventually catch what we couldn't.
    console.error(`🛑 orphan persist failed: ${err && err.message}`);
  }
}

/**
 * Install the handlers. Idempotent — safe if both index.js and worker.js
 * call it in the RUN_WORKER=true single-process mode.
 *
 * @param {object} o
 * @param {string} o.role  'web' | 'worker' — labels the alerts
 */
function installProcessAlerts({ role = 'web' } = {}) {
  if (installed) return;
  installed = true;
  if (!process.env.ALERT_ROLE) process.env.ALERT_ROLE = role;

  // ── boot ──
  // info-level, so it is muted at the default ALERT_MIN_LEVEL=warn. Set
  // ALERT_MIN_LEVEL=info to watch restarts live — that is what would have
  // made today's unexplained 19:00 instance replacement obvious in seconds.
  alerts.notifyAsync({
    level: 'info',
    title: `${role} started`,
    key:   `boot:${role}`,
    fields: {
      commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 8) || undefined,
      node:   process.version
    }
  });

  // ── crashes ──
  // Both handlers are structured the same way and for the same reason: the
  // exit MUST happen in a finally. If anything in the body threw, the async
  // handler would return a rejected promise nobody awaits — which re-enters
  // the unhandledRejection handler and, worse, skips the exit, leaving the
  // process limping on in a state Node would have killed. The finally makes
  // termination unconditional.
  const crashHandler = (kind, code) => async (thrown) => {
    try {
      console.error(`💥 ${kind}:`, thrown);
      if (terminating) return;
      terminating = true;
      const { fields, detail } = inFlightFields();
      const msg = (thrown && thrown.message) ? String(thrown.message) : String(thrown);
      // Persist orphans and send the alert in parallel — both share the
      // one flush window before we exit. persistOrphans is best-effort
      // and swallows its own errors, so it can't reject the race.
      await flush(Promise.all([
        alerts.notify({
          level:  'fatal',
          title:  `${role} crashed — ${kind}`,
          key:    `${kind}:${role}:${msg.slice(0, 80)}`,
          fields: { error: msg, ...fields },
          detail: [(thrown && thrown.stack) ? thrown.stack : msg, detail].filter(Boolean).join('\n\n')
        }),
        persistOrphans({ signal: kind, role })
      ]));
    } catch (e) {
      try { console.error(`💥 ${kind} handler itself failed: ${e && e.message}`); } catch { /* ignore */ }
    } finally {
      process.exit(code);
    }
  };

  // Node's defaults: an uncaught exception exits 1, and since Node 15 an
  // unhandled rejection is treated the same way. Both preserved.
  process.on('uncaughtException',  crashHandler('uncaughtException',  1));
  process.on('unhandledRejection', crashHandler('unhandledRejection', 1));

  // ── shutdown ──
  // Render sends SIGTERM when it replaces an instance: a deploy, a manual
  // restart, or an autoscale scale-in. On the web service that is the exact
  // moment in-flight video runs are lost, so the alert reports the damage.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const onSignal = async () => {
      try {
        if (terminating) return;
        terminating = true;
        const { fields, detail } = inFlightFields();
        const orphaned = inFlight.snapshot().adsRemaining;
        console.log(`🛑 ${sig} received — ${orphaned} ad(s) in flight will be orphaned`);
        // Persist orphans and send the alert in parallel — both share
        // the one flush window before the exit timer fires. When
        // orphaned=0 persistOrphans no-ops immediately, so a clean
        // shutdown pays nothing.
        await flush(Promise.all([
          alerts.notify({
            // Losing queued work is worth waking up for; a clean shutdown isn't.
            level:  orphaned > 0 ? 'error' : 'info',
            title:  orphaned > 0
              ? `${role} shutting down with ${orphaned} ad(s) in flight`
              : `${role} shutting down cleanly`,
            key:    `${sig}:${role}`,
            fields: { signal: sig, ...fields },
            detail
          }),
          persistOrphans({ signal: sig, role })
        ]));
      } catch (e) {
        try { console.error(`🛑 ${sig} handler failed: ${e && e.message}`); } catch { /* ignore */ }
      } finally {
        // Termination must be GUARANTEED. Re-raising after removing this
        // listener only restores Node's default disposition if this was the
        // LAST listener — and it is not: puppeteer registers its own
        // SIGTERM/SIGINT handler on every launch (handleSIGTERM defaults to
        // true; none of this repo's five launch sites disable it), and that
        // handler closes the browser WITHOUT exiting. Re-raise alone would
        // therefore leave the process alive until Render SIGKILLs it,
        // stalling every deploy (reproduced: alive at 6s with a
        // puppeteer-style listener).
        //
        // So: arm an unstoppable exit timer FIRST, then re-raise. The
        // re-raise lets puppeteer's cleanup close Chrome; the timer
        // guarantees death ~1s later with the conventional 128+signo code
        // even if no other listener exits. unref() would be wrong here —
        // an emptied event loop must still hit the exit path deliberately.
        const code = 128 + (sig === 'SIGINT' ? 2 : 15);
        setTimeout(() => process.exit(code), 1000);
        process.removeListener(sig, onSignal);
        process.kill(process.pid, sig);
      }
    };
    process.on(sig, onSignal);
  }
}

module.exports = { installProcessAlerts };
