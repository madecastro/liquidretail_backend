# CampaignRun stuck 'running' after full delivery — Ad-truth reconciliation fix

Owner-reported live incident: a run delivered all its ads and never
transitioned to a terminal status, so the operator saw a permanent spinner
and cancelled it. Measured against prod (Render one-off jobs, read-only,
base64-eval'd scripts — no live run touched, no mutation, no cancel/retry):

`run_1787263897396_ef1fcb32` — 9 ads ordered, **9 delivered** (every Ad
carries a `renderUrl`, `status:'draft'`). At the time it was first observed,
`CampaignRun.status` was still `'running'` and `lastHeartbeatAt` had gone
stale/null. By the time I queried it (some time later), the automatic reaper
(`worker.js reapOrphans`) had already stamped it `'failed'` — the operator's
manual cancel and the reaper's automatic timeout both point at the same
underlying gap, whichever fired first in the wild.

Real prod document (via a Render one-off job, `srv-d1vuktqli9vc73ft07ng`):
`lastHeartbeatAt: "2026-08-20T22:15:37.836Z"` (one beat, ~4 min after
`startedAt: 22:11:37`, then never again), `completedAt: 22:31:00.595Z`
(the reap), `succeeded: 0, mintedTotal: 0, total: 9`. The 9 Ads themselves
(`campaignRunIds` contains the run id — plural array field, not a singular
`campaignRunId`) all show `status:'draft'`, `renderRoute:'veo'`,
`renderStage:'done'`, with `updatedAt`/`renderStageAt` spread from
**22:32:51 to 22:38:50 — 1m51s to 7m50s AFTER the reap already fired.** The
work was never abandoned; it was still genuinely in flight (paid-for veo
submissions cooking behind the shared render pools) at the moment the
reaper judged the run dead on `updatedAt` staleness alone, and finished
moments later with nothing left to notice.

## Root cause

`CampaignRun.status` is written ONLY by process-local code:
`routes/ads.js`'s render loop stamps `'done'` exactly once, after its own
in-memory `Promise.all(pools...)` resolves; the reaper
(`worker.js reapOrphans` → `services/campaignRunGuards.js
buildStaleRunningReapUpdate`) stamps `'failed'` blindly on `updatedAt`
staleness, never inspecting a single Ad. **Nothing ever re-derives
`CampaignRun.status` from the Ads the run actually claimed.** Two other
paths — `titlingResumeService.resumeUntitledMasters`,
`bootRecoveryService.resumeInFlightAds` — can drive an Ad all the way to
its terminal `draft`+`renderUrl` shape (recovering a receipted,
already-billed submission after the original process died, e.g. an instance
restart) without ever touching the owning `CampaignRun` row: no counter
`$inc`, no heartbeat, no `done` write. So a run whose original process died
mid-render can sit `'running'` forever even after every claimed Ad is
genuinely delivered — and the reaper's blind `updatedAt`-only staleness
check has no way to tell "abandoned" from "still cooking, just quiet on
this one row."

Same root cause explains the already-observed sibling in the other
direction: a run stamped `'failed'` with a stale `succeeded:18` while all
39 of its claimed Ads already carried a `renderUrl` — the reaper's blind
write never looked at the Ads either, so the counters it left behind were
just whatever they happened to be at reap time, not the truth.

Traced with Grok CLI (`grok-4.6`, `--effort high`, read-only sandbox,
fanned across the schema/heartbeat/reaper/completion-path/verify-script
questions in parallel) then independently verified file:line against the
real current source before anything was acted on.

## The fix

`services/campaignRunGuards.js` gained two pure, exported functions:

- `classifyRunAdOutcome(adDocs)` — given the REAL `Ad.find({ campaignRunIds:
  runId })` rows a run claimed, returns `{ succeeded, failed, stillRendering,
  requeuedAway, isSettled, needsRetry }`. `isSettled` is false while ANY
  claimed Ad is still `'rendering'` (a receipt-holding Ad is deliberately
  never requeued by the Ad-sweep, `services/spendReceipt.js`, so it can
  finish for free — `stillRendering > 0` means real paid-for work is still
  outstanding, not abandoned). `needsRetry` is true only if some claimed Ad
  was genuinely reset to `'queued'` (lost work needing a fresh "Generate
  more").
- `buildRunReconciliationUpdate(outcome, {staleMin, now})` — the honest
  terminal write. `!needsRetry` → `{$set:{status:'done', completedAt,
  succeeded, failed}}` with the REAL counts. `needsRetry` → delegates to
  the existing `buildStaleRunningReapUpdate` for the `'failed'` write +
  reaper `errors[]` explanation, layering the real counts on top rather
  than re-deriving the message a second way.

Deliberately a SEPARATE function from `buildStaleRunningReapUpdate`, not an
extra parameter on it: that function's whole contract (pinned by
`scripts/verifyRunStatusTruthfulness.js` C1) is a BLIND write that must
never guess at counters. Here the counters are not a guess — they are
computed from verified Ad truth — so writing them is the fix, not a new
risk.

`worker.js reapOrphans()` now does `CampaignRun.find(buildStaleRunningFilter(
...))` (candidates) then, per candidate, `Ad.find({campaignRunIds:
candidate.runId})` → `classifyRunAdOutcome` → `buildRunReconciliationUpdate`
→ a status-guarded `updateOne`. A candidate with `!isSettled` is left
completely alone this tick (no write at all) — often it is simply waiting
behind a sibling run's share of the global `VEO_CONCURRENCY`/
`REMOTION_QUEUE_CONCURRENCY` pools, not stalled; the next tick
(`REAP_INTERVAL_MIN`, 5 min) re-checks. This replaced a single blind
`CampaignRun.updateMany(buildStaleRunningFilter(...),
buildStaleRunningReapUpdate(...))` — each candidate now needs its own
Ad-truth read before it can be judged, so a bulk write can't do it; the
candidate set is small by construction (0-2 rows per campaign, per
`buildActiveRunsFilter`'s own header) and this only runs on a 5-minute
background cadence, never a request path.

**Deliberately does NOT resurrect an already-`'failed'` run to `'done'`.**
`buildTerminalDoneFilter`'s `preparing|running`-only allow-list (the D3
invariant in `scripts/verifyRunAlertsAndDoneGuard.js`, unchanged) stays in
force — a `'failed'` run can have had its claimed Ads released and
re-claimed by a completely different run since, so "my claimed Ads look
terminal now" does not prove "my own claim on them succeeded." This means
the historical `run_1787263897396_ef1fcb32` document itself is **not**
corrected retroactively — same forward-only posture as the other
closed-off incidents in `session.d/KNOWN-OPEN.md`. This fix closes the
CLASS going forward: the next run in this exact shape gets reconciled to
`'done'` (or an honestly-counted `'failed'`) at the reaper's own periodic
tick, before it can ever sit wrong long enough for an operator to notice
and cancel it.

### Smaller, related fix

`services/campaignRunHeartbeat.js`'s ticker only wrote `lastHeartbeatAt` on
a `setInterval` tick (up to 60s after real work starts). A batch whose
claimed work settles inside that first window reads `lastHeartbeatAt: null`
for its ENTIRE life despite being genuinely alive throughout — exactly what
made the prod document above misleadingly show a single early beat then
nothing, even though the underlying veo submissions were legitimately still
running for another 20+ minutes. `startRunHeartbeat` now beats once
immediately (gated on the same `isWorking()` the interval uses) before the
first tick.

## Assessed, not fixed (per the task's own instruction — propose, don't
## unilaterally change concurrency)

`VEO_CONCURRENCY=12` / `REMOTION_QUEUE_CONCURRENCY=4` are global pools
shared across every concurrent run, not per-run. The healthy sibling run
running at the same time (`run_1787264867188_ed82a8e3`, 39 ads,
`delivered=8/39` at the time, `lastHeartbeatAt` ticking normally) was
plausibly holding some of that shared capacity while `ef1fcb32`'s 9 video
ads queued behind it — from `ef1fcb32`'s own render loop's perspective, its
ads may not have looked "actively submitted" yet, which is consistent with
its heartbeat's `isWorking()` gate reading false and the beat stopping
early even though the ads were absolutely going to run (and did).
Recommend a frontend/backend follow-up: distinguish "waiting for a shared
pool slot" from "working" from "genuinely stuck" in the run UI — today all
three read identically as a silent, unmoving progress bar. Not attempted
here; `VEO_CONCURRENCY`/`REMOTION_QUEUE_CONCURRENCY` are tuned against spend
and explicitly out of scope to change unilaterally.

## Verification

Could not reproduce end-to-end without spending (a billable E2E run was
already in flight concurrently in this same investigation window, per
explicit instruction not to touch it) — the realistic way to reproduce
requires a real veo submission racing a real reap tick, which is exactly
the kind of timing this fix targets and is not something to manufacture
live against prod.

Instead: **revert-proof BEHAVIOURAL harness**, extending
`scripts/verifyRunStatusTruthfulness.js` (14 → 24 checks, new section E)
and `scripts/verifyCampaignRunHeartbeat.js` (40 → 42 checks, new E8/E9) —
drives the real exported `classifyRunAdOutcome` / `buildRunReconciliationUpdate`
/ `startRunHeartbeat` functions directly, plus source-scoped checks that
`worker.js` actually wires them together (find → per-candidate Ad.find →
classify → reconcile → status-guarded updateOne, with the unsettled branch
provably writing nothing). Every new check was individually revert-proven:
reverted the relevant line/function in a scratch copy, watched the specific
named check go red, then restored the real fix and watched it go green
again (6 mutations against campaignRunGuards.js/worker.js, 2 against
campaignRunHeartbeat.js — see each file's revert-prove list for the exact
mutations and which check catches each one).

`npm test` (178/178) and `npm run lint` (clean, `no-undef` only) both pass
on the full suite, not just the new/touched scripts.

## Files touched

- `services/campaignRunGuards.js` — `classifyRunAdOutcome`,
  `buildRunReconciliationUpdate` (new, exported)
- `services/campaignRunHeartbeat.js` — leading beat in `startRunHeartbeat`
- `worker.js` — `reapOrphans()`'s running-reap sweep rewired to reconcile
  from Ad truth per candidate instead of a blind bulk update
- `scripts/verifyRunStatusTruthfulness.js` — new section E (10 checks),
  D4 updated for the new call shape
- `scripts/verifyCampaignRunHeartbeat.js` — new E8/E9 (leading beat), G2
  updated for the new `find()`-based call shape
- `docs/ALERTING.md` — new "CampaignRun terminal-status reconciliation
  (2026-08-20, follow-up)" section

Not touched: `VEO_CONCURRENCY`, `REMOTION_QUEUE_CONCURRENCY`,
`buildTerminalDoneFilter`'s allow-list, `routes/ads.js`'s render-loop
completion write itself (still the primary/happy-path completion
mechanism — this fix is the safety net for when that path never gets to
run).
