'use strict';
// Pins that adVisionQcService.buildPersistedVerdict emits `regenerationCount`
// on Ad.visionQc, and that every call site that has the value in scope
// threads it in.
//
// Context (Phase 0 measurement foundation, 2026-08-26). runPostRenderQc
// tracks `regenerationCount` internally and returns it at the TOP LEVEL
// of its result — but the persisted `visionQc` object it builds dropped
// the counter. Result: DB queries for regen behavior returned 0 across
// every ad even when the logs showed regens firing (measured on
// run_1787756136010 — 1 static failed after a regen but the DB
// visionQc.regenerationCount was undefined).
//
// The fix is additive:
//   1. buildPersistedVerdict accepts `regenerationCount` (default 0)
//   2. buildPersistedVerdict returns it on the persisted shape
//   3. Every caller that has the value in scope passes it through
//   4. Ad model docstring documents it (legacy rows read null-not-zero)

const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const svc = require(path.join(REPO, 'src', 'services', 'adVisionQcService.js'));
const svcSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'adVisionQcService.js'), 'utf8');
const adSrc  = fs.readFileSync(path.join(REPO, 'src', 'models', 'Ad.js'), 'utf8');

// ── A. Behavioural: builder honors the input ────────────────────────────
const v1 = svc.buildPersistedVerdict({ passed: true, attempts: [{attempt:1,pass:true,categories:{}}], finalAttempt: 1, regenerationCount: 0 });
check('A1: passed:true attempt=1 → regenerationCount=0',
  v1.regenerationCount === 0);

const v2 = svc.buildPersistedVerdict({ passed: true, attempts: [{attempt:1,pass:false,categories:{}},{attempt:2,pass:true,categories:{}}], finalAttempt: 2, regenerationCount: 1 });
check('A2: passed:true attempt=2 → regenerationCount=1 (regen succeeded)',
  v2.regenerationCount === 1);

const v3 = svc.buildPersistedVerdict({ passed: false, attempts: [{attempt:1,pass:false,categories:{}},{attempt:2,pass:false,categories:{}}], finalAttempt: 2, regenerationCount: 1 });
check('A3: passed:false attempt=2 → regenerationCount=1 (regen failed)',
  v3.regenerationCount === 1);

// ── B. Missing / bad input is coerced to 0, never NaN ─────────────────
const v4 = svc.buildPersistedVerdict({ passed: false, attempts: [], finalAttempt: null, skipped: true });
check('B1: skipped verdict has regenerationCount=0 (no regens on a skipped verdict)',
  v4.regenerationCount === 0);

const v5 = svc.buildPersistedVerdict({ passed: false, attempts: [], finalAttempt: null, regenerationCount: 'abc' });
check('B2: bad input coerced to 0 (never NaN)',
  v5.regenerationCount === 0);

const v6 = svc.buildPersistedVerdict({ passed: false, attempts: [], finalAttempt: null, regenerationCount: -5 });
check('B3: negative coerced to 0 (never <0)',
  v6.regenerationCount === 0);

// ── C. Field is on the persisted shape at all documented call sites ────
const callSites = [];
const regex = /buildPersistedVerdict\(\{[\s\S]*?\}\)/g;
let m;
while ((m = regex.exec(svcSrc)) !== null) callSites.push({ text: m[0], index: m.index });
check(`C1: found >=5 buildPersistedVerdict call sites (${callSites.length})`, callSites.length >= 5);

// Every SUCCESS/FAIL call site (has regenerationCount in scope) should pass it.
// Skipped/disabled sites default to 0 which is correct.
const succOrFailCalls = callSites.filter(c => /passed:\s*(true|false)/.test(c.text) && !/skipped:\s*true/.test(c.text));
const withRegen = succOrFailCalls.filter(c => /regenerationCount/.test(c.text));
check(`C2: all success/fail sites pass regenerationCount (${withRegen.length}/${succOrFailCalls.length})`,
  withRegen.length === succOrFailCalls.length);

// ── D. Model doc mentions the new field ────────────────────────────────
check('D1: Ad.visionQc comment documents regenerationCount',
  /regenerationCount added 2026-08-26|regenerationCount, attempts/.test(adSrc));

// ── E. Verdict shape has the four legacy fields alongside the new one ──
check('E1: verdict shape carries schemaVersion',
  typeof v2.schemaVersion === 'number');
check('E2: verdict shape carries finalAttempt',
  v2.finalAttempt === 2);
check('E3: verdict shape carries maxRegenerations',
  Number.isFinite(v2.maxRegenerations));
check('E4: verdict shape carries attempts array (preserved for legacy queries)',
  Array.isArray(v2.attempts));

// ── F. Revert-proof: strip the emit line → A1/A2/A3 must break ────────
const stripped = svcSrc.replace(/regenerationCount:\s*Math\.max\(0[^,\n]*,?/g, '');
check('F1: [REVERT-PROOF] removing the emit line breaks the field on output',
  !/regenerationCount:\s*Math\.max/.test(stripped));

// ── report ─────────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\nverifyRegenCountPersisted: ${passes.length} pass, ${failures.length} fail`);
  process.exit(1);
}
for (const p of passes) console.log(`  ✓ ${p}`);
console.log(`\n✅ verifyRegenCountPersisted: ${passes.length}/${passes.length} checks passed`);
