#!/usr/bin/env node
'use strict';
//
// verifyVideoQcVerdictSurvives — renderVideo()'s terminal stamp must not
// overwrite a terminal verdict that titling already wrote.
//
// THE DEFECT THIS PINS (measured in production, 2026-08-24):
//
//   services/brandScriptExecutor.js buildVideoQcFailureFields() stamps
//   status:'failed' when a video ad really fails vision QC — that is PR #282,
//   "deliver a QC-failed ad as failed with the exact Slack reason". It runs
//   INSIDE renderBrandScriptAndSave, i.e. BEFORE renderVideo's terminal write.
//   Both of renderVideo's terminal writes used a bare { _id: ad._id } filter
//   and unconditionally $set status:'draft', so they overwrote that verdict
//   and then counted the ad 'succeeded'.
//
//   Prod count on 2026-08-24 (read-only job over the shared `ads` collection):
//       video ads, visionQc.passed:false, not skipped/disabled
//         status:'draft'   ->  47
//         status:'failed'  ->   0
//   Zero. The verdict never survived once. B=0 is the signature of this bug:
//   if the mechanism worked at all that number would be non-zero.
//
//   Amplified by PR #4: bumpRunCounter now calls maybeFinalizeRun, and
//   campaignRunGuards.classifyRunAdOutcome buckets a 'draft' ad as
//   succeeded++ once isVideoTitlingSettled(ad) passes. A QC-failed ad HAS
//   finished titling, so it passes that gate — the clobber therefore also
//   finalizes the CampaignRun with an inflated succeeded and failed:0. Note
//   the precise mechanism: the gate tests titling truth, NOT the QC verdict.
//   "draft counts as succeeded" is false — that file was already hardened
//   once (2026-08-20) against the unconditional version.
//
// WHY THE FIX IS AN $in ALLOWLIST AND NOT renderStatic's FILTER. The obvious fix — copy
// renderStatic's { _id, claimedByWorker, status:'rendering' } — is WRONG here
// and this harness pins that too. uploadRenderAndStamp (brandScriptExecutor)
// already promotes the row to 'draft' during titling, so a 'rendering' guard
// would no-op on every SUCCESSFUL render: claimedByWorker would never be
// cleared (claimOne requires it null, and renderer.js is the only writer of
// that field in either repo), and the titling debt would never settle.
//
// And the allowlist direction is itself the safety property: a
// $nin:['failed','archived'] denylist fails OPEN — any status nobody
// enumerated ('queued' from a backend requeue, 'live' from an operator) would
// be overwritten with 'draft'. $in admits only the two states this path owns.
//
// Pure + offline: fs/path/assert only, no node_modules required.
//   node scripts/verifyVideoQcVerdictSurvives.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const RAW = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');

// Comments are stripped BEFORE any scan. Without this, every check below can be
// satisfied by the prose that explains it — this file's own header contains
// `claimedByWorker: null` and `titlingResumeState: null`, so C2/C3 would pass
// against code that deleted both. Same lesson verifyLlmErrorCodes D5 learned.
// Regex-literal aware: `replace(/^['"]|['"]$/g, '')` desyncs a naive quote
// tracker for the rest of the file (see productDetailsService.js:56).
/**
 * One character-walk that both strips comments AND records string/template
 * literal spans in the OUTPUT's coordinate space. Regex-vs-division
 * disambiguation is the SAME prevSig heuristic stripComments always used —
 * reusing it here, not re-implementing it, is what stops the string tracker
 * from being confused by a quote INSIDE a regex literal (this file's own
 * /['"]draft['"]/ , for instance): a naive string-only scan applied
 * separately would see that ' and think a string just opened.
 *
 * WHY THIS EXISTS: adversarial review named a "string-decoy" hole in E2/E3 —
 * a string literal whose CONTENTS spell out the exact text a check searches
 * for (e.g. a log message containing "Object.assign(set, buildVideoQcFailure
 * Fields(") would satisfy a plain .indexOf/regex scan even though it is
 * inert data, not code. stringSpans lets a check reject a match that falls
 * inside someone else's string.
 */
function analyzeSource(src) {
  let out = ''; let i = 0;
  let inS = null, inBlock = false, inLine = false, inRe = false;
  let prevSig = '';
  const stringSpans = [];
  let stringStart = -1;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (inLine)       { if (c === '\n') { inLine = false; out += c; } i++; continue; }
    if (inBlock)      { if (c === '*' && d === '/') { inBlock = false; i += 2; } else i++; continue; }
    if (inS)          { out += c; if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
                        if (c === inS) { inS = null; stringSpans.push([stringStart, out.length]); }
                        i++; continue; }
    if (inRe)         { out += c; if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
                        if (c === '/') inRe = false; i++; continue; }
    if (c === '/' && d === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && d === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; stringStart = out.length; out += c; i++; continue; }
    if (c === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(prevSig)) { inRe = true; out += c; i++; continue; }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return { stripped: out, stringSpans };
}

/**
 * True if `idx` — the match's OWN START position — sits STRICTLY INSIDE the
 * interior of a tracked string (after its opening quote, before its closing
 * quote). Deliberately NOT an overlap test: a real, legitimate match like
 * `status: 'draft'` starts in CODE (at `status`) and its tail legitimately
 * runs into the 'draft' string's own span — an overlap test would call that
 * a decoy too, rejecting genuine code. A decoy, by contrast, has its match
 * START somewhere in the MIDDLE of an unrelated string's content, because
 * the whole needle was typed as characters between someone else's quotes.
 */
function isInsideAString(stringSpans, idx) {
  return stringSpans.some(([s, e]) => idx > s && idx < e);
}

function stripComments(src) { return analyzeSource(src).stripped; }

const { stripped: SRC, stringSpans: SRC_STRINGS } = analyzeSource(RAW);

let failures = 0;
let passes = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err.message}`); }
}

/** Slice from `openIdx` (must be the opening delimiter) to its match. */
function balanced(text, openIdx, open, close) {
  if (openIdx < 0 || text[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}

/** Body of a top-level `async function <name>(` declaration. */
function fnBody(name) {
  const m = new RegExp(`async function ${name}\\s*\\(`).exec(SRC);
  if (!m) return null;
  return balanced(SRC, SRC.indexOf('{', SRC.indexOf(')', m.index)), '{', '}');
}

const renderVideoBody = fnBody('renderVideo');
// Offset of renderVideoBody within SRC, so section F can shift SRC_STRINGS
// into renderVideoBody-local coordinates for decoy-resistant scanning —
// same technique section E used for uploadBody before it became behavioural.
const renderVideoOffset = (() => {
  const m = /async function renderVideo\s*\(/.exec(SRC);
  return m ? SRC.indexOf('{', SRC.indexOf(')', m.index)) : -1;
})();
const renderVideoStrings = renderVideoOffset >= 0
  ? SRC_STRINGS.map(([s, e]) => [s - renderVideoOffset, e - renderVideoOffset]).filter(([s]) => s >= 0)
  : [];

// ── A. the scan is real (a zero-result scan proves nothing) ──────────────
console.log('\n── A: the scan found the code it claims to check ──');

check('A1 renderVideo() is present and its body extracts', () => {
  assert.ok(renderVideoBody && renderVideoBody.length > 500,
    'renderVideo body not found — re-derive this harness against renderer.js');
});

// Every Ad.updateOne / findOneAndUpdate inside renderVideo, as {filter, update}.
const writes = [];
{
  const CALL = /Ad\.(updateOne|findOneAndUpdate)\s*\(/g;
  let m;
  while ((m = CALL.exec(renderVideoBody))) {
    const openParen = renderVideoBody.indexOf('(', m.index + m[0].length - 1);
    const args = balanced(renderVideoBody, openParen, '(', ')');
    if (!args) continue;
    const firstBrace = args.indexOf('{');
    const filter = balanced(args, firstBrace, '{', '}') || '';
    const afterFilter = firstBrace + filter.length;
    const updBrace = args.indexOf('{', afterFilter);
    const update = balanced(args, updBrace, '{', '}') || '';
    writes.push({ filter, update });
    CALL.lastIndex = m.index + args.length;
  }
}

check('A2 the scan found renderVideo\'s Ad writes', () => {
  assert.ok(writes.length >= 4,
    `expected >=4 Ad writes inside renderVideo, found ${writes.length}`);
});

// The terminal writes are the ones that promote to draft.
const draftWrites = writes.filter((w) => /status:\s*['"]draft['"]/.test(w.update));

check('A3 both terminal draft-promoting writes were found (derive + master)', () => {
  assert.strictEqual(draftWrites.length, 2,
    `expected exactly 2 status:'draft' writes in renderVideo, found ${draftWrites.length}`);
});

// ── B. THE DEFECT — the verdict must survive ─────────────────────────────
console.log('\n── B: a terminal verdict written by titling must survive ──');

check('B1 [THE FIX] every draft-promoting write is guarded against an existing terminal verdict', () => {
  const unguarded = draftWrites.filter((w) => !/status:\s*\{[^}]*\$in[^}]*\}/.test(w.filter));
  assert.strictEqual(unguarded.length, 0,
    `${unguarded.length} of ${draftWrites.length} draft writes use an unguarded filter and will ` +
    `overwrite a vision-QC 'failed' verdict. Filter(s): ${unguarded.map((w) => w.filter.replace(/\s+/g, ' ')).join(' | ')}`);
});

check('B1b [ANTI-DUPLICATE-KEY] no draft-write filter declares `status` more than once', () => {
  // { _id, status: {$in:[...]}, status: {$exists:true} } is valid JS — the
  // SECOND key wins at runtime and silently defeats the guard the first key
  // appears to set, while a naive single-match regex (B1/B2) still finds the
  // first and reports green. Count occurrences, not presence.
  for (const w of draftWrites) {
    const occurrences = (w.filter.match(/(?<![\w$])status\s*:/g) || []).length;
    assert.strictEqual(occurrences, 1,
      `filter declares status ${occurrences} times — the last one silently wins at runtime: ` +
      w.filter.replace(/\s+/g, ' '));
  }
});

check('B2 [FAIL-CLOSED] the guard is an ALLOWLIST of exactly rendering+draft', () => {
  // A $nin denylist fails OPEN — any status nobody enumerated ('queued' from a
  // requeue, 'live' from an operator) would be overwritten with 'draft'. The
  // allowlist admits only the two states this path legitimately owns, so every
  // unknown status falls to the settle-only arm instead of being resurrected.
  for (const w of draftWrites) {
    const g = /status:\s*\{\s*\$in:\s*\[([^\]]*)\]/.exec(w.filter);
    assert.ok(g, `a draft write has no $in status allowlist: ${w.filter.replace(/\s+/g, ' ')}`);
    const allowed = g[1].match(/'([a-z]+)'/g) || [];
    assert.deepStrictEqual(allowed.sort(), ["'draft'", "'rendering'"],
      `the allowlist must be exactly rendering+draft, got ${g[1].trim()}`);
    assert.ok(!/\$nin/.test(w.filter), 'a $nin denylist fails open — use the $in allowlist');
  }
});

check('B3 [THE TRAP] the guard is NOT status:\'rendering\'', () => {
  for (const w of draftWrites) {
    assert.ok(!/status:\s*'rendering'/.test(w.filter),
      "a status:'rendering' guard no-ops on every SUCCESSFUL render — titling already " +
      'promoted the row to draft. It would strand claimedByWorker forever.');
  }
});

// ── C. a no-op must not strand the claim ─────────────────────────────────
console.log('\n── C: the guarded no-op still settles claim + titling debt ──');

const settleBody = fnBody('settleNonDraftTerminal');

check('C1 a fallback path exists for the guarded no-op', () => {
  assert.ok(settleBody, 'settleNonDraftTerminal() not found — the no-op branch has no handler, ' +
    'so a QC-failed ad keeps claimedByWorker forever and becomes unclaimable');
});

check('C1b [ANTI-DEAD-CODE] the fallback is actually CALLED from renderVideo', () => {
  // C1 only proves the function EXISTS. A version that defines it and never
  // calls it keeps every other check green while the no-op arm strands the
  // claim — the exact false-green an adversarial pass found in the first draft.
  const calls = renderVideoBody.match(/settleNonDraftTerminal\s*\(/g) || [];
  assert.strictEqual(calls.length, 2,
    `both video branches must route their no-op through the fallback, found ${calls.length} call(s)`);
});

check('C2 the fallback clears claimedByWorker (nothing else in either repo does)', () => {
  assert.match(settleBody, /claimedByWorker:\s*null/,
    'claimOne requires claimedByWorker:null; renderer.js is the only writer of that field');
  assert.match(settleBody, /claimedAt:\s*null/);
});

check('C3 the fallback settles the titling debt', () => {
  assert.match(settleBody, /titlingResumeState:\s*null/,
    "leaving 'claimed' lets titlingResumeService re-render this ad after CLAIM_STALE_MIN");
});

check('C4 the fallback never re-writes status (it must not resurrect the verdict)', () => {
  // Scoped to the $set clause of each Ad write inside the fallback, NOT the
  // whole function body — `projection: { status: 1 }` is a READ, and the
  // function's own `return { status: kept, ... }` is its result shape for
  // the caller, neither is a write to Mongo. Banning ANY status key (not
  // just a quoted literal) inside a $set still matters: `status: next` (a
  // variable) resurrects the verdict exactly as badly as `status: 'draft'`.
  const CALL = /Ad\.(updateOne|findOneAndUpdate)\s*\(/g;
  let m;
  let found = 0;
  while ((m = CALL.exec(settleBody))) {
    const openParen = settleBody.indexOf('(', m.index + m[0].length - 1);
    const args = balanced(settleBody, openParen, '(', ')');
    if (!args) continue;
    found++;
    const setIdx = args.indexOf('$set:');
    if (setIdx >= 0) {
      const setObj = balanced(args, args.indexOf('{', setIdx), '{', '}') || '';
      assert.ok(!/(?<![\w$])status\s*:/.test(setObj),
        `the fallback must not $set status at all — it exists precisely to leave the verdict ` +
        `alone. Found in: ${setObj.replace(/\s+/g, ' ')}`);
    }
    CALL.lastIndex = m.index + args.length;
  }
  assert.ok(found >= 1, 'no Ad write found inside the fallback to check — did it change shape?');
});

// ── D. the run counter must tell the truth ───────────────────────────────
console.log('\n── D: a QC-failed ad must not be counted as a success ──');

check('D1 [THE FIX] neither video branch hardcodes bumpRunCounter(..., \'succeeded\')', () => {
  const hardcoded = renderVideoBody.match(/bumpRunCounter\([^)]*'succeeded'\s*\)/g) || [];
  assert.strictEqual(hardcoded.length, 0,
    `${hardcoded.length} video branch(es) still hardcode 'succeeded', so a QC-failed ad inflates ` +
    'the CampaignRun via maybeFinalizeRun -> classifyRunAdOutcome. Found: ' + hardcoded.join(', '));
});

check('D2 both video branches derive the counter from the settled outcome', () => {
  const derived = renderVideoBody.match(/bumpRunCounter\([^)]*\.counter\s*\)/g) || [];
  assert.strictEqual(derived.length, 2,
    `expected both video branches to pass the settled .counter, found ${derived.length}`);
});

check('D3 the fallback maps a real \'failed\' verdict to the failed counter', () => {
  // Only the exact non-inverted ternary counts. The old second alternative
  // (`counter:\s*[^\n]*failed`) was vacuous — it also matched an INVERTED
  // mapping (`kept === 'failed' ? 'succeeded' : 'failed'`), which reports a
  // real QC failure as succeeded and passed this check anyway.
  assert.match(settleBody, /kept\s*===\s*'failed'\s*\?\s*'failed'\s*:\s*'succeeded'/,
    "settleNonDraftTerminal must map kept==='failed' -> 'failed', not the inverse");
});

// ── F. NO BRAND RESOLVED must still reach vision QC ──────────────────────
// A SEPARATE, pre-existing defect from B/C/D above (found during adversarial
// review of #7): both `if (brandDoc) { ...renderBrandScriptAndSave... }`
// blocks had no else-arm at all. When brandDoc is falsy, NEITHER
// renderBrandScriptAndSave NOR any QC call ever runs — the ad ships with
// ZERO Ad.visionQc, not even a {skipped:true, disabled:true} stub. Backend
// hit and fixed this exact gap already (routes/ads.js:2609/3067, comment:
// "NO BRAND RESOLVED — same gap as the master path"); adgen's renderer.js
// was ported without the else-arm. This is presence, not order/decoy risk
// (unlike section E's old defeat class) — but still string-decoy-scanned
// for the same reason section A-D's checks already strip comments: cheap
// insurance against a log message that spells out the exact text this
// check searches for.
console.log('\n── F: NO BRAND RESOLVED must still reach vision QC ──');

/** Every top-level `if (brandDoc) { ... }` in `body`, paired with whatever
 *  else-block (if any) immediately follows it. */
function findBrandDocArms(body) {
  const arms = [];
  const IF_RE = /if\s*\(\s*brandDoc\s*\)\s*\{/g;
  let m;
  while ((m = IF_RE.exec(body))) {
    const ifOpen = body.indexOf('{', m.index);
    const ifBlock = balanced(body, ifOpen, '{', '}');
    if (!ifBlock) continue;
    const afterIf = ifOpen + ifBlock.length;
    const elseMatch = /^\s*else\s*\{/.exec(body.slice(afterIf, afterIf + 40));
    let elseBlock = null, elseOffset = -1;
    if (elseMatch) {
      elseOffset = afterIf + elseMatch[0].indexOf('{');
      elseBlock = balanced(body, elseOffset, '{', '}');
    }
    arms.push({ ifIndex: m.index, ifBlock, elseBlock, elseOffset });
    IF_RE.lastIndex = afterIf;
  }
  return arms;
}

const brandDocArms = findBrandDocArms(renderVideoBody);

check('F1 both if (brandDoc) blocks were found (derive + master)', () => {
  assert.strictEqual(brandDocArms.length, 2,
    `expected exactly 2 "if (brandDoc)" blocks in renderVideo, found ${brandDocArms.length}`);
});

check('F2 [THE FIX] each if (brandDoc) block has an else-arm', () => {
  const missing = brandDocArms.filter((a) => !a.elseBlock);
  assert.strictEqual(missing.length, 0,
    `${missing.length} of ${brandDocArms.length} "if (brandDoc)" blocks have NO else-arm — a no-brand ` +
    'video ad ships with zero Ad.visionQc, not even a skipped/disabled stub.');
});

check('F3 [ANTI-DECOY] each else-arm actually CALLS qcAndStampVideoAd — not a string that mentions it', () => {
  for (const { elseBlock, elseOffset } of brandDocArms) {
    if (!elseBlock) continue; // already failed by F2
    const CALL_RE = /qcAndStampVideoAd\s*\(/g;
    let found = false, cm;
    while ((cm = CALL_RE.exec(elseBlock))) {
      if (!isInsideAString(renderVideoStrings, elseOffset + cm.index)) { found = true; break; }
    }
    assert.ok(found, 'no REAL (non-string-decoy) call to qcAndStampVideoAd found in the else-arm');
  }
});

/** Split the interior of a balanced "{...}" object literal on TOP-LEVEL
 *  commas only (tracking nested {}/[]/() and string literals), then parse
 *  each part as a `key: value` entry. Needed because the derive arm's `ad:`
 *  value is itself an object literal with its own commas — a naive split on
 *  every comma would misparse it. */
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
function objectLiteralEntries(objLiteralText) {
  const inner = objLiteralText.slice(1, -1); // strip outer { }
  const entries = {};
  for (const part of splitTopLevelCommas(inner)) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(part);
    if (m) entries[m[1]] = m[2].trim();
  }
  return entries;
}

/** Find every REAL (non-string-decoy) `await qcAndStampVideoAd({...})` call
 *  in `elseBlock`, returning {argsEntries, awaited, callIdx} for each. Reused
 *  by F4-F6 so all three inspect the SAME real call(s) — a check that
 *  re-derives its own match independently can silently diverge from what the
 *  others verified. */
function findRealQcCalls(elseBlock, elseOffset) {
  const found = [];
  const CALL_RE = /qcAndStampVideoAd\s*\(/g;
  let cm;
  while ((cm = CALL_RE.exec(elseBlock))) {
    if (isInsideAString(renderVideoStrings, elseOffset + cm.index)) continue;
    const openParen = elseBlock.indexOf('(', cm.index);
    const callArgs = balanced(elseBlock, openParen, '(', ')') || '';
    const objStart = callArgs.indexOf('{');
    const objLiteral = objStart >= 0 ? (balanced(callArgs, objStart, '{', '}') || '') : '';
    const preceding = elseBlock.slice(Math.max(0, cm.index - 20), cm.index);
    found.push({
      callIdx: cm.index,
      argsEntries: objLiteral ? objectLiteralEntries(objLiteral) : {},
      awaited: /\bawait\s*$/.test(preceding)
    });
  }
  return found;
}

// KNOWN LIMITS OF F4/F5, documented rather than chased (rs-d2, after a
// second Grok xhigh round constructed both by hand): F4's `awaited` check
// looks at the 20 chars immediately before the call, so an unawaited async
// IIFE wrapper around the real call — `(async () => { await
// qcAndStampVideoAd(...) })();` — reads as awaited from the inside while the
// OUTER statement races the terminal $in write below it. F5 matches the
// IDENTIFIER `adFinal` appearing anywhere in the "ad:" text, so
// `ad: adFinal && ad` or `ad: { adFinal }` (a nested, unused property, not a
// spread) both satisfy the regex while the object actually handed to
// qcAndStampVideoAd is the stale `ad` param. Both are adversarial
// constructions, not shapes a normal edit produces — unlike the F6/F7 holes
// this round fixed, which were accident-shaped (a missing argument, a
// "harmonising" edit). Patching a source-text check against a determined
// author is a game with no fixed point, proven three times already tonight
// in a different file's section E; the same call was made here rather than
// starting a fourth round on F4/F5. If either shape is ever seen for real,
// this is the place to reconsider.
check('F4 each REAL qcAndStampVideoAd call is awaited and passes both `ad` and `deliveredUrl`', () => {
  for (const { elseBlock, elseOffset } of brandDocArms) {
    if (!elseBlock) continue; // already failed by F2
    const calls = findRealQcCalls(elseBlock, elseOffset);
    assert.strictEqual(calls.length, 1, `expected exactly 1 real call in the else-arm, found ${calls.length}`);
    const call = calls[0];
    assert.ok(call.awaited,
      'qcAndStampVideoAd must be awaited — an un-awaited call races the terminal $in write below it, ' +
      'which can promote status to draft before the QC verdict has even been computed, let alone persisted.');
    assert.ok('ad' in call.argsEntries, `call is missing "ad:": ${JSON.stringify(call.argsEntries)}`);
    assert.ok('deliveredUrl' in call.argsEntries, `call is missing "deliveredUrl:": ${JSON.stringify(call.argsEntries)}`);
    // VALUE, not just key. `deliveredUrl: ad.veoVideoUrl` (the stale
    // renderVideo(ad) param — empty/undefined on a fresh master or derive
    // before its own inherit/persist write ever ran) satisfies the key-only
    // check above while pointing at nothing. The two legitimate sources are
    // master.veoVideoUrl (derive, the inherited sibling plate) and
    // veoResult.videoUrl (master, this call's own fresh Omni result) — never
    // a bare `ad.` or `adFinal.` field read.
    const dUrl = call.argsEntries.deliveredUrl;
    assert.ok(!/\b(ad|adFinal)\.\w+/.test(dUrl),
      `deliveredUrl must not read off the stale ad/adFinal object — found: ${dUrl}`);
    assert.match(dUrl, /^(master\.veoVideoUrl|veoResult\.videoUrl)$/,
      `deliveredUrl must be exactly master.veoVideoUrl (derive) or veoResult.videoUrl (master), got: ${dUrl}`);
  }
});

check('F5 [FRESH READ] each call passes a re-read Ad doc (adFinal), never the stale renderVideo(ad) param', () => {
  // The master path's Ad.updateOne (just above Stage 3) writes
  // veoReferenceImages — the exact seed URLs actually sent to the model —
  // which runVideoVisionQcForAd reads. Passing the original in-memory `ad`
  // param there would silently fall through to a CatalogProduct hero photo
  // that may not be the frame that generated the delivered clip, flipping
  // the verdict in either direction. `adFinal` (Ad.findById(adId), read
  // AFTER that write) is the only value in scope that reflects it.
  //
  // The `ad:` value is checked for the IDENTIFIER `adFinal` appearing
  // anywhere in it — accepts both `ad: adFinal` (master) and
  // `ad: { ...adFinal, veoReferenceImages: ... }` (derive, which additionally
  // overrides the reference-image list from `master` — see F6's neighbour
  // check and the inline comment at the real call site for why: the inherit
  // -write never copies veoReferenceImages onto the derive row itself, so
  // adFinal alone would still compare against the wrong reference image).
  // A bare `ad: ad` (the stale param) contains no `adFinal` substring at all
  // and is correctly rejected.
  for (const { elseBlock, elseOffset } of brandDocArms) {
    if (!elseBlock) continue;
    const calls = findRealQcCalls(elseBlock, elseOffset);
    if (!calls.length) continue; // already failed by F4
    const adValue = calls[0].argsEntries.ad || '';
    assert.match(adValue, /\badFinal\b/,
      `qcAndStampVideoAd's "ad" value must reference adFinal, not the stale renderVideo(ad) param: ${adValue}`);
  }
  // ORDERING: adFinal's declaration must appear textually AFTER the derive
  // inherit-write / master persist-write that populates the fields QC
  // depends on, not before it (a findById moved above that write, or a
  // `const adFinal = ad` alias, would satisfy the identifier check above
  // while reading stale data). Scoped PER ARM via ifIndex — pairing globally
  // nearest-before would let the master's read match against the DERIVE
  // branch's write (textually earlier in the same function, but a different
  // code path entirely) if the master's own read were hoisted too far up.
  const declMatches = [...renderVideoBody.matchAll(/const\s+adFinal\s*=\s*await\s+Ad\.findById\s*\(\s*adId\s*\)\s*\.lean\s*\(\s*\)/g)]
    .filter((m) => !isInsideAString(renderVideoStrings, m.index));
  assert.strictEqual(declMatches.length, 2,
    `expected exactly 2 "const adFinal = await Ad.findById(adId).lean()" declarations (derive + master), found ${declMatches.length}`);
  const writeMarkers = [...renderVideoBody.matchAll(/titlingResumeState:\s*['"]claimed['"]/g)]
    .filter((m) => !isInsideAString(renderVideoStrings, m.index));
  assert.strictEqual(writeMarkers.length, 2,
    `expected exactly 2 titlingResumeState:'claimed' persist-writes (derive inherit + master persist), found ${writeMarkers.length}`);
  for (const arm of brandDocArms) {
    const priorWrite = writeMarkers.filter((w) => w.index < arm.ifIndex).pop();
    const priorDecl = declMatches.filter((d) => d.index < arm.ifIndex).pop();
    assert.ok(priorWrite,
      `no titlingResumeState:'claimed' persist-write found before the if(brandDoc) at offset ${arm.ifIndex}`);
    assert.ok(priorDecl,
      `no adFinal declaration found before the if(brandDoc) at offset ${arm.ifIndex}`);
    assert.ok(priorDecl.index > priorWrite.index,
      `this branch's adFinal was read (offset ${priorDecl.index}) BEFORE its own persist-write ` +
      `(offset ${priorWrite.index}) — a stale read, exactly the bug the hoist exists to fix.`);
  }
});

check('F6 [NO STEAL] each real call is wrapped in the SAME startAdHeartbeat/beat.stop() as the brand arm', () => {
  // Vision QC is a real vision-LLM call (multiple minutes in a real retry
  // scenario) and this row is still status:'rendering' with a live Omni
  // receipt. Without a beat, backend's bootRecoveryService (RESUME_STALE_MIN)
  // can steal it mid-QC exactly as it could a live titling render — the
  // whole reason startAdHeartbeat exists in this file at all. Missing this
  // was the more serious of the two holes an adversarial (Grok xhigh) pass
  // found in the first draft of this fix.
  for (const { elseBlock, elseOffset } of brandDocArms) {
    if (!elseBlock) continue;
    const calls = findRealQcCalls(elseBlock, elseOffset);
    if (!calls.length) continue; // already failed by F4
    const callIdx = calls[0].callIdx;
    const BEAT_START_RE = /const\s+beat\s*=\s*startAdHeartbeat\s*\(/g;
    let beatStart = null, bm;
    while ((bm = BEAT_START_RE.exec(elseBlock))) {
      if (bm.index < callIdx && !isInsideAString(renderVideoStrings, elseOffset + bm.index)) beatStart = bm;
    }
    assert.ok(beatStart,
      'no REAL (non-string-decoy) "const beat = startAdHeartbeat(" found before the qcAndStampVideoAd call');
    // THE ARGUMENT, not just the call shape. startAdHeartbeat() or
    // startAdHeartbeat(null) matches the token pattern above but beats
    // nothing — Ad.updateOne's filter is { _id: undefined, ... }, which
    // matches no document, so bootRecovery still steals the row mid-QC after
    // RESUME_STALE_MIN. A plausible typo, not just an adversarial construct
    // (found in a second Grok xhigh round after the first round only
    // checked call/stop presence).
    const openParen = elseBlock.indexOf('(', beatStart.index + beatStart[0].length - 1);
    const beatArgs = (balanced(elseBlock, openParen, '(', ')') || '').slice(1, -1).trim();
    assert.strictEqual(beatArgs, 'adId',
      `startAdHeartbeat must be called with exactly "adId", got: "${beatArgs}" — an empty, null, or wrong ` +
      'argument beats nothing and leaves the row unprotected from a bootRecovery steal.');
    const BEAT_STOP_RE = /beat\.stop\s*\(\s*\)/g;
    let beatStopFound = false, sm;
    while ((sm = BEAT_STOP_RE.exec(elseBlock))) {
      if (sm.index > callIdx && !isInsideAString(renderVideoStrings, elseOffset + sm.index)) { beatStopFound = true; break; }
    }
    assert.ok(beatStopFound, 'no REAL (non-string-decoy) "beat.stop()" found after the qcAndStampVideoAd call');
  }
});

check('F7 [DERIVE REFERENCE FIDELITY] the derive arm merges the master\'s veoReferenceImages into the QC payload', () => {
  // The derive inherit-write (above, in the if/else's shared setup) copies
  // veoVideoUrl/veoAspectRatio/veoModel/renderUrl onto the derived row but
  // deliberately NOT veoReferenceImages — the derived row was never itself
  // submitted to Omni, so it has no seed list of its own. Passing plain
  // adFinal (as the master arm correctly does — its OWN persist-write DOES
  // write veoReferenceImages from veoResult) would make
  // runVideoVisionQcForAd fall through to a CatalogProduct hero photo that
  // may not be the frame that generated this clip, producing a FALSE
  // product-fidelity failure on a perfectly good derive. Found in
  // adversarial (Grok xhigh) review of the first draft, which called plain
  // `ad: adFinal` on derive "not the same *comparison* as the master arm."
  // brandDocArms[0] is the derive arm (renderVideo processes derive before
  // master, and there are exactly 2 — pinned by F1).
  const derive = brandDocArms[0];
  const calls = findRealQcCalls(derive.elseBlock, derive.elseOffset);
  if (!calls.length) return; // already failed by F4
  const adValue = (calls[0].argsEntries.ad || '').trim();
  assert.ok(adValue.startsWith('{') && adValue.endsWith('}'),
    `the derive arm's "ad" value must be an object literal (to carry the master-sourced overrides), got: ${adValue}`);
  const adEntries = objectLiteralEntries(adValue);
  // PIN THE VALUE, not a substring of the whole "ad:" text. A prior version
  // of this check did `assert.match(adValue, /master\.veoReferenceImages/)`,
  // which a THIRD round of adversarial review (Grok xhigh) showed stays
  // green even when the expression is broken — e.g. the "harmonised",
  // defensive-looking `adFinal.veoReferenceImages || master.veoReferenceImages
  // || []` contains the substring `master.veoReferenceImages` but NEVER
  // evaluates it, because Ad.veoReferenceImages defaults to `[]`
  // (models/Ad.js) and an empty array is truthy in JS — adFinal's stored `[]`
  // wins every time. Parsing the "ad:" object literal's own entries and
  // asserting the EXACT expression closes that: only `master.x || []` (no
  // `adFinal.x ||` in front) can satisfy it.
  assert.strictEqual(adEntries.veoReferenceImages, 'master.veoReferenceImages || []',
    `veoReferenceImages must be exactly "master.veoReferenceImages || []" — no adFinal fallback in front of ` +
    `it (adFinal's stored default is [], which is TRUTHY, so any "adFinal.x || master.x" shape would never ` +
    `reach master at all): got "${adEntries.veoReferenceImages}"`);
  // videoDurationSec must fall back to adFinal's own value, not straight to
  // null, if master's happens to be unset — Ad.videoDurationSec is
  // operator/wizard-stamped per ad per format, so master-null-while-derive
  // -set is reachable. `master.videoDurationSec || null` would silently
  // discard a real duration and force the QC's hardcoded 8s fallback, which
  // shifts every sampled frame timestamp. Found in a second round of
  // adversarial review (rs-d2), after the first round's veoReferenceImages
  // fix already landed. UNLIKE veoReferenceImages above, Ad.videoDurationSec
  // defaults to null (falsy), so master-first-then-adFinal is the CORRECT
  // and only safe order here — the two fields are NOT interchangeable
  // despite sitting next to each other with a similar shape; see the
  // renderer.js comment at this exact call site for why.
  assert.strictEqual(adEntries.videoDurationSec, "master.videoDurationSec || adFinal.videoDurationSec || null",
    `videoDurationSec must be exactly "master.videoDurationSec || adFinal.videoDurationSec || null": ` +
    `got "${adEntries.videoDurationSec}"`);
});

// ── E. THE UPSTREAM WRITER — now a BEHAVIOURAL test, not a source scan ────
// Everything above opens ONLY renderer.js. Section E used to open
// brandScriptExecutor.js as text too and pin the Object.assign merge order
// by regex — hardened across three rounds against decoys and a resurrecting
// assignment. RETIRED 2026-08-24 after an adversarial (Grok xhigh) pass on
// the backend's identical copy found it still went green on six real shapes
// that clobber the verdict just the same: findByIdAndUpdate,
// Ad.collection.updateOne (bypasses Mongoose), a $set built as a variable, a
// computed key, a backtick-quoted status, and an assignment sitting after
// the merge in a spot the scan didn't cover. Each round closed the shapes
// we'd thought of and left the ones we hadn't — an unbounded game against
// JS/Mongoose syntax. Replaced with a test that calls the REAL
// uploadRenderAndStamp (Cloudinary/vision-QC/Ad stubbed via the same
// require-cache convention scripts/verifyAdVisionQcSurfacing.js's own
// F-section already established), forces a genuine QC failure, and asserts
// the ACTUAL Ad.updateOne payload it produces. That is immune to all six
// shapes at once, and to any future one, because it never reads source.
console.log('\n── E: the upstream QC-verdict writer cannot be silently defeated (behavioural) ──');

(async () => {
  const cloudinaryPath = require.resolve(path.join(ROOT, 'src/services/cloudinaryService.js'));
  const originalCloudinary = require.cache[cloudinaryPath];
  require.cache[cloudinaryPath] = {
    id: cloudinaryPath, filename: cloudinaryPath, loaded: true,
    exports: {
      uploadFileToCloudinary: async () => ({ secure_url: 'https://res.cloudinary.com/x/video/upload/v1/fake.mp4' })
    }
  };

  const qcPath = require.resolve(path.join(ROOT, 'src/services/adVisionQcService.js'));
  const originalQc = require.cache[qcPath];
  const fakeVerdict = {
    passed: false, skipped: false, disabled: false, finalAttempt: 1,
    attempts: [{
      attempt: 1, pass: false, categories: {}, findings: ['garbled logo'],
      summary: 'hallucinated colourway', renderUrl: 'https://x/v.mp4', discarded: false
    }]
  };
  require.cache[qcPath] = {
    id: qcPath, filename: qcPath, loaded: true,
    exports: {
      resolveVideoEnabled: async () => true,
      warnQcDisabledOnce: () => {},
      buildAppPreviewUrl: () => 'https://app.example/preview',
      runVideoPostRenderQc: async () => ({ ok: true, skipped: false, passed: false, visionQc: fakeVerdict }),
      alertQcFailure: () => 'FAKE_SLACK_DETAIL_TEXT_FOR_TEST',
      noteQcFailToRunFeed: () => {},
      noteQcPassToRunFeed: () => {},
      alertQcSkipped: () => {},
      buildPersistedVerdict: (args) => args,
      buildSkippedVerdict: (reason) => ({ skipped: true, reason })
    }
  };

  const adStagePath = require.resolve(path.join(ROOT, 'src/services/adStage.js'));
  const originalAdStage = require.cache[adStagePath];
  require.cache[adStagePath] = {
    id: adStagePath, filename: adStagePath, loaded: true,
    exports: { adStage: () => {}, noteRenderIssue: () => {} }
  };

  // Covers every Mongoose write method AND the raw collection bypass, so a
  // future code change is captured cleanly regardless of which one it uses
  // — deliberately not locked to updateOne only.
  const adModelPath = require.resolve(path.join(ROOT, 'src/models/Ad.js'));
  const originalAdModel = require.cache[adModelPath];
  const updateCalls = [];
  const recordWrite = (filter, update) => {
    updateCalls.push({ filter, update });
    return { matchedCount: 1, modifiedCount: 1 };
  };
  require.cache[adModelPath] = {
    id: adModelPath, filename: adModelPath, loaded: true,
    exports: {
      updateOne: async (filter, update) => recordWrite(filter, update),
      findOneAndUpdate: async (filter, update) => { recordWrite(filter, update); return null; },
      findByIdAndUpdate: async (id, update) => { recordWrite({ _id: id }, update); return null; },
      collection: { updateOne: async (filter, update) => recordWrite(filter, update) }
    }
  };

  const bsePath = require.resolve(path.join(ROOT, 'src/services/brandScriptExecutor.js'));
  const originalBse = require.cache[bsePath];
  delete require.cache[bsePath];
  try {
    const freshBse = require(path.join(ROOT, 'src/services/brandScriptExecutor.js'));

    check('E1 uploadRenderAndStamp() is exported for direct behavioural testing', () => {
      assert.strictEqual(typeof freshBse.uploadRenderAndStamp, 'function');
    });

    const result = await freshBse.uploadRenderAndStamp({
      ad: { _id: '507f1f77bcf86cd799439099', veoReferenceImages: ['https://x/orig.png'], campaignRunIds: [] },
      // Neither path is read for real: uploadFileToCloudinary is stubbed
      // above (never touches finalPath), and tempDir cleanup uses
      // fs.promises.rm(..., { force: true }), which is silent on ENOENT.
      finalPath: '/tmp/verifyVideoQcVerdictSurvives-does-not-exist.mp4',
      tempDir:   '/tmp/verifyVideoQcVerdictSurvives-does-not-exist-tmp',
      timings:   {}
    });

    check('E2 [THE REAL MECHANISM, BEHAVIOURAL] a real QC failure persists status:\'failed\', not draft', () => {
      assert.strictEqual(updateCalls.length, 1, `expected exactly one Ad.updateOne call, saw ${updateCalls.length}`);
      const set = updateCalls[0].update.$set || updateCalls[0].update;
      assert.strictEqual(set.status, 'failed',
        'a real (non-skipped/disabled) vision-QC failure must persist status:\'failed\'. This assertion ' +
        'reads the ACTUAL persisted value, so it does not matter what internal shape produced the write — ' +
        'merge order, a later resurrecting assignment, findByIdAndUpdate instead of updateOne, a raw ' +
        'Ad.collection.updateOne bypass, a computed key, a backtick, or a $set built as a variable all ' +
        'either produce the right payload or they do not, and this is what checks which.');
      assert.ok(set.renderError, 'must include a renderError so the operator sees why');
      assert.strictEqual(set.renderError.charged, true, 'the master was already billed — must not read as an unbilled infra failure');
      assert.strictEqual(set.visionQc?.failureDetail, 'FAKE_SLACK_DETAIL_TEXT_FOR_TEST',
        'must stamp the same failureDetail text alertQcFailure sent to Slack');
    });

    check('E3 uploadRenderAndStamp still returns the delivered renderUrl on a QC failure (asset never discarded)', () => {
      assert.strictEqual(result.renderUrl, 'https://res.cloudinary.com/x/video/upload/v1/fake.mp4');
    });

    // POSITIVE CONTROL — a genuine QC PASS must leave status as 'draft', not
    // 'failed'. Without this, a hypothetical bug that always stamped
    // 'failed' regardless of the verdict would pass every check above.
    require.cache[qcPath].exports.runVideoPostRenderQc = async () => ({
      ok: true, skipped: false, passed: true,
      visionQc: { passed: true, skipped: false, disabled: false, finalAttempt: 1, attempts: [] }
    });
    delete require.cache[bsePath];
    const passFreshBse = require(path.join(ROOT, 'src/services/brandScriptExecutor.js'));
    updateCalls.length = 0;
    const passResult = await passFreshBse.uploadRenderAndStamp({
      ad: { _id: '507f1f77bcf86cd799439098', veoReferenceImages: ['https://x/orig.png'], campaignRunIds: [] },
      finalPath: '/tmp/verifyVideoQcVerdictSurvives-does-not-exist-2.mp4',
      tempDir:   '/tmp/verifyVideoQcVerdictSurvives-does-not-exist-tmp-2',
      timings:   {}
    });
    check('E4 [POSITIVE CONTROL] a genuine QC pass leaves status as \'draft\'', () => {
      assert.strictEqual(updateCalls.length, 1, `expected exactly one Ad.updateOne call, saw ${updateCalls.length}`);
      const set = updateCalls[0].update.$set || updateCalls[0].update;
      assert.strictEqual(set.status, 'draft',
        'a genuine pass must not flip status to failed — if this fails while E2 above also passes, ' +
        'something stamps failed unconditionally rather than reading the real verdict.');
      assert.strictEqual(set.renderError, undefined, 'no renderError on a genuine pass');
      assert.strictEqual(passResult.renderUrl, 'https://res.cloudinary.com/x/video/upload/v1/fake.mp4');
    });
  } finally {
    if (originalCloudinary) require.cache[cloudinaryPath] = originalCloudinary; else delete require.cache[cloudinaryPath];
    if (originalQc) require.cache[qcPath] = originalQc; else delete require.cache[qcPath];
    if (originalAdStage) require.cache[adStagePath] = originalAdStage; else delete require.cache[adStagePath];
    if (originalAdModel) require.cache[adModelPath] = originalAdModel; else delete require.cache[adModelPath];
    if (originalBse) require.cache[bsePath] = originalBse; else delete require.cache[bsePath];
    delete require.cache[bsePath];
  }

  console.log('');
  if (failures) {
    console.log(`❌ verifyVideoQcVerdictSurvives: ${failures} FAILED, ${passes} passed`);
    console.log('\nOn UNFIXED code the expected reds are B1 (bare {_id} filters), C1-C4');
    console.log('(no fallback handler) and D1/D2 (hardcoded \'succeeded\').');
    process.exit(1);
  }
  console.log(`✅ verifyVideoQcVerdictSurvives: all ${passes} checks passed`);
})().catch((err) => {
  console.error('verifyVideoQcVerdictSurvives crashed:', err);
  process.exit(1);
});
