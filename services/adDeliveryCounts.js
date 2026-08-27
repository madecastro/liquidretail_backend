'use strict';

/**
 * adDeliveryCounts — ONE definition of "this ad is a deliverable asset", used
 * by every dashboard counter that means coverage.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────
 * `GET /api/catalog/ads-summary` reported `coveragePct: 100, adCount: 12` for a
 * product whose TWELVE ads had all FAILED with zero assets — the same response
 * carried `draftCount: 0, liveCount: 0, readyToExport: 0`. The page header
 * advanced 18 → 30 "ADS CREATED" and "1 of 200" → "2 of 200 products" covered.
 * Measured in the live app 2026-08-27. So the dashboard called a product fully
 * covered when nothing shipped.
 *
 * Mechanism: coverage divided `adCount` — a bare `$sum: 1` over every
 * non-archived Ad row — by TARGET_ADS_PER_PRODUCT. `Ad.status` has six values
 * (`queued`, `rendering`, `draft`, `live`, `archived`, `failed`) and only
 * `$ne: 'archived'` was ever excluded, so `failed`, `queued` and `rendering`
 * all counted as coverage.
 *
 * ── THIS IS AN ALIGNMENT, NOT A REVERSAL — checked before changing ─────────
 * Coverage shipped in `ed3e6d83` (2026-06-23) explicitly as a placeholder:
 * the commit message says "coverage % (placeholder formula: adCount / 5, capped
 * at 100)" and the code comment beside TARGET_ADS_PER_PRODUCT still says Phase 2
 * will replace it with real opportunity scoring. The ONLY status rule anyone
 * wrote down for it was `$ne: 'archived'`. That same commit already computed
 * `failedCount` as its own `$cond` — and then never returned it and never
 * subtracted it. The distinction was drawn and left unused; nobody decided that
 * failures are coverage.
 *
 * Then `9d632297` (#278) DID define "delivered" for this repo —
 * `adTitlingTruth.isAdHonestlyDelivered` requires `draft|live|archived` and its
 * comment names `'failed' and anything non-terminal (queued/rendering)` as
 * never delivered — and applied it to ads-DETAIL, the run rollup and Meta push.
 * It never reached these two summary aggregations. This module applies the
 * repo's own existing definition to the last surface that lacked it.
 *
 * ── WHY IN-FLIGHT IS EXCLUDED, DELIBERATELY ────────────────────────────────
 * `queued`/`rendering` rows have zero assets too, so counting them as covered
 * recreates the identical "covered but nothing shipped" lie for the duration of
 * a run, then collapses when the run fails — a flicker, not a signal. The repo
 * already excludes them from `isAdHonestlyDelivered` and from
 * `GET /api/ads?rendered=true`; one rule beats two. They are instead REPORTED
 * separately (`inFlightCount`) so a UI can say "generating" rather than having
 * to choose between "covered" and "none".
 *
 * ── WHAT IS DELIBERATELY *NOT* CHANGED ─────────────────────────────────────
 * `adCount` / `adsCreated` stay every non-archived row. "12 ads were created"
 * is TRUE even when all 12 failed; the untruth was calling that product
 * covered. Narrowing those too would swap one false statement for another.
 *
 * `renderUrl` is deliberately NOT part of the predicate either: a QC-failed
 * video keeps its paid master (`33259f9c`), so a `failed` row can legitimately
 * hold a URL. Status is the honest signal.
 */

/**
 * A deliverable creative. Scoped to what can appear in these pipelines'
 * population — they already exclude `archived`, which is delivered-but-hidden,
 * so within that population delivered is exactly draft|live.
 */
const DELIVERED_STATUSES = ['draft', 'live'];

/** Attempted, no asset yet, not a failure. Reported, never counted as covered. */
const IN_FLIGHT_STATUSES = ['queued', 'rendering'];

/** Terminal failure. */
const FAILED_STATUSES = ['failed'];

/**
 * `$sum`-able accumulator counting rows whose status is in `statuses`.
 * Returned as a fresh object each call — a shared literal reused across two
 * `$group` stages would be the same object reference in both pipelines, which
 * is fine for Mongo but a trap if anything ever mutates it.
 */
function countOfStatuses(statuses) {
  return { $sum: { $cond: [{ $in: ['$status', statuses] }, 1, 0] } };
}

/** The three outcome accumulators every coverage surface should carry. */
function outcomeAccumulators() {
  return {
    deliveredCount: countOfStatuses(DELIVERED_STATUSES),
    failedCount:    countOfStatuses(FAILED_STATUSES),
    inFlightCount:  countOfStatuses(IN_FLIGHT_STATUSES)
  };
}

/**
 * `$addToSet` collecting the grouped field ONLY on delivered rows (nulls
 * elsewhere — `$addToSet` cannot be conditional, so callers filter the nulls
 * out exactly as they already do for the unconditional set).
 */
function distinctOnDelivered(fieldRef) {
  return {
    $addToSet: {
      $cond: [{ $in: ['$status', DELIVERED_STATUSES] }, fieldRef, null]
    }
  };
}

/**
 * Coverage as a percentage of a per-product target, from DELIVERED ads.
 * Clamped to 100 and floored at 0; a non-finite or negative target yields 0
 * rather than NaN/Infinity reaching the SPA (`Number('')` is 0, and this repo
 * has been bitten by a blanked env var becoming a live 0 threshold before).
 */
function coveragePctFromDelivered(deliveredCount, target) {
  const d = Number(deliveredCount);
  const t = Number(target);
  if (!Number.isFinite(d) || d <= 0) return 0;
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((d / t) * 100)));
}

/** Is this row a deliverable asset? For per-document (non-aggregation) use. */
function isDeliveredStatus(status) {
  return DELIVERED_STATUSES.includes(status);
}

module.exports = {
  DELIVERED_STATUSES,
  IN_FLIGHT_STATUSES,
  FAILED_STATUSES,
  countOfStatuses,
  outcomeAccumulators,
  distinctOnDelivered,
  coveragePctFromDelivered,
  isDeliveredStatus
};
