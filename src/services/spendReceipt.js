'use strict';
//
// THE SPEND RECEIPT — one definition, used by every site that moves an ad out of
// `rendering` back into `queued`.
//
// WHY THIS MODULE EXISTS (2026-08-04). Providers charge at SUBMIT, not at
// completion. So the moment an ad has a prediction id stamped on it, the money
// is gone whatever happens next:
//
//   Ad.veoPredictionId                — video (Omni). atlasVideoService writes
//                                       it at the charge point, before polling.
//   Ad.imageGeneration.predictionId   — static (gpt-image-2).
//
// Requeuing such an ad means the next run SUBMITS AGAIN and we pay a second time
// for a generation the provider may already have delivered. atlasVideoService
// names this hole at its own charge point: "without it a crash mid-poll loses
// the only handle to work we have paid for, and the reaper re-queues the ad into
// a second submit."
//
// Measured in production: a 411s Omni master completed at 17:27:09 and the
// shutdown requeue swept its run one second later, at 17:27:10.
//
// THE RULE: a requeue may only ever touch RECEIPT-FREE ads, so re-running them
// costs the one charge that was always owed.
//
// ONE HONEST GAP, do not paper over it: "receipt-free" means "we hold no receipt",
// NOT "it was never billed". The receipt is written AFTER the submit POST returns,
// so an ad whose submit is IN FLIGHT when the process dies is genuinely billed and
// still receipt-free — it matches RECEIPT_FREE and will be requeued. That window is
// irreducible without a pre-submit intent record, and it is narrow (one HTTP
// round-trip) versus the alternative of never requeuing anything. It is also not a
// silent double-charge: `queued` ads never auto-drain (CLAUDE.md §2), so a human has
// to re-drain before a second submit can happen. Earlier wording here claimed such
// ads "were never billed — the process died before or during submit"; the "during
// submit" half was wrong and is corrected. Receipt-HOLDING ads stay in `rendering`,
// which is honest (the outcome genuinely is unknown until the receipt is
// polled), stays visible to ALERT_RENDERING_STALE_MIN, and preserves the receipt
// so the asset can be recovered for free instead of re-bought.
//
// WHY THE ABSENCE TEST IS SHAPED LIKE THIS, and why `$exists: false` alone is a
// bug: models/Ad.js declares `veoPredictionId: { type: String, default: null }`.
// The schema DEFAULT IS NULL, so the field exists on essentially every ad. A
// bare `$exists: false` would therefore match almost nothing and strand the
// entire queue. Both the null/empty case and the genuinely-absent case must be
// treated as "no receipt".
//
// ONE EXCEPTION, deliberately NOT using this filter: the claim-anomaly release
// in routes/ads.js (search "CLAIM ANOMALY"). That path releases a claim it just
// took, BEFORE any render or submit has run, so no receipt can exist yet and an
// unconditional release is correct there. It is allowlisted by name in
// scripts/verifyReceiptAwareRequeue.js rather than silently skipped.

/** Matches an ad that has NOT been billed — safe to requeue. */
const RECEIPT_FREE = Object.freeze({
  $and: [
    { $or: [
      { veoPredictionId: { $in: [null, ''] } },
      { veoPredictionId: { $exists: false } }
    ] },
    { $or: [
      { 'imageGeneration.predictionId': { $in: [null, ''] } },
      { 'imageGeneration.predictionId': { $exists: false } }
    ] }
  ]
});

/** Matches an ad that HAS been billed — never requeue; poll the receipt. */
const HAS_RECEIPT = Object.freeze({
  $or: [
    { veoPredictionId: { $nin: [null, ''] } },
    { 'imageGeneration.predictionId': { $nin: [null, ''] } }
  ]
});

/**
 * Add the receipt guard to a requeue filter.
 *
 * Spread-merging would silently drop an existing `$and`, so this composes
 * instead: `receiptFree({ status: 'rendering', $and: [...] })` keeps both.
 */
function receiptFree(filter = {}) {
  const existing = Array.isArray(filter.$and) ? filter.$and : [];
  return { ...filter, $and: [...existing, ...RECEIPT_FREE.$and] };
}

/**
 * THE RULE ABOVE, APPLIED TO ONE SPECIFIC PATH: a video ad whose provider poll
 * hit OUR wall-clock ceiling while the provider was still working.
 *
 * Extracted as a pure decision — the same pattern atlasVideoService.js uses for
 * `resolveTimeoutOutcome` / `submitRetryDecision` / `shouldResumeAttempt`, and
 * for the same reason: the money-relevant branching has to be executable in a
 * harness without mongoose, axios, or an Atlas key. It lives HERE rather than in
 * renderer.js because renderer.js cannot be required offline (it pulls Remotion,
 * Cloudinary and the Atlas clients), and because this module's header already
 * states the rule this function encodes.
 *
 * WHY 'hold' EXISTS AT ALL. Until 2026-08-27 this path unconditionally released
 * the claim while leaving `status:'rendering'`. claimOne's filter is
 * {status:'rendering', claimedByWorker:null, ...}, so that is an immediate
 * invitation to re-enter generateForAd. Measured consequence on
 * run/master 6a8fb12ad0621a3e8f4a7d49 (2026-08-26): ten distinct billable Atlas
 * prediction ids in 2h21m, ~one fresh submit every 12-14 minutes, none
 * completing, 17 derives pinned behind it. 'hold' keeps a receipt-holding row
 * claimed and `rendering` — the resting state this module's header already calls
 * honest — so the only thing that can touch it next is bootRecoveryService's
 * free GET, never another submit.
 *
 * ⚠️  WHAT 'hold' IS AND IS NOT BOUNDED BY — read before trusting the cap.
 * Because 'hold' does NOT release the claim, claimOne cannot re-enter processAd
 * for that row, so the attempt counter is $inc'd exactly ONCE and
 * `attempts >= cap` is UNREACHABLE on this arm. The cap therefore bounds the
 * RELEASE arm and catches re-entry driven by anything else (a claim-TTL sweeper,
 * a future requeue path); it does NOT bound a hold. A hold is bounded instead by
 * the free receipt poller eventually settling the prediction — which is why
 * `freePollerEnabled` is an input rather than an assumption: with the poller off
 * there is nothing to bound it at all, and parking would be a permanent strand,
 * so this returns 'terminal' instead. An adversarial pass (Grok xhigh,
 * 2026-08-27) caught an earlier version of this doc claiming "both arms are
 * bounded by the cap"; that was false in exactly the way the bug this fixes was
 * false, so it is spelled out here.
 *
 * @param {{receipt:?string, attempts:number, cap:number, freePollerEnabled:boolean}} o
 *   receipt          — the spend receipt (prediction id) this attempt polled, if any.
 *   attempts         — attempt count AFTER this attempt has been counted (1-based).
 *   cap              — lifetime ceiling for this branch.
 *   freePollerEnabled— whether bootRecoveryService's free-GET sweep is actually
 *                      running (RESUME_IN_FLIGHT_ON_BOOT). Defaults true to match
 *                      that module's own default.
 * @returns {{action:'terminal'|'hold'|'release', reason:string, receipt:?string,
 *            attempts:number, cap:number}}
 *   terminal — stop: fail the ad, preserving the receipt for reconciliation.
 *   hold     — keep the claim; hand the row to the free receipt poller.
 *   release  — nothing was paid for; releasing into the queue is safe.
 *
 * Cap is checked FIRST, deliberately: a receipt-holding row that has somehow
 * come back round despite 'hold' is exactly the runaway this bounds, so the
 * ceiling must not be reachable-but-skipped just because a receipt is present.
 */
function resolveUnsettledTimeoutAction({ receipt, attempts, cap, freePollerEnabled = true } = {}) {
  const held = typeof receipt === 'string' && receipt.length > 0;
  // Fail CLOSED on a garbage attempt count — treat an unreadable counter as
  // "this is the first attempt" rather than as "cap reached", so a counter bug
  // can never silently terminal-fail a paid render on its first timeout.
  const nAttempts = Number(attempts);
  const attemptNo = Number.isFinite(nAttempts) && nAttempts > 0 ? nAttempts : 1;
  // FLOORED AT 2, and that floor is load-bearing. A ceiling of 1 would make
  // attempt 1 satisfy `attemptNo >= ceiling`, so the very FIRST timeout would
  // terminal-fail the ad — foreclosing the free receipt recovery that is the
  // entire reason this path does not write status:'failed' (a 'failed' row is
  // outside bootRecoveryService's `status:'rendering'` selector, so the paid
  // master could never be collected). An operator mis-setting
  // VIDEO_UNSETTLED_MAX_ATTEMPTS=1, or an unreadable value, must not be able to
  // convert a slow-but-succeeding render into a discarded charge. Unbounded is
  // the failure mode this whole change exists to remove, so the fallback still
  // bounds — just never on the first attempt.
  const nCap = Number(cap);
  const ceiling = Math.max(2, Number.isFinite(nCap) && nCap > 0 ? nCap : 2);

  const base = { receipt: held ? receipt : null, attempts: attemptNo, cap: ceiling };
  if (attemptNo >= ceiling) {
    return { action: 'terminal', reason: 'cap-reached', ...base };
  }
  if (held) {
    // NOTHING WOULD EVER COLLECT IT. Parking a paid row depends entirely on the
    // free-GET sweep running: the reaper skips claimed rows, the shutdown drain
    // only releases receipt-FREE rows, and no periodic scanner pages on a row
    // that is merely still-processing. With the sweep off, 'hold' is a permanent
    // silent strand, so failing honestly (receipt preserved for reconciliation)
    // is strictly better than parking forever.
    if (!freePollerEnabled) {
      return { action: 'terminal', reason: 'no-free-poller', ...base };
    }
    return { action: 'hold', reason: 'awaiting-free-recovery', ...base };
  }
  return { action: 'release', reason: 'no-receipt', ...base };
}

module.exports = { RECEIPT_FREE, HAS_RECEIPT, receiptFree, resolveUnsettledTimeoutAction };
