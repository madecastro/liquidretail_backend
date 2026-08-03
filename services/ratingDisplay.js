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
 * ATOMIC rating + reviewCount pair resolution.
 *
 * CRITICAL HISTORY: a brand-level cascade tier once mixed sources — a product's
 * 41,000-review count printed next to the brand's 3.3 rating. That path was
 * removed. This resolver is the ONLY brand fallback and is ATOMIC: rating and
 * count always come from the SAME tier (product pair OR brand pair), never
 * mixed.
 *
 * Product pair first. If it yields no displayable rating (formatDisplayRating
 * gate), try the brand pair (same gate). When the brand pair is used,
 * reviewsText attributes the count to the brand domain/name so the ad never
 * implies product-level reviews.
 *
 * If brand rating passes but brand count is missing → show rating with NO
 * count (never the product's count).
 *
 * Data source for brand pair (caller's responsibility): Brand.brandReviews
 * ({ rating, reviewCount }) — same Gemini grounded-search snapshot written by
 * enrichBrandFromUrl / productMatchService. Prefer that over averaging
 * CatalogProduct rows (partial coverage, not a true brand aggregate).
 *
 * @returns {{ rating: string|null, reviewCount: number|null, reviewsText: string|null, source: 'product'|'brand'|null }}
 */
function resolveAtomicRatingPair({
  productRating = null,
  productReviewCount = null,
  brandRating = null,
  brandReviewCount = null,
  brandAttribution = null,
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
    let reviewsText = null;
    if (rc != null) {
      const label = brandAttribution && String(brandAttribution).trim();
      reviewsText = label
        ? `${rc} review${rc === 1 ? '' : 's'} · ${label}`
        : `${rc} review${rc === 1 ? '' : 's'}`;
    }
    return {
      rating: brandDisplay,
      reviewCount: rc,
      reviewsText,
      source: 'brand',
    };
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
