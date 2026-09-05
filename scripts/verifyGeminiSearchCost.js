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
 *
 * UPDATED 2026-08-19: pass 2 (the JSON-structuring half of lookupBrandReviews
 * / lookupProductReviews — never grounded) moved off this raw REST transport
 * onto Atlas (atlasLlmService.chatCompletion, model google/gemini-2.5-flash).
 * Pass 1 (grounded search) is UNCHANGED and still the subject of most of this
 * file. Section D's stub now branches on request URL so one monkey-patched
 * `axios.post` (shared by this file's own axios require AND
 * atlasLlmService's, since Node's module cache makes both the same object)
 * can serve both transports. See scripts/verifyGeminiSearchAtlasRouting.js
 * for the dedicated, revert-proven pin on the ROUTING decision itself; this
 * file keeps owning the COST ARITHMETIC.
 */

// Pin the env BEFORE any require: costTracker resolves the grounding surcharge
// and the provider resolves MODEL at module load, so a stray local override
// would silently change the expected arithmetic below.
delete process.env.GEMINI_GROUNDING_COST_USD;
// Same reason as the line above: these checks pin the SHIPPED DEFAULT, so an
// operator's override must not be able to make the suite pass against a value
// nobody ships. Added 2026-08-19 with the vision surcharge's $0 default.
delete process.env.VISION_IMAGE_COST_USD;
delete process.env.GEMINI_GROUNDING_FREE_RPD;
delete process.env.GEMINI_SEARCH_MODEL;
process.env.GEMINI_API_KEY = 'test-key-not-a-real-credential';   // only gates isEnabled()
// Pass 2 now goes through atlasLlmService.chatCompletion, which only
// attempts the Atlas branch when this is set (isConfigured()).
process.env.ATLAS_API_KEY = 'test-key-not-a-real-credential';
// Chain/retry tuning: keep the harness fast. chatCompletion retries a failed
// Atlas attempt MAX_ATTEMPTS times with BACKOFF_MS*n sleeps between — at the
// real defaults (3 attempts, 3000ms) a single failure test would sleep
// several real seconds. These are read at module load by atlasLlmService,
// so they must be set before it is required (directly or transitively via
// geminiSearchProvider).
process.env.ATLAS_LLM_MAX_ATTEMPTS = '1';
process.env.ATLAS_LLM_BACKOFF_MS = '1';

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
// The POST-ALLOWANCE price. Not what a grounded row costs today: the first
// 1,500 grounded prompts each UTC day are free on the paid tier too, and
// measured volume is ~1% of that, so the shipped default is $0. This constant
// is what the surcharge becomes when GEMINI_GROUNDING_COST_USD is set past the
// allowance. See services/costTracker.js §FREE-ALLOWANCE.
const GROUNDING_POST_ALLOWANCE_PER_CALL = 0.035;  // "$35 / 1,000 grounded prompts"
// What the ledger actually charges a grounded request with no env override.
const GROUNDING_PER_CALL  = 0;
// Atlas's google/gemini-2.5-flash listing — read live 2026-08-19 against
// GET https://api.atlascloud.ai/api/v1/models. Same input/output rate as
// direct; only cachedInput differs slightly (0.075 vs 0.03) and no fixture
// below exercises caching on the Atlas path, so that difference is not
// asserted here.
const ATLAS_FLASH_INPUT_PER_1M  = 0.30;
const ATLAS_FLASH_OUTPUT_PER_1M = 2.50;

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
const BRAND_FN     = fnBody('lookupBrandReviews');
const PRODUCT_FN   = fnBody('lookupProductReviews');
const HELPER_FN    = fnBody('trackedGenerate');
// Pass 2 (json_structure), UPDATED 2026-08-19 — moved off this file's raw
// REST transport onto Atlas. Its own fnBody is checked separately (A8/A9)
// rather than folded into BRAND_FN/PRODUCT_FN, because it is now called from
// both, not embedded in either.
const STRUCTURE_FN = fnBody('structureReviewNarrative');

check('A1 lookupBrandReviews makes no unledgered axios.post', () => {
  assert.strictEqual((BRAND_FN.match(/axios\.post\(/g) || []).length, 0,
    'a raw axios.post survives in lookupBrandReviews — that call is billable and unledgered');
});
check('A2 lookupProductReviews makes no unledgered axios.post', () => {
  assert.strictEqual((PRODUCT_FN.match(/axios\.post\(/g) || []).length, 0,
    'a raw axios.post survives in lookupProductReviews — that call is billable and unledgered');
});
check('A3 both functions route their GROUNDED pass through trackedGenerate exactly once (pass 2 moved to Atlas)', () => {
  // Was 2 (pass 1 + pass 2) before the 2026-08-19 Atlas migration of pass 2.
  // Now exactly 1 — pass 2 calls structureReviewNarrative instead (A3b).
  assert.strictEqual((BRAND_FN.match(/trackedGenerate\(/g) || []).length, 1);
  assert.strictEqual((PRODUCT_FN.match(/trackedGenerate\(/g) || []).length, 1);
});
check('A3b both functions call the SHARED structureReviewNarrative for pass 2, not a re-implemented literal', () => {
  assert.strictEqual((BRAND_FN.match(/structureReviewNarrative\(/g) || []).length, 1);
  assert.strictEqual((PRODUCT_FN.match(/structureReviewNarrative\(/g) || []).length, 1);
});
check('A4 each function declares its (sole, grounded) trackedGenerate pass as grounded:true', () => {
  // grounded:false no longer appears anywhere in these two functions — pass 2
  // does not use trackedGenerate's grounded flag at all now (it is not a
  // Google-Search-grounding concept on the Atlas/OpenAI-compat transport).
  for (const [name, body] of [['brand', BRAND_FN], ['product', PRODUCT_FN]]) {
    assert.strictEqual((body.match(/grounded:\s*true/g)  || []).length, 1, `${name}: expected 1 grounded pass`);
    assert.strictEqual((body.match(/grounded:\s*false/g) || []).length, 0,
      `${name}: grounded:false should no longer appear — pass 2 moved off trackedGenerate entirely`);
  }
});
check('A8 structureReviewNarrative (pass 2, shared) calls chatCompletion, not axios.post directly', () => {
  assert.strictEqual((STRUCTURE_FN.match(/axios\.post\(/g) || []).length, 0,
    'pass 2 must not call axios.post directly — it is unledgered exactly the way A1/A2 guard against');
  assert.ok(/chatCompletion\(/.test(STRUCTURE_FN),
    'pass 2 must route through atlasLlmService.chatCompletion');
});
check('A9 structureReviewNarrative never declares a google_search tool (it must stay ungrounded)', () => {
  // If this function ever grows a `tools` field, it has become a grounded
  // call that must NOT be on Atlas — see the ATLAS GROUNDING PROBE comment.
  assert.ok(!/google_search/.test(STRUCTURE_FN),
    'pass 2 must never request grounding — if it needs to, it must move back to the direct transport');
});
check('A5 trackedGenerate resolves the response BODY, not the axios envelope', () => {
  // `return r;` here would zero every token count while still writing a row.
  assert.ok(/return r\.data;/.test(HELPER_FN),
    'trackedGenerate must return r.data — extractUsage reads usageMetadata off the body');
  assert.ok(!/return r;/.test(HELPER_FN));
});
check('A6 trackedGenerate pins maxRedirects:0 on the billable POST (CLAUDE.md §2)', () => {
  // Strip comments first — the call already documents the pin in a
  // `// maxRedirects:0 per CLAUDE.md §2` comment, which used to satisfy
  // this check after the real `{ timeout, maxRedirects: 0 }` was deleted.
  // Same recipe as verifyLlmErrorCodes.js D5.
  const HELPER_FN_CODE = HELPER_FN
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(/maxRedirects:\s*0\b/.test(HELPER_FN_CODE),
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
check('B2 a grounded request ledgers $0 by default — inside Google\'s free daily allowance', () => {
  // CHANGED 2026-08-19 (was pinned to 0.035). Google's 1,500-grounded-prompts/day
  // allowance applies to the paid tier; measured volume is 13-19/day, ~1% of it.
  // The old default claimed $1.1200 over 7 days for calls Google never billed —
  // 89.9% of all direct-Gemini spend in the window.
  assert.strictEqual(costTracker.GROUNDED_SEARCH_COST_PER_REQUEST_USD, GROUNDING_PER_CALL);
  assert.strictEqual(GROUNDING_PER_CALL, 0, 'the shipped default must be $0, not the post-allowance price');
});
check('B2b the free allowance is declared, so the $0 default is bounded rather than blind', () => {
  // Without this, $0 would be an unexamined guess. With it, the ledger knows the
  // number it is betting on and alerts as the day's volume approaches it.
  assert.strictEqual(costTracker.GEMINI_GROUNDING_FREE_RPD, 1500);
});
check('B2c the post-allowance price is still reachable via env, unchanged', () => {
  // The $0 default is a claim about VOLUME, not about Google's price list. If
  // volume ever exhausts the allowance the operator sets GEMINI_GROUNDING_COST_USD
  // and every grounded row prices at $35/1,000 again. Pin the parser so that
  // escape hatch cannot rot: an env value must survive as an exact float.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'costTracker.js'), 'utf8');
  assert.ok(/process\.env\.GEMINI_GROUNDING_COST_USD/.test(src),
    'the env override must remain the way to price past the allowance');
  assert.strictEqual(GROUNDING_POST_ALLOWANCE_PER_CALL, 0.035);
});
check('B2d the vision surcharge is $0 — image tokens are already inside prompt_tokens', () => {
  // Measured 2026-08-19 against Atlas's settled billing: on 2026-08-17 this
  // surcharge was 99.2% of a $1.3705 over-claim (260 images x $0.005 = $1.3000).
  // Removing it took that day from +40.1% to +0.3%. Every provider in
  // extractUsage() reports image tokens in its prompt-token count, so charging
  // per image on top billed the same pixels twice.
  assert.strictEqual(costTracker.VISION_IMAGE_COST_PER_IMAGE_USD, 0);
});
check('B1b Atlas google/gemini-2.5-flash (pass 2\'s new home) is priced too, and matches direct', () => {
  // Read live 2026-08-19 against GET https://api.atlascloud.ai/api/v1/models.
  const r = costTracker.MODEL_RATES['google/gemini-2.5-flash'];
  assert.ok(r, 'no MODEL_RATES entry for the Atlas slug — pass 2 would ledger $0 tokens');
  assert.strictEqual(r.input,  ATLAS_FLASH_INPUT_PER_1M);
  assert.strictEqual(r.output, ATLAS_FLASH_OUTPUT_PER_1M);
  // Same price as the direct rate — the whole point of the model-choice
  // comment in structureReviewNarrative: no cost argument either way, only
  // the transport changed.
  assert.strictEqual(r.input,  FLASH_INPUT_PER_1M);
  assert.strictEqual(r.output, FLASH_OUTPUT_PER_1M);
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

await checkAsync('C2 a grounded call costs its tokens and nothing more, while inside the allowance', async () => {
  // REWRITTEN 2026-08-19. This check previously asserted the inverse — that the
  // surcharge DOMINATED the row (>80% of it). That was true of the arithmetic and
  // false about our bill: the calls were inside Google's free 1,500/day allowance,
  // so the dominant component was money nobody charged us.
  const row = await ledger({ ...BASE, groundedRequests: 1 }, geminiBody({
    promptTokenCount: 1000, toolUsePromptTokenCount: 500,
    candidatesTokenCount: 800, thoughtsTokenCount: 200
  }));
  const tokens = (1500 / 1e6) * FLASH_INPUT_PER_1M + (1000 / 1e6) * FLASH_OUTPUT_PER_1M;
  assert.strictEqual(row.groundedRequests, 1);
  assert.strictEqual(row.costUsd, Number((tokens + GROUNDING_PER_CALL).toFixed(6)));
  // The declaration must SURVIVE even though it no longer moves the price — it is
  // what the allowance counter and any future Google-billing reconcile run on.
  // A row that forgets it was grounded is unrecoverable after the fact.
  assert.strictEqual(row.groundedRequests, 1, 'grounding must stay declared even at $0');
  assert.strictEqual(row.costUsd, Number(tokens.toFixed(6)),
    'at the shipped default a grounded row is exactly its token cost');
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

await checkAsync('C6 an unknown model is stamped UNKNOWN, not quietly priced at the surcharge', async () => {
  // REWRITTEN 2026-08-19. This used to assert the row still carried $0.035, on the
  // reasoning that a renamed slug must not make a grounded call look free. With the
  // surcharge at its correct $0 that costUsd is now 0 — so the protection has to
  // come from costSource:'unknown', which says "the token cost was NOT computed"
  // rather than "nothing was charged". That distinction is the real guard, and it
  // holds at any surcharge value.
  const row = await ledger({ ...BASE, model: 'gemini-9.9-unreleased', groundedRequests: 1 },
    geminiBody({ promptTokenCount: 100, candidatesTokenCount: 100 }));
  assert.strictEqual(row.costUsd, GROUNDING_PER_CALL);
  assert.strictEqual(row.costSource, 'unknown',
    'an unmapped model must never pass as a real estimate — $0 here means uncomputed, not free');
  assert.strictEqual(row.groundedRequests, 1);
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
const NARRATIVE = 'These are incredibly comfortable and the quality is amazing. '.repeat(4);
// The quote text MUST satisfy EVERY intake gate, because this harness drives the real
// provider. Twice now a tightened gate broke this fixture, and both times the fix was
// to make the FIXTURE honest rather than to relax the gate:
//   1. keepVerbatimQuotes requires the quote to be a literal substring of the
//      narrative. 'The athletic fit is perfect.' appeared nowhere in NARRATIVE, so the
//      fixture was modelling a FABRICATED quote and the provider correctly returned 0.
//   2. screenAdUsableSentiment requires clear praise (owner directive: mediocre and
//      negative never pass any gate). 'Customers consistently praise the fit and the
//      fabric weight.' is a NARRATOR sentence about reviews, not customer praise, so
//      it was correctly dropped. The fixture now reads like something a customer wrote.
// If this fixture breaks again, check which gate tightened before touching the check.
const STRUCTURED = JSON.stringify({
  quotes: [{ text: 'These are incredibly comfortable and the quality is amazing.', author: 'Alex R.', source: 'trustpilot.com' }],
  rating: 4.6, reviewCount: 1200, summary: 'Broadly positive.'
});
const PASS1_USAGE = { promptTokenCount: 1000, toolUsePromptTokenCount: 500, candidatesTokenCount: 800, thoughtsTokenCount: 200 };
// UPDATED 2026-08-19: pass 2 now goes through Atlas's OpenAI-compatible
// surface, so its usage arrives in OpenAI field names (prompt_tokens /
// completion_tokens), not Gemini's (promptTokenCount / candidatesTokenCount).
// Same NUMBERS as the pre-migration PASS2_USAGE (2000 / 300) so EXPECTED_PASS2
// below is unchanged in value — only the transport and field names moved.
const PASS2_ATLAS_USAGE = { prompt_tokens: 2000, completion_tokens: 300 };

// Pass 1 (direct Gemini REST, still grounded) is identifiable by its URL;
// pass 2 (Atlas chat.completions, structuring) by its URL. Branching on URL
// rather than on the google_search tool is now required because the two
// passes are genuinely different transports with different request/response
// shapes, not just different request bodies against the same endpoint.
function threeWayStub() {
  return async (url, body) => {
    if (String(url).includes('atlascloud.ai')) {
      // Atlas's OpenAI-compatible chat.completions response shape.
      return {
        status: 200,
        data: {
          id: 'chatcmpl-test', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: STRUCTURED }, finish_reason: 'stop' }],
          usage: PASS2_ATLAS_USAGE
        }
      };
    }
    const grounded = Array.isArray(body.tools) && body.tools.some(t => t.google_search);
    assert.ok(grounded, 'the only non-Atlas URL this stub expects is the grounded pass-1 REST call');
    return {
      status: 200,
      data: Object.assign(geminiBody(PASS1_USAGE, NARRATIVE), {
        candidates: [{
          content: { parts: [{ text: NARRATIVE }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://www.trustpilot.com/review/x', title: 'T' } }] }
        }],
        usageMetadata: PASS1_USAGE
      })
    };
  };
}

// GROUNDING_PER_CALL is 0 at the shipped default, so pass 1 is now its token cost.
// Kept as an explicit term rather than dropped: setting GEMINI_GROUNDING_COST_USD
// past the allowance must keep this expectation correct without an edit here.
const EXPECTED_PASS1 = Number((((1500 / 1e6) * FLASH_INPUT_PER_1M + (1000 / 1e6) * FLASH_OUTPUT_PER_1M) + GROUNDING_PER_CALL).toFixed(6));
const EXPECTED_PASS2 = Number(((2000 / 1e6) * ATLAS_FLASH_INPUT_PER_1M + (300 / 1e6) * ATLAS_FLASH_OUTPUT_PER_1M).toFixed(6));

await checkAsync('D1 lookupBrandReviews ledgers both passes with brand linkage — pass 1 gemini, pass 2 atlas', async () => {
  rows.length = 0;
  stubAxios(threeWayStub());
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
  // THE OBSERVABLE PROOF THIS ROUTING FIX TOOK EFFECT: pass 2's provider flips
  // from 'gemini' (direct) to 'atlas', same stage, same purposeTag string.
  // A dashboard querying CostLog by (stage, purposeTag, provider) sees exactly
  // this split without reading a line of code.
  assert.strictEqual(rows[1].provider, 'atlas', 'pass 2 must now be served by Atlas, not the direct key');
  assert.strictEqual(rows[1].model, 'google/gemini-2.5-flash');
  assert.strictEqual(rows[1].brandId, brandId, 'linkage must survive the transport change too');
  assert.strictEqual(rows[1].costUsd, EXPECTED_PASS2);
});

await checkAsync('D2 lookupProductReviews ledgers both passes with product linkage — pass 1 gemini, pass 2 atlas', async () => {
  rows.length = 0;
  stubAxios(threeWayStub());
  const brandId = '6a4e7ea956509c2169977681';
  const productId = '6a70cf95aa11bb22cc33dd44';
  const out = await provider.lookupProductReviews({
    productName: "Men's Tree Runner NZ", brandName: 'Allbirds', productUrl: 'allbirds.com/x', brandId, productId
  });
  restoreAxios();

  assert.ok(out && out.quotes.length === 1);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r.stage), ['product_reviews', 'product_reviews']);
  assert.deepStrictEqual(rows.map(r => r.provider), ['gemini', 'atlas']);
  assert.strictEqual(rows[0].productId, productId);
  assert.strictEqual(rows[0].brandId, brandId);
  assert.strictEqual(rows[1].productId, productId, 'pass 2 linkage must survive the transport change');
  assert.strictEqual(rows[1].brandId, brandId);
});

await checkAsync('D3 a lookup with no ids still produces rows (linkage is optional)', async () => {
  rows.length = 0;
  stubAxios(threeWayStub());
  await provider.lookupBrandReviews({ brandName: 'Gymshark' });
  restoreAxios();
  assert.strictEqual(rows.length, 2, 'a caller without a Brand row must still be billed into the ledger');
  assert.strictEqual(rows[0].brandId, null);
  assert.strictEqual(rows[1].brandId, null);
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
