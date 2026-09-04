#!/usr/bin/env node
// Offline pins for src/services/videoReferenceResolver.js — the cache-first
// helper every video-model ref path (adgen direct-Gemini gemini-omni-1.1-flash,
// Atlas Omni, Veo 3.1 preview) should call to resolve a Media doc + target
// aspect to a public HTTP URL.
//
// The real defect this file pins is the SILENT drift class: a resolver
// that computed a WRONG aspect key would miss the cache on every call
// and silently reroute every reference through the c_fill fallback,
// throwing away the DINO-derived subject preservation without ever
// throwing. Section B is the load-bearing part.
//
// Runs zero DB / zero network. Every fixture is a plain object shaped
// like a Mongoose .lean() result.

'use strict';

const assert = require('assert');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const {
  resolveVideoReferenceForMedia,
  mediaAspectKey
} = require('../src/services/videoReferenceResolver');

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

// ── Section A — mediaAspectKey normalisation ─────────────────────────
//
// Byte-identical to the aspectKey computation in
// atlasVideoService.reframeReferenceForAspect. A mismatch here would
// key the resolver's read to a field the writer never wrote — silent
// 100% cache miss.

console.log('\n== A. mediaAspectKey ==');

check('A1 "9:16" → "9_16"',   () => assert.strictEqual(mediaAspectKey('9:16'), '9_16'));
check('A2 "16:9" → "16_9"',   () => assert.strictEqual(mediaAspectKey('16:9'), '16_9'));
check('A3 "4:5" → "4_5"',     () => assert.strictEqual(mediaAspectKey('4:5'),  '4_5'));
check('A4 "1:1" → "1_1"',     () => assert.strictEqual(mediaAspectKey('1:1'),  '1_1'));
check('A5 "1.91:1" → "1_91_1"',() => assert.strictEqual(mediaAspectKey('1.91:1'), '1_91_1'));
check('A6 null → ""',          () => assert.strictEqual(mediaAspectKey(null), ''));
check('A7 undefined → ""',     () => assert.strictEqual(mediaAspectKey(undefined), ''));
check('A8 empty string → ""',  () => assert.strictEqual(mediaAspectKey(''), ''));

// ── Section B — cache-hit path serves the persisted URL ──────────────

console.log('\n== B. cache hits return the persisted URL as-is ==');

// Simulate a real persisted reframe entry — source-native pad on the
// 9:16 hero. Matches the exact shape persistReframe writes.
const HERO_PAD_URL = 'https://res.cloudinary.com/reach-social-prod/image/upload/b_rgb:ffffff,c_pad,w_2000,h_3556,f_jpg,q_auto:good/v1788358689/catalog-product/x/hero.jpg';
const ALT_CROP_URL = 'https://res.cloudinary.com/reach-social-prod/image/upload/c_crop,w_1125,h_2000,x_438,y_0,f_jpg,q_auto:good/v1788358690/catalog-product/x/alt.jpg';

function makeMediaWithReframe({ aspectKey, url, method = 'pad-product-only', ladderVersion = 'reframe-v2' } = {}) {
  return {
    _id: 'fixture-media-abc',
    fileUrl: 'https://res.cloudinary.com/reach-social-prod/image/upload/v1788358689/catalog-product/x/hero.jpg',
    metadata: {
      reframes: { [aspectKey]: { url, method, ladderVersion, at: '2026-09-03T18:00:00.000Z' } }
    }
  };
}

check('B1 9:16 cache hit returns the pad URL verbatim', () => {
  const media = makeMediaWithReframe({ aspectKey: '9_16', url: HERO_PAD_URL });
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.url, HERO_PAD_URL);
  assert.strictEqual(r.source, 'reframe-cache');
  assert.strictEqual(r.aspectKey, '9_16');
  assert.strictEqual(r.method, 'pad-product-only');
  assert.strictEqual(r.ladderVersion, 'reframe-v2');
});

check('B2 16:9 cache hit returns the persisted URL (aspect key crosses the ":" boundary)', () => {
  const url = 'https://res.cloudinary.com/reach-social-prod/image/upload/b_rgb:ffffff,c_pad,w_2229,h_1254,f_jpg,q_auto:good/v1788358900/catalog-product/x/hero.png';
  const media = makeMediaWithReframe({ aspectKey: '16_9', url, method: 'pad-product-only', ladderVersion: 'reframe-v2' });
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '16:9', brand: null });
  assert.strictEqual(r.url, url);
  assert.strictEqual(r.source, 'reframe-cache');
  assert.strictEqual(r.aspectKey, '16_9');
});

check('B3 yolo-crop cache hit surfaces method + ladderVersion for logging', () => {
  const media = makeMediaWithReframe({ aspectKey: '9_16', url: ALT_CROP_URL, method: 'yolo-crop-forced', ladderVersion: 'reframe-v2' });
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.method, 'yolo-crop-forced');
  assert.strictEqual(r.ladderVersion, 'reframe-v2');
});

check('B4 preferReframe:false skips the cache even when it holds a URL', () => {
  const media = makeMediaWithReframe({ aspectKey: '9_16', url: HERO_PAD_URL });
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null, preferReframe: false });
  assert.strictEqual(r.source, 'c-fill-fallback');
  assert.match(r.url, /c_fill/);
});

// ── Section C — cache-miss fall-through to c_fill,g_auto ─────────────

console.log('\n== C. cache misses fall through to c_fill,g_auto ==');

check('C1 empty reframes → c_fill fallback', () => {
  const media = { _id: 'x', fileUrl: 'https://res.cloudinary.com/reach-social-prod/image/upload/v1/catalog-product/x/y.jpg', metadata: { reframes: {} } };
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.source, 'c-fill-fallback');
  assert.match(r.url, /c_fill,w_720,h_1280,g_auto/);
  assert.strictEqual(r.aspectKey, '9_16');
});

check('C2 missing metadata → c_fill fallback', () => {
  const media = { _id: 'x', fileUrl: 'https://res.cloudinary.com/reach-social-prod/image/upload/v1/y.jpg' };
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16' });
  assert.strictEqual(r.source, 'c-fill-fallback');
  assert.match(r.url, /c_fill/);
});

check('C3 media without _id → c_fill fallback (no key to lookup)', () => {
  const media = { fileUrl: 'https://res.cloudinary.com/reach-social-prod/image/upload/v1/y.jpg', metadata: { reframes: { '9_16': { url: HERO_PAD_URL } } } };
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16' });
  assert.strictEqual(r.source, 'c-fill-fallback');
});

check('C4 wrong aspect key on media → c_fill fallback (cache miss)', () => {
  const media = makeMediaWithReframe({ aspectKey: '16_9', url: HERO_PAD_URL });
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16' });
  assert.strictEqual(r.source, 'c-fill-fallback');
});

check('C5 null media → c_fill fallback returns null (no source URL)', () => {
  const r = resolveVideoReferenceForMedia({ media: null, aspectRatio: '9:16' });
  assert.strictEqual(r.source, 'c-fill-fallback');
  assert.strictEqual(r.url, null);
});

check('C6 non-Cloudinary source → passthrough (cropImageUrlForAspect returns input untouched)', () => {
  const media = { _id: 'x', fileUrl: 'https://cdn.shopify.com/x/y.jpg', metadata: { reframes: {} } };
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16' });
  assert.strictEqual(r.source, 'c-fill-fallback');
  assert.strictEqual(r.url, 'https://cdn.shopify.com/x/y.jpg');
});

// ── Section D — the drift class this helper exists to eliminate ──────
//
// Pin the exact aspectKey the writer stores vs the resolver reads. A
// resolver bug that computed a slightly different key (e.g., dropped the
// underscore, kept ':' verbatim, lowercased differently) would silently
// miss every cache entry — no error, no log, 100% c_fill fallback.

console.log('\n== D. writer/reader key parity ==');

check('D1 resolver reads the same key persistReframe writes', () => {
  // Real fixture: media doc's reframes keys as written by persistReframe
  // in atlasVideoService.js — the aspectKey normalisation lives there.
  // A drift here means the resolver would look for the WRONG key.
  const persistWriterKey = '9_16'; // what persistReframe stores
  const resolverReaderKey = mediaAspectKey('9:16'); // what resolver computes
  assert.strictEqual(resolverReaderKey, persistWriterKey);
});

check('D2 resolver reads the same key persistReframe writes (16:9)', () => {
  assert.strictEqual(mediaAspectKey('16:9'), '16_9');
});

check('D3 resolver reads the same key persistReframe writes (4:5)', () => {
  assert.strictEqual(mediaAspectKey('4:5'), '4_5');
});

check('D4 resolver reads the same key persistReframe writes (1.91:1)', () => {
  assert.strictEqual(mediaAspectKey('1.91:1'), '1_91_1');
});

// ── Section E — on-demand DINO crop on cache miss ────────────────────
//
// The reason this tier exists (see the resolver's header): prewarm and
// render can pick DIFFERENT seed sets. The prewarm's rank-based top-3
// warms one triplet; the render's operator picks (or a differently
// ranked triplet) can reach for a seed the prewarm didn't touch. Before
// this tier, that seed collapsed to Cloudinary's `c_fill,g_auto`
// saliency crop, silently throwing away the subject-preservation
// guarantee the master paid for.
//
// Live incident 2026-09-04 run run_1788537786429_3f81190c: hero (feed 0)
// + alt (feed 1) + alt (feed 2) were the operator picks; prewarm had
// warmed feed 0 / feed 2 / feed 5 (rank-based). Feed 1 had
// refinedProducts populated but no cache entry → resolver emitted
// c_fill. This section pins that the on-demand tier now catches that
// exact class of miss and returns a subject-centred c_crop URL derived
// live from chooseStrategy.

console.log('\n== E. on-demand DINO crop when cache misses ==');

// Fixture 1 — a well-fitting subject: source 2000x2000, bbox
// (163,352)-(1242,1915). Same shape as feed-2 in the live incident, which
// chooseStrategy resolves to yolo-crop @ 9:16 (window 1125x2000, x=140).
const CATALOG_URL_SMALL = 'https://res.cloudinary.com/reach-social-prod/image/upload/v1788389298/catalog-product/x/small-subject.jpg';
function makeMediaSmallSubject() {
  return {
    _id: 'fixture-small-subject',
    fileUrl: CATALOG_URL_SMALL,
    width: 2000,
    height: 2000,
    metadata: { reframes: {} }, // cache empty on purpose
    refinedProducts: [
      { label: 'Test Product', x1: 163, y1: 352, x2: 1242, y2: 1915, confidence: 0.5 }
    ]
  };
}

// Fixture 2 — a subject that EXCEEDS the tolerance in the constrained
// dimension: source 2000x2000, bbox (289,459)-(1835,1606). Same shape as
// feed-1 in the live incident. subject width 1546 > 1125 (9:16 window
// width) beyond 10% tolerance → chooseStrategy returns method
// 'yolo-crop-forced' when COMPOSITE_MASK_METHOD=force-crop (the default).
const CATALOG_URL_WIDE = 'https://res.cloudinary.com/reach-social-prod/image/upload/v1788389297/catalog-product/x/wide-subject.jpg';
function makeMediaWideSubject() {
  return {
    _id: 'fixture-wide-subject',
    fileUrl: CATALOG_URL_WIDE,
    width: 2000,
    height: 2000,
    metadata: { reframes: {} },
    refinedProducts: [
      { label: 'Test Product', x1: 289, y1: 459, x2: 1835, y2: 1606, confidence: 0.44 }
    ]
  };
}

// Sanity-check the chooseStrategy shape we expect — if the strategy
// return contract changes, the tier-2 branch of the resolver would need
// updating with it. Anchor the harness to the real function's output so
// a silent contract drift fails a check here rather than shipping a
// mis-shaped URL.
const { chooseStrategy } = require('../src/services/reframeStrategyChooser');

check('E1 cache miss + fitting subject → on-demand-yolo (crop URL from chooseStrategy)', () => {
  const media = makeMediaSmallSubject();
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.source, 'on-demand-yolo', `source: ${r.source}`);
  assert.strictEqual(r.method, 'yolo-crop');
  assert.strictEqual(r.aspectKey, '9_16');
  // URL is the deterministic c_crop pointing at the subject-centred window
  // — includes c_crop directive and does NOT include c_fill (the fallback
  // marker).
  assert.match(r.url, /\/image\/upload\/c_crop,w_1125,h_2000,/, `url: ${r.url}`);
  assert.doesNotMatch(r.url, /c_fill/, 'must not fall back to c_fill');
});

check('E2 on-demand URL is byte-identical to a direct chooseStrategy call', () => {
  const media = makeMediaSmallSubject();
  const direct = chooseStrategy({ media, aspectRatio: '9:16', sourceUrl: media.fileUrl });
  assert.strictEqual(direct.action, 'crop', 'chooseStrategy contract: action should be crop');
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.url, direct.url, 'resolver on-demand URL must equal chooseStrategy URL');
  assert.strictEqual(r.method, direct.method, 'resolver on-demand method must equal chooseStrategy method');
});

check('E3 cache miss + wide subject → yolo-crop-forced (edges clipped, still $0)', () => {
  const media = makeMediaWideSubject();
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.source, 'on-demand-yolo');
  assert.strictEqual(r.method, 'yolo-crop-forced', `method: ${r.method}`);
  assert.match(r.url, /\/image\/upload\/c_crop,w_1125,h_2000,/);
});

check('E4 cache miss + NO refinedProducts → c_fill (no bboxes to work with)', () => {
  const media = {
    _id: 'fixture-no-bboxes',
    fileUrl: CATALOG_URL_SMALL,
    width: 2000,
    height: 2000,
    metadata: { reframes: {} }
    // no refinedProducts
  };
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.source, 'c-fill-fallback');
  assert.strictEqual(r.method, null);
  assert.match(r.url, /c_fill,w_720,h_1280,g_auto/);
});

check('E5 cache miss + bboxes but NO width/height → c_fill (chooseStrategy defers "source dims unknown")', () => {
  // The exact class of media that would slip through: refinedProducts
  // populated by detect, but the dims backfill never ran. tier 2 defers
  // and we correctly ship c_fill rather than emit a garbage crop.
  const media = {
    _id: 'fixture-no-dims',
    fileUrl: CATALOG_URL_SMALL,
    metadata: { reframes: {} },
    refinedProducts: [
      { label: 'Test Product', x1: 163, y1: 352, x2: 1242, y2: 1915, confidence: 0.5 }
    ]
  };
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.source, 'c-fill-fallback');
});

check('E6 preferReframe:false skips BOTH cache AND on-demand (debug arm)', () => {
  // The debug arm is used for A/B comparison — it deliberately emits the
  // c_fill baseline even when we could compute a subject-centred crop, so
  // the two arms are actually comparable.
  const media = makeMediaSmallSubject();
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null, preferReframe: false });
  assert.strictEqual(r.source, 'c-fill-fallback');
  assert.match(r.url, /c_fill/);
});

check('E7 non-Cloudinary source + bboxes → c_fill (chooseStrategy defers, buildCloudinaryCropUrl returns null)', () => {
  // A Shopify CDN source can't be transformed by inserting a c_crop
  // segment — chooseStrategy returns action:'defer' via
  // buildCloudinaryCropUrl's Cloudinary-only guard. Correct behaviour: fall
  // through to c_fill (which is also a passthrough for non-Cloudinary).
  const media = {
    _id: 'fixture-shopify',
    fileUrl: 'https://cdn.shopify.com/x/y.jpg',
    width: 2000,
    height: 2000,
    metadata: { reframes: {} },
    refinedProducts: [
      { label: 'Test Product', x1: 163, y1: 352, x2: 1242, y2: 1915, confidence: 0.5 }
    ]
  };
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.source, 'c-fill-fallback');
  assert.strictEqual(r.url, 'https://cdn.shopify.com/x/y.jpg');
});

check('E8 cache HIT takes precedence over on-demand (tier order is 1 → 2 → 3, not reversed)', () => {
  // Same media as E1 but with a cache entry — cache should win, on-demand
  // never runs. A regression that swapped tier order would waste
  // computation and diverge from the persisted decision.
  const media = makeMediaSmallSubject();
  const CACHED = HERO_PAD_URL;
  media.metadata.reframes = { '9_16': { url: CACHED, method: 'pad-product-only', ladderVersion: 'reframe-v2' } };
  const r = resolveVideoReferenceForMedia({ media, aspectRatio: '9:16', brand: null });
  assert.strictEqual(r.source, 'reframe-cache', 'cache must win over on-demand');
  assert.strictEqual(r.url, CACHED);
  assert.strictEqual(r.method, 'pad-product-only');
});

// ── Summary ──────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter(r => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
