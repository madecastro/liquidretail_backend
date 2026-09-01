#!/usr/bin/env node
'use strict';
//
// verifyAdPhaseParity — closes the LAST two surfaces PR #365 left untouched.
//
// services/adPhase.js's own header names THREE independent places that used
// to derive "what state is this ad in" from the same raw Ad fields and could
// disagree: the Product Ads tile (frontend, via routes/ads.js/routes/
// catalog.js/routes/campaigns.js `phase`/`failure`), services/
// campaignRunGuards.js `classifyRunAdOutcome`, and services/runFeedService.js
// (Slack's live run feed — the count line AND the failure-reason grouping).
// PR #365 wired the first surface. This harness pins the retrofit of the
// other two onto the SAME `deriveAdPhase`/`describeAdFailure` — not a fourth
// re-derivation, and not a re-derivation that happens to agree today by
// coincidence.
//
// THIS IS A REFACTOR, NOT A REWRITE. Every check below either:
//   (a) proves the retrofitted function still produces the EXACT bucket the
//       pre-adPhase switch would have (parity, not new behaviour), or
//   (b) proves it now goes through deriveAdPhase/describeAdFailure
//       structurally, so a future edit to adPhase.js's phase rules cannot
//       silently stop propagating to the run counters or Slack.
//
// Money-adjacent scope, read before touching either retrofitted function:
// classifyRunAdOutcome feeds CampaignRun.succeeded/failed and
// buildRunReconciliationUpdate's `isSettled`/`needsRetry` — see
// scripts/verifyTitlingDeliveryTruth.js (the pre-existing harness pinning
// its exact fixture behaviour, still 39/39 after this retrofit) and
// campaignRunGuards.js's own updated header for the equivalence proof this
// harness exercises behaviourally.
//
// Offline only: no DB, no network, no API key.
//   node scripts/verifyAdPhaseParity.js
//
// REVERT-PROVEN 2026-08-31 (both applied directly, run, confirmed RED, then
// `git checkout --` to restore — confirmed GREEN again after restore):
//   1. In services/campaignRunGuards.js, changed `if (phase === 'complete')`
//      to `if (phase === 'failed-terminal')` inside classifyRunAdOutcome →
//      every Group B "succeeded" assertion failed (the complete fixtures
//      were counted as failed instead), proving Group B actually drives the
//      real function rather than a hand-rolled reimplementation.
//   2. In services/runFeedService.js, changed summariseFailures's
//      `failure.isQc` guard to `false` (never prefixes "QC Fail —") →
//      Group D's "message without the word QC still reads QC Fail" case
//      failed, proving that assertion actually exercises describeAdFailure
//      rather than the message-text regex alone.
// Both restored via `git checkout -- <file>` before this file was
// finalized; `git diff` on both was empty.

const fs   = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const { deriveAdPhase, describeAdFailure } = require('../services/adPhase');
const { classifyRunAdOutcome } = require('../services/campaignRunGuards');

let pass = 0;
const failures = [];
function ok(label, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    failures.push(`${label}\n      ${err.message}`);
  }
}

// ── A: structural — both retrofitted call sites actually CALL the
// canonical functions, not just import them ─────────────────────────────
const GUARDS_SRC = read('services', 'campaignRunGuards.js');
const FEED_SRC   = read('services', 'runFeedService.js');

ok('A1 campaignRunGuards.js imports deriveAdPhase from ./adPhase', () => {
  assert.match(GUARDS_SRC, /require\(['"]\.\/adPhase['"]\)/);
});
ok('A2 classifyRunAdOutcome actually CALLS deriveAdPhase (not just imports it)', () => {
  const start = GUARDS_SRC.indexOf('function classifyRunAdOutcome');
  assert.ok(start !== -1, 'classifyRunAdOutcome not found');
  const end = GUARDS_SRC.indexOf('\nfunction ', start + 10);
  const body = GUARDS_SRC.slice(start, end === -1 ? undefined : end);
  assert.match(body, /deriveAdPhase\(ad\)/);
});
ok('A3 runFeedService.js summariseFailures calls deriveAdPhase AND describeAdFailure', () => {
  const start = FEED_SRC.indexOf('async function summariseFailures');
  assert.ok(start !== -1, 'summariseFailures not found');
  const end = FEED_SRC.indexOf('\nasync function ', start + 10);
  const body = FEED_SRC.slice(start, end === -1 ? undefined : end);
  assert.match(body, /deriveAdPhase\(ad\)/);
  assert.match(body, /describeAdFailure\(ad, phase\)/);
});
ok('A4 runFeedService.js loadLiveSnapshot calls classifyRunAdOutcome (not a re-derived tally)', () => {
  const start = FEED_SRC.indexOf('async function loadLiveSnapshot');
  assert.ok(start !== -1, 'loadLiveSnapshot not found');
  const end = FEED_SRC.indexOf('\nasync function ', start + 10);
  const body = FEED_SRC.slice(start, end === -1 ? undefined : end);
  assert.match(body, /classifyRunAdOutcome\(/);
});
ok('A5 buildParentText annotates the draft count with the SAME titlingIncomplete field, not a re-derivation', () => {
  const start = FEED_SRC.indexOf('function buildParentText');
  assert.ok(start !== -1, 'buildParentText not found');
  const end = FEED_SRC.indexOf('\nfunction ', start + 10);
  const body = FEED_SRC.slice(start, end === -1 ? undefined : end);
  assert.match(body, /live\?\.titlingIncomplete/);
});

// ── B: behavioural parity — classifyRunAdOutcome's bucket for a fixture
// must match what deriveAdPhase says about the SAME fixture, via the
// documented mapping (complete→succeeded; failed-terminal/qc-failed-kept→
// failed; everything else keyed on raw status, exactly as the pre-adPhase
// switch was). This is the "drive fixtures through BOTH functions and
// confirm they agree" check. ──────────────────────────────────────────
const NOW = new Date('2026-08-31T12:00:00Z').getTime();

function mkAd(overrides = {}) {
  return Object.assign({
    kind: 'image',
    status: 'rendering',
    claimedByWorker: null,
    claimedAt: NOW,
    renderStage: null,
    renderStageAt: NOW,
    updatedAt: NOW
  }, overrides);
}

// Expected bucket, computed from deriveAdPhase's OWN answer plus the raw
// status the pre-adPhase switch keyed non-terminal buckets on — this is a
// restatement of the documented mapping, not a call into
// classifyRunAdOutcome, so it is a real cross-check rather than the
// function agreeing with itself.
function expectedBucket(ad) {
  const phase = deriveAdPhase(ad, { now: NOW });
  if (phase === 'complete') return 'succeeded';
  if (phase === 'failed-terminal' || phase === 'qc-failed-kept') return 'failed';
  if (ad.status === 'rendering') return 'stillRendering';
  if (ad.status === 'queued') return 'requeuedAway';
  if (ad.status === 'draft' || ad.status === 'live' || ad.status === 'archived') return 'titlingIncomplete';
  return null; // not counted either way
}

const FIXTURES = [
  ['complete image (draft)', mkAd({ kind: 'image', status: 'draft', renderUrl: 'https://c/img.jpg' })],
  ['complete video (genuinely titled)', mkAd({
    kind: 'video', status: 'draft', renderUrl: 'https://c/titled.mp4',
    veoVideoUrl: 'https://c/master.mp4', titlingResumeState: null, renderStage: 'done'
  })],
  ['complete video (declared no-brand ship)', mkAd({
    kind: 'video', status: 'live', renderUrl: 'https://c/master.mp4',
    veoVideoUrl: 'https://c/master.mp4', titlingResumeState: null,
    renderStage: 'no titling (no brand) — shipping master'
  })],
  ['qc-failed-kept', mkAd({
    kind: 'image', status: 'failed', renderUrl: 'https://c/img.jpg',
    visionQc: { passed: false, skipped: false, attempts: [] }
  })],
  ['failed-terminal (no QC verdict)', mkAd({
    kind: 'image', status: 'failed', renderUrl: null, visionQc: null
  })],
  ['failed-terminal (video, generic render failure)', mkAd({
    kind: 'video', status: 'failed', renderUrl: null, veoVideoUrl: null, visionQc: null
  })],
  ['titling (claimed video mid-composite)', mkAd({
    kind: 'video', status: 'draft', renderUrl: 'https://c/master.mp4',
    veoVideoUrl: 'https://c/master.mp4', titlingResumeState: 'claimed',
    renderStage: 'titling 9:16', claimedByWorker: 'w1'
  })],
  ['awaiting-titler (handed off, unclaimed)', mkAd({
    kind: 'video', status: 'draft', renderUrl: 'https://c/master.mp4',
    veoVideoUrl: 'https://c/master.mp4', titlingNeeded: true, claimedByWorker: null
  })],
  ['quality-check (verdict not yet stamped)', mkAd({
    kind: 'video', status: 'draft', renderUrl: 'https://c/master.mp4',
    veoVideoUrl: 'https://c/master.mp4', renderStage: 'vision QC (video)', visionQc: null
  })],
  ['skipped-derivative (archived, never rendered/billed)', mkAd({
    kind: 'video', status: 'archived', renderUrl: null, veoPredictionId: null,
    veoVideoUrl: null
  })],
  // THE case that proves stillRendering/requeuedAway cannot move onto
  // phase alone: the IDENTICAL phase ('awaiting-master') from two
  // different raw statuses must land in two different old-style buckets.
  ['awaiting-master, claim held (status:rendering)', mkAd({
    kind: 'video', status: 'rendering', deriveFromMaster: 'meta_stories_9_16',
    veoVideoUrl: null, claimedByWorker: 'w1'
  })],
  ['awaiting-master, claim released (status:queued)', mkAd({
    kind: 'video', status: 'queued', deriveFromMaster: 'meta_stories_9_16',
    veoVideoUrl: null, claimedByWorker: null
  })],
  ['generating-master (claimed, has stage)', mkAd({
    kind: 'image', status: 'rendering', claimedByWorker: 'w1',
    renderStage: 'static image generation'
  })],
  ['claimed (no stage breadcrumb yet)', mkAd({
    kind: 'image', status: 'rendering', claimedByWorker: 'w1', renderStage: null
  })],
  ['deferred-retrying (released, not yet reclaimed)', mkAd({
    kind: 'image', status: 'rendering', claimedByWorker: null
  })],
  ['plain queued', mkAd({ kind: 'image', status: 'queued', claimedByWorker: null })]
];

for (const [label, ad] of FIXTURES) {
  ok(`B ${label}: classifyRunAdOutcome bucket matches deriveAdPhase's implied bucket`, () => {
    const expected = expectedBucket(ad);
    const outcome = classifyRunAdOutcome([ad]);
    const buckets = ['succeeded', 'failed', 'stillRendering', 'requeuedAway', 'titlingIncomplete'];
    for (const b of buckets) {
      const want = (b === expected) ? 1 : 0;
      assert.strictEqual(outcome[b], want,
        `expected ${expected || 'none'}, got {${buckets.map((k) => `${k}:${outcome[k]}`).join(',')}}`);
    }
  });
}

ok('B-total a mixed batch sums buckets independently (no cross-contamination)', () => {
  const outcome = classifyRunAdOutcome(FIXTURES.map(([, ad]) => ad));
  const expectedCounts = { succeeded: 0, failed: 0, stillRendering: 0, requeuedAway: 0, titlingIncomplete: 0 };
  for (const [, ad] of FIXTURES) {
    const b = expectedBucket(ad);
    if (b) expectedCounts[b]++;
  }
  for (const k of Object.keys(expectedCounts)) {
    assert.strictEqual(outcome[k], expectedCounts[k], `bucket ${k}: expected ${expectedCounts[k]}, got ${outcome[k]}`);
  }
});

// ── C: pre-existing verifyTitlingDeliveryTruth.js fixtures re-asserted
// here too — belt and braces so a future edit to THAT file cannot silently
// stop covering the retrofit this file exists to pin. ───────────────────
{
  const TITLED_VIDEO = mkAd({
    kind: 'video', status: 'draft', renderUrl: 'https://c/titled.mp4',
    veoVideoUrl: 'https://c/master.mp4', titlingResumeState: null, renderStage: 'done'
  });
  const UNTITLED_ABANDONED = mkAd({
    kind: 'video', status: 'draft', renderUrl: 'https://c/master.mp4',
    veoVideoUrl: 'https://c/master.mp4', titlingResumeState: null, renderStage: 'titling 4:5'
  });
  const IMAGE_AD = mkAd({ kind: 'image', status: 'draft', renderUrl: 'https://c/img.jpg' });

  ok('C1 incident shape (orphaned untitled master) is titlingIncomplete, never succeeded', () => {
    const o = classifyRunAdOutcome([TITLED_VIDEO, UNTITLED_ABANDONED, IMAGE_AD]);
    assert.strictEqual(o.succeeded, 2);
    assert.strictEqual(o.titlingIncomplete, 1);
    assert.strictEqual(o.isSettled, false);
  });
}

// ── D: runFeedService summariseFailures parity — the label it prefixes
// must be driven by describeAdFailure(ad, phase).isQc, not a substring
// match on the message alone. Uses the file's OWN _setDeps({Ad}) seam
// (the same one loadLiveSnapshot already offered; summariseFailures was
// retrofitted in this change to use AdModel() instead of a direct
// require('../models/Ad') specifically so this stays offline without
// monkeypatching module resolution). ─────────────────────────────────────
function fakeAdWithRows(rows) {
  return {
    find: () => ({
      select() { return this; },
      limit() { return this; },
      lean: async () => rows
    })
  };
}

async function testSummariseFailures() {
  const feed = require('../services/runFeedService');

  feed._setDeps({
    Ad: fakeAdWithRows([{
      renderError: { message: 'video ad failed vision QC (no regeneration): bad crop', stage: 'vision-qc' },
      renderUrl: 'https://c/master.mp4',
      visionQc: { passed: false, skipped: false, attempts: [] }
    }])
  });
  {
    const reasons = await feed.summariseFailures('run_x');
    ok('D1 message that ALREADY says "vision QC" is not double-prefixed', () => {
      assert.strictEqual(reasons.length, 1);
      assert.strictEqual(reasons[0].reason, 'video ad failed vision QC');
    });
  }

  feed._setDeps({
    // Hypothetical future QC call site whose message text does not happen
    // to mention QC at all — describeAdFailure must still catch it.
    Ad: fakeAdWithRows([{
      renderError: { message: 'asset rejected by inspector: bad logo', stage: 'vision-qc' },
      renderUrl: 'https://c/master.mp4',
      visionQc: { passed: false, skipped: false, attempts: [] }
    }])
  });
  {
    const reasons = await feed.summariseFailures('run_x');
    ok('D2 a QC failure whose message text does NOT say "QC" still gets prefixed "QC Fail —"', () => {
      assert.strictEqual(reasons.length, 1);
      assert.strictEqual(reasons[0].reason, 'QC Fail — asset rejected by inspector: bad logo');
    });
  }

  feed._setDeps({
    Ad: fakeAdWithRows([{
      renderError: { message: 'Model Moderation Error: policy', stage: 'render' },
      renderUrl: null,
      visionQc: null
    }])
  });
  {
    const reasons = await feed.summariseFailures('run_x');
    ok('D3 a non-QC render failure is NOT prefixed (would just be noise on every line)', () => {
      assert.strictEqual(reasons.length, 1);
      assert.strictEqual(reasons[0].reason, 'Model Moderation Error: policy');
    });
  }

  feed._resetState();
}

// ── E: describeAdFailure/deriveAdPhase agreement — the label
// summariseFailures/routes/ads.js would show for the SAME doc must match. ─
ok('E1 describeAdFailure(ad, deriveAdPhase(ad)) agrees for a qc-failed-kept fixture', () => {
  const ad = mkAd({
    kind: 'video', status: 'failed', renderUrl: 'https://c/master.mp4',
    visionQc: { passed: false, skipped: false, attempts: [] },
    renderError: { stage: 'vision-qc' }
  });
  const phase = deriveAdPhase(ad, { now: NOW });
  assert.strictEqual(phase, 'qc-failed-kept');
  const failure = describeAdFailure(ad, phase);
  assert.strictEqual(failure.label, 'QC Fail');
  assert.strictEqual(failure.isQc, true);
});

// ── F: end-to-end — loadLiveSnapshot/buildParentText via the real Slack
// flush path (_flushOnce), the same seams scripts/verifyRunFeed.js uses.
// Proves the wiring reaches the actual posted Slack text, not just that the
// two functions are called in isolation. ─────────────────────────────────
function makeClaimStore() {
  const byRunId = new Map();
  return {
    seed(runId, slackFeed = null) { byRunId.set(String(runId), { runId: String(runId), slackFeed }); },
    async updateOne(filter, update) {
      const rid = String(filter.runId);
      let doc = byRunId.get(rid);
      if (!doc) { doc = { runId: rid, slackFeed: null }; byRunId.set(rid, doc); }
      const ts = doc.slackFeed && doc.slackFeed.ts;
      if (ts != null && ts !== '') return { modifiedCount: 0 };
      if (update.$set && update.$set.slackFeed) {
        doc.slackFeed = { ts: update.$set.slackFeed.ts, channel: update.$set.slackFeed.channel };
        return { modifiedCount: 1 };
      }
      return { modifiedCount: 0 };
    },
    async findOne(filter) { return byRunId.get(String(filter.runId)) || null; }
  };
}
async function testLoadLiveSnapshotAnnotation() {
  const feed = require('../services/runFeedService');
  const store = makeClaimStore();
  store.seed('run_titling', null);

  const fetchCalls = [];
  const fakeFetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    if (String(url).includes('chat.postMessage')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: '10.1', channel: 'C1' }) };
    }
    if (String(url).includes('chat.update')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  };

  // Two video ads: one genuinely complete, one mid-titling (draft, raw
  // master parked on renderUrl, no declared-intentional-ship stage).
  const rows = [
    {
      _id: 'a1', status: 'draft', kind: 'video',
      renderUrl: 'https://c/titled.mp4', veoVideoUrl: 'https://c/master.mp4',
      titlingResumeState: null, renderStage: 'done'
    },
    {
      _id: 'a2', status: 'draft', kind: 'video',
      renderUrl: 'https://c/master.mp4', veoVideoUrl: 'https://c/master.mp4',
      titlingResumeState: 'claimed', renderStage: 'titling 9:16'
    }
  ];

  feed._resetState();
  process.env.SLACK_BOT_TOKEN = ['xoxb', 'test', 'parity'].join('-');
  process.env.SLACK_ALERT_CHANNEL_STATUS = 'C_PARITY';
  process.env.RUN_FEED_ENABLED = 'true';
  process.env.RUN_FEED_PARENT_THROTTLE_MS = '0';
  feed._setDeps({
    CampaignRun: {
      updateOne: (f, u) => store.updateOne(f, u),
      findOne: () => ({ select() { return this; }, lean: async () => null })
    },
    Ad: fakeAdWithRows(rows),
    fetch: fakeFetch,
    // Advancing clock — PARENT_THROTTLE_MS() floors at 1000ms even with the
    // env var set to '0', so a fixed `now` would never let the SECOND flush
    // (the one that actually calls loadLiveSnapshot) past the throttle.
    now: (() => { let t = 1_700_000_000_000; return () => (t += 5000); })()
  });
  feed.startRun({ runId: 'run_titling', total: 2, adIds: ['a1', 'a2'] });
  // First flush: ensureParent creates + claims the parent message from a
  // bare {now} snapshot (no counts yet) and resets parentDirty itself —
  // that first post never carries the annotation. A second event + flush
  // is what triggers the THROTTLED update, which is the one that actually
  // runs loadLiveSnapshot and calls buildParentText with real counts.
  await feed._flushOnce();
  feed.noteEvent('run_titling', 'recheck'); // re-marks parentDirty for the second flush
  await feed._flushOnce();

  const parentUpdate = fetchCalls.find((c) => c.url.includes('chat.update'));
  const parentText = parentUpdate ? JSON.parse(parentUpdate.opts.body).text : null;

  ok('F1 loadLiveSnapshot+buildParentText end-to-end: 2 raw-draft video ads (1 complete, 1 mid-titling) read "2 draft (1 still titling)"', () => {
    assert.ok(parentText, 'no chat.update captured');
    assert.match(parentText, /\b2 draft \(1 still titling\)/);
  });

  feed._resetState();
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_ALERT_CHANNEL_STATUS;
  delete process.env.RUN_FEED_ENABLED;
  delete process.env.RUN_FEED_PARENT_THROTTLE_MS;
}

async function main() {
  await testSummariseFailures();
  await testLoadLiveSnapshotAnnotation();

  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifyAdPhaseParity: ${pass}/${total} passed, ${failures.length} FAILED`);
    for (const f of failures) console.error('  FAIL', f);
    process.exit(1);
  }
  console.log(`verifyAdPhaseParity: ${pass}/${total} passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error('verifyAdPhaseParity: uncaught error', err);
  process.exit(1);
});
