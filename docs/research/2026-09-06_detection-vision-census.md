# YOLO ingest census + keep-out opportunity

**Verdict first.** The owner's thesis is **wrong for the thing he actually needs**. Most of a keep-out map for **native Remotion type on a generated video frame** is **not** sitting in Mongo waiting to be wired. Catalog/UGC detections live in the **source still's** coordinate space. The Gymshark title is composited onto a **new image** the video model invented. A box on the catalog photo does not transfer. `dinoOverlayZoneService` cannot be pointed at a Veo/Omni frame — its math is "intersect this bbox with a crop of the **same** still."

Local OCR is also not a thing. Comments that say "OCR" are lying. `Media.text[]` is **paid GPT-4.1 vision**, written only by DetectRun, and even when it has boxes those boxes are of the **source still**, not the generated plate. A shark **graphic** is not OCR-able text anyway.

The cheap path is **not** ingest wiring. It is **extending detection that already runs on the generated plate** (`detectClipBoxes` + optional Grounding DINO `/detect` with a logo prompt on those same stills) and teaching Canonical a **rect**, not just a band hop.

Verified against `liquidretail_backend` (main) and `liquidretail_adgen` (master) on 2026-09-05. YOLO microservice source fetched read-only from `https://raw.githubusercontent.com/madecastro/yolo_microservice/main/yolo_service.py` (not in this workspace). No production files edited. No billed POSTs.

---

## 0. The owner's question, answered

> "aren't we already doing local OCR?"

**No.** There is no Tesseract, Paddle, EasyOCR, or `ocr` npm dependency in either `package.json` (backend has `sharp` + `@napi-rs/canvas` only). The word "OCR" in `adSuitabilityService.js:46`, `:162` and `brandSafetyService.js:69` is a **label on GPT-4.1 output**. The only production writer of `Media.text[]` is `subjectTextService.detectSubjectsAndText` (`subjectTextService.js:33`, model `'gpt-4.1'` at `:44`), persisted by `pipelines/detect.js:245-270` (UGC/video-hero) and `:640-661` (catalog DetectRun). Shape is `{ id, content, type, x1, y1, x2, y2, confidence }` — **boxes exist**, strings live on `.content` not `.text`. Coverage is **DetectRun only**, not catalog ingest YOLO, not Apify.

> "examine the entire YOLO ingest and see what it is doing and what else it should be doing rather than doing new calls"

Ingest YOLO is doing **product-bbox work for reframe and static overlay**, and it is already well-used for that. It is **not** computing a keep-out map for generated-video type. Asking ingest to also solve Gymshark-on-Omni is the wrong layer.

---

## 1. Detection inventory

Two YOLO worlds. They share a microservice and they do not share a purpose.

| World | Job | HTTP | Writes `Media.text[]`? |
|---|---|---|---|
| Catalog ingest YOLO | Cheap product boxes on catalog stills | `/detect-batch` (prompt → Grounding DINO) | **No** |
| DetectRun | Full paid pipeline: YOLO + identify + GPT subjects/text + crops + overlay | `/detect` (no prompt → COCO), `/detect-video` (hero fallback) | **Yes** |

Catalog DetectRuns are **deferred** (`CATALOG_DETECT_PRECOMPUTE=false`, `defaults.env:1134`). Catalog ingest YOLO still runs after every catalog sync via `catalogPostSyncOrchestrator.js:113-114`.

Adgen is the live titler (`ADGEN_RENDERER_ENABLED=true` hands off at backend `routes/ads.js:1855-1864`). Adgen's `src/services/yoloService.js` is a **dead vendor copy**: no `require('./yoloService')` callers, no prompt, no `/detect-batch`.

### 1.1 YOLO stills — `POST /detect`

- **Entry:** `liquidretail_backend/services/yoloService.js:10` `detectMultipleProducts`.
- **Trigger:** DetectRun `pipelines/detect.js:908` (no prompt); catalog ingest `mediaYoloRefine.js:230` (with prompt); legacy `pipelines/inventory.js:24`; legacy `pipelines/bridge.js:22`.
- **Input:** image buffer, multipart `image`. Optional `prompt` (`yoloService.js:19-21`) — **only ingest YOLO sends one**.
- **Returns:** `{ width, height, detections:[{ id, cropBuffer, confidence, x1,y1,x2,y2, className, imgWidth, imgHeight, firstSeenSec }] }` (`yoloService.js:226-243`).
- **Persisted:** DetectRun → `DetectionArtifact.yoloProducts` (`detect.js:194`). Catalog ingest **attempts** `Media.yoloProducts` (`mediaYoloRefine.js:289`) — **see schema bug in §1 note**. `Media.refinedProducts` after refine/synthesize.
- **Cost:** self-hosted. Default URL `YOLO_SERVICE_URL \|\| 'https://yolo-microservice.onrender.com'` (`yoloService.js:8`).
- **Live:** yes.

Microservice (`yolo_service.py`, fetched):
- No prompt → **YOLOv8x** `yolov8x.pt` (`MODEL_PATH`, COCO 80 classes) + tiled inference + OpenCV rectangle proposals + **gpt-4o-mini box fallback** when recall looks sparse (`OAI_BOX_FALLBACK` default on). That last stage **is a paid OpenAI call inside the "free" YOLO service**, UGC/no-prompt path only.
- Prompt set and `YOLO_OPEN_VOCAB_ENABLED=true` → **Grounding DINO only** (`IDEA-Research/grounding-dino-tiny`), skip COCO. Eval comment in that file: category prompt hit 100% detection / 100% correct labels on Soludos, Pelagic Gear, **and Gymshark catalog photos**. That is **product** detection, not logo detection.

### 1.2 YOLO video — `POST /detect-video`

- **Entry:** `yoloService.js:25` `detectFromVideo`.
- **Callers (not zero):** `pipelines/detect.js:1071` (`runYoloVideoChain`); `pipelines/inventory.js:23` (legacy Job if `fileType==='video'`). Adgen wrapper exists (`src/services/yoloService.js:16`) with **zero other callers**.
- **Input:** video buffer, multipart `video`. **No prompt field.**
- **What the service actually does** (`yolo_service.py` `detect_video`): sample at `VIDEO_SAMPLE_FPS=2`, run the **COCO+rects+OAI** pipeline on each sample, NMS-dedup across the clip, pick hero frame by highest detection count, return detections + `hero_frame` JPEG. **Grounding DINO is never used on this route.**
- **When it fires:** DetectRun **video without** `metadata.thumbnailUrl`. IG/Reel covers skip it (`detect.js:422-435`) — thumbnail-first, measured to avoid a 30–60s YOLO round-trip.
- **Not:** generated ad plates. This is ingested UGC/manual video, hero-frame picking.
- **Cost:** self-hosted. Comments: ~30–60s, historically high no-hero rate (`detect.js:407-413`).
- **Live:** conditional, as above.

### 1.3 YOLO batch — `POST /detect-batch`

- **Entry:** `yoloService.js` `detectBatch` (backend only; adgen does not implement it).
- **Trigger:** `catalogYoloDetectionService.detectYoloForOne` → `detectYoloForMediaBatch`. Worker `yoloBackfillTick` (`worker.js:319-367`) uses **single** `/detect`, not batch.
- **Input:** N× `image` + JSON `prompts` array. Empty prompt → COCO; non-empty → DINO.
- **Live:** yes. Caps: `CATALOG_YOLO_ALT_LIMIT=7`, `MAX_PER_RUN=500`, `CONCURRENCY=6`, `CATALOG_YOLO_BACKFILL_ENABLED=true`.

### 1.4 Grounding DINO (open-vocab, via the same microservice)

- **Prompt builder:** `mediaYoloRefine.js:154-178` `buildOpenVocabPrompt`. Period-separated classes from `CatalogProduct.category` splits, last 1–2 title tokens, then `"product"` and `"object"`. **Does not ask for logo / brand mark / printed emblem.**
- **Trigger:** catalog-product Media only (`mediaYoloRefine.js:204-232`). UGC: no prompt → COCO.
- **On hit:** synthesize `refinedProducts` from CatalogProduct metadata, **skip GPT refine** (`:260-262`).
- **On miss / non-catalog:** paid GPT-4.1 refine (`:268-276`). Comment ~$0.03/media (`worker.js:312`).
- **Could it detect a Gymshark chest logo?** The HTTP contract is free-text (`yoloService.js:15-16`; `yolo_service.py` `/detect` forks on `prompt`). Grounding DINO is built for "detect this phrase." Production **never sends that phrase.** I did **not** live-POST a logo prompt (no billable/load-bearing calls this pass). Unverified: recall on a small metallic graphic at chest scale.

### 1.5 GPT-4.1 crop refine

- **Entry:** `cropRefineService.js:56`, model `'gpt-4.1'` at `:251` (Atlas maps this — `atlasModelMap` not re-read this pass).
- **Trigger:** DetectRun after identify (`detect.js:1048-1054`); ingest when DINO empty or source ≠ catalog-product.
- **Returns:** tight per-product boxes in **source pixels**, plus `croppedImageUrl`.
- **Live:** yes on those paths. Catalog + DINO hit skips it.

### 1.6 Dual-engine identify (DetectRun UGC only)

- GPT-4.1 `yoloIdentifyService.js:36,122` + Gemini `geminiIdentifyService.js` (`GEMINI_VISION_MODEL \|\| 'gemini-2.5-flash'`).
- **Skipped** for `catalog-product` (`detect.js` `skipIdentify: true` at catalog pipeline `:559`).
- Paid. Mutates `DetectionArtifact.yoloProducts[].identification` / `engines`.

### 1.7 GPT-4.1 subjects + "OCR" — the actual `Media.text[]` writer

- **Entry:** `subjectTextService.js:33` `detectSubjectsAndText`, model `'gpt-4.1'` `:44`.
- **Trigger:** DetectRun `runSubjectsTextChain` (`detect.js:1105-1115`), parallel with YOLO. Image, catalog DetectRun, and video-hero. **Not** ingest YOLO. **Not** Apify.
- **Returns:** `subjects[]` (0–1), `text[]` `{id, content, type, x1,y1,x2,y2, confidence}` (0–1), background, shotType, faceVisible, contentNature.
- **Persisted:** `DetectionArtifact.text` + **wholesale `$set Media.text`** (`detect.js:245-270`, `:640-661`). Failure writes `[]` (`emptySubjectsText` `:1138-1145`) and **overwrites** prior text — documented as a real lie in `routes/ads.js:5424-5454` / `seedTextTruth.js`.
- **Cost:** one paid GPT-4.1 vision call per DetectRun still.
- **Coverage:** only Media that complete DetectRun detect-fanout. Catalog ingest YOLO does not OCR. Apify IG DetectRuns are deferred (`POST_DETECT_DEFER_TO_CATALOG=true`, `apifyIngestService.js:451-468`). Official IG OAuth `postSyncService` still enqueues DetectRuns immediately (subagent; not re-opened this pass).

### 1.8 Face keep-out + face-safe crop (titling, generated plate)

- **Entry:** `basePlateCropService.js:796` `ensureFaceDetectionForKeepOut` → `detectClipBoxes` `:454` → `detectFrameBoxes` `:404`.
- **Trigger:** `brandScriptExecutor.js:2466` (adgen; backend sibling exists but is dormant under the adgen handoff). Gated `TITLE_FACE_KEEPOUT=true` (`defaults.env:1881`).
- **Input:** **`ad.veoVideoUrl`** — the generated master. Cloudinary `so_<sec>` stills, 640px wide. **Not** catalog stills.
- **Prompt** (`DETECT_SYSTEM_PROMPT` `:379-387`): JSON `{ subject, face }` fractions. `"subject" is the tight box around ALL important content (people, products, text).` `"face"` is the primary head including headwear.
- **Model:** `'gpt-4.1'` at `:409`. Comment: 3–4 serial frames, ~$0.02 (`:47-52`). Cache on `Ad.basePlate` when `sourceUrl === ad.veoVideoUrl`.
- **Keep-out drops `subject`.** Only `faceSamples` are returned (`:882-888` region) and applied via `applyFaceKeepOut` (`plateIntelService.js:639`).
- **Live:** default on.

### 1.9 Plate intel (titling, generated plate)

- **Entry:** `plateIntelService.js:455` `analyzePlate`; `semanticScan` `:382`.
- **Trigger:** `remotionRenderService.js:917` unless `TITLE_PLATE_SCAN=off`. Adgen `defaults.env:1835` **`TITLE_PLATE_SCAN=gemini`**.
- **Input:** ffmpeg frames of the **Remotion plate** (the video being titled).
- **Returns:** `{ samples: [{ atSec, bands: { top|middle|bottom: { lum, busy, avoid } } }] }` — **three coarse bands**, not rects. Gemini prompt (`:387-392`) marks bands that would cover "a face, the product itself, or the visual focal point."
- **Cost:** `basic` = free sharp. `gemini` = `TITLE_SCAN_MODEL \|\| 'gemini-2.5-flash'` (`:404`).
- **Persisted:** in-memory `inputProps.plateHints` only. Not a Media field.
- **Live:** yes in adgen.

`plateIntelService.js:86-93` **already names the Gymshark class of failure**: busy/texture is "the score that moves copy off a printed garment wordmark," and sampling the wrong strip is "the mechanism behind the 2026-08-21 `layout_safe_box` QC failures ('the caption overlay is placed directly on top of the primary back logo')." That is **band texture on the generated plate**, not ingest YOLO.

### 1.10 Overlay zones

**Gemini** `overlayZoneService.js:104`, model `GEMINI_VISION_MODEL \|\| 'gemini-2.5-pro'` (`:41`). Comment $0.039/call, measured $143 / 3641 calls = 64% of a $223 Pelagic Gear resync (`dinoOverlayZoneService.js:7-8`).

**DINO math** `dinoOverlayZoneService.js:203` `analyzeFromRefinedProducts`. Pure reprojection of `Media.refinedProducts` source-pixel boxes into a **crop rect of that same still**. Classes `['product','face','secondary_subject','text','object','other']`. Logo-like **labels** (`/\b(text|label|logo|tag|writing|sign|badge|emblem)\b/i`) map to `text` at strictness 0.5 (`:72-75`) — post-hoc on whatever DINO already returned, which production never asked to find.

Backend `OVERLAY_ZONES_MODE=dino` (`defaults.env:732`). Gemini is fallback when refinedProducts empty or `cropRect` missing (`detect.js:1705-1748`). Adgen **has** `overlayZoneService`, **does not have** `dinoOverlayZoneService`. Adgen's only caller is PMax split density on a **seed outfill** (`atlasVideoService.js:3164`), not titling.

Header claims it loses on-product text and names "cheap OCR (Tesseract local)" as add-back (`dinoOverlayZoneService.js:31-40`). That comment is **unaware of `Media.text[]`**. See §2.

### 1.11 Vision QC (post-render, not placement)

- `adVisionQcService.js`. Video `layout_safe_box` is "framing/visibility — no fixed geometry" (`:1840-1843`). `text_defects` is on-product lettering (woven labels, hang tags, embossed logos) (`:1833-1836`).
- **Default OFF** (SystemConfig `staticVisionQcEnabled` / `videoVisionQcEnabled`, subagent; not re-opened). Even on, it **rejects after the fact**. It does not place type.

### 1.12 videoProductAnchor (prompt only)

- `videoProductAnchor.js:39` `VIDEO_PRODUCT_ANCHOR === 'true'`. **Not in adgen `defaults.env` → off.**
- Reads `Media.subjects[]`, `refinedProducts[]`, `matchedProducts[]` and names a coarse region for the **lifestyle prompt**. Explicitly deferred for crop/titling (`:18-21`): "seed-image boxes applied to generated-video dims" needs a mapping that does not exist. `basePlateCropService` does not consult this module.

### 1.13 Other (short)

| Name | Entry | When | Cost | Titling? |
|---|---|---|---|---|
| GPT crop judge | `judgeService.js` | DetectRun crop-judge | gpt-4.1 | no |
| Shot heuristic | `imageShotHeuristicService.js` | DetectRun + ingest classify | free sharp | no |
| Focus Laplacian | `imageQualityService.js` | DetectRun derivations | free | no |
| Visual SKU match | `visualCatalogMatchService.js` | UGC DetectRun match | gemini-2.5-flash | no |
| Brand-safety keywords | `brandSafetyService.js:69` | matcher, uses `Media.text` strings | free regex | no |
| Ad suitability | `adSuitabilityService.js:62` | DetectRun derivations | $0 consumer | no |
| Ingest shot-classify | `ingestShotClassifyService.js` | catalog sync | free | no |
| Whisper/NER | deleted (`detect.js:16-22`) | — | — | — |

### Schema bug (load-bearing)

`mediaYoloRefine.js:289` `$set`s `yoloProducts` onto Media. **`models/Media.js` does not declare `yoloProducts`.** Mongoose strict (default; no `{ strict: false }`) **drops** undeclared paths — the schema itself documents this trap for `yoloFailReason` at `Media.js:108-110`. Canonical store of raw YOLO is `DetectionArtifact.yoloProducts` (declared, `DetectionArtifact.js:26`). Adgen Media also lacks `yoloDetectedAt` / `yoloFailReason` (backend has both at `Media.js:103,111`). An adgen `Media.save()` can strip those stamps. `vendor-manifest.json` does not mention this gap.

---

## 2. The OCR question, settled

**Who writes `Media.text[]`?** `subjectTextService.js:130-136` via DetectRun `$set`. Cited as the only production writer by `routes/ads.js:5425-5427` and `seedTextTruth.js:34`. I grepped writers, not just readers. Confirmed.

**Is it local?** No. GPT-4.1 vision. No tesseract in either `package.json`.

**Is it the YOLO microservice?** No. YOLO returns product/object boxes, not scene text.

**Is it Apify?** No. Apify writes `Comment.text` (`apifyIngestService.js:514-515`) and creates Media; it does not populate `Media.text[]`. Per-post DetectRun is deferred.

**Coverage:** DetectRun stills only. Catalog ingest YOLO (`mediaYoloRefine`) never writes text. Failed subjects-text **zeros** the array.

**Boxes?** Yes. Normalized 0–1 of the **analyzed still**. Type enum `product_label|brand|serial|warning|general`. A shark **symbol** will not land here unless the model also emits a `brand` box around a graphic — unverified, and even then the box is on the **catalog/UGC still**.

**Is `dinoOverlayZoneService`'s Tesseract comment unaware, or is `Media.text[]` unfit?**

Both, for different jobs:

- **Static overlay of a catalog crop (same still):** `Media.text[]` **is** the add-back that comment is wishing for — boxes, already paid if DetectRun ran. The comment is unaware. Wiring would be code-only: union `text[]` (scale 0–1 → source pixels via `media.width/height`) into `analyzeFromRefinedProducts` as `classification:'text'` restrictions. Caveat: catalog DetectRun is deferred, so at ingest-YOLO time `Media.text` is usually empty. The add-back only exists **after** ad-time DetectRun.
- **Native type on a generated video frame:** `Media.text[]` is **unfit**. Wrong image. A Gymshark chest logo on Omni is not a string on the catalog still.

---

## 3. The YOLO microservice

**Source:** not in this workspace. GitHub `github.com/madecastro/yolo_microservice`, Render autodeploy (`docs/PROD_DEPLOY.md:101`). `yolo_service.py` fetched 2026-09-05.

**Weights / classes (verified from that file):**
- Primary: `YOLO_MODEL` default `yolov8x.pt` — Ultralytics YOLOv8x, COCO 80 classes. **No logo class.**
- Open-vocab: `YOLO_OPEN_VOCAB_MODEL` default `IDEA-Research/grounding-dino-tiny`. Free-text prompts.
- OpenCV rects: class_name `"object"`.
- gpt-4o-mini fallback: class_name `"product"` — **paid**, UGC/sparse path.

**`/detect-video` today:** used. For ingested videos without an IG thumbnail, to pick a hero JPEG and collect COCO boxes across the clip. It does **not** accept a DINO prompt. It is **not** "run open-vocab on generated ad frames." Treating it as the keep-out engine would be a category error.

**Logo / printed mark:**
- COCO: no.
- Grounding DINO: **yes in principle**, if you send `"logo. brand mark. printed emblem. gymshark."` to `/detect`. Production ingest prompt does not. `/detect-video` cannot. I did not live-test logo recall.

---

## 4. The opportunity — what is computed but not reaching the renderer

Remotion `inputProps` (`remotionRenderService.js:992-1004`) are:

```
format, safeZoneKey, platformFormat, plate, meta, tokens, spec, plateHints
```

No `refinedProducts`, no overlay `restrictions`, no `Media.text`, no logo box. Keep-out is `plateHints.samples[].bands.{top,middle,bottom}.{avoid,busy,lum}` consumed by `Canonical.resolveGroupAnchor` (`Canonical.jsx:242-289`).

### Per signal

| Signal | Reaches Remotion? | Space | Transfer to generated frame? |
|---|---|---|---|
| `Media.refinedProducts` | **No.** Used for reframe (`reframeStrategyChooser`), quotes, seed ranking. Titling never loads Media. | Source still, **pixels** | **(b) fresh detection.** `dinoOverlayZoneService.reprojectBboxToCrop` (`:97-118`) needs a crop rect **of that still**. A Veo frame is a new image. Homography does not exist. `videoProductAnchor.js:18-21` already deferred this on purpose. |
| OverlayZoneArtifact `restrictions[]` | **No** for Remotion. **Yes** for static overlay templates (`overlayPlacementService.js`, `layoutInputService.js:3448`). | 0–1 of **analyzed crop** | **(b).** Same-still crop math. Extended 9:16/1.91 generated stills already fall through to Gemini because they have no `cropRect` (`detect.js:1706-1710`). |
| `Media.text[]` | **No.** Seed ranking (`seededUniverseService.js:91-93`) and burned-in-text reporting only. | 0–1 of **source still** | **(b).** Unfit for Gymshark graphic. Fit for static overlay add-back after DetectRun. |
| Faces (`Ad.basePlate.faceSamples`) | **Yes**, as band `avoid`. | 0–1 of **generated** source frame; remapped through crop via `mapSourceFaceToPlate` (`plateIntelService.js:596-618`) | **(c) already on the plate.** |
| `detectClipBoxes.subject` | **No.** Already paid when faces run. Keep-out **drops it**. Prompt says it includes "people, products, text." | 0–1 generated frame | **(a)-shaped wiring, $0 extra, too coarse for Gymshark.** On a chest close-up the subject **is** the garment. Flagging it avoid-all-bands hits `Canonical.jsx:250-256` (every band dirty → keep authored). That **is** the collision. |
| Plate intel busy / gemini avoid | **Yes.** | Generated plate bands | **(c) already on the plate.** Band-granular. A small silver shark on a large pink field does **not** move mean texture enough. Gemini "avoid the product" on a product-filling close-up dirties every band, then authored is kept. |
| videoProductAnchor | **No** (prompt only, flag off) | Source still | **(b)** if ever used for crop. Not titling. |
| Vision QC | After the fact | Generated frames | Not placement. |
| Brand.logoUrl | Composited logo, no bbox | n/a | Irrelevant to on-garment marks. |

### The Gymshark frame, inspected

File exists:

`/Volumes/Sayulita/Projects/RS/.wt-director-title-cards-fix/title-preview-output/after-prompt-fix/6a9c65e6fb5073eec0cb50c8-titlecards_f155.png`

I viewed it. Pink long-sleeve, face cropped to collarbone, silver Gymshark shark on the chest, white title **"The top for your run and your coffee run"** sitting **on the mark**. Lower torso is empty pink.

Would ingest data in Mongo have prevented this? **No.**

- Catalog product box = the shirt in a packshot / on-model still. Omni invented a new close-up. The box does not map.
- `Media.text[]` would be GPT reading the **catalog photo**. A graphic shark often has no letters. Wrong frame regardless.
- DINO overlay `text` class only fires if a **label string** matched `logo|tag|…`. Ingest prompt never asks for logo, so the label is `"hoodie"` / `"product"`, classified as `product` at strictness 1.0 covering the **whole garment**. Reprojecting that onto a generated close-up is meaningless.
- Face keep-out: **no face in frame**. If anything, a leftover chin at the top flags `top` avoid and **pushes type onto the chest** — the opposite of what we want. Consumer census noted the same on trunk `…_f173.png`.
- Band busy: large flat pink, tiny metallic mark. Mean texture stays low.
- Prior session (gbrain fact #101): "Remotion keep-out even shifted upperThird→center and still hit the zoomed chest logo. No existing video-plate brand-logo bbox." That matches the code.

**Hard part, not glossed:** even a perfect catalog logo box is the wrong image. The keep-out map for native type on Omni **must be computed on sampled generated frames.** `/detect-video` is not that job (COCO, ingested mp4, hero-frame). `/detect` **with a logo prompt on Cloudinary stills of `ad.veoVideoUrl`** is that job, and the stills are already being fetched by `detectClipBoxes`.

---

## 5. What else ingest should be doing (ranked by value-per-effort)

Honest list. Not invented work.

### 1. Stop DetectRun from destroying ingest DINO boxes — high value, code-only

Catalog ingest YOLO runs Grounding DINO **with** a product prompt and synthesizes `Media.refinedProducts` for $0 GPT (`mediaYoloRefine.js:260-262`). Ad-time `ensureDetectForProducts` (`catalogProductDetectService.js:387`) then runs `runCatalogProductPipeline`, which calls `detectMultipleProducts(yoloBuffer)` **with no prompt** (`detect.js:908`) → COCO, then paid crop-refine, then **`$set`s `Media.refinedProducts`** (`:640-661`). That overwrite is the load-bearing input for $0 reframe crop (`reframeStrategyChooser`). Empty/generic boxes fall through to nano-banana outpaint (commented `REFRAME_COST_USD=0.08`).

This is the real "we already paid for it and then threw it away" bug. Files: `pipelines/detect.js` `runYoloChain` / catalog denorm — skip YOLO+refine when `yoloDetectedAt` is set and `refinedProducts.length > 0`, or pass `buildOpenVocabPrompt` into DetectRun YOLO.

### 2. Declare `Media.yoloProducts` or stop writing it — hygiene, 5 lines

`mediaYoloRefine.js:289` writes a field mongoose drops. Either add it next to `refinedProducts` in `models/Media.js` (and adgen's copy), or delete the `$set`. Also port `yoloDetectedAt` / `yoloFailReason` onto adgen Media so a `save()` cannot strip them.

### 3. Add logo classes to the **ingest** DINO prompt — cheap, helps **static** overlay only

`buildOpenVocabPrompt` (`mediaYoloRefine.js:154`) could append `"logo. brand mark. printed emblem."` (and the brand name). Overlay DINO would then have a small `text` restriction on catalog crops. **Does not fix generated-video type.** Do it if static overlay still hits hang tags; do not sell it as the Gymshark fix.

### 4. Feed `Media.text[]` into `dinoOverlayZoneService` — static only, after DetectRun

The Tesseract comment is the wrong add-back. DetectRun already paid GPT-4.1 for boxed text. Union those rects as `classification:'text'` when overlay runs. File: `dinoOverlayZoneService.js` + `detect.js:1735` caller. Worthless for Omni frames.

### 5. Do **not** wire `/detect-video` into titling

Wrong input (ingested mp4), wrong model (COCO), no prompt, 30–60s. The stills titling already has are Cloudinary `so_<sec>` JPEGs. Call `/detect` on those.

### 6. Do **not** add Tesseract

Would miss a graphic shark, add a native binary, and duplicate a GPT-4.1 path that already has boxes on the wrong image.

### 7. `detectClipBoxes.subject` as extra avoid — tempting, $0, **does not solve this defect**

On a chest close-up the subject box **is** the collision. Band-avoid-all → keep authored (`Canonical.jsx:250-256`). Skip.

### 8. Adgen `yoloService.js` is dead

If titling calls Grounding DINO, the adgen client must grow a `prompt` argument (backend already has it at `yoloService.js:19-21`). Today it cannot.

Ingest is otherwise **well-used** for what it is: product boxes for reframe, match, static overlay, seed ranking. The gap is not "ingest computes a keep-out map and nobody reads it." The gap is "nobody detects logos on the generated plate."

---

## 6. Recommendation

**Cheapest real path to a keep-out map that can place native Remotion type off a Gymshark chest logo:**

Detect the mark **on the generated frame**, then dodge a **rect**, not a third of the frame.

1. **Reuse the already-paid plate vision.** `detectClipBoxes` already samples `ad.veoVideoUrl` (3–4 GPT-4.1 calls, cached on `Ad.basePlate`, default on via `TITLE_FACE_KEEPOUT`). Extend `DETECT_SYSTEM_PROMPT` (`basePlateCropService.js:379`) to also return `logo` (and `text`) boxes — tight, not "all important content." Persist next to `faceSamples`. **$0 extra** on every titled ad that already pays this call.

2. **Point Grounding DINO at those same stills as the graphic-mark specialist.** The tiny DINO weights are already loaded on the microservice. `POST /detect` with prompt `"logo. brand mark. printed emblem. <brand>."` on the 640px Cloudinary stills `detectClipBoxes` already built. Self-hosted, no new LLM. This is the model the ingest eval already trusted on Gymshark **products**; logos are the open-vocab job. Adgen `yoloService.js` needs the `prompt` argument backend already has. Latency is the tax (~15–20s/image on CPU per microservice comments) — run it **once** on the title-phase still, not on every ffmpeg sample, and cache on `Ad.basePlate` like faces.

3. **Generalize `applyFaceKeepOut` into rect keep-out** (`plateIntelService.js:639`). Same mapping through `cropRect`. Flag a band `avoid` when a **logo** rect overlaps it — and, for native type, pass the rect into Canonical so a band that is mostly clear pink can still **offset** the stack away from a small mark instead of hopping to a worse band or keeping authored.

4. **Canonical must grow a within-band dodge.** `resolveGroupAnchor` (`Canonical.jsx:242-289`) only hops top/middle/bottom. On this frame the lower torso is empty pink; a band hop to `lowerThird` would have worked **if** the logo rect flagged center. On a zoomed mark that still sits in the chosen band, hopping is not enough — native text has to shift/shrink inside the group box. That is the actual Remotion work for "move video title typography off gpt-image-2 onto native Remotion text." gpt-image-2 cards cannot punch a hole; native text can.

**Do not** reproject ingest boxes. **Do not** add Tesseract. **Do not** turn `/detect-video` into a titling API. **Do not** pay a new Gemini overlay pass on the plate — `TITLE_PLATE_SCAN=gemini` already runs and is the wrong granularity.

### Files to change (titling keep-out)

| File | Why |
|---|---|
| `liquidretail_adgen/src/services/basePlateCropService.js` | Logo/text in `DETECT_SYSTEM_PROMPT`; persist on `Ad.basePlate` |
| `liquidretail_adgen/src/services/yoloService.js` | Add `prompt` (copy backend `:19-21`); call `/detect` on plate stills |
| `liquidretail_adgen/src/services/plateIntelService.js` | Rect keep-out, not face-only |
| `liquidretail_adgen/src/services/remotionRenderService.js` | Pass logo samples next to `faceKeepOut` |
| `liquidretail_adgen/src/services/brandScriptExecutor.js` | Thread the new keep-out blob into `renderTitles` (already does faces at `:2466`) |
| `liquidretail_adgen/src/remotion/compositions/Canonical.jsx` | Within-band dodge against logo rects |
| `liquidretail_adgen/src/models/Ad.js` | Comment/`basePlate` shape already Mixed; document the new keys |

### Files to change (ingest, separate, do not block titling)

| File | Why |
|---|---|
| `liquidretail_backend/pipelines/detect.js` | Don't overwrite ingest DINO `refinedProducts` with unprompted COCO |
| `liquidretail_backend/models/Media.js` | Declare `yoloProducts` or stop `$set`ting it; keep adgen Media in sync for YOLO stamps |
| `liquidretail_backend/services/mediaYoloRefine.js` | Optional: append logo classes to `buildOpenVocabPrompt` for **static** overlay |
| `liquidretail_backend/services/dinoOverlayZoneService.js` | Optional: union DetectRun `Media.text[]` as text restrictions |

### If a new detection call is unavoidable

It is, **on the generated frame**. It is **not** a new vendor. Grounding DINO is already paid-for infrastructure (Render box). GPT-4.1 plate vision is already on the titling receipt (~$0.02/ad). Expanding that JSON is the first move; DINO on the same still is the backup for a mark GPT boxes as "subject=whole torso."

I did not live-run DINO on the Gymshark still (no POSTs). Unverified: whether `grounding-dino-tiny` boxes a ~4% silver graphic at 640px. If it misses, the GPT `logo` key from step 1 is the fallback; if both miss, **then** a new paid vision call is justified. Exhaust those two first.

---

## Unverified (explicit)

- Render dashboard overrides of `TITLE_PLATE_SCAN`, `TITLE_FACE_KEEPOUT`, `ADGEN_DIRECTOR_TITLE_CARDS`, `OVERLAY_ZONES_MODE`, `YOLO_OPEN_VOCAB_ENABLED`. Repo defaults cited; live env not read.
- Grounding DINO recall on a small on-garment graphic (no live `/detect`).
- Whether production `Media.yoloProducts` exists from a pre-strict or raw `collection.updateOne` write. Mechanism of the drop is real.
- Whether adgen `Media.save()` has actually wiped `yoloDetectedAt` in prod. Mechanism is real.
- Exact Atlas mapping of `'gpt-4.1'` on today's transport (comment in `detectFrameBoxes` says `openai/gpt-5.6-terra`; not re-verified).
- `$` figures in comments ($0.039 overlay, $0.03 refine, $0.02 detectClipBoxes, $143/$223 Pelagic) — cited as **comments**, not re-measured this pass.
- Whether the f155 preview's `keepOut:` log showed a band hop. The PNG collision is verified by viewing the file.

verify: every load-bearing claim above is `path:line` or a fetched `yolo_service.py` quote; Mongo contents and live DINO logo recall are marked unverified.
