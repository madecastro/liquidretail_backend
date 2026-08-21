#!/usr/bin/env node
'use strict';
/**
 * Verify static-image recovery: finishing an ALREADY-PAID Atlas output into a real
 * ad, instead of buying it again. No DB, no network, no API key.
 *
 * WHY THIS PATH EXISTS (2026-08-05). Atlas retains a prediction for 30 days, so a
 * paid generation is never really lost — only its pointer is. Nine
 * openai/gpt-image-2/edit predictions were killed mid-poll by a deploy; all nine
 * were still COMPLETED at Atlas hours later with $0.5663 already billed. A live
 * dry run recovered 9/9 into finished, correctly-cropped plates.
 *
 * THE TWO INVARIANTS, both money:
 *   1. Recovery must never SUBMIT. Its only provider call is a free GET. A submit
 *      here buys a second copy of an image we already own.
 *   2. Recovery must never stamp the raw Atlas URL onto renderUrl. A static ad's
 *      model output is not a deliverable — it still owes the delivery crop and the
 *      logomark. Stamping it would ship an uncropped, unbranded image AS a
 *      successful render, which is worse than not recovering at all.
 *
 * AND the structural one that keeps 2 true over time: finishPlate has exactly ONE
 * implementation, called by both the render path and recovery. Two copies of the
 * delivery crop would drift, and the failure is silent — a mis-cropped ad still
 * looks plausible while cutting through typeset copy.
 *
 * Run: node scripts/verifyImageRecovery.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const recSrc = fs.readFileSync(path.join(ROOT, 'services/imageRecoveryService.js'), 'utf8');
const dirSrc = fs.readFileSync(path.join(ROOT, 'services/directImageRenderService.js'), 'utf8');

console.log('\nSTATIC IMAGE RECOVERY\n');

// ── A. [MONEY] NO IMAGE SUBMIT, STRUCTURALLY ─────────────────────────────
check('A1 recovery never calls a generate/edit entry point',
  !/\b(generateImage|editImage)\s*\(/.test(recSrc));
check('A2 recovery issues no HTTP POST of its own',
  !/axios\.post|\.post\(/.test(recSrc));
check('A3 free provider read is peekImagePrediction; vision LLM is optional QC only',
  /peekImagePrediction/.test(recSrc)
  && /judgeRender|maybeQcRecoveredPlate/.test(recSrc));
check('A4 it does not import atlasVideoService or a render-submit path',
  !/atlasVideoService|renderCreative|runRenderLoop/.test(recSrc));
// Pre-spend idempotency: vision call only after re-read confirms recoverability.
check('A5 [MONEY] maybeQcRecoveredPlate re-reads ad status/visionQc BEFORE judgeRender',
  (() => {
    const fn = recSrc.indexOf('async function maybeQcRecoveredPlate');
    if (fn === -1) return false;
    const body = recSrc.slice(fn, recSrc.indexOf('\nasync function ', fn + 1) === -1
      ? recSrc.indexOf('\nfunction surfaceForAd', fn)
      : recSrc.indexOf('\nasync function ', fn + 1));
    const reRead = body.indexOf('Ad.findById');
    const judge = body.indexOf('judgeRender');
    return reRead > -1 && judge > reRead
      && /visionQc/.test(body.slice(reRead, judge))
      && /draft.*live.*archived|live.*archived/.test(body.slice(reRead, judge));
  })());
// Expected text: judge call must never hard-code expectedText:[] (that means
// "pure product" and false-fails brand-line ads). Known-empty via reconstruction
// is fine; the UNKNOWN flag is required when reconstruction fails.
check('A6 recovery judge path uses expectedTextUnknown, never hard-coded []',
  (() => {
    const i = recSrc.indexOf('judgeRender({');
    if (i === -1) return false;
    const call = recSrc.slice(i, recSrc.indexOf('});', i) + 2);
    return !/expectedText:\s*\[\s*\]/.test(call)
      && /expectedTextUnknown/.test(call)
      && /resolveExpectedTextForRecovery/.test(recSrc);
  })());
// QC fail → status failed (not plain draft exportable pool).
check('A7 QC-failed recovery sets status failed (not plain draft)',
  /qcFailed\s*\?\s*['"]failed['"]\s*:\s*['"]draft['"]/.test(recSrc)
  || /status:\s*qcFailed\s*\?\s*['"]failed['"]/.test(recSrc));

// ── B. [MONEY] NEVER SHIP THE RAW ATLAS OUTPUT AS THE AD ─────────────────
check('B1 the persisted renderUrl comes from the Cloudinary upload, never from '
    + 'peek.imageUrl (which is the uncropped, unbranded model output)',
  /renderUrl\s*=\s*upload\?\.secure_url/.test(recSrc)
  && !/renderUrl:\s*peek\.imageUrl/.test(recSrc));
check('B2 the Atlas output is passed through finishPlate before upload',
  (() => {
    const fp = recSrc.indexOf('finishPlate({');
    const up = recSrc.indexOf('uploadBufferToCloudinary(');
    return fp > -1 && up > fp;
  })());
check('B3 the buffer uploaded is the FINISHED plate, not the fetched frame',
  /uploadBufferToCloudinary\(plate\.buffer/.test(recSrc));

// ── C. ONE IMPLEMENTATION OF THE DELIVERY CROP ───────────────────────────
check('C1 finishPlate is exported from directImageRenderService',
  /^\s*finishPlate,/m.test(dirSrc));
check('C2 the NORMAL render path calls it too — so there is one implementation, '
    + 'not a copy that can drift',
  /const plate = await finishPlate\(\{/.test(dirSrc));
check('C3 recovery imports it rather than reimplementing the crop',
  /require\('\.\/directImageRenderService'\)/.test(recSrc)
  && /finishPlate/.test(recSrc)
  && !/\.extract\(|\.resize\(/.test(recSrc));
check('C4 geometry is derived via computeSurface (the live derivation), not read '
    + 'from a possibly-stale copy on the Ad',
  /computeSurface\(/.test(recSrc));

// ── D. Verdicts are honest about uncertainty ─────────────────────────────
check('D1 processing/unknown are NOT written off — acting on ignorance discards a paid asset',
  /'processing' and 'unknown' are deliberately NOT written off/.test(recSrc));
check('D2 a fetch failure is retryable, not terminal (the image lives 30 days at Atlas)',
  /fetch failed/.test(recSrc) && /state: 'processing'/.test(recSrc));
check('D3 no receipt is reported as such, never as a failure',
  /return \{ state: 'no-receipt' \}/.test(recSrc));

// ── E. Idempotence + confirmed charge ────────────────────────────────────
check('E1 the persist is status-filtered so a late-finishing original render or a '
    + 'second pass cannot be clobbered',
  /status: \{ \$nin: \['draft', 'live', 'archived'\] \}/.test(recSrc));
check('E2 the charge is reconciled from the CONFIRMED settled price, not an estimate',
  /peek\.priceConfirmed/.test(recSrc) && /costSource: 'actual'/.test(recSrc));
check('E3 [SILENT-DROP] the ledger call passes a COMPLETE record — finalizeFlatCost '
    + 'falls back to an insert here (these rows predate the charge-point ledger), '
    + 'and CostLog drops any row missing `stage`',
  (() => {
    const i = recSrc.indexOf('finalizeFlatCost({');
    if (i === -1) return false;
    const call = recSrc.slice(i, recSrc.indexOf('})', i));
    return /stage:/.test(call) && /provider:/.test(call) && /model:/.test(call);
  })());
check('E4 a dryRun stops before any write — so recovery can be rehearsed against '
    + 'real paid predictions safely',
  /if \(dryRun\)/.test(recSrc)
  && recSrc.indexOf('if (dryRun)') < recSrc.indexOf('uploadBufferToCloudinary('));

// ── F. THE OPERATOR IS TOLD WHY ──────────────────────────────────────────
// A failure the operator cannot diagnose is barely better than a silent one. The
// two ads that triggered this work read "Atlas image unknown (HTTP 502 …
// Cloudflare …)" while the truth, sitting in the settled prediction, was
// "Input Prompt violates policy" — deterministic, and no retry can fix it.
// Leaving a known-wrong diagnosis in place sends someone chasing an outage that
// never happened.
const imgSrc2 = fs.readFileSync(path.join(ROOT, 'services/atlasImageService.js'), 'utf8');
const feedSrc = fs.readFileSync(path.join(ROOT, 'services/runFeedService.js'), 'utf8');

check('F1 the render failure message LEADS with the operator-facing label, not the '
    + 'internal policy name — "Model Moderation Error: …" not "moderationBlocked (HTTP…)"',
  /const heading = policy\.label \|\| `Atlas image \$\{policy\.name\}`/.test(imgSrc2));
check('F2 settle CORRECTS a stale reason once the real one is known',
  /'renderError\.message'\]\s*=|set\['renderError\.message'\]/.test(recSrc));
check('F3 the correction PRESERVES the original — a correction must not destroy '
    + 'what was previously recorded',
  /was recorded as:/.test(recSrc));
check('F4 it only overwrites when the peek actually named a cause',
  /if \(peek\.message && ad\.renderError\?\.message/.test(recSrc));
check('F5 [SLACK] the run summary reports WHY, not just how many — this is the gap '
    + 'that made "10✓ / 2✗" unactionable',
  /summariseFailures/.test(feedSrc) && /finishReasons/.test(feedSrc));
check('F6 [SLACK] the reason lookup is DETACHED, never awaited — runFeed must never '
    + 'sit on a render path, and a reporting query must not degrade a run',
  (() => {
    const i = feedSrc.indexOf('summariseFailures(rid)');
    if (i === -1) return false;
    // must be a detached .then(), never `await`ed
    const near = feedSrc.slice(i, i + 60);
    return /\.then\(/.test(near) && !/await\s+summariseFailures/.test(feedSrc);
  })());
check('F7 [SLACK] reasons are GROUPED with counts — a 20-ad run failing identically '
    + 'is one fact, not twenty lines',
  /counts\.set\(reason, \(counts\.get\(reason\) \|\| 0\) \+ 1\)/.test(feedSrc));

// ── G. [BEHAVIORAL] a stale `disabled:true` stamp must not defeat the
// pre-spend idempotency guard in maybeQcRecoveredPlate ──────────────────
// The regex checks above (A5) only prove the guard's presence, not its
// correctness. This calls the REAL function with a stubbed Ad.findById and
// a stubbed adVisionQc.isEnabled to reproduce the exact production
// scenario: an ad recovered once while AD_VISION_QC_ENABLED was OFF (so it
// carries a persisted {skipped:true, disabled:true} stamp), then recovered
// AGAIN after an operator flips the gate ON. Before the fix, the guard's
// bare `typeof fresh.visionQc === 'object'` check treated that stale
// gate-off stamp as "already inspected" and returned it verbatim — real
// QC never ran, permanently. After the fix, a `disabled:true` verdict does
// not satisfy the guard, so the function proceeds (and — because this test
// ad also has no resolvable original product image — lands on the
// `resolveOriginalProductUrl` skip branch with a fresh, distinct
// `{disabled:false, reason:'recovered without QC'}` verdict, proving real
// code executed past the guard rather than short-circuiting on the stale
// object).
async function runBehavioralChecks() {
  const Ad = require(path.join(ROOT, 'models/Ad'));
  const adVisionQc = require(path.join(ROOT, 'services/adVisionQcService'));
  const imageRecovery = require(path.join(ROOT, 'services/imageRecoveryService'));

  const origFindById = Ad.findById;
  const origIsEnabled = adVisionQc.isEnabled;
  // FIXED 2026-08-20 — maybeQcRecoveredPlate now awaits resolveEnabled(),
  // not the synchronous isEnabled() TTL-cache peek (that peek is exactly
  // the production incident this file's own header discusses: a stale
  // cache silently read a genuinely-on SystemConfig flag as off). Stubbing
  // only isEnabled() here would leave resolveEnabled() unstubbed, which
  // would fall through to a REAL (unstubbed, unreachable in this offline
  // harness) SystemConfig.findOne() Mongo call and hang for the full
  // mongoose buffering timeout before failing soft to the env default.
  const origResolveEnabled = adVisionQc.resolveEnabled;

  const staleDisabledStamp = {
    schemaVersion: 1,
    skipped: true,
    disabled: true,
    passed: false,
    reason: 'AD_VISION_QC_ENABLED=false',
    finalAttempt: null,
    maxRegenerations: 1,
    attempts: []
  };

  Ad.findById = function fakeFindById() {
    return {
      select() { return this; },
      lean() {
        return Promise.resolve({ status: 'rendering', visionQc: staleDisabledStamp });
      }
    };
  };
  adVisionQc.isEnabled = () => true; // operator flipped the gate back ON
  adVisionQc.resolveEnabled = async () => true; // same signal, on the real (awaited) gate path

  try {
    const fakeAd = {
      _id: 'fake-ad-id-for-verify-image-recovery',
      brandId: null,
      productId: null,
      campaignId: null,
      campaignRunIds: []
    };
    const verdict = await imageRecovery.maybeQcRecoveredPlate({
      ad: fakeAd,
      brand: null,
      surface: {},
      dims: { width: 1080, height: 1080 },
      renderUrl: 'https://example.test/recovered.png'
    });

    check(
      'G1 [BEHAVIORAL][MONEY] a stale disabled:true stamp does not satisfy the '
        + 'idempotency guard (would otherwise return the SAME stale object)',
      !!verdict && verdict !== staleDisabledStamp && verdict.disabled !== true,
      `got ${JSON.stringify(verdict)}`
    );
    check(
      'G2 [BEHAVIORAL] execution actually proceeds past the guard to a real '
        + 'code path (a fresh skip verdict with a DIFFERENT reason), not just '
        + 'returning a hand-shaped object',
      !!verdict && verdict.reason === 'recovered without QC',
      `got reason=${verdict && verdict.reason}`
    );
  } finally {
    Ad.findById = origFindById;
    adVisionQc.isEnabled = origIsEnabled;
    adVisionQc.resolveEnabled = origResolveEnabled;
  }
}

// ── Revert-proof (manual, per CLAUDE.md §5) ──────────────────────────────
// 1. Stamp peek.imageUrl onto renderUrl directly -> B1/B2/B3 fail (the
//    ships-an-unbranded-image regression).
// 2. Inline a sharp .extract/.resize in the recovery service instead of calling
//    finishPlate -> C3 fails (the drift regression).
// 3. Drop stage/provider/model from the finalizeFlatCost call -> E3 fails, and the
//    row is silently discarded in production. Observed live before the fix.
// 4. Remove the dryRun early return -> E4 fails.
// 5. Drop the `&& !fresh.visionQc.disabled` clause from the pre-spend guard in
//    maybeQcRecoveredPlate -> G1/G2 fail (the silent-gate regression: a
//    disabled stamp permanently defeats QC once the gate is re-enabled).
// Each verified by hand before shipping this harness.

runBehavioralChecks().finally(() => {
  if (failures.length) {
    console.error(`❌ verifyImageRecovery: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyImageRecovery: ${pass} checks passed`);
});
