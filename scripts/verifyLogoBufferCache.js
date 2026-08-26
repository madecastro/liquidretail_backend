'use strict';
// Pins the per-process logo buffer cache added to directImageRenderService
// on 2026-08-26. Phase 2 of the wall-time reduction plan — third ship
// (after quoteSnippet L2 cache, before Director batching investigation).
//
// Context. optionalImage fires a fresh axios GET on every ad. For a 9-ad
// Pelagic Gear batch on a single brand, the SAME logo URL was fetched 9
// times × ~300-700ms each = ~3-6 seconds of pure duplicate HTTP time per
// run. The fix wraps the LOGO call site in a URL-keyed LRU that caches
// the RAW fetched buffer; each ad still does its own Sharp resize because
// delivery dims vary per format.
//
// SCOPE-CONTROLLED: only the corner-logomark call site is wired. Product
// reference fetches at 2364 and 2573 in the same file are UNCACHED on
// purpose — their working set is unbounded and per-ad, so a cache there
// would just add memory pressure without a repeated-URL benefit.

const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const svcSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'directImageRenderService.js'), 'utf8');

// ── A. Helpers exist and have expected shape ────────────────────────────
check('A1: optionalImageCached function defined',
  /async function optionalImageCached\(url\)/.test(svcSrc));
check('A2: _logoCache Map exists',
  /const _logoCache\s*=\s*new Map\(\)/.test(svcSrc));
check('A3: LOGO_CACHE_CAP is env-configurable (default 32)',
  /LOGO_CACHE_CAP[\s\S]*?\|\|\s*32/.test(svcSrc));
check('A4: LOGO_CACHE_TTL_MS is env-configurable (default 1 hour)',
  /LOGO_CACHE_TTL_MS[\s\S]*?\|\|\s*60\s*\*\s*60\s*\*\s*1000/.test(svcSrc));
check('A5: _logoCacheGet function exists',
  /function _logoCacheGet\(url\)/.test(svcSrc));
check('A6: _logoCacheSet function exists',
  /function _logoCacheSet\(url,\s*buf\)/.test(svcSrc));

// ── B. LRU discipline ───────────────────────────────────────────────────
const getFn = svcSrc.match(/function _logoCacheGet\([\s\S]*?\n\}/);
check('B1: _logoCacheGet body found', !!getFn);
if (getFn) {
  const body = getFn[0];
  check('B2: _logoCacheGet expires stale entries (TTL enforcement)',
    /Date\.now\(\)\s*>=?\s*entry\.expiresAt/.test(body) && /_logoCache\.delete\(url\)/.test(body));
  check('B3: _logoCacheGet refreshes LRU order (delete + set at tail)',
    /_logoCache\.delete\(url\)[\s\S]*?_logoCache\.set\(url,\s*entry\)/.test(body));
}

const setFn = svcSrc.match(/function _logoCacheSet\([\s\S]*?\n\}/);
check('B4: _logoCacheSet body found', !!setFn);
if (setFn) {
  const body = setFn[0];
  check('B5: _logoCacheSet evicts oldest when over cap',
    /while\s*\(_logoCache\.size\s*>\s*LOGO_CACHE_CAP\)/.test(body));
  check('B6: _logoCacheSet stamps expiresAt (Date.now() + TTL)',
    /expiresAt:\s*Date\.now\(\)\s*\+\s*LOGO_CACHE_TTL_MS/.test(body));
}

// ── C. Wire-in at the logo composite site ──────────────────────────────
// The main composite is around line 2135-2145 (logo → sharp resize).
// Only ONE call site should use optionalImageCached — the corner-logomark
// one. Reference/product fetches must stay on the plain optionalImage.
// Count CALL sites (excluding the function declaration itself).
const cachedCallSites = (svcSrc.match(/\bawait optionalImageCached\(/g) || []).length;
check('C1: optionalImageCached invoked exactly once via await (logo site only)',
  cachedCallSites === 1, `got ${cachedCallSites} call sites`);

const uncachedCalls = (svcSrc.match(/optionalImage\((?!Cached)/g) || []).length;
// The definition line itself matches `optionalImage(` — subtract expected
// plumbing. Rough sanity: 2 product-ref call sites should still exist.
check('C2: plain optionalImage still called for non-logo fetches (product refs)',
  uncachedCalls >= 2, `found ${uncachedCalls} plain optionalImage references`);

// ── D. optionalImageCached delegates to optionalImage on miss ──────────
const cachedFn = svcSrc.match(/async function optionalImageCached\([\s\S]*?\n\}/);
check('D1: optionalImageCached body found', !!cachedFn);
if (cachedFn) {
  const body = cachedFn[0];
  check('D2: null url short-circuits (no cache entry stored)',
    /if\s*\(!url\)\s*return\s+null/.test(body));
  check('D3: cache hit returns without calling optionalImage',
    /const hit = _logoCacheGet\(url\)[\s\S]*?if\s*\(hit\)\s*return\s+hit/.test(body));
  check('D4: cache miss delegates to plain optionalImage (fail-open, same behaviour)',
    /await optionalImage\(url\)/.test(body));
  check('D5: only successful fetches (non-null buf) get cached',
    /if\s*\(buf\)\s*_logoCacheSet\(url,\s*buf\)/.test(body));
}

// ── E. Revert-proofs ───────────────────────────────────────────────────
// Removing the call-site swap → C1 must fail.
const strippedCall = svcSrc.replace(/await optionalImageCached\(logoUrl\)/, 'await optionalImage(logoUrl)');
check('E1: [REVERT-PROOF] reverting the logo-site call defeats C1',
  (strippedCall.match(/\bawait optionalImageCached\(/g) || []).length === 0);

// Removing the LRU eviction → B5 must fail.
if (setFn) {
  const strippedEvict = setFn[0].replace(/while[\s\S]*?_logoCache\.delete\(oldest\);?\s*\}/, '');
  check('E2: [REVERT-PROOF] removing eviction defeats B5',
    !/while\s*\(_logoCache\.size\s*>\s*LOGO_CACHE_CAP\)/.test(strippedEvict));
}

// ── report ─────────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\nverifyLogoBufferCache: ${passes.length} pass, ${failures.length} fail`);
  process.exit(1);
}
for (const p of passes) console.log(`  ✓ ${p}`);
console.log(`\n✅ verifyLogoBufferCache: ${passes.length}/${passes.length} checks passed`);
