// JSON-LD product-category inference.
//
// For brands that aren't on Shopify (and Shopify-connected brands as
// supplemental signal), parse the brand's product pages for structured
// data — BreadcrumbList + Product.category — and build a real Category
// tree from what the brand publishes to Google Shopping.
//
// Triggered automatically after catalog sync (catalogSyncService) and
// manually via POST /api/catalog/brands/:id/infer-categories. Results
// stamped on CatalogProduct.inferredBreadcrumb + inferredCategoryAt;
// Category tree built via Category.findOrCreateCategoryTree.
//
// TTL: 14 days. After that we re-scrape on next sync (or when the
// operator manually re-triggers).

const axios = require('axios');
const CatalogProduct = require('../models/CatalogProduct');
const Category = require('../models/Category');
const { findOrCreateCategoryTree } = Category;
// Pure JSON-LD breadcrumb parser (no axios) — shared with the catalog
// scanner so it can capture breadcrumbs in-scan without a second crawl.
const {
  BREADCRUMB_SKIP,
  extractJsonLdBlocks,
  findByType,
  normalizeBreadcrumb,
  extractBreadcrumb
} = require('./breadcrumbParser');
const { concurrency: CONC } = require('./concurrency');

// Realistic browser UA — many e-commerce hosts (Cloudflare-protected
// Shopify stores in particular) serve a managed-challenge page to
// generic bot UAs. We pose as Safari so the underlying product HTML
// actually reaches us. We're not hiding identity — `From` header sets
// the reach-social.io contact for any host that wants to block us.
const USER_AGENT     = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const FROM_HEADER    = 'crawler@reach-social.io';
const FETCH_TIMEOUT  = 15000;
const TTL_DAYS       = 14;
// Shorter TTL when the page was Cloudflare-challenged — we want to
// retry sooner once the site potentially drops the challenge, instead
// of waiting the full 14-day no-data TTL.
const CHALLENGED_TTL_DAYS = 1;
const MAX_HTML_BYTES = 2 * 1024 * 1024;   // 2 MB — most product pages are 200–500 KB

// Per-domain concurrency cap. Some e-commerce hosts (especially behind
// Cloudflare/Fastly) 429 aggressive scrapers. Default 3 concurrent + 250 ms
// post-finish gap is polite enough for ~10 RPS sustained per domain.
// Override via CATEGORY_INFERENCE_DOMAIN_CONCURRENCY.
const DOMAIN_CONCURRENCY = CONC.CATEGORY_INFERENCE_DOMAIN_CONCURRENCY;
const POST_FETCH_DELAY_MS = 250;

// BREADCRUMB_SKIP / extractJsonLdBlocks / findByType / normalizeBreadcrumb
// / extractBreadcrumb are imported from ./breadcrumbParser (above) so the
// axios-free scanner can share them.

// ── HTTP fetch ───────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout:       FETCH_TIMEOUT,
    maxRedirects:  3,
    maxContentLength: MAX_HTML_BYTES,
    headers: {
      'User-Agent':      USER_AGENT,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'From':            FROM_HEADER
    },
    validateStatus: s => s >= 200 && s < 400,
    responseType: 'text',
    transformResponse: [(d) => d]   // keep raw text
  });
  return String(res.data || '');
}

async function fetchJson(url) {
  const res = await axios.get(url, {
    timeout:       FETCH_TIMEOUT,
    maxRedirects:  3,
    headers: {
      'User-Agent':      USER_AGENT,
      'Accept':          'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'From':            FROM_HEADER
    },
    validateStatus: s => s >= 200 && s < 400,
    responseType: 'json'
  });
  return res.data;
}

// Cloudflare's managed challenge page is recognizable from the body —
// "Just a moment..." title + a `_cf_chl_opt` bootstrap script. When we
// hit one of these we want to retry later (different IP / different
// time) rather than silently TTL-marking the product as "no data".
function isCloudflareChallenge(html) {
  if (!html) return false;
  return /Just a moment\.\.\./.test(html) && /_cf_chl_opt|cdn-cgi\/challenge-platform/.test(html);
}

// Shopify storefronts expose a public JSON endpoint at
// /products/{handle}.json that returns title/vendor/product_type/tags
// directly — far more reliable than scraping the rendered HTML, since
// most Shopify themes don't emit application/ld+json on product pages.
// We detect Shopify by URL path: any /products/{handle} pattern.
function shopifyJsonUrlFor(productUrl) {
  try {
    const u = new URL(productUrl);
    const m = u.pathname.match(/^\/products\/([^/?#]+)\/?$/);
    if (!m) return null;
    const handle = m[1];
    return `${u.origin}/products/${encodeURIComponent(handle)}.json`;
  } catch {
    return null;
  }
}

// Given a Shopify product JSON ({ product: { product_type, tags, vendor, ... } }),
// build a breadcrumb from product_type + the most-specific-looking tag.
// Returns [] when neither is usable so the caller can fall through to
// JSON-LD parsing.
function breadcrumbFromShopifyJson(payload) {
  const p = payload?.product;
  if (!p) return [];
  const names = [];
  const type = String(p.product_type || '').trim();
  if (type && !BREADCRUMB_SKIP.has(type.toLowerCase())) names.push(type);
  // Tags ship as Array on /products.json (bulk) but as a comma-separated
  // STRING on /products/{handle}.json (per-product). Normalize.
  const rawTags = Array.isArray(p.tags) ? p.tags
                : typeof p.tags === 'string' ? p.tags.split(',')
                : [];
  // We surface the FIRST tag that's title-cased + alphabetic — a weak
  // proxy for "name of a real collection". Skips time-bound campaigns
  // ("summer 2026" — has digits) and lowercase admin tags ("vday 2025").
  // Tags containing `&` (e.g., "Home & Gifts") are allowed by widening
  // the regex; we only require it to start uppercase.
  const candidates = rawTags
    .map(t => String(t).trim())
    .filter(t => t && !BREADCRUMB_SKIP.has(t.toLowerCase()))
    .filter(t => /^[A-Z]/.test(t))            // starts uppercase
    .filter(t => !/\d/.test(t));              // no digits (excludes "Summer 2026")
  if (candidates.length) names.push(candidates[0]);
  return names;
}

// Per-domain in-flight counter — polite throttle so we never burst more
// than DOMAIN_CONCURRENCY requests at the same host. Each finished
// request adds POST_FETCH_DELAY_MS before releasing the slot.
const inFlightByDomain = new Map();

async function throttledFetch(url) {
  const domain = new URL(url).hostname;
  while ((inFlightByDomain.get(domain) || 0) >= DOMAIN_CONCURRENCY) {
    await new Promise(r => setTimeout(r, POST_FETCH_DELAY_MS));
  }
  inFlightByDomain.set(domain, (inFlightByDomain.get(domain) || 0) + 1);
  try {
    return await fetchHtml(url);
  } finally {
    setTimeout(() => {
      inFlightByDomain.set(domain, Math.max(0, (inFlightByDomain.get(domain) || 0) - 1));
    }, POST_FETCH_DELAY_MS);
  }
}

// ── Public API ───────────────────────────────────────────────────────

// Pure function — fetch, parse, return breadcrumb. No DB writes.
//
// Order of attempts:
//   1. Shopify /products/{handle}.json (when the URL fits the pattern)
//      — most reliable when accessible, ships product_type + tags
//   2. HTML scrape for JSON-LD BreadcrumbList / Product.category
//   3. Detect Cloudflare challenge response → reason='cf_challenged'
//      so the caller can retry with a shorter TTL
async function inferFromProductUrl(productUrl) {
  if (!productUrl) return null;
  const t0 = Date.now();

  // ── 1. Shopify JSON fast-path ──
  const shopifyJsonUrl = shopifyJsonUrlFor(productUrl);
  if (shopifyJsonUrl) {
    try {
      const json = await fetchJson(shopifyJsonUrl);
      const breadcrumb = breadcrumbFromShopifyJson(json);
      if (breadcrumb.length) {
        return { ok: true, breadcrumb, source: 'shopifyJson', elapsedMs: Date.now() - t0 };
      }
      // Endpoint responded but had no usable category fields — fall
      // through to HTML scrape (some Shopify stores hide product_type
      // / tags but expose JSON-LD via theme customizations).
    } catch (err) {
      // 404 / 403 / non-Shopify host — fall through silently. Only
      // log unexpected failures (network errors, timeouts).
      const status = err.response?.status;
      if (!status || status >= 500) {
        // not noisy; just don't bail — try HTML scrape
      }
    }
  }

  // ── 2. HTML scrape ──
  try {
    const html = await throttledFetch(productUrl);
    if (isCloudflareChallenge(html)) {
      return { ok: false, reason: 'cf_challenged', elapsedMs: Date.now() - t0 };
    }
    const result = extractBreadcrumb(html);
    if (!result) return { ok: false, reason: 'no structured data', elapsedMs: Date.now() - t0 };
    return { ok: true, breadcrumb: result.breadcrumb, source: result.source, elapsedMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, reason: err.message || String(err), elapsedMs: Date.now() - t0 };
  }
}

// Per-product: infer, build Category tree, stamp CatalogProduct.
// Returns { ok, breadcrumb, categoryId } on success, { skipped, reason }
// otherwise. The categoryRef on CatalogProduct is updated to point at
// the inferred leaf — replacing any prior coarse heuristic-mapped ref.
async function inferAndStamp(productId, { force = false } = {}) {
  const product = await CatalogProduct.findById(productId)
    .select('_id brandId advertiserId productUrl categoryRef inferredCategoryAt')
    .lean();
  if (!product) return { skipped: true, reason: 'product not found' };
  if (!product.productUrl) return { skipped: true, reason: 'no productUrl' };

  if (!force && product.inferredCategoryAt) {
    const ageMs = Date.now() - new Date(product.inferredCategoryAt).getTime();
    if (ageMs < TTL_DAYS * 24 * 60 * 60 * 1000) {
      return { skipped: true, reason: 'TTL', ageMs };
    }
  }

  const r = await inferFromProductUrl(product.productUrl);
  if (!r || !r.ok) {
    // Mark the attempt so we don't retry on every sync. Cloudflare-
    // challenged responses use a shorter TTL (1 day instead of 14) so
    // we re-probe sooner — the challenge may drop, the brand may
    // disable bot protection, or we may move to a server with a
    // different reputation. All other "no data" reasons use the
    // standard TTL.
    const challenged = r?.reason === 'cf_challenged';
    const ttlBackdateMs = challenged
      ? (TTL_DAYS - CHALLENGED_TTL_DAYS) * 24 * 60 * 60 * 1000
      : 0;
    await CatalogProduct.updateOne(
      { _id: productId },
      { $set: { inferredCategoryAt: new Date(Date.now() - ttlBackdateMs) } }
    );
    return { skipped: true, reason: r?.reason || 'unknown', challenged };
  }

  const breadcrumb = r.breadcrumb;
  const categoryId = await findOrCreateCategoryTree({
    brandId:          product.brandId,
    advertiserId:     product.advertiserId || null,
    breadcrumb:       breadcrumb.join(' > '),
    url:              product.productUrl,
    firstSeenMediaId: null
  });

  await CatalogProduct.updateOne(
    { _id: productId },
    {
      $set: {
        inferredBreadcrumb: breadcrumb,
        inferredCategoryAt: new Date(),
        ...(categoryId ? { categoryRef: categoryId } : {})
      }
    }
  );

  return { ok: true, breadcrumb, source: r.source, categoryId };
}

// Batch — runs N products with global concurrency cap. The per-domain
// throttle inside throttledFetch keeps a single brand from hammering
// its own host even when the batch concurrency is high.
// opts.onProgress(done, total) is awaited after each product so callers
// can surface live progress (and cancel — a throwing onProgress stops the
// batch: workers exit, in-flight items finish). Kept optional so the
// existing callers are unaffected.
async function inferBatch(productIds, { concurrency = CONC.CATEGORY_INFERENCE_BATCH_CONCURRENCY, force = false, onProgress = null } = {}) {
  const results = { ok: 0, skipped: 0, challenged: 0, failed: 0, total: productIds.length };
  let cursor = 0;
  let done = 0;
  let stopped = false;
  async function worker() {
    while (!stopped && cursor < productIds.length) {
      const id = productIds[cursor++];
      try {
        const r = await inferAndStamp(id, { force });
        if (r.ok) results.ok++;
        else if (r.challenged) results.challenged++;
        else      results.skipped++;
      } catch {
        results.failed++;
      }
      done++;
      if (onProgress) {
        try { await onProgress(done, productIds.length); }
        catch { stopped = true; }   // onProgress threw (e.g. cancel) → stop
      }
    }
  }
  const workerCount = Math.min(concurrency, productIds.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  results.cancelled = stopped;
  return results;
}

module.exports = {
  inferFromProductUrl,
  inferAndStamp,
  inferBatch,
  extractBreadcrumb,        // exposed for testing
  TTL_DAYS
};
