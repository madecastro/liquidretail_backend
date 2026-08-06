// Executor for capability onboarding.createBrandFromUrl (Tier 4, advertiser scope).
//
// The "onboard shop.example.com" workflow — chains the existing
// Phase 3/4 primitives into a single confirm-and-go flow:
//
//   1. Create Brand           (source='curated', websiteUrl set)
//   2. Enrichment             (Brandfetch → scrape → LLM)
//   3. Shopify catalog sync   (public products.json path)
//   4. Refresh reviews        (top-N products via 3-tier scraper)
//
// Each step reports its outcome in the workflowResult. A step failing
// does NOT abort the workflow — later steps still run and their
// outcomes surface individually. Downstream detect + enrichment
// enqueue is fire-and-forget inside step 3's service; DetectRuns
// materialize in the worker over the next few minutes.

'use strict';

const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const { normalizeBrandName } = Brand;

// Upper-bound estimate for spendGuard: Brandfetch + LLM enrichment
// ~$0.15 + Shopify sync free + downstream review scrape free. The
// dominant real cost (~$5-10) is the downstream catalog detect
// enqueued fire-and-forget by step 3 — that cost lands on OTHER
// spendGuard rows (per-product detect), NOT on this workflow's cap.
// $2 leaves headroom.
const ESTIMATE_USD = 2.00;

const REVIEW_REFRESH_CAP = 25;   // cap step 4 fan-out to keep wall time bounded

async function resolveScope({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const name = String(args?.name || '').trim();
  const websiteUrl = String(args?.websiteUrl || '').trim();
  if (!name) return { ok: false, error: 'name required (non-empty)' };
  if (!websiteUrl) return { ok: false, error: 'websiteUrl required (non-empty)' };
  if (!/^https?:\/\//i.test(websiteUrl)) {
    return { ok: false, error: 'websiteUrl must start with http:// or https://' };
  }
  const normalized = normalizeBrandName(name);
  if (!normalized) return { ok: false, error: 'name produces empty slug — pick something with alphanumerics' };
  return { ok: true, name, websiteUrl, normalized };
}

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;

  const existing = await Brand.findOne({
    advertiserId: req.advertiserId,
    nameNormalized: scope.normalized
  }).select('_id name websiteUrl').lean();

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'onboarding.createBrandFromUrl',
      name: scope.name,
      websiteUrl: scope.websiteUrl,
      alreadyExists: !!existing,
      existingBrand: existing ? {
        _id: String(existing._id),
        name: existing.name,
        websiteUrl: existing.websiteUrl || null
      } : null,
      summary: existing
        ? `Brand "${scope.name}" already exists under this advertiser (id ${existing._id}). The workflow will refresh enrichment + re-pull catalog + refresh reviews on the existing row.`
        : `Onboard "${scope.name}" from ${scope.websiteUrl}: create the brand, enrich (Brandfetch + LLM), pull the public Shopify catalog, then refresh on-site reviews for up to ${REVIEW_REFRESH_CAP} products.`,
      steps: [
        { step: 1, label: 'create brand',                                     estimateUsd: 0 },
        { step: 2, label: 'enrichment (Brandfetch + scrape + LLM)',           estimateUsd: 0.15 },
        { step: 3, label: 'public Shopify catalog sync (products.json → GraphQL → sitemap)', estimateUsd: 0 },
        { step: 4, label: `refresh on-site reviews for up to ${REVIEW_REFRESH_CAP} products`, estimateUsd: 0 }
      ],
      totalSteps:     4,
      estimateUsd:    ESTIMATE_USD,
      estimateWallMs: 5 * 60 * 1000,
      reversible:     false,
      note: 'Heavy workflow. SSE stream stays open for the whole run (typically 2-5 min). Downstream detect fires from step 3\'s service — DetectRuns materialize in the worker over the following few minutes and consume their own spendGuard budget separately from this workflow\'s estimate.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const started = Date.now();

  const outcomes = { create: null, enrichment: null, shopifySync: null, reviewsRefresh: null };

  function tick(step, label, outcome, extra = {}) {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ step, totalSteps: 4, stage: label, outcome, ...extra });
    } catch (_) { /* progress errors never fail the workflow */ }
  }

  // ── Step 1: brand.create (or reuse) ───────────────────────────────
  let brand = await Brand.findOne({
    advertiserId: req.advertiserId,
    nameNormalized: scope.normalized
  });
  let brandCreated = false;
  if (!brand) {
    try {
      brand = await Brand.create({
        advertiserId:   req.advertiserId,
        name:           scope.name,
        nameNormalized: scope.normalized,
        websiteUrl:     scope.websiteUrl,
        source:         'curated',
        curatedFields:  ['name', 'websiteUrl']
      });
      brandCreated = true;
      outcomes.create = { ok: true, brandId: String(brand._id), created: true };
      tick(1, 'create brand', 'ok', { brandId: String(brand._id), created: true });
    } catch (err) {
      outcomes.create = { ok: false, error: err.message };
      tick(1, 'create brand', 'failed', { error: err.message });
      return {
        ok: false,
        kind: 'workflowResult',
        error: `brand create failed: ${err.message}`,
        data: { workflowId: 'onboarding.createBrandFromUrl', outcomes, durationMs: Date.now() - started }
      };
    }
  } else {
    outcomes.create = { ok: true, brandId: String(brand._id), created: false, note: 'reused existing brand' };
    tick(1, 'create brand', 'skipped', { brandId: String(brand._id), reason: 'brand already exists' });
    // If the existing row has no websiteUrl, back-fill so enrichment can run.
    if (!brand.websiteUrl) {
      brand.websiteUrl = scope.websiteUrl;
      await brand.save();
    }
  }

  // ── Step 2: enrichment ────────────────────────────────────────────
  try {
    const { enrichBrandFromUrl } = require('../brandEnrichmentService');
    const enrichmentResult = await enrichBrandFromUrl(brand._id);
    outcomes.enrichment = enrichmentResult?.ok
      ? { ok: true, ...enrichmentResult }
      : { ok: false, reason: enrichmentResult?.reason || 'unknown' };
    tick(2, 'enrichment', outcomes.enrichment.ok ? 'ok' : 'failed',
         { reason: outcomes.enrichment.reason || null });
  } catch (err) {
    outcomes.enrichment = { ok: false, error: err.message };
    tick(2, 'enrichment', 'failed', { error: err.message });
  }

  // ── Step 3: public Shopify catalog sync ───────────────────────────
  try {
    // Re-read brand — enrichment may have updated shopifyUrl / stored
    // canonicals we need to sync against.
    brand = await Brand.findById(brand._id);
    const { syncBrandShopifyDirect } = require('../shopifyPublicIngestService');
    let stubStageCounter = 0;
    const stubRun = {
      stage(msg) {
        stubStageCounter++;
        tick(3, `shopify sync (${msg || 'stage'})`, 'running');
      }
    };
    const syncResult = await syncBrandShopifyDirect(brand, stubRun, { isBrandAborted: () => false });
    outcomes.shopifySync = {
      ok: syncResult?.ok !== false,
      productsUpserted: syncResult?.productsUpserted || 0,
      videosIngested:   syncResult?.videosIngested   || 0,
      reviewsCaptured:  syncResult?.reviewsCaptured  || 0,
      errors:           syncResult?.errors || [],
      reason:           syncResult?.reason || null
    };
    tick(3, 'shopify sync', outcomes.shopifySync.ok ? 'ok' : 'failed', {
      productsUpserted: outcomes.shopifySync.productsUpserted,
      reason: outcomes.shopifySync.reason
    });
  } catch (err) {
    outcomes.shopifySync = { ok: false, error: err.message };
    tick(3, 'shopify sync', 'failed', { error: err.message });
  }

  // ── Step 4: on-site review refresh (bounded fan-out) ──────────────
  try {
    const products = await CatalogProduct.find({
      brandId: brand._id,
      productUrl: { $ne: null, $exists: true, $ne: '' }
    })
      .sort({ lastSyncedAt: -1, firstSeenAt: -1 })
      .limit(REVIEW_REFRESH_CAP)
      .select('_id title')
      .lean();

    if (!products.length) {
      outcomes.reviewsRefresh = { ok: true, total: 0, note: 'no products with productUrl to scrape' };
      tick(4, 'reviews refresh', 'skipped', { reason: 'no products with productUrl' });
    } else {
      const { refreshOne } = require('../catalogProductReviewRefreshService');
      const perStep = [];
      let cursor = 0;
      const CONCURRENCY = 3;
      async function worker() {
        while (cursor < products.length) {
          const idx = cursor++;
          const p = products[idx];
          try {
            const r = await refreshOne({ productId: p._id });
            perStep.push({ ...r, productId: String(p._id) });
          } catch (err) {
            perStep.push({ ok: false, reason: err.message, productId: String(p._id) });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, products.length) }, worker));
      const succeeded = perStep.filter((r) => r.ok).length;
      const failed    = perStep.filter((r) => !r.ok).length;
      outcomes.reviewsRefresh = {
        ok: true,
        total: products.length,
        succeeded,
        failed
      };
      tick(4, 'reviews refresh', 'ok', { total: products.length, succeeded, failed });
    }
  } catch (err) {
    outcomes.reviewsRefresh = { ok: false, error: err.message };
    tick(4, 'reviews refresh', 'failed', { error: err.message });
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'onboarding.createBrandFromUrl',
      brand: { _id: String(brand._id), name: brand.name, websiteUrl: brand.websiteUrl, created: brandCreated },
      outcomes,
      durationMs: Date.now() - started,
      note: 'Downstream detect + enrichment queued from the Shopify sync run in the worker over the next few minutes. Refresh the catalog page to see hero images + subject/text detection populate.'
    }
  };
}

module.exports = { preview, execute, ESTIMATE_USD, REVIEW_REFRESH_CAP };
