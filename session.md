# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-remotimeout`,
branch `fix/remotion-child-timeout` off `origin/master` @ `227348c`.)*

- **What this is.** Production regression from PR #8 (`c00e17d`): the Remotion
  child supervisor reused `REMOTION_TIMEOUT_MS=180s` as a wall-clock SIGKILL of
  the whole child. Tonight 3/12 ads on run_1787575090320_db5a5d96 failed with
  `remotion child exceeded 180000ms timeout` after the Omni master was paid.
- **Mechanism (confirmed).** Timer starts at spawn AFTER `enqueue()` takes a
  `REMOTION_QUEUE_CONCURRENCY` slot — queue wait is not counted. Covers the
  whole child lifetime (re-bundle, download, plate scan, selectComposition,
  renderMedia, process.exit). Remotion's `timeoutInMilliseconds` is a
  delayRender() watchdog (4.0.495 `timeout.js`), not a whole-render bound.
  Same number, two clocks. Not nested double-count.
- **Fix.** Split: `RENDER_TIMEOUT_MS` / `REMOTION_TIMEOUT_MS=180000` stays the
  delayRender timeout. New `CHILD_TIMEOUT_MS` / `REMOTION_CHILD_TIMEOUT_MS=480000`
  is the wall-clock. 480s admits 100% of the 62-asset sample (mean 89 / p95 158 /
  max 380) with 26% slack above max. Finite — a wedged Chrome/ffmpeg is still
  SIGKILL'd at 8 min. Child isolation, D11, heartbeat, #7 `$in` filters,
  `REMOTION_QUEUE_CONCURRENCY=2` untouched.
- **Heartbeat interaction.** Per-child 480s sits under the 10 min formula floor
  and the live 60.8 min cap, so a hung *in-slot* child dies before that ad's
  beat. A full 32-inflight pile-up of 480s waves is 128 min and exceeds 60.8 min
  (the formula still uses 76s). 16×180s used to fit; 16×380s already did not.
  Not fixed here — heartbeat is out of scope. Tonight's 12-ad batch (6 waves)
  still fits at 480s (48 min).
- **Proof.** Isolation 27/27 → 32/32. Mutation: Infinity → B6/B7/D12 red;
  absent fallback → B6/B7 red; reunite timeoutMs → B5/D1 red; 700s (past floor)
  → B7/D12 red; `CHILD_TIMEOUT_MS * 2` → B5/D1 red. Restored 32/32. Heartbeat
  17/17, slack 34/34. Suite before/after 18/22, same four reds.
- **Pushed.** PR against master. Do not merge.

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-brandport`,
branch `port/brand-consistency-to-adgen`, cut from `origin/master` @ `af4338b`.)*

- **What this is.** Hunk port of backend `fix/brand-consistency` (PR #321:
  `65285607` / `21f1bf09` / `784ffad3`) into adgen so the three creative
  fixes are LIVE on the new-ad path (`ADGEN_RENDERER_ENABLED=true`). Backend
  copies remain regenerate/preview only.
- **Ported files.** `src/services/directImageRenderService.js`,
  `src/services/ratingDisplay.js`, plus harnesses
  `scripts/verifyBrandConsistency.js`, `verifyLogoColorPreservation.js`,
  `verifyStaticCtaDeterminism.js`. Harness requires rewritten
  `services/*` → `src/services/*`. No `require('../config/foo')` came
  across (nothing to rewrite to `../../config/foo`).
- **Not a wholesale overwrite.** Every ported function body matches
  backend byte-for-byte. Adgen divergence kept (`usableAttribution`,
  `composeCorrectiveOverride`, `buildQcRetryArgs`,
  `submitEditImageWithSeedFallback`). DIR 2841 → 3035 lines (backend 3050).
- **The logo pair.** `srgbEncodedToLinear` (true WCAG, breakpoint 0.04045)
  AND `LOGO_MIN_INK_CONTRAST = 4.5`. Picker is `contrastingInkFor` on the
  same metric. High-chroma tiles never re-inked.
- **Hunks.** All nine DIR/ratingDisplay hunks applied on matching anchors.
  None re-anchored.
- **Proof.** Harnesses 82 / 21 / 41 (match backend). Mutation matrix:
  (a) floor 3 keep lin → RED 8 fail, 0.56 wordmark stays white;
  (b) identity linearize keep 4.5 → RED 17 fail, Mai Tai 0.27 wordmark
  `rgb=0,0,0`; (c) both → RED 18 fail; (d) restored → 82 green.
  Suite before 14/18, after 17/21. Same four reds (two KNOWN_OPEN,
  verifyArchiveDigestRelease, verifyModelParity). Require-graph 506/506.
- **Pushed** to `origin/port/brand-consistency-to-adgen`. Not merged.

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-slack`,
branch `fix/adgen-slack-alerting` — additive Slack alerting in `renderer.js`,
rebased onto `origin/master` @ `c00e17d` = #8 + #10 + #11 + #9 + #7.
False-page closed: orphan scan is now claimed-old AND not-heartbeating.)*

- **Rebase still good.** Five ancestors present; diff vs master is still only
  the two additive files (`renderer.js`, `verifyRendererSlackAlerts.js`).
- **Orphan query is two clocks.** `claimedAt < CLAIM_STALE_MIN(20)` AND
  `updatedAt < HEARTBEAT_STALE_MIN(5, floor 3)`. claimedAt stays: claimOne
  does not write updatedAt (`timestamps: false`), so a fresh backlog claim
  can carry a pre-claim stale updatedAt. Bound is 5 min = RESUME_STALE_MIN
  (5 missed 60s beats / 3.3 missed 90s beats), not 20. Floor 3 so a legal
  `RESUME_STALE_MIN=1` cannot make a live 90s beat look stale.
- **Delayed rescan.** Immediate boot scan plus one unref'd `setTimeout` at
  HEARTBEAT_STALE_MIN + AD_HEARTBEAT_SAFE_MAX_MS (5 min + 90s). A predecessor
  that died seconds before boot still looks alive; waiting that window is
  how "not heartbeating" becomes distinguishable from a live sibling.
- **Invariants held.** Heartbeat interval/cap/`claimedByWorker` untouched.
  Terminal `$in: ['rendering','draft']` untouched. OOM OUTER/INNER nesting
  untouched; D11 green. Harness still in-memory `notifyAsync` only (E6).
- **Not merged. Do not open a PR.**

---

## KNOWN-OPEN

- **`verifyCampaignRunHeartbeatWired_KNOWN_OPEN.js`** — expected red.
  `startRunHeartbeat` has no call site in `src/`.
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
