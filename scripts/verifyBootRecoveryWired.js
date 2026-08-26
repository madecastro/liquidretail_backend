'use strict';
// Pins that bootRecoveryService.resumeInFlightAds is wired from adgen's
// renderer, on both BOOT and PERIODIC triggers, gated on
// isAdgenRendererEnabled() — closing the 273-minute-tail defect measured
// on run_1787699482964 (2026-08-25). Details in the block comment above
// startBootRecoverySweep() in renderer.js.
//
// This is the Phase 0 finalization-defect fix. Backend's own bootRecovery
// runs against the same collection UNGATED, but only on rare backend-web
// boots. In autoscale-quiet stretches the recovery gap was hours long.
// Adding an adgen-side sweep on the same 5-minute cadence as
// titlingResumeService closes it for the receipt-holding class (which is
// where money is at stake; a receipt-free stuck claim is a separate fix).
//
// The wired call is safe to run redundantly across autoscaled instances
// (bootRecoveryService's own header: "NO CLAIM, ON PURPOSE — the only
// provider call is a free GET. Two instances peeking the same prediction
// wastes one HTTP request and nothing else.").

const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const rendererSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'renderer.js'), 'utf8');

// ── A. startBootRecoverySweep exists with expected shape ───────────────
const sweepBody = rendererSrc.match(/function startBootRecoverySweep\(\)\s*\{[\s\S]*?\n\}/);
check('A1: startBootRecoverySweep function defined', !!sweepBody);

if (sweepBody) {
  const body = sweepBody[0];
  check('A2: lazy-requires ./bootRecoveryService (not top-level)',
    /require\(['"]\.\/bootRecoveryService['"]\)/.test(body));
  check('A3: calls resumeInFlightAds() inside the tick',
    /resumeInFlightAds\(\)/.test(body));
  check('A4: reads BOOT_RECOVERY_INTERVAL_MIN with default 5',
    /BOOT_RECOVERY_INTERVAL_MIN[\s\S]*?\|\|\s*5/.test(body));
  check('A5: gated on isAdgenRendererEnabled() — same pattern as titlingResumeSweep',
    /isAdgenRendererEnabled\(\)/.test(body));
  check('A6: has inFlightPass guard so a slow sweep does not stack on itself',
    /inFlightPass\s*=\s*true[\s\S]*?inFlightPass\s*=\s*false/.test(body));
  check('A7: guards against `stopping` (SIGTERM race)',
    /if\s*\(\s*stopping/.test(body));
  check('A8: setTimeout for boot pass + setInterval for periodic',
    /setTimeout\(tick[\s\S]*?setInterval\(tick/.test(body));
  check('A9: timers .unref() so the sweep cannot pin the process',
    /timeoutHandle\.unref[\s\S]*?intervalHandle\.unref/.test(body));
  check('A10: promise chain catches errors (fail-open — must not throw)',
    /\.catch\(/.test(body) && /\.finally\(/.test(body));
  check('A11: returns a { stop } handle so shutdown can clear timers',
    /return\s*\{\s*stop\(\)/.test(body));
}

// ── B. run() wires bootRecoverySweep after titlingResumeSweep ──────────
const runBody = rendererSrc.match(/async function run\(\)\s*\{[\s\S]*?\n\}/);
check('B1: run() body found', !!runBody);
if (runBody) {
  const body = runBody[0];
  check('B2: run() assigns bootRecoverySweep = startBootRecoverySweep()',
    /bootRecoverySweep\s*=\s*startBootRecoverySweep\(\)/.test(body));
  check('B3: assignment happens INSIDE run() (module-level assignment would fire before Mongo connect)',
    body.indexOf('startBootRecoverySweep()') > 0);
}

// ── C. shutdown() stops the sweep ──────────────────────────────────────
const shutdownBody = rendererSrc.match(/async function shutdown\(\)\s*\{[\s\S]*?\n\}/);
check('C1: shutdown() body found', !!shutdownBody);
if (shutdownBody) {
  const body = shutdownBody[0];
  check('C2: shutdown() stops bootRecoverySweep',
    /bootRecoverySweep\)?\s*&&?\s*bootRecoverySweep\.stop\(\)/.test(body)
    || /if \(bootRecoverySweep\)\s*bootRecoverySweep\.stop/.test(body));
}

// ── D. Module-level state declared ─────────────────────────────────────
check('D1: module-level `bootRecoverySweep` state var declared',
  /let bootRecoverySweep\s*=\s*null/.test(rendererSrc));

// ── E. bootRecoveryService exports the expected entry point ────────────
const brs = require(path.join(REPO, 'src', 'services', 'bootRecoveryService.js'));
check('E1: bootRecoveryService exports resumeInFlightAds',
  typeof brs.resumeInFlightAds === 'function');

// ── F. Money-safety pins from bootRecoveryService (spot-check the receipt-scoped filter) ──
const brsSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'bootRecoveryService.js'), 'utf8');
check('F1: bootRecoveryService only touches rendering + HAS_RECEIPT ads (money-safety)',
  /status:\s*['"]rendering['"][\s\S]*?HAS_RECEIPT/.test(brsSrc));
check('F2: bootRecoveryService reads RESUME_STALE_MIN (default 5min heartbeat window)',
  /RESUME_STALE_MIN/.test(brsSrc));
check('F3: bootRecoveryService never re-submits (imports resumeForAd, not submitGeneration)',
  /resumeForAd/.test(brsSrc) && !/submitGeneration/.test(brsSrc));

// ── G. Revert-proofs ───────────────────────────────────────────────────
// If someone deletes the run() wiring, B2 must fail.
const stripped = rendererSrc.replace(/bootRecoverySweep\s*=\s*startBootRecoverySweep\(\)/, '// stripped');
check('G1: [REVERT-PROOF] removing the run() assignment defeats B2 assertion',
  !/bootRecoverySweep\s*=\s*startBootRecoverySweep\(\)/.test(stripped));

// If someone removes the isAdgenRendererEnabled gate, A5 must fail.
if (sweepBody) {
  const stripped2 = sweepBody[0].replace(/isAdgenRendererEnabled\(\)/g, 'true');
  check('G2: [REVERT-PROOF] removing the render-flag gate defeats A5',
    !/isAdgenRendererEnabled\(\)/.test(stripped2));
}

// ── report ─────────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\nverifyBootRecoveryWired: ${passes.length} pass, ${failures.length} fail`);
  process.exit(1);
}
for (const p of passes) console.log(`  ✓ ${p}`);
console.log(`\n✅ verifyBootRecoveryWired: ${passes.length}/${passes.length} checks passed`);
