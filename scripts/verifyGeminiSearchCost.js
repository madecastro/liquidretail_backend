#!/usr/bin/env node
'use strict';
/**
 * verifyGeminiSearchCost — guards the cost ledger on the grounded-search path.
 *
 * WHY THIS EXISTS
 * geminiSearchProvider.lookupBrandReviews / lookupProductReviews call the raw
 * generativelanguage REST API directly with axios — they do not go through
 * atlasLlmService, so nothing ledgered them. Every brand/product enrichment run
 * (and every backfill sweep) billed Google twice per lookup and wrote no CostLog
 * row, while the sibling GPT-4.1 tier in the same service showed up on every
 * spend report. A $0 path is indistinguishable from a free one, which is exactly
 * how this stayed invisible.
 *
 * Three failure modes are pinned here, all of which produce a row that LOOKS
 * measured while being wrong:
 *
 *   1. Wrapping the axios RESPONSE instead of the response BODY. extractUsage
 *      reads usageMetadata off the resolved value; on raw REST that lives on
 *      `res.data`. Return `res` and every token count silently reads 0.
 *   2. Dropping the grounding surcharge. Google bills Search grounding per
 *      REQUEST ($35/1,000 prompts) on top of tokens. On these calls grounding is
 *      ~90% of the true cost — token math alone understates it ~10x.
 *   3. Counting candidatesTokenCount alone. Gemini reports thinking tokens
 *      separately in thoughtsTokenCount but bills them at the OUTPUT rate, and
 *      2.5 models think by default unless thinkingBudget is 0 (pass 1 does not
 *      set it). Tool-use prompt tokens are likewise reported separately.
 *
 * Pure — no DB, no network, no API key. axios.post and CostLog.create are
 * stubbed, so the "live" checks exercise the real provider + real costTracker
 * without spending anything.
 */

// Pin the env BEFORE any require: costTracker resolves the grounding surcharge
// and the provider resolves MODEL at module load, so a stray local override
// would silently change the expected arithmetic below.
delete process.env.GEMINI_GROUNDING_COST_USD;
delete process.env.GEMINI_SEARCH_MODEL;
process.env.GEMINI_API_KEY = 'test-key-not-a-real-credential';   // only gates isEnabled()

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const costTracker = require('../services/costTracker');
const CostLog     = require('../models/CostLog');
const axios       = require('axios');
const provider    = require('../services/providers/geminiSearchProvider');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

// ── Test doubles ─────────────────────────────────────────────────────────────
// CostLog.create is replaced on the SAME module object costTracker holds, so
// persistCost writes land in `rows` instead of mongoose.
const rows = [];
CostLog.create = async (doc) => { rows.push(doc); return doc; };

const realAxiosPost = axios.post;
function stubAxios(handler) { axios.post = handler; }
function restoreAxios() { axios.post = realAxiosPost; }

// ── Source of truth for the arithmetic ───────────────────────────────────────
// Read live from https://ai.google.dev/gemini-api/docs/pricing on 2026-08-03.
const FLASH_INPUT_PER_1M  = 0.30;
const FLASH_OUTPUT_PER_1M = 2.50;   // "Output price includes thinking tokens"
const FLASH_CACHED_PER_1M = 0.03;
const GROUNDING_PER_CALL  = 0.035;  // "$35 / 1,000 grounded prompts"

// ── A. Wiring — asserted against the source, since "no bare axios.post" is not
//    observable at runtime. ────────────────────────────────────────────────────
const SRC_PATH = path.join(__dirname, '..', 'services', 'providers', 'geminiSearchProvider.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

// Top-level function bodies end at a `}` in column 0.
function fnBody(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  assert.notStrictEqual(start, -1, `function ${name} not found in source`);
  const end = SRC.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, `could not find end of ${name}`);
  return SRC.slice(start, end);
}
const BRAND_FN   = fnBody('lookupBrandReviews');
const PRODUCT_FN = fnBody('lookupProductReviews');
const HELPER_FN  = fnBody('trackedGenerate');

check('A1 lookupBrandReviews makes no unledgered axios.post', () => {
  assert.strictEqual((BRAND_FN.match(/axios\.post\(/g) || []).length, 0,
    'a raw axios.post survives in lookupBrandReviews — that call is billable and unledgered');
});
check('A2 lookupProductReviews makes no unledgered axios.post', () => {
  assert.strictEqual((PRODUCT_FN.match(/axios\.post\(/g) || []).length, 0,
    'a raw axios.post survives in lookupProductReviews — that call is billable and unledgered');
});
check('A3 both functions route exactly their two passes through trackedGenerate', () => {
  assert.strictEqual((BRAND_FN.match(/trackedGenerate\(/g) || []).length, 2);
  assert.strictEqual((PRODUCT_FN.match(/trackedGenerate\(/g) || []).length, 2);
});
check('A4 each function declares one grounded pass and one non-grounded pass', () => {
  for (const [name, body] of [['brand', BRAND_FN], ['product', PRODUCT_FN]]) {
    assert.strictEqual((body.match(/grounded:\s*true/g)  || []).length, 1, `${name}: expected 1 grounded pass`);
    assert.strictEqual((body.match(/grounded:\s*false/g) || []).length, 1, `${name}: expected 1 non-grounded pass`);
  }
});
check('A5 trackedGenerate resolves the response BODY, not the axios envelope', () => {
  // `return r;` here would zero every token count while still writing a row.
  assert.ok(/return r\.data;/.test(HELPER_FN),
    'trackedGenerate must return r.data — extractUsage reads usageMetadata off the body');
  assert.ok(!/return r;/.test(HELPER_FN));
});
check('A6 trackedGenerate pins maxRedirects:0 on the billable POST (CLAUDE.md §2)', () => {
  assert.ok(/maxRedirects:\s*0/.test(HELPER_FN),
    'axios defaults to 21 redirects and re-sends the body on 307/308 — a silent double charge');
});
check('A7 trackedGenerate ledgers the model actually configured, not a literal', () => {
  assert.ok(/model:\s*MODEL/.test(HELPER_FN),
    'hardcoding a model id would mis-rate the row whenever GEMINI_SEARCH_MODEL is set');
  assert.ok(/provider:\s*'gemini'/.test(HELPER_FN));
});

// ── B. Rate table — the numbers the arithmetic depends on. ───────────────────
check('B1 gemini-2.5-flash carries live-verified rates, not Flash-Lite ones', () => {
  const r = costTracker.MODEL_RATES['gemini-2.5-flash'];
  assert.ok(r, 'no MODEL_RATES entry — every row would ledger $0 tokens');
  assert.strictEqual(r.input,  FLASH_INPUT_PER_1M);
  assert.strictEqual(r.output, FLASH_OUTPUT_PER_1M);
  assert.strictEqual(r.cachedInput, FLASH_CACHED_PER_1M);
});
check('B2 the grounding surcharge is the published per-request price', () => {
  assert.strictEqual(costTracker.GROUNDED_SEARCH_COST_PER_REQUEST_USD, GROUNDING_PER_CALL);
});

// ── C. costTracker arithmetic, exercised through the real trackLlmCall. ──────
function geminiBody(usage, text = 'ok') {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: usage
  };
}
async function ledger(meta, body) {
  rows.length = 0;
  await costTracker.trackLlmCall(meta, async () => body);
  assert.strictEqual(rows.length, 1, 'expected exactly one CostLog row');
  return rows[0];
}

const BASE = { stage: 'brand_reviews', provider: 'gemini', model: 'gemini-2.5-flash' };

// CommonJS — no top-level await; the async checks run inside main().
async function main() {
await checkAsync('C1 thinking + tool-use tokens are counted, not just candidates', async () => {
  const row = await ledger({ ...BASE }, geminiBody({
    promptTokenCount: 1000, toolUsePromptTokenCount: 500,
    candidatesTokenCount: 800, thoughtsTokenCount: 200,
    cachedContentTokenCount: 0, totalTokenCount: 2500
  }));
  // Counting candidatesTokenCount alone would give 800 output / 1000 input.
  assert.strictEqual(row.inputTokens, 1500, 'toolUsePromptTokenCount must be added to input');
  assert.strictEqual(row.outputTokens, 1000, 'thoughtsTokenCount must be added to output');
});

await checkAsync('C2 a grounded call adds the per-request surcharge on top of tokens', async () => {
  const row = await ledger({ ...BASE, groundedRequests: 1 }, geminiBody({
    promptTokenCount: 1000, toolUsePromptTokenCount: 500,
    candidatesTokenCount: 800, thoughtsTokenCount: 200
  }));
  const tokens = (1500 / 1e6) * FLASH_INPUT_PER_1M + (1000 / 1e6) * FLASH_OUTPUT_PER_1M;
  assert.strictEqual(row.groundedRequests, 1);
  assert.strictEqual(row.costUsd, Number((tokens + GROUNDING_PER_CALL).toFixed(6)));
  // The point of the surcharge: it dominates. If this ratio ever inverts,
  // someone has changed the pricing assumption and the comment is now a lie.
  assert.ok(GROUNDING_PER_CALL / row.costUsd > 0.8,
    'grounding should be the majority of a grounded row; token-only math understates ~10x');
});

await checkAsync('C3 a non-grounded call carries no surcharge', async () => {
  const row = await ledger({ ...BASE, groundedRequests: 0 }, geminiBody({
    promptTokenCount: 2000, candidatesTokenCount: 300
  }));
  assert.strictEqual(row.groundedRequests, 0);
  assert.strictEqual(row.costUsd, Number(((2000 / 1e6) * FLASH_INPUT_PER_1M + (300 / 1e6) * FLASH_OUTPUT_PER_1M).toFixed(6)));
});

await checkAsync('C4 cached prompt tokens bill at the cached rate, not full input', async () => {
  const row = await ledger({ ...BASE }, geminiBody({
    promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 100
  }));
  // promptTokenCount already includes the cached portion, so full input is 600.
  const expect = (600 / 1e6) * FLASH_INPUT_PER_1M
               + (100 / 1e6) * FLASH_OUTPUT_PER_1M
               + (400 / 1e6) * FLASH_CACHED_PER_1M;
  assert.strictEqual(row.cachedInputTokens, 400);
  assert.strictEqual(row.costUsd, Number(expect.toFixed(6)));
});

await checkAsync('C5 returning the axios envelope zeroes the tokens (the trap A5 guards)', async () => {
  const usage = { promptTokenCount: 1000, candidatesTokenCount: 800 };
  const row = await ledger({ ...BASE }, { data: geminiBody(usage) });   // wrapped, i.e. `return r`
  assert.strictEqual(row.inputTokens, 0);
  assert.strictEqual(row.outputTokens, 0);
});

await checkAsync('C6 an unknown model still carries the grounding surcharge', async () => {
  // A renamed slug must not turn a $0.035 grounded call into a free one.
  const row = await ledger({ ...BASE, model: 'gemini-9.9-unreleased', groundedRequests: 1 },
    geminiBody({ promptTokenCount: 100, candidatesTokenCount: 100 }));
  assert.strictEqual(row.costUsd, GROUNDING_PER_CALL);
});

await checkAsync('C7 a failed call writes a row, and ledgers $0 — a KNOWN, deliberate limit', async () => {
  rows.length = 0;
  await assert.rejects(() => costTracker.trackLlmCall(
    { ...BASE, groundedRequests: 1 },
    async () => { throw new Error('boom'); }
  ));
  assert.strictEqual(rows.length, 1, 'a failure that may still have been billed must leave a trace');
  assert.strictEqual(rows[0].status, 'error');
  // PINNED SO IT STAYS A DECISION, NOT AN ACCIDENT. trackLlmCall's error path has
  // always ledgered $0 for every consumer, and this change does not alter that.
  // The gap is real: a grounded request that reached Google and then timed out on
  // the read was billed, and we record nothing. Fixing it means distinguishing
  // "never left the box" (ECONNREFUSED — not billed) from "server answered or we
  // timed out waiting" (probably billed), which is atlasImageService.chargedError's
  // job and a change to SHARED error semantics for every caller. Deliberately out
  // of scope here. If this assertion ever fails, that decision was revisited —
  // make sure it was on purpose.
  assert.strictEqual(rows[0].costUsd, 0);
  assert.strictEqual(rows[0].costSource, 'none');
  assert.strictEqual(rows[0].groundedRequests, 1, 'the attempted grounding is still recorded');
});

// ── D. End to end through the real provider functions. ──────────────────────
const NARRATIVE = 'Customers consistently praise the fit and the fabric weight. '.repeat(4);
// The quote text MUST be a literal substring of NARRATIVE above. This harness
// tests COST LEDGERING, not provenance, so the two were originally unrelated —
// 'The athletic fit is perfect.' appears nowhere in NARRATIVE. Since
// geminiSearchProvider.keepVerbatimQuotes now drops any quote the grounded
// narrative does not contain (the anti-fabrication guarantee), that fixture was
// modelling a FABRICATED quote and the provider correctly returned zero. Fixed by
// making the fixture honest rather than by relaxing the check.
const STRUCTURED = JSON.stringify({
  quotes: [{ text: 'Customers consistently praise the fit and the fabric weight.', author: 'Alex R.', source: 'trustpilot.com' }],
  rating: 4.6, reviewCount: 1200, summary: 'Broadly positive.'
});
const PASS1_USAGE = { promptTokenCount: 1000, toolUsePromptTokenCount: 500, candidatesTokenCount: 800, thoughtsTokenCount: 200 };
const PASS2_USAGE = { promptTokenCount: 2000, candidatesTokenCount: 300 };

// Grounded pass 1 is identifiable by the google_search tool in the body.
function twoPassStub() {
  return async (_url, body) => {
    const grounded = Array.isArray(body.tools) && body.tools.some(t => t.google_search);
    return {
      data: grounded
        ? Object.assign(geminiBody(PASS1_USAGE, NARRATIVE), {
            candidates: [{
              content: { parts: [{ text: NARRATIVE }] },
              groundingMetadata: { groundingChunks: [{ web: { uri: 'https://www.trustpilot.com/review/x', title: 'T' } }] }
            }],
            usageMetadata: PASS1_USAGE
          })
        : geminiBody(PASS2_USAGE, STRUCTURED)
    };
  };
}

const EXPECTED_PASS1 = Number((((1500 / 1e6) * FLASH_INPUT_PER_1M + (1000 / 1e6) * FLASH_OUTPUT_PER_1M) + GROUNDING_PER_CALL).toFixed(6));
const EXPECTED_PASS2 = Number(((2000 / 1e6) * FLASH_INPUT_PER_1M + (300 / 1e6) * FLASH_OUTPUT_PER_1M).toFixed(6));

await checkAsync('D1 lookupBrandReviews ledgers both passes with brand linkage', async () => {
  rows.length = 0;
  stubAxios(twoPassStub());
  const brandId = '6a4e7ea956509c2169977681';
  const out = await provider.lookupBrandReviews({ brandName: 'Allbirds', brandUrl: 'allbirds.com', brandId });
  restoreAxios();

  assert.ok(out && out.quotes.length === 1, 'provider still returns its normal shape');
  assert.strictEqual(rows.length, 2, 'both the grounded pass and the structuring pass must be ledgered');
  assert.deepStrictEqual(rows.map(r => r.stage), ['brand_reviews', 'brand_reviews']);
  assert.deepStrictEqual(rows.map(r => r.purposeTag), ['grounded_search', 'json_structure']);
  assert.deepStrictEqual(rows.map(r => r.groundedRequests), [1, 0]);
  assert.strictEqual(rows[0].brandId, brandId, 'brandId must reach CostLog for the per-brand rollup');
  assert.strictEqual(rows[0].model, 'gemini-2.5-flash');
  assert.strictEqual(rows[0].costUsd, EXPECTED_PASS1);
  assert.strictEqual(rows[1].costUsd, EXPECTED_PASS2);
});

await checkAsync('D2 lookupProductReviews ledgers both passes with product linkage', async () => {
  rows.length = 0;
  stubAxios(twoPassStub());
  const brandId = '6a4e7ea956509c2169977681';
  const productId = '6a70cf95aa11bb22cc33dd44';
  const out = await provider.lookupProductReviews({
    productName: "Men's Tree Runner NZ", brandName: 'Allbirds', productUrl: 'allbirds.com/x', brandId, productId
  });
  restoreAxios();

  assert.ok(out && out.quotes.length === 1);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r.stage), ['product_reviews', 'product_reviews']);
  assert.strictEqual(rows[0].productId, productId);
  assert.strictEqual(rows[0].brandId, brandId);
});

await checkAsync('D3 a lookup with no ids still produces rows (linkage is optional)', async () => {
  rows.length = 0;
  stubAxios(twoPassStub());
  await provider.lookupBrandReviews({ brandName: 'Gymshark' });
  restoreAxios();
  assert.strictEqual(rows.length, 2, 'a caller without a Brand row must still be billed into the ledger');
  assert.strictEqual(rows[0].brandId, null);
});

await checkAsync('D4 a failed grounded pass is ledgered, not silently swallowed', async () => {
  rows.length = 0;
  stubAxios(async () => { throw new Error('ECONNRESET'); });
  const out = await provider.lookupBrandReviews({ brandName: 'Vuori' });
  restoreAxios();
  assert.strictEqual(out, null, 'provider still soft-fails to null for its callers');
  assert.strictEqual(rows.length, 1, 'the attempt must leave a row');
  assert.strictEqual(rows[0].status, 'error');
});

restoreAxios();
}

main().then(() => {
  if (failures.length) {
    console.error(`❌ verifyGeminiSearchCost: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyGeminiSearchCost: ${pass}/${pass} checks passed`);
}).catch((err) => {
  restoreAxios();
  console.error(`❌ verifyGeminiSearchCost: harness threw — ${err.stack || err.message}`);
  process.exit(1);
});
