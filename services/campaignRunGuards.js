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

module.exports = {
  DONE_ELIGIBLE_STATUSES,
  buildTerminalDoneFilter
};
