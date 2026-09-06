All lanes complete and cross-checked. Writing the inventory.

---

# WHAT THIS STACK CAN ALREADY DO — verified inventory

**Method:** `slotRenderers.jsx`, `titleSpecValidator.js`, `tokens.js`, `safeZones.js`, `plateHints.js`, `Canonical.jsx`, `directorTitleCardService.js`, `directorTitleCardGenerate.js` read in full directly. Five parallel Grok lanes traced brandScripts/tokens, the spec pipeline, placement intel, the YOLO/face stack, and the vision judge. Preset axis counts computed by script over all 15 preset JSONs. **Zero billable calls made.**

---

## 0. FIVE PREMISES IN THE BRIEF ARE WRONG. Fix these before designing.

**0.1 — There are two repos, and the brief cites the dead one for three of its four vision services.**

The live renderer is **`liquidretail_adgen`** (`ADGEN_RENDERER_ENABLED=true`, `config/defaults.env`; adgen `src/config.js:64-66`). `liquidretail_backend` stops at claim. Every path the brief gives as `liquidretail_backend/services/...` is a **vendored copy that materially differs**:

| File | backend | adgen worktree | Material difference |
|---|---|---|---|
| `plateIntelService.js` | 679 L | **738 L** | adgen has the entire `director` arm — `directorScanAppendix` (`:359`), `hints.directorBriefs` (`:420`), `hints.directorFrames` (`:511-529`). The 679-line copy the brief cites **cannot** produce director briefs. |
| `overlayZoneService.js` | 413 L | 372 L | backend exports `computeBrightnessGridFromUrl`; adgen does not. |
| `adVisionQcService.js` | 2607 L | ~2694 L | adgen has `titlingOnlyGate` / `TITLING_CATEGORIES`; backend has none. |
| `dinoOverlayZoneService.js` | present | **absent in adgen** | |
| `yoloService.js`, `mediaYoloRefine.js`, `catalogYoloDetectionService.js`, `yoloIdentifyService.js` | present | **all absent in adgen** | Vendor manifest: *"backend detection; adgen does not call it"* (`scripts/verifyVendorDrift.js:192,220-221`). |
| `safeZones.js`, `plateHints.js`, `overlayPlacementService.js` | — | — | **byte-identical** |

`safeZones.js` is **not** in `services/` — it is `remotion/lib/safeZones.js` (backend) / `src/remotion/lib/safeZones.js` (adgen).

**0.2 — The director title-card path is OFF by default. It is not the shipped design.**

`config/defaults.env:1634` → `ADGEN_DIRECTOR_TITLE_CARDS=false`. Gate at `directorTitleCardService.js:51-53` (`=== 'true'`, literal). `render.yaml` sets no override. The module header states it plainly (`directorTitleCardService.js:16-17`):

> "Default off — production titles stay the DOM/CSS slot path. This module must never throw out of the titling path; any failure falls back to those slots."

Double gate: the flag **and** a `generateTitleCard` function must be passed in (`remotionRenderService.js:822-824`; `generatorIfEnabled()` returns `undefined` when the flag is off, `directorTitleCardGenerate.js:144-148`). The worktree is branch `fix/director-title-cards`; commit `fcf3709` is **not an ancestor** of `liquidretail_adgen` local `master` (`94ba1c1`). So the defect set in the brief is from a flag-forced experiment (`scripts/renderDirectorTitleCardsPreview.js:176` forces `'true'`), not from production creative. **Production video titling today is the DOM/CSS slot system described in §1.**

**0.3 — `@remotion/layout-utils` is not used. Neither are five of the other packages named.**

Grep for `layout-utils` across all five repos, all source extensions, excluding `node_modules`: **zero imports.** Declared only at `package.json:29` (adgen) / `:34` (backend). Actually imported anywhere in adgen source:

| Package | Import count |
|---|---|
| `@remotion/renderer` | 26 |
| `@remotion/bundler` | 7 |
| `@remotion/fonts` | 4 — **all four are comments saying DO NOT use it** |
| `@remotion/media-parser` | 3 |
| `@remotion/player` | 1 |
| `layout-utils`, `google-fonts`, `animation-utils`, `paths`, `motion-blur`, `noise`, `transitions` | **0** |

`@remotion/fonts` is deliberately avoided: `FontLoader.jsx:7-10` — *"do NOT use @remotion/fonts `loadFont`. That helper's catch path calls cancelRender() … which is UNRECOVERABLE"*; `getFontFormat` is re-inlined at `FontLoader.jsx:36-51`. `@remotion/media-parser` is used only for fps/duration probing (`remotionRenderService.js:503-504`), **not** frame extraction.

The `measureText`/`fitText` hits in the repo are hand-rolled **node-canvas** `ctx.measureText` inside `services/brandScripts/*.script.js` (e.g. `canonical.script.js:579`, `:606`) — a different, kill-switched renderer (§2.1). Not layout-utils.

**0.4 — "~18 native text slot renderers" is three different numbers.**

`SLOT_RENDERERS` (`slotRenderers.jsx:968-992`) has **21 keys**; **18 exported component names**; but only **~14 distinct implementations** — `ProductDescriptionSlot`/`TaglineSlot`/`WebsiteSlot` are literal aliases `= TextSlot` (`:749-751`), `BadgesSlot`/`BenefitsSlot` both delegate to `renderMultiValue` (`:818-828`), `ProductImageSlot`/`BrandLogoSlot` both delegate to `renderImage` (`:899-904`). Of the 21, **three are image slots, not text** (`productImage`, `brandLogo`, `titleCard`).

**0.5 — No logo detector: confirmed, and the gap is wider than stated.**

Confirmed definitively (§5). But note what the cited failure actually is: in `6a9c65e6fb5073eec0cb50c8-titlecards_f155.png` (2.3 MB, exists, `title-preview-output/after-prompt-fix/`) the colliding chest logo is a **pixel inside the Gemini-generated plate**, not a composited asset. The brand's own logo, where it is composited, sits at a hardcoded rect (`overlayPlacementService.js:25` `LOGO_RECT = {x1:0.04,y1:0.04,x2:0.20,y2:0.10}`) or is drawn by `BrandPillSlot` (`slotRenderers.jsx:590-622`). Nothing in the stack localizes a mark **in generated footage**.

---

## 1. THE REAL `treatment` SCHEMA — every styling axis that exists today

`slotRenderers.jsx` consumes it; **`src/services/titleSpecValidator.js` is the authoritative contract** — it rejects, defaults, and strips unknown fields (`validateTitleSpec`, `:246-635`).

### 1.1 Full slot object (validator `:12-70` prose; `:326-614` implementation)

```
{ key, visible, slotType, bind[], brandMode, brandModeBind, visibleWhenEmpty,
  phase, position{...}, timing{...}, transition{...}, treatment{...} }
```

**`SLOT_KEYS`** (`:85-100`) — 21: `headline, quote, reviewer, rating, badge, brandPill, productName, price, deliveryLine, cta, promo, productDescription, tagline, website, likes, reviewCount, badges, benefits, productImage, brandLogo, titleCard`.
**`SLOT_TYPE_BY_KEY`** (`:105-115`): `rating`→rating; `badges|benefits`→multi; `productImage|brandLogo|titleCard`→image; everything else→text.

### 1.2 Every styling axis, with its enumerated values and default

**Universal `treatment` (validator `:531-572`):**

| Axis | Legal values | Default | Renderer |
|---|---|---|---|
| `scrim` | `frosted \| solid \| card \| none` | **`none`** | `scrimStyle` `slotRenderers.jsx:83-117` |
| `scrimOpacity` | 0..1 | 0.7 | `:98,104` |
| `scrimColorToken` | any `TOKEN_COLOR_KEYS` | `scrim` | `:85` |
| `shadow` | `layered \| soft \| none` | **`layered`** | `textShadowFor` `tokens.js:121-126` |
| `casing` | `upper \| title \| none` | `none` | `applyCasing` `tokens.js:309-317` |
| `fontRole` | `heading \| body \| quote` | `body` | `tokenFont` `tokens.js:54-59` |
| `weight` | integer 100..900 | 600 | `:126` |
| `sizeScale` | 0.5..2 | 1 | `baseSize` `:77-81` |
| `maxLines` | integer 1..4 | 2 | `WebkitLineClamp` `:144` |
| `trackingPx` | 0..8 | 0 | `:135` |
| `colorToken` | any of 15 `TOKEN_COLOR_KEYS` | `textPrimary` | `tokenColor` |
| `accent` | `{type: underline\|bar\|none, colorToken, animate}` | `{none,accent,true}` | `Accent` `:149-182` |
| `logoMode` | `auto \| text` | `auto` | validated on **every** slot; read only by `BrandPillSlot:596` |

**Multi-only (`badges`/`benefits`, validator `:577-593`):** `itemLayout` `stack|row|grid` (default `benefits`→stack, `badges`→row); `itemStyle` `pill|bullet|plain|chip` (default `benefits`→bullet, `badges`→pill); `itemDelaySec` 0..2 (0.12); `itemGap` 0..0.05 (0.012); `maxItems` 1..8 (4). Rendered by `renderMultiValue` `:830-894` — grid is `repeat(2, minmax(0,1fr))` (`:843`), per-item stagger at `:854-857`.

**Image-only (`productImage`/`brandLogo`/`titleCard`, validator `:596-612`):** `fit` `contain|cover` (contain); `sizePct` 0.05..0.9 of canvas short edge (0.35); `radiusPct` 0..0.5; `borderWidthPct` 0..0.02; `borderColorToken`.

**`position` (validator `:483-496`)** — fractions + an anchor enum, never px:
`anchor` ∈ `top|upperThird|center|lowerThird|bottom` (default `lowerThird`); `align` ∈ `left|center|right` (default `left`); `offsetX`/`offsetY` fraction of W/H clamped **±0.25**; `maxWidthPct` 0.2..1 (0.85); `row` string|null (shared value ⇒ side-by-side, `foldRows` `Canonical.jsx:353-364`).

**`timing` (`:498-510`):** `enterAtSec` (defaults to the phase's `startSec`), `exitAtSec` (**`null` = hold to clip end**), `enterDurationSec`/`exitDurationSec` 0..2 (0.4).
**`transition` (`:512-529`):** `type` `fade|slide|pop|wipe|none` (fade); `direction` `up|down|left|right` (up); `spring {damping 1..1000, stiffness 1..1000, mass 0.1..10}`.
**`phases`:** 1..4, **no key enum** — any unique non-empty string; `startSec`/`endSec` 0..15 (`MAX_CLIP_SEC`, `:168`).
**Doc-level:** `stack.rowGapPct` 0..0.08 (0.018); `tokenOverrides.colors` (15 keys, `#RRGGBB` only) and `.fonts` (3 roles, `family` ≤80 chars + optional weight).

### 1.3 Axes the renderer honours that the SPEC CANNOT AUTHOR

**`treatment.stroke` is not in the validator.** `slotRenderers.jsx` reads `t.stroke` at `:131`, `:134`, `:416`, `:448`, `:508`, `:581`, `:711`, `:715`, `:771`, `:881`, `:887` — but `validateTitleSpec` never writes `stroke` into `out.treatment` (`:569-572`). It is **injected at render time** by `Canonical.jsx:707` (`stroke: escalationInk?.marginal ? true : undefined`). Same for the **weight bump** (`Canonical.jsx:753-755`, +100 capped 900), the **shadow escalation to `layered`** (`:685`), the **colorToken flip** (`:682-684`), and the **`sizeScale` multiply by `fitPlan.scale`** (`:757-760`). A designer cannot request or suppress any of these from a spec — they are contrast/fit machinery.

### 1.4 The token vocabulary (`src/remotion/lib/tokens.js`)

15 colors (`COLOR_DEFAULTS` `:6-24`): `primary #0B0F14, secondary #DCDCDC, accent #F5B70A, ctaBg #46783E, ctaText #FFF8EF, scrim #0C0906, textPrimary #FFFFFF, textSecondary #DCDCDC, stars #F5B70A, badgeBg #BEC282, badgeText #1F2219, promoBg #F5B70A, promoText #16161A, textOnLight #16181D, textSecondaryOnLight #3A4048`.
3 font roles (`FONT_DEFAULTS` `:48-52`): heading Playfair Display 700 / body Inter 500 / quote Lora 400.
Shadow recipes: `TEXT_SHADOWS` (black) `:74-78` and `TEXT_SHADOWS_ON_LIGHT` (white halo) `:99-103` — **polarity follows the ink, not the token table** (`textShadowFor` `:121-126`, flips at luminance 0.5). `BOX_SHADOWS` `:303-307`. Contour stroke: `STROKE_WIDTH_EM 0.028`, `MAX_PX 3`, `paint-order: stroke fill` (`textStrokeStyle` `:177-192`) plus two clip guards (`strokeClipGuard` `:227-234`, `containerStrokeBleedGuard` `:291-301`). **adgen-only** — backend `tokens.js` ends at `clampPx` (146 lines vs adgen's 321).

**Per-slot base type sizes** are a hardcoded table, not measured: `BASE_SIZE` `slotRenderers.jsx:41-65`, e.g. `headline {vertical 68, feed 44, landscape 60}`. `square` aliases `feed` (`SIZE_FORMAT_ALIAS:75`) — the comment at `:71-74` notes the fallback is `?? 24`, which silently renders *everything* at 24px on an unknown format rather than throwing. `baseSize` clamps 10..200 (`:80`).

---

## 2. brandScripts / brandStyles — model-free variation actually available

### 2.1 The canvas engine is kill-switched

`src/services/brandScripts/` holds four node-canvas renderers (`canonical.script.js`, `canonical_dr_v1_vertical.script.js`, `top_scrim_editorial.script.js`, `local_scrim_landscape.script.js`), plus `assets/fonts/` (16 TTFs in adgen; **48 in backend**) and `assets/webfonts/`. **`resolveTitlingEngine` (`brandScriptExecutor.js:1676-1692`) unconditionally returns `{engine:'remotion', source:'canvas-disabled'}`.** Custom `Brand.styleScript*` is logged and ignored. Canvas survives only for operator preview.

**`brandStyles/` does not exist in adgen at all.** It is backend-only (`index.js`, `u_beauty.js`, `camelback_flowers.js`) and **`getBrandStyle` has zero callers** outside its own module; the only consumer is `routes/brand.js:2836,2864` seeding the editor UI. It is not on any render path.

### 2.2 15 shipped presets — and what they actually vary

`src/remotion/presets/*.json`, 15 files, identical names in both repos. I computed the axis usage across all 15 × all formats (**431 slot entries**):

**Slot keys any preset uses — 11 of 21:** `badge, brandPill, cta, deliveryLine, headline, price, productName, promo, quote, rating, reviewer`.
**Never used by any shipped preset — 10 of 21:** `productDescription, tagline, website, likes, reviewCount, badges, benefits, productImage, brandLogo, titleCard`.

| Axis | Values the schema allows | Values any preset uses |
|---|---|---|
| `scrim` | frosted, solid, card, none | **`none` only** (0 of 431 use a scrim) |
| `casing` | upper, title, none | upper, none — **`title` never** |
| `accent.type` | underline, bar, none | **`underline` only**, on 9 of 431 slots — **`bar` never** |
| `shadow` | layered, soft, none | layered, soft — `none` never |
| `colorToken` | 15 keys | 5: accent, ctaText, scrim, secondary, textSecondary |
| `fontRole` | heading, body, quote | all 3 |
| `weight` | 100–900 | 300, 400, 500, 600, 700, 800 |
| `sizeScale` | 0.5–2 | 19 distinct values, 0.9–1.74 |
| `trackingPx` | 0–8 | 9 values, 0.5–3.5 |
| `maxLines` | 1–4 | 1, 2, 3 |
| `anchor` | 5 | all 5 |
| `align` | 3 | all 3 |
| `offsetX` | ±0.25 | **0 in every preset** |
| `offsetY` | ±0.25 | 4 values, 0.05–0.105 |
| `maxWidthPct` | 0.2–1 | 14 values, 0.22–0.92 |
| `row` | any string | `ctaRow` only |
| `transition.type` | fade, slide, pop, wipe, none | fade, slide, pop — **`wipe`/`none` never** |
| `transition.direction` | up, down, left, right | up, down, right — **`left` never** |
| `transition.spring` | object | used on **71** slots |
| `itemLayout`/`itemStyle`/`itemGap`/`maxItems` | full vocab | **never** (badges/benefits absent from presets) |
| `fit`/`sizePct`/`radiusPct`/`borderWidthPct` | full vocab | **never** (image slots absent from presets) |
| `logoMode` | auto, text | **never authored** — default `auto` only |
| `brandMode` | keep, hide | **never authored** — defaults only |
| `visibleWhenEmpty` | any slot key | 11 uses, all `headline<-quote` |
| `stack.rowGapPct` | 0–0.08 | 7 values, 0.012–0.024 |

**Phase keys used:** `main` 36, `hook` 18, `proof` 18, `close` 16, `offer` 1. (`hook/proof/close` is the 3-phase video shape; `main` is the single-phase shape — the brief's "hook → proof → close" is one of two.)

**Only 6 of 15 presets carry `tokenOverrides`** — `babyboo-{main-character,editorial-monochrome}`, `pelagic-{offshore-bold,bluewater-editorial}`, `soludos-{mediterranean-editorial,summer-postcard}`. Each overrides ~11 colors + 2–3 font roles. Font families across them: heading `Barlow Condensed, Fraunces, Montserrat, Poppins, Saira Condensed`; body `Inter, Montserrat, Poppins`; quote `Fraunces, Inter`. The 9 `canonical*`/`proto*` presets carry **no** token overrides — they inherit Brand tokens.

⚠️ **Preset `description` fields lie about scrims.** `pelagic-offshore-bold` describes "solid near-black scrims", `babyboo-main-character` "frosted black scrim", `soludos-mediterranean-editorial` "ecru cards" — every `treatment.scrim` in every one of those files is `"none"`. Believe the JSON.

### 2.3 Where brand tokens come from (no AI)

`buildBrandTokens` (`titleSpecService.js:283-380`) cascade: `Brand.styleTheme.<key>` → `Brand.primaryColor/secondaryColor/accentColor` → `layoutInputBrand.primary_color/…` → hardcoded defaults. Pill ink (`ctaText`/`badgeText`/`promoText`) is **WCAG-picked** black `#16181D` or white `#FFFFFF` against the fill (`:325-332`). Spec color overrides win last, in the browser: `Canonical.jsx:391-394`.

Fonts: `fontResolverService.buildFontLadders` (`:928-1114`) is a **10-tier** ladder per role — spec override → ingested `customFonts` exact file → scraped family → Meta-ads high-confidence name → curated `styleTheme` → operator `fontFamily` → `tailwindTheme`/`websiteFontUsage` → weak Meta name → shared family → `DEFAULT_ROLE_FONTS`. `resolveFamily` (`:1-22`) resolves to a Cloudinary file, else a **Google Fonts CSS2 HTTP fetch** (`resolveGoogleFamily:218-273` — HTTP, not a model), else a bundled substitute marked `exact:false`. Ingestion (`brandFontIngestService.js`, `shopifyThemeFontService.js`) is **backend-only, non-AI HTTP crawl**; adgen only consumes the persisted `Brand.customFonts`.

### 2.4 Skeptical verdict on §2

Without any model, **two brands today differ in: fill colors on pills/CTA/stars, three typefaces, logo presence, and which proof slots have content.** They do **not** differ in chrome architecture unless someone pins `Brand.titleStylePreset` or a persisted `Brand.titleStyleSpec`. `titleIntentComposition.js:81-84` states in code that the 6 curated brand presets are used by **0 of 7 live brands**. The live floor is one no-scrim, black-or-white-type, 3-phase canonical with funnel timing variants.
**UNCONFIRMED (no Mongo read):** which brands actually carry `titleStylePreset`, `titleStyleSpec`, `styleTheme`, or non-empty `customFonts`.

---

## 3. How a title spec is built and reaches Remotion

### 3.1 Order inside `renderWithRemotionAndSave` (`brandScriptExecutor.js:2368`)

| Step | Line | Runs when |
|---|---|---|
| `resolveSpec` | `2412-2415` | **every** render |
| `validateTitleSpec` | inside `resolveSpec`, `titleSpecService.js:165,191,205,222,240` | every cascade tier |
| `composeFunnelSpec` | inside `resolveSpec.finish`, `titleSpecService.js:156` → `titleIntentComposition.js:304-319` | canonical-sourced titleable video |
| `applyBenefitsPlacement` | `2416-2423` | **called every render**; splices only if `ad.videoTitleDirection.include===true` ∧ `meta.benefits` non-empty ∧ no visible benefits slot. Re-validates at `videoBenefitsDirector.js:406`; authors `sizeScale 0.92` (`:347`); may target `proof|close`, **never `hook`** (`:218-221`) |
| `renderTitles` | `2501` | every render |
| `injectTitleCardsIntoSpec` | **not here** — parent `remotionRenderService.js:1089-1090` → `maybePrepareDirectorTitleCards:819` | flag ON **and** generator passed |
| child → `inputProps.spec` → `renderMedia` | `remotionRenderService.js:992-1028` | every render |

Compositions: `COMPOSITION_BY_FORMAT` (`remotionRenderService.js:40-45`) → `CanonicalVertical/Feed/Square/Landscape` at **1080×1920 / 1080×1350 / 1080×1080 / 1920×1080** (`Root.jsx:45-80`).

`resolveSpec` cascade tiers (`titleSpecService.js:147-242`): TIER 0 `presetOverride` → persisted `Brand/ad/product/category.titleStyleSpec` → TIER 2.5 `intentPreset` (funnel: PMax→`canonical-<stage>-pmax10`, Meta→`canonical-<stage>`, `titleIntentComposition.js:60-66`) → guaranteed floor `canonical.json`. **Every tier validates; a failed tier falls through.** `validateTitleSpec` returns `normalized: null` on any error (`:629`) — never a partial spec.

### 3.2 `injectTitleCardsIntoSpec` (`directorTitleCardService.js:518-587`) — replace, not overlay

It **does not delete** slots. Per phase with a successful card:
1. every visible non-preserved slot in that phase → `visible:false` + `_replacedByTitleCard` (`:528-537`);
2. a new `titleCard` slot is **pushed** (`:550-569`);
3. `validateTitleSpec` rebuilds (stripping `_` fields), then `_replacedSlotKeys` is re-stamped (`:576-585`).

`PRESERVE_DOM_KEYS` (`:46`) = `brandPill, brandLogo, productImage, titleCard` — those stay visible **alongside** the card.

**Geometry is copied from `replaceable[0]` — the first slot, not the union of the group** (`:557-564`):
```
anchor: hero.position.anchor || (phase === 'close' ? 'lowerThird' : 'upperThird')
align:  hero.position.align  || 'left'
maxWidthPct: hero.position.maxWidthPct || 0.85
row: null
```
`TITLE_CARD_TREATMENT` (`:491-510`): `fit:'contain'`, **`sizePct: 0.85`**, `shadow:'none'`, `sizeScale:1`, `weight:700`, `fontRole:'heading'`.

⚠️ **`sizePct` is dead on this slot.** `TitleCardSlot` (`slotRenderers.jsx:911-936`) reads only `t.sizeScale` and `t.fit` — unlike `renderImage` (`:938-959`) which sizes `productImage`/`brandLogo` to `shortEdge * sizePct`. So the `0.85` authored at `:507` has no effect.

`PLACEHOLDER_PREFIX = 'director-card:'` (`:44`) — the bind literal before the PNG exists on the child's loopback asset server; `rewriteTitleCardLiterals` (`:589-604`) swaps it for `http://127.0.0.1/jobs/<id>/titlecard-<phase>.png`; `hideFailedTitleCards` (`:606-631`) restores the DOM slots via `_replacedSlotKeys` if the swap failed. Timing is `phaseCardTiming` (`:413-441`) — non-final phases forced to exit at `phase.endSec`, **not** a raw union.

### 3.3 Where the image is generated

`directorTitleCardGenerate.js:115-141`. `atlasImage.editImage({ model: process.env.AI_DIRECT_IMAGE_EDIT_MODEL || 'openai/gpt-image-2/edit', quality: … || 'medium', extraParams: {output_format:'png', background:'transparent'}, allowFallback:false })`. Inputs: a **1024×1024 fully transparent blank canvas** (`blankCanvasPng:16-33`) plus, optionally, an extracted plate frame buffer (`:120-121`). Then `ensureTransparentCard` (`:35-113`) — the corner-transparency-aware keying pass the brief mentions, with the `cornersTransparent = as[2] < 64` guard at `:71` added after an opaque-white card was punched to empty.

Sizes (`cardSizeForFormat`, `directorTitleCardService.js:374-377`): `landscape → 1536x1024`, `vertical → 1024x1536`, **everything else → `1024x1024`**. Prompt: `buildCardPrompt` (`:318-372`) — arrow notation `key -> verbatim`, `ABSENT` fenced sentences (`absentSentences:288`, `ALWAYS_FENCE_IF_UNSET` = headline/quote/rating), and `BACKGROUND: fully transparent PNG…Do not put any string in the image that is not listed under TEXT.` (`:369-370`).

**Cost:** `atlasImageService.js:61-66` records gpt-image-2/edit catalog base `0.01` vs a **measured $0.07173** on 40 live *static* edits, and explicitly says do **not** extrapolate to another size/quality. Title cards use `quality:'medium'` + transparent background + non-square sizes. **The brief's ~$0.04/card is UNCONFIRMED by the code** — the only authoritative figure is the settled `price` on the prediction.

### 3.4 Group geometry and the card-space ≠ frame-space mechanism (`Canonical.jsx`)

Groups are keyed `phase|anchor` (`groupSlots:341-349`), built from the **first slot's** offsets (`:513-521`). Box: `stackContainerStyle` (`safeZones.js:253-350`) → `left/right = (safe.left ± offsetX) * width` clamped 0.02–0.9; `top/bottom` from `resolveGroupBoxPx` (`:212-242`) using `ANCHOR_TOP` (`:185-191`: `upperThird 0.135`, `lowerThird 0.54`). `boxHeightPx = height - placed.top - placed.bottom` (`Canonical.jsx:620-622`), then `planGroupFit` (`stackFit.js:368-436`) shrinks in 0.02 steps to `SHRINK_FLOOR 0.82`, then drops the rating reviews line, then drops trailing whole rows.

The titleCard wrapper is overridden at `Canonical.jsx:776-784`:
```
flex:'1 1 auto', minHeight:0, width:'100%', maxHeight:'100%',
overflow:'hidden', display:'flex', alignItems:'flex-start'
```
and the `<Img>` at `slotRenderers.jsx:920-933` is `width: ${100*scale}%`, `height:'100%'`, `objectFit: contain`, `objectPosition: 'center top'`.

**Three nested, non-coincident rectangles:**
1. **PNG canvas** — 1024×1536 / 1536×1024 / 1024×1024. The model typesets in *this* space.
2. **Remotion frame** — 1080×1920 / 1920×1080 / 1080×1350 / 1080×1080.
3. **Group box** — a *band*: for `lowerThird` on `vertical` that is y ∈ [0.54H, 0.65H] — **11% of frame height**.

So glyphs at PNG y=0 land at the *top of the band*, not the top of the frame; `contain` letterboxes the remainder; and the fit planner estimates a titleCard's height as a flat **`dims.height * 0.22`** (`stackFit.js:169-172`) regardless of the PNG's actual content. There is **no full-frame overlay path for title cards** — any prompt phrased in frame coordinates cannot match paint coordinates unless the group box happens to be the whole safe frame.

---

## 4. Placement intelligence that exists today

### 4.1 `plateIntelService` — the only intel on the render path, and it DOES run on generated video

Input: a **local filesystem path**. Video frames are extracted with **`ffmpeg-static`** (`:254-269`): `ffmpeg -y -v quiet -ss <t> -i <plate> -frames:v 1 <out.png>`. Sample times (`:440-446`): `[0.5, 1.5, d*0.35, d*0.55, d*0.75]` clamped — **for a 10s plate: 0.5, 1.5, 3.5, 5.5, 7.5s**. Frame is greyscaled to **96×160** (`:326`).

Three named bands, **not thirds** (`BANDS:57-61`): `top [0.14,0.28]`, `middle [0.40,0.55]`, `bottom [0.52,0.65]`. `bandsFor(safeZoneKey)` (`:239-252`) stretches only `bottom` for shallower surfaces. Horizontal sample x ∈ [0.08, 0.92] (`:276-277`).

Metrics: **`lum` = median** greyscale 0..1 (`:350-358`, mean was abandoned after a Vuori failure); **`busy` = `min(1, 3 × stddev(luma))`** (`:359-361`) — **not edge density, and there is no busy/calm threshold inside this file**; `avoid` starts `false` (`:361`) and is set only by the optional Gemini `semanticScan` (`:366-397`) or `applyFaceKeepOut` (`:586-658`, threshold `FACE_BAND_OVERLAP_THRESHOLD 0.20`).

Output — the entire contract:
```js
{ samples: [{ atSec, bands: { top|middle|bottom: { lum, busy, avoid } } }] }
```
**That is 9 scalars + 3 booleans per sample. No boxes, no regions, no coordinates.**

`TITLE_PLATE_SCAN`: code default `'basic'` (`:456`) but **adgen `config/defaults.env:1864` ships `TITLE_PLATE_SCAN=gemini`** — so the Gemini `avoid`-band pass is the file default on the live renderer. (Lane D reported `'basic'` from the backend copy; corrected here.) **UNCONFIRMED:** any Render dashboard override.

adgen-only additions: `directorScanAppendix` (`:359`), `hints.directorBriefs` (`:420`), `hints.directorFrames[] = {phase, atSec, b64}` (`:511-529`) — the per-phase reference frame handed to gpt-image-2.

### 4.2 Where it already feeds the renderer

```
brandScriptExecutor.js:2194 resolveBasePlateVideoUrl → 2211 ensureFaceDetectionForKeepOut
  → 2230 resolveSafeZoneKeyCjs → 2235 renderTitles({videoUrl, faceKeepOut, safeZoneKey})
remotionRenderService.js:458-464 download → :488 analyzePlate → :501 applyFaceKeepOut
  → :551-562 inputProps.plateHints → :581 renderMedia
Canonical.jsx:401-412 groupAnchors=resolveGroupAnchor → :433 effectiveAnchor
  → :444-448 worstCaseInkForBand/inkForBand → :513-521 stackContainerStyle
  → :674-764 treatment override → slotRenderers tokenColor/textShadowFor/textStrokeStyle
```

**"Avoid band" becomes placement at `Canonical.jsx:242-290` (`resolveGroupAnchor`)** — never in the spec. Candidates from `KEEP_OUT_CANDIDATES` (`:40-46`); `bandStateFor` (`:51-98`) takes **`avoid` as a union and `busy` as a max across all samples** while `isLight` stays nearest-sample (`:91`); faces are **hard-excluded** (`FACE_DISQUALIFIES:149`); survivors scored `busy + 1.0 × contrastPenalty` with a `BAND_SWITCH_MARGIN 0.03` head start for the authored band (`:265-266`). One anchor per group for the whole clip.

**The "plate-intel contrast flip" the `slotRenderers.jsx` comments reference (`:128-129`, `:364-365`, `:514`, `:642`) does not happen in `slotRenderers.jsx`.** It happens at `Canonical.jsx:682-684` → `contrastToken` (`tokens.js:29-33`), remapping `textPrimary→textOnLight` and `textSecondary→textSecondaryOnLight`. Pills/CTA/stars are never remapped. `inkForBand` (`Canonical.jsx:116-128`) chooses by **WCAG contrast ratio**, not a luminance threshold; `marginal` = best ratio < 4.5. Busy escalation: `BUSY_SHADOW_THRESHOLD 0.45` (`:501`) forces `shadow:'layered'`. **Plate intel never sets a scrim** — owner no-scrim rule.

Adgen-only: `contrastPenaltyFor` (`:219-225`) folds worst-case contrast into the keep-out score. Backend `Canonical.jsx` (621 L vs adgen 838 L) scores face + busy only.

### 4.3 `overlayZoneService` — richest spatial data, and it is NOT on the Remotion path

Input: a **finished Cloudinary still URL** (`w_1024`, arraybuffer→base64), Gemini 2.5 Pro. Output (`:199-210`):
```js
{ schemaVersion:'3.0', imageWidth, imageHeight,
  densityGrid:{cols,rows,cells},      // model-inferred 0/1, 8×6 / 6×8 / 6×10
  brightnessGrid:{cols,rows,cells},   // sharp mean luma 0..1
  restrictions:[{id, rectPct:{x1,y1,x2,y2}, classification, strictness, reason}],
  primarySubjectRectPct }
```
`classification` ∈ `product | face | secondary_subject | text | object | other`; strictness product 1.0, face ≥0.9 (`:23-28, 267-274`).

**This is the only thing in the stack that produces real rectangles — and there is no path from `OverlayZoneArtifact` to `Canonical`'s `plateHints`.** Confirmed by the `inputProps` object (`remotionRenderService.js:551-562, 992-1003`) and Canonical's prop list (`Canonical.jsx:373`). Its consumers are static overlay templates via `overlayPlacementService.placeOverlays` (`:71`, called from `layoutInputService.js:3368`) and a pre-generation split gate (`atlasVideoService.js:2572-2585`, on the **outfill still, before** the video is generated). `pipelines/detect.js:1678-1684` records that multi-frame analysis of the composed video is **still open / not implemented**.

### 4.4 `safeZones.js` (`src/remotion/lib/`) — byte-identical in both repos

| key | top | bottom | left | right |
|---|---|---|---|---|
| `vertical` (generic 9:16) | 0.14 | **0.35** | 0.075 | 0.075 |
| `stories` | 0.14 | 0.14 | 0.075 | 0.075 |
| `reels` | 0.14 | 0.35 | 0.075 | **0.15** |
| `feed` (4:5) | 0.06 | 0.06 | 0.065 | 0.06 |
| `square` (1:1) | 0.06 | 0.06 | 0.065 | 0.06 |
| `landscape` (16:9) | 0.10 | 0.10 | 0.075 | 0.075 |
| `verticalYt` | 0.14 | 0.35 | 0.075 | 0.15 |
| `landscapeYt` | 0.10 | **0.36** | 0.075 | 0.15 |
| `squareYt` | 0.10 | 0.10 | 0.10 | 0.10 |

Surface mapping `PMAX_VIDEO_SAFE_ZONE_KEY` (`:145-157`). The file declares itself **"THE ONLY TITLING AUTHORITY"** (`:76-77`) — `platformFormats.safeArea` looks like a second encoding and is **not read by Remotion at all**. `reels.right = 0.15` is flagged in-file as *"A CONSIDERED DEFAULT, NOT A MEASURED SPEC"* (`:97-103`); `landscapeYt.bottom = 0.36` **was** measured off Google's official 1920×1080 template (`:40-49`).

`panelColumnStyle` (`:403-462`) implements a real horizontal copy column (west/east, `PANEL_CENTER_GUTTER_FRAC 0.04`, cap 0.46) — but **production `renderTitles` never passes `panelSide`** (no call sites in either executor). Built, unwired.

---

## 5. YOLO stack — what it detects, on what, and the frame-extraction question

**Every YOLO file is backend-only. adgen — the live renderer — imports none of them.**

**Model:** not local weights in Node. An HTTP client to a hosted Flask/Python service: `axios.post` to `${YOLO_SERVICE_URL || 'https://yolo-microservice.onrender.com'}/detect | /detect-video | /detect-batch` (`yoloService.js:8,22,28,57`). Two internal paths: **YOLOv8x-COCO + OpenCV contours + gpt-4o-mini** when the prompt is empty, **Grounding DINO** open-vocab when a prompt is supplied and the microservice's `YOLO_OPEN_VOCAB_ENABLED` is on (`yoloService.js:13-21`). **The Python source `yolo_service.py` is not on this volume** (`scripts/verifyCatalogYoloDetection.js:389` points at `/Volumes/Sayulita/Projects/yolo_microservice`, absent) — exact checkpoints are **UNCONFIRMED**.

**Billing:** the YOLO HTTP call itself is treated as $0 token spend. Money forks after: catalog+hits → synthesize from title ($0); catalog+empty or UGC → paid GPT-4.1 refine ~$0.03/media (`mediaYoloRefine.js:7-27`).

**Inputs:** local **Buffers**, not URLs (`detectMultipleProducts(imageBuffer, opts)`, `detectFromVideo(videoBuffer, filename)`, `detectBatch(items)`). Callers fetch `Media.fileUrl` first (`mediaYoloRefine.js:68-78`). **Catalog stills, and ingest UGC video** — not generated ads.

### Can it detect a logo? **NO. Definitively.**

1. The Grounding DINO prompt builder `buildOpenVocabPrompt` (`mediaYoloRefine.js:154-178`) emits category tokens + last 1–2 title words + always `product` and `object`. It **never emits `logo`, `wordmark`, or `brandmark`**. Its `brand` parameter is accepted and **never inserted into the prompt**.
2. COCO-80 (the named closed set) has no logo class; no custom class exists in backend.
3. `dinoOverlayZoneService.js:31-34` **explicitly lists embossed logos as a capability this path loses**: *"On-product text detection (woven labels, hang tags, embossed logos). Add-back path: … Tesseract … deferred."*
4. The only `logo` string in the detection stack is a **consumer regex** classifying whatever label came back — `dinoOverlayZoneService.js:72-75` maps `/text|label|logo|tag|writing|sign|badge|emblem/` to restriction class `text`, strictness 0.5. That is not a detector.
5. `overlayPlacementService.js:25,84-88` has a hardcoded `LOGO_RECT` for placing the **brand's own asset** — not finding one.

**Storage:** `Media.refinedProducts` (declared `[Mixed]`, `models/Media.js:86-90`) + `yoloProducts` + `yoloDetectedAt` (`mediaYoloRefine.js:286-293`). Entry shape: `{id, label, brand, category, confidence, className, x1,y1,x2,y2, imgWidth, imgHeight, cropUrl, source}` (`:123-135`). **Note:** it is `Media.refinedProducts`, **not** `Media.metadata.refinedProducts` as the CLAUDE.md reframe docs imply.

**Consumers of the bboxes:** reframe/crop chooser (`reframeStrategyChooser.js:133-151`), PMax split side (`pmaxSplitStrategy.js:82-116`), DINO overlay zones (`pipelines/detect.js:1497-1514`), safe-rect union (`smartCropService.js:151-176`), quote scope, ad suitability, product match, atlas video reframe. **None of them is the Remotion titling path.**

### Frame extraction on a generated video — does the capability exist? **Yes, three independent ones.**

| Mechanism | Where | Notes |
|---|---|---|
| **Cloudinary `so_<sec>`** | `videoFrameService.js:116-134` (**present in adgen**) — `buildFrameUrl/buildFrameUrls/buildFrameUrlsAtTimestamps/fetchFrameBuffers`. Transform `so_<sec>,w_<n>,c_limit,f_jpg`; requires `/upload/` in the URL. | Already used by face detection and vision QC on `veoVideoUrl`. Generated Cloudinary videos are valid inputs today. |
| **ffmpeg-static** | `plateIntelService.extractFrames:254-269`; also `brandScriptExecutor.js` (header 8-12, ffmpeg at :30). | Already runs on the generated plate every render. |
| **YOLO microservice `/detect-video`** | `yoloService.js:25-28` — returns a `hero_frame` base64 + `hero_frame_sec`. | Server-side scan of the whole clip. Used on ingest UGC video only. |
| `@remotion/media-parser` | `remotionRenderService.js:358-368` | **Does not extract frames** — `{fps, slowDurationInSeconds, dimensions}` only. |

So frame extraction is solved and already paid for. **What does not exist is any wiring from a generated-video frame into a detector, in adgen.**

### Face detection (Task B)

`faceSafeCrop.js` **is not a detector** — header `:17-20`: *"No I/O. No ffmpeg, no Cloudinary, no vision calls, no Mongo."* Pure geometry: `computeGravityCropRect(sw,sh,wr,hr,subject,face) → {cx,cy,cw,ch,anchorY}` (`:243-317`), boxes normalized 0..1.

The actual detector is `basePlateCropService.js:398-424` — **Atlas `chatCompletion`, `model:'gpt-4.1'`, `stage:'base_plate_crop'`**, on 3–4 Cloudinary `so_` JPEG stills at 640px (`:443`). Prompt (`DETECT_SYSTEM_PROMPT:373-381`) returns `{"subject":{l,t,r,b},"face":{...}|null}` — `face` = whole head incl. hair/headwear; `subject` = all important content including **text**. `detectClipBoxes` (`:442-470`) needs quorum `FACE_MIN_FRAMES 2`. Persisted to `Ad.basePlate.faceSamples[] = [{atSec, face:{l,t,r,b}|null}]` in source fractions (`models/Ad.js:528-540`). Cost stated as **~4 vision calls ≈ $0.02** per ad that needs a crop (`:47-52`). **It runs on the generated video plate, post-generation, pre-titling** (`resolveBasePlateVideoUrl:527` on `ad.veoVideoUrl`; `ensureFaceDetectionForKeepOut:558-564` will pay for it purely for title-band avoidance even when no crop is needed).

**So: one detector already returns real boxes on generated video frames — and it is a GPT-4.1 vision prompt that already asks for "subject … including text", not YOLO.** Its output is then collapsed into `bands[].avoid` booleans by `applyFaceKeepOut` (`plateIntelService.js:586-658`).

---

## 6. `adVisionQcService` — what it judges, and whether the signal can move upstream

**Judge:** `google/gemini-2.5-pro` via Atlas role `'ad-vision-qc'` (`adVisionQcService.js:110-133`; `atlasModelMap.js:229`). Billable through `chatCompletion`/`trackLlmCall`. Cost per the code (catalog snapshot **2026-08-05**, **UNCONFIRMED today**): static ~$0.01–0.03/call, video ~$0.02/check (`videoQcFrameSelectionService.js:7`). Gates default **off**: `SystemConfig.staticVisionQcEnabled` / `videoVisionQcEnabled` (`:47-65`). **UNCONFIRMED whether these are on in production.**

**Artifact judged — and this answers the brief's question directly:** for video, it is **N JPEG frames sampled from the delivered mp4 via Cloudinary `so_<sec>`** (not the bitstream, not ffmpeg). Quartile baseline 25/50/75% for ≤20s clips, max 5 (`videoFrameService.planTimestamps:33-54`); caller passes `ad.videoDurationSec` else hardcoded 8 (`brandScriptExecutor.js:1814`), so a 10s clip → 2.5/5.0/7.5s. Optional non-billable dense pre-filter of ~12 160px frames picks up to 2 outliers, hard cap 5 (`videoQcFrameSelectionService.js:140-141`).

**Titled or bare?** The primary video call is at `uploadRenderAndStamp` — **post-Remotion, on the delivered pixels** (`brandScriptExecutor.js:1717-1720`, `:2099-2112`). Bare-master calls exist **only where the ad ships untitled** (`renderBrandScriptAndSave` no-chrome `:2644-2664`; `renderer.js:1609-1612`, `:1377-1384`). **There is no call whose job is to inspect the plate so typography can be placed.** Static QC is always after `finishPlate`. `renderer.js` does not call the judge; `queuedArchiveSweeper.js` is not a QC call site and does not exist in adgen.

### The four categories (`:83-91`, `PASS_FLOOR = 7`, `clampScore` floors so 6.9→6→fail `:558-564`)

**`layout_safe_box` — VIDEO prompt, verbatim (`:1927-1987` adgen / `:1861-1921` backend):**
> **4. layout_safe_box (framing/visibility -- no fixed geometry supplied)**
> Is the product's key branding area (where a hang tag, woven label, or logo would sit) fully in-frame and not clipped by the video's crop in the sampled frames? Does the caption/logo overlay ever fully obscure the product in a sampled frame? Flag only real visibility problems, not ordinary cinematic framing choices (close-ups, pans).

**`text_defects` — VIDEO prompt, verbatim:**
> **3. text_defects (product-intrinsic only -- NOT the ad's caption overlay)**
> Misspelled, mangled, gibberish, or nonsensical text/lettering that is part of the PRODUCT ITSELF or the scene (woven labels, hang tags, embossed or debossed logos, packaging). **Do NOT score the ad's own burned-in caption, headline, CTA button, or star-rating overlay** -- that overlay is inspected by a separate system and is explicitly OUT OF SCOPE for this category.

**`competitor_marks` — VIDEO prompt, verbatim:**
> Logos, wordmarks, emblems, badges, tree/animal/crest marks, or other brand devices present ON THE PRODUCT in any sampled frame that are ABSENT [from the reference], OR that belong to a DIFFERENT brand than ${brand}. IMPORTANT: ${brand}'s OWN logo composited into a corner as ad chrome is EXPECTED and must NOT be flagged. Only invent marks on the product surface (hardware, woven labels, hang tags) that were not on the original product.

The **static** prompt is a different rubric (`:499-546`): there, `layout_safe_box` *is* pixel-precise — *"Any TEXT or CTA that breaches the declared safe box numbers above, or is clipped at the canvas edge. Use the pixel numbers — do not invent a different safe region."* — and `text_defects` **is** in scope for ad copy. adgen adds a logo-occlusion paragraph (`:428-434`) absent from backend.

### THE ANSWER ON MOVING IT UPSTREAM — three hard facts

1. **No coordinates come back.** The requested JSON is `{categories:{<key>:{score, pass, findings[]}}, summary}`. Persisted `Ad.visionQc` (`buildPersistedVerdict:1313-1354`) adds bookkeeping only. Grepping adgen's copy for bbox/bounding-box/coordinates/region returns **only inputs** — the declared safe box (`:402,492,519`) and `logoGeometry`, which is **computed in code** from `logoRect` + `safeBox` (`computeLogoGeometry:363-384`) and handed *into* the prompt. A score plus the string "text breaches the safe box" is not a box.
2. **On video it is not even asked the placement question.** `layout_safe_box` supplies *"no fixed geometry"* and asks about product visibility; `text_defects` explicitly **forbids** scoring the burned-in typography. So the two categories that sound like typographic layout have had that meaning deliberately stripped on the video rubric.
3. **It never runs before typography is placed on a path that then places typography.** The bare-master calls happen only on ads that ship untitled.

**`titlingOnlyGate` (adgen worktree only, `:90-103`, `:2179-2194`):** for derives (`ad.deriveFromMaster`, set at `brandScriptExecutor.js:1864-1875`) the judge is still asked for all four and all four persist, but `verdict.pass` is re-scoped to `TITLING_CATEGORIES = ['text_defects','layout_safe_box']`. Combined with fact 2, the derive ship-gate rests on the two categories the video rubric emptied of overlay-typography meaning. **Absent from backend; `grep -c` returns 0 in `liquidretail_adgen` master (`94ba1c1`) — `fcf3709` is not an ancestor of that local HEAD.**

**On fail:** static regenerates exactly once (`MAX_QC_REGENERATIONS = 1`, `:81`) then throws `err.charged=true` → `renderer.js:2326-2384` stamps `status:'failed'`. Video **never regenerates** and `ok` is always true (`:2001-2029`); the caller stamps `status:'failed'` via `buildVideoQcFailureFields` (`brandScriptExecutor.js:2014-2035`) while keeping the asset. The header comment *"FLAG, DON'T DISCARD / ships as a normal draft"* (`:39-45`) is **stale** relative to its callers.

Latency: no SLA in the service. `renderer.js:1329-1330` describes it as *"several minutes in a real retry scenario"*. `Ad.renderStages.visionQcMs` is instrumented (`:1597-1606`) but **writes no number**. Measured p50/p99 **UNCONFIRMED**.

---

## 7. Is `@remotion/layout-utils` used? **No. Nowhere. In any repo.**

Declared: `.wt-director-title-cards-fix/package.json:29`, `liquidretail_backend/package.json:34` — both `4.0.495`.
Imports: **zero**, across `liquidretail_backend`, `liquidretail_adgen`, the worktree, `liquidretail`, and `rs-ai-backend`, over `.js/.jsx/.ts/.tsx/.mjs`, excluding `node_modules`.

Text fitting today is done three ways, none of them deterministic measurement:
- **CSS clamping** — `-webkit-box` + `WebkitLineClamp: t.maxLines` + `overflow:hidden` (`slotRenderers.jsx:142-146`).
- **Character-cap arithmetic** — `deriveCharCap` in `slotContent.js`, modelling `AVG_CHAR_WIDTH_EM 0.70` with a `CHAR_CAP_SAFETY 0.91` reserve.
- **Height arithmetic** — `estimateSlotHeightPx`/`planGroupFit` (`stackFit.js`), modelling `lines × fontPx × lineHeight`; titleCard is a flat `dims.height * 0.22` (`:169-172`).

The consequences are documented in-code as known gaps: `Canonical.jsx:730-738` states that **neither** `deriveCharCap` **nor** `estimateSlotHeightPx` models font weight, and both run **before** the render-time weight bump is applied — so a slot budgeted at 2 lines can wrap to 3 and hit `overflow:hidden`. `tokens.js:216-223` records that `strokeClipGuard`'s padding makes the rendered box taller than stackFit's estimate. **These are exactly the errors a real `measureText` would remove, and the package is installed and unused.**

The only `measureText`/`fitText` in the codebase is hand-rolled node-canvas inside the kill-switched brandScripts (`canonical.script.js:569-613`, `u_beauty.script.js:168-180`, `local_scrim_landscape.script.js:349-356`).

---

## Marked UNCONFIRMED

- Live Render dashboard values for `ADGEN_DIRECTOR_TITLE_CARDS`, `TITLE_PLATE_SCAN`, `OVERLAY_ZONES_MODE`, `SystemConfig.staticVisionQcEnabled`/`videoVisionQcEnabled`. No Render API query was run.
- Which brands carry `titleStylePreset` / `titleStyleSpec` / `styleTheme` / non-empty `customFonts`. No Mongo read. The "0 of 7 live brands use curated presets" figure is a **code comment** (`titleIntentComposition.js:81-84`), not a query.
- Actual billed USD per title card. The `~$0.04` in the brief is not supported by anything in the code; `atlasImageService.js:61-66` gives a measured **$0.07173** for gpt-image-2/edit on *static* square edits and explicitly forbids extrapolating to other sizes/qualities.
- Whether Atlas honours `1024x1536` / `1536x1024` exactly for `gpt-image-2/edit`. `buildParams` passes `size` through with no clamp (`:768-775`); no API call was made.
- Exact YOLO checkpoints / COCO class filter — `yolo_service.py` is not on this volume.
- Whether `Media.yoloProducts` survives Mongoose strict mode (it is `$set` by `mediaYoloRefine.js:286-293` but declared only on `DetectionArtifact.js:26`, not `Media.js`). Every named consumer reads `refinedProducts`, which *is* declared.
- Whether `fcf3709` (`titlingOnlyGate`) is merged on adgen `origin/master`. It is present in the worktree branch `fix/director-title-cards` and absent from the local `master` checkout at `94ba1c1`; no fetch was performed.