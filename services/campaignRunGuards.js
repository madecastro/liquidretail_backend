'use strict';
//
// Pure CampaignRun predicates. Extracted so a harness can evaluate the
// REAL filter against REAL document shapes instead of regexing a 4000-line
// route handler. A source-text assertion cannot tell a working query from
// one that merely still contains the right words.
//
// CampaignRun.status enum is ['preparing','running','done','failed']
// (models/CampaignRun.js). There is NO 'cancelled' on this collection —
// operator stop is OperationRun.status='cancelled' via progressService
// (STATUSES = running|succeeded|failed|cancelled|cancelling). A
// CampaignRun that finishes after an operator stop still lands on 'done'.

// In-flight statuses that may legally transition to 'done'. Terminal
// 'failed' (reaper) and 'done' must stay put; an allow-list (not a
// $nin of guessed names) is what keeps a future 'cancelled' on this
// collection from being flipped back to 'done'.
const DONE_ELIGIBLE_STATUSES = Object.freeze(['preparing', 'running']);

/**
 * Filter for the render-loop's terminal `done` write.
 * A run the reaper already marked `failed` must not become `done`.
 */
function buildTerminalDoneFilter(id) {
  return { _id: id, status: { $in: [...DONE_ELIGIBLE_STATUSES] } };
}

/**
 * worker.js reapOrphans() — CampaignRuns stuck in 'preparing'. HYGIENE ONLY,
 * NOT the money guard — see buildRunningFlipFilter below for that.
 *
 * A 'preparing' run never heartbeats: expandWizardJob (Director + Judge,
 * then the atomic Ad claim) makes ZERO writes to the CampaignRun row before
 * the 'running' flip, so updatedAt === startedAt for the entire expansion.
 * That is why this keys on startedAt, unlike the 'running' sweep in
 * worker.js which safely uses updatedAt (a live batch's per-ad $inc proves
 * liveness — see the comment there). Using updatedAt here would be no
 * different from using startedAt, so startedAt states the real semantics.
 *
 * This sweep runs on a 5-minute cadence (REAP_INTERVAL_MIN) and can lag
 * arbitrarily further if the worker process itself is down — so it CANNOT
 * be the thing that closes the double-spend window on its own. That guard
 * is buildRunningFlipFilter's age check, which is self-contained and does
 * not depend on this sweep having run at all. This function only decides
 * when to stamp a dead-looking row 'failed' for visibility/cleanup; a run
 * this sweep hasn't gotten to yet is already money-safe because the flip
 * below independently refuses to resurrect anything past the gate's own
 * staleness window.
 */
function buildStalePreparingFilter({ now, staleMin }) {
  const t = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
  return {
    status: 'preparing',
    startedAt: { $lt: new Date(t - staleMin * 60 * 1000) }
  };
}

/**
 * routes/ads.js — the compare-and-swap for the 'preparing' → 'running' flip.
 * THIS is the actual money guard, not the reaper sweep above.
 *
 * `status:'preparing'` alone is necessary but not sufficient. Adversarial
 * review caught the gap: the concurrency gate (routes/ads.js) stops treating
 * a 'preparing'/'running' run as active once its `createdAt` is older than
 * `REAP_STALE_MIN` (the SAME const the gate already uses, by the same
 * repo convention documented there — "the two cannot drift into disagreeing
 * about what stale means"). That gate check fires on every request,
 * independent of whether the worker's reaper has actually ticked. So
 * without an age check HERE too, a run whose expansion is merely slow (not
 * dead) can outlive the gate's window — a duplicate request then sails
 * through as "not a duplicate" (the stale row is invisible to the gate),
 * a sibling run bills a fresh generation, and MINUTES LATER the original's
 * expansion finally finishes and this flip — checking only {_id,
 * status:'preparing'} — would have succeeded too, billing a second time
 * for the same operator intent. Passing `staleMin` (the gate's own
 * REAP_STALE_MIN) closes this: the flip refuses once the run has aged past
 * the exact instant the gate stopped honoring its exclusivity, regardless
 * of reaper cadence. `staleMin` is optional only so the pure-logic tests can
 * exercise the bare status guard in isolation; every real caller must pass
 * it.
 */
function buildRunningFlipFilter(runDocId, { now, staleMin } = {}) {
  const filter = { _id: runDocId, status: 'preparing' };
  if (staleMin != null) {
    const t = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
    filter.startedAt = { $gte: new Date(t - staleMin * 60 * 1000) };
  }
  return filter;
}

module.exports = {
  DONE_ELIGIBLE_STATUSES,
  buildTerminalDoneFilter,
  buildStalePreparingFilter,
  buildRunningFlipFilter
};
