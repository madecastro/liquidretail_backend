# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Replaced 2026-08-25 ~12:30 UTC. Trunk `master` @ the commit after #66. Narrative:
`session.d/2026-08-25_overnight-video-chain-and-review-coverage.md` then
`session.d/2026-08-25_e2e-rounds-and-qc-findings.md`.)*

**Video generation works** — the PR #43 IPC regression is fixed and proven in production
data. **Static creative is reliable**: ~160 images across four E2E rounds with essentially
zero final-attempt fidelity failures.

**What you must not trust: the VIDEO QC judge.** It is confidently wrong in both
directions — it fabricated specific defects on two masters (one claim reproduced
identically by four separate QC calls, visible in no frame) and caught a genuinely hidden
real one on a third. Video has NO regeneration, so a fabricated verdict terminally
discards a paid master. Before acting on this, note the confound: round 4 used a
single-image seed override instead of the default 3-image reference stack. Re-run with the
default stack first.

**Three fixes shipped from here:** #63 (renderer claim excludes titler-handoff rows —
`ADGEN_TITLER_ENABLED` is now unblocked and needs only a dashboard flip after a watched
video run), #65 (QC can see a logo composited on top of the product), #66 (terminal static
failures persist their verdict — verified by a natural before/after in production, 0 of 10
before the deploy, 16 of 16 after).

**Two production levers still unpulled.** `REMOTION_QUEUE_CONCURRENCY` is 2 on the
adgen-renderer dashboard, so PR #61 is inert — round 4 measured the cost at ~30 minutes for
26 video ads through titling. `ADGEN_TITLER_ENABLED` is false.

**Do not build subject-aware logo placement** — see the session.d entry. #65's QC-retry
path restages the scene; relocation only trades one collision for another.

**Suite:** `node scripts/runVerifySuite.js` → 48/49, the one red being
`verifyRunFinalizesOnSettle_KNOWN_OPEN`, red by design. **Never set NODE_PATH and never run
`npm ci` in an adgen worktree.**

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
- ~~`verifyVendorDrift.js` is currently RED on `origin/master`~~ — **FIXED
  2026-08-28** (PR #94, `session.d/2026-08-28_ci-red-budget-and-vendor-drift.md`).
  This bullet's 2026-08-24 file list is stale on its own terms (most of those
  12 were reconciled by intervening PRs, e.g. #62) and was superseded by a
  fresh round of drift (11 different files) that #94 reconciled individually.
  `verifyRemotionMemoryBudget.js` was ALSO red at the same trunk tip
  (`a108753`'s unbudgeted `REMOTION_QUEUE_CONCURRENCY` 2→3 bump) and is fixed
  in the same PR. **Two real, unrelated, still-open debts came OUT of that
  reconciliation pass, left deliberately `unported` rather than silently
  cleared** — `services/brandScriptExecutor.js` (backend still lacks the
  titling resumable-retry-cap mechanism, #81) and
  `services/adRegenerateService.js` (backend's `runVideoFull`/`runImage`
  lack the `assertNotInFlightBeforeSubmit()` execute-time re-check, #90) —
  see the manifest entries for the full reasoning. If `verifyVendorDrift.js`
  is red again by the time you read this, trunk has moved again since
  2026-08-28; re-run it and diff fresh rather than assuming this list still
  applies. (Prior 2026-08-24 file list retained below for archaeology only —
  do NOT treat it as current.)
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
- **`verifyModelParity.js`** — currently red on `origin/master` for a
  content reason, not a tooling one (re-confirmed 2026-08-25 by stashing):
  `Ad.js` declares `titlingNeeded` (titler Phase 3, PR #52) and, as of the
  video-titling-recoverability PR, `titlingAttempts` too — both adgen-only
  mechanisms the sibling `liquidretail_backend/models/Ad.js` has no
  analogue for, violating the adgen-fields-⊆-backend-fields subset rule.
  Real follow-up, not done here (separate repo/PR): either port both
  fields to backend's Ad.js (as declared-but-unwritten, matching how
  adgen carries backend-only fields today) or teach the harness an
  explicit accepted-drift allowlist the way `verifyVendorDrift.js --reconcile`
  does. (Older note about "models no longer call mongoose.model in a
  shape the harness can extract" was NOT reproduced 2026-08-25 — that
  looked like a stale/environment-specific symptom, not this repo's
  current cause; don't assume it without re-checking.) Separately: a
  `node_modules` symlink in the worktree still breaks it (remove before
  commit) — that part of the old note stands.
- **Orchestrator is still Phase 0, unchanged.** The video-titling-
  recoverability PR's FIRST draft wired the titling resume sweep here
  (reasoning: it's the one adgen role Render keeps singleton) but
  adversarial review found orchestrator's Render plan is `starter`
  (~512 MB) while a real Remotion titling slot needs ~1.97 GiB — the
  sweep would have OOM-killed it on the first real retitle. Moved to
  `renderer.js` instead (see CURRENT STATE). Expansion
  (Director/Judge/mint/claim) is still unwritten here.
- **`bootRecoveryService` still unwired** from adgen boot (unchanged by
  this PR — only `titlingResumeService.resumeUntitledMasters()` was
  wired, from `renderer.js`). `bootRecoveryService` is a DIFFERENT
  mechanism (pulls a finished Omni master out of a spend receipt after a
  crash mid-generation) that adgen has never wired either; still nobody's
  job here. Confirm before assuming it's covered.
- **`liquidretail_backend`'s own titling-resume sweep is ungated and has
  no attempt-cap concept — cross-repo, not fixed here.** Backend's web
  process runs its OWN `titlingResumeService.resumeUntitledMasters()` on
  an interval with NO `ADGEN_RENDERER_ENABLED` check (confirmed absent
  from `liquidretail_backend/index.js`'s wiring) and its
  `brandScriptExecutor.js` has no `stampTitlingFailureAndThrow` /
  `titlingResumable` — a plain OOM-or-terminal-fail split, same as adgen
  before this PR. If backend wins the claim race on a resumable ad before
  adgen does, its first Remotion failure immediately marks the ad
  `status:'failed'`, undoing this PR's resumability for that ad. Pre-
  existed for OOM; this PR widens which failures are exposed to it. The
  atomic per-document claim still prevents a double-title either way.
  Needs a backend-side PR (separate repo) — flagged, not done here.

---

## Adding an entry

Replace CURRENT STATE / KNOWN-OPEN in place. Do not grow a dated log in
this file.
