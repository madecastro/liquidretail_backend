# CLAUDE.md — liquidretail_backend

Express + Mongoose backend for Reach Social's ad-generation product. Deploys to
**Render** (`liquidretail-backend.onrender.com`). The SPA frontend is a separate repo
(`Emami-RS-Project/liquidretail`, trunk `master`) deployed to **Netlify**
(`staging.reach-social.io`). Trunk here is `main`.

**Read `session.md` for live state. Read `ARCHITECTURE_REVIEW.md` before touching
security, money, or the render queue** — it carries verified P0s with `path:line`.

---

## 00. THE CATALOG PRODUCT-AD PIPELINE — owner-stated, 2026-08-02

**This is the whole architecture for catalog-based product ads. There are no
other generation pathways for them. Do not propose, restore, or "fall back to"
one.** Owner, verbatim: *"We are no longer using ANY other generation pathways
for video or static ads … we are not using any other generation pathways for
catalog based product ads."*

**VIDEO** — one generation, four deliverables:

1. Resize the hero image to **9:16** with the **current** resizing system.
2. **Omni** image-to-video → the 9:16 **master**. `google/gemini-omni-flash/
   image-to-video-developer`. ONE submit per product. See §2 — everything named
   `veo*` is this Omni pipeline under a legacy name.
3. **Crop** the master to **4:5** and **1:1** (`videoCropUrl` +
   `basePlateCropService`, face-anchored). Never a second generation.
4. **Title each surface appropriately** — burned into the delivered file, using
   that surface's own safe zone. Reels (204) and Stories (250) differ and must
   not share one entry.
5. **Preview** the result inside the matching **Meta surface overlay**.

**STATIC** — direct to **gpt-image-2/edit**, one call returns the finished ad
(`directImageRenderService`). No HTML, no Puppeteer, no SVG overlay compositing.

### The overlay is PREVIEW ONLY — and it is not the titling

Two different things, repeatedly confused, so state both:

- **Titling / "chrome"** in `brandScriptExecutor` → `remotionRenderService` **is
  burned into the video**. Correct and intended.
- **The Meta surface overlay** — the simulated IG/FB furniture *including Meta's
  current CTA treatment for that surface* — is **PREVIEW ONLY and MUST NOT be
  burned in**. Owner: *"the meta overlays should include the current meta
  treatment for CTA as those are not burned in the video."* An advertiser
  uploads a clean asset; Meta draws its own UI.

### SCOPE — read this before deleting anything

Exclusivity covers **catalog-based product ads only**. Owner: *"existing
alternate pathways will exist for social media images that get repurposed for
ads."* So the HTML/Puppeteer and canvas paths are **not** automatically dead —
some serve social-image repurposing. Before removing any renderer, prove which
path a given entry point serves. And note `headlessScrapeService` uses Puppeteer
for **scraping**, not generation — it stays regardless.

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
| Which titling engine runs? | `brandScriptExecutor.js:797-806` — returns `'remotion'` **unconditionally**; the cascade below it is inside `/* … */` |
| Which render path runs? | `renderService.js:462` (HTML, `ai_*` only) vs `:510` `renderViaSpec` fallthrough |
| Which video overlay runs? | `routes/ads.js:698` `if (ad.renderRoute === 'veo')` → `renderBrandScriptAndSave`, then **returns**. Never reaches `renderCreative` |
| Which models can a user pick? | `selectable: true` in `MODEL_CAPS`, filtered at `routes/ads.js:1235` |
| Is a feature on? | grep `config/defaults.env` — it is `dotenv`-loaded at boot by `index.js:5` and `worker.js:20` |

Cheap habit: `grep -n "function resolve<Thing>" -A 20` and read the **first**
`return`. If there is a `/*` below it, the docs may describe the comment.

---

## 1. Dead or disabled paths — do not plan work against these

Verified 2026-07-29. Each looks live; none is.

- **Canvas titling engine.** `resolveTitlingEngine` is hard-wired to remotion, so
  `TITLING_ENGINE` and `Brand.videoSettings.titlingEngine` are **not read by the render
  path** — and worse than inert: they are still validated, still persisted, still
  returned by `routes/brand.js:1362,2308`, and **badged in the UI**
  (`TitleStudioCard.tsx:483`). A brand set to `'canvas'` displays "engine: canvas"
  while rendering with remotion. All of `services/brandScripts/*.script.js`,
  `brandScriptRunner.child.js`, and the `sharp.resize(fit:'cover')` calls at
  `brandScriptExecutor.js:387-388`/`:488-489` are dead. See `docs/TITLING.md` §0.
  **Exception:** `POST /api/brand/:id/preview-script` forces `engine='canvas'`,
  bypassing the switch — the only route reaching the `vm.compileFunction` escape
  (`ARCHITECTURE_REVIEW.md` GEN-1).
- **`renderViaSpec` + the whole `frontend/client/` tree.** `renderService.js:791`
  fetches `${FRONTEND_URL}/ads.html`, but the frontend's `netlify.toml` publishes only
  `frontend/app/dist` and its `/*` fallback swallows everything else. Probed live:
  `/ads.html`, `/templatePreview.js`, `/tp-zones.css` all return the **655-byte Vite
  shell**, byte-identical to `/`. So that path loads a React shell, waits for
  `window.__tpRenderReady`, and times out at `RENDER_TIMEOUT` (60s).
  Blast radius: the **7 legacy templates** in
  `schemas/rsSocialProof.templates.catalog.json` (`creator_endorsement`,
  `product_overlay`, `results_proof`, `review_collage`, `testimonial_overlay`,
  `testimonial_spotlight`, `ugc_split_screen`) are all `status: active`, and none
  starts with `ai_`, so `renderService.js:462` excludes them from the HTML path and
  `:510` sends them here. By inspection they cannot render. **Not** verified by
  actually rendering one, and **not** checked against the DB for whether any existing
  ad still references them. `ai_*` templates are fine on the HTML path but lose their
  fallback.
- **Cloudinary video compositing.** `composeVideoOutput` /
  `videoCompositeService` are **not** on the live video path (see the table in §0).
  Reachable only via a static ad with a video source, or `aiOverlayPolishService`,
  which is gated on `AI_OVERLAY_POLISH_ENABLED` = **`false`**
  (`config/defaults.env:40`).
- **`smartCropBbox`.** `renderService.js:1194-1276` reads `CropArtifact` from Mongo,
  validates a bbox, and hands it to `buildVideoCompositeUrl`, which documents it as
  "kept for compat; UNUSED in v2 chain" and discards it. No caller reads the returned
  value either. `sourceDims` from the same block **is** live (caps `workW/workH`).
- **`slotFitCloudinaryUrl`** (`frontend/client/templatePreview.js:1568-1581`) is a
  deliberate no-op. The comment above its call site still claims it chains
  `c_fill,g_auto`. It does not.
- **`pickHeroSourceRatio`** (`layoutInputService.js:1597, 2260`) reads
  `registry.CANVAS.templates[template]` — **legacy templates only**. Returns null for
  every `ai_*` template. The live crop insertion point is `buildCloudinaryCropUrl`
  and its winner-selection sites (`:2292`, `:2329-2340`, `:2439-2462`, `:2540-2542`).

**Puppeteer is static-image-only.** `renderService.js:712` (live HTML path), `:831`
(dead spec path), `adRegenerateService.js:299` (image regen),
`aiImageReferenceService.js:594` (HTML→PNG seed). `headlessScrapeService.js:54` is
scraping. Video never launches a browser.

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
  instances; `VEO_CONCURRENCY` is per-process too (`routes/ads.js:144`).
- **Each aspect ratio is its own billable generation.** `identityDigest` includes
  `aspectRatio`, so 1:1 + 4:5 + 9:16 = three Ads = three video submits. Nothing
  reuses a sibling's `veoVideoUrl`. **Measured in production 2026-08-01:** four
  runs on one campaign/product/media produced four independent submits at 1:1,
  1:1, 4:5 and 9:16 — four unrelated creatives, not one master in four sizes.
- **"veo" IS A LEGACY NAME — the video model is Omni.** Corrected 2026-08-02.
  `BUILT_IN_DEFAULT_MODEL` is `google/gemini-omni-flash/image-to-video-developer`
  (`atlasVideoService.js:231`) and `ATLAS_VIDEO_MODEL` is **blank** in
  `config/defaults.env`, so that default is what runs. Veo 3.1 is in `MODEL_CAPS`
  but is not selectable. Everything spelled veo — `renderRoute:'veo'`,
  `veoPredictionId`, `veoVideoUrl`, `VEO_CONCURRENCY`, `AI_VEO_FEED`,
  `veoPromptBuilder`, `buildVeoPrompt` — is an Omni pipeline wearing an old name.
  Do not infer the model from any of those identifiers.
- **Every Meta video aspect already renders at Omni 9:16.** Omni's
  `supportedAspectRatios` is exactly `['16:9','9:16']`, and
  `omniFamilyNativeFor()` (`atlasVideoService.js:507`) ends
  `return r < 1 ? '9:16' : '16:9'` — so 4:5 routes to 9:16, and 1:1 also routes
  to 9:16 unless `SQUARE_VIA_OMNI_CROP=false`. The compositor then crops
  face-anchored via `basePlateCropService` + `faceSafeCrop`. The previous claim
  here — that 1:1 and 4:5 "force-route to Grok" — was **false**;
  `ASPECT_FALLBACK_MODEL` (Grok Imagine) is now only the square opt-out and
  explicitly-selected non-Omni models. Consequence: the crop-from-9:16 machinery
  the owner asked to reuse already exists and is proven, so one-master fan-out is
  about SHARING a master across sibling Ads, not about building cropping.

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

- **`node_modules` is gitignored but 4930 files are tracked** (added before the ignore
  rule). The vendored tree is **incomplete**: `https-proxy-agent` is absent, and
  requiring any service that pulls in axios threw `MODULE_NOT_FOUND` — observed here,
  from `scripts/verifySubmitGuard.js` → `services/atlasVideoService.js` → axios. Whether
  a fresh clone + `npm ci` hits the same thing is untested, but the tracked tree is
  demonstrably missing the package. Restore with
  `npm install --no-save https-proxy-agent@5.0.1`, then
  `git checkout -- node_modules/.package-lock.json` so the tracked file is not
  committed. Stage explicit paths, never `git add -A`.
- **`config/defaults.env` is committed** and `dotenv`-loaded at boot. It is the real
  source of defaults — `.env.example` is documentation only and several vars there are
  blank while `defaults.env` sets them.
- **Docs have described commented-out code.** `TITLING.md` documented the disabled
  canvas cascade as live. When you find such a case, fix the doc in the same commit.

---

## 5. Conventions

- Commit message trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Commit/push **only when asked**. Feature branches only; never push to `main`
  without explicit permission.
- Before pushing non-trivial changes: `node --check` the touched files and run the
  relevant `scripts/verify*.js` harness. Add a harness for money/security-critical
  logic, and **revert-prove it** — back the fix out and confirm the test fails.
  A test that cannot fail is not a test.
- Adversarial review on non-trivial diffs: have a second model try to *refute* the
  change (bugs, bypasses, money holes) before committing. It caught two real regex
  bugs in the submit guard that review-by-reading missed.
