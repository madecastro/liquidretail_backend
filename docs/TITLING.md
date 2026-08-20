# Titling Engine

## 0) READ FIRST — the canvas engine is DISABLED (verified 2026-07-29)

**Remotion is the only titling engine that runs.** `resolveTitlingEngine`
(`services/brandScriptExecutor.js:797-806`) returns `{ engine: 'remotion', source:
'canvas-disabled' }` **unconditionally**. The cascade described in §1 below is the
code at `:808-823`, which sits inside a `/* … */` block.

Consequences that have already cost real time:

- `TITLING_ENGINE` and `Brand.videoSettings.titlingEngine` are **not read by the
  render path** — `resolveTitlingEngine` returns before reaching them. Every other
  reader was grepped; the full picture is worse than "inert":
  - `validateVideoSettings` (`atlasVideoService.js:1644`) still **accepts** `'canvas'`,
    so it persists.
  - `routes/brand.js:1362` and `:2308` compute
    `videoSettings?.titlingEngine || process.env.TITLING_ENGINE || 'remotion'` and
    return it to the SPA, which renders it as a badge
    (`frontend/app/src/titling/TitleStudioCard.tsx:483-484`, "engine: …").
  - So a brand with `titlingEngine: 'canvas'` shows **"engine: canvas"** in the UI
    while every render uses remotion. The setting is not just ineffective, it is
    **actively misreported**. Fix the badge or the resolver together — not one alone.
- A brand's custom `styleScript*` fields do **not** take effect. `:804` logs a line
  saying so per render.
- Everything under `services/brandScripts/*.script.js`, `brandScriptRunner.child.js`,
  and the `sharp.resize(fit:'cover')` calls at `brandScriptExecutor.js:387-388` and
  `:488-489` is on the dead path. Do not plan framing/crop work against them —
  video framing lives in `remotion/components/BasePlate.jsx:18,28` (`objectFit:
  'cover'`).
- **Security:** `POST /api/brand/:id/preview-script` forces `engine='canvas'` and so
  bypasses this kill-switch — that is the only route reaching the
  `vm.compileFunction` sandbox-escape in `brandScriptRunner.child.js:139`. See
  `ARCHITECTURE_REVIEW.md` GEN-1.

§1 is retained as a description of the cascade to restore *if* canvas is re-enabled.
Treat it as design intent, not current behaviour.

## 1) Architecture overview (the cascade AS COMMENTED OUT — not live)

Dual-engine dispatch in `services/brandScriptExecutor.js`:

- `resolveTitlingEngine(brand, ad)`: custom per-format script (styleScript*/styleScriptVertical etc.) forces 'canvas'; else Brand.videoSettings.titlingEngine > TITLING_ENGINE env > default **'remotion'**. **← NOT LIVE, see §0.**
- 'canvas' path: `renderBrandScriptAndSave` → `resolveBrandRenderer` → `renderBrandScript` (child process) → upload + Ad.renderUrl. **← unreachable except via preview-script.**
- 'remotion' path: `renderWithRemotionAndSave` → `resolveSpecForBrand` + `buildBrandTokens` → `renderTitles` (services/remotionRenderService.js) → upload + Ad.renderUrl. **← the only live path.**

Remotion render pipeline (ad.veoVideoUrl → Ad.renderUrl):

- `warmup()` at boot: `getServeUrl()` (bundle once via @remotion/bundler on remotion/index.jsx), `ensureBrowserReady()`, `getAssetServer()`.
- `renderTitles({videoUrl, meta, spec, tokens, format, placementMode?, brand?})`: enqueue (concurrency-1 queue), per-job dir under os.tmpdir()/remotion_assets.
- Download plate (axios + 45s inactivity watchdog) or copy local; probe fps/duration/dims via @remotion/media-parser (clamped 12..60 fps).
- Placement mode (see §4): `canonical` skips plate scan (`plateHints: null`); `content` runs `analyzePlate` (plateIntelService.js).
- Logo download to job dir (served via loopback).
- `selectComposition` + `renderMedia` (h264/aac) with inputProps containing plateHints, normalized spec, tokens (fonts rewritten to asset-server URLs).
- Return {finalPath, tempDir, timings}; caller uploads and rmdir. Timings include `placementMode`.
- Stills fast lane: `enqueueStill` (separate tail) for `renderPreview` (scale=0.5, no audio, optional stillTimesSec via renderStill).

Loopback asset server (services/remotionRenderService.js): http on 127.0.0.1, serves /jobs/<jobId>/ (plate/logo), /fonts/ (from FONT_CACHE_DIR — google + custom website faces) and /libfonts/ (from fontLoader FONTS_DIR — the 48 curated library faces); full Range support, CORS * for fonts INCLUDING on the 404 branch. The two font dirs need two routes: a library-match resolves into FONTS_DIR, and mapping only /fonts/ meant every library-match 404'd, which cancelRender turned into a fatal render failure (see scripts/verifyFontServing.js).

## 2) The Title Style Spec

Full schema contract + validator in `services/titleSpecValidator.js` (v1). Declarative JSON rendered by canonical compositions. Shipped canonicals are presets (remotion/presets/*.json); brands override via Brand.titleStyleSpec or pin via titleStylePreset.

CTA default: every shipped preset ships its `cta` slot `visible: false` — all current placements (meta_feed_*, meta_reels/stories, pmax_16_9) render the platform's own CTA button, so a baked-in chip duplicates chrome. The slot keeps its timing/positioning; re-enable per brand (spec PATCH / playground) for channels without native CTAs.

```json
{
  "version": 1,
  "phases": [ { "key": "hook", "startSec": 0, "endSec": 3 }, ... ],  // 1..4
  "stack": { "rowGapPct": 0.018 },
  "tokenOverrides": {
    "colors": { "primary": "#0072CE", ... },  // TOKEN_COLOR_KEYS subset
    "fonts": { "heading": { "family": "...", "weight?": 700 }, ... }
  },
  "slots": [ {
    "key": "headline",  // SLOT_KEYS
    "visible": true,
    "bind": ["headline"],  // BINDABLE_META_FIELDS order
    "brandMode": "keep"|"hide",
    "brandModeBind": ["brandTagline"],
    "phase": "hook",  // must exist in phases
    "position": {
      "anchor": "top"|"upperThird"|"center"|"lowerThird"|"bottom",
      "align": "left"|"center"|"right",
      "offsetX": 0, "offsetY": 0,  // -0.25..0.25
      "maxWidthPct": 0.85,  // 0.2..1
      "row": null  // side-by-side when shared
    },
    "timing": {
      "enterAtSec": 0.33,
      "exitAtSec": null,  // null=hold to end
      "enterDurationSec": 0.4,
      "exitDurationSec": 0.4
    },
    "transition": {
      "type": "fade"|"slide"|"pop"|"wipe"|"none",
      "direction": "up"|"down"|"left"|"right",
      "spring": { "damping": 200, "stiffness": 100, "mass": 1 } | null
    },
    "treatment": {
      "scrim": "frosted"|"solid"|"card"|"none",
      "scrimOpacity": 0.7,  // 0..1
      "scrimColorToken": "scrim",
      "shadow": "layered"|"soft"|"none",
      "casing": "upper"|"title"|"none",
      "fontRole": "heading"|"body"|"quote",
      "weight": 700,  // 100..900
      "sizeScale": 1,  // 0.5..2
      "maxLines": 2,  // 1..4
      "trackingPx": 0,  // 0..8
      "colorToken": "textPrimary",  // TOKEN_COLOR_KEYS
      "accent": { "type": "underline"|"bar"|"none", "colorToken": "accent", "animate": true },
      "logoMode": "auto"|"text"  // brandPill only
    }
  } ]
}
```

Validation (`validateTitleSpec`, `validateTitleStyleSpecDoc`): normalizes optionals to defaults; rejects unknowns/duplicates/out-of-range; phases 1..4, slots <= SLOT_KEYS, times 0..MAX_CLIP_SEC (15). Treatment fallbacks: `scrim ?? 'none'`, `shadow ?? 'layered'` (no-scrim standard).

Resolution (`services/titleSpecService.js` `resolveSpecForBrand`):
- brand.titleStyleSpec[format] (validated) → 'brand'
- else brand.titleStylePreset → loadPresetFile(name) → byFormat[format] (validated) → 'preset:<name>'
- else canonical (remotion/presets/canonical.json) → 'canonical'
- Throws only on canonical failure. `loadPresetFile` + `clearPresetCache`.

Duration time-scaling: specs are authored against their own extent (max `phases[].endSec`, nominally 8s). At render, `specTimeScale` (remotion/lib/timing.js) compresses every enter/exit time proportionally when the probed plate is shorter (6s segment → ×0.75 — the CTA still lands), and entrances are hard-clamped inside the clip; longer plates keep authored pacing and hold-to-end slots hold longer. Positions are clamped to per-format safe zones in the composition (remotion/lib/safeZones.js).

`vertical` is the shared canvas-format fallback — top **14%**, bottom **35%**, sides **7.5%** (Meta Reels community-consensus clear zones; official Meta guidance is qualitative + Ads Manager guardrail; disclaimer rule is bottom 40%). **Both Meta 9:16 surfaces now have their OWN zone, resolved from `platformFormat` via `resolveSafeZoneKey`, not this shared one** (2026-08-11 — see `PMAX_VIDEO_SAFE_ZONE_KEY` in `safeZones.js`): `meta_stories_9_16` → `stories` (top/bottom **14%/14%** — Stories has no persistent right-edge rail); `meta_reels_9_16` → `reels` (top/bottom **14%/35%**, same as `vertical`, but right **15%** to clear the IG action rail — like/comment/share/audio-disc). Bottom-anchored vertical stacks end at ~65% height on `reels`/`vertical`, ~86% on `stories` — intended, and the reason a keep-out-shifted group has much less vertical room on Reels than on Stories.

**Accepted caveats (vertical safe zones):**
- (a) Vertical `upperThird` (0.135) now clamps to `safe.top` (0.14), so `top` and `upperThird` anchors coincide on vertical.
- (b) `lowerThird`/`bottom` stacks are edge-clamped, not height-clamped — a multi-slot stack taller than its box CAN still overflow past the top or bottom edge of that box. **What changed 2026-08-19: which end drops is now guaranteed, not incidental.** `stackContainerStyle`'s `lowerThird`/`bottom` anchors use CSS `safe flex-end` (Box Alignment L3) instead of bare `flex-end`, so on overflow the box falls back to start-alignment and the TRAILING content clips — never the OPENING. Before this, a `meta_reels_9_16` quote that needed one more wrapped line than its Stories sibling (right:0.15 narrows the box to 0.775W vs Stories' 0.85W) silently lost its first clause: `justifyContent:'flex-end'` pushed the whole group toward the floor and the excess overflowed PAST THE TOP, where `overflow:hidden` clipped it — measured on a delivered Vuori ad, `scripts/verifyReelsSafeZone.mjs` section G. Paired with a char-cap fix (section H, same file): `slotContent.js`'s width model now bounds `usableWidthPx` by the surface's own resolved safe-zone width when it's narrower than the canvas format's shared default, instead of `maxWidthPct × canvasWidth` alone — inert for `vertical`/`stories`, tightens `reels`/`verticalYt`/`landscapeYt`/`squareYt`/`pmax_video_*`.

**Follow-up, 2026-08-19: "never the opening" was not "never clips through an element."** Fixing WHICH end drops did not fix WHETHER the box is smaller than a single whole element — on a delivered Vuori `meta_reels_9_16`, the proof group's `rating` slot (5-star row + "4.6/5" + review count) landed exactly on that boundary: the star row sliced through its own middle, the score cut mid-glyph, the review-count line vanished entirely, with ~40% of the frame left as dead space below the cut. `remotion/lib/stackFit.js` closes this: before paint, `planGroupFit` estimates the group's real stack height from its resolved content (the vertical-axis twin of `deriveCharCap`'s horizontal model) against the box `remotion/lib/safeZones.js` `resolveGroupBoxPx` affords for its effective (post-keep-out) anchor, and degrades in order — (1) shrink every slot in the group together, bounded (`SHRINK_FLOOR`, 0.82); (2) drop the `rating` slot's own trailing reviews line; (3) drop whole trailing rows, working backward, protecting the group's HERO row (the first row with real content — not literally the first array slot, since `proof`'s `headline` claim-restatement sits at `visibleWhenEmpty:"quote"` and can occupy either position depending on which one is gated). `overflow:hidden` remains as a last-resort safety net, not the enforcement mechanism — it should essentially never fire once a group has been sized to its box. Pinned by `scripts/verifyReelsOverflowSafety.mjs`, including the exact shipped-incident numbers (section E) and the same mechanism exercised against `verticalYt`/`landscapeYt`/`squareYt` (section F) — the fix lives in the anchor/box-resolution layer shared by every surface, not a Reels-only branch. Operators should still preview with the frontend guardrail toggle — the guarantee is "never a partial element," not "never drops anything."

**Follow-up, 2026-08-19: the `productName` (close phase) slot itself was still clamping — a shorter SOURCE string beats a smarter clamp.** Same Vuori jacket: the close-phase headline shipped as `"Women's Vuori Vintage Oversized…"` on Reels and `"Women's Vuori Vintage Oversized Denim…"` on Stories — different cutoffs for the identical source string, the tell that `deriveCharCap` (width-driven) was doing the cutting, not a fixed character cap. `truncateWordSafe` was already word-safe (never mid-word); the actual defect was upstream — nothing had ever shortened a still-45-character catalog title before the cap fired. The fix is in `services/brandScriptExecutor.js`'s `cleanProductNameForDisplay(name, brandName)`, applied once at the single point every video surface's cascade result already funnels through (`buildMetaForAd`, regardless of which cascade source won — `catalogProduct.title` / `layoutInput.input.product.name` / `ad.copy.productName`): strip a leading merchandising gender/audience qualifier (plural/possessive forms only — `Women's`, `Kids`, `Mens`, `Unisex`, … — bare singular `Men`/`Boy` are excluded, they collide with ordinary English like "Men in Black"), then strip a leading token-for-token match of the ad's own brand name (word-by-word prefix match, not a single substring — so a demo/test tenant literally named `"Vuori 2"` still strips the catalog's plain `"Vuori "` prefix). Both steps are guarded to never fire where the token is load-bearing (a brand literally named `"Women's Health"`) and never empty the string. Result for the incident string: `"Vintage Oversized Denim Jacket"` — fits Reels' and Stories' caps outright, no ellipsis. Where even that still doesn't fit a tighter box (`squareYt`/`pmax_video_1_1`'s 1-line cap), `remotion/lib/slotContent.js`'s new `fitProductNameToCap` (scoped to the `productName` slot only — every other slot keeps the plain tail-safe `truncateWordSafe`, so the quote's opening-clause guarantee above is untouched) drops leading modifier words one at a time — `"Oversized Denim Jacket"`, then `"Denim Jacket"`, … — never the trailing noun that actually identifies the product, and never emits an ellipsis while any whole-word phrase still fits. A tail-cut ellipsis remains the true last resort only when no whole-word candidate fits at all. Pinned by `scripts/verifyTitleSpecResolution.js` (G9/G9b/G10 — the cleaning function's brand/gender guards, plus the exact reported string end-to-end) and `scripts/verifyFormatAwareCharCaps.mjs` (section J — the Reels-vs-Stories cap delta and the noun-preserving fitter, including proof the quote slot is unaffected).

**Follow-up, 2026-08-20 (Marine Layer 2, `run_1787174963435_ff67021e`) — four more defects, same
neighborhood, full write-up `session.d/2026-08-20_five-video-titling-defects-marine-layer-2.md`.**
(1) `deliveryLine`'s cascade read `input.product.badges[1]` — the same array `badgeText` reads
`badges[0]` from — so a second undifferentiated merchandising claim ("Best seller") printed beside
the CTA, redundant with (and on `landscape`/`feed`/`square`, simultaneously visible next to) the
real `badge` slot's "TOP RATED". Fixed to `deliveryLine: []` — this slot has no genuine
delivery/shipping data source today; empty always resolves `null`, which `Canonical.jsx` has
handled cleanly since 2026-07-30. (2) The `headline` slot (Director/layoutInput prose, NOT
`productName` — that slot was already correct here via the fix above) has no shortening step and
clamped with a mid-sentence tail-ellipsis on any surface whose real cap was smaller than the
cascade string. Fixed by running `services/videoHeadlineService.js`'s existing "select a candidate
that fits, never truncate" machinery **unconditionally** (previously gated on `ad.funnelStage`,
i.e. only for staged retitles) and against the REAL render-time `deriveCharCap` result, not
videoHeadlineService's own coarser per-canvas-format estimate. (3) A burned-in quote opened with a
proper curly `“` and closed with a bare apostrophe-shaped mark on a totally clean render (fresh
webpack bundle, source data and font file both verified byte-correct in isolation) — the exact
mechanism wasn't pinned down despite real effort, so `slotRenderers.jsx`'s `quoteWrap` now wraps
with straight ASCII quotes instead of curly ones: both ends are the same character, so a mismatch
is structurally impossible regardless of cause. (4) `meta_reels_9_16` productName was hard to read
over a texturally busy (not merely dark) mountain plate despite a confidently-non-marginal mean
contrast ratio — `plateIntelService`'s `busy` signal was already computed per band but only ever
fed to keep-out scoring, never to the shadow decision. `Canonical.jsx`'s `reinforceShadow` now also
escalates to the same already-authored `layered` shadow (never a scrim, never a stronger halo — see
the no-scrim comment above `inkForBand` and the "halo is way too much" history right below it) when
`busy > 0.45`, a first empirically-grounded threshold from this one incident, same status as
`videoHeadlineService`'s own `LANDSCAPE_HEADLINE_BUDGET_CHARS`. **Investigated and deliberately left
alone:** a fifth reported defect (video renders the brand's real custom-ingested "Seriously
Nostalgic" serif; a static ad for the same brand would likely render sans, because
`directImageRenderService.js`'s `FONT_SERIF_HINTS` keyword regex doesn't recognize that font's name
as serif) is a classification bug in the STATIC prompt pipeline, not a titling/render defect —
flagged as its own follow-up rather than patched inline or silently unified with video.

Constants exported: SLOT_KEYS, BINDABLE_META_FIELDS, TOKEN_COLOR_KEYS, FONT_ROLES, ANCHORS, ALIGNS, TRANSITIONS, SCRIMS, SHADOWS, CASINGS, FORMATS, DEFAULT_BIND, clamp.

## 2b) Formats — one canonical template per format and size

Four titling formats. `services/titleSpecValidator.js` `FORMATS` is the **single source
of truth**; import it rather than re-listing (it was duplicated as a literal in five
places in `routes/brand.js`, which is exactly how the square bug nearly shipped twice).

| format | composition | canvas | platformFormats served |
|---|---|---|---|
| `vertical` | `CanonicalVertical` | 1080x1920 | `meta_reels_9_16`, `meta_stories_9_16` |
| `feed` | `CanonicalFeed` | 1080x1350 | `meta_feed_4_5` |
| `square` | `CanonicalSquare` | 1080x1080 | `meta_feed_1_1` |
| `landscape` | `CanonicalLandscape` | 1920x1080 | `pmax_16_9` |

**`square` was added 2026-07-29, and it fixed a live bug.** `classifyFormat` was a
three-way branch ending in `return 'feed'`, so a 1:1 ad matched neither vertical nor
landscape and fell through to `feed` — titled in `CanonicalFeed` at 1080x1350. Because
`BasePlate` uses `objectFit:'cover'`, the square ad was centre-cropped into a 4:5 frame
and delivered at 4:5 while its Ad row still said `aspectRatio: '1:1'`. Nothing threw.
`meta_feed_1_1` declares `kinds: ['image','video']` and `AI_VEO_FEED=true`, so this was
reachable, not theoretical.

Square's canonical is feed's stack with **every `maxLines` clamped to 1**, which is the
house response to a height-constrained canvas (`landscape` does the same). Budget:
square has `1080 - 0.54*1080 - 0.06*1080` = **432px** of `lowerThird` stack room versus
feed's **540px**. Slot coverage is otherwise identical to feed — nothing is dropped.
Square deliberately shares feed's `styleScript` field and safe-zone padding: same 1080
width, same surface, only the height differs.

### Adding a format is EIGHT registries, not one

`scripts/verifyTitlingFormats.js` (49 offline checks, no DB/network) asserts every one
of them and fails loudly if a format is half-added. Run it after any format change.

1. `services/titleSpecValidator.js` `FORMATS`
2. `remotion/presets/canonical.json` `byFormat.<format>` — **omitting this makes
   `titleSpecService.resolveSpec` THROW** at its guaranteed-floor step
3. `remotion/Root.jsx` — a `<Composition>` with matching `defaultProps.format`
4. `services/remotionRenderService.js` `COMPOSITION_BY_FORMAT`
5. `remotion/lib/safeZones.js` `SAFE_ZONES`
6. `remotion/components/slotRenderers.jsx` `BASE_SIZE` column **or** a
   `SIZE_FORMAT_ALIAS` entry — miss both and `baseSize()` returns its `?? 24` default
   for every slot, i.e. wrong output rather than a failure
7. `services/brandScriptExecutor.js` `BRAND_SCRIPT_FIELD` + a `classifyFormat` branch
8. `routes/brand.js` `ASPECT_BY_TITLING_FORMAT` and `DIMS_BY_FORMAT`

The harness's most valuable check is **B3**: for every `PLATFORM_FORMATS` entry it
asserts `deliveryDims`' aspect matches the composition the ad will actually render in.
That is the assertion the original bug could not survive.

Brand presets under `remotion/presets/` other than `canonical.json` are **not** required
to carry every format — `resolveSpec` warns and falls back to canonical for a missing
one. The six brand presets currently have no `square`, so square ads render the
canonical square spec until authored.

## 3) Brand token pipeline

`services/titleSpecService.js` `buildBrandTokens(brand, {layoutInputBrand, specFontOverrides})` → {colors, fonts}.

Colors (first hit):
- Brand.styleTheme (canvas-vocabulary aliases first): primaryColor/secondaryColor/accentColor, ctaBgColor/ctaBg, ctaTextColor/ctaText, scrimColor, textPrimary/textSecondary, starColor/accentGold, badgeBgColor/badgeBg/calloutBgColor, badgeTextColor/badgeText, promoBgColor/promoBg, promoTextColor/promoText, textOnLight, textSecondaryOnLight.
- Brand.*Color fields.
- layoutInputBrand.*_color.
- Hard defaults (primary #0B0F14, accent #F5B70A, etc.). textOnLight/textSecondaryOnLight for plate contrast flips.

Fonts (`services/fontResolverService.js`) — TWO mechanisms, do not conflate:

**A. `buildFontLadders(brand)` — WHICH families to try, in order. Pure, no network.**
Per-role ordered list of `[family, requireExact]`. `requireExact` means the tier is
rejected if the family resolves only to a library SUBSTITUTION — a tone-matched
lookalike is not the brand's typeface and must not outrank a curated choice.

heading/body: `overrides` > `ownFace`* > `scannedPromoted`* > `metaAds.heading`(high-conf)*
 > `theme.<role>FontFamily` > curated `fontFamily` > tailwind > websiteUsage
 > `metaAds.heading`(any conf) > sharedFamily.  (* = exact-only)
quote: `overrides` > `theme.quoteFontFamily` > websiteUsage.quote > sharedFamily.
Quote never receives a brand/ad face — serifFontFamily is a deliberate pairing.

TIER ORDER IS LOAD-BEARING. Two cases pin it in `scripts/verifyFontLadder.js`:
- Pelagic: scanned `Oswald` (real Google family) must beat theme alias `Montserrat`.
- AllBirds: `Self Modern` is licence-held → nothing to serve → curated `DM Sans` wins.
Theme-pairing guard: if the curated theme already NAMES the scanned/ad face, no
promotion happens — the pairing already accounts for it (Camelback: fontFamily
`Lora` + theme serif `Lora` must not collapse a sans/serif pairing to one serif).

**B. `resolveFamily(family)` — ONE family to a file.**
1. `matchCustomFont` → `resolveCustomFont` (brand's own ingested face, Cloudinary
   raw mirror → FONT_CACHE_DIR; `needsLicense` holds and the commercial gate
   respected). `exact: true`.
2. `resolveGoogleFamily` (css2, `pickLatinFace` for the U+0000-00FF subset,
   CACHE_VER bust, download woff2). `exact: true`.
3. `resolveLibraryMatch` → `LIBRARY_SUBSTITUTIONS` → closest face in the
   **48-face** `fontLoader.FONTS` library. **`exact: false`** — an approximation.
   Logged 🔤 unless the caller passed `quiet` (an exact-only tier that will reject
   it — logging a face that never reached the render is worse than not logging).
`resolveLadder` walks the ladder with this, returns the first acceptable entry, and
falls back to the best substitution any tier produced if nothing resolves exactly.

Library (`services/fontLoader.js`): **48 faces**, downloaded at boot from the
google/fonts GitHub raw mirror (OFL only — `GH_BASE` hardcodes `ofl/`). This list is
the CEILING on match quality: a substitution can only ever name a face that exists
here. Grown 16 → 48 on 2026-08-04 to cover classes that previously had no target at
all (slab, mono, fashion didone, casual script, wide display).
Guards: `BODY_UNSAFE_FACES` (display/script never on paragraph copy; the remap
preserves serif-vs-sans by inspecting the CHOSEN face, not the requested name) and
`LIBRARY_SERIF_FACES` (must stay aligned with `SERIF_HINTS`).

Sources of a family name: website `@font-face` ingest (`brandFontIngestService` →
`Brand.customFonts`, REAL FILES) and Meta-ad identification (`metaAdsFontService` →
`Brand.metaAdsFontUsage`, a NAME ONLY — see §Brand fonts from Meta ads below).

Output per role: `{family, weight, style, url:localPath, remoteUrl, fallback,
source, exact, requestedFamily, resolvedFamily, matchReason}`.
`remotionRenderService` rewrites `url` to an asset-server URL before the browser.

### Brand fonts from Meta ads (`services/metaAdsFontService.js`)

Second font source for the common premium-DTC case where the website scan cannot
get the file: the foundry CDN 403s us, or the stack is JS-injected so no
`@font-face` is in the fetched HTML. The ads still show the typeface.

**It produces a NAME, never a file** — a raster creative embeds no font. The name
goes through ladder A above, so it is served exactly when we already hold the
family and substituted otherwise.

Creative gathering, free tiers first: persisted `Campaign.adSets[].ads[].creative
.imageUrl` → the brand's connected ad account via Graph (`resolveMetaAdsCred`) →
public Ad Library via Apify (**billable, and blank by default** —
`APIFY_ADLIB_ACTOR` must be set to enable it; the run is ledgered via
`recordFlatCost`, which no other Apify path in this repo does).
Note catalog/DPA ad sets never persist a creative URL (`metaAdsCreativeMatcher`
skips the creative fetch once a product set resolves), so the Graph tier is the
normal path for the most product-shaped campaigns, not a rare fallback.

Vision: ONE `chatCompletion` on role `'font-vision'` (→ `google/gemini-2.5-pro`),
`response_format: json_object` (never `json_schema` — 400s on Anthropic routes),
`visionImages` set to the real count so the per-image ledger surcharge is right.
Never called with zero images. A malformed verdict degrades to "identified
nothing"; it never throws and never fabricates a face.

Only `confidence: 'high'` earns the exact-only ladder tier. Persistence
(`applyMetaFontsResult`) deliberately does NOT write `fontFamily`/`fontSource` —
that field is treated repo-wide as the brand's scanned face, and a name read off a
JPEG is not that. Gated on `Brand.metaFontsIngestedAt`, stamped even on a miss so a
coverage backfill does not re-pay the vision call.

Config: `META_ADS_FONTS_ENABLED` (default true), `META_ADS_FONTS_MAX_IMAGES` (4),
`META_ADS_FONTS_MODEL`, `APIFY_ADLIB_ACTOR` (blank), `APIFY_ADLIB_COST_USD`.

### Auditing coverage

`node scripts/backfillBrandFonts.js` — report mode, no writes. Per brand it prints
the stamps AND what each role actually resolves to, because `fontIngestedAt` records
an ATTEMPT, not a success: a brand can look fully ingested and still render three
approximated faces. Verdicts: OK (all roles exact) / APPROX / APPROX-ALL / MISSING /
ERROR. `--apply` re-runs the free website scan (calling `ingestBrandFonts` directly,
NOT `enrichBrandFromUrl`, which would fire billable LLM tiers) and, only for brands
still holding no usable face, the billable meta-ads step. `--matrix` lists healthy
brands too; `--skip-meta` suppresses all spend; `--force-reingest` re-scans everyone.

## 4) Placement mode + plate intelligence

### Placement mode (`titlePlacementMode`)

Controls whether titles react to footage content or stay fully static (canonical).

| Mode | Behavior |
|------|----------|
| `canonical` (default) | **No longer skips `analyzePlate`.** Fixed 2026-08-04 — see "Plate intelligence" below for why the old `plateHints: null` behavior shipped unreadable ads. Titles still render at their authored, static positions; the scan's only effect here is feeding the global ink flip. |
| `content` | Same `analyzePlate` scan as `canonical` (scan depth from `TITLE_PLATE_SCAN`, `basic` default / `gemini` optional). Historically also meant to drive position-nudging off avoid bands, but `remotionRenderService.js` never threads the resolved mode into the composition's `inputProps` — only `plateHints` reaches `Canonical.jsx`, so today `canonical` vs `content` has no code-level effect on what gets rendered; it's still resolved/validated/echoed in responses for the brand-setting / per-request override plumbing. |

**Resolution precedence** (`resolveTitlePlacementMode` in `plateIntelService.js`):

1. Per-request `placementMode` (title-still / preview-script body)
2. `Brand.videoSettings.titlePlacementMode` (`'canonical' | 'content'`, validated by `validateVideoSettings`)
3. Default `'canonical'`

**Kill switch:** `TITLE_PLATE_SCAN=off` forces canonical behavior globally (no plate scan, regardless of request/brand).

Threaded through `renderWithRemotionAndSave` → `renderTitles` / `renderPreview`. Log lines include `placement=canonical|content`; timings/response metadata carry `placementMode` where a response object exists.

### Plate intelligence

`services/plateIntelService.js` `analyzePlate(platePath, {durationSec, isImage})` — **runs unconditionally, in both placement modes, as of 2026-08-04.** It used to fire only in `content` mode (leaving `plateHints: null` in `canonical`), but `canonical` is the default and the global ink flip (`plateIsLightGlobal` in `Canonical.jsx`) reads `plateHints` to decide light-vs-dark title ink — with hints permanently null, that flip could never fire, and a near-white studio plate shipped **white-on-white title text** in `canonical` mode (found live 2026-08-04, "this is hard to read"). The scan is now wired to legibility, not to the placement feature, so it always runs. The only thing that still skips it is the `TITLE_PLATE_SCAN=off` kill switch (scan depth otherwise 'basic' default | 'gemini' | 'off'). Never throws.

- basic: ffmpeg extract (**5 samples** — `[0.5, 1.5, .35×dur, .55×dur, .75×dur]`, clamped inside the probed duration and de-duped — or `[0]` for a still image; widened from the original 3-point grid so the hook/proof/close enter-windows of a canonical cut each land near a real sample instead of voting off a frame seconds away from where text is actually visible), sharp greyscale 96x160, per-band (top/middle/bottom) lum (0..1) + busy (0..1) inside safe zones (BAND_FOR_ANCHOR maps anchors).
- gemini: + vision pass (TITLE_SCAN_MODEL=gemini-2.5-flash) marking avoid bands (faces/product/focal); falls back silently.
- Output: {samples: [{atSec, bands: {top|middle|bottom: {lum, busy, avoid}}}] }.
- Contrast: ONE global ink decision per render (plateIsLightGlobal in Canonical.jsx) — band verdicts weighted by how many slots render copy there; majority wins, so copy never mixes ink colors across light/dark bands in one video (the minority band leans on the layered shadows). Keep-out `avoid` nudges stay per-band (positional only) and in practice only fire from the gemini pass or face-keep-out — basic-only scans never set `avoid`, so `Canonical.jsx` still renders at its authored static positions whenever gemini/face-keep-out are absent, regardless of placement mode. `plateHints: null` (no hints at all) now only happens if the kill switch is set or the scan throws/finds nothing.

## 5) Operator flows (routes/brand.js, all under /api/brand/:id, Bearer + tenant-scoped)

- `GET /title-spec` — full titling state: saved titleStyleSpec/titleStylePreset, resolved spec + source + per-format fonts (each resolved with that spec's own tokenOverrides.fonts), available presets, tokens, customFonts.
- `POST /title-still` — the FAST refinement loop: body {format, spec?, frames? (≤4 sec marks), scale?, meta? (text fields only), adId?, placementMode? ('canonical'|'content')}; synchronous, ~1-3s warm via the stills fast lane (enqueueStill — never waits behind a production render). With `adId` (must belong to the brand), stills render over the ad's REAL base video (ad.veoVideoUrl, cached per ad) — renderStill + OffthreadVideo extracts the exact frame at each timestamp, meta comes from the ad's own layout artifact (buildMetaForAd). Response: {frames, plateSource, fps, plateDurationSec, plateHints, placementMode, scanSampleTimes}. Powers `GET /title-playground` (public/titlePlayground.html).
- `POST /preview-script` (+ `GET /preview-script/:jobId`) — async full-motion preview (202+poll, base64 mp4); honors the engine dispatch, body.spec previews unsaved specs, body.engine and body.placementMode overrides (enum-validated, 400 on garbage).
- `POST /render-script` — body `{adId}`: re-title one ad over `ad.veoVideoUrl` via `renderBrandScriptAndSave` (ad→media→brand ownership check).
- `POST /retitle-videos` (+ `GET /retitle-videos/:jobId`) — batch re-title. Body `{adIds?: string[], dryRun?: boolean=false, concurrency?: number=2}` (concurrency clamped 1..4). Selects brand ads with `kind='video'` and non-null `veoVideoUrl`; optional `adIds` restricts (unknown/foreign ids reported in `errors`, not fatal). `dryRun` stays **synchronous** → `{count, ads:[{id, createdAt, renderUrl, veoVideoUrl}], errors?}`. Live is **async** (Netlify ~26s proxy cap; tens of seconds per ad): POST returns `202 {ok, jobId, status:'pending', count}`; poll `GET /:id/retitle-videos/:jobId` until `status` is `done` or `failed` (404 unknown/expired/wrong-brand; reaped 5 min after finish, same TTL as preview-script). Job transitions: `pending` → `running` with `progress:{done,total}` + accumulating `results`/`errors` → `done` (or `failed` + `error` for a catastrophic runner throw). Pool is concurrency-capped; per-ad try/catch calling `renderBrandScriptAndSave` (one failure never aborts the batch). Done payload fields: `{status, count, progress, results:[{id, ok, renderUrl?, skipped?, error?}], errors?, elapsedMs}`.
- `POST /title-spec/modify` (+ poll) — natural-language spec editing: LLM (atlasTextService) gets schema + current spec + tokens, returns the full updated spec; validated with one repair retry; NOT persisted — operator previews then saves via `PATCH {titleStyleSpec}` (schema-validated again at write).
- `POST /ingest-fonts` — website font scan → customFonts (merge by family/weight/style).
- `POST /ingest-meta-fonts` — vision identification of the typefaces in the brand's own
  Meta ads → metaAdsFontUsage. BILLABLE every call (an explicit operator request means
  re-run, so unlike the enrichment tier it does not gate on metaFontsIngestedAt).
  Body: `{maxImages?}`. Produces a NAME, not a file; never writes fontFamily.
- Title Studio (frontend monorepo `frontend/app/src/titling/`) — @remotion/player renders the same composition island live in the browser: instant slider edits, AI modify, per-format save; fonts load from gstatic/Cloudinary remoteUrls. Island is a copy — source of truth is this repo's remotion/ (see island/README.md).

### Per-ad copy override (routes/ads.js)

`PATCH /api/ads/:id` accepts `status` and/or `copy` (at least one required). Copy keys: `headline`, `cta_text`, `quote`, `productName`, `productPrice` — each a string (trimmed, ≤300 chars; empty → null) or null; unknown keys → 400. Updates use dotted paths (`copy.headline`) so omitted keys are untouched. Response unchanged: `{ad: projectAd(...)}`. These fields feed `buildMetaForAd` (headline resolution: `ad.copy?.headline` || layoutInput || brand tagline-in-brand-mode). After copy edit, re-title via `render-script` or `retitle-videos` to bake new text onto `Ad.renderUrl` (base plate stays in `veoVideoUrl`).

## 6) Ops runbook

Env vars:
- TITLING_ENGINE=canvas|remotion (brandScriptExecutor.js) — **INERT as of 2026-07-29.** `resolveTitlingEngine` returns remotion unconditionally (`:806`) and never reads this. Kept documented because the value still persists and reads as effective. See §0.
- REMOTION_TIMEOUT_MS (default 180000), REMOTION_BROWSER_EXECUTABLE, REMOTION_CONCURRENCY.
- TITLE_PLATE_SCAN=basic|gemini|off (plateIntelService.js) — scan depth in **content** placement mode; `off` is a global kill switch forcing canonical placement.
- GEMINI_API_KEY (for gemini mode).

Memory sizing: renders are memory-heavy (~1.5-3GB peak with headless Chrome; concurrency-1 main queue) — size Render.com instances ≥4GB; stills lane is much lighter. Browser resolution: requires a chrome-headless-shell binary (resolveBrowserExecutable checks /opt/pw-browsers, .cache/puppeteer/chrome-headless-shell; else ensureBrowser() downloads Remotion's own). Modern full Chrome (≥132) removed old-headless and cannot be used.

Remotion licensing: Remotion 4 is commercially licensed for companies >3 people (remotion.pro — company license + per-render seats). Default engine is remotion — confirm license before production use. (`acknowledgeRemotionLicense` flags in code silence the console notice; they are not the license.)

Troubleshooting:
- Fonts fallback: 🔤 logs in fontResolverService.js. A line naming a `library face` means the
  brand rendered an APPROXIMATION, not its typeface — `source: 'library-match'`, `exact: false`.
  Check `needsLicense` holds, the commercial gate, latin-subset, CACHE_VER.
  For a whole-fleet view run `scripts/backfillBrandFonts.js` (report mode, no writes).
- fps drift: eliminated by @remotion/media-parser probe (vs. canvas 24fps hardcode); safeFps clamped.
- Stalled downloads: 45s watchdog in downloadToFile (remotionRenderService); 30s in font downloads.
- Bundle/browser: warmup logs; bundlePromise reset on error; assetServer unref().
- Preset invalid: falls back with console.warn (🎬 titleSpec); canonical must always load.
