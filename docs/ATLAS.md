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

### Poll-time transport noise ≠ a task verdict (fixed 2026-08-05)

**Incident:** two static ads failed with
`Atlas image unknown (HTTP 502, code n/a, status unknown): …Cloudflare error 502: Bad gateway… —
unrecognised failure shape`. The submit had **succeeded** (real prediction ids,
`openai/gpt-image-2/edit`); the **first status poll** 3-4s later came back as a bare Cloudflare error
page. `classify()` correctly has no policy matching that shape — there is nothing in it to match — so
it fell to `FALLBACK` (`retryable:false`) and `atlasImageService`'s poll loop threw, discarding a
render Atlas was most likely still working on.

⚠️ **Do NOT read those rows as "free". `FALLBACK.charged` is `null` — UNKNOWN, not false.**
`renderService.js:1440` writes `charged: err.charged === true`, which collapses that `null` to
`false`, and `models/Ad.js` declares `renderError.charged` as `{type: Boolean, default: false}`, so
the schema cannot express "unknown" at all. The two ads that failed this way on 2026-08-05 are
therefore recorded as costing nothing when the honest answer is **we do not know whether Atlas
billed them** — and per §4's owner rule a charge may only be asserted from a CONFIRMED price on the
settled prediction. Understating the ledger is the one direction it can never be corrected in.
**Open, needs a schema change** (tri-state, or a companion `chargeConfirmed` field); the
`peekImagePrediction` price read-back below is the mechanism that would populate it truthfully.

**The distinction that matters:** an error seen while **polling** may carry information about the
task (`data.status:'failed'`, a coded `{code,msg}` envelope) — or **none at all** (a CDN/WAF/proxy
error page). The second kind says nothing about the prediction, and a poll is an **idempotent GET**,
never a resubmit — so continuing to poll the same id is free and cannot double-charge. That is
categorically different from the submit path, where the "never blind-retry a billable POST" rule
still holds absolutely and is untouched.

`isPollTransportFailure({httpStatus, envelopeCode, hasDataObject, isFailureStatus})` in
`services/atlasErrorPolicy.js` returns true **only** when there is zero Atlas signal: no numeric
envelope `code`, no `data` object, non-200, and no definitive verdict. It is deliberately the logical
complement of `atlasImageService`'s own `isErrorEnvelope` checks, not a new heuristic.

Two guards at the call site are load-bearing:
- It sits **after** the existing `policy.retryable && !isFailureStatus` branch, so every case
  `classify()` already recognizes keeps its exact current precedence and behavior.
- It is gated on **`&& !policy.terminal`**. `classify()` also resolves several policies from `http`
  **alone**, with no body needed — `unauthorized`(401) / `insufficientBalance`(402) /
  `forbidden`(403) are all `terminal:true` even with an empty body. Without that gate, a bare 402
  behind a WAF page would be "kept polling" for the full `ATLAS_IMAGE_TIMEOUT_MS` (180s default) and
  then ledgered as a **charged timeout**, instead of failing instantly as a billing outage. Found by
  adversarial review, not by the first draft.

`atlasVideoService`'s poll loop already handled this correctly (bare 5xx → `consecutiveErrors++` and
continue, up to `MAX_CONSECUTIVE_ERRORS`), so **only the image path changed** — the usual "one
pipeline got the fix, the other didn't", in the video path's favour for once.

**Operational note:** during a sustained CDN outage, renders now hold their concurrency slot until
timeout rather than failing fast. Correct for not throwing away paid work; reduces throughput while
the outage lasts.

Pinned by `scripts/verifyPollTransportRetry.js` (20 checks — a behavioral table, an end-to-end
`predicate + !policy.terminal` decision table incl. the bare-401/402/403 regression cases, and
structural checks that the real call site keeps the ordering and the terminal gate).

**Known adjacent gap, NOT fixed:** the poll `axios.get` has no `try/catch`, so a raw network
exception (`ECONNRESET`, DNS failure) still escapes `submitAndPoll` untagged, losing `.charged` /
`.policy`. `directImageRenderService` is safe (it passes `allowFallback: !atlasImage.isConfigured()`,
i.e. false in prod), but `openaiService`, `aiLayoutStudioService`, `personaAvatarService`,
`geminiImageService` and `aiImageReferenceService` all call with the default `allowFallback:true` and
would fall through to a direct-provider retry without the double-pay warning firing. Mirror
`atlasVideoService.pollPrediction`'s catch if this is picked up.

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

## 9) Claude 5 refuses the sampling knobs (live-verified 2026-08-10)

Atlas rejects `temperature` (≠ 1), `top_p` and `top_k` on the **Claude 5 family**
with a bare, field-less `HTTP 400 {"code":400,"msg":"bad request"}`. This is the
Anthropic extended-thinking constraint — with thinking on, sampling is not the
caller's to set — now enforced at the gateway.

Probed live against the production key:

| Request to `anthropic/claude-sonnet-5` | Result |
|---|---|
| bare (model + messages) | 200 |
| `max_tokens: 30768` | 200 |
| `response_format: {type:'json_object'}` | 200 |
| `stop`, `seed`, `frequency_penalty`, `presence_penalty` | 200 |
| `temperature: 1` | 200 |
| **`temperature: 0` / `0.45` / `0.7`** | **400** |
| **`top_p: 0.9`** | **400** |
| **`top_k: 40`** | **400** |

`anthropic/claude-opus-5` behaves identically. `claude-opus-4.8`,
`claude-sonnet-4.6`, `claude-sonnet-4.5-*` and every `openai/*` and `google/*`
slug still accept `temperature`.

### What it cost us

Role `director` is the only Anthropic entry in `atlasModelMap`, and
`aiCreativeDirectorService.directConceptsRound` sent `temperature: 0.45`. Every
concept-driven expansion therefore threw before creating a single static `Ad`
row — **static ad generation ran at a 100% failure rate**, while video was
untouched because every other role maps to `openai/*` or `google/*`:

```
conceptDriven[product=…]: failed (Atlas 400: {"code":400,"msg":"bad request"})
[campaignRun run_…] start — 4 ad(s) concurrency=veo:12(4) image:24(0)
                                                          ^ zero static ads
```

Last good Director round **2026-08-07 21:20 UTC**; first failure **2026-08-10
15:17 UTC**; **no deploy in between** — the running commit was `f3cd56c9` the
whole time. This was an Atlas-side change, not a regression of ours. Worth
remembering when triaging the next one: a 100%-failure onset with no deploy is
evidence *against* a code cause, and the deploy history is the fastest way to
prove it.

### The guard

`atlasModelMap.rejectsSamplingParams(atlasId)` + `stripSamplingParams(body)`.
Applied by all **three** transports that POST to `/v1/chat/completions`:

- `atlasLlmService.buildAtlasBody`
- `atlasLlmStreamService.buildStreamBody`
- `atlasTextService.buildTextBody` — posts its body inline rather than through
  the other two, so it carries the guard itself. Its `DEFAULT_MODEL` is a 4.x
  slug today, but `ATLAS_TEXT_MODEL_ID` exists to repoint it.

Params are **stripped, not pinned to 1**: 1 is already the model default, and an
explicit 1 would imply we still control a knob we do not. The practical
consequence is that `DIRECTOR_ROUND_TEMP = 0.45` is now **inert** on Claude 5 —
the Director samples at the default, so expect more run-to-run variety. To get a
tunable temperature back, repoint `director` at `anthropic/claude-sonnet-4.6`.

Covered by `scripts/verifyClaude5SamplingParams.js` (offline, revert-proven).
**Before changing the `director` model or adding a second Anthropic role,
re-probe** — check `B2`, which fails deliberately when a new Anthropic role
appears so its gateway behaviour gets confirmed rather than assumed.

## 10) Video: a terminal verdict arrives inside an HTTP 500 (live-verified 2026-08-10)

Atlas serves a **failed** video prediction as **HTTP 500 with a complete body**:

```
HTTP 500  { code: 500, message: "Generation failed: task processing failed
            (code: generation_failed)",
            data: { status: "failed", outputs: null, executionTime: 0,
                    timings: { inference: 0 } } }      ← no `price` key at all
```

`executionTime: 0` / `inference: 0` means the model accepted the job and died
before rendering a frame. Measured 2026-08-10: **6 failures across ~23 submits
in one day (~26%)**. The status code is **not** a reliable discriminator — the
same prediction was observed returning 200 earlier in its life and 500 later,
which is why some failures were caught instantly and others were not.

### Billing: `data.price` is the authority

| | `data.price` | |
|---|---|---|
| succeeded | `"0.75"` (full length) / `"0.08"` (short) — 5 of 5 | real charge |
| failed | **absent entirely** — 5 of 5 | no charge |

This matches the note already in `atlasImageService`: *"Atlas refunds the
reservation on a failed task and never bills a rejection."* A full video is
**$0.75**, so each of those failures was $0.75 of value lost, not spent.

### Three defects this exposed, all fixed

1. **No retry.** `predictionFailed` has always said `action:'retry'`,
   `maxAttempts:2`, `charged:false` — the video path never read it, so every
   provider hiccup became a dead ad.
2. **A terminal verdict was retried as a transport blip.** The poll's
   `axios.get` had no `validateStatus`, so a 500 threw into the generic 5xx
   branch: prediction `cec47abe…` was polled **12 times over 3 minutes** after
   it had already failed, then reported as "12 consecutive poll failures" —
   which reads like an Atlas outage and discards the classification, so a
   moderation block arriving as a 500 would never be named.
3. **Recovery could never settle them.** `peekPrediction` bailed on
   `res.status !== 200` *before* reading the body, so a confirmed-failed video
   came back `unknown` and its charge state never resolved. `unknown` must mean
   "we could not tell", not "we did not look".

### The money gate

`mayRetryAfterFailure()` allows a resubmit only when **all three** hold:
policy-retryable (excludes `moderationBlocked`, which would re-block), the
attempt is under the policy ceiling, and `confirmedCharge()` reports
**`charged === false`** read from `data.price`.

**`charged: null` (unknown) does NOT retry.** §4's rule is that a charge may
only be asserted from a confirmed price; the converse binds equally — a
NON-charge may only be asserted from a confirmed price, so unknown is treated
as charged.

⚠️ **The charge-point `recordFlatCost` MUST stamp `providerRequestId`.**
`finalizeFlatCost` keys on it to zero the unbilled attempt in place. Without the
stamp the update matches nothing, falls back to an insert, and the failed
attempt's estimate survives beside the retry's — **$1.50 booked for one
delivered video**. Missed in the first draft; caught by adversarial review.

**Residual risk, accepted:** if Atlas ever bills at accept and attaches `price`
to a failed body only later, a "no price" read would retry a real charge.
Nothing in the current data suggests that (5/5 failed rows never gained a price
on repeated reads), and closing it would need a delayed second peek or a refund
API. Revisit if the video bill ever exceeds delivered videos.

Pinned by `scripts/verifyVideoRetryOnUnbilledFailure.js` (23 checks, offline,
revert-proven on the gate, both poll paths, and the ledger key).
