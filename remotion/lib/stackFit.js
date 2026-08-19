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
 * Multi-value slots (`badges`/`benefits`) are approximated by their own
 * authored `maxLines` at a single row's height; they are not part of the
 * incident this module closes, and the estimate errs toward "keep the box
 * honest" rather than exactness (see file header).
 *
 * @returns {number} px, never negative; 0 for empty/unrenderable content.
 */
export function estimateSlotHeightPx(slotKey, content, ctx = {}) {
  if (content == null) return 0;
  const { fontPx, usableWidthPx, maxLines, dims, sizePct, dropReviews = false } = ctx;

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
  const text = Array.isArray(content) ? content.join(' ') : String(content ?? '');
  const lines = estimateTextLines(text, { usableWidthPx, fontPx, maxLines: maxLines || 1 });
  return lines * fontPx * TEXT_LINE_HEIGHT;
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
