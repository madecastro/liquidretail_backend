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
// would leave the process alive until Render SIGKILLs it. The only additive
// change is a bounded (default 2.5s) window to flush one Telegram message
// first.

const alerts   = require('./alertService');
const inFlight = require('./inFlight');

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
      await flush(alerts.notify({
        level:  'fatal',
        title:  `${role} crashed — ${kind}`,
        key:    `${kind}:${role}:${msg.slice(0, 80)}`,
        fields: { error: msg, ...fields },
        detail: [(thrown && thrown.stack) ? thrown.stack : msg, detail].filter(Boolean).join('\n\n')
      }));
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
        await flush(alerts.notify({
          // Losing queued work is worth waking up for; a clean shutdown isn't.
          level:  orphaned > 0 ? 'error' : 'info',
          title:  orphaned > 0
            ? `${role} shutting down with ${orphaned} ad(s) in flight`
            : `${role} shutting down cleanly`,
          key:    `${sig}:${role}`,
          fields: { signal: sig, ...fields },
          detail
        }));
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
