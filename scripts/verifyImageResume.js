#!/usr/bin/env node
'use strict';
/**
 * Verify static-image spend-receipt capture + the no-submit resume primitive.
 * No DB, no network, no API key.
 *
 * WHAT WAS BROKEN (found 2026-08-05 while asking "is the 600s image timeout long
 * enough?"). Providers charge at SUBMIT, so services/spendReceipt.js exists to stop a
 * requeue re-buying work we already paid for, and its header promises receipts are kept
 * "so the asset can be recovered for free instead of re-bought". Its image arm reads
 * `Ad.imageGeneration.predictionId` — but that field was only ever written by
 * renderService.persistStage, i.e. ON SUCCESS. So for the failure cases the guard
 * exists to protect (timeout, crash mid-poll) there was NO receipt at all:
 *   - a paid image was unrecoverable, and
 *   - the ad was requeue-eligible, i.e. a second billable submit for one image.
 * Meanwhile bootRecoveryService — "collect generations we already paid for" — matched
 * those ads via HAS_RECEIPT but selected only `veoPredictionId` and called the
 * video-only `resumeForAd`, which returns {state:'no-receipt'}, so every stranded
 * STATIC ad was silently tallied as 'unknown' and left in `rendering` forever.
 *
 * THE ONE THING THIS HARNESS MUST NOT LET REGRESS: the resume path may never submit.
 * It exists to collect an already-paid asset; a submit there would double-charge.
 *
 * Run: node scripts/verifyImageResume.js
 */

const fs = require('fs');
const path = require('path');
const atlasImage = require('../services/atlasImageService');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const imgSrc  = fs.readFileSync(path.join(ROOT, 'services/atlasImageService.js'), 'utf8');
const bootSrc = fs.readFileSync(path.join(ROOT, 'services/bootRecoveryService.js'), 'utf8');

console.log('\nIMAGE SPEND RECEIPT + RESUME\n');

// ── A. NO-SUBMIT GUARANTEE (the money-critical invariant) ─────────────────
const resumeRegion = imgSrc.slice(imgSrc.indexOf('async function peekImagePrediction'));
check('A1 the resume region exists at all',
  imgSrc.includes('async function peekImagePrediction') && imgSrc.includes('async function resumeImageForAd'));
check('A2 [MONEY] the resume region contains NO axios.post — it can only read',
  !/axios\.post/.test(resumeRegion));
check('A3 [MONEY] the resume region does NOT call submitAndPoll / generateImage / editImage',
  !/submitAndPoll\s*\(|(?<!function )\bgenerateImage\s*\(|(?<!function )\beditImage\s*\(/.test(resumeRegion));
check('A4 the resume region does issue a GET against /model/prediction/',
  /axios\.get\(/.test(resumeRegion) && /model\/prediction\//.test(resumeRegion));
check('A5 both resume primitives are exported',
  /module\.exports\s*=\s*\{[\s\S]*peekImagePrediction[\s\S]*\}/.test(imgSrc)
  && /module\.exports\s*=\s*\{[\s\S]*resumeImageForAd[\s\S]*\}/.test(imgSrc));

// ── B. BEHAVIOR of resumeImageForAd, no network needed ────────────────────
(async () => {
  const noReceipt = await atlasImage.resumeImageForAd({ ad: {} });
  check('B1 an ad with no receipt returns state:no-receipt and never claims resumed',
    noReceipt.state === 'no-receipt' && noReceipt.resumed === false,
    JSON.stringify(noReceipt));

  const nullAd = await atlasImage.resumeImageForAd({});
  check('B2 a missing ad is handled without throwing',
    nullAd && nullAd.state === 'no-receipt', JSON.stringify(nullAd));

  const noId = await atlasImage.peekImagePrediction(null);
  check('B3 peekImagePrediction(null) is state:unknown, not a throw and not a submit',
    noId.state === 'unknown', JSON.stringify(noId));

  // resumeImageForAd must NEVER report resumed:true — a located image is not a
  // delivered ad (it still needs crop + logo + upload). If someone later wires
  // delivery, they must change this assertion deliberately, not by accident.
  check('B4 [CONTRACT] resumeImageForAd never returns resumed:true, because a located '
      + 'image is not yet a deliverable ad (crop + logo + upload still owed)',
    !/resumed:\s*true/.test(resumeRegion));

  // ── C. CHARGE-POINT RECEIPT ────────────────────────────────────────────
  const chargePoint = imgSrc.slice(
    imgSrc.indexOf('const id = submit.data.data.id;'),
    imgSrc.indexOf('while (Date.now() - t0 < generationTimeoutMs)')
  );
  check('C1 the receipt is written at the CHARGE POINT (after the submit id, before the poll loop)',
    chargePoint.includes('imageGeneration') && chargePoint.includes('predictionId'));
  check('C2 [TRAP] it uses an aggregation-pipeline $mergeObjects, NOT a dotted '
      + '$set of imageGeneration.predictionId — models/Ad.js defaults imageGeneration to '
      + 'null, and MongoDB cannot create a field inside a null element, so the dotted '
      + 'form would throw on the first render of every ad',
    /\$mergeObjects/.test(chargePoint)
    && !/['"]imageGeneration\.predictionId['"]\s*:/.test(chargePoint));
  check('C3 it preserves any existing imageGeneration ($cond on $type, so a regenerate '
      + "cannot clobber the prior render's submission record)",
    /\$type/.test(chargePoint) && /\$cond/.test(chargePoint));
  check('C4 it is guarded on meta.adId so non-ad callers stay silent',
    /if\s*\(meta\.adId\)/.test(chargePoint));
  check('C5 it is non-fatal (try/catch) — bookkeeping must never fail a POST-payment render',
    /try\s*\{/.test(chargePoint) && /catch/.test(chargePoint));
  check('C6 it marks the partial shape receiptOnly so a reader can tell it from the full record',
    /receiptOnly/.test(chargePoint));

  // ── D. bootRecoveryService routes by receipt ────────────────────────────
  check('D1 bootRecovery imports resumeImageForAd', /resumeImageForAd/.test(bootSrc));
  check('D2 it selects imageGeneration (HAS_RECEIPT matches on it, so selecting only '
      + 'veoPredictionId is what wrote off every stranded static ad as unknown)',
    /\.select\(['"][^'"]*imageGeneration/.test(bootSrc));
  check('D3 it routes on which receipt the ad holds, not on ad.kind',
    /isImageReceipt/.test(bootSrc)
    && /!ad\.veoPredictionId\s*&&\s*!!ad\.imageGeneration\?\.predictionId/.test(bootSrc));
  check('D4 [MONEY/CORRECTNESS] a located image is NOT stamped onto renderUrl — that would '
      + 'ship an uncropped, unbranded image as a successful render',
    (() => {
      const i = bootSrc.indexOf('isImageReceipt && r.state ===');
      if (i === -1) return false;
      // Bound the window to THIS branch only — it ends at its `continue;`. A fixed
      // char window overruns into the video 'done' branch below, which legitimately
      // DOES stamp renderUrl/status:'draft', and would false-positive forever.
      const end = bootSrc.indexOf('continue;', i);
      if (end === -1) return false;
      const branch = bootSrc.slice(i, end);
      return !/renderUrl/.test(branch) && !/status:\s*['"]draft['"]/.test(branch);
    })());
  check('D5 the image branch is counted separately and never folded into `recovered`',
    /recoverableNotCollected/.test(bootSrc)
    && !/out\.recovered\+\+[\s\S]{0,80}recoverableNotCollected/.test(bootSrc));
  check('D6 the failure branch records WHICHEVER receipt exists (hardcoding veoPredictionId '
      + 'wrote null for every static ad, losing the handle to real spend)',
    /renderError\.predictionId['"]\]?\s*:\s*ad\.veoPredictionId\s*\|\|\s*ad\.imageGeneration\?\.predictionId/.test(bootSrc));

  // ── E. A CHARGE IS CONFIRMED, NEVER ASSUMED (owner rule, CLAUDE.md §2) ────
  // A receipt proves a SUBMIT, not a CHARGE: Atlas refunds failed tasks, and the
  // authoritative figure is `price` on the settled prediction. The peek already
  // fetches that body, so discarding `price` and hardcoding charged:true was
  // asserting spend we had not confirmed.
  check('E1 peekImagePrediction reads Atlas\'s settled `price` back and reports whether it is confirmed',
    /priceConfirmed/.test(resumeRegion) && /data\.price/.test(resumeRegion));
  check('E2 every peek outcome reached AFTER the price parse carries the charge evidence',
    (() => {
      // Scope to peekImagePrediction's own body — resumeImageForAd's `no-receipt`
      // return legitimately has no charge (there is no prediction to price), and a
      // region-wide scan would wrongly demand one. Count-based rather than
      // per-return regex because two of the four outcomes are ternary branches
      // (`return url ? {...} : {...}`), which a /return\s*\{/ pattern misses
      // entirely — that false negative is what this replaced.
      const peekBody = imgSrc.slice(
        imgSrc.indexOf('async function peekImagePrediction'),
        imgSrc.indexOf('async function resumeImageForAd')
      );
      const afterParse = peekBody.slice(peekBody.indexOf('const rawPrice'));
      const spreads = (afterParse.match(/\.\.\.charge\b/g) || []).length;
      // done, completed-no-output, failed, processing = 4 post-parse outcomes.
      return spreads >= 4;
    })());
  check('E3 [MONEY] bootRecovery does NOT hardcode charged:true for an image — the charged flag '
      + 'itself must be derived from a confirmed price',
    (() => {
      // Scope to the confirmedCharge ASSIGNMENT. A bootSrc-wide regex for the
      // priceConfirmed expression false-passes, because the same expression also
      // guards the reconcileCost call below — verified: hardcoding the image branch
      // to `true` left that wide check green. The flag's own derivation is the thing
      // under test.
      const i = bootSrc.indexOf('const confirmedCharge');
      if (i === -1) return false;
      const assignment = bootSrc.slice(i, bootSrc.indexOf(';', i));
      return /priceConfirmed\s*===\s*true/.test(assignment)
        && /Number\(r\.price\)\s*>\s*0/.test(assignment);
    })());
  check('E4 the unconfirmed case is recorded as UNCONFIRMED in the message, not silently as free',
    /charge UNCONFIRMED/.test(bootSrc));
  check('E5 a confirmed price is reconciled into the ledger (Atlas\'s real figure, not base_price)',
    /reconcileCost\(\{\s*providerRequestId/.test(bootSrc));
  check('E6 [SCOPE] video billing semantics are left untouched — peekPrediction does not read '
      + 'price back, so there is nothing to confirm against',
    /VIDEO IS UNCHANGED ON PURPOSE/.test(bootSrc));

  // ── Revert-proof note (manual, per CLAUDE.md §5) ─────────────────────────
  // 1. Delete the charge-point block  -> C1..C6 fail (6).
  // 2. Swap $mergeObjects for a dotted `'imageGeneration.predictionId': id` $set
  //    -> C2 fails (and the code would throw in prod on any ad with null imageGeneration).
  // 3. Make the bootRecovery image branch stamp renderUrl/status:'draft'
  //    -> D4 fails (the "ships an unbranded image as success" regression).
  // 4. Revert bootRecovery's .select() to '_id veoPredictionId' -> D2 fails.
  // 5. Add an axios.post to the resume region -> A2 fails (the double-charge regression).
  // Each verified by hand before shipping this harness.

  if (failures.length) {
    console.error(`❌ verifyImageResume: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyImageResume: ${pass} checks passed`);
})();
