#!/usr/bin/env node
// Offline pins for the D2 visual-match cache in productMatchService.
// Covers env parsers, cache set/get/miss/TTL/eviction/kill-switch,
// stats introspection, structural pins that cache-set is called at
// every return point in compareUgcCropToCatalogProduct, and that
// defaults.env commits the shipped values.
//
// Runs zero DB / zero network.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const svc = require('../services/productMatchService');
const {
  visualMatchCacheStats,
  __test: {
    _cacheKey,
    _cacheGet,
    _cacheSet,
    _visualMatchCache,
    isVisualMatchCacheEnabled,
    VISUAL_MATCH_CACHE_MAX,
    VISUAL_MATCH_CACHE_TTL_MS
  }
} = svc;

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

// ── Section A — env parsers / defaults ────────────────────────────────

console.log('\n== A. env parsers ==');

check('A1 VISUAL_MATCH_CACHE_MAX default is 500 (matches defaults.env)', () => {
  assert.strictEqual(VISUAL_MATCH_CACHE_MAX, 500);
});

check('A2 VISUAL_MATCH_CACHE_TTL_MS default is 30m (1_800_000)', () => {
  assert.strictEqual(VISUAL_MATCH_CACHE_TTL_MS, 30 * 60 * 1000);
});

check('A3 isVisualMatchCacheEnabled default true (matches defaults.env)', () => {
  const prior = process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
  try {
    delete process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
    assert.strictEqual(isVisualMatchCacheEnabled(), true);
  } finally {
    if (prior === undefined) delete process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
    else process.env.SKU_VISUAL_MATCH_CACHE_ENABLED = prior;
  }
});

check('A4 isVisualMatchCacheEnabled "false" → false', () => {
  const prior = process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
  try {
    process.env.SKU_VISUAL_MATCH_CACHE_ENABLED = 'false';
    assert.strictEqual(isVisualMatchCacheEnabled(), false);
  } finally {
    if (prior === undefined) delete process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
    else process.env.SKU_VISUAL_MATCH_CACHE_ENABLED = prior;
  }
});

check('A5 isVisualMatchCacheEnabled "0" → false', () => {
  const prior = process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
  try {
    process.env.SKU_VISUAL_MATCH_CACHE_ENABLED = '0';
    assert.strictEqual(isVisualMatchCacheEnabled(), false);
  } finally {
    if (prior === undefined) delete process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
    else process.env.SKU_VISUAL_MATCH_CACHE_ENABLED = prior;
  }
});

check('A6 isVisualMatchCacheEnabled "off" → false', () => {
  const prior = process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
  try {
    process.env.SKU_VISUAL_MATCH_CACHE_ENABLED = 'off';
    assert.strictEqual(isVisualMatchCacheEnabled(), false);
  } finally {
    if (prior === undefined) delete process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
    else process.env.SKU_VISUAL_MATCH_CACHE_ENABLED = prior;
  }
});

check('A7 isVisualMatchCacheEnabled "TRUE" → true (case-insensitive)', () => {
  const prior = process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
  try {
    process.env.SKU_VISUAL_MATCH_CACHE_ENABLED = 'TRUE';
    assert.strictEqual(isVisualMatchCacheEnabled(), true);
  } finally {
    if (prior === undefined) delete process.env.SKU_VISUAL_MATCH_CACHE_ENABLED;
    else process.env.SKU_VISUAL_MATCH_CACHE_ENABLED = prior;
  }
});

// ── Section B — cache key / roundtrip / miss ─────────────────────────

console.log('\n== B. cache set / get / miss ==');

function resetCache() {
  _visualMatchCache.clear();
}

check('B1 _cacheKey composes url + productId with `::` separator', () => {
  const k = _cacheKey('https://res.cloudinary.com/x/img.jpg', 'abc123');
  assert.strictEqual(k, 'https://res.cloudinary.com/x/img.jpg::abc123');
});

check('B2 different url/product pairs yield distinct keys', () => {
  const k1 = _cacheKey('a', 'p1');
  const k2 = _cacheKey('a', 'p2');
  const k3 = _cacheKey('b', 'p1');
  assert.notStrictEqual(k1, k2);
  assert.notStrictEqual(k1, k3);
  assert.notStrictEqual(k2, k3);
});

check('B3 _cacheGet on unseen key returns null (miss)', () => {
  resetCache();
  assert.strictEqual(_cacheGet('unseen'), null);
});

check('B4 _cacheSet + _cacheGet roundtrip returns the value', () => {
  resetCache();
  const val = { isMatch: true, score: 0.92, matchedAgainst: 'img.jpg' };
  _cacheSet('k1', val);
  assert.deepStrictEqual(_cacheGet('k1'), val);
});

check('B5 _cacheSet with null value roundtrips as null-hit (not miss)', () => {
  resetCache();
  _cacheSet('k1', null);
  // _cacheGet returns entry.value; entry.value is null. We distinguish
  // "cached null" from "miss" by checking the entry exists first.
  const raw = _visualMatchCache.get('k1');
  assert.ok(raw, 'entry should exist');
  assert.strictEqual(raw.value, null);
});

// ── Section C — TTL expiry ───────────────────────────────────────────

console.log('\n== C. TTL expiry ==');

check('C1 entry within TTL is a hit', () => {
  resetCache();
  _cacheSet('k1', { score: 1 });
  // freshly set — cachedAt is Date.now() effectively; TTL 30m
  const hit = _cacheGet('k1');
  assert.deepStrictEqual(hit, { score: 1 });
});

check('C2 entry past TTL is evicted and returns null', () => {
  resetCache();
  _cacheSet('k1', { score: 1 });
  // Rewrite cachedAt to a value beyond TTL horizon.
  const entry = _visualMatchCache.get('k1');
  entry.cachedAt = Date.now() - VISUAL_MATCH_CACHE_TTL_MS - 1;
  assert.strictEqual(_cacheGet('k1'), null);
  // And the stale entry should have been deleted, not left dangling.
  assert.strictEqual(_visualMatchCache.has('k1'), false);
});

// ── Section D — insertion-order eviction at cap ──────────────────────

console.log('\n== D. eviction at cap ==');

check('D1 eviction fires when size >= MAX (oldest entry dropped)', () => {
  resetCache();
  // Simulate cap of 3 by monkey-patching would be intrusive. Instead,
  // fill to VISUAL_MATCH_CACHE_MAX and one more, assert the FIRST key
  // is gone. Keep the load small by keying with sequential ints.
  const cap = VISUAL_MATCH_CACHE_MAX;
  for (let i = 0; i < cap; i++) _cacheSet(`k${i}`, { score: i });
  assert.strictEqual(_visualMatchCache.size, cap);
  _cacheSet('overflow', { score: -1 });
  assert.strictEqual(_visualMatchCache.size, cap);
  // The first-inserted key should have been evicted.
  assert.strictEqual(_visualMatchCache.has('k0'), false);
  assert.strictEqual(_visualMatchCache.has('overflow'), true);
});

check('D2 eviction preserves the most-recent entries', () => {
  resetCache();
  const cap = VISUAL_MATCH_CACHE_MAX;
  for (let i = 0; i < cap; i++) _cacheSet(`k${i}`, { score: i });
  _cacheSet('newest', { score: -1 });
  // The last cap-1 keys plus the newest should all still be present.
  for (let i = 1; i < cap; i++) {
    assert.strictEqual(_visualMatchCache.has(`k${i}`), true,
      `expected k${i} to remain after single-overflow eviction`);
  }
});

// ── Section E — stats introspection ──────────────────────────────────

console.log('\n== E. stats ==');

check('E1 visualMatchCacheStats returns { size, hits, misses }', () => {
  resetCache();
  const s = visualMatchCacheStats();
  assert.ok(typeof s === 'object' && s !== null);
  assert.ok('size' in s);
  assert.ok('hits' in s);
  assert.ok('misses' in s);
});

check('E2 visualMatchCacheStats reports current cache size', () => {
  resetCache();
  _cacheSet('a', { score: 1 });
  _cacheSet('b', { score: 2 });
  assert.strictEqual(visualMatchCacheStats().size, 2);
});

// ── Section F — structural pins on compareUgcCropToCatalogProduct ───

console.log('\n== F. structural pins on compareUgcCropToCatalogProduct ==');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'productMatchService.js'),
  'utf8'
);

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  // Walk the parameter list first — its own destructured `{ brandId }` /
  // default values would otherwise fool a naive brace-matcher into
  // treating the params object as the body. Find the `)` that closes
  // the param list, THEN scan for the body `{`.
  let parenDepth = 0;
  let bodyOpen = -1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '(') parenDepth++;
    else if (c === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        bodyOpen = source.indexOf('{', i);
        break;
      }
    }
  }
  if (bodyOpen === -1) throw new Error(`no body open for ${name}`);
  let depth = 0;
  for (let i = bodyOpen; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const fnSrc = extractFunction(src, 'compareUgcCropToCatalogProduct');

check('F1 function reads cacheEnabled from isVisualMatchCacheEnabled()', () => {
  assert.match(fnSrc, /isVisualMatchCacheEnabled\s*\(\s*\)/);
});

check('F2 function calls _cacheKey(ugcCropImageUrl, productKey)', () => {
  assert.match(fnSrc, /_cacheKey\s*\(\s*ugcCropImageUrl\s*,\s*productKey\s*\)/);
});

check('F3 function calls _cacheGet to check for a hit', () => {
  assert.match(fnSrc, /_cacheGet\s*\(\s*cacheKey\s*\)/);
});

check('F4 function increments _visualMatchCacheHits on hit', () => {
  assert.match(fnSrc, /_visualMatchCacheHits\+\+/);
});

check('F5 function increments _visualMatchCacheMisses on miss', () => {
  assert.match(fnSrc, /_visualMatchCacheMisses\+\+/);
});

// Count _cacheSet calls in the function — must be at least 3 (batch
// success, serial return, empty-targets guard). If any future refactor
// drops one of these, the harness fails so the cache silently going
// half-populated is caught before ship.
check('F6 function calls _cacheSet at ≥ 3 return points', () => {
  const setCalls = (fnSrc.match(/_cacheSet\s*\(/g) || []).length;
  assert.ok(setCalls >= 3,
    `expected at least 3 _cacheSet calls (batch, serial, empty-targets); got ${setCalls}`);
});

check('F7 batch-success branch caches best before returning', () => {
  // Match the sequence: if (best) { if (cacheKey) _cacheSet(...); return best; }
  assert.match(
    fnSrc,
    /if\s*\(\s*best\s*\)\s*\{[^}]*_cacheSet\s*\(\s*cacheKey\s*,\s*best\s*\)[^}]*return\s+best/s
  );
});

check('F8 serial branch caches best before final return', () => {
  // The tail of the function — the fall-through serial path — must
  // cache before returning best. Grab the LAST return-best block.
  const tail = fnSrc.slice(fnSrc.lastIndexOf('const results = await Promise.all'));
  assert.match(tail, /_cacheSet\s*\(\s*cacheKey\s*,\s*best\s*\)/);
  assert.match(tail, /return\s+best\s*;\s*\}$/s);
});

check('F9 empty-targets guard caches null before early return', () => {
  assert.match(
    fnSrc,
    /if\s*\(\s*!\s*targets\.length\s*\)\s*\{[^}]*_cacheSet\s*\(\s*cacheKey\s*,\s*null\s*\)[^}]*return\s+null/s
  );
});

// ── Section G — defaults.env commits the shipped values ──────────────

console.log('\n== G. defaults.env commits the shipped values ==');

const defaults = fs.readFileSync(
  path.join(__dirname, '..', 'config', 'defaults.env'),
  'utf8'
);

check('G1 SKU_VISUAL_MATCH_CACHE_ENABLED=true in defaults.env', () => {
  assert.match(defaults, /^SKU_VISUAL_MATCH_CACHE_ENABLED=true$/m);
});

check('G2 SKU_VISUAL_MATCH_CACHE_MAX=500 in defaults.env', () => {
  assert.match(defaults, /^SKU_VISUAL_MATCH_CACHE_MAX=500$/m);
});

check('G3 SKU_VISUAL_MATCH_CACHE_TTL_MS=1800000 in defaults.env', () => {
  assert.match(defaults, /^SKU_VISUAL_MATCH_CACHE_TTL_MS=1800000$/m);
});

// ── Summary ──────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter(r => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
