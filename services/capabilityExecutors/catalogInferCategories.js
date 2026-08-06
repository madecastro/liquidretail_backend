// Executor for capability catalog.inferCategories (Tier 2, product scope).
//
// Runs the JSON-LD → LLM category inference chain for one
// CatalogProduct (productCategoryInferenceService.inferAndStamp).
// Persists Category.breadcrumb + updates CatalogProduct.categoryRef,
// inferredBreadcrumb, inferredCategoryAt. Respects the 14-day TTL by
// default; pass force=true to re-scrape even if inferredCategoryAt is
// recent.
//
// Billable — ~$0.02/product on the LLM side when JSON-LD is absent
// and the model has to walk the page. spendGuard reserves the estimate
// against the advertiser's daily cap before dispatch.

'use strict';

const mongoose = require('mongoose');
const CatalogProduct = require('../../models/CatalogProduct');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawProductId = args?.productId;
  if (!rawProductId) return { ok: false, error: 'productId required' };
  if (!mongoose.isValidObjectId(rawProductId)) {
    return { ok: false, error: `productId "${rawProductId}" is not a valid ObjectId` };
  }
  const force = !!args?.force;

  const product = await CatalogProduct.findOne({ _id: rawProductId, advertiserId: req.advertiserId })
    .select('_id brandId title productUrl categoryRef inferredBreadcrumb inferredCategoryAt');
  if (!product) return { ok: false, error: `product ${rawProductId} not found` };
  if (!product.productUrl) {
    return { ok: false, error: 'product has no productUrl — cannot infer categories without a page to walk' };
  }

  const inference = require('../productCategoryInferenceService');
  const result = await inference.inferAndStamp(product._id, { force });

  return {
    ok: true,
    kind: 'categoryInference',
    data: {
      productId: String(product._id),
      brandId:   product.brandId ? String(product.brandId) : null,
      title:     product.title,
      outcome:   result?.ok
                   ? 'inferred'
                   : result?.challenged
                     ? 'challenged'
                     : 'skipped',
      breadcrumb: result?.breadcrumb || null,
      categoryRef: result?.categoryId ? String(result.categoryId) : null,
      reason: result?.reason || null,
      forced: force
    }
  };
}

module.exports = { run };
