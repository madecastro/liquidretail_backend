#!/usr/bin/env node
'use strict';
//
// verifyQuoteSnippetProofBarGate — extractSnippet's third return path used
// to ship an unfinished/unscored fragment verbatim, with no gate at all.
//
// DEFECT (traced 2026-08-24, ad 6a8c830612c17a42936d529e): a rendered ad
// read "Great for offshore fishing and the length is....". The "...." is
// the CUSTOMER'S OWN informal trail-off punctuation, not an appended
// ellipsis — no truncator added it.
//
// A production DB query refuted the original PR's root-cause story: the
// stored snippet is actually "Great for offshore fishing and the length is
// good." (50 chars, a complete sentence ending in a period). The reported
// ad's real cause is `quoteSnippetService.MAX_CHARS` (50) vs.
// `deriveCharCap('quote', …)` returning a SHORTER cap (48) on the square
// surface (`pmax_video_1_1`) — a separate mismatch, NOT fixed by this file.
// See this PR's description for the measured per-surface caps.
//
// This harness instead covers a genuinely real, independently-confirmed
// structural defect found while investigating: extractSnippet
// (src/services/quoteSnippetService.js) has THREE return paths. Two of them
// gate on meetsProofBar (~:428), which rejects `/[…]|\.\.\./` among other
// things — an ellipsis/trail-off means "we never found a finished thought."
// The THIRD — `if (source.length <= MAX_CHARS) return source;` — had NO
// gate at all, so `strongestSentence`'s single-sentence short-circuit
// (`if (parts.length <= 1) return clean;`, unscored) could ship an ellipsis,
// an off-product complaint, or an aggregate-voice line straight onto a paid
// ad, anything under 50 chars.
//
// THE FIX SHIPPED HERE (CHANGE 1 ONLY — see "Scope" below):
//   quoteSnippetService.js ~:560 — gate that third path on meetsProofBar
//   too. A source that fits the budget but fails the bar is salvaged via
//   the same bestFallbackSnippet ladder used for an over-budget quote,
//   rather than dropped or shipped outright.
//
// SCOPE — read before extending this file.
// The original draft of this fix also extended `bestClause` with
// coordinating-conjunction splitting and a `DANGLING_END` filter (rejecting
// a candidate whose last word is a conjunction/preposition/copula). That
// second change is HELD OUT of this PR: it demonstrably regresses a case
// that used to correctly resolve to nothing —
//
//   input: "Great product but not sure about long term durability...."
//   old:   null                                   (correctly found nothing usable)
//   new:   "not sure about long term durability"  (a NEGATIVE fragment shipped)
//
// — because the conjunction-split discards "Great product" (2 words, fails
// the >=3-word filter), leaving only the negative half as a candidate.
// DANGLING_END checks grammatical completeness, not sentiment, and has no
// equivalent to `buildSystemPrompt()`'s existing "skip complaints, mixed or
// hedged lines" instruction to the LLM path. See session notes / PR
// description for the sentiment-guard rescue assessment.
//
// A DIRECT, MEASURED CONSEQUENCE of holding Change 2 out: with only Change
// 1 landed, extractSnippet(REPORTED) below no longer contains an ellipsis
// (the original reported symptom is fixed) but MAY still dangle on a
// copula/preposition ("...and the length is") — that residual defect is
// exactly what Change 2 was trying to fix, and is explicitly NOT asserted
// as correct behaviour anywhere in this file. Do not add an assertion here
// that requires dangling-word rejection; that belongs to a future PR that
// ships a sentiment-aware version of Change 2.
//
// Section A drives the real exported extractSnippet on the reported shape
// and a clean-already-fits case. Section R revert-proves Change 1 via
// sibling-copy mutation of the real source (does not edit the tree) — the
// same technique verifyQuoteColourway.js already uses in this repo.
//
// NO LLM CALL IN THIS HARNESS. ATLAS_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
// are deleted from process.env below before quoteSnippetService is even
// required, so atlasConfigured() reads false and extractSnippet's async LLM
// branch cannot be reached even if a fixture somehow got past the
// mechanical short-circuits. Every fixture here resolves through Change 1's
// synchronous gate/salvage branch before the function ever reaches
// `await chatCompletion(...)`.
//
// Offline: no DB, no network, no API key.
//   node scripts/verifyQuoteSnippetProofBarGate.js

delete process.env.ATLAS_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ATLASCLOUD_API_KEY;

const fs = require('fs');
const path = require('path');
const Module = require('module');

// Same defensive stub verifyQuoteColourway.js / verifyQuoteProvenanceStamp.js
// use — this worktree's node_modules may be incomplete for a transitive dep
// neither of those two packages actually needs for what THIS harness drives.
function ensureHttpsProxyAgent() {
  try {
    require.resolve('https-proxy-agent');
    return 'present';
  } catch { /* fall through */ }
  const orig = Module._load;
  Module._load = function loadStub(request, parent, isMain) {
    if (request === 'https-proxy-agent') {
      return function HttpsProxyAgent() { return {}; };
    }
    return orig.apply(this, arguments);
  };
  return 'stub';
}
ensureHttpsProxyAgent();

const {
  extractSnippet,
  bestFallbackSnippet,
  strongestSentence,
  MAX_CHARS
} = require('../src/services/quoteSnippetService');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'src', 'services', 'quoteSnippetService.js');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
check.pending = [];

const realLog = console.log;
const realWarn = console.warn;
console.log = () => {};
console.warn = () => {};

// ── Fixtures ───────────────────────────────────────────────────────────
//
// REPORTED reproduces the exact shape from ad 6a8c830612c17a42936d529e: a
// dotted trail-off ("is....") followed by whitespace + a DIGIT, which is
// what satisfies splitSentences' lookahead and creates the bogus boundary.
// NOTE: this is the MECHANICAL shape of the originally-reported bug, kept
// here because it is still the cleanest fixture for the ellipsis gate —
// even though the actual production incident's root cause turned out to be
// the MAX_CHARS/deriveCharCap mismatch (see header), not this parse path.
const REPORTED = "Great for offshore fishing and the length is.... 8'6\" and handles rough water great";

// A clean quote already inside the budget — must pass through untouched,
// with no ladder invoked at all. Handled by extractSnippet's FIRST
// short-circuit (`if (clean.length <= MAX_CHARS) ...`), above and
// unmodified by Change 1 — kept here as a regression guard.
const CLEAN_FITS = 'Fits true to size and feels amazing.';

function hasEllipsis(s) {
  return /[…]|\.\.\.\./.test(String(s || ''));
}

// ── A. Behavioural: drive the REAL exported extractSnippet ─────────────

check('A0 extractSnippet is a function', typeof extractSnippet === 'function');
check('A0 bestFallbackSnippet is a function', typeof bestFallbackSnippet === 'function');
check('A0 MAX_CHARS is 50 (not widened)', MAX_CHARS === 50, `got ${MAX_CHARS}`);

check('A measured: strongestSentence(REPORTED) picks the dotted 48-char fragment',
  strongestSentence(REPORTED) === 'Great for offshore fishing and the length is....',
  `got ${JSON.stringify(strongestSentence(REPORTED))}`);

{
  let reportedResult;
  let threw = null;
  const p = extractSnippet(REPORTED).then((r) => { reportedResult = r; }, (e) => { threw = e; });
  check.pending.push(p.then(() => {
    check('A measured: extractSnippet(REPORTED) does not throw', threw === null,
      threw ? threw.message : '');
    check('A measured: extractSnippet(REPORTED) produces a non-empty string',
      typeof reportedResult === 'string' && reportedResult.length > 0,
      `got ${JSON.stringify(reportedResult)}`);
    check('A measured: extractSnippet(REPORTED) contains no run of dots / ellipsis (CHANGE 1\'s job)',
      !hasEllipsis(reportedResult), `got ${JSON.stringify(reportedResult)}`);
    check('A measured: extractSnippet(REPORTED) fits MAX_CHARS',
      reportedResult && reportedResult.length <= MAX_CHARS,
      `got ${reportedResult && reportedResult.length}`);
    check('A measured: extractSnippet(REPORTED) does not reproduce the reported defect verbatim',
      reportedResult !== 'Great for offshore fishing and the length is....',
      `got ${JSON.stringify(reportedResult)}`);
    // Deliberately NOT asserted: whether reportedResult ends on a dangling
    // word ("...and the length is"). That is the known, held Change-2 gap
    // — see header. This harness only proves the ellipsis defect is gone.
  }));
}

{
  const p = extractSnippet(CLEAN_FITS).then((r) => r);
  check.pending.push(p.then((r) => {
    check('A clean-fits: a quote already inside the budget passes through UNTOUCHED',
      r === CLEAN_FITS, `got ${JSON.stringify(r)}`);
  }));
}

// ── R. Revert-prove CHANGE 1 via sibling copy (does not edit the tree) ──

function mutateOrThrow(src, from, to, label) {
  const mutated = src.replace(from, to);
  if (mutated === src) {
    throw new Error(`revert-prove mutation ${label} was a no-op — pattern missed the real source`);
  }
  return mutated;
}

function withMutatedSibling(realAbsPath, mutatedSrc, fn) {
  const dir = path.dirname(realAbsPath);
  const base = path.basename(realAbsPath, '.js');
  const tmpAbsPath = path.join(
    dir,
    `.__revertprove_${base}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.js`
  );
  fs.writeFileSync(tmpAbsPath, mutatedSrc);
  try {
    delete require.cache[tmpAbsPath];
    const mod = require(tmpAbsPath);
    return fn(mod, tmpAbsPath);
  } finally {
    try { fs.unlinkSync(tmpAbsPath); } catch { /* best effort */ }
    delete require.cache[tmpAbsPath];
  }
}

const realSrc = fs.readFileSync(SRC_PATH, 'utf8');

{
  // Revert CHANGE 1 alone — the gate + salvage collapse back to the
  // original bare `if (source.length <= MAX_CHARS) return source;`. Must
  // reproduce the exact reported defect: the dotted fragment ships as-is.
  const gatedBlock = `if (source.length <= MAX_CHARS && meetsProofBar(source)) {
    snippetCacheSet(cacheKey, source);
    return source;
  }
  if (source.length <= MAX_CHARS) {
    // Fits the budget but fails the bar — run the same clause/sentence ladder
    // used for an over-budget quote instead of shipping the fragment.
    const salvaged = bestFallbackSnippet(clean, source, MAX_CHARS);
    snippetCacheSet(cacheKey, salvaged);
    return salvaged;
  }`;
  const ungated = `if (source.length <= MAX_CHARS) {
    snippetCacheSet(cacheKey, source);
    return source;
  }`;
  const mutated = mutateOrThrow(realSrc, gatedBlock, ungated, 'R1');
  const p = withMutatedSibling(SRC_PATH, mutated, (mod) => mod.extractSnippet(REPORTED));
  check.pending.push(Promise.resolve(p).then((got) => {
    check('R1 revert CHANGE 1 alone reproduces the reported defect verbatim (A measured would go red)',
      got === 'Great for offshore fishing and the length is....',
      `got ${JSON.stringify(got)}`);
    check('R1 revert CHANGE 1 alone: the no-ellipsis assertion specifically would fail',
      hasEllipsis(got), `got ${JSON.stringify(got)}`);
  }));
}

// ── Finish ───────────────────────────────────────────────────────────
Promise.all(check.pending || []).then(() => {
  console.log = realLog;
  console.warn = realWarn;

  if (failures.length) {
    console.error(`\n❌ verifyQuoteSnippetProofBarGate: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyQuoteSnippetProofBarGate: ${pass} checks passed`);
  console.log('   extractSnippet driven for real on the reported shape; CHANGE 1 revert-proven.');
  console.log('   CHANGE 2 (conjunction-split / DANGLING_END) is HELD, not covered here — see file header.');
}).catch((err) => {
  console.log = realLog;
  console.warn = realWarn;
  console.error(`\n❌ verifyQuoteSnippetProofBarGate: harness error — ${err.message}`);
  process.exit(1);
});
