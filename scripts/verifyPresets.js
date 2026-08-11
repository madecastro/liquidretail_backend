#!/usr/bin/env node
'use strict';
/**
 * verifyPresets — offline checks for the format PRESET API.
 *
 * The preset table replaces the three-knob wizard API (platformFormat + kinds +
 * expandStaticFormats) with one operator choice. Money-shaped invariants that
 * are load-bearing:
 *
 *   1. meta_video queues exactly ONE video format (the 9:16 master). Returning
 *      the full META_VIDEO_FANOUT would queue four billable Veo submits per
 *      product; the other three sizes are Phase 3 derivations, not generations.
 *   2. google_video queues exactly TWO video masters (9:16 + 16:9).
 *      pmax_video_1_1 is DERIVE-ONLY — it must never appear in resolvePreset
 *      videoFormats (that would make it a third billable Omni submit).
 *   3. coming_soon formats never appear in any resolved list, fan-out, or
 *      generatable allowlist. They are UI chrome only until they go live.
 *
 * Phase A (2026-08): six PMax keys are live (3 static + 3 video). Demand Gen +
 * google_shorts_9_16 + frozen pmax_16_9 stay coming_soon. google_pmax is gone
 * (it double-spent static+video on pmax_16_9).
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
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
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
// Live Meta surfaces (unchanged).
const LIVE_META = [
  'meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16', 'meta_stories_9_16'
];
// Phase A live PMax surfaces.
const LIVE_PMAX_STATIC = [
  'pmax_landscape_1_91_1', 'pmax_square_1_1', 'pmax_portrait_4_5'
];
const LIVE_PMAX_VIDEO = [
  'pmax_video_16_9', 'pmax_video_1_1', 'pmax_video_9_16'
];
const LIVE_PMAX = [...LIVE_PMAX_STATIC, ...LIVE_PMAX_VIDEO];
const LIVE_ALL = [...LIVE_META, ...LIVE_PMAX];
// Google keys that remain coming_soon after Phase A (Demand Gen + Shorts +
// frozen legacy dual-kind pmax_16_9). Not the six live PMax keys above.
const COMING = [
  'pmax_16_9',
  'google_demandgen_1_1', 'google_demandgen_4_5',
  'google_demandgen_1_91_1', 'google_shorts_9_16'
];
const GOOGLE_PRESETS = ['google_static', 'google_video', 'google_all'];
// Billable Omni masters only — pmax_video_1_1 is intentionally absent.
const GOOGLE_VIDEO_MASTERS_EXPECTED = ['pmax_video_9_16', 'pmax_video_16_9'];

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
for (const k of LIVE_ALL) {
  const caps = pf.PLATFORM_FORMATS[k];
  const want = parseAr(caps.aspectRatio);
  const got = caps.deliveryDims.width / caps.deliveryDims.height;
  check(`  ${k}: delivery ${caps.deliveryDims.width}x${caps.deliveryDims.height} matches ${caps.aspectRatio}`,
    Math.abs(want - got) < 0.02);
  check(`  ${k}: status is live`, caps.status === 'live');
}
console.log('\ncoming_soon Google keys (Demand Gen + Shorts + frozen pmax_16_9)');
for (const k of COMING) {
  check(`  ${k}: declared`, !!pf.PLATFORM_FORMATS[k]);
  check(`  ${k}: status is coming_soon`, pf.PLATFORM_FORMATS[k]?.status === 'coming_soon');
  check(`  ${k}: isComingSoonFormat`, pf.isComingSoonFormat(k) === true);
  check(`  ${k}: isLiveFormat is false`, pf.isLiveFormat(k) === false);
}
// PMax live keys have the published delivery dims
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
// Live PMax status pin
for (const k of LIVE_PMAX) {
  check(`  ${k}: is live (Phase A)`, pf.isLiveFormat(k) === true);
}
// Frozen pmax_16_9 keeps prior geometry for read paths
eq('  pmax_16_9 deliveryDims unchanged', pf.PLATFORM_FORMATS.pmax_16_9?.deliveryDims,
  { width: 1920, height: 1080 });
eq('  pmax_16_9 canvas unchanged', pf.PLATFORM_FORMATS.pmax_16_9?.canvas,
  { width: 1000, height: 563 });
eq('  pmax_16_9 kinds unchanged', pf.PLATFORM_FORMATS.pmax_16_9?.kinds, ['image', 'video']);
eq('  pmax_16_9 safeArea unchanged', pf.PLATFORM_FORMATS.pmax_16_9?.safeArea, { top: 0, bottom: 0 });

check('  LIVE_PLATFORM_FORMAT_KEYS is exactly Meta4 + live PMax6',
  JSON.stringify([...pf.LIVE_PLATFORM_FORMAT_KEYS].sort()) === JSON.stringify([...LIVE_ALL].sort()));
check('  no coming_soon key is in LIVE_PLATFORM_FORMAT_KEYS',
  COMING.every((k) => !pf.LIVE_PLATFORM_FORMAT_KEYS.includes(k)));
check('  every live PMax key is Google-platform',
  LIVE_PMAX.every((k) => pf.PLATFORM_FORMATS[k]?.platform === 'google'));
check('  Demand Gen + Shorts + frozen pmax_16_9 remain coming_soon on Google',
  COMING.every((k) =>
    pf.PLATFORM_FORMATS[k]?.platform === 'google' &&
    pf.PLATFORM_FORMATS[k]?.status === 'coming_soon'));

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
console.log('\nGoogle presets — Phase A money shape (live PMax, not empty)');
{
  const r = pf.resolvePreset('google_static', 'meta_feed_1_1');
  eq('  google_static staticFormats (3 billable image submits/concept)', r.staticFormats, LIVE_PMAX_STATIC);
  eq('  google_static videoFormats', r.videoFormats, []);
  eq('  google_static kinds', r.kinds, ['image']);
  check('  google_static is 3 billable image surfaces', r.staticFormats.length === 3);
}
{
  const r = pf.resolvePreset('google_video', 'meta_feed_1_1');
  eq('  google_video videoFormats is the TWO Omni masters (order)', r.videoFormats, GOOGLE_VIDEO_MASTERS_EXPECTED);
  eq('  google_video staticFormats', r.staticFormats, []);
  eq('  google_video kinds', r.kinds, ['video']);
  check('  MONEY: google_video queues exactly TWO video masters (not three)',
    r.videoFormats.length === 2);
  check('  MONEY: pmax_video_1_1 is NOT a master in google_video',
    !r.videoFormats.includes('pmax_video_1_1'));
}
{
  const r = pf.resolvePreset('google_all', 'meta_feed_1_1');
  eq('  google_all staticFormats', r.staticFormats, LIVE_PMAX_STATIC);
  eq('  google_all videoFormats is the TWO masters (order)', r.videoFormats, GOOGLE_VIDEO_MASTERS_EXPECTED);
  setEq('  google_all kinds', r.kinds, ['image', 'video']);
  check('  google_all still only TWO video masters to queue', r.videoFormats.length === 2);
  check('  MONEY: pmax_video_1_1 is NOT a master in google_all',
    !r.videoFormats.includes('pmax_video_1_1'));
}
// MONEY PIN: derive-only square must never be queued by a multi-surface preset.
// If it appears in google_video / google_all / meta_* videoFormats it becomes a
// third billable Omni submit. single with seed===pmax_video_1_1 is the one
// legitimate case (operator explicitly named that surface); every other
// (preset, seed) pair must keep it out of videoFormats.
{
  const seeds = [...LIVE_ALL, ...COMING, null, 'bogus', 'meta_feed_1_1'];
  const kindOpts = [null, 'image', 'video', 'both'];
  const expandOpts = [false, true];
  const namedPresets = pf.PRESET_KEYS.filter((k) => k !== 'single');
  let leakNamed = null;
  let leakSingleOtherSeed = null;
  for (const preset of namedPresets) {
    for (const seed of seeds) {
      for (const kinds of kindOpts) {
        for (const expand of expandOpts) {
          const r = pf.resolvePreset(preset, seed, { kinds, expandStaticFormats: expand });
          if ((r.videoFormats || []).includes('pmax_video_1_1')) {
            leakNamed = { preset, seed, kinds, expand, videoFormats: r.videoFormats };
          }
        }
      }
    }
  }
  for (const seed of seeds) {
    if (seed === 'pmax_video_1_1') continue;
    for (const kinds of kindOpts) {
      for (const expand of expandOpts) {
        const r = pf.resolvePreset('single', seed, { kinds, expandStaticFormats: expand });
        if ((r.videoFormats || []).includes('pmax_video_1_1')) {
          leakSingleOtherSeed = { seed, kinds, expand, videoFormats: r.videoFormats };
        }
      }
    }
  }
  check('  MONEY: pmax_video_1_1 never in named-preset videoFormats (derive-only; would be 3rd Omni)',
    !leakNamed, leakNamed ? JSON.stringify(leakNamed) : '');
  check('  MONEY: pmax_video_1_1 never sneaks into single for any other seed',
    !leakSingleOtherSeed, leakSingleOtherSeed ? JSON.stringify(leakSingleOtherSeed) : '');
  // Also pin the export itself: masters list excludes 1:1.
  eq('  GOOGLE_VIDEO_MASTERS export is 9:16 + 16:9 only',
    pf.GOOGLE_VIDEO_MASTERS, GOOGLE_VIDEO_MASTERS_EXPECTED);
  check('  GOOGLE_VIDEO_MASTERS excludes pmax_video_1_1',
    !pf.GOOGLE_VIDEO_MASTERS.includes('pmax_video_1_1'));
}
check('  google_pmax no longer exists', !pf.PRESETS.google_pmax && !pf.PRESET_KEYS.includes('google_pmax'));
// Intent lists exist so Demand Gen can flip on without a rewrite
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
// Demand Gen + Shorts never appear in any resolved list
for (const k of COMING) {
  // checked again in the global coming_soon sweep below; pin here for money docs
  check(`  coming_soon ${k} not in GOOGLE_STATIC_FANOUT`, !pf.GOOGLE_STATIC_FANOUT.includes(k));
  check(`  coming_soon ${k} not in GOOGLE_VIDEO_MASTERS`, !(pf.GOOGLE_VIDEO_MASTERS || []).includes(k));
}

// ── single: exhaustive backwards-compat for LIVE formats ────────────────
console.log('\nresolvePreset single — exhaustive three-knob back-compat (live Meta + live PMax)');
const KIND_OPTS = [null, 'image', 'video', 'both'];
const EXPAND_OPTS = [false, true];
const PF_OPTS = [...LIVE_ALL, 'meta_feed_1_1', null, 'not_a_format', ...COMING];

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
// Frozen pmax_16_9: single resolves empty (money belt); generate also refuses.
eq('  single pmax_16_9 both → empty (coming_soon)',
  pf.resolvePreset('single', 'pmax_16_9', { kinds: 'both', expandStaticFormats: false }),
  { staticFormats: [], videoFormats: [], kinds: [] });
// Live PMax static single path
eq('  single pmax_landscape image no-expand',
  pf.resolvePreset('single', 'pmax_landscape_1_91_1', { kinds: 'image', expandStaticFormats: false }),
  { staticFormats: ['pmax_landscape_1_91_1'], videoFormats: [], kinds: ['image'] });
eq('  single pmax_video_9_16 video',
  pf.resolvePreset('single', 'pmax_video_9_16', { kinds: 'video' }),
  { staticFormats: [], videoFormats: ['pmax_video_9_16'], kinds: ['video'] });
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
    pf.assertGeneratablePlatformFormat('pmax_landscape_1_91_1');
  } catch (e) {
    threw = true;
  }
  check('  live PMax static is allowed (no throw)', !threw);
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
  for (const seed of [...LIVE_ALL, ...COMING, null, 'bogus']) {
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
// Live PMax statics DO appear in google_static resolve results (already pinned);
// Demand Gen keys must not.
check('  Demand Gen + Shorts absent from every resolvePreset result',
  ['google_demandgen_1_1', 'google_demandgen_4_5', 'google_demandgen_1_91_1', 'google_shorts_9_16']
    .every((k) => !allResolved.includes(k)));

// Fan-outs themselves only ever return live keys
for (const k of LIVE_ALL) {
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
eq('  videoFanout(pmax_16_9) is [] (coming_soon)',
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

  // Phase A: six PMax keys are live in the catalog; Demand Gen + Shorts +
  // frozen pmax_16_9 stay coming_soon.
  const gFormats = google?.formats || [];
  for (const k of LIVE_PMAX) {
    check(`  catalog ${k} is live`,
      gFormats.some((f) => f.key === k && f.status === 'live'));
  }
  for (const k of COMING) {
    check(`  catalog ${k} is coming_soon`,
      gFormats.some((f) => f.key === k && f.status === 'coming_soon'));
  }

  // Meta live formats still live in catalog
  check('  meta catalog has live formats',
    (meta?.formats || []).some((f) => f.status === 'live'));

  // Catalog includes the live PMax set and frozen pmax_16_9
  const gKeys = gFormats.map((f) => f.key);
  for (const k of ['pmax_16_9', ...LIVE_PMAX, 'google_demandgen_1_1', 'google_shorts_9_16']) {
    check(`  catalog lists ${k}`, gKeys.includes(k));
  }

  // Preset format lists in catalog are INTENT (unfiltered) so UI can show cards
  const gStatic = google?.presets.find((p) => p.key === 'google_static');
  check('  google_static catalog shows intended formats (not empty)',
    (gStatic?.formats || []).length > 0);
  check('  google_static catalog formats are the three live PMax statics',
    (gStatic?.formats || []).every((f) => LIVE_PMAX_STATIC.includes(f.key) && f.status === 'live') &&
    (gStatic?.formats || []).length === 3);
  const gVideo = google?.presets.find((p) => p.key === 'google_video');
  check('  google_video catalog shows the two masters (not derive-only 1:1)',
    (gVideo?.formats || []).every((f) => GOOGLE_VIDEO_MASTERS_EXPECTED.includes(f.key)) &&
    (gVideo?.formats || []).length === 2 &&
    !(gVideo?.formats || []).some((f) => f.key === 'pmax_video_1_1'));
}

// ── static fan-out still holds (regression guard) ───────────────────────
console.log('\nstatic fan-out still money-safe');
for (const k of META3) {
  setEq(`  staticFanout(${k})`, pf.staticFanoutForPlatformFormat(k), META3);
}
eq('  staticFanout(pmax_16_9) empty (coming_soon)', pf.staticFanoutForPlatformFormat('pmax_16_9'), []);
eq('  staticFanout(reels) empty', pf.staticFanoutForPlatformFormat('meta_reels_9_16'), []);
// Live PMax static single-key: staticFanout returns [that key] only (not the
// Meta-style three-way fan-out). Multi-surface Google statics come from the
// google_static *preset*, not from staticFanoutForPlatformFormat.
eq('  staticFanout(pmax_landscape) is singleton (preset owns the 3-way fan-out)',
  pf.staticFanoutForPlatformFormat('pmax_landscape_1_91_1'), ['pmax_landscape_1_91_1']);
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
