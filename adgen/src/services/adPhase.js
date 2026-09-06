'use strict';
//
// services/adPhase.js — THE ONE PLACE that turns an Ad document into a
// single, human-facing "where is this ad right now" phase.
//
// WHY THIS FILE EXISTS (2026-08-26 UI-truth / Slack-parity audit). Before
// this file, at least three call sites independently read a subset of
// {status, renderStage, titlingNeeded, titlingResumeState, claimedByWorker,
// visionQc} and each drew its own conclusion: the Product Ads tile
// (pages/ProductAds/index.tsx, frontend repo) added an `isFailed` override
// the legacy /ads tile never got; the Rendering-window run counters
// (services/campaignRunGuards.js classifyRunAdOutcome) bucket by raw
// `status` plus `isVideoTitlingSettled`, with no notion of "handed off to
// the titler and stranded"; and Slack's run-feed parent
// (services/runFeedService.js loadLiveSnapshot) groups by raw `Ad.status`
// again, independently. The result: the SAME ad could read "Quality check"
// on one surface, "Failed" on another, and never show up as stuck on a
// third. See services/adTitlingTruth.js's header for the sibling incident
// this module builds on (the 29/39 vs 16/39 "delivered" undercount).
//
// Pure function of the Ad doc (+ injectable now/staleMinutes). No DB access,
// no I/O, no Date.now() unless the caller omits `opts.now`.
//
// VENDORED INTO liquidretail_adgen byte-for-byte (same convention as
// services/adTitlingTruth.js — see that repo's scripts/verifyVendorDrift.js).
// Edit both copies together, or the drift check goes red there. adgen is
// where the LIVE render/titler lifecycle actually runs today, so Slack
// alerts fired from renderer.js/titler.js must call the SAME deriveAdPhase
// this file exports — not a re-derivation — or the UI and Slack can
// disagree about whether an ad is mid-flight, stalled, or a QC fail again.

const { isVideoTitlingSettled, isAdHonestlyDelivered } = require('./adTitlingTruth');
// COMPETITOR_MARKS_CAVEAT: owner-confirmed 2026-08-26 known false-positive
// pattern (competitor_marks flagging the product's OWN printed name/brand).
// Required from adVisionQcService so the caveat text has exactly one
// definition — see that file for the full incident note.
const { COMPETITOR_MARKS_CAVEAT } = require('./adVisionQcService');

// ── canonical phase set ──────────────────────────────────────────────────
const PHASES = Object.freeze([
  'queued',              // Ad.status === 'queued', not yet claimed
  'claimed',             // claimed, no stage breadcrumb written yet
  'generating-master',   // static image generation, OR video master submit/poll,
                          // OR any other claimed in-flight work with a stage
                          // breadcrumb that doesn't match a more specific phase
  'awaiting-master',     // free derive waiting on its sibling master's plate
  'titling',             // Remotion compositing in progress (in-process or
                          // claimed by the titler role)
  'awaiting-titler',     // handed off (titlingNeeded:true) but NOT YET claimed
                          // by a titler — this is the phase that silently
                          // stranded work when ADGEN_TITLER_ENABLED was off
                          // on the titler service while on on the renderer
  'quality-check',       // vision QC in flight, verdict not yet stamped
  'qc-failed-kept',      // TERMINAL: status:'failed', vision QC rejected it,
                          // asset was KEPT (owner decision 2026-08-20) —
                          // distinct from failed-terminal on every surface
  'complete',            // TERMINAL: isAdHonestlyDelivered() is true
  'failed-terminal',     // TERMINAL: status:'failed', not a QC rejection
  'deferred-retrying',   // released back (timeout / reaper) but not yet
                          // re-claimed by anyone
  'skipped-derivative',  // TERMINAL: archived, never rendered, never billed
                          // (e.g. Stop's undispatched tail)
  'stalled',             // OVERLAY: any non-terminal phase above whose
                          // relevant timestamp hasn't moved in staleMinutes
  'cancelling',          // OVERLAY: operator requested Stop on this ad's run
                          // (CampaignRun.status:'cancelling') and this ad has
                          // not yet settled or been archived — "Stopping…" in
                          // the UI, not yet a final state.
  'cancelled'            // TERMINAL: operator stopped this ad's run
                          // (CampaignRun.status:'cancelled') and this ad was
                          // never going to render — distinct from
                          // skipped-derivative so the UI can say WHY.
]);

// Phases that are done moving — the staleness overlay never applies to them,
// and a run/UI should treat them as final regardless of how old they are.
const TERMINAL_PHASES = new Set(['complete', 'failed-terminal', 'qc-failed-kept', 'skipped-derivative', 'cancelled']);

// Phases the cancel overlay may still override — everything except an ad
// that reached its OWN real outcome (complete / failed-terminal /
// qc-failed-kept) or is already the settled 'cancelled' phase itself.
// Deliberately INCLUDES 'skipped-derivative': an archived, never-billed row
// is exactly what Stop's backlog-archive produces, and once a run is
// cancelled that archive should read "Cancelled" (why), not the more
// generic "skipped-derivative" (that it happened).
const CANCEL_OVERRIDABLE_PHASES = new Set(
  PHASES.filter((p) => p !== 'complete' && p !== 'failed-terminal' && p !== 'qc-failed-kept' && p !== 'cancelled')
);

// Staleness is about work that STARTED and then stopped moving. 'queued' is
// deliberately exempt on top of TERMINAL_PHASES: a mint leftover can
// legitimately sit unclaimed for hours awaiting an operator's "Generate
// more" (see QUEUED_ARCHIVE_AFTER_H, services/queuedArchiveSweeper.js in the
// backend repo) — that is a backlog, not a stall, and nothing has been
// claimed for the overlay to describe as stuck.
const NO_STALENESS_PHASES = new Set([...TERMINAL_PHASES, 'queued']);

// Matches the REAP_STALE_MIN convention already used for CampaignRun
// staleness (services/campaignRunGuards.js) so an operator sees one
// consistent "how long is too long" number across the product, not two.
const DEFAULT_STALE_MINUTES = 15;

function toMillis(d) {
  if (d == null) return NaN;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function minutesSince(date, nowMs) {
  const t = toMillis(date);
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs - t) / 60000;
}

/**
 * Which phase is this Ad in right now? Deterministic given the same doc +
 * `now` — safe to call from a request handler, a background sweep, or a
 * Slack alert builder and get the identical answer every time.
 *
 * @param {object} ad — Ad doc/lean object. Reads (all optional/defaulted):
 *   status, kind, renderStage, renderStageAt, titlingNeeded,
 *   titlingResumeState, claimedByWorker, claimedAt, veoVideoUrl,
 *   veoPredictionId, renderUrl, deriveFromMaster, visionQc, updatedAt.
 * @param {object} [opts]
 * @param {Date|number} [opts.now] — defaults to Date.now()
 * @param {number} [opts.staleMinutes] — defaults to DEFAULT_STALE_MINUTES
 * @param {boolean} [opts.runCancelling] — this ad's CampaignRun.status is
 *   'cancelling' (operator pressed Stop, not yet fully drained). Pure
 *   function stays pure — the CALLER reads the run's own status and passes
 *   it in; this file never queries CampaignRun itself.
 * @param {boolean} [opts.runCancelled] — this ad's CampaignRun.status is
 *   'cancelled' (fully settled). Wins over `runCancelling` if both are
 *   somehow set.
 * @returns {string} one of PHASES
 */
function deriveAdPhase(ad, opts = {}) {
  if (!ad) return 'queued';
  const nowMs = opts.now instanceof Date ? opts.now.getTime()
    : (typeof opts.now === 'number' ? opts.now : Date.now());
  const staleMinutes = Number.isFinite(opts.staleMinutes) ? opts.staleMinutes : DEFAULT_STALE_MINUTES;

  const status = ad.status;
  const isVideo = ad.kind === 'video';
  const claimed = !!ad.claimedByWorker;
  const qc = ad.visionQc || null;

  // ── terminal, unconditional — evaluated before anything else so a
  //    finished ad can never be re-classified as in-flight by a stale stage
  //    breadcrumb (services/adStage.js is fire-and-forget and, on the live
  //    path, was never cleared on success — the exact "Quality check /
  //    growing elapsed timer" bug this module exists to stop). ────────────
  //
  // QC-FAILED-KEPT checked BEFORE the generic failed-terminal branch, and
  // before isAdHonestlyDelivered — owner requirement 2026-08-20: a video or
  // static ad that failed vision QC but kept its rendered asset must read
  // distinctly, never folded into either "Failed" (loses the QC verdict) or
  // "complete" (it did not pass).
  if (status === 'failed' && qc && qc.passed === false && !qc.skipped && ad.renderUrl) {
    return 'qc-failed-kept';
  }
  if (status === 'failed') return 'failed-terminal';

  if (status === 'draft' || status === 'live' || status === 'archived') {
    if (isAdHonestlyDelivered(ad)) return 'complete';
    if (status === 'archived' && !ad.renderUrl && !ad.veoPredictionId) {
      // Never rendered, never billed — an archived mint leftover or Stop's
      // backlog archive. Distinct from a genuine failure. Goes through the
      // SAME cancel-overlay check as every other phase below (not an early
      // return) so a row archived BECAUSE its run was cancelled reads
      // "Cancelled", the more informative of the two true labels.
      return (opts.runCancelled || opts.runCancelling)
        ? (opts.runCancelled ? 'cancelled' : 'cancelling')
        : 'skipped-derivative';
    }
    // draft/live/archived but titling not honestly settled — a video ad
    // sits status:'draft' through titling AND vision QC (the master/derive
    // path stamps `draft` the instant the plate lands, before compositing —
    // see adTitlingTruth.js's header). Fall through to the in-flight
    // sub-phase checks below instead of returning here.
  } else if (status !== 'queued' && status !== 'rendering') {
    // Unrecognised/legacy status value. Do not throw; do not guess a
    // terminal phase for something we don't understand.
    return 'queued';
  }

  // ── in-flight sub-phases — checked by field shape, NOT by exact status,
  //    because (a) a video ad can be mid-titling while status is still
  //    'draft' and (b) adgen's titler-handoff write deliberately leaves
  //    status untouched (renderer.js: "Do NOT bumpRunCounter — the ad
  //    hasn't settled yet"). ────────────────────────────────────────────
  let phase;
  if (isVideo && ad.deriveFromMaster && !ad.veoVideoUrl) {
    // Free derive still waiting on its sibling master's plate — whether the
    // row is 'rendering' (actively polling, claim held) or was requeued to
    // 'queued' after DERIVE_MASTER_WAIT_MS expired (claim released), it is
    // the same wait, so it gets the same phase either way.
    phase = 'awaiting-master';
  } else if (isVideo && ad.titlingNeeded === true) {
    // Handoff flag. Cleared only on the titler's terminal SUCCESS write —
    // it stays true for the entire titler pass, so "claimed" is the only
    // signal separating "waiting for a titler" from "being titled by one".
    phase = claimed ? 'titling' : 'awaiting-titler';
  } else if (isVideo && (ad.titlingResumeState === 'pending' || ad.titlingResumeState === 'claimed')) {
    phase = 'titling';
  } else if (isVideo && ad.renderStage && /^vision QC/i.test(String(ad.renderStage)) && !qc) {
    // A verdict has not been stamped yet — once it is, status flips to
    // 'draft' (pass) or 'failed' (fail) and one of the terminal branches
    // above already returned.
    phase = 'quality-check';
  } else if (status === 'queued') {
    phase = 'queued';
  } else if (!claimed) {
    // Released (timeout, reaper, a crashed worker) but nobody has re-claimed
    // it yet.
    phase = 'deferred-retrying';
  } else if (!ad.renderStage) {
    // Just claimed; no stage breadcrumb written yet.
    phase = 'claimed';
  } else {
    // Claimed with a stage breadcrumb that matched none of the more
    // specific checks above: static image generation, or a video master
    // submit/poll, or any other claimed in-flight work.
    phase = 'generating-master';
  }

  // ── cancel overlay — checked BEFORE staleness so a stopped run's ads
  //    read "Cancelled"/"Stopping…", not "Stalled". An ad already in a
  //    TERMINAL phase (finished before Stop landed) is never rewritten —
  //    a cancel only touches work that was still going to happen. ───────
  if (CANCEL_OVERRIDABLE_PHASES.has(phase)) {
    if (opts.runCancelled) return 'cancelled';
    if (opts.runCancelling) return 'cancelling';
  }

  // ── staleness overlay ────────────────────────────────────────────────
  if (!NO_STALENESS_PHASES.has(phase)) {
    const ts = ad.renderStageAt || ad.updatedAt || ad.claimedAt;
    if (minutesSince(ts, nowMs) > staleMinutes) return 'stalled';
  }
  return phase;
}

// ── failure labeling — owner requirement 2026-08-26 ─────────────────────
// "for QC failures it should specifically be noted as a QC Fail, not just
// Failed since there are so many issues that can cause a 'failure'."
// Generalised to every renderError.stage this repo and adgen are confirmed
// to write on a terminal video/static failure (grepped 2026-08-26, both
// repos) — the same complaint applies to any stage collapsed into the bare
// word "Failed". An unmapped/new stage degrades to a humanized version of
// the raw string, never to a bare "Failed" that hides a stage the code did
// record.
const FAILURE_STAGE_LABELS = Object.freeze({
  'vision-qc':          'QC Fail',
  'vision-qc-recovery': 'QC Fail',
  'render':             'Render Failed',
  'derive-no-master':   'Master Unavailable',
  'titling':            'Titling Failed',
  'titler':             'Titling Failed',
  'resume':             'Titling Failed',
  'face-safe-crop':     'Crop Failed',
  'reaper':             'Reclaimed (Stalled Claim)',
  'shutdown':           'Interrupted (Deploy)',
  'crash':              'Process Crash',
  'claim':              'Claim Failed',
  // These two appear in the owner's measured stage distribution but were
  // not found as literal source strings by a repo-wide grep on 2026-08-26 —
  // kept as explicit entries in case they are set dynamically (a template
  // string, or a since-changed call site) rather than absent. The generic
  // humanizeStage() fallback below covers them either way if this mapping
  // is ever wrong.
  'cleanup':            'Cleanup Failed',
  'zombie-cleanup':     'Stalled Claim Cleared'
});

/** "derive-no-master" -> "Derive No Master"; last-resort label for a stage
 *  this module doesn't have an explicit mapping for. */
function humanizeStage(stage) {
  return String(stage)
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Failed';
}

/**
 * Operator-facing description of a TERMINAL failure phase. Returns null for
 * every other phase — callers should call this only after deriveAdPhase()
 * returns 'failed-terminal' or 'qc-failed-kept' (pass that phase in so this
 * function never has to recompute it and risk disagreeing with the caller).
 *
 * Slack and every UI surface must call this — not re-derive a label from
 * `ad.status` — so "QC Fail" vs "Render Failed" vs "Master Unavailable"
 * reads identically everywhere.
 *
 * @param {object} ad
 * @param {string} phase — result of deriveAdPhase(ad, ...)
 * @returns {{label:string, isQc:boolean, stage:string|null, keptAsset:boolean,
 *   qcCaveat:string|null}|null}
 */
function describeAdFailure(ad, phase) {
  if (phase !== 'failed-terminal' && phase !== 'qc-failed-kept') return null;
  const stage = (ad && ad.renderError && ad.renderError.stage) || null;
  const isQc = phase === 'qc-failed-kept' || stage === 'vision-qc' || stage === 'vision-qc-recovery';
  const label = isQc
    ? 'QC Fail'
    : (stage ? (FAILURE_STAGE_LABELS[stage] || humanizeStage(stage)) : 'Failed');

  // Known false-positive caveat (see adVisionQcService.COMPETITOR_MARKS_CAVEAT):
  // surfaced whenever the failing verdict's LAST attempt has a failing
  // competitor_marks category, regardless of whether other categories also
  // failed — the owner's instruction is "do not present a competitor_marks
  // finding as authoritative", not "only when it's the sole cause".
  let qcCaveat = null;
  if (isQc) {
    const qc = ad && ad.visionQc;
    const attempts = qc && Array.isArray(qc.attempts) ? qc.attempts : [];
    const last = attempts[attempts.length - 1];
    const cm = last && last.categories && last.categories.competitor_marks;
    if (cm && cm.pass === false) qcCaveat = COMPETITOR_MARKS_CAVEAT;
  }

  return {
    label,
    isQc,
    stage,
    keptAsset: phase === 'qc-failed-kept' || !!(ad && ad.renderUrl),
    qcCaveat
  };
}

module.exports = {
  PHASES,
  TERMINAL_PHASES,
  NO_STALENESS_PHASES,
  CANCEL_OVERRIDABLE_PHASES,
  DEFAULT_STALE_MINUTES,
  deriveAdPhase,
  FAILURE_STAGE_LABELS,
  humanizeStage,
  describeAdFailure
};
