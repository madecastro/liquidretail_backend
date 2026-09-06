#!/usr/bin/env node
'use strict';
//
// PORTED from liquidretail_backend/scripts/verifySubmitGuard.js
// (pre-2026-08-24 snapshot) into liquidretail_adgen. Path adjustment only
// (../services/atlasVideoService -> ../src/services/atlasVideoService);
// every assertion below is unchanged from the backend original. See that
// file's history for the regression (A-group) this harness was written
// against.
//
// verifySubmitGuard — guards the ONE decision that can double-charge us.
//
// Atlas generation POSTs are billable. submitGeneration may only repeat a POST
// when the failure response PROVES the request was rejected before any
// generation began. This harness drives submitRetryDecision() directly, so no
// axios mocking is involved and the assertions are about the real predicate the
// production catch block calls.
//
// Pure + offline: no DB, no network, no API key. Safe to run anywhere.
//   node scripts/verifySubmitGuard.js
//
// Cost model that decides every expectation below:
//   replaying a POST that already billed  = money gone, unrecoverable
//   declining to replay a genuine 429     = a failed ad a human can regenerate
// So every ambiguous case must resolve to "do not replay".

const {
  isRateLimit, isDefinite429, submitRetryDecision, summarizeAxiosError
} = require('../src/services/atlasVideoService');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
}

/** Build the axios-error shape summarizeAxiosError actually receives. */
function axiosErr({ status, data, message }) {
  const e = new Error(message || `Request failed with status code ${status}`);
  if (status !== undefined || data !== undefined) e.response = { status, data };
  return e;
}
const decide = (errLike, attempt = 1, maxAttempts = 4) =>
  submitRetryDecision(summarizeAxiosError(errLike), attempt, maxAttempts);

// ── A. The regression that motivated this file ────────────────────────
// A 429-PREFIXED longer integer is not a 429. Without a digit boundary in the
// regex, `code: 42901` matched and the billable POST was replayed for an error
// that had nothing to do with rate limiting. Found by adversarial review.
check('A1 code: 42901 is not a rate limit',
  isDefinite429(summarizeAxiosError(axiosErr({ status: 500, data: { error: 'bad field code: 42901' } }))), false);
check('A2 code: 42901 does not replay the POST',
  decide(axiosErr({ status: 500, data: { error: 'bad field code: 42901' } })), 'throw-other');
check('A3 status: 42917 is not a rate limit',
  isDefinite429(summarizeAxiosError(axiosErr({ status: 500, data: { error: 'status: 42917 unknown' } }))), false);
check('A4 http status code: 42999 is not a rate limit',
  isDefinite429(summarizeAxiosError(axiosErr({ status: 502, data: { error: 'http status code: 42999' } }))), false);
check('A5 the same guard is in isRateLimit (predicates must agree on "429")',
  isRateLimit(summarizeAxiosError(axiosErr({ status: 500, data: { error: 'bad field code: 42901' } }))), false);

// ── B. Genuine rate limits still retry ────────────────────────────────
// The documented Atlas envelope: an upstream 429 wrapped in an Atlas 500.
const ATLAS_WRAPPED_429 = { error: 'unexpected http status code: 429, body: {"code":429,"message":"rate limited"}' };
check('B1 documented Atlas-wrapped 429 is definite',
  isDefinite429(summarizeAxiosError(axiosErr({ status: 500, data: ATLAS_WRAPPED_429 }))), true);
check('B2 documented Atlas-wrapped 429 retries',
  decide(axiosErr({ status: 500, data: ATLAS_WRAPPED_429 })), 'retry');
check('B3 bare HTTP 429 retries',
  decide(axiosErr({ status: 429, data: { error: 'Too Many Requests' } })), 'retry');
check('B4 code: 429 exactly (trailing brace) retries',
  decide(axiosErr({ status: 500, data: { error: '{"code":429}' } })), 'retry');
check('B5 attempts exhausted stops replaying',
  decide(axiosErr({ status: 429, data: {} }), 4, 4), 'throw-429');
check('B6 last attempt before the cap still retries',
  decide(axiosErr({ status: 429, data: {} }), 3, 4), 'retry');

// ── C. Rate-limit-ish shapes must NOT replay ───────────────────────────
// The ONLY property that matters here is "does not replay". Whether a case lands
// in 'throw-maybe-429' or 'throw-other' is a logging distinction — both refuse the
// second POST. The expectations differ per row because the two predicates have
// deliberately different reach:
//   C1/C2 — isRateLimit matches the prose, isDefinite429 does not ⇒ throw-maybe-429
//   C3/C4 — NEITHER matches, so they fall through ⇒ throw-other
// C3 and C4 are the interesting ones: `\bstatus\b` cannot match "statusCode"
// (no word boundary before the capital C), and "HTTP 429" has no `:`/`=`
// separator. So these genuine-looking rate limits are invisible to BOTH
// predicates. Safe, but it means the "possible rate-limit" log line will not fire
// for them — worth knowing when reading production logs.
for (const [label, body, expected] of [
  ['C1 "rate limit" prose',      { error: 'upstream rate limit reached' },  'throw-maybe-429'],
  ['C2 "too many requests"',     { error: 'too many requests, slow down' }, 'throw-maybe-429'],
  ['C3 statusCode (not status)', { error: '{"statusCode":429}' },           'throw-other'],
  ['C4 bare "HTTP 429"',         { error: 'upstream said HTTP 429' },       'throw-other'],
]) {
  check(`${label} is not DEFINITE`, isDefinite429(summarizeAxiosError(axiosErr({ status: 500, data: body }))), false);
  check(`${label} does not replay`, decide(axiosErr({ status: 500, data: body })), expected);
}

// ── D. A POST that may have LANDED must never replay ──────────────────
// No response object at all => we cannot know whether the server received it.
check('D1 client timeout does not replay',
  decide(axiosErr({ message: 'timeout of 60000ms exceeded' })), 'throw-other');
check('D2 ECONNRESET does not replay',
  decide(axiosErr({ message: 'read ECONNRESET' })), 'throw-other');
check('D3 socket hang up does not replay',
  decide(axiosErr({ message: 'socket hang up' })), 'throw-other');
check('D4 generic 500 does not replay',
  decide(axiosErr({ status: 500, data: { error: 'internal error' } })), 'throw-other');
check('D5 400 validation error does not replay',
  decide(axiosErr({ status: 400, data: { error: 'aspect_ratio invalid' } })), 'throw-other');
check('D6 3xx (redirect, with maxRedirects: 0) does not replay',
  decide(axiosErr({ status: 308, data: '' })), 'throw-other');

// ── E. Degenerate inputs ──────────────────────────────────────────────
check('E1 null summary is not a rate limit', isDefinite429(null), false);
check('E2 undefined summary is not a rate limit', isDefinite429(undefined), false);
check('E3 empty summary does not replay', submitRetryDecision({}, 1, 4), 'throw-other');
check('E4 null summary does not replay', submitRetryDecision(null, 1, 4), 'throw-other');

// ── F. An operator prompt is attacker-adjacent input ──────────────────
// Operators type raw prompts. If Atlas ever echoes the request body into an
// error envelope, prompt text must not be able to buy itself a replay. The
// digit-boundary guard does not help here (the text is an exact "code: 429"),
// so this documents the residual risk rather than claiming it is closed:
// an echoed EXACT marker is indistinguishable from a real one.
const echoed = { error: 'invalid request: prompt="make it pop, code: 429 style"' };
check('F1 an echoed EXACT 429 marker is (knowingly) treated as definite',
  isDefinite429(summarizeAxiosError(axiosErr({ status: 400, data: echoed }))), true);
// ...but a near-miss in prompt text is safely rejected:
check('F2 an echoed 429-prefixed number is rejected',
  isDefinite429(summarizeAxiosError(axiosErr({ status: 400, data: { error: 'prompt="ref 4290"' } }))), false);

// ── Report ────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifySubmitGuard: ${failures.length} of ${total} checks FAILED\n`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  console.error('A failure here means a billable POST may be repeated. Do not ship.\n');
  process.exit(1);
}
console.log(`✅ verifySubmitGuard: ${total}/${total} checks passed`);
console.log('   billable POST is replayed ONLY on a structurally proven 429.');
console.log('   NOTE F1 documents a residual risk that is open by design:');
console.log('   an echoed exact "code: 429" cannot be distinguished from a real one.');
