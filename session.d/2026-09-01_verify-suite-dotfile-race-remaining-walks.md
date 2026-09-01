# 2026-09-01 — verify-suite dotfile-ENOENT-race: the remaining 11 files (PR #374)

## What shipped

PR #367 added CI here and, while verifying it, fixed one real ENOENT race in
`verifyMetaApiVersion.js`'s directory walk: several "revertprove" harnesses
briefly write a transient `.__revertprove_<name>_<pid>_<ts>_<rand>.js`
sibling into `routes/`/`services/`/etc. while mutation-testing, and under
`runVerifySuite.js --concurrency=4` (what CI runs) any OTHER harness doing
its own unfiltered `fs.readdirSync` walk of the same directory can catch
that file mid-write and crash with ENOENT once it's cleaned up before being
read. #367 only fixed the one harness that had actually broken a real CI
run.

PR #374 closed the same gap in the 10 remaining harnesses that do their own
directory walk (`verifyBrandFieldNames.js`, `verifyGroundedGeminiLedger.js`,
`verifyCatalogImageCaps.js`, `verifyImageGridPreviewUrl.js`,
`verifyLifestylePreserve.js`, `verifyQuoteRotation.js`,
`verifySocialProofRestoration.js`, `verifySeedClass.js`,
`verifyStageVisibility.js`, `verifyVideoGridPreviewUrl.js`), plus
`scripts/lib/sourceWalk.js` itself — its file-match branch skipped
dot-prefixed *directories* but not dot-prefixed *filenames*, so a transient
dotfile written directly into an already-scanned directory (not inside a
dot-directory) still slipped through. That shared helper has 4 callers,
including the money-critical `verifyArchiveDigestRelease.js` — the fix
closes the gap for all four, not just whichever one happened to surface it.
No assertion predicates, expected-count lists, or scan roots changed in any
of the 11 files. Suite: 220/220, zero expected-failures. Reviewed by Grok
(`grok-4.6`, `--effort xhigh`, read-only sandbox against the real diff):
SHIP on all 11.

## The bigger thing worth recording: origin moved out from under a
## build-complete diff, twice, in the ~20 minutes before landing

This diff (11 dotfile fixes) was built alongside 4 other changes — all
sitting uncommitted in a worktree, believed to be additions to PR #367
("existing open PR"). By the time this session went to land the whole
batch:

- **PR #367 itself had already been merged** by the owner
  (`nicknsheth-beep`), despite its own title (*"ci: add GitHub Actions CI
  (lint + verify suite) — DO NOT MERGE"*) and an explicitly unchecked
  `[ ] DO NOT MERGE` line in its own body checklist. The remote branch
  `ci/github-actions-verify-suite` no longer existed — "commit and push onto
  the existing branch/PR" was no longer possible as instructed, because the
  PR was closed.
- **All four of the known-failures PR #367 shipped with in
  `scripts/expected-failures.json` had independently been fixed and merged
  as their own small PRs** — apparently by a separate concurrent session —
  in roughly the 20 minutes before this session got to `git push`:
  - #370 `fix(campaignRun): remove dead startedAt rewrite from ADGEN
    handoff flip (F2)` — `routes/ads.js`
  - #371 `fix(ingest): reconcile background-work trigger counts for
    C2/D1/E1` — `scripts/verifyIngestBackgroundWorkSurvives.js`
  - #372 `fix(verify): repoint verifyCostAttribution 7k/7l off stale
    literal-text anchors` — `scripts/verifyCostAttribution.js`
  - #373 `fix(director): restore Anthropic direct twins as named
    LLM_AUTH_MISSING skips` — `services/atlasModelMap.js`

This session's own uncommitted diff had independently arrived at
functionally the same four fixes (drafted by Grok, xhigh, reviewed here —
see below). Caught by **re-diffing against a freshly-fetched `origin/main`
instead of trusting the branch state the diff was originally built
against**: `git diff origin/main -- <file>` showed `routes/ads.js` and
`services/atlasModelMap.js` were **byte-identical** to what had already
landed; `scripts/verifyCostAttribution.js` and
`scripts/verifyIngestBackgroundWorkSurvives.js` were the same underlying
fix with different implementations (origin's `verifyCostAttribution.js` fix
is actually **more robust** than the one this session had drafted — a
brace-balanced `captureCallArgs` parser vs. a naive `indexOf('})', ci)`
boundary that a nested `})` inside the captured call could have truncated
early).

**Resolution**: adopted origin's already-merged, already-reviewed versions
of those four files (`git checkout origin/main -- <file>` for each) rather
than re-landing a competing copy that would have either been a no-op or a
regression in robustness. Rebased the branch onto current `origin/main`
(`git checkout -b fix/verify-suite-dotfile-race-remaining-walks origin/main`
— applied the 11 genuinely-still-needed files cleanly, since none of the
intervening PRs touched them) and opened a **new** PR (#374) carrying only
the still-outstanding work, since #367 was closed and there was no open PR
left to add to.

## Adversarial review of the three already-merged money/lifecycle changes

Even though #370/#372/#373 were already merged by the time this session's
own adversarial-reviewer pass came back, the review still ran (against the
committed tree, re-verified) — reasonable due diligence given the risk
class (Director LLM failover, CampaignRun lifecycle, cost attribution), and
it surfaced two real, non-blocking follow-ups worth picking up separately:

1. **`docs/turn-on-anthropic-direct.md` is now stale.**
   `services/atlasModelMap.js`'s restored-twins comment (~line 188-192)
   points at this doc as the tracker for the "add `ANTHROPIC_API_KEY`"
   follow-up, but the doc's own Context section still says *"both Anthropic
   direct twins were replaced with `direct: null`"* and its step 4 still
   instructs restoring them — already done by #373. Step 5 ("delete this
   file" once done) wasn't taken either. Whoever picks up the
   `ANTHROPIC_API_KEY` follow-up starts from a false premise.
2. **`DIRECT_URLS` (`services/atlasLlmService.js:39-42`) has no `anthropic`
   entry**, and neither the restored code comment nor
   `docs/turn-on-anthropic-direct.md` mentions this. The doc's only
   forward-looking instruction (lines 76-80) says to add *only* a
   `DIRECT_KEYS.anthropic` entry. Followed literally and with no `DIRECT_URLS`
   fix, `services/atlasLlmService.js:420` evaluates
   `post(DIRECT_URLS['anthropic'], …)` → `axios.post(undefined, …)` →
   **throws `ERR_INVALID_URL`** (verified by execution). It's caught and
   coded, so no money leaks, but it reproduces the exact "configured
   fallback that cannot actually fire" shape this whole restore exists to
   prevent — on the day someone finally tries to turn it on. One extra line
   needed alongside the `DIRECT_KEYS` one whenever that follow-up happens.

Two more notes, neither a defect: `routes/ads.js:1734-1736`'s comment still
claims the (now-removed) `startedAt` write was needed to flip the operator
UI out of "preparing" — false on all 3 call sites, the CAS/create already
does that; and `verifyPreparingReap.js` F2's regex is scoped only to
`routes/ads.js` and can't cross a nested `}`, so a future `$set` touching
`startedAt` from `services/` or behind a nested object literal would slip
past it uncaught. Nothing currently does either.

Full adversarial-reviewer transcript available on request; not reproduced
verbatim here to keep this entry a reasonable length. Verdict on all three
already-merged changes: **SHIP**, no defects found that would have blocked
#370/#372/#373.

## Deploy

Both backend services (`liquidretail_backend` web
`srv-d1vuktqli9vc73ft07ng`, worker `srv-d8128c1o3t8c73e8kb30`) auto-deployed
on merge and confirmed `live` on commit `175968db`
(`https://liquidretail-backend.onrender.com/` responds; Render deploy
status API confirms both `live`).
