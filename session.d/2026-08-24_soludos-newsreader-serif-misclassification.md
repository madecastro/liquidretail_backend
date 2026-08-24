# 2026-08-24 — Soludos GS Newsreader classified as sans-serif

Live static ads for **Soludos GS** rendered sans headlines. The brand's
heading face is Newsreader, a serif. Measured against the real production
Brand document: `typefaceDirectiveForBrand` returned

> This brand's own typeface is Newsreader, **a sans-serif**. Set the
> headline … in a sans-serif with clean grotesque/humanist proportions,
> in the spirit of Newsreader.

Two linked ingest faults, both confirmed against live soludos.com CSS
(theme t/269, 2026-08-24) before either was changed.

## (a) Role detection found only icon fonts

Stored `websiteFontUsage`:

- heading / body / headingGeneric / bodyGeneric = null
- button = `oke-widget-icons`
- evidence = two rows: Okendo `.oke-button.oke-is-loading:before` →
  `oke-widget-icons`, Swiper `.swiper-button-next:after` → `swiper-icons`

Those are dingbats on `::before`/`::after` of widget buttons, not
typography. `extractFontUsageFromCss` treated `button` as a role token
inside `.oke-button` / `.swiper-button-next` and kept the rule.

## (b) The generic WAS declared; ingest could not see it

Verbatim from the homepage inline `:root` block:

```css
--FONT-STACK-BODY: "DM Sans", sans-serif;
--FONT-STACK-HEADING: Newsreader, serif;
```

Verbatim from `theme.css`:

```css
.h1, .h2, .h3, .h4, .h5, .h6, h1, h2, h3, h4, h5, h6 {
  font-family: var(--FONT-STACK-HEADING);
}
body {
  font-family: var(--FONT-STACK-BODY);
}
```

`extractFontUsageFromCss` collected custom properties from the sheet it
was scoring. `aggregateFontUsageAcrossSheets` scored each sheet alone,
then merged evidence. theme.css's `var(--FONT-STACK-HEADING)` did not
resolve, `firstConcreteFamily` returned null, the heading rule was
skipped, and headingGeneric stayed null. `classifyTypeface` then fell
through to the name heuristic; "Newsreader" matches no `SERIF_HINTS`
keyword → sans.

This is the Marine Layer "read the brand's CSS generic" path failing to
engage, not a missing keyword. Precedence is unchanged: a recognised
serif name still outranks a stored generic.

`(a)` alone would not have fixed Soludos — heading was null because of
`(b)`, not because icon-font rows crowded it out (`pick()` runs before
the 30-row evidence cap). `(b)` alone would have; `(a)` is still
required so dingbats never become role evidence.

## Fix

- Skip a rule whose every comma-separated selector is `:before`/`:after`
  (`h1, h1:before` still counts).
- Skip icon-font family names (`oke-widget-icons`, `swiper-icons`,
  font-awesome, …) as non-brand, same bucket as emoji fallbacks.
- Merge CSS custom properties across sheets **before** scoring, so a
  token defined in an inline `:root` is visible to `var(--token)` usage
  in theme.css.
- `typefaceDirectiveForBrand` skips icon-font families when picking the
  face (consume-time guard for already-stored icon-font roles).

Classifier / `SERIF_HINTS` untouched. "Newsreader" is not on the keyword
list.

## Residual — already-stored docs

The stored Soludos GS document still has `heading: null` and no generic.
`typefaceDirectiveForBrand` on that exact shape still says sans: the
generic is captured at ingest, and a keyword-list patch was refused.
`scripts/backfillBrandFontGenerics.js` cannot repair it — it skips a
role whose recorded family is empty.

After deploy: re-ingest fonts for Soludos GS (and any brand whose heading
is null while `customFonts[0]` is an unkeyworded serif). New ingest
writes `heading: Newsreader`, `headingGeneric: serif`.

## Proof

`scripts/verifyTypefaceClassification.js` C9 + C7-K/L/M/N. 157 checks
(was 128). Playfair / aktiv-grotesk directives hardcoded byte-identical
to the pre-change strings. Live CSS (inline + theme + swiper) after the
fix: heading=Newsreader, headingGeneric=serif; directive names
Newsreader as a serif.
