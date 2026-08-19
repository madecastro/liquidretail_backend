## 2026-08-19 — Slack job status messages name who ordered the run

**MERGED to `main`** as `aa827fae` (PR #226, squash), branch deleted. Rebased onto `555fe8cb`
first — #220 (`fix/campaignrun-heartbeat`) had landed mid-session and also touched `routes/ads.js`
and `docs/ALERTING.md`; both regions were re-verified after the rebase rather than trusted to a
clean textual merge. Its heartbeat lands at `routes/ads.js` ~1724, *after* this change's await
point at ~1642, so they do not interact.

Suite **151 / 152**, lint clean. The one failure is `verifyLogoSilhouette` needing native `sharp`,
which does not resolve inside a git worktree via `NODE_PATH` — it passes in a normal checkout and
touches none of these files.

Files: `services/runFeedService.js`, `services/slackRunVerbosity.js`, `routes/ads.js`,
`scripts/verifyRunFeed.js` (§I, +13), `scripts/verifySlackRunVerbosity.js` (D4–D8, +5),
`docs/ALERTING.md`.

Run-feed parent head is now `▸ <run> · <brand> [· <product>] · <N> ads · by <who>`; the thread's
`run start` line and the four job-status alerts carry it too. **Mechanism, resolution order, and
the two independent paths that feed it live in `docs/ALERTING.md` → "Who ordered the run"** — read
that rather than re-deriving from the code.

**No schema change was needed.** `CampaignRun.requestedBy` already existed *and was already being
stamped* from `req.user.userId` by all five routes that create runs. The data was there; nothing
displayed it.

**Four traps this hit — worth knowing before touching this area again:**

1. **`User` has `displayName`, not `name`.** `GET /api/ads/render-activity` had been selecting
   `'email name'` with a `u?.name` fallback that could never fire. Fixed in the same pass.
2. **`renderOneInner` is a separate top-level function, not a closure in `runRenderLoop`.** A
   drafted `by: requesterLabel` in the video-failure alert was out of scope there — it would have
   thrown a `ReferenceError` inside the very catch block whose own comment warns a synchronous
   throw there "would skip the CampaignRun/Ad failure bookkeeping below, wedging the ad in
   `rendering`". **ESLint caught it; the 142-script suite did not.** Run `npx eslint` on changed
   files — the verify suite is not a substitute. The label now rides on `job.requesterLabel`, which
   already flows `runRenderLoop → renderOne → renderOneInner`.
3. **`verifySlackRunVerbosity` G18 regexes `stage: buildRunStartLine(` in runFeedService.** A first
   cut appended the requester at the call site and broke it. The guard's intent is "one builder for
   that line", so the fix was to thread `requesterLabel` *into* `buildRunStartLine` — not to loosen
   the regex. If you touch that line, keep the literal call shape.
4. **A best-effort "enrich once" lookup keyed only on `!label` retries forever** when the id
   resolves to nothing (deleted user). Latched on *attempt*. The adjacent brand-name enrich has the
   same shape and the same latent behaviour — it just rarely misses.

Every new assertion was revert-proven behaviourally (drop the head-line atom → 5 checks fail; drop
the run-doc copy → 4 different checks fail; make the builder ignore the label → D4/D5/D8 fail), so
neither new section passes vacuously.

**Note on the shared checkout:** `/Volumes/Sayulita/Projects/RS/liquidretail_backend` was 25
commits behind `origin/main` when this started, and `routes/ads.js` had moved +391 lines upstream.
This work was first built there, then rebuilt in the worktree; the shared tree was restored to
clean and is **still behind** — it was deliberately not pulled, in case another session is working
in it. Two hunks genuinely did not apply to current `main`, so do not assume a stale-base patch
here transfers: rebase and re-run the suite, never just retarget by hand.
