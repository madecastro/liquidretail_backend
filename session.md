# session.md — liquidretail_backend

Handoff for the next session. **Restructured 2026-08-19** — this file had grown to
6,962 lines / 475 KB (touched by 15 of the last 36 merges to `main`), because every
session appended its entry directly here. Two different in-file reorganisations
(2026-08-03, then a "moved history to `CHANGELOG.md`" pointer later) were each buried
by the next round of appends landing past them — a written convention alone did not
hold, because every append still touched this one file at the one shared insertion
point, so any two open PRs conflicted on this file within seconds of either merging.

**The fix is structural, not just a rule:** a session's own entry now goes in its own
file under `session.d/`, never inside this one. Two sessions adding two different
files can never conflict — there is no shared line for git to argue about. This file
stays small on purpose, because the global convention is to read it first, every
session; a 475 KB read was most of a session's context budget before it opened a
single source file.

**What still lives here, and how it changes:**
- **NEXT-SESSION PROMPT** — the owner's standing instruction. The owner edits this;
  a session clears it back to the placeholder after acting on it. Whoever changes
  this is making a real edit to real state, so a conflict here is a real conflict,
  not the append tax — expected to be rare and easy to resolve by hand.
- **CURRENT STATE** — a short, *replaced* (not appended) snapshot. Same reasoning:
  low-frequency, legitimate edits only.
- **KNOWN-OPEN** — moved to `session.d/KNOWN-OPEN.md`, a curated checklist edited in
  place (add/remove/check off items; do not append a second copy of the list here or
  anywhere else).
- **Everything chronological** — every dated entry that used to accumulate in this
  file now lives as its own file in `session.d/`, one per entry, named
  `YYYY-MM-DD_<slug>.md`. See "Adding an entry" below.

**Archive.** All 56 pre-existing dated entries from the old `session.md` (2026-08-03
through 2026-08-19) were split out verbatim into `session.d/` in this same change —
nothing was deleted or summarized away; every file is git-tracked with its own
history entry point, and the old content is also still fully recoverable from this
file's own git history (`git log -- session.md`) if a `session.d/` file is ever
suspected of drifting from the original. `CHANGELOG.md` holds the older, hand-curated
prose summary (pre-2026-08-03) and is unaffected by this change.

## Adding an entry (do this instead of editing this file)

1. Create `session.d/YYYY-MM-DD_<short-slug>.md` (today's date, a few kebab-case
   words describing the finding — copy the style of any existing file in that
   directory). Write your entry there, in full — this is the same level of detail
   that used to go inline here.
2. Do **not** add a link to it anywhere. There is no index to maintain — that was
   itself a second shared-append point. To find recent entries:
   `ls -t session.d/*.md | head -20`, or `grep -rl <keyword> session.d/`.
3. Only touch the body of *this* file if you are updating CURRENT STATE, clearing or
   setting NEXT-SESSION PROMPT, or the owner asked you to fold something significant
   back into `CHANGELOG.md`.
4. If an entry is settled history with no more forensic value as a standalone file
   (rare — most are kept), fold a compressed summary into `CHANGELOG.md` and delete
   the `session.d/` file in the same commit, `git log --follow` will still find it.

See `CLAUDE.md` §5 *Conventions* for the repo-wide statement of this rule.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder in the same commit that closes it out.)_

---

## CURRENT STATE

*(Replace this whole section, don't append to it, when it goes stale.)*

- **UNATTENDED E2E LOOP, 2026-08-21 (this entry): `main` is at `8fc602d6`
  (#303).** PR #303 reverts `REMOTION_QUEUE_CONCURRENCY` 8→4 — the 4→8 raise in
  #274 was owner-approved *contingent on* being validated against the web-service
  memory graph on a full run, that validation ran, and 8 OOM-killed the web
  process at its 8Gi limit (0.33 → 7.57 GiB in two minutes; ~0.9 GiB per
  concurrent Remotion slot). Deployed and confirmed live; same workload now peaks
  at 3.38 GiB. 174/174 verify scripts pass. `VEO_CONCURRENCY` deliberately left
  at 24. **Recovery from that OOM was flawless and needs no work** — 12/12 ads
  re-titled free, run reconciled to `done · succeeded 12`, zero re-spend; read
  the entry before "fixing" the reaper or the resume window. **Video vision QC is
  now validated end-to-end in production for the first time** (12 real verdicts,
  ~$0.025 each, 3 pass / 9 fail). **NEW, NOT FIXED:** the 9:16 generative reframe
  (`nano-banana-2/edit`, no mask, re-synthesises the whole canvas with no pixel
  paste-back) is **recolouring brand logos before Omni runs** — Pelagic's marlin
  measured teal `(96,156,168)` → navy `(12,60,96)`, L1 252, which vision QC then
  independently reported and failed 5 ads for. Full detail, the three ranked fix
  options, and two schema traps that will otherwise mislead you:
  `session.d/2026-08-21_oom-titling-loop-and-reframe-recolour.md` — **read
  `session.d/2026-08-21_reframe-fabrication-spotcheck-pr151.md` WITH it. That file
  corrects a wrong claim in the first (the product-only pad branch DOES exist, at
  `atlasVideoService.js:1880`, and runs before the crop attempt), and establishes
  that this is the merchandise-fidelity spot-check PR #151 explicitly asked for —
  so re-enabling that pad is NOT the fix: padding a SEED bakes letterbox bands into
  the delivered video, which is exactly why #151 reverted it.**
  **DECIDED 2026-08-21 — CLOSED. The owner reviewed all 33 generated references and
  ruled the reframe ACCEPTABLE (1 of 9 products rejectable, ~$0.14 expected waste per
  product, QC catches it and nothing ships).
  `session.d/2026-08-21_reframe-owner-verdict-CLOSED.md` is authoritative and records
  four things NOT to do, incl. that a pixel pre-flight screen CANNOT work. Do not
  reopen. The keep-out band gap (PR #306) is separate and still open — moved to
  another session 2026-08-21.**
  *(This section is append-not-replace here on purpose: the bullets below are
  other sessions' live state and I could not establish they are stale.)*
- Trunk `main` is moving fast — always `git fetch` before trusting a SHA here.
  As of an earlier update, `main` was at `9534502a` (#275, reverts the Meta video
  prompt hook-first standardization back to pre-standardization text and
  applies the same text to PMax), with #274, #273, #272, #271, #268 merged
  just before it. #260-through-#265 (vision-qc silent gate, typeface
  classification, funnel stage + retailer productUrl on projections,
  verify-infra hardening) are all merged — the PR #260 narrative that used to
  live in this section is now historical; see
  `session.d/2026-08-19_vision-qc-silent-gate-fixed-pr-260.md` if you need it
  (**and see the new PR #276 bullet below — #260 fixed the missing
  disabled-stub visibility; #276 fixes a DIFFERENT, deeper bug in the same
  gate that #260 did not touch: a cache-race that read a genuinely-ON DB flag
  as off on most real calls**). `npm test` (parallel,
  `scripts/runVerifySuite.js`) remains the gate; **do NOT trust
  `npm run test:affected`** — confirmed hole in its changed-file basename
  filter (`length >= 4`), so `models/Ad.js` → `"Ad"` → excluded; editing it
  (or `routes/ads.js`, `"ads"`) alone can report "nothing to run" and exit 0
  while dependent scripts never run. Use plain `npm test` (full suite) until
  this is fixed.
- **Newer backend session (2026-08-20): PR #279 + fast-follow #280, both
  MERGED** — `fix/run-counter-desync-and-render-resilience` +
  `fix/run-counter-titling-truth-compat`. #279 merged while #278 was
  concurrently in flight; the two didn't textually conflict but #278 changed
  `classifyRunAdOutcome`'s semantics (titling-truth awareness) in a way
  #279's two new call sites weren't written against — #280 closed that gap
  moments later (wide Ad projection + `!isSettled && !needsRetry` guard).
  Both PRs' 33-check harness state and 182/182 full-suite pass are current on
  `main` as of this note. Owner-flagged: two runs
  (brian@egami.tv) stuck at `status:'failed', succeeded:18, total:39` while
  all 39 claimed Ads were genuinely `draft` with a real `renderUrl` (confirmed
  against prod via a read-only query). Root cause: PR #272's Ad-truth
  reconciliation is wired into exactly one place (the worker's stale-`running`
  reaper); `services/processAlerts.js` `persistOrphans` (fires on every
  deploy/autoscale SIGTERM) blind-stamped `status:'failed'` with no recount,
  which is permanently invisible to that fix. Fixed: `persistOrphans` now
  reconciles from real Ad truth (reusing `classifyRunAdOutcome`/
  `buildRunReconciliationUpdate`), plus a new general healing pass
  (`buildRecentlyFailedFilter`) that re-checks recently-`'failed'` runs the
  same way — this is what actually heals the two already-broken runs once
  deployed. Two independent Grok adversarial reviews caught a real regression
  in the first draft (a bare `!outcome.isSettled` guard starving
  `strandedRunSweeper`'s contract in the common mixed deploy shape) before
  commit; fixed and revert-proven. Also investigated (no code change): the
  SIGTERM/render-resilience question — Render's own events API shows the
  22:45:45 single SIGTERM was a benign autoscale scale-down and the 23:05:09
  triple was the operator's own deploys, though genuine OOM kills do recur
  independently every 20-45 minutes; existing recovery
  (`bootRecoveryService`/`titlingResumeService`) already avoids double-
  billing there, with 5-20 minute latency. Full write-up:
  `session.d/2026-08-20_run-counter-desync-and-render-sigterm-investigation.md`.
  `scripts/verifyRunStatusTruthfulness.js` extended 24 → 31 checks. `npm test`
  — **181/181** passed. `npm run lint` clean.
- **Newest backend session (this one, 2026-08-20): PR #276, open, not
  self-merged** — `fix/vision-qc-cache-race`. Owner turned
  `SystemConfig.adVisionQcEnabled` on and it barely ran: 11/18 delivered
  statics on one run stamped `disabled:true` with the flag genuinely on, and
  all 14 delivered videos had no `visionQc` at all. Root cause #1: the
  synchronous `adVisionQcService.isEnabled()` gate fired a fire-and-forget
  cache refresh and peeked the cache in the SAME TICK, so any call landing
  past the 5s TTL (the normal case in production) read a cache miss as "off".
  Fixed by switching all three real callers to `await resolveEnabled()` (the
  pre-existing, never-racy async resolver — they are all already `async`
  functions already awaiting a billable vision call a few lines later) plus a
  defense-in-depth fix in `systemConfigService.peekAdVisionQcEnabled()` itself
  (serve the last-known value across staleness instead of collapsing to env).
  Root cause #2 (separate, also reported): several video paths (no-brand
  branches in `routes/ads.js` ×2 and `adRegenerateService.js`, a swallowed
  chrome-throw in `adRegenerateService.js`, `titlingResumeService.js`'s
  give-up-on-brand branch) never reach `renderBrandScriptAndSave` at all, so
  they never reach vision QC either — not even PR #260's disabled stub. Added
  a shared `qcAndStampVideoAd()` helper and wired it into all five spots.
  Full write-up, revert-proof notes, and the mocked-`Date.now()` TTL
  regression test in
  `session.d/2026-08-20_vision-qc-ttl-cache-race-and-video-visibility-gaps-pr276.md`.
  Extended `scripts/verifyQcGateWiring.js` (new section K),
  `scripts/verifyAdVisionQcSurfacing.js`, `scripts/verifyImageRecovery.js`.
  `npm test` — **181/181** passed. `npm run lint` clean. Read-only against
  prod; `SystemConfig.adVisionQcEnabled` untouched (still `true`).
- **Also 2026-08-20, a separate concurrent session: PR #282, open, not
  self-merged** — `feat/qc-failed-status-and-reason`. Owner decision: a QC-failed
  ad now delivers as `status:'failed'` (video path — statics already did, via
  the existing job-failure/recovery handling) with a `visionQc.failureDetail`
  that is byte-identical to what `alertQcFailure` sends Slack (it now returns
  that string; callers stamp it before persisting). Rebased onto PR #276 below
  (both touched `brandScriptExecutor.js`'s new `qcAndStampVideoAd` shared
  helper) — the status flip now lives INSIDE `qcAndStampVideoAd` itself, so
  all five of #276's callers get it, not just the two this PR originally
  touched. Also fixes `routes/catalog.js`'s `GET /:id/ads-detail` — the
  Product Ads detail endpoint — which never carried `visionQc`/`renderError`
  in its own `$project` allowlist at all. Extended
  `scripts/verifyAdVisionQcSurfacing.js` (+20 checks, hand revert-proven three
  ways, re-run green post-rebase). `npm test` 181/181, lint clean. Paired
  frontend PR `liquidretail#68` (gallery pill + detail-screen description).
  Full detail:
  `session.d/2026-08-20_qc-failed-status-and-slack-reason-parity-pr282.md`.
- **PR #274, open, not self-merged** — `fix/concurrency-and-derive-wait-backup`. Two owner-approved
  changes: (a) `VEO_CONCURRENCY` 12→24 / `REMOTION_QUEUE_CONCURRENCY` 4→8 in
  `config/defaults.env` (submit+poll-only and low-risk vs. a memory-bound
  in-process render pool that needs a full-run memory-graph check before going
  higher than 8); (b) the derive-master wait timeout
  (`renderDeriveOnlyVideoAd` → new `handleDeriveMasterBackup`,
  `routes/ads.js`) no longer stamps an ad `failed` after
  `MAX_DERIVE_WAIT_ATTEMPTS` — it requeues AND actively reclaims through the
  same atomic claim path stranded ads use (`requeueStrandedAds` →
  `claimAdsForRun`), and fires one rate-limited Slack notice per backup
  episode, keyed on the master. Full detail, revert-proof notes, and why this
  had to ship as one PR (raising concurrency makes the timeout fire more
  often) in
  `session.d/2026-08-20_concurrency-raise-and-derive-wait-never-abandons-pr274.md`.
  New harness `scripts/verifyDeriveWaitBackup.js`. `npm test` — **181/181**
  passed (post-rebase onto `9fb14705`). `npm run lint` clean.
- Open PRs at the time of this update: RPD **#210/#212** (carried forward from
  the prior snapshot as "deliberately deferred — do not touch"; not
  independently re-verified this session — confirm status before assuming
  it still holds). Backend: **#276, #274** above, and **#278**
  `fix/titling-delivery-truth`: closes the gap where `renderUrl` non-null +
  `status:'draft'` was treated as "delivered" everywhere (run rollup,
  `projectAd`, both `ads-detail` endpoints, Meta push), which let an untitled
  video master ship indistinguishable from a finished ad — see
  `session.d/2026-08-20_titling-delivery-truth-fix.md`. Also found and fixed a
  live bug in `routes/catalog.js`/`routes/campaigns.js` ads-detail: both
  fetched `renderStage` but never put it on the response, so despite frontend
  commit `6541164`'s claim, Product Ads had NO pipeline-stage signal at all.
  Root-cause note on the *why now*: `render logs` shows the web instance being
  autoscale-replaced roughly every 1-9 minutes from 23:09Z through past 23:51Z
  on 2026-08-20 — well past the day's 3 real deploys — consistent with
  `REMOTION_QUEUE_CONCURRENCY` 4→8 (PR #274, same day, explicitly unvalidated
  against the memory graph) causing RSS-driven replacement mid-titling. Not
  reverted here — owner-approved, flagged for a memory-graph check instead.
- Offline verify: `npm test` (or `node scripts/runVerifySuite.js` directly)
  — **181 scripts** as of this update (re-count before quoting, this number
  drifts — it was 174 two snapshots ago). `npm run lint` enables exactly one
  rule, `no-undef` — see `CLAUDE.md` §5 for why that one rule matters more
  than it looks like it should.
- **Correction to a prior note below**: `verifyLogoSilhouette.js`,
  `verifyLogoColorPreservation.js`, `verifyStaticTextInk.js` failing in a
  fresh `git worktree` checkout (all three `require(path.join(__dirname,
  '..','node_modules','sharp'))`, which `NODE_PATH` cannot rescue — it's a
  literal path join, not a bare `require`) is **not permanently
  environmental** — it means that worktree's vendored `node_modules/sharp`
  is missing its native `@img/sharp-<platform>` + `detect-libc` deps (a
  `git worktree add` artifact, not a code issue). Verified 2026-08-19:
  `npm install sharp --no-save --ignore-scripts` from inside the worktree
  repairs it cleanly (also incidentally pulled in `https-proxy-agent` and
  `ffmpeg-static`, separately missing in that same worktree) — all three
  scripts then pass for real. `--no-save` leaves the top-level
  `package.json`/`package-lock.json` untouched; only
  `node_modules/.package-lock.json` (npm's own in-tree bookkeeping file,
  already git-tracked in this repo) shows a diff afterward — do not commit
  that file, it is a local environment repair, not a source change. macOS
  still has no `timeout` binary — a loop that wraps each script in `timeout`
  will misreport all of them as failed regardless of the above.
- Most recent entries (see `session.d/`, newest by filename date):
  `2026-08-19_vision-qc-silent-gate-fixed-pr-260.md` (this session — PR
  #260, open, rebased onto #257/#259 with a second adversarial-review pass:
  idempotency-guard fix, rollup status-scoping, qcdOnRetry double-count fix,
  qcDisabled/qcUnavailable split),
  `2026-08-19_detect-prep-mediaids-brand-leak-fix.md` (PR #257, merged —
  closes the #245-review finding #1 above; a same-day follow-up also made
  `ensureDetectForProducts` fail-closed on a missing `brandId`, see
  `session.d/KNOWN-OPEN.md`),
  `2026-08-19_reels-rating-row-half-sliced-fixed-element-aware-overflow.md`
  (follow-up to #239: a title group can now shrink/drop whole
  elements to fit its box instead of `overflow:hidden` clipping through the
  middle of one; `remotion/lib/stackFit.js` is new),
  `2026-08-19_crossbrand-tenant-leak-generate-fix.md` (PR #245, merged),
  `2026-08-19_video-vision-qc.md` (video ads now get the same post-render
  vision QC statics have; landed as PR #240),
  `2026-08-19_undispatched-tail-fix-stranded-ads-close-the-loop.md` (PR #241, merged),
  `2026-08-19_reels-quote-opening-line-silently-dropped-fixed-pr-239.md` (PR #239, merged),
  `2026-08-19_pelagic-ad-price-snapshots-repaired.md` (PR #242, merged),
  `2026-08-19_vision-qc-surfacing-closed-last-gap-table-row.md` (PR #236, merged).

## KNOWN-OPEN

See `session.d/KNOWN-OPEN.md` — curated list, edited in place.

## ARCHIVE

- `session.d/` — every dated session entry, one file per entry, 2026-08-03 onward.
- `CHANGELOG.md` — hand-curated prose summary, pre-2026-08-03 and select highlights.
- Full pre-restructuring `session.md` (single 6,962-line file): `git log -- session.md`.
