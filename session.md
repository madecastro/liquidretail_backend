# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24/25. Worktree `/Volumes/Sayulita/Projects/RS/.wt-video-titling-recovery`,
branch `fix/video-titling-recoverable` off `origin/master` @ `0c97041`.
PR #60 open, NOT merged, NOT deployed — owner asked for a PR only.)*

- **Made a failed titling pass on a paid video master recoverable instead
  of stranding it.** Confirmed defect, as measured: `liquidretail_adgen`'s
  video path is Omni submit (PAID, ~$0.45-$1.00) → Remotion titling
  in-process → done, and only a Remotion child OOM was ever stamped
  resumable (`brandScriptExecutor.js`'s `stampTitlingOomAndThrow`); a
  timeout or any other child failure fell through to a bare `throw` and
  processAd's generic catch marked the row `status:'failed'` with NO
  resume marker — permanently stranding an already-billed master.
  `titlingResumeService.resumeUntitledMasters()` (the module that would
  rescue such a row) had ZERO callers anywhere in `src/` — confirmed via
  grep across `entrypoint.js`/`renderer.js`/`titler.js`/`orchestrator.js`.
  All three defects the task described were confirmed present, unchanged
  from the description.
  1. **Generalized the stamp** (`brandScriptExecutor.js`,
     `stampTitlingFailureAndThrow`, now module-level + exported) to cover
     OOM, timeout, AND a generic child failure/exception — all three
     stamp `status:'draft'`+`titlingResumeState:'pending'` (resumable) up
     to a shared `TITLING_ATTEMPTS_MAX` ceiling (new `Ad.titlingAttempts`
     counter, default 3, env-overridable), past which the ad goes
     TERMINAL (`status:'failed'`) instead — an unbounded retry on a paid
     path would be worse than the stranding it replaces (a real
     deterministic bug — "remotion child IPC forbids buffers" — showed up
     in the stranded-ad query below, which is exactly the failure class
     the cap exists for). `renderer.js`'s two titling call sites (derive +
     master) and `titlingResumeService.js`'s own catch now defer to
     `err.titlingResumable` (the flag the stamp sets) instead of
     re-classifying OOM only — otherwise the renderer's own generic
     catch-all or the resume sweep's old OOM-only branch would clobber a
     resumable stamp straight back to `failed`.
  2. **Wired the resume sweep from `renderer.js`**, on a 90s-delay/5-min
     interval, modeled on backend's own wiring, gated on
     `isAdgenRendererEnabled()` (same flag PR #52 wired into `claimOne()`)
     so it cannot race backend's own render/resume path over the same
     collection, and re-entrancy-guarded so a slow pass never stacks
     concurrent Remotion renders. **First draft put this on `orchestrator`**
     (the one adgen role Render keeps singleton) reasoning that avoided
     "two workers racing" — **adversarial review (Grok, xhigh, two
     independent passes) caught that this would have OOM-killed the
     process**: `orchestrator`'s Render plan is `starter` (~512 MB) but
     `resumeUntitledMasters()` calls `renderBrandScriptAndSave` for REAL,
     and a single Remotion titling slot has been MEASURED at ~1.97 GiB
     (`renderer.js`'s own `REMOTION_QUEUE_CONCURRENCY` comment). The very
     first ad it actually retitled would have crashed the singleton.
     Correct fix: run it from `renderer.js` (`pro_plus`, 8 GB, already
     budgets exactly this cost) — autoscaled (min2/max8), which is fine
     because the atomic per-document claim (below) is what makes two
     instances racing the same ad safe, not "only one process runs this."
     Also mirrored the same `err.titlingResumable` gate into `titler.js`'s
     own titling call site (same review pass found it still OOM-only —
     this file duplicates renderer's call site by design, per its own "if
     you edit one copy, edit the other" header) and closed a real
     regression the review found: a cap-exceeded (terminal) titling
     failure used to reach `processAd`'s catch and have its detailed
     `renderError` (stage/code/attempt-count) clobbered by the generic,
     unscoped `noteRenderIssue()` write — fixed by skipping that call when
     `err.titlingFailureKind` is already set.
  3. **Claimability** relies on `titlingResumeService`'s OWN pre-existing
     atomic per-document claim (already vendored, untouched) — did NOT
     touch `claimOne()` or widen the renderer's `status:'rendering'`
     filter, which would have required routing a resumed ad back through
     the full `renderVideo()` (re-submitting Omni). Proved the claim is
     race-safe with two REAL concurrent `resumeUntitledMasters()` calls
     racing one ad (`scripts/verifyTitlingRecoverability.js` C1) — exactly
     one titles it, the other sees `modifiedCount:0` and skips.
  4. **MONEY — verified by execution, not just review**, that no resume
     path can reach `atlasVideoService.submitGeneration` (the only
     billable Omni POST): `submitGeneration` has exactly 1 call site,
     structurally inside the `else` of `if (isResuming)`
     (`scripts/verifyTitlingResumeNeverResubmits.js` section A), and a REAL
     require-graph BFS (Node's own `require.resolve`, not a regex) proves
     `atlasVideoService.js` is unreachable from either
     `titlingResumeService.js` or `brandScriptExecutor.js`'s entire
     transitive require graph (section B) — with a positive control
     proving the same BFS DOES find it from `renderer.js` (rules out a
     vacuous pass). Mutation-tested: injecting a fake
     `require('./atlasVideoService')` into `titlingResumeService.js`, or a
     second `submitGeneration(...)` call site, or moving the call into the
     `if(isResuming)` branch, each turned the harness red; reverting turned
     it green.
  - **Stranded-population query (read-only Render job, `adgen-renderer`
    service, `MONGODB_URI` already in env).** The exact population the
    task specified (`titlingResumeState` in `{pending,claimed}`,
    `status:'draft'`, non-null `veoVideoUrl`) is currently **0** — because
    the OLD code only ever put an ad in that state for OOM, which is rare;
    everything else went straight to `status:'failed'` with no resume
    marker at all. The REAL population this fix would have rescued:
    **88** video ads are `status:'failed'` with a paid master
    (`veoVideoUrl`) already on file, of which **38** have a titling-
    specific failure signature (Remotion timeout, the IPC-buffer bug) —
    the other 50 are legitimate vision-QC rejections, a different, correct
    code path this PR does not touch. All 88 are 4.9-14.3 hours old (this
    fleet is 3 days old). This is retrospective only — the OLD code
    already terminal-failed these; the fix changes behavior for failures
    from here forward.
  - **Suite: 41/44 passed** (2 new scripts added, `runVerifySuite.js`
    auto-discovers). Non-passing, none caused by this branch (confirmed by
    stashing and re-running on bare `origin/master`):
    - `verifyRunFinalizesOnSettle_KNOWN_OPEN.js` — allowlisted expected-fail.
    - `verifyVendorDrift.js` — pre-existing, sibling backend has moved on.
    - `verifyModelParity.js` — pre-existing (`titlingNeeded`, from the
      titler Phase 3 PR #52, already violated the adgen-fields-⊆-backend-
      fields rule before this branch). This PR's new `Ad.titlingAttempts`
      field adds a SECOND entry to the same, already-red check — same
      precedent as `titlingNeeded` (an adgen-only mechanism with no backend
      analogue), not a new category of problem. Did not touch the sibling
      `liquidretail_backend` repo (out of scope — separate repo, separate
      PR process, not authorized here). Flagged as a real follow-up, not
      silently left; see KNOWN-OPEN.
  - Two pre-existing harnesses (`verifyRemotionChildIsolation.js` D6/D8/D11,
    `verifyRenderErrorTails.js` D3) had text/regex pins tied to the old
    OOM-only shape and needed updating to the new OOM+timeout+generic
    shape — not weakened, just re-pointed at the widened mechanism
    (mutation-tested same as above).
- **Not landed.** PR #60 open against `master`, NOT merged, NOT deployed —
  owner reviews and merges/deploys.

  *(Superseded by this entry: a concurrent session's `fix/wire-
  safezonekey-titling-adgen` — surface-aware titling band geometry,
  `resolveSafeZoneKeyCjs` in `plateIntelService.js`, wired into both
  `renderTitles` call sites in `brandScriptExecutor.js` — landed and
  merged as PR #54/#59 while this session was in flight. Full write-up:
  `session.d/2026-08-24_wire-safezonekey-titling.md`. This branch was
  rebased onto that merge; the `safeZoneKey` plumbing and this session's
  titling-recoverability changes are both present and non-overlapping in
  `brandScriptExecutor.js`/`renderer.js`.)*

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
