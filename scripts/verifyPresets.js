#!/usr/bin/env node
'use strict';
/**
 * verifyPresets — offline checks for the format PRESET API.
 *
 * The preset table replaces the three-knob wizard API (platformFormat + kinds +
 * expandStaticFormats) with one operator choice. Two money-shaped invariants
 * are load-bearing:
 *
 *   1. meta_video queues exactly ONE video format (the 9:16 master). Returning
 *      the full META_VIDEO_FANOUT would queue four billable Veo submits per
 *      product; the other three sizes are Phase 3 derivations, not generations.
 *   2. coming_soon formats never appear in any resolved list, fan-out, or
 *      generatable allowlist. They are UI chrome only until they go live.
 *
 * Google is fully frozen (all coming_soon). google_static / google_video /
 * google_all resolve empty via filterLiveFormats — not a second special case.
 * google_pmax is gone (it double-spent static+video on pmax_16_9).
 *
 * 'single' must reproduce today's three-knob behaviour exhaustively for LIVE
 * formats — that is the backwards-compat proof so old callers stay
 * byte-identical on Meta.
 *
 * No DB, no network, no API keys. Run free on every edit:
 *   node scripts/verifyPresets.js
 */

const path = require('path');
const pf = require(path.join(__dirname, '..', 'services', 'platformFormats.js'));

let pass = 0;
const failures = [];
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(label, actual, expected) {
  check(`${label} → ${JSON.stringify(expected)}`, JSON.stringify(actual) === JSON.stringify(expected));
}
function setEq(label, actual, expected) {
  const a = [...(actual || [])].slice().sort();
  const e = [...(expected || [])].slice().sort();
  eq(label, a, e);
}

const META3 = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16'];
// Live Meta surfaces only — pmax_16_9 is frozen (coming_soon).
const LIVE4 = [
  'meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16', 'meta_stories_9_16'
];
const GOOGLE_PMAX_STUBS = [
  'pmax_landscape_1_91_1', 'pmax_square_1_1', 'pmax_portrait_4_5',
  'pmax_video_16_9', 'pmax_video_1_1', 'pmax_video_9_16'
];
const COMING = [
  'pmax_16_9',
  ...GOOGLE_PMAX_STUBS,
  'google_demandgen_1_1', 'google_demandgen_4_5',
  'google_demandgen_1_91_1', 'google_shorts_9_16'
];
const GOOGLE_PRESETS = ['google_static', 'google_video', 'google_all'];

// ── table shape ─────────────────────────────────────────────────────────
console.log('\nPLATFORM_FORMATS — every entry has platform + status');
for (const k of pf.PLATFORM_FORMAT_KEYS) {
  const caps = pf.PLATFORM_FORMATS[k];
  check(`  ${k}: platform is meta|google`, caps.platform === 'meta' || caps.platform === 'google');
  check(`  ${k}: status is live|coming_soon`, caps.status === 'live' || caps.status === 'coming_soon');
  check(`  ${k}: has deliveryDims`, !!caps.deliveryDims?.width && !!caps.deliveryDims?.height);
  check(`  ${k}: has aspectRatio + canvas + kinds`,
    !!caps.aspectRatio && !!caps.canvas?.width && Array.isArray(caps.kinds) && caps.kinds.length > 0);
}

console.log('\nlive formats — deliveryDims consistent with aspectRatio');
function parseAr(s) {
  const [a, b] = String(s).split(':').map(Number);
  return a / b;
}
for (const k of LIVE4) {
  const caps = pf.PLATFORM_FORMATS[k];
  const want = parseAr(caps.aspectRatio);
  const got = caps.deliveryDims.width / caps.deliveryDims.height;
  check(`  ${k}: delivery ${caps.deliveryDims.width}x${caps.deliveryDims.height} matches ${caps.aspectRatio}`,
    Math.abs(want - got) < 0.02);
  check(`  ${k}: status is live`, caps.status === 'live');
}
console.log('\nevery Google format is coming_soon');
for (const k of COMING) {
  check(`  ${k}: declared`, !!pf.PLATFORM_FORMATS[k]);
  check(`  ${k}: status is coming_soon`, pf.PLATFORM_FORMATS[k]?.status === 'coming_soon');
  check(`  ${k}: isComingSoonFormat`, pf.isComingSoonFormat(k) === true);
  check(`  ${k}: isLiveFormat is false`, pf.isLiveFormat(k) === false);
}
// PMax stubs have the published delivery dims
eq('  pmax_landscape_1_91_1 deliveryDims', pf.PLATFORM_FORMATS.pmax_landscape_1_91_1?.deliveryDims,
  { width: 1200, height: 628 });
eq('  pmax_square_1_1 deliveryDims', pf.PLATFORM_FORMATS.pmax_square_1_1?.deliveryDims,
  { width: 1200, height: 1200 });
eq('  pmax_portrait_4_5 deliveryDims', pf.PLATFORM_FORMATS.pmax_portrait_4_5?.deliveryDims,
  { width: 960, height: 1200 });
eq('  pmax_video_16_9 deliveryDims', pf.PLATFORM_FORMATS.pmax_video_16_9?.deliveryDims,
  { width: 1920, height: 1080 });
eq('  pmax_video_1_1 deliveryDims', pf.PLATFORM_FORMATS.pmax_video_1_1?.deliveryDims,
  { width: 1080, height: 1080 });
eq('  pmax_video_9_16 deliveryDims', pf.PLATFORM_FORMATS.pmax_video_9_16?.deliveryDims,
  { width: 1080, height: 1920 });
// Frozen pmax_16_9 keeps prior geometry for read paths
eq('  pmax_16_9 deliveryDims unchanged', pf.PLATFORM_FORMATS.pmax_16_9?.deliveryDims,
  { width: 1920, height: 1080 });
eq('  pmax_16_9 canvas unchanged', pf.PLATFORM_FORMATS.pmax_16_9?.canvas,
  { width: 1000, height: 563 });
eq('  pmax_16_9 kinds unchanged', pf.PLATFORM_FORMATS.pmax_16_9?.kinds, ['image', 'video']);
eq('  pmax_16_9 safeArea unchanged', pf.PLATFORM_FORMATS.pmax_16_9?.safeArea, { top: 0, bottom: 0 });

check('  LIVE_PLATFORM_FORMAT_KEYS is exactly the 4 live Meta surfaces',
  JSON.stringify([...pf.LIVE_PLATFORM_FORMAT_KEYS].sort()) === JSON.stringify([...LIVE4].sort()));
check('  no coming_soon key is in LIVE_PLATFORM_FORMAT_KEYS',
  COMING.every((k) => !pf.LIVE_PLATFORM_FORMAT_KEYS.includes(k)));
check('  every Google-platform entry is coming_soon',
  pf.PLATFORM_FORMAT_KEYS
    .filter((k) => pf.PLATFORM_FORMATS[k].platform === 'google')
    .every((k) => pf.PLATFORM_FORMATS[k].status === 'coming_soon'));

// ── named presets ───────────────────────────────────────────────────────
console.log('\nresolvePreset — named presets');
{
  const r = pf.resolvePreset('meta_static', 'meta_feed_1_1');
  setEq('  meta_static staticFormats', r.staticFormats, META3);
  eq('  meta_static videoFormats', r.videoFormats, []);
  eq('  meta_static kinds', r.kinds, ['image']);
  check('  meta_static is 3 billable image surfaces', r.staticFormats.length === 3);
  check('  meta_static has no video', r.videoFormats.length === 0 && !r.kinds.includes('video'));
}
{
  const r = pf.resolvePreset('meta_video', 'meta_feed_1_1');
  eq('  meta_video videoFormats is the ONE 9:16 master', r.videoFormats, [pf.META_VIDEO_MASTER]);
  eq('  meta_video staticFormats', r.staticFormats, []);
  eq('  meta_video kinds', r.kinds, ['video']);
  check('  MONEY: meta_video queues exactly ONE video format (not four)',
    r.videoFormats.length === 1);
  check('  MONEY: that one is not the full META_VIDEO_FANOUT',
    r.videoFormats.length !== pf.META_VIDEO_FANOUT.length);
  check('  master is a live 9:16 surface',
    pf.isLiveFormat(r.videoFormats[0]) &&
    pf.aspectRatioForPlatformFormat(r.videoFormats[0]) === '9:16');
}
{
  const r = pf.resolvePreset('meta_all', 'meta_feed_1_1');
  setEq('  meta_all staticFormats', r.staticFormats, META3);
  eq('  meta_all videoFormats is the ONE master', r.videoFormats, [pf.META_VIDEO_MASTER]);
  setEq('  meta_all kinds', r.kinds, ['image', 'video']);
  check('  meta_all still only ONE video format to queue', r.videoFormats.length === 1);
}
console.log('\nGoogle presets — all resolve empty (every Google format is coming_soon)');
for (const g of GOOGLE_PRESETS) {
  const r = pf.resolvePreset(g, 'meta_feed_1_1');
  eq(`  ${g} staticFormats`, r.staticFormats, []);
  eq(`  ${g} videoFormats`, r.videoFormats, []);
  eq(`  ${g} kinds`, r.kinds, []);
}
check('  google_pmax no longer exists', !pf.PRESETS.google_pmax && !pf.PRESET_KEYS.includes('google_pmax'));
// Intent lists exist so when Google goes live the filter flips on without a rewrite
check('  GOOGLE_STATIC_FANOUT non-empty intent', pf.GOOGLE_STATIC_FANOUT.length > 0);
check('  GOOGLE_VIDEO_FANOUT non-empty intent', pf.GOOGLE_VIDEO_FANOUT.length > 0);
check('  GOOGLE_STATIC_FANOUT every entry is image-capable Google',
  pf.GOOGLE_STATIC_FANOUT.every((k) =>
    pf.PLATFORM_FORMATS[k]?.platform === 'google' &&
    pf.kindsForPlatformFormat(k).includes('image')));
check('  GOOGLE_VIDEO_FANOUT every entry is video-capable Google',
  pf.GOOGLE_VIDEO_FANOUT.every((k) =>
    pf.PLATFORM_FORMATS[k]?.platform === 'google' &&
    pf.kindsForPlatformFormat(k).includes('video')));
// Static and video lists must not share keys (split-by-kind invariant)
check('  Google static/video lists are disjoint (no double-spend key)',
  pf.GOOGLE_STATIC_FANOUT.every((k) => !pf.GOOGLE_VIDEO_FANOUT.includes(k)));

// ── single: exhaustive backwards-compat for LIVE formats ────────────────
console.log('\nresolvePreset single — exhaustive three-knob back-compat (live Meta)');
const KIND_OPTS = [null, 'image', 'video', 'both'];
const EXPAND_OPTS = [false, true];
const PF_OPTS = [...LIVE4, 'meta_feed_1_1', null, 'not_a_format', ...COMING];

// Reproduce pre-preset expandWizardJob format resolution in pure form.
// This is the oracle: single must match it for every combination.
function oracleSingle(platformFormat, kinds, expandStaticFormats) {
  const requested = kinds == null || kinds === '' ? 'image' : kinds;
  // resolveKinds already returns [] for coming_soon / unknown
  const resolvedKinds = pf.resolveKinds(platformFormat, requested);
  const wantsImage = resolvedKinds.includes('image');
  const wantsVideo = resolvedKinds.includes('video');
  let staticFormats = [];
  if (wantsImage) {
    if (expandStaticFormats) {
      staticFormats = pf.staticFanoutForPlatformFormat(platformFormat);
    } else if (pf.isLiveFormat(platformFormat) && pf.kindsForPlatformFormat(platformFormat).includes('image')) {
      staticFormats = [platformFormat];
    }
  }
  let videoFormats = [];
  if (wantsVideo && pf.isLiveFormat(platformFormat) && pf.kindsForPlatformFormat(platformFormat).includes('video')) {
    videoFormats = [platformFormat];
  }
  staticFormats = pf.filterLiveFormats(staticFormats);
  videoFormats = pf.filterLiveFormats(videoFormats);
  const kindsOut = [];
  if (staticFormats.length && wantsImage) kindsOut.push('image');
  if (videoFormats.length && wantsVideo) kindsOut.push('video');
  return { staticFormats, videoFormats, kinds: kindsOut };
}

let singleCombos = 0;
for (const platformFormat of PF_OPTS) {
  for (const kinds of KIND_OPTS) {
    for (const expandStaticFormats of EXPAND_OPTS) {
      singleCombos++;
      const actual = pf.resolvePreset('single', platformFormat, { kinds, expandStaticFormats });
      const expected = oracleSingle(platformFormat, kinds, expandStaticFormats);
      const label = `single pf=${platformFormat} kinds=${kinds} expand=${expandStaticFormats}`;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        check(`${label}`, false);
        console.log(`      expected ${JSON.stringify(expected)}`);
        console.log(`      actual   ${JSON.stringify(actual)}`);
      } else {
        pass++;
      }
    }
  }
}
check(`  exhaustive single combos all matched (${singleCombos} cases)`, true);

// Pin human-readable single cases for the four remaining LIVE Meta formats.
eq('  single feed1:1 image no-expand',
  pf.resolvePreset('single', 'meta_feed_1_1', { kinds: 'image', expandStaticFormats: false }),
  { staticFormats: ['meta_feed_1_1'], videoFormats: [], kinds: ['image'] });
setEq('  single feed1:1 image expand static',
  pf.resolvePreset('single', 'meta_feed_1_1', { kinds: 'image', expandStaticFormats: true }).staticFormats,
  META3);
eq('  single feed4:5 image no-expand',
  pf.resolvePreset('single', 'meta_feed_4_5', { kinds: 'image', expandStaticFormats: false }),
  { staticFormats: ['meta_feed_4_5'], videoFormats: [], kinds: ['image'] });
eq('  single stories both no-expand',
  pf.resolvePreset('single', 'meta_stories_9_16', { kinds: 'both', expandStaticFormats: false }),
  { staticFormats: ['meta_stories_9_16'], videoFormats: ['meta_stories_9_16'], kinds: ['image', 'video'] });
eq('  single reels image → nothing (no invert to video)',
  pf.resolvePreset('single', 'meta_reels_9_16', { kinds: 'image' }),
  { staticFormats: [], videoFormats: [], kinds: [] });
eq('  single reels video',
  pf.resolvePreset('single', 'meta_reels_9_16', { kinds: 'video' }),
  { staticFormats: [], videoFormats: ['meta_reels_9_16'], kinds: ['video'] });
// pmax is frozen: single resolves empty (money belt); generate also refuses.
eq('  single pmax both → empty (coming_soon)',
  pf.resolvePreset('single', 'pmax_16_9', { kinds: 'both', expandStaticFormats: false }),
  { staticFormats: [], videoFormats: [], kinds: [] });
eq('  single coming_soon demandgen → empty',
  pf.resolvePreset('single', 'google_demandgen_1_1', { kinds: 'image' }),
  { staticFormats: [], videoFormats: [], kinds: [] });
eq('  single null kinds defaults to image (not both)',
  pf.resolvePreset('single', 'meta_feed_1_1', { kinds: null }).kinds,
  ['image']);

// ── assertGeneratablePlatformFormat — refuse coming_soon ─────────────────
console.log('\nassertGeneratablePlatformFormat — coming_soon is refused');
{
  let threw = false;
  let msg = '';
  try {
    pf.assertGeneratablePlatformFormat('pmax_16_9');
  } catch (e) {
    threw = true;
    msg = e.message || '';
  }
  check('  single request for pmax_16_9 is refused', threw);
  check('  error names the format', msg.includes('pmax_16_9'));
  check('  error says not yet available / coming soon',
    /not yet available|coming soon/i.test(msg));
}
{
  let threw = false;
  try {
    pf.assertGeneratablePlatformFormat('google_demandgen_1_1');
  } catch (e) {
    threw = true;
  }
  check('  demandgen coming_soon is refused', threw);
}
{
  let threw = false;
  try {
    pf.assertGeneratablePlatformFormat('meta_feed_1_1');
  } catch (e) {
    threw = true;
  }
  check('  live format is allowed (no throw)', !threw);
}
{
  let threw = false;
  try {
    pf.assertGeneratablePlatformFormat(null);
    pf.assertGeneratablePlatformFormat(undefined);
    pf.assertGeneratablePlatformFormat('');
  } catch (e) {
    threw = true;
  }
  check('  null/empty is a no-op (caller falls through)', !threw);
}
{
  let threw = false;
  try {
    pf.assertGeneratablePlatformFormat('not_a_format');
  } catch (e) {
    threw = true;
  }
  check('  unknown key is a no-op (existing fall-through)', !threw);
}

// ── coming_soon never slips through ─────────────────────────────────────
console.log('\ncoming_soon never appears in any resolved list or fan-out');
const allResolved = [];
for (const preset of pf.PRESET_KEYS) {
  for (const seed of [...LIVE4, ...COMING, null, 'bogus']) {
    for (const kinds of KIND_OPTS) {
      for (const expand of EXPAND_OPTS) {
        const r = pf.resolvePreset(preset, seed, { kinds, expandStaticFormats: expand });
        allResolved.push(...r.staticFormats, ...r.videoFormats);
      }
    }
  }
}
for (const k of COMING) {
  check(`  ${k} absent from every resolvePreset result`, !allResolved.includes(k));
  eq(`  staticFanout(${k}) is []`, pf.staticFanoutForPlatformFormat(k), []);
  eq(`  videoFanout(${k}) is []`, pf.videoFanoutForPlatformFormat(k), []);
  eq(`  resolveKinds(${k}, both) is []`, pf.resolveKinds(k, 'both'), []);
}
check('  no coming_soon in META_STATIC_FANOUT',
  COMING.every((k) => !pf.META_STATIC_FANOUT.includes(k)));
check('  no coming_soon in META_VIDEO_FANOUT',
  COMING.every((k) => !pf.META_VIDEO_FANOUT.includes(k)));

// Fan-outs themselves only ever return live keys
for (const k of LIVE4) {
  const sf = pf.staticFanoutForPlatformFormat(k);
  const vf = pf.videoFanoutForPlatformFormat(k);
  check(`  staticFanout(${k}) every entry live`, sf.every((x) => pf.isLiveFormat(x)));
  check(`  videoFanout(${k}) every entry live`, vf.every((x) => pf.isLiveFormat(x)));
}

// ── video fan-out declaration (intent for Phase 3) ──────────────────────
console.log('\nMETA_VIDEO_FANOUT — declared intent, not a queue list');
eq('  META_VIDEO_FANOUT order (master first)', pf.META_VIDEO_FANOUT, [
  'meta_stories_9_16', 'meta_reels_9_16', 'meta_feed_1_1', 'meta_feed_4_5'
]);
eq('  META_VIDEO_MASTER is first of fan-out', pf.META_VIDEO_MASTER, pf.META_VIDEO_FANOUT[0]);
check('  META_VIDEO_FANOUT has no duplicates',
  new Set(pf.META_VIDEO_FANOUT).size === pf.META_VIDEO_FANOUT.length);
check('  every video-fanout entry is live',
  pf.META_VIDEO_FANOUT.every((k) => pf.isLiveFormat(k)));
// videoFanoutForPlatformFormat returns the full set (Phase 3 consumers);
// resolvePreset('meta_video') returns only the master (queue path).
setEq('  videoFanout(stories) is full set',
  pf.videoFanoutForPlatformFormat('meta_stories_9_16'), pf.META_VIDEO_FANOUT);
setEq('  videoFanout(reels) is full set',
  pf.videoFanoutForPlatformFormat('meta_reels_9_16'), pf.META_VIDEO_FANOUT);
eq('  videoFanout(pmax) is [] (coming_soon)',
  pf.videoFanoutForPlatformFormat('pmax_16_9'), []);
eq('  videoFanout(null) is []', pf.videoFanoutForPlatformFormat(null), []);

// ── channel / platform helpers + READ paths for frozen pmax ─────────────
console.log('\nplatform + channel helpers + pmax_16_9 read paths');
eq('  platformForFormat(meta_feed_1_1)', pf.platformForFormat('meta_feed_1_1'), 'meta');
eq('  platformForFormat(pmax_16_9)', pf.platformForFormat('pmax_16_9'), 'google');
eq('  platformForFormat(google_demandgen_1_1)', pf.platformForFormat('google_demandgen_1_1'), 'google');
eq('  platformForFormat(meta_legacy_thing) prefix', pf.platformForFormat('meta_legacy_thing'), 'meta');
eq('  platformForFormat(pmax_future) prefix', pf.platformForFormat('pmax_future'), 'google');
eq('  channelLabelForFormat(meta_*)', pf.channelLabelForFormat('meta_feed_1_1'), 'Meta');
eq('  channelLabelForFormat(pmax_*)', pf.channelLabelForFormat('pmax_16_9'), 'Google');
eq('  channelLabelForFormat(google_*)', pf.channelLabelForFormat('google_shorts_9_16'), 'Google');
eq('  channelLabelForFormat(tiktok_*)', pf.channelLabelForFormat('tiktok_feed'), 'TikTok');
// Read paths for the 45 existing pmax_16_9 Ads must still resolve.
eq('  aspectRatioForPlatformFormat(pmax_16_9)', pf.aspectRatioForPlatformFormat('pmax_16_9'), '16:9');
eq('  canvasForPlatformFormat(pmax_16_9)', pf.canvasForPlatformFormat('pmax_16_9'),
  { width: 1000, height: 563 });
eq('  safeAreaForPlatformFormat(pmax_16_9)', pf.safeAreaForPlatformFormat('pmax_16_9'),
  { top: 0, bottom: 0 });
eq('  kindsForPlatformFormat(pmax_16_9)', pf.kindsForPlatformFormat('pmax_16_9'),
  ['image', 'video']);
check('  getFormatCaps(pmax_16_9) returns caps',
  !!pf.getFormatCaps('pmax_16_9')?.label);

// ── PRESETS table completeness ──────────────────────────────────────────
console.log('\nPRESETS table');
for (const k of ['meta_static', 'meta_video', 'meta_all', 'google_static', 'google_video', 'google_all', 'single']) {
  check(`  PRESETS.${k} exists`, !!pf.PRESETS[k]);
}
// An unknown preset THROWS. It used to fall through to 'single', which meant a
// typo'd or deleted preset name silently produced a different — and differently
// billed — format set while reporting success. Same silent-wrong-answer shape as
// the done/total:0 runs of 2026-08-01.
{
  let threwUnknown = false;
  try { pf.resolvePreset('not_a_preset', 'meta_feed_1_1', { kinds: 'image' }); }
  catch { threwUnknown = true; }
  check('  unknown preset throws instead of silently becoming single', threwUnknown);
}

// ── formatCatalog — UI stub ─────────────────────────────────────────────
console.log('\nformatCatalog() — UI catalog for greyed coming-soon cards');
{
  const cat = pf.formatCatalog();
  check('  returns platforms array', Array.isArray(cat?.platforms) && cat.platforms.length >= 2);
  const ids = (cat.platforms || []).map((p) => p.id);
  check('  includes meta', ids.includes('meta'));
  check('  includes google', ids.includes('google'));

  const meta = cat.platforms.find((p) => p.id === 'meta');
  const google = cat.platforms.find((p) => p.id === 'google');
  check('  meta has presets', Array.isArray(meta?.presets) && meta.presets.length === 3);
  check('  google has presets', Array.isArray(google?.presets) && google.presets.length === 3);

  const metaPresetKeys = (meta?.presets || []).map((p) => p.key);
  setEq('  meta preset keys', metaPresetKeys, ['meta_static', 'meta_video', 'meta_all']);
  const googlePresetKeys = (google?.presets || []).map((p) => p.key);
  setEq('  google preset keys', googlePresetKeys, ['google_static', 'google_video', 'google_all']);

  // Every format entry carries the fields the UI needs to render a card.
  for (const plat of cat.platforms) {
    for (const fmt of plat.formats || []) {
      check(`  ${plat.id}/${fmt.key}: has label+aspect+dims+kinds+status`,
        !!fmt.label && !!fmt.aspectRatio && !!fmt.deliveryDims?.width &&
        Array.isArray(fmt.kinds) && (fmt.status === 'live' || fmt.status === 'coming_soon'));
    }
    for (const preset of plat.presets || []) {
      for (const fmt of preset.formats || []) {
        check(`  ${preset.key}/${fmt.key}: catalog format has status`,
          fmt.status === 'live' || fmt.status === 'coming_soon');
      }
    }
  }

  // Google formats in the catalog are all coming_soon (stubs for grey cards).
  check('  every google platform format is coming_soon in catalog',
    (google?.formats || []).every((f) => f.status === 'coming_soon'));
  check('  every google preset format is coming_soon in catalog',
    (google?.presets || []).every((p) =>
      (p.formats || []).every((f) => f.status === 'coming_soon')));

  // Meta live formats still live in catalog
  check('  meta catalog has live formats',
    (meta?.formats || []).some((f) => f.status === 'live'));

  // Catalog includes the new PMax stubs and frozen pmax_16_9
  const gKeys = (google?.formats || []).map((f) => f.key);
  for (const k of ['pmax_16_9', ...GOOGLE_PMAX_STUBS, 'google_demandgen_1_1', 'google_shorts_9_16']) {
    check(`  catalog lists ${k}`, gKeys.includes(k));
  }

  // Preset format lists in catalog are INTENT (unfiltered) so UI can show stubs
  const gStatic = google?.presets.find((p) => p.key === 'google_static');
  check('  google_static catalog shows intended formats (not empty)',
    (gStatic?.formats || []).length > 0);
  check('  google_static catalog formats are all coming_soon',
    (gStatic?.formats || []).every((f) => f.status === 'coming_soon'));
}

// ── static fan-out still holds (regression guard) ───────────────────────
console.log('\nstatic fan-out still money-safe');
for (const k of META3) {
  setEq(`  staticFanout(${k})`, pf.staticFanoutForPlatformFormat(k), META3);
}
eq('  staticFanout(pmax) empty (coming_soon)', pf.staticFanoutForPlatformFormat('pmax_16_9'), []);
eq('  staticFanout(reels) empty', pf.staticFanoutForPlatformFormat('meta_reels_9_16'), []);
check('  META_STATIC_FANOUT returns a copy',
  pf.staticFanoutForPlatformFormat('meta_feed_1_1') !== pf.META_STATIC_FANOUT);
check('  META_VIDEO_FANOUT returns a copy from videoFanout',
  pf.videoFanoutForPlatformFormat('meta_stories_9_16') !== pf.META_VIDEO_FANOUT);

const total = pass + failures.length;
console.log('');
if (failures.length) {
  console.log(`❌ verifyPresets: ${pass}/${total} passed, ${failures.length} FAILED`);
  failures.forEach((f) => console.log(`   FAILED: ${f}`));
  process.exit(1);
}
console.log(`✅ verifyPresets: ${pass}/${total} checks passed`);
