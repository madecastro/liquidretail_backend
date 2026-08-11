// Executor for capability catalog.refreshReviewsForProduct (Tier 2, product scope).
//
// Single-product analog of catalog.refreshReviewsForBrand. Wraps
// catalogProductReviewRefreshService.refreshOne — 3-tier scraper
// (JSON-LD → vendor API → optional headless). HTTP-only, no LLM
// cost. Kept Tier 2 so a runaway agent can't loop refresh-one 500x
// on the same product; spendGuard enforces $0 with the daily-cap
// clock as the effective rate limiter.

'use strict';

const mongoose = require('mongoose');
const CatalogProduct = require('../../models/CatalogProduct');
const { refreshOne } = require('../catalogProductReviewRefreshService');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawProductId = args?.productId;
  if (!rawProductId) return { ok: false, error: 'productId required' };
  if (!mongoose.isValidObjectId(rawProductId)) {
    return { ok: false, error: `productId "${rawProductId}" is not a valid ObjectId` };
  }
  const allowHeadless = typeof args?.allowHeadless === 'boolean' ? args.allowHeadless : null;

  const product = await CatalogProduct.findOne({ _id: rawProductId, advertiserId: req.advertiserId })
    .select('_id brandId title productUrl').lean();
  if (!product) return { ok: false, error: `product ${rawProductId} not found` };
  if (!product.productUrl) {
    return { ok: false, error: 'product has no productUrl — cannot scrape reviews without a page to hit' };
  }

  const result = await refreshOne({ productId: product._id, allowHeadless });

  return {
    ok: result?.ok !== false,
    kind: 'reviewsRefresh',
    data: {
      productId:   String(product._id),
      brandId:     product.brandId ? String(product.brandId) : null,
      title:       product.title,
      productUrl:  product.productUrl,
      quotesCount: result?.quotesCount ?? 0,
      quotesWithStars: result?.quotesWithStars ?? 0,
      ratingValue: result?.ratingValue ?? null,
      reviewCount: result?.reviewCount ?? null,
      tiers:       result?.tiers || [],
      platform:    result?.platform || null,
      reason:      result?.reason || null,
      note: result?.ok
        ? 'Reviews upserted; LayoutInputArtifact + CreativeDirectionArtifact cache keys were invalidated by the refresh service. Regenerate affected ads to pick up the new signal.'
        : 'Refresh returned no reviews — check the tiers array for which layers were tried.'
    }
  };
}

module.exports = { run };
