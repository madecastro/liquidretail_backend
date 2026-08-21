# 2026-08-20 — ad.list capability executor: emit the grid preview URLs the other two ad surfaces already do

**CHECKPOINT NOTE — cold-read this first.** Implementation is DONE and correct.
What's unresolved is purely a landing problem: my PR merged into a branch that
turned out to be a dead end relative to `main`. See **State** and **Next
action** below before doing anything else.

## Task

Third-surface follow-up to PR #268 (`feat/image-grid-preview-url`), which added
`services/imagePreviewUrl.js` and wired it into `routes/ads.js` `projectAd()`
and `routes/catalog.js` `GET /:id/ads-detail`, explicitly scoping this file
out. Task: wire the same two builders into
`services/capabilityExecutors/adList.js`'s per-ad projection — the third
backend surface returning Ad rows to the frontend, backing the AI agent's chat
resource-card grid (frontend `agent/ResourceCard.tsx` → `AdThumbnail`). Add a
revert-proof verify check, run tests/lint, open a PR (base main), do not
self-merge.

## Established facts

- **Gap confirmed 2026-08-20 by direct read**: `services/capabilityExecutors/adList.js`
  (pre-change, ~line 94 per-ad object) emitted `renderUrl`/`posterUrl`/
  `photorealUrl` but no `previewVideoUrl`/`previewImageUrl`, while
  `routes/ads.js` `projectAd()` (~line 4885-4896 on the PR #268 branch) and
  `routes/catalog.js` `/:id/ads-detail` (~line 995-1001, same branch) both did.
- **No `.select()` change was needed, contrary to the task's framing.** Both
  builders (`services/imagePreviewUrl.js`, `services/videoPreviewUrl.js`) are
  pure string transforms over `renderUrl`; `renderUrl` + `kind` were already
  in `adList.js`'s Mongoose `.select()` (line 66 pre-change).
- **`photorealUrl` join already existed** in `adList.js` (`loadPhotorealUrlMap`,
  line 19/73-76/96 pre-change) — added earlier when the projection was widened
  for `AdThumbnail`. So the actual diff is 2 requires + 2 fields, nothing more.
- **Frontend plumbing already exists, but on a branch with no open PR.**
  `liquidretail` repo (frontend), branch `feat/image-grid-preview-url` (NOT
  `master`): `agent/ResourceCard.tsx`'s `adListEntryToExpansionAd()` (line
  ~134-135 on that branch) passes `a.previewVideoUrl`/`a.previewImageUrl`
  through to `ExpansionAd`, and `ProductAds/index.tsx`'s `gridDisplayUrlFor()`
  (line ~221) already prefers them. On frontend `master` these are absent
  entirely (verified via `git grep` across all remote branches — only that one
  branch has `gridDisplayUrlFor`). **That frontend branch needs a PR of its
  own** — this backend change is inert for the agent grid until it lands.
- **`npm test` does not exist** in `liquidretail_backend` (`package.json`
  scripts: `start`, `worker`, `postinstall`, `video:dryrun`, `titles:test`,
  `lint` only). Gate is `scripts/verify*.{js,mjs}` — **180** as of today, run
  via `node scripts/runVerifySuite.js` (parallel, ~36s; confirmed safe to run
  in parallel per that script's own header comment).
- **`eslint` binary is absent from this worktree's tracked `node_modules`**
  (memory: `node-modules-is-tracked-in-rs-backend.md`). Fix: invoke the main
  checkout's binary with this worktree as cwd —
  `/Volumes/Sayulita/Projects/RS/liquidretail_backend/node_modules/.bin/eslint .`
  — config is plugin-free (one rule, `no-undef`), resolves fine from any cwd.
  Ran clean.
- **New harness `scripts/verifyAdListGridPreviewUrls.js` — 11/11, drives the
  real exported `run()`** with the Mongoose query layer stubbed (no DB, no
  network). Stub order is load-bearing: `adList.js` destructures
  `{ loadPhotorealUrlMap, loadUseImageRefMap }` from `adDisplayUrlService` at
  *require* time, so those exports must be overwritten BEFORE the first
  `require('.../adList.js')` or the photoreal-preference check silently tests
  a path the stub never reaches.
- **Revert-proven**: 10 hand-applied mutations to the pristine diff (remove
  either/both fields, swap the two builders, drop the `kind` gate, drop the
  photoreal preference, null the non-Cloudinary fallback, drop
  `renderUrl`/`kind` from `.select()`, hand-roll the transform inline) —
  **all 10 caught**, each by the expected check (verified with a Python
  mutation-and-restore script, output captured, file diffed back to pristine
  afterward — confirmed identical).
- **Suite result in this worktree: 179/180.** The one failure,
  `verifyTitleBeatScale.mjs`, is `ERR_MODULE_NOT_FOUND: remotion` — the known
  worktree gap (`NODE_PATH` only rescues CommonJS, not ESM `import`; see
  memory file above, now updated with the exact command and count). Confirmed
  by running the SAME script in the main checkout: **42/42 pass there.** My
  diff touches nothing remotion-related. `eslint .` clean.
- **CRITICAL, discovered only at 2026-08-20T23:2x checkpoint time — the PR
  did NOT land in `main`.** Backend `main` moved a lot while this was in
  flight (#269, #271-#277, #281 all merged; current `origin/main` HEAD
  `057ab15a`, moved again to include `9534502a`/`40821675`/`75ff91df`/
  `9fb14705`/`110837df`/`de243f43` by the time of this check). Chain of
  events, all confirmed via `gh pr view` / `git log` / `git merge-tree`:
  1. PR #268 (base `main`) was **squash-merged** into `main` as single
     commit `110837df` — `git log --oneline origin/main` shows it as one
     commit titled `Downscale static ad-grid tiles (image equivalent of
     previewVideoUrl) (#268)`.
  2. Its source branch `feat/image-grid-preview-url` was **not deleted**
     on merge and still exists on `origin` with its original (non-squashed)
     commit history — this is the branch I built on top of, per the task's
     own instruction that PR #268 was "still out for review" at the time.
  3. My PR #270 was opened with base=`feat/image-grid-preview-url` (correct,
     since #268 hadn't merged yet when I started). Nick merged **#268 first**
     (2026-08-20T23:01:35Z), then **#270 22 minutes later**
     (2026-08-20T23:23:32Z) — but merged #270 into its literal base
     (`feat/image-grid-preview-url`), producing merge commit `8b92620b` on
     that branch. GitHub did not auto-retarget #270 to `main` (that only
     happens automatically in some UI flows, not guaranteed).
  4. Net result: `8b92620b` (my 2 commits + PR #268's original branch history)
     sits on `origin/feat/image-grid-preview-url`, which is **NOT an ancestor
     of `origin/main`** (confirmed: `git merge-base --is-ancestor 8b92620b
     origin/main` → false). My work is safely pushed and not lost, but it
     never reached `main`.
  5. **Real merge conflict exists, not just a stale-base problem.** Confirmed
     via `git merge-tree origin/main origin/feat/adlist-grid-preview-urls`
     (non-destructive, no working-tree mutation): `CONFLICT (content): Merge
     conflict in services/capabilityExecutors/adList.js`. Root cause
     identified: **PR #273** ("fix(ads): emit funnelStage + productUrl on
     every ads-detail/list endpoint", merged into `main` after my base
     diverged) *also* edited `services/capabilityExecutors/adList.js`,
     touching the same per-ad projection object literal (adding
     `funnelStage`/`productUrl` fields) that my change also edits (adding
     `previewVideoUrl`/`previewImageUrl`). `routes/ads.js` and
     `routes/catalog.js` auto-merged clean — only `adList.js` conflicts.

## State

- Repo: `liquidretail_backend`. Worktree:
  `/Volumes/Sayulita/Projects/RS/.wt-adlist-preview-urls` (branch
  `feat/adlist-grid-preview-urls`, tracks `origin/feat/adlist-grid-preview-urls`).
- **Everything is committed and pushed — nothing uncommitted, nothing local-only.**
  Commits `2152a953` (PR #268's own history, inherited) → `aab431cd` (feat:
  the adList.js change + new verify script) → `d6713418` (docs: this file,
  prior revision). `git status --porcelain` clean; `git log
  origin/feat/adlist-grid-preview-urls..HEAD` empty (fully pushed).
- **PR #270**: state `MERGED` (by Nick, 2026-08-20T23:23:32Z), base
  `feat/image-grid-preview-url`, head `feat/adlist-grid-preview-urls`. **This
  merge did NOT land the change in `main`** — see fact #7 above. Do not
  report this as "shipped" without the caveat.
- Gate result in this worktree at last check: verify suite **179/180**
  (180 total scripts; the 1 failure is the pre-existing worktree/ESM artefact,
  passes 42/42 in the main checkout), `eslint .` **clean**, new harness
  **11/11**, mutation-proof **10/10 caught**.
- Frontend repo `liquidretail`: no code change made (none needed — plumbing
  already exists on its own `feat/image-grid-preview-url` branch). That
  branch has **no open PR**.

## Next action

**Open a fresh PR against real `main`, resolving one real conflict by hand —
do not attempt this under time pressure; do it fresh next session.**

1. From a new worktree or branch off current `origin/main`
   (`git fetch && git checkout -b feat/adlist-grid-preview-urls-v2 origin/main`),
   re-apply exactly two things from `origin/feat/adlist-grid-preview-urls`
   (commit `aab431cd`, or diff `2152a953..aab431cd` if you want the isolated
   delta): the `previewVideoUrl`/`previewImageUrl` block in
   `services/capabilityExecutors/adList.js`, and the new file
   `scripts/verifyAdListGridPreviewUrls.js` (that file is untouched by #273,
   should apply clean via cherry-pick or manual copy).
2. **The actual conflict to resolve by hand**: `main`'s current
   `adList.js` (post-#273) has `funnelStage`/`productUrl` fields in the same
   per-ad object literal my `previewVideoUrl`/`previewImageUrl` fields sit
   next to. They are unrelated, non-overlapping fields — the fix is almost
   certainly "keep both", i.e. splice my 2-field block in alongside #273's
   fields rather than picking one side. Read `#273`'s diff first
   (`gh pr view 273 --repo Emami-RS-Project/liquidretail_backend`) to see its
   exact insertion point before touching the file.
3. Re-run `node scripts/verifyAdListGridPreviewUrls.js` and
   `node scripts/runVerifySuite.js` against the new state (expect 180/180 in
   a fresh worktree, or main-checkout-equivalent if remotion gap persists).
4. Open a new PR, base=`main`. Reference this file and superseded PR #270 in
   the description (#270 is merged but into a branch, not into `main` — say
   so explicitly so a reviewer doesn't assume duplicate work).
5. Separately, flag or open a PR for the frontend `feat/image-grid-preview-url`
   branch (repo `liquidretail`) — it has no PR and holds the passthrough logic
   this backend change needs to have any visible effect.

## Dead ends

- None on the implementation side — mutation testing all passed on the first
  harness draft (after one deliberate hardening: the initial Grok-drafted
  harness hardcoded `w_640`/`w_480` instead of importing
  `GRID_PREVIEW_WIDTH_PX` from each builder, which would have gone red on a
  legitimate width retune rather than a real regression — fixed before
  landing, not a wasted cycle since it was caught during review, not after).
- The one thing that cost time and should not be repeated: assuming a merged
  PR is equivalent to "landed in main". **Always check
  `git merge-base --is-ancestor <PR-head-sha> origin/main` (or equivalent)
  after any PR merges when the base branch was itself a feature branch, not
  the trunk** — especially when the base's own source PR might get
  squash-merged in the interim. This is the same failure class as
  `squash-merge-stacked-branch-gotcha` (existing memory) but this is the
  first time it's actually severed a PR from main rather than just adding
  noise to a diff.

## Blocked on

Nothing requiring a decision from Nick — the path forward (re-open against
main, hand-resolve the one conflict) is mechanical and low-risk. Just needs
someone (next session) to actually do it; explicitly deferred per this
checkpoint's "don't try to finish" instruction.

---

*(Below this line: content from the pre-checkpoint revision of this file,
kept for the implementation detail it carries that isn't restated above.)*

## Verification detail

Two things worth keeping in mind about the new harness:

- **Stub order is load-bearing.** `adList.js` destructures
  `{ loadPhotorealUrlMap, loadUseImageRefMap }` from `adDisplayUrlService` at
  *require* time, capturing the function references. Overwriting those exports
  after requiring `adList` is a silent no-op, and the photoreal-preference check
  would then pass while testing a path the stubs never reached. The service must
  be patched before the first `require` of `adList`. The models are different —
  `adList` holds the `Ad`/`Brand` *objects*, so `Ad.find = …` works at any time.
- **S1 pins `renderUrl` + `kind` in the `.select()`.** Drop either and the preview
  URLs compute off `undefined`, every row looks like the legitimate
  null-`renderUrl` case, and every other check stays green.
