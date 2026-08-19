#!/usr/bin/env node
/**
 * verifyReelsSafeZone.mjs — Instagram Reels titling must reserve the
 * right-edge action rail. Offline: no DB, no network. ESM because
 * remotion/lib/safeZones.js is "type":"module".
 *
 * THE DEFECT THIS PINS
 * --------------------
 * SAFE_ZONES had no `reels` key and `meta_reels_9_16` was absent from
 * PMAX_VIDEO_SAFE_ZONE_KEY, so resolveSafeZoneKey fell through to the canvas
 * format `vertical` — right:0.075. Instagram Reels paints a persistent action
 * rail (like / comment / share / audio disc) down the RIGHT edge at roughly
 * 15% of width, so a right-reaching title stack rendered underneath native UI.
 * verticalYt already reserves right:0.15 for YouTube Shorts' engagement rail;
 * Reels is the Meta twin of that surface and had no equivalent reserve.
 *
 * MEASURED CONTEXT (why this was found): a production run delivered
 * meta_reels_9_16 and meta_stories_9_16 as BYTE-IDENTICAL files (md5
 * e9029634, 1080x1920, 10.048s) from two separate Remotion renders. The two
 * zones differed only in the bottom floor, and face/product keep-out had
 * relocated the close group to `upperThird`, where they are pixel-identical.
 *
 * ⚠️ THE 0.15 IS A CONSIDERED DEFAULT, NOT A MEASURED SPEC — it is parity with
 * verticalYt, not a reading of a published Instagram safe-zone template the
 * way landscapeYt.bottom was measured off Google's PNG. Do not cite it as
 * measured evidence. If Meta publishes a real overlay, re-measure and correct
 * remotion/lib/safeZones.js — NOT platformFormats.safeArea, which Remotion
 * never reads.
 *
 * BLAST: PMAX_VIDEO_SAFE_ZONE_KEY.meta_reels_9_16 → reels, so every production
 * Reels title uses this zone. Dropping the map entry silently reverts Reels to
 * `vertical` and re-opens the occlusion. Widening `vertical.right` instead
 * would move titling on every OTHER 9:16 surface that falls through to it.
 *
 * REVERT-PROOF: delete the `reels` key or the map entry → the
 * resolveSafeZoneKey / resolveSafeZone / wiring checks fail by name. Set
 * reels.right back to 0.075 → the stories-inequality and verticalYt-parity
 * checks go red. Widen vertical.right to 0.15 → the vertical-unchanged checks
 * go red.
 */

import {
  SAFE_ZONES,
  PMAX_VIDEO_SAFE_ZONE_KEY,
  resolveSafeZoneKey,
  resolveSafeZone,
} from '../remotion/lib/safeZones.js';

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('verifyReelsSafeZone\n');

// ── A. Reels resolves to its own zone, not the canvas fallback ──────────────
const reelsKey = resolveSafeZoneKey({ format: 'vertical', platformFormat: 'meta_reels_9_16' });
check("A1 resolveSafeZoneKey(meta_reels_9_16) === 'reels'",
  reelsKey === 'reels', `got ${reelsKey}`);
check("A2 resolveSafeZoneKey(meta_reels_9_16) is NOT the 'vertical' fallback",
  reelsKey !== 'vertical', `got ${reelsKey}`);

// The map is pinned independently of the resolver: a resolver rewrite that
// hardcoded the answer would still have to keep the wiring honest.
check("A3 PMAX_VIDEO_SAFE_ZONE_KEY.meta_reels_9_16 === 'reels'",
  PMAX_VIDEO_SAFE_ZONE_KEY?.meta_reels_9_16 === 'reels',
  `got ${PMAX_VIDEO_SAFE_ZONE_KEY?.meta_reels_9_16}`);

// resolveSafeZone is what stackContainerStyle actually calls.
const resolvedReels = resolveSafeZone({ format: 'vertical', platformFormat: 'meta_reels_9_16' });
check('A4 resolveSafeZone(meta_reels_9_16) returns SAFE_ZONES.reels',
  resolvedReels === SAFE_ZONES.reels);
check('A5 resolveSafeZone(meta_reels_9_16) is NOT SAFE_ZONES.vertical',
  resolvedReels !== SAFE_ZONES.vertical);

// ── B. Stories is untouched ─────────────────────────────────────────────────
const storiesKey = resolveSafeZoneKey({ format: 'vertical', platformFormat: 'meta_stories_9_16' });
check("B1 resolveSafeZoneKey(meta_stories_9_16) === 'stories'",
  storiesKey === 'stories', `got ${storiesKey}`);
check('B2 resolveSafeZone(meta_stories_9_16) returns SAFE_ZONES.stories',
  resolveSafeZone({ format: 'vertical', platformFormat: 'meta_stories_9_16' }) === SAFE_ZONES.stories);

// ── C. The PMax three still resolve to their YouTube zones ──────────────────
const pmax9 = resolveSafeZoneKey({ format: 'vertical', platformFormat: 'pmax_video_9_16' });
check("C1 resolveSafeZoneKey(pmax_video_9_16) === 'verticalYt'",
  pmax9 === 'verticalYt', `got ${pmax9}`);
const pmax16 = resolveSafeZoneKey({ format: 'landscape', platformFormat: 'pmax_video_16_9' });
check("C2 resolveSafeZoneKey(pmax_video_16_9) === 'landscapeYt'",
  pmax16 === 'landscapeYt', `got ${pmax16}`);
const pmax1 = resolveSafeZoneKey({ format: 'square', platformFormat: 'pmax_video_1_1' });
check("C3 resolveSafeZoneKey(pmax_video_1_1) === 'squareYt'",
  pmax1 === 'squareYt', `got ${pmax1}`);

// ── D. `vertical` is byte-unchanged ─────────────────────────────────────────
// It is the canvas-format fallback for every other 9:16 caller; widening it
// instead of adding a key would silently move titling on all of them.
const v = SAFE_ZONES.vertical;
const vKeys = Object.keys(v || {}).sort().join(',');
check('D1 SAFE_ZONES.vertical has exactly bottom,left,right,top',
  vKeys === 'bottom,left,right,top', `keys=${vKeys}`);
check('D2 SAFE_ZONES.vertical.top === 0.14', v?.top === 0.14, `top=${v?.top}`);
check('D3 SAFE_ZONES.vertical.bottom === 0.35', v?.bottom === 0.35, `bottom=${v?.bottom}`);
check('D4 SAFE_ZONES.vertical.left === 0.075', v?.left === 0.075, `left=${v?.left}`);
check('D5 SAFE_ZONES.vertical.right === 0.075 (NOT widened for Reels)',
  v?.right === 0.075, `right=${v?.right}`);

// ── E. The reels zone's own shape ───────────────────────────────────────────
const r = SAFE_ZONES.reels;
const s = SAFE_ZONES.stories;
const yt = SAFE_ZONES.verticalYt;
check('E1 SAFE_ZONES.reels is defined', !!r);
const rKeys = Object.keys(r || {}).sort().join(',');
check('E2 SAFE_ZONES.reels has exactly bottom,left,right,top',
  rKeys === 'bottom,left,right,top', `keys=${rKeys}`);
check('E3 reels.right === 0.15 (the rail reserve)', r?.right === 0.15, `right=${r?.right}`);
check('E4 reels.right > stories.right (Stories has no right rail)',
  r && s && r.right > s.right, `reels=${r?.right} stories=${s?.right}`);
check('E5 reels.right === verticalYt.right (the parity the comment claims)',
  r && yt && r.right === yt.right, `reels=${r?.right} verticalYt=${yt?.right}`);
check('E6 reels.top === vertical.top (pure right-edge change)',
  r && v && r.top === v.top, `reels=${r?.top} vertical=${v?.top}`);
check('E7 reels.bottom === vertical.bottom (deep bottom reserve preserved)',
  r && v && r.bottom === v.bottom, `reels=${r?.bottom} vertical=${v?.bottom}`);
check('E8 reels.left === vertical.left (pure right-edge change)',
  r && v && r.left === v.left, `reels=${r?.left} vertical=${v?.left}`);
// Reels and Stories must not be the same object OR the same numbers — that
// identity is the whole reason two Remotion passes were producing one file.
check('E9 reels and stories are not the same zone object', r !== s);
check('E10 reels and stories differ in at least one inset',
  r && s && (r.top !== s.top || r.bottom !== s.bottom || r.left !== s.left || r.right !== s.right));

// ── F. Fallback behaviour is exactly as before ──────────────────────────────
const unk = resolveSafeZoneKey({ format: 'vertical', platformFormat: 'totally_unknown_xyz' });
check("F1 unknown platformFormat + format:'vertical' → 'vertical'",
  unk === 'vertical', `got ${unk}`);
const nonsense = resolveSafeZoneKey({ format: 'nonsense' });
check("F2 resolveSafeZoneKey({format:'nonsense'}) → 'feed'",
  nonsense === 'feed', `got ${nonsense}`);
check("F3 resolveSafeZoneKey({}) → 'feed'",
  resolveSafeZoneKey({}) === 'feed', `got ${resolveSafeZoneKey({})}`);
check("F4 resolveSafeZoneKey() with no args → 'feed'",
  resolveSafeZoneKey() === 'feed', `got ${resolveSafeZoneKey()}`);
// The canvas format 'vertical' must NOT be hijacked by the new key: a plain
// 9:16 render with no platformFormat still gets the shared zone.
check("F5 format:'vertical' with no platformFormat still → 'vertical'",
  resolveSafeZoneKey({ format: 'vertical' }) === 'vertical',
  `got ${resolveSafeZoneKey({ format: 'vertical' })}`);
// 'reels' is not a canvas format, so classifyFormat can never produce it —
// but if a caller passes it as `format` the lookup must not explode.
check("F6 format:'reels' passed directly resolves without throwing",
  resolveSafeZoneKey({ format: 'reels' }) === 'reels');

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyReelsSafeZone: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyReelsSafeZone: ${passed}/${total} checks passed`);
