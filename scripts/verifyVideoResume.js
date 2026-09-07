#!/usr/bin/env node
'use strict';
//
// verifyVideoResume — pins the one property that makes resume safe:
//
//   RESUMING A GENERATION MUST NEVER SUBMIT ONE.
//
// WHY THIS EXISTS (2026-08-04):
//   Ad.veoPredictionId is a spend receipt: the provider charged at submit. The
//   only correct response to finding one is to COLLECT what we already paid
//   for. A submit on this path pays a second time for the same asset — the hole
//   services/spendReceipt.js documents, and the reason "restart in-progress
//   generations" had to be built as RESUME rather than RESTART.
//
//   peekPrediction is a single GET on purpose. pollPrediction blocks up to
//   MAX_POLL_MS (10 min), which is correct inside a render and wrong at boot:
//   recovery must not hold startup open, and an ad still processing is simply
//   re-checked on the next sweep.
//
// This harness is pure + offline: no DB, no network, no API key. The behavioural
// cases are the ones reachable without a provider (missing receipt, missing
// key); the no-submit guarantee is asserted on the SOURCE, because a unit test
// cannot prove the absence of a call it never happens to trigger.
//   node scripts/verifyVideoResume.js
//
// Revert-prove:
//   (a) Add any submit call (axios.post / submitImageGeneration /
//       pacedModelSubmit) inside peekPrediction or resumeForAd -> N* fail.
//   (b) Make peekPrediction return 'failed' on a transport error instead of
//       'unknown' -> U1 fails.
//   (c) Make a completed-with-no-output return 'processing' -> C1 fails.
//   Report the failing output verbatim when proving.
//
// Covered:
//   N*  neither function can submit (the money guarantee)
//   B*  behaviour reachable offline: no receipt, no key, no id
//   U*  'unknown' is distinct from 'failed' — a transport error is NOT a failure
//   C*  completed-without-output is a classified failure, not still-running
//   O*  the boot ORCHESTRATION: IMAGE-receipt recovery only (video-receipt
//       arm including resolveRecoveredVideoFailureCharge is deleted; adgen
//       owns collecting a stranded Omni master). Receipt-scoped, staleness-
//       windowed, lease-free via status-filtered idempotent writes, wired
//       before the reaper.

const fs   = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'services', 'atlasVideoService.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const { peekPrediction, resumeForAd } = require('../services/atlasVideoService');

let pass = 0;
const failures = [];
function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(label + (extra ? ` — ${extra}` : ''));
}

// Extract a function body by brace matching so an assertion cannot be satisfied
// (or broken) by code in a neighbouring function.
function bodyOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return '';
  // Skip the PARAMETER LIST first. `async function resumeForAd({ ad } = {}) {`
  // has braces in its params, so searching for the next '{' after the name
  // returns the destructuring pattern — a 6-character "body" that silently
  // passes every absence assertion. Find the params' closing ')' first.
  const paren = src.indexOf('(', at);
  let pdepth = 0, afterParams = -1;
  for (let i = paren; i >= 0 && i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { afterParams = i; break; } }
  }
  if (afterParams < 0) return '';
  const open = src.indexOf('{', afterParams);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function braceSlice(src, openIdx) {
  if (openIdx < 0 || src[openIdx] !== '{') return '';
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return '';
}

// Three Ad.updateOne sites share the identical `{ _id, status:'rendering' }`
// filter. A `{0,N}` window from that filter to `status: 'failed'` is
// satisfied by the IMAGE failure write (~74 chars), so the VIDEO failure
// write can change and the pin stays green. Classify each write by unique
// neighbouring fields in its $set operand and assert THAT write's status.
function adUpdateOnes(src) {
  const code = stripComments(src);
  const out = [];
  let from = 0;
  while (true) {
    const idx = code.indexOf('Ad.updateOne(', from);
    if (idx < 0) break;
    const paren = code.indexOf('(', idx);
    const filterOpen = code.indexOf('{', paren);
    const filter = braceSlice(code, filterOpen);
    const updateOpen = filter ? code.indexOf('{', filterOpen + filter.length) : -1;
    const update = braceSlice(code, updateOpen);
    out.push({ filter, update });
    from = idx + 1;
  }
  return out;
}

// ── N: the money guarantee ───────────────────────────────────────────
// Every way this file can spend money. If any appears in a resume body, a
// restart re-buys an asset we already own.
const SUBMIT_MARKERS = [
  'axios.post',            // any POST on this service is a billable submit
  'submitImageGeneration',
  'pacedModelSubmit',      // the gate every billable submit passes through
  'generateForAd'
];
for (const [name, decl] of [
  ['peekPrediction', 'async function peekPrediction'],
  ['resumeForAd',    'async function resumeForAd']
]) {
  const body = bodyOf(SRC, decl);
  checkTrue(`N0 ${name} body extracted`, body.length > 40, `${body.length} chars`);
  for (const marker of SUBMIT_MARKERS) {
    checkTrue(`N1 ${name} contains no submit call (${marker})`, !body.includes(marker));
  }
  // Positive: it must actually be a GET, not merely free of POSTs.
  if (name === 'peekPrediction') {
    checkTrue('N2 peekPrediction reads via GET', /axios\.get\(/.test(body));
    checkTrue('N3 peekPrediction is single-shot — no poll loop',
      !/while \(/.test(body) && !/MAX_POLL_MS/.test(body));
  }
}
checkTrue('N4 resumeForAd delegates to peekPrediction rather than its own request',
  /peekPrediction\(/.test(bodyOf(SRC, 'async function resumeForAd')));

// ── B: offline behaviour ─────────────────────────────────────────────
(async () => {
  const noReceipt = await resumeForAd({ ad: {} });
  checkTrue('B1 an ad with no receipt is not resumed', noReceipt.resumed === false);
  checkTrue('B2 and it is reported as no-receipt, not as a failure',
    noReceipt.state === 'no-receipt', JSON.stringify(noReceipt));
  const noArgs = await resumeForAd();
  checkTrue('B3 resumeForAd tolerates no arguments', noArgs.resumed === false);

  const nullId = await peekPrediction(null);
  checkTrue('B4 peekPrediction with no id returns unknown, never failed',
    nullId.state === 'unknown', JSON.stringify(nullId));

  // ── U: unknown must never be conflated with failed ─────────────────
  // A transport error tells us NOTHING about the prediction. Calling it failed
  // is how a paid asset gets written off — or re-submitted.
  const body = bodyOf(SRC, 'async function peekPrediction');
  checkTrue('U1 a transport error yields unknown, not failed',
    /catch \(err\) \{\s*return \{ state: 'unknown'/.test(body));
  checkTrue('U2 a non-200 yields unknown, not failed',
    /res\.status !== 200[\s\S]{0,120}state: 'unknown'/.test(body));
  checkTrue('U3 a missing API key yields unknown rather than pretending to know',
    /apiKey\(\)[\s\S]{0,120}state: 'unknown'/.test(body));

  // ── C: completed-with-no-output is a failure, not still-running ─────
  checkTrue('C1 completed without an output url is a classified failure',
    /completed with no output url/.test(body) && /completedNoOutput/.test(body));
  // A failed prediction must be classified, so a moderation block is named
  // rather than shown as a generic fault (see atlasErrorPolicy).
  checkTrue('C2 a failed prediction is classified through atlasErrorPolicy',
    /classify\(\{/.test(body) && /policy\.label/.test(body));

  // ── O: boot orchestration ──────────────────────────────────────────
  const REC = fs.readFileSync(path.join(__dirname, '..', 'services', 'bootRecoveryService.js'), 'utf8');
  const WRK = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  const rec = require('../services/bootRecoveryService');

  checkTrue('O1 recovery only considers ads that HOLD a receipt',
    /HAS_RECEIPT/.test(REC) && /status: 'rendering'/.test(REC));
  // renderOne heartbeats updatedAt every 60s, so a staleness window is what
  // stops us stamping `draft` underneath an instance that is still rendering.
  checkTrue('O2 recovery only touches ads stale past a heartbeat window',
    /updatedAt: \{ \$lt: cutoff \}/.test(REC) && /RESUME_STALE_MIN/.test(REC));
  // Lease-free: safety comes from the status filter on every write, so two
  // instances booting together cannot conflict.
  const recWrites = adUpdateOnes(REC).filter((w) =>
    /status:\s*'rendering'/.test(w.filter)
  );
  const recoveredMaster = recWrites.find((w) => /veoVideoUrl/.test(w.update));
  const videoFailure = recWrites.find((w) =>
    /renderError\.charged/.test(w.update) && /veoPredictionId/.test(w.update)
  );
  // O3/O4 VIDEO recovered-master / video-failure writes are gone. This
  // backend's bootRecovery is IMAGE-receipt only; adgen recovers video.
  checkTrue('O3 bootRecovery no longer writes a recovered video master (veoVideoUrl stamp gone)',
    !recoveredMaster);
  const imageFailure = recWrites.find((w) =>
    /renderError\.charged/.test(w.update) && /imageGeneration/.test(w.update)
  );
  checkTrue('O4 the IMAGE failure write is status-filtered (idempotent, no lease needed)',
    !!imageFailure
      && /status:\s*'rendering'/.test(imageFailure.filter)
      && /status:\s*'failed'/.test(imageFailure.update));
  void videoFailure;
  // O5 resolveRecoveredVideoFailureCharge was the VIDEO-receipt charge
  // derivation. Deleted with the video arm. IMAGE failure uses
  // ir.priceConfirmed === true && Number(ir.price) > 0 inline.
  checkTrue('O5 resolveRecoveredVideoFailureCharge is no longer exported (video-receipt recovery is adgen)',
    typeof rec.resolveRecoveredVideoFailureCharge !== 'function');
  checkTrue('O5d IMAGE failure charged flag is derived from peek price, not a hardcoded true',
    /const confirmedCharge = ir\.priceConfirmed === true && Number\(ir\.price\) > 0/.test(REC)
    && /'renderError\.charged':\s*confirmedCharge/.test(REC));
  checkTrue('O6 IMAGE recovery delegates to recoverImage / recoverImageAd (not a video draft stamp)',
    /recoverImage\(\s*\{\s*ad\s*\}\)/.test(REC) || /recoverImageAd/.test(REC));
  // processing/unknown must be left alone — acting on ignorance writes off a
  // paid asset. IMAGE arm still has this.
  checkTrue('O7 processing and unknown are left untouched for the next pass',
    /stillRunning\+\+/.test(REC));
  checkTrue('O8 recovery has a kill switch', /RESUME_IN_FLIGHT_ON_BOOT/.test(REC)
    && rec.enabled() === true);
  checkTrue('O9 recovery is bounded per pass so boot cannot hang', /RESUME_MAX_ADS/.test(REC)
    && /\.limit\(limit\)/.test(REC));
  checkTrue('O10 recovery cannot submit (it delegates to recoverImageAd)',
    /recoverImageAd|recoverImage/.test(REC)
    && !/pacedModelSubmit|axios\.post|submitImageGeneration/.test(REC));
  // Wiring: recovery must run BEFORE the reaper, and must not be able to crash
  // boot — an unhandled rejection in fire-and-forget work is the crash class
  // this whole effort came from.
  const bootOrder = WRK.indexOf('recoverTick()') < WRK.indexOf('await reapOrphans()');
  checkTrue('O11 recovery is wired BEFORE the boot reap', bootOrder);
  checkTrue('O12 recovery failures cannot crash boot', /boot recovery failed/.test(WRK));
  checkTrue('O13 recovery also runs on the reap interval (processing ads need re-checking)',
    /setInterval\(\(\) => \{\s*recoverTick\(\);/.test(WRK));

  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifyVideoResume: ${pass}/${total} passed, ${failures.length} FAILED`);
    for (const f of failures) console.error('  FAIL', f);
    process.exit(1);
  }
  console.log(`verifyVideoResume: ${pass}/${total} passed`);
  process.exit(0);
})().catch((err) => {
  console.error('verifyVideoResume: harness error —', err.message);
  process.exit(1);
});
