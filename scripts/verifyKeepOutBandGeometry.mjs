#!/usr/bin/env node
/**
 * verifyKeepOutBandGeometry.mjs — the band strips plateIntel SAMPLES must be
 * the strips remotion PAINTS, on every surface. Offline: no DB, no network,
 * no key. ESM because remotion/lib/safeZones.js is "type":"module" and this
 * harness's whole job is to pin the CJS mirror against the real ESM table.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * services/plateIntelService.js states its own contract above BANDS:
 *
 *   "Vertical extents of each band (fractions of H) — MUST match where
 *    remotion stacks actually paint, not crude frame-thirds."
 *
 * ...and then derives the literals from ONE surface, naming it:
 *
 *   "Anchor geometry (remotion/lib/safeZones.js ANCHOR_TOP + SAFE_ZONES.vertical)
 *    lowerThird top = 0.54; bottom-anchored content ends by 0.65 (1 - 0.35)
 *    -> sample strip [0.52, 0.65]."
 *
 * That arithmetic is right for `vertical` (bottom inset 0.35) and WRONG for
 * every surface whose bottom inset differs, because the literals were applied
 * to all of them. Bottom-anchored copy paints to (1 - safe.bottom):
 *
 *   zone         bottom   paints to   old strip end   UNTESTED
 *   vertical      0.35      0.65          0.65          —
 *   reels         0.35      0.65          0.65          —
 *   verticalYt    0.35      0.65          0.65          —
 *   landscapeYt   0.36      0.64          0.65          — (over-tested by 0.01)
 *   stories       0.14      0.86          0.65        0.65-0.86  (21% of H)
 *   squareYt      0.10      0.90          0.65        0.65-0.90  (25%)
 *   feed          0.06      0.94          0.65        0.65-0.94  (29%)
 *   square        0.06      0.94          0.65        0.65-0.94  (29%)
 *
 * On a 12-ad Meta video run that is NINE ads sampling a strip their copy does
 * not sit in — 3 meta_stories_9_16 (-> stories), 3 meta_feed_1_1 (-> square),
 * 3 meta_feed_4_5 (-> feed). Only the 3 reels rows were ever measured where
 * their text lands.
 *
 * WHY IT MATTERS THREE TIMES: all three consumers read these strips.
 *   1. FACE KEEP-OUT (applyFaceKeepOut -> bands[*].avoid) — a face below 0.65
 *      on stories/feed/square can never flag.
 *   2. BUSY / TEXTURE — the score resolveGroupAnchor uses to move copy off a
 *      printed garment wordmark (Canonical.jsx: "wordmark printed across the
 *      garment. Measured: bottom busy 0.199, top 0.144"). Measured on the wrong
 *      strip, a caption lands on the product's logo and nothing objects.
 *   3. MEDIAN LUMA — the dark-vs-light ink vote. Sampling where the text is NOT
 *      is precisely the failure the tightened geometry was written to fix (the
 *      Vuori contact-sheet note in that same comment). So correcting the strips
 *      makes the ink vote MORE correct, not riskier — that equivalence is the
 *      argument for changing a constant two consumers share, and B4 pins it.
 *
 * MEASURED EVIDENCE: on the 2026-08-21 Pelagic billable run, 3 of 12 vision-QC
 * verdicts failed `layout_safe_box` (scores 2/2/3). The meta_stories_9_16 one
 * reported "at t=5.0s and t=7.5s, the caption overlay is placed directly on top
 * of the primary back logo, obscuring the brand name and key graphic elements"
 * — t=5.0/7.5s is the close phase, authored at lowerThird, inside the untested
 * region. (The two reels failures are a DIFFERENT miss: reels' strip is
 * correct, so those are FACE_BAND_OVERLAP_THRESHOLD = 0.20 refusing a small
 * chest mark that cannot cover 20% of an 84%x14% band. Not fixed here.)
 *
 * INERTNESS is the reason this is landable: with safeZoneKey absent, or on any
 * surface whose insets are vertical's, bandsFor returns BANDS byte-identically.
 * It can only change a surface that provably violates the stated contract.
 * Group A pins that, and it is the check to run first if anything regresses.
 *
 * SCOPE: only the BOTTOM strip is derived. `top` is left literal because
 * BAND_FOR_ANCHOR maps both `top` (starts at safe.top) and `upperThird`
 * (fixed ANCHOR_TOP.upperThird = 0.135) onto it, so deriving from safe.top
 * alone would give feed/square [0.06, 0.20] and miss half an upperThird group.
 * C1 pins top/middle untouched so that stays a deliberate omission.
 *
 * MUTATIONS THAT MUST FAIL THIS FILE
 *   1. bandsFor returns BANDS unconditionally            -> B2, B3, F1 fail
 *   2. drop the `if (!z) return BANDS` fallback           -> A1 fails
 *   3. derive `top` from z.top as well                    -> C1 fails
 *   4. change any SURFACE_INSETS number                   -> B1 fails
 *   5. bandRect ignores its safeZoneKey argument          -> D1 fails
 *   6. remotionRenderService stops passing safeZoneKey    -> E1/E2 fail
 *   7. applyFaceKeepOut stops forwarding it to bandRect   -> D2 fails
 *   8. revert plateIntelService entirely                  -> A/B/C/D/F fail
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SAFE_ZONES, PMAX_VIDEO_SAFE_ZONE_KEY, ANCHOR_TOP } from '../remotion/lib/safeZones.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plateIntel = require('../services/plateIntelService');
const { bandsFor, BANDS, bandRect, SURFACE_INSETS } = plateIntel;

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); process.exitCode = 1; }
};
const j = (v) => JSON.stringify(v);
const r4 = (v) => Math.round(v * 1e4) / 1e4;

console.log('verifyKeepOutBandGeometry\n');

// ── A. INERTNESS. Absent/unknown key, and surfaces whose insets match the
//    literals, must be byte-identical to today. Run this first on a regression.
ok('A1 absent / empty / unknown safeZoneKey returns BANDS verbatim', () => {
  for (const k of [undefined, null, '', '   ', 'nope', 'STORIES_TYPO']) {
    assert.strictEqual(j(bandsFor(k)), j(BANDS), `bandsFor(${j(k)}) must equal BANDS`);
  }
});

ok('A2 vertical / reels / verticalYt are unchanged (bottom inset 0.35)', () => {
  for (const k of ['vertical', 'reels', 'verticalYt']) {
    assert.strictEqual(SAFE_ZONES[k].bottom, 0.35, `${k} inset moved; this check needs rewriting`);
    assert.strictEqual(j(bandsFor(k)), j(BANDS), `${k} must be byte-identical to BANDS`);
  }
});

ok('A3 bandsFor never mutates the shared BANDS object', () => {
  const before = j(BANDS);
  const b = bandsFor('feed');
  b.bottom[0] = 99; b.top[0] = 99;
  assert.strictEqual(j(BANDS), before, 'BANDS was mutated through a returned array');
});

// ── B. THE CROSS-MODULE PIN. This is the check that exists because the insets
//    are mirrored into CJS rather than imported.
ok('B1 SURFACE_INSETS mirrors remotion/lib/safeZones.js exactly', () => {
  for (const [k, v] of Object.entries(SURFACE_INSETS)) {
    const z = SAFE_ZONES[k];
    assert.ok(z, `SURFACE_INSETS has key "${k}" that SAFE_ZONES does not — stale mirror`);
    assert.strictEqual(v.bottom, z.bottom, `${k}.bottom mirror ${v.bottom} != SAFE_ZONES ${z.bottom}`);
    assert.strictEqual(v.top, z.top, `${k}.top mirror ${v.top} != SAFE_ZONES ${z.top}`);
  }
});

ok('B2 every REACHABLE surface is mirrored (none silently falls back)', () => {
  // Reachable = what resolveSafeZoneKey can return: the PMax/Meta map's values,
  // the canvas formats classifyFormat emits, and its 'feed' fallback.
  const reachable = new Set([
    ...Object.values(PMAX_VIDEO_SAFE_ZONE_KEY),
    'vertical', 'square', 'landscape', 'feed',
  ]);
  const missing = [...reachable].filter((k) => SAFE_ZONES[k] && !SURFACE_INSETS[k]);
  assert.deepStrictEqual(missing, [],
    `reachable surfaces missing from the mirror (they would sample the wrong strip): ${missing.join(', ')}`);
});

ok('B3 bottom strip ENDS where that surface stops painting (1 - safe.bottom)', () => {
  for (const k of Object.keys(SURFACE_INSETS)) {
    const expected = r4(1 - SAFE_ZONES[k].bottom);
    assert.strictEqual(bandsFor(k).bottom[1], expected,
      `${k}: strip ends ${bandsFor(k).bottom[1]}, copy paints to ${expected}`);
  }
});

ok('B4 bottom strip STARTS just above ANCHOR_TOP.lowerThird', () => {
  // The equivalence that justifies changing a constant the ink vote also reads:
  // the sampled strip is the painted strip, so both consumers get more correct
  // together. lowerThird is where bottom-anchored copy begins.
  assert.strictEqual(ANCHOR_TOP.lowerThird, 0.54, 'lowerThird moved; re-derive BAND_LEAD_IN');
  for (const k of Object.keys(SURFACE_INSETS)) {
    assert.strictEqual(bandsFor(k).bottom[0], 0.52,
      `${k}: strip starts ${bandsFor(k).bottom[0]}, expected 0.52 (0.54 - 0.02 lead-in)`);
  }
});

ok('B5 no strip is inverted or zero-height on any surface', () => {
  for (const k of [...Object.keys(SURFACE_INSETS), null, 'nope']) {
    for (const [band, [y0, y1]] of Object.entries(bandsFor(k))) {
      assert.ok(y1 > y0, `${k}/${band} inverted: [${y0}, ${y1}]`);
      assert.ok(y0 >= 0 && y1 <= 1, `${k}/${band} outside the frame: [${y0}, ${y1}]`);
    }
  }
});

// ── C. SCOPE. Only `bottom` is derived; the rest is a deliberate omission.
ok('C1 top and middle are untouched on every surface', () => {
  for (const k of Object.keys(SURFACE_INSETS)) {
    assert.strictEqual(j(bandsFor(k).top), j(BANDS.top), `${k}: top strip was derived — out of scope`);
    assert.strictEqual(j(bandsFor(k).middle), j(BANDS.middle), `${k}: middle strip was derived — out of scope`);
  }
});

// ── D. The keep-out rect, and that the surface actually reaches it.
ok('D1 bandRect is surface-aware', () => {
  const generic = bandRect('bottom');
  const stories = bandRect('bottom', 'stories');
  assert.strictEqual(generic.bottom, 0.65, 'bandRect with no surface must keep today geometry');
  assert.strictEqual(stories.bottom, 0.86, 'bandRect(bottom, stories) must reach 0.86');
  assert.strictEqual(bandRect('nope', 'stories'), null, 'unknown band key must return null');
});

ok('D2 applyFaceKeepOut forwards safeZoneKey into bandRect', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/plateIntelService.js'), 'utf8');
  const body = src.slice(src.indexOf('function applyFaceKeepOut'));
  assert.match(body, /bandRect\(\s*bandKey\s*,\s*opts\.safeZoneKey/,
    'applyFaceKeepOut must pass opts.safeZoneKey to bandRect, or every surface tests the vertical strip');
});

ok('D3 behavioural — content at y 0.66-0.86 flags `bottom` on stories, not on vertical', () => {
  // This band sits entirely BELOW the old 0.65 literal, so pre-fix it was
  // invisible on every surface. Post-fix it must flag on stories (whose copy
  // paints to 0.86) and must still NOT flag on vertical (paints to 0.65).
  const face = { left: 0.08, top: 0.66, right: 0.92, bottom: 0.86 };
  const mk = (key) => plateIntel.applyFaceKeepOut(
    { samples: [{ atSec: 1, bands: { top: {}, middle: {}, bottom: {} } }] },
    [{ atSec: 1, face }],
    { safeZoneKey: key }
  );
  assert.strictEqual(mk('stories').samples[0].bands.bottom.avoid, true,
    'stories: content at 0.66-0.86 sits under the close-phase copy and must flag');
  assert.notStrictEqual(mk('vertical').samples[0].bands.bottom.avoid, true,
    'vertical: 0.66-0.86 is below where its copy paints, so it must NOT flag');
});

ok('D4 KNOWN, NOT FIXED — a wider strip is HARDER to trip, because the overlap '
 + 'fraction divides by band area', () => {
  // overlap = inter / bandArea (bandFaceOverlapFrac). Widening stories' bottom
  // strip from height 0.13 to 0.34 multiplies the denominator by ~2.6, so a
  // small mark needs ~2.6x the area to clear FACE_BAND_OVERLAP_THRESHOLD.
  // That is backwards — a LARGER painted region should be EASIER to collide
  // with — and it is why this change alone does not close the two
  // meta_reels_9_16 `layout_safe_box` failures from 2026-08-21, which are
  // small chest marks rather than large back logos.
  //
  // Pinned deliberately so the interaction is a recorded decision, not a
  // surprise. Fixing it means changing the denominator (e.g. inter/faceArea,
  // "how much of the mark would be covered"), which alters behaviour on EVERY
  // surface including the ones this change leaves byte-identical — a separate
  // decision with a much wider blast radius, not something to fold in here.
  const small = { left: 0.30, top: 0.70, right: 0.70, bottom: 0.80 };
  const frac = plateIntel.bandFaceOverlapFrac(bandRect('bottom', 'stories'), small);
  assert.ok(frac > 0, 'the widened strip must at least SEE content the old one missed');
  assert.ok(frac < plateIntel.FACE_BAND_OVERLAP_THRESHOLD,
    `expected the known shortfall: ${frac.toFixed(3)} is below the ${plateIntel.FACE_BAND_OVERLAP_THRESHOLD} `
    + 'threshold. If this now passes, the denominator or threshold changed — '
    + 'update this check and the PR note that documents the gap.');
  // And pin the improvement direction: the OLD geometry could not see it at all.
  assert.strictEqual(plateIntel.bandFaceOverlapFrac(bandRect('bottom'), small), 0,
    'the old vertical-derived strip must score exactly 0 on this mark');
});

// ── E. WIRING. The pure rule is worthless if the render path stops supplying
//    the surface. Source-shape, and labelled as such.
ok('E1 renderTitles passes safeZoneKey to analyzePlate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/remotionRenderService.js'), 'utf8');
  assert.match(src, /analyzePlate\(\s*platePath\s*,\s*\{[^}]*safeZoneKey[^}]*\}/s,
    'analyzePlate must receive safeZoneKey or the luma/busy strips stay wrong');
});

ok('E2 renderTitles passes safeZoneKey to applyFaceKeepOut', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/remotionRenderService.js'), 'utf8');
  const call = src.slice(src.indexOf('applyFaceKeepOut(plateHints'));
  assert.match(call.slice(0, 400), /safeZoneKey/,
    'applyFaceKeepOut must receive safeZoneKey or keep-out tests the wrong rect');
});

// ── F. THE DEFECT ITSELF, stated as a test so it cannot silently come back.
ok('F1 the four defective surfaces now test below 0.65', () => {
  for (const [k, paintsTo] of [['stories', 0.86], ['squareYt', 0.9], ['feed', 0.94], ['square', 0.94]]) {
    const end = bandsFor(k).bottom[1];
    assert.ok(end > 0.65, `${k}: strip still ends at ${end}; the blind region is not closed`);
    assert.strictEqual(end, paintsTo, `${k}: strip ends ${end}, copy paints to ${paintsTo}`);
  }
});

ok('F2 the untested region is now zero on every mirrored surface', () => {
  for (const k of Object.keys(SURFACE_INSETS)) {
    const gap = r4((1 - SAFE_ZONES[k].bottom) - bandsFor(k).bottom[1]);
    assert.strictEqual(gap, 0, `${k}: ${gap} of frame height below the strip is still untested`);
  }
});

if (process.exitCode) {
  console.log(`\n${checks} passed, and at least one FAILED — see ✗ above`);
} else {
  console.log(`${checks} checks passed`);
}
