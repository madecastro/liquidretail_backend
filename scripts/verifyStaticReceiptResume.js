#!/usr/bin/env node
'use strict';
//
// verifyStaticReceiptResume — pins the static/image charge point's
// resume-from-receipt gate.
//
// THE BUG THIS CLOSES. Unlike atlasVideoService.generateForAd
// (shouldResumeAttempt, scripts/verifyVideoResumeFromReceipt.js), the static
// image submit path (atlasImageService.submitAndPoll, reached via
// directImageRenderService.renderDirectImage) used to submit a NEW Atlas
// gpt-image-2/edit generation on every call, with no check of an existing
// Ad.imageGeneration.predictionId. Confirmed by the team's own commit
// message (2f99218, PR #40, 2026-08-24): "the static/image charge point
// still has no resume guard at all." This harness pins the fix that closes
// it: shouldResumeImageAttempt (mirrors shouldResumeAttempt exactly) gates
// submitAndPollWithResume, which resumes polling an EXISTING predictionId
// instead of submitting a second one, and falls through to a fresh submit
// ONLY when Atlas's own settled record confirms the resumed prediction
// genuinely failed and was refunded (mayResubmit — the same money gate
// submitAndPollWithRetry already uses for its own internal 429/503 retries).
//
// ── A + B: EXECUTION-BASED, not just structural ─────────────────────────
// Sections A/B actually CALL the real submitAndPollWithResume /
// atlasImage.editImage code paths against a stubbed axios (installed via
// require.cache — no real network, no DB, no Atlas key) and assert on the
// axios calls that were ACTUALLY MADE, not on source text. This is the
// "prove the branch was reached" half the plain structural pins below
// cannot provide by themselves: a decoy-resistant regex can confirm the
// WIRING looks right without ever confirming the resume branch executes
// and skips the POST, or that the fallthrough branch executes and DOES
// re-POST. Meta.adId is deliberately omitted from every call below — that
// is what makes the receipt-stamp write (`if (meta.adId) { ... Ad.updateOne
// ... }` inside submitAndPoll) and the adStage/CostLog telemetry no-ops
// offline, without needing a live Mongo connection; both are genuinely
// optional at that call site for any non-ad caller, so this is exercising a
// real supported shape, not a hack around the harness.
//
// ── C: structural pins on the call-site wiring (decoy-resistant, mirrors
// verifyVideoResumeFromReceipt.js's C-section technique) ────────────────
//
// ── POST-MERGE GATE FINDING — presence vs effect (fixed by B8) ──────────
// A pre-merge check of this PR's diff demonstrated a REAL gap the C-section
// alone could not see: a mutation that keeps the
// `atlasImage.shouldResumeImageAttempt(...)` call inside
// submitEditImageWithSeedFallback but deletes ONLY the early `return` in
// front of the resumed editImage(...) call left C4 fully green (the call
// still appears in the textually-correct position — C4 only asserts
// ordering) while changing the real control flow: execution now falls
// through into the seed-fallback branch and calls its `submit()` closure,
// which carries NO existingPredictionId/allowResume, so it unconditionally
// POSTs a second, real, billable Atlas submit alongside the (harmless)
// resumed one — a genuine ~$0.072 double-bill that no check in sections
// A-C (all structural, or execution against atlasImageService ALONE) would
// have caught, because none of them ever drove
// submitEditImageWithSeedFallback's own control flow.
//
// FIXED by B8 (below): it calls the REAL, exported
// directImageRenderService.submitEditImageWithSeedFallback directly
// against a stubbed axios and asserts on the OBSERVABLE OUTCOME (zero
// POSTs), not on source-text ordering. MANUALLY REVERT-PROVEN against
// exactly this mutation (delete only the early `return`, keep everything
// else): applied it to a clean, committed checkout of
// directImageRenderService.js, ran this script — B8 alone went RED
// (`saw 1 POST(s): [...generateImage...]`), every other check (including
// C4) stayed GREEN, confirming C4's blind spot and B8's coverage of it;
// restored via `git checkout -- src/services/directImageRenderService.js`,
// re-ran, full 27/27 green again. Not left as permanent harness machinery
// (mutating a committed source file at every run is its own hazard — see
// this repo's CLAUDE.md on parallel-agent mutation-test interference); the
// PROOF is this comment plus B8's standing execution coverage, which
// cannot regress silently the way a purely textual check can.
//
// Offline only: no DB, no network, no Atlas key.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// isConfigured() (atlasImageService.js) gates every submit/resume call on
// process.env.ATLAS_API_KEY being set — offline execution needs SOME value
// here so editImage() actually reaches the resume/submit logic this harness
// pins, rather than short-circuiting on "not configured" before any of it
// runs (which would make every scenario below pass for the WRONG reason: no
// axios call happened because nothing tried, not because the money gate
// worked). Fake, never used for a real network call — axios itself is
// stubbed in every scenario below.
process.env.ATLAS_API_KEY = 'test-fake-key-offline-harness';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n     ${err.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n     ${err.message}`); }
}

console.log('verifyStaticReceiptResume\n');

// ═══════════════════════════════════════════════════════════════════════
// ── A: shouldResumeImageAttempt — exhaustive behavioural matrix ─────────
// ═══════════════════════════════════════════════════════════════════════
console.log('── A: shouldResumeImageAttempt (pure decision) ──');

const atlasImagePath = path.join(ROOT, 'src/services/atlasImageService.js');
const { shouldResumeImageAttempt } = require(atlasImagePath);

check('A0 shouldResumeImageAttempt is exported as a function', () => {
  assert.strictEqual(typeof shouldResumeImageAttempt, 'function');
});

const MATRIX = [
  ['A1 mint-time render, first attempt, receipt exists -> RESUME',
    { allowResume: true, attempt: 1, existingPredictionId: 'pred_abc123' }, true],
  ['A2 regenerate (allowResume:false), receipt exists -> submit fresh',
    { allowResume: false, attempt: 1, existingPredictionId: 'pred_abc123' }, false],
  ['A3 vision-QC corrective retry (allowResume:false), receipt exists -> submit fresh',
    { allowResume: false, attempt: 1, existingPredictionId: 'pred_qc_stale' }, false],
  ['A4 first-ever render, no receipt (null) -> submit fresh',
    { allowResume: true, attempt: 1, existingPredictionId: null }, false],
  ['A5 first-ever render, no receipt (undefined) -> submit fresh',
    { allowResume: true, attempt: 1, existingPredictionId: undefined }, false],
  ['A6 schema-default empty string -> submit fresh',
    { allowResume: true, attempt: 1, existingPredictionId: '' }, false],
  ['A7 attempt 2 with a receipt -> NEVER resume (matches video\'s A6/A7 invariant)',
    { allowResume: true, attempt: 2, existingPredictionId: 'pred_abc123' }, false],
  ['A8 allowResume as the string "true" (truthy, not boolean true) -> submit fresh',
    { allowResume: 'true', attempt: 1, existingPredictionId: 'pred_abc123' }, false],
  ['A9 [STRICT, NOT COERCED] attempt as the string "1" -> submit fresh',
    { allowResume: true, attempt: '1', existingPredictionId: 'pred_abc123' }, false],
  ['A10 existingPredictionId not a string (ObjectId-like object) -> submit fresh',
    { allowResume: true, attempt: 1, existingPredictionId: { toString: () => 'pred_abc123' } }, false]
];

for (const [label, args, expected] of MATRIX) {
  check(label, () => {
    assert.strictEqual(shouldResumeImageAttempt(args), expected,
      `shouldResumeImageAttempt(${JSON.stringify(args)}) should be ${expected}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ── B: EXECUTION — real submit/poll code against a stubbed axios ───────
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── B: execution against a stubbed axios (no network, no DB) ──');

// Install a fake axios BEFORE atlasImageService.js is (re-)required, so its
// module-scope `const axios = require('axios')` resolves to this stub.
// Routes by URL SUBSTRING: '/model/generateImage' (submit, POST),
// '/model/prediction/' (poll, GET), '/models' (price catalog, GET — hit by
// priceFor() whenever a completion/failure needs a cost estimate and the
// per-process price cache is cold, which it always is right after we
// re-require the module below).
const axiosRealPath = require.resolve('axios');

function installFakeAxios() {
  const calls = []; // { method, url }
  const postQueue = [];
  const getQueue = [];
  const fake = {
    post: async (url) => {
      calls.push({ method: 'POST', url });
      const next = postQueue.shift();
      if (!next) throw new Error(`unstubbed POST ${url}`);
      if (next.throw) throw next.throw;
      return next;
    },
    get: async (url) => {
      calls.push({ method: 'GET', url });
      if (url.includes('/model/prediction/')) {
        const next = getQueue.shift();
        if (!next) throw new Error(`unstubbed poll GET ${url}`);
        if (next.throw) throw next.throw;
        return next;
      }
      if (url.endsWith('/models')) {
        // Price catalog — empty is fine, buildPriceMap degrades to a $0
        // estimate with a warning; not what this harness is pinning.
        return { status: 200, data: { data: [] } };
      }
      throw new Error(`unstubbed GET ${url}`);
    }
  };
  require.cache[axiosRealPath] = { id: axiosRealPath, filename: axiosRealPath, loaded: true, exports: fake };
  return { calls, postQueue, getQueue };
}

// Fresh, isolated module instance per scenario — atlasImageService.js keeps
// a module-level `priceCache` singleton that must not leak stale state (or
// a stale fake-axios closure) across scenarios.
function freshAtlasImage() {
  delete require.cache[atlasImagePath];
  return require(atlasImagePath);
}

// directImageRenderService.js requires atlasImageService.js (which requires
// the SAME cached 'axios' module id) — installFakeAxios's require.cache
// swap works for both, one axios module instance per Node process
// regardless of which file required it first. Also clears
// atlasImageService.js's own cache entry so submitEditImageWithSeedFallback
// calls the fresh, fake-axios-backed atlasImage.editImage, not a stale
// cached instance holding an old fake closure from a previous scenario.
const directImageRenderServicePath = path.join(ROOT, 'src/services/directImageRenderService.js');
function freshDirectImageRenderService() {
  delete require.cache[atlasImagePath];
  delete require.cache[directImageRenderServicePath];
  return require(directImageRenderServicePath);
}

const COMPLETED_PRED_A = {
  status: 200,
  data: { data: { status: 'completed', outputs: ['https://cdn.example/out-a.png'], price: '0.0722' } }
};
function fakeImageBytesGet() {
  // finishPlate/editImage downloads the output URL as arraybuffer when it
  // looks like an http(s) URL — stub that GET too (same fake.get router,
  // matched by NOT hitting the two named branches, so give it its own
  // queue entry keyed generically). Simplify: route any GET that is
  // neither a prediction poll nor the price catalog to a canned image
  // buffer response.
}

async function scenarioA_resumeThenDone() {
  const { calls, postQueue, getQueue } = installFakeAxios();
  const atlasImage = freshAtlasImage();
  // Extend the fake to also answer the output-URL download GET (the model's
  // completed prediction's `outputs[0]`) — add it to the same get() router
  // by pre-seeding getQueue with BOTH the prediction poll AND, right after,
  // let the real axios.get inside submitAndPoll's completion branch fetch
  // the image bytes via a SEPARATE axios.get call. Route it generically:
  // any GET whose url does not match /model/prediction/ or /models falls
  // through to a canned PNG-ish buffer.
  const realGet = require.cache[axiosRealPath].exports.get;
  require.cache[axiosRealPath].exports.get = async (url) => {
    if (url.includes('/model/prediction/') || url.endsWith('/models')) return realGet(url);
    calls.push({ method: 'GET', url });
    return { status: 200, data: Buffer.from('fake-png-bytes') };
  };
  getQueue.push(COMPLETED_PRED_A);

  const out = await atlasImage.editImage({
    prompt: 'a scenario-A resume test',
    images: ['https://cdn.example/seed.png'], // plain URL string — no upload POST needed
    size: '1024x1024', quality: 'medium',
    model: 'openai/gpt-image-2/edit',
    meta: {}, // NO adId — skips the DB receipt-stamp write, see file header
    allowFallback: false,
    allowResume: true,
    existingPredictionId: 'pred_existing_a'
  });

  const posts = calls.filter(c => c.method === 'POST');
  assert.strictEqual(posts.length, 0,
    `[THE MONEY ASSERTION] a resume onto an already-billed prediction must NEVER POST a fresh submit — saw ${posts.length}: ${JSON.stringify(posts)}`);
  const predictionPolls = calls.filter(c => c.method === 'GET' && c.url.includes('/model/prediction/'));
  assert.ok(predictionPolls.length >= 1, 'expected at least one GET poll of the prediction');
  assert.ok(predictionPolls.every(c => c.url.includes('pred_existing_a')),
    `every poll must target the EXISTING predictionId, not a new one — saw ${JSON.stringify(predictionPolls)}`);
  assert.strictEqual(out.submission.predictionId, 'pred_existing_a',
    'the returned submission record must carry the RESUMED id, proving the resumed prediction is what was actually delivered');
}

async function scenarioB_resumeFailedUnbilledFallsThroughToFreshSubmit() {
  const { calls, postQueue, getQueue } = installFakeAxios();
  const atlasImage = freshAtlasImage();
  const realGet = require.cache[axiosRealPath].exports.get;
  require.cache[axiosRealPath].exports.get = async (url) => {
    if (url.includes('/model/prediction/') || url.endsWith('/models')) return realGet(url);
    calls.push({ method: 'GET', url });
    return { status: 200, data: Buffer.from('fake-png-bytes') };
  };

  // The RESUMED poll (on 'pred_existing_b') comes back genuinely FAILED
  // with NO price field — Atlas's documented convention for "refunded,
  // never charged" (this file's own header, atlasErrorPolicy's
  // predictionFailed policy: charged:false, action:'retry').
  getQueue.push({
    status: 200,
    data: { data: { status: 'failed', error: 'generation_failed', executionTime: 0 } }
  });
  // The FRESH submit (fallthrough) is accepted with a NEW id...
  postQueue.push({ status: 200, data: { data: { id: 'pred_fresh_b' } } });
  // ...and its own poll completes.
  getQueue.push({
    status: 200,
    data: { data: { status: 'completed', outputs: ['https://cdn.example/out-b.png'], price: '0.0722' } }
  });

  const out = await atlasImage.editImage({
    prompt: 'a scenario-B fallthrough test',
    images: ['https://cdn.example/seed.png'],
    size: '1024x1024', quality: 'medium',
    model: 'openai/gpt-image-2/edit',
    meta: {},
    allowFallback: false,
    allowResume: true,
    existingPredictionId: 'pred_existing_b'
  });

  const posts = calls.filter(c => c.method === 'POST');
  assert.strictEqual(posts.length, 1,
    `[THE FALLTHROUGH ASSERTION] a CONFIRMED-refunded resumed prediction must trigger EXACTLY ONE fresh POST — saw ${posts.length}`);
  const predictionPolls = calls.filter(c => c.method === 'GET' && c.url.includes('/model/prediction/'));
  assert.ok(predictionPolls.some(c => c.url.includes('pred_existing_b')),
    'must have polled the OLD id first (confirming it failed+unbilled) before ever submitting fresh');
  assert.ok(predictionPolls.some(c => c.url.includes('pred_fresh_b')),
    'must poll the NEW prediction id after the fresh submit');
  assert.strictEqual(out.submission.predictionId, 'pred_fresh_b',
    'the delivered image must be the FRESH submission, not a phantom reuse of the dead old id');
}

async function scenarioB2_resumeChargedFailureNeverResubmits() {
  // The adversarial twin of B: the resumed prediction failed, but Atlas's
  // settled record does NOT confirm it was unbilled (a genuine moderation
  // block, which atlasErrorPolicy marks charged:false but DETERMINISTIC —
  // action:'give-up', terminal:true). This must propagate the error
  // WITHOUT ever submitting fresh — a moderation block is not a "resubmit
  // safely" case (mayResubmit only allows the refunded predictionFailed
  // shape) — AND must NOT be treated as merely "unsettled": it is a
  // confirmed, deterministic verdict, so the ordinary terminal-failure
  // path (not the unsettledAtResume release-and-retry path) must stand.
  const { calls, getQueue } = installFakeAxios();
  const atlasImage = freshAtlasImage();

  getQueue.push({
    status: 500,
    data: { code: 500, message: 'Input Prompt violates policy', data: { status: 'failed', executionTime: 0 } }
  });

  let threw = null;
  try {
    await atlasImage.editImage({
      prompt: 'a scenario-B2 charged-failure test',
      images: ['https://cdn.example/seed.png'],
      size: '1024x1024', quality: 'medium',
      model: 'openai/gpt-image-2/edit',
      meta: {},
      allowFallback: false,
      allowResume: true,
      existingPredictionId: 'pred_existing_b2'
    });
  } catch (err) { threw = err; }

  assert.ok(threw, 'a moderation-blocked resumed prediction must throw, not silently succeed');
  const posts = calls.filter(c => c.method === 'POST');
  assert.strictEqual(posts.length, 0,
    `[THE MONEY ASSERTION] an uncertain/charged resumed-prediction failure must NEVER trigger a fresh POST — saw ${posts.length}: ${JSON.stringify(posts)}`);
  assert.ok(!threw.unsettledAtResume,
    'a DETERMINISTIC verdict (moderation block, terminal:true) must NOT be marked unsettledAtResume — ' +
    'that would leave the ad looping forever, resuming into the identical deterministic rejection on every retry');
}

async function scenarioB5_resumeBufferInputNeverUploads() {
  // ADVERSARIAL FINDING (Grok xhigh): editImage used to upload every Buffer
  // reference to Atlas BEFORE ever checking whether this call could resume
  // an already-paid prediction — so a resume onto a DONE prediction still
  // paid an uploadMedia round trip, and a transient upload failure could
  // fail an ad that in fact held a perfectly good, freely-recoverable
  // receipt. This scenario uses a Buffer (not a URL string) input
  // specifically to exercise the upload path IF it were ever reached.
  const { calls, postQueue, getQueue } = installFakeAxios();
  const atlasImage = freshAtlasImage();
  const realGet = require.cache[axiosRealPath].exports.get;
  require.cache[axiosRealPath].exports.get = async (url) => {
    if (url.includes('/model/prediction/') || url.endsWith('/models')) return realGet(url);
    calls.push({ method: 'GET', url });
    return { status: 200, data: Buffer.from('fake-png-bytes') };
  };
  getQueue.push({
    status: 200,
    data: { data: { status: 'completed', outputs: ['https://cdn.example/out-b5.png'], price: '0.0722' } }
  });

  const out = await atlasImage.editImage({
    prompt: 'a scenario-B5 buffer-input resume test',
    images: [Buffer.from('fake-reference-bytes')], // Buffer — would need uploadMedia if ever submitted
    size: '1024x1024', quality: 'medium',
    model: 'openai/gpt-image-2/edit',
    meta: {},
    allowFallback: false,
    allowResume: true,
    existingPredictionId: 'pred_existing_b5'
  });

  const uploadPosts = calls.filter(c => c.method === 'POST' && c.url.includes('uploadMedia'));
  assert.strictEqual(uploadPosts.length, 0,
    `[THE UPLOAD ASSERTION] a resume onto a DONE prediction must never upload the Buffer reference — saw ${uploadPosts.length} uploadMedia POST(s)`);
  const anyPosts = calls.filter(c => c.method === 'POST');
  assert.strictEqual(anyPosts.length, 0,
    `no POST of any kind should fire on a clean resume-to-done — saw ${anyPosts.length}: ${JSON.stringify(anyPosts)}`);
  assert.strictEqual(out.submission.predictionId, 'pred_existing_b5');
}

async function scenarioB6_resumeAmbiguousFailureIsUnsettledNotFailed() {
  // ADVERSARIAL FINDING (Grok xhigh) — HUNT 1, "stuck ad". A resumed poll
  // that comes back with a bare Atlas envelope `code:500` and NO
  // `data.status` (a genuine, observed shape — Atlas replying but the task
  // outcome itself unconfirmed) classifies as `serverError` (action:'probe',
  // charged:null, terminal:false) — mayResubmit correctly refuses a second
  // submit (nothing here is unsafe), but the OLD behavior (before this
  // scenario's fix) would have let that ambiguous failure propagate as an
  // ordinary error, which renderer.js's processAd would stamp
  // status:'failed' — permanently stranding a receipt that might still
  // resolve. err.unsettledAtResume is the fix: it must be set so
  // processAd instead releases the claim and leaves status:'rendering'.
  const { calls, getQueue } = installFakeAxios();
  const atlasImage = freshAtlasImage();

  // Deliberately NO `data.data` key at all — a bare coded envelope, exactly
  // the "Atlas replied, task outcome unconfirmed" shape.
  getQueue.push({
    status: 500,
    data: { code: 500, message: 'internal error, try again' }
  });

  let threw = null;
  try {
    await atlasImage.editImage({
      prompt: 'a scenario-B6 ambiguous-failure test',
      images: ['https://cdn.example/seed.png'],
      size: '1024x1024', quality: 'medium',
      model: 'openai/gpt-image-2/edit',
      meta: {},
      allowFallback: false,
      allowResume: true,
      existingPredictionId: 'pred_existing_b6'
    });
  } catch (err) { threw = err; }

  assert.ok(threw, 'an ambiguous resumed-poll failure must still throw (this function never silently succeeds)');
  assert.strictEqual(threw.unsettledAtResume, true,
    '[THE STUCK-AD ASSERTION] an ambiguous (non-terminal, non-refunded) resumed-poll failure must set ' +
    'err.unsettledAtResume — without it, renderer.js processAd would terminal-fail an ad whose receipt ' +
    'might still resolve, and bootRecoveryService only ever looks at status:\'rendering\' rows');
  const posts = calls.filter(c => c.method === 'POST');
  assert.strictEqual(posts.length, 0,
    `an ambiguous failure must still NEVER trigger a fresh POST — saw ${posts.length}: ${JSON.stringify(posts)}`);
}

async function scenarioB7_resumeCompletedNoOutputsIsTerminalNotUnsettled() {
  // ROUND-2 ADVERSARIAL FINDING (Grok xhigh) — a resumed poll landing on
  // Atlas's own 'completed' status with an EMPTY outputs array is a
  // CONFIRMED, SETTLED, CHARGED verdict — not an ambiguous one. Before this
  // fix, the "completed with no outputs" throw carried no err.policy at
  // all, so submitAndPollWithResume's catch fell into the ambiguous branch
  // and marked it unsettledAtResume — which releases the claim and leaves
  // status:'rendering', so the ad would claim→resume→completed-no-outputs→
  // release→reclaim FOREVER, never terminal-failing (a re-poll of the SAME
  // id always returns the identical completed-with-no-outputs answer).
  // This scenario proves the fix: unsettledAtResume must be ABSENT here,
  // and the error must still propagate (a real, resolvable failure) so
  // processAd's ordinary terminal-failure path runs instead.
  const { calls, getQueue } = installFakeAxios();
  const atlasImage = freshAtlasImage();

  getQueue.push({
    status: 200,
    data: { data: { status: 'completed', outputs: [], price: '0.0722' } }
  });

  let threw = null;
  try {
    await atlasImage.editImage({
      prompt: 'a scenario-B7 completed-no-outputs test',
      images: ['https://cdn.example/seed.png'],
      size: '1024x1024', quality: 'medium',
      model: 'openai/gpt-image-2/edit',
      meta: {},
      allowFallback: false,
      allowResume: true,
      existingPredictionId: 'pred_existing_b7'
    });
  } catch (err) { threw = err; }

  assert.ok(threw, 'a completed-with-no-outputs resumed prediction must throw, not silently succeed');
  assert.ok(!threw.unsettledAtResume,
    '[THE STUCK-AD-FOREVER ASSERTION] completed-with-no-outputs is a CONFIRMED, SETTLED verdict — marking it ' +
    'unsettledAtResume would loop the ad claim→resume→same-verdict→release→reclaim forever, since re-polling the ' +
    'SAME id can never return a different answer once Atlas reports it complete');
  assert.strictEqual(threw.charged, true,
    'the completed-with-no-outputs error must still report charged:true (Atlas billed for this) — unchanged by this fix');
  const posts = calls.filter(c => c.method === 'POST');
  assert.strictEqual(posts.length, 0,
    `a confirmed charged failure must never trigger a fresh POST — saw ${posts.length}: ${JSON.stringify(posts)}`);
}

// ── B8: drives submitEditImageWithSeedFallback DIRECTLY, not through
// editImage/renderDirectImage — THE GATE'S OWN FINDING (post-merge review).
//
// C4 (below, in section C) only asserted that
// `atlasImage.shouldResumeImageAttempt(` appears TEXTUALLY before
// `singleSeedEligible` inside submitEditImageWithSeedFallback's source — a
// mutation that KEEPS the shouldResumeImageAttempt(...) call but DELETES
// only the early `return` in front of the resumed editImage(...) call left
// C4 green (the call still appears in the right textual position) while
// changing the actual control flow: execution now falls through into the
// `!singleSeedEligible || ...` branch below and calls the seed-fallback
// `submit()` closure — which does NOT carry existingPredictionId/
// allowResume — so it unconditionally POSTs a FRESH billable submit
// alongside the (harmless) resumed one. Two real Atlas charges for one ad,
// ~$0.072 doubled. B1-B7 above never caught this because they all drive
// atlasImage.editImage directly — none of them exercise
// submitEditImageWithSeedFallback's OWN control flow at all.
//
// THE FIX: this scenario calls the REAL, exported
// directImageRenderService.submitEditImageWithSeedFallback (already
// exported "for behavioural pinning" — see this file's module.exports
// comment) against a stubbed axios and asserts on the OBSERVABLE OUTCOME
// (zero POSTs), not on source-text ordering. Against the real code today
// this passes (the early return fires, the seed-fallback branch below it
// never executes). Against the exact "delete only the early return"
// mutation the coordinator's merge gate demonstrated, this goes RED — see
// this file's own header for the manual revert-prove that confirmed it
// (mutate, run, confirm red, restore, re-run, confirm green).
async function scenarioB8_submitEditImageWithSeedFallbackActuallyReturnsOnResume() {
  const { calls, getQueue } = installFakeAxios();
  const realGet = require.cache[axiosRealPath].exports.get;
  require.cache[axiosRealPath].exports.get = async (url) => {
    if (url.includes('/model/prediction/') || url.endsWith('/models')) return realGet(url);
    calls.push({ method: 'GET', url });
    return { status: 200, data: Buffer.from('fake-png-bytes') };
  };
  getQueue.push({
    status: 200,
    data: { data: { status: 'completed', outputs: ['https://cdn.example/out-b8.png'], price: '0.0722' } }
  });

  const directImage = freshDirectImageRenderService();

  // singleSeedEligible:false deliberately — under the mutation, this is
  // exactly the branch execution falls into immediately after the
  // (no-longer-returning) resume call: `if (!singleSeedEligible || ...)
  // return { result: await submit(refs, imageMeta), seedFallback: null };`
  // — submit() carries NO resume params, so it POSTs fresh. Under the REAL
  // code, the early return above this branch means it is never reached at
  // all on a resume.
  let outcome = null;
  let threw = null;
  try {
    outcome = await directImage.submitEditImageWithSeedFallback({
      refs: ['https://cdn.example/seed-b8.png'],
      imageMeta: [{ sourceUrl: 'https://cdn.example/seed-b8.png', role: 'primary' }],
      prompt: 'a scenario-B8 seed-fallback-bleed test',
      genSize: '1024x1024',
      meta: {},
      model: 'openai/gpt-image-2/edit',
      quality: 'medium',
      timeoutMs: undefined,
      uploadTimeoutMs: undefined,
      allowProviderFallback: false,
      singleSeedEligible: false,
      mediaId: null,
      resolvedProduct: null,
      campaignRunId: null,
      productId: null,
      existingPredictionId: 'pred_existing_b8',
      allowResume: true
    });
  } catch (err) { threw = err; }

  const posts = calls.filter(c => c.method === 'POST');
  assert.strictEqual(posts.length, 0,
    `[THE GATE'S OWN FINDING — MONEY ASSERTION] submitEditImageWithSeedFallback must return on a successful ` +
    `resume WITHOUT ever reaching the seed-fallback submit() branch — saw ${posts.length} POST(s): ` +
    `${JSON.stringify(posts)}${threw ? ` (also threw: ${threw.message})` : ''}`);
  assert.ok(!threw, `submitEditImageWithSeedFallback must not throw on a clean resume-to-done — threw: ${threw && threw.message}`);
  assert.strictEqual(outcome.seedFallback, null, 'a resumed attempt must never report a seedFallback');
  assert.strictEqual(outcome.result.submission.predictionId, 'pred_existing_b8',
    'the returned submission must carry the RESUMED id, proving the resumed prediction is what was actually delivered');
}

async function scenarioC_ordinaryFirstTimePathUnaffected() {
  const { calls, postQueue, getQueue } = installFakeAxios();
  const atlasImage = freshAtlasImage();
  const realGet = require.cache[axiosRealPath].exports.get;
  require.cache[axiosRealPath].exports.get = async (url) => {
    if (url.includes('/model/prediction/') || url.endsWith('/models')) return realGet(url);
    calls.push({ method: 'GET', url });
    return { status: 200, data: Buffer.from('fake-png-bytes') };
  };

  postQueue.push({ status: 200, data: { data: { id: 'pred_ordinary_c' } } });
  getQueue.push({
    status: 200,
    data: { data: { status: 'completed', outputs: ['https://cdn.example/out-c.png'], price: '0.0722' } }
  });

  // No existingPredictionId, no allowResume — the ordinary mint-time SHAPE
  // for an ad that has never rendered before.
  const out = await atlasImage.editImage({
    prompt: 'a scenario-C ordinary-path test',
    images: ['https://cdn.example/seed.png'],
    size: '1024x1024', quality: 'medium',
    model: 'openai/gpt-image-2/edit',
    meta: {},
    allowFallback: false
  });

  const posts = calls.filter(c => c.method === 'POST');
  assert.strictEqual(posts.length, 1,
    `[THE REGRESSION ASSERTION] the ordinary first-time path must still submit exactly once, unaffected by this fix — saw ${posts.length}`);
  assert.strictEqual(out.submission.predictionId, 'pred_ordinary_c');

  // Same assertion, explicitly with allowResume:true but existingPredictionId
  // null/absent (the REAL shape renderStatic sends for a genuinely
  // first-time ad — see renderer.js: existingPredictionId defaults to
  // ad.imageGeneration?.predictionId || null).
  const { calls: calls2, postQueue: postQueue2, getQueue: getQueue2 } = installFakeAxios();
  const atlasImage2 = freshAtlasImage();
  const realGet2 = require.cache[axiosRealPath].exports.get;
  require.cache[axiosRealPath].exports.get = async (url) => {
    if (url.includes('/model/prediction/') || url.endsWith('/models')) return realGet2(url);
    calls2.push({ method: 'GET', url });
    return { status: 200, data: Buffer.from('fake-png-bytes') };
  };
  postQueue2.push({ status: 200, data: { data: { id: 'pred_ordinary_c2' } } });
  getQueue2.push({
    status: 200,
    data: { data: { status: 'completed', outputs: ['https://cdn.example/out-c2.png'], price: '0.0722' } }
  });
  await atlasImage2.editImage({
    prompt: 'a scenario-C2 allowResume:true-but-no-receipt test',
    images: ['https://cdn.example/seed.png'],
    size: '1024x1024', quality: 'medium',
    model: 'openai/gpt-image-2/edit',
    meta: {},
    allowFallback: false,
    allowResume: true,
    existingPredictionId: null
  });
  const posts2 = calls2.filter(c => c.method === 'POST');
  assert.strictEqual(posts2.length, 1,
    `allowResume:true with NO existing receipt must still submit exactly once — saw ${posts2.length}`);
}

async function runExecutionScenarios() {
  await checkAsync('B1 [THE MONEY ASSERTION] resume onto a DONE prediction never re-submits', scenarioA_resumeThenDone);
  await checkAsync('B2 resume onto a confirmed-refunded FAILED prediction falls through to exactly one fresh submit', scenarioB_resumeFailedUnbilledFallsThroughToFreshSubmit);
  await checkAsync('B3 [ADVERSARIAL] resume onto a DETERMINISTIC (moderation-blocked) failure never resubmits, and is NOT marked unsettled', scenarioB2_resumeChargedFailureNeverResubmits);
  await checkAsync('B4 the ordinary first-time render path (no receipt) is unaffected', scenarioC_ordinaryFirstTimePathUnaffected);
  await checkAsync('B5 [ADVERSARIAL] a Buffer-input resume onto a DONE prediction never uploads the reference', scenarioB5_resumeBufferInputNeverUploads);
  await checkAsync('B6 [ADVERSARIAL — THE STUCK-AD FIX] an ambiguous resumed-poll failure is marked unsettledAtResume, never resubmitted', scenarioB6_resumeAmbiguousFailureIsUnsettledNotFailed);
  await checkAsync('B7 [ROUND-2 ADVERSARIAL — THE STUCK-FOREVER FIX] a resumed completed-with-no-outputs verdict is terminal, NOT unsettledAtResume', scenarioB7_resumeCompletedNoOutputsIsTerminalNotUnsettled);
  await checkAsync("B8 [POST-MERGE GATE FINDING — THE SEED-FALLBACK-BLEED FIX] submitEditImageWithSeedFallback actually returns on a successful resume, never reaching the seed-fallback submit()", scenarioB8_submitEditImageWithSeedFallbackActuallyReturnsOnResume);
}

// ═══════════════════════════════════════════════════════════════════════
// ── C: structural pins on the call-site wiring (decoy-resistant) ───────
// ═══════════════════════════════════════════════════════════════════════
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
function isInsideAString(text, matchIndex) {
  if (matchIndex == null || matchIndex < 0 || matchIndex > text.length) return false;
  let inS = null;
  for (let i = 0; i < matchIndex; i++) {
    const c = text[i];
    if (inS) { if (c === '\\') { i++; continue; } if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === '`') inS = c;
  }
  return inS !== null;
}
function findRealMatches(text, regex) {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  const hits = [];
  let m;
  while ((m = re.exec(text))) { if (!isInsideAString(text, m.index)) hits.push(m); }
  return hits;
}

console.log('\n── C: caller sites ──');

check('C1 renderer.js (renderStatic, the mint-time path) passes allowResume: true explicitly and sources existingPredictionId from ad.imageGeneration.predictionId', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8'));
  const body = fnBody(src, 'async function renderStatic(');
  assert.ok(body, 'renderStatic() not found in renderer.js');
  assert.match(body, /allowResume:\s*true/,
    'renderStatic must pass allowResume: true explicitly — this is the exact call site a released claim on a receipt-holding ad re-enters');
  assert.match(body, /existingPredictionId:\s*ad\.imageGeneration\?\.\s*predictionId\s*\|\|\s*null/,
    'renderStatic must source existingPredictionId from ad.imageGeneration.predictionId (the actual receipt), not a literal or an unrelated field');
});

check('C2 [THE REGENERATE CARVE-OUT] adRegenerateService.js (buildDirectImageArgsFromAd) passes allowResume: false / existingPredictionId: null explicitly', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/adRegenerateService.js'), 'utf8'));
  const body = fnBody(src, 'function buildDirectImageArgsFromAd(');
  assert.ok(body, 'buildDirectImageArgsFromAd() not found in adRegenerateService.js');
  assert.match(body, /allowResume:\s*false/,
    'buildDirectImageArgsFromAd must pass allowResume: false — a regenerate is a deliberately NEW image, never a resume of a stale receipt');
  assert.match(body, /existingPredictionId:\s*null/,
    'buildDirectImageArgsFromAd must pass existingPredictionId: null');
});

check('C3 buildQcRetryArgs (the vision-QC corrective re-entry) resets existingPredictionId/allowResume rather than spreading the original call\'s values forward', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/directImageRenderService.js'), 'utf8'));
  const body = fnBody(src, 'function buildQcRetryArgs(');
  assert.ok(body, 'buildQcRetryArgs() not found in directImageRenderService.js');
  assert.match(body, /existingPredictionId:\s*null/,
    'buildQcRetryArgs must explicitly null out existingPredictionId — otherwise a spread of the ORIGINAL mint-path callArgs (allowResume:true, existingPredictionId set) would let the QC corrective retry try to "resume" the REJECTED image\'s receipt instead of paying for a fresh corrective generation');
  assert.match(body, /allowResume:\s*false/,
    'buildQcRetryArgs must explicitly set allowResume: false');
});

check('C4 [DECOY-RESISTANT] submitEditImageWithSeedFallback checks shouldResumeImageAttempt BEFORE any seed-fallback candidate is chosen', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/directImageRenderService.js'), 'utf8'));
  const body = fnBody(src, 'async function submitEditImageWithSeedFallback(');
  assert.ok(body, 'submitEditImageWithSeedFallback() not found');

  const resumeHits = findRealMatches(body, /shouldResumeImageAttempt\s*\(/);
  assert.ok(resumeHits.length >= 1, 'submitEditImageWithSeedFallback must call atlasImage.shouldResumeImageAttempt(...)');

  const singleSeedHits = findRealMatches(body, /singleSeedEligible/);
  assert.ok(singleSeedHits.length >= 1, 'expected the existing singleSeedEligible branching to still be present');

  assert.ok(resumeHits[0].index < singleSeedHits[0].index,
    'the resume check must run BEFORE the seed-fallback branching starts — otherwise a fallback candidate submit ' +
    'could be compared against a receipt that belongs to a DIFFERENT (earlier) seed image');
});

check('C5 renderDirectImage defaults existingPredictionId/allowResume to the SAFE (non-resuming) shape', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/directImageRenderService.js'), 'utf8'));
  const body = fnBody(src, 'async function renderDirectImage(');
  assert.ok(body, 'renderDirectImage() not found');
  // renderDirectImage takes a single `callArgs = {}` in its SIGNATURE and
  // destructures inside the BODY (`const { ... } = callArgs;`) — unlike
  // video's generateForAd, whose params are destructured directly in the
  // signature. Check the body's own destructure defaults, not the
  // (uninformative) signature parameter list.
  assert.match(body, /existingPredictionId\s*=\s*null/,
    'existingPredictionId must default to null — a caller that forgets to pass it must never accidentally resume');
  assert.match(body, /allowResume\s*=\s*false/,
    'allowResume must default to false — the safe direction is "always submit fresh" unless a caller explicitly opts in');
});

check('C6 [THE STUCK-AD FIX] processAd releases the claim (leaves rendering) on err.unsettledAtResume, same as err.unsettledAtTimeout — never terminal-fails it', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8'));
  const body = fnBody(src, 'async function processAd(');
  assert.ok(body, 'processAd() not found in renderer.js');

  const catchIdx = body.search(/catch\s*\(\s*err\s*\)\s*\{/);
  assert.ok(catchIdx >= 0, 'inner catch(err) block not found inside processAd');
  const catchOpen = body.indexOf('{', catchIdx);
  const catchBlock = balanced(body, catchOpen, '{', '}');
  assert.ok(catchBlock, 'could not balance the catch(err) block');

  const releaseHits = findRealMatches(catchBlock, /unsettledAtResume/);
  assert.ok(releaseHits.length >= 1, 'processAd\'s catch must reference err.unsettledAtResume');

  // ASSERT THE INVARIANT, NOT THE SPELLING (updated 2026-08-27, PR #82).
  //
  // This check used to require ONE combined
  //   `if (err && (err.unsettledAtTimeout || err.unsettledAtResume))`
  // on the reasoning that "a separate, parallel branch could drift from the
  // video branch's release/bumpRunCounter/return shape". PR #82 deliberately
  // SPLIT that branch, because the video half must no longer have that shape:
  // releasing the claim while leaving status:'rendering' is exactly the
  // re-claim livelock that burned ten billable Atlas predictions on one ad in
  // 2h21m. Video now delegates to the bounded settleUnsettledVideoTimeout;
  // static keeps this release-and-leave-rendering treatment, which is correct
  // for it (no lifetime cap was ever the static bug).
  //
  // So the anti-drift concern is re-pointed rather than dropped: the two arms
  // are now ALLOWED to differ, but BOTH must still exist, the static one must
  // still have its exact release shape, and neither may terminal-fail a paid
  // receipt. Deleting either arm still fails this check — which is the
  // property that actually protects the money, and the reason this was not
  // "relaxed to make the suite green".
  const resumeIf = findRealMatches(
    catchBlock,
    /if\s*\(\s*err\s*&&\s*\(?[^)]*err\.unsettledAtResume[^)]*\)?\s*\)/
  );
  assert.ok(resumeIf.length >= 1,
    'processAd\'s catch must GUARD on err.unsettledAtResume — either in a combined ' +
    '`if (err && (err.unsettledAtTimeout || err.unsettledAtResume))` or in its own ' +
    'dedicated `if (err && err.unsettledAtResume)`. Without a guard, an ambiguous ' +
    'resumed static poll falls through to the terminal status:\'failed\' write and ' +
    'strands a PAID image receipt — bootRecoveryService only ever selects status:\'rendering\'.');
  // NO EXTRA CONJUNCTS. Matching the guard by regex alone would accept
  //   `if (err && err.unsettledAtResume && somethingElse)`
  // and a future narrowing conjunct could quietly disable the static
  // protection while leaving this check green — a hole the OLD C6 did not have,
  // because it pinned one exact string. So the condition is compared against an
  // EXHAUSTIVE whitelist of the two logical forms that are actually correct
  // (split, or combined either way round) rather than pattern-matched.
  // Deliberately strict: if someone legitimately refactors this guard (hoists
  // it into a named predicate, say), this fires and makes them re-validate a
  // money path on purpose instead of by accident. Raised by adversarial review
  // 2026-08-27.
  const condOpen = catchBlock.indexOf('(', resumeIf[0].index);
  const cond = balanced(catchBlock, condOpen, '(', ')');
  assert.ok(cond, 'could not balance the unsettledAtResume if-condition');
  const condNorm = cond.replace(/\s+/g, '');
  const ACCEPTED = [
    '(err&&err.unsettledAtResume)',
    '(err&&(err.unsettledAtTimeout||err.unsettledAtResume))',
    '(err&&(err.unsettledAtResume||err.unsettledAtTimeout))'
  ];
  assert.ok(ACCEPTED.includes(condNorm),
    `the unsettledAtResume guard's condition is ${condNorm}, which is not one of the accepted ` +
    `forms ${JSON.stringify(ACCEPTED)}. An added conjunct can narrow this guard until a paid ` +
    'image receipt falls through to the terminal write; a removed one can widen it onto rows it ' +
    'must not touch. If you are changing this deliberately, add the new form here and re-prove ' +
    'the static receipt path.');

  const ifOpen = catchBlock.indexOf('{', resumeIf[0].index);
  const ifBlock = balanced(catchBlock, ifOpen, '{', '}');
  assert.ok(ifBlock, 'could not balance the unsettledAtResume if-block');
  assert.match(ifBlock, /releaseClaim\s*\(\s*ad\._id/,
    'the unsettledAtResume branch must call releaseClaim(ad._id, ...)');
  assert.match(ifBlock, /bumpRunCounter\s*\(\s*ad\.campaignRunIds\s*,\s*['"]skipped['"]\s*\)/,
    'the unsettledAtResume branch must bump the run counter as \'skipped\', not \'failed\'');
  assert.match(ifBlock, /return\s*;/,
    'the unsettledAtResume branch must return — otherwise execution falls through into the generic failed-status write');
  // The static arm must NOT terminal-fail: that is the whole defect #74 fixed.
  assert.ok(!/status:\s*['"]failed['"]/.test(ifBlock),
    'the unsettledAtResume branch must never write status:\'failed\' — a stranded paid receipt is the bug it exists to prevent');
  // AND IT MUST NOT BE ROUTED THROUGH THE VIDEO SETTLER. The merge gate called
  // this out specifically when it proposed the split: settleUnsettledVideoTimeout
  // is video-specific by construction — it backfills veoPredictionId and writes a
  // video-shaped renderError (predictionId + chargeState) — so sending a static
  // resume through it would stamp a video receipt field on an image row and
  // report against the wrong poll ceiling. Wrong in a different way than the
  // livelock, and easy to do by accident when collapsing the two arms back
  // together. Cheap to pin, so pinned.
  assert.ok(!/settleUnsettledVideoTimeout/.test(ifBlock),
    'the unsettledAtResume branch must NOT call settleUnsettledVideoTimeout — that settler is ' +
    'video-specific (backfills veoPredictionId, writes a video-shaped renderError); a static ' +
    'resume belongs on releaseClaim + leave-rendering');

  // THE VIDEO HALF MUST STILL BE HANDLED SOMEWHERE IN THIS CATCH. Either
  // combined into the same guard (the pre-#82 shape) or routed to the bounded
  // settler (the post-#82 shape). If a future resolution of this same conflict
  // drops the video arm, this fires.
  const videoHandled =
    findRealMatches(catchBlock, /err\.unsettledAtTimeout/).length >= 1 &&
    (/settleUnsettledVideoTimeout\s*\(/.test(catchBlock) ||
      /err\.unsettledAtTimeout\s*\|\|/.test(catchBlock));
  assert.ok(videoHandled,
    'processAd\'s catch must still handle err.unsettledAtTimeout — either combined with ' +
    'unsettledAtResume, or delegated to settleUnsettledVideoTimeout(ad, err). Losing it ' +
    'reinstates the video re-claim livelock (PR #82).');

  const genericFailedHits = findRealMatches(catchBlock, /status:\s*['"]failed['"]/);
  assert.ok(genericFailedHits.length >= 1, 'no generic status:"failed" write found in the catch block');
  assert.ok(genericFailedHits[0].index > resumeIf[0].index,
    'the generic status:"failed" write must come AFTER the unsettledAtResume branch in source order');
});

check('C7 atlasImageService distinguishes a DETERMINISTIC verdict (err.policy.terminal OR completedNoOutput) from an AMBIGUOUS one before setting unsettledAtResume', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/atlasImageService.js'), 'utf8'));
  const body = fnBody(src, 'async function submitAndPollWithResume(');
  assert.ok(body, 'submitAndPollWithResume() not found');
  assert.match(body, /err\.policy\s*&&\s*\(?\s*err\.policy\.terminal/,
    'submitAndPollWithResume must check err.policy.terminal before falling into the unsettledAtResume branch — ' +
    'otherwise a genuinely deterministic verdict (moderation block, bad credentials) would be left \'rendering\' ' +
    'forever, re-resuming into the identical rejection on every future claim');
  assert.match(body, /err\.policy\.name\s*===\s*['"]completedNoOutput['"]/,
    '[ROUND-2 ADVERSARIAL FIX] submitAndPollWithResume must ALSO special-case err.policy.name===\'completedNoOutput\' ' +
    'alongside err.policy.terminal — completedNoOutput is a CONFIRMED, SETTLED Atlas verdict (action:\'probe\' in the ' +
    'policy table, so policy.terminal is false for it) that will never differ on a later poll; without this, a resumed ' +
    'prediction that completed with no output would loop claim→resume→completed-no-outputs→release→reclaim forever');
  const setHits = findRealMatches(body, /err\.unsettledAtResume\s*=\s*true/);
  assert.ok(setHits.length >= 1, 'submitAndPollWithResume must set err.unsettledAtResume = true on the ambiguous branch');
});

check('C8 [ROUND-2 ADVERSARIAL FIX] the completed-with-no-outputs throw attaches a policy (predictionStatus:\'completed\', hasOutputs:false)', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/services/atlasImageService.js'), 'utf8'));
  const body = fnBody(src, 'async function pollSubmittedPrediction(');
  assert.ok(body, 'pollSubmittedPrediction() not found');
  const noOutputIdx = body.search(/completed with no outputs/);
  assert.ok(noOutputIdx >= 0, 'the "completed with no outputs" throw was not found');
  // The .policy assignment must appear AFTER the chargedError call and
  // BEFORE the throw, in the immediate vicinity of the no-outputs branch —
  // not just anywhere in the (large) poll loop, which would pass even if
  // some unrelated policy assignment satisfied a loose file-wide regex.
  const nearby = body.slice(noOutputIdx, noOutputIdx + 800);
  assert.match(nearby, /\.policy\s*=\s*classify\s*\(\s*\{\s*predictionStatus:\s*['"]completed['"]\s*,\s*hasOutputs:\s*false\s*\}\s*\)/,
    'the completed-with-no-outputs error must have .policy set via classify({predictionStatus:\'completed\', hasOutputs:false}) ' +
    'immediately after chargedError() — that policy is what lets submitAndPollWithResume\'s catch (C7) recognise this as a ' +
    'confirmed, settled verdict rather than an ambiguous one');
});

console.log('');

runExecutionScenarios().then(() => {
  if (failed) {
    console.log(`❌ verifyStaticReceiptResume: ${failed} FAILED`);
    process.exit(1);
  }
  console.log('✅ verifyStaticReceiptResume: all checks passed');
}).catch((err) => {
  console.error('verifyStaticReceiptResume: harness crashed —', err);
  process.exit(1);
});
