#!/usr/bin/env node
//
// Unit checks for services/reviewAdapters — the paginated tier-2 driver and
// the per-vendor adapters' pure discovery/parse logic.
//
// The driver is exercised against FAKE adapters with the HTTP layer stubbed
// (httpScrapeClient's fetchJson/fetchText are swapped on the module object),
// so pagination, caps, dedupe and stop conditions are tested deterministically
// with no network. Real vendor payload fixtures cover the adapters themselves.
//
// Usage:
//   node scripts/testReviewAdapters.js

'use strict';

const assert = require('node:assert/strict');

// Stub the HTTP layer BEFORE the driver is required — the driver holds the
// module object and calls through it, so property swaps take effect.
const http = require('../services/httpScrapeClient');
const realFetchJson = http.fetchJson;
const realFetchText = http.fetchText;

let requestLog = [];
let jsonResponder = null;
let textResponder = null;
let robotsAllow = true;
let robotsLog = [];

http.fetchJson = async (url, opts) => {
  requestLog.push(url);
  return jsonResponder ? jsonResponder(url, opts) : { ok: false, status: 500, json: null };
};
http.fetchText = async (url, opts) => {
  requestLog.push(url);
  return textResponder ? textResponder(url, opts) : { ok: false, status: 500, text: null };
};
const realRobots = http.isAllowedByRobots;
http.isAllowedByRobots = async (url) => {
  robotsLog.push(url);
  return typeof robotsAllow === 'function' ? robotsAllow(url) : robotsAllow;
};

const adapters = require('../services/reviewAdapters');
const { collectFromAdapter, firstMatch, pick, pickAny, toInt, toFloat } = adapters;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('use checkAsync for async tests');
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const asyncTests = [];
function checkAsync(name, fn) {
  asyncTests.push([name, fn]);
}

function reset() {
  requestLog = [];
  robotsLog = [];
  jsonResponder = null;
  textResponder = null;
  robotsAllow = true;
}

// ── a fake vendor + adapter ────────────────────────────────────────

// Vendor with 47 reviews, 10 per page, 1-based `page` param, and a total
// count in the envelope. Mirrors the common shape.
function fakeVendor({ totalReviews = 47, pageSize = 10, ignorePageParam = false } = {}) {
  return (url) => {
    const page = Number(new URL(url).searchParams.get('page') || 1);
    const start = ignorePageParam ? 0 : (page - 1) * pageSize;
    const rows = [];
    for (let i = start; i < Math.min(start + pageSize, totalReviews); i++) {
      rows.push({
        id: i,
        body: `Review number ${i} — held up well over three months of daily use.`,
        headline: `Title ${i}`,
        score: (i % 5) + 1,
        reviewer: { name: `User${i}` },
        created: '2026-05-01'
      });
    }
    return {
      ok: true,
      status: 200,
      json: { response: { reviews: rows, total: totalReviews, average: 4.3 } }
    };
  };
}

const FAKE = {
  platform: 'fakevendor',
  pageSize: 10,
  discover(html) {
    const key = firstMatch(html, [/fakevendor_key="([^"]+)"/]);
    const pid = firstMatch(html, [/fakevendor_product="([^"]+)"/]);
    if (!key || !pid) return null;
    return { key, pid };
  },
  request(ctx, page) {
    return {
      url: `https://api.fakevendor.test/v1/${ctx.key}/products/${ctx.pid}/reviews.json?page=${page + 1}&per_page=10`,
      as: 'json'
    };
  },
  parse(payload) {
    return {
      reviews: pick(payload, 'response.reviews') || [],
      total: pick(payload, 'response.total'),
      average: pick(payload, 'response.average')
    };
  },
  normalize(raw) {
    if (!raw || !raw.body) return null;
    return {
      text: raw.body,
      title: raw.headline || null,
      author: pickAny(raw, ['reviewer.name', 'author']) || null,
      rating: toFloat(raw.score),
      datePublished: raw.created ? new Date(raw.created) : null,
      verified: true
    };
  }
};

const PDP = '<html>fakevendor_key="abc123" fakevendor_product="P-9"</html>';

// ── discovery ──────────────────────────────────────────────────────

checkAsync('discover() null → adapter skipped, zero requests', async () => {
  reset();
  jsonResponder = fakeVendor();
  const r = await collectFromAdapter(FAKE, { html: '<html>no keys here</html>', pageUrl: 'https://s.test/p/1' });
  assert.equal(r, null);
  assert.equal(requestLog.length, 0);
});

check('firstMatch: ordered fallback across identifier shapes', () => {
  const html = '<div data-oke-store="sub-123"></div>';
  assert.equal(firstMatch(html, [/subscriberId="([^"]+)"/, /data-oke-store="([^"]+)"/]), 'sub-123');
  assert.equal(firstMatch(html, [/nope="([^"]+)"/]), null);
});

check('firstMatch: a /g regex does not carry lastIndex between calls', () => {
  const re = /key="([^"]+)"/g;
  const html = 'key="one"';
  assert.equal(firstMatch(html, [re]), 'one');
  assert.equal(firstMatch(html, [re]), 'one');   // would be null if lastIndex leaked
});

check('pick / pickAny / toInt / toFloat', () => {
  assert.equal(pick({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
  assert.equal(pick({ a: null }, 'a.b.c'), undefined);
  assert.equal(pickAny({ x: '', y: 'hit' }, ['x', 'y']), 'hit');
  assert.equal(toInt('1,234 reviews'), 1234);
  assert.equal(toFloat('4.6 out of 5'), 4.6);
  assert.equal(toInt('none'), null);
});

// ── pagination ─────────────────────────────────────────────────────

checkAsync('pages until the vendor runs out (47 reviews, 10/page, cap 5 pages)', async () => {
  reset();
  jsonResponder = fakeVendor({ totalReviews: 47 });
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 5, maxReviews: 200 });
  assert.equal(r.platform, 'fakevendor');
  assert.equal(r.reviews.length, 47);
  assert.equal(r.pagesFetched, 5);
  assert.equal(r.total, 47);
  assert.equal(r.average, 4.3);
  // page 5 returned 7 rows (< pageSize) → short page, stop
  assert.equal(r.stopReason, 'short page');
  assert.equal(requestLog.length, 5);
  assert.match(requestLog[0], /page=1&/);
  assert.match(requestLog[4], /page=5&/);
});

checkAsync('review cap truncates and flags it', async () => {
  reset();
  jsonResponder = fakeVendor({ totalReviews: 500 });
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 50, maxReviews: 25 });
  assert.equal(r.reviews.length, 25);
  assert.equal(r.truncated, true);
  assert.equal(r.stopReason, 'review cap');
  assert.equal(requestLog.length, 3);          // 10 + 10 + 5 → stops mid-page 3
});

checkAsync('page cap truncates and flags it', async () => {
  reset();
  jsonResponder = fakeVendor({ totalReviews: 500 });
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 2, maxReviews: 1000 });
  assert.equal(r.reviews.length, 20);
  assert.equal(r.pagesFetched, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.stopReason, 'page cap');
});

checkAsync('vendor that IGNORES the page param stops after page 2, not at the cap', async () => {
  reset();
  jsonResponder = fakeVendor({ totalReviews: 500, ignorePageParam: true });
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 20, maxReviews: 1000 });
  assert.equal(r.reviews.length, 10);          // page 2 was all duplicates
  assert.equal(r.stopReason, 'no new reviews');
  assert.equal(requestLog.length, 2);
});

checkAsync('hasMore:false is honoured even on a full page', async () => {
  reset();
  const ADAPTER = Object.assign({}, FAKE, {
    parse(payload) {
      return { reviews: pick(payload, 'response.reviews') || [], total: 47, hasMore: false };
    }
  });
  jsonResponder = fakeVendor({ totalReviews: 500 });
  const r = await collectFromAdapter(ADAPTER, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 10 });
  assert.equal(r.pagesFetched, 1);
  assert.equal(r.stopReason, 'vendor says last page');
});

checkAsync('empty first page → null result (nothing to store)', async () => {
  reset();
  jsonResponder = () => ({ ok: true, status: 200, json: { response: { reviews: [] } } });
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1' });
  assert.equal(r, null);
});

checkAsync('aggregate-only response still returns a result', async () => {
  reset();
  jsonResponder = () => ({ ok: true, status: 200, json: { response: { reviews: [], total: 88, average: 4.8 } } });
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1' });
  assert.ok(r);
  assert.equal(r.total, 88);
  assert.equal(r.average, 4.8);
  assert.deepEqual(r.reviews, []);
});

// ── failure handling ───────────────────────────────────────────────

checkAsync('mid-pagination HTTP error keeps the pages already collected', async () => {
  reset();
  const good = fakeVendor({ totalReviews: 500 });
  jsonResponder = (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page >= 3) return { ok: false, status: 503, json: null };
    return good(url);
  };
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 10 });
  assert.equal(r.reviews.length, 20);
  assert.equal(r.stopReason, 'http 503');
});

checkAsync('rate limit bails politely, keeping partials', async () => {
  reset();
  const good = fakeVendor({ totalReviews: 500 });
  jsonResponder = (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page >= 2) return { ok: false, status: 429, json: null, rateLimited: true };
    return good(url);
  };
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 10 });
  assert.equal(r.reviews.length, 10);
  assert.equal(r.stopReason, 'rate limited');
});

checkAsync('a throwing parse() does not propagate', async () => {
  reset();
  jsonResponder = fakeVendor();
  const ADAPTER = Object.assign({}, FAKE, { parse() { throw new Error('boom'); } });
  const r = await collectFromAdapter(ADAPTER, { html: PDP, pageUrl: 'https://s.test/p/1' });
  assert.equal(r, null);                       // nothing collected → null
});

checkAsync('a throwing discover() is swallowed (adapter just declines)', async () => {
  reset();
  const ADAPTER = Object.assign({}, FAKE, { discover() { throw new Error('bad regex'); } });
  const r = await collectFromAdapter(ADAPTER, { html: PDP, pageUrl: 'https://s.test/p/1' });
  assert.equal(r, null);
  assert.equal(requestLog.length, 0);
});

checkAsync('normalize() returning null skips rows without breaking paging', async () => {
  reset();
  jsonResponder = fakeVendor({ totalReviews: 20 });
  const ADAPTER = Object.assign({}, FAKE, {
    normalize(raw) { return raw.id % 2 === 0 ? FAKE.normalize(raw) : null; }
  });
  const r = await collectFromAdapter(ADAPTER, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 5 });
  assert.equal(r.reviews.length, 10);          // half of 20
  assert.ok(r.pagesFetched >= 2);
});

checkAsync('dedupe across pages: repeated text is stored once', async () => {
  reset();
  let call = 0;
  jsonResponder = () => {
    call += 1;
    const dup = { id: 1, body: 'Same exact review body repeated by the vendor across pages.', score: 5 };
    const uniq = { id: call * 100, body: `Unique body ${call} that is long enough to be kept.`, score: 5 };
    return { ok: true, status: 200, json: { response: { reviews: [dup, uniq], total: 99 } } };
  };
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 3 });
  const bodies = r.reviews.map(q => q.text);
  assert.equal(new Set(bodies).size, bodies.length);
  assert.equal(bodies.filter(b => b.startsWith('Same exact')).length, 1);
});

checkAsync('text-mode adapters (HTML widget responses) are supported', async () => {
  reset();
  textResponder = () => ({
    ok: true,
    status: 200,
    text: '<div class="rev"><p>Wore these hiking for three months and they still look new.</p></div>'
  });
  const ADAPTER = {
    platform: 'htmlvendor',
    pageSize: 1,
    discover: () => ({ shop: 's.test' }),
    request: (ctx, page) => ({ url: `https://htmlvendor.test/w?shop=${ctx.shop}&page=${page + 1}`, as: 'text' }),
    parse: (text) => ({
      reviews: [...text.matchAll(/<p>([^<]+)<\/p>/g)].map(m => ({ body: m[1] })),
      hasMore: false
    }),
    normalize: (raw) => ({ text: raw.body, title: null, author: null, rating: null, datePublished: null })
  };
  const r = await collectFromAdapter(ADAPTER, { html: '<html/>', pageUrl: 'https://s.test/p/1' });
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0].text, /hiking/);
});

// ── robots compliance on vendor hosts ──────────────────────────────

checkAsync('robots.txt disallow on the vendor host → adapter declines, nothing fetched', async () => {
  reset();
  robotsAllow = false;
  jsonResponder = fakeVendor();
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1' });
  assert.equal(r, null);
  assert.equal(requestLog.length, 0, 'must not fetch a disallowed endpoint');
  assert.equal(robotsLog.length, 1);
  assert.match(robotsLog[0], /api\.fakevendor\.test/);
});

checkAsync('robots is checked once, not per page', async () => {
  reset();
  jsonResponder = fakeVendor({ totalReviews: 47 });
  await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1', maxPages: 5, maxReviews: 200 });
  assert.equal(robotsLog.length, 1);
  assert.equal(requestLog.length, 5);
});

checkAsync('unreachable robots.txt (throw) is treated as "nothing stated" → proceed', async () => {
  reset();
  robotsAllow = () => { throw new Error('403'); };
  jsonResponder = fakeVendor({ totalReviews: 5 });
  const r = await collectFromAdapter(FAKE, { html: PDP, pageUrl: 'https://s.test/p/1' });
  assert.ok(r);
  assert.equal(r.reviews.length, 5);
});

// ── per-vendor adapters, against real payload shapes ───────────────
//
// Fixtures mirror the exact structures a research pass captured live from
// each vendor on 2026-07-27 (field names, nesting, indexing, clamps). They
// are deliberately shaped like the real thing rather than minimal — the
// traps these adapters exist to handle only show up in the real shapes.

const byPlatform = (slug) => adapters.BY_PLATFORM.get(slug);

check('every registered adapter declares a slug the detector also knows', () => {
  const { NAMED } = require('../utils/htmlEntities');   // sanity: helpers load
  assert.ok(NAMED);
  const eng = require('../services/productReviewsScrapeService');
  for (const a of adapters.ADAPTERS) {
    // detectReviewPlatform must be able to produce this slug, otherwise the
    // "detected platform first" ordering silently never fires for it.
    const probe = {
      'bazaarvoice': '<div data-bv-show="reviews"></div>',
      'judge.me': '<div class="jdgm-widget"></div>',
      'yotpo': '<script src="//cdn.yotpo.com/w.js">',
      'okendo': '<div data-oke-widget></div>',
      'stamped': '<script src="https://cdn1.stamped.io/files/widget.min.js">',
      'reviews.io': '<div class="ruk_rating_snippet"></div>',
      'powerreviews': '<div class="pr-snippet"></div>',
      'junip': '<span class="junip-store-key"></span>',
      'fera': '<script src="https://cdn.fera.ai/js/v3/fera.js">'
    }[a.platform];
    assert.ok(probe, `no detector probe for ${a.platform}`);
    assert.equal(eng.detectReviewPlatform(probe), a.platform, `detector missed ${a.platform}`);
  }
});

// ── Yotpo ──────────────────────────────────────────────────────────

check('yotpo: discovery takes the REVIEWS key, never the loyalty key', () => {
  const a = byPlatform('yotpo');
  const html = `
    <script src="https://cdn-loyalty.yotpo.com/loader/dVWhcBSvyqNFQpeF1QrmIg.js?shop=x"></script>
    <script src="https://cdn-widgetsrepository.yotpo.com/v1/loader/3rDpN9Pt4bd0nDlU4w5UAHDVg66o2ao2LlD94EWF?languageCode=en"></script>
    <div class="yotpo-widget-instance" data-yotpo-product-id="538465337388"></div>`;
  const ctx = a.discover(html, 'https://s.com/p/1');
  assert.equal(ctx.appKey, '3rDpN9Pt4bd0nDlU4w5UAHDVg66o2ao2LlD94EWF');
  assert.notEqual(ctx.appKey, 'dVWhcBSvyqNFQpeF1QrmIg');
  assert.equal(ctx.productId, '538465337388');
  assert.match(a.request(ctx, 0).url, /\/v1\/widget\/3rDpN9[^/]*\/products\/538465337388\/reviews\.json/);
  assert.match(a.request(ctx, 0).url, /page=1/);       // driver 0 → vendor 1
  assert.match(a.request(ctx, 3).url, /page=4/);
});

check('yotpo: parse maps rows, bottomline and star_distribution', () => {
  const a = byPlatform('yotpo');
  const payload = {
    response: {
      pagination: { page: 1, per_page: 150, total: 82 },
      bottomline: { average_score: 4.7, total_review: 82, star_distribution: [2, 1, 4, 15, 60] },
      reviews: [{
        content: 'Softest tee I own and it survived a year of weekly washes.',
        title: 'Holds up', score: 5, created_at: '2026-05-02T10:00:00Z',
        verified_buyer: true, user: { display_name: 'Sam' }
      }]
    }
  };
  const p = a.parse(payload, {}, 0);
  assert.equal(p.total, 82);
  assert.equal(p.average, 4.7);
  // ASCENDING array → 5-star bucket must be 60, not 2
  assert.deepEqual(p.distribution[0], { stars: 5, count: 60 });
  const q = a.normalize(p.reviews[0]);
  assert.equal(q.rating, 5);
  assert.equal(q.author, 'Sam');
  assert.equal(q.verified, true);
  assert.ok(q.datePublished instanceof Date);
});

// ── REVIEWS.io — the 0-indexing trap ───────────────────────────────

check('reviews.io: page 0 is the FIRST page (0-indexed endpoint)', () => {
  const a = byPlatform('reviews.io');
  const html = `<script>var reviewsIoStore = 'boxraw';</script>
    <div class="ruk_rating_snippet" data-sku="BXRW-GSB-B-OS;40047970385978;7104899907642;handle"></div>`;
  const ctx = a.discover(html, 'https://boxraw.com/p/1');
  assert.equal(ctx.store, 'boxraw');
  assert.equal(ctx.sku, 'BXRW-GSB-B-OS');            // first segment only
  assert.match(a.request(ctx, 0).url, /page=0&/);    // NOT page=1
  assert.match(a.request(ctx, 1).url, /page=1&/);
});

check('reviews.io: total_pages drives termination, current_page is ignored', () => {
  const a = byPlatform('reviews.io');
  // current_page echoes the request and lies — 2 pages of data, we are on the last
  const payload = {
    count: 68, rating: 4.8, total_pages: 2, current_page: 99,
    reviews: [{
      review: 'Gloves held up through eight months of heavy bag work.',
      title: 'Tough', rating: 5, date_created: '2026-04-01',
      reviewer: { first_name: 'Jo', last_name: 'B', verified_buyer: true }
    }]
  };
  assert.equal(a.parse(payload, {}, 0).hasMore, true);   // page 0 of 2 → more
  assert.equal(a.parse(payload, {}, 1).hasMore, false);  // page 1 of 2 → done
  const q = a.normalize(payload.reviews[0]);
  assert.equal(q.author, 'Jo B');
  assert.equal(q.rating, 5);
});

// ── Bazaarvoice — error-in-200, family rollup, offsets ──────────────

check('bazaarvoice: Errors[] inside a 200 body becomes a stop, not an empty page', () => {
  const a = byPlatform('bazaarvoice');
  const payload = {
    Limit: 0, Offset: 0, TotalResults: 0, Results: [],
    Errors: [{ Message: 'Invalid limit value: 200, limit cannot be greater than 100',
               Code: 'ERROR_PARAM_INVALID_LIMIT' }]
  };
  const p = a.parse(payload, { productId: '1' }, 0);
  assert.match(p.error, /limit cannot be greater than 100/);
  assert.deepEqual(p.reviews, []);
});

check('bazaarvoice: Offset is a RECORD offset and Filter is mandatory', () => {
  const a = byPlatform('bazaarvoice');
  const ctx = { passkey: 'pk', productId: '384812' };
  assert.match(a.request(ctx, 0).url, /Offset=0/);
  assert.match(a.request(ctx, 2).url, /Offset=200/);    // page 2 × Limit 100
  assert.match(a.request(ctx, 0).url, /Filter=ProductId%3A384812/);
  assert.match(a.request(ctx, 0).url, /Limit=100/);
});

check('bazaarvoice: family rollup — exact-product rows win when present', () => {
  const a = byPlatform('bazaarvoice');
  const ctx = { productId: '384812', familyRollup: false };
  const payload = {
    TotalResults: 1511,
    Results: [
      { ProductId: '384808', ReviewText: 'The ottoman is lovely and firm.', Rating: 5 },
      { ProductId: '384812', ReviewText: 'This sofa seats five comfortably.', Rating: 5 }
    ],
    Includes: { Products: { 384812: { ReviewStatistics: {
      AverageOverallRating: 4.6, TotalReviewCount: 1511,
      RatingDistribution: [{ RatingValue: 5, Count: 1200 }, { RatingValue: 1, Count: 40 }]
    } } } }
  };
  const p = a.parse(payload, ctx, 0);
  assert.equal(p.reviews.length, 1);
  assert.match(p.reviews[0].ReviewText, /sofa seats five/);
  assert.equal(ctx.familyRollup, false);
  assert.equal(p.average, 4.6);
  assert.deepEqual(p.distribution, [{ stars: 5, count: 1200 }, { stars: 1, count: 40 }]);
});

check('bazaarvoice: family rollup — falls back to siblings and FLAGS them', () => {
  const a = byPlatform('bazaarvoice');
  const ctx = { productId: '384812', familyRollup: false };
  const payload = {
    TotalResults: 1511,
    Results: [{ ProductId: '384810', ReviewText: 'Great ottoman, matches the set.', Rating: 5 }]
  };
  const p = a.parse(payload, ctx, 0);
  assert.equal(p.reviews.length, 1);
  assert.equal(ctx.familyRollup, true);
  const q = a.normalize(p.reviews[0], ctx);
  assert.equal(q.familyRollup, true, 'sibling quotes must carry provenance');
});

check('bazaarvoice: ratings-only reviews (no body) are skipped', () => {
  const a = byPlatform('bazaarvoice');
  assert.equal(a.normalize({ Rating: 5, ReviewText: '' }, {}), null);
  assert.equal(a.normalize({ Rating: 5 }, {}), null);
});

// ── PowerReviews — epoch ms, ascending histogram, pages_total ───────

check('powerreviews: paging.from is a record offset capped at size 25', () => {
  const a = byPlatform('powerreviews');
  const ctx = { apiKey: 'k', merchantId: '6406', locale: 'en_US', pageId: 'pimprod2054180' };
  assert.equal(a.pageSize, 25);
  assert.match(a.request(ctx, 0).url, /paging\.from=0/);
  assert.match(a.request(ctx, 3).url, /paging\.from=75/);
  assert.match(a.request(ctx, 0).url, /paging\.size=25/);
  assert.match(a.request(ctx, 0).url, /\/m\/6406\/l\/en_US\/product\/pimprod2054180\/reviews/);
  // merchant_group_id must never appear
  assert.ok(!/merchant_group/i.test(a.request(ctx, 0).url));
});

check('powerreviews: epoch-ms dates and ASCENDING histogram', () => {
  const a = byPlatform('powerreviews');
  const payload = {
    paging: { total_results: 714, pages_total: 29, current_page_number: 1 },
    results: [{
      rollup: { average_rating: 4.48, review_count: 714, rating_histogram: [26, 20, 44, 122, 502] },
      reviews: [{
        details: { comments: 'Full coverage that lasted a 12-hour shift.',
                   headline: 'All day wear', nickname: 'Dana', created_date: 1751000000000 },
        metrics: { rating: 5 }, badges: { is_verified_buyer: true }
      }]
    }]
  };
  const p = a.parse(payload, {}, 0);
  assert.equal(p.total, 714);
  assert.equal(p.average, 4.48);
  assert.deepEqual(p.distribution[0], { stars: 5, count: 502 });   // ascending → 502 is 5-star
  assert.equal(p.hasMore, true);
  assert.equal(a.parse(payload, {}, 28).hasMore, false);           // page 28 of 29
  const q = a.normalize(payload.results[0].reviews[0]);
  assert.equal(q.author, 'Dana');
  assert.equal(q.datePublished.getUTCFullYear(), 2025);            // ms, not seconds
});

check('powerreviews: status_code>=400 inside the body is an error stop', () => {
  const a = byPlatform('powerreviews');
  const p = a.parse({ message: 'paging.size maximum value is 25', status_code: 400 }, {}, 0);
  assert.match(p.error, /maximum value is 25/);
});

// ── Junip / Okendo — cursor paging ─────────────────────────────────

check('junip: cursor paging, no totals in the list, summary span harvested', () => {
  const a = byPlatform('junip');
  const html = `<script src="https://widgets.juniphq.com/v1/junip_shopify.js?shop=hexclad-cookware.myshopify.com"></script>
    <span class="junip-store-key" data-store-key="jg6Ctmk2KGaaKe7sXgWBYgxi"></span>
    <span class="junip-product-summary" data-product-id="6888697921670"
      data-product-rating-count="8278" data-product-rating-average="4.845"></span>`;
  const ctx = a.discover(html, 'https://hexclad.com/p/1');
  assert.equal(ctx.storeKey, 'jg6Ctmk2KGaaKe7sXgWBYgxi');
  assert.equal(ctx.productId, '6888697921670');
  assert.equal(ctx.summaryTotal, 8278);       // free aggregate, no extra request
  const r0 = a.request(ctx, 0);
  assert.equal(r0.headers['Junip-Store-Key'], 'jg6Ctmk2KGaaKe7sXgWBYgxi');
  assert.ok(!/page_after/.test(r0.url), 'first page must omit the cursor');
  assert.match(r0.url, /page_size=50/);
  // page > 0 without a cursor must stop rather than refetch page 1
  assert.equal(a.request({ ...ctx, cursor: null }, 1), null);
  ctx.cursor = 'eyJyZXZpZXdfY3JlYXRlZF9hdCI6';
  assert.match(a.request(ctx, 1).url, /page_after=eyJyZXZpZXdfY3JlYXRlZF9hdCI6/);
});

check('junip: product-group rollup prefers exact remote_id, else flags', () => {
  const a = byPlatform('junip');
  const ctx = { productId: '6888697921670', storeKey: 'k' };
  const exact = {
    data: [
      { body: 'The 6-pc set is great but I bought the 12-pc.', rating: 5,
        product: { remote_id: 4352900202630 } },
      { body: 'Pans heat evenly and clean up in seconds.', rating: 5,
        product: { remote_id: 6888697921670 }, title: 'Even heat',
        customer: { first_name: 'Ada', last_name: 'L' }, verified_buyer: true }
    ],
    meta: { after: null }
  };
  const p = a.parse(exact, ctx, 0);
  assert.equal(p.reviews.length, 1);
  assert.equal(ctx.familyRollup, false);
  const q = a.normalize(p.reviews[0], ctx);
  assert.equal(q.author, 'Ada L');
  assert.equal(q.title, 'Even heat');
  assert.equal(q.familyRollup, undefined);

  const groupOnly = { data: [{ body: 'Love the 6-pc pot set lids.', rating: 5,
    product: { remote_id: 4352900202630 } }], meta: { after: null } };
  const ctx2 = { productId: '6888697921670', storeKey: 'k' };
  const p2 = a.parse(groupOnly, ctx2, 0);
  assert.equal(ctx2.familyRollup, true);
  assert.equal(a.normalize(p2.reviews[0], ctx2).familyRollup, true);
});

check('junip: title never falls back to target_title (a PRODUCT name)', () => {
  const a = byPlatform('junip');
  const q = a.normalize({ body: 'Solid pan, even heat after months.',
    target_title: 'Hybrid Pot Set with Lids, 6-pc' }, {});
  assert.equal(q.title, null, 'a product name must not be used as a review headline');
});

check('okendo: productId must be shopify-prefixed; cursor replayed verbatim', () => {
  const a = byPlatform('okendo');
  const html = `<script id="okeReferralSettings" type="application/json">
      {"subscriberId":"6a5493fe-bb43-48c7-9860-714f216f13cf"}</script>
    <div data-oke-widget data-oke-reviews-product-id="shopify-8859021475989"></div>`;
  const ctx = a.discover(html, 'https://s.com/p/1');
  assert.equal(ctx.subscriberId, '6a5493fe-bb43-48c7-9860-714f216f13cf');
  assert.equal(ctx.productId, 'shopify-8859021475989');
  assert.match(a.request(ctx, 0).url, /\/products\/shopify-8859021475989\/reviews/);

  const payload = { reviews: [{ body: 'Held colour after 20 washes.', rating: 5,
      dateCreated: '2026-03-01', reviewer: { displayName: 'Kim', isVerified: true } }],
    nextUrl: '/stores/6a5493fe/products/shopify-1/reviews?limit=5&lastEvaluated=%7Bx%7D',
    reviewAggregate: { reviewCount: 40, reviewCountByLevel: { level5Count: 30, level1Count: 2 } } };
  const p = a.parse(payload, ctx, 0);
  assert.equal(p.hasMore, true);
  assert.equal(p.total, 40);
  assert.deepEqual(p.distribution[0], { stars: 5, count: 30 });
  ctx.cursor = p.cursor;
  assert.match(a.request(ctx, 1).url, /lastEvaluated=%7Bx%7D/);   // verbatim replay
  // Absent nextUrl = authoritative last page
  assert.equal(a.parse({ reviews: [] }, ctx, 1).hasMore, false);
});

check('okendo: synthesises the shopify- prefix when only a bare id exists', () => {
  const a = byPlatform('okendo');
  const html = `<meta name="oke:subscriber_id" content="6a5493fe-bb43-48c7-9860-714f216f13cf">
    <div data-oke-widget></div>
    <script>var meta = {"product":{"id":8859021475989,"gid":"x"}};</script>`;
  const ctx = a.discover(html, 'https://s.com/p/1');
  assert.equal(ctx.productId, 'shopify-8859021475989');
});

// ── Judge.me — HTML fragment parsing ───────────────────────────────

check('judge.me: parses the HTML fragment into rows with stars', () => {
  const a = byPlatform('judge.me');
  const html = `<script>window.jdgmSettings={"pagination":5};</script>
    <div class="jdgm-widget jdgm-preview-badge" data-id='7432276279379'
      data-average-rating="4.74" data-number-of-reviews="81"></div>`;
  const ctx = a.discover(html, 'https://beardbrand.com/products/x');
  assert.equal(ctx.productId, '7432276279379');
  assert.equal(ctx.pageAverage, 4.74);
  assert.equal(ctx.pageCount, 81);
  const req = a.request(ctx, 0);
  assert.match(req.url, /per_page=30/);      // the silent clamp ceiling
  assert.match(req.url, /page=1/);

  const fragment = `<div class="jdgm-rev-widg__reviews">
    <div class="jdgm-rev jdgm-divider-top" data-score="5" data-verified-buyer="true"
         data-timestamp="2026-05-01T00:00:00Z">
      <b class="jdgm-rev__title">Best trimmer</b>
      <div class="jdgm-rev__body"><p>Cuts cleanly and the battery lasts weeks.</p></div>
      <span class="jdgm-rev__author">Alex</span>
    </div>
    <div class="jdgm-rev" data-score="2" data-verified-buyer="false">
      <div class="jdgm-rev__body"><p>Stopped charging after a month.</p></div>
      <span class="jdgm-rev__author">Sam</span>
    </div></div>`;
  const p = a.parse({ html: fragment }, ctx, 0);
  assert.equal(p.reviews.length, 2);
  assert.equal(p.average, 4.74);
  const q = a.normalize(p.reviews[0]);
  assert.equal(q.text, 'Cuts cleanly and the battery lasts weeks.');
  assert.equal(q.title, 'Best trimmer');
  assert.equal(q.author, 'Alex');
  assert.equal(q.rating, 5);
  assert.equal(q.verified, true);
  assert.equal(a.normalize(p.reviews[1]).rating, 2);
});

// ── Stamped / Fera ─────────────────────────────────────────────────

check('stamped: pubkey + sId from one init call, Shopify id from analytics', () => {
  const a = byPlatform('stamped');
  const html = `<script>function myInit(){ StampedFn.init({ apiKey: 'pubkey-3k2cnGWYWs2hfG2efGP1cwlH6XrYvo', sId: '114374' }); }</script>
    <script src="https://cdn1.stamped.io/files/widget.min.js"></script>
    <script>var meta = {"product":{"id":8483130540168,"gid":"gid://shopify/Product/8483130540168"}};</script>`;
  const ctx = a.discover(html, 'https://innosupps.com/p/1');
  assert.equal(ctx.apiKey, 'pubkey-3k2cnGWYWs2hfG2efGP1cwlH6XrYvo');
  assert.equal(ctx.storeUrl, '114374');
  assert.equal(ctx.productId, '8483130540168');
  assert.match(a.request(ctx, 0).url, /page=1&/);
  assert.match(a.request(ctx, 0).url, /take=100/);

  const payload = { total: 398, rating: 4.7, data: [{
    reviewMessage: 'Mixes clean with no clumps at all.', reviewTitle: 'Smooth',
    reviewRating: 5, author: 'Ray', dateCreated: '2026-06-01', reviewVerifiedType: 2 }] };
  const p = a.parse(payload, ctx, 0);
  assert.equal(p.total, 398);
  assert.equal(p.average, 4.7);
  const q = a.normalize(p.data ? p.data[0] : p.reviews[0]);
  assert.equal(q.verified, true);        // non-zero enum = verified
});

check('fera: 1-indexed pages, meta.page_count terminates', () => {
  const a = byPlatform('fera');
  const html = `<script>const fkey = "pk_e70aebf09910b4ffa8a096daf07aaeb5da64c102e28fe16ba1dddadd61d5f43f";
    const fdomain = "the-vintage-secret.myshopify.com";</script>
    <script>window.fera.push({ action: "setProductId", product_id: "7961280610487" });</script>`;
  const ctx = a.discover(html, 'https://thevintagesecret.com.au/products/x');
  assert.match(ctx.apiKey, /^pk_e70aebf0/);
  assert.equal(ctx.productId, '7961280610487');
  assert.match(a.request(ctx, 0).url, /page=1&/);
  assert.match(a.request(ctx, 0).url, /cdn\.fera\.ai/);   // edge cache, politer

  const payload = { product: null, meta: { page: 1, page_count: 3, total_count: 26 },
    data: [{ body: 'Adjustable length is perfect, choker to long.', heading: 'Excellent!',
      rating: 5, created_at: '2025-08-25T21:58:48Z', is_verified: true,
      customer: { display_name: 'Mia' } }] };
  const p = a.parse(payload, ctx, 0);
  assert.equal(p.total, 26);
  assert.equal(p.hasMore, true);
  assert.equal(a.parse({ meta: { page: 3, page_count: 3, total_count: 26 }, data: [] }, ctx, 2).hasMore, false);
  const q = a.normalize(p.reviews[0]);
  assert.equal(q.title, 'Excellent!');
  assert.equal(q.author, 'Mia');
});

// ── tier 3: headless capture internals ─────────────────────────────
//
// The browser half can't run here (puppeteer is absent from this container's
// partial install), but everything that decides WHAT gets harvested is pure:
// URL matching, JSONP unwrapping, and the reuse of tier-2 adapters to map an
// intercepted payload. Those are the parts that break silently, so they are
// the parts under test.

const headless = require('../services/reviewHeadlessCapture');

check('headless: JSONP wrapper is unwrapped (Bazaarvoice batch.json)', () => {
  const jsonp = 'BV._internal.dataHandler0({"BatchedResults":{"q0":{"Results":[],"TotalResults":149}}})';
  const j = headless.unwrapJsonp(jsonp);
  assert.equal(j.BatchedResults.q0.TotalResults, 149);
  // bv_<n>_<n> callback naming also occurs
  assert.ok(headless.unwrapJsonp('bv_123_456({"Results":[]})'));
  // plain JSON passes straight through
  assert.deepEqual(headless.unwrapJsonp('{"a":1}'), { a: 1 });
  assert.equal(headless.unwrapJsonp('not json at all'), null);
  assert.equal(headless.unwrapJsonp(''), null);
  assert.equal(headless.unwrapJsonp(null), null);
});

check('headless: only review-carrying URLs match; loader/telemetry do not', () => {
  const m = (u) => { const v = headless.matchVendorResponse(u); return v && v.platform; };
  assert.equal(m('https://api.bazaarvoice.com/data/batch.json?passkey=x'), 'bazaarvoice');
  assert.equal(m('https://api.bazaarvoice.com/data/reviews.json?passkey=x'), 'bazaarvoice');
  assert.equal(m('https://apid.juniphq.com/v2/products/remote/123/reviews?page_size=5'), 'junip');
  assert.equal(m('https://api-cdn.yotpo.com/v1/widget/KEY/products/9/reviews.json'), 'yotpo');
  assert.equal(m('https://api.okendo.io/v1/stores/sub/products/shopify-1/reviews'), 'okendo');
  assert.equal(m('https://stamped.io/api/widget/reviews?productId=1'), 'stamped');
  assert.equal(m('https://judge.me/reviews/reviews_for_widget?url=x'), 'judge.me');
  assert.equal(m('https://display.powerreviews.com/m/6406/l/en_US/product/p1/reviews'), 'powerreviews');
  assert.equal(m('https://cdn.fera.ai/api/v3/public/products/7/reviews.json'), 'fera');

  // Presence-only / noise hosts must never be harvested.
  assert.equal(m('https://network-a.bazaarvoice.com/beacon.gif'), null);
  assert.equal(m('https://apps.bazaarvoice.com/deployments/client/main_site/bv.js'), null);
  assert.equal(m('https://display.ugc.bazaarvoice.com/static/Client/bvapi.js'), null);
  assert.equal(m('https://scripts.juniphq.com/v1/junip.js'), null);
  assert.equal(m('https://www.googletagmanager.com/gtm.js'), null);
  assert.equal(m(''), null);
  assert.equal(m(null), null);
});

check('headless: intercepted BV batch payload maps via the tier-2 adapter', () => {
  const vendor = headless.matchVendorResponse('https://api.bazaarvoice.com/data/batch.json');
  const jsonp = 'BV._internal.dataHandler0(' + JSON.stringify({
    BatchedResults: {
      q0: { Limit: 30, Offset: 10, TotalResults: 149, Results: [{
        ProductId: '7330615623735',
        ReviewText: 'Bold roast with real caffeine kick, my morning staple now.',
        Title: 'Strong', Rating: 5, UserNickname: 'Chuey72',
        SubmissionTime: '2026-07-27T01:51:05.000+00:00',
        Badges: { verifiedPurchaser: true }
      }] }
    }
  }) + ')';
  const got = headless.harvestFromPayload(vendor, jsonp, { productId: null });
  assert.equal(got.quotes.length, 1);
  assert.equal(got.total, 149);
  assert.equal(got.quotes[0].rating, 5);
  assert.equal(got.quotes[0].author, 'Chuey72');
  assert.equal(got.quotes[0].source, 'bazaarvoice');
  assert.ok(got.quotes[0].datePublished instanceof Date);
});

check('headless: BV batch picks the sub-result holding reviews, whatever its q index', () => {
  const vendor = headless.matchVendorResponse('https://api.bazaarvoice.com/data/batch.json');
  // Real batches interleave products + reviews and the index shifts per call.
  const body = JSON.stringify({ BatchedResults: {
    q0: { Results: undefined, Products: [] },
    q7: { TotalResults: 4, Results: [{ ReviewText: 'Grinds evenly and stays fresh for weeks.', Rating: 4 }] }
  } });
  const got = headless.harvestFromPayload(vendor, body, {});
  assert.equal(got.quotes.length, 1);
  assert.equal(got.total, 4);
});

check('headless: intercepted Junip payload maps via its adapter', () => {
  const vendor = headless.matchVendorResponse('https://apid.juniphq.com/v2/products/remote/1/reviews');
  const got = headless.harvestFromPayload(vendor, {
    data: [{ body: 'Pans heat evenly and wash clean in seconds.', title: 'Even heat',
             rating: 5, created_at: '2026-06-01T00:00:00Z', verified_buyer: true,
             customer: { first_name: 'Ada', last_name: 'L' },
             product: { remote_id: 999 } }],
    meta: { after: 'cursor' }
  }, {});
  assert.equal(got.quotes.length, 1);
  assert.equal(got.quotes[0].author, 'Ada L');
  assert.equal(got.quotes[0].source, 'junip');
});

check('headless: unusable / mismatched payloads harvest nothing, never throw', () => {
  const bv = headless.matchVendorResponse('https://api.bazaarvoice.com/data/batch.json');
  for (const body of [null, undefined, '', 'garbage', '{}', '{"BatchedResults":{}}']) {
    const got = headless.harvestFromPayload(bv, body, {});
    assert.deepEqual(got.quotes, []);
  }
  assert.deepEqual(headless.harvestFromPayload(null, '{}', {}).quotes, []);
});

check('headless: load-more text sweep never clicks "Write a review"', () => {
  const rx = headless.LOAD_MORE_TEXT_RE;
  const deny = headless.LOAD_MORE_TEXT_DENY_RE;
  const wouldClick = (label) => rx.test(label) && !deny.test(label);
  assert.equal(wouldClick('See more reviews'), true);
  assert.equal(wouldClick('Load more'), true);
  assert.equal(wouldClick('Next Reviews'), true);
  assert.equal(wouldClick('Show more'), true);
  // These would navigate away mid-capture or open an unrelated flow.
  assert.equal(wouldClick('Write a review'), false);
  assert.equal(wouldClick('Write A Review'), false);
  assert.equal(wouldClick('Ask a question'), false);
  assert.equal(wouldClick('See more products'), false);
  assert.equal(wouldClick('Add to cart'), false);
});

check('headless: every vendor entry points at a registered tier-2 adapter', () => {
  for (const v of headless.VENDOR_RESPONSES) {
    assert.ok(adapters.BY_PLATFORM.get(v.adapter),
      `${v.platform} references unknown adapter "${v.adapter}"`);
    assert.equal(typeof v.test, 'function');
    assert.equal(typeof v.unwrap, 'function');
  }
});

checkAsync('headless: disabled by default — captureReviews is a no-op without opt-in', async () => {
  // ENABLED reads REVIEW_HEADLESS_ENABLED at load; unset here, so a call must
  // return null WITHOUT trying to launch a browser (puppeteer is absent from
  // this container, so a launch attempt would surface as an error, not null).
  assert.equal(headless.ENABLED, false);
  assert.equal(await headless.captureReviews('https://example.com/p/1'), null);
  assert.equal(await headless.captureReviews(''), null);
});

// ── registry ───────────────────────────────────────────────────────

check('registry: every loaded adapter satisfies the contract', () => {
  for (const a of adapters.ADAPTERS) {
    assert.equal(typeof a.platform, 'string', 'platform slug');
    assert.equal(typeof a.discover, 'function', `${a.platform}.discover`);
    assert.equal(typeof a.request, 'function', `${a.platform}.request`);
    assert.equal(typeof a.parse, 'function', `${a.platform}.parse`);
    assert.equal(typeof a.normalize, 'function', `${a.platform}.normalize`);
    assert.ok(Number.isFinite(a.pageSize) && a.pageSize > 0, `${a.platform}.pageSize`);
  }
});

check('adaptersFor: detected platform first, then the rest as fallback', () => {
  if (!adapters.ADAPTERS.length) return;              // nothing loaded yet
  const slug = adapters.ADAPTERS[adapters.ADAPTERS.length - 1].platform;
  const ordered = adapters.adaptersFor(slug);
  assert.equal(ordered[0].platform, slug);
  assert.equal(ordered.length, adapters.ADAPTERS.length);
  // Unknown platform → all adapters, original order
  assert.equal(adapters.adaptersFor('nope').length, adapters.ADAPTERS.length);
  assert.equal(adapters.adaptersFor(null).length, adapters.ADAPTERS.length);
});

// ── run ────────────────────────────────────────────────────────────

(async () => {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  http.fetchJson = realFetchJson;
  http.fetchText = realFetchText;
  http.isAllowedByRobots = realRobots;

  const total = passed + failed;
  console.log(`${passed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
})();
