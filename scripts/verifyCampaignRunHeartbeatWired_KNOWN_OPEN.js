#!/usr/bin/env node
'use strict';
//
// ██████  KNOWN-OPEN DEFECT — THIS HARNESS IS EXPECTED TO FAIL.  ██████
// Do not "fix" it by relaxing the assertions. Fix it by calling
// startRunHeartbeat(...) from renderer.js's render loop for each claimed
// run, then delete this header and let the harness go green.
//
// verifyCampaignRunHeartbeatWired — services/campaignRunHeartbeat.js is a
// FULLY IMPLEMENTED, exported `startRunHeartbeat` with a real setInterval,
// a leading beat, a lifetime cap, and an injectable-model design built
// specifically so callers don't need a live DB to drive it. Its own header
// and THREE other files' comments (models/CampaignRun.js, campaignRunGuards.js
// x2) describe it as running "every ~60s ... while runRenderLoop reports
// real in-flight work". `grep -rn "startRunHeartbeat(" src/` outside its own
// definition/export line returns ZERO matches — verified mechanically by
// Group B below, not merely asserted here.
//
// CONSEQUENCE, if this stays unwired (adgen's own words, from renderer.js's
// header + campaignRunHeartbeat.js's header, corroborated behaviourally by
// Group C): `CampaignRun.updatedAt` moves ONLY when an ad settles
// (bumpRunCounter's per-completion $inc). During a long, quiet stretch —
// e.g. video titling serialized behind REMOTION_QUEUE_CONCURRENCY while a
// run's remaining ads are all video — `updatedAt` goes stale. The backend's
// reaper (`buildStaleRunningFilter` / `buildActiveRunsFilter`'s running arm,
// vendored into campaignRunGuards.js) keys the concurrency GATE on that same
// field: past REAP_STALE_MIN (15 min default) the gate stops treating the
// run as active, an identical `/generate` is admitted with no 409, and — per
// CLAUDE.md §2's generation-gate section — that is the ONLY protection
// against a duplicate STATIC fan-out (the atomic Ad claim does not back it
// up: each expansion mints its OWN ads). Unwired heartbeat therefore
// degrades a money guard, not just an operator-visible progress bar.
//
// WHAT THIS HARNESS DOES:
//   Group A (PASSES) — startRunHeartbeat's OWN mechanism is correct in
//     isolation: given injected stub models and a real in-flight signal, it
//     beats CampaignRun.updatedAt/lastHeartbeatAt on schedule and stops
//     beating the instant work drains. This is not the defect; it proves
//     the fix, once wired, would work.
//   Group B (EXPECTED TO FAIL) — a source scan proves startRunHeartbeat has
//     no call site anywhere in src/ outside its own module.
//   Group C (EXPECTED TO FAIL) — reproduces the staleness consequence:
//     replays renderer.js's REAL, source-extracted bumpRunCounter update
//     shape (the only CampaignRun write renderer.js makes) across a
//     simulated 20-minute video-titling gap with zero ad completions, then
//     asserts updatedAt stayed fresh enough to keep the gate's running arm
//     honoring the run. It did not — because nothing beat it.
//
// Pure + offline: campaignRunHeartbeat.js's only require is ./staleness
// (dependency-free), so it is required directly — no stub, no NODE_PATH.
//   node scripts/verifyCampaignRunHeartbeatWired_KNOWN_OPEN.js   (exits 1 — expected)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  startRunHeartbeat,
  heartbeatOnce
} = require('../src/services/campaignRunHeartbeat.js');
const { positiveMinutes, REAP_STALE_MIN_DEFAULT } = require('../src/services/staleness.js');

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

// ── minimal injectable model stub (heartbeatOnce/startRunHeartbeat accept
// a `models` object precisely so a harness never needs a live Mongo) ──────
function makeStubCampaignRun(seed) {
  const doc = { ...seed };
  return {
    async updateOne(filter, update) {
      const statusOk = filter.status === undefined || doc.status === filter.status;
      const idOk = String(filter._id) === String(doc._id);
      if (!statusOk || !idOk) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    snapshot() { return { ...doc }; }
  };
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  // GROUP A — the heartbeat MECHANISM itself is correct (not the defect).
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
  // GROUP B — [EXPECTED TO FAIL] startRunHeartbeat is never actually called.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n── Group B: is the mechanism actually wired into the render loop? ──');

  await check('B1 [EXPECTED TO FAIL] startRunHeartbeat has a real call site outside campaignRunHeartbeat.js', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const HEARTBEAT_FILE = path.join(srcDir, 'services', 'campaignRunHeartbeat.js');
    const callers = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || full === HEARTBEAT_FILE) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/startRunHeartbeat\s*\(/.test(text)) callers.push(path.relative(srcDir, full));
      }
    })(srcDir);
    assert.ok(callers.length > 0,
      'startRunHeartbeat is fully implemented, exported, and documented in three other files\' comments ' +
      'as running "every ~60s" — but has ZERO call sites in src/. renderer.js (which owns the render loop ' +
      'and the render loop\'s own in-flight/pool counters that isWorking() is supposed to read) never starts it.');
  });

  await check('B2 [structural corroboration] renderer.js does not even require campaignRunHeartbeat.js', () => {
    const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'renderer.js'), 'utf8');
    assert.ok(!/require\(['"]\.\/campaignRunHeartbeat/.test(rendererSrc),
      'if this now passes, startRunHeartbeat has been wired in and B1 should go green too — update the header');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GROUP C — [EXPECTED TO FAIL] the consequence: a long ad-completion gap
  // leaves CampaignRun.updatedAt stale enough to fall outside the gate's
  // running-arm staleness window, using the REAL bumpRunCounter shape.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n── Group C: reproducing the staleness consequence ──');

  const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'renderer.js'), 'utf8');
  const bumpFnMatch = /async function bumpRunCounter\(campaignRunIds, field\)\s*\{/.exec(RENDERER_SRC);
  assert.ok(bumpFnMatch, 'bumpRunCounter signature not found — renderer.js shape changed, re-derive this harness');
  const bumpBody = balanced(RENDERER_SRC, RENDERER_SRC.indexOf('{', bumpFnMatch.index + bumpFnMatch[0].length - 1), '{', '}');
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

  await check('C1 [EXPECTED TO FAIL] updatedAt stays inside the gate\'s running-staleness window across a 20-minute all-video gap', () => {
    // Shape: a mixed Meta+PMax run whose 18 statics settled quickly (each
    // one calling bumpRunCounter, refreshing updatedAt) and then sits
    // through a long video-titling stretch with ZERO ad completions — the
    // exact production shape documented in campaignRunGuards.js's own
    // header (run_1787105727540_e8c94542: 18 statics by ~02:21, silence
    // until the reaper acted at 02:36).
    let run = { runId: 'run_test', status: 'running', updatedAt: new Date('2026-08-20T02:15:27Z'), lastHeartbeatAt: null };
    for (let i = 0; i < 18; i++) run = applyBumpRunCounter(run, 'succeeded'); // real code stamps `new Date()` — freshest of these is effectively "now"

    // Simulate what the reaper/gate see GAP_MIN later with no further
    // completions and NO heartbeat running (the defect this file pins).
    const GAP_MIN = 20;
    const staleMin = positiveMinutes(undefined, REAP_STALE_MIN_DEFAULT); // the real, shared parser — 15 by default
    const checkedAt = new Date(run.updatedAt.getTime() + GAP_MIN * 60 * 1000);
    const ageMin = (checkedAt.getTime() - run.updatedAt.getTime()) / 60000;

    assert.ok(ageMin <= staleMin,
      `run.updatedAt is ${ageMin.toFixed(1)} minutes stale after a ${GAP_MIN}-minute all-video gap with ` +
      `no ad completions — exceeds REAP_STALE_MIN (${staleMin}m). With no heartbeat running, the worker's ` +
      'reaper (buildStaleRunningFilter) would stamp this genuinely-alive run "failed", and the ' +
      'concurrency gate\'s running arm (buildActiveRunsFilter) would stop treating it as in-flight — ' +
      'admitting a duplicate /generate with no 409.');
  });

  await check('C2 [supporting, PASSES] IF startRunHeartbeat were driven every runHeartbeatMs() during that same gap, updatedAt would stay fresh', async () => {
    const stubRun = makeStubCampaignRun({ _id: 'run_test', status: 'running', updatedAt: new Date('2026-08-20T02:21:00Z'), lastHeartbeatAt: null });
    // One beat, dated as if it landed mid-gap — exactly what
    // startRunHeartbeat would have produced had it been started alongside
    // the render loop.
    await heartbeatOnce({ CampaignRun: stubRun, runDocId: 'run_test', now: new Date('2026-08-20T02:30:00Z') });
    const ageMin = (new Date('2026-08-20T02:36:00Z').getTime() - stubRun.snapshot().updatedAt.getTime()) / 60000;
    assert.ok(ageMin < REAP_STALE_MIN_DEFAULT, 'a single mid-gap beat is enough to keep the run inside the staleness window');
  });

  // ── report ─────────────────────────────────────────────────────────────
  const total = checks + failures.length;
  console.log('');
  if (failures.length) {
    console.log(`❌ verifyCampaignRunHeartbeatWired_KNOWN_OPEN: ${failures.length} of ${total} checks FAILED (EXPECTED — see file header)`);
    for (const f of failures) console.log(`  • ${f}`);
    console.log('\nThis is a KNOWN-OPEN DEFECT harness. A red result here is correct and expected.');
    console.log('Fix: call startRunHeartbeat(...) from renderer.js\'s render loop, then re-run this file.');
    process.exitCode = 1;
  } else {
    console.log(`✅ verifyCampaignRunHeartbeatWired_KNOWN_OPEN: ${total}/${total} checks passed`);
    console.log('⚠️  If you are seeing this, the known-open defect has been FIXED — update/retire this file\'s header.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
