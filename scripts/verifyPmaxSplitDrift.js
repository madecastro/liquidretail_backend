#!/usr/bin/env node
'use strict';
/**
 * verifyPmaxSplitDrift — offline suite for decideSplitPanelDrift in services/basePlateCropService.js.
 *
 * THE DEFECT THIS PREVENTS. The PMax 16:9 split-stage unit (env PMAX_SPLIT_VIDEO) seeds the
 * product into a vertical band on one side of a 1920x1080 frame and generatively extends the other
 * side, which then carries composited ad copy. The seed places the subject correctly, but the
 * VIDEO MODEL can drift the subject across the panel boundary as the clip progresses — the seed-time
 * gate cannot see that, because it only ever looks at what was fed IN, not what came OUT. If a
 * drifted render is titled anyway, the ad copy gets composited on top of the product on a render
 * that has already been paid for. decideSplitPanelDrift is the post-render check that catches this
 * BEFORE titling so the caller can fall back to the centred layout instead — this suite pins its
 * decision logic so a future edit cannot reintroduce the failure silently (in particular: checking
 * only the first sampled frame instead of the worst, or inverting which side is "safe" for a given
 * panelSide, both of which would ship the exact defect described above with every test still green
 * unless they are specifically exercised, which is what section D and section M below do).
 *
 * No DB, no network, no vision calls — decideSplitPanelDrift is pure. Safe in CI.
 */

const assert = require('assert');
const {
  decideSplitPanelDrift, SPLIT_PANEL_SIDES, DEFAULT_DRIFT_TOLERANCE_FRAC,
} = require('../services/basePlateCropService');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

console.log('\nverifyPmaxSplitDrift\n');

// A panel width used throughout — arbitrary but plausible for a copy column (not 0.5, so the
// west/east intervals are visibly asymmetric and a swapped start/end would show up immediately).
const PANEL_W = 0.4;
const TOL = DEFAULT_DRIFT_TOLERANCE_FRAC;

// Build a subject box spanning [left,right] horizontally with an arbitrary-but-valid vertical
// extent (vertical never matters to this function — only the panelSide/panelWidthFrac/tolerance
// axis is under test here, and using the SAME vertical span everywhere makes that explicit).
const box = (left, right) => ({ left, top: 0.1, right, bottom: 0.9 });

// ── S. sanity on the exported vocabulary (so the fixtures below can't silently drift from it) ────
check('S1 SPLIT_PANEL_SIDES is exactly west/east', () => {
  assert.deepStrictEqual([...SPLIT_PANEL_SIDES].sort(), ['east', 'west']);
});
check('S2 DEFAULT_DRIFT_TOLERANCE_FRAC is a small positive fraction', () => {
  assert.ok(Number.isFinite(DEFAULT_DRIFT_TOLERANCE_FRAC));
  assert.ok(DEFAULT_DRIFT_TOLERANCE_FRAC > 0 && DEFAULT_DRIFT_TOLERANCE_FRAC < 0.5);
});

// ── C. subject fully clear of the panel, BOTH sides ────────────────────────────────────────────
check('C1 west panel: subject entirely on the right (safe) side -> not drifted', () => {
  const d = decideSplitPanelDrift({
    frameBoxes: [box(0.5, 0.95)], panelSide: 'west', panelWidthFrac: PANEL_W,
  });
  assert.deepStrictEqual(d, { drifted: false });
});
check('C2 east panel: subject entirely on the left (safe) side -> not drifted', () => {
  const d = decideSplitPanelDrift({
    frameBoxes: [box(0.05, 0.45)], panelSide: 'east', panelWidthFrac: PANEL_W,
  });
  assert.deepStrictEqual(d, { drifted: false });
});

// ── D. subject squarely inside the panel -> drifted, with the correct reason ──────────────────
check('D1 west panel: subject entirely inside the panel -> drifted, reason names the side', () => {
  const d = decideSplitPanelDrift({
    frameBoxes: [box(0.05, 0.35)], panelSide: 'west', panelWidthFrac: PANEL_W,
  });
  assert.strictEqual(d.drifted, true);
  assert.strictEqual(d.reason, 'subject-in-west-panel');
  assert.strictEqual(d.atFrame, 0);
  assert.ok(d.worstOverlapFrac > TOL, `expected a large overlap, got ${d.worstOverlapFrac}`);
});
check('D2 east panel: subject entirely inside the panel -> drifted, reason names the side', () => {
  const d = decideSplitPanelDrift({
    frameBoxes: [box(0.65, 0.95)], panelSide: 'east', panelWidthFrac: PANEL_W,
  });
  assert.strictEqual(d.drifted, true);
  assert.strictEqual(d.reason, 'subject-in-east-panel');
});

// ── B. tolerance boundary, pinned both ways, both sides ────────────────────────────────────────
// Construct an overlap of exactly PANEL_W*(TOL-delta) (safe) and PANEL_W*(TOL+delta) (drifted),
// well clear of floating-point noise (delta = 0.01, i.e. ~17% of TOL at the default 0.06).
const DELTA = 0.01;
check('B1 west panel: grazing just WITHIN tolerance -> not drifted', () => {
  const overlapFrac = TOL - DELTA;
  const left = PANEL_W - overlapFrac * PANEL_W; // intrudes overlapFrac*PANEL_W past the inner edge
  const d = decideSplitPanelDrift({
    frameBoxes: [box(left, 0.5)], panelSide: 'west', panelWidthFrac: PANEL_W,
  });
  assert.strictEqual(d.drifted, false, JSON.stringify(d));
});
check('B2 west panel: JUST BEYOND tolerance -> drifted', () => {
  const overlapFrac = TOL + DELTA;
  const left = PANEL_W - overlapFrac * PANEL_W;
  const d = decideSplitPanelDrift({
    frameBoxes: [box(left, 0.5)], panelSide: 'west', panelWidthFrac: PANEL_W,
  });
  assert.strictEqual(d.drifted, true, JSON.stringify(d));
  assert.ok(Math.abs(d.worstOverlapFrac - overlapFrac) < 1e-9);
});
check('B3 east panel: grazing just WITHIN tolerance -> not drifted (mirror of B1)', () => {
  const overlapFrac = TOL - DELTA;
  const right = (1 - PANEL_W) + overlapFrac * PANEL_W;
  const d = decideSplitPanelDrift({
    frameBoxes: [box(0.5, right)], panelSide: 'east', panelWidthFrac: PANEL_W,
  });
  assert.strictEqual(d.drifted, false, JSON.stringify(d));
});
check('B4 east panel: JUST BEYOND tolerance -> drifted (mirror of B2)', () => {
  const overlapFrac = TOL + DELTA;
  const right = (1 - PANEL_W) + overlapFrac * PANEL_W;
  const d = decideSplitPanelDrift({
    frameBoxes: [box(0.5, right)], panelSide: 'east', panelWidthFrac: PANEL_W,
  });
  assert.strictEqual(d.drifted, true, JSON.stringify(d));
});
check('B5 a caller-supplied tolerance overrides the default', () => {
  // Same geometry as B1 (safe under the default), but a tighter caller tolerance of 0 makes any
  // nonzero overlap count as drift — proves `tolerance` is actually consulted, not just accepted.
  const overlapFrac = TOL - DELTA;
  const left = PANEL_W - overlapFrac * PANEL_W;
  const d = decideSplitPanelDrift({
    frameBoxes: [box(left, 0.5)], panelSide: 'west', panelWidthFrac: PANEL_W, tolerance: 0,
  });
  assert.strictEqual(d.drifted, true, JSON.stringify(d));
});

// ── L. drift in a LATE frame only — the case the seed-time gate cannot see ─────────────────────
check('L1 only the LAST of several frames drifts -> still drifted, atFrame identifies it', () => {
  const safe = box(0.5, 0.95);          // clear of the west panel
  const drifted = box(0.05, 0.35);      // squarely inside the west panel
  const d = decideSplitPanelDrift({
    frameBoxes: [safe, safe, safe, drifted], panelSide: 'west', panelWidthFrac: PANEL_W,
  });
  assert.strictEqual(d.drifted, true);
  assert.strictEqual(d.atFrame, 3, 'atFrame must point at the late frame that actually drifted');
});
check('L2 a missing/garbage frame between good frames does not hide a late drift', () => {
  const safe = box(0.5, 0.95);
  const garbage = null;
  const drifted = box(0.05, 0.35);
  const d = decideSplitPanelDrift({
    frameBoxes: [safe, garbage, drifted], panelSide: 'west', panelWidthFrac: PANEL_W,
  });
  assert.strictEqual(d.drifted, true);
  assert.strictEqual(d.atFrame, 2);
});

// ── W. worstOverlapFrac is the WORST frame, not the first and not the average ──────────────────
check('W1 worstOverlapFrac is the maximum across frames, reported from the middle frame', () => {
  // Overlap fractions 0.10 (idx0), 0.75 (idx1), 0.30 (idx2). First = 0.10, average ~= 0.383,
  // max = 0.75 at idx1. A "first frame" or "average" bug would both fail this assertion.
  const atOverlap = (overlapFrac) => box(PANEL_W - overlapFrac * PANEL_W, 0.5);
  const d = decideSplitPanelDrift({
    frameBoxes: [atOverlap(0.10), atOverlap(0.75), atOverlap(0.30)],
    panelSide: 'west', panelWidthFrac: PANEL_W,
  });
  assert.strictEqual(d.drifted, true);
  assert.strictEqual(d.atFrame, 1);
  assert.ok(Math.abs(d.worstOverlapFrac - 0.75) < 1e-9, `expected 0.75, got ${d.worstOverlapFrac}`);
  const first = 0.10;
  const average = (0.10 + 0.75 + 0.30) / 3;
  assert.notStrictEqual(d.worstOverlapFrac, first);
  assert.ok(Math.abs(d.worstOverlapFrac - average) > 0.1, 'result looks like an average, not a max');
});

// ── M. mirror sweep — same geometry, flipped panelSide, opposite verdict ───────────────────────
// Proves the west/east interval table is not inverted: a subject sitting in the RIGHT half is safe
// against a west (left) panel and drifted against an east (right) panel occupying the same geometry.
check('M1 mirror sweep: identical frameBoxes flip the verdict when panelSide flips', () => {
  const frameBoxes = [box(0.5, 0.9)];
  const west = decideSplitPanelDrift({ frameBoxes, panelSide: 'west', panelWidthFrac: PANEL_W });
  const east = decideSplitPanelDrift({ frameBoxes, panelSide: 'east', panelWidthFrac: PANEL_W });
  assert.strictEqual(west.drifted, false, `west: ${JSON.stringify(west)}`);
  assert.strictEqual(east.drifted, true, `east: ${JSON.stringify(east)}`);
});
check('M2 mirror sweep the other way: a subject in the LEFT half flips too', () => {
  const frameBoxes = [box(0.1, 0.5)];
  const west = decideSplitPanelDrift({ frameBoxes, panelSide: 'west', panelWidthFrac: PANEL_W });
  const east = decideSplitPanelDrift({ frameBoxes, panelSide: 'east', panelWidthFrac: PANEL_W });
  assert.strictEqual(west.drifted, true, `west: ${JSON.stringify(west)}`);
  assert.strictEqual(east.drifted, false, `east: ${JSON.stringify(east)}`);
});

// ── X. malformed input battery — undecidable, never throws, never a bare boolean ───────────────
function assertUndecidable(label, args) {
  check(label, () => {
    let d;
    assert.doesNotThrow(() => { d = decideSplitPanelDrift(args); });
    assert.strictEqual(typeof d, 'object');
    assert.notStrictEqual(d, null);
    assert.notStrictEqual(d, true, 'must not return a bare boolean');
    assert.notStrictEqual(d, false, 'must not return a bare boolean');
    assert.strictEqual(d.drifted, null, JSON.stringify(d));
    assert.strictEqual(typeof d.reason, 'string');
    assert.ok(d.reason.length > 0);
  });
}

assertUndecidable('X1 empty frameBoxes array -> undecidable', {
  frameBoxes: [], panelSide: 'west', panelWidthFrac: PANEL_W,
});
assertUndecidable('X2 frameBoxes null -> undecidable (not thrown as a TypeError)', {
  frameBoxes: null, panelSide: 'west', panelWidthFrac: PANEL_W,
});
assertUndecidable('X3 frameBoxes missing entirely -> undecidable', {
  panelSide: 'west', panelWidthFrac: PANEL_W,
});
assertUndecidable('X4 no argument object at all -> undecidable', undefined);
assertUndecidable('X5 NaN coordinate -> undecidable', {
  frameBoxes: [{ left: NaN, top: 0.1, right: 0.5, bottom: 0.9 }],
  panelSide: 'west', panelWidthFrac: PANEL_W,
});
assertUndecidable('X6 inverted box (x2 < x1) -> undecidable', {
  frameBoxes: [{ left: 0.6, top: 0.1, right: 0.3, bottom: 0.9 }],
  panelSide: 'west', panelWidthFrac: PANEL_W,
});
assertUndecidable('X7 inverted box vertically (bottom < top) -> undecidable', {
  frameBoxes: [{ left: 0.1, top: 0.9, right: 0.5, bottom: 0.2 }],
  panelSide: 'west', panelWidthFrac: PANEL_W,
});
assertUndecidable('X8 missing fields on every box -> undecidable', {
  frameBoxes: [{ left: 0.1, top: 0.2 }, {}],
  panelSide: 'west', panelWidthFrac: PANEL_W,
});
assertUndecidable('X9 all frames null/garbage -> undecidable, not a silent "safe"', {
  frameBoxes: [null, undefined, 'not-a-box', 42],
  panelSide: 'west', panelWidthFrac: PANEL_W,
});
assertUndecidable('X10 bad panelSide -> undecidable', {
  frameBoxes: [box(0.5, 0.9)], panelSide: 'north', panelWidthFrac: PANEL_W,
});
assertUndecidable('X11 missing panelSide -> undecidable', {
  frameBoxes: [box(0.5, 0.9)], panelWidthFrac: PANEL_W,
});
for (const bad of [0, 1, -0.2, 1.5, NaN, undefined, 'half']) {
  assertUndecidable(`X12 bad panelWidthFrac (${JSON.stringify(bad)}) -> undecidable`, {
    frameBoxes: [box(0.5, 0.9)], panelSide: 'west', panelWidthFrac: bad,
  });
}

// A valid call must NOT be undecidable — guards against the battery above being vacuously true
// because every fixture is somehow malformed.
check('X13 sanity: a well-formed call is decidable (not null)', () => {
  const d = decideSplitPanelDrift({
    frameBoxes: [box(0.5, 0.9)], panelSide: 'west', panelWidthFrac: PANEL_W,
  });
  assert.notStrictEqual(d.drifted, null);
});

if (failures.length) {
  console.error(`❌ verifyPmaxSplitDrift: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyPmaxSplitDrift: ${pass}/${pass} checks passed`);
