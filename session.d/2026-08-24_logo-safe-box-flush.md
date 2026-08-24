# 2026-08-24 — static logo flush to the QC safe box

Dominant static creative defect, measured across 63 real ads / 7 runs /
2 brands tonight. 41 of 63 delivered (65%). Of the 21 that failed vision
QC, 14 were `layout_safe_box` (two thirds). 19 of 21 were regenerated
first — paid for the image twice and shipped nothing.

Verbatim QC verdicts named one element: the composited brand logo sitting
outside / at the bottom / in the bottom-right of the required safe area.
Some also said "severely distorted"; that is the vision inspector
describing a large stacked lockup on the line, not Sharp stretching
(`fit:'inside'` never distorts).

## Composite vs prompt

**We composite it.** `services/directImageRenderService.js` `finishPlate`
(the post-model half) fetches `Brand.logoUrl`, resizes via `logoResizeBox`
+ `fit:'inside'`, then `sharp().composite` at `logoPlacementFor(...)`.
The prompt only reserves the corner (`staticAdIntents.js` geometry block
+ "Keep the ${logoCorner} corner clear"). Vision QC is handed
`safeBoxInDeliveredPx(built.surface, dims)` — the same delivered-px box
the compositor places into.

So this is arithmetic, not a prompt-compliance problem, and it is
provable offline.

## The numbers (production square mark, before the inset)

Every live static surface placed the mark **flush** to the QC box on the
right and/or bottom. Frame gaps stayed positive — which is why
`verifyStaticSafeBox` S3 (frame-edge gap) and `verifyStaticGeometry` G4
(`<=` the box) both stayed green.

| surface | delivery | QC box | logo rect (square) | margin vs QC L/T/R/B |
|---|---|---|---|---|
| meta_feed_1_1 | 1080×1080 | 65–1015, 65–1015 | 842–1015, 842–1015 | 777/777/**0/0** |
| meta_feed_4_5 | 1080×1350 | 65–1015, 65–1285 | 842–1015, 1096–1269 | 777/1031/**0**/16 |
| meta_stories_9_16 | 1080×1920 | 65–1015, 336–1584 | 826–999, 1411–1584 | 761/1075/16/**0** |
| pmax_landscape_1_91_1 | 1200×628 | 120–1080, 63–565 | 980–1080, 465–565 | 860/402/**0/0** |
| pmax_square_1_1 | 1200×1200 | 120–1080, 120–1080 | 888–1080, 888–1080 | 768/768/**0/0** |
| pmax_portrait_4_5 | 960×1200 | 96–864, 120–1080 | 710–864, 926–1080 | 614/806/**0/0** |

`platformFormats.safeArea` is live for static (Stories 250/250 on canvas
1000×1778; every other live static is 0/0). It is already folded into
`computeSurface` as the platform reserve. The Math.max(crop, margin)
collapse from 2026-08-03 is **not** firing on live surfaces (all
zero-crop except pmax landscape, whose 40px crop is smaller than its
10% margin). Pinned as fixture C in `verifyLogoSafeBox.js` so it cannot
silently return.

## Did the square `logoResizeBox` (#321) make it worse?

The square box does **not** push the mark outside the QC box. The 0.35-tall
predecessor was flush on the same edges (same right/bottom, just shorter).
What it does: a stacked ~1:1 lockup that used to bind on height at ~60px
is now 173×173 on 1080 (~2.8× taller, extending upward into the box).
Wide wordmarks still bind on width (`fit:'inside'`) and are unchanged.

Owner's control (safe-area signature among failed ads 16% → 26%, z≈1.7,
p≈0.09) is consistent with an **amplifier**, not a new overflow: more
ink sitting on the line that vision already scored as a breach. Root
cause pre-dates #321. The square box is left in place (stacked-lockup
legibility); re-ink contrast (#321 linearized WCAG + 4.5 floor) is
untouched.

## Fix

`logoPlacementFor` insets the clamped (text-box ∩ platform-floor) rect
by `max(8px, 2% of short edge)` before bottom-right alignment. The mark
moves up and left; it is not shrunk. After:

| surface | logo rect | margin vs QC L/T/R/B |
|---|---|---|
| meta_feed_1_1 | 820–993, 820–993 | 755/755/**22/22** |
| meta_feed_4_5 | 820–993, 1074–1247 | 755/1009/**22/38** |
| meta_stories_9_16 | 804–977, 1389–1562 | 739/1053/**38/22** |
| pmax_landscape_1_91_1 | 967–1067, 452–552 | 847/389/**13/13** |
| pmax_square_1_1 | 864–1056, 864–1056 | 744/744/**24/24** |
| pmax_portrait_4_5 | 691–845, 907–1061 | 595/787/**19/19** |

## Harness

`scripts/verifyLogoSafeBox.js`. Drives the real geometry functions.
Fails if any composited logo rect has a non-positive margin vs
`safeBoxInDeliveredPx`. Includes the crop-band vs edge-margin collapse
fixture (C1–C3). Revert-proven:

1. Drop the four inset assignments in `logoPlacementFor` → 25 fails
   (L2/L5/L6; every live surface flush again).
2. Restore `Math.max(crop, margin)` in `computeSurface` → C2 fails
   (synthetic 1:3 `box.left` 20.4% vs additive 23.9%).
3. Same inset drop against tightened G4 (`<` not `≤`) → 20 fails in
   `verifyStaticGeometry.js`.
4. Keep `logoPlacementFor` but paste at the frame edge in `finishPlate`
   → Q2b fails (L2/L5 stay green — they only drive the placement
   function). Adversarial finding; the first Q2 window was 4500 chars
   and missed the paste at +6220.

## Port

adgen owns the live render path. The same `logoPlacementFor` /
`finishPlate` pair has to receive this inset there; this worktree does
not do that port.

## Constraints honoured

No generation-gate / campaign / ads-route / atlas\* edits (nothing
billable). QC check not weakened. Logo re-ink contrast untouched.
}
