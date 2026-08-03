#!/usr/bin/env node
'use strict';
/**
 * verifyRatingMotion — offline guard for RatingSlot star-pop + reviews count-up.
 *
 * WHY THIS EXISTS
 * Owner 2026-08-05: animate the rating lockup (stars populate L→R with a spring
 * pop; reviewsText leading number rolls 0→N; suffix fades in). All motion must
 * be Remotion-deterministic (useCurrentFrame / spring — no Date/random/timeout).
 * A browserless behavioural test of the JSX is not practical, so:
 *   (1) source pins that RatingSlot still wires frame-derived motion + tabular-nums
 *   (2) pure-function checks on remotion/lib/ratingMotion.js (count-up endpoints,
 *       monotonicity, star fill targets, schedule ≤ ~1.6s settle)
 *
 * No DB, no network, no API key, no browser. Safe in CI.
 *
 *   node scripts/verifyRatingMotion.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const ROOT = path.join(__dirname, '..');
const SLOT_SRC = fs.readFileSync(
  path.join(ROOT, 'remotion/components/slotRenderers.jsx'),
  'utf8'
);
const MOTION_SRC = fs.readFileSync(
  path.join(ROOT, 'remotion/lib/ratingMotion.js'),
  'utf8'
);

const {
  STAR_COUNT,
  STAR_STAGGER_SEC,
  STAR_POP_SEC,
  COUNT_DUR_SEC,
  SUFFIX_FADE_SEC,
  easeOutCubic,
  ratingLocalFrame,
  starStartSec,
  starTargetFill,
  starFillAt,
  lastStarLandSec,
  parseReviewsLeadingNumber,
  countUpValue,
  formatReviewsCount,
  suffixOpacityAt,
  lineFadeOpacityAt,
} = require('../remotion/lib/ratingMotion.js');

console.log('\nverifyRatingMotion — RatingSlot star pop + count-up\n');

// ── A. Source pins (RatingSlot / StarRow) ──────────────────────────────────
check('A1 RatingSlot imports useCurrentFrame from remotion', () => {
  assert.match(SLOT_SRC, /useCurrentFrame/);
  assert.match(SLOT_SRC, /from ['"]remotion['"]/);
});

check('A2 RatingSlot imports spring from remotion', () => {
  assert.match(SLOT_SRC, /\bspring\b/);
  // Fail if spring is only a comment / dead import elsewhere: must appear in
  // the StarRow animation path as a call.
  assert.match(SLOT_SRC, /spring\s*\(\s*\{/);
});

check('A3 RatingSlot calls useCurrentFrame() (not only props.frame)', () => {
  // FAIL-IF-REVERTED: prop-only motion breaks standalone compositions.
  assert.match(SLOT_SRC, /useCurrentFrame\s*\(\s*\)/);
  assert.match(SLOT_SRC, /useVideoConfig\s*\(\s*\)/);
});

check('A4 reviews count line applies tabular-nums', () => {
  assert.match(SLOT_SRC, /fontVariantNumeric:\s*['"]tabular-nums['"]/);
});

check('A5 partial star fill uses clipPath + left-anchored rect (not a font glyph)', () => {
  assert.match(SLOT_SRC, /clipPath/);
  assert.match(SLOT_SRC, /rating-star-fill-/);
  // width={size * fill} is the partial-fill mechanism (efc281c stars are SVG polygons).
  assert.match(SLOT_SRC, /width=\{size \* fill\}/);
});

check('A6 RatingSlot still column-locks stars above reviewsText (iteration-3)', () => {
  // flexDirection column on the lockup wrapper inside RatingSlot.
  const ratingBlock = SLOT_SRC.slice(SLOT_SRC.indexOf('export const RatingSlot'));
  assert.match(ratingBlock, /flexDirection:\s*['"]column['"]/);
  assert.match(ratingBlock, /StarRow/);
});

check('A7 no Date/random/setTimeout calls in rating motion helpers or RatingSlot block', () => {
  // Strip // comments so a "never Date/random/setTimeout" note doesn't false-fail.
  const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '');
  const ratingBlock = stripComments(SLOT_SRC.slice(
    SLOT_SRC.indexOf('export const RatingSlot'),
    SLOT_SRC.indexOf('export const', SLOT_SRC.indexOf('export const RatingSlot') + 1)
  ));
  const motion = stripComments(MOTION_SRC);
  assert.doesNotMatch(ratingBlock, /\bDate\.(now|parse|UTC)\b/);
  assert.doesNotMatch(ratingBlock, /\bnew Date\b/);
  assert.doesNotMatch(ratingBlock, /\bMath\.random\s*\(/);
  assert.doesNotMatch(ratingBlock, /\bsetTimeout\s*\(/);
  assert.doesNotMatch(motion, /\bDate\.(now|parse|UTC)\b/);
  assert.doesNotMatch(motion, /\bnew Date\b/);
  assert.doesNotMatch(motion, /\bMath\.random\s*\(/);
  assert.doesNotMatch(motion, /\bsetTimeout\s*\(/);
});

// ── B. parseReviewsLeadingNumber ───────────────────────────────────────────
check('B1 parses "15,545 reviews · domain"', () => {
  const p = parseReviewsLeadingNumber('15,545 reviews · vuoriclothing.com');
  assert.ok(p);
  assert.strictEqual(p.target, 15545);
  assert.strictEqual(p.suffix, ' reviews · vuoriclothing.com');
});

check('B2 parses bare "128 reviews"', () => {
  const p = parseReviewsLeadingNumber('128 reviews');
  assert.ok(p);
  assert.strictEqual(p.target, 128);
  assert.strictEqual(p.suffix, ' reviews');
});

check('B3 no leading integer → null (fade path)', () => {
  assert.strictEqual(parseReviewsLeadingNumber('Trusted by thousands'), null);
  assert.strictEqual(parseReviewsLeadingNumber(''), null);
  assert.strictEqual(parseReviewsLeadingNumber(null), null);
});

// ── C. countUpValue endpoints + monotonic ──────────────────────────────────
const FPS = 30;
const COUNT_START = lastStarLandSec(); // schedule used by RatingSlot

check('C1 count is 0 at/before start', () => {
  const startF = Math.round(COUNT_START * FPS);
  assert.strictEqual(countUpValue(startF, FPS, 15545, { startSec: COUNT_START }), 0);
  assert.strictEqual(countUpValue(startF - 5, FPS, 15545, { startSec: COUNT_START }), 0);
  assert.strictEqual(countUpValue(-10, FPS, 100, { startSec: COUNT_START }), 0);
});

check('C2 count is target at settle', () => {
  const settleF = Math.round((COUNT_START + COUNT_DUR_SEC) * FPS);
  assert.strictEqual(
    countUpValue(settleF, FPS, 15545, { startSec: COUNT_START, durationSec: COUNT_DUR_SEC }),
    15545
  );
  assert.strictEqual(
    countUpValue(settleF + 50, FPS, 15545, { startSec: COUNT_START, durationSec: COUNT_DUR_SEC }),
    15545
  );
});

check('C3 count-up is monotonic non-decreasing across the window', () => {
  const startF = Math.round(COUNT_START * FPS);
  const endF = Math.round((COUNT_START + COUNT_DUR_SEC) * FPS);
  let prev = -1;
  for (let f = startF; f <= endF; f++) {
    const v = countUpValue(f, FPS, 1000, { startSec: COUNT_START, durationSec: COUNT_DUR_SEC });
    assert.ok(v >= prev, `frame ${f}: ${v} < prev ${prev}`);
    prev = v;
  }
  assert.strictEqual(prev, 1000);
});

check('C4 count-up mid-window is strictly between 0 and target', () => {
  const midF = Math.round((COUNT_START + COUNT_DUR_SEC * 0.5) * FPS);
  const v = countUpValue(midF, FPS, 1000, { startSec: COUNT_START, durationSec: COUNT_DUR_SEC });
  assert.ok(v > 0 && v < 1000, `mid=${v}`);
});

check('C5 formatReviewsCount reapplies locale commas', () => {
  assert.strictEqual(formatReviewsCount(15545), '15,545');
  assert.strictEqual(formatReviewsCount(0), '0');
  assert.strictEqual(formatReviewsCount(999), '999');
});

check('C6 countUpValue works at low fps (derive from fps, no hardcoded frames)', () => {
  const fps = 8;
  const startF = Math.round(COUNT_START * fps);
  const endF = Math.round((COUNT_START + COUNT_DUR_SEC) * fps);
  assert.strictEqual(countUpValue(startF, fps, 50, { startSec: COUNT_START }), 0);
  assert.strictEqual(countUpValue(endF, fps, 50, { startSec: COUNT_START }), 50);
});

// ── D. star fill targets + ramp ────────────────────────────────────────────
check('D1 starTargetFill for 4.6', () => {
  const fills = [0, 1, 2, 3, 4].map((i) => starTargetFill(4.6, i));
  assert.deepStrictEqual(fills.slice(0, 4), [1, 1, 1, 1]);
  assert.ok(Math.abs(fills[4] - 0.6) < 1e-9, `partial fill=${fills[4]}`);
});

check('D2 starTargetFill for 3 and 5', () => {
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4].map((i) => starTargetFill(3, i)),
    [1, 1, 1, 0, 0]
  );
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4].map((i) => starTargetFill(5, i)),
    [1, 1, 1, 1, 1]
  );
});

check('D3 starFillAt is 0 before star start, target after pop window', () => {
  const i = 2;
  const startF = Math.round(starStartSec(i) * FPS);
  const endF = startF + Math.round(STAR_POP_SEC * FPS);
  assert.strictEqual(starFillAt(startF, FPS, 4.6, i), 0);
  assert.strictEqual(starFillAt(startF - 1, FPS, 4.6, i), 0);
  assert.strictEqual(starFillAt(endF, FPS, 4.6, i), 1);
  // partial star (index 4, rating 4.6)
  const pStart = Math.round(starStartSec(4) * FPS);
  const pEnd = pStart + Math.round(STAR_POP_SEC * FPS);
  assert.ok(Math.abs(starFillAt(pEnd, FPS, 4.6, 4) - 0.6) < 1e-9);
  assert.ok(starFillAt(pStart + Math.round(STAR_POP_SEC * 0.5 * FPS), FPS, 4.6, 4) < 0.6 - 1e-9);
});

check('D4 star stagger is STAR_STAGGER_SEC (~90ms)', () => {
  assert.strictEqual(STAR_STAGGER_SEC, 0.09);
  assert.strictEqual(starStartSec(0), 0);
  assert.strictEqual(starStartSec(4), 0.36);
});

// ── E. schedule settles ≤ ~1.6s; suffix fade ────────────────────────────────
check('E1 total settle (last star land + count) ≤ 1.6s', () => {
  const settle = lastStarLandSec() + COUNT_DUR_SEC;
  assert.ok(settle <= 1.6, `settle=${settle}s > 1.6s`);
  // And not accidentally instant.
  assert.ok(settle >= 1.2, `settle=${settle}s unexpectedly short`);
});

check('E2 lastStarLandSec matches stagger*(n-1)+pop', () => {
  assert.strictEqual(
    lastStarLandSec(),
    (STAR_COUNT - 1) * STAR_STAGGER_SEC + STAR_POP_SEC
  );
});

check('E3 suffix opacity 0 early, 1 at count end', () => {
  const opts = {
    startSec: COUNT_START,
    durationSec: COUNT_DUR_SEC,
    fadeSec: SUFFIX_FADE_SEC,
  };
  assert.strictEqual(suffixOpacityAt(0, FPS, opts), 0);
  const midCount = Math.round((COUNT_START + COUNT_DUR_SEC * 0.4) * FPS);
  assert.strictEqual(suffixOpacityAt(midCount, FPS, opts), 0);
  const endF = Math.round((COUNT_START + COUNT_DUR_SEC) * FPS);
  assert.strictEqual(suffixOpacityAt(endF, FPS, opts), 1);
});

check('E4 lineFadeOpacityAt 0→1 for no-integer path', () => {
  assert.strictEqual(lineFadeOpacityAt(0, FPS, { startSec: COUNT_START }), 0);
  const endF = Math.round((COUNT_START + SUFFIX_FADE_SEC) * FPS);
  assert.strictEqual(lineFadeOpacityAt(endF, FPS, { startSec: COUNT_START }), 1);
});

check('E5 ratingLocalFrame is negative before enter, 0 at enter', () => {
  // enterAtSec=1, timeScale=1, fps=30 → enter frame 30
  assert.strictEqual(ratingLocalFrame(30, 30, 1, 1), 0);
  assert.strictEqual(ratingLocalFrame(20, 30, 1, 1), -10);
  assert.strictEqual(ratingLocalFrame(45, 30, 1, 0.5), 30); // enter at 15
});

check('E6 easeOutCubic endpoints', () => {
  assert.strictEqual(easeOutCubic(0), 0);
  assert.strictEqual(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.5); // ease-out is front-loaded
});

// ── report ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`❌ verifyRatingMotion: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyRatingMotion: ${pass}/${pass} checks passed`);
