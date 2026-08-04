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
// Inside the ~FLUSH_MS shutdown window (default 4s) we do two things in
// SEQUENCE: first persist a diagnostic for any ads this process had in
// flight (requeue rendering→queued, stamp a shutdown row on
// CampaignRun.errors[], flip the run failed), THEN document + alert via
// crashReporter so the requeued ad ids, per-ad stages, charged-submit
// counts, commit, and uptime land in the same Slack message / IncidentLog
// row. Both share one flush window. Without the persist step the reaper
// would eventually notice ~15 min later, but with an empty errors[] and
// 0/0/0 counters — the "silent stall" pattern we hit on the Allbirds
// 2026-07-28 20:07 UTC run.

const alerts        = require('./alertService');
const inFlight      = require('./inFlight');
const crashReporter = require('./crashReporter');

// Sequential persist + IncidentLog + Slack needs more headroom than the
// old parallel flush. Floor 250ms / cap 10s unchanged.
const FLUSH_MS = () => Math.max(250, Math.min(parseInt(process.env.ALERT_EXIT_FLUSH_MS || '4000', 10), 10000));

let installed = false;
let terminating = false;   // re-entrancy guard: a second signal must not re-run the handler

// Bound how long we hold the process open to deliver a message. Never
// rejects, never exceeds the cap.
function flush(promise, ms) {
  const budget = Number.isFinite(ms) ? Math.max(50, ms) : FLUSH_MS();
  return Promise.race([
    Promise.resolve(promise).catch(() => false),
    new Promise((r) => setTimeout(() => r(false), budget))
  ]).catch(() => false);
}

// Share of the flush window persistOrphans may consume. The rest is RESERVED
// for crashReporter (IncidentLog write + Slack send).
//
// This split exists because making the two SEQUENTIAL — which is what lets the
// requeued ad ids reach the alert — also made them compete for one budget. With
// slow Mongo or many orphans, a find plus two updateManys can burn the whole
// window, and then the durable row and the Slack message (the entire point of
// this module) are the first things cut. Under the old parallel version Slack
// had the full window to itself, so this would have been a straight regression.
const PERSIST_SHARE = 0.45;

/**
 * Build the Slack fields + diagnostic detail for a crash/shutdown report.
 * Per-ad lines (stage, age, SUBMITTED/charged) are the core of the alert —
 * counts alone are not diagnosable. commit is added by crashReporter;
 * uptime is not, so we attach it here.
 */
function buildExitPayload({ signal, orphan, thrown = null }) {
  const s = inFlight.snapshot();
  const fields = {};

  try {
    fields.uptime = `${Math.floor(process.uptime())}s`;
  } catch { /* ignore */ }

  if (s.runCount === 0 && (!s.adIds || s.adIds.length === 0)) {
    fields['in flight'] = 'nothing';
  } else {
    if (s.runCount > 0) {
      fields['runs in flight'] = s.runCount;
      fields['ads orphaned']   = s.adsRemaining;
      fields['oldest run']     = `${Math.round(s.oldestAgeMs / 1000)}s`;
    }
    // Ads with a billable Atlas POST already returned — unrecoverable spend
    // if the process dies before veoPredictionId / status is durable.
    const charged = (s.submittedAdIds && s.submittedAdIds.length) || 0;
    fields['charged in flight'] = charged > 0
      ? `${charged} ad(s) — unrecoverable spend`
      : '0';
  }

  if (orphan) {
    if (orphan.requeuedCount > 0 || (orphan.requeuedAdIds && orphan.requeuedAdIds.length > 0)) {
      fields.requeued = orphan.requeuedCount;
      // "candidates" because the write re-asserts status:'rendering', so an ad
      // that finished mid-window is listed but was not requeued. `requeued` is
      // the authoritative count.
      fields[orphan.overReported ? 'requeue candidates' : 'requeued ads'] =
        orphan.requeuedAdIds.join(', ');
    }
    if (orphan.runsFailed > 0) {
      fields['runs failed'] = orphan.runsFailed;
    }
  }

  // SIGTERM is a deploy OR an autoscale scale-in — the process cannot
  // distinguish them. State both honestly; do not guess one.
  if (signal === 'SIGTERM') {
    fields['likely cause'] = 'deploy or autoscale scale-in';
  }

  if (thrown != null) {
    const msg = (thrown && thrown.message) ? String(thrown.message) : String(thrown);
    fields.error = msg;
  }

  // Detail: stack (crash) + per-ad lines + run lines. crashReporter uses
  // `diagnostic` as the Slack detail when present.
  const parts = [];
  if (thrown != null) {
    const msg = (thrown && thrown.message) ? String(thrown.message) : String(thrown);
    parts.push((thrown && thrown.stack) ? thrown.stack : msg);
  }
  if (s.adLines && s.adLines.length) parts.push(s.adLines.join('\n'));
  if (s.lines && s.lines.length) parts.push(s.lines.join('\n'));

  return {
    fields,
    diagnostic: parts.length ? parts.join('\n\n') : null,
    snapshot: s
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
// Runs FIRST inside the shutdown flush window (~FLUSH_MS, default 4s),
// BEFORE crashReporter, so the requeued ad ids can land in the alert.
// Skipped entirely if Mongoose isn't connected — e.g. a crash during
// boot before the DB came up — so the shutdown path never blocks on a
// dead connection. A persist failure still lets the alert go out.
//
// @returns {{ requeuedAdIds:string[], requeuedCount:number, runsFailed:number }}
async function persistOrphans({ signal, role }) {
  const empty = { requeuedAdIds: [], requeuedCount: 0, runsFailed: 0 };
  const s = inFlight.snapshot();
  if (s.adsRemaining === 0) return empty;

  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) {
    console.warn(`⚠️  ${signal} orphan persist skipped — mongoose not connected (readyState=${mongoose.connection.readyState})`);
    return empty;
  }

  const Ad = require('../models/Ad');
  const CampaignRun = require('../models/CampaignRun');
  const now = new Date();
  const stage = 'shutdown';
  const message = `${role} process ${signal} at ${now.toISOString()} — ${s.adsRemaining} ad(s) requeued`;

  try {
    // Find the matching _ids first so the alert can name them, then
    // update BY THAT ID LIST — keeps the write scoped exactly as the
    // previous filter (campaignRunIds ∈ this process's runs, status
    // rendering) and yields the ids for the payload.
    const orphanAds = await Ad.find(
      { campaignRunIds: { $in: s.runIds }, status: 'rendering' },
      { _id: 1 }
    ).lean();
    const idList = orphanAds.map((a) => a._id);
    const requeuedAdIds = idList.map((id) => String(id));

    const [adRes, runRes] = await Promise.all([
      // `status: 'rendering'` is RE-ASSERTED, not replaced by the id list. An
      // ad that finished in the window between the find and this update would
      // otherwise be flipped back to 'queued' and re-rendered later — a second
      // billable Omni submit (~$1) for work that already succeeded. The ids
      // are for the alert payload; the predicate is what keeps the write safe.
      idList.length
        ? Ad.updateMany(
            { _id: { $in: idList }, status: 'rendering' },
            { $set: { status: 'queued', updatedAt: now } }
          )
        : Promise.resolve({ modifiedCount: 0 }),
      CampaignRun.updateMany(
        { runId: { $in: s.runIds }, status: { $nin: ['done', 'failed'] } },
        {
          $set: { status: 'failed', completedAt: now },
          $push: { errors: { stage, message } }
        }
      )
    ]);
    console.log(`🛑 orphan persist: requeued ${adRes.modifiedCount} ad(s), marked ${runRes.modifiedCount} run(s) failed`);
    // requeuedCount comes from modifiedCount, NOT from the find list. The
    // write re-asserts `status: 'rendering'`, so an ad that finished in the
    // race window is deliberately skipped — reporting the find-list length
    // would claim we requeued work we did not touch. The id list can therefore
    // over-report by a racing ad; it is labelled "candidates" for that reason.
    const requeuedCount = Number(adRes.modifiedCount) || 0;
    return {
      requeuedAdIds,
      requeuedCount,
      overReported: requeuedAdIds.length !== requeuedCount,
      runsFailed: Number(runRes.modifiedCount) || 0
    };
  } catch (err) {
    // Best-effort — the alert is still going out with the orphan count,
    // and the reaper will eventually catch what we couldn't.
    console.error(`🛑 orphan persist failed: ${err && err.message}`);
    return empty;
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
  // Do not change level or remove: commit is only visible here at info, and
  // crash/shutdown now carry commit via crashReporter for the warn+ path.
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
  //
  // These are the two call sites where crashReporter.report is AWAITED —
  // they sit inside the bounded flush window before process death.
  // Everywhere else in the codebase it is fire-and-forget (reportSync).
  const crashHandler = (kind, code) => async (thrown) => {
    try {
      console.error(`💥 ${kind}:`, thrown);
      if (terminating) return;
      terminating = true;
      // Persist orphans FIRST so requeued ids reach the alert, then report.
      // Both share the one flush window before we exit. persistOrphans is
      // best-effort and never throws a rejection that escapes the race.
      const budget = FLUSH_MS();
      const persistMs = Math.round(budget * PERSIST_SHARE);
      // Bounded separately so a slow persist cannot starve the report.
      const orphan = (await flush(persistOrphans({ signal: kind, role }), persistMs))
        || { requeuedAdIds: [], requeuedCount: 0, runsFailed: 0 };
      await flush((async () => {
        const { fields, diagnostic, snapshot } = buildExitPayload({
          signal: kind,
          orphan,
          thrown
        });
        await crashReporter.report({
          kind,
          level: 'fatal',
          title: `${role} crashed — ${kind}`,
          err: thrown,
          diagnostic,
          fields,
          inFlight: snapshot
        });
      })(), budget - persistMs);
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
        const orphaned = inFlight.snapshot().adsRemaining;
        console.log(`🛑 ${sig} received — ${orphaned} ad(s) in flight will be orphaned`);
        // Persist orphans FIRST, then report — both share the one flush
        // window before the exit timer fires. When orphaned=0
        // persistOrphans no-ops immediately, so a clean shutdown pays
        // nothing beyond the crashReporter row + Slack send.
        const budget = FLUSH_MS();
        const persistMs = Math.round(budget * PERSIST_SHARE);
        const orphan = (await flush(persistOrphans({ signal: sig, role }), persistMs))
          || { requeuedAdIds: [], requeuedCount: 0, runsFailed: 0 };
        await flush((async () => {
          const { fields, diagnostic, snapshot } = buildExitPayload({
            signal: sig,
            orphan
          });
          await crashReporter.report({
            kind: 'shutdown',
            // Losing queued work is worth waking up for; a clean shutdown isn't.
            level: orphaned > 0 ? 'error' : 'info',
            title: orphaned > 0
              ? `${role} shutting down with ${orphaned} ad(s) in flight`
              : `${role} shutting down cleanly`,
            diagnostic,
            fields: { signal: sig, ...fields },
            signal: sig,
            inFlight: snapshot
          });
        })(), budget - persistMs);
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
