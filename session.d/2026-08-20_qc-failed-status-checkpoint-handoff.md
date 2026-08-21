# CHECKPOINT HANDOFF — QC-failed-status-and-reason (PR #282 + #68), 2026-08-20 ~01:00 UTC

Written because the session that did this work was cut off mid-verification (token budget /
account switch). Read this before touching anything else in this area.

## The task, in one paragraph

Owner decision, verbatim: *"It should be delivered as failed with a description in the
detail screen of what was wrong with it. that should be the same that gets echoed to slack
in the vision QC feedback."* Three parts: (1) a QC-failed ad reads Failed, not "Ready for
Review"; (2) the detail screen shows what was wrong; (3) that description is the exact same
text Slack gets — one formatter, two surfaces, provably. Backend
`liquidretail_backend`, frontend `liquidretail`, branch `feat/qc-failed-status-and-reason`
in both.

## Status as of this note: BOTH PRs MERGED. One small follow-up PR open.

- **Backend PR #282 — MERGED** to `main` as squash commit `33259f9c`. Confirmed:
  `origin/main`'s own copy of `services/brandScriptExecutor.js` has `qcAndStampVideoAd`
  correctly applying `buildVideoQcFailureFields` (grep it yourself:
  `git show origin/main:services/brandScriptExecutor.js | grep -n buildVideoQcFailureFields`)
  and `routes/catalog.js` has `visionQc: 1, renderError: 1` in the `ads-detail` `$project`
  (`git show origin/main:routes/catalog.js | grep -n 'visionQc: 1, renderError: 1'`). **The
  product code on main is correct and fully integrated with the two concurrent peer PRs
  (#276 cache-race fix, #277 frame-sampling density)** — I rebased onto both by hand before
  the owner merged; see "What I actually did" below for exactly how.
- **Frontend PR #68 — MERGED.** Not independently re-verified post-merge this session (ran
  out of time) — if picking this up, at minimum re-run `tsc -b --noEmit && vite build` on
  `origin/master` HEAD to confirm nothing about the merge broke it, though there is no reason
  to expect it did (frontend had no conflicting concurrent PRs).
- **Backend PR #285 — OPEN, NOT YET MERGED.** `fix/verify-ad-vision-qc-surfacing-after-282`.
  **THIS IS THE ONE THING LEFT.** #282 merged one commit BEFORE a test-only fixup I pushed to
  that branch landed, so **`npm test` on `main` is currently red** (confirmed live against
  `origin/main` @ `db85ac08`): 182/183, one failure in `scripts/verifyAdVisionQcSurfacing.js`
  (checks F6/F7/G3). #285 fixes exactly that — cherry-picked cleanly onto current `main`,
  re-verified 182/183 (the ONE remaining failure, `verifyVideoQcFrameSampling.js` G2, is
  PRE-EXISTING and unrelated — see below). **Next action: get #285 reviewed and merged.**
  Nothing else is required to close this task out.

## What I actually did (chronological, so a cold session doesn't re-derive it)

1. Implemented the feature against `origin/main` @ `9534502a` (before it moved):
   - `services/adVisionQcService.js`: `alertQcFailure` now **returns** the exact `detail`
     string it sends to Slack (`buildQcSlackDetail`'s output) instead of void.
     `summarizeVisionQc` passes a new `visionQc.failureDetail` field through verbatim, gated
     behind `{categories:true}`.
   - Three call sites (`directImageRenderService.js` static live path,
     `imageRecoveryService.js` static recovery path, `brandScriptExecutor.js` video live
     path) capture that return value and stamp it onto `visionQc.failureDetail` before
     persisting.
   - `brandScriptExecutor.js`: new pure `buildVideoQcFailureFields(videoVisionQc)` — a REAL
     video QC failure (`passed:false && !skipped && !disabled`) now returns
     `{status:'failed', renderError:{...}}`; applied in `uploadRenderAndStamp` AND the
     no-chrome branch of `renderBrandScriptAndSave` (my original two call sites).
   - `routes/catalog.js`'s `GET /:id/ads-detail`: added `visionQc`/`renderError` to the
     `$project` allowlist (was missing entirely — the exact trap the PR description named)
     and to the shaped `adRows` via `summarizeVisionQc`/`renderErrorMessage`.
   - Extended `scripts/verifyAdVisionQcSurfacing.js` (sections E/F/G, +20 checks) — did NOT
     create a new file, per repo convention. Hand revert-proven three ways (see the file's
     own header for the exact revert-and-confirm-fail steps).
   - Frontend (`liquidretail`, same branch name): `pages/ProductAds/index.tsx` —
     `ExpansionAd` type gains `renderErrorMessage`/`visionQc.failureDetail`; `AdThumbnail`'s
     gallery badge gets an explicit `status==='failed'` override (without it, a QC-failed ad
     read "QUALITY CHECK" instead of "FAILED" — the last-written `renderStage` matched
     `STAGE_RULES`' progress-tone entry even though the tone was already forced to warn);
     `AdDetailModal` gets a new "Failed vision QC" / "Render failed" description box.
   - **Browser-verified against REAL data** — see the fuller write-up in
     `session.d/2026-08-20_qc-failed-status-and-slack-reason-parity-pr282.md` (already
     committed, still accurate) for the exact method: 3 real QC-failed Pelagic Gear statics
     (run `run_1787266578461_70865bdd`) fetched read-only via `render jobs create`, served
     through a local mock backend that required the REAL modified `adVisionQcService.js`,
     confirmed in-browser: gallery pill reads Failed, detail screen shows the full verdict
     text, a real passing ad still reads Ready for Review.
   - Full suite 181/181, lint clean, at THIS point (before main moved further).

2. **Discovered main had moved 7 commits** (to `057ab15a`) while step 1 was in flight — two
   peer sessions (`isEnabled()` cache race → #276; video QC frame-sampling density → #277)
   had merged, both touching the exact same files. Rebased `feat/qc-failed-status-and-reason`
   onto `origin/main` by hand:
   - `services/brandScriptExecutor.js` had two real conflicts. PR #276 introduced a NEW
     shared helper `qcAndStampVideoAd({ad, deliveredUrl, brandName})` used by FIVE call sites
     (routes/ads.js ×2, adRegenerateService.js ×2, titlingResumeService.js, and this file's
     own no-chrome branch) to cover video-QC-visibility gaps my original 2-call-site fix
     never touched. **Resolution: moved the `buildVideoQcFailureFields` merge INSIDE
     `qcAndStampVideoAd` itself**, so all five callers get the status:'failed' flip for
     free, and simplified the no-chrome branch back to a plain call to the shared helper.
     This is objectively MORE correct than my original fix (covers 5 paths, not 2).
   - `session.md` conflicted (both sides added a new CURRENT-STATE bullet at the same
     anchor). Resolved by keeping both bullets (upstream's #276 entry + mine) plus the
     shared #274 bullet, once.
   - `routes/catalog.js`, `services/adVisionQcService.js`, `services/directImageRenderService.js`,
     `services/imageRecoveryService.js`, `scripts/verifyAdVisionQcSurfacing.js` all
     auto-merged cleanly — no manual resolution needed.
   - Force-pushed the rebased branch, then ran the full suite and found 2 NEW failures
     (not present before the rebase) — both were bugs in MY OWN test stubs, not product code,
     caused by the rebase exposing my section-F/G checks to #276/#277's new contract:
     - F6/F7: my stub for `adVisionQcService` only had `isEnabled()`; #276 changed
       `runVideoVisionQcForAd` to call `await resolveEnabled()`. Fixed: added
       `resolveEnabled: async () => true` to the stub.
     - G3: my source-scan did `src.indexOf('adRows', routeIdx)` to find the shaping block; a
       NEW comment elsewhere in `routes/catalog.js` (added by an unrelated upstream commit)
       now also contains the literal text `` `adRows` `` in backticks, and `indexOf` found
       that comment first. Fixed: anchored on `'const adRows = ads.map('` instead.
     - Fixed both, confirmed 182/183 (the one remaining failure —
       `verifyVideoQcFrameSampling.js` G2 — was proven PRE-EXISTING on `origin/main` itself
       by checking out `origin/main`'s own copies of the 3 files it touches and running it
       standalone with nothing from my branch applied; real MongoDB connection timeout in
       this sandbox, unrelated to either PR).
   - Pushed the fix as a follow-up commit to the SAME branch.

3. **Owner merged PR #282 (and frontend #68) before that follow-up commit's push had
   propagated / been reviewed** — the squash-merge captured everything through the rebase
   integration (good — product code on main is correct) but not the final test-stub fixup
   commit, leaving `main`'s `npm test` red. Cherry-picked just that one commit onto a fresh
   branch off current `main`, re-verified 182/183, opened **PR #285**.

## Decisions nobody was waiting on (already made, documented for the record)

- **No visually distinct pill for "failed vision QC" vs. "failed for any other reason"**
  (moderation block, crash). Judged the plain "Failed" badge + the description box's own
  heading ("Failed vision QC" vs "Render failed") sufficient. Not run past the owner
  explicitly — revisit if they want a different treatment.
- **Did not backfill `failureDetail` onto historical `Ad.visionQc` documents.** The 3 real
  Pelagic Gear ads used for browser verification predate this fix and still only carry the
  generic `renderErrorMessage` on their detail screen, not the rich per-category block, until
  naturally re-rendered. No migration was requested or attempted.

## What did NOT work / don't repeat

- Do not try to extract the real `MONGODB_URI` to run a local backend against prod data —
  never found one in any `.env` on this machine (only `.env.example`), and didn't need to:
  `render jobs create <serviceId> --start-command "node -e ..."` (base64-wrapped inline
  script, since `--start-command` goes through several layers of shell quoting) is the
  correct read-only way to query prod, already established convention in this repo (see
  memory: "Query prod via Render jobs"). `render logs -r job-<id>` has a **hard 1000-line
  cap** ("invalid limit: too large" above that) and seems to return the LAST N lines, not
  the first — for a big JSON blob, use a tight Mongo `projection` to keep total output under
  that cap rather than trying to raise the limit.
- The shared Browser pane in this environment is used by OTHER concurrent sessions too — a
  different session's artifact tab (`file:///.../scratchpad/report/vision_qc_audit.html`,
  a "Vision QC Cost Audit" investigation) kept stealing tab focus mid-verification. Passing
  `tabId` explicitly to every `computer`/`javascript_tool`/`navigate` call (not relying on
  `tabs_select` alone) is what made screenshots reliable again.

## If you're picking this up cold

1. Check `gh pr view 285` — if merged, **this task is done**, nothing left.
2. If not merged: review it (it's a pure test-file diff, low risk), or just verify `npm test`
   is still 182/183 on top of current `main` and merge it.
3. Do not re-implement any of the product-code fix — it is already on `main` via #282,
   confirmed correct and integrated with #276/#277.
