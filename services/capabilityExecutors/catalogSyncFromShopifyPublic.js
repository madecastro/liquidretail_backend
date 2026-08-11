// Executor for capability catalog.syncFromShopifyPublic (Tier 4, brand scope).
//
// Two-phase workflow that runs shopifyPublicIngestService.syncBrandShopifyDirect
// — the public-storefront path (products.json → Storefront GraphQL →
// sitemap fallback, cf. shopifyAccessResolver). Needs a store origin, which
// resolveStoreOrigin derives from `Brand.apifyDemo.shopifyUrl` falling back to
// `Brand.websiteUrl`. (This header used to say "Requires Brand.shopifyUrl" —
// there is no such top-level field; it lives under apifyDemo.)
//
// Heavy sync: the SSE stream stays open for the whole run
// (potentially minutes at high catalog sizes). MAX_STEPS is capped
// server-side by SHOPIFY_DIRECT_LIMIT. Downstream detect + enrichment
// enqueue is fire-and-forget inside the service; only the products.json
// pull + upsert is inline.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const { syncBrandShopifyDirect } = require('../shopifyPublicIngestService');
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
  // syncBrandShopifyDirect — so a missing path here silently starves the service
  // too, and it resolves the store from websiteUrl instead. See the .select()
  // trap in CLAUDE.md §4: Mongoose neither throws nor warns.
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name websiteUrl apifyDemo.shopifyUrl');
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };
  return { ok: true, brand };
}

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  // The SHARED resolver, not a local cascade. syncBrandShopifyDirect resolves the
  // origin with resolveStoreOrigin(brand), so anything else here can show the
  // operator one store in the preview and then scrape a different one.
  const store = resolveStoreOrigin(brand);
  if (!store) {
    return { ok: false, error: 'brand has no store origin configured (apifyDemo.shopifyUrl or websiteUrl) — nothing to sync from' };
  }

  const existing = await CatalogProduct.countDocuments({ brandId: brand._id });
  const cap = Math.max(1, parseInt(process.env.SHOPIFY_DIRECT_LIMIT, 10) || 200);

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.syncFromShopifyPublic',
      brand: { _id: String(brand._id), name: brand.name, store },
      summary: `Pull the public catalog from ${store} (up to ${cap} products). Upserts CatalogProduct rows by (brandId, externalId). Downstream detect + enrichment enqueue is fire-and-forget from the service.`,
      existingProductCount: existing,
      productCap:           cap,
      estimateUsd:          0,
      estimateWallMs:       Math.min(cap, 200) * 1000,  // ~1s/product typical
      reversible:           false,
      note: 'Wall time is capped by SHOPIFY_DIRECT_LIMIT + the store\'s server speed. The SSE stream stays open for the whole run.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();

  // shopifyPublicIngestService expects a `run` object with .stage(msg).
  // The Mongo-backed progressService.startRun is heavy for a one-off
  // agent workflow; build a minimal stub that forwards stage messages
  // to onProgress instead.
  let stageCounter = 0;
  const stubRun = {
    stage(msg) {
      stageCounter++;
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            step:       stageCounter,
            totalSteps: null,   // unknown until the sync finishes
            stage:      String(msg || 'stage'),
            outcome:    'running'
          });
        } catch (_) { /* ignore */ }
      }
    }
  };

  let result;
  try {
    result = await syncBrandShopifyDirect(brand, stubRun, { isBrandAborted: () => false });
  } catch (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `shopify sync failed: ${err.message}`,
      data: {
        workflowId: 'catalog.syncFromShopifyPublic',
        brand: { _id: String(brand._id), name: brand.name },
        durationMs: Date.now() - started
      }
    };
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'catalog.syncFromShopifyPublic',
      brand: { _id: String(brand._id), name: brand.name },
      productsUpserted: result?.productsUpserted || 0,
      videosIngested:   result?.videosIngested   || 0,
      reviewsCaptured:  result?.reviewsCaptured  || 0,
      errors:           result?.errors           || [],
      reason:           result?.reason           || null,
      durationMs:       Date.now() - started,
      note: 'Downstream detect + enrichment enqueue runs in the worker asynchronously; expect crop artifacts + product matches over the next few minutes.'
    }
  };
}

module.exports = { preview, execute };
