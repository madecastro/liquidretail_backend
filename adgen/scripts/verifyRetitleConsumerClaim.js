#!/usr/bin/env node
'use strict';
//
// verifyRetitleConsumerClaim — pins the claim-safety AND status-preservation
// invariants for the ad-gen manual RE-TITLE handoff (2026-08-28): backend's
// routes/brand.js runRetitleJobViaAdgen(), when ADGEN_RENDERER_ENABLED is
// true, stamps Ad.retitleRequest and returns; src/services/retitleConsumer.js
// here claims and executes it.
//
// TWO DISTINCT HAZARDS, both pinned here:
//   1. CLAIM-SAFETY (the #81-class hazard the owner asked to guard
//      against): a double claim on one ad wastes a Remotion slot and a
//      Cloudinary upload racing the same renderUrl identity. Not billable
//      (grep-verified: brandScriptExecutor.js never requires an Atlas
//      client), so the bar is wasted compute, not a double charge.
//   2. STATUS-PRESERVATION (found DURING this investigation, more severe):
//      brandScriptExecutor.uploadRenderAndStamp forces status:'draft' on
//      EVERY call by default — correct for the first titling pass right
//      after generation, and a live production bug for a manual retitle of
//      an already-delivered ad (commonly status:'live') — it would
//      silently un-publish the ad on every single retitle, success or a QC
//      fail. preserveAdStatus / retitleMode (added alongside this
//      consumer, in the SAME brandScriptExecutor.js this file calls) is
//      what stops that. Group E below revert-proves the guarding
//      conditions directly out of the real source text.
//
// EXECUTION, not source-text pattern matching, for claim/settle/reclaim:
// this harness requires the REAL src/services/retitleConsumer.js module and
// drives its actual exported claimOne/settle/reclaimStaleRetitleClaims
// against a monkey-patched Ad Mongoose Model (same technique
// scripts/verifyTitlingResumeAdgenGate.js in the sibling backend repo uses,
// and the same technique verifyRendererAtomicClaim.js uses here) — so a
// change to the real filter/update changes what this harness proves.
// SOURCE EXTRACTION (balanced-brace parse + isolated condition eval, same
// discipline as verifyRegenerateConsumerClaim.js) for the parts that live
// inside a much larger function (uploadRenderAndStamp) that cannot be
// exercised offline without a live Cloudinary/vision-QC stack.
//
// Pure + offline: no DB, no network, no API keys. Run:
//   node scripts/verifyRetitleConsumerClaim.js
//
// Revert-prove:
//   drop retitleClaimedByWorker:null from claimOne's filter        → A2
//   swap retitleRequest:{$type:'object'} for {$ne:null}            → A3
//   drop the isAdgenRendererEnabled() gate                          → A4
//   settle() not scoped to retitleClaimedByWorker:WORKER_ID         → C2
//   reclaim sweep age comparison inverted / missing                → D2/D3
//   remove `retitleMode: true` from processClaimed's render call    → B1
//   remove the `if (!preserveAdStatus)` guard on set.status         → E1/E2
//   remove the `if (preserveAdStatus) delete qcFailureFields.status` → E3

// Offline harness affordance — src/config.js (required transitively by
// retitleConsumer.js -> ../config) validates ADGEN_ROLE and MONGODB_URI at
// require time and exits the process on failure. This harness never
// connects to Mongo (every DB call is monkey-patched below), so any role
// with no REQUIRED_ENV_BY_ROLE entry works; 'api' is the quietest.
process.env.ADGEN_ROLE   = process.env.ADGEN_ROLE   || 'api';
process.env.MONGODB_URI  = process.env.MONGODB_URI  || 'mongodb://offline-harness/unused';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; }
  catch (err) { failures.push(`${label}\n     ${err.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); checks += 1; }
  catch (err) { failures.push(`${label}\n     ${err.message}`); }
}

function balanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return null;
}
function functionBody(src, signatureRe) {
  const m = signatureRe.exec(src);
  assert.ok(m, `signature not found: ${signatureRe}`);
  const brace = src.indexOf('{', m.index + m[0].length - 1);
  const body = balanced(src, brace, '{', '}');
  assert.ok(body, `unterminated function body for ${signatureRe}`);
  return body;
}

const CONSUMER_PATH = path.join(__dirname, '..', 'src', 'services', 'retitleConsumer.js');
const CONSUMER_SRC  = fs.readFileSync(CONSUMER_PATH, 'utf8');
const BSE_PATH = path.join(__dirname, '..', 'src', 'services', 'brandScriptExecutor.js');
const BSE_SRC  = fs.readFileSync(BSE_PATH, 'utf8');

console.log('verifyRetitleConsumerClaim\n');

// Bare worktree affordance — same shared loader verifyModelParity.js /
// verifyHandoffContract.js use. Must run BEFORE requiring src/models/Ad or
// src/services/retitleConsumer (both do their own bare `require('mongoose')`
// transitively). See scripts/lib/mongooseLoader.js's header for why the
// Module._load patch it installs is deliberately left in place afterward.
const { resolveBackendRoot } = require('./lib/siblingBackend');
const { loadMongooseWithFallback } = require('./lib/mongooseLoader');
loadMongooseWithFallback({
  harnessName: 'verifyRetitleConsumerClaim',
  backendRoot: resolveBackendRoot(path.join(__dirname, '..')),
});

// ═════════════════════════════════════════════════════════════════════════
// A — claimOne(): real execution against a monkey-patched Ad model
// ═════════════════════════════════════════════════════════════════════════
const Ad = require('../src/models/Ad');
const retitleConsumer = require('../src/services/retitleConsumer');

function withFindOneAndUpdateSpy(impl) {
  const orig = Ad.findOneAndUpdate;
  const calls = [];
  Ad.findOneAndUpdate = function spy(filter, update, opts) {
    calls.push({ filter, update, opts });
    return impl ? impl(filter, update, opts) : Promise.resolve(null);
  };
  return { calls, restore() { Ad.findOneAndUpdate = orig; } };
}

(async () => {
  const origFlag = process.env.ADGEN_RENDERER_ENABLED;

  await checkAsync('A1 claimOne() gated on isAdgenRendererEnabled — returns null and never queries when flag is off', async () => {
    process.env.ADGEN_RENDERER_ENABLED = 'false';
    const spy = withFindOneAndUpdateSpy();
    try {
      const result = await retitleConsumer.claimOne();
      assert.strictEqual(result, null);
      assert.strictEqual(spy.calls.length, 0, 'claimOne must not query Mongo at all when the handoff flag is off');
    } finally { spy.restore(); }
  });

  await checkAsync('A2 claimOne() filter requires retitleClaimedByWorker:null (claim exclusivity)', async () => {
    process.env.ADGEN_RENDERER_ENABLED = 'true';
    const spy = withFindOneAndUpdateSpy();
    try {
      await retitleConsumer.claimOne();
      assert.strictEqual(spy.calls.length, 1);
      const { filter } = spy.calls[0];
      assert.strictEqual(filter.retitleClaimedByWorker, null,
        'dropping this would let a second worker claim a row another worker already owns');
    } finally { spy.restore(); }
  });

  await checkAsync('A3 claimOne() filter uses retitleRequest:{$type:"object"}, NOT {$ne:null}', async () => {
    process.env.ADGEN_RENDERER_ENABLED = 'true';
    const spy = withFindOneAndUpdateSpy();
    try {
      await retitleConsumer.claimOne();
      const { filter } = spy.calls[0];
      assert.ok(filter.retitleRequest && filter.retitleRequest.$type === 'object',
        'must require an actual stamped object — {$ne:null} also matches every ad where the field is simply ' +
        'ABSENT (every ad that predates this migration), which would make claimOne fire on unrelated rows');
    } finally { spy.restore(); }
  });

  await checkAsync('A4 claimOne() sets retitleClaimedByWorker + retitleClaimedAt in the SAME $set as the claim', async () => {
    process.env.ADGEN_RENDERER_ENABLED = 'true';
    const spy = withFindOneAndUpdateSpy();
    try {
      await retitleConsumer.claimOne();
      const { update } = spy.calls[0];
      assert.ok(update.$set && typeof update.$set.retitleClaimedByWorker === 'string' && update.$set.retitleClaimedByWorker.length > 0);
      assert.ok(update.$set.retitleClaimedAt instanceof Date);
    } finally { spy.restore(); }
  });

  await checkAsync('A5 two concurrent claimOne() calls against ONE candidate cannot both win', async () => {
    process.env.ADGEN_RENDERER_ENABLED = 'true';
    // Atomic single-document store: findOneAndUpdate only succeeds once —
    // the second call sees claimedByWorker already set and "fails" the
    // filter, exactly like a real Mongo atomic update would.
    let doc = { _id: 'ad-1', retitleRequest: { kind: 'manual-retitle' }, retitleClaimedByWorker: null };
    const orig = Ad.findOneAndUpdate;
    Ad.findOneAndUpdate = async (filter) => {
      if (filter.retitleClaimedByWorker !== null) return null;
      if (doc.retitleClaimedByWorker !== null) return null; // already claimed
      if (!(doc.retitleRequest && typeof doc.retitleRequest === 'object')) return null;
      doc = { ...doc, retitleClaimedByWorker: 'winner', retitleClaimedAt: new Date() };
      return doc;
    };
    try {
      const [r1, r2] = await Promise.all([retitleConsumer.claimOne(), retitleConsumer.claimOne()]);
      const wins = [r1, r2].filter(Boolean).length;
      assert.strictEqual(wins, 1, `expected exactly one winner, got ${wins}`);
    } finally { Ad.findOneAndUpdate = orig; }
  });

  process.env.ADGEN_RENDERER_ENABLED = origFlag;

  // ═══════════════════════════════════════════════════════════════════════
  // B — processClaimed(): must call renderBrandScriptAndSave with
  // retitleMode:true. This is THE line that activates preserveAdStatus
  // downstream — source-checked because actually executing
  // renderBrandScriptAndSave needs a live Remotion/Cloudinary/vision stack.
  // ═══════════════════════════════════════════════════════════════════════
  check('B1 processClaimed() calls renderBrandScriptAndSave with retitleMode:true', () => {
    const body = functionBody(CONSUMER_SRC, /async function processClaimed\s*\([^)]*\)\s*\{/);
    assert.ok(/renderBrandScriptAndSave\s*\(\s*\{[^}]*retitleMode:\s*true/.test(body),
      'without retitleMode:true, this consumer would run the FIRST-titling failure/status machinery ' +
      '(stampTitlingFailureAndThrow, forced status:"draft") against an already-delivered ad');
  });

  check('B2 processClaimed() never writes Ad.status directly (no Ad.updateOne / ad.status assignment)', () => {
    const body = functionBody(CONSUMER_SRC, /async function processClaimed\s*\([^)]*\)\s*\{/);
    const code = body.replace(/\/\/.*$/gm, '');
    // `status:` DOES appear legitimately here (settle(id, {status:'done'|'failed', ...}) —
    // that's retitleResult.status, not Ad.status). What must NEVER appear is a direct
    // Mongo write or an in-memory mutation of the ad's own status field.
    assert.ok(!/Ad\.(updateOne|findOneAndUpdate|updateMany)\s*\(/.test(code),
      'processClaimed must route every write through settle() — a direct Ad write here could ' +
      'bypass the retitleClaimedByWorker scoping settle() enforces');
    assert.ok(!/\bad\.status\s*=/.test(code),
      'processClaimed must never assign ad.status — status preservation is entirely ' +
      'brandScriptExecutor\'s job under retitleMode');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // C — settle(): real execution against a monkey-patched Ad.updateOne
  // ═══════════════════════════════════════════════════════════════════════
  await checkAsync('C1 settle() clears retitleRequest/retitleClaimedByWorker/retitleClaimedAt and writes retitleResult', async () => {
    const orig = Ad.updateOne;
    let captured = null;
    Ad.updateOne = async (filter, update) => { captured = { filter, update }; return { modifiedCount: 1 }; };
    try {
      await retitleConsumer.settle('ad-1', { status: 'done', renderUrl: 'https://example/x.mp4' });
      const set = captured.update.$set;
      assert.strictEqual(set.retitleRequest, null);
      assert.strictEqual(set.retitleClaimedByWorker, null);
      assert.strictEqual(set.retitleClaimedAt, null);
      assert.strictEqual(set.retitleResult.status, 'done');
      assert.strictEqual(set.retitleResult.renderUrl, 'https://example/x.mp4');
    } finally { Ad.updateOne = orig; }
  });

  await checkAsync('C2 settle() scopes its write to retitleClaimedByWorker:WORKER_ID (cannot stomp a later claimant)', async () => {
    const orig = Ad.updateOne;
    let captured = null;
    Ad.updateOne = async (filter) => { captured = filter; return { modifiedCount: 1 }; };
    try {
      await retitleConsumer.settle('ad-1', { status: 'failed', error: 'boom' });
      assert.ok(typeof captured.retitleClaimedByWorker === 'string' && captured.retitleClaimedByWorker.length > 0,
        'settle() must scope its write to this worker\'s own claim — an unscoped write could clear a claim a ' +
        'stale-claim reclaim already released and a fresh worker just re-claimed');
    } finally { Ad.updateOne = orig; }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // D — reclaimStaleRetitleClaims(): real execution against Ad.updateMany
  // ═══════════════════════════════════════════════════════════════════════
  await checkAsync('D1 reclaim filter requires a stamped retitleRequest AND a non-null claim', async () => {
    const orig = Ad.updateMany;
    let captured = null;
    Ad.updateMany = async (filter) => { captured = filter; return { modifiedCount: 0 }; };
    try {
      await retitleConsumer.reclaimStaleRetitleClaims();
      assert.ok(captured.retitleRequest && captured.retitleRequest.$type === 'object');
      assert.deepStrictEqual(captured.retitleClaimedByWorker, { $ne: null });
    } finally { Ad.updateMany = orig; }
  });

  await checkAsync('D2 reclaim clears ONLY the claim pair, never retitleRequest itself', async () => {
    const orig = Ad.updateMany;
    let captured = null;
    Ad.updateMany = async (filter, update) => { captured = update; return { modifiedCount: 1 }; };
    try {
      await retitleConsumer.reclaimStaleRetitleClaims();
      assert.strictEqual(captured.$set.retitleClaimedByWorker, null);
      assert.strictEqual(captured.$set.retitleClaimedAt, null);
      assert.ok(!('retitleRequest' in captured.$set),
        'reclaim must leave retitleRequest intact — clearing it would silently drop the operator\'s request ' +
        'instead of freeing it for a live worker to pick back up');
    } finally { Ad.updateMany = orig; }
  });

  await checkAsync('D3 reclaim cutoff uses RETITLE_CLAIM_STALE_MIN (a real Date comparison, not a no-op)', async () => {
    const orig = Ad.updateMany;
    let captured = null;
    const t0 = Date.now();
    Ad.updateMany = async (filter) => { captured = filter; return { modifiedCount: 0 }; };
    try {
      await retitleConsumer.reclaimStaleRetitleClaims();
      const cutoff = captured.retitleClaimedAt.$lt;
      assert.ok(cutoff instanceof Date);
      const ageMin = (t0 - cutoff.getTime()) / 60000;
      assert.ok(ageMin > 1 && ageMin < 60, `expected a cutoff somewhere between 1 and 60 minutes ago, got ${ageMin.toFixed(1)}`);
    } finally { Ad.updateMany = orig; }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E — THE STATUS-PRESERVATION FIX: extract the real guarding conditions
  // out of brandScriptExecutor.js and evaluate them directly. A hand-copy
  // of this logic would drift from the source silently; this does not.
  // ═══════════════════════════════════════════════════════════════════════
  check('E1 uploadRenderAndStamp declares preserveAdStatus, default false', () => {
    const m = /async function uploadRenderAndStamp\s*\(\s*\{([^}]*)\}\s*\)/.exec(BSE_SRC);
    assert.ok(m, 'uploadRenderAndStamp signature not found');
    assert.ok(/preserveAdStatus\s*=\s*false/.test(m[1]),
      'must default to false — every EXISTING caller (first-pass titling) must keep forcing status:"draft"');
  });

  check('E2 set.status = "draft" is reachable ONLY when preserveAdStatus is falsy (executed against both values)', () => {
    const body = functionBody(BSE_SRC, /async function uploadRenderAndStamp\s*\([^)]*\)\s*\{/);
    // Extract the exact guarding condition text around the status literal —
    // tolerant of the surrounding comment block, strict about the code line.
    const guardMatch = /if\s*\(([^)]*preserveAdStatus[^)]*)\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*set\.status\s*=\s*'draft';/.exec(body);
    assert.ok(guardMatch, 'could not find an `if (<preserveAdStatus expr>) { ... set.status = \'draft\'; }` guard — ' +
      'has the status write been un-guarded again?');
    const condSrc = guardMatch[1].trim();
    // eslint-disable-next-line no-new-func
    const evalCond = new Function('preserveAdStatus', `return (${condSrc});`);
    assert.strictEqual(evalCond(false), true, `condition "${condSrc}" must be true when preserveAdStatus is false (existing callers must still get status:'draft')`);
    assert.strictEqual(evalCond(true), false, `condition "${condSrc}" must be false when preserveAdStatus is true — otherwise a retitle of a 'live' ad silently un-publishes it`);
  });

  check('E3 QC-failure status override is deleted under preserveAdStatus (executed against both values)', () => {
    const body = functionBody(BSE_SRC, /async function uploadRenderAndStamp\s*\([^)]*\)\s*\{/);
    const m = /if\s*\(([^)]*preserveAdStatus[^)]*)\)\s*delete\s+qcFailureFields\.status;/.exec(body);
    assert.ok(m, 'could not find `if (<preserveAdStatus expr>) delete qcFailureFields.status;` — without this, ' +
      'a retitle QC failure would still flip status:\'failed\' on an already-delivered ad');
    const condSrc = m[1].trim();
    // eslint-disable-next-line no-new-func
    const evalCond = new Function('preserveAdStatus', `return (${condSrc});`);
    assert.strictEqual(evalCond(true), true, `condition "${condSrc}" must be true when preserveAdStatus is true`);
    assert.strictEqual(evalCond(false), false, `condition "${condSrc}" must be false when preserveAdStatus is false — a real QC failure on the FIRST titling pass must still flip status:'failed'`);
  });

  check('E4 renderWithRemotionAndSave threads retitleMode -> preserveAdStatus into its uploadRenderAndStamp call', () => {
    const body = functionBody(BSE_SRC, /async function renderWithRemotionAndSave\s*\([^)]*\)\s*\{/);
    assert.ok(/preserveAdStatus:\s*retitleMode/.test(body));
  });

  check('E5 renderBrandScriptAndSave threads retitleMode into renderWithRemotionAndSave', () => {
    const body = functionBody(BSE_SRC, /async function renderBrandScriptAndSave\s*\([^)]*\)\s*\{/);
    assert.ok(/renderWithRemotionAndSave\s*\(\s*\{[^}]*retitleMode\s*(,|\})/.test(body) || /renderWithRemotionAndSave\s*\(\s*\{[^}]*retitleMode:\s*retitleMode/.test(body),
      'renderBrandScriptAndSave must forward its own retitleMode argument to renderWithRemotionAndSave');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // F — the FIRST-titling failure path (stampTitlingFailureAndThrow) must
  // be bypassed under retitleMode at all THREE call sites, so a retitle
  // failure never burns the shared titlingAttempts cap or flips
  // titlingResumeState/titlingNeeded on an ad that isn't mid-first-titling.
  // ═══════════════════════════════════════════════════════════════════════
  check('F1 all three stampTitlingFailureAndThrow call sites are preceded by an `if (retitleMode) throw` guard', () => {
    const body = functionBody(BSE_SRC, /async function renderWithRemotionAndSave\s*\([^)]*\)\s*\{/);
    const guardedThrows = (body.match(/if\s*\(\s*retitleMode\s*\)\s*throw\s+err2?;/g) || []).length;
    const stampCalls = (body.match(/await\s+stampTitlingFailureAndThrow\s*\(/g) || []).length;
    assert.strictEqual(stampCalls, 3, `expected 3 stampTitlingFailureAndThrow call sites, found ${stampCalls} — this check's own count needs updating if the function was restructured`);
    assert.strictEqual(guardedThrows, 3, `expected all 3 call sites guarded by \`if (retitleMode) throw\`, found ${guardedThrows} guard(s)`);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Report
  // ═══════════════════════════════════════════════════════════════════════
  const total = checks + failures.length;
  if (failures.length) {
    console.error(`❌ verifyRetitleConsumerClaim: ${failures.length} of ${total} checks FAILED\n`);
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    process.exitCode = 1;
    return;
  }
  console.log(`✅ verifyRetitleConsumerClaim: ${checks}/${total} checks passed`);
})();
