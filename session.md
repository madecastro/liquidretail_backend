# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-vendorgate`,
branch `feat/parallel-work-infra` off `origin/master` @ `904062e`. PR open
(see PR description for number), NOT merged — owner asked for a PR only,
no self-merge.)*

- **What this is.** Build infra to stop parallel work from falling behind
  trunk. Diagnosed problem: 38 merges/14h, median gap 12.5min — far under
  how long a real unit of work takes to build+verify. Three things landed:

  1. **`scripts/vendor-manifest.json` merge driver.** Confirmed generated
     (`scripts/lib/vendorDrift.js` `saveManifest`, written by
     `verifyVendorDrift.js --seed`/`--reconcile`) and the single most
     merge-conflicted path (9/38 merges) — git's textual 3-way merge
     collides on sorted-JSON-key proximity even when two branches' actual
     changes never overlap. `scripts/mergeVendorManifest.js` merges the
     `files` map at the KEY level instead, re-seeds anything newly vendored
     in the merged tree, and verifies (untracked/stale/dead must be empty)
     before writing — reusing vendorDrift.js's own primitives, no
     reimplementation. Live-tested with synthetic merges (disjoint-key:
     clean, with backend present and forced absent; same-key conflicting
     edit: fails loudly, JSON never corrupted). Setup is NOT automatic —
     `npm run setup:worktree` (→ `scripts/setupMergeDrivers.js`) must run
     once per clone/worktree; `.gitattributes` documents this. **Real
     finding, not fixed here:** the manifest's `generatedAt`/`backendHead`
     are a wall-clock timestamp + the sibling backend's live HEAD — neither
     is deterministic, though neither is read back by any pass/fail check
     either (confirmed by reading `loadManifest`), so it's safe but will
     always show churn.
  2. **Auto-rebase, not a merge queue.** `master` has NO branch protection
     today (confirmed via API — 404). Enabling GitHub's merge queue needs
     branch protection + required status checks, which is a standing
     repo-admin change out of scope for a PR to make — the org plan
     (`team`) does support it if the owner wants to flip it on; see the PR
     description for exact steps. Shipped the cheaper, no-admin-needed
     alternative instead: `.github/workflows/rebase-open-prs.yml` runs
     after every push to master and rebases every open, ready-for-review,
     same-repo PR (`.github/scripts/rebaseOpenPrs.js`), `--force-with-lease`,
     skipping drafts/forks/`no-auto-rebase`-labeled PRs, commenting instead
     of force-pushing on conflict.
  3. **Collision warnings.** `.github/workflows/pr-collision-watch.yml` +
     `.github/scripts/prCollisionWatch.js` recomputes every open PR's
     file-overlap set on every relevant event and keeps one bot comment per
     PR current (edited in place via a hidden marker — a stale "no
     collision" claim is worse than none). Uses `gh pr diff --name-only`
     (real merge-base diff, not a raw local diff, so a merely-behind PR
     doesn't look like it touches everything).
  4. **`renderer.js` report (no refactor)** — see PR description / this
     session's final report for the full breakdown. Short version: 1747
     lines, one function (`renderVideo`, ~398 lines) is the single largest
     chunk and itself covers three distinct money paths (master/derive/
     titling); `renderStatic` (~169 lines) is a fully separate pipeline
     sharing almost nothing with it except claim/bump/heartbeat primitives
     and module-level state (`inFlight`, `runInflight`/`runHeartbeats`/
     `runDocIdCache` Maps). Natural seam: split by render route into
     `staticRenderService.js` / `videoRenderService.js`, leaving
     `renderer.js` as the poll/claim/heartbeat/dispatch core. Not done —
     owner decision, this was report-only.
- **Suite: 36/38 passed.** Two non-passing, both pre-existing / not caused
  by this branch (confirmed: `scripts/vendor-manifest.json` is
  byte-identical to `origin/master`'s copy on this branch):
  - `verifyRunFinalizesOnSettle_KNOWN_OPEN.js` — the documented, allowlisted
    expected-failure (see `scripts/expected-failures.json`).
  - `verifyVendorDrift.js` — a REAL, PRE-EXISTING failure already on
    `origin/master`: 12 vendored files have drifted because the sibling
    `liquidretail_backend` has moved past the manifest's last recorded
    reconciliation (backend is at `ba99a59f` / #329; the manifest's
    recorded `backendHead` is `b7b8cae6`, several backend commits back).
    This is a content/porting decision (port or re-attest each file via
    `--reconcile`), not a build-infra concern — out of scope for this PR,
    flagged for the owner rather than silently fixed or ignored.
- **Not landed.** PR open against `master`, NOT merged per explicit
  instruction — owner reviews and merges.

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
