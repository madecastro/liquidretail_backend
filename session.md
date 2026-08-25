# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-safezonekey-adgen`,
branch `fix/wire-safezonekey-titling-adgen`, built ON TOP OF the open
`port/backend-307-titling-band-geometry` branch (PR #54, itself open/unmerged
— this branch must land AFTER #54, not instead of it). PR open, NOT merged.)*

- **What this is.** PR #54 ported backend #307's surface-aware titling band
  geometry (`bandsFor(safeZoneKey)` etc.) faithfully — including the gap that
  made it inert on backend too: nothing on adgen's side ever computed a
  `safeZoneKey` to hand it. Both `renderTitles({...})` call sites in
  `src/services/brandScriptExecutor.js` had `platformFormat` in scope and
  never derived `safeZoneKey` from it, so `bandsFor` always fell back to the
  pre-#307 literal on every real render. Fixed with `resolveSafeZoneKeyCjs`
  (`src/services/plateIntelService.js`, mirrors `src/remotion/lib/
  safeZones.js`'s `resolveSafeZoneKey` the same way `SURFACE_INSETS` already
  mirrors `SAFE_ZONES`), called once in `brandScriptExecutor.js` and forwarded
  to both call sites. New harness groups I/J/K in
  `scripts/verifyKeepOutBandGeometry.mjs` (this port's own groups run A-H)
  are the regression check that would have caught the gap; mutation-proven
  (3 mutations, each red then restored green). `scripts/vendor-manifest.json`
  reasons updated for both touched files. Full write-up:
  `session.d/2026-08-24_wire-safezonekey-titling.md`. Companion fix, same
  day: `liquidretail_backend`'s own PR for the identical gap.
- **Suite: 40/43 passed.** Identical to the PR #54 branch tip BEFORE this
  change (confirmed via `git stash` bisection) — no new failures introduced.
  - `verifyRunFinalizesOnSettle_KNOWN_OPEN.js` — documented expected-fail.
  - `verifyModelParity.js` / `verifyVendorDrift.js` — both pre-existing on
    the PR #54 branch tip, unrelated to files this change touches (drift is
    against `adVisionQcService.js` / `directImageRenderService.js` /
    `imageRecoveryService.js`, a known ongoing backend-sync gap flagged by
    prior sessions, not introduced or worsened here).
- **Not landed.** PR open, NOT merged — must land after (or alongside, not
  instead of) PR #54.

---

## KNOWN-OPEN

- **Director-side reservation gate widening (`aiCreativeDirectorService.js`
  PROOF PRESENCE comment, correction 1) — owner decision, not started, now
  RIPE.** Both residuals it names are closed (PR #42 and PR #41, both
  MERGED as of this writing) — the comment says widening the gate to
  COMPEL a proof-led concept for a quote-only product "is very likely the
  right call", but that call itself still has not been put to the owner.
  `scripts/verifyProofReservationGate.js`'s D3 tripwire will not flag it
  automatically (both landed fixes are data-conditional, not blanket
  grants) — whoever picks this up should re-read that file's own
  instructions before touching the gate. Untouched by this PR (out of
  scope — this PR is build infra only).
- **`verifyVendorDrift.js` is currently RED on `origin/master`** (not
  allowlisted, not caused by this PR) — 12 vendored files drifted vs the
  sibling backend (`ba99a59f` / #329) since the manifest's last recorded
  look (`b7b8cae6`). Needs a human to look at each file and either port the
  backend change or re-attest with `node scripts/verifyVendorDrift.js
  --reconcile <path> --reason "…"`. Listed files (2026-08-24):
  `services/adVisionQcService.js`, `aiVideoPosterService.js`,
  `atlasVideoService.js`, `basePlateCropService.js`,
  `brandEnrichmentService.js`, `directImageRenderService.js`,
  `imageRecoveryService.js`, `judgeService.js`, `layoutInputService.js`,
  `overlayZoneService.js`, `plateIntelService.js`, `textEmbeddingService.js`.
- **`renderer.js` split (static vs. video render service) — owner
  decision, not started.** 1747 lines, touched by 13/38 recent merges (a
  third). Natural seam is render-route: `renderStatic` (~169 lines) vs.
  `renderVideo` (~398 lines, itself covering three sub-paths: master/
  derive/titling) share almost nothing except claim/release/
  bumpRunCounter/heartbeat primitives and module-level state (`inFlight`,
  `runInflight`/`runHeartbeats`/`runDocIdCache`). A split would extract
  those two into their own files and leave `renderer.js` as the thin
  poll/claim/dispatch/heartbeat core — see this session's final report for
  the full writeup. `processAd`'s shared catch block already has one
  video-specific carve-out inline (`err.unsettledAtTimeout`), so "thin
  dispatcher" isn't 100% clean today; a split needs to decide where that
  moves.
- **GitHub merge queue — needs repo-admin action, not done.** `master` has
  no branch protection (confirmed via API, 404). Org plan is `team`, which
  supports merge queue on a private repo. To enable: Settings → Branches →
  add a protection rule for `master` with at least one required status
  check (e.g. the existing `ci` job), then check "Require merge queue".
  This is a standing, repo-wide config change — deliberately not done by
  this session; the auto-rebase workflow (above) is the no-admin-needed
  alternative shipped instead.
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
