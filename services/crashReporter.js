// crashReporter — single choke point for documenting and notifying crashes.
//
// Inherits the alertService never-throws / never-blocks contract verbatim:
//   • every export is safe to call un-awaited from a render loop, a catch,
//     or a process-exit handler;
//   • a missing token, network failure, Mongo down, or malformed argument
//     degrades to ONE console.warn, never a rejected promise.
//
// This matters more than usual: processAlerts installs an unhandledRejection
// handler, so a rejecting alert path would kill the process it exists to
// watch.
//
// THE ORDERING RULE (load-bearing — do not reorder):
//   IncidentLog write ALWAYS happens BEFORE the Slack send, and is NEVER
//   conditional on it. The DB is the system of record; Slack is notification.
//   With no-folding (key = 'crash:' + incidentId), ALERT_RATE_LIMIT_MAX is
//   the only silent drop point — the row must already exist when that fires.

'use strict';

const crypto = require('crypto');
const os = require('os');
const mongoose = require('mongoose');

const alerts = require('./alertService');
// renderDiagnostic lands in the same commit; require it even if the file
// is not present yet in this worktree lane.
// eslint-disable-next-line global-require
const renderDiagnostic = require('./renderDiagnostic');
const IncidentLog = require('../models/IncidentLog');

// Lazy env readers — same idiom as alertService so a Render env change
// takes effect on the next boot without load-order branches.
const PERSIST_TIMEOUT_MS = () =>
  Math.max(250, parseInt(process.env.CRASH_PERSIST_TIMEOUT_MS || '2000', 10) || 2000);

const ROLE = () =>
  process.env.ALERT_ROLE ||
  (process.env.RENDER_SERVICE_TYPE === 'background_worker' ? 'worker' : 'web');

const INSTANCE = () =>
  (process.env.RENDER_INSTANCE_ID || os.hostname() || '?').slice(-8);

const COMMIT = () => {
  const c = (process.env.RENDER_GIT_COMMIT || '').trim();
  return c ? c.slice(0, 8) : null;
};

const ENV_LABEL = () =>
  process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || 'prod';

// ── per-ad Slack suppression ─────────────────────────────────────────────────
// "One Slack message per crash" means per LOGICAL failure, not per layer. A
// single failing static ad surfaces at up to three layers — renderService's
// per-stage catch, the route's `result.status === 'failed'` branch, and the
// route's outer catch — and because crash keys are deliberately unique there is
// no dedupe to collapse them. A 20-ad vendor blip would post 40-60 messages and
// bury the signal it exists to raise.
//
// So: EVERY report still writes its IncidentLog row (nothing is undocumented),
// but Slack gets one message per ad per window. Reports with no adId (process
// crashes, expansion failures, worker-loop crashes) are never suppressed — they
// are already distinct events. Ads other than the first are unaffected, so
// no-folding across DIFFERENT ads is preserved.
const AD_WINDOW_MS = () =>
  Math.max(0, parseInt(process.env.CRASH_AD_WINDOW_MS || '60000', 10) || 0);

const MAX_TRACKED_ADS = 500;
const lastByAd = new Map();   // adId → { at, incidentId }

function notePerAd(adId, incidentId) {
  lastByAd.delete(adId);      // re-insert so eviction stays oldest-first
  lastByAd.set(adId, { at: Date.now(), incidentId });
  while (lastByAd.size > MAX_TRACKED_ADS) {
    lastByAd.delete(lastByAd.keys().next().value);
  }
}

/** @returns {{incidentId:string, agoSec:number}|null} the earlier report, if inside the window */
function recentForAd(adId) {
  if (!adId) return null;
  const win = AD_WINDOW_MS();
  if (win <= 0) return null;
  const prev = lastByAd.get(adId);
  if (!prev) return null;
  const age = Date.now() - prev.at;
  if (age >= win) return null;
  return { incidentId: prev.incidentId, agoSec: Math.round(age / 1000) };
}

/**
 * Promise.race against a deadline, with the timer ALWAYS cleared. A bare
 * `race([p, new Promise(r => setTimeout(r, ms))])` leaves the timer pending
 * for the full ms even when `p` settles first — one leaked timer per crash
 * report, and on the shutdown path a pending timer keeps the event loop
 * alive inside the very window we are trying to bound.
 *
 * Deliberately NOT unref'd. The deadline is the thing being awaited, so an
 * unref'd timer lets Node judge the loop empty and exit BEFORE it fires —
 * the race then never settles and report() silently never returns. (Caught
 * by scripts/verifyCrashReporter.js, where crashReporter really is the only
 * live handle.) clearTimeout in the finally is what prevents the leak; the
 * unref would only have traded a leak for a hang.
 */
function raceDeadline(promise, ms, timeoutValue) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Coerce anything id-like to a string, or null. Never throws. */
function idStr(v) {
  if (v == null || v === '') return null;
  try {
    if (typeof v === 'object' && v._id != null) return String(v._id);
    return String(v);
  } catch {
    return null;
  }
}

/**
 * Normalise err → { message, stack }. A vendor error can have a non-string
 * .message (or throw on property access), so every read is defensive.
 */
function normaliseErr(err) {
  if (err == null) return { message: null, stack: null };
  if (typeof err === 'string') {
    return { message: err, stack: null };
  }
  let message = null;
  let stack = null;
  try {
    if (err && typeof err.message === 'string') message = err.message;
    else if (err != null) message = String(err);
  } catch {
    message = '(unreadable error message)';
  }
  try {
    if (err && typeof err.stack === 'string') stack = err.stack;
  } catch {
    stack = null;
  }
  return { message, stack };
}

/**
 * Money tags from the ad and the error. err.charged is set by
 * atlasImageService.chargedError (CLAUDE.md §2) — a billable submit that
 * then failed still costs money, and shutdown/crash paths must surface it.
 */
function deriveMoney(ad, err) {
  let predictionId = null;
  let charged = false;
  let costUsd = null;
  try {
    const re = ad && ad.renderError;
    const cause = err && typeof err === 'object' ? err.cause : null;
    predictionId =
      (ad && ad.veoPredictionId) ||
      (re && re.predictionId) ||
      (err && err.predictionId) ||
      (cause && cause.predictionId) ||
      null;
    if (predictionId != null) predictionId = String(predictionId);

    charged =
      (err && err.charged === true) ||
      (cause && cause.charged === true) ||
      (re && re.charged === true) ||
      false;

    const rawCost =
      (err && typeof err.costUsd === 'number' ? err.costUsd : null) ??
      (cause && typeof cause.costUsd === 'number' ? cause.costUsd : null) ??
      (re && typeof re.costUsd === 'number' ? re.costUsd : null);
    if (typeof rawCost === 'number' && Number.isFinite(rawCost)) costUsd = rawCost;
  } catch {
    /* money tags are best-effort; never lose the report for them */
  }
  return { predictionId, charged, costUsd };
}

/**
 * Document and report a crash. NEVER throws. Safe un-awaited.
 *
 * @param {object} o
 * @param {string} o.kind                 required, one of IncidentLog.KINDS
 * @param {'warn'|'error'|'fatal'} [o.level='error']
 * @param {string} o.title                required, short one-line summary
 * @param {Error|string|null} [o.err]
 * @param {object|null} [o.ad]            Ad doc (or {_id})
 * @param {object|null} [o.run]           CampaignRun doc (or {runId})
 * @param {string|null} [o.diagnostic]    pre-built block; else built from ad
 * @param {object} [o.fields]             extra Slack key→value lines
 * @param {string|null} [o.stage]
 * @param {string|null} [o.signal]
 * @param {object|null} [o.inFlight]      snapshot for crash/shutdown kinds
 * @param {object} [o.ids]                { campaignId, productId, brandId, mediaId }
 * @returns {Promise<{incidentId:string, persisted:boolean, delivered:boolean}>}
 */
async function report({
  kind,
  level = 'error',
  title,
  err = null,
  ad = null,
  run = null,
  diagnostic = null,
  fields = {},
  stage = null,
  signal = null,
  inFlight = null,
  ids = {}
} = {}) {
  // Absolute backstop: nothing in an alerting path may propagate. The
  // unhandledRejection handler would exit the process if we rejected.
  const empty = { incidentId: null, persisted: false, delivered: false, suppressed: false, duplicateOf: null };
  try {
    // 1. Generate incidentId — unique per call so Slack dedupe cannot fold.
    const incidentId = crypto.randomBytes(6).toString('hex');

    // 2. Normalise err → message + stack.
    const { message, stack } = normaliseErr(err);

    // 'info' MUST be honoured, not coerced up. A CLEAN shutdown reports at
    // info precisely so it stays muted at the default ALERT_MIN_LEVEL=warn —
    // every deploy is a clean shutdown, and firing those at error would be
    // the exact noise that teaches people to ignore the channel. Anything
    // unrecognised still lands on 'error' (fail loud, not silent).
    const lvl = ['info', 'warn', 'fatal'].includes(level) ? level : 'error';
    const safeTitle = (typeof title === 'string' && title.trim())
      ? title.trim()
      : (kind ? String(kind) : '(no title)');
    const safeKind = kind != null && kind !== '' ? String(kind) : 'render-crash';

    // 3. Derive diagnostic: explicit wins; else build from ad; never lose
    // the report if renderDiagnostic throws on a partial Ad.
    let diag = diagnostic != null ? String(diagnostic) : null;
    if (!diag && ad) {
      try {
        diag = renderDiagnostic.diagnosticForAd(ad, { run }) || null;
      } catch (diagErr) {
        try {
          console.warn(
            `🔔 crashReporter: diagnostic build failed — ${diagErr && diagErr.message}`
          );
        } catch { /* ignore */ }
        diag = null;
      }
    }

    // Scrub credentials from everything we are about to PERSIST. alertService
    // redacts on its way out to Slack, but the IncidentLog row is a second,
    // longer-lived copy of the same text — a stack from a failed authenticated
    // request can carry the bot token verbatim, and this collection outlives
    // the incident by INCIDENT_LOG_TTL_DAYS.
    const redact = (s) => {
      if (s == null) return s;
      try { return alerts.redact(s); } catch { return s; }
    };

    // 4. Money tags.
    const { predictionId, charged, costUsd } = deriveMoney(ad, err);

    // Correlation ids — explicit ids overrides win over ad/run fields.
    const adId = idStr(ad && (ad._id || ad.id || ad.adId)) || idStr(ids && ids.adId);
    const runId =
      (run && (run.runId != null ? String(run.runId) : null)) ||
      idStr(run && run._id) ||
      idStr(ids && ids.runId);
    const campaignId =
      idStr(ids && ids.campaignId) ||
      idStr(ad && ad.campaignId) ||
      idStr(run && run.campaignId);
    const productId =
      idStr(ids && ids.productId) || idStr(ad && ad.productId);
    const brandId =
      idStr(ids && ids.brandId) || idStr(ad && ad.brandId);
    const mediaId =
      idStr(ids && ids.mediaId) ||
      idStr(ad && ad.mediaId) ||
      (Array.isArray(ad && ad.mediaIds) && ad.mediaIds[0] != null
        ? idStr(ad.mediaIds[0])
        : null);
    const stageStr = stage != null && stage !== ''
      ? String(stage)
      : (ad && ad.renderStage != null ? String(ad.renderStage) : null);

    // Decide suppression BEFORE the row is built so `duplicateOf` is persisted
    // with it — the row must record that a human was not paged for this one.
    const dup = recentForAd(adId);
    if (adId && !dup) notePerAd(adId, incidentId);

    const commit = COMMIT();
    const role = ROLE();
    const instanceId = INSTANCE();
    const envLabel = ENV_LABEL();
    let uptimeSec = null;
    try { uptimeSec = Math.floor(process.uptime()); } catch { /* ignore */ }

    // Identity fields go FIRST, caller fields after. alertService caps a
    // message at MAX_FIELDS and silently drops the overflow, so insertion
    // order is a priority order. `incident` is the only thing that joins this
    // Slack message to its IncidentLog row — appending it last meant it was
    // the first field dropped on exactly the richest alerts (a shutdown
    // carries ~10 of its own fields before crashReporter adds any).
    // Never mutate the caller's object.
    const callerFields = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
    const slackFields = {};
    slackFields.incident = incidentId;
    slackFields.kind = safeKind;
    if (commit) slackFields.commit = commit;
    if (charged) slackFields.charged = 'true';
    if (predictionId) slackFields.prediction = predictionId;
    if (adId) slackFields.ad = adId;
    if (runId) slackFields.run = runId;
    if (stageStr) slackFields.stage = stageStr;
    for (const [k, v] of Object.entries(callerFields)) {
      if (!(k in slackFields)) slackFields[k] = v;
    }

    // 5. Write the IncidentLog row BEFORE Slack. Skip — do not fail — when
    // mongoose is not connected (boot crash, DB blip). Surface the omission
    // as a Slack field so the channel still says why there is no row.
    let persisted = false;
    const mongoReady = mongoose.connection.readyState === 1;
    if (!mongoReady) {
      slackFields['incident log'] = 'skipped (mongo not connected)';
    } else {
      try {
        const doc = {
          incidentId,
          at: new Date(),
          kind: safeKind,
          level: lvl,
          role,
          instanceId,
          commit: commit || undefined,
          envLabel,
          uptimeSec: uptimeSec != null ? uptimeSec : undefined,
          signal: signal != null ? String(signal) : undefined,
          title: redact(safeTitle),
          message: redact(message) || undefined,
          stack: redact(stack) || undefined,
          diagnostic: redact(diag) || undefined,
          adId: adId || undefined,
          runId: runId || undefined,
          campaignId: campaignId || undefined,
          productId: productId || undefined,
          brandId: brandId || undefined,
          mediaId: mediaId || undefined,
          stage: stageStr || undefined,
          predictionId: predictionId || undefined,
          charged: charged === true,
          // Set when an earlier report for the SAME ad already paged someone in
          // this window. The row still exists — only the Slack send is skipped.
          duplicateOf: dup ? dup.incidentId : undefined,
          costUsd: costUsd != null ? costUsd : undefined,
          inFlight: inFlight && typeof inFlight === 'object' ? {
            runCount: inFlight.runCount,
            adsRemaining: inFlight.adsRemaining,
            runIds: Array.isArray(inFlight.runIds) ? inFlight.runIds.map(String) : undefined,
            adIds: Array.isArray(inFlight.adIds) ? inFlight.adIds.map(String) : undefined,
            submittedAdIds: Array.isArray(inFlight.submittedAdIds)
              ? inFlight.submittedAdIds.map(String)
              : undefined
          } : undefined
        };

        const timeoutMs = PERSIST_TIMEOUT_MS();
        // Bound the write: a hung Mongo must not stall the Slack send
        // (and must not hold a signal handler past the exit flush window).
        const writeResult = await raceDeadline(
          IncidentLog.create(doc).then(() => true).catch((e) => {
            try {
              console.warn(
                `🔔 crashReporter: IncidentLog create failed — ${e && e.message}`
              );
            } catch { /* ignore */ }
            return false;
          }),
          timeoutMs,
          'timeout'
        );

        if (writeResult === true) {
          persisted = true;
        } else if (writeResult === 'timeout') {
          slackFields['incident log'] = `skipped (persist timeout ${timeoutMs}ms)`;
          try {
            console.warn(
              `🔔 crashReporter: IncidentLog create timed out after ${timeoutMs}ms`
            );
          } catch { /* ignore */ }
        } else {
          slackFields['incident log'] = 'skipped (persist failed)';
        }
      } catch (writeErr) {
        slackFields['incident log'] = 'skipped (persist failed)';
        try {
          console.warn(
            `🔔 crashReporter: IncidentLog write error — ${writeErr && writeErr.message}`
          );
        } catch { /* ignore */ }
      }
    }

    // 6. Slack notify. key is unique per incident → dedupe folding is
    // bypassed structurally. Do NOT modify alertService dedupe to achieve this.
    // detail = diagnostic block when present, else stack, else message.
    const detail = diag || stack || message || null;
    let delivered = false;
    let slackError = null;
    if (dup) {
      // Row already written above; only the page is skipped. The reason is
      // recorded on the row so "why didn't Slack tell me" is answerable.
      slackError = `suppressed (ad already reported ${dup.agoSec}s ago as ${dup.incidentId})`;
      try {
        console.warn(`🔔 crashReporter: ${safeKind} for ad ${adId} — ${slackError}`);
      } catch { /* ignore */ }
    } else {
      try {
        delivered = await alerts.notify({
          level: lvl,
          title: safeTitle,
          detail,
          fields: slackFields,
          key: 'crash:' + incidentId
        });
        if (!delivered) slackError = 'not delivered (disabled, rate-limited, or Slack error)';
      } catch (notifyErr) {
        // alertService.notify already never throws; this is belt-and-braces.
        slackError = (notifyErr && notifyErr.message) || 'notify threw';
        try {
          console.warn(`🔔 crashReporter: notify failed — ${slackError}`);
        } catch { /* ignore */ }
        delivered = false;
      }
    }

    // 7. Patch delivery status back onto the row (best-effort). Only when
    // we actually created a document — otherwise there is nothing to patch.
    if (persisted) {
      try {
        const patch = { slackDelivered: delivered === true };
        if (!delivered) patch.slackError = slackError || 'not delivered';
        await raceDeadline(
          IncidentLog.updateOne({ incidentId }, { $set: patch }).catch(() => {}),
          PERSIST_TIMEOUT_MS(),
          undefined
        );
      } catch { /* swallow — delivery status is secondary to the row itself */ }
    }

    return {
      incidentId,
      persisted,
      delivered: delivered === true,
      suppressed: Boolean(dup),
      duplicateOf: dup ? dup.incidentId : null
    };
  } catch (outer) {
    try {
      console.warn(
        `🔔 crashReporter: report failed — ${outer && outer.message}`
      );
    } catch { /* ignore */ }
    return empty;
  }
}

/**
 * Fire-and-forget wrapper for hot paths and catch blocks, mirroring
 * alertService.notifyAsync. Swallows everything — including the promise
 * from report() — so an unhandledRejection handler never sees us.
 */
function reportSync(opts) {
  Promise.resolve()
    .then(() => report(opts))
    .catch(() => {});
}

module.exports = {
  report,
  reportSync,
  // Test seams / KINDS re-export so callers need not load the model.
  KINDS: IncidentLog.KINDS,
  _resetState: () => { lastByAd.clear(); },
  _stateSize: () => ({ lastByAd: lastByAd.size }),
  _normaliseErr: normaliseErr,
  _deriveMoney: deriveMoney,
  _idStr: idStr
};
