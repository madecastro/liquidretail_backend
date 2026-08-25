#!/usr/bin/env node
'use strict';
//
// verifyRemotionChildIsolation — parent-side supervision of a Remotion
// titling child, driven against STUB children. Does not launch Chrome,
// does not load remotionRenderService (that would pull @remotion/bundler
// on first render), does not talk to Mongo, the network, or any API key.
//
// WHY THIS EXISTS. Production titling used to run Remotion IN the same
// Node process that claims ads (ADGEN_MAX_INFLIGHT=32). A Chrome/ffmpeg
// OOM SIGKILL'd the whole process and stranded the other ~30 claims —
// measured 2026-08-24, 12 ads left untitled, two 8 GiB instances killed.
// Isolation is load-bearing: the parent must (a) kill a hung child, (b)
// tell OOM (SIGKILL/137) apart from a merited render throw, (c) pass
// paths not buffers over IPC, (d) keep REMOTION_QUEUE_CONCURRENCY as
// the bound on how many run at once.
//
// WHAT THIS PINS
//   A. classifyChildExit: timeout vs OOM vs merited exit vs ok
//   B. serializePayload rejects Buffers; serializeError/deserializeError
//      restore name/message/stack/code (JSON does not keep Error intact)
//   C. Behavioural: superviseRemotionChild against stub children
//        1. normal completion → { finalPath, tempDir } paths
//        2. non-zero exit with serialized Error → kind:'render', stack kept
//        3. SIGKILL (not our timer) → oomKilled, code REMOTION_CHILD_OOM
//        4. hung child → SIGKILL from the supervisor, kind:'timeout',
//           NOT oom (the timedOut flag is what makes that distinction)
//        5. timeout also kills a same-group grandchild (Chrome-shaped)
//   D. Structural (source of remotionRenderService / renderer /
//      brandScriptExecutor / titlingResumeService):
//        - production renderTitles goes through enqueue + supervise
//        - Remotion delayRender timeout is RENDER_TIMEOUT_MS (REMOTION_TIMEOUT_MS, default 180s)
//        - supervisor wall-clock is CHILD_TIMEOUT_MS (REMOTION_CHILD_TIMEOUT_MS, default 480s)
//          DISTINCT from the delayRender timeout, finite, under the heartbeat cap
//        - queue still reads REMOTION_QUEUE_CONCURRENCY
//        - OOM is not a terminal status:'failed' on a paid master
//        - OOM early-return is INSIDE the heartbeat try whose finally
//          stops the beat (so the timer cannot outlive the render)
//
// Pure + offline: Node builtins + src/services/remotionChildSupervisor.js
// (itself builtins only). Run:
//   node scripts/verifyRemotionChildIsolation.js
//
// REVERT-PROOF (see session report for this exact run):
//   flipping classifyChildExit so SIGKILL is 'exit' not 'oom'  → C3 red
//   removing the supervisor's SIGKILL on timeout               → C4 red
//   deserializeError dropping stack                            → B2 red
//   serializePayload allowing Buffer                           → B1 red
//   renderTitles no longer calling enqueue(supervise...)       → D1 red
//   OOM catch nested OUTSIDE the heartbeat try/finally         → D11 red
//     (D6 and verifyTitlingHeartbeat B1 stay green — that is the
//      silent leak this rebase can reintroduce while both features
//      appear present)
//   timeoutMs: RENDER_TIMEOUT_MS again (reunite the two bounds) → B5 red
//   CHILD_TIMEOUT_MS fallback Infinity / omit the || literal    → B6 red
//   CHILD_TIMEOUT_MS raised to 700_000 (past 10min floor)      → B7 red
//   superviseRemotionChild accepting timeoutMs: Infinity        → B8 red
//   drop REMOTION_CHILD_TIMEOUT_MS from defaults.env            → D12 red

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const {
  RENDER_TIMEOUT_MS,
  CHILD_TIMEOUT_MS,
  superviseRemotionChild,
  classifyChildExit,
  serializePayload,
  serializeError,
  deserializeError,
  defaultChildEnv,
  isRemotionChildOomError,
  isRemotionChildTimeoutError
} = require('../src/services/remotionChildSupervisor');

const ROOT = path.join(__dirname, '..');
const SUPERVISOR_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'remotionChildSupervisor.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'remotionRenderService.js'), 'utf8');
const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'renderer.js'), 'utf8');
const EXECUTOR_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'brandScriptExecutor.js'), 'utf8');
const RESUME_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'titlingResumeService.js'), 'utf8');
const CHILD_FILE = path.join(ROOT, 'src', 'services', 'remotionRender.child.js');

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      return ret.then(() => { pass += 1; console.log(`  ✓ ${label}`); })
        .catch((err) => { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); });
    }
    pass += 1;
    console.log(`  ✓ ${label}`);
    return undefined;
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
    return undefined;
  }
}

function writeStub(name, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotion-child-verify-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return { dir, file };
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ═════════════════════════════════════════════════════════════════════════
// A — classifyChildExit (pure, no spawn)
// ═════════════════════════════════════════════════════════════════════════
console.log('── A. classifyChildExit ──');
check('A1 ok exit is ok', () => {
  assert.strictEqual(classifyChildExit({ code: 0, signal: null, timedOut: false }), 'ok');
});
check('A2 SIGKILL without our timer is oom (Linux OOM killer / kernel SIGKILL)', () => {
  assert.strictEqual(classifyChildExit({ code: null, signal: 'SIGKILL', timedOut: false }), 'oom');
});
check('A3 exit code 137 is oom (128+SIGKILL)', () => {
  assert.strictEqual(classifyChildExit({ code: 137, signal: null, timedOut: false }), 'oom');
});
check('A4 exit code 9 is oom', () => {
  assert.strictEqual(classifyChildExit({ code: 9, signal: null, timedOut: false }), 'oom');
});
check('A5 our timeout SIGKILL is timeout, NOT oom — this is the whole distinction', () => {
  assert.strictEqual(classifyChildExit({ code: null, signal: 'SIGKILL', timedOut: true }), 'timeout');
  assert.strictEqual(classifyChildExit({ code: 137, signal: null, timedOut: true }), 'timeout');
});
check('A6 merited non-zero is exit', () => {
  assert.strictEqual(classifyChildExit({ code: 1, signal: null, timedOut: false }), 'exit');
  assert.strictEqual(classifyChildExit({ code: 2, signal: 'SIGTERM', timedOut: false }), 'exit');
});

// ═════════════════════════════════════════════════════════════════════════
// B — IPC serialisation
// ═════════════════════════════════════════════════════════════════════════
console.log('\n── B. IPC serialisation (paths, not buffers; Error survives JSON) ──');
check('B1 serializePayload rejects a Buffer (the whole point of "pass a path")', () => {
  assert.throws(
    () => serializePayload({ videoUrl: Buffer.from('not-a-path') }),
    /forbids buffers/
  );
  assert.throws(
    () => serializePayload({ tokens: { raw: { type: 'Buffer', data: [1, 2, 3] } } }),
    /forbids Buffer JSON/
  );
  const json = serializePayload({ videoUrl: '/tmp/plate.mp4', spec: { id: 'x' } });
  assert.strictEqual(JSON.parse(json).videoUrl, '/tmp/plate.mp4');
});
check('B2 deserializeError restores name, message, stack, code — JSON(Error) would not', () => {
  const original = new Error('composition exploded');
  original.name = 'TypeError';
  original.code = 'ERENDER';
  // Unique frame so a `new Error(message)` default stack (which also
  // contains the message text) cannot satisfy the assertion — that hole
  // let a "drop the stack" mutation keep B2 green.
  original.stack = 'Error: composition exploded\n    at uniqueFrame (verify.js:99:1)';
  const wire = serializeError(original);
  assert.strictEqual(wire.message, 'composition exploded');
  assert.ok(wire.stack && wire.stack.indexOf('uniqueFrame (verify.js:99:1)') !== -1, 'stack must ride on the wire');
  const round = deserializeError(wire);
  assert.strictEqual(round.message, 'composition exploded');
  assert.strictEqual(round.name, 'TypeError');
  assert.strictEqual(round.code, 'ERENDER');
  assert.ok(round.stack && round.stack.indexOf('uniqueFrame (verify.js:99:1)') !== -1);
  assert.strictEqual(round.kind, 'render');
  // Control: structured clone / JSON.stringify of an Error loses the stack
  // as an own property on the reconstructed object. Pin that we did NOT
  // just JSON.parse(JSON.stringify(err)).
  const naive = JSON.parse(JSON.stringify(original));
  assert.ok(!naive.stack, 'sanity: naive JSON(Error) has no stack — if this fails, the B2 control is wrong');
});
check('B3 defaultChildEnv strips secrets (MONGODB_URI, ATLAS keys) and sets REMOTION_IN_CHILD', () => {
  const prevMongo = process.env.MONGODB_URI;
  const prevAtlas = process.env.ATLAS_API_KEY;
  process.env.MONGODB_URI = 'mongodb://secret-must-not-cross';
  process.env.ATLAS_API_KEY = 'sk-secret';
  try {
    const env = defaultChildEnv();
    assert.strictEqual(env.REMOTION_IN_CHILD, '1');
    assert.strictEqual(env.MONGODB_URI, undefined);
    assert.strictEqual(env.ATLAS_API_KEY, undefined);
    assert.ok(env.PATH, 'PATH must survive so the child can find node/chrome');
  } finally {
    if (prevMongo === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = prevMongo;
    if (prevAtlas === undefined) delete process.env.ATLAS_API_KEY; else process.env.ATLAS_API_KEY = prevAtlas;
  }
});
check('B4 RENDER_TIMEOUT_MS is Remotion\'s delayRender timeout (REMOTION_TIMEOUT_MS default 180000), NOT the child kill', () => {
  assert.strictEqual(RENDER_TIMEOUT_MS, Number(process.env.REMOTION_TIMEOUT_MS || 180_000));
  assert.ok(SUPERVISOR_SRC.indexOf('REMOTION_TIMEOUT_MS') !== -1);
  assert.ok(SUPERVISOR_SRC.indexOf('180_000') !== -1);
  // Not the canvas child's 5-minute budget — that would stall a 2-slot queue.
  assert.ok(SUPERVISOR_SRC.indexOf('5 * 60 * 1000') === -1);
});
check('B5 [MUTATION: reunite the two bounds] CHILD_TIMEOUT_MS is DISTINCT from RENDER_TIMEOUT_MS', () => {
  assert.notStrictEqual(CHILD_TIMEOUT_MS, RENDER_TIMEOUT_MS,
    'supervisor wall-clock and Remotion delayRender timeout must not share a value — ' +
    'tuning one (admit a 380s encode) would break the other (hung delayRender waits the same)');
  assert.ok(SUPERVISOR_SRC.indexOf('REMOTION_CHILD_TIMEOUT_MS') !== -1,
    'wall-clock must be its own env var, not an alias of REMOTION_TIMEOUT_MS');
  assert.match(RENDER_SRC, /timeoutMs:\s*CHILD_TIMEOUT_MS\s*[,\n}]/,
    'parent must pass CHILD_TIMEOUT_MS as the child kill budget, with no trailing arithmetic');
  assert.ok(!/timeoutMs:\s*CHILD_TIMEOUT_MS\s*[*/+-]/.test(RENDER_SRC),
    'timeoutMs: CHILD_TIMEOUT_MS * N would still match a prefix check while doubling the kill budget');
  assert.ok(!/timeoutMs:\s*RENDER_TIMEOUT_MS/.test(RENDER_SRC),
    'parent must not reuse RENDER_TIMEOUT_MS as the child kill budget');
  assert.ok(/timeoutInMilliseconds:\s*RENDER_TIMEOUT_MS/.test(RENDER_SRC),
    'Remotion calls must still pass RENDER_TIMEOUT_MS as timeoutInMilliseconds');
});
check('B6 [MUTATION: Infinity / absent] CHILD_TIMEOUT_MS is finite, positive, and admits the measured max', () => {
  assert.ok(Number.isFinite(CHILD_TIMEOUT_MS) && CHILD_TIMEOUT_MS > 0,
    `CHILD_TIMEOUT_MS must be a finite positive number, got ${CHILD_TIMEOUT_MS}`);
  assert.ok(CHILD_TIMEOUT_MS > 380_000,
    `CHILD_TIMEOUT_MS=${CHILD_TIMEOUT_MS} does not admit the measured max of 380s`);
  const decl = /const CHILD_TIMEOUT_MS\s*=\s*Number\(process\.env\.REMOTION_CHILD_TIMEOUT_MS\s*\|\|\s*([^)]+)\)/.exec(SUPERVISOR_SRC);
  assert.ok(decl, 'CHILD_TIMEOUT_MS must be Number(process.env.REMOTION_CHILD_TIMEOUT_MS || <literal>) — an absent fallback is Number(undefined) === NaN, i.e. unbounded');
  const fallback = decl[1].replace(/\s+/g, '');
  assert.ok(!/Infinity|NaN|undefined|null/.test(fallback),
    `wall-clock fallback must not be Infinity/absent/NaN, found ${fallback}`);
  const n = Number(fallback.replace(/_/g, ''));
  assert.ok(Number.isFinite(n) && n > 0,
    `wall-clock fallback must parse as a finite positive number, got ${fallback}`);
});
check('B7 [MUTATION: raise past heartbeat cap] CHILD_TIMEOUT_MS is under the titling-heartbeat lifetime cap', () => {
  // Heartbeat lifetime cap (renderer.js): max(10min floor,
  // 3 * ceil(MAX_INFLIGHT / REMOTION_QUEUE_CONCURRENCY) * 76s).
  // Live (32 / 2): 3,648,000ms = 60.8 min. Floor binds if concurrency
  // rises enough to shrink the derived term. The wall-clock must sit
  // under BOTH so a hung child is SIGKILL'd (slot frees) before the
  // beat dies (bootRecovery can steal a still-running render).
  assert.match(RENDERER_SRC, /const AD_HEARTBEAT_MAX_MS/,
    'heartbeat cap must still exist — do not "fix" a long render by removing it');
  assert.match(RENDERER_SRC, /10\s*\*\s*60\s*\*\s*1000/,
    'heartbeat formula floor (10 min) must still be in AD_HEARTBEAT_MAX_MS');
  const HEARTBEAT_FLOOR_MS = 10 * 60 * 1000;
  const LIVE_CAP_MS = Math.max(
    HEARTBEAT_FLOOR_MS,
    3 * Math.ceil(32 / 2) * 76_000
  );
  assert.strictEqual(LIVE_CAP_MS, 3_648_000, 'sanity: live cap is 60.8 min at MAX_INFLIGHT=32, conc=2');
  assert.ok(CHILD_TIMEOUT_MS < HEARTBEAT_FLOOR_MS,
    `CHILD_TIMEOUT_MS=${CHILD_TIMEOUT_MS} must sit under the heartbeat floor (${HEARTBEAT_FLOOR_MS}ms) ` +
    'so a hung child is killed before the beat dies even if the floor binds');
  assert.ok(CHILD_TIMEOUT_MS < LIVE_CAP_MS,
    `CHILD_TIMEOUT_MS=${CHILD_TIMEOUT_MS} must sit under today's live heartbeat cap (${LIVE_CAP_MS}ms)`);
});
check('B8 [MUTATION: pass Infinity / omit timeoutMs] superviseRemotionChild refuses a non-finite kill budget', () => {
  assert.throws(
    () => superviseRemotionChild({ runnerPath: CHILD_FILE, payload: { videoUrl: '/tmp/x' }, timeoutMs: Infinity }),
    /timeoutMs must be a positive number/
  );
  assert.throws(
    () => superviseRemotionChild({ runnerPath: CHILD_FILE, payload: { videoUrl: '/tmp/x' } }),
    /timeoutMs must be a positive number/
  );
  assert.throws(
    () => superviseRemotionChild({ runnerPath: CHILD_FILE, payload: { videoUrl: '/tmp/x' }, timeoutMs: 0 }),
    /timeoutMs must be a positive number/
  );
  assert.throws(
    () => superviseRemotionChild({ runnerPath: CHILD_FILE, payload: { videoUrl: '/tmp/x' }, timeoutMs: -1 }),
    /timeoutMs must be a positive number/
  );
});

// ═════════════════════════════════════════════════════════════════════════
// C — behavioural supervision against stub children (no Chrome)
// ═════════════════════════════════════════════════════════════════════════
async function runC() {
  console.log('\n── C. superviseRemotionChild vs stub children ──');
  await check('C1 normal completion returns path fields, not buffers', async () => {
    const stub = writeStub('ok.js', [
      "'use strict';",
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => { buf += c; });",
      "process.stdin.on('end', () => {",
      "  const cfg = JSON.parse(buf.trim());",
      "  process.stdout.write(':: stub progress\\n');",
      "  process.stdout.write(JSON.stringify({",
      "    ok: true,",
      "    finalPath: '/tmp/stub-out.mp4',",
      "    tempDir: '/tmp/stub-job',",
      "    timings: { renderMs: 1, adId: cfg.adId || null }",
      "  }) + '\\n');",
      "});",
      ''
    ].join('\n'));
    try {
      const result = await superviseRemotionChild({
        runnerPath: stub.file,
        payload: { videoUrl: '/tmp/plate.mp4', spec: { id: 'canonical' }, adId: 'ad-verify-1' },
        timeoutMs: 5000,
        cwd: stub.dir
      });
      assert.strictEqual(result.finalPath, '/tmp/stub-out.mp4');
      assert.strictEqual(result.tempDir, '/tmp/stub-job');
      assert.strictEqual(typeof result.finalPath, 'string');
      assert.ok(!Buffer.isBuffer(result.finalPath));
      assert.strictEqual(result.timings.adId, 'ad-verify-1');
    } finally {
      rmDir(stub.dir);
    }
  });

  await check('C2 non-zero exit with serialized Error → kind render, stack kept, NOT oom', async () => {
    const stub = writeStub('fail.js', [
      "'use strict';",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stderr.write('chrome said no\\n');",
      "  process.stdout.write(JSON.stringify({",
      "    ok: false,",
      "    error: {",
      "      name: 'Error',",
      "      message: 'composition exploded',",
      "      stack: 'Error: composition exploded\\n    at stub.js:4:3',",
      "      code: 'ERENDER'",
      "    }",
      "  }) + '\\n');",
      "  process.exit(2);",
      "});",
      ''
    ].join('\n'));
    try {
      let caught = null;
      try {
        await superviseRemotionChild({
          runnerPath: stub.file,
          payload: { videoUrl: '/tmp/plate.mp4' },
          timeoutMs: 5000,
          cwd: stub.dir
        });
      } catch (err) { caught = err; }
      assert.ok(caught, 'expected throw');
      assert.strictEqual(caught.message, 'composition exploded');
      assert.strictEqual(caught.code, 'ERENDER');
      assert.strictEqual(caught.kind, 'render');
      assert.ok(caught.stack && caught.stack.indexOf('stub.js:4:3') !== -1, `stack not restored: ${caught.stack}`);
      assert.strictEqual(caught.oomKilled, undefined);
      assert.strictEqual(isRemotionChildOomError(caught), false);
      assert.strictEqual(isRemotionChildTimeoutError(caught), false);
    } finally {
      rmDir(stub.dir);
    }
  });

  await check('C3 SIGKILL (child self-kill, timer not fired) → oomKilled, distinct from render throw', async () => {
    const stub = writeStub('oom.js', [
      "'use strict';",
      "process.stdin.resume();",
      "process.stdin.on('end', () => { process.kill(process.pid, 'SIGKILL'); });",
      ''
    ].join('\n'));
    try {
      let caught = null;
      try {
        await superviseRemotionChild({
          runnerPath: stub.file,
          payload: { videoUrl: '/tmp/plate.mp4' },
          timeoutMs: 5000,
          cwd: stub.dir
        });
      } catch (err) { caught = err; }
      assert.ok(caught, 'expected throw');
      assert.strictEqual(caught.kind, 'oom');
      assert.strictEqual(caught.oomKilled, true);
      assert.strictEqual(caught.timedOut, false);
      assert.strictEqual(caught.code, 'REMOTION_CHILD_OOM');
      assert.strictEqual(isRemotionChildOomError(caught), true);
      assert.strictEqual(isRemotionChildTimeoutError(caught), false);
      assert.ok(/OOM-killed/.test(caught.message), caught.message);
    } finally {
      rmDir(stub.dir);
    }
  });

  await check('C4 hung child is SIGKILL\'d and surfaces kind:timeout, NOT oom', async () => {
    const stub = writeStub('hang.js', [
      "'use strict';",
      "process.stdin.resume();",
      "setInterval(() => {}, 1e9);",
      ''
    ].join('\n'));
    try {
      const t0 = Date.now();
      let caught = null;
      try {
        await superviseRemotionChild({
          runnerPath: stub.file,
          payload: { videoUrl: '/tmp/plate.mp4' },
          timeoutMs: 400,
          cwd: stub.dir
        });
      } catch (err) { caught = err; }
      const elapsed = Date.now() - t0;
      assert.ok(caught, 'expected throw');
      assert.strictEqual(caught.kind, 'timeout');
      assert.strictEqual(caught.timedOut, true);
      assert.strictEqual(caught.oomKilled, false);
      assert.strictEqual(caught.code, 'REMOTION_CHILD_TIMEOUT');
      assert.strictEqual(isRemotionChildTimeoutError(caught), true);
      assert.strictEqual(isRemotionChildOomError(caught), false);
      assert.ok(elapsed < 4000, `timeout kill took too long (${elapsed}ms) — child was not killed`);
      assert.ok(elapsed >= 300, `timeout fired too fast (${elapsed}ms) — budget was 400ms`);
    } finally {
      rmDir(stub.dir);
    }
  });

  await check('C6 timeout also kills a grandchild (Chrome-shaped descendant), not just the node child', async () => {
    const stub = writeStub('tree.js', [
      "'use strict';",
      "const fs = require('fs');",
      "const { spawn } = require('child_process');",
      "const pidFile = process.env.GRANDCHILD_PID_FILE;",
      // Same group as this stub (no detached) so kill(-leader) takes it.
      "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore' });",
      "fs.writeFileSync(pidFile, String(g.pid));",
      "process.stdin.resume();",
      "setInterval(() => {}, 1e9);",
      ''
    ].join('\n'));
    const pidFile = path.join(stub.dir, 'grandchild.pid');
    try {
      let caught = null;
      try {
        await superviseRemotionChild({
          runnerPath: stub.file,
          payload: { videoUrl: '/tmp/plate.mp4' },
          timeoutMs: 400,
          cwd: stub.dir,
          env: Object.assign({}, process.env, { GRANDCHILD_PID_FILE: pidFile, REMOTION_IN_CHILD: '1' })
        });
      } catch (err) { caught = err; }
      assert.ok(caught, 'expected timeout throw');
      assert.strictEqual(caught.kind, 'timeout');
      assert.ok(fs.existsSync(pidFile), 'grandchild pid file missing — stub did not start');
      const gpid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      assert.ok(gpid > 0, 'bad grandchild pid');
      // Give the kernel a beat to reap, then prove the descendant is gone.
      const t0 = Date.now();
      let alive = true;
      while (Date.now() - t0 < 2000) {
        try { process.kill(gpid, 0); alive = true; } catch { alive = false; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(alive, false, `grandchild pid ${gpid} still alive after process-group SIGKILL`);
    } finally {
      rmDir(stub.dir);
    }
  });

  await check('C5 non-zero exit WITHOUT a JSON report still throws a real error (kind:exit)', async () => {
    const stub = writeStub('bare.js', [
      "'use strict';",
      "process.stdin.resume();",
      "process.stdin.on('end', () => { process.stderr.write('no report\\n'); process.exit(3); });",
      ''
    ].join('\n'));
    try {
      let caught = null;
      try {
        await superviseRemotionChild({
          runnerPath: stub.file,
          payload: { videoUrl: '/tmp/plate.mp4' },
          timeoutMs: 5000,
          cwd: stub.dir
        });
      } catch (err) { caught = err; }
      assert.ok(caught, 'expected throw');
      assert.strictEqual(caught.kind, 'exit');
      assert.ok(/exited code=3/.test(caught.message), caught.message);
      assert.strictEqual(isRemotionChildOomError(caught), false);
    } finally {
      rmDir(stub.dir);
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════
// D — structural: queue semantics, timeout constant, OOM handling
// ═════════════════════════════════════════════════════════════════════════
function runD() {
  console.log('\n── D. structural (real source, not a reimplementation) ──');

  check('D1 production renderTitles goes through enqueue(() => superviseRemotionChild(...))', () => {
    const fn = /async function renderTitles\(args\)\s*\{[\s\S]*?\n\}/.exec(RENDER_SRC);
    assert.ok(fn, 'renderTitles not found');
    const body = fn[0];
    assert.ok(/enqueue\(\(\)\s*=>\s*superviseRemotionChild\(/.test(body), 'parent path must enqueue the supervisor');
    assert.match(body, /timeoutMs:\s*CHILD_TIMEOUT_MS\s*[,\n}]/,
      'parent must pass CHILD_TIMEOUT_MS as the child kill budget, with no trailing arithmetic');
    assert.ok(!/timeoutMs:\s*CHILD_TIMEOUT_MS\s*[*/+-]/.test(body),
      'timeoutMs: CHILD_TIMEOUT_MS * N would still match a prefix check while doubling the kill budget');
    assert.ok(/runnerPath:\s*CHILD_PATH/.test(body), 'parent must spawn remotionRender.child.js');
    assert.ok(/REMOTION_IN_CHILD === '1'/.test(body), 'child re-entry must skip spawn (no fork bomb)');
    assert.ok(/return renderTitlesJob\(args\)/.test(body), 'child re-entry runs the in-process job');
  });

  check('D2 CHILD_PATH is path.join(__dirname, \'remotionRender.child.js\') and the file exists', () => {
    assert.ok(/path\.join\(__dirname,\s*'remotionRender\.child\.js'\)/.test(RENDER_SRC));
    assert.ok(fs.existsSync(CHILD_FILE), 'remotionRender.child.js missing');
    const childSrc = fs.readFileSync(CHILD_FILE, 'utf8');
    assert.ok(/require\('\.\/remotionRenderService'\)/.test(childSrc));
    assert.ok(/serializeError/.test(childSrc), 'child must serialize thrown Errors onto stdout JSON');
    assert.ok(/finalPath/.test(childSrc) && /tempDir/.test(childSrc), 'child report is paths');
    assert.ok(!/Buffer\.from/.test(childSrc), 'child must not send a buffer over stdout');
    assert.ok(/process\.exit\(0\)/.test(childSrc), 'child must process.exit(0) after the ok report or Chrome pins the event loop');
  });

  check('D3 REMOTION_QUEUE_CONCURRENCY still bounds the pool (queue semantics unchanged)', () => {
    assert.ok(/parseInt\(process\.env\.REMOTION_QUEUE_CONCURRENCY,\s*10\)/.test(RENDER_SRC));
    assert.ok(/function enqueue\(taskFn\)/.test(RENDER_SRC));
    assert.ok(/function pump\(\)/.test(RENDER_SRC));
    // Isolation must not raise the default. File default in remotionRenderService
    // is `|| 4`; the committed env default is 2. Do not pin a raise here.
    const q = /parseInt\(process\.env\.REMOTION_QUEUE_CONCURRENCY,\s*10\)\s*\|\|\s*(\d+)/.exec(RENDER_SRC);
    assert.ok(q, 'queue default missing');
    assert.ok(Number(q[1]) <= 4, `queue fallback raised to ${q[1]} — do not raise`);
  });

  check('D4 renderTitlesJob production renderMedia sets disallowParallelEncoding:true', () => {
    const job = /async function renderTitlesJob\([\s\S]*?\n\}/.exec(RENDER_SRC);
    assert.ok(job, 'renderTitlesJob not found');
    assert.ok(/disallowParallelEncoding:\s*true/.test(job[0]));
  });

  check('D5 renderPreview stays in-process (no superviseRemotionChild in that function)', () => {
    const fn = /async function renderPreview\([\s\S]*?\n  \}\);/.exec(RENDER_SRC);
    assert.ok(fn, 'renderPreview not found');
    assert.ok(!/superviseRemotionChild/.test(fn[0]), 'preview must not spawn a titling child');
  });

  check('D6 renderer.js catches a resumable titling failure at BOTH titling sites and returns (does not processAd-fail)', () => {
    // WAS OOM-only (isRemotionChildOomError + "...OOM-killed" log text). The
    // titling-recoverability fix widened this to any RESUMABLE titling
    // failure — OOM, timeout, or a generic child failure/exception, as long
    // as brandScriptExecutor's shared attempt cap has not been exceeded —
    // signalled by err.titlingResumable rather than re-classifying the error
    // here. Markers/assertion updated to match; the invariant this check
    // exists to pin (return before processAd can mark status:'failed') is
    // unchanged and, if anything, now covers strictly more failure kinds.
    const deriveIdx = RENDERER_SRC.indexOf('VIDEO DERIVE titling');
    const masterIdx = RENDERER_SRC.indexOf('VIDEO MASTER titling');
    assert.ok(deriveIdx > 0, 'derive titling-failure catch missing');
    assert.ok(masterIdx > 0, 'master titling-failure catch missing');
    // Each site must return, not throw, so processAd catch cannot mark failed.
    const sliceAround = (idx) => RENDERER_SRC.slice(idx, idx + 400);
    assert.ok(/return;/.test(sliceAround(deriveIdx)));
    assert.ok(/return;/.test(sliceAround(masterIdx)));
    assert.ok(/scriptErr\s*&&\s*scriptErr\.titlingResumable/.test(RENDERER_SRC));
  });

  check('D7 brandScriptExecutor OOM stamp leaves titlingResumeState:\'pending\' (resume can re-title for free)', () => {
    assert.ok(/titlingResumeState:\s*'pending'/.test(EXECUTOR_SRC));
    assert.ok(/REMOTION_CHILD_OOM/.test(EXECUTOR_SRC));
    assert.ok(/isRemotionChildOomError/.test(EXECUTOR_SRC));
    // Must NOT retry a cropped-plate OOM on the raw plate (second Chrome on an
    // already-dying box).
    const oomRetryWindow = EXECUTOR_SRC.slice(
      EXECUTOR_SRC.indexOf('isRemotionChildOomError'),
      EXECUTOR_SRC.indexOf('isRemotionChildOomError') + 2500
    );
    assert.ok(/isRemotionChildTimeoutError/.test(oomRetryWindow));
  });

  check('D8 titlingResumeService does not terminal-fail a resumable (OOM/timeout/generic, under-cap) titling failure', () => {
    // WAS OOM-only (isRemotionChildOomError). titlingResumeService now defers
    // to err.titlingResumable — the same flag D6 reads — which
    // brandScriptExecutor's shared attempt cap sets true/false for EVERY
    // titling-failure kind, not just OOM.
    assert.ok(/titlingResumable\s*===\s*true/.test(RESUME_SRC));
    assert.ok(/left pending for retry/.test(RESUME_SRC));
    // The merited-failure arm (status:'failed' + titlingResumeState:null) must
    // still exist AFTER the resumable skip, not instead of it.
    const resumableIdx = RESUME_SRC.indexOf('titlingResumable === true');
    const failIdx = RESUME_SRC.indexOf("status: 'failed'");
    assert.ok(resumableIdx > 0 && failIdx > resumableIdx, 'resumable skip must precede the merited-failure stamp');
  });

  check('D9 renderer.js terminal $set blocks still clear titlingResumeState on genuine success (untouched)', () => {
    const draftClears = RENDERER_SRC.match(/titlingResumeState:\s*null/g) || [];
    assert.ok(draftClears.length >= 2, 'success stamps should still clear titlingResumeState');
    // processAd catch still marks failed — merited throws still go there.
    assert.ok(/status:\s*'failed'/.test(RENDERER_SRC));
  });

  check('D10 supervisor timeout kill is SIGKILL of the process group (Chrome/ffmpeg descendants die too)', () => {
    assert.ok(/process\.kill\(-pid,\s*'SIGKILL'\)/.test(SUPERVISOR_SRC) || /process\.kill\(-pid, 'SIGKILL'\)/.test(SUPERVISOR_SRC));
    assert.ok(/detached:\s*true/.test(SUPERVISOR_SRC), 'child must be a process-group leader or kill(-pid) hits the PARENT');
    assert.ok(/timedOut = true/.test(SUPERVISOR_SRC));
  });

  // D11 — the rebase hazard. #9 wraps titling in try/finally { beat.stop() }.
  // #8 wraps the same call in try/catch that `return`s on child OOM. Nesting
  // the OOM catch OUTSIDE the heartbeat try/finally (or putting stop() after
  // the catch) lets the early return skip beat.stop() while D6 still sees the
  // return and the heartbeat harness still sees a try{titling}/finally{stop}
  // pair. The beat then outlives the render and keeps a draft+pending row
  // artificially alive — exactly the leak #9's finally exists to prevent.
  check('D11 OOM early-return is inside the heartbeat try whose finally stops the beat (both sites)', () => {
    function balanced(text, openIdx, open, close) {
      if (openIdx < 0 || text[openIdx] !== open) return null;
      let depth = 0;
      for (let i = openIdx; i < text.length; i++) {
        if (text[i] === open) depth++;
        else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
      }
      return null;
    }
    function tryFinallyBlocks(text) {
      const out = [];
      const TRY = /\btry\s*\{/g;
      let m;
      while ((m = TRY.exec(text))) {
        const tryIndex = m.index;
        const openIdx = text.indexOf('{', m.index);
        const tryBody = balanced(text, openIdx, '{', '}');
        if (!tryBody) { TRY.lastIndex = openIdx + 1; continue; }
        const afterTry = openIdx + tryBody.length;
        const fm = /^\s*finally\s*\{/.exec(text.slice(afterTry, afterTry + 60));
        let finallyBody = '';
        let finallyOpen = -1;
        if (fm) {
          finallyOpen = afterTry + fm[0].lastIndexOf('{');
          finallyBody = balanced(text, finallyOpen, '{', '}') || '';
        }
        out.push({ tryIndex, openIdx, tryBody, finallyBody, finallyOpen });
        TRY.lastIndex = afterTry;
      }
      return out;
    }

    // WAS 'VIDEO DERIVE/MASTER remotion child OOM-killed' — now a single
    // resumable-titling-failure log line covers OOM/timeout/generic alike
    // (see D6/D8). The static prefix before the ${scriptErr.titlingFailureKind
    // || 'failed'} interpolation is still a stable source-text marker.
    const sites = [
      'VIDEO DERIVE titling',
      'VIDEO MASTER titling'
    ];
    for (const marker of sites) {
      const logIdx = RENDERER_SRC.indexOf(marker);
      assert.ok(logIdx > 0, `${marker}: titling-failure log missing`);
      const afterLog = RENDERER_SRC.slice(logIdx, logIdx + 400);
      const retRel = afterLog.search(/\breturn\s*;/);
      assert.ok(retRel >= 0, `${marker}: no return; after titling-failure log — processAd would mark failed`);
      const retIdx = logIdx + retRel;

      const covering = tryFinallyBlocks(RENDERER_SRC).filter((b) => {
        if (!/\.stop\s*\(/.test(b.finallyBody)) return false;
        // The return must sit INSIDE this try's body (including nested
        // catch), not in a catch that is a sibling of this try/finally.
        return b.openIdx < retIdx && retIdx < b.openIdx + b.tryBody.length;
      });
      assert.ok(covering.length >= 1,
        `${marker}: OOM return is not inside a try whose finally stops the beat — ` +
        'an early return on child OOM would leak the heartbeat timer. Nest the ' +
        'heartbeat try/finally OUTSIDE the OOM try/catch, never the other way.');

      for (const b of covering) {
        const preTry = RENDERER_SRC.slice(Math.max(0, b.tryIndex - 300), b.tryIndex);
        assert.match(preTry, /startAdHeartbeat\s*\(/,
          `${marker}: covering try/finally is not the heartbeat wrapper — ` +
          'startAdHeartbeat must start immediately before the try that stops it');
      }
    }
  });

  check('D12 defaults.env pins both bounds, with the measured distribution on the wall-clock', () => {
    const defaults = fs.readFileSync(path.join(ROOT, 'config', 'defaults.env'), 'utf8');
    const childAssigns = defaults.match(/^REMOTION_CHILD_TIMEOUT_MS=/gm) || [];
    const renderAssigns = defaults.match(/^REMOTION_TIMEOUT_MS=/gm) || [];
    assert.strictEqual(childAssigns.length, 1,
      'REMOTION_CHILD_TIMEOUT_MS must appear exactly once (dotenv last-occurrence wins)');
    assert.strictEqual(renderAssigns.length, 1,
      'REMOTION_TIMEOUT_MS must appear exactly once (dotenv last-occurrence wins)');
    assert.match(defaults, /^REMOTION_CHILD_TIMEOUT_MS=480000$/m);
    assert.match(defaults, /^REMOTION_TIMEOUT_MS=180000$/m);
    assert.match(SUPERVISOR_SRC,
      /const CHILD_TIMEOUT_MS\s*=\s*Number\(process\.env\.REMOTION_CHILD_TIMEOUT_MS\s*\|\|\s*480_000\)/,
      'code fallback must lockstep with defaults.env (480_000) so a missed dotenv load does not re-ship 180s');
    assert.match(defaults, /mean 89/);
    assert.match(defaults, /p95 158/);
    assert.match(defaults, /max 380/);
    assert.match(defaults, /1\.97 GiB/);
    assert.match(defaults, /concurrency 2/);
  });
}

async function main() {
  runD();
  await runC();

  console.log('');
  if (failures.length) {
    console.log(`❌ verifyRemotionChildIsolation: ${failures.length} of ${pass + failures.length} checks FAILED`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyRemotionChildIsolation: ${pass}/${pass} checks passed`);
}

main().catch((err) => {
  console.error('verifyRemotionChildIsolation: internal error:', err);
  process.exit(1);
});
