# 2026-08-20 — Five video-titling defects, Marine Layer 2 (branch `fix/video-titling-defects-marine-layer2`)

Owner-reported by eye on shipped frames from `run_1787174963435_ff67021e` (Marine Layer 2,
"Custom Cut & Sew Bode Puffer Jacket" — verified genuine, not cross-brand contamination: the
CatalogProduct is `source: 'shopify-direct'` off `marinelayer.com`'s own Shopify catalog, every
image on Marine Layer's own CDN, and both `product.brandId` and every `Ad.brandId` on the run agree
on "Marine Layer 2". Not a P0.). Two prior sessions attempted this and both died on spend limits
with **zero commits** — `git log d3a8fe74..origin/main` showed the branch sitting exactly at the
already-merged PR #254 commit with no unique work. All five root-caused against the **real ads**
(`buildMetaForAd` + `resolveSpec` + `resolveSlotContent` called directly against the live DB, not
just read from source) and confirmed by an actual `renderTitles()` re-render before AND after each
fix, using the already-downloaded chrome-headless-shell + already-cached base plates (zero Atlas
spend, zero upload, zero DB write — same harness pattern as PR #239/#250/#254).

## 1 — Two proof badges stacked (`pmax_video_16_9`, also present on `feed`/`square`)

**Root cause:** `services/metaCascadeConfig.js`'s `deliveryLine` cascade read
`input.product.badges[1]` — the SECOND item of the exact same `input.product.badges` array
`badgeText` already reads `badges[0]` from (feeding the `badge` slot, "TOP RATED"). Two independent
slots, one shared source. On `landscape`/`feed`/`square` both slots hold visible for the ENTIRE
clip (single un-staged phase, neither has an `exitAtSec`), so both print simultaneously — on
`vertical` they happen not to visually collide because `badge` is scoped to the `hook` phase
(exits 2.4s) and `deliveryLine` to `close` (enters 5.4s+), but the redundant SECOND badge-shaped
claim ("Best seller") is minted there too, just at a different moment.

This was a known, half-fixed defect, not a new one: `slotRenderers.jsx`'s own `DeliverySlot`
component already carries a comment quoting the owner — *"I am seeing the shipping car show back
up"* — and a `DELIVERY_CLAIM` regex that suppresses the TRUCK ICON when the bound text doesn't
read as a shipping claim (which "Best seller"/"Top rated"/"New Arrival" never do). That fix
silenced the icon but left the naked TEXT printing next to the CTA — a second undifferentiated
merchandising claim, indistinguishable in treatment from the real `badge` slot on video, and the
"double badge" defect the owner reported.

**Fix:** `deliveryLine: []` (was `[{doc:'layoutInput', path:'input.product.badges[1]'}]`) — this
slot is documented (its own header comment, six lines above) as a shipping reassurance with
**no** genuine delivery/shipping data source anywhere in `LayoutInputArtifact` today; an empty
cascade always resolves to `null`, and `Canonical.jsx` has handled the empty case cleanly since
2026-07-30 (row wrapper falls back to a lone CTA column). Confirmed via `resolveSlotContent`:
`deliveryLine` now resolves `null` on all three tested formats; `badge` ("Top rated") is the sole
surviving proof claim. Re-rendered `pmax_video_16_9`: before — "Best seller" + "TOP RATED" both
visible; after — "TOP RATED" only.

**Flagged, not fixed, as a separate follow-up:** `services/layoutInputService.js:1247` explicitly
offers the LLM "Top rated"/"Editor's pick"/"Best seller" as **filler examples** when it lacks real
signal ("prefer real signal over filler" — not a hard ban), and this exact product has
`rating: null, reviewCount: null` yet `badges: ["Top rated","Best seller","Sustainably made"]`.
PR #138 (`bf0fd397`) already fixed the CODE-LEVEL hardcoded `'Bestseller'` literal fallback for
this exact false-advertising-claim reason; the LLM can still independently invent the same class
of unearned claim into the `badges` array itself, upstream of every cascade this PR touches. Out
of scope here (prompt engineering on a different service, not a titling/render defect) — spawned
as its own task.

## 2 — Headline truncated on `pmax_video_16_9` and `meta_reels_9_16` hook phase

**Root cause — a DIFFERENT slot from the one PR #254 fixed, confirmed by direct execution, not by
re-reading #254's diff.** `productName` (PR #254's `fitProductNameToCap`) is unaffected and was
ALREADY correct on current `main` for this exact ad before this branch touched anything — verified
by calling `resolveSlotContent` directly: `meta_reels_9_16`'s close-phase productName resolves
`"Cut & Sew Bode Puffer Jacket"` (leading-word-dropped, no ellipsis) and `meta_stories_9_16`'s
resolves the full un-clamped string — both already correct. The genuinely broken slot is
`headline` (hook/proof phase, Director/layoutInput copy, catalog-title-independent):
`services/metaCascadeConfig.js`'s `headline` cascade (`ad.copy.headline` → `layoutInput.input
.copy.headline` → `brand.tagline`) has **no** shortening step analogous to `productName`'s
`cleanProductNameForDisplay`/`fitProductNameToCap`; `resolveSlotContentCore` clamps it with plain
word-safe `truncateWordSafe` — a mid-sentence tail-ellipsis. Measured live: the 45-char cascade
headline *"All the warmth of a puffer without the puff"* shipped as *"All the warmth of a
puffer…"* on `pmax_video_16_9` (real cap 32) and *"…without the…"* on `meta_reels_9_16`'s hook
phase (real cap 40) — `meta_stories_9_16` (cap 46) happened to fit and was untouched, which is
exactly the per-surface-cap-dependent signature PR #254's own write-up used to diagnose its class
of bug.

**The fix reuses existing, purpose-built machinery instead of inventing new shortening logic for
prose that isn't `[modifiers][noun]`-shaped.** `services/videoHeadlineService.js` already exists
to differentiate PMax funnel-stage headlines by SELECTING among Director-written candidates
(`copy.headline`/`.subheadline`/`.eyebrow` across every concept) that FIT a budget — "never
truncate, never fabricate" is its own stated contract, and the owner directive behind its
existence is explicit: *"Let's let the director make the call, it knows what the goal is... it has
a lot to choose from."* It was previously invoked ONLY when `ad.funnelStage` was set (staged
retitles), using its own coarse, per-**canvas-format** `HEADLINE_CHAR_BUDGET` estimate (documented
in its own header as "NOT a pixel-measured value... should be validated"). The unstaged/master ad
— which is what all five reported defects are on — never got this treatment at all.

`services/brandScriptExecutor.js`'s funnel-copy block now runs unconditionally (not gated on
`ad?.funnelStage`): it computes the REAL render-time cap via `deriveCharCap('headline', {format,
platformFormat, canvasWidth})` (the same width/safe-zone-aware model `Canonical.jsx` uses to paint,
tighter and more accurate than videoHeadlineService's own table), and only when the cascade
headline does not fit that real cap (or a funnel stage wants differentiation) does it fetch
candidates and pick the first one that fits the REAL cap — falling back to the untouched cascade
headline (and its existing word-safe clamp, the true last resort) when nothing fits better.
Byte-identical when the cascade headline already fits — confirmed `meta_stories_9_16` is
untouched. Re-rendered `pmax_video_16_9`/`meta_reels_9_16`: both now print a complete alternate
headline, *"Quilted for Real Warmth"* (23 chars, fits every tested cap with room to spare), no
ellipsis anywhere.

## 3 — Mismatched quote marks (`"…lightweight'`)

**Source data is clean, traced to individual codepoints.** `LayoutInputArtifact.input.social_proof
.primary_quote.text`/`.snippet` are both plain ASCII with zero embedded quote characters at either
end (checked with `Array.from(s).map(c => c.codePointAt(0))`). `slotRenderers.jsx`'s `quoteWrap`
template literal is also byte-correct — both wrap characters are U+201C/U+201D, confirmed by
codepoint inspection of the actual file (not misread in an editor/terminal font), and `git log
-L294,294` shows that line has never changed since the file's original 2026-07-21 commit.

**The render still reproduces a mismatched pair (open proper double, close single) on a completely
fresh render (cleared `remotion/node_modules/.cache`, rebuilt the webpack bundle from cold — same
byte-identical output).** Chased hard before concluding the exact mechanism isn't cheaply
findable: isolated the brand's real custom font "Seriously Nostalgic" (both the Cloudinary
original and the render's own locally-cached woff2) in a standalone page driven by the SAME
chrome-headless-shell binary the real render uses — U+201C/U+201D render as a correctly matched
pair at every tested size (20-72px) and with the exact `layered`/`soft` on-light text-shadow halo
this role can carry. None of font glyph coverage, render-engine identity, font size, or shadow-halo
bleed reproduces the defect in isolation, and a stale build cache is ruled out by the cold-bundle
re-render. Whatever the actual interaction is (something specific to the full `-webkit-box`/
`WebkitLineClamp` DOM+CSS context this composition applies, not replicated by any isolated test),
it wasn't pinned down with confidence in the time available.

**Fix, deliberately not contingent on understanding the mechanism:** wrap with straight ASCII
quotes (`"`) instead of curly typographic ones. Both ends are now the literal same character, so a
mismatch is structurally impossible regardless of cause — and Basic Latin is guaranteed present in
every font a brand could ever ingest, unlike the General Punctuation block curly quotes live in.
Slightly less "editorial" than a curly pair; correctness over curliness. Re-rendered both surfaces:
matching `"…"` on both ends, confirmed at high zoom.

## 4 — Legibility on `meta_reels_9_16` (white serif over a busy mountain/rock texture)

**Video is not missing static's ink mechanism — it already has a strictly more rigorous one.**
Static's `sampleSafeBoxLuminance`/`textInkDirective` (`directImageRenderService.js`) is one mean-
luminance sample over one box, feeding a single ink-polarity sentence into the image-gen prompt —
no scrim decision, no per-element sampling. Video's `Canonical.jsx` already does real WCAG
contrast-ratio ink selection PER GROUP (not one whole-clip vote unless plate data is missing),
already computes a `marginal` flag (best achievable contrast still under 4.5:1) and already
escalates to the strongest authored ('layered') shadow when marginal — none of this needed adding.

**The actual gap, precisely located:** `plateIntelService`'s `busy` (local luma variance — texture,
independent of mean brightness) is computed for every band and was fed to KEEP-OUT scoring only;
the ink/shadow decision site (`Canonical.jsx`, `bandStateFor(...).lum`) discarded `.busy` entirely.
So a band can score an excellent MEAN contrast ratio (measured live on the productName band:
`best=10.87:1`, nowhere near marginal) while still being genuinely hard to read in patches because
the plate is texturally busy (measured `busy=0.76`, well into "detail-heavy" — a rocky mountain
face). Mean contrast is blind to that.

**Fix:** `reinforceShadow` now also fires when `busy` exceeds `BUSY_SHADOW_THRESHOLD` (0.45 — a
first empirically-grounded estimate from this one incident, same evidentiary status as
videoHeadlineService's own `LANDSCAPE_HEADLINE_BUDGET_CHARS`, explicitly flagged as such, not a
pixel-swept constant). Deliberately escalates to the SAME already-authored 'layered' shadow the
marginal path uses — **never a scrim** (the file's own header comment records the owner ruling
scrims out) and **never a stronger halo** than what shipped after "the halo is way too much" was
already fixed once. Re-rendered `meta_reels_9_16`: the close-phase productName band now logs
`busy=0.76 ... BUSY -> layered shadow` (previously no escalation at all on that exact band, same
lum/contrast numbers, confirmed against the pre-fix render's log). **Owner attention warranted**:
this makes the layered shadow fire on more renders than before (any busy band, not only
contrast-marginal ones) — worth watching for the "halo" complaint recurring on other brands/plates,
which is exactly why the threshold and its provisional status are called out this explicitly rather
than buried in a comment nobody reads.

## 5 — Typeface split, video serif vs. static sans (investigated, NOT changed)

**Marine Layer 2 is not an "empty" brand** — it has a real custom font ingested from its own
website, "Seriously Nostalgic" (`Brand.customFonts[0]`, `source: 'website'`, ingested the same day
as this session). Video's `buildFontLadders`/`resolveBrandFonts` correctly resolves and renders
this real file for heading/body/quote — the Didone-ish serif look in every video surface of this
run IS the brand's own actual typeface, not a fallback. This is deliberate, correct behavior, not a
bug, and this PR does not touch it.

**What would actually diverge, if a static ad were generated for this same brand (not testable in
this run — it minted video only):** `services/directImageRenderService.js`'s
`typefaceDirectiveForBrand` also checks `customFonts[0]` and would find the same "Seriously
Nostalgic" family, but classifies serif-vs-sans by testing the family NAME against
`FONT_SERIF_HINTS` — a keyword regex (`serif|playfair|lora|cormorant|garamond|...|cinzel`, no
catch-all). "Seriously Nostalgic" matches none of those keywords (checked char-by-char: "serio…"
vs "serif…" diverge at the 5th character), so the static prompt would instruct **sans-serif** for
a font that is visually, unambiguously serif — a genuine classification bug, not a deliberate
per-template choice.

**Deliberately not fixed, per the brief's own instruction to flag rather than silently unify.** The
static image-gen prompt pipeline is documented elsewhere in this repo as unusually fragile (PR #61's
full rollback of a "hardened" video prompt is the standing precedent for how badly a well-intentioned
prompt edit can regress this class of pipeline), this file is entirely outside `remotion/`, and
widening `FONT_SERIF_HINTS` (or replacing name-guessing with an actual font-shape classification) is
a cross-brand change to a different, actively-tuned pipeline — not a "titling" fix. Flagged as its
own follow-up task rather than patched inline.

## Also flagged, out of scope, found by a prior investigation session in the same scratchpad
(`scratchpad/mla_final/findings.json`) and independently spot-checked here — real, but not
titling/render defects, so not touched by this PR:
- **Hallucinated fake e-commerce UI baked into the Veo/Omni video PLATE itself** (garbled "Cut &
  Sew *Fakflart Bufeh*" store-header text, visible ~0-1s on the vertical master and its
  derivatives) — a generation-time defect in the underlying footage, not a Remotion overlay bug.
  Reproduced directly on a fresh re-render (`reels_after_hook.png`, t=1.5s).
- **A hard cut to a visibly wrong garment colour/trim** in the final ~1s of the `pmax_video_16_9`
  master (charcoal/red-piping profile shot vs. the true navy/multi-colour-stripe jacket seen
  everywhere else in the same clip) — also reproduced on a fresh re-render.
- **Two headlines rendering simultaneously on CONVERSION-stage 9:16 crops** (a stale hook headline
  from consideration copy overlapping the close-phase productName) — not reproduced against the
  awareness/master ads this PR's fixes were verified on; would need its own investigation against
  the staged rows specifically.

## Verification

Re-rendered `pmax_video_16_9` and `meta_reels_9_16` before/after every fix via `renderTitles()`
directly (same harness pattern as PR #239/#250/#254 — `basePlateCropService.resolveBasePlateVideoUrl`
against the already-cached plate, `REMOTION_BROWSER_EXECUTABLE` pointed at the already-downloaded
chrome-headless-shell): zero Atlas spend, zero Cloudinary upload, zero DB write. `#250`'s rating row
(absent here — this product has no rating data — confirmed still cleanly absent, not sliced),
`#239`'s quote opening clause, and `#254`'s un-ellipsised productName all confirmed unregressed on
every re-render.

`npm run lint`: clean. Full suite (`npm test`, 174 scripts): see PR for the run this session.d entry
accompanies.
