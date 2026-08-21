# The titling-resume reclaim had no bound — an ad could cycle claim→abandon→reclaim forever

Branch `fix/titling-claim-staleness`, based on current `origin/main` (`c27df039`, includes
#278/#279). **Not committed, not pushed, no PR.** Lives only in an isolated worktree —
see the checkpoint note at the bottom for the exact path.

## Task

Investigate a report that a live "Everything" preset run on Pelagic Gear
(`run_1787266578461_70865bdd`, "Marco Polo Lured") delivered 14 video ads as
`status:'draft'` with a non-empty `renderUrl`, 13 of which were the raw untitled Omni
master (`renderUrl === veoVideoUrl`), each `titlingResumeState:'claimed'`. The task
brief's hypothesis: `titlingResumeService.js`'s claim mechanism has no staleness timeout,
so a claim interrupted by SIGTERM is never re-driven.

## Established facts (file:line)

- **The prompt's hypothesis was false.** `services/titlingResumeService.js:105-121`
  (`buildResumeFilter`) already has a working staleness re-claim: arm 2 matches
  `titlingResumeState:'claimed'` + `updatedAt < now - CLAIM_STALE_MIN` (15 min default).
  Confirmed via a read-only `render jobs create` probe against the live web service's DB
  (`srv-d8128c1o3t8c73e8kb30`, `job-da3prp67bikc73bis52g`, 2026-08-21T00:38Z): **0 ads**
  currently sit in any arm of the resume filter; all 39 ads on the named run are
  `titlingResumeState:null` with `renderStage:'done'`. The run healed itself before this
  session started — consistent with `session.d/2026-08-20_titling-delivery-truth-fix.md`
  (PR #278), which documents the same run and the same reclaim already working live.
- **The real defect: the reclaim is unbounded.** Nothing counted how many times one Ad had
  been claimed. `services/titlingResumeService.js`'s claim write (`Ad.updateOne(claimFilter,
  {$set: claimSet})`, pre-fix) had no counter. An ad whose titling can never finish inside
  one process lifetime — a deploy/autoscale replacement storm (PR #278 identified
  `REMOTION_QUEUE_CONCURRENCY` 4→8, PR #274, as an unvalidated, plausible trigger — not
  re-investigated here, out of scope), or a render heavy enough to OOM the process (killed
  it once already, 2026-08-04, per `index.js`'s re-entrancy comment) — cycles
  claim→die→reclaim with no exit.
- **Consequence 1 — no terminal verdict, ever.** The ad stays `titlingResumeState:'claimed'`
  forever, which reads as "in flight," never surfaced as needing attention.
  `scripts/verifyTitlingResume.js` (35 checks pre-fix: 27) and
  `scripts/verifyTitlingOrphanResume.js` had zero checks asserting any bound on claim count
  — confirmed by reading both files and by a Grok trace (independently corroborated) that
  found no `titlingResumeAttempts`-shaped field anywhere in the repo pre-fix.
- **Consequence 2 — the alarm built for this is structurally blind to it.**
  `services/backlogWatchdog.js`'s existing "titling stuck" arm
  (`ALERT_TITLING_STUCK_MIN`, 45 min default) keys on `updatedAt` idle time. Every reclaim
  WRITES `updatedAt` (it's part of `claimSet`), and a reclaim happens at most
  `CLAIM_STALE_MIN` (15m) + the sweep interval (5m) ≈ 20m after the previous touch — under
  half the alert's threshold. So the alarm can only ever fire on an ad the sweeper has
  STOPPED reaching, never on one actively (and fruitlessly) cycling. This is the exact shape
  of the incident PR #278's own comment describes ("a batch of Remotion renders stalled for
  11-15m straight through an autoscale replacement storm") with zero signal.
- **`services/adArchiveDigest.js`'s `REQUEUE_SITES` ledger and `Ad.wasRendering` do NOT cover
  this** — verified by reading the ledger (8 sites, all keyed on a `'rendering'→'queued'`
  transition) and grepping `wasRendering` in both `titlingResumeService.js` and the
  `routes/ads.js` titling block: zero occurrences. Confirmed distinct from, not already
  closed by, the `wasRendering` family — this session's premise to verify, not assume.
- A free, non-billable manual re-drive path already exists
  (`scripts/retitleDriver.js` — structurally incapable of reaching Omni, confirmed via its
  own header comment and by grep), which is what makes bounding the automatic retry safe:
  giving up automatically doesn't strand the ad, it just stops burning a Remotion render on
  a proven-futile ad until a human re-drives it for free.

## The fix

- `models/Ad.js`: new declared field `titlingResumeAttempts` (Number, default 0) — declared,
  not reused, per this repo's own established trap (`titlingResumeState`'s own header
  comment) that an undeclared Mongoose-strict path is silently dropped on write.
- `services/titlingResumeService.js`:
  - `RESUME_MAX_ATTEMPTS` (env `TITLING_RESUME_MAX_ATTEMPTS`, default 3).
  - `buildResumeFilter`'s stale-claim arm now also requires
    `titlingResumeAttempts < max OR $exists:false` (the `$exists` escape is load-bearing —
    every ad already stuck `'claimed'` in production today predates the counter and would
    otherwise be permanently excluded from recovery, turning a fix for a leak into a wider
    leak).
  - New `buildExhaustedClaimFilter` / `markExhaustedClaims`: a separate pass, run BEFORE the
    main find in `resumeUntitledMasters` (so a permanently-failing ad — sorted oldest-first —
    can't starve every other ad behind it), that writes an honest terminal verdict
    (`status:'failed'`, `titlingResumeState:null`, `renderError.stage:'titling'`,
    `renderStage:'master rendered; titling abandoned'`) — paid master left untouched on
    `renderUrl`/`veoVideoUrl`, never discarded.
  - The claim write's CAS now `$inc`s `titlingResumeAttempts` on the SAME `updateOne` as the
    claim itself (atomic with the race arbiter — counting on a second write could miss the
    attempt that then died, or double-count a lost race).
- `services/backlogWatchdog.js`: second arm on the existing titling-stuck alert,
  `TITLING_CYCLES` (env `ALERT_TITLING_CYCLES`, default 2, floored at 2 so ordinary
  single-claim recovery never pages), querying `titlingResumeAttempts >= cycles`
  independent of idle time — the query stays `titlingResumeState:{$in:[pending,claimed]}`
  AND `(idle OR cycling)`, not accidentally a top-level OR.

## Harness (extended, not new files — 3 files, 21 new checks total, all revert-proven)

- `scripts/verifyTitlingResume.js`: 27→35 (T19-T23: schema declaration, atomic `$inc`, the
  `$exists` escape, the exported exhausted-claim filter/shape, the honest-verdict wording).
- `scripts/verifyTitlingOrphanResume.js`: 26→32 (F1-F9, behavioral against the real
  functions — partition invariant between the two filters, the pre-counter regression
  guard, `markExhaustedClaims` never touches `renderUrl`/`veoVideoUrl`, the claim's `$inc` is
  on the same write as the CAS). Extended the local Mongo matcher with `$gte`/`$exists`
  (repo convention: models real Mongo "missing field" semantics, not JS `undefined`
  shortcuts).
- `scripts/verifyTitlingDeliveryTruth.js` (PR #278's harness): 36→42 (B4-B6: the new
  watchdog arm, its floor, and that it's a true AND-gate not an accidental OR).

**Revert-proven by hand, 7 mutations, each restored after confirming the harness caught
it:** dropped the `$exists` escape (2 harnesses failed, 4 checks); dropped the `$inc`
(2 harnesses, 2 checks); had `markExhaustedClaims` clear `renderUrl` — the actual money
hazard (2 harnesses, 2 checks); mislabeled the give-up as `"no titling ("` — the exact
string that means "deliberate," which would relabel an abandoned render as intentional
(2 harnesses, 3 checks); dropped the claim's re-assertion filter (race hazard — 1 harness,
1 check); undeclared the schema field (1 harness, 1 check — the silent-drop trap); widened
`$lt`→`$lte` (off-by-one — 2 harnesses, 6 checks, cascaded as expected since the harness's
own regex is exact-match).

## Gate

- ESLint clean on all 6 touched files (`models/Ad.js`, `services/titlingResumeService.js`,
  `services/backlogWatchdog.js`, and the 3 verify scripts).
- Full offline suite: **182/182**, after fixing the documented `https-proxy-agent`
  worktree trap (`npm install --no-save https-proxy-agent@5.0.1` + restore
  `node_modules/.package-lock.json` — this left zero `git status` diff in `node_modules`,
  confirmed).
- An xhigh-effort Grok adversarial review of the full diff (money/race/off-by-one focus,
  9 numbered questions) was launched and still running when this note was written — its
  result has NOT yet been read or acted on. Check the task output before trusting this
  fix is fully reviewed.

## State / next action

- **Not committed. Not pushed. No PR.** Waiting on explicit go-ahead from Nick (asked
  in-conversation; a peer session's checkpoint request is not sufficient authorization to
  commit under this session's own standing rule).
- Once authorized: commit the 6 files above, push `fix/titling-claim-staleness`, open a PR
  referencing this note, run the repo's PR checks, report the PR number back.
- Read the Grok adversarial-review output (background task, prompt at
  `scratchpad/grok/review.md`, diff at `scratchpad/grok/titling-fix.diff`) before merging —
  it was not yet incorporated as of this note.

## Dead ends / things NOT to re-derive

- Do not re-investigate whether `wasRendering`/`REQUEUE_SITES` already covers this — verified
  directly, it does not (see above), and re-checking costs a full re-read of
  `adArchiveDigest.js` for nothing.
- Do not re-run the "is the production run still stuck" check — it is not; the 39-ad run is
  fully settled (probe above). If a NEW stuck run is reported, that's fresh evidence, not a
  contradiction of this note.
- The `REMOTION_QUEUE_CONCURRENCY` 4→8 raise (PR #274) as a possible root cause of *why*
  processes keep dying mid-titling is flagged in PR #278's note and NOT re-investigated or
  touched here — this session's fix is bookkeeping (bound the retry, make it visible), not a
  fix for whatever is killing the process. If titling deaths continue after this lands, that
  knob is the next thing to check, not this fix.
