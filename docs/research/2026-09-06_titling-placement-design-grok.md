# Title placement on a generated video frame

**Status:** design only. No production files edited.
**Repos cited:** `liquidretail_adgen` (live renderer) and `liquidretail_backend`. Always named.
**Looked at the actual frames** for ad `6a9c65e6fb5073eec0cb50c8` (Gymshark Reels), not just the inventory.

---

## What I would build, in one paragraph

Stop asking the plate-intel Gemini call which *horizontal band* to avoid. It cannot solve this. Keep using the GPT-4.1 boxes we already pay for on the generated plate (`detectClipBoxes` in adgen `src/services/basePlateCropService.js`) — but **stop throwing the subject box away**. Persist per-frame `subject` next to `face`, union those boxes **per title phase**, and if a phase’s subject leaves a usable side gutter, pin that phase’s Remotion group into a copy column on the empty side. Same CSS override Canonical already has for PMax landscape (`panelBox`), lifted off the landscape-only gate and sized to the *gutter*, not a 50/50 split. Fail closed to today’s full-width stack. That is the P0 that fixes the full-body frame. A follow-up extends the same already-paid vision JSON with `marks[]` (logo / printed text on the garment) so the zoomed chest-logo frame stops compositing type on the chevron. No new detector, no YOLO on the generated ad, no `@remotion/layout-utils`, no director title cards, no per-ad LLM placement author. The backend/adgen merge is **not a prerequisite**.

---

## The frame that started this, honestly

Three stills of the same 10s Gymshark Reels plate, native-path-equivalent overlay (the title-card experiment used the same copy and the same group box):

| Still | ~time | What’s in the plate | What’s wrong with the type |
|---|---|---|---|
| `title-preview-output/6a9c65e6fb5073eec0cb50c8-titlecards_f46.png` | ~1.9s @ 24fps (hook) | Full-body model, beige void on both sides | Headline sits on her torso. **This is the owner’s sentence.** There is empty beige to the left (and right) of the subject. |
| `…/after-prompt-fix/6a9c65e6fb5073eec0cb50c8-titlecards_f155.png` | ~6.5s (proof/close, logo-zoom beat) | Torso fills ~90% of the frame; Gymshark chevron is a **pixel in the plate** | Type sits on the logo. There is no empty half. A 50/50 split still lands on the garment. |
| `title-preview-output/6a9c65e6fb5073eec0cb50c8-titlecards_f173.png` | later in the zoom | Same close-up | Same collision, lots of unused pink *below* the block. |

These are two different placement failures that happen **in the same ad, in sequence**, because the canonical Omni camera beats are *pan → logo zoom → reveal* (`canonical.json` description, lines 3–4 of adgen `src/remotion/presets/canonical.json`). Hook has a gutter. Proof is a close-up of the mark. A whole-clip union of the subject box is the zoomed torso and would forfeit the hook gutter. Placement **must be per phase**.

`chooseSubjectSide` in adgen `src/services/pmaxSplitStrategy.js:95-154` would **defer on both frames**: f46 is a centered person (dead zone ±0.05 around 0.5, `:62`) whose silhouette is wider than `MAX_SUBJECT_WIDTH_FRACTION` 0.55 (`:74`). f155 is worse. The PMax 50/50 split is the wrong primitive for 9:16 lifestyle. Do not reuse it as-is.

---

## 1. Where the keep-out map for a GENERATED frame comes from

### Decision

**Primary signal: `detectClipBoxes` subject boxes on the generated plate. Already paid. Currently discarded.**

**Not:** catalog YOLO / DINO / `Media.text` / `overlayZoneService` rectangles. Those live in the catalog still’s coordinate space. The video plate is a new image. A box on the still does not transfer. The merge does not change that.

**Not:** plate-intel Gemini avoid-bands, as the thing that *chooses a copy side*. Granularity is wrong.

**Not:** a new `/detect-video` call, as P0. Evidence below.

### 1.1 plateIntel director arm — verified, insufficient for a copy side

**Repo:** `liquidretail_adgen` `src/services/plateIntelService.js` (738-line copy; backend’s 679-line copy lacks this arm).

| Fact | Where |
|---|---|
| Runs on the generated plate every titling render unless `TITLE_PLATE_SCAN=off` | `remotionRenderService.js:917-921`; adgen `config/defaults.env:1835` ships `TITLE_PLATE_SCAN=gemini` |
| Samples **5 frames** on a 10s plate: 0.5, 1.5, 3.5, 5.5, 7.5s | `:467-472` `[0.5, 1.5, d*0.35, d*0.55, d*0.75]` |
| Extraction: `ffmpeg-static` one PNG per seek (`:247-262`). **Full-resolution**, not the 96×160 greyscale used for luma |
| Luma/busy: greyscale resize **96×160**, median luma, `busy = min(1, 3×stddev)` | `analyzeFrameBands` `:314-357` |
| Bands: `top [0.14,0.28]`, `middle [0.40,0.55]`, `bottom [0.52,0.65]` — **three horizontal strips, full width** (unless `panelSide` already known) | `BANDS` `:57-61`; `resolveBandXRange` `:292-311` |
| Gemini `semanticScan` asks only: for each frame, which of `{top,middle,bottom}` to **avoid** because they cover a face, the product, or the focal point | `:387-392` |
| Contract out: `{ samples: [{ atSec, bands: { top\|middle\|bottom: { lum, busy, avoid } } }] }` — **9 scalars + 3 booleans per sample. No boxes.** | `:481-488` |
| Model: `TITLE_SCAN_MODEL \|\| 'gemini-2.5-flash'` (not lite) | `:404` |
| Director extras (`directorScanAppendix` `:359`, `hints.directorBriefs` `:420`, `hints.directorFrames[]` `:511-529`) only fire when a `director` payload is passed — i.e. the **off-by-default title-card path** | flag `ADGEN_DIRECTOR_TITLE_CARDS=false` |

Canonical consumes this as **one vertical-anchor hop per group for the whole clip** (`resolveGroupAnchor`, `Canonical.jsx:242-290`). `avoid` is unioned across all samples; `busy` is max (`bandStateFor` `:61-82`). Candidates are only other vertical anchors (`KEEP_OUT_CANDIDATES` `:40-46`). There is no horizontal candidate.

On f46 every band overlaps the person. When every band is `avoid`, the function **keeps the authored band** (`:256`). That is why keep-out can shift `upperThird → center` and still sit on the torso. Bands cannot express “put the words in the beige.”

**Cost of this call today:** one Gemini 2.5 Flash vision request with 5 full-res PNGs, every video title. Ledger rates in adgen `costTracker.js:70`: `$0.30 / $2.50` per million in/out plus whatever Atlas actually bills for the images. **Settled USD per titling scan is UNCONFIRMED** (defaults.env `:1831-1834` says the same). I would not add a *second* vision pass. I would, after P0 is proven, consider dropping this Gemini avoid-band pass entirely (`TITLE_PLATE_SCAN=basic`) and keeping only the $0 luma/busy scan for ink polarity.

`resolveBandXRange` already knows how to score luma on a west/east column (`:301-308`) **once a `panelSide` exists**. Production never passes one (`analyzePlate` call at `remotionRenderService.js:921` does not pass `panelSide`). Built, unwired — same shape as Canonical’s `panelBox`.

### 1.2 Face filmstrip — the right *call*, the wrong *field kept*

**Repo:** adgen `src/services/basePlateCropService.js`.

`ensureFaceDetectionForKeepOut` (`:796-894`) already runs on the generated `ad.veoVideoUrl` post-generation, pre-titling, even when no crop is needed (`:47-57` header: full-frame 9:16 skips the *crop* but keep-out may still pay detection once). Default on (`TITLE_FACE_KEEPOUT` default `'true'`, `:78-79`). Cached on `Ad.basePlate` (`Mixed`, adgen `models/Ad.js:472`).

`detectClipBoxes` (`:454-510`):

- Samples Cloudinary `so_<sec>` JPEGs at 640px via `buildFrameUrls(..., { width: 640, isReel: true })` (`:455-457`). `planTimestamps` with `isReel:true` (`videoFrameService.js:33-45`): clips ≤4s → 1 mid frame; **≤20s → quartiles, max 4, so a 10s reel is 3 stamps: 2.5 / 5.0 / 7.5s**. That is *not* `filmstripFrameCount` (that helper is the crop-geometry sampler, ~1/2s, 3–8). Do not conflate them. Three stamps land almost one-per-phase on the canonical 8s grid scaled onto 10s (hook/proof/close). Mid-phase wander inside hook’s pan is **not** visible with one sample — acceptable for P0; if production shows hook columns that the pan walks into, bump this path to `isReel: false` (5 stamps, ~+$0.01), do not add a second detector.
- GPT-4.1 vision (`:409`; Atlas maps the legacy id). Prompt (`DETECT_SYSTEM_PROMPT` `:379-387`) returns **both** `subject` (tight box around people, products, **text**) and `face` (head only, including headwear; “Include nothing below the chin”).
- Cost in-file: ~3–4 vision calls ≈ **$0.02** per ad that needs a crop; keep-out-only on a 9:16 is the same call once; $0 on cache hit (`:47-57`). Rate table `costTracker.js:23` `gpt-4.1` $2.50 / $10.00 per M.
- Returns `{ subject, head, frames, faceHits, envelope, faceSamples }` where `subject` is the **clip-level union** and `faceSamples` is `[{ atSec, face }]` — **subject is not in the per-frame array** (`:499-502`).

Then `detectionExtras` (`:712-722`) persists `faceSamples` / `envelope` / `facesComputed` and **drops `subject`**. `applyFaceKeepOut` (`plateIntelService.js:639-705`) collapses each face box into `bands[].avoid` with a 20% overlap test. The horizontal extent of the subject — which `decideSplitPanelDrift` in the same file (`:215-218`) already calls *“sitting in already-paid-for detection output, unused”* — never reaches Remotion.

**This is the P0 source.** Same call, keep the field we already paid to get. Coordinate space is already documented: source-frame fractions 0..1, mapped through `cropRect` when the plate is a crop (`mapSourceFaceToPlate` `:596-618`).

Quorum: `FACE_MIN_FRAMES = 2` (`faceSafeCrop.js:332`). A 0-hit (true headless product shot) still returns **subject** boxes; those are the ones we need for a packshot. Do not gate copy-side on a face quorum.

### 1.3 YOLO `/detect-video` — exists, not on generated ads, cannot do the chest logo

**Repo:** `liquidretail_backend/services/yoloService.js` (the real client). Adgen has a thinner vendored copy at `src/services/yoloService.js` with **zero callers** in `liquidretail_adgen/src` (confirmed: no `require` of it). Dead in the live renderer.

Backend callers of `detectFromVideo`:

- `pipelines/detect.js:1071` `runYoloVideoChain` — ingest UGC video
- `pipelines/inventory.js:23` — legacy truck-bed upload

Neither is the titling path. Neither is a generated ad.

Endpoint: `POST ${YOLO_SERVICE_URL}/detect-video`, timeout **120s** (`:31`), one retry on transient. **No `prompt` field** on the video call (`:25-28`). Open-vocab / Grounding DINO is only on `/detect` and `/detect-batch` when a prompt is supplied (`:10-22`, `:42-56`).

Return (`:76-97`): clip-level `{ detections: [{ x1,y1,x2,y2, className, firstSeenSec, cropBuffer, … }], heroFrameBase64, heroFrameSec }`. One hero frame, not a per-timestamp track. `firstSeenSec` is “when this product first appeared,” not “where the chest logo is at 6.4s.”

Grounding DINO on a *generated still*, hypothetically, after the merge:

- Backend `buildOpenVocabPrompt` (`mediaYoloRefine.js:154-178`) emits category tokens + last title words + always `product` and `object`. **`brand` is accepted and never inserted. Never emits `logo` / `wordmark`.**
- `dinoOverlayZoneService.js:31-34` **states in code** that this path *loses* “On-product text detection (woven labels, hang tags, embossed logos).”
- The `logo` regex at `:72-75` classifies a label that already came back; it is not a detector.
- Python `yolo_service.py` is **not on this volume**. Exact checkpoints, whether `/detect-video` can take a prompt, and latency on a 10s 1080×1920 — **UNCONFIRMED**. I will not design as if it can localise “logo on garment.”

Pricing: the HTTP call is treated as $0 token spend. Wall clock is the cost (up to 120s, and a 5-frame `/detect-batch` scales the timeout, `:71`). I will not put a 2-minute Python hop on the titling critical path for P0.

**Verdict:** `/detect-video` is the wrong tool. If P1’s `marks[]` prompt on the *already-running* GPT-4.1 call fails to find garment logos, a canary of `/detect` with prompt `logo. brand mark. printed text.` against the *same* 640px filmstrip stills is the fallback — $0 tokens, new latency, quality explicitly doubted by our own DINO overlay comments. Not the lead.

### 1.4 `Media.text[]` — has boxes, on the wrong image

**Writer:** backend `services/subjectTextService.js` `detectSubjectsAndText` (`:33`), GPT-4.1, called from `pipelines/detect.js` `runSubjectsTextChain` (`:1105`).

Shape (`:57-58`, `:130-136`): `{ id, content, type, x1, y1, x2, y2, confidence }` — **boxes, not bare strings.** Schema is `Media.text: [Mixed]` (`models/Media.js:81`).

Consumed at `pipelines/detect.js:1896` as `text: media.text || []` into `scoreMedia` (ad-suitability), and as a boolean “does the seed have burned-in text” (`seedTextTruth.js:99-100`). **No consumer is Remotion.**

Those boxes are on the **catalog/UGC still**. The Gymshark chevron in f155 is a pixel the video model painted. Seed OCR cannot point at it.

### 1.5 Catalog `primarySubjectRectPct` / `refinedProducts` — same coordinate-space wall

Persisted, real rectangles, already used to steer **plate generation** (PMax split side, reframe, overlay zones). `copyPanelRectForSubjectSide` (`pmaxSplitStrategy.js:211-214`) is called from adgen `atlasVideoService.js:3167-3178` to judge whether the *outfill still’s* copy half is calm — **before** the video exists, **never** to place a title. `PMAX_SPLIT_VIDEO` defaults **false** (`aiCreativeDirectorService.js:1322`).

`dinoOverlayZoneService.js` is pure math that reprojects `Media.refinedProducts` into a *crop of that same still*. After merge, adgen could call it. It still would not know where the subject is in a Veo/Omni frame.

**Do not launder catalog boxes into title placement.** Using them as a prior (“this SKU’s hero is usually a centered on-model”) is a later hint, not a coordinate.

### 1.6 Cost table for anything new

| Option | Extra $ | Extra wall | Spatial grain | On generated plate? | Verdict |
|---|---|---|---|---|---|
| Persist `subject` from `detectClipBoxes` | **$0** (same 3 GPT-4.1 calls we already make for keep-out on a 10s reel; 1–4 depending on duration) | 0 | Per-frame box, typically 3 samples (one per canonical phase) | Yes | **P0** |
| Add `marks[]` to the same JSON | ~50–150 extra output tokens / frame, ~$0.001 | 0 | Logo/text boxes on *this* frame | Yes | **P1** |
| Gemini avoid-band (already on) | already paying | already paying | 3 booleans | Yes | Keep for ink; do not use for side |
| New Gemini “pick a copy side” | another Flash vision call | seconds | Unreliable spatial (title-card experiment: numeric coords did not confine glyphs) | Yes | **No** |
| `/detect-video` on the master | $0 tokens, up to 120s | 120s | Clip-level products + one hero frame | Would be, not today | **No** |
| `/detect` + DINO prompt on filmstrip | $0 tokens | seconds–minutes | Open-vocab boxes; code says it misses garment logos | Would be | P1 fallback only |
| `overlayZoneService` Gemini Pro on a frame | ~$0.01–0.03 + ~50s (ingest measured $143 / 3641 calls, `dinoOverlayZoneService.js:7-9`) | 50s | Real `restrictions[]` | Would be | **No** — we already have GPT-4.1 boxes cheaper |
| Transfer catalog YOLO | $0 | 0 | **Wrong image** | No | **No** |

---

## 2. How the signal reaches Remotion

### 2.1 Today’s path (unchanged spine)

```
brandScriptExecutor.renderWithRemotionAndSave  (:2357)
  resolveSpec → validateTitleSpec (every cascade tier)
  applyBenefitsPlacement                       (:2408)
  resolveBasePlateVideoUrl                     (:2449)
  ensureFaceDetectionForKeepOut                (:2466)  → faceKeepOut
  renderTitles({ videoUrl, spec, tokens, faceKeepOut, safeZoneKey, … })  (:2493)
    remotionRenderService.renderTitles         (:1079)
      maybePrepareDirectorTitleCards           (:1090)  no-op: flag off AND generator undefined
      child renderTitlesJob                    (:868)
        analyzePlate                           (:921)   → plateHints.samples[].bands
        applyFaceKeepOut(plateHints, faceSamples) (:934)
        inputProps = { format, safeZoneKey, platformFormat, plate, meta, tokens, spec, plateHints }
                                               (:992-1004)
        renderMedia → Canonical.jsx
          groupSlots by phase|anchor
          resolveGroupAnchor(plateHints)       → vertical hop only
          stackContainerStyle                  → full-width safe box
          panelColumnStyle                     → ONLY if panelSide && format==='landscape'
                                               (Canonical.jsx:385-387)
          planGroupFit → SLOT_RENDERERS
```

`inputProps` has **no `panelSide`**. Grep of adgen `remotionRenderService.js` and `brandScriptExecutor.js` for `panelSide`: empty. Canonical’s `panelBox` path is dead in production. `validateTitleSpec` is not in this hop for placement — keep-out already mutates geometry at render time (`effectiveAnchor`), not by rewriting the spec. **P0 follows that pattern.** Do not put `panelSide` on the spec for the first ship.

### 2.2 What I would add

**New pure module** (adgen): `src/services/titlePlacementService.js`

```
chooseCopyBox({
  subjectSamples: [{ atSec, subject, face, marks? }],  // source-fraction boxes
  phases: spec.phases,                                  // hook/proof/close windows
  format, safeZone, cropRect, sourceW, sourceH
}) → {
  byPhase: {
    hook:  { side: 'west'|'east'|null, box: {x1,y1,x2,y2}|null, reason },
    proof: { … },
    close: { … }
  }
}
```

Rules, decided:

1. **Per phase, not per frame, not whole-clip.** Map samples into `[phase.startSec, phase.endSec]` (after `specTimeScale`, same way Canonical already compresses 8s spec onto a 10s plate). Union the subject boxes in that window. One copy box per phase, stable while that phase’s slots are on screen. Titles do not chase the subject inside a phase (groups already don’t reflow; `Canonical.jsx:8-10`).
2. **Gutter column, not 50/50.** `leftClear = union.left`, `rightClear = 1 - union.right`, minus safe insets. Pick the roomier side. Column width = `clamp(clear + 0.04, MIN_COLUMN, MAX_COLUMN)` with `MIN_COLUMN = 0.28` (~300px @ 1080, enough for wrapped headline at `maxLines` 3) and `MAX_COLUMN = 0.46` (already the landscape cap in `safeZones.js:392`). A centered on-model with ~0.20 beige each side still gets a 0.28 left column that overlaps an arm and **misses the face + chest**. That is the f46 fix. `chooseSubjectSide`’s 0.55 width cap and 0.10 dead zone would defer; we do not use them here.
3. **Face veto.** If the chosen column overlaps the phase’s face union by more than the existing 20% band test, try the other side; if both fail, `side: null` (full-width + today’s vertical keep-out).
4. **Fail closed.** Missing samples, degenerate boxes, column narrower than `MIN_COLUMN` after face trim, or subject covering both sides (f155) → `side: null`. Canonical paints today’s stack. Never throw. Same total-function posture as `chooseSubjectSide` and `decideSplitPanelDrift`.
5. **Drift check inside the phase.** Reuse `decideSplitPanelDrift` (`basePlateCropService.js:327`) against the phase’s per-frame subject boxes. If the union said west but a late sample in the same phase walks into the column (`drifted: true` or `null`), drop that phase to full-width. The comment at `:307-311` is exactly this failure mode: the video model wanders; seed-time intent is not the clip.

**Persistence.** Extend `faceSamples` to `subjectSamples: [{ atSec, subject, face }]` in `detectClipBoxes` (`:499-502`) and `detectionExtras` (`:712-722`). `Ad.basePlate` is already `Mixed`; no schema migration. Cache hit on retitle stays $0.

**IPC.** `brandScriptExecutor.js:2523-2528` already passes `faceKeepOut` across the child boundary as a JSON object of numbers. Add `subjectSamples` on that object. `assertNoBuffers` is why we send fractions, not PNG buffers (comment at `:2503-2513`).

**`plateHints` shape, extended not replaced:**

```
{
  samples: [ { atSec, bands: { top, middle, bottom } } ],   // unchanged, ink + vertical hop
  copyByPhase: {
    hook:  { side: 'west', box: { x1: 0.075, y1: 0.14, x2: 0.355, y2: 0.65 } },
    proof: { side: null, box: null, reason: 'subject-too-wide' },
    close: { side: 'west', box: { … } }
  }
}
```

Computed in `renderTitlesJob` *after* `applyFaceKeepOut`, from `faceKeepOut.subjectSamples` + `spec.phases` + `safeZoneKey`. One extra pure function. No new I/O.

**Canonical.jsx** (`:373-387`, `:513-527`):

- Lift the `format === 'landscape'` gate.
- Per group, `copy = plateHints.copyByPhase[group.phase]`.
- If `copy?.box`, override `placed.left/right` from `copy.box` (same two-line override as `panelBox` at `:525-527`). Vertical anchor / `slotEnvelope` / fit planner unchanged.
- Pass `panelSide: copy.side` into `capCtx` so `deriveCharCap` already-existing panel-aware branch (`slotContent.js:307-308, 385`) tightens the character budget to the column. That path is written and tested (`verifyPmaxSplitTitlePanel.mjs`); it just never sees a live `panelSide` on 9:16.

**`validateTitleSpec`:** P0 teaches it **nothing**. Placement is not a spec field, same as `effectiveAnchor`. Unknown spec fields continue to be dropped (`:528-531` writes a closed `treatment` object; position is a closed object at `:455`). An LLM that authors `position.panelSide` today is **silently stripped**. That is correct for P0. If we later want an operator/LLM *hint*, add optional `position.panelSide: 'west'|'east'|null` (default null) and let keep-out override it — never the other way around. Do not add it until a caller exists.

**Ink.** When a phase has a side, pass that `panelSide` into `analyzePlate` so luma/busy is scored on the column (`resolveBandXRange` is already there). When phases disagree, leave the scan full-width (today’s ink). Do not block P0 on per-phase ink; a slightly conservative ink vote is readable, a wrong column is not.

### 2.3 Time window, restated

| Strategy | What happens on this Gymshark ad | Verdict |
|---|---|---|
| Static side for 10s | Hook gets beige; proof’s west column is her left shoulder | Better than today on hook, still on the garment in the zoom |
| Whole-clip union keep-out | Union is the zoomed torso → defer everything to full-width | **Today’s bug, with extra code** |
| Per-frame animated box | Type crawls every 2s; groups are designed not to reflow (`Canonical.jsx:8-10`) | No |
| **Per-phase union** | Hook: west column in the beige. Proof: defer (subject too wide) → full-width + P1 marks for the chevron. Close: re-evaluate on the reveal shot | **This** |

Phases already cut on the camera beats (hook 0–2.7 / proof 2.7–5.1 / close 5.1–8 on the nominal 8s grid, scaled onto 10s by `specTimeScale`). We are not inventing a clock.

---

## 3. The LLM-authored treatment spec

### What exists

The only LLM that authors a title spec today is **operator Title Studio**, backend `routes/brand.js` `runModifyTitleSpec` (`:2043`). It is **not** on the render path. Automatic per-ad spec construction is `titleSpecService.resolveSpec` cascade + `composeFunnelSpec` + `applyBenefitsPlacement` — no model.

That modify call uses `atlasTextService.generate` with **no model override**, so `ATLAS_TEXT_MODEL_ID` or **`anthropic/claude-sonnet-4.6`** (`atlasTextService.js:25`), `maxTokens: 8000` (`brand.js:2101`), one repair retry against `validateTitleSpec`. It is **not** `gemini-2.5-flash-lite`.

### What an LLM can meaningfully vary *today* (must survive `validateTitleSpec` `:246-593`)

Everything in inventory §1.2. Practically, given what presets actually use (inventory §2.2):

| Axis | LLM can author | Renderer honours | Useful for “art direction, real fonts, editable text”? |
|---|---|---|---|
| `tokenOverrides.fonts` (3 roles, family ≤80 chars) | yes | yes, via font ladder | **Yes** — this is the brand-type lever |
| `tokenOverrides.colors` (15 keys, `#RRGGBB` only) | yes | yes | Yes, within brand |
| `treatment.fontRole / weight / sizeScale / maxLines / trackingPx / casing / shadow / colorToken / accent` | yes | yes | Yes |
| `position.anchor / align / offsetX±0.25 / offsetY±0.25 / maxWidthPct 0.2–1` | yes | yes, then keep-out may hop the **anchor** | Align/maxWidth are how a human would push type off a subject — but keep-out should own this, not the LLM, or they fight |
| `timing.*` / `transition.*` / `phase` keys | yes | yes | Yes |
| `scrim` | yes (frosted/solid/card/none) | yes | **Do not use.** Owner no-scrim rule. Every shipped preset is `'none'` even when the description lies |
| `itemLayout / itemStyle / …` (badges/benefits) | yes | yes | Schema-live, unused by presets; benefits placement already authors `sizeScale 0.92` in code |
| `treatment.stroke`, weight bump, contrast flip, `fitPlan.scale` | **no** — stripped or injected at render | yes | Inventory §1.3. A designer cannot request or suppress them |

Fail-safe, already built: `validateTitleSpec` returns `{ normalized: null }` on any error (`:588`). `resolveSpec` falls through to the next cascade tier, floor `canonical.json`. Modify-title-spec retries once with the error list, then fails the *job*, not the render (`:2096-2129`). Invalid LLM output cannot ship.

### What would widen the design space (only if we mean it)

1. Optional `position.panelSide` on the spec — a *hint*, keep-out wins. Not P0.
2. Admit `treatment.stroke: bool` so a brand can ask for contour instead of hoping the marginal-band injector fires.
3. Turn on `scrim: card` for a specific brand that wants it. Product call, not a schema change.
4. Automatic per-ad spec author. **I would not add this to fix placement.** Placement is geometry from boxes. The Gymshark type already looks like Gymshark; it is sitting in the wrong place.

### Cost sanity on `~$0.00025 / gemini-2.5-flash-lite`

Ledger: adgen `costTracker.js:109` `'google/gemini-2.5-flash-lite': { input: 0.10, output: 0.40 }` $/M tokens.

`$0.00025` is **~1.5k in + 250 out**. That is a compact “change these three axes” prompt, not a full spec rewrite.

A real modify-style call (schema prompt ~2–3k tokens + `JSON.stringify(canonical vertical)` ~2–4k + brand tokens + 3–6k output) is **~$0.002–0.003 on flash-lite**, about **10×** the prior figure. Attaching plate frames as vision is extra and **UNCONFIRMED** on lite.

The *existing* Title Studio path on Sonnet 4.6 (`costTracker.js:28` $3 / $15 per M) is ~**$0.04–0.08 per operator modify**, not per ad. Fine for a human in the studio. Not a thing to fire on every video.

**Decision:** no per-ad LLM spec for P0/P1. If we later want automatic treatment variation, a flash-lite call that receives *the current spec + a 10-line plate summary* (`copyByPhase` + ink) and is allowed to vary only `sizeScale / maxLines / align / weight / accent / tokenOverrides.colors.accent`, then `validateTitleSpec`, then fall through. Budget ~$0.002. Do not send five PNGs. Do not let it set `offsetX` or `anchor` — those are keep-out’s.

---

## 4. Text fitting — skip `@remotion/layout-utils`

Verified again: **zero imports** of `@remotion/layout-utils` in adgen, backend, the title-card worktree. Declared, unused.

The DOM/CSS path already fits text, three layers:

1. **Horizontal budget** — `deriveCharCap` (`slotContent.js`), `AVG_CHAR_WIDTH_EM 0.70` × `CHAR_CAP_SAFETY 0.91`, already panel-aware when `panelSide` is set (`:307-308`).
2. **Line clamp** — `-webkit-box` + `WebkitLineClamp: t.maxLines` + `overflow:hidden` (`slotRenderers.jsx:142-146`). Truncates at a line boundary with ellipsis, never through a glyph.
3. **Vertical group fit** — `planGroupFit` (`stackFit.js:368+`): shrink together to `SHRINK_FLOOR 0.82`, drop the rating reviews line, drop trailing rows. Explicitly “never clip through an element” (`:16-38`). `overflow:hidden` on the stack is the last-resort net (`safeZones.js:325-326`).

Known gap, documented at `Canonical.jsx:730-738`: neither estimator models font weight, and both run *before* the render-time +100 weight bump, so a 2-line budget can wrap to 3 and clamp. That is a real `measureText` win, and it is **not this bug**. The Gymshark headline is not overflowing; it is sitting on the subject.

**Decision:** do not adopt `layout-utils` in this work. If we later want deterministic glyph measurement, do it as its own pass against the weight-bump bug, with a harness on `verifyStackFit.mjs` / `verifyFormatAwareCharCaps.mjs`. P0’s column will make the *existing* char-cap path fire (narrower `usableWidthPx` → more wrapping → `maxLines` clamp). That is the intended degradation in a 0.28 column, not a reason to add a package.

---

## 5. Experiment-branch defects vs the production native path

All three were found on `fix/director-title-cards` with `ADGEN_DIRECTOR_TITLE_CARDS` forced on. Production is DOM/CSS slots. **(a) and (b) cannot recur on native. (c) can, in a weaker form, and is mostly intentional.**

### (a) Opaque card keeps a baked checkerboard — **experiment-only**

`directorTitleCardGenerate.js:71,100` (worktree): `cornersTransparent = as[2] < 64` is false on a fully opaque PNG, so `checker && a < 180` never keys. Measured 3/4 cards 100% opaque, grey slab in the video.

Native path never calls `generateTitleCard` (double gate: flag `'true'` *and* a passed generator; `generatorIfEnabled()` returns `undefined` when off). No PNG, no RGBA keying, no checkerboard. `TitleCardSlot` is unused. **Cannot recur.**

### (b) Non-final card forced to `phase.endSec` → 3.7s gap — **experiment-only**

`directorTitleCardService.js:430-432` `phaseCardTiming`: non-final phases always get a finite exit at `phase.endSec`. Combined with 10s plate vs 8s spec, a harness still sampled a hole.

Native slots author their own `exitAtSec`. Canonical vertical hook headline **already exits at 2.4s** (`canonical.json:94`), proof quote **enters at 2.7s** (`:121`). Close is a new group. There is no card-replace step, so there is no 37% empty hole from this function. (Native *can* hold a slot to clip end with `exitAtSec: null` — brandPill does, and it is `visible: false`. That is overlap-by-design, not a gap.)

**Cannot recur** as stated. Do not port `phaseCardTiming` onto DOM slots.

### (c) Hook and proof generated with identical copy — **can recur, usually on purpose**

Title cards collected per-phase copy and, for this ad, typeset the same sentence from 0.67s–7.67s.

Native bindings differ: hook `headline` ← `meta.headline`; proof `quote` ← `quoteSnippet` then `quote`; a second proof `headline` is `visibleWhenEmpty: "quote"` (`canonical.json:140-170`) — **the claim restatement when the quote is gated empty**, owner 2026-08-05. If this ad has no quote, proof *will* show the same headline. That is the fallback working, not a generator repeating itself. It does not occupy a 3.7s hole; it occupies the proof window (2.7–4.8s), then close takes over with productName / delivery / CTA.

**Useful check, not a title-card port:** if hook headline === proof visible copy, that is a copy/meta problem (`videoTitleDirection` / quote pool), not a placement problem. Out of scope here.

---

## 6. Ship order

Assume the merge **does not** land first. It does not help P0. Subject boxes already live in adgen.

### P0 — smallest increment that visibly fixes f46, near-zero spend

**What you see:** on a full-body / mid-shot phase, type sits in the beige (or the roomier side), not on the torso. On the zoomed phase, type stays where it is today (full-width). Honest: **P0 does not fix f155’s chevron.** Say that in the PR.

**Files (all adgen unless noted):**

| File | Change |
|---|---|
| `src/services/basePlateCropService.js` | `detectClipBoxes` emits `subjectSamples: [{ atSec, subject, face }]`. `detectionExtras` persists them. `ensureFaceDetectionForKeepOut` returns them. Do not change the prompt yet. |
| `src/services/titlePlacementService.js` | **New.** Pure `chooseCopyBox`. Total function. No I/O. |
| `src/services/brandScriptExecutor.js` | Pass `subjectSamples` on the existing `faceKeepOut` object (`:2523`). |
| `src/services/remotionRenderService.js` | After `applyFaceKeepOut`, run `chooseCopyBox`, hang `copyByPhase` on `plateHints`. Still no `panelSide` at the analyzePlate call unless every phase agrees. |
| `src/remotion/compositions/Canonical.jsx` | Per-group, honour `copyByPhase[phase].box`; lift landscape-only gate; thread `panelSide` into `capCtx`. |
| `src/remotion/lib/safeZones.js` | Optional: `gutterColumnStyle({ box, dims, zoneKey })` that takes an explicit `{x1,x2}` rather than a 50% split. Or just inline the two-line left/right override. I would add the helper so 9:16 cannot silently pick up `PANEL_COLUMN_WIDTH_CAP` 50% math. |
| `scripts/verifyTitlePlacementGutter.js` | **New harness.** Fixtures: (1) f46-like centered person with 0.22 gutters → west column ≥0.28, does not include face; (2) f155-like subject width 0.9 → `side: null`; (3) subject east of 0.62, width 0.35 → west; (4) phase union where a late frame drifts → that phase defers; (5) missing samples → null, no throw. |
| `scripts/verifyFaceKeepOut.js` / `verifyBasePlateCrop.js` | Pin that `subjectSamples` round-trip through extras/cache. |

**Not in P0:** validator changes, YOLO, Gemini prompt changes, layout-utils, title cards, catalog boxes, merge plumbing.

**Prove it:** retitle ad `6a9c65e6fb5073eec0cb50c8` (or the current live equivalent) with the flag-off native path. Still at f46 (hook) should show type in the left beige; still at f155 may still hit the logo. `$0` extra model spend if `Ad.basePlate.facesComputed` is already set; otherwise the keep-out call we already make.

### P1 — the chest logo (f155)

Same GPT-4.1 JSON, extra key:

```
{"subject":{…},"face":{…}|null,"marks":[{"left","top","right","bottom","kind":"logo"|"text"}]|[]}
```

Keep existing keys first in the prompt so face/subject quality cannot regress. Persist `marks` on `subjectSamples`. In `chooseCopyBox`, if `side` is null (no gutter) **and** a mark overlaps the group’s full-width stack, nudge `offsetX` away from the mark (clamped ±0.25, already legal) and/or shrink `maxWidthPct`, preferring the side of the stack with more remaining room. Fail closed to today’s overlay if the nudge would push type out of the safe zone.

Canary: if `marks` comes back empty on known Gymshark close-ups, *then* try `/detect` + `logo. brand mark. printed text.` on the same 640px stills (merge helps here because backend’s `yoloService.detectMultipleProducts` already takes `opts.prompt`; adgen’s dead copy does not). Do not lead with that.

**Do not change the Gemini avoid-band prompt to return boxes.** The title-card spatial-steer experiment already showed the image model ignoring numeric coords; asking Flash for a rect we already get from GPT-4.1 is a second bill for a worse box.

### P2 — cleanups, only after P0 is in production

- When `PMAX_SPLIT_VIDEO` actually ships, pass the *same* `panelSide` that steered outfill into `renderTitles`. Landscape titles currently ignore a column the plate was generated to protect. One prop.
- If P0’s gutter + existing face flags make Gemini `avoid` redundant, set `TITLE_PLATE_SCAN=basic` and stop paying Flash for three booleans. Keep the $0 luma/busy scan; ink still needs it.
- Optional `position.panelSide` on the validator, hint-only.

### Explicitly out of scope

- Migrating off title cards (they are off).
- `@remotion/layout-utils`.
- Per-ad LLM spec author.
- Using catalog YOLO / `Media.text` / `overlayZoneArtifact` as coordinates on a generated frame.
- Waiting for the repo merge.

---

## Merge

The standing assumption (renderer can call backend detection services) **does not unlock P0 or P1.** The boxes we need are already produced inside adgen, on the generated plate, on the titling path.

What merge *would* simplify: P1 fallback (Grounding DINO `/detect` with a logo prompt, backend client has the prompt field; adgen’s copy doesn’t, and nothing in adgen calls it). That is a fallback I hope not to need.

What merge cannot do: make a catalog-still box true on a Veo frame.

---

## Unconfirmed (did not verify)

- Live Render dashboard overrides for `TITLE_PLATE_SCAN`, `TITLE_SCAN_MODEL`, `TITLE_FACE_KEEPOUT`, `PMAX_SPLIT_VIDEO`, `YOLO_OPEN_VOCAB_ENABLED`. Read committed `defaults.env` / code defaults only.
- Settled USD of the Gemini 5-frame title scan. Rates exist; a CostLog row was not queried.
- Whether Atlas maps `gpt-4.1` to `openai/gpt-5.6-terra` on the live transport (comment at `basePlateCropService.js:409` says it does; not re-probed).
- `yolo_service.py` checkpoints, `/detect-video` prompt support, measured latency.
- Whether `fcf3709` / title-card code is on adgen `origin/master`. Local production path does not import it as live.
- Whether this specific ad’s `Ad.basePlate.subject` would already be in cache if we started persisting today (we never have, so every first titling after P0 lands will pay the keep-out call we already pay).
- Exact pixel gutter on f46 (read from the PNG by eye: beige each side ~0.18–0.25 of width; `MIN_COLUMN = 0.28` is chosen to still fire). Measure in the P0 harness off a real extracted still before locking the constant.
- Whether `detectClipBoxes` on this ad used the 8s duration fallback or `ad.videoDurationSec` (gbrain fact #103: stale 8s fallbacks were being patched in a sibling worktree, not on the dirty checkouts). Quartile stamps move if the duration argument is 8 vs 10. `chooseCopyBox` must use the same duration the samples were taken at.

---

## What I would tell the owner

The overlay is not stupid in the way a missing detector is stupid. We already locate the person on the generated frame, three times on a 10s reel, for about two cents, and then throw away the part of the answer that says where they are left-to-right. Vertical band-hopping cannot put “The top for your run…” in the beige. A 50/50 PMax split would look at this clip and refuse to try. The fix is to keep the subject box, decide per hook/proof/close, and pin the existing DOM title stack into the empty side when there is one. The zoomed Gymshark logo is a second, smaller problem — same vision call, ask it for the mark too — and P0 will not pretend to solve it.
