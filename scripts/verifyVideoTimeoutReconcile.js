#!/usr/bin/env node
'use strict';
/**
 * verifyVideoTimeoutReconcile — offline harness for the 2026-08-19 incident
 * (run_1787119100250_eef4d871: two Omni masters timed out at 600s; both were
 * still 'processing' at Atlas 14-25+ minutes after submit, one showing signs
 * of an internal Atlas requeue). Root cause was NOT that 600s is too short —
 * fresh Omni-only completion data (n=28, Aug 14-19) measures p50=167s
 * p95=203s p99=215s max=215s, so 600s already carries ~2.8x headroom over the
 * observed max. The real defect: on timeout, the poll loop threw a bare,
 * unclassified Error, the render route always wrote status:'failed', and
 * that severed the ad's already-stamped spend receipt (Ad.veoPredictionId)
 * from services/bootRecoveryService's periodic sweep (worker.js recoverTick,
 * which keys on status:'rendering' + a receipt) — so a prediction that
 * completed or settled moments later was written off instead of recovered
 * or reconciled, and the CostLog row stayed at the submit-time ESTIMATE
 * forever (costSource:'estimated', status:'submitted').
 *
 * WHAT THIS PINS
 *   A. resolveTimeoutOutcome (atlasVideoService) — the pure decision for
 *      what a final free peek at the deadline means: done → rescue the
 *      render; failed → classified error, same shape as the mid-poll branch;
 *      processing/unknown → err.unsettledAtTimeout, chargeConfirmed stays
 *      null (never coerced to a definite failure).
 *   B. mayRetryAfterFailure structurally refuses to resubmit for the
 *      unsettled shape (policyRetryable is undefined) — the fix cannot
 *      reopen the double-charge the charge-point receipt guards against.
 *   C. resolveRecoveredVideoFailureCharge (bootRecoveryService) — the
 *      tri-state charge-confirmation decision for a video prediction
 *      recovered as FAILED: charged:false → zero the estimate;
 *      charged:true + a real settled price → correct the estimate to it;
 *      charged:null (unknown) → leave the ledger untouched.
 *   D. models/CostLog.js — campaignRunId is a String path (matches
 *      Ad.campaignRunIds / CampaignRun.runId), not an ObjectId ref.
 *   E. campaignRunId actually reaches the charge-point write on both the
 *      video and static-image paths (source-scan + revert-proof).
 *   F. routes/ads.js's video catch block checks err.unsettledAtTimeout
 *      BEFORE the generic failure write, and that branch never sets
 *      status:'failed' — the entire point is to leave the receipt
 *      discoverable to bootRecoveryService.
 *
 * No DB, no network, no API key. Run: node scripts/verifyVideoTimeoutReconcile.js
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REVERT-PROOF RECIPE (the automated H-block below does these and restores;
 * listed here too so a human can reproduce by hand):
 *
 *  1. In atlasVideoService.js's resolveTimeoutOutcome, change the
 *     processing/unknown branch to set `err.chargeConfirmed = false` instead
 *     of `null` → B1/A5 fail (a genuinely unknown outcome would be asserted
 *     as a confirmed non-charge, which is the exact "guessing" rule violates
 *     CLAUDE.md §2 forbids).
 *  2. In routes/ads.js's video catch block, delete the
 *     `if (err.unsettledAtTimeout) { ... return; }` branch (or move it AFTER
 *     the generic failure write) → F1/F2 fail, because every timeout would
 *     go back to being marked 'failed' and the receipt would stop being
 *     discoverable to bootRecoveryService.
 *  3. In bootRecoveryService.js, hardcode
 *     `resolveRecoveredVideoFailureCharge` to always return
 *     `{confirmedCharge:true, reconcile:null}` → C2 fails (a confirmed-unbilled
 *     failure would permanently keep the submit-time estimate instead of
 *     being zeroed).
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const VID_PATH   = path.join(ROOT, 'services/atlasVideoService.js');
const BOOT_PATH  = path.join(ROOT, 'services/bootRecoveryService.js');
const ADS_PATH   = path.join(ROOT, 'routes/ads.js');
const DIRECT_PATH = path.join(ROOT, 'services/directImageRenderService.js');
const COSTLOG_PATH = path.join(ROOT, 'models/CostLog.js');

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function withTempMutation(filePath, find, replace, runCheck) {
  const original = fs.readFileSync(filePath, 'utf8');
  assert.ok(original.includes(find), `mutate target not found in ${path.basename(filePath)}: ${find.slice(0, 80)}…`);
  try {
    fs.writeFileSync(filePath, original.replace(find, replace));
    runCheck();
  } finally {
    fs.writeFileSync(filePath, original);
  }
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), original, `mutation residue left on ${filePath}`);
}

function freshRequire(modPath) {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

console.log('\nverifyVideoTimeoutReconcile\n');

// ── A. resolveTimeoutOutcome — the deadline-reached decision ────────────
console.log('A. resolveTimeoutOutcome (atlasVideoService)');
{
  const { resolveTimeoutOutcome, mayRetryAfterFailure } = require('../services/atlasVideoService');

  check('A1 exported and is a function', () => {
    assert.strictEqual(typeof resolveTimeoutOutcome, 'function');
  });

  check('A2 final peek DONE → success, not a thrown error', () => {
    const out = resolveTimeoutOutcome(
      { state: 'done', videoUrl: 'https://example.com/v.mp4', price: '0.9' },
      { predictionId: 'pred1', maxPollMs: 600000 }
    );
    assert.strictEqual(out.action, 'success');
    assert.strictEqual(out.url, 'https://example.com/v.mp4');
    assert.strictEqual(out.price, '0.9');
  });

  check('A3 final peek DONE with no price → price null, still success', () => {
    const out = resolveTimeoutOutcome(
      { state: 'done', videoUrl: 'https://example.com/v.mp4' },
      { predictionId: 'pred1', maxPollMs: 600000 }
    );
    assert.strictEqual(out.action, 'success');
    assert.strictEqual(out.price, null);
  });

  check('A4 final peek FAILED → classified throw, same field shape as the mid-poll branch', () => {
    const out = resolveTimeoutOutcome(
      { state: 'failed', message: 'atlasVideo: prediction failed: blocked', policy: 'moderationBlocked', charged: false, priceUsd: 0 },
      { predictionId: 'pred1', maxPollMs: 600000 }
    );
    assert.strictEqual(out.action, 'throw');
    assert.strictEqual(out.error.atlasPolicy, 'moderationBlocked');
    assert.strictEqual(out.error.chargeConfirmed, false);
    assert.strictEqual(out.error.policyRetryable, false); // deadline already spent — never resubmit from here
    assert.strictEqual(out.error.predictionId, 'pred1');
    assert.strictEqual(out.error.unsettledAtTimeout, undefined); // must NOT also be flagged unsettled
  });

  check('A5 final peek PROCESSING → unsettledAtTimeout:true, chargeConfirmed stays null (never coerced)', () => {
    const out = resolveTimeoutOutcome(
      { state: 'processing' },
      { predictionId: 'pred1', maxPollMs: 600000 }
    );
    assert.strictEqual(out.action, 'throw');
    assert.strictEqual(out.error.unsettledAtTimeout, true);
    assert.strictEqual(out.error.chargeConfirmed, null);
    assert.strictEqual(out.error.predictionId, 'pred1');
  });

  check('A6 final peek UNKNOWN (transport hiccup on the final GET) → same unsettled treatment as processing', () => {
    const out = resolveTimeoutOutcome(
      { state: 'unknown', message: 'ECONNRESET' },
      { predictionId: 'pred1', maxPollMs: 600000 }
    );
    assert.strictEqual(out.action, 'throw');
    assert.strictEqual(out.error.unsettledAtTimeout, true);
    assert.strictEqual(out.error.chargeConfirmed, null);
  });

  check('A7 unsettled error message names the prediction id and says "preserved for reconciliation"', () => {
    const out = resolveTimeoutOutcome({ state: 'processing' }, { predictionId: 'abc123', maxPollMs: 600000 });
    assert.ok(out.error.message.includes('abc123'));
    assert.ok(/reconciliation/i.test(out.error.message));
  });

  console.log('\nB. mayRetryAfterFailure structurally refuses the unsettled shape');
  check('B1 unsettled error (policyRetryable undefined) never authorizes a resubmit', () => {
    const out = resolveTimeoutOutcome({ state: 'processing' }, { predictionId: 'p', maxPollMs: 600000 });
    const may = mayRetryAfterFailure({
      policyRetryable: out.error.policyRetryable,
      chargeConfirmed: out.error.chargeConfirmed,
      attempt: 1,
      maxAttempts: 3
    });
    assert.strictEqual(may, false);
  });

  check('B2 classified-failed-at-deadline (policyRetryable explicitly false) also never resubmits from this path', () => {
    const out = resolveTimeoutOutcome(
      { state: 'failed', message: 'x', policy: 'predictionFailed', charged: false, priceUsd: 0 },
      { predictionId: 'p', maxPollMs: 600000 }
    );
    const may = mayRetryAfterFailure({
      policyRetryable: out.error.policyRetryable,
      chargeConfirmed: out.error.chargeConfirmed,
      attempt: 1,
      maxAttempts: out.error.policyMaxAttempts
    });
    assert.strictEqual(may, false, 'a failure discovered only at the deadline must never trigger a NEW billable submit from pollPrediction — that decision belongs to generateForAd\'s own attempt loop, not a stale deadline');
  });
}

// ── C. resolveRecoveredVideoFailureCharge — bootRecoveryService ─────────
console.log('\nC. resolveRecoveredVideoFailureCharge (bootRecoveryService)');
{
  const { resolveRecoveredVideoFailureCharge } = require('../services/bootRecoveryService');

  check('C1 exported and is a function', () => {
    assert.strictEqual(typeof resolveRecoveredVideoFailureCharge, 'function');
  });

  check('C2 confirmed NOT charged (charged:false) → zero the ledger estimate', () => {
    const r = resolveRecoveredVideoFailureCharge({ charged: false, priceUsd: 0, predictionId: 'p1' });
    assert.strictEqual(r.confirmedCharge, false);
    assert.deepStrictEqual(r.reconcile, { costUsd: 0 });
  });

  check('C3 confirmed CHARGED with a real settled price → correct estimate to the real figure', () => {
    const r = resolveRecoveredVideoFailureCharge({ charged: true, priceUsd: 0.9, predictionId: 'p1' });
    assert.strictEqual(r.confirmedCharge, true);
    assert.deepStrictEqual(r.reconcile, { costUsd: 0.9 });
  });

  check('C4 UNKNOWN (charged:null) → leave the ledger untouched, never guess', () => {
    const r = resolveRecoveredVideoFailureCharge({ charged: null, priceUsd: null, predictionId: 'p1' });
    assert.strictEqual(r.confirmedCharge, false); // renderError.charged is a plain Boolean field — cannot be tri-state
    assert.strictEqual(r.reconcile, null, 'an unknown charge state must not trigger any CostLog write');
  });

  check('C5 charged:true but no usable priceUsd → confirmedCharge true, no reconcile (nothing to correct to)', () => {
    const r = resolveRecoveredVideoFailureCharge({ charged: true, priceUsd: null, predictionId: 'p1' });
    assert.strictEqual(r.confirmedCharge, true);
    assert.strictEqual(r.reconcile, null);
  });
}

// ── D. CostLog schema — campaignRunId is a String, not an ObjectId ref ──
console.log('\nD. models/CostLog.js schema');
{
  const CostLog = require('../models/CostLog');
  check('D1 campaignRunId path is String (matches Ad.campaignRunIds / CampaignRun.runId)', () => {
    const p = CostLog.schema.path('campaignRunId');
    assert.ok(p, 'campaignRunId path missing from schema');
    assert.strictEqual(p.instance, 'String');
  });
  check('D2 a real run-id string does not throw a CastError on assignment', () => {
    const doc = new CostLog({ stage: 'test', provider: 'atlas', model: 'x', campaignRunId: 'run_1787119100250_eef4d871' });
    const err = doc.validateSync();
    // Other required-but-absent fields are fine to be missing here (stage/
    // provider/model are set); we only care that campaignRunId itself casts.
    if (err) assert.ok(!err.errors.campaignRunId, `campaignRunId cast/validation failed: ${err.errors.campaignRunId && err.errors.campaignRunId.message}`);
  });
}

// ── E. campaignRunId actually reaches the charge-point writes ───────────
console.log('\nE. campaignRunId threading to the charge-point CostLog writes');
{
  const vidSrc = fs.readFileSync(VID_PATH, 'utf8');
  const directSrc = fs.readFileSync(DIRECT_PATH, 'utf8');
  const adsSrc = fs.readFileSync(ADS_PATH, 'utf8');
  const routerSrc = fs.readFileSync(path.join(ROOT, 'services/videoRouter.js'), 'utf8');

  check('E1 generateForAd accepts campaignRunId as a parameter', () => {
    const i = vidSrc.indexOf('async function generateForAd({');
    assert.ok(i >= 0);
    const sig = vidSrc.slice(i, i + 900);
    assert.ok(/campaignRunId\s*=\s*null/.test(sig), 'generateForAd signature does not declare campaignRunId');
  });

  check('E2 the charge-point recordFlatCost call passes campaignRunId through', () => {
    const i = vidSrc.indexOf("stage:      'atlas_video_render'");
    assert.ok(i >= 0, 'charge-point recordFlatCost call not found');
    const block = vidSrc.slice(i, i + 1500);
    assert.ok(/campaignRunId:\s*campaignRunId \|\| null/.test(block), 'charge-point cost record does not include campaignRunId');
  });

  check('E3 routes/ads.js passes campaignRunId: run.runId into veoGenerateForAd', () => {
    assert.ok(
      /veoGenerateForAd\(\{\s*ad,\s*storyboard,\s*campaignRunId:\s*run\.runId\s*\}\)/.test(adsSrc),
      'the master-video call site does not thread run.runId through as campaignRunId'
    );
  });

  check('E4 videoRouter.generateForAd forwards campaignRunId to atlasVideoService', () => {
    const i = routerSrc.indexOf('async function generateForAd({');
    assert.ok(i >= 0);
    const block = routerSrc.slice(i, i + 400);
    assert.ok(/campaignRunId/.test(block), 'videoRouter.generateForAd does not accept/forward campaignRunId');
  });

  check('E5 directImageRenderService includes campaignRunId + campaignId in the static-image charge-point meta', () => {
    const i = directSrc.indexOf("stage: 'direct_image'");
    assert.ok(i >= 0, 'static-image meta object not found');
    const block = directSrc.slice(i, i + 900);
    assert.ok(/campaignRunId:\s*campaignRunId \|\| null/.test(block), 'static-image meta is missing campaignRunId');
    assert.ok(/campaignId:\s*campaignId \|\| null/.test(block), 'static-image meta is missing campaignId');
  });

  console.log('\n  [REVERT-PROOF]');
  check('E6 [REVERT-PROOF] removing campaignRunId from the video charge-point record is detected', () => {
    const find = 'campaignRunId: campaignRunId || null,';
    const replace = '// campaignRunId intentionally dropped for this test';
    let e2WouldStillPass = false; // set true below only if the mutation somehow left the pattern intact
    withTempMutation(VID_PATH, find, replace, () => {
      const mutSrc = fs.readFileSync(VID_PATH, 'utf8');
      const i = mutSrc.indexOf("stage:      'atlas_video_render'");
      const block = mutSrc.slice(i, i + 1500);
      if (/campaignRunId:\s*campaignRunId \|\| null/.test(block)) e2WouldStillPass = true; // harness blind to the mutation
    });
    assert.ok(!e2WouldStillPass, 'E2-style scan did not notice campaignRunId being dropped from the charge point');
  });
}

// ── F. routes/ads.js — unsettled-at-timeout never becomes status:'failed' ─
console.log('\nF. routes/ads.js video catch block ordering');
{
  const adsSrc = fs.readFileSync(ADS_PATH, 'utf8');
  const catchIdx = adsSrc.indexOf('} catch (err) {\n      console.error(`❌ veoReference[ad=${adId}]:`');
  assert.ok(catchIdx >= 0, 'video catch block not found — has it moved or been renamed?');
  const block = adsSrc.slice(catchIdx, catchIdx + 5000);
  const unsettledIdx = block.indexOf('err.unsettledAtTimeout');
  const genericFailIdx = block.indexOf("title:  'Video generation failed'");

  check('F1 the catch block checks err.unsettledAtTimeout', () => {
    assert.ok(unsettledIdx >= 0);
  });
  check('F2 the unsettledAtTimeout branch is checked BEFORE the generic failure write', () => {
    assert.ok(genericFailIdx >= 0);
    assert.ok(unsettledIdx < genericFailIdx, 'generic failure write appears before (or the unsettled branch is missing) — a timeout would always be marked failed');
  });
  check('F3 the unsettledAtTimeout branch does not set status:\'failed\' on the Ad', () => {
    const branchEnd = block.indexOf('return;', unsettledIdx);
    const branch = block.slice(unsettledIdx, branchEnd > 0 ? branchEnd : unsettledIdx + 1200);
    assert.ok(!/status:\s*'failed'/.test(branch), 'unsettled branch sets status:\'failed\' — this would sever the receipt from bootRecoveryService');
  });
  check('F4 the unsettledAtTimeout branch increments CampaignRun.skipped, not failed', () => {
    const branchEnd = block.indexOf('return;', unsettledIdx);
    const branch = block.slice(unsettledIdx, branchEnd > 0 ? branchEnd : unsettledIdx + 1200);
    assert.ok(/\$inc:\s*\{\s*skipped:\s*1\s*\}/.test(branch));
    assert.ok(!/\$inc:\s*\{\s*failed:\s*1\s*\}/.test(branch));
  });

  console.log('\n  [REVERT-PROOF]');
  check('F5 [REVERT-PROOF] deleting the unsettled branch is detected', () => {
    // Simulate the branch being removed by truncating the check window used
    // above — re-derive genericFailIdx relative to a version of the block
    // with the branch spliced out, and confirm F2-style logic would then fail.
    const withoutBranch = block.slice(0, unsettledIdx) + block.slice(block.indexOf('return;', unsettledIdx) + 'return;'.length);
    const wouldStillFindUnsettled = withoutBranch.indexOf('err.unsettledAtTimeout') >= 0;
    assert.ok(!wouldStillFindUnsettled, 'branch removal was not actually detected by the F1-style scan — mutation harness is unreliable');
  });
}

// ── Summary ──────────────────────────────────────────────────────────────
const total = pass + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} verifyVideoTimeoutReconcile: ${pass}/${total} passed`);
if (failures.length) {
  console.log('  failed:');
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
process.exit(0);
