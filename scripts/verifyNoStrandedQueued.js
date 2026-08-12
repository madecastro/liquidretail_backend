#!/usr/bin/env node
'use strict';
//
// verifyNoStrandedQueued — leftovers expandWizardJob minted and
// selectAdsForRun never claimed must not sit status:'queued' forever,
// because a later Generate on the same product can claim and BILL them.
//
// THE MEASURED DEFECT (2026-08-12). Production had 345 ads in
// status:'queued', oldest 2026-06-01, all receipt-free / renderUrl-null /
// renderAttempts:0. 180 belonged to campaigns that no longer existed.
// MAX_CREATIVES_PER_RUN (20) claimed a slice; CampaignRun.total was stamped
// with the claim count so even the progress bar hid the gap.
//
// THE FIX, three parts:
//   A) CampaignRun.mintedTotal / unclaimedAtStart — `total` stays the claim
//      count so the progress bar denominator is honest.
//   B) A non-blocking notice (same { code, message } shape as
//      concurrent-run-shares-products) naming how many ads were minted
//      but not claimed.
//   C) An archive sweep: leftover queued ads whose minting run is terminal
//      and older than QUEUED_ARCHIVE_AFTER_H move to status:'archived'.
//
// These checks evaluate the REAL filter object against REAL document shapes
// — not a regex over the source. A source-text assertion cannot tell a
// working query from one that merely still contains the right words.
//
// Revert-prove (each mutation must fail this harness):
//   1. Drop receiptFree() from buildQueuedArchiveFilter
//        → C1/C2 fail (a receipt-holding ad is selected — the money hole)
//   2. Include status:'running' in buildTerminalRunFilter
//        → D1 fails (an in-flight run's leftovers are selected)
//   3. Drop the mintedTotal / notice $set after claim
//        → E* fail
//   4. Stop calling Ad.find(buildQueuedArchiveFilter(...))
//        → F3 fails (these checks would be testing a copy)
//   5. Re-implement the receipt clauses inline instead of importing
//        receiptFree → F2 fails (the unbound-identifier production incident)
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyNoStrandedQueued.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildQueuedArchiveFilter,
  buildTerminalRunFilter,
  buildQueuedArchiveWriteFilter,
  buildEmptyRunIdArchiveFilter,
  ENABLED,
  afterHours,
  maxAds,
  TERMINAL_RUN_STATUSES
} = require('../services/queuedArchiveSweeper');
const { receiptFree } = require('../services/spendReceipt');
const {
  buildUnclaimedNotice, UNCLAIMED_NOTICE_CODE, buildOverlapNotice
} = require('../services/generationGate');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyNoStrandedQueued\n');

// ── A tiny Mongo matcher, covering exactly the operators this filter uses.
// Deliberately NOT a general implementation: it throws on anything it does not
// understand, so a future operator added to the query cannot be silently
// mis-evaluated into a false pass.
function getPath(doc, key) {
  if (Object.prototype.hasOwnProperty.call(doc, key) || !key.includes('.')) return doc[key];
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

function matchOp(value, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === '$ne') { if (value === operand) return false; }
      else if (op === '$lt') { if (!(value != null && value < operand)) return false; }
      else if (op === '$in') {
        // Mongo: missing field equals null; array field matches if ANY
        // element is in the operand (campaignRunIds: { $in: [...] }).
        if (value === undefined && operand.includes(null)) continue;
        if (Array.isArray(value)) {
          if (!value.some((v) => operand.includes(v))) return false;
        } else if (!operand.includes(value)) return false;
      } else if (op === '$nin') {
        if (Array.isArray(value)) {
          if (value.some((v) => operand.includes(v))) return false;
        } else if (operand.includes(value)) return false;
      } else if (op === '$elemMatch') {
        if (!Array.isArray(value) || !value.some((v) => matchOp(v, operand))) return false;
      } else if (op === '$not') {
        if (matchOp(value, operand)) return false;
      } else if (op === '$size') {
        if (!Array.isArray(value) || value.length !== operand) return false;
      } else if (op === '$exists') {
        const exists = value !== undefined;
        if (operand ? !exists : exists) return false;
      } else {
        throw new Error(`matcher does not implement operator ${op} — extend it deliberately`);
      }
    }
    return true;
  }
  // Mongo treats a missing field and an explicit null as equal for `field: null`.
  if (cond === null) return value === null || value === undefined;
  return value === cond;
}

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some((sub) => matches(doc, sub))) return false;
    } else if (key === '$and') {
      if (!cond.every((sub) => matches(doc, sub))) return false;
    } else if (key.startsWith('$')) {
      throw new Error(`matcher does not implement top-level ${key}`);
    } else if (!matchOp(getPath(doc, key), cond)) return false;
  }
  return true;
}

const NOW = new Date('2026-08-12T18:00:00Z');
const OLD = new Date(NOW.getTime() - 36 * 60 * 60 * 1000);   // 36h — past the 24h default
const FRESH = new Date(NOW.getTime() - 30 * 60 * 1000);      // 30m — still in the render-more window
const TERMINAL = ['run_done_1', 'run_failed_1'];
const FILTER = buildQueuedArchiveFilter({ terminalRunIds: TERMINAL, olderThan: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) });
const RUN_FILTER = buildTerminalRunFilter(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));

function leftover(over = {}) {
  return {
    status: 'queued',
    campaignRunIds: ['run_done_1'],
    queuedAt: OLD,
    renderUrl: null,
    renderAttempts: 0,
    veoPredictionId: null,
    imageGeneration: { predictionId: null },
    ...over
  };
}

// ── Group A — the matcher itself is trustworthy.
ok('A1 matcher: exact equality', () => {
  assert.strictEqual(matches({ a: 1 }, { a: 1 }), true);
  assert.strictEqual(matches({ a: 2 }, { a: 1 }), false);
});
ok('A2 matcher: $ne, $lt, $in, $exists', () => {
  assert.strictEqual(matches({ a: 'x' }, { a: { $ne: null } }), true);
  assert.strictEqual(matches({ t: OLD }, { t: { $lt: NOW } }), true);
  assert.strictEqual(matches({ t: NOW }, { t: { $lt: OLD } }), false);
  assert.strictEqual(matches({ ids: ['run_done_1'] }, { ids: { $in: TERMINAL } }), true);
  assert.strictEqual(matches({ ids: ['run_other'] }, { ids: { $in: TERMINAL } }), false);
  assert.strictEqual(matches({}, { veoPredictionId: { $exists: false } }), true);
  assert.strictEqual(matches({ veoPredictionId: 'p' }, { veoPredictionId: { $exists: false } }), false);
});
ok('A3 matcher: missing field equals explicit null (Mongo semantics)', () => {
  assert.strictEqual(matches({}, { a: null }), true);
  assert.strictEqual(matches({ a: undefined }, { a: null }), true);
});
ok('A4 matcher: $or / $and', () => {
  assert.strictEqual(matches({ a: 1 }, { $or: [{ a: 9 }, { a: 1 }] }), true);
  assert.strictEqual(matches({ a: 1, b: 2 }, { $and: [{ a: 1 }, { b: 2 }] }), true);
  assert.strictEqual(matches({ a: 1, b: 3 }, { $and: [{ a: 1 }, { b: 2 }] }), false);
});
ok('A5 matcher refuses an operator it does not implement', () => {
  assert.throws(() => matches({ a: 1 }, { a: { $gte: 1 } }), /does not implement/);
});
ok('A5b matcher: $not / $elemMatch / $nin (all-owners-terminal predicate)', () => {
  const pred = { ids: { $in: ['a'], $not: { $elemMatch: { $nin: ['a'] } } } };
  assert.strictEqual(matches({ ids: ['a'] }, pred), true);
  assert.strictEqual(matches({ ids: ['a', 'b'] }, pred), false);
  assert.strictEqual(matches({ ids: [] }, pred), false);
});
ok('A6 matcher: dotted path (imageGeneration.predictionId)', () => {
  assert.strictEqual(
    matches({ imageGeneration: { predictionId: 'p1' } }, { 'imageGeneration.predictionId': { $in: [null, ''] } }),
    false
  );
  assert.strictEqual(
    matches({ imageGeneration: { predictionId: null } }, { 'imageGeneration.predictionId': { $in: [null, ''] } }),
    true
  );
});

// ── Group B — the leftover the incident produced MUST be selected.
ok('B1 [THE BUG] an inert leftover from a terminal run is selected', () => {
  assert.strictEqual(matches(leftover(), FILTER), true,
    'the 345 prod leftovers would still be invisible to the sweeper');
});
ok('B2 a leftover from a FAILED run is selected too (terminal = done|failed)', () => {
  assert.strictEqual(matches(leftover({ campaignRunIds: ['run_failed_1'] }), FILTER), true);
});
ok('B3 a leftover whose queuedAt is still inside the render-more window is NOT selected', () => {
  assert.strictEqual(matches(leftover({ queuedAt: FRESH }), FILTER), false,
    'same-day POST /runs ("Generate more") must still be able to claim these');
});

// ── Group C — MONEY: a receipt / delivered asset / attempted render is never archived.
ok('C1 [MONEY] a leftover holding a VIDEO spend receipt is never selected', () => {
  assert.strictEqual(matches(leftover({ veoPredictionId: 'pred_omni_1' }), FILTER), false,
    'archiving a paid receipt would hide work we already bought');
});
ok('C2 [MONEY] a leftover holding a STATIC spend receipt is never selected', () => {
  assert.strictEqual(
    matches(leftover({ imageGeneration: { predictionId: 'pred_img_1' } }), FILTER),
    false,
    'imageGeneration.predictionId is the static receipt — same money rule'
  );
});
ok('C3 an ad with a renderUrl is never selected (something was delivered)', () => {
  assert.strictEqual(matches(leftover({ renderUrl: 'https://res.cloudinary.com/x/img.png' }), FILTER), false);
});
ok('C4 an ad with renderAttempts > 0 is never selected (work began)', () => {
  assert.strictEqual(matches(leftover({ renderAttempts: 1 }), FILTER), false);
});
ok('C5 already-archived / rendering / draft / failed / live are out of scope', () => {
  for (const status of ['archived', 'rendering', 'draft', 'failed', 'live']) {
    assert.strictEqual(matches(leftover({ status }), FILTER), false, `status '${status}' must not be swept`);
  }
});
ok('C6 a leftover owned by a run that is NOT in the terminal list is not selected', () => {
  assert.strictEqual(matches(leftover({ campaignRunIds: ['run_still_going'] }), FILTER), false);
});
ok('C6b [MONEY] an ad a LATER run also owns is not archived just because the minting run is old', () => {
  // Minted by run_done_1, then claimed by a newer run (POST /runs or a
  // later Generate). $addToSet leaves BOTH ids. $in:[run_done_1] would
  // still match; the $not/$elemMatch/$nin clause is what saves it.
  assert.strictEqual(
    matches(leftover({ campaignRunIds: ['run_done_1', 'run_still_going'] }), FILTER),
    false,
    'a second run still owns this leftover — archiving it would steal their claim'
  );
});
ok('C7 an empty terminal-run list matches nothing (fail-closed)', () => {
  const empty = buildQueuedArchiveFilter({ terminalRunIds: [], olderThan: OLD });
  assert.strictEqual(matches(leftover(), empty), false);
});
ok('C8 write filter refuses a receipt even when _id is already chosen', () => {
  const write = buildQueuedArchiveWriteFilter(['ad1']);
  assert.strictEqual(
    matches({ _id: 'ad1', status: 'queued', renderUrl: null, renderAttempts: 0, veoPredictionId: 'p' }, write),
    false
  );
  assert.strictEqual(
    matches({ _id: 'ad1', status: 'queued', renderUrl: null, renderAttempts: 0, veoPredictionId: null }, write),
    true
  );
});

// ── Group C-hist — the MEASURED incident shape: campaignRunIds:[] 
const EMPTY_FILTER = buildEmptyRunIdArchiveFilter({ olderThan: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) });
ok('C9 [THE INCIDENT] a leftover with empty campaignRunIds is selected by the historical arm', () => {
  assert.strictEqual(matches(leftover({ campaignRunIds: [] }), EMPTY_FILTER), true,
    'the 345 prod leftovers were minted with campaignRunIds:[] — this arm is what sees them');
});
ok('C10 a missing campaignRunIds field is selected (legacy rows)', () => {
  const doc = leftover();
  delete doc.campaignRunIds;
  assert.strictEqual(matches(doc, EMPTY_FILTER), true);
});
ok('C11 [MONEY] the historical arm still refuses a receipt', () => {
  assert.strictEqual(matches(leftover({ campaignRunIds: [], veoPredictionId: 'pred_1' }), EMPTY_FILTER), false);
});
ok('C12 a stamped leftover is NOT selected by the historical arm (owned arm covers it)', () => {
  assert.strictEqual(matches(leftover({ campaignRunIds: ['run_done_1'] }), EMPTY_FILTER), false);
});

// ── Group D — a run that is still in flight is never a source of archive ids.
ok('D1 [MONEY] buildTerminalRunFilter only accepts done/failed — never running/preparing', () => {
  assert.deepStrictEqual(TERMINAL_RUN_STATUSES.slice().sort(), ['done', 'failed']);
  assert.strictEqual(matches({ status: 'running', completedAt: OLD }, RUN_FILTER), false);
  assert.strictEqual(matches({ status: 'preparing', completedAt: OLD }, RUN_FILTER), false);
  assert.strictEqual(matches({ status: 'done', completedAt: OLD }, RUN_FILTER), true);
  assert.strictEqual(matches({ status: 'failed', completedAt: OLD }, RUN_FILTER), true);
});
ok('D2 a terminal run younger than the threshold is not selected', () => {
  assert.strictEqual(matches({ status: 'done', completedAt: FRESH }, RUN_FILTER), false);
});
ok('D3 a terminal run missing completedAt falls back to startedAt (still age-gated)', () => {
  assert.strictEqual(matches({ status: 'done', completedAt: null, startedAt: OLD }, RUN_FILTER), true);
  assert.strictEqual(matches({ status: 'done', completedAt: null, startedAt: FRESH }, RUN_FILTER), false);
});

// ── Group E — notice / totals. Drive the REAL builders.
ok('E1 buildUnclaimedNotice follows the overlap notice shape ({ code, message })', () => {
  const P1 = '64b000000000000000000001';
  const overlap = buildOverlapNotice({
    activeRuns: [{ runId: 'r1', requestedProductIds: [P1], createdAt: NOW }],
    requestedProductIds: [P1]
  });
  const unclaimed = buildUnclaimedNotice({ minted: 34, claimed: 20, unclaimed: 14 });
  assert.ok(overlap && typeof overlap.code === 'string' && typeof overlap.message === 'string');
  assert.ok(unclaimed && typeof unclaimed.code === 'string' && typeof unclaimed.message === 'string');
  assert.strictEqual(unclaimed.code, UNCLAIMED_NOTICE_CODE);
  assert.strictEqual(UNCLAIMED_NOTICE_CODE, 'minted-ads-unclaimed');
});
ok('E2 notice names the exact minted / claimed / unclaimed counts', () => {
  const n = buildUnclaimedNotice({ minted: 34, claimed: 20, unclaimed: 14 });
  assert.strictEqual(n.minted, 34);
  assert.strictEqual(n.claimed, 20);
  assert.strictEqual(n.unclaimed, 14);
  assert.ok(/14/.test(n.message) && /34/.test(n.message) && /20/.test(n.message));
  assert.ok(/will not render on their own/i.test(n.message));
});
ok('E3 no leftovers → null notice (do not nag a fully-claimed run)', () => {
  assert.strictEqual(buildUnclaimedNotice({ minted: 10, claimed: 10, unclaimed: 0 }), null);
  assert.strictEqual(buildUnclaimedNotice({ minted: 0, claimed: 0 }), null);
  assert.strictEqual(buildUnclaimedNotice({}), null);
});
ok('E4 claimed-of-minted (set-difference) wins over a naive minted-claimed when both are passed', () => {
  // 34 minted, 20 claimed of which 5 were OLD leftovers → 19 of THIS mint sit queued.
  const n = buildUnclaimedNotice({ minted: 34, claimed: 15, unclaimed: 19 });
  assert.strictEqual(n.unclaimed, 19);
  assert.strictEqual(n.claimed, 15);
});

// ── Group F — wiring. Comments STRIPPED before matching so a check cannot
// pass on its own explanatory prose (same lesson as verifyTitlingOrphanResume E*).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

const ROOT = path.join(__dirname, '..');
const adsSrc = stripComments(fs.readFileSync(path.join(ROOT, 'routes', 'ads.js'), 'utf8'));
const sweepSrc = stripComments(fs.readFileSync(path.join(ROOT, 'services', 'queuedArchiveSweeper.js'), 'utf8'));
const sweepRaw = fs.readFileSync(path.join(ROOT, 'services', 'queuedArchiveSweeper.js'), 'utf8');
const workerSrc = stripComments(fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8'));
const modelSrc = fs.readFileSync(path.join(ROOT, 'models', 'CampaignRun.js'), 'utf8');
const genSrc = stripComments(fs.readFileSync(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'), 'utf8'));
const defaultsSrc = fs.readFileSync(path.join(ROOT, 'config', 'defaults.env'), 'utf8');

ok('F1 sweeper IMPORTS receiptFree from spendReceipt (does not re-implement)', () => {
  // The unbound-identifier incident: a call without an import shipped to
  // prod with a green harness. Source-text of the call is not enough.
  assert.ok(
    /require\(\s*['"]\.\/spendReceipt['"]\s*\)/.test(sweepRaw),
    'queuedArchiveSweeper must require services/spendReceipt'
  );
  assert.ok(
    /receiptFree/.test(sweepSrc) && /const \{\s*receiptFree\s*\}/.test(sweepRaw),
    'receiptFree must be destructured from that require'
  );
});
ok('F2 filter builder CALLS receiptFree (the live query is not a hand-rolled copy)', () => {
  assert.ok(/return receiptFree\(/.test(sweepSrc));
  assert.ok(/function buildQueuedArchiveFilter/.test(sweepSrc));
});
ok('F3 the live query uses buildQueuedArchiveFilter — these checks test the real filter', () => {
  assert.ok(/Ad\.find\(buildQueuedArchiveFilter\(/.test(sweepSrc),
    'the live query must use buildQueuedArchiveFilter, or these checks test a copy');
});
ok('F3b historical empty-runId leftovers use buildEmptyRunIdArchiveFilter', () => {
  assert.ok(/Ad\.find\(buildEmptyRunIdArchiveFilter\(/.test(sweepSrc));
});
ok('F3c terminal-run query has NO per-pass limit (a capped unsorted $in starves leftovers)', () => {
  const i = sweepSrc.indexOf('CampaignRun.find(buildTerminalRunFilter');
  assert.ok(i > 0);
  const block = sweepSrc.slice(i, i + 220);
  assert.ok(!/\.limit\(/.test(block),
    'limit() on the terminal-run query can return the same N rows forever');
});
ok('F3d empty-runId arm skips campaigns with a preparing/running run', () => {
  assert.ok(/status:\s*\{\s*\$in:\s*\[\s*'preparing'\s*,\s*'running'\s*\]\s*\}/.test(sweepSrc));
});
ok('F4 write is status:archived — never a delete, never failed/queued flip', () => {
  assert.ok(/status:\s*['"]archived['"]/.test(sweepSrc));
  assert.ok(!/deleteMany|deleteOne|findOneAndDelete/.test(sweepSrc));
});
ok('F5 sweep is bounded per pass', () => {
  assert.ok(/\.limit\(maxAds\(\)\)/.test(sweepSrc));
});
ok('F6 CampaignRun declares mintedTotal, unclaimedAtStart, notice', () => {
  assert.ok(/mintedTotal:/.test(modelSrc));
  assert.ok(/unclaimedAtStart:/.test(modelSrc));
  assert.ok(/notice:\s*\{\s*type:\s*mongoose\.Schema\.Types\.Mixed/.test(modelSrc));
});
ok('E5 [TOTALS] after claim, the run is stamped mintedTotal + unclaimedAtStart + total=claimed', () => {
  // Pin the SUCCESS path (the one that also sets status:running), not the
  // empty-select early exits — those also write mintedTotal but have no claim.
  const i = adsSrc.indexOf("status: 'running'");
  assert.ok(i > 0, 'routes/ads.js never flips the run to running');
  const block = adsSrc.slice(Math.max(0, i - 900), i + 400);
  assert.ok(/total:\s*adIds\.length/.test(block), 'total must stay the claim count');
  assert.ok(/mintedTotal/.test(block));
  assert.ok(/unclaimedAtStart/.test(block));
  assert.ok(/buildUnclaimedNotice\(/.test(block), 'the overflow notice must be built from the real counts');
});
ok('E6 GET /runs returns mintedTotal, unclaimedAtStart, and notice (poller is where post-expand facts land)', () => {
  const i = adsSrc.indexOf("router.get('/runs/:runId'");
  assert.ok(i > 0);
  const body = adsSrc.slice(i, i + 2500);
  assert.ok(/mintedTotal:/.test(body));
  assert.ok(/unclaimedAtStart:/.test(body));
  assert.ok(/notice:/.test(body));
});
ok('E7 202 still returns notice in the existing shape (overlap, known at request time)', () => {
  const i = adsSrc.indexOf('res.status(202).json({');
  assert.ok(i > 0);
  const body = adsSrc.slice(i, i + 900);
  assert.ok(/notice:\s*gate\.notice\s*\|\|\s*null/.test(body));
});
ok('F7 mint stamps campaignRunIds so leftovers have an owning run', () => {
  assert.ok(/function mintedCampaignRunIds/.test(genSrc));
  const uses = genSrc.match(/campaignRunIds:\s*mintedCampaignRunIds\(generationRunId\)/g) || [];
  assert.ok(uses.length >= 3,
    `expected ≥3 payload sites to stamp mintedCampaignRunIds, found ${uses.length}`);
  assert.ok(!(/campaignRunIds:\s*\[\s*\]/.test(genSrc)),
    'a payload still mints with campaignRunIds:[] — leftovers from that path cannot be archived');
});
ok('F8 expandDeterministicVideo forwards generationRunId (video leftovers need an owner too)', () => {
  assert.ok(/generationRunId\s*=\s*null/.test(genSrc));
  const calls = [];
  const re = /expandDeterministicVideo\(\{/g;
  let m;
  while ((m = re.exec(genSrc))) calls.push(m.index);
  assert.ok(calls.length >= 5, `expected ≥5 expandDeterministicVideo calls, found ${calls.length}`);
  for (const idx of calls) {
    const block = genSrc.slice(idx, idx + 800);
    assert.ok(/generationRunId/.test(block),
      `expandDeterministicVideo call at offset ${idx} does not forward generationRunId`);
  }
});
ok('F9 worker.js wires the sweep (WORKER, not web — no Remotion / no submit)', () => {
  assert.ok(/sweepQueuedLeftovers/.test(workerSrc));
  assert.ok(/require\('\.\/services\/queuedArchiveSweeper'\)/.test(workerSrc));
  const idxSrc = stripComments(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'));
  assert.ok(!/queuedArchiveSweeper/.test(idxSrc),
    'archive sweep must not be wired on the web process (it does not render)');
});
ok('F10 env knobs exist in config/defaults.env with sane defaults', () => {
  assert.ok(/QUEUED_ARCHIVE_ENABLED=true/.test(defaultsSrc));
  assert.ok(/QUEUED_ARCHIVE_AFTER_H=24/.test(defaultsSrc));
  assert.ok(/QUEUED_ARCHIVE_MAX_ADS=200/.test(defaultsSrc));
  assert.ok(/QUEUED_ARCHIVE_INTERVAL_MIN=15/.test(defaultsSrc));
});
ok('F11 blank / 0 / negative AFTER_H falls back to 24 (Number("") === 0 trap)', () => {
  const prev = process.env.QUEUED_ARCHIVE_AFTER_H;
  try {
    delete process.env.QUEUED_ARCHIVE_AFTER_H;
    assert.strictEqual(afterHours(), 24);
    process.env.QUEUED_ARCHIVE_AFTER_H = '';
    assert.strictEqual(afterHours(), 24);
    process.env.QUEUED_ARCHIVE_AFTER_H = '0';
    assert.strictEqual(afterHours(), 24);
    process.env.QUEUED_ARCHIVE_AFTER_H = '-3';
    assert.strictEqual(afterHours(), 24);
    process.env.QUEUED_ARCHIVE_AFTER_H = '48';
    assert.strictEqual(afterHours(), 48);
  } finally {
    if (prev === undefined) delete process.env.QUEUED_ARCHIVE_AFTER_H;
    else process.env.QUEUED_ARCHIVE_AFTER_H = prev;
  }
});
ok('F12 sweep is kill-switchable and bounded', () => {
  assert.strictEqual(typeof ENABLED, 'function');
  assert.ok(maxAds() >= 1);
});
ok('F13 MAX_CREATIVES_PER_RUN was not raised (that hides the symptom)', () => {
  assert.ok(/MAX_CREATIVES_PER_RUN=20/.test(defaultsSrc));
});
ok('F14 sweeper does not require routes/ads (no boot-time cycle, no render loop)', () => {
  assert.ok(!/routes\/ads/.test(sweepSrc));
});
ok('F15 receiptFree is composed, not spread — a caller $and is preserved', () => {
  const merged = receiptFree({ status: 'queued', $and: [{ foo: 1 }] });
  assert.ok(merged.$and.length >= 3);
  assert.deepStrictEqual(merged.$and[0], { foo: 1 });
});

if (process.exitCode) {
  console.log(`\n❌ verifyNoStrandedQueued: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyNoStrandedQueued: ${checks}/${checks} checks passed`);
}
