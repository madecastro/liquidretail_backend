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
