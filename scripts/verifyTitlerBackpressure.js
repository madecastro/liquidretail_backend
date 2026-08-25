'use strict';
// Pins the titler → Remotion queue backpressure gate (2026-08-25).
//
// Context. On run_1787697069901 the titler autoscaled to 4 instances with
// MAX_INFLIGHT=16 each (theoretical 64 concurrent), yet effective peak was
// 6 — one instance held 4 (all queued behind its 2-slot Chrome ceiling)
// while three sat at 0/16 for 5+ minutes. The env cap (MAX_INFLIGHT: 16→4)
// narrowed the hoard but did not eliminate head-of-line pin. This gate
// closes it.
//
// Rule (see titler.js's block comment):
//   skip = (active + waiting) >= (concurrency + SLACK)
// with SLACK=1 — permits exactly ONE local pipeline waiter so fetch/prep
// overlaps ongoing renders, but no more. Anything past 1 waiter is
// head-of-line waste that a sibling instance could pick up.
//
// Fail-open: a broken renderQueueStats getter must NEVER stop the titler.
//
// This harness patches renderQueueStats via `require.cache` before titler
// is loaded, then evaluates the predicate across the 6 quadrants of
// (active, waiting) space. Also asserts source-level invariants that a
// silent revert would trip:
//   - the loop MUST check backpressure INSIDE the while (not just at
//     entry), because each successful claim mutates queue state
//   - fail-open must be a try/catch, not a special sentinel

const path = require('path');
const REPO = path.resolve(__dirname, '..');
const fs = require('fs');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── isolate: patch remotionRenderService.renderQueueStats BEFORE loading titler ──
const remotionPath = require.resolve(path.join(REPO, 'src', 'services', 'remotionRenderService.js'));
let stubStats = { concurrency: 2, active: 0, waiting: 0 };
let statsThrows = null;
// Load the module once (real load), then swap the exported function on the module's exports.
require(remotionPath);
require.cache[remotionPath].exports.renderQueueStats = () => {
  if (statsThrows) throw statsThrows;
  return stubStats;
};

// Now load titler (which will use the patched renderQueueStats).
const titlerPath = require.resolve(path.join(REPO, 'src', 'services', 'titler.js'));
const titler = require(titlerPath);
const { shouldSkipForBackpressure, REMOTION_BACKPRESSURE_SLACK } = titler;

// ── A. Predicate quadrants (SLACK=1, concurrency=2 in stub) ────────────────
// A1: empty queue → don't skip
stubStats = { concurrency: 2, active: 0, waiting: 0 };
check('A1: empty queue (0/0/2) → CLAIM', shouldSkipForBackpressure() === false);

// A2: partially loaded (below concurrency) → don't skip
stubStats = { concurrency: 2, active: 1, waiting: 0 };
check('A2: 1 active / 0 waiting → CLAIM (below concurrency)', shouldSkipForBackpressure() === false);

// A3: exactly at concurrency, 0 waiters → allow 1 pipelined claim
stubStats = { concurrency: 2, active: 2, waiting: 0 };
check('A3: 2 active / 0 waiting → CLAIM (fills the SLACK=1 pipeline waiter)',
  shouldSkipForBackpressure() === false);

// A4: at concurrency, 1 waiter — this is the SLACK boundary, must skip
stubStats = { concurrency: 2, active: 2, waiting: 1 };
check('A4: 2 active / 1 waiting → SKIP (backpressure engaged at slack ceiling)',
  shouldSkipForBackpressure() === true);

// A5: at concurrency, 5 waiters — deeply saturated, must skip
stubStats = { concurrency: 2, active: 2, waiting: 5 };
check('A5: 2 active / 5 waiting → SKIP (saturated)',
  shouldSkipForBackpressure() === true);

// A6: over-committed (shouldn't happen but shouldn't crash)
stubStats = { concurrency: 2, active: 3, waiting: 0 };
check('A6: 3 active / 0 waiting (impossible in practice) → SKIP (active alone exceeds concurrency)',
  shouldSkipForBackpressure() === true);

// A7: different concurrency ceiling (raise via env in prod) — rule holds
stubStats = { concurrency: 4, active: 4, waiting: 0 };
check('A7: concurrency=4, 4 active / 0 waiting → CLAIM (slack still 1)',
  shouldSkipForBackpressure() === false);
stubStats = { concurrency: 4, active: 4, waiting: 1 };
check('A7b: concurrency=4, 4 active / 1 waiting → SKIP',
  shouldSkipForBackpressure() === true);

// ── B. Fail-open behavior ──────────────────────────────────────────────────
statsThrows = new Error('remotion queue offline');
stubStats = null;
check('B1: getter throws → DO NOT skip (fail-open on telemetry breakage)',
  shouldSkipForBackpressure() === false);
statsThrows = null;

// Malformed shapes fail-open too. Missing concurrency = don't backpressure.
stubStats = { active: 99, waiting: 99 };
check('B2: missing concurrency field → DO NOT skip (partial telemetry ignored)',
  shouldSkipForBackpressure() === false);

stubStats = null;
check('B3: null stats → DO NOT skip',
  shouldSkipForBackpressure() === false);

stubStats = { concurrency: 2, active: NaN, waiting: NaN };
check('B4: NaN active/waiting → treats as 0, doesn\'t skip on empty',
  shouldSkipForBackpressure() === false);

// ── C. SLACK value ─────────────────────────────────────────────────────────
check('C1: SLACK exported and equals 1 (documented policy)',
  REMOTION_BACKPRESSURE_SLACK === 1);

// ── D. Source-level invariants ─────────────────────────────────────────────
const titlerSrc = fs.readFileSync(titlerPath, 'utf8');

// D1: the check MUST be inside the while loop, not just guarding entry.
// Otherwise a burst-claim tick can claim N ads before any queue-state update
// re-triggers the check.
const pollTickBody = titlerSrc.match(/async function pollTick\([^)]*\)\s*\{[\s\S]*?\n\}/);
check('D1: pollTick defines a body', pollTickBody && pollTickBody[0].length > 0);
if (pollTickBody) {
  const body = pollTickBody[0];
  const whileIdx = body.indexOf('while ');
  const claimIdx = body.indexOf('await claimOne(');
  const checkIdx = body.indexOf('shouldSkipForBackpressure(');
  check('D2: shouldSkipForBackpressure() is called inside pollTick',
    checkIdx !== -1);
  check('D3: backpressure check occurs BEFORE claimOne() inside the loop',
    whileIdx !== -1 && checkIdx > whileIdx && checkIdx < claimIdx,
    `while@${whileIdx}, check@${checkIdx}, claim@${claimIdx}`);
}

// D4: fail-open path must be a try/catch, not a "return true" default.
// Extract the shouldSkipForBackpressure function body and grep.
const helperBody = titlerSrc.match(/function shouldSkipForBackpressure\(\)\s*\{[\s\S]*?\n\}/);
check('D4: shouldSkipForBackpressure body found', helperBody && helperBody[0].length > 0);
if (helperBody) {
  const hb = helperBody[0];
  check('D5: helper uses try/catch (fail-open)', /try\s*\{[\s\S]*?catch\s*\(/.test(hb));
  check('D6: catch returns false (fail-open, not fail-closed)',
    /catch[\s\S]*?return\s+false/.test(hb));
  check('D7: helper reads renderQueueStats',
    /renderQueueStats\(\)/.test(hb));
  check('D8: helper compares against concurrency + SLACK',
    /concurrency\s*\+\s*REMOTION_BACKPRESSURE_SLACK/.test(hb));
}

// D9: renderQueueStats is imported from ./remotionRenderService (not a
// local re-implementation that could drift from the real queue).
check('D9: renderQueueStats imported from ./remotionRenderService',
  /require\(['"]\.\/remotionRenderService['"]\)/.test(titlerSrc)
  && /renderQueueStats/.test(titlerSrc));

// ── E. Automated revert-proofs ─────────────────────────────────────────────
// E1: If the backpressure check were removed from pollTick, D2 must fail.
//     Mutation: strip 'shouldSkipForBackpressure' from the pollTick body.
const strippedPollTick = titlerSrc.replace(
  /if \(shouldSkipForBackpressure\(\)\) break;/, ''
);
check('E1: [REVERT-PROOF] removing the pollTick check makes D2/D3 assertions fail',
  strippedPollTick.indexOf('shouldSkipForBackpressure(') === strippedPollTick.lastIndexOf('shouldSkipForBackpressure('));

// E2: If SLACK were bumped to 999 (effectively disabling backpressure),
//     A4/A5 would flip. Verify the check equation still uses SLACK.
check('E2: [REVERT-PROOF] SLACK constant is what the equation reads (not a hardcoded number)',
  /concurrency\s*\+\s*REMOTION_BACKPRESSURE_SLACK/.test(titlerSrc));

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\nverifyTitlerBackpressure: ${passes.length} pass, ${failures.length} fail`);
  process.exit(1);
}
for (const p of passes) console.log(`  ✓ ${p}`);
console.log(`\n✅ verifyTitlerBackpressure: ${passes.length}/${passes.length} checks passed`);
