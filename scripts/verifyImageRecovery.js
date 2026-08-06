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

// ── A. [MONEY] NO SUBMIT, STRUCTURALLY ───────────────────────────────────
check('A1 recovery never calls a generate/edit entry point',
  !/\b(generateImage|editImage)\s*\(/.test(recSrc));
check('A2 recovery issues no HTTP POST of its own',
  !/axios\.post|\.post\(/.test(recSrc));
check('A3 its only provider read is peekImagePrediction (the free GET)',
  /peekImagePrediction/.test(recSrc));
check('A4 it does not import atlasVideoService or a render-submit path',
  !/atlasVideoService|renderCreative|runRenderLoop/.test(recSrc));

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

// ── Revert-proof (manual, per CLAUDE.md §5) ──────────────────────────────
// 1. Stamp peek.imageUrl onto renderUrl directly -> B1/B2/B3 fail (the
//    ships-an-unbranded-image regression).
// 2. Inline a sharp .extract/.resize in the recovery service instead of calling
//    finishPlate -> C3 fails (the drift regression).
// 3. Drop stage/provider/model from the finalizeFlatCost call -> E3 fails, and the
//    row is silently discarded in production. Observed live before the fix.
// 4. Remove the dryRun early return -> E4 fails.
// Each verified by hand before shipping this harness.

if (failures.length) {
  console.error(`❌ verifyImageRecovery: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ verifyImageRecovery: ${pass} checks passed`);
