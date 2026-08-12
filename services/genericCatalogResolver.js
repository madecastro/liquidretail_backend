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
// per-host throttle, 429/Retry-After, CF detection). Image-URL upgrade
// may issue a HEAD (or ranged GET) via the same client to verify that a
// stripped Shopify/WP size token is a real original — see imageUrlUpgrade.

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
// Category options from sitemap URL path segments — pure, no PDP fetches.
// Used for discover-only previews and selective import filters on large catalogs.
const {
  deriveCategoryOptions,
  matchesAnyCategory
} = require('./genericCatalogDiscovery/categoryOptions');
// Wall-clock budget — pure, clock-injectable. Bounds the scan so a large
// or hostile site cannot grind for ~83 min while the UI shows a dead run.
// Distinct from abort (user cancel) and from progressService.MAX_RUN_MS
// (dead-process safety net for the heartbeat only).
const { createBudget } = require('./genericCatalogDiscovery/budget');
// Platform fingerprint (pure) — senses Shopify etc. from pre-fetched
// homepage + robots so the generic path can climb the right ladder.
const { fingerprintSite } = require('./siteFingerprintService');
// Per-host browser-cleared session cache (Cookie + pinned UA). Used only
// after the cheap path fails a browser-fixable block — most syncs never
// touch Chrome. See scrapeSession.js for host keying (not eTLD+1).
const scrapeSession = require('./scrapeSession');
// Thumbnail → original image URL upgrade (defence in depth when JSON-LD/OG
// emit a resized asset). Pure transform + HEAD-verified resolve. Flag-off
// is byte-identical: no upgrades, no HEADs.
const {
  isCatalogImageUpgradeEnabled,
  createImageUpgradeRun,
  makeHttpScrapeFetchHead,
  dedupeUrlsFirstSeen,
  upgradeImageUrl,
  isShopifyCdnUrl
} = require('./imageUrlUpgrade');

// ── constants ──────────────────────────────────────────────────────
const LOG = '🗺';
// Auto-detect Shopify (and other platforms for telemetry) before the
// sitemap+JSON-LD walk. Default ON: brands on method=generic-sitemap that
// are actually Shopify were storing ZERO alt images (Shopify JSON-LD only
// ships the featured image; products.json has the full gallery — measured
// on pb5star.com 2026-08-10: 100 products, 0 alts via JSON-LD; products.json
// mean 7.91 images). Flag-off restores byte-identical prior behaviour:
// no homepage fetch, no fingerprint, no new result keys.
const AUTODETECT_ENABLED = process.env.GENERIC_CATALOG_AUTODETECT !== 'false';
// Per-PDP Shopify gallery enrichment on the JSON-LD fallthrough path.
// Shopify JSON-LD Product.image is a 1-element `_small` array — so even
// with size-suffix stripping the hero upgrades, additionalImages stays
// empty and the 12/20-image cap is a no-op. When the PDP URL is
// /products/{handle}, fetch the same `{origin}/products/{handle}.js`
// endpoint shopifyPublicIngestService already uses (full-resolution
// multi-image list). Default ON. Flag-off = no extra request, JSON-LD
// images only (still upgraded by imageUrlUpgrade). Safe: any miss/error
// keeps the JSON-LD seed. "Never worse" is enforced by count in
// preferShopifyGallery, not merely by the miss/error paths — a SUCCESSFUL
// but thinner gallery must not replace a richer JSON-LD list.
const SHOPIFY_GALLERY_ENRICH_ENABLED =
  String(process.env.GENERIC_CATALOG_SHOPIFY_GALLERY || 'true').toLowerCase() !== 'false';
// Last-rung browser + session reuse. Default ON, but Chrome launches ONLY
// when the cheap HTTP path already failed for a reason a browser can fix
// (CF / PX / DataDome browser-session remedy, Shopify ladder fallthrough,
// or zero sitemap candidates while robots was reachable). WHY (measured
// 2026-08-10): ubeauty.com yields 0 products — Shopify behind Cloudflare
// managed challenge; /products.json + sitemaps all 403 with
// cf-mitigated:challenge; a real browser clears the interstitial and an
// in-page same-origin fetch('/products.json?limit=250') returns all 103
// products. Flag-off = no browser launch, no session replay.
const RENDER_GENERIC_ENABLED =
  String(process.env.RENDER_GENERIC_ENABLED || 'true').toLowerCase() !== 'false';
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
// Wall-clock budgets (ms). Non-finite / ≤0 → unbounded (createBudget safety).
const TOTAL_BUDGET_MS = parseInt(process.env.GENERIC_CATALOG_TOTAL_BUDGET_MS, 10);
const SITEMAP_BUDGET_MS = parseInt(process.env.GENERIC_CATALOG_SITEMAP_BUDGET_MS, 10);
const GZIP_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;  // decompressed sitemap cap
const MAX_ROBOTS_SITEMAPS = 50;                  // cap root sitemaps from robots.txt
const RAW_DATA_CAP_BYTES = 8000;
// How many category keys to name in an operator-facing reason string. Log
// cosmetics only — deliberately NOT a bare slice(0, 8), because
// verifyCatalogImageCaps greps this file for hardcoded image-cap slices and a
// literal here is indistinguishable from the bug that guard exists to catch.
const MAX_LOGGED_CATEGORY_KEYS = 8;
const FALLBACK_SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];
// Category options from sitemap URLs (no PDP fetches). Flag-off restores a
// byte-identical resolver result (no new keys). Defaults match owner request
// for selective import of large catalogs (fanatics-scale ~800k products).
const CATEGORY_OPTIONS_ENABLED = process.env.GENERIC_CATALOG_CATEGORY_OPTIONS !== 'false';
const CATEGORY_PROMPT_MIN = Math.max(
  1,
  parseInt(process.env.GENERIC_CATALOG_CATEGORY_PROMPT_MIN, 10) || 500
);
const CATEGORY_MIN_COUNT = Math.max(
  1,
  parseInt(process.env.GENERIC_CATALOG_CATEGORY_MIN_COUNT, 10) || 25
);
const CATEGORY_MAX_OPTIONS = Math.max(
  1,
  parseInt(process.env.GENERIC_CATALOG_CATEGORY_MAX_OPTIONS, 10) || 40
);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** True when classifyBlock says a browser-cleared session can help. */
function isBrowserSessionRemedy(block) {
  if (!block || block.remedy == null) return false;
  return String(block.remedy).startsWith('browser-session');
}

/** Record vendor/remedy on stats; flip browserSessionBlockSeen when applicable. */
function noteBlock(stats, block) {
  if (!stats || !block) return;
  stats.lastBlockVendor = block.vendor || stats.lastBlockVendor || null;
  stats.lastBlockRemedy = block.remedy || stats.lastBlockRemedy || null;
  if (isBrowserSessionRemedy(block)) {
    stats.browserSessionBlockSeen = true;
  }
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

/**
 * imagesFromNode(node, pageUrl, opts?) → { imageUrl, additionalImages }
 *
 * Collects image URLs from a JSON-LD Product node, absolutizes them, then:
 *   - CATALOG_IMAGE_UPGRADE_ENABLED + opts.upgradeRun → upgrade each URL
 *     (HEAD-verified) and de-dupe AFTER upgrade (a `_small` and a
 *     `_1024x1024` of the same photo collapse to one original; first-seen
 *     order preserved because feedIndex is stamped from position).
 *   - Flag-off OR no upgradeRun → exact-URL de-dupe only (byte-identical
 *     prior path; no HEADs). Offline harnesses call without upgradeRun.
 *
 * Async so the HEAD path can run; always returns a Promise.
 */
async function imagesFromNode(node, pageUrl, opts = {}) {
  opts = opts || {};
  const raw = node && node.image;
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

  let uniq;
  if (
    isCatalogImageUpgradeEnabled() &&
    opts.upgradeRun &&
    typeof opts.upgradeRun.upgradeList === 'function'
  ) {
    // Upgrade first, de-dupe second — collapse is the point.
    uniq = await opts.upgradeRun.upgradeList(list);
  } else {
    // Exact-URL de-dupe only (flag-off / pure offline callers).
    uniq = dedupeUrlsFirstSeen(list);
  }

  return {
    imageUrl: uniq[0] || null,
    // index 0 is the hero (imageUrl); slice starts at 1 so the hero is
    // never also stored as an alt. Cap = MAX_ADDITIONAL_IMAGES alts
    // (end exclusive → 1 + N). Shared const — see top of file.
    additionalImages: uniq.slice(1, 1 + MAX_ADDITIONAL_IMAGES)
  };
}

/**
 * extractShopifyProductHandle(pageUrl) → handle | null
 *
 * Pure. Matches `/products/{handle}` and `/collections/{c}/products/{handle}`.
 * Rejects handles that look like API suffixes (`products.json`, `products.js`)
 * so we never fetch `/products/products.js.js`. Non-Shopify hosts with a
 * coincidental path shape still return a handle — the subsequent fetch is
 * fail-soft (404 → keep JSON-LD images).
 */
function extractShopifyProductHandle(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return null;
  try {
    const u = new URL(pageUrl);
    const m = (u.pathname || '').match(/\/products\/([^/]+)\/?$/i);
    if (!m) return null;
    let handle;
    try {
      handle = decodeURIComponent(m[1]).trim();
    } catch {
      handle = String(m[1]).trim();
    }
    if (!handle) return null;
    // Reject API-ish suffixes and empty / `.` names.
    if (/\.(?:js|json|xml|html?)$/i.test(handle)) return null;
    if (handle === '.' || handle === '..') return null;
    return handle;
  } catch {
    return null;
  }
}

/**
 * Absolutize a Shopify asset URL. products.json returns absolute https CDN
 * urls; the AJAX /products/<handle>.js endpoint often returns protocol-
 * relative (`//cdn.shopify.com/…`) strings.
 *
 * Returning the string unchanged when it is neither was a hole: a relative
 * `/cdn/shop/files/x.jpg` was stored as-is (an unfetchable seed), and a
 * `data:` / `javascript:` src was stored verbatim. These become catalog
 * image URLs and then ad seeds, so only http(s) may survive. Relative paths
 * resolve against the PDP url via the same absUrl() the JSON-LD path uses;
 * anything else is dropped.
 */
function absShopifyAssetUrl(u, pageUrl = null) {
  if (!u || typeof u !== 'string') return null;
  const s = u.trim();
  if (!s) return null;
  if (s.startsWith('//')) return 'https:' + s;
  if (/^https?:\/\//i.test(s)) return s;
  // Any other scheme (data:, javascript:, blob:, file:) is never a product
  // photo — drop rather than store. absUrl only resolves relative refs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  const abs = pageUrl ? absUrl(s, pageUrl) : null;
  return abs && /^https?:\/\//i.test(abs) ? abs : null;
}

/**
 * imagesFromShopifyProductPayload(payload) → { imageUrl, additionalImages }
 *
 * Pure. Accepts either the bare products/{handle}.js object OR the
 * `{ product: {...} }` wrapper from products/{handle}.json. Image list
 * order is feed order (do not sort). Cap via shared mapShopifyProductImages
 * → MAX_ADDITIONAL_IMAGES from catalogImageLimits (never hardcode).
 *
 * pageUrl is used only to resolve relative asset paths; without it a
 * relative src is dropped rather than stored unfetchable.
 */
function imagesFromShopifyProductPayload(payload, pageUrl = null) {
  const empty = { imageUrl: null, additionalImages: [] };
  if (!payload || typeof payload !== 'object') return empty;
  const p =
    payload.product && typeof payload.product === 'object'
      ? payload.product
      : payload;

  const list = [];
  const push = (src) => {
    const a = absShopifyAssetUrl(src, pageUrl);
    if (a) list.push({ src: a });
  };

  if (Array.isArray(p.images) && p.images.length) {
    for (const img of p.images) {
      if (typeof img === 'string') push(img);
      else if (img && typeof img === 'object') push(img.src || img.url || null);
    }
  } else if (Array.isArray(p.media) && p.media.length) {
    // .js media[] mixes image / video / external_video — keep images only,
    // preserve order (feedIndex load-bearing).
    for (const m of p.media) {
      if (!m) continue;
      if (typeof m === 'string') {
        push(m);
        continue;
      }
      const t = m.media_type || m.mediaType || null;
      if (t && t !== 'image') continue;
      push(m.src || m.url || (m.preview_image && m.preview_image.src) || null);
    }
  }

  if (!list.length && p.featured_image) {
    if (typeof p.featured_image === 'string') push(p.featured_image);
    else if (typeof p.featured_image === 'object') {
      push(p.featured_image.src || p.featured_image.url || null);
    }
  }

  if (!list.length) return empty;
  // Shared cap + feed-order split (hero = [0], alts = [1..cap]).
  return ingestHelpers.mapShopifyProductImages(list);
}

/**
 * preferShopifyGallery(jsonLd, shopify) → winning { imageUrl, additionalImages }
 *
 * Prefer the products.js gallery when it is at least as rich as the JSON-LD
 * result — that endpoint is the full-resolution multi-image source of truth
 * on Shopify (measured: marinelayer JSON-LD 1×_small vs .js 6 full-res).
 * Never drop a working JSON-LD seed, whether the gallery is empty, missing,
 * OR successful-but-thinner.
 */
function preferShopifyGallery(jsonLd, shopify) {
  const empty = { imageUrl: null, additionalImages: [] };
  const a = jsonLd && typeof jsonLd === 'object' ? jsonLd : empty;
  const b = shopify && typeof shopify === 'object' ? shopify : empty;
  const aAlts = Array.isArray(a.additionalImages) ? a.additionalImages : [];
  const bAlts = Array.isArray(b.additionalImages) ? b.additionalImages : [];
  const aCount = (a.imageUrl ? 1 : 0) + aAlts.length;
  const bCount = (b.imageUrl ? 1 : 0) + bAlts.length;
  // NEVER trade N images for fewer. Preferring any non-empty gallery
  // outright silently discarded JSON-LD alts whenever the gallery came back
  // thinner — reachable in production via a variant-scoped .js payload, a
  // media[] list that is mostly video, or a featured_image-only fallback.
  // The enrichment gate fires on a Shopify-CDN hero even when JSON-LD
  // already produced several alts, so this was a live regression for sites
  // that work today, not a theoretical one. Count is the tie-break: on a
  // real Shopify PDP the gallery is richer and still wins.
  if (b.imageUrl && bCount >= aCount) {
    return { imageUrl: b.imageUrl, additionalImages: bAlts };
  }
  return {
    imageUrl: a.imageUrl || null,
    additionalImages: aAlts
  };
}

/**
 * Should we spend a request on products/{handle}.js?
 *
 * TWO gates, and both must pass.
 *
 * 1. EVIDENCE the site is actually Shopify. A `/products/{handle}` path is
 *    NOT evidence — BigCommerce, headless and custom stores use it too, and
 *    the first production target of this resolver is a non-Shopify retailer.
 *    Treating the path shape as sufficient meant every single-image PDP on
 *    a non-Shopify host paid two 404s (.js then .json). At ~300 thin PDPs
 *    that is ~600 wasted requests against a domain-throttled crawl, inside
 *    a bounded total budget — it steals scan time from the actual walk.
 *    Accept either an explicit Shopify platform fingerprint, or a hero that
 *    lives on the Shopify image CDN / carries a strippable size suffix.
 *
 * 2. Something to GAIN: a thin gallery (no alts) or a hero that is still a
 *    sized thumbnail. A full-res hero that already has alts is left alone.
 */
function shouldEnrichShopifyGallery(pageUrl, current, opts = {}) {
  if (!SHOPIFY_GALLERY_ENRICH_ENABLED) return false;
  if (!extractShopifyProductHandle(pageUrl)) return false;
  const cur = current || {};
  const alts = Array.isArray(cur.additionalImages) ? cur.additionalImages : [];

  // ── gate 1: positive Shopify evidence ──
  let heroOnShopifyCdn = false;
  let heroIsSizedThumb = false;
  if (cur.imageUrl) {
    try {
      const upgraded = upgradeImageUrl(cur.imageUrl);
      if (upgraded && upgraded.upgraded) heroIsSizedThumb = true;
    } catch { /* not upgradeable */ }
    try {
      if (isShopifyCdnUrl(new URL(cur.imageUrl))) heroOnShopifyCdn = true;
    } catch { /* unparseable hero */ }
  }
  const isShopify = opts.platformIsShopify === true || heroOnShopifyCdn || heroIsSizedThumb;
  if (!isShopify) return false;

  // ── gate 2: something to gain ──
  return !cur.imageUrl || alts.length === 0 || heroIsSizedThumb;
}

/**
 * tryShopifyProductGallery(pageUrl, current, opts) → { imageUrl, additionalImages }
 *
 * opts.fetchShopifyProduct(handle, pageUrl) → payload | null (injected;
 * never throws from the caller's perspective — we catch). On any failure
 * returns `current` unchanged. Pure w.r.t. network when fetch is mocked.
 */
async function tryShopifyProductGallery(pageUrl, current, opts = {}) {
  const cur = current || { imageUrl: null, additionalImages: [] };
  if (typeof opts.fetchShopifyProduct !== 'function') return cur;
  if (!shouldEnrichShopifyGallery(pageUrl, cur, opts)) return cur;

  const handle = extractShopifyProductHandle(pageUrl);
  if (!handle) return cur;

  let payload = null;
  try {
    payload = await opts.fetchShopifyProduct(handle, pageUrl);
  } catch {
    return cur;
  }
  if (!payload) return cur;

  let gallery;
  try {
    gallery = imagesFromShopifyProductPayload(payload, pageUrl);
  } catch (err) {
    // A throw here means the payload→images contract broke (e.g. a future
    // mapShopifyProductImages change). Swallowing it silently would leave
    // the feature looking enabled while never enriching anything, so say so.
    console.warn(`${LOG} shopify gallery map failed for ${pageUrl}: ${err && err.message}`);
    return cur;
  }
  if (!gallery || !gallery.imageUrl) return cur;

  // Defence in depth: run the same size-suffix upgrade over the gallery
  // (products.js is usually already full-res; no-op then).
  if (
    isCatalogImageUpgradeEnabled() &&
    opts.upgradeRun &&
    typeof opts.upgradeRun.upgradeList === 'function'
  ) {
    try {
      const all = [gallery.imageUrl].concat(gallery.additionalImages || []);
      const uniq = await opts.upgradeRun.upgradeList(all);
      gallery = {
        imageUrl: uniq[0] || gallery.imageUrl,
        additionalImages: uniq.slice(1, 1 + MAX_ADDITIONAL_IMAGES)
      };
    } catch {
      // keep un-upgraded gallery
    }
  }

  return preferShopifyGallery(cur, gallery);
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
 * mapJsonLdProduct(node, pageUrl, explicitId?, opts?) → flat product | null
 * explicitId, when supplied, overrides id resolution (used by the
 * resolver's on-page feed-id recovery when the node lacks a structured id).
 * opts.upgradeRun (from createImageUpgradeRun) enables HEAD-verified
 * thumbnail→original upgrade on imageUrl + additionalImages.
 * opts.fetchShopifyProduct(handle, pageUrl) — when set, may replace a thin
 * Shopify JSON-LD image list with the full products/{handle}.js gallery
 * (full-res multi-image; shared MAX_ADDITIONAL_IMAGES cap). Fail-soft.
 * Async (awaits imagesFromNode / optional gallery fetch).
 */
async function mapJsonLdProduct(node, pageUrl, explicitId = null, opts = {}) {
  opts = opts || {};
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
  // JSON-LD first (size-suffix upgrade when upgradeRun present), then
  // optional products/{handle}.js gallery for multi-image full-res.
  let { imageUrl, additionalImages } = await imagesFromNode(node, pageUrl, opts);
  ({ imageUrl, additionalImages } = await tryShopifyProductGallery(
    pageUrl,
    { imageUrl, additionalImages },
    opts
  ));
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
 * mapOgProduct(html, pageUrl, opts?) → partial flat product | null
 * Fallback when no Product JSON-LD. Requires og:title at minimum.
 * opts.upgradeRun upgrades og:image the same way as JSON-LD images.
 * Async when upgrade runs; always returns a Promise.
 */
async function mapOgProduct(html, pageUrl, opts = {}) {
  opts = opts || {};
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

  let imageUrl = absUrl(image, pageUrl);
  if (
    imageUrl &&
    isCatalogImageUpgradeEnabled() &&
    opts.upgradeRun &&
    typeof opts.upgradeRun.resolve === 'function'
  ) {
    imageUrl = await opts.upgradeRun.resolve(imageUrl);
  }
  // Same gallery enrichment as JSON-LD: OG only ever has one image, so a
  // Shopify /products/{handle} PDP still needs products.js for alts.
  let additionalImages = [];
  ({ imageUrl, additionalImages } = await tryShopifyProductGallery(
    pageUrl,
    { imageUrl, additionalImages },
    opts
  ));
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
    additionalImages,
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

async function fetchXmlText(url, { session = null } = {}) {
  const isGz = /\.gz($|\?)/i.test(url);
  if (isGz) {
    const res = await http.fetchBuffer(url, { maxBytes: 20_000_000, session });
    const block = res.block || null;
    if (res.cfChallenged) {
      return { ok: false, cfChallenged: true, rateLimited: false, text: null, block };
    }
    if (res.rateLimited) {
      return { ok: false, cfChallenged: false, rateLimited: true, text: null, block };
    }
    if (!res.ok || !res.buffer) {
      return {
        ok: false,
        cfChallenged: false,
        rateLimited: false,
        text: null,
        error: res.error,
        block
      };
    }
    try {
      // Cap DECOMPRESSED size (gzip-bomb guard): a small .gz can inflate to
      // GBs. maxOutputLength makes gunzipSync throw once the cap is hit.
      const text = zlib.gunzipSync(res.buffer, { maxOutputLength: GZIP_MAX_OUTPUT_BYTES }).toString('utf8');
      return { ok: true, text, cfChallenged: false, rateLimited: false, block: null };
    } catch (err) {
      return {
        ok: false,
        cfChallenged: false,
        rateLimited: false,
        text: null,
        error: err.message,
        block: null
      };
    }
  }

  const res = await http.fetchText(url, { maxBytes: 8_000_000, session });
  const block = res.block || null;
  if (res.cfChallenged) {
    return { ok: false, cfChallenged: true, rateLimited: false, text: null, block };
  }
  if (res.rateLimited) {
    return { ok: false, cfChallenged: false, rateLimited: true, text: null, block };
  }
  if (!res.ok || !res.text) {
    return {
      ok: false,
      cfChallenged: false,
      rateLimited: false,
      text: null,
      error: res.error,
      block
    };
  }
  return { ok: true, text: res.text, cfChallenged: false, rateLimited: false, block: null };
}

async function discoverSitemapUrls(origin, abortCheck = async () => false, { session = null, stats = null } = {}) {
  const discovered = [];
  const seen = new Set();               // O(1) dedup (not .includes O(n^2))
  const add = (u) => { if (u && !seen.has(u)) { seen.add(u); discovered.push(u); } };
  let crawlDelayMs = 0;
  let cfChallenges = 0;
  let rateLimited = false;
  // robots body is free once fetched — hand to fingerprintSite so
  // Shopify's canonical robots signature can fire without a re-fetch.
  let robotsText = null;
  let robotsReachable = false;

  // 1. robots.txt
  try {
    const robotsUrl = `${origin}/robots.txt`;
    const res = await http.fetchText(robotsUrl, { timeoutMs: 15000, session });
    if (res.cfChallenged) cfChallenges += 1;
    if (res.rateLimited) rateLimited = true;
    if (res.block) noteBlock(stats, res.block);
    if (res.ok && res.text) {
      robotsText = res.text;
      robotsReachable = true;
      const parsed = parseRobotsForSitemaps(res.text, '*');
      crawlDelayMs = parsed.crawlDelayMs || 0;
      for (const u of parsed.sitemaps) add(u);
    } else if (res.ok) {
      robotsReachable = true;
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
        const got = await fetchXmlText(url, { session });
        if (got.cfChallenged) cfChallenges += 1;
        if (got.rateLimited) rateLimited = true;
        if (got.block) noteBlock(stats, got.block);
        if (got.ok && got.text && /<loc[\s>]/i.test(got.text)) add(url);
      } catch (err) {
        console.warn(`   ⚠️  ${LOG}  fallback sitemap ${url}: ${err.message}`);
      }
    }
  }

  return {
    sitemaps: discovered,
    crawlDelayMs,
    cfChallenges,
    rateLimited,
    robotsText,
    robotsReachable
  };
}

/**
 * Walk sitemap indexes → urlsets (depth ≤ 2). Streams product-page
 * candidates ranked product-ish first, lastmod desc.
 * Returns { pageEntries:[{loc,lastmod}], sitemapsWalked, cfChallenges,
 *   rateLimited, aborted, budgetExpired }.
 * `budget` is an optional RungBudget from createBudget().enterRung — checked
 * alongside abortCheck so a large index cannot burn the whole wall-clock
 * allotment before any PDP is scanned.
 */
async function walkSitemaps(rootSitemaps, {
  abortCheck,
  maxUrls,
  budget = null,
  session = null,
  stats = null
} = {}) {
  const pageEntries = [];
  const seenLoc = new Set();
  const seenSitemaps = new Set();   // dedup index/sub-sitemap URLs (loop + DoS guard)
  let sitemapsWalked = 0;
  let sitemapFetches = 0;
  let cfChallenges = 0;
  let rateLimited = false;
  let aborted = false;
  let budgetExpired = false;

  // Fetch a sitemap document at most once, bounded by MAX_SITEMAP_FETCHES.
  // Prevents a self-referential / diamond index graph from forcing an
  // unbounded number of outbound requests.
  async function fetchSitemapOnce(url) {
    if (!url || seenSitemaps.has(url)) return null;
    if (sitemapFetches >= MAX_SITEMAP_FETCHES) return null;
    seenSitemaps.add(url);
    sitemapFetches += 1;
    try {
      const got = await fetchXmlText(url, { session });
      if (got && got.block) noteBlock(stats, got.block);
      return got;
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
    if (budget && budget.expired()) { budgetExpired = true; break; }
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
    if (budget && budget.expired()) { budgetExpired = true; break; }
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

  return { pageEntries, sitemapsWalked, cfChallenges, rateLimited, aborted, budgetExpired };
}

// ── browser session last rung ──────────────────────────────────────

/**
 * Should we launch Chrome? Only when the cheap path already failed for a
 * reason a browser can fix, products are still empty, and budget remains.
 * Most syncs never enter this function's body past the gate.
 */
function shouldAttemptBrowserRung({ stats, disc, pageEntries, budget }) {
  if (!RENDER_GENERIC_ENABLED) return false;
  if (stats && stats.browserAttempted) return false; // once per resolve
  if (budget && typeof budget.expired === 'function' && budget.expired()) return false;

  const browserBlock = !!(stats && stats.browserSessionBlockSeen);
  const shopifyFall = !!(stats && stats.shopifyFallthrough);
  // Zero candidates while robots was reachable (ubeauty: robots 200,
  // every sitemap/products.json 403 with cf-mitigated:challenge).
  const robotsOk = !!(disc && (disc.robotsReachable || disc.robotsText));
  const zeroCandidates = !pageEntries || pageEntries.length === 0;
  const zeroUrlsWithRobots = robotsOk && zeroCandidates;

  return browserBlock || shopifyFall || zeroUrlsWithRobots;
}

/**
 * tryBrowserSessionRung(...) → success result object | null
 *
 * null = did not run, or ran and still has zero products (caller emits
 * the existing honest failure). On success returns a full resolveGenericCatalog
 * result with source 'shopify-direct' | 'sitemap-jsonld'.
 *
 * Order once Chrome is up:
 *   1. gotoWithCf(origin) + harvestSession (HttpOnly cookies via page.cookies)
 *   2. if Shopify: in-page paginated products.json
 *   3. else/additionally: re-run cheap rungs with the harvested session
 *   4. still nothing → null (honest failure with vendor named)
 */
// Hard ceiling on the WHOLE browser rung, mirroring the protection the older
// headless path already has (headlessScrapeService SHOPIFY_HEADLESS_TIMEOUT_MS +
// its Promise.race). Env-tunable.
//
// WHY A RACE AND NOT JUST THE BUDGET: the wall-clock budget is CHECKED BETWEEN
// steps — it cannot interrupt an in-flight await. Measured 2026-08-10 against
// ubeauty.com, a wedged Chrome launch outlived a 300s total budget by more than
// 300s and the resolver never returned. Per-step timeouts (45s goto, 15s
// challenge wait) do not cover launch, page teardown, or an in-page evaluate
// that never settles. This is the same defect class Phase 1 fixed for the HTTP
// path, so the new rung gets the same guarantee.
//
// Note the race does not CANCEL the inner work (Promise.race cannot) — it lets
// the resolver return honestly while the orphaned attempt unwinds. That matches
// the existing headless path's semantics; the singleton browser is reused or
// closed on shutdown rather than leaked per-run.
const BROWSER_RUNG_TIMEOUT_MS = Math.max(
  10000,
  parseInt(process.env.HEADLESS_RUNG_TIMEOUT_MS, 10) || 120000
);

async function tryBrowserSessionRung(args) {
  const { stats, warnings, budget } = args;
  // Never allow the rung more time than the run has left.
  const remaining = budget && typeof budget.remainingMs === 'function'
    ? budget.remainingMs()
    : Infinity;
  const capMs = Math.max(1000, Math.min(BROWSER_RUNG_TIMEOUT_MS, remaining));

  let timer = null;
  const TIMED_OUT = Symbol('browser-rung-timeout');
  try {
    const result = await Promise.race([
      tryBrowserSessionRungInner(args),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), capMs);
      })
    ]);
    if (result === TIMED_OUT) {
      const msg = `browser rung timed out after ${capMs}ms`;
      console.warn(`   ⚠️  ${LOG}  ${msg}`);
      if (stats) {
        stats.browserTimedOut = true;
        stats.browserTimeoutMs = capMs;
      }
      if (warnings) warnings.push(msg);
      return null;   // fall through honestly rather than hang the run
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tryBrowserSessionRungInner({
  brand,
  origin,
  stats,
  warnings,
  effectiveCap,
  budget,
  abortCheck,
  run,
  isShopify,
  pageEntries,
  disc,
  getRateLimited,
  setRateLimited,
  getBudgetExpired,
  setBudgetExpired,
  activeSessionRef,
  rescanWithSession = true,
  attachCategoryFields = (o) => o,
  // Image-URL upgrade context (shared with the main PDP scan so memo +
  // check-cap span the whole resolve). Optional — missing = no upgrades.
  mapOpts = null
}) {
  if (!shouldAttemptBrowserRung({ stats, disc, pageEntries, budget })) {
    return null;
  }
  if (await abortCheck()) return null;

  stats.browserAttempted = true;
  stats.browserMode = null;
  stats.sessionHarvested = false;
  stats.sessionReused = false;
  stats.browserProductCount = 0;

  let headless;
  try {
    headless = require('./headlessScrapeService');
  } catch (err) {
    warnings.push(`browser rung unavailable: ${err.message}`);
    stats.browserError = err.message;
    return null;
  }
  if (typeof headless.clearChallengeAndHarvest !== 'function') {
    warnings.push('browser rung unavailable: clearChallengeAndHarvest missing');
    return null;
  }

  console.log(
    `   · ${LOG}  browser session rung — ` +
    `shopify=${!!isShopify} blockSeen=${!!stats.browserSessionBlockSeen} ` +
    `fallthrough=${!!stats.shopifyFallthrough}`
  );
  try { run?.stage?.('browser session (challenge clear)'); } catch { /* */ }
  try {
    run?.note?.(
      `launching headless Chrome to clear bot challenge @ ${origin}`
    );
  } catch { /* */ }

  const wrappedAbort = async () => {
    try {
      if (await abortCheck()) return true;
    } catch { /* */ }
    if (budget && typeof budget.expired === 'function' && budget.expired()) {
      if (typeof setBudgetExpired === 'function') setBudgetExpired(true);
      return true;
    }
    return false;
  };

  let harvest;
  try {
    harvest = await headless.clearChallengeAndHarvest(origin, {
      abortCheck: wrappedAbort,
      run,
      tryProductsJson: !!isShopify,
      cap: effectiveCap
    });
  } catch (err) {
    console.warn(`   ⚠️  ${LOG}  browser harvest threw: ${err.message}`);
    stats.browserError = err.message;
    warnings.push(`browser harvest failed: ${err.message}`);
    return null;
  }

  if (!harvest || !harvest.ok || !harvest.session) {
    const why = (harvest && harvest.reason) || 'challenge not cleared';
    stats.browserError = why;
    warnings.push(`browser session failed: ${why}`);
    console.log(`   · ${LOG}  browser harvest failed: ${why}`);
    return null;
  }

  // Cache only if clearance cookies are present (document.cookie trap).
  const cached = scrapeSession.putSession({
    origin,
    cookieHeader: harvest.session.cookieHeader,
    userAgent: harvest.session.userAgent,
    acceptLanguage: harvest.session.acceptLanguage,
    vendor: harvest.session.vendor || 'cloudflare'
  });
  stats.sessionHarvested = !!cached;
  if (cached && activeSessionRef) activeSessionRef.set(cached);
  if (!cached) {
    // Harvest returned cookies but they failed the clearance gate —
    // still usable for in-page products already collected; HTTP reuse no.
    warnings.push(
      'browser harvest missing cf_clearance/__cf_bm — session not cached for HTTP reuse'
    );
  }

  // ── 2. Shopify in-page products.json ─────────────────────────────
  const rawProducts = Array.isArray(harvest.products) ? harvest.products : [];
  if (rawProducts.length) {
    stats.browserMode = 'products-json';
    stats.browserProductCount = rawProducts.length;
    const mapFlat = ingestHelpers.mapShopifyNormalizedToFlat;
    const flat = [];
    for (const p of rawProducts) {
      try {
        const m = mapFlat(p, origin, brand);
        if (m && m.externalId) flat.push(m);
      } catch (err) {
        warnings.push(`browser shopify map failed for ${p && p.id}: ${err.message}`);
      }
    }
    if (flat.length) {
      console.log(
        `${LOG}  resolveGenericCatalog ok via browser products.json: n=${flat.length}`
      );
      const out = {
        ok: true,
        mode: 'products-json',
        // CatalogProduct.source enum — must stay a valid member.
        source: 'shopify-direct',
        origin,
        products: flat.slice(0, effectiveCap),
        stats,
        rateLimited: typeof getRateLimited === 'function' ? getRateLimited() : false
      };
      if (warnings.length) out.warnings = warnings;
      if (typeof getBudgetExpired === 'function' && getBudgetExpired()) {
        out.budgetExpired = true;
        out.partial = true;
        out.partialReason = 'budget-exceeded';
      }
      return attachCategoryFields(out);
    }
  }

  // ── 3. Re-run cheap rungs with harvested session ─────────────────
  const session = cached || (activeSessionRef && activeSessionRef.get());
  if (!rescanWithSession || !session || !session.isValid()) {
    return null;
  }

  stats.sessionReused = true;
  stats.browserMode = stats.browserMode || 'session-http';
  try { run?.stage?.('re-scan with browser session'); } catch { /* */ }
  try {
    run?.note?.('replaying cleared session on HTTP path (sitemap + PDPs)');
  } catch { /* */ }

  // Re-discover + walk with session (sitemaps may have been CF-blocked).
  let sessionEntries = Array.isArray(pageEntries) ? pageEntries.slice() : [];
  if (!sessionEntries.length) {
    try {
      const disc2 = await discoverSitemapUrls(origin, abortCheck, {
        session,
        stats
      });
      if (disc2.rateLimited && typeof setRateLimited === 'function') {
        setRateLimited(true);
      }
      stats.cfChallenges += disc2.cfChallenges || 0;
      if (disc2.sitemaps && disc2.sitemaps.length) {
        const walked2 = await walkSitemaps(disc2.sitemaps, {
          abortCheck: wrappedAbort,
          maxUrls: MAX_SITEMAP_URLS,
          budget:
            budget && typeof budget.enterRung === 'function'
              ? budget.enterRung('sitemap-session', budget.remainingMs())
              : null,
          session,
          stats
        });
        stats.sitemapsWalked += walked2.sitemapsWalked || 0;
        stats.cfChallenges += walked2.cfChallenges || 0;
        if (walked2.rateLimited && typeof setRateLimited === 'function') {
          setRateLimited(true);
        }
        if (walked2.budgetExpired && typeof setBudgetExpired === 'function') {
          setBudgetExpired(true);
        }
        sessionEntries = walked2.pageEntries || [];
      }
    } catch (err) {
      warnings.push(`session re-discover failed: ${err.message}`);
    }
  }

  if (!sessionEntries.length) {
    // Optional: renderKnownUrls is available but we have no URLs — done.
    return null;
  }

  // Bounded PDP re-scan with session (same validation as the main loop).
  const sessionProducts = [];
  const seenIds = new Set();
  const pdpBudget =
    budget && typeof budget.enterRung === 'function'
      ? budget.enterRung('pdp-session', budget.remainingMs())
      : null;
  const scanCap = Math.min(sessionEntries.length, MAX_SITEMAP_URLS);

  for (let i = 0; i < scanCap && sessionProducts.length < effectiveCap; i++) {
    if (await abortCheck()) break;
    if (pdpBudget && pdpBudget.expired()) {
      if (typeof setBudgetExpired === 'function') setBudgetExpired(true);
      break;
    }
    if (budget && budget.expired()) {
      if (typeof setBudgetExpired === 'function') setBudgetExpired(true);
      break;
    }

    const entry = sessionEntries[i];
    const loc = entry && entry.loc;
    if (!loc) continue;

    let html = null;
    try {
      const res = await http.fetchText(loc, {
        timeoutMs: 15000,
        maxBytes: 4_000_000,
        session
      });
      if (res.block) noteBlock(stats, res.block);
      if (res.cfChallenged) {
        stats.cfChallenges += 1;
        continue;
      }
      if (res.rateLimited) {
        if (typeof setRateLimited === 'function') setRateLimited(true);
        break;
      }
      if (!res.ok || !res.text) continue;
      html = res.text;
    } catch {
      continue;
    }

    stats.urlsScanned += 1;
    let mapped = null;
    try {
      const nodes = extractJsonLdProducts(html);
      if (nodes.length) {
        stats.jsonLdProductsFound += 1;
        for (const node of nodes) {
          mapped = await mapJsonLdProduct(node, loc, null, mapOpts);
          if (mapped) break;
        }
        if (!mapped) {
          const htmlId = extractProductIdFromHtml(html);
          if (htmlId) {
            for (const node of nodes) {
              mapped = await mapJsonLdProduct(node, loc, htmlId, mapOpts);
              if (mapped) break;
            }
          }
        }
      }
      if (!mapped) {
        mapped = await mapOgProduct(html, loc, mapOpts);
        if (mapped) stats.ogFallbackUsed += 1;
      }
    } catch {
      continue;
    }
    if (!mapped) continue;

    if (entry.lastmod) mapped._lastmod = entry.lastmod;
    try {
      const bc = extractBreadcrumb(html);
      if (bc && Array.isArray(bc.breadcrumb) && bc.breadcrumb.length) {
        mapped.breadcrumb = bc.breadcrumb;
        mapped.breadcrumbSource = bc.source;
      }
    } catch { /* best-effort */ }
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

    if (!validateProduct(mapped).valid) {
      stats.validationFailures += 1;
      continue;
    }
    const idKey = String(mapped.externalId);
    if (seenIds.has(idKey)) {
      stats.duplicatesSkipped += 1;
      continue;
    }
    seenIds.add(idKey);
    sessionProducts.push(mapped);
    try {
      run?.tick?.(
        sessionProducts.length,
        effectiveCap,
        `session scan ${sessionProducts.length}/${effectiveCap}`
      );
    } catch { /* */ }
  }

  stats.browserProductCount = sessionProducts.length;
  if (!sessionProducts.length) return null;

  console.log(
    `${LOG}  resolveGenericCatalog ok via browser session HTTP: n=${sessionProducts.length}`
  );
  const out = {
    ok: true,
    mode: 'sitemap-jsonld',
    source: 'sitemap-jsonld',
    origin,
    products: sessionProducts.slice(0, effectiveCap),
    stats,
    rateLimited: typeof getRateLimited === 'function' ? getRateLimited() : false
  };
  if (warnings.length) out.warnings = warnings;
  if (typeof getBudgetExpired === 'function' && getBudgetExpired()) {
    out.budgetExpired = true;
    out.partial = true;
    out.partialReason = 'budget-exceeded';
  }
  return attachCategoryFields(out);
}

// ── main resolve ───────────────────────────────────────────────────

/**
 * resolveGenericCatalog(brand, { run, abortCheck, cap, discoverOnly, categories })
 * → { ok, mode, source?, origin, products:[flat], stats, rateLimited?, reason?, warnings?,
 *     categoryOptions?, categoryPromptSuggested?, discoverOnly?, totalCandidates? }
 *
 * mode: 'sitemap-jsonld' | shopify ladder mode ('products-json'|'storefront-graphql'|'sitemap')
 * source: CatalogProduct.source enum value when AUTODETECT ran
 *   ('shopify-direct' | 'sitemap-jsonld'). Flag-off omits it (byte-identical).
 *
 * discoverOnly:true — walk sitemaps, derive category options, return WITHOUT
 *   scanning a single PDP (products:[]). Used by the capability preview so an
 *   operator can pick categories before spending wall-clock on pages.
 * categories:['buffalo-bills',…] — filter pageEntries through
 *   matchesAnyCategory BEFORE the PDP scan. Segment-exact match only.
 * Both are gated on GENERIC_CATALOG_CATEGORY_OPTIONS (default true); when
 * false the result is byte-identical to the pre-feature shape (no new keys).
 *
 * AUTODETECT (GENERIC_CATALOG_AUTODETECT, default true): after robots/sitemap
 * discovery, fingerprint the homepage. Shopify high/medium → climb the
 * existing shopifyAccessResolver ladder (products.json first). Zero products
 * (e.g. CF-blocked) falls through to sitemap+JSON-LD so coverage is never
 * lost. Living Spaces (non-Shopify) stays on the JSON-LD path.
 *
 * BROWSER SESSION (RENDER_GENERIC_ENABLED, default true): last rung only —
 * launches Chrome when a browser-session block was seen, the Shopify ladder
 * fell through, or sitemaps yielded zero URLs while robots was reachable.
 * Harvests HttpOnly cookies (page.cookies — NEVER document.cookie), then
 * either pulls products.json in-page (Shopify) or re-runs cheap HTTP rungs
 * with the pinned session. Most syncs never start a browser.
 */
async function resolveGenericCatalog(brand, {
  run = null,
  abortCheck = async () => false,
  cap = DEFAULT_CAP,
  discoverOnly = false,
  categories = null
} = {}) {
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
  // budgetExpired is its OWN flag — do not overload aborted/cancelled.
  // aborted drives run.markCancelled(...); a timeout is not a cancellation.
  let budgetExpired = false;
  // `activeSession` is null until the browser rung harvests one; cheap
  // path first, always. Declared early so fetchShopifyProduct can close
  // over the binding (TDZ-safe: only read at call time, after init).
  let activeSession = null;

  // Image-URL upgrade run (one per resolve). Memoises HEAD answers and caps
  // verification requests (CATALOG_IMAGE_UPGRADE_MAX_CHECKS). Flag-off →
  // upgradeRun is null and map* paths skip HEADs. fetchHead is built
  // lazily so a flag-off resolve never even constructs it.
  const imageUpgradeRun = isCatalogImageUpgradeEnabled()
    ? createImageUpgradeRun({
        fetchHead: makeHttpScrapeFetchHead(http, { timeoutMs: 8000 })
      })
    : null;

  // Per-PDP products/{handle}.js gallery fetch (same endpoint
  // shopifyPublicIngestService uses). Tries .js first, then .json.
  // Memoised per handle so a re-map (explicitId recovery) does not double-
  // bill the host. Never throws — returns null on any miss so the caller
  // keeps the JSON-LD seed.
  const shopifyGalleryMemo = new Map();
  const fetchShopifyProduct = SHOPIFY_GALLERY_ENRICH_ENABLED
    ? async function fetchShopifyProduct(handle, pageUrl) {
        if (!handle) return null;
        let origin;
        try {
          origin = new URL(pageUrl).origin;
        } catch {
          return null;
        }
        // Key on origin+handle, NOT handle alone. A resolve walks sitemap
        // locs with no same-origin filter, so two hosts (us./eu. storefronts)
        // can carry the same handle for different products — a handle-only
        // memo would serve the first host's gallery as the second product's
        // ad seeds. Wrong-product imagery is worse than a second request.
        const key = `${origin}::${handle}`;
        if (shopifyGalleryMemo.has(key)) return shopifyGalleryMemo.get(key);
        const candidates = [
          `${origin}/products/${encodeURIComponent(handle)}.js`,
          `${origin}/products/${encodeURIComponent(handle)}.json`
        ];
        for (const url of candidates) {
          try {
            const res = await http.fetchText(url, {
              timeoutMs: 10000,
              maxBytes: 2_000_000,
              session: activeSession
            });
            if (!res || !res.ok || !res.text) continue;
            // Both endpoints return JSON (the .js AJAX payload is a JSON
            // object with application/javascript content-type).
            let parsed;
            try {
              parsed = JSON.parse(res.text);
            } catch {
              continue;
            }
            if (parsed && typeof parsed === 'object') {
              shopifyGalleryMemo.set(key, parsed);
              return parsed;
            }
          } catch {
            // try next candidate
          }
        }
        shopifyGalleryMemo.set(key, null);
        return null;
      }
    : null;

  // Always an object (may be empty when both upgrade + gallery enrich are
  // flag-off). Offline pure callers of mapJsonLdProduct omit opts entirely.
  const mapOpts = {};
  if (imageUpgradeRun) mapOpts.upgradeRun = imageUpgradeRun;
  if (fetchShopifyProduct) mapOpts.fetchShopifyProduct = fetchShopifyProduct;

  // Wall-clock budget for the whole resolve (discovery + walk + PDP scan).
  // Unset / non-positive env → unbounded (createBudget safety property).
  const budget = createBudget({ totalMs: TOTAL_BUDGET_MS });
  const budgetReason = (detail) => {
    const sec = Math.round(budget.spentMs() / 1000);
    return `stopped after ${sec}s (budget)${detail ? ` — ${detail}` : ''}`;
  };

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
  // Counts against the TOTAL budget (sitemap rung opens after discovery
  // so a slow robots.txt cannot starve the walk allotment entirely —
  // discovery is a handful of requests; the walk is the expensive part).
  const disc = await discoverSitemapUrls(origin, abortCheck, { stats });
  stats.sitemapsDiscovered = disc.sitemaps.length;
  stats.cfChallenges += disc.cfChallenges || 0;
  if (disc.rateLimited) rateLimited = true;
  const crawlDelayMs = disc.crawlDelayMs || 0;
  const pdpGapMs = Math.max(crawlDelayMs - 250, 0);

  // ── Platform auto-detect (Shopify → access ladder) ───────────────
  // One homepage fetch + pure fingerprint on already-fetched robots.
  // Flag-off: skip entirely (no new stats keys, no homepage fetch).
  // discoverOnly: skip delegation — category options still need the
  // sitemap walk; fingerprint alone is not useful without product import.
  if (AUTODETECT_ENABLED && !discoverOnly && !(await abortCheck()) && !budget.expired()) {
    let homepageHtml = null;
    let homepageHeaders = null;
    try {
      run?.stage?.('fingerprinting store platform');
      const homeRes = await http.fetchText(`${origin}/`, { timeoutMs: 15000, maxBytes: 2_000_000 });
      if (homeRes.cfChallenged) stats.cfChallenges += 1;
      if (homeRes.rateLimited) rateLimited = true;
      if (homeRes.block) noteBlock(stats, homeRes.block);
      if (homeRes.ok && homeRes.text) {
        homepageHtml = homeRes.text;
        homepageHeaders = homeRes.headers || null;
      }
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  homepage fetch for fingerprint: ${err.message}`);
    }

    const fp = fingerprintSite({
      homepageHtml,
      homepageHeaders,
      robotsText: disc.robotsText || null
    });
    stats.platform = fp.platform;
    stats.confidence = fp.confidence;
    stats.fingerprintSignals = fp.signals;
    // Feed the gallery-enrichment gate real platform evidence. mapOpts is
    // built before this point but consumed later (during the walk), so the
    // assignment lands before any map* call reads it. Without this the gate
    // falls back to hero-URL evidence alone, which misses a Shopify store
    // serving images from a non-Shopify CDN.
    if (String(fp.platform || '').toLowerCase() === 'shopify') {
      mapOpts.platformIsShopify = true;
    }

    console.log(
      `   · ${LOG}  fingerprint: platform=${fp.platform} confidence=${fp.confidence}` +
      (fp.signals.length ? ` signals=[${fp.signals.join(', ')}]` : '')
    );
    try { run?.note?.(`platform=${fp.platform} (${fp.confidence})`); } catch { /* optional */ }

    const shopifyEligible =
      fp.platform === 'shopify' &&
      (fp.confidence === 'high' || fp.confidence === 'medium');

    if (shopifyEligible && !(await abortCheck()) && !budget.expired()) {
      stats.shopifyAttempted = true;
      run?.stage?.('shopify access ladder (auto-detect)');
      console.log(`   · ${LOG}  Shopify detected — delegating to shopifyAccessResolver`);

      let shopifyAccess = null;
      try {
        const { resolveShopifyAccess } = require('./shopifyAccessResolver');
        // Honour budget via abort wrapper: when the wall-clock expires the
        // ladder stops climbing; partials already collected are still used.
        const shopifyAbort = async () => {
          if (await abortCheck()) return true;
          if (budget.expired()) {
            budgetExpired = true;
            return true;
          }
          return false;
        };
        shopifyAccess = await resolveShopifyAccess(brand, {
          run,
          abortCheck: shopifyAbort,
          cap: effectiveCap
        });
      } catch (err) {
        console.warn(`   ⚠️  ${LOG}  shopifyAccessResolver threw: ${err.message}`);
        stats.shopifyError = err.message;
        shopifyAccess = null;
      }

      if (shopifyAccess) {
        if (shopifyAccess.rateLimited) rateLimited = true;
        stats.shopifyMode = shopifyAccess.mode || null;
        stats.shopifyProductCount = (shopifyAccess.products || []).length;
        if (shopifyAccess.discoveredMyshopify) {
          stats.discoveredMyshopify = shopifyAccess.discoveredMyshopify;
        }
        if (shopifyAccess.reason) stats.shopifyReason = shopifyAccess.reason;

        const rawProducts = Array.isArray(shopifyAccess.products)
          ? shopifyAccess.products.slice(0, effectiveCap)
          : [];

        if (rawProducts.length) {
          // Adapt products.json shape → flat generic fields via the SHARED
          // mapper (mapShopifyNormalizedToFlat) — never a second copy.
          const mapFlat = ingestHelpers.mapShopifyNormalizedToFlat;
          const effectiveOrigin = shopifyAccess.origin || origin;
          const flat = [];
          for (const p of rawProducts) {
            try {
              const m = mapFlat(p, effectiveOrigin, brand);
              if (m && m.externalId) flat.push(m);
            } catch (err) {
              warnings.push(`shopify map failed for ${p && p.id}: ${err.message}`);
            }
          }

          if (flat.length) {
            console.log(
              `${LOG}  resolveGenericCatalog ok via Shopify auto-detect: ` +
              `n=${flat.length} mode=${shopifyAccess.mode} origin=${effectiveOrigin}`
            );
            const out = {
              ok: true,
              mode: shopifyAccess.mode || 'products-json',
              // CatalogProduct.source enum — honest stamp of the ladder used.
              source: 'shopify-direct',
              origin: effectiveOrigin,
              products: flat,
              stats,
              rateLimited
            };
            if (warnings.length) out.warnings = warnings;
            if (budgetExpired) {
              out.budgetExpired = true;
              out.partial = true;
              out.partialReason = 'budget-exceeded';
              out.reason = budgetReason(`kept ${flat.length} product(s) via Shopify ladder`);
            }
            return out;
          }
        }

        // Zero products (or all unmappable) — fall through to sitemap+JSON-LD.
        // Never let the new branch lose coverage the old path had
        // (e.g. ubeauty.com CF-blocked on every Shopify rung).
        const fallReason = shopifyAccess.reason ||
          `Shopify ladder returned 0 products (mode=${shopifyAccess.mode || 'none'})`;
        stats.shopifyFallthrough = true;
        stats.shopifyFallthroughReason = fallReason;
        // A BLOCK is not an empty store. Recording it distinctly is the whole
        // point: "0 products" invites the conclusion that the merchant has no
        // catalog, when in fact products.json was never allowed to answer and
        // the full-resolution gallery is still sitting there. The JSON-LD walk
        // below yields ~1 featured image per product, so a silent downgrade
        // here is what puts thumbnails into ad seeds.
        if (shopifyAccess.blocked) {
          stats.shopifyBlocked = shopifyAccess.blocked;
          // Route through the SHARED helper, not just a private stat. It sets
          // lastBlockVendor/lastBlockRemedy and — when the remedy is
          // browser-session — flips browserSessionBlockSeen, which is what
          // gates the browser rung (shouldAttemptBrowserRung). Without this
          // the ladder's own blocks were invisible to the one mechanism that
          // can actually RECOVER the products.json gallery in-page, so a
          // CF-blocked Shopify store reported its block and then degraded
          // anyway. This is the difference between naming the problem and
          // fixing it.
          noteBlock(stats, shopifyAccess.blocked);
          warnings.push(
            `Shopify ladder BLOCKED by ${shopifyAccess.blocked.vendor} ` +
            `(${shopifyAccess.blocked.confidence} confidence, remedy=${shopifyAccess.blocked.remedy}) — ` +
            'degraded to JSON-LD; this is a block, not an empty catalog'
          );
          console.warn(
            `   ⚠️  ${LOG}  Shopify ladder BLOCKED by ${shopifyAccess.blocked.vendor} ` +
            `— degrading to sitemap+JSON-LD (expect ~1 image/product)`
          );
        } else {
          console.log(`   · ${LOG}  Shopify ladder empty — falling through to sitemap+JSON-LD`);
        }
        warnings.push(`Shopify auto-detect fell through: ${fallReason}`);
      }
    }
  }

  // Track Shopify eligibility for the browser rung (products.json in-page).
  let shopifyEligibleForBrowser = stats.platform === 'shopify' &&
    (stats.confidence === 'high' || stats.confidence === 'medium');

  if (!disc.sitemaps.length) {
    // Last rung: browser may still recover Shopify products.json (ubeauty)
    // even when no Sitemap: lines / fallbacks are reachable over HTTP.
    // Never launch Chrome on discoverOnly (category-options preview).
    if (!discoverOnly) {
      const browserEarly = await tryBrowserSessionRung({
        brand,
        origin,
        stats,
        warnings,
        effectiveCap,
        budget,
        abortCheck,
        run,
        isShopify: shopifyEligibleForBrowser || !!stats.shopifyFallthrough,
        pageEntries: [],
        disc,
        getRateLimited: () => rateLimited,
        setRateLimited: (v) => { rateLimited = v; },
        getBudgetExpired: () => budgetExpired,
        setBudgetExpired: (v) => { budgetExpired = v; },
        activeSessionRef: { get: () => activeSession, set: (s) => { activeSession = s; } },
        mapOpts
      });
      if (browserEarly) return browserEarly;
    }

    const reason = stats.lastBlockVendor
      ? `no sitemaps found at ${origin} — blocked by ${stats.lastBlockVendor}` +
        (stats.browserAttempted ? ' (browser session also failed)' : '')
      : `no sitemaps found at ${origin} — site does not expose XML sitemaps`;
    console.warn(`   ⚠️  ${LOG}  ${reason}`);
    const emptyOut = {
      ok: false,
      mode: 'sitemap-jsonld',
      origin,
      products: [],
      stats,
      rateLimited,
      reason
    };
    if (AUTODETECT_ENABLED) emptyOut.source = 'sitemap-jsonld';
    if (warnings.length) emptyOut.warnings = warnings;
    return emptyOut;
  }

  console.log(`   · ${LOG}  discovered ${disc.sitemaps.length} sitemap(s), crawlDelayMs=${crawlDelayMs}`);

  if (await abortCheck()) {
    const abortOut = {
      ok: false,
      mode: 'sitemap-jsonld',
      origin,
      products: [],
      stats,
      reason: 'aborted during sitemap discovery',
      cancelled: true
    };
    if (AUTODETECT_ENABLED) abortOut.source = 'sitemap-jsonld';
    return abortOut;
  }
  if (budget.expired()) {
    const budOut = {
      ok: false,
      mode: 'sitemap-jsonld',
      origin,
      products: [],
      stats,
      rateLimited,
      budgetExpired: true,
      partial: true,
      partialReason: 'budget-exceeded',
      reason: budgetReason('timed out during sitemap discovery')
    };
    if (AUTODETECT_ENABLED) budOut.source = 'sitemap-jsonld';
    return budOut;
  }

  // ── Walk sitemaps → ranked page URLs ─────────────────────────────
  // Sitemap rung: clamped to min(SITEMAP_BUDGET_MS, total remaining).
  const sitemapBudget = budget.enterRung('sitemap', SITEMAP_BUDGET_MS);
  const walked = await walkSitemaps(disc.sitemaps, {
    abortCheck,
    maxUrls: MAX_SITEMAP_URLS,
    budget: sitemapBudget,
    session: activeSession,
    stats
  });
  stats.sitemapsWalked = walked.sitemapsWalked;
  stats.cfChallenges += walked.cfChallenges || 0;
  if (walked.rateLimited) rateLimited = true;
  if (walked.budgetExpired) budgetExpired = true;

  // Cancel during the walk must read as cancelled, not "no product URLs".
  // User-cancel DISCARDS the partial URL list: the operator said stop, so
  // we refuse further network spend on PDPs. Budget expiry is different —
  // the discovery clock ran out, but URLs already collected are free to
  // scan under whatever TOTAL budget remains (PDP rung). Keeping them
  // maximises products recovered from sitemap-fetch time already spent.
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

  // let — may be reassigned by the category filter below (selective import).
  let pageEntries = walked.pageEntries || [];
  if (!pageEntries.length) {
    // Prefer a budget reason over the generic "no product URLs" message
    // when the walk was cut short before any locs landed.
    if (budgetExpired) {
      const reason = budgetReason('no product URLs collected before the wall-clock limit');
      console.warn(`   ⚠️  ${LOG}  ${reason}`);
      return {
        ok: false,
        mode: 'sitemap-jsonld',
        origin,
        products: [],
        stats,
        rateLimited,
        budgetExpired: true,
        partial: true,
        partialReason: 'budget-exceeded',
        reason
      };
    }

    // ubeauty-class: robots + Sitemap: lines present, every sitemap doc
    // CF-blocked → zero candidates. Browser clears + products.json.
    // Skip on discoverOnly — preview must stay network-cheap.
    if (!discoverOnly) {
      const browserNoUrls = await tryBrowserSessionRung({
        brand,
        origin,
        stats,
        warnings,
        effectiveCap,
        budget,
        abortCheck,
        run,
        isShopify: shopifyEligibleForBrowser || !!stats.shopifyFallthrough,
        pageEntries: [],
        disc,
        getRateLimited: () => rateLimited,
        setRateLimited: (v) => { rateLimited = v; },
        getBudgetExpired: () => budgetExpired,
        setBudgetExpired: (v) => { budgetExpired = v; },
        activeSessionRef: { get: () => activeSession, set: (s) => { activeSession = s; } },
        mapOpts
      });
      if (browserNoUrls) return browserNoUrls;
    }

    const reason = stats.lastBlockVendor
      ? `sitemaps found but blocked by ${stats.lastBlockVendor}` +
        (stats.browserAttempted ? ' (browser session also failed)' : '')
      : 'sitemaps found but contained no product page URLs';
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

  // ── Category options (pure string work on already-collected locs) ──
  // Zero extra network. Gated so flag-off is byte-identical (no new keys).
  // Cheap on MAX_SITEMAP_URLS (default 20k); still skip if the total budget
  // already expired so derivation cannot become a hang after a slow walk.
  let categoryOptions = null;
  let categoryPromptSuggested = false;
  const categoryKeys = CATEGORY_OPTIONS_ENABLED && Array.isArray(categories)
    ? categories.map(k => String(k || '').trim()).filter(Boolean)
    : [];
  const wantCategoryWork = CATEGORY_OPTIONS_ENABLED && (
    discoverOnly ||
    categoryKeys.length > 0 ||
    pageEntries.length >= CATEGORY_PROMPT_MIN
  );

  if (wantCategoryWork && !budget.expired()) {
    try {
      const urls = pageEntries.map(e => e && e.loc).filter(Boolean);
      categoryOptions = deriveCategoryOptions(urls, {
        minCount: CATEGORY_MIN_COUNT,
        maxOptions: CATEGORY_MAX_OPTIONS,
        maxDepth: 2
      });
    } catch (err) {
      console.warn(`   ⚠️  ${LOG}  category option derivation failed: ${err.message}`);
      categoryOptions = [];
    }
  }

  // Discover-only: return the options without spending a single PDP fetch.
  if (CATEGORY_OPTIONS_ENABLED && discoverOnly) {
    const totalCandidates = pageEntries.length;
    console.log(
      `   · ${LOG}  discoverOnly: ${totalCandidates} candidates, ` +
      `${(categoryOptions || []).length} category option(s) — no PDP scan`
    );
    run?.stage?.('category options ready');
    const discOut = {
      ok: true,
      mode: 'sitemap-jsonld',
      origin,
      discoverOnly: true,
      totalCandidates,
      categoryOptions: categoryOptions || [],
      products: [],
      stats,
      rateLimited
    };
    // discoverOnly skips Shopify delegation; stamp stays sitemap-jsonld
    // when auto-detect is on (flag-off: no new key).
    if (AUTODETECT_ENABLED) discOut.source = 'sitemap-jsonld';
    return discOut;
  }

  // Selective import: filter candidates by operator-chosen category keys
  // BEFORE the PDP scan (segment-exact match — see matchesAnyCategory).
  // Reassign pageEntries in place so the PDP loop shape
  // (`for (…; i < pageEntries.length; …)`) stays intact for the budget
  // harness and for readers of the scan.
  if (categoryKeys.length) {
    const before = pageEntries.length;
    pageEntries = pageEntries.filter(e => e && matchesAnyCategory(e.loc, categoryKeys));
    stats.candidatesFilteredByCategory = before - pageEntries.length;
    console.log(
      `   · ${LOG}  category filter: ${pageEntries.length}/${before} candidates kept ` +
      `(keys=${categoryKeys.length}, dropped=${stats.candidatesFilteredByCategory})`
    );
    if (!pageEntries.length) {
      const reason =
        `category filter matched 0 of ${before} candidate URLs ` +
        `(keys: ${categoryKeys.slice(0, MAX_LOGGED_CATEGORY_KEYS).join(', ')}` +
        `${categoryKeys.length > MAX_LOGGED_CATEGORY_KEYS ? '…' : ''})`;
      console.warn(`   ⚠️  ${LOG}  ${reason}`);
      const emptyOut = {
        ok: false,
        mode: 'sitemap-jsonld',
        origin,
        products: [],
        stats,
        rateLimited,
        reason
      };
      if (categoryOptions) emptyOut.categoryOptions = categoryOptions;
      return emptyOut;
    }
  }

  // Large catalog, no categories supplied — still run normally (do NOT
  // refuse), but surface options so the caller can suggest narrowing.
  // Use pre-filter size via stats when filtered; otherwise pageEntries.
  const candidateCountForPrompt = categoryKeys.length
    ? (pageEntries.length + (stats.candidatesFilteredByCategory || 0))
    : pageEntries.length;
  if (
    CATEGORY_OPTIONS_ENABLED &&
    !categoryKeys.length &&
    candidateCountForPrompt >= CATEGORY_PROMPT_MIN &&
    categoryOptions &&
    categoryOptions.length
  ) {
    categoryPromptSuggested = true;
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
  // `activeSession` (when harvested) pins Cookie + UA on every PDP.
  const scanOnePdp = async ({ loc, lastmod }) => {
    let allowed = true;
    try { allowed = await http.isAllowedByRobots(loc); } catch { allowed = true; }
    if (!allowed) {
      console.log(`   · ${LOG}  robots disallows ${loc} — skip`);
      return { skipped: true };
    }

    let html = null;
    try {
      const res = await http.fetchText(loc, {
        timeoutMs: 15000,
        maxBytes: 4_000_000,
        session: activeSession
      });
      if (res.block) noteBlock(stats, res.block);
      if (res.cfChallenged) return { cfChallenged: true, block: res.block || null };
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
        for (const node of nodes) {
          mapped = await mapJsonLdProduct(node, loc, null, mapOpts);
          if (mapped) break;
        }
        // Product node(s) present but no structured feed id → recover the
        // id from the page (canonical <meta itemprop=productID>) + re-map.
        if (!mapped) {
          const htmlId = extractProductIdFromHtml(html);
          if (htmlId) {
            for (const node of nodes) {
              mapped = await mapJsonLdProduct(node, loc, htmlId, mapOpts);
              if (mapped) break;
            }
          }
          if (!mapped) idMiss = true;   // real id-resolution miss (counts as validationFailure)
        }
      }
      if (!mapped) {
        mapped = await mapOgProduct(html, loc, mapOpts);
        if (mapped) ogUsed = true;
      }
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
  // PDP rung gets whatever TOTAL budget remains after the sitemap walk.
  // Separate from the sitemap rung so a slow walk cannot silently steal
  // the whole allotment without the operator seeing a budget reason.
  const pdpBudget = budget.enterRung('pdp', budget.remainingMs());
  for (let i = 0; i < pageEntries.length && !stop; i += pdpConcurrency) {
    if (products.length >= effectiveCap) break;
    if (stats.urlsScanned >= MAX_SITEMAP_URLS) break;
    if (await abortCheck()) { aborted = true; break; }
    if (pdpBudget.expired() || budget.expired()) { budgetExpired = true; break; }
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

  // Attach category fields only when the feature flag is on AND we have
  // something to say — keeps flag-off results byte-identical (no new keys).
  // source is similarly gated on AUTODETECT (flag-off = no new key).
  const attachCategoryFields = (out) => {
    if (AUTODETECT_ENABLED && out.source == null) {
      out.source = 'sitemap-jsonld';
    }
    if (!CATEGORY_OPTIONS_ENABLED) return out;
    if (categoryOptions && categoryOptions.length) {
      out.categoryOptions = categoryOptions;
    }
    if (categoryPromptSuggested) {
      out.categoryPromptSuggested = true;
    }
    return out;
  };

  // Aborted mid-scan — return truthfully as cancelled (keeping any
  // partials) rather than misclassifying it as an unscrapeable site.
  if (aborted) {
    return attachCategoryFields({
      ok: products.length > 0,
      mode: 'sitemap-jsonld',
      origin,
      products,
      stats,
      rateLimited,
      cancelled: true,
      reason: 'aborted during product scan'
    });
  }

  // Budget expiry mid-scan — keep products already collected (same partial-
  // keeping contract as abort-mid-scan) but flag budgetExpired, NOT cancelled.
  if (budgetExpired) {
    if (!products.length) {
      const reason = budgetReason(
        `scanned ${stats.urlsScanned} pages but no products extracted before the wall-clock limit`
      );
      console.warn(`   ⚠️  ${LOG}  ${reason}`);
      return attachCategoryFields({
        ok: false,
        mode: 'sitemap-jsonld',
        origin,
        products: [],
        stats,
        rateLimited,
        budgetExpired: true,
        partial: true,
        partialReason: 'budget-exceeded',
        reason
      });
    }
    if (stats.validationFailures > 0) {
      warnings.push(`${stats.validationFailures} product pages failed validation (skipped)`);
    }
    if (stats.cfChallenges > 0) {
      warnings.push(`${stats.cfChallenges} Cloudflare challenge(s) encountered`);
    }
    const reason = budgetReason(`kept ${products.length} product(s)`);
    console.log(`${LOG}  resolveGenericCatalog partial (budget): n=${products.length} ${reason}`);
    const out = {
      ok: true,
      mode: 'sitemap-jsonld',
      origin,
      products,
      stats,
      rateLimited,
      budgetExpired: true,
      partial: true,
      partialReason: 'budget-exceeded',
      reason
    };
    if (warnings.length) out.warnings = warnings;
    return attachCategoryFields(out);
  }

  // ── Decisive unscrapeable / partial outcomes ─────────────────────
  if (!products.length) {
    // Last rung: cheap path scanned (or blocked) to zero products.
    const browserFinal = await tryBrowserSessionRung({
      brand,
      origin,
      stats,
      warnings,
      effectiveCap,
      budget,
      abortCheck,
      run,
      isShopify: shopifyEligibleForBrowser || !!stats.shopifyFallthrough,
      pageEntries,
      disc,
      getRateLimited: () => rateLimited,
      setRateLimited: (v) => { rateLimited = v; },
      getBudgetExpired: () => budgetExpired,
      setBudgetExpired: (v) => { budgetExpired = v; },
      activeSessionRef: { get: () => activeSession, set: (s) => { activeSession = s; } },
      // Re-scan PDP list with harvested session when products.json empty.
      rescanWithSession: true,
      attachCategoryFields,
      mapOpts
    });
    if (browserFinal) return browserFinal;

    let reason;
    if (stats.cfChallenges > 0 && stats.jsonLdProductsFound === 0 && stats.ogFallbackUsed === 0) {
      reason = `blocked by Cloudflare challenge on ${origin}`;
      if (stats.lastBlockVendor && stats.lastBlockVendor !== 'cloudflare') {
        reason = `blocked by ${stats.lastBlockVendor} on ${origin}`;
      }
      if (stats.browserAttempted) reason += ' (browser session also failed)';
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
    return attachCategoryFields({
      ok: false,
      mode: 'sitemap-jsonld',
      origin,
      products: [],
      stats,
      rateLimited,
      reason
    });
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
  return attachCategoryFields(out);
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
  imagesFromNode,
  // Shopify gallery enrichment (Lane Q — full-res multi-image on JSON-LD path)
  extractShopifyProductHandle,
  imagesFromShopifyProductPayload,
  preferShopifyGallery,
  shouldEnrichShopifyGallery,
  tryShopifyProductGallery,
  SHOPIFY_GALLERY_ENRICH_ENABLED,
  deriveCategoryOptions,
  matchesAnyCategory,
  DEFAULT_CAP,
  MAX_SITEMAP_URLS,
  AUTODETECT_ENABLED
};
