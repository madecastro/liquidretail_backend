## 0. CORRECTIONS — 2026-08-04. Read before trusting anything below.

Four claims in this file were wrong. Each was verified against live code, the installed
packages, or a real production render.

**(a) "MERGE PR #32 FIRST — video spend is UNRECORDED" — STALE. Already fixed, better.**
`models/CostLog.js:34` now has `COST_STATUSES = ['ok','error','timeout','rejected',
'rejected-billing','failed','charged-no-output','submitted']` — all three values PR #32 wanted,
plus two more. And `services/costTracker.js:148-160` now *normalises* an unknown status to
`'error'` with a loud `❌` log instead of dropping the row, so the whole class of bug is closed
structurally. Landed via PR #43 / `68a0ee0`, not PR #32. PR #32 is 3 commits stale and
`CONFLICTING`. **Its one still-valuable piece is the unlanded GEN-1 security guard** (an
`engine !== 'remotion'` 400 on `POST /api/brand/:id/preview-script`, closing an
authenticated-tenant RCE via three doors). Land that on its own; do not merge the branch.

**(b) "The font errors are a RED HERRING … chasing the font 404 first would waste a session"
— EXACTLY BACKWARDS. The font 404 IS the root cause of the fatal video failure.**
Chain, every link verified:
1. `library-match` Inter resolves to `localPath = FONTS_DIR/Inter.ttf`
   (`fontResolverService.js:279`, `fontLoader.js:31`).
2. `fontsToUrls` (`remotionRenderService.js:291`) rewrites to `/fonts/<basename>`, and
   `assetPathFor` (`:149-150`) maps `/fonts/*` ONLY to `FONT_CACHE_DIR` (= `assets/webfonts`).
   File is in `fonts/`, lookup in `webfonts/` → **404**.
3. The 404 branch set **no CORS header** (only the success path did, `:176`), so the browser
   reported a CORS failure and `FontFace.load()` rejected with `A network error occurred`.
4. **`node_modules/@remotion/fonts/dist/cjs/load-font.js` ends `catch (err) { cancelRender(err) }`.**
   `loadFont` cancels the render ITSELF. Confirmed in the installed package, v4.0.495.
5. `FontLoader.jsx`'s `.catch(...)` logging *"using fallback stack"* is a **FALSE SAFETY NET** —
   it runs after `cancelRender` and cannot un-cancel. The file's header comment claiming "a
   render must never fail because a webfont 404'd" was a lie in the code.
`Could not extract frame from compositor / Request closed` is downstream collateral from the
aborted page, not the fault. **Control proof:** 2026-08-01 renders succeeded because that
brand's fonts all resolved via Google, so the files really were in `webfonts/`. The bug is
deterministic for `library-match` — which is where the curated Inter/Lora defaults live.
Also note the fix is NOT a directory rename: google + custom fonts legitimately live in
`webfonts/`, so renaming would break the two branches that work.

**(c) "Safe zones do not reconcile … titles are floating far higher than necessary" —
REAL BUT MISDIAGNOSED. Fixing `safeZones.js` alone would change NOTHING.**
Measured every one of the 192 frames of a real Stories render (1080x1920):
- topmost text y=279 = **0.1453** of H (safe top 0.14) — sits exactly on the boundary
- lowest text  y=744 = **0.3875** of H, against an allowed limit of **0.65**
- left x=84 = 0.0778 (safe 0.075); right x=965 = 0.8935 (limit 0.925)
**Zero safe-zone breaches anywhere in the video.** Text never descends past 0.3875 while
permitted to 0.65, so `bottom: 0.35` is NOT the binding constraint — **504px / 26.2% of frame
height is unused because the layout is top/upperThird-anchored** (`remotion/lib/safeZones.js`
`ANCHOR_TOP`). The lever is anchor selection, not the safe-zone constant.
The Reels/Stories collapse is still a real latent bug, and the numbers still disagree — but
note **neither source is right for both surfaces**: remotion's 0.35 bottom is plausibly correct
for *Reels* (tall caption/action rail) and far too conservative for *Stories*, while
`platformFormats`' 250px is plausibly right for *Stories* and its 204px looks too small for
*Reels*. **Confirm against Meta's published spec before locking any number in** — do not derive
the fractions from `platformFormats`, that would push Reels titles under the caption rail.

**(d) "Video path not QC'd on [competitor marks]" — now QC'd, and it HAS the defect.**
See §0.1.

### 0.1 What a real render actually looks like (2026-08-04)

**Static** — pulled the three live `2026-08-03` renders and viewed them. **1 of 3 carries the
competitor mark**, matching the reported rate. The defect ad is `ai_editorial`
(`1_1-ai_editorial-69977681-7447a677.png`): a **Timberland tree emblem on the midfoot of an
Allbirds shoe**. I pulled the ORIGINAL product photo
(`Media.fileUrl`, media `6a4e7ea956509c2169977681`) — it is **completely clean, no mark on the
panel**. The emblem is a pure hallucination with no source.
**Likely mechanism, worth testing: the product is "Men's Tree Runner NZ".** A literal *tree*
emblem on a product named *Tree Runner* looks like product-name semantics leaking into the
artwork, not a random competitor logo. That suggests a targeted prompt/negative lever in
addition to measure-and-reject.
The other two renders are genuinely good — clean type hierarchy, correct `allbirds` wordmark
and debossed midsole mark.

**Video** — the 2026-08-01 titled Story (`brand_script/product-1785618231946-9-ia67yyu7.mp4`,
Gymshark Muscle Tee, 8s @ 24fps) is the only titled output that exists. **Titling itself is
fine**: serif headline "Meet your new favorite Muscle Tee", then a working quote gate
rendering *"The athletic fit is perfect."* — ALEX R. The creative failure is the **last 29% of
the clip**:
- text absent frames **137–191 = 5.71s→7.96s (2.29s)** — no title, no CTA, no end card
- the model is **fully back-turned** — featureless black shirt back, Gymshark chest logo gone
- **white Nike sneakers with clearly visible swooshes**, sharp and stable across every frame
So the ad's final impression is a competitor's logo. Confirmed with output-seeking (`-i` before
`-ss`) across three stable frames; this is not a decode artifact.

**ROOT CAUSE — it is the REFERENCE STACK, not the prompt and not hallucination.**
`Ad.veoReferenceImages` for ad `6a6e5e6a57a1c6217fd33e8a` holds exactly three images:
| pos | content |
|---|---|
| REF0 (seed) | model **front-facing**, **black** sneakers |
| REF1 | model **fully back-turned**, wearing **white Nike sneakers, swoosh visible** |
| REF2 | three-quarter view, black socks |
The back-turned ending and the Nikes are **REF1, faithfully reproduced**. Omni did what the
prompt told it — *"the first image is the primary scene, the rest are additional views of the
same product"* (`veoPromptBuilder.js:337-340`) — treated the stack as a sequence and dissolved
through the views. That also explains the ~5.0s cross-dissolve (front → back), which is
therefore normal behaviour, NOT a generation artifact. Two earlier reads in this session were
wrong and are corrected here: the ghosting is a legitimate shot transition, and the Nikes are
not the model inventing a competitor mark.
**OWNER INPUT 2026-08-04 — read before "fixing" this.** A back view is **not** a bad reference;
the owner considers it useful for fidelity. And: *"we found with too many images it was
hallucinating"* — so **do NOT raise the reference count** to compensate. Corroborating evidence:
the static Timberland ad sent **exactly ONE** reference and still invented the emblem, so ref
COUNT is not the driver; ref quality/role is. `DEFAULT_REFERENCE_IMAGE_COUNT = 3`,
`MAX = 7` (`atlasVideoService.js:762-763`) — keep 3.

**Selection is purely positional today.** `buildReferenceImages` (`atlasVideoService.js:1791-1807`)
= seed at position 0, then catalog mirrors in `hero-first / createdAt asc`, truncated. Owner,
verbatim: *"we are taking the first three images by default."* Whatever lands 2nd/3rd by
createdAt becomes a reference — for a typical PDP set that is LEFT/BACK.

**PREVALENCE — this is NOT an edge case.** 423 video ads; 130 carry reference stacks across 86
products and 10 brands; refcount distribution `{1:35, 2:10, 3:85}` — **65% carry three refs**.
Confirmed on a second brand/category: Allbirds "Men's Wool Cruiser" ref R2 is literally named
`..._PDP_BACK_....png`. Also spotted: "Fujimurasaki Matcha" uses an
`encrypted-tbn0.gstatic.com/shopping?q=tbn:` **Google Shopping thumbnail** as a reference for a
$1.00 video generation — a separate reference-quality bug.

**THE MISSING PIECE: there is no view/angle field on Media.** The detect pipeline already
populates `subjects`, `text`, `background`, `primarySubjectDesc/Label`, `technicalInsights`,
`adSuitability`, `classification`, `refinedProducts` — but nothing records front vs back vs
detail. That is exactly why selection is positional: it has nothing else to sort on.

**RECOMMENDED DIRECTION (discussed with owner, not yet built):**
1. **Minimal, free, testable first:** the stack is consumed as a SEQUENCE, so the fix is not
   reordering but making the CLOSING BEAT return to the primary view. `buildVeoPrompt` Scene 3
   says *"zoom out to reveal the full product"* without saying WHICH view. Prompt-only change.
2. **Classify view ONCE at ingest**, not per generation — stamp Media with
   `view: front|back|detail|lifestyle|packaging` (~$0.0016/image with flash, one time). Ordering
   then becomes free and deterministic forever; a per-generation Director call re-pays that cost
   and is non-reproducible.
3. **Share that ingest call with the brand-safety screen** (§0.2 known limit / task): one look at
   each ingested image returns view angle + competitor marks + text presence.
4. Leave the **Director** to sequence a script from already-labelled views, which matches the
   owner's stated intent that an enabled Director should drive the camera prompt — rather than
   doing perception work per run.

**Secondary, still worth doing — the canonical prompt has real gaps** (`veoPromptBuilder.js`
`OMNI_DIRECTIVES:156-193`):
- It locks the CAMERA and the PRODUCT but never the PERSON. `cameraStyle` says "The product
  stays completely static"; `physicalAccuracy:186-188` preserves "face, hair, skin tone, and
  identity" — **identity, but not pose or orientation**. For apparel the product is worn by a
  person the prompt does not govern.
- **Self-contradiction:** `transitions:172` allows *"Smooth crossfades only, ~0.25s"* while
  `doNot:190-192` bans *"morphing, or dissolves."* A crossfade IS a dissolve. The measured one
  also ran ~0.4s+, longer than the stated 0.25s.

### 0.2 Vision QC — there was none, at all

Verified: `aiJudgeService` runs BEFORE render and scores Director *concepts*
(`campaignAdsGenerationService.js:2293`); `judgeService.judgeDetections({imageUrl,...})` has
**zero call sites** (dead code); `directImageRenderService.js:711` states validation runs
*"BEFORE the billable submit, deliberately"*; and nothing reads the final `renderUrl`.
**That is why the Timberland emblem ships — nothing ever looks at the output**, and it is why
"the fix is measure-and-reject" was never actionable: the measure half did not exist.

**Model, probed LIVE against the real defect** (not chosen from a spec sheet). Both candidates
route and both caught the emblem:
| model | verdict | cost/check | contract |
|---|---|---|---|
| `google/gemini-2.5-pro` | "competitor's logo (Timberland) … debossed into the heel counter … absent from the original" | ~$0.011 | **exact requested JSON shape** |
| `google/gemini-2.5-flash` | also caught it, localised it slightly better | ~$0.0016 | **BROKE the shape** — returned `competitor_marks: false` as a bare bool, hoisted `findings` |
**Use `gemini-2.5-pro`.** The $0.0094 delta is noise against the $0.01–0.17 generation it
protects, and a malformed verdict either ships a bad ad or burns a needless regeneration.
Register it as a **new `vision-qc` role** — do NOT repoint `'gpt-4.1'`, which
`atlasModelMap.js` warns is shared by 11 services.
Owner-approved behaviour: **auto-regenerate exactly ONCE**, then `status:'failed'` + Slack;
**keep the discarded render** (already paid for); **surface findings in the generation details**
(follow `imageGeneration`/`intentResolution`: `models/Ad.js:337,347` → `renderService.js:1157`
→ `routes/ads.js:1888-1889,1944-1953`). All four checks: competitor marks, product fidelity vs
original, text defects, layout/safe-box.

**KNOWN LIMIT OF THIS QC — it cannot catch the video Nike case.** The check compares render
against the ORIGINAL, so it only catches marks the model INVENTED. The Timberland emblem
qualifies (original was clean → caught). The Nike sneakers do NOT: they are genuinely present
in REF1, a real Gymshark catalog photo sitting in our own Media library, so render-vs-original
correctly passes them. **Competitor branding that enters through source imagery needs a
separate brand-safety screen at media ingest / reference-selection time.** Two different
defects that look identical in the finished ad; do not expect one control to cover both.

### 0.25 PROVEN LIVE — the font fix works ($0 validation, 2026-08-04)

Deployed `45b7419` to both services, then re-ran ONLY Remotion titling against the already-paid
master of the ad that failed on 08-03 (`6a7017ee51cea04158ad8b47`, Allbirds, meta_reels_9_16).
Zero new spend. Log:

```
fonts=heading:Inter(library-match) body:Inter(library-match) quote:Lora(google)
render 25% -> 50% -> 75% -> 100%
TITLING_OK 76.2s
AFTER url=.../brand_script/product-1785735868132-1-uajivuga.mp4
```

That is the exact `library-match` case that used to die at ~3s. **No compositor error, no
"A network error occurred", and critically NO `font load failed for Inter` warning** — which is
the positive proof Inter actually LOADED rather than soft-failing to a fallback. Deployment
sanity check on the box: `assets/fonts` = 17 files, `assets/webfonts` = **0** (it only fills
on-demand per brand), which is exactly why every library-match request 404'd before.

**Non-fatal, worth tracking:** a `ProtocolError: Page.bringToFront: Target closed` fires after
75% during teardown, yet the render still reaches 100% and succeeds. Benign shutdown race.

### 0.26 CREATIVE DEFECTS in the newly titled output (viewed frame by frame)

1. **The endcard prints the raw catalog SKU title, truncated:**
   `"Women's Breezer Point - Warm Red (Dark..."` — colorway parenthetical and all, clipped
   mid-word (cap applied at `remotion/compositions/Canonical.jsx:98` `.slice(0, cap)`).
   Note `CLAUDE.md` says the product name is *"dropped entirely by owner instruction"* for
   STATIC, yet the video endcard leads with it.
2. **The closing beat is the heel/back view AGAIN** — arc was side -> three-quarter -> top-down
   -> heel -> heel. Reference-stack ordering reproduced on a SECOND product and category
   (footwear vs apparel). Confirms §0.1.
3. Headline sits on a heavy grey translucent scrim; reads unpolished next to the static ads.

### 0.27 FONT FALLBACK IS NEARLY A CONSTANT (owner flagged; confirmed)

Owner: *"those fonts are the same ones that always get used"* / *"there should be much better
fallback choices."* Correct, and worse than it looks:
- `fontResolverService.js:269` — `substitution?.family || (fallbackFor(requested)==='serif' ? 'Lora' : 'Inter')`.
  A **binary** default.
- `LIBRARY_SUBSTITUTIONS` (`:253-262`) only fires when the **requested font NAME** matches a known
  foundry name (helvetica/futura/bodoni/...). Brands with proprietary typefaces — Allbirds
  **"Self Modern"** — match nothing and always land on Inter. That is the common case for premium DTC.
- `fontLoader.js:46-61` downloads **16** faces; only **8** are reachable via substitution.
  **Unreachable by ANY fallback path:** Cormorant, Antonio, Bebas Neue, IBM Plex Sans, Poppins,
  Nunito, Quicksand.
Fix: classify once per BRAND (site/logo/theme signals) -> pick best of the 16 -> cache on the
Brand doc. Same "classify once, reuse forever" pattern as view-angle.

### 0.28 OWNER ASK — gpt-image-2 for titling. Transparency is NOT available; do this instead.

Checked the LIVE schema (`openai-gpt-image-2-edit.json`): `output_format` is
`enum ['jpeg','png']` and there is **no `background: transparent` param** (OpenAI's native API
has one; Atlas does not expose it). PNG alone does not give alpha, so a per-frame composited
transparent title layer is NOT reliably achievable.

**Better architecture, no transparency needed:** don't overlay — have `gpt-image-2/edit` render a
COMPLETE designed frame (exactly what the static pipeline already does, and its typography is
visibly better than Remotion's), and have Remotion **cut to it**. Highest-value slice is an
**AI-designed ENDCARD** for the final ~1.5-2s:
- `size: '1152x2048'` is in the enum and is **exactly 9:16** -> clean downscale to 1080x1920
- $0.01 flat, one call per video
- fixes BOTH §0.26(1) the truncated raw-SKU endcard AND §0.26(2) the ad ending on a shoe heel
- text-accuracy risk (image models misspell) is exactly what the §0.2 vision QC catches

### 0.29 HOW MUCH PRODUCT INFO DO WE HAVE? (measured, answers the owner's question)

Coverage over 500 Media docs — the detect pipeline is thorough:
`classification` 100%, `adSuitability` 100%, `subjects` 95%, `primarySubjectDesc` 95%,
`primarySubjectLabel` 95%, `background` 95%, `technicalInsights` 94%, `text` 71%,
`refinedProducts` 45%.

So we are NOT missing perception generally — we are missing exactly ONE dimension: view/angle.
That makes the reference-ordering fix much smaller than it first looked.

**And the signal is already half-captured.** 42% of `primarySubjectDesc` values contain angle
vocabulary, e.g. *"Black short-sleeve crew neck t-shirt, **plain back**, ..."*. But it is NOT
reliably regex-extractable: another sample reads *"standing in **front** of a classic black
muscle car"*, where "front" is the car's position, not the camera angle.

**CHEAPEST FIX — add a `view` field to the EXISTING detect call's output schema.** That call
already looks at every image and writes the description; asking it for
`view: front|back|side|three_quarter|detail|lifestyle|packaging` costs **zero additional API
calls** and needs no new vision pass. Prefer this over a separate per-image classification pass
(my earlier suggestion — superseded, it was more expensive for the same result). Only existing
media would need a backfill.

### 0.295 ENDCARD PROBE — VALIDATED, $0.01 (2026-08-04)

Ran one live `gpt-image-2/edit` call on the Allbirds Breezer Point to test the §0.28 endcard
idea before building anything. **It works.**

- `size:"1152x2048"` accepted -> returned exactly 1152x2048 = **0.5625 = perfect 9:16**
  (note `buildParams`' comment at `atlasImageService.js:440` lists only 3 sizes — STALE, the
  live schema has 14)
- 115s, $0.01, one submit
- Output: elegant editorial serif headline, clean price line, pill CTA, generous negative space,
  bottom-right corner left EMPTY for logo compositing as instructed, all spelling correct
- **No invented logo on the product** — the explicit "Do NOT add, invent, or redraw ANY logo,
  emblem, badge or wordmark; it carries none" instruction HELD. Worth reusing verbatim in the
  static path, given the Timberland defect.
- Qualitatively far better than the current Remotion CSS card, and the raw-SKU-title problem
  disappears because copy is authored, not concatenated.

**Measured product-fidelity drift** (mean saturated-red pixel, source vs render):
`#a03849` -> `#b15760` — ~11% lighter, ~13% LESS saturated, shifted pink. NOTE: an earlier
eyeball read in-session called it "deeper burgundy" and that was WRONG in direction; the
measurement is the record. Part of the shift is legitimately the warm scene lighting that was
requested, so this is a judgement call rather than an unambiguous bug — but it is exactly what
the §0.2 vision QC "product fidelity vs original" check is for, and it is measurable this way.

**Two prompt fixes for the next iteration:** "125 dollars" rendered literally (written that way
to dodge glyph mangling — test "$125"); and the product sat mid-frame leaving dead space
instead of the requested lower-centre.

### 0.296 TITLING "REGRESSION" — DIAGNOSED. A stale stored brand spec shadows canonical.

Owner, on seeing the re-titled Allbirds render: *"We had really great titles going and now I am
seeing scrim again"*, *"this is not the canonical titling we were using last"*, *"this font is
incorrect"*. All three are correct. Mechanism, verified:

**There is NO LLM in the live titling path.** `services/titleSpecService.js` has zero
`chatCompletion` references. `resolveSpec` (`:121-162`) is purely deterministic:
 1. stored override docs — **ad > product > category > brand** (`:123-138`)
 2. pinned named preset `brand.titleStylePreset` (`:141-152`)
 3. canonical floor `remotion/presets/canonical.json` (`:155-161`)
Title Studio (`aiLayoutStudioService.js:219`) DOES call an LLM, but it **persists** a
`titleStyleSpec`; the renderer just replays that stored document.

**The render logged `spec=brand`.** Per `:130-135` that tier only returns when
`brand.titleStyleSpec[format]` exists AND validates. So Allbirds carries a persisted `vertical`
spec that wins over everything below it.

**Canonical is clean — proving the render was not canonical.** `remotion/presets/canonical.json`
`byFormat.vertical` has `scrim: "none"` for every slot. The render HAS a heavy scrim, so it
categorically did not use canonical. The `0e885c5` / `da1f2b4` "no-scrim cinema standard" is
being bypassed for any brand holding a stored spec.

**Where the good titles came from:** `remotion/presets/` holds CURATED per-brand presets —
`soludos-mediterranean-editorial`, `soludos-summer-postcard`, `pelagic-bluewater-editorial`,
`pelagic-offshore-bold`, `babyboo-editorial-monochrome`, `babyboo-main-character`. Allbirds has
NO preset, so it never reaches tier 2 or 3.

**THE STRUCTURAL BUG:** a persisted brand spec permanently shadows the canonical standard.
Improving canonical reaches only brands with no stored override. Any brand frozen with an old
spec keeps that look forever, silently. Needs a version/freshness stamp on stored specs so a
stale one falls through, or an explicit "prefer canonical unless curated" rule.

**Owner direction:** *"even the canonical titling is okay but use the right fonts and right
positioning."* So the target is: reach CANONICAL (not the stale stored spec), with correct brand
fonts (see §0.27 — Allbirds gets Inter because "Self Modern" matches no substitution) and better
positioning. NOTE canonical's only anchor is `upperThird`, which is exactly the top-heavy layout
measured in §0(c) — 26% of frame height unused. Positioning is a CANONICAL-level fix.

### 0.297 THE SWEEP EXERCISE (2026-08-04, owner-directed, plan-approved)

Owner authorized unlimited $0 re-renders; objective: re-title EVERY 9:16/4:5/1:1 master
(367 of 374; 238 reels / 28 stories / 64 4:5 / 37 1:1), score on six axes (positioning,
color, legibility, on-brand, conversion, animations), report recommendations.
Plan: ~/.claude-work/plans/shimmying-orbiting-panda.md. Fable is CREATIVE DIRECTOR for
templates (owner-directed); Grok drafts; scoring agents are persona-primed.

**THE BIG ONE — canonical was the OLD template.** Owner: "we had a new titling template you
are using the old one." Verified: the three curated presets share a 9-slot/3-phase
architecture (hook -> proof with rating stars+count -> close with productName/deliveryLine/
CTA at lowerThird) that canonical.json never received. Now REBUILT (PR #60, merged a29be17):
canonical + three funnel variants (awareness/consideration/conversion, mirroring the static
intents — owner wants funnel-position ads like static) + two experimental prototypes
(proto-kinetic-center, proto-bottom-editorial) for the scoring pilot.
- CTA visible:true everywhere (owner decision; was false even in the presets).
- There is NO separate endcard in the Remotion path (canvas-era only) — the close phase IS
  the endcard. The card seen at 7.8s in the 08-04 re-title came from the stale brand spec.
- Fable direction pass: canonical/conversion/protos cut text phases ON the camera cuts
  (2.7/5.1 = buildVeoPrompt scene marks dur/3, 0.64*dur); CTA rides the reveal (+60% screen
  time). Awareness/consideration keep divergent pacing AS their A/B hypothesis.
  **Owner caveat (correct): camera beats drift per video** — requested marks are a prior.
  Sweep adds mechanical scene-cut detection (local ffmpeg, $0) as a per-video metric;
  if drift is material, fast-follow = per-render beat-snap via plate intelligence
  (timing.js already time-warps specs; precedent exists).
- resolveSpec tier 0: presetOverride argument (never persisted) for funnel A/B;
  driver --preset flag. titlingSnapshot records 'override:<name>'.
- productName cleaned for display (parenthetical stripped; productNameFull preserved);
  word-safe truncation. NOTE: my earlier claim that Canonical.jsx:98 .slice(0,cap) was the
  truncation site was WRONG (that is a maxItems cap); the clip was CSS line-clamp on the raw
  SKU. Fixed at the meta source.
- scripts/retitleDriver.js: serial $0 sweep driver, money-invariant verified line-by-line
  (renderBrandScriptAndSave only; side cost ~$0.02/cropped-format ad for face-detect vision
  on cache miss, ledgered; worst case ~$2 across the 101 cropped ads).

**Sweep state:** deploy of a29be17 in progress. NEXT: owner-gate render (ONE Allbirds
vertical on new canonical — owner must approve frames before sweep), then format smokes,
then pilot: 12 ads x 6 templates = 72 renders ($0), persona-primed scoring
(Brand.demographics/tone/tagline — pulled to scratchpad sweep/brand-personas.txt; GymShark/
Peloton/Soludos2/Fellow have EMPTY profiles -> category-generic fallback + recommend brand
enrichment), then full 367 sweep + report. Pilot manifest: scratchpad sweep/pilot-manifest.txt.
NOTE: no brand has titleStylePreset set, so the whole sweep renders pure canonical-family —
clean single-variable test.

**Adversarial reviews on the diff found and fixed pre-commit:** failed re-ingest clobbering a
good font mirror; no magic-byte check on downloads (HTML-as-200 became a "usable" face); human
needsLicense holds wiped by re-ingest; commercial faces starving the ingest cap. Documented
footgun (not yet fixed): Title Studio still authors/previews persisted specs that renders now
ignore — preview != ship; needs a UI warning.

### 0.298 CANONICAL TITLING TEST — iteration log (2026-08-04 overnight; TEAM TESTS TOMORROW)

**Owner deadline: canonical titles working by morning; the whole team tests static + video
production.** Iterations, each frame-verified, all $0 re-titles of the same 12 pilot ads:

- **v1 (PR #60):** 9-slot canonical worked (fonts, CTA, cleaned names, close on the reveal) but
  proof phase ran empty when quote+rating were withheld, and white ink shipped on light plates.
- **Ink root cause (PR #61):** the plate scan only ran for placement='content' — canonical
  renders had plateHints=null so the contrast flip could NEVER fire. Scan now always on (render
  + preview), kill switch intact. ALSO in #61: atomic brand-rating fallback
  (`resolveAtomicRatingPair`, Brand.brandReviews same-snapshot pair, honest attribution, >4.5
  gate, mixing bug pinned); camera-prompt subject-lock + Scene-3 return-to-primary + crossfade
  policy; REPEAT_PRIMARY_REFERENCE (default true, cap 4 refs).
- **v2 sheets (canon2):** ink flip fired (AllBirds dark Playfair on light wall ✓), stars+counts
  live (Pelagic 5.0/5, Vuori 4.6/5 + 15,545 ✓), CTAs everywhere ✓. NEW defects: rating rows on
  FACES (keep-out computed but never applied); ink flip inconsistent (Vuori white-on-light);
  Vuori brandPill rendered a broken gradient box; "- Warm Red" / "| ..." suffixes; deliveryLine
  faint.
- **Iteration 2 (PR #62):** keep-out APPLIED (group shifts to first clear band, stable, logged
  `keepOut:`); ink vote inputs fixed (band rects tightened to the real text strips — old top
  band spanned 26% incl. faces; median luma; 5 sample times; logged `inkVote:`); deeper name
  cleaning (parenthetical -> pipe -> dash-colorway w/ short-name guard); deliveryLine w600
  primary ink. brandPill hidden by default everywhere (owner: Meta draws its own page identity;
  doubly validated — Vuori's pill rendered broken).

**Owner directions recorded:** multi-color type allowed when brand-tokened (per-group ink =
NEXT iteration, deliberately not tonight); owner waits for the canon3 contact sheet; funnel
variant A/B + 6-template pilot PARKED until canonical is approved (variants + protos exist and
validate; sweep infra ready).

**$1 REGENERATE (end-to-end pipeline test) — all green + one discovery:**
- Ledger PROVEN live: `atlas_video_render | $1 | submitted` — the widened-enum fix recording
  real video spend. Crop-vision rows ledgered (~$0.004).
- Money guard observed live: renderUrl briefly = raw master (draft stamp) then titled.
- Owner's prompt idea WORKED: "end on the FIRST reference image's view" -> front-on close, CTA
  riding it. The structural repeat-primary version is deployed but has NEVER run a live
  generation (regen predated #61) — MUST validate with one $1 regen before the team generates,
  else flip REPEAT_PRIMARY_REFERENCE=false.
- **NEW DEFECT CLASS: Omni mangles on-product wordmarks on zoom shots** — tongue label rendered
  "wfoirds" in the 3.5s detail shot. Video-side proof of the vision-QC case (§0.2).

**Ops learnings tonight (cost real time):** `nohup &` dies with the render-ssh PTY — use
`setsid nohup ... < /dev/null &`. The BACKEND web service is MULTI-INSTANCE — a file written in
one render-ssh session may not exist in the next; write+launch in ONE session, monitor via DB.
The worker is single-instance and safe for long drivers. /tmp scripts can't require app
modules (documented trap; bit again — run from /opt/render/project/src).

### 0.299 TEAM-DAY READINESS — VALIDATED 2026-08-04 ~02:30 (read this first tomorrow)

**Prod = `bb024b8` on both services. Suite 34/34. Canonical titling: WORKING, frame-verified
in all four sizes** (final contact sheets delivered to owner ~02:05; canon3 = iteration-2
build: keep-out off faces, consistent ink, cleaned names, legible deliveryLine, CTA everywhere,
no brand pill).

**Production validations run tonight (total ~$2.05):**
- STATIC regenerate: 74s, healthy, logo composited, >4.5 star gate live (weak rating correctly
  suppressed), NO invented emblem this sample. $0.01 ledgered `ok`.
- VIDEO regenerate, DEFAULT PATH (empty prompt — exactly what the team clicks): **full pipeline
  97s** (Omni was fast: submit 09:06:47Z -> master +52s -> titled +41s), $1 ledgered
  `submitted`, **REPEAT-PRIMARY CONFIRMED LIVE** (1 distinct ref -> [primary, primary]), and
  the close RETURNS TO THE FRONT-FACING PRIMARY VIEW with CTA + allbirds.com attribution.
  NOTE a correction: an earlier in-session read that empty-prompt regens dedupe to $0 was
  WRONG — the explicit regenerate route always regens fully (adRegenerateService: "video
  always regens fully", effMode='full'). Every explicit video regenerate costs ~$1. The
  accidental-double-click protection lives on the GENERATE path digest, not regenerate.
- Earlier prompt-lever regen ($1): ending fixed via operator prompt; found Omni mangles
  on-product wordmarks on zoom shots ("wfoirds") — vision-QC case, video-side proof.

**KNOWN LIMITATION for tomorrow:** proof phase renders empty when a brand has neither a
gate-passing quote nor a >4.5 rating pair (product or brandReviews). AllBirds sheet row shows
it. Not a crash — just a quiet middle beat. Brand enrichment for GymShark/Peloton/Soludos2/
Fellow would populate personas + brandReviews.

**Grok CLI: re-authed by owner 2026-08-04 morning, probe verified (0.2.117).** (It had signed
out overnight mid-session — auth sessions can expire; on `Not signed in`, fall back to
subagents and tell the owner, don't retry.)

**Efficiency audit** (owner-requested): two subagent audits over render + generation paths
were in flight at handoff-write; findings land in this file / the conversation when done.
Seeds already measured: webpack bundle rebuilt per driver invocation (4-10s), Chrome 91.9MB
per fresh instance, plate scan now per-render (cacheable on Ad like basePlate crops),
storyboard-LLM-on-regen possibly wasted on canonical path, fixed 15s Omni poll, video costs
never reconciled to actuals (veoPredictionId is persisted; image reconcile pattern exists).

**PARKED, awaiting owner:** funnel-variant A/B (presets exist + validate), 6-template pilot,
full 367 sweep + persona scoring, AI endcard arm ($0.01/video), per-group brand-tokened ink
(owner allowed multi-color), Title Studio preview!=ship warning.

### 0.2995 EFFICIENCY AUDIT (owner-requested, 2026-08-04 night) — verified findings, NOT yet implemented

Two subagent audits (Grok signed out), every load-bearing citation spot-checked by hand.
Post-team-day work; nothing deployed. THREE of the audit's seed premises (mine) were WRONG and
are corrected here so nobody re-chases them:

- **Webpack bundle is ALREADY cached** — module-scope memo (`remotionRenderService.js:45-62`)
  + @remotion/bundler filesystem cache (enableCaching default). The 4-10s observed was
  warm-cache. The sweep driver is one process -> bundle paid ONCE per sweep. No fix needed;
  just never chunk the sweep into many separate invocations.
- **Plate scan is LOCAL ffmpeg**, not Cloudinary network (`plateIntelService.js:63-79,174-221`
  runs against the already-downloaded platePath). The Cloudinary so_<sec> stills belong to the
  face-crop detector, which is ALREADY cached per (veoVideoUrl, format) via `Ad.basePlate`
  (`basePlateCropService.js:298-311`).
- **Storyboard LLM on regen is DEAD CODE on the Atlas path** — `prepareStoryboard` returns
  `storyboard:null` (`atlasVideoService.js:2527-2533`); `buildVeoPrompt` marks the param
  unconsumed. $0 today. (`VEO_USE_GPT_STORYBOARD=true` in defaults.env is a no-op — hygiene.)

**Real wins, ranked (effort S unless noted):**
1. **Video cost reconcile to actuals** (accuracy, M): `reconcileCost` has one call site
   (images). Video charge point already persists `veoPredictionId`; NOTE the terminal poll
   already hits `GET /model/prediction/{id}` — the settled `price` may ride the completion
   response for ZERO extra requests (verify live; images' comment warns price can lag).
2. **`Ad.plateHints` cache** keyed by (plateUrl, FORMAT — not just veoVideoUrl; cropped plates
   differ per format), mirroring `Ad.basePlate`: skips 5x ffmpeg+sharp per repeat re-title.
   ~0.5-2s/render on preset-sweep reruns.
3. **Regenerate flow Mongo diet:** `prepareStoryboard` call in `adRegenerateService.js:195` is
   pure overhead (outputs discarded, cache-warm no-op on re-renders) — 6-10 round-trips;
   `loadBrand` (`:174-181`) re-derives brand via Ad->Media->Brand when `ad.brandId` is on the
   doc; 4x Brand loads and 4x Ad loads per regenerate, 2 of each avoidable.
4. **Upload double-buffer** (`brandScriptExecutor.js:1012` readFile -> `cloudinaryService.js:46`
   streamifier): stream disk->network directly. Tens-to-100s of ms.
5. **Chrome pre-warm may be silently failing:** postinstall runs `npx remotion browser ensure
   || true` (`package.json:11`) yet a fresh instance downloaded 91.9MB at first render. The
   `|| true` swallows failures and vendored remotion pkg has `bin:null` — CHECK RENDER BUILD
   LOGS for that step's real output. Same class as the f89e30b Puppeteer saga.
6. Cosmetic/doc: stale `resolveBrowserExecutable` comment (`remotionRenderService.js:91-94`
   points at the pre-f89e30b puppeteer cache path); `docs/TITLING.md:215-232` still documents
   content-mode-only 3-sample scan — violates the fix-docs-in-same-commit rule; fix with the
   plateHints work.
7. Omni polling: fixed 15s+jitter is fine for wall-clock (completion detection lag <=18s);
   the lever is fewer polls for rate-limit headroom, and no sync/webhook field exists in any
   of the 5 param shapes — upstream capability UNVERIFIED.

### 0.2999 UI END-TO-END TEST + ITERATIONS 3/4 (2026-08-04, owner driving)

**UI test (owner's Chrome, staging): TEAM PATH PASSES end to end.** Wizard -> dispatch ->
2 Omni masters ($1 each, ledgered `submitted`) -> square face-crop titling -> playable in Meta
preview -> run `done` -> **Slack per-run feed POSTED (first live observation —
CampaignRun.slackFeed {ts, channel})**. Video dedupe protected the third product (Warm Red
already owns video ads — not re-billed). 8s is the wizard default. UI findings logged as
tasks: Render Activity board never fetches its data (#13); format chips only register on the
active card + video cards mislabeled AI_BRAND_LED (#14); preview-chrome "Lorem ipsum"
confirmed live (known-open).

**Iteration 3 (PR #63, deployed):** sizeScale bumps (~x1.2 family-wide, fit arithmetic
verified); `visibleWhenEmpty:"<slotKey>"` spec property (cycle-proof) + proof-phase fallback
headline when the quote is gated empty; animated rating lockup — stars pop L->R on staggered
springs with TRUE partial-star fill (clipPath; stars were full-only before), count rolls 0->N
ease-out with tabular-nums; settle 1.48s; all useCurrentFrame-deterministic. Suite 35/35
(verifyRatingMotion 26).

**canon4 (14 ads = pilot 12 + the 2 UI-run ads) frame review — CORRECTIONS:**
- An initial "proof beat regressed, quote+stars gone" read was WRONG twice: (a) the quote gate
  withholds on EVERY pilot ad (unstamped provenance) — the fallback claim rendering is the
  DESIGNED behaviour, canon3 never had quotes either; (b) the sheet's 3.2s proof frame caught
  the stars MID-ANIMATION at near-zero scale — at 4.6s the Pelagic lockup is exactly as
  directed (brand-navy claim + large gold ★★★★★ 5.0/5). Sheet proof frame moved to 4.6s.
- Pelagic's blue type = its own brand on-light token (inkVote flipped on-light) — the
  "multi-color if on-brand" direction emerging naturally.
- **REAL defect 1: keep-out NEVER fires** — zero `keepOut:` log lines; the basic plate scan
  never sets band `avoid` flags (luma-only). Text still lands on faces.
- **REAL defect 2: ink tie rule** — `light=3 dark=3 -> brand-default` put white type on a
  near-white wall (AllBirds proof beat).

**Iteration 4 (in flight):** wire the EXISTING cached face detection (detectClipBoxes,
~$0.02/master once, ledgered) into plateHints `avoid` bands behind TITLE_FACE_KEEPOUT
(default true), incl. explicit pixel->fraction coordinate conversion; ink tie breaks toward
global median plate luma (>0.55 -> on-light), logged. Then canon5 re-render + artifact
refresh (same URL).

### 0.29995 CANON5 — iteration 4 VERIFIED IN FRAME; artifact refreshed (same URL)

14/14 re-titled on `b97991d`. Live log evidence: `keepOut: top->center (face band)` x2 fired;
`inkVote: light=3 dark=3 tie -> globalLum 0.81 -> on-light` — both iteration-4 mechanisms
working. Frame review: Pelagic proof lockup fully OFF the face (brand-navy claim + large gold
5.0/5); Vuori shows the complete lockup incl. "15445 reviews · vuoriclothing.com"; AllBirds
proof headline rides the red toe in white Playfair — correct per-plate ink (verified at full
res; three separate low-res sheet misreads this session — ALWAYS zoom the native frame before
judging ink/animation; sheet proof frame is 4.6s post-settle for this reason).
Approval-grid artifact refreshed in place:
https://claude.ai/code/artifact/535b2728-b623-4898-9841-518e89b03798 (iteration 4 status).
AWAITING OWNER: approve -> full 367 sweep + persona scoring; or flag -> next $0 iteration.

### 0.29996 TEAM-DAY LIVE REPORTS — THREE REPORTS, ONE ROOT-CAUSE FAMILY (2026-08-04)

*Rewritten after measurement. An earlier version of this block claimed brand stars were read
from the wrong document and treated the schemaVersion hole as the whole story. Both were wrong;
corrected below. Full plan: `~/.claude-work/plans/graceful-forging-gem.md`.*

Owner, mid-testing: (1) *"not seeing the canonical title being used on videos"*; (2) *"we are not
seeing customer comments … there should be at least brand slugs … we opened up the llm gating
removing attribution, but I am not seeing that"*; (3) *"what happened to the star reviews and
review counts? We were going to brand level stars and counts but now I am not seeing any."*

**These are ONE root cause.** The titling IS canonical — prod web+worker both on `b97991d`
(`render-ssh` `RENDER_GIT_COMMIT`), no `TITLE_SPEC_*` env override, and every `🎨 brandScript`
line since 10:26 logs `spec=canonical` (the lone `spec=brand` was 04:26, pre-fix; the SAME ad
re-titled at 17:15 logs `spec=canonical`). What is missing is the **proof phase** — canonical's
quote + reviewer + rating lockup, the distinctive part of the template. With the quote withheld
AND the rating withheld, `headline` takes over via `visibleWhenEmpty:"quote"` and the beat
degrades to a repeated headline. So report 1 is a *symptom* of reports 2 and 3.

| # | finding | evidence |
|---|---|---|
| A | `buildMetaForAd` loads the artifact by **`mediaId` only** — no `productId`, no `schemaVersion` | `brandScriptExecutor.js:713` |
| B | **722 of 738** layout artifacts are pre-`4.1` → unstamped quotes the gate must withhold | prod count |
| C | Video path rebuilds **only when the artifact is empty**, so stale-but-populated is never refreshed | `atlasVideoService.js` `lpEmpty` ~:2497/:2590 |
| D | Brand-tier quotes **withheld from product ads** by design | `layoutInputService.js:2023-2028`; live `🔒 quote scope` |
| E | Brand stars cannot clear `>4.5`: **only 4 of 34 brands qualify** | prod query |

Live proof of B/C: `quote withheld (tier=unstamped origin=unstamped)` fired at 17:10 and 17:15
today. **STATIC is unaffected** — `renderService.js:332` calls `buildLayoutInput`
unconditionally and its cache treats a `schemaVersion` mismatch as a MISS → rebuild → stamped
`llm-web` quotes flow (live: `winner=product "The shoes are very comfortable"`). The hole is
video-only.

**On E, the numbers that matter.** Brands with a brand rating = 16/34; clearing the owner's
`>4.5` rule = **4** (Pohnpei 4.7, Camelbackflowers 4.9, Ubeauty 4.8, Vuori 4.58→4.6). The two
brands under test today both fail: **GymShark 3.3** (with 41,000 reviews and 6 brand quotes) and
**AllBirds has no `brandReviews` at all**. Nothing regressed — `resolveAtomicRatingPair` (PR #61)
is correct and live; the DATA cannot clear the gate the owner asked for.

**TWO HYPOTHESES TESTED AND KILLED — do not re-chase:**
- *Brand stars read from the wrong doc:* **FALSE.** `ProductMatchArtifact.brandReviews` is `null`
  for every ad checked; `Brand.brandReviews` is the correct source. AllBirds simply has no data.
- *The `llm-web` attribution opening regressed:* **FALSE.** `quoteProvenance.js` is correct and
  live; `llm-web` prints as anonymous text with bylines structurally deleted. What blocks these
  ads is B/C (stale artifacts) and D (brand tier withheld), not the provenance rule.

**Owner decisions this session:** stars → when the brand rating fails `>4.5`, print the **review
count paired with a positive brand-level quote**, no stars (*"let's try using the number of
reviews with a positive review that we have plucked out at the brand level"*); brand-tier quotes
→ allowed as **last-resort fallback** on product ads, anonymous; enrichment → backfill
`brandReviews` for all brands missing it; **NO sweep** (*"just make a fix and redeploy so we can
keep testing"*).

**INTEGRATION GAP found while building (important).** `buildMetaForAd` only READS artifacts —
`buildLayoutInput` is what rebuilds. So a `schemaVersion` filter makes a stale artifact resolve to
"none" → degrade to `ad.copy` → still no quote on a $0 re-title; only NEW generations rebuild.
Worse for the brand-tier fallback: `primary_quote` is baked in at **assembly** time, so existing
v4.1 artifacts assembled before the change hold no brand quote (GymShark `6a70cf95` is v4.1 with
`q=NONE`). Re-titling alone therefore cannot validate the brand-quote path — the artifact must be
rebuilt first. Deliberately NOT fixed by adding an LLM call to the render path (`retitleDriver`
must stay ~$0).

**Grok CLI headless: NO for edits, YES for review — with the diff INLINED.**
`grok -p …` prints narration and exits WITHOUT executing tool calls: no file edits, exit 0,
silently. `--max-turns 60` and `--permission-mode acceptEdits` do not change it;
`bypassPermissions` is blocked by Claude Code's classifier. So use **subagents** for anything
that edits files.
**But review works and EARNED ITS KEEP.** An earlier version of this note claimed review was
useless too — that was wrong, written before the long pass returned. With the full diff pasted
into the prompt (no file access needed), one high-effort pass found **two real HIGH defects that
37 green harnesses and my own line-by-line read both missed** (§0.29998). The other pass, given a
"look for interaction bugs" steer, returned narration only. Lesson: inline the diff, ask for
refutation, allow it several minutes, and do not judge the run from a truncated interim file.

### 0.29997 IMPLEMENTATION — code COMPLETE + verified, DEPLOY HELD BY OWNER (2026-08-04)

Landed in the working tree, NOT committed (owner held it — see the shared-tree note below).
`config/defaults.env` gains `QUOTE_BRAND_TIER_FALLBACK=true`.

| change | file |
|---|---|
| Artifact lookup scoped by `productId`; fresh schema PREFERRED, stale DEMOTED not dropped | `services/brandScriptExecutor.js` |
| `allowBrandCountWithoutStars` — third outcome: count prints, stars withheld, `source:'brand-count'` | `services/ratingDisplay.js` |
| Brand tier demoted to last-resort on product ads (flagged, default on); brand-ad order UNCHANGED | `services/layoutInputService.js` |
| Stale artifacts rebuilt on the video path (one `refreshStaleLayoutInput` helper, both call sites) | `services/atlasVideoService.js` |
| Rating slot non-empty on count alone; `rating:null` distinguishes "no stars" from "zero stars" | `remotion/lib/slotContent.js` |
| Star row + score skipped entirely when `rating == null`; count animation starts at slot enter | `remotion/components/slotRenderers.jsx` |
| New revert-proven harness (22 checks) | `scripts/verifyProofBeat.js` |
| New dry-run-default enrichment driver, NOT yet run | `scripts/backfillBrandReviews.js` |

**Verify: 37/37 scripts green.** `verifyProofBeat` revert-proven 5 ways (break the count-only
branch → 4 fail; delete `tier` in the byline strip → 3 fail; restore the old rating-only bail →
S1 fails; remove the star-row guard → S3 fails; unconditional `countStartSec` → S4 fails).
**One pin was initially too weak and passed while the guard was deleted** — a bare
`/rating != null ?/` matched the `countStartSec` line ~80 lines away. Now requires the guard
within 400 chars of `<StarRow>`. That is the whole argument for revert-proving.

**A REGRESSION THE FAN-OUT ALMOST SHIPPED — corrected by hand.** The subagent filtered the
artifact query on `schemaVersion`, which drops a stale artifact ENTIRELY. But **ten** meta fields
take `layoutInput` as their FIRST cascade source — including `rating` and `reviewCount` themselves,
plus `deliveryLine`, `badgeText`, `badges`, `benefits`, `productDescription`, `likes`. With 722/738
artifacts stale that would have thinned the close phase and DELETED the very stars this work
restores. Freshness is now a preference with a fallback; the unstamped quote is still withheld by
`gateLayoutInputQuotes`, which is all the filter ever bought.

**Adversarially verified BY EXECUTION** (Grok review unusable, see above) across the real
production shapes. Every row traced pair → Remotion slot:
| input | renders |
|---|---|
| stale AllBirds: product 4.4, no brand data | slot EMPTY → headline fallback |
| GymShark: brand 3.3 / 41,000, brand-tier quote | **no stars, "41000 reviews · gymshark.com"** |
| brand count, no brand rating | no stars, count prints |
| brand 4.7, no count | 4.7 stars, no count line |
| 0–100 scale (87) | no stars, count only — 87 never becomes a star value |
| `reviewCount: 0` | slot EMPTY — never "0 reviews" |
| product count 41,000 + brand rating fails, no brand count | slot EMPTY — **cross-tier leak blocked** |
No forbidden star value reaches the screen on any path, and nothing crashes (`rating.toFixed(1)`
was a latent throw on null before the guard).

**Two latent items, deliberately NOT fixed (no live consumer):**
1. Brand quotes now also enter `secondary_quotes` on product ads. That pool bypasses the
   last-resort ordering. Read ONLY by `aiCanvas*` / HTML services, which §1 documents as dead for
   new generation; the Remotion path binds `primary_quote` only. If a canvas path is ever revived
   it needs its own scoping decision.
2. A rating stored as a STRING ("4.7") that would legitimately clear the gate now renders
   count-only, because `formatDisplayRating` requires `typeof === 'number'`. Pre-existing and
   harmless (never prints a WRONG value), but it silently forfeits real stars.

**COST — re-titling is no longer unconditionally $0.** `buildLayoutInput` runs an LLM derivation
on a cache miss, so rebuilding a stale artifact costs one derivation per ad. Scoped to the stale
population (722/738); schema-current rows still cache-hit at $0. A full sweep would therefore be
billable — a second reason the owner's "no sweep" call is right.

**SHARED WORKING TREE — why nothing is committed.** A concurrent session is editing this same
tree: `routes/ads.js` (new `POST /api/ads/video-ref-prewarm`), new
`services/videoRefPrewarmService.js`, and `services/costTracker.js` (re-prices
`gemini-2.5-flash` 3x input / 6x output as Flash-LITE numbers, and adds a $0.035/call
grounded-search surcharge). `services/atlasVideoService.js` is MIXED — the proof-beat helper and
their prewarm/reframe hunks share the file. Owner chose HOLD: land that session first, then commit
and deploy this on top. **Do not commit the tree as-is** without deciding on those three files.

**Money-invariant gap found in passing:** the Gemini brand-reviews tier
(`geminiSearchProvider.lookupBrandReviews`) calls `axios.post` against the raw Gemini endpoint with
**no costTracker/CostLog involvement at all** — unlike the GPT tier, which is ledgered. So brand
enrichment spend is invisible in month-to-date totals. The concurrent session's `costTracker.js`
grounded-search surcharge may be addressing exactly this; reconcile rather than double-ledger.

### 0.29998 ADVERSARIAL REVIEW FOUND TWO REAL HIGH BUGS — both fixed, both revert-proven

The two-pass rule paid for itself again. Neither defect was caught by 37 green harnesses, by the
9-shape execution trace, or by my own line-by-line read. Suite now **39/39**, `verifyProofBeat`
at **26 checks**.

**HIGH 1 — the count-up animation printed FABRICATED totals.** `parseReviewsLeadingNumber`
(`remotion/lib/ratingMotion.js:93`) used `/^(\d{1,3}(?:,\d{3})*|\d+)/`. Alternation is ORDERED, so
on an uncommaed run of digits branch one won: **"41000" matched only "410"** (`\d{1,3}` greedy,
then zero comma groups) → `target:410`, `suffix:"00 reviews · gymshark.com"`. The count rolled
0→410 with a stray "00" beside it, so mid-animation frames read **"18800 reviews"**, "30800", … —
numbers no source ever produced — for ~0.9s of paid video. Only the SETTLED frame looked right,
which is exactly why every post-settle contact sheet passed it. `reviewsText` is built uncommaed
by `ratingDisplay.js`, so any count ≥1000 was affected ("8343" → 834 + "3 reviews").
Reproduced before fixing. Fix: `/^(\d+(?:,\d{3})*)/` — `\d+` first, comma groups optional.
Verified: 41000/8343/15,545/128/1/1,234,567 all parse whole; mid-roll now "18,860 reviews",
settled "41,000 reviews · gymshark.com". **This was PRE-EXISTING** (Vuori's 15445 shipped through
it) but the count-only path makes an uncommaed count the primary proof, so it became load-bearing.

**HIGH 2 — the brand count could ride a quote that was not the brand's.** The gate read
`primary_quote.tier === 'brand'`, but the quote that RENDERS is `cascaded.quote`, and that cascade
puts **`ad.copy.quote` FIRST**, layoutInput's primary_quote second (`metaCascadeConfig.js:49-52`).
So an ad carrying an operator-edited or stale `ad.copy.quote` rendered THAT line while tier still
said 'brand' — hanging a catalog-wide review count off a product-specific claim that never passed
the provenance gate. Fix: require the brand quote to be the one that actually prints
(`renderedQuote === brandQuoteText`).

**Three further findings ASSESSED, deliberately not code-changed:**
- *Product stars + a brand-tier last-resort quote on one ad.* Rating/count atomicity still holds
  (both product-tier). What remains is the cross-product quote risk the owner **explicitly
  accepted** when approving the fallback. Documented, not "fixed" — fixing it would gut the
  feature that was asked for.
- *Brand stars beside a product-tier quote.* Real but **pre-existing**: the brand-rating branch is
  untouched by this work. Out of scope; worth its own pass.
- *`slotContent` does not re-apply the >4.5 rule.* Defence-in-depth gap, pre-existing — the
  renderer trusts `meta.rating`, and `buildMetaForAd` is the only writer. Adding a second
  enforcement point risks the two diverging; left as the single-source design.

**METHOD NOTE worth keeping:** two of my own source-pin checks initially passed while the code
under them was broken — the star-row guard pin matched an identical expression 80 lines away, and
the regex pin matched the old pattern quoted in its own explanatory comment. Source pins must
strip comments and assert PROXIMITY. Both were caught only by revert-proofing.

### 0.3001 OWNER TEAM-TEST ROUND 2 — three complaints, all real, all fixed (2026-08-03 22:0x)

Owner, on delivered ads: *"these titles are not the canonical titling we have discussed, I am
seeing the shipping car show back up, there is a dark pill, I am not seeing star ratings or
reviews, I am unclear why we reverted to this again?"* Prod now `8febbf2`, suite **42/42**,
`verifyProofBeat` **31**.

**"why we reverted" — WE DID NOT. The template is intact.** `git log b97991d..HEAD` over
`canonical.json` + `slotRenderers.jsx` + `Canonical.jsx` + `slotContent.js` returns exactly ONE
commit, `0319c68`, which is the merge that landed this session's own work. Every recent render
logs `spec=canonical placement=canonical`, and the four newest ads' `titlingSnapshot.spec.source`
is `canonical`. What the owner saw was three separate defects on top of an unchanged template.

**(1) NO STARS / NO REVIEW COUNT — a PROJECTION, not the rating logic. THE BIG ONE.**
`routes/ads.js:1315` (generation — what the wizard runs) and
`adRegenerateService.loadBrand:393` both `.select()` an explicit brand field list, and **neither
listed `brandReviews`**. So `buildMetaForAd` saw `brand.brandReviews === undefined` → `brandPair`
null → `resolveAtomicRatingPair` returned `source=none`, and **every generated ad shipped with no
stars and no count** — including **Vuori at 4.58 / 15,545**, which clears the >4.5 gate outright.
Why it hid: a projection omission is indistinguishable from a brand with no review data;
`resolveAtomicRatingPair` was correct all along so unit coverage passed; and — the part that
matters — **the canon5 sheets the owner approved were rendered by `scripts/retitleDriver.js`,
which loads the FULL brand doc.** Stars appeared there and were NEVER achievable through the
generation path. That is the whole "we had it and lost it" feeling, and it was never a regression.
Proven live after deploy: `PROJECTED brandReviews={r:4.58,c:15545}` → `ratingPair: source=brand
rating=4.6 count=15545` → frame shows gold ★★★★½ 4.6/5 + "15,545 reviews · vuoriclothing.com".
Pinned by `verifyProofBeat` P1 (revert-proven).

**(2) "SHIPPING CAR" — a truck icon stapled to copy that never mentioned delivery.**
The `deliveryLine` slot is labelled "Delivery / offer line" but its cascade binds
`layoutInput.input.product.badges[1]` — the SECOND BADGE. Text is routinely "Premium Cotton",
"Best Seller", "New Arrival", and the old condition (`endcardMode !== 'brand'`, i.e. every product
ad) drew a truck next to all of them. Icon is now content-gated (`DELIVERY_CLAIM`), so it appears
only for an actual delivery/shipping line and returns automatically if one is ever bound.
**The cascade mismatch is left alone deliberately** — the line reads fine as badge text; rebinding
it changes what copy appears and is an owner call.

**(3) "DARK PILL" — brand-token pill read as scrim.** `BadgeSlot` filled a `Pill` from
`badgeBg`/`badgeText`, so the same slot shipped CHARCOAL on Vuori and cream on GymShark, and on a
light plate the dark box was exactly the scrim the no-scrim standard exists to remove. Owner chose
*"Plain text, no pill"*. Badge now renders small-caps in `textPrimary`, so the contrast flip drives
it and it is consistent across brands. `Pill` stays for CTA/promo, which should read as buttons.

**(4) LOGO — owner: *"keep the static but I noticed the allbirds logo is put on a block of white,
the logo should just be rendered in black or white depending on the color of the background."***
Static compositing stays ON (the model is still forbidden from drawing a logo). The asset was
composited verbatim, so a logo on an OPAQUE white canvas painted a white rectangle. Now re-inked
as a single-colour silhouette chosen from the mean luminance behind it (`monochromeInkFor`,
>0.5 → black else white); coverage from alpha when present, else luminance in whichever polarity
the asset's own border implies, so white-on-black assets don't invert into a block. Failure falls
back to the original asset. **NOT yet visually verified — needs one static render (~$0.01).**
Video titling was never the source: `brandPill` and `brandLogo` are both off in canonical.

### 0.3006 TYPE EXPERIMENT — ARM A SHIPPED, THREE ARMS RUNNING (2026-08-04). Supersedes 0.3005's plan.

**ARM A IS A REAL PRODUCTION CHANGE and is deployed.** Everything else in this section is
experiment scaffolding. The owner drew that line explicitly: *"The QC gate is experimental just
for this test, not to be applied to production."* Two production files changed, both on owner
directive; six new `scripts/type*.js` files are additive with **zero imports from
`services/`, `routes/`, `models/` or `remotion/`** (verified, not assumed) and are to be moved to
`scripts/experiments/` or deleted once the run is judged.

**INK — `titleSpecService.buildBrandTokens`.** `textOnLight` fell back to the brand PRIMARY and
`textSecondary` to the brand SECONDARY, so scraped palette values were rendering as letterforms
(Pelagic `#4d92b6` blue, BabyBoo `#ba3357` red). Both now default to neutrals; a curated value
still wins. **Measured justification, which is stronger than the owner's aesthetic call alone:**
unlike `ctaText`/`badgeText`/`promoText`, `textOnLight` never went through the contrast helper, so a
brand with a PALE scraped primary shipped type at **1.03–1.21:1** on a light plate (AllBirds
`#ECE9E2` = 1.21:1). The neutral is **17.76:1**. Every real production primary except pure black is
LESS legible than what replaced it.

**FONT ORDER — `resolveBrandFonts`.** Was: collapse the cascade to ONE family, resolve it, else fall
to a hardcoded default — so a tier could win and render nothing it named. Now an ordered ladder of
`[family, requireExact]` pairs; the scraped face outranks the generic `styleTheme` alias **only when
servable exactly**. Pelagic → Oswald (the owner's report). AllBirds with the file held → still
DM Sans.
**TWO HIGH REGRESSIONS IN MY FIRST DRAFT, both caught by independent adversarial review:**
- Camelback `{fontFamily:'Lora', theme.sans:'DM Sans', theme.serif:'Lora'}` — Lora IS servable, so
  an unconditional promotion made heading+body+quote ALL Lora and collapsed a deliberate sans/serif
  pairing. Rule that separates it from Pelagic without a special case: **promote only when the theme
  does not already name the scraped face in some role.**
- I had moved the curated-`fontFamily` tier ABOVE the theme, which it never was. Moved back.
`ownFace` is exact-only too: a claimed file that will not load must yield to the curated theme.
Reviewers DISAGREED on Camelback (one called it working-as-designed); I judged the collapse a
degradation. One boolean reverses that if the owner prefers scraped-first everywhere.

**F3 NOW DRIVES THE REAL RESOLVER.** The walk arrived refactored in the shared tree
(`buildFontLadders` + `resolveLadder(ladder, resolveOne)`, resolver injected); semantics verified
identical, and it lets the pin exercise the real code over six production brand shapes instead of a
mirror. Three things that exposed: `check()` was **synchronous**, so a returned promise counted as a
PASS regardless — a test that could not fail; the order assertion read the requireExact flag out of a
Map when the scanned family legitimately appears TWICE in the ladder; and `entry || firstInexact` is
**defensive and currently unreachable** (sharedFamily always re-offers the scanned family
unrestricted), so it keeps a structural pin with that fact written down. Revert-proven on nine
mutations; suite 46/46, `verifyProofBeat` 55.

**⚠️ THE POD'S `/tmp` IS PER-SSH-SESSION, NOT PER-POD.** Measured: a manifest written at 08:22:56 was
gone 30s later in the next `render-ssh` call, `/tmp` empty and freshly stamped. The older note
("wiped on pod rotation") understates this. **Why it matters beyond convenience:** the pool captures
each ad's CURRENT `renderUrl` as the baseline, so losing the manifest and re-deriving after an arm
has run makes the "before" column that arm's own output — comparing an arm against itself, plausibly.
Every phase artifact is now mirrored into `type_experiment_state` in Mongo keyed by `--run`, restored
when a local file is missing, and the results column is persisted the instant it is written. Drop
with `db.type_experiment_state.deleteMany({})`.

**THE THREE ARMS** (`scripts/typeExperimentRun.js`, phases resumable):
- **A disciplined deterministic** — the shipped engine above. $0.
- **B per-brand template** (`typeTemplateExtract.js`) — read 2-3 of the brand's OWN gpt-image-2
  statics with vision, compile the observed type onto a canonical-shaped preset. **9 of 10 brands
  have usable statics, so NO image generation is needed** — the owner's $0.04-0.07/brand approval
  goes unspent.
- **C per-ad autonomy** (`typeAutonomyArm.js`) — owner: *"if we want to set another test that gives
  the LLM more autonomy, do that also."* Shows the model the ACTUAL frame and lets it choose
  placement, alignment, casing, weight, size and ink polarity for that ad alone. Four constraints are
  enforced, not merely requested: no type over a face, black/white only, no scrim, no caps quotes.
  The engine's face keep-out still runs ON TOP of the model's anchor, so a plan that would land on a
  face is corrected rather than shipped.

**ADVERSARIAL REVIEW OF ARM B FOUND A SILENT-NO-OP CLASS** — the worst possible outcome, because
"the template made no difference" and "the template never ran" look identical:
`sizeScale` was DEAD (guarded `== null`, but canonical already authors it, so the biggest type lever
never applied — now MULTIPLIES the authored value so canonical's hierarchy survives); a missing
preset file makes `--preset` fall through to canonical **with only a warning**; and there was no
zero-delta check. Also: `staticsForBrand` had no `variantKind` filter, so a repurposed **UGC** static
could have trained a brand's type template. The vision contract now REJECTS rather than clamps —
caps quotes, weight/tracking ceilings, any scrim, confidence <0.4 — because clamping ships a template
worse than canonical while reporting success.

**GROK WAS DOWN MID-SESSION** (HTTP 521 on three calls, trivial probe fine → size-related, not
credits). Fell back to two Sonnet reviewers with different lenses rather than stalling; a smaller
Grok prompt then worked and found the two HIGH font regressions. Lesson: split the prompt, don't
retry the same size.

**FONTS FILLED IN FROM LIVE SITES** (owner: *"if needed check on their websites or meta ads"*), read
from computed styles, not memory: GymShark → **Montserrat** (h1/h2/h3 700; Anton/Druk also loaded),
Peloton → **Inter**, Soludos 2 → **Newsreader** (the sibling row's stored "Poppins" appears nowhere
on the live site). Deliberately NOT recorded because an unservable name looks like real data while
resolving to a lookalike: Vuori (`aktiv-grotesk`, Adobe) and Fellow (`Fellow Solar` + `Sohne`) — both
already stored correctly, neither renderable. That took the pool from 6 to **10 real client brands**.

**LATENT, NOT MINE TO FIX SILENTLY:** `babyboo-editorial-monochrome.json` sets the **price digits** to
`colorToken:'accent'` with `accent:#BA3357`, i.e. pink letterforms, and `contrastToken()` never
remaps `accent` so it gets no plate-adaptive protection either. Six brand-specific presets also set
`deliveryLine` to `textSecondary`, the dim token the code's own comments warn against. **Every
`canonical*` and `proto-*` preset is clean** — this is confined to hand-art-directed presets, so it
only bites a brand pinned via `titleStylePreset`. The pool reports such brands rather than dropping
them. Owner's call whether to change someone's art direction.

### 0.3005 TYPE EXPERIMENT — OWNER-DIRECTED WORKSTREAM (2026-08-04). Superseded by 0.3006 above.

**Owner verdict on the 17-ad sample** (artifact 3f801888-f0d0-4d28-af66-1ee62078d894): good EXCEPT
Pelagic (font style regressed — my styleTheme alias moved it Oswald→Montserrat) and BabyBoo
(before better). Verbatim directives: *"let's just stick to black or white type only when on a
dark subject with a dark background, either with a drop shadow. The red lettering and white
lettering you are choosing is tacky and doesn't look professional"* — measured cause: `textOnLight`
fell back to brand PRIMARY (`titleSpecService.js` — Pelagic `#4d92b6` blue, BabyBoo `#ba3357`
red). And: *"look at the GPT2 static ads, those look perfect with regards to font usage, color,
placement"* — note the static path does NOT prescribe type; it hands typography to gpt-image-2
("typeface and weight, the scale and colour of every text element", `staticAdIntents.js:747`).
There is NO downloadable type rulebook in the repo; the constraint must be encoded.

**THE EXPERIMENT (owner-approved, including LLM spend and $0.01 image calls for brands lacking
statics): three arms over the SAME 30 masters, variety of colour/composition/size, then compare.**
- **Baseline** = current pre-fix renders. CAPTURE BEFORE URLS FIRST — re-titling overwrites them.
- **Arm A: disciplined deterministic** = current engine + black/white-only ink + font-order revert.
  STATE: ink fix EDITED (uncommitted) in `titleSpecService.js` — `textOnLight` default `#16181D`,
  no primary fallback; explicit curated `textOnLight` still wins (none in prod). REMAINING: font
  order — a Google-resolvable scanned family (Pelagic "Oswald") must outrank the generic
  `styleTheme.sansFontFamily` alias ("Montserrat"); `ownFace` (usable custom file, AllBirds "Self
  Modern") stays top; update `verifyProofBeat` F2 ordering pins to match; suite; commit; deploy.
- **Arm B: GPT-derived type template** = per-brand: collect 2-3 of the brand's OWN approved
  gpt-image-2 static `renderUrl`s (for brands with none, generate ONE $0.01 static via the live
  pipeline first — owner approved); send to a vision LLM with a STRICT JSON schema → type template
  (ink discipline, casing, weight, tracking, alignment, size feel, NO scrim); map onto a
  canonical-shaped preset JSON; write to `remotion/presets/` AT RUNTIME on the worker pod
  (writable but EPHEMERAL — write + retitle in the SAME pod session); drive via the EXISTING
  tier-0 `presetOverride` / driver `--preset` flag (never persisted).
  MODEL: verify live before use (CLAUDE.md rule) — `google/gemini-2.5-pro` was probed for vision
  QC (§0.2, exact-JSON-shape compliant; flash BROKE the shape). LLM calls are billable: ledger
  them, no auto-retry, `maxRedirects: 0`.
  **Grok adversarial review of the extractor BEFORE any billable call** (standing rule; it found
  real defects in every diff this session).
- **"Test the entire proposed workstream"** (owner, verbatim): after both arms work individually,
  one end-to-end run — selection → baseline capture → arm A sweep → frames → arm B template
  extraction → arm B sweep → frames → 3-column artifact (30 rows: baseline / disciplined /
  template, annotated with each brand's ink+font inputs) — as a single scripted pipeline, not
  hand-stitched steps, so it can be re-run.

**Selection (30):** variety via stored metrics — `adSuitability.metrics.primarySubjectAreaFraction`
(composition), overlay-zone band `lum` (colour/lightness), ≥8 brands, all four Meta formats
(+pmax only with a live brand — three legacy pmax ads failed `brand not found — skip`, correctly).

**BRAND INPUT TABLE (queried live, saves a round-trip):**
| brand | scanned | theme.sans | primary | customFonts |
|---|---|---|---|---|
| Pelagic Gear | Oswald | Montserrat | #4d92b6 | none |
| BabyBooFashion | Playfair Display | — | #ba3357 | none |
| AllBirds | Self Modern | DM Sans | #ECE9E2 | Geograph×8, Self Modern, Akkurat Mono |
| Vuori Clothing | Aktiv Grotesk | — | #333333 | none |
(`textOnLight` explicitly set: NONE. GymShark 3.3/41000, Vuori 4.58/15545, Pelagic 3.2/22,
BabyBoo 4.3/17645, Camelback 4.9, Peloton no data.)

**OPS (relearned the hard way, all this session):** render-ssh <900 chars/cmd, rate-limits under
sleepless loops — back off 60s, ONE call; worker `/tmp` wiped on every pod rotation and a DEPLOY
ROTATES THE POD (never launch a driver right after deploying); driver stdout goes to its own file,
NOT `render logs`; verify JSON edits by PARSING; Haiku is fine for mechanical fan-out but verify
its counts (miscounted twice); the presets round-trip at `indent=2`.

**Tasks #13-#16 track the four workstreams. Owner is compacting the conversation after this
commit — continue from THIS section.**

### 0.3004 TITLE PLACEMENT — the bug was TIMING, not geometry. Tested, awaiting rollout call.

Prod `53e26a4`. Suite 46/46, `verifyProofBeat` 53. **Tested on the three ads the owner
flagged; NOT yet rolled out to the library — that is an owner decision.**

**ROOT CAUSE, and it is not what either of us assumed.** `applyFaceKeepOut` assigns each
detected face box to the NEAREST plate sample. There are typically 3 face samples against 5
plate samples, so some samples carry no face flag at all. `resolveGroupAnchor` makes ONE
decision for the WHOLE clip but read a SINGLE sample — so whether it saw the face was luck.
Proven by running the real path against the real cached data:
```
Vuori   square:   avoid top=TRUE mid=true bot=false
Pelagic vertical: avoid top=TRUE
```
The flags were CORRECT in both. Pelagic's group happened to read a flagged sample and moved off
the face; Vuori's read an unflagged one and walked onto it. Two of my own hypotheses were wrong
first (missing face detection — it was present; then a coordinate-conversion error — the numbers
check out at 0.84 overlap). Do not re-chase either.
**My texture ranking made it worse rather than causing it:** a smooth face is LOW variance, so
once a face flag was missed, skin became the most attractive band in the frame.

**FIX:** `bandStateFor` returns the UNION of `avoid` and the MAX of `busy` across every sample.
A face occupying a band at any point disqualifies it for text on screen across that clip, and
worst-case texture is what legibility depends on. `isLight` deliberately stays nearest-sample —
ink has its own weighted vote (`plateIsLightGlobal`) and widening it would double-count.
Strictly more conservative: it can only ADD avoid flags, and when every band is flagged the
authored anchor is kept, i.e. pre-change behaviour.

**LIVE EVIDENCE — the log reason flipped, which is the tell:**
```
keepOut: top->lowerThird        (face band; authored busy 0.516 -> 0.655)
keepOut: upperThird->lowerThird (face band; authored busy 0.970 -> 0.467)
keepOut: lowerThird->upperThird (busier band; authored busy 0.875 -> 0.497)
```
Same ads previously reported `busier band` (no face seen). Note line 1 moved to a BUSIER band
because the authored one held a face — correct priority: faces disqualify, texture only breaks
ties among clear bands. Frames confirm: Pelagic 9:16 well clear, Vuori 1:1 down off the
eyes/nose, GymShark 4:5 still clear of the wordmark.

**Pinned by K4** (the rule: whichever sample the group lands on, a band a face occupies at t=2
is never chosen; with no face anywhere, texture still wins) **and K5** (the wiring: aggregation
must iterate every sample AND be what is returned). K5 revert-proven — K4 uses mirrored logic so
it does not catch a wiring revert, which is why both exist.

**ALSO SHIPPED THIS ROUND** (all owner-approved, all with revert-proven pins):
- **No burned-in CTA on Meta surfaces** (`a2e8e79`). Meta draws its own button; ours duplicated it
  and was the element most prone to contrast collisions. `landscape` (pmax/YouTube) keeps its CTA.
  `verifyTitleSpecResolution`'s G4/G6/H1 correctly FAILED this and were updated to pin the new
  contract both ways rather than deleted.
- **Pill ink from the fill** — `ctaText` defaulted to white regardless of the fill, so a
  cream-accent brand shipped white-on-cream. Adversarial review then broke my first fix with
  arithmetic: a `lum > 0.55` threshold picks WHITE on mid-tones (#5B8C5A → 1.93:1 when dark gives
  9.3:1). Now computes the WCAG ratio both ways and takes the winner.
- **Font plumbing guard** — `var(--font-sans)` and anything containing a parenthesis is no longer
  treated as a typeface. My own harness caught that `"var(--brand-font, serif)"` comma-splits to
  `serif)`, which is NOT in the generic list and would have returned a font named `serif)`.
- **The brand's own face wins when we hold the file.** Data settled this: of 34 brands ZERO set
  `headingFontFamily` (that tier was always dead) and FOUR set `sansFontFamily`, all four
  disagreeing with their scraped face (AllBirds theme "DM Sans" vs real "Self Modern"). Naively
  enabling the alias would have replaced real typefaces with generic Google ones. The scraped
  family now outranks the theme ONLY when `matchCustomFont` finds a USABLE ingested file, so
  licence holds still apply. Verified: AllBirds → Self Modern, licence-held → DM Sans, Pelagic
  (no file) → Montserrat.
- **Product-tier counts name the product** (capped 28 chars, word-safe) and the render log now
  reports `quoteTier` and flags the cross-tier case.
- **Seed guard** skips a first catalog image whose `primarySubjectAreaFraction` > 0.6, preserving
  feed order. Two of my own bugs fixed after review: `limit(24)` was a silent wrong-seed generator,
  and a missing `fileType` filter could land on a catalog VIDEO and switch Omni's seed track.

**PROCESS TRAPS HIT THIS ROUND, all worth remembering:**
- A regex JSON edit inserted a DUPLICATE `"visible"` key (non-greedy terminator stopped inside the
  nested `position` object). JSON keeps the last occurrence, so files still parsed as `true` while
  the script reported success. **Verify by parsing, never by trusting the edit log.** The presets
  round-trip exactly at `indent=2`, so structural edits are clean.
- `render-ssh` rate-limits hard; an `until` loop with no sleep hammers it into refusing everything.
  Back off, then make ONE call. `/tmp` on the worker is wiped by every pod rotation, and a deploy
  rotates the pod — so a detached driver launched right after a deploy dies with it. Monitor via
  the DB, not the log file.
- The driver's stdout goes to its own file, NOT the Render log stream — `render logs` will never
  show `keepOut:` lines from a `retitleDriver` run.

**AWAITING OWNER:** roll the placement fix across the library (a $0 re-title sweep, 382 ads, dry
run green) or leave it applying to new renders only.

### 0.3003 SEED = FEED ORDER, and the legibility fix was a POLARITY bug (prod `caec844`)

**VIDEO SEED — the 'hero' stamp is gone.** Owner: *"the default video behaviour should be the
first three images, not the 'hero' image, especially since we don't know how that is determined."*
Removed the `metadata.imageRole:'hero'` tier from `expandDeterministicVideo` — BOTH the default
seed and the non-catalog-picks product anchor — via one helper,
`firstCatalogMediaForProduct()`. The stamp was never a dependable "first image": it is written by
`catalogProductDetectService` off `CatalogProduct.imageUrl`, so it required that materialisation to
have run, and when absent the cascade fell through to earliest-`createdAt` anyway — the SAME
product could seed differently depending on ingest state. Now one rule: earliest `createdAt`.
**No change was needed for "the first three"**: `atlasVideoService` already loads `catalogMedias`
with `.sort({createdAt: 1})` and no hero ranking, and `DEFAULT_REFERENCE_IMAGE_COUNT = 3` with
`REPEAT_PRIMARY_REFERENCE=false`, so seed + mirrors ARE the first three in feed order.
Money unchanged — one Omni submit per product. Kill switch `VIDEO_SEED_FEED_ORDER` (default on)
restores the old cascade without a deploy. Pinned by `verifyProofBeat` V1.

**ANSWERING THE OWNER'S QUESTION — automatic, not a prompt.** Seed selection is fully automatic
and there is no operator prompt today. The override that exists is operator picks
(`referenceMediaIds` → `orderedReferenceMedia`, position 0 = primary seed), which bypasses the
default assembly entirely. Nothing warns an operator when the automatic pick is poor for video.

**LEGIBILITY WAS A POLARITY BUG, not a missing shadow.** Every entry in `TEXT_SHADOWS` is BLACK,
which silently assumed white type on dark footage. The plate-intel contrast flip makes the ink
DARK on light plates, so a black shadow behind dark type separated *nothing* — which is exactly
why the Vuori title vanished into a face while `inkVote` was behaving correctly. Added
`TEXT_SHADOWS_ON_LIGHT` + `textShadowFor(name, inkHex)`: polarity follows the ink's luminance
(dark ink → light halo, light ink → the original dark shadow, unparseable → previous behaviour).
Wired through EVERY `textShadow` site, including the rating row and reviews line — the two worst
affected. No boxes, no scrim. Verified in frame: headline, `4.6/5` and `15,545 reviews` all legible
over the beard where the headline had been invisible. Pinned by S2-1/S2-2 (S2-2 bans any
`textShadow: TEXT_SHADOWS[...]` so a new slot cannot reintroduce the dark-only assumption).

**TWO THINGS MEASURED AND DELIBERATELY NOT BUILT:**
1. **The camera-prompt constraint the owner asked for.** Not implemented — it could not have fixed
   the observed ads (§0.3002 numbers), and camera directives are the one lever already rolled back
   for causing hallucinations (`be5b83f`). Raised with the owner rather than shipped.
2. **An automatic "prefer a wider seed" picker.** There is NO signal for it.
   `OverlayZoneArtifact.zones.restrictions` looked perfect — it has a `'face'` classification with
   `rectPct` geometry and "any visible face gets ≥0.9" — and 95% of catalog media have the artifact
   (3446/3624). But **0 of 120 sampled carry a `face` restriction at all**, so face coverage is not
   derivable from existing data. `classification.shotType` cannot substitute: it has no
   shot-distance axis, so "on_model full body" and "on_model face close-up" are the same value and
   both rank 1–2. Getting this signal needs either a new field on the existing detect call (free,
   but that is INGEST — a colleague's area, owner-scoped-out) or a vision call per candidate seed
   (~$0.02, cached) at generation time.

**HARNESS LESSON, worth repeating:** V1's first version PASSED with the regression restored — it
scanned only from `expandDeterministicVideo` onward and could not see the helper declared above it.
Caught solely by revert-proofing. Source-anchored checks must assert on the structure that actually
decides the behaviour, not on a region that merely contains its call site.

### 0.3002 TEXT-ON-FACE — the camera prompt is NOT the cause. Measured.

Owner picked "constrain the camera prompt" for the close-up legibility problem, but the numbers
say that would not have fixed it, so it was NOT implemented pending a decision.

Measured on the Vuori square ad (`6a710c82…`): `basePlate` = source **1080x1920**, crop rect
`{cx:0, cy:67, cw:1080, ch:1080, anchorY:'face-safe'}`, face envelope `top 0.035 → bottom 0.558`.
That is a face **1,004px tall — 52% of the master's height**. A 1080px square crop therefore
**cannot** contain that face and still leave a clear title band; there is no cy that works. And
`anchorY:'face-safe'` exists to keep the face IN frame, which is the opposite of what titling
wants. Same shape on GymShark (`cy:39`, envelope to 0.35 — less extreme, still tight).
So the chain is: the MASTER is a tight portrait → the square/4:5 face-anchored crop preserves the
face → titles have nowhere clear to go. A zoom cap in `buildVeoPrompt` changes the last ~10% and
cannot undo a seed that is already a portrait.
**Also relevant, and a reason for caution:** `be5b83f` rolled back ALL of PR#61's camera-prompt
changes because the owner found they *"creat[ed] additional hallucinations and the previous output
was better."* Adding camera directives is the one lever with a proven history of backfiring here.
Real levers, in order of effect: (a) VIDEO SEED framing — prefer a wider on-model/full-product
shot over a tight portrait for ads that will be cropped square; (b) legibility treatment (soft
shadow, no box) which works on EXISTING masters at $0; (c) crop bias for less-extreme masters;
(d) camera zoom cap — marginal, and needs its own live A/B given (be5b83f).

### 0.3000 VALIDATED IN PIXELS — the proof beat works end to end (2026-08-03 19:04)

Live Chrome test on staging found a BLOCKER that no harness could, then confirmed the whole
chain in a real frame. Prod = `56569a2` both services. Suite **40/40**, `verifyProofBeat` **28**.

**THE BLOCKER: `ctx.brand` was null for GymShark, so the brand-tier fallback could never fire.**
`loadContext` resolves the brand by NAME, and the name on a Media/CatalogProduct is scraped page
text. GymShark's catalog media carries `metadata.brand = "Gymshark | Be a visionary."` — name plus
site tagline — which `normalizeBrandName` turns into `"gymshark be a visionary"`, and that can
never match the real doc's `"gymshark"`. `findBrandByName` returned null, so EVERY brand-sourced
field silently vanished: `brandReviews` (empty brand quote pool → the new fallback was
structurally unable to fire), `styleTheme`, logo, tagline. `media.brandId` pointed at the correct
Brand doc the whole time (`6a6a4d58…` → "GymShark", 6 quotes, 3.3/41000).
Fix (`f2f26bf`): use the FK **only when the name lookup already returned null**, so every
resolution that works today is byte-identical, and log when it rescues one. Pinned by B1/B2 in
`verifyProofBeat` (B2 fails if the normalizer ever learns to strip taglines, i.e. if the FK stops
being what rescues this brand). **Deliberately did NOT touch the scraped name — that is ingestion,
owned by a colleague** (owner instruction, same session: *"don't make any changes to ingestion …
let's focus on the selection, curation, and integration into the ads"*).

**The full live chain, GymShark ad `6a70cf95…` (square), $0 re-title over the paid master:**
```
🔗 brand name lookup failed for "Gymshark | Be a visionary." — resolved via brandId FK to "GymShark"
🔓 6 brand-tier quote(s) demoted to last-resort on a product ad
🔓 brand-tier quote WON as last-resort fallback on product ad
📐 quote pool product=3 category=0 brand=6 comment=0 → winner=brand "clothes look and feel great…"
ratingPair: source=brand-count rating=none count=41000
🎨 brandScript: engine=remotion format=square spec=canonical
```
Note `product=3` yet brand won: all three product quotes failed `pickStrongestQuote`'s score
floor, so the last-resort ladder behaved exactly as designed.

**THE FRAME** (Cloudinary still, `so_4.6` post-settle, 1080x1080):
badge "TOP RATED COMFORT" · headline "Gymshark Campus Crest Sweatshirt" ·
**"41,000 reviews · GymShark"** · *"clothes look and feel great and reasonably priced"* ·
"Best Seller" · SHOP NOW. Type sits below the chin (face keep-out fired), dark ink on the light
plate (inkVote on-light).
- **NO STARS** — 3.3 suppressed per the owner rule, while the volume still lands. Report 3 fixed.
- **The quote prints with NO byline** — anonymous llm-web text, provenance gate holding. Report 2
  fixed.
- **"41,000" is COMMA-FORMATTED** — direct proof the `parseReviewsLeadingNumber` fix works. Before
  it, this exact string rolled 0→410 with a stray "00" beside it.
Still: `…/video/upload/so_4.6/v1785783858/liquidretail/brand_script/product-1785783857757-1-8zltbuf2.jpg`

**Also confirmed live on the OTHER path** (AllBirds `6a7017ee…`, via the UI's "Re-render title"
button — a $0 titling-only action worth knowing about, no Omni submit):
`📐 buildMetaForAd: layoutInput STALE (schemaVersion=4.0 want=4.1) — serving non-quote fields;
quote withheld by the provenance gate` + `ratingPair: source=none`. That is the stale-artifact
correction working as intended: non-quote fields still served, only the unstamped quote withheld.
A pre-4.1 artifact legitimately shows no proof beat until it is re-derived.

### 0.29999 SHIPPED — live on prod, both services (2026-08-03 18:39)

**The concurrent session committed MY work along with theirs**: `0319c68` ("Parallel generations
+ wizard reference prewarm; land session's titling work") → merged `9fda078`. Both Render
services report `Live 9fda078e…`, finished 18:39. Every fix verified present in HEAD after their
merge (nothing mangled), and the **full suite is 40/40 on the merged tree**.
So the shared-tree problem resolved itself — no cherry-picking was needed.

**NOT YET EXERCISED IN PROD.** Checked the logs after deploy: zero `ratingPair:` lines, and the
newest `quote scope` lines still carry the OLD "withheld" wording from 16:46. Nothing has
rendered since 18:38. Confidence rests on 40/40 harnesses + the 26-check proof-beat harness +
the 9-shape execution trace — not on a live frame yet.
**It will engage on its own with the team's next video generation**: the generation path now
refreshes a stale artifact automatically (`refreshStaleLayoutInput`), so a fresh 4.1 artifact
with the brand-tier quote is built before titling. No manual step needed for NEW videos.
Watch for `ratingPair: source=brand-count` and `🔓 quote scope — brand-tier quote WON`.

**BACKFILL: STOOD DOWN, and it was the right call twice over.**
1. Owner 2026-08-03: *"don't make any changes to ingestion my colleague is working on that,
   let's focus on the selection, curation, and integration into the ads."* The backfill drives
   `brandEnrichmentService` = ingestion. Out of scope now.
2. The dry run proved it would be **waste anyway**: all 17 candidate brands already carry
   `brand-reviews` in `enrichmentSources`, so `wantBrandReviews` is false for every one — it
   would fetch **zero** brand ratings while still firing billable `gpt`/`scraped`/`brandfetch`/
   logo/font tiers, on a list that is mostly junk (`Apple`, `Test`, `Test 2`, `Egami`, two
   duplicate `Hot Crispy Oil` docs). Re-fetching brand reviews would require clearing
   `brand-reviews` from `enrichmentSources` — deliberately NOT done unilaterally.
   `scripts/backfillBrandReviews.js` is committed and dry-run-safe for whenever it IS wanted.

**CORRECTION — AllBirds DOES have brand review data.** Earlier in this session I reported "AllBirds
has no brand rating at all" and it is in the plan file that way. Queried fresh post-deploy:
**AllBirds `3.8 / 2,667 reviews / 6 quotes`** (`enrichmentSources`: brandfetch, tailwind, scraped,
gpt, brand-reviews) and **GymShark `3.3 / 41,000 / 6 quotes`**. Both FAIL the >4.5 star gate and
both have a real count plus brand quotes — so both are now ideal live cases for the count-only
proof beat, and neither needs any enrichment. My earlier "no data" read was wrong; this is the
record.

**Remaining (optional) validation:** $0 re-title of AllBirds `6a70c584f33c6cfd76d43e54` or
GymShark `6a70cf95f33c6cfd76d46b6b` (both hold paid masters) to see the beat without waiting for a
generation. Requires a `buildLayoutInput({…, refresh:true})` first, because `primary_quote` is
baked in at ASSEMBLY time and both artifacts predate the brand-tier fallback. Reuse the existing
artifact's own `template`/`aspectRatio` for the refresh so the right cache entry is overwritten.
**Blocked purely on ops:** `render-ssh` rate-limits after ~10 rapid sessions and was exhausted by
script staging. `resolveTitleTemplate` is NOT exported from atlasVideoService — read the template
off the artifact doc instead. And a driver in `/tmp` cannot resolve app modules by relative path:
require via absolute `/opt/render/project/src/...` (`process.chdir` does NOT fix module
resolution — that trap cost two runs).

### 0.3 Landed this session (branch `fix/remotion-font-fatal-load`, NOT committed)

| change | files |
|---|---|
| FontLoader loads via raw `FontFace`; a font failure warns and continues, never `cancelRender` | `remotion/components/FontLoader.jsx` |
| Dual asset routes `/fonts` (google+custom) + `/libfonts` (library-match) via `fontRouteForLocalPath()`; traversal guard applied to every base | `services/remotionRenderService.js` |
| CORS headers on 404/416/500 so a miss is a clean error | `services/remotionRenderService.js` |
| Owner rule "we only use stars over 4.5" → `RATING_STAR_MIN = 4.5`, strict `>` | `services/directImageRenderService.js:357-359,414-423` |
| New harness, revert-proven | `scripts/verifyFontServing.js` |
| P3 fixtures updated for the 4.5 floor (deliberate contract change, documented) | `scripts/verifyQuoteProvenance.js` |

**Verify suite is now 30 scripts, 30/30 green** (`verifyQuoteProvenance` 161 checks,
`verifyFontServing` 23).

**Two adversarial passes were run on this diff and BOTH independently found the same HIGH bug**
— proof the two-pass rule earns its cost. Fixed before any commit:
- **The star gate tested the RAW value but the ad displayed the ROUNDED one.** `4.51/4.54/4.55`
  passed `> 4.5` and then printed **`"4.5"`** — the exact string the owner rule forbids, and it
  also kept `social_proof_led` eligible. Now ONE shared helper `services/ratingDisplay.js`
  (`formatDisplayRating`) gates on the DISPLAYED value. Verified: 3.2/4.4/4.5/4.51/4.55/87 →
  withheld; 4.6→"4.6", 4.66→"4.7", 5→"5".
- **The rule was static-only; video chrome rendered any `rating > 0`**
  (`remotion/compositions/Canonical.jsx:78`). Prod holds a real catalog rating of **3.2**, so
  that was live exposure, not theory. Now gated at the single meta source
  (`brandScriptExecutor.js:747-748`) using the same shared helper. Both cascade sources
  (`layoutInput.input.social_proof.rating_value`, `catalogProduct.rating`) confirmed to store
  JS numbers in prod, so the strict `typeof === 'number'` check is safe.
- **`FontLoader` created its delay handle in `useState`,** so an effect re-run loaded fonts
  against an already-continued handle and silently lost the wait. Handle is now created INSIDE
  the effect, with all three exit paths releasing it (settle / batch-catch / cleanup).
  **Reviewed by hand — a leaked handle hangs a render forever.**

**Still open from adversarial pass 1** (tracked, not done): soft-fail font loading converts a
hard crash into a SILENT off-brand ship, so font-resolution failures should be recorded on the
Ad and surfaced in the inspector; `fontRouteForLocalPath` should prefer the existing
`source:'library-match'` field over path matching; and `verifyFontServing`'s T* traversal checks
overclaim (`path.normalize` runs before the head split, so `..` returns null via unknown-head
even with the guard deleted).
The star gate makes `social_proof_led` ineligible below 4.5; the existing
`FALLBACK_ORDER` (`staticAdIntents.js:347`) handles it — `product_first_lifestyle` is always
eligible. `badges:['top rated']` deliberately left at `>= 4.5`: different concept, and
`buildIntentData` does not pass `proof_badges` to intent text anyway.

### 0.29997 COST LEDGER — the grounded-search path was invisible (2026-08-03)

`geminiSearchProvider.lookupBrandReviews` / `lookupProductReviews` hit the RAW
`generativelanguage` REST endpoint with axios, so they bypassed `atlasLlmService` and
ledgered **nothing** — while the sibling GPT-4.1 tier in the same `brandEnrichmentService`
appeared on every spend report. Each function is **two** billable POSTs (grounded
`google_search` pass, then a JSON-structuring pass), on every brand/product enrichment run.
Now ledgered via a single `trackedGenerate()` helper → `costTracker.trackLlmCall`,
`stage:'brand_reviews'|'product_reviews'`, `purposeTag:'grounded_search'|'json_structure'`,
with brandId/productId threaded from all four call sites.

**Three things a plain wrap would have gotten wrong — all verified live, not assumed:**

- **Grounding is billed PER REQUEST, not per token, and it dominates.** $35/1,000 grounded
  prompts = $0.035, against ~$0.004 of tokens. Token-only math understates this path **~10x**.
  New `costTracker.GROUNDED_SEARCH_COST_PER_REQUEST_USD` + `CostLog.groundedRequests`.
  **Per-PROMPT billing is a 2.5-era rule** — Google bills Gemini 3 per executed *query*, so a
  model bump changes the unit.
- **`MODEL_RATES['gemini-2.5-flash']` was wrong: 0.10/0.40 are Flash-LITE numbers.** Live is
  **0.30/2.50/0.03**. Every direct-flash row understated input 3x, output 6x. The Atlas sibling
  `google/gemini-2.5-flash` already carried the right values, which is what gave it away.
  ⚠️ **Expect a step change in flash spend reports — it is the fix, not a regression.**
- **`extractUsage` counted `candidatesTokenCount` only.** Gemini reports `thoughtsTokenCount`
  separately but bills it at the OUTPUT rate, and 2.5 thinks by default (pass 1 sets no
  thinkingBudget). `toolUsePromptTokenCount` also added — ~1% of a row, and Google does *not*
  explicitly document it as billable, so the comment says so honestly.

`scripts/verifyGeminiSearchCost.js` — 20 checks, offline (axios + `CostLog.create` stubbed),
**revert-proven against 6 separate mutations**. Suite now **39/39 green**.

**Adversarial pass (Grok, high effort) — two findings accepted, both now pinned in code:**
its `toolUsePromptTokenCount` challenge was fair (unproven → comment made honest), and the
error path ledgers **$0 even for a grounded call that may have been billed**. That is
*pre-existing* `trackLlmCall` behaviour for every consumer; fixing it means distinguishing
"never left the box" from "server answered / we timed out" — shared error semantics, out of
scope. **Deliberately pinned in harness check C7 so it stays a decision, not an accident.**

**Two policy calls left to the owner** (both one-liners): the free **1,500 grounded
prompts/day** allowance means $0.035 *overstates* until it is exhausted —
`GEMINI_GROUNDING_COST_USD=0` ledgers the free tier honestly; and
**`MODEL_RATES['gemini-2.5-pro']` output is ALSO stale** (5.00 vs live 10.00, caching 0.31 vs
0.125), understating `layoutInputService` 2x — left untouched on purpose, flagged in-code.

**Still unledgered, same class:** `geminiSearchProvider.match` (every detect run!),
`.lookupBrandCategoryUrl`, `categoryReviewsService`, `productDetailsService` — all POST the
same raw endpoint with no tracking and no `maxRedirects:0`.

⚠️ **These edits sit in the `fix/remotion-font-fatal-load` working tree**, on top of that
branch's own uncommitted work. Nothing was committed. Six files + one new script; the cost
change is separable from the font fix if you want it on its own branch.

---

