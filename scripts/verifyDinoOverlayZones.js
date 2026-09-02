#!/usr/bin/env node
// Offline pins for services/dinoOverlayZoneService.js. Pure-math helpers
// so the harness runs with fixture bboxes and zero I/O — the same
// discipline verifyReframeStrategy.js follows for reframeStrategyChooser.

'use strict';

const assert = require('assert');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const svc = require('../services/dinoOverlayZoneService');
const {
  reprojectBboxToCrop,
  buildDensityGrid,
  classifyDinoLabel,
  pickGridDims,
  derivePrimarySubjectRectPct,
  SCHEMA_VERSION,
  RESTRICTION_CLASSES,
  LABEL_PATTERNS
} = svc.__test;

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

// ── Section 1: reprojectBboxToCrop ────────────────────────────────────

console.log('\n== 1. reprojectBboxToCrop — source → crop-local fractional coords ==');

check('R1 identity: bbox equals crop → rectPct spans full [0..1]', () => {
  const out = reprojectBboxToCrop(
    { x1: 100, y1: 200, x2: 500, y2: 800 },
    { x1: 100, y1: 200, x2: 500, y2: 800 }
  );
  assert.deepStrictEqual(out, { x1: 0, y1: 0, x2: 1, y2: 1 });
});

check('R2 bbox fully inside crop → normalized fractions', () => {
  // crop is 200..800 x 100..700 (width 600, height 600)
  // bbox is 300..500 x 200..400 → (100, 100) - (300, 300) in crop coords
  const out = reprojectBboxToCrop(
    { x1: 300, y1: 200, x2: 500, y2: 400 },
    { x1: 200, y1: 100, x2: 800, y2: 700 }
  );
  assert.deepStrictEqual(out, {
    x1: 100 / 600, y1: 100 / 600, x2: 300 / 600, y2: 300 / 600
  });
});

check('R3 bbox outside crop → null (no overlap)', () => {
  const out = reprojectBboxToCrop(
    { x1: 900, y1: 900, x2: 1000, y2: 1000 },
    { x1: 0, y1: 0, x2: 500, y2: 500 }
  );
  assert.strictEqual(out, null);
});

check('R4 bbox partially clipped by crop → clamped to intersection', () => {
  // Bbox extends beyond right edge of crop — intersection is
  // x1=400, y1=100, x2=500, y2=300 → normalized (0.5, 0, 1.0, 0.5)
  const out = reprojectBboxToCrop(
    { x1: 400, y1: 100, x2: 700, y2: 300 },
    { x1: 200, y1: 100, x2: 500, y2: 500 }
  );
  assert.strictEqual(out.x1, (400 - 200) / (500 - 200));
  assert.strictEqual(out.x2, 1.0);   // clamped to crop right edge
  assert.strictEqual(out.y1, 0);     // intersection top = crop top
  assert.strictEqual(out.y2, (300 - 100) / (500 - 100));
});

check('R5 malformed inputs → null (fail-closed)', () => {
  assert.strictEqual(reprojectBboxToCrop(null, { x1: 0, y1: 0, x2: 100, y2: 100 }), null);
  assert.strictEqual(reprojectBboxToCrop({ x1: 0, y1: 0, x2: 100, y2: 100 }, null), null);
  // Degenerate crop (zero width)
  assert.strictEqual(reprojectBboxToCrop(
    { x1: 0, y1: 0, x2: 100, y2: 100 },
    { x1: 500, y1: 0, x2: 500, y2: 100 }
  ), null);
});

check('R6 output coords are always in [0..1] (clamp math)', () => {
  const out = reprojectBboxToCrop(
    { x1: -50, y1: -50, x2: 600, y2: 600 },
    { x1: 0, y1: 0, x2: 500, y2: 500 }
  );
  assert.ok(out.x1 >= 0 && out.x1 <= 1);
  assert.ok(out.y1 >= 0 && out.y1 <= 1);
  assert.ok(out.x2 >= 0 && out.x2 <= 1);
  assert.ok(out.y2 >= 0 && out.y2 <= 1);
});

// ── Section 2: classifyDinoLabel ──────────────────────────────────────

console.log('\n== 2. classifyDinoLabel — DINO label → { classification, strictness } ==');

check('C1 face labels → face 0.9', () => {
  assert.deepStrictEqual(classifyDinoLabel('face'), { cls: 'face', strictness: 0.9 });
  assert.deepStrictEqual(classifyDinoLabel('person\'s face'), { cls: 'face', strictness: 0.9 });
  assert.deepStrictEqual(classifyDinoLabel('EYES'), { cls: 'face', strictness: 0.9 });
});

check('C2 person labels → secondary_subject 0.7', () => {
  assert.deepStrictEqual(classifyDinoLabel('person'), { cls: 'secondary_subject', strictness: 0.7 });
  assert.deepStrictEqual(classifyDinoLabel('a person walking'), { cls: 'secondary_subject', strictness: 0.7 });
  assert.deepStrictEqual(classifyDinoLabel('body'), { cls: 'secondary_subject', strictness: 0.7 });
});

check('C3 text/label patterns → text 0.5', () => {
  assert.deepStrictEqual(classifyDinoLabel('woven label'), { cls: 'text', strictness: 0.5 });
  assert.deepStrictEqual(classifyDinoLabel('brand logo'), { cls: 'text', strictness: 0.5 });
  assert.deepStrictEqual(classifyDinoLabel('hang tag'), { cls: 'text', strictness: 0.5 });
});

check('C4 face pattern beats person pattern (order matters)', () => {
  // "person's face" contains both `face` and `person` — face wins because
  // LABEL_PATTERNS lists face first. Regressing to iterate in dict order
  // would classify this as secondary_subject 0.7, weakening the face
  // protection.
  assert.deepStrictEqual(classifyDinoLabel("person's face"), { cls: 'face', strictness: 0.9 });
});

check('C5 unknown / open-vocab label → object 0.3 default', () => {
  assert.deepStrictEqual(classifyDinoLabel('PELAGIC Freespool'), { cls: 'object', strictness: 0.3 });
  assert.deepStrictEqual(classifyDinoLabel('hooded fishing shirt'), { cls: 'object', strictness: 0.3 });
});

check('C6 empty / null label → object 0.3', () => {
  assert.deepStrictEqual(classifyDinoLabel(''), { cls: 'object', strictness: 0.3 });
  assert.deepStrictEqual(classifyDinoLabel(null), { cls: 'object', strictness: 0.3 });
  assert.deepStrictEqual(classifyDinoLabel(undefined), { cls: 'object', strictness: 0.3 });
});

check('C7 all classifications are in the RESTRICTION_CLASSES enum', () => {
  // Structural pin — every value the classifier emits must be valid per
  // the OverlayZoneArtifact schema, or downstream consumers crash on an
  // unknown enum value.
  for (const p of LABEL_PATTERNS) {
    assert.ok(RESTRICTION_CLASSES.includes(p.cls), `label pattern emits invalid class: ${p.cls}`);
  }
});

// ── Section 3: buildDensityGrid ───────────────────────────────────────

console.log('\n== 3. buildDensityGrid — fraction of each cell covered by ANY bbox ==');

check('D1 empty bbox set → all cells 0', () => {
  const g = buildDensityGrid([], 4, 3);
  assert.strictEqual(g.cols, 4);
  assert.strictEqual(g.rows, 3);
  assert.strictEqual(g.cells.length, 3);
  for (const row of g.cells) for (const v of row) assert.strictEqual(v, 0);
});

check('D2 bbox covering entire frame → all cells 1.0', () => {
  const g = buildDensityGrid([{ x1: 0, y1: 0, x2: 1, y2: 1 }], 4, 3);
  for (const row of g.cells) for (const v of row) assert.strictEqual(v, 1.0);
});

check('D3 bbox covering top-left quadrant → top-left cells 1.0, rest 0', () => {
  // 4×2 grid, bbox covers left half (0..0.5 x 0..1)
  const g = buildDensityGrid([{ x1: 0, y1: 0, x2: 0.5, y2: 1 }], 4, 2);
  assert.strictEqual(g.cells[0][0], 1.0);
  assert.strictEqual(g.cells[0][1], 1.0);
  assert.strictEqual(g.cells[0][2], 0);
  assert.strictEqual(g.cells[0][3], 0);
  assert.strictEqual(g.cells[1][0], 1.0);
  assert.strictEqual(g.cells[1][3], 0);
});

check('D4 overlapping bboxes cap at 1.0 (no over-counting)', () => {
  const g = buildDensityGrid([
    { x1: 0, y1: 0, x2: 0.5, y2: 1 },
    { x1: 0.25, y1: 0, x2: 0.75, y2: 1 }   // overlaps left bbox in cell 2
  ], 4, 1);
  for (const v of g.cells[0]) assert.ok(v <= 1.0, 'density must not exceed 1.0');
});

check('D5 output values are 1-decimal rounded (compact artifact)', () => {
  const g = buildDensityGrid([{ x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 }], 4, 4);
  for (const row of g.cells) for (const v of row) {
    // v * 10 should be an integer (1-decimal precision)
    assert.strictEqual(Math.round(v * 10), v * 10);
  }
});

check('D6 degenerate cols/rows → empty grid, no crash', () => {
  const g = buildDensityGrid([{ x1: 0, y1: 0, x2: 1, y2: 1 }], 0, 0);
  assert.deepStrictEqual(g, { cols: 0, rows: 0, cells: [] });
});

// ── Section 4: pickGridDims ───────────────────────────────────────────

console.log('\n== 4. pickGridDims — grid shape by aspect ratio ==');

check('G1 9:16 (very tall) → 6×10', () => {
  assert.deepStrictEqual(pickGridDims('9:16'), { cols: 6, rows: 10 });
});

check('G2 4:5 (portrait) → 6×10', () => {
  assert.deepStrictEqual(pickGridDims('4:5'), { cols: 6, rows: 10 });
});

check('G3 1:1 (square) → 6×6', () => {
  assert.deepStrictEqual(pickGridDims('1:1'), { cols: 6, rows: 6 });
});

check('G4 5:4 (landscape) → 8×6', () => {
  assert.deepStrictEqual(pickGridDims('5:4'), { cols: 8, rows: 6 });
});

check('G5 unknown ratio → 8×6 landscape default', () => {
  assert.deepStrictEqual(pickGridDims('16:9'), { cols: 8, rows: 6 });
  assert.deepStrictEqual(pickGridDims(''), { cols: 8, rows: 6 });
  assert.deepStrictEqual(pickGridDims(null), { cols: 8, rows: 6 });
});

// ── Section 5: derivePrimarySubjectRectPct ────────────────────────────

console.log('\n== 5. derivePrimarySubjectRectPct — hot-path lookup ==');

check('P1 exactly one product restriction → its rect wins', () => {
  const r = derivePrimarySubjectRectPct([
    { classification: 'face', strictness: 0.9, rectPct: { x1: 0, y1: 0, x2: 0.5, y2: 0.5 } },
    { classification: 'product', strictness: 1.0, rectPct: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 } },
    { classification: 'object', strictness: 0.3, rectPct: { x1: 0.7, y1: 0.7, x2: 0.9, y2: 0.9 } }
  ]);
  assert.deepStrictEqual(r, { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 });
});

check('P2 no product restriction → null', () => {
  const r = derivePrimarySubjectRectPct([
    { classification: 'face', strictness: 0.9, rectPct: { x1: 0, y1: 0, x2: 0.5, y2: 0.5 } },
    { classification: 'object', strictness: 0.3, rectPct: { x1: 0.7, y1: 0.7, x2: 0.9, y2: 0.9 } }
  ]);
  assert.strictEqual(r, null);
});

check('P3 multiple product restrictions → highest-strictness wins', () => {
  const r = derivePrimarySubjectRectPct([
    { classification: 'product', strictness: 0.8, rectPct: { x1: 0, y1: 0, x2: 0.3, y2: 0.3 } },
    { classification: 'product', strictness: 1.0, rectPct: { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 } }
  ]);
  assert.deepStrictEqual(r, { x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.9 });
});

check('P4 empty restrictions → null', () => {
  assert.strictEqual(derivePrimarySubjectRectPct([]), null);
  assert.strictEqual(derivePrimarySubjectRectPct(null), null);
  assert.strictEqual(derivePrimarySubjectRectPct(undefined), null);
});

// ── Section 6: End-to-end analyzeFromRefinedProducts ───────────────────

console.log('\n== 6. analyzeFromRefinedProducts — full artifact shape ==');

const { analyzeFromRefinedProducts } = svc;

check('E1 realistic single-product frame → correct artifact shape', () => {
  const zone = analyzeFromRefinedProducts({
    refinedProducts: [
      { id: 'r1', x1: 200, y1: 100, x2: 800, y2: 900, label: 'PELAGIC Freespool', confidence: 0.95 }
    ],
    cropRect: { x1: 0, y1: 0, x2: 1000, y2: 1000 },
    primarySubjectId: 'r1',
    ratio: '1:1',
    imageWidth: 1080,
    imageHeight: 1080
  });
  assert.ok(zone, 'expected zone artifact');
  assert.strictEqual(zone.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(zone.imageWidth, 1080);
  assert.strictEqual(zone.imageHeight, 1080);
  assert.strictEqual(zone.restrictions.length, 1);
  assert.strictEqual(zone.restrictions[0].classification, 'product');
  assert.strictEqual(zone.restrictions[0].strictness, 1.0);
  assert.ok(zone.primarySubjectRectPct, 'primary subject rect must be surfaced');
  assert.strictEqual(zone.densityGrid.cols, 6);
  assert.strictEqual(zone.densityGrid.rows, 6);
});

check('E2 primary subject fallback (no id) → largest bbox wins', () => {
  const zone = analyzeFromRefinedProducts({
    refinedProducts: [
      { id: 'r1', x1: 0, y1: 0, x2: 100, y2: 100, label: 'small' },       // area 10000
      { id: 'r2', x1: 100, y1: 100, x2: 900, y2: 900, label: 'large' }    // area 640000 — largest, becomes primary
    ],
    cropRect: { x1: 0, y1: 0, x2: 1000, y2: 1000 },
    primarySubjectId: null,   // ← force largest-bbox fallback
    ratio: '1:1'
  });
  const product = zone.restrictions.find((r) => r.classification === 'product');
  assert.ok(product, 'expected a product restriction');
  assert.strictEqual(product.strictness, 1.0);
  // Verify it's the LARGE one (r2)
  assert.ok(product.reason.includes('large'));
});

check('E3 missing refinedProducts → null (fail-closed)', () => {
  const zone = analyzeFromRefinedProducts({
    refinedProducts: null,
    cropRect: { x1: 0, y1: 0, x2: 100, y2: 100 },
    ratio: '1:1'
  });
  assert.strictEqual(zone, null);
});

check('E4 missing cropRect → null', () => {
  const zone = analyzeFromRefinedProducts({
    refinedProducts: [{ x1: 0, y1: 0, x2: 100, y2: 100, label: 'a' }],
    cropRect: null,
    ratio: '1:1'
  });
  assert.strictEqual(zone, null);
});

check('E5 forbiddenRectsPct injected as strictness=1.0 restrictions', () => {
  // Video path passes cross-frame safeRect / platform UI bands as
  // forbidden rects. They must ride into the output as hard rules,
  // classification='other'.
  const zone = analyzeFromRefinedProducts({
    refinedProducts: [{ id: 'r1', x1: 0, y1: 0, x2: 100, y2: 100, label: 'product' }],
    cropRect: { x1: 0, y1: 0, x2: 1000, y2: 1000 },
    primarySubjectId: 'r1',
    forbiddenRectsPct: [
      { x1: 0, y1: 0.85, x2: 1, y2: 1, reason: 'IG Reels action rail' }
    ],
    ratio: '9:16'
  });
  const forbidden = zone.restrictions.find((r) => r.classification === 'other');
  assert.ok(forbidden, 'expected a forbidden-region restriction');
  assert.strictEqual(forbidden.strictness, 1.0);
  assert.match(forbidden.reason, /IG Reels/);
});

check('E6 bboxes outside crop are dropped (no null restrictions in output)', () => {
  const zone = analyzeFromRefinedProducts({
    refinedProducts: [
      { id: 'r1', x1: 50, y1: 50, x2: 150, y2: 150, label: 'inside' },
      { id: 'r2', x1: 900, y1: 900, x2: 1000, y2: 1000, label: 'outside' }
    ],
    // Crop covers 0..500, so r2 is completely outside
    cropRect: { x1: 0, y1: 0, x2: 500, y2: 500 },
    primarySubjectId: 'r1',
    ratio: '1:1'
  });
  // Only the inside bbox produces a restriction — dropped bboxes don't
  // even leave an "object" placeholder.
  assert.strictEqual(zone.restrictions.length, 1);
  assert.match(zone.restrictions[0].reason, /inside/);
});

// ── Summary ─────────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter((r) => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
