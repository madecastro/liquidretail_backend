'use strict';
/**
 * verifyPmaxSplitDensityGate — a PMax 16:9 split-stage outfill must not become
 * a video master when its copy half is busy.
 *
 * WHY THIS EXISTS. The split unit pre-composes the product onto one side of a
 * 16:9 canvas and generatively extends the OTHER side; that extended half later
 * carries composited headline / quote / CTA. The extension is generative, so the
 * model can fill it with clutter, a second product, or high-frequency detail.
 * Copy over a busy panel is unreadable, and the repo has a standing NO-SCRIM
 * rule (owner reaffirmed 2026-08-12) — we cannot rescue it with a shade behind
 * the type. It has to be caught AFTER the ~$0.08 extended seed and BEFORE the
 * ~$0.90–$1.20 video master, by a ~$0.01–0.02 vision pass.
 *
 * The pure rule (isCopyHalfCalm) is tested behaviourally below — it is the
 * shipped function, so a reimplementation that keeps the name still has to
 * obey it. The call site sits behind Mongo + network I/O an offline harness
 * cannot drive, so section W is a WIRING check (labelled as such): the gate
 * must be split-path-only, and a failure must degrade rather than throw.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  isCopyHalfCalm,
  copyPanelRectForSubjectSide,
  COPY_HALF_MEAN_MAX,
  COPY_HALF_PEAK_MAX,
  RESTRICTION_OVERLAP_MIN_AREA,
  RESTRICTION_STRICTNESS_MIN,
  HARD_RESTRICTION_CLASSES
} = require('../services/pmaxSplitStrategy');

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; void label; };

console.log('verifyPmaxSplitDensityGate\n');

// ── helpers ──────────────────────────────────────────────────────────────────

// 8×6 landscape grid (matches overlayZoneService's landscape suggestion).
// cells[row][col]: row 0 = top, col 0 = left. Left half = cols 0..3, right = 4..7.
function gridFrom(fn) {
  const rows = 6;
  const cols = 8;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(fn(r, c, rows, cols));
    cells.push(row);
  }
  return { cols, rows, cells };
}

const EAST_PANEL = copyPanelRectForSubjectSide('east'); // product right → panel left
const WEST_PANEL = copyPanelRectForSubjectSide('west'); // product left  → panel right

// ── A. behavioural — the shipped pure rule ───────────────────────────────────

ok('calm panel => calm', () => {
  // Entire frame calm (0.1). Either panel must pass.
  const densityGrid = gridFrom(() => 0.1);
  const v = isCopyHalfCalm({ densityGrid, restrictions: [], panelRectPct: EAST_PANEL });
  assert.strictEqual(v.calm, true, JSON.stringify(v));
  assert.ok(v.mean <= COPY_HALF_MEAN_MAX);
  assert.ok(v.peak <= COPY_HALF_PEAK_MAX);
});

ok('busy panel => not calm', () => {
  // Left (copy) half busy, right calm — east subject puts copy on the left.
  const densityGrid = gridFrom((_r, c) => (c < 4 ? 0.8 : 0.1));
  const v = isCopyHalfCalm({ densityGrid, restrictions: [], panelRectPct: EAST_PANEL });
  assert.strictEqual(v.calm, false, JSON.stringify(v));
  assert.ok(v.reason === 'mean-density' || v.reason === 'peak-density', v.reason);
});

ok('panel calm but the PRODUCT half busy => still calm (panel-only)', () => {
  // THE single most important check: product half (right) is fully busy, copy
  // half (left) is calm. Averaging the whole frame would fail; panel-only must
  // pass. This is the bug class the gate must never have.
  const densityGrid = gridFrom((_r, c) => (c >= 4 ? 1.0 : 0.05));
  const v = isCopyHalfCalm({ densityGrid, restrictions: [], panelRectPct: EAST_PANEL });
  assert.strictEqual(v.calm, true, `judged whole frame? ${JSON.stringify(v)}`);
  // And the product-side panel must fail on the same grid (sanity).
  const productAsPanel = isCopyHalfCalm({
    densityGrid, restrictions: [], panelRectPct: WEST_PANEL
  });
  assert.strictEqual(productAsPanel.calm, false, 'product half should read busy');
});

ok('average calm but one dense cell/corner => NOT calm (adversarial)', () => {
  // 23 calm cells + one corner at 1.0 on the left half. Mean ≈ 0.09, well
  // under COPY_HALF_MEAN_MAX — mean-only would pass. Peak must catch it.
  const densityGrid = gridFrom((r, c) => (r === 0 && c === 0 ? 1.0 : 0.05));
  const v = isCopyHalfCalm({ densityGrid, restrictions: [], panelRectPct: EAST_PANEL });
  assert.strictEqual(v.calm, false, `mean-only hole: ${JSON.stringify(v)}`);
  assert.strictEqual(v.reason, 'peak-density', v.reason);
  assert.ok(v.worstCell && v.worstCell.value === 1.0, JSON.stringify(v.worstCell));
  assert.ok(v.mean <= COPY_HALF_MEAN_MAX, `mean ${v.mean} should still be under cap`);
  assert.ok(v.peak > COPY_HALF_PEAK_MAX);
});

ok('product restriction overlapping the panel => not calm, class reported', () => {
  const densityGrid = gridFrom(() => 0.05);
  const v = isCopyHalfCalm({
    densityGrid,
    restrictions: [{
      rectPct: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.8 },
      classification: 'product',
      strictness: 1.0
    }],
    panelRectPct: EAST_PANEL
  });
  assert.strictEqual(v.calm, false, JSON.stringify(v));
  assert.strictEqual(v.reason, 'restriction-overlap');
  assert.strictEqual(v.offendingClassification, 'product');
});

ok('face restriction overlapping the panel => not calm, class reported', () => {
  const densityGrid = gridFrom(() => 0.05);
  const v = isCopyHalfCalm({
    densityGrid,
    restrictions: [{
      rectPct: { x1: 0.05, y1: 0.05, x2: 0.3, y2: 0.35 },
      classification: 'face',
      strictness: 0.9
    }],
    panelRectPct: EAST_PANEL
  });
  assert.strictEqual(v.calm, false, JSON.stringify(v));
  assert.strictEqual(v.offendingClassification, 'face');
});

ok('restriction rect entirely OUTSIDE the panel => ignored', () => {
  // Face is fully on the product (right) half; copy (left) is calm.
  const densityGrid = gridFrom(() => 0.05);
  const v = isCopyHalfCalm({
    densityGrid,
    restrictions: [{
      rectPct: { x1: 0.6, y1: 0.1, x2: 0.95, y2: 0.9 },
      classification: 'face',
      strictness: 0.9
    }],
    panelRectPct: EAST_PANEL
  });
  assert.strictEqual(v.calm, true, JSON.stringify(v));
});

ok('restriction below min overlap area is ignored', () => {
  // Tiny peek of product into the panel — area << RESTRICTION_OVERLAP_MIN_AREA.
  const densityGrid = gridFrom(() => 0.05);
  const v = isCopyHalfCalm({
    densityGrid,
    restrictions: [{
      // width 0.01 * height 0.01 = 0.0001 << 0.005
      rectPct: { x1: 0.495, y1: 0.5, x2: 0.505, y2: 0.51 },
      classification: 'product',
      strictness: 1.0
    }],
    panelRectPct: EAST_PANEL
  });
  assert.strictEqual(v.calm, true, JSON.stringify(v));
  assert.ok(RESTRICTION_OVERLAP_MIN_AREA > 0.0001);
});

ok('mirror sweep: same grid, panel on the other side flips the verdict', () => {
  // Left half calm, right half busy.
  const densityGrid = gridFrom((_r, c) => (c >= 4 ? 0.9 : 0.05));
  const east = isCopyHalfCalm({ densityGrid, restrictions: [], panelRectPct: EAST_PANEL });
  const west = isCopyHalfCalm({ densityGrid, restrictions: [], panelRectPct: WEST_PANEL });
  assert.strictEqual(east.calm, true, `east (left panel) should be calm: ${JSON.stringify(east)}`);
  assert.strictEqual(west.calm, false, `west (right panel) should be busy: ${JSON.stringify(west)}`);
});

ok('malformed battery => undecidable, never throws, never accidentally calm', () => {
  const panel = EAST_PANEL;
  const cases = [
    { densityGrid: null, restrictions: [], panelRectPct: panel, label: 'null grid' },
    { densityGrid: undefined, restrictions: [], panelRectPct: panel, label: 'undefined grid' },
    { densityGrid: {}, restrictions: [], panelRectPct: panel, label: 'empty grid obj' },
    { densityGrid: { cols: 0, rows: 0, cells: [] }, restrictions: [], panelRectPct: panel, label: 'zero grid' },
    {
      densityGrid: { cols: 2, rows: 2, cells: [[NaN, NaN], [NaN, NaN]] },
      restrictions: [],
      panelRectPct: panel,
      label: 'NaN cells'
    },
    {
      densityGrid: gridFrom(() => 0.05),
      restrictions: [],
      panelRectPct: { x1: 0.8, y1: 0, x2: 0.2, y2: 1 }, // inverted
      label: 'inverted rect'
    },
    {
      densityGrid: gridFrom(() => 0.05),
      restrictions: [],
      panelRectPct: { x1: 0, y1: 0, x2: 0, y2: 1 }, // zero width
      label: 'zero-width rect'
    },
    {
      densityGrid: gridFrom(() => 0.05),
      restrictions: [],
      panelRectPct: null,
      label: 'null panel'
    },
    {
      densityGrid: gridFrom(() => 0.05),
      restrictions: 'not-an-array',
      panelRectPct: panel,
      label: 'malformed restrictions'
    }
  ];
  for (const c of cases) {
    let v;
    assert.doesNotThrow(() => { v = isCopyHalfCalm(c); }, c.label);
    assert.notStrictEqual(v.calm, true, `${c.label} must not be calm: ${JSON.stringify(v)}`);
    assert.strictEqual(v.calm, null, `${c.label} should be undecidable: ${JSON.stringify(v)}`);
  }
  // Total function on total garbage.
  assert.doesNotThrow(() => isCopyHalfCalm());
  assert.doesNotThrow(() => isCopyHalfCalm(null));
  assert.doesNotThrow(() => isCopyHalfCalm({ densityGrid: 7 }));
  assert.strictEqual(isCopyHalfCalm().calm, null);
});

ok('exported thresholds are the ones the decision uses (no shadow literals)', () => {
  // A grid whose panel mean sits JUST under the exported cap must pass; just
  // over must fail. Pins that the harness and the function share one number.
  const under = COPY_HALF_MEAN_MAX - 0.01;
  const over = COPY_HALF_MEAN_MAX + 0.01;
  assert.ok(under > 0 && over < COPY_HALF_PEAK_MAX, 'threshold geometry for this check');
  const calmGrid = gridFrom(() => under);
  const busyGrid = gridFrom(() => over);
  assert.strictEqual(
    isCopyHalfCalm({ densityGrid: calmGrid, restrictions: [], panelRectPct: EAST_PANEL }).calm,
    true
  );
  const busy = isCopyHalfCalm({
    densityGrid: busyGrid, restrictions: [], panelRectPct: EAST_PANEL
  });
  assert.strictEqual(busy.calm, false);
  assert.strictEqual(busy.reason, 'mean-density');
  assert.ok(Array.isArray(HARD_RESTRICTION_CLASSES));
  assert.ok(HARD_RESTRICTION_CLASSES.includes('product'));
  assert.ok(HARD_RESTRICTION_CLASSES.includes('face'));
  assert.ok(RESTRICTION_STRICTNESS_MIN > 0 && RESTRICTION_STRICTNESS_MIN <= 1);
});

ok('copyPanelRectForSubjectSide mirrors correctly and rejects garbage', () => {
  assert.deepStrictEqual(EAST_PANEL, { x1: 0, y1: 0, x2: 0.5, y2: 1 });
  assert.deepStrictEqual(WEST_PANEL, { x1: 0.5, y1: 0, x2: 1, y2: 1 });
  assert.strictEqual(copyPanelRectForSubjectSide('sideways'), null);
  assert.strictEqual(copyPanelRectForSubjectSide(null), null);
});

// ── W. wiring — gate is split-only and degrades, never throws ────────────────
//
// Labelled as a wiring check: the call site sits behind network I/O an offline
// harness cannot drive. Source shape is the honest tool here.

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'atlasVideoService.js'), 'utf8'
);

ok('WIRING: density gate is invoked only on the split path and degrades on failure', () => {
  // 1. Gate body is gated on splitSide (and a successful resultUrl).
  assert.ok(
    /if\s*\(\s*resultUrl\s*&&\s*splitSide\s*\)/.test(SRC),
    'gate must be behind `if (resultUrl && splitSide)` — non-split callers must stay inert'
  );

  // 2. Uses the pure decision + the overlay-zone vision pass.
  assert.ok(
    /isCopyHalfCalm\s*\(/.test(SRC),
    'call site must invoke isCopyHalfCalm'
  );
  assert.ok(
    /analyzeOverlayZones\s*\(/.test(SRC),
    'call site must invoke analyzeOverlayZones on the extended seed'
  );
  assert.ok(
    /require\(['"]\.\/pmaxSplitStrategy['"]\)/.test(SRC),
    'decision module must be required from pmaxSplitStrategy'
  );

  // 3. Failure degrades to brand_panel rather than throwing / rethrowing.
  //    Extract the gate block and prove it never rethrows.
  const gateStart = SRC.indexOf('SPLIT COPY-HALF DENSITY GATE');
  assert.ok(gateStart > 0, 'gate comment block missing — harness is stale');
  // Gate ends at the next numbered step (6a. Drop the normalized-source…).
  const gateEnd = SRC.indexOf('// 6a. Drop the normalized-source mirror', gateStart);
  assert.ok(gateEnd > gateStart, 'could not bound the gate block');
  const gateBody = SRC.slice(gateStart, gateEnd);
  assert.ok(
    /brand_panel/.test(gateBody),
    'not-calm / undecidable path must degrade to brand_panel'
  );
  assert.ok(
    /run continues/.test(gateBody),
    'gate failure must log that the run continues (not hard-fail)'
  );
  assert.ok(
    !/\bthrow\b/.test(gateBody),
    'gate block must not throw — a $0.01 advisory cannot kill the run'
  );
  // At most one vision call: no retry loop around analyzeOverlayZones.
  const visionCalls = (gateBody.match(/analyzeOverlayZones\s*\(/g) || []).length;
  assert.strictEqual(
    visionCalls, 1,
    `expected exactly one analyzeOverlayZones call in the gate, saw ${visionCalls}`
  );
});

console.log(`\n✅ verifyPmaxSplitDensityGate: ${checks}/${checks} checks passed`);
