#!/usr/bin/env node
'use strict';
//
// verifyGeminiLeaseSweeperCollision — a Gemini cap-miss must never poison
// strandedRunSweeper's deriveWaitAttempts bound, and must never look like
// queuedArchiveSweeper leftover debris.
//
// WHY THIS EXISTS (2026-09-03). The first Gemini-lease-retry patch reused
// Ad.deriveWaitAttempts as a cross-claim-cycle counter (to avoid a new
// schema path). That field is one of TWO independent attempt bounds in
// strandedRunSweeper.buildStrandedAdFilter (default < 3). A SIGTERM
// (processAlerts shutdown sweep) moves a receipt-free rendering ad to
// queued with its minting run marked failed. After >= 3 lease-requeue
// cycles the stranded sweeper skips the row; 24h later
// queuedArchiveSweeper — which never looks at deriveWaitAttempts —
// archives it as mint leftover. Nothing was billed; the creative
// silently vanishes.
//
// THE FIX is not a new field and not a bumped threshold. generateForAd
// holds the Ad claim through its own internal backoff (the full retry
// budget). Renderer does not persist a counter and does not release the
// claim back to claimOne between attempts. A still-exhausted cap is a
// plain skip → renderer throws → status:'failed', same as any other
// unbilled render failure.
//
// EXECUTION, not source-text. This harness:
//   1. Loads the REAL buildStrandedAdFilter / buildQueuedArchiveFilter
//      (function bodies eval'd with the REAL receiptFree helper).
//   2. Builds a synthetic Ad the way N Gemini lease-cap-miss cycles
//      PLUS a SIGTERM rendering→queued transition would leave it,
//      applying whatever $inc the live renderer source still issues
//      on that path (so this goes RED against the deriveWaitAttempts-
//      reuse code and GREEN once that write is gone).
//   3. Asserts stranded STILL matches (so the row is recovered) and
//      queued-archive does NOT match a fresh queuedAt (so it is not
//      archived out from under the sweeper that owns it).
//
// OFFLINE. No DB, no network. Mongo matching is scripts/lib/miniMongoStub.

const fs = require('fs');
const path = require('path');
const { matches } = require('./lib/miniMongoStub');
const { receiptFree } = require('../src/services/spendReceipt');

const ROOT = path.join(__dirname, '..');
const SVC = path.join(ROOT, 'src', 'services');

const rendererSrc = fs.readFileSync(path.join(SVC, 'renderer.js'), 'utf8');
const strandedSrc = fs.readFileSync(path.join(SVC, 'strandedRunSweeper.js'), 'utf8');
const queuedSrc = fs.readFileSync(path.join(SVC, 'queuedArchiveSweeper.js'), 'utf8');
const providerSrc = fs.readFileSync(path.join(SVC, 'geminiVideoService.js'), 'utf8');

let pass = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

function extractFn(src, name) {
  const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}

// REAL filter functions. buildStrandedAdFilter closes over MAX_ATTEMPTS
// (the same `|| 3` default the file uses). buildQueuedArchiveFilter
// closes over the REAL receiptFree.
const buildStrandedAdFilter = new Function(
  extractFn(strandedSrc, 'buildStrandedAdFilter').replace(
    'function buildStrandedAdFilter',
    'const MAX_ATTEMPTS = Number(process.env.STRANDED_SWEEP_MAX_ATTEMPTS || 3);\nfunction buildStrandedAdFilter'
  ) + '\nreturn buildStrandedAdFilter;'
)();
const buildQueuedArchiveFilter = new Function(
  'receiptFree',
  extractFn(queuedSrc, 'buildQueuedArchiveFilter') + '\nreturn buildQueuedArchiveFilter;'
)(receiptFree);

const FAILED_RUN = 'run_sigterm_failed';
const strandedFilter = buildStrandedAdFilter({ failedRunIds: [FAILED_RUN] });
const now = Date.now();
const archiveFilterFresh = buildQueuedArchiveFilter({
  terminalRunIds: [FAILED_RUN],
  olderThan: new Date(now - 24 * 3600 * 1000)
});

console.log('\nverifyGeminiLeaseSweeperCollision\n');

// ── A. stub can evaluate both real filters (operators we just needed) ──
console.log('A. miniMongoStub evaluates the real sweeper filters');
{
  const probe = {
    status: 'queued',
    campaignRunIds: [FAILED_RUN],
    renderStage: 'gemini lease wait 1/21',
    renderAttempts: 0,
    deriveWaitAttempts: 0,
    queuedAt: new Date(now - 1000),
    veoPredictionId: null,
    renderUrl: null,
    imageGeneration: { predictionId: null }
  };
  let strandedOk = false;
  let archiveOk = false;
  try { strandedOk = matches(probe, strandedFilter); }
  catch (err) { check('A1 stranded filter is evaluable', false, err.message); }
  try { archiveOk = matches(probe, archiveFilterFresh); }
  catch (err) { check('A2 archive filter is evaluable', false, err.message); }
  if (strandedOk || archiveOk || (strandedOk === false && archiveOk === false)) {
    check('A1 stranded filter is evaluable (no stub throw)', typeof strandedOk === 'boolean');
    check('A2 archive filter is evaluable (no stub throw)', typeof archiveOk === 'boolean');
  }
  check('A3 $elemMatch/$not: a row whose campaignRunIds is ONLY the terminal run is owned by it',
    matches({ campaignRunIds: [FAILED_RUN] }, {
      campaignRunIds: { $in: [FAILED_RUN], $not: { $elemMatch: { $nin: [FAILED_RUN] } } }
    }));
  check('A4 $elemMatch/$not: a row also owned by a live run is NOT archive-owned',
    !matches({ campaignRunIds: [FAILED_RUN, 'run_still_running'] }, {
      campaignRunIds: { $in: [FAILED_RUN], $not: { $elemMatch: { $nin: [FAILED_RUN] } } }
    }));
}

// ── B. renderer must not persist a Gemini-lease counter on a sweeper field ──
console.log('\nB. renderer Gemini cap-miss path does not persist a sweeper-visible counter');
{
  const requeueFn = (rendererSrc.match(/async function requeueGeminiLeaseForRetry[\s\S]*?\n\}/) || [''])[0];
  check('B1 requeueGeminiLeaseForRetry is gone — internal backoff is the full retry budget',
    !/async function requeueGeminiLeaseForRetry/.test(rendererSrc),
    'the claim-released requeue is what collided with strandedRunSweeper');

  const deriveFn = (rendererSrc.match(/async function requeueDeriveForRetry[\s\S]*?\n\}/) || [''])[0];
  check('B2 requeueDeriveForRetry still increments deriveWaitAttempts (the field\'s real job)',
    /\$inc:\s*\{\s*deriveWaitAttempts:\s*1\s*\}/.test(deriveFn));

  // Every $inc of deriveWaitAttempts in renderer.js must live inside the
  // derive-wait helper. A Gemini lease path that reuses the field is the
  // collision this harness exists to forbid.
  const incBlocks = [];
  const incRe = /\$inc:\s*\{[\s\S]*?\}/g;
  let m;
  while ((m = incRe.exec(rendererSrc))) {
    if (/deriveWaitAttempts/.test(m[0])) incBlocks.push({ text: m[0], index: m.index });
  }
  const deriveIdx = rendererSrc.indexOf('async function requeueDeriveForRetry');
  const deriveEnd = deriveIdx >= 0 ? deriveIdx + deriveFn.length : -1;
  const foreign = incBlocks.filter((b) => b.index < deriveIdx || b.index > deriveEnd);
  check('B3 the only deriveWaitAttempts $inc in renderer.js is requeueDeriveForRetry',
    foreign.length === 0,
    foreign.map((b) => b.text.replace(/\s+/g, ' ')).join(' | '));

  check('B4 renderer does not special-case GEMINI_LEASE_EXHAUSTED into a requeue',
    !/requeueGeminiLeaseForRetry/.test(rendererSrc));

  // A skipped generateForAd (including a cap-miss after internal backoff)
  // must throw, not return-as-success and not fall through to persist.
  const skipBlock = (rendererSrc.match(/if \(veoResult\.skipped\) \{[\s\S]*?\n    \}/) || [''])[0];
  check('B5 a skipped generateForAd throws (terminal-fail after internal budget)',
    /throw new Error\(veoResult\.reason/.test(skipBlock) &&
    !/requeueGeminiLeaseForRetry/.test(skipBlock));
}

// ── C. EXECUTION: N cap-miss cycles + SIGTERM vs both real filters ──
console.log('\nC. N Gemini lease cycles then SIGTERM-queued — stranded owns it, archive does not');
{
  const N = 5; // well above STRANDED_SWEEP_MAX_ATTEMPTS default of 3
  const requeueFn = (rendererSrc.match(/async function requeueGeminiLeaseForRetry[\s\S]*?\n\}/) || [''])[0];
  const incMatch = requeueFn && requeueFn.match(/\$inc:\s*\{([^}]+)\}/);
  const incBody = incMatch ? incMatch[1] : '';
  const incDerive = /deriveWaitAttempts\s*:\s*1/.test(incBody);
  const incRender = /renderAttempts\s*:\s*1/.test(incBody);

  function afterNCyclesAndSigterm({ queuedAt, deriveWaitAttempts: startDwa } = {}) {
    const doc = {
      _id: 'ad_gemini_master',
      status: 'rendering',
      campaignRunIds: [FAILED_RUN],
      renderStage: 'gemini lease wait 1/21',
      renderAttempts: 0,
      deriveWaitAttempts: startDwa == null ? 0 : startDwa,
      claimedByWorker: 'renderer-abc',
      claimedAt: new Date(now - 60_000),
      veoPredictionId: null,
      renderUrl: null,
      veoProvider: 'gemini',
      imageGeneration: { predictionId: null },
      queuedAt: null
    };
    // Apply whatever persisted counter the LIVE renderer source still
    // writes on the Gemini lease-requeue path. After the fix this is a
    // no-op (function gone → no $inc) and deriveWaitAttempts stays 0.
    for (let i = 0; i < N; i += 1) {
      if (incDerive) doc.deriveWaitAttempts = (doc.deriveWaitAttempts || 0) + 1;
      if (incRender) doc.renderAttempts = (doc.renderAttempts || 0) + 1;
    }
    // SIGTERM-style processAlerts shutdown sweep: receipt-free rendering
    // → queued, minting run already failed. Does not clear renderStage
    // (stranded requires it as proof work had begun) and does not bump
    // either attempt counter.
    doc.status = 'queued';
    doc.claimedByWorker = null;
    doc.claimedAt = null;
    doc.queuedAt = queuedAt || new Date(now - 60_000);
    return doc;
  }

  const fresh = afterNCyclesAndSigterm();
  check(`C1 after ${N} lease cycles the live renderer left deriveWaitAttempts=${fresh.deriveWaitAttempts} (must stay 0)`,
    fresh.deriveWaitAttempts === 0,
    `deriveWaitAttempts=${fresh.deriveWaitAttempts} — Gemini lease path is still incrementing a sweeper-bound field`);
  check('C2 renderAttempts also stayed 0 (archive sweeper\'s "never started" guard)',
    fresh.renderAttempts === 0);

  const strandedHit = matches(fresh, strandedFilter);
  check('C3 strandedRunSweeper filter MATCHES — SIGTERM-queued Gemini master is recovered',
    strandedHit === true,
    `filter missed the row (deriveWaitAttempts=${fresh.deriveWaitAttempts}); this is the silent-vanish bug`);

  const archiveHit = matches(fresh, archiveFilterFresh);
  check('C4 queuedArchiveSweeper filter does NOT match a fresh queuedAt — not archived out from under stranded',
    archiveHit === false,
    'archive matched a row still inside the stranded window');

  // CONTROL: the collision shape the first patch produced. Documents why
  // C1/C3 exist — this is what stranded looks like when the field is reused.
  const collision = afterNCyclesAndSigterm();
  collision.deriveWaitAttempts = N; // force the old write
  check(`C5 CONTROL: deriveWaitAttempts=${N} is excluded from stranded (the collision, default cap 3)`,
    matches(collision, strandedFilter) === false);

  const agedCollision = {
    ...collision,
    queuedAt: new Date(now - 25 * 3600 * 1000)
  };
  check('C6 CONTROL: that same collision shape IS archived after 24h (the silent-vanish half)',
    matches(agedCollision, archiveFilterFresh) === true);

  // A 25h-old row that stranded WOULD have recovered (deriveWaitAttempts=0)
  // is legitimate leftover cleanup once stranded's own 24h run-age window
  // has closed. Not asserted as forbidden — just that a FRESH one is not
  // archived (C4). Pin the 24h gate itself still exists.
  check('C7 archive filter still requires queuedAt older than the cutoff (the 24h gate)',
    /queuedAt:\s*\{\s*\$lt:\s*olderThan\s*\}/.test(extractFn(queuedSrc, 'buildQueuedArchiveFilter')));
}

// ── D. generateForAd's internal backoff IS the retry budget ──
console.log('\nD. internal lease backoff is the full budget (held claim, no persisted counter)');
{
  function evalIife(src, name, env) {
    const m = src.match(new RegExp(`const ${name} = \\(\\(\\) => \\{[\\s\\S]*?\\}\\)\\(\\);`));
    if (!m) throw new Error(`no IIFE ${name}`);
    return new Function('process', `${m[0]}\nreturn ${name};`)({ env: env || {} });
  }

  const attemptsDefault = evalIife(providerSrc, 'LEASE_ACQUIRE_ATTEMPTS', {});
  const attemptsOne = evalIife(providerSrc, 'LEASE_ACQUIRE_ATTEMPTS', { GEMINI_LEASE_ACQUIRE_ATTEMPTS: '1' });
  const attemptsTen = evalIife(providerSrc, 'LEASE_ACQUIRE_ATTEMPTS', { GEMINI_LEASE_ACQUIRE_ATTEMPTS: '10' });
  const backoffDefault = evalIife(providerSrc, 'LEASE_ACQUIRE_BACKOFF_MS', {});

  check('D1 LEASE_ACQUIRE_ATTEMPTS floors at 2 (env=1 cannot mean zero retries)',
    attemptsOne === 2,
    `got ${attemptsOne}`);
  check('D2 LEASE_ACQUIRE_ATTEMPTS honors a value >= 2',
    attemptsTen === 10,
    `got ${attemptsTen}`);
  check('D3 default attempts is >= 2',
    attemptsDefault >= 2,
    `got ${attemptsDefault}`);

  // 21 masters vs 8 slots, measured submit→terminal 46/60/80.6s plus a
  // ~95s file-PROCESSING tail ≈ ~3 min occupancy. Third wave of a
  // 21-master run waits ~6 min. Default internal budget must cover that
  // with margin so a renderer-level requeue (and its persisted counter)
  // is unnecessary.
  const defaultWaitMs = (attemptsDefault - 1) * backoffDefault;
  check('D4 default internal backoff covers >= 10 minutes ((attempts-1)*backoff)',
    defaultWaitMs >= 10 * 60 * 1000,
    `got ${Math.round(defaultWaitMs / 1000)}s from attempts=${attemptsDefault} backoff=${backoffDefault}ms`);

  check('D5 generateForAd still returns skipped/retryable/GEMINI_LEASE_EXHAUSTED (regenerate parks on that)',
    /code:\s*['"]GEMINI_LEASE_EXHAUSTED['"]/.test(providerSrc) &&
    /retryable:\s*true/.test(providerSrc));
}

console.log('');
if (failures.length) {
  console.log(`❌ geminiLeaseSweeperCollision: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ geminiLeaseSweeperCollision: ${pass} checks passed\n`);
