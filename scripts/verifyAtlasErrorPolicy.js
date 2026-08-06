#!/usr/bin/env node
'use strict';
/**
 * Verify the Atlas failure classification.
 *
 * Cases marked [LIVE] are the exact envelopes returned by Atlas on 2026-07-31 and
 * are the reason this module exists — particularly the failed prediction, which
 * arrives as code:500 with status:"failed", so naive 500 handling would treat a
 * refunded failure as a possible double-charge and refuse to reattempt.
 *
 * Run: node scripts/verifyAtlasErrorPolicy.js
 */

const { classify, mayResubmit, retryAfterFrom, POLICIES } = require('../services/atlasErrorPolicy');

let pass = 0, fail = 0;
const failures = [];

function expect(label, input, want) {
  const got = classify(input);
  const bad = [];
  for (const [k, v] of Object.entries(want)) {
    if (got[k] !== v) bad.push(`${k}: want ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
  }
  if (bad.length) { fail++; failures.push(`${label}\n      ${bad.join('\n      ')}`); }
  else pass++;
  const flagged = bad.length ? '✗' : '✓';
  console.log(`  ${flagged} ${label.padEnd(52)} -> ${got.name} / ${got.action} / charged=${got.charged} / cost=${got.costStatus()}`);
}

console.log('\nATLAS FAILURE CLASSIFICATION\n');

// ── [LIVE] the failed prediction we actually observed ────────────────────
expect('[LIVE] failed prediction (code 500 + status failed)',
  { http: 200, code: 500, predictionStatus: 'failed', hasOutputs: false,
    msg: 'system error, unknown error' },
  { name: 'predictionFailed', action: 'retry', charged: false, retryable: true, terminal: false });

// ── [LIVE] a healthy completion must NOT classify as a failure ───────────
{
  const got = classify({ http: 200, code: 200, predictionStatus: 'completed', hasOutputs: true });
  const ok = got.name === 'unknown';   // nothing matched => caller treats as success
  if (ok) pass++; else { fail++; failures.push('[LIVE] completed+outputs matched a failure policy: ' + got.name); }
  console.log(`  ${ok ? '✓' : '✗'} ${'[LIVE] completed with outputs matches nothing'.padEnd(52)} -> ${got.name}`);
}

// ── billing / credentials: never retried, always paged ───────────────────
expect('402 insufficient balance',
  { http: 402, msg: 'insufficient balance' },
  { name: 'insufficientBalance', action: 'fix-config', charged: false, terminal: true, alertLevel: 'fatal' });

expect('402 reported only in the message body',
  { http: 200, code: 402, msg: 'insufficient balance' },
  { name: 'insufficientBalance', terminal: true });

expect('401 bad bearer token',
  { http: 401 }, { name: 'unauthorized', action: 'fix-config', terminal: true, alertLevel: 'fatal' });

expect('403 monthly spending limit',
  { http: 403, msg: 'reached its monthly spending limit' },
  { name: 'forbidden', action: 'fix-config', terminal: true });

// ── the bug this module was written for ──────────────────────────────────
// [LIVE 2026-08-05] Atlas's wording for a rejected prompt. It matched none of the
// original moderation alternatives, so a DETERMINISTIC content rejection came out
// as serverError/probe: we would keep probing a prompt that can never succeed and
// report it as an unknown server fault. Verified on two real predictions
// (35ea54dd…, 4cee5c40…), both status:"failed", executionTime:0.
expect('[LIVE] "Input Prompt violates policy" is moderation, not a server error',
  { http: 500, code: 500, predictionStatus: 'failed', msg: 'Input Prompt violates policy' },
  { name: 'moderationBlocked', action: 'give-up', charged: false, terminal: true });

// THE BOUNDARY. The list is enumerated on purpose: a false positive marks a
// RETRYABLE failure permanently futile and throws away a render that would have
// succeeded on a second attempt. A bare "policy" must NOT match.
expect('a bare "policy" stays retryable — the matcher did not over-broaden',
  { http: 200, predictionStatus: 'failed', msg: 'policy' },
  { name: 'predictionFailed', action: 'retry' });

expect('429 rate limit (was terminal, must retry)',
  { http: 429 },
  { name: 'rateLimited', action: 'retry', retryable: true, charged: false, terminal: false });

// ── outcome-unknown: probe, never blind resubmit ─────────────────────────
expect('500 with no prediction status',
  { http: 500 }, { name: 'serverError', action: 'probe', charged: null, probeFirst: true });

expect('504 gateway timeout',
  { http: 504 }, { name: 'gatewayTimeout', action: 'probe', charged: null });

expect('503 service unavailable',
  { http: 503 }, { name: 'unavailable', action: 'wait', retryable: true });

expect('ECONNRESET mid-flight',
  { errCode: 'ECONNRESET' }, { name: 'network', action: 'probe', charged: null });

expect('our own deadline exceeded (billable)',
  { errCode: 'ETIMEDOUT', msg: 'timed out after 600000ms' },
  { name: 'clientTimeout', action: 'probe', charged: true });

// ── prediction-level outcomes ────────────────────────────────────────────
expect('moderation outranks a failed status',
  { predictionStatus: 'failed', nsfw: true },
  { name: 'moderationBlocked', action: 'give-up', terminal: true, charged: false });

expect('moderation detected from the message',
  { http: 200, msg: 'rejected by the safety filter' },
  { name: 'moderationBlocked', action: 'give-up', terminal: true });

// REGRESSION, 2026-08-04. This is Atlas's ACTUAL live wording, copied verbatim
// from a production video failure. It matched none of the original safety
// alternatives (system|filter), so a real moderation block was classified
// predictionFailed and RETRIED — futile by definition, and shown to the
// operator as a generic prediction failure. If this case ever goes red again,
// safety rejections are silently being retried.
expect('the REAL Atlas safety-review wording is moderation, not a retryable failure',
  { predictionStatus: 'failed',
    msg: 'Your input or generated content was blocked by safety review. Please revise your input and try again. (code: generation_failed)' },
  { name: 'moderationBlocked', action: 'give-up', terminal: true, charged: false });

expect('safety check is moderation too',
  { predictionStatus: 'failed', msg: 'blocked by safety check' },
  { name: 'moderationBlocked', action: 'give-up' });

expect('safety guidelines is moderation too',
  { predictionStatus: 'failed', msg: 'violates safety guidelines' },
  { name: 'moderationBlocked', action: 'give-up' });

// The other half of the contract: the matcher must NOT be so loose that a
// retryable fault gets marked terminal. A false positive here throws away a
// render that would have succeeded on the second attempt, which is why the
// safety alternatives stay ENUMERATED rather than `safety\s+\w+`, and why
// bare `blocked` is still not matched.
expect('an infrastructure "blocked" is NOT moderation',
  { predictionStatus: 'failed', msg: 'upstream blocked the connection' },
  { name: 'predictionFailed', action: 'retry' });

expect('a generic prediction failure is NOT moderation',
  { predictionStatus: 'failed', msg: 'prediction failed: internal error' },
  { name: 'predictionFailed', action: 'retry' });

// The operator-facing heading. The ads page shows Ad.renderError.message, and
// "prediction failed" told an operator nothing actionable about a safety block.
check('moderationBlocked carries the operator label',
  classify({ predictionStatus: 'failed', msg: 'blocked by safety review' }).label === 'Model Moderation Error',
  classify({ predictionStatus: 'failed', msg: 'blocked by safety review' }).label);

// Only the classes we have deliberately named carry a label; everything else
// keeps the provider's own wording rather than inventing a friendlier one.
check('an unlabelled class exposes label === null',
  classify({ predictionStatus: 'failed', msg: 'internal error' }).label === null,
  String(classify({ predictionStatus: 'failed', msg: 'internal error' }).label));

expect('cancelled prediction',
  { predictionStatus: 'cancelled' }, { name: 'predictionFailed', action: 'retry' });

expect('completed but no outputs (the real charged case)',
  { http: 200, predictionStatus: 'completed', hasOutputs: false },
  { name: 'completedNoOutput', charged: true, action: 'probe' });

expect('unrecognised shape defaults to outcome-unknown',
  { msg: 'something we have never seen' },
  { name: 'unknown', action: 'probe', charged: null });

// ── backoff behaviour ────────────────────────────────────────────────────
console.log('\nBACKOFF\n');
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(`${label} — ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
}

const rl = classify({ http: 429 });
const b = [0, 1, 2, 3].map(n => rl.backoffFor(n));
check('429 backoff grows', b[0] < b[1] && b[1] < b[2], b.join(','));
check('429 backoff capped at 30s', b.every(v => v <= 30_500), b.join(','));

{
  const c = classify({ http: 429, retryAfterSec: 7 });
  check('Retry-After 7s -> 7000ms', c.backoffFor(0) === 7000, String(c.backoffFor(0)));
}
{
  const c = classify({ http: 429, retryAfterSec: 9999 });
  check('Retry-After clamped to 120s', c.backoffFor(0) === 120_000, String(c.backoffFor(0)));
}

check('terminal policies allow only one attempt',
  ['unauthorized', 'insufficientBalance', 'forbidden', 'moderationBlocked']
    .every(k => POLICIES[k].maxAttempts === 1));

check('no policy marks a fix-config state as retryable',
  Object.values(POLICIES).every(p => !(p.action === 'fix-config' && p.maxAttempts > 1)));

// ── THE DOUBLE-CHARGE GATE ───────────────────────────────────────────────
// Adversarial review caught this: the first version gated resubmission on
// "were we charged", but a 429 classifies as uncharged, and a 429 seen AFTER a
// successful submit sits beside a task that WAS billed at submission. Gating on
// charged alone therefore bought the same image twice. The gate is now "did the
// previous attempt leave nothing running".
console.log('\nRESUBMIT GATE (double-charge protection)\n');

function gate(label, policy, predictionId, want) {
  const got = mayResubmit(policy, predictionId);
  if (got === want) { pass++; console.log(`  ✓ ${label.padEnd(50)} resubmit=${got}`); }
  else { fail++; failures.push(`${label} — want resubmit=${want}, got ${got}`); console.log(`  ✗ ${label.padEnd(50)} resubmit=${got} (want ${want})`); }
}

gate('429 at submit — nothing created yet', classify({ http: 429 }), null, true);
gate('429 after submit — task exists, MUST NOT resubmit', classify({ http: 429 }), 'pred_abc', false);
gate('503 after submit — task exists, MUST NOT resubmit', classify({ http: 503 }), 'pred_abc', false);
gate('failed prediction — refunded, safe to reattempt',
  classify({ code: 500, predictionStatus: 'failed' }), 'pred_abc', true);
gate('500 outcome unknown — never resubmit', classify({ http: 500 }), 'pred_abc', false);
gate('500 unknown even with no id — probe, not retry', classify({ http: 500 }), null, false);
gate('our timeout — task likely live and billable', classify({ errCode: 'ETIMEDOUT' }), 'pred_abc', false);
gate('402 balance — futile', classify({ http: 402 }), null, false);
gate('moderation — deterministic, futile', classify({ nsfw: true }), 'pred_abc', false);
gate('completed-no-output — charged, never resubmit',
  classify({ predictionStatus: 'completed', hasOutputs: false }), 'pred_abc', false);
gate('null policy is never resubmittable', null, null, false);

// ── envelope-shape guards ────────────────────────────────────────────────
console.log('\nENVELOPE SHAPES\n');
{
  // outputs: [] is truthy — length is what matters, or completed-with-no-outputs
  // silently classifies as a success.
  const outs = [];
  const c = classify({ predictionStatus: 'completed', hasOutputs: Array.isArray(outs) ? outs.length > 0 : !!outs });
  check('empty outputs array counts as no output', c.name === 'completedNoOutput', c.name);
}
{
  const c = classify({ predictionStatus: 'failed', nsfw: [true] });
  check('nsfw as an array still reads as moderation', c.name === 'moderationBlocked', c.name);
}

// ── header parsing ───────────────────────────────────────────────────────
check('retryAfterFrom numeric', retryAfterFrom({ headers: { 'retry-after': '12' } }) === 12);
check('retryAfterFrom absent', retryAfterFrom({ headers: {} }) === null);
check('retryAfterFrom http-date',
  typeof retryAfterFrom({ headers: { 'retry-after': new Date(Date.now() + 20_000).toUTCString() } }) === 'number');

console.log('\n' + '-'.repeat(74));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log('  ✗ ' + f)); process.exitCode = 1; }
console.log('');
