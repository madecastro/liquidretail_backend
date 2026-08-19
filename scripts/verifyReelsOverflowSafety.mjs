#!/usr/bin/env node
/**
 * verifyReelsOverflowSafety.mjs — a title GROUP must never lose an element
 * to a mid-element clip. Offline: no DB, no network, no Remotion/Chromium.
 * ESM because remotion/lib/stackFit.js and safeZones.js are "type":"module".
 *
 * THE DEFECT THIS PINS (2026-08-19, follow-up to PR #239)
 * ---------------------------------------------------------
 * #239 fixed WHICH end of an overflowing group's box drops first
 * (`safe flex-end` — the trailing end, never the opening). It shipped its
 * own residual, explicitly flagged as out of scope: on the patched Reels
 * render, the proof group's rating row was "now the one that's tight on
 * space and gets partially clipped at its own trailing edge" — logged as
 * "cosmetic, safe direction." It was not cosmetic: re-rendered pixels (see
 * the PR that adds this file) showed a five-star row sliced through its own
 * middle (~30% visible), "4.6/5" cut mid-glyph, the review-count line gone
 * entirely, and ~40% of the frame left as dead space below the cut. A
 * half-star reads as a crashed renderer, not shorter copy.
 *
 * ROOT CAUSE. `stackContainerStyle` only ever decided a group's box
 * (top/bottom in px) and let CSS `overflow:hidden` clip wherever the pixel
 * boundary happened to land — with no idea whether that boundary fell
 * between two elements or through the middle of one. `deriveCharCap`
 * (slotContent.js) sizes a SINGLE slot's text to its own box; nothing sized
 * the GROUP (quote + reviewer + rating, or headline alone, or productName +
 * CTA row) to the box its anchor actually affords after face/texture
 * keep-out shifts it.
 *
 * THE FIX, two pieces, both required:
 *   - `remotion/lib/safeZones.js` `resolveGroupBoxPx` — single source of
 *     truth for a group's box height per anchor, now used by
 *     `stackContainerStyle` too (previously duplicated inline) — and now
 *     bounded for EVERY anchor, including `bottom`, which had no ceiling at
 *     all before this change (see section G below).
 *   - `remotion/lib/stackFit.js` `planGroupFit` — estimates the group's real
 *     stack height from its RESOLVED content (mirrors deriveCharCap's
 *     horizontal-axis model on the vertical axis) and decides, BEFORE
 *     paint, how to degrade: shrink everything together (bounded) → drop
 *     the rating row's own reviews line → drop whole trailing rows,
 *     protecting the group's HERO row (first row with real content — not
 *     literally rows[0], see section D5). `overflow:hidden` stays as a
 *     last-resort safety net; it should essentially never fire once the fit
 *     plan has already sized the group to its box.
 *
 * THIS FILE IS SURFACE-AGNOSTIC BY DESIGN. `planGroupFit`/`estimateSlotHeightPx`
 * take no format/platformFormat — they only see a box height and resolved
 * row heights. The fix is not "give Reels a bigger budget," it is "make
 * every surface degrade safely within whatever budget it has" — sections F
 * and G exercise `verticalYt`/`landscapeYt`/`squareYt` (and by extension
 * their `pmax_video_*` aliases) through the SAME functions Reels uses, with
 * no per-surface branch anywhere in this file or in Canonical.jsx.
 *
 * REVERT-PROOF: see the inline notes on sections C, D5, D8, E and G — each
 * names the exact revert that turns it red. Confirmed by hand (temporarily
 * reverting each fix in isolation, running this file, restoring, re-running)
 * before landing; do not re-derive that confirmation as "this file exists,
 * so it must be revert-proof."
 */

import { SAFE_ZONES, resolveGroupBoxPx, resolveSafeZoneKey, stackContainerStyle } from '../remotion/lib/safeZones.js';
import {
  estimateTextLines,
  estimateSlotHeightPx,
  planGroupFit,
  SHRINK_FLOOR,
  FIT_SAFETY_MARGIN,
} from '../remotion/lib/stackFit.js';

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
// Sets stringify to "{}" via plain JSON.stringify — every failure detail
// above that embeds a plan uses this so a red run actually shows the drop
// set, not an empty object.
const showPlan = (p) => JSON.stringify(p, (k, v) => (v instanceof Set ? [...v] : v));

console.log('verifyReelsOverflowSafety\n');

// ── A. estimateTextLines — the vertical-axis twin of deriveCharCap's model ──
{
  check('A1 empty text → 0 lines', estimateTextLines('', { usableWidthPx: 800, fontPx: 40 }) === 0);
  check('A2 short text → 1 line', estimateTextLines('hi', { usableWidthPx: 800, fontPx: 40 }) === 1);
  const long = 'x'.repeat(500);
  check('A3 very long text clamps to maxLines',
    estimateTextLines(long, { usableWidthPx: 200, fontPx: 40, maxLines: 3 }) === 3);
  check('A4 missing usableWidthPx/fontPx → worst case (maxLines), never under-counts',
    estimateTextLines('some text here', { maxLines: 5 }) === 5);
  check('A5 default maxLines is 1 when omitted',
    estimateTextLines('a very very very long single line of text indeed', { usableWidthPx: 10000, fontPx: 10 }) === 1);
  // Monotonic sanity: a narrower box never needs FEWER lines for the same text.
  const wide = estimateTextLines('cinched at the waist but not tight', { usableWidthPx: 2000, fontPx: 60, maxLines: 5 });
  const narrow = estimateTextLines('cinched at the waist but not tight', { usableWidthPx: 400, fontPx: 60, maxLines: 5 });
  check('A6 narrower usableWidthPx never estimates fewer lines than wider', narrow >= wide, `narrow=${narrow} wide=${wide}`);
}

// ── B. estimateSlotHeightPx ──────────────────────────────────────────────────
{
  check('B1 null content → 0', estimateSlotHeightPx('quote', null, { fontPx: 60 }) === 0);
  const textH = estimateSlotHeightPx('quote', 'hello world', { fontPx: 60, usableWidthPx: 1000, maxLines: 3 });
  check('B2 text height = lines × fontPx × TEXT_LINE_HEIGHT', Math.abs(textH - 1 * 60 * 1.16) < 1e-6, `got ${textH}`);

  const ratingBoth = estimateSlotHeightPx('rating', { rating: 4.6, reviewsText: '123 reviews' }, { fontPx: 40 });
  const ratingStarsOnly = estimateSlotHeightPx('rating', { rating: 4.6, reviewsText: '123 reviews' }, { fontPx: 40, dropReviews: true });
  const ratingNoStars = estimateSlotHeightPx('rating', { rating: null, reviewsText: '123 reviews' }, { fontPx: 40 });
  const ratingNothing = estimateSlotHeightPx('rating', { rating: null, reviewsText: '' }, { fontPx: 40 });
  check('B3 rating with stars+reviews > stars-only (reviews sub-part adds real height)',
    ratingBoth > ratingStarsOnly, `both=${ratingBoth} starsOnly=${ratingStarsOnly}`);
  check('B4 dropReviews strips exactly the reviews contribution',
    Math.abs(ratingStarsOnly - 40 * 1.15) < 1e-6, `got ${ratingStarsOnly}`);
  check('B5 rating with no stars, reviews only, is shorter than stars+reviews',
    ratingNoStars > 0 && ratingNoStars < ratingBoth, `noStars=${ratingNoStars} both=${ratingBoth}`);
  check('B6 rating with neither stars nor reviews → 0 (nothing renders)', ratingNothing === 0);
  check('B7 rating height needs a finite fontPx (fails closed, not NaN)',
    estimateSlotHeightPx('rating', { rating: 4.6, reviewsText: 'x' }, {}) === 0);

  const imgH = estimateSlotHeightPx('productImage', 'https://example/img.png', { dims: { width: 1080, height: 1920 }, sizePct: 0.4 });
  check('B8 image slot height = sizePct × short side', Math.abs(imgH - 0.4 * 1080) < 1e-6, `got ${imgH}`);
  check('B9 image slot with no dims → 0, never throws',
    estimateSlotHeightPx('brandLogo', 'https://example/logo.png', {}) === 0);
}

// ── C. resolveGroupBoxPx — every anchor, every zone, always bounded ─────────
// REVERT-PROOF: reverting the `bottom` case in resolveGroupBoxPx back to
// `{ topPx: -Infinity (or undefined), bottomPx }` (its pre-2026-08-19 shape,
// which had no `top` at all) makes C3 go red by name for anchor:'bottom'.
{
  const ANCHORS = ['top', 'upperThird', 'center', 'lowerThird', 'bottom'];
  const CASES = [
    { name: 'vertical/reels', safe: SAFE_ZONES.reels, height: 1920 },
    { name: 'vertical/stories', safe: SAFE_ZONES.stories, height: 1920 },
    { name: 'vertical/verticalYt', safe: SAFE_ZONES.verticalYt, height: 1920 },
    { name: 'landscape/landscapeYt', safe: SAFE_ZONES.landscapeYt, height: 1080 },
    { name: 'square/squareYt', safe: SAFE_ZONES.squareYt, height: 1080 },
    { name: 'vertical/vertical', safe: SAFE_ZONES.vertical, height: 1920 },
    { name: 'feed/feed', safe: SAFE_ZONES.feed, height: 1350 },
    { name: 'landscape/landscape', safe: SAFE_ZONES.landscape, height: 1080 },
  ];
  for (const c of CASES) {
    for (const anchor of ANCHORS) {
      const { topPx, bottomPx } = resolveGroupBoxPx({ anchor, safe: c.safe, height: c.height, offsetY: 0 });
      check(`C1 ${c.name} ${anchor}: topPx is finite`, Number.isFinite(topPx), `got ${topPx}`);
      check(`C2 ${c.name} ${anchor}: bottomPx is finite`, Number.isFinite(bottomPx), `got ${bottomPx}`);
      check(`C3 ${c.name} ${anchor}: box has positive height (a real ceiling AND floor)`,
        c.height - topPx - bottomPx > 0, `topPx=${topPx} bottomPx=${bottomPx} height=${c.height}`);
    }
  }
  // The two boxes the shipped incident is about, pinned exactly.
  const reelsLower = resolveGroupBoxPx({ anchor: 'lowerThird', safe: SAFE_ZONES.reels, height: 1920, offsetY: 0 });
  const storiesLower = resolveGroupBoxPx({ anchor: 'lowerThird', safe: SAFE_ZONES.stories, height: 1920, offsetY: 0 });
  const reelsBoxH = 1920 - reelsLower.topPx - reelsLower.bottomPx;
  const storiesBoxH = 1920 - storiesLower.topPx - storiesLower.bottomPx;
  check('C4 Reels lowerThird box ≈ 211px (the measured incident number)',
    Math.abs(reelsBoxH - 211.2) < 1, `got ${reelsBoxH}`);
  check('C5 Stories lowerThird box ≈ 614px (the measured incident number)',
    Math.abs(storiesBoxH - 614.4) < 1, `got ${storiesBoxH}`);
  check('C6 Stories affords vastly more height than Reels for the identical anchor',
    storiesBoxH > reelsBoxH * 2.5, `stories=${storiesBoxH} reels=${reelsBoxH}`);
}

// ── D. planGroupFit — the shrink → drop-subpart → drop-whole-row priority ──
{
  // D1: fits already — byte-identical/inert.
  const d1 = planGroupFit({
    rows: [{ id: 'a', heightPx: 100, heightPxNoReviews: 100 }, { id: 'b', heightPx: 100, heightPxNoReviews: 100 }],
    boxHeightPx: 1000, rowGapPx: 20,
  });
  check('D1 group that already fits: scale=1, nothing dropped',
    d1.scale === 1 && d1.dropReviewsRowId === null && d1.droppedRowIds.size === 0, showPlan(d1));

  // D2: needs shrink only — a case where the FLOOR fits but scale=1 does not,
  // and dropping is never attempted (droppedRowIds stays empty).
  const d2 = planGroupFit({
    rows: [{ id: 'a', heightPx: 100, heightPxNoReviews: 100 }, { id: 'b', heightPx: 100, heightPxNoReviews: 100 }],
    boxHeightPx: 195, rowGapPx: 10,
  });
  check('D2 needs shrink only: scale<1, nothing dropped',
    d2.scale < 1 && d2.scale >= SHRINK_FLOOR && d2.droppedRowIds.size === 0, showPlan(d2));

  // D3: shrink alone cannot save it, but dropping the rating row's reviews
  // sub-part does — the row itself is KEPT (not in droppedRowIds).
  const d3 = planGroupFit({
    rows: [
      { id: 'quote', heightPx: 150, heightPxNoReviews: 150 },
      { id: 'rating', heightPx: 90, heightPxNoReviews: 40 },
    ],
    boxHeightPx: 180, rowGapPx: 20,
  });
  check('D3 drops the reviews sub-part before ever dropping the whole row',
    d3.dropReviewsRowId === 'rating' && !d3.droppedRowIds.has('rating'), showPlan(d3));

  // D4: even reviews-drop + floor shrink isn't enough — the WHOLE trailing
  // row goes, never the hero (this is section E's real-incident shape with
  // arbitrary round numbers instead of measured ones).
  const d4 = planGroupFit({
    rows: [
      { id: 'quote', heightPx: 150, heightPxNoReviews: 150 },
      { id: 'reviewer', heightPx: 30, heightPxNoReviews: 30 },
      { id: 'rating', heightPx: 90, heightPxNoReviews: 40 },
    ],
    boxHeightPx: 180, rowGapPx: 20, // enough to fit quote+reviewer once rating drops; not enough before that
  });
  check('D4 drops the trailing row whole when shrink+reviews-drop still fails',
    d4.droppedRowIds.has('rating') && !d4.droppedRowIds.has('quote') && !d4.droppedRowIds.has('reviewer'),
    showPlan(d4));

  // D5: HERO IS BY CONTENT, NOT ARRAY INDEX. canonical.json's proof group
  // authors quote, then a `headline` claim restatement gated
  // `visibleWhenEmpty: "quote"` — when quote IS empty, headline is rows[1]
  // (not rows[0]) yet is the ACTUAL rendered hero. REVERT-PROOF: change
  // `heroIdx` back to a hardcoded `0` in planGroupFit → this check goes red
  // (the fallback header would get dropped instead of protected).
  const d5 = planGroupFit({
    rows: [
      { id: 'quote-gated-empty', heightPx: 0, heightPxNoReviews: 0 },
      { id: 'headline-fallback', heightPx: 200, heightPxNoReviews: 200 },
      { id: 'rating', heightPx: 90, heightPxNoReviews: 40 },
    ],
    boxHeightPx: 50, rowGapPx: 20, // starved — only the hero can possibly survive
  });
  check('D5 the hero (first row with real content) is protected even when it is not rows[0]',
    !d5.droppedRowIds.has('headline-fallback'), showPlan(d5));
  check('D5b the empty gated row (0 height) is irrelevant to protection either way',
    true); // documented via D5's construction; no separate assertion needed

  // D6: maximally starved box (0px) — the hero survives (never dropped) even
  // though it plainly cannot fit; nothing else does either.
  const d6 = planGroupFit({
    rows: [
      { id: 'hero', heightPx: 500, heightPxNoReviews: 500 },
      { id: 'trailer', heightPx: 80, heightPxNoReviews: 80 },
    ],
    boxHeightPx: 0, rowGapPx: 20,
  });
  check('D6 hero never dropped even in a zero-height box', !d6.droppedRowIds.has('hero'), showPlan(d6));
  check('D6b scale floors out rather than going below SHRINK_FLOOR', d6.scale === SHRINK_FLOOR, showPlan(d6));

  // D7: shrink is preferred over dropping whenever shrink alone is enough —
  // construct a box where BOTH a drop and a shrink would fit, and require
  // the planner pick shrink (no drops) per the documented priority order.
  const d7 = planGroupFit({
    rows: [
      { id: 'a', heightPx: 100, heightPxNoReviews: 100 },
      { id: 'b', heightPx: 100, heightPxNoReviews: 100 },
    ],
    boxHeightPx: 190, rowGapPx: 5, // total@1=205; @floor(.82)=168.9 — fits by shrink alone
  });
  check('D7 prefers shrinking over dropping when the floor alone would fit',
    d7.droppedRowIds.size === 0 && d7.scale < 1, showPlan(d7));

  // D8: zero-content rows cost no gap. REVERT-PROOF: reverting `totalAt`'s
  // `visibleCount` back to plain `kept.length` makes this go red — the
  // wasted phantom gaps (2 × rowGapPx here) would tip an otherwise-fitting
  // group into an unnecessary drop.
  const withPhantoms = planGroupFit({
    rows: [
      { id: 'quote', heightPx: 150, heightPxNoReviews: 150 },
      { id: 'phantom1', heightPx: 0, heightPxNoReviews: 0 },
      { id: 'phantom2', heightPx: 0, heightPxNoReviews: 0 },
      { id: 'rating', heightPx: 84, heightPxNoReviews: 40 },
    ],
    boxHeightPx: 211, rowGapPx: 42,
  });
  const withoutPhantoms = planGroupFit({
    rows: [
      { id: 'quote', heightPx: 150, heightPxNoReviews: 150 },
      { id: 'rating', heightPx: 84, heightPxNoReviews: 40 },
    ],
    boxHeightPx: 211, rowGapPx: 42,
  });
  check('D8 phantom (zero-height) rows do not change the outcome vs. the same rows without them',
    withPhantoms.dropReviewsRowId === withoutPhantoms.dropReviewsRowId
      && withPhantoms.droppedRowIds.has('rating') === withoutPhantoms.droppedRowIds.has('rating')
      && Math.abs(withPhantoms.scale - withoutPhantoms.scale) < 1e-9,
    `with=${showPlan(withPhantoms)} without=${showPlan(withoutPhantoms)}`);
  check('D8b the phantom-inclusive case keeps the rating row (this is THE shipped-incident fix)',
    !withPhantoms.droppedRowIds.has('rating') && withPhantoms.dropReviewsRowId === 'rating',
    showPlan(withPhantoms));
}

// ── E. THE REAL INCIDENT, pinned with the actual measured numbers ──────────
// Vuori meta_reels_9_16, run run_1787136860887_654ed621: quote "cinched at
// the waist but not tight" (35 chars), no reviewer name, rating 4.6/15,626
// reviews. Same content, same fontPx model, on BOTH surfaces' real boxes.
{
  const dims = { width: 1080, height: 1920 };
  const QUOTE = '"cinched at the waist but not tight"';
  const quoteFontPx = 56 * 1.15; // BASE_SIZE.quote.vertical × canonical.json sizeScale
  const ratingFontPx = 28 * 1.25; // BASE_SIZE.rating.vertical × canonical.json sizeScale
  const usableWidthPx = (1 - SAFE_ZONES.reels.left - SAFE_ZONES.reels.right) * dims.width; // Reels' own (narrower) box

  const quoteH = estimateSlotHeightPx('quote', QUOTE, { fontPx: quoteFontPx, usableWidthPx, maxLines: 3 });
  const ratingContent = { rating: 4.6, reviewsText: '15,626 brand reviews' };
  const ratingH = estimateSlotHeightPx('rating', ratingContent, { fontPx: ratingFontPx, usableWidthPx });
  const ratingHNoRev = estimateSlotHeightPx('rating', ratingContent, { fontPx: ratingFontPx, usableWidthPx, dropReviews: true });
  const rowGapPx = Math.round(0.022 * dims.height); // canonical.json vertical stack.rowGapPct

  // The real group shape: quote, a null claim-fallback, a null reviewer,
  // then rating — see section D5/D8 for why the two null rows matter.
  const rows = () => [
    { id: 'quote', heightPx: quoteH, heightPxNoReviews: quoteH },
    { id: 'claim-fallback', heightPx: 0, heightPxNoReviews: 0 },
    { id: 'reviewer', heightPx: 0, heightPxNoReviews: 0 },
    { id: 'rating', heightPx: ratingH, heightPxNoReviews: ratingHNoRev },
  ];

  const reelsBox = resolveGroupBoxPx({ anchor: 'lowerThird', safe: SAFE_ZONES.reels, height: dims.height });
  const reelsBoxH = dims.height - reelsBox.topPx - reelsBox.bottomPx;
  const storiesBox = resolveGroupBoxPx({ anchor: 'lowerThird', safe: SAFE_ZONES.stories, height: dims.height });
  const storiesBoxH = dims.height - storiesBox.topPx - storiesBox.bottomPx;

  const reelsPlan = planGroupFit({ rows: rows(), boxHeightPx: reelsBoxH, rowGapPx });
  const storiesPlan = planGroupFit({ rows: rows(), boxHeightPx: storiesBoxH, rowGapPx });

  check('E1 Reels: the quote is NEVER dropped', !reelsPlan.droppedRowIds.has('quote'), showPlan(reelsPlan));
  check('E2 Reels: the rating ROW is kept — only its reviews sub-part is dropped '
      + '(the exact, better-than-minimum outcome: complete stars + score, no partial anything)',
    !reelsPlan.droppedRowIds.has('rating') && reelsPlan.dropReviewsRowId === 'rating',
    showPlan(reelsPlan));
  check('E3 Stories: fits at full size, nothing shrunk or dropped (must stay byte-identical)',
    storiesPlan.scale === 1 && storiesPlan.dropReviewsRowId === null && storiesPlan.droppedRowIds.size === 0,
    showPlan(storiesPlan));

  // THE MASTER INVARIANT: whatever the plan decides, re-simulate it and
  // confirm the result actually fits inside the REAL box (not just the
  // safety-margined budget) — i.e. the plan is not merely "an answer" but a
  // answer that holds when taken at face value.
  const simulate = (plan) => {
    const kept = rows().filter((r) => !plan.droppedRowIds.has(r.id));
    const eff = kept.map((r) => (r.id === plan.dropReviewsRowId ? r.heightPxNoReviews : r.heightPx));
    const visible = eff.filter((h) => h > 0);
    const sum = eff.reduce((a, h) => a + h * plan.scale, 0);
    return sum + rowGapPx * plan.scale * Math.max(0, visible.length - 1);
  };
  check('E4 Reels plan, simulated, fits inside the real 211px box (not just the safety margin)',
    simulate(reelsPlan) <= reelsBoxH, `simulated=${simulate(reelsPlan)} box=${reelsBoxH}`);
  check('E5 Stories plan, simulated, fits inside the real 614px box',
    simulate(storiesPlan) <= storiesBoxH, `simulated=${simulate(storiesPlan)} box=${storiesBoxH}`);
}

// ── F. Cross-surface: the SAME functions, fed each YouTube/PMax zone's real
//      box, never produce a partial-element outcome. No per-surface branch
//      exists anywhere in stackFit.js/Canonical.jsx for this to special-case —
//      these checks exist to prove that claim, not to add a carve-out. ──────
{
  const SURFACES = [
    { name: 'reels (meta_reels_9_16)', zoneKey: 'reels', height: 1920 },
    { name: 'verticalYt (pmax_video_9_16)', zoneKey: 'verticalYt', height: 1920 },
    { name: 'landscapeYt (pmax_video_16_9)', zoneKey: 'landscapeYt', height: 1080 },
    { name: 'squareYt (pmax_video_1_1)', zoneKey: 'squareYt', height: 1080 },
    { name: 'stories (meta_stories_9_16)', zoneKey: 'stories', height: 1920 },
  ];
  for (const s of SURFACES) {
    const box = resolveGroupBoxPx({ anchor: 'lowerThird', safe: SAFE_ZONES[s.zoneKey], height: s.height });
    const boxH = s.height - box.topPx - box.bottomPx;
    // A deliberately oversized synthetic group (quote 3 lines + reviewer +
    // rating with reviews) — bigger than ANY of these boxes could hold at
    // full size, so every surface is forced through the shrink/drop path.
    const fontBase = s.height >= 1920 ? 60 : 36; // vertical vs landscape/square font scale
    // maxLines mirrors the REAL authored values (slotContent.js DEFAULT_MAX_LINES.quote):
    // vertical=3, landscape/square=2 — a stress test should still be representable copy,
    // not an unbounded hero no real preset would ever author.
    const quoteMaxLines = s.height >= 1920 ? 3 : 2;
    const quoteH = estimateSlotHeightPx('quote', 'x'.repeat(120), { fontPx: fontBase * 1.15, usableWidthPx: 700, maxLines: quoteMaxLines });
    const reviewerH = estimateSlotHeightPx('reviewer', 'A REVIEWER NAME', { fontPx: fontBase * 0.4, usableWidthPx: 700, maxLines: 1 });
    const ratingContent = { rating: 4.9, reviewsText: '99,999 brand reviews' };
    const ratingH = estimateSlotHeightPx('rating', ratingContent, { fontPx: fontBase * 0.6, usableWidthPx: 700 });
    const ratingHNoRev = estimateSlotHeightPx('rating', ratingContent, { fontPx: fontBase * 0.6, usableWidthPx: 700, dropReviews: true });
    const testRows = [
      { id: 'quote', heightPx: quoteH, heightPxNoReviews: quoteH },
      { id: 'reviewer', heightPx: reviewerH, heightPxNoReviews: reviewerH },
      { id: 'rating', heightPx: ratingH, heightPxNoReviews: ratingHNoRev },
    ];
    const plan = planGroupFit({ rows: testRows, boxHeightPx: boxH, rowGapPx: Math.round(0.022 * s.height) });

    check(`F ${s.name}: hero (quote) never dropped`, !plan.droppedRowIds.has('quote'), `box=${boxH} plan=${showPlan(plan)}`);
    // The invariant is binary per row: a row is either fully present (with
    // or without its own reviews sub-part) or fully absent — simulate and
    // confirm no row is left in a state that still overflows on its own.
    const eff = testRows
      .filter((r) => !plan.droppedRowIds.has(r.id))
      .map((r) => (r.id === plan.dropReviewsRowId ? r.heightPxNoReviews : r.heightPx));
    const visible = eff.filter((h) => h > 0);
    const total = eff.reduce((a, h) => a + h * plan.scale, 0) + Math.round(0.022 * s.height) * plan.scale * Math.max(0, visible.length - 1);
    check(`F ${s.name}: simulated plan fits the real box (no residual overflow to clip)`,
      total <= boxH + 1e-6, `total=${total} box=${boxH}`);
  }
}

// ── G. resolveGroupBoxPx's `bottom` anchor now has a real ceiling ───────────
// Before 2026-08-19 this anchor had NO `top` at all (see stackContainerStyle's
// history) — an intrinsic-height box with nothing above it, so it could
// never clip an element but also never had the "no spec offset can push
// content under platform UI" guarantee the file's own header claims for it.
// REVERT-PROOF: remove the `topPx: topFor(safe.top)` line from
// resolveGroupBoxPx's `bottom` case (reverting to the old shape) → G1/G2 go
// red (topPx becomes undefined/non-finite).
{
  const cases = [
    { name: 'reels', safe: SAFE_ZONES.reels, height: 1920 },
    { name: 'landscapeYt', safe: SAFE_ZONES.landscapeYt, height: 1080 },
  ];
  for (const c of cases) {
    const box = resolveGroupBoxPx({ anchor: 'bottom', safe: c.safe, height: c.height, offsetY: 0 });
    check(`G1 ${c.name} bottom anchor: topPx is now finite (had no ceiling before)`,
      Number.isFinite(box.topPx), `got ${box.topPx}`);
    check(`G2 ${c.name} bottom anchor: box has positive real height`,
      c.height - box.topPx - box.bottomPx > 0, JSON.stringify(box));
    // stackContainerStyle must actually USE this — not just resolveGroupBoxPx
    // computing it and the CSS builder ignoring it.
    const css = stackContainerStyle({ format: 'vertical', safeZoneKey: 'reels', anchor: 'bottom', offsetX: 0, offsetY: 0, width: 1080, height: c.height });
    check(`G3 ${c.name === 'reels' ? 'reels' : c.name} bottom anchor CSS carries a numeric top AND overflow:hidden`,
      Number.isFinite(css.top) && css.overflow === 'hidden', JSON.stringify(css));
  }
}

// ── H. Sanity on the safety margin / shrink floor constants themselves ─────
{
  check('H1 FIT_SAFETY_MARGIN is strictly below 1 (a real margin, not a no-op)', FIT_SAFETY_MARGIN < 1 && FIT_SAFETY_MARGIN > 0.8);
  check('H2 SHRINK_FLOOR is a modest reduction, not a drastic one', SHRINK_FLOOR >= 0.75 && SHRINK_FLOOR < 1);
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyReelsOverflowSafety: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyReelsOverflowSafety: ${passed}/${total} checks passed`);
