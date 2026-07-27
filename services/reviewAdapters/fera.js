// Fera (fera.ai) — public product reviews API.
//
// VERIFIED LIVE 2026-07-27 against thevintagesecret.com.au (product
// 7961280610487). Drafted by Grok from the verified contract, caps and
// naming aligned to this repo.
//
// TWO API SURFACES THAT LOOK ALIKE: developers.fera.ai documents a PRIVATE
// admin API (api.fera.ai/v3/private, header SECRET-KEY, "never expose to
// shoppers"). We use only the PUBLIC surface, authenticated by the pk_ key
// that Fera prints into every visitor's HTML by design. Never reach for the
// private shape here.
//
// PAGE_SIZE IS SILENTLY CLAMPED AT 100 — 150 and 250 both come back with
// meta.page_size echoing 100 rather than erroring, so paging maths must
// trust meta.page_count, not the size we asked for.
//
// THE LIST RESPONSE'S TOP-LEVEL `product` KEY CAME BACK NULL in testing —
// it is not a source of totals or ids, hence the separate rating.json call
// in aggregate() for average/distribution.

'use strict';

const {
  firstMatch,
  pick,
  toInt,
  toFloat,
  toDate,
  text,
  shopifyProductId,
  distributionFromCounts,
  REVIEW_TEXT_MAX, REVIEW_TITLE_MAX, REVIEW_AUTHOR_MAX
} = require('./helpers');

const PAGE_SIZE = 100;                   // server ceiling; above it clamps silently

// From the Shopify app-embed block: `const fkey = "pk_…"`.
const FKEY_RES = [
  /const\s+fkey\s*=\s*["'](pk_[a-f0-9]+)["']/,
  /api_key\s*[:=]\s*["'](pk_[a-f0-9]+)["']/,
  /["']api_key["']\s*:\s*["'](pk_[a-f0-9]+)["']/
];

const FDOMAIN_RES = [/const\s+fdomain\s*=\s*["']([^"']+)["']/];

const PRODUCT_ID_RES = [
  /window\.fera\.push\(\s*\{\s*action\s*:\s*["']setProductId["']\s*,\s*product_id\s*:\s*["'](\d+)["']/,
  /["']?setProductId["']?[^}]{0,80}product_id\s*:\s*["'](\d+)["']/
];

const PRESENCE_RE = /cdn\.fera\.ai|window\.fera/i;

function discover(html, pageUrl) {
  try {
    if (!html || typeof html !== 'string') return null;
    if (!PRESENCE_RE.test(html) && !firstMatch(html, FKEY_RES)) return null;

    const apiKey = firstMatch(html, FKEY_RES);
    if (!apiKey) return null;

    const productId = firstMatch(html, PRODUCT_ID_RES) || shopifyProductId(html);
    if (!productId) return null;

    return {
      apiKey,
      productId: String(productId),
      shopDomain: firstMatch(html, FDOMAIN_RES) || null
    };
  } catch {
    return null;
  }
}

function request(ctx, page) {
  const qs = new URLSearchParams({
    api_key: ctx.apiKey,
    page: String(page + 1),              // driver is 0-based, Fera is 1-indexed
    page_size: String(PAGE_SIZE)
  });
  // cdn.fera.ai is Fera's own edge cache of the same public API — byte
  // identical in testing and politer to hit repeatedly than api.fera.ai.
  return {
    url: `https://cdn.fera.ai/api/v3/public/products/${encodeURIComponent(ctx.productId)}` +
         `/reviews.json?${qs}`,
    as: 'json'
  };
}

function parse(payload, ctx, page) {
  const out = { reviews: [] };
  if (!payload || typeof payload !== 'object') return out;

  out.reviews = Array.isArray(payload.data) ? payload.data : [];

  const meta = payload.meta || {};
  const total = toInt(meta.total_count);
  if (total != null) out.total = total;

  // meta.page_count is authoritative — the clamp makes our requested size
  // an unreliable basis for computing the last page.
  const pageNum = toInt(meta.page);
  const pageCount = toInt(meta.page_count);
  if (pageNum != null && pageCount != null) {
    out.hasMore = pageNum < pageCount;
  } else if (total != null) {
    out.hasMore = (page + 1) * PAGE_SIZE < total;
  }

  return out;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const body = text(raw.body, REVIEW_TEXT_MAX);
  if (!body) return null;
  return {
    text: body,
    title: text(raw.heading, REVIEW_TITLE_MAX),
    // display_name is literally 'Anonymous' when the reviewer opted out.
    author: text(pick(raw, 'customer.display_name'), REVIEW_AUTHOR_MAX),
    rating: toFloat(raw.rating),
    datePublished: toDate(raw.created_at),
    verified: raw.is_verified === true
  };
}

// Average + distribution only — the list response already carries the total.
async function aggregate(ctx) {
  try {
    if (!ctx || !ctx.productId || !ctx.apiKey) return null;
    const { fetchJson } = require('../httpScrapeClient');
    const url = `https://cdn.fera.ai/api/v3/public/products/${encodeURIComponent(ctx.productId)}` +
                `/rating.json?api_key=${encodeURIComponent(ctx.apiKey)}`;
    const res = await fetchJson(url, { timeoutMs: 12000 });
    if (!res || !res.ok || !res.json) return null;

    const out = {};
    const average = toFloat(res.json.average);
    const total = toInt(res.json.count);
    if (total != null) out.total = total;
    if (average != null) out.average = average;
    // counts is a 5-element ASCENDING array (index 0 = 1-star).
    const dist = distributionFromCounts(res.json.counts, 'asc');
    if (dist) out.distribution = dist;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

module.exports = {
  platform: 'fera',
  pageSize: PAGE_SIZE,
  discover,
  request,
  parse,
  normalize,
  aggregate
};
