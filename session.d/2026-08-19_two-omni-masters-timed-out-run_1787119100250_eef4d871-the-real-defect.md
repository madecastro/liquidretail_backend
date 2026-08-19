## 2026-08-19 — Two Omni masters timed out (run_1787119100250_eef4d871); the real defect
was write-off + no reconciliation, NOT the 600s cap. Branch `fix/video-master-reliability`.

**Escalation, not a routine bug report.** Both video masters in a mixed Meta+PMax run
(`meta_stories_9_16`, `pmax_video_16_9`) hit the 600s poll timeout. Every dependent derive/
funnel-variant failed with them (21 video Ads affected). Investigated live, not from logs
alone — queried Atlas directly with the project's own key (the global default key 404s on
these prediction ids) and pulled Render WEB logs for the exact window.

**Finding 1 — NOT a systemic Omni outage; it's real spend at real risk of being written off
for nothing.** Fresh Omni-only completion data, `google/gemini-omni-flash/image-to-video-
developer`, n=28 successful masters over the last 5 days (cross-referenced Render `"done
after Ns"` log lines against CostLog `providerRequestId→model`, since CostLog's own
`durationMs` on this stage is submit-latency only, not end-to-end — see the charge-point
comment in `atlasVideoService.js`): **p50=167s p90=199s p95=203s p99=215s max=215s.**
600s already carries ~2.8x headroom over the observed max — **raising the timeout number
would not have been evidence-based**, and masters-per-day over Aug 5–18 show only 2
timeouts in 175 masters (Aug 12) before this incident. **Decision: `MAX_POLL_MS` stays
600000 (unchanged).** The fix belongs in what happens ON timeout, not in a bigger number.

**Finding 2 — both predictions were STILL live at Atlas, well past 600s, when checked
directly.** `59e2b1b9...` (submitted 06:01:45 UTC): still `"processing"` 21+ minutes later.
`c584d847...` (submitted 06:08:59 UTC): still `"processing"` at 14 min, then on a SECOND
query minutes later its `created_at` had jumped forward 16 minutes and its status had
REGRESSED to `"created"` — consistent with an internal Atlas requeue/restart, not merely
slow inference. Neither settled during the investigation window. **This matters for the
fix shape**: a bigger synchronous poll budget would not have rescued either one (both were
already well past any reasonable cap when checked), and would have held a render/
concurrency slot open even longer — directly worsening Finding 4 below.

**Finding 3 — poll cadence is ~2-3x slower than configured, and it is NOT new to this
incident.** `POLL_INTERVAL=5000ms`+jitter implies ~6.5s between polls; the incident logged
37 polls across ~607-611s (~16.4s/poll), and a fresh 5-day sample of "done after" log lines
shows the same ratio (2-3 polls logged in the time slot a healthy cadence would produce
6-10). This is a real, pre-existing GET-latency characteristic of the poll loop (or the
path to Atlas), not something this incident introduced. **Not fixed here** — it's a
separate, lower-severity latency question (it does not change the 600s budget's ~2.8x
safety margin materially) and is called out for whoever tunes `POLL_INTERVAL` /
investigates Atlas/network latency next.

**Finding 4 — a related, DISTINCT stranding race, and a deliberate decision NOT to auto-fix
it.** Two `pmax_video_16_9` derive-only ads were left `status:'queued'` at
`deriveWaitAttempts` 1/30 ("waiting for master... attempt 1/30") after the run had already
closed `status:'done'`. Root cause: `renderDeriveOnlyVideoAd`'s in-render wait
(`DERIVE_MASTER_WAIT_MS`, 12 min) is a FIXED budget measured from when the DERIVE starts
waiting, not from when its sibling MASTER actually begins polling — and under concurrency
contention the master's real submission was measured ~8 minutes behind the derive's own
wait clock, so the derive gave up while the master was only ~4 minutes into its own (still
in-budget) poll. **This is a narrower variant of the ALREADY-DOCUMENTED "claimed-but-
undispatched tail" class in `CLAUDE.md` §1 (`run_1787105727540_e8c94542`, 2026-08-18) —
mine differs only in that these two rows DO carry a `renderStage` breadcrumb (they were
genuinely dispatched and waited, not skipped). The owner's existing directive for that
class is explicit: "Do not widen the sweeper to reach them — that is a money-adjacent
change." No new sweep was built here, in deference to that directive** — these are not a
money bug (derive-only ads never call Omni; `resolveDeriveFromMaster`'s fail-closed gate
is untouched) and will self-heal via `queuedArchiveSweeper` after `QUEUED_ARCHIVE_AFTER_H`
(24h) or an operator's next "Generate more". Flagged for an explicit owner decision on
whether `DERIVE_MASTER_WAIT_MS` should be coupled to `MAX_POLL_MS` (mirroring the existing
`REFRAME_CLAIM_TTL_MS` pattern) — NOT implemented here because the measured 8-minute
dispatch delay is not itself bounded by any constant, so a coupling would need its own
measurement pass to size correctly rather than a guessed slack.

### What shipped (PR, this branch)

**A. `atlasVideoService.js` — the poll timeout no longer writes anything off blind.**
`pollPrediction`'s deadline branch now does ONE final free `peekPrediction` before giving
up (extracted as the pure, directly-testable `resolveTimeoutOutcome`, mirroring
`submitRetryDecision`'s role for the submit-replay decision):
  - peek `done` → **return success** — rescues a render that settled right at the
    deadline instead of throwing it away unclassified.
  - peek `failed` → the SAME classified error shape the mid-poll branch already produces
    (extracted into `buildClassifiedFailureError`, shared by both branches so a caller
    cannot tell which one fired).
  - peek `processing`/`unknown` → **`err.unsettledAtTimeout = true`**, `chargeConfirmed`
    stays `null` (never coerced to a guessed non-charge). `mayRetryAfterFailure` already
    refuses to resubmit this shape (`policyRetryable` is undefined) — cannot reopen the
    double-charge the charge-point receipt exists to prevent.
  `peekPrediction`'s `done` branch now also returns the settled `price` (previously
  discarded), so a recovery caller can reconcile from the same free GET without a second
  round trip.

**B. `routes/ads.js` — an unsettled timeout is no longer written off as `'failed'`.** The
video-render catch block now checks `err.unsettledAtTimeout` BEFORE the generic failure
write. On that branch: **status is left untouched** (stays `'rendering'`, where the
charge-point already stamped `Ad.veoPredictionId`) so the existing periodic sweep
(`services/bootRecoveryService.resumeInFlightAds`, already run on an interval from
`worker.js`'s `recoverTick` — it was NOT boot-only, contrary to what an earlier stale
reading of this codebase assumed) keeps polling the same free GET until Atlas settles,
either recovering the asset for $0 or reconciling the ledger to a confirmed non-charge.
`CampaignRun.skipped` is incremented (not `failed`) — the outcome is deferred, not decided,
mirroring the derive-wait convention already in this file. Every OTHER failure path
(moderation, provider-fault-exhausted retries, etc.) is byte-for-byte unchanged.

**C. `bootRecoveryService.js` — the recovery paths now actually reconcile the ledger.**
Two real, pre-existing gaps closed (not new to this incident, but this incident's evidence
is what surfaced them):
  - The recovered-master (`done`) branch never called any cost reconcile at all — a $0
    recovery left the CostLog row at the submit-time ESTIMATE forever. Now calls
    `reconcileVideoCostFromTerminal` with the price now available from (A).
  - The recovered-`failed` branch hardcoded `confirmedCharge = true` unconditionally, with
    a comment claiming "peekPrediction does not read price back" — no longer true (and
    contradicted by CLAUDE.md §2's own measurement that 5/5 failed video predictions
    carry no price field). Extracted into `resolveRecoveredVideoFailureCharge` (tri-state:
    confirmed-unbilled → zero the ledger; confirmed-billed with a real price → correct to
    it; unknown → leave untouched, never guess).

**D. `campaignRunId` on CostLog — populated at the two highest-value write sites.**
`models/CostLog.js`: `campaignRunId` was typed `ObjectId ref CampaignRun` (implying the
Mongo `_id`) since it was added, while every producer holds the STRING `CampaignRun.runId`
(matches `Ad.campaignRunIds`) — so nobody ever populated it. **Confirmed safe to retype**:
0 non-null values across all 24,817 existing CostLog rows (and 878 `AiJudgeResultArtifact`
rows, same latent bug, not touched here — out of scope). Retyped to `String`. Threaded
through:
  - **Video**: `routes/ads.js` → `videoRouter.generateForAd` → `atlasVideoService.
    generateForAd` → the charge-point `recordFlatCost` call. (Downstream `finalizeFlatCost`/
    `reconcileCost` calls are UPDATEs keyed on `providerRequestId` — campaignRunId set at
    insert survives them; no need to repeat it.)
  - **Static image**: `directImageRenderService.renderDirectImage` already received both
    `campaignId` and `campaignRunId` as parameters (threaded for run-feed notices / app deep
    links) but never copied either into the CostLog `meta` object — one-line fix, no new
    plumbing needed.
  - **NOT done — explicitly out of scope, flagged for follow-up**: the LLM-call-site
    producers (Director, layout generator, judge, copy derivation, canvas spec, overlay
    polish, poster, embeddings — `trackLlmCall`/`recordCacheHit` call sites in
    `aiCreativeDirectorService.js`, `layoutInputService.js`, `aiJudgeService.js`,
    `copyDerivationService.js`, `aiCanvasSpecService.js`, `aiOverlayPolishService.js`,
    `aiVideoPosterService.js`, `atlasLlmService.js`/`atlasLlmStreamService.js`,
    `textEmbeddingService.js`, `aiImageReferenceService.js`) do not currently receive
    `campaignRunId` as a parameter at all — none of them, checked directly. Threading it
    through is a real, larger, separate refactor (new parameter across ~10 files and their
    callers in `campaignAdsGenerationService.js`), not attempted here given the money-
    critical scope of this change. `costTracker.persistCost` already accepts and stores
    `campaignRunId` generically (line ~290) — the only work left is each caller passing it.

**E. `services/costTracker.costForRun(campaignRunId)` + `scripts/costPerRun.js`.** A true
per-run cost aggregation from CostLog (split by `actual` vs `estimated` costSource, never
collapsed into one misleading number), replacing "reconstruct from a time window". Coverage
caveat stated in both the function doc and the script's own output: only rows written after
this fix carry `campaignRunId`, so a pre-2026-08-19 run's total is real but incomplete, not
a false zero.

### Verification

`scripts/verifyVideoTimeoutReconcile.js` — new, 27 checks, offline (no DB/network/key),
**calls the real exported functions** (`resolveTimeoutOutcome`, `mayRetryAfterFailure`,
`resolveRecoveredVideoFailureCharge`) rather than scanning source text for the money-
critical decisions, plus source-scan+revert-proof checks for the wiring (campaignRunId
threading, catch-block branch ordering). Revert-proven manually in addition to the
automated E6/F5 sub-checks: forcing `resolveTimeoutOutcome`'s unsettled branch to assert
`chargeConfirmed:false` instead of `null` fails A5/A6; restoring passes 27/27 again.
Full existing suite (153 `verify*.js` scripts) + `npm run lint` re-run against this branch —
see the PR for the actual pass/fail count at merge time.

**What was NOT verified**: no live Atlas call was made to test the fix (per the standing
rule — Omni is $1.20-1.80/product and this task explicitly forbade launching new billable
runs to test). The two real timed-out predictions from the incident were still unsettled
when last checked (06:26 UTC) — whether they ever complete, and whether `bootRecoveryService`
successfully recovers or reconciles them once deployed, is not something this session could
observe; check `costlogs` for `providerRequestId` in `["59e2b1b9bd304282a4ec7c80d9126d22",
"c584d847d6ed452a87787f54b89ecd0f"]` after deploy to see the real outcome.

