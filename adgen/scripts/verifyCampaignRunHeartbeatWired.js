#!/usr/bin/env node
'use strict';
//
// verifyCampaignRunHeartbeatWired — services/campaignRunHeartbeat.js is a
// FULLY IMPLEMENTED, exported `startRunHeartbeat` with a real setInterval,
// a leading beat, a lifetime cap, and an injectable-model design built
// specifically so callers don't need a live DB to drive it. Its own header
// and THREE other files' comments (models/CampaignRun.js, campaignRunGuards.js
// x2) describe it as running "every ~60s ... while runRenderLoop reports
// real in-flight work".
//
// HISTORY. This file was born as verifyCampaignRunHeartbeatWired_KNOWN_OPEN.js
// because `grep -rn "startRunHeartbeat(" src/` outside the module's own
// definition/export returned ZERO matches. The module was vendored, documented,
// and inert. CONSEQUENCE (adgen's own words, from renderer.js's header +
// campaignRunHeartbeat.js's header): `CampaignRun.updatedAt` moved ONLY when
// an ad settled (bumpRunCounter's per-completion $inc). During a long, quiet
// stretch — e.g. video titling serialized behind REMOTION_QUEUE_CONCURRENCY
// while a run's remaining ads are all video — `updatedAt` went stale. The
// backend's reaper (`buildStaleRunningFilter` / `buildActiveRunsFilter`'s
// running arm, vendored into campaignRunGuards.js) keys the concurrency GATE
// on that same field: past REAP_STALE_MIN (15 min default) the gate stops
// treating the run as active, an identical `/generate` is admitted with no
// 409, and — per CLAUDE.md §2's generation-gate section — that is the ONLY
// protection against a duplicate STATIC fan-out (the atomic Ad claim does
// not back it up: each expansion mints its OWN ads). Unwired heartbeat
// therefore degrades a money guard, not just an operator-visible progress
// bar.
//
// THE DEFECT IS CLOSED. renderer.js requires the module and
// acquireRunHeartbeat starts the ticker per claimed run, gated on a per-run
// inflight map. The assertions below pin the CLOSED state — they must go
// red if the wiring is removed. Do not "fix" a red by relaxing them.
//
// WHAT THIS HARNESS DOES:
//   Group A — startRunHeartbeat's OWN mechanism is correct in isolation:
//     given injected stub models and a real in-flight signal, it beats
//     CampaignRun.updatedAt/lastHeartbeatAt on schedule and stops beating
//     the instant work drains.
//   Group B — import-plus-call-site. B1: startRunHeartbeat has a real call
//     site in src/ outside its own module. B2: renderer.js REQUIRES
//     campaignRunHeartbeat.js (a call without the import is a ReferenceError;
//     a vendored module nobody requires is the original incident). A harness
//     that asserts a call site must also assert the file imports the helper.
//   Group C — the behavioural pin this file exists for. C1 executes
//     renderer.js's acquireRunHeartbeat (the production wrap) against stub
//     models, then drives the real heartbeat write across a simulated
//     20-minute all-video gap with zero further bumpRunCounter settlements,
//     and asserts updatedAt stayed inside the gate's running-staleness
//     window. Remove the startRunHeartbeat call from acquireRunHeartbeat
//     and C1 goes red — not because a regex missed a token, but because
//     nothing beat the run. C2 remains the single-beat arithmetic check.
//
// Pure + offline: campaignRunHeartbeat.js's only require is ./staleness
// (dependency-free), so it is required directly — no stub, no NODE_PATH.
//   node scripts/verifyCampaignRunHeartbeatWired.js
//
// REVERT-PROVE:
//   remove the require('./campaignRunHeartbeat') from renderer.js → B2 red
//   require the module but do not bind startRunHeartbeat          → B2 red
//   remove the startRunHeartbeat(...) call from acquireRunHeartbeat   → C1 red
//   restore both → all green

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  startRunHeartbeat,
  heartbeatOnce,
  runHeartbeatMs
} = require('../src/services/campaignRunHeartbeat.js');
const { positiveMinutes, REAP_STALE_MIN_DEFAULT } = require('../src/services/staleness.js');

const ROOT = path.resolve(__dirname, '..');
const RENDERER_PATH = path.join(ROOT, 'src', 'services', 'renderer.js');
const HEARTBEAT_PATH = path.join(ROOT, 'src', 'services', 'campaignRunHeartbeat.js');

let checks = 0;
const failures = [];
// ASYNC-AWARE check: every call site below is `await check(...)`, so a
// check whose fn() returns a Promise is genuinely awaited before pass/fail
// is decided — a plain synchronous try/catch here would silently mark a
// later-rejecting async check as a pass.
async function check(label, fn) {
  try { await fn(); checks += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); }
}

function balanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return null;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Comments in renderer.js quote almost every identifier this file cares
// about (including the require path). A scan that does not strip them
// cannot go red if the require is deleted and a comment leftover remains.
function stripComments(src) {
  let out = ''; let i = 0;
  let inS = null, inBlock = false, inLine = false, inRe = false;
  let prevSig = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (inLine)       { if (c === '\n') { inLine = false; out += c; } i++; continue; }
    if (inBlock)      { if (c === '*' && d === '/') { inBlock = false; i += 2; } else i++; continue; }
    if (inS)          { out += c; if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
                        if (c === inS) inS = null; i++; continue; }
    if (inRe)         { out += c; if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
                        if (c === '/') inRe = false; i++; continue; }
    if (c === '/' && d === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && d === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; out += c; i++; continue; }
    if (c === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(prevSig)) { inRe = true; out += c; i++; continue; }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}

function extractNamedFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  const bodyStart = src.indexOf('{', m.index);
  if (bodyStart < 0) return null;
  const body = balanced(src, bodyStart, '{', '}');
  if (!body) return null;
  return src.slice(m.index, bodyStart) + body;
}

// ── minimal injectable model stub (heartbeatOnce/startRunHeartbeat accept
// a `models` object precisely so a harness never needs a live Mongo) ──────
function makeStubCampaignRun(seed) {
  const doc = { ...seed };
  return {
    findOne(filter) {
      const runIdOk = filter.runId === undefined || filter.runId === doc.runId;
      const idOk = filter._id === undefined || String(filter._id) === String(doc._id);
      const row = (runIdOk && idOk) ? { _id: doc._id, runId: doc.runId } : null;
      const query = {
        select() { return query; },
        lean() { return Promise.resolve(row); }
      };
      return query;
    },
    async updateOne(filter, update) {
      const statusOk = filter.status === undefined || doc.status === filter.status;
      const idOk = String(filter._id) === String(doc._id);
      if (!statusOk || !idOk) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    snapshot() { return { ...doc }; }
  };
}

function makeStubAd(ads) {
  return {
    find() {
      const query = {
        select() { return query; },
        lean() { return Promise.resolve(ads); }
      };
      return query;
    },
    async updateMany() { return { matchedCount: ads.length, modifiedCount: ads.length }; }
  };
}

async function main() {
  const RAW_RENDERER = fs.readFileSync(RENDERER_PATH, 'utf8');
  const RENDERER_SRC = stripComments(RAW_RENDERER);

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP A — the heartbeat MECHANISM itself is correct.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('── Group A: the heartbeat mechanism works when driven directly ──');

  await check('A1 heartbeatOnce writes updatedAt+lastHeartbeatAt to a running CampaignRun via the injected model', async () => {
    const stubRun = makeStubCampaignRun({ _id: 'run1', status: 'running', updatedAt: new Date(0), lastHeartbeatAt: null });
    const now = new Date('2026-08-24T00:00:00Z');
    await heartbeatOnce({ CampaignRun: stubRun, runDocId: 'run1', now });
    const after = stubRun.snapshot();
    assert.deepStrictEqual(after.updatedAt, now);
    assert.deepStrictEqual(after.lastHeartbeatAt, now);
  });

  await check('A2 heartbeatOnce refuses to beat a run that is no longer "running" (does not resurrect a reaped run)', async () => {
    const stubRun = makeStubCampaignRun({ _id: 'run1', status: 'failed', updatedAt: new Date(0), lastHeartbeatAt: null });
    await heartbeatOnce({ CampaignRun: stubRun, runDocId: 'run1', now: new Date() });
    assert.strictEqual(stubRun.snapshot().status, 'failed');
    assert.deepStrictEqual(stubRun.snapshot().updatedAt, new Date(0), 'a failed run must not have its updatedAt refreshed post-mortem');
  });

  await check('A3 startRunHeartbeat beats on a timer while isWorking() is true, and STOPS beating once work drains', async () => {
    const stubRun = makeStubCampaignRun({ _id: 'run1', status: 'running', updatedAt: new Date(0), lastHeartbeatAt: null });
    let working = true;
    const handle = startRunHeartbeat({
      runDocId: 'run1',
      isWorking: () => working,
      models: { CampaignRun: stubRun, Ad: {} },
      intervalMs: 20 // fast, test-only override — the real value comes from runHeartbeatMs()
    });
    try {
      await sleep(70); // leading beat + at least one interval tick
      assert.ok(handle.beats >= 1, 'expected at least the leading beat to have fired');
      working = false; // work drains
      await sleep(30);
      const beatsAtDrain = handle.beats;
      await sleep(70);
      assert.strictEqual(handle.beats, beatsAtDrain,
        'must NOT keep beating once isWorking() reports false — an unconditional beat would defeat the reaper');
    } finally {
      handle.stop();
    }
  });

  await check('A4 startRunHeartbeat is capped by maxMs — a run whose inflight count never drops stops beating anyway', async () => {
    const stubRun = makeStubCampaignRun({ _id: 'run1', status: 'running', updatedAt: new Date(0), lastHeartbeatAt: null });
    const handle = startRunHeartbeat({
      runDocId: 'run1',
      isWorking: () => true, // a "wedged" render that never reports drained
      models: { CampaignRun: stubRun, Ad: {} },
      intervalMs: 10,
      maxMs: 30
    });
    try {
      await sleep(90);
      assert.strictEqual(handle.expired, true, 'a heartbeat with a never-draining isWorking() must still expire at maxMs');
      assert.strictEqual(handle.stopped, true);
    } finally {
      handle.stop(); // idempotent — must not throw
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP B — import-plus-call-site. A call without the import is a
  // ReferenceError; an import without a call is the original incident.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n── Group B: is the mechanism actually wired into the render loop? ──');

  await check('B1 startRunHeartbeat has a real call site outside campaignRunHeartbeat.js', () => {
    const srcDir = path.join(ROOT, 'src');
    const callers = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || full === HEARTBEAT_PATH) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/startRunHeartbeat\s*\(/.test(text)) callers.push(path.relative(srcDir, full));
      }
    })(srcDir);
    assert.ok(callers.length > 0,
      'startRunHeartbeat is fully implemented and exported but has ZERO call sites in src/. ' +
      'renderer.js (which owns the render loop and the per-run inflight map that isWorking() ' +
      'is supposed to read) must start it.');
    assert.ok(callers.some((c) => c.replace(/\\/g, '/') === 'services/renderer.js'),
      `expected renderer.js among callers, got: ${callers.join(', ')}`);
  });

  await check('B2 renderer.js requires campaignRunHeartbeat.js and binds startRunHeartbeat (import-plus-call-site)', () => {
    assert.ok(RAW_RENDERER.length > RENDERER_SRC.length + 500,
      'stripComments removed almost nothing — B2 would be scanning comments that quote the module path');
    const requireRe = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]\.\/campaignRunHeartbeat['"]\s*\)/;
    const m = requireRe.exec(RENDERER_SRC);
    assert.ok(m,
      'renderer.js must require("./campaignRunHeartbeat") — a call site without the import is a ' +
      'ReferenceError, and a vendored module nobody requires is the original production incident. ' +
      'This check must go red if the require is removed.');
    // C1 injects startRunHeartbeat into a factory, so it cannot see a missing
    // binding. Bare `require('./campaignRunHeartbeat')` or
    // `const { heartbeatOnce } = require(...)` would still match a path-only
    // scan, then throw ReferenceError inside acquireRunHeartbeat's try/catch
    // (ticker never starts). The destructure must name startRunHeartbeat.
    assert.match(m[1], /\bstartRunHeartbeat\b/,
      'the require must bind startRunHeartbeat — an unused or differently-named import is the same bug with extra steps');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP C — the behavioural pin: a 20-minute all-video gap with zero ad
  // completions must NOT drop CampaignRun.updatedAt outside the gate's
  // running-arm staleness window, because acquireRunHeartbeat now starts
  // the real ticker.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n── Group C: a 20-minute all-video gap must not go stale ──');

  const bumpFnMatch = /async function bumpRunCounter\(campaignRunIds, field\)\s*\{/.exec(RAW_RENDERER);
  assert.ok(bumpFnMatch, 'bumpRunCounter signature not found — renderer.js shape changed, re-derive this harness');
  const bumpBody = balanced(RAW_RENDERER, RAW_RENDERER.indexOf('{', bumpFnMatch.index + bumpFnMatch[0].length - 1), '{', '}');
  const updateCallIdx = bumpBody.indexOf('CampaignRun.updateOne(');
  const updateCallWhole = balanced(bumpBody, updateCallIdx + 'CampaignRun.updateOne('.length - 1, '(', ')');
  const bumpUpdateText = updateCallWhole.slice(1, -1).slice(updateCallWhole.slice(1, -1).indexOf('{ $inc'));

  function applyBumpRunCounter(run, field) {
    // eslint-disable-next-line no-new-func
    const update = new Function('field', `return (${bumpUpdateText});`)(field);
    const out = { ...run };
    for (const [k, v] of Object.entries(update.$inc || {})) out[k] = (out[k] || 0) + v;
    Object.assign(out, update.$set || {});
    return out;
  }

  await check('C1 updatedAt stays inside the gate\'s running-staleness window across a 20-minute all-video gap', async () => {
    // Shape: a mixed Meta+PMax run whose 18 statics settled quickly (each
    // one calling bumpRunCounter, refreshing updatedAt) and then sits
    // through a long video-titling stretch with ZERO ad completions — the
    // exact production shape documented in campaignRunGuards.js's own
    // header (run_1787105727540_e8c94542: 18 statics by ~02:21, silence
    // until the reaper acted at 02:36).
    //
    // THIS IS NOT A SOURCE SCAN. We extract acquireRunHeartbeat from
    // renderer.js and RUN it against stub models. If the startRunHeartbeat
    // call is removed, the wrap never starts a ticker, the 20-minute gap
    // is driven by bumpRunCounter alone, and updatedAt falls outside the
    // window. Wall-clock 20 minutes is not viable in a harness: the gap
    // is simulated by applying the same write the ticker emits
    // (heartbeatOnce) at runHeartbeatMs() using the runDocId the
    // production call passed.

    const acquireSrc = extractNamedFunction(RENDERER_SRC, 'acquireRunHeartbeat');
    const workingSrc = extractNamedFunction(RENDERER_SRC, 'runIsWorking');
    assert.ok(acquireSrc, 'acquireRunHeartbeat not found in renderer.js — that is the wrap that starts the ticker');
    assert.ok(workingSrc, 'runIsWorking not found in renderer.js — that is the per-run inflight gate');

    let run = {
      _id: 'runDoc1',
      runId: 'run_test',
      status: 'running',
      updatedAt: new Date('2026-08-20T02:15:27Z'),
      lastHeartbeatAt: null,
      succeeded: 0
    };
    for (let i = 0; i < 18; i++) run = applyBumpRunCounter(run, 'succeeded'); // real code stamps `new Date()` — freshest of these is effectively "now"
    const t0 = run.updatedAt.getTime();

    const stubRun = makeStubCampaignRun(run);
    const stubAd = makeStubAd([{ _id: 'ad-claimed-1' }]);
    let captured = null;
    const wrappedStart = (opts) => {
      captured = opts;
      // Invoke the REAL ticker (so a broken export / throw surfaces here),
      // then stop it: the 20-minute gap is timestamp-simulated below.
      const handle = startRunHeartbeat({
        ...opts,
        models: { CampaignRun: stubRun, Ad: stubAd }
      });
      handle.stop();
      return handle;
    };

    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'CampaignRun', 'Ad', 'startRunHeartbeat', 'WORKER_ID', 'console',
      `const runInflight = new Map();
       const runHeartbeats = new Map();
       const runDocIdCache = new Map();
       ${workingSrc}
       ${acquireSrc}
       return acquireRunHeartbeat;`
    );
    const acquireRunHeartbeat = factory(stubRun, stubAd, wrappedStart, 'verify-worker', console);
    await acquireRunHeartbeat('run_test');

    const GAP_MIN = 20;
    const staleMin = positiveMinutes(undefined, REAP_STALE_MIN_DEFAULT); // the real, shared parser — 15 by default
    const intervalMs = runHeartbeatMs();
    const checkedAt = new Date(t0 + GAP_MIN * 60 * 1000);

    if (captured) {
      // Drive the real beat write at the real cadence across the gap,
      // targeting the runDocId the production call handed the ticker.
      for (let t = t0; t <= checkedAt.getTime(); t += intervalMs) {
        await heartbeatOnce({
          CampaignRun: stubRun,
          runDocId: captured.runDocId,
          adIds: captured.adIds || [],
          now: new Date(t)
        });
      }
    }

    const ageMin = (checkedAt.getTime() - stubRun.snapshot().updatedAt.getTime()) / 60000;
    assert.ok(ageMin <= staleMin,
      `run.updatedAt is ${ageMin.toFixed(1)} minutes stale after a ${GAP_MIN}-minute all-video gap with ` +
      `no ad completions — exceeds REAP_STALE_MIN (${staleMin}m). ` +
      (captured
        ? 'startRunHeartbeat was invoked but the beat did not keep updatedAt inside the window.'
        : 'acquireRunHeartbeat never called startRunHeartbeat — the wiring is gone, so nothing beat the run. ' +
          'The worker\'s reaper (buildStaleRunningFilter) would stamp this genuinely-alive run "failed", and the ' +
          'concurrency gate\'s running arm (buildActiveRunsFilter) would stop treating it as in-flight — ' +
          'admitting a duplicate /generate with no 409.'));
  });

  await check('C2 a single mid-gap beat is enough to keep updatedAt inside the staleness window', async () => {
    const stubRun = makeStubCampaignRun({ _id: 'run_test', status: 'running', updatedAt: new Date('2026-08-20T02:21:00Z'), lastHeartbeatAt: null });
    await heartbeatOnce({ CampaignRun: stubRun, runDocId: 'run_test', now: new Date('2026-08-20T02:30:00Z') });
    const ageMin = (new Date('2026-08-20T02:36:00Z').getTime() - stubRun.snapshot().updatedAt.getTime()) / 60000;
    assert.ok(ageMin < REAP_STALE_MIN_DEFAULT, 'a single mid-gap beat is enough to keep the run inside the staleness window');
  });

  // ── report ─────────────────────────────────────────────────────────────
  const total = checks + failures.length;
  console.log('');
  if (failures.length) {
    console.log(`❌ verifyCampaignRunHeartbeatWired: ${failures.length} of ${total} checks FAILED`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ verifyCampaignRunHeartbeatWired: ${total}/${total} checks passed`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
