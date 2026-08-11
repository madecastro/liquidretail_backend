#!/usr/bin/env node
/**
 * verifyCopyCasing.js — the derivation prompt must not TEACH the template, and
 * must say what casing to use. Offline: no DB, no network, no API key.
 *
 * THREE OBSERVED DEFECTS, all traced to this one prompt (owner, 2026-08-11):
 *   "I just don't want to see meet the, especially in all caps. I noticed it
 *    is sometimes capitalizing random words in titles also."
 *
 * 1. IT TAUGHT THE PHRASE. The prompt listed complete setup clauses as
 *    examples — "SAY HELLO TO", "MEET THE", "SOMETHING NEW IS" — with nothing
 *    saying they were register rather than wording, at temperature 0.3. The
 *    model was not inventing "Meet the"; it was copying it off the page.
 *
 * 2. IT TAUGHT THE SHOUTING. Every example was written in CAPS, including a
 *    worked example that ran .toUpperCase() on the brand name. There is no
 *    textTransform in the Remotion renderers and no title-case helper on this
 *    path, so whatever the model returns is exactly what a customer reads.
 *
 * 3. IT SAID NOTHING ABOUT CASING. With the examples gone there was still no
 *    rule, and a model with no rule guesses differently every run — the same
 *    product shipped "MEET THE STRATO BREATHE" and "Meet The New Softest Tee",
 *    and naive title-case capitalised prepositions ("Built To Move").
 *
 * The fix is NOT a ban on the word "Meet": the owner is explicit that it suits
 * some brands. It is (a) stop handing the model the literal string, (b) tell it
 * the casing. So this harness asserts the EXAMPLES are gone and the RULE is
 * present — it deliberately does not forbid "meet" in generated output.
 *
 * REVERT-PROOF RECIPE (each must fail this harness):
 *   a) restore any literal example phrase to the prompt   -> A* fails
 *   b) delete the CASING rule                             -> B1 fails
 *   c) move the CASING rule back inside `if (isBranding)` -> B2 fails (product
 *      ads are where the reported defect actually shipped)
 */

const path = require('path');
const { buildDerivationPrompt } = require(path.join(__dirname, '..', 'services', 'layoutInputService'));

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

// Minimal ctx in the shape buildDerivationPrompt destructures.
function ctxFor(outcome) {
  return {
    media: { metadata: { brand: 'Vuori' } },
    detection: {},
    match: {
      outcome,
      identification: {
        brand: 'Vuori',
        productName: 'Short Sleeve Strato Breathe Tee | Black',
        details: {}
      }
    },
    brand: { name: 'Vuori' }
  };
}

const MODES = [
  ['product ad (brand_match=false)', ctxFor('product_match')],
  ['brand ad  (brand_match=true)',   ctxFor('brand_match')],
];

// Literal phrases the prompt used to hand the model.
const TAUGHT_PHRASES = [
  'MEET THE', 'SAY HELLO TO', 'SOMETHING NEW IS',
  'WHY ANGLERS LOVE', 'WHY ANGLERS TRUST',
  'Built for the offshore life', 'Made for every adventure',
  'HOT CRISPY OIL', 'COMING IN HOT', 'THE NEW ESSENTIAL',
];

// Enumerate the REAL canvas registry rather than guessing a template.
// First cut of this harness hardcoded ai_brand_led @ 1:1, which has no canvas
// variant — so `useSplitHeadline` was false and the split-headline branch (the
// one that actually carried "MEET THE") was never exercised. The revert-proof
// caught it: restoring the phrase did NOT turn the harness red. A check that
// cannot reach the code it guards is not a check.
const registry = require(path.join(__dirname, '..', 'services', 'templateRegistry'));
const canvasTemplates = registry.CANVAS?.templates || {};

const PAIRS = [];
for (const [tpl, def] of Object.entries(canvasTemplates)) {
  for (const ar of Object.keys(def.variants || {})) PAIRS.push([tpl, ar]);
}
// Plus an AI template with no canvas variant, to cover the non-split branch.
PAIRS.push(['ai_brand_led', '1:1']);

check('A0 the registry yielded canvas variants to test', PAIRS.length > 5,
  `only ${PAIRS.length} pairs — the split-headline branch may be untested`);

let splitBranchSeen = 0;
for (const [outcomeLabel, ctx] of MODES) {
  for (const [tpl, ar] of PAIRS) {
    let prompt = null;
    try {
      prompt = buildDerivationPrompt(ctx, tpl, ar, { variantKind: 'product_image' });
    } catch (e) {
      check(`A ${outcomeLabel} ${tpl}@${ar}: prompt builds`, false, e.message.slice(0, 120));
      continue;
    }
    if (/headline_lead/.test(prompt)) splitBranchSeen++;

    for (const phrase of TAUGHT_PHRASES) {
      check(`A ${outcomeLabel} ${tpl}@${ar}: does not hand the model "${phrase}"`,
        !prompt.includes(phrase),
        'a literal example phrase is back — this is what produced "Meet <SKU>"');
    }
    check(`B ${outcomeLabel} ${tpl}@${ar}: states a casing rule`, /CASING:/.test(prompt));
    check(`B ${outcomeLabel} ${tpl}@${ar}: forbids ALL CAPS`, /ALL CAPS/i.test(prompt));
    check(`B ${outcomeLabel} ${tpl}@${ar}: forbids capitalising every word`,
      /Capitalise Every Word|capitalize every word/i.test(prompt));
  }
}

// The whole point of enumerating: prove the split-headline branch was reached.
check('A1 the split-headline branch was actually exercised', splitBranchSeen > 0,
  'no prompt contained headline_lead — the branch that carried "MEET THE" is untested');

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyCopyCasing: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyCopyCasing: ${passed} checks passed`);
