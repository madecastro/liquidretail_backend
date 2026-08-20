# Parallel work: architecture plan

**Why this exists.** The owner runs 6-10 concurrent Claude Code sessions against
this repo. One measured night (~40 merges) showed the collision cost is now the
dominant tax on that setup: one file (`routes/ads.js`) had four agents editing
it simultaneously; the test gate is a 3-5 minute serial loop re-run dozens of
times; two rebases silently dropped content with no safety net; and a
worktree's incomplete `node_modules` cost hours of "is this a real bug or my
environment" confusion. This document proposes how to fix the structural
problems (decompose the hot files, split `CLAUDE.md`'s volatile content, adopt
a self-service ownership convention) and records what was executed immediately
because it was safe, high-value, and touched none of it.

**Scope discipline.** Sections 1-5 are **plans only** — no code in
`routes/ads.js`, `worker.js`, the two flagged services, or `CLAUDE.md` was
touched to produce this document, because six agents were mid-flight on those
exact files when this work started (see §6). Section 7 records what *was*
shipped now: a parallel test runner, three worktree-environment fixes, and a
rebase safety net — all in `scripts/`, `bin/`, and this file.

**A numbers correction, stated up front because stale counts are exactly the
kind of thing this plan is trying to stop propagating:** the brief's premise
cited "152 `scripts/verify*.{js,mjs}` scripts" and "160 `.js` scripts pass."
Measured directly against `origin/main` (`dcca06cb`, 2026-08-19): **169 total**
(160 `.js` + 9 `.mjs`). `CLAUDE.md`'s own §5 already carries a *third* number
("143 `.js` / 151 including `.mjs`") and flags itself as stale relative to an
even older "101" in the header. Three different counts of the same thing, all
inside one file, is itself evidence for §4 below. The tooling in §7 reports its
own count on every run instead of hardcoding one anywhere.

---

## 1. `routes/ads.js` decomposition

**4,776 lines** (measured; the brief's ~4,661 was stale by ~115 lines within
the same day). 20 routes plus ~1,750 lines of internals (`claimAdsForRun`,
`runRenderLoop`, `renderOne(Inner)`, `renderDeriveOnlyVideoAd`,
`findSiblingMasterAd`, `requeueStrandedAds`) that the routes call into.

### Route table (method + path, file order)

| # | Route | Lines | Cluster |
|---|---|---|---|
| 1 | `POST /preview` | :302-390 (89) | A — generation kickoff |
| 2 | `POST /generate` | :391-1262 (872) | A |
| 3 | `POST /runs` | :1409-1589 (181) | B — run lifecycle |
| 4 | `GET /runs/:runId` | :3091-3195 (105) | B |
| 5 | `POST /preview-video-composite` | :3205-3274 (70) | E — diagnostics |
| 6 | `GET /` (list) | :3295-3391 (97) | D — CRUD |
| 7 | `GET /meta-adsets` | :3410-3427 (18) | G — Meta push |
| 8 | `GET /render-activity` | :3443-3599 (157) | E |
| 9 | `POST /video-ref-prewarm` | :3610-3669 (60) | F — wizard support |
| 10 | `GET /video-models` | :3676-3692 (17) | F |
| 11 | `GET /formats` | :3700-3703 (4) | F |
| 12 | `GET /veo-prompt-scaffold` | :3710-3764 (55) | F |
| 13 | `POST /push-to-meta` | :3766-3797 (32) | G |
| 14 | `POST /:id/approve` | :3822-3850 (29) | D |
| 15 | `POST /:id/regenerate` | :3901-4022 (122) | D |
| 16 | `PATCH /:id` | :4029-4155 (127) | D |
| 17 | `DELETE /:id` | :4162-4232 (71) | D |
| 18 | `GET /:id` | :4238-4254 (17) | D |
| 19 | `GET /:id/generation-inspector` | :4266-4493 (228) | E |
| 20 | `GET /:adId/preview-page` | :4507-4532 (26) | E |

Non-route internals: `claimAdsForRun` :1295-1408, `runRenderLoop` :1594-2018,
`findSiblingMasterAd` :2019-2069, `renderDeriveOnlyVideoAd` :2070-2378,
`renderOne`/`renderOneInner` :2379-3065, `pickClosestBaseRatio` :3278-3292,
`projectAd` :4543-4678, `requeueStrandedAds` :4700-4759. Header/shared helpers
:1-292 (`assertGeneratableFormatList`, `parsePhase3WizardFields`,
`AD_STATUSES`, `veoTitlingSemaphore`).

### Clusters → target files

| Cluster | Routes | ~Lines | Target |
|---|---|---|---|
| **A. Generation kickoff** | `/preview`, `/generate` | 975 | `routes/ads/generate.js` |
| **B. Run lifecycle/status** | `/runs`, `/runs/:runId` | 300 | `routes/ads/runs.js` |
| **C. Shared render engine** (not routes) | `claimAdsForRun`, `runRenderLoop`, `renderOne*`, `findSiblingMasterAd`, `requeueStrandedAds` | 1,750 | `routes/ads/shared/renderEngine.js` |
| **D. CRUD** | list/approve/regenerate/PATCH/DELETE/GET | 465 | `routes/ads/adsCrud.js` + `routes/ads/shared/projectAd.js` |
| **E. Diagnostics** | preview-composite, render-activity, inspector, preview-page | 500 | `routes/ads/diagnostics.js` |
| **F. Wizard support** | formats, video-models, veo-prompt-scaffold, video-ref-prewarm | 140 | `routes/ads/wizardSupport.js` |
| **G. Meta push** | meta-adsets, push-to-meta | 50 | `routes/ads/metaPush.js` |

Route-registration order is load-bearing (`mongoose.isValidObjectId` accepts
any 12-byte string, so every fixed-path route must mount above `/:id`) —
preserve exact registration order when converting to `router.use(subRouter)`
mounts on the same `/api/ads` prefix.

### Where the four "hot" fixes actually landed (evidence the split helps, and where it can't)

| Hot area | Commit | Landed at | Cluster |
|---|---|---|---|
| run-status | `11ce9e12` | `/runs/:runId` :3140-3190, `/runs` crash handler :1558-1562 | B |
| video-timeout | `87cfdd00` | `renderOneInner` :2830-2891 | C |
| vision-QC | `6e953361` | import :111, `/runs/:runId` rollup :3117-3177, `projectAd` :4633-4675 | **B and D** |
| preview-URL (uncommitted, `fix/video-preview-perf`) | — | import ~:78, `projectAd` :4569 | **D** |

**Honest limit of a file split**: run-status and vision-QC collide inside the
*same handler* (`GET /runs/:runId`); vision-QC and preview-URL collide inside
the *same function* (`projectAd`). Splitting files removes collisions between
*unrelated* clusters (generate vs. diagnostics vs. Meta push) — it cannot
un-collide two fixes that are genuinely edits to the same 100-line function.
video-timeout is the one hot area fully isolated by the split (nothing else
touches `renderOneInner`). Set expectations accordingly: this is a real,
large reduction in collision surface, not a total elimination.

### Migration order (incremental; router stays mounted at identical paths)

1. **Cluster G (Meta push)** — smallest, no hot-area overlap, no harness reads
   its source text by path. Verify: full suite + manual curl of both routes.
2. **Cluster F (wizard support)** — read-only, no state. Watch registration
   order (must mount above `/:id`).
3. **Cluster E (diagnostics)** — touches some already-dead code
   (`smartCropBbox`, `videoCompositeService` per `CLAUDE.md` §1); move it
   as-is, do **not** clean it up in the same change. Verify: route-table diff
   + byte-diff JSON output for a handful of real ad ids.
4. **Cluster D + `shared/projectAd.js`** — `projectAd` is externally imported
   by `scripts/verifyStageVisibility.js:49`; update that import path in the
   same commit. Verify order: `verifyStageVisibility.js` first (fails loudly
   on an export-shape change), then `verifyRunsClaim.js` (proves the module
   still resolves the same way), then full suite, then a manual PATCH
   archive/restore smoke test (this route drives the identity-digest release
   path — money-adjacent).
5. **Clusters A + B + C together, one coordinated change** — `/preview`,
   `/generate`, `/runs`, `/runs/:runId`, and the render engine are mutually
   referential; splitting them across separate PRs would leave one file
   importing render-engine internals across a half-finished boundary. This is
   the highest-stakes step (every money invariant around atomic claiming,
   receipt-aware requeue, and the derive-only gate lives here). Verify with
   the full money-critical set, not a sample: `verifyRunsClaim.js`,
   `verifyPmaxVideoExpansion.js`, `verifyPmaxFunnelVariants.js`,
   `verifySharedPortraitMaster.js`, `verifyVideoIntentVariants.js`,
   `verifyVideoTimeoutReconcile.js`, `verifyCampaignRunHeartbeat.js`,
   `verifyRunStatusTruthfulness.js`, `testAdRunSelection.js`,
   `verifyGenerationGate.js`, plus the full suite + lint.
6. **`shared/wizardFields.js`, `shared/middleware.js`** last, once their
   consumers have already moved.

### The real hazard: ~15+ harnesses read `routes/ads.js` by raw source text

This is the single biggest risk in this migration and is **not optional to
handle** — a route-table diff is insufficient proof any step is safe.
Confirmed slice targets (`fs.readFileSync(...'routes/ads.js'...)` + string
search for a specific function/route):

- `renderDeriveOnlyVideoAd` — sliced by `verifyPmaxVideoExpansion.js`,
  `verifyPmaxFunnelVariants.js`, `verifySharedPortraitMaster.js`,
  `verifyVideoIntentVariants.js` (the most harness-coupled function in the
  file — move it last within cluster C's PR, update all four paths in the
  same commit).
- `findSiblingMasterAd` — `verifySharedPortraitMaster.js`.
- `runRenderLoop`/`renderOne` boundary — `testAdRunSelection.js:254-256`
  literally slices between `indexOf('async function runRenderLoop')` and
  `indexOf('async function renderOne')`; any reordering (even keeping both in
  one file) breaks this if anything is inserted between them.
- `router.param('id'` — `verifyAdIdParamGuard.js`.
- `router.get('/formats'` — `verifyAdsFormatsRoute.js`.
- `require('../services/generationGate')` + `/generate` body — whole-file
  regexes in `verifyGenerationGate.js:833-875`.
- `new Semaphore(` — `verifyTitlingPermit.js:171-174`.
- `requeueStrandedAds`, error entries, `preparing→running` flip,
  `REAP_STALE_MIN` — `verifyStrandedSweep.js`, `verifyLlmErrorCodes.js:430-431`,
  `verifyPreparingReap.js`, `verifyStalenessParser.js`.
- Four named exports consumed **by import path** from outside the file:
  `claimAdsForRun` (→ `verifyRunsClaim.js:51`), `requeueStrandedAds` (→
  `index.js:417`), `resolveDeriveFromMaster` (→ `verifyPmaxVideoExpansion.js:267`,
  `verifyPmaxFunnelVariants.js:222`), `projectAd` (→
  `verifyStageVisibility.js:49`).

`scripts/verifyRunStatusTruthfulness.js` is the one exception worth copying —
it bounds its slice at the *next* `router.(get|post|...)(` declaration rather
than a fixed offset, so it degrades more gracefully. **Every migration step
must budget time to update the affected harnesses' file paths in the same
commit as the code move** — this is real work, not incidental cleanup, and
skipping it makes the suite red for reasons that have nothing to do with
correctness.

### Avoid touching first

No `TODO`/`FIXME` markers in the file. The real fragility is external:
run-status, video-timeout, and vision-QC all landed within the same ~9-hour
window on 2026-08-19, hours before this plan was written. Extract by moving
whole functions/handlers verbatim; never hand-edit mid-move.

---

## 2. `worker.js` decomposition

559 lines. **Not** a dispatcher with many job kinds — one poller with two
queues (DetectRun, legacy Job) and one 238-line cross-cutting reaper
(`reapOrphans`, :256-494 — **43% of the file**).

### Structure

- Boot/config :18-150 (staleness constants derived inline: `REAP_STALE_MIN`
  :61, `PREPARE_STALE_MIN` :128, `WATCHDOG_INTERVAL_MIN` :132).
- Boot sequence (`mongoose.connect().then(...)`) :152-251 — `syncIndexes`,
  boot recovery, reap timers, watchdog timer, archive-sweep timer, spawns
  `CONCURRENCY` poll loops, starts the IG scheduler.
- `reapOrphans()` :256-494 — four unrelated, money-critical sweeps in one
  function: DetectRun requeue, Ad receipt-aware requeue, CampaignRun
  running→failed, CampaignRun preparing→failed, plus Slack notices.
- `workerLoop(workerId)` :496-559 — DetectRun claim → Job claim (branch on
  `fileType`) → jittered sleep, run `CONCURRENCY` times in parallel.

Most supporting infra (`services/concurrency`, `services/staleness`,
`services/backlogWatchdog`, `services/queuedArchiveSweeper`,
`services/bootRecoveryService`) is **already** extracted; the two things
still physically inside `worker.js` are the derived staleness constants and
the reaper itself.

### Proposed decomposition

| New file | Contents | ~Lines |
|---|---|---|
| `worker.js` (thin entrypoint) | boot, connect, wire timers, spawn poll loops | ~100 |
| `workers/pollLoop.js` | `workerLoop` skeleton minus handler bodies | ~35 |
| `workers/handlers/detectRun.js` | DetectRun claim+process | ~30 |
| `workers/handlers/legacyJob.js` | Job claim+dispatch (`pre-cropped` vs. legacy) | ~30 |
| `workers/orphanReaper.js` | all of `reapOrphans()` + `startOrphanReaper()` | ~270 |

### Migration order

1. **Extract the poll loop + both handlers first.** This code had **zero**
   touches in the 10 most recent commits that modified `worker.js` — it is
   uncontested territory and delivers the stated collision-reduction goal
   immediately. Verify: byte-diff the moved function bodies against the
   originals (pure move, no logic change); run the worker against a
   manually-queued DetectRun and both Job shapes, confirm identical status
   transitions.
2. **Extract `orphanReaper.js` only after step 1 is stable** — this is the
   actively-edited, money-critical piece (see below). **Before moving it,
   update every harness that reads `worker.js`'s source text for this logic**
   in the *same* PR: `verifyCampaignRunHeartbeat.js`, `verifyPreparingReap.js`,
   `verifyReceiptAwareRequeue.js`, `verifyNoStrandedQueued.js`,
   `verifyArchiveDigestRelease.js`, `verifyRunStatusTruthfulness.js`,
   `verifyStalenessParser.js`, `verifySlackRunVerbosity.js` all
   `readFileSync` this exact path today. Revert-prove per this repo's
   convention: reintroduce a known-fixed defect in the new module and confirm
   the corresponding harness fails.
3. **Relocate the derived staleness constants** into the reaper module once
   step 2 lands, so there is never a window with two copies.
4. **Collapse remaining boot wiring** into the final thin `worker.js`.

### Avoid touching first

**The job-dispatch loop is uncontested; `reapOrphans()` is the real hotspot.**
All 10 of the most recent commits touching `worker.js` land in either the
constants block or inside `reapOrphans()` — none touch `workerLoop()`. Dated
comments through :63-127 and :329-351 reference an ongoing 2026-08-18/19
incident (the CampaignRun heartbeat fix) still being refined one commit before
this plan's baseline. Extract the dispatch loop now; treat the reaper as a
separate, later, carefully-sequenced step, not because it's broken, but
because it's demonstrably where real PRs keep landing.

**Unverified discrepancy, flagged rather than reconciled**: the brief cites
"8 of 40 merges" touching `worker.js`; a direct commit check found 5 of the
last 40 *commits* (not distinguished as merges). Both land in the same two
regions, so it doesn't change the finding above.

---

## 3. `services/campaignAdsGenerationService.js` + `aiCreativeDirectorService.js`

### `campaignAdsGenerationService.js` (4,395 lines)

No mutable module-level state (everything is a frozen constant or an
env-derived value computed once at `require()` time) — splitting doesn't risk
losing shared runtime state. Two clusters are **CLAUDE.md-flagged money
invariants** and need the highest care:

| Cluster | Contents | Money risk |
|---|---|---|
| **Video money-gates** :43-956 | `resolveDeriveFromMaster`, `resolvePortraitMasterFormat`, `isSharedPortraitPlatePromptCoherent`, `planDeterministicVideoAds`, `resolveVideoDurationForFormat`, all kill switches | **High — imported by `routes/ads.js` and `adRegenerateService.js`; "defined once, never re-implemented" per CLAUDE.md** |
| **Identity digests** | `computeIdentityDigest`, `computeV2IdentityDigest`, `computeDeterministicVideoDigest` | **High — the sole anti-double-bill guard; digests must stay byte-identical** |
| Readiness/popularity scoring | pure math | none |
| Legacy-cartesian seed builders | image seeding | low |
| Video-seed resolution cascade | feed-order/hero cascade | money-adjacent (digest input) |
| Deterministic-video orchestrator | ties gates+digests+seeds together | inherits high risk |
| Concept-driven (Director-round) orchestrator | universe→Director→Judge→payloads | none directly |
| Selection/claim (`selectAdsForRun`) | kind-scoped claim | its own documented money note |
| Shadow LLM warm-up, merge/reporting, misc utils | | none |

Coupling that constrains splitting: `computeDeterministicVideoDigest` calls
`isGooglePmaxVideoFormat` (money-gates cluster) — these two must import from
each other, never duplicate. `resolveDeriveFromMaster` is consumed by two
files **outside** this service; any extraction must update those two import
sites in the same change or keep a permanent re-export shim.

**Proposed target**: `services/campaignAdsGeneration/{module}.js`, barrel-
re-exported from the current path. Migration order, safest→riskiest:
readiness scoring/reporting/shared utils (pure move) → seed builders (verify:
`verifyCatalogFeedOrderSeeding.js`, `verifySeededUniverseHeroDefault.js`) →
identity digests (verify: `verifySharedPortraitMaster.js` G3,
`verifyVideoIntentVariants.js` M1/M2 — byte-identical digest requirement) →
**video money-gates** (highest-risk step; verify:
`verifySharedPortraitMaster.js` 86 checks, `verifyPmaxVideoExpansion.js` 81
checks, `verifyMixedPlatformVideo.js`, plus grep `routes/ads.js` and
`adRegenerateService.js` to confirm they still resolve the *same function
object*, not a re-implemented copy) → video-seed resolution → deterministic-
video orchestrator → concept-driven orchestrator → shadow warm-up/selection →
top-level `expandWizardJob` last (depends on everything) → replace with
barrel, grep-repo for every importer, confirm identical export keys.

No `TODO`/`FIXME` found; three deliberately-partial features are documented
inline as future work, not instability.

### `aiCreativeDirectorService.js` (3,665 lines)

One piece of mutable state: a lazy-memoized `require()` (`_scoreQuote`,
:252) — idempotent, safe to split as long as it isn't duplicated into two
files. One **money cluster distinct from the video-billing risk above**:
round-artifact insert-race protection (:1991-2126, explicitly labeled "money"
in the file's own `module.exports` comment) — protects a paid Claude Sonnet 5
response from being dropped on a Mongo dup-key race.

The highest-care coupling: `assembleSignals` and three shared prompt-building
blocks (`OBJECTIVE_BLOCK`, `ARCHETYPE_WEIGHTING`, `buildFormatConstraints`)
are used by **both** the V1 legacy path and the V2 live round path — the
file's own comment states this is deliberate, so the Judge scores against the
same objective text as both prompts. **A copy-paste-instead-of-import mistake
here silently forks the V1/V2 prompt** — exactly the failure class CLAUDE.md's
§00 PR #61 section warns about. Also worth noting: this file declares its own
local `PMAX_FUNNEL_STAGES` constant (:1283) that duplicates (by value, not by
import) the one `campaignAdsGenerationService.js` exports — not a bug today,
but nothing enforces they stay in sync; either the split fixes this by giving
both a single shared source, or the plan should flag it as a pre-existing
small risk independent of the split.

**Proposed target**: `services/aiCreativeDirector/{module}.js`, same barrel
pattern. Migration order: JSON salvage (pure, verify:
`verifyDirectorJsonSalvage.js`) → payload validation → round-artifact
persistence (verify: `verifyDirectorRoundPersist.js`, revert-prove the retry)
→ style/shape enums → PMax round-brief helpers (verify:
`verifyPmaxPromptOverlay.js`) → **shared prompt-building blocks** (highest
care in this file — verify by byte-diffing the full prompt string for a fixed
input on both `buildPrompt` and `buildPromptRound`, before vs. after) →
signal assembly (verify: `verifyDirectorPrompt.js`, `verifyDirectorProofMenu.js`,
`verifySocialProofRestoration.js` groups A/B) → V1 legacy path → round
prompt+schema together (they must stay mutually consistent per the file's own
comment — verify: `verifyDirectorPrompt.js` again) →
`directConceptsRound` orchestrator last (verify:
`verifyDirectorFallbackChain.js`, `verifyLlmErrorCodes.js`,
`verifyDirectorJsonSalvage.js`) → barrel + full suite + lint + grep every
importer.

No `TODO`/`FIXME` found; the one partial feature (`PMAX_SPLIT_VIDEO`) is an
explicitly-labeled, default-off Stage 1 of a documented Phase B.

---

## 4. `CLAUDE.md`: volatile/stable split

**Do not restructure `CLAUDE.md`'s existing content now** (per the brief, and
because it moved twice under this plan while it was being written — see the
dated evidence below). This section is the inventory + rule-set for when that
restructuring *does* happen.

### What already exists and must not be re-derived from scratch

`CLAUDE.md` §5 ("Conventions") **already documents this exact problem** and
already rejected two tempting non-solutions, as of PR #238 (`session.md` →
`session.d/`) and a same-day follow-up:

- **`session.md` was already restructured** (2026-08-19): every dated entry
  now goes in its own `session.d/YYYY-MM-DD_<slug>.md` file, never a new
  paragraph in `session.md` itself. Two sessions creating two different files
  cannot conflict — there is no shared line to fight over. This is the exact
  pattern this section recommends extending to `CLAUDE.md`'s volatile
  content, because it already shipped and already works.
- **`CLAUDE.md` itself was deliberately NOT split**, because two harnesses
  assert on it *by this exact path* (below), and because it is a
  cross-referenced instruction manual read for correctness, not a log — a
  merge strategy that can silently keep two disagreeing versions of the same
  fact is a worse trade here than for `session.md`.
- **`.gitattributes merge=union` was considered and explicitly rejected**
  for `CLAUDE.md` and `docs/ALERTING.md` (2026-08-19, CLAUDE.md §5, last
  bullet). The reason, verified directly against the code below: union merge
  auto-resolves two edits to the *same table row* by silently keeping both,
  with no conflict raised and no human told. **Do not revisit this** — the
  rejection is correct and the plan should not propose it again.

### Exactly which harnesses read `CLAUDE.md` / `docs/ALERTING.md` by path, and how

This is the safety-critical part — get this list wrong and a future split
breaks a money-invariant harness silently.

**`scripts/verifyLlmErrorCodes.js`** (confirmed via direct read):
- `:548` `fs.readFileSync(path.join(REPO, 'docs/ALERTING.md'), 'utf8')` — F1
  parses every `|`-prefixed line into `rows`, then for each of the 15 `LLM_*`
  codes does `rows.find((l) => l.includes('`' + c + '`'))` — **a first-match
  lookup**, exactly the shape the merge=union rejection above is about: a
  silently duplicated row for the same code would make this read whichever
  copy sorts first and report green regardless of which one is stale.
  Asserts the row has ≥4 cells and a `billable` cell matching `` `true` ``/
  `` `false` ``/`` `unknown` ``.
- `:566` same file, F2 — scans for every `` `LLM_[A-Z_]+` `` mention and
  asserts it exists in the real `LLM_ERROR_CODES` taxonomy (catches stale
  rows documenting a retired code).
- Also reads `CLAUDE.md` only in **comments** (`:18`, `:68`, `:155`, `:442`)
  as citations, not as parsed content — those are prose, not a machine check,
  and don't constrain a split.

**`scripts/verifyCampaignRunHeartbeat.js`** (confirmed via direct read):
- `:814` `fs.readFileSync(path.join(ROOT, 'docs/ALERTING.md'), 'utf8')` — G3
  asserts the doc no longer claims "CampaignRun has no periodic heartbeat"
  and that it names the owning service, the pinning harness, the measured
  incident, and the operator-visible field. Substring assertions, not a
  table row — safe as long as the *sentence* survives somewhere in
  `docs/ALERTING.md`, regardless of which section it's in.
- `:854` `fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8')` — G4 asserts
  `CLAUDE.md` carries the run id, the owning service, and the pinning
  harness name, again as substrings, not a table row.

**Net rule, derived from the above, not asserted**: the two harnesses do a
**substring/first-row-match search over the file's full text** — they do not
care which *section* the content is under, only that specific facts appear
*somewhere* in the named file. This means: **moving prose between sections
within `CLAUDE.md` is always safe for these two harnesses; moving content
*out* of `CLAUDE.md` (or `docs/ALERTING.md`) entirely is safe only if the
exact asserted substrings/table rows move with it to the *other* named file
these harnesses read**, which today is only `docs/ALERTING.md`. A pointer
sentence left behind in `CLAUDE.md` ("Full write-up: `docs/incident-X.md`")
does **not** satisfy G4 if the actual run id / service name / harness name
were the thing moved — the harness has no notion of "see elsewhere."

### Classification of `CLAUDE.md`'s top-level sections

| Section | Class | Notes |
|---|---|---|
| Header (prod, offline-suite count, worktree gotchas) | VOLATILE | Already 3 generations of stale counts inside one paragraph — see the correction at the top of this document. First candidate to shrink to a pointer. |
| §00 Catalog product-ad pipeline | **HARNESS-READ risk** (indirectly) + VOLATILE additions | The architecture description is closer to STABLE-INVARIANT, but it has become the dumping ground for inline incident narratives (see PR #239 evidence below) — those additions are VOLATILE and should not have landed here. |
| §0 "The one rule" | STABLE-INVARIANT | Short, general, rarely edited. |
| §1 Dead/disabled paths | STABLE-INVARIANT (with a decay risk) | Needs periodic re-verification, not frequent editing. |
| §2 Money invariants | **STABLE-INVARIANT, but see "Known open"** | The invariant statements themselves belong here permanently. The "Known open" subsection is where incident write-ups keep landing — see below. |
| §2 "Known open" subsection | VOLATILE | This is the actual append point for most of the growth measured in the brief — each dated bullet is an incident write-up, several 40-80 lines long. |
| §3 Verified external facts | STABLE-INVARIANT | Dated but low-churn. |
| §4 Repo traps | **MIXED — HARNESS-READ for two specific facts, VOLATILE for the rest** | The two G3/G4 facts above live inside this section's LLM-error-codes bullet; the surrounding narrative (measured incidents, "shipped to production three times") is VOLATILE. |
| §4a Render dashboard vs. `config/defaults.env` | STABLE-INVARIANT | Explicitly says "the per-key list is deliberately not repeated here" — already following the pattern this section recommends. |
| §5 Conventions | STABLE-INVARIANT | Rules, not incidents — and already contains the correct guidance (see below). |

**Confirming §5 already says the right thing** (quoted, not paraphrased,
because this is the rule a future restructuring should enforce mechanically
rather than re-litigate): *"keep new bullets short. State the rule and the
money/correctness consequence in 1-5 lines with a citation
(`session.d/<file>.md` or `docs/PIPELINES.md §N`) for the full incident
write-up — do not paste the forensic narrative inline here."* The problem
isn't that the convention is missing. It's that it isn't followed.

### Concrete, dated evidence the convention isn't holding — and it's from *today*

PR #239 (`35af6843`, merged after this plan started) is a clean natural
experiment: same incident, three places.

- **`CLAUDE.md`**: +22 lines inserted directly into §00's video-titling
  paragraph — a full "Two causes, both fixed: (1)... (2)..." narrative,
  ending in a `Pinned by` citation. No pointer sentence to the session.d/
  entry was added.
- **`session.d/2026-08-19_reels-quote-opening-line-silently-dropped-fixed-pr-239.md`**:
  a new, 113-line file with the same narrative in more detail — correctly
  following the `session.md` restructuring convention.
- **`docs/TITLING.md`**: 6 lines changed with related content (confirmed by
  running this plan's own rebase-safety tool, §7, against the pre/post-rebase
  refs spanning this exact commit — it flagged two now-superseded sentences
  from the old `docs/TITLING.md` as "missing," which on inspection is this
  legitimate edit, not a rebase-created loss; see §7 for the full worked
  example).

Same-day, same-incident, three copies — while the file's own convention,
written days earlier, asked for one copy plus a citation. **The convention is
sound; it has no enforcement.** A person or an agent under time pressure
defaults to "append here, it's already open" rather than "open the other
file and write a five-line pointer."

Also notable, from the same commit's own message: *"Full offline suite:
166/169 green (3 known-environmental sharp failures, unrelated)"* — an
independent, same-day confirmation of exactly the `sharp` worktree bug fixed
in §7 below, from a session that hit it and correctly reasoned past it rather
than losing time to it.

**A second, even more direct same-day repeat: PR #240** (`49e08692`,
video vision-QC), merged while this plan was being written. Its own commit
message states it *"corrects two stale CURRENT STATE facts found while
running the full verify gate this session: the script count (160, not 168)
and the sharp-in-a-worktree failure class, which is a repairable
git-worktree artifact (`npm install sharp --no-save --ignore-scripts`), not
permanently environmental."* Three independent sessions, one day, three
separate encounters with the same two facts (a stale script count, and the
`sharp` worktree gap) — this plan's own count correction at the top and the
§7 `sharp` fix are not solving a hypothetical, they are the fourth and fifth
touches on the same afternoon. PR #240's own diff to `CLAUDE.md` is a second,
cleaner instance of the append-tax pattern too: its commit title says
"docs: record the video vision-QC gap closure (**CLAUDE.md, ALERTING.md,
session.d**)" — naming all three files it touched with one incident's
narrative, the same shape as PR #239, just more self-aware about it.

One correction PR #240 did NOT make, worth flagging precisely because §00's
own header text is what it left stale: the header still says *"`NODE_PATH`
alone will not fix it, since Node resolves the local `node_modules` first"* —
true of the OLD hardcoded-`__dirname`-path form these three scripts used
before this PR's §7 fix, but no longer the full picture now that they
`require('sharp')` normally (which DOES consult `NODE_PATH` as a resolution
fallback). Not fixed here, deliberately, per this plan's own scope discipline
(§4 opening) — noted for whoever next edits that header.

### Recommendation (propose only — do not execute now)

1. **When `CLAUDE.md` restructuring does happen**, move the "Known open"
   incident subsections of §2 and the incident-shaped additions inside §00/§4
   into `docs/` (either new dated files under `docs/incidents/`, or folded
   into the relevant subsystem doc — `docs/PIPELINES.md`, `docs/TITLING.md`,
   `docs/ALERTING.md`), leaving a one-line pointer in `CLAUDE.md`. Do this
   **file by file**, one incident-cluster at a time, each as its own PR, and
   run `checkRebaseContainment.js` (§7) against the before/after of each PR —
   it is exactly the tool that would catch a moved fact silently failing to
   land anywhere.
2. **Preserve every exact substring/table row `verifyLlmErrorCodes.js` F1/F2
   and `verifyCampaignRunHeartbeat.js` G3/G4 assert on**, listed above,
   verbatim, in whichever file ends up holding them — `CLAUDE.md` or
   `docs/ALERTING.md`, the two paths those four checks read today. Do not
   rely on a pointer sentence to satisfy them.
3. **Do not add `merge=union`** — this was correctly rejected already; this
   plan is not reopening it.
4. **A lightweight mechanical nudge is worth building, later, as its own
   safe slice** (not done now — it's an enforcement tool, not a docs edit,
   but it's still worth flagging precisely because §00/§5's evidence shows a
   *written* convention wasn't enough): a small advisory script run in CI or
   pre-push that flags a `CLAUDE.md` diff adding more than ~10 contiguous
   lines to §00/§2/§4 without a `Full write-up:`/`See docs/`/`session.d/`
   citation in the same hunk. Advisory, never blocking — this repo's own
   culture (owner is a non-coder reviewing outcomes, not diffs) means a hard
   gate here would just get bypassed under pressure; a printed reminder at
   push time is the right weight. Sketch only; not implemented in this PR.

---

## 5. File-ownership convention

**Goal**: any of the 6-10 concurrent sessions can discover, without asking a
human, which files another session already claims — replacing the
owner's manual "I hand-coordinated who owned which file all night via
messages" from the brief. **Constraint**: sessions rotate names (per the
brief), so identity must be the **branch/worktree**, not a session label a
human has to track.

### Why not a single shared file

The obvious first idea — one `docs/ACTIVE_WORK.md` or `.claude/ownership.json`
that every session edits to register its claim — recreates the exact problem
this whole document exists to solve: it becomes a new hot file that every
concurrent session writes to, and two simultaneous claims are themselves a
merge conflict on the claims file. Any first-match/duplicate-tolerant merge
strategy for it has the same silent-staleness risk documented in §4 for
`docs/ALERTING.md`'s table. Reject this shape outright.

### Proposed shape: one file per claim, keyed by branch name

Mirror the `session.d/` precedent that already shipped in this repo (§4) —
many small files, one per writer, so concurrent writes never touch the same
line:

```
.claude/claims/<branch-slug>.json
```

```json
{
  "branch": "fix/video-preview-perf",
  "worktree": "/private/tmp/.../wt-video-preview-be",
  "startedAt": "2026-08-19T09:41:00Z",
  "globs": ["routes/ads.js#projectAd", "services/videoPreviewUrl.js"],
  "summary": "add previewVideoUrl to the ad projection",
  "expectedPrEta": "2026-08-19T12:00Z"
}
```

- **Written once by the owning session**, at the start of work, and deleted
  (or a companion `<slug>.done` marker added) when the branch merges or is
  abandoned. Only the owning branch ever writes its own file — no contention.
- **`globs` is advisory, not enforced.** It names the files (and, where
  useful, the specific function — see the `routes/ads.js#projectAd` example,
  which matters exactly because §1 shows two hot fixes colliding *inside* one
  function, not just one file) the session expects to touch. Nothing stops a
  session from touching more; the value is a two-second grep before starting
  work, not a lock.
- **Discovery is a read, not a query to anyone**: `ls .claude/claims/*.json`,
  or a tiny helper (`node scripts/listClaims.js` — not built in this PR)
  that unions every file and flags overlaps with the files you're about to
  touch. This can run automatically as a first step of any session's
  workflow, exactly like `git status` already is.
- **Staleness self-heals via age, the same principle as §7's
  `findStaleUncommittedWork.js`**: a claim with no corresponding open PR and
  older than a threshold (a few hours, given this repo's actual PR cadence)
  is presumptively abandoned and safe to ignore or overwrite. No human has to
  declare it dead.

### Where the claims live, given this repo's actual environment

Every session here already works in a **git worktree** off a single shared
filesystem (`/Volumes/Sayulita/Projects/RS/` held ~30 worktrees at once when
this plan was written — `.worktrees/*`, `.wt-*`, and per-session scratch
dirs). Two storage options, in order of preference:

1. **A plain shared directory on that filesystem**, e.g.
   `/Volumes/Sayulita/Projects/RS/.claim-registry/*.json`, sibling to both
   `liquidretail_backend` and `liquidretail`, visible to every worktree of
   either repo with zero git operations — no commit, no push, no merge, no
   branch to fetch. This is the right default for this specific setup (one
   operator, one machine, one filesystem) and is genuinely free of the
   collision problem: every session writes only its own file.
2. **A git-based fallback** (`git fetch origin claims:claims`, write own file,
   `git push origin claims` to a dedicated orphan branch) for a future where
   sessions run on separate machines/containers without a shared filesystem.
   Concurrent pushes to *different* filenames on the same branch are ordinary
   fast-forwards; a losing race is a cheap re-fetch-and-retry, not a merge
   conflict, because no two sessions ever touch the same file.

Recommendation: build option 1 first (cheaper, matches the actual
environment); keep option 2 as a documented fallback, not built until it's
needed. **Not implemented in this PR** — this is the plan's proposal, per the
brief's framing of this item as a §A (plan) deliverable, not a §B (execute
now) one.

---

## 6. Sequencing against the six in-flight agents

At the time this plan was written, six agents were active: the
undispatched-ad-tail fix (top priority, in `routes/ads.js`), moderation-
rejection handling, video vision QC (`services/adVisionQcService.js`), Reels
title truncation (`remotion/`), and two more implied by the brief's file
list. All four of those landed **during** this session — this plan does not
merely coexist with fast-moving trunk, it was actively rebased across it,
repeatedly, which is itself a live test of the friction this document is
about:

| PR | What | `origin/main` after |
|---|---|---|
| #239 | Reels quote-truncation fix (`remotion/`) | `35af6843` |
| #241 | **The top-priority undispatched-ad-tail fix** — closed the exact "9 stranded rows invisible to the sweeper" gap in `CLAUDE.md` §2's own heartbeat write-up | `7a5822c6` |
| #240 | Video vision-QC (`services/adVisionQcService.js`) | `49e08692` |
| #242 | Pelagic price-snapshot repair | `a96f304c` |
| (2 more) | Catalog visual-signal persistence; Apify IG comment backfill | `c633e2c1` |

This plan:

- Touched **zero** lines in `routes/ads.js`, `worker.js`,
  `campaignAdsGenerationService.js`, `aiCreativeDirectorService.js`,
  `CLAUDE.md`, or `remotion/`, across the whole session.
- **Rebased onto `origin/main` three times** in one working session
  (`dcca06cb`→`35af6843`, then →`a96f304c`, then →`c633e2c1`) with **zero
  conflicts each time** — because every file this work touches (`scripts/`,
  `bin/`, `docs/PARALLEL_WORK.md`, `package.json`) stayed untouched by the six
  in-flight agents, confirming §1-3's premise that a plan-only PR restricted
  to uncontested paths really does rebase for free even against a fast-moving
  trunk. Ran `scripts/checkRebaseContainment.js` (§7) after each rebase — one
  real, expected false-positive on the first (a legitimate `docs/TITLING.md`
  edit from PR #239, inspected and confirmed benign; see §7's worked example),
  clean on the other two.
- Everything in §1-3 was researched read-only, in a separate git worktree, off
  a pinned commit — no product code was written for those sections. The line
  citations in §1-3 are pinned to `origin/main` at the commit named in each
  section's survey and were **not** re-verified against every subsequent
  merge — `routes/ads.js` and `worker.js` both changed again after the survey
  (PR #241), so treat exact line numbers there as approximate-but-structurally-
  sound, not byte-current, and re-grep before relying on one.
- The top-priority in-flight fix (#241) landing successfully, without this
  plan's authors going anywhere near `routes/ads.js`, is itself a small
  positive data point for the "stay off contended files entirely" strategy
  this plan follows for its own execution.

**Sequencing recommendation for whoever executes §1-3**: do them one cluster
at a time, in the safest-first order given in each section, with the full
verify suite (§7's new runner — 34s, not 95s) run after every step. Do **not**
start §1/§2/§3 extraction while an active fix targets the same cluster; check
`.claude/claims/` (§5, once it exists) or ask in-channel first.

---

## 7. What was executed now (the safe slice)

Everything below lives in `scripts/`, `bin/`, `package.json`, and this file —
nothing that six other agents were touching.

### A parallel aggregate test runner — `scripts/runVerifySuite.js`

Replaces the documented `for f in scripts/verify*.js; do node "$f" || echo
FAIL; done` loop (which also silently skipped all 9 `.mjs` harnesses) with a
worker-pool runner reporting the same per-script verdict (process exit code).

**Measured, same tree, same 169 scripts, diffed directly:**

| | Serial (documented loop, `.js` only) + `.mjs` separately | This runner, all 169 |
|---|---|---|
| Wall clock | 94.5s + 0.6s = **~95.1s** | **33.6-34.7s** (concurrency=8, 3 runs) |
| Verdict | 169/169 pass, 0 failures | 169/169 pass, 0 failures — **identical set, identical result** |

`--affected` mode selects scripts by (a) the script itself changed, or (b) its
source text mentions a changed file — a heuristic dev-speed tool, explicitly
documented as not a substitute for the full suite before pushing.
`--list`/`--concurrency`/`--timeout` flags; no shelled-out `timeout` binary
(macOS has none) — per-script timeout is a JS timer + `child.kill()`.

**`--affected`'s bare-basename matcher silently zeroed itself out on short
filenames — found and fixed 2026-08-19.** The first version gated its
substring match to basenames `>= 4` chars "to avoid drowning the selection in
noise." That gate did not just add noise-avoidance, it **excluded every short
filename outright**: `models/Ad.js` → basename `"Ad"` (2 chars) never matched
anything, so editing the Ad schema alone reported "no verify scripts
affected... Nothing to run" with **exit 0** — a confident, silent false
negative — even though 7 verify scripts directly `require('../models/Ad')`.
Same hole for `models/Job.js` ("Job"), `routes/me.js` ("me"), and
`routes/ads.js` ("ads") — the single most-edited file in this repo.

**The fix, in two parts, not one:**
1. A **precise `dir/basename` check with no length gate** runs first —
   e.g. `"models/Ad"` for `models/Ad.js`, `"routes/ads"` for `routes/ads.js`.
   That's what a real `require('../models/Ad')` looks like as a substring, and
   it's specific enough that a length gate was never actually needed for it —
   short filenames now match exactly instead of being dropped.
2. For any changed file that still matches **nothing**, and lives under
   `CORE_DIRS` (`models/`, `routes/`, `services/`, `middleware/`, `config/`,
   `utils/`, `pipelines/`, `remotion/`, `schemas/` — directories everything
   else routinely `require()`s), `computeAffected` refuses to report a clean
   "nothing selected." It fails loud and returns `null`, and the caller falls
   back to running the **full suite** — because a core-dir file matching no
   script is a heuristic gap, never proof the file has zero dependents.

**Verified on this tree, each as an isolated uncommitted edit diffed against
`HEAD`:**

| Changed file | Old behavior | New behavior |
|---|---|---|
| `models/Ad.js` | basename `"Ad"` (2 chars) → **nothing selected**, exit 0 | 14 scripts selected, including all 7 real dependents (`verifyArchiveDigestRelease`, `verifyBasePlateCropOrder`, `verifyAgentRegistry`, `verifyPmaxVideoExpansion`, `verifyQueuedArchiveNotice`, `verifyStrandedSweep`, `verifyTitlingResume`) |
| `routes/ads.js` | basename `"ads"` (3 chars) → **nothing selected**, exit 0 | 36 scripts selected |
| `routes/me.js` | basename `"me"` (2 chars) → **nothing selected**, exit 0 | 1 script selected (`verifyAgentRegistry.js`) — precise, not a full-suite fallback |
| `routes/salesDemos.js` | already worked (`>=4` chars) | 2 scripts selected — confirms a real narrow dependency still selects narrowly, not just core-dir files that happen to fail loud |
| `models/Job.js` | basename `"Job"` (3 chars) → **nothing selected**, exit 0 | matches no script (real: `Job.js` has no direct verify-script dependent today) → `CORE_DIRS` fires, refuses the false "clean," falls back to the full 173-script suite |

The `models/Job.js` row is the fail-loud path exercising for real, not a
constructed example: it is a genuine `CORE_DIRS` file with zero current verify
dependents, and the runner correctly declines to call that "nothing to run."

Audited for parallel-safety before building this: no `scripts/verify*` script
talks to a live DB or network (the ~9 touching `mongoose` do so for in-memory
schema use only, confirmed by their own comments; zero scripts require
`axios` directly), and the 4 scripts that write temp files all use
`fs.mkdtempSync` (unique per process) — concurrent execution is safe today.
`UNSAFE_FOR_PARALLEL` in the runner is the escape hatch if a future script
breaks that assumption.

Wired as `npm test` / `npm run test:affected`.

### Three `sharp`-hardcoded harnesses fixed

`verifyLogoSilhouette.js`, `verifyLogoColorPreservation.js`,
`verifyStaticTextInk.js` each did
`require(path.join(__dirname, '..', 'node_modules', 'sharp'))` — an absolute
path that bypasses `NODE_PATH` and always fails in a fresh worktree (which has
no `node_modules/sharp`, since it's a native module and was never committed).
Changed to plain `require('sharp')`, which resolves normally and honors
`NODE_PATH`. Verified by removing `sharp`/`https-proxy-agent` from a worktree
entirely, confirming all three fail with `MODULE_NOT_FOUND`, reinstalling, and
confirming all three pass (17, 17, and 21 checks respectively). Independently
corroborated the same day: PR #239's own commit message logs "166/169 green
(3 known-environmental sharp failures, unrelated)" — this exact bug, hit by a
different session hours earlier.

### `bin/setup-worktree.sh` (+ `npm run setup:worktree`)

Installs `https-proxy-agent@5.0.1` and `sharp` with `--no-save`, restores the
tracked `node_modules/.package-lock.json` (so the install doesn't leave a
diff in a tracked file), then runs the verify suite. Tested end-to-end
against a worktree with both packages removed — installs correctly and the
full 169-script suite passes afterward.

### A rebase safety net — `scripts/checkRebaseContainment.js`

Two read-only checks between a before/after ref: **line containment**
(every significant line in any `*.md` file at `before` must appear somewhere
in `*.md` at `after` — a heuristic, documented as such, that would rather
over-flag a reworded line than miss a deleted one) and **commit containment**
(every commit unique to `before` must have a `git patch-id` match among
commits unique to `after` — flags a commit that vanished instead of being
replayed).

**Verified three ways**:
1. **Constructed true positive**: a branch with one new commit adding a
   sentinel doc line, "rebased" onto a branch that dropped it — both checks
   correctly flagged the loss.
2. **Constructed true negative**: the same commit properly cherry-picked
   (replayed, different hash, same content) — both checks correctly reported
   OK.
3. **Real dogfood run**, this session's own rebase (`dcca06cb` → `35af6843`
   via `origin/main`): commit containment correctly reported OK (clean
   fast-forward, zero commits lost); line containment flagged 2 lines from
   `docs/TITLING.md` — inspected and confirmed to be PR #239's own legitimate
   edit to that file (see §4's evidence section), not a rebase-created loss.
   This is the documented heuristic tradeoff working exactly as intended: a
   human 2-second glance resolved it.

All test branches/worktrees created for cases 1-2 were deleted after
verification; nothing was left behind. Wired as
`node scripts/checkRebaseContainment.js <before> [after]` /
`npm run check:rebase`.

### A fourth slice, added mid-session: stale uncommitted work — `scripts/findStaleUncommittedWork.js`

Added after the orchestrator surfaced a **different** failure mode found
independently: 41 lines of finished, prod-verified work sat uncommitted in
the shared checkout for hours, discovered only because the owner happened to
ask why the tree wasn't clean (`git log --all -S` found it in zero commits —
it was never committed anywhere, not lost to a bad merge). This is distinct
from every other problem in this document: not two sessions fighting over the
same lines, but one session's finished work having nowhere durable to land.

Lists tracked (not untracked — this repo's shared checkout separately
accumulates dozens of `_tmp_*.js` scratch files, a lower-stakes, different
kind of clutter) files with uncommitted changes, flagging any whose most
recent write is older than a threshold (default 2h) via mtime. Reporting
only — never commits, stashes, or touches a file; the fix is always a human
decision (branch it, or discard it), never a silent third option.

**Run against the real shared checkout as part of verifying this tool** (read-
only, so safe to run): it correctly found **3 tracked files with
uncommitted changes, ~9.4h old** — `routes/ads.js` (+28/-1),
`services/seededUniverseService.js` (+13/-2), `session.md` (+105/-0). Per the
orchestrator's explicit instruction, this plan does **not** attempt to land,
inspect the intent of, or otherwise touch those three files — a different
agent owns that. The finding is reported here only as proof the tool works
against a real, current instance of the failure mode it's meant to catch.

Wired as `npm run check:stale-work`; `--repo=<path>` to point at any
checkout, `--json` for machine consumption, `--min-age-hours=N` to tune the
threshold.

### A fifth slice: committed work with no PR — `scripts/findOrphanedBranches.js`

The orchestrator surfaced a second variant of the same "finished work has no
durable home" failure mode mid-session: *"two separate orphans confirmed now,
one of which had a commit but no PR ever opened."* `findStaleUncommittedWork.js`
only sees uncommitted diffs — a real commit sitting on an unpushed or
never-PR'd branch is invisible to it, so this is a genuinely separate check,
not a duplicate.

This repo's git worktrees all share one `.git`, so `git for-each-ref
refs/heads` already enumerates every branch any worktree created (222 at the
time this ran) — no filesystem walk needed. For each branch with commits
ahead of `origin/main`, it cross-references GitHub via **one** batched `gh pr
list --state all` call (not 222 individual API calls) and classifies:
**ORPHANED** (commits ahead, no PR record ever) vs. **STALE** (commits ahead,
but every matching PR is already closed/merged — usually just a local branch
nobody ran `git branch -d` on). A `--min-age-hours` floor (default 3) excludes
branches that are plausibly still being worked.

**Run against the real repo (read-only) as part of verifying it**: found **8
ORPHANED** branches (3.7h to 387h old, 1-3 commits each — e.g.
`fix/pelagic-ad-price-snapshots`, 1 commit, 14.2h old) and **119 STALE**
branches (ordinary post-merge local cleanup debt, not concerning). Per the
same instruction as the fourth slice, **none of the 8 were landed, deleted, or
investigated** — reported only as proof the tool catches a real instance of
exactly the failure mode described. One caveat worth stating plainly: this
matches PRs to branches by exact head-branch NAME, so content that was landed
under a *different* branch name (e.g. cherry-picked into a fresh PR branch)
will still show as ORPHANED even though it is safely merged — an ORPHANED
result means "needs a human look," not "proven lost." Wired as
`npm run check:orphaned-branches`; `--show-stale` for the full STALE list
(collapsed to 5 by default so the actionable ORPHANED bucket isn't buried).

### Gate

`npm run lint` clean throughout. Full suite green after every change in this
session, including post-rebase (169 scripts at the time this section was
first written; 173 after the 2026-08-19 rebase onto a `main` that had moved
another 6 commits — see the correction immediately below).

**The flake: root-caused and fixed (2026-08-19), superseding everything this
subsection said before.** The paragraph that used to be here claimed "a
single **different each time** script," "likely module-load contention," "not
chased to a root cause," and recommended re-running a failing script
standalone before treating it as a regression. An adversarial review measured
the runner directly instead of trusting that writeup, and **every one of
those claims was wrong**:

- **25 runs at the default `--concurrency=8`: 170/170 every time, zero
  flakes.**
- **20 runs at `--concurrency=16`: 4 failures (20%) — and contrary to
  "different each time," every single failure was the *same* script,
  `verifyDirectorFallbackChain.js`.**

**Root cause, actually chased down this time:** check **C4** in that script
sets `ATLAS_LLM_CHAIN_BUDGET_MS=60`, stubs the upstream HTTP call to burn 40ms
of **real wall clock** via `setTimeout`, and asserts exactly 2 calls start
inside that 60ms **real-clock** window before `atlasLlmService`'s budget gate
(`Date.now() - startedAt < CHAIN_BUDGET_MS`, itself real-clock) refuses a
third. Under CPU oversubscription — 16 Node processes contending for this
machine's 10 cores — the scheduler does not guarantee a `setTimeout(40)`
returns inside a 60ms window, so call #2 sometimes never starts and
`calls.length` comes back 1 instead of 2. That is a hardcoded-real-timer race
between the test's own stub and the OS scheduler, not module-load contention
and not a bug in the budget logic itself — the two "it's probably these two
unrelated heavy-`require()` scripts" guesses in the old writeup were never
checked against evidence.

**Why "re-run it standalone before treating it as a real regression" was
actively unsafe, not just factually wrong:** a standalone rerun has zero
contention, so it clears this exact failure class *every single time* —
which means a genuine future regression in `atlasLlmService`'s budget gating
that manifests the same way ("saw N-1 calls instead of N") is
indistinguishable from this known flake under that policy, and the
recommended remedy would launder it straight through as "just the flake."

**The fix:** C4 no longer races a real timer against a real clock. Both are
faked for the duration of the check — `Date.now` is stubbed, and the HTTP
stub advances a logical counter by 40 instead of actually waiting 40ms — so
the budget gate now evaluates against *computed* elapsed time, never
*measured* elapsed time. This asserts the gate's actual logic
deterministically instead of racing the host scheduler to exercise it.

Three more scripts use the same real-`setTimeout`-inside-an-async-check
shape and were individually audited for the same failure class, not just
pattern-matched by their file names:

- **`verifyIngestShotClassify.js` (check J4)** races `safeFetchBuffer`'s real
  `AbortController` deadline against real per-hop delays (`TIMEOUT_MS=200` vs
  `HOP_MS=80`) — structurally the same shape as C4, with a wider margin
  (2.5x vs C4's ~1.5x) that did not reproduce a failure across repeated
  stress runs at `--concurrency=16`. Unlike `atlasLlmService`'s budget gate,
  `safeFetchBuffer`'s abort timer isn't behind an injectable clock, so making
  it deterministic the way C4 was fixed would mean changing production
  fetch/abort code, not just the test — out of scope here. Instead its
  `TIMEOUT_MS`/`HOP_MS` were widened 5x (1000ms/400ms, same ratios, same
  assertions), which shrinks scheduler jitter to a much smaller fraction of
  every window and cuts the residual risk without touching `safeFetchBuffer`
  itself.
- **`verifyTitlingPermit.js`** and **`verifyScrapeSession.js`** also call
  `setTimeout` inside async checks, but neither races a tight real-time
  budget: one uses it purely as concurrency-creating scaffolding for a
  `Semaphore` peak-count assertion (any nonzero delay creates the overlap;
  the assertion doesn't depend on its size) plus a 500ms deadlock watchdog
  with a wide margin, the other purely to let four concurrent callers pile up
  before a stub resolves, for a refresh-de-dupe assertion. Neither needed a
  change.

**Fresh evidence, post-fix:** C4 in isolation (`node
scripts/verifyDirectorFallbackChain.js`, standalone, no pool) — **30/30 clean**,
matching the "both clocks are now faked" design: nothing left for the OS
scheduler to race.

The pooled full-suite claim needs an honest caveat instead of a clean number.
Measured at `--concurrency=16` on this 10-core machine, but with **6-10 other
Claude Code sessions' background agents actively running** at the same time
(51-63 concurrent `node` processes system-wide, not the pool's own 16) — a
condition this repo now runs in most nights, not a contrived worst case.
Under that load, some runs surfaced 1-2 failures in `verifyRenderFailureRecord.js`
and `verifyVideoRetryOnUnbilledFailure.js` — **not** `verifyDirectorFallbackChain.js`,
and neither script is part of this fix's scope. A cold, single-shot run of the
same suite passed 173/173. This reads as genuine machine-level contention
(real CPU/memory pressure from unrelated processes), not evidence the C4 fix
regressed — but it means "16" is not a safe universal default divorced from
how loaded the host already is. **Do not claim a clean N-run/zero-flake
number for the pooled suite under realistic host load until those two
scripts are themselves audited for the same hardcoded-real-timer pattern that
made C4 flaky** — that audit is unstarted, flagged here rather than done
speculatively.

**The policy, corrected:** there is no sanctioned "re-run it and see." A
runner failure is a real failure until proven otherwise by root-causing it —
the way C4 was here — never by a clean rerun, which proves nothing about a
race and everything about the absence of contention. The one honest
quarantine mechanism is `UNSAFE_FOR_PARALLEL` in `runVerifySuite.js`: a
script whose real-time dependence genuinely cannot be made deterministic gets
listed there and runs alone, serially, after the parallel pool drains — a
stated, auditable exception, not a shrug. It is empty today; all four
audited real-timer scripts either got fixed outright (C4) or were confirmed,
individually, not to need it.

---

## 8. What was deliberately not done

Per the brief's explicit "do NOT do these now" list, confirmed still correct
after this session's research:

- **Splitting `routes/ads.js`, `worker.js`, or the two flagged services.**
  §1-3 are plans; execution is future work, sequenced against whichever
  agents are active at the time (§6).
- **Restructuring `CLAUDE.md`'s existing content.** §4 is the inventory and
  rule-set for when that happens; nothing there was executed.
- **Adding `.gitattributes merge=union` anywhere.** Already correctly
  rejected in `CLAUDE.md` §5; this plan does not revisit it.
- **Implementing the file-ownership convention (§5) or the `CLAUDE.md`-bloat
  advisory checker (§4, item 4).** Both are proposals with a specific shape
  and a stated reason for the shape; building them is a natural next safe
  slice, not done here to keep this PR's footprint matched to what the brief
  asked executed now.
- **Landing, deleting, or investigating the three stale-uncommitted files or
  the eight orphaned branches** the two new detectors (§7) found in the real
  repo. Reported, not acted on, per explicit instruction.
- **Re-verifying every §1-3 line citation against each subsequent merge.**
  Three rebases landed during this session (§6); the surveys are pinned to
  the commit each section names, not continuously re-checked against trunk.
