// PowerReviews — public display API.
//
// VERIFIED LIVE 2026-07-27 against ulta.com (merchant 6406, page_id
// pimprod2054180, 714 reviews). display.powerreviews.com serves no
// robots.txt (404) — nothing stated. No auth headers; the page's own public
// apikey is the only credential. Drafted by Grok from the verified contract,
// completed and made stub-testable here.
//
// A WRONG page_id RETURNS HTTP 200 WITH total_results:0 — it does not error.
// That is why discover() is async: page_id is whatever identifier the
// MERCHANT submitted reviews under (SKU, UPC, internal id, or a PDP slug),
// and on Ulta the SKU (2644401) returned a perfectly valid EMPTY response
// while the PDP slug (pimprod2054180) returned all 714. Guessing wrong would
// silently look like "this product has no reviews", so we probe candidates
// with a size=1 request and keep the first that actually has data.
//
// paging.size ABOVE 25 IS A HARD HTTP 400 (not a silent clamp), so the page
// size is pinned at the ceiling.
//
// DATES ARE EPOCH MILLISECONDS, not ISO strings.
//
// merchant_group_id sits right next to the other two identifiers in the page
// config and is NEVER part of the read URL — only m/{merchant_id}.

'use strict';

const {
  firstMatch,
  pick,
  toInt,
  toFloat,
  toDate,
  text,
  distributionFromCounts
} = require('./helpers');

const PAGE_SIZE = 25;                    // hard server ceiling: 26+ → HTTP 400
const PROBE_LIMIT = 4;                   // bound the page_id fan-out

// Modern React page-state blob (pr* keys) and the classic render() call.
const API_KEY_RES = [
  /"prApiKey"\s*:\s*"([^"]+)"/i,
  /api_key\s*:\s*['"]([^'"]+)['"]/i
];
const MERCHANT_ID_RES = [
  /"prMerchantId"\s*:\s*"?(\d+)"?/i,
  /merchant_id\s*:\s*['"]?(\d+)['"]?/i
];
const LOCALE_RES = [
  /"locale"\s*:\s*"([a-z]{2}[-_][A-Z]{2})"/,
  /page_locale\s*:\s*['"]([^'"]+)['"]/i
];

// page_id candidates, best-first.
const RENDER_PAGE_ID_RES = [
  /POWERREVIEWS\.display\.render\s*\(\s*\{[\s\S]{0,800}?page_id\s*:\s*['"]([^'"]+)['"]/i
];
const JSONLD_PRODUCT_ID_RES = [
  /"productID"\s*:\s*"([^"]+)"/i,
  /"productId"\s*:\s*"([^"]+)"/i
];
const CANONICAL_RES = [
  /rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
  /href=["']([^"']+)["'][^>]*rel=["']canonical["']/i
];
const JSONLD_SKU_RES = [/"sku"\s*:\s*"([^"]+)"/i];

const PRESENCE_RE = /ui\.powerreviews\.com|powerreviews|pr-snippet/i;

// The endpoint wants en_US; pages carry en-US.
function localeUnderscore(locale) {
  return locale ? String(locale).replace(/-/g, '_') : 'en_US';
}

function reviewsUrl({ merchantId, locale, pageId, apiKey, from, size }) {
  const loc = localeUnderscore(locale);
  const qs = new URLSearchParams({
    apikey: apiKey,
    _noconfig: 'true',
    page_locale: loc,
    'paging.from': String(from),
    'paging.size': String(size)
  });
  return `https://display.powerreviews.com/m/${encodeURIComponent(merchantId)}` +
         `/l/${encodeURIComponent(loc)}/product/${encodeURIComponent(pageId)}/reviews?${qs}`;
}

// Trailing hyphen-token of the canonical path basename: …-pimprod2054180.
function canonicalPageId(html) {
  const href = firstMatch(html, CANONICAL_RES);
  if (!href) return null;
  const base = String(href).split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  if (!base) return null;
  const parts = base.split('-');
  return parts[parts.length - 1] || null;
}

function collectCandidates(html) {
  const out = [];
  const seen = new Set();
  const add = (id) => {
    if (id == null) return;
    const s = String(id).trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  add(firstMatch(html, RENDER_PAGE_ID_RES));
  add(firstMatch(html, JSONLD_PRODUCT_ID_RES));
  add(canonicalPageId(html));
  add(firstMatch(html, JSONLD_SKU_RES));
  return out.slice(0, PROBE_LIMIT);
}

async function discover(html) {
  try {
    if (!html || typeof html !== 'string' || !PRESENCE_RE.test(html)) return null;

    const apiKey = firstMatch(html, API_KEY_RES);
    const merchantId = firstMatch(html, MERCHANT_ID_RES);
    if (!apiKey || !merchantId) return null;

    const locale = localeUnderscore(firstMatch(html, LOCALE_RES));
    // Lazily required so tests can stub the module's fetchJson.
    const { fetchJson } = require('../httpScrapeClient');

    for (const pageId of collectCandidates(html)) {
      const url = reviewsUrl({ merchantId, locale, pageId, apiKey, from: 0, size: 1 });
      try {
        const res = await fetchJson(url, { timeoutMs: 10000 });
        if (!res || !res.ok || !res.json) continue;
        const total = toInt(pick(res.json, 'paging.total_results'));
        if (total != null && total > 0) {
          return { apiKey, merchantId, locale, pageId };
        }
      } catch {
        // Probe failure is non-fatal — try the next candidate.
      }
    }
    return null;
  } catch {
    return null;
  }
}

function request(ctx, page) {
  if (!ctx || !ctx.apiKey || !ctx.merchantId || !ctx.pageId) return null;
  return {
    url: reviewsUrl({
      merchantId: ctx.merchantId,
      locale: ctx.locale,
      pageId: ctx.pageId,
      apiKey: ctx.apiKey,
      from: page * PAGE_SIZE,            // 0-indexed RECORD offset, not a page number
      size: PAGE_SIZE
    }),
    as: 'json'
  };
}

function parse(payload, ctx, page) {
  if (payload == null || typeof payload !== 'object') return { reviews: [] };

  // Vendor failure inside a 200 body (over-cap paging.size, bad params).
  const status = toInt(payload.status_code != null ? payload.status_code : payload.statusCode);
  if (status != null && status >= 400) {
    return { reviews: [], error: String(payload.message || payload.error || `status ${status}`) };
  }

  const result = Array.isArray(payload.results) ? payload.results[0] : null;
  const rows = result && Array.isArray(result.reviews) ? result.reviews : [];
  const rollup = (result && result.rollup) || {};

  const total = toInt(
    rollup.review_count != null ? rollup.review_count : pick(payload, 'paging.total_results')
  );
  const pagesTotal = toInt(pick(payload, 'paging.pages_total'));

  return {
    reviews: rows,
    total: total != null ? total : undefined,
    average: toFloat(rollup.average_rating),
    // rating_histogram is ASCENDING (index 0 = 1-star) — verified
    // [26,20,44,122,502] summing to the 714 total.
    distribution: distributionFromCounts(rollup.rating_histogram, 'asc'),
    // pages_total is the reliable signal; an out-of-range offset just
    // returns an empty array with no error.
    hasMore: pagesTotal != null ? (page + 1) < pagesTotal : undefined
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const body = text(pick(raw, 'details.comments'), 400);
  if (!body) return null;
  return {
    text: body,
    title: text(pick(raw, 'details.headline'), 140),
    author: text(pick(raw, 'details.nickname'), 120),
    rating: toFloat(pick(raw, 'metrics.rating')),
    // Epoch MILLISECONDS — toDate handles both, but this is why it must.
    datePublished: toDate(pick(raw, 'details.created_date')),
    verified: !!pick(raw, 'badges.is_verified_buyer')
  };
}

module.exports = {
  platform: 'powerreviews',
  pageSize: PAGE_SIZE,
  discover,
  request,
  parse,
  normalize
};
