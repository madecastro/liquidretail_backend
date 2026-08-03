# AI Creative Pipeline — Architecture Reference

Phase 0 reference for the multi-stage creative stack (Director → concepts →
Judge → Ad expansion → render). **Corrected 2026-08-03 against live code on
`13cf679`.** Older prose in this file described planned Phase 1–8 layout /
resolver / Puppeteer steps as if they were the terminal path for catalog
product ads. They are not: for `product_image` / catalog-based product ads the
live terminals are **direct image** (`directImageRenderService` → gpt-image-2)
and **Omni video + Remotion titling** (`atlasVideoService` +
`brandScriptExecutor`). The HTML/Puppeteer renderer is unreachable for new
`ai_*` generation (see CLAUDE.md §00 / §1).

## Stages

```
                      ┌─────────────────────────┐
                      │   Operator wizard       │
                      │   (ad type + intent)    │
                      └────────────┬────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │       campaignAdsGenerationService      │
              │  seed universe → Director → Judge →     │
              │  expand media_picks → Ad docs queued    │
              └────────────────────┬────────────────────┘
                                   │
                       ┌───────────┴───────────┐
                       │  buildLayoutInput     │
                       │  → LayoutInputArtifact│   (cached per cartesian cell)
                       └───────────┬───────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │ AI Creative Director            │   live
                  │ → CreativeDirectionArtifact     │   cached per
                  │   (N concepts, routing v3)      │   (brand × product × kind × intent)
                  └────────────────┬────────────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │ Concept-round LLM Judge         │   live
                  │ → JudgeResultArtifact           │   ranks concepts;
                  │   (no culling)                  │   universe-aware axes
                  └────────────────┬────────────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │ Expand concepts → Ad payloads   │   live
                  │ conceptMediaPicks → mediaId(s)  │
                  │ perProduct reasons on CampaignRun│
                  └────────────────┬────────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │  Render (POST /api/ads/runs claim)      │
              │  static: directImageRenderService       │
              │  video:  Omni master → Remotion title   │
              │  adStage piggybacks poll ticks          │
              └─────────────────────────────────────────┘
```

**Earlier diagram (pre-2026-08) ended in "Puppeteer + Cloudinary" for every
ad.** That was the Phase 6 plan for the layout-chain renderer and is **false
as a description of catalog product-ad delivery today.** Puppeteer remains for
scraping / logo ingest / review capture, not for new `ai_*` plate generation.

Layout Generator / Resolver / RendererJob artifacts (`LayoutGenerationArtifact`,
`ResolvedLayoutArtifact`, `RendererJobArtifact`) remain in the contract table
below as Phase 2–6 work; do not assume they sit on the live catalog path
without re-checking the selector in code.

## Contracts

| Stage | Output artifact | Contract schema | Cache key |
|---|---|---|---|
| Creative Director | `CreativeDirectionArtifact` | `schemas/contracts/creative_direction.v1.json` | `(brandId, productId, campaignKind, creativeIntent)` |
| Layout Generator | `LayoutGenerationArtifact` | `schemas/contracts/layout_generation.v1.json` | `(conceptId, mediaId, aspectRatio, variantKind, paletteSource)` |
| Resolver | `ResolvedLayoutArtifact` | `schemas/contracts/resolved_layout.v1.json` | `(layoutGenerationArtifactId, layoutInputArtifactId)` |
| Renderer | `RendererJobArtifact` | `schemas/contracts/renderer_job.v1.json` | `(resolvedLayoutArtifactId, exportFormat, scale)` |

Every artifact carries `contract_type` + `version` + `cache_key` in its body, so any artifact can be validated against its schema standalone.

### Director concept shape (v3 routing nest) — load-bearing

Director schema **v3 nests strategy fields under `concept.routing`**:
`media_picks`, `archetype`, `creative_style`, `output_shape`, priorities, etc.
(`services/conceptProjection.js` `ROUTING_NESTED_FIELDS`).

**The defect (fixed 2026-08-03):** the producer dual-read both shapes, so its
validator logged `warnings=0`, while six consumers still read **flat v2 only**
(`concept.media_picks`). Every v3 concept was discarded as "no media_picks"
after a paid Director round — zero ads, silent. Live symptom:
`concepts=3 payloads=0`.

**The rule now:** one helper only —

- `conceptField(concept, name)` — prefer `routing[name]`, fall through to flat
- `conceptMediaPicks(concept)` — Array.isArray order (nested array wins
  including empty; non-array nested falls through to flat)

Consumers: `campaignAdsGenerationService`, `aiJudgeService` (×2),
`aiCanvasHtmlGeneratorService`, `veoStoryboardService`, and the producer's own
dual-reads. `scripts/verifyConceptContract.js` exhaustively scans
`services/` + `routes/` and fails if any file reads a `ROUTING_NESTED_FIELDS`
name off a concept without the helper.

`conceptForRender` projects a strategy-safe flat object and **never** exports
`rationale` / reasoning into image prompts.

### Seeded universe default (hero-only)

`DIRECTOR_UNIVERSE_TOP_N` default is **1** (`config/defaults.env:30`,
`campaignAdsGenerationService.js:184`). This is a **default** change, not a
capability removal: ceiling stays 10, multi-image remains fully wired, and
operator multi-select still widens via
`Math.max(mediaIds.length, DIRECTOR_UNIVERSE_TOP_N)`.

Side effects wired in code:

1. **Judge `media_utilization` is N/A at universe ≤ 1** — excluded from the
   average so concepts are not docked for obeying the hero-only constraint
   (`aiJudgeService.js:423-431,549-556`). Prompt still scores 10 when the
   pick is in-universe; still penalizes out-of-universe ids.
2. **Output-shape menu narrows to `static_single`** when universe size < 2
   (`aiCreativeDirectorService.feedOutputShapesForUniverse`, `:1050-1055`) so
   the model cannot emit a collage declaring one tile.

### Per-product reasons

Expansion outcomes are persisted on `CampaignRun.perProduct` and returned by
`GET /api/ads/runs/:runId` (`services/perProductReasons.js`,
`campaignAdsGenerationService` + `routes/ads.js`). Machine codes include
`no_concepts` vs **`concepts_no_usable_media`** (Director returned concepts but
every pick was unusable / outside universe). Run-level empty message uses real
reasons — not the old generic "check that the product has usable imagery".

### Stage instrumentation

`adStage` lives in `services/adStage.js`. **Fire-and-forget; never awaited** —
it sits where Atlas is already billed. Both static and video paths write a
stage at every phase and piggyback **existing** poll ticks
(`ATLAS_IMAGE_POLL_MS` ~3s, `ATLAS_POLL_INTERVAL_MS` ~15s) with elapsed time +
poll count, e.g. `plate generation (meta_feed_1_1) — polling 20s (7)`. Floor
knob `AD_STAGE_MIN_MS` (default 3000ms; not in `defaults.env`). Closed a ~600s
blind spot. No new timers.

### Video: untitled master is not a success

Omni master lands → intermediate `status:'draft'` (deliberate: without it a
crash mid-titling leaves `rendering`, the reaper requeues, next drain pays
Omni again). If Remotion titling then throws, the ad is **`failed`** with
`master rendered; titling failed`, counted against the run; raw master
**kept** (paid for). No-chrome shipping the master deliberately still counts
as success (`routes/ads.js:1258-1345`).

### `/runs` claim (money)

`POST /api/ads/runs` uses `claimAdsForRun()` with atomic
`status:'queued'` filter, ownership re-read, `modifiedCount` cross-check, and
post-claim requeue on throw (`routes/ads.js:619+`). Same discipline as
`/generate`. Harness: `scripts/verifyRunsClaim.js`.

### Routes note (ads surface)

- `GET /api/ads/formats` returns `formatCatalog()` verbatim — display-only,
  brand-agnostic, no brandId (`routes/ads.js:1992-2000`).
- Unknown `/api/ads/*` paths 404 via `router.param` guards on `id`/`adId`
  instead of 500 CastError. **Trap:**
  `mongoose.isValidObjectId('video-models') === true` — 12-byte strings cast —
  so named routes are protected by **route registration order**, not the
  param guard alone.

## Vocabulary lock (Phase 0)

`services/aiVocabulary.js` is the source of truth for:

- **ROLES** — 15 fixed: `headline`, `hero_media`, `quote`, `comment`, `stat`, `rating`, `cta`, `offer`, `eyebrow`, `logo`, `creator`, `badges`, `panel`, `scrim`, `product_card`
- **ZONE_KINDS** — v1: equals ROLES (1-to-1)
- **COMPONENT_STYLE_BY_ROLE** — per-role variant whitelist (~75 total across all roles)
- **LEGACY_KIND_ALIASES** — old `AiCanvasArtifact` kinds → new role names. Backward compat through Phase 5; removed in Phase 8.
- **ROLE_FALLBACK_CHAINS** — Resolver downgrade order when a chosen variant fails constraint checks
- **REQUIRED_PROPS_BY_ROLE_VARIANT** — props each variant needs to render

Renderer derives CSS classes as `rs-<role>-<component_style>` from the locked names. CSS lives in `frontend/client/rs-component-variants.css` (frontend repo).

## Cost discipline

`services/costTracker.js` wraps every LLM call. Every call writes a `CostLog` doc — including cache hits (0-cost). The eight cost-saving levers from the architecture review map to specific places:

| Lever | Where it lives | Phase shipping it |
|---|---|---|
| 1. Cache Director per `(brand × product × campaignKind × creativeIntent)` | `CreativeDirectionArtifact` unique index | Phase 1 |
| 1b. Cache copy candidates per `(brand × style)` | `CopyCandidatesArtifact` unique index | Phase 4 |
| 2. Right-size models per stage | `costTracker.MODEL_RATES` + per-service model picks | Phases 3, 4 |
| 3. Low-res vision attachments | `aiCanvasInputBuilder.pickAltRatiosForVision` + thumbnail URL transforms | Phase 2 |
| 4. Batched judge | `aiJudgeService` batches / concept-round scoring | Phase 3 |
| 5. Preview ≠ production | Generator gets a `mode: 'preview'/'production'` param | Phase 3 + Phase 9 UX |
| 6. Prompt compression | Compressed system prompts in each service | Phase 2 |
| 7. Tiered fast/slow path | Deferred — measure first | (Future) |
| 8. Reusable resolved layout | `ResolvedLayoutArtifact` decoupled from format/scale | Phase 5 |

Money invariants that sit next to this pipeline (do not soften):

- Generation POSTs are billable; submit once. Atomic claim on `/runs` and
  `/generate`. `maxRedirects: 0` on billable Atlas POSTs.
- Ledger spend at the charge point (`atlasImageService.chargedError`).
- One Director round per product feeds every static surface size; do not
  re-run the Director per format (`campaignAdsGenerationService.js:2445-2451`).

## Migration safety net

Through Phases 1–7, the legacy `AiCanvasArtifact` flow was kept valid alongside
the new chain for brands on the HTML static pipeline. Catalog product ads on
the live path are concept-driven + direct image / Omni — not a dual-path
opt-in flag for new generation. Phase 8 still targets dropping legacy artifact
reads; already-generated ads hold finished `renderUrl`s and are not a reason
to keep dead renderers (CLAUDE.md §00).

## Naming reconciliation (locked here)

Three breaking changes from the legacy `AiCanvasArtifact.canvasSpec`:

1. **`kind: 'media'` → `kind: 'hero_media'`** (and role: hero_media). Renderer keeps a back-compat alias map until Phase 8.
2. **`kind: 'text'` + `style_variant: 'display_script'` → `kind: 'headline'` + `component_style: 'display_script'`**.
3. **`layer: 'media'/'background'/'copy'/...` (string enum) → `layer: 0/1/2/...` (integer z-index)**.

Plus one additive change:

4. **`zone.zone_scaler` is a single number per zone** (proposed contract) instead of `canvas.zone_scalers[name].font` map. Renderer reads either during migration.

## File index

```
schemas/contracts/
  creative_direction.v1.json
  layout_generation.v1.json
  resolved_layout.v1.json
  renderer_job.v1.json
services/
  aiVocabulary.js                 ← role/kind/variant/fallback source of truth
  conceptProjection.js            ← ONLY way to read Director concept fields
  perProductReasons.js            ← expansion skip codes + run message
  adStage.js                      ← fire-and-forget render progress
  costTracker.js                  ← wraps every LLM call
  campaignAdsGenerationService.js ← universe → Director → Judge → Ad payloads
  aiCreativeDirectorService.js    ← Director producer
  aiJudgeService.js               ← concept-round judge (universe-aware)
  directImageRenderService.js     ← static terminal for ai_* product ads
  quoteProvenance.js              ← printable customer-quote gate
models/
  CostLog.js                      ← per-call telemetry
docs/
  ai-creative-pipeline.md         ← this file
  PROOF_JUDGE.md                  ← comment judge + quote provenance
```

Paths above are repo-root relative. An earlier revision of this index said
`server/services/` and `server/docs/` — those prefixes were wrong for this
repo layout.

## Transparent product images / website background

**Problem.** Product images scraped from client sites often have transparent backgrounds. AI video/image models receive those seeds after Cloudinary transforms; alpha is treated as black, so ads render as product-on-black instead of product-on-brand-surface.

**Capture.** `Brand.websiteBackground` (hex like `#FFFFFF`, nullable) is filled during homepage enrichment in `brandEnrichmentService` via a static-HTML/CSS heuristic (`extractWebsiteBackground`: body/html inline style, then `body{...}` / `html{...}` rules in `<style>` tags). It is **never** inferred from meta `theme-color` (brand accent, not page surface) and never GPT-guessed. Respects `curatedFields`. Logged with source like other enrichment fields. (FLAG: static heuristic — headless browser not coupled here.)

**Helper.** `utils/websiteBackground.js` → `websiteBackgroundHex(brand)` returns normalized `RRGGBB` (no `#`) for Cloudinary `b_rgb:`, defaulting to `FFFFFF` when absent/invalid. Also re-exported from `brandEnrichmentService`.

**Transforms that apply `b_rgb` (flatten-then-resize).** Image-source seed crops only:

| Function | File | Notes |
|---|---|---|
| `deriveAspectCroppedImageUrl` | `services/aiVideoReferenceService.js` | Omni/image-seed track (legacy "Veo" name) |
| `cropImageUrlForAspect` (image branch) | `services/atlasVideoService.js` | Atlas reference stack via `buildReferenceImages` |

Video-source branches unchanged (no alpha).

**Known NOT-yet-covered surfaces (follow-ups):**

- HTML template `panel_bg` / `body` for static image ads
- Remotion plate fallback `#3D3D3D`
- Legacy `videoCompositeService` `b_lpad,b_black` chain
- `layoutInputService` `c_crop` URLs

## Validation gates by phase

Phase 0 establishes baseline. Subsequent phases each have a measurable gate before merging the next:

| Phase | Gate |
|---|---|
| 0 | CostLog populating; baseline $/ad and cache-hit-rate metrics for current pipeline |
| 1 | Director vocabulary spread (archetype/emotional_hook/social_proof_type variety); conceptProjection dual-read green |
| 2 | v2 spec visual quality at parity; cost-per-spec drops 30% vs v1 |
| 3 | Judge agreement with operator picks; universe-size-aware axes; cost reduction 60-70% vs naive proposal |
| 4 | Copy variety (3-5 distinct candidates per slot per style) |
| 5 | Pixel parity vs legacy renderer ≤5% diff rate on 100-spec sample |
| 6 | Multi-format export + asset preload working |
| 7 | Carousel coherence (4-frame story reads naturally) |
| 8 | Legacy artifact reads drop to zero over 7 days |
| 9 | Operator wizard usable without template training |

## Known open (do not claim fixed)

- **1-in-3 static ads** can still render a competitor-shaped brand mark on the
  product (e.g. tree emblem reading as Timberland on an Allbirds shoe) —
  prompts already ask for fidelity; fix is measure-and-reject, not more
  prompt tuning. Video path not QC'd as of 2026-08-03.
- **`queued` ads never auto-drain** — operator/API must claim them.
- **`veoPredictionId` is a spend receipt that is never resumed** — process
  death + re-drain double-bills.
- Meta preview chrome still shows placeholder "Lorem ipsum dolor sit amet".
