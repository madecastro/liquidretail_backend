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
//   discover(html, pageUrl) → ctx | null            (may be async)
//       Pull the public identifiers (app key / store id / product id) out
//       of the PDP HTML. null = this adapter cannot serve this page, which
//       is the normal answer for 8 of the 9 adapters on any given page.
//       Async is allowed because some vendors bury the key behind their
//       loader JS — Bazaarvoice's display passkey takes three hops
//       (PDP → deployments/<client>/bv.js → legacyScoutUrl bvapi.js).
//
//   request(ctx, page) → { url, as: 'json' | 'text', headers? }
//       page is ZERO-BASED here; adapters convert to whatever the vendor
//       wants (1-based page, item offset, cursor from state).
//
//   parse(payload, ctx, page) → {
//       reviews: rawReview[],      // vendor-shaped, passed to normalize()
//       total?: number,            // total review count for the product
//       average?: number,          // aggregate rating
//       distribution?: [{stars,count}],
//       hasMore?: boolean,         // omit → driver infers from page fill
//       cursor?: any,              // stashed on ctx for the next request()
//       error?: string             // vendor said no (see BV below) → stop
//   }
//       `error` exists because vendors report failure INSIDE a 200 body:
//       Bazaarvoice answers an over-cap Limit with HTTP 200 and
//       {"Errors":[{"Code":"ERROR_PARAM_INVALID_LIMIT"}],"Results":[]}.
//       Status-code checks alone would read that as an empty last page.
//
//   aggregate(ctx) → { total?, average?, distribution? } | null   (optional,
//       async) — for vendors whose review list carries no aggregate and
//       needs a second call (Junip, Okendo, Fera). Called once, after the
//       first page succeeds, and only when the list didn't supply one.
//
//   normalize(raw, ctx) → { text, title, author, rating, datePublished, verified }
//       Vendor row → engine quote shape. Return null to skip a row.
//
// EVERY request goes through httpScrapeClient so vendor hosts get the same
// per-host throttle, UA rotation, 429/Retry-After handling and byte caps as
// the rest of our crawling. Adapters never call fetch() directly.
//
// ROBOTS POSTURE IS A DEPLOYMENT CHOICE — see REVIEW_RESPECT_ROBOTS below.
// This deployment runs with client authorisation for the storefronts it
// scrapes, so the gate defaults OFF. Set REVIEW_RESPECT_ROBOTS=true to restore
// it. NOTE the asymmetry the flag cannot fix: a client can authorise access to
// THEIR storefront, but api.bazaarvoice.com / loox.io / judge.me are
// third-party infrastructure the client cannot consent on behalf of, so the
// policies below remain the vendors' own position on automated access.
//
// VENDOR ROBOTS POLICIES (checked live 2026-07-27, recorded for the record):
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

// ── rating filter under throttling ─────────────────────────────────
//
// When a vendor host starts rate-limiting us mid-product, the remaining
// request budget is better spent on reviews we can actually use. We surface
// positive quotes, so 1-3 star reviews are fetched, stored, and then never
// chosen — pure waste at exactly the moment requests became scarce.
//
// So on a 429 the driver escalates ONCE to "4 stars and up, server-side" and
// re-asks for the same page, instead of stopping. Only adapters that declare
// supportsMinRating participate, and only Bazaarvoice can do it in a single
// request; asking the others would mean two requests per page (Yotpo's
// star=4 then star=5) or an undocumented param that might 400 — both worse
// than not filtering. Full table + sources: docs/REVIEW_VENDORS.md §10.
//
// This never becomes the default: an unfiltered sweep is what gives an honest
// rating distribution, and the escalation is recorded on the result
// (ratingFiltered) so a consumer knows the tail was not sampled.
const MIN_RATING_ON_THROTTLE = Math.min(5, Math.max(1,
  parseInt(process.env.REVIEW_MIN_RATING_ON_THROTTLE, 10) || 4
));

// Robots posture is system-wide — see httpScrapeClient.respectsRobots(). It is
// off by default because this platform scrapes with client authorisation.
// REVIEW_RESPECT_ROBOTS remains accepted as a reviews-only override.
function respectRobots() {
  return process.env.REVIEW_RESPECT_ROBOTS === 'true' || http.respectsRobots();
}

// ── shared helpers ─────────────────────────────────────────────────
//
// In ./helpers so adapter modules can require them without a cycle back
// through this file (see the note at the top of helpers.js). Re-exported
// below for tests and for callers that already import from here.
const helpers = require('./helpers');
const { firstMatch, pick, pickAny, toInt, toFloat, reviewKey } = helpers;

// ── registry ───────────────────────────────────────────────────────
//
// Order matters only for logging; lookup is by platform slug. Each module
// self-reports the slug so the registry can't drift from the detector.
// No loox adapter: loox.io/robots.txt disallows /widget and /widgets (see
// header). No shopify-legacy adapter: Shopify's own Product Reviews app was
// removed 2023-09-05 and its backend shut down 2024-05-06 —
// productreviews.shopifyapps.com no longer answers TLS at all, and it was
// never a paginated JSON API in the first place (Liquid-rendered metafield
// HTML plus Shopify's generic ?page= param).
const ADAPTER_MODULES = [
  './bazaarvoice',
  './judgeme',
  './yotpo',
  './okendo',
  './stamped',
  './reviewsio',
  './powerreviews',
  './junip',
  './fera'
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
  maxReviews = MAX_REVIEWS,
  minRating = null
} = {}) {
  let ctx;
  try {
    ctx = await adapter.discover(html, pageUrl);
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
    stopReason: null,
    // Non-null → the captured set is 4★+ only and is NOT a representative
    // sample. total/average/distribution are still whole-product (they are
    // only ever read from an unfiltered response).
    ratingFiltered: null
  };
  const seen = new Set();

  // A caller-supplied floor (a host already known to throttle) applies from
  // page 0. The reactive escalation below applies from wherever the 429 hit.
  if (minRating && adapter.supportsMinRating) {
    ctx.minRating = minRating;
    out.ratingFiltered = minRating;
  }
  let escalated = false;

  /**
   * Rate-limited. If this adapter can filter server-side and we are not
   * already filtering, switch on the 4★ floor and let the caller retry the
   * same page — the remaining budget then returns only usable reviews.
   * Returns true when the caller should retry rather than stop.
   */
  function escalateOnThrottle(page) {
    if (escalated || ctx.minRating || !adapter.supportsMinRating) return false;
    escalated = true;
    ctx.minRating = MIN_RATING_ON_THROTTLE;
    out.ratingFiltered = MIN_RATING_ON_THROTTLE;
    console.log(`   · ${LOG}  ${adapter.platform}: rate limited at page ${page + 1} — retrying with ${MIN_RATING_ON_THROTTLE}★+ server-side filter`);
    return true;
  }

  for (let page = 0; page < maxPages; page++) {
    let req;
    try {
      req = adapter.request(ctx, page);
    } catch (err) {
      out.stopReason = `request build failed: ${err.message}`;
      break;
    }
    if (!req || !req.url) { out.stopReason = 'no further request'; break; }

    // Robots gate on the VENDOR host, when the deployment opts into it.
    // Checked on the first page only — later pages are the same path with a
    // different query, and isAllowedByRobots caches per origin anyway.
    if (respectRobots() && page === 0) {
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
    let throttled = false;
    try {
      if (req.as === 'text') {
        const res = await http.fetchText(req.url, opts);
        if (res.rateLimited) throttled = true;
        else if (!res.ok || !res.text) { out.stopReason = `http ${res.status || 'error'}`; break; }
        else payload = res.text;
      } else {
        const res = await http.fetchJson(req.url, opts);
        if (res.rateLimited) throttled = true;
        else if (!res.ok || res.json == null) { out.stopReason = `http ${res.status || 'error'}`; break; }
        else payload = res.json;
      }
    } catch (err) {
      out.stopReason = `fetch failed: ${err.message}`;
      break;
    }
    if (throttled) {
      // page -= 1 then the loop's page++ re-asks for THIS page, now filtered.
      // Guarded by `escalated` so it can happen at most once per product.
      if (escalateOnThrottle(page)) { page -= 1; continue; }
      out.stopReason = 'rate limited';
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
    if (parsed.error) {
      // Vendor rejected the request inside a 200 body (over-cap page size,
      // bad filter). Keep what earlier pages gave us and stop.
      out.stopReason = `vendor error: ${parsed.error}`;
      break;
    }

    out.pagesFetched = page + 1;
    // AGGREGATE ONLY FROM AN UNFILTERED RESPONSE. A 4★+ filtered page may
    // report the count and mean of the filtered slice — Bazaarvoice has a
    // separate FilteredStats concept and the interaction is documented
    // ambiguously. Storing "4.9 from 83 reviews" for a product that really
    // holds 3.8 from 156 would be a worse error than having no rating, so the
    // aggregate is simply never read from a filtered page.
    if (!ctx.minRating) {
      if (parsed.total != null && out.total == null) out.total = toInt(parsed.total);
      if (parsed.average != null && out.average == null) out.average = toFloat(parsed.average);
      if (parsed.distribution && !out.distribution) out.distribution = parsed.distribution;
    }
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
      const key = reviewKey(q.text);
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

  // Second call for vendors that keep the aggregate on a different endpoint.
  if (out.pagesFetched > 0 && typeof adapter.aggregate === 'function' &&
      (out.total == null || out.average == null)) {
    try {
      const agg = await adapter.aggregate(ctx);
      if (agg) {
        if (out.total == null && agg.total != null) out.total = toInt(agg.total);
        if (out.average == null && agg.average != null) out.average = toFloat(agg.average);
        if (!out.distribution && agg.distribution) out.distribution = agg.distribution;
      }
    } catch { /* best-effort — the review rows are what matter */ }
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
  maxReviews = MAX_REVIEWS,
  minRating = null
} = {}) {
  if (!ENABLED) return null;
  for (const adapter of adaptersFor(platform)) {
    const res = await collectFromAdapter(adapter, {
      html, pageUrl, maxPages, maxReviews, minRating
    });
    if (res) return res;
  }
  return null;
}

module.exports = Object.assign({
  fetchViaAdapters,
  collectFromAdapter,
  adaptersFor,
  ADAPTERS,
  BY_PLATFORM,
  MAX_PAGES,
  MAX_REVIEWS,
  MIN_RATING_ON_THROTTLE,
  ENABLED,
  respectRobots
}, helpers);
