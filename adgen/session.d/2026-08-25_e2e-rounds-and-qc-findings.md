# 2026-08-25 (late) — four E2E rounds, three fixes, and what QC can't be trusted about

Continues `session.d/2026-08-25_overnight-video-chain-and-review-coverage.md`. Written for
two engineers joining cold.

---

## What shipped from here

| PR | What |
|---|---|
| #63 | renderer claim excludes titler-handoff rows — unblocks `ADGEN_TITLER_ENABLED` |
| #65 | vision QC can now flag a logo composited ON TOP OF the product |
| #66 | a terminal STATIC failure persists its `visionQc` verdict |

Backend, same window: #339 (headless review tier reachable per call), #340 (readiness gate
stops demanding a detect run only the blocked request could create), #330, #331, #333.

## The QC findings, in the order they matter

**1. The video QC judge is confidently wrong in BOTH directions.** Round 4 ran four video
masters as matched laydown/on-figure pairs and reviewed every one frame-by-frame. It
fabricated specific claims on two masters — one drawstring-colour finding came back
*identically from four separate QC calls* and appears in no frame — while on a third it
caught a genuinely well-hidden real defect: a fabricated gold-foil wordmark on a shoe
tongue, legible across 53 consecutive frames, that a 0.5s-interval scan had missed.

Same confidence, same specificity, opposite truth value. **Video has no regeneration**
(`renderError.message`: "video ad failed vision QC (no regeneration)"), so a fabricated
verdict terminally discards an already-paid master. The 79% video-failure rate measured in
rounds 1-2 contains an unknown share of phantom failures.

CONFOUND, stated because it could invalidate the above: round 4 used a single-image seed
override rather than the default 3-image reference stack, and that seed did not show the
region where the fabricated logo appeared. A thinner reference set may itself have caused
the hallucination. **Re-run those products with the default stack before changing the QC
prompt.** That is the cheapest next experiment.

**2. This is what makes #66 load-bearing.** You cannot distinguish a correct verdict from a
hallucinated one without downloading the footage — which needs the persisted verdict and
its `attempts[].discardedRenderUrl`. Before #66 the static path dropped both.

#66 has a clean natural control in production: static QC failures created BEFORE the deploy
carried `visionQc` **0 of 10** times; after, **16 of 16**.

**3. `layout_safe_box` is not a live false-positive problem.** ~2 failures in ~148 verdicts
across rounds 1-2. After #65 the rate rose — expected, because occlusion became a second
legitimate reason to fail that category. All 9 of round 3's catches were visually
adjudicated and none showed the old "restated boundary numbers" signature.

**4. Do NOT build subject-aware logo placement.** It was the obvious fix after #65 and it is
wrong. There is no subject signal for the RENDERED frame at composite time
(`Media.refinedProducts[]` describes the catalog seed and cannot be projected onto a
lifestyle generation), and the image model is told to keep only the bottom-right clear of
text — so relocating the logo trades a product collision for a headline collision. #65's
QC-retry path **restages the scene**, which relocation can never do. Round 3 confirmed it:
all 9 catches self-corrected on retry.

**5. Static creative is reliable.** Roughly 160 images across the rounds with essentially
zero final-attempt fidelity failures, holding up under zoom against the seeds.

## Two defects left open here

- **The preview quote under-reserves.** `/api/ads/preview` quoted $1.29 for 18 statics; 17
  used a QC regeneration and the real cost was $3.36. The ui-smoke budget guard reserves
  from that quote, so it under-reserves exactly when a run is most expensive.
- **A real static defect:** one control batch failed 16/18 images showing the *back* of a
  hat, hiding the embroidered design that is the product's whole identity.

## Operational notes for whoever runs the suite

- `REMOTION_QUEUE_CONCURRENCY` is still **2** on the adgen-renderer dashboard. PR #61 raised
  the file default to 3 and is inert because the dashboard wins. Round 4 made the cost
  concrete: 26 video ads took ~30 minutes to clear titling.
- `verifyRequireGraph.js` failed once under concurrency=8 and passed standalone and on two
  subsequent full runs, with and without a change. Intermittent; not a real red.
- Suite on trunk: 48/49, the one red being `verifyRunFinalizesOnSettle_KNOWN_OPEN`, red by
  design.
