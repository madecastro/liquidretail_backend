// services/reviewAdapters/index.js
//
// Tier-2 review capture: per-vendor PUBLIC read APIs, paginated.
//
// WHY A SECOND TIER: the schema.org data a review app publishes for rich
// snippets (tier 1, productReviewsScrapeService.extractOnPageReviews) is
// capped by the app — Judge.me publishes ~2 of 81 reviews, Bazaarvoice
// publishes ~6 of 156, and stores whose widget renders client-side publish
// none at all. The widget itself reads a public JSON endpoint with no
// credentials, keyed by an identifier that is sitting in the page HTML.
// Reading that same endpoint gets the full, paginated review set.
//
// ADAPTER CONTRACT — one module per platform in this directory:
//
//   platform   'judge.me' | 'yotpo' | …  matches detectReviewPlatform()
//   pageSize   number — reviews requested per page
//
//   discover(html, pageUrl) → ctx | null
//       Pull the public identifiers (app key / store id / product id) out
//       of the PDP HTML. null = this adapter cannot serve this page, which
//       is the normal answer for 12 of the 13 adapters on any given page.
//
//   request(ctx, page) → { url, as: 'json' | 'text', headers? }
//       page is ZERO-BASED here; adapters convert to whatever the vendor
//       wants (1-based page, item offset, cursor from state).
//
//   parse(payload, ctx, page) → {
//       reviews: rawReview[],      // vendor-shaped, passed to normalize()
//       total?: number,            // total review count for the product
//       average?: number,          // aggregate rating
//       distribution?: {stars:count},
//       hasMore?: boolean,         // omit → driver infers from page fill
//       cursor?: any               // stashed on ctx for the next request()
//   }
//
//   normalize(raw, ctx) → { text, title, author, rating, datePublished, verified }
//       Vendor row → engine quote shape. Return null to skip a row.
//
// EVERY request goes through httpScrapeClient so vendor hosts get the same
// per-host throttle, UA rotation, 429/Retry-After handling and byte caps as
// the rest of our crawling. Adapters never call fetch() directly.
//
// ROBOTS IS ENFORCED ON VENDOR HOSTS TOO (checked live 2026-07-27):
//   api-cdn.yotpo.com   Disallow: / BUT explicit Allow: /v1/widget/*,
//                       /products/*/*/reviews, /v1/star_distribution/* —
//                       i.e. the widget read endpoints are opened on purpose.
//   judge.me            explicit Allow: /api/v1 (+ /api/docs); the
//                       disallow list is unsubscribe/email/admin paths.
//   stamped.io          only /go disallowed.
//   api.reviews.io      "Disallow:" (empty) — allow all.
//   api.bazaarvoice.com no robots.txt (404) — nothing stated.
//   display.powerreviews.com  no robots.txt (404) — nothing stated.
//   api.okendo.io       robots.txt 403s — nothing stated.
//   loox.io             Disallow: /widget AND /widgets → THEIR REVIEW
//                       ENDPOINTS ARE OFF-LIMITS. That is why there is no
//                       loox adapter in this directory, and it isn't an
//                       oversight: Loox reviews are reachable only via the
//                       merchant page's own rich snippets (tier 1) or by
//                       rendering the merchant page and reading what it
//                       displays (tier 3 DOM read — we fetch the merchant's
//                       page, which we are allowed to fetch, and never call
//                       loox.io ourselves).
// The gate below re-checks robots at runtime rather than trusting this list,
// so a vendor tightening their policy stops us automatically.

'use strict';

const http = require('../httpScrapeClient');

const LOG = '⭐';

// ── caps ───────────────────────────────────────────────────────────
//
// Blast-radius control. A 10k-product catalog × unbounded pagination is a
// six-figure request count; these keep a full sweep proportional. Reviews
// are for surfacing a handful of positive quotes plus an honest rating
// distribution — we do not need every review ever written.
const MAX_PAGES = Math.max(
  1,
  parseInt(process.env.REVIEW_ADAPTER_MAX_PAGES, 10) || 5
);
const MAX_REVIEWS = Math.max(
  1,
  parseInt(process.env.REVIEW_ADAPTER_MAX_REVIEWS, 10) || 100
);
const REQUEST_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.REVIEW_ADAPTER_TIMEOUT_MS, 10) || 12000
);
const MAX_BYTES = 4_000_000;
// Master switch — adapters are pure additive value, so a bad vendor day
// should be one env var away from off.
const ENABLED = process.env.REVIEW_ADAPTERS_ENABLED !== 'false';

// ── shared helpers for adapter modules ─────────────────────────────

/**
 * firstMatch(html, regexes, groupIndex?) → string | null
 * First capturing-group hit across an ordered regex list. Adapters use
 * this for identifier discovery, where sites put the same key in several
 * shapes (inline JSON, data-attribute, script src query).
 */
function firstMatch(html, regexes, groupIndex = 1) {
  if (!html) return null;
  for (const re of regexes) {
    // Fresh regex per use: adapter modules define these at module scope and
    // a /g one would carry lastIndex between products.
    const rx = re.global ? new RegExp(re.source, re.flags.replace('g', '')) : re;
    const m = html.match(rx);
    if (m && m[groupIndex] != null && String(m[groupIndex]).trim()) {
      return String(m[groupIndex]).trim();
    }
  }
  return null;
}

/**
 * pick(obj, path) → value | undefined
 * Dot/bracket path reader ('response.reviews.0.content'). Adapters keep
 * their field mapping declarative and readable.
 */
function pick(obj, path) {
  if (obj == null || !path) return undefined;
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** First defined value among several paths. */
function pickAny(obj, paths) {
  for (const p of paths) {
    const v = pick(obj, p);
    if (v != null && v !== '') return v;
  }
  return undefined;
}

// First number in the string, not "every digit concatenated" — vendors send
// "4.6 out of 5" and "1,234 reviews", where stripping non-digits would yield
// 4.65 and (correctly) 1234. Thousands separators are dropped first so the
// grouped form still parses.
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

// ── registry ───────────────────────────────────────────────────────
//
// Order matters only for logging; lookup is by platform slug. Each module
// self-reports the slug so the registry can't drift from the detector.
const ADAPTER_MODULES = [
  './judgeme',
  './yotpo',
  './okendo',
  './stamped',
  './bazaarvoice',
  './powerreviews',
  './reviewsio',
  './shopifyLegacy'
];

const ADAPTERS = [];
for (const mod of ADAPTER_MODULES) {
  try {
    // eslint-disable-next-line global-require
    const a = require(mod);
    if (a && a.platform && typeof a.discover === 'function') ADAPTERS.push(a);
  } catch (err) {
    console.warn(`${LOG}  review adapter ${mod} failed to load: ${err.message}`);
  }
}

const BY_PLATFORM = new Map(ADAPTERS.map(a => [a.platform, a]));

/**
 * adaptersFor(platform) → adapter[]
 * The detected platform's adapter first, then every other adapter as a
 * fallback: platform detection is a keyword sniff over HTML and gets it
 * wrong both ways (a store can carry markers for three apps it once
 * trialled). discover() is the authoritative test — it either finds real
 * identifiers on the page or returns null — so trying the rest costs
 * nothing but a few regexes.
 */
function adaptersFor(platform) {
  const primary = platform ? BY_PLATFORM.get(platform) : null;
  if (!primary) return ADAPTERS.slice();
  return [primary, ...ADAPTERS.filter(a => a !== primary)];
}

// ── pagination driver ──────────────────────────────────────────────

function reviewKey(q) {
  return String(q && q.text ? q.text : '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * collectFromAdapter(adapter, { html, pageUrl, … }) → result | null
 *
 * Pages the vendor endpoint until any stop condition trips:
 *   · parse() said hasMore === false
 *   · a page returned zero rows, or zero rows we hadn't already seen
 *     (a vendor that ignores the page param would otherwise loop forever
 *      re-serving page 1 until the page cap)
 *   · maxReviews / maxPages reached
 *   · HTTP error, rate-limit or unparseable body — keep what we have
 *
 * Returns null when discover() finds nothing (not this adapter's page).
 * Never throws: a review miss must not fail a catalog sync.
 */
async function collectFromAdapter(adapter, {
  html,
  pageUrl,
  maxPages = MAX_PAGES,
  maxReviews = MAX_REVIEWS
} = {}) {
  let ctx;
  try {
    ctx = adapter.discover(html, pageUrl);
  } catch (err) {
    return null;
  }
  if (!ctx) return null;

  const out = {
    platform: adapter.platform,
    reviews: [],
    total: null,
    average: null,
    distribution: null,
    pagesFetched: 0,
    truncated: false,
    stopReason: null
  };
  const seen = new Set();

  for (let page = 0; page < maxPages; page++) {
    let req;
    try {
      req = adapter.request(ctx, page);
    } catch (err) {
      out.stopReason = `request build failed: ${err.message}`;
      break;
    }
    if (!req || !req.url) { out.stopReason = 'no further request'; break; }

    // Robots gate on the VENDOR host. Checked on the first page only —
    // subsequent pages are the same path with a different query, and
    // isAllowedByRobots caches per origin anyway. A vendor that disallows
    // its widget endpoints (Loox does) stops here with nothing fetched.
    if (page === 0) {
      let allowed = true;
      try {
        allowed = await http.isAllowedByRobots(req.url);
      } catch {
        allowed = true;          // unreachable robots.txt → nothing stated
      }
      if (!allowed) {
        console.log(`   · ${LOG}  ${adapter.platform}: robots.txt disallows ${req.url} — skipping adapter`);
        return null;
      }
    }

    const opts = {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      headers: req.headers || {}
    };

    let payload;
    try {
      if (req.as === 'text') {
        const res = await http.fetchText(req.url, opts);
        if (res.rateLimited) { out.stopReason = 'rate limited'; break; }
        if (!res.ok || !res.text) { out.stopReason = `http ${res.status || 'error'}`; break; }
        payload = res.text;
      } else {
        const res = await http.fetchJson(req.url, opts);
        if (res.rateLimited) { out.stopReason = 'rate limited'; break; }
        if (!res.ok || res.json == null) { out.stopReason = `http ${res.status || 'error'}`; break; }
        payload = res.json;
      }
    } catch (err) {
      out.stopReason = `fetch failed: ${err.message}`;
      break;
    }

    let parsed;
    try {
      parsed = adapter.parse(payload, ctx, page);
    } catch (err) {
      out.stopReason = `parse failed: ${err.message}`;
      break;
    }
    if (!parsed) { out.stopReason = 'unparseable page'; break; }

    out.pagesFetched = page + 1;
    if (parsed.total != null && out.total == null) out.total = toInt(parsed.total);
    if (parsed.average != null && out.average == null) out.average = toFloat(parsed.average);
    if (parsed.distribution && !out.distribution) out.distribution = parsed.distribution;
    if (parsed.cursor !== undefined) ctx.cursor = parsed.cursor;

    const rows = Array.isArray(parsed.reviews) ? parsed.reviews : [];
    let added = 0;
    for (const raw of rows) {
      let q;
      try {
        q = adapter.normalize(raw, ctx);
      } catch {
        q = null;
      }
      if (!q || !q.text) continue;
      const key = reviewKey(q);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.reviews.push(q);
      added += 1;
      if (out.reviews.length >= maxReviews) break;
    }

    if (out.reviews.length >= maxReviews) {
      out.truncated = true;
      out.stopReason = 'review cap';
      break;
    }
    if (!rows.length) { out.stopReason = 'empty page'; break; }
    // Vendor ignored our paging param (same rows again) — bail rather than
    // burn the page budget re-reading page 1.
    if (added === 0) { out.stopReason = 'no new reviews'; break; }
    if (parsed.hasMore === false) { out.stopReason = 'vendor says last page'; break; }
    if (parsed.hasMore === undefined && rows.length < (adapter.pageSize || Infinity)) {
      out.stopReason = 'short page';
      break;
    }
    if (page + 1 >= maxPages) {
      out.truncated = true;
      out.stopReason = 'page cap';
    }
  }

  if (!out.reviews.length && out.total == null && out.average == null) return null;
  return out;
}

/**
 * fetchViaAdapters(html, pageUrl, opts?) → result | null
 * Try the detected platform's adapter, then the others, and return the
 * first one that produces data. Adapter order can't hide a better source:
 * the caller (tier 2 in productReviewsScrapeService) merges this with the
 * tier-1 JSON-LD result rather than replacing it.
 */
async function fetchViaAdapters(html, pageUrl, {
  platform = null,
  maxPages = MAX_PAGES,
  maxReviews = MAX_REVIEWS
} = {}) {
  if (!ENABLED) return null;
  for (const adapter of adaptersFor(platform)) {
    const res = await collectFromAdapter(adapter, { html, pageUrl, maxPages, maxReviews });
    if (res) return res;
  }
  return null;
}

module.exports = {
  fetchViaAdapters,
  collectFromAdapter,
  adaptersFor,
  ADAPTERS,
  BY_PLATFORM,
  // shared helpers for adapter modules + their tests
  firstMatch,
  pick,
  pickAny,
  toInt,
  toFloat,
  reviewKey,
  MAX_PAGES,
  MAX_REVIEWS,
  ENABLED
};
