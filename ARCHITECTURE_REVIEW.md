# liquidretail_backend — Architecture, Design & Security Review

**Repo:** `/home/user/liquidretail_backend` (Express + Mongoose, multi-tenant; Render web dyno + background worker; Atlas Cloud for image/video/LLM generation).
**Date:** 2026-07-28.

## Method

This review was produced by a set of adversarial agents working under a fixed *refute-or-confirm* contract: every finding had to be traced to `path:line` in code read directly on disk, and each claim was stated as something a second reader could try to break. The usual Grok relay used for an independent second opinion was unreachable this session (it needs an owner-side restart on the Mac); in its place, **every P0/P1 money- or security-critical finding was independently re-verified by a second agent reading the cited code cold**, and the four verification passes' verdicts override the first-pass severities where they differ. The two remote-code-execution claims were treated as extraordinary claims: each was confirmed by *both* executing the exact `vm`/`spawn` call shape in isolation *and* tracing a reachable authenticated HTTP route to it. Severity downgrades and one upgrade-conditional are noted inline against each finding so the reasoning is auditable.

**Count:** 77 distinct findings after de-duplication — **7 P0, 14 P1, 41 P2, 15 P3.** The recurring brand-script-isolation and double-bill findings that appeared across multiple slices have been merged.

---

## Executive summary

Three buckets a founder can triage independently. Each is real, each is reachable in the running system, and none requires an exotic precondition.

### A. SECURITY — a tenant can run code on your server, and can plant credentials in another tenant's account

- **Authenticated-tenant remote code execution.** The brand `styleScript` preview path compiles user-supplied JavaScript with `vm.compileFunction` and **no** `parsingContext` — which does not sandbox anything. The compiled function resolves free identifiers against the real global object, so its first line can be `process.mainModule.require('child_process').execSync(...)`. Any logged-in customer (or anyone who phishes one session) reaches it via `POST /api/brand/:id/preview-script`, which forces `engine='canvas'` and bypasses the production kill-switch. Confirmed by executing the exact call and by tracing the route. *(GEN-1, GEN-2)*
- **The env-scrub that was supposed to contain a hostile script does not.** The child runs as the same OS user as the API, so it reads `/proc/<ppid>/environ` and recovers the parent's full secret set — Mongo URI, every provider key — and nothing blocks its network egress. The blast radius of the RCE is your entire database and every credential, from one HTTP request. *(GEN-2)*
- **Cross-tenant credential injection.** All three OAuth connect routes trust an unverified `X-Brand-Id` header. A caller can write an `IntegrationCredential` row against *another tenant's* `brandId`; the service layer then resolves credentials by `brandId` alone. This is a confused-deputy that publishes a victim's ads through an attacker's ad account, and (at connect finalize) injects attacker-controlled catalog/posts into the victim's brand. *(DATA-1)*

### B. MONEY — you are being billed for work you don't record, and re-billed for work you already paid for

- **Video is charged at submit, but nothing durable remembers the charge.** The billable Veo submit happens, then the `predictionId` lives only in a local variable and the `CostLog` row is written *only after* poll + download + Cloudinary upload all succeed. Any death or timeout after submit = **unrecorded spend** *and* a **guaranteed re-bill** on requeue, because there is no persisted receipt to adopt the orphan. *(PIPELINE-2, XREPO-4)*
- **Re-render after a reaper requeue re-buys the video.** On re-entry the render path never consults `ad.veoVideoUrl` as a spend receipt for image-seeded ads, so it submits a fresh billable generation. Every deploy/autoscale event manufactures exactly this crash. *(GEN-3)*
- **The direct-OpenAI fallback double-charges.** `generateImage`/`editImage` catch *any* post-submit error — including a poll timeout on a generation Atlas already billed — and replay against direct OpenAI. One request, two charges, the Atlas charge unledgered. *(XREPO-2)*
- **The image ledger has been $0 forever.** The price cache reads `m.pricing.actual.price`; the live catalog field is `price.actual.base_price` (verified against the live catalog). The lookup never matches, so *every* Atlas image generation is recorded at $0.00 and per-tenant rollups understate spend by the entire image line. *(XREPO-1)*

### C. DURABILITY — the thing that renders your paid work dies whenever you deploy or scale, and nothing drains the queue

The render loop (including every billable Veo call) runs fire-and-forget inside the **autoscaled web process**. The orphan reaper flips stuck ads back to `queued`, but **nothing drains `queued`** — paid work halts until a human clicks Generate. Worse, render CPU on the web service is itself what trips the 60%-CPU autoscale trigger that replaces the instance and kills the render. The failure rate rises with load. Poll-only job state for retitle/preview/spec/script also lives in per-process `Map`s that evaporate on deploy and are invisible on a second instance. *(PIPELINE-1, DATA-5; full treatment below.)*

---

## Findings

Grouped by severity, then by area. Money/security flags are explicit. Recommendations are the smallest sound fix unless noted.

### P0 — fix before the next deploy

**GEN-1 — Brand `styleScript` is executed, not sandboxed → authenticated-tenant RCE.** `services/brandScriptRunner.child.js:139` calls `vm.compileFunction` with no `parsingContext`; the parameter list controls the function's arguments, not its scope chain, so the body resolves `globalThis`/`process`/`process.mainModule.require` against the live V8 context. Reachable by any tenant via `routes/brand.js:1147` (`bodyScript` branch forces `engine='canvas'`, bypassing the kill-switch) → `brandScriptExecutor.js:398` `runChild`. **SECURITY.** *Fix:* delete the `bodyScript` branch at `routes/brand.js:1147` and the custom-script branch at `brandScriptExecutor.js:772` so only vetted canonical scripts reach `runChild`; long-term, make brand styling a validated *data* spec (as `titleStyleSpec`/`metaCascades` already are) and never ship executable brand code in-process.

**GEN-2 — `/proc/<ppid>/environ` defeats the env scrub → full secret disclosure.** `services/brandScriptExecutor.js:260` scrubs the child's env to PATH/NODE_PATH, but parent and child share a uid, so the child reads the parent's environ block (Mongo URI, provider keys) and exfiltrates over unblocked egress. Corollary of GEN-1; the executor's documented isolation guarantee is void. **SECURITY.** *Fix:* fixing GEN-1 makes this unreachable — do not patch in isolation (hiding `/proc` still leaves filesystem + network). Under a real boundary the child would run as a distinct non-root uid with no `/proc` and no egress.

**DATA-1 — Unverified `X-Brand-Id` on all three OAuth connect routes → cross-tenant credential injection.** `routes/integrations.js:169-190` (and the meta-ads/google-ads connect siblings) sign the client-supplied `brandId` into OAuth state with no ownership check; the callback persists it verbatim (`:255-266`); services resolve by `brandId` alone (`metaAdsPushService.js:73-90`, `adReadinessService.js:49`, `catalogSyncService.js:362`, `postSyncService.js:481`). Precondition is only knowing the victim's brand ObjectId. **SECURITY.** *Fix:* call the already-present, currently-unused `assertBrandInTenant(brandId, req)` (`middleware/tenantHelpers.js:58-66`) in all three connect handlers before signing state; add `advertiserId` to every service-layer credential lookup as defence in depth.

**PIPELINE-2 / XREPO-4 — Video billed at submit; `predictionId` never persisted; `CostLog` only on success → unrecorded spend + guaranteed re-bill.** `atlasVideoService.js:2351` is the charge point; the id lives only in a local const, and `recordFlatCost` fires at `:2400-2416` after poll (up to 10 min) + download + upload. Any failure/death in between loses the ledger row and, on requeue, re-submits from scratch — there is no orphan to adopt. The same file gets this *right* for the image reframe path (`:1395-1403`, `billed=true` at submit, never cleared); the expensive path lacks that discipline. **MONEY.** *Fix:* immediately after `:2351`, persist `{veoPredictionId, veoSubmittedAt, veoSubmittedModel}` on the Ad and write the CostLog estimate pre-poll (`estimateRenderCostUsd` needs only model/duration/resolution, all known before submit); on render entry, if a fresh `veoPredictionId` exists, poll it instead of resubmitting. Long-term: a `VideoGeneration` ledger row per submit with state `submitted|landed|lost`.

**GEN-3 — Re-render after reaper requeue re-submits billable video.** `routes/ads.js:742` declares `veoVideoUrl` fresh and generates unconditionally; for image-seeded ads `ad.veoVideoUrl` (written at `:792`) is never read back on re-entry, so the reaper's requeue → re-select → re-pay. This is an auto-retry of a billable submit, spelled as a reaper — violating the project's own submit-once rule. **MONEY.** *Fix:* seed `veoVideoUrl` from `ad.veoVideoUrl` before the `if (!veoVideoUrl)` gate at `:742`, so a re-render resumes at compositing (the correct semantics — the base video is the expensive immutable artifact).

**XREPO-1 — Image cost logged at $0 forever (wrong catalog field).** `services/atlasImageService.js:46` reads `m.pricing.actual.price`; the live catalog exposes `price.actual.base_price` (no `pricing` key exists) — verified against the live catalog and the repo's own Atlas skill doc. `priceCache` never populates, `priceFor()` returns 0, every image gen ledgers $0.00. **MONEY.** *Fix:* `m.price?.actual?.base_price ?? m.price?.actual?.output_price`; better, delete this cache and call the shared `price()` helper (see divergence section). The `/models` GET is also unauthenticated (`:43`) — a second latent break.

**XREPO-2 — `generateImage`/`editImage` fall back to direct OpenAI on any post-submit error → double charge.** `services/atlasImageService.js:159-163`, `:183-192`: the `catch` around a billable Atlas submit (`:72`) replays against OpenAI on poll timeout / `status:'failed'` / download failure; `recordFlatCost` runs only on the success branch, so the Atlas charge is unledgered. **MONEY.** *Fix:* have `submitAndPoll` throw with `charged:true` once the POST returns an id (the pattern exists at `atlasVideoService.js:697-701`), gate the OpenAI fallback on `!err.charged`, and ledger the Atlas spend either way.

### P1 — fix this cycle

**PIPELINE-1 — Billable render loop runs in the autoscaled web process; nothing drains `queued`.** *(Downgraded P0→P1: real, but documented in-repo, fires an `error`-level alert, and causes no silent data loss — it stalls paid work until a human clicks Generate.)* `routes/ads.js:341,508` dispatch `runRenderLoop` via `setImmediate`; the reaper requeues (`worker.js:151-154`) but `workerLoop` polls only DetectRun + Job, never `Ad{status:'queued'}` (`worker.js:213-275`). **DURABILITY.** Full target architecture below.

**PIPELINE-3 — No atomic claim in the ad lifecycle → concurrent double-submit.** `selectAdsForRun` is three plain `Ad.find({status:'queued'})` reads (`campaignAdsGenerationService.js:875-911`); the "claim" is an unguarded bulk `updateMany({_id:{$in}})` (`routes/ads.js:384-390,472-478`); `renderOne` fetches by id with no status check (`:680`). Two concurrent `/generate`+`/runs` on one campaign submit the same ads twice. **MONEY.** *Fix:* replace select-then-bulk-flip with a loop of per-ad `findOneAndUpdate({campaignId,status:'queued',…},{$set:{status:'rendering'}})` — exactly the DetectRun pattern at `worker.js:219-227`; guard `renderOne`'s terminal writes on `{_id,status:'rendering'}`.

**PIPELINE-5 / GEN-8 — Regenerate lock has no lease and no reaper coverage.** The atomic lock is correct (`adRegenerateService.js:114-130`) but is released only by in-process `markComplete` (`:326-345`); the reaper never touches `regenerating` (grep of `worker.js` = 0 matches). A deploy mid-regen — a window containing a billable Veo submit — strands `regenerating:true` forever, permanently 409-ing the ad. **MONEY / reliability.** *Fix:* treat the flag as a lease (refuse only when fresh `updatedAt`), and add a reaper clause clearing `{regenerating:true, updatedAt<cutoff}`. Long-term, regeneration is just a render job — put it on the same worker queue.

**DATA-3 — Roles are stored and displayed but never enforced → privilege escalation.** `middleware/requireAuth.js:13-15` documents that no route reads `req.user.role`; `routes/members.js:58-89` lets a `viewer` PATCH their own membership to `owner` (only the last-owner *demotion* is guarded). Same gap on invite/revoke. **SECURITY.** *Fix:* a `requireRole(...)` middleware on mutating membership/invitation routes, and reject promotion to a role at or above the caller's own; long-term a default-deny capability check.

**DATA-5 — Poll-only job state lives in per-process `Map`s.** `routes/brand.js:435,731,1378,1671` hold retitle/preview/spec/script job state that clients poll; on scale-out the poll lands on the wrong instance, on deploy it vanishes mid-Remotion-render (1.5–3 GB, billable Cloudinary uploads discarded). **DURABILITY.** *Fix:* persist to the existing `OperationRun` model + `/api/progress` feed; long-term enqueue to the worker so the route is a thin submit + status read.

**DATA-2 — `/api/products` is authenticated but wholly unscoped `[LEGACY]`.** `index.js:204-250` mounts CRUD behind `requireAuth` with no tenant predicate, and `Product` (`models/Product.js:3-21`) has no tenant field at all — any authenticated user of any tenant can enumerate/mutate/delete every row. **SECURITY.** *Reachable-but-legacy:* this is vestigial truck-inventory code outside the ad tool's Brand/Advertiser model — global exposure, not cross-tenant-within-the-ad-tool — but it is mounted and live. *Fix:* delete the block, or gate operator-only.

**DATA-4 — Unfiltered body write (mass assignment) `[LEGACY]`.** `index.js:244` `Product.findByIdAndUpdate(req.params.id, req.body)` writes the raw request body; combined with DATA-2, an arbitrary write to an arbitrary row. Same legacy caveat as DATA-2. **SECURITY.** *Fix:* allowlist editable fields (as `routes/brand.js:247-248` already does), or delete with DATA-2.

**GEN-4 — Regenerate daily cap can never fire → no daily ceiling on paid regens.** *(Downgraded P0→P1: the in-flight lock serializes regens, so this is "no daily ceiling," not a burst.)* `HISTORY_CAP=5` `$slice`-bounds `regenerationHistory` (`adRegenerateService.js:123`), but `DAILY_CAP=10` (`:55`), so `recent.length >= 10` (`:76`) is unsatisfiable — the only spend control on the endpoint is dead at default config. Each blocked call would have prevented a ~$1.75 full video regen. **MONEY.** *Fix:* count from an uncapped source (a `(adId, yyyy-mm-dd)` counter incremented in the lock update, or `RegenerateEvent` rows); at minimum assert `DAILY_CAP <= HISTORY_CAP` at load. Long-term cap *spend* per tenant, not calls per ad.

**GEN-5 — No run-level ceiling on either video path.** `MAX_ADS_PER_GENERATION_RUN` guards only the legacy image cartesian (`campaignAdsGenerationService.js:744`); the deterministic path emits one ad per product unbounded (`:1747`) and the concept path caps only per `(product,kind)` (`:2193`). A wizard run over a 500-SKU catalog queues 500 ~$1.75 renders. **MONEY.** *Fix:* apply the existing backstop to the merged payload before insert, and surface the truncation; long-term a per-tenant spend budget checked at expand time (the `dryRun` branch already computes the projection).

**GEN-6 — Concept path is non-idempotent by construction.** `computeV2IdentityDigest` hashes the LLM-minted `concept_id` (`:1463-1474`), which is fresh per Director round, so the `(campaignId, identityDigest)` unique index never collides across runs — double-pressing Generate doubles LLM *and* video spend, reported as full success both times. **MONEY.** *Fix:* derive the digest from content (`seedUniverseHash` + ordered media picks + CTA), not LLM identity; long-term an `Idempotency-Key` on `POST /api/ads/generate` recorded against the CampaignRun.

**GEN-7 — LLM spend precedes dedup, with unbounded fan-out.** `Promise.all` over all products (`:2033`) issues Director + Judge calls per product before any dedup at `insertMany` (`:2233`), with no concurrency limiter against per-model RPS. Rate-limit rejections surface as "fewer ads than expected" (`:2182-2185`), not errors. **MONEY.** *Fix:* bound fan-out (4–6), short-circuit per product on a non-stale `CreativeDirectionArtifact`; long-term split cheap idempotent *planning* from expensive *concept* generation.

**GEN-9 — Layout-artifact read key ≠ write key.** The write keys on 7 fields (`layoutInputService.js:319-326`, matching the unique index); `renderService.js:309` reads on 5, omitting `campaignContextHash` and `paletteSource`, so it can FK the Ad to a different palette/context variant than the one just validated — a promotional campaign can silently render product-mode copy. *Fix:* add the two fields to the `findOne`; better, have `buildLayoutInput` return `{input, artifactId}` so no re-query is needed. (`layoutResolverService.js:44-52` already matches all 7 — the correct pattern is two files away.)

**GEN-10 — Titling meta resolved by `mediaId` alone.** `brandScriptExecutor.js:576` (and `:893`) resolve the LayoutInputArtifact by `mediaId` + `createdAt` only — one of seven key fields — so titling text (quote, price, benefits, brand theme) burned into a paid video can come from another product's derivation, discovered only by watching the finished clip. *Fix:* resolve through `Ad.layoutInputArtifactId` (persisted at `renderService.js:1027`), falling back to the query only for legacy rows. GEN-9/GEN-10 share a root: the 7-field layout key has no single owner.

**XREPO-5 — Bounded 4× retry of a billable `/generateVideo` submit.** `atlasVideoService.js:2050-2078` re-POSTs when a regex over the error body matches rate-limit phrasing. *(Conditional money risk: a clean 429 creates no prediction and is safe; double-bill occurs only when the broad regex matches a 5xx that actually created a billable prediction.)* **MONEY.** *Fix:* delete the retry and pre-pace submits (the expander's `atlas.ts:78-99` gate); the backend already has the correct poll-side jitter/backoff — it just applies retry on the wrong side of the charge.

### P2 — schedule deliberately

| ID | Claim | path:line | Flag |
|---|---|---|---|
| PIPELINE-4 | Heartbeat is completion-driven; a single 15-min+ ad stall (no completions) lets the reaper flip the mid-flight batch, reopening the double-spend window *(downgraded P1→P2: only bites on a zero-completion stall)* | `routes/ads.js:604-607`, `worker.js:50` | MONEY |
| PIPELINE-6 | `CampaignRun` stuck in `preparing` (death during expand) is unreapable and unwatched — hangs forever | `worker.js:167-170`, `backlogWatchdog.js:92` | |
| PIPELINE-7 | `VEO_CONCURRENCY` is per-process; at autoscale-3 the global rate is 3 against a 1-RPS provider | `routes/ads.js:143-144` | |
| PIPELINE-8 | SIGTERM alerts but never releases claimed ads — recovery always costs the 15-min reap + a human | `processAlerts.js:119-131` | |
| PIPELINE-9 | express-session default `MemoryStore` on an autoscaled service breaks the OAuth handshake across instances | `index.js:67-72` | SEC-adj |
| PIPELINE-10 | Spend watchdog sums a `CostLog` that (per PIPELINE-2) misses failed video spend — blind during provider incidents | `backlogWatchdog.js:137-150` | MONEY |
| DATA-6 | `Ad` has no `advertiserId`, so `tenantFilter` is unavailable and every call site hand-rolls ad→media→brand scoping *(downgraded P1→P2)* | `models/Ad.js:29` | |
| DATA-7 | Self-heal recreates an **owner** membership from stale `User.advertiserId`; only a lazily-built index stops it resurrecting revoked access | `requireAuth.js:64-83` | SEC |
| DATA-8 | JWT accepted from `?_token=` query string → lands in access logs, history, `Referer` | `index.js:177-184` | SEC |
| DATA-9 | `advertiserId` is `default:null` on artifact models, so `tenantFilter` silently returns zero rows for un-backfilled data | `models/CropArtifact.js:8` (10 files) | |
| DATA-10 | Spend ledger has no `advertiserId` and `brandId` defaults null — per-tenant cost not derivable | `models/CostLog.js:28` | MONEY |
| DATA-11 | `routes/brand.js` (134 KB, 30 routes) owns job lifecycle, concurrency pooling, disk caching — a service layer wearing a router's clothes | `routes/brand.js` | |
| DATA-12 | Encryption blob carries no `keyId` — no rotation path without decrypting every row | `integrationCryptoService.js:16-24` | SEC |
| DATA-13 | No validation library; error mapping turns client `CastError` into 500 and discards the tenant helpers' 404 semantics | `routes/campaigns.js:119`, `requireAuth.js:88` | |
| GEN-12 | Puppeteer launched per render, `--no-sandbox`, no pool/cap, while the sibling Remotion service pools at concurrency-1 *(downgraded P1→P2)* | `renderService.js:712` | SEC-adj |
| GEN-13 | `runFfmpeg` has no timeout and the kill targets one pid not the group — a hung/adversarial encode outlives the render *(downgraded P1→P2)* | `brandScriptExecutor.js:211` | |
| GEN-14 | Canvas render engine disabled by a hardcoded early return but still reachable via preview endpoints — carries the GEN-1 risk with no production value | `brandScriptExecutor.js:797` | |
| GEN-15 | Two orthogonal ad state machines (`status`, `regenerating`) with writers in 15 files and no transition owner | `models/Ad.js:157` | |
| GEN-16 | Whole MP4s base64'd into memory and HTTP responses; per-render memory scales with video size | `brandScriptExecutor.js:532` | |
| GEN-17 | Temp dirs cleaned only on normal exit; process death orphans them and no janitor sweeps the roots | `brandScriptExecutor.js:88` | |
| GEN-18 | Three half-live representations of the layout contract gated by three independent env flags (8 reachable combinations) | `layoutResolverService.js:10`, `renderService.js:355` | |
| PROMPTING-1 | Validator HTTP-probes every URL it extracts from LLM HTML — including off-allowlist ones — with no private-IP filter *(downgraded P1→P2: semi-blind SSRF, status echoed not body)* | `htmlValidationService.js:153-163` | SEC |
| PROMPTING-2 | Pre-Judge hard-violation gate falls open: if every candidate violates, index 0 ships anyway *(downgraded P1→P2)* | `aiCanvasHtmlGeneratorService.js:316-321` | SEC |
| PROMPTING-3 | `<script>` regex is the only active-content check; HTML runs in Puppeteer JS-on, `--no-sandbox`, `networkidle0` *(downgraded P1→P2; becomes P1 only if the generated ad HTML is ever served raw to an end-user browser — the confirmed sink is a Puppeteer screenshot)* | `htmlValidationService.js:118,278` | SEC |
| PROMPTING-4 | Unanchored host suffix match — `host.endsWith('instagram.com')` accepts `evil-instagram.com` | `htmlValidationService.js:79` | SEC |
| PROMPTING-5 | Concept scores zipped positionally; the schema's per-row `concept_id` is never checked, so reordering misattributes every rank | `aiJudgeService.js:443-456` | |
| PROMPTING-6 | HTML Gen always pays for 2 candidates at 12K tokens on the priciest tier, then picks index 0 — no judge | `aiCanvasHtmlGeneratorService.js:32,328` | MONEY |
| PROMPTING-7 | Director `copy_picks` (grounded on scraped review copy) interpolated unescaped into the HTML prompt with "render VERBATIM" → published ad copy + 2nd-order injection | `aiCanvasHtmlGeneratorService.js:606-631` | SEC/MONEY |
| PROMPTING-8 | Scraped `product.description` and IG `caption` enter the Generator prompt uncapped while the Director caps the same fields | `aiCanvasInputBuilder.js:144,240` | MONEY |
| PROMPTING-9 | Seven hand-rolled prompt builders, seven schema builders, three version constants, no shared template — safe-area geometry authored three times | `aiCreativeDirectorService.js:560` et al. | |
| PROMPTING-10 | V2 prompt instructs a Google Fonts `<link>`, V1 forbids external fonts, validator warns "renderer runs offline, will timeout" — three sources disagree | `aiCanvasHtmlGeneratorService.js:628`, `htmlValidationService.js:122` | |
| PROMPTING-11 | Three services gate on `OPENAI_API_KEY` but call through Atlas — an Atlas-only deploy 500s the Director and silently no-ops HTML Gen | `aiCreativeDirectorService.js:83`, `aiCanvasHtmlGeneratorService.js:61` | |
| PROMPTING-12 | `gemini-2.5-flash-image` absent from `MODEL_RATES` — every overlay-polish call logged at $0.00 | `aiOverlayPolishService.js:149`, `costTracker.js:20` | MONEY |
| PROMPTING-13 | Uncapped `operatorPrompt` is never in `DROP_PRIORITY`; an over-cap prompt returns with a `console.warn` → silent failed billable video submit | `veoPromptBuilder.js:270-393` | MONEY |
| XREPO-3 | A 5xx *whose body also contains rate-limit phrasing* wrapping a failed prediction is polled to timeout *(downgraded P1→P2: a real `status:'failed'` returns HTTP 200 and is handled correctly)* | `atlasVideoService.js:1868-1877` | MONEY (indirect) |
| XREPO-8 | `validateStatus:()=>true` makes the image poll ignore HTTP status; a 401/402/500 spins silently to the 180 s timeout | `atlasImageService.js:84-108` | MONEY (hides 402) |
| XREPO-9 | Two incompatible rate-limit strategies (expander pre-paces, backend reacts); neither survives multi-process | `atlas.ts:66-99` vs `atlasVideoService.js:2043-2078` | MONEY (partial) |
| XREPO-10 | Backend crop sizing rounds and can emit **odd** dimensions — fine for Cloudinary, fatal for H.264 `yuv420p` | `smartCropService.js:28-36` | |
| XREPO-11 | Crop placement differs — backend scores 3 candidate centers and may pick a non-subject-centered one | `smartCropService.js:44-63` | |
| XREPO-12 | `computeSafeRect` mixes pixel and normalized coordinate conventions in one function with no validation | `smartCropService.js:151-177` | |
| XREPO-13 | Request bodies hardcoded via `MODEL_CAPS`/`paramShape` switch, so an Atlas schema change is invisible until a paid submit fails | `atlasVideoService.js:236-337` | MONEY (partial) |

### P3 — track

| ID | Claim | path:line |
|---|---|---|
| PIPELINE-11 | Rate-limited alerts drop without incrementing `suppressed` — the "+N more" tally undercounts | `alertService.js:290-294` |
| PIPELINE-12 | A `renderOne` dispatch-crash strands the ad in `rendering` while the run is marked `done` short of total | `routes/ads.js:632-635` |
| DATA-14 | Invite tokens never expire and are returned raw in the list response | `models/AdvertiserMembership.js:46` |
| DATA-15 | Sibling queries in one `Promise.all` — one brand-scoped, one not (safe by transitivity today) | `routes/campaigns.js:438` |
| GEN-11 | `downloadToFile` lacks allowlist/private-IP/size-cap (SSRF) *(downgraded P1→P3: the "no redirect limit" sub-claim is refuted — axios defaults to 5 — and it is gated behind the disabled canvas path)* | `brandScriptExecutor.js:232` |
| GEN-19 | Deterministic video digest omits `videoDurationSec` — changing length reports "alreadyQueued" and produces nothing | `campaignAdsGenerationService.js:1482` |
| GEN-20 | Regenerate catch block can itself throw (unhandled rejection in a `setImmediate` worker); cancel path returns without settling the run | `adRegenerateService.js:168` |
| PROMPTING-14 | No shared output-validation layer; the direct-Gemini fallback forwards `strict:true` json_schema to a gateway that may not honor it | `atlasLlmService.js:92` |
| PROMPTING-15 | Judge's "small cheap model" premise is stale (2.5×/3.75× the quoted rates); judge and generator are the same vendor family — unmitigated self-family bias | `aiJudgeService.js:9`, `costTracker.js:36` |
| PROMPTING-16 | `max_tokens` silently clamped to 16,384; over-budget callers get truncation surfacing only as a downstream `JSON.parse` failure | `atlasLlmService.js:85` |
| XREPO-14 | `REFRAME_COST_USD` defaults to 0.08 while the submitted model is `edit-developer` (0.04) — reframe spend over-reported 2× (safe direction) | `atlasVideoService.js:84-86` |
| XREPO-15 | Video cost comes from hand-maintained, self-described "UNVERIFIED" per-second rates instead of the live catalog | `atlasVideoService.js:305-380` |
| XREPO-16 | Browser `User-Agent`/WAF convention honored in the expander but nowhere in the backend (not currently enforced by the WAF — measured 200s) | backend: none |
| XREPO-17 | Vision-derived label/brand/category strings interpolated verbatim into the refine prompt (bounded blast radius) | `cropRefineService.js:215-240` |
| XREPO-18 | `buildCloudinaryCropUrl` clamps only to `≥0`/`≥1`, never to image bounds | `cropRefineService.js:400-411` |

---

## The render-queue architecture problem

**The validated failure, precisely.** Ad rendering — including every billable Veo generation — is dispatched fire-and-forget via `setImmediate` inside the **web process** (`routes/ads.js:341`, `:508` → `runRenderLoop` at `:539`). The orphan reaper flips ads whose holder died from `rendering` back to `queued` (`worker.js:151-154`), but the worker loop polls only `DetectRun` and `Job` — never `Ad{status:'queued'}` (`worker.js:213-275`); `selectAdsForRun` is called from exactly two HTTP handlers and nothing else. The code says so itself (`worker.js:185-189`: "nothing drains 'queued' automatically … somebody has to press Generate"). So on any web-process death mid-render — deploy, autoscale replacement, OOM — the in-flight batch is orphaned, requeued, and then *sits* until a human re-triggers it. Compounding this: Puppeteer/ffmpeg/compositing CPU runs on the web service whose autoscale triggers at 60% CPU, so **the render workload is what trips the autoscaler that kills the render workload** — a self-defeating placement, not a tuning knob. Render's SIGKILL arrives after a drain window capped at 300 s, while `MAX_POLL_MS` is 10 min, so an in-flight video poll *cannot* be drained on Render even with a perfect shutdown handler — it will always be killed mid-poll (sourced: Render zero-downtime deploy docs and background-worker guidance below).

**Recommended target architecture — one, with reasoning.** **Move ad rendering to the existing worker service as a third Mongo-claimed polled queue, reusing the proven `findOneAndUpdate` atomic-claim + `updatedAt` reaper pattern this repo already runs for `DetectRun` (`worker.js:219-227`).** Web routes do expansion + enqueue + CampaignRun creation only; the worker claims one ad at a time atomically (`findOneAndUpdate({_id,status:'queued'},{$set:{status:'rendering',claimedBy,heartbeatAt}})`), heartbeats on a timer (decoupling liveness from completion, fixing PIPELINE-4), and the reaper you already have covers crashes. This is **zero new infrastructure, zero new failure domains, no Redis bill**, and because the worker is single-instance `VEO_CONCURRENCY=1` becomes globally true again (fixing PIPELINE-7). The two prerequisites the job-shape change forces are exactly the P0 fixes above: persisted `predictionId` so a killed poll is *resumable* by any worker (PIPELINE-2), and check-receipt-before-submit so at-least-once redelivery is safe (GEN-3).

**Why not Redis/BullMQ yet.** BullMQ buys real primitives — lock-renewal recovery (stronger than a 15-min staleness heuristic), delayed jobs, a rate limiter that would finally give the per-(team,model) RPS gate a shared home — but it costs a Redis instance and a second data plane to operate, and, decisively, **its default retry semantics are actively dangerous for billable submits**: `attempts` must be pinned to 1 and every stall-retry path audited, or a stalled job is silently re-processed by another worker — i.e. a re-run of a paid Veo submit. At this throughput (nowhere near the "tens of thousands of jobs/minute" threshold the sourced selection rule names for BullMQ), the Mongo claim you already have is correct and the library adds an infra plane a small team doesn't need. Adopt it only when priorities/delays/rate-limiting outgrow comfortable Mongo polling. If a Mongo-native library is ever wanted for lease semantics, Agenda/Pulse fit the existing stack without Redis — but sequence it *after* the SIGTERM handler and resumable polling, because no library fixes a poll longer than the drain window.

Sources (durable queue architecture, Node + Mongo on Render):
- https://render.com/docs/deploys
- https://render.com/articles/how-render-handles-zero-downtime-deploys
- https://github.com/render-oss/skills/blob/main/skills/render-background-workers/SKILL.md
- https://docs.bullmq.io/guide/workers/stalled-jobs
- https://github.com/agenda/agenda
- https://github.com/pulsecron/pulse
- https://judoscale.com/blog/node-task-queues
- https://blog.appsignal.com/2023/09/06/job-schedulers-for-node-bull-or-agenda.html

---

## The Atlas-integration divergence

The sibling repo (`reach-social-llm-expander`) has already solved, in production-hardened form, four concerns this backend gets wrong: submit-once/no-retry, structural terminal-failure classification, live-catalog costing, and a typed error taxonomy. **Recommendation: extract a shared `@reach/atlas-client` and adopt the winning side per concern** (named in the last column). The backend's charge-point billing discipline and its cooperative-cancel + poll jitter/backoff are the halves worth keeping from *this* side.

| Concern | Expander | Backend | Winner |
|---|---|---|---|
| Submit semantics | One POST, never retried, contract in the header (`atlas.ts:10-12`, `:113-142`) | Video retries 4× on regex-matched rate-limit (`atlasVideoService.js:2048-2078`); image/reframe correct | **Expander** |
| Rate-limit handling | Proactive process-wide per-model gate, never burns a submit (`atlas.ts:69-99`) | Reactive poll jitter + escalating backoff (`atlasVideoService.js:1834-1899`) | **Split** — expander's *submit* gate + backend's *poll* backoff |
| Poll / terminal classification | Structural parse of a failed prediction at 3 nesting levels, rate-limit-wrap distinguished (`atlas.ts:231-269`) | Only `data.status==='failed'` on a 2xx; a 5xx-wrapped failure misread (`atlasVideoService.js:1868`); image ignores HTTP status entirely | **Expander, decisively** — the single most valuable artifact in either repo |
| Error taxonomy | `AtlasError{status,code}` + biased-retryable classes (balance/auth/moderation) (`atlas.ts:18-51`, `:165-184`) | Flat `new Error(string)`, no NSFW/balance distinction | **Expander** |
| Cost accounting | Live catalog `price.actual.base_price`, `video = base_price × snapDuration` (`cost.ts:27-40`, `:100-104`) | Hardcoded blocks, two self-labelled UNVERIFIED; image lookup reads a field that doesn't exist (XREPO-1) | **Expander** |
| Charge-point / ledger timing | Bills at terminal-ok only — loses the charge on timeout (`media.ts:1303`) | Bills at *submit*, `billed` never cleared, ledgered on every exit (`atlasVideoService.js:1395-1403`) | **Backend** — but it applies this to reframe and *not* to video render (XREPO-4), inconsistent with itself |
| Idempotency / claim | SQLite CAS (`store.ts:500-526`) | Mongo `findOneAndUpdate` CAS + orphan reaper (`worker.js:249-253`) | **Tie** (each correct for its engine; backend additionally has the reaper) |
| Request-body construction | Live per-model OpenAPI schema, refuses on missing required input (`normalize.ts:380-431`) | Hand-maintained `MODEL_CAPS` + `paramShape` switch (`atlasVideoService.js:236-337`) | **Expander for correctness, backend for operator UX** (`validateVideoSettings` catches typo'd slugs at write time) |
| Audit honesty | Prompt-cap measured on the body actually sent (`normalize.ts:395-412`) | `submittedImageUrls` single source of truth for body + audit record (`atlasVideoService.js:1933-1955`) | **Backend** — best-in-class |

A shared client would be: `submitOnce` (expander) · `classifyPrediction` (expander) · `poll` with jitter/backoff/cancel (backend) · a pluggable submit limiter (single-process default + Mongo-backed impl) · `price()` (expander, against the live catalog) · a charge-point ledger hook fired at submit (backend).

---

## Prompting layer

Four themes, one fix. **(1) Template drift** — seven hand-rolled prompt builders and schema builders with no shared layer (PROMPTING-9); safe-area geometry is authored three times and the Director's archetype enum already disagrees with the HTML prompt's, observably, not hypothetically. **(2) The Judge gate fails open** (PROMPTING-2) — when every HTML candidate hard-violates, index 0 ships anyway, and under prompt injection "all candidates violate" is the *expected* state; the HTML path (the one the renderer consumes) does not even call the Judge that the JSON path does (PROMPTING-6). **(3) Validator SSRF** (PROMPTING-1, -4) — the validator probes the very URLs it flagged off-allowlist, through an unanchored suffix match that accepts `evil-instagram.com`. **(4) Scraped-copy injection** (PROMPTING-7, -8) — review/description/caption text flows verbatim and uncapped into prompts told to "render VERBATIM," reaching published ad copy and a second-order injection point.

**Recommendation: a single validated prompt/schema layer** — a `promptKit` module owning shared blocks (format caps, safe areas, allowlists, vocabulary) rendered from one source of truth; an `untrusted(text, maxLen)` wrapper that caps/strips/wraps every scraped or user field in an explicit "data, not instructions" delimiter block; one `PROMPT_CONTRACT_VERSION` in every artifact cache key; and one `chatCompletionJson(meta, params, validator)` that Ajv-validates the parsed output against the schema already being sent (closing the strict-mode fallback hole, PROMPTING-14). Split hard-violation codes so security checks (`has_script`, disallowed host, `on\w+=`, `javascript:`, `<iframe>`) fail *closed* while quality checks stay fail-open. `titleSpecValidator.js` is the in-repo model to port.

---

## Strengths worth preserving

These are verified-sound and should anchor, not be disturbed by, the fixes above.

- **Queue-time idempotency via `identityDigest`** — sha256 over identity inputs with a per-campaign unique index (`models/Ad.js:212,349`) plus boot-time `syncIndexes` in both processes (`index.js:283-305`, `worker.js:80-95`). Duplicate inserts are structurally impossible; keep this as the anchor of any queue redesign.
- **The DetectRun atomic-claim + `updatedAt` reaper** (`worker.js:219-227`, `:158-166`) — the exact pattern the ad-render fix should copy. The fix is applying proven code to a third collection, not new design.
- **The alerting stack's paranoia** — never-throws contract with pre-await dedupe claiming, bounded key-space, token redaction (incl. malformed-URL leak), and exit-semantics-preserving crash/signal handlers (`alertService.js:280-315`, `processAlerts.js:84-156`).
- **Charge-point billing discipline on the reframe path** (`atlasVideoService.js:1395-1403`, `:1461-1512`) — `billed=true` at submit, never cleared, persist-only-if-billed, with the principle ("an overstated ledger is correctable, an understated one is invisible") argued in the code. This is the model the video path must copy.
- **`titleSpecValidator.js`** — allowlist-driven, fail-closed, returns a *normalized* document rather than blessing input in place; callers gate on `ok` before persisting. The rigor model for the whole prompting layer.
- **The sandboxed `srcdoc` preview boundary** (`adPreviewPageService.js:189`) — LLM HTML rendered as `<iframe srcdoc="${htmlEscape(...)}" sandbox="allow-same-origin">` with no `allow-scripts`; this is why PROMPTING-3 is a server-side SSRF issue and not stored XSS.
- **AES-256-GCM credential crypto** (`integrationCryptoService.js:32-40`) — fresh 96-bit IV per call, auth tag stored and verified, strict key-length check, plaintext confined to the service layer, and `/token-debug` deliberately returning a `first4…last4` fingerprint.
- **`tenantHelpers` throwing rather than silently unscoping** (`middleware/tenantHelpers.js:16-26`) — `tenantFilter` throws when `req.advertiserId` is missing, and `assert*` helpers 404 rather than 403 to avoid existence leaks. The fix for the tenancy findings is extending this pattern, not inventing one.

## Sound areas

`aiCreativeV2Helpers.js` (pure functions, idempotent URL transforms); `adSuitabilityService.js` and `adReadinessService.js` (pure, deterministic, consistently wired, "not connected ⇒ not blocked" documented); the deterministic-video path's money-aware seed validation (`campaignAdsGenerationService.js:1593-1628`, refusing to promote a category match to a product match with the ~$1 rationale written down) and its genuinely stable digest; the Remotion asset-server design (`remotionRenderService.js:119-238` — server-side fetch so the render browser has zero egress, path-traversal guard, pooled browser, concurrency-1 queue) as the quality bar for the render fix; cost instrumentation that wraps the failure path and records cache hits as explicit $0 rows; and `atlasLlmService`'s well-reasoned retry policy (router-missing breaks immediately, one fallback attempt with the caller's original params).
