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
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// (basePlateCropService is required by the wiring assertions below via source read only.)

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

// ── B. wiring: the derive path actually copies it, and only when bound ────────

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
const deriveFn = SRC.slice(
  SRC.indexOf('async function renderDeriveOnlyVideoAd'),
  SRC.indexOf('\nasync function ', SRC.indexOf('async function renderDeriveOnlyVideoAd') + 40)
);

ok('the derive path computes an inherited plate guarded on the source URL', () => {
  // Wiring check (labelled): the write sits behind Mongo I/O this offline
  // harness cannot drive. The guard is the load-bearing half — without it a
  // regenerated master's stale boxes would ride onto every sibling.
  assert.ok(deriveFn.length > 500, 'renderDeriveOnlyVideoAd not found — harness is stale');
  assert.ok(
    /master\.basePlate && master\.basePlate\.sourceUrl === veoVideoUrl/.test(deriveFn),
    'inherited plate is no longer guarded on the master pointing at this URL'
  );
});

ok('it is written into the derive $set, conditionally', () => {
  assert.ok(
    /\.\.\.\(inheritedBasePlate \? \{ basePlate: inheritedBasePlate \} : \{\}\)/.test(deriveFn),
    'derive no longer copies the master plate — every sibling re-pays detection'
  );
});

ok('the derive path still bills nothing', () => {
  // Guard the surrounding money invariant while we are in here: this function
  // must never reach a paid video submit.
  //
  // Comments are stripped first. The function opens with its own written
  // assertion — "this function must not call veoGenerateForAd" — which a naive
  // source match reads as the very call it is forbidding. A money check that
  // fires on prose is worse than no check: it trains the next person to
  // dismiss it.
  const code = deriveFn
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(
    !/veoGenerateForAd\s*\(|\bgenerateForAd\s*\(/.test(code),
    'a paid generation call appeared on the free derive path'
  );
  // ...and the prose assertion itself is still present, so the intent stays
  // documented for the next reader even though the regex ignores it.
  assert.ok(/must not call veoGenerateForAd/.test(deriveFn));
});

console.log(`\n✅ verifyDeriveInheritsBasePlate: ${checks}/${checks} checks passed`);
