// Executor for capability sales.brand.enrich (Tier 4, global scope).
//
// Two-phase workflow — full-catalog enrichment via
// catalogProductEnrichmentService.enrichBrandDetails (SerpAPI + Gemini).
// This is the paid path: cross-seller price table + web-wide review
// synthesis + Immersive specs per product. Mirrors POST
// /api/sales-demos/brands/:id/enrich but awaits completion so the
// workflowResult reports real outcomes.
//
// Atomic claim: same enrichInFlight flag the route uses — a concurrent
// call fails at preview() with a clear error, keeping paid SerpAPI /
// Gemini spend from doubling on the same brand.

'use strict';

const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const { findDemoBrand } = require('./_salesDemosCommon');
const { enrichBrandDetails } = require('../catalogProductEnrichmentService');

// Cost is dominated by per-product SerpAPI hits. A 100-product brand
// costs roughly $5-10. Reserve $10 as a bounded upper.
const ESTIMATE_USD = 10.00;

async function preview({ req, args }) {
  const found = await findDemoBrand({ req, args });
  if (!found.ok) return found;
  const { brand } = found;

  if (brand.apifyDemo?.enrichInFlight === true) {
    return {
      ok: false,
      error: 'enrichment already running for this brand',
      code:  'ENRICH_IN_FLIGHT'
    };
  }
  const productCount = await CatalogProduct.countDocuments({ brandId: brand._id });

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'sales.brand.enrich',
      brand: { _id: String(brand._id), name: brand.name },
      productCount,
      summary: `Full-catalog enrichment for ${brand.name} (${productCount} products): cross-seller price table + web-wide review synthesis + Immersive specs.`,
      estimateUsd:    ESTIMATE_USD,
      estimateWallMs: 8 * 60 * 1000,
      reversible:     false,
      note: 'Paid path (SerpAPI + Gemini). Protected by apifyDemo.enrichInFlight — a concurrent call fails with 409-style error rather than double-billing.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const found = await findDemoBrand({ req, args, select: '_id name advertiserId apifyDemo' });
  if (!found.ok) return found;
  const { brand } = found;
  const started = Date.now();

  // Atomic claim — same as the route.
  const claimed = await Brand.findOneAndUpdate(
    { _id: brand._id, 'apifyDemo.enrichInFlight': { $ne: true } },
    { $set: { 'apifyDemo.enrichInFlight': true } },
    { new: true }
  ).select('_id');
  if (!claimed) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: 'enrichment already running for this brand',
      data: { workflowId: 'sales.brand.enrich', brand: { _id: String(brand._id), name: brand.name } }
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
    await Brand.updateOne({ _id: brand._id }, { $set: { 'apifyDemo.enrichInFlight': false } })
      .catch((clearErr) => console.warn(`sales.brand.enrich: clear enrichInFlight failed: ${clearErr.message}`));
  }

  if (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `enrichment failed: ${err.message}`,
      data: { workflowId: 'sales.brand.enrich', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'sales.brand.enrich',
      brand: { _id: String(brand._id), name: brand.name },
      result: result || null,
      durationMs: Date.now() - started,
      note: 'Enrichment complete. Re-fetch the catalog page to see updated price tables + review summaries + specs.'
    }
  };
}

module.exports = { preview, execute };
