#!/usr/bin/env node
'use strict';
//
// verifyClassifyRunAdOutcomeParity — the run-rollup must not become a
// fourth "where is this ad" derivation now that adPhase.js exists.
//
// campaignRunGuards.classifyRunAdOutcome used to switch on raw `ad.status`
// + isVideoTitlingSettled. Backend #368 / this PR retrofit it onto
// deriveAdPhase(): succeeded ← phase 'complete', failed ←
// 'failed-terminal'|'qc-failed-kept', stillRendering/requeuedAway still
// keyed on raw status. This harness:
//
//   A. Structural: classifyRunAdOutcome requires and CALLS deriveAdPhase.
//   B. Count-equivalence matrix: a FROZEN copy of the pre-adPhase switch
//      (the oracle — it still calls isVideoTitlingSettled directly) and
//      the LIVE classifyRunAdOutcome must return identical counters for
//      every named fixture, plus a mixed bag of all of them together.
//
// Fixtures cover the shapes the retrofit is documented to preserve:
//   settled draft / live / archived (image), qc-failed-kept
//   (status:'failed' + visionQc.passed===false + renderUrl),
//   failed-terminal, rendering, requeued (queued), mid-titling draft.
// Plus the awaiting-master rendering-vs-queued pair that proves phase
// alone cannot replace the raw-status split.
//
// Offline. The suite's NODE_PATH (sibling backend node_modules) is what
// lets campaignRunGuards → adPhase → adVisionQcService resolve json5.
//   node scripts/verifyClassifyRunAdOutcomeParity.js
//   (or: node scripts/runVerifySuite.js verifyClassifyRunAdOutcomeParity.js)

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const GUARDS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'campaignRunGuards.js'), 'utf8');

const { isVideoTitlingSettled } = require('../src/services/adTitlingTruth');
const { classifyRunAdOutcome } = require('../src/services/campaignRunGuards');
const { deriveAdPhase } = require('../src/services/adPhase');

let checks = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    checks += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
  }
}

// ── frozen pre-adPhase oracle (do not "fix" this to call deriveAdPhase) ──
function classifyRunAdOutcomePreAdPhase(adDocs) {
  let succeeded = 0, failed = 0, stillRendering = 0, requeuedAway = 0, titlingIncomplete = 0;
  for (const ad of (adDocs || [])) {
    switch (ad && ad.status) {
      case 'draft':
      case 'live':
      case 'archived':
        if (isVideoTitlingSettled(ad)) succeeded++;
        else titlingIncomplete++;
        break;
      case 'failed':   failed++; break;
      case 'rendering': stillRendering++; break;
      case 'queued':    requeuedAway++; break;
      default: break;
    }
  }
  return {
    succeeded,
    failed,
    stillRendering,
    requeuedAway,
    titlingIncomplete,
    isSettled: stillRendering === 0 && titlingIncomplete === 0,
    needsRetry: requeuedAway > 0
  };
}

const COUNT_KEYS = ['succeeded', 'failed', 'stillRendering', 'requeuedAway', 'titlingIncomplete', 'isSettled', 'needsRetry'];

function countsOf(outcome) {
  const out = {};
  for (const k of COUNT_KEYS) out[k] = outcome[k];
  return out;
}

function fmtCounts(o) {
  return `s=${o.succeeded} f=${o.failed} r=${o.stillRendering} q=${o.requeuedAway} t=${o.titlingIncomplete} settled=${o.isSettled} retry=${o.needsRetry}`;
}

// ═════════════════════════════════════════════════════════════════════════
// A — structural
// ═════════════════════════════════════════════════════════════════════════
console.log('\n── A: classifyRunAdOutcome is wired onto deriveAdPhase ──');

check('A1 campaignRunGuards.js requires ./adPhase', () => {
  assert.match(GUARDS_SRC, /require\(['"]\.\/adPhase['"]\)/);
});

check('A2 classifyRunAdOutcome CALLs deriveAdPhase(ad) (not just imports it)', () => {
  const start = GUARDS_SRC.indexOf('function classifyRunAdOutcome');
  assert.ok(start !== -1, 'classifyRunAdOutcome not found');
  const end = GUARDS_SRC.indexOf('\nfunction ', start + 10);
  const body = GUARDS_SRC.slice(start, end === -1 ? undefined : end);
  assert.match(body, /deriveAdPhase\(ad\)/);
  assert.match(body, /phase === 'complete'/);
  assert.match(body, /failed-terminal/);
  assert.match(body, /qc-failed-kept/);
});

check('A3 residual switch is on ad.status and has no case \'failed\' (failed is the phase arm)', () => {
  const start = GUARDS_SRC.indexOf('function classifyRunAdOutcome');
  const end = GUARDS_SRC.indexOf('\nfunction ', start + 10);
  const body = GUARDS_SRC.slice(start, end === -1 ? undefined : end);
  const switchMatch = /switch\s*\(\s*ad\.status\s*\)\s*\{/.exec(body);
  assert.ok(switchMatch, 'expected switch (ad.status)');
  // Only the switch body — the function header still mentions the old
  // `case 'failed'` in the equivalence proof comments.
  const switchStart = body.indexOf('{', switchMatch.index + switchMatch[0].length - 1);
  let depth = 0;
  let switchEnd = switchStart;
  for (let i = switchStart; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') {
      depth--;
      if (depth === 0) { switchEnd = i + 1; break; }
    }
  }
  const switchBody = body.slice(switchStart, switchEnd);
  assert.doesNotMatch(switchBody, /case\s+['"]failed['"]/);
  assert.match(switchBody, /case\s+'rendering'/);
  assert.match(switchBody, /case\s+'queued'/);
});

check('A4 live classifyRunAdOutcome is the exported function (oracle is local)', () => {
  assert.notStrictEqual(classifyRunAdOutcome, classifyRunAdOutcomePreAdPhase);
  assert.strictEqual(typeof classifyRunAdOutcome, 'function');
});

// ═════════════════════════════════════════════════════════════════════════
// B — fixture matrix
// ═════════════════════════════════════════════════════════════════════════
console.log('\n── B: count-equivalence matrix (old switch vs live deriveAdPhase) ──');

const MASTER = 'https://cdn.example/master.mp4';
const TITLED = 'https://cdn.example/titled.mp4';
// Fresh clock so deriveAdPhase does not overlay 'stalled' (default 15 min)
// on fixtures that omit updatedAt — the overlay is irrelevant to counts
// (stalled still falls through to the raw-status switch) but the matrix
// should show the underlying sub-phase.
const NOW = new Date();

const FIXTURES = [
  ['settled draft (image)',
    { status: 'draft', kind: 'image', renderUrl: 'https://cdn.example/img.jpg', updatedAt: NOW }],
  ['settled live (image)',
    { status: 'live', kind: 'image', renderUrl: 'https://cdn.example/img.jpg', updatedAt: NOW }],
  ['settled archived (image)',
    { status: 'archived', kind: 'image', renderUrl: 'https://cdn.example/img.jpg', updatedAt: NOW }],
  ['settled draft (video, titled)',
    { status: 'draft', kind: 'video', renderUrl: TITLED, veoVideoUrl: MASTER, titlingResumeState: null, updatedAt: NOW }],
  ['qc-failed-kept (failed + visionQc.passed===false + renderUrl)',
    { status: 'failed', kind: 'video', renderUrl: TITLED, veoVideoUrl: MASTER, updatedAt: NOW,
      visionQc: { passed: false, skipped: false } }],
  ['failed-terminal (failed, no QC verdict)',
    { status: 'failed', kind: 'image', renderError: { message: 'atlas 500', stage: 'render' }, updatedAt: NOW }],
  ['rendering (claimed in-flight)',
    { status: 'rendering', kind: 'video', claimedByWorker: 'renderer-abc',
      renderStage: 'master video generation', updatedAt: NOW, claimedAt: NOW, renderStageAt: NOW }],
  ['requeued (queued after wait)',
    { status: 'queued', kind: 'video', deriveFromMaster: '9:16', updatedAt: NOW }],
  ['mid-titling draft (video, resume claimed, raw master on renderUrl)',
    { status: 'draft', kind: 'video', renderUrl: MASTER, veoVideoUrl: MASTER,
      titlingResumeState: 'claimed', updatedAt: NOW }],
  ['awaiting-master while rendering (claim held)',
    { status: 'rendering', kind: 'video', deriveFromMaster: '1:1',
      claimedByWorker: 'renderer-abc', updatedAt: NOW, claimedAt: NOW }],
  ['awaiting-master after requeue (claim released)',
    { status: 'queued', kind: 'video', deriveFromMaster: '1:1', updatedAt: NOW }],
  ['null row (ignored)',
    null],
];

const matrixRows = [];
for (const [label, ad] of FIXTURES) {
  const docs = ad == null ? [null] : [ad];
  const oldC = countsOf(classifyRunAdOutcomePreAdPhase(docs));
  const newC = countsOf(classifyRunAdOutcome(docs));
  const match = COUNT_KEYS.every((k) => oldC[k] === newC[k]);
  const phase = ad ? deriveAdPhase(ad) : '(null)';
  matrixRows.push({ label, oldC, newC, match, phase });
  check(`B ${label}`, () => {
    assert.deepStrictEqual(newC, oldC, `new ${fmtCounts(newC)} !== old ${fmtCounts(oldC)} (phase=${phase})`);
  });
}

check('B mixed bag of every fixture returns identical totals', () => {
  const docs = FIXTURES.map(([, ad]) => ad);
  const oldC = countsOf(classifyRunAdOutcomePreAdPhase(docs));
  const newC = countsOf(classifyRunAdOutcome(docs));
  assert.deepStrictEqual(newC, oldC, `mixed new ${fmtCounts(newC)} !== old ${fmtCounts(oldC)}`);
});

check('B awaiting-master pair: same phase, different stillRendering vs requeuedAway', () => {
  const rendering = FIXTURES.find(([l]) => l.startsWith('awaiting-master while'))[1];
  const queued = FIXTURES.find(([l]) => l.startsWith('awaiting-master after'))[1];
  assert.strictEqual(deriveAdPhase(rendering), deriveAdPhase(queued),
    'the point of this pair is that deriveAdPhase names them the same');
  const r = classifyRunAdOutcome([rendering]);
  const q = classifyRunAdOutcome([queued]);
  assert.strictEqual(r.stillRendering, 1);
  assert.strictEqual(r.requeuedAway, 0);
  assert.strictEqual(q.stillRendering, 0);
  assert.strictEqual(q.requeuedAway, 1);
});

console.log('\n  fixture                                          phase                 old                              new                              match');
console.log('  ' + '-'.repeat(140));
for (const row of matrixRows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    '  ' +
    pad(row.label, 50) +
    pad(row.phase, 21) +
    pad(fmtCounts(row.oldC), 33) +
    pad(fmtCounts(row.newC), 33) +
    (row.match ? '✓' : '✗')
  );
}

const mixedOld = countsOf(classifyRunAdOutcomePreAdPhase(FIXTURES.map(([, ad]) => ad)));
const mixedNew = countsOf(classifyRunAdOutcome(FIXTURES.map(([, ad]) => ad)));
console.log('  ' + padLine('MIXED BAG', 50) + padLine('', 21) + padLine(fmtCounts(mixedOld), 33) + padLine(fmtCounts(mixedNew), 33) + (COUNT_KEYS.every((k) => mixedOld[k] === mixedNew[k]) ? '✓' : '✗'));

function padLine(s, n) { return String(s).padEnd(n); }

// ── report ───────────────────────────────────────────────────────────────
const total = checks + failures.length;
console.log('');
if (failures.length) {
  console.log(`❌ verifyClassifyRunAdOutcomeParity: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyClassifyRunAdOutcomeParity: ${total}/${total} checks passed`);
