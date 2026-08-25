# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Replaced 2026-08-25 ~08:00 UTC, end of a long overnight session. Trunk `master`
@ `684ac8b`. Full narrative: `session.d/2026-08-25_overnight-video-chain-and-review-coverage.md`.)*

**Video generation works.** The outage was PR #43 passing raw Mongoose ObjectIds on
the Remotion child IPC payload, which `remotionChildSupervisor.assertNoBuffers`
rejects. Fixed by `String()`-wrapping every id at both `renderTitles` call sites in
`brandScriptExecutor.js`. Proof is in production data, not the merge log: the last
`remotion child IPC forbids buffers` failure is 22:09 UTC 2026-08-24; the 04:13 UTC
2026-08-25 batch returned `status:'draft'` with `veoVideoUrl` populated. The only
failure in that batch was a vision-QC content rejection.

**Deployed:** all four adgen services and both backend services are live on their
trunks. `ADGEN_RENDERER_ENABLED=true` on backend-web (dashboard, not the file).

**Two production levers are still unpulled, both deliberately:**

1. `REMOTION_QUEUE_CONCURRENCY` is **2** on the adgen-renderer dashboard. PR #61
   raised `config/defaults.env` to 3, but `src/config.js:12` loads dotenv WITHOUT
   `override:true`, so the dashboard variable wins — **PR #61 is inert in
   production.** Raising it is a dashboard edit. Measured ~1.97 GiB per concurrent
   Remotion render, so 3 ≈ 5.9 GiB of an 8 GiB box. 4 is the value that was
   OOM-killed on 2026-08-21 holding a paid master; do not restore it.
2. `ADGEN_TITLER_ENABLED` is **false**. Its blocker is now cleared: PR #63 landed the
   `titlingNeeded: { $ne: true }` exclusion in `claimOne()`, gated on
   `isTitlerEnabled()` so a flag-off rollback can still drain leftovers. Without it
   the renderer re-claimed every row it handed to the titler. **Next step is a
   dashboard flip, once someone has watched a video run on the deployed build.**

**`verifyModelParity` now pins to backend `origin/main`** (`git archive` into a temp
dir, then a real `require()`), matching `verifyVendorDrift`. It previously read the
sibling's WORKING TREE — a shared checkout that is routinely dirty and behind — and
produced a false "backend lacks titlingNeeded/titlingAttempts" failure. Override the
ref with `ADGEN_BACKEND_REF`. **The NODE_PATH prohibition is unchanged and absolute:
never set NODE_PATH, never run `npm ci` in an adgen worktree.**

**Suite:** `node scripts/runVerifySuite.js` → 48/49 on the #63 branch (49 harnesses),
47/48 on trunk. The single red is `verifyRunFinalizesOnSettle_KNOWN_OPEN.js`, red by
design and listed in `scripts/expected-failures.json`.

**Review-coverage numbers were corrected, and this changes the funnel plan.** The
strategy document's "80.5% of SKUs have a usable product review quote" is the
UNGATED count and was measured on Pelagic Gear, then generalised. Measured across six
brands, first-party (`scraped`) quote coverage is 946 of 4,424 SKUs — **21%**. Details
and the mechanism live in the backend's session entry for the same date; the short
version is that `catalogproducts.productReviews` is a Mixed OBJECT (not an array),
`quotesOrigin` is `scraped` or `llm-web`, and ingest never writes ratings — three
separate later passes do.

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
