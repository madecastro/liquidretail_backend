# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-remotion-sub`,
branch `perf/remotion-subprocess` = adgen PR #8, rebased onto `origin/master`
@ `62436f6` = #10 + #11 + #9 + #7.)*

- **Rebased in two hops.** Original fork point `0143f7c` (`#5`). First hop
  onto `98fe279` (`#9`) resolved the real `renderer.js` conflict (heartbeat
  OUTER, OOM try/catch INNER, both titling sites). Trunk then moved again
  (`397284f` #11 cap clamp, `62436f6` #10 attribution) during that hop;
  second hop onto current `origin/master` auto-merged `renderer.js` and
  `brandScriptExecutor.js`, conflicted only on this file.
- **`git diff origin/master HEAD --stat`** is only #8's files (supervisor,
  child script, brandScriptExecutor, remotionRenderService, renderer.js,
  titlingResumeService, isolation harness, this file). No re-application of
  #7/#9/#10/#11.
- **Nesting:** heartbeat `try/finally { beat.stop() }` is OUTER; OOM
  try/catch with early `return` is INNER. The OOM `return` still runs
  `beat.stop()`. Terminal `$set` `$in: ['rendering','draft']` (#7) and
  heartbeat cap/interval/`claimedByWorker` (#9, cap corrected by #11) were
  not rewritten by this PR.
- **D11** in `scripts/verifyRemotionChildIsolation.js` pins that the OOM
  early-return sits inside the heartbeat try whose finally stops the beat.
- **Pushed** `--force-with-lease` to `origin/perf/remotion-subprocess`. Not merged.

---

## KNOWN-OPEN

- **`verifyCampaignRunHeartbeatWired_KNOWN_OPEN.js`** — expected red.
  `startRunHeartbeat` has no call site in `src/`.
- **`verifyRunFinalizesOnSettle_KNOWN_OPEN.js`** — still labelled expected-fail;
  `maybeFinalizeRun` is wired on this branch. Group A only replays the `$inc`.
- **`verifyArchiveDigestRelease.js` E3/E14** — self-diagnosed broken ported scans.
- **`verifyModelParity.js`** — red in this worktree because sibling
  `liquidretail_backend/models/*` no longer call `mongoose.model(...)` in a
  shape the harness can extract. Also fails while a `node_modules` symlink
  is present (remove it before commit).
- **Orchestrator is not Phase 2.**
- **`titlingResumeService` / `bootRecoveryService` unwired** from adgen boot.
  Isolation leaves resume state; it does not start the sweeper.

---

## Adding an entry

Replace CURRENT STATE / KNOWN-OPEN in place. Do not grow a dated log in
this file.
