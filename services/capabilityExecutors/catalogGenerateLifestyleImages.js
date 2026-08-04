// Executor for capability catalog.generateLifestyleImages (Tier 4, brand scope).
//
// Second Tier 4 workflow (backlog row 167). Same two-phase shape as
// catalog.refreshReviewsForBrand — preview() computes the plan, execute()
// fans out over products missing lifestyle_image and generates one via
// gpt-image-2/edit.
//
// Cost model: aggregate estimateUsd is COMPUTED per-call from the plan
// size × PER_UNIT_ESTIMATE_USD. Registry entry uses a function
// estimator (not a static number) so spendGuard sees the real batch
// cost, not a per-unit misrepresentation.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const lifestyle = require('../catalogProductLifestyleImageService');

const MAX_CONCURRENCY = 2;     // gpt-image-2/edit is 30-90s per call; 2 parallel keeps memory tolerable
const MAX_STEPS_PER_RUN = 50;  // per-run guard: 50 × ~$0.04 = ~$2 max cost per invocation

async function selectTargets({ brandId }) {
  return CatalogProduct.find({
    brandId,
    $or: [
      { lifestyle_image: { $exists: false } },
      { lifestyle_image: null },
      { lifestyle_image: '' }
    ],
    // Only consider products that HAVE a hero to ground the generation.
    // Products with neither imageUrl nor productImages[0] can't be
    // handled by this workflow at all — surface them separately.
    $and: [{
      $or: [
        { imageUrl: { $exists: true, $ne: null, $ne: '' } },
        { 'productImages.0.url': { $exists: true, $ne: null } }
      ]
    }]
  })
    .sort({ lastSyncedAt: -1, firstSeenAt: -1 })
    .limit(MAX_STEPS_PER_RUN)
    .select('_id title imageUrl productImages')
    .lean();
}

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

// ── PREVIEW ──────────────────────────────────────────────────────────

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  const targets = await selectTargets({ brandId: brand._id });
  const total = targets.length;
  const estimateUsd = Number((total * lifestyle.PER_UNIT_ESTIMATE_USD).toFixed(2));

  // Wall-time estimate: gpt-image-2/edit is ~45s per call. At
  // concurrency 2 across N: N * 45s / 2.
  const estimateWallMs = Math.round(total * 45_000 / MAX_CONCURRENCY);

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.generateLifestyleImages',
      brand: { _id: String(brand._id), name: brand.name },
      summary: `Generate lifestyle images for ${total} product(s) under ${brand.name} via gpt-image-2/edit. Uses each product's hero as the reference; writes result to CatalogProduct.lifestyle_image. Estimated cost: $${estimateUsd.toFixed(2)}.`,
      totalSteps:      total,
      estimateUsd,
      estimateWallMs,
      concurrency:     MAX_CONCURRENCY,
      perUnitCostUsd:  lifestyle.PER_UNIT_ESTIMATE_USD,
      reversible:      false,
      sampleSteps: targets.slice(0, 10).map((p) => ({
        productId:  String(p._id),
        productName: p.title
      })),
      note: 'On confirm, the workflow runs to completion synchronously — the SSE stream stays open for the duration (~' +
            Math.round(estimateWallMs / 60000) + ' min). Products already carrying a lifestyle_image are excluded (clear the field to regenerate).'
    }
  };
}

// ── EXECUTE ──────────────────────────────────────────────────────────

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  const targets = await selectTargets({ brandId: brand._id });
  const total = targets.length;
  const perStep = [];
  let cursor = 0;
  const started = Date.now();

  async function worker() {
    while (cursor < targets.length) {
      const idx = cursor++;
      const target = targets[idx];
      const t0 = Date.now();
      const outcome = await lifestyle.generateOne({ productId: target._id });
      const meta = { ...outcome, tookMs: Date.now() - t0 };
      perStep.push(meta);
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            step:        idx + 1,
            totalSteps:  total,
            productId:   String(target._id),
            productName: target.title,
            outcome:     outcome.ok ? 'ok' : (outcome.reason || 'failed'),
            lifestyleUrl: outcome.lifestyleUrl || null,
            estimateUsd: outcome.estimateUsd || 0
          });
        } catch (_) { /* progress errors never fail the workflow */ }
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  const succeeded = perStep.filter((r) => r.ok).length;
  const failed    = perStep.filter((r) => !r.ok).length;
  const actualSpendUsd = Number((succeeded * lifestyle.PER_UNIT_ESTIMATE_USD).toFixed(2));

  const reasonCounts = {};
  for (const r of perStep) {
    if (r.ok) continue;
    const key = r.reason || 'unknown';
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'catalog.generateLifestyleImages',
      brand: { _id: String(brand._id), name: brand.name },
      totalSteps:      total,
      succeeded,
      failed,
      failureReasons:  reasonCounts,
      actualSpendUsd,
      durationMs:      Date.now() - started,
      note: succeeded === total
        ? `All ${total} lifestyle images generated and uploaded to Cloudinary. Products now carry CatalogProduct.lifestyle_image.`
        : `${succeeded} succeeded, ${failed} failed. Failed products retain their prior lifestyle_image state (empty).`
    }
  };
}

module.exports = { preview, execute };
