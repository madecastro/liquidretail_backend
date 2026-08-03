// services/shopifyPublicIngestService.js
//
// Free, Apify-less Shopify catalog ingester for the sales-demo tool.
// Hits Shopify's documented public storefront endpoints directly —
// no private app token, no Apify actor.
//
// Endpoints used:
//   1. GET {store}/products.json?limit=250&page=N
//        Bulk catalog. price is a STRING decimal ("19.99"). tags is an
//        ARRAY. No currency field (leave null). No videos.
//   2. GET {store}/products/{handle}.js
//        AJAX product payload. price is INTEGER CENTS (do NOT reuse for
//        CatalogProduct.price — we already wrote the decimal from #1).
//        media[] carries video / external_video entries on OS 2.0 themes.
//   3. GET {store}/products/{handle}  (HTML)
//        JSON-LD blocks (application/ld+json) for aggregateRating + review[]
//        injected by review apps (judge.me, yotpo, loox, stamped, okendo).
//
// Rate-limit posture (empirically verified):
//   Shopify's Cloudflare edge 429s penalized datacenter/cloud IPs and the
//   bucket may never clear. We honor Retry-After up to 3 times (cap 90s),
//   pace ≥400ms between requests, concurrency 1, detect CF challenge HTML,
//   and on persistent 429/403 fail the run with a clear note while keeping
//   already-ingested partials. Live e2e runs from production egress — dev
//   containers are 429-blocked. Ship scripts/probeShopifyStore.js as the
//   operator diagnostic.
//
// Gotchas from the endpoint shapes:
//   - products.json price = STRING decimal; /products/{handle}.js price = cents
//   - products.json tags = ARRAY; /products/{handle}.json tags = comma STRING
//   - no currency anywhere on the public endpoints → currency: null
//   - video duration is MILLISECONDS on the AJAX media entry

const CatalogProduct = require('../models/CatalogProduct');
const Media          = require('../models/Media');
const { cleanScrapedText, decodeHtmlEntities, tidyText } = require('../utils/htmlEntities');
// Shared on-page review/rating engine. Owns platform detection + review
// extraction for every ingest path; this service keeps its own polite
// fetch loop and hands the HTML over.
const reviewsEngine = require('./productReviewsScrapeService');

// ── constants ──────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 20_000;
const PACE_MS            = 400;
const MAX_RETRIES_429    = 3;
const MAX_RETRY_AFTER_S  = 90;
const MAX_VIDEO_BYTES    = 20 * 1024 * 1024; // 20 MB
const DEFAULT_PRODUCT_CAP = 200;

// ── helpers ────────────────────────────────────────────────────────

// Normalize gtin to a clean digit string. Copied from catalogSyncService
// so cross-source lookups match regardless of formatting.
function normalizeGtin(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).trim().replace(/[^\d]/g, '');
  // Valid GTINs are 8/12/13/14 digits (UPC-A/E, EAN-13, ITF-14).
  // Reject anything outside that range — likely junk.
  if (![8, 12, 13, 14].includes(cleaned.length)) return null;
  return cleaned;
}

// Strip HTML tags → plain text, collapse whitespace, truncate.
//
// Entity decoding is delegated to utils/htmlEntities so NUMERIC references
// are handled too — the hand-rolled list here only covered five named ones,
// which left `&#x2B;` / `&#34;` / `&#8221;` (all common in furniture
// catalogs) sitting raw in descriptions.
//
// Two tag-strip passes around ONE decode pass: sites that escape their
// JSON-LD ship the description as encoded markup ("&lt;div&gt;Introducing
// the Austen Black 74&quot; …"), which is only strippable after decoding.
// Decoding twice is what we must avoid, not stripping twice.
function stripHtml(html, maxLen = 2000) {
  if (!html) return null;
  const decoded = decodeHtmlEntities(String(html).replace(/<[^>]*>/g, ' '));
  return tidyText(decoded.replace(/<[^>]*>/g, ' '), maxLen);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isCloudflareChallenge(status, bodyText) {
  if (status === 403 || status === 503) {
    // fall through to body check
  }
  if (typeof bodyText !== 'string') return false;
  if (/<title[^>]*>\s*Just a moment/i.test(bodyText)) return true;
  if (/cf-challenge|cdn-cgi\/challenge|cf-browser-verification/i.test(bodyText)) return true;
  return false;
}

// Resolve the store origin from brand.apifyDemo.shopifyUrl (or similar).
// Accepts "https://foo.com", "foo.com", "https://foo.com/", etc.
function resolveStoreOrigin(brand) {
  const raw = brand?.apifyDemo?.shopifyUrl || brand?.shopifyUrl || brand?.websiteUrl;
  if (!raw) return null;
  let s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.origin;
  } catch {
    return null;
  }
}

// Polite fetch: UA, 20s timeout, ≥400ms pacing (caller spaces calls),
// honor 429 Retry-After up to 3× (cap 90s), CF-challenge detection.
// Throws on persistent rate-limit with a clear message so the run can
// keep partials and surface the note to the operator.
async function politeFetch(url, { asText = false, asBuffer = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Accept': asText ? 'text/html,application/xhtml+xml,*/*;q=0.8' : 'application/json,text/javascript,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: ctrl.signal,
        redirect: 'follow'
      });

      // Rate limited — honor Retry-After bounded.
      if (res.status === 429 || res.status === 403) {
        const bodyPreview = await res.text().catch(() => '');
        if (isCloudflareChallenge(res.status, bodyPreview)) {
          throw new Error('store rate-limited this server');
        }
        if (res.status === 429) {
          if (attempt >= MAX_RETRIES_429) {
            throw new Error('store rate-limited this server');
          }
          const ra = parseInt(res.headers.get('retry-after') || '60', 10);
          const waitS = Math.min(Number.isFinite(ra) && ra > 0 ? ra : 60, MAX_RETRY_AFTER_S);
          console.warn(`   ⚠️  🛍  429 on ${url} — waiting ${waitS}s (attempt ${attempt + 1}/${MAX_RETRIES_429})`);
          await sleep(waitS * 1000);
          continue;
        }
        // bare 403 without CF markers — treat as rate-limit too
        throw new Error('store rate-limited this server');
      }

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }

      // Optional content-length guard for video downloads.
      if (asBuffer) {
        const cl = parseInt(res.headers.get('content-length') || '0', 10);
        if (cl > MAX_VIDEO_BYTES) {
          throw new Error(`video too large (${cl} bytes > ${MAX_VIDEO_BYTES})`);
        }
        const ab = await res.arrayBuffer();
        if (ab.byteLength > MAX_VIDEO_BYTES) {
          throw new Error(`video too large (${ab.byteLength} bytes > ${MAX_VIDEO_BYTES})`);
        }
        return Buffer.from(ab);
      }

      const text = await res.text();
      if (isCloudflareChallenge(res.status, text)) {
        throw new Error('store rate-limited this server');
      }
      if (asText) return text;
      try {
        return JSON.parse(text);
      } catch (e) {
        const err = new Error(`JSON parse failed for ${url}: ${e.message}`);
        err.body = text;
        throw err;
      }
    } catch (err) {
      if (err.message === 'store rate-limited this server') throw err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms for ${url}`);
      } else {
        lastErr = err;
      }
      // Network blip — one soft retry then surface.
      if (attempt >= MAX_RETRIES_429) throw lastErr;
      await sleep(PACE_MS * 2);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`fetch failed for ${url}`);
}

async function pace() {
  await sleep(PACE_MS);
}

// ── main export ────────────────────────────────────────────────────

/**
 * syncBrandShopifyDirect(brand, run, { isBrandAborted })
 *
 * brand  – hydrated Brand doc (needs _id, advertiserId, name, apifyDemo.shopifyUrl)
 * run    – progressService run handle (stage/tick/checkpoint)
 * opts.isBrandAborted(brandId, run) – cooperative-cancel helper (same
 *   signature as apifyIngestService.isBrandAborted)
 *
 * Returns { productsUpserted, videosIngested, reviewsCaptured, errors: [], cancelled?: true }
 */
async function syncBrandShopifyDirect(brand, run, { isBrandAborted } = {}) {
  const t0 = Date.now();
  const errors = [];
  let productsUpserted = 0;
  let videosIngested   = 0;
  let reviewsCaptured  = 0;

  const abortCheck = typeof isBrandAborted === 'function'
    ? isBrandAborted
    : async () => false;

  let origin = resolveStoreOrigin(brand);
  if (!origin) {
    return {
      productsUpserted: 0,
      videosIngested: 0,
      reviewsCaptured: 0,
      errors: ['no shopifyUrl configured on brand'],
      ok: false,
      reason: 'no shopifyUrl configured on brand'
    };
  }

  const CAP = Math.max(1, parseInt(process.env.SHOPIFY_DIRECT_LIMIT, 10) || DEFAULT_PRODUCT_CAP);

  console.log(`🛍  Shopify-direct sync starting: brand=${brand._id} store=${origin} cap=${CAP}`);

  // ── Stage 1: acquire the catalog via the resolver ladder ─────────
  // resolveShopifyAccess tries, cheapest first: primary products.json →
  // myshopify-backend discovery (for HEADLESS Hydrogen/Next/Remix stores
  // whose custom domain doesn't serve products.json) → tokenless
  // Storefront GraphQL → sitemap. It returns products in the products.json
  // item shape PLUS the EFFECTIVE origin (the myshopify backend when the
  // storefront is headless) that the media/review stages below fetch
  // against. Layer 4 — the flag-gated headless-render fallback
  // (headlessScrapeService, SHOPIFY_HEADLESS_RENDER=true) — is the last
  // resort when every HTTP rung is Cloudflare-blocked or JS-only.
  run?.stage?.('resolving catalog access');
  // Bind the abort check to this brand/run so it fires inside the
  // resolver/headless loops (they call abortCheck() with no args).
  const boundAbort = () => abortCheck(brand._id, run);

  const { resolveShopifyAccess } = require('./shopifyAccessResolver');
  let access;
  try {
    access = await resolveShopifyAccess(brand, { run, abortCheck: boundAbort, cap: CAP });
  } catch (err) {
    errors.push(`access resolver: ${err.message}`);
    access = { ok: false, mode: null, products: [], origin, reason: err.message };
  }

  // Last-resort headless render (default OFF; SHOPIFY_HEADLESS_RENDER=true).
  if ((!access.ok || !(access.products || []).length) && !(await boundAbort())) {
    try {
      const headless = require('./headlessScrapeService');
      if (typeof headless.syncViaHeadless === 'function') {
        run?.note?.('all HTTP rungs empty — trying headless render');
        const hres = await headless.syncViaHeadless(brand, { run, abortCheck: boundAbort, cap: CAP });
        if (hres && hres.ok && (hres.products || []).length) access = hres;
        else if (hres?.reason) errors.push(`headless: ${hres.reason}`);
      }
    } catch (err) {
      errors.push(`headless render: ${err.message}`);
    }
  }

  // Abort could have landed during resolution — honor it before persisting.
  if (await boundAbort()) {
    console.log(`   · 🛍  aborted during catalog resolution for brand=${brand._id}`);
    return { productsUpserted, videosIngested, reviewsCaptured, errors, cancelled: true, durationMs: Date.now() - t0 };
  }

  const products = (access.products || []).slice(0, CAP);
  if (access.origin) origin = access.origin;   // effective backend (myshopify for headless)
  const totalPlanned = products.length || CAP;
  const hitRateLimit = !!access.rateLimited;
  if (access.reason && !products.length) errors.push(access.reason);
  run?.tick?.(0, totalPlanned, `resolved ${products.length} products via ${access.mode || 'none'}`);
  console.log(`🛍  resolved ${products.length} products via ${access.mode || 'none'} (origin=${origin}${access.discoveredMyshopify ? `, backend=${access.discoveredMyshopify}` : ''})`);

  // ── Upsert each product ──────────────────────────────────────────
  let idx = 0;
  for (const p of products) {
    idx += 1;
    if (await abortCheck(brand._id, run)) {
      console.log(`   · 🛍  aborted mid-upsert for brand=${brand._id}`);
      return {
        productsUpserted,
        videosIngested,
        reviewsCaptured,
        errors,
        cancelled: true,
        durationMs: Date.now() - t0
      };
    }
    if (run?.checkpoint) await run.checkpoint();

    try {
      const externalId = String(p.id);
      const variants = Array.isArray(p.variants) ? p.variants : [];
      const images   = Array.isArray(p.images)   ? p.images   : [];
      const v0 = variants[0] || {};

      const price = v0.price != null && v0.price !== ''
        ? Number(v0.price)
        : null;
      const availability = variants.some(v => v && v.available)
        ? 'in stock'
        : 'out of stock';
      const imageUrl = images[0]?.src || null;
      const additionalImages = images.slice(1, 9).map(i => i.src).filter(Boolean);
      const productUrl = `${origin}/products/${p.handle}`;
      const description = stripHtml(p.body_html, 2000);

      await CatalogProduct.findOneAndUpdate(
        { brandId: brand._id, externalId },
        {
          $set: {
            advertiserId:     brand.advertiserId,
            brandId:          brand._id,
            source:           'shopify-direct',
            externalId,
            itemGroupId:      externalId,
            // Decoded for the same reason as the generic path: the headless
            // fallback feeds this shape from JSON-LD, and merchants
            // sometimes type entities straight into a Shopify title.
            title:            cleanScrapedText(p.title) || '(untitled)',
            description,
            brand:            cleanScrapedText(p.vendor) || brand.name || null,
            price:            Number.isFinite(price) ? price : null,
            currency:         null,
            availability,
            imageUrl,
            additionalImages,
            productUrl,
            gtin:             normalizeGtin(v0.barcode),
            mpn:              v0.sku || null,
            category:         cleanScrapedText(p.product_type),
            rawData:          p,
            lastSyncedAt:     new Date()
          },
          $setOnInsert: { firstSeenAt: new Date() }
        },
        { upsert: true, new: true }
      );
      productsUpserted += 1;
    } catch (err) {
      console.warn(`   ⚠️  🛍  upsert failed for ${p?.id}: ${err.message}`);
      errors.push(`upsert ${p?.id}: ${err.message}`);
    }

    run?.tick?.(
      idx,
      totalPlanned,
      `products ${idx}/${totalPlanned} · ${videosIngested} videos · ${reviewsCaptured} reviews`
    );
  }

  if (hitRateLimit && !products.length) {
    // Nothing ingested and we're blocked — surface clearly.
    return {
      productsUpserted,
      videosIngested,
      reviewsCaptured,
      errors,
      ok: false,
      reason: 'store rate-limited this server — partials kept; try the Apify method',
      durationMs: Date.now() - t0
    };
  }

  // ── Stage 2: product media & videos ──────────────────────────────
  run?.stage?.('product media & videos');
  const cloudinaryService = require('./cloudinaryService');

  for (let i = 0; i < products.length; i++) {
    if (i > 0 && i % 5 === 0) {
      if (await abortCheck(brand._id, run)) {
        console.log(`   · 🛍  aborted during media stage for brand=${brand._id}`);
        return {
          productsUpserted,
          videosIngested,
          reviewsCaptured,
          errors,
          cancelled: true,
          durationMs: Date.now() - t0
        };
      }
      if (run?.checkpoint) await run.checkpoint();
    }

    const p = products[i];
    const hasStorefrontVideos = Array.isArray(p?._storefrontVideos) && p._storefrontVideos.length > 0;
    if (!p?.handle && !hasStorefrontVideos) continue;

    let mediaArr;
    if (hasStorefrontVideos) {
      // Storefront-GraphQL rung already returned hosted video sources —
      // use them directly, no extra <handle>.js round-trip.
      mediaArr = p._storefrontVideos.map(v => ({
        id:           v.id,
        media_type:   'video',
        duration:     v.duration ?? null,
        aspect_ratio: v.aspect_ratio ?? null,
        sources:      Array.isArray(v.sources) ? v.sources : []
      }));
    } else {
      let ajax;
      try {
        await pace();
        ajax = await politeFetch(`${origin}/products/${encodeURIComponent(p.handle)}.js`);
      } catch (err) {
        if (err.message === 'store rate-limited this server') {
          errors.push(`media stage rate-limited at handle=${p.handle}`);
          console.warn(`   ⚠️  🛍  ${err.message} during media stage — skipping remaining videos`);
          break;
        }
        // 404 / parse-fail → skip silently, count error.
        if (err.status === 404) continue;
        errors.push(`products/${p.handle}.js: ${err.message}`);
        continue;
      }
      mediaArr = Array.isArray(ajax?.media) ? ajax.media : [];
    }
    // external_video → metadata-only note on the product rawData (no mirror).
    const externalVideos = mediaArr.filter(m => m && m.media_type === 'external_video');
    if (externalVideos.length) {
      try {
        await CatalogProduct.updateOne(
          { brandId: brand._id, externalId: String(p.id) },
          {
            $set: {
              'rawData._externalVideos': externalVideos.map(m => ({
                host: m.host || null,
                externalId: m.external_id || null,
                mediaId: m.id || null
              }))
            }
          }
        );
      } catch (err) {
        // best-effort note
        errors.push(`external_video note ${p.id}: ${err.message}`);
      }
    }

    const videoEntries = mediaArr.filter(m => m && m.media_type === 'video');
    for (const media of videoEntries) {
      try {
        const sources = Array.isArray(media.sources) ? media.sources : [];
        // Prefer mp4 with largest width; skip m3u8/mov.
        const mp4s = sources.filter(s => s && s.format === 'mp4' && s.url);
        if (!mp4s.length) continue;
        mp4s.sort((a, b) => (b.width || 0) - (a.width || 0));
        const best = mp4s[0];

        // Idempotency: the Media row is $setOnInsert-only, so a re-sync
        // that re-downloaded + re-uploaded would orphan a fresh
        // Cloudinary asset every run AND inflate videosIngested
        // (adversarial-review find). Skip before spending bandwidth.
        const already = await Media.findOne({
          brandId: brand._id, source: 'catalog-product',
          externalId: `cp_${p.id}_video_${media.id}`
        }).select('_id').lean();
        if (already) continue;

        await pace();
        let buf;
        try {
          buf = await politeFetch(best.url, { asBuffer: true });
        } catch (err) {
          console.warn(`   ⚠️  🛍  video download failed ${p.handle}/${media.id}: ${err.message}`);
          errors.push(`video download ${p.id}/${media.id}: ${err.message}`);
          continue;
        }

        let upload;
        try {
          // cloudinaryService.uploadBufferToCloudinary(buffer, opts) —
          // same call shape as brandFontIngestService / materializeImage.
          upload = await cloudinaryService.uploadBufferToCloudinary(buf, {
            folder: 'shopify-direct/videos',
            resourceType: 'video'
          });
        } catch (err) {
          console.warn(`   ⚠️  🛍  cloudinary video upload failed ${p.handle}/${media.id}: ${err.message}`);
          errors.push(`video upload ${p.id}/${media.id}: ${err.message}`);
          continue;
        }

        const secureUrl = upload?.secure_url || upload?.url;
        if (!secureUrl) {
          errors.push(`video upload ${p.id}/${media.id}: no secure_url returned`);
          continue;
        }

        const externalId = `cp_${p.id}_video_${media.id}`;
        try {
          await Media.findOneAndUpdate(
            { brandId: brand._id, source: 'catalog-product', externalId },
            {
              $setOnInsert: {
                advertiserId: brand.advertiserId,
                brandId:      brand._id,
                source:       'catalog-product',
                externalId,
                fileType:     'video',
                fileUrl:      secureUrl,
                sourceUrl:    best.url,
                metadata: {
                  catalogProductId: null, // filled below if we can resolve
                  imageRole:        'video',
                  brand:            brand.name || null,
                  productTitle:     p.title || ajax?.title || null,
                  durationMs:       media.duration ?? null,
                  aspectRatio:      media.aspect_ratio ?? null,
                  ingestedFrom:     'shopify-direct'
                }
              }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );

          // Stamp catalogProductId from the upserted CatalogProduct when present.
          try {
            const cp = await CatalogProduct.findOne({ brandId: brand._id, externalId: String(p.id) })
              .select('_id').lean();
            if (cp?._id) {
              await Media.updateOne(
                { brandId: brand._id, source: 'catalog-product', externalId },
                { $set: { 'metadata.catalogProductId': cp._id } }
              );
            }
          } catch (_) { /* best-effort */ }

          videosIngested += 1;
        } catch (err) {
          if (err.code !== 11000) {
            console.warn(`   ⚠️  🛍  Media upsert failed for video ${p.id}/${media.id}: ${err.message}`);
            errors.push(`video media ${p.id}/${media.id}: ${err.message}`);
          }
        }
      } catch (err) {
        console.warn(`   ⚠️  🛍  video handle failed ${p.handle}/${media?.id}: ${err.message}`);
        errors.push(`video ${p.id}/${media?.id}: ${err.message}`);
      }
    }

    run?.tick?.(
      i + 1,
      products.length,
      `products ${i + 1}/${products.length} · ${videosIngested} videos · ${reviewsCaptured} reviews`
    );
  }

  // ── Stage 3: reviews & ratings (JSON-LD on product HTML) ─────────
  run?.stage?.('reviews & ratings');

  for (let i = 0; i < products.length; i++) {
    if (i > 0 && i % 5 === 0) {
      if (await abortCheck(brand._id, run)) {
        console.log(`   · 🛍  aborted during reviews stage for brand=${brand._id}`);
        return {
          productsUpserted,
          videosIngested,
          reviewsCaptured,
          errors,
          cancelled: true,
          durationMs: Date.now() - t0
        };
      }
      if (run?.checkpoint) await run.checkpoint();
    }

    const p = products[i];
    if (!p?.handle) continue;

    let html;
    try {
      await pace();
      html = await politeFetch(`${origin}/products/${encodeURIComponent(p.handle)}`, { asText: true });
    } catch (err) {
      if (err.message === 'store rate-limited this server') {
        errors.push(`reviews stage rate-limited at handle=${p.handle}`);
        console.warn(`   ⚠️  🛍  ${err.message} during reviews stage — skipping remaining reviews`);
        break;
      }
      if (err.status === 404) continue;
      errors.push(`product HTML ${p.handle}: ${err.message}`);
      continue;
    }

    try {
      // Shared engine (services/productReviewsScrapeService) — captures
      // per-review stars/headline/date and ranks positives first, and is
      // the same extractor the sitemap + Meta-catalog paths run.
      const rev = reviewsEngine.extractOnPageReviews(html);
      const productReviews = reviewsEngine.buildProductReviews(rev);

      if (productReviews) {
        const $set = { productReviews };
        if (productReviews.rating != null) $set.rating = productReviews.rating;

        await CatalogProduct.updateOne(
          { brandId: brand._id, externalId: String(p.id) },
          { $set }
        );
        reviewsCaptured += 1;
      } else if (rev.platform) {
        // Widget present but nothing structured to read — the store has
        // its review app's rich snippets turned off. Worth a log line:
        // it's the difference between "no reviews" and "reviews we can't
        // see", and it's the case a headless render would recover.
        console.log(`   · 🛍  ${p.handle}: ${rev.platform} widget detected, no structured reviews on page`);
      }
    } catch (err) {
      console.warn(`   ⚠️  🛍  review parse failed for ${p.handle}: ${err.message}`);
      errors.push(`reviews ${p.id}: ${err.message}`);
    }

    run?.tick?.(
      i + 1,
      products.length,
      `products ${i + 1}/${products.length} · ${videosIngested} videos · ${reviewsCaptured} reviews`
    );
  }

  // ── End-of-run trio (same as catalogSyncService ~298-342) ────────
  const cancelled = await abortCheck(brand._id, run);
  if (!cancelled) {
    try {
      const { enqueueBrandProductDetects } = require('./catalogProductDetectService');
      await enqueueBrandProductDetects(brand._id);
    } catch (err) {
      console.warn(`   ⚠️  🛍  product-path detect enqueue failed: ${err.message}`);
      errors.push(`detect enqueue: ${err.message}`);
    }

    setImmediate(() => {
      require('./catalogProductEnrichmentService')
        .enqueueBrandProductEnrichment(brand._id)
        .catch(err => console.warn(`   ⚠️  🛍  catalog enrichment enqueue failed: ${err.message}`));
    });

    setImmediate(() => {
      (async () => {
        try {
          const inference = require('./productCategoryInferenceService');
          // NOTE: not { $ne: null, …, $ne: '' } — duplicate keys in a JS
          // object literal keep only the LAST one, silently dropping the
          // null exclusion (adversarial-review find; same bug fixed in
          // catalogSyncService's copy of this query).
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
          const result = await inference.inferBatch(candidates.map(c => c._id), {
            concurrency: require('./concurrency').concurrency.CATEGORY_INFERENCE_BATCH_CONCURRENCY
          });
          console.log(`🔎 categoryInference: brand=${brand._id} done — ok=${result.ok} cfChallenged=${result.challenged || 0} skipped=${result.skipped} failed=${result.failed}`);
        } catch (err) {
          console.warn(`   ⚠️  🛍  category inference enqueue failed: ${err.message}`);
        }
      })();
    });
  }

  const durationMs = Date.now() - t0;
  console.log(
    `🛍  Shopify-direct sync done: brand=${brand._id} ` +
    `upserted=${productsUpserted} videos=${videosIngested} reviews=${reviewsCaptured} ` +
    `errors=${errors.length} cancelled=${!!cancelled} in ${durationMs}ms`
  );

  const out = {
    productsUpserted,
    videosIngested,
    reviewsCaptured,
    errors,
    durationMs
  };
  if (cancelled) out.cancelled = true;
  if (hitRateLimit) {
    out.ok = false;
    out.reason = 'store rate-limited this server — partials kept; try the Apify method';
  }
  return out;
}

// ── review helpers ─────────────────────────────────────────────────

// Review extraction + platform detection now live in
// services/productReviewsScrapeService (the shared engine). These two
// names stay as thin delegates because probe scripts import them from
// here; new callers should use the engine directly.
function detectReviewApp(html) {
  return reviewsEngine.detectReviewPlatform(html);
}

function extractReviewsFromHtml(html, reviewAppName) {
  const r = reviewsEngine.extractOnPageReviews(html, {
    platform: reviewAppName !== undefined ? reviewAppName : undefined
  });
  return { rating: r.rating, reviewCount: r.reviewCount, quotes: r.quotes };
}

module.exports = {
  syncBrandShopifyDirect,
  // exported for unit tests / probe scripts
  normalizeGtin,
  stripHtml,
  detectReviewApp,
  extractReviewsFromHtml,
  resolveStoreOrigin
};
