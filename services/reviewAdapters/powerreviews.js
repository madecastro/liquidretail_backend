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
const PROBE_LIMIT = 8;                   // bound the page_id fan-out (literals + derived)

// Three integration shapes seen in the wild, and the key names differ in all
// three — this is the part that breaks when a new retailer shows up:
//   Ulta (React page-state):  "prApiKey" / "prMerchantId"
//   Gap  (RSC flight payload): powerReviewsConfig:{groupId,merchantId,apiKey}
//   classic:                   POWERREVIEWS.display.render({api_key, merchant_id})
//
// The Gap patterns are SCOPED to the powerReviewsConfig object on purpose: a
// bare /"apiKey"/ matches an unrelated key elsewhere on their PDP (a 20-char
// token for another service), which would send a valid-looking but wrong key.
// `\\?"` tolerates the escaped quotes of a flight payload.
const API_KEY_RES = [
  /"prApiKey"\s*:\s*"([^"]+)"/i,
  /powerReviewsConfig\\?"?\s*:\s*\{[^{}]{0,300}?\\?"apiKey\\?"\s*:\s*\\?"([0-9a-fA-F-]{20,})/i,
  /api_key\s*:\s*['"]([^'"]+)['"]/i
];
const MERCHANT_ID_RES = [
  /"prMerchantId"\s*:\s*"?(\d+)"?/i,
  /powerReviewsConfig\\?"?\s*:\s*\{[^{}]{0,300}?\\?"merchantId\\?"\s*:\s*\\?"?(\d+)/i,
  /merchant_id\s*:\s*['"]?(\d+)['"]?/i
];
const LOCALE_RES = [
  /"locale"\s*:\s*"([a-z]{2}[-_][A-Z]{2})"/,
  /\\?"locale\\?"\s*:\s*\\?"([a-z]{2}[-_][A-Z]{2})\\?"/,
  /page_locale\s*:\s*['"]([^'"]+)['"]/i
];

// page_id candidates, best-first.
const RENDER_PAGE_ID_RES = [
  /POWERREVIEWS\.display\.render\s*\(\s*\{[\s\S]{0,800}?page_id\s*:\s*['"]([^'"]+)['"]/i
];
// Escaped variants included: on RSC stores the JSON-LD lives inside the flight
// payload, so its quotes arrive backslashed.
const JSONLD_PRODUCT_ID_RES = [
  /"productID"\s*:\s*"([^"]+)"/i,
  /"productId"\s*:\s*"([^"]+)"/i,
  /\\+"productID\\+"\s*:\s*\\+"([^"\\]+)/i
];
const CANONICAL_RES = [
  /rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
  /href=["']([^"']+)["'][^>]*rel=["']canonical["']/i
];
const JSONLD_SKU_RES = [
  /"sku"\s*:\s*"([^"]+)"/i,
  /\\+"sku\\+"\s*:\s*\\+"([^"\\]+)/i
];
// Retailer-specific product param, last resort: Gap keys its PDPs on ?pid=,
// and the submitted page_id is sometimes that id rather than the SKU.
const URL_PID_RES = [/[?&]pid=(\d+)/i];

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

// ── page_id inference ──────────────────────────────────────────────
//
// The identifiers on a PDP are often a VARIANT id while reviews are submitted
// against the STYLE. gap.com is the case that forced this: the PDP is
// ?pid=130046042 with sku 1300460420010, and PowerReviews holds all 2741
// reviews under page_id `130046` — the pid minus its 3-digit colour suffix.
// Every id literally present on the page returns 200 with total_results:0, so
// without derived candidates a 2741-review product looks review-less.
//
// So each literal id also yields trimmed prefixes. Trims are small (1-4
// trailing chars) and never go below MIN_DERIVED_LEN, which keeps the probe
// from walking into short ids that would collide with unrelated products.
const MAX_TRIM = 4;
const MIN_DERIVED_LEN = 5;

// Learned per store, PERSISTED: once a (source, trim) combination wins for a
// host, every other product on that host tries it FIRST — and the knowledge
// survives worker restarts and DB resets via
// services/reviewSiteProfileService (memory → ReviewSiteProfile collection →
// checked-in reviewSiteProfiles.json). On Gap's 9143-product catalog that is
// ~9k probes instead of ~45k. Verified: product 1 took 5 probes, product 2 took 1.
const profiles = require('../reviewSiteProfileService');

function candidateList(html, pageUrl) {
  const raw = [
    { source: 'render', id: firstMatch(html, RENDER_PAGE_ID_RES) },
    { source: 'productID', id: firstMatch(html, JSONLD_PRODUCT_ID_RES) },
    { source: 'canonical', id: canonicalPageId(html) },
    { source: 'sku', id: firstMatch(html, JSONLD_SKU_RES) },
    { source: 'urlPid', id: firstMatch(pageUrl || '', URL_PID_RES) }
  ].filter(c => c.id != null && String(c.id).trim());

  const out = [];
  const seen = new Set();
  const add = (source, id, trim) => {
    const s = String(id).trim();
    if (!s || s.length < MIN_DERIVED_LEN) return;
    // Skip file-like values: Gap's canonical path ends in "product.do", which
    // is a page name, never a page_id, and would waste a probe.
    if (/\.[a-z]{2,4}$/i.test(s)) return;
    const key = `${s}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, id: s, trim });
  };

  for (const c of raw) add(c.source, c.id, 0);
  // Derived: trim trailing chars off numeric-ish ids (variant → style).
  for (const c of raw) {
    const s = String(c.id).trim();
    if (!/^\d+$/.test(s)) continue;
    for (let t = 1; t <= MAX_TRIM; t++) {
      if (s.length - t < MIN_DERIVED_LEN) break;
      add(c.source, s.slice(0, s.length - t), t);
    }
  }

  // Put the transform this store already taught us at the front. Sync read:
  // candidateList stays pure, and discover() has already warmed the cache.
  const learned = profiles.getProfileSync(pageUrl);
  if (learned && learned.idSource) {
    const trim = learned.idTrim || 0;
    out.sort((a, b) => {
      const score = (x) => (x.source === learned.idSource && x.trim === trim ? 0 : 1);
      return score(a) - score(b);
    });
    // The remembered transform may derive an id no literal on THIS page
    // produced (a differently-shaped pid), so synthesise it when missing.
    if (!out.some(c => c.source === learned.idSource && c.trim === trim)) {
      const base = raw.find(c => c.source === learned.idSource);
      if (base) {
        const s = String(base.id).trim();
        if (trim > 0 && s.length - trim >= MIN_DERIVED_LEN) {
          out.unshift({ source: learned.idSource, id: s.slice(0, s.length - trim), trim });
        }
      }
    }
  }
  return out.slice(0, PROBE_LIMIT);
}

async function discover(html, pageUrl) {
  try {
    if (!html || typeof html !== 'string' || !PRESENCE_RE.test(html)) return null;

    const apiKey = firstMatch(html, API_KEY_RES);
    const merchantId = firstMatch(html, MERCHANT_ID_RES);
    if (!apiKey || !merchantId) return null;

    const locale = localeUnderscore(firstMatch(html, LOCALE_RES));
    // Warm the profile cache so candidateList's sync read sees it.
    await profiles.getProfile(pageUrl);
    // Lazily required so tests can stub the module's fetchJson.
    const { fetchJson } = require('../httpScrapeClient');

    for (const cand of candidateList(html, pageUrl)) {
      const url = reviewsUrl({
        merchantId, locale, pageId: cand.id, apiKey, from: 0, size: 1
      });
      try {
        const res = await fetchJson(url, { timeoutMs: 10000 });
        // A wrong MERCHANT answers 401 ("api key is invalid for this
        // merchant"); a wrong page_id answers 200 with total_results:0. Only
        // the latter is worth continuing past.
        if (!res || !res.ok || !res.json) continue;
        const total = toInt(pick(res.json, 'paging.total_results'));
        if (total != null && total > 0) {
          // Fire-and-forget: a slow profile write must not delay the sync.
          profiles.learn(pageUrl, {
            platform: 'powerreviews',
            idSource: cand.source,
            idTrim: cand.trim,
            reviewsSeen: total,
            learnedFrom: pageUrl || null
          }).catch(() => {});
          return { apiKey, merchantId, locale, pageId: cand.id };
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
  normalize,
  // exposed for tests
  candidateList
};
