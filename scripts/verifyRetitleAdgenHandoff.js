#!/usr/bin/env node
'use strict';
//
// verifyRetitleAdgenHandoff — pins the backend half of the ad-gen manual
// RE-TITLE handoff (2026-08-28): routes/brand.js's POST /:id/retitle-videos,
// when ADGEN_RENDERER_ENABLED is true, stamps Ad.retitleRequest per ad and
// polls for completion instead of running renderBrandScriptAndSave
// in-process. liquidretail_adgen's src/services/retitleConsumer.js is the
// other half (see that repo's scripts/verifyRetitleConsumerClaim.js).
//
// Full field contract lives in services/handoffContract.js
// (retitleRequest / retitleClaimedByWorker / retitleClaimedAt /
// retitleResult) — scripts/verifyHandoffContract.js already asserts those
// are declared on the live models/Ad.js schema with the right types; this
// harness does not repeat that check.
//
// THIS FILE ALSO PINS A SEVERE PRE-EXISTING BUG FOUND DURING THE SAME
// INVESTIGATION, independent of ADGEN_RENDERER_ENABLED: brandScriptExecutor
// .uploadRenderAndStamp forces status:'draft' on EVERY call — correct for
// the first titling pass right after generation, and a LIVE PRODUCTION BUG
// for a manual retitle of an already-delivered ad (commonly status:'live')
// — every retitle-videos call today silently un-publishes the ad, success
// or a QC fail, because this function was written for a lifecycle a manual
// retitle is not in. Fixed here (preserveAdStatus / retitleMode) alongside
// the adgen-handoff work, in BOTH repos (same bug, same fix, both copies of
// brandScriptExecutor.js) — this repo's LOCAL retitle-videos path
// (runRetitleJob, the dormant fallback when the flag is off) now also
// passes retitleMode:true, so the fix applies whether or not the handoff
// flag is ever flipped on.
//
// SOURCE EXTRACTION (balanced-brace parse + isolated condition eval), same
// discipline as this repo's own scripts/verifyTitlingResumeAdgenGate.js and
// adgen's scripts/verifyRegenerateConsumerClaim.js — tests the REAL source
// text, not a hand-copied reimplementation that could silently drift.
//
// Pure + offline: no DB, no network, no API keys. Run:
//   node scripts/verifyRetitleAdgenHandoff.js
//
// Revert-prove:
//   drop titlingNeeded:{$ne:true} from the stamp filter        → B1
//   drop retitleRequest:null from the stamp filter             → B2
//   drop the isAdgenRendererEnabled() branch in the route       → A1
//   remove `retitleMode: true` from the local runRetitleJob call → C1
//   remove the `if (!preserveAdStatus)` guard on set.status      → D1/D2
//   remove the `if (preserveAdStatus) delete qcFailureFields.status` → D3

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; }
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
function callArgs(src, calleeText, fromIdx = 0) {
  const idx = src.indexOf(calleeText, fromIdx);
  assert.ok(idx >= 0, `call not found: ${calleeText}`);
  const openParen = idx + calleeText.length - 1;
  const whole = balanced(src, openParen, '(', ')');
  assert.ok(whole, `unterminated call args for ${calleeText}`);
  return whole;
}
// Extracts the full text of a `router.<method>('<routePath>', ...)`
// registration, including its handler body, by balancing PARENS from the
// router call's own opening paren (not from a hand-typed prefix — that
// broke when the prefix itself contained balanced parens like
// `express.json()`, which desynced the brace/paren count).
function routeRegistration(src, routeCallPrefix) {
  const idx = src.indexOf(routeCallPrefix);
  assert.ok(idx >= 0, `route registration not found: ${routeCallPrefix}`);
  const openParen = src.indexOf('(', idx);
  assert.ok(openParen >= 0);
  const whole = balanced(src, openParen, '(', ')');
  assert.ok(whole, `unterminated route registration for ${routeCallPrefix}`);
  return whole;
}

const BRAND_ROUTE_PATH = path.join(__dirname, '..', 'routes', 'brand.js');
const BRAND_ROUTE_SRC  = fs.readFileSync(BRAND_ROUTE_PATH, 'utf8');
const BSE_PATH = path.join(__dirname, '..', 'services', 'brandScriptExecutor.js');
const BSE_SRC  = fs.readFileSync(BSE_PATH, 'utf8');

console.log('verifyRetitleAdgenHandoff\n');

// ═════════════════════════════════════════════════════════════════════════
// A — the route reads isAdgenRendererEnabled() once and branches to the
// deferred vs local runner. Structural: the actual dispatch decision.
// ═════════════════════════════════════════════════════════════════════════
check('A1 POST /:id/retitle-videos branches on isAdgenRendererEnabled() between runRetitleJobViaAdgen and runRetitleJob', () => {
  const routeArgs = routeRegistration(BRAND_ROUTE_SRC, "router.post('/:id/retitle-videos', express.json()");
  assert.ok(/isAdgenRendererEnabled\s*\(\s*\)/.test(routeArgs), 'route handler does not read the handoff flag at all');
  assert.ok(/runRetitleJobViaAdgen\s*\(/.test(routeArgs), 'route handler never calls the deferred runner');
  assert.ok(/runRetitleJob\s*\(\s*jobId,\s*brand,\s*eligible,\s*concurrency,\s*errors\s*\)/.test(routeArgs), 'route handler no longer calls the ORIGINAL local runner — the dormant fallback must stay reachable');
});

check("A2 the flag is read from services/adgenBridge (the SAME helper runRenderLoop / titlingResumeService use), not re-implemented", () => {
  const routeArgs = routeRegistration(BRAND_ROUTE_SRC, "router.post('/:id/retitle-videos', express.json()");
  assert.ok(/require\(\s*['"]\.\.\/services\/adgenBridge['"]\s*\)/.test(routeArgs),
    'a second reader of ADGEN_RENDERER_ENABLED will drift from the shared predicate (case-insensitive exact "true", fail-safe OFF)');
});

// ═════════════════════════════════════════════════════════════════════════
// B — the stamp write: never claims a row mid-first-titling, never
// clobbers an already-pending request. This is the safety boundary that
// makes adgen's retitleConsumer claim query safe WITHOUT itself excluding
// titlingNeeded — see that repo's models/Ad.js doc comment.
// ═════════════════════════════════════════════════════════════════════════
check('B1 the stamp filter requires titlingNeeded:{$ne:true} (never stamp mid-first-titling)', () => {
  const fnBody = functionBody(BRAND_ROUTE_SRC, /async function runRetitleJobViaAdgen\s*\([^)]*\)\s*\{/);
  const updateOneArgs = callArgs(fnBody, 'await Ad.updateOne(');
  assert.ok(/titlingNeeded:\s*\{\s*\$ne:\s*true\s*\}/.test(updateOneArgs),
    'without this, a manual retitle stamped during the exact instant a fresh master hands off to the ' +
    'titler (titlingNeeded:true) would create a retitleRequest object the titler claim has no awareness of, ' +
    'and adgen\'s retitleConsumer could then race the titler for the SAME undelivered master');
});

check('B2 the stamp filter requires retitleRequest:null (never clobber an already-pending request)', () => {
  const fnBody = functionBody(BRAND_ROUTE_SRC, /async function runRetitleJobViaAdgen\s*\([^)]*\)\s*\{/);
  const updateOneArgs = callArgs(fnBody, 'await Ad.updateOne(');
  assert.ok(/retitleRequest:\s*null\s*,?\s*\n/.test(updateOneArgs) || /retitleRequest:\s*null\s*}/.test(updateOneArgs),
    'without this, a stray double-POST (impatient double-click, client retry) could overwrite the payload ' +
    'a live consumer is currently reading, out from under it');
});

check('B3 the stamp write nulls retitleResult in the SAME $set (a stale prior outcome cannot leak into a new poll)', () => {
  const fnBody = functionBody(BRAND_ROUTE_SRC, /async function runRetitleJobViaAdgen\s*\([^)]*\)\s*\{/);
  const updateOneArgs = callArgs(fnBody, 'await Ad.updateOne(');
  assert.ok(/retitleResult:\s*null/.test(updateOneArgs));
});

check('B4 a stamp refusal (modifiedCount===0) is reported per-ad, never silently dropped from the batch', () => {
  const fnBody = functionBody(BRAND_ROUTE_SRC, /async function runRetitleJobViaAdgen\s*\([^)]*\)\s*\{/);
  assert.ok(/stamp\.modifiedCount\s*===\s*0/.test(fnBody));
  assert.ok(/results\.push\(\s*\{\s*id,\s*ok:\s*false/.test(fnBody));
});

// ═════════════════════════════════════════════════════════════════════════
// C — the LOCAL (dormant fallback) runner must still exist unmodified in
// shape, and must ALSO carry the status-preservation fix — this bug is
// independent of ADGEN_RENDERER_ENABLED and is live in production today.
// ═════════════════════════════════════════════════════════════════════════
check('C1 the LOCAL runRetitleJob passes retitleMode:true to renderBrandScriptAndSave', () => {
  const fnBody = functionBody(BRAND_ROUTE_SRC, /async function runRetitleJob\s*\([^)]*\)\s*\{/);
  assert.ok(/renderBrandScriptAndSave\s*\(\s*\{[^}]*retitleMode:\s*true/.test(fnBody),
    'without this, EVERY manual retitle via the in-process fallback (today\'s only live path, since this ' +
    'endpoint has zero adgen awareness before this change) silently un-publishes a status:\'live\' ad');
});

check('C2 runRetitleJob (local) still exists with its original worker-pool signature — the dormant fallback was not deleted', () => {
  assert.ok(/async function runRetitleJob\s*\(\s*jobId,\s*brand,\s*eligible,\s*concurrency,\s*seedErrors\s*\)/.test(BRAND_ROUTE_SRC));
});

// ═════════════════════════════════════════════════════════════════════════
// D — THE STATUS-PRESERVATION FIX in THIS repo's OWN brandScriptExecutor.js
// (same defect, same fix, independently applied to the vendored copy in
// liquidretail_adgen — see that repo's verifyRetitleConsumerClaim.js
// groups E/F for the adgen-side proof).
// ═════════════════════════════════════════════════════════════════════════
check('D1 uploadRenderAndStamp declares preserveAdStatus, default false', () => {
  const m = /async function uploadRenderAndStamp\s*\(\s*\{([^}]*)\}\s*\)/.exec(BSE_SRC);
  assert.ok(m, 'uploadRenderAndStamp signature not found');
  assert.ok(/preserveAdStatus\s*=\s*false/.test(m[1]),
    'must default to false — every EXISTING caller (render-script debug route, first-pass titling) must ' +
    'keep forcing status:"draft"');
});

check('D2 set.status = "draft" is reachable ONLY when preserveAdStatus is falsy (executed against both values)', () => {
  const body = functionBody(BSE_SRC, /async function uploadRenderAndStamp\s*\([^)]*\)\s*\{/);
  const guardMatch = /if\s*\(([^)]*preserveAdStatus[^)]*)\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*set\.status\s*=\s*'draft';/.exec(body);
  assert.ok(guardMatch, 'could not find an `if (<preserveAdStatus expr>) { ... set.status = \'draft\'; }` guard');
  const condSrc = guardMatch[1].trim();
  // eslint-disable-next-line no-new-func
  const evalCond = new Function('preserveAdStatus', `return (${condSrc});`);
  assert.strictEqual(evalCond(false), true, `"${condSrc}" must be true when preserveAdStatus is false`);
  assert.strictEqual(evalCond(true), false, `"${condSrc}" must be false when preserveAdStatus is true — otherwise a retitle of a 'live' ad silently un-publishes it`);
});

check('D3 QC-failure status override is deleted under preserveAdStatus (executed against both values)', () => {
  const body = functionBody(BSE_SRC, /async function uploadRenderAndStamp\s*\([^)]*\)\s*\{/);
  const m = /if\s*\(([^)]*preserveAdStatus[^)]*)\)\s*delete\s+qcFailureFields\.status;/.exec(body);
  assert.ok(m, 'could not find `if (<preserveAdStatus expr>) delete qcFailureFields.status;`');
  const condSrc = m[1].trim();
  // eslint-disable-next-line no-new-func
  const evalCond = new Function('preserveAdStatus', `return (${condSrc});`);
  assert.strictEqual(evalCond(true), true, `"${condSrc}" must be true when preserveAdStatus is true`);
  assert.strictEqual(evalCond(false), false, `"${condSrc}" must be false when preserveAdStatus is false — a real QC failure on the FIRST titling pass must still flip status:'failed'`);
});

check('D4 renderWithRemotionAndSave threads retitleMode -> preserveAdStatus into its uploadRenderAndStamp call', () => {
  const body = functionBody(BSE_SRC, /async function renderWithRemotionAndSave\s*\([^)]*\)\s*\{/);
  assert.ok(/preserveAdStatus:\s*retitleMode/.test(body));
});

check('D5 renderBrandScriptAndSave threads retitleMode into renderWithRemotionAndSave', () => {
  const body = functionBody(BSE_SRC, /async function renderBrandScriptAndSave\s*\([^)]*\)\s*\{/);
  assert.ok(/renderWithRemotionAndSave\s*\(\s*\{[^}]*retitleMode\s*(,|\})/.test(body));
});

// ═════════════════════════════════════════════════════════════════════════
// Report
// ═════════════════════════════════════════════════════════════════════════
const total = checks + failures.length;
if (failures.length) {
  console.error(`❌ verifyRetitleAdgenHandoff: ${failures.length} of ${total} checks FAILED\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✅ verifyRetitleAdgenHandoff: ${checks}/${total} checks passed`);
