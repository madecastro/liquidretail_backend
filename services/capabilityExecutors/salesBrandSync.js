// Executor for capability sales.brand.sync (Tier 4, global scope).
//
// Two-phase workflow that runs apifyIngestService.syncBrandApify for
// a demo brand — same service Phase 4's catalog.pullFromApify wraps,
// but scoped to callers who are IN the Sales Demos advertiser bucket
// (via _salesDemosCommon.requireSalesDemosScope). The route it mirrors
// (POST /api/sales-demos/brands/:id/sync) fires-and-forgets; here we
// await so the workflowResult carries real outcome counts.

'use strict';

const { findDemoBrand } = require('./_salesDemosCommon');
const { syncBrandApify } = require('../apifyIngestService');

const ESTIMATE_USD = 1.00;

async function preview({ req, args }) {
  const found = await findDemoBrand({ req, args });
  if (!found.ok) return found;
  const { brand } = found;
  const cfg = brand.apifyDemo || {};
  if (!cfg.igHandle && !cfg.shopifyUrl) {
    return { ok: false, error: 'brand.apifyDemo has neither igHandle nor shopifyUrl configured — patch first via sales.brand.patch' };
  }

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'sales.brand.sync',
      brand: { _id: String(brand._id), name: brand.name },
      apifyDemo: {
        igHandle:   cfg.igHandle   || null,
        shopifyUrl: cfg.shopifyUrl || null,
        method:     cfg.method     || 'shopify-direct',
        aborted:    !!cfg.aborted
      },
      summary: `Pull demo data for ${brand.name}: ${cfg.igHandle ? `IG @${cfg.igHandle}` : ''}${cfg.igHandle && cfg.shopifyUrl ? ' + ' : ''}${cfg.shopifyUrl ? `Shopify ${cfg.shopifyUrl}` : ''}. Method: ${cfg.method || 'shopify-direct'}.`,
      estimateUsd:    ESTIMATE_USD,
      estimateWallMs: 3 * 60 * 1000,
      reversible:     false,
      note: 'Same underlying service as catalog.pullFromApify. Cancel mid-flight via sales.brand.abort.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const found = await findDemoBrand({ req, args });
  if (!found.ok) return found;
  const { brand } = found;
  const started = Date.now();

  // Clear stale abort flag so a prior aborted run doesn't short-circuit.
  if (brand.apifyDemo?.aborted) {
    brand.apifyDemo.aborted = false;
    brand.markModified('apifyDemo');
    await brand.save();
  }

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
      data: { workflowId: 'sales.brand.sync', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'sales.brand.sync',
      brand: { _id: String(brand._id), name: brand.name },
      ig:         result?.ig      || null,
      shopify:    result?.shopify || null,
      method:     result?.method  || null,
      durationMs: Date.now() - started,
      note: 'Downstream detect enqueue is fire-and-forget inside the service; DetectRuns materialize in the worker over the next few minutes.'
    }
  };
}

module.exports = { preview, execute };
