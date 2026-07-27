// REVIEWS.io — public product-reviews endpoint.
//
// VERIFIED LIVE 2026-07-27 against boxraw.com (store 'boxraw',
// sku BXRW-GSB-B-OS, 68 reviews). api.reviews.io/robots.txt is an empty
// Disallow — allow all.
//
// ⚠ THIS ENDPOINT IS 0-INDEXED. /product/reviews?page=0 is the FIRST page,
// proven on a 68-review product: page=0 and page=1 returned 34 rows each
// with zero overlapping ids. Starting a loop at page=1 silently skips the
// first 34 reviews and then reads one page past the end (which returns 200
// + empty array, so the bug never surfaces as an error). The driver hands
// adapters a zero-based page, so here it passes straight through — that
// coincidence is load-bearing, hence this comment.
//
// `current_page` in the response is NOT authoritative — it echoes back
// whatever you sent. Termination uses total_pages / array length.
//
// The SKU is the first segment of the rating-snippet's semicolon-delimited
// data-sku (merchant SKU;variant id;product id;handle).

'use strict';

const {
 firstMatch, pick, toInt, toFloat, toDate, text,
  REVIEW_TEXT_MAX, REVIEW_TITLE_MAX, REVIEW_AUTHOR_MAX
} = require('./helpers');

const PAGE_SIZE = 50;

const STORE_RES = [
  /var\s+reviewsIoStore\s*=\s*["']([A-Za-z0-9_-]+)["']/i,
  /["']?store["']?\s*:\s*["']([A-Za-z0-9_-]+)["'][^}]{0,120}reviews\.io/i,
  /reviews\.io[^"']{0,80}[?&]store=([A-Za-z0-9_-]+)/i
];

const SKU_RES = [
  /class=["'][^"']*ruk_rating_snippet[^"']*["'][^>]*data-sku=["']([^"';]+)/i,
  /data-sku=["']([^"';]+)[^"']*["'][^>]*class=["'][^"']*ruk_rating_snippet/i
];

// JSON-LD sku corroborates the same value on the pages tested; used only
// when the snippet div is absent.
const LD_SKU_RES = [/"sku"\s*:\s*"([^"]+)"/i];

function discover(html) {
  if (!html || !/reviews\.io|reviewsio|ruk_rating_snippet/i.test(html)) return null;
  const store = firstMatch(html, STORE_RES);
  if (!store) return null;
  const sku = firstMatch(html, SKU_RES) || firstMatch(html, LD_SKU_RES);
  if (!sku) return null;
  return { store, sku };
}

function request(ctx, page) {
  const qs = new URLSearchParams({
    store: ctx.store,
    sku: ctx.sku,
    page: String(page),                  // 0-INDEXED — see header
    per_page: String(PAGE_SIZE)
  });
  return { url: `https://api.reviews.io/product/reviews?${qs}`, as: 'json' };
}

function parse(payload, ctx, page) {
  const rows = pick(payload, 'reviews');
  const totalPages = toInt(pick(payload, 'total_pages'));
  const list = Array.isArray(rows) ? rows : [];
  return {
    reviews: list,
    total: toInt(pick(payload, 'count')),
    average: toFloat(pick(payload, 'rating')),
    // 0-indexed: the last page index is total_pages - 1.
    hasMore: totalPages != null ? (page + 1) < totalPages : undefined
  };
}

function normalize(raw) {
  const body = text(raw && raw.review, REVIEW_TEXT_MAX);
  if (!body) return null;
  const first = raw.reviewer && raw.reviewer.first_name;
  const last = raw.reviewer && raw.reviewer.last_name;
  const author = [first, last].filter(Boolean).join(' ').trim();
  return {
    text: body,
    title: text(raw.title, REVIEW_TITLE_MAX),
    author: text(author, REVIEW_AUTHOR_MAX),
    rating: toFloat(raw.rating),
    datePublished: toDate(raw.date_created),
    verified: !!(raw.reviewer && raw.reviewer.verified_buyer)
  };
}

module.exports = {
  platform: 'reviews.io',
  pageSize: PAGE_SIZE,
  discover,
  request,
  parse,
  normalize
};
