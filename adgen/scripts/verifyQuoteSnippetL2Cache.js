'use strict';
// Pins the cross-process (L2/Mongo) cache layer added to quoteSnippetService
// on 2026-08-26. Phase 2 of the wall-time reduction plan.
//
// Context. Measured on run_1787696303378 (2026-08-25 22:18, 9 statics): the
// SAME quote ("fit and look great") was regenerated TWICE at 15.7s + 15.9s
// = 31 seconds of duplicate LLM time because two different renderer processes
// each cold-hit the L1 (per-process LRU) and each paid the full LLM round
// trip. This harness pins the L2 layer that closes it.
//
// The change is additive:
//   1. models/QuoteSnippetCache — TTL-indexed Mongo collection, keyed on the
//      same SHA-1 the L1 already uses (snippetCacheKey). Reusing the key
//      means the two tiers cannot drift.
//   2. quoteSnippetService adds mongoSnippetCacheGet before the LLM call
//      (LRU miss → Mongo lookup → LLM) and mongoSnippetCacheSet on
//      LLM-verified success + on the pre-LLM deterministic short-circuits
//      (already-fits/salvaged). Mechanical fallbacks are NOT written to L2
//      so a next process retries the LLM in case the failure was transient.
//   3. Both L2 helpers are fire-and-forget on errors — a Mongo blip must
//      never fail a paid render.

const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const svcSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'quoteSnippetService.js'), 'utf8');
const modelSrc = fs.readFileSync(path.join(REPO, 'src', 'models', 'QuoteSnippetCache.js'), 'utf8');

// ── A. QuoteSnippetCache model shape ───────────────────────────────────
const model = require(path.join(REPO, 'src', 'models', 'QuoteSnippetCache.js'));
check('A1: exports a mongoose model', typeof model.modelName === 'string');
check('A2: modelName is QuoteSnippetCache', model.modelName === 'QuoteSnippetCache');
check('A3: uses `_id: String` (not ObjectId — key is the SHA-1)',
  /_id:\s*\{\s*type:\s*String/.test(modelSrc));
check('A4: has TTL index on createdAt (30 days)',
  /expireAfterSeconds:\s*30\s*\*\s*24\s*\*\s*60\s*\*\s*60/.test(modelSrc));
check('A5: has `snippet: String` (required)',
  /snippet:\s*\{\s*type:\s*String,\s*required:\s*true/.test(modelSrc));
check('A6: has brandId + productId (denormalized for analytics)',
  /brandId:[\s\S]*?ObjectId[\s\S]*?productId:[\s\S]*?ObjectId/.test(modelSrc));
check('A7: has hits counter (observability)',
  /hits:\s*\{\s*type:\s*Number/.test(modelSrc));

// ── B. quoteSnippetService wires L2 correctly ──────────────────────────
check('B1: requires QuoteSnippetCache model',
  /require\(['"]\.\.\/models\/QuoteSnippetCache['"]\)/.test(svcSrc));

check('B2: exports/defines mongoSnippetCacheGet',
  /function mongoSnippetCacheGet\(/.test(svcSrc)
  || /const mongoSnippetCacheGet\s*=\s*async/.test(svcSrc)
  || /async function mongoSnippetCacheGet/.test(svcSrc));

check('B3: exports/defines mongoSnippetCacheSet',
  /function mongoSnippetCacheSet\(/.test(svcSrc));

// ── C. Ordering: L1 → L2 → LLM ─────────────────────────────────────────
const extractStart = svcSrc.indexOf('async function extractSnippet');
check('C0: extractSnippet function found', extractStart > 0);

if (extractStart > 0) {
  const extractBody = svcSrc.slice(extractStart, extractStart + 12000);
  const l1Idx = extractBody.indexOf('snippetCacheGet(cacheKey)');
  const l2Idx = extractBody.indexOf('mongoSnippetCacheGet(cacheKey)');
  const llmIdx = extractBody.indexOf('chatCompletion(');
  check('C1: L1 lookup (snippetCacheGet) precedes L2 (mongoSnippetCacheGet)',
    l1Idx > 0 && l2Idx > 0 && l1Idx < l2Idx);
  check('C2: L2 lookup precedes the LLM call',
    l2Idx > 0 && llmIdx > 0 && l2Idx < llmIdx);
  check('C3: L2 hit promotes into L1 (so next same-process read is instant)',
    /const l2Hit = await mongoSnippetCacheGet[\s\S]*?snippetCacheSet\(cacheKey, l2Hit\)/.test(extractBody));
}

// ── D. Write discipline ────────────────────────────────────────────────
// LLM-verified success writes to L2. Mechanical fallbacks do NOT.
check('D1: L2 write fires on LLM-verified success (after verbatim resolve)',
  /console\.log\(`💬 quoteSnippet:[\s\S]*?mongoSnippetCacheSet\(cacheKey, verbatim/.test(svcSrc));

// mechanical() must NOT call mongoSnippetCacheSet.
const mechanicalMatch = svcSrc.match(/const mechanical\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\};/);
check('D2: mechanical() body found', !!mechanicalMatch);
if (mechanicalMatch) {
  check('D3: mechanical() does NOT write to L2 (transient failures must be retryable cross-process)',
    !/mongoSnippetCacheSet/.test(mechanicalMatch[0]));
}

// ── E. Fail-open discipline ────────────────────────────────────────────
// mongoSnippetCacheGet must NOT throw on Mongo error — extract the function
// body and check its catch.
const getFn = svcSrc.match(/async function mongoSnippetCacheGet\([\s\S]*?\n\}/);
check('E1: mongoSnippetCacheGet body found', !!getFn);
if (getFn) {
  const body = getFn[0];
  check('E2: mongoSnippetCacheGet catches errors (fail-open)',
    /catch\s*\([\s\S]*?return\s+undefined/.test(body));
  check('E3: mongoSnippetCacheGet .findById by _id key',
    /findById\(key\)/.test(body));
  check('E4: mongoSnippetCacheGet $inc hits for observability',
    /\$inc:\s*\{\s*hits:\s*1/.test(body));
}

const setFn = svcSrc.match(/function mongoSnippetCacheSet\([\s\S]*?\n\}/);
check('E5: mongoSnippetCacheSet body found', !!setFn);
if (setFn) {
  const body = setFn[0];
  check('E6: mongoSnippetCacheSet uses upsert:true',
    /upsert:\s*true/.test(body));
  check('E7: mongoSnippetCacheSet uses $setOnInsert for createdAt (preserves TTL age)',
    /\$setOnInsert:\s*\{\s*createdAt/.test(body));
  check('E8: mongoSnippetCacheSet is fire-and-forget (.catch on the write)',
    /\.catch\(\(\)\s*=>\s*\{\}\)/.test(body));
  check('E9: mongoSnippetCacheSet is NOT async / does NOT return the promise',
    !/^async function mongoSnippetCacheSet/.test(body) && !/return\s+QuoteSnippetCache\.updateOne/.test(body));
}

// ── F. Revert-proofs ───────────────────────────────────────────────────
// Removing the L2 read → C1/C2/C3 must fail.
const strippedGet = svcSrc.replace(/const l2Hit = await mongoSnippetCacheGet[\s\S]*?}\s*}/, '// stripped');
check('F1: [REVERT-PROOF] removing L2 read defeats C1/C2/C3',
  !/const l2Hit = await mongoSnippetCacheGet/.test(strippedGet));

// Removing the L2 write on LLM success → D1 must fail.
const strippedWrite = svcSrc.replace(/mongoSnippetCacheSet\(cacheKey, verbatim, \{ brandId, productId \}\)/, '// stripped');
check('F2: [REVERT-PROOF] removing L2 LLM-success write defeats D1',
  !/mongoSnippetCacheSet\(cacheKey, verbatim/.test(strippedWrite));

// ── report ─────────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\nverifyQuoteSnippetL2Cache: ${passes.length} pass, ${failures.length} fail`);
  process.exit(1);
}
for (const p of passes) console.log(`  ✓ ${p}`);
console.log(`\n✅ verifyQuoteSnippetL2Cache: ${passes.length}/${passes.length} checks passed`);
