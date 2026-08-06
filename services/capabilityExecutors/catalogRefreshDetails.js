// Executor for capability catalog.refreshDetails (Tier 4, brand scope).
//
// General-brand version of sales.brand.enrich — full-catalog enrichment
// via catalogProductEnrichmentService.enrichBrandDetails (SerpAPI
// cross-seller price table + Gemini web-wide review synthesis +
// Immersive specs per product). Previously locked behind the Sales
// Demos scope; this cap exposes the same service to any brand under
// the caller's advertiser.
//
// Atomic claim: reuses Brand.apifyDemo.enrichInFlight (declared on
// the schema regardless of isDemo) to prevent double-billing when
// two concurrent runs are dispatched. Same lock sales.brand.enrich
// uses, so the two capabilities won't run simultaneously on the same
// brand either.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const { enrichBrandDetails } = require('../catalogProductEnrichmentService');

// Same $10 upper bound as sales.brand.enrich — cost scales with
// product count at ~$0.05-0.10 each; $10 covers a ~100-product
// brand comfortably. Higher-catalog brands hit the executor-side
// batch cap inside enrichBrandDetails.
const ESTIMATE_USD = 10.00;

async function resolveScope({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name apifyDemo');
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };
  return { ok: true, brand };
}

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  if (brand.apifyDemo?.enrichInFlight === true) {
    return {
      ok: false,
      error: 'enrichment already running for this brand (Brand.apifyDemo.enrichInFlight=true) — retry once the current run finishes',
      code:  'ENRICH_IN_FLIGHT'
    };
  }

  const productCount = await CatalogProduct.countDocuments({
    advertiserId: req.advertiserId,
    brandId: brand._id
  });

  if (productCount === 0) {
    return {
      ok: false,
      error: 'brand has 0 CatalogProduct rows — nothing to enrich. Sync a catalog first (catalog.syncFromShopifyPublic, catalog.syncFromInstagram, catalog.pullFromApify, catalog.syncFromGenericSitemap, or catalog.createProduct).'
    };
  }

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.refreshDetails',
      brand: { _id: String(brand._id), name: brand.name },
      productCount,
      summary: `Full-catalog enrichment for ${brand.name} (${productCount} products): cross-seller price table (SerpAPI) + web-wide review synthesis (Gemini) + Immersive specs per product. Paid path — same service sales.brand.enrich uses; this exposes it for any brand.`,
      estimateUsd:    ESTIMATE_USD,
      estimateWallMs: 8 * 60 * 1000,
      reversible:     false,
      note: 'Protected by Brand.apifyDemo.enrichInFlight — a concurrent run fails at preview() rather than double-billing. Same lock sales.brand.enrich uses.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();

  // Atomic claim — same shape sales.brand.enrich uses. Brand.apifyDemo
  // is declared on the schema regardless of Brand.isDemo, so the lock
  // works for any brand.
  const claimed = await Brand.findOneAndUpdate(
    {
      _id: brand._id,
      advertiserId: req.advertiserId,
      'apifyDemo.enrichInFlight': { $ne: true }
    },
    { $set: { 'apifyDemo.enrichInFlight': true } },
    { new: true }
  ).select('_id');
  if (!claimed) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: 'enrichment already running for this brand — Brand.apifyDemo.enrichInFlight lock is held',
      data: { workflowId: 'catalog.refreshDetails', brand: { _id: String(brand._id), name: brand.name } }
    };
  }

  if (typeof onProgress === 'function') {
    try { onProgress({ step: 1, totalSteps: null, stage: 'starting enrichment', outcome: 'running' }); }
    catch (_) { /* ignore */ }
  }

  let result;
  let err;
  try {
    result = await enrichBrandDetails(String(brand._id));
  } catch (e) {
    err = e;
  } finally {
    // Always release the lock — even on throw. Fire-and-forget the
    // release itself so a Mongo blip doesn't propagate the error
    // back up over the workflow result.
    Brand.updateOne({ _id: brand._id }, { $set: { 'apifyDemo.enrichInFlight': false } })
      .catch((clearErr) => console.warn(`catalog.refreshDetails: clear enrichInFlight failed for brand=${brand._id}: ${clearErr.message}`));
  }

  if (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `enrichment failed: ${err.message}`,
      data: { workflowId: 'catalog.refreshDetails', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'catalog.refreshDetails',
      brand: { _id: String(brand._id), name: brand.name },
      result: result || null,
      durationMs: Date.now() - started,
      note: 'Enrichment complete. Price tables + review synthesis + specs are refreshed on each CatalogProduct row. Regenerate affected ads to pick up the new signal in Director briefs + layout inputs.'
    }
  };
}

module.exports = { preview, execute, ESTIMATE_USD };
