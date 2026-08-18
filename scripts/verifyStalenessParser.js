#!/usr/bin/env node
/**
 * ONE staleness parser, shared by the web gate and the worker reaper.
 *
 * WHY THIS EXISTS. REAP_STALE_MIN was parsed two different ways in two
 * processes that are REQUIRED to agree about what "stale" means:
 *
 *   worker.js      Math.max(1, parseInt(env, 10) || 15)
 *   routes/ads.js  Number.isFinite(raw) && raw > 0 ? raw : 15
 *
 * They agree on every input except two, and the disagreement runs the wrong
 * way on the one that matters:
 *
 *   value   old worker   old web   unified
 *   '-5'    1            15        15
 *   '7.9'   7            7.9       7.9
 *
 * A negative resolving to **1** hands the reaper a ONE-MINUTE threshold, so it
 * sweeps ads and runs a minute old — reaping live work mid-render. routes/ads.js
 * already asserted the invariant in a comment ("the two cannot drift into
 * disagreeing about what stale means"); a single parser is what enforces it.
 *
 * The money case is 0 / blank / whitespace / negative, and BOTH vars have one
 * (corrected 2026-08-18 — this header used to attribute the flip guard to
 * REAP_STALE_MIN, which stopped being true when the preparing lifecycle moved
 * to its own window):
 *
 *   PREPARE_STALE_MIN keys buildRunningFlipFilter's age guard, so a value that
 *     collapses to <= 0 makes `startedAt >= now` unsatisfiable and turns EVERY
 *     Generate into "pay for Director + Judge, claim the ads, discard all of
 *     them" — a silent total generation outage.
 *   REAP_STALE_MIN bounds the concurrency gate's RUNNING arm (and the reapers).
 *     A value that collapses to <= 0 empties that arm, so a run that is
 *     actively submitting billable work is invisible to the gate and a
 *     duplicate /generate is admitted with no 409 and no confirm — a double
 *     bill rather than an outage.
 *
 * REAP_STALE_MIN is dashboard-only and PREPARE_STALE_MIN ships in
 * config/defaults.env; either is somewhere "set it to 0 to disable" is the
 * intuitive and catastrophic move.
 *
 * Run: node scripts/verifyStalenessParser.js   (no DB, no network, no key)
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const staleness = require('../services/staleness');

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (e) { fail++; console.log(`  ✗ ${label} — ${String(e.message).split('\n')[0].slice(0, 190)}`); }
}
function withEnv(key, val, fn) {
  const prev = process.env[key];
  if (val === undefined) delete process.env[key]; else process.env[key] = val;
  try { return fn(); }
  finally { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; }
}

console.log('\nStaleness parser — one source of truth');

// ── A. the money cases: anything not a positive finite number falls back ──
const MUST_FALL_BACK = [undefined, '', '   ', '0', '-5', '-0.1', 'abc', 'NaN', 'null'];
for (const v of MUST_FALL_BACK) {
  ok(`A ${JSON.stringify(v)} falls back to 15, never <= 0`, () => {
    withEnv('REAP_STALE_MIN', v, () => {
      const got = staleness.reapStaleMin();
      assert.strictEqual(got, 15, `got ${got}`);
      assert.ok(got > 0, 'a staleness bound <= 0 reaps live work / discards every generation');
    });
  });
}

// ── B. legitimate values are honoured, including fractional ──
ok('B1 a normal value is honoured', () => {
  withEnv('REAP_STALE_MIN', '30', () => assert.strictEqual(staleness.reapStaleMin(), 30));
});
ok('B2 a fractional value is NOT truncated (old worker parseInt gave 7)', () => {
  withEnv('REAP_STALE_MIN', '7.9', () => assert.strictEqual(staleness.reapStaleMin(), 7.9));
});
ok('B3 PREPARE_STALE_MIN is an independent knob, same guarantees', () => {
  // Default is 30, NOT 15 (raised 2026-08-18). The two windows are deliberately
  // different numbers: 15 is the CLAIMED-doc heartbeat window (Ad 'rendering',
  // CampaignRun 'running'), while a 'preparing' run never heartbeats and has a
  // documented healthy runtime of ~18-20 min. Keying the preparing lifecycle on
  // 15 was failing expansions that were merely finishing. Asserted against the
  // exported constant rather than a literal so this cannot silently drift from
  // the value the code actually ships.
  assert.strictEqual(staleness.PREPARE_STALE_MIN_DEFAULT, 30,
    'preparing window must clear the ~18-20min healthy expansion ceiling');
  withEnv('PREPARE_STALE_MIN', '0', () =>
    assert.strictEqual(staleness.prepareStaleMin(), staleness.PREPARE_STALE_MIN_DEFAULT));
  withEnv('PREPARE_STALE_MIN', '45', () => assert.strictEqual(staleness.prepareStaleMin(), 45));
});
ok('B4 the two windows are SEPARATE — raising preparing must not have moved the claimed-doc window', () => {
  // The whole affordability argument for 30 is that RUNNING runs and Ads keep
  // 15: raising REAP_STALE_MIN too would delay orphan requeue for every claimed
  // doc. If someone "simplifies" these back into one constant, this fails.
  assert.strictEqual(staleness.REAP_STALE_MIN_DEFAULT, 15, 'claimed-doc window must stay 15');
  assert.ok(staleness.PREPARE_STALE_MIN_DEFAULT > staleness.REAP_STALE_MIN_DEFAULT,
    'the preparing window is longer than the claimed-doc window by design, not by accident');
  withEnv('PREPARE_STALE_MIN', '99', () => {
    assert.strictEqual(staleness.reapStaleMin(), 15,
      'PREPARE_STALE_MIN must not leak into reapStaleMin() — separate env vars, separate lifecycles');
  });
  withEnv('REAP_STALE_MIN', '99', () => {
    assert.strictEqual(staleness.prepareStaleMin(), 30,
      'REAP_STALE_MIN must not leak into prepareStaleMin()');
  });
});

// ── C. THE REGRESSION THIS FIXES: the two old idioms disagreed ──
const oldWorker = (raw) => Math.max(1, parseInt(raw, 10) || 15);
ok('C1 [REGRESSION] the OLD worker idiom returns 1 on a negative — a 1-minute reap threshold', () => {
  assert.strictEqual(oldWorker('-5'), 1, 'if this no longer reproduces, rewrite this harness note');
});
ok('C2 the unified parser refuses that value instead of clamping to 1', () => {
  withEnv('REAP_STALE_MIN', '-5', () => assert.strictEqual(staleness.reapStaleMin(), 15));
});
ok('C3 web and worker now agree on EVERY input (one parser, by construction)', () => {
  for (const v of [...MUST_FALL_BACK, '30', '7.9', '1e2']) {
    withEnv('REAP_STALE_MIN', v, () => {
      assert.strictEqual(staleness.reapStaleMin(), staleness.reapStaleMin());
    });
  }
});

// ── D. wiring: no inline parse may come back ──
// Source scan is the right shape here ONLY because the assertion is about the
// ABSENCE of a second parser — behaviour cannot observe a duplicate that agrees
// today and drifts tomorrow. The behavioural guarantees are A–C above.
const adsSrc    = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const INLINE = /(?:parseInt|Number)\s*\(\s*process\.env\.(?:REAP_STALE_MIN|PREPARE_STALE_MIN)/;

ok('D1 routes/ads.js does not parse REAP_STALE_MIN inline', () => {
  assert.ok(!INLINE.test(adsSrc), 'an inline parse reintroduces the drift this module removed');
});
ok('D2 worker.js does not parse either var inline', () => {
  assert.ok(!INLINE.test(workerSrc), 'an inline parse reintroduces the drift this module removed');
});
ok('D3 routes/ads.js reads the bound through the shared parser', () => {
  assert.ok(/require\(['"]\.\.\/services\/staleness['"]\)/.test(adsSrc), 'ads.js does not require staleness.js');
  assert.ok(/reapStaleMin\(\)/.test(adsSrc), 'ads.js does not call reapStaleMin()');
});
ok('D4 worker.js reads both bounds through the shared parser', () => {
  assert.ok(/require\(['"]\.\/services\/staleness['"]\)/.test(workerSrc), 'worker.js does not require staleness.js');
  assert.ok(/reapStaleMin\(\)/.test(workerSrc) && /prepareStaleMin\(\)/.test(workerSrc),
    'worker.js does not call both accessors');
});

console.log(`\n${fail ? '❌' : '✅'} verifyStalenessParser: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
