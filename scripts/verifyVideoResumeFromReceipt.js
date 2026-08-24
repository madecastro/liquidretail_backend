#!/usr/bin/env node
'use strict';
//
// verifyVideoResumeFromReceipt — pins generateForAd's resume-from-receipt gate.
//
// THE BUG THIS CLOSES. generateForAd used to submit a NEW Atlas Omni
// generation on every call, with no check of an existing ad.veoPredictionId.
// That is correct the first time an ad renders. It is a double-bill the
// SECOND time: if an ad's claim is released while status stays 'rendering'
// and it already holds a receipt — a future claim-TTL sweeper, a SIGKILL/OOM
// the shutdown handler never sees, or any other requeue-without-clearing-the
// -receipt path — a worker re-enters claimOne -> renderVideo -> generateForAd
// and pays a second time for one video. claimOne has no receipt filter
// (verifyRendererAtomicClaim.js), and services/spendReceipt.js's "never
// requeue a receipt-holding ad" rule only governs REQUEUES — it says nothing
// about what generateForAd itself does once re-entered.
//
// WHY THE FIX IS NOT "call the existing resumeForAd() at the top of
// generateForAd". That was the first, wrong shape of this fix — adversarial
// review (Grok xhigh) found three real reasons it breaks things:
//
//   1. adRegenerateService calls generateForAd on the SAME Ad doc for an
//      OPERATOR-REQUESTED new video, and never clears veoPredictionId. A
//      blind resume there would silently serve the OLD master back instead
//      of submitting the new one — the regenerate would appear to do
//      nothing.
//   2. resumeForAd/peekPrediction is a ONE-SHOT peek built for the
//      out-of-band bootRecoveryService sweep. It does not poll a still-
//      running job to completion and does not Cloudinary-mirror a success —
//      wiring it in directly would return a shape no caller of
//      generateForAd understands.
//   3. Nothing binds a veoPredictionId to a specific ATTEMPT — the retry
//      loop overwrites it on every submit. A resume gate must only ever
//      apply to the FIRST attempt of a call, never to a retry the loop's
//      own money gate (mayRetryAfterFailure) has already decided is safe to
//      resubmit.
//
// THE ACTUAL FIX. shouldResumeAttempt (atlasVideoService.js) is a pure,
// exported decision — allowResume (caller's choice, default true) AND
// attempt===1 AND an existing veoPredictionId. When true, generateForAd's
// retry loop skips submitGeneration() entirely on that one iteration and
// hands the EXISTING predictionId to the SAME pollPrediction() call the
// fresh-submit path already uses — every downstream step (retry-on-failure,
// cost reconcile, download, Cloudinary mirror, the return shape) runs
// completely unchanged, because none of it cares whether predictionId came
// from a fresh submit or an existing receipt. adRegenerateService passes
// allowResume:false explicitly to keep its "always submit fresh" behaviour.
//
// ACCEPTED, NOT CLOSED: the window between submitGeneration() returning and
// the veoPredictionId $set landing is the same one services/spendReceipt.js
// already documents as irreducible without a pre-submit intent record. A
// crash in that exact window leaves the Ad pointing at the PREVIOUS
// attempt's id (or none) — resuming from that stale id cannot see the truly
// in-flight, already-billed new one. This fix does not widen that window;
// it is unrelated to what generateForAd does once it already has an id in
// hand.
//
// Offline only: no DB, no network, no Atlas key.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n     ${err.message}`); }
}

console.log('verifyVideoResumeFromReceipt\n');

// ── A. shouldResumeAttempt — exhaustive behavioural matrix ────────────────
console.log('── A: shouldResumeAttempt (pure decision) ──');

const { shouldResumeAttempt } = require(path.join(ROOT, 'src/services/atlasVideoService'));

const MATRIX = [
  // [label, args, expected]
  ['A1 normal render, first attempt, receipt exists -> RESUME',
    { allowResume: true, attempt: 1, existingPredictionId: 'pred_abc123' }, true],
  ['A2 regenerate (allowResume:false), receipt exists -> submit fresh',
    { allowResume: false, attempt: 1, existingPredictionId: 'pred_abc123' }, false],
  ['A3 first-ever render, no receipt (null) -> submit fresh',
    { allowResume: true, attempt: 1, existingPredictionId: null }, false],
  ['A4 first-ever render, no receipt (undefined) -> submit fresh',
    { allowResume: true, attempt: 1, existingPredictionId: undefined }, false],
  ['A5 schema-default empty string -> submit fresh',
    { allowResume: true, attempt: 1, existingPredictionId: '' }, false],
  ['A6 [THE RETRY-LOOP INVARIANT] attempt 2 with a receipt -> NEVER resume',
    { allowResume: true, attempt: 2, existingPredictionId: 'pred_abc123' }, false],
  ['A7 attempt 3 with a receipt -> NEVER resume',
    { allowResume: true, attempt: 3, existingPredictionId: 'pred_abc123' }, false],
  ['A8 allowResume as the string "true" (truthy, not boolean true) -> submit fresh',
    { allowResume: 'true', attempt: 1, existingPredictionId: 'pred_abc123' }, false],
  ['A9 [STRICT, NOT COERCED] attempt as the string "1" -> submit fresh',
    { allowResume: true, attempt: '1', existingPredictionId: 'pred_abc123' }, false],
  ['A10 existingPredictionId not a string (e.g. an ObjectId-like object) -> submit fresh',
    { allowResume: true, attempt: 1, existingPredictionId: { toString: () => 'pred_abc123' } }, false]
];

for (const [label, args, expected] of MATRIX) {
  check(label, () => {
    assert.strictEqual(shouldResumeAttempt(args), expected,
      `shouldResumeAttempt(${JSON.stringify(args)}) should be ${expected}`);
  });
}

// ── B. the retry loop actually consults it, and actually skips the submit ──
console.log('\n── B: generateForAd wiring ──');

// A REGEX-BASED "strip // and /* */" is not safe on a 500+ line function full
// of prose comments and template-literal log lines: a comment or string can
// contain an unmatched brace character (a JSDoc-shaped `{string}` mention, a
// stray "}" in an example), and a naive regex strip either leaves those
// braces behind or removes code around them — either way the NET brace count
// this file relies on to find function boundaries goes wrong. Measured while
// building this harness: a simple `.replace(/\/\/.../g, '')` left
// generateForAd's own body brace-count off by one and every downstream
// extraction (B3 onward) silently returned null. Character-walking tokenizer
// instead — same technique already proven in
// scripts/verifyVideoQcVerdictSurvives.js's analyzeSource for exactly this
// reason, reused rather than re-invented.
function stripComments(src) {
  let out = ''; let i = 0;
  let inS = null, inBlock = false, inLine = false, inRe = false;
  let prevSig = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (inLine)       { if (c === '\n') { inLine = false; out += c; } i++; continue; }
    if (inBlock)      { if (c === '*' && d === '/') { inBlock = false; i += 2; } else i++; continue; }
    if (inS)          { out += c; if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
                        if (c === inS) inS = null; i++; continue; }
    if (inRe)         { out += c; if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
                        if (c === '/') inRe = false; i++; continue; }
    if (c === '/' && d === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && d === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; out += c; i++; continue; }
    if (c === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(prevSig)) { inRe = true; out += c; i++; continue; }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}
function balanced(text, openIdx, open, close) {
  if (openIdx < 0 || text[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}
function fnBody(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const open = text.indexOf('{', text.indexOf(')', start));
  return balanced(text, open, '{', '}');
}

// ── Decoy-resistant helpers (B4/B5/C2/C3 hardening) ────────────────────────
//
// A plain regex match anywhere in a stripped-of-comments source can still
// land inside a STRING or TEMPLATE literal — stripComments only removes //
// and /* */ comments and regex literals, it preserves string/template
// contents verbatim. A stale comment-as-string, a dead decoy call, or a
// second call sitting next to a drifted real one can all satisfy a bare
// substring/regex check while the actual wiring is wrong. These helpers
// pin a match to real code and pin the ARGUMENTS of the call, not just its
// name.

// True iff matchIndex sits STRICTLY INSIDE a '...', "..." or `...` literal
// (after the opening quote, before the closing quote). Honours backslash
// escapes. Deliberately not an overlap test: a real match like
// `allowResume: false` starts in CODE even if its tail runs into a string.
// A decoy has its match START in the middle of someone else's quotes.
function isInsideAString(text, matchIndex) {
  if (matchIndex == null || matchIndex < 0 || matchIndex > text.length) return false;
  let inS = null;
  for (let i = 0; i < matchIndex; i++) {
    const c = text[i];
    if (inS) {
      if (c === '\\') { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inS = c;
  }
  return inS !== null;
}

// Regex hits whose START is not inside a string/template.
function findRealMatches(text, regex) {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  const hits = [];
  let m;
  while ((m = re.exec(text))) {
    if (!isInsideAString(text, m.index)) hits.push(m);
  }
  return hits;
}
// `balanced` already generalizes to any open/close pair — reused for '('/')'
// as the argument-list extractor, no separate paren helper needed.
function callOpenAt(text, match) {
  return text.indexOf('(', match.index);
}
function callArgsAt(text, match) {
  return balanced(text, callOpenAt(text, match), '(', ')');
}
function afterCall(text, match) {
  const open = callOpenAt(text, match);
  const args = balanced(text, open, '(', ')');
  return args ? text.slice(open + args.length) : '';
}
function firstObjectLiteral(argsText) {
  if (!argsText) return null;
  const objOpen = argsText.indexOf('{');
  if (objOpen < 0) return null;
  return balanced(argsText, objOpen, '{', '}');
}

// Split an object-literal interior on TOP-LEVEL commas only (nested
// {}/[]/() and string literals are not split points).
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0, cur = '', inStr = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += text[i + 1] || ''; i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
// Shorthand `allowResume` maps to { allowResume: 'allowResume' };
// `allowResume: false` maps to { allowResume: 'false' }. Last duplicate
// key wins — same as JS.
function objectLiteralEntries(objLiteralText) {
  const inner = objLiteralText.slice(1, -1);
  const entries = {};
  for (const part of splitTopLevelCommas(inner)) {
    const kv = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(part);
    if (kv) { entries[kv[1]] = kv[2].trim(); continue; }
    const sh = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part);
    if (sh) entries[sh[1]] = sh[1];
  }
  return entries;
}

const atlasSrcRaw = fs.readFileSync(path.join(ROOT, 'src/services/atlasVideoService.js'), 'utf8');
const atlasSrc = stripComments(atlasSrcRaw);

const genBody = fnBody(atlasSrc, 'async function generateForAd(');
check('B1 generateForAd() is present and its body extracts', () => {
  assert.ok(genBody && genBody.length > 500, 'not found — re-derive this harness against atlasVideoService.js');
});

check('B2 generateForAd declares allowResume = true as a parameter default', () => {
  // The PARAMETER LIST, not genBody — fnBody's balanced-brace extraction
  // starts at the function BODY's opening brace, after the closing `)` of
  // the destructured parameter list, so the parameter defaults live in the
  // span BEFORE genBody, not inside it. Slice from the signature to genBody
  // itself to cover exactly the parameter list.
  const sigStart = atlasSrc.indexOf('async function generateForAd(');
  const paramList = atlasSrc.slice(sigStart, atlasSrc.indexOf(genBody, sigStart));
  assert.match(paramList, /allowResume\s*=\s*true/,
    'allowResume must default to true (the safe default for the normal render path)');
});

// Isolate the retry loop body specifically — the resume gate must live INSIDE
// it (scoped to a single attempt), not floating at the top of the function
// (which would apply to every attempt and defeat A6/A7's invariant).
const loopStart = genBody.indexOf('for (let attempt = 1');
const loopOpenBrace = genBody.indexOf('{', genBody.indexOf(')', loopStart));
const loopBody = balanced(genBody, loopOpenBrace, '{', '}');

check('B3 the retry loop is present and its body extracts', () => {
  assert.ok(loopBody && loopBody.length > 200, 'the `for (let attempt = 1; ...)` loop was not found');
});

check('B4 [DECOY-RESISTANT] the loop calls shouldResumeAttempt(...) and branches on it', () => {
  // ONE connected assignment — not two independent substring matches.
  // Defeat this used to pass: a discarded shouldResumeAttempt(unrelated)
  // plus `const isResuming = attempt === 1 && ad.veoPredictionId`.
  const assigns = findRealMatches(loopBody, /isResuming\s*=\s*shouldResumeAttempt\s*\(/);
  assert.ok(assigns.length >= 1,
    'expected `isResuming = shouldResumeAttempt(` as a single assignment — a discarded ' +
    'shouldResumeAttempt(...) call plus an unrelated isResuming is the double-bill hole');

  for (const assign of assigns) {
    const args = callArgsAt(loopBody, assign);
    assert.ok(args, 'could not balance shouldResumeAttempt(...) arguments (nested parens)');
    // Direct assignment: `|| true` / `&& extra` / ternary would let isResuming
    // diverge from the money-gate's return value.
    const tail = afterCall(loopBody, assign);
    assert.ok(!/^\s*(\|\||&&|\?|,)/.test(tail),
      'isResuming must be assigned shouldResumeAttempt(...) directly, with no ||/&&/ternary/' +
      `comma after the call (tail=${JSON.stringify(tail.slice(0, 40))})`);

    const obj = firstObjectLiteral(args);
    assert.ok(obj, 'shouldResumeAttempt must be passed an object literal, not positional args');
    const entries = objectLiteralEntries(obj);
    assert.strictEqual(entries.allowResume, 'allowResume',
      'must pass the allowResume parameter through (shorthand or allowResume: allowResume), ' +
      `not a boolean literal — got ${JSON.stringify(entries.allowResume)}`);
    assert.strictEqual(entries.attempt, 'attempt',
      'must pass the loop\'s `attempt` (not a hardcoded 1 — that would resume on retries and ' +
      `defeat A6/A7) — got ${JSON.stringify(entries.attempt)}`);
    assert.ok(/^ad\.veoPredictionId\b/.test(entries.existingPredictionId || ''),
      'existingPredictionId must be sourced from the Ad field ad.veoPredictionId — got ' +
      JSON.stringify(entries.existingPredictionId));
  }

  assert.ok(findRealMatches(loopBody, /if\s*\(\s*isResuming\s*\)/).length >= 1,
    'expected an `if (isResuming)` branch — a differently-named variable would still need to gate the submit');
});

check('B5 [THE MECHANISM] [DECOY-RESISTANT] the isResuming branch does NOT call submitGeneration', () => {
  // Extract the `if (isResuming) { ... } else { ... }` shape and confirm
  // submitGeneration only appears on the ELSE side, and is AWAITED there.
  // Then scan the REST of the loop (before the if AND after the else) — a
  // stray submit after the if/else is invisible to branch-only extraction
  // and would double-submit (double-bill) on every resumed attempt.
  const ifHits = findRealMatches(loopBody, /if\s*\(\s*isResuming\s*\)\s*\{/);
  assert.ok(ifHits.length >= 1, 'if (isResuming) { not found in the loop body');
  const ifIdx = ifHits[0].index;
  const ifOpen = loopBody.indexOf('{', ifIdx);
  const ifBlock = balanced(loopBody, ifOpen, '{', '}');
  assert.ok(ifBlock, 'could not balance the if (isResuming) block');
  assert.ok(findRealMatches(ifBlock, /submitGeneration\s*\(/).length === 0,
    'the isResuming branch calls submitGeneration — this is the exact double-bill the fix exists to prevent');

  const afterIf = ifOpen + ifBlock.length;
  const elseMatch = /^\s*else\s*\{/.exec(loopBody.slice(afterIf, afterIf + 40));
  assert.ok(elseMatch, 'no else branch immediately follows if (isResuming) { ... }');
  const elseOpen = afterIf + elseMatch[0].indexOf('{');
  const elseBlock = balanced(loopBody, elseOpen, '{', '}');
  assert.ok(elseBlock, 'could not balance the else (fresh-submit) block');
  assert.ok(findRealMatches(elseBlock, /await\s+submitGeneration\s*\(/).length >= 1,
    'the else (fresh-submit) branch must AWAIT submitGeneration — a fire-and-forget call races the poll');

  const outside = loopBody.slice(0, ifIdx) + loopBody.slice(elseOpen + elseBlock.length);
  const stray = findRealMatches(outside, /submitGeneration\s*\(/);
  assert.ok(stray.length === 0,
    'submitGeneration() appears outside the if (isResuming)/else — a resumed attempt would ' +
    'submit (and bill) a second time. The gate only skips the call INSIDE the else; anything ' +
    'after (or before) the if/else still runs on the resume path.');
});

check('B6 the isResuming branch does NOT write a NEW veoPredictionId or a second CostLog "submitted" row', () => {
  const ifIdx = loopBody.search(/if\s*\(\s*isResuming\s*\)\s*\{/);
  const ifOpen = loopBody.indexOf('{', ifIdx);
  const ifBlock = balanced(loopBody, ifOpen, '{', '}');
  assert.ok(!/Ad\.updateOne/.test(ifBlock),
    'the isResuming branch writes to the Ad doc — veoPredictionId is already correct, a rewrite is unnecessary ' +
    'and a DIFFERENT write here has not been reviewed for this branch');
  assert.ok(!/recordFlatCost\s*\(/.test(ifBlock),
    'the isResuming branch records a new CostLog row — this would duplicate the original submit\'s row ' +
    '($1.50 booked for one delivered video, the exact shape the charge-point comment already warns about)');
});

check('B7 shouldResumeAttempt is exported (so this harness — and any future one — can test it directly)', () => {
  assert.match(atlasSrc, /shouldResumeAttempt\s*,?\s*\n/,
    'shouldResumeAttempt must appear in module.exports');
  const exportsBlock = atlasSrc.slice(atlasSrc.indexOf('module.exports'));
  assert.match(exportsBlock, /\bshouldResumeAttempt\b/, 'shouldResumeAttempt not found inside module.exports');
});

// ── C. every caller makes an explicit, auditable choice ───────────────────
console.log('\n── C: caller sites ──');

check('C1 renderer.js (the normal render path) passes allowResume: true explicitly', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8'));
  assert.match(src, /generateForAd\(\{[^}]*allowResume:\s*true[^}]*\}\)/,
    'renderer.js must pass allowResume: true explicitly — this is the exact call site a released claim on a ' +
    'receipt-holding ad re-enters, and it must not silently rely on the default going unnoticed');
});

check('C2 [THE REGENERATE CARVE-OUT] [DECOY-RESISTANT] adRegenerateService.js passes allowResume: false explicitly', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/adRegenerateService.js'), 'utf8'));

  // Pin to the LIVE call the exported entry point actually reaches — not
  // "any generateForAd({allowResume:false}) anywhere in the file". A string
  // decoy, a dead helper, or a second call next to a drifted live one used
  // to satisfy a file-wide regex.
  const exportsIdx = src.indexOf('module.exports');
  assert.ok(exportsIdx >= 0, 'adRegenerateService.js has no module.exports');
  const exportsBlock = src.slice(exportsIdx);
  assert.match(exportsBlock, /\bregenerateAd\b/,
    'regenerateAd must be the exported regenerate entry point');

  const regenBody = fnBody(src, 'async function regenerateAd(');
  assert.ok(regenBody, 'regenerateAd body not found');

  // Architecture: regenerateAd does not call generateForAd itself. The video
  // worker is runVideoFull (private), which regenerateAd invokes for
  // kind==='video'. Following only regenerateAd's braces would fail the real
  // code and invite a decoy generateForAd stuffed into the export.
  function assertAllGenerateForAdDisallowResume(body, where) {
    const calls = findRealMatches(body, /generateForAd\s*\(/);
    for (const c of calls) {
      const args = callArgsAt(body, c);
      assert.ok(args, `could not balance generateForAd(...) args in ${where}`);
      const obj = firstObjectLiteral(args);
      assert.ok(obj, `generateForAd in ${where} must be passed an object literal`);
      const entries = objectLiteralEntries(obj);
      assert.strictEqual(entries.allowResume, 'false',
        `generateForAd in ${where} must pass allowResume: false (a regenerate is an ` +
        'operator-requested NEW video on the same Ad doc, which never clears veoPredictionId) — got ' +
        JSON.stringify(entries.allowResume));
    }
    return calls.length;
  }

  const runCallsFromRegen = findRealMatches(regenBody, /\brunVideoFull\s*\(/);
  const nInRegen = assertAllGenerateForAdDisallowResume(regenBody, 'regenerateAd');
  const runBody = fnBody(src, 'async function runVideoFull(');
  const nInRun = (runCallsFromRegen.length >= 1 && runBody)
    ? assertAllGenerateForAdDisallowResume(runBody, 'runVideoFull')
    : 0;

  assert.ok(runCallsFromRegen.length >= 1 || nInRegen >= 1,
    'exported regenerateAd must reach generateForAd — either by calling runVideoFull or by calling generateForAd itself');
  assert.ok(nInRun + nInRegen >= 1,
    'no REAL (non-string-decoy) generateForAd({ allowResume: false }) on the live regenerate path');
});

check('C3 [DECOY-RESISTANT] videoRouter.js threads allowResume through to atlasVideoService.generateForAd', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/videoRouter.js'), 'utf8'));
  const fnBodyText = fnBody(src, 'async function generateForAd(');
  assert.ok(fnBodyText, 'videoRouter.js generateForAd not found');

  assert.ok(findRealMatches(fnBodyText, /allowResume/).length >= 1,
    'videoRouter.js generateForAd does not mention allowResume at all (outside a string/template)');

  const calls = findRealMatches(fnBodyText, /atlasVideoService\.generateForAd\s*\(/);
  assert.ok(calls.length >= 1,
    'videoRouter.js must pass allowResume through to atlasVideoService.generateForAd, not swallow it');
  for (const c of calls) {
    const args = callArgsAt(fnBodyText, c);
    assert.ok(args, 'could not balance atlasVideoService.generateForAd(...) args');
    const obj = firstObjectLiteral(args);
    assert.ok(obj, 'atlasVideoService.generateForAd must be passed an object literal');
    const entries = objectLiteralEntries(obj);
    // Identifier, not a boolean literal — hardcoding true would swallow
    // adRegenerateService's allowResume: false (regenerate goes through this wrapper).
    assert.strictEqual(entries.allowResume, 'allowResume',
      'videoRouter.js must thread the allowResume parameter through (shorthand or ' +
      `allowResume: allowResume), not a literal — got ${JSON.stringify(entries.allowResume)}`);
  }
});

// ── D. renderer.js: an unsettled-at-timeout Ad is released, never failed ──
console.log('\n── D: processAd unsettledAtTimeout handling (renderer.js) ──');
//
// THE OTHER HALF OF THIS FIX. A6/A7 pin that generateForAd itself never
// resumes on a retry — but the resume is only reachable at all if the FIRST
// attempt's own timeout is handled as "still pending", not "confirmed
// failed". pollPrediction throws err.unsettledAtTimeout when it hits its own
// MAX_POLL_MS wall-clock budget while Atlas was still genuinely processing
// (real Omni predictions measured taking 14-25+ min — well past that
// budget). If processAd's catch block stamped status:'failed' here the way
// it does for every other render error, the Ad becomes permanently
// unreachable: shouldResumeAttempt only ever fires when something re-enters
// generateForAd, and nothing re-enters a row already 'failed'. So this half
// of the fix is releasing the claim while leaving status:'rendering' intact
// — claimOne()'s own filter (status:'rendering', claimedByWorker:null) then
// re-claims it on a future poll, re-entering generateForAd fresh (attempt 1)
// with ad.veoPredictionId still set, which is exactly what A1 already pins
// resumes instead of resubmitting.

const rendererSrcRaw = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');
const rendererSrc = stripComments(rendererSrcRaw);

const processAdBody = fnBody(rendererSrc, 'async function processAd(');
check('D1 processAd() is present and its body extracts', () => {
  assert.ok(processAdBody && processAdBody.length > 200,
    'not found — re-derive this section against renderer.js');
});

// Isolate the INNER catch(err) block specifically — the same one that
// unconditionally writes status:'failed' for a generic render error. (The
// OUTER catch in processAd is the dead-today rethrow guard around the
// heartbeat and is not relevant here.)
const catchIdx = processAdBody.search(/catch\s*\(\s*err\s*\)\s*\{/);
const catchOpen = processAdBody.indexOf('{', catchIdx);
const catchBlock = balanced(processAdBody, catchOpen, '{', '}');

check('D2 the inner catch(err) block is present and extracts', () => {
  assert.ok(catchBlock && catchBlock.length > 100,
    'catch (err) { ... } block not found inside processAd');
});

function unsettledBranch() {
  const ifIdx = catchBlock.search(/if\s*\(\s*err\s*&&\s*err\.unsettledAtTimeout\s*\)\s*\{/);
  if (ifIdx < 0) return null;
  const ifOpen = catchBlock.indexOf('{', ifIdx);
  return { ifOpen, ifBlock: balanced(catchBlock, ifOpen, '{', '}') };
}

// Quote-agnostic literal matcher for the D-section string-value checks below.
// A prior version of D4 hardcoded /status:\s*'failed'/ (single-quote only) —
// an adversarial pass injected `$set: { status: "failed" }` (double-quoted)
// into the unsettledAtTimeout branch and D4 stayed green, because JS does not
// care which quote character a string literal uses but that regex did. Fixed
// by matching either quote character; findRealMatches additionally keeps a
// benign log-message mention of the same words from producing a false
// failure (this file already strips comments, so this only matters for an
// actual string ARGUMENT, e.g. inside a console.log or error message).
function findStringLiteralMatches(text, key, value) {
  return findRealMatches(text, new RegExp(`${key}\\s*:\\s*['"]${value}['"]`));
}

check('D3 [THE FIX] an unsettledAtTimeout branch exists, is reached BEFORE the generic failure write, and returns', () => {
  const branch = unsettledBranch();
  assert.ok(branch, 'no `if (err && err.unsettledAtTimeout)` branch found in the catch block');
  assert.ok(branch.ifBlock, 'could not balance the unsettledAtTimeout if-block');
  assert.match(branch.ifBlock, /return\s*;/,
    'the unsettledAtTimeout branch must return — otherwise execution falls through into the generic failed-status write below it');

  const genericFailedHits = findStringLiteralMatches(catchBlock, 'status', 'failed');
  assert.ok(genericFailedHits.length >= 1, 'no generic status:"failed" write found anywhere in the catch block');
  assert.ok(genericFailedHits[0].index > branch.ifOpen,
    'the generic status:"failed" write must come AFTER the unsettledAtTimeout branch in source order — ' +
    'if it ran first, the release below would be a no-op on an already-failed Ad');
});

check('D4 [QUOTE-AGNOSTIC] the unsettledAtTimeout branch does NOT stamp status to "failed"', () => {
  const branch = unsettledBranch();
  const hits = findStringLiteralMatches(branch.ifBlock, 'status', 'failed');
  assert.strictEqual(hits.length, 0,
    'the unsettledAtTimeout branch must not set status to "failed" (either quote style) — that strands the ' +
    'resume fix, since a "failed" Ad is never re-entered by claimOne or anything else');
});

check('D5 the unsettledAtTimeout branch releases the claim via releaseClaim(ad._id, ...)', () => {
  const branch = unsettledBranch();
  assert.match(branch.ifBlock, /releaseClaim\s*\(\s*ad\._id/,
    'expected releaseClaim(ad._id, ...) so claimOne() can re-claim this ad on a future poll ' +
    '(status:"rendering", claimedByWorker:null — see D7/D8)');
});

check('D6 [QUOTE-AGNOSTIC] the unsettledAtTimeout branch bumps the run counter as "skipped", never "failed"', () => {
  const branch = unsettledBranch();
  const skippedHits = findRealMatches(branch.ifBlock,
    /bumpRunCounter\s*\(\s*ad\.campaignRunIds\s*,\s*['"]skipped['"]\s*\)/);
  assert.ok(skippedHits.length >= 1,
    "expected bumpRunCounter(ad.campaignRunIds, 'skipped') (either quote style) — 'failed' would misreport a " +
    'genuinely still-pending Atlas job as a confirmed failure to the CampaignRun counters');
  const failedHits = findRealMatches(branch.ifBlock,
    /bumpRunCounter\s*\(\s*ad\.campaignRunIds\s*,\s*['"]failed['"]\s*\)/);
  assert.strictEqual(failedHits.length, 0,
    'the unsettledAtTimeout branch must not ALSO bump the run counter as "failed" alongside "skipped"');
});

check('D7 releaseClaim() clears claimedByWorker/claimedAt and never touches status', () => {
  const relBody = fnBody(rendererSrc, 'async function releaseClaim(');
  assert.ok(relBody, 'releaseClaim() not found in renderer.js');
  assert.match(relBody, /claimedByWorker:\s*null/, 'releaseClaim must clear claimedByWorker');
  assert.ok(!/\bstatus\s*:/.test(relBody),
    'releaseClaim must not write status — D3/D4 rely on status staying untouched at "rendering" after this call');
});

check('D8 claimOne() re-claims exactly the shape releaseClaim leaves behind', () => {
  const claimBody = fnBody(rendererSrc, 'async function claimOne(');
  assert.ok(claimBody, 'claimOne() not found in renderer.js');
  assert.match(claimBody, /status:\s*'rendering'/,
    'claimOne must filter on status:"rendering" — the unsettledAtTimeout branch deliberately leaves status here');
  assert.match(claimBody, /claimedByWorker:\s*null/,
    'claimOne must filter on claimedByWorker:null — exactly what releaseClaim produces');
});

console.log('');
if (failed) {
  console.log(`❌ verifyVideoResumeFromReceipt: ${failed} FAILED`);
  process.exit(1);
}
console.log('✅ verifyVideoResumeFromReceipt: all checks passed');
