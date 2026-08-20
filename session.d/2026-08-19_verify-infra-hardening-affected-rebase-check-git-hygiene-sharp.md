# 2026-08-19 — verify-infra hardening: `--affected` real dep graph, rebase-loss detection, git-hygiene fixes, sharp pinning

Branch `fix/verify-infra-hardening`, PR
[#264](https://github.com/Emami-RS-Project/liquidretail_backend/pull/264). Not
self-merged — needs independent review per the standing rule (#246 was self-merged
without one, which is how the bugs below shipped in the first place).

Five independent fixes to meta-infrastructure whose failure mode is "quietly
reports green," each reproduced first (throwaway repos / real repro scenarios),
then fixed, then re-verified. Landed alongside #259 (mutate-a-temp-copy fix to
three verify scripts + `UNSAFE_FOR_PARALLEL`) — confirmed no line-level overlap
before rebasing onto it (that PR touched the doc paragraph and
`UNSAFE_FOR_PARALLEL` region of `runVerifySuite.js`; this one touched
`computeAffected` and its own doc paragraph — disjoint hunks, clean rebase).

## `scripts/runVerifySuite.js` `--affected`

Replaced raw-text substring matching (a changed file's `dir/basename` fragment
checked against every script's raw source) with real static resolution of each
verify script's require()/require.resolve()/readFileSync()/readFile()/import
dependency graph — transitive through `require`/`import` edges, but a LEAF
through `readFileSync`/`readFile` "source-pin" edges (conflating the two
reintroduced a false positive during development: a script reading `index.js`'s
text for one assertion was recursing into everything `index.js` requires).

Confirmed fixed: `models/Ad.js` now selects `verifyRenderFailureRecord.js`
(previously missed entirely; 14 unrelated scripts were wrongly selected via
prefix collision). `routes/ads.js` selects exactly the 4 real dependents
(`verifyDeriveInheritsBasePlate.js`/`verifyAdVisionQc.js`/
`verifyMetaVideoDerive.js`/`verifyStaticOnlyNoVideo.js`) among 34/175 total —
narrow, not the full suite. `routes/me.js` no longer spuriously selects
`verifyAgentRegistry.js`. `models/Product.js`/`models/Job.js` now correctly
trigger the `CORE_DIRS` fail-loud fallback instead of a coincidental match
masking a true zero. Untracked files (e.g. a brand-new verify script) are now
included via `git ls-files --others --exclude-standard`. The runner's own file
changing now unconditionally falls back to the full suite (nothing requires the
runner itself, so no graph signal could ever flag a bug in its own selection
logic).

## `scripts/checkRebaseContainment.js`

Built throwaway git repos reproducing all four ways it reported a clean pass on
real, confirmed content loss:
- A merge commit's own resolution content vanished when a default
  `--no-rebase-merges` rebase flattened the branch — now caught via each lost
  merge commit's combined diff (`git diff-tree --cc`).
- `before` being a plain git ancestor of `after` (nothing was actually rebased)
  printed the identical "OK" a genuinely verified rebase would — now a distinct
  "N/A" status that says plainly zero comparisons were performed.
- Line containment's one global Set across all `*.md` files let a duplicate
  boilerplate line elsewhere mask a real deletion — now tracked per source file,
  only accepting survival as genuine migration if the new location didn't
  already have the line at `before` too.
- The documented `--files='**/*.md'` example matched via plain `endsWith` and
  silently checked zero files — now supports real globs, and an explicit 0/0
  match is a loud error instead of a clean pass.

## `scripts/findOrphanedBranches.js` / `scripts/findStaleUncommittedWork.js`

- Split the dangerous `ORPHANED` classification (never pushed anywhere) from a
  new `PUSHED_NO_PR` bucket (safe on origin, just missing a PR) — checked
  precisely via "is the local tip an ancestor of origin's tip for this branch
  name," not just "does a same-named branch exist on origin" (an early pass at
  this fix got that wrong and would have called a fresh unpushed commit on
  local `main` safe).
- Detached-HEAD worktrees (invisible to `refs/heads/`) are now scanned via
  `git worktree list --porcelain`.
- Local `main`/`master` ahead of origin are no longer unconditionally skipped.
- Tip age now uses author date instead of committer date — a routine rebase
  resets committer date to "now" on every replayed commit while leaving author
  date untouched (confirmed empirically).
- Fixed a rename-record misparse in `git status --porcelain -z`: confirmed the
  actual field order is `newpath\0oldpath\0`, and the parser was overwriting the
  correct new-path field with the old one, reporting every fresh `git mv` as a
  stale deletion of a file that no longer exists.
- Age tracking switched from file mtime to a persisted content-fingerprint (hash
  of `git diff HEAD -- file`, stored under this checkout's private git-dir), so
  a touch/format-on-save/this repo's own mutate-and-restore verify harnesses no
  longer reset the staleness clock on an unrelated, genuinely old diff.

## `bin/setup-worktree.sh` / `scripts/verifyLogoColorPreservation.js`

Pinned the `sharp` install to `0.33.5` (matching package.json's `^0.33.5`; was
unpinned, unlike `https-proxy-agent` right above it in the same script — a plain
`npm install --no-save sharp` grabs npm's current latest regardless of
package.json). Made the harness assert its own loaded sharp version
(`require('sharp/package.json').version`) before running any fixture-dependent
checks, since its L1 group pins a documented version-specific bug in
`sharp@0.33.5`'s `.extract().stats()`. Verified outside the repo tree (a nested
worktree with no local `node_modules/sharp` silently resolves a parent
checkout's copy via Node's normal module-resolution walk) that a version
mismatch now fails loud with the actual resolved path, instead of silently
running version-sensitive assertions against an unknown build.

## Verification

- `node scripts/runVerifySuite.js`: 174/174 passed.
- `npm run lint`: clean.
- Per-script pass/fail sets from the runner vs. a plain serial loop over every
  `scripts/verify*.{js,mjs}`: identical (the property that makes the runner
  trustworthy).
- Each fix reproduced first against the unfixed baseline before being shown
  fixed — throwaway repos for the rebase-checker and sharp-resolution cases,
  real uncommitted/branch scenarios for the git-hygiene scripts, direct
  `--affected` runs (old script swapped in, then the fix) for the runner.
