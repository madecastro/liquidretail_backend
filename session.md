# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-slackharness`,
branch `fix/slack-harness-plumbing` off `origin/master` @ `a99afb1`.)*

- **What this is.** Harness plumbing only. `verifyRendererSlackAlerts.js`
  went 4/34 red on healthy master after #19 (`childTailsFrom` in
  `notifyRenderFailure`). Production alerting was not broken. The A-tests
  extract function bodies via `new Function` and injected only `alerts`,
  so the new free name threw before `alerts.notifyAsync`.
- **Option (b), not (a).** Bare `require` of renderer.js is blocked:
  `config.js` `process.exit(1)` without `ADGEN_ROLE`+`MONGODB_URI`; the
  file exports only `{ run, shutdown }`; the graph pulls mongoose/Atlas/
  Slack; E6 forbids loading `alertService`. #13's recipe needed a
  production export (`uploadRenderAndStamp`) — not done here. Isolated
  `Module._compile` with a custom `require()`: stub `alertService` /
  config / db / Ad, load leaf `renderErrorFields` + `concurrency` for
  real, stub other relative requires as `{}`. Internals are re-exported
  only in the compiled copy.
- **ECONNREFUSED.** D6's in-memory `Ad.find` thrower. The function's
  catch logs `renderer[renderer-test]: … failed — ECONNREFUSED`. Not a
  live connection. D6 now captures that warn and asserts it.
- **Proof.** 34/34. A1–A4 assertions byte-identical vs origin/master.
  Mutation: hardcode static `level: 'error'` → A4 red (`'error' !==
  'fatal'`). Extra used `require('os')` inside `notifyRenderFailure` →
  still 34/34; extraction would have thrown. Reverted both. E6 still
  forbids `require(alertService)` / `require(services/renderer)`.
- **Suite after.** Same two expected reds as master:
  `verifyArchiveDigestRelease` E3/E14, `verifyRunFinalizesOnSettle_KNOWN_OPEN`.
- **Pushed.** PR against master. Do not merge.

---

## KNOWN-OPEN

- **`verifyRunFinalizesOnSettle_KNOWN_OPEN.js`** — still labelled expected-fail;
  `maybeFinalizeRun` is wired on this branch. Group A only replays the `$inc`.
- **`verifyArchiveDigestRelease.js` E3/E14** — self-diagnosed broken ported scans.
- **`verifyModelParity.js`** — red in some worktrees because sibling
  `liquidretail_backend/models/*` no longer call `mongoose.model(...)` in a
  shape the harness can extract. Also fails while a `node_modules` symlink
  is present (remove it before commit). Green in this worktree with
  `NODE_PATH` pointed at backend `node_modules`.
- **Orchestrator is not Phase 2.**
- **`titlingResumeService` / `bootRecoveryService` unwired** from adgen boot.
  Isolation leaves resume state; it does not start the sweeper.

---

## Adding an entry

Replace CURRENT STATE / KNOWN-OPEN in place. Do not grow a dated log in
this file.
