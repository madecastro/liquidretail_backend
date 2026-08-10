// Pure category-option derivation from product sitemap URLs.
// No I/O beyond the local productish module — zero PDP fetches.
//
// Goal: turn a large sitemap walk (e.g. fanatics ~800k locs) into a short,
// operator-facing list of category keys so a selective import can filter
// BEFORE any product-page scan. Counts aggregate across the whole walk.
//
// Matching rule (matchesAnyCategory): PATH-SEGMENT exact equality, never a
// naive substring. `new-york-yankees` matches a segment of that exact name
// only — it does NOT match `new-york-yankees-kids`. Depth-2 keys (`a/b`)
// match two consecutive path segments.

'use strict';

const { scoreProductish } = require('./productish');

// Site scaffolding that is never a real category, even when scoreProductish
// is ≤0 (listing demotion can make "collections" score negative).
const NON_CATEGORY_SEGS = new Set([
  'products', 'product',
  'collections', 'collection',
  'category', 'categories',
  'p', 'item', 'items',
  'shop', 'dp', 'sku'
]);

// Locale path tokens: 2-letter (`en`, `us`) or BCP-47-ish `xx-yy` (`en-us`,
// `fr-ca`). Case-insensitive. Deliberately does NOT swallow longer tokens
// like `en-english` or team codes that happen to contain a hyphen.
const LOCALE_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;

// Noise: pure decimal integer (any length).
const PURE_NUMBER_RE = /^\d+$/;
// Hex-ish blob — long enough that short real words like "cafe" survive.
const HEXISH_RE = /^[0-9a-f]{6,}$/i;
// Single-letter + digits id fragment (`p123`, `a99`).
const ID_FRAG_RE = /^[a-z]\d+$/i;

// A single dominant bucket above this share of the corpus is flagged
// `suspicious: true` rather than silently trusted (prototype junk like
// `lege` at ~36% of a fanatics sub-sitemap).
const SUSPICIOUS_SHARE = 0.30;

const SAMPLE_MAX_LEN = 200;

/**
 * True when `seg` looks like a locale code we should drop from the path
 * before considering category candidates.
 */
function isLocaleSeg(seg) {
  return typeof seg === 'string' && LOCALE_RE.test(seg);
}

/**
 * Opaque / id-like / too-short noise. These must never become options
 * even when they dominate frequency counts.
 */
function isNoiseSeg(seg) {
  if (seg == null) return true;
  const s = String(seg);
  if (!s) return true;
  if (s.length <= 2) return true;
  if (PURE_NUMBER_RE.test(s)) return true;
  if (HEXISH_RE.test(s)) return true;
  if (s.includes('+')) return true;
  if (ID_FRAG_RE.test(s)) return true;
  return false;
}

/**
 * A segment is usable as (part of) a category key only when it clears
 * noise, denylist, and the productish heuristic.
 */
function isCategorySeg(seg) {
  if (seg == null) return false;
  const s = String(seg).trim();
  if (!s) return false;
  if (isNoiseSeg(s)) return false;
  if (NON_CATEGORY_SEGS.has(s.toLowerCase())) return false;
  // scoreProductish on the bare token — filters `product`/`item`/`shop`
  // and id-shaped segments (`+p-123…`) without requiring a full URL.
  if (scoreProductish(s) > 0) return false;
  return true;
}

/**
 * Parse a product URL into cleaned path segments ready for category
 * extraction: empty + locale dropped, last segment (product slug/id)
 * dropped. Returns null on garbage input (never throws).
 */
function categoryPathSegs(url) {
  if (url == null || typeof url !== 'string' || !url) return null;
  let pathname;
  try {
    pathname = new URL(url).pathname || '';
  } catch {
    return null;
  }
  // Drop empty segments (fanatics `//` after locale) and locale codes.
  const segs = pathname.split('/').filter(s => s && !isLocaleSeg(s));
  if (segs.length < 2) return null; // need at least category + product slug
  // Last segment is the product identity (slug or id) — never a category.
  segs.pop();
  return segs.length ? segs : null;
}

/**
 * Humanise a raw key: hyphens → spaces, title-case each word. Depth-2
 * keys (`a/b`) join with " / " so the UI can show "Car / Ty Gibbs".
 */
function humanizeKey(key) {
  return String(key)
    .split('/')
    .map(part =>
      part
        .split('-')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ')
    )
    .join(' / ');
}

function clipSample(url) {
  if (url == null) return null;
  const s = String(url);
  if (s.length <= SAMPLE_MAX_LEN) return s;
  return s.slice(0, SAMPLE_MAX_LEN - 1) + '…';
}

/**
 * deriveCategoryOptions(urls, opts) → [{ key, label, count, depth, sample, suspicious? }]
 *
 * Pure. Garbage in → []. Never throws.
 *
 * opts:
 *   minCount   – suppress long-tail noise (default 25)
 *   maxOptions – cap the list (default 40)
 *   maxDepth   – consider seg[0] … seg[0]/…/seg[maxDepth-1] (default 2)
 */
function deriveCategoryOptions(urls, opts = {}) {
  try {
    if (!Array.isArray(urls) || !urls.length) return [];

    const minCount = Math.max(1, parseInt(opts.minCount, 10) || 25);
    const maxOptions = Math.max(1, parseInt(opts.maxOptions, 10) || 40);
    const maxDepth = Math.max(1, parseInt(opts.maxDepth, 10) || 2);

    // key → { count, depth, sample }
    const buckets = new Map();
    let corpus = 0;

    for (const raw of urls) {
      const segs = categoryPathSegs(raw);
      if (!segs) continue;
      corpus += 1;

      // Drop scaffolding / noise / productish segments (collections,
      // products, locale already gone, id blobs, …) then take PREFIXES of
      // what remains up to maxDepth. Filtering (not "break at first miss")
      // is load-bearing for Shopify
      // `/collections/skincare/products/retinol-24` → `skincare`: a break
      // at `collections` would yield no category at all.
      const usableAll = [];
      for (const seg of segs) {
        if (!isCategorySeg(seg)) continue;
        usableAll.push(seg.toLowerCase());
      }
      if (!usableAll.length) continue;
      const usable = usableAll.slice(0, maxDepth);

      for (let d = 1; d <= usable.length; d += 1) {
        const key = usable.slice(0, d).join('/');
        let b = buckets.get(key);
        if (!b) {
          b = { count: 0, depth: d, sample: null };
          buckets.set(key, b);
        }
        b.count += 1;
        if (!b.sample && typeof raw === 'string') b.sample = clipSample(raw);
      }
    }

    if (!buckets.size) return [];

    const out = [];
    for (const [key, b] of buckets) {
      if (b.count < minCount) continue;
      const row = {
        key,
        label: humanizeKey(key),
        count: b.count,
        depth: b.depth,
        sample: b.sample
      };
      // Flag a dominant blob rather than silently promoting it — an
      // operator can see that `lege` is not a real category.
      if (corpus > 0 && b.count / corpus > SUSPICIOUS_SHARE) {
        row.suspicious = true;
      }
      out.push(row);
    }

    // Deterministic: count desc, then key asc. Never rely on Map order.
    out.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      return 0;
    });

    return out.slice(0, maxOptions);
  } catch {
    // Absolute safety — pure helpers must never break the resolver.
    return [];
  }
}

/**
 * matchesAnyCategory(url, keys) → boolean
 *
 * Path-SEGMENT exact match (and consecutive-segment match for depth-2+
 * keys that contain `/`). NOT a substring search: a key of
 * `new-york-yankees` will not match a path segment `new-york-yankees-kids`.
 *
 * Locale / empty segments are still present in the path for matching —
 * the operator's key is matched against the raw path tokens (lowercased),
 * so a key derived earlier still finds its products. Empty segments from
 * `//` are dropped so indices stay aligned with derivation.
 *
 * Garbage in → false. Never throws.
 */
function matchesAnyCategory(url, keys) {
  try {
    if (url == null || typeof url !== 'string' || !url) return false;
    if (!Array.isArray(keys) || !keys.length) return false;

    let segs;
    try {
      segs = (new URL(url).pathname || '')
        .split('/')
        .filter(Boolean)
        .map(s => s.toLowerCase());
    } catch {
      return false;
    }
    if (!segs.length) return false;

    const want = [];
    for (const k of keys) {
      if (k == null) continue;
      const s = String(k).trim().toLowerCase();
      if (s) want.push(s);
    }
    if (!want.length) return false;

    for (const key of want) {
      if (key.includes('/')) {
        const parts = key.split('/').filter(Boolean);
        if (!parts.length) continue;
        // Sliding window of consecutive path segments.
        for (let i = 0; i <= segs.length - parts.length; i += 1) {
          let ok = true;
          for (let j = 0; j < parts.length; j += 1) {
            if (segs[i + j] !== parts[j]) { ok = false; break; }
          }
          if (ok) return true;
        }
      } else {
        // Single-token key: exact segment equality only.
        if (segs.includes(key)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  deriveCategoryOptions,
  matchesAnyCategory,
  // Exported for harness / diagnostics — not part of the public contract.
  isNoiseSeg,
  isLocaleSeg,
  isCategorySeg,
  humanizeKey,
  SUSPICIOUS_SHARE
};
