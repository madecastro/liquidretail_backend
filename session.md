# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-stderrtail-adgen`,
branch `fix/persist-child-stderr` off `origin/master`.)*

- **What this is.** Tonight 4/12 video ads on `run_1787579089058_b7efb329`
  failed with only `remotion child exited code=1 signal=none`. The child's
  real error was on `err.stderrTail` (`makeChildError`) and then thrown
  away: `Ad.renderError` is a strict mongoose subdocument and those two
  fields were undeclared, AND `renderer.js` processAd copied
  message/stage/code/at and never the tails. Schema half + forwarding half
  — either one alone is a no-op.
- **Fix.** Declare `stderrTail`/`stdoutTail` on `src/models/Ad.js`. Copy
  via `childTailsFrom()` at processAd, titlingResume terminal persist, OOM
  stamp, and noteRenderIssue. Persist-side clip 8 KiB stderr keep-start /
  2 KiB stdout keep-end; NULs stripped. processAd logs `stderrTail`; Slack
  video-fail puts it in `detail`. Backend gets the same schema + titling
  persist copy (same production DB).
- **Proof.** `scripts/verifyRenderErrorTails.js` — Ad-doc round-trip,
  in-process revert (stripped schema drops the payload), `makeChildError`
  → persist shape → schema set. Do not merge until the sibling backend PR
  is up; both must land.

---

## KNOWN-OPEN

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
