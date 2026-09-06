#!/usr/bin/env node
'use strict';
//
// verifyAdgenRunFeedWired — execution + structural pins for the adgen-side
// Slack thread feed. Backend's runFeed.startRun creates ONE parent per
// CampaignRun (CampaignRun.slackFeed: { ts, channel }). Adgen is a different
// Node process, so that in-memory adToRun map is empty here; attachAd READs
// slackFeed and threads replies under the existing ts. A Slack failure
// must never throw into a billed path.
//
//   node scripts/verifyAdgenRunFeedWired.js
//
// WHAT THIS PINS
//   A. formatThreadLine renders `[source]` when present, and is
//      byte-identical to the untagged shape when source is absent.
//   B. attachAd + onStage/noteEvent + flush: events POST as thread replies
//      with thread_ts === CampaignRun.slackFeed.ts (stubbed Slack HTTP).
//   C. two ads on two runs land in TWO different threads.
//   D. missing slackFeed: no new parent is created; attachAd/onStage/flush
//      never throw.
//   E. Slack HTTP throw / forceThrow cannot escape to the caller.
//   F. every required subsystem tag is a real SOURCE constant and shows
//      up in the posted thread text.
//   G. structural: renderer/titler/resume/boot actually CALL attachAd and
//      the listed stages; never `await runFeed.`; noteFeed is try/caught.
//   H. does NOT duplicate the dedicated not-chargeable-retry alert
//      (video-retry-not-chargeable) — that stays on alertService.
//
// Offline: no real Slack token, no Mongo, no network. Drives the REAL
// runFeedService via _setDeps.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const feed = require('../src/services/runFeedService');

let checks = 0;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
    checks += 1;
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
  }
}

const CFG = {
  SLACK_BOT_TOKEN: ['xoxb', 'test', 'token', 'ADGENFEED', 'ONLY'].join('-'),
  SLACK_ALERT_CHANNEL_STATUS: 'C_ADGEN_FEED',
  RUN_FEED_ENABLED: 'true',
  RUN_FEED_PARENT_THROTTLE_MS: '1',
  RUN_FEED_THREAD_FLUSH_MS: '500',
  RUN_FEED_RING_SIZE: '50',
  RUN_FEED_SEND_TIMEOUT_MS: '2000',
  ALERT_ENV_LABEL: 'test',
  ALERT_ROLE: 'verify',
  ADGEN_ROLE: 'renderer'
};

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

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function makeClaimStore() {
  const byRunId = new Map();
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
      const ts = doc.slackFeed && doc.slackFeed.ts;
      const unset = ts == null || ts === '';
      if (!unset) return { modifiedCount: 0 };
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
        lean: async () => doc || null
      };
    }
  };
}

function makeEmptyAd(docsById) {
  const byId = docsById || new Map();
  return {
    aggregate: async () => [],
    find: () => ({
      select() { return this; },
      lean: async () => []
    }),
    findById(id) {
      const doc = byId.get(String(id)) || null;
      const chain = {
        select() { return chain; },
        lean: async () => doc
      };
      return chain;
    }
  };
}

function parseBody(call) {
  try { return JSON.parse(call.opts && call.opts.body ? call.opts.body : '{}'); }
  catch { return {}; }
}

function threadPosts(calls) {
  return calls.filter((c) => {
    if (!String(c.url).includes('chat.postMessage')) return false;
    const b = parseBody(c);
    return !!b.thread_ts;
  });
}

function parentPosts(calls) {
  return calls.filter((c) => {
    if (!String(c.url).includes('chat.postMessage')) return false;
    const b = parseBody(c);
    return !b.thread_ts;
  });
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  // A — formatThreadLine source tag (pure)
  // ═══════════════════════════════════════════════════════════════════════
  await check('A1 no source → untagged line (byte-compatible with historical shape)', () => {
    const line = feed.formatThreadLine({
      t: Date.parse('2026-01-01T03:00:44.000Z'),
      stage: 'static image generation (meta_feed_1_1)',
      adId: 'xx7686',
      meta: { template: 'ai_brand_led', aspectRatio: '1:1' }
    });
    assert.ok(!/\[adgen-/.test(line), `untagged line must not contain a source bracket: ${line}`);
    assert.match(line, /static image generation \(meta_feed_1_1\)/);
    assert.match(line, /ai_brand_led\/1:1/);
    assert.match(line, /ad=…xx7686/);
  });

  await check('A2 source on ev.source is rendered as [tag] before the stage', () => {
    const line = feed.formatThreadLine({
      t: Date.parse('2026-01-01T03:00:44.000Z'),
      stage: 'claimed by renderer-abc',
      adId: 'ad1',
      source: 'adgen-renderer (static)',
      meta: {}
    });
    assert.match(line, /\[adgen-renderer \(static\)\] claimed by renderer-abc/);
  });

  await check('A3 source on meta.source also renders (noteEvent shape)', () => {
    const line = feed.formatThreadLine({
      t: Date.parse('2026-01-01T03:00:44.000Z'),
      stage: 'boot recovery: peeking stuck ad',
      adId: 'ad9',
      meta: { source: 'boot-recovery-sweep' }
    });
    assert.match(line, /\[boot-recovery-sweep\] boot recovery: peeking stuck ad/);
  });

  await check('A4 SOURCE constants match the owner-required subsystem names', () => {
    assert.strictEqual(feed.SOURCE.RENDERER_STATIC, 'adgen-renderer (static)');
    assert.strictEqual(feed.SOURCE.RENDERER_VIDEO, 'adgen-renderer (video)');
    assert.strictEqual(feed.SOURCE.TITLER, 'adgen-titler');
    assert.strictEqual(feed.SOURCE.TITLING_RESUME, 'titling-resume-sweep');
    assert.strictEqual(feed.SOURCE.BOOT_RECOVERY, 'boot-recovery-sweep');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // B — attachAd posts into the EXISTING slackFeed thread
  // ═══════════════════════════════════════════════════════════════════════
  await check('B1 attachAd + onStage flush posts thread_ts = slackFeed.ts with source tag', async () => {
    await withEnv(CFG, async () => {
      feed._resetState();
      const store = makeClaimStore();
      store.seed('run_alpha', { ts: '111.aaa', channel: 'C_ADGEN_FEED' });
      const calls = [];
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(store),
        Ad: makeEmptyAd(),
        fetch: async (url, opts) => {
          calls.push({ url: String(url), opts });
          return jsonRes(200, { ok: true, ts: '999.orphan', channel: 'C_ADGEN_FEED' });
        },
        now: () => Date.parse('2026-01-01T12:00:00.000Z')
      });

      const ad = {
        _id: 'adStatic01',
        campaignRunIds: ['run_alpha'],
        renderRoute: 'html_gen',
        template: 'ai_brand_led',
        aspectRatio: '1:1',
        platformFormat: 'meta_feed_1_1',
        mediaId: 'media7686'
      };
      feed.attachAd(ad, { source: feed.SOURCE.RENDERER_STATIC });
      feed.onStage(ad._id, 'claimed by renderer-test');
      feed.onStage(ad._id, 'layout build');
      feed.onStage(ad._id, 'atlas image ready');
      feed.onStage(ad._id, 'cloudinary upload');
      feed.noteEvent('run_alpha', 'done', { adId: ad._id, source: feed.SOURCE.RENDERER_STATIC });
      await feed._flushOnce();

      const parents = parentPosts(calls);
      assert.strictEqual(parents.length, 0, `must NOT create a new parent (got ${parents.length})`);
      const threads = threadPosts(calls);
      assert.ok(threads.length >= 1, 'expected at least one threaded chat.postMessage');
      const texts = threads.map((c) => parseBody(c).text).join('\n');
      for (const t of threads) {
        const b = parseBody(t);
        assert.strictEqual(b.thread_ts, '111.aaa', `thread_ts must be the existing slackFeed.ts, got ${b.thread_ts}`);
        assert.strictEqual(b.channel, 'C_ADGEN_FEED');
      }
      assert.match(texts, /\[adgen-renderer \(static\)\] claimed by renderer-test/);
      assert.match(texts, /\[adgen-renderer \(static\)\] layout build/);
      assert.match(texts, /\[adgen-renderer \(static\)\] atlas image ready/);
      assert.match(texts, /\[adgen-renderer \(static\)\] cloudinary upload/);
      assert.match(texts, /\[adgen-renderer \(static\)\] done/);
    });
  });

  await check('B2 video source tag lands on a video ad in the same thread', async () => {
    await withEnv(CFG, async () => {
      feed._resetState();
      const store = makeClaimStore();
      store.seed('run_vid', { ts: '222.bbb', channel: 'C_ADGEN_FEED' });
      const calls = [];
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(store),
        Ad: makeEmptyAd(),
        fetch: async (url, opts) => {
          calls.push({ url: String(url), opts });
          return jsonRes(200, { ok: true, ts: 'x', channel: 'C_ADGEN_FEED' });
        },
        now: () => 1_700_000_000_000
      });
      const ad = {
        _id: 'adVideo01',
        campaignRunIds: ['run_vid'],
        renderRoute: 'veo',
        aspectRatio: '9:16',
        platformFormat: 'meta_story_9_16'
      };
      feed.attachAd(ad, { source: feed.SOURCE.RENDERER_VIDEO });
      feed.onStage(ad._id, 'master video ready');
      await feed._flushOnce();
      const threads = threadPosts(calls);
      assert.ok(threads.length >= 1);
      assert.strictEqual(parseBody(threads[0]).thread_ts, '222.bbb');
      const text = threads.map((c) => parseBody(c).text).join('\n');
      assert.match(text, /\[adgen-renderer \(video\)\] master video ready/);
    });
  });

  await check('B3 onStage before attachAd is buffered and still lands', async () => {
    await withEnv(CFG, async () => {
      feed._resetState();
      const store = makeClaimStore();
      store.seed('run_pend', { ts: '333.ccc', channel: 'C_ADGEN_FEED' });
      const calls = [];
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(store),
        Ad: makeEmptyAd(),
        fetch: async (url, opts) => {
          calls.push({ url: String(url), opts });
          return jsonRes(200, { ok: true, ts: 'x', channel: 'C_ADGEN_FEED' });
        },
        now: () => 1_700_000_000_000
      });
      const ad = { _id: 'adPend', campaignRunIds: ['run_pend'], renderRoute: 'html_gen' };
      feed.onStage(ad._id, 'claimed by renderer-test'); // not yet mapped
      feed.attachAd(ad, { source: feed.SOURCE.RENDERER_STATIC });
      await feed._flushOnce();
      const text = threadPosts(calls).map((c) => parseBody(c).text).join('\n');
      assert.match(text, /\[adgen-renderer \(static\)\] claimed by renderer-test/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // C — two runs → two threads
  // ═══════════════════════════════════════════════════════════════════════
  await check('C1 two ads on two runs post to two different thread_ts values', async () => {
    await withEnv(CFG, async () => {
      feed._resetState();
      const store = makeClaimStore();
      store.seed('run_one', { ts: 'ts.one', channel: 'C_ADGEN_FEED' });
      store.seed('run_two', { ts: 'ts.two', channel: 'C_ADGEN_FEED' });
      const calls = [];
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(store),
        Ad: makeEmptyAd(),
        fetch: async (url, opts) => {
          calls.push({ url: String(url), opts });
          return jsonRes(200, { ok: true, ts: 'x', channel: 'C_ADGEN_FEED' });
        },
        now: () => 1_700_000_000_000
      });
      feed.attachAd({ _id: 'a1', campaignRunIds: ['run_one'], renderRoute: 'html_gen' },
        { source: feed.SOURCE.RENDERER_STATIC });
      feed.attachAd({ _id: 'a2', campaignRunIds: ['run_two'], renderRoute: 'veo' },
        { source: feed.SOURCE.RENDERER_VIDEO });
      feed.onStage('a1', 'layout build');
      feed.onStage('a2', 'derive: waiting for sibling master');
      await feed._flushOnce();
      const threads = threadPosts(calls);
      const tsSet = new Set(threads.map((c) => parseBody(c).thread_ts));
      assert.ok(tsSet.has('ts.one'), 'missing thread for run_one');
      assert.ok(tsSet.has('ts.two'), 'missing thread for run_two');
      assert.strictEqual(tsSet.size, 2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // D — missing slackFeed never creates a parent, never throws
  // ═══════════════════════════════════════════════════════════════════════
  await check('D1 missing slackFeed: attachAd + onStage + flush create no parent and do not throw', async () => {
    await withEnv(CFG, async () => {
      feed._resetState();
      const store = makeClaimStore();
      store.seed('run_orphan', null);
      const calls = [];
      let threw = false;
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(store),
        Ad: makeEmptyAd(),
        fetch: async (url, opts) => {
          calls.push({ url: String(url), opts });
          return jsonRes(200, { ok: true, ts: 'should-not-be-used', channel: 'C_ADGEN_FEED' });
        },
        now: () => 1_700_000_000_000
      });
      try {
        feed.attachAd({ _id: 'adOrphan', campaignRunIds: ['run_orphan'], renderRoute: 'html_gen' },
          { source: feed.SOURCE.RENDERER_STATIC });
        feed.onStage('adOrphan', 'layout build');
        await feed._flushOnce();
      } catch (err) {
        threw = true;
        throw err;
      }
      assert.strictEqual(threw, false);
      assert.strictEqual(parentPosts(calls).length, 0, 'must not chat.postMessage a new parent');
      assert.strictEqual(threadPosts(calls).length, 0, 'no thread posts without a parent ts');
      const after = store.get('run_orphan');
      assert.ok(!after.slackFeed || !after.slackFeed.ts, 'must not write slackFeed.ts');
    });
  });

  await check('D2 attachAd with no campaignRunIds is a silent no-op', async () => {
    await withEnv(CFG, async () => {
      feed._resetState();
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(makeClaimStore()),
        Ad: makeEmptyAd(),
        fetch: async () => { throw new Error('fetch must not run'); },
        now: () => 1
      });
      feed.attachAd({ _id: 'adNoRun', renderRoute: 'html_gen' }, { source: 'x' });
      feed.onStage('adNoRun', 'claimed');
      assert.strictEqual(feed._trackedRunCount(), 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E — Slack / internal failures never escape
  // ═══════════════════════════════════════════════════════════════════════
  await check('E1 fetch throw during flush does not escape _flushOnce', async () => {
    await withEnv(CFG, async () => {
      feed._resetState();
      const store = makeClaimStore();
      store.seed('run_boom', { ts: '444.ddd', channel: 'C_ADGEN_FEED' });
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(store),
        Ad: makeEmptyAd(),
        fetch: async () => { throw new Error('slack transport blew up'); },
        now: () => 1_700_000_000_000
      });
      feed.attachAd({ _id: 'adBoom', campaignRunIds: ['run_boom'], renderRoute: 'html_gen' },
        { source: feed.SOURCE.RENDERER_STATIC });
      feed.onStage('adBoom', 'layout build');
      await feed._flushOnce(); // must not throw
    });
  });

  await check('E2 forceThrow cannot escape attachAd / onStage / noteEvent / finishRun', async () => {
    await withEnv(CFG, async () => {
      feed._resetState();
      feed._setDeps({ forceThrow: true });
      feed.attachAd({ _id: 'x', campaignRunIds: ['r'] });
      feed.onStage('x', 'y');
      feed.noteEvent('r', 'z');
      feed.finishRun({ runId: 'r' });
    });
  });

  await check('E3 unconfigured (no token) → zero fetches, no throw', async () => {
    await withEnv({
      ...CFG,
      SLACK_BOT_TOKEN: '',
      SLACK_ALERT_CHANNEL_STATUS: ''
    }, async () => {
      feed._resetState();
      let fetches = 0;
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(makeClaimStore()),
        Ad: makeEmptyAd(),
        fetch: async () => { fetches += 1; return jsonRes(200, { ok: true }); },
        now: () => 1
      });
      feed.attachAd({ _id: 'a', campaignRunIds: ['r'], renderRoute: 'html_gen' },
        { source: feed.SOURCE.RENDERER_STATIC });
      feed.onStage('a', 'claimed');
      await feed._flushOnce();
      assert.strictEqual(fetches, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // F — every subsystem tag in a real flush
  // ═══════════════════════════════════════════════════════════════════════
  await check('F1 all five subsystem tags appear in flushed thread text', async () => {
    await withEnv(CFG, async () => {
      feed._resetState();
      const store = makeClaimStore();
      store.seed('run_all', { ts: '555.eee', channel: 'C_ADGEN_FEED' });
      const calls = [];
      feed._setDeps({
        CampaignRun: makeCampaignRunFromStore(store),
        Ad: makeEmptyAd(),
        fetch: async (url, opts) => {
          calls.push({ url: String(url), opts });
          return jsonRes(200, { ok: true, ts: 'x', channel: 'C_ADGEN_FEED' });
        },
        now: () => 1_700_000_000_000
      });
      const ad = { _id: 'adAll', campaignRunIds: ['run_all'], renderRoute: 'veo' };
      feed.attachAd(ad, { source: feed.SOURCE.RENDERER_VIDEO });
      feed.onStage(ad._id, 'claimed by renderer');
      feed.noteEvent('run_all', 'claimed for titling', {
        adId: ad._id, source: feed.SOURCE.TITLER
      });
      feed.noteEvent('run_all', 'titling resume: claimed stuck ad', {
        adId: ad._id, source: feed.SOURCE.TITLING_RESUME
      });
      feed.noteEvent('run_all', 'boot recovery: peeking stuck ad', {
        adId: ad._id, source: feed.SOURCE.BOOT_RECOVERY
      });
      feed.attachAd({ ...ad, _id: 'adStatic', renderRoute: 'html_gen' },
        { source: feed.SOURCE.RENDERER_STATIC });
      feed.onStage('adStatic', 'layout build');
      await feed._flushOnce();
      const text = threadPosts(calls).map((c) => parseBody(c).text).join('\n');
      assert.match(text, /\[adgen-renderer \(video\)\]/);
      assert.match(text, /\[adgen-renderer \(static\)\]/);
      assert.match(text, /\[adgen-titler\]/);
      assert.match(text, /\[titling-resume-sweep\]/);
      assert.match(text, /\[boot-recovery-sweep\]/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // G — structural wiring
  // ═══════════════════════════════════════════════════════════════════════
  const rendererSrc = src('src/services/renderer.js');
  const titlerSrc = src('src/services/titler.js');
  const resumeSrc = src('src/services/titlingResumeService.js');
  const bootSrc = src('src/services/bootRecoveryService.js');
  const feedSrc = src('src/services/runFeedService.js');
  const qcSrc = src('src/services/adVisionQcService.js');
  const atlasVideoSrc = src('src/services/atlasVideoService.js');

  await check('G1 renderer defines noteFeed/noteFeedEvent and calls attachAd', () => {
    assert.match(rendererSrc, /function noteFeed\(/);
    assert.match(rendererSrc, /function noteFeedEvent\(/);
    assert.match(rendererSrc, /runFeed\.attachAd\(/);
    assert.match(rendererSrc, /adgen-renderer \(static\)/);
    assert.match(rendererSrc, /adgen-renderer \(video\)/);
  });

  await check('G2 renderer processAd claims into the feed', () => {
    const m = rendererSrc.match(/async function processAd\(ad\)\s*\{[\s\S]*?\nasync function poll\(/);
    assert.ok(m, 'processAd body not found');
    assert.match(m[0], /noteFeed\(ad,\s*`claimed by \$\{WORKER_ID\}`\)/);
    assert.match(m[0], /noteFeedEvent\(ad,\s*`failed/);
  });

  await check('G3 renderer static stages: layout, atlas result, cloudinary, skipped, done', () => {
    assert.match(rendererSrc, /noteFeed\(ad,\s*'layout build'\)/);
    assert.match(rendererSrc, /noteFeed\(ad,\s*'atlas image ready'\)/);
    assert.match(rendererSrc, /noteFeed\(ad,\s*'cloudinary upload'\)/);
    assert.match(rendererSrc, /noteFeed\(ad,\s*`failed — skipped/);
    assert.match(rendererSrc, /noteFeedEvent\(ad,\s*'done'\)/);
  });

  await check('G4 renderer video derive + master stages', () => {
    assert.match(rendererSrc, /noteFeed\(ad,\s*'derive: waiting for sibling master'\)/);
    assert.match(rendererSrc, /noteFeed\(ad,\s*'derive: retrying \(sibling master not ready\)'\)/);
    assert.match(rendererSrc, /async function requeueDeriveForRetry[\s\S]*?noteFeed\(ad,\s*'derive: retrying/);
    assert.match(rendererSrc, /noteFeed\(ad,\s*'derive: inherited master'\)/);
    assert.match(rendererSrc, /noteFeed\(ad,\s*'derive: handed off to titler'\)/);
    assert.match(rendererSrc, /noteFeed\(ad,\s*'master video ready'\)/);
    assert.match(rendererSrc, /noteFeed\(ad,\s*'handed off to titler'\)/);
  });

  await check('G5 renderer maybeFinalizeRun calls finishRun in its own try/catch, never awaited', () => {
    const m = rendererSrc.match(/async function maybeFinalizeRun\(runId\)\s*\{[\s\S]*?\n\/\/ Static-path render/);
    assert.ok(m, 'maybeFinalizeRun body not found');
    assert.match(m[0], /runFeedService['"]\)\.finishRun\(/);
    assert.ok(!/await\s+require\(['"]\.\/runFeedService['"]\)/.test(m[0]));
    assert.match(m[0], /try\s*\{[\s\S]*finishRun[\s\S]*\}\s*catch/);
  });

  await check('G6 titler attachAd + claimed / remotion start+done / terminal / failed', () => {
    assert.match(titlerSrc, /runFeed\.attachAd\(/);
    assert.match(titlerSrc, /adgen-titler/);
    assert.match(titlerSrc, /claimed for titling/);
    assert.match(titlerSrc, /titling remotion start/);
    assert.match(titlerSrc, /titling remotion done/);
    assert.match(titlerSrc, /noteFeedEvent\(ad,\s*`failed/);
    assert.match(titlerSrc, /noteFeed\(ad,\s*`claimed by \$\{WORKER_ID\}`\)/);
  });

  await check('G7 titling-resume-sweep is a distinct source and notes claim/start/done/fail', () => {
    assert.match(resumeSrc, /titling-resume-sweep/);
    assert.match(resumeSrc, /titling resume: claimed stuck ad/);
    assert.match(resumeSrc, /titling resume: remotion start/);
    assert.match(resumeSrc, /titling resume: remotion done/);
    assert.match(resumeSrc, /titling resume: done/);
    assert.match(resumeSrc, /titling resume: failed/);
    assert.match(resumeSrc, /runFeed\.attachAd\(/);
  });

  await check('G8 boot-recovery-sweep is a distinct source and notes peek/recovered/failed', () => {
    assert.match(bootSrc, /boot-recovery-sweep/);
    assert.match(bootSrc, /boot recovery: peeking stuck ad/);
    assert.match(bootSrc, /boot recovery: recovered paid master/);
    assert.match(bootSrc, /boot recovery: recovered static/);
    assert.match(bootSrc, /runFeed\.attachAd\(/);
  });

  await check('G9 no `await runFeed.` / `await require(.*runFeedService` in live pipeline files', () => {
    for (const [name, body] of [
      ['renderer.js', rendererSrc],
      ['titler.js', titlerSrc],
      ['titlingResumeService.js', resumeSrc],
      ['bootRecoveryService.js', bootSrc],
      ['adStage.js', src('src/services/adStage.js')]
    ]) {
      assert.ok(!/await\s+runFeed\./.test(body), `${name} awaits runFeed`);
      assert.ok(!/await\s+require\([^)]*runFeedService/.test(body), `${name} awaits a runFeed require`);
    }
  });

  await check('G10 attachAd / onStage / noteEvent each have a try/catch backstop', () => {
    assert.match(feedSrc, /function attachAd\s*\([^)]*\)\s*\{\s*try\s*\{/);
    assert.match(feedSrc, /function onStage\s*\([^)]*\)\s*\{\s*try\s*\{/);
    assert.match(feedSrc, /function noteEvent\s*\([^)]*\)\s*\{\s*try\s*\{/);
    assert.match(feedSrc, /adoptOnly/);
    assert.match(feedSrc, /slackFeed/);
  });

  await check('G11 adStage forwards optional extra (source) to onStage', () => {
    const stageSrc = src('src/services/adStage.js');
    assert.match(stageSrc, /function adStage\(adId, stage, extra\)/);
    assert.match(stageSrc, /onStage\(id, text, extra\)/);
  });

  await check('G12 vision QC still posts via noteEvent (pass + fail)', () => {
    assert.match(qcSrc, /runFeed\.noteEvent\([^,]+,\s*'vision QC pass'/);
    assert.match(qcSrc, /runFeed\.noteEvent\([^,]+,\s*'vision QC fail'/);
  });

  await check('G13 ensureParent never creates a parent when adoptOnly or ADGEN_ROLE is set', () => {
    assert.match(feedSrc, /if \(st\.adoptOnly \|\| isAdgenRole\(\)\)/);
    assert.match(feedSrc, /st\._noParent = true/);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // H — do not duplicate the not-chargeable retry alert
  // ═══════════════════════════════════════════════════════════════════════
  await check('H1 renderer/titler/resume/boot/runFeed do not emit video-retry-not-chargeable', () => {
    for (const [name, body] of [
      ['renderer.js', rendererSrc],
      ['titler.js', titlerSrc],
      ['titlingResumeService.js', resumeSrc],
      ['bootRecoveryService.js', bootSrc],
      ['runFeedService.js', feedSrc]
    ]) {
      assert.ok(!/video-retry-not-chargeable/.test(body), `${name} duplicated the retry alert key`);
      assert.ok(!/buildNotChargeableRetryAlert/.test(body), `${name} duplicated the retry-alert builder`);
    }
  });

  await check('H2 the dedicated retry alert remains on atlasVideoService + alertService', () => {
    assert.match(atlasVideoSrc, /buildNotChargeableRetryAlert/);
    assert.match(atlasVideoSrc, /video-retry-not-chargeable/);
    assert.match(atlasVideoSrc, /alerts\.notifyAsync\(\s*buildNotChargeableRetryAlert\(/);
  });

  await check('H3 renderer noteFeed helpers wrap attachAd in try/catch that does not rethrow', () => {
    const helper = rendererSrc.slice(
      rendererSrc.indexOf('function noteFeed(ad, stage, extra)'),
      rendererSrc.indexOf('function noteFeedEvent')
    );
    assert.match(helper, /try\s*\{/);
    assert.match(helper, /catch \(err\)/);
    assert.ok(!/catch[^{]*\{[^}]*throw/.test(helper), 'noteFeed catch must not rethrow');
  });

  // ── report ────────────────────────────────────────────────────────────
  const total = checks + failures.length;
  if (failures.length) {
    console.error(`\n❌ verifyAdgenRunFeedWired: ${failures.length} of ${total} checks FAILED\n`);
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
    process.exit(1);
  }
  console.log(`✅ verifyAdgenRunFeedWired: ${total}/${total} checks passed`);
}

main().catch((err) => {
  console.error(`verifyAdgenRunFeedWired: harness crashed — ${err.stack || err.message}`);
  process.exit(1);
});
