// services/reviewAdapters/helpers.js
//
// Shared, dependency-free helpers for the review adapters.
//
// These live here rather than in index.js because index.js requires every
// adapter at module load. An adapter requiring index.js back would get a
// half-initialised module object (index.js assigns module.exports at the
// END of the file), so firstMatch & co. would be undefined at adapter
// module scope. Separate leaf module, no cycle.

'use strict';

const {
  cleanScrapedText, decodeHtmlEntities, truncateSentences
} = require('../../utils/htmlEntities');

// Stored length of one review body. 400 was too tight — measured live, 10 of 50
// Ulta reviews and 1 of 50 Living Spaces reviews hit it and were cut mid-word.
// 1200 clears essentially every real review while keeping documents bounded;
// anything longer is truncated at a word boundary with an ellipsis.
const REVIEW_TEXT_MAX = Math.max(
  120,
  parseInt(process.env.REVIEW_TEXT_MAX_CHARS, 10) || 1200
);
const REVIEW_TITLE_MAX = 200;
const REVIEW_AUTHOR_MAX = 120;

/**
 * firstMatch(html, regexes, groupIndex?) → string | null
 * First capturing-group hit across an ordered regex list. Vendors put the
 * same identifier in several shapes (data-attribute, inline JSON, script
 * src), so discovery is always a list, most-reliable first.
 */
function firstMatch(html, regexes, groupIndex = 1) {
  if (!html) return null;
  for (const re of regexes) {
    // Fresh regex when /g — adapters define these at module scope and a
    // sticky lastIndex would leak between products.
    const rx = re.global ? new RegExp(re.source, re.flags.replace('g', '')) : re;
    const m = String(html).match(rx);
    if (m && m[groupIndex] != null && String(m[groupIndex]).trim()) {
      return String(m[groupIndex]).trim();
    }
  }
  return null;
}

/** Dot-path reader: pick(obj, 'response.pagination.total'). */
function pick(obj, path) {
  if (obj == null || !path) return undefined;
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** First defined, non-empty value among several dot-paths. */
function pickAny(obj, paths) {
  for (const p of paths) {
    const v = pick(obj, p);
    if (v != null && v !== '') return v;
  }
  return undefined;
}

// First number in a string — "4.6 out of 5" → 4.6, "1,234 reviews" → 1234.
// Stripping all non-digits instead would produce 4.65 for the first.
function firstNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/(\d),(\d{3})\b/g, '$1$2');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = firstNumber(v);
  return n == null ? null : Math.round(n);
}

function toFloat(v) {
  return firstNumber(v);
}

/** Dedupe/identity key for a review body. */
function reviewKey(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * shopifyProductId(html) → numeric id string | null
 *
 * Most Shopify review apps key on the store's own numeric product id, and
 * every Shopify PDP carries it in the analytics blob regardless of theme or
 * app. Ordered by reliability: the analytics blob is platform-standard, the
 * data-attributes are theme-dependent.
 *
 * Deliberately NOT matching bare `"id":\d+` — a PDP is full of variant ids,
 * collection ids and image ids, and grabbing the wrong one produces reviews
 * for a different product (silently, since the API happily returns none).
 */
const SHOPIFY_PRODUCT_ID_RES = [
  /var\s+meta\s*=\s*\{[^<]*?"product"\s*:\s*\{\s*"id"\s*:\s*(\d{6,})/,
  /"product"\s*:\s*\{\s*"id"\s*:\s*(\d{6,})\s*,\s*"gid"/,
  /ShopifyAnalytics\.meta[^<]{0,400}?"product"\s*:\s*\{\s*"id"\s*:\s*(\d{6,})/,
  /data-product-id\s*=\s*["'](\d{6,})["']/,
  /"productId"\s*:\s*"?(\d{6,})"?/
];

function shopifyProductId(html) {
  return firstMatch(html, SHOPIFY_PRODUCT_ID_RES);
}

/**
 * shopDomain(html, pageUrl) → 'store.myshopify.com' | pageUrl host | null
 * Review APIs that scope by shop want the permanent myshopify domain when
 * it's available; the storefront host works for most of them as a fallback.
 */
const MYSHOPIFY_RES = [
  /["']?(?:shopDomain|shop_domain|permanent_domain|myshopifyDomain)["']?\s*[:=]\s*["']([a-z0-9-]+\.myshopify\.com)["']/i,
  /\bshop=([a-z0-9-]+\.myshopify\.com)/i,
  /([a-z0-9-]+\.myshopify\.com)/i
];

function shopDomain(html, pageUrl) {
  const m = firstMatch(html, MYSHOPIFY_RES);
  if (m) return m.toLowerCase();
  try {
    return new URL(pageUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Storefront host of the PDP, no scheme. */
function pageHost(pageUrl) {
  try {
    return new URL(pageUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * htmlToText(fragment, maxLen?) → string | null
 * Widget responses that ship HTML (Judge.me) → plain review text. Block
 * boundaries become spaces so "<p>a</p><p>b</p>" doesn't fuse into "ab".
 */
function stripReviewMarkup(fragment) {
  return String(fragment)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '');
}

function htmlToText(fragment, maxLen = 400) {
  if (!fragment) return null;
  return cleanScrapedText(decodeHtmlEntities(stripReviewMarkup(fragment)), maxLen);
}

/**
 * distributionFromCounts(counts, order) → [{stars, count}] | null
 * Vendors send star histograms as arrays or 1..5-keyed objects, and the
 * array ones are ASCENDING (index 0 = 1-star) often enough that assuming
 * descending silently inverts the histogram. Callers state the order.
 */
function distributionFromCounts(counts, order = 'asc') {
  if (!counts) return null;
  let pairs = [];
  if (Array.isArray(counts)) {
    if (counts.length !== 5) return null;
    pairs = counts.map((c, i) => ({
      stars: order === 'asc' ? i + 1 : 5 - i,
      count: toInt(c) || 0
    }));
  } else if (typeof counts === 'object') {
    for (const [k, v] of Object.entries(counts)) {
      const stars = toInt(k);
      if (stars == null || stars < 1 || stars > 5) continue;
      pairs.push({ stars, count: toInt(v) || 0 });
    }
    if (!pairs.length) return null;
  } else {
    return null;
  }
  return pairs.sort((a, b) => b.stars - a.stars);
}

/** Vendor date → Date | null. Handles ISO strings and epoch ms/seconds. */
function toDate(v) {
  if (v == null) return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    const ms = String(v).length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Trim a scraped display string to a bounded, entity-decoded form. */
function text(v, maxLen) {
  return cleanScrapedText(v, maxLen);
}

/**
 * reviewText(v) → string | null
 * A review BODY: decoded, whitespace-normalised, and — only when it exceeds
 * REVIEW_TEXT_MAX — shortened by keeping the MOST USEFUL whole sentences in
 * their original order (utils/reviewText.shortenReview). Never mid-sentence,
 * never an ellipsis, never rewritten. `text()` stays for titles/authors, where
 * a word-boundary cut is appropriate.
 */
function reviewText(v) {
  const clean = cleanScrapedText(v);            // no cap — decode + normalise only
  if (!clean) return null;
  return require('../../utils/reviewText').shortenReview(clean, REVIEW_TEXT_MAX);
}

/**
 * reviewHtmlText(fragment) → string | null
 * reviewText() for vendors that ship the body as an HTML fragment (Judge.me).
 * Tags are stripped and entities decoded BEFORE any length decision, so the
 * bound applies to the text a reader sees rather than to the markup.
 */
function reviewHtmlText(fragment) {
  if (!fragment) return null;
  return reviewText(decodeHtmlEntities(stripReviewMarkup(fragment)));
}

module.exports = {
  reviewText,
  reviewHtmlText,
  REVIEW_TEXT_MAX,
  REVIEW_TITLE_MAX,
  REVIEW_AUTHOR_MAX,
  firstMatch,
  pick,
  pickAny,
  firstNumber,
  toInt,
  toFloat,
  toDate,
  text,
  reviewKey,
  shopifyProductId,
  shopDomain,
  pageHost,
  htmlToText,
  distributionFromCounts
};
