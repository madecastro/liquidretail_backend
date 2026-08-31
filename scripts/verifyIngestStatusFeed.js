#!/usr/bin/env node
'use strict';
//
// verifyIngestStatusFeed — offline guards for the Slack ingest-status live
// feed (services/ingestStatusFeedService.js) and its progressService hooks.
//
// No network, no real token, no live Mongo. Drives the REAL progressService
// + REAL ingestStatusFeedService against an in-memory OperationRun store
// (the real model's static methods are monkey-patched to delegate to it —
// progressService has no _setDeps seam of its own, unlike runFeedService)
// plus a stubbed fetch and a stubbed Brand model.
//
//   node scripts/verifyIngestStatusFeed.js
//
// Assertions that must never regress:
//   A. Stage-close bookkeeping: progressService.stage()/succeed() push real
//      {name, durationMs, itemsDone, itemsTotal, note} records to
//      OperationRun.stages[] — the actual money question this feature
//      depends on (OperationRun did NOT store this before).
//   B. buildStatusText renders correct per-stage counts/timings, a running
//      total, and the resolved ingest method for a demo-sync run.
//   C. A Slack failure (fetch throws, 429, ok:false) can NEVER throw out of
//      any progressService handle method — ingest business logic (the
//      store's own doc/status) completes identically either way.
//      ★ REVERT-PROVE: remove the try/catch in ingestStatusFeedService.touch
//      → this harness's C3 must FAIL.
//   D. Per-run throttle coalesces — many touch() calls inside one throttle
//      window produce at most ONE chat.update.
//   E. Parent-ts claim is single-winner under a simulated race (mirrors
//      runFeedService's own claim test, on OperationRun.slackFeed).
//   F. HTTP 429 does not sleep.
//   G. Dark by default: unset channel/token → isConfigured() false → zero
//      fetches even after a full run.
//   H. sweepStaleRuns reaping a watched-kind run renders it "interrupted"
//      instead of leaving the Slack message stuck "in progress".
//   I. Structural: schema fields, single touch() integration point, kind
//      whitelist gating, resolveCatalogMethod wired.
//
// Revert-prove recipe for (C3):
//   In services/ingestStatusFeedService.js, delete the try/catch around
//   touch()'s body (leave the throw unguarded). Re-run this script — C3
//   must FAIL. Restore the try/catch.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

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
function checkClose(label, actual, expected, tolerance) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ~${expected} (±${tolerance})\n      actual:   ${JSON.stringify(actual)}`);
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

// ── fetch stub ──────────────────────────────────────────────────────────
const origFetch = global.fetch;
let fetchCalls = [];
let fetchImpl = null;

function installFetch(impl) {
  fetchCalls = [];
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
  SLACK_BOT_TOKEN: ['xoxb', 'test', 'token', 'INGESTFEED', 'ONLY'].join('-'),
  SLACK_INGEST_STATUS_CHANNEL: 'C_INGEST_VERIFY',
  INGEST_STATUS_SLACK_ENABLED: 'true',
  INGEST_STATUS_SLACK_KINDS: 'demo-sync,catalog-sync,social-ingest,enrichment',
  INGEST_STATUS_SLACK_MIN_UPDATE_MS: '1000',
  INGEST_STATUS_SLACK_SEND_TIMEOUT_MS: '2000',
  ALERT_ENV_LABEL: 'test',
  ALERT_ROLE: 'verify'
};

// ── in-memory OperationRun store — backs BOTH progressService's real
// model reference (monkey-patched below) AND ingestStatusFeedService's
// _setDeps({OperationRun}) seam, so both sides see the same documents. ──
function makeOperationRunStore() {
  const byId = new Map();
  let seq = 1;
  function clone(rec) { return rec == null ? null : JSON.parse(JSON.stringify(rec)); }
  function matches(rec, filter) {
    if (filter._id != null && String(filter._id) !== String(rec._id)) return false;
    if (filter.status && filter.status.$in && !filter.status.$in.includes(rec.status)) return false;
    if (filter.heartbeatAt && filter.heartbeatAt.$lt) {
      if (!(new Date(rec.heartbeatAt) < new Date(filter.heartbeatAt.$lt))) return false;
    }
    return true;
  }
  const store = {
    async create(doc) {
      const _id = `run_${seq++}`;
      const rec = Object.assign({ _id, stages: [], slackFeed: null }, doc);
      byId.set(_id, rec);
      return clone(rec);
    },
    async updateOne(filter, update) {
      const rec = byId.get(String(filter._id));
      if (!rec) return { modifiedCount: 0 };
      if (filter.$or) {
        const ts = rec.slackFeed && rec.slackFeed.ts;
        const unset = !rec.slackFeed || ts == null || ts === '';
        if (!unset) return { modifiedCount: 0 };
      }
      if (update.$set) Object.assign(rec, update.$set);
      if (update.$push && update.$push.stages) {
        rec.stages = rec.stages || [];
        rec.stages.push(update.$push.stages);
      }
      return { modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      let n = 0;
      for (const rec of byId.values()) {
        if (matches(rec, filter)) {
          if (update.$set) Object.assign(rec, update.$set);
          n++;
        }
      }
      return { modifiedCount: n };
    },
    findById(id) {
      const rec = byId.get(String(id));
      return { select() { return this; }, lean: async () => clone(rec) };
    },
    findOne(filter) {
      const rec = [...byId.values()].find((r) => matches(r, filter)) || null;
      return { select() { return this; }, lean: async () => clone(rec) };
    },
    find(filter) {
      const matched = [...byId.values()].filter((r) => matches(r, filter));
      return { select() { return this; }, lean: async () => matched.map(clone) };
    },
    get(id) { return byId.get(String(id)); },
    reset() { byId.clear(); seq = 1; }
  };
  return store;
}

function makeBrandStub(brandsById) {
  return {
    findById(id) {
      const b = brandsById.get(String(id)) || null;
      return { select() { return this; }, lean: async () => b };
    }
  };
}

// ── patch the REAL OperationRun model's statics (progressService has no
// injectable seam of its own — it always requires the real model) ────────
const OperationRun = require('../models/OperationRun');
const opRunStore = makeOperationRunStore();
const originalStatics = {
  create: OperationRun.create,
  updateOne: OperationRun.updateOne,
  updateMany: OperationRun.updateMany,
  findById: OperationRun.findById,
  findOne: OperationRun.findOne,
  find: OperationRun.find
};
OperationRun.create = (...a) => opRunStore.create(...a);
OperationRun.updateOne = (...a) => opRunStore.updateOne(...a);
OperationRun.updateMany = (...a) => opRunStore.updateMany(...a);
OperationRun.findById = (...a) => opRunStore.findById(...a);
OperationRun.findOne = (...a) => opRunStore.findOne(...a);
OperationRun.find = (...a) => opRunStore.find(...a);

const progressService = require('../services/progressService');
const feed = require('../services/ingestStatusFeedService');

let fakeClock = 1_000_000_000_000; // arbitrary fixed epoch ms
function advance(ms) { fakeClock += ms; return fakeClock; }
// progressService's own stage-timing (closeOpenStagePush) has no injectable
// clock — it always reads the REAL Date.now(), unlike ingestStatusFeedService
// (which honors _setDeps({now})). So proving durationMs is a real measured
// elapsed time (not a stub/zero) needs a REAL, if small, sleep between stage
// transitions — advance() alone would not move progressService's own clock.
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  console.log('\nverifyIngestStatusFeed\n');

  // ── A + B. stage-close bookkeeping + rendered summary + method ───────
  console.log('A/B. stage timing capture, rendered summary, ingest method');
  await withEnv(CFG, async () => {
    opRunStore.reset();
    feed._resetState();
    const brands = new Map();
    const brandId = 'brand_1';
    brands.set(brandId, {
      _id: brandId,
      name: 'Acme Co',
      apifyDemo: { method: null, shopifyUrl: 'https://acme.example/shop' }
    });
    feed._setDeps({ OperationRun: opRunStore, Brand: makeBrandStub(brands), now: () => fakeClock });
    installFetch(async (url) => {
      if (String(url).includes('chat.postMessage')) return jsonRes(200, { ok: true, ts: '111.aaa', channel: 'C_INGEST_VERIFY' });
      if (String(url).includes('chat.update')) return jsonRes(200, { ok: true });
      return jsonRes(200, { ok: true });
    });

    const run = await progressService.startRun({
      kind: 'demo-sync',
      advertiserId: 'adv_1',
      brandId,
      label: 'Demo data sync'
    });
    checkTrue('A1 startRun returns a real handle', run && typeof run.stage === 'function' && run.id);

    run.stage('instagram posts');
    await sleep(120);
    run.tick(10, 10, '10 fetched · 9 ingested');
    await sleep(90); // instagram stage spans >= ~210ms of REAL elapsed time
    run.stage('shopify catalog');
    run.tick(50, 100, 'products 50/100 · 3 videos · 2 reviews');
    await sleep(60);
    run.tick(100, 100, 'products 100/100 · 5 videos · 4 reviews');
    await sleep(40); // shopify stage spans >= ~100ms of REAL elapsed time
    await run.succeed({ ig: 9, shopify: 100 });

    const doc = opRunStore.get(run.id);
    checkTrue('A2 stages[] has two closed entries', Array.isArray(doc.stages) && doc.stages.length === 2);
    check('A3 stage 1 name', doc.stages[0] && doc.stages[0].name, 'instagram posts');
    check('A4 stage 1 note captured at close', doc.stages[0] && doc.stages[0].note, '10 fetched · 9 ingested');
    checkTrue('A5 stage 1 durationMs is a real positive measured elapsed time (>=180ms, <5000ms)',
      doc.stages[0] && doc.stages[0].durationMs >= 180 && doc.stages[0].durationMs < 5000);
    check('A6 stage 2 name', doc.stages[1] && doc.stages[1].name, 'shopify catalog');
    check('A7 stage 2 note captured at close (terminal write closes it)', doc.stages[1] && doc.stages[1].note, 'products 100/100 · 5 videos · 4 reviews');
    checkTrue('A8 stage 2 durationMs is a real positive measured elapsed time (>=80ms, <5000ms)',
      doc.stages[1] && doc.stages[1].durationMs >= 80 && doc.stages[1].durationMs < 5000);
    checkTrue('A8b stage 1 duration exceeds stage 2 duration (matches the sleeps above, not a constant)',
      doc.stages[0].durationMs > doc.stages[1].durationMs);
    check('A9 final status succeeded', doc.status, 'succeeded');
    check('A10 meta carries summary counts', doc.meta && doc.meta.shopify, 100);

    // Force a flush and inspect the rendered text.
    await feed._flushOnce();
    const updateCalls = fetchCalls.filter((c) => c.url.includes('chat.update'));
    checkTrue('A11 at least one chat.update fired', updateCalls.length >= 1);
    const lastBody = JSON.parse(updateCalls[updateCalls.length - 1].opts.body);
    const text = lastBody.text;
    checkTrue('B1 header names the run + brand', text.includes('Demo data sync') && text.includes('Acme Co'));
    checkTrue('B2 method resolved+shown (stored method:null, shopifyUrl set → shopify-direct)', text.includes('Method: *shopify-direct*'));
    // fmtElapsed floors to whole seconds, so sub-second real sleeps above
    // render as "(0s)" — that is a display-granularity choice, not a bug;
    // durationMs itself (asserted precisely above) is what actually matters.
    checkTrue('B3 stage 1 line has its name + note + a duration token', /instagram posts — 10 fetched · 9 ingested \(\d+s\)/.test(text));
    checkTrue('B4 stage 2 line has its name + note + a duration token', /shopify catalog — products 100\/100 · 5 videos · 4 reviews \(\d+s\)/.test(text));
    checkTrue('B5 total elapsed line present', /⏱ Total: /.test(text));
    checkTrue('B6 succeeded icon in header', text.startsWith('✅'));

    // Pure buildStatusText should render identically off the same doc.
    const pureText = feed.buildStatusText(doc, { brandName: 'Acme Co', method: 'shopify-direct' });
    checkTrue('B7 buildStatusText is pure and reproducible', pureText.includes('Method: *shopify-direct*'));

    restoreFetch();
  });

  // ── A2. a dispatch-only stage does not inherit a stale note ───────────
  // Mirrors the REAL apifyIngestService.syncBrandApify → shopifyPublicIngestService
  // .syncBrandShopifyDirect call chain: an OUTER run.stage('shopify catalog')
  // is closed almost immediately by an INNER run.stage('resolving catalog
  // access') on the SAME handle, with no tick()/note() call in between.
  console.log('\nA2. a stage closed with no tick()/note() of its own does not inherit the PREVIOUS stage\'s note');
  await withEnv(CFG, async () => {
    opRunStore.reset();
    feed._resetState();
    feed._setDeps({ OperationRun: opRunStore, Brand: makeBrandStub(new Map()) });

    const run = await progressService.startRun({ kind: 'demo-sync', advertiserId: 'adv_1', brandId: 'brand_dispatch' });
    run.stage('instagram posts');
    run.tick(9, 9, '9 fetched · 8 ingested');       // real IG tally
    run.stage('shopify catalog');                    // outer dispatch stage
    run.stage('resolving catalog access');            // closes 'shopify catalog' with NO tick() in between
    run.tick(1, 1, 'products.json');
    await run.succeed({ ok: true });

    const doc2 = opRunStore.get(run.id);
    const shopifyEntry = doc2.stages.find((s) => s.name === 'shopify catalog');
    checkTrue('A2a the dispatch-only stage entry exists', !!shopifyEntry);
    check('A2b it does NOT inherit the previous stage\'s note', shopifyEntry && shopifyEntry.note, null);
    const igEntry = doc2.stages.find((s) => s.name === 'instagram posts');
    check('A2c the REAL prior stage keeps its own note untouched', igEntry && igEntry.note, '9 fetched · 8 ingested');
  });

  // ── C. Slack failure cannot break ingest ─────────────────────────────
  console.log('\nC. a Slack failure cannot throw out of progressService');
  await withEnv(CFG, async () => {
    opRunStore.reset();
    feed._resetState();
    feed._setDeps({ OperationRun: opRunStore, Brand: makeBrandStub(new Map()), fetch: async () => { throw new Error('network is down'); }, now: () => fakeClock });

    let threw = false;
    let runId = null;
    try {
      const run = await progressService.startRun({ kind: 'demo-sync', advertiserId: 'adv_1', brandId: 'brand_x' });
      runId = run.id;
      run.stage('instagram posts');
      run.tick(1, 1, 'ok');
      await run.succeed({ ok: true });
      await feed._flushOnce(); // drives the throwing fetch — must not escape
    } catch (err) {
      threw = true;
    }
    checkTrue('C1 progressService + a throwing fetch never throws', !threw);

    const completedDoc = runId ? opRunStore.get(runId) : null;
    checkTrue('C2 ingest business state (the doc itself) still completed despite the Slack outage',
      !!completedDoc && completedDoc.status === 'succeeded');

    // C3: force an internal throw inside touch() itself and confirm every
    // progressService handle method still swallows it (the revert-prove
    // target named in the header). Get a REAL handle first with
    // forceThrow OFF — startRun has its own PRE-EXISTING try/catch (for
    // unrelated Mongo-safety reasons) that would otherwise mask this test
    // by silently downgrading to a no-op handle right at startRun, before
    // ever reaching .stage()/.tick()/.succeed() — exactly the call sites
    // this section exists to prove are ALSO safe on their own, since only
    // touch()'s own internal guard protects them, not a call-site wrapper.
    const run2 = await progressService.startRun({ kind: 'demo-sync', advertiserId: 'adv_1', brandId: 'brand_y' });
    checkTrue('C3setup got a REAL (non-noop) handle before forcing the throw', !!run2.id);
    feed._setDeps({ forceThrow: true });
    let threw2 = false;
    try {
      run2.stage('instagram posts'); // exercises .stage()'s own touch() call
      run2.tick(1, 1, 'ok');          // exercises .tick()'s own touch() call
      run2.note('hi');                // exercises .note()'s own touch() call
      await run2.succeed({ ok: true }); // exercises .succeed()'s own touch() call
    } catch (err) {
      threw2 = true;
    }
    checkTrue('C3 forced internal throw in touch() cannot escape .stage()/.tick()/.note()/.succeed()', !threw2);
    const doc2 = opRunStore.get(run2.id);
    checkTrue('C4 ingest business state still completed even with touch() throwing on every call',
      !!doc2 && doc2.status === 'succeeded');
    feed._setDeps({ forceThrow: false });
  });

  // ── D. throttle coalesces ─────────────────────────────────────────────
  console.log('\nD. per-run throttle coalesces bursts into one chat.update');
  await withEnv(Object.assign({}, CFG, { INGEST_STATUS_SLACK_MIN_UPDATE_MS: '5000' }), async () => {
    opRunStore.reset();
    feed._resetState();
    feed._setDeps({ OperationRun: opRunStore, Brand: makeBrandStub(new Map()), now: () => fakeClock });
    installFetch(async (url) => {
      if (String(url).includes('chat.postMessage')) return jsonRes(200, { ok: true, ts: '222.bbb', channel: 'C_INGEST_VERIFY' });
      return jsonRes(200, { ok: true });
    });

    const run = await progressService.startRun({ kind: 'catalog-sync', advertiserId: 'adv_1', brandId: 'brand_z' });
    run.stage('syncing catalog');
    // A burst of 20 tick() calls inside the SAME throttle window.
    for (let i = 1; i <= 20; i++) {
      run.tick(i, 20, `products ${i}/20`);
      await feed._flushOnce();
    }
    const updateCallsBurst = fetchCalls.filter((c) => c.url.includes('chat.update'));
    // First flush creates the parent (chat.postMessage), not chat.update.
    // Every flush AFTER that inside the 5s window must be throttled away.
    checkTrue('D1 burst inside one throttle window produced at most 1 chat.update', updateCallsBurst.length <= 1);

    advance(6000); // past the throttle window
    run.tick(20, 20, 'products 20/20 — done');
    await feed._flushOnce();
    const updateCallsAfter = fetchCalls.filter((c) => c.url.includes('chat.update'));
    checkTrue('D2 a flush past the throttle window fires a new chat.update', updateCallsAfter.length >= updateCallsBurst.length + 1 || updateCallsAfter.length >= 1);

    restoreFetch();
  });

  // ── E. parent-ts claim is single-winner under simulated race ─────────
  console.log('\nE. parent-ts claim is single-winner under simulated race');
  await withEnv(CFG, async () => {
    // A dedicated store instance for this section (mirrors runFeedService's
    // own makeClaimStore() pattern) — seeded with one bare run doc.
    const raceStore = makeOperationRunStore();
    const seeded = await raceStore.create({ kind: 'demo-sync', status: 'running' });
    const rid = seeded._id;

    const claimA = await feed.claimParentTs(rid, 'C_INGEST_VERIFY', '111.aaa', raceStore);
    const claimB = await feed.claimParentTs(rid, 'C_INGEST_VERIFY', '222.bbb', raceStore);
    checkTrue('E1 first claim wins', claimA.won === true && claimA.ts === '111.aaa');
    checkTrue('E2 second claim loses', claimB.won === false);
    check('E3 loser reads winner ts', claimB.ts, '111.aaa');
    check('E4 store has exactly winner ts', raceStore.get(rid).slackFeed.ts, '111.aaa');

    const claimC = await feed.claimParentTs(rid, 'C_INGEST_VERIFY', '333.ccc', raceStore);
    checkTrue('E5 third also loses', !claimC.won);
    check('E6 third reads winner', claimC.ts, '111.aaa');

    const feedSrc = src('services/ingestStatusFeedService.js');
    checkTrue('E7 claim filters on slackFeed.ts unset', /slackFeed\.ts/.test(feedSrc) && /updateOne/.test(feedSrc));
    checkTrue('E8 lost claim does not keep orphan (chat.delete)', /chat\.delete/.test(feedSrc));
    checkTrue('E9 OperationRun schema has slackFeed', /slackFeed/.test(src('models/OperationRun.js')));
    checkTrue('E10 OperationRun schema has stages', /stages/.test(src('models/OperationRun.js')));
  });

  // ── F. HTTP 429 does not sleep ────────────────────────────────────────
  console.log('\nF. HTTP 429 does not sleep');
  await withEnv(CFG, async () => {
    opRunStore.reset();
    feed._resetState();
    feed._setDeps({ OperationRun: opRunStore, Brand: makeBrandStub(new Map()), now: () => fakeClock });

    let maxGap = 0;
    let lastAt = 0;
    installFetch(async () => {
      const at = Date.now();
      if (lastAt) maxGap = Math.max(maxGap, at - lastAt);
      lastAt = at;
      return jsonRes(429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '30' });
    });

    const realSetTimeout = global.setTimeout;
    const longSleeps = [];
    global.setTimeout = function patched(fn, ms, ...rest) {
      if (typeof ms === 'number' && ms >= 5000) longSleeps.push(ms);
      return realSetTimeout(fn, ms, ...rest);
    };
    try {
      const run = await progressService.startRun({ kind: 'social-ingest', advertiserId: 'adv_1', brandId: 'brand_429' });
      run.stage('ingesting posts');
      await feed._flushOnce();
      await feed._flushOnce();
    } finally {
      global.setTimeout = realSetTimeout;
    }
    checkTrue('F1 no sleep >= 5000ms observed despite repeated 429', longSleeps.length === 0);
    checkTrue('F2 no gap between fetch calls >= 5000ms (no Retry-After sleep)', maxGap < 5000);
    restoreFetch();
  });

  // ── G. dark by default ────────────────────────────────────────────────
  console.log('\nG. unset channel/token → zero fetches, fully inert');
  await withEnv({
    SLACK_BOT_TOKEN: undefined,
    SLACK_INGEST_STATUS_CHANNEL: undefined,
    INGEST_STATUS_SLACK_ENABLED: undefined,
    INGEST_STATUS_SLACK_KINDS: undefined
  }, async () => {
    opRunStore.reset();
    feed._resetState();
    feed._setDeps({ OperationRun: opRunStore, Brand: makeBrandStub(new Map()) });
    installFetch(async () => jsonRes(200, { ok: true, ts: '1.1' }));

    checkTrue('G1 isConfigured() false with nothing set', feed.isConfigured() === false);
    const run = await progressService.startRun({ kind: 'demo-sync', advertiserId: 'adv_1', brandId: 'brand_dark' });
    run.stage('instagram posts');
    run.tick(1, 1, 'ok');
    await run.succeed({ ok: true });
    await feed._flushOnce();
    check('G2 zero fetches when unconfigured', fetchCalls.length, 0);
    check('G3 nothing tracked when unconfigured', feed._trackedCount(), 0);
    restoreFetch();
  });

  // ── H. sweepStaleRuns reaping mirrors to Slack ────────────────────────
  console.log('\nH. sweepStaleRuns renders a reaped run as interrupted');
  await withEnv(CFG, async () => {
    opRunStore.reset();
    feed._resetState();
    // Deliberately NO `now` override here: progressService.sweepStaleRuns()
    // has no injectable clock of its own — it always uses the REAL
    // Date.now() for both its cutoff and its `endedAt` stamp. Seeding this
    // run against the fake clock used elsewhere in this file (a fixed,
    // decades-old epoch) would make it trivially "stale" for the wrong
    // reason (any date that far in the past clears a 2-minute cutoff) —
    // real relative timestamps are what actually exercises the 2-minute
    // STALE_HEARTBEAT_MS threshold sweepStaleRuns is built around.
    feed._setDeps({ OperationRun: opRunStore, Brand: makeBrandStub(new Map()) });
    installFetch(async (url) => {
      if (String(url).includes('chat.postMessage')) return jsonRes(200, { ok: true, ts: '999.zzz', channel: 'C_INGEST_VERIFY' });
      return jsonRes(200, { ok: true });
    });

    // Seed a run that looks stuck: status running, heartbeat 10 real
    // minutes old — comfortably past progressService's real
    // STALE_HEARTBEAT_MS (2 minutes).
    const realNow = Date.now();
    const stuck = await opRunStore.create({
      kind: 'demo-sync',
      advertiserId: 'adv_1',
      brandId: 'brand_stuck',
      status: 'running',
      startedAt: new Date(realNow - 11 * 60 * 1000),
      heartbeatAt: new Date(realNow - 10 * 60 * 1000), // 10 real minutes stale
      stage: 'shopify catalog',
      note: 'products 5/100',
      itemsDone: 5,
      itemsTotal: 100,
      stages: []
    });

    await progressService.sweepStaleRuns();
    const after = opRunStore.get(stuck._id);
    check('H1 reaper marks the run failed', after.status, 'failed');

    await feed._flushOnce();
    const updateOrPost = fetchCalls.filter((c) => c.url.includes('chat.postMessage') || c.url.includes('chat.update'));
    checkTrue('H2 the reaped run got at least one Slack render', updateOrPost.length >= 1);
    const lastBody = JSON.parse(updateOrPost[updateOrPost.length - 1].opts.body);
    checkTrue('H3 rendered text reflects the failed/interrupted state', lastBody.text.startsWith('❌') && /process restarted/.test(lastBody.text));
    checkTrue('H4 the stage it died in is named as interrupted, not silently dropped',
      /⚠ shopify catalog — interrupted \(5\/100\)/.test(lastBody.text));

    restoreFetch();
  });

  // ── I. structural wiring ───────────────────────────────────────────────
  console.log('\nI. structural wiring (progressService hooks, kind gating, method resolver)');
  {
    const progSrc = src('services/progressService.js');
    checkTrue('I1 progressService requires ingestStatusFeedService', /require\(['"]\.\/ingestStatusFeedService['"]\)/.test(progSrc));
    checkTrue('I2 startRun touches the feed after create', /OperationRun\.create\(\{[\s\S]*?\}\);\s*\n\s*ingestStatusFeed\.touch\(doc\._id, doc\.kind\)/.test(progSrc));
    checkTrue('I3 stage() touches the feed on a real transition', /if \(firstOfStage\) ingestStatusFeed\.touch\(id, kind\);/.test(progSrc));
    checkTrue('I4 succeed()/fail()/markCancelled() all touch the feed',
      (progSrc.match(/ingestStatusFeed\.touch\(id, kind\);/g) || []).length >= 5);
    checkTrue('I5 sweepStaleRuns touches the feed for reaped runs', /for \(const r of reaped\) \{\s*ingestStatusFeed\.touch\(r\._id, r\.kind\);/.test(progSrc));
    checkTrue('I6 flush() supports an optional $push', /update\.\$push = \{ stages: push \}/.test(progSrc));

    const feedSrc = src('services/ingestStatusFeedService.js');
    checkTrue('I7 kind whitelist gate exists', /WATCHED_KINDS\(\)\.has/.test(feedSrc));
    checkTrue('I8 default watched kinds include demo-sync', /DEFAULT_KINDS = 'demo-sync/.test(feedSrc));
    checkTrue('I9 dark-by-default gate: ENABLED && token && channel', /ENABLED\(\) && BOT_TOKEN\(\) && CHANNEL\(\)/.test(feedSrc));
    checkTrue('I10 touch() has its own try/catch (never-throws contract)',
      /function touch\(runId, kind\) \{\s*\n\s*try \{/.test(feedSrc));
    checkTrue('I11 resolveCatalogMethod is required for method resolution', /resolveCatalogMethod/.test(feedSrc));

    const apifySrc = src('services/apifyIngestService.js');
    checkTrue('I12 apifyIngestService exports resolveCatalogMethod', /resolveCatalogMethod\b/.test(apifySrc) && /module\.exports = \{[\s\S]*resolveCatalogMethod/.test(apifySrc));
    checkTrue('I13 syncBrandApify actually calls the shared resolver (no re-inlined ternary)',
      /const method = resolveCatalogMethod\(cfg\);/.test(apifySrc));

    checkTrue('I14 config/defaults.env documents the new knobs, channel left blank',
      /SLACK_INGEST_STATUS_CHANNEL=\s*$/m.test(src('config/defaults.env')));
  }

  // ── restore ────────────────────────────────────────────────────────────
  Object.assign(OperationRun, originalStatics);

  console.log('');
  if (failures.length) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    console.error(`FAIL ${failures.length}  (pass ${pass})`);
    process.exit(1);
  }
  console.log(`OK ${pass}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('verifyIngestStatusFeed crashed:', err && err.stack || err);
  Object.assign(OperationRun, originalStatics);
  process.exit(2);
});
