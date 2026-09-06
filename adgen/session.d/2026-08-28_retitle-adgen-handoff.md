# Manual retitle → adgen handoff: retitleConsumer + status-preservation fix (2026-08-28)

Companion to backend PR (`liquidretail_backend` branch
`fix/retitle-adgen-handoff-be`, `session.d/2026-08-28_retitle-adgen-handoff.md`
there carries the full investigation and verdict). This entry is the
adgen-side implementation notes.

## Scope

Owner asked whether backend's manual `/retitle-videos` route would
genuinely be "more scalable" routed through adgen's titler engine. Verdict:
yes for this ONE route (it runs Remotion in-process on the backend web
server today — the same CPU-isolation problem the titler role exists to
solve). Backend's OTHER two manual-titling routes (`/title-still`,
`/title-spec/modify`) do not belong in this migration — see the backend
entry for why.

## New: `src/services/retitleConsumer.js`

A fourth claim namespace (`retitleRequest` / `retitleClaimedByWorker` /
`retitleClaimedAt` / `retitleResult`), modeled closely on
`regenerateConsumer.js`'s stamp-then-poll-claim-execute shape, but
DISTINCT from it in two ways forced by retitle making no NEW Atlas VIDEO-
GENERATION submit (it does still make the pre-existing vision-QC/face-
detection Atlas LLM calls every titling render makes — see the money
correction below):

1. **Runs a stale-claim reclaim sweep** (`reclaimStaleRetitleClaims`,
   mirroring `titler.js`'s `reclaimStaleTitlerClaims`) — the regenerate
   consumer deliberately has NO reclaim sweep, because retrying a
   regenerate would be a second billable submit. Retrying a retitle costs
   only time and a render slot, so auto-release on a stale claim is safe.
2. **Executes via `brandScriptExecutor.renderBrandScriptAndSave(...,
   retitleMode: true)`**, not a separate `runClaimedX` execution module —
   retitle is a single call into the existing render pipeline, not a
   multi-stage image/video dispatch the way regenerate is.

Wired from `renderer.js` `run()`/`shutdown()`, same lifecycle shape as
`regenerateConsumer` (own poll loop, own `{stop()}`, concurrent — not
sequential — SIGTERM drain).

## The severest finding: `uploadRenderAndStamp` forces `status:'draft'` unconditionally

Traced BEFORE writing the consumer, not after: `brandScriptExecutor
.uploadRenderAndStamp` hard-codes `status:'draft'` on every terminal write,
and its QC-failure path hard-codes `status:'failed'`. Calling this
unmodified from a manual-retitle consumer would silently un-publish any
`status:'live'` ad on every retitle, success or a QC fail — this repo's
copy AND backend's copy both had it (backend's independently, since it's
the pre-existing production `/retitle-videos` path today).

Fixed with a `preserveAdStatus` option on `uploadRenderAndStamp`
(default `false`, every existing caller unaffected), threaded through
`renderWithRemotionAndSave`'s `retitleMode` option, which ALSO routes a
Remotion child failure at all three of its call sites to a plain `throw`
instead of `stampTitlingFailureAndThrow` — that function's entire purpose
(bound FIRST-titling retries against the shared `Ad.titlingAttempts` cap,
hand an unfinished master to `titlingResumeState:'pending'` for the
automatic resume sweep) describes a lifecycle a manual retitle of an
already-delivered ad is not in. Reusing it would (a) burn the automatic
path's SHARED retry budget for an unrelated retry, and (b) still force
`status:'draft'`/`'failed'` onto a `'live'` ad on a `capExceeded` write.

Revert-proven (mutate the guard, confirm the harness goes red, restore,
confirm green) for every load-bearing condition:
`scripts/verifyRetitleConsumerClaim.js` groups E (uploadRenderAndStamp) and
F (all three `stampTitlingFailureAndThrow` call sites guarded).

## `services/handoffContract.js` v1.0.0 → v1.1.0

Four new `CONTRACT_FIELDS` entries. Kept byte-identical with backend's copy
(verified via `diff` against the actual worktree — `verifyHandoffContract
.js`'s own cross-repo check reads the SIBLING'S TRUNK via `git show`, by
design, so it will read red until both PRs merge; not a real defect, see
the backend session.d entry).

Canonical contract doc: `docs/CONTRACT-backend-adgen.md` §4a "Protocol D —
the manual retitle deferral" — full field table, both functions' exact
guard conditions, and the one known/accepted residual (the "no chrome
configured" skip branch still routes through the SHARED, owner-decided
`qcAndStampVideoAd`, unguarded — five call sites across both repos, judged
disproportionate to touch for a narrow edge case).

`scripts/verifyVendorDrift.js`'s `services/brandScriptExecutor.js` "fork"
entry reconciled to record this coordinated two-repo fix (was already
`status:fork` from earlier titling work — this adds one more mutually-
applied fix on top, not a new divergence).

## Baseline / verification

Pristine `origin/master` @ `a108753` baseline (bare worktree, no `npm ci`,
per this repo's own tooling trap notes): `npm test` → 77/81 non-expected +
1 `_KNOWN_OPEN` expected-fail, 2 unexpected pre-existing failures
(`verifyRemotionMemoryBudget.js`, `verifyVendorDrift.js` — both pre-existing
drift backlog from other work tonight, confirmed on the clean worktree
before any edit here). After this change: same 2 pre-existing failures,
PLUS the new `verifyRetitleConsumerClaim.js` (18/18, passing) and the
expected-transient `verifyHandoffContract.js` / `verifyModelParity.js`
(both read the SIBLING BACKEND's `origin/main`, which does not have this
work yet — self-resolving once the backend PR merges).

**Land together with the backend PR** — a partial land leaves the
cross-repo contract checks red until the second half arrives.

## Adversarial review (two independent Grok xhigh passes, one per repo)

Run before opening either PR was called done. Both passes independently
converged on the same real defect, plus corrected the money framing:

1. **Real: the stamp filter needed `regenerating:{$ne:true}` too** (both
   reviews found this independently, from the two different repos). Fixed
   in backend's `runRetitleJobViaAdgen` — without it, a manual retitle
   could be stamped on an ad a regenerate is actively rewriting, wasting a
   Remotion slot, a Cloudinary upload, and a real vision-QC/face-detection
   Atlas LLM call on a result about to be superseded by the regenerate's
   fresh master. `scripts/verifyRetitleAdgenHandoff.js` (backend) grew
   13→16 checks; new ones revert-proven.
2. **Real, backend-only: the local `runRetitleJob` never defensively
   cleared a stale/active deferred request on the same ad**, and the poll
   loop's "retitleRequest cleared with no result" branch assumed success
   when it should have assumed indeterminate failure. Both fixed
   (backend). Also fixed: a poll timeout now only clears `retitleRequest`
   when the row is confirmed unclaimed, never when adgen genuinely still
   holds it.
3. **Corrected: "retitle is confirmed FREE" overclaimed.** Vision QC
   (`adVisionQcService`) and face-detection for the safe-crop
   (`basePlateCropService`) both require `atlasLlmService.chatCompletion`
   — a real, billed Atlas LLM call, made on every titling render
   (pre-existing, not something this change adds or removes). The
   accurate claim: no NEW Atlas VIDEO-GENERATION submit; the claim-safety
   concern is double EXECUTION of one request, not a double VIDEO charge.
   Corrected everywhere this was stated (code comments in both repos'
   `models/Ad.js` and `services/handoffContract.js`, this file, `session
   .md`, `CLAUDE.md`, `docs/CONTRACT-backend-adgen.md`).
4. **Known, narrower, NOT fixed: a regenerate can still start while a
   retitle is already claimed and rendering** (the reverse of finding 1).
   Worst case is a last-writer-wins clobber between the retitle's stale
   output and the regenerate's fresh master — not a double bill. Judged
   disproportionate to fix by touching regenerate's own already-
   adversarially-reviewed, money-critical lock for this narrower,
   lower-frequency window. Flagged in `docs/CONTRACT-backend-adgen.md`
   §4a rather than silently left undocumented.
5. Confirmed clean (both reviews): schema declarations match the writes;
   the titled-path status-preservation fix is correctly threaded through
   all three `stampTitlingFailureAndThrow` call sites; SIGTERM handling is
   sound (reclaim sweep is the intended backstop); the no-chrome residual
   (already known/flagged) is confirmed unreachable today.
