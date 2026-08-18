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
//      window the concurrency gate uses to decide a 'preparing' run has
//      stopped being exclusive. Status alone
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
//   4. AMENDED 2026-08-18 — WHICH window that is. Parts 1-3 shipped with the
//      flip keyed on REAP_STALE_MIN (15), on the reasoning that the flip and
//      the gate must agree. The agreement requirement was right; the value was
//      wrong. 15 is the CLAIMED-doc heartbeat window, and a 'preparing' run
//      never heartbeats — its healthy runtime is the Director + Judge ladder at
//      ~18-20 min, which worker.js documents in the same breath as calling 15
//      safe. So a normal expansion finishing at T=18 lost its own CAS: claimed
//      ads released back to 'queued', run stamped 'failed', operator shown a
//      crash that never happened. The preparing lifecycle now keys on
//      PREPARE_STALE_MIN (30) in all three places — the reap, the flip guard,
//      and (newly extracted) the gate's preparing arm,
//      campaignRunGuards.buildActiveRunsFilter. Group G pins that the flip and
//      gate windows are EQUAL, behaviourally, at every age.
//
//      Note where the gate's bound actually lives, because it is not where the
//      name suggests: services/generationGate.js implements NO staleness at all
//      (it reads createdAt only as a total-order key). The bound was always in
//      the caller's Mongo query in routes/ads.js — a single
//      `status:{$in:['preparing','running']}` + one createdAt cutoff, which is
//      precisely what forced both lifecycles onto one window. G8 pins that the
//      gate module stays free of its own bound.
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
//  11. Set PREPARE_STALE_MIN_DEFAULT back to 15 (services/staleness.js)
//        → E1, E2, E3 fail (and verifyStalenessParser B3/B4)
//  12. Feed the flip the bare `staleMin` again (the original defect)
//        → D4 fails
//  13. Feed buildActiveRunsFilter's preparing arm `staleMin` instead of
//      `prepareMin` — the coherence break that reopens the double bill
//        → G7 fails (and G2b demonstrates the gap that mutation creates)
//  14. Let config/defaults.env and services/staleness.js disagree
//        → E3 fails (CLAUDE.md §4a lockstep)
//  15. Re-inline either activeRuns query in routes/ads.js instead of using
//      the shared builder
//        → G7 fails (the pre-check and the race re-read would drift)
//
//   node scripts/verifyPreparingReap.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildStalePreparingFilter,
  buildRunningFlipFilter,
  buildActiveRunsFilter
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
ok('D4 the live flip site calls buildRunningFlipFilter(run._id, { now, staleMin: prepareMin }) — the age guard must be wired in AND fed the PREPARING window', () => {
  // UPDATED 2026-08-18. This used to require the bare shorthand `{ now:
  // Date.now(), staleMin }`, which pinned the flip to `staleMin` —
  // i.e. reapStaleMin(), 15. That was the defect: 15 is the claimed-doc
  // heartbeat window, and a 'preparing' run never heartbeats. Its healthy
  // runtime is the Director + Judge ladder at ~18-20 min (worker.js), so a
  // normal expansion finishing at T=18 lost this CAS, had its claimed ads
  // released back to 'queued', and was reported to the operator as a crash.
  // The check now pins the OPPOSITE requirement: the guard must be present
  // (unchanged — dropping it reopens the double-spend C5 pins) and it must be
  // fed prepareMin, not staleMin.
  assert.ok(/CampaignRun\.updateOne\(\s*\n\s*buildRunningFlipFilter\(run\._id,\s*\{\s*now:\s*Date\.now\(\),\s*staleMin:\s*prepareMin\s*\}\)/.test(adsSrc),
    'the running-flip updateOne must call buildRunningFlipFilter(run._id, { now: Date.now(), staleMin: prepareMin }) — ' +
    'passing only run._id silently drops the money guard C5 pins; passing the bare `staleMin` (REAP_STALE_MIN, 15) ' +
    'silently fails healthy ~18-20min expansions');
  assert.ok(/const prepareMin = prepareStaleMin\(\)/.test(adsSrc),
    'routes/ads.js must bind prepareMin from the shared parser prepareStaleMin()');
  assert.ok(!/buildRunningFlipFilter\(run\._id,\s*\{\s*now:\s*Date\.now\(\),\s*staleMin\s*\}\)/.test(adsSrc),
    'the flip must NOT be fed the bare reap window again');
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
// existing REAP_STALE_MIN pattern (env override, nonsense falls back).
//
// CORRECTED 2026-08-18. This group's header used to say the value "no longer
// carries money risk either way", on the strength of the reaper sweep being
// hygiene. That was wrong, and it is why the defect survived review: the sweep
// is hygiene, but the VALUE is now read by routes/ads.js for two money-facing
// decisions — buildRunningFlipFilter's age guard and the 'preparing' arm of
// buildActiveRunsFilter. Group G below pins the relationship between them.
ok('E1 PREPARE_STALE_MIN comes from the shared parser with a 30-minute default', () => {
  // REWRITTEN: this used to pin `Math.max(1, parseInt(env,10) || 15)` — which
  // ENSHRINED THE BUG. That idiom maps a negative to 1, handing the reaper a
  // ONE-MINUTE staleness threshold (it would sweep runs a minute old, i.e.
  // reap live work mid-render), and it disagreed with the web side's parse of
  // the same class of value. Both processes now read services/staleness.js.
  // Asserted by BEHAVIOUR, not by shape, so no idiom can be "right-looking".
  const staleness = require('../services/staleness');
  assert.ok(/prepareStaleMin\(\)/.test(workerSrc), 'worker.js must call prepareStaleMin()');
  // 30, not 15. The number is not arbitrary: worker.js's own arithmetic puts a
  // HEALTHY expansion at ~18-20 min (Director's 2 paid attempts x (120s timeout
  // + backoff) plus the Judge call). A preparing window at or below that
  // ceiling fails runs that are merely finishing.
  assert.strictEqual(staleness.PREPARE_STALE_MIN_DEFAULT, 30,
    'default must clear the ~18-20min healthy expansion ceiling documented in worker.js');
  assert.ok(staleness.PREPARE_STALE_MIN_DEFAULT > 20,
    'a preparing window <= 20 min reaps and un-flips healthy expansions — that was the 2026-08-18 defect');
  const prev = process.env.PREPARE_STALE_MIN;
  try {
    for (const bad of ['', '   ', '0', '-5', 'abc']) {
      process.env.PREPARE_STALE_MIN = bad;
      assert.strictEqual(staleness.prepareStaleMin(), 30,
        `nonsense value ${JSON.stringify(bad)} must fall back to 30, never clamp to 1`);
    }
    process.env.PREPARE_STALE_MIN = '45';
    assert.strictEqual(staleness.prepareStaleMin(), 45, 'a legitimate override must be honoured');
  } finally {
    if (prev === undefined) delete process.env.PREPARE_STALE_MIN; else process.env.PREPARE_STALE_MIN = prev;
  }
});
ok('E2 the RUNNING/claimed-doc window is untouched at 15 — raising it would delay orphan requeue', () => {
  const staleness = require('../services/staleness');
  assert.strictEqual(staleness.REAP_STALE_MIN_DEFAULT, 15,
    'REAP_STALE_MIN governs Ad "rendering" + CampaignRun "running" reaping and is deliberately NOT raised');
  assert.ok(staleness.PREPARE_STALE_MIN_DEFAULT > staleness.REAP_STALE_MIN_DEFAULT,
    'two separate lifecycles, two separate windows — collapsing them back into one is the regression');
});
ok('E3 config/defaults.env declares PREPARE_STALE_MIN and it AGREES with the code default (CLAUDE.md §4a lockstep)', () => {
  const defaultsRaw = fs.readFileSync(path.join(ROOT, 'config/defaults.env'), 'utf8');
  const staleness = require('../services/staleness');
  const m = defaultsRaw.match(/^PREPARE_STALE_MIN=(\d+)\s*$/m);
  assert.ok(m, 'config/defaults.env must declare PREPARE_STALE_MIN (non-secret defaults live there — CLAUDE.md §4a)');
  assert.strictEqual(Number(m[1]), staleness.PREPARE_STALE_MIN_DEFAULT,
    `defaults.env says ${m[1]} but the code default is ${staleness.PREPARE_STALE_MIN_DEFAULT} — ` +
    'a file/code disagreement is exactly the silent config lie §4a warns about');
  assert.ok(/18-20\s*min/.test(defaultsRaw),
    'the defaults.env comment must record WHY 30 (the ~18-20min healthy expansion ceiling), ' +
    'or the next person tuning it down has no way to know what it protects');
});

// ── Group F — adversarial-review round 2 findings.
//
// F1: REAP_STALE_MIN's gate-side parse (routes/ads.js) is now load-bearing
// for whether ANY generation succeeds (buildRunningFlipFilter's age guard),
// not just for duplicate-detection leniency. The naive `Number(env || 15)`
// idiom checks the RAW STRING's truthiness before parsing, so '0',
// whitespace, or a negative value all skip the `|| 15` fallback (they are
// non-empty strings, hence truthy) and collapse the flip's startedAt guard
// to `>= now` (or a future instant) — which NO real run can ever satisfy.
// That is a silent, total generation outage: every claim succeeds, every
// flip fails, every ad is quietly released. This mirrors the same env-
// parsing trap CLAUDE.md documents for PMAX_PROOF_* ("blank env is 0, not
// NaN") — and REAP_STALE_MIN lives dashboard-only (not in
// config/defaults.env), exactly where a human might "set it to 0 to
// disable staleness", the intuitive and catastrophic move.
//
// This re-implements the fixed formula (not the buggy one) as a plain JS
// mirror — same posture as E1 above — and separately pins that the real
// source uses the SAME clamp idiom already established in this repo
// (services/atlasImageService.js positiveTimeout).
function clampStaleMin(rawEnvValue) {
  const parsed = Number(rawEnvValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
}
ok('F1a the clamp survives every malformed REAP_STALE_MIN value adversarial review tried', () => {
  assert.strictEqual(clampStaleMin(undefined), 15, 'unset must default to 15');
  assert.strictEqual(clampStaleMin('0'), 15, "the string '0' must NOT collapse the guard to a no-op");
  assert.strictEqual(clampStaleMin('  '), 15, 'whitespace must NOT collapse the guard to a no-op');
  assert.strictEqual(clampStaleMin('-5'), 15, 'a negative value must NOT collapse the guard to a no-op');
  assert.strictEqual(clampStaleMin('abc'), 15, 'a non-numeric value must NOT produce an Invalid Date query');
  assert.strictEqual(clampStaleMin('30'), 30, 'a legitimate override must still be honored');
});
ok('F1b the real routes/ads.js staleMin computation uses the fixed clamp idiom, not the naive one', () => {
  assert.ok(!/const staleMin = Number\(process\.env\.REAP_STALE_MIN \|\| 15\)/.test(adsSrc),
    'the naive `Number(env || 15)` form must not return — it is truthy-string-shaped, not numeric-shaped');
  // The clamp moved OUT of routes/ads.js into services/staleness.js, so that
  // the worker's reaper and this gate cannot parse the same bound differently
  // (they did: a negative gave the worker 1 and the web 15). Assert the wiring
  // plus the actual behaviour, not the literal inline shape.
  assert.ok(/require\(['"]\.\.\/services\/staleness['"]\)/.test(adsSrc),
    'routes/ads.js must read the bound through services/staleness.js');
  assert.ok(/const staleMin = reapStaleMin\(\)/.test(adsSrc),
    'routes/ads.js must assign staleMin from reapStaleMin()');
  const { reapStaleMin } = require('../services/staleness');
  const prevReap = process.env.REAP_STALE_MIN;
  try {
    for (const bad of ['', '   ', '0', '-5']) {
      process.env.REAP_STALE_MIN = bad;
      assert.ok(reapStaleMin() > 0,
        `a staleMin of <= 0 from ${JSON.stringify(bad)} makes startedAt >= now unsatisfiable — every Generate would be discarded`);
    }
  } finally {
    if (prevReap === undefined) delete process.env.REAP_STALE_MIN; else process.env.REAP_STALE_MIN = prevReap;
  }
});

// F2: buildRunningFlipFilter keys on startedAt while the gate keys on
// createdAt — safe today only because startedAt is always set at
// CampaignRun.create() and NEVER rewritten afterward (startedAt <=
// createdAt by construction, a few ms apart). This scans for the one thing
// that would silently invert that ordering: a $set block anywhere that
// touches startedAt on an EXISTING doc. A future retry/resume path adding
// `$set: { startedAt: ... }` would reopen the double-spend window with
// nothing else here to catch it.
ok('F2 nothing ever $sets startedAt on an existing CampaignRun (only CampaignRun.create() may set it)', () => {
  assert.ok(!/\$set:\s*\{[^}]*\bstartedAt\b/.test(adsSrc),
    'found a $set block touching startedAt in routes/ads.js — this inverts the startedAt<=createdAt ordering ' +
    'buildRunningFlipFilter relies on (see its JSDoc); key the flip on createdAt instead if this is intentional');
  assert.ok(!/\$set:\s*\{[^}]*\bstartedAt\b/.test(workerSrc),
    'found a $set block touching startedAt in worker.js — same risk as above');
});

// ── Group G — THE COHERENCE INVARIANT (added 2026-08-18).
//
// The gate DOES bound in-flight run consideration by staleness. It just does
// not do it inside services/generationGate.js — that module reads `createdAt`
// only as a total-order key (compareRunOrder) and never compares an age to a
// clock. The bound lives in the CALLER's query, now
// campaignRunGuards.buildActiveRunsFilter, fed by routes/ads.js. So the
// coherence constraint is REAL and had to be wired, not auto-satisfied.
//
// THE INVARIANT. Let Wg be how long the gate still counts a preparing run as
// in-flight (and therefore blocks an identical duplicate), and Wf how long that
// run may still win its own 'preparing'→'running' flip. If Wf > Wg there is a
// live double-bill window: between Wg and Wf the gate cannot see the original,
// so a duplicate request is admitted and bills — and then the original's slow
// expansion finishes and ITS flip still succeeds, billing a second time for one
// operator intent. Safety needs Wf <= Wg; there is no benefit to Wf < Wg (that
// only discards legitimate flips the gate was still protecting). So Wf == Wg,
// and both read the same PREPARE_STALE_MIN.
//
// These checks evaluate the REAL exported filters against REAL document shapes
// at a swept set of ages, so they fail if the two windows are ever fed
// different values — including by a future caller that passes reapStaleMin() to
// one of them again.
const G_PREP_MIN = 30;
const G_RUN_MIN  = 15;
// Same reaper filter Group B exercises, but at the PREPARING window rather than
// the Group B fixture's 15 — so G3/G4 assert against the sweep the worker
// actually runs.
const PREP_FILTER_PREP_WINDOW = buildStalePreparingFilter({ now: NOW, staleMin: G_PREP_MIN });
const gateFilter = buildActiveRunsFilter({
  campaignId: 'camp1',
  now: NOW,
  runningStaleMin:   G_RUN_MIN,
  preparingStaleMin: G_PREP_MIN
});
// startedAt === createdAt here on purpose: mongoose stamps them a few ms apart,
// and modelling them as equal is the WORST case for this invariant (any real
// skew leans the safe way — see buildRunningFlipFilter's ordering note).
const preparingRunAged = (ageMin) => ({
  _id: RUN_ID, campaignId: 'camp1', status: 'preparing',
  startedAt: minAgo(ageMin), createdAt: minAgo(ageMin)
});
const flipAllows  = (ageMin) => matches(preparingRunAged(ageMin),
  buildRunningFlipFilter(RUN_ID, { now: NOW, staleMin: G_PREP_MIN }));
const gateBlocks  = (ageMin) => matches(preparingRunAged(ageMin), gateFilter);

ok('G1 the flip window NEVER outlives the gate window at any age — the double-bill direction is closed', () => {
  for (let age = 0; age <= 60; age += 1) {
    if (flipAllows(age)) {
      assert.ok(gateBlocks(age),
        `age ${age}m: the flip would still succeed but the gate no longer sees this run as in-flight — ` +
        'a duplicate request bills, then this run flips and bills again');
    }
  }
});
ok('G2 the two windows are EQUAL, not merely ordered — a gate that outlives the flip discards healthy runs', () => {
  for (let age = 0; age <= 60; age += 1) {
    assert.strictEqual(flipAllows(age), gateBlocks(age),
      `age ${age}m: flip=${flipAllows(age)} gate=${gateBlocks(age)} — the preparing lifecycle must have ONE window`);
  }
});
ok('G2b [ANTI-VACUITY] G1 is a real constraint: mis-wiring the gate to the RUNNING window DOES open the gap', () => {
  // Without this, G1 could pass simply because no age ever satisfies its
  // premise. Reproduce the exact mis-wiring mutation 3 makes — flip on the
  // preparing window (30), gate's preparing arm on the reap window (15) — and
  // assert a double-bill window really exists between them. If this ever stops
  // reproducing, G1 has stopped testing anything and must be rewritten.
  const misWiredGate = buildActiveRunsFilter({
    campaignId: 'camp1', now: NOW,
    runningStaleMin: G_RUN_MIN, preparingStaleMin: G_RUN_MIN   // ← the bug
  });
  const exposed = [];
  for (let age = 0; age <= 60; age += 1) {
    const canFlip = matches(preparingRunAged(age),
      buildRunningFlipFilter(RUN_ID, { now: NOW, staleMin: G_PREP_MIN }));
    if (canFlip && !matches(preparingRunAged(age), misWiredGate)) exposed.push(age);
  }
  assert.ok(exposed.length > 0,
    'the mis-wired pairing must expose ages where the flip still succeeds but the gate is blind — ' +
    'if it does not, G1/G2 are vacuous');
  assert.ok(exposed.includes(20) && exposed.includes(29),
    `expected the exposed window to span roughly 15-30m, got [${exposed[0]}..${exposed[exposed.length - 1]}]`);
});
ok('G3 a HEALTHY expansion at the documented ~18-20min ceiling still wins its flip (the bug being fixed)', () => {
  for (const age of [18, 19, 20]) {
    assert.strictEqual(flipAllows(age), true,
      `an expansion finishing at T=${age}m is healthy per worker.js, not a crash — it must keep its flip`);
    assert.strictEqual(matches(preparingRunAged(age), PREP_FILTER_PREP_WINDOW), false,
      `a ${age}m-old preparing run must NOT be reaped — it is still legitimately expanding`);
  }
});
ok('G4 the guard is still a guard: past the preparing window BOTH the flip and the gate let go together', () => {
  assert.strictEqual(flipAllows(31), false, 'a run past the preparing window must not resurrect itself');
  assert.strictEqual(gateBlocks(31), false, 'and the gate must have stopped counting it at the same instant');
  assert.strictEqual(matches(preparingRunAged(31), PREP_FILTER_PREP_WINDOW), true,
    'and the reaper must be willing to stamp it failed for visibility');
});
ok('G5 the RUNNING arm is NOT widened — running runs still roll off at the 15m claimed-doc window', () => {
  const running = (ageMin) => ({
    _id: 'r2', campaignId: 'camp1', status: 'running',
    startedAt: minAgo(ageMin), createdAt: minAgo(ageMin)
  });
  assert.strictEqual(matches(running(10), gateFilter), true, 'a live running run is in flight');
  assert.strictEqual(matches(running(20), gateFilter), false,
    'a running run past REAP_STALE_MIN must roll off at 15 — raising it here would delay orphan requeue, ' +
    'which is explicitly out of scope for the preparing-window change');
  assert.strictEqual(matches(preparingRunAged(20), gateFilter), true,
    'while a PREPARING run of the same age is still in flight — that asymmetry is the whole point');
});
ok('G6 buildActiveRunsFilter refuses a nonsense window instead of emitting an arm that matches nothing', () => {
  // A missing/blank/negative minute value would otherwise produce new Date(NaN)
  // and silently disable half the duplicate gate. Falls back through the ONE
  // shared parser (services/staleness.positiveMinutes), not a second one.
  for (const bad of [undefined, null, '', '   ', '0', '-5', 'abc']) {
    const f = buildActiveRunsFilter({ campaignId: 'camp1', now: NOW, runningStaleMin: bad, preparingStaleMin: bad });
    for (const arm of f.$or) {
      const cutoff = arm.createdAt.$gte;
      assert.ok(cutoff instanceof Date && Number.isFinite(cutoff.getTime()),
        `${JSON.stringify(bad)} produced an Invalid Date cutoff — that arm matches nothing and the gate is half-off`);
    }
    assert.strictEqual(matches(preparingRunAged(5), f), true,
      `${JSON.stringify(bad)} must fall back to the documented default, still catching a 5m-old preparing run`);
  }
});
ok('G7 BOTH gate call sites use the shared builder — the pre-check and the mint-then-verify re-read must see one population', () => {
  const occurrences = adsSrc.split('CampaignRun.find(buildActiveRunsFilter({').length - 1;
  assert.strictEqual(occurrences, 2,
    `expected exactly 2 buildActiveRunsFilter queries in routes/ads.js, found ${occurrences} — ` +
    'the pre-check and the race re-read must not drift apart, which is how an inlined copy fails');
  assert.ok(!/status:\s*\{\s*\$in:\s*\[\s*'preparing',\s*'running'\s*\]\s*\},\s*\n\s*createdAt:\s*\{\s*\$gte/.test(adsSrc),
    'the old single-window $in query must not come back — it forces both lifecycles onto REAP_STALE_MIN');
  assert.ok(/preparingStaleMin:\s*prepareMin/.test(adsSrc) && /runningStaleMin:\s*staleMin/.test(adsSrc),
    'the arms must be fed from the matching parsers: preparing→prepareStaleMin(), running→reapStaleMin()');
});
ok('G8 generationGate.js still implements NO staleness bound of its own — the caller owns it, so there is one', () => {
  // Documented finding, pinned so it cannot silently become false. If someone
  // adds an age filter inside the gate module, there are suddenly TWO places
  // deciding what "in flight" means and G1/G2 above stop covering the real path.
  const gateSrc = fs.readFileSync(path.join(ROOT, 'services/generationGate.js'), 'utf8');
  assert.ok(!/staleMin|reapStaleMin|prepareStaleMin|REAP_STALE_MIN|PREPARE_STALE_MIN/.test(
    gateSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')),
  'services/generationGate.js must not implement its own staleness window in CODE (comments may name it) — ' +
  'the bound belongs to buildActiveRunsFilter so the flip guard can be held equal to it');
});

if (process.exitCode) {
  console.log(`\n❌ verifyPreparingReap: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyPreparingReap: ${checks}/${checks} checks passed`);
}
