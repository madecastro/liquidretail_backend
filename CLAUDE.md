# CLAUDE.md — liquidretail_backend

Express + Mongoose backend for Reach Social's ad-generation product. Deploys to
**Render** (`liquidretail-backend.onrender.com`). The SPA frontend is a separate repo
(`Emami-RS-Project/liquidretail`, trunk `master`) deployed to **Netlify**
(`staging.reach-social.io`). Trunk here is `main`.

**Read `session.md` for live state. Read `ARCHITECTURE_REVIEW.md` before touching
security, money, or the render queue** — it carries verified P0s with `path:line`.

Live prod (2026-08-03) = `13cf679` (both services). Offline verify suite = **29
scripts, all green** (includes `verifyRunFeed.js`). Claims written against
pre-deploy binaries are suspect.

---

## 00. THE CATALOG PRODUCT-AD PIPELINE — owner-stated, 2026-08-02

**This is the whole architecture for catalog-based product ads. There are no
other generation pathways for them. Do not propose, restore, or "fall back to"
one.** Owner, verbatim: *"We are no longer using ANY other generation pathways
for video or static ads … we are not using any other generation pathways for
catalog based product ads."*

**VIDEO** — one billable generation (9:16 master); other Meta surfaces are
free crop/retitle **intent** (Phase 3 queue fan-out not live — see step 3):

1. Resize the hero image to **9:16** with the **current** resizing system.
2. **Omni** image-to-video → the 9:16 **master**. `google/gemini-omni-flash/
   image-to-video-developer`. ONE billable submit per product on live presets
   (`meta_video` / `meta_all` queue `videoFormats: [META_VIDEO_MASTER]` only —
   `platformFormats.js:586-593`, `campaignAdsGenerationService.js:592-596`).
   See §2 — everything named `veo*` is this Omni pipeline under a legacy name.
3. **Crop** for non-9:16 targets via `videoCropUrl` + `basePlateCropService`
   (face-anchored) at titling time — never a second Omni submit. **Phase 3
   multi-surface fan-out is not the queue path yet:** `META_VIDEO_FANOUT`
   (Reels retitle + feed 1:1 + 4:5) is documented as free derivation intent
   (`platformFormats.js:406-422`); `resolvePreset('meta_video')` still returns
   the master only. Do not reintroduce four video Ads = four submits.
4. **Title each surface appropriately** — burned into the delivered file, using
   that surface's own safe zone. Reels (204) and Stories (250) differ and must
   not share one entry. **Untitled is not success:** after the master lands the
   ad is stamped `status:'draft'` (reaper-safe money guard), then titling runs;
   if Remotion throws, status flips to **`failed`** with
   `master rendered; titling failed`, the run is charged a failure, and the
   **raw master is kept** (`routes/ads.js:1258-1343`). Leaving the ad
   `rendering` mid-titling is a double-bill hole (reaper requeues → second Omni).
5. **Preview** the result inside the matching **Meta surface overlay**
   (preview chrome only — known-open: placeholder "Lorem ipsum" copy).

**Video prompt (owner 2026-08-03):** Live path is the **canonical camera-only
prompt** via `buildVeoPrompt` — not Director concepts. Comment + priority at
`atlasVideoService.js:2593-2620`: on-screen text is **not** in the Omni prompt;
Remotion brand-script titling composites it from `ad.copy` + LayoutInputArtifact.
Generic-looking camera prose is **by design**, not a missing field. Do **not**
plumb `art_direction` / `creative_style` / `archetype` into the camera prompt.
**Levers:** `videoPromptGuidance` (prepend), `videoPromptRaw` (full replace;
logs *"canonical directives bypassed"*), and the canonical directives inside
`buildVeoPrompt`. `buildVeoPrompt` receives **no** Director concept — args are
`{brand, product, media, layoutInput, sourceMedia, aspectRatio, seedHasText,
hasProductReference, storyboard, caps, durationSec}`. Director is **off for
video by default** (`directorVariants` opt-in; wizard "AI DIRECTOR VARIANTS —
Off"). Even when on, Director does **not** drive the camera prompt or video
titling (`docs/PIPELINES.md` §6). `meta_video` / `meta_all` use
`expandDeterministicVideo` — one Ad per product, no concept expansion.
**Current objective: tune the canonical prompt.** Archetype-driven video is
**deferred, not missing.** **None of this is evaluable until Remotion titling
is fixed** — it dies at `Could not extract frame from compositor / Request
closed` (`offthread-video-server.js:99`); every run pays for a master with no
titled output, so prompt changes are unobservable. Font 404/CORS in that log
is a red herring (FontLoader recovers with fallback stack).

**STATIC** — direct to **gpt-image-2/edit**, one call returns the finished ad
(`directImageRenderService`). No HTML, no Puppeteer, no SVG overlay compositing.
Each Meta static size is its own billable image gen (`meta_static` = 3 —
`platformFormats.js:576-583`).

### The overlay is PREVIEW ONLY — and it is not the titling

Two different things, repeatedly confused, so state both:

- **Titling / "chrome"** in `brandScriptExecutor` → `remotionRenderService` **is
  burned into the video**. Correct and intended.
- **The Meta surface overlay** — the simulated IG/FB furniture *including Meta's
  current CTA treatment for that surface* — is **PREVIEW ONLY and MUST NOT be
  burned in**. Owner: *"the meta overlays should include the current meta
  treatment for CTA as those are not burned in the video."* An advertiser
  uploads a clean asset; Meta draws its own UI.

### SCOPE — what constrains deletion, and what does not

Exclusivity covers **catalog-based product ads** (`Ad.variantKind ===
'product_image'`). Owner: *"existing alternate pathways will exist for social
media images that get repurposed for ads."* `'ugc'` is that repurposed social
image — **and it is also moving to the new pipeline** (owner, same day).

Three things that do **NOT** constrain deletion, all owner-confirmed:

- **Already-generated ads.** *"I am not worried about ads that have been
  previously generated, they are already there."* They hold finished
  `renderUrl`s. Old renderer code is only needed to RE-render them, which is not
  a requirement. (Older snapshot: ~777 ugc / ~466 product_image on `html_gen` —
  not re-counted 2026-08-03; counts are not a reason to keep dead code.)
- **Brand pipeline flags.** *"All brands should be on the new pipeline now"* —
  earlier snapshot: 33 brands `null`, 1 `direct_overlay`, **zero** on `'html'`
  (not re-queried 2026-08-03). Code path is still load-bearing:
  `resolveStaticPipeline` maps everything except literal `'html'` to
  `DIRECT_IMAGE`.
- **`renderRoute: 'html_gen'`.** ANOTHER MISNOMER, same family as `veo*`.
  `renderRouteForKind()` returns `'html_gen'` for every image ad regardless of
  brand or variant — it means "static", not "the HTML renderer". The real
  renderer is chosen inside `renderService`: every `ai_*` static ad enters
  `renderDirectImage` (`renderService.js:485-487`) and returns on success.
  Production proves it — rows can be `html_gen` + pipeline `direct_image`.

**So the HTML renderer is unreachable for new generation.** It survives only for
non-`ai_*` legacy templates, which §1 already documents as routing to the dead
`renderViaSpec`.

Still must stay: `headlessScrapeService`, `brandLogoIngestService` and
`reviewHeadlessCapture` use Puppeteer for **scraping / ingest / review capture**,
not generation.

---

## 0. THE ONE RULE THAT WOULD HAVE SAVED THE MOST TIME

**Code being present does not mean the path is live.** This repo retires paths by
kill-switch and comment-block, leaving the old code — and often its documentation —
in place. A single session burned hours getting the video pipeline wrong three times
by reading call sites instead of selectors.

Before planning work against any path, **find the selector and read what it actually
returns**:

| Question | Where the answer really is |
|---|---|
| Which titling engine runs? | `brandScriptExecutor.js:913-922` — returns `'remotion'` **unconditionally**; the cascade below it is inside `/* … */` |
| Which render path runs? | `renderService.js:485-520` (`ai_*` static → `renderDirectImage`, return) vs `:895` `renderViaSpec` fallthrough |
| Which video overlay runs? | `routes/ads.js:1156` `if (ad.renderRoute === 'veo')` → master + `renderBrandScriptAndSave`, then **returns**. Never reaches `renderCreative` |
| Which models can a user pick? | `selectable: true` in `MODEL_CAPS`, filtered at `routes/ads.js:1979` |
| Concept field (v2 flat vs v3 `routing`)? | **Only** `services/conceptProjection.js` — `conceptField()` / `conceptMediaPicks()` |
| Is a feature on? | grep `config/defaults.env` — it is `dotenv`-loaded at boot by `index.js:5` and `worker.js:20` |

Cheap habit: `grep -n "function resolve<Thing>" -A 20` and read the **first**
`return`. If there is a `/*` below it, the docs may describe the comment.

---

## 1. Dead or disabled paths — do not plan work against these

Verified 2026-07-29; line anchors re-checked 2026-08-03. Each looks live; none is.

- **Canvas titling engine.** `resolveTitlingEngine` is hard-wired to remotion, so
  `TITLING_ENGINE` and `Brand.videoSettings.titlingEngine` are **not read by the render
  path** — and worse than inert: they are still validated, still persisted, still
  returned by brand routes, and **badged in the UI**. A brand set to `'canvas'`
  displays "engine: canvas" while rendering with remotion. All of
  `services/brandScripts/*.script.js`, `brandScriptRunner.child.js`, and the
  canvas `sharp.resize(fit:'cover')` paths are dead. See `docs/TITLING.md` §0.
  **Exception:** `POST /api/brand/:id/preview-script` forces `engine='canvas'`,
  bypassing the switch — the only route reaching the `vm.compileFunction` escape
  (`ARCHITECTURE_REVIEW.md` GEN-1).
- **`renderViaSpec` + the whole `frontend/client/` tree.** `renderViaSpec`
  (`renderService.js:895`) fetches `${FRONTEND_URL}/ads.html`, but the frontend's
  `netlify.toml` publishes only `frontend/app/dist` and its `/*` fallback
  swallows everything else. Probed live: `/ads.html`, `/templatePreview.js`,
  `/tp-zones.css` all return the **655-byte Vite shell**, byte-identical to `/`.
  So that path loads a React shell, waits for `window.__tpRenderReady`, and times
  out at `RENDER_TIMEOUT` (60s). Blast radius: the **7 legacy templates** in
  `schemas/rsSocialProof.templates.catalog.json` (`creator_endorsement`,
  `product_overlay`, `results_proof`, `review_collage`, `testimonial_overlay`,
  `testimonial_spotlight`, `ugc_split_screen`) are all `status: active`, and none
  starts with `ai_`, so they miss the direct-image block and fall through to
  `renderViaSpec`. By inspection they cannot render. **Not** verified by
  actually rendering one, and **not** checked against the DB for whether any existing
  ad still references them. `ai_*` templates are fine on the direct-image path but
  lose their HTML fallback.
- **Cloudinary video compositing.** `composeVideoOutput` /
  `videoCompositeService` are **not** on the live video path (see the table in §0).
  Reachable only via a static ad with a video source, or `aiOverlayPolishService`,
  which is gated on `AI_OVERLAY_POLISH_ENABLED` = **`false`**
  (`config/defaults.env:59`).
- **`smartCropBbox`.** `renderService.js` (~1321+) still builds a bbox for
  `buildVideoCompositeUrl`, which documents it as "kept for compat; UNUSED in v2
  chain" and discards it. No caller reads the returned value either. `sourceDims`
  from related crop work **is** live.
- **`slotFitCloudinaryUrl`** (`frontend/client/templatePreview.js`) is a
  deliberate no-op. The comment above its call site still claims it chains
  `c_fill,g_auto`. It does not.
- **`pickHeroSourceRatio`** (`layoutInputService.js`) reads
  `registry.CANVAS.templates[template]` — **legacy templates only**. Returns null for
  every `ai_*` template. The live crop insertion point is `buildCloudinaryCropUrl`
  and its winner-selection sites.
- **Telegram.** Gone. Operational alerts are **Slack only**
  (`services/alertService.js`). See §4.

**Puppeteer is static-image-only / scrape-only.** Live HTML path + dead spec path
in `renderService`, image regen, HTML→PNG seed, and `headlessScrapeService`.
Video never launches a browser.

---

## 2. Money invariants — violating these costs real cash

- **Generation POSTs are billable. Submit once.** A replay is only safe on positive,
  *structured* proof the request was rejected before work began — that is
  `isDefinite429` (`atlasVideoService.js`), not `isRateLimit`. `isRateLimit` casts
  wide on purpose and is for **polling**, where retries are free. The decision is one
  pure function, `submitRetryDecision()`, covered by
  `scripts/verifySubmitGuard.js` (31 offline checks, no DB/network/key).
- **`maxRedirects: 0` on every billable POST.** Axios defaults to **21** and re-sends
  the body on 307/308 — a silent double charge inside one call, invisible to retry
  logic.
- **Never trust a model id or a price from memory.** `GET
  https://api.atlascloud.ai/api/v1/models` (no auth) is the catalog; each entry
  carries `schema` and `readme` **URLs** — fetch those, they are the operative
  contract. The price field is **`price.actual.base_price`** (a string), and `actual`
  is what we pay (`origin` is list). Verified live: **0 of 444** entries have a
  `pricing` key, **444 of 444** have `price`. 123 have no `base_price` at all — those
  are per-token LLM entries, which must be treated as "not applicable", never as free.
  Covered by `scripts/verifyImagePricing.js` (9 offline checks, revert-proven).
- **Ledger spend at the charge point, not the success point.** A billable submit that
  then fails still costs money. `atlasImageService.chargedError` records it and sets
  `err.charged`, which is the flag telling a caller that a direct-provider fallback
  means paying twice for one asset.
- **Never print or commit `ATLAS_API_KEY`.**
- Same-model submits are paced by `pacedModelSubmit` (`ATLAS_SUBMIT_SPACING_MS`,
  default 1200ms). It is **in-memory**, so it is not a global limiter across web
  instances; `VEO_CONCURRENCY` is per-process too (`routes/ads.js:147`).
- **Static: each aspect / surface is its own billable image generation.**
  `resolvePreset('meta_static')` / `META_STATIC_FANOUT` = three Meta sizes =
  three image submits (`platformFormats.js:405`, `:576-583`). Cannot crop one
  static plate cheaply — text is burned in-model (`:400-403`).
- **Video: ONE Omni 9:16 master per product on the live presets — not one per
  aspect.** `resolvePreset('meta_video'|'meta_all')` returns
  `videoFormats: [META_VIDEO_MASTER]` only (`platformFormats.js:586-593`);
  `expandDeterministicVideo` queues one Ad per product
  (`campaignAdsGenerationService.js:592-596`). Non-9:16 *Ads* (if any) still
  generate at Omni 9:16 then face-crop at titling (`basePlateCropService`);
  free multi-surface derivation from one master is **Phase 3 intent**, not a
  second billable submit (`platformFormats.js:406-422`). **The older claim in
  this file — that `identityDigest` made 1:1 + 4:5 + 9:16 = three separate
  video submits — was true for non-preset multi-aspect video queues (measured
  in prod 2026-08-01) and is a money bug if reintroduced; it is not the
  `meta_video` path.**
- **`POST /api/ads/runs` must claim atomically** — same money shape as
  `/generate`. Use `claimAdsForRun()` only: `status:'queued'` filter, ownership
  re-read (`campaignRunIds` + `rendering`), `modifiedCount` cross-check, and
  post-claim requeue on throw (`routes/ads.js:645-750`, `:882-902`). Covered by
  `scripts/verifyRunsClaim.js` (67 checks). Do not inline a second claim path.
- **Never leave a paid Omni master in `status:'rendering'`.** Stamp `draft`
  with `veoVideoUrl` before titling (`routes/ads.js:1258-1294`). Titling failure
  → `failed` + keep master; success/no-chrome → finished. Counting an untitled
  master as success is forbidden.
- **"veo" IS A LEGACY NAME — the video model is Omni.** Corrected 2026-08-02.
  `BUILT_IN_DEFAULT_MODEL` is `google/gemini-omni-flash/image-to-video-developer`
  (`atlasVideoService.js:232`) and `ATLAS_VIDEO_MODEL` is **blank** in
  `config/defaults.env`, so that default is what runs. Veo 3.1 is in `MODEL_CAPS`
  but is not selectable. Everything spelled veo — `renderRoute:'veo'`,
  `veoPredictionId`, `veoVideoUrl`, `VEO_CONCURRENCY`, `AI_VEO_FEED`,
  `veoPromptBuilder`, `buildVeoPrompt` — is an Omni pipeline wearing an old name.
  Do not infer the model from any of those identifiers.
- **Every Meta video aspect already renders at Omni 9:16.** Omni's
  `supportedAspectRatios` is exactly `['16:9','9:16']`, and
  `omniFamilyNativeFor()` (`atlasVideoService.js:508`) ends
  `return r < 1 ? '9:16' : '16:9'` — so 4:5 routes to 9:16, and 1:1 also routes
  to 9:16 unless `SQUARE_VIA_OMNI_CROP=false`. The compositor then crops
  face-anchored via `basePlateCropService` + `faceSafeCrop`. The previous claim
  here — that 1:1 and 4:5 "force-route to Grok" — was **false**;
  `ASPECT_FALLBACK_MODEL` (Grok Imagine) is now only the square opt-out and
  explicitly-selected non-Omni models.

### Known open (do not claim fixed)

- **~1-in-3 static ads** render a competitor-shaped brand mark on the product
  (e.g. tree emblem reading as Timberland on an Allbirds shoe). Prompts already
  ask for fidelity — fix is measure-and-reject, not prompt tuning. Video path
  not QC'd on this.
- **`queued` ads never auto-drain** — still require an explicit `/runs` (or
  equivalent) claim.
- **`veoPredictionId` is a spend receipt that is never resumed** — process
  death + re-drain can double-bill Omni for the same ad.
- Meta preview chrome can show placeholder **"Lorem ipsum dolor sit amet"**.

---

## 3. Verified external facts (2026-07-29)

Full detail in `docs/ATLAS.md` §7 and `docs/CLOUDINARY-VIDEO.md`. Headlines:

- **720p and 1080p are the same list price** on Omni. Atlas readme, verbatim: *"720p
  and 1080p are identically priced."* Formula `(4k ? $1 : $0.2) + duration × $0.1`.
  Hence `ATLAS_VIDEO_RESOLUTION=1080p` — no price increase, and it matches every
  `deliveryDims` in `platformFormats.js` (all 1080-wide). 4k is the only tier that
  costs more. **Not** free in render time: Remotion/ffmpeg handle 2.25× the pixels per
  frame, and that has not been measured.
- **Prompt caps.** Omni i2v/r2v: **20,000 characters** (README param table + schema
  description agree). Grok Imagine: **no limit found** in the Atlas README, the Atlas
  schema, or xAI's own docs — our 4096 is product policy, not a published cap. Veo
  3.1: Atlas silent; Google documents **1,024 tokens**, so our 4096-*byte* cap is
  unit-mismatched (moot, Veo is not selectable). Image models: no published max.
- **No image or video generation endpoint supports a system prompt.** All seven
  schemas fetched take a single flat `prompt` (+ `negative_prompt` on Veo only).
  System/user pairs exist **only** at the LLM layer.
- **Cloudinary video: no face gravity.** `g_face` → *"Gravity face not supported for
  video"*. `g_xy_center` → *"not supported for video"*. `fl_relative` on a base asset →
  *"resize marked as relative but not performed on a layer"* (layers only). `g_auto`
  works but is **async**: first request per asset returns **423 `Video tracking-crop is
  pending`**; later variants on that asset resolved in ≤5s. Explicit `c_crop` in pixels
  is synchronous and exact. All probed on **one account, one asset** — see
  `docs/CLOUDINARY-VIDEO.md` for what is measured vs inferred, which matters here.

---

## 4. Repo traps

- **`node_modules` is gitignored but thousands of files are tracked** (added before
  the ignore rule). The vendored tree is **incomplete**: `https-proxy-agent` is
  absent, and requiring any service that pulls in axios can throw
  `MODULE_NOT_FOUND` (observed via `scripts/verifySubmitGuard.js` →
  `atlasVideoService` → axios). Restore with
  `npm install --no-save https-proxy-agent@5.0.1`, then
  `git checkout -- node_modules/.package-lock.json` so the tracked file is not
  committed. Stage explicit paths, never `git add -A`.
- **`config/defaults.env` is committed** and `dotenv`-loaded at boot. It is the real
  source of defaults — `.env.example` is documentation only and several vars there are
  blank while `defaults.env` sets them.
- **Docs have described commented-out code.** `TITLING.md` documented the disabled
  canvas cascade as live. When you find such a case, fix the doc in the same commit.
- **Director concept contract (v3 nested under `routing`).** Schema v3 moved
  strategy fields (`media_picks`, `creative_style`, `output_shape`, …) under
  `concept.routing`. Reading `concept.media_picks` flat silently zeros ads while
  the producer's dual-read validator logs `warnings=0`. **Every consumer must use
  `services/conceptProjection.js` — `conceptField()` / `conceptMediaPicks()`.**
  `scripts/verifyConceptContract.js` (125 checks) exhaustively scans `services/` +
  `routes/` and fails if any file reads a `ROUTING_NESTED_FIELDS` name off a concept
  without the helper. Zero-ads root cause fixed 2026-08-03 (live:
  `concepts=3 payloads=3` where it was `payloads=0`).
- **`mongoose.isValidObjectId` accepts any 12-byte string.**
  Verified: `mongoose.isValidObjectId('video-models') === true` (12 chars);
  `'formats'` is false (7). So `router.param('id'|'adId', …)` 404 guards
  (`routes/ads.js:2105-2112`) **cannot** protect a 12-character named route.
  **Route registration order** is what keeps `/formats`, `/video-models`,
  `/veo-prompt-scaffold`, etc. from falling through to `/:id`. Unknown
  non-ObjectId paths 404; unregistered 12-char names still cast and hit `/:id`.
- **Slack, not Telegram. `res.ok` is not delivery.** `SLACK_BOT_TOKEN` is the
  only secret (Render env on **both** services). Channels are committed in
  `config/defaults.env` (non-secret): `SLACK_ALERT_CHANNEL`,
  `SLACK_ALERT_CHANNEL_FATAL`, and `SLACK_ALERT_CHANNEL_STATUS` (per-run live
  feed — `services/runFeedService.js`; parent `chat.update` + threaded event
  log; fire-and-forget, never on a render path). Slack returns HTTP 200 with
  `{ok:false,error:…}` on logical failure; checking only `res.ok` reports
  success while nothing delivered (`alertService.js:220-222`). Worker boot:
  `🔔 alerts: Slack configured`.
- **`DIRECTOR_UNIVERSE_TOP_N` default is 1** (`config/defaults.env:30`,
  `campaignAdsGenerationService.js:184`). Ceiling stays 10
  (`seededUniverseService` `DEFAULT_TOP_N`); multi-image remains wired;
  operator multi-select widens via `Math.max(mediaIds.length, TOP_N)`
  (`campaignAdsGenerationService.js:2332-2333`). Side effects of universe 1:
  judge `media_utilization` is N/A (`aiJudgeService.js:423-430`); output-shape
  menu narrows to `static_single` only
  (`aiCreativeDirectorService.js:feedOutputShapesForUniverse` `:1050-1055`) so
  the model cannot emit a collage declaring one tile.
- **Customer quotes: `llm-web` is PRINTABLE; attribution is stripped.**
  Prior denylist / "llm-web never prints" claims were **false**.
  `services/providers/geminiSearchProvider.js:254,399` use
  `tools:[{google_search:{}}]`; `:266,411` read
  `groundingMetadata.groundingChunks` — real grounded retrieval, not LLM
  authorship. `verbatim:false` on that origin is a **source-class stamp** ("not
  a first-party scrape"), not a paraphrase confession; it still hard-rejects for
  first-party origins only (`quoteProvenance.js:106-118`; stamp at
  `geminiSearchProvider.js:33`). Callers
  **must** use the return value of `toPrintableCustomerQuote()` (deletes bylines
  + `source` + `verified` — `:120-147`). `synthesized` and `unknown` remain
  rejected. Video titling reuses the same gate in
  `brandScriptExecutor.gateLayoutInputQuotes` / `buildMetaForAd` (`:609-680`) so
  a cached `LayoutInputArtifact` cannot burn a fabricated claim into Remotion
  chrome.
- **Stage telemetry is fire-and-forget.** `services/adStage.js` — **never
  await** (`adStage` sits where Atlas is already billed). Both static and video
  piggyback existing poll ticks (`ATLAS_IMAGE_POLL_MS` 3s,
  `ATLAS_POLL_INTERVAL_MS` 15s) with elapsed + poll count; floor
  `AD_STAGE_MIN_MS` (default 3000, env-only — not in `defaults.env`). No new
  timers. Closed a ~600s blind spot.
- **`perProduct` on `CampaignRun`.** Persisted and returned by
  `GET /api/ads/runs/:runId` (`routes/ads.js:1602`). Reason
  `concepts_no_usable_media` distinguishes "Director returned nothing" from
  "returned concepts but none usable" (`perProductReasons.js:32`). Run-level
  empty messages use real reasons, not a generic imagery blame.
- **`GET /api/ads/formats`** returns `formatCatalog()` verbatim — display-only,
  brand-agnostic, no `brandId` (`routes/ads.js:1998-2000`). Must stay
  registered above `/:id`.

---

## 5. Conventions

- Commit message trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Commit/push **only when asked**. Feature branches only; never push to `main`
  without explicit permission.
- Before pushing non-trivial changes: `node --check` the touched files and run the
  relevant `scripts/verify*.js` harness (**37 scripts** as of 2026-08-03). Add a
  harness for money/security-critical logic, and **revert-prove it** — back the
  fix out and confirm the test fails. A test that cannot fail is not a test.
- Adversarial review on non-trivial diffs: have a second model try to *refute* the
  change (bugs, bypasses, money holes) before committing. It caught two real regex
  bugs in the submit guard that review-by-reading missed.
