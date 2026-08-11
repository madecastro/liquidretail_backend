// Executor for capability catalog.pullFromApify (Tier 4, brand scope).
//
// Two-phase workflow that runs apifyIngestService.syncBrandApify — the
// demo-brand data pull (IG posts + Shopify catalog via Apify actors).
// Actor selection is server-controlled via Brand.apifyDemo.method
// (shopify-direct | apify | generic-sitemap); the agent cannot pick
// arbitrary Apify actors.
//
// Gated on Brand.isDemo=true. Attempting to run against a real (non-
// demo) brand fails fast at preview and execute — matches the service's
// own guard. Cost is real (~$0.20 IG + ~$0.15 Shopify + downstream
// enrichment); estimateUsd reserves against the advertiser cap.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const { syncBrandApify } = require('../apifyIngestService');

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
    .select('_id name isDemo apifyDemo');
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };
  if (!brand.isDemo) {
    return { ok: false, error: `brand ${rawBrandId} is not a demo brand — catalog.pullFromApify is scoped to Sales-Demos advertiser bucket only` };
  }
  return { ok: true, brand };
}

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  const cfg = brand.apifyDemo || {};
  if (!cfg.igHandle && !cfg.shopifyUrl) {
    return { ok: false, error: 'brand.apifyDemo has neither igHandle nor shopifyUrl configured — nothing to pull' };
  }

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.pullFromApify',
      brand: { _id: String(brand._id), name: brand.name },
      apifyDemo: {
        igHandle:   cfg.igHandle   || null,
        shopifyUrl: cfg.shopifyUrl || null,
        method:     cfg.method     || 'shopify-direct'
      },
      summary: `Run the demo-brand pull for ${brand.name}: ${cfg.igHandle ? `IG @${cfg.igHandle}` : ''}${cfg.igHandle && cfg.shopifyUrl ? ' + ' : ''}${cfg.shopifyUrl ? `Shopify ${cfg.shopifyUrl}` : ''}. Actor selection controlled server-side by apifyDemo.method.`,
      estimateUsd:    1.00,
      estimateWallMs: 3 * 60 * 1000,   // Apify sync-run cap is 5min; IG+Shopify usually ~1-3 min combined
      reversible:     false,
      note: 'Heavy sync. Creates Media (source=apify-ig) + CatalogProduct (source=apify-shopify) rows and enqueues downstream detect. SSE stream stays open until completion.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();

  // Emit a single leading progress tick so the client sees the workflow
  // is doing something. The service itself uses its Mongo progress
  // ledger, not a callback, so per-item onProgress isn't reachable
  // without a bigger refactor of apifyIngestService.
  if (typeof onProgress === 'function') {
    try { onProgress({ step: 1, totalSteps: null, stage: 'starting apify sync', outcome: 'running' }); }
    catch (_) { /* ignore */ }
  }

  let result;
  try {
    result = await syncBrandApify(brand._id);
  } catch (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `apify sync failed: ${err.message}`,
      data: {
        workflowId: 'catalog.pullFromApify',
        brand: { _id: String(brand._id), name: brand.name },
        durationMs: Date.now() - started
      }
    };
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'catalog.pullFromApify',
      brand: { _id: String(brand._id), name: brand.name },
      ig:          result?.ig          || null,
      shopify:     result?.shopify     || null,
      method:      result?.method      || null,
      durationMs:  Date.now() - started,
      note: 'Downstream detect enqueue is fire-and-forget inside the service; expect DetectRuns + product matches to appear over the next several minutes.'
    }
  };
}

module.exports = { preview, execute };
