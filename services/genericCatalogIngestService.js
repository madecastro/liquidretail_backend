// services/genericCatalogIngestService.js
//
// Client-agnostic catalog ingester: walks XML sitemaps + scrapes
// schema.org JSON-LD (or Open Graph) Product data from any
// server-rendered e-commerce site, then upserts CatalogProduct rows.
//
// Mirrors services/shopifyPublicIngestService.syncBrandShopifyDirect
// (progress/abort, CatalogProduct upsert shape, end-of-run detect /
// enrichment / category-inference trio) but sources the catalog from
// genericCatalogResolver. Mode is usually 'sitemap-jsonld'; when
// GENERIC_CATALOG_AUTODETECT senses Shopify the resolver climbs the
// shopifyAccessResolver ladder and returns source:'shopify-direct'
// (full image gallery via products.json — see siteFingerprintService).
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
const {
  resolveGenericCatalog,
  DEFAULT_CAP
} = require('./genericCatalogResolver');
// Shared per-product alt-image cap (hero is separate). Zero-dep module
// so this path never re-exports the constant through the resolver.
const { MAX_ADDITIONAL_IMAGES } = require('./catalogImageLimits');
const ingestHelpers = require('./shopifyPublicIngestService');
const { concurrency: CONC } = require('./concurrency');
// Free packshot/lifestyle classify at ingest (URL-keyed on CatalogProduct).
// Bounded session per sync — never fails the upsert.
const ingestShotClassify = require('./ingestShotClassifyService');
// Shared feed-truth stamper — used as a FALLBACK when the scanner did
// not capture a JSON-LD breadcrumb. Feeds row.category (single term or
// path) through resolveFeedCategoryRef first, coarse enum second, so
// non-breadcrumb rows still land a real categoryRef at ingest instead
// of waiting for a match / re-scrape.
const { stampFeedTruthCategoryRef, applyFeedTruthStamp } = require('./categoryClassifier');
// Upsert loop gets its OWN wall-clock budget (DB-bound) — must not share
// the network scan budget's clock, or a slow scan would leave no time to
// persist products already paid for in network cost.
const { createBudget } = require('./genericCatalogDiscovery/budget');
// Back-fills Brand.websiteUrl the first time this ingest path proves a
// storefront domain for a brand that doesn't have one yet — same helper
// shopifyPublicIngestService uses; see brandWebsiteBackfill.js header.
const { backfillBrandWebsiteUrl } = require('./brandWebsiteBackfill');

const LOG = '🗺';
const UPSERT_BUDGET_MS = parseInt(process.env.GENERIC_CATALOG_UPSERT_BUDGET_MS, 10);

/**
 * syncBrandGenericCatalog(brand, run, { isBrandAborted, categories })
 *
 * brand  – hydrated Brand doc (_id, advertiserId, name, catalog URL fields)
 * run    – progressService run handle (stage/tick/checkpoint)
 * opts.isBrandAborted(brandId, run) – cooperative-cancel helper
 * opts.categories – optional category keys (from sitemap derivation) that
 *   filter candidate URLs before the PDP scan. Segment-exact match.
 *
 * Returns {
 *   productsUpserted, videosIngested:0, reviewsCaptured, errors:[],
 *   durationMs, ok?, reason?, cancelled?,
 *   categoryOptions?, categoryPromptSuggested?
 * }
 */
async function syncBrandGenericCatalog(brand, run, { isBrandAborted, categories } = {}) {
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
      cap: CAP,
      // Operator-selected category keys (from a prior discoverOnly preview).
      // Resolver no-ops the filter when the feature flag is off.
      categories: Array.isArray(categories) ? categories : undefined
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
  // CatalogProduct.source is a closed enum. Prefer the resolver's honest
  // stamp (Shopify ladder → 'shopify-direct'; JSON-LD walk → 'sitemap-jsonld').
  // Never invent a value outside models/CatalogProduct.js enum.
  const catalogSource = (() => {
    if (access.source === 'shopify-direct' || access.source === 'sitemap-jsonld') {
      return access.source;
    }
    // Shopify ladder modes from auto-detect success (mode ≠ sitemap-jsonld)
    const shopifyModes = new Set(['products-json', 'storefront-graphql', 'sitemap']);
    if (shopifyModes.has(access.mode)) return 'shopify-direct';
    return 'sitemap-jsonld';
  })();
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
    `(source=${catalogSource} origin=${access.origin || origin}` +
    ` platform=${stats.platform ?? '—'} conf=${stats.confidence ?? '—'}` +
    ` scanned=${stats.urlsScanned ?? '?'} jsonLd=${stats.jsonLdProductsFound ?? '?'}` +
    ` og=${stats.ogFallbackUsed ?? '?'} invalid=${stats.validationFailures ?? '?'}` +
    ` cf=${stats.cfChallenges ?? '?'})` +
    (access.reason ? ` reason=${access.reason}` : '')
  );

  // websiteUrl back-fill: `origin` here is resolveStoreOrigin's own return
  // (apifyDemo.shopifyUrl etc.) — this resolver, unlike the Shopify-direct
  // ladder, never substitutes a myshopify-backend origin for it, but
  // backfillBrandWebsiteUrl's host denylist is a second, independent guard
  // regardless. Gated on products.length so an unreachable/typo'd config
  // never poisons websiteUrl.
  if (products.length > 0) {
    backfillBrandWebsiteUrl(brand, origin, { ingestSource: catalogSource }).catch(err =>
      console.warn(`   ⚠️  websiteUrl back-fill failed for brand=${brand._id}: ${err.message}`)
    );
  }

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
    const emptyOut = {
      productsUpserted: 0,
      videosIngested: 0,
      reviewsCaptured: 0,
      errors,
      ok: false,
      reason: access.reason || 'generic catalog resolution failed',
      durationMs: Date.now() - t0
    };
    if (access.partial) {
      emptyOut.partial = true;
      emptyOut.partialReason = access.partialReason || 'budget-exceeded';
    }
    if (access.budgetExpired) emptyOut.budgetExpired = true;
    return emptyOut;
  }

  const totalPlanned = products.length || CAP;
  run?.tick?.(0, totalPlanned, `resolved ${products.length} products via ${access.mode || catalogSource}`);
  run?.stage?.('saving products to catalog');

  // ── Upsert each flat product ─────────────────────────────────────
  // If the resolver was already cancelled, still persist the partials it
  // fetched (network cost already paid) — matching the "partial ingest
  // kept" contract — and skip the per-item abort re-check (the run handle
  // is already closed). Only a FRESH mid-upsert cancel breaks the loop.
  //
  // ARCHITECTURE: product upsert NEVER awaits image classification.
  // Collect work; post-loop pass classifies. Hung DNS cannot truncate.
  const shotSession = ingestShotClassify.createSession();
  const pendingClassify = [];
  // Upsert budget is a SEPARATE clock from the scan (DB-bound work).
  const upsertBudget = createBudget({ totalMs: UPSERT_BUDGET_MS });
  let idx = 0;
  let cancelled = resolverCancelled;
  let partial = !!access.partial;
  let partialReason = access.partialReason || null;
  // Universal ingest cap — see services/ingestLimits.js. Env
  // CATALOG_INGEST_LIMIT bounds how many rows this pass persists;
  // default 10. Stops the loop at the cap without changing what the
  // upstream fetch returned.
  const { catalogIngestLimit } = require('./ingestLimits');
  const ingestCap = catalogIngestLimit();
  let persistedCount = 0;
  try {
  for (const p of products) {
    if (ingestCap != null && persistedCount >= ingestCap) {
      console.log(`   · ${LOG}  hit CATALOG_INGEST_LIMIT=${ingestCap} — stopping after ${persistedCount} product(s)`);
      break;
    }
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
    // Wall-clock stop: keep everything already written, report partial.
    // Distinct from cancel — do not set cancelled / do not discard rows.
    if (upsertBudget.expired()) {
      console.log(`   · ${LOG}  upsert budget expired for brand=${brand._id} (kept ${productsUpserted})`);
      partial = true;
      partialReason = partialReason || 'budget-exceeded';
      break;
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
      // FALLBACK — scanner didn't capture a JSON-LD breadcrumb but the
      // row still carries a merchant-authored category string. Feed
      // truth first (breadcrumb-as-path or single term), coarse enum
      // second. Same helper the Meta / Shopify / Apify paths use.
      if (!categoryRefId && p.category) {
        try {
          const stamp = await stampFeedTruthCategoryRef({
            brandId:      brand._id,
            advertiserId: brand.advertiserId || null,
            feedCategory: p.category,
            title:        p.title
          });
          if (stamp) categoryRefId = stamp.categoryId;
        } catch (err) {
          console.warn(`   ⚠️  ${LOG}  feed-truth category stamp failed for ${externalId}: ${err.message}`);
        }
      }

      const set = {
        advertiserId:     brand.advertiserId,
        brandId:          brand._id,
        // Honest stamp of the rung that produced this product — see
        // catalogSource above. Must be a CatalogProduct.source enum value.
        source:           catalogSource,
        externalId,
        itemGroupId:      externalId,
        title:            p.title || '(untitled)',
        description:      p.description || null,
        brand:            p.brand || brand.name || null,
        price:            Number.isFinite(p.price) ? p.price : null,
        currency:         p.currency || null,
        availability:     p.availability || null,
        imageUrl:         p.imageUrl || null,
        // p.additionalImages is ALREADY the alt list (hero is p.imageUrl),
        // so slice from 0 — not the hero-offset form used in the resolver.
        // Cap = MAX_ADDITIONAL_IMAGES (shared; see catalogImageLimits).
        additionalImages: Array.isArray(p.additionalImages)
          ? p.additionalImages.slice(0, MAX_ADDITIONAL_IMAGES)
          : [],
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
      }
      // categoryRef stamping is DELIBERATELY not part of the upsert
      // $set — applyFeedTruthStamp below handles insert/noop/rename
      // uniformly across every ingest path, with the null-guard that
      // preserves later inferred stamps (GPT-4.1 brand-nav) from
      // productMatchService. Setting it here would clobber those on
      // every re-sync.

      // Upsert only — no await on classify (image network work).
      const doc = await CatalogProduct.findOneAndUpdate(
        { brandId: brand._id, externalId },
        {
          $set: set,
          $setOnInsert: { firstSeenAt: new Date() }
        },
        { upsert: true, new: true }
      );
      productsUpserted += 1;
      persistedCount += 1;

      // Post-upsert category stamp. Two candidate stamps: the JSON-LD
      // scanner-derived leaf (categoryRefId, set at line 254) or the
      // feed-truth fallback from p.category. Prefer the scanner leaf
      // because it typically carries a richer breadcrumb than a
      // single-term product_type; fall back on the feed-truth stamp.
      // Either way, applyFeedTruthStamp handles the insert/rename/noop
      // decision.
      if (doc) {
        try {
          let stamp = categoryRefId
            ? { categoryId: categoryRefId, source: 'jsonld-scanner' }
            : (p.category
                ? await stampFeedTruthCategoryRef({
                    brandId:      brand._id,
                    advertiserId: brand.advertiserId || null,
                    feedCategory: p.category,
                    title:        p.title
                  })
                : null);
          const outcome = await applyFeedTruthStamp(doc, stamp);
          if (outcome.action === 'renamed' || outcome.action === 'rehomed-from-tombstone') {
            console.log(`   ↺ ${LOG}  category ${outcome.action} for ${externalId}: ${outcome.from} → ${outcome.to}`);
          }
        } catch (err) {
          console.warn(`   ⚠️  ${LOG}  category stamp failed for ${externalId}: ${err.message}`);
        }
      }

      if (p.productReviews && (p.productReviews.quotes?.length || p.productReviews.rating != null)) {
        reviewsCaptured += 1;
      }
      // Defer classify to post-loop pass — never block remaining upserts.
      if (doc && ingestShotClassify.isEnabled()) {
        pendingClassify.push({
          productId: doc._id,
          imageUrl: doc.imageUrl,
          additionalImages: doc.additionalImages,
          existingStyles: doc.imageShotStyles
        });
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

  // Post-loop classify pass — products already persisted.
  // Budget clock starts here (beginClassifyPhase), not at createSession.
  // Batched across products so the concurrency cap is used for 1-image
  // SKUs; cooperative cancel stops the wave and abandonPending-counts
  // remaining URLs (same signal the upsert loop honors).
  if (pendingClassify.length && ingestShotClassify.isEnabled()) {
    shotSession.beginClassifyPhase();
    await shotSession.classifyPendingProducts(pendingClassify, {
      isCancelled: async () => {
        // Same cancel signal the upsert loop honors (resolver cancel or
        // fresh mid-run abort). Re-read mutable `cancelled` each poll.
        if (cancelled || resolverCancelled) return true;
        try {
          if (await abortCheck(brand._id, run)) {
            cancelled = true;
            return true;
          }
        } catch (_) { /* ignore */ }
        return false;
      },
      onProduct: async (item, { entries, changed }) => {
        if (!changed) return;
        await CatalogProduct.updateOne(
          { _id: item.productId },
          { $set: { imageShotStyles: entries } }
        );
      }
    }).then((r) => {
      if (r && r.cancelled) cancelled = true;
    }).catch((shotErr) => {
      console.warn(`   ⚠️  ${LOG}  shot-classify batch failed: ${shotErr.message}`);
    });
  }

  // ── End-of-run trio (mirror shopifyPublicIngestService) ──
  // Use the cancel state established above (resolver signal or a fresh
  // mid-upsert cancel) — re-polling abortCheck here is unreliable once the
  // run handle has been closed by an earlier checkpoint().
  //
  // ROBUSTNESS (2026-08-19) — same fix as shopifyPublicIngestService.js's
  // end-of-run trio, same underlying bug. The enrichment + category-
  // inference triggers below used to fire via setImmediate(), which defers
  // ONE tick but does NOT keep the caller's process (or its Mongoose
  // connection) alive for that tick. A short-lived caller (a maintenance
  // script that connects -> syncs -> disconnects) can tear the connection
  // down before the deferred tick runs; the trigger then throws "Client
  // must be connected before running operations" silently, because both
  // call sites only console.warn on failure. Fix: call directly (no
  // setImmediate needed — an async function already yields to its caller
  // at its first await, so nothing here blocks this sync's own return) and
  // COLLECT the promises onto `out` so a caller that owns its own
  // connection lifecycle can await them before disconnecting. Declared
  // outside the guard so `out.backgroundWork` is always an array (empty on
  // a cancelled run). Every existing HTTP/executor caller ignores it.
  const backgroundWork = [];
  if (!cancelled) {
    try {
      const { enqueueBrandProductDetects } = require('./catalogProductDetectService');
      await enqueueBrandProductDetects(brand._id);
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  product-path detect enqueue failed: ${err.message}`);
      errors.push(`detect enqueue: ${err.message}`);
    }

    // See shopifyPublicIngestService.js's copy of this comment —
    // enqueueBrandProductDetects is a deliberate no-op under the detect
    // deferral, so nothing else materializes imageMediaId at sync time.
    // Idempotent (findActiveMaterializeDrain) — safe under retry/overlap.
    if (productsUpserted > 0) {
      require('./catalogMaterializeDrainService')
        .startCatalogMaterializeDrain({ brandId: brand._id, advertiserId: brand.advertiserId, label: 'Preparing catalog images (post-ingest)' })
        .catch(err => console.warn(`   ⚠️  ${LOG}  catalog materialize drain trigger failed: ${err.message}`));
    }

    backgroundWork.push(
      require('./catalogProductEnrichmentService')
        .enqueueBrandProductEnrichment(brand._id)
        .catch(err => console.warn(`   ⚠️  ${LOG}  catalog enrichment enqueue failed: ${err.message}`))
    );

    // Materialize + YOLO detect chain via the resilient orchestrator.
    // Wraps both phases in OperationRun(kind='catalog-post-sync') so a
    // transient failure (SIGTERM mid-work, yolo microservice outage,
    // Cloudinary rate-limit) leaves a persistent signal that worker.js
    // postSyncReconcileTick can retry. See catalogPostSyncOrchestrator.js
    // header for why the inline try/try version silently stranded brands.
    backgroundWork.push(
      require('./catalogPostSyncOrchestrator').runPostSyncChain(brand._id, { trigger: 'sync' })
    );

    backgroundWork.push((async () => {
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
    })());
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
    durationMs,
    // Awaitable by a caller that owns its own connection lifecycle (see the
    // ROBUSTNESS comment on the end-of-run trio above). Ignored — safely —
    // by every existing HTTP/executor caller.
    backgroundWork
  };
  if (cancelled) out.cancelled = true;
  if (partial) {
    out.partial = true;
    out.partialReason = partialReason || 'budget-exceeded';
  }
  // Propagate resolver budget reason so the Sales UI / OperationRun can
  // show "stopped after Xs (budget)" instead of a silent partial.
  if (access.budgetExpired && access.reason) {
    out.reason = out.reason || access.reason;
  }
  if (access.rateLimited && !productsUpserted) {
    out.ok = false;
    out.reason = access.reason || `rate-limited while scanning ${origin}`;
  }
  // Category options / "this catalog is large" prompt — only present when
  // the resolver attached them (flag on). apifyIngestService forwards
  // these onto out.shopify for the Sales UI.
  if (Array.isArray(access.categoryOptions) && access.categoryOptions.length) {
    out.categoryOptions = access.categoryOptions;
  }
  if (access.categoryPromptSuggested) {
    out.categoryPromptSuggested = true;
  }
  return out;
  } catch (err) {
    // Re-throw after finally marks abandoned pending when phase never started.
    throw err;
  } finally {
    // Unconditional summary — cancel, throw, and success all report.
    // Outstanding pending when classify never ran → abandoned (not considered=0).
    try {
      if (!shotSession.hasClassifyPhaseStarted() && pendingClassify.length) {
        shotSession.abandonPending(
          pendingClassify,
          cancelled ? 'cancelled' : 'phase_skipped'
        );
      }
    } catch (_) { /* ignore */ }
    try { shotSession.logSummary(`${LOG} shot-classify`); } catch (_) { /* ignore */ }
    try { shotSession.dispose(); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  syncBrandGenericCatalog
};
