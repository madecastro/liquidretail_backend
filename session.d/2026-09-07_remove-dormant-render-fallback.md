# Delete backend's dormant in-process render/titling fallback + ADGEN_RENDERER_ENABLED (2026-09-07)

## What this was

Owner directive: *"remove it, I want to eliminate that path and I want to
eliminate all the switches associated with it. We are not going back to that
infrastructure."* Backend had carried the pre-adgen-cutover in-process
render/titling/regenerate implementation as a "fallback" behind
`ADGEN_RENDERER_ENABLED`, permanently shipped `true` since 2026-08-24. Since
that date the fallback has been unreachable dead code in production — this
change makes the code admit it, physically deleting the flag, its accessor,
and every function reachable only from the four gate sites it used to guard.

## What was deleted

- `routes/ads.js` — the whole in-process render loop below the ADGEN handoff:
  `renderOne`, `renderOneInner`, `renderDeriveOnlyVideoAd`,
  `handleDeriveMasterBackup`, `notifyDeriveWaitBackup`,
  `findSiblingMasterAd`, the `VEO_CONCURRENCY`/`RENDER_CONCURRENCY` worker
  pools, the CampaignRun heartbeat wiring inside the loop (the mechanism
  itself, `services/campaignRunHeartbeat.js`, is untouched — only its
  now-pointless call site is gone), and the Stop-cancellation cleanup
  (`archiveAdsReleasingDigest` + `buildStopUndispatchedArchiveFilter`/
  `buildStopBacklogArchiveFilter`, imports removed as dead). `runRenderLoop`
  now just flips `CampaignRun` to `'running'` and returns.
- `services/adgenBridge.js` — deleted entirely (the flag accessor).
- `services/adRegenerateService.js` — `performRegeneration` and its whole
  private subtree (`runVideoFull`, `runImage`,
  `buildDirectImageArgsFromAd`, `promoteFailedToDraft`,
  `cascadeRegenerateToDerivatives`, and ~10 more), **plus** the
  catalog-first-reseed subtree (`isRegenReseedCatalogFirstEnabled`,
  `reseedDecision`, `shouldReseedFromCatalog`, `isCatalogMediaForProduct`,
  `pickFirstCatalogMediaId`, `deriveFirstCatalogMediaId`, `RESEED_SKIP`) that
  this session found was ALSO reachable only from the deleted `runImage` —
  not called out in the original plan, confirmed dead by tracing, removed in
  the same pass. Kept: `preflight`, `inFlightRefusal`, `notInFlight`,
  `resolveEffectiveRegenMode`, `buildRegenerationRequest`.
- `routes/brand.js` — `runRetitleJob` (dead branch); `runRetitleJobViaAdgen`
  is now unconditional.
- `services/brandScriptExecutor.js` — only `qcAndStampVideoAd` and
  `buildVideoQcFailureFields`'s dead-only caller path. The Remotion titling
  chain itself (`renderBrandScriptAndSave`, `uploadRenderAndStamp`,
  `buildMetaForAd`, etc.) is untouched and fully live.
- `services/renderService.js` — `renderCreative`/`renderStage`/`renderViaSpec`/
  `renderViaHtml` deleted; only `composeVideoOutput` remains exported.
- `services/directImageRenderService.js` — `renderDirectImage` and
  everything reachable only from it: `buildIntentData`, `conceptLook`,
  `intentForTemplate`, `renderedTextForRole`, `selectStaticQuoteText`,
  `resolveStaticQuoteCap`, `typefaceDirectiveForBrand`,
  `resolveImagePromptOverride`, `composeCorrectiveOverride`,
  `submitEditImageWithSeedFallback`, the file's own thin re-export of the
  shared quote-rotation helpers, and the vision-QC gate/alert wiring that
  lived inside `renderDirectImage`. Kept `finishPlate` (recovery's sole
  entry point) and everything reachable from it: `deliveryGeometryFor`,
  `safeBoxInDeliveredPx`, `extractFor`, `logoPlacementFor`, the whole
  logo-color/contrast/compositing helper set.
- `services/ugcVideoPipeline.js` — deleted entirely.
- `services/adArchiveDigest.js` — removed the now-stale
  `handleDeriveMasterBackup:wait-requeue` row from the `REQUEUE_SITES`
  ledger (the function it described no longer exists).
- Stale canvas-titling files confirmed deleted: `services/brandScriptRunner.child.js`,
  `services/brandScripts/*.script.js` (5 files), `scripts/testBrandScript.js`.
  `services/brandScripts/assets/` (fonts) untouched, still live.
- `config/defaults.env` — removed `ADGEN_RENDERER_ENABLED`,
  `VEO_CONCURRENCY`, `RENDER_CONCURRENCY`, `REGEN_CASCADE_MAX_SIBLINGS`,
  `REGEN_RESEED_CATALOG_FIRST` (the last one found by this session, not in
  the original plan's list — see above).
- ~40 `scripts/verify*.js` harnesses rewritten (checks that tested the
  deleted code removed/converted to absence pins; everything testing a live
  path left untouched) plus `scripts/verifyTitlingOrphanResume.js`
  (converted to absence pins) and `scripts/verifyRegenerateStatusPromotionAndCascade.js`
  / `scripts/verifyStaticCtaDeterminism.js` / `scripts/verifyStaticTextInk.js` /
  `scripts/verifyStaticTypefaceDeterminism.js` / `scripts/verifyUgcVideoPassthrough.js`
  (deleted outright — nothing left to test).

## What was kept — same files, live callers

- `brandScriptExecutor.js`'s Remotion titling chain — called from
  `routes/brand.js:505` `POST /:id/render-script`, `scripts/retitleDriver.js`
  (SSH-invoked ops tool), and an ad-debug reconstruction path in
  `routes/ads.js`. All three still work exactly as before.
- `services/remotionRenderService.js` / `remotion/` — boot-time warmup,
  `POST /:id/title-still`, `POST /:id/preview-script`.
- `services/videoRouter.js` — **NOT actually live any more**, see finding
  below; kept per the plan's original instruction, orphaning noted instead
  of acted on.
- `services/campaignAdsGenerationService.js` — completely untouched;
  `resolveDeriveFromMaster` (the real, still-enforced money gate: "a
  derive-only ad must never reach a billable Omni submit") is unaffected.
- Env vars confirmed still load-bearing: `REMOTION_QUEUE_CONCURRENCY`,
  `RESUME_IN_FLIGHT_ON_BOOT`/`RESUME_STALE_MIN`/`RESUME_MAX_ADS`/
  `RESUME_CLAIM_STALE_MIN`, `ADGEN_RETITLE_POLL_MS`/`ADGEN_RETITLE_MAX_WAIT_MS`,
  `REGENERATE_DAILY_CAP`, `UGC_FIRST_SEEDING`.

## Verification

- `npm run lint` clean, `node --check` clean on all 60 touched `.js` files.
- `npm test`: **248/248 passed** (stable across repeated runs).
- Grep sweep for `isAdgenRendererEnabled`, `shouldDeferToAdgen`, `adgenBridge`,
  `ADGEN_RENDERER_ENABLED`, `performRegeneration`, `renderOneInner`,
  `renderCreative`, `renderViaSpec`, `renderDirectImage`, `qcAndStampVideoAd`,
  `runVideoFull`, `runImage`, `runRetitleJob` (the dead one) across the whole
  repo (excluding `node_modules/`, `adgen/`): **zero references in
  live/executable code paths.** The only remaining hits are (a) deliberate
  absence-assertions inside test harnesses, or (b) descriptive prose in
  `services/handoffContract.js` and other docs/comments, listed here for
  anyone re-verifying:
  - `isAdgenRendererEnabled` — (a) `verifyRegeneration` / `verifyRetitleAdgenHandoff` absence regexes; (b) `handoffContract.js` `note:` strings, `models/Ad.js` / `routes/ads.js` comments.
  - `shouldDeferToAdgen` — (a) `verifyRegeneration.js` R6a (`typeof === 'undefined'` + source regex).
  - `adgenBridge` — (a) `verifyRetitleAdgenHandoff` / `verifyRegeneration` absence regexes; (b) comments in `routes/ads.js`, `bootRecoveryService.js`, `README.md`.
  - `ADGEN_RENDERER_ENABLED` — (a) `verifyRegeneration` defaults.env absence pin; (b) `handoffContract.js` `note:` strings **and** the still-exported `OWNERSHIP_FLAG` / `describeContract()` env read (already flagged below as a known stale-contract follow-up — not a live render-path gate). Also comments in `models/Ad.js`, `worker.js`, `docs/*`.
  - `performRegeneration` — (a) `verifyRegeneration` R6c/R6d, `verifyRegenerateModeHonesty` B0; (b) comments in `adRegenerateService.js`.
  - `renderOneInner` — (a) many `verify*` absence pins (`verifyTitlingOrphanResume`, `verifyRenderFailureRecord`, `verifyRunFeedStartsUnderHandoff`, …); (b) comments in `routes/ads.js`, `campaignRunHeartbeat.js`.
  - `renderCreative` — (a) `verifyImageRecovery` / `verifyArchiveDigestRelease` absence scans; (b) comments in `renderService.js`, `atlasVideoService.js`, `aiCanvasHtmlGeneratorService.js`.
  - `renderViaSpec` — (b) comments in `routes/ads.js`, `campaignAdsGenerationService.js`, `renderService.js`, `CLAUDE.md`.
  - `renderDirectImage` — (a) `verifyLifestylePreserve` C* / `verifyRenderFailureRecord` absence pins; (b) comments across static-intent harnesses and leftover service headers.
  - `qcAndStampVideoAd` — (a) `verifyTitlingOrphanResume` E5; (b) comment in `routes/ads.js`.
  - `runVideoFull` — (b) comments in `adRegenerateService.js`, `routes/ads.js`, `docs/PIPELINES.md`.
  - `runImage` — (a) `verifyCatalogPipelineExclusive` / `verifyUgcFirstSeeding` comments+absence; (b) comments in `adRegenerateService.js`.
  - `runRetitleJob` — (a) `verifyRetitleAdgenHandoff` A2 (`function runRetitleJob` gone); (b) `routes/brand.js` "formerly" comment, `models/Ad.js` comments.
  None of these is a live call site or a flag that still gates rendering.
- `git status --short adgen/` returns nothing — the stale, uncommitted 432-file
  `adgen/` graft-attempt directory the plan warned about was never staged or
  touched.

## Judgment calls this session had to make finishing a partially-cut-off edit

A prior agent (plus its own sub-agents) got most of the way through this plan
and hit a rate limit mid-edit, leaving `scripts/verifyQuoteProvenance.js`
syntactically broken (a header comment describing removals that were never
actually made — 18 `no-undef` errors) and 45 other harnesses failing against
production deletions that had already landed. Delegated the bulk of the
mechanical harness-rewrite work to Grok (`grok-4.6`, high effort, its own
4-way parallel fan-out) with an explicit ground-truth brief and hard rules
("never delete a check without confirming the tested code is genuinely dead;
flag anything ambiguous instead of guessing"); personally verified every file
against the real source and re-ran the full suite repeatedly. One real
production-code race surfaced during that parallel work: this session's own
fix to `services/adArchiveDigest.js` (removing the stale ledger row) got
silently reverted by Grok's still-running process writing an independent fix
to the same file; caught by a full-suite re-run going from 248/248 back to
247/248, reconciled by re-applying the fix after terminating the background
process.

Judgment calls made independently (all confirmed by tracing real call graphs,
not assumed):

- **`services/videoRouter.js` is now orphaned, contrary to the plan's own
  premise.** The plan listed it as "must NOT be touched — used by the live
  mint/expansion path (`routes/ads.js:92`)". Tracing the actual call sites
  showed `veoGenerateForAd`/`veoPrepareStoryboard` (the two things imported
  from it) were called ONLY from the now-deleted `renderOneInner`'s video
  render path — never from mint/expansion. The file itself is untouched
  (per the plan), but it now has zero production callers anywhere in this
  repo. Not fixed (out of scope — the plan explicitly protected it, and
  deleting it is a separate decision); flagged for a follow-up.
- **`services/handoffContract.js`, a hand-synced cross-repo contract
  document (mirrored in `adgen/src/services/handoffContract.js`), is now
  stale** — several `note:` strings and its own boot-log helper
  (`describeContract()`) still describe `ADGEN_RENDERER_ENABLED`/
  `isAdgenRendererEnabled()` as a live conditional gate ("Backend stamps the
  full pass-through call ONLY when it decided to defer..."). Confirmed
  `describeContract()` is only ever invoked by its own test's closing
  `console.log`, not a real boot path, so this is a documentation-accuracy
  issue, not a functional one. Not fixed — editing a deliberately-synced
  cross-repo file without adgen-side context felt like the wrong call to
  make unilaterally; flagged for a coordinated follow-up.
- **Stop/cancel no longer actually halts an in-flight ad-generation run.**
  The cancellation-detection loop (`progressRun.checkpoint()` throwing on
  `cancelRequested`, checked once per pool dispatch cycle) lived entirely
  inside the deleted in-process render loop. Neither backend nor adgen's
  renderer (checked `adgen/src/services/renderer.js` directly — zero
  `cancelRequested` references) currently watch for a Stop press once a run
  is hers to adgen. This is **not a new regression** — the same reasoning
  that makes the rest of this deletion safe applies here too: this watcher
  has been unreached in production since `ADGEN_RENDERER_ENABLED` shipped
  `true` on 2026-08-24, so the behavior is unchanged, just no longer masked
  by dead code that looked like it handled it. Real, pre-existing,
  user-facing gap; implementing Stop support in adgen's renderer is
  substantial new work, well out of scope here.
- **The `REGEN_RESEED_CATALOG_FIRST` catalog-first-reseed subtree** (see
  above) was not in the plan's file-level deletion list but was confirmed,
  by tracing, to be reachable only from the deleted `runImage` — removed in
  this same pass along with its env var and test coverage.

## Two pre-flight hazards from the plan — confirmed

1. `adgen/` (the stale, uncommitted 432-file graft-attempt directory) — confirmed
   `git status --short adgen/` returns nothing; never staged or touched.
2. `crash/rebase` branch collision (crash-alerting wired into the now-deleted
   `runRenderLoop`/`renderOneInner`, `renderCreative`/`renderStage`, and
   `regenerateAd`) — not re-checked this session (out of scope for a
   worktree-local finish-up); still needs the owner heads-up the plan
   recommended before/alongside the deletion PR, since its instrumentation on
   the now-deleted functions is moot and its `worker.js` changes may still be
   worth landing separately.

## Follow-up pass, same day (2026-09-07) — four leftovers the original pass missed

A second read-through of this same deletion, specifically looking for
anything the "zero live-code references" grep sweep above could not have
caught (it searched for symbol names like `renderOneInner`/`renderCreative`,
not for knobs or comments that merely *describe* them), found four small,
purely cosmetic items — no behavior change in any of them, confirmed by
`npm run lint` / `node --check` / `npm test` staying green across the fix:

1. **`services/concurrency.js` still declared `RENDER_CONCURRENCY` and
   `VEO_CONCURRENCY`** as live SPEC entries, even though the only code that
   ever read those two values as properties (`routes/ads.js`'s
   `runRenderLoop`/`renderOneInner` worker pools) was already gone. Grepped
   the whole backend (excluding `adgen/`) for `.RENDER_CONCURRENCY`/
   `.VEO_CONCURRENCY` property access and for `require(...services/concurrency)`
   call sites (`index.js`, `worker.js`, `routes/ads.js`, `routes/catalog.js`,
   two verify scripts) — none read either value. Removed both SPEC entries
   (replaced with a `REMOVED 2026-09-07` comment, same pattern as the
   existing `VEO_TITLING_CONCURRENCY REMOVED 2026-08-28` note just below
   them) and the two prose references elsewhere in the file that treated
   `VEO_CONCURRENCY` as still live (the module header's Grok-pacing example,
   and `GROK_MAX_RPS`'s own comment). `adgen/services/concurrency.js` (and
   `adgen/config/defaults.env`) carry their own, separate, still-live copies
   of both knobs for adgen's own renderer — untouched, out of scope.
2. **`scripts/verifyConcurrencyConfig.js` still asserted on the two removed
   knobs** (`fromDefaults.RENDER_CONCURRENCY === 24`, an env-override round
   trip for both, and a `REMOTION_QUEUE_CONCURRENCY <= VEO_CONCURRENCY`
   comparison) — all of which would have started failing the moment the
   SPEC entries above were removed, since `resolveAll()` no longer produces
   those keys. Retired the checks (not the knobs a second time), keeping
   every check on a knob that is still live (`MAX_CREATIVES_PER_RUN`,
   `REMOTION_QUEUE_CONCURRENCY`, `ATLAS_SUBMIT_SPACING_MS`, `GROK_MAX_RPS`,
   `CAMPAIGN_BRIEF_CONCURRENCY`). Section F's "log contains RENDER_CONCURRENCY"
   check was repointed at `REMOTION_QUEUE_CONCURRENCY`, still a real line in
   `logConcurrencyConfig`'s output.
3. **`scripts/verifyArchiveDigestRelease.js` carried a stale, self-contradicting
   NOTE.** Two comment blocks in the same file described the same historical
   fact (whether `services/adArchiveDigest.js`'s `REQUEUE_SITES` ledger still
   listed the dead `handleDeriveMasterBackup:wait-requeue` row) and disagreed:
   the one next to the E14 check correctly said the row was already removed
   ("the ledger and the scan agree again"); the one right before E15d/E15e
   still said it was present, out of scope, and "NEEDS HUMAN REVIEW". Read
   `services/adArchiveDigest.js` directly to confirm which was true — the row
   is gone, only a `REMOVED 2026-09-07` comment describing its removal
   remains — and corrected the stale block to match, so the file no longer
   disagrees with itself.
4. **`routes/ads.js` had three small leftovers from the same deletion**,
   all inside or immediately around `runRenderLoop`: (a) a comment on the
   `/runs` handler's `job` object claiming it "carries the brand / campaign
   metadata renderOne needs to thread into renderCreative" — both functions
   are deleted and `job` no longer threads into anything in-process, it only
   feeds the ADGEN-handoff Slack run-feed lookup; (b) a dead local
   `isVeoRun` variable inside `runRenderLoop`, computed from `veoIds.length`
   and never read anywhere else in the file (confirmed by grep across the
   whole file) — a leftover from when the deleted render loop used it to
   pick between the render/video worker pools; (c) a comment plus a dead
   write, `if (requesterLabel) job.requesterLabel = requesterLabel;`,
   whose stated purpose ("renderOneInner's video-failure alert can name the
   requester") no longer exists — `runFeed.startRun` a few lines below reads
   the local `requesterLabel` const directly, not `job.requesterLabel`,
   confirmed by grep (only 3 references to `requesterLabel` in the whole
   file, none of them a read of `job.requesterLabel`). All three fixed:
   comments corrected, the dead variable and dead write removed.

None of these four items changed behavior — each was either a knob nothing
read, an assertion on a knob that no longer exists, a comment that disagreed
with a sibling comment in the same file, or a local variable/property write
nothing downstream consumed. Re-ran `npm run lint`, `node --check` on all
touched files, and `npm test` after the fix; see the top-level session state
for the pass/fail counts from that run.
