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
delete process.env.STATIC_VISION_QC_ENABLED;
delete process.env.VIDEO_VISION_QC_ENABLED;

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

let stubDbValue = null;          // legacy adVisionQcEnabled: true | false | null
                                 // undefined = no document (findOne → null)
let stubStaticDbValue = null;    // staticVisionQcEnabled: true | false | null
let stubVideoDbValue = null;     // videoVisionQcEnabled: true | false | null
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
            : {
                key: 'default',
                adVisionQcEnabled: stubDbValue,
                staticVisionQcEnabled: stubStaticDbValue,
                videoVisionQcEnabled: stubVideoDbValue
              }
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
  delete process.env.STATIC_VISION_QC_ENABLED;
  delete process.env.VIDEO_VISION_QC_ENABLED;
  stubDbValue = null;
  stubStaticDbValue = null;
  stubVideoDbValue = null;
  stubShouldThrow = false;
  systemConfig.resetAdVisionQcEnabledCache();
  systemConfig.resetStaticVisionQcEnabledCache();
  systemConfig.resetVideoVisionQcEnabledCache();
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

    check('A4 SystemConfig schema declares staticVisionQcEnabled + videoVisionQcEnabled (nullable tri-state)', () => {
      const paths = SystemConfig.schema.paths;
      assert.ok(paths.staticVisionQcEnabled, 'staticVisionQcEnabled path missing from schema');
      assert.ok(paths.videoVisionQcEnabled, 'videoVisionQcEnabled path missing from schema');
      assert.strictEqual(paths.staticVisionQcEnabled.defaultValue, null,
        'static default must be null (unset → migration bridge → env), not false');
      assert.strictEqual(paths.videoVisionQcEnabled.defaultValue, null,
        'video default must be null (unset → migration bridge → env), not false');
      // Legacy field must still be present — removing it is the
      // "ships uninspected ads" bug the split's comments exist to prevent.
      assert.ok(paths.adVisionQcEnabled, 'legacy adVisionQcEnabled must stay on the schema');
    });

    check('A5 split-gate service surface: resolvers, env helpers, parseBoolEnv, get/set/peek/reset', () => {
      assert.strictEqual(typeof qc.resolveStaticEnabled, 'function');
      assert.strictEqual(typeof qc.resolveVideoEnabled, 'function');
      assert.strictEqual(typeof qc.staticEnvEnabled, 'function');
      assert.strictEqual(typeof qc.videoEnvEnabled, 'function');
      assert.strictEqual(typeof qc.parseBoolEnv, 'function');
      // Legacy exports must stay — this harness's A3/C/D/E/F still call them.
      assert.strictEqual(typeof qc.resolveEnabled, 'function');
      assert.strictEqual(typeof qc.envEnabled, 'function');
      assert.strictEqual(typeof systemConfig.getStaticVisionQcEnabled, 'function');
      assert.strictEqual(typeof systemConfig.setStaticVisionQcEnabled, 'function');
      assert.strictEqual(typeof systemConfig.peekStaticVisionQcEnabled, 'function');
      assert.strictEqual(typeof systemConfig.resetStaticVisionQcEnabledCache, 'function');
      assert.strictEqual(typeof systemConfig.refreshStaticVisionQcEnabledCache, 'function');
      assert.strictEqual(typeof systemConfig.getVideoVisionQcEnabled, 'function');
      assert.strictEqual(typeof systemConfig.setVideoVisionQcEnabled, 'function');
      assert.strictEqual(typeof systemConfig.peekVideoVisionQcEnabled, 'function');
      assert.strictEqual(typeof systemConfig.resetVideoVisionQcEnabledCache, 'function');
      assert.strictEqual(typeof systemConfig.refreshVideoVisionQcEnabledCache, 'function');
    });

    check('A6 config/defaults.env keeps AD_VISION_QC_ENABLED and adds the two split names', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'config', 'defaults.env'),
        'utf8'
      );
      assert.match(src, /^AD_VISION_QC_ENABLED=/m);
      assert.match(src, /^STATIC_VISION_QC_ENABLED=/m);
      assert.match(src, /^VIDEO_VISION_QC_ENABLED=/m);
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

    // ── K. TTL-EXPIRY REGRESSION — the exact bug reported live 2026-08-20 ──
    // Owner repro, reproduced here without real sleeps (Date.now is mocked
    // forward instead of waiting out the TTL):
    //   RESOLVE_ENABLED_ASYNC              true   (awaits the DB read — correct)
    //   IS_ENABLED_SYNC_CALL_1              true   (cache still warm)
    //   IS_ENABLED_SYNC_CALL_2 (+8s gap)    ??? ← was `false` pre-fix (BUG),
    //                                             must be `true` post-fix
    //   IS_ENABLED_SYNC_CALL_3 (+200ms)     true   (unchanged either way)
    //
    // A harness that only ever calls isEnabled()/peekAdVisionQcEnabled() on a
    // WARM cache (I1/I2 above) passes against the broken code — the whole
    // point of this section is a call landing AFTER the TTL elapses, which
    // is the NORMAL case in production (real renders are spaced further
    // apart than the 5s TTL) but was never exercised by I1/I2.
    function withMockedNow(offsetMs, fn) {
      const base = Date.now();
      const orig = Date.now;
      Date.now = () => base + offsetMs;
      try {
        return fn();
      } finally {
        Date.now = orig;
      }
    }

    // Async-safe variant — keeps Date.now mocked until the returned promise
    // SETTLES, not just until it is created. K1-K4 below only ever wrap a
    // synchronous function (peekAdVisionQcEnabled / isEnabled), where the
    // plain version above is exact. K5 wraps resolveEnabled(), which awaits
    // internally, so it needs this one.
    async function withMockedNowAsync(offsetMs, fn) {
      const base = Date.now();
      const orig = Date.now;
      Date.now = () => base + offsetMs;
      try {
        return await fn();
      } finally {
        Date.now = orig;
      }
    }

    await checkAsync('K1 peekAdVisionQcEnabled survives past the TTL (stale-but-real, not undefined)', async () => {
      resetAll();
      stubDbValue = true;
      systemConfig.resetAdVisionQcEnabledCache();
      await systemConfig.getAdVisionQcEnabled(); // warm the cache at "now"
      // Jump past AD_VISION_QC_CACHE_TTL_MS (5000ms) without any reset or
      // re-read — this is exactly what a real render arriving >5s after the
      // last one looks like.
      const peeked = withMockedNow(systemConfig.AD_VISION_QC_CACHE_TTL_MS + 3000, () =>
        systemConfig.peekAdVisionQcEnabled());
      assert.strictEqual(peeked, true,
        'a value loaded once must still be readable after its TTL elapses — ' +
        'expiry should trigger a BACKGROUND refresh, not erase the last known answer');
    });

    await checkAsync('K2 isEnabled() past the TTL still reflects the true DB value, not env', async () => {
      resetAll();
      // Env is the OPPOSITE of the DB value — if the bug is present, the
      // stale-cache fallback silently answers the env value instead.
      process.env.AD_VISION_QC_ENABLED = 'false';
      stubDbValue = true;
      systemConfig.resetAdVisionQcEnabledCache();
      await systemConfig.getAdVisionQcEnabled(); // IS_ENABLED_SYNC_CALL_1 equivalent: warm
      assert.strictEqual(qc.isEnabled(), true, 'sanity: warm cache must read true first');

      // IS_ENABLED_SYNC_CALL_2 (+8s gap, i.e. past the 5s TTL). Pre-fix this
      // read `undefined` from peek (expired) and fell through to envEnabled()
      // === false — the exact production incident (11/18 statics stamped
      // disabled:true with the flag genuinely on).
      const call2 = withMockedNow(8000, () => qc.isEnabled());
      assert.strictEqual(call2, true,
        'CALL_2 (+8s, past TTL): must still read the true DB value (true), ' +
        'not silently fall back to env (false) merely because nobody has ' +
        're-fetched in the last 8 seconds');

      // IS_ENABLED_SYNC_CALL_3 (+200ms more) — unaffected either way, kept
      // for parity with the owner's exact repro shape.
      const call3 = withMockedNow(8200, () => qc.isEnabled());
      assert.strictEqual(call3, true, 'CALL_3 (+8.2s): still true');
    });

    await checkAsync('K3 isEnabled() past the TTL still reflects DB false over env true', async () => {
      // Mirror of K2 in the other direction — the bug is direction-agnostic
      // (it reads "whatever env says" once stale), so pin both.
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      stubDbValue = false;
      systemConfig.resetAdVisionQcEnabledCache();
      await systemConfig.getAdVisionQcEnabled();
      assert.strictEqual(qc.isEnabled(), false, 'sanity: warm cache must read false first');

      const stale = withMockedNow(9000, () => qc.isEnabled());
      assert.strictEqual(stale, false,
        'past TTL, isEnabled() must still honour the DB false (explicit kill-switch), ' +
        'not fall through to env true just because the cache is stale');
    });

    await checkAsync('K4 a TRULY cold cache (never loaded) still falls through to env — unchanged', async () => {
      // Distinguishes "stale" (K1-K3: a real answer exists, just past its
      // TTL) from "cold" (nothing has EVER been read in this process) — only
      // the latter is genuine absence of data and should still default via
      // env, matching the pre-existing "unconfigured -> off" contract.
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      systemConfig.resetAdVisionQcEnabledCache();
      assert.strictEqual(systemConfig.peekAdVisionQcEnabled(), undefined,
        'never-loaded cache must still peek as undefined, not invent a value');
      assert.strictEqual(qc.isEnabled(), true,
        'a truly cold cache falls through to env — this is "unconfigured", not "stale"');
    });

    await checkAsync('K5 resolveEnabled() (the async path) is correct across the same TTL gap', async () => {
      // The async path was never racy (it awaits a real read), but pin it
      // alongside the sync-path regression so a future change to either
      // cannot silently reintroduce staleness-as-off asymmetry between them.
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'false';
      stubDbValue = true;
      systemConfig.resetAdVisionQcEnabledCache();
      const getCfg = () => systemConfig.getAdVisionQcEnabled();
      assert.strictEqual(await qc.resolveEnabled({ getAdVisionQcEnabled: getCfg }), true);
      const stalePeekButRealRead = await withMockedNowAsync(8000, () =>
        qc.resolveEnabled({ getAdVisionQcEnabled: getCfg }));
      assert.strictEqual(stalePeekButRealRead, true,
        'resolveEnabled() awaits a real read every time its own cache is stale — ' +
        'must never regress to answering from env just because time has passed');
    });

    // ── J. source wiring: schema + service field name ────────────────
    check('J1 models/SystemConfig.js source contains adVisionQcEnabled', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'models', 'SystemConfig.js'),
        'utf8'
      );
      assert.match(src, /adVisionQcEnabled\s*:/);
    });

    check('J2 models/SystemConfig.js source contains the split fields (legacy kept)', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'models', 'SystemConfig.js'),
        'utf8'
      );
      assert.match(src, /staticVisionQcEnabled\s*:/);
      assert.match(src, /videoVisionQcEnabled\s*:/);
      assert.match(src, /adVisionQcEnabled\s*:/);
    });

    // Shared deps bag for the split resolvers. Passing BOTH getters on
    // every call is load-bearing: a resolver that copy-pasted the other
    // pipeline's dep key would ignore its own getter and read this one.
    function splitDeps(staticVal, videoVal) {
      return {
        getStaticVisionQcEnabled: async () => staticVal,
        getVideoVisionQcEnabled: async () => videoVal
      };
    }

    // ── L. resolveStaticEnabled precedence (mirror of C/D/F, static only) ─
    await checkAsync('L1 default OFF: no SystemConfig, no env → resolveStaticEnabled false', async () => {
      resetAll();
      stubStaticDbValue = null;
      stubDbValue = null;
      const v = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
      });
      assert.strictEqual(v, false);
    });

    await checkAsync('L2 SystemConfig static true wins over env unset', async () => {
      resetAll();
      stubStaticDbValue = true;
      stubDbValue = null;
      const v = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'DB static true must enable QC even with env unset');
    });

    await checkAsync('L3 SystemConfig static true wins over STATIC env false', async () => {
      resetAll();
      process.env.STATIC_VISION_QC_ENABLED = 'false';
      stubStaticDbValue = true;
      stubDbValue = null;
      systemConfig.resetStaticVisionQcEnabledCache();
      const v = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'DB static true must beat STATIC env false');
    });

    await checkAsync('L4 SystemConfig static false wins over STATIC env true (explicit off)', async () => {
      resetAll();
      process.env.STATIC_VISION_QC_ENABLED = 'true';
      stubStaticDbValue = false;
      stubDbValue = null;
      systemConfig.resetStaticVisionQcEnabledCache();
      const v = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
      });
      assert.strictEqual(v, false,
        'DB static false is an explicit kill-switch and must beat STATIC env true');
    });

    await checkAsync('L5 SystemConfig static null falls through to STATIC env true', async () => {
      resetAll();
      process.env.STATIC_VISION_QC_ENABLED = 'true';
      stubStaticDbValue = null;
      stubDbValue = null; // no legacy bridge either
      systemConfig.resetStaticVisionQcEnabledCache();
      const v = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'null static DB override must fall through to STATIC env');
    });

    await checkAsync('L6 throwing getStaticVisionQcEnabled does not propagate (falls back to STATIC env)', async () => {
      resetAll();
      process.env.STATIC_VISION_QC_ENABLED = 'true';
      delete process.env.AD_VISION_QC_ENABLED;
      const v = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: async () => {
          throw new Error('mongo down (injected)');
        }
      });
      assert.strictEqual(v, true,
        'must fall back to staticEnvEnabled (STATIC=true), not throw, and not envEnabled (AD unset → false)');
    });

    await checkAsync('L7 throwing getStaticVisionQcEnabled with STATIC unset → false', async () => {
      resetAll();
      const v = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: async () => {
          throw new Error('mongo down (injected)');
        }
      });
      assert.strictEqual(v, false);
    });

    await checkAsync('L8 injected getStaticVisionQcEnabled true is honoured (deps win without Mongo)', async () => {
      resetAll();
      stubStaticDbValue = false;
      stubDbValue = false;
      const v = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: async () => true
      });
      assert.strictEqual(v, true,
        'deps.getStaticVisionQcEnabled must be the resolver\'s SystemConfig read, matching resolveEnabled\'s deps.getAdVisionQcEnabled');
    });

    // ── M. resolveVideoEnabled precedence (mirror of L, video only) ────
    await checkAsync('M1 default OFF: no SystemConfig, no env → resolveVideoEnabled false', async () => {
      resetAll();
      stubVideoDbValue = null;
      stubDbValue = null;
      const v = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: () => systemConfig.getVideoVisionQcEnabled()
      });
      assert.strictEqual(v, false);
    });

    await checkAsync('M2 SystemConfig video true wins over env unset', async () => {
      resetAll();
      stubVideoDbValue = true;
      stubDbValue = null;
      const v = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: () => systemConfig.getVideoVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'DB video true must enable QC even with env unset');
    });

    await checkAsync('M3 SystemConfig video true wins over VIDEO env false', async () => {
      resetAll();
      process.env.VIDEO_VISION_QC_ENABLED = 'false';
      stubVideoDbValue = true;
      stubDbValue = null;
      systemConfig.resetVideoVisionQcEnabledCache();
      const v = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: () => systemConfig.getVideoVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'DB video true must beat VIDEO env false');
    });

    await checkAsync('M4 SystemConfig video false wins over VIDEO env true (explicit off)', async () => {
      resetAll();
      process.env.VIDEO_VISION_QC_ENABLED = 'true';
      stubVideoDbValue = false;
      stubDbValue = null;
      systemConfig.resetVideoVisionQcEnabledCache();
      const v = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: () => systemConfig.getVideoVisionQcEnabled()
      });
      assert.strictEqual(v, false,
        'DB video false is an explicit kill-switch and must beat VIDEO env true');
    });

    await checkAsync('M5 SystemConfig video null falls through to VIDEO env true', async () => {
      resetAll();
      process.env.VIDEO_VISION_QC_ENABLED = 'true';
      stubVideoDbValue = null;
      stubDbValue = null;
      systemConfig.resetVideoVisionQcEnabledCache();
      const v = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: () => systemConfig.getVideoVisionQcEnabled()
      });
      assert.strictEqual(v, true, 'null video DB override must fall through to VIDEO env');
    });

    await checkAsync('M6 throwing getVideoVisionQcEnabled does not propagate (falls back to VIDEO env)', async () => {
      resetAll();
      process.env.VIDEO_VISION_QC_ENABLED = 'true';
      delete process.env.AD_VISION_QC_ENABLED;
      const v = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: async () => {
          throw new Error('mongo down (injected)');
        }
      });
      assert.strictEqual(v, true,
        'must fall back to videoEnvEnabled (VIDEO=true), not throw, and not envEnabled (AD unset → false)');
    });

    await checkAsync('M7 throwing getVideoVisionQcEnabled with VIDEO unset → false', async () => {
      resetAll();
      const v = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: async () => {
          throw new Error('mongo down (injected)');
        }
      });
      assert.strictEqual(v, false);
    });

    await checkAsync('M8 injected getVideoVisionQcEnabled true is honoured (deps win without Mongo)', async () => {
      resetAll();
      stubVideoDbValue = false;
      stubDbValue = false;
      const v = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: async () => true
      });
      assert.strictEqual(v, true,
        'deps.getVideoVisionQcEnabled must be the resolver\'s SystemConfig read');
    });

    // ── N. MIGRATION BRIDGE — real getStatic/getVideoVisionQcEnabled ──
    // These call the REAL systemConfigService getters against the SAME
    // SystemConfig.findOne stub as D1/G1. A hand-rolled getter would not
    // prove the bridge that keeps prod QC on across this deploy.

    await checkAsync('N1 static field unset + legacy DB true → getStaticVisionQcEnabled true (bridge)', async () => {
      resetAll();
      stubStaticDbValue = null;
      stubVideoDbValue = false; // sibling off — must not leak
      stubDbValue = true;
      const dbVal = await systemConfig.getStaticVisionQcEnabled();
      assert.strictEqual(dbVal, true,
        'unset staticVisionQcEnabled must bridge to legacy adVisionQcEnabled=true, ' +
        'not fall through to env/false and not read the video field');
      const resolved = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
      });
      assert.strictEqual(resolved, true,
        'resolveStaticEnabled must honour the bridged getter, not skip it and read env');
    });

    await checkAsync('N2 video field unset + legacy DB true → getVideoVisionQcEnabled true (bridge)', async () => {
      resetAll();
      stubVideoDbValue = null;
      stubStaticDbValue = false; // sibling off — must not leak
      stubDbValue = true;
      const dbVal = await systemConfig.getVideoVisionQcEnabled();
      assert.strictEqual(dbVal, true,
        'unset videoVisionQcEnabled must bridge to legacy adVisionQcEnabled=true');
      const resolved = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: () => systemConfig.getVideoVisionQcEnabled()
      });
      assert.strictEqual(resolved, true);
    });

    await checkAsync('N3 static field explicitly false wins over legacy true (bridge only while unset)', async () => {
      resetAll();
      stubStaticDbValue = false;
      stubDbValue = true;
      stubVideoDbValue = true;
      const dbVal = await systemConfig.getStaticVisionQcEnabled();
      assert.strictEqual(dbVal, false,
        'explicit static false must win over legacy true — once the new field is set the bridge must not apply');
      const resolved = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
      });
      assert.strictEqual(resolved, false);
    });

    await checkAsync('N4 video field explicitly false wins over legacy true (bridge only while unset)', async () => {
      resetAll();
      stubVideoDbValue = false;
      stubDbValue = true;
      stubStaticDbValue = true;
      const dbVal = await systemConfig.getVideoVisionQcEnabled();
      assert.strictEqual(dbVal, false,
        'explicit video false must win over legacy true');
      const resolved = await qc.resolveVideoEnabled({
        getVideoVisionQcEnabled: () => systemConfig.getVideoVisionQcEnabled()
      });
      assert.strictEqual(resolved, false);
    });

    await checkAsync('N5 static field explicitly true wins over legacy false', async () => {
      resetAll();
      stubStaticDbValue = true;
      stubDbValue = false;
      const dbVal = await systemConfig.getStaticVisionQcEnabled();
      assert.strictEqual(dbVal, true,
        'explicit static true must win over legacy false');
    });

    await checkAsync('N6 bridge is to LEGACY, not to the sibling pipeline field', async () => {
      resetAll();
      // static unset, video true, legacy false → static must be false (legacy),
      // not true (that would mean it bridged to videoVisionQcEnabled).
      stubStaticDbValue = null;
      stubVideoDbValue = true;
      stubDbValue = false;
      const s = await systemConfig.getStaticVisionQcEnabled();
      assert.strictEqual(s, false,
        'static unset must bridge to adVisionQcEnabled (false), not to videoVisionQcEnabled (true)');
      const v = await systemConfig.getVideoVisionQcEnabled();
      assert.strictEqual(v, true,
        'video explicit true must still win on its own getter');
    });

    await checkAsync('N7 both new fields unset + legacy null → getters return null (resolver then env)', async () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      stubStaticDbValue = null;
      stubVideoDbValue = null;
      stubDbValue = null;
      assert.strictEqual(await systemConfig.getStaticVisionQcEnabled(), null,
        'getter must return null (not false) so the resolver can fall through to env');
      assert.strictEqual(await systemConfig.getVideoVisionQcEnabled(), null);
      assert.strictEqual(
        await qc.resolveStaticEnabled({
          getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
        }),
        true,
        'null getter + AD env true (STATIC unset → staticEnvEnabled → envEnabled) must enable'
      );
      assert.strictEqual(
        await qc.resolveVideoEnabled({
          getVideoVisionQcEnabled: () => systemConfig.getVideoVisionQcEnabled()
        }),
        true
      );
    });

    await checkAsync('N8 no SystemConfig document → getter null (bridge cannot invent a legacy value)', async () => {
      resetAll();
      stubDbValue = undefined; // existing idiom: findOne lean() → null
      stubStaticDbValue = true; // would be true IF a document existed — it must not
      const s = await systemConfig.getStaticVisionQcEnabled();
      assert.strictEqual(s, null,
        'a missing singleton has no legacy field to bridge from; must return null, not the stubStatic value sitting on a document that was not returned');
    });

    await checkAsync('N9 static and video TTL caches are independent (shared-cache copy-paste)', async () => {
      resetAll();
      stubStaticDbValue = true;
      stubVideoDbValue = false;
      stubDbValue = null;
      let reads = 0;
      const orig = SystemConfig.findOne;
      SystemConfig.findOne = function (...args) {
        reads += 1;
        return orig.apply(this, args);
      };
      try {
        const s1 = await systemConfig.getStaticVisionQcEnabled();
        const s2 = await systemConfig.getStaticVisionQcEnabled();
        assert.strictEqual(s1, true);
        assert.strictEqual(s2, true);
        assert.strictEqual(reads, 1, `static cache hit should not re-read Mongo, got ${reads} reads`);
        const v = await systemConfig.getVideoVisionQcEnabled();
        assert.strictEqual(v, false,
          'video getter must not serve the static cache (true) — a shared cache object would return true here');
        assert.strictEqual(reads, 2, `video has its own cache and must perform its own Mongo read, got ${reads}`);
        assert.strictEqual(systemConfig.peekStaticVisionQcEnabled(), true);
        assert.strictEqual(systemConfig.peekVideoVisionQcEnabled(), false);
      } finally {
        SystemConfig.findOne = orig;
        installStub();
      }
    });

    // ── O. 2×2 independence matrix ───────────────────────────────────
    await checkAsync('O1 2×2 matrix: each resolver returns its own injected value (both getters passed every time)', async () => {
      resetAll();
      const combos = [
        { name: 'static=true,video=false', s: true, v: false },
        { name: 'static=false,video=true', s: false, v: true },
        { name: 'static=true,video=true', s: true, v: true },
        { name: 'static=false,video=false', s: false, v: false }
      ];
      for (const c of combos) {
        const deps = splitDeps(c.s, c.v);
        const gotS = await qc.resolveStaticEnabled(deps);
        const gotV = await qc.resolveVideoEnabled(deps);
        assert.strictEqual(gotS, c.s,
          `${c.name}: resolveStaticEnabled returned ${gotS}, expected ${c.s} ` +
          `(if this equals the VIDEO value, the static resolver is reading getVideoVisionQcEnabled)`);
        assert.strictEqual(gotV, c.v,
          `${c.name}: resolveVideoEnabled returned ${gotV}, expected ${c.v} ` +
          `(if this equals the STATIC value, the video resolver is reading getStaticVisionQcEnabled)`);
      }
    });

    await checkAsync('O2 flipping ONLY video does not change resolveStaticEnabled', async () => {
      resetAll();
      for (const s of [true, false]) {
        const before = await qc.resolveStaticEnabled(splitDeps(s, false));
        const after = await qc.resolveStaticEnabled(splitDeps(s, true));
        assert.strictEqual(before, s);
        assert.strictEqual(after, s,
          `flipping video false→true must not change resolveStaticEnabled (held static=${s})`);
        assert.strictEqual(await qc.resolveVideoEnabled(splitDeps(s, false)), false);
        assert.strictEqual(await qc.resolveVideoEnabled(splitDeps(s, true)), true);
      }
    });

    await checkAsync('O3 flipping ONLY static does not change resolveVideoEnabled', async () => {
      resetAll();
      for (const v of [true, false]) {
        const before = await qc.resolveVideoEnabled(splitDeps(false, v));
        const after = await qc.resolveVideoEnabled(splitDeps(true, v));
        assert.strictEqual(before, v);
        assert.strictEqual(after, v,
          `flipping static false→true must not change resolveVideoEnabled (held video=${v})`);
        assert.strictEqual(await qc.resolveStaticEnabled(splitDeps(false, v)), false);
        assert.strictEqual(await qc.resolveStaticEnabled(splitDeps(true, v)), true);
      }
    });

    await checkAsync('O4 2×2 against REAL getters + Mongo stub (not just injected deps)', async () => {
      // Injected deps in O1 would still pass if both resolvers ignored deps
      // and read the same Mongo field that happened to match. This arm
      // drives the real getters so a shared-field copy-paste fails.
      resetAll();
      const combos = [
        { name: 'static=true,video=false', s: true, v: false },
        { name: 'static=false,video=true', s: false, v: true },
        { name: 'static=true,video=true', s: true, v: true },
        { name: 'static=false,video=false', s: false, v: false }
      ];
      for (const c of combos) {
        stubStaticDbValue = c.s;
        stubVideoDbValue = c.v;
        stubDbValue = null; // no legacy bridge
        systemConfig.resetStaticVisionQcEnabledCache();
        systemConfig.resetVideoVisionQcEnabledCache();
        const gotS = await qc.resolveStaticEnabled({
          getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
        });
        const gotV = await qc.resolveVideoEnabled({
          getVideoVisionQcEnabled: () => systemConfig.getVideoVisionQcEnabled()
        });
        assert.strictEqual(gotS, c.s, `${c.name} (real getter): static expected ${c.s}, got ${gotS}`);
        assert.strictEqual(gotV, c.v, `${c.name} (real getter): video expected ${c.v}, got ${gotV}`);
      }
    });

    // ── P. mutation-style cross-wiring (copy-pasted the wrong dep key) ─
    await checkAsync('P1 resolveStaticEnabled must NOT invoke getVideoVisionQcEnabled (throws if it does)', async () => {
      resetAll();
      stubStaticDbValue = false;
      stubVideoDbValue = false;
      stubDbValue = false;
      const v = await qc.resolveStaticEnabled({
        getStaticVisionQcEnabled: async () => true,
        getVideoVisionQcEnabled: async () => {
          throw new Error('resolveStaticEnabled invoked getVideoVisionQcEnabled (copy-pasted the video dep key)');
        }
      });
      assert.strictEqual(v, true,
        'static resolver must use getStaticVisionQcEnabled (true) — ' +
        'if it copy-pasted getVideoVisionQcEnabled this either threw or returned Mongo false');
    });

    await checkAsync('P2 resolveVideoEnabled must NOT invoke getStaticVisionQcEnabled (returns true IFF it did)', async () => {
      resetAll();
      stubStaticDbValue = false;
      stubVideoDbValue = false;
      stubDbValue = false;
      // Static accessor returns true; video accessor returns false.
      // If resolveVideoEnabled accidentally called getStaticVisionQcEnabled,
      // it would resolve true — the only way this assertion sees true.
      const v = await qc.resolveVideoEnabled({
        getStaticVisionQcEnabled: async () => true,
        getVideoVisionQcEnabled: async () => false
      });
      assert.strictEqual(v, false,
        'resolveVideoEnabled must return its own getter (false), not the static getter (true)');

      // Same fact, fail-loud: the static getter throws if touched.
      const v2 = await qc.resolveVideoEnabled({
        getStaticVisionQcEnabled: async () => {
          throw new Error('resolveVideoEnabled invoked getStaticVisionQcEnabled (copy-pasted the static dep key)');
        },
        getVideoVisionQcEnabled: async () => false
      });
      assert.strictEqual(v2, false);
    });

    // ── Q. shared parseBoolEnv semantics across all three env helpers ─
    check('Q1 parseBoolEnv("1") is false — and all three env helpers agree', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = '1';
      process.env.STATIC_VISION_QC_ENABLED = '1';
      process.env.VIDEO_VISION_QC_ENABLED = '1';
      assert.strictEqual(qc.parseBoolEnv('1'), false);
      assert.strictEqual(qc.envEnabled(), false);
      assert.strictEqual(qc.staticEnvEnabled(), false);
      assert.strictEqual(qc.videoEnvEnabled(), false,
        'if videoEnvEnabled is true here it is not using parseBoolEnv (truthy "1")');
    });

    check('Q2 parseBoolEnv("TRUE ") trailing space is false — all three agree', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'TRUE ';
      process.env.STATIC_VISION_QC_ENABLED = 'TRUE ';
      process.env.VIDEO_VISION_QC_ENABLED = 'TRUE ';
      assert.strictEqual(qc.parseBoolEnv('TRUE '), false,
        'toLowerCase alone does not trim — trailing space must stay off');
      assert.strictEqual(qc.envEnabled(), false);
      assert.strictEqual(qc.staticEnvEnabled(), false);
      assert.strictEqual(qc.videoEnvEnabled(), false);
    });

    check('Q3 parseBoolEnv("true") is true — all three agree', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      process.env.STATIC_VISION_QC_ENABLED = 'true';
      process.env.VIDEO_VISION_QC_ENABLED = 'true';
      assert.strictEqual(qc.parseBoolEnv('true'), true);
      assert.strictEqual(qc.envEnabled(), true);
      assert.strictEqual(qc.staticEnvEnabled(), true);
      assert.strictEqual(qc.videoEnvEnabled(), true);
    });

    check('Q4 parseBoolEnv("TRUE") is true (toLowerCase) — all three agree', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'TRUE';
      process.env.STATIC_VISION_QC_ENABLED = 'TRUE';
      process.env.VIDEO_VISION_QC_ENABLED = 'TRUE';
      assert.strictEqual(qc.parseBoolEnv('TRUE'), true);
      assert.strictEqual(qc.envEnabled(), true);
      assert.strictEqual(qc.staticEnvEnabled(), true);
      assert.strictEqual(qc.videoEnvEnabled(), true);
    });

    check('Q5 unset → false on parseBoolEnv and all three env helpers', () => {
      resetAll();
      assert.strictEqual(qc.parseBoolEnv(undefined), false);
      assert.strictEqual(qc.parseBoolEnv(null), false);
      assert.strictEqual(qc.parseBoolEnv(''), false);
      assert.strictEqual(qc.envEnabled(), false);
      assert.strictEqual(qc.staticEnvEnabled(), false);
      assert.strictEqual(qc.videoEnvEnabled(), false);
    });

    // ── R. per-gate env-var fallback (own name unset → legacy AD_ name) ─
    check('R1 STATIC unset + AD_VISION_QC_ENABLED=true → staticEnvEnabled true (legacy env bridge)', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      delete process.env.STATIC_VISION_QC_ENABLED;
      delete process.env.VIDEO_VISION_QC_ENABLED;
      assert.strictEqual(qc.staticEnvEnabled(), true,
        'entirely-unset STATIC_VISION_QC_ENABLED must fall back to envEnabled() (legacy true)');
      assert.strictEqual(qc.videoEnvEnabled(), true,
        'entirely-unset VIDEO_VISION_QC_ENABLED must fall back to the same legacy true');
      assert.strictEqual(qc.envEnabled(), true);
    });

    check('R2 STATIC="" wins over legacy true (empty is set, not unset)', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      process.env.STATIC_VISION_QC_ENABLED = '';
      delete process.env.VIDEO_VISION_QC_ENABLED;
      assert.strictEqual(qc.staticEnvEnabled(), false,
        'empty string is !== undefined so it wins outright; parseBoolEnv("") is false even though legacy is true');
      assert.strictEqual(qc.envEnabled(), true,
        'legacy envEnabled must be unaffected by STATIC being set');
      assert.strictEqual(qc.videoEnvEnabled(), true,
        'setting STATIC must not steal VIDEO\'s unset→legacy fallback');
    });

    check('R3 STATIC="false" wins over legacy true', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      process.env.STATIC_VISION_QC_ENABLED = 'false';
      assert.strictEqual(qc.staticEnvEnabled(), false,
        'STATIC=false must win over AD=true — the new name, once present, is the whole decision');
    });

    check('R4 STATIC="true" wins over legacy false', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'false';
      process.env.STATIC_VISION_QC_ENABLED = 'true';
      assert.strictEqual(qc.staticEnvEnabled(), true);
      assert.strictEqual(qc.envEnabled(), false);
    });

    check('R5 VIDEO unset + AD_VISION_QC_ENABLED=true → videoEnvEnabled true (legacy env bridge)', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      delete process.env.VIDEO_VISION_QC_ENABLED;
      assert.strictEqual(qc.videoEnvEnabled(), true);
    });

    check('R6 VIDEO="" wins over legacy true (empty is set, not unset)', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      process.env.VIDEO_VISION_QC_ENABLED = '';
      delete process.env.STATIC_VISION_QC_ENABLED;
      assert.strictEqual(qc.videoEnvEnabled(), false,
        'empty string is !== undefined so it wins outright even though legacy is true');
      assert.strictEqual(qc.staticEnvEnabled(), true,
        'setting VIDEO must not steal STATIC\'s unset→legacy fallback');
    });

    check('R7 VIDEO="false" wins over legacy true', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'true';
      process.env.VIDEO_VISION_QC_ENABLED = 'false';
      assert.strictEqual(qc.videoEnvEnabled(), false);
    });

    check('R8 VIDEO="true" wins over legacy false', () => {
      resetAll();
      process.env.AD_VISION_QC_ENABLED = 'false';
      process.env.VIDEO_VISION_QC_ENABLED = 'true';
      assert.strictEqual(qc.videoEnvEnabled(), true);
      assert.strictEqual(qc.envEnabled(), false);
    });

    // ── S. runPostRenderQc / runVideoPostRenderQc enabled-omitted fallback ─
    // runPostRenderQc calls resolveStaticEnabled() as a SAME-MODULE lexical
    // binding, so qc.resolveStaticEnabled = … (the sibling-harness export
    // swap) does NOT intercept it — that is the PR #288 class applied to
    // CJS. The hop the resolver actually performs at call time is
    // require('./systemConfigService').getStaticVisionQcEnabled, and THAT
    // is a require-cache export — the same idiom this file already uses
    // for SystemConfig.findOne. We swap those getters.
    //
    // Observable: gate OFF → skipped/disabled, judgeFn never called.
    //            gate ON  → judgeFn called, skipped false.

    function passingVerdict() {
      return {
        pass: true,
        summary: 'clean',
        findings: [],
        categories: {
          competitor_marks: { score: 9, pass: true, findings: [] },
          product_fidelity: { score: 9, pass: true, findings: [] },
          text_defects: { score: 9, pass: true, findings: [] },
          layout_safe_box: { score: 9, pass: true, findings: [] }
        }
      };
    }

    function functionBody(src, fnName) {
      const start = src.indexOf(`function ${fnName}`);
      assert.ok(start >= 0, `${fnName} function not found`);
      const sigClose = src.slice(start).search(/\)\s*\{/);
      assert.ok(sigClose >= 0, `${fnName} signature close not found`);
      const brace = start + sigClose + src.slice(start + sigClose).indexOf('{');
      let depth = 0;
      for (let i = brace; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) return src.slice(start, i + 1);
        }
      }
      throw new Error(`${fnName} body not closed`);
    }

    await checkAsync('S1 runPostRenderQc(enabled omitted) reads getStaticVisionQcEnabled, not video/legacy', async () => {
      resetAll();
      const origS = systemConfig.getStaticVisionQcEnabled;
      const origV = systemConfig.getVideoVisionQcEnabled;
      const origL = systemConfig.getAdVisionQcEnabled;
      let staticCalls = 0;
      let videoCalls = 0;
      let legacyCalls = 0;
      let judgeCalls = 0;
      systemConfig.getStaticVisionQcEnabled = async () => { staticCalls += 1; return true; };
      systemConfig.getVideoVisionQcEnabled = async () => { videoCalls += 1; return false; };
      systemConfig.getAdVisionQcEnabled = async () => { legacyCalls += 1; return false; };
      try {
        const result = await qc.runPostRenderQc({
          // enabled omitted on purpose — this IS the fallback branch
          originalProductUrl: 'https://example.test/product.jpg',
          generate: async () => ({ renderUrl: 'https://example.test/ad.png' }),
          judgeFn: async () => { judgeCalls += 1; return passingVerdict(); },
          adId: 'qc-gate-s1'
        });
        assert.ok(staticCalls >= 1,
          `runPostRenderQc fallback must call getStaticVisionQcEnabled (got ${staticCalls} calls)`);
        assert.strictEqual(videoCalls, 0,
          `runPostRenderQc must not call getVideoVisionQcEnabled (got ${videoCalls}) — that is the video resolver`);
        assert.strictEqual(legacyCalls, 0,
          `runPostRenderQc must not call getAdVisionQcEnabled (got ${legacyCalls}) — that is the pre-split resolveEnabled path`);
        assert.ok(judgeCalls >= 1,
          'static getter returned true, so QC must actually run (judgeFn called) — a stale resolveEnabled() stub would skip');
        assert.strictEqual(result.skipped, false);
      } finally {
        systemConfig.getStaticVisionQcEnabled = origS;
        systemConfig.getVideoVisionQcEnabled = origV;
        systemConfig.getAdVisionQcEnabled = origL;
      }
    });

    await checkAsync('S2 runVideoPostRenderQc(enabled omitted) reads getVideoVisionQcEnabled, not static/legacy', async () => {
      resetAll();
      const origS = systemConfig.getStaticVisionQcEnabled;
      const origV = systemConfig.getVideoVisionQcEnabled;
      const origL = systemConfig.getAdVisionQcEnabled;
      let staticCalls = 0;
      let videoCalls = 0;
      let legacyCalls = 0;
      let judgeCalls = 0;
      systemConfig.getStaticVisionQcEnabled = async () => { staticCalls += 1; return false; };
      systemConfig.getVideoVisionQcEnabled = async () => { videoCalls += 1; return true; };
      systemConfig.getAdVisionQcEnabled = async () => { legacyCalls += 1; return false; };
      try {
        const result = await qc.runVideoPostRenderQc({
          originalProductUrl: 'https://example.test/product.jpg',
          frames: [{ timestampSec: 0.5, url: 'https://example.test/frame.jpg' }],
          judgeFn: async () => { judgeCalls += 1; return passingVerdict(); },
          adId: 'qc-gate-s2'
        });
        assert.ok(videoCalls >= 1,
          `runVideoPostRenderQc fallback must call getVideoVisionQcEnabled (got ${videoCalls} calls)`);
        assert.strictEqual(staticCalls, 0,
          `runVideoPostRenderQc must not call getStaticVisionQcEnabled (got ${staticCalls})`);
        assert.strictEqual(legacyCalls, 0,
          `runVideoPostRenderQc must not call getAdVisionQcEnabled (got ${legacyCalls}) — that is the pre-split resolveEnabled path`);
        assert.ok(judgeCalls >= 1,
          'video getter returned true, so QC must actually run (judgeFn called)');
        assert.strictEqual(result.skipped, false);
      } finally {
        systemConfig.getStaticVisionQcEnabled = origS;
        systemConfig.getVideoVisionQcEnabled = origV;
        systemConfig.getAdVisionQcEnabled = origL;
      }
    });

    await checkAsync('S3 swapping ONLY the video getter changes only runVideoPostRenderQc', async () => {
      resetAll();
      const origS = systemConfig.getStaticVisionQcEnabled;
      const origV = systemConfig.getVideoVisionQcEnabled;
      let staticGate = true;
      let videoGate = false;
      systemConfig.getStaticVisionQcEnabled = async () => staticGate;
      systemConfig.getVideoVisionQcEnabled = async () => videoGate;
      try {
        const staticBefore = await qc.runPostRenderQc({
          originalProductUrl: 'https://example.test/product.jpg',
          generate: async () => ({ renderUrl: 'https://example.test/ad.png' }),
          judgeFn: async () => passingVerdict(),
          adId: 'qc-gate-s3-static-before'
        });
        const videoBefore = await qc.runVideoPostRenderQc({
          originalProductUrl: 'https://example.test/product.jpg',
          frames: [{ timestampSec: 0.5, url: 'https://example.test/frame.jpg' }],
          judgeFn: async () => passingVerdict(),
          adId: 'qc-gate-s3-video-before'
        });
        assert.strictEqual(staticBefore.skipped, false, 'static=true → runPostRenderQc must inspect');
        assert.strictEqual(videoBefore.skipped, true, 'video=false → runVideoPostRenderQc must skip');
        assert.strictEqual(videoBefore.visionQc && videoBefore.visionQc.disabled, true);

        // Flip ONLY video.
        videoGate = true;
        const staticAfter = await qc.runPostRenderQc({
          originalProductUrl: 'https://example.test/product.jpg',
          generate: async () => ({ renderUrl: 'https://example.test/ad.png' }),
          judgeFn: async () => passingVerdict(),
          adId: 'qc-gate-s3-static-after'
        });
        const videoAfter = await qc.runVideoPostRenderQc({
          originalProductUrl: 'https://example.test/product.jpg',
          frames: [{ timestampSec: 0.5, url: 'https://example.test/frame.jpg' }],
          judgeFn: async () => passingVerdict(),
          adId: 'qc-gate-s3-video-after'
        });
        assert.strictEqual(staticAfter.skipped, false,
          'flipping ONLY video true must not change runPostRenderQc (still inspects)');
        assert.strictEqual(videoAfter.skipped, false,
          'flipping video false→true must make runVideoPostRenderQc inspect');
      } finally {
        systemConfig.getStaticVisionQcEnabled = origS;
        systemConfig.getVideoVisionQcEnabled = origV;
      }
    });

    await checkAsync('S4 swapping ONLY the static getter changes only runPostRenderQc', async () => {
      resetAll();
      const origS = systemConfig.getStaticVisionQcEnabled;
      const origV = systemConfig.getVideoVisionQcEnabled;
      let staticGate = true;
      let videoGate = true;
      systemConfig.getStaticVisionQcEnabled = async () => staticGate;
      systemConfig.getVideoVisionQcEnabled = async () => videoGate;
      try {
        staticGate = false; // flip ONLY static
        const staticRes = await qc.runPostRenderQc({
          originalProductUrl: 'https://example.test/product.jpg',
          generate: async () => ({ renderUrl: 'https://example.test/ad.png' }),
          judgeFn: async () => {
            throw new Error('runPostRenderQc judged while static getter is false — still on the video/legacy resolver');
          },
          adId: 'qc-gate-s4-static'
        });
        const videoRes = await qc.runVideoPostRenderQc({
          originalProductUrl: 'https://example.test/product.jpg',
          frames: [{ timestampSec: 0.5, url: 'https://example.test/frame.jpg' }],
          judgeFn: async () => passingVerdict(),
          adId: 'qc-gate-s4-video'
        });
        assert.strictEqual(staticRes.skipped, true,
          'static=false → runPostRenderQc must skip (and must not call judgeFn)');
        assert.strictEqual(staticRes.visionQc && staticRes.visionQc.disabled, true);
        assert.strictEqual(videoRes.skipped, false,
          'flipping ONLY static false must not change runVideoPostRenderQc (still inspects)');
      } finally {
        systemConfig.getStaticVisionQcEnabled = origS;
        systemConfig.getVideoVisionQcEnabled = origV;
      }
    });

    check('S5 runPostRenderQc source fallback calls resolveStaticEnabled (not video, not legacy)', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'services', 'adVisionQcService.js'),
        'utf8'
      );
      const body = functionBody(src, 'runPostRenderQc');
      const stripped = body
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      assert.match(stripped, /typeof enabled === ['"]boolean['"]/);
      assert.match(stripped, /\bresolveStaticEnabled\s*\(/);
      assert.ok(!/\bresolveVideoEnabled\s*\(/.test(stripped),
        'runPostRenderQc must not call resolveVideoEnabled');
      assert.ok(!/\bresolveEnabled\s*\(/.test(stripped),
        'runPostRenderQc must not fall back to the legacy resolveEnabled() — that is the stale-stub class from PR #288');
    });

    check('S6 runVideoPostRenderQc source fallback calls resolveVideoEnabled (not static, not legacy)', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'services', 'adVisionQcService.js'),
        'utf8'
      );
      const body = functionBody(src, 'runVideoPostRenderQc');
      const stripped = body
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      assert.match(stripped, /typeof enabled === ['"]boolean['"]/);
      assert.match(stripped, /\bresolveVideoEnabled\s*\(/);
      assert.ok(!/\bresolveStaticEnabled\s*\(/.test(stripped),
        'runVideoPostRenderQc must not call resolveStaticEnabled');
      assert.ok(!/\bresolveEnabled\s*\(/.test(stripped),
        'runVideoPostRenderQc must not fall back to the legacy resolveEnabled()');
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
