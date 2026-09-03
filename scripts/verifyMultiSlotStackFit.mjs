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
 *
 * THE GRID + BULLET DEFECTS THIS ALSO PINS (2026-09-03, same-day follow-up)
 * ---------------------------------------------------------------------------
 * M1-M12 above all use single-character items (['a','b','c','d']) so they
 * can never wrap — no per-cell-width or line-cap bug can ever fail them,
 * which is exactly why the grid under-estimate below shipped unnoticed. Two
 * real defects, both in `estimateMultiSlotHeightPx`'s 'grid' branch (or
 * shared code it exercises):
 *
 * (1) GRID LINE CAP. Reproduced BY EXECUTION: a realistic 3-5 item, 20-45
 *     char benefits list (the longest live benefit string measured is ~30
 *     chars) under a real maxWidthPct(0.46)+sizeScale(1.3) combo estimated
 *     ~157.8px pre-fix vs ~302.5px post-fix — ~1.9× low, matching the
 *     adversarial review's finding. Cause: each grid cell's per-item line
 *     count was capped at the slot's authored `maxLines` (2, the
 *     -webkit-line-clamp value titleSpecValidator defaults to) — but
 *     `renderMultiValue` (slotRenderers.jsx, badges/benefits) applies NO
 *     line-clamp to individual items, unlike `textCoreStyle` (single-value
 *     text slots). A cell half the group's width commonly needs MORE lines
 *     than a full-width `maxLines` was ever meant to bound. Fixed: grid's
 *     per-item cap is `maxLines × cols` (cols=2), not bare `maxLines` — see
 *     stackFit.js's own comment on `estimateMultiSlotHeightPx` for the full
 *     reasoning (why not literally uncapped).
 *
 * (2) BULLET INSET. `itemStyle:'bullet'` reserves a dot (size×0.4) plus a
 *     flex gap of the same width before the label (slotRenderers.jsx
 *     `renderMultiValue`, ~:822-825) — real horizontal room the estimator
 *     was not charging for, so every wrapped line was estimated with ~1
 *     character more space than it has. Fixed for both 'stack' and 'grid'
 *     (both measure width per item; 'row' stays the coarser joined-text
 *     model, untouched). Inert on the live Canonical.jsx render path today
 *     (it does not thread `itemStyle` into estCtx — out of this file's
 *     scope) but correct now rather than wrong-and-unexercised.
 *
 * REVERT-PROOF (grid): reverting the grid cap to bare `maxLines` makes M14
 * (realistic grid clears the pre-fix under-estimate by a wide margin) and
 * M15 (matches the independently re-derived formula) go red — confirmed by
 * running this file against the pre-fix `estimateMultiSlotHeightPx` (both
 * fail: grid=157.768) and the fixed one (both pass: grid=302.536).
 *
 * REVERT-PROOF (bullet): reverting the bullet-inset subtraction makes M16
 * (bullet strictly taller than plain) and M17 (benefits' default itemStyle
 * behaves like 'bullet') go red — confirmed the same way (pre-fix:
 * plain===bullet===55.68, since `itemStyle` was not even read; fixed:
 * plain=55.68 < bullet=83.52).
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
  // 4 items → 2 rows, so taller than row, shorter than stack of 4. Kept as a
  // basic sanity check, but single-char items can never wrap, so this alone
  // proves nothing about per-cell-width or line-cap correctness — see the
  // realistic-fixture group below, which is what actually pins the fix.
  const gridH = estimateSlotHeightPx('benefits', ITEMS, { ...stackCtx, itemLayout: 'grid' });
  check(
    "M12 itemLayout:'grid' is between row and 4-row stack (2 columns → 2 rows)",
    gridH > rowH && gridH < fourStack,
    `grid=${gridH} row=${rowH} stack=${fourStack}`
  );
}

// ── N. Realistic multi-slot fixtures — grid under-estimate + bullet inset ──
// M1-M12 above use single-character items, which can never wrap at any
// width, so no cell-width or line-cap bug can ever fail them. Real benefit
// strings are 3-5 items of ~20-45 chars (longest measured live: ~30 chars,
// e.g. "Comfortable for all-day wear", "Your perfect travel sneaker") — long
// enough to wrap for real once a narrow maxWidthPct / raised sizeScale
// shrinks the box or grows the type, which is exactly the combination that
// broke (see file header).
{
  const REAL_ITEMS = [
    'Comfortable for all-day wear',
    'Your perfect travel sneaker',
    'Machine washable and easy care',
    'Free shipping on every order',
  ];
  check(
    'N0 realistic fixture items are all 20-45 chars (would be a fixture bug otherwise)',
    REAL_ITEMS.every((s) => s.length >= 20 && s.length <= 45),
    `lengths=${REAL_ITEMS.map((s) => s.length).join(',')}`
  );

  // maxWidthPct 0.46 × canvasWidth 1080 (Canonical.jsx's own documented
  // panel-column default) and sizeScale 1.3 on the benefits base size (24px
  // vertical, slotRenderers.jsx BASE_SIZE) — a real, unremarkable authoring
  // combo, not a contrived extreme.
  const REAL_FONT = 24 * 1.3; // 31.2 — baseSize('benefits','vertical',1.3)
  const REAL_WIDTH = 0.46 * 1080; // 496.8
  const REAL_MAXLINES = 2; // titleSpecValidator default
  const REAL_GAP = 0.012;
  const realLineH = REAL_FONT * TEXT_LINE_HEIGHT;

  const realGridCtx = {
    fontPx: REAL_FONT, usableWidthPx: REAL_WIDTH, maxLines: REAL_MAXLINES,
    dims: DIMS, itemLayout: 'grid', itemGap: REAL_GAP, maxItems: 4,
  };
  const realGridH = estimateSlotHeightPx('benefits', REAL_ITEMS, realGridCtx);
  const realStackH = estimateSlotHeightPx('benefits', REAL_ITEMS, { ...realGridCtx, itemLayout: 'stack' });
  const realRowH = estimateSlotHeightPx('benefits', REAL_ITEMS, { ...realGridCtx, itemLayout: 'row' });

  check(
    'M13 realistic grid is taller than the joined-text row estimate',
    realGridH > realRowH,
    `grid=${realGridH} row=${realRowH}`
  );
  check(
    'M14 realistic grid is no taller than the full 4-row stack',
    realGridH < realStackH,
    `grid=${realGridH} stack=${realStackH}`
  );

  // THE REGRESSION THIS PR CLOSES. Pre-fix, a grid cell's per-item line
  // count was capped at the slot's authored maxLines (2) — a
  // -webkit-line-clamp concept the real multi-value renderer never applies.
  // At this fixture's cell width every item genuinely needs 3-4 lines;
  // capped at 2 the old code returned ~157.8px (measured against the
  // pre-fix function). The floor below sits comfortably above that and
  // comfortably below the honest ~302.5px value, so reverting either the
  // grid cap (maxLines×cols) or the bullet-inset subtraction trips it.
  check(
    'M15 realistic grid clears the pre-fix under-estimate by a wide margin',
    realGridH >= 7 * realLineH,
    `grid=${realGridH} 7×lineH=${7 * realLineH} (pre-fix measured ~157.8)`
  );

  // Independently re-derive the expected grid height from the SAME exported
  // estimateTextLines (unchanged) plus the documented formula — cell width =
  // (usableWidthPx − one inter-column gap) / 2 cols, minus the bullet inset
  // for benefits' default itemStyle, per-item cap = maxLines × cols — rather
  // than trusting the function under test to grade its own homework.
  const cols = 2;
  const gapPx = Math.round(Math.min(DIMS.width, DIMS.height) * REAL_GAP);
  const cellWidth = Math.max(1, (REAL_WIDTH - gapPx) / cols);
  const bulletInsetPx = 2 * Math.round(REAL_FONT * 0.4); // dot (size×0.4) + gap (size×0.4)
  const cellUsableWidthPx = cellWidth - bulletInsetPx;
  const gridItemMaxLines = REAL_MAXLINES * cols;
  const rows = Math.ceil(REAL_ITEMS.length / cols);
  let expectedGrid = 0;
  for (let r = 0; r < rows; r++) {
    let rowH = 0;
    for (let c = 0; c < cols; c++) {
      const item = REAL_ITEMS[r * cols + c];
      if (item == null) continue;
      const lines = estimateTextLines(item, {
        usableWidthPx: cellUsableWidthPx, fontPx: REAL_FONT, maxLines: gridItemMaxLines,
      });
      rowH = Math.max(rowH, lines * realLineH);
    }
    expectedGrid += rowH;
  }
  expectedGrid += gapPx * Math.max(0, rows - 1);
  check(
    'M16 realistic grid matches the independently re-derived cell-width/cap formula',
    Math.abs(realGridH - expectedGrid) < 1e-6,
    `got ${realGridH} expected ${expectedGrid}`
  );
}

// ── O. Bullet inset (itemStyle:'bullet') isolated from the grid cap change ─
{
  // A single item at a marginal width: with no inset "Comfortable for
  // all-day wear" (29 chars) wraps to 2 lines; the dot + gap (size×0.4
  // twice, slotRenderers.jsx renderMultiValue's bullet branch) removes
  // ~1 char of room per line and pushes it to 3. Uses 'stack' (not 'grid')
  // to isolate the bullet fix from the grid-cap fix above.
  const ITEM = ['Comfortable for all-day wear'];
  const base = {
    fontPx: 24, usableWidthPx: 250, maxLines: 3, dims: DIMS,
    itemLayout: 'stack', itemGap: 0.012, maxItems: 4,
  };
  const plainH = estimateSlotHeightPx('benefits', ITEM, { ...base, itemStyle: 'plain' });
  const bulletH = estimateSlotHeightPx('benefits', ITEM, { ...base, itemStyle: 'bullet' });
  check(
    "M17 itemStyle:'bullet' reserves the dot+gap and needs strictly more height than 'plain'",
    bulletH > plainH,
    `plain=${plainH} bullet=${bulletH}`
  );

  // Same effect via benefits' DEFAULT itemStyle (bullet, titleSpecValidator)
  // — no itemStyle passed at all, matching what a caller that only sets
  // itemLayout gets today.
  const defaultH = estimateSlotHeightPx('benefits', ITEM, base);
  check(
    "M18 benefits' default itemStyle behaves like explicit 'bullet', not 'plain'",
    Math.abs(defaultH - bulletH) < 1e-6 && defaultH > plainH,
    `default=${defaultH} bullet=${bulletH} plain=${plainH}`
  );
}

if (failures.length) {
  console.error(`❌ verifyMultiSlotStackFit: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyMultiSlotStackFit: ${passed}/${passed} checks passed`);
