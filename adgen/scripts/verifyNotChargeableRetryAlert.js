#!/usr/bin/env node
'use strict';
//
// verifyNotChargeableRetryAlert — Slack visibility on the EXISTING
// not-chargeable video retry. Does NOT add or widen any retry policy.
//
// SCOPE. The retry itself is already live: mayRetryAfterFailure() + the
// atlasErrorPolicy.js `predictionFailed` policy (commit 76a7740, 2026-08-21)
// auto-retries a settled Atlas failure up to 3 attempts when Atlas's own
// record confirms it was not chargeable (no `price` field). That gate
// already fired in production. The only gap this change closes is Slack:
// ops had zero visibility that the retry-and-often-fail cycle was happening.
//
// SEPARATE FROM verifySubmitGuard.js: that harness pins the SUBMIT-time
// replay decision (submitRetryDecision / isDefinite429) — the raw POST,
// before any predictionId exists. It is UNCHANGED by this work and is not
// consulted here.
//
// WHAT THIS FILE ACTUALLY ADDS
//   Group A — execution: the two real production error strings still retry,
//             bounded, via the existing gate. buildClassifiedFailureError
//             stamps err.providerMessage so the alert can quote Atlas
//             verbatim without re-parsing err.message.
//   Group B — execution: every class that must NOT auto-retry still doesn't
//             (regression lock on the unchanged money gate).
//   Group C — execution: buildNotChargeableRetryAlert payload is verbose
//             and truthful (this event only — no claims about other
//             failure classes). Always a master: generateForAd is
//             unreachable for derives.
//   Group D — structural: the notifyAsync call is wired on the RETRY
//             branch only. The source window STARTS AFTER the
//             `if (!mayRetry) { ... }` closing brace (a prior draft
//             started before that `if`, so moving the alert onto the
//             non-retry arm still passed). The try/catch check matches
//             the alert's OWN try, not an earlier `try { finalizeFlatCost }`
//             inside the non-retry arm.
//
// Pure + offline: no DB, no network, no API key, no Slack token.
//   node scripts/verifyNotChargeableRetryAlert.js

const fs = require('fs');
const path = require('path');

// atlasVideoService → layoutInputService → stageTiming → src/config.js, which
// process.exit(1)s unless ADGEN_ROLE + MONGODB_URI are set (and Cloudinary /
// Atlas keys for renderer). Same placeholder pattern as
// scripts/verifyStageTiming.js. `||=` so a real local .env is never clobbered.
process.env.ADGEN_ROLE = process.env.ADGEN_ROLE || 'renderer';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/adgen_verify_placeholder';
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'verify-placeholder';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'verify-placeholder';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'verify-placeholder';
process.env.ATLAS_API_KEY = process.env.ATLAS_API_KEY || 'verify-placeholder';

const {
  mayRetryAfterFailure,
  confirmedCharge,
  buildClassifiedFailureError,
  buildNotChargeableRetryAlert
} = require('../src/services/atlasVideoService');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function checkTrue(label, cond) {
  if (cond) { pass++; return; }
  failures.push(`${label}\n      expected condition to be true, was false`);
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

/** Brace matcher that skips quotes, comments, and template interpolations. */
function indexOfMatchingBrace(src, openIdx) {
  if (openIdx < 0 || src[openIdx] !== '{') return -1;
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          const innerClose = indexOfMatchingBrace(src, i + 1);
          i = innerClose === -1 ? src.length : innerClose + 1;
          continue;
        }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Atlas's documented shape for a settled FAILED prediction — status
 *  present, price ABSENT ENTIRELY (measured live 2026-08-10). */
function settledFailedNoPrice(msg, extra = {}) {
  return { status: 'failed', error: msg, outputs: null, executionTime: 0, ...extra };
}

// ── A. The two REAL production messages retry, bounded ────────────────
const PROD_MSG_1 = 'INTERNAL';
const PROD_MSG_2 = 'An exception occurred during the generation process. Please initiate the request again.';

for (const [tag, msg] of [['A-msg1', PROD_MSG_1], ['A-msg2', PROD_MSG_2]]) {
  const data = settledFailedNoPrice(msg);
  const err = buildClassifiedFailureError('pred-abc123', 'failed', data);

  check(`${tag} classifies as predictionFailed`, err.atlasPolicy, 'predictionFailed');
  check(`${tag} charge is confirmed FALSE (Atlas settled record has no price)`, err.chargeConfirmed, false);
  check(`${tag} policy is retryable`, err.policyRetryable, true);
  check(`${tag} policy caps at 3 attempts`, err.policyMaxAttempts, 3);
  check(`${tag} err.providerMessage carries Atlas's raw text, undecorated`, err.providerMessage, msg);
  checkTrue(`${tag} err.message matches the exact observed production string`,
    err.message === `atlasVideo: prediction failed: ${msg} (id=pred-abc123)`);

  check(`${tag} mayRetryAfterFailure(attempt=1,max=3) is true`,
    mayRetryAfterFailure({
      policyRetryable: err.policyRetryable,
      chargeConfirmed: err.chargeConfirmed,
      attempt: 1,
      maxAttempts: err.policyMaxAttempts
    }),
    true);
  check(`${tag} mayRetryAfterFailure(attempt=2,max=3) is still true (last allowed attempt)`,
    mayRetryAfterFailure({
      policyRetryable: err.policyRetryable,
      chargeConfirmed: err.chargeConfirmed,
      attempt: 2,
      maxAttempts: err.policyMaxAttempts
    }),
    true);
  check(`${tag} mayRetryAfterFailure(attempt=3,max=3) is false (exhausted)`,
    mayRetryAfterFailure({
      policyRetryable: err.policyRetryable,
      chargeConfirmed: err.chargeConfirmed,
      attempt: 3,
      maxAttempts: err.policyMaxAttempts
    }),
    false);
}

// ── B. DISJOINT from every class that must NOT auto-retry ─────────────
// The retry gate is unchanged. These lock that this visibility work did
// not silently start retrying anything it shouldn't.
{
  const data = settledFailedNoPrice('Your input or generated content was blocked by safety review.');
  const err = buildClassifiedFailureError('pred-mod', 'failed', data);
  check('B1 moderationBlocked classifies correctly', err.atlasPolicy, 'moderationBlocked');
  check('B1 moderationBlocked is NOT policy-retryable', err.policyRetryable, false);
  check('B1 moderationBlocked chargeConfirmed is still false (Atlas confirms unbilled)', err.chargeConfirmed, false);
  check('B1 moderationBlocked never auto-retries despite being unbilled',
    mayRetryAfterFailure({
      policyRetryable: err.policyRetryable,
      chargeConfirmed: err.chargeConfirmed,
      attempt: 1,
      maxAttempts: err.policyMaxAttempts
    }),
    false);
}

{
  const data = settledFailedNoPrice('INTERNAL', { price: '0.45' });
  const err = buildClassifiedFailureError('pred-charged', 'failed', data);
  check('B2 a priced failed prediction reads chargeConfirmed TRUE', err.chargeConfirmed, true);
  check('B2 a priced failed prediction reads a real chargePriceUsd', err.chargePriceUsd, 0.45);
  check('B2 a confirmed charge never auto-retries even though the policy is retryable',
    mayRetryAfterFailure({
      policyRetryable: err.policyRetryable,
      chargeConfirmed: err.chargeConfirmed,
      attempt: 1,
      maxAttempts: err.policyMaxAttempts
    }),
    false);
}

{
  check('B3 an unsettled status (still processing) reads charged:null (unknown)',
    confirmedCharge({ status: 'processing', price: undefined }).charged, null);
  check('B3 a garbage price on a settled record reads charged:null (unknown), not false',
    confirmedCharge({ status: 'failed', price: 'not-a-number' }).charged, null);
  check('B3 unknown charge state (null) never auto-retries',
    mayRetryAfterFailure({ policyRetryable: true, chargeConfirmed: null, attempt: 1, maxAttempts: 3 }),
    false);
  check('B3 undefined charge state never auto-retries either (strict === false, not != true)',
    mayRetryAfterFailure({ policyRetryable: true, chargeConfirmed: undefined, attempt: 1, maxAttempts: 3 }),
    false);
}

// ── C. The Slack alert payload ────────────────────────────────────────
const baseAlertArgs = {
  ad: { _id: '66ffabc123456789abcdef01', platformFormat: 'meta_stories_9_16' },
  model: 'google/gemini-omni-flash/image-to-video-developer',
  aspectRatio: '9:16',
  platformFormat: 'meta_stories_9_16',
  campaignRunId: 'run_abc123',
  predictionId: 'pred-abc123',
  atlasPolicy: 'predictionFailed',
  providerMsg: PROD_MSG_1,
  attempt: 1,
  maxAttempts: 3,
  backoffMs: 15000
};

{
  const alert = buildNotChargeableRetryAlert(baseAlertArgs);
  check('C1 alert level is warn', alert.level, 'warn');
  checkTrue('C2 title names this as an auto-retry, not a plain failure', /auto-retried/i.test(alert.title));
  checkTrue('C3 detail quotes the exact verbatim provider message', alert.detail.includes(`"${PROD_MSG_1}"`));
  check('C4 fields.ad carries the ad id', alert.fields.ad, '66ffabc123456789abcdef01');
  check('C5 fields.model carries the resolved model', alert.fields.model, baseAlertArgs.model);
  check('C6 fields.aspectRatio carries the render aspect', alert.fields.aspectRatio, '9:16');
  check('C7 fields.platformFormat carries Ad.platformFormat', alert.fields.platformFormat, 'meta_stories_9_16');
  check('C8 fields.policy carries the atlasErrorPolicy classification', alert.fields.policy, 'predictionFailed');
  check('C9 fields.attempt reports the UPCOMING attempt out of the cap', alert.fields.attempt, '2/3');
  check('C10 fields.backoff reports the wait', alert.fields.backoff, '15s');
  checkTrue('C11 fields has no more than 12 keys (alertService MAX_FIELDS)', Object.keys(alert.fields).length <= 12);
  check('C12 scenario is master (generateForAd is unreachable for derives)', alert.fields.scenario, 'master');
  checkTrue('C13 detail names this as a paid video MASTER and a derive-blocking situation',
    /paid video MASTER/.test(alert.detail) && /Sibling derive/.test(alert.detail));
  checkTrue('C14 detail does not invent a DERIVE-submit scenario',
    !/\bDERIVE video\b/.test(alert.detail) && !/deriving from master/.test(alert.detail));
  checkTrue('C15 dedupe key is keyed on policy+message, NOT ad id',
    alert.key === 'video-retry-not-chargeable:predictionFailed:INTERNAL'
    && !alert.key.includes(baseAlertArgs.ad._id));
  checkTrue('C16 detail says this is visibility on an existing decision, not a new retry policy',
    /unchanged decision/.test(alert.detail) && /does not add or widen any retry policy/.test(alert.detail));
  checkTrue('C17 detail does not claim a submit-time no-predictionId failure is never auto-retried',
    !/no predictionId/.test(alert.detail) && !/submit-time failure/.test(alert.detail));
  checkTrue('C18 detail does not claim other failure classes fail the ad immediately',
    !/fail the ad immediately/.test(alert.detail) && !/still fail the ad/.test(alert.detail));
}

{
  // Ad.deriveFromMaster is a platformFormat STRING KEY, not an ad id, and
  // a derive never reaches generateForAd. Passing one must not flip the
  // alert into a "DERIVE" scenario — that was a real bug in a prior draft.
  const alert = buildNotChargeableRetryAlert({
    ...baseAlertArgs,
    ad: {
      _id: '66ffabc123456789abcdef02',
      deriveFromMaster: 'meta_stories_9_16',
      platformFormat: 'pmax_video_1_1'
    }
  });
  check('C19 deriveFromMaster set still reports scenario=master (no dead branching)',
    alert.fields.scenario, 'master');
  checkTrue('C20 deriveFromMaster set does not produce DERIVE-submit wording',
    !/\bDERIVE video\b/.test(alert.detail) && !/deriving from master/.test(alert.detail));
}

{
  const midAlert = buildNotChargeableRetryAlert({ ...baseAlertArgs, attempt: 1, maxAttempts: 3 });
  checkTrue('C21 mid-sequence alert (attempt 1 of 3) does NOT claim this is the last retry',
    !/LAST retry/.test(midAlert.detail));

  const finalAlert = buildNotChargeableRetryAlert({ ...baseAlertArgs, attempt: 2, maxAttempts: 3 });
  checkTrue('C22 final-attempt alert (attempt 2 of 3, next=3=cap) DOES say this is the last retry',
    /LAST retry/.test(finalAlert.detail));
}

{
  const longMsg = 'x'.repeat(500);
  const alert = buildNotChargeableRetryAlert({ ...baseAlertArgs, providerMsg: longMsg });
  checkTrue('C23 fields.error is clipped to <=200 chars (alertService MAX_FIELD_VAL)',
    alert.fields.error.length <= 200);
}

{
  let threw = false;
  let alert = null;
  try {
    alert = buildNotChargeableRetryAlert({
      ad: { _id: 'x' }, model: null, aspectRatio: null, platformFormat: null,
      campaignRunId: null, predictionId: null, atlasPolicy: null, providerMsg: null,
      attempt: 1, maxAttempts: 3, backoffMs: 0
    });
  } catch { threw = true; }
  checkTrue('C24 degenerate/missing optional fields do not throw', !threw);
  checkTrue('C24b degenerate build still returns a usable payload', !!(alert && alert.level && alert.title));
}

{
  const alert = buildNotChargeableRetryAlert({ ...baseAlertArgs, providerMsg: PROD_MSG_2 });
  checkTrue('C25 second production error string is quoted verbatim in detail',
    alert.detail.includes(`"${PROD_MSG_2}"`));
}

// ── D. Wiring: alert is on the retry branch, in its own try/catch ─────
{
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'atlasVideoService.js'), 'utf8'
  );
  const rendererSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'renderer.js'), 'utf8'
  );

  checkTrue('D0 atlasVideoService.js requires alertService',
    /require\(['"]\.\/alertService['"]\)/.test(src));
  checkTrue('D0b buildNotChargeableRetryAlert is exported',
    /buildNotChargeableRetryAlert/.test(src.slice(src.indexOf('module.exports'))));

  const exportBlock = src.slice(src.indexOf('module.exports'));
  const expIdx = exportBlock.indexOf('buildNotChargeableRetryAlert');
  const exportAround = exportBlock.slice(Math.max(0, expIdx - 280), expIdx + 40);
  checkTrue('D0c export comment names scripts/verifyNotChargeableRetryAlert.js',
    exportAround.includes('verifyNotChargeableRetryAlert.js'));
  checkTrue('D0d export comment does not point at verifySubmitGuard.js',
    !exportAround.includes('verifySubmitGuard.js'));

  // generateForAd is unreachable for derives — prove the call sits AFTER
  // the deriveFromFmt block, which every path inside throws or returns.
  const deriveIf = rendererSrc.indexOf('if (deriveFromFmt)');
  const deriveOpen = deriveIf === -1 ? -1 : rendererSrc.indexOf('{', deriveIf);
  const deriveClose = deriveOpen === -1 ? -1 : indexOfMatchingBrace(rendererSrc, deriveOpen);
  const genCall = rendererSrc.indexOf('videoRouter.generateForAd(');
  const genCount = (rendererSrc.match(/videoRouter\.generateForAd\(/g) || []).length;
  const namedCount = (rendererSrc.match(/(?:atlasVideo|geminiVideo)\.generateForAd\(/g) || []).length;
  checkTrue('D1 renderer.js has exactly one videoRouter.generateForAd call', genCount === 1);
  checkTrue('D1a renderer.js has ZERO provider-named generateForAd calls', namedCount === 0);
  checkTrue('D1b that call sits AFTER the if (deriveFromFmt) block',
    deriveClose !== -1 && genCall > deriveClose);

  const builderStart = src.indexOf('function buildNotChargeableRetryAlert');
  const builderOpen = builderStart === -1 ? -1 : src.indexOf('{', builderStart);
  const builderClose = builderOpen === -1 ? -1 : indexOfMatchingBrace(src, builderOpen);
  const builderCode = builderStart === -1 || builderClose === -1
    ? ''
    : stripComments(src.slice(builderStart, builderClose + 1));
  checkTrue('D2 builder function found', builderStart !== -1 && builderClose !== -1);
  checkTrue('D2b builder code does not read deriveFromMaster (dead branching)',
    !/\bderiveFromMaster\b/.test(builderCode));
  checkTrue('D2c builder code has no master/derive ternary',
    !/isMaster/.test(builderCode) && !/\? ['"]master['"]\s*:\s*['"]derive['"]/.test(builderCode));

  const gateIdx = src.indexOf('const mayRetry = mayRetryAfterFailure({');
  checkTrue('D3 found the retry gate call site', gateIdx !== -1);
  const ifIdx = gateIdx === -1 ? -1 : src.indexOf('if (!mayRetry)', gateIdx);
  checkTrue('D3b found if (!mayRetry) after the gate', ifIdx !== -1 && ifIdx > gateIdx);
  const ifOpen = ifIdx === -1 ? -1 : src.indexOf('{', ifIdx);
  const ifClose = ifOpen === -1 ? -1 : indexOfMatchingBrace(src, ifOpen);
  checkTrue('D3c found the if (!mayRetry) closing brace', ifClose !== -1 && ifClose > ifOpen);

  const nonRetryBlock = ifOpen !== -1 && ifClose !== -1 ? src.slice(ifOpen, ifClose + 1) : '';
  checkTrue('D3d non-retry block contains throw err (sanity: captured the right if)',
    /throw err;/.test(nonRetryBlock));
  checkTrue('D3e non-retry block contains the finalizeFlatCost try (the WRONG try)',
    /try\s*\{[\s\S]*?finalizeFlatCost/.test(nonRetryBlock));

  // WINDOW STARTS AFTER the if (!mayRetry) closing brace. A prior draft
  // sliced from `const mayRetry = ...` (BEFORE this if), so moving
  // notifyAsync onto the non-retry arm still passed.
  const afterNonRetry = ifClose === -1 ? '' : src.slice(ifClose + 1);
  const sleepRel = afterNonRetry.indexOf('await new Promise((r) => setTimeout(r, backoffMs));');
  checkTrue('D4 found the backoff sleep after the non-retry block', sleepRel !== -1);
  const retryWindow = sleepRel === -1 ? '' : afterNonRetry.slice(0, sleepRel);

  checkTrue('D5 retry window (AFTER if (!mayRetry)) calls alerts.notifyAsync(buildNotChargeableRetryAlert(...))',
    /alerts\.notifyAsync\(\s*buildNotChargeableRetryAlert\(/.test(retryWindow));
  checkTrue('D5b non-retry block does NOT call notifyAsync / buildNotChargeableRetryAlert',
    !/notifyAsync/.test(nonRetryBlock) && !/buildNotChargeableRetryAlert/.test(nonRetryBlock));
  checkTrue('D5c prefix of generateForAd catch up through if (!mayRetry) has no notifyAsync',
    !/notifyAsync/.test(src.slice(gateIdx, ifClose + 1)));

  // Tight try-anchor: the try that wraps the alert, not `[\s\S]*` from an
  // earlier try. The non-retry arm's `try { await finalizeFlatCost }` is
  // outside this window; a greedy regex spanning it would still pass if
  // someone stripped THIS try/catch.
  checkTrue('D6 alert notifyAsync is wrapped in its OWN try { alerts.notifyAsync(buildNotChargeableRetryAlert',
    /try\s*\{\s*alerts\.notifyAsync\(\s*buildNotChargeableRetryAlert\(/.test(retryWindow));
  checkTrue('D6b that try has a catch that does not rethrow',
    /try\s*\{\s*alerts\.notifyAsync\(\s*buildNotChargeableRetryAlert\([\s\S]*?\}\s*catch\s*\(\s*alertErr\s*\)\s*\{[\s\S]*?\}/.test(retryWindow)
    && !/catch\s*\(\s*alertErr\s*\)\s*\{[\s\S]*?throw/.test(retryWindow));
}

// ── Report ────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyNotChargeableRetryAlert: ${failures.length} of ${total} checks FAILED\n`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  console.error('A failure here means either the existing bounded-retry money gate');
  console.error('regressed, or the Slack alert for it is missing/miswired/untruthful.\n');
  process.exit(1);
}
console.log(`✅ verifyNotChargeableRetryAlert: ${total}/${total} checks passed`);
console.log('   the two real production error messages still retry, bounded at 3,');
console.log('   ONLY when Atlas confirms no charge; Slack visibility fires on the');
console.log('   retry branch only, with provider text, model, format, ad, attempt,');
console.log('   backoff, and master/derive-blocking context; no new retry policy.');
