// Catalog enrichment — two paths, split for cost control, both fronted by
// a free on-site review scrape:
//
//   PHASE 0 (both paths, free) — ON-SITE REVIEWS + RATINGS.
//     services/productReviewsScrapeService reads the schema.org review
//     data the store's review app publishes for rich snippets (Bazaarvoice,
//     Judge.me, Yotpo, Okendo, Loox, Stamped, PowerReviews, …) off each
//     product page: aggregate rating, review count, and individual reviews
//     with their STAR RATINGS. TTL-gated (30d), robots-aware, per-host
//     throttled. No LLM, no SerpAPI.
//
//     This runs HERE, not in the ingest services, because all four catalog
//     sources converge on this function when their sync completes —
//     Shopify auth (catalogSyncService), Shopify direct
//     (shopifyPublicIngestService), Apify (apifyIngestService) and
//     generic-sitemap (genericCatalogIngestService). One implementation,
//     uniform coverage, nothing to keep in sync across four call sites.
//     The Shopify-direct and generic paths also capture reviews inline
//     from HTML they already hold; those rows come back TTL-fresh here, so
//     phase 0 costs them nothing and only fills the gaps (products the
//     scan never reached, or pages that were rate-limited).
//
//   AUTO (enqueueBrandProductEnrichment) — fires after a catalog sync.
//     Phase 0, then a reviews-only GAP-FILL: web-wide review sentiment
//     (Gemini) for products that STILL have no review signal after the
//     scrape (no quotes AND no aggregate rating). It does NOT run the paid
//     SerpAPI product-details fetch — most products already have
//     price/rating/reviews on-page, so firing details for all of them was
//     pure waste (the old detailsRefreshedAt gate never matched the scan's
//     fields, so it fired for 100% of products every first sync).
//
//   USER-ACTUATED (enrichBrandDetails) — fires from the "Enrich" button.
//     Phase 0, then FULL enrichment for every non-draft product:
//     cross-seller price table (SerpAPI google_shopping) + web-wide review
//     synthesis (Gemini) + immersive specs. This is the genuinely-additive
//     data a single product page can't provide; it's opt-in because it
//     costs ~$0.05–0.12/product and most catalog products never become ads.
//
// Both paths are concurrency-limited and surfaced as a cancellable
// OperationRun (kind 'enrichment') so the work is visible in the
// ActivityBar dock and can be stopped mid-flight (partials kept).
// Per-run product count is uncapped by default (see parseMaxPerRun).
//
// Idempotent: the underlying reviews/details services check their 30-day
// caches (+ gtin/mpn sibling dedup) first, so re-running is cheap.
//
// Cost shape per product (worst case, cold cache, FULL path only):
//   - productDetails: 1 SerpAPI google_shopping + 1 SerpAPI immersive
//                     + 1 Gemini grounded-search → ~$0.05–0.12
//   - productReviews: 1 Gemini grounded-search → ~$0.02–0.05
//   - Sibling-hit on gtin/mpn (V3 dedup) → $0
// Cap in-flight spend by tuning CATALOG_ENRICHMENT_CONCURRENCY. An optional
// per-run ceiling still exists (CATALOG_ENRICHMENT_MAX_PER_RUN) but defaults
// to uncapped — a positive integer re-caps one run if ever needed.

const CatalogProduct        = require('../models/CatalogProduct');
const productDetailsService = require('./productDetailsService');
const progressService       = require('./progressService');
// Free, first-party on-page review scrape — tried before the paid
// web-wide lookup for every product that has a productUrl.
const reviewsEngine         = require('./productReviewsScrapeService');
const {
  maybeFetchProductReviewsCached
} = require('./productMatchService');

const { concurrency: CONC } = require('./concurrency');
const CONCURRENCY = CONC.CATALOG_ENRICHMENT_CONCURRENCY;
// Per-run ceiling. Unset / 0 / negative / NaN → uncapped. A positive
// integer re-caps one brand run. Default is uncapped so an operator who
// does nothing gets no ceiling (owner 2026-09-05).
function parseMaxPerRun(raw) {
  const n = Number(raw);
  return n > 0 ? n : Infinity;
}
const MAX_PER_RUN = parseMaxPerRun(process.env.CATALOG_ENRICHMENT_MAX_PER_RUN);
function applyRunCap(candidates, cap = MAX_PER_RUN) {
  if (!Array.isArray(candidates)) return [];
  return Number.isFinite(cap) ? candidates.slice(0, cap) : candidates;
}

(function logConfig() {
  const maxLabel = Number.isFinite(MAX_PER_RUN) ? MAX_PER_RUN : 'uncapped';
  console.log(
    `🛒 catalogProductEnrichmentService config — ` +
    `concurrency=${CONCURRENCY} maxPerRun=${maxLabel} ` +
    `productDetailsEnabled=${productDetailsService.isEnabled()}`
  );
})();

// AUTO-path gate: a product needs a PAID review gap-fill only when it has
// NO review signal at all — neither individual quotes NOR an aggregate
// rating — after phase 0's free on-site scrape has run. Products carrying
// on-page reviews/rating are left alone (the paid cross-seller details
// fetch is user-actuated now, so we no longer gate on detailsRefreshedAt).
// NOTE: callers must .select('rating productReviews') for this to work,
// and must load rows AFTER the scrape so the gate sees fresh state.
function needsEnrichment(row) {
  const hasQuotes = Array.isArray(row.productReviews?.quotes) && row.productReviews.quotes.length > 0;
  const hasRating = row.rating != null;
  return !hasQuotes && !hasRating;
}

// Reviews (+ optionally full details) for a single product. Errors are
// caught + logged so one bad product doesn't poison the whole queue.
//
// Returns { enriched: boolean } — did this product actually GAIN review/
// detail signal this pass, as opposed to merely being iterated over. This
// is distinct from "did not throw": every branch below already swallows
// its own errors, so a product with e.g. a fully-down review-scrape source
// completes "successfully" with zero real signal. runEnrichment aggregates
// this to decide succeed() vs fail() (see the zero-enrichment gap fix).
async function enrichOne(product, { includeDetails = false } = {}) {
  const id    = String(product._id);
  const label = `"${product.title || '(untitled)'}"`;
  const t0    = Date.now();
  let enriched = false;

  // FIRST-PARTY REVIEWS FIRST. The merchant's own product page carries the
  // reviews their review app publishes as rich snippets — free, verbatim,
  // and SKU-exact. Catalog sources that never crawl PDPs (Meta/IG catalog,
  // Apify) previously skipped straight to the paid web-wide Gemini lookup,
  // which returns third-party chatter about the product instead of the
  // store's own reviews. Scrape first; fall through on a miss.
  let scraped = false;
  if (product.productUrl) {
    try {
      const res = await reviewsEngine.captureForProduct(product);
      scraped = res.captured;
      if (res.captured) {
        enriched = true;
        const pr = res.productReviews;
        console.log(
          `   ✓ enrich-reviews ${label}: on-page ${pr.quotes.length} quote(s) · ` +
          `rating=${pr.rating ?? '—'} · count=${pr.reviewCount ?? '—'}` +
          (pr.platform ? ` · ${pr.platform}` : '')
        );
      }
    } catch (err) {
      console.warn(`   ⚠️  enrich-reviews[on-page] ${label}: ${err.message}`);
    }
  }

  try {
    // Web-wide review sentiment (Gemini) — only when the product page had
    // nothing structured. Cached/sibling data returns synchronously; a
    // genuine miss kicks off a background fetch (fire-and-forget — its
    // return is null even when the background lookup later succeeds, so
    // it can only ever mark THIS pass enriched on a cache/sibling hit,
    // never on a still-pending background fetch — that is deliberate:
    // this pass's own accomplishment is what run.succeed/fail is about).
    if (!scraped) {
      const webWide = await maybeFetchProductReviewsCached({
        catalogProductId: id,
        productName:      product.title || null,
        brandName:        product.brand || null,
        productUrl:       product.productUrl || null
      });
      if (webWide) enriched = true;
    }
  } catch (err) {
    console.warn(`   ⚠️  enrich-reviews ${label}: ${err.message}`);
  }

  // Details (cross-seller table + immersive specs) — USER-ACTUATED path
  // only. Blocking, writes-through to CatalogProduct on success. No-op if
  // SERPAPI is disabled.
  if (includeDetails && productDetailsService.isEnabled()) {
    try {
      // brandId threaded too (adversarial-review finding, 2026-08-19):
      // `product.brandId` is a real, required ObjectId field on CatalogProduct
      // (models/CatalogProduct.js) — previously not passed, so this path's
      // product_review_summary CostLog rows carried brandId:null despite the
      // brand being right there on the document being enriched.
      const details = await productDetailsService.fetchProductDetails(
        {
          productName: product.title,
          brand:       product.brand || null,
          variant:     null
        },
        id,
        product.brandId || null
      );
      if (details) enriched = true;
    } catch (err) {
      console.warn(`   ⚠️  enrich-details ${label}: ${err.message}`);
    }
  }

  const ms = Date.now() - t0;
  console.log(`   ✓ enriched ${label} in ${ms}ms`);
  return { enriched };
}

// Concurrency-capped queue — N workers pull from the same product list.
// opts.includeDetails threads through to enrichOne.
// opts.onDone(n, total) is awaited after each item (progress ticks +
//   cooperative-cancel checkpoint live here).
// opts.isCancelled() → truthy stops launching new work (in-flight items
//   still finish). Returns { processed, enrichedCount, cancelled }.
//
// processed counts items ITERATED (matches every existing caller's
// progress-tick math); enrichedCount counts items that actually GAINED
// signal (enrichOne's own { enriched } result) — the two diverge exactly
// when a product completes without error but produces nothing, e.g. a
// review-scrape source returning empty across the board. A crashed
// enrichOne (the .catch below) counts toward processed but never
// enrichedCount, which is the conservative/correct call.
async function processQueue(products, { includeDetails = false, onDone = null, isCancelled = null } = {}) {
  let next = 0;
  let inflight = 0;
  let processed = 0;
  let enrichedCount = 0;
  let stopped = false;
  await new Promise(resolve => {
    const pump = () => {
      // Nothing left to launch and nothing in flight → done.
      if ((next >= products.length || stopped) && inflight === 0) {
        resolve();
        return;
      }
      while (!stopped && inflight < CONCURRENCY && next < products.length) {
        const p = products[next++];
        inflight++;
        enrichOne(p, { includeDetails })
          .then((result) => { if (result && result.enriched) enrichedCount++; })
          .catch(err => console.warn(`   ⚠️  enrich crash for ${p._id}: ${err.message}`))
          .finally(async () => {
            inflight--;
            processed++;
            if (onDone) { try { await onDone(processed, products.length); } catch {} }
            if (isCancelled && !stopped) { try { if (await isCancelled()) stopped = true; } catch {} }
            pump();
          });
      }
    };
    pump();
  });
  return { processed, enrichedCount, cancelled: stopped };
}

// Shared driver for both paths. Loads the brand's non-draft products,
// filters to the target set, wraps the queue in a cancellable
// 'enrichment' OperationRun so it's visible + stoppable.
async function runEnrichment(brandId, { includeDetails, onlyGaps, label }) {
  if (!brandId) return { skipped: true, reason: 'no brandId' };
  const t0 = Date.now();

  // ── Phase 0: on-site reviews, uniformly, for EVERY ingest path ──
  //
  // This is the one place all four catalog sources converge — Shopify
  // auth (catalogSyncService), Shopify direct, Apify and generic-sitemap
  // all call enqueueBrandProductEnrichment when their sync finishes — so
  // the review scrape lives here rather than being copy-pasted into four
  // post-sync hooks that could drift apart.
  //
  // Free: no LLM, no SerpAPI. Reads the schema.org review data the
  // store's review app publishes for rich snippets (any app), TTL-gated
  // at 30 days, robots-aware and per-host throttled. Awaited so the
  // gap-fill below sees post-scrape state and doesn't pay for reviews we
  // just captured for nothing.
  let reviewScrape = null;
  try {
    reviewScrape = await reviewsEngine.syncBrandProductReviews(brandId);
  } catch (err) {
    console.warn(`   ⚠️  on-site review scrape failed for brand=${brandId}: ${err.message}`);
  }

  const rows = await CatalogProduct.find({
    brandId,
    draft: { $ne: true }
  })
    .select('_id advertiserId title brand productUrl productReviews rating detailsRefreshedAt')
    .lean();

  const candidates = onlyGaps ? rows.filter(needsEnrichment) : rows;
  const targets = applyRunCap(candidates);

  console.log(
    `🛒 catalogProductEnrichment[brand=${brandId}]: ${label} — ` +
    `${rows.length} products, ${targets.length} target(s) ` +
    `(onlyGaps=${!!onlyGaps} includeDetails=${!!includeDetails} cap=${Number.isFinite(MAX_PER_RUN) ? MAX_PER_RUN : 'uncapped'}, concurrency=${CONCURRENCY})` +
    (reviewScrape
      ? ` · on-site reviews: ${reviewScrape.captured}/${reviewScrape.candidates} captured, ${reviewScrape.withQuotes} with quotes`
      : '')
  );
  if (!targets.length) {
    return {
      ok: true, total: rows.length, enriched: 0, skipped: rows.length,
      reviewScrape, durationMs: Date.now() - t0
    };
  }

  const advertiserId = targets[0]?.advertiserId || rows[0]?.advertiserId || null;
  const run = await progressService.startRun({
    kind:        'enrichment',
    advertiserId,
    brandId,
    total:       targets.length,
    cancellable: true,
    label
  });

  let cancelledByRun = false;
  const noun = includeDetails ? 'enriched' : 'reviews';
  const { processed, enrichedCount, cancelled } = await processQueue(targets, {
    includeDetails,
    onDone: async (n, total) => {
      run.tick(n, total, `${noun} ${n}/${total}`);
      if (!cancelledByRun) {
        // checkpoint() throws CancelledError (and writes the terminal
        // 'cancelled' state) if a stop was requested — swallow it and let
        // the queue drain its in-flight items.
        try { await run.checkpoint(); } catch { cancelledByRun = true; }
      }
    },
    isCancelled: () => cancelledByRun
  });

  const durationMs = Date.now() - t0;
  if (cancelledByRun || cancelled) {
    // run already closed as 'cancelled' by checkpoint(); markCancelled is
    // an idempotent no-op guard in case cancelled came from elsewhere.
    run.markCancelled?.('Cancelled — partial enrichment kept');
    console.log(`🛒 catalogProductEnrichment[brand=${brandId}]: ${label} CANCELLED after ${processed}/${targets.length} in ${Math.round(durationMs / 1000)}s`);
    return { ok: true, cancelled: true, total: rows.length, enriched: processed, reviewScrape, durationMs };
  }

  // Genuine gap, not a hypothetical: this queue attempted real work
  // (targets.length > 0, guaranteed by the early-return above) and every
  // single product came back with zero new review/detail signal — e.g. the
  // review-scrape source is down across the board. Previously this always
  // called succeed(), so an operator watching the ActivityBar / ingest
  // Slack feed saw a normal-looking green run with nothing to show for it.
  // Empty gap-fill (targets.length === 0) is untouched — that stays the
  // existing no-op/skip path above.
  if (enrichedCount === 0 && targets.length > 0) {
    await run.fail(
      new Error(`enrichment: 0 of ${targets.length} product(s) produced new review/detail signal`),
      { total: rows.length, targets: targets.length, processed, enriched: enrichedCount }
    );
    console.log(
      `🛒 catalogProductEnrichment[brand=${brandId}]: ${label} FAILED — ` +
      `zero enrichments across ${targets.length} target(s) in ${Math.round(durationMs / 1000)}s`
    );
    return { ok: false, total: rows.length, enriched: 0, skipped: rows.length - targets.length, reviewScrape, durationMs };
  }

  await run.succeed({ enriched: enrichedCount });
  console.log(
    `🛒 catalogProductEnrichment[brand=${brandId}]: ${label} done — ` +
    `enriched=${enrichedCount}/${processed} skipped=${rows.length - targets.length} in ${Math.round(durationMs / 1000)}s`
  );
  return { ok: true, total: rows.length, enriched: enrichedCount, skipped: rows.length - targets.length, reviewScrape, durationMs };
}

// AUTO path — called after catalog sync. Reviews-only gap-fill for
// products with no on-page review signal. Cheap; no SerpAPI details.
async function enqueueBrandProductEnrichment(brandId) {
  return runEnrichment(brandId, {
    includeDetails: false,
    onlyGaps:       true,
    label:          'Review gap-fill'
  });
}

// USER-ACTUATED path — called from POST /api/sales-demos/brands/:id/enrich.
// Full cross-seller details + web-wide reviews for every non-draft
// product. This is where the SerpAPI/Gemini spend lives now.
async function enrichBrandDetails(brandId) {
  return runEnrichment(brandId, {
    includeDetails: true,
    onlyGaps:       false,
    label:          'Product enrichment'
  });
}

module.exports = {
  enqueueBrandProductEnrichment,
  enrichBrandDetails,
  // exported for tests / one-off scripts
  enrichOne,
  needsEnrichment,
  parseMaxPerRun,
  applyRunCap
};
