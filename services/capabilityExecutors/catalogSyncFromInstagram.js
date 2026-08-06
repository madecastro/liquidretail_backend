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

  const [creds, existing] = await Promise.all([
    IntegrationCredential.find({
      brandId: brand._id,
      type: 'instagram',
      status: 'active',
      catalogId: { $exists: true, $ne: null }
    }).select('_id igUsername catalogId lastCatalogSyncAt').lean(),
    CatalogProduct.countDocuments({ brandId: brand._id, source: 'ig-catalog' })
  ]);

  if (!creds.length) {
    return { ok: false, error: 'no active Instagram credential with a catalogId for this brand — connect Instagram first via integrations.instagram.connectUrl' };
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
