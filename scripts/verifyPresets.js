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
 * 'single' must reproduce today's three-knob behaviour exhaustively — that is
 * the backwards-compat proof so old callers stay byte-identical.
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
const LIVE5 = [
  'meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16',
  'meta_stories_9_16', 'pmax_16_9'
];
const COMING = [
  'google_demandgen_1_1', 'google_demandgen_4_5',
  'google_demandgen_1_91_1', 'google_shorts_9_16'
];

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
for (const k of LIVE5) {
  const caps = pf.PLATFORM_FORMATS[k];
  const want = parseAr(caps.aspectRatio);
  const got = caps.deliveryDims.width / caps.deliveryDims.height;
  check(`  ${k}: delivery ${caps.deliveryDims.width}x${caps.deliveryDims.height} matches ${caps.aspectRatio}`,
    Math.abs(want - got) < 0.02);
  check(`  ${k}: status is live`, caps.status === 'live');
}
for (const k of COMING) {
  check(`  ${k}: status is coming_soon`, pf.PLATFORM_FORMATS[k]?.status === 'coming_soon');
  check(`  ${k}: isComingSoonFormat`, pf.isComingSoonFormat(k) === true);
  check(`  ${k}: isLiveFormat is false`, pf.isLiveFormat(k) === false);
}
check('  LIVE_PLATFORM_FORMAT_KEYS is exactly the 5 live surfaces',
  JSON.stringify([...pf.LIVE_PLATFORM_FORMAT_KEYS].sort()) === JSON.stringify([...LIVE5].sort()));
check('  no coming_soon key is in LIVE_PLATFORM_FORMAT_KEYS',
  COMING.every((k) => !pf.LIVE_PLATFORM_FORMAT_KEYS.includes(k)));

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
{
  const r = pf.resolvePreset('google_pmax', 'meta_feed_1_1');
  eq('  google_pmax staticFormats', r.staticFormats, ['pmax_16_9']);
  eq('  google_pmax videoFormats', r.videoFormats, ['pmax_16_9']);
  setEq('  google_pmax kinds', r.kinds, ['image', 'video']);
  check('  google_pmax does not include any Demand Gen / Shorts key',
    ![...r.staticFormats, ...r.videoFormats].some((k) => k.startsWith('google_')));
}

// ── single: exhaustive backwards-compat ─────────────────────────────────
console.log('\nresolvePreset single — exhaustive three-knob back-compat');
const KIND_OPTS = [null, 'image', 'video', 'both'];
const EXPAND_OPTS = [false, true];
const PF_OPTS = [...LIVE5, 'meta_feed_1_1', null, 'not_a_format', ...COMING];

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

// Pin a few human-readable single cases that map to known old behaviour.
eq('  single feed1:1 image no-expand',
  pf.resolvePreset('single', 'meta_feed_1_1', { kinds: 'image', expandStaticFormats: false }),
  { staticFormats: ['meta_feed_1_1'], videoFormats: [], kinds: ['image'] });
setEq('  single feed1:1 image expand static',
  pf.resolvePreset('single', 'meta_feed_1_1', { kinds: 'image', expandStaticFormats: true }).staticFormats,
  META3);
eq('  single reels image → nothing (no invert to video)',
  pf.resolvePreset('single', 'meta_reels_9_16', { kinds: 'image' }),
  { staticFormats: [], videoFormats: [], kinds: [] });
eq('  single reels video',
  pf.resolvePreset('single', 'meta_reels_9_16', { kinds: 'video' }),
  { staticFormats: [], videoFormats: ['meta_reels_9_16'], kinds: ['video'] });
eq('  single pmax both no-expand',
  pf.resolvePreset('single', 'pmax_16_9', { kinds: 'both', expandStaticFormats: false }),
  { staticFormats: ['pmax_16_9'], videoFormats: ['pmax_16_9'], kinds: ['image', 'video'] });
eq('  single coming_soon → empty',
  pf.resolvePreset('single', 'google_demandgen_1_1', { kinds: 'image' }),
  { staticFormats: [], videoFormats: [], kinds: [] });
eq('  single null kinds defaults to image (not both)',
  pf.resolvePreset('single', 'meta_feed_1_1', { kinds: null }).kinds,
  ['image']);

// ── coming_soon never slips through ─────────────────────────────────────
console.log('\ncoming_soon never appears in any resolved list or fan-out');
const allResolved = [];
for (const preset of pf.PRESET_KEYS) {
  for (const seed of [...LIVE5, ...COMING, null, 'bogus']) {
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
for (const k of LIVE5) {
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
eq('  videoFanout(pmax) is passthrough',
  pf.videoFanoutForPlatformFormat('pmax_16_9'), ['pmax_16_9']);
eq('  videoFanout(null) is []', pf.videoFanoutForPlatformFormat(null), []);

// ── channel / platform helpers ──────────────────────────────────────────
console.log('\nplatform + channel helpers (prefix fallback for unknown keys)');
eq('  platformForFormat(meta_feed_1_1)', pf.platformForFormat('meta_feed_1_1'), 'meta');
eq('  platformForFormat(pmax_16_9)', pf.platformForFormat('pmax_16_9'), 'google');
eq('  platformForFormat(google_demandgen_1_1)', pf.platformForFormat('google_demandgen_1_1'), 'google');
eq('  platformForFormat(meta_legacy_thing) prefix', pf.platformForFormat('meta_legacy_thing'), 'meta');
eq('  platformForFormat(pmax_future) prefix', pf.platformForFormat('pmax_future'), 'google');
eq('  channelLabelForFormat(meta_*)', pf.channelLabelForFormat('meta_feed_1_1'), 'Meta');
eq('  channelLabelForFormat(pmax_*)', pf.channelLabelForFormat('pmax_16_9'), 'Google');
eq('  channelLabelForFormat(google_*)', pf.channelLabelForFormat('google_shorts_9_16'), 'Google');
eq('  channelLabelForFormat(tiktok_*)', pf.channelLabelForFormat('tiktok_feed'), 'TikTok');

// ── PRESETS table completeness ──────────────────────────────────────────
console.log('\nPRESETS table');
for (const k of ['meta_static', 'meta_video', 'meta_all', 'google_pmax', 'single']) {
  check(`  PRESETS.${k} exists`, !!pf.PRESETS[k]);
}
eq('  unknown preset falls through to single behaviour',
  pf.resolvePreset('not_a_preset', 'meta_feed_1_1', { kinds: 'image' }),
  pf.resolvePreset('single', 'meta_feed_1_1', { kinds: 'image' }));

// ── static fan-out still holds (regression guard) ───────────────────────
console.log('\nstatic fan-out still money-safe');
for (const k of META3) {
  setEq(`  staticFanout(${k})`, pf.staticFanoutForPlatformFormat(k), META3);
}
eq('  staticFanout(pmax) passthrough', pf.staticFanoutForPlatformFormat('pmax_16_9'), ['pmax_16_9']);
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
