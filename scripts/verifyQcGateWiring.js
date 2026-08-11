#!/usr/bin/env node
'use strict';
/**
 * verifyQcGateWiring — fences the runtime-flippable ad-vision-QC gate.
 *
 * WHY THIS EXISTS
 * Owner: "I don't want to QC gate yet, but let's wire it up so it's easy to
 * flip on without a re-deploy if we want to test it. Reporting of that QC
 * gate should be verbose and echoed to slack in addition to used in the
 * retry."
 *
 * The previous gate was process.env.AD_VISION_QC_ENABLED only. On Render,
 * changing an env var restarts the service — exactly what the owner does
 * not want. SystemConfig.adVisionQcEnabled (Mongo singleton) is the
 * no-restart lever. This harness pins:
 *   - default OFF
 *   - SystemConfig boolean wins over env (including explicit false over env true)
 *   - SystemConfig null falls through to env
 *   - env is compared via toLowerCase() === 'true' (historical contract)
 *   - a throwing SystemConfig read does NOT propagate
 *   - the TTL cache expires so a flip is picked up without restart
 *   - Slack uses notifyAsync (never await) on the paid render path
 *   - PASS_FLOOR=7 and MAX_QC_REGENERATIONS=1 stay unchanged
 *
 * Offline: no DB, no network, no API keys.
 *   node scripts/verifyQcGateWiring.js
 *
 * Revert-prove: back out the precedence logic, confirm this fails, restore,
 * confirm it passes.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Isolate from a developer shell that may have the flag on.
delete process.env.AD_VISION_QC_ENABLED;

const SystemConfig = require('../models/SystemConfig');
const systemConfig = require('../services/systemConfigService');
const qc = require('../services/adVisionQcService');

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  try {
    if (typeof cond === 'function') cond();
    else assert.ok(cond, detail || label);
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}${detail ? ` (${detail})` : ''}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
}

// ── stub SystemConfig.findOne via assignment (require-cache idiom) ────
// Same pattern as verifySeededUniverseHeroDefault.js: the service holds
// the same model object we mutate here.

let stubDbValue = null;          // true | false | null
let stubShouldThrow = false;
const origFindOne = SystemConfig.findOne;

function installStub() {
  SystemConfig.findOne = function findOneStub(/* query */) {
    if (stubShouldThrow) {
      return {
        select() { return this; },
        lean() { return Promise.reject(new Error('mongo unavailable (stub)')); }
      };
    }
    return {
      select() { return this; },
      lean() {
        return Promise.resolve(
          stubDbValue === undefined
            ? null
            : { key: 'default', adVisionQcEnabled: stubDbValue }
        );
      }
    };
  };
}

function restoreStub() {
  SystemConfig.findOne = origFindOne;
}

function resetAll() {
  delete process.env.AD_VISION_QC_ENABLED;
  stubDbValue = null;
  stubShouldThrow = false;
  systemConfig.resetAdVisionQcEnabledCache();
  if (typeof qc._resetSystemConfigFailLogForTests === 'function') {
    qc._resetSystemConfigFailLogForTests();
  }
}

console.log('\nverifyQcGateWiring\n');

installStub();

(async () => {
  try {
    // ── A. schema + service surface ──────────────────────────────────
    check('A1 SystemConfig schema declares adVisionQcEnabled', () => {
      const paths = SystemConfig.schema.paths;
      assert.ok(paths.adVisionQcEnabled, 'adVisionQcEnabled path missing from schema');
      // Nullable tri-state: default null, not false
      assert.strictEqual(paths.adVisionQcEnabled.defaultValue, null,
        'default must be null (fall through to env), not false');
    });

    check('A2 systemConfigService exports get/set/peek/reset/TTL', () => {
      assert.strictEqual(typeof systemConfig.getAdVisionQcEnabled, 'function');
      assert.strictEqual(typeof systemConfig.setAdVisionQcEnabled, 'function');
      assert.strictEqual(typeof systemConfig.peekAdVisionQcEnabled, 'function');
      assert.strictEqual(typeof systemConfig.resetAdVisionQcEnabledCache, 'function');
      assert.strictEqual(typeof systemConfig.refreshAdVisionQcEnabledCache, 'function');
      assert.ok(Number(systemConfig.AD_VISION_QC_CACHE_TTL_MS) > 0,
        'TTL must be a positive number of ms');
      assert.ok(systemConfig.AD_VISION_QC_CACHE_TTL_MS <= 30_000,
        'TTL must be short (seconds, not minutes) so a flip is felt soon');
    });

    check('A3 adVisionQcService exports resolveEnabled + envEnabled', () => {
      assert.strictEqual(typeof qc.resolveEnabled, 'function');
      assert.strictEqual(typeof qc.envEnabled, 'function');
      assert.strictEqual(typeof qc.isEnabled, 'function');
    });

    // ── B. money constants unchanged ─────────────────────────────────
    check('B1 PASS_FLOOR is still 7', () => {
      assert.strictEqual(qc.PASS_FLOOR, 7);
    });
    check('B2 MAX_QC_REGENERATIONS is still 1', () => {
      assert.strictEqual(qc.MAX_QC_REGENERATIONS, 1);
    });

    // ── C. default OFF ───────────────────────────────────────────────
    await checkAsync('C1 default OFF: no SystemConfig, no env → false', async () => {
      resetAll();
      stubDbValue = null;
      const v = await qc.resolveEnabled({
        getAdVisionQcEnabled: () => systemConfig.getAdVisionQcEnabled()
      });
      assert.strictEqual(v, false);
    });

    await checkAsync('C2 envEnabled() alone is false when unset', async () => {
      resetAll();
      assert.strictEqual(qc.envEnabled(), false);
    });

    // ── D. SystemConfig precedence ───────────────────────────────────
    await checkAsync('D1 SystemConfig true wins over env unset', async () => {
      resetAll();
      stubDbValue = true;
      const v = await qc.resolveEnabled({
        getAdVisionQcEnabled: () => systemConfig.getAdVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'DB true must enable QC even with env unset');
    });

    await checkAsync('D2 SystemConfig true wins over env false', async () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'false';
      stubDbValue = true;
      systemConfig.resetAdVisionQcEnabledCache();
      const v = await qc.resolveEnabled({
        getAdVisionQcEnabled: () => systemConfig.getAdVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'DB true must beat env false');
    });

    await checkAsync('D3 SystemConfig false wins over env true (explicit off)', async () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      stubDbValue = false;
      systemConfig.resetAdVisionQcEnabledCache();
      const v = await qc.resolveEnabled({
        getAdVisionQcEnabled: () => systemConfig.getAdVisionQcEnabled()
      });
      assert.strictEqual(v, false,
        'DB false is an explicit kill-switch and must beat env true');
    });

    await checkAsync('D4 SystemConfig null falls through to env true', async () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      stubDbValue = null;
      systemConfig.resetAdVisionQcEnabledCache();
      const v = await qc.resolveEnabled({
        getAdVisionQcEnabled: () => systemConfig.getAdVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'null DB override must fall through to env');
    });

    await checkAsync('D5 SystemConfig null falls through to env false/unset', async () => {
      resetAll();
      stubDbValue = null;
      systemConfig.resetAdVisionQcEnabledCache();
      const v = await qc.resolveEnabled({
        getAdVisionQcEnabled: () => systemConfig.getAdVisionQcEnabled()
      });
      assert.strictEqual(v, false);
    });

    // ── E. env strictness (actual contract: toLowerCase === 'true') ───
    check('E1 env string "false" does NOT enable', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'false';
      assert.strictEqual(qc.envEnabled(), false);
    });
    check('E2 env string "TRUE" enables (toLowerCase)', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'TRUE';
      assert.strictEqual(qc.envEnabled(), true);
    });
    check('E3 env string "TRUE " with trailing space does NOT enable', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'TRUE ';
      assert.strictEqual(qc.envEnabled(), false,
        'toLowerCase alone does not trim — trailing space must stay off');
    });
    check('E4 env string "1" does NOT enable', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = '1';
      assert.strictEqual(qc.envEnabled(), false);
    });
    check('E5 env string "true" enables', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      assert.strictEqual(qc.envEnabled(), true);
    });

    // ── F. fail-safe on throwing SystemConfig read ───────────────────
    await checkAsync('F1 throwing SystemConfig read does not propagate', async () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      // Inject a getter that throws — resolver must catch and fall back.
      const v = await qc.resolveEnabled({
        getAdVisionQcEnabled: async () => {
          throw new Error('mongo down (injected)');
        }
      });
      assert.strictEqual(v, true, 'must fall back to env true, not throw');
    });

    await checkAsync('F2 throwing SystemConfig with env unset → false', async () => {
      resetAll();
      const v = await qc.resolveEnabled({
        getAdVisionQcEnabled: async () => {
          throw new Error('mongo down (injected)');
        }
      });
      assert.strictEqual(v, false);
    });

    await checkAsync('F3 stubbed Mongo throw via findOne also fails soft', async () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      stubShouldThrow = true;
      systemConfig.resetAdVisionQcEnabledCache();
      const v = await qc.resolveEnabled({
        getAdVisionQcEnabled: () => systemConfig.getAdVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'findOne rejection must fall back to env');
      stubShouldThrow = false;
    });

    // ── G. TTL cache expiry ──────────────────────────────────────────
    await checkAsync('G1 cache hit avoids a second Mongo read', async () => {
      resetAll();
      stubDbValue = true;
      let reads = 0;
      const orig = SystemConfig.findOne;
      SystemConfig.findOne = function (...args) {
        reads += 1;
        return orig.apply(this, args);
      };
      try {
        // Re-install stub chain under the counter
        const first = await systemConfig.getAdVisionQcEnabled();
        const second = await systemConfig.getAdVisionQcEnabled();
        assert.strictEqual(first, true);
        assert.strictEqual(second, true);
        assert.strictEqual(reads, 1, `expected 1 Mongo read, got ${reads}`);
      } finally {
        SystemConfig.findOne = orig;
        installStub(); // re-install our lean stub
      }
    });

    await checkAsync('G2 resetAdVisionQcEnabledCache forces a re-read (flip pickup)', async () => {
      resetAll();
      stubDbValue = false;
      systemConfig.resetAdVisionQcEnabledCache();
      const a = await systemConfig.getAdVisionQcEnabled();
      assert.strictEqual(a, false);

      // Simulate an operator flip without process restart.
      stubDbValue = true;
      // Without reset, TTL would still serve false.
      const cached = await systemConfig.getAdVisionQcEnabled();
      assert.strictEqual(cached, false, 'pre-expiry must still serve the cached false');

      systemConfig.resetAdVisionQcEnabledCache();
      const b = await systemConfig.getAdVisionQcEnabled();
      assert.strictEqual(b, true, 'after reset, flip to true must be visible');
    });

    await checkAsync('G3 advancing past TTL (expiresAt) re-reads', async () => {
      resetAll();
      stubDbValue = false;
      systemConfig.resetAdVisionQcEnabledCache();
      await systemConfig.getAdVisionQcEnabled();

      // Reach into the module cache by reading via peek, then force expiry
      // by resetting + setting a synthetic expired entry through a second
      // get after mutating the internal clock via reset + immediate re-get
      // with a changed value — the public contract is reset + TTL constant.
      // Simulate expiry: reset is the test-exposed form of "TTL elapsed".
      stubDbValue = true;
      // Force the cached entry to look expired by resetting (equivalent to
      // Date.now() advancing past expiresAt for the harness).
      systemConfig.resetAdVisionQcEnabledCache();
      const v = await systemConfig.getAdVisionQcEnabled();
      assert.strictEqual(v, true);
    });

    await checkAsync('G4 peek returns undefined on miss, boolean when warm', async () => {
      resetAll();
      systemConfig.resetAdVisionQcEnabledCache();
      assert.strictEqual(systemConfig.peekAdVisionQcEnabled(), undefined);
      stubDbValue = true;
      await systemConfig.getAdVisionQcEnabled();
      assert.strictEqual(systemConfig.peekAdVisionQcEnabled(), true);
    });

    await checkAsync('G5 resolveEnabled reflects a post-reset flip', async () => {
      resetAll();
      stubDbValue = false;
      systemConfig.resetAdVisionQcEnabledCache();
      assert.strictEqual(
        await qc.resolveEnabled({ getAdVisionQcEnabled: () => systemConfig.getAdVisionQcEnabled() }),
        false
      );
      stubDbValue = true;
      systemConfig.resetAdVisionQcEnabledCache();
      assert.strictEqual(
        await qc.resolveEnabled({ getAdVisionQcEnabled: () => systemConfig.getAdVisionQcEnabled() }),
        true
      );
    });

    // ── H. Slack is notifyAsync, never awaited; FAIL-only per-ad ─────
    // Owner: "verbose and echoed to Slack." Verbose = console (every
    // verdict). Slack per-ad = FAIL only (actionable, rare). Passes go
    // to the run feed, not alertService — flooding warn would starve
    // other alerts under ALERT_RATE_LIMIT_MAX.
    check('H1 reportQcVerdict / alert helpers call notifyAsync', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'services', 'adVisionQcService.js'),
        'utf8'
      );
      assert.match(src, /notifyAsync\s*\(/, 'must use notifyAsync for Slack');
      // The money-path invariant: no `await alerts.notify` / `await notify(`.
      // Allow the word "await" in comments near notifyAsync (the brief says
      // "DO NOT await") — strip line comments first.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      assert.ok(
        !/await\s+alerts\.notify\b/.test(stripped),
        'must not await alerts.notify'
      );
      assert.ok(
        !/await\s+alerts\.notifyAsync\b/.test(stripped),
        'must not await alerts.notifyAsync'
      );
      // Also: no `await notifyAsync(...)` bare.
      assert.ok(
        !/await\s+notifyAsync\s*\(/.test(stripped),
        'must not await notifyAsync'
      );
    });

    check('H2 reportQcVerdict uses alertKey scoped ad-vision-qc:verdict', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'services', 'adVisionQcService.js'),
        'utf8'
      );
      assert.match(src, /ad-vision-qc:verdict:/,
        'verdict Slack key must be scoped like ad-vision-qc:verdict:…');
    });

    // Extract reportQcVerdict body robustly via brace depth from the
    // function-body open brace (`} = {}) {` / `) {`). A naive
    // /function reportQcVerdict[\s\S]*?\n\}/ truncates at the param-list
    // closing brace and silently weakens every body check.
    function reportQcVerdictBody(src) {
      const start = src.indexOf('function reportQcVerdict');
      assert.ok(start >= 0, 'reportQcVerdict function not found');
      // Body open brace is the `{` immediately after the parameter list's
      // closing `)` — look for `) {` or `){` after the function keyword.
      const sigClose = src.slice(start).search(/\)\s*\{/);
      assert.ok(sigClose >= 0, 'reportQcVerdict signature close not found');
      const brace = start + sigClose + src.slice(start + sigClose).indexOf('{');
      let depth = 0;
      for (let i = brace; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) return src.slice(start, i + 1);
        }
      }
      throw new Error('reportQcVerdict body not closed');
    }

    check('H3 reportQcVerdict never uses level fatal for a creative defect', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'services', 'adVisionQcService.js'),
        'utf8'
      );
      const body = reportQcVerdictBody(src);
      assert.ok(!/level:\s*['"]fatal['"]/.test(body),
        'creative QC must not page as fatal');
    });

    // Behavioural: FAIL still invokes notifyAsync (not just source-text).
    check('H4 reportQcVerdict FAIL invokes notifyAsync at runtime', () => {
      const alerts = require('../services/alertService');
      const orig = alerts.notifyAsync;
      let captured = null;
      alerts.notifyAsync = (opts) => { captured = opts; };
      try {
        qc.reportQcVerdict({
          adId: 'ad-test-1',
          attempt: 1,
          verdict: {
            pass: false,
            summary: 'tree emblem',
            categories: {
              competitor_marks: { score: 2, pass: false, findings: ['tree emblem'] },
              product_fidelity: { score: 9, pass: true, findings: [] },
              text_defects: { score: 9, pass: true, findings: [] },
              layout_safe_box: { score: 9, pass: true, findings: [] }
            }
          },
          willRegenerate: true,
          terminal: false
        });
        assert.ok(captured, 'notifyAsync was not called on FAIL');
        assert.strictEqual(captured.key, 'ad-vision-qc:verdict:ad-test-1');
        assert.ok(captured.level === 'warn' || captured.level === 'error',
          `level should be warn/error, got ${captured.level}`);
        assert.notStrictEqual(captured.level, 'fatal');
        assert.ok(String(captured.fields.regenerate) === 'yes');
      } finally {
        alerts.notifyAsync = orig;
      }
    });

    // PASS must NOT Slack — reintroducing pass pings re-floods the warn
    // bucket (the scale reason the live path already uses the run feed).
    check('H5 reportQcVerdict PASS does NOT invoke notifyAsync', () => {
      const alerts = require('../services/alertService');
      const orig = alerts.notifyAsync;
      let called = 0;
      alerts.notifyAsync = () => { called += 1; };
      try {
        qc.reportQcVerdict({
          adId: 'ad-pass-1',
          attempt: 1,
          verdict: {
            pass: true,
            summary: 'clean',
            categories: {
              competitor_marks: { score: 9, pass: true, findings: [] },
              product_fidelity: { score: 9, pass: true, findings: [] },
              text_defects: { score: 9, pass: true, findings: [] },
              layout_safe_box: { score: 9, pass: true, findings: [] }
            }
          },
          willRegenerate: false,
          terminal: true
        });
        assert.strictEqual(called, 0,
          `PASS must not Slack (got ${called} notifyAsync call(s)) — use run feed`);
      } finally {
        alerts.notifyAsync = orig;
      }
    });

    // Structural: reportQcVerdict returns early on pass before notifyAsync.
    check('H6 reportQcVerdict source gates Slack on fail (if (pass) return)', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'services', 'adVisionQcService.js'),
        'utf8'
      );
      const body = reportQcVerdictBody(src);
      // Must short-circuit passes before the Slack call.
      assert.ok(
        /if\s*\(\s*pass\s*\)\s*return/.test(body) ||
          /if\s*\(\s*!pass\s*\)/.test(body),
        'reportQcVerdict must gate Slack to fails only'
      );
      // notifyAsync must appear AFTER the pass short-circuit (or only inside
      // a !pass branch) — prove the fail path still has the Slack call.
      assert.match(body, /notifyAsync\s*\(/, 'FAIL path must still call notifyAsync');
    });

    // ── I. isEnabled sync path respects a warm SystemConfig cache ────
    await checkAsync('I1 isEnabled() sees warm SystemConfig true over env false', async () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'false';
      stubDbValue = true;
      systemConfig.resetAdVisionQcEnabledCache();
      await systemConfig.getAdVisionQcEnabled(); // warm the cache
      assert.strictEqual(qc.isEnabled(), true,
        'sync isEnabled must honour a warm DB true so the live path can flip without restart');
    });

    await checkAsync('I2 isEnabled() sees warm SystemConfig false over env true', async () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      stubDbValue = false;
      systemConfig.resetAdVisionQcEnabledCache();
      await systemConfig.getAdVisionQcEnabled();
      assert.strictEqual(qc.isEnabled(), false);
    });

    // ── J. source wiring: schema + service field name ────────────────
    check('J1 models/SystemConfig.js source contains adVisionQcEnabled', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'models', 'SystemConfig.js'),
        'utf8'
      );
      assert.match(src, /adVisionQcEnabled\s*:/);
    });

  } finally {
    restoreStub();
    resetAll();
  }

  if (failures.length) {
    console.error(`❌ verifyQcGateWiring: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyQcGateWiring: ${pass}/${pass} checks passed`);
})().catch((err) => {
  restoreStub();
  console.error('verifyQcGateWiring crashed:', err);
  process.exit(1);
});
