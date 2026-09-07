'use strict';
/**
 * verifyDeriveInheritsBasePlate — a free derive must inherit the master's face
 * detection, and must never inherit its crop.
 *
 * WHY THIS EXISTS (2026-08-12). Every derive-only ad — the free 1:1 crop and
 * all three PMax funnel retitles — renders from the master's exact
 * veoVideoUrl. But each was created with basePlate:null, so titling paid
 * basePlateCropService for a fresh vision pass (~$0.02) on footage the master
 * had already analysed. Four identical detections per master, for boxes that
 * were guaranteed to match.
 *
 * The sharing is safe by the cache's OWN stated contract, and this harness
 * pins both halves of it so a future edit cannot quietly break either:
 *
 *   SAFE TO SHARE — face boxes are stored in SOURCE fraction space, so they do
 *   not depend on the titling format. ensureFaceDetectionForKeepOut accepts any
 *   entry whose sourceUrl matches the ad's current veoVideoUrl.
 *
 *   MUST NOT SHARE — cropRect is format-specific. A 9:16 master's rect applied
 *   to a 1:1 derive would composite titles onto the wrong region. The consumer
 *   only honours rect when cached.format === the format being titled; this
 *   harness proves that gate still holds, because the inherit makes it
 *   load-bearing in a way it was not before.
 *
 * The binding invariant is also pinned: a stale entry (master regenerated, so
 * its plate points at replaced footage) must NOT be inherited — that would ship
 * keep-out boxes measured on a video the operator no longer has.
 *
 * REMOVED (dormant render fallback deletion): the B-group extract of
 * `routes/ads.js` `renderDeriveOnlyVideoAd` (the inherit `$set` lived there).
 * That function is gone with the in-process render loop; adgen's renderer
 * owns derive rendering now. The LIVE consumer of the sharing contract is
 * `services/basePlateCropService.js` `ensureFaceDetectionForKeepOut`, still
 * called from `brandScriptExecutor.js` titling. Group B now pins that
 * helper's sourceUrl + cropRect format gate, plus the absence of the
 * deleted derive function.
 *
 * Run: node scripts/verifyDeriveInheritsBasePlate.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; void label; };

console.log('verifyDeriveInheritsBasePlate\n');

const MASTER_URL = 'https://res.cloudinary.com/x/video/upload/v1/master.mp4';
const OTHER_URL  = 'https://res.cloudinary.com/x/video/upload/v1/regenerated.mp4';

// A master plate exactly as basePlateCropService persists one for a 9:16 crop.
const masterPlate = (sourceUrl = MASTER_URL) => ({
  version: 1,
  format: 'vertical',
  sourceUrl,
  videoUrl: 'https://res.cloudinary.com/x/video/upload/c_crop,w_1,h_1,x_0,y_0/v1/master.mp4',
  rect: { cx: 0, cy: 279, cw: 1080, ch: 1080 },
  sourceW: 1080,
  sourceH: 1920,
  frames: 3,
  faceHits: 3,
  envelope: { left: 0.3, right: 0.7, top: 0.1, bottom: 0.4 },
  faceSamples: [{ atSec: 0, face: { x1: 0.4, x2: 0.6, y1: 0.1, y2: 0.3 } }],
  facesComputed: true,
  computedAt: new Date()
});

// ── A. behavioural: the consumer's sharing contract ───────────────────────────

ok('same-source detection is reused across a DIFFERENT titling format', () => {
  // The 1:1 derive inherits a plate stamped format:'vertical'. The face boxes
  // must still be accepted — that is the whole saving.
  const ad = { _id: 'a1', veoVideoUrl: MASTER_URL, basePlate: masterPlate() };
  // ensureFaceDetectionForKeepOut is async, env-gated and does network I/O, so
  // this asserts the acceptance predicate it documents rather than calling it.
  const cached = ad.basePlate;
  const accepted = !!(cached && cached.sourceUrl === ad.veoVideoUrl && cached.facesComputed);
  assert.ok(accepted, 'inherited plate would be rejected — the saving is lost');
});

ok('a stale plate (master regenerated) is NOT inheritable', () => {
  const stale = masterPlate(OTHER_URL);
  const accepted = stale.sourceUrl === MASTER_URL;
  assert.ok(!accepted, 'a plate bound to replaced footage must never be inherited');
});

ok('cropRect stays format-scoped — a 9:16 rect is not usable by a 1:1 derive', () => {
  const cached = masterPlate();               // format 'vertical'
  const titlingFormat = 'square';             // the 1:1 derive
  const rectUsable = (cached.format === titlingFormat && cached.videoUrl && cached.rect);
  assert.ok(!rectUsable, 'the master crop leaked into a different format');
  // ...and remains usable for the format it was computed for.
  assert.ok(!!(cached.format === 'vertical' && cached.videoUrl && cached.rect));
});

// ── B. LIVE consumer (basePlateCropService) + ABSENCE of the deleted derive ──
// The inherit write used to live in routes/ads.js renderDeriveOnlyVideoAd
// (deleted with the in-process render loop). Adgen's renderer copies the
// plate at derive time. Backend titling still consumes Ad.basePlate through
// ensureFaceDetectionForKeepOut — that helper's format gate is what makes
// "share faces, never share crop" load-bearing.

const CROP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'basePlateCropService.js'), 'utf8'
);
const ADS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8'
);

ok('ensureFaceDetectionForKeepOut still accepts a plate whose sourceUrl matches the ad', () => {
  assert.ok(
    /cached\.sourceUrl === ad\.veoVideoUrl/.test(CROP_SRC)
      && /cached\.facesComputed/.test(CROP_SRC),
    'the live keep-out helper no longer reuses a same-source plate'
  );
});

ok('ensureFaceDetectionForKeepOut still gates cropRect on cached.format === format', () => {
  assert.ok(
    /cropRect:\s*\(cached\.format === format && cached\.videoUrl && cached\.rect\)/.test(CROP_SRC),
    'the live keep-out helper no longer format-scopes cropRect — a 9:16 rect would leak onto a 1:1 derive'
  );
});

ok('renderDeriveOnlyVideoAd is gone from routes/ads.js (adgen owns derive rendering)', () => {
  assert.ok(
    !/async function renderDeriveOnlyVideoAd\s*\(/.test(ADS_SRC),
    'the in-process derive renderer came back — this harness would need its wiring pins restored'
  );
});

console.log(`\n✅ verifyDeriveInheritsBasePlate: ${checks}/${checks} checks passed`);
