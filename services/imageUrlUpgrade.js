// services/imageUrlUpgrade.js
//
// PURE upgrade of resized / thumbnail catalog image URLs → original-size
// URLs, plus an injectable HEAD-verified resolve path.
//
// WHY (measured live, marinelayer.com 2026-08-11): JSON-LD / OG often emit
// a Shopify `_small` thumbnail as Product.image. Same photo, two paths:
//   products.json → ...Final-Web.jpg?v=…          757,341 bytes
//   JSON-LD PDP   → ...Final-Web_small.jpg?v=…      3,820 bytes  (198× smaller)
// The hero is the DEFAULT AD SEED (CATALOG_FEED_ORDER_SEEDING /
// preferFirstCatalogImage), so a 3.8KB thumbnail has been feeding billable
// gpt-image-2 generations. Garbage in, paid garbage out.
//
// FALSE POSITIVE: a file can legitimately be NAMED with a size token
// (`photo_large.jpg`). Blind stripping → `photo.jpg` → 404. Strictly worse
// than the bug. resolveUpgradedImageUrl therefore HEAD-checks the candidate
// and falls back to the original on any non-2xx / network error / timeout.
//
// NO I/O in upgradeImageUrl. resolveUpgradedImageUrl takes an injected
// fetchHead so the module stays offline-testable; the caller supplies one
// backed by httpScrapeClient (per-domain concurrency, 250ms min-gap, 429
// backoff). Never throw.

'use strict';

// Named Shopify size tokens that sit immediately before the file extension
// (optionally followed by _crop_* and/or @2x).
const SHOPIFY_NAMED_SIZES =
  'pico|icon|thumb|small|compact|medium|large|grande|original|master';

// Dimension shapes: _1024x1024, _600x, _x800, optionally @2x on the dims.
const SHOPIFY_DIM_SIZE = '(?:\\d+x\\d+|\\d+x|x\\d+)(?:@\\d+x)?';

// Optional trailing crop hint + optional trailing @2x (either order is rare;
// both covered). Lookahead keeps the extension intact.
const SHOPIFY_SIZE_RE = new RegExp(
  `_(?:(?:${SHOPIFY_NAMED_SIZES})|${SHOPIFY_DIM_SIZE})` +
    `(?:_crop_[a-z]+)?(?:@\\d+x)?(?=\\.[^./?#]+$)`,
  'i'
);

// WordPress / WooCommerce attachment sizes: shirt-150x150.jpg → shirt.jpg
const WP_SIZE_RE = /-\d+x\d+(?=\.[^./?#]+$)/i;

// Query params that only resize the delivered asset on Shopify's image CDN.
const SHOPIFY_RESIZE_QUERY_KEYS = new Set(['width', 'height', 'crop']);

function isCatalogImageUpgradeEnabled() {
  // Default ON. Flag-off restores byte-identical prior path: no upgrades, no HEADs.
  return String(process.env.CATALOG_IMAGE_UPGRADE_ENABLED || 'true').toLowerCase() !== 'false';
}

function catalogImageUpgradeMaxChecks() {
  const n = parseInt(process.env.CATALOG_IMAGE_UPGRADE_MAX_CHECKS, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return 500;
}

/**
 * True when the URL is served via Shopify's image CDN (host or path form).
 * Host: cdn.shopify.com. Path: /cdn/shop/… or /cdn/shopifycloud/… (theme/
 * storefront proxy that rewrites to the same assets).
 */
function isShopifyCdnUrl(parsed) {
  if (!parsed || !parsed.hostname) return false;
  const host = String(parsed.hostname).toLowerCase();
  if (host === 'cdn.shopify.com') return true;
  const path = parsed.pathname || '';
  if (path.includes('/cdn/shop/') || path.includes('/cdn/shopifycloud/')) return true;
  return false;
}

function looksLikeAbsoluteHttpUrl(s) {
  if (typeof s !== 'string' || !s) return false;
  // Reject relative / scheme-less inputs without throwing.
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop only Shopify resize query params (width/height/crop). Preserve `v`
 * and every other key byte-for-byte (order of remaining keys is kept).
 * Returns { search, dropped } where search includes leading `?` or is ''.
 */
function stripShopifyResizeQuery(search) {
  if (!search || search === '?') return { search: '', dropped: false };
  const raw = search.charAt(0) === '?' ? search.slice(1) : search;
  if (!raw) return { search: '', dropped: false };
  const parts = raw.split('&');
  const kept = [];
  let dropped = false;
  for (const part of parts) {
    if (!part) {
      kept.push(part);
      continue;
    }
    const eq = part.indexOf('=');
    const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
    if (SHOPIFY_RESIZE_QUERY_KEYS.has(key)) {
      dropped = true;
      continue;
    }
    kept.push(part);
  }
  if (!dropped) return { search: search.charAt(0) === '?' ? search : `?${raw}`, dropped: false };
  if (!kept.length) return { search: '', dropped: true };
  return { search: `?${kept.join('&')}`, dropped: true };
}

/**
 * upgradeImageUrl(url) → { url, upgraded, original, reason }
 *
 * Pure. Never throws. Non-string / empty / relative / unparseable → input
 * returned unchanged with upgraded:false.
 */
function upgradeImageUrl(url) {
  const original = url;
  if (url == null || url === '') {
    return { url, upgraded: false, original, reason: null };
  }
  if (typeof url !== 'string') {
    return { url, upgraded: false, original, reason: null };
  }
  if (!looksLikeAbsoluteHttpUrl(url)) {
    return { url, upgraded: false, original, reason: null };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { url, upgraded: false, original, reason: null };
  }

  // ── Shopify CDN ────────────────────────────────────────────────────
  if (isShopifyCdnUrl(parsed)) {
    let pathname = parsed.pathname || '';
    let reason = null;
    let changed = false;

    if (SHOPIFY_SIZE_RE.test(pathname)) {
      pathname = pathname.replace(SHOPIFY_SIZE_RE, '');
      changed = true;
      reason = 'shopify-size-suffix';
    }

    const q = stripShopifyResizeQuery(parsed.search || '');
    if (q.dropped) {
      changed = true;
      reason = reason || 'shopify-resize-query';
    }

    if (!changed) {
      return { url, upgraded: false, original, reason: null };
    }

    // Rebuild WITHOUT using URL.toString() on the whole thing — that can
    // normalise encoding. Path + remaining query are spliced; origin and
    // hash stay as the parser saw them. Query string is preserved verbatim
    // for non-resize keys (Shopify's ?v= is a content version).
    const upgradedUrl =
      parsed.origin + pathname + q.search + (parsed.hash || '');
    if (upgradedUrl === url) {
      return { url, upgraded: false, original, reason: null };
    }
    return { url: upgradedUrl, upgraded: true, original, reason };
  }

  // ── WordPress / WooCommerce ────────────────────────────────────────
  // Any absolute http(s) URL with a trailing -{W}x{H} before the extension.
  {
    const pathname = parsed.pathname || '';
    if (WP_SIZE_RE.test(pathname)) {
      const nextPath = pathname.replace(WP_SIZE_RE, '');
      if (nextPath !== pathname) {
        const upgradedUrl =
          parsed.origin + nextPath + (parsed.search || '') + (parsed.hash || '');
        if (upgradedUrl !== url) {
          return {
            url: upgradedUrl,
            upgraded: true,
            original,
            reason: 'wordpress-size-suffix'
          };
        }
      }
    }
  }

  return { url, upgraded: false, original, reason: null };
}

/**
 * De-dupe a list of URLs preserving first-seen order.
 * Used AFTER upgrading: a _small and a _1024x1024 of the same photo can
 * collapse to one original; shipping both would inflate additionalImages
 * and skew feedIndex (load-bearing for the default ad seed).
 */
function dedupeUrlsFirstSeen(urls) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(urls)) return out;
  for (const u of urls) {
    if (u == null || u === '') continue;
    const key = String(u);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/**
 * resolveUpgradedImageUrl(url, { fetchHead, memo, checksUsedRef, maxChecks })
 * → string (the URL to store)
 *
 * - If upgradeImageUrl did not change the URL → return input, no request.
 * - Otherwise HEAD the upgraded URL via injected fetchHead(url) → status.
 *   Keep upgraded ONLY on 2xx. Any non-2xx, throw, or missing fetchHead
 *   → fall back to the original. Fail safe: a working thumbnail beats a
 *   broken original.
 * - Memoise per distinct ORIGINAL url within a run (memo Map).
 * - Cap total verification requests via maxChecks; past the cap, leave
 *   candidates un-upgraded (do not swap without verification).
 *
 * Never throws.
 */
async function resolveUpgradedImageUrl(url, opts = {}) {
  const {
    fetchHead = null,
    memo = null,
    checksUsedRef = null,
    maxChecks = catalogImageUpgradeMaxChecks()
  } = opts;

  // Garbage in → garbage out, no throw.
  if (url == null || typeof url !== 'string' || !url) return url;

  if (memo && memo.has(url)) return memo.get(url);

  let candidate;
  try {
    candidate = upgradeImageUrl(url);
  } catch {
    if (memo) memo.set(url, url);
    return url;
  }

  if (!candidate || !candidate.upgraded || candidate.url === url) {
    if (memo) memo.set(url, url);
    return url;
  }

  // Past the verification budget → leave un-upgraded (not unverified-swapped).
  const used =
    checksUsedRef && typeof checksUsedRef.used === 'number'
      ? checksUsedRef.used
      : 0;
  if (used >= maxChecks) {
    if (memo) memo.set(url, url);
    return url;
  }

  if (typeof fetchHead !== 'function') {
    // No verifier injected → fail safe, keep original.
    if (memo) memo.set(url, url);
    return url;
  }

  if (checksUsedRef) checksUsedRef.used = used + 1;

  let status;
  try {
    status = await fetchHead(candidate.url);
  } catch {
    if (memo) memo.set(url, url);
    return url;
  }

  const ok =
    typeof status === 'number' && status >= 200 && status < 300;
  const chosen = ok ? candidate.url : url;
  if (memo) memo.set(url, chosen);
  return chosen;
}

/**
 * Upgrade every URL (HEAD-verified), then de-dupe first-seen.
 * Cap on additional entries is applied by the caller (imagesFromNode).
 */
async function upgradeImageUrlList(urls, opts = {}) {
  if (!Array.isArray(urls) || !urls.length) return [];
  const resolved = [];
  for (const u of urls) {
    // eslint-disable-next-line no-await-in-loop
    const next = await resolveUpgradedImageUrl(u, opts);
    resolved.push(next);
  }
  return dedupeUrlsFirstSeen(resolved);
}

/**
 * createImageUpgradeRun({ fetchHead, maxChecks }) — one per catalog resolve.
 * Owns the memo Map + check counter so N products sharing a size pattern
 * do not pay N HEADs for the same answer, and the run cannot exceed the
 * verification budget.
 */
function createImageUpgradeRun({ fetchHead = null, maxChecks = null } = {}) {
  const memo = new Map();
  const checksUsedRef = { used: 0 };
  const cap =
    maxChecks == null ? catalogImageUpgradeMaxChecks() : Math.max(0, maxChecks | 0);

  return {
    memo,
    checksUsedRef,
    maxChecks: cap,
    get checksUsed() {
      return checksUsedRef.used;
    },
    async resolve(url) {
      return resolveUpgradedImageUrl(url, {
        fetchHead,
        memo,
        checksUsedRef,
        maxChecks: cap
      });
    },
    async upgradeList(urls) {
      return upgradeImageUrlList(urls, {
        fetchHead,
        memo,
        checksUsedRef,
        maxChecks: cap
      });
    }
  };
}

/**
 * Build a fetchHead(url) → statusNumber backed by httpScrapeClient.
 * Uses HEAD first; on 405/501 falls back to a ranged GET (bytes=0-0) so
 * hosts that reject HEAD still verify. Never throws — returns 0 on error.
 */
function makeHttpScrapeFetchHead(httpClient, { timeoutMs = 8000, session = null } = {}) {
  if (!httpClient || typeof httpClient.fetchText !== 'function') {
    return async () => 0;
  }
  return async function fetchHead(url) {
    try {
      const res = await httpClient.fetchText(url, {
        method: 'HEAD',
        timeoutMs,
        maxBytes: 0,
        session: session || null
      });
      const status = res && typeof res.status === 'number' ? res.status : 0;
      if (status === 405 || status === 501) {
        const res2 = await httpClient.fetchText(url, {
          method: 'GET',
          timeoutMs,
          maxBytes: 1,
          headers: { Range: 'bytes=0-0' },
          session: session || null
        });
        // 206 Partial Content is success for a ranged probe.
        return res2 && typeof res2.status === 'number' ? res2.status : 0;
      }
      return status;
    } catch {
      return 0;
    }
  };
}

module.exports = {
  upgradeImageUrl,
  resolveUpgradedImageUrl,
  upgradeImageUrlList,
  dedupeUrlsFirstSeen,
  createImageUpgradeRun,
  makeHttpScrapeFetchHead,
  isCatalogImageUpgradeEnabled,
  catalogImageUpgradeMaxChecks,
  isShopifyCdnUrl,
  // exported for harnesses / revert-proof
  SHOPIFY_SIZE_RE,
  WP_SIZE_RE
};
