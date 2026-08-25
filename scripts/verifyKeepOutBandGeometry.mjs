#!/usr/bin/env node
/**
 * verifyKeepOutBandGeometry.mjs — the band strips plateIntel SAMPLES must be
 * the strips remotion PAINTS, on every surface. Offline: no DB, no network,
 * no key. ESM because src/remotion/lib/safeZones.js is "type":"module" (see
 * src/remotion/package.json) and this harness's whole job is to pin the CJS
 * mirror in src/services/plateIntelService.js against the real ESM table.
 *
 * PORTED from liquidretail_backend scripts/verifyKeepOutBandGeometry.mjs
 * (commit dabceaf4, PR #307), which adgen never received. Adapted for this
 * repo's layout (src/services/, src/remotion/) — see ADGEN DIVERGENCE below
 * for what additionally changed versus a straight copy.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * src/services/plateIntelService.js states its own contract above BANDS:
 *
 *   "Vertical extents of each band (fractions of H) — MUST match where
 *    remotion stacks actually paint, not crude frame-thirds."
 *
 * ...and then derives the literals from ONE surface, naming it:
 *
 *   "lowerThird top = 0.54; bottom-anchored content ends by 0.65 (1 - 0.35)
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
 * their text lands. (meta_stories_9_16/meta_reels_9_16 ARE explicit in
 * adgen's PMAX_VIDEO_SAFE_ZONE_KEY — see B2 below; feed/square are NOT, so
 * they fall through resolveSafeZoneKey -> classifyFormat -> square/feed,
 * exactly as the backend commit measured.)
 *
 * WHY IT MATTERS THREE TIMES: all three consumers read these strips.
 *   1. FACE KEEP-OUT (applyFaceKeepOut -> bands[*].avoid) — a face below 0.65
 *      on stories/feed/square can never flag.
 *   2. BUSY / TEXTURE — the score that moves copy off a printed garment
 *      wordmark. Measured on the wrong strip, a caption lands on the
 *      product's logo and nothing objects.
 *   3. MEDIAN LUMA — the dark-vs-light ink vote. Sampling where the text is
 *      NOT is precisely the failure the tightened geometry was written to
 *      fix, so correcting the strips makes the ink vote MORE correct too.
 *
 * INERTNESS is the reason this is landable: with safeZoneKey absent, or on
 * any surface whose insets are vertical's, bandsFor returns BANDS
 * byte-identically. It can only change a surface that provably violates the
 * stated contract. Group A pins that.
 *
 * SCOPE: only the BOTTOM strip is derived. `top` is left literal because
 * BAND_FOR_ANCHOR maps both `top` (starts at safe.top) and `upperThird`
 * (fixed ANCHOR_TOP.upperThird = 0.135) onto it, so deriving from safe.top
 * alone would give feed/square [0.06, 0.20] and miss half an upperThird
 * group. C1 pins top/middle untouched so that stays a deliberate omission.
 *
 * ADGEN DIVERGENCE FROM THE BACKEND HARNESS
 * ------------------------------------------
 * 1. Paths: ../src/services/plateIntelService (not ../services/...),
 *    ../src/remotion/lib/safeZones.js (not ../remotion/...).
 * 2. adgen's analyzePlate/semanticScan also thread brandId/productId/adId/
 *    campaignRunId for cost attribution (adgen's own #43 divergence, unseen
 *    on backend at the time #307 shipped there). H1/H2 below pin that this
 *    port did not regress that threading while adding safeZoneKey.
 * 3. adgen's real render body is `renderTitlesJob` (called by `renderTitles`,
 *    which itself either runs renderTitlesJob in-process under
 *    REMOTION_IN_CHILD=1 or spawns it via remotionChildSupervisor) — NOT a
 *    function literally named `renderTitles` containing the analyzePlate
 *    call, the way backend's file is structured. E1/E2 source-scan
 *    `renderTitlesJob`, not `renderTitles`.
 *
 * MUTATIONS THAT MUST FAIL THIS FILE
 *   1. bandsFor returns BANDS unconditionally            -> B2, B3, F1 fail
 *   2. drop the `if (!z) return BANDS` fallback           -> A1 fails
 *   3. derive `top` from z.top as well                    -> C1 fails
 *   4. change any SURFACE_INSETS number                   -> B1 fails
 *   5. bandRect ignores its safeZoneKey argument           -> D1 fails
 *   6. remotionRenderService stops passing safeZoneKey    -> E1/E2 fail
 *   7. applyFaceKeepOut stops forwarding it to bandRect    -> D2 fails
 *   8. drop the REFERENCE_BAND_H rescale in applyFaceKeepOut -> G2 fails
 *   9. change REFERENCE_BAND_H away from 0.13              -> G1/G3 fail
 *  10. revert plateIntelService entirely                   -> A/B/C/D/F/G fail
 *  11. drop brandId/productId/adId/campaignRunId from the
 *      renderTitlesJob analyzePlate call (adgen-only)       -> H1 fails
 *
 * GROUPS I/J/K — THE SECOND GAP, closed after the port above first landed.
 * A-H pin that bandsFor/bandRect/applyFaceKeepOut are surface-aware PURE
 * FUNCTIONS, and that renderTitlesJob/renderPreview forward whatever
 * safeZoneKey they are GIVEN (E1/E2/E3). None of that pins that anything
 * ever GIVES renderTitles a real key. It didn't: both call sites in
 * brandScriptExecutor.js had `platformFormat` in scope and passed it
 * straight through, but never computed `safeZoneKey` at all — so
 * renderTitles's default `safeZoneKey = null` is what every real render
 * used, `bandsFor(null)` returned BANDS every time, and A-H were all GREEN
 * throughout because they test the pure functions/internal forwarding
 * directly, never through the real call site. Same double no-op backend's
 * own PR #307 shipped (see that repo's session.d/2026-08-24_wire-
 * safezonekey-titling.md) — this port faithfully reproduced it.
 *
 * MUTATIONS THAT MUST FAIL I/J/K SPECIFICALLY
 *  12. resolveSafeZoneKeyCjs's PMAX map drifts from the real ESM one -> I1/I2 fail
 *  13. brandScriptExecutor.js's call site drops `safeZoneKey` (either
 *      renderTitles({...}) block, or both)                -> J1 fails
 *  14. brandScriptExecutor.js keeps the token but hardcodes
 *      `safeZoneKey: null` / never assigns it from the resolver -> J2 fails
 *  15. the resolver+bandsFor chain stops producing per-surface bands for a
 *      real (format, platformFormat) pair reachable in production -> K1 fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SAFE_ZONES, PMAX_VIDEO_SAFE_ZONE_KEY, ANCHOR_TOP, resolveSafeZoneKey } from '../src/remotion/lib/safeZones.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plateIntel = require('../src/services/plateIntelService');
const { bandsFor, BANDS, bandRect, SURFACE_INSETS, resolveSafeZoneKeyCjs, PMAX_VIDEO_SAFE_ZONE_KEY_CJS } = plateIntel;

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); process.exitCode = 1; }
};
const j = (v) => JSON.stringify(v);
const r4 = (v) => Math.round(v * 1e4) / 1e4;

console.log('verifyKeepOutBandGeometry (adgen port of backend #307)\n');

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
ok('B1 SURFACE_INSETS mirrors src/remotion/lib/safeZones.js exactly', () => {
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
  const src = fs.readFileSync(path.join(ROOT, 'src/services/plateIntelService.js'), 'utf8');
  const body = src.slice(src.indexOf('function applyFaceKeepOut'));
  assert.match(body, /bandRect\(\s*bandKey\s*,\s*opts\.safeZoneKey/,
    'applyFaceKeepOut must pass opts.safeZoneKey to bandRect, or every surface tests the vertical strip');
});

ok('D3 behavioural — content at y 0.66-0.86 flags `bottom` on stories, not on vertical', () => {
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

ok('D4 a NARROW small mark below 0.65 now flags on a widened surface', () => {
  const small = { left: 0.30, top: 0.70, right: 0.70, bottom: 0.80 };
  const mk = (key) => plateIntel.applyFaceKeepOut(
    { samples: [{ atSec: 1, bands: { top: {}, middle: {}, bottom: {} } }] },
    [{ atSec: 1, face: small }], { safeZoneKey: key }
  ).samples[0].bands.bottom.avoid;
  assert.strictEqual(mk('stories'), true, 'stories: a mark under the close copy must flag');
  assert.notStrictEqual(mk('vertical'), true,
    'vertical: 0.70-0.80 is below where its copy paints, so it must NOT flag');
});

// ── G. THE REGRESSION THIS ALMOST SHIPPED (backend caught it in a second
//    review round before merge — see dabceaf4's second commit message).
ok('G1 REFERENCE_BAND_H is the height the 0.20 threshold was tuned against', () => {
  assert.strictEqual(plateIntel.REFERENCE_BAND_H, 0.13,
    'changing this re-calibrates every keep-out threshold at once');
  assert.strictEqual(r4(BANDS.bottom[1] - BANDS.bottom[0]), 0.13,
    'the old literal strip height moved — REFERENCE_BAND_H must be revisited');
});

ok('G2 NO DESENSITISATION — a face inside the OLD strip still flags on every widened surface', () => {
  const mk = (key, face) => plateIntel.applyFaceKeepOut(
    { samples: [{ atSec: 1, bands: { top: {}, middle: {}, bottom: {} } }] },
    [{ atSec: 1, face }], { safeZoneKey: key }
  ).samples[0].bands.bottom.avoid;
  for (const h of [0.026, 0.03, 0.05, 0.068, 0.084]) {
    const face = { left: 0.08, top: 0.53, right: 0.92, bottom: 0.53 + h };
    assert.strictEqual(mk(null, face), true, `sanity: faceH ${h} must flag on old geometry`);
    for (const k of ['stories', 'feed', 'square', 'squareYt']) {
      assert.strictEqual(mk(k, face), true,
        `DESENSITISED: faceH ${h} flags on the old strip but not on ${k}`);
    }
  }
});

ok('G3 the rescale is exactly inert where the strip IS the reference height', () => {
  for (const k of [null, 'vertical', 'reels', 'verticalYt']) {
    const b = bandsFor(k);
    assert.strictEqual(r4(b.bottom[1] - b.bottom[0]), plateIntel.REFERENCE_BAND_H,
      `${k}: strip height must equal the reference, or its threshold shifts`);
  }
});

ok('G4 saturation is clamped — a full-frame union still just flags', () => {
  const huge = { left: 0.0, top: 0.0, right: 1.0, bottom: 1.0 };
  const mk = (key) => plateIntel.applyFaceKeepOut(
    { samples: [{ atSec: 1, bands: { top: {}, middle: {}, bottom: {} } }] },
    [{ atSec: 1, face: huge }], { safeZoneKey: key }
  ).samples[0].bands.bottom.avoid;
  for (const k of ['stories', 'feed', 'square', 'squareYt', 'vertical'])
    assert.strictEqual(mk(k), true, `${k}: a full-frame face must flag`);
});

ok('G5 reels is genuinely UNCHANGED, so its two known failures stay open', () => {
  assert.strictEqual(j(bandsFor('reels')), j(BANDS), 'reels must be byte-identical');
  assert.strictEqual(r4(bandsFor('reels').bottom[1] - bandsFor('reels').bottom[0]),
    plateIntel.REFERENCE_BAND_H, 'reels rescale multiplier must be exactly 1');
});

// ── E. WIRING. The pure rule is worthless if the render path stops supplying
//    the surface. Source-shape, and labelled as such. adgen's render body is
//    `renderTitlesJob` (see ADGEN DIVERGENCE above), not `renderTitles`.
ok('E1 renderTitlesJob passes safeZoneKey to analyzePlate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/remotionRenderService.js'), 'utf8');
  const body = src.slice(src.indexOf('async function renderTitlesJob'), src.indexOf('async function renderTitles('));
  assert.match(body, /analyzePlate\(\s*platePath\s*,\s*\{[^}]*safeZoneKey[^}]*\}/s,
    'analyzePlate must receive safeZoneKey or the luma/busy strips stay wrong');
});

ok('E2 renderTitlesJob passes safeZoneKey to applyFaceKeepOut', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/remotionRenderService.js'), 'utf8');
  const call = src.slice(src.indexOf('applyFaceKeepOut(plateHints'));
  assert.match(call.slice(0, 400), /safeZoneKey/,
    'applyFaceKeepOut must receive safeZoneKey or keep-out tests the wrong rect');
});

ok('E3 renderPreview passes safeZoneKey to BOTH its analyzePlate calls', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/remotionRenderService.js'), 'utf8');
  const body = src.slice(src.indexOf('async function renderPreview'));
  const calls = [...body.matchAll(/analyzePlate\(\s*[a-zA-Z.]+\s*,\s*\{[^}]*\}/gs)];
  assert.ok(calls.length >= 2, `expected at least 2 analyzePlate calls in renderPreview, found ${calls.length}`);
  for (const m of calls) {
    assert.match(m[0], /safeZoneKey/, `renderPreview analyzePlate call missing safeZoneKey: ${m[0]}`);
  }
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

// ── H. ADGEN-ONLY: the cost-attribution threading (brandId/productId/adId/
//    campaignRunId) must survive alongside safeZoneKey — this port must not
//    silently drop a divergence that predates it.
ok('H1 renderTitlesJob analyzePlate call still threads brandId/productId/adId/campaignRunId', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/remotionRenderService.js'), 'utf8');
  const body = src.slice(src.indexOf('async function renderTitlesJob'), src.indexOf('async function renderTitles('));
  const m = body.match(/analyzePlate\(\s*platePath\s*,\s*\{([^}]*)\}/s);
  assert.ok(m, 'analyzePlate(platePath, {...}) call not found in renderTitlesJob');
  for (const key of ['brandId', 'productId', 'adId', 'campaignRunId', 'safeZoneKey']) {
    assert.ok(m[1].includes(key), `analyzePlate options dropped "${key}" — adgen cost-attribution regressed`);
  }
});

ok('H2 plateIntelService.analyzePlate signature still accepts brandId/productId/adId/campaignRunId', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/plateIntelService.js'), 'utf8');
  const m = src.match(/async function analyzePlate\(platePath,\s*\{([^}]*)\}/s);
  assert.ok(m, 'analyzePlate signature not found');
  for (const key of ['brandId', 'productId', 'adId', 'campaignRunId', 'safeZoneKey']) {
    assert.ok(m[1].includes(key), `analyzePlate signature dropped "${key}"`);
  }
});

// Extract the full `renderTitles(...)` call expression starting at the '('
// right after the identifier, respecting nested parens/braces and simple
// string literals — a fixed-width slice is not safe here: adgen's two call
// sites sit at different indentation depths (top-level try vs. nested
// catch), and one embeds a nested ternary object literal
// (`faceKeepOut: faceKeepOut ? { ... } : null`), so a naive "next closing
// brace at N spaces" heuristic would either truncate early or overrun into
// the surrounding control flow.
function extractCallExpr(src, openParenIdx) {
  let depth = 0;
  let inStr = null;
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParenIdx, i + 1);
    }
  }
  return src.slice(openParenIdx); // unterminated (shouldn't happen) — fallback
}

// ── I. THE RESOLVER. resolveSafeZoneKeyCjs (src/services/plateIntelService.js)
//    is a MIRROR of the real ESM resolveSafeZoneKey, not an import (same
//    CJS/ESM-island reason SURFACE_INSETS mirrors SAFE_ZONES). Drift between
//    the two mappings is exactly the failure mode this port exists to guard
//    against — pin agreement in BOTH directions against the REAL source, not
//    a copy-pasted expectation list.
ok('I1 CJS resolver agrees with the real ESM resolver for every REAL PMAX_VIDEO_SAFE_ZONE_KEY entry', () => {
  for (const [pf, expectedKey] of Object.entries(PMAX_VIDEO_SAFE_ZONE_KEY)) {
    const esm = resolveSafeZoneKey({ platformFormat: pf });
    const cjs = resolveSafeZoneKeyCjs({ platformFormat: pf });
    assert.strictEqual(esm, expectedKey, `sanity: ESM resolver disagrees with its own map for ${pf}`);
    assert.strictEqual(cjs, esm, `DRIFT: resolveSafeZoneKeyCjs(${pf}) = "${cjs}", real resolveSafeZoneKey = "${esm}"`);
  }
});

ok('I2 CJS resolver mirror has the SAME key set as the real ESM map (no stale/extra entries either direction)', () => {
  const esmKeys = Object.keys(PMAX_VIDEO_SAFE_ZONE_KEY).sort();
  const cjsKeys = Object.keys(PMAX_VIDEO_SAFE_ZONE_KEY_CJS).sort();
  assert.deepStrictEqual(cjsKeys, esmKeys,
    `mirror key set drifted from the real map: cjs=[${cjsKeys}] esm=[${esmKeys}]`);
});

ok('I3 CJS resolver agrees with ESM on every canvas format (no platformFormat) and on absent/unknown', () => {
  for (const format of ['vertical', 'feed', 'square', 'landscape', undefined, null, 'not-a-real-format']) {
    for (const platformFormat of [undefined, null, '', 'not_a_real_platform_format']) {
      const esm = resolveSafeZoneKey({ format, platformFormat });
      const cjs = resolveSafeZoneKeyCjs({ format, platformFormat });
      assert.strictEqual(cjs, esm,
        `DRIFT at format=${format} platformFormat=${platformFormat}: cjs="${cjs}" esm="${esm}"`);
    }
  }
});

ok('I4 case/whitespace handling matches (resolver lowercases + trims platformFormat)', () => {
  for (const pf of ['  META_STORIES_9_16  ', 'Pmax_Video_1_1']) {
    assert.strictEqual(resolveSafeZoneKeyCjs({ platformFormat: pf }), resolveSafeZoneKey({ platformFormat: pf }),
      `case/whitespace handling drifted for "${pf}"`);
  }
});

// ── J. THE CALL SITE. The pure resolver + bandsFor chain is worthless if
//    nothing at the real render call site invokes it. THIS is the check that
//    would have caught the original port gap — it fails on source text that
//    has bandsFor/bandRect fully wired (groups A-H green) but no caller ever
//    computing a real safeZoneKey, which is exactly the state this port
//    shipped and merged.
ok('J1 brandScriptExecutor.js passes safeZoneKey on BOTH renderTitles call sites', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/brandScriptExecutor.js'), 'utf8');
  const starts = [...src.matchAll(/renderTitles\(/g)].map((m) => m.index + m[0].length - 1);
  assert.ok(starts.length >= 2, `expected >=2 renderTitles(...) call sites, found ${starts.length}`);
  for (const openIdx of starts) {
    const block = extractCallExpr(src, openIdx);
    assert.match(block, /\bsafeZoneKey\b/,
      `renderTitles(...) call at offset ${openIdx} has no safeZoneKey — the #307 port cannot fire from this call site`);
  }
});

ok('J2 safeZoneKey is assigned from resolveSafeZoneKeyCjs, not a bare null/undefined literal', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/brandScriptExecutor.js'), 'utf8');
  assert.match(src, /const\s+safeZoneKey\s*=\s*resolveSafeZoneKeyCjs\(\s*\{\s*format\s*,\s*platformFormat\s*\}\s*\)/,
    'safeZoneKey must be assigned from resolveSafeZoneKeyCjs({format, platformFormat}) — a decoy `safeZoneKey: null` would satisfy a naive presence check');
  assert.doesNotMatch(src, /safeZoneKey\s*:\s*null\b/,
    'found a hardcoded `safeZoneKey: null` — this is exactly the shape of the original inert call site');
});

ok('J3 resolveSafeZoneKeyCjs is actually imported from plateIntelService in brandScriptExecutor.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/brandScriptExecutor.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/plateIntelService['"]\)/, 'plateIntelService must be required');
  const reqLine = src.split('\n').find((l) => l.includes("require('./plateIntelService')"));
  assert.match(reqLine || '', /resolveSafeZoneKeyCjs/,
    'resolveSafeZoneKeyCjs must be destructured off the plateIntelService require, or the call site throws ReferenceError at runtime');
});

// ── K. END-TO-END BEHAVIOURAL PROOF. Execute the real resolver -> bandsFor
//    chain for the (format, platformFormat) pairs an actual Ad document
//    carries in production, and show the strip actually widens for the four
//    named-defective surfaces and stays byte-identical for the rest.
const REAL_AD_SHAPES = [
  { label: 'meta_stories_9_16 -> stories',   format: 'vertical', platformFormat: 'meta_stories_9_16', expectKey: 'stories',   expectChanged: true },
  { label: 'pmax_video_1_1 -> squareYt',     format: 'square',   platformFormat: 'pmax_video_1_1',     expectKey: 'squareYt',  expectChanged: true },
  { label: 'meta_feed_4_5 -> feed',          format: 'feed',     platformFormat: 'meta_feed_4_5',      expectKey: 'feed',      expectChanged: true },
  { label: 'meta_feed_1_1 -> square',        format: 'square',   platformFormat: 'meta_feed_1_1',      expectKey: 'square',   expectChanged: true },
  { label: 'meta_reels_9_16 -> reels',       format: 'vertical', platformFormat: 'meta_reels_9_16',    expectKey: 'reels',     expectChanged: false },
  { label: 'pmax_video_9_16 -> verticalYt',  format: 'vertical', platformFormat: 'pmax_video_9_16',    expectKey: 'verticalYt', expectChanged: false },
  { label: 'meta_video_9_16 master -> vertical (no platformFormat mapping)', format: 'vertical', platformFormat: 'meta_video_9_16', expectKey: 'vertical', expectChanged: false },
];

ok('K1 real Ad (format, platformFormat) shapes resolve to a non-null key and bandsFor widens exactly the 4 defective surfaces', () => {
  for (const { label, format, platformFormat, expectKey, expectChanged } of REAL_AD_SHAPES) {
    const key = resolveSafeZoneKeyCjs({ format, platformFormat });
    assert.ok(key, `${label}: resolver returned falsy key`);
    assert.strictEqual(key, expectKey, `${label}: resolved "${key}", expected "${expectKey}"`);
    const bands = bandsFor(key);
    const changed = j(bands) !== j(BANDS);
    assert.strictEqual(changed, expectChanged,
      `${label}: bandsFor("${key}") changed=${changed}, expected ${expectChanged} (bottom=${j(bands.bottom)} vs BANDS.bottom=${j(BANDS.bottom)})`);
  }
});

ok('K2 an ad whose platformFormat is null (legacy row / no PMax mapping) still resolves to a real, non-inverted key', () => {
  for (const format of ['vertical', 'feed', 'square', 'landscape']) {
    const key = resolveSafeZoneKeyCjs({ format, platformFormat: null });
    assert.strictEqual(key, format, `legacy row with format="${format}" must resolve to itself, got "${key}"`);
    const bands = bandsFor(key);
    assert.ok(bands.bottom[1] > bands.bottom[0], `${format}: legacy-row key produced an inverted strip`);
  }
});

ok('K3 a genuinely unrecognised (format, platformFormat) pair still fails closed to "feed", never to an inverted or garbage key', () => {
  const key = resolveSafeZoneKeyCjs({ format: 'not-a-format', platformFormat: 'not-a-platform-format' });
  assert.strictEqual(key, 'feed', 'must fail closed to feed, matching the real ESM resolver');
  const bands = bandsFor(key);
  assert.ok(bands.bottom[1] > bands.bottom[0], 'feed fallback must not itself be an inverted strip');
  assert.strictEqual(j(bandsFor('totally-bogus-key')), j(BANDS),
    'bandsFor must still fall back to BANDS verbatim on a key with no SURFACE_INSETS entry at all');
});

if (process.exitCode) {
  console.log(`\n${checks} passed, and at least one FAILED — see ✗ above`);
} else {
  console.log(`${checks} checks passed`);
}
