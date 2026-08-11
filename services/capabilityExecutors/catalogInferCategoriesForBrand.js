// Executor for capability catalog.inferCategoriesForBrand (Tier 4, brand scope).
//
// Bulk analog of catalog.inferCategories. Wraps productCategory-
// InferenceService.inferBatch across every product in the brand that
// has a productUrl. Preview reports the target count and the LLM-
// fallback upper-bound estimate. Runs inside the SSE stream — the
// service streams onProgress ticks so the drawer can render progress.
//
// COST SHAPE: inferAndStamp tries JSON-LD BreadcrumbList first (free),
// then falls back to Gemini page-walk (~$0.02) only when JSON-LD is
// missing. Real cost is usually a fraction of the reserve because
// most catalogs have well-formed BreadcrumbList markup, but the
// reserve upper-bounds the worst case (100% LLM fallback).

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');

const PER_UNIT_ESTIMATE_USD = 0.02;
const MAX_STEPS_PER_RUN = 100;

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
  const force = !!args?.force;

  const filter = {
    advertiserId: req.advertiserId,
    brandId: brand._id,
    productUrl: { $ne: null, $exists: true, $ne: '' }
  };
  if (!force) {
    // Respect the 14-day TTL — products with a recent inferredCategoryAt
    // skip. Match productCategoryInferenceService's own TTL check.
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    filter.$or = [
      { inferredCategoryAt: { $exists: false } },
      { inferredCategoryAt: null },
      { inferredCategoryAt: { $lt: cutoff } }
    ];
  }
  const eligible = await CatalogProduct.countDocuments(filter);

  if (eligible === 0) {
    return {
      ok: false,
      error: force
        ? 'brand has no products with a productUrl to walk'
        : 'no products need inference — all products with a productUrl were categorized within the last 14 days. Pass force=true to bypass the TTL.'
    };
  }

  const capped = Math.min(eligible, MAX_STEPS_PER_RUN);
  const estimateUsd = Math.round(capped * PER_UNIT_ESTIMATE_USD * 100) / 100;

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.inferCategoriesForBrand',
      brand: { _id: String(brand._id), name: brand.name },
      eligible,
      totalSteps:     capped,
      capped:         eligible > MAX_STEPS_PER_RUN,
      force,
      perUnitUsdUpperBound: PER_UNIT_ESTIMATE_USD,
      estimateUsd,
      estimateWallMs: capped * 3_000,
      reversible:     false,
      summary: `Infer JSON-LD BreadcrumbList → LLM-fallback categories for ${capped} product(s) under ${brand.name}${eligible > MAX_STEPS_PER_RUN ? ` (${eligible} eligible; capped at ${MAX_STEPS_PER_RUN})` : ''}. Reserve is worst-case; most catalogs hit the free JSON-LD path.`,
      note: 'Stamps CatalogProduct.categoryRef + inferredBreadcrumb + inferredCategoryAt. 14-day TTL respects prior inference unless force=true.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();
  const force = !!args?.force;

  const filter = {
    advertiserId: req.advertiserId,
    brandId: brand._id,
    productUrl: { $ne: null, $exists: true, $ne: '' }
  };
  if (!force) {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    filter.$or = [
      { inferredCategoryAt: { $exists: false } },
      { inferredCategoryAt: null },
      { inferredCategoryAt: { $lt: cutoff } }
    ];
  }

  const targets = await CatalogProduct.find(filter)
    .sort({ lastSyncedAt: -1, firstSeenAt: -1 })
    .limit(MAX_STEPS_PER_RUN)
    .select('_id').lean();

  if (!targets.length) {
    return {
      ok: true,
      kind: 'workflowResult',
      data: {
        workflowId: 'catalog.inferCategoriesForBrand',
        brand: { _id: String(brand._id), name: brand.name },
        totalSteps: 0,
        note: 'no eligible products at execute time — someone else may have run inference between preview and confirmation.'
      }
    };
  }

  const inference = require('../productCategoryInferenceService');
  const { concurrency } = require('../concurrency');

  const perStepProgress = (done, total) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress({ step: done, totalSteps: total, outcome: 'running' });
      } catch (_) { /* ignore */ }
    }
  };

  const result = await inference.inferBatch(
    targets.map((t) => t._id),
    {
      concurrency: concurrency.CATEGORY_INFERENCE_BATCH_CONCURRENCY,
      force,
      onProgress: perStepProgress
    }
  );

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'catalog.inferCategoriesForBrand',
      brand: { _id: String(brand._id), name: brand.name },
      totalSteps: result?.total || targets.length,
      succeeded:  result?.ok       || 0,
      challenged: result?.challenged || 0,
      skipped:    result?.skipped  || 0,
      failed:     result?.failed   || 0,
      cancelled:  !!result?.cancelled,
      durationMs: Date.now() - started,
      note: `${result?.ok || 0} products got a fresh categoryRef. ${result?.challenged || 0} needed manual review (ambiguous breadcrumb). ${result?.skipped || 0} were already fresh under the TTL. Regenerate affected ads to pick up the new category signal.`
    }
  };
}

module.exports = { preview, execute, PER_UNIT_ESTIMATE_USD, MAX_STEPS_PER_RUN };
