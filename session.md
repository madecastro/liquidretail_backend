# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-vendordrift`,
branch `feat/vendor-drift-detector` off `origin/master` @ `6045317`.)*

- **What this is.** A vendor-drift detector. Tonight's repeated mistake
  (fix in backend, never ported to adgen: #318/#321/#325; plus
  campaignRunHeartbeat.js vendored-but-unwired, #16) had no check.
  Byte-equality is useless — adgen has large legitimate divergence.
- **Design.** Committed `scripts/vendor-manifest.json`. Per file: sha256
  of the *backend* blob last looked at (FAIL signal) + last-touching
  backend commit (provenance) + status `synced`/`fork`/`unused`. Vendored
  set is derived: adgen `src/<rel>` ∩ backend `<rel>` at `origin/main`
  (`git show`, working tree ignored). Backend absent → skip drift, still
  fail dead modules.
- **Dead modules.** Vendored `services/*.js` that export and have no
  `require()` / `path.join(__dirname,…)` reference in `src/`. FAIL unless
  `unused` with a reason. New copies with no requirer fail untracked+dead
  even after today's seed.
- **First run (no manifest, at 9d68b20).** 236 vendored, 220 identical,
  16 divergent, 236 untracked, 33 dead. Seeded so the suite starts
  clean. Rebased onto #18/#19; backend meanwhile moved to `d8c13301`
  (#324) and the check flagged 6 real files + new `adCopyGuards.js`.
  Reconciled, did not port. Landed numbers: 237 vendored, 218
  identical, 19 divergent, 18 forks, 56 unused, 163 synced, 0 drift,
  0 dead, 11/11.
- **Proof.** Overlay pre-#318/#321/#325 hashes → drift flags. DIR
  recorded as fork, adgen differs, not flagged. Fixture `services/c.js`
  with no requirer flags; stripping `unused` from live `semaphore.js`
  flags it; `campaignRunHeartbeat.js` is wired and does not. Suite path
  never writes. Adversarial review: unused no longer mutes drift;
  dead check is reachability from adgen-owned files; line-comment
  `require()` ignored; `GIT_DIR` stripped on `git -C`.
- **Reconcile.** Failure prints `git log recorded..current -- path` and
  `node scripts/verifyVendorDrift.js --reconcile <path> --reason "…"`.
- **Pushed.** PR against master. Do not merge.

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
