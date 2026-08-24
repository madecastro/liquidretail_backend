# 2026-08-24 — quote colourway mismatch (fail-closed)

Measured on Soludos product "Women's Roma Retro Sneaker | White - Wine"
(`run_1787576848754_994b722b`). Four of nine statics failed vision QC;
two of those because the testimonial described a green accent on a
wine/burgundy shoe. The ads regenerated and failed again — two
gpt-image-2/edit submits (~$0.14) per occurrence, nothing shipped.

## What was confirmed vs corrected

1. **Colourway lives in the title.** CatalogProduct has no `color` /
   `options` field. Confirmed: `models/CatalogProduct.js` schema has
   `title`, `itemGroupId`, `primaryProductId`, `productReviews` — no
   colour path. The `:34` comment names "size/color/scent variants of
   the same parent" as the *grouping* key, not a stored colour.
2. **No colour filter in quote selection.** Confirmed: zero matches for
   `colou?r` in `quoteSnippetService.js` and `productDetailsService.js`.
3. **Quotes are not joined across variants via parent id.** Corrected
   slightly: `itemGroupId` / `primaryProductId` are used to collapse
   *detect* (shared imagery), not to copy `productReviews`. The green
   review reaches the wine row because Shopify colour variants share a
   product URL / search name — `captureForProduct` scrapes `productUrl`,
   `lookupProductReviews` searches `productName`. Pooling is at the
   source, not a parent-id join. Scoping is still brandId + this row's
   own `productReviews` / productId.
4. **Fail-closed is the only safe gate** without a structured colour
   field (which we were told not to add).

## Approach chosen

**(c), which is (a) + fail-closed (b) on unparseable titles.**

`usableColourwayQuote(quote, productOrTitle)` in
`services/quoteColourway.js`, same shape as `usableAttribution`:

- Quote names no colour language → KEEP (no-op).
- No product context (brand / media ads) → KEEP (no-op).
- Quote names a colour, title parses, every named family is in the
  colourway → KEEP.
- Quote names a colour and the title has no parseable colourway →
  REJECT (fail closed). A title that cannot vouch for "green accent"
  must not print it.
- Quote names a colour whose family is not in the colourway → REJECT.

Parse is title-only, no ingest change. Prefers the segment after the
last `|` (the measured Soludos shape), then a trailing ` - …` segment
that looks like colours, then a full-title scan. Zero tokens →
unparseable. Reliability: the pipe-suffix is the honest one
(`Pink Floyd Tee | Black` → `{black}`, not pink). Full-title scan is
the residual ("Green Tea Cleanser" parses as `{green}`).

Wine/burgundy/oxblood/maroon are one family, so a burgundy quote on a
Wine colourway is a KEEP. Ordinary-word senses (`blue-chip`, `rose to
the occasion`, `in the black`) are masked before matching, plus a
hyphenated-non-colour skip so `blue-chip` is still safe if the mask
is edited.

Composed with `toPrintableCustomerQuote` / `applyStrictQuoteScope` at
the same choke points (static `buildIntentData`, video
`gateLayoutInputQuotes`, rotation `passesRenderGate`, pool assembly
`prepareQuotePool` when a title is supplied). Not folded into
printability — a green scraped quote is still a printable customer
quote; it is just the wrong one for this product.

No kill switch, same as `usableAttribution`. Revert is the PR.

Follow-up, not this PR: a structured colour field on CatalogProduct
filled at ingest. That would make the parse unnecessary; it is a
larger blast radius than stopping the reprint.

Pinned by `scripts/verifyQuoteColourway.js` (68 checks, revert-proven
on 5 mutations: identity helper, unmasked idiom, unparseable keep,
unwired static, unwired video). Director flag-off (the shipped default)
also colour-filters arrival reviews when a title is present, so a
green-accent line cannot be echoed into copy.headline after the
testimonial is dropped.
