// Executor for capability sales.brand.syncReviews (Tier 4, global scope).
//
// Two-phase workflow that runs productReviewsScrapeService.syncBrand-
// ProductReviews across a demo brand's catalog: schema.org rich
// snippets → vendor-widget public API → optional headless. FREE (HTTP
// only) unless useHeadless=true; headless is off by default because
// it costs a browser per product (~10-25s each).
//
// Mirrors POST /api/sales-demos/brands/:id/sync-reviews.

'use strict';

const CatalogProduct = require('../../models/CatalogProduct');
const { findDemoBrand } = require('./_salesDemosCommon');
const { syncBrandProductReviews } = require('../productReviewsScrapeService');

// HTTP tiers are free. Reserve $0 to reflect that — spendGuard still
// applies as a rate-limiter.
const ESTIMATE_USD = 0;

async function preview({ req, args }) {
  const found = await findDemoBrand({ req, args, select: '_id name advertiserId' });
  if (!found.ok) return found;
  const { brand } = found;

  const productCount = await CatalogProduct.countDocuments({
    brandId: brand._id,
    productUrl: { $ne: null, $exists: true, $ne: '' }
  });

  const force        = !!args?.force;
  const useHeadless  = args?.useHeadless === true;  // strict: routes/agent.js JSON.parses args with no schema coercion, so the STRING "false" is truthy

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'sales.brand.syncReviews',
      brand: { _id: String(brand._id), name: brand.name },
      productCount,
      force,
      useHeadless,
      summary: `Re-scrape reviews for ${brand.name} — up to ${productCount} products with productUrl.${force ? ' Ignoring 30-day TTL.' : ''}${useHeadless ? ' Tier 3 headless ENABLED (~10-25s per product).' : ''}`,
      estimateUsd:    ESTIMATE_USD,
      estimateWallMs: useHeadless ? productCount * 15_000 : productCount * 3_000,
      reversible:     false,
      note: 'HTTP tiers are free; headless per-product is not (opt-in via useHeadless=true).'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const found = await findDemoBrand({ req, args, select: '_id name advertiserId' });
  if (!found.ok) return found;
  const { brand } = found;
  const started = Date.now();

  const force        = !!args?.force;
  const useHeadless  = args?.useHeadless === true;  // strict: routes/agent.js JSON.parses args with no schema coercion, so the STRING "false" is truthy
  const pages        = Number(args?.pages);

  if (typeof onProgress === 'function') {
    try { onProgress({ step: 1, totalSteps: null, stage: 'starting reviews sync', outcome: 'running' }); }
    catch (_) { /* ignore */ }
  }

  let result;
  try {
    result = await syncBrandProductReviews(String(brand._id), {
      force,
      useHeadless,
      advertiserId: brand.advertiserId,
      ...(Number.isFinite(pages) && pages > 0 ? { adapterMaxPages: pages } : {})
    });
  } catch (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `reviews sync failed: ${err.message}`,
      data: { workflowId: 'sales.brand.syncReviews', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'sales.brand.syncReviews',
      brand: { _id: String(brand._id), name: brand.name },
      result: result || null,
      force,
      useHeadless,
      durationMs: Date.now() - started,
      note: 'Product review data refreshed. LayoutInputArtifact + CreativeDirectionArtifact cache keys may still carry the OLD signal until regenerate.'
    }
  };
}

module.exports = { preview, execute };
