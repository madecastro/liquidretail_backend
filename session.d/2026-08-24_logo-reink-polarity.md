# 2026-08-24 — logo re-ink polarity (Pelagic white wordmark)

Correction on `fix/brand-consistency` after `1d8e3007`. Diagnosis direction
(ink-vs-plate contrast) was right; polarity was inverted for the brand that
exhibited the defect. No spend-path files touched. Rating + CTA work in
`1d8e3007` left alone.

## What was wrong

`prepareLogoForComposite` re-inked low-chroma covered pixels to LIGHT ink,
and only when `behindLuminance <= 0.5`. Measured on the Pelagic batch that
produced the "two lockups" screenshot:

| | value |
|---|---|
| Pelagic SVG fills | `#ffffff` ×3 (wordmark), `#0055b8` (chroma 184, L 0.29), `#c10230` (chroma 191, L 0.18). **No dark wordmark.** |
| Ws Aquatek plate behind the logo | **0.56** (light). Cropped corner: tiles only, white wordmark gone. |
| Mai Tai plate behind the logo | **0.27** (dark). Cropped corner: white wordmark clearly present. |

The inverted gate never fired on 0.56 (light side of 0.5) and, had it fired,
would have painted the ink that was already invisible.

## What shipped instead

Contrast-driven, bidirectional re-ink of **low-chroma** covered pixels:

- `inkContrastRatio` is the WCAG 2.x `(L1+0.05)/(L2+0.05)` formula in the
  **same 0..1 space as `behindLuminance`** (Rec.709-weighted, no sRGB
  linearization). Linearizing classifies the failing 0.56 plate as ~3.24:1
  and skips the re-ink — revert-proven.
- Floor `LOGO_MIN_INK_CONTRAST = 3`. Measured ratios: white vs 0.56 → **1.72**
  (re-ink); white vs 0.27 → **3.28** (leave). 3 sits between them. White-ink
  crossover is plate L = 0.30, so Mai Tai has 0.03 of headroom.
- Replacement ink is `contrastingInkFor` (max of black/white vs the plate),
  **not** `monochromeInkFor`'s 0.5 split. At plate 0.49 that split picks
  WHITE; black is 10.8:1. Reusing it would re-ink a white wordmark to white.
- Square logo box from `1d8e3007` kept. Simple-wordmark `monochromeInkFor`
  path unchanged.

## High-chroma residual — decided, not silent

Brand-colour preservation **wins** for high-chroma pixels. `#0055b8` and
`#c10230` fail 3:1 against **both** measured plates (blue ~1.06 / 1.79, red
~1.39 / 2.65). Applying the contrast rule to them flattens Pelagic's tiles
to black on every ad — revert-proven (8 fails, tiles → `0,0,0`). A navy
wordmark on a dark plate is the same residual: at pixel level we cannot tell
a navy wordmark from a navy tile. A flat navy-only logo is a different
class (`logoIsPolychrome` uses mean chroma, so a single-hue tint reads
polychrome); not closed here.

## Mutation matrix (`verifyLogoColorPreservation.js`, each went red then restored)

| mutation | failed checks |
|---|---|
| restore `monochromeInkFor` + `behindLuminance <= 0.5` | L6 Aquatek stays `255,255,255`; 0.49 stays white; L6-src ×2 (4 failed) |
| `LOGO_MIN_INK_CONTRAST = 4.5` | Mai Tai wordmark → `0,0,0` (the other inversion); exports; floor (4 failed) |
| drop the chroma `continue` | `#0055b8` / `#c10230` → `0,0,0` on **both** plates (8 failed) |
| `if (false && ink)` skip re-ink | L6 Aquatek stays white; L5 dark wordmark stays dark (4 failed) |
| sRGB-linearize `inkContrastRatio` | Aquatek ratio becomes 3.24 ≥ 3, white wordmark stays (8 failed) |
| always re-ink low-chroma (no contrast check) | **Mai Tai → `0,0,0`** — the contrast check is the only thing keeping 0.27 white (1 failed) |
| mixed-path `monochromeInkFor` instead of `contrastingInkFor` | L5 dark wordmark at 0.27 → white (0.5-split); L6 0.49 white stays white; L6-src (3 failed). Aquatek 0.56 still went black (lucky side of 0.5) |

## Checked and rejected (measured, not argued)

`sharp@0.33.5` `removeAlpha()` **drops** the alpha channel and keeps source
RGB; it does **not** composite onto black (`flatten({background:black})` is
that path). A 50% white AA fringe stays `(255,255,255)` and follows the
same contrast rule as solid white — so it is **not** re-inked to a black
outline on Mai Tai (white vs 0.27 = 3.28 ≥ 3). A coverage≥200 skip was
considered and dropped: on the failing 0.56 plate it would have *left*
white AA around the newly-black wordmark.

## Unverified

- No live re-render of the Pelagic batch (would bill). Fixtures use the
  measured hexes and the measured behind-logo luminances, not the delivered
  PNGs.
- Production `behindLuminance` is `sharp().greyscale()` mean / 255 —
  measured on 0.33.5 as neither Rec.601 nor Rec.709-no-gamma on chromatic
  primaries (red 124 vs 76 vs 54). Greys agree, and we only re-ink
  low-chroma pixels, so a white wordmark is unaffected. The 0.27 / 0.56
  fixtures are the owner's measurements as fed into `prepareLogoForComposite`;
  if live greyscale of a golden-hour plate reads ≥ ~0.31, Mai Tai's 0.03
  headroom would run out and the wordmark would go black. Unverified
  against a live re-render.
- `toFixed(2)` on the Render log would print `0.30` for 0.304, which is
  already below the floor. Logging is not the decision.
- White wordmark on an **opaque white canvas** (no discriminating alpha)
  would still be dropped by `coverageFromBackgroundDistance` on every
  plate. Production Pelagic is an SVG with transparent ground — the dark
  plate showing the wordmark proves those pixels are in the composite.
  Not this bug.
