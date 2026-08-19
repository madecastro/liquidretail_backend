# Static pipeline survives image-model moderation rejections — PR pending

Branch `fix/static-moderation-fallback`, worktree at
`/private/tmp/claude-502/.../scratchpad/worktrees/wt-moderation-fallback`, based on
origin/main (rebased twice while landing: last onto `c633e2c1`, the tip as of this
write-up — main moved fast tonight, ~15 merges in a few hours).

## The incident (measured, not re-derived)

`run_1787136860887_654ed621` (Vuori 2, Women's Vuori Vintage Oversized Denim Jacket |
Bone Denim, `6a8572e6b31cf7b22149ca01`, "Everything" preset, 39 creatives): all 18
statics failed, HTTP code spread `{200:3, 400:10, 500:5}`, every one classified
`moderationBlocked` (`safety_violations=[sexual]`) against the SAME single catalog
seed — an ordinary Vuori e-commerce photo (open denim jacket over a black bralette,
bare midriff, plain studio background). `services/campaignAdsGenerationService.js`'s
`DIRECTOR_UNIVERSE_TOP_N=1` default means all 18 of a product's static payloads
(3 concepts × 6 surfaces) share exactly one seed — so one flagged photo currently
zeroes 100% of a product's static output, for any brand selling apparel/swim/
activewear/intimates, which is normal catalog photography, not an edge case.

## What shipped

**1. Stable error code taxonomy** — `services/atlasErrorPolicy.js` gains
`IMAGE_ERROR_CODES` (13 codes, `IMAGE_MODERATION_BLOCKED` etc.), one per policy,
mirroring `services/llmError.js`'s pattern WITHOUT merging into it (that module is
explicitly text/chat/embedding-only — `scripts/verifyLlmErrorCodes.js` A5 enforces
the boundary by grepping for the literal string; had to reword a comment that
innocently named the sibling module to stop tripping that regex). Threaded through
`services/renderService.js`'s `wrapped`/`failed()` (which also stopped **lying**
about `retryable` — it used to hardcode `stage !== 'validate'`, so a moderation
rejection, which is `give-up`/never-retryable by design, read as retryable) into
`routes/ads.js`'s `buildErrorEntry` → the ALREADY-DECLARED (for the LLM taxonomy,
generic `String`, unconstrained) `CampaignRun.errors[].code`/`.action` and a new
`Ad.renderError.code`. `GET /runs/:runId` gains a `moderationBlocked` rollup
(count + productIds + operator sentence), a structured complement to the
pre-existing `failureSummary` (which — checked before building this — ALREADY
correctly surfaces "Model Moderation Error" as a grouped reason via
`runFeedService.summariseFailures`'s text-parsed label grouping; the new field adds
a code-keyed signal immune to future message rewording, not a fix for a surface
that was silent before).

**2. Seed fallback** — `services/moderationSeedFallback.js` (new) + a
`submitEditImageWithSeedFallback` helper wired into
`services/directImageRenderService.js`. On a `moderationBlocked` rejection of a
product's SINGLE DEFAULT catalog seed (never an operator/Director explicit
multi-image `referenceMediaIds` stack — swapping one entry there without being
asked is exactly the silent-downgrade this must not do), tries the product's next
catalog image (ordered: `imageMediaId` then `additionalImageMediaIds`, the same
feed order used elsewhere in this pipeline) before giving up. Bounded: at most
`1 + STATIC_MODERATION_SEED_FALLBACK_MAX_CANDIDATES` (default 2) submits per
render call, ever. Coordinates across a run's creatives via a new
`CampaignRun.seedFallbacks` array (best-effort — a read/write failure just costs one
more wasted primary attempt on a later creative, exactly today's behaviour, never a
broken render) so creative #2..N for the same product skip a known-doomed seed
instead of re-discovering it. A successful fallback is stamped onto
`Ad.imageGeneration.seedFallback` (Mixed field, no migration) — visible, never
silent, per the "do not downgrade quality silently" requirement. Kill switch:
`STATIC_MODERATION_SEED_FALLBACK=false`.

**Why seed fallback and not the other three options, with evidence:**
- *Pre-flight screening*: no dedicated moderation/classification model exists on
  Atlas Cloud (checked live, `GET /api/v1/models` — zero hits for
  moderation/safety/nsfw). Would need a vision-LLM heuristic proxy, unproven, and
  the incident's own data shows a naive HTTP-status pre-check wouldn't help anyway
  (3/18 failures were HTTP 200 with an embedded `status:"failed"` body — already
  handled correctly by the EXISTING `atlasImageService.js` envelope check, unrelated
  to this fix, confirmed by reading it).
- *A different image model*: not pursued — no evidence gathered that another
  model's moderation is meaningfully looser, and switching the delivery model is a
  much bigger blast radius than swapping a reference photo.
- *Prompt-side mitigation*: genuinely live-tested (see below) — prompt content
  DOES matter, but `staticAdIntents.js` already deliberately forbids the specific
  softening lever (letting the model de-risk a worn garment into unpeopled/flat-lay)
  after a prior regression (the "PELAGIC jacket" incident documented in
  `staticAdIntents.js`'s own comments) where removing that fidelity constraint
  caused the model to photograph products off-body. Loosening it again is a product
  decision, not a mechanical fix, so this session did not touch it.
- *Seed fallback*: directly verified to work against the ACTUAL flagged product
  (below), reuses catalog images the product already has (most have several — this
  one had 7), and required no provider-behavior assumptions.

**3. New harness** `scripts/verifyModerationSeedFallback.js` — 23 checks, offline,
revert-proven on 5 separate mutations (taxonomy code missing, old hardcoded
`retryable` guess restored, `buildModerationRollup`'s filter gutted, the candidate
cap dropped, `buildErrorEntry`'s code/action stripped — each confirmed to fail the
harness, then pass again once restored). Also fixed a real fragility hit while
landing: `scripts/verifyAdVisionQcSurfacing.js`'s C1-C3 checks used a hardcoded
6000-char `sliceFrom` span to scope `GET /runs/:runId`'s handler, which the new
`moderationBlocked` rollup pushed past — the EXACT class of drift
`verifyRunStatusTruthfulness.js` already fixed once (4500→6000) by bounding at the
next `router.METHOD(` declaration instead. Ported that same self-maintaining
pattern into `verifyAdVisionQcSurfacing.js` rather than bumping the number again.

## Verified live against the ACTUAL failing product (Vuori jacket, `6a8572e6b31cf7b22149ca01`)

Three real, controlled `openai/gpt-image-2/edit` submits, all settled/actual cost
(never `base_price`):
- The exact flagged hero photo, with a shorter test prompt (not the real
  `staticAdIntents.js` prompt — reproducing that exactly needs the full pipeline's
  DB artifacts) → **succeeded**, unflagged. Repeated once more, also succeeded, and
  once more with an explicit `moderation:'low'` parameter (Atlas's own schema
  already defaults this to `'low'` — setting it explicitly changed nothing, so
  that lever is exhausted, not a fix).
- A skin-free alternate catalog image of the SAME product (a back-of-jacket detail
  shot) → succeeded.
- **Conclusion, stated with appropriate hedging (small sample, N=1 product)**:
  prompt content plainly influences the classifier's verdict — the SAME risky
  image passed with different prompting — so this is not purely an image-content
  problem. But a skin-free alternate seed reliably renders regardless, which is why
  seed fallback (not prompt softening, blocked by the fidelity-hardening decision
  above) is the mechanism this session implemented.

Two further live proofs of the actual shipped code path (not a mock), each
replaying the primary seed's HTTP layer with the real incident's failure shape
(HTTP 200 transport, envelope `code:500`, `safety_violations=[sexual]`, the
trickiest of the three real shapes) and letting the fallback candidate go out for
real:
- **Proof 1**: `submitEditImageWithSeedFallback` correctly caught the replayed
  moderation failure, tried the product's first catalog alternate, got a REAL
  successful render (1.2MB PNG, saved), stamped
  `seedFallback:{used:true, originalMediaId, resolvedMediaId, reason:'moderation_blocked', attemptsBeforeSuccess:2}`.
- **Proof 2 (cross-creative coordination)**: pre-seeded `CampaignRun.seedFallbacks`
  with that discovered override (direct `recordSeedOutcome`/`readRunSeedState`
  round-trip, confirmed deterministic — proof 1's own fire-and-forget write raced
  its own test cleanup and couldn't be confirmed there), then called
  `submitEditImageWithSeedFallback` again for "creative #2" on the same
  run/product. Result: **exactly 1 `generateImage` submit** (the flagged primary
  was never attempted at all), `attemptsBeforeSuccess:1` — proving the coordination
  actually saves the doomed-primary submit for later creatives, not just in theory.

Both throwaway `CampaignRun` test docs were deleted afterward; confirmed zero
leftover test data in Mongo.

## Exposure quantification — method, numbers, and an honest correction mid-session

**A live, coordinator-directed course correction happened here, stated plainly:**
this session started quantifying exposure with a live 20-item stratified sample
(category-keyword-matched "high-risk" vs general products across the four target
brands, real `gpt-image-2/edit` submits). Ten of the planned twenty ran before a
mid-task instruction arrived: check in before spending further on Atlas (a shared
nightly budget across concurrent sessions was under pressure), and prefer
already-existing CostLog/Ad data over new spend where possible. **Complied
immediately — stopped at 10/20, no further submits, pivoted the primary
quantification to free historical data.** Total real Atlas spend this session,
all controlled/deliberate, none auto-retried: **$1.1709** across 15 submits
(3 mechanism probes + 2 live shipped-code proofs + 10 of the planned 20 exposure
samples), all settled/actual price, none estimated.

**Free signal 1 — category/title keyword stratification** (regex over
`title`/`category` for bra/bikini/swim/intimates/crop-top/legging/romper/
bodysuit/etc., zero cost):

| Brand | Catalog size | High-risk-keyword match | % |
|---|---|---|---|
| Vuori 2 | 10,553 | 1,159 | 11.0% |
| Marine Layer | 2,446 | 63 | 2.6% |
| Pelagic Gear | 881 | 68 | 7.7% (29 "Ws Bikini Bottom" + 14 "Ws Bikini Top" alone) |
| BabyBooFashion | 52 | 5 | 9.6% |

This is an UPPER BOUND on "photographically risky category," not a rejection-rate
estimate — not every swim/bra photo trips the classifier (the live proofs above
show the same image can pass or fail depending on prompt).

**Free signal 2 — actual production CostLog history** (`stage:'direct_image'`,
all brands, all time, zero cost, the coordinator's suggested alternative): 873
total submits platform-wide, **771 ok (88.3%), 48 rejected (5.5%) of which 44 were
moderation-shaped (5.0% of all submits, 91.7% of rejections)**, 52 generic `failed`,
2 `error`. 124 distinct products have ever had a direct_image attempt; **12 (9.7%)
have hit at least one moderation rejection**. Per target brand (attempts are a
small, non-random sample — driven by which products operators actually generated
ads for, not a catalog-wide draw):

| Brand | Attempts | Distinct products attempted | Products w/ ≥1 moderation rejection |
|---|---|---|---|
| Vuori 2 | 18 | 1 | 1 (100% of the one product tried — the incident) |
| Vuori Clothing (sibling brand) | 181 | 19 | 1 |
| Marine Layer | 24 | 4 | 0 |
| Marine Layer 2 | 234 | 22 | 4 (18.2% of attempted products) |
| Pelagic Gear | 34 | 8 | 0 |
| BabyBooFashion | 12 | 2 | 1 |

**My own partial live sample (10/20, stopped mid-run)** — 3 high-risk + 2 general
per brand, real submits, one consistent test prompt: **1/10 rejected** (the Marine
Layer "Bikini Top" product). Too small (n=10, and stopped before Pelagic
Gear/BabyBooFashion's items ran) to be a standalone estimate; reported as a data
point, not a headline number.

**Honest synthesis, error bars stated, not a single confident number:** across all
three sources, the real-world rejection rate for a chosen seed is in the
**rough single-digit-to-~20% range depending on category mix and which specific
products get sampled** — not "most" catalog photography, but not negligible
either, and every brand in this task sells at least some swim/intimates/activewear.
**The consequence, not the base rate, is the actual severity**: because
`DIRECTOR_UNIVERSE_TOP_N=1` shares one seed across all 18 static payloads, a
single-digit-percent per-product hit rate currently means a 100%-of-that-product
static-output failure every time it lands — exactly what this session's fix
addresses. A materially better exposure estimate would need either a larger live
sample (budget-gated, deferred) or a proper stratified re-run once the fallback is
live and CostLog volume grows under it.

## Verification

`npm run lint` clean. Full `scripts/verify*.{js,mjs}` suite: **170/170**, including
the 3 scripts flagged as "always fail from a worktree due to hardcoded `sharp`
path" — they passed clean here once `npm install --no-save https-proxy-agent@5.0.1`
(the documented environmental-gap fix) also happened to resolve whatever else was
missing; `node_modules/.package-lock.json` reverted afterward so that install isn't
part of the diff. Revert-proved 5 of the new harness's own checks by hand (see
above). `git diff --numstat origin/main` clean (rebased twice as main moved,
last conflict — `visionQcRollup` vs the new `moderationBlocked` field landing on
the same `res.json({...})` line — resolved by keeping both, additive).

**Not verified:**
- The full `renderDirectImage` → `submitEditImageWithSeedFallback` integration
  path is unit-tested at the taxonomy/pure-function/coordination layer
  (`scripts/verifyModerationSeedFallback.js`) and separately proved live against
  the real product (two one-off scripts, not committed — they make real billable
  calls), but there is no single committed harness that exercises the ENTIRE
  `renderDirectImage` call end-to-end offline (it needs Director/LayoutInput/Brand
  DB fixtures well beyond this session's scope to construct safely).
- Whether a DIFFERENT image model's moderation is meaningfully looser — not
  investigated; no evidence either way.
- The remaining 10 of 20 planned exposure samples (Pelagic Gear, BabyBooFashion
  general/high-risk items) — stopped mid-run per the spend-discipline instruction,
  not because of a technical blocker.
- At-scale behavior of the seed-fallback coordination under real
  `RENDER_CONCURRENCY` (8) — the two live proofs were sequential, single-call
  tests, not a concurrent-creative race simulation.

## Cost discipline

Approved budget: up to $5 on controlled experiments. Settled spend: **$1.1709**
(15 real Atlas submits, all settled/`actual` price from the provider, none
estimated, none auto-retried). Stopped short of the original plan (a 20-item
exposure sample, ~$1.5-1.8 total) on an explicit mid-session instruction to check
in before further spend given a shared nightly budget — pivoted to free
CostLog/category data instead, as directed.

## POST-SCRIPT: a P0 was caught by adversarial review before merge

Grok (`-m grok-4.6 --effort high`) reviewed the full diff independently and found
the fallback mechanism above was dead code on the actual incident path:
`singleSeedEligible = !orderedIds.length` is only true for a length-0
`referenceMediaIds` array, but `renderService.js:208-211` forwards `Ad.mediaIds`
whenever `Ad.referenceMediaIds` is empty, and every concept-driven static mint
writes exactly ONE id into `Ad.mediaIds` (`DIRECTOR_UNIVERSE_TOP_N=1`). Confirmed
directly against the incident's own Ad documents (`mediaIds.length===1`,
`referenceMediaIds.length===0`) — the fallback would have shipped never
engaging on the one path it exists for.

Also found and fixed, same review: (1) candidate-list construction could push
both a resolved override AND the primary as separate starting slots, allowing up
to 4 submits against a documented cap of 3; (2) a moderation-blocked PRIMARY was
never recorded to `blocked[]` (guarded on `!isPrimary`), so other creatives kept
re-paying to rediscover the exact seed the incident was about; (3)
`nextCandidateIds` checked its cap after pushing, so `limit:0` still returned one
candidate; (4) `atlasVideoService.js`'s classified-failure error never carried
`.code`, so a video master rejected for the same reason as its sibling statics
was invisible to `Ad.renderError.code` and the `moderationBlocked` rollup.

Root cause of why the original test suite didn't catch this: it exported
`submitEditImageWithSeedFallback` "for behavioural pinning" and never actually
called it — every check in the original A-D sections tested the taxonomy,
coordination helpers, and downstream plumbing correctly, but none of them
exercised the orchestration loop that decides what to submit. My own live
proofs (described above) also missed this: they called the money function
directly with `singleSeedEligible: true` hardcoded, bypassing the very
computation that was broken.

Fixed: the gate is now `moderationSeedFallback.isSingleSeedEligible(orderedIds)`
(`<= 1`, not `!length`) — a pure, exported, directly-unit-tested function. New
harness sections E (5 checks on the gate itself) and F (7 checks that call the
real `submitEditImageWithSeedFallback`, with `atlasImageService`/`models/Media`
stubbed through `require.cache` and a real `sharp`-generated PNG fixture for the
reference-fetch/normalise path) close the gap — every one of the five bugs above
is now individually revert-proven: reintroducing any one of them fails exactly
the check that targets it, confirmed by hand for all five.

Full suite after these fixes: 172/172, lint clean. No additional Atlas spend —
all five bugs were found and fixed through source reading plus offline,
require.cache-mocked tests, zero live submits.

**Lesson for next time, stated plainly:** "call the real function" is not
sufficient on its own if the caller hand-constructs the inputs to bypass the
exact logic under review. The live proofs proved the RETRY MECHANISM works;
they did not prove the ELIGIBILITY GATE that decides whether it runs at all —
those are different claims, and conflating them is exactly how this shipped
broken in the first draft.
