// Okendo — public store reviews API.
//
// VERIFIED LIVE 2026-07-27 (subscriber 6a5493fe-…, product
// shopify-8859021475989). api.okendo.io serves no robots.txt (403), so
// nothing is stated.
//
// CURSOR PAGINATION, NOT PAGES. The response carries `nextUrl` — a relative
// path+query holding a DynamoDB LastEvaluatedKey blob. It must be replayed
// VERBATIM against https://api.okendo.io/v1; hand-building `lastEvaluated`
// from local state does not work. Last page = `nextUrl` simply absent.
//
// productId MUST be `shopify-<numericId>` — the bare number 404s. Stores
// render it that way in data-oke-reviews-product-id, so it is used as-is
// and only synthesised from the analytics blob as a fallback.
//
// The docs say limit maxes at 25; the real ceiling is 100 (empirically).
// Trusting the docs here would triple the request count.

'use strict';

const {
  firstMatch, pick, pickAny, toInt, toFloat, toDate, text, distributionFromCounts, shopifyProductId
} = require('./helpers');

const PAGE_SIZE = 100;                  // real ceiling, not the documented 25
const API_ROOT = 'https://api.okendo.io/v1';

const SUBSCRIBER_RES = [
  /["']subscriberId["']\s*:\s*["']([0-9a-f-]{32,36})["']/i,
  /<meta[^>]+name=["']oke:subscriber_id["'][^>]+content=["']([0-9a-f-]{32,36})["']/i,
  /data-oke-subscriber-id=["']([0-9a-f-]{32,36})["']/i,
  /api\.okendo\.io\/v1\/stores\/([0-9a-f-]{32,36})\//i
];

const PRODUCT_ID_RES = [
  /data-oke-reviews-product-id=["'](shopify-\d+)["']/i,
  /data-oke-product-id=["'](shopify-\d+)["']/i,
  /["']productId["']\s*:\s*["'](shopify-\d+)["']/i
];

function discover(html) {
  if (!html || !/okendo|oke-|data-oke/i.test(html)) return null;
  const subscriberId = firstMatch(html, SUBSCRIBER_RES);
  if (!subscriberId) return null;

  let productId = firstMatch(html, PRODUCT_ID_RES);
  if (!productId) {
    const numeric = shopifyProductId(html);
    if (!numeric) return null;
    productId = `shopify-${numeric}`;   // the prefix is mandatory
  }
  return { subscriberId, productId, cursor: null };
}

function request(ctx, page) {
  // Page 0 starts fresh; every later page replays the server's own nextUrl.
  if (page === 0) {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
    return {
      url: `${API_ROOT}/stores/${encodeURIComponent(ctx.subscriberId)}` +
           `/products/${encodeURIComponent(ctx.productId)}/reviews?${qs}`,
      as: 'json',
      headers: { Accept: 'application/json' }
    };
  }
  if (!ctx.cursor) return null;          // no nextUrl → driver stops
  const rel = String(ctx.cursor).startsWith('/') ? ctx.cursor : `/${ctx.cursor}`;
  return { url: `${API_ROOT}${rel}`, as: 'json', headers: { Accept: 'application/json' } };
}

function parse(payload) {
  const rows = pick(payload, 'reviews');
  const list = Array.isArray(rows) ? rows : [];
  const nextUrl = pick(payload, 'nextUrl');

  // reviewAggregate is on the review-list response for most stores; when it
  // is missing the driver's aggregate() hook fills it in.
  const total = toInt(pickAny(payload, ['reviewAggregate.reviewCount', 'reviewCount']));
  const sum = toFloat(pick(payload, 'reviewRatingValuesTotal'));
  const average = (sum != null && total) ? Math.round((sum / total) * 100) / 100 : undefined;

  const byLevel = pick(payload, 'reviewAggregate.reviewCountByLevel');
  let distribution = null;
  if (byLevel && typeof byLevel === 'object') {
    const counts = {};
    for (let s = 1; s <= 5; s++) counts[s] = toInt(byLevel[`level${s}Count`]) || 0;
    distribution = distributionFromCounts(counts);
  }

  return {
    reviews: list,
    total: total != null ? total : undefined,
    average,
    distribution,
    cursor: nextUrl || null,
    hasMore: !!nextUrl                   // authoritative: key absent = done
  };
}

// Aggregate lives on a separate endpoint when the list response omits it.
async function aggregate(ctx) {
  const http = require('../httpScrapeClient');
  const url = `${API_ROOT}/stores/${encodeURIComponent(ctx.subscriberId)}` +
              `/products/${encodeURIComponent(ctx.productId)}/reviews/summary`;
  const res = await http.fetchJson(url, { timeoutMs: 10000, headers: { Accept: 'application/json' } });
  if (!res.ok || !res.json) return null;
  const total = toInt(pickAny(res.json, ['reviewAggregate.reviewCount', 'reviewCount']));
  const average = toFloat(pickAny(res.json, ['reviewAggregate.averageRating', 'averageRating']));
  return { total, average };
}

function normalize(raw) {
  const body = text(raw && raw.body, 400);
  if (!body) return null;
  return {
    text: body,
    title: text(raw.title, 140),
    author: text(pickAny(raw, ['reviewer.displayName', 'reviewer.name']), 120),
    rating: toFloat(raw.rating),
    datePublished: toDate(raw.dateCreated),
    verified: !!pick(raw, 'reviewer.isVerified')
  };
}

module.exports = {
  platform: 'okendo',
  pageSize: PAGE_SIZE,
  discover,
  request,
  parse,
  normalize,
  aggregate
};
