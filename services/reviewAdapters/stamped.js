// Stamped.io — public widget REST endpoint.
//
// VERIFIED LIVE 2026-07-27 against innosupps.com (and pescience.com,
// kingdomkratom.com, lilacst.com, opopop.com). robots.txt disallows only
// /go, so this path is open.
//
// The public key and store id sit together in the loader call, which is why
// discovery is a single regex over `StampedFn.init({ apiKey: 'pubkey-…',
// sId: '114374' })`. The key is prefixed `pubkey-` — that prefix IS the
// vendor's own marker for "safe to expose in a storefront", so we are
// reading a published credential, not a leaked one.
//
// PRODUCT ID MUST BE THE SHOPIFY PRODUCT ID — not the variant id, not a
// Stamped internal review id. A Shopify PDP is full of plausible-looking
// numbers; the analytics blob is the one that works.
//
// page is 1-indexed (page=0 returns an empty data[] with `total` still
// populated, which would look like a valid last page), `take` clamps
// silently at 100, and `total` repeats on every page → clean termination.

'use strict';

const {
  firstMatch, pick, toInt, toFloat, toDate, text, shopifyProductId, shopDomain,
  REVIEW_TEXT_MAX, REVIEW_TITLE_MAX, REVIEW_AUTHOR_MAX
} = require('./helpers');

const PAGE_SIZE = 100;                   // server cap

// apiKey and sId come from the same init call, so grab them as a pair first
// and fall back to standalone patterns for themes that split them.
const INIT_PAIR_RE = /StampedFn\.init\(\s*\{[^}]*?apiKey\s*:\s*["'](pubkey-[A-Za-z0-9]+)["'][^}]*?sId\s*:\s*["']?(\d+)["']?/i;
const API_KEY_RES = [
  /["']?apiKey["']?\s*:\s*["'](pubkey-[A-Za-z0-9]+)["']/i,
  /(pubkey-[A-Za-z0-9]{20,})/
];
const SID_RES = [/["']?sId["']?\s*:\s*["']?(\d{4,})["']?/i];

function discover(html, pageUrl) {
  if (!html || !/stamped/i.test(html)) return null;

  let apiKey = null;
  let storeId = null;
  const pair = html.match(INIT_PAIR_RE);
  if (pair) {
    apiKey = pair[1];
    storeId = pair[2];
  } else {
    apiKey = firstMatch(html, API_KEY_RES);
    storeId = firstMatch(html, SID_RES);
  }
  if (!apiKey) return null;

  const productId = shopifyProductId(html);
  if (!productId) return null;

  // storeUrl accepts either the sId hash or the myshopify domain. sId is
  // already in hand from the same regex match, so prefer it and keep the
  // domain as the fallback.
  const storeUrl = storeId || shopDomain(html, pageUrl);
  if (!storeUrl) return null;

  return { apiKey, storeUrl, productId };
}

function request(ctx, page) {
  const qs = new URLSearchParams({
    productId: String(ctx.productId),
    apiKey: ctx.apiKey,
    storeUrl: String(ctx.storeUrl),
    page: String(page + 1),              // 1-indexed
    take: String(PAGE_SIZE)
  });
  return { url: `https://stamped.io/api/widget/reviews?${qs}`, as: 'json' };
}

function parse(payload) {
  const rows = pick(payload, 'data');
  const total = toInt(pick(payload, 'total'));
  return {
    reviews: Array.isArray(rows) ? rows : [],
    total: total != null ? total : undefined,
    average: toFloat(pick(payload, 'rating'))
  };
}

function normalize(raw) {
  const body = text(raw && raw.reviewMessage, REVIEW_TEXT_MAX);
  if (!body) return null;
  return {
    text: body,
    title: text(raw.reviewTitle, REVIEW_TITLE_MAX),
    author: text(raw.author, REVIEW_AUTHOR_MAX),
    rating: toFloat(raw.reviewRating),
    datePublished: toDate(raw.dateCreated),
    // reviewVerifiedType is a numeric enum; anything non-zero is a verified
    // purchase of some kind.
    verified: toInt(raw.reviewVerifiedType) > 0
  };
}

module.exports = {
  platform: 'stamped',
  pageSize: PAGE_SIZE,
  discover,
  request,
  parse,
  normalize
};
