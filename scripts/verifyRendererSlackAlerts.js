#!/usr/bin/env node
'use strict';
//
// verifyRendererSlackAlerts — pins the Slack-alerting fix wired into
// src/services/renderer.js (fix/adgen-slack-alerting). Before this change
// renderer.js had ZERO references to alertService: its crash path only
// `console.warn`ed, and every alert the backend's routes/ads.js used to fire
// for this work (run-completion, derive-wait backup, video-unsettled,
// video-failed) was unreachable once ADGEN_RENDERER_ENABLED short-circuits
// runRenderLoop before it gets there. Measured consequence: adgen-renderer
// was OOM-killed twice on 2026-08-24, stranding 12 ads mid-titling, with
// zero Slack rows for that service that day.
//
// WHAT THIS PINS, behaviourally, by executing the REAL function bodies
// (not a reimplementation — see "ISOLATED MODULE LOAD" below):
//   A. notifyRenderFailure  — the processAd-catch alert. Video route
//      classifies unsettledAtTimeout (warn) vs a hard failure (error);
//      static route reuses directImageRenderService's existing
//      err.alertLevel/err.alertKey tag instead of a hardcoded class.
//   B. notifyDeriveWaitBackup — one alert per derive-wait episode, keyed on
//      the sibling master; escalates to 'error' when the master looks
//      genuinely stuck (rendering + stale) or the wait ceiling is exceeded.
//   C. notifyRunFinalized — the run-completion alert, silent when nothing
//      failed, 'error' when the whole run failed, 'warn' for a partial.
//   D. alertOrphanedClaimsOnBoot — read-only boot-time query for ads left
//      claimed+rendering that are BOTH claim-old (claimedAt < 20min) AND
//      not heartbeating (updatedAt < 5min / RESUME_STALE_MIN). claimedAt
//      alone is the false-page: the titling heartbeat writes updatedAt,
//      never claimedAt, so a healthy paid master still titling after 20
//      minutes used to match. A landed paid video master (veoVideoUrl
//      already set) alerts at 'error', everything else 'warn' — never
//      'info', which would be silently dropped by ALERT_MIN_LEVEL's
//      default 'warn' floor.
//   E. WIRING — each function above is actually CALLED from the render path
//      it claims to cover (processAd's catch, maybeFinalizeRun's success
//      branch, renderVideo's derive-wait branch, run()'s boot sequence).
//
// ISOLATED MODULE LOAD, not source-text extraction. A–D used to slice each
// function out of renderer.js with a balanced-brace parser and eval it via
// `new Function`, injecting free names (`alerts`, `Ad`, …) as parameters.
// That died the moment #19 added `const { childTailsFrom } = require(
// './renderErrorFields')` and referenced it inside notifyRenderFailure:
// the extracted body ran in a synthetic scope that did not include the
// new binding, threw before alerts.notifyAsync, and A1–A4 went red on
// healthy production code. Production alerting was never broken — the
// real module has the require at the top of renderer.js.
//
// The same class of bug is why verifyVideoQcVerdictSurvives.js section E
// (adgen #13 / backend #322) stopped scanning source and required the
// real module with require.cache stubs. We cannot copy that recipe
// verbatim here:
//   • renderer.js exports only { run, shutdown } — the functions under
//     test are not exported, and this harness does not change production
//     to export them.
//   • a bare load of src/services/renderer.js pulls src/config.js,
//     which process.exit(1)s without ADGEN_ROLE + MONGODB_URI, and then
//     the rest of the render graph (mongoose models, Atlas, Cloudinary,
//     Remotion). This file must stay node_modules-free.
//   • E6 forbids the harness from requiring alertService.
// So we compile renderer.js as its own Module with a custom require():
//   • './alertService' → the in-memory notifyAsync stub (never the real
//     module, never a Slack token / chat.postMessage).
//   • '../config', '../db', '../models/Ad' → test doubles.
//   • './renderErrorFields', './concurrency' → the real leaf modules
//     (no config/mongoose/network). A new require of this shape, used
//     inside notifyRenderFailure, just works — that is the #19 bug.
//   • any other project-local require → {} so a new heavy dependency
//     cannot pull mongoose/Slack into this script. If an alert function
//     starts *calling* a new leaf helper, add that specifier to
//     REAL_RELATIVE below (the trap, documented).
//   • module.exports is rewritten ONLY in the compiled copy so A–D can
//     call the unexported functions; the file on disk is untouched.
// E1–E5 stay source scans of call sites (wiring is not exported). Do
// not call run() — that starts poll loops.
//
// Pure + offline: no DB, no network, no Slack token, no node_modules
// required (only Node builtins: fs, path, assert, module). Run:
//   node scripts/verifyRendererSlackAlerts.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const RENDERER_PATH = path.join(__dirname, '..', 'src', 'services', 'renderer.js');
const SRC = fs.readFileSync(RENDERER_PATH, 'utf8');

let checks = 0;
const failures = [];
// async-aware: every check may be sync OR return a promise (the D-group
// functions are `async`). Awaiting unconditionally is correct for both —
// awaiting a non-promise value is a no-op in JS.
async function check(label, fn) {
  try { await fn(); checks += 1; }
  catch (err) { failures.push(`${label}\n     ${err.message}`); }
}

// ── tiny balanced-bracket slicer (same discipline as verifyRendererAtomicClaim.js) ──
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
// Isolated compile of renderer.js. Does NOT go through Node's normal
// require() of that file (E6 pins this), so config.js cannot process.exit
// and alertService never loads. The compiled copy is the real function
// bodies with a stubbed module graph.
const EXPORT_RE = /module\.exports\s*=\s*\{\s*run,\s*shutdown\s*\}\s*;/;
const REAL_RELATIVE = new Set(['./renderErrorFields', './concurrency']);

function specId(request) {
  return String(request || '').replace(/\\/g, '/').replace(/\.js$/i, '');
}

function loadRenderer({ alerts, Ad }) {
  assert.ok(EXPORT_RE.test(SRC),
    'renderer.js no longer assigns module.exports = { run, shutdown }; update the isolated loader');
  const wrapped = SRC.replace(
    EXPORT_RE,
    'module.exports = { run, shutdown, notifyRenderFailure, notifyDeriveWaitBackup, notifyRunFinalized, alertOrphanedClaimsOnBoot };'
  );

  const filename = RENDERER_PATH;
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));

  const origRequire = Module.prototype.require.bind(mod);
  const AdStub = Ad || {
    find() { throw new Error('isolated renderer: Ad.find was not stubbed for this check'); }
  };

  mod.require = function isolatedRequire(request) {
    const id = specId(request);
    if (id === '../config') {
      return {
        POLL_MS: 500,
        WORKER_ID: 'renderer-test',
        MAX_INFLIGHT: 32,
        isAdgenRendererEnabled: () => false
      };
    }
    if (id === '../db') {
      return {
        isStaleTopologyError: () => false,
        reconnectAfterStaleTopology: async () => {},
        resetReconnectAttempts: () => {}
      };
    }
    if (id === './alertService') return alerts;
    if (id === '../models/Ad') return AdStub;
    if (REAL_RELATIVE.has(id)) return origRequire(request);
    // Other project-local requires (directImage, atlas, cloudinary, models,
    // …) stay empty so this script never needs node_modules and never
    // reaches a live service. A new require of a LEAF helper that an
    // alert function actually calls must be added to REAL_RELATIVE —
    // that is the remaining trap, and it is smaller than "every free
    // name in the extracted body."
    if (id.startsWith('.')) return {};
    return origRequire(request);
  };

  mod._compile(wrapped, filename);
  return mod.exports;
}

function makeAlertsStub() {
  const calls = [];
  return { calls, notifyAsync(opts) { calls.push(opts); } };
}

function makeAdStub(docs) {
  let capturedFilter = null;
  const chain = {
    select() { return chain; },
    lean() { return Promise.resolve(docs); }
  };
  return {
    find(filter) { capturedFilter = filter; return chain; },
    _filter: () => capturedFilter
  };
}

// Apply the REAL Ad.find filter the isolated function issued — not a
// reimplementation of orphan logic. Understands only the operators this
// query uses (equality, $ne, $lt). Anything else fails closed.
function matchesCapturedFilter(doc, filter) {
  assert.ok(filter && typeof filter === 'object', 'Ad.find was never called');
  for (const [key, cond] of Object.entries(filter)) {
    const val = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if (Object.prototype.hasOwnProperty.call(cond, '$ne')) {
        if (val === cond.$ne) return false;
        if (cond.$ne === null && (val === undefined || val === null)) return false;
      }
      if (Object.prototype.hasOwnProperty.call(cond, '$lt')) {
        const a = val instanceof Date ? val.getTime() : Number(val);
        const b = cond.$lt instanceof Date ? cond.$lt.getTime() : Number(cond.$lt);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !(a < b)) return false;
      }
      const ops = Object.keys(cond).filter((k) => k.startsWith('$'));
      for (const op of ops) {
        if (op !== '$ne' && op !== '$lt') {
          throw new Error(`matchesCapturedFilter: unsupported operator ${op} on ${key}`);
        }
      }
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

function loadOrphanFn(alerts, AdStub) {
  return loadRenderer({ alerts, Ad: AdStub }).alertOrphanedClaimsOnBoot;
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  // A — notifyRenderFailure (processAd's catch)
  // ═══════════════════════════════════════════════════════════════════════
  const SIG_A = /function notifyRenderFailure\(ad, err\)\s*\{/;

  await check('A0 notifyRenderFailure exists in renderer.js', () => {
    assert.ok(SIG_A.test(SRC));
  });

  await check('A1 video route + unsettledAtTimeout → warn, video-unsettled key, carries predictionId', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyRenderFailure;
    const ad = { _id: 'ad1', renderRoute: 'veo', brandId: 'brandX', campaignRunIds: ['run1', 'run2'] };
    const err = new Error('atlasVideo: prediction timed out after 600s');
    err.unsettledAtTimeout = true;
    err.predictionId = 'pred-123';
    fn(ad, err);
    assert.strictEqual(alerts.calls.length, 1);
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'warn');
    assert.strictEqual(c.title, 'Video master unsettled at poll timeout — awaiting reconciliation');
    assert.strictEqual(c.key, `video-unsettled:${err.message.slice(0, 60)}`);
    assert.strictEqual(c.fields.ad, 'ad1');
    assert.strictEqual(c.fields.run, 'run2', 'must use the MOST RECENT campaignRunId, not the first');
    assert.strictEqual(c.fields.brand, 'brandX');
    assert.strictEqual(c.fields.predictionId, 'pred-123');
  });

  await check('A2 video route + ordinary failure → error, video-failed key, NO predictionId field', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyRenderFailure;
    const ad = { _id: 'ad2', renderRoute: 'veo', brandId: null, campaignRunIds: [] };
    const err = new Error('Atlas 500 Internal Server Error');
    fn(ad, err);
    assert.strictEqual(alerts.calls.length, 1);
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'error');
    assert.strictEqual(c.title, 'Video generation failed');
    assert.strictEqual(c.key, `video-failed:${err.message.slice(0, 60)}`);
    assert.strictEqual(c.fields.run, null);
    assert.strictEqual('predictionId' in c.fields, false);
  });

  await check('A3 static route, untagged error → defaults to error / direct-image:render-failed', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyRenderFailure;
    const ad = { _id: 'ad3', renderRoute: 'html_gen', brandId: 'brandY', campaignRunIds: ['run9'] };
    const err = new Error('buffer was empty');
    fn(ad, err);
    assert.strictEqual(alerts.calls.length, 1);
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'error');
    assert.strictEqual(c.title, 'Static ad render failed (direct overlay)');
    assert.strictEqual(c.key, 'direct-image:render-failed');
    assert.strictEqual(c.detail, err.stack);
  });

  await check('A4 static route reuses directImageRenderService\'s own err.alertLevel/err.alertKey tag', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyRenderFailure;
    const ad = { _id: 'ad4', renderRoute: 'html_gen', brandId: 'brandY', campaignRunIds: [] };
    const err = new Error('no Atlas credentials configured');
    err.alertLevel = 'fatal';
    err.alertKey = 'direct-image:no-credentials';
    fn(ad, err);
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'fatal', 'must use the THROWER\'s classification, not a hardcoded default');
    assert.strictEqual(c.key, 'direct-image:no-credentials');
  });

  await check('A5 a throwing alerts stub is swallowed — alerting must never fail the failure path', () => {
    const throwingAlerts = { notifyAsync() { throw new Error('slack transport blew up'); } };
    const fn = loadRenderer({ alerts: throwingAlerts }).notifyRenderFailure;
    assert.doesNotThrow(() => fn({ _id: 'x', renderRoute: 'veo', campaignRunIds: [] }, new Error('boom')));
  });

  // ═══════════════════════════════════════════════════════════════════════
  // B — notifyDeriveWaitBackup (renderVideo's derive-wait branch)
  // ═══════════════════════════════════════════════════════════════════════
  const SIG_B = /function notifyDeriveWaitBackup\(ad, master, waitAttempt\)\s*\{/;

  await check('B0 notifyDeriveWaitBackup exists in renderer.js', () => {
    assert.ok(SIG_B.test(SRC));
  });

  await check('B1 master never found yet → warn, backup title, key falls back to the ad id', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyDeriveWaitBackup;
    fn({ _id: 'adA' }, null, 1);
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'warn');
    assert.strictEqual(c.title, 'Derive-wait backup: sibling master still in flight');
    assert.strictEqual(c.key, 'derive-wait-backup:adA');
    assert.strictEqual(c.fields.masterStatus, 'not-found-yet');
  });

  await check('B2 master found but young + queued → still ordinary backup, not stuck', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyDeriveWaitBackup;
    const master = { _id: 'masterM', status: 'queued', updatedAt: new Date() };
    fn({ _id: 'adB' }, master, 2);
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'warn');
    assert.strictEqual(c.key, 'derive-wait-backup:masterM', 'must dedupe on the MASTER, not the ad, so siblings fold together');
  });

  await check('B3 [ESCALATION] master rendering + stale past CLAIM_STALE_MIN → error, STUCK title', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyDeriveWaitBackup;
    const master = { _id: 'masterN', status: 'rendering', updatedAt: new Date(Date.now() - 25 * 60 * 1000) };
    fn({ _id: 'adC' }, master, 3);
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'error');
    assert.strictEqual(c.title, 'Derive-wait: sibling master looks STUCK, not just backed up');
  });

  await check('B4 [ESCALATION] wait ceiling exceeded escalates level WITHOUT relabeling it "stuck"', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyDeriveWaitBackup;
    const master = { _id: 'masterP', status: 'queued', updatedAt: new Date() }; // NOT stuck by staleness
    fn({ _id: 'adD' }, master, 61); // > MAX_DERIVE_WAIT_ATTEMPTS (60)
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'error', 'exceeding the wait ceiling must still escalate');
    assert.strictEqual(c.title, 'Derive-wait backup: sibling master still in flight', 'title stays "backup" — only a genuinely stale master is called STUCK');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // C — notifyRunFinalized (maybeFinalizeRun's success branch)
  // ═══════════════════════════════════════════════════════════════════════
  const SIG_C = /function notifyRunFinalized\(runId, outcome\)\s*\{/;

  await check('C0 notifyRunFinalized exists in renderer.js', () => {
    assert.ok(SIG_C.test(SRC));
  });

  await check('C1 a run with zero failures alerts NOTHING (matches backend\'s nFailed > 0 gate)', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyRunFinalized;
    fn('run1', { succeeded: 5, failed: 0 });
    fn('run1', null);
    fn('run1', undefined);
    assert.strictEqual(alerts.calls.length, 0);
  });

  await check('C2 total failure (succeeded:0) → error, "failed entirely", run-failed:total key', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyRunFinalized;
    fn('run_abc', { succeeded: 0, failed: 3 });
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'error');
    assert.strictEqual(c.title, 'Campaign run failed entirely — 3 ad(s)');
    assert.strictEqual(c.key, 'run-failed:total');
    assert.strictEqual(c.fields.run, 'run_abc');
  });

  await check('C3 partial failure → warn, "finished with N failed", run-failed:partial key', () => {
    const alerts = makeAlertsStub();
    const fn = loadRenderer({ alerts }).notifyRunFinalized;
    fn('run_xyz', { succeeded: 5, failed: 2 });
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'warn');
    assert.strictEqual(c.title, 'Campaign run finished with 2 failed ad(s)');
    assert.strictEqual(c.key, 'run-failed:partial');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // D — alertOrphanedClaimsOnBoot (run()'s boot sequence)
  // ═══════════════════════════════════════════════════════════════════════
  const SIG_D = /async function alertOrphanedClaimsOnBoot\(\)\s*\{/;

  await check('D0 alertOrphanedClaimsOnBoot exists in renderer.js', () => {
    assert.ok(SIG_D.test(SRC));
  });

  await check('D1 nothing stale → zero alerts (function is read-only: only Ad.find is used)', async () => {
    const alerts = makeAlertsStub();
    const AdStub = makeAdStub([]);
    const fn = loadOrphanFn(alerts, AdStub);
    await fn();
    assert.strictEqual(alerts.calls.length, 0);
  });

  await check('D2 query shape: rendering + claimed + claimedAt old AND updatedAt quiet — both clocks, not claimedAt alone', async () => {
    const alerts = makeAlertsStub();
    const AdStub = makeAdStub([]);
    const fn = loadOrphanFn(alerts, AdStub);
    const before = Date.now();
    await fn();
    const filter = AdStub._filter();
    assert.deepStrictEqual(
      Object.keys(filter).sort(),
      ['claimedAt', 'claimedByWorker', 'status', 'updatedAt'],
      'orphan query must test exactly these four keys; claimedAt-only is the false-page this pin exists to catch'
    );
    assert.strictEqual(filter.status, 'rendering');
    assert.deepStrictEqual(filter.claimedByWorker, { $ne: null });
    assert.ok(filter.claimedAt && filter.claimedAt.$lt instanceof Date);
    assert.ok(filter.updatedAt && filter.updatedAt.$lt instanceof Date,
      'updatedAt staleness is required — claimedAt is stamped once at claimOne() and the heartbeat never refreshes it');
    const claimedAgeMin = (before - filter.claimedAt.$lt.getTime()) / 60000;
    const beatAgeMin    = (before - filter.updatedAt.$lt.getTime()) / 60000;
    assert.ok(Math.abs(claimedAgeMin - 20) < 1, `expected ~20min claimedAt cutoff (CLAIM_STALE_MIN), got ${claimedAgeMin.toFixed(2)}min`);
    assert.ok(Math.abs(beatAgeMin - 5) < 1,
      `expected ~5min updatedAt cutoff (RESUME_STALE_MIN = 3.3 missed 90s beats / 5 missed 60s beats), got ${beatAgeMin.toFixed(2)}min`);
    assert.ok(beatAgeMin >= 3,
      `updatedAt bound must outlast two clamped 90s beats (floor 3 min); got ${beatAgeMin.toFixed(2)}min`);
    assert.ok(beatAgeMin < claimedAgeMin,
      'heartbeat-silence bound must be tighter than claim-age — a live job beats every 60-90s');
  });

  await check('D3 [MONEY] a landed video master (veoVideoUrl set) stranded mid-titling alerts at error, keyed paid-master', async () => {
    const alerts = makeAlertsStub();
    const AdStub = makeAdStub([
      { _id: 'paidAd1', claimedByWorker: 'dead-worker-1', renderRoute: 'veo', veoVideoUrl: 'https://cloudinary/vid.mp4' }
    ]);
    const fn = loadOrphanFn(alerts, AdStub);
    await fn();
    assert.strictEqual(alerts.calls.length, 1);
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'error', 'a paid, already-landed master must not alert at a level ALERT_MIN_LEVEL could drop');
    assert.strictEqual(c.key, 'orphaned-claim:paid-master');
    assert.strictEqual(c.fields.count, 1);
  });

  await check('D4 a video claim with NO landed master yet (still unstarted) is the cheaper "unstarted" bucket, warn', async () => {
    const alerts = makeAlertsStub();
    const AdStub = makeAdStub([
      { _id: 'unstartedAd1', claimedByWorker: 'dead-worker-2', renderRoute: 'veo', veoVideoUrl: null },
      { _id: 'staticAd1', claimedByWorker: 'dead-worker-2', renderRoute: 'html_gen', veoVideoUrl: null }
    ]);
    const fn = loadOrphanFn(alerts, AdStub);
    await fn();
    assert.strictEqual(alerts.calls.length, 1);
    const c = alerts.calls[0];
    assert.strictEqual(c.level, 'warn');
    assert.strictEqual(c.key, 'orphaned-claim:unstarted');
    assert.strictEqual(c.fields.count, 2);
  });

  await check('D5 a mix of both buckets fires BOTH alerts independently, never merged', async () => {
    const alerts = makeAlertsStub();
    const AdStub = makeAdStub([
      { _id: 'paid', claimedByWorker: 'w1', renderRoute: 'veo', veoVideoUrl: 'https://x/y.mp4' },
      { _id: 'unstarted', claimedByWorker: 'w1', renderRoute: 'html_gen', veoVideoUrl: null }
    ]);
    const fn = loadOrphanFn(alerts, AdStub);
    await fn();
    assert.strictEqual(alerts.calls.length, 2);
    const keys = alerts.calls.map((c) => c.key).sort();
    assert.deepStrictEqual(keys, ['orphaned-claim:paid-master', 'orphaned-claim:unstarted']);
  });

  await check('D6 never throws even if the Ad query rejects — boot must not crash on a Mongo blip', async () => {
    const alerts = makeAlertsStub();
    // The thrown message is the Mongo-blip stand-in. The function's own
    // catch logs `renderer[renderer-test]: alertOrphanedClaimsOnBoot failed
    // — ECONNREFUSED`. That line is this stub, not a live connection:
    // Ad.find is the in-memory thrower below, and E6 guarantees the
    // harness never loads alertService. Capture the warn so a green run
    // does not look like it reached the network.
    const AdStub = { find() { throw new Error('ECONNREFUSED'); } };
    const fn = loadOrphanFn(alerts, AdStub);
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    try {
      await assert.doesNotReject(() => fn());
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      warnings.some((w) => /alertOrphanedClaimsOnBoot failed — ECONNREFUSED/.test(w)),
      'the catch path must log the handled Ad.find failure (WORKER_ID is the config stub)'
    );
  });

  // ── D7–D11: the REAL captured filter, run against timed fixtures ──
  // Ad.find's stub does not evaluate Mongo; D3–D5 inject already-matching
  // docs to pin classification. These checks pin the QUERY itself by
  // applying the filter object the isolated function actually issued.
  // D7 is the false-page this change exists to close.

  async function captureOrphanFilter() {
    const alerts = makeAlertsStub();
    const AdStub = makeAdStub([]);
    const fn = loadOrphanFn(alerts, AdStub);
    await fn();
    const filter = AdStub._filter();
    assert.ok(filter, 'Ad.find was never called');
    return { filter, alerts };
  }

  function fixture(overrides) {
    const now = Date.now();
    return {
      _id: 'fix',
      status: 'rendering',
      claimedByWorker: 'dead-or-live-worker',
      claimedAt: new Date(now - 40 * 60 * 1000),
      updatedAt: new Date(now - 40 * 60 * 1000),
      renderRoute: 'veo',
      veoVideoUrl: 'https://cloudinary/paid-master.mp4',
      ...overrides
    };
  }

  await check('D7 [FALSE-PAGE] claimed 40m ago, updatedAt 10s ago (healthy long titling job) MUST NOT match', async () => {
    const { filter } = await captureOrphanFilter();
    const doc = fixture({ updatedAt: new Date(Date.now() - 10 * 1000) });
    assert.strictEqual(
      matchesCapturedFilter(doc, filter),
      false,
      'a heartbeating paid master with a 40-minute-old claimedAt is WORKING work — paging it is the false page'
    );
    const matching = [doc].filter((d) => matchesCapturedFilter(d, filter));
    const alerts = makeAlertsStub();
    const fn = loadOrphanFn(alerts, makeAdStub(matching));
    await fn();
    assert.strictEqual(alerts.calls.length, 0, 'Mongo would return no row, so the boot scan must not page');
  });

  await check('D8 [MONEY] claimed 40m ago, updatedAt 40m ago (worker died mid-titling, holds paid master) MUST match AND page paid-master', async () => {
    const { filter } = await captureOrphanFilter();
    const doc = fixture({
      claimedAt: new Date(Date.now() - 40 * 60 * 1000),
      updatedAt: new Date(Date.now() - 40 * 60 * 1000)
    });
    assert.strictEqual(
      matchesCapturedFilter(doc, filter),
      true,
      'a dead worker holding a paid master is why this alert exists'
    );
    const alerts = makeAlertsStub();
    const AdStub = makeAdStub([doc]);
    const fn = loadOrphanFn(alerts, AdStub);
    await fn();
    assert.strictEqual(alerts.calls.length, 1);
    assert.strictEqual(alerts.calls[0].level, 'error');
    assert.strictEqual(alerts.calls[0].key, 'orphaned-claim:paid-master');
  });

  await check('D9 claimed 40m ago, updatedAt 40m ago, NO veoVideoUrl → query matches, classification is unstarted/warn (correct: no landed Omni asset)', async () => {
    const { filter } = await captureOrphanFilter();
    const doc = fixture({
      claimedAt: new Date(Date.now() - 40 * 60 * 1000),
      updatedAt: new Date(Date.now() - 40 * 60 * 1000),
      veoVideoUrl: null
    });
    assert.strictEqual(matchesCapturedFilter(doc, filter), true, 'a quiet 40m claim still matches the orphan query');
    const alerts = makeAlertsStub();
    const AdStub = makeAdStub([doc]);
    const fn = loadOrphanFn(alerts, AdStub);
    await fn();
    assert.strictEqual(alerts.calls.length, 1);
    assert.strictEqual(alerts.calls[0].level, 'warn');
    assert.strictEqual(alerts.calls[0].key, 'orphaned-claim:unstarted',
      'no veoVideoUrl means the ~$0.90 Omni asset never landed — warn, not the paid-master error');
  });

  await check('D10 claimed 2m ago, updatedAt 2m ago (fresh claim) MUST NOT match; nor a 2m claim with pre-claim stale updatedAt', async () => {
    const { filter } = await captureOrphanFilter();
    const now = Date.now();
    const fresh = fixture({
      claimedAt: new Date(now - 2 * 60 * 1000),
      updatedAt: new Date(now - 2 * 60 * 1000)
    });
    assert.strictEqual(matchesCapturedFilter(fresh, filter), false, 'a 2-minute-old claim is not an orphan');
    // claimOne() does not write updatedAt (timestamps:false). A sibling
    // that just claimed a backlog row can carry a 40-minute-old updatedAt
    // for the first 60-90s before its first beat. claimedAt is the gate
    // that keeps that from paging. This is why claimedAt stays in the
    // filter after updatedAt staleness was added — it is not redundant.
    const neverBeatYet = fixture({
      claimedAt: new Date(now - 2 * 60 * 1000),
      updatedAt: new Date(now - 40 * 60 * 1000)
    });
    assert.strictEqual(
      matchesCapturedFilter(neverBeatYet, filter),
      false,
      'a fresh claim with a pre-claim stale updatedAt must not page — this is why claimedAt remains in the filter'
    );
  });

  await check('D11 boundary: exactly at the updatedAt bound is NOT stale ($lt); one 90s beat either side', async () => {
    const { filter } = await captureOrphanFilter();
    const beatCutoff = filter.updatedAt.$lt.getTime();
    const BEAT_MS = 90_000; // AD_HEARTBEAT_SAFE_MAX_MS — worst-case interval
    const oldClaim = { claimedAt: new Date(Date.now() - 40 * 60 * 1000) };

    const atBound = fixture({ ...oldClaim, updatedAt: new Date(beatCutoff) });
    assert.strictEqual(matchesCapturedFilter(atBound, filter), false,
      'exactly at the cutoff is NOT stale — the query uses $lt, not $lte');

    const oneBeatOlder = fixture({ ...oldClaim, updatedAt: new Date(beatCutoff - BEAT_MS) });
    assert.strictEqual(matchesCapturedFilter(oneBeatOlder, filter), true,
      'one clamped beat (90s) past the bound is a missed-beat orphan');

    const oneBeatYounger = fixture({ ...oldClaim, updatedAt: new Date(beatCutoff + BEAT_MS) });
    assert.strictEqual(matchesCapturedFilter(oneBeatYounger, filter), false,
      'one clamped beat inside the bound is still a live heartbeat');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E — WIRING: each alert function above is actually CALLED from the
  // render path it claims to cover. A correct standalone function nobody
  // calls is exactly as silent in production as no function at all.
  // ═══════════════════════════════════════════════════════════════════════
  await check('E1 processAd\'s catch calls notifyRenderFailure(ad, err)', () => {
    const processAdBody = functionBody(SRC, /async function processAd\s*\(ad\)\s*\{/);
    const catchIdx = processAdBody.indexOf('} catch (err) {');
    assert.ok(catchIdx >= 0);
    const catchBody = balanced(processAdBody, processAdBody.indexOf('{', catchIdx), '{', '}');
    assert.match(catchBody, /notifyRenderFailure\(ad,\s*err\)/);
  });

  await check('E2 maybeFinalizeRun calls notifyRunFinalized(runId, outcome) ONLY inside the successful-CAS branch', () => {
    const body = functionBody(SRC, /async function maybeFinalizeRun\(runId\)\s*\{/);
    const ifMatch = /if\s*\(res\s*&&\s*\(res\.modifiedCount\s*\|\|\s*res\.nModified\)\)\s*\{/.exec(body);
    assert.ok(ifMatch, 'expected the CAS-success if-block guarding the finalize log line');
    const ifBody = balanced(body, body.indexOf('{', ifMatch.index + ifMatch[0].length - 1), '{', '}');
    assert.match(ifBody, /notifyRunFinalized\(runId,\s*outcome\)/);
    // And NOT called outside that guard (i.e. not once per maybeFinalizeRun
    // invocation regardless of whether the CAS actually won).
    const outsideIfBlock = body.replace(ifBody, '');
    assert.doesNotMatch(outsideIfBlock, /notifyRunFinalized\(/);
  });

  await check('E3 renderVideo\'s not-ready-yet derive branch calls notifyDeriveWaitBackup BEFORE requeuing', () => {
    const body = functionBody(SRC, /async function renderVideo\(ad\)\s*\{/);
    const branchMatch = /if\s*\(\s*!master\?\.veoVideoUrl\s*\)\s*\{/.exec(body);
    assert.ok(branchMatch, 'expected the not-ready-yet branch');
    const branch = balanced(body, body.indexOf('{', branchMatch.index + branchMatch[0].length - 1), '{', '}');
    const notifyIdx  = branch.indexOf('notifyDeriveWaitBackup(');
    const requeueIdx = branch.indexOf('requeueDeriveForRetry(');
    assert.ok(notifyIdx >= 0, 'notifyDeriveWaitBackup must be called in this branch');
    assert.ok(requeueIdx >= 0, 'requeueDeriveForRetry must still be called in this branch');
    assert.ok(notifyIdx < requeueIdx, 'the alert call must not sit between requeueDeriveForRetry and return — verifyRendererVideoMoneyInvariants.js A5 pins that no statement of any kind does');
  });

  await check('E4 run() fires alertOrphanedClaimsOnBoot() at boot, before entering the poll loop', () => {
    const body = functionBody(SRC, /async function run\(\)\s*\{/);
    const alertIdx = body.indexOf('alertOrphanedClaimsOnBoot();');
    const pollIdx  = body.indexOf('poll();');
    assert.ok(alertIdx >= 0, 'run() must call alertOrphanedClaimsOnBoot()');
    assert.ok(pollIdx >= 0);
    assert.ok(alertIdx < pollIdx, 'boot-time detection should fire before the claim loop starts, not after');
  });

  await check('E4b run() also schedules a delayed second scan after HEARTBEAT_STALE_MIN + one clamped beat, unref\'d', () => {
    const body = functionBody(SRC, /async function run\(\)\s*\{/);
    // Immediate boot is not enough: a SIGKILL'd predecessor's last beat is
    // ≤90s old, so the updatedAt conjunct would miss the exact OOM-restart
    // this pager exists for. The delay must be the silence window plus one
    // clamped beat — not a magic number, and not the 20-minute claim bound.
    assert.match(body, /setTimeout\s*\(\s*\(\s*\)\s*=>\s*\{\s*alertOrphanedClaimsOnBoot\(\s*\)/);
    assert.match(body, /HEARTBEAT_STALE_MIN\s*\*\s*60\s*\*\s*1000\s*\+\s*AD_HEARTBEAT_SAFE_MAX_MS/);
    const timeoutIdx = body.search(/setTimeout\s*\(\s*\(\s*\)\s*=>\s*\{\s*alertOrphanedClaimsOnBoot\(\s*\)/);
    assert.ok(timeoutIdx >= 0);
    const afterTimeout = body.slice(timeoutIdx);
    assert.match(afterTimeout, /\.unref\s*\(\s*\)/, 'the rescan timer must be unref\'d so it cannot hold the process open');
  });

  await check('E5 alertOrphanedClaimsOnBoot never mutates the Ad it inspects (visibility only — no writes)', () => {
    const body = functionBody(SRC, /async function alertOrphanedClaimsOnBoot\(\)\s*\{/);
    assert.doesNotMatch(body, /Ad\.(updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany)\(/,
      'this function is documented as READ-ONLY; a write here would be an undocumented remediation decision, not an alerting fix');
  });

  await check('E6 this harness never requires alertService or renderer.js — in-memory notifyAsync stub only, no live Slack', () => {
    const harnessSrc = fs.readFileSync(__filename, 'utf8');
    assert.doesNotMatch(harnessSrc, /require\([^)]*alertService/);
    assert.doesNotMatch(harnessSrc, /require\([^)]*services\/renderer/);
    assert.match(harnessSrc, /notifyAsync\(opts\)\s*\{\s*calls\.push\(opts\)/);
    // Live intercept, not a comment: isolatedRequire must return the
    // in-memory stub for ./alertService. Matching the identifier anywhere
    // in this file is not enough — a commented-out intercept plus the
    // same text in a comment would keep a naive scan green while
    // origRequire loaded the real Slack module.
    const iso = functionBody(harnessSrc, /mod\.require = function isolatedRequire\(request\)\s*\{/);
    const live = iso.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.match(live, /if \(id === ['"]\.\/alertService['"]\) return alerts;/);
    assert.doesNotMatch(live, /origRequire\([^)]*alertService/);
    // Leaf modules loaded for real must themselves stay leaves — their
    // requires go through Module.prototype.require, not isolatedRequire.
    for (const rel of REAL_RELATIVE) {
      const leafSrc = fs.readFileSync(path.join(path.dirname(RENDERER_PATH), `${rel}.js`), 'utf8');
      assert.doesNotMatch(leafSrc, /require\([^)]*alertService/);
      assert.doesNotMatch(leafSrc, /require\(['"]\.\.\/config['"]\)/);
    }
  });

  // ── report ───────────────────────────────────────────────────────────────
  const total = checks + failures.length;
  if (failures.length) {
    console.log(`\n❌ verifyRendererSlackAlerts: ${failures.length} of ${total} checks FAILED\n`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyRendererSlackAlerts: ${total}/${total} checks passed`);
}

main().catch((err) => {
  console.error(`verifyRendererSlackAlerts: harness crashed — ${err.stack || err.message}`);
  process.exit(1);
});

/*
 * REVERT-PROOF LEDGER — mutations performed against the real
 * src/services/renderer.js and confirmed to turn this harness red (see the
 * session report for the actual before/after runs):
 *   1. Remove `notifyRenderFailure(ad, err);` from processAd's catch
 *        → E1 fails.
 *   2. Remove `notifyRunFinalized(runId, outcome);` from maybeFinalizeRun
 *        → E2 fails.
 *   3. Remove `notifyDeriveWaitBackup(...)` from renderVideo's derive branch
 *        → E3 fails.
 *   4. Remove `alertOrphanedClaimsOnBoot();` from run()
 *        → E4 fails.
 *   4b. Remove the delayed setTimeout rescan (keep the immediate call)
 *        → E4b fails. The immediate-only shape misses a SIGKILL restart
 *          whose last beat is still inside HEARTBEAT_STALE_MIN.
 *   5. Swap the unsettledAtTimeout branch's level from 'warn' to 'error'
 *        → A1 fails (asserts 'warn' exactly).
 *   6. Drop the `if (!outcome || !outcome.failed) return;` guard in
 *      notifyRunFinalized
 *        → C1 fails (alerts on a run with zero failures).
 *   7. Hardcode notifyRenderFailure's static branch to 'error' instead of
 *      `err.alertLevel || 'error'`
 *        → A4 fails (a 'fatal'-tagged credentials error reports 'error').
 *   8. Change alertOrphanedClaimsOnBoot's paid-master bucket to 'warn'
 *        → D3 fails (asserts 'error' exactly, with the reason stated inline).
 *   9. Drop updatedAt from the orphan query (claimedAt-only, the pre-fix
 *      shape that false-paged live titling jobs)
 *        → D2 fails (updatedAt missing from the filter keys) AND D7 fails
 *          (a 40m-old claim with a 10s-old heartbeat matches).
 */
