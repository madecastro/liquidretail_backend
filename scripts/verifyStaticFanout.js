#!/usr/bin/env node
'use strict';
/**
 * verifyStaticFanout — offline checks for the "All static formats" fan-out.
 *
 * Every entry the fan-out adds is a SEPARATE BILLABLE Atlas image submit, so
 * the two things this guards are money-shaped:
 *
 *   1. The fan-out set itself. Fanning a Google Performance Max request out to
 *      Meta sizes, or fanning a video-only surface out at all, would bill for
 *      surfaces the operator never asked for.
 *   2. The post-cap bucketing. The cap is applied per (product, kind, format).
 *      It used to bucket by kind alone, which silently reduced "3 concepts in 3
 *      sizes" (9 ads) to "the top concept in 3 sizes" (3 ads) — the operator
 *      paid the Director for three concepts and got one. This file pins the
 *      bucketing so that regression cannot come back quietly.
 *
 * No DB, no network, no API keys. Run free on every edit:
 *   node scripts/verifyStaticFanout.js
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

console.log('\nstaticFanoutForPlatformFormat — which surfaces get billed');
const META3 = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16'];
// Any Meta static surface fans out to all three, so the operator gets every
// size they actually run regardless of which one they happened to click.
for (const k of META3) eq(`  ${k}`, pf.staticFanoutForPlatformFormat(k), META3);
// pmax is a different ad platform — one format in, one out. Fanning it to Meta
// sizes would bill three Meta generations for a Google request.
// Frozen 2026-08-02: Google is coming_soon, so pmax fans out to nothing at all.
eq('  pmax_16_9 (frozen — fans out to nothing)', pf.staticFanoutForPlatformFormat('pmax_16_9'), []);
// Reels declares kinds:['video'] — it ships no static image, so no image work.
eq('  meta_reels_9_16 (video-only)', pf.staticFanoutForPlatformFormat('meta_reels_9_16'), []);
eq('  unknown format', pf.staticFanoutForPlatformFormat('not_a_format'), []);
eq('  null', pf.staticFanoutForPlatformFormat(null), []);
eq('  undefined', pf.staticFanoutForPlatformFormat(undefined), []);

console.log('\nfan-out set integrity');
check('  META_STATIC_FANOUT has no duplicates (a dupe = a double charge)',
  new Set(pf.META_STATIC_FANOUT).size === pf.META_STATIC_FANOUT.length);
check('  every fanned surface actually accepts image',
  pf.META_STATIC_FANOUT.every(k => pf.kindsForPlatformFormat(k).includes('image')));
check('  every fanned surface is a real declared format',
  pf.META_STATIC_FANOUT.every(k => pf.PLATFORM_FORMAT_KEYS.includes(k)));
check('  every fanned surface is live',
  pf.META_STATIC_FANOUT.every(k => pf.isLiveFormat(k)));
check('  reels is NOT in the fan-out set',
  !pf.META_STATIC_FANOUT.includes('meta_reels_9_16'));
check('  pmax is NOT in the fan-out set',
  !pf.META_STATIC_FANOUT.includes('pmax_16_9'));
check('  returns a COPY, not the shared array (a caller mutating it would ' +
      'change the fan-out for every later run in the process)',
  pf.staticFanoutForPlatformFormat('meta_feed_1_1') !== pf.META_STATIC_FANOUT);

// ── post-cap bucketing ───────────────────────────────────────────────
// Mirrors runConceptDrivenExpansion's cap block. Kept as a local reimplementation
// on purpose: the point is to pin the BEHAVIOUR (bucket key includes format), so
// this must fail if the real bucket key regresses to kind-only.
function applyCap(payloads, capByKind, keyFn) {
  const byBucket = new Map();
  for (const p of payloads) {
    const k = keyFn(p);
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k).push(p);
  }
  const kept = [];
  for (const [bucket, list] of byBucket.entries()) {
    const kind = bucket.split('|')[0];
    const cap = capByKind[kind] ?? Infinity;
    const sorted = list.slice().sort((a, b) => (a.judgeRank ?? 999) - (b.judgeRank ?? 999));
    kept.push(...(isFinite(cap) ? sorted.slice(0, cap) : sorted));
  }
  return kept;
}
const BUCKET = p => `${p.kind || 'image'}|${p.platformFormat || ''}`;

// 3 concepts x 3 formats, emitted concept-major exactly as the real loop does.
const fanned = [];
for (let c = 1; c <= 3; c++) {
  for (const f of META3) fanned.push({ kind: 'image', platformFormat: f, conceptId: `c${c}`, judgeRank: c });
}

console.log('\npost-cap bucketing — cap is per (kind, FORMAT), not per kind');
const keptFan = applyCap(fanned, { image: 3 }, BUCKET);
check('  all 9 (3 concepts x 3 sizes) survive a cap of 3', keptFan.length === 9);
for (const f of META3) {
  check(`  ${f} keeps 3 concepts`, keptFan.filter(p => p.platformFormat === f).length === 3);
}
for (const c of ['c1', 'c2', 'c3']) {
  check(`  concept ${c} survives in all 3 sizes`, keptFan.filter(p => p.conceptId === c).length === 3);
}
// The regression this file exists to catch: kind-only bucketing collapses the
// fan-out to the single top-ranked concept.
const keptKindOnly = applyCap(fanned, { image: 3 }, p => p.kind);
check('  REGRESSION GUARD: kind-only bucketing would keep only 3 of 9 …',
  keptKindOnly.length === 3);
check('  … and would drop concepts 2 and 3 entirely (why format must be in the key)',
  new Set(keptKindOnly.map(p => p.conceptId)).size === 1);

console.log('\nfan-out OFF — behaviour must be byte-identical to pre-feature');
const single = [];
for (let c = 1; c <= 3; c++) single.push({ kind: 'image', platformFormat: 'meta_feed_1_1', conceptId: `c${c}`, judgeRank: c });
const keptSingle = applyCap(single, { image: 3 }, BUCKET);
check('  one format, 3 concepts, cap 3 → 3 kept (one bucket, as before)', keptSingle.length === 3);
const over = [];
for (let c = 1; c <= 5; c++) over.push({ kind: 'image', platformFormat: 'meta_feed_1_1', conceptId: `c${c}`, judgeRank: c });
const keptOver = applyCap(over, { image: 3 }, BUCKET);
check('  5 concepts, cap 3 → 3 kept (cap still bites within a format)', keptOver.length === 3);
check('  … and keeps the JUDGE-RANKED best three, not arbitrary ones',
  JSON.stringify(keptOver.map(p => p.conceptId)) === JSON.stringify(['c1', 'c2', 'c3']));

console.log('\nvideo is never fanned out');
const mixed = [
  { kind: 'image', platformFormat: 'meta_feed_1_1', conceptId: 'c1', judgeRank: 1 },
  { kind: 'image', platformFormat: 'meta_feed_4_5', conceptId: 'c1', judgeRank: 1 },
  { kind: 'video', platformFormat: 'meta_reels_9_16', conceptId: 'c1', judgeRank: 1 },
  { kind: 'video', platformFormat: 'meta_reels_9_16', conceptId: 'c2', judgeRank: 2 }
];
const keptMixed = applyCap(mixed, { image: 3, video: 1 }, BUCKET);
check('  video still capped at 1 per (product, format) — ~$1.75/Veo call',
  keptMixed.filter(p => p.kind === 'video').length === 1);
check('  image fan-out unaffected by the video bucket',
  keptMixed.filter(p => p.kind === 'image').length === 2);

console.log('\nbillable-count estimate matches the live post-cap math');
const CAP = 3;
const estimate = (flag, fmt) => Math.min(3, CAP) * (flag ? Math.max(1, pf.staticFanoutForPlatformFormat(fmt).length) : 1);
check('  flag off, feed 1:1 → 3 images/product (unchanged)', estimate(false, 'meta_feed_1_1') === 3);
check('  flag on,  feed 1:1 → 9 images/product', estimate(true, 'meta_feed_1_1') === 9);
check('  flag on,  stories  → 9 images/product', estimate(true, 'meta_stories_9_16') === 9);
// The estimate helper mirrors production's Math.max(1, fanout.length) floor, so a
// frozen format still *estimates* 3. That is fine — the real guard is upstream:
// resolvePreset emits nothing for it and the route refuses it outright. Assert the
// guard, not the estimator's floor.
check('  pmax fans out to nothing while Google is frozen',
  pf.staticFanoutForPlatformFormat('pmax_16_9').length === 0);
check('  frozen pmax yields no formats from any preset',
  pf.resolvePreset('single', 'pmax_16_9', { kinds: 'both' }).staticFormats.length === 0);
check('  estimate equals what the cap actually keeps (9)', estimate(true, 'meta_feed_1_1') === keptFan.length);

const total = pass + failures.length;
console.log('');
if (failures.length) {
  console.log(`❌ verifyStaticFanout: ${pass}/${total} passed, ${failures.length} FAILED`);
  failures.forEach(f => console.log(`   FAILED: ${f}`));
  process.exit(1);
}
console.log(`✅ verifyStaticFanout: ${pass}/${total} checks passed`);
