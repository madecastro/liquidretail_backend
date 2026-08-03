'use strict';

/**
 * ONE definition of "may this star rating print on an ad".
 *
 * Shared by the static path (directImageRenderService.buildIntentData) and the
 * video chrome path (brandScriptExecutor.buildMetaForAd → Remotion Canonical).
 * Owner rule is about star display generally, not one surface — a raw 3.2 must
 * not burn into a Reel either.
 *
 * Owner rule (verbatim): "we only use stars over 4.5". Strictly greater than
 * this floor is required; exactly 4.5 does not print.
 */
const RATING_STAR_MIN = 4.5;

/**
 * Format a raw rating for display, or withhold it.
 *
 * WHY the gate tests the ROUNDED (one-decimal) value, not the raw one:
 * a raw gate of `rating_value > 4.5` lets 4.51 through, then `toFixed(1)`
 * prints "4.5" — the exact value the owner rule forbids. Confirmed by
 * execution against the old static gate:
 *   rating_value=4.51  passesGate=true  -> displays "4.5"
 *   rating_value=4.54  passesGate=true  -> displays "4.5"
 *   rating_value=4.55  passesGate=true  -> displays "4.5"
 * Compute the displayed number first, then require THAT to be
 * `> RATING_STAR_MIN` and `<= 5`. Upper bound still catches a 0–100 vendor
 * scale that would otherwise render as "87 stars".
 *
 * @param {*} raw  Candidate rating (must be a finite number to print).
 * @returns {string|undefined} display string (e.g. "4.6") or undefined to withhold.
 */
function formatDisplayRating(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const displayed = Number(raw.toFixed(1));
  if (!(displayed > RATING_STAR_MIN && displayed <= 5)) return undefined;
  return String(displayed);
}

module.exports = {
  RATING_STAR_MIN,
  formatDisplayRating,
};
