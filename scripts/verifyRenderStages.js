#!/usr/bin/env node
'use strict';
/**
 * verifyRenderStages — offline harness for per-ad render stage telemetry.
 *
 * Asserts:
 *   A. services/adStage.js exists, is fire-and-forget, throttles poll ticks
 *   B. Stage vocabulary is emitted for static + video phase transitions
 *   C. No call site awaits adStage / noteRenderIssue
 *   D. Task 3 failures persist a renderError-shaped reason
 *   E. Titling failure is not counted as a clean success (Task 4)
 *
 * No network, no database.
 *   node scripts/verifyRenderStages.js
 *
 * Revert-prove (run after commenting out a known assertion target):
 *   e.g. remove `plate generation` from atlasImageService poll → B fails
 */

const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src  = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
const failures = [];

function check(label, cond) {
  if (cond) { pass++; return; }
  failures.push(label);
}

function checkTrue(label, cond) { check(label, !!cond); }

console.log('\nverifyRenderStages\n');

// ── A. adStage module contract ────────────────────────────────────────
console.log('A. services/adStage.js contract');
const stageModPath = path.join(root, 'services/adStage.js');
checkTrue('A1 services/adStage.js exists', fs.existsSync(stageModPath));
const stageSrc = src('services/adStage.js');
const adStage = require(path.join(root, 'services/adStage.js'));

checkTrue('A2 exports adStage', typeof adStage.adStage === 'function');
checkTrue('A3 exports noteRenderIssue', typeof adStage.noteRenderIssue === 'function');
checkTrue('A4 exports formatElapsed', typeof adStage.formatElapsed === 'function');
checkTrue('A5 AD_STAGE_MIN_MS documented in comment', /AD_STAGE_MIN_MS/.test(stageSrc));
checkTrue('A6 default floor is 3000', /3000/.test(stageSrc) && adStage.stageMinMs() === 3000);
checkTrue('A7 adStage never uses await (fire-and-forget)',
  !/async\s+function\s+adStage/.test(stageSrc) && !/await\s+Ad\.updateOne/.test(stageSrc));
checkTrue('A8 adStage swallows errors via .catch',
  /Ad\.updateOne\([\s\S]*?\)\.catch\(\s*\(\)\s*=>\s*\{\s*\}\)/.test(stageSrc));
checkTrue('A9 noteRenderIssue swallows errors',
  /noteRenderIssue[\s\S]*?\.catch\(\s*\(\)\s*=>\s*\{\s*\}\)/.test(stageSrc) ||
  (stageSrc.includes('function noteRenderIssue') && /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\)/.test(stageSrc)));

checkTrue('A10 formatElapsed 12s', adStage.formatElapsed(12_000) === '12s');
checkTrue('A11 formatElapsed 4m10s', adStage.formatElapsed(250_000) === '4m10s');
checkTrue('A12 stageBase strips polling suffix',
  adStage.stageBase('master video generation (9:16) — polling 4m10s (17)') ===
  'master video generation (9:16)');
checkTrue('A13 throttle compares stageBase not full string',
  /stageBase\(/.test(stageSrc) && /_lastByAd/.test(stageSrc));

// ── B. Stage vocabulary on both paths ─────────────────────────────────
console.log('\nB. stage vocabulary emitted per path');
const adsSrc    = src('routes/ads.js');
const renderSrc = src('services/renderService.js');
const directSrc = src('services/directImageRenderService.js');
const imgSrc    = src('services/atlasImageService.js');
const vidSrc    = src('services/atlasVideoService.js');
const brandSrc  = src('services/brandScriptExecutor.js');
const cropSrc   = src('services/basePlateCropService.js');

// routes must import from services/adStage, not define locally
checkTrue('B1 routes/ads imports adStage from services/adStage',
  /require\(['"]\.\.\/services\/adStage['"]\)/.test(adsSrc));
checkTrue('B2 routes/ads no longer defines function adStage',
  !/function\s+adStage\s*\(/.test(adsSrc));

// Static vocabulary (in order of pipeline)
const staticStages = [
  { file: 'renderService',   src: renderSrc,  re: /adStage\([^)]*,\s*['`]deriving layout/ },
  { file: 'directImage',     src: directSrc,  re: /adStage\([^)]*,\s*[`'"]fetching references/ },
  { file: 'directImage',     src: directSrc,  re: /adStage\([^)]*,\s*[`'"]building prompt \+ geometry/ },
  { file: 'directImage',     src: directSrc,  re: /adStage\([^)]*,\s*[`'"]plate submit/ },
  { file: 'atlasImage poll', src: imgSrc,     re: /plate generation \(\$\{|plate generation \(/ },
  { file: 'directImage',     src: directSrc,  re: /adStage\([^)]*,\s*[`'"]crop \+ logo composite/ },
  { file: 'renderService',   src: renderSrc,  re: /adStage\([^)]*,\s*['`]uploading static/ },
  { file: 'renderService',   src: renderSrc,  re: /adStage\([^)]*,\s*['`]persisting static/ },
];
staticStages.forEach((s, i) => {
  checkTrue(`B-static-${i + 1} ${s.file}: ${s.re}`, s.re.test(s.src));
});
// Poll piggyback: stage write inside the existing poll loop
checkTrue('B-static-poll piggybacks ATLAS_IMAGE poll loop',
  /pollCount\+\+[\s\S]{0,200}adStage\(meta\.adId/.test(imgSrc) ||
  /adStage\(meta\.adId[\s\S]{0,80}stageLabel/.test(imgSrc));
checkTrue('B-static-poll includes elapsed + count',
  /formatElapsed/.test(imgSrc) && /pollCount/.test(imgSrc));

// Video vocabulary
const videoStages = [
  { name: 'preparing video context', re: /adStage\([^)]*,\s*['`]preparing video context/ },
  { name: 'reference reframe',       re: /adStage\([^)]*,\s*[`'"]reference reframe/ },
  { name: 'master video submit',     re: /adStage\([^)]*,\s*[`'"]master video submit/ },
  { name: 'master video generation poll', re: /stagePrefix\s*=\s*`master video generation|master video generation \(\$\{/ },
  { name: 'downloading master',      re: /adStage\([^)]*,\s*[`'"]downloading master video/ },
  { name: 'mirror upload',           re: /adStage\([^)]*,\s*[`'"]mirror upload/ },
  { name: 'face-safe crop',          re: /adStage\([^)]*,\s*[`'"]face-safe crop/ },
  { name: 'titling',                 re: /adStage\([^)]*,\s*[`'"]titling / },
  { name: 'uploading titled',        re: /adStage\([^)]*,\s*[`'"]uploading titled video/ },
];
videoStages.forEach((s, i) => {
  const hay = adsSrc + vidSrc + brandSrc;
  checkTrue(`B-video-${i + 1} ${s.name}`, s.re.test(hay));
});
checkTrue('B-video-poll piggybacks pollPrediction tick',
  /function pollPrediction[\s\S]*?writePollStage|pollCount\+\+[\s\S]{0,80}writePollStage/.test(vidSrc));
checkTrue('B-video-poll includes elapsed + count in stage string',
  /polling \$\{formatElapsed|polling.*formatElapsed/.test(vidSrc) ||
  /`\$\{stagePrefix\} — polling \$\{formatElapsed/.test(vidSrc));

// ── C. never awaited ──────────────────────────────────────────────────
console.log('\nC. stage writes are never awaited');
const allTouched = [adsSrc, renderSrc, directSrc, imgSrc, vidSrc, brandSrc, cropSrc, stageSrc];
const joined = allTouched.join('\n');
// await adStage( or await noteRenderIssue(
checkTrue('C1 no await adStage(', !/await\s+adStage\s*\(/.test(joined));
checkTrue('C2 no await noteRenderIssue(', !/await\s+noteRenderIssue\s*\(/.test(joined));
// async adStage definition
checkTrue('C3 adStage is not async', !/async\s+function\s+adStage/.test(stageSrc));

// ── D. Task 3 — failures persist a reason ─────────────────────────────
console.log('\nD. Task 3 failures leave a legible reason on the Ad');
// Template validation skip → routes writes status + renderError
checkTrue('D1 template skip path writes renderError',
  /result\.status === ['"]skipped['"][\s\S]{0,1200}renderError/.test(adsSrc));
checkTrue('D2 template skip sets Ad status failed (not left rendering)',
  /result\.status === ['"]skipped['"][\s\S]{0,1200}status:\s*['"]failed['"]/.test(adsSrc));
checkTrue('D3 skipReason / validate stage recorded',
  /stage:\s*['"]validate['"]/.test(adsSrc) && /skipReason|skipMsg/.test(adsSrc));

// Video skipped (Atlas disabled)
checkTrue('D4 veo skipped no longer re-queues forever',
  /veoResult\.skipped[\s\S]{0,1200}status:\s*['"]failed['"]/.test(adsSrc));
checkTrue('D5 veo skipped writes renderError with reason',
  /veoResult\.skipped[\s\S]{0,1200}renderError/.test(adsSrc));
// Between veoResult.skipped and the return, status must not be re-queued.
checkTrue('D6 veo skipped does NOT set status queued',
  (() => {
    const m = adsSrc.match(/if\s*\(\s*veoResult\.skipped\s*\)\s*\{[\s\S]*?\n\s*return;/);
    return m ? !/status:\s*['"]queued['"]/.test(m[0]) : false;
  })());

// Logo compose
checkTrue('D7 logo compose failure calls noteRenderIssue',
  /logo compose failed[\s\S]{0,200}noteRenderIssue|noteRenderIssue\([\s\S]{0,120}logo/.test(directSrc));
// Layout derive
checkTrue('D8 layoutInput derive failure calls noteRenderIssue',
  /layoutInput[\s\S]{0,200}noteRenderIssue|noteRenderIssue\([\s\S]{0,80}layoutInput/.test(vidSrc));
// basePlate
checkTrue('D9 basePlate skip persists reason via noteRenderIssue',
  /noteRenderIssue[\s\S]{0,120}face-safe crop skipped|persistSkip[\s\S]{0,300}noteRenderIssue/.test(cropSrc));

// ── E. Task 4 — an untitled master is not counted as success ──────────
// REWRITTEN 2026-08-28 (backend titling removal, owner directive: "remove
// and disable the backend titling function, we are not going to go back to
// it"). routes/ads.js no longer attempts Remotion titling in-process at
// all (brandScriptExecutor.renderBrandScriptAndSave is no longer called
// from here), so there is no more "titling failure" outcome to distinguish
// from success — every video ad this loop ships goes through
// qcAndStampVideoAd unconditionally. E2/E3/E4/E6 (which pinned the
// titlingFailed branch's status/$inc/gating) are retired with the branch
// they tested; E1/E5 (below) still hold structurally against a hypothetical
// reintroduction. The real remaining "not a clean success" gate on this
// path is vision QC, which is still live: a real failure still stamps
// status:'failed' via qcAndStampVideoAd → buildVideoQcFailureFields
// (brandScriptExecutor.js), and the promotion write below is still
// allowlist-guarded ($in:['rendering','draft']) so it can never resurrect
// that verdict — see E7.
console.log('\nE. Task 4 — untitled master is not counted as success');
checkTrue('E1 no titling catch that only console.warns survives (there is no more titling catch at all)',
  !/catch\s*\(\s*scriptErr\s*\)\s*\{\s*console\.warn\(`⚠️ brandScript/.test(adsSrc));
checkTrue('E5 [REVERT GUARD] "titlingFailed" does not reappear without this file being updated',
  !/titlingFailed/.test(adsSrc),
  'if this fails, someone reintroduced a titling-failure branch — update this Group E to pin it again');
checkTrue('E7 the promotion write is still allowlist-guarded against an already-stamped verdict',
  /status:\s*\{\s*\$in:\s*\[\s*['"]rendering['"],\s*['"]draft['"]\s*\]\s*\}/.test(adsSrc),
  'a video ad promoted to draft without this guard can overwrite a real vision-QC failure');

// ── F. claimAdsForRun untouched (structural smoke) ────────────────────
console.log('\nF. money claim path still present (smoke — full proof is verifyRunsClaim)');
checkTrue('F1 claimAdsForRun still exported',
  /module\.exports\.claimAdsForRun\s*=\s*claimAdsForRun/.test(adsSrc));
checkTrue('F2 claim filter still has status queued',
  /status:\s*['"]queued['"]/.test(adsSrc) && /function claimAdsForRun/.test(adsSrc));

// ── Report ────────────────────────────────────────────────────────────
// Fix double-count on A10: recount pass for failed A10 if any
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyRenderStages: ${failures.length} of ${total} checks FAILED\n`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`\n✅ verifyRenderStages: ${total}/${total} checks passed`);
console.log('   stage vocabulary static+video, never-awaited writes, Task 3/4 outcomes.');
