# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-logosafe-adgen`,
branch `port/logo-safe-area-to-adgen` off `origin/master` @ `e1063d2`.)*

- **What this is.** Port of backend `fix/logo-safe-area` (`378d7b7d`) into
  adgen. The composited brand mark was pasted flush to the QC box
  (`left = right - logoW` against the un-inset edge). Vision QC is handed
  the same `safeBoxInDeliveredPx` numbers and treats on-the-line as a
  breach. Measured tonight: 14 of 21 static QC failures, two thirds, and
  19 of 21 were regenerated first. Adgen renders every NEW ad, so the
  backend fix was inert until this landed.
- **Where it pastes.** Same compositor as backend. `finishPlate` resizes
  via `logoResizeBox` + `fit:'inside'`, then
  `layers.push({ input: toPlace, top: place.top, left: place.left })` at
  `src/services/directImageRenderService.js:2155`. Inset is applied in
  `logoPlacementFor` (the function that produces `place`), not at the
  paste site. Square `logoResizeBox` and re-ink contrast untouched.
- **Re-anchors.** Harness requires `../src/services/*` (not
  `../services/*`). Q1/Q2 source scan is
  `src/services/directImageRenderService.js`. No new `require('../config')`
  from `src/services/` — the FILE vs DIRECTORY trap is unused here.
- **Proof.** `verifyLogoSafeBox` 55/55 across the same 6 live surfaces as
  backend (no harness-count delta). Mutation: `LOGO_INSET_FRAC=0` and
  `LOGO_INSET_PX_FLOOR=0` → 15 failed, right/bottom margins 0 on every
  surface (the exact defect). Restored. `verifyLogoColorPreservation`
  82/82, `verifyBrandConsistency` 24/24, `verifyRatingFurniture` 130/130,
  `verifyRequireGraph` 518/518, `verifyVendorDrift` 11/11. Suite after:
  26/28 — same two expected reds as master (`verifyArchiveDigestRelease`
  E3/E14, `verifyRunFinalizesOnSettle_KNOWN_OPEN`).
- **Landed.** adgen PR #23 (`20568ae`) and backend PR #327 merged
  together at 17:06Z. Do not re-open. Code on `origin/master` matches
  this worktree (inset + harness + vendor reason). This session.md
  commit is handoff only.

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
