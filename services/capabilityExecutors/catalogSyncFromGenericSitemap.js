// Executor for capability catalog.syncFromGenericSitemap (Tier 4, brand scope).
//
// Two-phase workflow — pull a brand's catalog via the generic XML
// sitemap + schema.org JSON-LD path (genericCatalogIngestService).
// Fallback for non-Shopify server-rendered stores where the Shopify
// products.json path returns nothing. Reachable only for demo brands
// today via catalog.pullFromApify with method='generic-sitemap'; this
// capability exposes it standalone for any brand with a websiteUrl.
//
// Preview is discover-only: walk sitemaps, derive category options from
// URL path segments, return WITHOUT scanning a single PDP so the operator
// can pick categories before spending wall-clock. Execute accepts an
// optional `categories` arg and passes it through to the ingest filter.
//
// GENERIC_CATALOG_ENABLED must be true (default). GENERIC_CATALOG_LIMIT
// caps the per-run product count (default 200).

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const { resolveStoreOrigin } = require('../shopifyAccessResolver');

async function resolveScope({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  // `apifyDemo.shopifyUrl`, NOT a bare `shopifyUrl` — there is no top-level
  // shopifyUrl on brandSchema (models/Brand.js declares it only inside
  // apifyDemo). This projection is load-bearing twice over: resolveStoreOrigin
  // leads with brand.apifyDemo?.shopifyUrl, and THIS doc is what gets handed to
  // syncBrandGenericCatalog — so a missing path here silently starves the
  // service too, and it resolves the store from websiteUrl instead. See the
  // .select() trap in CLAUDE.md §4: Mongoose neither throws nor warns.
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name websiteUrl apifyDemo.shopifyUrl');
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };
  return { ok: true, brand };
}

/** Normalise operator-supplied category keys to a clean string array. */
function normalizeCategories(raw) {
  if (!Array.isArray(raw)) return undefined;
  const keys = raw.map(k => String(k || '').trim()).filter(Boolean);
  return keys.length ? keys : undefined;
}

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  // The SHARED resolver, not a local cascade. syncBrandGenericCatalog resolves
  // the origin with resolveStoreOrigin(brand), so anything else here can show
  // the operator one store in the preview and then scrape a different one.
  const origin = resolveStoreOrigin(brand);
  if (!origin) {
    return { ok: false, error: 'brand has no catalog URL configured (apifyDemo.shopifyUrl or websiteUrl) — set one via brand.patch first' };
  }
  if (process.env.GENERIC_CATALOG_ENABLED === 'false') {
    return { ok: false, error: 'generic-sitemap method disabled on this deployment (GENERIC_CATALOG_ENABLED=false)' };
  }

  const existing = await CatalogProduct.countDocuments({ brandId: brand._id, source: 'sitemap-jsonld' });
  const cap = Math.max(1, parseInt(process.env.GENERIC_CATALOG_LIMIT, 10) || 200);

  // Discover-only: walk sitemaps + derive category options, zero PDP fetches.
  // Failure is non-fatal for the plan shape — we still return the static plan
  // fields so the operator can proceed without category narrowing.
  let categoryOptions = null;
  let totalCandidates = null;
  let discoverReason = null;
  if (process.env.GENERIC_CATALOG_CATEGORY_OPTIONS !== 'false') {
    try {
      const { resolveGenericCatalog } = require('../genericCatalogResolver');
      const disc = await resolveGenericCatalog(brand, {
        discoverOnly: true,
        abortCheck: async () => false
      });
      if (disc && disc.ok) {
        categoryOptions = Array.isArray(disc.categoryOptions) ? disc.categoryOptions : [];
        totalCandidates = disc.totalCandidates != null ? disc.totalCandidates : null;
      } else {
        discoverReason = disc?.reason || 'discover-only walk returned no candidates';
      }
    } catch (err) {
      discoverReason = `discover-only walk failed: ${err.message}`;
    }
  }

  const data = {
    workflowId: 'catalog.syncFromGenericSitemap',
    brand: { _id: String(brand._id), name: brand.name, origin },
    existingProductCount: existing,
    productCap:           cap,
    summary: `Pull the public catalog from ${origin} via XML sitemap + schema.org JSON-LD (up to ${cap} products). Fallback path when Shopify products.json returns nothing (non-Shopify stores).`,
    estimateUsd:    0,
    estimateWallMs: Math.min(cap, 200) * 1500,
    reversible:     false,
    note: 'HTTP-only. Downstream detect + enrichment enqueue is fire-and-forget inside the service.'
  };
  if (totalCandidates != null) data.totalCandidates = totalCandidates;
  if (categoryOptions) {
    data.categoryOptions = categoryOptions;
    data.categoryOptionCount = categoryOptions.length;
    if (categoryOptions.length) {
      data.note =
        `Sitemap walk found ${totalCandidates ?? '?'} candidate URLs and ` +
        `${categoryOptions.length} category option(s). Pass categories:[…] on execute ` +
        `to limit the import (no PDP fetches until execute).`;
    }
  }
  if (discoverReason) data.discoverNote = discoverReason;

  return {
    ok: true,
    kind: 'plan',
    data
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

  const categories = normalizeCategories(args?.categories);

  const { syncBrandGenericCatalog } = require('../genericCatalogIngestService');
  let result;
  try {
    result = await syncBrandGenericCatalog(brand, stubRun, {
      isBrandAborted: () => false,
      categories
    });
  } catch (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `generic-sitemap sync failed: ${err.message}`,
      data: { workflowId: 'catalog.syncFromGenericSitemap', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  const data = {
    workflowId: 'catalog.syncFromGenericSitemap',
    brand: { _id: String(brand._id), name: brand.name },
    productsUpserted: result?.productsUpserted || 0,
    videosIngested:   result?.videosIngested   || 0,
    reviewsCaptured:  result?.reviewsCaptured  || 0,
    errors:           result?.errors           || [],
    reason:           result?.reason           || null,
    durationMs:       Date.now() - started,
    note: 'Sitemap-JSONLD upsert complete. Downstream detect + enrichment runs in the worker over the next few minutes.'
  };
  if (categories) data.categories = categories;
  if (Array.isArray(result?.categoryOptions) && result.categoryOptions.length) {
    data.categoryOptions = result.categoryOptions;
  }
  if (result?.categoryPromptSuggested) {
    data.categoryPromptSuggested = true;
  }

  return {
    ok: (result?.ok !== false),
    kind: 'workflowResult',
    data
  };
}

module.exports = { preview, execute };
