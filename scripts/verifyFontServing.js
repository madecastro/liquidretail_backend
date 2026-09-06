#!/usr/bin/env node
'use strict';
/**
 * verifyFontServing — offline guard for Remotion font asset routing + soft-load.
 *
 * WHY THIS EXISTS
 * Every video render died for library-match brands. Chain (verified):
 *   1. library-match Inter → localPath = FONTS_DIR/Inter.ttf
 *      (fontResolverService.js:279, fontLoader.js:31)
 *   2. fontsToUrls rewrote to ${base}/fonts/<basename> which assetPathFor
 *      maps ONLY to FONT_CACHE_DIR (webfonts/) → 404
 *   3. 404 branch set no CORS → FontFace "A network error occurred"
 *   4. @remotion/fonts loadFont catch calls cancelRender() — unrecoverable;
 *      FontLoader's outer .catch was a false safety net
 *
 * REVERT MAP (which checks fail if each part is undone):
 *   (1) FontLoader reverts to `import { loadFont } from '@remotion/fonts'`
 *       → F1 fails (fatal-import pin)
 *   (2) dual-route /libfonts removed (fontsToUrls always /fonts, no libfonts base)
 *       → L1/L2/L3 and S1 fail; G1/G2 may still pass
 *   (3) CORS dropped from 404 writeHead
 *       → C1 fails (source pin on 404 branch)
 *   (4) traversal guard weakened / removed for a base
 *       → T* for that base fails
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyFontServing.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const ROOT = path.join(__dirname, '..');
const { FONTS_DIR } = require('../services/fontLoader');
const { FONT_CACHE_DIR } = require('../services/fontResolverService');
const {
  assetPathFor,
  fontRouteForLocalPath,
  fontsToUrls,
} = require('../services/remotionRenderService');

const BASE = 'http://127.0.0.1:9';
const libInter = path.join(FONTS_DIR, 'Inter.ttf');
const cacheInter = path.join(FONT_CACHE_DIR, 'Inter.ttf');
// Distinct basename under cache so we also cover non-colliding google files.
const cacheWoff2 = path.join(FONT_CACHE_DIR, 'brand-abc-inter-400-v1.woff2');

console.log('\nverifyFontServing — dual-route fonts + non-fatal FontLoader\n');
console.log(`  FONTS_DIR       = ${FONTS_DIR}`);
console.log(`  FONT_CACHE_DIR  = ${FONT_CACHE_DIR}\n`);

// ── L. library-match → /libfonts → FONTS_DIR ──────────────────────────────
// Fails if dual-route (2) is reverted.
check('L1 library-match localPath routes to libfonts', () => {
  assert.strictEqual(fontRouteForLocalPath(libInter), 'libfonts');
});
check('L2 /libfonts/Inter.ttf resolves into FONTS_DIR', () => {
  const abs = assetPathFor('/libfonts/Inter.ttf');
  assert.strictEqual(abs, libInter);
  assert.ok(abs.startsWith(FONTS_DIR + path.sep), `expected under FONTS_DIR, got ${abs}`);
});
check('L3 fontsToUrls(library localPath) emits /libfonts/ URL', () => {
  const out = fontsToUrls({ heading: { family: 'Inter', url: libInter, source: 'library-match' } }, BASE);
  assert.strictEqual(out.heading.url, `${BASE}/libfonts/${encodeURIComponent('Inter.ttf')}`);
});

// ── G. google/custom → /fonts → FONT_CACHE_DIR (non-regression) ───────────
check('G1 google localPath routes to fonts', () => {
  assert.strictEqual(fontRouteForLocalPath(cacheWoff2), 'fonts');
  assert.strictEqual(fontRouteForLocalPath(cacheInter), 'fonts');
});
check('G2 /fonts/<file> resolves into FONT_CACHE_DIR', () => {
  const abs = assetPathFor('/fonts/brand-abc-inter-400-v1.woff2');
  assert.strictEqual(abs, cacheWoff2);
  assert.ok(abs.startsWith(FONT_CACHE_DIR + path.sep));
});
check('G3 fontsToUrls(google localPath) emits /fonts/ URL', () => {
  const out = fontsToUrls({ body: { family: 'Inter', url: cacheWoff2, source: 'google' } }, BASE);
  assert.strictEqual(out.body.url, `${BASE}/fonts/${encodeURIComponent('brand-abc-inter-400-v1.woff2')}`);
});

// ── S. identical basenames do not shadow ──────────────────────────────────
// Inter.ttf can exist in BOTH dirs; route must disambiguate by directory.
check('S1 same basename under both dirs maps to different abs paths', () => {
  const fromLib = assetPathFor('/libfonts/Inter.ttf');
  const fromCache = assetPathFor('/fonts/Inter.ttf');
  assert.strictEqual(fromLib, libInter);
  assert.strictEqual(fromCache, cacheInter);
  assert.notStrictEqual(fromLib, fromCache);
});
check('S2 fontsToUrls chooses route by localPath dir, not basename', () => {
  const both = fontsToUrls({
    heading: { family: 'Inter', url: libInter },
    body: { family: 'Inter', url: cacheInter },
  }, BASE);
  assert.ok(both.heading.url.includes('/libfonts/'), both.heading.url);
  assert.ok(both.body.url.includes('/fonts/'), both.body.url);
  assert.notStrictEqual(both.heading.url, both.body.url);
});

// ── T. traversal rejected for EVERY base ──────────────────────────────────
// Fails if traversal guard (assetPathFor startsWith) is removed/weakened.
const TRAVERSAL_CASES = [
  '/fonts/../secret',
  '/fonts/%2e%2e%2fsecret',
  '/fonts/foo/../../etc/passwd',
  '/libfonts/../secret',
  '/libfonts/%2e%2e%2fsecret',
  '/libfonts/foo/../../etc/passwd',
  '/jobs/../secret',
  '/jobs/%2e%2e%2fsecret',
];
for (const p of TRAVERSAL_CASES) {
  check(`T reject ${p}`, () => {
    const abs = assetPathFor(p);
    // Either null, or (if normalize collapses the head) still not outside a base.
    // The production guard returns null when join escapes; assert null.
    assert.strictEqual(abs, null, `expected null, got ${abs}`);
  });
}
// Positive control: a normal nested job path still works (jobs base lives under tmp).
check('T control /jobs/<id>/plate.mp4 is accepted (under ASSET_ROOT)', () => {
  const abs = assetPathFor('/jobs/abc123/plate.mp4');
  assert.ok(abs, 'expected a path');
  assert.ok(abs.endsWith(path.join('abc123', 'plate.mp4')), abs);
});

// ── C. CORS on 404 path (source pin) ──────────────────────────────────────
// Fails if (3) is reverted.
check('C1 404 writeHead includes Access-Control-Allow-Origin', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/remotionRenderService.js'), 'utf8');
  // Narrow window: the !stat || !stat.isFile() branch must set CORS on writeHead(404).
  const m = /if\s*\(\s*!stat\s*\|\|\s*!stat\.isFile\(\)\s*\)\s*\{([\s\S]*?)return;/.exec(src);
  assert.ok(m, 'could not find 404 branch in remotionRenderService.js');
  assert.ok(
    /writeHead\(\s*404\s*,\s*\{[^}]*Access-Control-Allow-Origin/.test(m[1]),
    '404 branch missing CORS header object on writeHead'
  );
});

// ── F. FontLoader must NOT import @remotion/fonts loadFont ────────────────
// Fails if (1) is reverted — this is the fatal cancelRender regression pin.
// Also pins the delayRender lifecycle (Finding 2) and settle-before-release
// order (Finding 3) so a "looks safe" rewrite that continues before loads
// settle, or reintroduces a sticky useState handle, cannot pass.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

check('F1 FontLoader.jsx does not import loadFont from @remotion/fonts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'remotion/components/FontLoader.jsx'), 'utf8');
  assert.ok(
    !/from\s+['"]@remotion\/fonts['"]/.test(src),
    'FontLoader imports @remotion/fonts — loadFont cancelRender is fatal on 404'
  );
  assert.ok(
    !/\bimport\s*\{[^}]*\bloadFont\b[^}]*\}\s*from\s*['"]@remotion\/fonts['"]/.test(src),
    'explicit loadFont import from @remotion/fonts is forbidden'
  );
  // Positive: still uses FontFace + delayRender/continueRender.
  assert.ok(/\bnew\s+FontFace\b/.test(src), 'expected direct FontFace construction');
  assert.ok(/\bdelayRender\b/.test(src) && /\bcontinueRender\b/.test(src),
    'expected delayRender/continueRender handle discipline');
  // cancelRender may appear in explanatory comments (institutional memory of
  // why @remotion/fonts is banned). Strip comments, then assert it is never
  // imported from 'remotion' and never called.
  const codeOnly = stripComments(src);
  assert.ok(
    !/\bimport\s*\{[^}]*\bcancelRender\b[^}]*\}\s*from\s*['"]remotion['"]/.test(codeOnly),
    'FontLoader must not import cancelRender from remotion'
  );
  assert.ok(
    !/\bcancelRender\s*\(/.test(codeOnly),
    'FontLoader must not call cancelRender on font failure'
  );
});

// F1b: delayRender must be created inside the effect, not sticky useState.
// A useState(() => delayRender(...)) handle is continued on first cleanup;
// a second effect run then loads against an already-continued handle and
// never delays again (StrictMode / format switch / fonts identity change).
check('F1b delayRender handle is created inside the effect (not useState)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'remotion/components/FontLoader.jsx'), 'utf8');
  const codeOnly = stripComments(src);
  assert.ok(
    !/useState\s*\(\s*\(\s*\)\s*=>\s*delayRender/.test(codeOnly),
    'sticky useState delayRender handle reintroduces the re-run miss-delay bug'
  );
  const effectBody = /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\[\s*fonts\s*\]/.exec(codeOnly);
  assert.ok(effectBody, 'could not find useEffect(() => { ... }, [fonts]) body');
  assert.ok(
    /\bdelayRender\s*\(/.test(effectBody[1]),
    'delayRender must be called inside the effect body so each run gets a fresh handle'
  );
  // continueRender only via the per-run release() — not a bare call outside it.
  assert.ok(
    /const\s+release\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?\bcontinueRender\s*\(\s*handle\s*\)/.test(effectBody[1]),
    'continueRender must live inside an idempotent release() for this run\'s handle'
  );
});

// F1c: on the success path, release is only reachable AFTER the load batch
// settles. A rewrite that does `release(); Promise.all(...)` or
// `Promise.all(...); release()` (fire-and-forget) would pass F1/F1b but
// paint frames on fallback stacks — the behaviour that actually matters.
//
// Offline limit: we cannot drive Remotion's delayRender in Node without a
// browser. This is a structural order pin on comment-stripped source, not a
// live paint test. It CAN fail (remove .then(release) or call release before
// Promise.all) — that is the bar for "a check that can fail".
check('F1c load batch settles before release on the success path', () => {
  const src = fs.readFileSync(path.join(ROOT, 'remotion/components/FontLoader.jsx'), 'utf8');
  const codeOnly = stripComments(src);
  const effectBody = /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\[\s*fonts\s*\]/.exec(codeOnly);
  assert.ok(effectBody, 'could not find useEffect body');
  const body = effectBody[1];

  // Success path: Promise.all(...loads...).then(release) — release waits.
  assert.ok(
    /Promise\.all\s*\(/.test(body),
    'expected Promise.all over the font load batch'
  );
  assert.ok(
    /Promise\.all\s*\([\s\S]*?\)\s*\.then\s*\(\s*release\s*\)/.test(body),
    'expected Promise.all(...).then(release) so release waits for every load to settle'
  );

  // Anti-pattern: a release() invocation that appears textually before
  // Promise.all, outside a function body (would fire before loads start).
  // Allow: `const release = () => { ... }` definition, and nested function
  // bodies. Flag a bare `release()` statement whose index is before Promise.all.
  const pAllIdx = body.search(/Promise\.all\s*\(/);
  assert.ok(pAllIdx >= 0, 'Promise.all not found');
  // Strip nested function/arrow bodies roughly, then look for release() calls
  // in the outer effect statements before Promise.all.
  const before = body.slice(0, pAllIdx);
  // Remove the release definition itself and any arrow/function bodies.
  const beforeOuter = before
    .replace(/const\s+release\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?\}\s*;/, '')
    .replace(/function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\}/g, '');
  assert.ok(
    !/\brelease\s*\(\s*\)/.test(beforeOuter),
    'release() must not be invoked before Promise.all starts the load batch'
  );
  // continueRender must not appear outside release (would bypass settle).
  const withoutReleaseFn = body.replace(
    /const\s+release\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?\}\s*;/,
    ''
  );
  assert.ok(
    !/\bcontinueRender\s*\(/.test(withoutReleaseFn),
    'continueRender must only appear inside release(), not as a free call'
  );
});

// ── R. dual-route present in assetPathFor + fontsToUrls (source pins) ─────
check('R1 assetPathFor handles libfonts head', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/remotionRenderService.js'), 'utf8');
  assert.ok(/head\s*===\s*['"]libfonts['"]/.test(src), 'assetPathFor missing libfonts branch');
  assert.ok(/\bFONTS_DIR\b/.test(src), 'remotionRenderService must require FONTS_DIR');
});
check('R2 fontsToUrls uses fontRouteForLocalPath', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/remotionRenderService.js'), 'utf8');
  assert.ok(/function\s+fontRouteForLocalPath\s*\(/.test(src));
  assert.ok(/fontRouteForLocalPath\s*\(\s*f\.url\s*\)/.test(src));
});

// ── D. FontFace weight descriptor STRING shape ────────────────────────────
// A variable file must register as `"min max"` so one face covers 400–900.
// Static-cut brands (no min/max) keep today's single-value string. Pin the
// shape, not merely that a weight value is present — `"700"` and `"100 900"`
// are different CSS descriptors and Chromium synthesises anything the
// registered descriptor does not cover.
{
  const { fontFaceWeightDescriptor } = require('../services/fontResolverService');
  check('D1 single-weight descriptor is the numeric string (static-cut brands)', () => {
    assert.strictEqual(fontFaceWeightDescriptor({ weight: 700 }), '700');
    assert.strictEqual(fontFaceWeightDescriptor({ weight: 400 }), '400');
    assert.strictEqual(fontFaceWeightDescriptor({ weight: '500' }), '500');
  });
  check('D2 range descriptor is "min max" when both endpoints are finite', () => {
    assert.strictEqual(
      fontFaceWeightDescriptor({ weight: 700, weightMin: 100, weightMax: 900 }),
      '100 900'
    );
    assert.strictEqual(
      fontFaceWeightDescriptor({ weight: 600, weightMin: 100, weightMax: 900 }),
      '100 900'
    );
  });
  check('D3 missing/NaN min or max falls back to the single-value string', () => {
    assert.strictEqual(fontFaceWeightDescriptor({ weight: 700, weightMin: 100 }), '700');
    assert.strictEqual(fontFaceWeightDescriptor({ weight: 700, weightMax: 900 }), '700');
    assert.strictEqual(fontFaceWeightDescriptor({ weight: 700, weightMin: null, weightMax: null }), '700');
  });
  check('D4 FontLoader.jsx uses the range form, not String(weight) alone', () => {
    const src = fs.readFileSync(path.join(ROOT, 'remotion/components/FontLoader.jsx'), 'utf8');
    const codeOnly = stripComments(src);
    assert.ok(
      /function\s+fontFaceWeightDescriptor\s*\(/.test(codeOnly),
      'FontLoader must compute the descriptor (not pass weight through raw)'
    );
    assert.ok(
      /Number\.isFinite\(\s*min\s*\)\s*&&\s*Number\.isFinite\(\s*max\s*\)/.test(codeOnly),
      'range form requires both endpoints finite'
    );
    assert.ok(
      /weightMin == null \|\| weightMin === ''/.test(codeOnly),
      'null min/max must not Number()-coerce to 0 (which isFinite)'
    );
    assert.ok(
      /`\$\{min\} \$\{max\}`/.test(codeOnly),
      'range descriptor must be the two-number string "min max"'
    );
    assert.ok(
      /weight:\s*fontFaceWeightDescriptor\s*\(/.test(codeOnly),
      'new FontFace must receive the computed descriptor, not String(weight)'
    );
  });
}

// ── summary ───────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('ok\n');
