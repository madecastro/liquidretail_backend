// Executor for capability catalog.refreshReviewsForBrand (Tier 4, brand scope).
//
// Two-phase Tier 4 workflow pattern:
//   preview({ req, args })                 → returns a plan the operator can review
//   execute({ req, args, onProgress? })    → runs the plan, streams progress
//
// Endpoint's Tier 4 gate decides which phase to invoke based on whether
// the tool_call_id is in the request's confirmations[]:
//   NOT confirmed → preview (side-effect free, cheap)
//   CONFIRMED     → execute (fans out over products, mutates catalog rows)
//
// The plan is deterministic-from-args at time of call. A small drift
// window exists between preview and confirmation (new products may
// appear, existing ones may lose their canonicalUrl); execute re-derives
// the target list rather than trusting a snapshot from preview. The
// tool_result surfaces any diff explicitly so the operator isn't
// surprised.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const refreshOne = require('../catalogProductReviewRefreshService').refreshOne;

const MAX_CONCURRENCY = 3;
const MAX_STEPS_PER_RUN = 100;    // per-run guard so a huge brand can't lock the SSE stream

// ── Target selection (shared preview + execute) ─────────────────────

// Products missing on-site reviews == not on the scraper source.
// Tenant-guarded by the brand lookup upstream.
async function selectTargets({ brandId }) {
  return CatalogProduct.find({
    brandId,
    $or: [
      { 'productReviews.source': { $exists: false } },
      { 'productReviews.source': null },
      { 'productReviews.source': { $ne: 'productReviewsScrape' } }
    ]
  })
    .sort({ lastSyncedAt: -1, firstSeenAt: -1 })
    .limit(MAX_STEPS_PER_RUN)
    .select('_id title productUrl canonicalUrl source')
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
  const withUrl = targets.filter((t) => t.productUrl || t.canonicalUrl);
  const noUrl = targets.filter((t) => !(t.productUrl || t.canonicalUrl));

  // When every candidate is skipped (no URL to scrape), refuse the
  // preview and steer to the right remedy per source. The 3-tier
  // scraper needs a product page — if the catalog was seeded from
  // sources that don't carry a productUrl (detect-identified drafts
  // from IG posts, sparse manual uploads), scraping is impossible;
  // enrichment via SerpAPI + Gemini (catalog.refreshDetails) is the
  // path that identifies the product page from external signals.
  if (targets.length > 0 && withUrl.length === 0) {
    const sourceCounts = {};
    for (const t of noUrl) {
      const src = t.source || 'unknown';
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    }
    const remedy = [];
    if (sourceCounts['detect-identified']) {
      remedy.push(`${sourceCounts['detect-identified']} products came from detect-identified (auto-created from IG posts — no product page was scraped at ingest). Backfill productUrl via catalog.patchProduct per row, OR run catalog.refreshDetails to enrich via SerpAPI + Gemini (which identifies product pages from title + brand + image signals rather than a pre-set URL).`);
    }
    if (sourceCounts['manual-upload']) {
      remedy.push(`${sourceCounts['manual-upload']} products came from manual-upload without a productUrl. Backfill via catalog.patchProduct.`);
    }
    if (sourceCounts['apify-shopify'] || sourceCounts['apify-ig']) {
      remedy.push(`${(sourceCounts['apify-shopify'] || 0) + (sourceCounts['apify-ig'] || 0)} products came from Apify but lack productUrl — the actor may have failed to capture it. Re-run catalog.pullFromApify to retry the ingest.`);
    }
    if (sourceCounts['shopify-direct']) {
      remedy.push(`${sourceCounts['shopify-direct']} products came from shopify-direct without productUrl — unusual, since products.json normally includes it. Re-run catalog.syncFromShopifyPublic.`);
    }
    if (sourceCounts['sitemap-jsonld']) {
      remedy.push(`${sourceCounts['sitemap-jsonld']} products came from sitemap-jsonld without productUrl — the sitemap entry may have been malformed. Re-run catalog.syncFromGenericSitemap.`);
    }
    return {
      ok: false,
      error: `no products under ${brand.name} have a productUrl to scrape. ${targets.length} candidate products checked; all skipped. Source breakdown: ${JSON.stringify(sourceCounts)}. Recommended actions: ${remedy.join(' ')} `,
      sourceCounts
    };
  }

  // Rough wall-time estimate: Tier 1 is ~4s per product (single HTTP
  // GET + parse). Tier 2 fallback adds ~2s where used. At concurrency
  // 3 across N products: N * ~5s / 3.
  const estimateWallMs = Math.round(withUrl.length * 5000 / MAX_CONCURRENCY);

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'catalog.refreshReviewsForBrand',
      brand: { _id: String(brand._id), name: brand.name },
      summary: `Refresh on-site reviews for ${withUrl.length} product(s) under ${brand.name} via the 3-tier scraper (JSON-LD → vendor API → optional headless). ${noUrl.length ? `${noUrl.length} product(s) will be skipped — no canonical URL.` : ''} No billable API cost.`,
      totalSteps:      withUrl.length,
      skippedNoUrl:    noUrl.length,
      estimateUsd:     0,
      estimateWallMs,
      concurrency:     MAX_CONCURRENCY,
      reversible:      false,
      // Sample the first 10 steps for the plan card. Not the full list
      // — that could easily blow the 12KB tool-result cap on large
      // brands. Total count is what matters for the decision.
      sampleSteps: withUrl.slice(0, 10).map((p) => ({
        productId:  String(p._id),
        productName: p.title
      })),
      skippedSample: noUrl.slice(0, 5).map((p) => ({
        productId:  String(p._id),
        productName: p.title
      })),
      note: 'On confirm, the workflow runs to completion synchronously — the SSE stream stays open for the duration (~' +
            Math.round(estimateWallMs / 60000) + ' min). Products that lack a canonical URL will be skipped with a reason.'
    }
  };
}

// ── EXECUTE ──────────────────────────────────────────────────────────
//
// onProgress: optional callback the endpoint threads in; called after
// each product finishes with { step, totalSteps, productId, productName,
// outcome, ...meta }. Never throws — errors are wrapped into the per-step
// outcome so the workflow can complete cleanly and report failures.

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  const targets = await selectTargets({ brandId: brand._id });
  const withUrl = targets.filter((t) => t.productUrl || t.canonicalUrl);
  const noUrl = targets.filter((t) => !(t.productUrl || t.canonicalUrl));
  const total = withUrl.length;

  const perStep = [];
  let cursor = 0;
  const started = Date.now();

  async function worker() {
    while (cursor < withUrl.length) {
      const idx = cursor++;
      const target = withUrl[idx];
      const t0 = Date.now();
      const outcome = await refreshOne({ productId: target._id });
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
            quotesCount: outcome.quotesCount ?? 0,
            quotesWithStars: outcome.quotesWithStars ?? 0,
            ratingValue: outcome.ratingValue ?? null,
            reviewCount: outcome.reviewCount ?? null,
            tiers:       outcome.tiers || []
          });
        } catch (_) { /* progress errors never fail the workflow */ }
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  const succeeded = perStep.filter((r) => r.ok).length;
  const failed    = perStep.filter((r) => !r.ok).length;
  const totalQuotes = perStep.reduce((s, r) => s + (r.quotesCount || 0), 0);
  const totalQuotesWithStars = perStep.reduce((s, r) => s + (r.quotesWithStars || 0), 0);

  // Aggregate failure reasons so the summary is compact.
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
      workflowId: 'catalog.refreshReviewsForBrand',
      brand: { _id: String(brand._id), name: brand.name },
      totalSteps:       total,
      succeeded,
      failed,
      skippedNoUrl:     noUrl.length,
      totalQuotes,
      totalQuotesWithStars,
      quotesWithoutStars: totalQuotes - totalQuotesWithStars,
      failureReasons:   reasonCounts,
      durationMs:       Date.now() - started,
      note: totalQuotesWithStars === totalQuotes
        ? 'Every quote captured a per-review star rating.'
        : `${totalQuotes - totalQuotesWithStars} quote(s) lack per-review star ratings — check the scraper's source coverage.`
    }
  };
}

module.exports = { preview, execute };
