# CLAUDE.md — liquidretail_backend

Express + Mongoose backend for Reach Social's ad-generation product. Deploys to
**Render** (`liquidretail-backend.onrender.com`). The SPA frontend is a separate repo
(`Emami-RS-Project/liquidretail`, trunk `master`) deployed to **Netlify**
(`staging.reach-social.io`). Trunk here is `main`.

**Read `session.md` for live state. Read `ARCHITECTURE_REVIEW.md` before touching
security, money, or the render queue** — it carries verified P0s with `path:line`.

Live prod (2026-08-11) = **`5d02debe`** (both services — WEB
`srv-d1vuktqli9vc73ft07ng`, WORKER `srv-d8128c1o3t8c73e8kb30`). Offline verify
suite = **101 scripts, all green**. Re-run with
`for f in scripts/verify*.js; do node "$f" || echo "FAIL $f"; done` — there is
no aggregate runner and no `npm test`. Two worktree gotchas that cost real time:
the committed `node_modules` subset is incomplete (no native `sharp`, so
`verifyLogoSilhouette.js` fails until you run `npm install` in the worktree —
`NODE_PATH` alone will not fix it, since Node resolves the local `node_modules`
first), and **macOS has no `timeout` binary**, so a loop wrapping each script in
`timeout` reports all 101 as failed. Claims written against pre-deploy binaries
are suspect. **A red harness in a local checkout is not necessarily red
on `main`** — this tree carries other sessions' uncommitted work, so confirm
against a clean worktree off `origin/main` before believing a failure (or a pass).

---

## 00. THE CATALOG PRODUCT-AD PIPELINE — owner-stated, 2026-08-02

**This is the whole architecture for catalog-based product ads. There are no
other generation pathways for them. Do not propose, restore, or "fall back to"
one.** Owner, verbatim: *"We are no longer using ANY other generation pathways
for video or static ads … we are not using any other generation pathways for
catalog based product ads."*

**VIDEO (Meta)** — one billable generation (9:16 master) plus **three FREE
derivatives** of it: feed 1:1, feed 4:5, and a Reels 9:16 retitle. Four Meta
video Ads per product, **one** Omni submit. The fan-out was documented as
"Phase 3 intent" from 2026-08-02 until 2026-08-11, when PMax's derive path
(`deriveFromMaster` → `renderDeriveOnlyVideoAd`) made it buildable — it is
platform-agnostic, so this is the original intent finally wired up, not a new
capability.
**VIDEO (Google PMax, Phase A)** — **two** billable Omni masters (9:16 + 16:9)
plus one free derive-only 1:1 crop of the 9:16 master — see §2 and
`docs/PIPELINES.md` §6. Do not apply the Meta one-master rule to `google_video`.

1. Resize the hero image to **9:16** with the **current** resizing system.
2. **Omni** image-to-video → the 9:16 **master**. `google/gemini-omni-flash/
   image-to-video-developer`. ONE billable submit per product on live **Meta**
   presets (`meta_video` / `meta_all` queue `videoFormats: [META_VIDEO_MASTER]`
   only). See §2 — everything named `veo*` is this Omni pipeline under a legacy
   name.
3. **Crop** for non-9:16 targets via `videoCropUrl` + `basePlateCropService`
   (face-anchored) at titling time — never a second Omni submit. **The Meta
   fan-out IS the queue path as of 2026-08-11:** `resolvePreset('meta_video')`
   still returns the master only (that is the BILLABLE list and must not
   change), and `expandWizardJob` then mints `META_VIDEO_DERIVATIVES`
   (`meta_feed_1_1`, `meta_feed_4_5`, `meta_reels_9_16`) each carrying
   `deriveFromMaster: 'meta_stories_9_16'`. ⚠️ **Four video Ads, ONE submit.**
   The old warning still stands in its real form: four ads is correct, four
   *submits* is the money bug. The `deriveFromMaster` field is the entire
   difference — dropping it turns three free crops into three ~$0.90 charges
   per product. Pinned by `scripts/verifyMixedPlatformVideo.js` H3.
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
`platformFormats.js:576-583`). **`ai_brand_led`** (when `STATIC_BRAND_LED_COPY`
is on, default true) resolves to its own `brand_led` intent
(`staticAdIntents.js:533-562`) with a BRAND LINE + SUBHEAD + TRUST MARK + CTA
contract and a copy cascade in `buildIntentData` (Director →
`layoutInput.copy` → `brand.tagline` for headline; Director →
`layoutInput.copy.subheadline` for subhead; case-insensitive dedupe). Flag-off
restores a **byte-identical** pre-change prompt (`TEMPLATE_INTENT` entry + both
cascades + SUBHEAD role revert together). `ai_ugc_led` / `ai_editorial` still
fall to `product_first_lifestyle` (unmapped). Full write-up:
`docs/PIPELINES.md` §5 *Brand-led intent + copy cascade*.

**WHICH TEMPLATE an ad becomes is the DIRECTOR's choice, not the operator's —
and the wizard no longer offers a template picker at all.** The frontend hardcodes
all five `ai_*` ids into every request (`GenerateAds/index.tsx`
`DEFAULT_TEMPLATE_IDS`; the Settings step was dropped 2026-06-12, `52cf33c`), and
under `AI_CONCEPT_DRIVEN=true` the *actual* template comes from the Director's
`routing.creative_style` via
`CREATIVE_STYLE_TO_TEMPLATE[style] || 'ai_brand_led'`
(`campaignAdsGenerationService.js`) — so an unrecognised or absent style silently
becomes **`ai_brand_led`**. That default, plus a round prompt whose entire
creative_style guidance was one bare enum line, is why production measured
**`ai_brand_led` 200+ renders vs `ai_social_proof_led` 18** over
2026-07-30..08-06. The string `social_proof_led` appeared exactly **once** in
`aiCreativeDirectorService.js` (the enum) and in **zero** prompt guidance.
Fixed 2026-08-10: `buildPromptRound` now carries per-style selection criteria
(with `brand_led` explicitly named the *default of last resort*),
`creative_style` is a listed concept-diversity axis, and when proof data exists
a **reserved slot** requires ≥1 of the 3 concepts to be `social_proof_led`.
**The reserved slot fires only on a RATING being reachable, not on any proof** —
`INTENTS.social_proof_led.eligible` is rating-only, so reserving a slot on the
strength of a quote or comment alone would mint `ai_social_proof_led` on products
that then fall back at render, *amplifying* the collapse this fixes (adversarial
finding; pinned by A5b). That condition is a strict subset of "the HONESTY RULE
does not fire" — **the two must never both be active**, or the prompt demands a
proof concept while forbidding proof (the self-contradictory-prompt class that
forced the §00 PR #61 rollback). The `proof_options` term is gated on the **same
flag** as the honesty rule's `proof_options` clause, so a stale or injected
summary cannot desynchronise them (pinned by A6b).
`DIRECTOR_PROOF_MENU_ENABLED` is now **true** (`config/defaults.env`), which is
what lets a product-scoped run ground a proof concept on scope-labelled brand
numbers; flipping it back off restores the pre-change prompt byte-for-byte,
**including** the original honesty-rule string. Paired with
**`DIRECTOR_SIGNALS_VERSION` 3.1.0 → 3.2.0**. ⚠️ **Scope of that bump, stated
correctly because an earlier version of this note got it wrong:** the LIVE path
`directConceptsRound` has **no** `signalsVersion` cache gate and re-assembles
every round, so the menu takes effect with or without the bump. The only gate is
at `aiCreativeDirectorService.js:262` in the **shadow** `directConcepts` path —
so the bump buys shadow correctness and costs one paid re-derive per shadow cache
key, and is **not** what makes the flip work. Pinned by
`scripts/verifySocialProofRestoration.js` groups A/B.

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
  contract. The price field is **`price.actual.base_price`** (a string; `origin` is
  list). Verified live: **0 of 444** entries have a `pricing` key, **444 of 444** have
  `price`. 123 have no `base_price` at all — those are per-token LLM entries, which
  must be treated as "not applicable", never as free.
  Covered by `scripts/verifyImagePricing.js` (9 offline checks, revert-proven).
- **`base_price` IS NOT THE CHARGE — never quote it as a cost. CORRECTED
  2026-08-03; this file previously said `actual` "is what we pay", and that was
  wrong by 7x.** MEASURED over 40 live edits: `openai/gpt-image-2/edit` publishes
  base_price **0.01** and charged **$0.07173** every single time; the
  `openai/gpt-image-2-developer/edit` variant publishes **0.005** and charged
  **$0.03586**. So the 50% discount is real, but a multiplier (~7.17x here) applies
  on top of both, it is not derivable from the catalog, and it must not be
  extrapolated to another model or another size/quality. A 3-surface `meta_static`
  fanout is therefore **~$0.11 per product on the developer model**, not ~$0.015.
  **Owner rule: always read the actual price back from Atlas after generation.** The
  authoritative figure is `price` on the **settled prediction**
  (`GET /model/prediction/:id`). **Images:** `scheduleCostReconcile`
  (`atlasImageService`) upgrades the row and clears `costSource:'estimated'`.
  Atlas usually publishes `price` *after* the image returns — measured **7 of 38**
  predictions had it at completion — so the scheduled re-poll is the normal path
  for images; its retry budget was widened the same day for exactly that reason.
  **Video (post-Phase-B):** the same rule is now implemented in
  `atlasVideoService` — `reconcileVideoCostFromTerminal` (fire-and-forget after the
  master lands) + `scheduleVideoCostReconcile` fallback. **Before this, every video
  row stayed the `estimateRenderCostUsd` formula forever** (~33% over-report on the
  developer model at 10s: formula $1.20 vs measured settled **$0.90** — over-
  REPORTING, not overspending). Video **does** publish `price` at completion
  (measured), so the immediate path is the normal one and the re-poll is the
  exception. `MODEL_CAPS` / the estimate function are deliberately unchanged (pre-
  settlement floor). Pinned by `scripts/verifyVideoCostReconcile.js`.
  **Consequence:** a video row still on `costSource:'estimated'` means the price
  was **never published**, not that the formula is authoritative. Do not quote
  `base + per-second` as spend for the developer model. `buildPriceMap` yields a
  floor-grade estimate whose only job is to stop a $0.00 row. Any budget, margin
  or per-ad cost claim must come from **reconciled** rows.
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
- **Video (Meta): ONE Omni 9:16 master per product — and FOUR Ads.**
  `resolvePreset('meta_video'|'meta_all')` returns
  `videoFormats: [META_VIDEO_MASTER]` only (`platformFormats.js`) — that is the
  billable list and must stay length 1. `expandWizardJob` then mints three FREE
  derivative Ads (`META_VIDEO_DERIVATIVES`: feed 1:1, feed 4:5, Reels retitle),
  each carrying `deriveFromMaster: 'meta_stories_9_16'` so they route through
  `renderDeriveOnlyVideoAd` and never reach Omni. Gated on the 9:16 master
  actually being in the run — a 1:1 or 4:5 window fits inside a portrait frame,
  so those crops are honest, but deriving them from a squarer master would be
  cropping up. An operator hand-picking a single non-9:16 Meta surface in
  Advanced still gets exactly one Ad at its own aspect, unchanged. **The older
  claim in this file — that `identityDigest` made 1:1 + 4:5 + 9:16 = three
  separate video submits — was true for non-preset multi-aspect video queues
  (measured in prod 2026-08-01) and is a money bug if reintroduced; it is not
  the `meta_video` path.**
- **Video (Google PMax, Phase A 2026-08-10): TWO billable Omni masters per
  product — 9:16 + 16:9 — not one, and not three.**
  `resolvePreset('google_video'|'google_all')` returns
  `videoFormats: GOOGLE_VIDEO_MASTERS` only (`['pmax_video_9_16','pmax_video_16_9']`);
  do **not** return the full `GOOGLE_VIDEO_FANOUT`. `pmax_video_1_1` is
  **derive-only**: face-safe crop of the settled 9:16 master's already-paid
  plate + its own Remotion titling — **never** an Omni submit. One extra Ad is
  minted with `deriveFromMaster: 'pmax_video_9_16'`. Full write-up:
  `docs/PIPELINES.md` §6 *Google Performance Max video*.
- **`pmax_video_1_1` must never reach a billable submit.** Gate is
  `resolveDeriveFromMaster(ad)` in `services/campaignAdsGenerationService.js` —
  **one definition, imported** by `routes/ads.js` (render) and
  `adRegenerateService.js` (regenerate preflight → 409). Fail-closed on
  `platformFormat === 'pmax_video_1_1'` so a dropped `deriveFromMaster` field
  cannot re-open spend. Master failed/absent → honest failure, never Omni
  fallback. Wait in-render for the plate (`DERIVE_MASTER_WAIT_MS` /
  `DERIVE_MASTER_POLL_MS`); do not requeue (stranded `queued` never auto-drains
  and a second Generate short-circuits as "Nothing to render"). Pinned by
  `scripts/verifyPmaxVideoExpansion.js` (54 checks).
- **Duration on the video identity digest is Google-only.**
  `computeDeterministicVideoDigest` keeps prefix `det-video:v1` and appends
  `videoDurationSec` **only** for Google PMax video formats (zero history). An
  earlier draft appended duration unconditionally and bumped `v1`→`v2` —
  MEASURED that changed every pre-existing Meta video digest; because the
  digest deliberately omits `generationRunId`, the `(campaignId, identityDigest)`
  unique index is the only guard against a repeat Generate re-billing Omni, so
  the next Generate on any existing campaign would have paid ~$1.00–1.20 per
  product again. Pre-existing Meta digests stay byte-identical. **Meta 8s→10s
  duration identity is a deliberate one-time re-mint that must be costed and
  flagged, never folded in silently.**
- **Static (Google): `google_static` = 3 billable image submits**
  (`GOOGLE_STATIC_FANOUT` — landscape 1.91:1, square, portrait 4:5). Demand Gen
  + Shorts keys stay `coming_soon` (identical `deliveryDims` to live PMax —
  generating both would double-spend).
- **MEASURED settled prices (Phase B 2026-08-10/11, prompt-only Atlas submits
  — no DB/Ad rows). These supersede planning estimates:**
  | item | settled `price` |
  |---|---|
  | static 1:1 @1024×1024 `gpt-image-2/edit` | **$0.071728** |
  | static 1.91:1 @2048×1152 | **$0.061440** |
  | static 4:5 @1088×1360 | **$0.066660** |
  | video 10s 16:9 @1080p Omni **developer** | **$0.90** |
  3-size PMax static fan-out ≈ **$0.199**/concept (was ~$0.22). Two masters =
  **$1.80**. Full kit (3 concepts × 3 statics + 2 masters) ≈ **$2.40**
  standalone / ≈ **$1.50** marginal beside a Meta run that already paid for
  9:16. Earlier ≈**$2.6** planning figure is **wrong**.
- **Omni developer 10s is $0.90, not $1.20.** The `MODEL_CAPS` formula
  (`base 0.20 + 0.10/s` → $1.20 @ 10s) **overstates the developer variant by
  ~33%**. Production default is
  `google/gemini-omni-flash/image-to-video-developer`
  (`BUILT_IN_DEFAULT_MODEL`). Do not quote $1.20 for it.
- **Image `size` enum is the `1024x1024` form** (underscore style). A
  `1024*1024` submit is rejected 400 "invalid size". `2048x1152` **is** an
  enum member (Phase A `GEN_SIZES` needed no probe). Omni i2v
  `aspect_ratio` enum exactly `['16:9','9:16']`; `duration` enum
  `[4,6,8,10]`. Delivered 16:9: **1920×1080, 10.000s, 240 frames**.
- **`POST /api/ads/runs` must claim atomically** — same money shape as
  `/generate`. Use `claimAdsForRun()` only: `status:'queued'` filter, ownership
  re-read (`campaignRunIds` + `rendering`), `modifiedCount` cross-check, and
  post-claim requeue on throw (`routes/ads.js:645-750`, `:882-902`). Covered by
  `scripts/verifyRunsClaim.js` (67 checks). Do not inline a second claim path.
- **The `/generate` gate is keyed on the REQUEST FINGERPRINT, not on products
  (owner directive 2026-08-10). It is the ONLY double-click protection for
  STATIC, and the atomic claim does NOT back it up.** Each static expansion mints
  its OWN ads (`identityDigest` scoped via `generationRunId`), so two runs on the
  same product never race for a row — they each claim what they just created and
  both bill. Owner: *"don't block ads that are concurrent based on the product
  alone, but based on the actual request. So block identical requests and note
  requests that are identical to previous requests but allow them if the user
  wants."* History: one-run-per-campaign → product-overlap (2026-08-03) →
  fingerprint (2026-08-10). Rules that are load-bearing, not stylistic:
  - **(a) The key is `computeRequestFingerprint`** — a hash over exactly the body
    fields that change what gets generated. **A field the handler does not read
    must stay OUT**: the wizard posts `expandVideoFormats` and `routes/ads.js`
    never destructures it, so including it would make two runs that produce
    identical creative hash differently and let a real double-click through. The
    inverse (omitting a field that DOES affect output) causes a false block. Order
    matters per field: `productIds`/`templateIds` sorted, `mediaIds`/`seedPicks`/
    `seedMediaIds` order-preserved (a different pick order is a different ad).
  - **(b) Why dropping product-overlap is not a money regression.** VIDEO cannot
    double-bill across runs at all — `computeV2IdentityDigest` omits
    `generationRunId` when `kind==='video'` (`:1715`) and
    `computeDeterministicVideoDigest` never includes it (`:1731`), so a duplicate
    video ad collides on the `(campaignId, identityDigest)` unique index and the
    second inserts nothing. **The index protects video, not this gate.** And
    duplicate STATIC sets are owner-sanctioned creative (`:266-269`), so the
    retired "never key on format/preset" rule was guarding a `meta_all` ⊃
    `meta_static` pair that the owner's own digest instruction calls two
    intentional creatives. What is left to catch is the ACCIDENT, and an accident
    is always a repeat of the *same* request.
  - **(c) FAIL-OPEN, and only here.** The old gate failed closed on an unreadable
    product scope, which is what **broke generation from the MEDIA LIBRARY** —
    those runs legitimately carry `productIds: []`, so they read as "scope
    unknown" and were refused whenever any sibling run was in flight (and while
    in flight they blocked every product run too). Blocking now requires
    *provable* identity, and you cannot prove identity against an unknown. So
    `CampaignRun.requestFingerprint` **must** be stamped at mint time by every
    creator: losing that write silently DISABLES double-click protection rather
    than over-blocking. `/api/ads/runs` stamps `renderClaimFingerprint(runId)` —
    namespaced and unique — because a render claim mints no ads and must never be
    mistaken for the same request as a `/generate`.
  - **(d) The override is single-use by construction.** An identical request is
    refused with `confirmable:true` + `acknowledgeRunId`; the client re-POSTs with
    `confirmDuplicate:true` + `acknowledgedRunId`. Every identical in-flight run
    must be the acknowledged one, so a stray second "Generate anyway" collides
    with the run the first click just minted and is refused with a fresh id. **A
    bare boolean confirm would have re-opened the exact double-click the gate
    exists to stop.**
  - **(e) mint-then-verify** after `CampaignRun.create` still closes the
    read-then-write race where two clicks both read an idle campaign; both racers
    compute the same winner via (`createdAt`, `runId`) and the loser aborts before
    expanding, so a false abort costs a 409 and nothing else. Now keyed on the
    fingerprint too, and it is what keeps two simultaneous confirms from both
    billing.
  - **(f) `kinds` arrives as a bare SCALAR** (`'image'|'video'|'both'|null`), not
    an array. Canonicalising it with an array-only helper collapsed every value to
    `''`, so a static-only run and a video-only run over the same product hashed
    **identically** and the second was refused as a duplicate — a false block on
    the most likely real sequence ("generate the statics, then the video"). Fixed
    by `canonicalScalarOrList`; both shapes are pinned, and scalar `'video'` must
    equal array `['video']`.
  - Product overlap is still computed but is **reporting only** — a non-blocking
    `notice` on the 202 (`concurrent-run-shares-products`) so the operator sees
    that both runs will bill. It names the **earliest** overlapping run by the same
    (`createdAt`, `runId`) order the blocking path uses — the `activeRuns` query
    applies no sort, so picking by list position would surface a different runId on
    each attempt for the same situation. Pinned by `scripts/verifyGenerationGate.js`
    (**194 checks**, revert-proven against ten mutations including the stale-confirm
    money hole, the `kinds` collapse, and re-blocking media-only requests).
- **A forced Instagram RE-SCAN is billable, and the manual route is UNCAPPED.**
  `POST /instagram/sync-posts` with `force:true` re-enters already-ingested posts
  and re-queues detect on media that already had a run — each one a paid
  vision/LLM run. ⚠️ **An earlier version of this bullet claimed "the daily detect
  cap still applies". That was WRONG** — `dailyDetectRunCap` reaches `syncPosts`
  from **`scheduledSyncService` only** (plus a separate read in
  `instagramWebhookService`); the manual route passes `{limit, force,
  credentialId}`, so `runsRemaining` is null, `enqueueRun` is unconditionally
  true, and `capSkipped` can never fire there. **The only bound on one call is
  `limit` (25 default, 50 max); repeated clicks are bounded by nothing
  server-side.** This is equally true of the pre-existing "Sync Now" and is not
  something the re-scan introduced — but the re-scan is the expensive one, so
  whether to wire a cap into this route is an **open decision**, not a solved
  problem. Guards actually in force, all pinned by
  `scripts/verifyIgRescanGuards.js` (**23 checks**, five revert-proven): the
  `if (!enqueueRun) return` return must stay **above** the `forceDetect` bypass in
  `ingestPost` so force can never outrank a cap *where one is supplied* (the
  scheduled job today, this route if it is ever wired up); `forceDetect` is
  `force && !!existing` so the bypass cannot widen to new posts; the route parses
  `force === true` **strictly**, because a truthy check would let the string
  `"false"` trigger a paid re-analysis of 50 posts; `reIngested` is counted
  separately from `ingested` so a re-scan is never reported as having found new
  content; and **5f asserts the absence of the cap**, so wiring one in fails the
  harness and forces this bullet to be updated in the same commit.
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

- **The free Meta crops can be silently swallowed on a campaign that already
  has an ad of that format.** `computeDeterministicVideoDigest` includes
  `platformFormat` but NOT `deriveFromMaster`, so a derivative minted for
  `meta_feed_1_1` hashes identically to a **pre-existing billable**
  `meta_feed_1_1` video ad with the same (campaign, product, refs, CTA,
  prompts). `insertMany` swallows the duplicate-key error and the crop is
  simply not created — the operator keeps the older independent ad instead.
  Unlike the PMax keys, these three Meta formats have **history**: any earlier
  Advanced single-surface pick, and the measured 2026-08-01 multi-aspect Meta
  bug, minted them as real billable rows.
  **This is not a spend regression** — nothing new bills; the free extra is
  just absent. **Do NOT "fix" it by adding `deriveFromMaster` or a run id to
  the Meta digest:** that re-keys every pre-existing Meta video ad, and because
  the digest deliberately omits `generationRunId` the `(campaignId,
  identityDigest)` unique index is the ONLY guard against a repeat Generate
  re-billing Omni — the same trap §2 records for the 8s→10s duration change.
  A re-mint of the Meta video corpus is a costed, flagged decision, never a
  side effect. Related pre-existing hazard, unchanged by this work: a stranded
  `queued` historical row of one of those formats is still claimable by
  `selectAdsForRun` (product-scoped, not new-ad-scoped) and would bill on that
  claim.

- ~~**PMax YouTube safe zones are DECLARED but NOT WIRED**~~ — **CLOSED Phase B
  (2026-08-11).** Zones resolve per `platformFormat`
  (`pmax_video_9_16`→`verticalYt`, `pmax_video_16_9`→`landscapeYt`,
  `pmax_video_1_1`→`squareYt`) and are threaded to the composition.
  `classifyFormat` still returns only the four **canvas** formats (see §4 trap)
  — zone selection is a separate concern. **Funnel preset 10s re-time was
  REVERTED** (shared generic presets; silently re-timed every brand's 8s
  renders — see §4 trap). Presets remain at **8s** extent. **Still open:**
  per-run funnel preset *selection* — `presetOverride` exists on the render
  path but no live caller supplies one; `buildMetaForAd` hardcodes `null`.
  PMax 10s pacing needs **separate** preset files selected with that path.
  See `docs/PIPELINES.md` §6.
- **No full end-to-end PMax kit has run through the app.** Offline suite
  **78/78** plus prompt-only live Atlas submits (measured unit costs above).
  First live app recipe: ONE product, brand with populated `summary`,
  `google_all` → 3 statics + 2 video masters + 1 derived 1:1 ≈ **$2.40**
  (3 concepts × statics + 2 masters; was planned ~$2.6). See `session.md`.
- **~1-in-3 static ads** render a competitor-shaped brand mark on the product
  (e.g. tree emblem reading as Timberland on an Allbirds shoe). Prompts already
  ask for fidelity — fix is measure-and-reject, not prompt tuning. Video path
  not QC'd on this. **STILL OPEN after the 2026-08-03 prompt hardening — that
  hardening is owner-directed work on top of this note, NOT a fix for it, and it
  has no measured effect on this defect yet.** The static prompt now opens with a
  long `PRODUCT_FIDELITY` block (`staticAdIntents.js`) covering source-of-truth,
  category/brand-prior, form, construction, surface, colour, on-item graphics,
  details and condition — plus carve-outs in `absences` / `textBlock` so the
  no-added-text rules cannot erase the product's OWN printed label (they read
  literally as "strip marks from clothing/packaging in the scene", and on this
  catalog the product often IS the clothing or the packaging). **`adVisionQcService`
  remains the actual fix.** Reversible without a deploy via
  `STATIC_PROMPT_FIDELITY_HARDENING=false`, which restores a **byte-identical**
  pre-hardening prompt — block *and* both carve-out sites revert together, so the
  A/B control arm really is the arm that was measured. **The cost is real and
  unmeasured:** the prompt more than doubled (~3.5-4.1k → ~7.8-8.4k chars) and the
  block sits above `SET EXACTLY THESE STRINGS` on a path whose measured text
  fidelity is 139/140 strings across 20 renders, and where `quality:high` already
  measured WORSE than `medium` by losing a string. If the next render sample shows
  copy defects, suspect this before anything else and flip the flag. Precedent for
  that outcome: PR #61 hardened the VIDEO prompt and was rolled back in full
  (§00). Pinned by `scripts/verifyStaticFidelityPrompt.js` (419 checks, both arms,
  revert-proven on three mutations).
- **Director round JSON is not enforced by the gateway (SEPARATE from the
  competitor-mark defect above).** The `director` role maps to
  `anthropic/claude-sonnet-5-ccmax` (`services/atlasModelMap.js:98`). Atlas
  **silently ignores** `response_format:{type:'json_object'}` for that model —
  probed live 2026-08-04, two arms (flag on / flag off), **both** returned
  conversational prose. Distinct from the already-documented fact that
  `json_schema` HTTP 400s for Anthropic; "use `json_object`" is now known to be
  **insufficient**. Measured from Render logs over 24h: **10 Director round
  failures, 1 success** — failures open with prose ("I don't have enough
  information…", "Before I generate…", "No AVOID block…", "Two inputs…",
  "A couple of things…"); each failure = a product with **zero ads** (paid
  Director call wasted). The round system prompt never independently demanded
  JSON, so compliance was luck; thin-signal SKUs reliably tipped the model into
  clarifying questions. The handler was asymmetric: schema-validation miss
  re-asked once, JSON parse failure threw with no salvage and no retry. **Code
  fix is applied in the working tree and offline-verified, but UNCOMMITTED and
  NOT deployed — do not claim production is fixed.** Fix: (a)
  `safeParseDirectorJSON` + `extractFirstBalancedObject` (string-aware
  balanced-brace salvage; mirrors `judgeService.safeParseJSON` but not greedy);
  (b) one-shot corrective re-ask that **shares** the existing `attempt` budget
  (worst case stays two paid Director calls per product/round); (c) `OUTPUT
  CONTRACT` block in the round system prompt naming the observed refusal
  openings and stating THIN DATA IS NOT A STOP. Pinned by
  `scripts/verifyDirectorJsonSalvage.js` (32 checks; revert-proven against three
  mutations: salvage removed → 28/32; unconditional throw → 30/32; OUTPUT
  CONTRACT deleted → 31/32).
  **Starved brief — FIXED (do not re-diagnose).** Separately from the JSON
  gateway issue, the Director input summary used to read fields that do not
  exist on the schemas: `brand.description` / `brand.logo` (neither on
  `brandSchema` — `models/Brand.js:31`; `description` is `demographicSchema`'s
  field at `:24`; real fields are `summary` `:47` and `logoUrl` `:48`) and
  `product.shortBenefits` (not on `CatalogProduct`, always `[]`). The round
  prompt told the model to pull from `brand_signal.tagline / description /
  brand_reviews_summary` and to null any ungrounded copy role — so copy came
  back empty while `dirWarnings=0` (the warning only fired when **all four**
  copy fields were null). Fixed: `brand_signal.description` ← `brand.summary`,
  `has_logo` ← `!!brand.logoUrl`, dead `shortBenefits` read dropped
  (`aiCreativeDirectorService.js:307-329`); warning on `copy.headline` alone
  null (`:1979-1983`); **`DIRECTOR_SIGNALS_VERSION` bumped `3.0.0 → 3.1.0`**
  (`:73`) so cached `CreativeDirectionArtifact` rows re-derive. Without the
  bump the brief fix is a no-op on every product that already has an artifact
  (cache-hit test is `cached.signalsVersion === DIRECTOR_SIGNALS_VERSION` at
  `:149` — same "looks right, silently does nothing" class as §0). Pinned by
  `scripts/verifyDirectorPrompt.js` (40 checks, section E).
- **Static `ai_brand_led` with zero cascade headline can still print a customer
  quote (known open — not "broken").** `INTENTS.brand_led` declares
  `rendersQuote:false` (owner: rating trust mark only, no quote —
  `staticAdIntents.js:544`). But with no headline from Director /
  `layoutInput.copy` / `brand.tagline`, `eligible` fails and `resolveIntent`
  walks `FALLBACK_ORDER` (`:565` / `:572-578`); if a rating exists the ad lands
  on `social_proof_led`, which **can** emit a customer quote. Documented
  deliberately rather than closed: the descent hierarchy is owner-specified,
  and a hollow brand-led ad is what `core:['BRAND LINE']` exists to prevent.
  Reachable only when all three headline tiers are absent. Full write-up:
  `docs/PIPELINES.md` §5 *Brand-led intent + copy cascade*.
- **Static geometry — two defects FIXED 2026-08-03; read the diagnostic before
  re-opening.** (A) `staticAdIntents.computeSurface` combined the post-generation
  crop band with the 6% edge margin via `Math.max`, so on every *cropped* surface
  the margin collapsed to zero and the safe box handed to the image model *was*
  the crop line. Proof needing no model compliance: the composited logomark
  shipped **flush to the delivered frame edge** on Stories and 4:5 — inspectable
  in any ad delivered before the fix. (B) `GEN_SIZES` was stale (three sizes;
  the live schema enum has 14), so 9:16 generated at `1024x1536` and lost 80px per
  side. All **Meta** live static surfaces generate at exact delivery aspect —
  zero crop. **Phase A amendment (2026-08-10):** `GEN_SIZES` gained schema-enum
  `2048x1152` — frozen `pmax_16_9` now zero-crops (was 1536x1024 / 15.6% crop);
  live `pmax_landscape_1_91_1` crops ~6.9% from that plate (no exact 1.91:1 enum
  twin). Live PMax statics use **10%** edge margin via `SURFACE_EDGE_MARGIN_PCT`;
  Meta + frozen `pmax_16_9` stay 6%. Pinned by `scripts/verifyStaticSafeBox.js`.
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
  `2048x1152` needed no probe — it is an enum member.
- **`queued` ads never auto-drain** — still require an explicit `/runs` (or
  equivalent) claim.
- ~~**`veoPredictionId` is a spend receipt that is never resumed**~~ — **CLOSED
  2026-08-04** (PRs #70-#72 + the titling resume). The receipt is now polled for
  free and the paid master collected: `services/bootRecoveryService.js` sweeps
  ads stranded in `rendering` that hold a receipt, and every requeue site is
  receipt-aware via `services/spendReceipt.js`. Do not re-open this as a bug.
  **What replaced it, and it is a DIFFERENT invariant — see §2 below:** a
  recovered master must be TITLED, and must never be requeued to get there.
- **A RECOVERED MASTER MUST NEVER BE REQUEUED — `status:'queued'` costs ~$0.75.**
  This reads as the obvious way to "finish" a recovered ad and it is a
  double-charge. `routes/ads.js:1342` declares `veoVideoUrl` **fresh** every
  render and the path **never reads `ad.veoVideoUrl`**, so `if (!veoVideoUrl)`
  (`:1367`) is TRUE for an ad that already holds a paid master — it falls
  straight into `veoGenerateForAd` and submits to Omni a second time. Titling is
  therefore resumed **titling-only** by `services/titlingResumeService.js`
  (claim → `renderBrandScriptAndSave`), never by re-entering the render queue.
  Pinned by `scripts/verifyTitlingResume.js` **T6** (neither service may contain
  `status: 'queued'`) and **T10** (the sweeper may not even require
  `atlasVideoService`, so it is structurally incapable of spending).
- **Titling resume is WEB-ONLY and that is not arbitrary.** Remotion is warmed in
  `index.js`; `worker.js` has **zero** remotion references. So the worker
  recovers the asset (`bootRecoveryService`) and the web process titles it
  (`titlingResumeService`, on an interval with a re-entrancy guard).
- **The resume state lives on `Ad.titlingResumeState` — NEVER on `renderStage`,
  and this was got wrong once.** The first design parked the sentinel in
  `renderStage`, reasoning that reusing an existing field dodges the
  Mongoose-strict trap where a write to an **undeclared** path is silently
  dropped (this repo already lost `renderError.predictionId` that way).
  Adversarial review killed it: **`renderStage` is OWNED by
  `services/adStage.js`**, which `$set`s it unconditionally (`adStage.js:82-85`)
  and is called throughout titling (`brandScriptExecutor.js:1200`, `:1306`,
  `:1332`). The sentinel was therefore clobbered seconds into the render, so an
  ad whose render crashed could never be re-swept — the exact leak the resume
  exists to close. The trap is about *undeclared* paths; **declaring** the field
  (`models/Ad.js`, `enum:['pending','claimed',null]`) removes it. `renderStage`
  is still written alongside as a human breadcrumb, but nothing queries it.
  `scripts/verifyTitlingResume.js` **G1/G2** forbid keying any query or claim
  filter on `renderStage`, and **G3** asserts the schema declaration exists — so
  neither half of that mistake can come back.
  **Corollary worth knowing:** the same mid-titling crash leaves the identical
  orphan on the NORMAL render path today (`routes/ads.js:1437-1460` stamps
  `draft` + `renderUrl` *before* titling at `:1477`), and no sweeper catches that
  either, because they all key on `status:'rendering'`. Pre-existing, still open,
  not introduced here.
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
- **`resolveDeriveFromMaster` is defined ONCE and imported — never re-implemented
  per caller.** Lives in `services/campaignAdsGenerationService.js`; both
  `routes/ads.js` (render loop, before any Omni submit) and
  `services/adRegenerateService.js` (preflight → 409) import it. A per-caller
  copy is **exactly** how the regenerate hole opened in Phase A: regenerate
  called `veoService.generateForAd` unconditionally on a PMax 1:1 and billed a
  full Omni generation on the free surface. Fail-closed on
  `platformFormat === 'pmax_video_1_1'` so a dropped `deriveFromMaster` field
  cannot re-open spend. Pinned by `scripts/verifyPmaxVideoExpansion.js` (gate
  defined once; zero billable submit calls inside `renderDeriveOnlyVideoAd`).
- **`config/defaults.env` is committed** and `dotenv`-loaded at boot. It is the real
  source of non-secret defaults — `.env.example` is documentation only and several
  vars there are blank while `defaults.env` sets them. **Secrets stay in the
  Render dashboard only** (migration COMPLETE 2026-08-03 — see §4a). Precedence:
  process env wins; a dashboard var of the same name **always shadows** the file.
- **`absences` `rendersSubhead` polarity.** The condition at
  `staticAdIntents.js:412` is `rendersSubhead && (!d.subhead || lost('SUBHEAD'))`.
  It **MUST** lead with `rendersSubhead` — only `brand_led` declares that flag,
  so every other intent stays `undefined`/falsy and its prompt is unchanged.
  Flipping to `!rendersSubhead || …` silently adds an absence line to **every**
  existing prompt and breaks the flag-off byte-identity baseline. Pinned by
  `verifyStaticIntents.js` E6 (additive-safety: no non-`brand_led` prompt
  contains "subhead"). Same trap class as §0.
- **`DIRECTOR_SIGNALS_VERSION` bump is load-bearing on any brief fix.** Cache-hit
  test is `cached.signalsVersion === DIRECTOR_SIGNALS_VERSION`
  (`aiCreativeDirectorService.js:149`). A code fix that feeds better brand /
  product signal **without** bumping the version leaves every product that
  already has a `CreativeDirectionArtifact` serving concepts built from the old
  brief — the fix looks deployed and is a no-op. Current value **`3.3.0`**
  (Phase B PMax funnel + proof hierarchy). Prior bumps: `3.0.0→3.1.0`
  starved-brief (`summary` / `logoUrl`); `3.1.0→3.2.0` social-proof menu.
  Any future signal-shape change needs the same bump.
- **PMax Director hierarchy PRECEDENCE SENTENCE — do not delete or "harmonise".**
  The shared DR block still says "≥4.5 from ≥50" (Meta-tuned, deliberately
  untouched). The PMax-only social-proof hierarchy block uses env-interpolated
  thresholds (`PMAX_PROOF_STRONG_RATING=4.5`, `PMAX_PROOF_MIN_REVIEW_COUNT=100`)
  and states explicitly that **it wins for this destination on any disagreement
  including thresholds**. Deleting that sentence, or editing the shared DR text
  to match, either re-opens dual-threshold confusion or **changes the Meta
  prompt**. Measured: Meta round prompt is byte-identical. See
  `docs/PIPELINES.md` §6 *Director: funnel spread*.
- **`classifyFormat` must keep returning canvas formats only**
  (`vertical|square|landscape|feed`). That string is also the **composition id**
  and the **`titleStyleSpec` cascade key**. Returning a YouTube zone name from
  it would break the render and silently change every spec lookup. Zone
  selection is a separate platformFormat-aware path (Phase B wired).
- **Do not re-time a SHARED funnel preset for PMax.** `canonical-awareness` /
  `consideration` / `conversion` are generic (`brand.titleStylePreset` Tier 2 +
  `retitleDriver --preset=`). Phase B re-authored them for 10s plates; because
  `specTimeScale` only compresses, every existing **8s** render using those
  presets dropped 1.0 → **0.8** with no crash and no failing test. **Reverted
  to 8s extent.** PMax 10s pacing must be **separate preset files** selected
  with per-run `presetOverride` (still open). See `docs/PIPELINES.md` §6.
- **`ROUTING_NESTED_FIELDS` registration is the scanner's coverage list, not a
  free-form enum.** `verifyConceptContract.js` only flags flat reads of
  *registered* names. Phase B added `routing.funnel_stage` without registering
  it → the new field silently lacked the guardrail that exists because reading
  these flat once produced zero ads. Registered + **R0b** pins load-bearing
  names (`media_picks`, `creative_style`, `output_shape`, `funnel_stage`) stay
  on the list — removing a name previously failed nothing (shorter iterate).
- **`PMAX_PROOF_*` blank env is 0, not NaN.** `Number('') === 0`. A cleared
  Render dashboard value would inject "strong rating ≥ 0" into the Director
  hierarchy and invert it. Parser falls back on blank/whitespace/negative.
- **`brand.logo` IS CORRECT on a `layoutInput.brand` object and WRONG on a Mongoose
  Brand doc. Check which object you are holding before "fixing" either.** The two
  are different shapes with overlapping names, which is how the Director bug hid.
  `layoutInputService.js:2227` builds `layoutInput.brand.logo` **from**
  `brand.logoUrl`, so `brand.logo` is a real field on that projection — and
  `aiCanvasInputBuilder.js:133/329/330` read it legitimately, because `:37` is
  `const brand = layoutInput.brand || {}`. `ALLOWED_SLOTS`
  (`aiCanvasSpecService.js:115`) and the prompt text at `:555`/`:749` are
  slot-binding **contract paths** and context-object **key names**, not property
  reads — renaming any of them breaks the binding contract. A Mongoose Brand doc
  has only `logoUrl` / `summary`. Both directions are pinned by
  `scripts/verifyBrandFieldNames.js` (17 checks): Group B forbids
  `brandDoc.description` / `brandDoc.logo`, and **Group D asserts the layoutInput
  usages still exist**, so an over-eager cleanup fails the harness. Group B is
  deliberately scoped to the variable name `brandDoc` — a bare `brand` is
  ambiguous repo-wide, and a check that cannot tell the two apart would have to
  allowlist half the services.
- **`.select()` of a field that does not exist is SILENT.** Mongoose neither throws
  nor warns; the path is simply absent on the result, so the read downstream is
  `undefined` forever. `aiCanvasInputBuilder` did
  `.select('description tagline brandReviews tone')` on Brand — `description` is
  not a brandSchema field, so the rich-context `description` key handed to the
  canvas Generator was permanently empty. Same defect as the Director's
  `brand?.description`, one layer earlier. Group A of
  `verifyBrandFieldNames.js` parses the real top-level `brandSchema` keys out of
  `models/Brand.js` (58 today) and asserts every `Brand.find*().select(…)` path in
  `services/` + `routes/` is one of them — it is the general form of this trap, so
  prefer extending it over adding a one-off string check.
  **SECOND LIVE INSTANCE, caught by Group A and fixed 2026-08-10 — the harness
  paid for itself.** `catalogSyncFromShopifyPublic` and
  `catalogSyncFromGenericSitemap` both did `.select('… shopifyUrl')`. **There is
  no top-level `shopifyUrl` on brandSchema** — it exists only as
  `apifyDemo.shopifyUrl`, and it is a *separate field from `websiteUrl`* exactly
  because a brand's catalog can live on a different host from its marketing site.
  Two compounding faults: the projection named a nonexistent path AND never
  selected `apifyDemo`, and that projected doc is handed straight to
  `syncBrandShopifyDirect` / `syncBrandGenericCatalog` — whose own
  `resolveStoreOrigin(brand)` (`brand?.apifyDemo?.shopifyUrl || …`) then fell
  through to `websiteUrl`. **So the bad projection propagated past the executor
  into the real scrape: the wrong host was pulled, silently.** Both executors also
  re-implemented the cascade locally as `brand.shopifyUrl || brand.websiteUrl`
  (two tiers, missing the one that matters); they now call the shared
  `resolveStoreOrigin`, so a preview cannot advertise one store and scrape
  another. A brand with a catalog URL but no `websiteUrl` was also falsely
  refused. **Lesson generalised: when an executor projects a doc it then PASSES
  DOWN, the projection must satisfy the callee's field reads, not just its own** —
  and prefer the shared resolver over a re-implemented cascade. The stale header
  claiming "Requires Brand.shopifyUrl" is why this looked right to three readers.
- **Gate a provider tier on the PRIMARY key, never the fallback.** `wantGpt`
  (`brandEnrichmentService.js`) gated on `OPENAI_API_KEY` while the call itself goes
  through `atlasLlmService.chatCompletion`, whose primary is Atlas and whose direct
  providers are only a fallback. After the move to Atlas, a deployment holding just
  Atlas credentials **silently skipped the whole GPT enrichment tier** — and that
  tier's `ENRICHMENT_SCHEMA` owns tagline, summary, tone, hashtags, tags,
  demographics, colours and fontSuggestion. `summary` has **no other automated
  writer**, and `brand_signal.description` in the Director brief reads exactly that
  field, so the starved brief had a starved *source*. Now
  `(atlasLlmConfigured() || !!process.env.OPENAI_API_KEY)`. **Not the same as
  `wantBrandReviews`:** `geminiSearchProvider` calls Google's grounded-search
  endpoint directly with `GEMINI_API_KEY` and is deliberately *not* behind
  `atlasLlmService` (Atlas does not proxy grounded retrieval), so gating that tier
  on its own key is correct. Before "fixing" a key gate, read which client the tier
  actually calls.
- **A REGEX OVER SOURCE TEXT CANNOT SEE AN UNBOUND IDENTIFIER — and `node --check`
  cannot either.** This shipped a broken money guard to production with a green
  harness on 2026-08-04. `services/processAlerts.js` called `receiptFree({...})`
  and never imported it; `routes/ads.js:23` and `worker.js:59` both did.
  `verifyReceiptAwareRequeue.js` "checked" the site with
  `/receiptFree\(/.test(block)` — which proves the call is *written*, not that it
  *resolves*. A `ReferenceError` is runtime, not syntax, so `node --check` passed
  too. Because both writes sat in one `Promise.all([...])`, the throw happened
  while the array was being **evaluated**, so `CampaignRun.updateMany` never even
  ran: every SIGTERM with ads in flight silently requeued nothing AND left the run
  unmarked — the exact "silent stall" that function exists to prevent. It hid for
  three hours because `persistOrphans` returns early when nothing is in flight.
  **Rule: when a harness asserts a call site uses a helper, it must also assert
  that file IMPORTS the helper** — and derive the file list by SCANNING, never a
  hardcoded list, or the next call site is unguarded again. Now `I0-I5`, and the
  scan is **recursive** (36 files under `services/providers`,
  `services/capabilityExecutors`, `services/reviewAdapters`, … were previously
  invisible to `X1` as well).
- **A merge conflict marker SURVIVES in `.env` — the parser ignores what it cannot
  understand.** `config/defaults.env` on `main` carried literal `<<<<<<<` /
  `=======` / `>>>>>>>` at lines 498/535/566 and was deployed. It did **not** break
  config: dotenv skips any line that is not `KEY=VALUE`, so all 114 keys parsed and
  both arms' vars were effective (measured, not assumed). But nothing catches it —
  not `node --check`, and **not the §4a diagnostic**
  (`grep -oE '^[A-Z_][A-Z0-9_]*='`), because markers do not match that pattern.
  Resolved 2026-08-04 by keeping **both** arms, since both were already live and
  dropping either would have been a silent behaviour change; proven a no-op at
  117 → 117 keys with identical values. **Add a marker scan to any config audit,
  and never assume a dirty merge would have failed loudly.**
- **Docs have described commented-out code.** `TITLING.md` documented the disabled
  canvas cascade as live. When you find such a case, fix the doc in the same commit.
- **Director concept contract (v3 nested under `routing`).** Schema v3 moved
  strategy fields (`media_picks`, `creative_style`, `output_shape`,
  `funnel_stage`, …) under `concept.routing`. Reading `concept.media_picks` flat
  silently zeros ads while the producer's dual-read validator logs `warnings=0`.
  **Every consumer must use `services/conceptProjection.js` —
  `conceptField()` / `conceptMediaPicks()`.** `scripts/verifyConceptContract.js`
  exhaustively scans `services/` + `routes/` and fails if any file reads a
  `ROUTING_NESTED_FIELDS` name off a concept without the helper. Zero-ads root
  cause fixed 2026-08-03 (live: `concepts=3 payloads=3` where it was
  `payloads=0`). New fields must be **registered** in that list or the scanner
  is blind to them (Phase B `funnel_stage` lesson; **R0b** pins the load-bearing
  set).
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
- **SUPERSEDED 2026-08-05 — THE DEFAULT SEED IS NOW THE MERCHANT FEED'S
  PRIMARY IMAGE, resolved `CatalogProduct.imageMediaId` → `metadata.feedIndex
  === 0` → (static only) best shotType rank.** Owner directive: *"the primary
  image as defined by the merchant feed is the main image ... The Hero stamp
  is not relevant when selecting images for video or static catalog
  generations."* `feedIndex` is stamped at ingest (0 = `product.imageUrl`,
  1..N = `additionalImages` in feed order). Video reference refs 1/2 are now
  `feedIndex` 1/2 (`atlasVideoService.sortCatalogMediasForReferenceStack`,
  which composes UNDER the existing `VIDEO_DEFAULT_REFERENCE_SHOT_TYPES`
  preference — feed order is the base, that dial is an opt-in reorder over
  it), and the video subject-dominance guard is gone on that path. Kill
  switch `CATALOG_FEED_ORDER_SEEDING` (default true) reverts all of it.
  **The pointer is checked BEFORE the stamp on purpose:** nothing clears
  `feedIndex` when a merchant replaces their primary image, so a stamp-first
  cascade would seed a billable render from a retired photo. Scope is the two
  live default paths only — `adRegenerateService` and `seedsFromProduct` are
  unchanged. Pinned by `scripts/verifyCatalogFeedOrderSeeding.js`; full
  write-up in `session.md` (2026-08-05). **The paragraph below is the
  SUPERSEDED 2026-08-03/08-04 rule, kept because the kill-switch-off path
  still runs exactly it.**
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
- **A LABELLED brand rating MAY now sit beside a product/comment-tier quote on
  STATIC — owner override of tier-coherence invariant #4, 2026-08-07. Do NOT
  "restore the invariant".** `resolveCoherentSocialProof`
  (`services/ratingDisplay.js`) used to hard-null brand numbers whenever a
  product/comment-tier quote was on frame, because a brand-wide count beside one
  SKU's testimonial reads as that SKU's volume. **Measured cost of that rule:
  7 of 18 `ai_social_proof_led` renders (2026-07-30..08-06) fell back to
  `objection_resolved`** — the comment-tier quote nulled otherwise-usable brand
  stars, and `INTENTS.social_proof_led`'s `core` **is** the rating, so the ad
  lost the very thing it exists to show. Owner, verbatim: *"I don't want brand
  level stars to block a comment tier quote. We can have both and clearly
  demarcate brand level stars … The positive comment is different and better
  social proof than brand level stars"* / *"include the comment and then use
  brand level stars and include a 'Brand Reviews' next to the stars."*
  **How it is contained — all three matter:** (1) the behaviour is an **opt-in
  parameter** `allowLabeledBrandNumbers`, **default `false`**, so every other
  caller — *including the whole video path via
  `brandScriptExecutor.buildMetaForAd`* — is unchanged **by construction, not by
  assertion**; only `directImageRenderService.buildIntentData` passes `true`.
  (2) The exception sits **after** both product attempts, so a product-tier
  number always wins and the exception can only ever ADD proof where there was
  none, never displace product numbers with brand ones. (3) It returns
  `source:'brand'` — **stars only** — which makes `packCoherentProof` derive
  `reviewsText` via `formatBrandReviewsText`, always carrying
  `BRAND_SCOPE_LABEL` (`"brand reviews"`), and `INTENTS.social_proof_led`
  prefers that scoped string over any re-derived unscoped one.
  **THREE CONSTRAINTS THAT LOOK OPTIONAL AND ARE NOT** — each closes a hole two
  independent adversarial passes found in the first draft, all three
  revert-proven: (a) the gate is **`=== true`**, not truthiness — a caller
  forwarding a raw env string opted in on the literal `"false"`; (b) a
  normalized brand **count is REQUIRED**, because `reviewsText` is derived from
  the count, so a stars-only brand pair (rating, `reviewCount: null`) produced
  `reviewsText: null` and `staticAdIntents` then rendered a **bare `4.7 ★`**
  beside a product/comment testimonial with no qualifier — no count means no
  label vehicle, so it refuses; (c) **`allowBrandCountWithoutStars` stays
  false** — a brand count with `rating: null` still fails
  `social_proof_led.eligible`, so it would print a brand volume claim beside a
  product testimonial *and* still collapse the intent. The fail-closed
  `renderedQuoteText` guard is untouched. **Known accepted residual:** a product
  pair with a sub-floor rating but a non-zero count returns `product-count` and
  short-circuits the exception, so that shape still falls back — fixing it would
  mean brand numbers displacing a product-tier number, a second override nobody
  has approved. Pinned (including that residual) by
  `scripts/verifySocialProofRestoration.js` groups C/D — **35 checks,
  revert-proven on 13 mutations**. Kill switch
  **`STATIC_BRAND_STARS_WITH_QUOTE=false`** (committed in `config/defaults.env`)
  reverts with no deploy. Precedent for why this note exists at all: §00's
  PR #61 rollback, where a later session "fixed" a deliberate decision.
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
- Before pushing non-trivial changes: run **`npm run lint`**, `node --check` the
  touched files, and run the relevant `scripts/verify*.js` harness (**101 scripts**
  as of the concept-expansion binding fix). Add a harness for money/security-critical
  logic, and **revert-prove it** — back the fix out and confirm the test fails. A test
  that cannot fail is not a test.
- **`npm run lint` is not optional, and it is not a style check.** It enables exactly
  one rule, `no-undef`, because that is the one thing every harness here is blind to:
  they assert over source text, and a regex cannot see an unbound identifier —
  neither can `node --check`, since a `ReferenceError` is a runtime error. This has
  now shipped to production three times (`receiptFree`, `preferUgcMediaId`,
  `usableProofCommentsOrNone`). If you add a rule, add it deliberately and say why.
- Adversarial review on non-trivial diffs: have a second model try to *refute* the
  change (bugs, bypasses, money holes) before committing. It caught two real regex
  bugs in the submit guard that review-by-reading missed.
