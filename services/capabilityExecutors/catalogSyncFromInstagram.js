// Executor for capability catalog.syncFromInstagram (Tier 4, brand scope).
//
// Two-phase workflow — pull a brand's Meta Catalog products via the
// Instagram Commerce OAuth path. Wraps catalogSyncService.syncCatalog,
// same service the /api/integrations/instagram/sync-catalog route
// invokes and same one onboarding.dispatchSyncs fans out. Standalone
// so an operator can trigger just the catalog leg without the whole
// dispatch bundle.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const IntegrationCredential = require('../../models/IntegrationCredential');
const { syncCatalog } = require('../catalogSyncService');

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
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };
  return { ok: true, brand };
}

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  const [creds, existing, sourceBreakdown] = await Promise.all([
    IntegrationCredential.find({
      brandId: brand._id,
      type: 'instagram',
      status: 'active',
      catalogId: { $exists: true, $ne: null }
    }).select('_id igUsername catalogId lastCatalogSyncAt').lean(),
    CatalogProduct.countDocuments({ brandId: brand._id, source: 'ig-catalog' }),
    // Same steer-the-LLM pattern posts.syncFromInstagram uses — when
    // the Meta Catalog OAuth path has no cred, the brand may still
    // have products from apify-shopify / shopify-direct / sitemap-
    // jsonld / manual-upload. Report the mix so the LLM can chain to
    // the right capability.
    CatalogProduct.aggregate([
      { $match: { brandId: new mongoose.Types.ObjectId(brand._id) } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ])
  ]);

  const sourceCounts = Object.fromEntries((sourceBreakdown || []).map((r) => [r._id, r.count]));

  if (!creds.length) {
    const alt = [];
    if (sourceCounts['apify-shopify']) {
      alt.push(`${sourceCounts['apify-shopify']} rows from source=apify-shopify (invoke catalog.pullFromApify or sales.brand.sync for more)`);
    }
    if (sourceCounts['shopify-direct']) {
      alt.push(`${sourceCounts['shopify-direct']} rows from source=shopify-direct (invoke catalog.syncFromShopifyPublic for more)`);
    }
    if (sourceCounts['sitemap-jsonld']) {
      alt.push(`${sourceCounts['sitemap-jsonld']} rows from source=sitemap-jsonld (invoke catalog.syncFromGenericSitemap for more)`);
    }
    if (sourceCounts['manual-upload']) {
      alt.push(`${sourceCounts['manual-upload']} rows from source=manual-upload (invoke catalog.createProduct for more)`);
    }
    if (sourceCounts['ig-catalog']) {
      alt.push(`${sourceCounts['ig-catalog']} rows from source=ig-catalog (the OAuth credential this workflow needs was disconnected — invoke integrations.instagram.connectUrl to reconnect)`);
    }
    const suffix = alt.length
      ? ` This brand DOES have products from other ingestion paths: ${alt.join('; ')}.`
      : ' This brand has no existing products from any ingestion path.';
    return {
      ok: false,
      error: `no active Instagram credential with a catalogId for this brand — catalog.syncFromInstagram uses the Meta Catalog OAuth path.${suffix} If the operator wants to re-pull via the SAME path that already has products, use the capability named above rather than this one. To connect a new OAuth credential, invoke integrations.instagram.connectUrl.`,
      sourceCounts
    };
  }

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.syncFromInstagram',
      brand: { _id: String(brand._id), name: brand.name },
      credentials: creds.map((c) => ({
        _id: String(c._id),
        igUsername: c.igUsername || null,
        catalogId: c.catalogId,
        lastCatalogSyncAt: c.lastCatalogSyncAt || null
      })),
      existingProductCount: existing,
      summary: `Pull the Meta Catalog for ${brand.name} across ${creds.length} active IG credential(s). Upserts CatalogProduct rows keyed by (brandId, externalId).`,
      estimateUsd:    0,
      estimateWallMs: 60_000,
      reversible:     false,
      note: 'HTTP-only (Meta Graph API). No LLM cost. Downstream detect + enrichment enqueue is fire-and-forget inside the service.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();

  if (typeof onProgress === 'function') {
    try { onProgress({ step: 1, totalSteps: null, stage: 'syncing meta catalog', outcome: 'running' }); }
    catch (_) { /* ignore */ }
  }

  let result;
  try {
    result = await syncCatalog(String(brand._id), {});
  } catch (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `catalog sync failed: ${err.message}`,
      data: { workflowId: 'catalog.syncFromInstagram', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  return {
    ok: (result?.ok !== false),
    kind: 'workflowResult',
    data: {
      workflowId: 'catalog.syncFromInstagram',
      brand: { _id: String(brand._id), name: brand.name },
      fetched:    result?.fetched    || 0,
      added:      result?.added      || 0,
      updated:    result?.updated    || 0,
      errors:     result?.errors     || 0,
      totalCount: result?.totalCount || 0,
      perCredential: result?.perCredential || null,
      reason:     result?.reason || null,
      durationMs: Date.now() - started,
      note: 'Meta Catalog upsert complete. Downstream detect + enrichment enqueue runs in the worker over the next few minutes.'
    }
  };
}

module.exports = { preview, execute };
