#!/usr/bin/env node
'use strict';
//
// verifyAdPhase — services/adPhase.js has NO dedicated test today
// (`grep -rl adPhase scripts/` finds nothing) despite being the single
// canonical "where is this ad right now" derivation now wired into
// routes/ads.js's projectAd, worker.js's reconciler + the new
// alertIfClaimsStranded() Slack alert, and both routes/campaigns.js and
// routes/catalog.js's ads-detail endpoints (fix/slack-parity). A silent
// regression here doesn't just mis-render one tile — it can mis-fire (or
// fail to fire) the stranded-claims Slack alert, or make the Product Ads UI
// and Slack disagree again, which is the exact three-way drift adPhase.js's
// own header says it exists to stop.
//
// THESE CHECKS drive the REAL exported `deriveAdPhase`/`describeAdFailure`
// over fixture Ad-shaped plain objects — no source-text regexing, no
// hand-rolled re-implementation of the phase logic to compare against.
// `opts.now` is always passed explicitly so every assertion is
// deterministic and immune to wall-clock drift.
//
// Group map:
//   A. One fixture per phase in the live PHASES export (currently 15) —
//      plus a completeness check that the set of phases this file actually
//      exercises is exactly PHASES, so a future 16th phase added to
//      adPhase.js without a matching fixture here fails loudly instead of
//      silently going untested.
//   B. describeAdFailure returns null for every NON-terminal phase, and the
//      full label table for every renderError.stage this repo is confirmed
//      to write (FAILURE_STAGE_LABELS), plus the unmapped-stage fallback
//      and the no-stage-at-all fallback.
//   C. THE "NEVER A BARE FAILED" PROPERTY — owner requirement 2026-08-26:
//      any renderError.stage that IS recorded (mapped or not) must produce
//      a label more specific than the bare string "Failed". The single
//      legitimate bare-"Failed" case — no stage was ever recorded at all —
//      is asserted separately, by name, so it reads as an intentional
//      carve-out rather than a gap this group missed.
//   D. Precedence/ordering: qc-failed-kept is checked before the generic
//      failed-terminal branch; the cancel overlay is checked before the
//      staleness overlay; a TERMINAL phase is never rewritten by the cancel
//      overlay; awaiting-titler vs titling is distinguished purely by
//      `claimedByWorker`, nothing else.
//
// REVERT-PROVEN 2026-08-31 (three mutations, applied directly to
// services/adPhase.js, run, confirmed RED, then `git checkout --
// services/adPhase.js` to restore — confirmed GREEN again after restore):
//   1. Changed the qc-failed-kept guard's `qc.passed === false` to
//      `qc.passed === true` (services/adPhase.js:158) → A8 (qc-failed-kept
//      fixture) failed: deriveAdPhase returned 'failed-terminal' instead,
//      proving the guard is what keeps a kept QC failure out of the bare
//      failed-terminal bucket.
//   2. Replaced the label line's `(FAILURE_STAGE_LABELS[stage] ||
//      humanizeStage(stage))` with the bare string `'Failed'`
//      (services/adPhase.js:303-305) → every Group B stage-label assertion
//      AND every Group C never-bare-Failed assertion failed at once (14+
//      failures), proving both groups actually exercise that line rather
//      than passing vacuously.
//   3. Commented out the staleness overlay's `if
//      (!NO_STALENESS_PHASES.has(phase))` guard body (services/adPhase.js
//      :236-239) → the A13 'stalled' fixture failed (returned
//      'generating-master' instead, since the branch never ran), proving
//      the fixture's old renderStageAt is actually what drives the result,
//      not a coincidence of the other fields.
// All three were restored via `git checkout -- services/adPhase.js` before
// this file was finalized; `git diff services/adPhase.js` is empty.
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyAdPhase.js

const assert = require('assert');
const {
  PHASES,
  deriveAdPhase,
  describeAdFailure,
  FAILURE_STAGE_LABELS,
  humanizeStage
} = require('../services/adPhase');
const { COMPETITOR_MARKS_CAVEAT } = require('../services/adVisionQcService');

let passed = 0;
const failures = [];
function ok(label, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${label}\n      ${err.message}`);
  }
}

// ── fixture plumbing ─────────────────────────────────────────────────────
const NOW = new Date('2026-08-30T12:00:00Z').getTime();

function mkAd(overrides = {}) {
  return Object.assign({
    kind: 'image',
    status: 'rendering',
    claimedByWorker: null,
    claimedAt: NOW,
    renderStage: null,
    renderStageAt: NOW,
    updatedAt: NOW,
    titlingNeeded: false,
    titlingResumeState: null,
    veoVideoUrl: null,
    veoPredictionId: null,
    renderUrl: null,
    deriveFromMaster: null,
    visionQc: null,
    renderError: null
  }, overrides);
}

const phasesCovered = new Set();
function phase(label, ad, opts, expected) {
  ok(label, () => {
    const got = deriveAdPhase(ad, Object.assign({ now: NOW }, opts));
    assert.strictEqual(got, expected, `expected phase '${expected}', got '${got}'`);
  });
  phasesCovered.add(expected);
}

// ── Group A: one fixture per phase ───────────────────────────────────────

phase('A1 queued: status queued, unclaimed',
  mkAd({ status: 'queued', claimedByWorker: null }),
  {},
  'queued');

phase('A2 claimed: claimed, no renderStage breadcrumb yet',
  mkAd({ status: 'rendering', claimedByWorker: 'renderer-1', renderStage: null }),
  {},
  'claimed');

phase('A3 generating-master: claimed, in-flight breadcrumb matching nothing more specific',
  mkAd({ status: 'rendering', claimedByWorker: 'renderer-1', renderStage: 'generating image' }),
  {},
  'generating-master');

phase('A4 awaiting-master: video derive waiting on sibling master (claim held, still polling)',
  mkAd({ kind: 'video', status: 'rendering', claimedByWorker: 'renderer-1', deriveFromMaster: 'meta_stories_9_16', veoVideoUrl: null }),
  {},
  'awaiting-master');

ok('A4b awaiting-master also holds after DERIVE_MASTER_WAIT_MS requeues the claim away', () => {
  const ad = mkAd({ kind: 'video', status: 'queued', claimedByWorker: null, deriveFromMaster: 'meta_stories_9_16', veoVideoUrl: null });
  assert.strictEqual(deriveAdPhase(ad, { now: NOW }), 'awaiting-master');
});

phase('A5 titling: titler handoff claimed (renderer.js’s titlingNeeded:true + claimedByWorker path)',
  mkAd({ kind: 'video', status: 'rendering', titlingNeeded: true, claimedByWorker: 'titler-1' }),
  {},
  'titling');

phase('A6 awaiting-titler: titler handoff NOT yet claimed — the exact silently-stranded phase this file was built to name',
  mkAd({ kind: 'video', status: 'rendering', titlingNeeded: true, claimedByWorker: null }),
  {},
  'awaiting-titler');

ok('A6b titling vs awaiting-titler is distinguished purely by claimedByWorker, nothing else', () => {
  const claimed = mkAd({ kind: 'video', status: 'rendering', titlingNeeded: true, claimedByWorker: 'titler-1' });
  const unclaimed = mkAd({ kind: 'video', status: 'rendering', titlingNeeded: true, claimedByWorker: null });
  assert.strictEqual(deriveAdPhase(claimed, { now: NOW }), 'titling');
  assert.strictEqual(deriveAdPhase(unclaimed, { now: NOW }), 'awaiting-titler');
});

phase('A7 titling: also reached via titlingResumeState pending/claimed (backend’s own resume sweep, not the adgen handoff)',
  mkAd({ kind: 'video', status: 'draft', titlingResumeState: 'claimed', renderUrl: null, veoVideoUrl: 'https://cdn/master.mp4' }),
  {},
  'titling');

phase('A8 quality-check: vision QC in flight, verdict not yet stamped',
  mkAd({ kind: 'video', status: 'rendering', claimedByWorker: 'renderer-1', renderStage: 'vision QC in progress' }),
  {},
  'quality-check');

phase('A9 qc-failed-kept: QC rejected it, asset was kept (owner decision 2026-08-20) — distinct from failed-terminal',
  mkAd({ status: 'failed', renderUrl: 'https://cdn/kept.mp4', visionQc: { passed: false, skipped: false, attempts: [] } }),
  {},
  'qc-failed-kept');

phase('A10 complete: image ad, no titling concept, delivered',
  mkAd({ kind: 'image', status: 'draft', renderUrl: 'https://cdn/plate.png' }),
  {},
  'complete');

phase('A10b complete: video ad, delivered asset differs from raw master (something actually composited)',
  mkAd({ kind: 'video', status: 'live', renderUrl: 'https://cdn/final.mp4', veoVideoUrl: 'https://cdn/master.mp4', titlingResumeState: null }),
  {},
  'complete');

phase('A11 failed-terminal: status failed, not a QC rejection',
  mkAd({ status: 'failed', renderError: { stage: 'render' } }),
  {},
  'failed-terminal');

phase('A12 deferred-retrying: released (timeout/reaper) but not yet re-claimed',
  mkAd({ kind: 'image', status: 'rendering', claimedByWorker: null }),
  {},
  'deferred-retrying');

phase('A13 skipped-derivative: archived, never rendered, never billed (video — image short-circuits to complete, see A10 note below)',
  mkAd({ kind: 'video', status: 'archived', renderUrl: null, veoVideoUrl: null, veoPredictionId: null }),
  {},
  'skipped-derivative');

phase('A14 stalled: non-terminal phase whose timestamp hasn’t moved in staleMinutes',
  mkAd({ status: 'rendering', claimedByWorker: 'renderer-1', renderStage: 'generating image', renderStageAt: NOW - 20 * 60000, updatedAt: NOW - 20 * 60000 }),
  {},
  'stalled');

ok('A14b stalled respects a caller-supplied staleMinutes, not just the 15-minute default', () => {
  const ad = mkAd({ status: 'rendering', claimedByWorker: 'renderer-1', renderStage: 'generating image', renderStageAt: NOW - 3 * 60000, updatedAt: NOW - 3 * 60000 });
  assert.strictEqual(deriveAdPhase(ad, { now: NOW, staleMinutes: 15 }), 'generating-master', 'fresh enough for the default 15m floor');
  assert.strictEqual(deriveAdPhase(ad, { now: NOW, staleMinutes: 2 }), 'stalled', 'but stale against a tighter 2m floor');
});

phase('A15 cancelling: archived/never-rendered row whose run was stopped (the direct early-return branch, not the generic overlay)',
  mkAd({ kind: 'video', status: 'archived', renderUrl: null, veoVideoUrl: null, veoPredictionId: null }),
  { runCancelling: true },
  'cancelling');

phase('A16 cancelled: same shape, run fully settled as cancelled',
  mkAd({ kind: 'video', status: 'archived', renderUrl: null, veoVideoUrl: null, veoPredictionId: null }),
  { runCancelled: true },
  'cancelled');

ok('A17 completeness: every phase in the live PHASES export has at least one fixture above', () => {
  const missing = PHASES.filter((p) => !phasesCovered.has(p));
  assert.deepStrictEqual(missing, [], `PHASES grew a phase with no fixture in this harness: ${missing.join(', ')}`);
  assert.strictEqual(phasesCovered.size, PHASES.length, 'covered-phase count must equal PHASES.length (no extras either)');
});

// ── Group B: describeAdFailure label table ───────────────────────────────

ok('B1 describeAdFailure returns null for every non-terminal phase', () => {
  for (const p of PHASES) {
    if (p === 'failed-terminal' || p === 'qc-failed-kept') continue;
    assert.strictEqual(describeAdFailure({ renderError: { stage: 'render' } }, p), null, `phase '${p}' must not get a failure label`);
  }
});

const STAGE_LABEL_TABLE = [
  ['vision-qc', 'QC Fail'],
  ['vision-qc-recovery', 'QC Fail'],
  ['render', 'Render Failed'],
  ['derive-no-master', 'Master Unavailable'],
  ['titling', 'Titling Failed'],
  ['titler', 'Titling Failed'],
  ['resume', 'Titling Failed'],
  ['face-safe-crop', 'Crop Failed'],
  ['reaper', 'Reclaimed (Stalled Claim)'],
  ['shutdown', 'Interrupted (Deploy)'],
  ['crash', 'Process Crash'],
  ['claim', 'Claim Failed'],
  ['cleanup', 'Cleanup Failed'],
  ['zombie-cleanup', 'Stalled Claim Cleared']
];

for (const [stage, expectedLabel] of STAGE_LABEL_TABLE) {
  ok(`B2 stage '${stage}' -> '${expectedLabel}'`, () => {
    const result = describeAdFailure({ status: 'failed', renderError: { stage } }, 'failed-terminal');
    assert.strictEqual(result.label, expectedLabel);
    assert.strictEqual(result.stage, stage);
    assert.strictEqual(result.isQc, stage === 'vision-qc' || stage === 'vision-qc-recovery');
  });
}

ok('B3 unmapped-but-present stage falls back to humanizeStage, not to FAILURE_STAGE_LABELS being silently absent', () => {
  const result = describeAdFailure({ renderError: { stage: 'mystery-new-stage' } }, 'failed-terminal');
  assert.strictEqual(result.label, 'Mystery New Stage');
  assert.strictEqual(result.label, humanizeStage('mystery-new-stage'));
});

ok('B4 the ONE legitimate bare-"Failed": no renderError.stage was ever recorded at all', () => {
  const result = describeAdFailure({ status: 'failed', renderError: null }, 'failed-terminal');
  assert.strictEqual(result.label, 'Failed');
  assert.strictEqual(result.stage, null);
  // Intentional carve-out, not a gap: there is no more specific truth to
  // tell when the stage itself was never written. Group C below asserts
  // the inverse — that this NEVER happens when a stage IS present.
});

ok('B5 qc-failed-kept always labels QC Fail, even with no stage on the doc — the phase itself is the signal', () => {
  const result = describeAdFailure({ status: 'failed', renderError: null, renderUrl: null }, 'qc-failed-kept');
  assert.strictEqual(result.label, 'QC Fail');
  assert.strictEqual(result.isQc, true);
  assert.strictEqual(result.keptAsset, true, 'qc-failed-kept implies keptAsset regardless of renderUrl on the doc passed here');
});

ok('B6 qcCaveat: fires only when the LAST QC attempt’s competitor_marks category is the failing one', () => {
  const withCaveat = describeAdFailure({
    status: 'failed',
    renderUrl: 'https://cdn/x.mp4',
    visionQc: { passed: false, attempts: [{ categories: { competitor_marks: { pass: false } } }] }
  }, 'qc-failed-kept');
  assert.strictEqual(withCaveat.qcCaveat, COMPETITOR_MARKS_CAVEAT);

  const withoutCaveat = describeAdFailure({
    status: 'failed',
    renderUrl: 'https://cdn/x.mp4',
    visionQc: { passed: false, attempts: [{ categories: { competitor_marks: { pass: true } } }] }
  }, 'qc-failed-kept');
  assert.strictEqual(withoutCaveat.qcCaveat, null);
});

ok('B7 keptAsset for a plain failed-terminal (not QC) reflects renderUrl, not a hardcoded true', () => {
  const kept = describeAdFailure({ status: 'failed', renderUrl: 'https://cdn/x.png', renderError: { stage: 'render' } }, 'failed-terminal');
  const notKept = describeAdFailure({ status: 'failed', renderUrl: null, renderError: { stage: 'render' } }, 'failed-terminal');
  assert.strictEqual(kept.keptAsset, true);
  assert.strictEqual(notKept.keptAsset, false);
});

// ── Group C: the "never a bare Failed" property ──────────────────────────

ok('C1 every mapped stage produces a label other than the bare word "Failed"', () => {
  for (const [stage] of STAGE_LABEL_TABLE) {
    const result = describeAdFailure({ renderError: { stage } }, 'failed-terminal');
    assert.notStrictEqual(result.label, 'Failed', `stage '${stage}' collapsed to a bare "Failed"`);
  }
});

ok('C2 an UNMAPPED-but-present stage also never collapses to bare "Failed" — humanizeStage is the safety net', () => {
  for (const stage of ['some-brand-new-failure-mode', 'x', 'a_b_c']) {
    const result = describeAdFailure({ renderError: { stage } }, 'failed-terminal');
    assert.notStrictEqual(result.label, 'Failed', `unmapped stage '${stage}' collapsed to a bare "Failed"`);
  }
});

// ── Group D: precedence / ordering ────────────────────────────────────────

ok('D1 qc-failed-kept is checked BEFORE the generic failed-terminal branch', () => {
  // Same status:'failed' + a kept asset; only the QC verdict shape differs.
  const qcFailed = mkAd({ status: 'failed', renderUrl: 'https://cdn/x.mp4', visionQc: { passed: false, skipped: false } });
  const plainFailed = mkAd({ status: 'failed', renderUrl: 'https://cdn/x.mp4', visionQc: null });
  assert.strictEqual(deriveAdPhase(qcFailed, { now: NOW }), 'qc-failed-kept');
  assert.strictEqual(deriveAdPhase(plainFailed, { now: NOW }), 'failed-terminal');
});

ok('D2 the cancel overlay is checked BEFORE the staleness overlay — a stopped run reads Stopping…, not Stalled', () => {
  const staleAndCancelling = mkAd({
    status: 'rendering', claimedByWorker: 'renderer-1', renderStage: 'generating image',
    renderStageAt: NOW - 999 * 60000, updatedAt: NOW - 999 * 60000
  });
  const got = deriveAdPhase(staleAndCancelling, { now: NOW, runCancelling: true });
  assert.strictEqual(got, 'cancelling', 'would be "stalled" if staleness ran first, since the timestamp is 999m old');
});

ok('D3 a TERMINAL phase is never rewritten by the cancel overlay', () => {
  const complete = mkAd({ kind: 'image', status: 'draft', renderUrl: 'https://cdn/x.png' });
  assert.strictEqual(deriveAdPhase(complete, { now: NOW, runCancelling: true }), 'complete');
  assert.strictEqual(deriveAdPhase(complete, { now: NOW, runCancelled: true }), 'complete');

  const failedTerminal = mkAd({ status: 'failed', renderError: { stage: 'render' } });
  assert.strictEqual(deriveAdPhase(failedTerminal, { now: NOW, runCancelling: true }), 'failed-terminal');
});

async function main() {
  if (failures.length) {
    console.error(`\n❌ verifyAdPhase: ${failures.length} of ${passed + failures.length} checks FAILED\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ verifyAdPhase: all ${passed} checks passed`);
  }
}

main().catch((err) => {
  console.error('verifyAdPhase: uncaught error', (err && err.stack) || err);
  process.exitCode = 1;
});
