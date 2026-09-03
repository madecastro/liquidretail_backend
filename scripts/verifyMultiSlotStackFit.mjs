#!/usr/bin/env node
/**
 * verifyMultiSlotStackFit.mjs — estimateSlotHeightPx must not under-count a
 * stacked multi slot (`benefits` / `badges`). Offline: no DB, no network,
 * no Remotion/Chromium. ESM because remotion/lib/stackFit.js is "type":"module".
 *
 * THE DEFECT THIS PINS (2026-09-03)
 * ---------------------------------
 * `estimateSlotHeightPx` used to fall through to:
 *     const text = Array.isArray(content) ? content.join(' ') : String(content ?? '');
 *     const lines = estimateTextLines(text, { … maxLines: maxLines || 1 });
 *     return lines * fontPx * TEXT_LINE_HEIGHT;
 * so a 4-item benefits array became ONE joined string at maxLines 1. The
 * file header claimed this "errs toward keeping the box honest" — TRUE for
 * itemLayout:'row' (one flex line of chips) and FALSE for 'stack', which is
 * the validator default for benefits (titleSpecValidator.js). The under-
 * estimate meant planGroupFit never shrank or dropped, and overflow:hidden
 * clipped THROUGH items — the exact Vuori mid-star defect stackFit exists
 * to prevent, now on a benefits list.
 *
 * WHY ITS OWN FILE, not a group in verifyReelsOverflowSafety.mjs: that
 * harness pins the 2026-08-19 rating/overflow incident (which end drops,
 * group-box ceilings). This is the first check that would catch a benefits
 * slot rendering badly; mixing the two defect classes would let a revert of
 * one hide inside a green run of the other.
 *
 * REVERT-PROOF: restoring the join-into-one-string fallthrough makes M1
 * (4 stacked items >= ~3× a single-line height) go red. Confirmed by
 * running this file against the pre-fix function (fails) and the fixed
 * function (passes).
 */

import {
  estimateTextLines,
  estimateSlotHeightPx,
  planGroupFit,
  TEXT_LINE_HEIGHT,
} from '../remotion/lib/stackFit.js';

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('verifyMultiSlotStackFit\n');

const FONT = 40;
const WIDTH = 800;
const DIMS = { width: 1080, height: 1920 };
const GAP = 0.012;
const ITEMS = ['a', 'b', 'c', 'd'];
const oneLine = FONT * TEXT_LINE_HEIGHT;

const stackCtx = {
  fontPx: FONT,
  usableWidthPx: WIDTH,
  maxLines: 1,
  dims: DIMS,
  itemLayout: 'stack',
  itemGap: GAP,
  maxItems: 4,
};

const rowCtx = { ...stackCtx, itemLayout: 'row' };

// ── M. Multi-slot height ────────────────────────────────────────────────────
{
  const fourStack = estimateSlotHeightPx('benefits', ITEMS, stackCtx);

  // FAIL-IF-JOIN-FALLTHROUGH: today's (pre-fix) code returns oneLine (~46px)
  // for four stacked items. A honest stack is n rows + (n-1) gaps, so a
  // 4-item stack is at least 3× a single line even before counting gap px.
  check(
    'M1 4-item benefits stack is >= ~3× a single-line height',
    fourStack >= 3 * oneLine,
    `got ${fourStack}, oneLine=${oneLine}, 3×=${3 * oneLine}`
  );

  check(
    'M2 4-item benefits stack is strictly taller than the joined-text (row) estimate',
    fourStack > estimateSlotHeightPx('benefits', ITEMS, rowCtx),
    `stack=${fourStack} row=${estimateSlotHeightPx('benefits', ITEMS, rowCtx)}`
  );

  check('M3 empty array → 0', estimateSlotHeightPx('benefits', [], stackCtx) === 0);
  check('M4 null content → 0', estimateSlotHeightPx('benefits', null, stackCtx) === 0);

  const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const capped = estimateSlotHeightPx('benefits', eight, stackCtx);
  check(
    'M5 maxItems caps the row count (8 items at maxItems 4 == 4 items)',
    Math.abs(capped - fourStack) < 1e-6,
    `capped=${capped} four=${fourStack}`
  );

  const uncapped = estimateSlotHeightPx('benefits', eight, { ...stackCtx, maxItems: 8 });
  check(
    'M6 raising maxItems to 8 makes an 8-item stack taller than 4',
    uncapped > fourStack,
    `uncapped=${uncapped} four=${fourStack}`
  );

  // 'row' must stay on the historical joined-text model — that layout is
  // one flex line, and the original header comment was true for it.
  const joined = ITEMS.join(' ');
  const joinedLines = estimateTextLines(joined, { usableWidthPx: WIDTH, fontPx: FONT, maxLines: 1 });
  const joinedH = joinedLines * FONT * TEXT_LINE_HEIGHT;
  const rowH = estimateSlotHeightPx('benefits', ITEMS, rowCtx);
  check(
    "M7 itemLayout:'row' matches today's joined-text estimate",
    Math.abs(rowH - joinedH) < 1e-6,
    `row=${rowH} joined=${joinedH}`
  );

  // badges with no itemLayout should follow the validator default ('row'),
  // benefits with no itemLayout should follow the validator default ('stack')
  // — so a Canonical.jsx fork that forgets to grow estCtx still estimates
  // benefits honestly. This file is vendor-synced; Canonical is not.
  const benefitsDefault = estimateSlotHeightPx('benefits', ITEMS, {
    fontPx: FONT, usableWidthPx: WIDTH, maxLines: 1, dims: DIMS, itemGap: GAP, maxItems: 4,
  });
  check(
    "M8 omitted itemLayout on 'benefits' defaults to stack (validator default)",
    Math.abs(benefitsDefault - fourStack) < 1e-6,
    `got ${benefitsDefault} expected stack ${fourStack}`
  );
  const badgesDefault = estimateSlotHeightPx('badges', ITEMS, {
    fontPx: FONT, usableWidthPx: WIDTH, maxLines: 1, dims: DIMS, itemGap: GAP, maxItems: 4,
  });
  check(
    "M9 omitted itemLayout on 'badges' defaults to row (validator default)",
    Math.abs(badgesDefault - joinedH) < 1e-6,
    `got ${badgesDefault} expected row ${joinedH}`
  );

  // Why the under-estimate was load-bearing: a 1.5-line box "fits" a
  // joined-text row at scale 1, so planGroupFit never shrinks and
  // overflow:hidden clips through the real 4-row stack.
  const tightBox = 1.5 * oneLine;
  const planHonest = planGroupFit({
    rows: [{ id: 'r0', heightPx: fourStack, heightPxNoReviews: fourStack }],
    boxHeightPx: tightBox,
  });
  check(
    'M10 honest 4-item stack does not fit a 1.5-line box at full size (scale < 1)',
    planHonest.scale < 1,
    `scale=${planHonest.scale}`
  );
  const planUnder = planGroupFit({
    rows: [{ id: 'r0', heightPx: joinedH, heightPxNoReviews: joinedH }],
    boxHeightPx: tightBox,
  });
  check(
    'M11 joined-text under-estimate WOULD fit that same box at scale 1 (the clip hole)',
    planUnder.scale === 1,
    `scale=${planUnder.scale}`
  );

  // grid: 2 columns (slotRenderers.jsx hardcodes repeat(2, minmax(0,1fr))).
  // 4 items → 2 rows, so taller than row, shorter than stack of 4.
  const gridH = estimateSlotHeightPx('benefits', ITEMS, { ...stackCtx, itemLayout: 'grid' });
  check(
    "M12 itemLayout:'grid' is between row and 4-row stack (2 columns → 2 rows)",
    gridH > rowH && gridH < fourStack,
    `grid=${gridH} row=${rowH} stack=${fourStack}`
  );
}

if (failures.length) {
  console.error(`❌ verifyMultiSlotStackFit: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyMultiSlotStackFit: ${passed}/${passed} checks passed`);
