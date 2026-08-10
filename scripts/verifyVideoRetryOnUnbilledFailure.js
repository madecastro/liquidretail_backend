#!/usr/bin/env node
'use strict';

// Verifies the video provider-fault retry and the settled-verdict poll fixes.
//
// THE INCIDENT (2026-08-10)
// -------------------------
// Atlas's video model intermittently accepts a job then fails it without
// rendering a frame — 6 failures across ~23 submits in one day (~26%):
//
//   veoReference[ad=…]: atlasVideo: prediction failed:
//     Generation failed: task processing failed (code: generation_failed)
//
// Three defects compounded it:
//
//  1. NO RETRY. The `predictionFailed` policy has always said
//     `action:'retry', maxAttempts:2, charged:false`, but nothing on the video
//     path read it — the poll classified and threw. Every provider hiccup
//     became a dead ad and ~$0.75 of value never delivered.
//
//  2. A TERMINAL VERDICT INSIDE A 500 WAS RETRIED AS A TRANSPORT BLIP. Atlas
//     serves a failed prediction as HTTP 500 with a complete
//     `data.status:'failed'` body. The poll's axios.get has no validateStatus,
//     so it threw into the generic 5xx branch: prediction cec47abe… was polled
//     12 times over 3 minutes after it had already failed, then reported as
//     "12 consecutive poll failures" — which reads like an Atlas outage and
//     discards the classification entirely.
//
//  3. RECOVERY COULD NEVER SETTLE THEM. peekPrediction bailed on
//     `res.status !== 200` BEFORE reading the body, so a confirmed-failed video
//     came back 'unknown' and its charge state stayed unresolved forever.
//
// THE MONEY RULE
// --------------
// A retry is a NEW BILLABLE SUBMIT. It is allowed only when Atlas's own settled
// record confirms the failed attempt carried NO price. Measured live
// 2026-08-10 across ten real predictions:
//
//   succeeded -> data.price "0.75" (full length) / "0.08" (short)   5 of 5
//   failed    -> data.price ABSENT ENTIRELY                          5 of 5
//
// `chargeConfirmed === null` (could not read a settled record) does NOT retry:
// a non-charge may only be asserted from a confirmed price, exactly as a charge
// may only be asserted from one. Unknown is treated as charged.
//
// Offline only: no DB, no network.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  mayRetryAfterFailure,
  confirmedCharge,
  SETTLED_POLL_STATUSES,
} = require('../services/atlasVideoService');
const { classify } = require('../services/atlasErrorPolicy');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'atlasVideoService.js'), 'utf8');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

// The REAL payloads, copied from live predictions on 2026-08-10.
const FAILED_BODY = {
  id: '99aa27e0d08b4cb8bb3b5cbc4dc59ad6',
  model: 'google/gemini-omni-flash/image-to-video-developer',
  outputs: null, status: 'failed', error_code: 1,
  error: 'Generation failed: task processing failed (code: generation_failed)',
  executionTime: 0, timings: { inference: 0 }, latency_ms: 49752,
  // NOTE: no `price` key at all — that absence is the whole signal.
};
const SUCCEEDED_BODY = {
  id: 'db5bc089d5244dfe8f10138ff3b4980d', status: 'completed',
  outputs: ['https://example.invalid/v.mp4'], price: '0.75', latency_ms: 134474,
};

console.log('\nA. the money gate — mayRetryAfterFailure');

check('A1 retries ONLY on a policy-retryable, confirmed-unbilled failure', () => {
  assert.strictEqual(mayRetryAfterFailure({
    policyRetryable: true, chargeConfirmed: false, attempt: 1, maxAttempts: 2
  }), true);
});

check('A2 a CONFIRMED CHARGE never retries (the double-bill case)', () => {
  assert.strictEqual(mayRetryAfterFailure({
    policyRetryable: true, chargeConfirmed: true, attempt: 1, maxAttempts: 2
  }), false);
});

check('A3 UNKNOWN charge state never retries — unknown is treated as charged', () => {
  for (const unknown of [null, undefined]) {
    assert.strictEqual(mayRetryAfterFailure({
      policyRetryable: true, chargeConfirmed: unknown, attempt: 1, maxAttempts: 2
    }), false, `chargeConfirmed=${unknown} must not spend again`);
  }
});

check('A4 a non-retryable policy never retries even when unbilled (moderation)', () => {
  assert.strictEqual(mayRetryAfterFailure({
    policyRetryable: false, chargeConfirmed: false, attempt: 1, maxAttempts: 2
  }), false);
});

check('A5 the attempt ceiling is honoured', () => {
  const base = { policyRetryable: true, chargeConfirmed: false, maxAttempts: 2 };
  assert.strictEqual(mayRetryAfterFailure({ ...base, attempt: 1 }), true,  'attempt 1 of 2 may retry');
  assert.strictEqual(mayRetryAfterFailure({ ...base, attempt: 2 }), false, 'attempt 2 of 2 is the last');
  assert.strictEqual(mayRetryAfterFailure({ ...base, attempt: 9 }), false);
});

check('A6 a missing maxAttempts degrades to single-attempt, not unlimited', () => {
  assert.strictEqual(mayRetryAfterFailure({
    policyRetryable: true, chargeConfirmed: false, attempt: 1, maxAttempts: undefined
  }), false, 'absent maxAttempts must mean 1, never Infinity');
});

check('A7 truthy-but-not-true values do not open the gate', () => {
  // Guards against a future refactor passing 'false'/0/'' through loosely.
  assert.strictEqual(mayRetryAfterFailure({
    policyRetryable: 1, chargeConfirmed: false, attempt: 1, maxAttempts: 2
  }), false);
  assert.strictEqual(mayRetryAfterFailure({
    policyRetryable: true, chargeConfirmed: 0, attempt: 1, maxAttempts: 2
  }), false, '0 is not a confirmed non-charge');
});

console.log('\nB. confirmedCharge — read the price, never guess it');

check('B1 a real FAILED prediction (no price key) is a confirmed NON-charge', () => {
  assert.deepStrictEqual(confirmedCharge(FAILED_BODY), { charged: false, priceUsd: 0 });
});

check('B2 a real SUCCEEDED prediction reports the confirmed charge', () => {
  assert.deepStrictEqual(confirmedCharge(SUCCEEDED_BODY), { charged: true, priceUsd: 0.75 });
});

check('B3 an UNSETTLED prediction is UNKNOWN, never "not charged"', () => {
  // Mid-flight: the absence of a price means nothing yet. Returning
  // charged:false here would let a still-running job be resubmitted.
  assert.deepStrictEqual(
    confirmedCharge({ status: 'processing' }), { charged: null, priceUsd: null }
  );
  assert.deepStrictEqual(confirmedCharge({}), { charged: null, priceUsd: null });
  assert.deepStrictEqual(confirmedCharge(null), { charged: null, priceUsd: null });
});

check('B4 an unparseable price is UNKNOWN, not zero', () => {
  assert.deepStrictEqual(
    confirmedCharge({ status: 'failed', price: 'n/a' }), { charged: null, priceUsd: null }
  );
});

check('B5 an explicit null/empty price on a settled row is a non-charge', () => {
  for (const p of [null, '']) {
    assert.deepStrictEqual(
      confirmedCharge({ status: 'failed', price: p }), { charged: false, priceUsd: 0 }
    );
  }
});

check('B6 a settled row priced 0 is a non-charge; any positive price is a charge', () => {
  assert.strictEqual(confirmedCharge({ status: 'failed', price: '0' }).charged, false);
  assert.strictEqual(confirmedCharge({ status: 'completed', price: '0.08' }).charged, true);
});

console.log('\nC. the live policy and the gate must agree');

check('C1 generation_failed classifies as retryable, maxAttempts 2, unbilled', () => {
  const p = classify({
    predictionStatus: 'failed',
    msg: 'Generation failed: task processing failed (code: generation_failed)',
    nsfw: null
  });
  assert.strictEqual(p.name, 'predictionFailed', `classified as ${p.name}`);
  assert.strictEqual(p.retryable, true);
  assert.strictEqual(p.charged, false);
  assert.strictEqual(p.maxAttempts, 2);
  // End to end: this is the production failure, and it must retry exactly once.
  assert.strictEqual(mayRetryAfterFailure({
    policyRetryable: p.retryable,
    chargeConfirmed: confirmedCharge(FAILED_BODY).charged,
    attempt: 1, maxAttempts: p.maxAttempts
  }), true);
});

check('C2 a real moderation block is NOT retried (deterministic — would re-block)', () => {
  const p = classify({
    predictionStatus: 'failed',
    msg: 'Your input or generated content was blocked by safety review. Please revise your input and try again.',
    nsfw: null
  });
  assert.strictEqual(p.name, 'moderationBlocked', `classified as ${p.name}`);
  assert.strictEqual(p.retryable, false);
  assert.strictEqual(mayRetryAfterFailure({
    policyRetryable: p.retryable, chargeConfirmed: false, attempt: 1, maxAttempts: p.maxAttempts
  }), false, 'a safety block must never be resubmitted');
});

console.log('\nD. settled-verdict handling in both poll paths');

check('D1 SETTLED_POLL_STATUSES covers every terminal state Atlas emits', () => {
  for (const s of ['completed', 'succeeded', 'failed', 'error', 'cancelled', 'canceled', 'rejected']) {
    assert.ok(SETTLED_POLL_STATUSES.has(s), `${s} missing`);
  }
  for (const s of ['processing', 'queued', 'starting', '']) {
    assert.ok(!SETTLED_POLL_STATUSES.has(s), `${s} must NOT be settled`);
  }
});

check('D2 the poll loop promotes an error response that carries a verdict', () => {
  // The 500-with-body case must reach the classify branch instead of
  // consecutiveErrors. Asserted structurally because the loop is I/O-bound.
  const i = SRC.indexOf('const settled = err.response?.data?.data;');
  assert.ok(i > 0, 'poll loop no longer inspects the error-response body');
  const window = SRC.slice(i, i + 1400);
  assert.ok(/SETTLED_POLL_STATUSES\.has\(settledStatus\)/.test(window), 'no settled-status test');
  assert.ok(/res = err\.response;/.test(window), 'never promotes the response onto the normal path');
});

check('D3 the bare-5xx transport path is UNCHANGED (docs/ATLAS.md §4 relies on it)', () => {
  // A CDN/WAF page carries no verdict and must still count toward
  // MAX_CONSECUTIVE_ERRORS rather than being read as a failure.
  const i = SRC.indexOf('const settled = err.response?.data?.data;');
  const window = SRC.slice(i, i + 1400);
  assert.ok(/consecutiveErrors\+\+/.test(window), 'lost the consecutive-error counter');
  assert.ok(/MAX_CONSECUTIVE_ERRORS/.test(window), 'lost the consecutive-error ceiling');
});

check('D5 every terminal-failure status the POLICY knows also terminates the poll', () => {
  // If the policy calls a status a failure but the poll does not recognise it,
  // the poll logs it as "still running" and burns the full MAX_POLL_MS budget —
  // and a timeout carries no policy metadata, so it never reaches the retry
  // gate either. Promotion made that reachable for Atlas's 500+body shape.
  const { TERMINAL_FAILURE_STATUSES } = require('../services/atlasVideoService');
  for (const s of ['failed', 'error', 'cancelled', 'canceled', 'rejected']) {
    assert.ok(TERMINAL_FAILURE_STATUSES.has(s), `${s} does not terminate the poll`);
    const p = classify({ predictionStatus: s, msg: 'x', nsfw: null });
    assert.strictEqual(p.name, 'predictionFailed', `policy disagrees on '${s}' (got ${p.name})`);
  }
  assert.ok(!TERMINAL_FAILURE_STATUSES.has('processing'));
  // Both poll and peek must branch on the shared set, not a hand-rolled list.
  assert.strictEqual(
    (SRC.match(/TERMINAL_FAILURE_STATUSES\.has\(status\)/g) || []).length, 2,
    'poll and peek must both use the shared terminal-failure set'
  );
});

check('D4 peekPrediction reads the body BEFORE bailing on a non-200', () => {
  const guard = SRC.indexOf("if (res.status !== 200 && !SETTLED_POLL_STATUSES.has(status))");
  assert.ok(guard > 0, 'peekPrediction still bails on status alone — recovery cannot settle a failed video');
  const dataRead = SRC.indexOf('const data = res.data?.data || {};');
  assert.ok(dataRead > 0 && dataRead < guard, 'the body must be parsed before the non-200 bail');
});

console.log('\nE. the ledger correction');

check('E1 an unbilled failure zeroes its own charge-point row before resubmitting', () => {
  // Anchor on the CALL, not the bare name — the name also appears in prose
  // above the charge-point write, and anchoring there silently walked this
  // check onto the wrong object.
  const i = SRC.indexOf('await finalizeFlatCost({');
  assert.ok(i > 0, 'no ledger correction — a retry would book two submits for one video');
  const window = SRC.slice(i, i + 700);
  assert.ok(/providerRequestId: predictionId/.test(window), 'not keyed on the prediction, so it cannot update in place');
  assert.ok(/costUsd:\s*0/.test(window), 'does not zero the cost');
  assert.ok(/costSource: 'none'/.test(window), "costSource must be 'none' — CostLog's enum is actual|estimated|none");
});

check('E3 the CHARGE-POINT row is keyed on the prediction, or nothing is correctable', () => {
  // The gap that made E1 a false pass: finalizeFlatCost keys on
  // providerRequestId, so if the charge-point write does not STAMP it, the
  // update matches nothing, falls back to an insert, and the failed attempt's
  // ~$0.75 estimate survives beside the retry's — $1.50 booked for one video.
  // Found by adversarial review, not by the first draft of this harness.
  const i = SRC.indexOf("stage:      'atlas_video_render',");
  assert.ok(i > 0, 'charge-point write not found');
  const window = SRC.slice(i, i + 900);
  assert.ok(
    /providerRequestId: predictionId/.test(window),
    'charge-point recordFlatCost does not stamp providerRequestId — the retry ledger correction cannot match its row'
  );
  assert.ok(/status:\s*'submitted'/.test(window), 'charge-point row is no longer the submitted row');
});

check('E2 costSource/status are legal CostLog enum values', () => {
  const { COST_STATUSES } = require('../models/CostLog');
  assert.ok(COST_STATUSES.includes('failed'), "'failed' must be a legal cost status");
  // Update validators are OFF by default, so an invented value would be
  // written straight past the enum instead of erroring.
  assert.ok(!/costSource: '(confirmed|verified|actualised)'/.test(SRC), 'invented costSource value present');
});

const total = pass + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} verifyVideoRetryOnUnbilledFailure: ${pass}/${total} passed`);
if (failures.length) {
  console.log(`  failed: ${failures.join(', ')}`);
  process.exit(1);
}
