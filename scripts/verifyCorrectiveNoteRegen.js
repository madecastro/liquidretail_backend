'use strict';
// Pins the two 2026-08-25 corrective-note improvements for vision-QC regen.
//
// Context. run_1787694870947_6009320f (Pelagic swimwear, 9 statics):
//   • 2 terminal fails out of 9 (22%). Both `layout_safe_box: logo occludes
//     product`. Root cause: `logoCorner:'bottom-right'` hardcoded in
//     directImageRenderService.js — the LLM composed model/product bottom-
//     right, then Sharp dropped the logo across the sleeve. Regen re-used
//     the same corner → same failure.
//   • ad ce40bc regen fixed the layout but shortened the CTA from
//     "Shop the collection" → "Shop now" — the corrective note gave the
//     model latitude on copy it had already gotten right on attempt 1.
//
// The paired fix is two additive clauses inside `buildCorrectiveNote`
// (adVisionQcService.js):
//   1. On layout_safe_box occlusion, add a concrete "recompose the
//      RESERVED CORNER as background — NEVER product/model/garment" note.
//      The composited logomark itself is deterministic and cannot be moved
//      by regen; the LLM's only lever is the composition.
//   2. When expectedText is available (non-recovery path), append a
//      PRESERVE THESE EXACT COPY STRINGS list so the model does not
//      paraphrase strings that were fine on attempt 1.
//
// Byte-identical when: verdict has neither an occlusion-worded
// layout_safe_box failing nor an expectedText list. Legacy `buildCorrectiveNote(verdict)`
// calls (no opts) still work identically for the non-occlusion baseline.

const path = require('path');
const REPO = path.resolve(__dirname, '..');
const { buildCorrectiveNote } = require(path.join(REPO, 'src', 'services', 'adVisionQcService.js'));

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function verdictWith({ layoutFailing = false, layoutFinding = null, textFailing = false } = {}) {
  return {
    categories: {
      competitor_marks: { score: 10, pass: true, findings: [] },
      product_fidelity: { score: 10, pass: true, findings: [] },
      text_defects: textFailing
        ? { score: 5, pass: false, findings: ['CTA "Shop now" instead of expected "Shop the collection".'] }
        : { score: 10, pass: true, findings: [] },
      layout_safe_box: layoutFailing
        ? { score: 2, pass: false, findings: [layoutFinding || 'brand logo placed on top of model sleeve, occluding the product.'] }
        : { score: 10, pass: true, findings: [] }
    }
  };
}

// ── A. Layout-safe-box occlusion clause ────────────────────────────────

const occNote = buildCorrectiveNote(
  verdictWith({ layoutFailing: true }),
  { logoCorner: 'bottom-right' }
);
check('A1: occlusion clause fires on "occluding the product" finding',
  /RECOMPOSE the scene/.test(occNote) && /bottom-right corner shows background only/.test(occNote));
check('A2: occlusion clause names the reserved corner verbatim',
  /bottom-right/.test(occNote));
check('A3: occlusion clause forbids product/model/garment in the corner',
  /NEVER the product, model, garment/.test(occNote));

const occDifferentCorner = buildCorrectiveNote(
  verdictWith({ layoutFailing: true, layoutFinding: 'brand logo on top of shoe midsole, occluding item.' }),
  { logoCorner: 'top-left' }
);
check('A4: occlusion clause substitutes the passed corner',
  /top-left corner shows background only/.test(occDifferentCorner));

// Occlusion detection is regex-driven — must not fire on OTHER layout failures.
const overflowNote = buildCorrectiveNote(
  {
    categories: {
      competitor_marks: { score: 10, pass: true, findings: [] },
      product_fidelity: { score: 10, pass: true, findings: [] },
      text_defects: { score: 10, pass: true, findings: [] },
      layout_safe_box: { score: 4, pass: false, findings: ['CTA is clipped at the canvas edge; text extends past the declared safe box.'] }
    }
  },
  { logoCorner: 'bottom-right' }
);
check('A5: non-occlusion layout failure does NOT emit the recompose clause',
  !/RECOMPOSE the scene/.test(overflowNote));

const noOccMissingCorner = buildCorrectiveNote(verdictWith({ layoutFailing: true }));
check('A6: occlusion clause with no logoCorner falls back to "bottom-right" (current production corner)',
  /bottom-right corner shows background only/.test(noOccMissingCorner));

// ── B. Expected-text preservation clause ───────────────────────────────

const expected = [
  'Made for Life on the Water',
  'Ocean-inspired hand-crafted swimwear',
  'Shop the collection',
  '4.9 ★ (295 reviews)'
];

const notePreserve = buildCorrectiveNote(
  verdictWith({ layoutFailing: true }),
  { expectedText: expected, logoCorner: 'bottom-right' }
);
check('B1: preserve-copy clause fires when expectedText is non-empty',
  /PRESERVE THESE EXACT COPY STRINGS/.test(notePreserve));
check('B2: preserve-copy clause enumerates every provided string',
  expected.every((s) => notePreserve.includes(s)));
check('B3: preserve-copy clause forbids paraphrasing/shortening',
  /Do not paraphrase, shorten, or substitute/.test(notePreserve));

const noteEmptyExpected = buildCorrectiveNote(
  verdictWith({ layoutFailing: true }),
  { expectedText: [], logoCorner: 'bottom-right' }
);
check('B4: empty expectedText array → NO preserve-copy clause',
  !/PRESERVE THESE EXACT COPY STRINGS/.test(noteEmptyExpected));

const noteNullExpected = buildCorrectiveNote(
  verdictWith({ layoutFailing: true }),
  { expectedText: null, logoCorner: 'bottom-right' }
);
check('B5: null expectedText → NO preserve-copy clause',
  !/PRESERVE THESE EXACT COPY STRINGS/.test(noteNullExpected));

// ── C. Legacy shape still works ────────────────────────────────────────

const legacy = buildCorrectiveNote(verdictWith({ textFailing: true }));
check('C1: no-opts call still emits the base header',
  /VISION QC CORRECTION/.test(legacy));
check('C2: no-opts call still emits per-category findings',
  /text_defects:/.test(legacy));
check('C3: no-opts call does NOT emit the preserve-copy clause (no expectedText)',
  !/PRESERVE THESE EXACT COPY STRINGS/.test(legacy));

// ── D. Automated revert-proof ──────────────────────────────────────────
// If someone deletes the occlusion regex OR the expectedText clause, the
// checks above must fail. Positive controls above already cover this; the
// mutations here confirm the assertions are targeted, not tautological.

const withoutClauses = buildCorrectiveNote(
  { categories: {
    competitor_marks: { score: 10, pass: true, findings: [] },
    product_fidelity: { score: 10, pass: true, findings: [] },
    text_defects: { score: 10, pass: true, findings: [] },
    layout_safe_box: { score: 10, pass: true, findings: [] }
  }},
  { expectedText: expected, logoCorner: 'bottom-right' }
);
check('D1: nothing failing + expectedText → still emits preserve-copy clause',
  /PRESERVE THESE EXACT COPY STRINGS/.test(withoutClauses));
check('D2: nothing failing → no occlusion clause even with corner',
  !/RECOMPOSE the scene/.test(withoutClauses));

// ── report ─────────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\nverifyCorrectiveNoteRegen: ${passes.length} pass, ${failures.length} fail`);
  process.exit(1);
}
for (const p of passes) console.log(`  ✓ ${p}`);
console.log(`\n✅ verifyCorrectiveNoteRegen: ${passes.length}/${passes.length} checks passed`);
