# 2026-08-24 — PR #324 follow-up: three reproduced colourway holes

Owner reproduced all three off the real exported predicate on
`fix/quote-colourway-mismatch` and sent them back. Closed on the
same branch. None of these is a matcher-widening: both failure
directions cost money (wrong-colour reprint ~$0.14, or silently
stripping a good testimonial from every future ad for the SKU).

## 1. Display-normalized title lost White

`productColourwayFromTitle("…Sneaker | White - Wine")` → `{white,wine}`.
`displayNormalizeTitle` flattens `|` to ` - `, and last-` - `-only
parse of `"…Sneaker - White - Wine"` returned `{wine}`. A quote
praising the white part was rejected as a mismatch.

Fix: walk consecutive trailing dash segments that look like
colourway pieces (leftover words must be empty or intensity
modifiers like `Heavy`), so both title forms yield the same set.
Pipe-suffix still wins when present. `"Pink Floyd Graphic Tee -
Black"` stays `{black}`, not pink.

Call sites: video rotation and paint now share one
`colourwayTitle` (`catalogProduct?.title` first, display name
fallback). Paint used to drop the catalog title. Static was
already catalog-first.

## 2. `green-accented` leaked

`\bgreen\b` matched inside `"green-accented"`, then
`isHyphenatedNonColour` skipped it because `accented` is not a
colour form. The hyphenated adjective is a natural reviewer
shape, not an edge case.

Fix: colour-describing hyphen tails (`accented`, `tinted`,
`hued`, `toned`, `colored`/`coloured`, `accent`/`accents`) are
colour language. Frozen compounds whose tail is neither a colour
nor one of those (`blue-chip`) still skip. Word-boundary match
is unchanged — not a substring search.

## 3. `mint condition` (and the collocate shape)

`"Arrived in mint condition"` named the green family. The idiom
list was a flat string bag, too short, and adding one sentence
would not have generalised.

Fix: `COLOUR_IDIOM_TAILS` is a colour→collocate map that
generates spaced and hyphenated forms. `mint: ['condition']` is
one entry of that shape, not a one-off. Phrases that cannot be
generated that way (`rose to the occasion`, `in the black`) stay
in `COLOUR_IDIOM_PHRASES`.

## Unknown colourway

Owner steer, confirmed: product-attached + colour language +
unparseable/missing title → DROP (cannot vouch). Brand /
media-library ads (`productAttached === false`) KEEP even when
`productTitle` is set for noun-scope — riding that title would
silently strip proof from ads that have no SKU colourway.
`applyQuoteColourway` now short-circuits on
`productAttached === false`. Layout-input pool assembly only
passes a colourway title when `options.productId` is set.

## Pin

`scripts/verifyQuoteColourway.js` matrix drives the real
`usableColourwayQuote` for every MUST DROP / MUST KEEP, raw vs
display-normalized, and revert-proves the three holes (R6 last-
dash-only, R7 adj-tail skip restored, R8 mint collocate removed)
plus the productAttached short-circuit (R9).
