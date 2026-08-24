# 2026-08-24 — three brand-consistency defects on one Pelagic static batch

> **CORRECTION (same day):** defect 3(b) polarity was inverted. Pelagic's
> wordmark is WHITE and vanished on the LIGHT plate (0.56), not a dark
> wordmark on a dark plate. See `session.d/2026-08-24_logo-reink-polarity.md`.


Measured on 27 delivered static ads for Pelagic Gear, run
`run_1787561664355_17096cc2`. Same brand, same run, same campaign. Branch
`fix/brand-consistency` off `origin/main`. No spend-path files touched.

## Defect 1 — "5 ★" reads as a broken rating widget

**Verdict: (a) compose bug.** Not model non-compliance, and not an
intentional compact-badge *at 5.0*.

`formatDisplayRating` (`services/ratingDisplay.js`) rounded via
`Number(raw.toFixed(1))` then `String(displayed)`. For a perfect 5 that is
`String(5)` → `"5"`. Shared by static (`directImageRenderService.buildIntentData`)
and video (`brandScriptExecutor.buildMetaForAd`).

Static then asks the image model for `${d.rating} ★`:

- `staticAdIntents.js` social_proof_led RATING slot
- `product_first_lifestyle` / `brand_led` TRUST MARK slots

So a 5.0 brand/product rating becomes the requested string **"5 ★"**. The
model typeset what we asked. The compact `"X ★"` form (and the explicit
`no star row, five-star graphic` absence) **is** intentional — two of five
test renders drew a 4.5-star graphic next to a 4.8 score. Do not "fix" this
by asking for ★★★★★.

Video Remotion `RatingSlot` already draws a five-star row +
`{rating.toFixed(1)}/5`, so a `"5"` meta value still painted `"5.0/5"` on
video. The broken widget is the **static in-model string**.

**Fix:** `return displayed.toFixed(1)` so 5 → `"5.0"` and the prompt asks
for `"5.0 ★"`. Floor/withhold contract unchanged.

**Not changed:** the star-row forbid; the `"X ★ (reviewsText)"` compose when
a count exists; video Remotion chrome.

## Defect 2 — CTA casing drifts inside one batch

**Verdict: nothing at render time normalised casing.** The 2026-08-19
`ctaCasingDirective` pins *whatever arrived*, so two source casings stay
two requested strings.

Actual static CTA path (Director `copy.cta` is **not** consulted):

1. `layoutInput.input.cta.text` — LLM derivation default `"Shop now"`,
   brand-match `"Shop the Brand"` / `"Shop the Collection"`
2. `buildIntentData` argument `cta: effectiveLayout.input?.cta?.text`
3. former fallback `'SHOP NOW'` (all-caps, disagreed with every other layer)

`"Shop the Mai Tai"` / `"Shop the Vaportek"` is **content** variety
(per-product derivation). Left byte-identical.

**Fix:** `normalizeCtaCasing` at `buildIntentData` rewrites only the generic
phrases we ourselves emit (`shop now` / `shop the brand` / `shop the
collection`), case-insensitively, to sentence case. Fallback is now
`'Shop now'`. Cached LayoutInputArtifacts pick it up without a re-derive.

**Not changed:** `metaCascadeConfig.js` `'SHOP NOW'` (preview overlay, not
burned in); Director `copy.cta` (still unused on the static image path —
reported, not wired); product-specific CTAs.

## Defect 3 — logo lockup differs between ads from one SVG

**Verdict: the mark IS composited by Sharp from `Brand.logoUrl`, not
generated.** Two contained causes from one asset explain "wordmark + two
tiles" vs "tiles only":

(a) Resize box was `width = 0.16·short-edge`, `height = 0.35·width`
    (`fit:'inside'`). A wide wordmark (Vuori 1108×179) still binds on
    width. A stacked lockup (PELAGIC over a two-tile mark, ~1:1) was
    crushed to ~60px tall on 1080 — wordmark illegible, and coverage
    computed *after* that downscale could drop thin letterforms.

(b) `prepareLogoForComposite` colour-preserves polychrome marks (right
    for the red/blue tiles). A dark wordmark on a dark generated plate
    then vanishes while the tiles stay. Same SVG, two lockups, varying
    with the plate behind.

The prompt still forbids drawing the logo and we still composite
afterwards. Model non-compliance (drawing the lockup into the scene) is
**possible and unfixable by config** — if an ad shows a large
wordmark+tiles *in the photograph* rather than the reserved corner, that
is the model. The two contained causes above are what we can actually
fix.

**Fix:** `logoResizeBox` is square (wide wordmarks unchanged — width still
binds). On a dark plate (`behindLuminance <= 0.5`), re-ink only
*low-chroma* covered pixels to contrasting light ink; high-chroma tiles
stay. Light plates keep today's colour-preserved wordmark.

**Not changed:** `logoPlacementFor` (still bottom-right of the clamped
safe box); the "never feed the logomark to the model" rule; spend.

## Mutation matrix (each went red, then restored)

| mutation | harness | failed checks |
|---|---|---|
| `return String(displayed)` | verifyBrandConsistency | R1, R4×2, R5, R6 (8 failed) — requested string becomes `"5 ★"` |
| `normalizeCtaCasing` identity | verifyStaticCtaDeterminism | C5 Shop Now / SHOP NOW / whitespace / brand / collection (7 failed) |
| restore `boxW * 0.35` resize in finishPlate | verifyBrandConsistency | L5-src |
| `if (false && ink && …)` skip dark-plate re-ink | verifyLogoColorPreservation | L5 wordmark stays 40,40,45 on a dark plate |
| `cta: cta \|\| 'SHOP NOW'` | verifyStaticCtaDeterminism | C5 missing/ALL-CAPS fallback |

## Unverified

- No live re-render of the Pelagic batch (would bill). `"5.0 ★"` is what we
  now *ask*; gpt-image-2 can still typeset it badly.
- Model-drawn logos in the scene (prompt non-compliance) are undiagnosable
  offline.
- Video Remotion already painted `"5.0/5"` + a star row; the decimal change
  is a no-op there (`Number("5.0").toFixed(1)`).
- Square logo box is larger in *height* for stacked marks; placement still
  refuses rather than overflow (`logoPlacementFor` returns null). Not
  visually confirmed on a real Pelagic SVG.
