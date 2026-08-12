// verifyTitlingQueueParallel — titling must actually run in parallel, and a
// failed render must not shrink the pool.
//
// WHAT WAS WRONG. routes/ads.js wrapped every titling call in a
// VEO_TITLING_CONCURRENCY permit (4) whose own config note called it
// "simultaneous Remotion titling renders". It was not. remotionRenderService
// ran a promise CHAIN:
//
//     queueTail = queueTail.then(task)      // concurrency 1, by construction
//
// so exactly ONE render ever happened, whatever the permit said. Three of four
// permit holders sat idle. That is the whole explanation for the measured
// titling tail on a 20-ad run: 926 seconds, 83% idle, 13 renders strictly back
// to back at ~70s each. Raising the permit had no effect and could not have had
// one — which is why this is a code change and not a config change.
//
// WHY A BEHAVIOURAL TEST AND NOT A GREP. A serial chain and a bounded pool look
// almost identical in source; both mention a queue, both mention concurrency.
// The only honest question is "do two tasks ever overlap in time", so these
// checks RUN the real exported `enqueue` and observe overlap.
//
// THE REGRESSION THIS GUARDS. The old chain used `.then(task, task)`, which kept
// the chain alive after a failure for free. A pool must release its slot in a
// `finally` or a throwing render permanently shrinks the pool — four bad renders
// and titling deadlocks for the life of the process, with no error and no
// alert. C1/C2 exist for that and nothing else.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let checks = 0;
const results = [];
const ok = async (label, fn) => {
  try { await fn(); checks += 1; results.push(null); }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyTitlingQueueParallel\n');

// WATCHDOG — this suite can be killed by the very bug it hunts, and without
// this it would report success while doing so.
//
// The failure being tested is a leaked pool slot. Leak all of them and every
// later enqueue() waits forever. Node then finds an empty event loop, exits 0,
// and prints nothing — so `node script.js || echo FAIL` counts a DEADLOCK as a
// PASS. Verified: mutating the slot release to skip on throw produced exactly
// that, silent exit 0.
//
// So the suite arms a timer it must clear itself. unref() is deliberately NOT
// used: an unref'd timer would not hold the loop open, which is the whole point.
const WATCHDOG_MS = 30_000;
const watchdog = setTimeout(() => {
  console.error('\n  ❌ WATCHDOG: the suite did not finish within 30s.');
  console.error('     The render pool is almost certainly deadlocked — a task that');
  console.error('     threw did not release its slot, so enqueue() never resolves.');
  console.error('     In production that stops ALL titling for the life of the process.');
  console.log('\n❌ verifyTitlingQueueParallel: DEADLOCKED');
  process.exit(1);
}, WATCHDOG_MS);

// Pin the pool size before requiring the module — it reads env at load.
process.env.REMOTION_QUEUE_CONCURRENCY = '4';
const svc = require('../services/remotionRenderService');
const { enqueue, renderQueueStats } = svc;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// An instrumented task: records how many are running at its start, so the max
// observed overlap is a real measurement rather than an inference from timing.
function makeProbe(state, ms = 40) {
  return async () => {
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    state.started += 1;
    await sleep(ms);
    state.active -= 1;
    return state.started;
  };
}

(async () => {
  await ok('A1 the pool is exported and reports its configured size', async () => {
    assert.strictEqual(typeof enqueue, 'function', 'enqueue must be exported');
    assert.strictEqual(typeof renderQueueStats, 'function', 'renderQueueStats must be exported');
    assert.strictEqual(renderQueueStats().concurrency, 4,
      'REMOTION_QUEUE_CONCURRENCY must drive the pool size');
  });

  await ok('A2 [THE FIX] tasks actually OVERLAP — the queue is no longer serial', async () => {
    const state = { active: 0, maxActive: 0, started: 0 };
    await Promise.all(Array.from({ length: 8 }, () => enqueue(makeProbe(state))));
    assert.ok(state.maxActive > 1,
      `max overlap was ${state.maxActive} — the queue is still effectively serial, `
      + 'which is the 926s tail this change exists to remove');
    assert.strictEqual(state.started, 8, 'every task must run exactly once');
  });

  await ok('A3 overlap reaches the configured concurrency', async () => {
    const state = { active: 0, maxActive: 0, started: 0 };
    await Promise.all(Array.from({ length: 12 }, () => enqueue(makeProbe(state))));
    assert.strictEqual(state.maxActive, 4,
      `expected the pool to reach 4 concurrent, observed ${state.maxActive}`);
  });

  await ok('B1 the pool NEVER exceeds its limit (this is the memory guard)', async () => {
    // Exceeding it is not a throughput bug, it is an OOM: each slot is a
    // headless Chrome page plus an ffmpeg 1080p encode in the web process, and
    // the documented failure mode is instance replacement stranding a PAID
    // Omni master mid-titling.
    const state = { active: 0, maxActive: 0, started: 0 };
    await Promise.all(Array.from({ length: 40 }, () => enqueue(makeProbe(state, 15))));
    assert.ok(state.maxActive <= 4,
      `pool ran ${state.maxActive} concurrent renders against a limit of 4 — memory guard breached`);
  });

  await ok('C1 [DEADLOCK GUARD] a THROWING task frees its slot', async () => {
    // The old chain got this free via `.then(task, task)`. A pool that releases
    // only on success loses a slot per failure; four failures and titling stops
    // forever, silently.
    const failures = Array.from({ length: 8 }, (_, i) =>
      enqueue(async () => { throw new Error(`render ${i} blew up`); }).catch(e => e));
    await Promise.all(failures);
    assert.strictEqual(renderQueueStats().active, 0,
      `pool leaked ${renderQueueStats().active} slot(s) after failures — titling would deadlock`);

    // And it must still do work afterwards.
    const state = { active: 0, maxActive: 0, started: 0 };
    await Promise.all(Array.from({ length: 8 }, () => enqueue(makeProbe(state))));
    assert.strictEqual(state.started, 8, 'pool stopped accepting work after failures');
    assert.strictEqual(state.maxActive, 4, 'pool shrank after failures');
  });

  await ok('C2 a throwing task rejects ONLY its own promise', async () => {
    const [bad, good] = await Promise.allSettled([
      enqueue(async () => { throw new Error('boom'); }),
      enqueue(async () => 'fine')
    ]);
    assert.strictEqual(bad.status, 'rejected', 'a failed render must reject its caller');
    assert.strictEqual(bad.reason.message, 'boom', 'the original error must survive');
    assert.strictEqual(good.status, 'fulfilled', 'one bad render must not poison a sibling');
    assert.strictEqual(good.value, 'fine', 'resolved value must pass through');
  });

  await ok('C3 the queue drains to empty', async () => {
    const s = renderQueueStats();
    assert.strictEqual(s.active, 0, `${s.active} still active after all work settled`);
    assert.strictEqual(s.waiting, 0, `${s.waiting} still waiting after all work settled`);
  });

  // ── D: config. The two knobs mean different things and confusing them is how
  // the original defect survived so long.
  const ROOT = path.join(__dirname, '..');
  const CONC = require('../services/concurrency');
  const envFile = fs.readFileSync(path.join(ROOT, 'config', 'defaults.env'), 'utf8');

  await ok('D1 VEO_TITLING_CONCURRENCY is 48 (owner-directed)', async () => {
    assert.ok(/^VEO_TITLING_CONCURRENCY=48$/m.test(envFile),
      'config/defaults.env must set VEO_TITLING_CONCURRENCY=48');
  });

  await ok('D2 REMOTION_QUEUE_CONCURRENCY exists and is the smaller, guarded knob', async () => {
    const m = envFile.match(/^REMOTION_QUEUE_CONCURRENCY=(\d+)$/m);
    assert.ok(m, 'config/defaults.env must declare REMOTION_QUEUE_CONCURRENCY');
    const render = Number(m[1]);
    const titling = Number(envFile.match(/^VEO_TITLING_CONCURRENCY=(\d+)$/m)[1]);
    assert.ok(render <= titling,
      'the memory-bound render pool must not exceed the cheap outer permit');
    assert.ok(render <= 16,
      `REMOTION_QUEUE_CONCURRENCY=${render} exceeds the documented ceiling — this is the OOM knob`);
  });

  await ok('D3 the config note no longer claims the permit bounds Remotion renders', async () => {
    // The stale claim is what hid the serial queue for so long: the number said
    // "4 simultaneous renders" and everyone believed it.
    const why = CONC.LIMITS?.VEO_TITLING_CONCURRENCY?.why
      || require('../services/concurrency.js').LIMITS?.VEO_TITLING_CONCURRENCY?.why
      || '';
    if (why) {
      assert.ok(!/^Simultaneous Remotion titling renders/.test(why),
        'VEO_TITLING_CONCURRENCY still documents itself as the render limit — it is not');
    }
    assert.ok(/REMOTION_QUEUE_CONCURRENCY/.test(envFile),
      'defaults.env must point readers at the knob that really guards memory');
  });

  // ── E: the "N ahead" diagnostic must be TRUE.
  // Owner rule: generation indicators are diagnostic, so an inaccurate one is
  // worse than none — it sends the reader looking in the wrong place. When the
  // permit was the narrowest thing in the path, reading its `.waiting` was
  // correct. It is now 48 and bounds only cheap prep, so that same read would
  // report "0 ahead" for an ad genuinely twelfth in the render queue.
  const adsSrc = fs.readFileSync(path.join(ROOT, 'routes', 'ads.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

  await ok('E1 queue depth is NOT read from the titling semaphore', async () => {
    assert.ok(!/veoTitlingSemaphore\.waiting/.test(adsSrc),
      'the permit is wide now — its .waiting is ~always 0 and would report a false "0 ahead"');
  });

  await ok('E2 both titling paths report depth from the render pool', async () => {
    const sites = adsSrc.match(/queued for titling \(\$\{[^}]+\} ahead\)/g) || [];
    assert.strictEqual(sites.length, 2,
      `expected the master + derive-only stage lines, found ${sites.length}`);
    for (const s of sites) {
      assert.ok(/q\.waiting/.test(s),
        `stage line "${s}" does not source its depth from the render pool`);
    }
    const helpers = adsSrc.match(/function titlingQueueDepth\(\)/g) || [];
    assert.strictEqual(helpers.length, 1,
      'titlingQueueDepth must be defined once and shared, not copied per call site');
  });

  await ok('E3 the depth helper reports the pool truthfully under load', async () => {
    // Not a source check: run more work than the pool can take and assert the
    // helper actually observes a backlog. A helper that always returns zero
    // would satisfy E1/E2 and still lie.
    const seen = [];
    const jobs = Array.from({ length: 12 }, () => enqueue(async () => {
      seen.push(renderQueueStats().waiting);
      await sleep(30);
    }));
    await Promise.all(jobs);
    assert.ok(Math.max(...seen) > 0,
      'renderQueueStats().waiting never rose above 0 under a 12-deep load — the number is not real');
    assert.strictEqual(renderQueueStats().waiting, 0, 'backlog must drain to 0');
  });

  clearTimeout(watchdog);
  if (process.exitCode) {
    console.log(`\n❌ verifyTitlingQueueParallel: failures above (${checks} passed)`);
  } else {
    console.log(`\n✅ verifyTitlingQueueParallel: ${checks}/${checks} checks passed`);
  }
})().catch((err) => {
  // An unexpected throw must also be loud. Without this the suite could exit
  // via an unhandled rejection warning and still leave exitCode 0.
  clearTimeout(watchdog);
  console.error(`\n  ❌ unexpected error: ${err && err.stack || err}`);
  console.log('\n❌ verifyTitlingQueueParallel: errored');
  process.exit(1);
});
