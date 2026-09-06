> ## RECOVERY HEADER — added 2026-09-03
>
> This file was recovered from a six-day-old **untracked** copy (last modified
> 2026-08-28) in the shared `liquidretail_adgen` checkout, which would otherwise
> have been lost. It documents a dead session's work — not any session running
> now. **The body below is verbatim and unchanged**; corrections live here, in
> this header, never by editing the original record (its value is the
> contemporaneous account, including what turned out wrong).
>
> All inline line references in the body (e.g. `atlasVideoService.js:318`) are
> **historical**, anchored to adgen `master @ c02c7ff` (= PR #75) as it stood on
> 2026-08-27. Verified against current trunk on 2026-09-03 (this worktree,
> `feat/benefits-to-directors`, rebased onto `origin/master`, 39 commits ahead of
> `c02c7ff`):
>
> - **§1 MONEY — poll ceiling resubmits instead of resuming — ALREADY FIXED.**
>   Landed the same day as this doc: adgen PR #82 (`8eb3e5d`, "bound the
>   unsettled-timeout claim loop and size the poll ceiling (MONEY)") plus
>   hardening follow-ups #83 (`020da59`), #84 (`b87adbc`), #85 (`9f41215`), #87
>   (`b8813ae`). `MAX_POLL_MS` was raised 600000→900000, citing this doc's own
>   p99/max=760.3s measurement in the code comment. A receipt-holding row is now
>   **kept** claimed and `'rendering'` (never released to `claimOne`) so
>   `bootRecoveryService`'s free poll collects a late completion for $0; only a
>   receipt-free row is released. `VIDEO_UNSETTLED_MAX_ATTEMPTS` (floor 2,
>   default 3) caps the release branch via the pure `resolveUnsettledTimeoutAction`
>   (`spendReceipt.js`), with an ad-scoped Slack alert on any repeat. #83 fixed a
>   retry-ladder wall-clock regression #82 itself introduced (900s×3≈45min →
>   900+300+300≈25min). Confirmed present today in `src/services/renderer.js`
>   (`settleUnsettledVideoTimeout`) and `src/services/spendReceipt.js`. Nothing
>   further to do here.
> - **§2 `buildReferenceImages` never dedupes by image content — STILL TRUE, and
>   the one live, money-relevant item in this file.** Confirmed on current
>   trunk: the default (non-packshot-ranking) catalog-alt loop still checks only
>   `seenMediaIds`, not `seenUrls` (now ~`atlasVideoService.js:3762-3773`). A new
>   `VIDEO_PACKSHOT_PROTECTED_RANKING` path (adgen PR #106, `9e944c8`, merged
>   **today**, 2026-09-03, default now ON) adds a `seenUrls` check inside its own
>   loop, but `seenUrls` remains raw URL-string equality — no perceptual/pixel
>   dedupe exists anywhere on this path (grepped for `perceptualHash` / `pHash`
>   / `imageHash` / `pixelDiff` / `contentHash` — none found). No branch or PR
>   named `fix/reference-legibility` was ever merged, or found open. **A
>   Cloudinary-mirror vs raw-merchant-CDN duplicate of the same photograph can
>   still silently occupy two of three reference slots on a live ~$0.90 video
>   generation.**
> - Owner-decision guardrails in §2's table: `REPEAT_PRIMARY_REFERENCE=false` and
>   `MAX_DISTINCT_REFERENCES=5` — **still true**, unchanged defaults. "No default
>   shot-type ranking" — **partially superseded**: PR #106 (today) turned
>   `VIDEO_PACKSHOT_PROTECTED_RANKING` ON by default, an owner-approved but
>   *narrower* shot-type-aware reorder (protects slot-0 packshot for text
>   fidelity); the general `VIDEO_DEFAULT_REFERENCE_SHOT_TYPES` dial this doc
>   warned against defaulting-on remains unset/off. Does not touch the
>   content-dedupe finding above.
> - "#350 reference-distinctness diagnostic" (§2) — **cannot verify**. No commit,
>   PR, or file by that name/number found anywhere in adgen git history or the
>   current tree.
> - **§3 `executionTime=0` process lesson — still true / informational.** The
>   cited sentence is still present verbatim in current adgen `CLAUDE.md:874`. No
>   code claim to verify.
> - **§4 stale 8s comment — still true, not fixed** (cosmetic, not money).
>   Identical text is still at `atlasVideoService.js:5015` (echoed at `:796`) on
>   current trunk; the 10s duration floor it contradicts is still confirmed
>   (`config/defaults.env` `META_VIDEO_DURATION_SEC=10`).
> - **§4 cost-curve reconciliation ($0.45@4s / $0.90@10s / model 1.333× high) —
>   still true**, historical measurement, unchanged, consistent with backend
>   `CLAUDE.md` §2's own "~33%" figure.
> - **§5 review rule / PR #81 depends on #75 — still true**, and cleanly so
>   today: `c02c7ff` (this doc's own anchor) *is* PR #75
>   (`fix(bootRecovery): stop adgen's own sweep stomping the titler handoff
>   (#75)`). PR #81 (`d0dac44`) is confirmed merged after it.
>   `feat/distributed-lease` (#79, `5645582`) — flagged as a hard Phase-B
>   prerequisite — is also confirmed merged. Nothing to correct; the process
>   lesson stands as general practice.
>
> **Cross-repo note.** The sibling entry this doc points readers at,
> `../liquidretail_backend/session.d/2026-08-27_video-livelock-and-two-refuted-hypotheses.md`,
> is **also untracked / stranded** in the backend repo (confirmed via `git
> status` there: `??`, 17.5 KB, last modified 2026-08-27 — one day older than
> this file). It was not rescued as part of this pass and needs the same
> treatment.
>
> **Bottom line for tonight:** of everything recorded below, only the §2
> reference-stack content-dedupe defect is still live and money-relevant — the
> poll-timeout livelock this file is titled after (§1) is already fixed.

---

# 2026-08-27 — the video poll livelock, and the reference stack ships two views not three

Documentation pass; no code changed. **The full cross-repo narrative, including the refuted
hypotheses and the session's own retractions, is
`../liquidretail_backend/session.d/2026-08-27_video-livelock-and-two-refuted-hypotheses.md`.**
This entry keeps the parts whose *code lives in this repo*, with line references against
`master` @ `c02c7ff`.

---

## 1. MONEY — the poll ceiling resubmits instead of resuming

**Ten distinct billable Atlas predictions for one ad in 2h21m. ~$5/hour at $0.90 settled.**

Every hop is in this repo:

| step | site | what happens |
|---|---|---|
| 1 | `atlasVideoService.js:318`, loop `:3741` | `MAX_POLL_MS` = **600000**. `ATLAS_TIMEOUT_MS` is in neither `config/defaults.env` nor `render.yaml`, so the code default runs. |
| 2 | `atlasVideoService.js:3890-3898`, `:3945` | deadline peek sees `processing` → throw with `err.unsettledAtTimeout = true` |
| 3 | `renderer.js:1784-1787` | `releaseClaim` + `bumpRunCounter('skipped')`, `status` stays `'rendering'`. **No `$inc renderAttempts`.** |
| 4 | `renderer.js:687-696` | `claimOne` filter is `{status:'rendering', claimedByWorker:null, renderRoute:{$in:[…]}}` — **no receipt predicate**. Re-claimed in ~500ms (`ADGEN_POLL_MS` 500). |
| 5 | `atlasVideoService.js:3535-3547`, `:4645-4667` | `shouldResumeAttempt` needs `typeof existingPredictionId === 'string' && length > 0`. **Ten distinct ids prove it was false every cycle** → `submitGeneration()` at `:4666`, a new billable POST, then `$set veoPredictionId` to the new id at `:4691`, orphaning the previous in-flight job. |
| 6 | `adStage.js:83-86` | `updatedAt` refreshed every poll tick (throttle 3s, interval 15s), so `bootRecoveryService.resumeInFlightAds` — `status:'rendering'` + receipt + `updatedAt` older than `RESUME_STALE_MIN` (5 min) — **never sees the row**. |

**One orphaned prediction completed at 760.3s and was never collected.** Had step 3 stopped
reclaiming, the `bootRecoveryService` sweep wired here on 2026-08-26 would have peeked at
t≈900s, found it `done`, and collected it for **$0**. The livelock defeats our own free
recovery path.

**No lifetime cap sees the loop.** `renderAttempts` is `$inc`'d only on the static-success,
derive-inherit and master-success writes, so it stayed **0** through all ten cycles.
`strandedRunSweeper` / `queuedArchiveSweeper` are not started from `entrypoint.js` and would
not match `'rendering'` anyway. `maybeFinalizeRun` returns early while any ad is `rendering`.
`RUN_HEARTBEAT_MAX_MS` (4h) `clearInterval`s without writing `CampaignRun.status`, and 2h21m
never reached it.

**`renderer.js:1770-1775` asserts this path "can only ever cost more poll time, never a second
charge." That is false.** Fix in flight: `fix/video-master-timeout-livelock`.

### On raising the ceiling

Don't — the owner's read is that a 10-minute generation is itself pathological, and the defect
is step 5. But the **stated justification** for 600s no longer holds and should not be
re-cited. Backend `CLAUDE.md` §2 records the 2026-08-19 decision as *"n=28, Aug 14-19,
p99=215s/max=215s, ~2.8x headroom."* Re-measured n=68 completions through 2026-08-27:

| | Aug 14-19 (n=28) | Aug 20-27 (n=68) |
|---|---|---|
| median | — | 178.7s |
| p90 | — | 456.2s |
| p99 / max | **215s** | **760.3s** |
| over the old 215s max | 0% | **36.8%** |
| over the 600s ceiling | 0% | **1.5%** |

## 2. `buildReferenceImages` never dedupes by image content

Verified in code, `atlasVideoService.js:2826-2911`. Three dedupe keys, none of them content:
`seenMediaIds` (Media `_id`), `seenUrls` (`fileUrl`), and later a final-reframed-URL set.

**The precise hole:** the operator-ordered branch checks both `seenMediaIds` and `seenUrls`, but
the **catalog-alt loop checks only `seenMediaIds`** (`:2886-2892`) — no `seenUrls` test at all.
So two Media rows pointing at the same photograph via different URLs (Cloudinary mirror vs raw
merchant CDN) both enter the stack, because their `_id`s differ.

Measured: refs 0 and 1 are the same photograph — garment-normalised pixel diff **4.02**,
against 35+ for genuinely different views. **A nominally three-slot reference stack delivers
two distinct views: the primary packshot twice, plus one on-model shot.**

⚠️ **#350's reference-distinctness diagnostic cannot rule this out — its silence is not proof
of variety.** Flagged by its own author: two of its three arms miss the real production case,
because when each CDN URL owns its own Media row **nothing collapses**, so the check reports
full distinctness and says nothing. Only a filename heuristic catches it, and it is labelled a
heuristic. **No pixel comparison exists anywhere in it.** Fine for a first diagnostic — but do
not ever cite it as having ruled duplicates out.

Why it matters beyond tidiness: the on-model shot is the **only** reference carrying a legible
brand mark (the two flat product refs carry none under contrast), so a wasted slot directly
halves the mark's representation. That feeds the leading — **not yet confirmed** — explanation
for logo hallucination: the model receives one small, low-contrast instance of the mark and
none in the opening frame it anchors on, so it fabricates one. The confirming two-cell
experiment was killed by the ~4h14m fleet outage and **has not returned.**

### ⚠️ Polarity — read before "respecting the owner decision"

| decision | date | reason | forbids |
|---|---|---|---|
| `REPEAT_PRIMARY_REFERENCE=false` | 2026-08-03 | *"repeating the primary increased hallucination"* — in-code at `atlasVideoService.js:2921` | flipping the repeat on as the fix |
| `MAX_DISTINCT_REFERENCES=5` | 2026-08-03 | owner's *"too many images hallucinated"* | adding reference slots |
| no **default** shot-type preference; pure feed order | 2026-08-05 | *"the primary image as defined by the merchant feed is the main image … The Hero stamp is not relevant"* | making shot-type ranking the default to surface a logo-bearing ref |

Production is **accidentally duplicating the primary reference** — exactly what row 1 was set to
prevent. So a content-dedupe fix **enforces** that owner decision rather than reversing it.
This is the inverse of the usual trap: a session that reads "owner decision, don't touch" and
walks away leaves a real defect in place. Row 3 is the genuine trap — shot-type ranking looks
like the obvious fix for the duplicate-view problem and *is* a reversal; the dial already
exists (`VIDEO_DEFAULT_REFERENCE_SHOT_TYPES`, a strict no-op when unset, an opt-in reorder over
feed order), and defaulting it on is what 2026-08-05 forbids. Work in flight:
`fix/reference-legibility`.

## 3. `executionTime` — this repo's CLAUDE.md already said it

The bottom of `CLAUDE.md` (RPD findings) reads: *"**Atlas publishes `executionTime=0` on that
video model** — it is not a usable latency signal."* **Two sessions burned hours re-deriving
this**, building a whole "inference never started" theory on it, including a proposed
pre-submit validator that was separately measured as useless for the failure class.

Measured now, twice over: `executionTime: 0` and `timings.inference: 0` on **13 of 13** in
tonight's run ledger (**including all 11 successes**) and **72 of 72** in a wider sweep
(**68 successes**). The real field is **`latency_ms`** — successes 119,963–760,255 ms (median
178.7s), failures 65,826 / 166,550 / 183,030 / 288,648 ms. So failures consume 1–4.8 minutes of
real provider time, and their durations sit *inside* the success band.

**Process lesson for this repo specifically:** before reasoning from a provider response field,
grep `CLAUDE.md` and `session.d/` for its name. The knowledge was written down; it just wasn't
where anyone looked.

## 4. Two smaller items

**Stale 8s comment.** `atlasVideoService.js:4046-4047` says *"the 8s output is a downstream
contract (brand scripts assume 8s @ 24fps)."* Every mint-time floor is 10s
(`GOOGLE_PMAX_VIDEO_DURATION_SEC`, `DEFAULT_META_VIDEO_DURATION_SEC`,
`META_VIDEO_DURATION_SEC=10`). **The comment is stale, not the duration** — the universal 10s
floor is the owner directive of 2026-08-18 and Google rejects PMax video under 10s. A session
that trusts the comment and restores 8s reverts an owner directive and breaks PMax ingest.

**The cost curve is now pinned at two points, and the per-second shape is correct.**
`MODEL_CAPS` models `base 0.20 + 0.10/s`. Settled: **$0.45 at 4s** (this repo's `CLAUDE.md`,
RPD run 2026-08-18) and **$0.90 at 10s** (68 of 68 tonight). Solving both:
**settled ≈ $0.15 + $0.075/s — exactly 75% of the modelled coefficients in both terms.** So the
model is uniformly **1.333× high** (the undeclared developer-variant discount), not
structurally wrong, and duration really is a cost lever. Note our two repos state the same
ratio inconsistently — backend `CLAUDE.md` says *"~33%"*, this repo's says *"~25%"*; $1.20/$0.90
= 1.33 and $0.90/$1.20 = 0.75. Prefer the 33% framing: it names the error in the number we
compute. Worth reconciling the two files.

## 5. Review rule to carry forward

> **Completeness is a property of the base, not the diff. A rebase onto an older master
> silently reopens the defect while the tests still pass.**

Live instance here: **PR #81 (titler dual-claim) only closes its defect on a base containing
#75** — without #75, `bootRecoveryService` still *creates* the state #81's stamp prevents.
Verified: `git merge-base --is-ancestor c02c7ff HEAD` → true, and #81 is 0 behind
`origin/master`, so it is complete **as based**. **Re-verify after every rebase** — nothing in
the suite will catch its loss. This matters immediately for the sequenced Phase B work, where
`feat/distributed-lease` (#79) must land and be proven *before* any expansion wiring.
