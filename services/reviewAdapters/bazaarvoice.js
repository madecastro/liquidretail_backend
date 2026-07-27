// Bazaarvoice — Conversations display API.
//
// VERIFIED LIVE 2026-07-27 against livingspaces.com (product 384812) and
// deathwishcoffee.com (product 263612097, 4726 reviews). api.bazaarvoice.com
// serves no robots.txt (404) — nothing stated. No headers needed; the public
// display passkey is the only credential.
//
// THIS IS THE ADAPTER THAT EARNS THE TIER. Both stores render their review
// CONTENT client-side — deathwishcoffee.com has zero aggregateRating in its
// server HTML — so tier 1 sees nothing at all there. The container div with
// the product id is still server-rendered, which is the thread we pull.
//
// THE PASSKEY TAKES THREE HOPS, hence async discover():
//   1. PDP HTML  → apps.bazaarvoice.com/deployments/<CLIENT>/…/bv.js
//   2. that bv.js → legacyScoutUrl:"…/static/<Client>/…/bvapi.js"
//                   (bv.js itself contains NO passkey — grep confirmed zero
//                    hits on both stores, so stopping at hop 2 finds nothing)
//   3. that bvapi.js → apiconfig:{limit:10,passkey:"<KEY>",baseUrl:"//api…"}
// Hops 2-3 are cached per client for the process lifetime: a 5000-product
// sync resolves the key ONCE instead of 5000 times, which is the difference
// between two extra requests and ten thousand.
//
// A SECOND, UNRELATED passkey lives further down the same bvapi.js under
// notifications:{passkey:"b8d5…"}. It is not the reviews key. The match is
// anchored to the `apiconfig` context for exactly that reason.
//
// AN OVER-CAP Limit RETURNS HTTP 200 WITH AN ERROR BODY — see parse().
//
// FAMILY ROLLUP is the correctness trap — see parse().

'use strict';

const {
  firstMatch, pick, toInt, toFloat, toDate, text
} = require('./helpers');

const PAGE_SIZE = 100;                   // hard server cap on Limit
const API_ROOT = 'https://api.bazaarvoice.com/data/reviews.json';

// Resolved passkeys, keyed by BV client slug. Module-scoped on purpose: the
// key is per-store, not per-product, and re-deriving it per product would
// triple the request count of a catalog sync for zero benefit.
const PASSKEY_CACHE = new Map();

// Hop 1. On Shopify stores the loader URL only appears inside an escaped
// JSON blob (…\/apps.bazaarvoice.com\/deployments\/deathwishcoffee\/…), so
// the separator has to tolerate an optional backslash.
const DEPLOYMENT_RES = [
  /apps\.bazaarvoice\.com\\?\/deployments\\?\/([A-Za-z0-9_-]+)\\?\/main_site/i,
  /apps\.bazaarvoice\.com\\?\/deployments\\?\/([A-Za-z0-9_-]+)/i
];

// Hop 2 → the legacy scout URL, taken verbatim: the client slug's CASING
// differs between hops ("deathwishcoffee" vs "LivingSpaces"), so rebuilding
// this URL from the hop-1 slug produces 404s.
const SCOUT_URL_RES = [
  /legacyScoutUrl\s*:\s*["'](https?:\/\/[^"']+bvapi\.js)["']/i,
  /["'](https?:\/\/display\.ugc\.bazaarvoice\.com\/static\/[^"']+bvapi\.js)["']/i
];

// Hop 3 → the reviews passkey, anchored inside apiconfig{…}.
const PASSKEY_RES = [
  /apiconfig\s*:\s*\{[^}]*?passkey\s*:\s*["']([A-Za-z0-9]+)["']/i
];

// The review container is server-rendered even when its contents are not.
const PRODUCT_ID_RES = [
  /data-bv-show=["']reviews["'][^>]*data-bv-product-id=["']([^"']+)["']/i,
  /data-bv-product-id=["']([^"']+)["'][^>]*data-bv-show=["']reviews["']/i,
  /data-bv-product-id=["']([^"']+)["']/i
];

const PRESENCE_RE = /bazaarvoice|data-bv-|bvapi\.js/i;

async function resolvePasskey(client, html) {
  if (PASSKEY_CACHE.has(client)) return PASSKEY_CACHE.get(client);

  const { fetchText } = require('../httpScrapeClient');
  const opts = { timeoutMs: 10000, maxBytes: 8_000_000 };

  // Some themes inline the scout URL on the PDP itself — try that before
  // spending a request on bv.js.
  let scoutUrl = firstMatch(html, SCOUT_URL_RES);

  if (!scoutUrl) {
    const loaderUrl = `https://apps.bazaarvoice.com/deployments/${client}` +
                      '/main_site/production/en_US/bv.js';
    const loader = await fetchText(loaderUrl, opts);
    if (!loader.ok || !loader.text) {
      PASSKEY_CACHE.set(client, null);   // cache the miss too — don't retry per product
      return null;
    }
    scoutUrl = firstMatch(loader.text, SCOUT_URL_RES);
  }
  if (!scoutUrl) {
    PASSKEY_CACHE.set(client, null);
    return null;
  }

  const scout = await fetchText(scoutUrl, opts);
  const passkey = (scout.ok && scout.text) ? firstMatch(scout.text, PASSKEY_RES) : null;
  PASSKEY_CACHE.set(client, passkey || null);
  return passkey || null;
}

async function discover(html) {
  try {
    if (!html || typeof html !== 'string' || !PRESENCE_RE.test(html)) return null;

    const productId = firstMatch(html, PRODUCT_ID_RES);
    if (!productId) return null;

    const client = firstMatch(html, DEPLOYMENT_RES);
    // Without a client slug we can still succeed if the PDP inlined the
    // scout URL, so only bail when both routes are dead.
    if (!client && !firstMatch(html, SCOUT_URL_RES)) return null;

    const passkey = await resolvePasskey(client || '_inline', html);
    if (!passkey) return null;

    return { passkey, productId: String(productId), familyRollup: false };
  } catch {
    return null;
  }
}

function request(ctx, page) {
  if (!ctx || !ctx.passkey || !ctx.productId) return null;
  const qs = new URLSearchParams({
    apiversion: '5.5',
    passkey: ctx.passkey,
    // Filter is MANDATORY — omitting it returns 200 with TotalResults:0.
    Filter: `ProductId:${ctx.productId}`,
    Limit: String(PAGE_SIZE),
    Offset: String(page * PAGE_SIZE),    // 0-indexed RECORD offset
    Include: 'Products',
    Stats: 'Reviews',
    Sort: 'SubmissionTime:desc'          // deterministic page-to-page ordering
  });
  return { url: `${API_ROOT}?${qs}`, as: 'json' };
}

function parse(payload, ctx, page) {
  if (!payload || typeof payload !== 'object') return { reviews: [] };

  // HTTP 200 + Errors[] is how BV reports a bad request (e.g. Limit > 100:
  // {"Results":[],"Errors":[{"Code":"ERROR_PARAM_INVALID_LIMIT"}]}). Reading
  // status alone would treat that as a legitimate empty last page.
  const errors = Array.isArray(payload.Errors) ? payload.Errors : [];
  if (errors.length) {
    const e = errors[0] || {};
    return { reviews: [], error: String(e.Message || e.Code || 'bazaarvoice error') };
  }

  const all = Array.isArray(payload.Results) ? payload.Results : [];
  const total = toInt(payload.TotalResults);

  // FAMILY ROLLUP: on livingspaces.com, Filter=ProductId:384812 (a 101" sofa)
  // returned reviews whose own ProductId was 384808/384809/384810 — the
  // chair, loveseat and ottoman — with the SAME TotalResults for every
  // sibling, because the retailer has BV pooling reviews across a furniture
  // family (Attributes.BV_FE_FAMILY:"PARKER SOFA"). We put these quotes on an
  // ad for ONE product, so "great ottoman" under a sofa is a real accuracy
  // problem. Prefer rows for the exact product; fall back to the family only
  // when nothing matches, and flag it so the quotes carry that provenance.
  let rows = all;
  if (all.length) {
    const exact = all.filter(r => String(r && r.ProductId || '') === String(ctx.productId));
    if (exact.length) {
      rows = exact;
      ctx.familyRollup = false;
    } else {
      ctx.familyRollup = true;
    }
  }

  // Aggregate rides along because Include=Products&Stats=Reviews was asked
  // for; the Includes map is keyed by product id.
  const stats = pick(payload, `Includes.Products.${ctx.productId}.ReviewStatistics`) || {};
  const dist = Array.isArray(stats.RatingDistribution)
    // Already {RatingValue, Count} objects — not a 5-element count array, so
    // distributionFromCounts would mis-read it.
    ? stats.RatingDistribution
        .map(d => ({ stars: toInt(d && d.RatingValue), count: toInt(d && d.Count) || 0 }))
        .filter(d => d.stars >= 1 && d.stars <= 5)
        .sort((a, b) => b.stars - a.stars)
    : null;

  return {
    reviews: rows,
    total: total != null ? total : toInt(stats.TotalReviewCount),
    average: toFloat(stats.AverageOverallRating),
    distribution: dist && dist.length ? dist : null,
    // Offset is a record offset: we're done once we've walked past the total.
    hasMore: total != null ? ((page + 1) * PAGE_SIZE) < total : undefined
  };
}

function normalize(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const body = text(raw.ReviewText, 400);
  if (!body) return null;                // ratings-only reviews are common on BV
  const quote = {
    text: body,
    title: text(raw.Title, 140),
    author: text(raw.UserNickname, 120),
    rating: toFloat(raw.Rating),
    datePublished: toDate(raw.SubmissionTime),
    verified: !!pick(raw, 'Badges.verifiedPurchaser')
  };
  if (ctx && ctx.familyRollup) quote.familyRollup = true;
  return quote;
}

module.exports = {
  platform: 'bazaarvoice',
  pageSize: PAGE_SIZE,
  discover,
  request,
  parse,
  normalize,
  // Exposed for tests — the cache is process-lifetime and must be clearable.
  _passkeyCache: PASSKEY_CACHE
};
