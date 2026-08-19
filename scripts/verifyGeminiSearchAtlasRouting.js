#!/usr/bin/env node
'use strict';

/**
 * verifyGeminiSearchAtlasRouting — pins the 2026-08-19 routing decision on
 * services/providers/geminiSearchProvider.js: WHICH calls must stay on the
 * direct Gemini REST API and WHICH may (and now do) run through Atlas.
 *
 * BACKGROUND. A 24h CostLog slice showed exactly one direct-Google-key path
 * left: `provider=gemini, model=gemini-2.5-flash, stage=brand_reviews`.
 * Investigation found that "stage" is actually TWO different calls sharing a
 * stage name: pass 1 (grounded Google Search retrieval — MUST stay direct,
 * see the ATLAS GROUNDING PROBE comment in geminiSearchProvider.js for the
 * live-tested proof Atlas cannot proxy it) and pass 2 (plain narrative→JSON
 * structuring — never grounded, now Atlas-routed via
 * atlasLlmService.chatCompletion). `match()` (used on every UGC/IG detect)
 * is also grounded and stays direct, but is now LEDGERED (it silently
 * billed Google with zero CostLog visibility before this).
 *
 * This file is SOURCE-based (complementary to
 * scripts/verifyGeminiSearchCost.js's D-section, which proves the same split
 * BEHAVIOURALLY by actually calling the real functions against a stubbed
 * transport and inspecting the resulting CostLog rows — run that one too).
 * A source-based check catches the case a behavioural one cannot: someone
 * ADDING a new direct call, or REMOVING the routing without touching the
 * behaviour a narrow stub happens to exercise.
 *
 * REVERT-PROOF (manual, 2026-08-19): every check below was run once against
 * a deliberately broken mutation before being accepted —
 *   - pointing pass 1's tools-bearing call at chatCompletion() → G1/G2 fail
 *   - deleting `tools: [{ google_search: {} }]` from match() → G3 fails
 *   - reverting structureReviewNarrative to call trackedGenerate/axios
 *     instead of chatCompletion → A1 fails
 *   - adding a `tools` field to structureReviewNarrative's request body →
 *     A2 fails
 * All four were confirmed to fail on the mutation and pass on the real
 * source before this file was accepted.
 *
 * Pure — reads source only. No DB, no network, no API key.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'services', 'providers', 'geminiSearchProvider.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass += 1; }
  catch (err) { failures.push(`${name}: ${err.message.split('\n')[0].slice(0, 300)}`); }
}

function fnBody(name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notStrictEqual(start, -1, `function ${name} not found`);
  const end = src.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `could not find end of ${name}`);
  return src.slice(start, end);
}

const MATCH_FN     = fnBody('match');
const BRAND_FN      = fnBody('lookupBrandReviews');
const PRODUCT_FN    = fnBody('lookupProductReviews');
const STRUCTURE_FN  = fnBody('structureReviewNarrative');

console.log('A. pass 2 (structuring, never grounded) is Atlas-routed');

check('A1 structureReviewNarrative calls chatCompletion, never trackedGenerate/axios', () => {
  assert.ok(/chatCompletion\(/.test(STRUCTURE_FN), 'must call the shared Atlas transport');
  assert.strictEqual((STRUCTURE_FN.match(/trackedGenerate\(/g) || []).length, 0,
    'must not fall back to the direct-Gemini ledgered transport');
  assert.strictEqual((STRUCTURE_FN.match(/axios\.post\(/g) || []).length, 0,
    'must not call the raw REST endpoint directly');
});

check('A2 structureReviewNarrative never requests grounding', () => {
  assert.ok(!/google_search/.test(STRUCTURE_FN),
    'a grounded structuring call would need to move BACK to the direct transport, not stay on Atlas');
  assert.ok(!/\btools\s*:/.test(STRUCTURE_FN),
    'no `tools` field of any kind belongs on the Atlas-routed pass');
});

check('A3 both lookups call structureReviewNarrative for their pass 2, not a re-implemented literal', () => {
  assert.ok(/structureReviewNarrative\(/.test(BRAND_FN), 'lookupBrandReviews must delegate pass 2');
  assert.ok(/structureReviewNarrative\(/.test(PRODUCT_FN), 'lookupProductReviews must delegate pass 2');
});

console.log('B. pass 1 (grounded search) and match() stay on the direct transport');

check('B1 lookupBrandReviews pass 1 still sends the native google_search tool to the direct endpoint', () => {
  assert.ok(/tools:\s*\[\{\s*google_search:\s*\{\}\s*\}\]/.test(BRAND_FN));
  assert.ok(/trackedGenerate\(/.test(BRAND_FN), 'pass 1 must stay on the ledgered DIRECT transport');
  assert.strictEqual((BRAND_FN.match(/chatCompletion\(/g) || []).length, 0,
    'lookupBrandReviews itself must never call chatCompletion — only its pass-2 delegate does');
});

check('B2 lookupProductReviews pass 1 still sends the native google_search tool to the direct endpoint', () => {
  assert.ok(/tools:\s*\[\{\s*google_search:\s*\{\}\s*\}\]/.test(PRODUCT_FN));
  assert.ok(/trackedGenerate\(/.test(PRODUCT_FN));
  assert.strictEqual((PRODUCT_FN.match(/chatCompletion\(/g) || []).length, 0,
    'lookupProductReviews itself must never call chatCompletion — only its pass-2 delegate does');
});

check('B3 match() still sends the native google_search tool, and is now ledgered', () => {
  assert.ok(/tools:\s*\[\{\s*google_search:\s*\{\}\s*\}\]/.test(MATCH_FN));
  assert.ok(/trackedGenerate\(/.test(MATCH_FN),
    '2026-08-19 fix: match() used to call axios.post directly and write nothing to CostLog');
  assert.strictEqual((MATCH_FN.match(/axios\.post\(/g) || []).length, 0,
    'a raw axios.post surviving here means it is billable and unledgered again');
  assert.strictEqual((MATCH_FN.match(/chatCompletion\(/g) || []).length, 0,
    'match() is genuinely grounded and must never move to Atlas');
});

console.log('C. the two transports never cross-contaminate the shared MODEL/ENDPOINT constants');

check('C1 chatCompletion is imported from atlasLlmService, not re-implemented', () => {
  assert.ok(/const\s*\{\s*chatCompletion\s*\}\s*=\s*require\(['"]\.\.\/atlasLlmService['"]\)/.test(src));
});

check('C2 ENDPOINT (the direct Gemini REST URL) is never referenced inside structureReviewNarrative', () => {
  assert.ok(!/\bENDPOINT\b/.test(STRUCTURE_FN),
    'the Atlas-routed pass must not fall back to the direct URL under any code path');
});

check('C3 the ATLAS GROUNDING PROBE evidence comment is present and dated', () => {
  assert.ok(/ATLAS GROUNDING PROBE/.test(src));
  assert.ok(/2026-08-19/.test(src));
  // The four concrete probe outcomes, so a future edit cannot quietly soften
  // "proven" back into "asserted" without this failing.
  assert.ok(/HTTP 400/.test(src), 'the live 400 rejections must stay documented');
  assert.ok(/SILENTLY IGNORED/.test(src), 'the silently-ignored web_search:true flag must stay documented');
});

if (failures.length) {
  console.log(`\n❌ verifyGeminiSearchAtlasRouting: ${failures.length} of ${pass + failures.length} checks FAILED`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`\n✅ verifyGeminiSearchAtlasRouting: ${pass}/${pass} checks passed`);
