# Parallel-work architecture plan + five safe slices (PR #246)

Branch `chore/parallel-work-infra`. Full plan: `docs/PARALLEL_WORK.md`.

## Why

Six agents were mid-flight on this repo when this session started — the
owner runs 6-10 concurrent Claude Code sessions against it and the collision
cost (biggest hotspot `routes/ads.js`, four agents editing it simultaneously
on one measured night) is now the dominant tax. This session's job was to
(a) plan the decomposition of the actually-hot files, and (b) ship only the
slices that are genuinely safe against six other agents working live — no
code changes to `routes/ads.js`, `worker.js`,
`services/campaignAdsGenerationService.js`, `services/aiCreativeDirectorService.js`,
`CLAUDE.md`, or `remotion/` anywhere in this branch.

## What shipped (see `docs/PARALLEL_WORK.md` §7 for full detail)

1. `scripts/runVerifySuite.js` — parallel aggregate runner for all
   `scripts/verify*.{js,mjs}` (**170** as of `origin/main` `64371b97`, not the
   "152"/"160"/"168" numbers various recent sessions have quoted — see the
   numbers-correction note at the top of the plan doc). Replaces the
   documented `for f in scripts/verify*.js; do node "$f" || echo FAIL; done`
   loop, which also silently never ran the `.mjs` harnesses. `npm test` /
   `npm run test:affected`. Measured ~35s parallel (concurrency=8) vs ~95s
   serial for the same 170 scripts, same pass/fail verdict, diffed directly.
   Across ~16 full-suite runs this session, 14 were a clean full pass; 2 were
   a single (different each time) script failing, neither reproducible on an
   immediate standalone re-run — written up honestly in the plan doc rather
   than claimed away, with a "re-run before treating as a real regression"
   policy note rather than a silent auto-retry.
2. Fixed `verifyLogoSilhouette.js` / `verifyLogoColorPreservation.js` /
   `verifyStaticTextInk.js` to `require('sharp')` normally instead of a
   hardcoded `path.join(__dirname, '..', 'node_modules', 'sharp')` that
   bypassed `NODE_PATH` entirely. This is the same failure class this
   file's own CURRENT STATE section and PR #239/#240's commit messages all
   independently hit or documented the same day — this PR is the actual code
   fix, not another workaround note. Verified by removing
   `sharp`/`https-proxy-agent` from a worktree, confirming `MODULE_NOT_FOUND`,
   reinstalling, confirming all three pass (17/17/21 checks).
3. `bin/setup-worktree.sh` + `npm run setup:worktree` — installs the two
   missing worktree deps with `--no-save`, restores
   `node_modules/.package-lock.json`, runs the suite. Tested end-to-end
   against a worktree with both packages removed.
4. `scripts/checkRebaseContainment.js` + `npm run check:rebase` — rebase
   safety net (line containment across `*.md` files + commit containment via
   `git patch-id`) for the "a rebase silently dropped content" failure mode
   that hit this repo twice in one measured night. Verified against a
   constructed true-positive and true-negative, then dogfooded on this
   session's own four real rebases across a fast-moving trunk (one flagged,
   correctly, a legitimate PR #239 doc edit as a line-containment false
   positive — inspected and confirmed benign, exactly the documented
   heuristic tradeoff).
5. `scripts/findStaleUncommittedWork.js` + `scripts/findOrphanedBranches.js`
   (`npm run check:stale-work` / `check:orphaned-branches`) — two read-only
   detectors for "finished work with nowhere durable to land," added
   mid-session after the orchestrator surfaced this as a live, separate
   failure mode (distinct from the file-collision problem the rest of this
   work addresses): once an uncommitted diff, once a real commit that never
   got a PR. Both found real, current examples in the shared checkout/repo
   (3 stale files ~9.4h old; 8 orphaned branches) — reported only, per
   explicit instruction not to land or investigate them; a different agent
   owns that.

## What's a plan only, not executed

`docs/PARALLEL_WORK.md` §1-5: `routes/ads.js` decomposition into 7 route
clusters (with the ~15 harnesses that read the file by raw source text — the
real hazard a route-table diff alone can't prove safe), `worker.js`
decomposition (`reapOrphans` is 43% of the file and the actual hotspot, not
the job-dispatch loop), the two flagged services'
decomposition (money-critical clusters flagged separately), the `CLAUDE.md`
volatile/stable split (grounded in exactly what
`verifyLlmErrorCodes.js`/`verifyCampaignRunHeartbeat.js` read by path, plus a
same-day PR #239-then-#240 worked example of the append-tax the file's own
§5 already warns about with no enforcement), and a file-ownership convention
proposal (one claim file per branch on the shared filesystem, mirroring the
`session.d/` precedent). None of it touches the four hot files or `CLAUDE.md`
— by design, so this PR carries zero collision risk against the six agents
that were active while it was written.

## Verification

`npm run lint` clean throughout. Full suite green after every change,
including after all four rebases this session. `git diff --numstat
origin/main` checked before every commit — only ever showed this branch's own
files.

Full write-up, all citations, and the honest residuals/caveats: `docs/PARALLEL_WORK.md`.
