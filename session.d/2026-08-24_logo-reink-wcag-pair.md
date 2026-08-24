# 2026-08-24 — logo re-ink margin: linearized WCAG + floor 4.5 as a PAIR

Follow-up on `fix/brand-consistency` after `10d38637`. Polarity was
already correct on both measured plates (owner executed that commit).
This widens the decision margin. No spend-path files touched. Chroma
gate, tile preservation, partial-alpha/AA-fringe, rating, and CTA
untouched.

## Why a pair, not either half

`10d38637` tested linearize and floor 4.5 as independent reverts. Each
half fails alone, so that matrix concluded "leave both as they are":

| mutation | Aquatek 0.56 (bug) | Mai Tai 0.27 (good) |
|---|---|---|
| linearize only, floor 3 | 3.24 ≥ 3, **stays white** — bug not fixed | 9.61 ≥ 3, stays white |
| floor 4.5 only, no linearize | 1.72 < 4.5, re-inks (lucky) | 3.28 < 4.5, **goes black** — regression |
| both reverted (non-linear + 3) | 1.72 < 3, re-inks | 3.28 ≥ 3, stays — worst margin **9%** |
| **SHIPPED PAIR (lin + 4.5)** | 3.24 < 4.5, re-inks | 9.61 ≥ 4.5, stays — worst margin **28%** |

A one-at-a-time matrix cannot see the pair. Applied together they fix
the bug AND triple the worst-case margin.

`behindLuminance` is a MEAN over the plate region, not a controlled
constant. The previous white-ink cliff was plate L = 0.300, so Mai Tai
at 0.27 had 0.03 of headroom — inside ordinary shot-to-shot variance.
A marginally brighter Mai Tai-style frame would re-ink Pelagic's WHITE
wordmark BLACK on a still-dark plate. That is the same failure the
owner reported, at a different plate value.

## What shipped

- `srgbEncodedToLinear`: IEC 61966-2-1 piecewise (`c <= 0.04045 ? c/12.92
  : ((c+0.055)/1.055)^2.4`), applied to already-greyscale 0..1 values.
- `inkContrastRatio` linearizes both args, then `(hi+0.05)/(lo+0.05)`.
- `LOGO_MIN_INK_CONTRAST = 4.5`.
- `contrastingInkFor` already called `inkContrastRatio`; it is linearized
  on the same basis as the gate, not a sibling metric.

Pinned by `scripts/verifyLogoColorPreservation.js` L6 matrix (all four
cells against BOTH plates) + L7 dark-plate bidirectional.

## Picker crossover — it moved, and that is right

Swept `contrastingInkFor` across 0.00–1.00:

| | first plate that picks BLACK |
|---|---|
| previous (non-linear) | **0.179** — BLACK from 0.20 up (white/black at 0.20 = 4.20/5.00) |
| shipped (linearized) | **0.460** — WHITE through the whole dark band; BLACK from 0.461 |

At Mai Tai 0.27 the old picker chose BLACK. Black's *true* WCAG ratio
there is **2.19** (fails 4.5); white is **9.61**. Re-inking a failing
dark wordmark to black would still be invisible. The linearized picker
chooses WHITE. L5's 0.27 dark wordmark now goes white; the remaining
disagreement with `monochromeInkFor`'s 0.5-split is the 0.460–0.500
band, still pinned at 0.49.

## Dark-plate bidirectional — widened, not dropped

Pure black wordmark vs plate, where the behaviour *starts* (ratio just
hits the floor; below this, black re-inks to white):

| rule | cliff (plate L) | 0.08 (reported case) | 0.12 |
|---|---|---|---|
| previous non-linear + 3 | **0.100** | re-ink (2.6 < 3) | leave (3.4 ≥ 3) |
| shipped linearized + 4.5 | **0.455** | re-ink (1.14 < 4.5) | re-ink (1.27 < 4.5) |

0.08 still re-inks. The band grew 0.10 → 0.455. White-ink cliff moved
0.300 → **0.465**; Mai Tai's headroom is 0.195 (was 0.03).

## New worst-case margin

Relative to floor 4.5, against the shipped exported functions:

- Aquatek 0.56: ratio **3.242**, **28% below**
- Mai Tai 0.27: ratio **9.611**, **114% above**
- Worst-case: **28%** (was 9%)

## Unchanged on purpose

Chroma `continue`, tile RGB on both plates, `removeAlpha` AA-fringe
path (white vs 0.27 is now 9.61 so a white fringe is still not outlined
black on Mai Tai), simple-wordmark `monochromeInkFor` 0.5-split, rating
`"5.0"`, generic-CTA casing, square logo box.

## Checks

`verifyLogoColorPreservation.js` **82** passed. Neighbouring:
`verifyLogoSilhouette` 17, `verifyBrandConsistency` 21,
`verifyStaticTextInk` 21. `npm run lint` clean. `node --check` on the
two touched files.

Mutation of the real service (restored after). Arithmetic table cells
stay green — they document the four formulas. The shipped-pair pins
go red on the matching axis:

| mutation | failed | named cell that went red | plate behaviour |
|---|---|---|---|
| linearize-only (floor 3, lin kept) | 8 | `PAIR not linearize-only` | Aquatek stays `255,255,255` (`THE DEFECT`) |
| floor-only (identity ratio, helper left in file) | 18 | `PAIR not floor-only` + `inkContrastRatio itself linearizes` | Mai Tai painted `0,0,0` (`MUST NOT REGRESS`) |
| both-reverted | 19 | all three shipped-pair matrix checks | — |

The src linearize scan is bounded to `inkContrastRatio`'s own body, so
a leftover `srgbEncodedToLinear` helper does not satisfy it (measured
on the floor-only mutation).
