'use strict';

/**
 * ONE definition of "{rating, reviewCount} from a single source".
 *
 * Audit rec #9 — two confirmed holes:
 *   1. Director paired IMMERSIVE `product.rating` with STORE
 *      `productReviews.reviewCount` (two snapshots).
 *   2. hydrateMatch copied `catalog.rating` into details but never
 *      `productReviews.reviewCount`, so deriveSocialProofNumbers wrote an
 *      empty review_count even when the merchant aggregate had one.
 *
 * Kill switch: RATING_PAIR_ATOMIC (env, default FALSE). Flag-off is
 * byte-identical with today's mixed / empty-count behaviour. Flag-on
 * reads the pair atomically from ONE snapshot, never rating from A +
 * count from B.
 *
 * Flag-on precedence (provenance, not "productReviews is merchant"):
 *   1. SCRAPED productReviews pair — quotesOrigin === 'scraped', or an
 *      explicit scrape marker (`source === 'productReviewsScrape'`,
 *      non-empty `tiers`). Rating + store total. This is the only
 *      productReviews shape whose reviewCount is THIS STORE's total.
 *   2. llm-web productReviews pair (quotesOrigin === 'llm-web' or a
 *      Gemini `ratingSource` stamp). Rating only. The count is the
 *      WINNING WEB SOURCE's total (Trustpilot / retailer / tier-2
 *      "5.0 from 3"), not this store's — STATIC_BRAND_STARS_WITH_QUOTE
 *      constraint (b): no owner-approved qualifier means no label
 *      vehicle, so the count is withheld rather than typeset as
 *      unlabelled product reviews.
 *   3. Immersive / catalog.rating — rating only. NEVER reviews.length
 *      (hard-capped sample of 10, not a store total).
 *   4. Unknown-provenance productReviews — lower trust than scraped
 *      AND lower than immersive (integrations.js historically wrote
 *      Gemini payloads with no origin stamp). Rating only, if nothing
 *      higher exists.
 *   5. Scraped count-only, then a lone details.reviewCount. No invented
 *      stars.
 *
 * productReviews.rating is NOT "the authoritative merchant aggregate".
 * Gemini pickBestRating writes that field (quotesOrigin 'llm-web'),
 * including a documented tier-2 "5.0 from 3 reviews" override.
 * refreshOne scrapes but historically omitted quotesOrigin — treat
 * `source === 'productReviewsScrape'` as scraped.
 *
 * Display floors (RATING_STAR_MIN, QUOTE_MIN_RATING, the 4.19/>5000
 * volume exception, the sub-4.0 never-print rule) live in ratingDisplay
 * / layoutInputService and are NOT consulted here. This module does not
 * average kept reviews into a rating. resolveCoherentSocialProof's
 * brand/product pairing rules are untouched.
 */

function ratingPairAtomicEnabled() {
  return String(process.env.RATING_PAIR_ATOMIC ?? 'false').toLowerCase() === 'true';
}

function usableRating(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

// Positive finite only. 0 / negatives must not become Director count: 0.
function usableCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Classify a productReviews snapshot. Unknown is NEVER ranked above
 * scraped — a row with no origin stamp is not a merchant aggregate.
 *
 * @returns {'scraped'|'llm-web'|'unknown'|null}
 */
function classifyProductReviewsProvenance(pr) {
  if (!pr || typeof pr !== 'object') return null;
  if (pr.quotesOrigin === 'scraped') return 'scraped';
  if (pr.source === 'productReviewsScrape') return 'scraped';
  if (Array.isArray(pr.tiers) && pr.tiers.length > 0) return 'scraped';
  if (pr.quotesOrigin === 'llm-web') return 'llm-web';
  if (typeof pr.ratingSource === 'string' && pr.ratingSource.trim()) return 'llm-web';
  return 'unknown';
}

function isScrapedProductReviews(pr) {
  return classifyProductReviewsProvenance(pr) === 'scraped';
}

function fetchedAtMs(pr) {
  if (!pr || pr.fetchedAt == null) return 0;
  const t = new Date(pr.fetchedAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

const PROVENANCE_RANK = Object.freeze({ scraped: 0, 'llm-web': 1, unknown: 2 });

/**
 * Among several productReviews snapshots (details vs match vs catalog),
 * prefer scraped over llm-web over unknown; same provenance → newer
 * fetchedAt. A truthy stale details.productReviews must not beat a
 * fresher catalog pair of higher trust.
 */
function selectProductReviewsSnapshot(candidates) {
  const rows = (Array.isArray(candidates) ? candidates : [candidates])
    .filter((c) => c && typeof c === 'object');
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => {
    const pa = PROVENANCE_RANK[classifyProductReviewsProvenance(a)] ?? 3;
    const pb = PROVENANCE_RANK[classifyProductReviewsProvenance(b)] ?? 3;
    if (pa !== pb) return pa - pb;
    return fetchedAtMs(b) - fetchedAtMs(a);
  })[0];
}

function emptyPair() {
  return { rating: null, reviewCount: null, source: null, provenance: null };
}

/**
 * Atomic {rating, reviewCount} from product-scoped sources.
 *
 * @returns {{ rating: number|null, reviewCount: number|null, source: 'productReviews'|'immersive'|'details'|null, provenance: 'scraped'|'llm-web'|'unknown'|null }}
 */
function pickAtomicProductRatingPair({
  productReviews = null,
  rating = null,
  reviews = null,
  reviewCount = null
} = {}) {
  const pr = productReviews && typeof productReviews === 'object' ? productReviews : null;
  const provenance = classifyProductReviewsProvenance(pr);
  const prRating = usableRating(pr && pr.rating);
  const prCount = usableCount(pr && pr.reviewCount);
  // Only a scrape's reviewCount is this store's total. llm-web /
  // unknown counts are another site's (or unknown) and must not be
  // returned as a product reviewCount the viewer can read as ours.
  const storeCount = provenance === 'scraped' ? prCount : null;

  if (provenance === 'scraped' && prRating != null) {
    return { rating: prRating, reviewCount: storeCount, source: 'productReviews', provenance };
  }

  if (provenance === 'llm-web' && prRating != null) {
    return { rating: prRating, reviewCount: null, source: 'productReviews', provenance };
  }

  // Immersive / catalog.rating. reviews is a capped sample (top 10) —
  // NEVER synthesize a store total from reviews.length. `reviews` is
  // accepted so callers can pass the same shape; it is not read.
  void reviews;
  const immersiveRating = usableRating(rating);
  if (immersiveRating != null) {
    return { rating: immersiveRating, reviewCount: null, source: 'immersive', provenance: null };
  }

  // Unknown provenance: lower trust than scraped and lower than
  // immersive. Use the rating only when nothing higher exists.
  if (provenance === 'unknown' && prRating != null) {
    return { rating: prRating, reviewCount: null, source: 'productReviews', provenance };
  }

  if (storeCount != null) {
    return { rating: null, reviewCount: storeCount, source: 'productReviews', provenance };
  }

  const detailCount = usableCount(reviewCount);
  if (detailCount != null) {
    return { rating: null, reviewCount: detailCount, source: 'details', provenance: null };
  }

  return emptyPair();
}

/**
 * Today's Director expressions, verbatim. Flag-off MUST stay this mix:
 * immersive `product.rating` + (`productReviews.reviewCount` ?? reviews.length).
 */
function pickLegacyDirectorPair(product) {
  const rating = typeof product?.rating === 'number' && product.rating > 0 ? product.rating : null;
  const reviewCount = product?.productReviews?.reviewCount
                    ?? (Array.isArray(product?.reviews) ? product.reviews.length : null);
  return { rating, reviewCount, source: 'legacy' };
}

function resolveDirectorProductRatingPair(product) {
  if (!ratingPairAtomicEnabled()) return pickLegacyDirectorPair(product);
  return pickAtomicProductRatingPair({
    productReviews: product?.productReviews,
    rating: product?.rating,
    reviews: product?.reviews,
    reviewCount: product?.reviewCount
  });
}

/**
 * Flag-off deriveSocialProofNumbers product branch, verbatim: independent
 * reads of details.rating / details.reviewCount. Returns null when product
 * has neither so the caller can run the (unchanged) brand fallback.
 */
function pickLegacyDeriveProductPair(details) {
  const hasProductNumber = typeof details?.rating === 'number' || typeof details?.reviewCount === 'number';
  if (!hasProductNumber) return null;
  return {
    rating_value:  details.rating,
    review_count:  details.reviewCount,
    rating_source: 'product'
  };
}

function resolveDeriveProductPair(details, productReviews) {
  if (!ratingPairAtomicEnabled()) return pickLegacyDeriveProductPair(details);
  const candidates = Array.isArray(productReviews)
    ? productReviews.concat([details && details.productReviews])
    : [productReviews, details && details.productReviews];
  const chosen = selectProductReviewsSnapshot(candidates);
  const pair = pickAtomicProductRatingPair({
    productReviews: chosen,
    rating: details?.rating,
    reviews: details?.reviews,
    reviewCount: details?.reviewCount
  });
  if (pair.rating != null || pair.reviewCount != null) {
    return {
      rating_value:  pair.rating != null ? pair.rating : undefined,
      review_count:  pair.reviewCount != null ? pair.reviewCount : undefined,
      rating_source: 'product'
    };
  }
  return null;
}

/**
 * Flag-on: apply the atomic pair onto `details` so rating and count
 * stay a single snapshot. Independent readers (badges / trusted_by /
 * derivation prompt) must not see immersive rating + store count.
 * Flag-off: no-op so a spread snapshot stays byte-identical.
 */
function applyHydratedRatingPair(details, catalog, snapDetails) {
  if (!ratingPairAtomicEnabled() || !details || typeof details !== 'object') return details;
  if (catalog && catalog.productReviews) {
    details.productReviews = catalog.productReviews;
  }
  const pair = pickAtomicProductRatingPair({
    productReviews: (catalog && catalog.productReviews) || details.productReviews || null,
    rating: details.rating,
    reviews: details.reviews,
    reviewCount: snapDetails && snapDetails.reviewCount
  });
  if (pair.rating != null) {
    details.rating = pair.rating;
  } else if (pair.reviewCount != null) {
    // Count-only: a leftover immersive rating beside this count is the mix.
    details.rating = null;
  }
  details.reviewCount = pair.reviewCount != null ? pair.reviewCount : null;
  return details;
}

/**
 * Flag-on: the atomic pair's count (null when rating-only). Flag-off:
 * undefined so the caller does not assign the key.
 */
function hydratedReviewCount(catalog, snapDetails) {
  if (!ratingPairAtomicEnabled()) return undefined;
  const details = {
    rating: catalog && catalog.rating != null
      ? catalog.rating
      : (snapDetails && snapDetails.rating != null ? snapDetails.rating : null),
    reviews: (catalog && catalog.reviews) || (snapDetails && snapDetails.reviews) || [],
    productReviews: catalog && catalog.productReviews
  };
  applyHydratedRatingPair(details, catalog, snapDetails);
  return details.reviewCount;
}

module.exports = {
  ratingPairAtomicEnabled,
  usableRating,
  usableCount,
  classifyProductReviewsProvenance,
  isScrapedProductReviews,
  selectProductReviewsSnapshot,
  pickAtomicProductRatingPair,
  pickLegacyDirectorPair,
  resolveDirectorProductRatingPair,
  pickLegacyDeriveProductPair,
  resolveDeriveProductPair,
  applyHydratedRatingPair,
  hydratedReviewCount
};
