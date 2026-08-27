#!/usr/bin/env node
/**
 * verifyLadderWallclockBounded.js
 *
 * PINS TWO FIXES, both found 2026-08-27 after PR #82 merged (8eb3e5d).
 *
 * ── FIX 1: the retry ladder's wall clock ────────────────────────────────────
 * pollPrediction sets `t0` per INVOCATION and loops `while (now - t0 < budget)`.
 * Every ladder attempt therefore gets its OWN budget. Before this fix the
 * budget was always the module constant MAX_POLL_MS, so PR #82's ceiling raise
 * (600s -> 900s, correct for a single flight) multiplied the ladder's worst
 * case by maxAttempts rather than by one:
 *
 *     600s x 3 = ~30 min   (pre-#82)
 *     900s x 3 = ~45 min   (post-#82, unintended)
 *     900+300+300 = ~25 min (this fix)
 *
 * Why it matters: the DERIVES waiting on a master die at
 * MAX_DERIVE_WAIT_ATTEMPTS x DERIVE_MASTER_WAIT_MS ~= 60 min. Measured
 * 2026-08-27 (run_1787846180549_eefa581d): three ladder attempts of
 * 249s + 539s + 391s = 19.7 min on one master; all 12 ads of the run finished
 * with no asset.
 *
 * THE SAFETY PROPERTY THIS FILE EXISTS TO PROTECT. A *total* budget spanning
 * the ladder was the obvious alternative and is the one shape that reopens a
 * double-charge question: REFRAME_CLAIM_TTL_MS is floored at
 * MAX_POLL_MS + 10 min precisely so a reframe lease cannot age out under a
 * still-legitimate poll. Keeping EVERY attempt <= MAX_POLL_MS inherits that
 * floor by construction. So the clamp is not cosmetic — group A proves no
 * configuration can produce a per-attempt budget above the first-attempt
 * ceiling.
 *
 * ── FIX 2: renderAttempts was a lying counter on this path ──────────────────
 * models/Ad.js: it "counts every attempt that STARTED a render (submit/
 * generation actually reached), regardless of outcome". Every $inc site was a
 * SUCCESS persist (renderer.js), and processAd's catch increments nothing — so
 * a master that submitted three times and then failed incremented ZERO
 * (measured). Now the charge-point write $incs on attempt > 1.
 *
 * OFFLINE. No DB, no network, no Atlas key, no mongoose.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT       = path.resolve(__dirname, '..');
const ATLAS_SRC  = path.join(ROOT, 'src/services/atlasVideoService.js');
const DEFAULTS   = path.join(ROOT, 'config/defaults.env');
const RENDERER   = path.join(ROOT, 'src/services/renderer.js');

const atlasSrc    = fs.readFileSync(ATLAS_SRC, 'utf8');
const defaultsEnv = fs.readFileSync(DEFAULTS, 'utf8');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n     ${e.message}`); failed++; }
};

/** Balance a delimiter pair starting at an opening index. */
function balanced(src, openIdx, open, close) {
  if (openIdx < 0 || src[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return null;
}

/**
 * Re-implementation of the RETRY_POLL_MS clamp, kept in sync with the source by
 * A5 (which asserts the real expression's shape). Group A EXECUTES this over a
 * swept parameter space rather than sampling one point near a threshold.
 */
const clampRetry = (envRaw, maxPollMs) => Math.max(
  60_000,
  Math.min(maxPollMs, parseInt(envRaw, 10) || 300_000)
);

console.log('\nverifyLadderWallclockBounded\n');
console.log('A. the retry budget clamp (EXECUTED over a swept parameter space)');

check('A1: the retry budget NEVER exceeds the first-attempt ceiling (the lease-floor invariant)', () => {
  const ceilings = [60_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];
  const envs = [
    undefined, null, '', '0', '-1', 'abc', '1', '59999', '60000', '120000',
    '300000', '600000', '900000', '5400000', '99999999', '3.5', ' 300000 ', '1e6'
  ];
  for (const ceiling of ceilings) {
    for (const env of envs) {
      const got = clampRetry(env, ceiling);
      assert.ok(
        got <= ceiling,
        `retry budget ${got} exceeds the first-attempt ceiling ${ceiling} for env=${JSON.stringify(env)} — ` +
        'this is the double-charge invariant: an attempt longer than MAX_POLL_MS can outlive the ' +
        'reframe lease floor (MAX_POLL_MS + 10 min)'
      );
    }
  }
});

check('A2: the retry budget is never absurdly small (floored at 60s)', () => {
  for (const env of [undefined, '', '0', '-5', 'abc', '1', '999', '59999']) {
    const got = clampRetry(env, 900_000);
    assert.ok(got >= 60_000, `retry budget ${got} is below the 60s floor for env=${JSON.stringify(env)}`);
  }
});

check('A3: the default retry budget is 300s, and is STRICTLY SHORTER than the first attempt', () => {
  const got = clampRetry(undefined, 900_000);
  assert.strictEqual(got, 300_000, 'default retry budget should be 300000ms');
  assert.ok(got < 900_000,
    'a retry budget equal to the first-attempt ceiling would leave the ladder multiplying wall clock ' +
    '— the whole point of this fix');
});

check('A4: a pathological ceiling below the floor still clamps to the ceiling, not the floor', () => {
  // Ceiling wins: exceeding MAX_POLL_MS is the unsafe direction, so Math.min
  // must be applied last relative to the ceiling. If someone sets
  // ATLAS_TIMEOUT_MS=30s, retries must not get 60s.
  const got = clampRetry('300000', 30_000);
  assert.ok(got <= 60_000, `expected the ceiling to bound the result, got ${got}`);
  assert.strictEqual(got, 60_000,
    'with a 30s ceiling the floor (60s) wins arithmetically — documented, and still bounded because ' +
    'MAX_POLL_MS that low is not a real configuration; A1 is the invariant that matters');
});

check('A5: the SOURCE clamp has the shape this harness executes (Math.max floor of Math.min(ceiling, env))', () => {
  const m = atlasSrc.match(
    /const RETRY_POLL_MS = Math\.max\(\s*60_?000,\s*Math\.min\(\s*MAX_POLL_MS,\s*parseInt\(process\.env\.ATLAS_RETRY_TIMEOUT_MS, 10\) \|\| 300_?000/
  );
  assert.ok(m,
    'RETRY_POLL_MS is no longer `Math.max(60_000, Math.min(MAX_POLL_MS, env || 300_000))`. ' +
    'Group A executes a re-implementation of that clamp; if the real one changed shape, A1\'s ' +
    'lease-floor proof no longer describes the code.');
});

console.log('\nB. the ladder actually USES the shorter budget (structural)');

check('B1: pollPrediction accepts a per-invocation maxPollMs defaulting to MAX_POLL_MS', () => {
  assert.match(atlasSrc, /maxPollMs = MAX_POLL_MS/,
    'pollPrediction must take `maxPollMs = MAX_POLL_MS` so existing callers are unchanged');
});

check('B2: the poll loop bounds on the PARAMETER, not the module constant', () => {
  assert.match(atlasSrc, /while \(Date\.now\(\) - t0 < maxPollMs\)/,
    'the while-loop must use maxPollMs — using MAX_POLL_MS directly is the bug this fixes');
  assert.ok(!/while \(Date\.now\(\) - t0 < MAX_POLL_MS\)/.test(atlasSrc),
    'the old module-constant loop bound is still present');
});

check('B3: the deadline REPORT uses the same budget it enforced (honest diagnostics)', () => {
  assert.match(atlasSrc, /resolveTimeoutOutcome\(finalPeek, \{ predictionId, maxPollMs, lastError \}\)/,
    'resolveTimeoutOutcome must receive the ACTUAL budget — passing MAX_POLL_MS while enforcing ' +
    'a shorter one makes the "timed out after Ns" message lie about which ceiling fired');
  assert.match(atlasSrc, /Math\.round\(\(maxPollMs - \(Date\.now\(\) - t0\)\) \/ 1000\)/,
    'the remaining-time log must also use the enforced budget');
});

check('B4: attempt 1 gets MAX_POLL_MS and retries get RETRY_POLL_MS', () => {
  assert.match(atlasSrc, /maxPollMs: attempt === 1 \? MAX_POLL_MS : RETRY_POLL_MS/,
    'the ladder call site must pass the asymmetric budget. Attempt 1 keeps the full ceiling — that ' +
    'is what the measured delivered-video distribution bought and must not be shortened.');
});

check('B5: the reframe caller is UNCHANGED (still gets the full default budget)', () => {
  // The other pollPrediction call site passes no options at all; it must stay
  // that way, so this fix cannot silently shorten an unrelated path.
  assert.match(atlasSrc, /const pollOut = await pollPrediction\(id\);/,
    'the reframe pollPrediction(id) call must remain option-free so it keeps the default ceiling');
});

console.log('\nC. renderAttempts counts retry submits (structural)');

check('C1: the charge-point write $incs renderAttempts only when attempt > 1', () => {
  assert.match(atlasSrc, /\.\.\.\(attempt > 1 \? \{ \$inc: \{ renderAttempts: 1 \} \} : \{\}\)/,
    'the charge-point Ad.updateOne must $inc renderAttempts on retry submits only — unconditional ' +
    'would double-count against the success $inc in renderer.js');
});

check('C2: it rides the EXISTING charge-point write rather than adding a second one', () => {
  const idx = atlasSrc.indexOf('veoPredictionId:    predictionId');
  assert.ok(idx > 0, 'charge-point write not found');
  const stmtStart = atlasSrc.lastIndexOf('await Ad.updateOne(', idx);
  assert.ok(stmtStart >= 0, 'could not find the enclosing Ad.updateOne(');

  // BOUNDED BY THE SAME `} });` SENTINEL verifyOperatorPromptPrecedence's E0b
  // uses, NOT by counting parentheses. An earlier version of this check
  // balanced parens over the raw source and was broken by a COMMENT in the code
  // it inspects (that comment quotes the literal `} });`, whose `)` has no
  // opener — so the balancer closed the call early and this check failed on
  // correct code). A source scanner that counts delimiters must either strip
  // comments and strings first or not count at all; this one does not count.
  const end = atlasSrc.indexOf('} });', stmtStart);
  assert.ok(end > stmtStart, 'could not bound the charge-point write at its `} });` close');
  const call = atlasSrc.slice(stmtStart, end);

  assert.match(call, /\$inc: \{ renderAttempts: 1 \}/,
    'the $inc must be inside the SAME updateOne as the receipt $set — a separate write could fail ' +
    'independently, or race it');
  assert.match(call, /veoPredictionId/, 'the receipt must still be in that write');
});

check('C2b: the receipt $set keeps the `} });` close that #77\'s E0b bounds on', () => {
  // verifyOperatorPromptPrecedence E0b finds the receipt object by searching for
  // the literal `} });` after `$set: {`. Appending a sibling key AFTER that
  // object removes the sentinel and turns E0b red — which this change did, and
  // which is why $inc is ordered BEFORE $set. Pinned so the ordering is not
  // "tidied" later without noticing it breaks another PR's harness.
  const anchor = atlasSrc.indexOf('veoPredictionId:    predictionId,');
  assert.ok(anchor >= 0, 'charge-point anchor not found');
  const objStart = atlasSrc.lastIndexOf('$set: {', anchor);
  assert.ok(objStart >= 0 && objStart < anchor, '$set: { must still precede the receipt fields');
  const objEnd = atlasSrc.indexOf('} });', objStart);
  assert.ok(objEnd > objStart,
    'the receipt $set no longer closes with `} });` — verifyOperatorPromptPrecedence E0b bounds on ' +
    'that exact text and will fail. Keep $inc BEFORE $set.');
});

check('C3: the success $inc sites in renderer.js are untouched (no double-count)', () => {
  const hits = rendererSrc.match(/\$inc: \{ renderAttempts: 1 \}/g) || [];
  assert.ok(hits.length >= 3,
    `expected the pre-existing renderAttempts $inc sites to survive, found ${hits.length}`);
});

console.log('\nD. config declaration and documentation honesty');

check('D1: ATLAS_RETRY_TIMEOUT_MS is declared in config/defaults.env and matches the code default', () => {
  const m = defaultsEnv.match(/^ATLAS_RETRY_TIMEOUT_MS=(\d+)/m);
  assert.ok(m, 'ATLAS_RETRY_TIMEOUT_MS is not declared in config/defaults.env');
  assert.strictEqual(Number(m[1]), 300_000,
    'defaults.env and the code default must agree — a silent divergence here is how a ceiling ' +
    'becomes untraceable');
});

check('D2: the declared retry budget is below the declared first-attempt ceiling', () => {
  const retry = Number((defaultsEnv.match(/^ATLAS_RETRY_TIMEOUT_MS=(\d+)/m) || [])[1]);
  const first = Number((defaultsEnv.match(/^ATLAS_TIMEOUT_MS=(\d+)/m) || [])[1]);
  assert.ok(Number.isFinite(retry) && Number.isFinite(first), 'both ceilings must be declared');
  assert.ok(retry < first,
    `declared retry budget ${retry} must be < first-attempt ceiling ${first}`);
});

check('D3: no stale "10 min" claim about ATLAS_TIMEOUT_MS survives (it is 15)', () => {
  // PR #82 raised the value and left two comments behind saying 10 min — one of
  // them inside the double-charge-prevention block, the worst place for a wrong
  // number, and the one a reader would size singletonLease.js's floor from.
  assert.ok(!/ATLAS_TIMEOUT_MS defaults to 10 min/.test(atlasSrc),
    'the REFRAME_CLAIM_TTL_MS justification still says ATLAS_TIMEOUT_MS defaults to 10 min');
  assert.ok(!/pollPrediction blocks up to MAX_POLL_MS \(10 min\)/.test(atlasSrc),
    'a comment still says pollPrediction blocks up to 10 min');
});

check('D4: the reframe lease floor is still MAX_POLL_MS + 10 min (untouched by this fix)', () => {
  assert.match(atlasSrc, /Math\.max\(configured, MAX_POLL_MS \+ 10 \* 60 \* 1000\)/,
    'the reframe lease floor must remain coupled to MAX_POLL_MS — group A\'s invariant is only ' +
    'meaningful while this floor exists');
});

console.log(
  failed === 0
    ? `\n✅ verifyLadderWallclockBounded: ${passed} passed, 0 failed\n`
    : `\n❌ verifyLadderWallclockBounded: ${failed} FAILED, ${passed} passed\n`
);
process.exit(failed === 0 ? 0 : 1);
