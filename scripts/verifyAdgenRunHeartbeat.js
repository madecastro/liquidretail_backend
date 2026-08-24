#!/usr/bin/env node
'use strict';
//
// verifyAdgenRunHeartbeat — pins the wiring of the vendored
// services/campaignRunHeartbeat.js into adgen's render loop.
//
// THE DEFECT. startRunHeartbeat is fully implemented, exported, and
// documented as running every ~60s while the loop has real in-flight work.
// grep -rn "startRunHeartbeat" src/ returned nothing outside the module's
// own file; grep -rn "require.*campaignRunHeartbeat" src/ returned nothing
// at all. Backend wires it at routes/ads.js:152 (import) and :1866
// (startRunHeartbeat({...})). adgen did not. ADGEN_RENDERER_ENABLED=true,
// so adgen renders EVERY new ad, and no CampaignRun row was heartbeaten.
//
// MEASURED LIVE (run_1787575090320_db5a5d96): lastHeartbeatAt NULL,
// updatedAt frozen 6+ minutes while the master was generating and the
// per-ad beat moved every ~10s. The run row only moved when an AD SETTLED.
// Backend's reaper (buildStaleRunningFilter) is service-agnostic:
//   { status:'running', updatedAt: { $lt: now - REAP_STALE_MIN(15m) } }
// so any adgen run with >15 min between ad settlements is stamped
// status:'failed' WHILE STILL RENDERING. That is the exact incident
// campaignRunHeartbeat.js was written to fix
// (run_1787105727540_e8c94542) — and the module was inert in the repo
// that now does the work.
//
// WHAT THIS HARNESS PINS
//   1. renderer.js actually REQUIRES and CALLS startRunHeartbeat. This is
//      the check whose absence caused the bug — a vendored module with no
//      caller. Comments are stripped first; the module's own header quotes
//      the function name.
//   2. The real exported beat, driven against a fake Ad/CampaignRun,
//      writes ONLY { updatedAt, lastHeartbeatAt } on { _id, status:'running' }.
//   3. A constructed mutation that adds `total` to that write goes red.
//      Same for the outcome counters. A heartbeat that touched any of them
//      would corrupt the progress denominator / audit.
//   4. The in-flight gate: isWorking() false => no write. The call site
//      in renderer.js must read the per-run inflight map, not a constant
//      true (that defeats the reaper) and not the process-wide `inFlight`
//      (that keeps a finished run beating while a sibling's ads run).
//   5. The lifetime cap exists and is finite (and matches
//      progressService.MAX_RUN_MS). A renderOne that never settles would
//      otherwise report work forever.
//
// Also: stop() in both catch AND finally of processAd, plus unref() in
// the module. Idempotent.
//
// Pure + offline: campaignRunHeartbeat.js's only require is ./staleness
// (dependency-free). No DB, no network, no node_modules.
//   node scripts/verifyAdgenRunHeartbeat.js
//
// REVERT-PROVE (run against this file; the named check is the OBSERVED
// failure, not a prediction):
//   1. Delete the require AND/OR the startRunHeartbeat(...) call in
//      renderer.js                              → W1 / W2 red
//   2. Add `total: 0` to buildRunHeartbeatUpdate → B3 red (in-harness
//      constructed mutation also proves B3 is load-bearing)
//   3. Change isWorking to `() => true`          → G2 red
//   4. Gate on process-wide `inFlight > 0`       → G3 red
//   5. Drop RUN_HEARTBEAT_MAX_MS / set Infinity  → C1 red
//   6. Delete stop() from the catch arm          → S1 red
//   7. Delete stop() from the finally arm        → S2 red
//   8. Pass `adIds: []` at the call site         → W2 red
//   9. Drop the Ad.find({ campaignRunIds: runId }) claimed-set load
//                                                → G3 red

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  startRunHeartbeat,
  heartbeatOnce,
  buildRunHeartbeatFilter,
  buildRunHeartbeatUpdate,
  RUN_HEARTBEAT_MAX_MS
} = require('../src/services/campaignRunHeartbeat.js');

const ROOT = path.resolve(__dirname, '..');
const RENDERER_PATH = path.join(ROOT, 'src/services/renderer.js');
const HEARTBEAT_PATH = path.join(ROOT, 'src/services/campaignRunHeartbeat.js');
const RAW_RENDERER = fs.readFileSync(RENDERER_PATH, 'utf8');
const RAW_HEARTBEAT = fs.readFileSync(HEARTBEAT_PATH, 'utf8');

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

const SRC = stripComments(RAW_RENDERER);
const HB_SRC = stripComments(RAW_HEARTBEAT);

function balanced(text, openIdx, open, close) {
  if (openIdx < 0 || text[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}

function fnBody(src, name) {
  const m = new RegExp(`function ${name}\\s*\\(`).exec(src);
  if (!m) return null;
  return balanced(src, src.indexOf('{', src.indexOf(')', m.index)), '{', '}');
}

const FORBIDDEN_PATHS = ['total', 'succeeded', 'failed', 'skipped', 'mintedTotal', 'errors'];

function assertAllowedHeartbeatUpdate(update, label) {
  assert.ok(update && typeof update === 'object', `${label}: update missing`);
  assert.deepStrictEqual(Object.keys(update), ['$set'],
    `${label}: heartbeat update must be a bare $set — no $inc, no $push, no $unset`);
  const keys = Object.keys(update.$set).sort();
  assert.deepStrictEqual(keys, ['lastHeartbeatAt', 'updatedAt'],
    `${label}: heartbeat $set must be exactly { updatedAt, lastHeartbeatAt }, got ${JSON.stringify(keys)}`);
  for (const bad of FORBIDDEN_PATHS) {
    assert.ok(!(bad in update.$set), `${label}: heartbeat wrote forbidden path $set.${bad}`);
    assert.ok(!(update.$inc && bad in update.$inc), `${label}: heartbeat wrote forbidden path $inc.${bad}`);
  }
}

function assertAllowedHeartbeatFilter(filter, label) {
  assert.ok(filter && typeof filter === 'object', `${label}: filter missing`);
  assert.strictEqual(filter.status, 'running',
    `${label}: filter must carry status:'running' — without it a beat can resurrect a reaped run`);
  assert.ok(Object.prototype.hasOwnProperty.call(filter, '_id'),
    `${label}: filter must target _id (the CampaignRun document), not a free-form query`);
  assert.ok(!('total' in filter) && !('succeeded' in filter),
    `${label}: filter must not mention progress counters`);
}

let checks = 0;
const failures = [];
async function check(label, fn) {
  try { await fn(); checks += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function recordingModels() {
  const runWrites = [];
  const adWrites = [];
  return {
    runWrites,
    adWrites,
    models: {
      CampaignRun: {
        updateOne: async (filter, update) => {
          runWrites.push({ filter, update });
          return { matchedCount: 1, modifiedCount: 1 };
        }
      },
      Ad: {
        updateMany: async (filter, update) => {
          adWrites.push({ filter, update });
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
    }
  };
}

const RUN_ID_OBJ = '64b0000000000000000000aa';

async function main() {
  console.log('\n── W: the renderer actually REQUIRES and CALLS startRunHeartbeat ──');

  await check('W0 comment stripping actually removed the prose (a zero-strip scan proves nothing)', () => {
    assert.ok(RAW_RENDERER.length > SRC.length + 500,
      'stripComments removed almost nothing — the checks below would be scanning comments that quote the function name');
  });

  await check('W1 [THE REGRESSION THAT SHIPPED] renderer.js requires campaignRunHeartbeat', () => {
    assert.match(SRC,
      /require\(\s*['"]\.\/campaignRunHeartbeat['"]\s*\)/,
      'renderer.js must require("./campaignRunHeartbeat") — a call without an import is a ReferenceError, ' +
      'and a vendored module nobody requires is exactly the production incident');
    assert.match(SRC,
      /startRunHeartbeat/,
      'the require must bind startRunHeartbeat (an unused import is the same bug with extra steps)');
  });

  await check('W2 renderer.js CALLS startRunHeartbeat( — not just mentions it', () => {
    assert.match(SRC, /startRunHeartbeat\s*\(/,
      'startRunHeartbeat must be invoked. The module being required and never called is the defect this file exists to close.');
    const callIdx = SRC.search(/startRunHeartbeat\s*\(/);
    const call = balanced(SRC, SRC.indexOf('(', callIdx), '(', ')');
    assert.ok(call && call.length > 20, 'startRunHeartbeat(...) call is empty or unparseable');
    assert.match(call, /runDocId\s*:/, 'the call must pass runDocId — that is which CampaignRun row gets beaten');
    assert.match(call, /isWorking\s*:/, 'the call must pass isWorking — that is the reaper-safety gate');
    // Backend uses the `adIds,` shorthand (routes/ads.js:1868). Either
    // `adIds,` or `adIds:` is a pass; the empty-array literal is the hole.
    assert.ok(/\badIds\s*,/.test(call) || /\badIds\s*:/.test(call),
      'the call must pass adIds — without them the claimed-but-undispatched tail (bulk-claimed to rendering before adgen handoff) is still reaped out from under a live run');
    assert.ok(!/adIds\s*:\s*\[\s*\]/.test(call),
      'adIds: [] is the hole that strands the undispatched tail — pass the run\'s claimed set, as backend does');
  });

  await check('W3 startRunHeartbeat has a real call site in src/ outside its own module', () => {
    const srcDir = path.join(ROOT, 'src');
    const callers = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || full === HEARTBEAT_PATH) continue;
        const text = stripComments(fs.readFileSync(full, 'utf8'));
        if (/startRunHeartbeat\s*\(/.test(text)) callers.push(path.relative(srcDir, full));
      }
    })(srcDir);
    assert.ok(callers.length > 0,
      'startRunHeartbeat has ZERO call sites in src/ outside its own file — that is the shipped regression');
    assert.ok(callers.some((c) => c.replace(/\\/g, '/') === 'services/renderer.js'),
      `expected renderer.js among callers, got: ${callers.join(', ')}`);
  });

  console.log('\n── B: the real exported beat writes ONLY updatedAt + lastHeartbeatAt on a running run ──');

  await check('B1 heartbeatOnce writes the exact filter/update pair against a fake CampaignRun', async () => {
    const { runWrites, models } = recordingModels();
    const now = new Date('2026-08-24T00:00:00Z');
    await heartbeatOnce({ CampaignRun: models.CampaignRun, Ad: models.Ad, runDocId: RUN_ID_OBJ, now });
    assert.strictEqual(runWrites.length, 1, 'expected exactly one CampaignRun write');
    assertAllowedHeartbeatFilter(runWrites[0].filter, 'B1 filter');
    assert.strictEqual(String(runWrites[0].filter._id), RUN_ID_OBJ);
    assertAllowedHeartbeatUpdate(runWrites[0].update, 'B1 update');
    assert.deepStrictEqual(runWrites[0].update.$set.updatedAt, now);
    assert.deepStrictEqual(runWrites[0].update.$set.lastHeartbeatAt, now);
  });

  await check('B2 the shared builders agree with what heartbeatOnce actually sent', () => {
    const now = new Date('2026-08-24T12:00:00Z');
    assertAllowedHeartbeatFilter(buildRunHeartbeatFilter(RUN_ID_OBJ), 'builder filter');
    assertAllowedHeartbeatUpdate(buildRunHeartbeatUpdate(now), 'builder update');
  });

  await check('B3 [MUTATION] adding `total` (or any outcome counter) to the write goes red', () => {
    const now = new Date();
    const good = buildRunHeartbeatUpdate(now);
    assertAllowedHeartbeatUpdate(good, 'B3 baseline');

    const mutatedTotal = { $set: { ...good.$set, total: 39 } };
    assert.throws(
      () => assertAllowedHeartbeatUpdate(mutatedTotal, 'B3 mutated total'),
      /forbidden path|exactly \{ updatedAt, lastHeartbeatAt \}/,
      'B3 must reject a write that adds `total` — if this assertion is a no-op the mutation cannot go red'
    );

    const mutatedInc = { $set: { ...good.$set }, $inc: { succeeded: 1 } };
    assert.throws(
      () => assertAllowedHeartbeatUpdate(mutatedInc, 'B3 mutated $inc'),
      /bare \$set|forbidden path/,
      'B3 must reject a write that $inc\'s an outcome counter'
    );

    const mutatedFailed = { $set: { ...good.$set, failed: 1 } };
    assert.throws(
      () => assertAllowedHeartbeatUpdate(mutatedFailed, 'B3 mutated failed'),
      /forbidden path|exactly \{ updatedAt, lastHeartbeatAt \}/
    );
  });

  await check('B5 the Ad arm, when handed ids, writes ONLY updatedAt on status:\'rendering\' — never a counter, never a status flip', async () => {
    const { runWrites, adWrites, models } = recordingModels();
    const ids = ['ad-a', 'ad-b'];
    const now = new Date('2026-08-24T01:00:00Z');
    await heartbeatOnce({
      CampaignRun: models.CampaignRun, Ad: models.Ad,
      runDocId: RUN_ID_OBJ, adIds: ids, now
    });
    assert.strictEqual(runWrites.length, 1);
    assert.strictEqual(adWrites.length, 1);
    assert.deepStrictEqual(adWrites[0].filter, { _id: { $in: ids }, status: 'rendering' });
    assert.deepStrictEqual(Object.keys(adWrites[0].update), ['$set']);
    assert.deepStrictEqual(Object.keys(adWrites[0].update.$set), ['updatedAt']);
    for (const bad of FORBIDDEN_PATHS.concat(['status', 'claimedByWorker'])) {
      assert.ok(!(bad in adWrites[0].update.$set), `Ad arm wrote forbidden path ${bad}`);
    }
  });

  await check('B4 a beat does not resurrect a run that is no longer running', async () => {
    const doc = { _id: RUN_ID_OBJ, status: 'failed', updatedAt: new Date(0), lastHeartbeatAt: null, total: 39, succeeded: 18 };
    const CampaignRun = {
      async updateOne(filter, update) {
        if (filter.status === 'running' && doc.status !== 'running') return { matchedCount: 0, modifiedCount: 0 };
        if (update.$set) Object.assign(doc, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      }
    };
    await heartbeatOnce({ CampaignRun, Ad: { updateMany: async () => ({}) }, runDocId: RUN_ID_OBJ, now: new Date() });
    assert.strictEqual(doc.status, 'failed');
    assert.deepStrictEqual(doc.updatedAt, new Date(0));
    assert.strictEqual(doc.total, 39, 'a heartbeat on a failed run must not touch total');
    assert.strictEqual(doc.succeeded, 18);
  });

  console.log('\n── G: the in-flight gate — no work in flight => no write ──');

  await check('G1 startRunHeartbeat with isWorking() false NEVER writes', async () => {
    const { runWrites, adWrites, models } = recordingModels();
    const hb = startRunHeartbeat({
      runDocId: RUN_ID_OBJ,
      adIds: ['ad1'],
      isWorking: () => false,
      models,
      intervalMs: 15
    });
    try {
      await sleep(80);
      assert.strictEqual(runWrites.length, 0,
        'an idle loop must emit no beat — an unconditional heartbeat defeats the reaper outright');
      assert.strictEqual(adWrites.length, 0);
      assert.ok(hb.idle >= 1, `the ticker must have evaluated the gate and declined, idle=${hb.idle}`);
    } finally {
      hb.stop();
    }
  });

  await check('G2 [MUTATION: constant true] renderer.js isWorking is NOT `() => true`', () => {
    const processAd = fnBody(SRC, 'processAd');
    const acquire = fnBody(SRC, 'acquireRunHeartbeat');
    const haystack = `${processAd || ''}\n${acquire || ''}`;
    const callIdx = haystack.search(/startRunHeartbeat\s*\(/);
    assert.ok(callIdx >= 0, 'startRunHeartbeat(...) must be called from processAd or acquireRunHeartbeat');
    const call = balanced(haystack, haystack.indexOf('(', callIdx), '(', ')');
    assert.ok(call, 'could not extract the startRunHeartbeat(...) argument list');
    const m = /isWorking\s*:\s*([^\n,]+)/.exec(call);
    assert.ok(m, `isWorking predicate not found in call: ${call.slice(0, 200)}`);
    const expr = m[1].trim();
    // EXACT match, not a "contains runIsWorking" presence check. `() => runIsWorking(runId) || true`
    // keeps every token this check used to look for while beating unconditionally.
    assert.strictEqual(expr.replace(/\s+/g, ''), '()=>runIsWorking(runId)',
      `isWorking must be exactly () => runIsWorking(runId), got: ${expr} — a truthy constant ` +
      'or a `|| true` smuggle would beat unconditionally and defeat the reaper');
  });

  await check('G3 [MUTATION: process-wide inFlight] the gate reads the PER-RUN inflight map, not process-wide inFlight', () => {
    const acquire = fnBody(SRC, 'acquireRunHeartbeat');
    assert.ok(acquire, 'acquireRunHeartbeat must exist — that is where the per-run count lives');
    const callIdx = acquire.search(/startRunHeartbeat\s*\(/);
    assert.ok(callIdx >= 0, 'acquireRunHeartbeat must call startRunHeartbeat');
    const call = balanced(acquire, acquire.indexOf('(', callIdx), '(', ')');
    const m = /isWorking\s*:\s*([^\n,]+)/.exec(call);
    assert.ok(m, 'isWorking predicate not found');
    const expr = m[1].trim();
    // Process-wide `inFlight > 0` would keep a finished run beating while
    // a sibling run's ads were in flight — the same class of bug as a
    // constant true, just smaller. The equivalent of backend's
    // pools.some(p => p.inflight > 0) in a multi-run worker is a per-run map.
    assert.ok(!/\binFlight\s*>\s*0/.test(expr),
      `isWorking reads the process-wide inFlight (${expr}) — that is "any ad, any run", not this run's work`);
    assert.ok(/runIsWorking|runInflight/.test(expr) || /runIsWorking|runInflight/.test(acquire),
      `isWorking must read the per-run inflight signal (runInflight / runIsWorking), got: ${expr}`);
    assert.match(acquire, /runInflight\.set\s*\(/,
      'acquireRunHeartbeat must increment runInflight — otherwise the gate has nothing real to read');
    assert.match(acquire, /Ad\.find\s*\(\s*\{\s*campaignRunIds:\s*runId\s*\}/,
      'acquireRunHeartbeat must load this run\'s claimed ads for the Ad arm — a one-ad snapshot misses the waiting tail');
  });

  await check('G4 runIsWorking reports the Map, not a constant', () => {
    const body = fnBody(SRC, 'runIsWorking');
    assert.ok(body, 'runIsWorking must exist');
    assert.match(body, /runInflight\.get/,
      'runIsWorking must read runInflight.get — a hardcoded return true is the G2 mutation under another name');
    const ret = /return\s+([^;]+);/.exec(body);
    assert.ok(ret, 'runIsWorking has no return');
    assert.strictEqual(ret[1].replace(/\s+/g, ''), '(runInflight.get(runId)||0)>0',
      `runIsWorking must return (runInflight.get(runId) || 0) > 0, got: ${ret[1].trim()}`);
  });

  console.log('\n── C: the lifetime cap exists and is finite ──');

  await check('C1 RUN_HEARTBEAT_MAX_MS is a finite positive duration', () => {
    assert.strictEqual(typeof RUN_HEARTBEAT_MAX_MS, 'number');
    assert.ok(Number.isFinite(RUN_HEARTBEAT_MAX_MS),
      `cap is not finite (${RUN_HEARTBEAT_MAX_MS}) — Infinity is immortality, the hazard the cap exists to close`);
    assert.ok(RUN_HEARTBEAT_MAX_MS > 0, 'cap must be positive');
    assert.ok(RUN_HEARTBEAT_MAX_MS < Number.MAX_SAFE_INTEGER,
      'cap must not be a "functionally infinite" sentinel');
  });

  await check('C2 the cap matches progressService.MAX_RUN_MS (same logical run)', () => {
    const progressSrc = fs.readFileSync(path.join(ROOT, 'src/services/progressService.js'), 'utf8');
    const m = progressSrc.match(/const MAX_RUN_MS\s*=\s*([^;]+);/);
    assert.ok(m, 'could not read progressService MAX_RUN_MS');
    // eslint-disable-next-line no-eval
    const progressMax = eval(m[1]);
    assert.strictEqual(RUN_HEARTBEAT_MAX_MS, progressMax,
      `the run heartbeat cap (${RUN_HEARTBEAT_MAX_MS}ms) must equal progressService.MAX_RUN_MS ` +
      `(${progressMax}ms) — they cap the same logical run`);
    assert.strictEqual(RUN_HEARTBEAT_MAX_MS, 4 * 60 * 60 * 1000, 'expected 4 hours');
  });

  await check('C3 a wedged isWorking()===true still ages out — the cap fires and the beat stops', async () => {
    const { runWrites, models } = recordingModels();
    const hb = startRunHeartbeat({
      runDocId: RUN_ID_OBJ,
      isWorking: () => true,
      models,
      intervalMs: 10,
      maxMs: 40
    });
    try {
      await sleep(180);
      assert.strictEqual(hb.expired, true,
        'the ticker must expire itself past maxMs even while isWorking() keeps saying true');
      assert.strictEqual(hb.stopped, true);
      const frozen = runWrites.length;
      assert.ok(frozen > 0, 'sanity: it beat before the cap');
      await sleep(60);
      assert.strictEqual(runWrites.length, frozen, 'no beat may land after the lifetime cap');
    } finally {
      hb.stop();
    }
  });

  await check('C4 startRunHeartbeat unref()s its interval so it cannot hold the process open', () => {
    assert.match(HB_SRC, /timer\.unref\(\)/,
      'startRunHeartbeat must unref its interval — same as the Ad beat and the progressService beat');
  });

  console.log('\n── S: stop() in BOTH catch AND finally, plus unref. Idempotent. ──');

  const processAd = fnBody(SRC, 'processAd');
  await check('S0 processAd exists and is the wrap point', () => {
    assert.ok(processAd && processAd.length > 200, 'processAd not found');
    assert.match(processAd, /acquireRunHeartbeat\s*\(/,
      'processAd must acquire the run heartbeat — that is the wrap around in-flight work');
  });

  await check('S1 [MUTATION: drop catch stop] processAd\'s OUTER catch calls stop() and rethrows', () => {
    // Two catch (err) blocks: inner swallows render failures; outer is the
    // heartbeat arm. We want the catch whose body calls stop() AND throw.
    const catches = [];
    const RE = /\} catch \(err\) \{/g;
    let m;
    while ((m = RE.exec(processAd))) {
      const open = processAd.indexOf('{', m.index + 1);
      const body = balanced(processAd, open, '{', '}');
      if (body) catches.push(body);
    }
    assert.ok(catches.length >= 2,
      `expected inner render-failure catch + outer heartbeat catch, found ${catches.length}`);
    const outer = catches.find((b) => /\.stop\(\)/.test(b) && /\bthrow\s+err\b/.test(b));
    assert.ok(outer,
      'the outer catch must call stop() AND rethrow — a crashed run whose timer keeps beating ' +
      'would be kept out of the reaper\'s reach forever');
  });

  await check('S2 [MUTATION: drop finally stop] processAd has a finally that stops the SAME handle acquire returned', () => {
    const decl = /(?:const|let)\s+(\w+)\s*=\s*await\s+acquireRunHeartbeat\s*\(/.exec(processAd);
    assert.ok(decl, 'processAd must capture acquireRunHeartbeat\'s return value');
    const varName = decl[1];
    const fm = /finally\s*\{/.exec(processAd);
    assert.ok(fm, 'processAd must have a finally arm');
    const finallyBody = balanced(processAd, processAd.indexOf('{', fm.index), '{', '}');
    assert.ok(finallyBody, 'unterminated finally');
    assert.match(finallyBody, new RegExp(`\\b${varName}\\.stop\\(\\)`),
      `the finally must call ${varName}.stop() — the exact handle acquireRunHeartbeat returned`);
    assert.ok(!/\bAd\s*\.\s*(updateOne|updateMany|findOneAndUpdate)\s*\(/.test(finallyBody),
      'the finally that stops the run beat must not perform any other Ad write');
  });

  await check('S3 stop() is idempotent — catch+finally both calling it is a no-op, not a second timer', async () => {
    const { runWrites, models } = recordingModels();
    const hb = startRunHeartbeat({
      runDocId: RUN_ID_OBJ,
      isWorking: () => true,
      models,
      intervalMs: 15
    });
    try {
      await sleep(40);
      const afterFirst = runWrites.length;
      assert.ok(afterFirst > 0, 'sanity: it was beating before stop()');
      hb.stop();
      hb.stop();
      assert.strictEqual(hb.stopped, true);
      await sleep(50);
      assert.strictEqual(runWrites.length, afterFirst,
        'no beat may land after stop() — the double call from catch+finally must be a no-op, not a second timer');
    } finally {
      hb.stop();
    }
  });

  await check('S4 acquireRunHeartbeat increments BEFORE starting the ticker (leading beat needs a true gate)', () => {
    const acquire = fnBody(SRC, 'acquireRunHeartbeat');
    const incIdx = acquire.search(/runInflight\.set\s*\(/);
    const startIdx = acquire.search(/startRunHeartbeat\s*\(/);
    assert.ok(incIdx >= 0 && startIdx >= 0, 'missing increment or startRunHeartbeat in acquireRunHeartbeat');
    assert.ok(incIdx < startIdx,
      'runInflight must be incremented BEFORE startRunHeartbeat so the leading beat sees real work — ' +
      'backend has the opposite order (start, then dispatch) and its leading beat therefore often no-ops');
  });

  // ── report ─────────────────────────────────────────────────────────────
  const total = checks + failures.length;
  console.log('');
  if (failures.length) {
    console.log(`❌ verifyAdgenRunHeartbeat: ${failures.length} of ${total} checks FAILED`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ verifyAdgenRunHeartbeat: ${total}/${total} checks passed`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
