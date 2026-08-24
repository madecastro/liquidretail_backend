# Cost-ledger attribution gap — six stages, ~42% of one day's spend untraceable

Owner asked why last night's Atlas spend didn't reconcile against visible generation
runs, with no new brand ingestion. Investigation (read-only): `scripts/reconcileAtlasDailyCosts.js`
showed our CostLog total matches Atlas's own billing API to within 0.04% — the aggregate
ledger was never wrong. The actual answer: 20 CampaignRuns fired in ~30h (not just
"last night"), several with catastrophic failure rates (video crashes, vision-QC
catches on real product-fidelity defects — both investigated separately, not fixed
here), and **~$16.44 of ~$38.87 (42%) landed in CostLog with `brandId`/`productId`/
`adId`/`campaignRunId` all null**, across six stages: `overlay_zones`,
`layout_derivation`, `subject_text`, `crop_refine`, `base_plate_crop`,
`judge_detections`. Real, correctly-billed spend — just untraceable to any brand, ad,
product, or run, which is exactly the question anyone reconciling a bill needs
answered. `services/costTracker.js`'s `persistCost()` already whitelists all four
fields into `CostLog.create()` (confirmed by reading the source, not inferring from
the query) — the gap was purely that these six producers never put them in the `meta`
object passed to `chatCompletion()`/`trackLlmCall()`.

## Vendoring hazard (caught by a peer session, rs-d2, mid-fix)

`liquidretail_adgen` — the live renderer under `ADGEN_RENDERER_ENABLED=true` — has its
own copies of four of the six: `layoutInputService.js`, `basePlateCropService.js`,
`judgeService.js`, `overlayZoneService.js` (confirmed via `git ls-tree -r
origin/master`, after an earlier check against a stale local `liquidretail_adgen`
checkout wrongly reported `overlayZoneService.js` as absent there). `subjectTextService.js`
and `cropRefineService.js` are genuinely backend-only. A live Render-logs grep (searching
for the distinctive `overlay-zones[` success line across `adgen-renderer`,
backend-web, and backend-worker) showed `overlay_zones` is currently emitted
exclusively by backend's WORKER — but both repos' copies were fixed anyway, since the
change is purely additive and "which repo is live for a given stage today" isn't
something to bet the fix's correctness on. The parallel adgen PR is
`fix/cost-ledger-attribution` in that repo, same branch name, different repo — the
two are a package; flag the dependency when opening PRs so nobody merges one without
the other.

## The fix

Purely additive: `brandId = null, productId = null, adId = null, campaignRunId = null`
threaded as optional params through each producer and its real callers
(`pipelines/detect.js`, `services/atlasVideoService.js`, `services/renderService.js`).
No existing prompts, cache keys, or control flow changed. Drafted by Grok (read-only
mode, exact OLD/NEW hunks; applied via Edit after verifying every hunk byte-for-byte
against the real file first — this caught two things Grok's flat diff would have
gotten wrong if applied blindly):

- **`services/atlasVideoService.js` has TWO near-identical `refreshStaleLayoutInput`
  call sites** — one inside `prepareStoryboard` (no `campaignRunId` param in scope),
  one inside `generateForAd` (has one). Grok's diff patched the right one only in
  intent, but the two calls are textually identical (`layoutInput, ad, media, brand,
  product, categories, campaign, targetAspect`), so a naive apply of the same
  old→new hunk would have added a reference to an undeclared `campaignRunId` inside
  `prepareStoryboard` — a `ReferenceError`, exactly the shipped-bug class this repo's
  own `CLAUDE.md` documents three prior times (`receiptFree`, `preferUgcMediaId`,
  `usableProofCommentsOrNone`) and that neither a regex-based diff apply nor
  `node --check` can catch. Disambiguated by the distinct comment immediately above
  each call site and applied only to `generateForAd`'s.
- **A second, self-inflicted collision**: adding `campaignRunId: campaignRunId ||
  null,` inside `refreshStaleLayoutInput`'s own `buildLayoutInput` options block
  made that exact string appear TWICE in the file (my new one, plus the pre-existing
  real charge-point write). `scripts/verifyVideoTimeoutReconcile.js`'s E6 revert-proof
  check does a first-occurrence string mutation to test that check E2 would catch a
  dropped `campaignRunId` at the charge point — with two matches, it silently mutated
  the WRONG (earlier, newly-added) one, leaving the real charge point's copy intact
  and passing when it should fail. Fixed by using object-shorthand
  (`campaignRunId,` — behaviorally identical since the param already defaults to
  `null`) at the new site, which de-collides the string without touching the real
  charge point. Caught by running the full suite (`npm test`), not by reading the
  diff — this is exactly why "run the checks" is not optional even for a change that
  looks purely additive.

## New harness: `scripts/verifyCostAttribution.js`

40 offline checks, revert-proven against the REAL file content (not hand-typed
pre-fix string literals — see the harness's own header for why that distinction
matters; an adversarial Grok review at `xhigh`-adjacent effort caught an earlier
draft's revert-proofs testing constants instead of the live file, plus a total
blind spot on caller-side threading). Section 7 specifically opens
`pipelines/detect.js`, `atlasVideoService.js`, and `renderService.js` and asserts
each real call site references an actual object property (`run.brandId`, `ad._id`,
`req.brandId`, …) rather than merely that a producer function accepts the param —
revert-proven by stashing ONLY the caller files (producers untouched) and confirming
exactly the 10 caller-side checks go red while the 30 producer-side checks stay
green. Full suite: 197/199 (two pre-existing, unrelated failures —
`verifyPreparingReap.js`, `verifyRenderStages.js` — confirmed present on a clean
`origin/main` checkout before this work started, not caused by it).

## Historical attribution (informational, not code)

For the ~30h window audited, a best-effort time-window join (each untraced CostLog
row bucketed into whichever CampaignRun's `[createdAt, updatedAt]` span contained
it) recovered brand-level attribution for $16.11 of the $16.44 (37 rows / $0.17
fell outside every run window — likely pre/post-run detect activity). Six run
windows overlap in this data, so a handful of rows could be mis-bucketed to the
wrong sibling run; good enough for a retrospective sanity check, not a source of
truth. Going forward, the real fix above makes this unnecessary — attribution is
exact, not reconstructed.

## Known-open, not touched here

- Two runs (~02:18/03:39 UTC) lost their entire video batch to
  `veoPrepareStoryboard is not a function` — confirmed transient (both
  `services/videoRouter.js` and `services/atlasVideoService.js` correctly export/
  define `prepareStoryboard` on current `main`), not reproduced, not root-caused.
- Multiple runs burned billed ~$0.90 video masters that then correctly failed vision
  QC for genuine defects (material/colorway drift, one competitor-brand-mark
  detection) — working as designed per PR #282, but the same product repeatedly
  failing across separate runs may be worth flagging as a QC-blocked SKU rather than
  continuing to retry it.
- Grok's broader audit (same session) found ~15 more CostLog producer call sites with
  no attribution and real IDs available one hop up in their callers (imageRecoveryService,
  aiOverlayPolishService, aiVideoPosterService, brandEnrichmentService,
  textEmbeddingService via productMatchService, aiLayoutStudioService, yoloIdentifyService,
  geminiIdentifyService, title_plate_scan) — not fixed in this pass; flagged as
  follow-up, not done unprompted given the scope already covered.
