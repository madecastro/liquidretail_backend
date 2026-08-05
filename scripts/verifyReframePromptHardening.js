#!/usr/bin/env node
// Offline pins for the additive REFRAME_PROMPT_HARDENING path in
// atlasVideoService.js. Two load-bearing properties:
//
//   1. FLAG-OFF BYTE IDENTITY — with REFRAME_PROMPT_HARDENING=false or unset,
//      reframePromptForAspect + reframeOutpaintPrompt must emit exactly the
//      pre-hardening string. If the base sentence drifts, the fallback
//      ladder becomes unmeasured. Same rule as STATIC_PROMPT_FIDELITY_
//      HARDENING per CLAUDE.md §2.
//
//   2. FLAG-ON ADDITIONAL CLAUSES — with REFRAME_PROMPT_HARDENING=true, the
//      output begins with the base sentence, then appends SUBJECT IDENTITY
//      (when productTitle present), PHYSICAL ACCURACY (always), and
//      SOURCE-EDGE PROTECTION (only when a YOLO subject bbox touches a
//      source frame edge within REFRAME_EDGE_CLIP_THRESHOLD_PX).
//
// Fixtures: b05-style (single subject away from edges → SUBJECT IDENTITY +
// PHYSICAL ACCURACY, no SOURCE-EDGE PROTECTION) and b13-style (4 subjects
// with one touching y=0 and another touching y=2007≈bottom → all three
// clauses fire). These match the images we diagnosed as the failure that
// motivated the hardening.
//
// No DB. No network. Loads config/defaults.env so REFRAME_PROMPT_HARDENING
// default resolves the same way in prod.

'use strict';

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });

// The module reads process.env at CALL TIME (functions are `() => ...`),
// so we can flip the flag between checks without re-requiring.
const svc = require('../services/atlasVideoService');
// These aren't exported from atlasVideoService's module.exports (private
// helpers), so we consume them via reframeOutpaintPrompt — the only public
// entry point that matters — and inspect its output string.
const reframeOutpaint = (aspect, ctx) => {
  const { reframeOutpaintPrompt } = require('../services/atlasVideoService');
  if (!reframeOutpaintPrompt) throw new Error('atlasVideoService did not export reframeOutpaintPrompt');
  return reframeOutpaintPrompt(aspect, ctx);
};

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

// Pre-hardening base string, character-for-character. If you change either
// side, you're changing the flag-off path — bump REFRAME_LADDER_VERSION and
// re-measure before landing.
const BASE_9_16 = `Reframe this image into a vertical (portrait) 9:16 composition. Keep the ENTIRE subject and all text fully visible and uncropped. Naturally extend the existing background, colors and scene to fill the new areas — do not add new objects, people or text. Seamless, photorealistic, matching the original style, lighting and palette.`;
const BASE_1_1 = `Reframe this image into a square 1:1 composition. Keep the ENTIRE subject and all text fully visible and uncropped. Naturally extend the existing background, colors and scene to fill the new areas — do not add new objects, people or text. Seamless, photorealistic, matching the original style, lighting and palette.`;
const BASE_16_9 = `Reframe this image into a horizontal (landscape) 16:9 composition. Keep the ENTIRE subject and all text fully visible and uncropped. Naturally extend the existing background, colors and scene to fill the new areas — do not add new objects, people or text. Seamless, photorealistic, matching the original style, lighting and palette.`;

// ── Fixtures ─────────────────────────────────────────────────────────

// b05-like: subjects centered, well away from frame edges
const B05_MEDIA = {
  width: 1692, height: 2018,
  metadata: { productTitle: 'Gymshark Campus Crest Zip Through Hoodie - Heavy Blue' },
  refinedProducts: [{ x1: 400, y1: 250, x2: 1000, y2: 1600 }]
};

// b13-like: 4 subjects, r3 at y=0 (top edge), r4 at y=2007 on 2018-tall (bottom edge)
const B13_MEDIA = {
  width: 1692, height: 2018,
  metadata: { productTitle: 'Gymshark Campus Crest Zip Through Hoodie - Heavy Blue' },
  refinedProducts: [
    { x1: 1344, y1: 674, x2: 1672, y2: 1381 },
    { x1: 1344, y1: 315, x2: 1667, y2: 958 },
    { x1: 302,  y1: 0,   x2: 588,  y2: 883 },
    { x1: 675,  y1: 1345, x2: 1269, y2: 2007 }
  ]
};

// Interior-only fixture with no product title
const INTERIOR_NO_TITLE_MEDIA = {
  width: 1000, height: 1000,
  metadata: {},
  refinedProducts: [{ x1: 300, y1: 300, x2: 700, y2: 700 }]
};

// ── Section 1: FLAG-OFF byte identity ────────────────────────────────

console.log('\n== FLAG-OFF byte identity (REFRAME_PROMPT_HARDENING=false) ==');
const priorFlag = process.env.REFRAME_PROMPT_HARDENING;
const priorStyle = process.env.REFRAME_PROMPT_STYLE;
process.env.REFRAME_PROMPT_HARDENING = 'false';
process.env.REFRAME_PROMPT_STYLE = 'reframe';

check('9:16 no-ctx is byte-identical to pre-hardening string', () => {
  assert.strictEqual(reframeOutpaint('9:16'), BASE_9_16);
});
check('9:16 with rich ctx STILL byte-identical (ctx ignored under flag-off)', () => {
  assert.strictEqual(reframeOutpaint('9:16', {
    productTitle: 'Whatever',
    hasEdgeClippedSubjects: true
  }), BASE_9_16);
});
check('1:1 no-ctx is byte-identical', () => {
  assert.strictEqual(reframeOutpaint('1:1'), BASE_1_1);
});
check('16:9 no-ctx is byte-identical', () => {
  assert.strictEqual(reframeOutpaint('16:9'), BASE_16_9);
});
check('unset flag = default false = byte-identical', () => {
  const prev = process.env.REFRAME_PROMPT_HARDENING;
  delete process.env.REFRAME_PROMPT_HARDENING;
  try {
    assert.strictEqual(reframeOutpaint('9:16', { productTitle: 'x', hasEdgeClippedSubjects: true }), BASE_9_16);
  } finally {
    process.env.REFRAME_PROMPT_HARDENING = prev;
  }
});

// ── Section 2: FLAG-ON additive clauses ──────────────────────────────

console.log('\n== FLAG-ON additive clauses (REFRAME_PROMPT_HARDENING=true) ==');
process.env.REFRAME_PROMPT_HARDENING = 'true';

check('base sentence is still the FIRST thing emitted', () => {
  const out = reframeOutpaint('9:16', { productTitle: 'x', hasEdgeClippedSubjects: false });
  assert.ok(out.startsWith(BASE_9_16), `expected out to start with base; got prefix: "${out.slice(0, 60)}..."`);
});

check('adds SUBJECT IDENTITY when productTitle present', () => {
  const out = reframeOutpaint('9:16', { productTitle: 'Test Product 500', hasEdgeClippedSubjects: false });
  assert.match(out, /SUBJECT IDENTITY: The primary subject is "Test Product 500"/);
  assert.match(out, /Preserve its shape, colors, materials, stitching, label text/);
  assert.match(out, /Do NOT invent alternate garment styles/);
});

check('omits SUBJECT IDENTITY when productTitle missing', () => {
  const out = reframeOutpaint('9:16', { hasEdgeClippedSubjects: false });
  assert.doesNotMatch(out, /SUBJECT IDENTITY/);
});

check('omits SUBJECT IDENTITY when productTitle is empty/whitespace', () => {
  const out = reframeOutpaint('9:16', { productTitle: '   ', hasEdgeClippedSubjects: false });
  assert.doesNotMatch(out, /SUBJECT IDENTITY/);
});

check('adds PHYSICAL ACCURACY unconditionally under flag-on', () => {
  const outA = reframeOutpaint('9:16', { productTitle: 'x', hasEdgeClippedSubjects: false });
  const outB = reframeOutpaint('9:16', { hasEdgeClippedSubjects: false });
  assert.match(outA, /PHYSICAL ACCURACY: If people are visible/);
  assert.match(outB, /PHYSICAL ACCURACY: If people are visible/);
  assert.match(outA, /5 fingers per hand/);
});

check('adds SOURCE-EDGE PROTECTION only when hasEdgeClippedSubjects=true', () => {
  const yes = reframeOutpaint('9:16', { productTitle: 'x', hasEdgeClippedSubjects: true });
  const no  = reframeOutpaint('9:16', { productTitle: 'x', hasEdgeClippedSubjects: false });
  assert.match(yes, /SOURCE-EDGE PROTECTION:/);
  assert.match(yes, /Do NOT invent unseen anatomy above, below, or beside/);
  assert.doesNotMatch(no, /SOURCE-EDGE PROTECTION/);
});

check('clauses appear in stable order: base → SUBJECT → PHYSICAL → EDGE', () => {
  const out = reframeOutpaint('9:16', { productTitle: 'x', hasEdgeClippedSubjects: true });
  const iBase = out.indexOf(BASE_9_16);
  const iSubj = out.indexOf('SUBJECT IDENTITY');
  const iPhys = out.indexOf('PHYSICAL ACCURACY');
  const iEdge = out.indexOf('SOURCE-EDGE PROTECTION');
  assert.strictEqual(iBase, 0, 'base at position 0');
  assert.ok(iSubj > iBase && iSubj < iPhys, `subj order (${iBase},${iSubj},${iPhys})`);
  assert.ok(iPhys < iEdge, `phys before edge (${iPhys},${iEdge})`);
});

check('flag-on prompt is at least 3x flag-off length (real content added)', () => {
  const on  = reframeOutpaint('9:16', { productTitle: 'Gymshark Campus Crest Hoodie', hasEdgeClippedSubjects: true });
  const off = BASE_9_16;
  assert.ok(on.length >= off.length * 3, `on=${on.length} off=${off.length}`);
});

// ── Section 3: fixture-driven ─────────────────────────────────────────

console.log('\n== Fixture-driven (b05 clean vs b13 edge-clipped) ==');

check('b05 fixture: NO source-edge protection (subjects interior)', () => {
  // simulate what reframePromptContext(media) would emit
  const ctx = simulateCtx(B05_MEDIA);
  assert.strictEqual(ctx.hasEdgeClippedSubjects, false, 'b05 subjects should be interior');
  const out = reframeOutpaint('9:16', ctx);
  assert.match(out, /SUBJECT IDENTITY/);
  assert.match(out, /PHYSICAL ACCURACY/);
  assert.doesNotMatch(out, /SOURCE-EDGE PROTECTION/);
});

check('b13 fixture: SOURCE-EDGE PROTECTION fires (r3 at y=0, r4 at y=2007)', () => {
  const ctx = simulateCtx(B13_MEDIA);
  assert.strictEqual(ctx.hasEdgeClippedSubjects, true, 'b13 has edge-clipped subjects');
  const out = reframeOutpaint('9:16', ctx);
  assert.match(out, /SUBJECT IDENTITY/);
  assert.match(out, /PHYSICAL ACCURACY/);
  assert.match(out, /SOURCE-EDGE PROTECTION/);
});

check('interior-no-title fixture: PHYSICAL only', () => {
  const ctx = simulateCtx(INTERIOR_NO_TITLE_MEDIA);
  assert.strictEqual(ctx.hasEdgeClippedSubjects, false);
  const out = reframeOutpaint('9:16', ctx);
  assert.doesNotMatch(out, /SUBJECT IDENTITY/);
  assert.match(out, /PHYSICAL ACCURACY/);
  assert.doesNotMatch(out, /SOURCE-EDGE PROTECTION/);
});

// ── Section 4: uncrop style is NOT hardened ──────────────────────────

console.log('\n== uncrop style is off-limits to hardening ==');
process.env.REFRAME_PROMPT_STYLE = 'uncrop';
// Save the flag-off uncrop output for comparison
process.env.REFRAME_PROMPT_HARDENING = 'false';
const uncropBase = reframeOutpaint('9:16', { productTitle: 'x', hasEdgeClippedSubjects: true });
// Flip hardening on — uncrop should still emit the same string
process.env.REFRAME_PROMPT_HARDENING = 'true';
check('uncrop prompt is unchanged when REFRAME_PROMPT_HARDENING=true', () => {
  const out = reframeOutpaint('9:16', { productTitle: 'x', hasEdgeClippedSubjects: true });
  assert.strictEqual(out, uncropBase);
  assert.doesNotMatch(out, /SUBJECT IDENTITY|PHYSICAL ACCURACY|SOURCE-EDGE PROTECTION/);
});

// Restore
process.env.REFRAME_PROMPT_HARDENING = priorFlag;
process.env.REFRAME_PROMPT_STYLE = priorStyle;

// Helper: minimal reimpl of reframePromptContext for fixture-driven checks.
// Matches the field names in atlasVideoService.reframePromptContext.
function simulateCtx(media) {
  const T = 4; // REFRAME_EDGE_CLIP_THRESHOLD_PX
  const w = Number(media?.width);
  const h = Number(media?.height);
  const hasEdgeClippedSubjects = w > 0 && h > 0 && (media.refinedProducts || []).some((r) => (
    Number.isFinite(r?.x1) && Number.isFinite(r?.y1) &&
    Number.isFinite(r?.x2) && Number.isFinite(r?.y2) &&
    (r.x1 <= T || r.y1 <= T || r.x2 >= w - T || r.y2 >= h - T)
  ));
  return {
    productTitle: media?.metadata?.productTitle || null,
    hasEdgeClippedSubjects
  };
}

// ── Summary ───────────────────────────────────────────────────────────

const total = results.length;
const passed = results.filter((r) => r.ok).length;
console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
if (passed !== total) process.exit(1);
