#!/usr/bin/env node
'use strict';
//
// verifyVisionQcPersistedVerdictInvariant — adgen's adVisionQcService.js
// used to differ from backend in two ways, both discovered auditing
// vendor drift 2026-08-24 and confirmed against real Render env (adgen's
// deployed env has none of the three retired vars set — config/defaults.env
// happens to also set them to 'false', so the fallback was a currently-inert
// no-op, not a live bug):
//
//   1. adgen still had a live env-var fallback (AD_VISION_QC_ENABLED /
//      STATIC_VISION_QC_ENABLED / VIDEO_VISION_QC_ENABLED) that backend
//      explicitly retired 2026-08-21 with "must not be reintroduced".
//   2. adgen's buildPersistedVerdict() was missing backend's invariant —
//      passed:true could be constructed on a skipped/disabled (uninspected)
//      verdict. Backend added this specifically after a real 2026-08-19
//      incident where exactly that shape shipped ads that were never
//      inspected but read as "passed" everywhere downstream.
//
// Both are fixed here to match backend exactly (function-for-function,
// same fallback chain, same reason-string constants). This harness pins
// both fixes structurally against the REAL module — no re-implementation,
// no stubbing of the function under test — so a future edit that
// reopens either hole turns this red immediately.
//
// Pure + offline: buildPersistedVerdict is a pure object-shaper, and the
// resolver checks inject a fake `deps.getXEnabled` so no Mongo/SystemConfig
// is touched. Async checks are genuinely awaited (see runCheck) — a
// fire-and-forget promise here would silently "pass" no matter what it
// asserts, which is exactly the kind of bug this harness exists to avoid
// shipping in the thing it's checking.
//
//   node scripts/verifyVisionQcPersistedVerdictInvariant.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'src', 'services', 'adVisionQcService.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const STRIPPED = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

const qc = require(SRC_PATH);

let checks = 0;
const failures = [];
async function runCheck(label, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
  }
}

async function main() {
  // ── Group A: the persisted-verdict invariant ──────────────────────────

  await runCheck('A1: skipped:true + passed:true collapses to passed:false', () => {
    const v = qc.buildPersistedVerdict({ passed: true, skipped: true, disabled: false, reason: 'x' });
    assert.strictEqual(v.passed, false, `expected passed:false, got ${v.passed}`);
  });

  await runCheck('A2: disabled:true + passed:true collapses to passed:false', () => {
    const v = qc.buildPersistedVerdict({ passed: true, skipped: false, disabled: true, reason: 'x' });
    assert.strictEqual(v.passed, false, `expected passed:false, got ${v.passed}`);
  });

  await runCheck('A3: skipped:true AND disabled:true + passed:true still collapses to passed:false', () => {
    const v = qc.buildPersistedVerdict({ passed: true, skipped: true, disabled: true, reason: 'x' });
    assert.strictEqual(v.passed, false, `expected passed:false, got ${v.passed}`);
  });

  await runCheck('A4: sanity — a real inspect-and-pass verdict (neither skipped nor disabled) still passes', () => {
    const v = qc.buildPersistedVerdict({ passed: true, skipped: false, disabled: false, reason: null });
    assert.strictEqual(v.passed, true, `expected passed:true, got ${v.passed} — A1-A3 must not break the real path`);
  });

  await runCheck('A5: sanity — a real inspect-and-fail verdict stays failed', () => {
    const v = qc.buildPersistedVerdict({ passed: false, skipped: false, disabled: false, reason: null });
    assert.strictEqual(v.passed, false);
  });

  // ── Group B: the retired env-var fallback must be gone, structurally ──

  await runCheck('B1: envEnabled/staticEnvEnabled/videoEnvEnabled are not defined anywhere in the file', () => {
    for (const name of ['envEnabled', 'staticEnvEnabled', 'videoEnvEnabled']) {
      assert.ok(!SRC.includes(`function ${name}(`), `${name}() still defined — the retired fallback is back`);
    }
  });

  await runCheck('B2: envEnabled/staticEnvEnabled/videoEnvEnabled are not exported', () => {
    for (const name of ['envEnabled', 'staticEnvEnabled', 'videoEnvEnabled']) {
      assert.strictEqual(qc[name], undefined, `module.exports.${name} still present`);
    }
  });

  await runCheck('B3: no live code reads AD_VISION_QC_ENABLED / STATIC_VISION_QC_ENABLED / VIDEO_VISION_QC_ENABLED from process.env (comments exempt)', () => {
    for (const name of ['AD_VISION_QC_ENABLED', 'STATIC_VISION_QC_ENABLED', 'VIDEO_VISION_QC_ENABLED']) {
      assert.ok(
        !STRIPPED.includes(`process.env.${name}`),
        `process.env.${name} is read outside a comment — the retired fallback is back`
      );
    }
  });

  await runCheck('B4: behavioural — resolveEnabled() ignores AD_VISION_QC_ENABLED=true when SystemConfig has no override', async () => {
    const prev = process.env.AD_VISION_QC_ENABLED;
    process.env.AD_VISION_QC_ENABLED = 'true';
    try {
      // getAdVisionQcEnabled resolving non-boolean (null) simulates "no
      // SystemConfig override configured" — the real contract per
      // systemConfigService.js.
      const result = await qc.resolveEnabled({ getAdVisionQcEnabled: async () => null });
      assert.strictEqual(result, false, `expected false (no env fallback), got ${result}`);
    } finally {
      if (prev === undefined) delete process.env.AD_VISION_QC_ENABLED;
      else process.env.AD_VISION_QC_ENABLED = prev;
    }
  });

  await runCheck('B5: behavioural — resolveVideoEnabled() ignores VIDEO_VISION_QC_ENABLED=true on a throwing SystemConfig read', async () => {
    const prev = process.env.VIDEO_VISION_QC_ENABLED;
    process.env.VIDEO_VISION_QC_ENABLED = 'true';
    try {
      const result = await qc.resolveVideoEnabled({ getVideoVisionQcEnabled: async () => { throw new Error('boom'); } });
      assert.strictEqual(result, false, `expected false (fail toward OFF, no env fallback), got ${result}`);
    } finally {
      if (prev === undefined) delete process.env.VIDEO_VISION_QC_ENABLED;
      else process.env.VIDEO_VISION_QC_ENABLED = prev;
    }
  });

  // ── Group C: persisted reason strings cite SystemConfig, not the retired env ──

  await runCheck('C1: persisted reason constants are SystemConfig-worded, not the retired env var', () => {
    assert.ok(!/reason:\s*['"]AD_VISION_QC_ENABLED=false['"]/.test(STRIPPED),
      "a persisted reason: still literally cites 'AD_VISION_QC_ENABLED=false'");
    assert.ok(SRC.includes("DISABLED_REASON_STATIC = 'vision QC disabled (SystemConfig.staticVisionQcEnabled)'"));
    assert.ok(SRC.includes("DISABLED_REASON_VIDEO = 'vision QC disabled (SystemConfig.videoVisionQcEnabled)'"));
  });

  const total = checks + failures.length;
  console.log('');
  if (failures.length) {
    console.log(`❌ verifyVisionQcPersistedVerdictInvariant: ${failures.length} of ${total} checks FAILED`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyVisionQcPersistedVerdictInvariant: ${total}/${total} checks passed`);
}

main();

/*
 * REVERT-PROOF LEDGER — mutations that would make this harness fail:
 *   1. buildPersistedVerdict's `passed: (skipped || disabled) ? false : !!passed`
 *      reverted to `passed: !!passed`                          → A1/A2/A3 fail
 *   2. envEnabled/staticEnvEnabled/videoEnvEnabled reintroduced  → B1/B2 fail
 *   3. a resolver reads process.env.*VISION_QC_ENABLED again     → B3/B4/B5 fail
 *   4. a persisted reason reverts to the literal env-var string  → C1 fails
 */
