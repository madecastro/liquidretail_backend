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
// THE RULE: a requeue may only ever touch RECEIPT-FREE ads. Those were never
// billed — the process died before or during submit — so re-running them costs
// the one charge that was always owed. Receipt-HOLDING ads stay in `rendering`,
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

module.exports = { RECEIPT_FREE, HAS_RECEIPT, receiptFree };
