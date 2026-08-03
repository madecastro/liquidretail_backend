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

/**
 * Normalize a review count for display. Positive finite numbers only.
 * @returns {number|null}
 */
function normalizeReviewCount(raw) {
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Honest brand label for attribution when the brand aggregate rating pair is
 * used (never imply the count is product-level). Prefer domain from websiteUrl,
 * else brand name.
 */
function brandAttributionLabel(brand) {
  if (!brand || typeof brand !== 'object') return null;
  const rawUrl = brand.websiteUrl || brand.brandWebsiteUrl || null;
  if (rawUrl && typeof rawUrl === 'string' && rawUrl.trim()) {
    try {
      const href = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl.trim()}`;
      const host = new URL(href).hostname.replace(/^www\./i, '');
      if (host) return host;
    } catch { /* fall through to name */ }
  }
  const name = brand.name && String(brand.name).trim();
  return name || null;
}

/**
 * Build the brand-tier reviewsText string (count + optional attribution).
 * Extracted so the brand-rating branch and the brand-count-only branch
 * (allowBrandCountWithoutStars) share ONE pluralisation/attribution
 * implementation — the same count must read identically whether or not
 * stars are printing alongside it.
 * @returns {string|null}
 */
function formatBrandReviewsText(rc, brandAttribution) {
  if (rc == null) return null;
  const label = brandAttribution && String(brandAttribution).trim();
  return label
    ? `${rc} review${rc === 1 ? '' : 's'} · ${label}`
    : `${rc} review${rc === 1 ? '' : 's'}`;
}

/**
 * ATOMIC rating + reviewCount pair resolution.
 *
 * CRITICAL HISTORY: a brand-level cascade tier once mixed sources — a product's
 * 41,000-review count printed next to the brand's 3.3 rating. That path was
 * removed. This resolver is the ONLY brand fallback and is ATOMIC: rating and
 * count always come from the SAME tier (product pair OR brand pair), never
 * mixed. The new brand-count-without-stars outcome below is still tier-atomic
 * — it only ever pairs the brand's own count with the brand's own quote (see
 * the call site gate in buildMetaForAd), never a product-tier quote.
 *
 * Product pair first. If it yields no displayable rating (formatDisplayRating
 * gate), try the brand pair (same gate). When the brand pair is used,
 * reviewsText attributes the count to the brand domain/name so the ad never
 * implies product-level reviews.
 *
 * If brand rating passes but brand count is missing → show rating with NO
 * count (never the product's count).
 *
 * If NEITHER pair clears the star gate (most brands: only 4 of 34 clear
 * >4.5 today — e.g. GymShark sits at 3.3 with 41,000 reviews, AllBirds has
 * no brand rating at all), a failing/missing rating would otherwise mean NO
 * social proof at all. `allowBrandCountWithoutStars` lets the brand's review
 * COUNT print alone (no stars — the owner rule "we only use stars over 4.5"
 * is untouched, see formatDisplayRating) when the caller has independently
 * confirmed the accompanying quote is also brand-tier — count and quote must
 * still come from the same tier, so this must never be turned on next to a
 * product-tier quote.
 *
 * Data source for brand pair (caller's responsibility): Brand.brandReviews
 * ({ rating, reviewCount }) — same Gemini grounded-search snapshot written by
 * enrichBrandFromUrl / productMatchService. Prefer that over averaging
 * CatalogProduct rows (partial coverage, not a true brand aggregate).
 *
 * @param {boolean} [allowBrandCountWithoutStars=false] Only set true when the
 *   quote alongside this pair is confirmed brand-tier (never product-tier).
 * @returns {{ rating: string|null, reviewCount: number|null, reviewsText: string|null, source: 'product'|'brand'|'brand-count'|null }}
 */
function resolveAtomicRatingPair({
  productRating = null,
  productReviewCount = null,
  brandRating = null,
  brandReviewCount = null,
  brandAttribution = null,
  allowBrandCountWithoutStars = false,
} = {}) {
  const productDisplay = formatDisplayRating(productRating);
  if (productDisplay) {
    // Product pair — count from product tier only (may be null).
    const rc = normalizeReviewCount(productReviewCount);
    return {
      rating: productDisplay,
      reviewCount: rc,
      reviewsText: rc != null ? `${rc} review${rc === 1 ? '' : 's'}` : null,
      source: 'product',
    };
  }

  const brandDisplay = formatDisplayRating(brandRating);
  if (brandDisplay) {
    // Brand pair — count from brand tier ONLY. Never productReviewCount.
    const rc = normalizeReviewCount(brandReviewCount);
    return {
      rating: brandDisplay,
      reviewCount: rc,
      reviewsText: formatBrandReviewsText(rc, brandAttribution),
      source: 'brand',
    };
  }

  if (allowBrandCountWithoutStars) {
    // Neither tier clears the star gate, but a strong brand review COUNT is
    // still honest, strong social proof on its own. Rating stays null (no
    // stars print) — only the count text prints.
    const rc = normalizeReviewCount(brandReviewCount);
    if (rc != null) {
      return {
        rating: null,
        reviewCount: rc,
        reviewsText: formatBrandReviewsText(rc, brandAttribution),
        source: 'brand-count',
      };
    }
  }

  return { rating: null, reviewCount: null, reviewsText: null, source: null };
}

module.exports = {
  RATING_STAR_MIN,
  formatDisplayRating,
  normalizeReviewCount,
  brandAttributionLabel,
  resolveAtomicRatingPair,
};
