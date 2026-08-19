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
//   O*  the boot ORCHESTRATION: receipt-scoped, staleness-windowed, lease-free
//       via status-filtered idempotent writes, and wired before the reaper

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
  checkTrue('O3 the recovered-master write is status-filtered (idempotent, no lease needed)',
    /\{ _id: ad\._id, status: 'rendering' \}[\s\S]{0,200}status: 'draft'/.test(REC));
  checkTrue('O4 the failure write is status-filtered too',
    /\{ _id: ad\._id, status: 'rendering' \}[\s\S]{0,240}status: 'failed'/.test(REC));
  // O5 REWRITTEN AGAIN 2026-08-19 — the previous version of this check itself
  // pinned a bug, and its own comment said why it would one day need to.
  //
  // History: originally asserted the literal `'renderError.charged': true`
  // ("a receipt means we were billed"). Rewritten 2026-08-05 to assert video
  // was UNCONDITIONALLY charged=true via a hardcoded ternary, on the stated
  // premise that "atlasVideoService.peekPrediction does not read price back,
  // so there is nothing to confirm against". That premise stopped being true
  // (peekPrediction's failed branch already spread confirmedCharge(data) into
  // its return — the video path simply never consulted it), and CLAUDE.md §2
  // measured 5/5 real failed video predictions carry NO price field, i.e. the
  // hardcoded true permanently overstated spend on every recovered failure.
  //
  // Fixed 2026-08-19: the derivation is now `resolveRecoveredVideoFailureCharge`,
  // a tri-state read of the SAME confirmed-price field the image path already
  // uses — imported and called directly here rather than pattern-matched from
  // source text, because the whole point is to catch a hardcoded regression
  // that a text scan (as the O5 above was) cannot always tell from the
  // real thing.
  checkTrue('O5a resumed video failure derives confirmedCharge from the settled price, not a hardcoded true',
    rec.resolveRecoveredVideoFailureCharge({ charged: false, priceUsd: 0 }).confirmedCharge === false);
  checkTrue('O5b a confirmed-charged failure with a real settled price corrects the ledger to it',
    JSON.stringify(rec.resolveRecoveredVideoFailureCharge({ charged: true, priceUsd: 0.9 }).reconcile) === JSON.stringify({ costUsd: 0.9 }));
  checkTrue('O5c an UNKNOWN charge state never invents a correction (never guess)',
    rec.resolveRecoveredVideoFailureCharge({ charged: null, priceUsd: null }).reconcile === null);
  checkTrue('O5d the failure write reads its charged flag from the derivation, not a literal',
    /const \{ confirmedCharge, reconcile \} = resolveRecoveredVideoFailureCharge\(r\)/.test(REC)
    && /'renderError\.charged':\s*confirmedCharge/.test(REC));
  checkTrue('O6 the recovered master rests at draft (the reaper-safe money guard)',
    /status: 'draft'/.test(REC));
  // processing/unknown must be left alone — acting on ignorance writes off a
  // paid asset.
  checkTrue('O7 processing and unknown are left untouched for the next pass',
    /LEAVE IT ALONE/.test(REC) && /stillRunning\+\+/.test(REC));
  checkTrue('O8 recovery has a kill switch', /RESUME_IN_FLIGHT_ON_BOOT/.test(REC)
    && rec.enabled() === true);
  checkTrue('O9 recovery is bounded per pass so boot cannot hang', /RESUME_MAX_ADS/.test(REC)
    && /\.limit\(limit\)/.test(REC));
  checkTrue('O10 recovery cannot submit (it delegates to resumeForAd)',
    /resumeForAd/.test(REC) && !/pacedModelSubmit|axios\.post|submitImageGeneration/.test(REC));
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
