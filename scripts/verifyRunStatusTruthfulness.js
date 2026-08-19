#!/usr/bin/env node
'use strict';
//
// verifyRunStatusTruthfulness — pins the in-app run-status fixes from the
// "Slack knows exactly what is going on, why aren't we using that as a
// source of information?" pass (2026-08-18/19). Pure + offline where
// possible (a fake `_Ad` injection covers the one Mongo-touching read); the
// two route-handler checks are scoped source scans because routes/ads.js
// requires a live app + DB to load, same posture as this repo's other
// route-level harnesses (e.g. verifyPreparingReap.js G7).
//
// THREE THINGS THIS PINS:
//
//   1. services/adStage.js `groupStageCounts` / `summarizeInFlightStages` —
//      the run poller (GET /api/ads/runs/:id) used to return only aggregate
//      succeeded/failed/skipped counts, with ZERO notion of what stage the
//      remaining work was in. Slack's live feed (runFeedService.js
//      buildParentText) already computed this "now: X, Y" aggregate for its
//      own "now:" line by grouping Ad.renderStage via adStage.stageBase.
//      summarizeInFlightStages is the same grouping, exported so the HTTP
//      route can call it too — single source of truth, not a second
//      re-derivation that could drift from what Slack says about the same
//      run.
//
//   2. services/campaignRunGuards.js `buildStaleRunningReapUpdate` —
//      worker.js's reaper used to stamp a stale 'running' CampaignRun
//      `{status:'failed', completedAt}` and NOTHING ELSE. No errors[] entry.
//      An operator looking at the run poller for a reaped run saw
//      `status:'failed'`, `errors:[]` — a hard stop with zero explanation,
//      exactly the "operator-blind" class this whole pass exists to close.
//      Money-safety constraint carried over unchanged from
//      services/campaignRunHeartbeat.js's own header: the update must touch
//      ONLY status/completedAt/errors — never succeeded/failed/skipped/total,
//      which would corrupt the run's own audit trail.
//
//   3. routes/ads.js — two source-level checks:
//      (a) GET /runs/:runId actually returns `stages`, `failureSummary`,
//          `lastHeartbeatAt`, `updatedAt` and actually calls
//          summarizeInFlightStages / runFeed.summariseFailures (not just
//          imports them unused).
//      (b) the queued-drain run-crash handler (POST /api/ads/runs) pushes a
//          real errors[] entry on crash, mirroring the prep/render crash
//          handler a few hundred lines above it — this one used to stamp
//          `status:'failed'` with no errors[] at all, same class as #2.
//
// Revert-prove (each mutation below must fail this harness):
//   1. Remove `stageBase(...)` from groupStageCounts (group by raw stage
//      string instead) → B1 fails: two rows that only differ by their poll
//      trailer ("… — polling 20s (7)" vs "… — polling 45s (12)") no longer
//      collapse into one bucket.
//   2. Drop the `$push` from buildStaleRunningReapUpdate, keep only `$set`
//      → C1/C2 fail.
//   3. Have the update also `$set` a counter field (e.g. `succeeded`)
//      → C3 fails (the money-safety "ONLY these two/three keys" guard).
//   4. Remove `stages,` or `failureSummary,` from the /runs/:runId res.json
//      block → D1 fails.
//   5. Remove the `$push` from the queued-drain crash handler's
//      CampaignRun.updateOne → D3 fails.
//
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  groupStageCounts,
  summarizeInFlightStages,
  stageBase
} = require('../services/adStage');
const { buildStaleRunningReapUpdate } = require('../services/campaignRunGuards');

const ROOT = path.join(__dirname, '..');
const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');

let checks = 0;
// ASYNC-AWARE on purpose: several checks below (section B) exercise
// summarizeInFlightStages, which is genuinely async (it awaits a Mongo
// read). A sync-only `ok()` that does not await a returned promise would
// increment `checks` before the assertion inside ever ran, and any
// rejection would surface as an unhandled rejection instead of a reported
// failure — i.e. every one of those checks would silently "pass" no matter
// what. `runChecks` below awaits every entry in strict sequence.
async function ok(label, fn) {
  try { await fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
}

async function main() {
console.log('verifyRunStatusTruthfulness\n');

// ── A. groupStageCounts (pure) ─────────────────────────────────────────────

await ok('A1 groups by stageBase, not the raw string — poll-trailer variants collapse into one bucket', () => {
  const rows = [
    { renderStage: 'master video generation (9:16) — polling 20s (7)' },
    { renderStage: 'master video generation (9:16) — polling 4m10s (17)' },
    { renderStage: 'titling 9:16' }
  ];
  const out = groupStageCounts(rows);
  const master = out.find(r => r.stage === stageBase(rows[0].renderStage));
  assert.ok(master, `expected a bucket for ${JSON.stringify(stageBase(rows[0].renderStage))}, got ${JSON.stringify(out)}`);
  assert.strictEqual(master.count, 2, 'the two poll-trailer variants of the same phase must collapse into one count of 2');
  const titling = out.find(r => r.stage === 'titling 9:16');
  assert.ok(titling && titling.count === 1);
});

await ok('A2 sorted most-common first (ties would break alphabetically)', () => {
  // stageBase only strips the poll-progress trailer (" — polling Ns (k)") —
  // NOT the surface parenthetical, so three different surfaces of the same
  // phase are genuinely three distinct buckets server-side (the frontend's
  // stageBucketLabel is what further collapses those by human label for
  // display). Use exact-duplicate raw stage strings here to isolate the
  // sort/count behaviour from that (separate, correct) non-collapsing.
  const rows = [
    { renderStage: 'uploading titled video (9:16)' },
    { renderStage: 'plate submit (meta_feed_1_1)' },
    { renderStage: 'plate submit (meta_feed_1_1)' },
    { renderStage: 'plate submit (meta_feed_1_1)' }
  ];
  const out = groupStageCounts(rows);
  assert.strictEqual(out[0].stage, 'plate submit (meta_feed_1_1)', 'the x3 bucket must sort first');
  assert.strictEqual(out[0].count, 3);
  assert.strictEqual(out[1].stage, 'uploading titled video (9:16)');
});

await ok('A3 respects `limit`, defaulting to 8', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ renderStage: `stage ${i}` }));
  assert.strictEqual(groupStageCounts(rows).length, 8, 'default limit must be 8');
  assert.strictEqual(groupStageCounts(rows, { limit: 3 }).length, 3);
  assert.strictEqual(groupStageCounts(rows, { limit: 0 }).length, 1, 'a nonsense limit must floor at 1, not return nothing');
});

await ok('A4 null/empty renderStage rows are silently dropped, not counted as a bucket', () => {
  const rows = [{ renderStage: null }, {}, { renderStage: '' }, { renderStage: 'vision QC (meta_feed_1_1)' }];
  const out = groupStageCounts(rows);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].stage, 'vision QC (meta_feed_1_1)');
});

// ── B. summarizeInFlightStages (Ad.find query shape + wiring) ─────────────

function makeFakeAd(rows) {
  const calls = [];
  return {
    calls,
    find(filter) {
      calls.push(filter);
      return {
        select() { return this; },
        lean() { return Promise.resolve(rows); }
      };
    }
  };
}

await ok('B1 queries campaignRunIds=<runId> AND status=\'rendering\' — the same population Slack\'s "now:" line reads', async () => {
  const fakeAd = makeFakeAd([{ renderStage: 'titling 9:16' }]);
  const out = await summarizeInFlightStages('run_123', { _Ad: fakeAd });
  assert.strictEqual(fakeAd.calls.length, 1);
  assert.deepStrictEqual(fakeAd.calls[0], { campaignRunIds: 'run_123', status: 'rendering' });
  assert.deepStrictEqual(out, [{ stage: 'titling 9:16', count: 1 }]);
});

await ok('B2 falsy runId short-circuits to [] without touching the model at all', async () => {
  const fakeAd = makeFakeAd([{ renderStage: 'should never be read' }]);
  const out = await summarizeInFlightStages(null, { _Ad: fakeAd });
  assert.deepStrictEqual(out, []);
  assert.strictEqual(fakeAd.calls.length, 0, 'must not call Ad.find at all for a falsy runId');
});

await ok('B3 end-to-end grouping through the injected model matches the pure function directly', async () => {
  const rows = [
    { renderStage: 'plate generation (meta_feed_1_1) — polling 3s (1)' },
    { renderStage: 'plate generation (meta_feed_1_1) — polling 6s (2)' },
    { renderStage: 'vision QC (meta_feed_1_1)' }
  ];
  const fakeAd = makeFakeAd(rows);
  const viaFn = await summarizeInFlightStages('run_x', { _Ad: fakeAd });
  const viaPure = groupStageCounts(rows);
  assert.deepStrictEqual(viaFn, viaPure);
});

// ── C. buildStaleRunningReapUpdate (pure) — the reaper's write, money-safe ─

await ok('C1 $set touches ONLY status + completedAt — never a counter field (succeeded/failed/skipped/total)', () => {
  const u = buildStaleRunningReapUpdate(15);
  const setKeys = Object.keys(u.$set || {}).sort();
  assert.deepStrictEqual(setKeys, ['completedAt', 'status']);
  assert.strictEqual(u.$set.status, 'failed');
  assert.ok(u.$set.completedAt instanceof Date);
  for (const forbidden of ['succeeded', 'failed', 'skipped', 'total']) {
    assert.ok(!(forbidden in u.$set), `$set must not touch "${forbidden}" — that would corrupt the run's own audit trail`);
  }
});

await ok('C2 $push.errors names the reaper and states the real configured staleMin, not a hardcoded number', () => {
  const u15 = buildStaleRunningReapUpdate(15);
  assert.ok(u15.$push && u15.$push.errors, 'must push an errors[] entry — this is the fix for the operator-blind gap');
  assert.strictEqual(u15.$push.errors.stage, 'reaper');
  assert.match(u15.$push.errors.message, /15m/, 'message must state the actual staleMin passed in, not a fixed literal');
  const u30 = buildStaleRunningReapUpdate(30);
  assert.match(u30.$push.errors.message, /30m/);
  assert.doesNotMatch(u30.$push.errors.message, /\b15m\b/, 'a different staleMin must not leak the other value');
});

await ok('C3 the message tells the operator what to DO, not just what happened', () => {
  const u = buildStaleRunningReapUpdate(15);
  assert.match(u.$push.errors.message, /queued/i);
  assert.match(u.$push.errors.message, /generate more/i);
});

// ── D. routes/ads.js — scoped source checks (route files need a live app to import) ─
//
// Sliced with indexOf, NOT a lazy `[\s\S]*?\}\);` regex — a lazy quantifier
// anchored on the generic "});" that closes nearly every callback/promise in
// this file stops at the FIRST such closer, which for both handlers below is
// an inner block (alerts.notifyAsync({...}) / an early .catch(() => {})) well
// before the code these checks actually care about. That is not a
// hypothetical: it is exactly what made D1-D3 fail red against the real,
// already-fixed source the first time this harness was run — the regex was
// wrong, not the code.

function sliceFrom(marker, span) {
  const start = adsSrc.indexOf(marker);
  if (start === -1) return null;
  return adsSrc.slice(start, start + span);
}

// Bounds a route-handler marker at the NEXT top-level route declaration (or
// EOF) instead of a hand-tuned char count. A fixed span drifts stale the
// moment the handler grows past it (measured: 4500→6000 one PR ago, when
// this exact handler grew a visionQcRollup block) — and a span that
// OVER-reaches past the real handler boundary risks a worse failure mode
// than "check can't find its target": a positive assertion ("the handler
// contains X") can pass on code that belongs to a different route entirely,
// which is a silent, unfalsifiable pass, not a scoping bug that fails loud.
// Self-maintaining: this never needs re-tuning as router.get('/runs/:runId')
// grows or shrinks.
function sliceHandler(marker) {
  const start = adsSrc.indexOf(marker);
  if (start === -1) return null;
  const routeDeclRe = /router\.(get|post|patch|put|delete)\(/g;
  routeDeclRe.lastIndex = start + marker.length;
  const next = routeDeclRe.exec(adsSrc);
  return adsSrc.slice(start, next ? next.index : adsSrc.length);
}

await ok('D1 GET /runs/:runId actually returns stages, failureSummary, lastHeartbeatAt, updatedAt', () => {
  const handler = sliceHandler("router.get('/runs/:runId'");
  assert.ok(handler, 'could not locate the GET /runs/:runId handler to scope this check');
  // Scoped to the res.json({...}) OBJECT LITERAL itself, not merely
  // "somewhere in this handler" — `stages` and `failureSummary` are also
  // destructured a few lines earlier (`const [queuedRemaining, stages,
  // failureSummary] = await Promise.all([...])`), so a bare `\bstages\b`
  // test over the whole handler stays green even if the field is deleted
  // from the actual response object. MEASURED: this was the harness's own
  // first bug — it passed against a mutation that deleted `stages,` from
  // the response, for exactly this reason.
  const rjStart = handler.indexOf('res.json({');
  assert.ok(rjStart !== -1, 'no res.json({ call found in the handler');
  const rjEnd = handler.indexOf('});', rjStart);
  assert.ok(rjEnd !== -1, 'res.json({ call never closed within the scoped window');
  const responseObj = handler.slice(rjStart, rjEnd);
  for (const key of ['stages', 'failureSummary', 'lastHeartbeatAt', 'updatedAt']) {
    assert.ok(new RegExp(`^\\s*${key}[,:]`, 'm').test(responseObj),
      `GET /runs/:runId response object is missing a "${key}" property`);
  }
});

await ok('D2 GET /runs/:runId actually CALLS summarizeInFlightStages and runFeed.summariseFailures (not just imported)', () => {
  const body = sliceHandler("router.get('/runs/:runId'");
  assert.ok(body);
  assert.match(body, /summarizeInFlightStages\(/, 'must call the shared stage-grouping function, not re-derive its own');
  assert.match(body, /runFeed\.summariseFailures\(/, 'must reuse Slack\'s own failure-grouping function, not a second copy');
});

await ok('D3 the queued-drain run-crash handler pushes a real errors[] entry on crash (mirrors the prep/render handler)', () => {
  // Span widened 1200→1600 (2026-08-19): the undispatched-tail fix
  // (services/adArchiveDigest.js buildRequeuePipeline) added a few explanatory
  // comment lines ahead of the Ad.updateMany in this same catch block, pushing
  // the $push/errors text this check looks for a bit further from the anchor.
  // A fixed span drifting stale the moment the handler grows is exactly the
  // trap sliceHandler's own header documents; this callsite just hasn't been
  // worth the dynamic-boundary rewrite yet, so give it real headroom instead.
  const block = sliceFrom("title: 'Campaign run crashed (queued drain)'", 1600);
  assert.ok(block, 'could not locate the queued-drain crash alert block to scope this check');
  assert.match(block, /\$push:\s*\{\s*errors:/,
    'the CampaignRun.updateOne after a queued-drain crash must $push an errors[] entry — ' +
    'it used to stamp status:\'failed\' with an empty errors[], leaving the run poller with zero explanation');
  assert.match(block, /stage:\s*'runs-drain'/);
});

await ok('D4 the running-reaper in worker.js uses the shared builder, not an inline duplicate', () => {
  const workerSrc = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  assert.match(workerSrc, /buildStaleRunningReapUpdate\(REAP_STALE_MIN\)/,
    'worker.js reapOrphans() must call the shared, harness-tested update builder — ' +
    'an inlined copy is exactly how this drifted from having an errors[] entry in the first place');
});

if (process.exitCode) {
  console.log(`\n❌ verifyRunStatusTruthfulness: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyRunStatusTruthfulness: ${checks}/${checks} checks passed`);
}
}

main().catch((err) => {
  console.error('verifyRunStatusTruthfulness: unexpected error', err);
  process.exitCode = 1;
});
