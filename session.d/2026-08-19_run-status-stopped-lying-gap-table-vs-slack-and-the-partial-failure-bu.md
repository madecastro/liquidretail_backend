## 2026-08-19 — Run status stopped lying: gap table vs Slack, and the partial-failure bug that mattered most

Owner framing: *"Slack seems to know exactly what is going on, why aren't we using
that as a source of information?"* Backend branch `fix/run-status-truthfulness`
(this repo), frontend companion `fix/run-status-frontend-truthfulness` →
**`liquidretail` PR #56**. Full gap table + architecture decision now live in
`docs/ALERTING.md` §"In-app run status vs Slack" — read that before touching either
side of this again, do not re-derive the table.

**Architecture decision, one line:** `GET /api/ads/runs/:id` now calls the exact
same functions Slack's live feed already calls
(`services/adStage.js summarizeInFlightStages`,
`services/runFeedService.js summariseFailures`) instead of a second re-derivation —
so the app and Slack describe a run's stage/failures identically by construction.

**The defect that mattered most was found live, mid-review, on a real partially-
failed run (`run_1787119100250_eef4d871`, Vuori Clothing, 39 ads: 18 draft / 18
failed / 1 rendering / 2 queued at the moment of capture — a shared 9:16 Omni video
master timed out after 600s, its 17 derives then failed closed, a second PMax master
was still legitimately rendering):** the frontend's `POLL_TIMEOUT_MS` (10 min) fully
**stopped polling** and swapped the live progress card for a permanent "Timed out"
card — no bar, no percent, a frozen "18 of 39" that read as "18 failed" when it was
actually the success count. Fixed: polling no longer stops just because a run is
taking a while (a 6h abandoned-tab valve is the only ceiling now, and it's additive,
never a takeover); counts are always four explicit numbers (succeeded/skipped/
failed/still-rendering); the card shows the run's live stage aggregate and grouped
failure reasons (Slack's own groupings, reused verbatim); a truthful "no update in
Xm" hint reads the backend's real `lastHeartbeatAt`/`updatedAt` (PR #220's heartbeat)
instead of a client-invented timer.

Two smaller, previously-reported defects fixed in the same pass: the post-Generate
toast always said "0 creatives queued" (the 202 response's `total` is *always* 0 by
design — nothing was ever wrong with the number updating, it just never had a real
one to show); and the first-~60s empty state told the operator to re-run the wizard
they'd just run (now gated on `campaignRunId` presence).

**Also fixed, smaller but real:** two "run died with an empty `errors[]`" gaps —
`worker.js`'s running-reaper and the `POST /api/ads/runs` queued-drain crash handler
both used to stamp `status:'failed'` with zero explanation. Both now `$push` a real
`errors[]` entry (`services/campaignRunGuards.js buildStaleRunningReapUpdate` for the
first; mirrors the existing prep/render crash handler for the second).

**Verification.** Backend: `scripts/verifyRunStatusTruthfulness.js` (14 checks,
revert-proven on 4 distinct mutations: drop `stageBase` grouping, drop the reaper's
`$push`, remove `stages`/`failureSummary` from the response, remove the queued-drain
`$push`). Full suite still 143/144 (the 1 failure is the pre-existing
`verifyLogoSilhouette` native-`sharp` environmental gap, confirmed unrelated).
`npm run lint` clean on the whole worktree. Frontend: `tsc --noEmit` clean; browser-
verified against a **local mock server** reproducing the measured incident's exact
shape (not a live/new generation — none was triggered) at every point in the
lifecycle: preparing/empty, early running, the partial-failure state, a stale-
heartbeat state, and done. Screenshots confirmed the empty-state fix, the progress
bar/percent surviving alongside real failures, the explicit count breakdown, the
stage aggregate line, and the grouped failure headline naming the exact master
timeout + derive-skip reason.

**Not verified:** the toast wording fix (defect 1) was confirmed by direct code
read + `tsc` only — reproducing it in-browser would need mocking the full wizard
flow (campaign/product picker), which this session judged not worth the added mock
surface for a simple, low-risk string substitution. The `'preparing'`-lifecycle
silence gap (a run stuck before ever reaching `'running'`) is explicitly **not**
closed — see the gap table's "Partially addressed" row — because that lifecycle has
no liveness signal by design; Slack's watchdog is still the only thing that catches
it today.

**Known open, deliberately not touched this pass** (see the gap table for the full
list): vision-QC category scores/findings are still inspector-only, not on the run
poller or gallery cards; Director "payload didn't satisfy the round contract"
warnings are still Slack/console-only, never written to `CampaignRun`; a repeated
identical failure's `alertService` dedupe tally ("+N more since HH:MM") has no
in-app equivalent.
