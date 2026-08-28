# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Replaced 2026-08-28 ~20:15 UTC. Trunk `master` @ `987ec51f` (#96). All four Render
services — `adgen-orchestrator`, `adgen-renderer`, `adgen-titler`, `adgen-api` —
confirmed `live` on this commit.)*

**Fixed 2026-08-28: face-safe-crop no-face-quorum boundary miss + turned on the
Gemini plate scan (PR #96).** Measured directly against production (Render one-off
Mongo query): **56/625 (9%) of crop-eligible ads** had a real face detected in
exactly one sampled frame, failed the `FACE_MIN_FRAMES=2` anti-hallucination quorum
(`faceSafeCrop.js`), and fell back to a blind full-frame crop that could clip the
face. `detectClipBoxes()` (`basePlateCropService.js`) now samples
`FACE_QUORUM_RETRY_FRAMES=2` new gap-midpoint timestamps
(`videoFrameService.js`: `planAdditionalTimestamps`/`buildAdditionalFrameUrls`)
**exactly once** when `head === null && initialHits === 1`, and re-runs consensus on
the combined set. Worst case 4+2=6 vision calls (~$0.03/ad); 0-hit and
already-quorum ads pay nothing extra. Ported `verifyBasePlateCrop.js` (40
checks)/`verifyFaceSafeCrop.js` (98)/`verifyFaceKeepOut.js` (31) from backend — adgen
had none. Also flipped `TITLE_PLATE_SCAN=gemini` as the live default
(`config/defaults.env`) — production had been silently running the free `basic`
(sharp luminance-only) scan only; `gemini` adds one billable `gemini-2.5-flash` call
per video marking bands to avoid for face/product/focal-point coverage. **Cost not
yet reconciled against a real settled CostLog row** — confirm the per-video price
once live titling runs have accrued.

⚠️ **Traced but NOT ported: backend's manual `/retitle-videos` admin flow still calls
this same crop code live** (`routes/brand.js` `runRetitleJob` →
`renderBrandScriptAndSave` → `renderWithRemotionAndSave` →
`basePlateCropService.resolveBasePlateVideoUrl`/`ensureFaceDetectionForKeepOut`), and
DOES recompute a fresh crop — paying the same no-quorum bug, un-retried — on an
`Ad.basePlate` cache miss (different format or source video). Reconciled in
`scripts/vendor-manifest.json` as an owed port-to-backend debt on
`basePlateCropService.js`/`faceSafeCrop.js`/`videoFrameService.js`, not silently
ignored — needs an owner decision on priority, not ported in this PR.

**A drafted retry condition had a real operator-precedence money bug, caught before
merge:** `head === null && initialHits === 1 || initialHits >= 2` parses (`&&` binds
tighter than `||`) as `(head===null && initialHits===1) || (initialHits>=2)` —
`consensusFaceBox` guarantees `head` is non-null whenever `faceHits>=2`, so that
clause fired two wasted vision calls on every ad that had already resolved a good
crop. Fixed to the bare `head === null && initialHits === 1`. An independent
xhigh-effort adversarial Grok review (fresh session, not a fork) confirmed the fix
and flagged one harness-coverage gap — Q1–Q4 stubbed `buildAdditionalFrameUrls`
without ever asserting the call site actually passes `count`, so a regression that
silently dropped it would have kept those tests green. Closed with a new
count-assertion plus a single-frame-already-trusted regression test (Q5), both
revert-proven against the exact regressions they target.

**Prior CURRENT STATE entries, compressed (both confirmed merged, full narrative in
`session.d/`):** `src/services/retitleConsumer.js` (**PR #93**, merged) — a fourth
claim namespace (`retitleRequest`/`retitleClaimedByWorker`) so backend's manual
`/retitle-videos` can defer to this service; found and fixed a live production bug
along the way (`brandScriptExecutor.uploadRenderAndStamp` was unconditionally forcing
`status:'draft'`, silently un-publishing already-live ads on manual retitle) via
opt-in `preserveAdStatus`/`retitleMode`; `handoffContract.js` v1.0.0→v1.1.0. Landed
together with backend PR #359. Full narrative:
`session.d/2026-08-28_retitle-adgen-handoff.md`. Vendor-drift + Remotion-memory-budget
reconciliation (**PR #94**, merged) — see KNOWN-OPEN below for the CURRENT drift
status, which has moved twice since (#94 itself, then this PR); don't trust either
PR's own narrative as up to date on that specific check.

**Also confirmed merged since the last full pass through this file (re-verified
2026-08-28 via `gh pr view`, not re-narrated in detail here):** #75 (adgen's own
sweep no longer stomps the titler handoff), #80 (the four hand-rolled Mongo matchers
fail loud on a dotted path), and #81/#79/#78/#77/#76 (previously listed as still
open — all five are MERGED).

**Video generation works** — the PR #43 IPC regression is fixed and proven in production
data. **Static creative is reliable**: ~160 images across four E2E rounds with essentially
zero final-attempt fidelity failures.

**What you must not trust: the VIDEO QC judge.** It is confidently wrong in both
directions — it fabricated specific defects on two masters (one claim reproduced
identically by four separate QC calls, visible in no frame) and caught a genuinely hidden
real one on a third. Video has NO regeneration, so a fabricated verdict terminally
discards a paid master. Before acting on this, note the confound: round 4 used a
single-image seed override instead of the default 3-image reference stack — which, per a
since-fixed content-dedupe bug (`buildReferenceImages`'s `seenUrls` set,
`atlasVideoService.js:3253+`, confirmed present on `origin/master` as of commit
`40f9003`), was shipping two distinct views under a 3-slot label, not three. Re-run
with the current default stack.

**Fixes shipped from here recently:** #63 (renderer claim excludes titler-handoff rows —
`ADGEN_TITLER_ENABLED` is now unblocked and needs only a dashboard flip after a watched
video run), #65 (QC can see a logo composited on top of the product), #66 (terminal static
failures persist their verdict — verified by a natural before/after in production, 0 of 10
before the deploy, 16 of 16 after), #75, #80 (see above).

**Concurrency knobs, re-checked 2026-08-28 (do not trust the previous "dashboard is
2" claim — it's more nuanced now):** `ADGEN_TITLER_ENABLED` is still `false` in
`config/defaults.env`. `REMOTION_QUEUE_CONCURRENCY`'s FILE default moved 2→3 same-day
(commit `a108753`, "staging tolerance") — its own commit message is explicit that
**production stays at 2 via the `adgen-renderer`/`adgen-titler` dashboard overrides
until the staging measurement is in**; read that commit directly rather than a second-
hand summary here if you need the current live value.

**Do not build subject-aware logo placement** — see the session.d entry. #65's QC-retry
path restages the scene; relocation only trades one collision for another.

**Suite:** `node scripts/runVerifySuite.js` → 84/86 as of 2026-08-28 (re-run directly,
not carried over from a stale count), the one non-expected red being
`verifyVendorDrift.js` (pre-existing backend-side drift, unrelated to PR #96 — see
KNOWN-OPEN), the one expected red being `verifyRunFinalizesOnSettle_KNOWN_OPEN`, red
by design. **Never set NODE_PATH and never run `npm ci` in an adgen worktree.**

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
- **`verifyVendorDrift.js` backend-side check is currently RED on
  `origin/master`, re-verified 2026-08-28** (this has moved twice since the
  2026-08-24 12-file list — first reconciled by PR #94, now red again for a
  DIFFERENT reason; don't trust either PR's own narrative as current, always
  re-run and diff fresh). Confirmed via a pristine `origin/master` worktree +
  `ADGEN_BACKEND_PATH` that the current 3-file red set is pre-existing, not
  caused by PR #96: `models/Ad.js`, `services/brandScriptExecutor.js`,
  `services/handoffContract.js` — all three are owed drift from the
  #93/#359/#360 retitle-handoff work landing same-day (backend moved past the
  manifest's last recorded look on each). Does **not** fail CI
  (`ADGEN_BACKEND_PATH` unset there, backend-side checks skip — see the
  harness's own `--help`). Needs a human to look at each file and either port
  the backend change or re-attest: `node scripts/verifyVendorDrift.js
  --reconcile <path> --reason "…"`. Separately, `services/adRegenerateService.js`
  remains an OPEN but currently-non-red unported debt from #94/#90 (backend's
  `runVideoFull`/`runImage` still lack the execute-time
  `assertNotInFlightBeforeSubmit()` re-check) — still owed, just not part of
  today's red set. PR #96 additionally added 3 NEW owed-port-to-backend
  entries for an unrelated reason (the face-quorum-retry fix — see CURRENT
  STATE): `basePlateCropService.js`, `faceSafeCrop.js`, `videoFrameService.js`.
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
