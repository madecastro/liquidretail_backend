// Apify ingest — for demo Brands (Brand.isDemo=true, config in
// Brand.apifyDemo), pulls records via apifyPullService and hands them
// off to the same downstream code paths OAuth-connected Brands use.
//
// IG posts:      Cloudinary mirror → Media (source='apify-ig') → DetectRun
// Shopify prods: CatalogProduct upsert (source='apify-shopify') → product-
//                path detect enqueue (catalogProductDetectService)
//
// Neither path uses IntegrationCredential — Apify config lives directly
// on Brand.apifyDemo and the token is one shared APIFY_TOKEN in .env.

const Brand          = require('../models/Brand');
const Media          = require('../models/Media');
const DetectRun      = require('../models/DetectRun');
const CatalogProduct = require('../models/CatalogProduct');

const { pullInstagramPosts, pullShopifyProducts } = require('./apifyPullService');
const { uploadUrlToCloudinary } = require('./cloudinaryService');
// Zero-dep shared cap — see services/catalogImageLimits.js. Kept here as
// a top-level require (module has no deps) so this path never hard-codes
// a lower truncating ceiling than detect's MAX_ALT_IMAGES.
const { MAX_ADDITIONAL_IMAGES } = require('./catalogImageLimits');
// Free packshot/lifestyle classify at ingest (URL-keyed on CatalogProduct).
const ingestShotClassify = require('./ingestShotClassifyService');
const { stampFeedTruthCategoryRef, applyFeedTruthStamp } = require('./categoryClassifier');

const APIFY_TRIGGER = 'apify-sync';

// Orchestrator — runs whichever sub-syncs the brand has configured.
// Returns per-source summaries so the route response is easy to
// display in the Sales UI.
async function syncBrandApify(brandId) {
  const brand = await Brand.findById(brandId);
  if (!brand) {
    const e = new Error(`Brand ${brandId} not found`);
    e.status = 404;
    throw e;
  }
  if (!brand.isDemo) {
    const e = new Error(`Brand ${brandId} is not a demo brand — refusing Apify sync`);
    e.status = 400;
    throw e;
  }

  // Reset the abort flag at the start of every sync. Cooperative
  // cancellation: /abort flips this to true; the ingest loops re-read
  // it between records and bail when they see it.
  brand.apifyDemo.aborted = false;
  await brand.save();

  // Unified progress row — the generic /api/progress cancel and the
  // legacy /abort flag both stop the loops between records.
  const { startRun } = require('./progressService');
  const run = await startRun({ kind: 'demo-sync', advertiserId: brand.advertiserId, brandId: brand._id, label: 'Demo data sync' });

  const cfg = brand.apifyDemo || {};
  // Catalog source method: 'shopify-direct' (default) hits the public
  // products.json path; 'apify' keeps the legacy Apify shopify-scraper;
  // 'generic-sitemap' runs the client-agnostic XML-sitemap + schema.org
  // JSON-LD scraper for non-Shopify server-rendered stores (uses
  // cfg.shopifyUrl as the target). IG stays on Apify regardless (hybrid).
  const method = ['apify', 'generic-sitemap'].includes(cfg.method) ? cfg.method : 'shopify-direct';
  const out = { ok: true, brandId: String(brand._id), ig: null, shopify: null, method, _run: run };
  const t0 = Date.now();

  if (cfg.igHandle) {
    run.stage('instagram posts');
    try       { out.ig = await syncBrandInstagram(brand, run); }
    catch (err) { out.ig = { ok: false, reason: err.message }; }
  }
  // Check between the two sources too — an abort during IG shouldn't
  // fall through into Shopify.
  let stillAborted = await isBrandAborted(brand._id, run);
  if (cfg.shopifyUrl && !stillAborted) {
    run.stage('shopify catalog');
    try {
      if (method === 'generic-sitemap') {
        // Kill-switch: on by default (the method is already per-brand
        // opt-in); set GENERIC_CATALOG_ENABLED=false to hard-disable.
        if (process.env.GENERIC_CATALOG_ENABLED === 'false') {
          out.shopify = { ok: false, reason: 'generic-sitemap method is disabled (GENERIC_CATALOG_ENABLED=false)' };
        } else {
          const r = await require('./genericCatalogIngestService')
            .syncBrandGenericCatalog(brand, run, { isBrandAborted });
          out.shopify = {
            added:   r.productsUpserted,
            videos:  r.videosIngested || 0,
            reviews: r.reviewsCaptured || 0,
            errors:  (r.errors || []).length,
            // Surface a resolver-level failure reason (e.g. "site does not
            // expose XML sitemaps") so the Sales UI shows WHY nothing came
            // back, instead of a silent empty catalog.
            ...(r.ok === false ? { ok: false, reason: r.reason } : {}),
            // Category options from the sitemap walk (no PDP cost) so the
            // Sales UI can offer selective import on large catalogs.
            ...(Array.isArray(r.categoryOptions) && r.categoryOptions.length
              ? { categoryOptions: r.categoryOptions } : {}),
            ...(r.categoryPromptSuggested ? { categoryPromptSuggested: true } : {})
          };
          if (r.cancelled) stillAborted = true;
        }
      } else if (method === 'shopify-direct') {
        const r = await require('./shopifyPublicIngestService')
          .syncBrandShopifyDirect(brand, run, { isBrandAborted });
        out.shopify = {
          added:   r.productsUpserted,
          videos:  r.videosIngested,
          reviews: r.reviewsCaptured,
          errors:  r.errors.length
        };
        // Direct path signals cooperative cancel via r.cancelled —
        // mirror the isBrandAborted=true exit so lastSyncedAt +
        // markCancelled still stamp exactly as today.
        if (r.cancelled) stillAborted = true;
      } else {
        out.shopify = await syncBrandShopify(brand, run);
      }
    } catch (err) { out.shopify = { ok: false, reason: err.message }; }
  } else if (cfg.shopifyUrl && stillAborted) {
    out.shopify = { ok: false, reason: 'aborted before Shopify sync started' };
  }

  // lastSyncedAt stamp must not be able to strand the progress row —
  // a transient save failure would otherwise skip markCancelled/succeed
  // below and leave the run "in progress" forever in the dock.
  try {
    brand.apifyDemo.lastSyncedAt = new Date();
    await brand.save();
  } catch (err) {
    console.warn(`   ⚠️  lastSyncedAt stamp failed for brand=${brand._id} (non-fatal): ${err.message}`);
  }

  out.durationMs = Date.now() - t0;
  out.aborted    = stillAborted || (await isBrandAborted(brand._id, run));
  delete out._run;
  const summary = { ig: out.ig?.ingested ?? null, shopify: out.shopify?.added ?? null };
  // GENERIC_CATALOG_FAIL_ON_ZERO=false restores the prior two-line
  // if/else byte-identically (always succeed unless aborted). Default
  // true: a run that attempted sources and ingested nothing must not
  // report success — OperationRun.status is what every poller keys off.
  if (process.env.GENERIC_CATALOG_FAIL_ON_ZERO === 'false') {
    if (out.aborted) await run.markCancelled('Aborted — partial ingest kept');
    else await run.succeed(summary);
  } else {
    const { computeSyncOutcome } = require('./apifySyncOutcome');
    // Explicit zero predicates — null vs 0 vs undefined all count as zero.
    // shopify uses `added`; IG uses `ingested`. ok:false is decisive zero
    // even when a count field is missing.
    const shopifyAttempted = out.shopify != null;
    const igAttempted = out.ig != null;
    const shopifyZero = !out.shopify
      || out.shopify.ok === false
      || (out.shopify.added ?? 0) === 0;
    const igZero = !out.ig
      || out.ig.ok === false
      || (out.ig.ingested ?? 0) === 0;
    const outcome = computeSyncOutcome({
      shopifyAttempted,
      shopifyZero,
      igAttempted,
      igZero,
      aborted: out.aborted
    });
    if (outcome.status === 'cancelled') {
      await run.markCancelled('Aborted — partial ingest kept');
    } else if (outcome.status === 'failed') {
      // fail(err, meta) so a failed run still carries the per-source counts
      // — the case where an operator most needs diagnostics.
      await run.fail(new Error(outcome.reason || 'sync ingested nothing'), summary);
    } else {
      await run.succeed(summary);
    }
  }
  return out;
}

// Lean read of the abort flag. Called between records so /abort can
// take effect mid-loop without a full brand fetch. Also honors the
// generic OperationRun cancel when a run handle is provided.
async function isBrandAborted(brandId, run = null) {
  if (run) {
    // Prefer the NON-throwing, non-closing cancel read: run.checkpoint()
    // closes the handle on its first cancel observation, after which it
    // resolves (not rejects) and this check would wrongly report "not
    // aborted". isCancelRequested() keeps reporting the cancel reliably.
    if (typeof run.isCancelRequested === 'function' && run.isCancelRequested()) return true;
    const cancelled = await run.checkpoint().then(() => false).catch(() => true);
    if (cancelled) return true;
  }
  const b = await Brand.findById(brandId).select('apifyDemo.aborted').lean();
  return !!b?.apifyDemo?.aborted;
}

// ── IG side ────────────────────────────────────────────────────────
async function syncBrandInstagram(brand, run = null) {
  const t0 = Date.now();
  const handle = brand.apifyDemo?.igHandle;
  if (!handle) return { ok: false, reason: 'no IG handle configured' };

  console.log(`📸 Apify IG sync starting: brand=${brand._id} handle=@${handle}`);
  const posts = await pullInstagramPosts(handle);

  const summary = { ok: true, fetched: posts.length, ingested: 0, skipped: 0, errors: 0, queuedRunIds: [], aborted: false };

  for (const post of posts) {
    if (await isBrandAborted(brand._id, run)) {
      summary.aborted = true;
      console.log(`   · Apify IG ingest aborted mid-loop for brand=${brand._id}`);
      break;
    }
    try {
      const r = await ingestIgPost(brand, post);
      // runId can accompany a skipped result — resume-after-abort
      // re-enqueues detect for already-ingested media.
      if (r?.runId) summary.queuedRunIds.push(String(r.runId));
      if (r?.skipped) summary.skipped++;
      else if (r?.mediaId) summary.ingested++;
    } catch (err) {
      console.warn(`   ⚠️  Apify IG ingest failed for ${post.externalId}: ${err.message}`);
      summary.errors++;
    }
  }

  // Fire brand-level enrichment in the background so downstream ad
  // generation can pull brandReviews / voice / colors from Gemini +
  // Brandfetch. Non-blocking + idempotent (the service checks its own
  // cache TTL per tier). Called UNCONDITIONALLY — enrichBrandFromUrl
  // itself declines gracefully (and now RECORDS why on the brand doc,
  // enrichmentSkipReason/enrichmentSkippedAt) when websiteUrl is still
  // missing at this point (demo brands sometimes don't have one, and
  // this IG branch runs before the Shopify-catalog branch in
  // syncBrandApify, which is what would back-fill it). Previously this
  // was gated on `brand.websiteUrl` and the skip was a bare comment —
  // truly silent, since the guard meant enrichBrandFromUrl was never
  // even called to record anything.
  setImmediate(() => {
    require('./brandEnrichmentService')
      .enrichBrandFromUrl(brand._id)
      .catch(err => console.warn(`   ⚠️  brand enrichment enqueue failed: ${err.message}`));
  });

  summary.durationMs = Date.now() - t0;
  console.log(`📸 Apify IG sync done: brand=${brand._id} fetched=${summary.fetched} ingested=${summary.ingested} skipped=${summary.skipped} errors=${summary.errors} in ${summary.durationMs}ms`);
  return summary;
}

async function ingestIgPost(brand, post) {
  const { externalId, mediaType, mediaUrl, thumbnailUrl, permalink, caption, timestamp, ownerUsername, likeCount, commentsCount } = post;
  if (!externalId || !mediaUrl) return { skipped: true };

  // Idempotent: dedup on (brandId, source, externalId). Apify pulls of
  // the same handle are the natural re-sync case. Existing rows skip
  // the download/upload but MUST still fall through to the DetectRun
  // check below — an early return here made the documented
  // resume-after-abort path unreachable (aborted runs are marked
  // failed; re-sync is what re-queues detect for ingested media).
  const existing = await Media.findOne({ brandId: brand._id, source: 'apify-ig', externalId }).select('_id').lean();

  const isVideo = mediaType === 'VIDEO';
  const fileType = isVideo ? 'video' : 'image';

  let media;
  if (existing) {
    media = existing;
  } else {
  const upload = await uploadUrlToCloudinary(mediaUrl, {
    resourceType: isVideo ? 'video' : 'image',
    folder:       'apify-demo/ig'
  });

  try {
    media = await Media.findOneAndUpdate(
      { brandId: brand._id, source: 'apify-ig', externalId },
      {
        $setOnInsert: {
          advertiserId: brand.advertiserId,
          brandId:      brand._id,
          source:       'apify-ig',
          externalId,
          sourceUrl:    permalink,
          fileType,
          fileUrl:      upload.secure_url,
          fileMimeType: upload.format ? `${fileType}/${upload.format}` : null,
          fileName:     `apify_ig_${externalId}.${upload.format || (isVideo ? 'mp4' : 'jpg')}`,
          width:        upload.width || null,
          height:       upload.height || null,
          durationSec:  upload.duration || null,
          metadata: {
            brand:         brand.name,
            brandUrl:      brand.websiteUrl || null,
            caption,
            postedAt:      timestamp ? new Date(timestamp) : null,
            creatorHandle: ownerUsername,
            postType:      mediaType,
            permalink,
            thumbnailUrl,
            ingestedFrom:  'apify-ig-sync'
          },
          platformStats: {
            likes:     likeCount     != null ? likeCount     : undefined,
            comments:  commentsCount != null ? commentsCount : undefined,
            fetchedAt: new Date()
          },
          classification: { socialPostType: 'brand_produced' }
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err.code === 11000) return { skipped: true };
    throw err;
  }
  }

  // Skip enqueue only if there's an ACTIVE run (queued/processing/
  // completed). A run marked failed by /abort should NOT block a fresh
  // enqueue on the next sync — that's what makes "run off the index
  // on resume" work: the Media row is already ingested, and the next
  // sync re-enqueues detect for any Media whose prior run was killed.
  const existingActive = await DetectRun.findOne({
    mediaId: media._id,
    status:  { $in: ['queued', 'processing', 'completed'] }
  }).select('_id').lean();
  // skipped reflects INGESTION (media already existed) — a resumed post
  // can be skipped for counting yet still re-enqueue detect below.
  if (existingActive) return { mediaId: media._id, runId: null, skipped: !!existing };

  let run;
  try {
    run = await DetectRun.create({
      advertiserId: brand.advertiserId,
      brandId:      brand._id,
      mediaId:      media._id,
      status:       'queued',
      stage:        'queued',
      priority:     2,
      trigger:      APIFY_TRIGGER
    });
  } catch (err) {
    if (err.code === 11000) {
      const inflight = await DetectRun.findOne({ mediaId: media._id, status: { $in: ['queued', 'processing'] } }).lean();
      return { mediaId: media._id, runId: inflight?._id || null, skipped: !!existing };
    }
    throw err;
  }
  return { mediaId: media._id, runId: run._id, skipped: !!existing };
}

// ── Shopify side ───────────────────────────────────────────────────
async function syncBrandShopify(brand, run = null) {
  const t0 = Date.now();
  const shopifyUrl = brand.apifyDemo?.shopifyUrl;
  if (!shopifyUrl) return { ok: false, reason: 'no Shopify URL configured' };

  // Money + correctness guard, added after the Pelagic Gear incident: a
  // misconfigured apifyDemo.shopifyUrl pointed at za.pelagicgear.com (a real,
  // separate South-African Shopify store, currency ZAR) instead of the US
  // store. Apify's actor returned currency:"USD" for that store regardless of
  // its real currency, so every scraped price was a correct ZAR number
  // silently mislabeled USD (~19.97-19.99x too high once read as dollars —
  // that ratio is the live USD/ZAR rate, not a cents/dollars unit bug). This
  // is a FREE check (no Apify actor run) done BEFORE the paid pull below, so
  // a misconfigured brand fails fast without spending anything. Only a
  // POSITIVE, confirmed mismatch refuses the sync — see
  // shopifyAccessResolver.verifyStoreCurrencyUsd's header comment for why an
  // inconclusive check (network error, no currency field) must not block.
  const { verifyStoreCurrencyUsd } = require('./shopifyAccessResolver');
  const currencyCheck = await verifyStoreCurrencyUsd(shopifyUrl);
  if (currencyCheck.mismatch) {
    console.warn(`🛍  Apify Shopify sync REFUSED: brand=${brand._id} shop=${shopifyUrl} currency=${currencyCheck.currency} (expected USD) — see models/CatalogProduct.js price unit contract`);
    return {
      ok: false,
      reason: `store currency is ${currencyCheck.currency}, not USD — refusing to write CatalogProduct.price under the wrong currency (see models/CatalogProduct.js)`,
      currencyMismatch: true,
      detectedCurrency: currencyCheck.currency
    };
  }

  console.log(`🛍  Apify Shopify sync starting: brand=${brand._id} shop=${shopifyUrl}`);
  const products = await pullShopifyProducts(shopifyUrl);

  // websiteUrl back-fill — same hole as the shopify-direct/generic-sitemap
  // paths (services/brandWebsiteBackfill.js): this actor already resolved
  // and proved brand.apifyDemo.shopifyUrl by fetching real products from
  // it, but nothing ever copied it onto Brand.websiteUrl, so downstream
  // enrichment/logo/font ingest stayed starved forever. Gated on a
  // non-empty pull so a bad config can't poison websiteUrl.
  if (products.length > 0) {
    require('./brandWebsiteBackfill').backfillBrandWebsiteUrl(brand, shopifyUrl, { ingestSource: 'apify-shopify' }).catch(err =>
      console.warn(`   ⚠️  websiteUrl back-fill failed for brand=${brand._id}: ${err.message}`)
    );
  }

  const summary = { ok: true, fetched: products.length, added: 0, updated: 0, errors: 0, aborted: false };
  // ARCHITECTURE: upsert NEVER awaits image classify. Post-loop pass only.
  const shotSession = ingestShotClassify.createSession();
  const pendingClassify = [];
  try {
  for (const p of products) {
    if (await isBrandAborted(brand._id, run)) {
      summary.aborted = true;
      console.log(`   · Apify Shopify ingest aborted mid-loop for brand=${brand._id}`);
      break;
    }
    try {
      // Upsert only — no await on classify (image network work).
      const result = await CatalogProduct.findOneAndUpdate(
        { brandId: brand._id, externalId: p.externalId },
        {
          $set: {
            advertiserId:    brand.advertiserId,
            brandId:         brand._id,
            source:          'apify-shopify',
            externalId:      p.externalId,
            title:           p.title || '(untitled)',
            description:     p.description || null,
            brand:           p.brand || brand.name || null,
            price:           p.price,
            // Prefer the INDEPENDENTLY VERIFIED store currency over the
            // actor's own per-product field once we've confirmed it above —
            // the actor is not a reliable reporter of currency (it returned
            // "USD" for the ZAR Pelagic incident store). When the check was
            // inconclusive (currencyCheck.verified === false, mismatch ===
            // false), fall back to whatever the actor reported, same as
            // before this fix.
            currency:        currencyCheck.verified ? currencyCheck.currency : p.currency,
            availability:    p.availability,
            imageUrl:        p.imageUrl || null,
            // p.additionalImageUrls is ALREADY the alt list (hero is
            // p.imageUrl), so slice from 0 — not the hero-offset form used
            // on Shopify/JSON-LD combined arrays. Cap = MAX_ADDITIONAL_IMAGES
            // (shared; see catalogImageLimits). Upstream apifyPullService
            // returns images.slice(1) uncapped; this writer is the bound.
            additionalImages: Array.isArray(p.additionalImageUrls)
              ? p.additionalImageUrls.slice(0, MAX_ADDITIONAL_IMAGES)
              : [],
            productUrl:      p.productUrl || null,
            // Merchant-authored category string (Shopify product_type)
            // captured by the Apify normalizer. Feeds the categoryRef
            // stamp below and drives the /api/catalog list's raw-string
            // filter dropdown.
            category:        p.category || null,
            rawData:         p,
            lastSyncedAt:    new Date()
          },
          $setOnInsert: { firstSeenAt: new Date() }
        },
        { upsert: true, new: true, rawResult: true }
      );
      if (result?.lastErrorObject?.updatedExisting) summary.updated++;
      else                                           summary.added++;
      // Defer classify to post-loop pass — never block remaining upserts.
      const row = result?.value || result;

      // Stamp / restamp categoryRef via applyFeedTruthStamp — handles
      // insert (fresh row), noop (ref matches), and rename (merchant
      // renamed product_type between syncs). Best-effort.
      if (row) {
        try {
          const stamp = await stampFeedTruthCategoryRef({
            brandId:      brand._id,
            advertiserId: brand.advertiserId,
            feedCategory: p.category,
            title:        p.title
          });
          const outcome = await applyFeedTruthStamp(row, stamp);
          if (outcome.action === 'renamed' || outcome.action === 'rehomed-from-tombstone') {
            console.log(`   ↺ Apify Shopify category ${outcome.action} for ${p.externalId}: ${outcome.from} → ${outcome.to}`);
          }
        } catch (err) {
          console.warn(`   ⚠️  Apify Shopify category stamp failed for ${p.externalId}: ${err.message}`);
        }
      }

      if (row && ingestShotClassify.isEnabled()) {
        pendingClassify.push({
          productId: row._id,
          imageUrl: row.imageUrl,
          additionalImages: row.additionalImages,
          existingStyles: row.imageShotStyles
        });
      }
    } catch (err) {
      console.warn(`   ⚠️  Apify Shopify upsert failed for ${p.externalId}: ${err.message}`);
      summary.errors++;
    }
  }

  // Post-loop classify pass — products already persisted.
  // Budget clock starts here (beginClassifyPhase), not at createSession.
  // Batched across products so the concurrency cap is used; cooperative
  // cancel (same isBrandAborted as the upsert loop) stops promptly and
  // records outstanding URLs as skippedAbandoned.
  if (pendingClassify.length && ingestShotClassify.isEnabled()) {
    shotSession.beginClassifyPhase();
    await shotSession.classifyPendingProducts(pendingClassify, {
      isCancelled: async () => {
        if (summary.aborted) return true;
        try { return !!(await isBrandAborted(brand._id, run)); } catch (_) { return false; }
      },
      onProduct: async (item, { entries, changed }) => {
        if (!changed) return;
        await CatalogProduct.updateOne(
          { _id: item.productId },
          { $set: { imageShotStyles: entries } }
        );
      }
    }).then((r) => {
      if (r && r.cancelled) summary.aborted = true;
    }).catch((shotErr) => {
      console.warn(`   ⚠️  Apify shot-classify batch failed: ${shotErr.message}`);
    });
  }

  // Fire product-path detect for any newly imported products with images.
  // Same helper the Meta catalog sync uses at end of run. Skipped if
  // /abort fired — no point queueing detect for a run the operator
  // just killed.
  if (!summary.aborted && !(await isBrandAborted(brand._id, run))) {
    try {
      const { enqueueBrandProductDetects } = require('./catalogProductDetectService');
      await enqueueBrandProductDetects(brand._id);
    } catch (err) {
      console.warn(`   ⚠️  product-path detect enqueue failed: ${err.message}`);
    }

    // See shopifyPublicIngestService.js's copy of this comment —
    // enqueueBrandProductDetects is a deliberate no-op under the detect
    // deferral, so nothing else materializes imageMediaId at sync time.
    // Idempotent (findActiveMaterializeDrain) — safe under retry/overlap.
    if ((summary.added + summary.updated) > 0) {
      require('./catalogMaterializeDrainService')
        .startCatalogMaterializeDrain({ brandId: brand._id, advertiserId: brand.advertiserId, label: 'Preparing catalog images (post-ingest)' })
        .catch(err => console.warn(`   ⚠️  catalog materialize drain trigger failed: ${err.message}`));
    }

    // Fire catalog enrichment in the background — matches what
    // catalogSyncService does after Meta catalog sync completes.
    // Populates CatalogProduct.productReviews.quotes + productDetails
    // (rating, sellers, specs) via Gemini + SerpAPI. Idempotent: the
    // enrichment service skips products already fresh in its 30-day
    // cache, so re-syncs are effectively free.
    // Enrichment leads with the free on-site review scrape
    // (productReviewsScrapeService) before any paid lookup — the Apify
    // actor returns no review data at all, so that scrape is where this
    // path's first-party reviews and ratings come from.
    setImmediate(() => {
      require('./catalogProductEnrichmentService')
        .enqueueBrandProductEnrichment(brand._id)
        .catch(err => console.warn(`   ⚠️  catalog enrichment enqueue failed: ${err.message}`));
    });
  }

  summary.durationMs = Date.now() - t0;
  console.log(`🛍  Apify Shopify sync done: brand=${brand._id} fetched=${summary.fetched} added=${summary.added} updated=${summary.updated} errors=${summary.errors} in ${summary.durationMs}ms`);
  return summary;
  } catch (err) {
    throw err;
  } finally {
    // Unconditional summary — abort, throw, and success all report.
    // Outstanding pending when classify never ran → abandoned (not considered=0).
    try {
      if (!shotSession.hasClassifyPhaseStarted() && pendingClassify.length) {
        shotSession.abandonPending(
          pendingClassify,
          summary.aborted ? 'cancelled' : 'phase_skipped'
        );
      }
    } catch (_) { /* ignore */ }
    try { shotSession.logSummary('🛍 apify shot-classify'); } catch (_) { /* ignore */ }
    try { shotSession.dispose(); } catch (_) { /* ignore */ }
  }
}

// ── Apify comment ingest ─────────────────────────────────────────────
// Comment refresh for apify-ig Media rows. Reuses apify/instagram-
// scraper with resultsType='comments'; upserts Comment docs by
// (mediaId, externalId) — same idempotency shape mediaInsightsService
// uses for OAuth-sourced Media. Runs one Apify sync-run per post so
// per-post progress is checkpointable; concurrency capped modest
// because each run is billed separately.
//
// PROVENANCE: sets Comment.source = 'instagram' (the platform),
// distinct from Media.source = 'apify-ig' (the ingest path). Comments
// don't carry an "ingest path" field — the mediaId reference identifies
// where the parent came from if a consumer needs it.
async function syncBrandInstagramCommentsApify(brandId, { concurrency = 2 } = {}) {
  const Comment = require('../models/Comment');
  const { pullInstagramComments } = require('./apifyPullService');

  const brand = await Brand.findById(brandId).select('_id name advertiserId').lean();
  if (!brand) {
    const e = new Error(`Brand ${brandId} not found`);
    e.status = 404;
    throw e;
  }

  // Target: every apify-ig Media on the brand with a permalink we can
  // hand to Apify. Skip catalog-product wrappers + soft-deleted.
  const targets = await Media.find({
    brandId: brand._id,
    source: 'apify-ig',
    deletedAt: null,
    'metadata.permalink': { $exists: true, $ne: null }
  })
    .select('_id metadata.permalink externalId')
    .lean();

  if (!targets.length) {
    return { ok: true, brandId: String(brand._id), total: 0, note: 'no apify-ig media with a permalink' };
  }

  const perStep = [];
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const idx = cursor++;
      const media = targets[idx];
      const t0 = Date.now();
      try {
        const comments = await pullInstagramComments(media.metadata.permalink, {});
        let upserted = 0;
        for (const c of comments) {
          const res = await Comment.updateOne(
            { mediaId: media._id, externalId: c.externalId },
            {
              $set: {
                text:             c.text,
                authorUsername:   c.authorUsername,
                authorId:         c.authorId,
                likeCount:        c.likeCount,
                replyCount:       c.replyCount,
                postedAt:         c.postedAt,
                parentExternalId: c.parentExternalId,
                fetchedAt:        new Date()
              },
              $setOnInsert: {
                mediaId:      media._id,
                brandId:      brand._id,
                advertiserId: brand.advertiserId,
                source:       'instagram',
                externalId:   c.externalId
              }
            },
            { upsert: true }
          );
          if (res.upsertedCount || res.modifiedCount) upserted++;
        }
        perStep.push({
          ok: true,
          mediaId: String(media._id),
          fetched: comments.length,
          upserted,
          tookMs: Date.now() - t0
        });
      } catch (err) {
        perStep.push({
          ok: false,
          mediaId: String(media._id),
          reason: err.message,
          tookMs: Date.now() - t0
        });
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, targets.length) },
    () => worker()
  );
  await Promise.all(workers);

  const succeeded = perStep.filter((r) => r.ok).length;
  const failed    = perStep.filter((r) => !r.ok).length;
  const totalFetched  = perStep.reduce((s, r) => s + (r.fetched  || 0), 0);
  const totalUpserted = perStep.reduce((s, r) => s + (r.upserted || 0), 0);

  return {
    ok: true,
    brandId: String(brand._id),
    total: targets.length,
    succeeded,
    failed,
    fetched: totalFetched,
    upserted: totalUpserted,
    perStep
  };
}

module.exports = {
  syncBrandApify,
  syncDemoBrand: syncBrandApify, // alias — method-aware orchestrator
  syncBrandInstagram,
  syncBrandInstagramCommentsApify,
  syncBrandShopify,
  isBrandAborted
};
