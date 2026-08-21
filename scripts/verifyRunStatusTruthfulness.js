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
const {
  buildStaleRunningReapUpdate,
  classifyRunAdOutcome,
  buildRunReconciliationUpdate,
  buildRecentlyFailedFilter
} = require('../services/campaignRunGuards');

const ROOT = path.join(__dirname, '..');
const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
const workerSrcForE = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const processAlertsSrc = fs.readFileSync(path.join(ROOT, 'services/processAlerts.js'), 'utf8');

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
  // worker.js calls buildRunReconciliationUpdate(...), not
  // buildStaleRunningReapUpdate(...) directly, since the 2026-08-20 Ad-truth
  // reconciliation fix (services/campaignRunGuards.js) — a blind reap write
  // is no longer correct on its own; every candidate is judged from its real
  // claimed Ads first (see section E below for that pin).
  // buildRunReconciliationUpdate ITSELF still calls buildStaleRunningReapUpdate
  // for the needsRetry branch (services/campaignRunGuards.js), so the
  // errors[] message this test exists to protect is not duplicated anywhere
  // — checked directly below rather than via worker.js's own source text.
  assert.match(workerSrc, /buildRunReconciliationUpdate\(/,
    'worker.js reapOrphans() must call the shared reconciliation builder — ' +
    'an inlined copy is exactly how this drifted from having an errors[] entry in the first place');
  assert.doesNotMatch(workerSrc, /\$push:\s*\{\s*errors:\s*\{\s*index:\s*0,\s*stage:\s*'reaper'/,
    'the reaper errors[] shape must come from the shared builder, not a hand-rolled copy inlined into worker.js');
  const guardsSrc = fs.readFileSync(path.join(ROOT, 'services/campaignRunGuards.js'), 'utf8');
  assert.match(guardsSrc, /function buildRunReconciliationUpdate[\s\S]*?buildStaleRunningReapUpdate\(staleMin\)/,
    'buildRunReconciliationUpdate must itself delegate to buildStaleRunningReapUpdate for the ' +
    'needsRetry branch, not re-derive the reaper errors[] message a second way');
});

// ── E. Ad-truth reconciliation (2026-08-20 incident fix) ──────────────────
//
// run_1787263897396_ef1fcb32: 9/9 claimed Ads settled to `draft` with a real
// renderUrl (delivered), but CampaignRun.status never left 'running' — it
// only became 'failed' once the operator, seeing what looked like a
// permanent spinner, cancelled it. Root cause: CampaignRun.status is written
// ONLY by process-local code (runRenderLoop's post-Promise.all `done` write,
// or the reaper's blind `failed` stamp) and NOTHING ever re-derives it from
// the run's actual claimed Ads — so a run whose owning process died can sit
// 'running' forever even after every Ad it claimed is genuinely delivered by
// a completely different path (titlingResumeService, bootRecoveryService)
// that never touches CampaignRun at all.
//
// Sibling shape, same root cause, opposite arrow: a run reaped to 'failed'
// with stale succeeded:18 while all 39 of its claimed Ads already carried a
// renderUrl — the reaper's blind write never looked at the Ads either.
//
// classifyRunAdOutcome / buildRunReconciliationUpdate (services/
// campaignRunGuards.js) close this by having worker.js's reaper read the
// REAL claimed Ads for every stale-running candidate before writing
// anything, rather than trusting the CampaignRun row's own (possibly dead)
// bookkeeping.
//
// Revert-prove (each mutation below must fail this harness):
//   1. classifyRunAdOutcome always returns isSettled:true (drop the
//      stillRendering check) → E3 fails (a receipt-holding still-rendering
//      Ad would let a genuinely in-flight run be finalized).
//   2. classifyRunAdOutcome never sets needsRetry (drop the requeuedAway
//      check) → E4 fails (an Ad genuinely lost back to 'queued' would be
//      silently treated as a clean finish).
//   3. buildRunReconciliationUpdate's done branch also $sets `skipped` or
//      `total` → E6 fails (same money-safety posture as C1, now on the new
//      write path).
//   4. buildRunReconciliationUpdate's needsRetry branch stops delegating to
//      buildStaleRunningReapUpdate (hand-rolls its own errors[] message)
//      → E7/D4 fail.
//   5. worker.js goes back to a blind `CampaignRun.updateMany(
//      buildStaleRunningFilter(...), buildStaleRunningReapUpdate(...))`
//      → E9 fails (no per-candidate Ad.find, no classifier, no
//      reconciliation update in the source at all).
//   6. worker.js's reconciliation loop drops the `continue` for an unsettled
//      candidate (so it falls through to a write) → E10 fails.

const CLAIMED_ADS_DRAFT_ONLY = [
  { status: 'draft' }, { status: 'draft' }, { status: 'draft' },
  { status: 'draft' }, { status: 'draft' }, { status: 'draft' },
  { status: 'draft' }, { status: 'draft' }, { status: 'draft' }
];

await ok('E1 classifyRunAdOutcome: all 9 claimed Ads draft+delivered — settled, no retry needed, honest counts (THE INCIDENT SHAPE)', () => {
  const outcome = classifyRunAdOutcome(CLAIMED_ADS_DRAFT_ONLY);
  assert.strictEqual(outcome.succeeded, 9);
  assert.strictEqual(outcome.failed, 0);
  assert.strictEqual(outcome.stillRendering, 0);
  assert.strictEqual(outcome.requeuedAway, 0);
  assert.strictEqual(outcome.isSettled, true);
  assert.strictEqual(outcome.needsRetry, false);
});

await ok('E2 classifyRunAdOutcome: a genuine mix of draft + Ad.status:\'failed\' is still SETTLED — done means finished, not all-succeeded', () => {
  const outcome = classifyRunAdOutcome([
    { status: 'draft' }, { status: 'draft' }, { status: 'failed' }, { status: 'live' }, { status: 'archived' }
  ]);
  assert.strictEqual(outcome.succeeded, 4, 'draft + live + archived all count as delivered');
  assert.strictEqual(outcome.failed, 1);
  assert.strictEqual(outcome.isSettled, true);
  assert.strictEqual(outcome.needsRetry, false,
    'a settled mix of success/failure is a COMPLETED run, not one that lost work');
});

await ok('E3 classifyRunAdOutcome: ANY receipt-holding Ad still \'rendering\' blocks finalization, however many others are draft', () => {
  const outcome = classifyRunAdOutcome([
    { status: 'draft' }, { status: 'draft' }, { status: 'draft' }, { status: 'draft' },
    { status: 'draft' }, { status: 'draft' }, { status: 'draft' }, { status: 'draft' },
    { status: 'rendering' } // the 9th ad, still genuinely cooking behind a shared pool
  ]);
  assert.strictEqual(outcome.stillRendering, 1);
  assert.strictEqual(outcome.isSettled, false,
    'one still-rendering ad must block BOTH done and failed — real paid-for work is outstanding');
});

await ok('E4 classifyRunAdOutcome: an Ad reset to \'queued\' (genuinely lost, not requeued yet by this pass) forces needsRetry', () => {
  const outcome = classifyRunAdOutcome([
    { status: 'draft' }, { status: 'draft' }, { status: 'queued' }
  ]);
  assert.strictEqual(outcome.isSettled, true, 'no ad is still rendering, so this candidate CAN be finalized');
  assert.strictEqual(outcome.needsRetry, true, 'a lost claim must still read failed, honestly');
  assert.strictEqual(outcome.succeeded, 2);
});

await ok('E5 classifyRunAdOutcome: empty claimed-ads list is vacuously settled with nothing to retry (defensive, not the expected shape)', () => {
  const outcome = classifyRunAdOutcome([]);
  assert.strictEqual(outcome.isSettled, true);
  assert.strictEqual(outcome.needsRetry, false);
  assert.strictEqual(outcome.succeeded, 0);
});

await ok('E6 buildRunReconciliationUpdate: settled + no retry → status:\'done\' with REAL counts, and ONLY status/completedAt/succeeded/failed (money-safety)', () => {
  const outcome = classifyRunAdOutcome(CLAIMED_ADS_DRAFT_ONLY);
  const now = new Date('2026-08-20T22:40:00Z');
  const u = buildRunReconciliationUpdate(outcome, { staleMin: 15, now });
  assert.deepStrictEqual(Object.keys(u), ['$set'], 'a clean finish must not also $push an errors[] entry');
  assert.strictEqual(u.$set.status, 'done');
  assert.strictEqual(u.$set.completedAt, now);
  assert.strictEqual(u.$set.succeeded, 9, 'THE FIX: the run must be closed out with the REAL delivered count, not a stale 0');
  assert.strictEqual(u.$set.failed, 0);
  const setKeys = Object.keys(u.$set).sort();
  assert.deepStrictEqual(setKeys, ['completedAt', 'failed', 'status', 'succeeded'],
    'must never touch total/skipped/mintedTotal — same money-safety posture as C1, now on this write path');
});

await ok('E7 buildRunReconciliationUpdate: settled + needsRetry → status:\'failed\' via the SAME reaper errors[] message, but with real counts', () => {
  const outcome = classifyRunAdOutcome([
    { status: 'draft' }, { status: 'draft' }, { status: 'queued' }
  ]);
  const now = new Date('2026-08-20T22:40:00Z');
  const u = buildRunReconciliationUpdate(outcome, { staleMin: 15, now });
  assert.strictEqual(u.$set.status, 'failed');
  assert.strictEqual(u.$set.completedAt, now);
  assert.strictEqual(u.$set.succeeded, 2, 'THE SIBLING FIX: honest succeeded count instead of a stale 0/undercounted value');
  assert.strictEqual(u.$set.failed, 0);
  assert.ok(u.$push && u.$push.errors, 'must still carry the reaper explanation');
  assert.strictEqual(u.$push.errors.stage, 'reaper');
  assert.match(u.$push.errors.message, /15m/);
  // Byte-identical message to the blind builder for the same staleMin — this
  // IS delegation, not a parallel re-derivation that could drift.
  assert.strictEqual(u.$push.errors.message, buildStaleRunningReapUpdate(15).$push.errors.message);
});

await ok('E8 buildRunReconciliationUpdate never resurrects a filter — callers must still gate the write on status:\'running\' themselves', () => {
  // This function returns only the UPDATE half; it has no _id/status filter
  // of its own to accidentally get wrong. Documented here so a future
  // change that tries to fold a filter into this function's return value
  // gets caught by this having to change at all.
  const outcome = classifyRunAdOutcome(CLAIMED_ADS_DRAFT_ONLY);
  const u = buildRunReconciliationUpdate(outcome, { staleMin: 15, now: new Date() });
  assert.ok(!('_id' in u) && !('status' in u), 'the update object must carry no filter-shaped keys of its own');
});

await ok('E9 worker.js wires find → per-candidate Ad.find(campaignRunIds) → classifyRunAdOutcome → buildRunReconciliationUpdate → status-guarded updateOne', () => {
  const code = stripCommentLinesForWorker(workerSrcForE);
  assert.match(code, /CampaignRun\.find\(\s*\n\s*buildStaleRunningFilter\(/,
    'candidates must come from the shared predicate, not a hand-rolled filter');
  assert.match(code, /Ad\.find\(\s*\{\s*campaignRunIds:\s*candidate\.runId\s*\}/,
    'each candidate must be judged from ITS OWN claimed Ads, not a blind bulk write');
  assert.match(code, /classifyRunAdOutcome\(/, 'must call the shared classifier, not a hand-rolled count');
  assert.match(code, /buildRunReconciliationUpdate\(/, 'must call the shared reconciliation update builder');
  assert.match(code, /CampaignRun\.updateOne\(\s*\{\s*_id:\s*candidate\._id,\s*status:\s*'running'\s*\}/,
    'the finalizing write must re-check status:\'running\' at write time (CAS) — a run this same tick already ' +
    'resolved some other way must not be clobbered');
});

await ok('E10 worker.js skips (does not write) an unsettled candidate — the `continue` before any updateOne', () => {
  const code = stripCommentLinesForWorker(workerSrcForE);
  const m = code.match(/if\s*\(!outcome\.isSettled\)\s*\{([\s\S]*?)\}/);
  assert.ok(m, 'could not locate the isSettled guard in worker.js\'s reconciliation loop');
  assert.match(m[1], /continue/, 'an unsettled candidate (real receipted work still rendering) must be left alone this tick');
  assert.doesNotMatch(m[1], /updateOne|updateMany/, 'no write may happen for a candidate that is not yet settled');
});

// ── F. services/processAlerts.js persistOrphans — the SIGTERM twin of E ────
//
// Measured incident (2026-08-20): two runs (operator brian@egami.tv) sat at
// `status:'failed', succeeded:18, total:39` while every one of the 39
// claimed Ads was, by the time anyone looked, genuinely `draft` with a real
// renderUrl — 100% delivered, reported as 46%. `persistOrphans` used to fire
// a BLIND `CampaignRun.updateMany({...}, {$set:{status:'failed',...}})` on
// every SIGTERM for every run this process still had in flight — no read of
// the run's actual claimed Ads — and because 'failed' sits outside
// worker.js's `buildStaleRunningFilter` ('running' only), that write was
// effectively unhealable by section E's fix above.
//
// Revert-prove (each mutation below must fail this harness):
//   1. persistOrphans goes back to a blind `CampaignRun.updateMany(...,
//      {$set:{status:'failed',...}})` with no per-run Ad read → F1 fails
//      (no `classifyRunAdOutcome(` / `buildRunReconciliationUpdate(` call).
//   2. The Ad requeue and the CampaignRun reconciliation move back into one
//      `Promise.all([...])` (so the reconciliation read can race the
//      requeue write instead of seeing it landed) → F2 fails.
//   3. The `!outcome.isSettled` branch starts setting `status` anyway → F3
//      fails (a receipt-holding still-rendering Ad must not be finalized).

function fnBody(src, marker) {
  // NOT just "the first balanced {...} after the marker" — for
  // `async function name({ destructured, params }) { body }` that first
  // brace pair is the PARAMETER destructuring, which closes immediately and
  // returns a near-empty slice ending mid-signature. Skip the parameter
  // list (matching parens, not braces) to find the body's own opening brace
  // first. Naive either way about braces/parens inside strings/comments/
  // regex literals in the body — fine here, this file's functions don't
  // have any that would desync the count.
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const parenStart = src.indexOf('(', start);
  if (parenStart === -1) return null;
  let parenDepth = 0;
  let i = parenStart;
  for (; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) { i += 1; break; }
    }
  }
  const braceStart = src.indexOf('{', i);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let j = braceStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return src.slice(start);
}

const persistOrphansBody = fnBody(processAlertsSrc, 'async function persistOrphans');

await ok('F0 persistOrphans is still findable as a whole function body (scoping precondition for F1-F3)', () => {
  assert.ok(persistOrphansBody, 'could not locate persistOrphans in services/processAlerts.js — later checks would silently scope to the whole file');
  assert.ok(persistOrphansBody.length < processAlertsSrc.length,
    'fnBody must have scoped to the function, not fallen back to the whole file');
});

function stripLineComments(src) {
  // Line-comment-only stripper (this file has no block comments in the
  // regions scanned below) — cheap insurance against a positive/negative
  // regex being fooled by a `// classifyRunAdOutcome(` mention or a
  // commented-out old blind stamp, the exact class of harness weakness
  // adversarial review flagged (2026-08-20).
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

const persistOrphansStripped = stripLineComments(persistOrphansBody);

await ok('F1 persistOrphans reconciles from real Ad truth (classifyRunAdOutcome + buildRunReconciliationUpdate), not a blind stamp', () => {
  assert.match(persistOrphansStripped, /classifyRunAdOutcome\(/,
    'persistOrphans must call the shared classifier on each run\'s real claimed Ads before deciding a terminal status');
  assert.match(persistOrphansStripped, /buildRunReconciliationUpdate\(/,
    'persistOrphans must call the shared reconciliation update builder, not hand-roll succeeded/failed');
  // Broader than the one exact old spelling: NO write anywhere in this
  // function may $set a run's status without that value having come out of
  // buildRunReconciliationUpdate's destructured `$set` a few lines earlier —
  // approximated here by requiring every literal `status:` OUTSIDE of a
  // `$set` destructured from the builder to be gone. Concretely: the old
  // shape `$set: { status: 'failed', completedAt: now }` (any key order) is
  // banned by requiring `$set:` never appears immediately followed by a
  // hand-written `status:` key within the same object literal.
  assert.doesNotMatch(persistOrphansStripped, /\$set:\s*\{[^}]*\bstatus\s*:\s*'(?:failed|done)'/,
    'persistOrphans must not blind-stamp a literal status value in any $set — every terminal status must come ' +
    'from buildRunReconciliationUpdate\'s own $set, not a hand-written one');
});

await ok('F2 the Ad requeue is AWAITED before the CampaignRun reconciliation read (not raced beside it in one Promise.all)', () => {
  const adUpdateIdx = persistOrphansBody.indexOf('Ad.updateMany(');
  const campaignFindIdx = persistOrphansBody.indexOf('CampaignRun.find(');
  assert.ok(adUpdateIdx !== -1, 'expected an Ad.updateMany( requeue call in persistOrphans');
  assert.ok(campaignFindIdx !== -1, 'expected a CampaignRun.find( candidate read in persistOrphans (not a blind updateMany)');
  assert.ok(adUpdateIdx < campaignFindIdx,
    'the Ad requeue must be awaited and appear BEFORE the CampaignRun candidate read — the reconciliation read ' +
    'must see this process\'s own requeue writes already landed, or a "queued" row can be misread as "not looked at yet"');
  assert.doesNotMatch(persistOrphansBody, /Promise\.all\(\[\s*\n?\s*Ad\.updateMany/,
    'the Ad requeue and the CampaignRun write must not be raced together in one Promise.all — that reopens the ' +
    'exact ordering bug this fix closes');
});

await ok('F3 a candidate with nothing lost yet (still-rendering, no needsRetry) is left alone — never stamped failed', () => {
  // NOT a bare `!outcome.isSettled` guard — adversarial review (2026-08-20,
  // two independent passes) caught that guard flattening a MIXED shape
  // (some claimed Ads still receipt-holding + rendering, OTHERS already
  // genuinely lost to 'queued') into "leave the whole run alone", which
  // starves services/strandedRunSweeper.js (it only drains a queued/
  // receipt-free tail once the OWNING run reads status:'failed') for
  // however long the receipt-holding sibling takes to separately resolve.
  // The correct guard only defers when NOTHING has been lost AND something
  // is still genuinely rendering.
  const m = persistOrphansStripped.match(/if\s*\(!outcome\.isSettled\s*&&\s*!outcome\.needsRetry\)\s*\{([\s\S]*?)\n\s{6}\}/);
  assert.ok(m, 'could not locate the !isSettled-and-not-needsRetry defer guard inside persistOrphans');
  assert.doesNotMatch(m[1], /\$set\b/,
    'a deferred candidate (real receipted work still outstanding, nothing lost) must not $set ANY field — ' +
    'only the audit $push is allowed; a hand-written status/counters write here is exactly the blind guess ' +
    'this fix removes');
  // The revert-prove for the specific regression this guard exists to
  // prevent: a candidate with something ALREADY lost (needsRetry) must NOT
  // hit this defer branch even if another sibling is still rendering — it
  // must instead reach buildRunReconciliationUpdate and get failed for real.
  assert.doesNotMatch(persistOrphansStripped, /if\s*\(!outcome\.isSettled\)\s*\{/,
    'persistOrphans must not gate on bare !outcome.isSettled ALONE anywhere (i.e. without also requiring ' +
    '!outcome.needsRetry) — that reopens the mixed-shape regression (a lost Ad alongside a still-outstanding ' +
    'one must still fail the run, not wait on the still-outstanding one)');
});

await ok('F4 persistOrphans projects the WIDE Ad field set classifyRunAdOutcome\'s titling-truth check needs (PR #278), not a status-only projection', () => {
  // PR #278 (merged 2026-08-20, moments before this branch was rebased onto
  // it) taught classifyRunAdOutcome to also check video-titling truth
  // (isVideoTitlingSettled), which reads kind/renderUrl/veoVideoUrl/
  // titlingResumeState/renderStage. A `.select('status')`-only projection
  // silently reads every video Ad's `kind` as `undefined !== 'video'`, so it
  // is treated as a static and the titling debt is never seen — the EXACT
  // "would have silently no-op'd the whole fix" failure mode #278's own
  // commit message warns about, now against THIS PR's two new call sites
  // instead of the running-reaper it originally fixed. Revert-prove: widen
  // this .select( call back down to 'status' only → this check fails, but
  // (as measured while writing this check) nothing else in this file did —
  // it was a genuine, previously-unpinned hole.
  const adFindIdx = persistOrphansStripped.indexOf("Ad.find({ campaignRunIds: run.runId })");
  assert.ok(adFindIdx !== -1, 'could not locate the per-run Ad.find( campaignRunIds: run.runId ) call inside persistOrphans');
  const afterAdFind = persistOrphansStripped.slice(adFindIdx);
  const selectMatch = afterAdFind.match(/\.select\(\s*'([^']*)'\s*\)\s*\n?\s*\.lean\(\)/);
  assert.ok(selectMatch, 'could not locate the .select(...).lean() projection on persistOrphans\' per-run Ad.find call');
  const fields = selectMatch[1].split(/\s+/).filter(Boolean);
  for (const required of ['status', 'kind', 'renderUrl', 'veoVideoUrl', 'titlingResumeState', 'renderStage']) {
    assert.ok(fields.includes(required),
      `persistOrphans' Ad.find projection is missing "${required}" — classifyRunAdOutcome's titling-truth ` +
      'check needs it, and losing it silently miscounts every video Ad instead of throwing');
  }
});

// ── G. The GENERAL safety net — recently-'failed' runs get re-checked too ──
//
// classifyRunAdOutcome/buildRunReconciliationUpdate (section E) only fixed
// the running-reaper's OWN blind stamp. `buildRecentlyFailedFilter`
// (services/campaignRunGuards.js) widens the SAME worker cadence to also
// re-derive already-'failed' runs, closing every OTHER writer that can land
// a run there blind (processAlerts.js persistOrphans — section F — plus
// routes/ads.js's crash handlers) and the shape where a run was correctly
// judged `needsRetry` at the time, then had its "lost" ads later drained
// into a successful re-render by services/strandedRunSweeper.js — which
// fixes the Ad, never the CampaignRun row it came from.
//
// Revert-prove (each mutation below must fail this harness):
//   1. buildRecentlyFailedFilter stops filtering on `completedAt` (scans
//      every 'failed' run ever) → G1 fails (window is not respected).
//   2. worker.js's healing pass drops the `!outcome.isSettled` guard →
//      G3-shaped bug is no longer structurally prevented (checked via G2's
//      source scan requiring the same guard pattern as section E10).
//   3. worker.js stops re-checking 'failed' runs at all (removes the whole
//      pass) → G2 fails (no buildRecentlyFailedFilter( call in worker.js).

await ok('G1 buildRecentlyFailedFilter: status:\'failed\' + completedAt within the window, nothing else', () => {
  const now = new Date('2026-08-20T23:00:00Z');
  const filter = buildRecentlyFailedFilter({ now, windowMin: 180 });
  assert.strictEqual(filter.status, 'failed');
  assert.ok(filter.completedAt && filter.completedAt.$gte instanceof Date);
  assert.strictEqual(filter.completedAt.$gte.getTime(), now.getTime() - 180 * 60 * 1000);
  assert.deepStrictEqual(Object.keys(filter).sort(), ['completedAt', 'status'],
    'must not smuggle in any other condition — a run outside the window is deliberately left alone');
});

function failedHealingLoopBody(code) {
  // Bounded at the next REAL statement after the loop (the summary-log
  // `if`), not a hand-tuned char count — the same "self-maintaining" posture
  // sliceHandler documents in section D above, and the direct fix for
  // adversarial review's critique that a fixed span is the span-drift trap
  // this file already knows about.
  const loopStart = code.indexOf('for (const failedCandidate of recentlyFailedCandidates)');
  if (loopStart === -1) return null;
  const nextMarker = code.indexOf('if (nRunsHealed > 0)', loopStart);
  if (nextMarker === -1) return null;
  return code.slice(loopStart, nextMarker);
}

await ok('G2 worker.js wires buildRecentlyFailedFilter → per-candidate Ad.find → classifyRunAdOutcome → buildRunReconciliationUpdate → status-guarded updateOne, mirroring section E\'s running-run pass', () => {
  const code = stripCommentLinesForWorker(workerSrcForE);
  assert.match(code, /buildRecentlyFailedFilter\(/, 'worker.js must call the shared recently-failed predicate');
  assert.match(code, /CampaignRun\.find\(\s*\n\s*buildRecentlyFailedFilter\(/,
    'the recently-failed candidates must come from the shared predicate, not a hand-rolled filter');
  const loopBody = failedHealingLoopBody(code);
  assert.ok(loopBody, 'could not locate the recently-failed healing loop, scoped to its own body');
  // Scoped to the FAILED loop specifically, not counted across the whole
  // file — adversarial review caught that a whole-file count could pass
  // with a hollow failed loop as long as section E's running loop alone
  // called each function twice.
  assert.match(loopBody, /classifyRunAdOutcome\(/, 'the failed-run healing loop must call the shared classifier itself, not just the running-run loop above it');
  assert.match(loopBody, /buildRunReconciliationUpdate\(/, 'the failed-run healing loop must call the shared reconciliation builder itself');
  assert.match(loopBody, /CampaignRun\.updateOne\(\s*\{\s*_id:\s*failedCandidate\._id,\s*status:\s*'failed'\s*\}/,
    'the healing write must re-check status:\'failed\' at write time (CAS) — a run this same tick already moved ' +
    'on some other way must not be clobbered');
});

await ok('G3 worker.js skips a candidate with nothing lost yet (still-rendering, no needsRetry) — never writes to it', () => {
  const code = stripCommentLinesForWorker(workerSrcForE);
  const loopBody = failedHealingLoopBody(code);
  assert.ok(loopBody, 'could not locate the recently-failed healing loop, scoped to its own body');
  // Same guard-shape fix as F3 — NOT a bare !outcome.isSettled (see F3's
  // header for the mixed-shape regression that guard caused).
  const m = loopBody.match(/if\s*\(!outcome\.isSettled\s*&&\s*!outcome\.needsRetry\)\s*continue;/);
  assert.ok(m, 'the healing loop must skip (continue) a candidate with real outstanding work and nothing yet lost');
  assert.doesNotMatch(loopBody, /if\s*\(!outcome\.isSettled\)\s*continue;/,
    'the healing loop must not gate on bare !outcome.isSettled ALONE — same regression F3 guards against');
  // Structural E10-style guarantee: nothing may write between the loop's
  // start and this exact continue statement — a write BEFORE the guard
  // would still pass a purely textual "does `continue` exist somewhere"
  // check, which is the specific weakness adversarial review flagged.
  const guardIdx = loopBody.search(/if\s*\(!outcome\.isSettled\s*&&\s*!outcome\.needsRetry\)\s*continue;/);
  const beforeGuard = loopBody.slice(0, guardIdx);
  assert.doesNotMatch(beforeGuard, /updateOne|updateMany/,
    'no write may happen before the still-rendering/no-needsRetry guard — a candidate must be classified before anything is written');
});

await ok('G4 the failed-run healing loop projects the same WIDE Ad field set (PR #278) as the running-run pass', () => {
  const code = stripCommentLinesForWorker(workerSrcForE);
  const loopBody = failedHealingLoopBody(code);
  assert.ok(loopBody, 'could not locate the recently-failed healing loop, scoped to its own body');
  const adFindIdx = loopBody.indexOf('Ad.find({ campaignRunIds: failedCandidate.runId })');
  assert.ok(adFindIdx !== -1, 'could not locate the Ad.find( campaignRunIds: failedCandidate.runId ) call inside the healing loop');
  const afterAdFind = loopBody.slice(adFindIdx);
  const selectMatch = afterAdFind.match(/\.select\(\s*'([^']*)'\s*\)\s*\n?\s*\.lean\(\)/);
  assert.ok(selectMatch, 'could not locate the .select(...).lean() projection on the healing loop\'s Ad.find call');
  const fields = selectMatch[1].split(/\s+/).filter(Boolean);
  for (const required of ['status', 'kind', 'renderUrl', 'veoVideoUrl', 'titlingResumeState', 'renderStage']) {
    assert.ok(fields.includes(required),
      `the failed-run healing loop's Ad.find projection is missing "${required}" — same PR #278 titling-truth ` +
      'requirement as the running-run pass above it, and section F\'s persistOrphans call');
  }
});


function stripCommentLinesForWorker(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

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
