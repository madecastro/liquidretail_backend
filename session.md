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

- Trunk `main` is moving fast — always `git fetch` before trusting a SHA here.
  As of this update, `main` is at `9fb14705` (#272, reconciles a stale
  `CampaignRun` from the real Ad truth instead of trusting process-local
  status writes), with #268 (static ad-grid tile downscale) and #271
  (brand-scope `mediaAssignmentService` attach/detach) merged just before it.
  #260-through-#265 (vision-qc silent gate, typeface classification, funnel
  stage + retailer productUrl on projections, verify-infra hardening) are all
  merged — the PR #260 narrative that used to live in this section is now
  historical; see `session.d/2026-08-19_vision-qc-silent-gate-fixed-pr-260.md`
  if you need it. `npm test` (parallel, `scripts/runVerifySuite.js`) remains
  the gate; **do NOT trust `npm run test:affected`** — confirmed hole in its
  changed-file basename filter (`length >= 4`), so `models/Ad.js` → `"Ad"` →
  excluded; editing it (or `routes/ads.js`, `"ads"`) alone can report "nothing
  to run" and exit 0 while dependent scripts never run. Use plain `npm test`
  (full suite) until this is fixed.
- **Newest backend session (this one, 2026-08-20): PR #274, open, not
  self-merged** — `fix/concurrency-and-derive-wait-backup`. Two owner-approved
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
  it still holds). Backend: **#274** above.
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
