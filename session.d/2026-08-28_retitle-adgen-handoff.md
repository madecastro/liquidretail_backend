# Manual retitle → adgen handoff: verdict + implementation (2026-08-28)

## The ask

Confirm whether moving backend's manual retitle routes
(`routes/brand.js`: `/retitle-videos`, `/title-still`, `/title-spec/modify`)
onto adgen's titler engine would genuinely be "more scalable", per the
owner's stated assumption — and only build it if the premise holds.

## Verdict: holds for ONE of the three routes, not all three

- **`/retitle-videos` — YES.** Confirmed sync-in-process: the batch job's
  worker pool (concurrency 1-4) calls `renderBrandScriptAndSave` directly
  inside the web process serving HTTP traffic — the exact CPU-isolation
  problem adgen's titler role exists to solve for the automatic
  post-generation path. Moving it off the web process is a real win.
- **`/title-still` — NO.** A synchronous ~1-3s interactive preview loop
  ("Powers /title-playground"). Routing it through an async claim-based
  remote worker would add latency variance and defeat its entire purpose.
  Left untouched.
- **`/title-spec/modify` — NOT APPLICABLE.** Not a Remotion render at all —
  an LLM call (`atlasTextService.generate`) that edits a JSON spec. Doesn't
  belong in this migration.

Scope narrowed to `/retitle-videos` only, based on this finding.

## What the "mirror regenerateAd()" instruction actually required

Traced the real regenerate handoff (backend PR #345/#347, adgen PR #72):
backend's `regenerateAd()` stamps `Ad.regenerationRequest` and returns;
adgen's `services/regenerateConsumer.js` polls, claims via a SEPARATE
`regenerateClaimedByWorker` field pair, and executes through its own
vendored `adRegenerateService.runClaimedRegeneration`. This is the exact
template mirrored here — new field pair, new consumer, same `$type:'object'`
(not `$ne:null`) claim discipline, same `services/handoffContract.js`
formal contract declaration (bumped to v1.1.0, see
`docs/CONTRACT-backend-adgen.md` §4a in the adgen repo — the canonical copy
— for the full field table and mechanism).

**Why a NEW claim namespace, not a reuse of the titler's
(`titlingNeeded`/`claimedByWorker`):** that claim requires
`status:{$in:['rendering','draft']}` — built exclusively for "a master just
landed and has never been titled". Manual retitle's real target is commonly
`status:'live'`, delivered days or weeks earlier — the titler claim can
never match it. Confirmed by direct trace, not assumption.

## The severest finding: a live production bug, independent of this work

`brandScriptExecutor.uploadRenderAndStamp` forces `status:'draft'` on
**every** call, unconditionally, in **both** repos' copies. This is correct
for the first titling pass right after generation. It is a live bug for
manual retitle: **every retitle-videos call today already silently
un-publishes a `status:'live'` ad**, success or a QC fail — this predates
the adgen-handoff work entirely and fires on the CURRENT in-process path,
right now, regardless of `ADGEN_RENDERER_ENABLED`.

Fixed in both repos via a new `preserveAdStatus` / `retitleMode` option
threaded through `uploadRenderAndStamp` → `renderWithRemotionAndSave` →
`renderBrandScriptAndSave`, opt-in only (every existing caller is
unaffected). Backend's LOCAL retitle-videos runner (`runRetitleJob`, the
dormant fallback) now also passes `retitleMode:true` — that half of the fix
ships regardless of the flag. adgen's copy additionally needed the SAME
flag threaded past `stampTitlingFailureAndThrow` at all three of its
Remotion-failure call sites, since that function's whole job (bound
FIRST-titling retries via the shared `Ad.titlingAttempts` cap) also
describes a lifecycle a retitle isn't in.

Revert-proven: mutating either guard (in either repo) turns the
corresponding harness check red; restoring turns it green. See
`scripts/verifyRetitleAdgenHandoff.js` here, and
`liquidretail_adgen/scripts/verifyRetitleConsumerClaim.js`.

## What was built

- `models/Ad.js`: `retitleRequest` (Mixed), `retitleClaimedByWorker`
  (String), `retitleClaimedAt` (Date), `retitleResult` (Mixed) — schema
  parity with adgen's copy (Mongoose-strict-drop reason, same pattern as
  `titlingNeeded`/`titlingAttempts`).
- `routes/brand.js`: `runRetitleJobViaAdgen()` — new sibling of the
  existing `runRetitleJob` (untouched, the dormant fallback). Stamps
  `retitleRequest` per ad (filter requires `titlingNeeded:{$ne:true}` +
  `retitleRequest:null`), then polls Mongo for completion, preserving the
  exact same job-store contract (`status`/`progress`/`results`/`errors`)
  the existing `GET /:id/retitle-videos/:jobId` poll endpoint already
  serves. `isAdgenRendererEnabled()` (the same shared helper
  `runRenderLoop`/`titlingResumeService` use) decides which runner the
  route calls.
- `services/brandScriptExecutor.js`: `preserveAdStatus`/`retitleMode`
  threading (see above).
- `services/handoffContract.js`: v1.0.0 → v1.1.0, four new
  `CONTRACT_FIELDS` entries, digest regenerated.
- `docs/CONTRACT-backend-adgen.md`: version bump (canonical doc lives in
  adgen).
- `scripts/verifyRetitleAdgenHandoff.js`: 13 checks, revert-proven on the
  four most safety-critical (stamp filter's `titlingNeeded` exclusion, both
  `preserveAdStatus` guards, the local path's `retitleMode:true`).

## What was explicitly NOT done

- `/title-still` and `/title-spec/modify` — unchanged, per the verdict above.
- `qcAndStampVideoAd`'s QC-failure `status:'failed'` flip — a SEPARATE,
  shared, owner-decided (2026-08-20) function with five call sites across
  both repos. The "no chrome configured" retitle edge case still routes
  through it unguarded — a narrow, flagged, accepted residual (see
  `docs/CONTRACT-backend-adgen.md` §4a's closing note). Touching a
  shared, owner-decided function for a rare edge case was judged
  disproportionate to this change's scope.

## Baseline / verification

Pristine `origin/main` @ `64d35c67` baseline: 210/213 (`npm test`), 3
pre-existing failures (`verifyDirectorFallbackChain.js`,
`verifyPreparingReap.js`, `verifyRenderStages.js` — unrelated to this
change, confirmed pre-existing on a clean worktree before any edit here).
After this change: 210/214 (the +1 is this new harness passing), same 3
pre-existing failures plus one EXPECTED, SELF-RESOLVING transient:
`verifyHandoffContract.js`'s cross-repo byte-identity check reads adgen's
copy from `origin/master` (its actual trunk, not a sibling working tree,
by design — see that harness's own comment) — it cannot see this
uncommitted/unmerged work yet and will pass once both PRs land. Confirmed
NOT a real defect: `diff`-identical against the actual adgen worktree.

PR: https://github.com/Emami-RS-Project/liquidretail_backend/pull/359 —
`fix/retitle-adgen-handoff-be`. Companion adgen PR:
https://github.com/Emami-RS-Project/liquidretail_adgen/pull/93 —
`fix/retitle-adgen-handoff-ag`.

**Do not merge without the companion adgen PR** — this is a paired,
cross-repo contract change; landing one without the other leaves
`verifyHandoffContract.js` and `verifyModelParity.js` red on whichever
repo's trunk gets the change first (both are expected, transient, and
resolve once the second PR merges).

## Adversarial review (two independent Grok xhigh passes, one per repo)

Run before either PR was called done. Both converged on the same real
defect from opposite sides, plus corrected the money framing:

1. **Real: the stamp filter needed `regenerating:{$ne:true}` too.** Fixed
   — without it, a manual retitle could be stamped on an ad a regenerate
   is actively rewriting, wasting a Remotion slot, a Cloudinary upload,
   and a real vision-QC/face-detection Atlas LLM call on a result about
   to be superseded. `scripts/verifyRetitleAdgenHandoff.js` grew 13→16
   checks (B5/B6/B7), all revert-proven.
2. **Real: the local `runRetitleJob` never defensively cleared a stale or
   active deferred request on the same ad before rendering it locally**
   — fixed with an atomic lock write (`retitleClaimedByWorker:null` in
   the filter) that REFUSES to render locally if adgen currently holds an
   active claim (B7), and nulls a stale unclaimed request otherwise. The
   poll loop's "retitleRequest cleared, no result" branch was also wrong
   — it assumed success; fixed to report indeterminate failure instead
   (B6), since the only way to reach that shape is the NEW local-path
   guard racing an in-flight poll. A poll timeout now only clears
   `retitleRequest` when the row is confirmed unclaimed at that moment,
   never when adgen genuinely still holds it.
3. **Corrected: "retitle is confirmed FREE" overclaimed.** Vision QC
   (`adVisionQcService`) and face-detection for the safe-crop
   (`basePlateCropService`) both require `atlasLlmService.chatCompletion`
   — a real, billed Atlas LLM call made on every titling render
   (pre-existing, not something this change adds or removes). Accurate
   claim: no NEW Atlas VIDEO-GENERATION submit; the claim-safety concern
   is double EXECUTION of one request, not a double video charge.
   Corrected in `models/Ad.js`, `routes/brand.js`, `services
   /handoffContract.js`, this file, `session.md`, `CLAUDE.md`, and the
   canonical `docs/CONTRACT-backend-adgen.md` (adgen repo).
4. **Known, narrower, NOT fixed: a regenerate can still start while a
   retitle is already claimed and rendering** (the reverse of #1). Worst
   case is a last-writer-wins clobber between the retitle's stale output
   and the regenerate's fresh master — not a double bill (regenerate
   still submits exactly one Omni generation regardless). Judged
   disproportionate to fix by touching regenerate's own already-
   adversarially-reviewed, money-critical lock for this narrower,
   lower-frequency window. Flagged, not silently left undocumented.
5. Confirmed clean by both reviews: schema declarations match the writes;
   the titled-path status-preservation fix is correctly threaded through
   all three `stampTitlingFailureAndThrow` call sites (adgen); SIGTERM
   handling is sound; the no-chrome residual (already known/flagged) is
   confirmed unreachable today.
