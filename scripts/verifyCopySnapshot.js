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
 *   - RENDER TIME: headline is the DIRECTOR's concept copy (here, the
 *     "organic-cotton-weight" concept, whose own `copy.headline` field IS
 *     literally "220 GSM organic cotton.").
 *   - SNAPSHOT TIME used to read `input.copy.headline` — the CACHED
 *     LayoutInputArtifact's marketing-line derivation (Gemini-backed,
 *     computed BEFORE the Director concept was ever selected for this ad).
 *
 * Groups:
 *   S3  Live staticAdIntents: buildPrompt's role names ('BRAND LINE' for
 *       product_first_lifestyle, 'CUSTOMER QUOTE' for social_proof_led)
 *       are the ones a snapshot reader must consume — pinned against the
 *       real intent modules, not a mirror of their role vocabulary.
 *
 * REMOVED (dormant render fallback deletion): S1 (`renderedTextForRole` on
 * `services/directImageRenderService.js`) and the S2 source pins against
 * `extractCopySnapshot` / `renderedCopy` in backend `renderService.js`.
 * `renderedTextForRole` lived only on the mint-time static render entry
 * point (`renderDirectImage` / `buildIntentData`) and was deleted with it.
 * `extractCopySnapshot` moved to adgen (`adgen/src/services/renderer.js`)
 * when adgen took ownership of static rendering unconditionally. Surviving
 * coverage is the live `services/staticAdIntents.js` role list that any
 * snapshot reader still has to match.
 *
 * Run: node scripts/verifyCopySnapshot.js
 */
const intents = require('../services/staticAdIntents');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function roleText(built, role) {
  if (!built || !Array.isArray(built.text)) return null;
  const hit = built.text.find((row) => Array.isArray(row) && row[0] === role);
  return hit ? hit[1] : null;
}

// ── S3: live integration — the role names a snapshot reader must use ──
const builtEditorial = intents.buildPrompt({
  intentKey: 'product_first_lifestyle',
  data: { headline: '220 GSM organic cotton.', cta: 'Shop the tee' },
  product: {},
  surface: 'meta_feed_1_1'
});
check('S3 product_first_lifestyle (ai_editorial\'s default intent) carries a BRAND LINE role with the Director\'s headline',
  roleText(builtEditorial, 'BRAND LINE') === '220 GSM organic cotton.',
  `text=${JSON.stringify(builtEditorial.text)}`);

const builtProof = intents.buildPrompt({
  intentKey: 'social_proof_led',
  data: {
    quote: 'Every single piece is so well made.',
    rating: '4.8',
    reviewCount: 120,
    reviewsText: '120 reviews',
    cta: 'Shop the tee'
  },
  product: {},
  surface: 'meta_feed_1_1'
});
check('S3 social_proof_led carries a CUSTOMER QUOTE role, and BRAND LINE is correctly absent (this intent has no headline slot)',
  roleText(builtProof, 'CUSTOMER QUOTE') !== null
  && roleText(builtProof, 'BRAND LINE') === null,
  `text=${JSON.stringify(builtProof.text)}`);

if (failures.length) {
  console.error(`\n❌ copy snapshot: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ copy snapshot: ${pass} checks passed`);
