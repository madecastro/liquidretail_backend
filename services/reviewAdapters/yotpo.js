// Yotpo — public widget CDN.
//
// VERIFIED LIVE 2026-07-27 against soldejaneiro.com (app key from the
// widget loader, product 538465337388). api-cdn.yotpo.com/robots.txt
// disallows / but explicitly ALLOWS /v1/widget/* — this exact path.
//
// TWO APP KEYS CAN SIT ON ONE PAGE. Stores running Yotpo Loyalty as well
// as Reviews expose a second key from cdn-loyalty.yotpo.com; using it
// returns nothing. The key is only taken from a Reviews loader
// (cdn-widgetsrepository.yotpo.com/v1/loader/<KEY> or
// staticw2.yotpo.com/<KEY>/widget.js), never from a loyalty host.
//
// per_page IS SILENTLY CLAMPED AT 150 and the response reports the CLAMPED
// value back in response.pagination.per_page — so page-count maths must
// read the effective size from the response, not from what we asked for.
// The driver's "no new reviews" rule covers us if a vendor ever clamps
// harder than documented.
//
// Also verified: api.yotpo.com/v1/apps/<key>/reviews (the "newer" shape)
// returns 401 — it needs a private key+secret. The widget path is the
// public one.

'use strict';

const {
  firstMatch, pick, pickAny, toInt, toFloat, toDate, text, distributionFromCounts, shopifyProductId
} = require('./helpers');

const PAGE_SIZE = 100;                  // under the 150 clamp, fewer huge payloads

// Reviews app key. Loyalty hosts are deliberately absent from these patterns.
const APP_KEY_RES = [
  /cdn-widgetsrepository\.yotpo\.com\/v1\/loader\/([A-Za-z0-9_-]{15,})/i,
  /staticw2\.yotpo\.com\/([A-Za-z0-9_-]{15,})\/widget\.js/i,
  /["'](?:appKey|app_key)["']\s*:\s*["']([A-Za-z0-9_-]{15,})["']/
];

const PRODUCT_ID_RES = [
  /data-yotpo-product-id=["'](\d{4,})["']/i,
  /data-product-id=["'](\d{6,})["'][^>]*class=["'][^"']*yotpo/i
];

function discover(html) {
  if (!html || !/yotpo/i.test(html)) return null;
  const appKey = firstMatch(html, APP_KEY_RES);
  if (!appKey) return null;
  const productId = firstMatch(html, PRODUCT_ID_RES) || shopifyProductId(html);
  if (!productId) return null;
  return { appKey, productId };
}

function request(ctx, page) {
  const qs = new URLSearchParams({
    page: String(page + 1),             // 1-indexed; page=0 is clamped to 1
    per_page: String(PAGE_SIZE)
  });
  return {
    url: `https://api-cdn.yotpo.com/v1/widget/${encodeURIComponent(ctx.appKey)}` +
         `/products/${encodeURIComponent(ctx.productId)}/reviews.json?${qs}`,
    as: 'json'
  };
}

function parse(payload) {
  const reviews = pick(payload, 'response.reviews');
  const total = toInt(pick(payload, 'response.pagination.total'));
  // Effective page size as the SERVER applied it (clamped), not as requested.
  const effective = toInt(pick(payload, 'response.pagination.per_page')) || PAGE_SIZE;
  const rows = Array.isArray(reviews) ? reviews : [];
  return {
    reviews: rows,
    total: total != null ? total : undefined,
    average: toFloat(pick(payload, 'response.bottomline.average_score')),
    distribution: distributionFromCounts(pick(payload, 'response.bottomline.star_distribution')),
    hasMore: total != null ? undefined : (rows.length >= effective ? undefined : false)
  };
}

function normalize(raw) {
  const body = text(raw && raw.content, 400);
  if (!body) return null;
  return {
    text: body,
    title: text(raw.title, 140),
    author: text(pickAny(raw, ['user.display_name', 'user.name', 'name']), 120),
    rating: toFloat(raw.score),
    datePublished: toDate(raw.created_at),
    verified: !!raw.verified_buyer
  };
}

module.exports = {
  platform: 'yotpo',
  pageSize: PAGE_SIZE,
  discover,
  request,
  parse,
  normalize
};
