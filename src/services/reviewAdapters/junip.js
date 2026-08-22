// Junip (juniphq.com) — the endpoint the free on-site widget itself calls.
//
// VERIFIED LIVE 2026-07-27 against hexclad.com (store key jg6Ctmk2…,
// product 6888697921670, 8278 reviews). Drafted by Grok from the verified
// contract; review-title fallback and caps corrected here.
//
// NOT the API in junip.co/docs — that one (api.juniphq.com/v1/…) is
// Premium-gated and needs an account key. This is apid.juniphq.com/v2,
// authenticated by the same public store key the storefront widget puts in
// its own markup, which is why it works for every merchant regardless of plan.
//
// CURSOR-ONLY PAGING WITH NO TOTALS: this response carries no total and no
// page_count — only meta.after. Stop when it is null/absent or the page came
// back short. The cursor is opaque base64; relay it verbatim, never build one.
//
// PAGE_SIZE OVER 50 IS A HARD 400 (not a silent clamp like most vendors),
// so the size is pinned at the ceiling rather than probed.
//
// PRODUCT-GROUP ROLLUP is the subtle one — see parse().

'use strict';

const {
  firstMatch,
  pick,
  pickAny,
  toInt,
  toFloat,
  toDate,
  text,
  shopifyProductId,
  distributionFromCounts,
  reviewText,
  REVIEW_TITLE_MAX, REVIEW_AUTHOR_MAX
} = require('./helpers');

const PAGE_SIZE = 50;                    // hard server ceiling: 51+ → HTTP 400

const PRESENCE_RES = [
  /widgets\.juniphq\.com\/v1\/junip_shopify\.js/i,
  /class=["'][^"']*junip-/i,
  /junip-store-key/i
];

const STORE_KEY_RES = [
  /class=["'][^"']*junip-store-key[^"']*["'][^>]*data-store-key=["']([^"']+)["']/i,
  /data-store-key=["']([^"']+)["'][^>]*class=["'][^"']*junip-store-key/i,
  /data-store-key=["']([A-Za-z0-9_-]{16,})["']/i
];

const PRODUCT_ID_RES = [
  /class=["'][^"']*junip-product-summary[^"']*["'][^>]*data-product-id=["'](\d+)["']/i,
  /class=["'][^"']*junip-product-review[^"']*["'][^>]*data-product-id=["'](\d+)["']/i,
  /data-product-id=["'](\d+)["'][^>]*class=["'][^"']*junip-product-(?:summary|review)/i
];

// The summary span carries the aggregate for free — harvesting it here is
// what lets aggregate() skip its HTTP call entirely on most stores.
const RATING_COUNT_RES = [/data-product-rating-count=["'](\d+)["']/i];
const RATING_AVG_RES = [/data-product-rating-average=["']([0-9.]+)["']/i];

function discover(html) {
  try {
    if (!html || typeof html !== 'string') return null;
    if (!firstMatch(html, PRESENCE_RES) && !/junip/i.test(html)) return null;

    const storeKey = firstMatch(html, STORE_KEY_RES);
    if (!storeKey) return null;

    const productId = firstMatch(html, PRODUCT_ID_RES) || shopifyProductId(html);
    if (!productId) return null;

    const ctx = { storeKey, productId: String(productId), cursor: null };
    const count = toInt(firstMatch(html, RATING_COUNT_RES));
    const avg = toFloat(firstMatch(html, RATING_AVG_RES));
    if (count != null) ctx.summaryTotal = count;
    if (avg != null) ctx.summaryAverage = avg;
    return ctx;
  } catch {
    return null;
  }
}

function headers(ctx) {
  // The store key is the credential; the myshopify domain only selects the
  // widget bundle and is not interchangeable with it.
  return { 'Junip-Store-Key': ctx.storeKey, Accept: 'application/json' };
}

function request(ctx, page) {
  if (!ctx || !ctx.storeKey || !ctx.productId) return null;
  if (page > 0 && !ctx.cursor) return null;      // no cursor → nothing more to ask for

  const qs = new URLSearchParams({
    page_size: String(PAGE_SIZE),
    sort_field: 'created_at',
    sort_order: 'desc'
  });
  if (page > 0) qs.set('page_after', ctx.cursor);

  return {
    url: `https://apid.juniphq.com/v2/products/remote/${encodeURIComponent(ctx.productId)}` +
         `/reviews?${qs}`,
    as: 'json',
    headers: headers(ctx)
  };
}

function parse(payload, ctx) {
  if (!payload || typeof payload !== 'object') return { reviews: [] };

  const data = Array.isArray(payload.data) ? payload.data : [];
  const after = pick(payload, 'meta.after') || null;

  // PRODUCT-GROUP ROLLUP: Junip pools reviews across a variant/bundle group,
  // so a query for the 12-pc set returned reviews whose product.remote_id was
  // the 6-pc set. We put these quotes on ads for ONE product, so a quote
  // about a different variant is a real accuracy problem. Prefer exact
  // matches; fall back to the group only when nothing matches, and flag it so
  // normalize() can mark the quotes and downstream can decide.
  let rows = data;
  if (ctx.productId && data.length) {
    const pid = String(ctx.productId);
    const exact = data.filter(r => String(pick(r, 'product.remote_id') || '') === pid);
    if (exact.length) {
      rows = exact;
      ctx.familyRollup = false;
    } else {
      ctx.familyRollup = true;
    }
  }

  return {
    reviews: rows,
    // No total/page_count exists here; a short page or a null cursor is the end.
    hasMore: !!after && data.length >= PAGE_SIZE,
    cursor: after,
    total: ctx.summaryTotal != null ? ctx.summaryTotal : undefined,
    average: ctx.summaryAverage != null ? ctx.summaryAverage : undefined
  };
}

function normalize(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;

  const body = reviewText(raw.body);
  if (!body) return null;

  // NOTE: raw.target_title is the PRODUCT name, not a review headline — it
  // must never stand in for the title, or ads would quote a product name.
  const first = text(pick(raw, 'customer.first_name'), 60) || '';
  const last = text(pick(raw, 'customer.last_name'), 60) || '';

  const quote = {
    text: body,
    title: text(raw.title, REVIEW_TITLE_MAX),
    author: text(`${first} ${last}`.trim(), REVIEW_AUTHOR_MAX),
    rating: toFloat(raw.rating),
    datePublished: toDate(raw.created_at),
    verified: !!pickAny(raw, ['verified_buyer', 'identity_confirmed'])
  };
  if (ctx && ctx.familyRollup) quote.familyRollup = true;
  return quote;
}

// Only reached when the PDP had no summary span — one extra request, once.
async function aggregate(ctx) {
  if (!ctx || !ctx.productId || !ctx.storeKey) return null;
  if (ctx.summaryTotal != null || ctx.summaryAverage != null) {
    const out = {};
    if (ctx.summaryTotal != null) out.total = ctx.summaryTotal;
    if (ctx.summaryAverage != null) out.average = ctx.summaryAverage;
    return out;
  }

  try {
    const { fetchJson } = require('../httpScrapeClient');
    const res = await fetchJson(
      `https://apid.juniphq.com/v2/products/remote/${encodeURIComponent(ctx.productId)}`,
      { timeoutMs: 12000, headers: headers(ctx) }
    );
    if (!res || !res.ok || !res.json) return null;

    const data = res.json.data || res.json;
    const out = {};
    const total = toInt(pickAny(data, ['rating_count', 'review_count']));
    const average = toFloat(pickAny(data, ['rating_average', 'average_rating']));
    if (total != null) out.total = total;
    if (average != null) out.average = average;
    const dist = distributionFromCounts(pick(data, 'rating_distribution'), 'asc');
    if (dist) out.distribution = dist;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

module.exports = {
  platform: 'junip',
  pageSize: PAGE_SIZE,
  discover,
  request,
  parse,
  normalize,
  aggregate
};
