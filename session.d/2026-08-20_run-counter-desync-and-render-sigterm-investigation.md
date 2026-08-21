# 2026-08-20 — Run counter desync (root-caused + fixed) and the SIGTERM/render-resilience question (investigated, mostly not a code gap)

Two-part investigation from the owner: (1) a confirmed bug where `CampaignRun.succeeded`/
`failed` counters can permanently under-report real delivery, and (2) whether Render
replacing the web process mid-render (deploy, autoscale, OOM) is silently stranding paid
work.

## Problem 1 — counter desync: root-caused with production evidence, fixed, self-healing added

**Confirmed against prod (read-only query via a one-off Render job).** Both operator
`brian@egami.tv` runs the owner flagged are real:

```
run_1787262113973_52bc3d73: status:'failed', succeeded:18, failed:0, total:39
  → 39/39 linked Ads are status:'draft' with a renderUrl. 100% delivered, reported 46%.
run_1787264867188_ed82a8e3: status:'failed', succeeded:18, failed:0, total:39
  → 39/39 linked Ads are status:'draft' with a renderUrl. Same shape.
```

**Root cause, precisely.** `routes/ads.js` has no Mongoose transactions/sessions anywhere
near the render loop. Every terminal-outcome pairing is two independent, non-atomic
writes: `Ad.updateOne({...},{$set:{status:'draft',...}})` then a SEPARATE
`CampaignRun.updateOne({...},{$inc:{succeeded:1}})` a line or more later (video success:
`:3032-3047`; derive-only success: `:2594-2605`; static success: `services/renderService.js`
`persistStage` then `routes/ads.js:3201`). A crash between the two keeps the Ad write and
loses the counter increment — the exact desync the owner measured.

PR #272 (`9fb14705`, merged, already on `main`) added `classifyRunAdOutcome` /
`buildRunReconciliationUpdate` (`services/campaignRunGuards.js`) specifically for this
class of bug — its own header comment already names the incident shape
(`succeeded:18` stale while all 39 Ads carry a renderUrl). **But it is wired into only ONE
place**: `worker.js`'s `reapOrphans()`, gated on `CampaignRun.find({status:'running',
updatedAt:{$lt:...}})` — i.e. it only re-derives counters for a run that is STILL
`'running'` and has gone quiet for `REAP_STALE_MIN` (15m). The moment ANY writer stamps a
run `status:'failed'` without going through that helper, the run becomes invisible to
this fix forever (the reaper's own candidate filter requires `status:'running'`).

**The blind writer that actually produced the incident.** `services/processAlerts.js`
`persistOrphans()` — the SIGTERM handler, which fires on literally every deploy and every
autoscale replacement — used to do exactly this:

```js
CampaignRun.updateMany(
  { runId: { $in: s.runIds }, status: { $nin: ['done', 'failed'] } },
  { $set: { status: 'failed', completedAt: now }, $push: { errors: {...} } }
)
```

No read of the run's actual claimed Ads. Whatever `succeeded`/`failed` the per-ad `$inc`
sites happened to have reached at that instant is what got frozen in, forever, because
'failed' is outside the reaper's `'running'`-only filter. `heartbeat+15m ≈ completedAt`
on both measured incident runs also points at a second, related path: the worker's
OWN (now-fixed) reaper can correctly compute `needsRetry` (some claimed Ad genuinely
reset to `'queued'`) at the moment it ticks, stamp `'failed'` with an honest count for
THAT moment — and then `services/strandedRunSweeper.js` later successfully re-renders
those "lost" ads (it exists specifically to drain `queued` + `renderStage` rows whose
owning run went `'failed'`). `strandedRunSweeper` fixes the Ad; it never touches the
CampaignRun row it came from. Either mechanism (or both, across the two measured runs)
produces the identical persisted shape, and neither is healed by anything today.

**Fix shipped (this PR), two parts:**

1. **`services/processAlerts.js` `persistOrphans`** — no longer blind-stamps. The Ad
   requeue is now `await`ed FIRST (previously raced beside the CampaignRun write inside
   one `Promise.all`), then each of this process's still-open runs is read via
   `Ad.find({campaignRunIds})`, classified with `classifyRunAdOutcome`, and finalized with
   `buildRunReconciliationUpdate` (both reused from `services/campaignRunGuards.js`,
   unchanged) — 'done' with real counts if every claimed Ad settled, 'failed' with real
   counts if something was genuinely lost to `'queued'`, or left untouched (still
   `'running'`/`'preparing'`) if a receipt-holding Ad is still genuinely `'rendering'` (the
   same money guard the requeue above already honors — don't finalize a run while paid-for
   work is still outstanding). A per-run `errors[]` note is still pushed either way, so the
   SIGTERM audit trail this handler exists for is unchanged.

2. **The general safety net — `services/campaignRunGuards.js` `buildRecentlyFailedFilter`
   + a second pass in `worker.js` `reapOrphans()`.** Rather than chase every individual
   blind-stamp call site (there are at least two more: `routes/ads.js`'s two crash
   handlers, unpatched — see below), the SAME classify/reconcile pass now also re-checks
   `status:'failed'` runs whose `completedAt` is within `FAILED_RUN_RECONCILE_WINDOW_MIN`
   (default 180m, env-overridable) on the worker's existing 5-minute cadence. If the
   recomputed counters/status differ from what's stored, it writes the correction (CAS'd
   on `status:'failed'` at write time); if they already match, it's a no-op (no spurious
   `completedAt` churn). This is what actually **heals** the two already-broken production
   runs once this deploys and the worker ticks — no manual backfill needed — and it also
   covers the `routes/ads.js` crash-handler paths I deliberately did NOT patch directly
   (see "Not fixed" below): whatever stamps a run `'failed'` blind, this pass revisits it
   within 3 hours and fixes the numbers.

**Deliberately not patched directly:** `routes/ads.js` has two more `status:'failed'`
writers that don't recount (`~:908` superseded-by-concurrent-run — fires ONLY pre-claim,
zero Ads ever claimed, nothing to recount, not a bug; and `~:1655` the queued-drain
run-crash handler ("runs-drain" stage) — this one CAN have real claimed Ads and is the
same shape as `persistOrphans`). I left `:1655` alone rather than patching a third call
site with a near-duplicate of the same logic, because the new general sweep (part 2
above) already heals whatever it produces within the reconcile window. If a future
session wants belt-and-suspenders correctness at the moment of write there too, the
pattern to copy is exactly what `persistOrphans` now does.

**Argued: should `succeeded`/`failed` be independently-incremented counters at all, or
derived on read?** Kept as counters, not switched to derive-on-read. Recomputing from
`Ad.find` on every `GET /api/ads/runs/:runId` poll would add an O(claimed-ads) read to a
route the frontend polls repeatedly for every run an operator has open — real cost with no
correctness upside once the write side is fixed, since GET already returns
`run.succeeded`/`run.failed` verbatim; once those are correct in the DB, GET is correct for
free. The actual defect was never "counters exist" — it was that ONE terminal-write call
site (`persistOrphans`) could move a run to a terminal status without ever having looked at
its Ads, and that terminal status then permanently excluded the run from the one
reconciliation path that existed. The fix is: every path that can finalize a run either
already has trustworthy counts (the normal in-loop completion write does, because nothing
crashed) or must reconcile from Ad truth first — and now, as a second layer, anything that
still slips through gets re-checked and healed within `FAILED_RUN_RECONCILE_WINDOW_MIN`.
That gets correctness without paying a live-recompute cost on every poll of every open run.

**Harness.** Extended `scripts/verifyRunStatusTruthfulness.js` (24 → 31 checks): new
sections F (`persistOrphans` reconciliation — F0-F3) and G (the general failed-run healing
pass — G1-G3). All source-scan + pure-function style, matching the file's existing
pattern (no live Mongo in this harness, same posture as its sections A-E). Revert-proven
by hand: reverted the three fix files to their `origin/main` content, reran the harness —
F1/F2/F3/G1/G2/G3 failed exactly as expected (25/31, all six new-check failures explained
by the missing fix), restored the fix, back to 31/31.

## Problem 2 — SIGTERM/render resilience: real churn confirmed, but NOT the incident the report first suspected, and NOT a code gap

**Render's own event log (the actual authority here, not app logs) fully explains both
incidents, and neither is what the original report guessed.**

- **23:05:09 triple SIGTERM — confirmed to be Nick's deploys, exactly as he corrected in
  the task.** Deploy `dep-da3oek5j96uc73eb34kg` (created 23:01:37, finished 23:04:10)
  booted three new instances (`npm82`/`kn6dd`/`rxfn7`) at 23:04:00-08; ~1 minute later, at
  23:05:09, the THREE instances from the PREVIOUS deploy (`x57pl`/`6c2p7`/`dmslv`, itself
  from `dep-da3oehrncjis738m0bt0`, finished 23:02:50) all logged
  `🛑 SIGTERM received`. This is Render's normal rolling-deploy drain, not autoscale, not
  OOM. `autoscaling` events show nothing at 23:05:09.

- **22:45:45 single SIGTERM — genuinely NOT a deploy (no deploy in that window,
  confirmed: prior deploy finished 19:51:16, next one started 23:01:27) — but it is ALSO
  not the "resource exhaustion → process replacement" failure mode the config comment
  predicts.** Render's own `autoscaling_started`/`autoscaling_ended` events show a
  **scale-DOWN** 2→1 instances starting exactly at 22:44:45 (`currentCPU:17,
  currentMemory:363MB` — i.e. load had already dropped to near-zero), ending 22:45:00.
  The 22:45:45 SIGTERM on instance `j7brk` is the tail of that scale-down: Render decided
  it didn't need the second instance and told it to drain. The app's own graceful-shutdown
  handler ran and logged `0 ad(s) in flight` (services/inFlight.js's tracked count was
  genuinely zero on that instance at that moment) — so this specific event was benign by
  timing, not by design.

- **A REAL OOM kill DID happen 6 minutes earlier, same instance.** Render's events API
  (`GET /v1/services/{id}/events`, NOT exposed by the CLI's `logs`/`deploys` subcommands —
  had to hit the REST API directly with the CLI's own key from `~/.render/cli.yaml`) shows
  `server_failed` / `reason.oomKilled: {memoryLimit:"8Gi"}` on instance `j7brk` at
  **22:39:42**, which lines up with the "Instance j7brk restarted" banner seen in the app
  logs at 22:39:43 (a real container-level kill+restart, not a graceful SIGTERM — no
  "SIGTERM received" line precedes it, consistent with an actual SIGKILL from the kernel
  OOM killer with zero chance for the app's own shutdown handler to run or log anything).

- **OOM kills are RECURRING, not a one-off, and this is the real finding for this half of
  the task.** Counted across the evening from the same events API: `server_failed`
  /`oomKilled` at **21:51:43, 22:16:44, 22:39:42, 22:58:51**, and — after the
  `REMOTION_QUEUE_CONCURRENCY` 4→8 raise deployed at 23:24:46 — again at **23:41:58**
  (instance `fw5dx`). That's roughly one genuine OOM kill every 20-45 minutes throughout
  the whole active period, both before and after the concurrency raise — so the one
  post-raise data point is NOT enough to blame the raise (the frequency looks the same as
  before it), but it's also not evidence the raise is safe; it's simply too little data
  either way from one evening. The service's own `autoscaling` config
  (`min:1, max:3, cpu:60%, memory:60%`) combined with rapid, repeated 1↔2↔3 instance
  churn (measured: 6+ scale events in under 90 minutes) is exactly the "RSS exhaustion →
  Render autoscale → process replacement" chain the `REMOTION_QUEUE_CONCURRENCY` config
  comment predicts — it is real and ongoing, just not the specific cause of either
  incident the owner flagged by timestamp.

**Why a mid-render OOM kill is NOT actually "silently stranded" today — recovery already
exists for both in-flight shapes, with bounded (not instant) latency:**

- **Shape A — mid-Omni submit/poll** (`Ad.status:'rendering'`, a real `veoPredictionId`
  receipt, no titled file yet). `services/processAlerts.js` `persistOrphans` deliberately
  does NOT requeue a receipt-holding row (see `services/spendReceipt.js` — requeuing would
  re-submit and double-bill). Recovery is `services/bootRecoveryService.js`, run from the
  **separate deployed worker service** (`srv-d8128c1o3t8c73e8kb30`, confirmed live,
  `npm run worker`, its own autoscaling `min:1 max:2` — verified via `render services`;
  this is a real second Render service, not a theoretical one) on boot + every
  `REAP_INTERVAL_MIN` (5m default). It does a FREE peek at the existing Atlas prediction
  (`resumeForAd`, explicitly "MUST NEVER SUBMIT") — if Atlas already finished, it stamps
  `draft` + the video URL + `titlingResumeState:'pending'`, no second Omni charge. Gated
  on `RESUME_STALE_MIN` (5m) keyed off the SAME heartbeat
  (`services/campaignRunHeartbeat.js`) that dies with the web process, so "stale" reliably
  means "the process is actually gone," not "still legitimately working."

- **Shape B — mid-Remotion-titling** (the literal scenario the config comment names: a
  paid master already landed, `status:'draft'`, `titlingResumeState:'claimed'`, and the
  Remotion render/upload that composites the burned-in title dies with the process).
  `services/titlingResumeService.js`, WEB-only (Remotion is warmed only in `index.js`; the
  worker never touches it), reclaims a `'claimed'` row once its `updatedAt` has been stale
  for `CLAIM_STALE_MIN` (15m — deliberately keyed off the same per-ad staleness signal, so
  it can't reclaim work a still-live process owns) and re-runs `renderBrandScriptAndSave`
  locally against the ALREADY-PAID master URL — no second Omni submit either. First tick
  is 90s after boot, but the claim only becomes reclaimable 15 minutes after the last
  write to that row, so recovery of this exact shape is bounded at roughly 15-20 minutes
  after a kill, not instant and not never.

**Bottom line for problem 2: the resilience the task asked "why doesn't this exist"
about already exists and already avoids double-billing** — both in-flight shapes are
recoverable, not silently and permanently stranded, with a 5-20 minute recovery latency
depending on shape. What's real and NOT yet addressed is the underlying OOM/autoscale
churn rate itself (every 20-45 min under load) — reducing THAT (e.g. moving Remotion
rendering out of the web process entirely, which the config comment's own "in the web
process" framing already flags as the structural reason a replacement is disruptive at
all) is a bigger architecture change than this investigation's scope, and is recorded here
as an open recommendation, not implemented. No code change was made for problem 2 — the
investigation itself, and confirming existing recovery mechanics are sound, is the
deliverable.

## Verification

`npm test` (`scripts/runVerifySuite.js`, full suite) and `npm run lint` — both run against
this branch before opening the PR; see the PR description for pass/fail counts. Revert-proof
of the new harness sections done by hand (see above) rather than only asserted.

## Files touched

- `services/processAlerts.js` — `persistOrphans` reconciles from Ad truth instead of a
  blind terminal stamp.
- `services/campaignRunGuards.js` — new exported `buildRecentlyFailedFilter`.
- `worker.js` — new `FAILED_RUN_RECONCILE_WINDOW_MIN` + a second `reapOrphans()` pass that
  heals recently-`'failed'` runs the same way the existing pass heals stale-`'running'`
  ones.
- `scripts/verifyRunStatusTruthfulness.js` — sections F (F0-F3) and G (G1-G3), 24 → 31
  checks.

Not touched, deliberately: `routes/ads.js`'s remaining blind `status:'failed'` writers
(see "Not fixed" above) — covered by the general healing pass instead of a third
near-duplicate patch.

## Addendum — adversarial review (two independent Grok passes) caught a real regression before commit

Both passes independently found the same MAJOR issue in the first draft of the
fix above: gating "leave the run alone" on a bare `!outcome.isSettled` (i.e.
any claimed Ad still receipt-holding + `rendering`) flattened the common MIXED
deploy shape — some claimed Ads still receipt-holding + `rendering`, OTHER
claimed Ads on the SAME run already genuinely lost to `queued` by the receipt-free
requeue a few lines above. `services/strandedRunSweeper.js` only drains that
queued/receipt-free tail once its OWNING run reads `status:'failed'`
(`findStranded`'s filter). The bare guard left the run `running` in that mixed
case — invisible to the sweeper AND still occupying `buildActiveRunsFilter`'s
concurrency gate — until every receipt-holding sibling separately resolved,
which can take from `bootRecoveryService`'s own staleness window up to the
full ~600s Omni poll ceiling.

**Fixed before commit**, in both new call sites (`services/processAlerts.js`
`persistOrphans`, `worker.js`'s new failed-run healing pass): the defer guard
is now `outcome.stillRendering > 0 && !outcome.needsRetry` — defer ONLY when
nothing has been lost yet AND something is still genuinely rendering. The
moment anything is genuinely lost (`needsRetry`), the run is finalized (failed,
with real counts) immediately, regardless of what else is still rendering —
that write never touches the still-rendering Ad's own status, so its free
recovery (`bootRecoveryService`/`titlingResumeService`) proceeds exactly as
before, just no longer gated behind an unrelated sibling.

Both reviews also flagged the harness sections (F/G) as individually weaker
than section E's own pins — comment-foolable regexes, whole-file call counts
instead of loop-scoped ones, a fixed-span slice, and a negative assertion that
only banned one exact spelling of the old blind stamp. All of these were
tightened in the same pass: F1/F3 now scan comment-stripped source and ban the
`$set` operator entirely (not one spelling) inside the defer branch; G2/G3 now
scope their assertions to the failed-loop's own body (bounded at the next real
statement, not a magic char count) instead of counting across the whole file;
G3 additionally asserts no write precedes the guard, mirroring E10. Both fixes
were revert-proven by hand a second time (mutating the guard back to the bare
`!outcome.isSettled` shape and confirming F3/G3 fail with the expected
messages) before restoring and re-confirming 31/31.

Two additional lower-severity findings from one of the two reviews, deliberately
NOT fixed in this PR (documented so a future session doesn't have to
re-discover them):

1. **A narrow race window**: `persistOrphans` now does an absolute `$set` of
   `succeeded`/`failed` from a point-in-time Ad snapshot, while the SAME
   process's OTHER still-resolving render promises (within the ~2.5-3.5s
   SIGTERM flush window) could independently complete their own Ad write +
   `$inc` afterward, landing on top of the just-corrected counters (a possible
   small, transient overcount — never an undercount, and never past what the
   NEXT worker healer tick, within `FAILED_RUN_RECONCILE_WINDOW_MIN`,
   re-derives and corrects). The old code never `$set` counters at all, so it
   could not overcount this way, but it also never corrected anything. Not
   fixed here; the general safety net (worker's recently-failed healing pass)
   self-heals any such transient drift within its next tick regardless, which
   is judged sufficient mitigation given the narrowness of the window. A full
   fix would mean gating every existing `$inc { succeeded | failed }` call
   site in `routes/ads.js` on `status:'running'` (CAS), which is a materially
   larger, separate change.
2. **Whether `classifyRunAdOutcome`'s `queued` → `requeuedAway` mapping is too
   broad** — a claimed-but-never-selected mint leftover (a run legitimately
   mints more Ads than it claims, per the existing `queued` leftovers
   architecture) could in principle also read `status:'queued'` and get
   miscounted as "lost" rather than "never this run's to claim". This is a
   pre-existing property of `classifyRunAdOutcome` as shipped by PR #272 (used
   unchanged here, not introduced by this PR), reused at two new call sites
   rather than one. Not investigated further or fixed here — it needs its own
   dedicated verification of the mint-vs-claim population before touching a
   function three other call sites already depend on.
