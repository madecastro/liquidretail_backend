// Single-product on-site review refresh — the unit the Tier 4
// catalog.refreshReviewsForBrand workflow fans out over.
//
// Wraps the existing 3-tier productReviewsScrapeService:
//   1. JSON-LD (free HTTP GET of the product page)
//   2. Vendor public API (9 adapters: yotpo/judgeme/bazaarvoice/etc.)
//   3. Headless browser (opt-in via REVIEW_HEADLESS_ENABLED)
//
// Per-review star ratings ARE captured by that engine (see the header
// comment on productReviewsScrapeService.js) — the whole reason this
// workflow exists is to move products off the gemini-search fallback
// path (which drops ratings) onto the scraper (which keeps them).
//
// Cache invalidation: refreshing a product's reviews shifts the
// downstream social_proof signals the LayoutInputArtifact reads. This
// service does NOT force invalidation of existing artifacts — a
// separate follow-up will wire cascade invalidation. For now, the
// tool_result note tells the operator to regenerate ads to see the
// fresh signals.

'use strict';

const CatalogProduct = require('../models/CatalogProduct');
const reviews = require('./productReviewsScrapeService');

const REVIEW_HEADLESS_ENABLED = () =>
  String(process.env.REVIEW_HEADLESS_ENABLED || '').toLowerCase() === 'true';

/**
 * Refresh reviews for one CatalogProduct. Non-throwing — every failure
 * mode surfaces as a structured result the workflow can aggregate.
 *
 * @param {object} opts
 * @param {string|ObjectId} opts.productId  — CatalogProduct._id
 * @param {boolean} [opts.allowHeadless]    — override REVIEW_HEADLESS_ENABLED for this call
 * @returns { ok, tiers, quotesCount, quotesWithStars, ratingValue,
 *            reviewCount, platform, error?, reason? }
 */
async function refreshOne({ productId, allowHeadless = null }) {
  const product = await CatalogProduct.findById(productId)
    .select('_id title productUrl canonicalUrl brandId productReviews').lean();
  if (!product) {
    return { ok: false, productId: String(productId), reason: 'not-found', error: `product ${productId} not found` };
  }

  // The scraper needs a canonical URL to hit. Products ingested via
  // Meta-catalog or CSV often lack this; call it out explicitly rather
  // than silently falling through to the gemini-search fallback.
  const url = product.productUrl || product.canonicalUrl;
  if (!url) {
    return {
      ok: false,
      productId: String(product._id),
      productName: product.title,
      reason: 'no-canonical-url',
      error: 'CatalogProduct has no productUrl/canonicalUrl — cannot scrape'
    };
  }

  const useHeadless = allowHeadless == null ? REVIEW_HEADLESS_ENABLED() : !!allowHeadless;

  let result;
  try {
    result = await reviews.fetchProductReviews(url, { allowHeadless: useHeadless });
  } catch (err) {
    return {
      ok: false,
      productId: String(product._id),
      productName: product.title,
      reason: 'scraper-error',
      error: err.message || String(err)
    };
  }

  if (!result || (!result.rating && !(result.quotes || []).length)) {
    return {
      ok: false,
      productId: String(product._id),
      productName: product.title,
      reason: 'no-data',
      error: `tier chain returned nothing (tiers tried: ${(result?.tiers || []).join(',') || 'none'})`
    };
  }

  // Persist. Overwrites productReviews with the fresh scraper payload
  // AND stamps source='productReviewsScrape' so downstream code can
  // distinguish tier-scraped from gemini-search rows.
  const quotes = Array.isArray(result.quotes) ? result.quotes : [];
  const quotesWithStars = quotes.filter((q) => typeof q.rating === 'number').length;
  const now = new Date();
  await CatalogProduct.updateOne({ _id: product._id }, {
    $set: {
      productReviews: {
        source:            'productReviewsScrape',
        rating:            result.rating ?? null,
        reviewCount:       result.reviewCount ?? null,
        quotes,
        ratingDistribution: result.ratingDistribution || [],
        reviewsFetched:    result.reviewsFetched ?? quotes.length,
        tiers:             result.tiers || [],
        platform:          result.platform || null,
        summary:           product.productReviews?.summary || null,   // keep existing summary if any
        fetchedAt:         now
      },
      // Mirror to top-level rating for the small number of consumers
      // that read product.rating directly (kept in sync with the
      // productReviews.rating we just wrote).
      rating: result.rating ?? null,
      updatedAt: now
    }
  });

  return {
    ok: true,
    productId:  String(product._id),
    productName: product.title,
    tiers:      result.tiers || [],
    platform:   result.platform || null,
    ratingValue: result.rating ?? null,
    reviewCount: result.reviewCount ?? null,
    quotesCount: quotes.length,
    quotesWithStars,
    quotesWithoutStars: quotes.length - quotesWithStars
  };
}

module.exports = { refreshOne };
