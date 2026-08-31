#!/usr/bin/env node
'use strict';
/**
 * verifyMasterPathParallel — pins the parallelization of refreshStaleLayoutInput
 * and buildReferenceImages on the video master path in atlasVideoService.js
 * `generateForAd()`.
 *
 * Background: pre-2026-08-31 the two ran sequentially — layoutInput (~43s on
 * cache-miss) then reframe (~54s on cold path) = 97s per master. They are
 * independent (reframe reads media + catalogMedias + aspectRatio; layoutInput
 * reads brand + product + campaign context), so a Promise.all reduces this to
 * max(43, 54) = 54s. This saves ~43s off every video master render.
 *
 * The pin protects against three regressions:
 *   1. Someone re-serializes them (revert or refactor drift).
 *   2. lpInput / lpSrcMedia get moved BEFORE the parallel block, forcing a
 *      sequential dependency that defeats the whole point.
 *   3. The empty-imageUrls throw ("no reference images available") is
 *      preserved — dropping it would let a broken run submit to Omni with
 *      no references and burn ~$0.90.
 *
 * Offline: no DB, no network, no API keys.
 *   node scripts/verifyMasterPathParallel.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const src = fs.readFileSync(path.join(ROOT, 'services/atlasVideoService.js'), 'utf8');

// Isolate the generateForAd function body — everything from its declaration
// through the first `}` at column 0 (the closing brace of the function).
// This scoping is what keeps prepareStoryboard's own refreshStaleLayoutInput
// call from satisfying the pins by accident: it never calls buildReferenceImages.
const genForAdStart = src.indexOf('async function generateForAd({');
if (genForAdStart < 0) {
  console.log('✗ could not locate generateForAd function — bail');
  process.exit(1);
}
// Bound by the NEXT top-level function declaration after generateForAd.
// The one that follows in this file today is downloadToBuffer; if that
// gets renamed, fall back to the next `async function` or `module.exports`
// (whichever comes first).
const afterStart = src.slice(genForAdStart + 1);
const candidates = [
  afterStart.indexOf('\nasync function '),
  afterStart.indexOf('\nfunction '),
  afterStart.indexOf('\nmodule.exports')
].filter((i) => i > 0);
const endOffset = Math.min(...candidates);
const genForAdBody = src.slice(genForAdStart, genForAdStart + 1 + endOffset);

// ── P1: single Promise.all wraps both calls ──
// The whole point is one race, not two. A regression that awaits them
// separately (even if lexically close) would defeat the trim.
{
  const promiseAllMatch = /const\s*\[\s*layoutInput\s*,\s*imageUrls\s*\]\s*=\s*await\s+Promise\.all\s*\(\s*\[/
    .test(genForAdBody);
  check(
    'P1: `const [layoutInput, imageUrls] = await Promise.all([` present in generateForAd',
    promiseAllMatch,
    'either the destructure order changed or the two calls got separated'
  );
}

// ── P2: refreshStaleLayoutInput is inside the Promise.all ──
{
  const inside = /Promise\.all\s*\(\s*\[[\s\S]{0,600}refreshStaleLayoutInput\s*\(/.test(genForAdBody);
  check(
    'P2: refreshStaleLayoutInput is called inside the Promise.all list',
    inside,
    'layoutInput derive moved outside the parallel block'
  );
}

// ── P3: buildReferenceImages is inside the same Promise.all ──
{
  const inside = /Promise\.all\s*\(\s*\[[\s\S]{0,1400}buildReferenceImages\s*\(/.test(genForAdBody);
  check(
    'P3: buildReferenceImages is called inside the Promise.all list',
    inside,
    'reframe moved outside the parallel block'
  );
}

// ── P4: lpInput / lpSrcMedia are declared AFTER the Promise.all ──
// If either read moves ABOVE the parallel block, the parallelization is
// broken (the reader forces sequential await of layoutInput before reframe
// can be scheduled). Order-based pin: `Promise.all` index < `const lpInput`.
{
  const promiseIdx = genForAdBody.indexOf('Promise.all');
  const lpIdx = genForAdBody.indexOf('const lpInput');
  check(
    'P4: `const lpInput` appears after the Promise.all in generateForAd',
    promiseIdx > 0 && lpIdx > promiseIdx,
    `promiseIdx=${promiseIdx} lpIdx=${lpIdx} — a reader that runs before the parallel await forces serialization`
  );
}

// ── P5: empty-imageUrls throw is preserved ──
// The parallelization must not swallow the money guard. buildReferenceImages
// returning [] means no references — submitting to Omni with an empty stack
// would burn ~$0.90 for garbage output. Kept where it was, right after the
// Promise.all resolves.
{
  const guard = /if\s*\(\s*!\s*imageUrls\.length\s*\)\s*throw new Error\(\s*`atlasVideo\[ad=\$\{ad\._id\}\]: no reference images available`/
    .test(genForAdBody);
  check(
    'P5: empty-imageUrls throw preserved after Promise.all',
    guard,
    'the "no reference images available" money guard was dropped or reworded — check before spending on Omni'
  );
}

// ── P6: no bare `await refreshStaleLayoutInput(` outside the Promise.all in generateForAd ──
// A defense against a partial revert that adds a duplicate awaited call
// (silently doubles work + can produce two DB writes for the same key).
{
  // Match `await refreshStaleLayoutInput(` that is NOT immediately preceded by
  // `Promise.all([` or comma+whitespace inside the array. Simplest form:
  // count total bare `await refreshStaleLayoutInput(` occurrences in
  // generateForAd (should be zero — the one inside Promise.all is a bare
  // call expression, not an `await` expression).
  const bareAwaits = genForAdBody.match(/await\s+refreshStaleLayoutInput\s*\(/g) || [];
  check(
    'P6: zero bare `await refreshStaleLayoutInput(...)` calls in generateForAd (the Promise.all one is not awaited directly)',
    bareAwaits.length === 0,
    `found ${bareAwaits.length} — a duplicate serial await after the parallel block would defeat the trim`
  );
}

// ── Summary ──
if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
