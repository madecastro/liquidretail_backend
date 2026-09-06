# What counts as a titling regression

Not automated — this is the checklist for a human (or a future automated job)
comparing two titling runs and deciding whether something got worse. Nothing
in `scripts/verifyRpdHarness.js` checks any of this: that suite tests the
harness's own wiring (money safety, spec parsing, the real-brand selection
logic) against stubs, never a real Remotion render. The only way to see any
of the classes below is to actually run `titling.enabled: true` against a
real master and look at the output — which is exactly what this harness is
for, on demand, not on a schedule (see "Turning this into an automated job"
at the bottom if that ever changes).

## The seven ways a titled video gets worse

Ordered roughly by how often this repo's own history shows each one actually
happening (see the citations — this isn't a hypothetical list).

### 1. It doesn't finish at all
Titling throws, times out, or the process never produces `titled.mp4`.
Cheapest to check: `titleCell()`'s return value (`ok: true/false`), or in a
full `rpd run`, whether `cells/<id>/titled.mp4` exists and `titlingError` is
absent from the manifest. Binary, no judgment needed.

### 2. Wrong composition / wrong safe zone for the surface
**The single most common real defect class in this codebase's history** —
see `CLAUDE.md`'s §00 incidents: a burned-in quote losing its opening clause
on Reels while Stories kept it whole (safe-zone width mismatch), a star
rating sliced mid-glyph at a box boundary (group-fit sizing, not just
overflow direction), PR #307's surface-aware bands shipping correct code that
never actually got a `platformFormat` and silently fell back to a shared
zone for months. All of these looked fine in isolated unit tests and were
only visible by watching a real render.

Check: does the composition id (`format` passed to `renderTitles`) match
`COMPOSITION_BY_FORMAT[format]` for the requested aspect? Does text/logo/
rating stay inside the surface's actual safe box for its real
`platformFormat` (Stories ≠ Reels ≠ PMax YouTube — they are NOT the same
inset even at the same aspect ratio)? Extract frames at a few timestamps
(see the SKILL.md `ffmpeg -vf select=...` recipe) and look at the edges,
not just the center.

### 3. Real brand identity doesn't show up
New as of the 2026-09-04 real-brand wiring (`dbSeed.js` → `runner.js` →
`titling.js`'s `resolveTitleBrand`): a real product seeded via
`seed.productId` should render with that brand's actual logo, colors, font,
and tagline, not the "Pelagic Test Fixture" placeholder look. A regression
here specifically looks like: a real product's titled video reverting to
Pelagic navy/gold/"Built for blue water" — meaning the wiring silently broke
and fell back to the fixture. Check: does `spec.titling.brand` actually
reach `titleCell` (log line `🎬 rpd-title[cell=...]: spec=...`), and does the
rendered logo/color match the real brand, not the fixture's `#0B2545` /
`#F2C14E` / `Barlow Condensed`.

### 4. Text is missing, wrong, or a truncation error
Headline/CTA/price/quote render empty or containing the wrong string —
distinct from #2 (which is about *where* text sits, this is about *whether
the right text is there at all*). Related to `stackFit.js`'s shrink → drop
reviews line → drop whole trailing rows behavior — a regression could mean
it now drops the WRONG thing first (the hero content instead of a trailing
row).

**Definition of a truncation error, precise enough to check without
guessing:** any burned-in text that does not read as one complete thought or
phrase — regardless of *why* it got that way. Don't diagnose the mechanism
before checking the symptom; a reader doesn't know or care whether the cause
was a safe-zone clip (#2), a `stackFit` drop, or a copy-cascade bug — they
just see a sentence that starts or ends mid-clause. This is the same failure
already measured in production: the Reels quote in #2's citation was
grammatically fine on its own, but with the opening clause gone it no longer
read as a complete thought — that's what made it a defect, not merely that
pixels were missing. Check every piece of burned-in text this way, one at a
time: read only what's on screen (not the source copy you supplied) and ask
"does this stand alone as a finished sentence or phrase?" A "yes, but I had
to mentally fill in the missing part" is a fail.

### 5. A quote, rating, or review count appears that wasn't supplied
The money/trust-safety class. `titling.js`'s `fixtureMeta` and the new
`resolveTitleBrand` path both guarantee proof-class fields
(`quote`/`quoteSnippet`/`reviewer`/`rating`/`reviewCount`/`reviewsText`/
`badgeText`/`deliveryLine`) stay `null` unless the operator supplied them —
pinned structurally by `verifyRpdHarness.js` E8/E9. What that pin **can't**
see is whether a quote you *did* supply renders correctly (right text, right
attribution, not garbled) — that's still a real-render-only check.

### 6. Colourway / contrast wrong
Ink unreadable against its background (white-on-white, dark-on-dark) — the
"pick the higher contrast, don't threshold" logic in
`titleSpecService.buildBrandTokens` (a mid-tone fill like `#5B8C5A` is the
historical trap: a naive luminance cutoff picked white at a measured
1.93:1 contrast ratio where dark ink measured 9.3:1 on the same fill). Also
watch for a quote or badge naming a colour that doesn't match the product's
actual colourway in the frame — a static-path defect (`quoteColourway.js`)
that doesn't have a video-titling equivalent yet, but the visual mismatch
would look the same if it ever does.

### 7. Timing / duration drift
Burned-in text appears out of sync with the clip, or the composition's
`durationInFrames` doesn't match the actual source video length — happened
once already from a hardcoded-24fps assumption on a non-24fps source.
`fps`/`durationInFrames` are probed from the real plate via
`@remotion/media-parser` now, not assumed; a regression would mean that
probe silently stopped being trusted somewhere in the pipeline.

## How to actually check these today (no automation)

1. **Pick a fixed reference product** with a hard logo/label — see
   `references/prompt-elements.md`'s "pick a hard product" guidance. A
   template spec is at `scripts/rpd/specs/titling-regression-reference.json`
   — fill in a real `seed.productId` (needs `MONGODB_URI`) and keep using the
   *same* product across comparisons, or the comparison isn't apples to
   apples.
2. **Run it with `titling.enabled: true`** at whatever aspect/platformFormat
   you're worried about — square, vertical Stories, vertical Reels, and a
   PMax YouTube format are the minimum spread, since #2 above is specifically
   about zones differing ACROSS those, not within one.
3. **Extract frames and actually look** — the SKILL.md recipe
   (`ffmpeg -i cells/<id>/titled.mp4 -vf "select=..." ...`). Check the edges
   of frame, not just that *something* rendered.
4. **`rpd eval <runDir>` covers LESS of this than it looks like it should —
   verified against the real production QC prompt, not assumed.**
   `adVisionQcService.js`'s video rubric (`buildVideoVisionUserContent`,
   same one `rpd eval` calls) has a `text_defects` category, but its
   instruction text is explicit: *"product-intrinsic only — NOT the ad's
   caption overlay... Do NOT score the ad's own burned-in caption, headline,
   CTA button, or star-rating overlay — that overlay is inspected by a
   separate system and is explicitly OUT OF SCOPE for this category."*
   **That separate system does not exist.** Checked both repos for anything
   resembling it (titling-text QC, caption QC, `adTitlingTruth.js` — the one
   plausible hit — turned out to be lifecycle/settlement tracking, "did
   titling finish," not "is the text any good"). So today, production has
   **zero automated QC on burned-in video titling text** — not truncation
   (#4 above), not legibility, not correctness against the intended copy.
   `layout_safe_box` catches only PIXEL-level clipping at a frame edge, which
   is a narrower thing than #4's "does it read as a complete thought" — a
   cleanly-dropped clause (no pixels clipped, `stackFit` just omitted it)
   would pass `layout_safe_box` and was never in `text_defects`'s scope
   either. Treat `rpd eval`'s verdict as covering #1/#2/#3(partial, via
   `layout_safe_box` framing checks)/#6 only — **not** #4, #5, or #7. This is
   a real production gap, not just a harness-documentation one; it isn't
   fixed here — see the note below before doing anything about it.
5. **Compare against the previous run's `titled.mp4`** for the same
   reference product/format, side by side. `rpd stats` gives you the run
   list; the gallery (`rpd publish`) is the easiest side-by-side view if you
   want to hand it to someone else for a second opinion.

## The production gap this surfaced (not fixed here — needs a decision)

Discovered while writing this doc, worth stating plainly rather than burying
in the checklist above: `adVisionQcService.js` (both repos, byte-synced) has
carried, since the video vision-QC path was added, a `text_defects` category
whose instruction explicitly excludes the ad's own burned-in caption/
headline/CTA/rating — deferring that to "a separate system." No such system
exists in either repo. **Production ships video ads today with no automated
check at all on whether the burned-in title text is legible, complete, or
correct** — the exact "truncation error" class this doc defines has zero
production QC coverage, not just an RPD-harness-checklist gap.

This is a real gap in a live, money-critical, cross-repo-vendored QC prompt
— not something to patch reflexively from an RPD-harness documentation pass.
Fixing it for real means deciding: does the fix belong in
`adVisionQcService.js`'s existing `text_defects`/`layout_safe_box` categories
(scope creep on categories that explicitly disclaim this today), a new fifth
category, or a genuinely separate lighter-weight check (a text-only pass
doesn't need the full vision call this rubric already makes)? Any of those
needs the same vendoring discipline this repo already applies everywhere
else (edit both repos' copies together, re-probe cost, revert-prove) and
should go through the same review this repo puts every other money/QC
change through — flagged here so it isn't lost, not decided unilaterally by
this doc.

## Turning this into an automated job (not done — here's where it would go)

`scripts/rpd/loop/nightly.sh` already runs a bounded batch every night, grades
it (vision-QC), publishes it, and appends a `LEARNINGS.md` row — it's the
natural place a titling-regression job would live if this is ever automated:
point `scripts/rpd/loop/nightly-spec.json` at the reference spec above with
`titling.enabled: true`, and extend the grading step to check the classes
`rpd eval`'s rubric doesn't cover (#2, #3, #7 — likely a small additional
script comparing geometry/frame hashes or brand-token values against a
recorded baseline, not a vision call). Deliberately not built now — this
file exists so that work doesn't have to start from a blank page later.
