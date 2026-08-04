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

Loopback asset server (services/remotionRenderService.js): http on 127.0.0.1, serves /jobs/<jobId>/ (plate/logo) and /fonts/ (from FONT_CACHE_DIR), full Range support, CORS * for fonts.

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

Duration time-scaling: specs are authored against their own extent (max `phases[].endSec`, nominally 8s). At render, `specTimeScale` (remotion/lib/timing.js) compresses every enter/exit time proportionally when the probed plate is shorter (6s segment → ×0.75 — the CTA still lands), and entrances are hard-clamped inside the clip; longer plates keep authored pacing and hold-to-end slots hold longer. Positions are clamped to per-format safe zones in the composition (remotion/lib/safeZones.js). Vertical (Reels): top **14%**, bottom **35%**, sides **7.5%** (Meta Reels community-consensus clear zones; official Meta guidance is qualitative + Ads Manager guardrail; disclaimer rule is bottom 40%). Bottom-anchored vertical stacks end at ~65% height — intended.

**Accepted caveats (vertical safe zones):**
- (a) Vertical `upperThird` (0.135) now clamps to `safe.top` (0.14), so `top` and `upperThird` anchors coincide on vertical.
- (b) `lowerThird`/`bottom` stacks are edge-clamped, not height-clamped — tall multi-slot vertical stacks can still overflow into the cleared bottom band; operators should preview with the frontend guardrail toggle.

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

Fonts (`services/fontResolverService.js` `resolveBrandFonts`):
- Ladder per role (heading/body/quote): overrides (from spec.tokenOverrides.fonts) > theme.<role>FontFamily > customFonts > scanned fontFamily (Google) > DEFAULT_ROLE_FONTS.
- `resolveFamily`: matchCustomFont (brand.customFonts, license !== 'commercial', weight/style sort) → resolveCustomFont (download to FONT_CACHE_DIR).
- else resolveGoogleFamily (css2, pickLatinFace for U+0000-00FF subset only, CACHE_VER bust, download woff2).
- else default (Playfair Display/Inter/Lora); logs 🔤 on fallback.
- Website ingestion: customFonts from brandFontIngestService (Cloudinary raw mirror); remoteUrl kept for frontend @remotion/player.
- Output: {family, weight, style, url:localPath, remoteUrl, fallback, source}; remotionRenderService rewrites url to asset-server before browser.

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
- Fonts fallback: 🔤 logs in fontResolverService.js (custom not ingested + not Google → default); check license !== 'commercial', latin-subset, CACHE_VER.
- fps drift: eliminated by @remotion/media-parser probe (vs. canvas 24fps hardcode); safeFps clamped.
- Stalled downloads: 45s watchdog in downloadToFile (remotionRenderService); 30s in font downloads.
- Bundle/browser: warmup logs; bundlePromise reset on error; assetServer unref().
- Preset invalid: falls back with console.warn (🎬 titleSpec); canonical must always load.
