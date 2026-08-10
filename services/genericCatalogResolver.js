// services/genericCatalogResolver.js
//
// Client-agnostic product-catalog discovery for server-rendered
// e-commerce sites that expose (a) XML sitemaps and (b) schema.org
// JSON-LD `Product` (or Open Graph product) data on product pages.
//
// NOTHING here is client-specific — only the origin URL (resolved via
// resolveStoreOrigin(brand) from brand.apifyDemo.shopifyUrl / shopifyUrl
// / websiteUrl) varies between brands. First production target is a
// non-Shopify furniture retailer, but the same path works for any site
// that publishes sitemaps + Product JSON-LD.
//
// Ladder:
//   1. robots.txt → Sitemap: lines (+ Crawl-delay)
//   2. fallback /sitemap.xml, /sitemap_index.xml, /sitemap-index.xml
//   3. walk sitemapindex → urlset (depth ≤ 2), rank product-ish locs first
//   4. per PDP: JSON-LD Product → Open Graph product → skip
//   5. validate (externalId + title + price|image) before accepting
//
// MONEY: JSON-LD offers.price is MAJOR units ("1499.00" = $1499). Parse
// as Number — NEVER divide by 100, NEVER reuse shopifyAccessResolver
// `_shopifyMoney` (its number-branch is Shopify-cents).
//
// All HTTP goes through services/httpScrapeClient.js (UA rotation,
// per-host throttle, 429/Retry-After, CF detection). Never HEAD.

'use strict';

const zlib = require('zlib');
const http = require('./httpScrapeClient');
const ingestHelpers = require('./shopifyPublicIngestService');
// TEXT: JSON-LD lives inside a <script> (a raw-text element), so the HTML
// parser never decodes character references in it. Sites that escape their
// JSON-LD string values hand us `74&quot; Wide TV Stand` verbatim — every
// human-readable field below goes through cleanScrapedText.
const { cleanScrapedText } = require('../utils/htmlEntities');
// Shared on-page review/rating engine — same extractor every ingest path
// uses, so review coverage doesn't depend on which sync method ran.
const reviewsEngine = require('./productReviewsScrapeService');
// Reuse the pure (axios-free) breadcrumb parser so we can capture the
// PDP's BreadcrumbList from the SAME HTML the scan already fetched —
// avoids a second full per-product crawl by the post-sync inference pass.
const { extractBreadcrumb } = require('./breadcrumbParser');
// Zero-dep shared cap — see services/catalogImageLimits.js. Kept here as
// a local binding so the JSON-LD mapper's slice stays readable; the
// constant itself is owned (and env-resolved) in that module only.
const { MAX_ADDITIONAL_IMAGES } = require('./catalogImageLimits');
// Scored product-URL heuristic — ranking only (non-matches still scanned later).
const { scoreProductish, isProductish } = require('./genericCatalogDiscovery/productish');

// ── constants ──────────────────────────────────────────────────────
const LOG = '🗺';
// Full-catalog by default — do NOT cap at a small demo number. 10k covers
// essentially any real catalog; override via GENERIC_CATALOG_LIMIT.
// NOTE: crawl throughput is ~1 page / HTTP_SCRAPE_MIN_GAP_MS (≈4/s at the
// 250ms default) and the progress run self-terminates at ~4h, so the
// practical ceiling per sync is ~10-14k pages. Downstream enrichment cost
// scales with product count — see docs.
const DEFAULT_CAP = Math.max(1, parseInt(process.env.GENERIC_CATALOG_LIMIT, 10) || 10000);
const MAX_SITEMAP_URLS = Math.max(
  1,
  parseInt(process.env.GENERIC_CATALOG_MAX_SITEMAP_URLS, 10) || 20000
);
const MAX_SITEMAP_DEPTH = 2;
// Hard ceiling on total sitemap documents fetched per sync (index +
// sub-sitemaps), independent of MAX_SITEMAP_URLS — bounds a hostile or
// misconfigured index graph from forcing unbounded outbound fetches.
const MAX_SITEMAP_FETCHES = Math.max(
  10,
  parseInt(process.env.GENERIC_CATALOG_MAX_SITEMAP_FETCHES, 10) || 200
);
const GZIP_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;  // decompressed sitemap cap
const MAX_ROBOTS_SITEMAPS = 50;                  // cap root sitemaps from robots.txt
const RAW_DATA_CAP_BYTES = 8000;
const FALLBACK_SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── robots.txt (Sitemap: + Crawl-delay — httpScrapeClient ignores both) ─

/**
 * parseRobotsForSitemaps(text, userAgent?) → { sitemaps:[url], crawlDelayMs }
 * Sitemap lines collected in document order. Crawl-delay prefers a
 * User-agent block matching `userAgent` (case-insensitive token match),
 * else the `*` block. Delay is seconds → ms; missing/invalid → 0.
 */
function parseRobotsForSitemaps(text, userAgent = '*') {
  const sitemaps = [];
  if (!text || typeof text !== 'string') {
    return { sitemaps, crawlDelayMs: 0 };
  }

  const sitemapRe = /^\s*Sitemap:\s*(\S+)/gim;
  let m;
  while ((m = sitemapRe.exec(text)) !== null) {
    const u = (m[1] || '').trim();
    if (u) sitemaps.push(u);
  }

  const wantUa = String(userAgent || '*').toLowerCase();
  const lines = text.split(/\r?\n/);
  let agents = []; // current group agent tokens (lowercase)
  let groupStarted = false;
  let specificDelay = null; // seconds, matching wantUa
  let starDelay = null;     // seconds, for *

  const flushNotNeeded = () => {}; // groups accumulate until next User-agent after directives

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const uaM = line.match(/^User-agent:\s*(\S+)/i);
    if (uaM) {
      const token = uaM[1].toLowerCase();
      // A User-agent after directives have started = new group
      if (groupStarted && agents.length) {
        // already recorded delays for previous group via directive path
        agents = [];
        groupStarted = false;
      }
      // Consecutive User-agent lines share one directive group
      if (!groupStarted) agents = [];
      agents.push(token);
      continue;
    }

    if (!agents.length) continue;
    groupStarted = true;

    const cdM = line.match(/^Crawl-delay:\s*([0-9.]+)/i);
    if (!cdM) continue;
    const secs = parseFloat(cdM[1]);
    if (!Number.isFinite(secs) || secs < 0) continue;

    const matchesSpecific = agents.some(a => a !== '*' && (wantUa === a || wantUa.includes(a) || a.includes(wantUa)));
    const matchesStar = agents.includes('*');
    if (matchesSpecific && specificDelay == null) specificDelay = secs;
    if (matchesStar && starDelay == null) starDelay = secs;
  }
  void flushNotNeeded;

  const delaySec = specificDelay != null ? specificDelay : (starDelay != null ? starDelay : 0);
  const crawlDelayMs = Math.round(delaySec * 1000);
  // Cap the declared sitemap count — a hostile/huge robots.txt shouldn't
  // seed an unbounded root set (walkSitemaps also caps total fetches).
  return {
    sitemaps: sitemaps.slice(0, MAX_ROBOTS_SITEMAPS),
    crawlDelayMs: Number.isFinite(crawlDelayMs) ? crawlDelayMs : 0
  };
}

// ── sitemap XML (regex only — no xml libs) ─────────────────────────

/**
 * parseSitemapXml(xml) → { type:'index'|'urlset', entries:[{loc,lastmod}] }
 * Malformed/empty → { type:'urlset', entries:[] } — never throws.
 */
function parseSitemapXml(xml) {
  if (!xml || typeof xml !== 'string') {
    return { type: 'urlset', entries: [] };
  }
  const type = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset';
  const entries = [];
  const blockRe = type === 'index'
    ? /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi
    : /<url\b[^>]*>([\s\S]*?)<\/url>/gi;

  let blockM;
  let matchedBlocks = 0;
  while ((blockM = blockRe.exec(xml)) !== null) {
    matchedBlocks += 1;
    const body = blockM[1] || '';
    const locM = body.match(/<loc>\s*([^<]+?)\s*<\/loc>/i);
    if (!locM) continue;
    const loc = (locM[1] || '').trim();
    if (!loc) continue;
    const lmM = body.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i);
    const lastmod = lmM ? (lmM[1] || '').trim() || null : null;
    entries.push({ loc, lastmod });
  }

  // Fallback: bare <loc> tags if block structure missing/malformed
  if (!matchedBlocks) {
    const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
    let lm;
    while ((lm = locRe.exec(xml)) !== null) {
      const loc = (lm[1] || '').trim();
      if (loc) entries.push({ loc, lastmod: null });
    }
  }

  return { type, entries };
}

// Lower rank sorts first — negate score so product-ish (high score) leads.
function rankLoc(loc) {
  return -scoreProductish(loc);
}

function lastmodMs(lastmod) {
  if (!lastmod) return 0;
  const t = Date.parse(lastmod);
  return Number.isFinite(t) ? t : 0;
}

// ── JSON-LD extract / flatten ──────────────────────────────────────

function flattenLdNodes(blocks) {
  const out = [];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node !== 'object') return;
    out.push(node);
    if (Array.isArray(node['@graph'])) {
      for (const n of node['@graph']) walk(n);
    }
  };
  for (const b of blocks) walk(b);
  return out;
}

function nodeTypes(node) {
  if (!node || typeof node !== 'object') return [];
  const t = node['@type'];
  if (Array.isArray(t)) return t.map(x => String(x || ''));
  if (t != null) return [String(t)];
  return [];
}

function isProductType(node) {
  return nodeTypes(node).some(t => /product/i.test(t));
}

/**
 * extractJsonLdProducts(html) → Product nodes[]
 * Regex all application/ld+json scripts, lenient trailing-comma parse,
 * flatten @graph/arrays, keep @type matching /product/i.
 */
function extractJsonLdProducts(html) {
  if (!html || typeof html !== 'string') return [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      try {
        const cleaned = raw.replace(/,\s*([}\]])/g, '$1');
        blocks.push(JSON.parse(cleaned));
      } catch {
        // skip unparseable block
      }
    }
  }
  return flattenLdNodes(blocks).filter(isProductType);
}

// ── URL / field helpers ────────────────────────────────────────────

function absUrl(u, pageUrl) {
  if (u == null) return null;
  let s = String(u).trim();
  if (!s) return null;
  if (s.startsWith('//')) s = 'https:' + s;
  try {
    return new URL(s, pageUrl || undefined).href;
  } catch {
    return s.startsWith('http') ? s : null;
  }
}

/**
 * Deterministic numeric id from a product page URL so
 * /pdp-x-123 and /…/p123 collapse to the same externalId ("123").
 */
function isYearLike(s) {
  return /^(?:19|20)\d{2}$/.test(String(s));
}

function extractNumericIdFromUrl(pageUrl) {
  if (!pageUrl) return null;
  let path;
  try {
    path = new URL(pageUrl).pathname || '';
  } catch {
    path = String(pageUrl);
  }
  // Product-specific patterns only (URL is a LAST-RESORT id source — the
  // feed id should come from JSON-LD sku/productID). Avoid grabbing a bare
  // year/page-number from a listing URL.
  let m = path.match(/\/pdp[-_x/.]*?(\d{3,})/i);
  if (m && !isYearLike(m[1])) return m[1];
  m = path.match(/\/p(\d{3,})(?:\/|$|[?#])/i);
  if (m && !isYearLike(m[1])) return m[1];
  // slug-suffixed id: "…-108724" with 5+ digits (excludes 4-digit years,
  // short sizes/quantities, and standalone trailing numbers).
  m = path.match(/-(\d{5,})(?:\/|$|[?#])/);
  if (m) return m[1];
  return null;
}

/**
 * A CLEAN product id is short and essentially one token — a number
 * ("108724"), or a compact alphanumeric SKU ("WC-108724", "SKU12345").
 * A URL/name SLUG like "willow-creek-ii-dresser" has "too many words" and
 * must NOT be used as the dedup key (two URL schemes would then never
 * collapse, and re-syncs could duplicate). Returns true when `id` looks
 * like a multi-word slug/name rather than a real identifier.
 */
function looksLikeSlug(id) {
  if (id == null) return false;
  const s = String(id).trim();
  if (!s) return false;
  if (/^\d+$/.test(s)) return false;            // pure numeric → clean
  const wordTokens = s.split(/[\s\-_/]+/).filter(t => /[a-z]/i.test(t));
  // 3+ alphabetic word-tokens, or very long → treat as a slug/name.
  return wordTokens.length >= 3 || s.length > 40;
}

/**
 * Recover the product's FEED id from page markup — used only when the
 * JSON-LD node carries no structured feed id (sku/productID/offers.sku).
 * Scoped to schema.org's canonical main-product signal `<meta
 * itemprop="productID">` (singular, in <head>). Deliberately does NOT
 * scan inline JSON / data-* attributes: those first-match anywhere and
 * can bind a related-items carousel / dataLayer id for a DIFFERENT
 * product, corrupting the dedup + feed key. Returns the id or null.
 */
function extractProductIdFromHtml(html) {
  return metaContent(html, ['itemprop'], 'productid');
}

// ── <meta> reader ──────────────────────────────────────────────────
//
// Read a <meta> tag's `content` by matching one of its identifying
// attributes (property / name / itemprop). Whole tags are scanned first,
// then each attribute is read with ITS OWN delimiter.
//
// The previous one-shot patterns (`["']([^"']+)["']`) truncated any
// double-quoted value containing an apostrophe — `content="Nate's 33&quot;
// Table"` came back as `Nate` — and only matched the two attribute
// orderings that were spelled out. Values are entity-decoded on the way
// out: attribute values are ALWAYS character-reference-encoded in HTML, so
// `33&quot;` here is the encoding of a plain `33"`.
// Source string, not a shared /g regex — a stateful lastIndex across calls
// would make results depend on call order.
const META_TAG_SRC = '<meta\\b[^>]*>';

function readTagAttr(tag, name) {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'\`=<>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return null;
  const raw = m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
  return raw == null ? null : raw;
}

function metaContent(html, idAttrs, wantedValue) {
  if (!html || typeof html !== 'string') return null;
  const want = String(wantedValue).toLowerCase();
  const re = new RegExp(META_TAG_SRC, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    let hit = false;
    for (const attr of idAttrs) {
      const v = readTagAttr(tag, attr);
      if (v != null && v.trim().toLowerCase() === want) { hit = true; break; }
    }
    if (!hit) continue;
    const content = readTagAttr(tag, 'content');
    const cleaned = cleanScrapedText(content);
    if (cleaned) return cleaned;
  }
  return null;
}

// Normalize a possibly-localized numeric string to a canonical JS number
// string ("1234.56"). Handles US ("1,499.00") and EU ("1.499,00" /
// "1499,00") thousands/decimal conventions: when both separators are
// present the LAST one is the decimal; a lone separator is treated as the
// decimal only when it has 1-2 trailing digits, otherwise as a thousands
// separator. Returns '' when no digits are present.
function toCanonicalNumber(raw) {
  let t = String(raw).replace(/[^\d.,]/g, '');
  if (!/\d/.test(t)) return '';
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let dec = null;
  if (lastComma > -1 && lastDot > -1) {
    dec = lastComma > lastDot ? ',' : '.';
  } else if (lastComma > -1) {
    const parts = t.split(',');
    dec = (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) ? ',' : null;
  } else if (lastDot > -1) {
    const parts = t.split('.');
    dec = (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) ? '.' : null;
  }
  if (dec === ',') t = t.replace(/\./g, '').replace(',', '.');
  else if (dec === '.') t = t.replace(/,/g, '');
  else t = t.replace(/[.,]/g, '');   // no decimal → separators are thousands
  return t;
}

// MONEY-CRITICAL: JSON-LD price is MAJOR units. Do NOT /100. Returns null
// (never 0) for non-numeric junk like "Call for Price"/"TBD" — Number('')
// is 0, which would otherwise store a fake $0 price.
function parseMajorPrice(val) {
  if (val == null || val === '') return null;
  const cleaned = toCanonicalNumber(val);
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function mapAvailability(raw) {
  if (raw == null) return null;
  const s = String(raw);
  if (/InStock|InStoreOnly|PreOrder|BackOrder/i.test(s)) return 'in stock';
  if (/OutOfStock|SoldOut|Discontinued/i.test(s)) return 'out of stock';
  return null;
}

// schema.org category can be a string, a Thing/{name} object, or an
// array (breadcrumb-style). Normalize to a single string (last/most-
// specific segment for arrays) or null.
function categoryOf(cat) {
  if (cat == null) return null;
  if (typeof cat === 'string') return cleanScrapedText(cat);
  if (Array.isArray(cat)) {
    const parts = cat.map(categoryOf).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }
  if (typeof cat === 'object') {
    return cat.name != null ? cleanScrapedText(cat.name) : null;
  }
  return null;
}

function brandNameOf(node) {
  if (!node) return null;
  const b = node.brand;
  if (b == null) return null;
  if (typeof b === 'string') return cleanScrapedText(b);
  if (typeof b === 'object') {
    return b.name != null ? cleanScrapedText(b.name) : null;
  }
  return null;
}

function pickGtin(node) {
  if (!node) return null;
  const candidates = [
    node.gtin,
    node.gtin13,
    node.gtin12,
    node.gtin14,
    node.gtin8,
    node.productID,
    node.isbn
  ];
  for (const c of candidates) {
    const g = ingestHelpers.normalizeGtin(c);
    if (g) return g;
  }
  return null;
}

function capRawData(node) {
  try {
    const s = JSON.stringify(node);
    if (s.length <= RAW_DATA_CAP_BYTES) return node;
    return { _truncated: s.slice(0, RAW_DATA_CAP_BYTES) };
  } catch {
    return { _truncated: String(node).slice(0, RAW_DATA_CAP_BYTES) };
  }
}

function firstOffer(offers) {
  if (offers == null) return null;
  if (Array.isArray(offers)) {
    // Prefer the lowest POSITIVE price across Offers. A $0/blank offer
    // (sold-out / "call for price" variant) must NOT beat a real one —
    // 0 is numerically the minimum, so guard on p > 0. Fall back to the
    // first valid offer object when none carry a positive price.
    let best = null;
    let bestPrice = Infinity;
    for (const o of offers) {
      if (!o || typeof o !== 'object') continue;
      if (!best) best = o;
      const p = parseMajorPrice(o.price != null ? o.price : o.lowPrice);
      if (p != null && p > 0 && p < bestPrice) {
        bestPrice = p;
        best = o;
      }
    }
    return best;
  }
  if (typeof offers === 'object') return offers;
  return null;
}

function priceFromOffers(offers) {
  const o = firstOffer(offers);
  if (!o) return { price: null, currency: null, availability: null };
  // AggregateOffer uses lowPrice; Offer uses price
  const types = nodeTypes(o);
  const isAgg = types.some(t => /aggregateoffer/i.test(t)) || (o.lowPrice != null && o.price == null);
  // MONEY-CRITICAL: major units, no /100
  const rawPrice = parseMajorPrice(isAgg ? (o.lowPrice ?? o.price) : (o.price ?? o.lowPrice));
  // Treat 0 / negative as "no usable price" (don't store a fake $0).
  const price = (rawPrice != null && rawPrice > 0) ? rawPrice : null;
  const currency = o.priceCurrency || o.currency || null;
  const availability = mapAvailability(o.availability);
  return {
    price,
    currency: currency ? String(currency) : null,
    availability
  };
}

function imagesFromNode(node, pageUrl) {
  const raw = node.image;
  const list = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      const a = absUrl(v, pageUrl);
      if (a) list.push(a);
      return;
    }
    if (typeof v === 'object') {
      const u = v.url || v.contentUrl || v['@id'] || null;
      const a = absUrl(u, pageUrl);
      if (a) list.push(a);
    }
  };
  if (Array.isArray(raw)) {
    for (const item of raw) push(item);
  } else {
    push(raw);
  }
  const uniq = [];
  const seen = new Set();
  for (const u of list) {
    if (seen.has(u)) continue;
    seen.add(u);
    uniq.push(u);
  }
  return {
    imageUrl: uniq[0] || null,
    // index 0 is the hero (imageUrl); slice starts at 1 so the hero is
    // never also stored as an alt. Cap = MAX_ADDITIONAL_IMAGES alts
    // (end exclusive → 1 + N). Shared const — see top of file.
    additionalImages: uniq.slice(1, 1 + MAX_ADDITIONAL_IMAGES)
  };
}

// Reviews come from the shared engine (services/productReviewsScrapeService)
// so this path, the Shopify path and the Meta-catalog path all capture the
// same fields: per-review STARS + headline + date, positive-ranked, scale-
// normalized aggregate. Previously this kept { text, author } for the first
// ten reviews in document order and dropped reviewRating entirely.
function reviewsFromNode(node) {
  const extracted = reviewsEngine.reviewsFromProductNode(node, { source: 'store' });
  const productReviews = reviewsEngine.buildProductReviews(extracted);
  return { rating: extracted.rating, productReviews };
}

// The offer-level sku, if present (some sites carry the feed id there).
function offerSku(offers) {
  const o = firstOffer(offers);
  if (o && o.sku != null && String(o.sku).trim()) return String(o.sku).trim();
  return null;
}

/**
 * Resolve the product's FEED id — the identifier a Shopify / Google
 * Merchant Center feed uses as its `id` attribute, so this catalog can
 * later drive supplemental feeds that join on it. Priority is the common
 * per-product identifier: sku → productID → offers.sku. mpn/gtin are
 * deliberately EXCLUDED (they are separate feed attributes that repeat
 * across variants — using them as the id would silently merge distinct
 * products). URL-derived id is a strict last resort.
 */
function resolveFeedId(node, pageUrl) {
  const cands = [node.sku, node.productID, node.productId, offerSku(node.offers)];
  for (const c of cands) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  return extractNumericIdFromUrl(node.url) || extractNumericIdFromUrl(pageUrl) || null;
}

/**
 * mapJsonLdProduct(node, pageUrl, explicitId?) → flat product | null
 * explicitId, when supplied, overrides id resolution (used by the
 * resolver's on-page feed-id recovery when the node lacks a structured id).
 */
function mapJsonLdProduct(node, pageUrl, explicitId = null) {
  if (!node || typeof node !== 'object') return null;

  const gtin = pickGtin(node);
  const mpn = node.mpn != null ? String(node.mpn).trim() || null : null;
  const externalId = (explicitId != null && String(explicitId).trim())
    ? String(explicitId).trim()
    : resolveFeedId(node, pageUrl);
  if (!externalId) return null;

  // Entity-decoded: a `33&quot;` in the JSON-LD name must land as `33"`.
  const title = node.name != null
    ? cleanScrapedText(node.name)
    : (node.title != null ? cleanScrapedText(node.title) : null);
  const descriptionRaw = node.description != null ? node.description : null;
  const description = descriptionRaw != null
    ? ingestHelpers.stripHtml(String(descriptionRaw), 2000)
    : null;

  const { price, currency, availability: offerAvail } = priceFromOffers(node.offers);
  const availability = offerAvail || mapAvailability(node.availability);
  const { imageUrl, additionalImages } = imagesFromNode(node, pageUrl);
  const productUrl = absUrl(node.url || node['@id'] || pageUrl, pageUrl) || pageUrl || null;
  const category = categoryOf(node.category);
  const { rating, productReviews } = reviewsFromNode(node);

  return {
    externalId: String(externalId),
    title: title || null,
    description,
    brand: brandNameOf(node),
    price,
    currency,
    availability,
    imageUrl,
    additionalImages,
    productUrl,
    gtin,
    mpn,
    category: category ? String(category).slice(0, 500) : null,
    rating,
    productReviews,
    rawData: capRawData(node),
    _lastmod: null
  };
}

/**
 * mapOgProduct(html, pageUrl) → partial flat product | null
 * Fallback when no Product JSON-LD. Requires og:title at minimum.
 */
function mapOgProduct(html, pageUrl) {
  if (!html || typeof html !== 'string') return null;

  // Attribute-order agnostic, delimiter-aware, entity-decoded — see
  // metaContent(). og:title carries the same `&quot;` inch marks as the
  // JSON-LD name on sites that escape their markup.
  const meta = (prop) => metaContent(html, ['property', 'name'], prop);

  const title = meta('og:title');
  if (!title) return null;

  const image = meta('og:image');
  const ogUrl = meta('og:url');
  const priceAmount = meta('product:price:amount') || meta('og:price:amount');
  const currency = meta('product:price:currency') || meta('og:price:currency');
  // MONEY-CRITICAL: major units; treat 0/negative as no-price (parity with
  // the JSON-LD offer path — never store a fake $0).
  const ogPrice = parseMajorPrice(priceAmount);
  const price = (ogPrice != null && ogPrice > 0) ? ogPrice : null;
  const externalId = extractNumericIdFromUrl(ogUrl || pageUrl);
  if (!externalId) return null;

  const imageUrl = absUrl(image, pageUrl);
  const productUrl = absUrl(ogUrl || pageUrl, pageUrl) || pageUrl;

  return {
    externalId: String(externalId),
    title,
    description: null,
    brand: null,
    price,
    currency: currency || null,
    availability: null,
    imageUrl,
    additionalImages: [],
    productUrl,
    gtin: null,
    mpn: null,
    category: null,
    rating: null,
    productReviews: null,
    rawData: { _source: 'open-graph', og: { title, image, ogUrl, priceAmount, currency } },
    _lastmod: null
  };
}

/**
 * validateProduct(p) → { valid, missing:[fieldNames] }
 * Required: non-empty externalId + title + (finite price OR imageUrl).
 */
function validateProduct(p) {
  const missing = [];
  if (!p || p.externalId == null || !String(p.externalId).trim()) {
    missing.push('externalId');
  }
  if (!p || p.title == null || !String(p.title).trim()) {
    missing.push('title');
  }
  const hasPrice = p && Number.isFinite(p.price);
  const hasImage = p && p.imageUrl && String(p.imageUrl).trim();
  if (!hasPrice && !hasImage) {
    // list both so callers see the either-or requirement failed
    if (!hasPrice) missing.push('price');
    if (!hasImage) missing.push('imageUrl');
  }
  return { valid: missing.length === 0, missing };
}

// ── sitemap fetch helpers ──────────────────────────────────────────

async function fetchXmlText(url) {
  const isGz = /\.gz($|\?)/i.test(url);
  if (isGz) {
    const res = await http.fetchBuffer(url, { maxBytes: 20_000_000 });
    if (res.cfChallenged) return { ok: false, cfChallenged: true, rateLimited: false, text: null };
    if (res.rateLimited) return { ok: false, cfChallenged: false, rateLimited: true, text: null };
    if (!res.ok || !res.buffer) {
      return { ok: false, cfChallenged: false, rateLimited: false, text: null, error: res.error };
    }
    try {
      // Cap DECOMPRESSED size (gzip-bomb guard): a small .gz can inflate to
      // GBs. maxOutputLength makes gunzipSync throw once the cap is hit.
      const text = zlib.gunzipSync(res.buffer, { maxOutputLength: GZIP_MAX_OUTPUT_BYTES }).toString('utf8');
      return { ok: true, text, cfChallenged: false, rateLimited: false };
    } catch (err) {
      return { ok: false, cfChallenged: false, rateLimited: false, text: null, error: err.message };
    }
  }

  const res = await http.fetchText(url, { maxBytes: 8_000_000 });
  if (res.cfChallenged) return { ok: false, cfChallenged: true, rateLimited: false, text: null };
  if (res.rateLimited) return { ok: false, cfChallenged: false, rateLimited: true, text: null };
  if (!res.ok || !res.text) {
    return { ok: false, cfChallenged: false, rateLimited: false, text: null, error: res.error };
  }
  return { ok: true, text: res.text, cfChallenged: false, rateLimited: false };
}

async function discoverSitemapUrls(origin, abortCheck = async () => false) {
  const discovered = [];
  const seen = new Set();               // O(1) dedup (not .includes O(n^2))
  const add = (u) => { if (u && !seen.has(u)) { seen.add(u); discovered.push(u); } };
  let crawlDelayMs = 0;
  let cfChallenges = 0;
  let rateLimited = false;

  // 1. robots.txt
  try {
    const robotsUrl = `${origin}/robots.txt`;
    const res = await http.fetchText(robotsUrl, { timeoutMs: 15000 });
    if (res.cfChallenged) cfChallenges += 1;
    if (res.rateLimited) rateLimited = true;
    if (res.ok && res.text) {
      const parsed = parseRobotsForSitemaps(res.text, '*');
      crawlDelayMs = parsed.crawlDelayMs || 0;
      for (const u of parsed.sitemaps) add(u);
    }
  } catch (err) {
    console.warn(`   ⚠️  ${LOG}  robots.txt fetch error: ${err.message}`);
  }

  // 2. fallback well-known paths when robots yields nothing
  if (!discovered.length && !(await abortCheck())) {
    for (const path of FALLBACK_SITEMAP_PATHS) {
      if (await abortCheck()) break;
      const url = `${origin}${path}`;
      try {
        const got = await fetchXmlText(url);
        if (got.cfChallenged) cfChallenges += 1;
        if (got.rateLimited) rateLimited = true;
        if (got.ok && got.text && /<loc[\s>]/i.test(got.text)) add(url);
      } catch (err) {
        console.warn(`   ⚠️  ${LOG}  fallback sitemap ${url}: ${err.message}`);
      }
    }
  }

  return { sitemaps: discovered, crawlDelayMs, cfChallenges, rateLimited };
}

/**
 * Walk sitemap indexes → urlsets (depth ≤ 2). Streams product-page
 * candidates ranked product-ish first, lastmod desc.
 * Returns { pageEntries:[{loc,lastmod}], sitemapsWalked, cfChallenges, rateLimited }.
 */
async function walkSitemaps(rootSitemaps, { abortCheck, maxUrls }) {
  const pageEntries = [];
  const seenLoc = new Set();
  const seenSitemaps = new Set();   // dedup index/sub-sitemap URLs (loop + DoS guard)
  let sitemapsWalked = 0;
  let sitemapFetches = 0;
  let cfChallenges = 0;
  let rateLimited = false;
  let aborted = false;

  // Fetch a sitemap document at most once, bounded by MAX_SITEMAP_FETCHES.
  // Prevents a self-referential / diamond index graph from forcing an
  // unbounded number of outbound requests.
  async function fetchSitemapOnce(url) {
    if (!url || seenSitemaps.has(url)) return null;
    if (sitemapFetches >= MAX_SITEMAP_FETCHES) return null;
    seenSitemaps.add(url);
    sitemapFetches += 1;
    try {
      return await fetchXmlText(url);
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  sitemap fetch ${url}: ${err.message}`);
      return null;
    }
  }

  const queue = rootSitemaps.map(url => ({ url, depth: 0 }));
  const rankedSubs = []; // product-ish sub-sitemaps first
  const otherSubs = [];

  // Pass 1: expand indexes, rank sub-sitemaps
  while (queue.length) {
    if (await abortCheck()) { aborted = true; break; }
    if (sitemapFetches >= MAX_SITEMAP_FETCHES) break;
    const { url, depth } = queue.shift();
    if (!url || depth > MAX_SITEMAP_DEPTH) continue;

    const got = await fetchSitemapOnce(url);
    if (!got) continue;
    if (got.cfChallenged) { cfChallenges += 1; continue; }
    if (got.rateLimited) { rateLimited = true; break; }
    if (!got.ok || !got.text) continue;

    sitemapsWalked += 1;
    const parsed = parseSitemapXml(got.text);

    if (parsed.type === 'index' && depth < MAX_SITEMAP_DEPTH) {
      const entries = parsed.entries.slice().sort((a, b) => rankLoc(a.loc) - rankLoc(b.loc));
      for (const e of entries) {
        if (!e.loc || seenSitemaps.has(e.loc)) continue;
        // Product-ish first (rankLoc < 0 ⇔ scoreProductish > 0).
        if (rankLoc(e.loc) < 0) rankedSubs.push({ url: e.loc, depth: depth + 1 });
        else otherSubs.push({ url: e.loc, depth: depth + 1 });
      }
    } else {
      // urlset (or index at max depth treated as leaf locs)
      for (const e of parsed.entries) {
        if (!e.loc || seenLoc.has(e.loc)) continue;
        // Skip nested sitemap pointers that look like .xml when we're at a urlset mis-detect
        if (/\.xml(\.gz)?$/i.test(e.loc) && depth < MAX_SITEMAP_DEPTH && parsed.type === 'index') {
          continue;
        }
        seenLoc.add(e.loc);
        pageEntries.push({ loc: e.loc, lastmod: e.lastmod || null });
        if (pageEntries.length >= maxUrls) break;
      }
    }
    if (pageEntries.length >= maxUrls) break;
  }

  // Pass 2: walk ranked sub-sitemaps then others until maxUrls / fetch cap
  const subQueue = rankedSubs.concat(otherSubs);
  for (const item of subQueue) {
    if (pageEntries.length >= maxUrls) break;
    if (sitemapFetches >= MAX_SITEMAP_FETCHES) break;
    if (await abortCheck()) { aborted = true; break; }
    if (item.depth > MAX_SITEMAP_DEPTH) continue;

    const got = await fetchSitemapOnce(item.url);
    if (!got) continue;
    if (got.cfChallenged) { cfChallenges += 1; continue; }
    if (got.rateLimited) { rateLimited = true; break; }
    if (!got.ok || !got.text) continue;

    sitemapsWalked += 1;
    const parsed = parseSitemapXml(got.text);

    if (parsed.type === 'index' && item.depth < MAX_SITEMAP_DEPTH) {
      // one more level of nesting
      for (const e of parsed.entries) {
        if (!e.loc || seenSitemaps.has(e.loc)) continue;
        subQueue.push({ url: e.loc, depth: item.depth + 1 });
      }
      continue;
    }

    for (const e of parsed.entries) {
      if (!e.loc || seenLoc.has(e.loc)) continue;
      seenLoc.add(e.loc);
      pageEntries.push({ loc: e.loc, lastmod: e.lastmod || null });
      if (pageEntries.length >= maxUrls) break;
    }
  }

  // Rank: product-ish first, then lastmod desc (freshest fills the cap)
  pageEntries.sort((a, b) => {
    const r = rankLoc(a.loc) - rankLoc(b.loc);
    if (r !== 0) return r;
    return lastmodMs(b.lastmod) - lastmodMs(a.lastmod);
  });

  return { pageEntries, sitemapsWalked, cfChallenges, rateLimited, aborted };
}

// ── main resolve ───────────────────────────────────────────────────

/**
 * resolveGenericCatalog(brand, { run, abortCheck, cap })
 * → { ok, mode:'sitemap-jsonld', origin, products:[flat], stats, rateLimited?, reason?, warnings? }
 */
async function resolveGenericCatalog(brand, { run = null, abortCheck = async () => false, cap = DEFAULT_CAP } = {}) {
  const stats = {
    sitemapsDiscovered: 0,
    sitemapsWalked: 0,
    urlsScanned: 0,
    jsonLdProductsFound: 0,
    ogFallbackUsed: 0,
    validationFailures: 0,
    cfChallenges: 0,
    duplicatesSkipped: 0
  };
  const warnings = [];
  const products = [];
  const seenIds = new Set();
  let rateLimited = false;

  const origin = ingestHelpers.resolveStoreOrigin(brand);
  if (!origin) {
    return {
      ok: false,
      mode: 'sitemap-jsonld',
      origin: null,
      products: [],
      stats,
      reason: 'no catalog URL configured on brand'
    };
  }

  const effectiveCap = Math.max(1, parseInt(cap, 10) || DEFAULT_CAP);
  console.log(`${LOG}  resolveGenericCatalog: origin=${origin} cap=${effectiveCap}`);
  run?.stage?.('discovering sitemaps');
  run?.note?.(`generic catalog discovery @ ${origin}`);

  // ── Discover sitemaps ────────────────────────────────────────────
  const disc = await discoverSitemapUrls(origin, abortCheck);
  stats.sitemapsDiscovered = disc.sitemaps.length;
  stats.cfChallenges += disc.cfChallenges || 0;
  if (disc.rateLimited) rateLimited = true;
  const crawlDelayMs = disc.crawlDelayMs || 0;
  const pdpGapMs = Math.max(crawlDelayMs - 250, 0);

  if (!disc.sitemaps.length) {
    const reason = `no sitemaps found at ${origin} — site does not expose XML sitemaps`;
    console.warn(`   ⚠️  ${LOG}  ${reason}`);
    return {
      ok: false,
      mode: 'sitemap-jsonld',
      origin,
      products: [],
      stats,
      rateLimited,
      reason
    };
  }

  console.log(`   · ${LOG}  discovered ${disc.sitemaps.length} sitemap(s), crawlDelayMs=${crawlDelayMs}`);

  if (await abortCheck()) {
    return {
      ok: false,
      mode: 'sitemap-jsonld',
      origin,
      products: [],
      stats,
      reason: 'aborted during sitemap discovery',
      cancelled: true
    };
  }

  // ── Walk sitemaps → ranked page URLs ─────────────────────────────
  const walked = await walkSitemaps(disc.sitemaps, {
    abortCheck,
    maxUrls: MAX_SITEMAP_URLS
  });
  stats.sitemapsWalked = walked.sitemapsWalked;
  stats.cfChallenges += walked.cfChallenges || 0;
  if (walked.rateLimited) rateLimited = true;

  // Cancel during the walk must read as cancelled, not "no product URLs".
  if (walked.aborted) {
    return {
      ok: false,
      mode: 'sitemap-jsonld',
      origin,
      products: [],
      stats,
      rateLimited,
      cancelled: true,
      reason: 'aborted during sitemap walk'
    };
  }

  const pageEntries = walked.pageEntries || [];
  if (!pageEntries.length) {
    const reason = 'sitemaps found but contained no product page URLs';
    console.warn(`   ⚠️  ${LOG}  ${reason}`);
    return {
      ok: false,
      mode: 'sitemap-jsonld',
      origin,
      products: [],
      stats,
      rateLimited,
      reason
    };
  }

  console.log(`   · ${LOG}  ${pageEntries.length} candidate URLs (scanning up to cap=${effectiveCap})`);
  run?.stage?.('scanning product pages');

  // ── PDP scan (bounded-parallel; parallel-fetch → serial-reduce) ──
  // Fetch+parse up to pdpConcurrency pages at once, then FOLD the outcomes
  // into shared state (stats / dedup / products) synchronously, in input
  // order — so cap, dedup and the empty-run stat counters stay exactly as
  // the old serial loop produced them. The old loop awaited each page to
  // completion (~1/response-time ≈ 0.5-1/s); httpScrapeClient's per-host
  // min-gap already serializes *starts* at ~1/gap (≈4/s), so several
  // fetches in flight lets the scan hit that ceiling instead of crawling
  // below it. Politeness is preserved: a site-declared crawl-delay
  // (pdpGapMs>0) forces serial + the inter-page sleep; only when the sole
  // spacing is the client's own min-gap do we parallelize.
  const pdpConcurrency = pdpGapMs > 0
    ? 1
    : require('./concurrency').concurrency.GENERIC_CATALOG_PDP_CONCURRENCY;

  // Fetch + parse ONE page. Pure w.r.t. scan state — returns an outcome
  // the reduce step applies; never touches stats/products/seenIds.
  const scanOnePdp = async ({ loc, lastmod }) => {
    let allowed = true;
    try { allowed = await http.isAllowedByRobots(loc); } catch { allowed = true; }
    if (!allowed) {
      console.log(`   · ${LOG}  robots disallows ${loc} — skip`);
      return { skipped: true };
    }

    let html = null;
    try {
      const res = await http.fetchText(loc, { timeoutMs: 15000, maxBytes: 4_000_000 });
      if (res.cfChallenged) return { cfChallenged: true };
      if (res.rateLimited)  return { rateLimited: true, loc };
      if (!res.ok || !res.text) return { skipped: true };
      html = res.text;
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  PDP fetch failed ${loc}: ${err.message}`);
      return { skipped: true };
    }

    let mapped = null;
    let jsonLdFound = false, ogUsed = false, idMiss = false;
    try {
      const nodes = extractJsonLdProducts(html);
      if (nodes.length) {
        jsonLdFound = true;
        for (const node of nodes) { mapped = mapJsonLdProduct(node, loc); if (mapped) break; }
        // Product node(s) present but no structured feed id → recover the
        // id from the page (canonical <meta itemprop=productID>) + re-map.
        if (!mapped) {
          const htmlId = extractProductIdFromHtml(html);
          if (htmlId) {
            for (const node of nodes) { mapped = mapJsonLdProduct(node, loc, htmlId); if (mapped) break; }
          }
          if (!mapped) idMiss = true;   // real id-resolution miss (counts as validationFailure)
        }
      }
      if (!mapped) { mapped = mapOgProduct(html, loc); if (mapped) ogUsed = true; }
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  extract failed ${loc}: ${err.message}`);
      return { jsonLdFound, skipped: true };
    }

    if (!mapped) return { jsonLdFound, ogUsed, idMiss };

    if (lastmod) mapped._lastmod = lastmod;

    // Capture the category breadcrumb from the SAME page HTML (avoids a
    // second per-product crawl by the post-sync inference pass).
    try {
      const bc = extractBreadcrumb(html);
      if (bc && Array.isArray(bc.breadcrumb) && bc.breadcrumb.length) {
        mapped.breadcrumb = bc.breadcrumb;
        mapped.breadcrumbSource = bc.source;
      }
    } catch { /* best-effort — inference pass will backfill on a miss */ }

    // Whole-page review sweep when the Product node alone came up short:
    // catches standalone Review nodes, a Product node the mapper skipped,
    // and itemprop-only aggregates. Also labels the review platform
    // (bazaarvoice / judge.me / yotpo / …) for provenance.
    if (mapped.rating == null || !mapped.productReviews) {
      try {
        const rev = reviewsEngine.extractOnPageReviews(html);
        if (rev.rating != null && mapped.rating == null) mapped.rating = rev.rating;
        if (!mapped.productReviews) {
          mapped.productReviews = reviewsEngine.buildProductReviews(rev);
        } else if (rev.platform && !mapped.productReviews.platform) {
          mapped.productReviews.platform = rev.platform;
        }
      } catch { /* best-effort */ }
    }

    if (!validateProduct(mapped).valid) return { jsonLdFound, ogUsed, idMiss, validationFailure: true };
    return { jsonLdFound, ogUsed, idMiss, mapped };
  };

  let aborted = false;
  let stop = false;
  for (let i = 0; i < pageEntries.length && !stop; i += pdpConcurrency) {
    if (products.length >= effectiveCap) break;
    if (stats.urlsScanned >= MAX_SITEMAP_URLS) break;
    if (await abortCheck()) { aborted = true; break; }
    // Respect a site-declared crawl-delay between (serial) chunks.
    if (i > 0 && pdpGapMs > 0) await sleep(pdpGapMs);

    const chunk = pageEntries.slice(i, i + pdpConcurrency);
    const outcomes = await Promise.all(chunk.map(scanOnePdp));

    // Serial reduce — mutate shared state in deterministic input order.
    for (const o of outcomes) {
      stats.urlsScanned += 1;
      run?.tick?.(
        products.length,
        effectiveCap,
        `scanned ${stats.urlsScanned} · found ${products.length}/${effectiveCap}`
      );
      if (o.rateLimited) {
        rateLimited = true;
        console.warn(`   ⚠️  ${LOG}  rate-limited at ${o.loc} — stopping PDP scan`);
        stop = true;
        break;
      }
      if (o.cfChallenged) { stats.cfChallenges += 1; continue; }
      if (o.jsonLdFound)  stats.jsonLdProductsFound += 1;
      if (o.idMiss)       stats.validationFailures += 1;
      if (o.ogUsed)       stats.ogFallbackUsed += 1;
      if (o.validationFailure) { stats.validationFailures += 1; continue; }
      if (o.skipped || !o.mapped) continue;

      const idKey = String(o.mapped.externalId);
      if (seenIds.has(idKey)) { stats.duplicatesSkipped += 1; continue; }
      seenIds.add(idKey);
      products.push(o.mapped);
      if (products.length >= effectiveCap) { stop = true; break; }
    }
  }

  // Aborted mid-scan — return truthfully as cancelled (keeping any
  // partials) rather than misclassifying it as an unscrapeable site.
  if (aborted) {
    return {
      ok: products.length > 0,
      mode: 'sitemap-jsonld',
      origin,
      products,
      stats,
      rateLimited,
      cancelled: true,
      reason: 'aborted during product scan'
    };
  }

  // ── Decisive unscrapeable / partial outcomes ─────────────────────
  if (!products.length) {
    let reason;
    if (stats.cfChallenges > 0 && stats.jsonLdProductsFound === 0 && stats.ogFallbackUsed === 0) {
      reason = `blocked by Cloudflare challenge on ${origin}`;
    } else if (stats.jsonLdProductsFound === 0 && stats.ogFallbackUsed === 0) {
      // No product structured data found on any scanned page.
      reason =
        `scanned ${stats.urlsScanned} pages but none exposed schema.org Product (JSON-LD) ` +
        `or Open Graph product data — this site is not scrapeable via the sitemap+JSON-LD method`;
    } else if (stats.validationFailures > 0) {
      // Product data WAS found, but none yielded a usable feed id + the
      // required fields (title + price/image).
      reason =
        `found ${stats.validationFailures} product page(s) with structured data but none had a ` +
        `usable feed id + required fields (title + price/image) — check the site's JSON-LD completeness`;
    } else if (rateLimited) {
      reason = `rate-limited while scanning ${origin}`;
    } else {
      reason =
        `scanned ${stats.urlsScanned} pages but no products could be extracted ` +
        `via the sitemap+JSON-LD method`;
    }
    console.warn(`   ⚠️  ${LOG}  ${reason}`);
    return {
      ok: false,
      mode: 'sitemap-jsonld',
      origin,
      products: [],
      stats,
      rateLimited,
      reason
    };
  }

  if (stats.validationFailures > 0) {
    warnings.push(`${stats.validationFailures} product pages failed validation (skipped)`);
  }
  if (stats.cfChallenges > 0) {
    warnings.push(`${stats.cfChallenges} Cloudflare challenge(s) encountered`);
  }

  console.log(
    `${LOG}  resolveGenericCatalog ok: n=${products.length} ` +
    `scanned=${stats.urlsScanned} jsonLd=${stats.jsonLdProductsFound} ` +
    `og=${stats.ogFallbackUsed} invalid=${stats.validationFailures} cf=${stats.cfChallenges}`
  );

  const out = {
    ok: true,
    mode: 'sitemap-jsonld',
    origin,
    products,
    stats,
    rateLimited
  };
  if (warnings.length) out.warnings = warnings;
  return out;
}

module.exports = {
  resolveGenericCatalog,
  parseRobotsForSitemaps,
  parseSitemapXml,
  extractJsonLdProducts,
  mapJsonLdProduct,
  mapOgProduct,
  validateProduct,
  // pure helpers exported for unit tests
  extractNumericIdFromUrl,
  looksLikeSlug,
  extractProductIdFromHtml,
  parseMajorPrice,
  rankLoc,
  isProductish,
  scoreProductish,
  DEFAULT_CAP,
  MAX_SITEMAP_URLS
};
