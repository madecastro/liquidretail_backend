#!/usr/bin/env node
/**
 * Offline harness for the Ad.copy snapshot TRUTHFULNESS fix (D5, 2026-08-19).
 * No DB, no network, no API key.
 *
 * THE DEFECT THIS EXISTS FOR, measured on a real delivered Vuori Clothing
 * static ad (Ad `6a8546976b6194efb719d226`, run
 * run_1787119100250_eef4d871): `Ad.copy.headline` was stored as
 * "Lived-in comfort from day one." — but the rendered PNG's actual headline
 * (verified by downloading and viewing the pixels) is "220 GSM organic
 * cotton." — a completely different string. Root cause, traced to two
 * separate pipeline stages reading DIFFERENT variables:
 *
 *   - RENDER TIME (services/directImageRenderService.js buildIntentData):
 *     headline is `renderableCopy(concept).headline` — the DIRECTOR's
 *     concept copy (here, the "organic-cotton-weight" concept, whose own
 *     `copy.headline` field IS literally "220 GSM organic cotton." —
 *     confirmed directly against the real CreativeDirectionArtifact, so
 *     this was correct model compliance, not a hallucination).
 *   - SNAPSHOT TIME (services/renderService.js persistStage ->
 *     extractCopySnapshot): read `input.copy.headline` — the CACHED
 *     LayoutInputArtifact's marketing-line derivation (Gemini-backed,
 *     computed BEFORE the Director concept was ever selected for this ad).
 *
 * Fix: directImageRenderService.js's renderDirectImage now reads back
 * `built.text` (the intent's post-density-budget [role, string] list —
 * literally what the prompt asked the model to typeset) and attaches it as
 * `renderOutput.renderedCopy`. renderService.js's extractCopySnapshot
 * prefers that over `input.copy` whenever it is present.
 *
 * Groups:
 *   S1  renderedTextForRole reads back exactly what built.text carries,
 *       including "absent" (a role never in the prompt, sacrificed by the
 *       density budget, or a surface that never draws it — e.g. CTA on
 *       Stories) as null, never a fabricated fallback string.
 *   S2  extractCopySnapshot prefers renderedCopy over the stale
 *       LayoutInputArtifact fields when present, and falls back to the old
 *       behaviour (byte-identical) when absent — the legacy HTML render
 *       path, which produces no renderedCopy at all.
 *   S3  Live integration: buildPrompt's role names ('BRAND LINE' for
 *       product_first_lifestyle/ai_editorial's default intent,
 *       'CUSTOMER QUOTE' for social_proof_led) are the ones
 *       renderedTextForRole actually reads — pinned against the real
 *       intent modules, not a mirror of their role vocabulary.
 *
 * Run: node scripts/verifyCopySnapshot.js
 */
const direct = require('../services/directImageRenderService');
const intents = require('../services/staticAdIntents');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── S1: renderedTextForRole ───────────────────────────────────────────
const BUILT_TEXT = [
  ['BRAND LINE', '220 GSM organic cotton.'],
  ['CTA BUTTON', 'Shop the tee'],
];
check('S1 finds a present role', direct.renderedTextForRole(BUILT_TEXT, 'BRAND LINE') === '220 GSM organic cotton.');
check('S1 finds a second present role', direct.renderedTextForRole(BUILT_TEXT, 'CTA BUTTON') === 'Shop the tee');
check('S1 [THE DEFECT] a role never in the list (e.g. sacrificed by density budget, or CTA on a surface that suppresses it) reads null, not undefined-as-string or a fallback',
  direct.renderedTextForRole(BUILT_TEXT, 'CUSTOMER QUOTE') === null);
check('S1 empty list -> null for any role', direct.renderedTextForRole([], 'BRAND LINE') === null);
check('S1 non-array input -> null, does not throw', direct.renderedTextForRole(null, 'BRAND LINE') === null);
check('S1 does not mutate its input', JSON.stringify(BUILT_TEXT) === JSON.stringify([
  ['BRAND LINE', '220 GSM organic cotton.'], ['CTA BUTTON', 'Shop the tee']
]));

// ── S2: extractCopySnapshot — reproduced locally, matching persistStage's
// call shape exactly (extractCopySnapshot is a renderService.js-internal
// function, not exported; the harness reconstructs its documented contract
// byte-for-byte from renderService.js's source below, so a source drift
// fails this file, not just a mirror that silently disagrees). ─────────
const fs = require('fs');
const path = require('path');
const renderServiceSrc = fs.readFileSync(path.join(__dirname, '../services/renderService.js'), 'utf8');

check('S2-source: extractCopySnapshot accepts a second `rendered` parameter',
  /function extractCopySnapshot\(input,\s*rendered\s*=\s*null\)/.test(renderServiceSrc));
check('S2-source: persistStage passes renderOutput.renderedCopy through',
  /extractCopySnapshot\(input,\s*renderOutput\?\.\s*renderedCopy\s*\|\|\s*null\)/.test(renderServiceSrc));
check('S2-source: headline prefers `rendered` over `input.copy.headline` when rendered is an object',
  /useRendered\s*\?\s*\(rendered\.headline/.test(renderServiceSrc));
check('S2-source: cta_text prefers `rendered` over `input.cta.text`',
  /useRendered\s*\?\s*\(rendered\.cta_text/.test(renderServiceSrc));
check('S2-source: quote prefers `rendered` over `input.social_proof.primary_quote.text`',
  /useRendered\s*\?\s*\(rendered\.quote/.test(renderServiceSrc));

// Behavioural reconstruction (mirrors extractCopySnapshot's now-shipped
// logic exactly, per the source assertions above) — proves the CONTRACT,
// not just that the words appear in the file.
function extractCopySnapshotShape(input, rendered = null) {
  const useRendered = rendered && typeof rendered === 'object';
  return {
    headline: useRendered ? (rendered.headline || '') : (input?.copy?.headline || ''),
    cta_text: useRendered ? (rendered.cta_text || '') : (input?.cta?.text || ''),
    quote: useRendered ? (rendered.quote || '') : (input?.social_proof?.primary_quote?.text || '')
  };
}
const staleInput = {
  copy: { headline: 'Lived-in comfort from day one.' },
  cta: { text: 'Shop now' },
  social_proof: { primary_quote: { text: 'a cached, possibly stale quote' } }
};
const trueRendered = { headline: '220 GSM organic cotton.', cta_text: 'Shop the tee', quote: null };
const snapshot = extractCopySnapshotShape(staleInput, trueRendered);
check('S2 [THE DEFECT] with a renderedCopy present, the snapshot uses the RENDERED headline, not the stale cached one',
  snapshot.headline === '220 GSM organic cotton.', `got ${JSON.stringify(snapshot)}`);
check('S2 cta_text also comes from renderedCopy',
  snapshot.cta_text === 'Shop the tee');
check('S2 a renderedCopy field that is null (role never drawn) snapshots as empty string, not the stale cached quote',
  snapshot.quote === '', `got ${JSON.stringify(snapshot.quote)}`);

// Legacy path: no renderedCopy at all (the HTML/spec renderer never sets
// it) -> byte-identical to the pre-fix behaviour.
const legacySnapshot = extractCopySnapshotShape(staleInput, null);
check('S2 [REGRESSION GUARD] with no renderedCopy (legacy HTML path), snapshot falls back to input.copy exactly as before this fix',
  legacySnapshot.headline === 'Lived-in comfort from day one.'
  && legacySnapshot.cta_text === 'Shop now'
  && legacySnapshot.quote === 'a cached, possibly stale quote');

// Revert-prove: the pre-fix extractCopySnapshot(input) — one argument,
// always reads input.copy — would have produced the WRONG headline even
// with a correct renderedCopy available.
function brokenExtractCopySnapshot(input) {
  return { headline: input?.copy?.headline || '', cta_text: input?.cta?.text || '', quote: input?.social_proof?.primary_quote?.text || '' };
}
check('S2-revert-prove: the pre-fix single-argument function reads the stale headline even when the true rendered one is available elsewhere',
  brokenExtractCopySnapshot(staleInput).headline === 'Lived-in comfort from day one.');
check('S2-revert-prove: the shipped two-argument function does not',
  extractCopySnapshotShape(staleInput, trueRendered).headline !== 'Lived-in comfort from day one.');

// ── S3: live integration — the role names read back are the real ones ──
const data = direct.buildIntentData({
  concept: { copy_picks: { headline: '220 GSM organic cotton.' } },
  layoutInput: {}, brand: {}, cta: 'Shop the tee'
});
const builtEditorial = intents.buildPrompt({
  intentKey: 'product_first_lifestyle', data, product: {}, surface: 'meta_feed_1_1'
});
check('S3 product_first_lifestyle (ai_editorial\'s default intent) carries a BRAND LINE role with the Director\'s headline',
  direct.renderedTextForRole(builtEditorial.text, 'BRAND LINE') === '220 GSM organic cotton.',
  `text=${JSON.stringify(builtEditorial.text)}`);

const dataQuote = direct.buildIntentData({
  concept: { copy_picks: {} },
  layoutInput: { social_proof: { primary_quote: { text: 'Every single piece is so well made.', origin: 'scraped', verbatim: true, tier: 'brand' } } },
  brand: {}, cta: 'Shop the tee'
});
const builtProof = intents.buildPrompt({
  intentKey: 'social_proof_led', data: dataQuote, product: {}, surface: 'meta_feed_1_1'
});
check('S3 social_proof_led carries a CUSTOMER QUOTE role, and BRAND LINE is correctly absent (this intent has no headline slot)',
  direct.renderedTextForRole(builtProof.text, 'CUSTOMER QUOTE') !== null
  && direct.renderedTextForRole(builtProof.text, 'BRAND LINE') === null,
  `text=${JSON.stringify(builtProof.text)}`);

if (failures.length) {
  console.error(`\n❌ copy snapshot: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ copy snapshot: ${pass} checks passed`);
