'use strict';
// Pins the moderation-fast-fail fix in atlasImageService.submitAndPoll.
//
// PROBLEM. Atlas returns a safety-filter fail like:
//   { code: 500, msg: "task failed",
//     data: { status: "failed",
//       error: { message: "Your request was rejected by the safety system... safety_violations=[sexual]" } } }
// The poll loop's `apiMsg` used to read `poll.data?.msg || poll.data?.message`
// only — "task failed", which matches NO regex in atlasErrorPolicy.
// moderationBlocked's match(). classify() therefore fell through to
// `predictionFailed` (action:'retry', refunded), the outer submitAndPollWithRetry
// loop resubmitted with the SAME prompt, Atlas rejected identically, and the
// cycle burned ~60-90s of pointless retry backoff PER moderation-blocked ad.
//
// MEASURED 2026-08-25 on run_1787684512013_e5feaf12 (Pelagic "Key West Top"
// swimwear, 9 ads): 4 ads hit safety-filter false-positives, each retried
// 2-3 times with 15-45s backoff before finally settling as moderationBlocked
// (only when Atlas's later error text was verbose enough to satisfy the
// regex on its own). Total wall clock: 32 minutes for a 9-ad run.
//
// FIX. Read the INNER error message too — data.data.error(.message) — and
// concatenate with the envelope msg before classify(). The regex then
// matches "safety system" on the FIRST failure and moderationBlocked
// (action:'give-up', maxAttempts:1) fires immediately.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const failures = [];
const passes = [];

function check(name, cond, detail) {
  if (cond) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── A. structural: the fix is in the poll loop ────────────────────────────
const svcPath = path.join(REPO, 'src', 'services', 'atlasImageService.js');
const svc = fs.readFileSync(svcPath, 'utf8');

check('A1 poll loop reads data.data.error for classify()',
  /const\s+innerErr\s*=\s*poll\.data\?\.data\?\.error\b/.test(svc),
  'must extract the inner error before classify() so moderationBlocked matches on first attempt');

check('A2 poll loop handles data.error as string OR object.message',
  /typeof\s+innerErr\s*===\s*['"]string['"][\s\S]{0,300}?innerErr\.message/.test(svc),
  'Atlas has been observed emitting data.error as both a string and {message:...} — handle both');

check('A3 apiMsg concatenates envelope + inner, not either/or',
  /const\s+apiMsg\s*=\s*\[\s*poll\.data\?\.msg\s*,\s*poll\.data\?\.message\s*,\s*innerMsg\s*\]/.test(svc),
  'either/or would lose the safety text when the envelope has ANY generic msg');

check('A4 apiMsg filters empty strings before join',
  /\.filter\(\([^)]+\)\s*=>\s*typeof[^)]*string[^)]*length\s*>\s*0\)/.test(svc));

// ── B. moderationBlocked policy stays terminal ────────────────────────────
const policyPath = path.join(REPO, 'src', 'services', 'atlasErrorPolicy.js');
const policy = fs.readFileSync(policyPath, 'utf8');

function matchingBrace(src, startIdx) {
  if (src[startIdx] !== '{') return -1;
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function stripJsComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const mbDecl = /moderationBlocked:\s*\{/.exec(policy);
const mbClose = mbDecl ? matchingBrace(policy, mbDecl.index + mbDecl[0].length - 1) : -1;
const mbCode = (mbDecl && mbClose >= 0)
  ? stripJsComments(policy.slice(mbDecl.index + mbDecl[0].length - 1, mbClose + 1))
  : '';

check('B1 moderationBlocked has action:give-up (no retries)',
  /(?:^|[,\n])\s*action:\s*['"]give-up['"]/.test(mbCode),
  'a retryable action would negate the fast-fail — the whole point is no retry');
check('B2 moderationBlocked maxAttempts:1',
  /(?:^|[,\n])\s*maxAttempts:\s*1\b/.test(mbCode));
check('B3 moderationBlocked outranks predictionFailed in PRECEDENCE',
  () => {
    const arr = policy.match(/PRECEDENCE\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
    if (!arr) return false;
    const mIdx = arr[1].search(/['"]moderationBlocked['"]/);
    const pIdx = arr[1].search(/['"]predictionFailed['"]/);
    return mIdx >= 0 && pIdx >= 0 && mIdx < pIdx;
  },
  'a failed prediction WITH safety text must classify as moderationBlocked, not predictionFailed');

// ── C. behavioral: run the real classify() against a swimwear-shaped body ─
const { classify } = require(policyPath);

// Shape 1 — inner error as an OBJECT with .message.
const shape1 = {
  http: 500,
  code: 500,
  msg: 'task failed',        // envelope-level: matches NO moderation regex
  predictionStatus: 'failed',
  hasOutputs: false,
  nsfw: null,
};
check('C1 [PRE-FIX BEHAVIOR] envelope-only msg mis-classifies as predictionFailed',
  classify(shape1).name === 'predictionFailed',
  'sanity: without the fix, this is exactly the misclassification that caused the retry storm');

// The REAL fix — classify with the CONCATENATED msg (what the poll loop now
// builds). This proves moderationBlocked fires when the inner error text
// reaches classify(), regardless of what shape data.error had.
const shapeFixed_object = {
  ...shape1,
  msg: 'task failed | recv from gpt image edit api failed. http_code:400, message:Your request was rejected by the safety system. safety_violations=[sexual]. code:moderation_blocked',
};
check('C2 [POST-FIX] concatenated msg with inner OBJECT.message classifies as moderationBlocked',
  classify(shapeFixed_object).name === 'moderationBlocked');

// Shape 2 — inner error as a bare STRING (also observed).
const shapeFixed_string = {
  ...shape1,
  msg: 'task failed | Input Prompt violates policy',
};
check('C3 [POST-FIX] concatenated msg with inner STRING classifies as moderationBlocked',
  classify(shapeFixed_string).name === 'moderationBlocked');

// Sanity: a real predictionFailed (no safety text anywhere) stays predictionFailed.
const shape_realFail = {
  http: 500, code: 500,
  msg: 'task failed | model backend crashed, no output',
  predictionStatus: 'failed', hasOutputs: false, nsfw: null,
};
check('C4 real prediction failures (no safety text) STAY predictionFailed → retry',
  classify(shape_realFail).name === 'predictionFailed',
  'a genuine transient model crash must still retry — the fix must not over-fire');

// ── D. money invariant preserved ──────────────────────────────────────────
const policyOut = classify(shapeFixed_object);
check('D1 moderationBlocked returns charged:false',
  policyOut.charged === false,
  'safety-filter fails are refunded per Atlas policy — must reflect that so no phantom charge appears');
check('D2 moderationBlocked returns terminal:true',
  policyOut.terminal === true,
  'without terminal:true the outer retry loop would still fire');
check('D3 moderationBlocked returns retryable:false',
  policyOut.retryable === false,
  'without retryable:false mayResubmit could allow a fourth attempt');

// ── report
console.log(`\nverifyModerationFastFail: ${passes.length} pass, ${failures.length} fail`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ moderation-blocked fails now short-circuit on first poll — no more 60-90s retry burn per swimwear ad');
