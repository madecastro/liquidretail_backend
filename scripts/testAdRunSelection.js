#!/usr/bin/env node
//
// Unit checks for the two ad-run bugs reported 2026-07-28:
//
//   1. Pressing "Generate Ad" for ONE product rendered an UNRELATED product as
//      "1 of 20". selectAdsForRun selected on { campaignId, status:'queued' }
//      with no product filter, and its first tier sorts queuedAt ASCENDING —
//      so the oldest leftover ad on the campaign rendered first.
//
//   2. Pressing Stop hid the stop button but rendering continued, and the
//      unrendered ads were put BACK to status:'queued' — so cancelled work
//      reappeared (and billed) on the next Generate.
//
// Mongoose is stubbed at the model layer: Ad.find(...) is replaced with a
// chainable fake over an in-memory row set, so the real query objects the
// service builds are asserted directly. No DB, no network.
//
// Usage:
//   node scripts/testAdRunSelection.js

'use strict';

const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Ad = require('../models/Ad');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('use checkAsync for async tests');
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const asyncChecks = [];
function checkAsync(name, fn) {
  asyncChecks.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
    }
  });
}

// ── model stub ──────────────────────────────────────────────────────

const realFind = Ad.find;
let findCalls = [];      // every filter selectAdsForRun built, in order
let rows = [];           // the fake queued-ad table

function matches(row, filter) {
  for (const [k, v] of Object.entries(filter)) {
    const actual = row[k];
    if (v && typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId)) {
      if ('$in' in v) {
        const want = v.$in.map(String);
        if (!want.includes(String(actual))) return false;
        continue;
      }
      if ('$ne' in v) {
        if (String(actual) === String(v.$ne)) return false;
        if (v.$ne === null && (actual === null || actual === undefined)) return false;
        continue;
      }
      if ('$nin' in v) {
        const no = v.$nin.map(String);
        if (no.includes(String(actual))) return false;
        continue;
      }
      return false;
    }
    if (v === null) { if (actual !== null && actual !== undefined) return false; continue; }
    if (String(actual) !== String(v)) return false;
  }
  return true;
}

function installStub() {
  findCalls = [];
  Ad.find = (filter) => {
    findCalls.push(JSON.parse(JSON.stringify(filter, (k, v) =>
      (v instanceof mongoose.Types.ObjectId ? String(v) : v))));
    let out = rows.filter(r => matches(r, filter));
    const chain = {
      sort(spec) {
        const keys = Object.entries(spec);
        out = out.slice().sort((a, b) => {
          for (const [k, dir] of keys) {
            const av = a[k], bv = b[k];
            if (av === bv) continue;
            if (av == null) return 1;
            if (bv == null) return -1;
            return av < bv ? -dir : dir;
          }
          return 0;
        });
        return chain;
      },
      limit(n) { out = out.slice(0, n); return chain; },
      select() { return chain; },
      lean() { return Promise.resolve(out); }
    };
    return chain;
  };
}
function restoreStub() { Ad.find = realFind; }

const oid = () => new mongoose.Types.ObjectId();
const CAMPAIGN = oid();
const PELAGIC  = oid();   // the product the operator picked
const OTHER    = oid();   // a product from an earlier session

// One deterministic video per product (the tier-0 shape), plus concept ads.
function seed() {
  rows = [
    // The backlog: OLDER, different product. Tier 0 sorts queuedAt ASC, so
    // these are exactly what used to render as "1 of 20".
    { _id: oid(), campaignId: CAMPAIGN, productId: OTHER, status: 'queued',
      conceptId: null, judgeRank: null, renderRoute: 'veo', queuedAt: new Date('2026-07-28T08:00:00Z'), readinessScore: 0.9 },
    { _id: oid(), campaignId: CAMPAIGN, productId: OTHER, status: 'queued',
      conceptId: 'c_other', judgeRank: 1, renderRoute: 'html_gen', queuedAt: new Date('2026-07-28T08:01:00Z'), readinessScore: 0.8 },
    { _id: oid(), campaignId: CAMPAIGN, productId: OTHER, status: 'queued',
      conceptId: null, judgeRank: null, renderRoute: 'html_gen', queuedAt: new Date('2026-07-28T08:02:00Z'), readinessScore: 0.7 },
    // What the operator just asked for: NEWER, the picked product.
    { _id: oid(), campaignId: CAMPAIGN, productId: PELAGIC, status: 'queued',
      conceptId: null, judgeRank: null, renderRoute: 'veo', queuedAt: new Date('2026-07-28T17:00:00Z'), readinessScore: 0.5 },
    { _id: oid(), campaignId: CAMPAIGN, productId: PELAGIC, status: 'queued',
      conceptId: 'c_pel', judgeRank: 2, renderRoute: 'html_gen', queuedAt: new Date('2026-07-28T17:01:00Z'), readinessScore: 0.4 }
  ];
}

const { selectAdsForRun } = require('../services/campaignAdsGenerationService');
const idsOf = (pred) => rows.filter(pred).map(r => String(r._id));

// ── 1. the wrong-product bug ────────────────────────────────────────

checkAsync('scoped run returns ONLY the picked product, never the backlog', async () => {
  seed(); installStub();
  try {
    const picked = await selectAdsForRun({
      campaignId: CAMPAIGN, limit: 20, productIds: [String(PELAGIC)]
    });
    const wanted = idsOf(r => String(r.productId) === String(PELAGIC));
    assert.equal(picked.length, wanted.length, `expected ${wanted.length} ads, got ${picked.length}`);
    for (const id of picked) {
      const row = rows.find(r => String(r._id) === id);
      assert.equal(String(row.productId), String(PELAGIC),
        `selected an ad for the wrong product: ${row.productId}`);
    }
  } finally { restoreStub(); }
});

checkAsync('every selection tier carries the product filter', async () => {
  seed(); installStub();
  try {
    await selectAdsForRun({ campaignId: CAMPAIGN, limit: 20, productIds: [String(PELAGIC)] });
    assert.ok(findCalls.length >= 2, `expected multiple tier queries, saw ${findCalls.length}`);
    for (const f of findCalls) {
      assert.ok(f.productId && Array.isArray(f.productId.$in),
        `a tier query had no productId scope: ${JSON.stringify(f)}`);
      assert.deepEqual(f.productId.$in, [String(PELAGIC)]);
    }
  } finally { restoreStub(); }
});

// The regression itself: with the picked product's ads NEWER than the
// backlog's, an unscoped tier-0 (queuedAt ASC) puts the other product first.
checkAsync('UNSCOPED selection still drains oldest-first (documents the bug)', async () => {
  seed(); installStub();
  try {
    const all = await selectAdsForRun({ campaignId: CAMPAIGN, limit: 20 });
    const first = rows.find(r => String(r._id) === all[0]);
    assert.equal(String(first.productId), String(OTHER),
      'unscoped selection is expected to start on the older product — that is the reported bug');
    assert.ok(all.length > idsOf(r => String(r.productId) === String(PELAGIC)).length,
      'unscoped selection should pull in the backlog too');
  } finally { restoreStub(); }
});

// "Generate more from this campaign" must keep draining everything.
checkAsync('omitting productIds preserves whole-campaign drain (POST /api/ads/runs)', async () => {
  seed(); installStub();
  try {
    for (const arg of [undefined, null, []]) {
      findCalls = [];
      const all = await selectAdsForRun({ campaignId: CAMPAIGN, limit: 20, productIds: arg });
      assert.equal(all.length, rows.length, `productIds=${JSON.stringify(arg)} should select everything`);
      for (const f of findCalls) {
        assert.ok(!('productId' in f) || f.productId === null,
          `productIds=${JSON.stringify(arg)} must not scope: ${JSON.stringify(f)}`);
      }
    }
  } finally { restoreStub(); }
});

checkAsync('a repeat Generate still finds the product\'s already-queued ads', async () => {
  // The unique index on (campaignId, identityDigest) means the second press
  // inserts NOTHING — newAdIds comes back empty. Scoping by product rather
  // than by newly-inserted id is what keeps that press working.
  seed(); installStub();
  try {
    const again = await selectAdsForRun({
      campaignId: CAMPAIGN, limit: 20, productIds: [String(PELAGIC)]
    });
    assert.equal(again.length, 2, 'pre-existing queued ads for the product must still be selectable');
  } finally { restoreStub(); }
});

checkAsync('malformed product ids FAIL CLOSED, they do not widen to the campaign', async () => {
  seed(); installStub();
  try {
    // The caller asked to scope and we could not honour it. Widening to the
    // whole campaign here would silently re-create the bug this parameter
    // exists to prevent — while spending money.
    const out = await selectAdsForRun({
      campaignId: CAMPAIGN, limit: 20, productIds: ['not-an-objectid', 'also-bad']
    });
    assert.deepEqual(out, [], 'must select nothing, not everything');
  } finally { restoreStub(); }
});

checkAsync('a partially valid list scopes to the valid ids only', async () => {
  seed(); installStub();
  try {
    const out = await selectAdsForRun({
      campaignId: CAMPAIGN, limit: 20, productIds: ['garbage', String(PELAGIC)]
    });
    assert.equal(out.length, 2);
    for (const id of out) {
      const row = rows.find(r => String(r._id) === id);
      assert.equal(String(row.productId), String(PELAGIC));
    }
  } finally { restoreStub(); }
});

// ── 2. Stop semantics ───────────────────────────────────────────────
//
// Asserted against source: runRenderLoop is a closure inside routes/ads.js
// with no export seam, and standing up an Express route plus a live
// OperationRun to test it would test the harness, not the fix.

const adsSrc = require('node:fs').readFileSync(require.resolve('../routes/ads.js'), 'utf8');
const loopSrc = adsSrc.slice(adsSrc.indexOf('async function runRenderLoop'),
                             adsSrc.indexOf('async function renderOne'));

check('Stop: cancelled ads are ARCHIVED, never returned to the queue', () => {
  // The literal `status: 'archived'` moved out of this file on 2026-08-18:
  // every archive site now goes through the shared
  // archiveAdsReleasingDigest() helper, which performs the status flip AND
  // releases a never-billed row's identityDigest. Assert the CALL, not the
  // string it used to contain.
  assert.ok(/archiveAdsReleasingDigest\(\s*\n?\s*Ad,/.test(loopSrc),
    'cancellation should archive unrendered ads via the shared archive helper');
  assert.ok(!/\$set: \{ status: 'queued'/.test(loopSrc),
    're-queueing on cancel is the bug: cancelled work reappears and bills on the next Generate');
});

check("Stop: the backlog archive is scoped to THIS RUN, not the whole campaign", () => {
  // CORRECTED 2026-08-18. This check used to assert the OPPOSITE — it pinned
  // `campaignId: run.campaignId, status: 'queued'`, i.e. archive every queued
  // ad on the campaign. Owner ruled that a bug: other runs' queued rows, and
  // mint leftovers waiting for a "Generate more", were destroyed by stopping
  // an unrelated run. Ownership is campaignRunIds (stamped at mint by
  // mintedCampaignRunIds, $addToSet'd at claim), so the backlog filter must be
  // run-scoped and must NOT be campaign-scoped.
  // The filter itself is a pure exported builder (so a harness can evaluate
  // the real query); assert the call here and the shape there.
  assert.ok(/buildStopBacklogArchiveFilter\(\{ runId: run\.runId \}\)/.test(loopSrc),
    "cancel should archive only the stopping run's own queued backlog");
  assert.ok(!/campaignId: (?:run|job)\.campaignId, status: 'queued'/.test(loopSrc),
    'campaign-wide backlog archiving on Stop destroys other runs\' pending work');
  const f = require('../services/adArchiveDigest')
    .buildStopBacklogArchiveFilter({ runId: 'run_x' });
  assert.equal(f.campaignRunIds, 'run_x');
  assert.equal(f.status, 'queued');
  assert.ok(!('campaignId' in f), 'the backlog filter must not be campaign-scoped');
});

check('Stop: the cancel check is AWAITED before more work is claimed', () => {
  // checkpoint() is async and signals cancel by throwing, so a fire-and-forget
  // `.catch(() => cancelled = true)` resolved a microtask too late and the
  // synchronous while-loop below claimed another full wave of billable renders.
  assert.ok(/await progressRun\.checkpoint\(\)/.test(loopSrc),
    'checkpoint() must be awaited so Stop takes effect before the next claim');
  assert.ok(!/progressRun\.checkpoint\(\)\.catch\(/.test(loopSrc),
    'the fire-and-forget checkpoint is the race that let renders start after Stop');
});

check('Stop: the dispatch loop cannot die on an unhandled rejection', () => {
  // dispatch() became async; an unhandled rejection would take the process
  // down instead of ending the batch.
  assert.ok(/dispatch\(\)\.catch\(/.test(loopSrc),
    'async dispatch() calls need a catch');
});

check('Stop: operator cancellation is recorded on the run', () => {
  assert.ok(/stage: 'cancel'/.test(loopSrc), 'cancellation should be visible on the CampaignRun');
});

// ── summary ─────────────────────────────────────────────────────────

(async () => {
  for (const run of asyncChecks) await run();
  const total = passed + failed;
  console.log(`${passed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
})();
