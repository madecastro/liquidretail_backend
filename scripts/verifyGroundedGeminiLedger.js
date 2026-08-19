#!/usr/bin/env node
'use strict';
/**
 * verifyGroundedGeminiLedger — the SECOND pass of the grounded-Gemini cost
 * ledger, covering the two call sites PR #229 deliberately left out of scope:
 *
 *   1. services/categoryReviewsService.js         — category-level grounded
 *      review search (pass 1) + narrative→JSON structuring (pass 2). Reachable
 *      from UGC/IG detect whenever the 30-day category-reviews cache misses
 *      (productMatchService → maybeFetchCategoryReviewsCached).
 *   2. services/productDetailsService.fetchReviewSummary — product-level
 *      grounded review narrative. Reachable from UGC product_match and from the
 *      user-triggered "Enrich", gated on SERPAPI_API_KEY (for the SIBLING
 *      shopping lookup), not on its own key.
 *
 * BOTH were bare `axios.post` calls to generativelanguage.googleapis.com with
 * no trackLlmCall, so they billed Google — including the ~$0.035-per-request
 * Google Search grounding surcharge, which dwarfs the token cost — and wrote
 * NOTHING to CostLog. A $0 path is indistinguishable from a free one; that is
 * how they stayed invisible, and it is the same defect `match()` had.
 *
 * WHAT IS PINNED, AND WHY EACH CHECK EARNS ITS PLACE
 *  · Section E (source + import resolution). "No bare axios.post in this file"
 *    is not observable at runtime, so it is asserted over source — but per
 *    CLAUDE.md's `receiptFree` lesson, a harness that asserts a call site uses a
 *    helper MUST also assert the file actually IMPORTS it (a regex cannot see an
 *    unbound identifier, and `node --check` cannot either), so E3 requires the
 *    module and reads the binding.
 *  · Section F (behavioural). Calls the REAL provider functions against a
 *    stubbed axios and the REAL costTracker, then inspects the CostLog rows —
 *    stage, purposeTag, provider, groundedRequests, linkage ids and exact
 *    dollars. A source-text check cannot tell a correct row from a row with 0
 *    tokens, which is the specific trap here (returning the axios envelope
 *    instead of the response BODY writes a row that LOOKS measured).
 *  · Section G (the request bodies as SENT). maxRedirects:0 and "pass 2 sends no
 *    tools" are properties of the outgoing request, so they are read off the
 *    stub rather than off the source.
 *
 * REVERT-PROVEN, MECHANICALLY, NOT BY EYE (2026-08-19). Fifteen mutations were
 * applied to the real source one at a time, this harness re-run against each,
 * and each confirmed to FAIL with the named checks before the mutation was
 * reverted. The list is the checks that actually tripped, not the ones intended:
 *
 *   M1  whole categoryReviewsService reverted        → E0,E1,E3,E4,E5,E6,E7,F1-F4,F7,F9,F10,G1-G3
 *   M2  whole productDetailsService reverted         → E2,E3,E4,E7,E8,F4,F5,F6,F8,F9,F10,G1,G2
 *   M3  provider stops EXPORTING trackedGenerate     → E3 + every behavioural check
 *   M4  drop grounded:true, category pass 1          → F1,F4,F10
 *   M5  drop grounded:true, fetchReviewSummary       → F4,F5,F10
 *   M6  trackedGenerate returns the axios ENVELOPE   → F1,F2,F3,F4,F5,F7,F8,F9,G3
 *   M7  trackedGenerate drops maxRedirects:0         → G2
 *   M8  category pass 1 stops asking google_search   → E5,G1
 *   M9  fetchAndCache stops threading brandId        → F7
 *   M10 fetchProductDetails drops catalogProductId   → F8
 *   M11 structureCategoryNarrative grows `tools`     → E6,G3
 *   M12 pass 2 borrows the provider's ratings[]      → G3
 *   M13 file drops the model import, re-reads the env→ E7
 *   M14 category pass 1 ledgers the wrong stage      → F1,F3
 *   M15 pass 2 reverts to trackedGenerate            → E6,F1,F3,F7,G1,G2,G3
 *
 * TWO BUGS IN THIS HARNESS THAT THE MATRIX FOUND, worth recording because both
 * are the generic failure mode of a verify script and both would have shipped:
 *   · A source regex for `tools: [{ google_search: {} }]` PASSED against M8,
 *     which deleted the field — it was matching the COMMENT that documents it.
 *     Every source assertion here now reads comment-stripped text, and the
 *     grounded-tool claim is owned behaviourally by G1 (the request as sent).
 *   · M1 killed the harness at module load (a top-level fnBody assert) — rc=1
 *     with ZERO named failures, which reads like a crash rather than a revert.
 *     fnBody now returns '' and E0 names the missing function.
 *
 * Pure — no DB, no network, no API key. axios.post and CostLog.create are
 * stubbed, so nothing is spent.
 *
 * Companions: scripts/verifyGeminiSearchCost.js owns the cost ARITHMETIC and
 * the brand/product review lookups; scripts/verifyGeminiSearchAtlasRouting.js
 * owns the grounded-stays-direct / ungrounded-may-move ROUTING decision inside
 * the provider. This file owns the two OTHER files that share the transport.
 */

// Pin the env BEFORE any require: costTracker resolves the grounding surcharge
// and the provider resolves its MODEL at module load.
delete process.env.GEMINI_GROUNDING_COST_USD;
delete process.env.GEMINI_SEARCH_MODEL;
process.env.GEMINI_API_KEY = 'test-key-not-a-real-credential';   // only gates isEnabled()
// Pass 2 goes through atlasLlmService.chatCompletion, which only attempts the
// Atlas branch when this is set (isConfigured()).
process.env.ATLAS_API_KEY  = 'test-key-not-a-real-credential';
// Keep the harness fast — read at module load by atlasLlmService.
process.env.ATLAS_LLM_MAX_ATTEMPTS = '1';
process.env.ATLAS_LLM_BACKOFF_MS   = '1';
// productDetailsService trims SERPAPI_API_KEY into a module-load const and gates
// fetchProductDetails on it. F8 drives that REAL entry point (see its comment),
// so the gate has to be satisfiable before the require below. No network: the
// SerpAPI axios.get is stubbed too.
process.env.SERPAPI_API_KEY = 'test-key-not-a-real-credential';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const costTracker = require('../services/costTracker');
const CostLog    = require('../models/CostLog');
const axios      = require('axios');
const provider   = require('../services/providers/geminiSearchProvider');
const CatalogProduct = require('../models/CatalogProduct');
const categorySvc = require('../services/categoryReviewsService');
const Category   = require('../models/Category');
const Brand      = require('../models/Brand');
const detailsSvc  = require('../services/productDetailsService');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message.split('\n')[0].slice(0, 400)}`); }
}
async function checkAsync(label, fn) {
  // ALWAYS un-stub, even when an assertion throws mid-check. `check`/`checkAsync`
  // swallow the error and continue, so a throw between stubAxios() and
  // restoreAxios() would leak a stub into the NEXT check — and a leaked stub
  // makes later checks pass or fail for reasons that have nothing to do with the
  // code under test. Restoring in `finally` removes that class outright rather
  // than relying on every check remembering to restore on its own.
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message.split('\n')[0].slice(0, 400)}`); }
  finally { restoreAxios(); restoreSerp(); }
}

// ── Test doubles ─────────────────────────────────────────────────────────────
// Same module object costTracker holds, so persistCost writes land in `rows`.
const rows = [];
// VALIDATES against the real mongoose schema before accepting a row — not a
// bare `rows.push(doc)`. `persistCost` (services/costTracker.js) wraps its own
// real CostLog.create in a try/catch and treats a ValidationError specially:
// the row is DROPPED, loudly logged, and an alert fires. A stub that skips
// validation would let a mutation ship a schema-invalid row (e.g.
// `costSource:'grounded'`, not in CostLog.COST_SOURCES) straight into `rows`,
// where every check here would see it as a normal row instead of the DROPPED
// row production would actually have. `validateSync()` is the same call
// `liveProbe.js` used to prove the real live-tested rows would have persisted;
// this makes that guarantee load-bearing for every check, not just a one-off.
CostLog.create = async (doc) => {
  const err = new CostLog(doc).validateSync();
  if (err) throw err;   // matches persistCost's real behaviour: a bad row never lands
  rows.push(doc);
  return doc;
};

// F8 drives the real fetchProductDetails, which reads and writes a CatalogProduct
// row around the call under test. Stubbed to "no such row" so the cache read
// misses (forcing the live path) and the write-through returns early.
CatalogProduct.findById = () => ({ select: () => ({ lean: async () => null }) });
CatalogProduct.updateOne = async () => ({ acknowledged: true });
// F7 drives the REAL fetchAndCache, which touches Category + Brand. Stub both
// write paths so the check proves the LINKAGE (brandId reaching CostLog), not
// Mongo connectivity. findOrCreateCategoryTree is a named export on the
// Category model object, same shape as the real module.
Category.findOrCreateCategoryTree = async () => 'stub-category-leaf-id';
Category.updateOne = async () => ({ acknowledged: true });
Brand.updateOne = async () => ({ acknowledged: true });

const realAxiosGet = axios.get;
function stubSerp(shoppingResults) {
  axios.get = async () => ({ status: 200, data: { shopping_results: shoppingResults } });
}
function restoreSerp() { axios.get = realAxiosGet; }

const realAxiosPost = axios.post;
const sent = [];                          // every outgoing request, as sent
function stubAxios(handler) {
  axios.post = async (url, body, config) => {
    sent.push({ url: String(url), body, config });
    return handler(url, body, config);
  };
}
function restoreAxios() { axios.post = realAxiosPost; }

// ── Rates, read live from the provider pricing pages ─────────────────────────
const FLASH_INPUT_PER_1M  = 0.30;
const FLASH_OUTPUT_PER_1M = 2.50;   // "Output price includes thinking tokens"
const GROUNDING_PER_CALL  = 0.035;  // "$35 / 1,000 grounded prompts", 2.5-era: per PROMPT
const ATLAS_FLASH_INPUT_PER_1M  = 0.30;
const ATLAS_FLASH_OUTPUT_PER_1M = 2.50;

// THREE surfaces are in play, and conflating them hides a real row.
//   · GEN_CONTENT  — the grounded direct REST call (`:generateContent`). The one
//                    thing that cannot move to Atlas.
//   · atlascloud   — the Atlas gateway, where the ungrounded structuring pass now
//                    lives.
//   · GOOGLE_OAI   — Gemini's OpenAI-COMPATIBLE surface. atlasLlmService uses it
//                    as the DIRECT-provider twin for this role, so an Atlas
//                    outage still reaches Google on GEMINI_API_KEY. That twin is
//                    itself ledgered (provider 'google-openai'), which F3 pins:
//                    routing pass 2 through Atlas makes Atlas PRIMARY, it does
//                    not remove the direct key from the path.
const GEN_CONTENT = ':generateContent';
const GOOGLE_OAI  = '/openai/chat/completions';

// ── Fixtures ────────────────────────────────────────────────────────────────
// The quote MUST clear every intake gate, because this harness drives the real
// code: keepVerbatimQuotes needs a literal substring of the narrative,
// completeSentencesOnly needs terminal punctuation, screenAdUsableSentiment
// needs clear customer praise. Borrowed verbatim from verifyGeminiSearchCost's
// section D for exactly that reason — if a gate tightens, fix the FIXTURE.
const NARRATIVE = 'These are incredibly comfortable and the quality is amazing. '.repeat(4);
const CATEGORY_STRUCTURED = JSON.stringify({
  quotes: [{ text: 'These are incredibly comfortable and the quality is amazing.', author: 'Alex R.', source: 'trustpilot.com', stage: 'consideration' }],
  rating: 4.6, reviewCount: 1200, summary: 'Broadly positive.'
});
const PASS1_USAGE = { promptTokenCount: 1000, toolUsePromptTokenCount: 500, candidatesTokenCount: 800, thoughtsTokenCount: 200 };
const PASS2_ATLAS_USAGE = { prompt_tokens: 2000, completion_tokens: 300 };
const SUMMARY_USAGE = { promptTokenCount: 900, toolUsePromptTokenCount: 300, candidatesTokenCount: 400, thoughtsTokenCount: 100 };

const EXPECTED_PASS1 = Number((((1500 / 1e6) * FLASH_INPUT_PER_1M + (1000 / 1e6) * FLASH_OUTPUT_PER_1M) + GROUNDING_PER_CALL).toFixed(6));
const EXPECTED_PASS2 = Number(((2000 / 1e6) * ATLAS_FLASH_INPUT_PER_1M + (300 / 1e6) * ATLAS_FLASH_OUTPUT_PER_1M).toFixed(6));
const EXPECTED_SUMMARY = Number((((1200 / 1e6) * FLASH_INPUT_PER_1M + (500 / 1e6) * FLASH_OUTPUT_PER_1M) + GROUNDING_PER_CALL).toFixed(6));

function groundedRestBody(usage, text) {
  return {
    status: 200,
    data: {
      candidates: [{
        content: { parts: [{ text }] },
        finishReason: 'STOP',
        groundingMetadata: {
          groundingChunks: [{ web: { uri: 'https://www.trustpilot.com/review/x', title: 'T' } }],
          webSearchQueries: ['q']
        }
      }],
      usageMetadata: usage
    }
  };
}

// One stub for both transports: the Atlas gateway and the direct Gemini REST
// endpoint are genuinely different request/response shapes, so it branches on
// URL — not on the presence of a `tools` field, which is itself under test.
function twoTransportStub({ restUsage = PASS1_USAGE, restText = NARRATIVE, atlasContent = CATEGORY_STRUCTURED, atlasFails = false, directTwinFails = true } = {}) {
  return async (url, body) => {
    const u = String(url);
    if (u.includes('atlascloud.ai')) {
      if (atlasFails) throw new Error('ECONNRESET');
      return {
        status: 200,
        data: {
          id: 'chatcmpl-test', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: atlasContent }, finish_reason: 'stop' }],
          usage: PASS2_ATLAS_USAGE
        }
      };
    }
    if (u.includes(GOOGLE_OAI)) {
      // Reached only when the Atlas attempt failed. Defaults to failing so no
      // happy-path check can quietly depend on the direct twin having answered.
      if (directTwinFails) throw new Error('ECONNRESET');
      return {
        status: 200,
        data: {
          id: 'chatcmpl-direct', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: atlasContent }, finish_reason: 'stop' }],
          usage: PASS2_ATLAS_USAGE
        }
      };
    }
    assert.ok(u.includes(GEN_CONTENT),
      `unexpected transport in this harness: ${u.slice(0, 80)}`);
    return groundedRestBody(restUsage, restText);
  };
}

// ── E. Source + import resolution ───────────────────────────────────────────
const CATEGORY_PATH = path.join(__dirname, '..', 'services', 'categoryReviewsService.js');
const DETAILS_PATH  = path.join(__dirname, '..', 'services', 'productDetailsService.js');
const CATEGORY_SRC  = fs.readFileSync(CATEGORY_PATH, 'utf8');
const DETAILS_SRC   = fs.readFileSync(DETAILS_PATH,  'utf8');

/**
 * CODE ONLY — comments stripped.
 *
 * THIS IS NOT TIDINESS, IT IS A BUG THIS HARNESS ALREADY HAD. The first draft
 * asserted `/tools:\s*\[\{\s*google_search/` over the raw function text, and
 * that check PASSED against a mutation that deleted the real `tools` field —
 * because a comment two lines above it says "genuinely grounded (`tools: [{
 * google_search: {} }]` below)". A regex over source cannot tell the code from
 * the prose describing it, which is the same family as CLAUDE.md's `receiptFree`
 * post-mortem. Every source assertion below reads the STRIPPED text.
 */
/**
 * classifySource(src) → Uint8Array parallel to src, one KIND byte per char:
 *   0 = real code     1 = string/template/regex-literal BODY     2 = comment
 *
 * ONE SHARED TOKENIZER for stripComments AND fnBody's brace/paren walker, so
 * the two can never independently disagree about what is "inside a string" —
 * which is exactly how the bug below was found: two hand-rolled scanners
 * would each have to separately rediscover the same fix.
 *
 * REGEX-LITERAL AWARE, which is the whole reason this replaced a naive
 * quote-tracker. A REAL line in this repo, `productDetailsService.js:56`:
 *   const _key = _rawKey.trim().replace(/^['"]|['"]$/g, '');
 * contains FOUR quote characters inside a regex literal. A lexer with no
 * notion of "this `/.../` is a regex, not division" reads the first `'` as
 * OPENING a string, the `"` right after as still-inside-that-string, the
 * SECOND `'` as CLOSING it, then the trailing `"` as OPENING a new string
 * that is never properly closed — corrupting every check downstream in the
 * same file. Demonstrated: with a naive tracker, a genuine `// GEMINI_
 * SEARCH_MODEL` comment nearly 300 lines later silently stopped being
 * recognised as a comment at all, because the tracker still believed itself
 * inside the unterminated fake string opened at line 56.
 *
 * Regex-vs-division is the classic JS tokenizer ambiguity, disambiguated
 * here by the standard heuristic real engines use: `/` starts a regex unless
 * the last significant character ended an expression (an identifier/digit/
 * `$`/`_` character, or `)` `]` `}`) — in which case it is division.
 */
function classifySource(src) {
  const kind = new Uint8Array(src.length);
  let mode = null;         // null | "'" | '"' | '`' | '//' | '/*' | 'regex' | 'regexClass'
  let lastSig = '';        // last significant (non-whitespace) CODE character
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === null) {
      if (c === "'" || c === '"' || c === '`') { mode = c; kind[i] = 1; continue; }
      if (c === '/' && n === '/') { mode = '//'; kind[i] = 2; kind[i + 1] = 2; i++; continue; }
      if (c === '/' && n === '*') { mode = '/*'; kind[i] = 2; kind[i + 1] = 2; i++; continue; }
      if (c === '/' && !/[A-Za-z0-9_$)\]\}]/.test(lastSig)) { mode = 'regex'; kind[i] = 1; continue; }
      if (!/\s/.test(c)) lastSig = c;
      continue;   // kind[i] stays 0 — real code
    }
    if (mode === '//') {
      kind[i] = 2;
      if (c === '\n') mode = null;
      continue;
    }
    if (mode === '/*') {
      kind[i] = 2;
      if (c === '*' && n === '/') { kind[i + 1] = 2; i++; mode = null; }
      continue;
    }
    if (mode === 'regex' || mode === 'regexClass') {
      kind[i] = 1;
      if (c === '\\') { if (n !== undefined) kind[i + 1] = 1; i++; continue; }
      if (mode === 'regex' && c === '[') { mode = 'regexClass'; continue; }
      if (mode === 'regexClass' && c === ']') { mode = 'regex'; continue; }
      if (mode === 'regex' && c === '/') {
        mode = null; lastSig = '/';
        while (i + 1 < src.length && /[a-z]/i.test(src[i + 1])) { i++; kind[i] = 1; }
      }
      continue;
    }
    // string/template mode
    kind[i] = 1;
    if (c === '\\') { if (n !== undefined) kind[i + 1] = 1; i++; continue; }
    if (c === mode) { mode = null; lastSig = c; }
  }
  return kind;
}

// Blanks COMMENT ranges only (kind===2) — string/template/regex content
// (kind===1) is a real value and survives untouched, exactly like the naive
// version this replaced, just correct in the presence of a regex literal.
function stripComments(src) {
  const kind = classifySource(src);
  let out = '';
  for (let i = 0; i < src.length; i++) out += kind[i] === 2 ? (src[i] === '\n' ? '\n' : ' ') : src[i];
  return out;
}
// Returns '' rather than throwing when a function is gone: a missing function
// must surface as a NAMED failing check (E0), not as an uncaught crash with no
// diagnostic. The mutation matrix caught that too — reverting the whole file
// killed the harness before a single check ran.
//
// BRACE-DEPTH-AWARE, NOT `\n}\n`-SEARCHING (hardened 2026-08-19, second
// adversarial pass). The first version sliced to the next `\n}\n`, and a
// template literal containing a bare `}` line ended the slice EARLY — a
// demonstrated, passing-green exploit: an env-gated `require('axios').post`
// injected after such a literal was invisible to every fnBody-scoped check AND
// to every behavioural check (the harness deletes the gating env var at the
// top, so the branch never ran either). Depth tracking skips string, template
// and comment content so literal braces cannot end the slice.
// KNOWN LIMIT: regex literals are not lexed, so a regex with UNBALANCED braces
// would skew the depth — none of the four sliced functions contains one (their
// only brace-bearing regex is the balanced /\{[\s\S]*\}/), and E0 fails loudly
// if the slice ever comes back empty.
// Returns '' rather than throwing when a function is gone: a missing function
// must surface as a NAMED failing check (E0), not as an uncaught crash with no
// diagnostic. The mutation matrix caught that too — reverting the whole file
// killed the harness before a single check ran.
//
// BRACE/PAREN-DEPTH-AWARE OVER classifySource's `kind` ARRAY, not its own
// hand-rolled string/comment tracker — sharing the tokenizer with
// stripComments is what closes the regex-literal desync class for BOTH
// consumers at once (see classifySource's own comment for the concrete
// exploit). Only `kind===0` (real code) positions count toward brace/paren
// depth; everything else is opaque.
//
// Every guarded function destructures its params (`async function f({ a,
// b })`), so the FIRST `{` after the name is the parameter object, not the
// body — walk the paren list first, then the brace body.
function fnBody(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) return '';
  const kind = classifySource(src);
  const walk = (i, open, close) => {
    let depth = 0;
    for (; i < src.length; i++) {
      if (kind[i] !== 0) continue;
      if (src[i] === open) depth++;
      else if (src[i] === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  };
  const parenEnd = walk(src.indexOf('(', start), '(', ')');
  if (parenEnd === -1) return '';
  const bodyOpen = src.indexOf('{', parenEnd);
  if (bodyOpen === -1) return '';
  const bodyEnd = walk(bodyOpen, '{', '}');
  if (bodyEnd === -1) return '';
  return stripComments(src.slice(start, bodyEnd + 1));
}
const CATEGORY_CODE     = stripComments(CATEGORY_SRC);
const DETAILS_CODE      = stripComments(DETAILS_SRC);
const CATEGORY_FETCH_FN  = fnBody(CATEGORY_SRC, 'fetchCategoryReviews');
const CATEGORY_STRUCT_FN = fnBody(CATEGORY_SRC, 'structureCategoryNarrative');
const CATEGORY_CACHE_FN  = fnBody(CATEGORY_SRC, 'fetchAndCache');
const SUMMARY_FN         = fnBody(DETAILS_SRC,  'fetchReviewSummary');

console.log('E. wiring — no unledgered transport survives, and the helper actually resolves');

check('E0 every function this section reasons about still exists', () => {
  // Without this, deleting one turns the whole section into an uncaught throw
  // with no named failure — which is how a "green-ish" crash hides a revert.
  for (const [name, body] of [
    ['fetchCategoryReviews', CATEGORY_FETCH_FN],
    ['structureCategoryNarrative', CATEGORY_STRUCT_FN],
    ['fetchAndCache', CATEGORY_CACHE_FN],
    ['fetchReviewSummary', SUMMARY_FN],
  ]) {
    assert.ok(body.length > 0, `${name} is missing — the two-pass ledger wiring cannot be verified`);
  }
});

check('E1 categoryReviewsService makes no axios.post at all (and requires no axios)', () => {
  // `.post(` not `axios.post(` — a demonstrated exploit used
  // `require('axios').post(`, which the literal-name regex does not match.
  // This file has zero legitimate `.post(` calls, so the blanket ban is valid.
  assert.strictEqual((CATEGORY_CODE.match(/\.post\s*\(/g) || []).length, 0,
    'a POST appeared in categoryReviewsService — billable and unledgered');
  assert.strictEqual((CATEGORY_CODE.match(/require\(['"]axios['"]\)/g) || []).length, 0,
    'both of this file\'s POSTs are ledgered now, so an axios require here is a bypass waiting to happen');
});

check('E2 productDetailsService performs no POST of any kind (serp()\'s axios.get is the only HTTP call)', () => {
  // WHOLE FILE, not fnBody-scoped, and `.post(` not `axios.post(` — both
  // hardenings bought by demonstrated exploits: an fnBody-scoped check missed a
  // POST hidden behind a truncating template literal, and the literal-name regex
  // missed `require('axios').post(` outright. This file has zero legitimate
  // `.post(` calls, so the blanket ban is valid.
  assert.strictEqual((DETAILS_CODE.match(/\.post\s*\(/g) || []).length, 0,
    'a POST appeared in productDetailsService — every billable call in this file must go through trackedGenerate');
  assert.strictEqual((DETAILS_CODE.match(/chatCompletion/g) || []).length, 0,
    'chatCompletion has no business in this file — its one Gemini call is grounded and must stay direct');
  // The SerpAPI GET must still be there: this check must not be satisfied by
  // someone deleting the shopping lookup.
  assert.ok(/axios\.get\(/.test(DETAILS_CODE), 'the SerpAPI axios.get should be untouched by this change');
});

check('E3 both files IMPORT trackedGenerate, and the binding RESOLVES', () => {
  // A regex proves the call is WRITTEN, not that it resolves — see CLAUDE.md's
  // `receiptFree` ReferenceError post-mortem. So: assert the require, then read
  // the real export off the real module.
  for (const [name, src] of [['categoryReviewsService', CATEGORY_CODE], ['productDetailsService', DETAILS_CODE]]) {
    assert.ok(/trackedGenerate\(/.test(src), `${name} must CALL trackedGenerate (not merely mention it in a comment)`);
    assert.ok(/require\(['"]\.\/providers\/geminiSearchProvider['"]\)/.test(src),
      `${name} must import it from the provider, not re-implement it`);
  }
  assert.strictEqual(typeof provider.trackedGenerate, 'function',
    'the provider must EXPORT trackedGenerate — an unexported helper is a ReferenceError at runtime');
  assert.strictEqual(typeof provider.GEMINI_REST_MODEL, 'string');
});

check('E4 neither file re-declares the direct generativelanguage URL', () => {
  // Read off the CODE, so a comment that names the host to explain the fix is
  // fine while a template literal that BUILDS the URL is not.
  for (const [name, src] of [['categoryReviewsService', CATEGORY_CODE], ['productDetailsService', DETAILS_CODE]]) {
    assert.strictEqual((src.match(/generativelanguage\.googleapis\.com/g) || []).length, 0,
      `${name} rebuilds the direct REST URL — trackedGenerate owns that URL, and owning it is what keeps the ledger unavoidable`);
  }
});

check('E5 categoryReviews pass 1 stays on the ledgered DIRECT transport', () => {
  assert.ok(/trackedGenerate\(/.test(CATEGORY_FETCH_FN), 'pass 1 must be ledgered');
  // "still asks for grounding" is DELIBERATELY NOT asserted here as a source
  // regex any more — it WAS one, and it passed against a mutation that DELETED
  // the real `tools` field, because the regex matched a dummy `{ tools: [...] }`
  // literal placed elsewhere in the function (or, before comment-stripping, the
  // comment documenting the field). G1/F7 own this behaviourally now, by
  // inspecting the actual REST request body sent through the PRODUCTION entry
  // points (fetchAndCache, fetchProductDetails) — the only way to know a call
  // still asks for grounding is to look at what it sent, not what its source
  // merely contains somewhere.
  assert.strictEqual((CATEGORY_FETCH_FN.match(/chatCompletion\(/g) || []).length, 0,
    'fetchCategoryReviews itself must never call chatCompletion — grounding is not available there ' +
    '(see the ATLAS GROUNDING PROBE comment); only its pass-2 delegate may');
});

check('E6 categoryReviews pass 2 is Atlas-routed and stays ungrounded', () => {
  assert.ok(/chatCompletion\(/.test(CATEGORY_STRUCT_FN), 'pass 2 must route through atlasLlmService');
  assert.strictEqual((CATEGORY_STRUCT_FN.match(/trackedGenerate\(/g) || []).length, 0,
    'pass 2 must not fall back to the direct ledgered transport');
  assert.strictEqual((CATEGORY_STRUCT_FN.match(/axios\.post\(/g) || []).length, 0);
  assert.ok(!/google_search/.test(CATEGORY_STRUCT_FN),
    'a grounded structuring pass would have to move BACK to the direct transport, not stay on Atlas');
  assert.ok(!/\btools\s*:/.test(CATEGORY_STRUCT_FN), 'no `tools` field of any kind belongs on the Atlas pass');
  assert.ok(/structureCategoryNarrative\(/.test(CATEGORY_FETCH_FN), 'the fetch must delegate pass 2 to it');
});

check('E7 neither file resolves its own GEMINI model id — it imports the provider\'s', () => {
  for (const [name, src] of [['categoryReviewsService', CATEGORY_CODE], ['productDetailsService', DETAILS_CODE]]) {
    // The realistic drift is not a redeclaration (that is a SyntaxError) — it is
    // someone dropping the import and re-adding a local env read. So assert BOTH
    // halves: no local env read, and the import is really there.
    assert.strictEqual((src.match(/GEMINI_SEARCH_MODEL/g) || []).length, 0,
      `${name} reads GEMINI_SEARCH_MODEL itself again — the ledger row's model and this file's log lines can then disagree`);
    assert.ok(/GEMINI_REST_MODEL\s*:/.test(src),
      `${name} must destructure the provider's model id, not merely mention it`);
  }
});

check('E8 fetchReviewSummary is ledgered and stays off Atlas', () => {
  assert.ok(/trackedGenerate\(/.test(SUMMARY_FN));
  // "still asks for grounding" moved to G1/F8, behaviourally — see E5's comment
  // for why a source regex for the `tools` field is not trustworthy here.
  assert.strictEqual((SUMMARY_FN.match(/chatCompletion\(/g) || []).length, 0,
    'this call is genuinely grounded and must never move to Atlas');
});

// Split a `fetchProductDetails(...)` argument LIST on top-level commas only —
// nesting-aware over classifySource's own `kind` array, so an argument that is
// itself `ctx.brandId || null` or `product.brandId || null` (both real, both
// contain no nested commas, but a defensive split must not assume that) is
// never miscounted. Shared logic, not a third hand-rolled scanner.
function topLevelArgCount(argsText) {
  const kind = classifySource(argsText);
  let depth = 0, count = argsText.trim() ? 1 : 0;
  for (let i = 0; i < argsText.length; i++) {
    if (kind[i] !== 0) continue;
    const c = argsText[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) count++;
  }
  return count;
}

check('E9 every fetchProductDetails CALL SITE passes catalogProductId AND brandId', () => {
  // The ledger is only as good as the callers. Three production call sites
  // exist; ALL THREE shipped dropping at least one linkage id at some point in
  // this PR's own history — the scene-level UGC path (productMatchService)
  // dropped catalogProductId first, then all three were found to drop brandId
  // too (CatalogProduct.brandId is a real, required field, available at every
  // one of them). Inventory-scan every services file so a FOURTH caller, or a
  // regression on these three, cannot ship id-less either. Argument-COUNT
  // based (>= 3), not name-based, so it does not care what a caller names its
  // brandId variable — only whether a third positional argument exists at all.
  const svcDir = path.join(__dirname, '..', 'services');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js') || e.name === 'productDetailsService.js') continue;
      const code = stripComments(fs.readFileSync(full, 'utf8'));
      for (const m of code.matchAll(/fetchProductDetails\s*\(([^)]*)\)/g)) {
        const n = topLevelArgCount(m[1]);
        if (n < 3) offenders.push(`${e.name}: fetchProductDetails(${m[1].trim().slice(0, 50)}) — ${n} arg(s), need 3 (identification, catalogProductId, brandId)`);
      }
    }
  };
  walk(svcDir);
  assert.deepStrictEqual(offenders, [],
    'these call sites drop catalogProductId and/or brandId — their CostLog rows will be unjoined and (for catalogProductId) their fetches uncached');
});

check('E10 no new env-gated branch can hide in the guarded files', () => {
  // Closes the general class behind the fnBody exploit: a bypass gated on an
  // env var the harness deletes at the top is invisible to every behavioural
  // check by construction. So: no bracket-notation env access at all (nothing
  // legitimate uses it, and it defeats any allowlist), and every dot-access
  // must be on the allowlist. A NEW env read here is not forbidden — it just
  // has to be added deliberately, which is the moment someone asks what gates
  // on it.
  const ALLOW = {
    categoryReviewsService: ['GEMINI_API_KEY'],
    productDetailsService:  ['GEMINI_API_KEY', 'SERPAPI_API_KEY', 'SERPAPI_COUNTRY'],
  };
  for (const [name, code] of [['categoryReviewsService', CATEGORY_CODE], ['productDetailsService', DETAILS_CODE]]) {
    assert.strictEqual((code.match(/process\.env\s*\[/g) || []).length, 0,
      `${name}: bracket-notation process.env access — use dot access so the allowlist can see it`);
    const reads = [...code.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    const bad = [...new Set(reads.filter((k) => !ALLOW[name].includes(k)))];
    assert.deepStrictEqual(bad, [],
      `${name}: unlisted env read(s) ${bad.join(', ')} — add deliberately to E10's allowlist after checking what gates on them`);
  }
});

// ── F / G. Behavioural ──────────────────────────────────────────────────────
async function main() {

console.log('F. behavioural — real functions, real costTracker, stubbed transport');

await checkAsync('F0 this file\'s rate constants still match costTracker\'s live table', async () => {
  // EXPECTED_PASS1/PASS2/SUMMARY are derived from the constants above. If
  // MODEL_RATES moves and these do not, F1/F5's exact-dollar assertions fail with
  // a confusing "wrong cost" message when the real story is "the rate table
  // changed". Name that failure here instead. (verifyGeminiSearchCost B1/B1b own
  // whether the RATES themselves are right; this only pins that the two agree.)
  const direct = costTracker.MODEL_RATES['gemini-2.5-flash'];
  const atlas  = costTracker.MODEL_RATES['google/gemini-2.5-flash'];
  assert.ok(direct && atlas, 'a missing MODEL_RATES entry would ledger $0 tokens on these rows');
  assert.strictEqual(direct.input,  FLASH_INPUT_PER_1M);
  assert.strictEqual(direct.output, FLASH_OUTPUT_PER_1M);
  assert.strictEqual(atlas.input,   ATLAS_FLASH_INPUT_PER_1M);
  assert.strictEqual(atlas.output,  ATLAS_FLASH_OUTPUT_PER_1M);
  assert.strictEqual(costTracker.GROUNDED_SEARCH_COST_PER_REQUEST_USD, GROUNDING_PER_CALL);
});

await checkAsync('F1 fetchCategoryReviews ledgers BOTH passes: pass 1 gemini+grounded, pass 2 atlas', async () => {
  rows.length = 0; sent.length = 0;
  stubAxios(twoTransportStub());
  const brandId = '6a4e7ea956509c2169977681';
  const out = await categorySvc.fetchCategoryReviews({
    brandName: 'Pelagic Gear', brandUrl: 'pelagicgear.com',
    breadcrumb: 'Men > Shirts > Performance Shirts', brandId
  });
  restoreAxios();

  assert.ok(out, 'the fetch still returns its normal shape');
  assert.strictEqual(out.quotes.length, 1, 'the real intake gates still pass the fixture quote');
  assert.strictEqual(out.rating, 4.6);
  assert.strictEqual(rows.length, 2, 'both the grounded pass and the structuring pass must be ledgered');
  assert.deepStrictEqual(rows.map(r => r.stage), ['category_reviews', 'category_reviews']);
  assert.deepStrictEqual(rows.map(r => r.purposeTag), ['grounded_search', 'json_structure']);
  assert.deepStrictEqual(rows.map(r => r.provider), ['gemini', 'atlas']);
  assert.deepStrictEqual(rows.map(r => r.groundedRequests), [1, 0]);
  assert.strictEqual(rows[0].model, 'gemini-2.5-flash');
  assert.strictEqual(rows[1].model, 'google/gemini-2.5-flash');
  assert.strictEqual(rows[0].costUsd, EXPECTED_PASS1);
  assert.strictEqual(rows[1].costUsd, EXPECTED_PASS2);
});

await checkAsync('F2 the grounded row counts tool-use + thinking tokens (proves BODY, not axios envelope)', async () => {
  rows.length = 0;
  stubAxios(twoTransportStub());
  await categorySvc.fetchCategoryReviews({ brandName: 'Pelagic Gear', breadcrumb: 'Men > Shirts' });
  restoreAxios();
  // Returning the axios envelope from trackedGenerate would write a row with
  // every count 0 — a row that LOOKS measured. Counting candidatesTokenCount
  // alone would give 1000/800 instead of 1500/1000.
  assert.strictEqual(rows[0].inputTokens, 1500, 'toolUsePromptTokenCount must be added to input');
  assert.strictEqual(rows[0].outputTokens, 1000, 'thoughtsTokenCount must be added to output');
});

await checkAsync('F3 a dead pass 2 degrades to summary-only, and EVERY attempt on the chain is ledgered', async () => {
  rows.length = 0;
  stubAxios(twoTransportStub({ atlasFails: true, directTwinFails: true }));
  const out = await categorySvc.fetchCategoryReviews({ brandName: 'Pelagic Gear', breadcrumb: 'Men > Shirts' });
  restoreAxios();
  assert.ok(out, 'a failed pass 2 must not lose the grounded narrative we already paid for');
  assert.deepStrictEqual(out.quotes, []);
  assert.strictEqual(out.rating, null);
  assert.ok(out.summary && out.summary.length > 0, 'the narrative summary survives');
  // THREE rows, not two, and that is the point: routing pass 2 through Atlas did
  // NOT take the direct Google key off this path — atlasLlmService keeps a direct
  // twin (Gemini's OpenAI-compatible surface) as fallback-of-last-resort for this
  // role. It is ledgered too, so an Atlas outage does not turn pass-2 spend
  // invisible again.
  // 3 rows because THIS HARNESS pins ATLAS_LLM_MAX_ATTEMPTS=1 for speed. At the
  // production default (3), the same total failure writes FIVE rows: grounded
  // pass + 3 Atlas attempts + direct twin. Same per-request honesty, more rows.
  assert.strictEqual(rows.length, 3, 'grounded pass + Atlas attempt + direct-twin attempt (MAX_ATTEMPTS pinned to 1 here)');
  assert.deepStrictEqual(rows.map(r => r.provider), ['gemini', 'atlas', 'google-openai']);
  assert.deepStrictEqual(rows.map(r => r.status), ['ok', 'error', 'error']);
  assert.deepStrictEqual(rows.map(r => r.stage), ['category_reviews', 'category_reviews', 'category_reviews'],
    'a fallback row that loses the stage cannot be joined to the work it paid for');
});

await checkAsync('F4 grounding is the MAJORITY of each grounded row — token math alone understates ~10x', async () => {
  // Measured off the REAL ledgered rows, not off this file's own EXPECTED_*
  // constants: a ratio between two harness constants only restates the harness's
  // arithmetic and would hold even if the code stopped declaring `grounded` at
  // all. What matters is that the row the code actually wrote is surcharge-dominated.
  rows.length = 0;
  stubAxios(twoTransportStub());
  await categorySvc.fetchCategoryReviews({ brandName: 'Pelagic Gear', breadcrumb: 'Men > Shirts' });
  restoreAxios();
  stubAxios(twoTransportStub({ restUsage: SUMMARY_USAGE, restText: 'u'.repeat(400) }));
  await detailsSvc.fetchReviewSummary({ productName: 'Tree Runner NZ' });
  restoreAxios();

  const grounded   = rows.filter(r => r.groundedRequests === 1);
  const ungrounded = rows.filter(r => r.groundedRequests === 0);
  assert.strictEqual(grounded.length, 2, 'category pass 1 + the product summary');
  assert.strictEqual(ungrounded.length, 1, 'the Atlas structuring pass');
  for (const r of grounded) {
    // ON TOP of tokens, not instead of them.
    assert.ok(r.costUsd > GROUNDING_PER_CALL, `${r.stage}: surcharge must be additive to tokens`);
    assert.ok(GROUNDING_PER_CALL / r.costUsd > 0.8,
      `${r.stage}: grounding should dominate the row — if this inverts, either the pricing ` +
      `assumption changed or the row stopped declaring the surcharge`);
  }
  assert.ok(ungrounded[0].costUsd < GROUNDING_PER_CALL,
    'the ungrounded pass must never carry a surcharge it did not incur');
});

await checkAsync('F5 fetchReviewSummary ledgers its single grounded call', async () => {
  rows.length = 0; sent.length = 0;
  stubAxios(twoTransportStub({ restUsage: SUMMARY_USAGE, restText: 'A balanced 180-word review summary of the product. '.repeat(4) }));
  const productId = '6a70cf95aa11bb22cc33dd44';
  const out = await detailsSvc.fetchReviewSummary({
    productName: 'Tree Runner NZ', brand: 'Allbirds', variant: 'Blizzard', catalogProductId: productId
  });
  restoreAxios();

  assert.ok(out && out.summary, 'still returns { summary, sources, queries }');
  assert.strictEqual(rows.length, 1, 'exactly one billable call, exactly one row');
  assert.strictEqual(rows[0].stage, 'product_review_summary');
  assert.strictEqual(rows[0].purposeTag, 'grounded_search');
  assert.strictEqual(rows[0].provider, 'gemini');
  assert.strictEqual(rows[0].model, 'gemini-2.5-flash');
  assert.strictEqual(rows[0].groundedRequests, 1, 'this call enables google_search — the surcharge is real');
  assert.strictEqual(rows[0].inputTokens, 1200);
  assert.strictEqual(rows[0].outputTokens, 500);
  assert.strictEqual(rows[0].costUsd, EXPECTED_SUMMARY);
  assert.strictEqual(rows[0].status, 'ok');
});

await checkAsync('F6 the ledgered model is the provider\'s single definition, not a local copy', async () => {
  rows.length = 0;
  stubAxios(twoTransportStub({ restUsage: SUMMARY_USAGE, restText: 'x'.repeat(400) }));
  await detailsSvc.fetchReviewSummary({ productName: 'Tree Runner NZ' });
  await categorySvc.fetchCategoryReviews({ brandName: 'Pelagic Gear', breadcrumb: 'Men > Shirts' });
  restoreAxios();
  const geminiRows = rows.filter(r => r.provider === 'gemini');
  // Guard the guard: iterating an EMPTY filter is vacuously green, which made
  // this check register as PASSED under a mutation that renamed the provider
  // string (every row then failed the filter). Demonstrated, not hypothetical.
  assert.ok(geminiRows.length >= 2, `expected direct-gemini rows to inspect, got ${geminiRows.length}`);
  for (const r of geminiRows) {
    assert.strictEqual(r.model, provider.GEMINI_REST_MODEL,
      'a row ledgering a model id the provider does not own means the constant drifted again');
  }
});

await checkAsync('F7 brandId reaches CostLog through the REAL production entry point (fetchAndCache)', async () => {
  // Deliberately NOT calling fetchCategoryReviews directly with brandId in
  // hand — that only proves the parameter is WIRED, the half that was never in
  // doubt. A source regex on fetchAndCache's own call
  // (/fetchCategoryReviews\(\{[^}]*brandId[^}]*\}\)/) was tried and is
  // DEMONSTRATED too weak: `brandId: null` still matches it, so a caller that
  // silently drops the join reads as passing. Drive the real fetchAndCache
  // instead, with Category/Brand stubbed, and assert on the row AND on the
  // request actually sent (closing the same "does it still ask for grounding"
  // gap E5's removed source regex used to paper over).
  rows.length = 0; sent.length = 0;
  stubAxios(twoTransportStub());
  const brandId = '6a4e7ea956509c2169977681';
  const out = await categorySvc.fetchAndCache({
    brandId, brandName: 'Pelagic Gear', brandUrl: 'pelagicgear.com',
    breadcrumb: 'Men > Shirts > Performance Shirts', categoryId: 'stub-leaf'
  });
  restoreAxios();

  assert.ok(out, 'fetchAndCache must still return the fresh result');
  assert.strictEqual(rows.length, 2, 'grounded pass + Atlas structuring pass');
  assert.strictEqual(rows[0].brandId, brandId, 'pass 1 must join back to the brand');
  assert.strictEqual(rows[1].brandId, brandId, 'and the linkage must survive the transport change');
  // cacheKey is the breadcrumb KEY (same key the 30-day Category cache uses),
  // so the (stage, cacheKey) hit-rate query means something on this path.
  assert.strictEqual(rows[0].cacheKey, 'men>shirts>performance shirts');
  // The request as SENT, not merely the source: the grounded pass must still
  // ask for grounding through the real production entry point.
  const rest = sent.filter(x => x.url.includes(GEN_CONTENT));
  assert.strictEqual(rest.length, 1, 'exactly one direct REST call through fetchAndCache');
  assert.ok(Array.isArray(rest[0].body.tools) && rest[0].body.tools.some(t => t.google_search),
    'fetchAndCache\'s grounded pass must actually ask for grounding — otherwise the ledgered surcharge is a lie');
});

await checkAsync('F8 productId reaches CostLog through the REAL production entry point', async () => {
  // Deliberately NOT calling fetchReviewSummary directly here: passing
  // catalogProductId in by hand proves only that the parameter is wired, which is
  // the half that was never in doubt. The half that matters is whether
  // fetchProductDetails — what actually runs on UGC product_match and on "Enrich"
  // — threads the id down. A source regex for that was tried and was too weak
  // (see the mutation list in this file's header), so this drives the real
  // function with SerpAPI and Mongo stubbed instead.
  rows.length = 0; sent.length = 0;
  stubSerp([{ title: 'Tree Runner NZ', price: '$98', extracted_price: 98, source: 'allbirds.com', link: 'https://allbirds.com/x' }]);
  stubAxios(twoTransportStub({ restUsage: SUMMARY_USAGE, restText: 'A balanced review summary. '.repeat(12) }));
  const productId = '6a70cf95aa11bb22cc33dd44';
  const out = await detailsSvc.fetchProductDetails(
    { productName: 'Tree Runner NZ', brand: 'Allbirds', variant: null },
    productId
  );
  restoreAxios(); restoreSerp();

  assert.ok(out && out.reviewSummary && out.reviewSummary.summary,
    'the grounded review summary must still reach the merged result');
  assert.strictEqual(rows.length, 1, 'one grounded Gemini call in a full product-details fetch, one row');
  assert.strictEqual(rows[0].stage, 'product_review_summary');
  assert.strictEqual(rows[0].productId, productId,
    'fetchProductDetails must thread catalogProductId down when it HAS one — E9 owns whether every caller supplies it');
  assert.strictEqual(rows[0].cacheKey, 'Allbirds Tree Runner NZ', 'the descriptor is the natural cache key here');
  // The request as SENT: same reasoning as F7 — a source regex for the
  // `tools` field was removed from E8 because it was dummy-satisfiable; this
  // is the real replacement, off the production entry point's actual
  // outgoing request.
  const rest2 = sent.filter(x => x.url.includes(GEN_CONTENT));
  assert.strictEqual(rest2.length, 1, 'exactly one direct REST call through fetchProductDetails');
  assert.ok(rest2[0].body.tools.some(t => t.google_search),
    'fetchProductDetails\'s grounded call must actually ask for grounding');
});

await checkAsync('F9 a call with no linkage ids still ledgers (linkage is optional, the row is not)', async () => {
  rows.length = 0;
  stubAxios(twoTransportStub({ restUsage: SUMMARY_USAGE, restText: 'z'.repeat(400) }));
  await detailsSvc.fetchReviewSummary({ productName: 'Anon Product' });
  await categorySvc.fetchCategoryReviews({ brandName: 'Anon Brand', breadcrumb: 'Cat' });
  restoreAxios();
  assert.strictEqual(rows.length, 3, '1 summary row + 2 category rows');
  assert.strictEqual(rows[0].productId, null);
  assert.strictEqual(rows[1].brandId, null);
  assert.strictEqual(rows[2].brandId, null);
});

await checkAsync('F10 a failed GROUNDED call leaves a row on both paths — the spend may already be gone', async () => {
  for (const [label, run] of [
    ['category', () => categorySvc.fetchCategoryReviews({ brandName: 'Vuori', breadcrumb: 'Men > Shorts' })],
    ['summary',  () => detailsSvc.fetchReviewSummary({ productName: 'Kore Short' })],
  ]) {
    rows.length = 0;
    stubAxios(async () => { throw new Error('ECONNRESET'); });
    const out = await run();
    restoreAxios();
    assert.strictEqual(out, null, `${label}: still soft-fails to null for its callers`);
    assert.strictEqual(rows.length, 1, `${label}: the attempt must leave a trace`);
    assert.strictEqual(rows[0].status, 'error');
    assert.strictEqual(rows[0].groundedRequests, 1, `${label}: the attempted grounding is still recorded`);
    // Deliberate, pinned limit (see verifyGeminiSearchCost C7): trackLlmCall
    // ledgers $0 on the error path for every consumer. A grounded request that
    // reached Google and then timed out WAS billed and we record nothing. If this
    // assertion fails, that shared decision was revisited — check it was on purpose.
    assert.strictEqual(rows[0].costUsd, 0);
    // ALSO pinned: the error row lands costSource:'none' — which CostLog defines
    // as "confirmed nothing was charged". For a grounded call that may have been
    // billed at send, that OVERSTATES certainty ('unknown' would be honest).
    // Shared trackLlmCall semantics for every consumer, so not changed here —
    // pinned exactly like C7's $0, so revisiting it is a decision, not drift.
    assert.strictEqual(rows[0].costSource, 'none');
  }
});

console.log('G. the requests as actually SENT');

await checkAsync('G1 both grounded calls send the native google_search tool to the direct REST endpoint', async () => {
  sent.length = 0; rows.length = 0;
  stubAxios(twoTransportStub());
  await categorySvc.fetchCategoryReviews({ brandName: 'Pelagic Gear', breadcrumb: 'Men > Shirts' });
  restoreAxios();
  const rest = sent.filter(s => s.url.includes(GEN_CONTENT));
  assert.strictEqual(rest.length, 1, 'exactly one direct REST call on the category path');
  assert.ok(Array.isArray(rest[0].body.tools) && rest[0].body.tools.some(t => t.google_search),
    'the grounded pass must actually ask for grounding — otherwise the surcharge we ledger is a lie');

  sent.length = 0; rows.length = 0;
  stubAxios(twoTransportStub({ restUsage: SUMMARY_USAGE, restText: 'w'.repeat(400) }));
  await detailsSvc.fetchReviewSummary({ productName: 'Tree Runner NZ' });
  restoreAxios();
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].body.tools.some(t => t.google_search));
});

await checkAsync('G2 both grounded direct REST POSTs pin maxRedirects:0 (CLAUDE.md §2)', async () => {
  // Scope stated honestly: this pins the two DIRECT generativelanguage POSTs
  // only. The Atlas gateway POST and its google-openai twin (atlasLlmService.
  // post) do NOT set maxRedirects — a PRE-EXISTING, systemic gap across all
  // ~12 Atlas callers, not introduced or widened here; tracked as its own
  // follow-up because it changes a shared transport with its own pinned
  // harnesses.
  // axios defaults to 21 redirects and RE-SENDS the body on 307/308 — a silent
  // double charge inside one call, invisible to any retry logic.
  sent.length = 0; rows.length = 0;
  stubAxios(twoTransportStub());
  await categorySvc.fetchCategoryReviews({ brandName: 'Pelagic Gear', breadcrumb: 'Men > Shirts' });
  restoreAxios();
  stubAxios(twoTransportStub({ restUsage: SUMMARY_USAGE, restText: 'v'.repeat(400) }));
  await detailsSvc.fetchReviewSummary({ productName: 'Tree Runner NZ' });
  restoreAxios();
  const rest = sent.filter(s => s.url.includes(GEN_CONTENT));
  assert.strictEqual(rest.length, 2, 'one grounded POST per path');
  for (const r of rest) {
    assert.strictEqual(r.config && r.config.maxRedirects, 0,
      'a billable POST without maxRedirects:0 can be re-sent by axios on a 307/308');
  }
});

await checkAsync('G3 the Atlas structuring request carries no tools and asks for the strict schema', async () => {
  sent.length = 0; rows.length = 0;
  stubAxios(twoTransportStub());
  await categorySvc.fetchCategoryReviews({ brandName: 'Pelagic Gear', breadcrumb: 'Men > Shirts' });
  restoreAxios();
  const atlas = sent.filter(s => s.url.includes('atlascloud.ai'));
  assert.strictEqual(atlas.length, 1, 'exactly one Atlas call on the category path');
  assert.strictEqual(atlas[0].body.tools, undefined,
    'grounding is unavailable on Atlas — a tools field here would silently 400 or be dropped');
  assert.strictEqual(atlas[0].body.response_format?.type, 'json_schema');
  assert.strictEqual(atlas[0].body.response_format?.json_schema?.strict, true);
  assert.strictEqual(atlas[0].body.response_format?.json_schema?.name, 'category_reviews_structure');
  // The scalar `rating` this path reads must be IN the schema, and the provider's
  // `ratings[]` array must NOT be — borrowing that shape would null every rating.
  const props = atlas[0].body.response_format.json_schema.schema.properties;
  assert.ok('rating' in props, 'the scalar rating is the only rating this path reads');
  assert.ok(!('ratings' in props),
    'the provider\'s multi-aggregate ratings[] shape would leave parsed.rating null on every category');
});

restoreAxios();
}

main().then(() => {
  restoreAxios(); restoreSerp();
  if (failures.length) {
    console.error(`\n❌ verifyGroundedGeminiLedger: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ verifyGroundedGeminiLedger: ${pass}/${pass} checks passed`);
}).catch((err) => {
  restoreAxios(); restoreSerp();
  console.error(`❌ verifyGroundedGeminiLedger: harness threw — ${err.stack || err.message}`);
  process.exit(1);
});
