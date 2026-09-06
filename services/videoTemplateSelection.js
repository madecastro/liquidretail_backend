'use strict';

/**
 * Deterministic, LLM-free Ad.template picker for video minting.
 *
 * WHY THIS EXISTS. expandDeterministicVideo used to stamp every video Ad
 * `template: 'ai_brand_led'`. Live consequence (measured 2026-09-03, adgen
 * session against the shared Ad collection): 1,693 of 1,693 video ads
 * carried that one template. Static ads on the same brands already vary
 * because the Director picks `routing.creative_style`. Video's mint path
 * never consults the Director — and must not start: that would add a paid
 * LLM round to the most expensive path in the system (billable Omni) for
 * a decision catalog data already supports.
 *
 * THIS FILE IS THE PRODUCTION MINT SITE. liquidretail_adgen's copy of
 * expandDeterministicVideo is a Phase-0 no-op; expansion / mint still
 * run here. Adgen's renderer already varies titling by Ad.template
 * (titleIntentComposition) once this field is not a constant.
 *
 * SELECTION MECHANISM mirrors staticAdIntents FALLBACK_ORDER / eligible():
 * walk a priority list, take the first intent whose real-data check passes,
 * floor is always eligible. This module picks an Ad.template string, not an
 * image-generation prompt, and does not duplicate static intent philosophy.
 *
 *   1. ai_social_proof_led — printable product rating with a real store
 *      review count (not a lone 5.0 / not reviews.length) OR a product-tier
 *      quote that already clears the same gates render uses
 *      (pickPrimaryProductQuote → toPrintableCustomerQuote + colourway;
 *      applyStrictQuoteScope is a no-op on product-tier).
 *   2. ai_editorial — floor. Maps to product_first_lifestyle
 *      (directImageRenderService.DEFAULT_INTENT / lifestyleIntentFromTemplate
 *      fallthrough): always eligible, degrades to a good product photograph,
 *      never a broken render.
 *
 * NEVER selected here:
 *   - ai_brand_led — that was the silent default this module exists to
 *     end. BRAND_LED_COPY still gates whether INTENTS.brand_led can
 *     render at all; minting it without a data reason would re-cluster
 *     every no-proof product onto the same treatment. Editorial is the
 *     documented floor.
 *   - ai_ugc_led / ai_promotional — both map to objection_resolved
 *     (static TEMPLATE_INTENT, owner-approved 2026-08-24). objection_resolved
 *     is "the customer's sentence is the whole ad", which the quote arm of
 *     social_proof_led already covers. UGC as a visual seed is already
 *     the Omni reference stack; it is not a second template axis.
 *
 * COST. Pure function of an already-loaded CatalogProduct. Zero Atlas /
 * LLM / vision calls. The mint site loads the product docs in one
 * indexed `$in` (see expandDeterministicVideo).
 */

const {
  formatDisplayRating,
  normalizeReviewCount,
  RATING_STAR_MIN,
  RATING_STAR_VOLUME_MIN,
  RATING_STAR_VOLUME_COUNT_MIN,
} = require('./ratingDisplay');
const { pickAtomicProductRatingPair } = require('./ratingPairAtomic');
const {
  toPrintableCustomerQuote,
  applyStrictQuoteScope,
} = require('./quoteProvenance');
const { applyQuoteColourway } = require('./quoteColourway');

const TEMPLATE_SOCIAL_PROOF = 'ai_social_proof_led';
const TEMPLATE_FLOOR = 'ai_editorial';

/**
 * Minimum honest store-total for the rating-as-hero arm.
 *
 * 2, not 1: a lone 5.0 from one review is the named defect. Not 50:
 * aiCreativeDirectorService ~1534 (`rating ≥ 4.5 AND count ≥ 50`) is the
 * STAT-LED ARCHETYPE bar ("the number is the concept"). The CREATIVE
 * STYLE block a few hundred lines below picks social_proof_led whenever
 * a usable rating OR quote exists — and staticAdIntents.eligible() is
 * `d.rating || d.quote` after ratingDisplay has already gated the
 * stars. Matching that style bar, not the archetype bar, keeps video
 * mint and image render on the same treatment.
 *
 * Count must come from pickAtomicProductRatingPair (scraped store total).
 * reviews.length is a capped Immersive sample of 10 and is never a total.
 */
const MIN_STORE_REVIEW_COUNT = 2;

let _pickPrimaryProductQuote = undefined;

function loadPickPrimaryProductQuote() {
  if (_pickPrimaryProductQuote !== undefined) return _pickPrimaryProductQuote;
  try {
    _pickPrimaryProductQuote = require('./layoutInputService').pickPrimaryProductQuote;
  } catch {
    _pickPrimaryProductQuote = null;
  }
  return _pickPrimaryProductQuote;
}

function productStarFloorForCount(count) {
  const rc = normalizeReviewCount(count);
  if (rc != null && rc > RATING_STAR_VOLUME_COUNT_MIN) return RATING_STAR_VOLUME_MIN;
  return RATING_STAR_MIN;
}

/**
 * Atomic product {rating, reviewCount} — same helper the Director uses
 * under RATING_PAIR_ATOMIC, always on here. Mint-time selection must not
 * inherit the flag-off mix (immersive rating + store/reviews.length
 * count): that mix is how a "5.0 from 3" becomes a review total.
 */
function atomicProductPair(product) {
  if (!product || typeof product !== 'object') {
    return { rating: null, reviewCount: null, source: null, provenance: null };
  }
  return pickAtomicProductRatingPair({
    productReviews: product.productReviews,
    rating: product.rating,
    reviews: product.reviews,
    reviewCount: product.reviewCount
  });
}

function hasUsableVideoRating(product) {
  const atomic = atomicProductPair(product);
  const count = normalizeReviewCount(atomic.reviewCount);
  if (count == null || count < MIN_STORE_REVIEW_COUNT) return false;
  const displayed = formatDisplayRating(atomic.rating, productStarFloorForCount(count));
  return !!displayed;
}

/**
 * Product-tier quote the renderer would actually print. Reuses
 * pickPrimaryProductQuote (stamp → printable → star gate → colourway →
 * strongest) so mint-time eligibility cannot diverge from the pool
 * buildMetaForAd / buildIntentData already consume. Brand-tier quotes
 * are not consulted: expandDeterministicVideo always has a product, and
 * the Director's own isProductScoped rule withholds brand quotes from
 * product ads for the same cross-SKU reason.
 *
 * Short-circuits before requiring layoutInputService when the product
 * has no quotes array — rating-only / empty products stay a cheap
 * in-process check.
 */
function hasUsableVideoQuote(product) {
  const pr = product && product.productReviews;
  if (!pr || !Array.isArray(pr.quotes) || !pr.quotes.length) return false;
  const pickPrimaryProductQuote = loadPickPrimaryProductQuote();
  if (typeof pickPrimaryProductQuote !== 'function') return false;
  const picked = pickPrimaryProductQuote(pr, {
    productTitle: product.title || null
  });
  if (!picked) return false;
  const printable = toPrintableCustomerQuote(picked) || picked;
  const scoped = applyStrictQuoteScope(printable, {
    productAttached: true,
    productTitle: product.title || null
  });
  if (!scoped) return false;
  return !!applyQuoteColourway(scoped, {
    productAttached: true,
    productTitle: product.title || null
  });
}

function selectVideoTemplate({ product = null } = {}) {
  if (hasUsableVideoRating(product) || hasUsableVideoQuote(product)) {
    return TEMPLATE_SOCIAL_PROOF;
  }
  return TEMPLATE_FLOOR;
}

module.exports = {
  selectVideoTemplate,
  hasUsableVideoRating,
  hasUsableVideoQuote,
  atomicProductPair,
  TEMPLATE_SOCIAL_PROOF,
  TEMPLATE_FLOOR,
  MIN_STORE_REVIEW_COUNT,
};
