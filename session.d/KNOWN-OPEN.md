# Known-open items (curated, not a dated log entry)

Living checklist. Update in place; do not append a duplicate list elsewhere.

- Video multi-surface fan-out (§00 Phase 3) — intent only.
- `RENDER_AUTH_TOKEN` logs `EXPIRED` at every boot (dead `renderViaSpec` path).
- `npm error could not determine executable to run` during postinstall — non-fatal.
- Dead HTML/canvas paths read `author_name` with no re-gate (`aiCanvasSpecService`,
  `layoutResolverService`, `aiCanvasInputBuilder`) — commented, NOT fixed.
- Reels 204 vs Stories 250 safe zones collapse into one `vertical` entry in
  `remotion/lib/safeZones.js`.
- The 9 pre-existing stranded ads in `run_1787136860887_654ed621` (the real,
  measured proof case for the undispatched-tail fix — see
  `session.d/2026-08-19_undispatched-tail-fix-stranded-ads-close-the-loop.md`)
  still sit `queued` with no `renderStage` — the CODE fix only prevents this
  happening to FUTURE reap/SIGTERM/crash events, it does not retroactively
  touch rows already written before it existed. A one-time backfill script
  (stamps the identical breadcrumb the fix would have written, via the same
  `buildRequeueSetStage`, dry-run verified against the real 9 documents) is
  ready but was **not applied** — the session's own write attempt was blocked
  by the Claude Code permission classifier (a live production DB write).
  Someone with write access needs to either run that script (ask the session
  that wrote it, or re-derive: filter on `campaignRunIds` containing the run,
  `status:'queued'`, `wasRendering:true`, `renderStage` empty, both attempt
  counters 0) or simply press **Generate more** on the campaign, which drains
  them today regardless of this fix.
- Root cause of why THIS SPECIFIC run's CampaignRun heartbeat stopped ticking
  at 11:04:32Z, 17 minutes before the 11:21:43Z reap, was not pinned to one
  line. Render logs for the window show **three separate web-instance
  boots/restarts** (11:02:12, 11:04:42, plus a platform-logged "Instance
  restarted" at 11:05:33) — consistent with an ordinary instance replacement
  killing the process holding the heartbeat ticker, NOT a logic bug in
  `isWorking()`. But the render loop's OWN `Promise.all` demonstrably kept
  producing completions in the SAME run for another ~30 minutes after that
  (renderStageAt timestamps up to 11:34:28Z on the 12 ads that did succeed),
  which is odd if the original process were truly gone — most likely explained
  by `bootRecoveryService` recovering the two receipted masters in a
  replacement process and separately-dispatched derive ads completing behind
  them, not literally the same in-memory pool surviving the restart. Not
  reconciled to a single timeline with certainty; if a similar-shaped incident
  recurs with NO instance-replacement log evidence, that would be the signal
  this explanation is incomplete and the heartbeat mechanism itself needs a
  second look.

---

