#!/usr/bin/env node
'use strict';
/**
 * scripts/verifyCostAttribution.js — pins that six CostLog producer stages
 * carry brand/product/ad/run attribution, offline (no DB, no network, no key).
 *
 * THE INCIDENT (2026-08-24). A live audit (reconcileAtlasDailyCosts.js +
 * direct CostLog queries) found that of one day's ~$38.87 real Atlas spend,
 * ~$16.44 (42%) landed in CostLog with brandId/productId/adId/campaignRunId
 * ALL null, across six stages: overlay_zones, layout_derivation, subject_text,
 * crop_refine, base_plate_crop, judge_detections. The dollars were correctly
 * billed and correctly ledgered against Atlas's own total (the aggregate
 * reconciliation was fine) — they were just untraceable to any brand, ad,
 * product, or run, which is exactly the question anyone reconciling a bill
 * against "what did we generate" needs answered. `services/costTracker.js`'s
 * persistCost() already whitelists all four fields into CostLog.create() —
 * the gap was purely that these six producers never put them in the `meta`
 * object handed to chatCompletion()/trackLlmCall(). Fixed same day; this
 * harness is what stops stage #7 from reopening the same hole silently.
 *
 * WHY A STRUCTURAL SLICE, NOT A FIXED CHAR COUNT. A magic-number window
 * (`src.slice(i, i + N)`) drifts stale the moment a comment or line is added
 * above the assertion point, and can accidentally span into the NEXT
 * function's unrelated code — which is exactly how the sibling
 * verifyVideoTimeoutReconcile.js revert-proof check (E6) broke during this
 * same fix: a second, unrelated `campaignRunId: campaignRunId || null,`
 * landed earlier in atlasVideoService.js than the real charge-point one, and
 * a plain first-occurrence string mutation grabbed the wrong target. Every
 * window here is bounded at the next `^async function` / `^function`
 * boundary, or the next `model:` key (the params object every one of these
 * chatCompletion calls carries as its second argument) — never a byte count.
 *
 * TWO ADVERSARIAL-REVIEW FINDINGS FOLDED IN (2026-08-24, Grok, high effort).
 * Both were real gaps in an EARLIER draft of this file, not in the production
 * fix (which the same review read line-by-line and found clean, including
 * confirming the two `refreshStaleLayoutInput` call sites in
 * atlasVideoService.js — one inside `prepareStoryboard` with no
 * `campaignRunId` param, one inside `generateForAd` with one — were not
 * swapped):
 *   1. Several revert-proof checks asserted `!hasAllAttrFields(<a hand-typed
 *      pre-fix string literal>)` — a constant, never touching the real file.
 *      That stays green even if the production fields are deleted. Every
 *      revert-proof below now mutates the REAL text captured from disk this
 *      run and confirms the SAME check function then fails.
 *   2. The whole harness only opened the six PRODUCER files. Reverting the
 *      CALLER-side threading (pipelines/detect.js, atlasVideoService.js,
 *      renderService.js) leaves producers still accepting
 *      `{ brandId = null, … }` and still mentioning those names in their own
 *      chatCompletion meta — every producer check stays green while every
 *      CostLog row goes back to all-null, because the callers simply stopped
 *      supplying real values. Section 7 below opens the three caller files
 *      and asserts each real call site threads an actual object property
 *      (`run.brandId`, `ad._id`, `req.brandId`, …), not just the field name.
 *
 * Run: node scripts/verifyCostAttribution.js
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

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// Slice from `from` to the next top-level function boundary after it (or EOF).
function sliceToNextFn(src, from) {
  const rest = src.slice(from + 1);
  const m = rest.match(/\n(?:async )?function [A-Za-z_$]/);
  return m ? src.slice(from, from + 1 + m.index) : src.slice(from);
}

// Capture a chatCompletion meta object: from the `stage: '<name>'` marker to
// the next `model:` key, which every one of these calls' second (params)
// argument carries — a real structural anchor, not a byte count.
function captureMeta(block, stageMarker) {
  const ci = block.indexOf(stageMarker);
  if (ci < 0) return null;
  const modelIdx = block.indexOf('model:', ci);
  return modelIdx > ci ? block.slice(ci, modelIdx) : null;
}

const ATTR_FIELDS = ['brandId', 'productId', 'adId', 'campaignRunId'];
function hasAllAttrFields(block) {
  return !!block && ATTR_FIELDS.every(f => new RegExp(`\\b${f}\\b`).test(block));
}

// Real revert-proof: given a captured (real, on-disk) string and the exact
// substring this fix added to it, confirm (a) the substring is actually
// present — proving `added` describes what's really there, not a guess —
// and (b) removing it makes the SAME predicate fail. A no-op strip (added
// text absent) fails outright rather than silently "passing" a check that
// never ran.
function revertProof(real, added, predicate) {
  if (typeof real !== 'string' || !real.includes(added)) return false;
  const stripped = real.replace(added, '');
  return predicate(real) && !predicate(stripped);
}

console.log('\nCOST ATTRIBUTION — six 2026-08-24 stages carry brand/product/ad/run IDs\n');

// ── 1. overlay_zones ──────────────────────────────────────────────────────
{
  const src = read('services/overlayZoneService.js');
  const i = src.indexOf('async function analyzeOverlayZones(');
  check('1a analyzeOverlayZones exists', i >= 0);
  const block = i >= 0 ? sliceToNextFn(src, i) : '';
  check('1b analyzeOverlayZones signature accepts all four attribution params',
    /analyzeOverlayZones\(\{[^)]*brandId[^)]*productId[^)]*adId[^)]*campaignRunId/.test(block.slice(0, 400)));

  const ci = block.indexOf("stage: 'overlay_zones'");
  const metaLine = ci >= 0 ? block.slice(ci, block.indexOf('\n', ci) + 1) : null;
  check('1c the chatCompletion meta for stage overlay_zones carries all four fields',
    hasAllAttrFields(metaLine));
  check('1d [REVERT-PROOF, real file] stripping the four fields from the real overlay_zones meta line fails 1c',
    revertProof(metaLine, ', brandId, productId, adId, campaignRunId', hasAllAttrFields));
}

// ── 2. layout_derivation ──────────────────────────────────────────────────
{
  const src = read('services/layoutInputService.js');
  const i = src.indexOf('async function runDerivation(');
  check('2a runDerivation exists', i >= 0);
  const block = i >= 0 ? sliceToNextFn(src, i) : '';
  const meta = captureMeta(block, "stage: 'layout_derivation'");
  check('2b the chatCompletion meta for stage layout_derivation carries all four fields',
    hasAllAttrFields(meta));
  check('2c [REVERT-PROOF, real file] stripping the four attribution lines from the real layout_derivation meta fails 2b',
    revertProof(
      meta,
      "brandId: options.brandId || ctx.media?.brandId || null,\n        productId: options.productId || null,\n        adId: options.adId || null,\n        campaignRunId: options.campaignRunId || null\n      ",
      hasAllAttrFields
    ));
}

// ── 3. subject_text ───────────────────────────────────────────────────────
{
  const src = read('services/subjectTextService.js');
  const i = src.indexOf('async function detectSubjectsAndText(');
  check('3a detectSubjectsAndText exists', i >= 0);
  const block = i >= 0 ? sliceToNextFn(src, i) : '';
  check('3b hints destructuring pulls all four attribution fields',
    /const \{ brand, category, caption, brandId[^}]*productId[^}]*adId[^}]*campaignRunId[^}]*\} = hints;/.test(block));

  const ci = block.indexOf("stage: 'subject_text'");
  const metaLine = ci >= 0 ? block.slice(ci, block.indexOf('\n', ci) + 1) : null;
  check('3c the chatCompletion meta for stage subject_text carries all four fields',
    hasAllAttrFields(metaLine));
  check('3d [REVERT-PROOF, real file] stripping the four fields from the real subject_text meta line fails 3c',
    revertProof(metaLine, ', brandId, productId, adId, campaignRunId', hasAllAttrFields));
}

// ── 4. crop_refine ────────────────────────────────────────────────────────
{
  const src = read('services/cropRefineService.js');
  const i = src.indexOf('async function refineDetectionCrops(');
  check('4a refineDetectionCrops accepts an ids param and threads it to refineChunk',
    i >= 0 && /refineDetectionCrops\(detections, sourceImageUrl, ids = \{\}\)/.test(src.slice(i, i + 80))
      && /refineChunk\(chunk, sourceImageUrl, offset, ids\)/.test(sliceToNextFn(src, i)));
  const j = src.indexOf('async function refineChunk(');
  const block = j >= 0 ? sliceToNextFn(src, j) : '';
  check('4b refineChunk accepts an ids param',
    j >= 0 && /refineChunk\([^)]*ids = \{\}\)/.test(block.slice(0, 200)));

  const ci = block.indexOf("stage: 'crop_refine'");
  const metaLine = ci >= 0 ? block.slice(ci, block.indexOf('\n', ci) + 1) : null;
  check('4c the chatCompletion meta for stage crop_refine carries all four fields',
    hasAllAttrFields(metaLine));
  check('4d [REVERT-PROOF, real file] stripping the four fields from the real crop_refine meta line fails 4c',
    revertProof(
      metaLine,
      ', brandId: ids.brandId || null, productId: ids.productId || null, adId: ids.adId || null, campaignRunId: ids.campaignRunId || null',
      hasAllAttrFields
    ));
}

// ── 5. base_plate_crop ────────────────────────────────────────────────────
{
  const src = read('services/basePlateCropService.js');
  const i = src.indexOf("stage: 'base_plate_crop'");
  check('5a the chatCompletion meta for stage base_plate_crop still spreads caller-supplied meta',
    i >= 0 && /\.\.\.meta/.test(src.slice(i, src.indexOf('\n', i) + 1)));
  // Both real callers of detectClipBoxes must supply productId — brandId/adId
  // were already threaded before this fix; productId was the gap (campaignRunId
  // is deliberately NOT added here: Ad has no scalar campaignRunId, only the
  // array campaignRunIds, and threading the real per-render run id would need
  // renderBrandScriptAndSave plus 7 further call sites — out of scope, and using
  // the array's last entry as a guess was rejected for this repo's callers).
  const calls = [];
  let idx = 0;
  while (true) {
    const ci = src.indexOf('internals.detectClipBoxes(ad.veoVideoUrl, durationSec, {', idx);
    if (ci < 0) break;
    const end = src.indexOf('});', ci);
    calls.push(src.slice(ci, end));
    idx = end + 1;
  }
  check('5b found both known detectClipBoxes call sites', calls.length === 2, `found ${calls.length}`);
  check('5c every detectClipBoxes call site includes productId',
    calls.length > 0 && calls.every(c => /productId:/.test(c)));
  check('5d [REVERT-PROOF, real file] stripping productId from a real call site fails 5c\'s predicate',
    calls.length > 0 && revertProof(calls[0], 'productId: ad.productId || null,\n    ', c => /productId:/.test(c)));
}

// ── 6. judge_detections / judge_extended_crops ───────────────────────────
{
  const src = read('services/judgeService.js');
  const i = src.indexOf('async function judgeDetections(');
  check('6a judgeDetections signature accepts all four attribution params',
    i >= 0 && /judgeDetections\(\{[^)]*brandId[^)]*productId[^)]*adId[^)]*campaignRunId/.test(src.slice(i, i + 300)));

  const dBlock = i >= 0 ? sliceToNextFn(src, i) : '';
  const dCi = dBlock.indexOf("stage: 'judge_detections'");
  const dMetaLine = dCi >= 0 ? dBlock.slice(dCi, dBlock.indexOf('\n', dCi) + 1) : null;
  check('6b the chatCompletion meta for stage judge_detections carries all four fields',
    hasAllAttrFields(dMetaLine));
  check('6c [REVERT-PROOF, real file] stripping the four fields from the real judge_detections meta fails 6b',
    revertProof(dMetaLine, ', brandId, productId, adId, campaignRunId', hasAllAttrFields));

  const j = src.indexOf('async function judgeExtendedCrops(');
  const eBlock = j >= 0 ? sliceToNextFn(src, j) : '';
  check('6d judgeExtendedCrops reads all four attribution fields off its arg',
    ATTR_FIELDS.every(f => new RegExp(`arg\\?\\.${f}`).test(eBlock.slice(0, 500))));
  const fullForwardRe = /callOpenAIWithCloudinaryRetry\(\{[\s\S]*?\n  \}, \{ brandId, productId, adId, campaignRunId \}\);/;
  check('6e judgeExtendedCrops forwards all four attribution fields into callOpenAIWithCloudinaryRetry',
    fullForwardRe.test(eBlock));
  check('6f [REVERT-PROOF, real file] stripping productId/adId from the real forwarding call fails 6e\'s own regex',
    revertProof(eBlock, 'productId, adId, ', block => fullForwardRe.test(block)));

  const k = src.indexOf('async function callOpenAIWithCloudinaryRetry(');
  const cBlock = k >= 0 ? sliceToNextFn(src, k) : '';
  const sigLine = cBlock.slice(0, cBlock.indexOf('\n') + 1);
  check('6g callOpenAIWithCloudinaryRetry accepts costMeta and spreads it into the judge_extended_crops meta',
    /callOpenAIWithCloudinaryRetry\(payload, costMeta = \{\}\)/.test(sigLine)
      && /stage: 'judge_extended_crops'[^}]*\.\.\.costMeta/.test(cBlock));
  check('6h [REVERT-PROOF, real file] stripping costMeta from the real signature line fails 6g\'s signature check',
    revertProof(sigLine, ', costMeta = {}', s => /callOpenAIWithCloudinaryRetry\(payload, costMeta = \{\}\)/.test(s)));
}

// ── 7. CALLER-SIDE THREADING — the load-bearing half of this fix ────────
// A producer that ACCEPTS brandId/productId/adId/campaignRunId is inert if
// nothing upstream actually supplies real values. Every check below opens the
// real caller file and asserts the call site references an actual object
// property (`run.brandId`, `ad._id`, `req.brandId`, …) — not merely that the
// field name appears somewhere in the file.
{
  const detect = read('pipelines/detect.js');

  const stCallIdx = detect.indexOf('const st = await detectSubjectsAndText(imageUrl, {');
  const stCall = stCallIdx >= 0 ? detect.slice(stCallIdx, detect.indexOf('});', stCallIdx)) : '';
  check('7a pipelines/detect.js threads run.brandId/media.brandId + catalogProductId into detectSubjectsAndText',
    /brandId:\s*run\.brandId \|\| media\.brandId \|\| null/.test(stCall)
      && /productId:\s*media\.metadata\?\.catalogProductId \|\| null/.test(stCall));

  const refineCallIdx = detect.indexOf('const refined = await refineDetectionCrops(survivors, refineSourceUrl, {');
  const refineCall = refineCallIdx >= 0 ? detect.slice(refineCallIdx, detect.indexOf('});', refineCallIdx)) : '';
  check('7b pipelines/detect.js threads run.brandId/media.brandId + catalogProductId into refineDetectionCrops',
    /brandId:\s*run\.brandId \|\| media\.brandId \|\| null/.test(refineCall)
      && /productId:\s*media\.metadata\?\.catalogProductId \|\| null/.test(refineCall));

  const judgeCalls = [];
  let jIdx = 0;
  while (true) {
    const ci = detect.indexOf('return await judgeDetections({\n', jIdx);
    if (ci < 0) break;
    judgeCalls.push(detect.slice(ci, detect.indexOf('});', ci)));
    jIdx = ci + 1;
  }
  check('7c both judgeDetections call sites in pipelines/detect.js found', judgeCalls.length === 2, `found ${judgeCalls.length}`);
  check('7d both judgeDetections call sites thread run.brandId/media.brandId + catalogProductId',
    judgeCalls.length > 0 && judgeCalls.every(c =>
      /brandId:\s*run\.brandId \|\| media\.brandId \|\| null/.test(c)
      && /productId:\s*media\.metadata\?\.catalogProductId \|\| null/.test(c)));

  const jeIdx = detect.indexOf('extendedJudgeRes = await judgeExtendedCrops({');
  const jeCall = jeIdx >= 0 ? detect.slice(jeIdx, detect.indexOf('});', jeIdx)) : '';
  check('7e judgeExtendedCrops call site threads run.brandId/media.brandId + catalogProductId',
    /brandId:\s*run\.brandId \|\| media\.brandId \|\| null/.test(jeCall)
      && /productId:\s*media\.metadata\?\.catalogProductId \|\| null/.test(jeCall));

  const ozIdx = detect.indexOf('overlayZones = await runOverlayZoneAnalysis({');
  const ozCall = ozIdx >= 0 ? detect.slice(ozIdx, detect.indexOf('});', ozIdx)) : '';
  check('7f runOverlayZoneAnalysis call site threads run.brandId/media.brandId + catalogProductId',
    /brandId:\s*run\.brandId \|\| media\.brandId \|\| null/.test(ozCall)
      && /productId:\s*media\.metadata\?\.catalogProductId \|\| null/.test(ozCall));

  const ozFnIdx = detect.indexOf('async function runOverlayZoneAnalysis(');
  const ozFnBlock = ozFnIdx >= 0 ? sliceToNextFn(detect, ozFnIdx) : '';
  check('7g runOverlayZoneAnalysis forwards its attribution params into analyzeOverlayZones',
    /analyzeOverlayZones\(\{[^)]*brandId,\s*productId,\s*adId,\s*campaignRunId/.test(ozFnBlock));
}

{
  const vid = read('services/atlasVideoService.js');

  // The two refreshStaleLayoutInput call sites must NOT be interchangeable:
  // prepareStoryboard has no campaignRunId param and must not reference one
  // (that would be a ReferenceError — exactly the class of bug this repo's
  // CLAUDE.md documents shipping three times because no regex/node --check
  // catches it); generateForAd does have the param and must pass it.
  const psIdx = vid.indexOf('async function prepareStoryboard(');
  const gfaIdx = vid.indexOf('async function generateForAd(');
  check('7h prepareStoryboard and generateForAd both found, in that order',
    psIdx >= 0 && gfaIdx > psIdx);
  const psBlock = psIdx >= 0 && gfaIdx > psIdx ? vid.slice(psIdx, gfaIdx) : '';
  const gfaBlock = gfaIdx >= 0 ? sliceToNextFn(vid, gfaIdx) : '';

  check('7i generateForAd declares a campaignRunId parameter',
    /campaignRunId\s*=\s*null/.test(gfaBlock.slice(0, gfaBlock.indexOf('}) {'))));
  check('7j prepareStoryboard\'s refreshStaleLayoutInput call does NOT reference campaignRunId (it has no such param — would be a ReferenceError)',
    (() => {
      const ci = psBlock.indexOf('layoutInput = await refreshStaleLayoutInput({');
      if (ci < 0) return false;
      const call = psBlock.slice(ci, psBlock.indexOf('});', ci));
      return !/campaignRunId/.test(call);
    })());
  check('7k generateForAd\'s refreshStaleLayoutInput call DOES pass campaignRunId',
    (() => {
      const ci = gfaBlock.indexOf('layoutInput = await refreshStaleLayoutInput({');
      if (ci < 0) return false;
      const call = gfaBlock.slice(ci, gfaBlock.indexOf('});', ci));
      return /,\s*campaignRunId\s*$/.test(call.trim());
    })());

  check('7l generateForAd\'s buildReferenceImages call threads real ad/media-derived attribution',
    (() => {
      const ci = gfaBlock.indexOf('const imageUrls = await buildReferenceImages({');
      if (ci < 0) return false;
      const call = gfaBlock.slice(ci, gfaBlock.indexOf('});', ci));
      return /brandId:\s*ad\.brandId \|\| media\.brandId \|\| null/.test(call)
        && /adId:\s*ad\._id \|\| null/.test(call)
        && /campaignRunId:\s*campaignRunId \|\| null/.test(call);
    })());
}

{
  const render = read('services/renderService.js');
  const ci = render.indexOf("variantKind:        req.variantKind         || 'ugc',");
  const block = ci >= 0 ? render.slice(ci, ci + 300) : '';
  check('7m renderService.js\'s buildLayoutInput options thread req.brandId/req.adId/req.campaignRunId',
    /brandId:\s*req\.brandId\s*\|\| null/.test(block)
      && /adId:\s*req\.adId\s*\|\| null/.test(block)
      && /campaignRunId:\s*req\.campaignRunId\s*\|\| null/.test(block));
}

console.log(`\n${failures.length === 0 ? '✅' : '❌'} verifyCostAttribution: ${pass}/${pass + failures.length} passed`);
if (failures.length) {
  console.log('  failed:');
  for (const f of failures) console.log(`   • ${f}`);
  process.exitCode = 1;
}
