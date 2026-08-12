#!/usr/bin/env node
/**
 * verifyLandscapeYtSafeZone.mjs — PMax 16:9 titling must reserve YouTube's
 * real bottom chrome band. Offline: no DB, no network. ESM because
 * remotion/lib/safeZones.js is "type":"module".
 *
 * THE DEFECT THIS PINS
 * --------------------
 * SAFE_ZONES.landscapeYt.bottom was 0.20. Google's official YouTube
 * horizontal safe-zone template (1920×1080 PNG, measured 2026-08-12) has a
 * fully blocked band below y=692 → 1080−692 = 388px = **35.9%** of frame
 * height. Title stacks clamped only to 20% sat under the player/ad chrome
 * on in-stream and were partially or fully occluded.
 *
 * Measured evidence (re-derive from the same PNG if this is ever disputed):
 *   source: https://services.google.com/fh/files/blogs/ytsafezoneoverlay-horizontal.png
 *   fully blocked above y=39 and below y=692
 *   mid-row clear span x=38..1758  (left≈2.0%, right≈8.4%)
 *   upper-row (y≈100) clear only x≈496..1444 — separate concern; left/right
 *   are deliberately NOT widened by this clamp fix.
 *
 * BLAST: PMAX_VIDEO_SAFE_ZONE_KEY.pmax_video_16_9 → landscapeYt, so every
 * production pmax_video_16_9 Remotion title uses this zone. A silent revert
 * of bottom to 0.20 re-opens the occlusion on all landscape PMax video.
 *
 * REVERT-PROOF: set landscapeYt.bottom back to 0.20 → this harness fails
 * the bottom-band check (and only that one, if left/top/right stay put).
 */

import {
  SAFE_ZONES,
  PMAX_VIDEO_SAFE_ZONE_KEY,
} from '../remotion/lib/safeZones.js';

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('verifyLandscapeYtSafeZone\n');

// Measured pixel evidence (see file-top block): bottom band ≥ 35.5% so a
// reversion to 0.20 turns this red while still allowing a 0.36 ship value.
const z = SAFE_ZONES.landscapeYt;
check('landscapeYt is defined', !!z);
check('landscapeYt.bottom reserves ≥35.5% (measured 35.9% → ship 0.36)',
  !!z && z.bottom >= 0.355,
  `bottom=${z?.bottom}`);
check('landscapeYt.top unchanged at 0.10', z && z.top === 0.10, `top=${z?.top}`);
check('landscapeYt.left unchanged at 0.075', z && z.left === 0.075, `left=${z?.left}`);
check('landscapeYt.right unchanged at 0.15', z && z.right === 0.15, `right=${z?.right}`);

// Wiring: the zone only protects the surface if the map still points here.
check(
  "PMAX_VIDEO_SAFE_ZONE_KEY.pmax_video_16_9 === 'landscapeYt'",
  PMAX_VIDEO_SAFE_ZONE_KEY?.pmax_video_16_9 === 'landscapeYt',
  `got ${PMAX_VIDEO_SAFE_ZONE_KEY?.pmax_video_16_9}`
);

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyLandscapeYtSafeZone: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyLandscapeYtSafeZone: ${passed}/${total} checks passed`);
