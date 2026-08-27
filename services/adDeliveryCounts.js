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
 * `adTitlingTruth.isAdHonestlyDelivered` requires `draft|live|archived` AND
 * (for video) `isVideoTitlingSettled` — and applied it to ads-DETAIL, the run
 * rollup and Meta push. It never reached these two summary aggregations. This
 * module applies the repo's own existing definition to the last surface that
 * lacked it.
 *
 * ⚠️ "Applies the repo's definition" means BOTH conjuncts, not just the status
 * one. The first draft of this module implemented `$in: ['draft','live']` alone
 * and claimed alignment — adversarial review caught that as a MAJOR, because it
 * leaves an untitled video draft (paid master landed, chrome never composited)
 * counting as coverage while `isAdHonestlyDelivered` — projected as `titled:`
 * on ads-detail in these very same route files — says it is not delivered. Two
 * definitions of delivered on one route is precisely the drift this module
 * exists to prevent. `deliveredExpr()` below is the full predicate, and its
 * parity with the JS function is proven by execution against a real mongod.
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

const { INTENTIONAL_NO_TITLING_STAGE_RE } = require('./adTitlingTruth');

/**
 * The STATUS half of delivered. Scoped to what can appear in these pipelines'
 * population — they already exclude `archived`, which is delivered-but-hidden,
 * so within that population the status cut is exactly draft|live.
 *
 * ⚠️ THIS IS NOT THE WHOLE PREDICATE. `isAdHonestlyDelivered` is status AND
 * `isVideoTitlingSettled`, and dropping the second conjunct leaves a real
 * "covered but nothing shipped" case — see `titlingSettledExpr` below.
 */
const DELIVERED_STATUSES = ['draft', 'live'];

/** Attempted, no asset yet, not a failure. Reported, never counted as covered. */
const IN_FLIGHT_STATUSES = ['queued', 'rendering'];

/** Terminal failure. */
const FAILED_STATUSES = ['failed'];

/**
 * Aggregation mirror of `adTitlingTruth.isVideoTitlingSettled`, branch for
 * branch, so ONE meaning of delivered serves both the per-document readers and
 * these aggregations.
 *
 * ── WHY THIS EXISTS (adversarial review, 2026-08-27) ──────────────────────
 * A status-only cut of `draft|live` is the status HALF of
 * `isAdHonestlyDelivered` and drops the conjunct that function was written
 * for. The gap is not theoretical and it is exactly the defect class this
 * module claims to close:
 *   an Omni master lands → `status:'draft'`, `renderUrl === veoVideoUrl`,
 *   `titlingResumeState:'claimed'`. A status-only predicate counts that as
 *   COVERED. `isAdHonestlyDelivered` says it is NOT delivered (titling never
 *   settled). Both live in the same two route files — `titled:
 *   isAdHonestlyDelivered(a)` is projected on ads-detail — so the dashboard
 *   would say "covered" while the detail row said "titled: false". If titling
 *   is then abandoned, the untitled orphan stays `draft` and stays coverage
 *   forever. CLAUDE.md's own money invariant is "Untitled is not success".
 *
 * The regex is IMPORTED from adTitlingTruth, never re-written here — that
 * module's comment says outright it is "kept as a named export so a harness
 * can assert new call sites stay consistent with it instead of inventing a
 * fourth wording". `$regexMatch` takes source+options rather than a BSON
 * regex so this stays legible and driver-version-independent.
 *
 * Parity with the JS function is proven by EXECUTION, not by reading:
 * scripts/verifyTruthfulReporting.js group D runs both over the same matrix of
 * ad shapes through a real mongod and demands they agree on every row.
 */
function titlingSettledExpr() {
  return {
    $switch: {
      branches: [
        // Statics have no titling step at all.
        { case: { $ne: ['$kind', 'video'] }, then: true },
        // Recovery debt still open — not settled either way.
        { case: { $in: ['$titlingResumeState', ['pending', 'claimed']] }, then: false },
        // Nothing shipped yet.
        { case: { $in: [{ $ifNull: ['$renderUrl', ''] }, ['', null]] }, then: false },
        // No raw master to compare against — fail toward settled, matching the
        // JS function's own comment rather than crashing on an odd shape.
        { case: { $in: [{ $ifNull: ['$veoVideoUrl', ''] }, ['', null]] }, then: true },
        // Delivered asset differs from the raw master — something composited.
        { case: { $ne: ['$renderUrl', '$veoVideoUrl'] }, then: true }
      ],
      // renderUrl === veoVideoUrl: settled ONLY on a declared, intentional
      // bare-master ship. Silence is not settled.
      default: {
        $regexMatch: {
          input:   { $ifNull: ['$renderStage', ''] },
          regex:   INTENTIONAL_NO_TITLING_STAGE_RE.source,
          options: 'i'
        }
      }
    }
  };
}

/**
 * The FULL delivered predicate as an aggregation expression:
 * terminal status AND titling settled. Mirrors `isAdHonestlyDelivered`
 * intersected with these pipelines' non-archived population.
 */
function deliveredExpr() {
  return {
    $and: [
      { $in: ['$status', DELIVERED_STATUSES] },
      titlingSettledExpr()
    ]
  };
}

/**
 * `$sum`-able accumulator counting rows whose status is in `statuses`.
 * Returned as a fresh object each call — a shared literal reused across two
 * `$group` stages would be the same object reference in both pipelines, which
 * is fine for Mongo but a trap if anything ever mutates it.
 */
function countOfStatuses(statuses) {
  return { $sum: { $cond: [{ $in: ['$status', statuses] }, 1, 0] } };
}

/** The outcome accumulators every coverage surface should carry. */
function outcomeAccumulators() {
  return {
    // The FULL predicate — status AND titling settled.
    deliveredCount: { $sum: { $cond: [deliveredExpr(), 1, 0] } },
    failedCount:    countOfStatuses(FAILED_STATUSES),
    inFlightCount:  countOfStatuses(IN_FLIGHT_STATUSES),
    // Reported separately because it is a DIFFERENT problem from a failure and
    // has a different remedy (titling resume, not regenerate): the ad holds a
    // paid master but never got its chrome. Previously invisible — it counted
    // as coverage.
    untitledDeliverableCount: {
      $sum: {
        $cond: [
          { $and: [
            { $in: ['$status', DELIVERED_STATUSES] },
            { $not: [titlingSettledExpr()] }
          ] }, 1, 0
        ]
      }
    }
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
      // Same FULL predicate as deliveredCount. A status-only test here would
      // reintroduce the untitled-draft hole on the per-product set while the
      // count above stayed clean — the two must not disagree.
      $cond: [deliveredExpr(), fieldRef, null]
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

/**
 * Is this row's STATUS a deliverable one? Status half only.
 *
 * If you need the real answer for a single document, call
 * `adTitlingTruth.isAdHonestlyDelivered(ad)` — that is the authority and it
 * also checks titling. This helper is named `...Status` so a caller cannot
 * mistake it for the whole predicate.
 */
function isDeliveredStatus(status) {
  return DELIVERED_STATUSES.includes(status);
}

module.exports = {
  DELIVERED_STATUSES,
  IN_FLIGHT_STATUSES,
  FAILED_STATUSES,
  // Exported so scripts/verifyTruthfulReporting.js can run these against a real
  // mongod and demand they agree with adTitlingTruth's JS functions row by row.
  titlingSettledExpr,
  deliveredExpr,
  countOfStatuses,
  outcomeAccumulators,
  distinctOnDelivered,
  coveragePctFromDelivered,
  isDeliveredStatus
};
