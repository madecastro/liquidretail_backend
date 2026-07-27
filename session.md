# session.md — liquidretail_backend

## Next-session prompt
_(empty — no pending owner prompt)_

## Current state (2026-07-27)

### Shipped today
`main` is at **`074babb`** with four merged PRs — #15 reframe port +
product-only pad + claim lease, #16 explicit seed count + stale re-derive,
#17 related media can seed a video (with product anchor), #18 inspector
records the images the model *actually* received. Frontend `master` at
`742bd0e` (#11). Both Render services live on `074babb`.

### Diagnosed: why video batches stall (2026-07-27)
Ad rendering — **including paid video generation** — runs in-process on the
**web** service as a fire-and-forget `setImmediate` after the 202
(`routes/ads.js runRenderLoop`), at `VEO_CONCURRENCY=1` ≈ 1 min/ad, so a
20-ad batch holds that process 25–35 min. The process does not live that
long: deploys replace it, **and Render autoscaling replaces it too**
(web service is `min 1 / max 3`, CPU *and* memory triggers at 60% — a render
batch is itself a scale trigger). Instance replacement kills the loop
silently. Ads sit in `rendering` → the worker's reaper flips them to
`queued` after 15 min → **nothing drains `queued`** (`selectAdsForRun` is
only reachable from `POST /api/ads/generate` and `POST /api/ads/runs`), so
work stops until a human presses *Generate more*.

Evidence: 20-ad batch started 18:48:22, killed by the 18:51:44 deploy,
15 ads reclaimed at 19:07:12 and stranded. Also found: an autoscale-driven
instance boot at 19:00:41 with no deploy behind it, and `RENDER_AUTH_TOKEN`
expired since 2026-05-07 (per-request token normally wins, so not currently
breaking renders — worth clearing anyway).

### In progress: Telegram alerting (branch `feat/telegram-alerts`)
New `services/alertService.js` (transport + dedupe + rate limit),
`processAlerts.js` (crash/SIGTERM — the codebase previously had **zero**
`uncaughtException`/`unhandledRejection` handlers), `backlogWatchdog.js`
(wedged renders, stalled runs, detect backlog, trailing-hour spend),
`inFlight.js` (what a shutdown is about to orphan). Wired into `index.js`,
`worker.js` (reaper alert + watchdog timer), `routes/ads.js` (run crash, run
failed, video failed). Docs: **`docs/ALERTING.md`**.

Secrets `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` must be set **in Render
env on both services** — names only in `.env.example`; `ALERT_*` tuning in
`config/defaults.env`. Alerting stays silently disabled until both are set.

Verified: 20 + 14 unit assertions on alertService (dedupe, escape,
tag-balance under hostile input, token redaction, map pruning, never-throws)
and 8 child-process assertions on exit semantics (SIGTERM re-raises to
Node's default disposition; crashes still `exit(1)`).

### Fixed in the same branch: reaper false-reap / double-spend window
Pre-existing: ads are bulk-claimed with ONE `updatedAt` stamp before the
loop, and the reaper flips `rendering→queued` at 15 min stale — so the tail
ads of any healthy >15-min serialized video batch were reclaimed MID-RUN
(renderOne renders by id with no status check), where a concurrent
"Generate more" could select the same ad into a second run → two billable
video POSTs for one ad. Same flaw run-level: CampaignRun was reaped on
`startedAt`, failing any healthy run older than 15 min. Fix: per-completion
heartbeat on the run's still-`rendering` ads (`routes/ads.js`), and the run
reap filter moved to `updatedAt` (auto-refreshed by every `$inc` —
`_setTimestampsOnUpdate` hook verified registered). Also removed the
reaper's `campaignRunId: null` write — singular field absent from the Ad
schema, silently stripped by `strict:true` since day one.

Grok adversarial pass earned its keep again: caught a real SIGTERM hang in
MY first version (re-raise assumes ours is the last listener; puppeteer
registers a non-exiting SIGTERM handler on every launch — reproduced, fixed
with a hard 1s exit timer behind the re-raise, exit code 143) and a
sync-throw risk in the veo catch that would have wedged the failure
bookkeeping.

### Known gap, NOT closed
Alerts report dropped work; they don't resume it. The real fix is a durable
worker-drained ad queue (let `worker.js` claim `Ad{status:'queued'}` the way
it claims `DetectRun`) so an instance replacement costs one ad, not a batch.
Deliberately unbundled — it changes claim/lease semantics on a billable POST.
Interim: smaller `MAX_CREATIVES_PER_RUN`, or pin the web service to
`max: 1` instance so scale-in stops being a cause.

### Cost note worth acting on
`google/gemini-omni-flash/image-to-video-developer` supports **16:9 / 9:16
only**, so every **4:5 Feed** video falls back to
`xai/grok-imagine-video-v1.5/image-to-video` (ledger `$0.50/s` ≈ **$4.00** per
8s clip vs ~$1.00) *and* gets remapped 4:5 → 3:4, which then fails titling
layout (`Template ai_brand_led does not support aspect ratio 3:4`). The
$0.50/s rate is flagged UNVERIFIED in `MODEL_CAPS` — a real invoice should
confirm it.

## Prior state (2026-07-23)
**Docs:** `docs/PIPELINES.md` §6 (+ intro date + quick map) updated for
deterministic-first video (backend PRs #11/#12/#13, frontend #10) —
verified against `campaignAdsGenerationService` / `atlasVideoService` /
cascades / wizard API. Doc edit uncommitted unless committed with this session.

**Prior:** Deterministic-video **Phases 1+2+3** implemented (code). Design:
`~/.claude-work/plans/compiled-inventing-babbage.md`.

**Phase 3 (this session):** `Ad.referenceMediaIds` (ordered operator stack);
`expandDeterministicVideo` + namespaced `computeDeterministicVideoDigest`
(`det-video:v1`); routing restructure (deterministic first, director
opt-in via `directorVariants`, brand campaigns stay director);
`mergeExpansionResults`; ordered render via `buildReferenceImages({orderedReferenceMedia})`;
`GET /api/ads/veo-prompt-scaffold`; `/preview`+`/generate` accept
`directorVariants`, `seedMediaIds`, `videoPromptGuidance`, `videoPromptRaw`.
Static image path / aiCanvas / gpt-image untouched.

Touched (Phase 3): `models/Ad.js`, `services/campaignAdsGenerationService.js`,
`services/atlasVideoService.js`, `routes/ads.js`. All pass `node --check`.

## Prior state (2026-07-22)
**Shipped.** The titling-engine batch described below is committed, pushed,
reviewed, and merged into `main` — no longer pending or uncommitted.

- [PR #2](https://github.com/Emami-RS-Project/liquidretail_backend/pull/2) — the feature batch itself, merged (`3a991f1`).
- [PR #3](https://github.com/Emami-RS-Project/liquidretail_backend/pull/3) — a same-day follow-up fix from an independent adversarial re-review (see below), merged (`49a3c0f`).

### What shipped (frontend/app)
1. **Remotion is the default titling engine** (`brandScriptExecutor.resolveTitlingEngine` fallthrough; custom-script brands still force canvas; brand/env overrides unchanged). Owner confirmed Remotion license is fine (<3 employees → free tier).
2. **`titlePlacementMode: 'canonical' | 'content'`** — default canonical = fully static spec anchors (skips `analyzePlate`, `plateHints:null`, no nudge/no ink flip); content = plate scan + nudge + ink flip. Precedence: request > `Brand.videoSettings.titlePlacementMode` > canonical; `TITLE_PLATE_SCAN=off` is the global kill switch. Threaded through renderTitles/renderPreview/title-still/preview-script.
3. **No-scrim validator defaults** — `titleSpecValidator` treatment fallbacks now `scrim:'none'`, `shadow:'layered'`.
4. **Per-ad copy override** — `PATCH /api/ads/:id` accepts `{status? , copy?}` (headline/cta_text/quote/productName/productPrice, dotted $set paths).
5. **Batch re-title** — `POST /api/brand/:id/retitle-videos` (dryRun sync; live async 202+jobId, poll `GET .../:jobId`, tenant-scoped, 5-min reap). Re-renders titles over retained `veoVideoUrl` base videos.
6. **Transparent-image fix** — `Brand.websiteBackground` (captured in enrichment via static-HTML heuristic, never theme-color), `utils/websiteBackground.js` helper, `b_rgb:<hex>` flatten BEFORE `c_fill` in the two image-seed transforms (`aiVideoReferenceService.deriveAspectCroppedImageUrl`, `atlasVideoService.cropImageUrlForAspect`); white default when uncaptured.
7. **Vertical safe zone tightened** — `remotion/lib/safeZones.js` top 0.121→0.14, bottom 0.16→0.35 (Meta Reels clear zones). Frontend island mirror updated in lockstep (see frontend repo).
8. Docs updated: `docs/TITLING.md` (engine default, placement mode, retitle contract, safe zones), `docs/ai-creative-pipeline.md` (transparency section + follow-up surfaces).

### Fixed in the follow-up (PR #3)
A fresh independent Grok adversarial pass (run before merging, on the staged diff — separate from whatever review happened when this was originally drafted) found `routes/ads.js`'s `projectAd()` preferring `ad.copy.cta_text` over the raw `ad.ctaText`. `metaAdsPushService.js` reads `ad.ctaText` directly from the Mongoose doc (bypassing this projection), so the live Meta push was never affected — but the API response could show operators the wrong field. Reverted to the raw field in `ads.js` only; `routes/catalog.js`/`routes/campaigns.js` keep the copy-preferring behavior since `ProductAds/index.tsx`'s edit box genuinely depends on it (traced and confirmed before deciding not to touch those two).

## Known follow-ups
- **Propagation**: after deploy, run batch re-title per brand (`dryRun:true` first) to apply new defaults to existing videos. Videos already exported to ad platforms need re-export.
- **Backend PR #6 (2026-07-22, shipped, paired with frontend PR #6)**: `services/genericCatalogIngestService.js`'s save-phase progress note changed from a raw review count to `saved X/Y products · Z% with reviews` (Z = reviewsCaptured/idx); catalog save stage renamed `'upserting catalog products'` → `'saving products to catalog'`. `GET /api/sales-demos/brands` (`routes/salesDemos.js`) now returns `reviewedProductCount` per brand, consumed by the frontend Sales Demos brand card's "review coverage %" badge. Docs updated: `docs/PROGRESS.md` (demo-sync table row + new "Sales Demos — brand list review coverage" section).
- **Backfill**: existing brands have no `websiteBackground` until re-enriched (transforms default to white meanwhile).
- **Not-yet-covered transparency surfaces** (listed in ai-creative-pipeline.md): HTML template `panel_bg`/body for static image ads; Remotion plate fallback `#3D3D3D`; legacy `videoCompositeService` `b_black` chain; `layoutInputService` crop URLs.
- Multi-instance caveat: retitle/preview job stores are in-memory (single-instance).
- Canvas engine still scrim-based + brand-font-poor by design — only reachable via custom scripts or explicit engine override now.
- **Not yet verified** (raised by the adversarial pass, plausible but unconfirmed): `plateIntelService.analyzePlate`'s `BANDS` were retuned for vertical's new safe zone, but the function takes no `format` param — could misapply vertical geometry if `titlePlacementMode:'content'` is ever used on a feed-format ad. Narrow blast radius (content mode is opt-in; default is canonical). Worth a look before anyone flips a brand to content mode on feed placements.

## Session log
- 2026-07-22: All of the above implemented (Grok CLI drafted; Fable reviewed line-by-line + one hand-edit: guardrail defaults to Reels bands when chrome=None; adversarial Grok pass run pre-commit). Owner decisions: corrections now / calibrate later; guardrail toggle yes; tighten vertical safe zone now.
- 2026-07-22 (adversarial round): fixed — draft-wipe race (prop-sync now gated by previous-prop-equality ref; regen poller freshens headline/ctaText from response), stale-response guards via live openAdIdRef in all save/re-render handlers, exported-ad gating added to legacy Ads page, re-render no longer requires a prior copy save (standalone re-title after placement changes), inputs disabled during regen, image-ad copy note, honest no-URL toast. Known bounded race: a poller tick landing mid-save can briefly clobber onMutated state; next tick self-corrects. Backend now shallow-merges videoSettings, so multi-card PATCH spreads are safe.
- 2026-07-22 (ship): committed, pushed, PR'd (#2), independently re-reviewed (fresh Grok adversarial pass on the actual staged diff — separate from the drafting-time review above), one real issue confirmed and fixed same-day (ctaText/overlay-text conflation, PR #3). Both merged into `main`, commits Verified server-side.
- 2026-07-22 (sales demos, PR #6): review-coverage % progress note + stage rename in `genericCatalogIngestService.js`, `reviewedProductCount` added to `GET /api/sales-demos/brands` (paired with frontend PR #6's brand-card badge). Merged. Docs updated (`docs/PROGRESS.md`).
