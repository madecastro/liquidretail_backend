# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-port-creative`.)*

- **Branch:** `port/creative-fixes-to-adgen` based on `origin/master` @ `0143f7c`
  (`fix(memory): Remotion titling OOM-killed an 8 GiB box at concurrency 4 (#5)`).
  Not pushed. Do not merge or deploy until the owner reviews the diff.
- **This session:** ported backend `fix/attribution-viability` (PR #318) into
  adgen. `usableAttribution` + `letterCount` live in
  `src/services/quoteProvenance.js` and are imported by both render paths.
  Without this port the backend-only fix is inert for every newly generated ad
  (`ADGEN_RENDERER_ENABLED=true`).
- **Call sites (matched backend before the patch, then wired identically):**
  - Video: `src/services/brandScriptExecutor.js` `buildMetaForAd`
    `reviewer: usableAttribution(cascaded.reviewer) ?? null`
  - Static: `src/services/directImageRenderService.js` `buildIntentData`
    `attribution: quoteText ? (usableAttribution(quote?.author_name) ?? undefined) : undefined`
- **Harness:** `scripts/verifyAttributionViability.js` (52 checks, offline).
  Paths adapted `services/` → `src/services/`.
- **Suite:** baseline 10/14 (new harness not yet present) → after 11/15.
  Same four reds as on a clean worktree: two `*_KNOWN_OPEN.js`,
  `verifyArchiveDigestRelease`, `verifyModelParity`. Do not weaken them.

---

## KNOWN-OPEN

- **`verifyCampaignRunHeartbeatWired_KNOWN_OPEN.js`** — expected red.
  `startRunHeartbeat` has no call site in `src/`.
- **`verifyRunFinalizesOnSettle_KNOWN_OPEN.js`** — file still labelled
  expected-fail; `maybeFinalizeRun` has since been added. Group A only
  replays the `$inc` half of `bumpRunCounter`.
- **`verifyArchiveDigestRelease.js` / `verifyModelParity.js`** — red at
  baseline on a clean worktree. Model-parity additionally fails while a
  `node_modules` symlink is present (remove it before commit).
- **Orchestrator is not Phase 2.** Do not assume it expands or claims.
- **Vendoring lag.** A backend fix is not live here until ported.
- **`../config` from `src/services` is the FILE `src/config.js`**, not the
  directory `config/`. Rewrite requires when porting backend services.

---

## Adding an entry

Replace CURRENT STATE / KNOWN-OPEN in place. Do not grow a dated log in
this file.
