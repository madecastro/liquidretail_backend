# Atlas Cloud AI Gateway

All AI-model traffic (LLM chat/vision, image generation/editing, video
generation) routes through Atlas Cloud (`api.atlascloud.ai`) — one key
(`ATLAS_API_KEY`), one cost ledger, with the original direct providers
retained as automatic fallbacks. Migrated 2026-07-21.

## 1) Transports

- **`services/atlasLlmService.js`** — `chatCompletion(meta, params)`: the
  single chat-completions transport (OpenAI-compatible request/response,
  vision `image_url` parts, `json_object` + strict `json_schema`).
  Retries 5xx/network (3 attempts, backoff), then **falls back to the
  direct provider with the ORIGINAL model** — OpenAI for gpt rows,
  Google's OpenAI-compat endpoint for gemini rows — on gateway-side
  failures (router-missing, 5xx, 429-exhausted, auth/404). True
  validation errors (400/422) fail fast without fallback. Every call
  logs through `costTracker.trackLlmCall` with caller meta passed through.
- **`services/atlasModelMap.js`** — legacy→gateway model mapping with the
  direct-fallback model per role; env-overridable (`ATLAS_MODEL_<ROLE>`).
- **`services/atlasImageService.js`** — `generateImage` / `editImage` via
  the async media API (submit `/model/generateImage`, poll
  `/model/prediction/:id`, `uploadMedia` for buffer inputs). Returns
  OpenAI-images-shaped `{ data: [{ b64_json }], url }`. Per-image costs
  read from the live catalog into the ledger. Direct-OpenAI images
  fallback with the caller's `fallbackModel` (gpt-image-1 / dall-e-3).
- **`services/atlasVideoService.js`** — video generation (predates this
  migration). `services/videoRouter.js` now defaults `VIDEO_PROVIDER=atlas`;
  the direct-Veo `aiVideoReferenceService` remains the `vertex` fallback.
  Operator-selectable models (schemas live-verified 2026-07-21) via the
  Brand "Video Generation" card + the regenerate dropdown
  (`GET /api/ads/video-models`):
  - `google/gemini-omni-flash/image-to-video-developer` — DEFAULT; ≤7 ref
    images; 16:9/9:16 only; $0.20 + $0.10/s (4k base $1.00).
  - `google/gemini-omni-flash/reference-to-video-developer` — transforms
    the ad's seed VIDEO (`video_clips` + ≤5 ref images; image-seeded ads
    degrade to the i2v default); 16:9/9:16 only; flat $1.60/gen ($2.40 4k).
  - `xai/grok-imagine-video-v1.5/image-to-video` — SINGLE starting-frame
    `image_url` (the multi-image stack is the v1 reference-to-video line,
    kept registered but not selectable); 7 aspect ratios; pricing
    UNVERIFIED (carrying v1's $0.50/s until a live render confirms).
  Canvas formats outside an Omni model's 16:9/9:16 support automatically
  route through the existing reference pre-crop to Grok 1.5
  (`ASPECT_FALLBACK_MODEL`, env `ATLAS_VIDEO_FALLBACK_MODEL`) — see
  `resolveModelAndAspect`.
  Render length: standard 8s; the wizard's format-selection stage can
  pick 1–15s, stamped per-ad as `Ad.videoDurationSec`. At render time
  `resolveDurationSec` clamps to the model's range and snaps to the
  Omni duration enum (4|6|8|10, nearest); the Ken Burns prompt's Output
  line and 3-scene timeline scale to the same value.
  Default prompts are per-model-family (`veoPromptBuilder.PROMPT_PROFILES`,
  selected by `promptProfileFor(caps)`, logged on every submit):
  `gemini-omni` (verbose; optimized for google/gemini-omni-flash/*, 20k
  cap) and `grok` (compact re-authoring of the same rules; optimized for
  xai/grok-imagine-video*, 4,096-byte cap; also serves veo/generic).
  Tune each family's directives independently in its labeled block.

## 2) Model map (live-verified 2026-07-21)

Catalog listing alone is NOT proof a model routes — `openai/gpt-4.1` is
listed but returns `router not found`. Every slug below was probed with a
real chat call. The gpt-4.x/4o family has no Atlas router, so those roles
substitute the routable gpt-5.6 line (env-overridable; direct fallbacks
keep the legacy models):

| Legacy model | Atlas slug | Direct fallback |
|---|---|---|
| gpt-4.1 | `openai/gpt-5.6-terra` ($2.5/$15 — same tier) | gpt-4.1 |
| gpt-4.1-mini | `openai/gpt-5.6-luna` ($1/$6) | gpt-4.1-mini |
| gpt-4o-mini | `openai/gpt-5.6-luna` | gpt-4o-mini |
| gpt-4o | `openai/gpt-5.6-terra` | gpt-4o |
| gemini-2.5-flash | `google/gemini-2.5-flash` (exact) | gemini-2.5-flash |
| gemini-2.5-pro | `google/gemini-2.5-pro` (exact) | gemini-2.5-pro |
| gpt-image-1 (gen/edit) | `openai/gpt-image-1.5/text-to-image` / `/edit` | gpt-image-1 |
| Gemini native image gen | `google/nano-banana-2/edit` | direct Gemini (full impl retained in geminiImageService) |

**Reasoning-token headroom:** the gpt-5.6 line and gemini-2.5 spend hidden
reasoning tokens out of `max_tokens` (verified: empty message +
`finish_reason: length` at small budgets — the raw-Gemini `thinkingBudget`
knob does not exist on the OpenAI-compat path). `atlasLlmService` adds
`reasoning_effort: 'low'` on openai slugs and pads `max_tokens` with
`ATLAS_REASONING_RESERVE_TOKENS` (default 768); fallback requests strip
gateway-only params and restore the caller's budget.

## 3) Documented exceptions (stay on direct providers)

| Service | Why |
|---|---|
| `services/providers/geminiSearchProvider.js` (6 calls), `productDetailsService`, `categoryReviewsService` (grounded calls) | Gemini `google_search` grounding + `groundingMetadata` citations are not expressible through an OpenAI-compatible gateway. Needs `GEMINI_API_KEY`. |
| `services/openaiImageService.js` | Mask inpainting (`images.edit` + mask PNG). No Atlas edit model accepts masks (gpt-image-1.5/edit and nano-banana-2/edit schemas verified live). Needs `OPENAI_API_KEY`. |
| `services/whisperService.js` | `whisper-1 verbose_json` per-segment timestamps feed nerService. Atlas has ASR models (`bytedance/seed-asr-2.0` `show_utterances`, `xai/stt-v1` `diarize`) but their timestamp output shape is unverified; revisit when the legacy inventory pipeline is next touched. Needs `OPENAI_API_KEY`. |
| Monorepo `server/services/openaiService.js` | Legacy, non-deployed Express app — migrated to Atlas-first for consistency but keeps its direct client (no shared transport there). |

## 4) Cost ledger

`services/costTracker.js`: provider `atlas` (and `google-openai` for the
Gemini direct fallback) extract OpenAI-shape usage; `MODEL_RATES` carries
the live-verified gateway rates; unknown model ids warn once instead of
silently logging $0. Image/video calls record flat per-generation costs
(`recordFlatCost`) with prices read from the live catalog.

## 5) Env

- `ATLAS_API_KEY` — primary, everything.
- `OPENAI_API_KEY` / `GEMINI_API_KEY` — fallbacks + the exceptions above.
- `ATLAS_TEXT_BASE_URL`, `ATLAS_LLM_MAX_ATTEMPTS/BACKOFF_MS/TIMEOUT_MS`,
  `ATLAS_REASONING_RESERVE_TOKENS`, `ATLAS_MODEL_<ROLE>` overrides,
  `ATLAS_IMAGE_MODEL`, `ATLAS_IMAGE_EDIT_MODEL`, `ATLAS_GEMINI_IMAGE_MODEL`,
  `ATLAS_IMAGE_POLL_MS/TIMEOUT_MS`, plus the pre-existing video vars.

## 6) Verifying / extending

Never trust a model id from memory: `GET https://api.atlascloud.ai/api/v1/models`
(no auth) lists the catalog; probe with a real chat call before adding to
`atlasModelMap` (listing ≠ routing). Fetch the per-model schema URL from
the catalog entry before using media-model params.

## 7) Prompt caps, resolutions, pricing — live-verified 2026-07-29

Method, in priority order (owner direction: **the Atlas per-model docs outrank the
OpenAPI schema**). Every catalog entry from `GET /api/v1/models` carries three URLs:

1. `readme` → `https://static.atlascloud.ai/model/readme/<slug>.md` — human param
   tables and pricing. **Primary.**
2. `schema` → `https://static.atlascloud.ai/model/schema/<slug>.json` — machine enums.
3. `price` → on the catalog entry itself. Field is **`price.actual.base_price`**, a
   string. There is **no `pricing` key**. ⚠️ **This is a BASE, not the amount charged
   — see below.**

README and schema agreed on all eight models checked. Re-run before trusting these.

### `base_price` is not the charge (measured 2026-08-03)

Corrected after a 40-render live sample. `base_price` under-reports the real charge by
a multiplier that is **not published anywhere in the catalog**:

| model | catalog `actual.base_price` | **measured charge** | ratio |
|---|---|---|---|
| `openai/gpt-image-2/edit` | $0.01 | **$0.07173** | 7.17x |
| `openai/gpt-image-2-developer/edit` | $0.005 | **$0.03586** | 7.17x |

Both were dead-consistent across every priced prediction, so the 50% `-developer`
discount is real — but the multiplier sits on top of both. Do **not** hardcode 7.17
or carry it to another model, size or quality; it was measured only at
`1024x1024` / `quality: medium`.

**Always read the price back from Atlas after generation** (owner rule). The
authoritative figure is `price` on the **settled** prediction from
`GET /api/v1/model/prediction/:id`. Atlas usually publishes it *after* the image is
returned — **7 of 38** predictions had it at completion time — so a single read when
the image lands misses most of them. `atlasImageService.scheduleCostReconcile` is the
mechanism, and its retry budget was widened to
`[3s, 10s, 30s, 60s, 120s, 300s]` on the same date for that reason. `buildPriceMap`
gives a floor-grade estimate only; its job is to stop a $0.00 ledger row, not to
answer "what did this cost".

### Selectable video models (`selectable: true` in `MODEL_CAPS`)

| slug | prompt cap | source | resolutions | aspects |
|---|---|---|---|---|
| `google/gemini-omni-flash/image-to-video-developer` | **20,000 chars** | README param table + schema description | 720p/1080p/**4k** | 16:9, 9:16 only |
| `google/gemini-omni-flash/reference-to-video-developer` | **20,000 chars** | same | 720p/1080p/4k | 16:9, 9:16 only |
| `xai/grok-imagine-video-v1.5/image-to-video` | **none published** | Atlas README, Atlas schema and xAI docs are all silent | 480p/720p/1080p | 1:1,16:9,9:16,4:3,3:4,3:2,2:3 |

Registered but **NOT selectable** (still reachable via persisted `videoSettings` or
env, because `validateVideoSettings` accepts any `MODEL_CAPS` key):
`xai/grok-imagine-video/reference-to-video`, `google/veo3.1/image-to-video`.

Our `promptByteCap` of 4096 for Grok is **product policy, not a provider limit** — do
not comment it as a spec. Veo's real constraint is Google's **1,024 tokens**, so a
4096-*byte* cap is unit-mismatched; moot while Veo is unselectable.

### Omni pricing — 720p and 1080p cost the SAME

README, verbatim: *"720p and 1080p are identically priced."*

```
(resolution == "4k" ? $1 : $0.2) + duration × $0.1
```

8s → **$1.00 at 720p, $1.00 at 1080p, $1.80 at 4k.** Hence
`ATLAS_VIDEO_RESOLUTION=1080p` in `config/defaults.env`: free, and it matches every
`deliveryDims` in `platformFormats.js` (all 1080-wide), so a 9:16 render is
1080×1920 and a 1:1 crop lands at exactly 1080×1080 with no upscale.

### Outpaint / reframe (`google/nano-banana-2/edit-developer`)

Resolution enum `1k|2k|4k`; **`REFRAME_RESOLUTION=4k` is already the maximum** — there
is no higher tier. README prices 1k **$0.08**, 2k **$0.08**, 4k **$0.16** ("4K costs
2× the standard rate"). So **2k is a free upgrade over 1k**; only 4k costs more. The
`-developer` suffix is a **billing** variant (50% off, live-verified: `actual` 0.04 vs
`origin` 0.08), not a quality tier.

### No system prompt on any media endpoint

All seven fetched schemas expose a single flat `prompt` string; only Veo adds
`negative_prompt`. **There are no chat roles on image or video generation.**
System/user prompt pairs exist only on the LLM/chat transports. The frontend
inspector's "Layout prompt (system/user)" is the **AI Canvas spec generator's** LLM
call, not the image model's — label any new prompt UI accordingly.

### Prompt-length enforcement today

- Video: per-model `caps.promptByteCap` via `veoPromptBuilder.enforceByteCap`, which
  drops whole lines in `DROP_PRIORITY` order when over budget. **Measured:** on Grok
  (4096) with ~400 chars of guidance it silently drops `Product` and `PHYSICAL
  ACCURACY`; at 1000 chars (the route's own legal max) the prompt is 4,250 bytes —
  over cap after dropping everything — and is submitted anyway with a warning.
- `routes/ads.js:69` rejects `videoPromptRaw > 4000` **chars regardless of model**, so
  an Omni prompt legal at 20,000 chars is refused at ~4,300.
- Image path: **no cap and no instrumentation** anywhere.

## 8) The '-developer' suffix is NOT uniformly cosmetic (verified 2026-07-29)

An older comment in `atlasVideoService.js` claimed `-developer` is a billing variant
only, and that "the same pattern holds across all 12 '-developer' variants". **That
generalisation is false.** It was verified for `google/nano-banana-2/edit` — where it
does hold — and then over-generalised.

Diffed live for `google/gemini-omni-flash/image-to-video`:

| | plain | `-developer` |
|---|---|---|
| image input | **`image`** — single string | **`images`** — array, 1–7 |
| duration | range **3–10**, default 10 | enum **4/6/8/10**, default 8 |
| resolution | **`720p` only** | **`720p` / `1080p` / `4k`** |
| `thinking_level` | **present** (default/high/low) | **absent** |
| price (8s) | `max(3, dur) × $0.13` = **$1.04** | `$0.2 + dur × $0.1` = **$1.00** |

So for this family the suffix changes the request shape, the resolution ceiling and
the pricing formula. **`-developer` is the only variant that can do 1080p**, which is
what `ATLAS_VIDEO_RESOLUTION=1080p` depends on.

**Rule: diff the two schemas for the specific slug before assuming anything.**
`https://static.atlascloud.ai/model/schema/<slug>.json` for each, then `diff`.

### All four Omni endpoints are one model

The plain README states it directly: *"AtlasCloud exposes Gemini Omni Flash through
four endpoints — text-to-video, image-to-video, reference-to-video, and video-edit.
All four route to the **same** `gemini-omni-flash-preview` model and differ only by the
input modality they accept."*

Registered in `MODEL_CAPS`: image-to-video-developer, reference-to-video-developer.
**Not registered:** `google/gemini-omni-flash/video-edit` (source video + edit prompt,
1–5 optional refs, `thinking_level`, **`resolution` enum is `['720p']` only**, priced
`clamp(duration, 3, 30) × $0.14` — so $1.12 for 8s, *more* than a fresh generation).
Also unregistered: the `text-to-video` pair and the plain non-developer variants.

### Conversational / multi-turn editing is NOT available through Atlas

Checked every field of both Omni video schemas plus both READMEs: **zero** occurrences
of `interaction`, `session`, `conversation`, `multi-turn`, `persistent`, `state`,
`follow-up` or `previous_*`. The input surface is stateless —
`{model, prompt, images|video_clips, duration, aspect_ratio, resolution, seed}`. Every
Atlas call is independent.

What this means for the **regeneration loop today**: `adRegenerateService.js:205` calls
`generateForAd({ ad, operatorPrompt })`, which regenerates from the **original seed
images** with the refinement prepended, then overwrites `veoVideoUrl` at `:211-217`. So
an operator's "make the quote larger" is interpreted against the seed stills, not
against the clip they just watched. It is a re-roll with a hint, not an edit, and
nothing is pixel-stable.

### Google's Interactions API — reachable, but not through Atlas

Google's stateful video editing is the **Interactions API** on the Gemini **Developer**
surface (API-key auth, not Vertex):

- `POST https://generativelanguage.googleapis.com/v1beta/interactions`
- State carried by **`previous_interaction_id`**; each response returns an `id` to chain.
- Image-to-video multi-turn IS supported: `"task": "image_to_video"` in `video_config`,
  initial image as `{"type":"image","data":<base64>,"mime_type":...}`.
- Aspect ratios **`9:16` / `16:9` only** — same restriction as Atlas, so deriving 1:1
  and 4:5 by crop is required either way.
- We already call that host (`aiVideoReferenceService.js:30`) and `.env.example:158`
  confirms our "vertex" provider actually authenticates with `GEMINI_API_KEY`.

**UNVERIFIED and load-bearing before adopting it** — no key was available to test:
1. **Resolution ceiling.** The doc lists aspect ratios but *not* resolutions (only
   ">720p when available" re: URI delivery). If Interactions is 720p-only it is
   mutually exclusive with 1080p multi-format delivery — a product decision, not a
   technical one.
2. **Pricing.** Atlas `-developer` is 50% off list. Direct Google is presumably list;
   the doc page carries no pricing.
3. Video references are documented as capped at 3s and "currently unsupported".

Adopting it also means re-implementing on a new transport everything Atlas currently
gives us: `submitRetryDecision` (submit-once), `pacedModelSubmit`, `maxRedirects: 0`,
the prediction-poll machinery, and the cost ledger. `aiVideoReferenceService` is the
existing direct-Google path and `ARCHITECTURE_REVIEW.md`'s divergence table rates it
weaker on every axis — harden it before putting money through it.
