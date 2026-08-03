#!/usr/bin/env node
'use strict';
//
// verifyRunFeed — offline guards for the per-run Slack live feed.
//
// No network, no real token, no Mongo. Drives runFeedService via exported
// test seams and a stubbed fetch + in-memory CampaignRun claim store.
//
//   node scripts/verifyRunFeed.js
//
// Assertions that must never regress (paid-render safety):
//   A. Poll-tick stage strings are filtered from the thread ring
//   B. Ring buffer drops OLDEST when full and REPORTS the drop count
//   C. A thrown error inside the feed CANNOT escape to the caller
//      ★ REVERT-PROVE: strip the try/catch on onStage → this harness fails
//   D. Unset channel / token → zero fetches
//   E. Parent-ts claim is single-winner under a simulated race
//   F. HTTP 429 does not sleep
//   G. Structural: adStage hooks the feed; runRenderLoop start/finish;
//      config knobs present; never-awaited on the call sites
//
// Revert-prove recipe for (C):
//   In services/runFeedService.js, temporarily replace onStage's body with
//   a bare `_onStage` that throws (or set the outer try/catch to rethrow).
//   Re-run this script — section C must FAIL. Restore the try/catch.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const feed = require('../services/runFeedService');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected) || actual === expected;
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function checkTrue(label, cond) {
  if (cond) { pass++; return; }
  failures.push(`${label}\n      expected: truthy\n      actual:   ${JSON.stringify(cond)}`);
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

// ── fetch stub ────────────────────────────────────────────────────────────
const origFetch = global.fetch;
let fetchCalls = [];
let fetchImpl = null;
let sleepDetected = false;

function installFetch(impl) {
  fetchCalls = [];
  sleepDetected = false;
  fetchImpl = impl;
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), opts, at: Date.now() });
    return fetchImpl(url, opts);
  };
}

function restoreFetch() {
  global.fetch = origFetch;
  fetchImpl = null;
  fetchCalls = [];
}

function jsonRes(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) || null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

// Token assembled so a token-shaped literal does not trip secret scanners.
const CFG = {
  SLACK_BOT_TOKEN: ['xoxb', 'test', 'token', 'RUNFEED', 'ONLY'].join('-'),
  SLACK_ALERT_CHANNEL_STATUS: 'C_STATUS_VERIFY',
  RUN_FEED_ENABLED: 'true',
  RUN_FEED_PARENT_THROTTLE_MS: '1000',
  RUN_FEED_THREAD_FLUSH_MS: '500',
  RUN_FEED_RING_SIZE: '8',
  RUN_FEED_SEND_TIMEOUT_MS: '2000',
  ALERT_ENV_LABEL: 'test',
  ALERT_ROLE: 'verify'
};

// ── In-memory CampaignRun claim store (mirrors atomic updateOne semantics) ─
function makeClaimStore() {
  const byRunId = new Map(); // runId → { slackFeed: { ts, channel } | null }
  return {
    seed(runId, slackFeed = null) {
      byRunId.set(String(runId), { runId: String(runId), slackFeed });
    },
    async updateOne(filter, update) {
      const rid = String(filter.runId);
      let doc = byRunId.get(rid);
      if (!doc) {
        doc = { runId: rid, slackFeed: null };
        byRunId.set(rid, doc);
      }
      // Evaluate $or of slackFeed.ts unset conditions
      const ts = doc.slackFeed && doc.slackFeed.ts;
      const unset = ts == null || ts === '';
      if (!unset) return { modifiedCount: 0 };

      // Also honour explicit $or if present (always true when unset)
      if (update.$set && update.$set.slackFeed) {
        doc.slackFeed = {
          ts: update.$set.slackFeed.ts,
          channel: update.$set.slackFeed.channel
        };
        return { modifiedCount: 1 };
      }
      return { modifiedCount: 0 };
    },
    async findOne(filter) {
      return byRunId.get(String(filter.runId)) || null;
    },
    get(runId) { return byRunId.get(String(runId)); }
  };
}

function makeCampaignRunFromStore(store) {
  return {
    updateOne: (f, u) => store.updateOne(f, u),
    findOne: (f) => {
      const doc = store.get(f.runId);
      return {
        select() { return this; },
        lean: async () => doc
      };
    }
  };
}

function makeEmptyAd() {
  return {
    aggregate: async () => [],
    find: () => ({
      select() { return this; },
      lean: async () => []
    })
  };
}

async function main() {
  console.log('\nverifyRunFeed\n');

  // ── A. Poll-tick filter ─────────────────────────────────────────────
  console.log('A. poll-tick strings filtered from thread ring');
  {
    checkTrue('A1 isPollTick basic',
      feed.isPollTick('plate generation (meta_feed_1_1) — polling 20s (7)'));
    checkTrue('A2 isPollTick m/s form',
      feed.isPollTick('master video generation (9:16) — polling 4m10s (17)'));
    checkTrue('A3 non-poll not tick',
      !feed.isPollTick('plate generation (meta_feed_1_1)'));
    checkTrue('A4 titling not tick',
      !feed.isPollTick('titling 1:1'));
    checkTrue('A5 done not tick',
      !feed.isPollTick('done'));
    checkTrue('A6 empty not tick', !feed.isPollTick(''));
    checkTrue('A7 structural regex exported', feed._POLL_TICK_RE instanceof RegExp);

    await withEnv(CFG, async () => {
      feed._resetState();
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(makeClaimStore()),
        Ad: makeEmptyAd(),
        fetch: async () => jsonRes(200, { ok: true, ts: '1.0', channel: 'C_STATUS_VERIFY' }),
        now: () => 1_700_000_000_000
      });
      feed.startRun({ runId: 'run_poll', total: 1, adIds: ['ad1'] });
      // Genuine transition → ring
      feed.onStage('ad1', 'static image generation (meta_feed_1_1)');
      // Poll ticks → parent lastStage only
      feed.onStage('ad1', 'plate generation (meta_feed_1_1) — polling 3s (1)');
      feed.onStage('ad1', 'plate generation (meta_feed_1_1) — polling 6s (2)');
      feed.onStage('ad1', 'plate generation (meta_feed_1_1) — polling 9s (3)');
      // Another genuine transition
      feed.onStage('ad1', 'crop + logo composite (meta_feed_1_1)');

      const st = feed._getRunState('run_poll');
      checkTrue('A8 state exists', !!st);
      // ring has: run start + static image + crop  (NOT the 3 poll ticks)
      const stages = st.ring.items.map((e) => e.stage);
      check('A9 ring size excludes polls', stages.length, 3);
      checkTrue('A10 has run start', stages.some((s) => /run start/.test(s)));
      checkTrue('A11 has static image', stages.some((s) => /static image/.test(s)));
      checkTrue('A12 has crop', stages.some((s) => /crop/.test(s)));
      checkTrue('A13 no polling in ring', !stages.some((s) => /polling/.test(s)));
      // Parent still sees latest poll-ish stage (last non-filtered write to lastStageByAd
      // was the crop, which overwrote — and polls DO update lastStageByAd)
      // Re-set a poll as latest:
      feed.onStage('ad1', 'plate generation (meta_feed_1_1) — polling 12s (4)');
      checkTrue('A14 parent lastStage keeps poll progress',
        /polling/.test(st.lastStageByAd.get('ad1') || ''));
      // And that poll did not grow the ring
      check('A15 ring still 3 after more polls', st.ring.size, 3);
    });
  }

  // ── B. Ring buffer drops oldest + reports count ─────────────────────
  console.log('\nB. ring buffer drops oldest and reports drop count');
  {
    const Ring = feed.RingBuffer;
    const rb = new Ring(3);
    rb.push({ n: 1 });
    rb.push({ n: 2 });
    rb.push({ n: 3 });
    check('B1 full size', rb.size, 3);
    check('B2 no drops yet', rb.dropCount, 0);
    rb.push({ n: 4 });
    check('B3 still capacity', rb.size, 3);
    check('B4 one drop', rb.dropCount, 1);
    checkTrue('B5 oldest gone', rb.items[0].n === 2 && rb.items[2].n === 4);
    rb.push({ n: 5 });
    rb.push({ n: 6 });
    check('B6 three drops', rb.dropCount, 3);
    const drained = rb.drain();
    check('B7 drain items length', drained.items.length, 3);
    check('B8 drain reports drops', drained.dropped, 3);
    checkTrue('B9 drain items are newest',
      drained.items.map((x) => x.n).join(',') === '4,5,6');
    check('B10 empty after drain', rb.size, 0);
    check('B11 dropCount reset', rb.dropCount, 0);

    // Through the public API with RING_SIZE=8 (CFG)
    await withEnv({ ...CFG, RUN_FEED_RING_SIZE: '4' }, async () => {
      feed._resetState();
      let now = 1_700_000_000_000;
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(makeClaimStore()),
        Ad: makeEmptyAd(),
        fetch: async () => jsonRes(200, { ok: true, ts: '2.0', channel: 'C_STATUS_VERIFY' }),
        now: () => now
      });
      feed.startRun({ runId: 'run_ring', total: 1, adIds: ['a'] });
      // startRun already pushed 1 event (run start). Push 5 more genuine stages
      // → capacity 4 means drops.
      for (let i = 0; i < 5; i++) {
        now += 1000;
        feed.onStage('a', `phase ${i}`);
      }
      const st = feed._getRunState('run_ring');
      check('B12 ring capped at 4', st.ring.size, 4);
      checkTrue('B13 dropCount > 0', st.ring.dropCount > 0);
      const beforeDrops = st.ring.dropCount;
      // Drain via flush path: post parent + thread; assert drop line in payload
      installFetch(async (url) => {
        if (String(url).includes('chat.postMessage')) {
          return jsonRes(200, { ok: true, ts: '99.1', channel: 'C_STATUS_VERIFY' });
        }
        if (String(url).includes('chat.update')) {
          return jsonRes(200, { ok: true, ts: '99.1', channel: 'C_STATUS_VERIFY' });
        }
        if (String(url).includes('chat.delete')) {
          return jsonRes(200, { ok: true });
        }
        return jsonRes(200, { ok: true });
      });
      feed._setDeps({ fetch: global.fetch });
      // Seed claim store empty so ensureParent posts + claims
      const store = makeClaimStore();
      store.seed('run_ring', null);
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(store),
        Ad: makeEmptyAd(),
        fetch: global.fetch,
        now: () => now
      });
      await feed._flushOnce();
      const threadPosts = fetchCalls.filter((c) =>
        String(c.url).includes('chat.postMessage') &&
        c.opts && c.opts.body && String(c.opts.body).includes('thread_ts')
      );
      checkTrue('B14 threaded post happened', threadPosts.length >= 1);
      const body = threadPosts.map((c) => {
        try { return JSON.parse(c.opts.body); } catch { return {}; }
      }).find((b) => b.thread_ts);
      checkTrue('B15 drop count surfaced in post',
        body && typeof body.text === 'string' &&
        new RegExp(`${beforeDrops} event`).test(body.text));
      restoreFetch();
    });
  }

  // ── C. Thrown error cannot escape to the caller (REVERT-PROVE) ──────
  console.log('\nC. thrown error cannot escape to the caller');
  {
    await withEnv(CFG, async () => {
      feed._resetState();
      feed._setDeps({ forceThrow: true });

      let threw = false;
      try {
        feed.onStage('adX', 'anything');
      } catch {
        threw = true;
      }
      checkTrue('C1 onStage does not throw when internals throw', !threw);

      threw = false;
      try {
        feed.startRun({ runId: 'x', adIds: [] });
      } catch {
        threw = true;
      }
      checkTrue('C2 startRun does not throw when internals throw', !threw);

      threw = false;
      try {
        feed.finishRun({ runId: 'x' });
      } catch {
        threw = true;
      }
      checkTrue('C3 finishRun does not throw when internals throw', !threw);

      threw = false;
      try {
        feed.noteEvent('x', 'y');
      } catch {
        threw = true;
      }
      checkTrue('C4 noteEvent does not throw when internals throw', !threw);

      feed._setDeps({ forceThrow: false });
    });

    // Structural: each public entry has a try/catch backstop.
    const feedSrc = src('services/runFeedService.js');
    // Match function onStage ... try { ... _forceThrow ... } catch
    checkTrue('C5 onStage source has try/catch',
      /function onStage\s*\([^)]*\)\s*\{\s*try\s*\{/.test(feedSrc));
    checkTrue('C6 startRun source has try/catch',
      /function startRun\s*\([^)]*\)\s*\{\s*try\s*\{/.test(feedSrc));
    checkTrue('C7 finishRun source has try/catch',
      /function finishRun\s*\([^)]*\)\s*\{\s*try\s*\{/.test(feedSrc));
    // adStage also wraps the require/call
    const stageSrc = src('services/adStage.js');
    checkTrue('C8 adStage wraps runFeed onStage in try/catch',
      /runFeedService['"]\)\.onStage/.test(stageSrc) &&
      /try\s*\{[\s\S]*?runFeedService[\s\S]*?\}\s*catch/.test(stageSrc));

    // ★ REVERT-PROVE marker: this harness encodes the assertion that a throw
    // inside the feed is swallowed. If you remove the try/catch around the
    // `_forceThrow` check in onStage, C1 fails. Documented at file head.
    checkTrue('C9 revert-prove anchor: forceThrow checked inside try',
      /function onStage[\s\S]*?try\s*\{[\s\S]*?_forceThrow[\s\S]*?\}\s*catch/.test(feedSrc));
  }

  // ── D. Unset channel = zero fetches ─────────────────────────────────
  console.log('\nD. unset channel / token → zero fetches, inert');
  {
    installFetch(async () => jsonRes(200, { ok: true, ts: '1.0' }));

    await withEnv({
      SLACK_BOT_TOKEN: null,
      SLACK_ALERT_CHANNEL_STATUS: null,
      RUN_FEED_ENABLED: 'true'
    }, async () => {
      feed._resetState();
      feed._setDeps({ fetch: global.fetch, now: () => Date.now() });
      checkTrue('D1 not configured without token/channel', !feed.isConfigured());
      feed.startRun({ runId: 'run_off', total: 2, adIds: ['a', 'b'] });
      feed.onStage('a', 'static image generation');
      feed.finishRun({ runId: 'run_off', succeeded: 1, failed: 0, skipped: 0, totalMs: 1000 });
      await feed._flushOnce();
      check('D2 zero fetches when unconfigured', fetchCalls.length, 0);
      check('D3 no run state retained when unconfigured', feed._trackedRunCount(), 0);
    });

    await withEnv({
      SLACK_BOT_TOKEN: CFG.SLACK_BOT_TOKEN,
      SLACK_ALERT_CHANNEL_STATUS: null,
      RUN_FEED_ENABLED: 'true'
    }, async () => {
      feed._resetState();
      feed._setDeps({ fetch: global.fetch });
      feed.startRun({ runId: 'run_nochan', adIds: ['a'] });
      await feed._flushOnce();
      check('D4 zero fetches when channel unset', fetchCalls.length, 0);
    });

    await withEnv({
      ...CFG,
      RUN_FEED_ENABLED: 'false'
    }, async () => {
      feed._resetState();
      feed._setDeps({ fetch: global.fetch });
      feed.startRun({ runId: 'run_disabled', adIds: ['a'] });
      await feed._flushOnce();
      check('D5 zero fetches when RUN_FEED_ENABLED=false', fetchCalls.length, 0);
    });

    restoreFetch();
  }

  // ── E. Parent-ts claim single-winner under race ─────────────────────
  console.log('\nE. parent-ts claim is single-winner under simulated race');
  {
    await withEnv(CFG, async () => {
      const store = makeClaimStore();
      store.seed('run_race', null);
      const CR = makeCampaignRunFromStore(store);

      // Two instances "post" different parent messages, then both claim.
      const claimA = await feed.claimParentTs('run_race', 'C_STATUS_VERIFY', '111.aaa', CR);
      const claimB = await feed.claimParentTs('run_race', 'C_STATUS_VERIFY', '222.bbb', CR);

      checkTrue('E1 first claim wins', claimA.won === true && claimA.ts === '111.aaa');
      checkTrue('E2 second claim loses', claimB.won === false);
      check('E3 loser reads winner ts', claimB.ts, '111.aaa');
      check('E4 store has exactly winner ts', store.get('run_race').slackFeed.ts, '111.aaa');

      // Third claim also loses and reads winner
      const claimC = await feed.claimParentTs('run_race', 'C_STATUS_VERIFY', '333.ccc', CR);
      checkTrue('E5 third also loses', !claimC.won);
      check('E6 third reads winner', claimC.ts, '111.aaa');

      // Structural: claim uses conditional updateOne
      const feedSrc = src('services/runFeedService.js');
      checkTrue('E7 claim filters on slackFeed.ts unset',
        /slackFeed\.ts/.test(feedSrc) && /updateOne/.test(feedSrc));
      checkTrue('E8 lost claim does not keep orphan (chat.delete)',
        /chat\.delete/.test(feedSrc));
      checkTrue('E9 CampaignRun schema has slackFeed',
        /slackFeed/.test(src('models/CampaignRun.js')));
    });
  }

  // ── F. 429 does not sleep ───────────────────────────────────────────
  console.log('\nF. HTTP 429 does not sleep');
  {
    await withEnv(CFG, async () => {
      feed._resetState();
      const store = makeClaimStore();
      store.seed('run_429', null);

      let maxGap = 0;
      let lastAt = 0;
      installFetch(async () => {
        const at = Date.now();
        if (lastAt) maxGap = Math.max(maxGap, at - lastAt);
        lastAt = at;
        // Always 429 — including "Retry-After: 30"
        return jsonRes(429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '30' });
      });

      // Monkey-patch setTimeout to detect multi-second sleeps on the flush path.
      const realSetTimeout = global.setTimeout;
      const longSleeps = [];
      global.setTimeout = function patched(fn, ms, ...rest) {
        if (typeof ms === 'number' && ms >= 1000) {
          // Allow AbortController timeouts (SEND_TIMEOUT) — those are not sleeps
          // for Retry-After. We flag only if something sleeps >= 5000 (Retry-After style).
          if (ms >= 5000) longSleeps.push(ms);
        }
        return realSetTimeout(fn, ms, ...rest);
      };

      try {
        feed._setDeps({
          CampaignRun: makeCampaignRunFromStore(store),
          Ad: makeEmptyAd(),
          fetch: global.fetch,
          now: () => Date.now()
        });
        feed.startRun({ runId: 'run_429', total: 1, adIds: ['a'] });
        feed.onStage('a', 'static image generation (meta_feed_1_1)');

        const t0 = Date.now();
        await feed._flushOnce();
        const elapsed = Date.now() - t0;

        checkTrue('F1 flush returned without multi-second wait', elapsed < 3000);
        checkTrue('F2 no Retry-After-length setTimeout', longSleeps.length === 0);
        checkTrue('F3 at least one fetch attempted', fetchCalls.length >= 1);
        // Structural
        const feedSrc = src('services/runFeedService.js');
        checkTrue('F4 429 path logs Retry-After',
          /Retry-After/.test(feedSrc) && /429/.test(feedSrc));
        checkTrue('F5 429 path does not await sleep',
          !/await\s+new\s+Promise\s*\(\s*\(?\s*r\s*\)?\s*=>\s*setTimeout/.test(feedSrc) &&
          !/await\s+sleep\s*\(/.test(feedSrc));
      } finally {
        global.setTimeout = realSetTimeout;
        restoreFetch();
      }
    });
  }

  // ── G. Structural wiring ────────────────────────────────────────────
  console.log('\nG. structural wiring (adStage, runRenderLoop, config)');
  {
    const stageSrc = src('services/adStage.js');
    const adsSrc = src('routes/ads.js');
    const defEnv = src('config/defaults.env');
    const feedSrc = src('services/runFeedService.js');

    checkTrue('G1 adStage requires runFeedService',
      /require\(['"]\.\/runFeedService['"]\)/.test(stageSrc));
    checkTrue('G2 adStage calls onStage',
      /\.onStage\s*\(/.test(stageSrc));
    checkTrue('G3 routes require runFeedService',
      /require\(['"]\.\.\/services\/runFeedService['"]\)/.test(adsSrc));
    checkTrue('G4 runRenderLoop calls startRun',
      /runFeed\.startRun\s*\(/.test(adsSrc));
    checkTrue('G5 runRenderLoop calls finishRun',
      /runFeed\.finishRun\s*\(/.test(adsSrc));
    // Never awaited on call sites
    checkTrue('G6 no await runFeed. in routes',
      !/await\s+runFeed\./.test(adsSrc));
    checkTrue('G7 no await onStage in adStage',
      !/await\s+.*onStage/.test(stageSrc));
    checkTrue('G8 defaults has RUN_FEED_ENABLED',
      /^RUN_FEED_ENABLED=/m.test(defEnv));
    checkTrue('G9 defaults has PARENT_THROTTLE',
      /^RUN_FEED_PARENT_THROTTLE_MS=/m.test(defEnv));
    checkTrue('G10 defaults has THREAD_FLUSH',
      /^RUN_FEED_THREAD_FLUSH_MS=/m.test(defEnv));
    checkTrue('G11 defaults has RING_SIZE',
      /^RUN_FEED_RING_SIZE=/m.test(defEnv));
    checkTrue('G12 STATUS channel still set',
      /^SLACK_ALERT_CHANNEL_STATUS=C0BMMD5AN84/m.test(defEnv));
    checkTrue('G13 feed uses chat.update',
      /chat\.update/.test(feedSrc));
    checkTrue('G14 feed uses chat.postMessage',
      /chat\.postMessage/.test(feedSrc));
    checkTrue('G15 feed checks body.ok === true',
      /ok\s*!==\s*true|ok\s*===\s*true/.test(feedSrc));
    checkTrue('G16 timer unrefed',
      /timer\.unref/.test(feedSrc));
    checkTrue('G17 ring DROP OLDEST documented/implemented',
      /dropCount|DROP OLDEST|drop.*oldest/i.test(feedSrc));
  }

  // ── H. ok:false on HTTP 200 is a failed send ────────────────────────
  console.log('\nH. Slack ok:false on HTTP 200 is a failed send');
  {
    await withEnv(CFG, async () => {
      feed._resetState();
      const store = makeClaimStore();
      store.seed('run_okfalse', null);
      installFetch(async () => jsonRes(200, { ok: false, error: 'channel_not_found' }));
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(store),
        Ad: makeEmptyAd(),
        fetch: global.fetch,
        now: () => Date.now()
      });
      feed.startRun({ runId: 'run_okfalse', total: 1, adIds: ['a'] });
      await feed._flushOnce();
      // Parent should NOT be claimed — post failed.
      const st = feed._getRunState('run_okfalse');
      checkTrue('H1 no parentTs after ok:false', !st || !st.parentTs);
      checkTrue('H2 store still unclaimed',
        !store.get('run_okfalse')?.slackFeed?.ts);
      restoreFetch();
    });
  }

  // Cleanup
  feed._resetState();
  restoreFetch();

  console.log('');
  if (failures.length) {
    console.error(`FAIL ${failures.length}  (pass ${pass})`);
    for (const f of failures) console.error('  ✗', f);
    process.exit(1);
  }
  console.log(`OK ${pass}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('verifyRunFeed crashed:', err);
  process.exit(2);
});
