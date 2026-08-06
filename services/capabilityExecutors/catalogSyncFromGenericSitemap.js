// Executor for capability catalog.syncFromGenericSitemap (Tier 4, brand scope).
//
// Two-phase workflow — pull a brand's catalog via the generic XML
// sitemap + schema.org JSON-LD path (genericCatalogIngestService).
// Fallback for non-Shopify server-rendered stores where the Shopify
// products.json path returns nothing. Reachable only for demo brands
// today via catalog.pullFromApify with method='generic-sitemap'; this
// capability exposes it standalone for any brand with a websiteUrl.
//
// GENERIC_CATALOG_ENABLED must be true (default). GENERIC_CATALOG_LIMIT
// caps the per-run product count (default 200).

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');

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
    .select('_id name websiteUrl shopifyUrl');
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };
  return { ok: true, brand };
}

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  const origin = brand.shopifyUrl || brand.websiteUrl;
  if (!origin) {
    return { ok: false, error: 'brand has neither shopifyUrl nor websiteUrl configured — set one via brand.patch first' };
  }
  if (process.env.GENERIC_CATALOG_ENABLED === 'false') {
    return { ok: false, error: 'generic-sitemap method disabled on this deployment (GENERIC_CATALOG_ENABLED=false)' };
  }

  const existing = await CatalogProduct.countDocuments({ brandId: brand._id, source: 'sitemap-jsonld' });
  const cap = Math.max(1, parseInt(process.env.GENERIC_CATALOG_LIMIT, 10) || 200);

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.syncFromGenericSitemap',
      brand: { _id: String(brand._id), name: brand.name, origin },
      existingProductCount: existing,
      productCap:           cap,
      summary: `Pull the public catalog from ${origin} via XML sitemap + schema.org JSON-LD (up to ${cap} products). Fallback path when Shopify products.json returns nothing (non-Shopify stores).`,
      estimateUsd:    0,
      estimateWallMs: Math.min(cap, 200) * 1500,
      reversible:     false,
      note: 'HTTP-only. Downstream detect + enrichment enqueue is fire-and-forget inside the service.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();

  if (process.env.GENERIC_CATALOG_ENABLED === 'false') {
    return {
      ok: false,
      kind: 'workflowResult',
      error: 'generic-sitemap method disabled on this deployment (GENERIC_CATALOG_ENABLED=false)',
      data: { workflowId: 'catalog.syncFromGenericSitemap', brand: { _id: String(brand._id), name: brand.name } }
    };
  }

  // Same stub-run shape catalog.syncFromShopifyPublic uses — forwards
  // stage messages to onProgress instead of the Mongo progress ledger.
  let stageCounter = 0;
  const stubRun = {
    stage(msg) {
      stageCounter++;
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            step:       stageCounter,
            totalSteps: null,
            stage:      String(msg || 'stage'),
            outcome:    'running'
          });
        } catch (_) { /* ignore */ }
      }
    }
  };

  const { syncBrandGenericCatalog } = require('../genericCatalogIngestService');
  let result;
  try {
    result = await syncBrandGenericCatalog(brand, stubRun, { isBrandAborted: () => false });
  } catch (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `generic-sitemap sync failed: ${err.message}`,
      data: { workflowId: 'catalog.syncFromGenericSitemap', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  return {
    ok: (result?.ok !== false),
    kind: 'workflowResult',
    data: {
      workflowId: 'catalog.syncFromGenericSitemap',
      brand: { _id: String(brand._id), name: brand.name },
      productsUpserted: result?.productsUpserted || 0,
      videosIngested:   result?.videosIngested   || 0,
      reviewsCaptured:  result?.reviewsCaptured  || 0,
      errors:           result?.errors           || [],
      reason:           result?.reason           || null,
      durationMs:       Date.now() - started,
      note: 'Sitemap-JSONLD upsert complete. Downstream detect + enrichment runs in the worker over the next few minutes.'
    }
  };
}

module.exports = { preview, execute };
