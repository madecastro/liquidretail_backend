# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Replaced 2026-09-02 night. Worktree `/Volumes/Sayulita/Projects/RS/.wt-pad-source-scale`,
branch `fix/pad-at-source-scale`, rebased onto `origin/master` `b4edfc2`. **Do not touch
the main `liquidretail_adgen` checkout.**)*

**This branch is the pad-at-source-scale + refinedProducts + Scene 2 landing for the
Pelagic fidelity experiment. Not pushed.**

- `1473950` — pad at source scale (`padCanvasDims`, method-gated `pad-src-v1`, `$in`
  claim fence, passthrough arm in code). Judged not shippable as-is.
- Follow-up commits on top: (1) `refinedProducts` on both catalog `.select()`s so
  cold siblings can crop-first; (2) byte-pad + composite-pad also use `padCanvasDims`
  (else composite-pad invalidation freezes 720-short under `pad-src-v1`); drop
  `REGENERATE_DAILY_CAP=1000` (no-op, does not belong here); document
  `REFRAME_PASSTHROUGH_BRAND_IDS=` empty; (3) Scene 2 else-branch only — "on the
  product as already shown". Designed extra "Do not search for a logo…" clause was
  dropped: +48 bytes overflowed Grok 4096 on a 1000-char operator regenerate.

**Suite:** 90/92. Reds are pre-existing, not this diff:
- `verifyVendorDrift` — backend moved on ~20 vendored files since the last
  look (same red on origin/master). This branch's three files
  (atlasVideoService, veoPromptBuilder, videoRefPrewarm) are reconciled.
- `verifyRegenerateInFlightGate` E1 — merge-order gate reading
  `origin/master:scripts/vendor-manifest.json` for the phrase `OWES PORTS IN BOTH
  DIRECTIONS` on `adRegenerateService.js`. That phrase is not on trunk. This
  branch does not touch that file. Fails on origin/master itself.

**Do not npm ci / NODE_PATH in this worktree.**

**Experiment still not run.** Deploy order is in the 2026-09-02 design: code with
passthrough empty → canary `6a985882` → control 14 → flip passthrough → canary →
arm 1 14 → restore env. Prewarm off during the window.

---

*(Prior 2026-09-01 morning. adgen trunk `master` @ `6d93686` (#102) — api/orchestrator/
renderer/titler all confirmed Live. Backend trunk `main` @ `175968d` (#374) — web + worker
both Live.)*

**adgen #102 + backend #374 landed and deployed — CI verify-suite dotfile-ENOENT-race
hardening, completing what PR #367 (backend CI) started.** Both were built as
build-complete, cross-model-reviewed diffs sitting uncommitted in worktrees, and both hit
the same real-world surprise on landing: **origin had moved substantially since the diffs
were drafted, in both repos, from other concurrent sessions.**

- **adgen #102**: `scripts/lib/sourceWalk.js` filename-dot-skip (this repo's independent
  vendored copy of the same shared helper backend has — same bug, same fix: the walk
  skipped dot-prefixed *directories* but not dot-prefixed *filenames*, so a transient
  `.__revertprove_*.js` mutation-test sibling could still be caught mid-write by
  `verifyArchiveDigestRelease.js`'s whole-repo scan and ENOENT under `--concurrency=4`).
  Plus `scripts/verifyRunFinalizesOnSettle_KNOWN_OPEN.js` → `scripts/verifyRunFinalizesOnSettle.js`:
  the harness's expected-fail theory ("renderer.js never wired run-finalization") was
  simply wrong — `renderer.js`'s `bumpRunCounter` (:733) already awaits `maybeFinalizeRun`
  (:744) — so it was rewritten to source-extract and replay the real live completion path
  instead of a hand-copied pre-fix shape. Suite: 89/89, zero expected-failures.
- **backend #374**: the other 10 `verify*.js` harnesses that do their own directory walk
  got the identical dot-skip PR #367 gave `verifyMetaApiVersion.js`. Suite: 220/220, zero
  expected-failures.
- **The surprise, worth internalizing for next time**: backend's PR #367 — titled
  "**DO NOT MERGE**", with its own body checklist explicitly unchecked on that line — got
  merged anyway by the owner (`nicknsheth-beep`) while this session's diff was in flight,
  and its four documented known-failures (`verifyCostAttribution.js`,
  `verifyDirectorFallbackChain.js` / `atlasModelMap.js`, `verifyIngestBackgroundWorkSurvives.js`,
  `verifyPreparingReap.js` F2) were *each independently fixed and merged as their own PRs*
  (#370, #371, #372, #373) — apparently by another concurrent session — in the ~20 minutes
  before this session went to land its own copy of overlapping work. Caught by re-diffing
  against a freshly-fetched `origin/main` rather than trusting the old local base: this
  session's local uncommitted versions of `routes/ads.js` and `services/atlasModelMap.js`
  were byte-identical to what had already landed; `scripts/verifyCostAttribution.js` and
  `scripts/verifyIngestBackgroundWorkSurvives.js` were functionally the same fix with
  different (and in `verifyCostAttribution.js`'s case, *more robust* — brace-balanced vs.
  naive `indexOf`) implementations. Adopted origin's already-merged, already-reviewed
  versions of those four files rather than re-landing a competing copy, rebased the
  branch onto current `origin/main`, and opened a **new** PR (#374, `ci/github-actions-verify-suite`
  was already closed) carrying only the genuinely-still-outstanding 11-file dotfile fix.
  Full narrative + the adversarial-reviewer's (opus) findings on the three
  already-merged money/lifecycle changes (all SHIP, two small non-blocking follow-ups —
  stale `docs/turn-on-anthropic-direct.md`, missing `DIRECT_URLS.anthropic` entry) live in
  `liquidretail_backend/session.d/2026-09-01_verify-suite-dotfile-race-remaining-walks.md`.
  **Lesson for any session landing a build-complete diff that sat uncommitted for a
  while: re-diff against a fresh `origin` fetch before committing, every time — don't
  trust the branch state the diff was originally built against.**

---

**SIX THINGS SHIPPED AND DEPLOYED 2026-08-31.** All merged and live in production:

1. **Title TEXT-ON-TEXT fixed** (adgen #97 → backend #361). Delivered vertical ads printed the
   headline and the productName/rating stack on top of each other. Cause: `resolveGroupAnchor`
   moves each slot group off a face/product band INDEPENDENTLY, with no knowledge of where other
   groups landed, so two SIMULTANEOUSLY-VISIBLE groups could resolve onto one band.
   Fix was TEMPLATE-level (owner choice): verticals re-timed strictly sequential, the pinned
   in-creative `brandPill` removed across all 6 brand presets (cleared 12 combos by itself), and
   `offsetY 0.105` on vertical upperThird so copy clears the model's head. **0 of 15 vertical
   combos overlap, was 9.** Pinned by `scripts/verifyTitleGroupsNeverOverlap.js`.

2. **Title LOW-CONTRAST legibility** (adgen #98). Contrast is now part of BAND SELECTION, not just
   ink colour — the scan measured contrast and threw it away at the one moment it could act. Plus
   a `paint-order:stroke fill` contour + weight bump, gated on WORST-CASE sub-AA contrast (matching
   what placement already did). Social-proof sizes bumped (quote 1.15→1.30, rating 1.25→1.60).
   ⚠️ **OWNER DECISION STILL OPEN**: the contour fires on ~1 ad in 5. To make it rarer, revert
   `escalationInk` → `bandInk` at the three gates in Canonical.jsx. One line, everything else stands.

3. **Meta-ads font retry** (backend #362). `metaFontsIngestedAt` was stamped even when NO source was
   configured, permanently disabling retry. All 9 brands were stuck in exactly that state, so
   connecting Meta later would have changed nothing. Now gated on a typed `billableAttempted`.
   Also: a brand with Meta Ads connected NEVER pays for the Apify scrape (owner rule).
   `scripts/clearConfigAbsentMetaFontStamps.js` unsticks existing rows — DRY-RUN by default,
   **has not been run**.

4. **Ad-phase parity** (backend #365, rescued from a 5-day-stale unpushed branch). `deriveAdPhase`
   is now one canonical answer to "where is this ad", replacing three surfaces that each derived it
   separately and could disagree. Fixed a LIVE bug: `routes/campaigns.js` never projected
   `visionQc`/`renderError` at all, so that endpoint couldn't tell a QC fail from a render fail.

5. **Shopify theme fonts** (backend #363) + **Slack ingest status** (backend #364). The former pulls
   REAL font files from a shop's theme (proven live: 5 Inter .woff2 off Peloton Apparel), authed +
   public, gated only on a shopifyUrl — NOT on ingest method. The latter reports every ingest stage
   with counts, per-stage and total timings, and the method, as one Slack message edited in place.

6. **Brand-tier quote can't attribute an implicit-SKU review to the wrong product** (adgen #101 →
   backend #369). Ad `6a9600196c6bffaf965a99e9` (product "Rusted Icon", a T-Shirt, brand "Pelagic
   Gear 4 Demos") printed a brand-pool testimonial — "I've got two pairs of these and they fit
   great..." — that is a genuine review of a DIFFERENT product in the same catalog ("Flyline Stretch
   Pant", pants). Root cause: `quoteAllowedForScope`'s (`services/quoteProvenance.js`) noun-scope
   gate only rejects a brand-tier quote that EXPLICITLY names the wrong garment; this quote names
   none ("pairs"/"these" aren't tracked nouns), so it was treated as brand-generic and allowed onto
   any product. Fix: a quote implying one specific pair-sold item ("N pairs of these/them/those/it")
   is now dropped from the brand tier UNCONDITIONALLY — never matched back against the ad's own
   scope labels. Two earlier draft designs that DID try to match back were adversarially reviewed
   (Grok, high effort, two independent passes) and found exploitable: a secondary detected label in
   the same photo, and the pre-existing `fromLabel` "short"→"shorts" recovery, which ANY "Short
   Sleeve" title satisfied and needed its own match-local (not whole-string) fix. The genuinely
   matching product still gets the review via its own product-tier pool, which bypasses this gate
   entirely — only the brand-wide last-resort guess is closed. Companion producer-side fix:
   `lookupBrandReviews`'s Gemini prompt (`services/providers/geminiSearchProvider.js`) now explicitly
   asks for brand-wide-only statements, naming this exact pattern as an exclusion example — that
   provider is BACKEND-live (adgen's copy is a documented, deliberately-unwired vendor fork), so the
   backend port is what actually changes future quote harvests. Pinned by
   `scripts/verifyQuoteScopeImplicitPairs.js` (39 checks, structural revert-proves against the
   shipped source, not stub reimplementations). While landing this, discovered ANOTHER concurrent
   Claude session had reset `liquidretail_backend` to `origin/main` mid-edit, silently wiping the
   first attempt at the backend-side port before it was ever committed — recovered cleanly (adgen
   was never touched; the other session's own stashed WIP was left fully intact) but worth knowing
   this repo's working tree is not safe to leave uncommitted for long right now.

**MEASUREMENTS THAT OVERTURNED DELEGATED CLAIMS — verify numbers before acting on them.** Two
adversarial reviews produced headline figures that did not survive re-measurement:
  - "HIGH severity: the contrast term worsens landscape collisions." Swept the real formula over
    1,157,625 band conditions: **+0.73pp** (72.00%→72.73%), and lowering CONTRAST_WEIGHT recovers
    NONE of it. The real find is the **72% BASELINE** — see KNOWN-OPEN.
  - "73% of real bands are worst-case marginal." Re-measured the same 5 delivered plates: **20%**
    (3/15). That changed the decision from "the contour becomes the default look" to "it stays a
    rescue for 1 ad in 5".
Both reviews DID also find real bugs. The lesson is not "ignore reviews" — it is "re-derive any
number you are about to act on".

**PRE-EXISTING BUGS FOUND WHILE IN THERE (all fixed):** `BadgeSlot` painted plain text on footage
with NEITHER shadow NOR contour — the only text-on-plate slot with zero legibility treatment, ever
since its pill was removed 2026-08-03. `RatingSlot` hardcoded fontWeight 700/500, silently
swallowing the treatment, so the star/score lockup an owner report called illegible was the one
part that could not be reinforced. The contour could be clipped by its own `overflow:hidden`
(proven in the same chrome-headless-shell Remotion uses: 2px horizontal, 1px on Verdana below the
baseline) — `strokeClipGuard` fixes it.

**NEW TOOLING.** `scripts/renderTitlePreview.js` renders ANY preset/format/scenario to a still in
~5s with NO database, network or vision call — `--plate-video` for real footage, `--real-scan` to
run the real plate scan over actual frames, `--lum`/`--busy` to force a hostile band. **Its fonts
are HARNESS DEFAULTS, not brand fonts** — it prints a banner saying so, because its serif output
was once mistaken for a production font regression. Also `scripts/inspectAd.js` (read-only Ad
inspector, structurally incapable of writing) and `scripts/verifyTitleGroupsNeverOverlap.js`.

**FONT PIPELINE REALITY CHECK.** Website font capture WORKS — 8 of 9 brands have real downloaded
font files. The "fonts look wrong" report was a FALSE ALARM caused by the preview harness's
placeholder fonts. What is actually broken needs OWNER action, not code: no brand has a Meta Ads
credential; `APIFY_ADLIB_ACTOR` is unset; and `Reach Social`'s own `websiteUrl`
(`https://reach-social.io`) returns **404**, which is why that brand has zero fonts.

---

## KNOWN-OPEN

- **LANDSCAPE title groups collide across ~72% of the condition space — PRE-EXISTING, measured
  2026-08-31, bigger than anything fixed today.** Sweeping the real `resolveGroupAnchor` formula
  over 1,157,625 band conditions on the landscape shape (`main|upperThird` simultaneous with
  `main|lowerThird`) shows they converge on one band ~72% of the time **with no contrast term at
  all**. Cause: their keep-out chains (`['upperThird','center','lowerThird']` and
  `['lowerThird','center','upperThird']`) contain the SAME three candidates, separated only by
  `BAND_SWITCH_MARGIN` (0.03) — far too small to hold them apart. **`BAND_SWITCH_MARGIN` is the
  lever, not CONTRAST_WEIGHT** (which costs only +0.73pp and buys back nothing when lowered).
  Landscape is 16:9 PMax/YouTube, NOT a Meta surface, and it additionally has the
  `panelColumnStyle` split-stage geometry, so whether these collide in *practice* was NOT audited —
  do that before sizing a fix. The 18 affected combos are listed explicitly in
  `scripts/verifyTitleGroupsNeverOverlap.js`'s ACCEPTED baseline. Rate is over a uniform sweep, not
  a prediction of the real-ad rate.
- **The title contour's firing rate is an OPEN OWNER DECISION.** It currently fires on ~1 ad in 5
  (worst-case-across-clip reading, matching placement). Reverting `escalationInk` → `bandInk` at
  the three gates in `Canonical.jsx` makes it rarer but reintroduces the inconsistency where a
  group is MOVED because a band fails later in the clip yet denied the treatment for that same
  failure. Rendered comparisons on real ads exist; the effect is subtle (0.95–6.6% of frame pixels).
- **The final adversarial Grok pass on the title-legibility diff NEVER RAN** — it timed out at 10
  minutes and #98 merged without it. The FIRST review completed and every finding was fixed and
  independently verified, and a separate agent proved the clipping empirically, so it is not
  unreviewed — but the second look at the fixes did not happen. Re-running it against `master`
  retroactively is cheap and would close this honestly.
- **Owner/ops actions that no code change can substitute for:**
  (a) no brand has a Meta Ads credential, so meta-ads font capture cannot run at all;
  (b) `APIFY_ADLIB_ACTOR` is unset, so the public Ad Library tier is off;
  (c) `Reach Social`'s `websiteUrl` `https://reach-social.io` returns **404** (verified live, both
      plain and browser UA) — that is why the brand has zero captured fonts, and its
      `fontIngestedAt` stamp also needs clearing to re-attempt;
  (d) Slack ingest status ships INERT until `SLACK_INGEST_STATUS_CHANNEL` is set;
  (e) `scripts/clearConfigAbsentMetaFontStamps.js` (backend) has NOT been run — it is dry-run by
      default and unsticks the 9 brands whose stamps currently block any retry.
- **BACKEND HAS NO CI.** `gh pr checks` reports zero checks on a backend branch, yet a backend merge
  AUTO-DEPLOYS the main API. Four backend PRs merged today on local suite runs alone. adgen has CI
  and it earned its keep — it caught an unreconciled vendor manifest on #98 that would otherwise
  have shipped. Worth closing this gap.
- **PARALLEL SESSIONS IN ONE WORKING TREE MAKE LOCAL VERIFY RUNS UNRELIABLE.** While #98 was in
  flight, another session had uncommitted work in `src/services/quoteProvenance.js` and
  `src/services/providers/geminiSearchProvider.js` in the SAME directory. `verifyVendorDrift`
  hashes the working tree, so their files showed as adgen-side drift in my local run and did not
  exist in CI. Stage by explicit path, never `git add -A`, and attribute a local red against a
  clean tree before believing it.

- **Title-group simultaneity still open on 14 LANDSCAPE + 2 proto combos
  (2026-08-31).** The 2026-08-31 vertical fix cleared every vertical and every
  Meta feed/square layout, but 18 preset+format combinations still have two
  groups on screen at once and are listed explicitly in
  `scripts/verifyTitleGroupsNeverOverlap.js`'s ACCEPTED baseline. 14 are
  `landscape` (16:9 PMax/YouTube — NOT a Meta surface), all the same shape
  (`main|upperThird X main|lowerThird`); landscape additionally has the
  `panelColumnStyle` split-stage geometry, so whether they can actually collide
  there needs its own look and was NOT audited. 2 are `proto-bottom-editorial` /
  `proto-kinetic-center` on feed+square (prototypes). Removing a line from that
  baseline as each is fixed is the goal; ADDING one to silence a red run is the
  exact regression the harness exists to catch.
- **Meta-ads font capture produces zero evidence for all 9 brands (2026-08-31).**
  See CURRENT STATE for the measurement. Next concrete step: check whether
  `APIFY_ADLIB_ACTOR` / `APIFY_TOKEN` are set on the **backend** Render service
  (brand enrichment runs there, not adgen); the committed default is blank.
  Separately, `Reach Social`'s website font scan failed permanently and will
  never retry — its `fontIngestedAt` stamp needs clearing to re-attempt.
- **An engine-level anchor-collision guard was drafted and reverted (2026-08-31).**
  Owner chose the template fix instead. If the landscape/proto set is ever tackled
  generically rather than per-preset, note the design constraint that killed the
  first attempt: its "no free band, so keep the authored anchor" fallback means
  sitting on a face, which the owner ruled unacceptable. Any revival needs a
  better answer for that case than the one that was written.

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
