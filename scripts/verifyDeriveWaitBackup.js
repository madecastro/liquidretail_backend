#!/usr/bin/env node
'use strict';
/**
 * verifyDeriveWaitBackup — behavioural harness for the derive-master wait
 * timeout, owner directive 2026-08-20: "hitting the timeout shouldn't
 * abandon, it should just send a slack explaining the backup."
 *
 * WHY THIS EXISTS. routes/ads.js `renderDeriveOnlyVideoAd` waits in-render
 * for a sibling master's plate (DERIVE_MASTER_WAIT_MS, 12 min). Until this
 * change, a master still `queued`/`rendering` when that wait expired was
 * tolerated silently for MAX_DERIVE_WAIT_ATTEMPTS (30) cycles and then the
 * ad was stamped `status:'failed'` ("refusing Omni fallback") — an ad the
 * owner ordered, permanently abandoned. Raising VEO_CONCURRENCY /
 * REMOTION_QUEUE_CONCURRENCY (config/defaults.env, 2026-08-20) makes masters
 * queue longer behind titling, so that abandonment would fire MORE often —
 * the exact regression this harness exists to prevent.
 *
 * THE FIX, pinned here: the timeout branch was extracted into
 * `handleDeriveMasterBackup` (exported by routes/ads.js). It now, every
 * time:
 *   1. Requeues the ad to 'queued' (unchanged — zero submits, zero bills).
 *   2. RECLAIMS IMMEDIATELY through the SAME atomic claim path stranded ads
 *      use — requeueStrandedAds() -> claimAdsForRun() — never a new one
 *      (CLAUDE.md §2).
 *   3. Fires ONE Slack notice per BACKUP EPISODE via notifyDeriveWaitBackup,
 *      keyed on the MASTER (not the ad), reusing alertService's own
 *      rate-limiting/dedupe rather than a bespoke one.
 * It never again writes `status:'failed'` for a master that is merely still
 * in flight — that branch is gone.
 *
 * Pure + offline: no real Mongo/network. Ad.updateOne / Ad.find /
 * CampaignRun.updateOne are monkey-patched on the real Mongoose Models
 * (same house style as scripts/verifyStrandedSweep.js's `Ad.find = ...`),
 * and Slack delivery is proven against the REAL alertService with a faked
 * global.fetch (same house style as scripts/verifyAdVisionQc.js group L /
 * scripts/verifyDirectorFallbackChain.js) — not a stubbed-away limiter —
 * so the "fires once per episode" claim is proven by the real dedupe, not
 * assumed.
 *   node scripts/verifyDeriveWaitBackup.js
 *
 * Neighbours: scripts/verifyStrandedSweep.js (the sweep this reclaim reuses),
 * scripts/verifyReceiptAwareRequeue.js (the receipt-safety invariant this
 * path must never violate — it never touches a receipted ad; it only ever
 * flips a NOT-YET-SUBMITTED derive-only ad back to 'queued').
 *
 * REVERT-PROOF RECIPE (each mutation must fail the named check):
 *   (a) Reintroduce `if (attempts >= MAX_DERIVE_WAIT_ATTEMPTS) { status:
 *       'failed', ... }` inside handleDeriveMasterBackup (or anywhere it is
 *       reachable from renderDeriveOnlyVideoAd's queued/rendering branch)
 *       -> A2/A2b fail.
 *   (b) Stop calling `requeue({ ads, run })` (or call a different function
 *       than requeueStrandedAds by default) -> B1/B2/B5 fail.
 *   (c) Pass `ads: [adId]` (a bare id) or `ads: []` instead of `[ad]`
 *       -> B3 fails.
 *   (d) Key the Slack alert on the ad instead of the master (e.g.
 *       `derive-wait-backup:${adId}`) -> D2 fails (two different ads on the
 *       SAME master would no longer collapse to one Slack send).
 *   (e) Drop the reapStaleMin()-based staleness check (treat 'rendering' as
 *       never stuck) -> E2 fails.
 *   (f) $inc renderAttempts instead of / in addition to deriveWaitAttempts
 *       here -> A4 fails (queuedArchiveSweeper's renderAttempts:0 guard
 *       would go blind to this ad again — see models/Ad.js).
 *
 * Report the failing output verbatim when proving (a)-(f).
 */

const assert = require('assert');

const adsRoute = require('../routes/ads');
const {
  handleDeriveMasterBackup,
  notifyDeriveWaitBackup,
  requeueStrandedAds
} = adsRoute;
const Ad = require('../models/Ad');
const CampaignRun = require('../models/CampaignRun');
const alerts = require('../services/alertService');

let pass = 0;
const failures = [];
async function checkAsync(label, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

console.log('\nDERIVE-WAIT BACKUP (never abandon)\n');

// ── fixtures ──────────────────────────────────────────────────────────────
function makeAd(over = {}) {
  return {
    _id: 'ad_1', campaignId: 'camp_1', productId: 'prod_1',
    queuedAt: new Date(Date.now() - 5 * 60 * 1000),
    ...over
  };
}
function makeMaster(over = {}) {
  return {
    _id: 'master_1', status: 'rendering', platformFormat: 'pmax_video_9_16',
    updatedAt: new Date(), ...over
  };
}
function makeRun(over = {}) {
  return {
    _id: 'run_doc_1', runId: 'run_123', brandId: 'brand_1',
    campaignId: 'camp_1', campaignKind: 'promotional', ...over
  };
}

// Monkey-patch the real Mongoose Model statics that handleDeriveMasterBackup
// and notifyDeriveWaitBackup call directly (not injected) — same technique
// scripts/verifyStrandedSweep.js already uses for Ad.find / CampaignRun.find.
// `adFindResult` lets a test control the "othersQueued" candidate set.
async function withMocks(fn, { adFindResult = [] } = {}) {
  const origAdUpdateOne = Ad.updateOne;
  const origAdFind = Ad.find;
  const origRunUpdateOne = CampaignRun.updateOne;
  const calls = { adUpdateOne: [], runUpdateOne: [], adFind: [] };
  Ad.updateOne = async (filter, update) => { calls.adUpdateOne.push({ filter, update }); return { acknowledged: true, modifiedCount: 1 }; };
  Ad.find = (filter) => {
    calls.adFind.push(filter);
    return { select: () => ({ lean: async () => adFindResult }) };
  };
  CampaignRun.updateOne = async (filter, update) => { calls.runUpdateOne.push({ filter, update }); return { acknowledged: true, modifiedCount: 1 }; };
  try {
    return await fn(calls);
  } finally {
    Ad.updateOne = origAdUpdateOne;
    Ad.find = origAdFind;
    CampaignRun.updateOne = origRunUpdateOne;
  }
}

(async () => {
// ── A. NEVER ABANDON — the core contract ──────────────────────────────────
await checkAsync('A1 first cycle (attempts=0): ad goes back to queued, never failed', async () => {
  await withMocks(async (calls) => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    const spy = async () => 1;
    const result = await handleDeriveMasterBackup({
      ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts: 0, index: 0, run,
      requeue: spy, notify: async () => {}
    });
    assert.strictEqual(calls.adUpdateOne.length, 1, 'expected exactly one Ad.updateOne');
    assert.strictEqual(calls.adUpdateOne[0].update.$set.status, 'queued');
    assert.notStrictEqual(calls.adUpdateOne[0].update.$set.status, 'failed');
    assert.strictEqual(result.requeuedToQueued, true);
  });
});

await checkAsync('A2 [REVERT-PROOF] attempts far past MAX_DERIVE_WAIT_ATTEMPTS (999): STILL queued, never failed', async () => {
  await withMocks(async (calls) => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    await handleDeriveMasterBackup({
      ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts: 999, index: 0, run,
      requeue: async () => 1, notify: async () => {}
    });
    assert.strictEqual(calls.adUpdateOne[0].update.$set.status, 'queued',
      'an ad this far past the old cap must still be recoverable, not stamped failed');
  });
});

await checkAsync('A2b [REVERT-PROOF] no code path in handleDeriveMasterBackup writes status:\'failed\' at any attempts value', async () => {
  await withMocks(async (calls) => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    for (const attempts of [0, 1, 29, 30, 31, 1000]) {
      await handleDeriveMasterBackup({
        ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts, index: 0, run,
        requeue: async () => 1, notify: async () => {}
      });
    }
    for (const c of calls.adUpdateOne) {
      assert.notStrictEqual(c.update.$set.status, 'failed', `attempts sweep must never fail the ad (saw ${JSON.stringify(c.update.$set)})`);
    }
    assert.strictEqual(calls.adUpdateOne.length, 6);
  });
});

await checkAsync('A3 deriveWaitAttempts is incremented, never renderAttempts (queuedArchiveSweeper depends on this)', async () => {
  await withMocks(async (calls) => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    await handleDeriveMasterBackup({
      ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts: 0, index: 0, run,
      requeue: async () => 1, notify: async () => {}
    });
    const inc = calls.adUpdateOne[0].update.$inc;
    assert.deepStrictEqual(inc, { deriveWaitAttempts: 1 });
  });
});

await checkAsync('A4 the RUN is marked skipped, never failed, by this branch', async () => {
  await withMocks(async (calls) => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    await handleDeriveMasterBackup({
      ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts: 0, index: 3, run,
      requeue: async () => 1, notify: async () => {}
    });
    assert.strictEqual(calls.runUpdateOne.length, 1);
    assert.deepStrictEqual(calls.runUpdateOne[0].update.$inc, { skipped: 1 });
    assert.strictEqual(calls.runUpdateOne[0].filter._id, run._id);
  });
});

// ── B. RECLAIM ROUTES THROUGH THE EXISTING ATOMIC CLAIM, NOT A NEW ONE ────
await checkAsync('B1 requeue is called exactly once, with { ads: [ad], run }', async () => {
  await withMocks(async () => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    const calls = [];
    await handleDeriveMasterBackup({
      ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts: 0, index: 0, run,
      requeue: async (args) => { calls.push(args); return 1; }, notify: async () => {}
    });
    assert.strictEqual(calls.length, 1, 'must reclaim exactly once per timeout, not zero, not twice');
    assert.strictEqual(calls[0].ads.length, 1);
    assert.strictEqual(calls[0].ads[0], ad, 'must pass the SAME ad doc, not a re-fetched or re-shaped copy');
    assert.strictEqual(calls[0].run, run, 'must pass the SAME run doc through unchanged');
  });
});

await checkAsync('B2 [MONEY] the default requeue IS requeueStrandedAds — the same atomic claim path stranded ads use', async () => {
  // Behavioural, not source-text: prove the DEFAULT parameter resolves to
  // the actual exported requeueStrandedAds function object, not merely a
  // same-named lookalike. Two functions can share a name; identity cannot.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
  const declIdx = src.indexOf('async function handleDeriveMasterBackup(');
  assert.ok(declIdx !== -1, 'handleDeriveMasterBackup declaration not found');
  const decl = src.slice(declIdx, declIdx + 400);
  assert.ok(/requeue\s*=\s*requeueStrandedAds\b/.test(decl),
    'default value for `requeue` must be the real requeueStrandedAds, not a re-implementation');
  assert.strictEqual(typeof requeueStrandedAds, 'function', 'requeueStrandedAds must be exported for this identity to even be checkable');
});

await checkAsync('B3 [REVERT-PROOF] passing a bad/empty ads array is impossible from this call site — exactly one ad, by id', async () => {
  await withMocks(async () => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    let seen = null;
    await handleDeriveMasterBackup({
      ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts: 0, index: 0, run,
      requeue: async (args) => { seen = args; return 1; }, notify: async () => {}
    });
    assert.ok(Array.isArray(seen.ads) && seen.ads.length === 1 && seen.ads[0]._id === ad._id);
  });
});

await checkAsync('B4 a reclaim that finds nothing to claim (raced) does not throw and still returns cleanly', async () => {
  await withMocks(async () => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    const result = await handleDeriveMasterBackup({
      ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts: 0, index: 0, run,
      requeue: async () => 0, notify: async () => {}
    });
    assert.strictEqual(result.reclaimed, 0);
    assert.strictEqual(result.requeuedToQueued, true, 'the ad must still be left recoverable even if the reclaim raced and lost');
  });
});

await checkAsync('B5 [REVERT-PROOF] a reclaim that THROWS is caught — never crashes the render loop, ad stays recoverable', async () => {
  await withMocks(async (calls) => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    const result = await handleDeriveMasterBackup({
      ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts: 0, index: 0, run,
      requeue: async () => { throw new Error('simulated claim failure'); }, notify: async () => {}
    });
    assert.strictEqual(result.reclaimed, 0);
    assert.strictEqual(calls.adUpdateOne[0].update.$set.status, 'queued', 'must have already been written queued before the reclaim attempt');
  });
});

// ── C. Alerting never blocks or breaks the recovery path ──────────────────
await checkAsync('C1 a notify that throws is caught — recovery already happened by then', async () => {
  await withMocks(async () => {
    const ad = makeAd(); const master = makeMaster(); const run = makeRun();
    const result = await handleDeriveMasterBackup({
      ad, adId: ad._id, master, deriveFromFmt: master.platformFormat, attempts: 0, index: 0, run,
      requeue: async () => 1, notify: async () => { throw new Error('simulated Slack failure'); }
    });
    assert.strictEqual(result.reclaimed, 1);
    assert.strictEqual(result.notified, false);
  });
});

// ── D. ONE Slack message per BACKUP EPISODE — real alertService, real dedupe ─
await checkAsync('D1/D2 two derivative ads on the SAME master collapse into ONE Slack send (not one per ad, not one per poll)', async () => {
  const prevEnv = {
    ALERT_DEDUPE_WINDOW_MIN: process.env.ALERT_DEDUPE_WINDOW_MIN,
    ALERT_MIN_LEVEL: process.env.ALERT_MIN_LEVEL,
    ALERTS_ENABLED: process.env.ALERTS_ENABLED,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_ALERT_CHANNEL: process.env.SLACK_ALERT_CHANNEL
  };
  process.env.ALERT_DEDUPE_WINDOW_MIN = '15';
  process.env.ALERT_MIN_LEVEL = 'info';
  process.env.ALERTS_ENABLED = 'true';
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token-for-verify';
  process.env.SLACK_ALERT_CHANNEL = 'C00000000';
  alerts._resetState();
  const origFetch = global.fetch;
  const origWarn = console.warn;
  console.warn = () => {};
  let fetches = 0;
  const bodies = [];
  global.fetch = async (_url, opts) => {
    fetches += 1;
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  };
  try {
    await withMocks(async () => {
      const master = makeMaster({ _id: 'shared_master' });
      const run = makeRun();
      // Ad A waits on the master, attempt 1.
      await handleDeriveMasterBackup({
        ad: makeAd({ _id: 'ad_A' }), adId: 'ad_A', master, deriveFromFmt: master.platformFormat,
        attempts: 0, index: 0, run, requeue: async () => 1
      });
      // A DIFFERENT ad, SAME master — must fold into the same episode, not
      // fire its own message (owner: "not one per ad").
      await handleDeriveMasterBackup({
        ad: makeAd({ _id: 'ad_B' }), adId: 'ad_B', master, deriveFromFmt: master.platformFormat,
        attempts: 0, index: 1, run, requeue: async () => 1
      });
      // The SAME ad, a later poll cycle — must fold too, not fire again
      // (owner: "not one per poll").
      await handleDeriveMasterBackup({
        ad: makeAd({ _id: 'ad_A' }), adId: 'ad_A', master, deriveFromFmt: master.platformFormat,
        attempts: 1, index: 0, run, requeue: async () => 1
      });
    });
    assert.strictEqual(fetches, 1, `expected exactly 1 Slack send for 3 backup hits on one master, got ${fetches}`);
    assert.ok(/derive-wait/i.test(JSON.stringify(bodies[0])), 'the one message sent must be the derive-wait backup notice');

    // A DIFFERENT master must get its OWN message — proves the key is
    // scoped per-master, not a global "derive-wait" mute switch.
    await withMocks(async () => {
      const master2 = makeMaster({ _id: 'other_master' });
      const run = makeRun();
      await handleDeriveMasterBackup({
        ad: makeAd({ _id: 'ad_C' }), adId: 'ad_C', master: master2, deriveFromFmt: master2.platformFormat,
        attempts: 0, index: 0, run, requeue: async () => 1
      });
    });
    assert.strictEqual(fetches, 2, 'a different master must not be suppressed by the first master\'s dedupe key');
  } finally {
    console.warn = origWarn;
    global.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    alerts._resetState();
  }
});

// ── E. Stuck vs merely queued — "waiting on a backup" must stay honest ────
async function captureNotifyPayload(over) {
  let seen = null;
  const origNotify = alerts.notifyAsync;
  alerts.notifyAsync = async (opts) => { seen = opts; };
  try {
    await notifyDeriveWaitBackup({
      ad: makeAd(), adId: 'ad_1', waitN: 1, run: makeRun(),
      deriveFromFmt: 'pmax_video_9_16',
      ...over
    });
  } finally {
    alerts.notifyAsync = origNotify;
  }
  return seen;
}

await checkAsync('E1 master merely `queued` — ordinary congestion, level warn, not flagged stuck', async () => {
  await withMocks(async () => {
    const payload = await captureNotifyPayload({ master: makeMaster({ status: 'queued', updatedAt: new Date() }) });
    assert.ok(payload, 'notifyAsync was not called');
    assert.strictEqual(payload.level, 'warn');
    assert.ok(!/STUCK/i.test(payload.title));
  });
});

await checkAsync('E2 [REVERT-PROOF] master `rendering` with NO heartbeat past reapStaleMin() is flagged STUCK, level error', async () => {
  await withMocks(async () => {
    const prevReap = process.env.REAP_STALE_MIN;
    process.env.REAP_STALE_MIN = '15';
    try {
      const staleMaster = makeMaster({
        status: 'rendering',
        updatedAt: new Date(Date.now() - 25 * 60 * 1000) // 25m silence > 15m reap window
      });
      const payload = await captureNotifyPayload({ master: staleMaster });
      assert.ok(payload);
      assert.strictEqual(payload.level, 'error');
      assert.ok(/STUCK/i.test(payload.title), `expected a STUCK title, got: ${payload.title}`);
    } finally {
      if (prevReap === undefined) delete process.env.REAP_STALE_MIN; else process.env.REAP_STALE_MIN = prevReap;
    }
  });
});

await checkAsync('E3 master `rendering` with a FRESH heartbeat is NOT flagged stuck — still ordinary congestion', async () => {
  await withMocks(async () => {
    const prevReap = process.env.REAP_STALE_MIN;
    process.env.REAP_STALE_MIN = '15';
    try {
      const freshMaster = makeMaster({ status: 'rendering', updatedAt: new Date(Date.now() - 60 * 1000) });
      const payload = await captureNotifyPayload({ master: freshMaster });
      assert.ok(payload);
      assert.strictEqual(payload.level, 'warn');
      assert.ok(!/STUCK/i.test(payload.title));
    } finally {
      if (prevReap === undefined) delete process.env.REAP_STALE_MIN; else process.env.REAP_STALE_MIN = prevReap;
    }
  });
});

// ── F. "how many others are queued" reuses the shared gate ────────────────
await checkAsync('F1 othersQueued counts only siblings that resolveDeriveFromMaster maps to the SAME master format', async () => {
  const candidates = [
    { _id: 'sib_1', deriveFromMaster: 'pmax_video_9_16' },              // same master -> counts
    { _id: 'sib_2', platformFormat: 'pmax_video_1_1' },                  // implicit same master -> counts
    { _id: 'sib_3', deriveFromMaster: 'meta_stories_9_16' },             // different master -> does not count
    { _id: 'sib_4', platformFormat: 'meta_feed_1_1', veoPredictionId: 'p1' } // legacy paid master, not a derivation -> does not count
  ];
  await withMocks(async () => {
    const payload = await captureNotifyPayload({ master: makeMaster({ status: 'queued' }) });
    assert.ok(payload);
    assert.strictEqual(payload.fields.othersQueued, 2, `expected 2 matching siblings, got ${payload.fields.othersQueued}`);
  }, { adFindResult: candidates });
});

// ── G. which master, how long, how many — the message is actually informative ─
await checkAsync('G1 the alert names the master id, its status, and this ad\'s wait duration', async () => {
  await withMocks(async () => {
    const ad = makeAd({ _id: 'ad_g1', queuedAt: new Date(Date.now() - 42 * 60 * 1000) });
    const master = makeMaster({ _id: 'master_g1', status: 'rendering', updatedAt: new Date() });
    const payload = await captureNotifyPayload({ ad, adId: 'ad_g1', master, waitN: 4 });
    assert.ok(payload);
    assert.strictEqual(payload.fields.master, 'master_g1');
    assert.strictEqual(payload.fields.masterStatus, 'rendering');
    assert.ok(/41m|42m|43m/.test(payload.fields.waited), `expected ~42m in "waited", got: ${payload.fields.waited}`);
    assert.strictEqual(payload.key, 'derive-wait-backup:master_g1');
  });
});

// ── report ─────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n❌ verifyDeriveWaitBackup: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`\n✅ verifyDeriveWaitBackup: ${pass} checks passed`);
})().catch((err) => {
  console.error('verifyDeriveWaitBackup crashed:', err);
  process.exit(1);
});
