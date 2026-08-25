# 2026-08-25 (late) — the readiness deadlock, the headless tier, and a preview that under-quotes

Continues `session.d/2026-08-25_review-coverage-corrected-and-ingest-mechanics.md`.

---

## What shipped

| PR | What |
|---|---|
| #339 | the headless review tier is actually reachable per call (two independent wiring bugs) |
| #340 | the ad-readiness gate stops demanding a catalog detect run only the blocked request could create |
| #330 | `scripts/postStatus.js` — CLI to post engineering status to #rs-status |
| #331 | cost attribution threaded through four more unledgered producers |
| #333 | Slack run-feed requester name restored; automated runs labelled |

## 1. The readiness gate deadlocked every brand onboarded after detect went lazy

`adReadinessService` required ≥1 COMPLETED catalog DetectRun. But catalog detect is
DEFERRED — `enqueueBrandProductDetects` returns `{deferred:true, heroEnqueued:0}` unless
`CATALOG_DETECT_PRECOMPUTE === 'true'`, and the committed default is false. The only other
creator of a catalog DetectRun is `ensureDetectForProducts`, called from
`campaignAdsGenerationService` — inside the request the gate was refusing.

Measured: PB5star (102 catalog Media / 0 runs), Marine Layer (200/0) and Gymshark (5/0) all
409'd on campaign create AND ad generate. Pelagic and both Soludos brands passed only
because they were onboarded while detect was still eager.

**This is the SECOND time this one gate locked out this same set of demo brands.** The
2026-08-19 note in `probeConnections` names Marine Layer, GymShark, Peloton and PB5Star
blocked by a hardcoded `source:'apify-shopify'`. Different clause, same file, same victims —
hence a harness this time
(`scripts/verifyReadinessGateAllowsDeferredDetect.js`).

The gate is now deliberately **asymmetric**: catalog needs Media + 0 in-flight; social still
needs ≥1 completed + 0 in-flight, because that is where the stale-UGC pairing risk the gate
was written for actually lives. Every place restating the old symmetric rule was corrected
with it — including `capabilityRegistry`'s `campaign.create` describe, which is agent-facing
and would otherwise have kept teaching the deadlocked rule in chat.

**Peloton Apparel needed a separate fix** — never a detect problem, it had 1,492
CatalogProducts and zero catalog-product Media because materialization never ran.
`POST /api/catalog/materialize` fixed it (1,492/1,492). All seven brands now read
`ready=true`.

**Still open here:** `catalog-detect-in-flight` is scoped brand-wide, so one product's lazy
detect transiently 409s generation for every other product on the brand.

## 2. `?headless=1` did nothing, in two independent ways

`reviewHeadlessCapture` reads `REVIEW_HEADLESS_ENABLED` ONCE at module load into a frozen
`ENABLED`, then bails unless that is true or `force` is passed. The variable is set nowhere.
The tier-3 call site decided *whether* to call it from the per-call `useHeadless` but never
passed `force` — so every per-call opt-in was discarded by the env default it existed to
override. `docs/PIPELINES.md:349` and `:379` document the two as equivalent, and git shows
`force` was added in the SAME commit as `?headless=1` as the override hatch; nobody wired
the call site.

Second instance: `catalogProductReviewRefreshService` computed `useHeadless` correctly then
passed it as `{ allowHeadless: … }` — a key `fetchProductReviews` has never destructured.

**A cost hazard this introduced, and the clamp.** While the tier was an accidental no-op it
was free. `reviewHeadlessCapture` calls `getBrowser()`/`newPage()` WITHOUT taking
`headlessBrowserClient`'s mutex, so with `PRODUCT_REVIEWS_CONCURRENCY` at 4 a headless run
would put four Chromium page loads on the web process that also runs Remotion, on an 8 GiB
box — the shape of the 2026-08-21 OOM. #339 clamps to 1 when headless is requested.
**Making tier 3 take the mutex properly is the real fix and is still open.**

**Consequence worth acting on:** probing real product URLs shows Gymshark's PDPs detect as
`bazaarvoice` and Marine Layer's as `yotpo`. Both have real review platforms the HTTP tiers
cannot read. Nobody has ever run tier 3 against them — that is the cheapest available
coverage win, and it is free.

## 3. A money bug: the preview under-quotes when QC regenerates

`/api/ads/preview` quoted **$1.29** for an 18-image static batch. Seventeen of the eighteen
used a QC-triggered regeneration and the real `CostLog` total was **$3.36** — 2.6x.

This is not just a wrong number on a screen: the ui-smoke budget guard reserves against the
preview quote before submitting, so it **under-reserves precisely when a run is most
expensive**, and a `--budget` ceiling can be exceeded without the guard noticing. The guard's
principle (reserve before request, because the vendor bills at submit) is right; its input
is wrong.

## 4. Known-red on this trunk

`verifyPreparingReap.js` and `verifyRenderStages.js` fail on clean `origin/main` and have
all day. Confirm by stashing your diff and re-running before assuming a failure is yours.

## 5. Still open

**#319** — its concern is REAL and unfixed: `terminalDraftWrites` still uses the
co-occurrence rule (`status:'draft'` AND `titlingResumeState:null` in the same update) the
PR calls unsound. But the branch is 19 behind and overlaps the one file it edits (#320, #322
landed there), so merging it would revert them. Main's own header now explains why section E
was retired — a source-text scan "still went green on six real shapes" — and
`terminalDraftWrites` is the same scan with the same disease. The stronger fix is to give it
the behavioural treatment section E got, not to rebase a better regex onto it. Triage is
commented on the PR.
