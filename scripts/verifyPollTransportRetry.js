#!/usr/bin/env node
'use strict';
/**
 * Verify the poll-time transport-failure retry fix (2026-08-05).
 * No DB, no network, no API key.
 *
 * THE INCIDENT THIS EXISTS TO CATCH: a real production submit (brand
 * "Pelagic Gear", model openai/gpt-image-2/edit) died on its FIRST status
 * poll, 3-4s after a successful billable submit, on a bare Cloudflare 502
 * ("Bad gateway") with no JSON body at all. classify() correctly has no
 * policy for that shape (nothing to match), so it fell to the non-retryable
 * FALLBACK and the render was thrown away as failed — even though polling an
 * already-submitted prediction is an idempotent GET and carries zero
 * resubmission/double-charge risk. isPollTransportFailure() (in
 * services/atlasErrorPolicy.js) is the narrow fix: it returns true ONLY when
 * a poll response carries no Atlas signal whatsoever, leaving every
 * classify()-recognized case (a real {code,...} object, a definitive failed
 * verdict, moderation/balance/429) exactly as terminal or retryable as today.
 *
 * Run: node scripts/verifyPollTransportRetry.js
 */

const fs = require('fs');
const path = require('path');
const { isPollTransportFailure, classify } = require('../services/atlasErrorPolicy');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Section A — pure behavioral table on isPollTransportFailure ──────────

console.log('\nPOLL TRANSPORT RETRY\n');

check(
  'A1 [LIVE] the exact production 502 shape — HTTP 502, no code, no data object -> true',
  isPollTransportFailure({ httpStatus: 502, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === true
);
check(
  'A2 a bare 503 gateway page with no JSON body -> true',
  isPollTransportFailure({ httpStatus: 503, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === true
);
check(
  'A3 a bare 504 gateway page with no JSON body -> true',
  isPollTransportFailure({ httpStatus: 504, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === true
);
check(
  'A4 a well-formed-but-unrecognized Atlas error object (code:500) must stay exactly as terminal as today -> false',
  isPollTransportFailure({ httpStatus: 500, envelopeCode: 500, hasDataObject: false, isFailureStatus: false }) === false
);
check(
  'A5 a real Atlas failure verdict always wins, even with zero envelope signal -> false',
  isPollTransportFailure({ httpStatus: 500, envelopeCode: null, hasDataObject: false, isFailureStatus: true }) === false
);
check(
  'A6 a healthy 200 never reaches this predicate in practice, but must fail closed -> false',
  isPollTransportFailure({ httpStatus: 200, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === false
);
check(
  'A7 an Atlas `data` object, even on a 500, is Atlas talking to us -> false',
  isPollTransportFailure({ httpStatus: 500, envelopeCode: null, hasDataObject: true, isFailureStatus: false }) === false
);
check(
  'A8 envelopeCode:0 is a valid number, not "absent" -> false',
  isPollTransportFailure({ httpStatus: 500, envelopeCode: 0, hasDataObject: false, isFailureStatus: false }) === false
);

// ── Section A2 — END-TO-END decision: isPollTransportFailure() combined with
// classify()'s policy.terminal, exactly as atlasImageService.js's poll loop
// combines them (`isPollTransportFailure(...) && !policy.terminal`). Adversarial
// review (2026-08-05) found that isPollTransportFailure() alone does not know
// classify() ALSO resolves several policies purely from `http`, with zero body
// required — unauthorized(401)/insufficientBalance(402)/forbidden(403) all
// match on http alone and are `terminal:true` even with no JSON envelope. Without
// the `!policy.terminal` guard at the call site, a bare 401/402/403 (e.g. a WAF
// block page with no Atlas JSON body) would be wrongly "kept polling" for the
// full timeout instead of failing immediately as auth/billing.
function endToEndShouldContinuePolling(pollShape) {
  const policy = classify({ http: pollShape.httpStatus, code: pollShape.envelopeCode });
  return isPollTransportFailure(pollShape) && !policy.terminal;
}

check(
  'A9 [REGRESSION GUARD] bare 401 (no body) must NOT be kept polling — classify() already resolved it terminal from HTTP alone',
  endToEndShouldContinuePolling({ httpStatus: 401, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === false
);
check(
  'A10 [REGRESSION GUARD] bare 402 (no body) must NOT be kept polling',
  endToEndShouldContinuePolling({ httpStatus: 402, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === false
);
check(
  'A11 [REGRESSION GUARD] bare 403 (no body) must NOT be kept polling',
  endToEndShouldContinuePolling({ httpStatus: 403, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === false
);
check(
  'A12 the real production incident (bare 502, no body) is unaffected by the terminal guard — still kept polling',
  endToEndShouldContinuePolling({ httpStatus: 502, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === true
);
check(
  'A13 a bare 500/504 (no body, probe-class, non-terminal) is unaffected by the guard — still kept polling',
  endToEndShouldContinuePolling({ httpStatus: 500, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === true
  && endToEndShouldContinuePolling({ httpStatus: 504, envelopeCode: null, hasDataObject: false, isFailureStatus: false }) === true
);

// ── Section B — structural wiring on atlasImageService.js ────────────────
// A correct pure predicate that's wired in wrong (bad ordering, dead code,
// falls through to the terminal throw) would still leave the bug live.

const src = fs.readFileSync(path.join(ROOT, 'services/atlasImageService.js'), 'utf8');

// Isolate submitAndPoll's body the same way this repo's other structural
// harnesses slice a single function (see scripts/verifyPreviewScriptGuard.js).
const fnStart = src.indexOf('async function submitAndPoll');
const fnBody  = fnStart >= 0
  ? src.slice(fnStart, src.indexOf('\nasync function', fnStart + 1))
  : '';

check('B1 atlasImageService.js requires isPollTransportFailure from ./atlasErrorPolicy',
  /const\s*\{[^}]*\bisPollTransportFailure\b[^}]*\}\s*=\s*require\(['"]\.\/atlasErrorPolicy['"]\)/.test(src)
);
check('B2 submitAndPoll calls isPollTransportFailure(', fnBody.includes('isPollTransportFailure('));

const retryableIdx    = fnBody.indexOf('policy.retryable && !isFailureStatus');
const transportIdx    = fnBody.indexOf('isPollTransportFailure(');
const terminalThrowIdx = fnBody.indexOf('err.alertKey    = policy.alertKey;\n      throw err;');

check(
  'B3 ordering: the new transport-noise branch comes AFTER the existing policy.retryable branch ' +
  '(every classify()-recognized case keeps its current precedence) and BEFORE the terminal ledger+throw',
  retryableIdx > -1 && transportIdx > -1 && terminalThrowIdx > -1
    && retryableIdx < transportIdx && transportIdx < terminalThrowIdx
);

check(
  "B4 the new branch continues polling (doesn't fall through to the terminal throw) — " +
  "a 'continue;' appears shortly after the isPollTransportFailure( call, before the next throw",
  (() => {
    if (transportIdx === -1) return false;
    const window = fnBody.slice(transportIdx, transportIdx + 700);
    const continueIdx = window.indexOf('continue;');
    const throwIdx = window.indexOf('throw err;');
    return continueIdx !== -1 && (throwIdx === -1 || continueIdx < throwIdx);
  })()
);

check(
  'B5 the new branch reuses the existing transientPolls counter rather than introducing new backoff state',
  (() => {
    if (transportIdx === -1) return false;
    const window = fnBody.slice(transportIdx, transportIdx + 700);
    return /transientPolls\+\+/.test(window);
  })()
);

check(
  'B7 [REGRESSION GUARD] the isPollTransportFailure( call is guarded by !policy.terminal — ' +
  'without this, a bare 401/402/403 (classify()-terminal from HTTP alone, zero body) would be ' +
  'wrongly kept polling instead of failing immediately (see Section A2)',
  (() => {
    if (transportIdx === -1) return false;
    // The guard can be written as `isPollTransportFailure({...}) && !policy.terminal`
    // (trailing) or wrapped some other way — check the ~50 chars immediately
    // following the isPollTransportFailure(...) call's closing for the guard,
    // scanning past the multi-line argument object first.
    const afterCall = fnBody.slice(transportIdx);
    const closeParenIdx = afterCall.indexOf('})');
    if (closeParenIdx === -1) return false;
    const tail = afterCall.slice(closeParenIdx, closeParenIdx + 60);
    return /!policy\.terminal/.test(tail);
  })()
);

check(
  'B6 the submit-refusal call site (before the poll loop) is untouched — still a single classify() call, ' +
  'no isPollTransportFailure reference near it (this fix must not touch resubmit logic)',
  (() => {
    const submitIdx = fnBody.indexOf('err.charged    = false;');
    if (submitIdx === -1) return false;
    return !fnBody.slice(Math.max(0, submitIdx - 400), submitIdx + 100).includes('isPollTransportFailure');
  })()
);

// ── Revert-proof note (manual, per CLAUDE.md §5) ──────────────────────────
// 1. Revert isPollTransportFailure's final line to `return false;` -> A1/A2/A3 fail (3 of 8 A-checks).
// 2. Delete the new `if (isPollTransportFailure(...))` block from atlasImageService.js -> B2/B4/B5 fail
//    (structural checks vacuous/absent), B3 fails (indices become -1).
// 3. Move the new block BEFORE the policy.retryable check (reorder) -> B3 fails (ordering), even though
//    A-section and B2/B4/B5 would still pass — this is why B3 must exist as its own assertion.
// 4. Remove `&& !policy.terminal` from the call site -> B7 fails (verified: 1 of 20). Note A9/A10/A11
//    do NOT fail on this mutation — they test the intended decision RULE (composing the predicate with
//    classify().terminal, as Section A2's endToEndShouldContinuePolling does), not the source text of
//    the call site. That split is deliberate: A9-A11 pin WHY the guard is required (the bare
//    401/402/403 regression the adversarial review of 2026-08-05 found — isPollTransportFailure()
//    alone cannot know classify() already resolved these terminal from HTTP status alone), and B7 pins
//    that the real call site actually applies it. Both are needed; neither implies the other.
// Verified by hand before shipping this harness.

if (failures.length) {
  console.error(`❌ verifyPollTransportRetry: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ verifyPollTransportRetry: ${pass} checks passed`);
