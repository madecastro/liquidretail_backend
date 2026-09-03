// Pure, offline-safe estimation of a title GROUP's rendered stack height, and
// the shrink/drop decision when that estimate exceeds the box its resolved
// anchor affords (remotion/lib/safeZones.js `resolveGroupBoxPx`).
//
// THE DEFECT THIS CLOSES (2026-08-19, follow-up to PR #239). #239 fixed WHICH
// end of an overflowing group drops first (`safe flex-end` on
// stackContainerStyle — the trailing end, never the opening). It did not fix
// that the box can still be smaller than a single whole element, so the
// outer `overflow:hidden` clips THROUGH the middle of that element — measured
// on a delivered Vuori `meta_reels_9_16`: a five-star row sliced at ~30% of
// its height, "4.6/5" cut mid-glyph, "15,586 brand reviews" gone entirely,
// and ~40% of the frame left as dead space below the cut. A half-star reads
// as a crashed renderer, not shorter copy — worse than the bug #239 fixed,
// which at least read as grammatical (if wrong) text.
//
// THE INVARIANT THIS ENCODES: never clip through an element. A group must
// degrade in this priority order (ticket's own ordering, restated as code):
//   1. SHRINK — every kept slot in the group scales down together (bounded,
//      see SHRINK_FLOOR), buying a line or a row without losing anything.
//      Preferred over dropping ANYTHING.
//   2. DROP A SUB-PART — today only the `rating` slot's own trailing reviews
//      line ("15,586 brand reviews"), which is a nice-to-have; the star
//      rating itself is the claim being illustrated.
//   3. DROP WHOLE TRAILING ROWS — working backward from the END of the
//      group, one row at a time, until what remains fits.
//   4. The group's HERO row is never sub-dropped or fully dropped. The hero
//      is the FIRST row that actually has content (heightPx > 0) — not
//      literally rows[0]: canonical.json's `proof` group authors `quote`,
//      then a `headline` restatement gated `visibleWhenEmpty: "quote"`
//      (renders only when quote does not), then `reviewer`/`rating`.
//      Whichever of quote/headline actually rendered is the hero, whatever
//      its array index. If even it alone (at the shrink floor) does not
//      fit, its own per-slot
//      `-webkit-line-clamp` (slotRenderers.jsx `textCoreStyle`) already
//      truncates it the SAFE way — at a whole-line boundary, ellipsis at the
//      end, never through a glyph. That existing guarantee is the last
//      resort; this module does not need to reimplement it, only avoid
//      making things worse by shrinking that row as far as it safely can.
//
// This is deliberately the VERTICAL twin of the model `slotContent.js`
// already uses for the HORIZONTAL axis (`deriveCharCap`: usable width ÷ avg
// glyph width ÷ font size → chars per line, with its own CHAR_CAP_SAFETY
// margin). Kept pure/framework-free, same convention slotContent.js's own
// header comment states, so offline harnesses (scripts/verify*.mjs) can
// drive the exact decision Canonical.jsx makes without a browser.
//
// WHY A SAFETY MARGIN (FIT_SAFETY_MARGIN below): `estimateTextLines` is an
// approximation (average glyph width, not the real font's per-character
// metrics) — the same approximation deriveCharCap already accepts, and for
// the same reason: "being slightly tight costs a shorter pick; being loose
// reopens clamp cuts" (slotContent.js). Treating the box as very slightly
// smaller than it really is biases every decision below toward shrinking or
// dropping a touch more than strictly necessary, in exchange for the
// estimate never being the reason a real render still clips mid-element.

import { AVG_CHAR_WIDTH_EM } from './slotContent.js';

/** Matches slotRenderers.jsx `textCoreStyle`'s fixed lineHeight. */
export const TEXT_LINE_HEIGHT = 1.16;

/**
 * RatingSlot internals (remotion/components/slotRenderers.jsx `RatingSlot`),
 * mirrored here so this module can estimate its height without importing
 * React/Remotion — same maintenance contract slotContent.js's
 * DEFAULT_BASE_FONT_PX already carries ("mirrors ... BASE_SIZE"). If those
 * multipliers change, update here too.
 */
export const RATING_STAR_ROW_SCALE = 1.15; // StarRow size = rating fontPx * 1.15
export const RATING_INTERNAL_GAP_SCALE = 0.28; // gap between star row and reviews line
export const RATING_REVIEWS_FONT_SCALE = 0.82; // reviews line fontSize = rating fontPx * 0.82
export const RATING_REVIEWS_LINE_HEIGHT = 1.2; // reviewsNode has no explicit lineHeight; browser default ~1.2

/**
 * Never shrink a group's type past this fraction of its authored size —
 * "modest", per the product call: legible type beats a few extra px of fit.
 */
export const SHRINK_FLOOR = 0.82;
/** Search step for the scale below. Coarse is fine; it only picks a CSS multiplier. */
const SHRINK_STEP = 0.02;
/**
 * Treat the box as this fraction of its real height when deciding "does it
 * fit" — see the file header's "WHY A SAFETY MARGIN" note. Mirrors
 * CHAR_CAP_SAFETY's role (slotContent.js) on the vertical axis.
 */
export const FIT_SAFETY_MARGIN = 0.96;

/**
 * Estimate how many lines a resolved text string will wrap to, using the
 * SAME average-glyph-width model `deriveCharCap` uses for the horizontal
 * axis (slotContent.js AVG_CHAR_WIDTH_EM). Clamped to [1, maxLines] — a slot
 * that renders at all takes at least one line's worth of height, and never
 * more than its own `-webkit-line-clamp` allows.
 *
 * Missing/invalid layout signal (no usableWidthPx/fontPx) returns the
 * WORST case (maxLines) rather than guessing low — an under-count here is
 * exactly how a group's real height could exceed this module's estimate and
 * clip for real; an over-count only costs a shorter pick or an earlier drop.
 *
 * @param {string} text
 * @param {{ usableWidthPx?: number, fontPx?: number, maxLines?: number }} ctx
 * @returns {number}
 */
export function estimateTextLines(text, { usableWidthPx, fontPx, maxLines = 1 } = {}) {
  const len = String(text ?? '').length;
  const cap = Math.max(1, Math.floor(maxLines) || 1);
  if (len === 0) return 0;
  if (!Number.isFinite(usableWidthPx) || usableWidthPx <= 0
    || !Number.isFinite(fontPx) || fontPx <= 0) {
    return cap;
  }
  const charsPerLine = Math.max(1, Math.floor(usableWidthPx / (AVG_CHAR_WIDTH_EM * fontPx)));
  const lines = Math.ceil(len / charsPerLine);
  return Math.min(cap, Math.max(1, lines));
}

/**
 * Estimate a single slot's rendered height in px from its RESOLVED content
 * and the same layout numbers Canonical.jsx already has on hand (fontPx from
 * `baseSize()`, usableWidthPx from the capCtx it builds for `deriveCharCap`).
 *
 * `rating` is the one composite case: content is `{ rating, reviewsText }`
 * (slotContent.js `resolveSlotContentCore`) and its height is the star row
 * PLUS, when present and `dropReviews` is not set, the reviews line and the
 * internal gap between them (see RATING_* constants above).
 *
 * Image slots (`productImage`/`brandLogo`) are sized by `sizePct` of the
 * canvas's short side (slotRenderers.jsx `renderImage`) — needs `dims`.
 *
 * Multi-value slots (`badges`/`benefits`) are LAYOUT-DEPENDENT. Joining the
 * array into one string at maxLines 1 is honest for itemLayout:'row' (one
 * flex line of chips) and FALSE for 'stack' — the validator default for
 * benefits. A 4-item stack became one line, planGroupFit never shrank, and
 * overflow:hidden clipped through items (the Vuori mid-star defect this
 * module exists to prevent). Layout math lives HERE, not in Canonical.jsx:
 * this file is vendor-synced with adgen; Canonical is not, so a fork that
 * only grows estCtx still gets the right estimate via the slotKey defaults.
 *
 * @returns {number} px, never negative; 0 for empty/unrenderable content.
 */
export function estimateSlotHeightPx(slotKey, content, ctx = {}) {
  if (content == null) return 0;
  const {
    fontPx, usableWidthPx, maxLines, dims, sizePct, dropReviews = false,
    itemLayout, itemStyle, itemGap, maxItems,
  } = ctx;

  if (slotKey === 'rating') {
    if (!Number.isFinite(fontPx) || fontPx <= 0) return 0;
    const rating = content?.rating;
    const reviewsText = content?.reviewsText;
    let h = 0;
    if (rating != null) h = fontPx * RATING_STAR_ROW_SCALE;
    if (reviewsText && !dropReviews) {
      const reviewsLineH = (fontPx * RATING_REVIEWS_FONT_SCALE) * RATING_REVIEWS_LINE_HEIGHT;
      h = h > 0 ? h + fontPx * RATING_INTERNAL_GAP_SCALE + reviewsLineH : reviewsLineH;
    }
    return h;
  }

  if (slotKey === 'productImage' || slotKey === 'brandLogo') {
    if (!dims || !Number.isFinite(dims.width) || !Number.isFinite(dims.height)) return 0;
    const short = Math.min(dims.width, dims.height);
    return short * (Number.isFinite(sizePct) ? sizePct : 0.35);
  }

  if (!Number.isFinite(fontPx) || fontPx <= 0) return 0;

  if (slotKey === 'badges' || slotKey === 'benefits') {
    return estimateMultiSlotHeightPx(content, {
      fontPx, usableWidthPx, maxLines, dims, itemLayout, itemStyle, itemGap, maxItems, slotKey,
    });
  }

  const text = Array.isArray(content) ? content.join(' ') : String(content ?? '');
  const lines = estimateTextLines(text, { usableWidthPx, fontPx, maxLines: maxLines || 1 });
  return lines * fontPx * TEXT_LINE_HEIGHT;
}

/**
 * Height of a badges/benefits slot from its resolved item array.
 *
 *   stack — n rows, each item wraps on its own, plus (n-1) × gap.
 *   row   — historical joined-text model (one flex line). wrap-to-next-line
 *           via flexWrap is possible but the original "keep the box honest"
 *           claim was true for this layout; we do not inflate it.
 *   grid  — slotRenderers.jsx hardcodes 2 columns (`repeat(2, minmax(0,1fr))`),
 *           so row count is ceil(n/2). Each cell wraps at ~half usable width;
 *           a row's height is the taller of its two cells.
 *
 * maxItems (validator default 4) caps n — slotContent.js already slices the
 * resolved array to that cap before paint. n=0 / empty array → 0.
 *
 * When itemLayout is omitted, use the validator default for the slot key
 * (benefits→stack, badges→row) so a Canonical.jsx fork that has not yet
 * grown estCtx still estimates benefits honestly.
 *
 * THE GRID UNDER-ESTIMATE (2026-09-03, adversarial review — reproduced BY
 * EXECUTION: measured up to ~1.9x low with a realistic maxWidthPct + sizeScale
 * combo). The cell-width arithmetic below (usable width minus one inter-
 * column gap, split across 2 columns) was already correct — that part is
 * literally what `slotRenderers.jsx`'s `gridTemplateColumns:
 * repeat(2,minmax(0,1fr))` does. The bug was downstream of it: each item's
 * wrapped-line count was capped at the SLOT's authored `maxLines`
 * (`treatment.maxLines`, titleSpecValidator default 2) — but that cap is a
 * `-webkit-line-clamp` concept, and `-webkit-line-clamp` is applied ONLY by
 * `textCoreStyle` (single-value text slots: headline/quote/reviewer/…).
 * `renderMultiValue` (badges/benefits — slotRenderers.jsx, the `bullet`/
 * `plain`/`pill`/`chip` item spans, ~:790-836) sets no such clamp: a real
 * benefit string wraps to as many lines as it needs, unbounded, in the real
 * DOM. Reusing `maxLines` as the per-item cap here silently discarded any
 * line past the 2nd, which is exactly how a ~29-45 char benefit in a
 * halved-width cell (narrower still once `maxWidthPct`/`sizeScale` shrink the
 * group or grow the type) came out shorter than it really renders.
 * `estimateTextLines`'s own missing-width fallback still returns `maxLines`
 * unchanged — that path is genuinely "no signal, assume the worst
 * single-line-clamp case" and is untouched.
 * Fix: for GRID ONLY, the per-item cap is `maxLines * cols` (`cols` fixed at
 * 2, matching the renderer), not bare `maxLines`. This is not "uncapped" —
 * literal Infinity would let one degenerate item (or an extreme
 * maxWidthPct/sizeScale combo) balloon the estimate arbitrarily, which is
 * safe in direction (over-count only costs an earlier shrink/drop) but not
 * bounded. `cols×` keeps the SAME total "reading budget"
 * (fontPx × maxLines × lineHeight, the author's real intent at full width) at
 * the cell's own aspect: a cell that's ~1/cols as wide may fairly need up to
 * ~cols× as many lines to show the same amount of text. 'stack'/'row' are
 * UNTOUCHED — they are already fixed/pinned (2026-09-03, the join-fallthrough
 * defect), this is additive to 'grid' only, and 'stack' items sit at the
 * FULL usable width so the same defect is far less likely to bind there
 * (not zero-risk, just out of THIS PR's scope).
 *
 * THE BULLET-WIDTH GAP (same review, `itemStyle:'bullet'`). slotRenderers.jsx
 * (`renderMultiValue`, ~:822-825) reserves `size*0.4` for the bullet dot PLUS
 * a `size*0.4` flex gap before the label starts — real horizontal room the
 * estimator was not charging for, so every wrapped line was estimated with
 * ~1 character more space than it actually has. Subtracted from the usable
 * width fed to `estimateTextLines` for BOTH 'stack' and 'grid' (both do
 * per-item width measurement; 'row' joins into one blob and was already
 * documented as a coarser, deliberately-uninflated model — not touched).
 * `itemStyle` is a NEW ctx field this file did not read before; Canonical.jsx
 * (out of this file's scope) does not thread `rawSlot.treatment?.itemStyle`
 * into `estCtx` yet, so on the live render path this is INERT today — it
 * only takes effect for a caller (or this file's own harness) that passes
 * `itemStyle` explicitly. Correct now rather than wrong-and-unexercised.
 */
function estimateMultiSlotHeightPx(content, ctx) {
  const rawItems = Array.isArray(content)
    ? content
    : (content == null ? [] : [content]);
  const items = rawItems.map((x) => String(x ?? '')).filter((s) => s.length > 0);
  if (!items.length) return 0;

  const cap = Number.isInteger(ctx.maxItems) && ctx.maxItems > 0 ? ctx.maxItems : 4;
  const shown = items.slice(0, cap);
  const n = shown.length;
  if (n === 0) return 0;

  const layout = ctx.itemLayout
    || (ctx.slotKey === 'benefits' ? 'stack' : 'row');
  const itemStyle = ctx.itemStyle
    || (ctx.slotKey === 'benefits' ? 'bullet' : 'pill');
  const gapPx = multiItemGapPx(ctx);
  const lineH = ctx.fontPx * TEXT_LINE_HEIGHT;
  const maxLines = Math.max(1, Math.floor(ctx.maxLines) || 1);

  // Dot (size*0.4) + the flex gap before the label (another size*0.4) —
  // matches slotRenderers.jsx's two `Math.round(size * 0.4)` calls exactly
  // (summed as two independently-rounded values, not one rounded sum, so
  // this cannot drift from the renderer by a stray rounding px). Zero for
  // every other itemStyle — pill/chip/plain reserve no such fixed dead space
  // ahead of the label.
  const bulletInsetPx = itemStyle === 'bullet' ? 2 * Math.round(ctx.fontPx * 0.4) : 0;
  const withBulletInset = (w) => (Number.isFinite(w) ? Math.max(1, w - bulletInsetPx) : w);

  if (layout === 'stack') {
    let total = 0;
    for (const item of shown) {
      const lines = estimateTextLines(item, {
        usableWidthPx: withBulletInset(ctx.usableWidthPx),
        fontPx: ctx.fontPx,
        maxLines,
      });
      total += lines * lineH;
    }
    return total + gapPx * Math.max(0, n - 1);
  }

  if (layout === 'grid') {
    const cols = 2;
    const rows = Math.ceil(n / cols);
    const cellWidth = Number.isFinite(ctx.usableWidthPx) && ctx.usableWidthPx > 0
      ? Math.max(1, (ctx.usableWidthPx - gapPx) / cols)
      : ctx.usableWidthPx;
    const cellUsableWidthPx = withBulletInset(cellWidth);
    // See the file-level comment above: a grid cell has no -webkit-line-clamp
    // in the real DOM, so the per-item cap must not be the single-text-slot
    // `maxLines` value — it is `maxLines * cols`, preserving the same total
    // reading budget at the cell's own (narrower) width.
    const gridItemMaxLines = maxLines * cols;
    let total = 0;
    for (let r = 0; r < rows; r++) {
      let rowH = 0;
      for (let c = 0; c < cols; c++) {
        const item = shown[r * cols + c];
        if (item == null) continue;
        const lines = estimateTextLines(item, {
          usableWidthPx: cellUsableWidthPx,
          fontPx: ctx.fontPx,
          maxLines: gridItemMaxLines,
        });
        rowH = Math.max(rowH, lines * lineH);
      }
      total += rowH;
    }
    return total + gapPx * Math.max(0, rows - 1);
  }

  // 'row' and unknown: joined-text, historical model.
  const text = shown.join(' ');
  const lines = estimateTextLines(text, {
    usableWidthPx: ctx.usableWidthPx,
    fontPx: ctx.fontPx,
    maxLines,
  });
  return lines * lineH;
}

function multiItemGapPx(ctx) {
  const frac = Number.isFinite(ctx.itemGap) ? ctx.itemGap : 0.012;
  if (ctx.dims && Number.isFinite(ctx.dims.width) && Number.isFinite(ctx.dims.height)) {
    return Math.round(Math.min(ctx.dims.width, ctx.dims.height) * Math.max(0, frac));
  }
  // No canvas size: treat gap as 0 rather than inventing pixels. Stack
  // still sums per-item text heights, so the under-estimate this module
  // exists to prevent cannot come from a missing gap.
  return 0;
}

/**
 * Decide how a group's rows must degrade to fit `boxHeightPx`, applying the
 * priority order documented at the top of this file: shrink everything
 * together (bounded by SHRINK_FLOOR) → drop the one row's reviews sub-part
 * → drop whole trailing rows, working backward, never touching the hero row
 * (see planGroupFit's own doc below for what "hero" means).
 *
 * Rows are already FOLDED (Canonical.jsx `foldRows`) — a side-by-side row's
 * height is the max of its members (they render next to each other, not
 * stacked), which the caller computes before calling this.
 *
 * Inert (scale 1, nothing dropped) whenever the group already fits at full
 * size — the common case, and byte-identical to pre-existing behaviour.
 *
 * @param {Array<{ id: string, heightPx: number, heightPxNoReviews: number }>} rows
 *   `heightPxNoReviews` only differs from `heightPx` for the row carrying a
 *   rating reviews line; equal to `heightPx` for every other row.
 * @param {number} boxHeightPx
 * @param {number} [rowGapPx] Gap between rows (spec.stack.rowGapPct × height
 *   — the same value Canonical.jsx passes as the container's CSS `gap`).
 * @returns {{ scale: number, dropReviewsRowId: string|null, droppedRowIds: Set<string> }}
 */
export function planGroupFit({ rows, boxHeightPx, rowGapPx = 0 }) {
  const dropped = new Set();
  let reviewsRowId = null;

  if (!Array.isArray(rows) || !rows.length) {
    return { scale: 1, dropReviewsRowId: null, droppedRowIds: dropped };
  }
  const budget = Number.isFinite(boxHeightPx) ? boxHeightPx * FIT_SAFETY_MARGIN : Infinity;

  // A row that renders NOTHING (e.g. canonical.json's `headline` proof
  // fallback, gated `visibleWhenEmpty: "quote"`, sitting next to a present
  // quote) gets no CSS gap either — Canonical.jsx's row map returns `null`
  // for it, so the flex container's `gap` never applies around a phantom
  // sibling. Counting a gap for it anyway (naively, once per array slot)
  // would waste real budget on air and could tip a group into dropping
  // something that would otherwise have fit — measured on the actual
  // shipped Vuori incident (quote + a null claim-fallback + a null reviewer
  // + rating): 3 "gaps" by array-slot count, only 1 by what actually paints.
  const totalAt = (scale) => {
    const kept = rows.filter((r) => !dropped.has(r.id));
    if (!kept.length) return 0;
    const effHeights = kept.map((r) => (r.id === reviewsRowId ? r.heightPxNoReviews : r.heightPx));
    const visibleCount = effHeights.filter((h) => h > 0).length;
    const sum = effHeights.reduce((acc, h) => acc + h * scale, 0);
    return sum + rowGapPx * scale * Math.max(0, visibleCount - 1);
  };
  const fits = (scale) => totalAt(scale) <= budget;

  // Largest scale in [SHRINK_FLOOR, 1] that fits under the CURRENT
  // drop/dropReviews state, or null if even the floor does not fit.
  const bestScale = () => {
    if (fits(1)) return 1;
    for (let s = 1 - SHRINK_STEP; s >= SHRINK_FLOOR - 1e-9; s -= SHRINK_STEP) {
      if (fits(s)) return Math.max(SHRINK_FLOOR, s);
    }
    return null;
  };

  // Step 1: shrink only.
  let scale = bestScale();
  if (scale != null) return { scale, dropReviewsRowId: null, droppedRowIds: dropped };

  // Step 2: drop the reviews sub-part of whichever row carries one (there is
  // at most one — `rating` never repeats in a group).
  const candidate = rows.find((r) => r.heightPxNoReviews < r.heightPx);
  if (candidate) {
    reviewsRowId = candidate.id;
    scale = bestScale();
    if (scale != null) return { scale, dropReviewsRowId: reviewsRowId, droppedRowIds: dropped };
  }

  // Step 3: drop whole trailing rows, working backward, protecting the HERO
  // row — the first row with any actual content, not literally rows[0] (see
  // the file header's point 4: a gated/empty row can legitimately sit ahead
  // of the real hero in array order).
  const heroIdx = Math.max(0, rows.findIndex((r) => r.heightPx > 0));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (i === heroIdx) continue;
    dropped.add(rows[i].id);
    scale = bestScale();
    if (scale != null) {
      return { scale, dropReviewsRowId: reviewsRowId, droppedRowIds: dropped };
    }
  }

  // Nothing left to drop but the hero row, and even it (at the shrink floor)
  // does not fit. Ship it at the floor — its own -webkit-line-clamp is the
  // remaining safe backstop (see file header point 4).
  return { scale: SHRINK_FLOOR, dropReviewsRowId: reviewsRowId, droppedRowIds: dropped };
}
