#!/usr/bin/env node
'use strict';
//
// verifyPreparingReap — pins the fix for CampaignRuns wedged forever in
// status:'preparing'. Pure + offline: no DB, no network, no API key.
//
// THE BUG: expandWizardJob (Director + Judge, then the atomic Ad claim)
// makes ZERO writes to the CampaignRun row before the 'running' flip. A web
// instance replaced mid-expansion (deploy, autoscale, or crash) leaves the
// row exactly as minted — status:'preparing', total:0, updatedAt frozen at
// startedAt — forever. Nothing RESOLVES this: the worker's reapOrphans()
// only sweeps status:'running'; backlogWatchdog.js already ALERTS on stale
// 'preparing' rows but does not fail them; the SIGTERM handler's in-flight
// registry (services/inFlight.js) isn't populated until AFTER the very flip
// this bug prevents, so persistOrphans sees zero in-flight work and never
// touches these rows either. Measured in production: 8 such runs, oldest
// 8+ days, all total:0/succeeded:0/failed:0/skipped:0.
//
// THE FIX has three parts that must ship together:
//   1. worker.js reapOrphans() gains a HYGIENE-ONLY sweep for stale
//      'preparing' runs (services/campaignRunGuards.buildStalePreparingFilter)
//      that stamps them 'failed' for visibility. This sweep runs on a
//      5-minute cadence (or longer if the worker is down), so it CANNOT be
//      the money guard on its own.
//   2. The 'preparing'→'running' flip in routes/ads.js becomes a
//      compare-and-swap on status:'preparing'
//      (services/campaignRunGuards.buildRunningFlipFilter). WITHOUT this,
//      shipping #1 alone opens a double-spend path: a run that is merely
//      slow (not dead) gets failed by the reaper, then resurrects itself to
//      'running' when expansion finally completes.
//   3. THE PART ADVERSARIAL REVIEW ADDED, AND IT IS THE REAL MONEY GUARD:
//      buildRunningFlipFilter also takes an age check keyed on the SAME
//      staleMin (REAP_STALE_MIN) the concurrency gate uses to decide a
//      'preparing'/'running' run has stopped being exclusive. Status alone
//      is not enough — the gate stops honoring a run's exclusivity purely
//      by age, on every request, independent of whether the worker's
//      reaper has ticked at all. Without the age check here too, a run
//      that outlives the GATE's window (but hasn't yet been reaped) can
//      still win its own CAS minutes later: a sibling duplicate request
//      sails through in the meantime (the gate no longer sees the original
//      as active) and bills a fresh generation, then the original's slow
//      expansion finishes and flips to 'running' too — two billed
//      generations for one operator intent. The age check closes this by
//      making the flip agree with the gate on the exact instant a run
//      stops being "still active", regardless of reaper cadence.
//
// These checks evaluate the REAL exported filter functions (and the REAL
// receiptFree() release guard) against REAL document shapes — not a regex
// over the source, for anything the matcher below can express. A
// source-text assertion cannot tell a working query from one that merely
// still contains the right words (same posture as
// verifyRunAlertsAndDoneGuard.js / verifyTitlingOrphanResume.js).
//
// Revert-prove (each mutation must fail this harness):
//   1. Drop `status: 'preparing'` from buildRunningFlipFilter
//        → C2 fails (a reaped/failed run would match the CAS and resurrect)
//   2. Drop the `staleMin` age guard from buildRunningFlipFilter (keep only
//      status) — THE BUG THIS REVIEW ROUND EXISTS TO CLOSE
//        → C5 fails (a run aged past the gate's window, but not yet reaped,
//          would still win its own CAS — the exact double-spend window)
//   3. Change buildStalePreparingFilter's status match to $in:['preparing','running']
//        → B3 fails (it would double-reap runs the OTHER sweep already owns)
//   4. Key buildStalePreparingFilter on updatedAt instead of startedAt
//        → harmless today (they're equal for 'preparing' rows) but D-group
//          import/call-site checks still require the helper be USED, so a
//          hand-rolled inline replacement fails D2/D4
//   5. Stop calling buildStalePreparingFilter at the worker.js sweep site
//        → D2 fails (these checks would be testing a copy)
//   6. Stop calling buildRunningFlipFilter at the routes/ads.js flip site,
//      or stop passing { now, staleMin }
//        → D4 fails
//   7. Drop the import of either helper from its call site
//        → D1 / D3 fail (the unbound-identifier production incident —
//          this repo has shipped that exact ReferenceError to prod three
//          times; see CLAUDE.md §5)
//   8. Make the abort branch call runRenderLoop anyway, or drop its `return`
//        → D5 fails
//   9. Drop `status:'rendering'` or `campaignRunIds: runId` from the release
//      filter, or stop clearing renderStage on release
//        → D6 fails (a gutted filter could release an ad belonging to a
//          different run, or leave a recycled ad eligible for
//          strandedRunSweeper's auto-requeue — see D6's comment)
//  10. Read flip.matchedCount without a fallback for other Mongo driver
//      result shapes
//        → D7 fails
//
//   node scripts/verifyPreparingReap.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildStalePreparingFilter,
  buildRunningFlipFilter
} = require('../services/campaignRunGuards');
const { receiptFree } = require('../services/spendReceipt');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyPreparingReap\n');

// ── A small Mongo matcher, covering exactly the operators these filters use
// (including the real receiptFree() shape: $and/$or/$in/$nin/$exists).
// Deliberately not general: throws on anything it does not understand, so a
// future operator added to a filter cannot be silently mis-evaluated into a
// false pass.
function matchOp(value, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === '$lt') { if (!(value != null && value < operand)) return false; }
      else if (op === '$gte') { if (!(value != null && value >= operand)) return false; }
      else if (op === '$in') { if (!operand.includes(value)) return false; }
      else if (op === '$nin') { if (operand.includes(value)) return false; }
      else if (op === '$exists') {
        const exists = value !== undefined;
        if (exists !== operand) return false;
      }
      else throw new Error(`matcher does not implement operator ${op} — extend it deliberately`);
    }
    return true;
  }
  // Real Mongo semantics: a scalar filter value against an ARRAY field
  // matches if any element equals it (e.g. `campaignRunIds: runId` against
  // Ad.campaignRunIds:[String]). Without this, the matcher would falsely
  // fail the exact real-world case D6 exists to test.
  if (Array.isArray(value)) return value.includes(cond);
  return value === cond;
}
function getPath(doc, key) {
  // Supports one level of dot-path (e.g. 'imageGeneration.predictionId'),
  // which is all receiptFree() uses.
  return key.split('.').reduce((o, k) => (o == null ? o : o[k]), doc);
}
function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!cond.every((sub) => matches(doc, sub))) return false;
    } else if (key === '$or') {
      if (!cond.some((sub) => matches(doc, sub))) return false;
    } else if (key.startsWith('$')) {
      throw new Error(`matcher does not implement top-level ${key}`);
    } else if (!matchOp(getPath(doc, key), cond)) {
      return false;
    }
  }
  return true;
}

const ROOT = path.join(__dirname, '..');
const workerSrc = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
const guardsSrc = fs.readFileSync(path.join(ROOT, 'services/campaignRunGuards.js'), 'utf8');

const NOW = new Date('2026-08-17T21:00:00Z');
const minAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000);
const STALE_MIN = 15;
const PREP_FILTER = buildStalePreparingFilter({ now: NOW, staleMin: STALE_MIN });

// ── Group B — buildStalePreparingFilter correctness (the hygiene sweep).
ok('B1 a preparing run older than staleMin matches (the wedge this fix reaps)', () => {
  const doc = { status: 'preparing', startedAt: minAgo(20), updatedAt: minAgo(20) };
  assert.strictEqual(matches(doc, PREP_FILTER), true);
});
ok('B2 a preparing run younger than staleMin does NOT match (still legitimately expanding)', () => {
  const doc = { status: 'preparing', startedAt: minAgo(5), updatedAt: minAgo(5) };
  assert.strictEqual(matches(doc, PREP_FILTER), false);
});
ok('B3 a stale RUNNING run does NOT match — that population belongs to the other sweep only', () => {
  const doc = { status: 'running', startedAt: minAgo(999), updatedAt: minAgo(999) };
  assert.strictEqual(matches(doc, PREP_FILTER), false);
});
ok('B4 stale done/failed rows do NOT match (already terminal)', () => {
  assert.strictEqual(matches({ status: 'done', startedAt: minAgo(999) }, PREP_FILTER), false);
  assert.strictEqual(matches({ status: 'failed', startedAt: minAgo(999) }, PREP_FILTER), false);
});
ok('B5 threshold is strict $lt on startedAt, not updatedAt (preparing rows never heartbeat)', () => {
  const start = guardsSrc.indexOf('function buildStalePreparingFilter');
  const body = guardsSrc.slice(start, start + 500);
  assert.ok(/startedAt:\s*\{\s*\$lt:/.test(body),
    'buildStalePreparingFilter must key staleness on startedAt');
  assert.ok(!/updatedAt/.test(body),
    'buildStalePreparingFilter must not reference updatedAt — a preparing row never heartbeats, ' +
    'so that would silently equal startedAt and invite someone to "optimize" it into a heartbeat check later');
});

// ── Group C — buildRunningFlipFilter is the REAL compare-and-swap, and its
// age guard (not the reaper) is what actually prevents the double-spend.
const RUN_ID = '64b0000000000000000000aa';
ok('C1 with no staleMin, the flip filter still pins id + status:preparing (bare-status mode, used only for isolation tests)', () => {
  assert.deepStrictEqual(buildRunningFlipFilter(RUN_ID), { _id: RUN_ID, status: 'preparing' });
});
ok('C2 a run the reaper already failed does NOT match the flip — this is what stops the resurrection', () => {
  const reapedDoc = { _id: RUN_ID, status: 'failed' };
  assert.strictEqual(matches(reapedDoc, buildRunningFlipFilter(RUN_ID)), false);
});
ok('C3 a run genuinely still preparing DOES match (bare-status mode) — legitimate slow expansions still complete', () => {
  const liveDoc = { _id: RUN_ID, status: 'preparing', startedAt: minAgo(2) };
  assert.strictEqual(matches(liveDoc, buildRunningFlipFilter(RUN_ID)), true);
});
ok('C4 WITH staleMin, a run still within the gate\'s window matches — real callers must not lose legitimate flips', () => {
  const filter = buildRunningFlipFilter(RUN_ID, { now: NOW, staleMin: STALE_MIN });
  const doc = { _id: RUN_ID, status: 'preparing', startedAt: minAgo(10) };
  assert.strictEqual(matches(doc, filter), true);
});
ok('C5 THE FIX: a run aged past staleMin does NOT match even though status is still preparing — ' +
   'this is the exact window adversarial review found (gate stops blocking duplicates at staleMin, ' +
   'a bare status guard would still let this run flip minutes later and double-bill)', () => {
  const filter = buildRunningFlipFilter(RUN_ID, { now: NOW, staleMin: STALE_MIN });
  const doc = { _id: RUN_ID, status: 'preparing', startedAt: minAgo(20) };
  assert.strictEqual(matches(doc, filter), false);
});
ok('C6 the age guard uses the SAME staleMin the gate passes — not a separately-tuned constant', () => {
  const start = guardsSrc.indexOf('function buildRunningFlipFilter');
  const body = guardsSrc.slice(start, start + 700);
  assert.ok(/startedAt\s*=\s*\{\s*\$gte:/.test(body),
    'buildRunningFlipFilter must add a startedAt $gte guard when staleMin is supplied');
});

// ── Group D — call sites use the real helpers (not a copy), imports
// resolve, and the release path is fully specified (not just "mentions
// receiptFree somewhere").
ok('D1 worker.js IMPORTS buildStalePreparingFilter (a call without an import is a ReferenceError)', () => {
  assert.ok(/require\(\s*['"]\.\/services\/campaignRunGuards['"]\s*\)/.test(workerSrc),
    'worker.js must require ./services/campaignRunGuards');
  assert.ok(/\{\s*buildStalePreparingFilter\s*\}/.test(workerSrc),
    'buildStalePreparingFilter must be destructured from that require');
});
ok('D2 the live worker.js sweep calls buildStalePreparingFilter — not a hand-rolled copy', () => {
  const i = workerSrc.indexOf("CampaignRun.updateMany(\n    buildStalePreparingFilter(");
  assert.ok(i !== -1, 'the preparing sweep must call CampaignRun.updateMany(buildStalePreparingFilter(...))');
});
ok('D3 routes/ads.js IMPORTS buildRunningFlipFilter', () => {
  const reqLineMatch = adsSrc.match(/const\s*\{[^}]*buildRunningFlipFilter[^}]*\}\s*=\s*require\(\s*['"]\.\.\/services\/campaignRunGuards['"]\s*\)/);
  assert.ok(reqLineMatch,
    'routes/ads.js must require ../services/campaignRunGuards and destructure buildRunningFlipFilter from it');
});
ok('D4 the live flip site calls buildRunningFlipFilter(run._id, { now, staleMin }) — the age guard must actually be wired in, not just available', () => {
  assert.ok(/CampaignRun\.updateOne\(\s*\n\s*buildRunningFlipFilter\(run\._id,\s*\{\s*now:\s*Date\.now\(\),\s*staleMin\s*\}\)/.test(adsSrc),
    'the running-flip updateOne must call buildRunningFlipFilter(run._id, { now: Date.now(), staleMin }) — ' +
    'passing only run._id would silently drop the money guard C5 pins');
});
ok('D5 the abort branch releases claimed ads and returns WITHOUT ever calling runRenderLoop', () => {
  const flipIdx = adsSrc.indexOf('const flip = await CampaignRun.updateOne(');
  assert.ok(flipIdx !== -1, 'could not locate the flip site');
  const branchStart = adsSrc.indexOf('if (!flipMatched)', flipIdx);
  assert.ok(branchStart !== -1, 'could not locate the flipMatched abort branch');
  const nextRenderLoopCall = adsSrc.indexOf('await runRenderLoop(', flipIdx);
  assert.ok(nextRenderLoopCall !== -1, 'runRenderLoop call site moved — re-anchor this check');
  const abortBlock = adsSrc.slice(branchStart, nextRenderLoopCall);
  assert.ok(/receiptFree\(/.test(abortBlock),
    'the abort branch must release claimed ads via receiptFree(...) — they are receipt-free by construction');
  assert.ok(/status:\s*'queued'/.test(abortBlock),
    'the abort branch must set the released ads back to queued');
  assert.ok(/\breturn;/.test(abortBlock),
    'the abort branch must return before runRenderLoop — a fallthrough would render ads whose run never flipped to running');
  assert.ok(!/runRenderLoop\(/.test(abortBlock),
    'the abort branch must NOT call runRenderLoop — that would submit billable work for a run that lost the CAS');
});
ok('D6 the release filter is FULLY specified — status:rendering + campaignRunIds:runId + renderStage cleared — ' +
   'not just "receiptFree appears somewhere" (a gutted filter, e.g. receiptFree({_id:{$in:adIds}}) alone, passes a ' +
   'looser check but would release ads belonging to other runs; failing to clear renderStage leaves a recycled ad ' +
   'eligible for strandedRunSweeper\'s auto-requeue — an unwanted real billable re-render with no operator click)', () => {
  const flipIdx = adsSrc.indexOf('const flip = await CampaignRun.updateOne(');
  const branchStart = adsSrc.indexOf('if (!flipMatched)', flipIdx);
  const nextRenderLoopCall = adsSrc.indexOf('await runRenderLoop(', flipIdx);
  const abortBlock = adsSrc.slice(branchStart, nextRenderLoopCall);
  assert.ok(/receiptFree\(\s*\{\s*_id:\s*\{\s*\$in:\s*adIds\s*\},\s*status:\s*'rendering',\s*campaignRunIds:\s*runId\s*\}\)/.test(abortBlock),
    'the release filter must be receiptFree({ _id:{$in:adIds}, status:"rendering", campaignRunIds:runId }) in full');
  assert.ok(/renderStage:\s*null/.test(abortBlock) && /renderStageAt:\s*null/.test(abortBlock),
    'the release $set must clear renderStage/renderStageAt, or a recycled ad stays eligible for auto-requeue');

  // And prove the REAL receiptFree() actually composes as claimed against a
  // synthetic doc shape — not just that the source text mentions it.
  const releaseFilter = receiptFree({ _id: { $in: ['a1'] }, status: 'rendering', campaignRunIds: 'run_x' });
  const receiptFreeAd  = { _id: 'a1', status: 'rendering', campaignRunIds: ['run_x'], veoPredictionId: null, imageGeneration: { predictionId: null } };
  const billedAd       = { ...receiptFreeAd, veoPredictionId: 'pred_123' };
  const otherRunAd      = { ...receiptFreeAd, campaignRunIds: ['run_y'] };
  assert.strictEqual(matches(receiptFreeAd, releaseFilter), true,
    'a genuinely unbilled ad in this run must match the release filter');
  assert.strictEqual(matches(billedAd, releaseFilter), false,
    'an ad already holding a video receipt must NOT match — releasing it would double-bill on the next claim');
  assert.strictEqual(matches(otherRunAd, releaseFilter), false,
    'an ad belonging to a DIFFERENT run must not match this run\'s release');
});
ok('D7 flip.matchedCount is read defensively against other Mongo result shapes, not bare', () => {
  assert.ok(/flip\.matchedCount\s*\?\?\s*flip\.nModified\s*\?\?\s*flip\.n\s*\?\?\s*0/.test(adsSrc),
    'a bare `if (!flip.matchedCount)` would silently discard every generation if the driver ever returns ' +
    'the older {n, nModified} shape instead of {matchedCount, modifiedCount} — this repo already treats that ' +
    'shape as untrustworthy elsewhere (services/runFeedService.js modifiedCount ?? nModified)');
});

// ── Group E — PREPARE_STALE_MIN has a sane bounded default, matching the
// existing REAP_STALE_MIN pattern (env override, floor of 1, default 15).
// Its value no longer carries money risk either way (see buildRunningFlipFilter),
// so this only pins that it stays a well-formed, boundable knob.
ok('E1 PREPARE_STALE_MIN parses env with Math.max(1, ...) and a 15-minute default', () => {
  const m = workerSrc.match(/const PREPARE_STALE_MIN\s*=\s*Math\.max\(1,\s*parseInt\(process\.env\.PREPARE_STALE_MIN,\s*10\)\s*\|\|\s*15\)/);
  assert.ok(m, 'PREPARE_STALE_MIN must follow the same env/floor/default shape as REAP_STALE_MIN');
});

if (process.exitCode) {
  console.log(`\n❌ verifyPreparingReap: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyPreparingReap: ${checks}/${checks} checks passed`);
}
