#!/usr/bin/env node
/**
 * Behavioural harness for the queued-leftover OPERATOR NOTICE.
 *
 * WHY THIS IS NOT A SOURCE-TEXT CHECK. Most of verifyNoStrandedQueued asserts on
 * the sweeper's SOURCE (`/sweepQueuedLeftovers/.test(workerSrc)`). That style
 * cannot distinguish "the notice fires with true wording" from "a function with
 * the right name exists", and it passes against any reimplementation that keeps
 * the identifier. So this harness CALLS sweepQueuedLeftovers() against stubbed
 * models and a stubbed alertService, and asserts on what actually happened.
 *
 * What it pins:
 *   A. A successful archive emits exactly one operator notice, carrying the
 *      archived count.
 *   B. The wording is TRUTHFUL — it states the rows were never started and never
 *      billed, and it must NOT claim an interruption or that in-progress work was
 *      removed. receiptFree() + renderUrl-empty + renderAttempts-0 make such an ad
 *      unreachable from this pass, so that claim would be a false alarm, and a
 *      false alarm is worse than the silence it replaces.
 *   C. Slack failure CANNOT break the sweep. The archive is already committed
 *      when the notice is attempted; a transport error must not surface as a
 *      sweep failure or trigger a retry.
 *   D. Nothing archived ⇒ no notice (no empty-channel noise).
 *
 * Run: node scripts/verifyQueuedArchiveNotice.js   (no DB, no network, no key)
 */
const assert = require('assert');
const path   = require('path');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (e) { fail++; console.log(`  ✗ ${label} — ${String(e.message).split('\n')[0].slice(0, 200)}`); }
}

const SWEEPER = require.resolve('../services/queuedArchiveSweeper');
const AD      = require.resolve('../models/Ad');
const RUN     = require.resolve('../models/CampaignRun');
const ALERTS  = require.resolve('../services/alertService');

/**
 * Install stubs, run one sweep, return { result, notices, threw }.
 * `notifyBehaviour` lets a case make the notifier explode.
 */
function runSweep({ candidates = [], modifiedCount = null, notifyBehaviour = null } = {}) {
  for (const m of [SWEEPER, AD, RUN, ALERTS]) delete require.cache[m];

  const notices = [];
  require.cache[ALERTS] = {
    id: ALERTS, filename: ALERTS, loaded: true,
    exports: {
      notifyAsync(opts) {
        notices.push(opts);
        if (notifyBehaviour === 'throw') throw new Error('slack exploded');
        return undefined;
      },
      notify: async () => true,
      isConfigured: () => true
    }
  };

  const chain = (rows) => ({
    sort() { return this; }, select() { return this; }, limit() { return this; },
    lean: async () => rows
  });
  require.cache[AD] = {
    id: AD, filename: AD, loaded: true,
    exports: {
      find: (filter) => {
        // Terminal-run arm asks with campaignRunIds; empty-runId arm asks with $or.
        const wantsEmpty = JSON.stringify(filter || {}).includes('$size');
        return chain(wantsEmpty ? [] : candidates);
      },
      updateMany: async () => ({
        modifiedCount: modifiedCount == null ? candidates.length : modifiedCount
      }),
      countDocuments: async () => 0
    }
  };
  require.cache[RUN] = {
    id: RUN, filename: RUN, loaded: true,
    exports: { find: () => chain([{ runId: 'run_terminal_1' }]) }
  };

  process.env.QUEUED_ARCHIVE_ENABLED = 'true';
  const sweeper = require(SWEEPER);
  let result = null, threw = null;
  return sweeper.sweepQueuedLeftovers()
    .then(r => { result = r; })
    .catch(e => { threw = e; })
    .then(() => ({ result, notices, threw }));
}

const CANDIDATES = [
  { _id: 'a1', brandId: 'brandX', campaignRunIds: ['run_terminal_1'] },
  { _id: 'a2', brandId: 'brandX', campaignRunIds: ['run_terminal_1'] },
  { _id: 'a3', brandId: 'brandY', campaignRunIds: ['run_terminal_1'] }
];

(async () => {
  console.log('\nQueued-leftover operator notice — behavioural');

  // ── A + B ────────────────────────────────────────────────────────────
  const okRun = await runSweep({ candidates: CANDIDATES });
  check('A1 a successful archive emits exactly ONE operator notice', () => {
    assert.strictEqual(okRun.threw, null, `sweep threw: ${okRun.threw && okRun.threw.message}`);
    assert.strictEqual(okRun.notices.length, 1, `expected 1 notice, got ${okRun.notices.length}`);
  });
  check('A2 the notice carries the archived count', () => {
    const n = okRun.notices[0];
    assert.ok(String(n.title).includes('3'), `title lacks the count: ${n.title}`);
    assert.strictEqual(String(n.fields.archived), '3');
  });
  check('A3 the notice names the affected brands', () => {
    const f = String(okRun.notices[0].fields.brands);
    assert.ok(f.includes('brandX') && f.includes('brandY'), `brands missing: ${f}`);
  });
  check('B1 [TRUTH] the notice states never-started and never-billed', () => {
    const d = String(okRun.notices[0].detail).toUpperCase();
    assert.ok(d.includes('NEVER STARTED'), 'missing "never started"');
    assert.ok(d.includes('NEVER BILLED'), 'missing "never billed"');
  });
  check('B2 [TRUTH] the notice does NOT claim an interruption or lost in-progress work', () => {
    const d = String(okRun.notices[0].detail).toLowerCase();
    for (const banned of ['was interrupted', 'generation interrupted', 'in-progress ads were deleted', 'in progress ads were deleted']) {
      assert.ok(!d.includes(banned), `notice makes a false claim: "${banned}"`);
    }
  });

  // ── C: Slack must never break the sweep ──────────────────────────────
  const boom = await runSweep({ candidates: CANDIDATES, notifyBehaviour: 'throw' });
  check('C1 a throwing notifier does not throw out of the sweep', () => {
    assert.strictEqual(boom.threw, null, `sweep threw: ${boom.threw && boom.threw.message}`);
  });
  check('C2 the archive result survives a notifier failure', () => {
    assert.ok(boom.result, 'no result returned');
    assert.strictEqual(boom.result.archived, 3, `archived=${boom.result && boom.result.archived}`);
  });

  // ── D: silence when nothing was archived ─────────────────────────────
  const none = await runSweep({ candidates: CANDIDATES, modifiedCount: 0 });
  check('D1 nothing archived ⇒ no notice (no empty-channel noise)', () => {
    assert.strictEqual(none.notices.length, 0, `expected 0 notices, got ${none.notices.length}`);
  });

  // ── E: partial writes are reported honestly ──────────────────────────
  const partial = await runSweep({ candidates: CANDIDATES, modifiedCount: 2 });
  check('E1 considered > archived is disclosed, not glossed', () => {
    assert.strictEqual(partial.notices.length, 1);
    const n = partial.notices[0];
    assert.strictEqual(String(n.fields.archived), '2');
    assert.strictEqual(String(n.fields.considered), '3');
    assert.ok(/left alone/i.test(String(n.detail)), 'partial write not explained in the detail');
  });

  console.log(`\n${fail ? '❌' : '✅'} verifyQueuedArchiveNotice: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
