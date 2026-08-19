## 2026-08-19 — Vision-QC surfacing: closed the last "Still gap" row in the run-status gap table

Branch `fix/vision-qc-surfacing`, PR #236 (backend, MERGEABLE/CLEAN vs main),
paired frontend `fix/vision-qc-surfacing-fe` → `liquidretail` PR #59. Worktree
`/private/tmp/.../scratchpad/wt-qc-surface`, rebased directly onto main after
#223 (its own base branch) squash-merged mid-session — see the note in
"Squash-merge gotcha" below if you hit the same thing.

Closed the one remaining `docs/ALERTING.md` gap-table row PR #223 left open:
"Per-ad vision-QC category scores + findings — Still gap." `services/
adVisionQcService.js` got one new pure export, `summarizeVisionQc(visionQc,
{categories})` — every surface below reuses it so "was this ad inspected"
has one derivation. `routes/ads.js` `projectAd()` now puts a compact
`visionQc` on every ad from `GET /api/ads` and `GET /api/ads/:id` (categories
added on the `:id` path only); `GET /runs/:runId` gets a `visionQcRollup
{shippedWithoutQc, qcdOnRetry}`. **Nothing in the generation/regeneration/
alerting control flow was touched** — pure read-side projection on top of
already-persisted data. Full detail + what shipped: `docs/ALERTING.md`
"Vision-QC surfacing (2026-08-19, follow-up)".

Pinned by new `scripts/verifyAdVisionQcSurfacing.js` (19 checks, revert-proven
on two mutations). Also had to widen `verifyRunStatusTruthfulness.js`'s
hardcoded source-scan window (4500→6000 chars) — this PR's additions pushed
the `GET /runs/:runId` handler's `res.json` close past the old window; not a
regression, just a brittle magic number that needed re-measuring.

**Squash-merge gotcha (worth remembering for the next stacked branch).** This
repo enables squash/merge/rebase all three on GitHub. I'd branched off
`origin/fix/run-status-truthfulness` (PR #223's own branch, not yet merged) —
after #223 squash-merged to main mid-session, that branch tip was no longer
an ancestor of main, so `git rebase origin/main` tried to REPLAY #223's own
commit and hit a real conflict in `session.md` (both sides had added new
top-of-file sections at the same insertion point — resolved by keeping
main's side, since #223's own section was already present, unconflicted,
immediately below the markers). The rebase left a harmless-looking but
wrong extra commit — my own blank-line-normalization regex, applied while
resolving that conflict, had touched unrelated spots in session.md too,
producing a second commit titled with #223's message but carrying only
stray blank-line noise. Caught it by re-checking `git show <replayed-sha>
--stat` before pushing; fixed with `git rebase --onto origin/main <that-sha>
<branch>` to drop it and land cleanly as one commit. Lesson: after any
rebase that replays a commit whose content should already be on the new
base (squash-merge case), always diff-check the replayed commit lands as an
EMPTY (or near-empty) no-op — a nonzero diff there is a resolution artifact,
not new work.

Full verify suite from the worktree: 160/163 (`157` unrelated-to-this-change
+ `3` pre-existing environmental — see below). `npm run type-check` and
`npm run build` clean on the frontend side; the new `RunProgress` rollup
line was also driven live in-browser via a new dev-only fixture harness
(`visionqc-harness.html`, same pattern as `badge-harness.html`) — all 7
run-state cases confirmed correct, screenshotted.

**Note for the next session**: two MORE verify scripts joined the
`verifyLogoSilhouette.js` native-`sharp`-in-a-worktree environmental
failure class since my last full-suite baseline — `verifyLogoColorPreservation.js`
and `verifyStaticTextInk.js` (both added by #228). Same root cause: they
hardcode `path.join(__dirname, '..', 'node_modules', 'sharp')`, which
`NODE_PATH` cannot rescue from a worktree (that env var only helps bare
`require('sharp')` calls, not an absolute path join). Expect 3 native-sharp
failures from any worktree now, not 1 — confirmed by checking the worktree's
own `node_modules/sharp` is genuinely absent (not just misconfigured).

### Next session

- Neither PR has merged yet as of this handoff — check
  `gh pr view 236 --repo Emami-RS-Project/liquidretail_backend` /
  `gh pr view 59 --repo Emami-RS-Project/liquidretail` for current status.
- Backend PR #227 (`fix/director-contract-warning-persist`, still open as of
  this handoff) also touches `routes/ads.js`'s `GET /runs/:runId` handler and
  `docs/ALERTING.md`'s same gap table (a different row — Director's
  round-contract warning). No semantic conflict, but whoever merges second
  should rebase and re-diff that handler by hand rather than trusting an
  auto-merge.
- Frontend PR #59's gallery-card QC pill and detail-modal QC block are
  inline JSX inside `AdsPage` (not standalone functions like `RunProgress`),
  so they were NOT independently browser-harnessed — verified via `tsc`
  + build + code review only. Worth a live check against real `Ad.visionQc`
  data once #236 is deployed and an actual QC-failed/skipped ad exists to
  look at.

---
_Archived 2026-08-19 during the session.md → session.d/ restructuring: this entry
landed on `main` (PR #236) as an append to the old monolithic `session.md`, one
merge before the restructuring PR rebased onto it — moved here verbatim rather
than lost in the rebase conflict, and is itself a second real example of the
exact append-tax this restructuring fixes (see the "Squash-merge gotcha" note
above, which describes the same collision happening to PR #223 a few hours
earlier)._
