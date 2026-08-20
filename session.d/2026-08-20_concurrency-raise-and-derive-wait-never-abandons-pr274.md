## 2026-08-20 — VEO/Remotion concurrency raised; derive-wait timeout no longer abandons ads (PR #274, open)

Two owner-approved changes landed together because they interact: raising
concurrency makes the second problem fire more often, so they had to ship as
one PR.

### 1. Concurrency: `VEO_CONCURRENCY` 12→24, `REMOTION_QUEUE_CONCURRENCY` 4→8

Owner-approved 2026-08-20. `config/defaults.env` and `services/concurrency.js`
comments rewritten in place (not appended) to record the new numbers and why:

- **VEO_CONCURRENCY** is submit+poll only since the 2026-08-05 split — an Omni
  poll is ~2min of idle waiting (measured p50 117s / p99 247s), no Omni 429 has
  ever been recorded, and Grok (the aspect-fallback model) stays ≤1 RPS via its
  own `pacedModelSubmit` + `GROK_MAX_RPS` floor regardless of this knob. 24 is
  low-risk for that reason.
- **REMOTION_QUEUE_CONCURRENCY** went to 8, not the 16 originally floated. The
  existing comment on this knob is explicit that 4 "is the only concurrency this
  process has actually survived" and is **not an RSS measurement** — the failure
  mode is RSS exhaustion → Render autoscale → process replacement → a **paid**
  Omni master stranded mid-titling (~$1.00 each). 8 is one doubling; it needs
  validation against the web-service memory graph on a full run before any
  further raise.
- Both moved together deliberately: raising VEO alone without Remotion would
  make titling a strictly harder bottleneck (more masters land from submit+poll
  per wave, no extra titling slots to drain them) — which is exactly what
  motivated problem #2 below.

`scripts/verifyConcurrencyConfig.js` and `scripts/verifyTitlingPermit.js` (B2,
a stale hardcoded `=== 4` pin) updated to the new values — both stay hard pins,
not loosened to `>=`.

### 2. Derive-master wait timeout no longer abandons the ad

Owner's words: *"hitting the timeout shouldn't abandon, it should just send a
slack explaining the backup."*

**The old behavior.** `renderDeriveOnlyVideoAd` (`routes/ads.js`) waits
in-render up to `DERIVE_MASTER_WAIT_MS` (12 min) for a sibling master's plate.
When that wait expired with the master still `queued`/`rendering`, it requeued
the ad to `queued` — up to `MAX_DERIVE_WAIT_ATTEMPTS` (30) times — and on the
30th, stamped the ad `status:'failed'` ("refusing Omni fallback"). Raising the
concurrency above makes masters queue longer behind titling, so that terminal
fail would trip more often, on ads the owner actually ordered.

**The deeper finding** (via a Grok trace before writing the fix): the terminal
fail at cycle 30 was almost never the real abandonment — the FIRST polite
requeue already was, in practice. `services/strandedRunSweeper.js` only
auto-recovers ads whose `CampaignRun` is `status:'failed'`, but the run a
derive-wait ad backs out of normally finishes `done` (its other ads succeed
fine) — so a merely-requeued derivative sat `queued` invisibly until an
operator happened to press "Generate more" or the 24h archive sweep took it.
See `session.d/2026-08-19_two-omni-masters-timed-out-run_1787119100250_eef4d871-the-real-defect.md`
for a measured instance of exactly this (two `pmax_video_16_9` derives left
`queued` at `deriveWaitAttempts` 1/30 after their run closed `done`).

**The fix.** Extracted the timeout branch into `handleDeriveMasterBackup`
(exported by `routes/ads.js`, alongside a new `notifyDeriveWaitBackup`). Every
time the wait expires with the master still in flight, it now:

1. Requeues the ad to `queued` — unchanged, zero submits, zero bills, still
   `$inc deriveWaitAttempts` (never `renderAttempts` — that's what keeps
   `queuedArchiveSweeper`'s `renderAttempts:0` guard honest).
2. **Actively reclaims it right away** through the exact atomic claim path
   stranded ads use — `requeueStrandedAds()` → `claimAdsForRun()` — rather than
   hoping an operator or a crash-triggered sweep notices. This closes the real
   gap found above: the ad no longer depends on its run going `failed` to be
   auto-recovered. `requeue` is an injectable param (default = the real
   `requeueStrandedAds`) purely so the harness can assert the call shape
   without touching Mongo.
3. Fires **one Slack notice per backup episode** via `notifyDeriveWaitBackup`,
   keyed on the **master's `_id`** (not the ad, not the run) — every derivative
   ad backed up on the same master folds into one message via `alertService`'s
   own dedupe (`ALERT_DEDUPE_WINDOW_MIN`, default 15m), never one per ad, never
   one per poll. The message names the master, its status, how long this ad has
   waited (`ad.queuedAt`), and how many *other* ads are also waiting on the same
   master (`resolveDeriveFromMaster` re-run against a small product-scoped
   candidate set — reuses the real gate, not an approximation). A master sitting
   `rendering` with no heartbeat past `reapStaleMin()` (the same window the
   worker's own orphan reaper uses) is flagged as looking **STUCK** at `error`
   instead of `warn`, so a genuine stall still reads differently from ordinary
   congestion — the owner's explicit "must not become the new silent failure"
   requirement.

`MAX_DERIVE_WAIT_ATTEMPTS` (30) is still in the file but no longer bounds
anything toward failure — it only decides when the alert escalates from `warn`
to `error`.

Deliberately did **not** use `runFeed.noteEvent` for the Slack notice (the
`noteQcPassToRunFeed` pattern) — that bypasses `alertService`'s rate limiter
because per-ad QC passes are high-volume and belong in one run's thread. A
derive-wait backup is the opposite shape: low-volume, and does not belong to a
single run's thread (every reclaim mints a NEW `CampaignRun`, so no one run
"owns" the whole episode). The rate-limited alert channel, keyed on the master,
is the right home — see `notifyDeriveWaitBackup`'s doc comment in
`routes/ads.js` for the full reasoning.

**Verification.** New behavioural harness `scripts/verifyDeriveWaitBackup.js`
(17 checks): monkey-patches the real `Ad`/`CampaignRun` model statics (same
house style as `verifyStrandedSweep.js`), and proves the Slack "fires once per
episode" claim against the **real** `alertService` dedupe with a faked
`global.fetch` (same house style as `verifyAdVisionQc.js` group L) — not a
stubbed-away limiter. Revert-proved twice by hand: reintroducing the old
`status:'failed'` branch turns A2/A2b red (and `verifyPmaxVideoExpansion`'s new
G2d); re-keying the Slack alert on the ad instead of the master turns D1/D2 (and
G1) red. Both reverted back to green after confirming. Updated the neighboring
pins this touched: `verifyPmaxVideoExpansion` (G2 family — the old "exactly
twice" `deriveWaitAttempts` increment pin is now "exactly once, in the extracted
function"), `verifyArchiveDigestRelease` (E15d/E15e — the `PRE_DISPATCH`
exemption proof moved with the code), `services/adArchiveDigest.js`'s
`REQUEUE_SITES` ledger entry renamed to match.

`npm test` — 181/181 (full suite, run after rebasing onto `origin/main` at
`9fb14705` — #268/#271/#272 had merged since this branch started; clean
rebase, no conflicts with the other live sessions touching `routes/ads.js` /
`services/mediaAssignmentService.js`). `npm run lint` — clean.

Also touched `docs/PIPELINES.md`'s derive-only-video section with a short note
on the new never-abandon behavior (did **not** attempt to fix the much older,
pre-existing staleness in that file where several tables still say
`VEO_CONCURRENCY=4` / `REMOTION_QUEUE_CONCURRENCY=4` from 2026-08-02/03 —
out of scope for this change, flagged separately).

**Status:** PR #274 open, not self-merged (owner cross-checks money-adjacent
diffs line by line). Branch `fix/concurrency-and-derive-wait-backup`.
