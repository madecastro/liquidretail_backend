// services/genericCatalogIngestService.js
//
// Client-agnostic catalog ingester: walks XML sitemaps + scrapes
// schema.org JSON-LD (or Open Graph) Product data from any
// server-rendered e-commerce site, then upserts CatalogProduct rows.
//
// Mirrors services/shopifyPublicIngestService.syncBrandShopifyDirect
// (progress/abort, CatalogProduct upsert shape, end-of-run detect /
// enrichment / category-inference trio) but sources the catalog from
// genericCatalogResolver (mode 'sitemap-jsonld') instead of Shopify
// storefront endpoints.
//
// Origin comes from resolveStoreOrigin(brand) — typically
// brand.apifyDemo.shopifyUrl (reused as "catalog URL" for non-Shopify
// brands). NOTHING client-specific lives here; dispatcher wiring
// (GENERIC_CATALOG_ENABLED kill-switch, method selection) is outside.
//
// MONEY: resolver already emits price in MAJOR units. Do not re-scale.

'use strict';

const CatalogProduct = require('../models/CatalogProduct');
const Category = require('../models/Category');
const { resolveGenericCatalog, DEFAULT_CAP } = require('./genericCatalogResolver');
const ingestHelpers = require('./shopifyPublicIngestService');
const { concurrency: CONC } = require('./concurrency');

const LOG = '🗺';

/**
 * syncBrandGenericCatalog(brand, run, { isBrandAborted })
 *
 * brand  – hydrated Brand doc (_id, advertiserId, name, catalog URL fields)
 * run    – progressService run handle (stage/tick/checkpoint)
 * opts.isBrandAborted(brandId, run) – cooperative-cancel helper
 *
 * Returns {
 *   productsUpserted, videosIngested:0, reviewsCaptured, errors:[],
 *   durationMs, ok?, reason?, cancelled?
 * }
 */
async function syncBrandGenericCatalog(brand, run, { isBrandAborted } = {}) {
  const t0 = Date.now();
  const errors = [];
  let productsUpserted = 0;
  const videosIngested = 0;
  let reviewsCaptured = 0;

  const abortCheck = typeof isBrandAborted === 'function'
    ? isBrandAborted
    : async () => false;

  const origin = ingestHelpers.resolveStoreOrigin(brand);
  if (!origin) {
    const reason = 'no catalog URL configured on brand';
    console.warn(`   ⚠️  ${LOG}  ${reason}`);
    return {
      productsUpserted: 0,
      videosIngested: 0,
      reviewsCaptured: 0,
      errors: [reason],
      ok: false,
      reason,
      durationMs: Date.now() - t0
    };
  }

  const CAP = Math.max(1, parseInt(process.env.GENERIC_CATALOG_LIMIT, 10) || DEFAULT_CAP);

  console.log(`${LOG}  Generic-catalog sync starting: brand=${brand._id} store=${origin} cap=${CAP}`);
  run?.stage?.('resolving generic catalog');

  const boundAbort = async () => abortCheck(brand._id, run);

  let access;
  try {
    access = await resolveGenericCatalog(brand, {
      run,
      abortCheck: boundAbort,
      cap: CAP
    });
  } catch (err) {
    errors.push(`generic catalog resolver: ${err.message}`);
    access = {
      ok: false,
      mode: 'sitemap-jsonld',
      products: [],
      origin,
      reason: err.message,
      stats: {}
    };
  }

  const products = (access.products || []).slice(0, CAP);
  const stats = access.stats || {};
  // Trust the resolver's own cancel signal — do NOT re-poll boundAbort()
  // here: the resolver's first checkpoint() already closed the run handle,
  // after which isBrandAborted can no longer observe the cancel and would
  // wrongly report "not aborted", letting a cancelled sync run to
  // completion + flip the run status back to succeeded.
  const resolverCancelled = !!access.cancelled;

  if (access.reason && !products.length) {
    errors.push(access.reason);
  }
  if (Array.isArray(access.warnings)) {
    for (const w of access.warnings) errors.push(`warning: ${w}`);
  }

  console.log(
    `${LOG}  resolved ${products.length} products via ${access.mode || 'sitemap-jsonld'} ` +
    `(origin=${access.origin || origin}` +
    ` scanned=${stats.urlsScanned ?? '?'} jsonLd=${stats.jsonLdProductsFound ?? '?'}` +
    ` og=${stats.ogFallbackUsed ?? '?'} invalid=${stats.validationFailures ?? '?'}` +
    ` cf=${stats.cfChallenges ?? '?'})` +
    (access.reason ? ` reason=${access.reason}` : '')
  );

  // Cancelled with nothing to persist — report cancel (any partials the
  // resolver did fetch are upserted by the loop below).
  if (resolverCancelled && !products.length) {
    return {
      productsUpserted: 0,
      videosIngested: 0,
      reviewsCaptured: 0,
      errors,
      cancelled: true,
      durationMs: Date.now() - t0
    };
  }

  // Unscrapeable / empty decisive failure (NOT a cancel) — surface reason
  // to the Sales UI instead of a silent empty catalog.
  if (!access.ok && !products.length) {
    return {
      productsUpserted: 0,
      videosIngested: 0,
      reviewsCaptured: 0,
      errors,
      ok: false,
      reason: access.reason || 'generic catalog resolution failed',
      durationMs: Date.now() - t0
    };
  }

  const totalPlanned = products.length || CAP;
  run?.tick?.(0, totalPlanned, `resolved ${products.length} products via sitemap-jsonld`);
  run?.stage?.('saving products to catalog');

  // ── Upsert each flat product ─────────────────────────────────────
  // If the resolver was already cancelled, still persist the partials it
  // fetched (network cost already paid) — matching the "partial ingest
  // kept" contract — and skip the per-item abort re-check (the run handle
  // is already closed). Only a FRESH mid-upsert cancel breaks the loop.
  let idx = 0;
  let cancelled = resolverCancelled;
  for (const p of products) {
    idx += 1;
    if (!resolverCancelled) {
      let midAbort = false;
      if (await abortCheck(brand._id, run)) {
        midAbort = true;
      } else if (run?.checkpoint) {
        // checkpoint() throws CancelledError if cancel landed exactly here;
        // treat that as a graceful cancel, not an unhandled error.
        try { await run.checkpoint(); } catch { midAbort = true; }
      }
      if (midAbort) {
        console.log(`   · ${LOG}  aborted mid-upsert for brand=${brand._id}`);
        cancelled = true;
        break;
      }
    }

    try {
      const externalId = String(p.externalId);

      // Category breadcrumb captured during the scan (from the PDP HTML we
      // already fetched). Build the Category tree + stamp inferredCategoryAt
      // here so the post-sync inference pass SKIPS this product (its query
      // filters on inferredCategoryAt) — no second per-product crawl.
      let inferredBreadcrumb = null;
      let categoryRefId = null;
      if (Array.isArray(p.breadcrumb) && p.breadcrumb.length) {
        inferredBreadcrumb = p.breadcrumb;
        try {
          categoryRefId = await Category.findOrCreateCategoryTree({
            brandId:          brand._id,
            advertiserId:     brand.advertiserId || null,
            breadcrumb:       p.breadcrumb.join(' > '),
            url:              p.productUrl || null,
            firstSeenMediaId: null
          });
        } catch (err) {
          console.warn(`   ⚠️  ${LOG}  category tree build failed for ${externalId}: ${err.message}`);
        }
      }

      const set = {
        advertiserId:     brand.advertiserId,
        brandId:          brand._id,
        source:           'sitemap-jsonld',
        externalId,
        itemGroupId:      externalId,
        title:            p.title || '(untitled)',
        description:      p.description || null,
        brand:            p.brand || brand.name || null,
        price:            Number.isFinite(p.price) ? p.price : null,
        currency:         p.currency || null,
        availability:     p.availability || null,
        imageUrl:         p.imageUrl || null,
        additionalImages: Array.isArray(p.additionalImages) ? p.additionalImages.slice(0, 4) : [],
        productUrl:       p.productUrl || null,
        gtin:             p.gtin || null,
        mpn:              p.mpn || null,
        category:         p.category || null,
        rawData:          p.rawData,
        lastSyncedAt:     new Date()
      };
      // Conditionally attach rating / productReviews so Mongoose does not
      // persist explicit undefined → null and wipe prior values.
      if (Number.isFinite(p.rating)) set.rating = p.rating;
      if (p.productReviews) set.productReviews = p.productReviews;
      // Category breadcrumb captured in-scan (see above). Stamping
      // inferredCategoryAt makes the post-sync inferBatch skip this row.
      if (inferredBreadcrumb) {
        set.inferredBreadcrumb = inferredBreadcrumb;
        set.inferredCategoryAt = new Date();
        if (categoryRefId) set.categoryRef = categoryRefId;
      }

      await CatalogProduct.findOneAndUpdate(
        { brandId: brand._id, externalId },
        {
          $set: set,
          $setOnInsert: { firstSeenAt: new Date() }
        },
        { upsert: true, new: true }
      );
      productsUpserted += 1;
      if (p.productReviews && (p.productReviews.quotes?.length || p.productReviews.rating != null)) {
        reviewsCaptured += 1;
      }
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  upsert failed for ${p?.externalId}: ${err.message}`);
      errors.push(`upsert ${p?.externalId}: ${err.message}`);
    }

    run?.tick?.(
      idx,
      totalPlanned,
      // Live review-coverage %: share of saved products that carried
      // review data (rating/quotes) in their structured data.
      `saved ${idx}/${totalPlanned} products · ${idx ? Math.round((reviewsCaptured / idx) * 100) : 0}% with reviews`
    );
  }

  // ── End-of-run trio (mirror shopifyPublicIngestService:632-674) ──
  // Use the cancel state established above (resolver signal or a fresh
  // mid-upsert cancel) — re-polling abortCheck here is unreliable once the
  // run handle has been closed by an earlier checkpoint().
  if (!cancelled) {
    try {
      const { enqueueBrandProductDetects } = require('./catalogProductDetectService');
      await enqueueBrandProductDetects(brand._id);
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  product-path detect enqueue failed: ${err.message}`);
      errors.push(`detect enqueue: ${err.message}`);
    }

    setImmediate(() => {
      require('./catalogProductEnrichmentService')
        .enqueueBrandProductEnrichment(brand._id)
        .catch(err => console.warn(`   ⚠️  ${LOG}  catalog enrichment enqueue failed: ${err.message}`));
    });

    setImmediate(() => {
      (async () => {
        let catRun = null;
        try {
          const inference = require('./productCategoryInferenceService');
          // NOTE: not { $ne: null, …, $ne: '' } — duplicate keys in a JS
          // object literal keep only the LAST one, silently dropping the
          // null exclusion (adversarial-review find; same bug fixed in
          // catalogSyncService's copy of this query).
          // Most products now arrive pre-stamped with inferredCategoryAt
          // (breadcrumb captured in-scan), so this backfills only the gaps
          // the scan couldn't parse — no longer a full per-product crawl.
          const candidates = await CatalogProduct.find({
            brandId: brand._id,
            productUrl: { $exists: true, $nin: [null, ''] },
            $or: [
              { inferredCategoryAt: null },
              { inferredCategoryAt: { $lt: new Date(Date.now() - inference.TTL_DAYS * 24 * 60 * 60 * 1000) } }
            ]
          }).select('_id').lean();
          if (!candidates.length) return;
          console.log(`🔎 categoryInference: brand=${brand._id} scheduling ${candidates.length} product page scrapes`);
          // Surface as a cancellable run so it shows in the activity dock.
          const progressService = require('./progressService');
          catRun = await progressService.startRun({
            // Distinct kind so this free category re-scrape isn't conflated
            // with (or blocked by) the paid 'enrichment' runs in the
            // activity log / Enrich lock.
            kind:         'category-inference',
            advertiserId: brand.advertiserId,
            brandId:      brand._id,
            total:        candidates.length,
            cancellable:  true,
            label:        'Category inference'
          });
          const result = await inference.inferBatch(candidates.map(c => c._id), {
            concurrency: CONC.CATEGORY_INFERENCE_BATCH_CONCURRENCY,
            onProgress: async (done, total) => {
              catRun.tick(done, total, `category inference ${done}/${total}`);
              try { await catRun.checkpoint(); } catch { throw new Error('cancelled'); }
            }
          });
          if (result.cancelled) catRun.markCancelled?.('Cancelled — partial categories kept');
          else await catRun.succeed({ ok: result.ok, skipped: result.skipped, failed: result.failed });
          console.log(`🔎 categoryInference: brand=${brand._id} done — ok=${result.ok} cfChallenged=${result.challenged || 0} skipped=${result.skipped} failed=${result.failed}`);
        } catch (err) {
          if (catRun) catRun.fail?.(err);
          console.warn(`   ⚠️  ${LOG}  category inference enqueue failed: ${err.message}`);
        }
      })();
    });
  }

  const durationMs = Date.now() - t0;
  console.log(
    `${LOG}  Generic-catalog sync done: brand=${brand._id} ` +
    `upserted=${productsUpserted} reviews=${reviewsCaptured} ` +
    `errors=${errors.length} cancelled=${!!cancelled} ` +
    `stats=${JSON.stringify(stats)} in ${durationMs}ms`
  );

  const out = {
    productsUpserted,
    videosIngested,
    reviewsCaptured,
    errors,
    durationMs
  };
  if (cancelled) out.cancelled = true;
  if (access.rateLimited && !productsUpserted) {
    out.ok = false;
    out.reason = access.reason || `rate-limited while scanning ${origin}`;
  }
  return out;
}

module.exports = {
  syncBrandGenericCatalog
};
