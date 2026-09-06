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
// Zero-dep shared alt-image cap. Safe at top level — no cycle with the
// resolver (that cycle only existed when the constant lived there).
const { MAX_ADDITIONAL_IMAGES } = require('./catalogImageLimits');
// Free packshot/lifestyle classify at ingest (URL-keyed on CatalogProduct).
const ingestShotClassify = require('./ingestShotClassifyService');
// Shared feed-truth stamper — same policy as catalogSyncService (Meta
// feed). Fills categoryRef from p.product_type (Shopify's merchant-
// authored category field) on upsert so Shopify-only brands don't
// have to wait for a UGC match / JSON-LD scrape to get a real leaf.
const { stampFeedTruthCategoryRef, applyFeedTruthStamp } = require('./categoryClassifier');
// Back-fills Brand.websiteUrl the first time this ingest path proves a
// storefront domain for a brand that doesn't have one yet — see the
// module header for why a naive "any known URL's origin" rule is unsafe.
const { backfillBrandWebsiteUrl } = require('./brandWebsiteBackfill');

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

// Split products.json images[] into hero + alts. Feed order is load-bearing
// (metadata.feedIndex / CATALOG_FEED_ORDER_SEEDING) — do not sort or reverse.
// Pure; exported for the offline cap harness.
function mapShopifyProductImages(images) {
  const list = Array.isArray(images) ? images : [];
  const imageUrl = list[0]?.src || null;
  // end-exclusive: slice(1, 1+cap) keeps up to `cap` additional URLs.
  const additionalImages = list
    .slice(1, 1 + MAX_ADDITIONAL_IMAGES)
    .map(i => i && i.src)
    .filter(Boolean);
  return { imageUrl, additionalImages };
}

/**
 * mapShopifyNormalizedToFlat(normalizedProduct, origin, brand?) → flat fields
 *
 * Pure adapter: products.json-shaped item (or storefront/sitemap normalized
 * equivalent from shopifyAccessResolver) → the flat catalog fields both
 * syncBrandShopifyDirect and the generic auto-detect path upsert.
 *
 * MUST stay the single mapping — a second copy is how the three-different-
 * image-caps bug happened. Reuses mapShopifyProductImages so the storage
 * cap (MAX_ADDITIONAL_IMAGES, catalogImageLimits) is shared.
 *
 * brand is optional; used only as a vendor fallback (brand.name).
 */
// CatalogProduct.rawData storage cap. MUST equal genericCatalogResolver's
// RAW_DATA_CAP_BYTES — duplicated rather than imported because that module
// already requires THIS one (ingestHelpers), so importing back would be a
// circular dependency. Pinned equal by verifyCatalogImageCap group R.
//
// Why this matters: an un-capped products.json entry MEASURES ~14.7KB
// (pb5star.com, 2026-08-10) — 1.8x the cap. The generic path capped rawData at
// 8KB before Shopify auto-detect existed; without this, a Shopify-detected
// brand on that path would silently write ~1.8x per product (~147MB extra at a
// 10k-product catalog). Nothing reads structured rawData fields — the only
// consumer $sets the dotted path 'rawData._externalVideos', which works on the
// truncated shape too — so truncating is safe.
const RAW_DATA_CAP_BYTES = 8000;

function capRawDataForFlat(node) {
  try {
    const s = JSON.stringify(node);
    if (s.length <= RAW_DATA_CAP_BYTES) return node;
    return { _truncated: s.slice(0, RAW_DATA_CAP_BYTES) };
  } catch {
    return { _truncated: String(node).slice(0, RAW_DATA_CAP_BYTES) };
  }
}

function mapShopifyNormalizedToFlat(p, origin, brand = null) {
  if (!p || typeof p !== 'object') return null;
  if (p.id == null && p.id !== 0) return null;

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
  const { imageUrl, additionalImages } = mapShopifyProductImages(images);
  const handle = p.handle ? String(p.handle) : null;
  let productUrl = null;
  if (handle && origin) {
    const base = String(origin).replace(/\/+$/, '');
    productUrl = `${base}/products/${handle}`;
  }
  const description = stripHtml(p.body_html, 2000);

  return {
    externalId,
    title:            cleanScrapedText(p.title) || '(untitled)',
    description,
    brand:            cleanScrapedText(p.vendor) || (brand && brand.name) || null,
    price:            Number.isFinite(price) ? price : null,
    currency:         null,
    availability,
    imageUrl,
    additionalImages,
    productUrl,
    gtin:             normalizeGtin(v0.barcode),
    mpn:              v0.sku || null,
    category:         cleanScrapedText(p.product_type) || null,
    rating:           null,
    productReviews:   null,
    rawData:          capRawDataForFlat(p)
  };
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
 * syncBrandShopifyDirect(brand, run, { isBrandAborted, uncapped })
 *
 * brand  – hydrated Brand doc (needs _id, advertiserId, name, apifyDemo.shopifyUrl)
 * run    – progressService run handle (stage/tick/checkpoint)
 * opts.isBrandAborted(brandId, run) – cooperative-cancel helper (same
 *   signature as apifyIngestService.isBrandAborted)
 *
 * Returns { productsUpserted, videosIngested, reviewsCaptured, errors: [], cancelled?: true }
 */
async function syncBrandShopifyDirect(brand, run, { isBrandAborted, uncapped } = {}) {
  const t0 = Date.now();
  const errors = [];
  let productsUpserted = 0;
  let videosIngested   = 0;
  let reviewsCaptured  = 0;
  // VISIBILITY (2026-08-19): a mid-stage rate-limit break previously only
  // pushed one line into `errors[]`, which the caller (apifyIngestService)
  // collapses to a bare COUNT (`errors: r.errors.length`) — an operator
  // looking at a completed 43-minute run with videos=0/reviews=0 had no way
  // to tell "the store rate-limited us" from "there was nothing to find".
  // These flags survive into the returned result AND get pushed into the
  // progress run's own `note` (services/progressService — the existing,
  // single status channel; not a new one) the moment they happen, so an
  // operator watching the run does not have to wait for it to finish.
  let mediaRateLimited = false;
  let reviewsRateLimited = false;

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

  // Nightly scheduled resync is persist-uncapped AND lifts the 200-product
  // fetch ceiling so "whole catalog" is real. Manual Sync Now keeps both
  // SHOPIFY_DIRECT_LIMIT (default 200) and CATALOG_INGEST_LIMIT (default 10).
  const uncappedRun = uncapped === true;
  const CAP = uncappedRun
    ? 100000
    : Math.max(1, parseInt(process.env.SHOPIFY_DIRECT_LIMIT, 10) || DEFAULT_PRODUCT_CAP);

  // Same money+correctness guard as apifyIngestService.syncBrandShopify (see
  // its comment and shopifyAccessResolver.verifyStoreCurrencyUsd's header) —
  // this path is free of Apify cost, but it can still write a wrong-currency
  // price under the assumed-USD contract if `origin` is misconfigured. A
  // POSITIVE, confirmed non-USD currency refuses; an inconclusive check does
  // not block (this endpoint publishes no currency field at all today — see
  // the header comment — so most runs fall through to that path unchanged).
  const { verifyStoreCurrencyUsd } = require('./shopifyAccessResolver');
  const currencyCheck = await verifyStoreCurrencyUsd(origin);
  if (currencyCheck.mismatch) {
    console.warn(`🛍  Shopify-direct sync REFUSED: brand=${brand._id} store=${origin} currency=${currencyCheck.currency} (expected USD) — see models/CatalogProduct.js price unit contract`);
    return {
      productsUpserted: 0,
      videosIngested: 0,
      reviewsCaptured: 0,
      errors: [`store currency is ${currencyCheck.currency}, not USD — refusing to write CatalogProduct.price under the wrong currency`],
      ok: false,
      reason: `store currency is ${currencyCheck.currency}, not USD`,
      currencyMismatch: true,
      detectedCurrency: currencyCheck.currency
    };
  }

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
  // websiteUrl back-fill: use the ORIGIN WE RESOLVED FROM (apifyDemo.shopifyUrl
  // etc.), not the effective backend below — a headless store's myshopify.com
  // backend is never the right value for Brand.websiteUrl (see
  // brandWebsiteBackfill.js header). Gated on products.length so a bad/typo'd
  // config that resolves to nothing never poisons websiteUrl either.
  if (products.length > 0) {
    backfillBrandWebsiteUrl(brand, origin, { ingestSource: 'shopify-direct' }).catch(err =>
      console.warn(`   ⚠️  websiteUrl back-fill failed for brand=${brand._id}: ${err.message}`)
    );
  }
  if (access.origin) origin = access.origin;   // effective backend (myshopify for headless)
  const totalPlanned = products.length || CAP;
  const hitRateLimit = !!access.rateLimited;
  if (access.reason && !products.length) errors.push(access.reason);
  run?.tick?.(0, totalPlanned, `resolved ${products.length} products via ${access.mode || 'none'}`);
  console.log(`🛍  resolved ${products.length} products via ${access.mode || 'none'} (origin=${origin}${access.discoveredMyshopify ? `, backend=${access.discoveredMyshopify}` : ''})`);

  // ── Upsert each product ──────────────────────────────────────────
  // ARCHITECTURE: product upsert NEVER awaits image classification.
  // A hung DNS / slow CDN must not truncate the catalog on first sync.
  // Collect classify work during the loop; run it as a post-loop pass.
  const shotSession = ingestShotClassify.createSession();
  const pendingClassify = [];
  const pendingBenefits = [];
  let midUpsertCancelled = false;
  // Universal ingest cap (2026-09-02, services/ingestLimits.js). Bounded
  // by CATALOG_INGEST_LIMIT env; defaults to 10 rows per pass. Stops the
  // persist loop the moment the cap is reached rather than filtering
  // upstream — the fetch may have returned a full page, we simply choose
  // to write only N.
  const { catalogIngestLimit } = require('./ingestLimits');
  const ingestCap = catalogIngestLimit({ uncapped: uncappedRun });
  let persistedCount = 0;
  try {
  let idx = 0;
  for (const p of products) {
    if (ingestCap != null && persistedCount >= ingestCap) {
      console.log(`   · 🛍  hit CATALOG_INGEST_LIMIT=${ingestCap} — stopping after ${persistedCount} product(s)`);
      break;
    }
    idx += 1;
    if (await abortCheck(brand._id, run)) {
      console.log(`   · 🛍  aborted mid-upsert for brand=${brand._id}`);
      midUpsertCancelled = true;
      break;
    }
    if (run?.checkpoint) await run.checkpoint();

    try {
      // Shared pure mapper — same function the generic auto-detect path uses
      // so image caps / price / availability cannot diverge again.
      const flat = mapShopifyNormalizedToFlat(p, origin, brand);
      if (!flat) {
        errors.push(`upsert ${p?.id}: unmappable product shape`);
        continue;
      }
      const externalId = flat.externalId;
      const nextTitle = flat.title || '(untitled)';
      const nextDescription = flat.description;
      const benefits = require('./productBenefitsService');
      const prevDoc = await benefits.loadPrevForBenefits(brand._id, externalId);
      const { changed: benefitsStale } = benefits.markBenefitsStaleIfTextChanged(
        prevDoc,
        { title: nextTitle, description: nextDescription }
      );

      // Upsert only — no await on classify (image network work).
      const set = {
        advertiserId:     brand.advertiserId,
        brandId:          brand._id,
        source:           'shopify-direct',
        externalId,
        itemGroupId:      externalId,
        // Decoded for the same reason as the generic path: the headless
        // fallback feeds this shape from JSON-LD, and merchants
        // sometimes type entities straight into a Shopify title.
        title:            nextTitle,
        description:      nextDescription,
        brand:            flat.brand || brand.name || null,
        price:            flat.price,
        // flat.currency is always null on this path (products.json /
        // .js expose no currency field — see file header). Once we've
        // independently verified the store via /meta.json above, store
        // the TRUE currency rather than leaving it null/defaulted.
        currency:         currencyCheck.verified ? currencyCheck.currency : flat.currency,
        availability:     flat.availability,
        additionalImages: flat.additionalImages,
        productUrl:       flat.productUrl,
        gtin:             flat.gtin,
        mpn:              flat.mpn,
        category:         flat.category,
        rawData:          flat.rawData || p,
        lastSyncedAt:     new Date()
      };
      // null → url heals; url → null must not clobber. See catalogImageUrlGuard.
      require('./catalogImageUrlGuard').assignImageUrl(set, flat.imageUrl);
      const upsertUpdate = {
        $set: set,
        $setOnInsert: { firstSeenAt: new Date() }
      };
      benefits.applyBenefitsStaleToUpdate(upsertUpdate, benefitsStale);
      const upsertResult = await CatalogProduct.findOneAndUpdate(
        { brandId: brand._id, externalId },
        upsertUpdate,
        { upsert: true, new: true, includeResultMetadata: true }
      );
      const doc = upsertResult?.value || upsertResult;
      benefits.collectAfterCatalogUpsert(upsertResult, pendingBenefits, { changed: benefitsStale });
      productsUpserted += 1;
      persistedCount += 1;

      // Stamp / restamp categoryRef via applyFeedTruthStamp. Handles
      // insert (fresh row), noop (ref already matches), and rename
      // (merchant renamed the product_type — overwrite with new leaf).
      // Best-effort — never breaks the sync.
      if (doc) {
        try {
          const stamp = await stampFeedTruthCategoryRef({
            brandId:      brand._id,
            advertiserId: brand.advertiserId,
            feedCategory: flat.category,
            title:        flat.title
          });
          const outcome = await applyFeedTruthStamp(doc, stamp);
          if (outcome.action === 'renamed' || outcome.action === 'rehomed-from-tombstone') {
            console.log(`   ↺ 🛍  category ${outcome.action} for ${flat.externalId}: ${outcome.from} → ${outcome.to}`);
          }
        } catch (err) {
          console.warn(`   ⚠️  🛍  category stamp failed for ${flat.externalId}: ${err.message}`);
        }
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
      console.warn(`   ⚠️  🛍  upsert failed for ${p?.id}: ${err.message}`);
      errors.push(`upsert ${p?.id}: ${err.message}`);
    }

    run?.tick?.(
      idx,
      totalPlanned,
      `products ${idx}/${totalPlanned} · ${videosIngested} videos · ${reviewsCaptured} reviews`
    );
  }

  // Post-loop classify pass — products are already persisted. Failures
  // here cannot un-save a product or skip a sibling SKU's upsert.
  // Budget clock starts here (beginClassifyPhase), not at createSession.
  // Batched across products so the concurrency cap is used; cooperative
  // cancel (same abortCheck as the upsert loop) stops promptly and
  // records outstanding URLs as skippedAbandoned.
  if (pendingClassify.length && ingestShotClassify.isEnabled()) {
    shotSession.beginClassifyPhase();
    await shotSession.classifyPendingProducts(pendingClassify, {
      isCancelled: async () => {
        if (midUpsertCancelled) return true;
        try { return !!(await abortCheck(brand._id, run)); } catch (_) { return false; }
      },
      onProduct: async (item, { entries, changed }) => {
        if (!changed) return;
        await CatalogProduct.updateOne(
          { _id: item.productId },
          { $set: { imageShotStyles: entries } }
        );
      }
    }).then((r) => {
      if (r && r.cancelled) midUpsertCancelled = true;
    }).catch((shotErr) => {
      console.warn(`   ⚠️  🛍  shot-classify batch failed: ${shotErr.message}`);
    });
  }

  if (midUpsertCancelled) {
    return {
      productsUpserted,
      videosIngested,
      reviewsCaptured,
      errors,
      cancelled: true,
      durationMs: Date.now() - t0
    };
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
    // Only the <handle>.js rung carries a title; the storefront-GraphQL rung
    // does not. Hoisted because the video loop below reads it as a fallback,
    // and `ajax` itself goes out of scope at the end of that branch.
    let ajaxTitle = null;
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
          mediaRateLimited = true;
          errors.push(`media stage rate-limited at handle=${p.handle}`);
          console.warn(`   ⚠️  🛍  ${err.message} during media stage — skipping remaining videos`);
          run?.note?.(`store rate-limited us during media stage — remaining videos skipped (${i + 1}/${products.length} products checked)`);
          break;
        }
        // 404 / parse-fail → skip silently, count error.
        if (err.status === 404) continue;
        errors.push(`products/${p.handle}.js: ${err.message}`);
        continue;
      }
      mediaArr = Array.isArray(ajax?.media) ? ajax.media : [];
      ajaxTitle = ajax?.title || null;
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
                  productTitle:     p.title || ajaxTitle || null,
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
        reviewsRateLimited = true;
        errors.push(`reviews stage rate-limited at handle=${p.handle}`);
        console.warn(`   ⚠️  🛍  ${err.message} during reviews stage — skipping remaining reviews`);
        run?.note?.(`store rate-limited us during reviews stage — remaining reviews skipped (${i + 1}/${products.length} products checked)`);
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
  //
  // ROBUSTNESS (2026-08-19): the enrichment + category-inference triggers
  // below are intentionally NOT awaited by the main sync — enrichment is a
  // separate paid/slow tier (GPT + on-site review scrape) and category
  // inference walks product pages; neither should hold up the catalog sync
  // itself or its HTTP/executor caller. They used to be wrapped in
  // setImmediate() to push them one tick out, which is where the bug was:
  // setImmediate does not keep this process (or its Mongoose connection)
  // alive, so a SHORT-LIVED caller (a one-off script, a queued job runner
  // that connects → syncs → disconnects) can tear down the DB connection
  // before that deferred tick ever runs — the trigger then fails immediately
  // with "Client must be connected before running operations", silently,
  // because both call sites only console.warn on failure. Measured live on
  // a real Marine Layer re-ingest: all three (on-site review scrape,
  // catalog enrichment, category inference) died this way.
  //
  // Fix: call directly (no setImmediate — an async function already returns
  // control to its caller at its first await, so nothing here blocks the
  // sync's own return) and COLLECT the promises onto the result so a caller
  // that owns its own connection lifecycle can choose to await them before
  // disconnecting. Every existing caller (HTTP routes, capability
  // executors) ignores this field and is unaffected — they stay connected
  // for the life of the process anyway, which is why this was invisible
  // until a short-lived script hit it.
  const cancelled = await abortCheck(brand._id, run);
  const backgroundWork = [];
  if (!cancelled) {
    try {
      const { enqueueBrandProductDetects } = require('./catalogProductDetectService');
      await enqueueBrandProductDetects(brand._id);
    } catch (err) {
      console.warn(`   ⚠️  🛍  product-path detect enqueue failed: ${err.message}`);
      errors.push(`detect enqueue: ${err.message}`);
    }

    // enqueueBrandProductDetects (above) is a deliberate no-op under
    // CATALOG_DETECT_PRECOMPUTE deferral — it returns `deferred` before
    // ever materializing a hero. Without a separate trigger, imageMediaId
    // stays null on every row until an operator happens to open ONE
    // product's own detail page (measured: 826/831 unpickable on a fresh
    // Pelagic Gear sync). Fire-and-forget, same shape as the enrichment /
    // category-inference triggers below; idempotent via
    // findActiveMaterializeDrain so a retried/overlapping sync never
    // stacks two sweeps over the same brand.
    if (productsUpserted > 0) {
      require('./catalogMaterializeDrainService')
        .startCatalogMaterializeDrain({ brandId: brand._id, advertiserId: brand.advertiserId, label: 'Preparing catalog images (post-ingest)' })
        .catch(err => console.warn(`   ⚠️  🛍  catalog materialize drain trigger failed: ${err.message}`));
    }

    backgroundWork.push(
      require('./catalogProductEnrichmentService')
        .enqueueBrandProductEnrichment(brand._id)
        .catch(err => console.warn(`   ⚠️  🛍  catalog enrichment enqueue failed: ${err.message}`))
    );

    // Materialize + YOLO detect chain via the resilient orchestrator.
    // See services/catalogPostSyncOrchestrator.js header for the failure
    // modes the old inline try/try version silently absorbed.
    backgroundWork.push(
      require('./catalogPostSyncOrchestrator').runPostSyncChain(brand._id, { trigger: 'sync' })
    );

    backgroundWork.push((async () => {
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
    })());
  }

  require('./productBenefitsService').enqueueFromPending({
    pending: pendingBenefits, brand, backgroundWork
  });

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
    durationMs,
    // Awaitable by a caller that owns its own connection lifecycle (see the
    // ROBUSTNESS comment on the end-of-run trio above). Ignored — safely —
    // by every existing HTTP/executor caller.
    backgroundWork
  };
  if (cancelled) out.cancelled = true;
  if (hitRateLimit) {
    out.ok = false;
    out.reason = 'store rate-limited this server — partials kept; try the Apify method';
  }
  // Mid-stage rate-limit notes survive past the bare errors[].length count
  // apifyIngestService's summary collapses `errors` to (see VISIBILITY
  // comment above). `videosIngested`/`reviewsCaptured` staying 0 with NO
  // reason attached is exactly what made the Marine Layer run look like a
  // silent failure instead of an explained, honest partial result.
  if (mediaRateLimited) out.mediaRateLimited = true;
  if (reviewsRateLimited) out.reviewsRateLimited = true;
  return out;
  } catch (err) {
    throw err;
  } finally {
    // Unconditional summary — every exit path (mid-upsert abort, rate-limit
    // return, media/reviews cancel, success, throw) must report budget
    // truncation so a partial classify never looks like "classified everything".
    // Outstanding pending when classify never ran → abandoned (not considered=0).
    try {
      if (!shotSession.hasClassifyPhaseStarted() && pendingClassify.length) {
        shotSession.abandonPending(
          pendingClassify,
          midUpsertCancelled ? 'cancelled' : 'phase_skipped'
        );
      }
    } catch (_) { /* ignore */ }
    try { shotSession.logSummary('🛍 shot-classify'); } catch (_) { /* ignore */ }
    try { shotSession.dispose(); } catch (_) { /* ignore */ }
  }
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
  resolveStoreOrigin,
  mapShopifyProductImages,
  mapShopifyNormalizedToFlat,
  RAW_DATA_CAP_BYTES
};
