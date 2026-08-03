# CLAUDE.md — liquidretail_backend

Express + Mongoose backend for Reach Social's ad-generation product. Deploys to
**Render** (`liquidretail-backend.onrender.com`). The SPA frontend is a separate repo
(`Emami-RS-Project/liquidretail`, trunk `master`) deployed to **Netlify**
(`staging.reach-social.io`). Trunk here is `main`.

**Read `session.md` for live state. Read `ARCHITECTURE_REVIEW.md` before touching
security, money, or the render queue** — it carries verified P0s with `path:line`.

Live prod (2026-08-03) = `13cf679` (both services). Offline verify suite = **42
scripts, all green** (re-run 2026-08-03 with
`for f in scripts/verify*.js; do node "$f" || echo "FAIL $f"; done` — there is
no aggregate runner and no `npm test`). Claims written against pre-deploy
binaries are suspect.

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
**deferred, not missing.**

**FULL PR #61 camera-prompt ROLLBACK (owner 2026-08-03, commit `be5b83f`):**
Commit `134db56` added three camera-prompt changes in
`services/veoPromptBuilder.js`; **all three are reverted**. Owner, verbatim:
*"This is creating additional hallucinations and the previous output was
better."* The three reverted pieces: (1) Scene 3 "RETURN TO THE PRIMARY VIEW"
+ two PRODUCT FIDELITY sentences claiming the FINAL reference repeats the
primary view; (2) the `subjectContinuity` directive (both `OMNI_DIRECTIVES`
and `GROK_DIRECTIVES`, plus its `lines.push` in `buildVeoPrompt`); (3) the
crossfade-vs-long-dissolve policy rewording. **Mechanical acceptance test:**
the file now differs from `git show 134db56~1:services/veoPromptBuilder.js` in
exactly **two hunks**, both comment/export only (`OMNI_DIRECTIVES` /
`GROK_DIRECTIVES` module exports for harnesses + the rollback comment block) —
**zero prompt-string hunks.** Pinned by `scripts/verifyPostPilotBatch.js`
(B1–B14); **B14** rebuilds the prompt from the `134db56~1` source out of git
and asserts byte-identity. **CRITICAL — the restored text is deliberately
self-contradictory:** `transitions` permits "Smooth crossfades only, ~0.25s"
while `doNot` bare-bans "dissolves", and a crossfade **is** a short dissolve.
Owner-confirmed: that contradictory prompt is the version that produced better
output. **Anyone "fixing" the contradiction is reintroducing the
regression.** Do not soften, split, or reword either string to resolve it.

**Primary-reference repeat is default OFF** (same day / same reason): both the
code default (`isRepeatPrimaryReferenceEnabled`, `atlasVideoService.js:829`)
and `config/defaults.env` `REPEAT_PRIMARY_REFERENCE=false`. Default stack =
the first **3 DISTINCT** refs with nothing appended. Turning the repeat off
removed the only clamp on that branch (`REPEAT_PRIMARY_TOTAL_CAP=4` applies
**only** to the opt-in flag-on path), which would have let
`videoSettings.referenceImageCount=7` ship seven refs against the owner's
"too many images hallucinated" finding — so **`MAX_DISTINCT_REFERENCES=5`**
(`atlasVideoService.js:813`) is the new hard ceiling on the default branch.
`REPEAT_PRIMARY_TOTAL_CAP=4` still applies only when the flag is explicitly on.

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
  **The former exception is now CLOSED (2026-08-03).**
  `POST /api/brand/:id/preview-script` used to reach the `vm.compileFunction` escape
  via **three** doors, not one: `body.script` (forces `'canvas'`), the
  `body.engine:'canvas'` hatch (which short-circuits *before* `resolveTitlingEngine`
  is consulted), and a `styleScript*` persisted earlier through the unvalidated
  `PATCH /api/brand/:id` allow-list and then previewed with `{engine:'canvas'}` and no
  `body.script` at all. An `engine !== 'remotion'` → 400 guard immediately after the
  engine resolution (`routes/brand.js`, search `SECURITY (GEN-1)`) closes all three
  and stays closed if `resolveTitlingEngine` is ever un-hardwired. **No HTTP route
  reaches `runChild` now**; `scripts/testBrandScript.js` still does by design, which
  is why `brandScriptRunner.child.js` cannot simply be deleted. Pinned by
  `scripts/verifyPreviewScriptGuard.js` (8 checks; removing the guard fails 3).
  Note the original prescribed fix — delete the `bodyScript` branch — was
  **insufficient**, leaving a two-request exploit; and `parsingContext` would not have
  helped either, because the injected params are parent-realm objects
  (`helpers.clamp.constructor("return process")()` escapes a fresh context).
  See `ARCHITECTURE_REVIEW.md` GEN-1.
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
- **The `/generate` concurrency gate is the ONLY double-click protection, and the
  atomic claim does NOT back it up.** Each expansion mints its OWN ads
  (`identityDigest` scoped via `generationRunId`), so two runs on the same product
  never race for a row — they each claim what they just created and both bill.
  Since 2026-08-03 the gate allows CONCURRENT runs whose product sets are
  **disjoint** and blocks overlap (`services/generationGate.js`,
  `scripts/verifyGenerationGate.js` — 65 checks, four revert-proven). Rules that
  are load-bearing, not stylistic: (a) keyed on `productIds` **only** — never on
  format/preset, because presets fan out (`meta_all` ⊃ `meta_static` surfaces) so
  two same-product runs with different presets CAN expand the same
  (product, template, aspect) into two differently-digested ads = one creative,
  two charges; (b) **fail-closed** — any run or request whose scope is unreadable
  blocks, which is why `CampaignRun.requestedProductIds` must be stamped at mint
  time by EVERY creator (`/generate` from the body, `/runs` from the claimed ads,
  and `[]` — not a partial list — when any claimed ad lacks a `productId`);
  (c) **mint-then-verify** after `CampaignRun.create` closes the read-then-write
  race where two clicks both read an idle campaign; both racers compute the same
  winner via (`createdAt`, `runId`) and the loser aborts before expanding, so a
  false abort costs a 409 and nothing else.
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
- **Static geometry — two defects FIXED 2026-08-03; read the diagnostic before
  re-opening.** (A) `staticAdIntents.computeSurface` combined the post-generation
  crop band with the 6% edge margin via `Math.max`, so on every *cropped* surface
  the margin collapsed to zero and the safe box handed to the image model *was*
  the crop line. Proof needing no model compliance: the composited logomark
  shipped **flush to the delivered frame edge** on Stories and 4:5 — inspectable
  in any ad delivered before the fix. (B) `GEN_SIZES` was stale (three sizes;
  the live schema enum has 14), so 9:16 generated at `1024x1536` and lost 80px per
  side. All live static surfaces now generate at their exact delivery aspect —
  zero crop. Pinned by `scripts/verifyStaticSafeBox.js`.
  **DIAGNOSTIC, and it matters:** `meta_feed_1_1` was immune to *both* defects
  (zero crop, full 61px margin) and it is the **default** surface
  (`directImageRenderService.js:508,516`). So truncated copy on a **square** ad is
  *not* this bug class — it is the model disregarding the percentage box. Use the
  surface signature to split geometry from model non-compliance before re-opening
  size work.
  **Non-enum sizes need a live probe, not the schema prose.** The schema's
  "arbitrary resolutions divisible by 16" clause is spliced from OpenAI's docs and
  carries an unpublished pixel/edge-limit caveat. `1088x1360` (4:5) is in use only
  because it was probed; the risk being guarded is silent coercion to the
  `1024x1024` default, which would square a 4:5 surface and then crop it.
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
  source of non-secret defaults — `.env.example` is documentation only and several
  vars there are blank while `defaults.env` sets them. **Secrets stay in the
  Render dashboard only** (migration COMPLETE 2026-08-03 — see §4a). Precedence:
  process env wins; a dashboard var of the same name **always shadows** the file.
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
- **`DIRECTOR_UNIVERSE_TOP_N` default is 1** (`config/defaults.env:35`,
  `campaignAdsGenerationService.js:195`). Ceiling stays 10
  (`seededUniverseService` `DEFAULT_TOP_N`); multi-image remains wired;
  operator multi-select widens via `Math.max(mediaIds.length, TOP_N)`
  (`campaignAdsGenerationService.js:2343-2345`). Side effects of universe 1:
  judge `media_utilization` is N/A (`aiJudgeService.js:423-430`); output-shape
  menu narrows to `static_single` only
  (`aiCreativeDirectorService.js:feedOutputShapesForUniverse` `:1050-1055`) so
  the model cannot emit a collage declaring one tile.
- **`TOP_N=1` IS NOT THE DEFAULT-IMAGE-SEED RULE — `preferFirstCatalogImage`
  is, and the rule is "the FIRST IMAGE THAT CAME FROM THE CATALOG", not the
  `imageRole:'hero'` label.** This file, `config/defaults.env`,
  `docs/PIPELINES.md` and two code comments all called TOP_N=1 the "Hero-image
  default" for a day. It never was. `buildSeededUniverse`'s auto-assembly
  branch merges catalog media **and** `product_match` UGC into ONE pool and
  ranks it by `classification.shotType` first (`seededUniverseService.js:96` →
  `shotTypeRank.js:15-23`: lifestyle → on_model → flat_lay → product_only →
  detail → packaging → unknown); `metadata.imageRole === 'hero'` is only a
  **within-tier tiebreak**, key #2 of 4. So TOP_N=1 trims a shotType-ranked pool
  to one entry and that entry was routinely a lifestyle catalog **ALT** or a
  **UGC post**. Owner, verbatim 2026-08-03: *"I actually just want to use the
  first image that comes from the catalog not the 'hero' image since that may
  also come from social media or UGC?"* Implemented by the opt-in
  `opts.preferFirstCatalogImage` → `promoteFirstCatalogImage`
  (`seededUniverseService.js:178`, applied `:504`) — a pure, non-mutating
  **CASCADE** applied to the ranked wrappers before `projectEntry()` and before
  the top-N trim. **Every tier is gated on `role === 'catalog'`, so it can never
  resolve to UGC:** (1) first `role==='catalog'` + `imageRole==='hero'` entry —
  that stamp is written only by `catalogProductDetectService:60` off
  `CatalogProduct.imageUrl`, i.e. the feed's first image (`:80`/`:513` write
  `'alt'`; the only other writer is `shopifyPublicIngestService.js:526`, which
  writes `'video'`); (2) else the **earliest-`createdAt` `role==='catalog'`
  entry** — this tier is the fix: the stamp can be **absent** (materialisation
  failed, legacy row), and a tier-1-only rule then fell through to the shotType
  ranking over that merged pool, which is exactly how a UGC post became the
  default; (3) else no promotion. Tier-2 ties use a strict `<` so the earlier
  entry in ranked order keeps index 0, and a missing/unparseable `createdAt`
  maps to `Infinity` (sorts last, never wins "earliest"). Deliberately mirrors
  the video rail's cascade at `campaignAdsGenerationService.js:2085`. Passed
  only for image runs with no operator picks
  (`campaignAdsGenerationService.js:2388`). Deliberately **not** applied in the
  `restrictToMediaIds` branch (operator picks ARE the override) or in brand-only
  mode (every SKU's catalog media is pooled, so "the catalog's first image" is
  undefined). `scripts/verifySeededUniverseHeroDefault.js` (111 checks) pins all
  of it, including that the promotion is **not** folded into the shared
  `rankMergedPool` — that would silently re-order operator picks. Details:
  `docs/PIPELINES.md` §5 *Seed selection — image vs video*.
- **Static regenerate RE-DERIVES the catalog-first seed
  (`REGEN_RESEED_CATALOG_FIRST`, default ON).** Ship in `be5b83f`.
  `services/adRegenerateService.js` used to **replay** the stored
  `Ad.mediaIds` stack forever, so ads queued under `TOP_N=10` still sent 3+
  refs on every regen. **NOT a trim:** historical stacks were shotType-ranked
  LIFESTYLE-FIRST over a catalog+UGC merged pool, so `mediaIds[0]` is often a
  UGC post and trimming would lock a social image in. Instead it re-derives
  via the same cascade as generation-time catalog-first: imageRole hero →
  earliest-`createdAt` catalog entry → nothing. **Every query is pinned to
  `source:'catalog-product'` + the ad's own product AND brand**
  (`deriveFirstCatalogMediaId`, `adRegenerateService.js:215-261`); a catalog
  **VIDEO** can never win (`fileType === 'video'` and
  `metadata.imageRole === 'video'` are both rejected —
  `isCatalogMediaForProduct` `:150-172`). An unusable/missing `fileUrl` is an
  **honest skip** (tier 3 / `NO_CATALOG_MEDIA`), not a silent fallback to the
  ad's original seed (that path would re-lock the UGC seed while logging
  success). **Gates:** `variantKind === 'product_image'` only (owner: *"UGC
  ads shouldn't be affected by this change, we haven't optimized that path
  yet"*); skipped when `Ad.referenceMediaIds` is non-empty (operator pick
  always wins); video regenerates never reseed. **Nothing is persisted back
  onto the Ad** — the derived stack is render-call-only, so the kill switch
  (`REGEN_RESEED_CATALOG_FIRST=false`) stays effective on the next regen.
  Pinned by `scripts/verifyRegeneration.js` (R3 / R3b / R3c).
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

## 4a. Render dashboard vs `config/defaults.env` (migration COMPLETE 2026-08-03)

Owner rule, verbatim: *"The dashboard in render should only contain secrets,
everything else should be editable outside of the dashboard."*

**PRECEDENCE — the trap that caused the half-done rollout.**
`index.js:1-5` and `worker.js:18-20` load the process environment **first**
(Render dashboard / local `.env`) and `config/defaults.env` **second**.
`dotenv` **never overrides an already-set var**. A dashboard var always wins;
a value in `defaults.env` is the **effective** value only when no dashboard
var of that name exists. **Diagnostic for a silent config lie:** a var set in
**both** places with **different** values. Next-session check: compare the
live dashboard key list against
`grep -oE '^[A-Z_][A-Z0-9_]*=' config/defaults.env` — any intersection whose
values disagree is lying about what prod runs.

**Migration status: FINISHED 2026-08-03** (was half-done; the file header used
to say "until the migrated vars are removed from the Render dashboard, they
shadow these defaults"). Verified live in the Render dashboard:

| Service | id | Before → after |
|---|---|---|
| WEB | `srv-d1vuktqli9vc73ft07ng` | 64 env vars → **23** (41 deleted) |
| WORKER | `srv-d8128c1o3t8c73e8kb30` | 24 env vars → **14** (10 deleted) |

Every deleted key existed in `config/defaults.env` with an **identical**
value, so the deletions were runtime no-ops — **except one** (below).

**Delete rule (load-bearing):** only delete a dashboard var that exists in
`config/defaults.env` with an **identical** value. A dashboard-only var must
be **migrated into the file first**, never just deleted — or the value is
lost with nothing to fall back on. That is why **`JIRA_PROJECT_KEY` was
RETAINED** even though it is not a secret: it does not exist in
`config/defaults.env`.

**What stays on the dashboard:** secrets only, plus `JIRA_PROJECT_KEY`.

**The per-key list is DELIBERATELY NOT REPEATED HERE.**
`docs/PIPELINES.md` §9 *"Stays in Render env"* is **canonical** — it carries the
full table with per-service (WEB / WORKER) columns and what each key is for.
Two copies of a 37-key list will drift, and a stale list here is worse than no
list: someone would trust it while deleting a dashboard var. This section owns
the *rules* (precedence, the delete rule, the counts, the one non-no-op); §9
owns the *inventory*. Keep it that way.

Note the audience split, which is why this is written in both places at all:
`CLAUDE.md` is read by Claude sessions, but env vars are edited by humans and by
other agents (Grok edits this repo directly and reads `docs/PIPELINES.md`, not
this file). The rule has to be findable from either direction — the inventory
only needs to exist once.

**The one non-no-op: `RENDER_CONCURRENCY`.** The dashboard pinned **4** while
the file said **8**. Earlier docs ("defaults raised 2026-08-02: RENDER 4→8")
described the **file** change only — production stayed at 4 for a day because
the dashboard shadowed it. Owner chose to delete the dashboard copy on
2026-08-03, so the file's **8 is now live** on the web service. Render
concurrency **doubled 4→8 on 2026-08-03 as a consequence of this cleanup**,
not as a separate tuning decision. Re-measure before going higher
(`services/concurrency.js`).

---

## 5. Conventions

- Commit message trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Commit/push **only when asked**. Feature branches only; never push to `main`
  without explicit permission.
- Before pushing non-trivial changes: `node --check` the touched files and run the
  relevant `scripts/verify*.js` harness (**42 scripts** as of 2026-08-03). Add a
  harness for money/security-critical logic, and **revert-prove it** — back the
  fix out and confirm the test fails. A test that cannot fail is not a test.
- Adversarial review on non-trivial diffs: have a second model try to *refute* the
  change (bugs, bypasses, money holes) before committing. It caught two real regex
  bugs in the submit guard that review-by-reading missed.
