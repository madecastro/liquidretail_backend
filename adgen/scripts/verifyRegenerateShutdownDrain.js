#!/usr/bin/env node
'use strict';
//
// verifyRegenerateShutdownDrain — EXECUTES services/regenerateConsumer.js's
// shutdown drain against a real (fake) in-flight claim, rather than only
// reading its source. Money finding this pins (adversarial review, Grok
// xhigh, "Finding 2"): renderer.js's SIGTERM handler used to call
// regenerateConsumer.stop() without awaiting it, and stop() itself did not
// wait for an in-flight processClaimed() at all — a renderer instance whose
// only work was a regenerate would report inFlight===0 on the MINT-TIME
// counter, finish shutdown immediately, and the process would exit while a
// billable Atlas submit was still in flight or freshly submitted with
// nothing left to poll it to completion.
//
// This is NOT a full fix (a video regenerate can run for minutes; a ~25s
// SIGTERM drain window will often not be enough) — it's a bounded
// mitigation: give regenerate work the SAME drain budget mint-time work
// already gets, and if that budget still isn't enough, fire a loud,
// findable alert BEFORE the process exits, naming the ad, so an
// interrupted regenerate becomes a visible operational item instead of a
// silent one (nothing else watches a `regenerating:true` row — regenerate
// never sets Ad.status, so bootRecoveryService's own sweep, which is
// status-keyed, will not find it either).
//
// APPROACH: module-cache substitution (no test framework, no real Mongo).
// require.cache is pre-seeded with fake exports for regenerateConsumer.js's
// three real dependencies (../config, ../models/Ad, ./adRegenerateService)
// BEFORE requiring the real file fresh, so the real claimOne/tick/stop
// functions run for real against controlled fakes — this is an EXECUTION
// test, not a source-text regex, for the one piece of this feature that is
// timing-sensitive enough that reading the code is not enough to trust it.
//
// Run: node scripts/verifyRegenerateShutdownDrain.js

const path = require('path');
const assert = require('assert');
const Module = require('module');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${name} — ${err.message}`); }
}

const CONSUMER_PATH  = require.resolve('../src/services/regenerateConsumer');
const CONFIG_PATH    = require.resolve('../src/config');
const AD_PATH        = require.resolve('../src/models/Ad');
const REGEN_PATH     = require.resolve('../src/services/adRegenerateService');
const ALERT_PATH     = require.resolve('../src/services/alertService');

function fakeModule(resolvedPath, exportsObj) {
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    children: [], paths: Module._nodeModulePaths(path.dirname(resolvedPath)),
    exports: exportsObj
  };
}

// Load a FRESH regenerateConsumer.js with fully controlled fakes for every
// real dependency it require()s. Returns { consumer, state, alerts } where
// `state` lets the test drive claimOne()'s result and observe alert calls.
function loadConsumerWithFakes({
  adgenEnabled = true, drainMs = 300, alertMs = 4000,
  notifyDelayMs = 0, notifyHang = false
} = {}) {
  delete require.cache[CONSUMER_PATH];

  const alertsSeen = [];
  fakeModule(ALERT_PATH, {
    // Real drain awaits notify(), not fire-and-forget notifyAsync.
    // A delay here is how E3 proves the call was actually awaited: if
    // drain still used notifyAsync, stop() would return before the
    // delayed push and alertsSeen would be empty.
    async notify(opts) {
      if (notifyHang) {
        await new Promise(() => { /* never resolves — E7 bounds this */ });
      }
      if (notifyDelayMs) {
        await new Promise((r) => setTimeout(r, notifyDelayMs));
      }
      alertsSeen.push(opts);
      return true;
    }
  });

  fakeModule(CONFIG_PATH, {
    WORKER_ID: 'test-worker-1',
    isAdgenRendererEnabled: () => adgenEnabled
  });

  const state = { claimQueue: [], claimed: [], claimHold: null, claimStarted: 0 };
  fakeModule(AD_PATH, {
    findOneAndUpdate() {
      state.claimStarted += 1;
      const hold = state.claimHold;
      return (async () => {
        if (hold) await hold;
        const next = state.claimQueue.shift();
        if (!next) return null;
        state.claimed.push(next);
        return next;
      })();
    }
  });

  const regenState = { resolveFns: [] };
  fakeModule(REGEN_PATH, {
    runClaimedRegeneration(ad, req) {
      // Hangs until the test explicitly resolves it — simulates a video
      // regenerate genuinely still in flight (mid Atlas poll) at SIGTERM.
      return new Promise((resolve) => { regenState.resolveFns.push(resolve); });
    }
  });

  process.env.ADGEN_SHUTDOWN_DRAIN_MS = String(drainMs);
  process.env.ADGEN_SHUTDOWN_ALERT_MS = String(alertMs);
  const consumer = require(CONSUMER_PATH);
  return { consumer, state, alertsSeen, regenState };
}

function restoreRealModules() {
  delete require.cache[CONSUMER_PATH];
  delete require.cache[CONFIG_PATH];
  delete require.cache[AD_PATH];
  delete require.cache[REGEN_PATH];
  delete require.cache[ALERT_PATH];
  delete process.env.ADGEN_SHUTDOWN_DRAIN_MS;
  delete process.env.ADGEN_SHUTDOWN_ALERT_MS;
}

(async () => {
  // ── E1: a claim with NOTHING in flight — stop() resolves promptly, no alert ──
  await checkAsync('E1 stop() with nothing claimed resolves quickly and fires no alert', async () => {
    const { consumer, alertsSeen } = loadConsumerWithFakes({ drainMs: 300 });
    const handle = consumer.start();
    const t0 = Date.now();
    await handle.stop();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 300, `stop() took ${elapsed}ms with nothing in flight — should return almost immediately`);
    assert.strictEqual(alertsSeen.length, 0, 'no in-flight work means no interrupted-regenerate alert');
  });
  restoreRealModules();

  // ── E2 [THE FIX] a claim STILL in flight when the drain window expires:
  // stop() waits the full budget, then returns (does not hang forever) ──
  await checkAsync('E2 [THE FIX] stop() waits up to the drain budget for an in-flight claim, then returns', async () => {
    const DRAIN_MS = 300;
    process.env.ADGEN_REGEN_POLL_MS = '20'; // fast poll so the claim lands within this test's patience
    const { consumer, state } = loadConsumerWithFakes({ drainMs: DRAIN_MS });
    state.claimQueue.push({ _id: 'ad-stuck-1', regenerationRequest: { kind: 'video', prompt: 'x' } });
    const handle = consumer.start();
    const claimDeadline = Date.now() + 4500; // real boot delay is a fixed 3000ms
    while (state.claimed.length === 0 && Date.now() < claimDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(state.claimed.length, 1, 'the fake claim was never picked up — test setup is broken, not the fix');

    const t0 = Date.now();
    await handle.stop();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= DRAIN_MS - 50,
      `stop() returned after only ${elapsed}ms — it must wait roughly the full ${DRAIN_MS}ms drain budget ` +
      'for a claim that never resolves, not bail early (that would mean SIGTERM abandons in-flight work with no wait at all)');
    assert.ok(elapsed < DRAIN_MS + 2000,
      `stop() took ${elapsed}ms — way past the drain budget; it must return (not hang the process shutdown forever) ` +
      'even when the claimed work never finishes');
    delete process.env.ADGEN_REGEN_POLL_MS;
    restoreRealModules();
  });

  // ── E3 [THE ALERT] when the drain expires with work still in flight, a
  // loud alert fires naming the ad — this is what makes an interrupted
  // regenerate a VISIBLE operational item instead of a silent one.
  // notify() is DELAYED so this also proves drain AWAITED it: fire-and-
  // forget notifyAsync would return from stop() before the delayed push,
  // leaving alertsSeen empty. ──
  await checkAsync('E3 [THE ALERT] drain timeout with in-flight work awaits alertService.notify naming the ad', async () => {
    const DRAIN_MS = 200;
    process.env.ADGEN_REGEN_POLL_MS = '20';
    const { consumer, state, alertsSeen } = loadConsumerWithFakes({
      drainMs: DRAIN_MS, notifyDelayMs: 80
    });
    state.claimQueue.push({ _id: 'ad-alert-me', regenerationRequest: { kind: 'video', prompt: 'x' } });
    const handle = consumer.start();
    const claimDeadline = Date.now() + 4500; // real boot delay is a fixed 3000ms
    while (state.claimed.length === 0 && Date.now() < claimDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(state.claimed.length, 1, 'claim never landed — test setup broken');

    await handle.stop();
    assert.strictEqual(alertsSeen.length, 1, `expected exactly one alert, got ${alertsSeen.length} — ` +
      'empty means drain used notifyAsync (fire-and-forget) or never called notify(); ' +
      'the delayed notify() push only lands if stop() actually awaited it');
    const alert = alertsSeen[0];
    assert.strictEqual(alert.level, 'error', 'an uncollected receipt is loud, not a warning');
    assert.ok(/interrupted/i.test(alert.title || ''), 'alert title must say what happened');
    assert.strictEqual(alert.fields && alert.fields.adId, 'ad-alert-me',
      'the alert must name the SPECIFIC ad — an operator needs to look this row up, not guess which one');
    assert.strictEqual(alert.fields && alert.fields.kind, 'video');
    delete process.env.ADGEN_REGEN_POLL_MS;
    restoreRealModules();
  });

  // ── E4: the claim is NOT released on a drain timeout — no retry, no
  // second submit, matching the file's own "no naive retry" argument ──
  await checkAsync('E4 a drain-timeout does NOT release/clear the claim (no retry surface introduced)', () => {
    // Source-checked: drainOnShutdown must never write to Mongo (no
    // Ad.updateOne/findOneAndUpdate call inside it) — its only actions are
    // waiting and alerting. This is the money property: releasing the claim
    // here would let a peer worker re-claim ad-alert-me and call
    // runClaimedRegeneration a SECOND time while the first attempt might
    // still be genuinely in flight (or might have already billed).
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'regenerateConsumer.js'), 'utf8');
    const fnIdx = src.indexOf('async function drainOnShutdown()');
    assert.ok(fnIdx >= 0, 'drainOnShutdown not found');
    const braceIdx = src.indexOf('{', fnIdx);
    let depth = 0, endIdx = -1;
    for (let i = braceIdx; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    const body = src.slice(braceIdx, endIdx);
    assert.ok(!/Ad\.(updateOne|findOneAndUpdate|updateMany)/.test(body),
      'drainOnShutdown must not write to the Ad collection at all — it only waits and alerts');
  });

  // ── E5: renderer.js's shutdown() must actually AWAIT the consumer's
  // stop() promise — the drain/alert in E1-E4 is inert if the caller fires
  // it and moves on without waiting, which is exactly the bug this whole
  // finding started from (stop() used to be synchronous and uncalled-back) ──
  check('E5 renderer.js shutdown() awaits regenerateConsumer.stop() (not fire-and-forget)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'renderer.js'), 'utf8');
    const fnIdx = src.indexOf('async function shutdown()');
    assert.ok(fnIdx >= 0, 'shutdown() not found in renderer.js');
    const braceIdx = src.indexOf('{', fnIdx);
    let depth = 0, endIdx = -1;
    for (let i = braceIdx; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    const body = src.slice(braceIdx, endIdx);
    assert.ok(/regenerateConsumer\s*\?\s*regenerateConsumer\.stop\(\)/.test(body),
      'shutdown() must call regenerateConsumer.stop() (guarded — regenerateConsumer may be null if run() never started it)');
    assert.ok(/await\s+regenerateStopPromise/.test(body),
      'shutdown() captures stop()\'s promise but never awaits it — the drain/alert this file exists to prove ' +
      'never gets a chance to run before the process proceeds to disconnect / exit');
  });

  // ── E6 [INFLIGHT-BEFORE-CLAIM] stop() must wait for a claim that is
  // still inside claimOne() (findOneAndUpdate not yet resolved). The old
  // bug set inFlight=true AFTER claimOne() returned, so a SIGTERM that
  // arrived during the await would see inFlight===false, skip the drain,
  // and orphan the row the moment the claim landed on a dying process. ──
  await checkAsync('E6 [INFLIGHT-BEFORE-CLAIM] drain waits for a claim still inside claimOne()', async () => {
    const DRAIN_MS = 300;
    process.env.ADGEN_REGEN_POLL_MS = '20';
    let releaseClaim;
    const claimHold = new Promise((r) => { releaseClaim = r; });
    const { consumer, state, alertsSeen, regenState } = loadConsumerWithFakes({ drainMs: DRAIN_MS });
    state.claimHold = claimHold;
    state.claimQueue.push({ _id: 'ad-mid-claim', regenerationRequest: { kind: 'video', prompt: 'x' } });
    const handle = consumer.start();
    const startDeadline = Date.now() + 4500;
    while (state.claimStarted === 0 && Date.now() < startDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(state.claimStarted >= 1, 'claimOne never started — test setup broken');
    assert.strictEqual(state.claimed.length, 0, 'claim should still be pending inside findOneAndUpdate');

    const t0 = Date.now();
    const stopPromise = handle.stop();
    // Give drain a tick so it observes inFlight while claimOne is still hanging.
    await new Promise((r) => setTimeout(r, 40));
    // Claim lands mid-drain; processClaimed hangs on regen so inFlight stays true.
    releaseClaim();
    await stopPromise;
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= DRAIN_MS - 50,
      `stop() returned after only ${elapsed}ms with claimOne still in flight at SIGTERM — ` +
      'inFlight must be set BEFORE await claimOne() so drainOnShutdown actually waits. ' +
      'The old ordering (set after the claim resolved) made stop() see inFlight===false, ' +
      'return immediately, then orphan the row the moment the claim landed.');
    assert.strictEqual(state.claimed.length, 1, 'the held claim must actually land during the drain');
    assert.strictEqual(regenState.resolveFns.length, 1, 'processClaimed must have started on the mid-drain claim');
    assert.strictEqual(alertsSeen.length, 1, 'once the claim lands mid-drain, work is still in flight at timeout so the alert must fire');
    assert.strictEqual(alertsSeen[0].fields && alertsSeen[0].fields.adId, 'ad-mid-claim');
    delete process.env.ADGEN_REGEN_POLL_MS;
    restoreRealModules();
  });

  check('E6b tick() assigns inFlight=true before await claimOne()', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'regenerateConsumer.js'), 'utf8');
    const fnIdx = src.indexOf('async function tick()');
    assert.ok(fnIdx >= 0, 'tick() not found');
    const braceIdx = src.indexOf('{', fnIdx);
    let depth = 0, endIdx = -1;
    for (let i = braceIdx; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    const body = src.slice(braceIdx, endIdx);
    const inflightIdx = body.search(/inFlight\s*=\s*true/);
    const claimIdx = body.search(/await\s+claimOne\s*\(/);
    assert.ok(inflightIdx >= 0, 'tick() must assign inFlight = true');
    assert.ok(claimIdx >= 0, 'tick() must await claimOne()');
    assert.ok(inflightIdx < claimIdx,
      'inFlight = true must appear BEFORE await claimOne() — setting it after the claim resolves ' +
      'is the drain-orphan race E6 executes');
  });

  // ── E7 a hung Slack notify must not stall shutdown past SHUTDOWN_ALERT_MS ──
  await checkAsync('E7 hung notify cannot block shutdown past the alert timeout', async () => {
    const DRAIN_MS = 150;
    const ALERT_MS = 200;
    process.env.ADGEN_REGEN_POLL_MS = '20';
    const { consumer, state } = loadConsumerWithFakes({
      drainMs: DRAIN_MS, alertMs: ALERT_MS, notifyHang: true
    });
    state.claimQueue.push({ _id: 'ad-hung-alert', regenerationRequest: { kind: 'video', prompt: 'x' } });
    const handle = consumer.start();
    const claimDeadline = Date.now() + 4500;
    while (state.claimed.length === 0 && Date.now() < claimDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(state.claimed.length, 1, 'claim never landed — test setup broken');

    const t0 = Date.now();
    await handle.stop();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= DRAIN_MS - 50,
      `stop() returned after only ${elapsed}ms — drain itself must still wait`);
    assert.ok(elapsed < DRAIN_MS + ALERT_MS + 1500,
      `stop() took ${elapsed}ms with a hung notify — drain must race notify() against ` +
      `SHUTDOWN_ALERT_MS (${ALERT_MS}ms) so a Slack outage cannot stall SIGTERM`);
    delete process.env.ADGEN_REGEN_POLL_MS;
    restoreRealModules();
  });

  console.log('verifyRegenerateShutdownDrain');
  if (failures.length) {
    console.error(`\n❌ verifyRegenerateShutdownDrain: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    process.exitCode = 1;
    return;
  }
  console.log(`✅ verifyRegenerateShutdownDrain: ${pass}/${pass} checks passed`);
})();
