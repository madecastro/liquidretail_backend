# CLAUDE.md — liquidretail_adgen

Ad-generation **renderer** microservice for Reach Social. Forked from
`liquidretail_backend`. Deploys to Render as three services from one Docker
image (`Dockerfile`, `render.yaml`). Shares the **same MongoDB** as the
backend. Trunk is `master`.

**Citations in this file are against `origin/master` @ `881dabd` (2026-08-24,
PR #4), not a detached local checkout.** If a line number does not match the
tree you have open, `git fetch && git log -1 --oneline origin/master` first.

**Read `session.md` for live branch/PR state.** This file is architecture, not
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
- Adgen `src/config.js:37-39` and `src/services/renderer.js:652-655`: when
  the flag is **not** `'true'`, the renderer poll loop sleeps (does not
  claim). When it **is** `'true'`, this process atomically claims ads and
  does the Atlas / Remotion / Cloudinary work.

Committed default in `config/defaults.env` is `ADGEN_RENDERER_ENABLED=false`
(file comment: flip only when the service is deployed). Production sets the
dashboard override to `true`. A boot without that override will not steal
work from the backend's in-process `runRenderLoop`.

There is **no** `ADGEN_SERVICE_ENABLED` / `ADGEN_ORCHESTRATOR_ENABLED` in
this tree. Those names appear only in the stale Phase 0 README; do not
invent them.

---

## How the four repos relate

| Repo | Role |
|---|---|
| `liquidretail` | React SPA. Trunk **`master`**. Netlify `staging.reach-social.io`. Talks to the **backend** HTTP API only. |
| `liquidretail_backend` | Express + Mongo. Trunk **`main`**. Render `liquidretail-backend.onrender.com`. Auth, catalog, wizard `/api/ads/generate`, expansion, mint, claim. When the flag is on, it **stops** at claim. |
| `liquidretail_adgen` | **This repo.** Render workers actually generate static plates and video masters/derives. |
| `rs-ai-backend` | Older/parallel backend fork. **Reference only** — not the live API, not the live renderer. |

All four sit as siblings under `/Volumes/Sayulita/Projects/RS/`.

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
| `renderer` | `adgen-renderer` (worker, autoscale) | The live path. `renderer.run()` → `poll()` burst-claims up to `ADGEN_MAX_INFLIGHT` ads and fires `processAd` as unawaited promises. |
| `titler` | `adgen-titler` (worker, autoscale, PHASE 3) | Out-of-process Remotion titling — polls for `{status:'rendering', veoVideoUrl:{$ne:null}, titlingNeeded:true, claimedByWorker:null}` when `ADGEN_TITLER_ENABLED=true`. Ships dark by default. |

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
Both paths coexist; the flag chooses. `config/defaults.env` ships `false`.

**Duplication.** `titler.js` duplicates several helpers from `renderer.js`
(`startAdHeartbeat`, `bumpRunCounter`, `maybeFinalizeRun`,
`settleNonDraftTerminal`, `notifyRunFinalized`, the per-run heartbeat
plumbing). Phase 4 consolidates these when the renderer's copies vanish
with the code that uses them. If you edit one copy, edit the other.

Pinned by `scripts/verifyTitlerHandoff.js` (44 checks, revert-proven on
10 targeted mutations covering both sides + config + render.yaml).

---

## Render lifecycle (`src/services/renderer.js`)

Dispatch (`processAd`, `:618-624`):

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

Money-critical: this is the **only** path that may call
`atlasVideo.generateForAd`.

1. `prepareStoryboard` via a **local alias**
   (`:94-99`, call at `:548`).
   `src/services/videoRouter.js:75` exports `prepareStoryboard`.
   Backend `routes/ads.js:81` binds it as
   `prepareStoryboard: veoPrepareStoryboard`. Phase 1c copied the **call**
   but destructured the alias name; that was `undefined` and **every
   first-time video master** threw `veoPrepareStoryboard is not a function`.
   Fixed on `origin/master` by aliasing explicitly:
   `const { prepareStoryboard: veoPrepareStoryboard } = require('./videoRouter')`.
2. `atlasVideo.generateForAd` (`:553`) — billable Omni submit+poll. Stamps
   `veoPredictionId` before polling.
3. Persist master + `titlingResumeState:'claimed'` in one write (`:560-580`).
4. **Remotion titling in-process** (`:582-586`):
   `renderBrandScriptAndSave({ ad, brand })`. This is the RAM-bound step.
5. Terminal stamp: `status:'draft'`, clear `titlingResumeState` and claim
   (`:592-603`). `bumpRunCounter(..., 'succeeded')`.

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

This repo copies backend modules under `src/`. As of `881dabd` there are
**134** top-level `src/services/*.js` files (plus `brandScripts/`,
`brandStyles/`, `reviewAdapters/`) and **33** Mongoose models under
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

| | `liquidretail_backend` | `liquidretail_adgen` |
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
(`src/services/layoutInputService.js` = `'4.2'` on `origin/master`,
same as `liquidretail_backend/services/layoutInputService.js:211`). A
mismatch split-brains the `layoutinputartifacts` cache: one service
rebuilds, the other treats the row as fresh.

---

## Verify harness

On `origin/master` (not on a checkout parked at `81e3ae0`):

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

Two files are named `*_KNOWN_OPEN.js`. Their headers say they are
**expected to fail** until the defect is wired. Do not "fix" them by
relaxing assertions.

Sibling backend location for cross-repo checks:
`ADGEN_BACKEND_PATH` or `../liquidretail_backend`
(`scripts/lib/siblingBackend.js`). Missing sibling = INFO skip, not fail.

| Script | What it actually asserts |
|---|---|
| `verifyRequireGraph.js` | Every static `require('./…')` / `require('../…')` under `src/` resolves to a real file. Reports vendored-but-unreferenced files as INFO. Would have caught the deleted `reviewAdapters/helpers` production crash. |
| `verifyModelParity.js` | For every model that exists in both trees, adgen top-level schema paths ⊆ backend paths. Backend-only fields are INFO. Needs `mongoose` (falls back to the sibling backend's `node_modules`). |
| `verifyRendererAtomicClaim.js` | `claimOne` filter requires `claimedByWorker:null`; two concurrent claims cannot both win (offline stub driven by the **real** filter text); claim is released on failure and derive-requeue; every terminal write clears `claimedByWorker`. |
| `verifyRendererVideoMoneyInvariants.js` | Structural: the single `atlasVideo.generateForAd` call is unreachable from the `if (deriveFromFmt)` block (every path throws or returns); a failed sibling master throws rather than submitting. |
| `verifyRendererAdStatusEnum.js` | Every `status:` value renderer **writes** is in `models/Ad.js`'s enum `queued/rendering/draft/live/archived/failed` and is a case `campaignRunGuards.classifyRunAdOutcome` recognises. Pins that renderer only writes `draft` / `failed` / `rendering`. |
| `verifyImagePricing.js` | `atlasImageService.buildPriceMap` reads `price.actual.base_price` (not the non-existent `pricing` key that led every image CostLog at $0). |
| `verifySubmitGuard.js` | `submitRetryDecision` / `isDefinite429`: replay an Atlas generation POST only when the error **proves** the request was rejected before work began. Ambiguous → do not replay. |
| `verifyVideoCostReconcile.js` | Video CostLog settlement: parse settled Atlas price, `finalizeFlatCost` on a real price, schedule fallback if missing, never write 0 from garbage, fire-and-forget on the render path. |
| `verifyArchiveDigestRelease.js` | Pure exported archive/requeue pipeline helpers (groups A–D). Group E (backend caller scan) is mostly skipped — adgen has no `routes/ads.js` / `worker.js`. |
| `verifyPmaxVideoExpansion.js` | PMax video minting money rules against vendored `campaignAdsGenerationService` / `platformFormats`; derive branch extracted from `renderer.js` instead of backend `routes/ads.js`. |
| `verifySharedPortraitMaster.js` | Mixed Meta+PMax shares one 9:16 master (one billable portrait plate). |
| `verifyQuoteProvenanceStamp.js` | `stampQuoteOrigins` reads `container.quotesOrigin`; flag-off baseline is an embedded snapshot of backend commit `3e4561e2` (that SHA is not in this repo's history). |
| `verifyRunFinalizesOnSettle_KNOWN_OPEN.js` | Originally: CampaignRun never reaches `done` because `bumpRunCounter` only `$inc`s. **On `origin/master`, `bumpRunCounter` now also calls `maybeFinalizeRun` (`renderer.js:160, 202-227`).** This harness still extracts **only** the `$inc` update and still labels itself expected-fail. Treat its Group A as a description of the **old** defect; Group C2 (call-site scan for `classifyRunAdOutcome`) should now see `renderer.js`. Current pass/fail: **unverified** (not re-run in this docs pass). |
| `verifyCampaignRunHeartbeatWired.js` | **Now passing — this was fixed on 2026-08-24 and the harness was renamed (the `_KNOWN_OPEN` suffix is gone).** It previously pinned an expected-fail: `startRunHeartbeat` was exported from `campaignRunHeartbeat.js` with **zero** call sites in `src/`. `startRunHeartbeat` now appears 4× in `renderer.js` on `origin/master`. Why it mattered: without the beat, `CampaignRun.updatedAt` only moves when an ad *settles*, so a long video-titling gap could drop the backend duplicate-generation gate's running arm. |
| `verifyTitlingRecoverability.js` | Titling-failure recoverability (2026-08-25): (A) `brandScriptExecutor.stampTitlingFailureAndThrow` decides resumable-vs-terminal correctly for OOM/timeout/generic, bounded by a shared `TITLING_ATTEMPTS_MAX` ceiling (execution, real function, stubbed `Ad`). (B) the resume sweep is wired from `renderer.js` (not the RAM-inadequate `orchestrator.js` — see CLAUDE.md's titlingResumeService note), gated on `isAdgenRendererEnabled()`, `orchestrator.js` does NOT run it, and `titler.js`'s own titling call site was mirrored to the same gate (structural). (C) two REAL concurrent `resumeUntitledMasters()` passes racing the same ad — only one titles it (execution, in-memory Mongo-like stub, `scripts/lib/miniMongoStub.js`, whose `findOneAndUpdate` correctly models Mongoose's `{new:true/false}` pre/post-image semantics — an earlier version of the stub ignored `opts` and would have hidden a real sign/timing bug in the attempt-cap read-back). (D) a cap-exceeded titling failure keeps its detailed `renderError` — `processAd`'s unscoped `noteRenderIssue` no longer clobbers the stamp's message/code with a generic one. |
| `verifyTitlingResumeNeverResubmits.js` | THE MONEY CHECK: a resumed titling attempt can never re-submit a paid Atlas Omni generation. `atlasVideoService.submitGeneration` has exactly one call site, structurally inside the `else` of `if (isResuming)`; a real require-graph BFS (Node's own `require.resolve`) proves `atlasVideoService.js` is unreachable from `titlingResumeService.js`'s or `brandScriptExecutor.js`'s entire transitive require graph, with a positive control (same BFS from `renderer.js`, which DOES require it) ruling out a vacuous pass. |

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
| `ADGEN_MAX_INFLIGHT` | `src/config.js:58`, `render.yaml` renderer env `32` | 32 | Burst-claim ceiling per renderer instance (`poll` while `inFlight < MAX_INFLIGHT`). I/O-bound statics+video polls. |
| `ADGEN_POLL_MS` | `src/config.js:68` | 500 | Claim poll interval (ms). |
| `ADGEN_RENDERER_ENABLED` | `src/config.js:37-39`, `config/defaults.env` | `false` in file | Sleep vs claim. |
| `DERIVE_MASTER_WAIT_MS` | `renderer.js:106` | 60000 | How long a derive holds a slot waiting for the sibling master. |
| `DERIVE_MASTER_POLL_MS` | `renderer.js:107` | 5000 | Poll interval inside that wait. |
| `MAX_DERIVE_WAIT_ATTEMPTS` | `renderer.js:108` | 60 | Requeue ceiling (~60 min). |

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

Autoscale min 2 / max 8 does not rescue a single process whose RSS is over the
cap — during the incident it scaled 2 → 3 → 4 instances and made things worse,
because each new instance runs its **own** slots into the same per-instance
ceiling. Instance SIZE or this number are the only real levers.

---

## Local run

```
cp .env.example .env   # MONGODB_URI — staging, never prod
npm install
ADGEN_ROLE=api npm start                 # :3100/health
ADGEN_ROLE=orchestrator npm start        # read-only poll
ADGEN_RENDERER_ENABLED=true ADGEN_ROLE=renderer npm start
npm test                                 # origin/master only; needs scripts/
```

`.env.example` does not list `ADGEN_RENDERER_ENABLED`; without it the
renderer sleeps.

### Do not create a git worktree INSIDE this repo directory

**This keeps recurring.** A cleanup pass on 2026-08-24 whose entire purpose
was removing nested worktrees found a NEW one appear *during* the cleanup
itself: `liquidretail_adgen/.worktrees/pr34-measure`. The three-line version
of this warning that used to live here evidently was not enough to stop it —
hence the longer version below.

**Rule: worktrees go as SIBLINGS of the repo**
(`/Volumes/Sayulita/Projects/RS/.wt-<name>`), **never nested under
`liquidretail_adgen/`** — not `.worktrees/`, not `.claude/worktrees/`, not
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
`verifyRunFinalizesOnSettle_KNOWN_OPEN.js`.

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

**Never `npm ci` an adgen worktree, and never set `NODE_PATH` here.**
`verifyModelParity.js` needs its own `require('mongoose')` to FAIL first —
only then does its `Module._load` fallback patch install
(`loadMongooseWithFallback`, `scripts/verifyModelParity.js:124-173`), which
is what lets it read both adgen's and the sibling backend's 33 model files
through one shared mongoose instance (`captureSchema`,
`scripts/verifyModelParity.js:188-201`, patches `mongoose.model` once and
relies on every later `require('mongoose')` in the process resolving to
that same instance). Give the worktree its own `mongoose` — via `npm ci` or
via `NODE_PATH` pointing at any `node_modules` that has it — and the
fallback patch never installs, the shared-instance assumption breaks, and
every one of the 33 adgen models reports "never called mongoose.model(...)
— cannot extract a schema." Measured: a bare worktree passes 33/33; an
`npm ci`'d or `NODE_PATH`-set one fails 33/33 with that exact message, which
reads exactly like a real schema-parity defect and is not one. Run this
harness from a bare worktree with the sibling `liquidretail_backend`
checkout present alongside it.

**Backend is the opposite** — its worktrees need `npm run setup:worktree`
first, because its committed `node_modules` subset is incomplete. Don't
carry either repo's rule over to the other.

**Parallel agents running mutation-style revert-proves in the same repo
interfere with each other's suite runs.** Observed twice in one night as a
transient `verifyRequireGraph` failure caused by another process's temp
file — not a real defect. A clean re-run fixed it both times. Re-run before
reporting a lone red, especially on a harness whose own revert-prove recipe
mutates a file on disk while another session could be doing the same thing
concurrently.

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
of real margin. The floor is now a flat 20 min in both repos; this repo's value
dropped 25→20, which costs nothing because backend always stole at 20 anyway.
Poll budget is a latency choice; the floor is a money guard. The **upper** clamp on
`REFRAME_POLL_MS` is lease-derived, not `MAX_POLL_MS` — that direction is fine
(money guard bounds latency knob), and a sweep found the reverse permits a
1364.5s hold against a 1200s lease.

Cross-repo enforcement is `scripts/shared-invariants.json` (read from backend's
`origin/main`); per-repo, `scripts/verifyReframeHoldBounded.js` (27 checks,
revert-proven). Full write-up: `session.d/2026-08-27_reframe-hold-bounded.md`.

## What this repo does not do (yet)

- Expansion / Director / Judge / Ad mint — still backend.
- Orchestrator work (the container boots; it does not expand).
- HTTP generate, auth, catalog, publish.
- `GET /health` is the entire public HTTP surface.
- ~~`startRunHeartbeat` is vendored and **unwired**~~ — **WIRED as of 2026-08-24.**
  It is now called from `renderer.js` (4 sites) and
  `scripts/verifyCampaignRunHeartbeatWired.js` passes. Left visible rather
  than deleted so the next reader can tell this was fixed, not overlooked.
- ~~`titlingResumeService` / `bootRecoveryService` are vendored but neither
  is started~~ — **`titlingResumeService.resumeUntitledMasters()` is WIRED
  as of the video-titling-recoverability PR (2026-08-25)**, started from
  `renderer.js` (`pro_plus`, 8 GB), on a 90s-delay/5-min interval modeled on
  backend's own wiring, gated on `isAdgenRendererEnabled()` so it cannot
  race backend's own render/resume path over the shared collection when
  the flag is off. **NOT run from `orchestrator.js`** — that was the first
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
  **KNOWN, NOT FIXED HERE (cross-repo):** `liquidretail_backend`'s OWN
  `titlingResumeService` runs on its web process **ungated** on
  `ADGEN_RENDERER_ENABLED` (confirmed absent from
  `liquidretail_backend/index.js`'s wiring) and has no
  `stampTitlingFailureAndThrow`/`titlingResumable` concept at all — if
  backend's sweep wins the claim race on a resumable ad before adgen's
  does, its Remotion failure immediately terminal-fails the ad
  (`status:'failed'`) on the FIRST retry, undoing this fix's whole point
  for that one ad. This pre-existed for the OOM-only case; this PR widens
  which failures are exposed to it. The atomic claim still prevents a
  double-title either way. Fixing it requires a change to the backend
  repo — out of scope here, flagged for a follow-up.
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
     present on `origin/master` as of this writing** — this is not a
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
