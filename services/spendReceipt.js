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
 * THE READ SIDE (2026-08-27) — the same two receipts, for a RESPONSE PAYLOAD.
 *
 * Everything above answers "may I requeue this ad?" as a Mongo filter. This
 * answers "what did this ad cost, and what is the handle?" for an HTTP consumer,
 * and it lives here so the read side and the write side can never disagree about
 * which two fields ARE the receipt. Used by `routes/ads.js` projectAd and by
 * `routes/catalog.js`'s parallel ads-detail allowlist — those two are required
 * to stay in lockstep (that file says so in three places) and a copied
 * expression in each is how they drift apart.
 *
 * WHY THE STRING GUARD IS NOT DECORATION. `Ad.imageGeneration` is Mongoose
 * `Mixed`, so a legacy or corrupt row can hold anything: a string parent, an
 * array, or an object whose `predictionId` is itself an object. A bare
 * `x || null` passes every truthy non-string straight through into JSON, so the
 * payload would advertise an object as a spend receipt. A receipt is a provider
 * id — a non-empty string — or it is absent. Anything else is `null`, which is
 * the honest answer and is also fail-closed: it can never invent a receipt.
 * (`services/adStage.js` reaches for `String(predictionId)` at its own call
 * site for the same reason; coercing here would instead let `[object Object]`
 * masquerade as an id, so this refuses rather than stringifies.)
 *
 * Field names deliberately mirror the DOCUMENT paths so an operator can move
 * from a payload straight to a query: `veoPredictionId` is verbatim, and
 * `imageGenerationPredictionId` is the flattening of `imageGeneration
 * .predictionId`. (`veoPredictionId` is an Omni id despite the legacy name —
 * CLAUDE.md §2.)
 *
 * NOT merged into one `predictionId`. `GET /api/ads/render-activity` already
 * publishes a merged form with an `image || veo` precedence; re-deriving that
 * precedence here would be a second copy of it, and the merged form also loses
 * WHICH provider billed.
 */
function receiptId(value) {
  return (typeof value === 'string' && value) ? value : null;
}

function adSpendReceipts(ad) {
  const doc = ad || {};
  const img = doc.imageGeneration;
  return {
    veoPredictionId: receiptId(doc.veoPredictionId),
    // Guard the PARENT's type too: on a string parent `img.predictionId` is
    // undefined, but on an array `[]` it is also undefined while on a String
    // OBJECT it could resolve — only a plain object may carry a receipt.
    imageGenerationPredictionId:
      (img && typeof img === 'object' && !Array.isArray(img))
        ? receiptId(img.predictionId)
        : null
  };
}

module.exports = { RECEIPT_FREE, HAS_RECEIPT, receiptFree, adSpendReceipts, receiptId };
