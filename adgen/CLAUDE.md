# CLAUDE.md — liquidretail_adgen

> **Monorepo (2026-09-06).** This tree now lives at `adgen/` inside
> `liquidretail_backend` (GitHub survivor, trunk `main`, merge `e6393912`).
> The parent **is** the backend. `Emami-RS-Project/liquidretail_adgen` is
> archive/rollback-only and deploys nothing. Monorepo rules (mongoose 8
> fail-closed, freeze-N 512, CI, hooks) live in the root `CLAUDE.md`.
> Paths below are relative to `adgen/`. Live state: root `session.md`.

Ad-generation **renderer** microservice for Reach Social. Forked from
`liquidretail_backend`. Deploys to Render as **four** services from one Docker
image (`Dockerfile`, `render.yaml`: api / orchestrator / renderer / titler).
Shares the **same MongoDB** as the backend. Survivor trunk is `main`
(this prefix used to be `master` on the split repo).

**Citations.** Older architecture sections were written against
the then-`origin/master` @ `881dabd` (2026-08-24, PR #4) and their `file:line` pins
have drifted. Video-provider / Gemini / DINO-ref / autoscale-pin /
vision-QC-derive-gate / director-benefits material is against
then-`origin/master` @ `fde6003` (2026-09-03). If a line number does not match
the tree you have open, `git log -1 --oneline` first (survivor trunk is `main`).

**Read the root `session.md` for live branch/PR state.** This file is architecture, not
handoff.

---

## codemap — known bug: `--importers`/`--deps`/hub-detection unreliable here

**Confirmed upstream bug, filed as
[JordanCoin/codemap#147](https://github.com/JordanCoin/codemap/issues/147).**
This repo is entirely CommonJS with single-quoted `require()` throughout — the
worst case for it. codemap's ast-grep rule for plain `.js` files
(`scanner/sg-rules/javascript.yml`) hardcodes `import`/`require` patterns to
**double-quoted** strings only; `.ts`/`.tsx`/`.jsx` use a quote-agnostic
structural rule instead and are unaffected. Verified directly: `entrypoint.js`
requires `./services/renderer` (single-quoted); `codemap --importers
src/services/renderer.js` reports "No files import
src/services/renderer.js." — a confident false negative on the single most
important file in the service. The accompanying "Go resolves imports at
package level" note is separately misleading boilerplate (already fixed
upstream, unrelated to this bug) — ignore it either way.

**Before trusting a codemap blast-radius/importer/hub result here, assume
it's wrong** and verify with `grep -rn "require(.*['\"].*<name>"` instead.
`codemap .` (tree/structure) and `codemap --diff` are unaffected — neither
depends on import parsing.

---

## What this service is

This repo owns **rendering** of ads that the backend has already minted and
moved to `Ad.status='rendering'`.

It does **not** own the HTTP generate API, expansion (Director/Judge/mint),
auth, catalog ingest, or Meta/Google publish. Those stay on
`liquidretail_backend`. The adgen **orchestrator** role is still a Phase 0
no-op (`src/services/orchestrator.js:1-12`) — expansion has not moved here.

The live cutover switch is **`ADGEN_RENDERER_ENABLED`**, read by **both**
repos:

- Backend `services/adgenBridge.js:13-15` and `routes/ads.js:1715-1723`: when
  the flag is the string `'true'` (case-insensitive), `runRenderLoop` flips
  the `CampaignRun` to `running` and **returns without dispatching**.
- Adgen `src/config.js:64-66` (`isAdgenRendererEnabled`) and
  `src/services/renderer.js:709` (`claimOne` re-reads at call time): when
  the flag is **not** `'true'`, the renderer poll loop sleeps (does not
  claim). When it **is** `'true'`, this process atomically claims ads and
  does the Atlas-image / provider-routed-video / Remotion / Cloudinary
  work. Video **generation** provider is a separate env (`VIDEO_PROVIDER`,
  currently `atlas` — see Direct-Gemini section below); this flag is
  ownership of the collection, not Atlas-vs-Gemini.

Committed default in `config/defaults.env` is `ADGEN_RENDERER_ENABLED=true`
— adgen owns rendering in production (matches the live dashboard). Parser
fail-safe is still OFF when unset (`=== 'true'` only). A boot that does
not load this file and does not set the flag will not steal work from
backend's in-process `runRenderLoop`.

There is **no** `ADGEN_SERVICE_ENABLED` / `ADGEN_ORCHESTRATOR_ENABLED` in
this tree. Those names appear only in the stale Phase 0 README; do not
invent them.

---

## How the trees relate

| Tree | Role |
|---|---|
| `liquidretail` | React SPA. Separate GitHub repo, trunk **`master`**. Netlify `staging.reach-social.io`. Talks to the **backend** HTTP API only. |
| `liquidretail_backend` (this GitHub repo, trunk **`main`**) | Express + Mongo. Render `liquidretail-backend.onrender.com`. Auth, catalog, wizard `/api/ads/generate`, expansion, mint, claim. When the flag is on, it **stops** at claim. |
| `adgen/` (this prefix) | **Live renderer.** Four Render services from Docker context `./adgen`. The old `liquidretail_adgen` GitHub repo is archive/rollback-only. |
| `rs-ai-backend` | Older/parallel backend fork. **Reference only** — not the live API, not the live renderer. |

The SPA (and `claude-org-brain`) stay separate GitHub repos under `/Volumes/Sayulita/Projects/RS/`.

---

## Four roles (`ADGEN_ROLE` → `src/entrypoint.js`)

One image, one entrypoint. `src/config.js` **exits 1** unless `ADGEN_ROLE`
is exactly `api`, `orchestrator`, `renderer`, or `titler`. Boot: connect
Mongo → start the matching role → install SIGTERM/SIGINT.

`render.yaml` maps the four Render services:

| Role | Render service | What the code actually does |
|---|---|---|
| `api` | `adgen-api` (web, starter, `:3100/health`) | Express app with **only** `GET /health`. 200 if mongoose `readyState === 1`, else 503. No inspect endpoints, no generate API. |
| `orchestrator` | `adgen-orchestrator` (worker, starter, singleton) | Polls `CampaignRun.countDocuments({ status: 'preparing' })` and logs. **No writes, no lease, no expansion**. Phase 2 is still a comment. |
| `renderer` | `adgen-renderer` (worker, autoscale **pinned in file**) | The live path. `renderer.run()` → `poll()` burst-claims up to `ADGEN_MAX_INFLIGHT` ads and fires `processAd` as unawaited promises. `render.yaml` `scaling:` is min 2 / max 4 (see autoscale pin below). |
| `titler` | `adgen-titler` (worker, autoscale **pinned in file**) | Out-of-process Remotion titling — polls for `{status:'rendering', veoVideoUrl:{$ne:null}, titlingNeeded:true, claimedByWorker:null}` when `ADGEN_TITLER_ENABLED=true`. Live in production (`render.yaml` ships `"true"` on renderer and titler). `scaling:` is min 4 / max 12. |

Worker identity: `ADGEN_WORKER_ID` or auto `${ROLE}-${random}`. Stamped onto
`Ad.claimedByWorker`.

### The titler handoff — env-var switchover (Phase 3, 2026-08-24)

The renderer's video path, when `isTitlerEnabled()` is true, atomically
stamps `veoVideoUrl` + `titlingNeeded: true` + clears the claim, all in the
SAME `$set`. It returns without titling (no in-process Remotion, no
bumpRunCounter). The titler role picks up the row on its next poll and
does Remotion out-of-process where Chrome gets the full 8 GB without
contending with the renderer's poll loop / Atlas HTTP / static submits.

**Money invariants preserved.** The persist-write is ONE $set (see the
long-standing veoVideoUrl+veoReferenceImages co-persist rule — same
argument). The renderer's handoff write is owner-scoped
(`claimedByWorker: WORKER_ID`). The titler's terminal write is
`status:{$in:['rendering','draft']}` guarded so vision-QC-`failed` verdicts
are not resurrected to `draft`. The titler NEVER calls Atlas.

**Rollback path.** Flip `ADGEN_TITLER_ENABLED=false` and the renderer
titles in-process again — the renderer's Remotion path was NOT deleted
(Phase 4 is when that goes away, after the switchover is proven stable).
Both paths coexist; the flag chooses. `render.yaml` ships `"true"` on
renderer and titler (production). `config/defaults.env` ships `false` as
the local / api / orchestrator fallback.

**Duplication.** `titler.js` duplicates several helpers from `renderer.js`
(`startAdHeartbeat`, `bumpRunCounter`, `maybeFinalizeRun`,
`settleNonDraftTerminal`, `notifyRunFinalized`, the per-run heartbeat
plumbing). Phase 4 consolidates these when the renderer's copies vanish
with the code that uses them. If you edit one copy, edit the other.

Pinned by `scripts/verifyTitlerHandoff.js` (44 checks, revert-proven on
10 targeted mutations covering both sides + config + render.yaml).

### The retitle handoff — a FOURTH claim namespace (2026-08-28)

`src/services/retitleConsumer.js` lets backend's manual
`POST /:id/retitle-videos` defer to this service, gated on
`isAdgenRendererEnabled()` like everything else in this file. It is
deliberately NOT a reuse of the titler claim above: that claim requires
`status:{$in:['rendering','draft']}` — built exclusively for "a master just
landed and has never been titled" — while a manual retitle's real target is
commonly `status:'live'`, delivered days or weeks earlier. Backend stamps
`Ad.retitleRequest` (filter requires `titlingNeeded:{$ne:true}`, so it can
never race the renderer→titler handoff above); this service claims via a
DISJOINT field pair (`retitleClaimedByWorker`/`retitleClaimedAt`) and
executes via `brandScriptExecutor.renderBrandScriptAndSave({...,
retitleMode: true})`.

**`retitleMode:true` is not optional.** `uploadRenderAndStamp` forces
`status:'draft'` unconditionally by default — correct for the first
titling pass, and a real bug for a retitle of an already-delivered ad
(would silently un-publish it). `retitleMode` skips that AND routes a
Remotion child failure at all three call sites to a plain throw instead of
`stampTitlingFailureAndThrow`, whose entire job (bound FIRST-titling
retries via the shared `Ad.titlingAttempts` cap) is a lifecycle a retitle
isn't in. Found and fixed in BOTH repos' `brandScriptExecutor.js` — see
`docs/CONTRACT-backend-adgen.md` §4a for the full mechanism, and
`session.d/2026-08-28_retitle-adgen-handoff.md` for the investigation.

Unlike the regenerate consumer, this one runs a stale-claim reclaim sweep
(`reclaimStaleRetitleClaims`, mirroring `reclaimStaleTitlerClaims` above) —
retitle makes no NEW Atlas video-generation submit, so an auto-release on
a stuck claim costs only time and a re-run of the same (already
pre-existing, unavoidable) vision-QC/face-detection LLM calls every
titling render makes — not a double VIDEO charge, which is what the
regenerate consumer's own no-reclaim design guards against.

⚠️ **Two adversarial Grok review passes (2026-08-28) independently found
the stamp filter needed `regenerating:{$ne:true}` too** (fixed in backend)
— without it a retitle could be stamped on an ad a regenerate is actively
rewriting. The REVERSE direction (a regenerate starting while a retitle is
already claimed) is a known, narrower residual, not fixed — see
`docs/CONTRACT-backend-adgen.md` §4a.

Pinned by `scripts/verifyRetitleConsumerClaim.js` (18 checks, revert-proven
on the claim-safety and status-preservation guards).

---

## Direct-Gemini video provider — LIVE IN PRODUCTION via dashboard override (repo default is still `atlas`)

Pinned to `origin/master` @ `fde6003` (2026-09-03). Landed across PRs
#108 (`3178c69`, "merges dark"), #110 (`035913e`), #113 (`b1e3a10`)
plus follow-ups `7935e93` / `00ba9d1` / `bb6e01a` / `fde6003`.
(`#114` is a vendor-manifest merge-order gate, not Gemini behaviour.
`#115` is director-benefits — separate section below.)

**VERIFIED LIVE 2026-09-04 — read this before the "committed default"
section below, which is about the repo, not production.** Queried the
Render API directly (`GET /v1/services/{id}/env-vars` against
`adgen-renderer` = `srv-da4bh9rbc2fs73cff2rg`, using the API key in
`~/.render/cli.yaml`, workspace `tea-d1ved76mcj7s73fad3og`) rather than
inferring from committed code — this is the same class of blind spot
that made the `pro_plus` plan bump invisible to the repo until the file
caught up, so it needed a direct query, not a grep. Result:
**`VIDEO_PROVIDER=gemini` is explicitly set on the live `adgen-renderer`
service**, overriding the file default below. `adgen-titler` /
`adgen-api` / `adgen-orchestrator` and both `liquidretail_backend`
services do **not** override it (irrelevant anyway — only the renderer
dispatches generation). Checked in the same pass:
**`VIDEO_RAW_CATALOG_REFERENCES=false`** is also explicit on
`adgen-renderer` (matches the file default — **not** live), and
**`VIDEO_BENEFITS_PLACEMENT` has no override anywhere** (runs on the
file's `true` default, so director-benefits placement — section below —
**is** live).

**Practical effect of the "no `override:true`" dotenv behavior below:**
production traffic is on Gemini, not Atlas. Everything in the "Two
dispatch points" / "Charge point" / "Error classes" / "Lease" / "Key
resolution" / "Reference assembly" sections after this point is **live
production behavior today**, not a "when (if) flipped" hypothetical —
read it that way. A fresh checkout, a local `npm start`, or a brand-new
Render service without the dashboard var copied onto it will still run
Atlas, because that override lives only on this one service's Render
dashboard config, not in git. Re-verify with the same API query
(`env-vars` endpoint, service id above) before trusting this if it's
been a while — a dashboard override can be flipped back without a
commit, and this file cannot detect that on its own.

### The committed default is Atlas. Gemini is not the live provider *in this repo's own config* — production overrides it.

**`config/defaults.env:394` is `VIDEO_PROVIDER=atlas`.** Code default in
both dispatch sites is the same string:

- `src/services/videoRouter.js:42-44` `activeProvider()` →
  `String(process.env.VIDEO_PROVIDER || 'atlas').toLowerCase()`
- `src/services/renderer.js:1460` same expression, inlined
- `src/services/geminiVideoService.js:93-95` `isEnabled()` is
  `=== 'gemini'` against that same read

**`render.yaml` does not set `VIDEO_PROVIDER` on any of the four
services.** Confirmed by reading the file: renderer/titler envVars are
`ADGEN_ROLE`, `ADGEN_RENDERER_ENABLED`, `ADGEN_TITLER_ENABLED`,
`ADGEN_MAX_INFLIGHT`, `MONGODB_URI` only.

PR #108's own subject is `(merges dark)`. session.md's 2026-09-03
landing note for #110 records the same: the path was deployed dormant
and `VIDEO_PROVIDER` was not touched.

**Render-dashboard override — CHECKED, not a blind spot anymore.**
`src/config.js:10-13` loads dotenv **without** `override:true`, so a
dashboard env var wins over `config/defaults.env`. That means this
*file* cannot see a manual Render override by reading source — but the
live Render API can, and was queried (see the VERIFIED LIVE callout at
the top of this section): **`VIDEO_PROVIDER=gemini` is set on
production `adgen-renderer`, overriding the `atlas` default below.**
Same class of override as the historical `pro_plus` plan bump. If this
gets re-flipped later without a commit (it can — dashboard changes
don't touch git), this file will not reflect that on its own; re-query
`GET /v1/services/srv-da4bh9rbc2fs73cff2rg/env-vars` to check current
truth rather than trusting this doc indefinitely.

### Two dispatch points, not one

A grep for `videoRouter.generateForAd` finds nothing. That is not
absence — regenerate aliases the module.

| Caller | File | What it does |
|---|---|---|
| **First-time mint / claim** | `renderer.js:1460-1489` | Own seam. `atlas` → `atlasVideo.generateForAd`; `gemini` → `geminiVideo.generateForAd` (**no `prompt` argument** — provider owns prompt + refs). Anything else **throws** before a billable submit. Does **not** accept `vertex`. |
| **Regenerate** | `adRegenerateService.js:43` requires `./videoRouter` as `veoService`; `:1669` calls `veoService.generateForAd({…, allowResume:false})` | Goes through `videoRouter.generateForAd`. |
| **Storyboard prep only** | `renderer.js:159` `prepareStoryboard: veoPrepareStoryboard` | `videoRouter.prepareStoryboard` (`:52-55`) no-ops to `{storyboard:null}` for every non-atlas provider. |

`videoRouter.js:73-158` `generateForAd`:

- `atlas` → `atlasVideoService.generateForAd`
- `gemini` → `geminiVideoService.generateForAd` (the block at `:76-140`
  commented `ADDED 2026-09-03 WITH THE DIRECT-GEMINI CUTOVER`). This
  branch exists because **before it**, `VIDEO_PROVIDER=gemini` fell
  through regenerate into the deprecated Vertex Veo path (catalog-title
  interpolation — the Vaportek class of bug). Renderer never called
  this function for mint, so a router-only Gemini branch would have
  been a no-op on first render while Atlas kept billing.
- `vertex` → `aiVideoReferenceService.generateForAd` (reachable **only
  by naming it**; no longer the fall-through)
- anything else → throw, same fail-closed shape as renderer

**Asymmetry worth not losing:** renderer refuses `vertex`; the router
still accepts it. Flipping `VIDEO_PROVIDER=vertex` would throw on mint
and still bill Vertex on regenerate.

**Rollback** is the same shape as `ADGEN_TITLER_ENABLED`: flip
`VIDEO_PROVIDER` back to `atlas` (or unset it — both code defaults are
`atlas`). The Atlas path was not deleted. Gemini code is required at
renderer boot (`renderer.js:150-152`) so a missing module fails at
start, not on the first billable Gemini render, but with the flag at
`atlas` that require is a load-only cost. Whether a Render dashboard
edit mutates a **running** process's `process.env` without a restart is
unverified (CONTRACT §9.2); the code re-reads `process.env` at call
time.

**Stale comments in source — do not trust these as current:**

- `videoRouter.js:28-36` still says Gemini "IS NOT YET SWITCHABLE"
  because it has no reference assembly. That was true at #108; **#110
  closed it** (`geminiReferenceAssembly.js`, provider owns refs). The
  remaining reason it is not live is the env default, not missing refs.
- `renderer.js:1454-1458` still says the router's non-atlas arm is
  Vertex fall-through. **#110 made that fail-closed.**
- `geminiVideoKey.js:12-16` still says "no production Gemini video path
  yet" / "forthcoming". The service exists; it is not the routed
  default.
- `renderer.js:18-23` file header still claims the video path is unwired
  Phase 1c. It has been the live path for weeks.

### Charge point is an accepted `interaction_id`, not HTTP status

This is the opposite of Atlas and is why Atlas's
`isDefinite429` / `submitRetryDecision` must not be ported here.

Measured 2026-09-03: exceeding Google's cap did **not** return HTTP 429
on POST. POST returned **200 with an `interaction_id`**; the first poll
returned `too_many_requests`. An id is possibly billed. `background:false`
bills **synchronously** (a stray $0.36 during a validation pass).
`buildRequestBody` is exported so a dry run can inspect bytes without
POSTing. Gemini **never** returns `price`; Atlas's "no price ⇒ unbilled"
inference would mark every completion unbilled and resubmit forever.

`geminiVideoService.generateForAd` (`:507+`) order of operations (do
not reorder):

1. Assemble refs (`assembleReferences`) unless the caller injected a
   non-empty `images` array (harness / dry-run only).
2. Resume from `Ad.veoPredictionId` when `allowResume` and a non-empty
   id exist — GET only, never a second POST.
3. Build prompt (provider-owned; see below).
4. `lease.acquire()` **before** POST. Null after bounded internal
   backoff → `{skipped:true, retryable:true, code:'GEMINI_LEASE_EXHAUSTED'}`.
   Renderer holds the Ad claim through that loop; it does **not** persist
   a counter (`renderer.js:170-174`).
5. POST once. Stamp `veoPredictionId` + `veoProvider:'gemini'` +
   `veoPrompt` / `veoModel` / `veoAspectRatio` / `veoResolution`
   **before** the first poll (`:672-683`).
6. Ledger at the charge point (`recordFlatCost` with
   `providerRequestId`, not a non-schema `predictionId`).
7. Poll. Heartbeat the lease every tick. Classify. Settle cost from
   `usage.output_tokens_by_modality` video tokens (not a fictional
   `usage.video_tokens` top-level field).
8. Download Files-API URI → Cloudinary overwrite-by-identity
   (`gemini_${interactionId}`). Return the **Cloudinary** URL as
   `videoUrl` — the Google URI is credentialed and expires.
9. `finally` release the lease.

Prompt precedence (`:558-604`): (1) explicit `prompt` arg (harness
only — real router/renderer call sites pass none), (2) non-empty
`operatorPrompt`, (3) `ad.veoPrompt` **only when `isResuming`**, (4)
`buildVeoPrompt` CORE. Ungated use of `ad.veoPrompt` is how a
regenerate (`allowResume:false`) silently resubmitted the previous
prompt.

### Error classes (recovery vs terminal)

`classifyPoll` (`geminiVideoService.js:344-378`):

- `error.code === 'too_many_requests'` → `rate_rejected` (possibly billed, not a free replay)
- `status` completed/succeeded → `completed` (billed)
- `status` failed/error → `failed` (possibly billed)
- **any top-level `error` object** that missed the above → `failed`,
  **not** `pending`. #113 (`b1e3a10`) — a content-policy body is
  `{error:{message,code}}` with **no** top-level `status`, so it used
  to fall through to `pending`, poll until `MAX_POLL_MS`, and get
  treated as a timeout instead of the rejection it already was.

Then `generateForAd` maps those onto thrown / returned codes:

| Code | When | `billed` | What recovery does |
|---|---|---|---|
| `GEMINI_AUTH_MISSING` | no key after fallback | `no` | never reached the network |
| `GEMINI_NO_PROMPT` / `GEMINI_NO_REFERENCES` | refuse empty submit | `no` | throw before POST |
| `GEMINI_SUBMIT_REJECTED` | POST, no id | `no` only on 4xx + structured `error`; else `possible` | only structured pre-work rejection licenses a replay |
| `GEMINI_TRANSPORT` | socket/timeout on POST | `possible` | recover by GET, never POST again |
| `GEMINI_LEASE_EXHAUSTED` | cap full after internal backoff | nothing billed | `{skipped, retryable:true}`. Renderer throws after that budget (unbilled fail). Regenerate parks on its claim instead of `markComplete('failed')` (`adRegenerateService.js:1676-1688`). |
| `GEMINI_RATE_REJECTED_AFTER_ACCEPT` | poll `too_many_requests` after an accepted id | `possible` | receipt stays; later free GET can still collect |
| `GEMINI_UNSETTLED_AT_TIMEOUT` | poll still pending at `MAX_POLL_MS` | `possible` | `unsettledAtTimeout:true` → leave `status:'rendering'` so bootRecovery can collect |
| `GEMINI_CONTENT_POLICY_BLOCKED` | failed + message/code matches `/prohibited\|content polic\|filtered out\|violat.*polic/` | `possible` | **terminal** for this attempt (`retryable:false`). Own Slack path vs generic "Video generation failed". |
| `GEMINI_GENERATION_FAILED` | any other failed poll | `possible` | terminal for this attempt |
| `GEMINI_NO_OUTPUT_URI` | completed but no `steps[].content[].type==='video'` uri (file still PROCESSING) | billed | `unsettledAtTimeout` — same recoverability as poll timeout |
| `GEMINI_OUTPUT_DOWNLOAD_FAILED` / `GEMINI_OUTPUT_MIRROR_FAILED` | billed + delivered at Google, local mirror failed | billed (`makeUnsettledMirrorError`) | **must not** write `status:'failed'` — that is invisible to bootRecovery's `status:'rendering'` selector and a later regenerate would double-bill |

`bootRecoveryService.js:448-580` routes by `Ad.veoProvider` (null
defaults to atlas). Gemini arm is GET-only (`resumeForAd` /
`downloadOutputToBuffer` / `uploadMirroredMaster`); CAS on
`renderStage:'boot-recovery-gemini-mirror'` so two autoscaled sweepers
do not both pull the same master.

### Lease (`geminiVideoLease.js`)

Not a semaphore. Google's cap is **per project per model** (measured:
`limit: 8` on `gemini-omni-1.1-flash`). adgen-renderer autoscales and
is double-instanced during deploy drain, so an in-process limiter
hands each instance the full budget.

Mongo collections `geminivideoleases` (occupancy, unique `(scope,slot)`)
and `geminivideoleaseevents` (append-only rate ledger). Holds **both**
constraints because occupancy-vs-RPM was never settled by a two-wave
probe:

- (a) at most `GEMINI_VIDEO_MAX_SLOTS` (default **8**) leases held
- (b) at most that many **acquisitions** per `GEMINI_VIDEO_RATE_WINDOW_MS`
  (default 60s)

Counting occupancy rows for (b) is structurally incapable of firing
(there are only MAX_SLOTS rows; a recycled slot overwrites
`acquiredAt`). The ledger is one INSERT per acquire. Unique index
failure → fail closed (`acquire()` returns null). Live holders
`heartbeat()` so TTL is abandon-of-dead-holder, not a wall-clock the
generation must finish inside (`GEMINI_VIDEO_LEASE_TTL_MS` default
600s, floor 120s). Independent of poll budget — same lesson as
`REFRAME_CLAIM_TTL_FLOOR_MS`.

**Sweeper-collision invariant** (`scripts/verifyGeminiLeaseSweeperCollision.js`):
do **not** persist `Ad.deriveWaitAttempts` (or `renderAttempts`) as a
Gemini lease-retry counter. `strandedRunSweeper` bounds
`deriveWaitAttempts < 3`; `queuedArchiveSweeper` never reads it. A
SIGTERM-queued receipt-free Gemini master that had cycled that counter
became invisible to stranded recovery and looked like 24h mint leftover
to the archive sweeper — silent loss of an **unbilled** creative. Fix:
hold the renderer claim through `generateForAd`'s internal
`LEASE_ACQUIRE_ATTEMPTS` (default 21 × 30s, floor 2) backoff.

### Key resolution (`geminiVideoKey.js`)

`GEMINI_VIDEO_API_KEY` if set and non-empty after trim/quote-strip,
else `GEMINI_API_KEY`. Empty video key is a true no-op (same credential
as grounded search) until a distinct key is supplied. Purpose: quota
isolation — grounded-search (~1,526 `gemini-2.5-flash`
`generate_content_paid_tier_2_requests`/24h) stays on `GEMINI_API_KEY`
and cannot move to Atlas (see `geminiSearchProvider.js` ATLAS GROUNDING
PROBE). Secret lives in the Render dashboard, never in
`config/defaults.env` (`GEMINI_VIDEO_API_KEY=` at `:405`). Never log
the key; fingerprint is last 4 chars. Pinned by
`scripts/verifyGeminiVideoKey.js`.

`src/config.js` does **not** require a Gemini key at renderer boot
(renderer still requires `ATLAS_API_KEY`). A `VIDEO_PROVIDER=gemini`
cutover without a key fails at submit (`GEMINI_AUTH_MISSING`), not at
boot.

### Reference assembly + shared DINO resolver

`geminiReferenceAssembly.js` exists because #108's provider took
`images` as a parameter and both callers passed `storyboard?.images`,
always `[]` on the gemini path. The provider now **owns** assembly.
Owner directive: **raw images, no reframe ladder, no paid nano-banana
outpaint.** Reuses Atlas's `buildReferenceImages` /
`sortCatalogMediasForReferenceStack` for packshot-protected ranking
(never a second copy). Gemini takes **base64 bytes** (Atlas takes
URLs); fetch validates `content-type` starts with `image/` (HTML 200s
must not become paid garbage refs). Throws rather than returning a
short stack (`GEMINI_REFS_NO_SEED` / `SEED_UNUSABLE` / `EMPTY`). Cap
`GEMINI_VIDEO_MAX_REFERENCES` default **3**; total base64 ceiling
`GEMINI_VIDEO_MAX_PAYLOAD_BYTES` default 20 MB is a **refusal**, not a
truncation.

Per-identity URL goes through `resolveVideoReferenceForMedia`
(`videoReferenceResolver.js`) via `buildReferenceImages`'s
`resolveUrlForIdentity` hook (`atlasVideoService.js:3695-3704`).

**Three $0 tiers, strict order:**

| Tier | `source` | What |
|---|---|---|
| 1 | `reframe-cache` | `Media.metadata.reframes[<aspectKey>].url` already persisted (prewarm / earlier Atlas `reframeReferenceForAspect`). |
| 2 | `on-demand-yolo` | Cache miss, but DINO bboxes on `refinedProducts[]`. `chooseStrategy` crop URL, **read-only** (does not persist — persist belongs to the reframe writer). Exists because prewarm's rank-based top-3 can diverge from render's operator picks. Only `action:'crop'` resolves; skip/defer/composite-mask fall through. |
| 3 | `c-fill-fallback` | No cache, no usable bboxes. Cloudinary `c_fill,g_auto`. |

Aspect key normalisation is bytewise-identical to
`reframeReferenceForAspect` (`':'` / `'.'` → `_`) so a mismatch cannot
silently miss every cache entry.

**`fde6003` "tier-3 c_fill ships source-native dims":**
`cropImageUrlForAspect` gained an optional 4th `targetDims` argument
(`atlasVideoService.js:1371-1384`). Tier 3 now computes
`sourceNativeCropDims` — largest crop rectangle at the requested
aspect that **fits inside the source without upscaling** (a 2000×2000
source at 9:16 → 1125×2000, not 720×1280). Unknown dims still use
output-native `imageDimsForAspect` (byte-identical to pre-change).
Never upscales.

**Does Atlas consume this resolver?** **Not today.** Atlas's default
`buildReferenceImages` path still calls `reframeReferenceForAspect`,
which is gated on `VIDEO_PROVIDER=atlas`. The shared resolver is
**opt-in** via `resolveUrlForIdentity`; only
`geminiReferenceAssembly.js` passes that hook. Atlas callers of
`cropImageUrlForAspect` omit `targetDims`. The helper is written as
the contract every video-model path *should* call
(`videoReferenceResolver.js:1-11`); only Gemini assembly actually does.
Hand-synced with `liquidretail_backend/services/videoReferenceResolver.js`
— the cache field is the same Mongo doc.

### Gemini knobs (code defaults; most are **not** in `defaults.env`)

| Knob | Default | Where |
|---|---|---|
| `VIDEO_PROVIDER` | **`atlas`** (file + code) | `config/defaults.env:394` |
| `GEMINI_VIDEO_API_KEY` | empty → fall back to `GEMINI_API_KEY` | `defaults.env:405`, `geminiVideoKey.js` |
| `GEMINI_VIDEO_MODEL` | `gemini-omni-1.1-flash` | `geminiVideoService.js:61` |
| `GEMINI_VIDEO_RESOLUTION` | `1080p` (measured same token count as 720p) | `:85` |
| `GEMINI_VIDEO_POLL_MS` | 600000 | `:104-107` |
| `GEMINI_VIDEO_POLL_INTERVAL_MS` | 5000 | `:109-112` |
| `GEMINI_LEASE_ACQUIRE_ATTEMPTS` | 21, **floor 2** | `:129-133` |
| `GEMINI_LEASE_ACQUIRE_BACKOFF_MS` | 30000 | `:134-137` |
| `GEMINI_VIDEO_MAX_SLOTS` | 8 | `geminiVideoLease.js:75-78` |
| `GEMINI_VIDEO_RATE_WINDOW_MS` | 60000 | `:82-85` |
| `GEMINI_VIDEO_LEASE_TTL_MS` | 600000, floor 120000 | `:116-120` |
| `GEMINI_VIDEO_MAX_REFERENCES` | 3 | `geminiReferenceAssembly.js:63-66` |
| `GEMINI_VIDEO_MAX_PAYLOAD_BYTES` | 20 MiB | `:79-82` |

None of these are in `src/services/concurrency.js`. Measured Gemini
cost at matched 1080p is **$1.0351**/master vs Atlas settle **$0.90**
(~15% more). Operator `modelOverride` is honored **only** when it
already looks like `gemini-*`; Atlas dropdown slugs are ignored
(`resolveGeminiModel`, `:157-161`). There is no Atlas-slug → Gemini
mapping.

---

## Director-benefits placement on live titling (PR #115 / backend #386)

`2c4b0b9`. Not a video-**generation** change.

- **Mint (still backend's job in prod; vendored copy here):**
  `campaignAdsGenerationService.js:3694-3716` stamps
  `Ad.videoTitleDirection` via `getVideoTitleDirection` when
  `VIDEO_BENEFITS_PLACEMENT === 'true'` (`config/defaults.env:1882`
  ships `true`). Failure fail-closes to `{include:false,
  reason:'director-failed:…'}` — expansion still mints (Omni is the
  money). One LLM call per `(product × profile × size)`, memoized
  across the 21-ad mixed kit (6 calls, not 21).
- **Live titling consumer:** `brandScriptExecutor.js:2416-2422`
  `applyBenefitsPlacement({ spec, meta, format, direction: ad.videoTitleDirection })`
  inside `renderWithRemotionAndSave`, **after** `resolveSpec` and
  **before** Remotion. Honours an already-visible benefits slot;
  splices a benefits slot into `proof` (never `hook`) when
  `direction.include === true` and `meta.benefits` is non-empty;
  validates via `validateTitleSpec` and skips the splice if invalid.
- **Not called from** `renderer.js`, `titler.js`, or
  `retitleConsumer.js` directly — those all go through
  `renderWithRemotionAndSave` / `renderBrandScriptAndSave`, so first
  title, titler handoff, and retitle all see it.
  `scripts/verifyVideoBenefitsDirector.js` W1 pins that wiring.

`render.yaml` does not set `VIDEO_BENEFITS_PLACEMENT` (inherits the
file default). **Checked live 2026-09-04 (Render API, `adgen-renderer`
env-vars): no dashboard override exists**, so it runs on the file's
`true` default — director-benefits placement is live in production,
unlike `VIDEO_PROVIDER` (which *is* overridden — see the Direct-Gemini
section above).

---

## Vision-QC derive ship gate is titling-only (`fcf3709`)

`adVisionQcService.js:83-103`. Four judge categories:
`competitor_marks`, `product_fidelity`, `text_defects`,
`layout_safe_box`. Pass floor 7.

A derive (`Ad.deriveFromMaster`) is a face-safe crop of a sibling
master's **already-paid** video pixels plus Remotion titling. It cannot
fix a fidelity / competitor-mark defect baked into the master.
`runVideoPostRenderQc({ titlingOnlyGate })` (`:2093-2178`) still **asks
the judge for all four scores** (persisted on `Ad.visionQc` —
derive-side `product_fidelity` is how master-QC false-positives get
caught), but `verdict.pass` is re-scoped to
`TITLING_CATEGORIES = ['text_defects','layout_safe_box']` only.

Caller: `brandScriptExecutor.js:1864-1875`
`titlingOnlyGate = !!ad.deriveFromMaster`. Log lines still print all
four scores; ungated below-floor scores get a `~` marker, gated
failures get `!`.

---

## Autoscale must live in `render.yaml` (`401e54f`)

Same footgun class as the `pro_plus` plan-name drift. Measured
2026-09-03 16:45 UTC: PR #109's deploy fired an
`autoscaling_config_changed` event that flipped enabled `true→false`
and dropped titler from 6 instances to 1, mid-run. **Render treats a
missing `scaling:` block as "disable autoscale", not "leave the
dashboard alone."**

Pinned in `render.yaml` as of `401e54f`:

| Service | min | max | targets |
|---|---|---|---|
| `adgen-renderer` | 2 | **4** (not 8) | 60% memory / 60% CPU |
| `adgen-titler` | 4 | 12 | 60% / 60% |

An older comment in the renderer `plan:` block still says "autoscaling
is currently DISABLED on this service" (`render.yaml:54-56`). That
sentence is leftover from before the pin; the `scaling:` stanza
immediately below it is the authority. `geminiVideoLease.js:11` still
says "min=2/max=8, currently disabled" — also stale relative to the
file.

---

## Render lifecycle (`src/services/renderer.js`)

Dispatch (`processAd`, `:2174-2179` as of `fde6003`):

- `renderRoute === 'html_gen'` → `renderStatic`
- `renderRoute === 'veo'` → `renderVideo`
- anything else → throw

### 1. Atomic claim

`claimOne()` (`:112-129`) is a single `Ad.findOneAndUpdate`:

```
filter: { status:'rendering', claimedByWorker:null, renderRoute:{ $in:['html_gen','veo'] } }
update: { $set: { claimedByWorker: WORKER_ID, claimedAt: now } }
sort:   { createdAt: 1 }
```

Derives **are** claimable without their own `veoVideoUrl`. Gating on the
derive's URL was a Phase 1a mistake (comment at `:114-118`): the URL is
inherited from the sibling master **during** render, never before.

Backend's reaper deliberately **skips** rows with `claimedByWorker` set
(`liquidretail_backend/worker.js:387-405`) so it does not requeue
adgen-owned work.

### 2. Static path (`renderStatic`, `:233+`)

Mirrors backend `renderService.deriveStage` + `directImageRenderService`:

1. `resolveQuoteAssemblyOptions` → `buildLayoutInput` → re-read
   `LayoutInputArtifact` by the same cache key → `applyStagedQuotePick`
   (`:255+`). The separate artifact lookup exists because
   `buildLayoutInput` does **not** return the artifact `_id`.
2. `directImage.renderDirectImage(...)` — billable Atlas
   `gpt-image-2/edit` (`:305`). Spend receipt is stamped inside
   `atlasImageService.submitAndPoll`.
3. Cloudinary upload with overwrite-by-identity (`uploadRenderToCloudinary`,
   `:69-88`).
4. **One** `Ad.updateOne` to `status:'draft'` with `renderUrl`, copy
   snapshot, `claimedByWorker:null` (`:365-392`). Doing upload+persist in
   one write closed a money bug where the row stayed `rendering`, got
   re-claimed, and re-billed Atlas (comment at `:345-351`).
5. `bumpRunCounter(..., 'succeeded')`.

Skip (`result.skipped`) stamps `status:'failed'` and bumps `skipped`
(`:329+`). Missing buffer throws (caught by `processAd` → `failed`).

### 3. Video master path (`renderVideo` when `resolveDeriveFromMaster(ad)` is falsy)

Money-critical: this is the **only** renderer path that may call a
billable video submit (`atlasVideo.generateForAd` **or**
`geminiVideo.generateForAd`). Derives still must not. Provider choice
is `VIDEO_PROVIDER` at `renderer.js:1460-1489` — see Direct-Gemini
section. As of `fde6003` the committed value is **`atlas`**, so the
live submit is still Atlas Omni.

1. `prepareStoryboard` via a **local alias**
   (`renderer.js:159`, call at `:1435`).
   `src/services/videoRouter.js:52-55` exports `prepareStoryboard`.
   Backend `routes/ads.js` binds it as
   `prepareStoryboard: veoPrepareStoryboard`. Phase 1c copied the **call**
   but destructured the alias name; that was `undefined` and **every
   first-time video master** threw `veoPrepareStoryboard is not a function`.
   Fixed by aliasing explicitly:
   `const { prepareStoryboard: veoPrepareStoryboard } = require('./videoRouter')`.
   On Atlas this returns `{storyboard:null}` (Ken Burns / CORE prompt
   directs motion). On Gemini it no-ops the same way.
2. Provider seam (`:1460-1489`) — `atlas` or `gemini` only; unknown
   values throw. Each provider stamps `veoPredictionId` before polling.
   `veoResult.skipped` (including `GEMINI_LEASE_EXHAUSTED`) throws after
   the provider's internal budget; nothing billed.
3. Persist master + `titlingNeeded` (handoff) or in-process titling,
   **one** `$set` with `veoVideoUrl` + `veoReferenceImages` together
   (`:1536+`).
4. When `isTitlerEnabled()` is false: **Remotion titling in-process**
   via `renderBrandScriptAndSave` (RAM-bound). When true: stamp
   `titlingNeeded:true`, clear claim, return — titler picks it up.
   `applyBenefitsPlacement` runs inside that titling call, not here.
5. Terminal stamp: `status:'draft'`, clear claim,
   `bumpRunCounter(..., 'succeeded')`.

### 4. Video derive path (`if (deriveFromFmt)` is the **first** branch)

`resolveDeriveFromMaster` is imported from
`campaignAdsGenerationService` (single definition, fail-closed on
`pmax_video_1_1`). If truthy, `renderVideo` **returns or throws** before
the Omni submit (`:458` opens the block; it returns at `:533`). Pinned by
`scripts/verifyRendererVideoMoneyInvariants.js`.

1. Cap wait attempts (`MAX_DERIVE_WAIT_ATTEMPTS`, default 60).
2. Poll sibling master (`findSiblingMasterAd`) up to
   `DERIVE_MASTER_WAIT_MS` (default **60s**, not 12 min — comment at
   `:95-102` vs the older comment at `:119` which still says 12 min and
   is stale relative to the constants).
3. If master never lands: `requeueDeriveForRetry` (releases claim, bumps
   `deriveWaitAttempts`, does **not** bump `renderAttempts`).
4. If sibling `status==='failed'`: throw (must not submit a paid master
   for a free surface).
5. Inherit `veoVideoUrl` / Cloudinary ids; stamp `titlingResumeState:'claimed'`.
6. Remotion titling (`:508-511`).
7. Terminal `status:'draft'` stamp (`:517-528`).

### 5. Terminal stamp / failure

`processAd` catch (`:628-645`): `status:'failed'`, release claim, bounded
`renderError`, `bumpRunCounter(..., 'failed')`.

`bumpRunCounter` (`:149-160`) `$inc`s the named CampaignRun field and
then calls `maybeFinalizeRun` (`:202-227`), which uses the vendored
`classifyRunAdOutcome` + `buildRunReconciliationUpdate` to CAS the run
to `done` once every claimed ad has settled. That write is unreachable
on the backend `runRenderLoop` happy path when the handoff flag is on
(backend terminal write sits after the early return).

---

## Vendored services — the maintenance hazard

This repo copies backend modules under `src/`. As of `fde6003` there are
**155** top-level `src/services/*.js` files (plus `brandScripts/`,
`brandStyles/`, `reviewAdapters/`) and **35** Mongoose models under
`src/models/`. They write the **same production collections**.

**A fix in `liquidretail_backend` is not live here until it is ported.**
`scripts/verifyRequireGraph.js` is the check that a copied `require()`
still resolves; `scripts/verifyModelParity.js` asserts adgen schema
paths ⊆ backend schema paths (subset, not equality).

Six video-path modules were missing from the original vendor and crashed
at runtime until PR #2: `seededUniverseService`, `reframeStrategyChooser`,
`overlayZoneService`, `metaCascadeResolver`, `metaCascadeConfig`,
`metaApiVersion`. After they landed, `verifyRequireGraph` reported
496/496 resolved.

### Layout difference (this has already caused bugs)

| | backend (repo root) | `adgen/` |
|---|---|---|
| Services | `services/` at **repo root** | `src/services/` |
| Models | `models/` at repo root | `src/models/` |
| Config | `config/` **directory** at repo root (`defaults.env`, `segmentPromptOverrides.js`) | **Both** `src/config.js` (**a file**) **and** `config/` (**a directory**) at repo root |

Node resolution from `src/services/*.js`:

- `require('../config')` resolves to the **FILE** `src/config.js`
  (renderer `:25`, orchestrator `:14`). That is intentional here.
- `require('../config/segmentPromptOverrides')` — the shape backend
  `services/staticAdIntents.js:908` uses — would look for
  `src/config/segmentPromptOverrides.js`, which **does not exist**. The
  real file is `config/segmentPromptOverrides.js` at repo root, which
  from `src/services` is `../../config/segmentPromptOverrides`.

When porting a backend service, rewrite every `../config/...` and
`../models/...` / `../services/...` require. Do not copy-paste. The
dotenv load in `src/config.js:12-13` is cwd-relative
(`config/defaults.env`); `Dockerfile` `WORKDIR /app` makes that work
in production.

`INPUT_SCHEMA_VERSION` must match the backend
(`src/services/layoutInputService.js` = `'4.2'`,
same as `../services/layoutInputService.js`). A
mismatch split-brains the `layoutinputartifacts` cache: one service
rebuilds, the other treats the row as fresh.

---

## Verify harness

On the grafted tree (survivor trunk `main`; not on a checkout parked at `81e3ae0`):

```
npm test
# same as:
node scripts/runVerifySuite.js
node scripts/runVerifySuite.js --list
node scripts/runVerifySuite.js --concurrency=4 --timeout=60000
node scripts/runVerifySuite.js verifyRequireGraph.js
```

`package.json` `"test": "node scripts/runVerifySuite.js"`. The runner
globs `scripts/verify*.{js,mjs}` at run time and **never** hardcodes a
count (`scripts/runVerifySuite.js:14-22`). Default timeout 120s,
concurrency `min(8, cpus)`. Exit 0 iff every selected script exits 0.

Files named `*_KNOWN_OPEN.js` are **expected to fail** until the defect is
wired. Do not "fix" them by relaxing assertions. There are currently none.

Backend location for cross-tree checks:
`ADGEN_BACKEND_PATH`, else the **parent** of `adgen/` (the parent IS the
backend), else `../liquidretail_backend` for leftover split-repo
checkouts (`scripts/lib/siblingBackend.js`). After the graft, a miss
throws (`assertBackendRoot`) rather than INFO-skip.

| Script | What it actually asserts |
|---|---|
| `verifyRequireGraph.js` | Every static `require('./…')` / `require('../…')` under `src/` resolves to a real file. Reports vendored-but-unreferenced files as INFO. Would have caught the deleted `reviewAdapters/helpers` production crash. |
| `verifyModelParity.js` | For every model that exists in both trees, adgen top-level schema paths ⊆ backend paths. Backend-only fields are INFO. Needs `mongoose` (falls back to the parent backend's `node_modules`). |
| `verifyRendererAtomicClaim.js` | `claimOne` filter requires `claimedByWorker:null`; two concurrent claims cannot both win (offline stub driven by the **real** filter text); claim is released on failure and derive-requeue; every terminal write clears `claimedByWorker`. |
| `verifyRendererVideoMoneyInvariants.js` | Structural: the single `atlasVideo.generateForAd` call is unreachable from the `if (deriveFromFmt)` block (every path throws or returns); a failed sibling master throws rather than submitting. |
| `verifyRendererAdStatusEnum.js` | Every `status:` value renderer **writes** is in `models/Ad.js`'s enum `queued/rendering/draft/live/archived/failed` and is a case `campaignRunGuards.classifyRunAdOutcome` recognises. Pins that renderer only writes `draft` / `failed` / `rendering`. |
| `verifyImagePricing.js` | `atlasImageService.buildPriceMap` reads `price.actual.base_price` (not the non-existent `pricing` key that led every image CostLog at $0). |
| `verifySubmitGuard.js` | `submitRetryDecision` / `isDefinite429`: replay an Atlas generation POST only when the error **proves** the request was rejected before work began. Ambiguous → do not replay. |
| `verifyVideoCostReconcile.js` | Video CostLog settlement: parse settled Atlas price, `finalizeFlatCost` on a real price, schedule fallback if missing, never write 0 from garbage, fire-and-forget on the render path. |
| `verifyArchiveDigestRelease.js` | Pure exported archive/requeue pipeline helpers (groups A–D). Group E (backend caller scan) is mostly skipped — adgen has no `routes/ads.js` / `worker.js`. |
| `verifyPmaxVideoExpansion.js` | PMax video minting money rules against vendored `campaignAdsGenerationService` / `platformFormats`; derive branch extracted from `renderer.js` instead of backend `routes/ads.js`. |
| `verifySharedPortraitMaster.js` | Mixed Meta+PMax shares one 9:16 master (one billable portrait plate). |
| `verifyQuoteProvenanceStamp.js` | `stampQuoteOrigins` reads `container.quotesOrigin`; flag-off baseline is an embedded snapshot of backend commit `3e4561e2`. |
| `verifyRunFinalizesOnSettle.js` | CampaignRun reaches `done` once every claimed ad has settled. Replays source-extracted `bumpRunCounter` (including its `maybeFinalizeRun` call at `renderer.js:744`) against the measured incident shape (succeeded=2, failed=1, total=3). Pins that `classifyRunAdOutcome` + `buildRunReconciliationUpdate` are called from `renderer.js`, and that a run does **not** finalize while a claimed ad is still `rendering`. |
| `verifyCampaignRunHeartbeatWired.js` | **Now passing — this was fixed on 2026-08-24 and the harness was renamed (the `_KNOWN_OPEN` suffix is gone).** It previously pinned an expected-fail: `startRunHeartbeat` was exported from `campaignRunHeartbeat.js` with **zero** call sites in `src/`. `startRunHeartbeat` now appears 4× in `renderer.js`. Why it mattered: without the beat, `CampaignRun.updatedAt` only moves when an ad *settles*, so a long video-titling gap could drop the backend duplicate-generation gate's running arm. |
| `verifyTitlingRecoverability.js` | Titling-failure recoverability (2026-08-25): (A) `brandScriptExecutor.stampTitlingFailureAndThrow` decides resumable-vs-terminal correctly for OOM/timeout/generic, bounded by a shared `TITLING_ATTEMPTS_MAX` ceiling (execution, real function, stubbed `Ad`). (B) the resume sweep is wired from `renderer.js` (not the RAM-inadequate `orchestrator.js` — see CLAUDE.md's titlingResumeService note), gated on `isAdgenRendererEnabled()`, `orchestrator.js` does NOT run it, and `titler.js`'s own titling call site was mirrored to the same gate (structural). (C) two REAL concurrent `resumeUntitledMasters()` passes racing the same ad — only one titles it (execution, in-memory Mongo-like stub, `scripts/lib/miniMongoStub.js`, whose `findOneAndUpdate` correctly models Mongoose's `{new:true/false}` pre/post-image semantics — an earlier version of the stub ignored `opts` and would have hidden a real sign/timing bug in the attempt-cap read-back). (D) a cap-exceeded titling failure keeps its detailed `renderError` — `processAd`'s unscoped `noteRenderIssue` no longer clobbers the stamp's message/code with a generic one. |
| `verifyTitlingResumeNeverResubmits.js` | THE MONEY CHECK: a resumed titling attempt can never re-submit a paid Atlas Omni generation. `atlasVideoService.submitGeneration` has exactly one call site, structurally inside the `else` of `if (isResuming)`; a real require-graph BFS (Node's own `require.resolve`) proves `atlasVideoService.js` is unreachable from `titlingResumeService.js`'s or `brandScriptExecutor.js`'s entire transitive require graph, with a positive control (same BFS from `renderer.js`, which DOES require it) ruling out a vacuous pass. |
| `verifyGeminiVideoProvider.js` | **THE GEMINI MONEY HARNESS.** Offline (source-extracted pures, no axios/mongoose). Pins measured request shape (`input` not `inputs`, duration `"10s"`, `background:true`, `task:reference_to_video`); never `$0` on a real charge; `classifyPoll` content-policy / no-status `error` is terminal not pending; `too_many_requests` after accept is not a free replay; Gemini never infers unbilled from missing `price`; lease is Mongo not `semaphore.js`; output URI is walked from `steps[].content[]` not inferred `output.uri`; download/mirror failures set `unsettledAtTimeout`; auth header reads `.apiKey` not the key object (the live 403). |
| `verifyGeminiReferenceAssembly.js` | Provider owns refs + prompt so a caller cannot forget. Pins `GEMINI_NO_REFERENCES` / `GEMINI_NO_PROMPT` refuse-before-submit; renderer and videoRouter gemini branches pass **no** `prompt:` / `images:` from `storyboard`; assembly throws rather than returning a short stack; `resolveUrlForIdentity` is wired to `resolveVideoReferenceForMedia`. |
| `verifyGeminiLeaseSweeperCollision.js` | A Gemini cap-miss must never `$inc` `deriveWaitAttempts` / `renderAttempts`. Execution against real `buildStrandedAdFilter` / `buildQueuedArchiveFilter`: after N lease-wait cycles + SIGTERM `rendering→queued`, stranded sweeper still matches and queued-archive does not treat a fresh `queuedAt` as mint leftover. |
| `verifyGeminiVideoLease.js` | Execution against fake Mongo occupancy + rate-event collections: stolen-slot release by the evicted holder is a no-op (B5); sequential single-slot recycle cannot defeat the rate window (B6); every Mongo error fails closed (B7). Complements the provider harness's structural lease scan. |
| `verifyGeminiVideoKey.js` | `GEMINI_VIDEO_API_KEY` empty in `defaults.env`; trim/quote-strip; fallback to `GEMINI_API_KEY` when unset/empty; no key material in logs (last-4 fingerprint only). |
| `verifyVideoReferenceResolver.js` | Cache-first URL resolver: aspect-key normalisation cannot silently miss `metadata.reframes`; tier-1 cache / tier-2 on-demand crop / tier-3 `c_fill`; source-native dims on tier 3; `preferReframe:false` skips to c_fill. |
| `verifyVideoBenefitsDirector.js` | Port of backend #386 harness. Mint stamps `Ad.videoTitleDirection`; `applyBenefitsPlacement` is wired in `renderWithRemotionAndSave` (not renderer/titler/retitle directly); include/skip/already-present; flag-off is identity. |

The runner globs every `scripts/verify*.{js,mjs}` — **101 files** as of
`fde6003`. The table above is the money / lifecycle / Gemini subset, not
the whole suite. Also in `scripts/` and **not** given a row here (do not
treat absence from this table as "not a real check"):

`verifyAdgenClaimRespectsRendererFlag.js`,
`verifyAdgenRunFeedWired.js`, `verifyAdgenRunHeartbeat.js`,
`verifyApparelSafetyHardening.js`, `verifyAttributionViability.js`,
`verifyBasePlateCrop.js`, `verifyBootRecoveryClaimAware.js`,
`verifyBootRecoveryWired.js`, `verifyBrandConsistency.js`,
`verifyBrandTaglineNoInversion.js`,
`verifyCleanupMergedBranchesSafety.js`, `verifyCloudinaryMirror.js`,
`verifyCorrectiveNoteRegen.js`, `verifyDurableCostReconcile.js`,
`verifyFaceKeepOut.js`, `verifyFaceSafeCrop.js`,
`verifyHandoffContract.js`, `verifyIconFontAndCrossSheetGenerics.js`,
`verifyKeepOutBandGeometry.mjs`, `verifyLadderWallclockBounded.js`,
`verifyLogoBufferCache.js`, `verifyLogoColorPreservation.js`,
`verifyLogoSafeBox.js`, `verifyModerationFastFail.js`,
`verifyMultiSlotStackFit.mjs`, `verifyNotChargeableRetryAlert.js`,
`verifyOperatorPromptPrecedence.js`, `verifyPmaxCtaAllIntents.js`,
`verifyPmaxDrawCtaSocialProof.js`, `verifyProofReservationGate.js`,
`verifyQcTrustsLogoGeometry.js`, `verifyQuoteColourway.js`,
`verifyQuoteScopeImplicitPairs.js`, `verifyQuoteSnippetL2Cache.js`,
`verifyQuoteSnippetProofBarGate.js`, `verifyRatingFurniture.js`,
`verifyReframeClaimShutdown.js`, `verifyReframeHoldBounded.js`,
`verifyReframeStrategy.js`, `verifyRegenCountPersisted.js`,
`verifyRegenerateConsumerClaim.js`, `verifyRegenerateInFlightGate.js`,
`verifyRegenerateLeaseExpiry.js`, `verifyRegenerateShutdownDrain.js`,
`verifyRegenerateStatusPromotionAndCascade.js`,
`verifyRemotionBrowserPrewarm.js`, `verifyRemotionChildIsolation.js`,
`verifyRemotionMemoryBudget.js`, `verifyRemotionPrebuild.js`,
`verifyRemotionTitlingPayloadIds.js`, `verifyRenderErrorTails.js`,
`verifyRenderStageTerminal.js`, `verifyRendererSlackAlerts.js`,
`verifyRendererTitlerClaimPartition.js`,
`verifyRetitleConsumerClaim.js`, `verifySharedInvariants.js`,
`verifySharpConcurrency.js`, `verifyShutdownReleaseReceiptAware.js`,
`verifySingletonLease.js`, `verifySocialProofGoalFraming.js`,
`verifyStageTiming.js`, `verifyStaticCtaDeterminism.js`,
`verifyStaticIntentChanges.js`, `verifyStaticReceiptResume.js`,
`verifyTimeoutCoherence.js`, `verifyTitleGroupsNeverOverlap.js`,
`verifyTitlerBackpressure.js`, `verifyTitlerClaimReclaim.js`,
`verifyTitlerHandoff.js`, `verifyTitlingDualClaim.js`,
`verifyTitlingHeartbeat.js`, `verifyUnsettledTimeoutBounded.js`,
`verifyVendorDrift.js`, `verifyVideoMasterCloudinaryPublicId.js`,
`verifyVideoQcVerdictSurvives.js`, `verifyVideoReferencePath.js`,
`verifyVideoResumeFromReceipt.js`,
`verifyVisionQcPersistedVerdictInvariant.js`.

---

## Concurrency knobs

Two layers:

1. **Adgen-native** (how many ads this Node process claims at once) —
   `src/config.js` + `render.yaml`.
2. **Vendored backend table** — `src/services/concurrency.js` `SPEC`,
   values from `config/defaults.env`. Callers import the frozen
   `concurrency` object. File default and `SPEC.default` must move
   together.

### This process

| Knob | Where | Default | What it bounds |
|---|---|---|---|
| `ADGEN_MAX_INFLIGHT` | `src/config.js:110`, `render.yaml` renderer env `32` | 32 | Burst-claim ceiling per renderer instance (`poll` while `inFlight < MAX_INFLIGHT`). I/O-bound statics+video polls. |
| `ADGEN_POLL_MS` | `src/config.js:120` | 500 | Claim poll interval (ms). |
| `ADGEN_RENDERER_ENABLED` | `src/config.js:64-66`, `config/defaults.env` | `true` in file | Sleep vs claim. |
| `VIDEO_PROVIDER` | `config/defaults.env:394`; **not** in `render.yaml`; **overridden to `gemini` on live `adgen-renderer`'s Render dashboard** (verified 2026-09-04) | File/code default `atlas`; **live value is `gemini`** | Atlas vs Gemini vs Vertex. See Direct-Gemini section — production is on Gemini today. |
| `DERIVE_MASTER_WAIT_MS` | `renderer.js:166` | 60000 | How long a derive holds a slot waiting for the sibling master. Comment at `:718` still says 12 min — stale; the constant is 60s. |
| `DERIVE_MASTER_POLL_MS` | `renderer.js:167` | 5000 | Poll interval inside that wait. |
| `MAX_DERIVE_WAIT_ATTEMPTS` | `renderer.js:168` | 60 | Requeue ceiling (~60 min). |
| `GEMINI_VIDEO_MAX_SLOTS` | `geminiVideoLease.js:75-78` (not in `concurrency.js` / `defaults.env`) | 8 | Global Gemini occupancy + rate cap. Mongo lease, not in-process. |

Remotion RAM, not `MAX_INFLIGHT`, is the binding constraint
(`src/config.js:54-57`). `REMOTION_QUEUE_CONCURRENCY` self-limits the
Chrome+ffmpeg slots.

### Vendored table (`config/defaults.env` + `src/services/concurrency.js`)

Read these; do not edit `config/defaults.env` from a docs pass.

| Knob | File default | Ceiling | Notes |
|---|---|---|---|
| `RENDER_CONCURRENCY` | 24 | SELF | Wave size for in-flight **static** Atlas submits. Unpaced. Unmeasured above 8. |
| `VEO_CONCURRENCY` | 24 | SELF | Video **submit+poll** wave. Not Remotion. |
| `VEO_TITLING_CONCURRENCY` | 48 | SELF | Cheap titling **prep** (Mongo/disk), not the Chrome render. |
| `REMOTION_QUEUE_CONCURRENCY` | **2** | SELF | **The memory guard.** Simultaneous Remotion renders in **this** process (`renderer.js:582-586`). **Measured ~1.97 GiB/slot on adgen 2026-08-24** — see below. Do not use the older ~0.9 figure. |
| `MAX_CREATIVES_PER_RUN` | 1000 | SELF | Sanity ceiling, not a product cap. |
| `ATLAS_SUBMIT_SPACING_MS` | 1200 | SELF | Video same-model submit spacing. Images unpaced. |
| `GROK_MAX_RPS` | 1 | **PROVIDER** | Env may lower, cannot raise above 1. |
| `WORKER_CONCURRENCY` | 8 | SELF | Backend worker DetectRun pool. Meaningless in this process (no `worker.js`). |

`concurrency.js:20-21` notes Atlas generation POSTs are billable.
`logConcurrencyConfig()` prints the resolved table at first require.

### Instance size (Remotion)

Committed `render.yaml` now correctly says `plan: pro_plus`. Was
`standard_plus` until a later 2026-08-24 push, when a blueprint sync
attempt rejected that plan name for worker services (Render's plan
naming shifted mid-year; the live `adgen-renderer` service was already
running `pro_plus` via a manual dashboard upgrade). Both the renderer
and the new titler now match — no drift between the file and reality.

**That upgrade was necessary but NOT sufficient.** The first real video run on
this service (`run_1787564306902_d3c1ca4a`, 1 paid Omni master + 11 free
derives) OOM-killed **two** instances at concurrency 4:

```
09:44   0.10 GiB   idle
09:45   5.22 GiB
09:46   6.78 GiB
09:47   7.97 GiB   <- 99.6% of the 8 GiB limit
09:48   server_failed {"oomKilled": {"memoryLimit": "8Gi"}}    instance -whg4h
09:48   server_failed {"nonZeroExit": 137}  (SIGKILL)          instance -fllr9
```

**The ~0.9 GiB/slot constant that had been carried in `defaults.env` since
2026-08-21 is wrong by ~2.2x.** It was computed as `(7.57-0.33)/8`, which
assumes all 8 permits were rendering at the instant of peak; they were not, so
the divisor was too large. With all 4 slots demonstrably busy the real figure
is `(7.97-0.09)/4 = ~1.97 GiB/slot`, so 4 slots need ~8 GiB and never fit an
8 GiB box. 4 was marginal all along — nobody had run it here to find out,
because until PR #2 the video path died upstream at import.

Budget against **1.97 GiB/slot**: 1 → ~2.1 GiB (26%), **2 → ~4.0 GiB (50%)**,
3 → ~6.0 GiB (75%), 4 → ~8.0 GiB (OOM). Set to 2 (PR #5), which also stays
under the 60% autoscale trigger.

Autoscale does not rescue a single process whose RSS is over the cap —
during the 2026-08-21 incident it scaled 2 → 3 → 4 instances and made
things worse, because each new instance runs its **own** slots into the
same per-instance ceiling. Instance SIZE or `REMOTION_QUEUE_CONCURRENCY`
are the only real levers.

**Committed autoscale as of `401e54f` / `fde6003` is not max 8.**
`render.yaml` pins renderer **min 2 / max 4** and titler **min 4 / max 12**.
A missing `scaling:` stanza on blueprint sync **disables** dashboard
autoscale (measured 2026-09-03, PR #109). See Autoscale section above.

---

## Local run

```
cp .env.example .env   # MONGODB_URI — staging, never prod
npm install
ADGEN_ROLE=api npm start                 # :3100/health
ADGEN_ROLE=orchestrator npm start        # read-only poll
ADGEN_RENDERER_ENABLED=true ADGEN_ROLE=renderer npm start
npm test                                 # 106 scripts; run from adgen/, never via parent NODE_PATH
```

`.env.example` does not list `ADGEN_RENDERER_ENABLED`; without it the
renderer sleeps.

### Do not create a git worktree INSIDE this repo directory

**This keeps recurring.** A cleanup pass on 2026-08-24 whose entire purpose
was removing nested worktrees found a NEW one appear *during* the cleanup
itself: `liquidretail_adgen/.worktrees/pr34-measure`. The three-line version
of this warning that used to live here evidently was not enough to stop it —
hence the longer version below.

**Rule: worktrees go as SIBLINGS of the monorepo**
(`/Volumes/Sayulita/Projects/RS/.wt-<name>`), **never nested under
`adgen/` or the backend checkout** — not `.worktrees/`, not `.claude/worktrees/`, not
anywhere inside the repo tree. `.gitignore` does **not** protect against
this: the hazard below is raw filesystem walks, not git status, so an
ignored directory gets scanned exactly like a tracked one.

**Why, concretely — audited 2026-08-24.** `scripts/` has exactly **8** call
sites that do their own `fs.readdirSync`, directly or via one of three
shared walk helpers: `scripts/lib/requireGraph.js` (backs
`verifyRequireGraph.js`), `scripts/lib/sourceWalk.js` (backs
`verifyArchiveDigestRelease.js`), `scripts/lib/vendorDrift.js` (backs
`verifyVendorDrift.js`), `scripts/runVerifySuite.js` itself, and four
harnesses that walk directly: `verifyAdgenRunHeartbeat.js`,
`verifyCampaignRunHeartbeatWired.js`, `verifyModelParity.js`,
`verifyRunFinalizesOnSettle.js`.

Unlike `liquidretail_backend` (4 of 22 safe, 18 exposed — see that repo's
`CLAUDE.md`), **all 8 of adgen's are currently safe**: the four direct
harnesses skip any entry whose name starts with `.` before recursing
(`entry.name.startsWith('.')`), and the two tree-walking lib helpers
(`requireGraph.js`, `vendorDrift.js`) do the same. `sourceWalk.js` goes
further — it special-cases `.worktrees` by name AND pattern-matches any
`.wt-*` prefix (`shouldSkipDir`, `scripts/lib/sourceWalk.js:65-69`), and
detects a linked worktree by its `.git` FILE (not directory) rather than
trusting a name list at all. `runVerifySuite.js`'s own `readdirSync` only
lists `scripts/` itself, never the repo root, so it isn't exposed to this
hazard regardless.

**This is not a green light — do not read it as one.** It takes exactly one
future harness copied from a fixed-name-list pattern (the way backend's 18
were written) to reintroduce the hazard, and no non-verify tooling here has
been audited at all. The rule — worktrees are always siblings, never nested
— is unconditional; it does not get softer because today's 8 harnesses
happen to be careful. This is the same defect class that already turned
`liquidretail_backend`'s `verifyArchiveDigestRelease` (a MONEY harness) red
with 7 false positives there, and the silent failure mode is worse: a
harness that passes or fails depending on what another session has checked
out, with no red flag at all.

### Two more tooling traps that have cost real time

**Never `npm ci` at the monorepo root then run adgen, and never set
`NODE_PATH` to the parent.** Adgen `src/db.js` fails closed unless mongoose
major is 8. `npm ci` **inside** `adgen/` is required. Pointing `NODE_PATH`
at the parent's mongoose 7 is the silent-shadow bug the boot assert exists
to catch.

The older `verifyModelParity.js` loader (`loadMongooseWithFallback`) still
exists for leftover bare-worktree / split-repo checkouts — do not "fix" it
by setting `NODE_PATH` at the parent. Backend worktrees still need
`npm run setup:worktree` (incomplete committed `node_modules`). Don't
carry either package's install rule over to the other.

**Parallel agents running mutation-style revert-proves in the same repo
interfere with each other's suite runs.** Observed twice in one night as a
transient `verifyRequireGraph` failure caused by another process's temp
file — not a real defect. A clean re-run fixed it both times. Re-run before
reporting a lone red, especially on a harness whose own revert-prove recipe
mutates a file on disk while another session could be doing the same thing
concurrently.

---

## Stranded-work tooling (2026-08-31)

Built after three real incidents in one night across this repo and
`liquidretail_backend`: a branch sat **5 days** with 9 commits never pushed to
any remote, inside a nested worktree locked by a dead PID (nearly lost a live
production bug fix); a running agent accumulated ~52KB across 6 files with
**zero commits**, then ended its turn waiting on a background review that
could never wake it; a nested worktree sat inside this repo directory
violating the documented rule two sections up. Plus, unrelated but
discovered while auditing: dozens of `.wt-*` sibling worktrees for branches
already merged, and several `prunable` worktrees under `/private/tmp`
nobody had cleaned up.

**`scripts/auditStrandedWork.js`** (read-only) reports, for the repo it runs
in: local branches with commits on **no** remote (the 5-day case); any
worktree — including the main checkout — with uncommitted/untracked changes
(the 52KB case); any worktree nested inside this repo directory (the
documented-rule violation); worktrees git itself reports prunable; and
branches already merged into trunk (by literal ancestry OR detected
squash-equivalence — this repo's PR history is almost entirely GitHub squash
merges, see the commit-message evidence right below the codemap warning at
the top of this file, so a plain `git merge-base --is-ancestor` check alone
would find almost nothing) whose branch or worktree still lingers. Exit code
1 iff anything in the first three (genuinely at-risk) categories was found;
0 for the last two (mere tidiness) — so it can gate something later without
crying wolf over ordinary end-of-session dirty state.

`npm run check:stranded-work` runs it. `--json` for machine consumption,
`--fast` to skip the full-branch-list merged-lingering scan (much faster on
a repo with 100+ local branches, at the cost of under-reporting cleanup
fodder — categories 1-3 are unaffected), `--repo=<path>` for another
checkout.

**`scripts/cleanupMergedBranches.js`** is the companion that actually
deletes — **dry-run by default**, `--apply` required to write anything. It
independently re-verifies, at the moment of deletion, that a candidate
branch: is not trunk; is not checked out in ANY worktree (main or linked);
has zero commits unreachable from any remote (re-checked here, not read from
a stale audit report); has a clean worktree if one exists; is not behind a
LOCKED worktree (reported, never auto-unlocked). Anything ambiguous is
skipped and reported, never guessed through. `npm run cleanup:merged-branches`
(add `-- --apply` to actually delete). Proven against a scratch fixture repo
with a real bare "origin" (not just assertions): a branch with commits
pushed nowhere was refused, a branch with a dirty worktree was refused
(both the "checked out anywhere" gate AND, unit-tested in isolation, the
dirty-worktree check itself), trunk was refused, and a genuinely
squash-merged-and-clean branch was deleted (local branch + its remote
counterpart) while the other three were left byte-for-byte untouched.

**Why `git branch -D` (force) for the squash case, not `-d`:** git's own
`-d` only trusts literal ancestry — it refuses a squash-merged branch as
"not fully merged" even though its content is safely in trunk under a
different commit SHA, which is exactly why this tool exists instead of a
bare `git branch --merged` loop. `-D` is used only after independently
verifying squash-equivalence (a patch-id comparison against trunk's history
— the same mechanism behind the well-known "git-delete-squashed" script,
with one correction found by testing against this repo's real history: the
synthetic probe commit must be parented at the branch/trunk **merge-base**,
not trunk's current tip, or a trunk that has moved on even one commit since
the merge makes every squash-merged branch look unmerged) AND confirming
zero unpushed commits AND a clean-or-absent worktree AND not checked out
anywhere.

**Adversarial review (Grok grok-4.6, `--effort high`, 2026-08-31) found real
bugs here, since fixed.** Worth recording because they were genuinely
subtle: (1) the remote delete had no lease, so a same-named `origin/<branch>`
that moved (someone pushed new commits) between our fetch and the delete
could have those commits destroyed alongside the branch — fixed with
`--force-with-lease` on an SHA observed as late as possible; (2) remote
delete used to run even when the local `-D` failed — now gated so a failed
local delete never reaches the remote step; (3) the squash-equivalence check
above (patch-id via `git cherry`) matches against ANY point in trunk's
history, including a commit trunk has since reverted or superseded —
demonstrated concretely (a branch bumps a setting, gets squash-merged, trunk
later independently changes the same setting again — the patch-id check
alone still said "merged"). Fixed with a second gate requiring the branch's
added lines to still be found in trunk's CURRENT file content (a ratio
threshold, not literal 100% — a stricter whole-file-identity version was
tried first and broke on this repo's own auto-regenerated
`scripts/vendor-manifest.json`, whose timestamps/hashes legitimately churn
on every unrelated reconciliation). All ten of these properties, plus the
original refusal-path proofs, are now pinned by
`scripts/verifyCleanupMergedBranchesSafety.js` against a real disposable
fixture repo — added to `npm test`, not just asserted in a PR description.

**Duplication, deliberate:** `scripts/lib/gitAudit.js` plus these two callers
are hand-synced, byte-identical, with the backend copies at repo-root
`scripts/` — NOT routed through `scripts/vendor-manifest.json`/`verifyVendorDrift.js`. That
system hashes backend↔adgen **production** modules under `models/`/`services/`
with a debt-tracking grace period (`UNPORTED_GRACE_DAYS_DEFAULT`) built for
code that writes the shared Mongo collections; a git-ops utility with zero
Mongo/business-logic coupling doesn't fit that shape, and forcing it through
a system built around "these two sides may legitimately drift for up to N
days" would be actively misleading for a file that has no reason to ever
drift. Diff the three files against the parent `scripts/` before editing either
copy.

**Backend also has `scripts/findOrphanedBranches.js` / `findStaleUncommittedWork.js`
(gh-CLI/GitHub-PR-aware) — complementary, not superseded.** Those answer "does
a PR exist for this branch name"; this pair answers "does this branch/worktree
exist safely anywhere outside this one disk," entirely offline, and (unlike
the backend-only originals) the same way in both repos. adgen has no
GitHub-PR-aware equivalent and isn't getting one here — `gh` cross-referencing
stays a backend-only tool as of this writing.

**Wired into the habit via a committed SessionEnd hook**, not left as a
script nobody runs. In the monorepo Claude Code only loads `.claude/` at
the **repo root**; `adgen/.claude/` is inert. The live wrapper is
`.claude/hooks/session-end-audit.sh` (one git-repo-wide
`auditStrandedWork.js --hook` run covers `adgen/` too). That wrapper
always exits 0 and prints exactly one `{"systemMessage": "..."}` line.
`adgen/.claude/` is kept on disk so a checkout that still opens `adgen/`
as its own Claude project does not lose the wrapper; do not add a second
audit invocation there.

---

## Reframe claim: poll budget and lease floor are INDEPENDENT (2026-08-27)

`reframeReferenceForAspect` called `pollPrediction(id)` with **no options**, so the
reframe outpaint (`nano-banana-2/edit`) inherited `MAX_POLL_MS` — the *video*
ceiling — by omission. It now passes its own **`REFRAME_POLL_MS`** (300000; measured
reframe latency n=60: p50 48.5s, max 232s, zero of 126 billed reframes timed out in
7 days, so the inherited 900s was 3.9× the observed max).

**Do NOT re-derive `REFRAME_CLAIM_TTL_FLOOR_MS` from any poll ceiling.** That
arithmetic link (`MAX_POLL_MS + 10 min`) *was* the defect: the claim is a field on
the **shared** `Media` doc that `liquidretail_backend` also steals from with its own
copy of the formula, so #82 raising `ATLAS_TIMEOUT_MS` here and not there put the
two sides 5 minutes apart on when a holder is dead (25 min here, 20 there). Its
"+10 min" was also already spent — 602.5s of bounded non-poll work meant **−2.5s**
of real margin. The floor is now a flat 20 min in both trees; this prefix's value
dropped 25→20, which costs nothing because backend always stole at 20 anyway.
Poll budget is a latency choice; the floor is a money guard. The **upper** clamp on
`REFRAME_POLL_MS` is lease-derived, not `MAX_POLL_MS` — that direction is fine
(money guard bounds latency knob), and a sweep found the reverse permits a
1364.5s hold against a 1200s lease.

Cross-tree enforcement is `scripts/shared-invariants.json` (read from the
parent); per-package, `scripts/verifyReframeHoldBounded.js` (27 checks,
revert-proven). Full write-up: `session.d/2026-08-27_reframe-hold-bounded.md`.

## What this repo does not do (yet)

- Expansion / Director / Judge / Ad mint — still backend. (The vendored
  `campaignAdsGenerationService` **does** stamp `Ad.videoTitleDirection`
  at mint in this tree, and live titling **does** apply it — but the
  production mint still runs on the backend process.)
- Orchestrator work (the container boots; it does not expand).
- HTTP generate, auth, catalog, publish.
- `GET /health` is the entire public HTTP surface.
- ~~Direct-Gemini is not the routed default~~ — **it is, as of 2026-09-04.**
  `VIDEO_PROVIDER=atlas` is still the repo/code default
  (`config/defaults.env:394`), but production `adgen-renderer` carries
  a Render-dashboard override to `gemini`, confirmed via a direct query
  of the live service's env vars (see the Direct-Gemini section above
  for the exact method — re-query before trusting this if it's been a
  while, since a dashboard flip leaves no commit trail). Rollback, if
  ever needed, is flipping that one dashboard var back to `atlas` (or
  deleting it) — no code change required either direction.
- ~~`startRunHeartbeat` is vendored and **unwired**~~ — **WIRED as of 2026-08-24.**
  It is now called from `renderer.js` (4 sites) and
  `scripts/verifyCampaignRunHeartbeatWired.js` passes. Left visible rather
  than deleted so the next reader can tell this was fixed, not overlooked.
- ~~`titlingResumeService` / `bootRecoveryService` are vendored but neither
  is started~~ — **`titlingResumeService.resumeUntitledMasters()` is WIRED
  as of the video-titling-recoverability PR (2026-08-25)**, started from
  `renderer.js` (`pro_plus`, 8 GB), on a 90s-delay/5-min interval modeled on
  backend's own wiring (since deleted — see the "RESOLVED — SUPERSEDED" note
  below), gated on `isAdgenRendererEnabled()` so it could not
  race backend's own render/resume path over the shared collection when
  the flag was off. **NOT run from `orchestrator.js`** — that was the first
  draft, on the reasoning that it's the one adgen role Render keeps
  singleton, but adversarial review (Grok, xhigh) caught that
  `orchestrator`'s Render plan is `starter` (~512 MB) while
  `resumeUntitledMasters()` calls Remotion for real (~1.97 GiB/slot,
  measured) — the first ad it actually retitled would have OOM-killed the
  singleton. `renderer.js` already budgets that RAM and is safe to
  autoscale here because titlingResumeService's own atomic per-document
  claim (not "only one process runs this") is what prevents two instances
  double-titling the same ad — proven with two REAL concurrent
  `resumeUntitledMasters()` calls in
  `scripts/verifyTitlingRecoverability.js` section C. Paired with a
  widened `brandScriptExecutor.js` failure stamp
  (`stampTitlingFailureAndThrow`, exported) that marks OOM, timeout, AND a
  generic child failure resumable (not just OOM), bounded by a shared
  `Ad.titlingAttempts` ceiling (`TITLING_ATTEMPTS_MAX`, default 3) so a
  deterministic bug cannot retry forever on a paid path, mirrored into
  `titler.js`'s own titling call site (same duplication rule as
  `startRunHeartbeat`/`bumpRunCounter` above). See
  `scripts/verifyTitlingRecoverability.js` and
  `scripts/verifyTitlingResumeNeverResubmits.js`.
  **RESOLVED — SUPERSEDED, not by the gate this bullet asked for
  (2026-09-03).** This used to flag a real cross-repo race:
  `liquidretail_backend`'s own `titlingResumeService` ran on its web
  process ungated on `ADGEN_RENDERER_ENABLED`, with no
  `stampTitlingFailureAndThrow`/`titlingResumable` concept, so a claim race
  it won could terminal-fail a resumable ad on the first retry. The
  follow-up flagged here never landed as a narrower gate — instead
  `liquidretail_backend` PR #360 (`abf7e0c2`, 2026-08-28, "remove(titling):
  delete backend's in-process titling function (MONEY)") deleted
  `services/titlingResumeService.js` and its `index.js` wiring entirely.
  Backend no longer titles video in-process at all, so the race described
  here cannot occur — there is nothing left on that side to race against.
  This repo's `src/services/titlingResumeService.js` is now the sole
  titling-resume path, unconditionally. Full removal is a strictly stronger
  fix than the gate this bullet was asking for; do not re-open this as
  outstanding work.
  **`bootRecoveryService` is WIRED as of 2026-08-26** — closes the
  273-minute-tail defect measured on run_1787699482964, where a stuck
  master claim (`renderer-7364c5b1` died holding cb7a91) blocked
  `maybeFinalizeRun` for 4.5 hours until backend eventually got to it.
  Wired from `renderer.js` (`startBootRecoverySweep`) with the same
  90s-delay/5-min-interval pattern as `titlingResumeService`, gated on
  `isAdgenRendererEnabled()` so it stands down when the backend owns
  the collection. Money-safe by construction (only touches
  `status:'rendering'` + spend receipt + stale updatedAt; peeks with a
  free GET; never re-submits — its own header pins that). Redundant
  across autoscaled instances is fine (no claim, guarded writes).
  Pinned by `scripts/verifyBootRecoveryWired.js` (23 checks).

---

## RPD findings salvaged from the retired A/B harness (backend PRs #210 / #212)

Backend built an "RPD harness" (`scripts/rpd/`, branch
`origin/claude/rpd-harness-v2`) for A/B testing video-model and prompt
variants. It targets a version of the prompt/QC system adgen has since
superseded independently, so the harness code itself is dead and was
retired without landing — PRs **#210 and #212 closed on
`liquidretail_backend` 2026-08-24, branches NOT deleted**, so the code is
recoverable if anyone wants it later. This section is the actual substance
worth keeping — about half a page of prose out of `scripts/rpd/LEARNINGS.md`
and `.claude/skills/rpd-experiments/references/prompt-elements.md` on that
branch — landed here because a future adgen session is far more likely to
open this file than to go dig up a closed PR on a different repo.

**Evidence-strength discipline, read before trusting any of this:** items 1,
2, and 4 below are each **a single measured comparison (n=1/arm), run
2026-08-18**, not a validated policy — the harness's own convention was to
record null results as null results, and that honesty is preserved
deliberately here. Two are directional wins, one is an explicit null. Item 3
is not an RPD experiment at all — it's an external benchmark cited as
context. Do not read any of this as settled fact from two data points.

1. **[n=1, 2026-08-18, directional signal, NOT applied] Low camera motion
   favours product fidelity.** The recommendation from the harness's prompt
   lever notes: slow push-in, subtle parallax, static product with the
   camera as the only thing moving. **Caution for whoever picks this up:**
   adgen's current `OMNI_DIRECTIVES.cameraStyle`
   (`src/services/veoPromptBuilder.js:287-289`) already *forbids* parallax
   outright — "No shake, handheld, parallax, simulated 3D, orbit, or object
   movement. The product stays completely static." So this is a candidate
   lever for a **future** experiment, not something already implemented;
   don't assume the two agree just because both say "low motion."

2. **[n=1, 2026-08-18, measured win — still live and actionable, verified
   present 2026-08-24] The crossfade/dissolve contradiction is deliberate;
   a narrower one-line patch measurably fixed a real defect.** Two things
   are both true and must not be conflated:
   - The contradiction itself is **intentional, owner-confirmed policy**:
     `transitions` permits "Smooth crossfades only, ~0.25s" while `doNot`
     bans "dissolves" outright, and a crossfade *is* a short dissolve.
     PR #61 "cleaned up" this exact inconsistency in the video prompt and
     was rolled back in full — the owner said the contradictory version
     produced better output. adgen's `veoPromptBuilder.js` carries this
     verbatim, with its own "DO NOT FIX" comment
     (`src/services/veoPromptBuilder.js:314-320`, `transitions` at line
     286, the `doNot` dissolves clause at line 327). **Confirmed still
     present on the grafted tree as of this writing** — this is not a
     historical note, the identical contradiction is live in production
     today.
   - Separately, the harness ran a **measured A/B** (`rpd-validation-crossfade-ab`,
     $0.90 settled, 2 × $0.45 Omni dev 4s 1080p) that found the baseline
     (the contradictory pair above) produces mid-crossfade **ghosting** at
     ~1.2s and ~2.5s in every sampled frame, and a **narrower one-line
     patch** — "hard cuts only" — removed the ghosting in every sampled
     frame with no other prompt change.
   - These do not contradict each other: the owner's rollback precedent is
     about the *general* transitions/doNot pair reading as internally
     inconsistent; the ghosting fix is a *specific, measured* defect in the
     current text with a *specific, measured, one-line* patch. n=1, so
     treat "hard cuts only" as a promising next experiment to re-run and
     confirm, not as a change to make unilaterally against explicit
     "DO NOT FIX" code comments and rollback history.

3. **[external benchmark, July 2026, not an RPD experiment] Product
   fidelity has a ceiling that prompt wording cannot fix.** An independent
   benchmark found even leading image models preserve *complete* product
   detail in only **~29%** of generations — in line with adgen's own
   observed ~1-in-3 competitor-mark defect rate. The harness's conclusion:
   a fidelity complaint is usually not solved by more forceful prompt
   wording. The real fix is **measure-and-reject** — adgen's own
   `src/services/adVisionQcService.js`, gated by `SystemConfig` (see
   `queuedArchiveSweeper.js` / `renderer.js` call sites) — not another
   round of `productPreservation` / `PRODUCT_FIDELITY` prose.

4. **[n=1/arm × 4 cells, 2026-08-18, MEASURED NULL RESULT] Rewriting the
   static `PRODUCT_FIDELITY` block did not beat the canonical block.**
   `static-fidelity-block-ab`, $0.2168 settled across 4 cells. A short
   product-specific rewrite of the whole `PRODUCT_FIDELITY` block was
   compared against the canonical block; neither measurably beat the other
   — both arms preserved the printed logo lockup and its text and invented
   nothing (corroborated by both a human read and the production
   gemini-2.5-pro auto-eval judge, 10/10 on both axes for all four cells).
   **Takeaway the harness recorded: prefer testing a different model over
   rewriting this block again** — this exact rewrite has already been
   tried and measured not to help.

**Measured prices worth keeping (concrete, from the same two runs above):**
- Image edit: `gpt-image-2/edit` settled **$0.072272**, `-developer/edit`
  settled **$0.036136** — the developer variant really is ~half the
  standard price, not an approximation.
- Video: 4s Omni dev 1080p settled **$0.45** vs the pricing table's formula
  estimate of $0.60 (~25% over-estimate, same direction previously observed
  at 10s).
- **Atlas publishes `executionTime=0` on that video model** — it is not a
  usable latency signal. Use `queueToTerminalMs` instead if timing this
  path.
