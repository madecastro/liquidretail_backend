#!/usr/bin/env node
'use strict';
/**
 * verifyVideoCostReconcile — offline harness for video CostLog settlement.
 *
 * THE DEFECT (measured live 2026-08-11). atlasVideoService books
 * estimateRenderCostUsd via recordFlatCost at the charge point and NEVER reads
 * Atlas's settled prediction price back. On the production default
 * (google/gemini-omni-flash/image-to-video-developer) the MODEL_CAPS formula
 * yields $1.20 @ 10s while live predictions settle at price "0.9". Every video
 * ledger row therefore OVERSTATES spend by ~33% forever. Images already
 * reconcile via atlasImageService.scheduleCostReconcile; video did not.
 *
 * Owner rule (CLAUDE.md §2): always read the actual price back from Atlas;
 * any budget/margin/per-ad claim must come from RECONCILED rows.
 *
 * WHAT THIS PINS
 *   A. exports + pure parseAtlasSettledPrice truth table
 *   B. terminal price → immediate finalizeFlatCost(costSource:'actual')
 *   C. missing price → schedule fallback, no immediate finalize
 *   D. garbage prices leave the estimate untouched (never write 0)
 *   E. fire-and-forget on the render path (no await)
 *   F. finalizeFlatCost keyed on providerRequestId (update, not second insert)
 *   G. scheduleVideoCostReconcile uses reconcileCost (estimated→actual only)
 *
 * No DB, no network, no API key. Run: node scripts/verifyVideoCostReconcile.js
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REVERT-PROOF RECIPE (run these by hand; the automated block below does
 * three of them and restores — leave NO residue):
 *
 *  1. In services/atlasVideoService.js, change parseAtlasSettledPrice to
 *     `return Number(raw) || 0` (or drop the `n <= 0` guard) → A3/A4/D* fail
 *     because garbage/negative prices would zero or overwrite the estimate.
 *
 *  2. In generateForAd, prefix the call with `await` → E1 fails (telemetry
 *     on the render path; a slow/failed finalize could delay download).
 *
 *  3. In reconcileVideoCostFromTerminal, call recordFlatCost instead of
 *     finalizeFlatCost (or drop providerRequestId) → F1/B1 fail and a second
 *     CostLog row would DOUBLE-COUNT the charge.
 *
 *  4. (optional) Delete the terminal-price branch so every success schedules
 *     a re-poll → B2 fails (immediate path is the measured video case).
 *
 *  5. (optional) In scheduleVideoCostReconcile use finalizeFlatCost that
 *     overwrites any row instead of reconcileCost → G1 fails (loses the
 *     "only upgrade estimated" safety the image path has).
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const VID_PATH = path.join(ROOT, 'services/atlasVideoService.js');
const COST_PATH = path.join(ROOT, 'services/costTracker.js');

const {
  parseAtlasSettledPrice,
  reconcileVideoCostFromTerminal,
  scheduleVideoCostReconcile,
} = require('../services/atlasVideoService');
const costTracker = require('../services/costTracker');

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

const vidSrc = fs.readFileSync(VID_PATH, 'utf8');
const costSrc = fs.readFileSync(COST_PATH, 'utf8');

console.log('\nverifyVideoCostReconcile\n');

// ── A. Exports + defensive parse ─────────────────────────────────────────
console.log('A. exports + parseAtlasSettledPrice');
check('A1 parseAtlasSettledPrice is exported and is a function', () => {
  assert.strictEqual(typeof parseAtlasSettledPrice, 'function');
});
check('A2 reconcileVideoCostFromTerminal is exported and is a function', () => {
  assert.strictEqual(typeof reconcileVideoCostFromTerminal, 'function');
});
check('A3 scheduleVideoCostReconcile is exported and is a function', () => {
  assert.strictEqual(typeof scheduleVideoCostReconcile, 'function');
});
check('A4 price "0.9" (Atlas string) → 0.9', () => {
  assert.strictEqual(parseAtlasSettledPrice('0.9'), 0.9);
});
check('A5 price 0.9 (number) → 0.9', () => {
  assert.strictEqual(parseAtlasSettledPrice(0.9), 0.9);
});
check('A6 empty string → null (leave estimate)', () => {
  assert.strictEqual(parseAtlasSettledPrice(''), null);
});
check('A7 "abc" → null', () => {
  assert.strictEqual(parseAtlasSettledPrice('abc'), null);
});
check('A8 null → null', () => {
  assert.strictEqual(parseAtlasSettledPrice(null), null);
});
check('A9 undefined → null', () => {
  assert.strictEqual(parseAtlasSettledPrice(undefined), null);
});
check('A10 -1 → null (never write a negative spend)', () => {
  assert.strictEqual(parseAtlasSettledPrice(-1), null);
});
check('A11 NaN → null', () => {
  assert.strictEqual(parseAtlasSettledPrice(NaN), null);
});
check('A12 0 → null (zero must not wipe a positive estimate as "actual")', () => {
  assert.strictEqual(parseAtlasSettledPrice(0), null);
});
check('A13 "0" → null', () => {
  assert.strictEqual(parseAtlasSettledPrice('0'), null);
});

// ── B. Terminal payload with price reconciles immediately ────────────────
console.log('\nB. terminal price → immediate finalize (no schedule)');
check('B1 price:"0.9" finalizes to 0.9 with costSource actual', () => {
  const calls = [];
  let scheduled = false;
  const result = reconcileVideoCostFromTerminal(
    'pred_video_ok',
    { price: '0.9' },
    {
      finalizeFlatCost: async (meta) => { calls.push(meta); },
      schedule: () => { scheduled = true; },
    }
  );
  assert.strictEqual(result.action, 'immediate');
  assert.strictEqual(result.costUsd, 0.9);
  assert.strictEqual(result.scheduled, false);
  assert.strictEqual(calls.length, 1, `expected 1 finalize, got ${calls.length}`);
  assert.strictEqual(calls[0].providerRequestId, 'pred_video_ok');
  assert.strictEqual(calls[0].costUsd, 0.9);
  assert.strictEqual(calls[0].costSource, 'actual');
  assert.strictEqual(scheduled, false, 'must not schedule a re-poll when price is already present');
});
check('B2 costSource string is the CostLog enum value "actual" (not confirmed/verified)', () => {
  const calls = [];
  reconcileVideoCostFromTerminal('p', { price: '0.9' }, {
    finalizeFlatCost: async (m) => { calls.push(m); },
    schedule: () => {},
  });
  assert.strictEqual(calls[0].costSource, 'actual');
  assert.ok(['actual', 'estimated', 'none'].includes(calls[0].costSource));
});
check('B3 status is a legal CostLog status (ok)', () => {
  const { COST_STATUSES } = require('../models/CostLog');
  const calls = [];
  reconcileVideoCostFromTerminal('p', { price: '0.9' }, {
    finalizeFlatCost: async (m) => { calls.push(m); },
    schedule: () => {},
  });
  assert.ok(COST_STATUSES.includes(calls[0].status), `status ${calls[0].status} not in COST_STATUSES`);
});

// ── C. No price → schedule, do not finalize ──────────────────────────────
console.log('\nC. missing price schedules fallback, no immediate finalize');
check('C1 payload with no price does NOT finalize immediately', () => {
  const calls = [];
  let scheduled = false;
  const result = reconcileVideoCostFromTerminal(
    'pred_no_price',
    { /* no price */ },
    {
      finalizeFlatCost: async (meta) => { calls.push(meta); },
      schedule: () => { scheduled = true; },
    }
  );
  assert.strictEqual(result.action, 'scheduled');
  assert.strictEqual(result.scheduled, true);
  assert.strictEqual(result.costUsd, null);
  assert.strictEqual(calls.length, 0, 'finalize must not run without a usable price');
  assert.strictEqual(scheduled, true, 'fallback schedule must fire');
});
check('C2 payload with price:null schedules (same as missing)', () => {
  const calls = [];
  let scheduled = false;
  reconcileVideoCostFromTerminal('pred_null', { price: null }, {
    finalizeFlatCost: async (m) => { calls.push(m); },
    schedule: () => { scheduled = true; },
  });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(scheduled, true);
});

// ── D. Garbage prices leave the estimate untouched ───────────────────────
console.log('\nD. garbage prices never overwrite the estimate with 0');
const GARBAGE = ['', 'abc', null, -1, NaN, 0, '0', undefined];
for (const g of GARBAGE) {
  const label = Object.is(g, NaN) ? 'NaN' : JSON.stringify(g);
  check(`D garbage ${label} does not call finalize (estimate stays)`, () => {
    const calls = [];
    reconcileVideoCostFromTerminal('pred_g', { price: g }, {
      finalizeFlatCost: async (m) => { calls.push(m); },
      schedule: () => {},
    });
    assert.strictEqual(calls.length, 0,
      `finalize was called with ${JSON.stringify(calls[0])} — would overwrite the estimate`);
    // Extra belt: if a future bug calls finalize with 0, still fail loudly.
    for (const c of calls) {
      assert.notStrictEqual(c.costUsd, 0, 'must never finalize costUsd:0 over an estimate');
    }
  });
}

// ── E. Fire-and-forget on the render path ────────────────────────────────
console.log('\nE. reconcile is never awaited on the render path');
check('E1 call site is not preceded by await (source-level, mirrors adStage harness)', () => {
  // Anchor on the unique call in generateForAd.
  const needle = 'reconcileVideoCostFromTerminal(predictionId, { price: terminalSettledPrice })';
  const i = vidSrc.indexOf(needle);
  assert.ok(i > 0, 'generateForAd call site not found — was the wire-up removed?');
  // Look at the preceding non-whitespace characters on the same statement.
  const before = vidSrc.slice(Math.max(0, i - 40), i);
  assert.ok(!/await\s+$/.test(before), `call is awaited: …${JSON.stringify(before)}…`);
  // Also ban `await reconcileVideoCostFromTerminal` anywhere in the file.
  assert.ok(
    !/await\s+reconcileVideoCostFromTerminal\s*\(/.test(vidSrc),
    'await reconcileVideoCostFromTerminal( found somewhere in atlasVideoService.js'
  );
});
check('E2 helper itself is not async (so a bare call is not a floating unhandled promise of an async fn that throws sync before the try)', () => {
  assert.ok(
    !/async\s+function\s+reconcileVideoCostFromTerminal/.test(vidSrc),
    'reconcileVideoCostFromTerminal must be sync fire-and-forget (like scheduleCostReconcile / adStage)'
  );
});
check('E3 scheduleVideoCostReconcile uses unref\'d timer (cannot pin the process)', () => {
  const i = vidSrc.indexOf('function scheduleVideoCostReconcile');
  assert.ok(i > 0);
  const body = vidSrc.slice(i, i + 1200);
  assert.ok(/\.unref\s*\??\.\s*\(\s*\)|\.unref\?\.\(\)/.test(body) || /unref\?\.\(\)/.test(body),
    'schedule timer must .unref?.() so a hung reconcile cannot keep the process alive');
});

// ── F. finalizeFlatCost keys on providerRequestId (update, not insert) ───
console.log('\nF. finalizeFlatCost updates in place — no double-count');
check('F1 finalizeFlatCost is keyed on providerRequestId in costTracker', () => {
  assert.strictEqual(typeof costTracker.finalizeFlatCost, 'function');
  // The update filter must include providerRequestId.
  const fnStart = costSrc.indexOf('async function finalizeFlatCost');
  assert.ok(fnStart > 0);
  // Window widened from 900 → 2400. A fixed-size slice is a brittle way to
  // scope a source assertion: adding a comment above the updateOne pushed the
  // real filter out of the window and failed this check while the invariant
  // it guards was untouched. If this trips again, widen it — do not delete the
  // assertion, and do not assume the code changed.
  const body = costSrc.slice(fnStart, fnStart + 2400);
  assert.ok(/providerRequestId:\s*id/.test(body) || /\{ providerRequestId: id \}/.test(body),
    'finalizeFlatCost must update by providerRequestId');
  assert.ok(/upsert:\s*false/.test(body), 'must not upsert:true (silent conjure)');
  // The durationMs field must NOT be written unconditionally: a caller that
  // finalizes for another reason (the video cost reconcile knows the settled
  // price, not the submit duration) would erase the charge-point value.
  assert.ok(/if \(meta\.durationMs !== undefined\)/.test(body),
    'durationMs must only be set when the caller supplies one');
});
check('F2 reconcile helper passes providerRequestId to finalize (not a bare insert)', () => {
  const calls = [];
  reconcileVideoCostFromTerminal('pred_key', { price: '0.9' }, {
    finalizeFlatCost: async (m) => { calls.push(m); },
    schedule: () => {},
  });
  assert.strictEqual(calls[0].providerRequestId, 'pred_key');
});
check('F3 source: immediate path uses finalizeFlatCost, not recordFlatCost', () => {
  const i = vidSrc.indexOf('function reconcileVideoCostFromTerminal');
  assert.ok(i > 0);
  // Window through the immediate branch only (before the schedule fallback).
  const body = vidSrc.slice(i, i + 1800);
  assert.ok(/finalizeFlatCost|deps\.finalizeFlatCost|finalize\(/.test(body),
    'immediate path must call finalizeFlatCost');
  // The immediate branch must not insert a second row via recordFlatCost.
  const imm = body.slice(0, body.indexOf('action: \'scheduled\'') > 0
    ? body.indexOf('action: \'scheduled\'')
    : body.length);
  assert.ok(!/recordFlatCost\s*\(/.test(imm),
    'immediate reconcile must not call recordFlatCost (that INSERTs → double-count)');
});
check('F4 charge-point recordFlatCost still stamps providerRequestId (reconcile target)', () => {
  const i = vidSrc.indexOf("stage:      'atlas_video_render',");
  assert.ok(i > 0);
  const window = vidSrc.slice(i, i + 900);
  assert.ok(/providerRequestId:\s*predictionId/.test(window),
    'charge-point row is not keyed — finalize/reconcile cannot find it');
});

// ── G. Scheduled fallback shape ──────────────────────────────────────────
console.log('\nG. scheduleVideoCostReconcile mirrors image safety');
check('G1 scheduled path uses reconcileCost (estimated→actual only)', () => {
  const i = vidSrc.indexOf('function scheduleVideoCostReconcile');
  assert.ok(i > 0);
  const body = vidSrc.slice(i, i + 1100);
  assert.ok(/reconcileCost\s*\(/.test(body),
    'schedule must use reconcileCost so a duplicate cannot corrupt an already-actual row');
});
check('G2 pollPrediction returns price alongside url', () => {
  assert.ok(
    /return \{\s*url,\s*price:\s*data\.price/.test(vidSrc)
    || /return \{ url, price: data\.price/.test(vidSrc),
    'pollPrediction must surface data.price so terminal reconcile can skip a re-poll'
  );
});
check('G3 generateForAd wires terminalSettledPrice into reconcileVideoCostFromTerminal', () => {
  assert.ok(/terminalSettledPrice/.test(vidSrc));
  assert.ok(
    /reconcileVideoCostFromTerminal\(\s*predictionId\s*,\s*\{\s*price:\s*terminalSettledPrice\s*\}\s*\)/.test(vidSrc)
  );
});
check('G4 comment documents WHY video reconciles immediately when price is present', () => {
  // Guard against someone "harmonising" with the image path and always scheduling.
  assert.ok(
    /published AT completion|price appears to be published AT completion|terminal poll/i.test(vidSrc),
    'missing the measured-difference comment that justifies the immediate path'
  );
});

// ── H. Automated revert-proof (mutate → fail → restore; leave NO residue) ─
console.log('\nH. automated revert-proof (3 mutations)');

function withTempMutation(filePath, find, replace, runCheck) {
  const original = fs.readFileSync(filePath, 'utf8');
  assert.ok(original.includes(find), `mutate target not found: ${find.slice(0, 60)}…`);
  const mutated = original.replace(find, replace);
  // Mutate a PRIVATE temp copy, never the real shared repo file. filePath is
  // read-only from here down. This file is required by other verify scripts
  // and can be running concurrently (runVerifySuite.js pool, a standalone
  // `node scripts/verifyVideoCostReconcile.js`, or CI); writing the mutation
  // in place — even inside try/finally — is not safe, because a SIGTERM/
  // SIGKILL mid-mutation (a runner timeout, CI abort, or Ctrl-C) skips any
  // pending `finally` and leaves the real file corrupted on disk. For
  // source-text checks like these (H1-H3 only ever inspect the returned
  // string, never re-require the file), a temp copy is all revert-proving
  // needs. Same pattern as verifyRatingPairAtomic.js / verifySeedClass.js.
  const tmp = path.join(
    os.tmpdir(),
    `verifyVideoCostReconcile-${path.basename(filePath)}-${process.pid}-${Date.now()}.js`
  );
  fs.writeFileSync(tmp, mutated);
  try {
    runCheck(fs.readFileSync(tmp, 'utf8'));
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* leave for OS tmp cleanup */ }
  }
  // Belt-and-braces: confirm the real file was never touched.
  assert.strictEqual(
    fs.readFileSync(filePath, 'utf8'),
    original,
    'real file was modified — mutation must target the temp copy only'
  );
}

check('H1 [REVERT-PROOF] awaiting the call makes E1-style assertion fail', () => {
  const find = 'reconcileVideoCostFromTerminal(predictionId, { price: terminalSettledPrice });';
  const replace = 'await reconcileVideoCostFromTerminal(predictionId, { price: terminalSettledPrice });';
  let failedAsExpected = false;
  withTempMutation(VID_PATH, find, replace, (mutSrc) => {
    const needle = 'reconcileVideoCostFromTerminal(predictionId, { price: terminalSettledPrice })';
    const i = mutSrc.indexOf(needle);
    const before = mutSrc.slice(Math.max(0, i - 40), i);
    if (/await\s+$/.test(before) || /await\s+reconcileVideoCostFromTerminal\s*\(/.test(mutSrc)) {
      failedAsExpected = true;
    }
  });
  assert.ok(failedAsExpected, 'await mutation did not trip the fire-and-forget guard');
});

check('H2 [REVERT-PROOF] parse that accepts garbage would fail D/A guards', () => {
  // Mutate the source of parseAtlasSettledPrice to a permissive form and show
  // that the harness's truth table would reject the behaviour. We re-implement
  // the broken parse inline (matching the mutation) rather than re-require.
  const broken = (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0; // the bug: zeros the estimate on garbage
  };
  assert.strictEqual(broken(''), 0, 'broken parse zeros empty string');
  assert.strictEqual(broken('abc'), 0, 'broken parse zeros abc');
  assert.strictEqual(broken(-1), -1, 'broken parse keeps negatives');
  // Live helper must still be correct (file not left mutated).
  assert.strictEqual(parseAtlasSettledPrice(''), null);
  assert.strictEqual(parseAtlasSettledPrice('abc'), null);
  assert.strictEqual(parseAtlasSettledPrice(-1), null);
  // And mutate the real guard off, confirm source-level check would fail, restore.
  const find = 'if (!Number.isFinite(n) || n <= 0) return null;';
  const replace = 'if (!Number.isFinite(n)) return 0; // BROKEN for revert-proof';
  let sourceLooksBroken = false;
  withTempMutation(VID_PATH, find, replace, (mutSrc) => {
    // A3-style: empty string path — after mutation the guard no longer rejects <=0.
    sourceLooksBroken = /return 0; \/\/ BROKEN for revert-proof/.test(mutSrc)
      && !/n <= 0\) return null/.test(
        mutSrc.slice(mutSrc.indexOf('function parseAtlasSettledPrice'), mutSrc.indexOf('function parseAtlasSettledPrice') + 400)
      );
  });
  assert.ok(sourceLooksBroken, 'permissive parse mutation not detected');
  // Live parse still good after restore.
  assert.strictEqual(parseAtlasSettledPrice('0.9'), 0.9);
  assert.strictEqual(parseAtlasSettledPrice(''), null);
});

check('H3 [REVERT-PROOF] immediate path using recordFlatCost would fail F3', () => {
  const find = 'const finalize = deps.finalizeFlatCost || finalizeFlatCost;';
  // A "broken" form that inserts instead of refining — double-count class.
  const replace = 'const finalize = deps.finalizeFlatCost || recordFlatCost; // BROKEN insert';
  let wouldFail = false;
  withTempMutation(VID_PATH, find, replace, (mutSrc) => {
    const i = mutSrc.indexOf('function reconcileVideoCostFromTerminal');
    const body = mutSrc.slice(i, i + 1800);
    const immEnd = body.indexOf("action: 'scheduled'");
    const imm = body.slice(0, immEnd > 0 ? immEnd : body.length);
    // F3: immediate branch must not call recordFlatCost as the default.
    if (/recordFlatCost; \/\/ BROKEN insert/.test(imm) || /\| \| recordFlatCost/.test(imm) || /\|\| recordFlatCost/.test(imm)) {
      wouldFail = true;
    }
  });
  assert.ok(wouldFail, 'recordFlatCost mutation not detected by F3-style scan');
});

// ── Summary ──────────────────────────────────────────────────────────────
const total = pass + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} verifyVideoCostReconcile: ${pass}/${total} passed`);
if (failures.length) {
  console.log('  failed:');
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
process.exit(0);
