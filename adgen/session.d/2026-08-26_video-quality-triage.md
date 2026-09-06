# 2026-08-26 — video quality triage (Pelagic), titling reliability, model registry

## Landed on `master` today (merged, deployed)
- `e7d18b4` — Scene 2 prompt: removed "the logo or" from the zoom instruction (all 3 timeline variants: split, hook-first, frozen). Owner-directed; the logo is specifically what Omni can't hold across frames. Mirrored on backend `main`.
- `fef602d` (merge) — titling reliability: build-time Remotion browser prewarm (`scripts/ensureRemotionBrowser.js`, closes the ETXTBSY/ENOENT filesystem race), `REMOTION_QUEUE_CONCURRENCY` 4→2 (measured ~1.91-2.0 GiB/slot vs 8GiB instance), stale-titler-claim reclaim (20min TTL), terminal `renderStage:'done'` write.
- Dashboard env changes (live, confirmed): `ADGEN_TITLER_ENABLED` false→true on adgen-titler (was the root cause of derives stranding untitled AND uncounted — renderer's own comment: "Do NOT bumpRunCounter — the titler owns the terminal stamp", and titler never claimed them). `REMOTION_QUEUE_CONCURRENCY=2` confirmed live via deploy (env changes need a DEPLOY not a restart — learned this the hard way).
- `1a92a46` — `chore/model-registry-refresh` branch: full MODEL_CAPS re-audit vs live Atlas catalog. Fixed 3 real veo3.1 inaccuracies (duration enum not range; missing 4k; wrongly-included 1:1 which could 422 live). Added `xai/grok-imagine-video-v1.5/reference-to-video` (not selectable, registry-accuracy only). **NOT YET MERGED — sitting on this branch, verified clean (54/65→ same before/after against real trunk).**
- `f924b44` — same branch: fixed a REAL regression from `3165e95` ("perf(qc): instrument visionQcMs stage timing", landed by someone else today). `stageTiming.js` eagerly required `../config`, dragging its hard ADGEN_ROLE/MONGODB_URI boot-gate into 10 otherwise-offline harnesses via `adVisionQcService.js`/`layoutInputService.js`. Fixed by making the require lazy (WORKER_ID must stay the same process singleton — cannot read process.env directly, would break the `claimedByWorker` filter). Verified: 54/65→64/65, only the deliberate `_KNOWN_OPEN` remains red. **NOT YET MERGED — same branch as above, HIGH PRIORITY, this un-breaks trunk's test suite.**

## Root-caused, NOT yet fixed (draft exists, not applied)
Owner priority: "minimize outpaints, first priority." A trace confirmed:
- **Stale reframe cache is the load-bearing bug.** `reframeReferenceForAspect` (`atlasVideoService.js`) checks a persisted cache BEFORE the `product_only` pad decision, with no shotType key — an image outpainted once stays outpainted forever even after later being correctly classified `product_only`.
- Pad gate is narrower than it should be: only `shotType==='product_only'`, ignores `flat_lay`/`detail`/`packaging` (the established packshot family elsewhere in the codebase).
- Pad-URL-construction failure falls through to generative outpaint (should fall to crop, like the non-flat-border case already does).
- Auto-assembly's catalog Media query omits `refinedProducts` (YOLO boxes) from its `.select()` — crop-first can never even attempt a crop for auto-assembled/prewarmed references.
- **16:9 has zero special-casing** vs 9:16 — same ladder, same thresholds. Explains why 16:9 measured far worse (ΔE 42.9 on a real Pelagic ad) — crop-first crops the abundant dimension (height, going to 16:9) and a full-frame subject usually can't fit the resulting window, so it defers to outpaint almost every time; 9:16 crops width, usually still contains the product.
- A Grok xhigh draft for all 4 fixes above was in flight when this entry was written — check scratchpad `outpaint-fix-draft` output / re-run if lost.
- Owner recalled a prior exploration: a 16:9 "pad expand to the left, reserve copy space" approach to avoid extreme generative fill. A search for this (existing code, prompt text, or reverted commit) was in flight — check for `pmaxSplitStrategy.js`/`PMAX_SPLIT_VIDEO`/`subjectSide`/`brand_panel` (this DOES exist but appears to be TITLING-time compositing, post-Omni, not pre-Omni seed reframe — needs confirming whether it reduces actual Omni invention or is cosmetic).

## Detect (YOLO) findings
- `CATALOG_DETECT_PRECOMPUTE=false` live, unchanged. adgen's renderer never calls detect at all (zero references) — the only on-demand caller (`ensureDetectForProducts`) lives in the BACKEND mint path, not adgen.
- Cost: ~$0.05/image (YOLO+Gemini identify+matching combined, one billed unit). Measured real latency (491 runs, 7 days): p50 37.5s, p90 106s, p99 170s. Concurrency: `WORKER_CONCURRENCY=8` (file default; live env-var check returned unset).
- Detect timing was ruled OUT as the cause of the two measured Pelagic failures — both had already-populated classification when they failed. The miss is pad/cache logic (above), not detect scheduling.
- Existing detect functions already support "detect ALL images of a product" (`enqueueProductDetect` for fresh products, `ensureDetectRunsForExistingMedia` for existing ones — both iterate hero + all `additionalImageMediaIds`). BUT: `ensureDetectForProducts`'s calling loop has a coverage gap — it only checks the HERO's DetectRun existence to decide skip-vs-proceed, so once a hero has ANY run, alts are never revisited even if never detected. Needs fixing as part of the new wizard-open trigger.
- UGC-post product matching (`pipelines/detect.js` Phase 1.7) IS architecturally a step inside the detect pipeline — YOLO always runs before matching for that path. Separate from catalog-product detect (crops/overlay zones for ad generation), which is the deferred/on-demand one discussed throughout.

## NEW FEATURE — decided, not yet built
Owner decision: trigger catalog-product detect (ALL images, not just hero — "we may want additional ads using different images down the line" + feeds a future lifestyle/on-figure classification enhancement) the moment the operator opens the Generate Ads wizard for a specific product (fire-and-forget, `wait:false` — exact precedent already exists: `productMatchService.js`'s "reverse-flow pre-warm" on confirmed UGC matches, same function, same pattern). Batch flow: same, first-3-images-per-product-in-batch was the ORIGINAL ask but was superseded by "just do all images" — confirm with owner if batch should also go to all-images or stay first-3 given cost (batch is N products × all images × $0.05, uncapped by owner's explicit choice "fire freely, no cap"). NOT YET SCOPED INTO A DRAFT — this is the next thing to build. Needs: (1) fix the `ensureDetectForProducts` hero-only skip-gate coverage bug, (2) a new lightweight fire-and-forget backend endpoint the wizard calls on open, (3) frontend hook at wizard-open.

## Model comparison (image-to-video vs alternatives) — ON HOLD
Owner: fix outpaint+detect first, re-test, THEN reconsider models — "not clear we need to change models yet." A live Atlas catalog check found `xai/grok-imagine-video-v1.5/reference-to-video` (now registered per above) as the closest genuinely-new candidate. `google/gemini-omni-flash/reference-to-video-developer` was mis-characterized earlier as a viable A/B candidate — it's actually video-to-video (`requiresVideoSeed:true`), not usable for stills-only catalog products, degrades back to i2v automatically. Real multi-ref alternative if ever tested: deprecated Grok Imagine 1.0 (`xai/grok-imagine-video/reference-to-video`, ~4x cost) or the new v1.5 reference-to-video sibling just registered.

## Other open items from this session
- Trunk is otherwise healthy as of `f924b44` (pending merge) — was 54/65 before the stageTiming fix, is 64/65 after.
- Backend has its own byte-identical STALE copy of `MODEL_CAPS` (same 3 veo3.1 bugs, missing v1.5 r2v) — confirmed, not touched, flagged for the same treatment later.

## NEW BUG — face-safe crop regression: faces cut off in 9:16-derived crops
Owner-observed on a live run (`run_1787784078946_b60cd74c`): many recent ads have the subject's
face cut off in derives cropped from the 9:16 master (e.g. `meta_feed_1_1`, `meta_feed_4_5`).
Confirmed one live example: `renderError` `stage:'face-safe-crop'`, `message:'face-safe crop
skipped: no-face-quorum'` while the ad was still `status:'rendering'`.

**Mechanism traced** (`src/services/basePlateCropService.js:162`, `decideBasePlateCrop`): the
face-aware crop needs a CONSENSUS head box sampled across frames of the **delivered video itself**
— `det.subject`/`det.head` (call site ~line 592-597) come from frame-sampling the FINISHED render
(confirmed by the surrounding `frames`/`faceHits`/`faceSamples` fields at the ~line 445 default),
**not** from any pre-generation catalog YOLO detect artifact. When quorum fails (`head === null`),
the function deliberately SKIPS the face-aware crop and falls back to a blind centre crop (own
comment: "the devil we know" — reasoning: a skewed subject box could push a centred crop to cut
MORE head than a blind crop). That blind fallback is NOT guaranteed face-safe, which is the likely
proximate cause of the cutoff symptom whenever `no-face-quorum` fires.

**Owner hypothesis, NOT YET CONFIRMED**: may be related to YOLO/detect not running prior to
generation. Traced so far: this specific mechanism analyzes POST-generation video frames, so any
causal link to pre-generation detect is indirect at best, not direct — unverified. Open questions
for whoever picks this up:
1. How often is `no-face-quorum` actually firing in production right now — rate, and has it
   trended up recently (i.e. did something regress, or was this always the failure floor)?
2. Did the frame-sampling face-detector itself regress (model swap, threshold change, sampling
   rate/frame-count change), independent of what it's being fed?
3. Could pre-generation product/lifestyle classification (which IS YOLO/detect-derived) be
   steering which images get selected as video seeds in a way that indirectly starves this
   face-sampling step of face-bearing frames — i.e. not a bug in the sampler itself, but a bug in
   what it's being asked to sample?
