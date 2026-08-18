// Atlas Cloud video generation — multi-model image-to-video service.
//
// Default model (today): Gemini Omni Flash image-to-video
// (google/gemini-omni-flash/image-to-video-developer). Accepts 1–7
// reference images, renders a fixed-duration clip (8s requested) at
// 720p/1080p/4K, ~$1.00 per 8s/720p render. The default prompt is a
// camera-only "Ken Burns" product-commercial spec — the model animates
// a virtual camera over the supplied photographs and must not alter
// the imagery. All text overlays (headline, CTA, quote, brand mark)
// are composited downstream by the canonical brand-script overlay
// (brandScriptExecutor + brandScripts/*.script.js).
//
// Model selection is per-ad via resolveVideoModel():
//   CatalogProduct.videoSettings.model → Brand.videoSettings.model
//   → ATLAS_VIDEO_MODEL env → BUILT_IN_DEFAULT_MODEL.
// Every slug must exist in MODEL_CAPS; unknown overrides warn and fall
// through to the next link. The previous default (Grok reference-to-
// video, ~$0.50/sec) stays in the registry as an override option.
//
// Atlas API: 3-step async flow
//   1. POST /model/generateVideo → { data: { id } }
//   2. GET  /model/prediction/{id} → poll until status=completed/succeeded
//   3. result.data.outputs[0] is a remote video URL — mirror to Cloudinary

const axios = require('axios');
const sharp = require('sharp');
// Shared failure taxonomy. The image path has always used this; the video
// poll below did not, so a moderation block read as a generic failure.
const { classify } = require('./atlasErrorPolicy');

const Media                     = require('../models/Media');
// Required for the charge-point veoPredictionId write in generateForAd. NOTE this file
// previously had no Ad import at all — `node --check` passes on an undefined identifier,
// so the missing require would only have surfaced as a runtime ReferenceError on the
// first real video generation, inside the very guard meant to protect spend.
const Ad                        = require('../models/Ad');
const Brand                     = require('../models/Brand');
const Campaign                  = require('../models/Campaign');
const CatalogProduct            = require('../models/CatalogProduct');
const LayoutInputArtifact       = require('../models/LayoutInputArtifact');
const { uploadBufferToCloudinary, deleteFromCloudinary } = require('./cloudinaryService');
const { recordFlatCost, finalizeFlatCost, reconcileCost } = require('./costTracker');
const referenceDefaultsService  = require('./referenceDefaultsService');
const { adStage, formatElapsed, noteRenderIssue } = require('./adStage');
const {
  buildVeoPrompt,
  aspectRatioForPlatformFormat,
  promptProfileFor,
  enforceRawByteCap,
  shouldUseLifestyleVideoPrompt,
  resolveLifestyleVideoRefCount,
  resolveLifestyleVideoRefPlan,
  lifestyleVideoGuidanceForIntent
} = require('./veoPromptBuilder');
const { loadCategoryChainForProduct } = require('./categoryChainService');

// INPUT_SCHEMA_VERSION drives the staleness check in
// refreshStaleLayoutInput() below (see that function's comment) — it is
// layoutInputService's own constant, imported rather than hardcoded so the
// two files can't drift on what "current schema" means.
const { buildLayoutInput, INPUT_SCHEMA_VERSION, resolveQuoteAssemblyOptions } = require('./layoutInputService');

// Generative reframe (video reference path only). Outpaint every ref to
// the target aspect so the product stays fully visible; store labeled
// results on Media.metadata.reframes for reuse (no re-spend). Master
// switch + model/resolution/skip-threshold are all env-tunable.
// Ported from ReachSocialLLMExpander runSafeZoneReframe (uncrop-v1 ladder).
const REFRAME_ENABLED = () => String(process.env.REFRAME_ENABLED ?? 'true').toLowerCase() !== 'false';
// Model tier: for THIS model ('google/nano-banana-2/edit') '-developer' is a BILLING
// variant, not a quality tier. Verified against the live Atlas catalogue
// (2026-07-24): it carries the same price.origin.base_price ($0.08) as plain /edit
// and differs only by a 50% discount factor; `profile` text is verbatim identical
// and the readmes are byte-identical. A genuine quality up-tier
// (nano-banana-pro/edit-ultra) gets its own higher list price. Distillation is the
// separate '-lite' axis, which composes independently. So here: half price, no
// evidenced fidelity cost.
//
// CORRECTION 2026-07-29 — this comment used to claim "the same pattern holds across
// all 12 '-developer' variants". That generalisation is FALSE. Diffed live for
// gemini-omni-flash/image-to-video: plain vs '-developer' differ in input shape
// (`image` single string vs `images[]` 1-7), duration (range 3-10 vs enum 4/6/8/10),
// resolution (720p ONLY vs 720p/1080p/4k), `thinking_level` (present vs ABSENT), and
// the pricing formula itself. Never assume the suffix is cosmetic — diff the two
// schemas for the specific slug. See docs/ATLAS.md §8.
const REFRAME_OUTPAINT_MODEL = () => process.env.REFRAME_OUTPAINT_MODEL || 'google/nano-banana-2/edit-developer';
// 1k is the schema default for both variants (enum 1k|2k|4k). Deliberately NOT
// 4k: no Atlas model exposes a mask or pixel-passthrough, so the whole canvas
// is re-synthesised every call — at 4k the decoder must commit to letterforms
// and logo strokes it can only guess, which is the artifact we were seeing.
// And the reframed reference is heavily downsampled by the video render anyway.
// Raise ATLAS_VIDEO_RESOLUTION, not this, for resolution viewers actually see.
// 4k per operator decision (2026-07-24) after reviewing 20 live generations
// side by side: at 4k the conservative 'reframe' prompt held product geometry
// better than 1k did, and the reframed reference is surfaced at full size in
// the generation inspector. The readme prices 4k at 2x, hence REFRAME_COST_USD
// below. Schema enum is 1k|2k|4k; 4k is the MAXIMUM offered — there is no higher
// tier to raise this to.
// UPDATED 2026-07-29: ATLAS_VIDEO_RESOLUTION is now 1080p (it is the same price as
// 720p — see config/defaults.env), so the downsample from a 4k reference is ~4x
// area rather than ~9x. That makes the operator's 4k choice MORE justified than
// when it was made, not less: more of the fidelity now survives into the finished
// ad instead of only into the inspector.
// Worth knowing if 4k is ever revisited: the readme prices 1k and 2k IDENTICALLY
// ($0.08), so 2k is a free upgrade over 1k, while 4k alone costs 2x ($0.16).
const REFRAME_RESOLUTION = () => process.env.REFRAME_RESOLUTION || '4k';
// 'reframe' (conservative, default) | 'uncrop' (scene-revealing, riskier on
// product imagery). See reframeOutpaintPrompt for the measured tradeoff.
const REFRAME_PROMPT_STYLE = () =>
  String(process.env.REFRAME_PROMPT_STYLE || 'reframe').trim().toLowerCase() === 'uncrop'
    ? 'uncrop' : 'reframe';
const REFRAME_SKIP_THRESHOLD = () => {
  const n = Number(process.env.REFRAME_SKIP_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.985;
};
// Per-image outpaint price for the cost ledger. $0.04 = the -developer tier at
// 1k. NOTE the model readme prices 1k $0.08 / 2k $0.12 / 4k $0.16 and notes
// "4K resolution costs 2x the standard rate" — whether that multiplier stacks
// on the discounted base is undocumented, so if you raise REFRAME_RESOLUTION
// raise this too or the ledger silently under-reports. Observability only.
const REFRAME_COST_USD = () => {
  const n = Number(process.env.REFRAME_COST_USD);
  return Number.isFinite(n) && n >= 0 ? n : 0.08;
};
// Accept outpaint output if its pixel ratio is within this relative
// tolerance of the target (ratio-only; pixel size is never compared).
const REFRAME_RATIO_TOLERANCE = () => {
  const n = Number(process.env.REFRAME_RATIO_TOLERANCE);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.05;
};
// Cap source / outpaint downloads so a runaway response can't OOM the worker.
const REFRAME_MAX_SOURCE_BYTES = () => {
  const n = Number(process.env.REFRAME_MAX_SOURCE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;
};
// Product-only shots NEVER go generative. Measured on real catalogue imagery
// (2026-07-24, 20 live generations): because no Atlas model exposes a mask, the
// whole canvas is re-synthesised, and on flat-lay/studio product shots that
// FABRICATES MERCHANDISE — a pair of shorts came back as full-length trousers,
// a waistband crop came back as an invented whole garment with the PELAGIC
// lockup reduced to illegible marks, and an embroidered espadrille came back
// with a different arrangement of fruits. That is product misrepresentation,
// not an aesthetic artifact. A deterministic c_pad scales-to-fit and never
// redraws a pixel, so it is both exact and free. Generative uncrop stays for
// on-model / lifestyle imagery, where it genuinely adds scene.
const REFRAME_PRODUCT_ONLY_PAD = () =>
  String(process.env.REFRAME_PRODUCT_ONLY_PAD ?? 'true').toLowerCase() !== 'false';
// Max per-channel stddev on an extended edge for it to count as a flat,
// uniform background we can match with a solid fill. Studio white measures
// 0.0; a lifestyle frame measured 27-39.
const REFRAME_BORDER_STD_MAX = () => {
  const n = Number(process.env.REFRAME_BORDER_STD_MAX);
  return Number.isFinite(n) && n > 0 ? n : 8;
};
// Ladder id persisted on Media.metadata.reframes[*]. BUMP THIS whenever the
// ladder changes in a way that should invalidate previously-derived assets.
//   uncrop-v1 → the first port (1k + uncrop prompt, no product-only routing)
//   reframe-v2 → current: 4k + conservative 'reframe' prompt, product-only $0
//                pad routing, output ratio validation, solid-preferred pad
const REFRAME_LADDER_VERSION = 'reframe-v2';
// Additive prompt hardening. When true, reframePromptForAspect appends
// SUBJECT IDENTITY, PHYSICAL ACCURACY, and (when the source has YOLO subjects
// touching a frame edge) SOURCE-EDGE PROTECTION clauses. When false — the
// DEFAULT — the base sentence is emitted byte-identically to pre-hardening.
// The revert is a single flag flip; the byte-identity contract is pinned by
// scripts/verifyReframePromptHardening.js. Never applied to the 'uncrop'
// style: that prompt is documented as verbatim-from-Expander and shouldn't
// be modified. See reframePromptForAspect + uncropPromptForAspect below.
const REFRAME_PROMPT_HARDENING = () =>
  String(process.env.REFRAME_PROMPT_HARDENING || 'false').toLowerCase() === 'true';
// Pixels-from-edge tolerance for "subject clipped at frame edge" — accounts
// for YOLO measurement variance. A bbox within this many px of any source
// edge is treated as edge-clipped, which triggers SOURCE-EDGE PROTECTION in
// the hardened prompt.
const REFRAME_EDGE_CLIP_THRESHOLD_PX = 4;
// Re-derive cached assets produced by an OLDER ladder on the next video
// generation, rather than serving them forever. A product whose videos were
// made under the old resize regime picks up the new one without any manual
// invalidation. Cost is bounded and mostly zero: stale 'exact' and 'pad-*'
// entries re-derive for $0, and product-only shots that used to outpaint now
// route to the free pad — only genuinely busy imagery re-spends. Set false to
// freeze existing assets in place.
const REFRAME_REDERIVE_STALE = () =>
  String(process.env.REFRAME_REDERIVE_STALE ?? 'true').toLowerCase() !== 'false';

// A cache entry is servable only when its url is usable AND it came from the
// CURRENT ladder. Returns { url, stale } so callers can both re-derive a stale
// asset and keep it as a last resort — a previously-good reframe beats a
// destructive crop if the re-derive fails.
function readReframeEntry(entry) {
  const url = entry?.url;
  if (typeof url !== 'string' || !url.trim()) return { url: null, stale: false };
  const stale = REFRAME_REDERIVE_STALE() && entry?.ladderVersion !== REFRAME_LADDER_VERSION;
  return { url: url.trim(), stale };
}
// Cross-process reframe claim lease. Web service and worker are separate Node
// processes, so the in-process Map + fresh DB re-read alone cannot stop both
// from POSTing generateImage for the same (media, aspect). Lease must outlive a
// realistic generation (ATLAS_TIMEOUT_MS defaults to 10 min) so a live flight
// is not stolen mid-poll; a crashed holder self-heals when the lease ages out.
// Floored at MAX_POLL_MS + 10 min rather than trusting the configured value
// alone. If the lease could expire while the holder is still legitimately
// polling, a second process would steal the claim and BOTH would bill — so the
// safe TTL is coupled to how long a generation is allowed to run. Raising
// ATLAS_TIMEOUT_MS therefore cannot silently reintroduce the double-charge this
// lease exists to prevent.
const REFRAME_CLAIM_TTL_MS = () => {
  const n = Number(process.env.REFRAME_CLAIM_TTL_MS);
  const configured = Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
  // Slack covers the work AFTER polling that still precedes persist: output
  // download with retries (~90s), Cloudinary uploads, pad build. Erring long is
  // the cheap direction — an over-long lease only makes peers crop for a while,
  // whereas an under-long one lets a second process bill for the same asset. It
  // also absorbs modest clock skew between processes, since `claim.at` is
  // written from each process's own wall clock rather than server time.
  return Math.max(configured, MAX_POLL_MS + 10 * 60 * 1000);
};

// How long a claim LOSER polls for the winner's reframe before degrading to
// the deterministic crop. waitForReframeUrl sleeps 1s,2s,…,Ns between reads,
// so attempts=26 ≈ 5m51s — sized to the measured worst-case cold reframe
// stage (5m19s, 3 serialized outpaints). Raised from the historical 3 (~6s)
// when the wizard prewarm landed: a Generate clicked while a prewarm outpaint
// is mid-flight used to lose the claim, give up after 6s, and silently ship a
// CROPPED reference where every other run got the generative one. Waiting for
// the winner is strictly better: the loser path NEVER submits, so a longer
// wait cannot create spend — worst case (winner died mid-flight) the
// claim-death early exit below fires and it crops in seconds.
//
// HARD COUPLING TO THE LEASE: waitForReframeUrl sleeps 1s,2s,…,Ns, so a run of
// n attempts spans sum(1..n) seconds. That total MUST stay under
// REFRAME_CLAIM_TTL_MS: once the lease ages out, a third process may steal the
// claim and submit — and a loser still sleeping past that point would return a
// url (or crop) chosen while a second billable flight was already away. The
// clamp below walks n down until the span fits, so raising the env var can
// never reopen the steal window (adversarial finding 5). n=26 → 351s, well
// under the ≥20 min TTL floor.
const REFRAME_CLAIM_WAIT_ATTEMPTS = () => {
  const n = Number(process.env.REFRAME_CLAIM_WAIT_ATTEMPTS);
  const requested = Number.isFinite(n) && n >= 1 ? Math.min(60, Math.floor(n)) : 26;
  const ttlSec = REFRAME_CLAIM_TTL_MS() / 1000;
  let capped = requested;
  while (capped > 1 && (capped * (capped + 1)) / 2 >= ttlSec) capped--;
  if (capped !== requested) {
    console.warn(
      `⚠️  REFRAME_CLAIM_WAIT_ATTEMPTS=${requested} would sleep past the claim lease ` +
      `(${Math.round(ttlSec)}s) — clamped to ${capped}`
    );
  }
  return capped;
};

// Titling is CANONICAL by default. The layoutInput derivation template is
// fixed to the canonical template ('ai_brand_led') UNLESS a brand or product
// overrides it in Title Studio via videoSettings.titleTemplate. The creative
// director no longer selects the template (concept.creative_style is ignored
// here) — titling is deterministic + operator-controlled, not concept-driven.
const CANONICAL_TITLE_TEMPLATE = 'ai_brand_led';
const VALID_TITLE_TEMPLATES = [
  'ai_brand_led', 'ai_ugc_led', 'ai_social_proof_led', 'ai_editorial', 'ai_promotional',
];

// Resolve the layoutInput template (most-specific wins):
//   CatalogProduct.videoSettings.titleTemplate → each Category leaf→root
//   videoSettings.titleTemplate → Brand.videoSettings.titleTemplate
//   → canonical default. Unknown values warn and fall through to canonical.
function resolveTitleTemplate({ brand = null, product = null, categories = [] } = {}) {
  const chain = [
    ['CatalogProduct.videoSettings.titleTemplate', product?.videoSettings?.titleTemplate],
    ...((Array.isArray(categories) ? categories : []).map((c) => [
      `Category[${c?.breadcrumbKey || c?._id}].videoSettings.titleTemplate`,
      c?.videoSettings?.titleTemplate
    ])),
    ['Brand.videoSettings.titleTemplate',          brand?.videoSettings?.titleTemplate],
  ];
  for (const [source, raw] of chain) {
    if (raw == null || raw === '') continue;
    if (VALID_TITLE_TEMPLATES.includes(raw)) return raw;
    console.warn(`⚠️  resolveTitleTemplate: invalid template '${raw}' from ${source} — falling through to ${CANONICAL_TITLE_TEMPLATE}`);
  }
  return CANONICAL_TITLE_TEMPLATE;
}

// Most-specific-wins prompt guidance (prepended into buildVeoPrompt as
// operatorPrompt). No concatenation — first non-empty string wins.
//   ad.videoPromptGuidance → product.videoSettings.promptGuidance
//   → each category leaf→root videoSettings.promptGuidance
//   → brand.videoSettings.promptGuidance → null
function resolvePromptGuidance({ ad = null, product = null, categories = [], brand = null }) {
  const pick = v => (typeof v === 'string' && v.trim()) ? v.trim() : null;
  return pick(ad?.videoPromptGuidance)
      || pick(product?.videoSettings?.promptGuidance)
      || (Array.isArray(categories) ? categories : []).map(c => pick(c?.videoSettings?.promptGuidance)).find(Boolean)
      || pick(brand?.videoSettings?.promptGuidance)
      || null;
}

/**
 * Map Ad.template → one of the four REAL static intents for lifestyle video
 * guidance selection. Mirrors directImageRenderService.intentForTemplate
 * without requiring that module (avoids a heavy import on the video path).
 * brand_led is only returned when STATIC_BRAND_LED_COPY is not 'false'.
 */
function lifestyleIntentFromTemplate(template) {
  const t = String(template || '');
  if (t === 'ai_social_proof_led') return 'social_proof_led';
  if (t === 'ai_promotional') return 'objection_resolved';
  if (t === 'ai_brand_led' && process.env.STATIC_BRAND_LED_COPY !== 'false') return 'brand_led';
  return 'product_first_lifestyle';
}

const BASE_URL     = process.env.ATLAS_BASE_URL || 'https://api.atlascloud.ai/api/v1';
const BUILT_IN_DEFAULT_MODEL = 'google/gemini-omni-flash/image-to-video-developer';
const POLL_INTERVAL = parseInt(process.env.ATLAS_POLL_INTERVAL_MS, 10) || 5000;
const MAX_POLL_MS   = parseInt(process.env.ATLAS_TIMEOUT_MS, 10)       || 600000; // 10 min

function apiKey() { return process.env.ATLAS_API_KEY; }
function enabled() {
  const flag = String(process.env.VIDEO_PROVIDER || '').toLowerCase();
  return flag === 'atlas' && !!apiKey();
}

// ── Per-model capability table ────────────────────────────────────────
//
// Drives request shape:
//   maxReferenceImages → caps how many reference images we pack into the request
//   paramShape         → which body fields Atlas expects for this provider
//   promptByteCap      → hard prompt-size limit enforced by veoPromptBuilder
//
// Every model emits motion-only video. Text is composited downstream
// by the brand-script overlay.
// `label` + `selectable: true` mark the entries offered in the operator
// UI (Brand settings card + regenerate dropdown — routes/brand.js
// exposes them as `videoModels`). Non-selectable entries stay registered
// so persisted videoSettings/env overrides keep resolving.
const MODEL_CAPS = {
  // Default. Duration is an ENUM (4|6|8|10), not a free range — the
  // request must send it explicitly so the output matches the 8s @ 24fps
  // assumption baked into the brand scripts. Aspect support is narrow
  // (16:9 / 9:16 only): every other canvas format routes to the Grok
  // aspect-fallback model (ASPECT_FALLBACK_MODEL below) via
  // resolveModelAndAspect, riding the existing reference pre-crop.
  // Prompt cap is 20,000 chars per Atlas's OpenAPI schema — enforced
  // here as bytes, the conservative interpretation. Pricing:
  // $0.20 base + $0.10/sec at 720p/1080p (8s ≈ $1.00); 4k base $1.00
  // (schema + readme re-verified 2026-07-21).
  // Atlas publishes no RPS figure for this slug (unlike Grok's 1 RPS) —
  // the rate-limit backoff below stays defensive until confirmed.
  'google/gemini-omni-flash/image-to-video-developer': {
    label: 'Google Omni Image-to-Video',
    selectable: true,
    minDuration: 4, maxDuration: 10,
    durationEnum: [4, 6, 8, 10],
    defaultDuration: 8,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    maxReferenceImages: 7,
    paramShape: 'gemini-omni',
    supportedAspectRatios: ['16:9', '9:16'],
    promptByteCap: 20000,
    // Atlas pricing: base fee by resolution + per-second rate.
    // 8s/720p ≈ $1.00, 8s/4k ≈ $1.80.
    pricing: { kind: 'base-plus-per-second', basePerResolution: { '720p': 0.20, '1080p': 0.20, '4k': 1.00 }, perSecond: 0.10 }
  },
  // Video-transform variant: REQUIRES a source video clip (≤30s asset,
  // ≤10s trimmed window) plus up to 5 style/character reference images
  // — schema live-verified 2026-07-21. Only usable for video-seeded ads;
  // resolveModelAndAspect degrades image-seeded ads to the i2v default.
  // Same 16:9/9:16-only aspect support as i2v, so the Grok aspect
  // fallback applies identically. Pricing: FIXED per generation
  // ($1.60 at 720p/1080p, $2.40 at 4k) — duration does not affect price.
  'google/gemini-omni-flash/reference-to-video-developer': {
    label: 'Google Omni Reference-to-Video (video-seeded)',
    selectable: true,
    minDuration: 4, maxDuration: 10,
    durationEnum: [4, 6, 8, 10],
    defaultDuration: 8,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    maxReferenceImages: 5,
    paramShape: 'gemini-omni-r2v',
    requiresVideoSeed: true,
    supportedAspectRatios: ['16:9', '9:16'],
    promptByteCap: 20000,
    pricing: { kind: 'flat-per-generation', perResolution: { '720p': 1.60, '1080p': 1.60, '4k': 2.40 } }
  },
  // Grok Imagine 1.5 — the operator-selectable Grok line AND the
  // automatic aspect-fallback target for formats the Omni models can't
  // render. SINGLE starting-frame image only (schema live-verified
  // 2026-07-21: `image_url` is one string — the multi-image stack of the
  // v1 reference-to-video line below does NOT carry over); the frame it
  // receives is the position-0 pre-cropped seed, so composition still
  // matches the canvas. Duration is a free 1–15s range, default 8.
  'xai/grok-imagine-video-v1.5/image-to-video': {
    label: 'Grok Imagine Video 1.5',
    selectable: true,
    minDuration: 1, maxDuration: 15,
    defaultDuration: 8,
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    maxReferenceImages: 1,
    paramShape: 'grok-i2v',
    supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    promptByteCap: 4096,
    // UNVERIFIED — neither the readme nor the catalog publishes a usable
    // rate for this slug (catalog base_price units are opaque). Carrying
    // the v1 line's $0.50/sec as a conservative upper bound until the
    // first live render's billing confirms; revisit alongside costTracker.
    pricing: { kind: 'per-second', perSecond: 0.50 }
  },
  // Previous default — kept registered (not selectable) so persisted
  // videoSettings / ATLAS_VIDEO_MODEL values keep resolving. Multi-image
  // reference stack (up to 7 refs).
  'xai/grok-imagine-video/reference-to-video': {
    label: 'Grok Imagine Video 1.0 (multi-reference)',
    minDuration: 1, maxDuration: 10,
    resolutions: ['480p', '720p'],
    maxReferenceImages: 7,
    paramShape: 'grok',
    supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    promptByteCap: 4096,
    // Flat per-second. 8s ≈ $4.00 — 4× the Gemini Omni default.
    pricing: { kind: 'per-second', perSecond: 0.50 }
  },
  'google/veo3.1/image-to-video': {
    label: 'Google Veo 3.1',
    minDuration: 5, maxDuration: 8,
    resolutions: ['720p', '1080p'],
    maxReferenceImages: 1,
    paramShape: 'veo',
    supportedAspectRatios: ['9:16', '16:9', '1:1'],
    promptByteCap: 4096,
    // UNVERIFIED tier-dependent rate ($0.05–0.20/sec advertised) —
    // conservative upper bound until confirmed against a real invoice.
    pricing: { kind: 'per-second', perSecond: 0.20 }
  }
};

// Where non-16:9/9:16 canvases go when an Omni model is selected: the
// references are already pre-cropped to the canvas aspect by the
// existing resize system (cropImageUrlForAspect), and Grok 1.5 renders
// most of those aspects natively — the pre-Omni behavior, per operator
// direction. Env-overridable; must name a MODEL_CAPS slug.
const ASPECT_FALLBACK_MODEL =
  process.env.ATLAS_VIDEO_FALLBACK_MODEL || 'xai/grok-imagine-video-v1.5/image-to-video';

function capsFor(model) {
  return MODEL_CAPS[model] || {
    minDuration: 5, maxDuration: 8, resolutions: ['720p'],
    maxReferenceImages: 1, paramShape: 'generic',
    supportedAspectRatios: ['1:1', '16:9', '9:16'],
    promptByteCap: 4096
    // no pricing — estimateRenderCostUsd returns null for unknown models
  };
}

// Best-effort USD estimate for one render, from the registry's pricing
// entry. Null when the model has no pricing data — callers should log
// 0-cost rather than guess. Not authoritative for billing (same caveat
// as costTracker.MODEL_RATES); refresh alongside Atlas price changes.
function estimateRenderCostUsd({ model, durationSec = 8, resolution = null } = {}) {
  const caps = capsFor(model);
  const p = caps.pricing;
  if (!p) return null;
  const dur = Number(durationSec) || 8;
  if (p.kind === 'per-second') {
    return Number((p.perSecond * dur).toFixed(4));
  }
  if (p.kind === 'base-plus-per-second') {
    const res  = resolution || caps.defaultResolution || '720p';
    const base = (p.basePerResolution && (p.basePerResolution[res] ?? p.basePerResolution['720p'])) || 0;
    return Number((base + p.perSecond * dur).toFixed(4));
  }
  if (p.kind === 'flat-per-generation') {
    const res = resolution || caps.defaultResolution || '720p';
    const flat = p.perResolution && (p.perResolution[res] ?? p.perResolution['720p']);
    return flat != null ? Number(flat.toFixed(4)) : null;
  }
  return null;
}

// ── Per-ad model resolution ───────────────────────────────────────────
//
// Most specific wins:
//   product per-canvas → product model → brand per-canvas → brand model
//   → ATLAS_VIDEO_MODEL env → built-in default.
//
// videoSettings shape (Brand + CatalogProduct, Mixed):
//   { model: '<MODEL_CAPS slug>' | null,
//     modelByCanvas: { '<platformFormat or aspectRatio>': '<slug>' } | null,
//     referenceImageCount: 1–7 | null }   // default 3 (primary + 2 alts)
//
// modelByCanvas keys are matched against the ad's platformFormat first
// (e.g. 'pmax_16_9'), then its canvas aspect ratio (e.g. '1:1', '9:16')
// — pass both via canvasKeys. Canvas overrides exist mainly because
// aspect support varies per model: the Gemini Omni default only renders
// 16:9/9:16, so e.g. a 1:1 feed canvas can be pinned to Grok (native
// 1:1) while vertical placements stay on the default.
//
// Every link must name a slug present in MODEL_CAPS; unknown slugs warn
// and fall through so a typo'd override degrades to the next level
// instead of silently running with generic caps. Both prepareStoryboard
// and generateForAd resolve from the same persisted docs, so the two
// stages of one ad always agree on the model.
function resolveVideoModel({ brand = null, product = null, categories = [], canvasKeys = [] } = {}) {
  const keys = (Array.isArray(canvasKeys) ? canvasKeys : [canvasKeys]).filter(Boolean);
  const links = [];
  const pushCanvasLinks = (label, settings) => {
    const map = settings?.modelByCanvas;
    if (!map || typeof map !== 'object') return;
    for (const k of keys) {
      if (map[k]) links.push([`${label}.modelByCanvas['${k}']`, map[k]]);
    }
  };
  pushCanvasLinks('CatalogProduct.videoSettings', product?.videoSettings);
  links.push(['CatalogProduct.videoSettings.model', product?.videoSettings?.model]);
  // Category tier between product and brand (leaf → root).
  for (const cat of (Array.isArray(categories) ? categories : [])) {
    const label = `Category[${cat?.breadcrumbKey || cat?._id}].videoSettings`;
    pushCanvasLinks(label, cat?.videoSettings);
    links.push([`${label}.model`, cat?.videoSettings?.model]);
  }
  pushCanvasLinks('Brand.videoSettings', brand?.videoSettings);
  links.push(['Brand.videoSettings.model', brand?.videoSettings?.model]);
  links.push(['ATLAS_VIDEO_MODEL env', process.env.ATLAS_VIDEO_MODEL]);

  for (const [source, slug] of links) {
    if (!slug) continue;
    if (MODEL_CAPS[slug]) return slug;
    console.warn(`⚠️  resolveVideoModel: unknown slug '${slug}' from ${source} — falling through`);
  }
  return BUILT_IN_DEFAULT_MODEL;
}

// Atlas/Grok rejects unsupported aspect_ratio variants outright (422),
// so we need to map any platform-format aspect we use (4:5, 5:4, 1.91:1)
// to the closest supported one for the model. We also pre-crop the
// reference images at the resolved aspect so the seed composition and
// the model output are consistent — preventing the "seed framed for 4:5,
// output rendered at 3:4" mismatch that would otherwise crop content.
//
// arParamForAspect used to live here too, building the ar_ param for an upload-time eager
// Cloudinary transform. Removed along with that transform (see the "Mirror to Cloudinary" comment
// further down): its premise — "the downstream brand-script composite requests this derivative
// URL" — was already false. The composite is gated off and the live cropper
// (services/videoCropUrl.js) emits an explicit c_scale/c_crop chain with no ar_ param at all.

function aspectToNumeric(ar) {
  const m = String(ar || '').match(/^([\d.]+)\s*:\s*([\d.]+)$/);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!w || !h) return null;
  return w / h;
}

function resolveAspectRatioForModel(requested, caps) {
  const supported = caps.supportedAspectRatios || [];
  if (!supported.length || supported.includes(requested)) return requested;
  const target = aspectToNumeric(requested);
  if (target == null) return supported[0];
  let best = supported[0];
  let bestDelta = Math.abs(aspectToNumeric(best) - target);
  for (const ar of supported.slice(1)) {
    const delta = Math.abs(aspectToNumeric(ar) - target);
    if (delta < bestDelta) { best = ar; bestDelta = delta; }
  }
  return best;
}

// Omni renders 16:9 or 9:16 only. Rather than fall back to Grok for
// every other aspect (4:5, 3:4, 2:3, 3:2, 4:3, 1.91:1 — which Grok either
// doesn't support natively either, or produces at higher cost), pick the
// FAMILY native: 9:16 for anything portrait, 16:9 for anything landscape.
// The downstream compositor's c_fill,g_auto (see videoCompositeService)
// crops the render aspect to the canvas aspect at composite time using
// saliency-aware gravity, so a 9:16 source in a 4:5 canvas gets a clean
// content-centered vertical crop with no letterboxing.
//
// SUPERSEDED BY THE BODY BELOW — kept because it explains the original
// reasoning, not because it is still true. It said square (1:1) has no clean
// family native (a 44%-of-frame crop drops too much subject) so Grok stays
// the fallback for it. The owner reversed that on 2026-07-29 after the
// face-safe base-plate crop landed: square now renders at Omni 9:16 by
// default and only falls back to Grok when SQUARE_VIA_OMNI_CROP=false.
// Non-numeric aspects (unrecognized string) do still fall through to null.
function omniFamilyNativeFor(requestedAspect) {
  const r = aspectToNumeric(requestedAspect);
  if (r == null) return null;
  if (Math.abs(r - 1) < 0.01) {
    // Square via Omni (owner decision 2026-07-29, flipped after side-testing). The "44% crop
    // drops too much subject" objection above predates the face-safe base-plate crop
    // (services/basePlateCropService.js): 1:1 now renders at Omni 9:16 and titling crops it
    // face-anchored — crown may be sacrificed up to FACE_TOP_CROP_ALLOWANCE_FRAC, forehead never
    // (faceSafeCrop.js). When detection finds no head, BasePlate's centre crop is the accepted
    // fallback. Env off-switch restores the Grok fallback for square only.
    return String(process.env.SQUARE_VIA_OMNI_CROP ?? 'true').toLowerCase() !== 'false'
      ? '9:16'
      : null;
  }
  return r < 1 ? '9:16' : '16:9';
}

// ── Model + aspect resolution (shared) ────────────────────────────────
//
// The single decision point both prepareStoryboard and generateForAd go
// through, so the two stages of one ad always agree. Order:
//   1. modelOverride (per-run, e.g. the regenerate dropdown) beats the
//      persisted chain; unknown slugs warn and fall through to it.
//   2. requiresVideoSeed degrade: Omni reference-to-video transforms an
//      existing clip — an image-seeded ad can't feed it, so it degrades
//      to the built-in i2v default rather than failing the render.
//   3. Omni family route: Omni models only render 16:9 / 9:16. For any
//      other portrait / landscape target we render at the FAMILY native
//      (9:16 or 16:9) and let the compositor's c_fill,g_auto crop to
//      the platform aspect. Cheaper + higher quality than Grok fallback,
//      and avoids the "no native 4:5" trap that used to two-hop through
//      Grok@3:4. Square (1:1) ALSO routes to Omni 9:16 by default — the
//      "still falls back to Grok" this comment used to claim was already
//      false when written: omniFamilyNativeFor returns '9:16' for 1:1
//      unless SQUARE_VIA_OMNI_CROP=false (see the note at that function,
//      owner decision 2026-07-29). Grok is now the square OPT-OUT only.
//   4. Grok fallback: square-only remainder (or explicitly-selected
//      non-Omni models whose caps.paramShape !== 'gemini-omni-*').
//   5. resolveAspectRatioForModel runs against the FINAL model's caps
//      (formats even Grok lacks — 5:4, 1.91:1 — keep the closest-aspect
//      render + Cloudinary eager re-crop path).
//
// Returns { model, caps, renderAspect, targetAspect, aspectRatio, fallback }.
//   renderAspect  — what the video model will emit (submit body, ref pre-crop)
//   targetAspect  — the platform aspect the ad ends up as (chrome + compositor)
//   aspectRatio   — backwards-compat alias for renderAspect
//   fallback      — null, or { from, to?, kind, reason } for logging / Ad doc.
//                   kind ∈ 'video-seed-degrade' | 'omni-family-crop' | 'grok-fallback'
function resolveModelAndAspect({
  brand = null, product = null, categories = [], canvasKeys = [],
  platformAspect, modelOverride = null, hasVideoSeed = false
} = {}) {
  let model;
  if (modelOverride && MODEL_CAPS[modelOverride]) {
    model = modelOverride;
  } else {
    if (modelOverride) {
      console.warn(`⚠️  resolveModelAndAspect: unknown modelOverride '${modelOverride}' — using the persisted chain`);
    }
    model = resolveVideoModel({ brand, product, categories, canvasKeys });
  }

  let fallback = null;
  let caps = capsFor(model);

  if (caps.requiresVideoSeed && !hasVideoSeed) {
    fallback = { from: model, kind: 'video-seed-degrade', reason: 'model requires a video seed; ad is image-seeded' };
    model = BUILT_IN_DEFAULT_MODEL;
    caps = capsFor(model);
  }

  const isOmni = String(caps.paramShape || '').startsWith('gemini-omni');
  if (isOmni && platformAspect && !(caps.supportedAspectRatios || []).includes(platformAspect)) {
    const familyNative = omniFamilyNativeFor(platformAspect);
    if (familyNative) {
      // Family route — keep Omni, render at its native, compositor crops.
      fallback = {
        from:   platformAspect,
        to:     familyNative,
        kind:   'omni-family-crop',
        reason: `render at Omni family native ${familyNative}; compositor c_fill,g_auto crops to ${platformAspect}`
      };
      return {
        model, caps,
        renderAspect: familyNative,
        targetAspect: platformAspect,
        aspectRatio:  familyNative,
        fallback
      };
    }
    // Square (or unrecognized) — no clean Omni family, fall back to Grok.
    fallback = { from: model, kind: 'grok-fallback', reason: `aspect ${platformAspect} unsupported (${(caps.supportedAspectRatios || []).join('/')})` };
    model = ASPECT_FALLBACK_MODEL;
    caps = capsFor(model);
  }

  const renderAspect = resolveAspectRatioForModel(platformAspect, caps);
  return {
    model, caps,
    renderAspect,
    targetAspect: platformAspect,
    aspectRatio:  renderAspect,
    fallback
  };
}

// Emit the resolver's outcome as ONE log line per ad instead of the old
// two-line "model fallback ... / remapped aspect ..." split. Keeps the
// resolver's dispatch decision in a single grep-able place.
function logResolution(adId, model, renderAspect, targetAspect, fallback) {
  if (!fallback && renderAspect === targetAspect) {
    console.log(`🎬 atlasVideo[ad=${adId}]: model=${model} aspect=${renderAspect}`);
    return;
  }
  const cropNote = renderAspect !== targetAspect ? ` → crop to ${targetAspect}` : '';
  const kind = fallback?.kind ? ` [${fallback.kind}]` : '';
  const reason = fallback?.reason ? ` — ${fallback.reason}` : '';
  console.log(`🎬 atlasVideo[ad=${adId}]: model=${model} render=${renderAspect}${cropNote}${kind}${reason}`);
}

// ── Cloudinary aspect cropping ────────────────────────────────────────
//
// Grok renders the aspect ratio implicit in the input images. So we
// pre-crop every reference to the target canvas aspect (saliency-aware
// via Cloudinary g_auto) sized to ≤720 on the short edge. This matches
// Atlas's 720p resolution cap and ensures the model doesn't have to
// resize/letterbox inputs.
function imageDimsForAspect(aspectRatio) {
  const a = String(aspectRatio || '').trim();
  switch (a) {
    case '9:16':   return { w: 720,  h: 1280 };
    case '16:9':   return { w: 1280, h: 720  };
    case '4:5':    return { w: 720,  h: 900  };
    case '5:4':    return { w: 900,  h: 720  };
    case '4:3':    return { w: 960,  h: 720  };
    case '3:4':    return { w: 720,  h: 960  };
    case '3:2':    return { w: 1080, h: 720  };
    case '2:3':    return { w: 720,  h: 1080 };
    case '1:1':    return { w: 720,  h: 720  };
    case '1.91:1': return { w: 1280, h: 670  };
    default:       return { w: 720,  h: 720  };
  }
}

// Cloudinary start-offset for video → poster / segment extraction.
// so_auto is nicer (Cloudinary picks the most eye-catching frame)
// but requires the AI Preview add-on — accounts without it get 400
// on every so_auto URL. so_2 is the safe fallback: 2 seconds in,
// past typical intro flashes and title cards on Reels/TikToks,
// without needing an add-on. Works on any Cloudinary plan.
const VIDEO_START_OFFSET = 'so_2';

// Build a Cloudinary 8-second segment URL for a video source. Grok
// is skipped for video-seeded video ads — Cloudinary extracts an
// 8-second clip starting at VIDEO_START_OFFSET (2s in). Aspect crop
// lands the clip at the target canvas aspect via c_fill; gravity
// defaults to center. (Saliency-aware g_auto requires the AI add-on
// for video transforms — accounts without it 400 on every g_auto
// video URL. Same pattern as the so_auto add-on gate.)
//
// Returns null when the URL isn't a Cloudinary /video/upload/ asset
// we can transform.
function buildVideoSegmentUrl(originalUrl, aspectRatio, durationSec = 8) {
  if (!originalUrl || typeof originalUrl !== 'string') return null;
  if (!originalUrl.includes('/video/upload/')) return null;
  const ar = String(aspectRatio || '').trim() || '1:1';
  const du = Math.max(1, Math.min(30, Number(durationSec) || 8));
  const chain = `${VIDEO_START_OFFSET},du_${du.toFixed(1)},c_fill,ar_${ar},q_auto:good`;
  return originalUrl.replace('/video/upload/', `/video/upload/${chain}/`);
}

// FLAG: image branch applies b_rgb:<websiteBackground> BEFORE c_fill so
// transparent product PNGs flatten onto the brand surface, then resize
// (flatten-then-resize). b_rgb is a no-op without an opaque output format —
// Cloudinary only bakes background when flattening to non-alpha or padding;
// f_jpg forces that flatten so b_rgb actually applies (URL extension can
// stay as-is; f_jpg wins). brandOrHex is Brand-like or raw color; defaults
// white. Video-source branch is unchanged (no alpha).
function cropImageUrlForAspect(originalUrl, aspectRatio, brandOrHex = null) {
  if (!originalUrl) return null;
  if (originalUrl.includes('/image/upload/')) {
    const { w, h } = imageDimsForAspect(aspectRatio);
    const { websiteBackgroundHex } = require('../utils/websiteBackground');
    const bg = websiteBackgroundHex(brandOrHex);
    return originalUrl.replace(
      '/image/upload/',
      `/image/upload/b_rgb:${bg},c_fill,w_${w},h_${h},g_auto,f_jpg,q_auto:good/`
    );
  }
  // Video source → extract a representative still at target aspect.
  // Uses VIDEO_START_OFFSET (2s in) rather than so_0 to skip typical
  // intro flashes / title cards on Reels / TikToks, and rather than
  // so_auto because so_auto needs the AI Preview add-on. Gravity
  // defaults to center — g_auto on video-source transforms also needs
  // the AI add-on. f_jpg forces JPEG output.
  if (originalUrl.includes('/video/upload/')) {
    const { w, h } = imageDimsForAspect(aspectRatio);
    return originalUrl
      .replace('/video/upload/', `/video/upload/${VIDEO_START_OFFSET},c_fill,w_${w},h_${h},f_jpg,q_auto:good/`)
      .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
  }
  // Non-Cloudinary URL: pass through untouched. Atlas will pull from
  // the origin host directly.
  return originalUrl;
}

// ── Reference image set ──────────────────────────────────────────────
//
// Deterministic retrieval order (identity list, then generative reframe):
//   Position 0:  seed media (the ad's main image — for product-seeded
//                ads this is the product hero)
//   Next:        catalog-product Media docs (Cloudinary mirrors), hero
//                first then alts (createdAt asc), deduped by Media _id
//   Fallback:    CatalogProduct.imageUrl / additionalImages (originals,
//                mediaDoc=null — no reframe cache) when stack < 2
//   Legacy:      pickProductOnlyUrl when still < 2
//
// Every identity is reframed to the target aspect via generative
// outpaint (or exact-fit skip / Cloudinary crop fallback). How many
// ship is selectable: default 3, configurable 1–7 via
// videoSettings.referenceImageCount (product → brand → env → default),
// always clamped to the model's maxReferenceImages. Cap BEFORE reframe
// so we never pay for images we won't send.
//
// Historical note: an earlier Grok-era iteration deliberately shipped a
// minimalist 2-reference stack (seed + one product_only anchor) because
// stacks of up to 7 refs diluted Grok's position-0 signal and
// occasionally blended shot-type variants into the video. That tradeoff
// is deliberately reversed here per operator direction — the Ken Burns
// prompt instructs the model to treat every reference as a locked
// photograph and never blend views. If multi-ref blending artifacts
// reappear, this stack size is the first knob to revisit.

// Return the fileUrl for the product-only reference — the first
// product_only-classified catalog Media, falling back to
// CatalogProduct.imageUrl when no catalog Media is classified. Returns
// null when neither is available; caller logs and degrades gracefully
// (seed-only stack).
function pickProductOnlyUrl(catalogMedias, product) {
  const first = (catalogMedias || []).find(
    m => m?.classification?.shotType === 'product_only' && m?.fileUrl
  );
  if (first?.fileUrl) return first.fileUrl;
  if (product?.imageUrl) return product.imageUrl;
  return null;
}

// Default ships 3 references: the primary image + the first two alt
// views. Operators can widen to the full 7-image stack (or narrow to
// seed-only) per brand/product via videoSettings.referenceImageCount.
const DEFAULT_REFERENCE_IMAGE_COUNT = 3;
const MAX_REFERENCE_IMAGE_COUNT     = 7;
// Ceiling that applies ONLY when the (now default-off) primary repeat is
// explicitly switched back on: 3 distinct + primary again = 4 total. Owner
// constraint from the high-ref-count hallucination finding — never raise past
// this while REPEAT_PRIMARY_REFERENCE is on. With the flag off (the default)
// this cap is not consulted; the stack is simply the first `effectiveMax`
// distinct views (3 by default).
const REPEAT_PRIMARY_TOTAL_CAP = 4;
// Hard ceiling on DISTINCT references when the primary repeat is OFF (the
// default since 2026-08-03). Owner-set to 5 on 2026-08-03. Without it that
// branch was unclamped up to MAX_REFERENCE_IMAGE_COUNT (7), which contradicted
// the owner's measured "too many images hallucinated" finding.
const MAX_DISTINCT_REFERENCES = 5;

/**
 * REPEAT_PRIMARY_REFERENCE env flag (DEFAULT FALSE since 2026-08-03).
 * When on, buildReferenceImages appends the primary (position 0) URL again
 * as the final reference so the model's closing beat returns to the front
 * view by construction.
 *
 * The owner rolled this off as the default: the repeated primary INCREASED
 * hallucination and the pre-repeat output was better. The capability is kept
 * (not deleted) so it stays available for a future A/B — an explicit truthy
 * value still turns it on. An unset or empty env yields FALSE.
 * `config/defaults.env` also sets it to false, so both the code default and
 * the dotenv-loaded production default agree. Offline harnesses flip this via
 * process.env.
 */
function isRepeatPrimaryReferenceEnabled() {
  const raw = process.env.REPEAT_PRIMARY_REFERENCE;
  if (raw == null || raw === '') return false;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

/**
 * Pure: append primary URL as final ref when there is room under the
 * total cap. Runs AFTER final-URL dedupe so a deliberate duplicate is kept
 * (seenFinal would otherwise drop a naive pre-dedupe push of the same URL).
 * Never evicts a real view — only appends when length < totalCap.
 *
 * @param {string[]} urls  Ordered reframed URLs (post-dedupe).
 * @param {{ enabled?: boolean, totalCap?: number }} opts
 * @returns {string[]}
 */
function appendPrimaryReferenceRepeat(urls, opts = {}) {
  const enabled = opts.enabled !== undefined ? !!opts.enabled : isRepeatPrimaryReferenceEnabled();
  const totalCap = Number.isFinite(opts.totalCap) ? opts.totalCap : REPEAT_PRIMARY_TOTAL_CAP;
  if (!enabled || !Array.isArray(urls) || urls.length === 0) return urls ? urls.slice() : [];
  if (urls.length >= totalCap) return urls.slice();
  const out = urls.slice();
  out.push(out[0]);
  return out;
}

/**
 * Pure: compute the reference-stack budget.
 *
 * repeatEnabled false — THE DEFAULT since 2026-08-03: no slot is reserved and
 * no duplicate is appended, so distinctCap === totalCap === min(effectiveMax,
 * modelMax). A default request (effectiveMax 3, modelMax 7) therefore ships
 * exactly the first three distinct images.
 *
 * repeatEnabled true — opt-in only: distinct views fill first, one slot is
 * left for the primary repeat when possible, and the total is capped at
 * REPEAT_PRIMARY_TOTAL_CAP (3 distinct + primary). A default-3 request is
 * bumped so the closing slot fits without dropping a view.
 *
 * @returns {{ distinctCap: number, totalCap: number }}
 */
function referenceStackBudget({ effectiveMax, modelMax, repeatEnabled }) {
  const model = Number.isFinite(modelMax) && modelMax >= 1 ? modelMax : MAX_REFERENCE_IMAGE_COUNT;
  const eff = Number.isFinite(effectiveMax) && effectiveMax >= 1 ? effectiveMax : DEFAULT_REFERENCE_IMAGE_COUNT;
  // DEFAULT PATH (flag off since 2026-08-03): no reserved slot, no duplicate —
  // just the first `eff` distinct views, so a default request ships 3 refs.
  //
  // MAX_DISTINCT_REFERENCES is a HARD CEILING and it is load-bearing. Turning the
  // primary repeat off removed the only clamp on this branch (the repeat path
  // caps at REPEAT_PRIMARY_TOTAL_CAP), so `videoSettings.referenceImageCount=7`
  // or an operator ordering 7 seeds in the wizard rail would have sent all seven
  // — against the owner's measured finding that "with too many images it was
  // hallucinating". Owner set the ceiling at FIVE on 2026-08-03. Found by
  // adversarial review of this very change, not by writing it.
  if (!repeatEnabled) {
    const cap = Math.min(eff, model, MAX_DISTINCT_REFERENCES);
    return { distinctCap: cap, totalCap: cap };
  }
  // OPT-IN PATH ONLY (flag explicitly on). Older owner constraint for that
  // path: 3 distinct + repeated primary = 4; more refs hallucinated.
  const totalCap = Math.min(
    Math.max(eff, Math.min(DEFAULT_REFERENCE_IMAGE_COUNT + 1, REPEAT_PRIMARY_TOTAL_CAP)),
    model,
    REPEAT_PRIMARY_TOTAL_CAP
  );
  // Leave one slot for the primary repeat when we have at least one ref
  // to repeat; never shrink distinct below 1.
  const distinctCap = Math.max(1, totalCap - 1);
  return { distinctCap, totalCap };
}

// Same most-specific-wins chain as resolveVideoModel. Non-numeric and
// out-of-range values warn and fall through; the result is additionally
// clamped to the resolved model's maxReferenceImages by
// buildReferenceImages.
function resolveReferenceImageCount({ brand = null, product = null } = {}) {
  const chain = [
    ['CatalogProduct.videoSettings.referenceImageCount', product?.videoSettings?.referenceImageCount],
    ['Brand.videoSettings.referenceImageCount',          brand?.videoSettings?.referenceImageCount],
    ['ATLAS_REFERENCE_IMAGE_COUNT env',                  process.env.ATLAS_REFERENCE_IMAGE_COUNT],
    // Policy floor, below the legacy env name so an existing
    // ATLAS_REFERENCE_IMAGE_COUNT deployment keeps winning and this is purely
    // additive. See services/referenceDefaultsService.js.
    ['VIDEO_DEFAULT_REFERENCE_COUNT env',               process.env.VIDEO_DEFAULT_REFERENCE_COUNT]
  ];
  for (const [source, raw] of chain) {
    if (raw == null || raw === '') continue;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= MAX_REFERENCE_IMAGE_COUNT) return n;
    console.warn(`⚠️  resolveReferenceImageCount: invalid value '${raw}' from ${source} (want 1–${MAX_REFERENCE_IMAGE_COUNT}) — falling through`);
  }
  return DEFAULT_REFERENCE_IMAGE_COUNT;
}

// Single billable image submit — NO retry (POST is charged). Sibling of
// submitGeneration; reuses pollPrediction for the shared prediction API.
async function submitImageGeneration({ model, images, prompt, aspectRatio, resolution }) {
  const res = await axios.post(
    `${BASE_URL}/model/generateImage`,
    { model, images, prompt, aspect_ratio: aspectRatio, resolution },
    {
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      timeout: 60000,
      // See the same guard on the video submit: axios's default maxRedirects of 5
      // re-sends the body on a 307/308, double-charging inside one call. This path
      // already refuses to retry; that promise is void unless redirects are off too.
      maxRedirects: 0
    }
  );
  const id = res.data?.data?.id;
  if (!id) {
    // The POST resolved, so Atlas accepted (and may well have charged) this
    // request — we just can't track it. Mark the error so the caller still
    // ledgers the spend instead of silently losing it.
    const err = new Error('atlasImage: submit response missing prediction id');
    err.charged = true;
    throw err;
  }
  return id;
}

// Re-fetch a completed prediction's output. Retrying THIS is safe and free —
// the generation is already paid for and the URL is idempotent. Only the POST
// is uncharged-once. Without a retry, one transient network blip after a good
// paid generation would discard it and cache the $0 pad permanently.
async function fetchOutpaintOutput(outUrl, attempts = 3) {
  if (isBlockedFetchHost(outUrl)) throw new Error('outpaint output URL host blocked');
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const dl = await axios.get(outUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxRedirects: 3,
        maxContentLength: REFRAME_MAX_SOURCE_BYTES(),
        maxBodyLength: REFRAME_MAX_SOURCE_BYTES()
      });
      return Buffer.from(dl.data);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.warn(`   ↻ reframe output fetch retry ${i + 1}/${attempts - 1} — ${err.message}`);
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// Two prompt styles, both measured on real catalogue imagery (2026-07-24, 20
// live generations). Selected by REFRAME_PROMPT_STYLE.
//
//   'reframe' (DEFAULT) — the conservative extension instruction. Constrains
//     visibility/framing. On flat-lay product shots it leaves the garment as
//     the garment.
//
//   'uncrop' — verbatim from ReachSocialLLMExpander media.ts:uncropPrompt.
//     Constrains geometry/identity/pose and is far better at revealing SCENE on
//     cropped lifestyle photos (it recovered a full model + garden from a
//     thigh-level crop). But its "continue the subject (reveal more of the
//     body/product/clothing)" clause is DANGEROUS on product-only imagery: it
//     turned a pair of shorts into full-length trousers and expanded a
//     waistband crop into an invented whole garment. Product-only shots are
//     routed to the $0 pad before this is reached, so the clause only applies
//     to on-model/lifestyle frames — but the risk is why it isn't the default.
// Detect whether any YOLO subject bbox sits within REFRAME_EDGE_CLIP_THRESHOLD_PX
// of the source frame edges. Pure — no I/O. The b13 fabrication class
// (nano-banana inventing anatomy above heads that were cut off at y=0, or
// below feet that ended at y=2007 on a 2018-tall source) is exactly the case
// this flags: when the model is asked to extend a frame whose subjects were
// already partially cropped, "continue the scene" becomes "invent the missing
// body," and Gemini-family editors reliably fabricate.
function hasEdgeClippedSubjects(media) {
  const w = Number(media?.width);
  const h = Number(media?.height);
  if (!(w > 0 && h > 0)) return false;
  const refined = Array.isArray(media?.refinedProducts) ? media.refinedProducts : [];
  const T = REFRAME_EDGE_CLIP_THRESHOLD_PX;
  return refined.some((r) => (
    Number.isFinite(r?.x1) && Number.isFinite(r?.y1) &&
    Number.isFinite(r?.x2) && Number.isFinite(r?.y2) &&
    (r.x1 <= T || r.y1 <= T || r.x2 >= w - T || r.y2 >= h - T)
  ));
}

// The `reframe` prompt has two shapes. Both start with the same base sentence
// so REFRAME_PROMPT_HARDENING=false is BYTE-IDENTICAL to the pre-hardening
// output. Hardening only ever APPENDS clauses; it never rewrites the base.
// This preserves the "measured artifact-free" ladder (uncrop-v1 → reframe-v2)
// as the fallback when hardening is reverted, and lets the byte-identity
// verifier prove flag-off produces no drift.
function reframePromptForAspect(aspectRatio, ctx = {}) {
  const [wr, hr] = String(aspectRatio).split(':').map(Number);
  const orient = wr > hr ? 'horizontal (landscape)' : wr < hr ? 'vertical (portrait)' : 'square';
  // BASE — byte-identical to the pre-hardening prompt. Do not edit this
  // string without bumping REFRAME_LADDER_VERSION and re-measuring on real
  // catalogue imagery. Same rule the static prompt hardening carries per
  // CLAUDE.md §2's flag-off byte-identity contract.
  const base = `Reframe this image into a ${orient} ${wr}:${hr} composition. Keep the ENTIRE subject and all text fully visible and uncropped. Naturally extend the existing background, colors and scene to fill the new areas — do not add new objects, people or text. Seamless, photorealistic, matching the original style, lighting and palette.`;

  if (!REFRAME_PROMPT_HARDENING()) return base;

  const clauses = [base];

  // (a) SUBJECT IDENTITY — only when we have a product name to plug in.
  // ctx.productTitle typically comes from Media.metadata.productTitle
  // (materializeImage in catalogProductDetectService.js:606). When absent
  // (rare: legacy media, non-catalog sources), we omit rather than emit a
  // useless "The primary subject is null" line.
  const title = typeof ctx.productTitle === 'string' && ctx.productTitle.trim()
    ? ctx.productTitle.trim() : null;
  if (title) {
    clauses.push(
      `SUBJECT IDENTITY: The primary subject is "${title}". Preserve its shape, colors, materials, stitching, label text, and every logo or badge exactly as they appear in the source. Do NOT invent alternate garment styles, invent product text, or add branding that isn't in the source.`
    );
  }

  // (b) PHYSICAL ACCURACY — ported from veoPromptBuilder's canonical clause.
  // Applies to any on-model shot; unconditional under hardening.
  clauses.push(
    `PHYSICAL ACCURACY: If people are visible, keep hands anatomically correct (5 fingers per hand), keep faces symmetric with paired eyes, and preserve body proportions. Do NOT invent extra digits, mismatched eyes, warped features, or impossible poses. Do NOT alter the identity, hair, skin tone, or facial features of any person from the source.`
  );

  // (c) SOURCE-EDGE PROTECTION — the specific hallucination class we
  // diagnosed on b13: subjects clipped by the source frame at y=0 (r3) and
  // y=2007 on a 2018-tall source (r4). Extending vertically into new area,
  // nano-banana invented what "should be" above the head / below the feet.
  // This clause tells the model NOT to extend the subject — only the
  // background — in the newly-created regions.
  if (ctx.hasEdgeClippedSubjects) {
    clauses.push(
      `SOURCE-EDGE PROTECTION: The source image already contains subjects clipped by the frame edges. Do NOT invent unseen anatomy above, below, or beside the visible portions of these subjects. Extend the background and setting only into the newly-created regions; leave the subjects' cropped boundaries where the source ends.`
    );
  }

  return clauses.join(' ');
}

// Assemble the ctx object for the hardened prompt from a Media doc.
// Extracted so both the reframe worker and the verifier can call it —
// no reason to duplicate the "which fields do we read" contract.
function reframePromptContext(media) {
  return {
    productTitle: media?.metadata?.productTitle || null,
    hasEdgeClippedSubjects: hasEdgeClippedSubjects(media)
  };
}

function reframeOutpaintPrompt(aspectRatio, ctx = {}) {
  // SPLIT-STAGE (PMax 16:9, 2026-08-12). A subject side means the caller has
  // pre-composed the source onto one half of the target canvas and wants the
  // model to fill the OTHER half. That is a different instruction from "grow
  // this image symmetrically", so it gets its own prompt rather than a flag
  // inside the existing one — and it deliberately ignores REFRAME_PROMPT_STYLE,
  // because the 'uncrop' style's "continue the subject (reveal more of the
  // body/product/clothing)" clause is the documented fabrication mechanism and
  // is exactly wrong when the empty half must stay empty.
  if (ctx.subjectSide === 'east' || ctx.subjectSide === 'west') {
    return reframePromptForSplitAspect(aspectRatio, ctx.subjectSide, ctx);
  }
  return REFRAME_PROMPT_STYLE() === 'uncrop'
    ? uncropPromptForAspect(aspectRatio)
    : reframePromptForAspect(aspectRatio, ctx);
}

/**
 * Directional outfill prompt for the split-stage unit.
 *
 * THE MODEL HAS NO MASK. `submitImageGeneration` posts
 * { model, images, prompt, aspect_ratio, resolution } — there is no region or
 * mask parameter anywhere in the Atlas image API. So direction is steered by
 * exactly two levers, and this is only one of them: the caller ALSO pre-composes
 * the subject onto its half of the canvas, so the model is handed an already
 * asymmetric frame whose empty side is the obvious thing to fill. Prompt alone
 * is a request; prompt + pre-composed canvas is the standard maskless steer.
 *
 * WHY "CALM" AND NEVER "ROOM FOR TEXT". The same billable submit carries a hard
 * noText directive, and any wording that invites the model to think about copy
 * is a way to get letterforms rendered into the pixels — which fails review and
 * wastes the master. The extended region's purpose is described purely in
 * visual terms; the fact that copy lands there later is the renderer's business,
 * not the model's.
 *
 * Hardening clauses are shared verbatim with reframePromptForAspect so the
 * person guards (anatomy, source-edge) and SUBJECT IDENTITY protections cannot
 * drift apart between the two prompts.
 */
function reframePromptForSplitAspect(aspectRatio, subjectSide, ctx = {}) {
  const [wr, hr] = String(aspectRatio).split(':').map(Number);
  // subjectSide is where the SUBJECT sits; the model extends the opposite side.
  const keepSide   = subjectSide === 'east' ? 'right' : 'left';
  const extendSide = subjectSide === 'east' ? 'left'  : 'right';

  const clauses = [
    `Extend this image into a horizontal ${wr}:${hr} composition. ` +
    `The subject is already positioned on the ${keepSide} side of the frame: keep it EXACTLY where it is, ` +
    `at its current size and scale, fully visible and uncropped. Do NOT move, re-centre, rescale or duplicate it. ` +
    `Build out ONLY the ${extendSide} side of the frame by naturally continuing the existing background, ` +
    `surface, lighting and palette. The ${extendSide} side must stay calm, open and uncluttered — ` +
    `plain continued background with no new objects, props, people, patterns or text of any kind. ` +
    `Seamless and photorealistic, with no visible seam, border, band or colour step where the original ` +
    `image ends and the extension begins.`
  ];

  // Shared hardening — same conditions and same wording as reframePromptForAspect.
  const title = typeof ctx.productTitle === 'string' && ctx.productTitle.trim()
    ? ctx.productTitle.trim() : null;
  if (title) {
    clauses.push(
      `SUBJECT IDENTITY: The primary subject is "${title}". Preserve its shape, colors, materials, stitching, label text, and every logo or badge exactly as they appear in the source. Do NOT invent alternate garment styles, invent product text, or add branding that isn't in the source.`
    );
  }
  clauses.push(
    `PHYSICAL ACCURACY: If people are visible, keep hands anatomically correct (5 fingers per hand), keep faces symmetric with paired eyes, and preserve body proportions. Do NOT invent extra digits, mismatched eyes, warped features, or impossible poses. Do NOT alter the identity, hair, skin tone, or facial features of any person from the source.`
  );
  // Unconditional here, unlike reframePromptForAspect where it is gated on
  // hasEdgeClippedSubjects. On a split the subject is deliberately pushed hard
  // against one edge, so it is ALWAYS edge-adjacent by construction — the very
  // condition that makes a model invent unseen anatomy sideways.
  clauses.push(
    `SOURCE-EDGE PROTECTION: Do NOT invent unseen anatomy, garment or product beyond the visible portions of the subject. Extend the background and setting only into the newly-created region; leave the subject's boundaries exactly where the source ends.`
  );

  return clauses.join(' ');
}

// Verbatim uncrop prompt from ReachSocialLLMExpander media.ts:uncropPrompt.
// Character-for-character; do not "improve" — that prompt is the artifact-free path.
function uncropPromptForAspect(aspectRatio) {
  const [wr, hr] = String(aspectRatio).split(':').map(Number);
  const orient = wr > hr ? 'horizontal (landscape)' : wr < hr ? 'vertical (portrait)' : 'square';
  return (
    `Expand and uncrop this image into a ${orient} ${wr}:${hr} composition. Naturally EXTEND the scene to ` +
    `fill the frame — continue the subject (reveal more of the body/product/clothing) and add clean ` +
    `headroom above plus more of the same plain background and floor. Keep the existing subject unchanged, ` +
    `sharp, uncropped and centered — do NOT distort, shrink, recolor or alter it, and do NOT change its ` +
    `pose or orientation. Seamless and photorealistic, matching the original lighting, color and plain ` +
    `background. Add no text, logos or new objects.`
  );
}

// Block server-side fetches of loopback / link-local / RFC1918 hosts. The
// reference implementation guards this (media.ts isBlockedIngestHost) and we
// now fetch sourceUrl ourselves, so the same guard applies here. sourceUrl is
// normally our own Cloudinary mirror, but CatalogProduct image URLs come from
// tenant feeds/scrapes, so treat them as untrusted. Not airtight against a
// hostile redirect chain (axios can't validate per-hop) — maxRedirects is
// clamped below to bound that. A shared, redirect-aware fetch helper for every
// ingest path in the repo is the proper fix; see docs/PIPELINES.md.
function isBlockedFetchHost(rawUrl) {
  let host;
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) return true;
    host = u.hostname.toLowerCase();
  } catch { return true; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  // IPv6 literals arrive from URL bracket-stripped and lowercased.
  const v6 = host.replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;             // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;             // fe80::/10 link-local
  // IPv4-mapped IPv6 (::ffff:7f00:1 or ::ffff:127.0.0.1) — recurse on the tail.
  const mapped = v6.match(/^::ffff:(.+)$/);
  if (mapped) {
    const t = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return isBlockedFetchHost(`http://${t}`);
    const hx = t.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hx) {
      const n = (parseInt(hx[1], 16) << 16) | parseInt(hx[2], 16);
      const dotted = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      return isBlockedFetchHost(`http://${dotted}`);
    }
    return true;
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;              // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// Prepare the source the Atlas edit model will fetch. Never throws; returns
// { buffer, url, mirrored } or null.
//
// Re-encode is CONDITIONAL, and that's deliberate. The only thing we actually
// need to fix is (a) alpha — a transparent product PNG gets matted by the model
// (often onto black) and then "extended", a direct artifact source — and (b)
// EXIF orientation. Everything else is better left alone: a JPEG round-trip
// costs a lossy generation and, at default settings, 4:2:0 chroma subsampling,
// which halves colour resolution exactly where coloured logo and label edges
// live. The reference implementation re-encodes unconditionally and pays that
// cost on every opaque photo; we skip it and forward the pristine original.
//
// When no re-encode is needed we also skip the Cloudinary mirror entirely and
// hand Atlas the original URL — no upload, no orphan to clean up.
async function normalizeReframeSource(sourceUrl) {
  try {
    if (isBlockedFetchHost(sourceUrl)) {
      console.warn('⚠️  normalizeReframeSource: blocked host — refusing to fetch');
      return null;
    }
    const res = await axios.get(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxRedirects: 3,
      maxContentLength: REFRAME_MAX_SOURCE_BYTES(),
      maxBodyLength: REFRAME_MAX_SOURCE_BYTES()
    });
    const raw = Buffer.from(res.data);
    // Content-type is ADVISORY only: some CDNs serve images as
    // application/octet-stream, and rejecting those would silently downgrade a
    // good image to a crop. sharp is the real gate — it throws on non-images
    // (including HTML error pages), which the catch below turns into null.
    const ct = String(res.headers['content-type'] || '').toLowerCase();
    if (ct && !ct.startsWith('image/')) {
      console.warn(`⚠️  normalizeReframeSource: non-image content-type "${ct}" — letting sharp decide`);
    }

    const md = await sharp(raw).metadata();
    const hasAlpha  = !!md.hasAlpha;
    // orientation > 1 means EXIF asks for a rotation/flip. sharp does NOT apply
    // it by default AND strips the tag on output, so leaving it would hand the
    // model — and bake into the ad — a sideways image. ffmpeg applied the
    // display matrix automatically, so the reference never needed this.
    const needsOrient = Number(md.orientation || 1) > 1;

    // Atlas refuses a non-https reference URL ("remote media URL must use
    // https"), and that refusal surfaces as a 500 AFTER the POST is charged —
    // so an http source would be billed and then thrown away. Mirroring costs
    // one Cloudinary upload and always yields https. Cheap insurance: this is
    // NOT confirmed to be the cause of the 2026-08-11 outpaint failures (the
    // prod key could not be reproduced against), it just removes one whole
    // class of them.
    if (!hasAlpha && !needsOrient && /^https:\/\//i.test(sourceUrl)) {
      return { buffer: raw, url: sourceUrl, mirrored: false };
    }

    // chromaSubsampling 4:4:4 keeps full colour resolution — without it sharp
    // defaults to 4:2:0 and smears exactly the coloured label/logo edges the
    // model is being asked to preserve.
    const buffer = await sharp(raw)
      .rotate()
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const up = await uploadBufferToCloudinary(buffer, { folder: 'liquidretail/reframes/src' });
    const url = up.secure_url || up.url;
    if (!url) return null;
    console.log(`   🖼  reframe source re-encoded (alpha=${hasAlpha} orient=${md.orientation || 1})`);
    return { buffer, url, mirrored: true };
  } catch (err) {
    console.warn(`⚠️  normalizeReframeSource: ${err.message}`);
    return null;
  }
}

// $0 deterministic pad: fit the WHOLE source inside a W×H frame (letterbox,
// nothing cropped/lost) over a blurred cover of itself. Port of media.ts:padToRatio
// (gblur=sigma=24). Never throws; returns JPEG Buffer or null.
async function padToRatioBuffer(srcBuffer, W, H) {
  try {
    const bg = await sharp(srcBuffer).resize(W, H, { fit: 'cover' }).blur(24).toBuffer();
    const fg = await sharp(srcBuffer).resize(W, H, { fit: 'inside' }).toBuffer();
    return await sharp(bg).composite([{ input: fg, gravity: 'center' }]).jpeg({ quality: 88 }).toBuffer();
  } catch (err) {
    console.warn(`⚠️  padToRatioBuffer: ${err.message}`);
    return null;
  }
}

/**
 * Pad-vs-crop for a VIDEO SEED reference. Pure; the single source of truth for
 * both pad sites in reframeReferenceForAspect. Covered by
 * scripts/verifyNoVisibleSeedPad.js.
 *
 * WHY A SEED IS DIFFERENT FROM A DELIVERABLE (owner, 2026-08-12). This image is
 * reference input to an image-to-video model. The model reproduces what it is
 * shown, so any band in the seed is BAKED INTO THE VIDEO — downstream c_crop
 * cannot remove content that is already inside the pixels. A visible band here
 * is a permanent defect in a billable render, not a cosmetic fallback.
 *
 * So the ONLY acceptable pad is a solid fill sampled from a genuinely flat
 * border: it is indistinguishable from the backdrop, there is no band to see,
 * and the whole subject stays visible. Everything else — blurred cover of the
 * frame, Cloudinary's b_auto gradient — is a visible smear and must crop
 * instead. A crop loses framing at the edges, which the owner has explicitly
 * called the better trade.
 */
function seedPadDecision(fill) {
  const uniform = !!fill?.uniform;
  const hex = fill?.hex || null;
  // A "uniform" verdict with no sampled colour cannot produce a matching fill,
  // so it is not an invisible pad either — crop rather than guess a colour.
  if (uniform && hex) return { action: 'pad-solid', hex };
  return { action: 'crop', reason: uniform ? 'no-sampled-hex' : 'border-not-flat' };
}

// Is this Media a flat-lay / studio product shot? LLM-judged by
// subjectTextService, so a HINT — but the cost of a false positive is only a
// letterboxed pad (product preserved exactly), while a false negative risks
// the model inventing merchandise. Asymmetric, so we lean on it.
function isProductOnlyShot(media) {
  return media?.classification?.shotType === 'product_only';
}

// Which edges does padding to `target` actually add? Only those need to be a
// uniform background for a solid fill to be invisible. A 1:1 source going to
// 9:16 gains height, so only top+bottom matter — checking left/right too would
// needlessly reject images whose sides are busy but whose top/bottom are clean.
function extendedEdgesFor(srcRatio, targetRatio) {
  return srcRatio > targetRatio ? ['top', 'bottom'] : ['left', 'right'];
}

// Sample the edges we're about to extend and report whether they're a single
// flat colour we can match exactly. Works on a tiny derivative (a few KB), so
// this is cheap enough to run before every product-only pad.
// Never throws; returns { uniform, hex } with hex always usable as a fallback.
async function detectBorderFill(buffer, srcRatio, targetRatio) {
  const FALLBACK = { uniform: false, hex: null };
  try {
    const N = 64;
    const { data, info } = await sharp(buffer)
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize(N, N, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    if (ch < 3) return FALLBACK;
    const band = Math.max(2, Math.round(N * 0.06));
    const px = (x, y) => {
      const i = (y * N + x) * ch;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const region = (x0, y0, x1, y1) => {
      const out = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(px(x, y));
      return out;
    };
    const REGIONS = {
      top:    () => region(0, 0, N, band),
      bottom: () => region(0, N - band, N, N),
      left:   () => region(0, 0, band, N),
      right:  () => region(N - band, 0, N, N)
    };
    const stats = [];
    for (const edge of extendedEdgesFor(srcRatio, targetRatio)) {
      const pxs = REGIONS[edge]();
      if (!pxs.length) return FALLBACK;
      const mean = [0, 1, 2].map(c => pxs.reduce((s, p) => s + p[c], 0) / pxs.length);
      const std = Math.max(...[0, 1, 2].map(c =>
        Math.sqrt(pxs.reduce((s, p) => s + (p[c] - mean[c]) ** 2, 0) / pxs.length)));
      stats.push({ mean, std });
    }
    const maxStd = Math.max(...stats.map(s => s.std));
    const mean = [0, 1, 2].map(c =>
      Math.round(stats.reduce((s, st) => s + st.mean[c], 0) / stats.length));
    // Edges must each be flat AND agree with each other, or a gradient reads as
    // "uniform" per-edge and the solid fill shows a seam.
    const spread = Math.max(...[0, 1, 2].map(c =>
      Math.max(...stats.map(s => s.mean[c])) - Math.min(...stats.map(s => s.mean[c]))));
    const hex = mean.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
    return { uniform: maxStd <= REFRAME_BORDER_STD_MAX() && spread <= 12, hex };
  } catch (err) {
    console.warn(`⚠️  detectBorderFill: ${err.message}`);
    return FALLBACK;
  }
}

// Pure Cloudinary pad — no upload, no bytes, no spend. c_pad scales-to-fit and
// pads, so the product is delivered untouched. b_rgb when we sampled a flat
// background; otherwise b_auto:predominant_gradient, which Cloudinary derives
// from the border server-side and is the ALWAYS-AVAILABLE soft option on this
// plan (b_blurred needs an add-on we don't have — see
// services/extendedCropsService.js:127-129). Returns null for non-Cloudinary
// sources, which the caller handles by padding the bytes locally instead.
function cloudinaryPadUrl(sourceUrl, aspectRatio, hex) {
  if (!sourceUrl || !sourceUrl.includes('/image/upload/')) return null;
  const { w, h } = imageDimsForAspect(aspectRatio);
  const bg = hex ? `b_rgb:${hex}` : 'b_auto:predominant_gradient';
  return sourceUrl.replace(
    '/image/upload/',
    `/image/upload/${bg},c_pad,w_${w},h_${h},f_jpg,q_auto:good/`
  );
}

// Local solid-colour letterbox, for product-only sources that aren't on
// Cloudinary and so can't be transformed by URL. Same geometry as
// padToRatioBuffer but a flat fill instead of a blurred cover — on a uniform
// studio background the blurred version smears product colour into the bands.
// GRAVITY (added 2026-08-12 for the PMax 16:9 split-stage unit). Defaults to
// 'center', which is byte-for-byte the previous behaviour — every existing
// caller is unchanged.
//
// 'east' / 'west' anchor the subject to one side and leave the opposite side as
// flat fill. That asymmetry is the whole point of the split unit: the empty side
// becomes the region the outfill model extends into, and later the region ad
// copy is composited onto. It is ALSO why this must stay a solid sampled fill —
// a half-frame of blurred smear would be the most visible band this codebase has
// ever shipped (see seedPadDecision above).
async function padSolidBuffer(srcBuffer, W, H, hex, gravity = 'center') {
  try {
    const fg = await sharp(srcBuffer).rotate().resize(W, H, { fit: 'inside' }).toBuffer();
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return await sharp({ create: { width: W, height: H, channels: 3, background: { r, g, b } } })
      .composite([{ input: fg, gravity }])
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (err) {
    console.warn(`⚠️  padSolidBuffer: ${err.message}`);
    return null;
  }
}

// Fetch a small derivative purely to sample the border. A few KB against a
// $0.04 decision. Falls back to the full source for non-Cloudinary URLs.
async function fetchBorderSample(sourceUrl) {
  const small = sourceUrl.includes('/image/upload/')
    ? sourceUrl.replace('/image/upload/', '/image/upload/w_120,c_limit,f_jpg,q_auto:eco/')
    : sourceUrl;
  if (isBlockedFetchHost(small)) return null;
  try {
    const res = await axios.get(small, {
      responseType: 'arraybuffer', timeout: 15000, maxRedirects: 3,
      maxContentLength: REFRAME_MAX_SOURCE_BYTES(), maxBodyLength: REFRAME_MAX_SOURCE_BYTES()
    });
    return Buffer.from(res.data);
  } catch (err) {
    console.warn(`⚠️  fetchBorderSample: ${err.message}`);
    return null;
  }
}

// Confirm buffer decodes and its aspect ratio ≈ target (ratio only, not pixel size).
// Port of media.ts:decodeAndRatioOk. Never throws; returns false on any error.
async function outputRatioOk(buffer, wr, hr) {
  try {
    const md = await sharp(buffer).metadata();
    if (!(md.width >= 2 && md.height >= 2)) return false;
    // metadata() reports STORED dims. EXIF orientation 5-8 means the image is
    // displayed transposed, so compare against the DISPLAY ratio or we would
    // reject good portrait output that happens to be stored landscape.
    const transposed = Number(md.orientation || 1) >= 5;
    const dw = transposed ? md.height : md.width;
    const dh = transposed ? md.width  : md.height;
    const tr = wr / hr;
    return Math.abs(dw / dh - tr) / tr <= REFRAME_RATIO_TOLERANCE();
  } catch {
    return false;
  }
}

// Cloudinary rejects an oversized upload with HTTP 400 "File size too large.
// Got <n>. Maximum is <limit>."
//
// THE LIMIT IS PLAN-DEPENDENT, NOT A FIXED API CONSTANT. An earlier version of
// this comment claimed it was a hard API limit; that was WRONG. Production hit
// the ceiling at 20971520 (20 MiB) on 2026-08-04, and the account was upgraded
// to 40 MiB the same day — the number moved, so it lives in the environment.
// Read the current value out of the failing message rather than assuming:
// Cloudinary states its own limit in the 400 body.
//
// REFRAME_RESOLUTION is '4k', so a healthy outpaint can return more than
// whatever the ceiling is: the 2026-08-04 crash was Got 24232221 (24.2 MB)
// against a 20 MiB plan. The pre-upload guard only had a FLOOR
// (`outBuf.length >= 512`) and no ceiling, so a perfectly good 4K generation
// passed the check and died on upload — AFTER `billed = true`. We had already
// paid for that asset and then discarded it, which is exactly what the "a
// single blip here used to discard a generation we had already paid for"
// comment further down exists to prevent. Raising the plan removes today's
// trigger; it does not remove the class, which is why the refit stays.
const CLOUDINARY_MAX_UPLOAD_BYTES = (() => {
  const raw = parseInt(process.env.CLOUDINARY_MAX_UPLOAD_BYTES || '', 10);
  // Floor at 1 MiB so a typo cannot refit every asset into oblivion.
  return Number.isFinite(raw) && raw >= 1048576 ? raw : 40 * 1024 * 1024;  // 41943040
})();

/**
 * Bring an oversized render under Cloudinary's ceiling WITHOUT throwing away a
 * generation we have already been billed for.
 *
 * Recompresses to JPEG at descending quality, then scales down, stopping at the
 * first result that fits. JPEG rather than PNG deliberately: this buffer is a
 * VIDEO REFERENCE IMAGE handed to Omni, never a delivered asset, so lossy
 * compression costs nothing that survives into the output — whereas losing the
 * asset costs a paid 4K generation.
 *
 * Returns the original buffer untouched when it already fits, and null only
 * when nothing we can do gets it under the limit (caller then falls back to
 * pad, same as any other outpaint failure).
 */
async function fitBufferForCloudinary(buf, label = 'reframe') {
  if (!Buffer.isBuffer(buf) || buf.length <= CLOUDINARY_MAX_UPLOAD_BYTES) return buf;
  const startedAt = Date.now();
  for (const attempt of [
    { quality: 90 }, { quality: 80 }, { quality: 72 },
    { quality: 80, scale: 0.75 }, { quality: 72, scale: 0.6 }
  ]) {
    try {
      let pipeline = sharp(buf);
      if (attempt.scale) {
        const md = await sharp(buf).metadata();
        if (md?.width) {
          pipeline = pipeline.resize(Math.max(640, Math.round(md.width * attempt.scale)));
        }
      }
      const out = await pipeline.jpeg({ quality: attempt.quality, mozjpeg: true }).toBuffer();
      if (out.length <= CLOUDINARY_MAX_UPLOAD_BYTES) {
        console.log(
          `   🗜  ${label}: ${buf.length} bytes exceeded Cloudinary's ${CLOUDINARY_MAX_UPLOAD_BYTES} — ` +
          `refit to ${out.length} (q=${attempt.quality}${attempt.scale ? `, scale=${attempt.scale}` : ''}) ` +
          `in ${Date.now() - startedAt}ms`
        );
        return out;
      }
    } catch (err) {
      console.warn(`   ⚠️  ${label}: refit attempt failed — ${err.message}`);
    }
  }
  console.warn(
    `   ⚠️  ${label}: could not bring ${buf.length} bytes under ${CLOUDINARY_MAX_UPLOAD_BYTES} — giving up on this tier`
  );
  return null;
}

// In-process single-flight for reframes. The product fan-out emits several
// ads that SHARE reference medias, and workers run those ads in parallel —
// without this, the same media+aspect would outpaint 2–3× concurrently
// before any persist lands, paying REFRAME_COST_USD each for one asset. Keyed by media
// _id (or source URL when there's no Media doc) + aspect; cleared on settle.
const _inflightReframes = new Map();

// ── Cross-process reframe claim (Option A) ─────────────────────────────
// Mutex lives on Media.metadata.reframes.<aspectKey>.claim = { at, by }.
// Chosen over Option B (dedicated claim collection + unique index) because:
//   • Mongo is already the shared store for the result cache on the same path
//   • one atomic findOneAndUpdate both locks and co-locates with the eventual
//     url entry (persist supersedes claim via full $set of the aspect key)
//   • no new collection/index to operate; the only wrinkle is that cache reads
//     MUST key on `.url` only — a claim-only entry is never a cache hit
//     (see steps 3 / 4c / waitForReframeUrl below).
//
// Winner → billable POST. Loser → bounded re-read wait, then $0 crop; NEVER
// spends. Stale claims (older than REFRAME_CLAIM_TTL_MS) are stealable so a
// crashed holder cannot block (media, aspect) forever. Unbilled exits release
// the claim; billed exits leave it for persist to supersede (or TTL if persist
// fails — better a soft lock than an immediate re-POST of a paid asset).

function reframeClaimPath(aspectKey) {
  return `metadata.reframes.${aspectKey}`;
}

// Atomic try-claim. Returns true only when THIS process holds the lease.
// Fail-CLOSED on Mongo errors: crop instead of risking a double POST.
async function tryClaimReframe(mediaId, aspectKey, claimBy) {
  const path = reframeClaimPath(aspectKey);
  const now = Date.now();
  const staleBefore = new Date(now - REFRAME_CLAIM_TTL_MS()).toISOString();
  try {
    const doc = await Media.findOneAndUpdate(
      {
        _id: mediaId,
        // Claimable when there is no finished result YET, or when the result
        // that exists came from an older ladder and is due for re-derivation.
        // Without the ladderVersion clause a stale asset could never be
        // reclaimed — its url is present, so the emptiness test alone would
        // reject every claim and the re-derive would silently never happen.
        $and: [
          {
            $or: [
              { [`${path}.url`]: { $exists: false } },
              { [`${path}.url`]: null },
              { [`${path}.url`]: '' },
              // Whitespace-only must count as empty too: the cache reads .trim(),
              // so without this a corrupt "   " url is neither a cache hit nor
              // claimable and the aspect is stuck on crops forever.
              { [`${path}.url`]: { $not: /\S/ } },
              ...(REFRAME_REDERIVE_STALE()
                ? [{ [`${path}.ladderVersion`]: { $ne: REFRAME_LADDER_VERSION } }]
                : [])
            ]
          },
          // No live claim, or the prior holder is past the lease TTL.
          {
            $or: [
              { [`${path}.claim.at`]: { $exists: false } },
              { [`${path}.claim.at`]: { $lt: staleBefore } }
            ]
          }
        ]
      },
      {
        $set: {
          [`${path}.claim`]: {
            at: new Date(now).toISOString(),
            by: claimBy
          }
        }
      },
      { new: true }
    );
    return !!doc;
  } catch (err) {
    console.error(
      `❌ reframe claim acquire failed (fail-closed, no spend) — ${err.message}`
    );
    return false;
  }
}

// Release OUR claim so a later render can retry. Two shapes, and picking the
// wrong one destroys data:
//   • claim-only entry (no url) → unset the whole path, restoring "never derived"
//   • stale entry we were re-deriving (url present) → unset ONLY `.claim`, or we
//     would delete a perfectly good older asset and leave the aspect with nothing
// Both are scoped to claim.by === ours so we never disturb another holder, and
// neither can clobber a freshly persisted result (persist replaces the whole
// entry, which drops `.claim` and makes claim.by stop matching).
async function releaseReframeClaim(mediaId, aspectKey, claimBy) {
  const path = reframeClaimPath(aspectKey);
  const emptyUrl = [
    { [`${path}.url`]: { $exists: false } },
    { [`${path}.url`]: null },
    { [`${path}.url`]: '' },
    { [`${path}.url`]: { $not: /\S/ } }
  ];
  try {
    // Claim-only → drop the entry entirely.
    const res = await Media.updateOne(
      { _id: mediaId, [`${path}.claim.by`]: claimBy, $or: emptyUrl },
      { $unset: { [path]: 1 } }
    );
    if (res?.modifiedCount) return;
    // Otherwise a url is present (the stale asset we tried to replace) — keep
    // the asset, drop just our lock.
    await Media.updateOne(
      { _id: mediaId, [`${path}.claim.by`]: claimBy },
      { $unset: { [`${path}.claim`]: 1 } }
    );
  } catch (err) {
    console.warn(`⚠️  reframe claim release failed — ${err.message}`);
  }
}

// Loser wait: re-read for the winner's url with 1s,2s,…,Ns backoff, returning
// the moment it lands. Attempts come from REFRAME_CLAIM_WAIT_ATTEMPTS at the
// claim-loss call site (default ≈6 min — sized to a full cold reframe so a
// run racing the wizard prewarm inherits the generative asset instead of
// degrading to a crop). Never spends; on timeout the caller crops.
// Deliberately accepts a STALE url too: during a re-derive the older asset is
// still a real, correctly-shaped image, so serving it to a concurrent render
// beats a destructive crop and costs nothing.
//
// CLAIM-DEATH EARLY EXIT — the reason a multi-minute wait is safe. Sleeping the
// full span only makes sense while a winner is actually working; if the holder
// died (instance replaced mid-deploy — the prewarm is a long fire-and-forget on
// the web process, so this is a real shape) a fixed wait would burn the whole
// span and then crop anyway, holding a render slot for nothing. Two cheap
// signals end the wait immediately, both read from the same document we already
// fetch each tick:
//   • entry gone / no claim → releaseReframeClaim ran with no url, i.e. the
//     winner gave up. Nothing is coming.
//   • claim.at older than the lease → holder is dead; the claim is now
//     stealable, so waiting on it is waiting on nobody.
// Neither can fire while a live holder works: tryClaimReframe writes claim
// before the submit and the lease floor (≥20 min) far outlasts a reframe.
// Returning null degrades to the caller's deterministic crop — never spend.
async function waitForReframeUrl(mediaId, aspectKey, attempts = 3) {
  const path = reframeClaimPath(aspectKey);
  const claimTtlMs = REFRAME_CLAIM_TTL_MS();
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    try {
      const fresh = await Media.findById(mediaId).select(path).lean();
      const entry = fresh?.metadata?.reframes?.[aspectKey];
      const url = entry?.url;
      if (typeof url === 'string' && url.trim()) return url;

      if (!entry || !entry.claim) {
        console.log(
          `   ⏳ reframe[${aspectKey}]: winner released without a result — cropping now (no spend)`
        );
        return null;
      }
      const claimedAt = Date.parse(entry.claim.at);
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt > claimTtlMs) {
        console.warn(
          `⚠️  reframe[${aspectKey}]: winner's claim aged past the lease ` +
          `(${Math.round((Date.now() - claimedAt) / 1000)}s) — holder presumed dead, cropping now`
        );
        return null;
      }
    } catch { /* retry / fall through */ }
  }
  return null;
}

// Reframe sourceUrl to aspectRatio via generative uncrop outpaint (or exact-fit
// skip / $0 pad). NEVER throws — any failure degrades to deterministic Cloudinary
// crop so the ad pipeline keeps moving. Successful reframes (incl. exact / pad)
// are persisted on Media.metadata.reframes[aspectKey] for reuse.
async function reframeReferenceForAspect({ media, sourceUrl, aspectRatio, brand, subjectSide = null }) {
  const cropUrl = () => cropImageUrlForAspect(sourceUrl, aspectRatio, brand);
  // Set when we find a cached asset from an OLDER ladder. We re-derive it, but
  // it stays the last resort: an old reframe is a real, correctly-shaped image,
  // so serving it beats falling back to a destructive c_fill crop if the
  // re-derive fails.
  let staleUrl = null;
  const fallback = () => staleUrl || cropUrl();
  try {
    // 1. Kill-switch / Atlas unconfigured / missing source → crop only.
    if (!REFRAME_ENABLED() || !enabled() || !sourceUrl) return fallback();

    // 2. Mongo-safe aspect key: alphanumeric+underscore only, so ':' AND
    //    '.' are removed ('9:16'→'9_16', '1.91:1'→'1_91_1'). A raw dot would
    //    make the $set path nest and permanently miss the flat-key read.
    //
    //    SPLIT DIMENSION (2026-08-12). A split-stage seed is NOT interchangeable
    //    with a plain reframe of the same media at the same aspect: the subject
    //    is anchored to one side and half the frame is generated. Two different
    //    split sides are not interchangeable with each other either. Without
    //    this suffix the aspect-only key would hand a 16:9 video run a
    //    subject-hard-right seed (or the reverse), silently, from cache — the
    //    kind of failure that costs a billable master and looks like a model
    //    problem. Plain reframes keep the exact key they have today, so no
    //    existing cache entry is invalidated or shadowed.
    const splitSide = (subjectSide === 'east' || subjectSide === 'west') ? subjectSide : null;
    const aspectKey = String(aspectRatio).replace(/[^a-z0-9]+/gi, '_')
      + (splitSide ? `_split_${splitSide}` : '');

    // 3. PERSISTENT CACHE HIT — no spend, no submit (survives restarts).
    //    Only `.url` counts: a claim-only entry ({ claim: { at, by } }) is NOT
    //    a hit and must fall through so the loser can wait / crop.
    //    A CURRENT-ladder entry is served as-is. An entry from an older ladder
    //    is deliberately NOT served: the next video generation re-derives it
    //    under the new resize regime (see REFRAME_REDERIVE_STALE).
    const cachedEntry = readReframeEntry(media?.metadata?.reframes?.[aspectKey]);
    if (cachedEntry.url && !cachedEntry.stale) return cachedEntry.url;
    if (cachedEntry.stale) {
      staleUrl = cachedEntry.url;
      console.log(
        `   ♻️  reframe[${aspectKey}]: cached asset is from ladder ` +
        `'${media?.metadata?.reframes?.[aspectKey]?.ladderVersion || 'pre-versioning'}' ` +
        `— re-deriving under '${REFRAME_LADDER_VERSION}'`
      );
    }

    // 4. IN-PROCESS SINGLE-FLIGHT — collapse concurrent reframes of the same
    //    media+aspect within this worker so the billable outpaint runs once.
    const memoKey = `${media?._id ? String(media._id) : sourceUrl}|${aspectKey}`;
    const existing = _inflightReframes.get(memoKey);
    if (existing) return await existing;

    // The worker below NEVER throws — it resolves to a reframe URL or the
    // deterministic crop fallback, so every awaiter gets a usable value.
    const work = (async () => {
      const [wr, hr] = String(aspectRatio).split(':').map(Number);
      // 4a. Malformed aspect → crop, never bill an outpaint on a broken prompt.
      if (!(wr > 0 && hr > 0)) return fallback();

      // 4b. Only MEDIA-BACKED refs are cacheable. An uncacheable ref (product
      //     URL / legacy fallback, no Media doc) would re-outpaint every
      //     render, so crop it instead of spending. The seed + catalog mirrors
      //     always have _id, so the common path still outpaints.
      if (!media?._id) return fallback();

      // 4c. FRESH persistent-cache re-read. This lean media doc may have been
      //     loaded BEFORE a sibling ad/worker persisted this aspect (fan-out
      //     ads share reference medias) — the in-process single-flight only
      //     covers overlapping calls, so re-check the DB to close the
      //     post-settle sequential dual-bill window (one cheap read ≪ cost).
      //     Again: `.url` only — never treat a bare claim as a finished reframe.
      try {
        const fresh = await Media.findById(media._id).select(`metadata.reframes.${aspectKey}`).lean();
        const freshEntry = readReframeEntry(fresh?.metadata?.reframes?.[aspectKey]);
        // Only a CURRENT-ladder entry short-circuits. A stale one is kept as the
        // last resort and we continue on to re-derive it.
        if (freshEntry.url && !freshEntry.stale) return freshEntry.url;
        if (freshEntry.stale) staleUrl = freshEntry.url;
      } catch { /* fall through and compute */ }

      // 5. ALREADY-CORRECT guard — source aspect within threshold of target.
      if (media.width > 0 && media.height > 0) {
        const sr = media.width / media.height;
        const tr = wr / hr;
        const retained = Math.min(sr, tr) / Math.max(sr, tr);
        if (retained >= REFRAME_SKIP_THRESHOLD()) {
          // cropUrl(), NOT fallback(). fallback() may return a STALE asset, and
          // persisting that here would launder an old generative reframe into a
          // current-ladder 'exact' entry — stamping it with the new
          // ladderVersion so it is never re-derived again. On a product-only
          // shot that would freeze a fabricated garment in place permanently.
          // At this threshold the source is already ~the target aspect, so the
          // deterministic crop IS the honest 'exact' result and costs nothing.
          const exactUrl = cropUrl();
          // Persist exact-fit too so every aspect is on file for reuse.
          await persistReframe(media, aspectKey, aspectRatio, exactUrl, 'exact');
          return exactUrl;
        }
      }

      // 5b. PRODUCT-ONLY → deterministic pad, NEVER generative, NEVER billed.
      //     See REFRAME_PRODUCT_ONLY_PAD for the measured reasoning: generative
      //     outpaint fabricates merchandise on flat-lay/studio shots. c_pad
      //     scales-to-fit and pads, so the product ships untouched.
      //
      //     Returns before any POST. On ANY failure we fall through to the
      //     generative ladder below rather than returning a crop, so a product
      //     still gets a usable reference — but the pad is tried first.
      if (REFRAME_PRODUCT_ONLY_PAD() && isProductOnlyShot(media)) {
        const srcRatio = media.width > 0 && media.height > 0 ? media.width / media.height : null;
        const sample   = await fetchBorderSample(sourceUrl);
        const fill     = sample && srcRatio
          ? await detectBorderFill(sample, srcRatio, wr / hr)
          : { uniform: false, hex: null };
        // FLAT BORDERS ONLY (owner, 2026-08-12). This used to fall back to
        // Cloudinary's b_auto:predominant_gradient when the edges were not flat,
        // which paints a VISIBLE band — and because this seed is reference input
        // to an image-to-video model, that band is reproduced in the delivered
        // video where no crop can reach it. See the note at 6b.
        //
        // A non-flat product shot goes straight to the deterministic crop rather
        // than falling through to the generative ladder: this branch exists
        // BECAUSE outpaint fabricates merchandise on product-only shots, so
        // "not paddable" must not become "pay to have a garment invented". The
        // crop is free, ships the real product, and has no bands.
        const padDec = seedPadDecision(fill);
        if (padDec.action !== 'pad-solid') {
          console.log(
            `   ✂️  reframe[${aspectKey}]: product_only but ${padDec.reason} → $0 crop (no band, no spend)`
          );
          return fallback();
        }
        const hex = padDec.hex;

        let padUrl = cloudinaryPadUrl(sourceUrl, aspectRatio, hex);
        if (!padUrl && sample) {
          // Non-Cloudinary source: can't transform by URL, so pad the bytes.
          const { w: pw, h: ph } = imageDimsForAspect(aspectRatio);
          const buf = await padSolidBuffer(sample, pw, ph, hex || 'ffffff');
          if (buf) {
            try {
              const up = await uploadBufferToCloudinary(buf, { folder: 'liquidretail/reframes' });
              padUrl = up.secure_url || up.url || null;
            } catch (err) {
              console.warn(`⚠️  reframeReferenceForAspect[${aspectKey}]: product-only pad upload failed — ${err.message}`);
            }
          }
        }
        if (padUrl) {
          console.log(
            `   🧺 reframe[${aspectKey}]: product_only → $0 pad ` +
            `(${hex ? `solid #${hex}, border std ok` : 'predominant gradient'})`
          );
          await persistReframe(media, aspectKey, aspectRatio, padUrl, 'pad-product-only');
          return padUrl;
        }
        console.warn(`⚠️  reframeReferenceForAspect[${aspectKey}]: product-only pad unavailable — falling through to generative`);
      }

      // 5c. YOLO-GUIDED CROP → deterministic, $0, no fabrication.
      //     When Media.refinedProducts carries YOLO subject bboxes AND those
      //     bboxes fit inside a target-aspect crop window on the source,
      //     ship the c_crop URL instead of paying nano-banana to invent
      //     pixels. Kill-switched via REFRAME_STRATEGY=crop-first (default
      //     off so this is a no-op until enabled).
      //
      //     Design point: this fires ONLY when the deterministic crop can
      //     preserve every YOLO-detected subject with an 8px safety margin.
      //     Multi-model lifestyle shots where the union spans more of the
      //     abundant dimension than a target-aspect window has room for
      //     defer to the outpaint path below (measured on prod:
      //     4-person catalog frame with 1370px horizontal union going to
      //     9:16 needs 1135px window → deferred).
      const { chooseStrategy } = require('./reframeStrategyChooser');
      const strategy = chooseStrategy({ media, aspectRatio, sourceUrl });
      if (strategy.action === 'crop') {
        console.log(
          `   ✂️  reframe[${aspectKey}]: ${strategy.reason} → $0 crop ` +
          `(${strategy.rect.w}×${strategy.rect.h} @ ${strategy.rect.x},${strategy.rect.y})`
        );
        await persistReframe(media, aspectKey, aspectRatio, strategy.url, strategy.method);
        return strategy.url;
      }
      // Any non-'crop' outcome (skip / defer) falls through. 'skip' is
      // already handled by the ALREADY-CORRECT guard at step 5, so in
      // practice we only reach here on 'defer' — logged verbosely so a
      // spike of deferrals is visible in Render logs before the ledger
      // shows the outpaint spend.
      if (strategy.action === 'defer' && strategy.reason !== 'REFRAME_STRATEGY!=crop-first') {
        console.log(`   ↪️  reframe[${aspectKey}]: crop-first deferred → ${strategy.reason}`);
      }

      // 6. NORMALIZE → OUTPAINT → VALIDATE → PAD. Ported from the LLM
      //    Expander's runSafeZoneReframe (media.ts:1117-1227). `billed` flips
      //    true as soon as the billable POST is away and is NEVER cleared, so
      //    the ledger records the charge on EVERY subsequent path — a rejected
      //    output, a failed download, a poll timeout, or a fall-through to the
      //    $0 pad. An unledgered charge is invisible; that's the failure mode
      //    this ordering exists to prevent.
      //
      //    Cross-process claim wraps this billable section only (free tiers
      //    above never spend and need no mutex). See tryClaimReframe.
      const { w: W, h: H } = imageDimsForAspect(aspectRatio);
      let billed    = false;
      let resultUrl = null;
      let method    = null;
      // BILLING/CLAIM: identity of this process's lease; only release when we
      // still hold a claim-only entry and did NOT bill (see finally below).
      const claimBy = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
      let holdClaim = false;

      try {
        // CLAIM: atomic cross-process mutex. Loser never reaches submitImageGeneration.
        const won = await tryClaimReframe(media._id, aspectKey, claimBy);
        if (!won) {
          console.log(
            `   ⏳ reframe[${aspectKey}]: claim held by another process — waiting for winner ` +
            `(≤${REFRAME_CLAIM_WAIT_ATTEMPTS()} reads, no spend)`
          );
          const winnerUrl = await waitForReframeUrl(
            media._id, aspectKey, REFRAME_CLAIM_WAIT_ATTEMPTS()
          );
          if (winnerUrl) return winnerUrl;
          console.warn(
            `⚠️  reframeReferenceForAspect[${aspectKey}]: claim loser — winner result not ready, cropping (no spend)`
          );
          return fallback();
        }
        holdClaim = true;

        // CLAIM: last look before spending. Winning the claim does NOT prove no
        // result exists — the FREE tiers (exact-fit skip, product-only pad) call
        // persistReframe with a full $set and no claim check, so another process
        // can land a $0 result and wipe our claim at any moment. Without this
        // re-read we would pay for a generative reframe that already has a free
        // answer, and then OVERWRITE that answer — which on a product-only shot
        // means replacing a pixel-exact pad with a fabricated garment.
        try {
          const settled = await Media.findById(media._id)
            .select(`metadata.reframes.${aspectKey}`).lean();
          const settledEntry = readReframeEntry(settled?.metadata?.reframes?.[aspectKey]);
          // Only a CURRENT-ladder result means "someone else already did the
          // work". A stale url here is the very asset we hold the claim to
          // replace — bailing on it would make the re-derive impossible.
          if (settledEntry.url && !settledEntry.stale) {
            console.log(`   ✅ reframe[${aspectKey}]: another process landed a result — no spend`);
            return settledEntry.url;
          }
          if (settledEntry.stale) staleUrl = settledEntry.url;
        } catch { /* unreadable → proceed; the claim is still ours */ }

        // The bytes + URL the model will see. Re-encoded ONLY when the source
        // carries alpha or an EXIF rotation; otherwise the original is forwarded
        // untouched (see normalizeReframeSource). Feeds BOTH the outpaint and the
        // pad fallback. If we can't even read it, do NOT spend — crop instead.
        const srcNorm = await normalizeReframeSource(sourceUrl);
        if (!srcNorm) {
          console.warn(`⚠️  reframeReferenceForAspect[${aspectKey}]: source normalize failed — cropping, no spend`);
          return fallback();
        }

        try {
          const id = await submitImageGeneration({
            model: REFRAME_OUTPAINT_MODEL(),
            images: [srcNorm.url],
            // splitSide rides in the prompt context so reframeOutpaintPrompt can
            // switch to the directional instruction. null for every existing
            // caller, which keeps their prompt byte-identical.
            prompt: reframeOutpaintPrompt(aspectRatio, { ...reframePromptContext(media), subjectSide: splitSide }),
            aspectRatio,
            resolution: REFRAME_RESOLUTION()
          });
          // BILLING: Charge point. submitImageGeneration's own contract is "NO
          // retry (POST is charged)", so the money is committed HERE — before
          // the poll, not after it. Setting `billed` at terminal-ok instead
          // would lose the charge whenever polling times out on a prediction
          // Atlas later completes and bills. Worst case this over-attributes a
          // genuinely failed prediction, which is the safe direction: an
          // overstated ledger is visible and correctable, an understated one is
          // neither. NEVER cleared once true.
          billed = true;

          const pollOut = await pollPrediction(id);
          // pollPrediction returns { url, price } (price is for video-master
          // cost reconcile; reframe ledgers its own flat estimate and ignores it).
          const outUrl = pollOut && typeof pollOut === 'object' ? pollOut.url : pollOut;

          // Retried (free, idempotent) — see fetchOutpaintOutput. A single blip
          // here used to discard a generation we had already paid for.
          const outBuf = await fetchOutpaintOutput(outUrl);
          if (outBuf.length >= 512 && await outputRatioOk(outBuf, wr, hr)) {
            // CEILING, not just a floor. At REFRAME_RESOLUTION=4k this buffer
            // regularly exceeds Cloudinary's 20 MiB limit; before this guard the
            // upload 400'd and a generation we had ALREADY BEEN BILLED for was
            // thrown away. Refit rather than discard. Ratio is checked on the
            // ORIGINAL buffer above, and the refit only recompresses/scales
            // uniformly, so the aspect the ratio check approved still holds.
            const fitted = await fitBufferForCloudinary(outBuf, `reframe[${aspectKey}]`);
            if (!fitted) {
              console.warn(
                `⚠️  reframeReferenceForAspect[${aspectKey}]: output ${outBuf.length} bytes cannot be stored — pad fallback`
              );
            } else {
              const up = await uploadBufferToCloudinary(fitted, { folder: 'liquidretail/reframes' });
              const url = up.secure_url || up.url;
              if (url) { resultUrl = url; method = 'outpaint'; }
            }
          } else {
            console.warn(`⚠️  reframeReferenceForAspect[${aspectKey}]: output rejected (bytes=${outBuf.length}) — pad fallback`);
          }
        } catch (err) {
          // BILLING: err.charged — POST resolved (Atlas accepted, may have billed)
          // but response carried no prediction id, so we can't poll. Still set
          // billed and ledger rather than lose the spend.
          if (err?.charged) billed = true;
          console.warn(`⚠️  reframeReferenceForAspect[${aspectKey}]: outpaint failed — ${err.message}`);
        }

        // 6a0. SPLIT COPY-HALF DENSITY GATE (2026-08-12).
        //
        // MONEY: the extended seed just cost ~$0.08; the video master that
        // consumes it costs ~$0.90–$1.20. A ~$0.01–0.02 vision pass that stops
        // a busy panel from becoming a master is overwhelmingly worth it.
        // Standing NO-SCRIM rule (owner 2026-08-12) means we cannot rescue a
        // busy panel with a shade behind the type later — catch it here, once.
        //
        // Scope: ONLY the split path, and ONLY after a successful generative
        // outfill. Every other caller of reframeReferenceForAspect is inert —
        // no vision call, no behaviour change. Gated on `splitSide` so a
        // missing/null subjectSide cannot reach analyzeOverlayZones.
        //
        // Failure discipline mirrors buildReferenceImages' per-item catch
        // (2026-08-04): a $0.01 advisory must NEVER hard-fail a run that
        // already paid for the seed. Vision throws / junk / undecidable all
        // degrade to the deterministic brand_panel (flat brand colour via
        // websiteBackgroundHex + padSolidBuffer gravity) and the run continues.
        // At most ONE retry, and that retry is the free brand_panel — never a
        // second vision call (looping a cheap advisory into unbounded cost).
        if (resultUrl && splitSide) {
          let densityOk = false;
          try {
            const { analyzeOverlayZones } = require('./overlayZoneService');
            const {
              isCopyHalfCalm,
              copyPanelRectForSubjectSide
            } = require('./pmaxSplitStrategy');
            const zones = await analyzeOverlayZones({
              imageUrl: resultUrl,
              label: `split-density[${aspectKey}]`,
              ratio: aspectRatio
            });
            const panelRectPct = copyPanelRectForSubjectSide(splitSide);
            const verdict = isCopyHalfCalm({
              densityGrid: zones?.densityGrid,
              restrictions: zones?.restrictions,
              panelRectPct
            });
            if (verdict.calm === true) {
              densityOk = true;
              console.log(
                `   ✅ split-density[${aspectKey}]: copy half calm ` +
                `(mean=${Number(verdict.mean).toFixed(2)} peak=${Number(verdict.peak).toFixed(2)}) — keeping outfill`
              );
            } else {
              // false OR null (undecidable) — both degrade. Asymmetry is
              // intentional: false calm ships unreadable copy on a ~$1 master;
              // false not-calm only costs a brand-panel swap.
              const detail = verdict.calm === false
                ? `${verdict.reason}` +
                  (verdict.offendingClassification
                    ? ` class=${verdict.offendingClassification}`
                    : '') +
                  (verdict.worstCell
                    ? ` worst=${JSON.stringify(verdict.worstCell)}`
                    : '')
                : `undecidable:${verdict.reason || 'unknown'}`;
              console.warn(
                `   ⚠️  split-density[${aspectKey}]: ${detail} — ` +
                `degrading to brand_panel (no scrim rescue; gate ~$0.01–0.02 vs master ~$0.90–1.20)`
              );
            }
          } catch (err) {
            // Advisory failure must not kill the run — same shape as the
            // buildReferenceImages per-item catch. Degrade and continue.
            console.warn(
              `   ⚠️  split-density[${aspectKey}]: gate failed ` +
              `(${err?.message || err}) — degrading to brand_panel, run continues`
            );
          }

          if (!densityOk) {
            // ONE free brand_panel swap. Source is the original product
            // bytes (srcNorm), not the busy outfill — the whole point is a
            // flat brand-colour half opposite the subject.
            try {
              const { websiteBackgroundHex } = require('../utils/websiteBackground');
              const hex = websiteBackgroundHex(brand);
              const panelBuf = await padSolidBuffer(srcNorm.buffer, W, H, hex, splitSide);
              const fitted = panelBuf
                ? await fitBufferForCloudinary(panelBuf, `split-brand-panel[${aspectKey}]`)
                : null;
              if (fitted) {
                const up = await uploadBufferToCloudinary(fitted, { folder: 'liquidretail/reframes' });
                const url = up.secure_url || up.url;
                if (url) {
                  resultUrl = url;
                  method = 'brand_panel-density-fallback';
                  console.log(
                    `   🎨 split-density[${aspectKey}]: brand_panel ready ` +
                    `(#${hex}, gravity=${splitSide})`
                  );
                }
              }
              if (method !== 'brand_panel-density-fallback') {
                // Brand panel itself failed. Keep the outfill rather than
                // return nothing — the pipeline still needs a seed URL, and
                // a possibly-busy panel beats a hard fail after money spent.
                console.warn(
                  `   ⚠️  split-density[${aspectKey}]: brand_panel unavailable — ` +
                  `keeping outfill rather than failing the run`
                );
              }
            } catch (err) {
              console.warn(
                `   ⚠️  split-density[${aspectKey}]: brand_panel failed ` +
                `(${err?.message || err}) — keeping outfill, run continues`
              );
            }
          }
        }

        // 6a. Drop the normalized-source mirror IF we made one (opaque, correctly
        //     oriented sources are handed to Atlas by their original URL and have
        //     nothing to clean up). The mirror exists only so the model could
        //     fetch flattened/oriented bytes; the prediction has reached a
        //     terminal state by here, so Atlas will never re-fetch it, and the pad
        //     below uses srcNorm.buffer (in-memory), not this URL. Without this,
        //     every re-encoded reframe would leak a permanent Cloudinary asset.
        //     Best-effort — deleteFromCloudinary catches internally, never throws.
        if (srcNorm.mirrored) await deleteFromCloudinary(srcNorm.url);

        // 6b. Rejected or failed → $0 deterministic pad from the normalized
        //     source, but ONLY when that pad is INVISIBLE.
        //
        //     WHY THIS NO LONGER BLUR-PADS (owner, 2026-08-12). This seed is fed
        //     to an image-to-video model as reference. The model reproduces what
        //     it is shown, so a letterboxed seed BAKES THE BANDS INTO THE VIDEO —
        //     and no downstream crop can remove content that is already inside
        //     the pixels. That is the "shaded bars around the video" the owner
        //     reported on PMax, and it reproduced on seeds that started at 4:5.
        //
        //     It went unnoticed because this path only runs when the outpaint
        //     fails, and the outpaint had been dormant since 2026-08-07. When it
        //     was switched back on it failed 14/14 (Atlas 500 "failed to upload
        //     output 0 to OSS"), so EVERY video seed landed here.
        //
        //     A solid fill sampled from a genuinely flat backdrop is still fine:
        //     it is indistinguishable from the backdrop, so there is no band to
        //     see and the whole subject stays visible. A blurred cover is not —
        //     it is a visible smear of the frame's own colours.
        //
        //     When the border is NOT flat we build nothing and leave resultUrl
        //     null. Step 8 then settles to staleUrl || cropUrl() and persists it
        //     as 'crop-after-bill'. A crop loses framing at the edges; the owner
        //     has been explicit that a clean crop beats bars. The ledger at step
        //     7 is upstream of this and still records the spend either way.
        if (!resultUrl) {
          try {
            const srcRatio = media.width > 0 && media.height > 0 ? media.width / media.height : null;
            const fill = srcRatio
              ? await detectBorderFill(srcNorm.buffer, srcRatio, wr / hr)
              : { uniform: false, hex: null };
            // SPLIT SEEDS NEVER PAD (2026-08-12). On a split the source has been
            // pre-composed hard against one edge, so "pad the rest" means
            // shipping a frame that is literally half flat fill — the single
            // most visible band this pipeline could produce, and the exact
            // defect class PR #155 removed, just at 50% scale instead of a
            // letterbox strip. detectBorderFill would often even call that fill
            // uniform (it IS uniform — it's our own fill), so seedPadDecision
            // cannot be trusted to refuse it here. Crop instead: the caller
            // reads a null/cropped result as "outfill unavailable" and falls
            // back to the deterministic brand_panel treatment, which is a
            // designed flat panel rather than an accident.
            const padDec = splitSide
              ? { action: 'crop', reason: 'split-seed-never-pads' }
              : seedPadDecision(fill);
            if (padDec.action !== 'pad-solid') {
              console.warn(
                `⚠️  reframeReferenceForAspect[${aspectKey}]: ${padDec.reason} — ` +
                `refusing a visible pad on a video seed, cropping instead`
              );
            }
            const padBuf = padDec.action === 'pad-solid'
              ? await padSolidBuffer(srcNorm.buffer, W, H, padDec.hex)
              : null;
            // Same ceiling applies here — a pad built from a 4K source is just
            // as capable of exceeding 20 MiB as the outpaint was. This tier is
            // free, so a refit failure is not a money loss, but an unguarded
            // 400 here is the same fatal rejection.
            const paddedFitted = padBuf
              ? await fitBufferForCloudinary(padBuf, `reframe-pad[${aspectKey}]`)
              : null;
            if (paddedFitted) {
              const up = await uploadBufferToCloudinary(paddedFitted, { folder: 'liquidretail/reframes' });
              const url = up.secure_url || up.url;
              if (url) { resultUrl = url; method = 'pad-fallback'; }
            }
          } catch (err) {
            console.warn(`⚠️  reframeReferenceForAspect[${aspectKey}]: pad fallback failed — ${err.message}`);
          }
        }

        // 7. LEDGER: spend EXACTLY ONCE if Atlas billed us — on every path,
        //    success or rejected-then-padded. Best-effort; never blocks the URL.
        if (billed) {
          try {
            await recordFlatCost({
              stage: 'reframe-outpaint',
              provider: 'atlas',
              model: REFRAME_OUTPAINT_MODEL(),
              brandId: brand?._id || media?.brandId || null,
              mediaId: media?._id || null,
              productId: media?.metadata?.catalogProductId || null,
              purposeTag: `reframe:${aspectRatio}`,
              costUsd: REFRAME_COST_USD()
            });
          } catch { /* telemetry only */ }
        }

        // 8. Persist the asset-library entry — but ONLY when Atlas actually billed
        //    us. A persisted entry is a permanent cache hit, so its real job is to
        //    stop a second POST for an asset we already paid for. Full $set of the
        //    aspect key SUPERSEDES the claim (claim field is not copied into entry).
        //
        //    When we were NEVER billed (Atlas 5xx, bad key, blocked host, submit
        //    threw) the pad is the right answer for THIS render, but persisting it
        //    would lock this media+aspect to a blurred letterbox forever on the
        //    strength of one transient outage. Leave the cache empty so a later
        //    render retries the real uncrop — there is no spend to protect.
        //    (method 'outpaint' implies billed, so this gates on `billed` alone.)
        if (resultUrl && method) {
          if (billed) await persistReframe(media, aspectKey, aspectRatio, resultUrl, method);
          return resultUrl;
        }

        // Billed, but nothing usable came out of it (pad build AND upload both
        // failed). Persist SOMETHING so the next render can't charge us a second
        // time — but label it for what it actually is, because these two cases
        // are different assets and a future targeted invalidation needs to tell
        // them apart via method + ladderVersion.
        //
        // Note we must NOT persist fallback() blindly: when re-deriving, it
        // returns the stale asset, and writing that under the current
        // ladderVersion would silently abandon the upgrade after a single paid
        // miss. Keeping the old asset is right (it beats a crop); pretending it
        // is a fresh derivation is not.
        const settleUrl = staleUrl || cropUrl();
        if (billed && settleUrl) {
          await persistReframe(
            media, aspectKey, aspectRatio, settleUrl,
            staleUrl ? 'stale-kept-after-bill' : 'crop-after-bill'
          );
        }
        return settleUrl;
      } finally {
        // CLAIM RELEASE: only when we hold a claim-only entry AND never billed.
        // Unbilled → free the slot so a later render can retry the real outpaint.
        // Billed → do NOT release: persist supersedes claim with the paid url, or
        // if persist failed the lease soft-locks until TTL (avoids an immediate
        // re-POST for an asset we already paid for but failed to share off-box).
        if (holdClaim && !billed) {
          await releaseReframeClaim(media._id, aspectKey, claimBy);
        }
      }
    })();

    _inflightReframes.set(memoKey, work);
    try {
      return await work;
    } finally {
      _inflightReframes.delete(memoKey);
    }
  } catch (err) {
    console.warn(`⚠️  reframeReferenceForAspect: unexpected — ${err.message}`);
    return fallback();
  }
}

// method: 'exact' | 'pad-product-only' | 'outpaint' | 'pad-fallback' | 'crop-after-bill'
// ladderVersion lets a future change invalidate $0 tiers selectively without
// re-spending on entries that cost real money.
// Returns true when the DB write succeeded (or was skipped because there is no
// media._id — in-memory only). Returns false when Media.updateOne failed: the
// calling process still has the paid URL in its lean doc, but other processes
// cannot see it and may re-POST after the claim TTL — spend is unprotected
// off-box. Never throws.
async function persistReframe(media, aspectKey, aspectRatio, finalUrl, method) {
  if (!finalUrl) return false;
  const entry = {
    url: finalUrl,
    aspect: aspectRatio,
    method,
    model: REFRAME_OUTPAINT_MODEL(),
    ladderVersion: REFRAME_LADDER_VERSION,
    at: new Date().toISOString()
  };
  // Mutate in-memory lean doc so the same run reuses the cache.
  if (media) {
    media.metadata = media.metadata || {};
    media.metadata.reframes = media.metadata.reframes || {};
    media.metadata.reframes[aspectKey] = entry;
  }
  if (!media?._id) return true;
  try {
    // Full $set supersedes any in-flight claim on this aspect key.
    await Media.updateOne(
      { _id: media._id },
      { $set: { [`metadata.reframes.${aspectKey}`]: entry } }
    );
    return true;
  } catch (err) {
    // PERSIST/BILLING visibility: was console.warn (easy to miss). A failed
    // write after a billed generation leaves other processes without the paid
    // URL — they will soft-wait on the claim then crop, and after TTL may
    // re-POST. Operators must notice this.
    console.error(
      `❌ reframeReferenceForAspect: PERSIST FAILED — paid reframe URL not shared ` +
      `across processes; spend unprotected off-box (media=${media._id} aspect=${aspectKey} ` +
      `method=${method}) — ${err.message}`
    );
    return false;
  }
}

// Resolve per-ad render duration. Operators may set Ad.videoDurationSec
// (1–15); null/undefined/invalid falls back to caps.defaultDuration || 8,
// then clamps to [minDuration, maxDuration]. When caps.durationEnum is a
// non-empty array (Gemini Omni accepts only 4|6|8|10), snap to the
// NEAREST enum value — ties go to the smaller value — so the request
// body always carries a provider-legal duration.
function resolveDurationSec(requested, caps) {
  let n = parseInt(requested, 10);
  if (!Number.isFinite(n) || n < 1) n = caps?.defaultDuration || 8;
  const min = caps?.minDuration || 1;
  const max = caps?.maxDuration || 15;
  n = Math.max(min, Math.min(max, n));
  const enumer = caps?.durationEnum;
  if (Array.isArray(enumer) && enumer.length) {
    let best = enumer[0];
    let bestDelta = Math.abs(best - n);
    for (const v of enumer.slice(1)) {
      const delta = Math.abs(v - n);
      // Strict < keeps the smaller value on a tie (encountered first when
      // the enum is ascending, which every MODEL_CAPS entry is).
      if (delta < bestDelta || (delta === bestDelta && v < best)) {
        best = v;
        bestDelta = delta;
      }
    }
    n = best;
  }
  return n | 0;
}

// Validate an operator-supplied videoSettings payload (Brand or
// CatalogProduct PATCH). Returns an error string, or null when valid.
// Render-time resolution stays defensive regardless (unknown slugs warn
// and fall through) — this just catches typos at write time.
function validateVideoSettings(vs) {
  if (typeof vs !== 'object' || vs === null || Array.isArray(vs)) return 'videoSettings must be an object';
  const badSlug = (slug) => `unknown video model '${slug}' — valid: ${Object.keys(MODEL_CAPS).join(', ')}`;
  if (vs.model != null && vs.model !== '' && !MODEL_CAPS[vs.model]) return badSlug(vs.model);
  if (vs.modelByCanvas != null) {
    if (typeof vs.modelByCanvas !== 'object' || Array.isArray(vs.modelByCanvas)) {
      return 'videoSettings.modelByCanvas must be an object map of canvas → model slug';
    }
    for (const [canvas, slug] of Object.entries(vs.modelByCanvas)) {
      if (slug != null && slug !== '' && !MODEL_CAPS[slug]) return `modelByCanvas['${canvas}']: ${badSlug(slug)}`;
    }
  }
  if (vs.referenceImageCount != null && vs.referenceImageCount !== '') {
    const n = Number(vs.referenceImageCount);
    if (!Number.isInteger(n) || n < 1 || n > MAX_REFERENCE_IMAGE_COUNT) {
      return `videoSettings.referenceImageCount must be an integer 1–${MAX_REFERENCE_IMAGE_COUNT}`;
    }
  }
  if (vs.titlingEngine != null && vs.titlingEngine !== '' && !['canvas', 'remotion'].includes(vs.titlingEngine)) {
    return "videoSettings.titlingEngine must be 'canvas' or 'remotion'";
  }
  if (vs.titlePlacementMode != null && vs.titlePlacementMode !== '' && !['canonical', 'content'].includes(vs.titlePlacementMode)) {
    return "videoSettings.titlePlacementMode must be 'canonical' or 'content'";
  }
  if (vs.titleTemplate != null && vs.titleTemplate !== '' && !VALID_TITLE_TEMPLATES.includes(vs.titleTemplate)) {
    return `videoSettings.titleTemplate must be one of ${VALID_TITLE_TEMPLATES.join(', ')}`;
  }
  if (vs.promptGuidance != null && vs.promptGuidance !== '') {
    if (typeof vs.promptGuidance !== 'string' || vs.promptGuidance.length > 1000)
      return 'videoSettings.promptGuidance must be a string ≤1000 characters';
  }
  return null;
}

// KILL SWITCH: CATALOG_FEED_ORDER_SEEDING, DEFAULT ON. Same flag as
// seededUniverseService.js / campaignAdsGenerationService.js. Owner directive
// 2026-08-05: reference images 2/3 (after the seed at position 0) should be
// "the first and second other images in the feed, as they appear in the
// feed" — not shot-type or createdAt order.
function isCatalogFeedOrderSeedingEnabled() {
  const raw = process.env.CATALOG_FEED_ORDER_SEEDING;
  if (raw == null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// Order the product's catalog Media docs for the reference stack that fills
// positions 1+ in buildReferenceImages (position 0 is the seed, resolved
// separately by firstCatalogMediaForProduct).
//
// ON (default): feedIndex ascending — feedIndex is stamped at ingest by
// catalogProductDetectService (0 = product.imageUrl, 1..N = additionalImages
// in stored order), so this is literally feed order. Docs not yet stamped
// (materialized before this field existed, not yet backfilled — see
// scripts/backfillMediaFeedIndex.js) sort after every stamped doc, tiebroken
// by createdAt so the order is still deterministic.
//
// OFF: the pre-2026-08-05 sort, byte-for-byte — createdAt ascending. The
// comment this replaced claimed "hero materializes before alts, so createdAt
// asc ≈ hero-first" — real production data (Gymshark Campus Crest Zip
// Through, 2026-08-05) disproved that: the hero doc was created ~1h41m and
// ~8s AFTER its alts on two separate SKUs, so createdAt order routinely put
// alts ahead of the hero. That gap is exactly why this function exists now.
// opts.preferUgcMediaId — UGC-ads Phase 3. When set (and the UGC-first kill
// switch is on), hoists the given Media id to index 0 of the sorted stack
// AFTER the existing feedIndex-first cascade runs on the rest. For the video
// rail this is largely defensive: `generateForAd` already places `Ad.mediaId`
// at reference position 0 directly, and this sort feeds positions 1..N off
// catalog-only docs. But when the UGC-ads wizard eventually opts a UGC into
// the catalog-scoped stack (or a follow-up call composes catalog+UGC docs
// before sort), the same rule applies: operator-picked UGC owns index 0.
// Unset / no-match / flag-off → byte-identical to the pre-Phase-3 sort.
function sortCatalogMediasForReferenceStack(docs, opts = {}) {
  const list = Array.isArray(docs) ? docs.slice() : [];
  const byCreatedAtAsc = (a, b) =>
    (a.createdAt ? new Date(a.createdAt).getTime() : 0) -
    (b.createdAt ? new Date(b.createdAt).getTime() : 0);

  const sorted = !isCatalogFeedOrderSeedingEnabled()
    ? list.sort(byCreatedAtAsc)
    : list.sort((a, b) => {
        const fa = a.metadata?.feedIndex;
        const fb = b.metadata?.feedIndex;
        const ha = Number.isFinite(fa);
        const hb = Number.isFinite(fb);
        if (ha && hb) return fa - fb;
        if (ha !== hb) return ha ? -1 : 1; // stamped entries sort before unstamped
        return byCreatedAtAsc(a, b);
      });

  // Deliberately imported lazily inside the function body — atlasVideoService
  // and seededUniverseService both live in services/ but neither requires the
  // other today, and forcing a top-of-file require would create a cycle-risk
  // window during startup. The lookup happens once per sort call, and the
  // require cache means it is free after the first hit.
  const { promoteUgcFirst, isUgcFirstSeedingEnabled } = require('./seededUniverseService');
  if (!opts.preferUgcMediaId || !isUgcFirstSeedingEnabled()) return sorted;
  // promoteUgcFirst expects entries wrapped { media }; sortCatalogMedias-
  // ForReferenceStack works on bare docs. Wrap+unwrap so the helper stays a
  // single source of truth for the "hoist by id, no-op if missing" contract.
  const wrapped = sorted.map(m => ({ media: m }));
  const promoted = promoteUgcFirst(wrapped, opts.preferUgcMediaId);
  return promoted.map(w => w.media);
}

async function buildReferenceImages({
  media, product, catalogMedias = [], aspectRatio, caps = null,
  referenceCount = null, brand = null,
  // Phase 3 — when non-empty, build the identity list DIRECTLY from this
  // ordered Media-doc array (operator pick order). Position 0 = primary
  // seed. Skips seed+catalogMedias+fallback assembly entirely.
  orderedReferenceMedia = null
}) {
  const requested = Number.isFinite(referenceCount) && referenceCount >= 1
    ? Math.min(referenceCount, MAX_REFERENCE_IMAGE_COUNT)
    : DEFAULT_REFERENCE_IMAGE_COUNT;
  const maxImages = Math.min(requested, caps?.maxReferenceImages || MAX_REFERENCE_IMAGE_COUNT);

  // Ordered identity list: { mediaDoc, sourceUrl }, deduped.
  const ids = [];
  const seenMediaIds = new Set();
  const seenUrls = new Set();

  // Operator-ordered stack — no seed/catalog/fallback assembly. Only taken
  // when it yields at least one usable ref; if every pick lacks a fileUrl
  // (degenerate) we fall through to the default assembly rather than throw.
  let usedOrdered = false;
  if (Array.isArray(orderedReferenceMedia) && orderedReferenceMedia.length) {
    for (const m of orderedReferenceMedia) {
      if (!m?.fileUrl) continue;
      const mid = m._id != null ? String(m._id) : null;
      if (mid && seenMediaIds.has(mid)) continue;
      if (mid) seenMediaIds.add(mid);
      if (seenUrls.has(m.fileUrl)) continue;
      seenUrls.add(m.fileUrl);
      ids.push({ mediaDoc: m, sourceUrl: m.fileUrl });
    }
    usedOrdered = ids.length > 0;
  }
  if (!usedOrdered) {
    // SEED first — position 0.
    if (media?.fileUrl) {
      ids.push({ mediaDoc: media, sourceUrl: media.fileUrl });
      if (media._id) seenMediaIds.add(String(media._id));
      seenUrls.add(media.fileUrl);
    }

    // Catalog mirrors, skip seed id.
    //
    // `catalogMedias` ARRIVES IN MERCHANT FEED ORDER — generateForAd runs it
    // through sortCatalogMediasForReferenceStack (metadata.feedIndex asc,
    // unstamped last), per the owner's 2026-08-05 directive that refs 1/2 be
    // "the first and second other images in the feed, as they appear in the
    // feed". That replaced the old `.sort({createdAt:1})`, whose own comment
    // claimed createdAt ≈ hero-first — disproved on real Gymshark data where
    // the hero materialised AFTER its alts.
    //
    // Reordered by the configured shot-type PREFERENCE on top of that
    // (VIDEO_DEFAULT_REFERENCE_SHOT_TYPES). Unset by default, in which case
    // this is a strict no-op and the array keeps pure feed order — so the two
    // mechanisms COMPOSE: feed order is the base, shot-type preference is an
    // opt-in reorder over it. A pure reorder, never a filter: shotType is
    // absent until detect runs, so dropping on it would empty the stack for
    // freshly ingested products.
    //
    // The SOURCE dial is deliberately NOT applied here. This branch is the AUTO
    // assembly, but `catalogMedias` is also where callers deliberately place
    // operator-chosen lifestyle/social media (the source:'catalog-product'
    // filter was removed upstream precisely so those picks survive), so
    // narrowing at this depth could discard media a caller meant to include.
    // Source scoping stays with the callers and the picker default.
    const orderedCatalogMedias = referenceDefaultsService.orderByShotTypePreference(
      catalogMedias || [],
      referenceDefaultsService.videoReferenceDefaults().shotTypes
    );
    for (const cm of orderedCatalogMedias) {
      if (!cm?.fileUrl) continue;
      if (media?._id && String(cm._id) === String(media._id)) continue;
      const mid = cm._id != null ? String(cm._id) : null;
      if (mid && seenMediaIds.has(mid)) continue;
      if (mid) seenMediaIds.add(mid);
      ids.push({ mediaDoc: cm, sourceUrl: cm.fileUrl });
    }

    // FALLBACK when still < 2: product originals (no mediaDoc → no cache).
    if (ids.length < 2) {
      const originals = [];
      if (product?.imageUrl) originals.push(product.imageUrl);
      for (const alt of (Array.isArray(product?.additionalImages) ? product.additionalImages : [])) {
        if (alt) originals.push(alt);
      }
      for (const url of originals) {
        if (!url || seenUrls.has(url)) continue;
        if (media?.fileUrl && url === media.fileUrl) continue;
        seenUrls.add(url);
        ids.push({ mediaDoc: null, sourceUrl: url });
        if (ids.length >= maxImages) break;
      }
    }

    // LEGACY FALLBACK when still < 2.
    if (ids.length < 2) {
      const legacy = pickProductOnlyUrl(catalogMedias, product);
      if (legacy && !seenUrls.has(legacy) && legacy !== media?.fileUrl) {
        ids.push({ mediaDoc: null, sourceUrl: legacy });
      }
    }
  }

  // Cap BEFORE reframing — never pay for images we won't send.
  //
  // An EXPLICIT operator pick list defines its own count: picking 5 images means
  // 5, not "5 truncated to referenceImageCount". referenceImageCount is the
  // default for AUTO assembly (how many to grab when nobody chose), not a
  // ceiling on a deliberate choice — silently dropping picks 4+ was the "why did
  // it ignore the images I selected?" surprise. Still bounded by the model's own
  // maxReferenceImages, which is a hard API limit we cannot exceed.
  //
  // REPEAT_PRIMARY_REFERENCE is OFF by default (owner 2026-08-03: repeating the
  // primary increased hallucination). With it off the stack is just the first
  // `effectiveMax` distinct views — 3 on a default request — and nothing is
  // appended. When an operator explicitly switches it back on for an A/B, the
  // owner's older constraint applies: cap the stack at 4 (3 distinct + primary
  // again), distinct views fill first, and the primary is appended AFTER
  // final-URL dedupe so the deliberate duplicate is kept (seenMediaIds/seenUrls
  // and seenFinal would drop a naive in-loop repeat). Never evict a real view
  // to make room for the duplicate — only append when length < totalCap.
  const modelMax = caps?.maxReferenceImages || MAX_REFERENCE_IMAGE_COUNT;
  const effectiveMax = usedOrdered
    ? Math.min(ids.length, modelMax)
    : maxImages;
  const repeatEnabled = isRepeatPrimaryReferenceEnabled();
  const { distinctCap, totalCap } = referenceStackBudget({
    effectiveMax,
    modelMax,
    repeatEnabled,
  });
  const capped = ids.slice(0, distinctCap);
  if (usedOrdered && ids.length > distinctCap) {
    console.warn(
      `⚠️  buildReferenceImages: ${ids.length} operator picks exceed the stack budget ` +
      `(distinctCap=${distinctCap}, modelMax=${modelMax}` +
      `${repeatEnabled ? ', REPEAT_PRIMARY_REFERENCE reserves 1 closing slot' : ''}) — ` +
      `using the first ${distinctCap} in pick order`
    );
  }

  // Reframe all in parallel; preserve order.
  //
  // PER-ITEM CATCH — load-bearing, not defensive dressing. Promise.all settles
  // on the FIRST rejection, and a sibling that rejects afterwards has no
  // listener left, which on Node 20 is a FATAL unhandledRejection. That is how
  // production died on 2026-08-04: a Cloudinary "File size too large" surfaced
  // here, killed the web process one second after a 411s Omni master had
  // already been paid for, and took the whole run with it (4 ads requeued, 1
  // run marked failed).
  //
  // reframeReferenceForAspect is DOCUMENTED as never throwing — it resolves to
  // a URL or a deterministic crop. That contract is exactly what proved unsafe
  // to lean on, so it is now enforced here instead of assumed. null is already
  // handled: the dedupe loop below skips falsy entries, so a failed reframe
  // simply drops out of the reference stack and the remaining refs still ship.
  const reframed = await Promise.all(
    capped.map(id => reframeReferenceForAspect({
      media: id.mediaDoc,
      sourceUrl: id.sourceUrl,
      aspectRatio,
      brand
    }).catch((err) => {
      console.warn(
        `⚠️  buildReferenceImages: reframe failed for ${id.mediaDoc?._id || id.sourceUrl} ` +
        `[${aspectRatio}] — dropping this reference, run continues: ${err?.message || err}`
      );
      return null;
    }))
  );

  // Dedup identical final URLs, keep order.
  const out = [];
  const seenFinal = new Set();
  for (const u of reframed) {
    if (!u || seenFinal.has(u)) continue;
    seenFinal.add(u);
    out.push(u);
  }

  // Primary-as-closing-ref: append AFTER seenFinal so the same URL may
  // appear twice. Plain post-dedupe duplicate is fine — consumers send the
  // array as ordered reference images; nothing re-dedupes downstream of here
  // before the model payload is built.
  return appendPrimaryReferenceRepeat(out, { enabled: repeatEnabled, totalCap });
}

// ── Polling ───────────────────────────────────────────────────────────

// Max consecutive errors for GENUINE transient failures (network blips,
// generic 5xx). 4xx fails immediately; rate-limit responses (429 or a
// 5xx wrapping a 429 body — see isRateLimit below) get their own
// exponential backoff and DO NOT count against this budget. Tuned for
// Grok's documented 1 RPS ceiling, which routinely burned through 6+
// polls in a burst when VEO_CONCURRENCY > 1; Gemini Omni's Atlas rate
// limit is unpublished, so the same defensive budget stays. With
// POLL_INTERVAL=5s, cap of 12 gives ~60s of leeway for other
// transients before surfacing the error.
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env.ATLAS_MAX_CONSECUTIVE_ERRORS, 10) || 12;

// Prediction states that are SETTLED — the task is over and the body is a
// verdict, not noise. Used to tell "this response tells us the outcome" from
// "this response tells us nothing", INDEPENDENTLY of the HTTP status code.
//
// Atlas delivers a settled verdict inside an HTTP 500 for a failed generation:
//   HTTP 500  { code: 500, message: "Generation failed: task processing failed
//               (code: generation_failed)",
//               data: { status: "failed", outputs: null, executionTime: 0, … } }
// Verified live 2026-08-10 against five real failed predictions — every one
// returned HTTP 500 with a complete `data.status:'failed'`. The same prediction
// was observed returning HTTP 200 earlier in its life, so the status code is
// NOT a reliable discriminator and only the body is.
//
// docs/ATLAS.md §4 already draws exactly this line: a poll error "may carry
// information about the task (`data.status:'failed'`, a coded {code,msg}
// envelope) — or none at all (a CDN/WAF/proxy error page)". The bare-5xx
// handling below is for the second kind and is deliberately unchanged.
// The terminal FAILURE states. Kept identical to `predictionFailed.match` in
// atlasErrorPolicy so classification and poll/peek termination cannot disagree:
// a status the policy calls a failure but the poll does not recognise would be
// logged as "still running" and burn the whole MAX_POLL_MS budget before timing
// out — and a timeout carries no policy metadata, so it would never reach the
// retry gate either.
const TERMINAL_FAILURE_STATUSES = new Set([
  'failed', 'error', 'cancelled', 'canceled', 'rejected'
]);
const TERMINAL_OK_STATUSES = new Set(['completed', 'succeeded']);

const SETTLED_POLL_STATUSES = new Set([
  ...TERMINAL_OK_STATUSES, ...TERMINAL_FAILURE_STATUSES
]);

// Rate-limit backoff schedule (ms). Applied on each consecutive rate-limit
// hit — resets on the next non-rate-limit response. Caps at the last value.
// Defaults tuned for Grok's roughly per-second window (30s clears it
// easily; the longer tail stops a stuck rate-limit from hammering Atlas).
// Gemini Omni's real limit is unpublished — override the schedule via
// ATLAS_RATE_LIMIT_BACKOFF_MS (comma-separated ms values) if it proves
// tighter or looser in practice.
const RATE_LIMIT_BACKOFF_MS = (() => {
  const raw = String(process.env.ATLAS_RATE_LIMIT_BACKOFF_MS || '').trim();
  if (raw) {
    const parsed = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
    if (parsed.length) return parsed;
    console.warn(`⚠️  atlasVideo: unparseable ATLAS_RATE_LIMIT_BACKOFF_MS='${raw}' — using defaults`);
  }
  return [30_000, 60_000, 120_000, 120_000];
})();

function summarizeAxiosError(err) {
  const status = err.response?.status;
  // Atlas typically puts diagnostic detail in response.data.error or
  // response.data.message — strip the noise (HTML pages, huge stack
  // traces) and surface the load-bearing string. Fall back to err.message
  // when no body is parseable.
  const body = err.response?.data;
  let bodyStr = null;
  if (body) {
    if (typeof body === 'string') bodyStr = body.slice(0, 400);
    else if (body.error)          bodyStr = typeof body.error === 'string' ? body.error : JSON.stringify(body.error).slice(0, 400);
    else if (body.message)        bodyStr = String(body.message).slice(0, 400);
    else                          bodyStr = JSON.stringify(body).slice(0, 400);
  }
  return { status, body: bodyStr, message: err.message };
}

// Atlas wraps upstream provider errors in its own envelope. Grok's 1 RPS
// rate-limit surfaces as HTTP 500 with a body like:
//   {"error":"unexpected http status code: 429, body: {\"code\":429,...}"}
// So we can't rely on `err.response.status === 429` alone — inspect the
// body for the tell-tale 429 signature or common phrasing.
function isRateLimit(summary) {
  if (!summary) return false;
  if (summary.status === 429) return true;
  const body = String(summary.body || summary.message || '').toLowerCase();
  // Same `(?!\d)` digit-boundary guard as isDefinite429 below — `code: 42901` is
  // not a 429. Harmless here (a mis-read only lengthens a poll backoff, and polls
  // are free to retry) but wrong is wrong, and the two predicates should not
  // disagree about what the word "429" means.
  return /(\bcode\b"?\s*[:=]\s*429(?!\d)|\bstatus\b"?\s*[:=]\s*429(?!\d)|http status code:\s*429(?!\d)|rate[- ]?limit|too many requests)/i.test(body);
}

// STRICTER sibling of isRateLimit, for the BILLABLE submit path only.
//
// isRateLimit is correct for polling, where a retry is free — so it casts wide,
// including the bare phrases "rate limit" / "too many requests" matched against
// JSON.stringify(<arbitrary envelope>).slice(0, 400). On a submit a retry is a
// second POST, so inference from a loose substring is the wrong evidence bar:
// we retry only on a STRUCTURED 429 signal, which is positive proof the request
// was rejected upstream before any generation began (and therefore unbilled).
//
// Deliberately NOT matched here: bare "rate limit"/"too many requests" prose. A
// 5xx from an unrelated cause whose envelope merely contains those words would
// otherwise be replayed. Cost of being wrong is asymmetric — a declined submit
// is a retryable ad, a duplicated submit is money already spent.
//
// Client-side failures (ECONNRESET, "timeout of 60000ms exceeded") match neither
// this nor isRateLimit, so they still throw on the first attempt. That is the
// correct call: a timed-out POST may well have landed server-side, and there is
// no prediction id to reconcile against.
// Two details here are load-bearing, NOT decoration. Both were caught by tests
// after adversarial review; keep them if this regex is ever edited.
//
// 1. `(?!\d)` after each 429. Without it `code: 42901`, `status: 42917` and
//    `http status code: 42999` all match — any longer integer merely PREFIXED by
//    429. A validation error carrying such a field id would read as a definite
//    rate-limit and get replayed: a second billable POST for an error that had
//    nothing to do with rate limiting.
// 2. `"?` before the separator. The documented Atlas envelope embeds JSON —
//    `{"error":"unexpected http status code: 429, body: {\"code\":429,...}"}` —
//    and `\bcode\b\s*[:=]` cannot match `"code":429`, because the quote sits
//    between the key and the colon. That envelope only matched at all via the
//    `http status code: 429` alternative; a body carrying ONLY the JSON marker
//    would have been misread as "not a rate limit". Safe direction (fail rather
//    than double-bill) but wrong, so it is fixed rather than tolerated.
function isDefinite429(summary) {
  if (!summary) return false;
  if (summary.status === 429) return true;
  const body = String(summary.body || summary.message || '');
  return /(\bcode\b"?\s*[:=]\s*429(?!\d)|\bstatus\b"?\s*[:=]\s*429(?!\d)|http status code:\s*429(?!\d))/i.test(body);
}

/**
 * The whole replay decision for a failed billable submit, as ONE pure function.
 *
 * Extracted from the catch block so the money-critical choice is unit-testable
 * without mocking axios — scripts/verifySubmitGuard.js drives this directly. The
 * catch block must contain no replay logic of its own; if a case is missing, add
 * it HERE so the harness covers it.
 *
 * Returns one of:
 *   'retry'            — proven 429 and attempts remain: safe to POST again
 *   'throw-429'        — proven 429 but attempts exhausted
 *   'throw-maybe-429'  — looks rate-limited but unproven: deliberately NOT replayed
 *   'throw-other'      — anything else, including timeouts and resets
 */
function submitRetryDecision(summary, attempt, maxAttempts) {
  if (isDefinite429(summary)) {
    return attempt < maxAttempts ? 'retry' : 'throw-429';
  }
  if (isRateLimit(summary)) return 'throw-maybe-429';
  return 'throw-other';
}

// ── Per-model submit pacing ───────────────────────────────────────────
//
// Atlas rate limits are per (team, model) RPS and some models are 1 RPS. Firing
// N same-model submits at once bursts past that and all-but-one fail server-side
// — which is exactly the condition the submit retry below was added to absorb.
// Pacing PREVENTS the collision instead of reacting to it: same-model submits are
// serialized and spaced apart (start-to-start) PER MODEL SLUG, while different
// models run in parallel as independent buckets.
//
// PER-MODEL-SLUG is load-bearing for VEO_CONCURRENCY > 1: Omni and Grok have
// separate gates. Raising the video pool must not let Grok (aspect-fallback,
// documented 1 RPS) share a global serial queue OR lose its floor. Spacing is
// resolved by services/concurrency.submitSpacingMsForModel — Grok always gets
// at least GROK_MIN_SUBMIT_SPACING_MS (PROVIDER-IMPOSED 1 RPS) even when
// ATLAS_SUBMIT_SPACING_MS is 0.
//
// This only ever DELAYS the single POST a task makes — it never retries one.
// Ported from reach-social-llm-expander src/lib/atlas.ts:69-99; keep the two in
// step, the reasoning is identical.
//
// SINGLE-PROCESS ASSUMPTION, and it matters: this gate is in-memory, so two web
// instances keep two independent gates and the effective rate doubles. It is a
// real improvement within one process and NOT a global limiter. It becomes
// globally true once rendering moves to the single-instance worker (see
// ARCHITECTURE_REVIEW.md "The render-queue architecture problem"); until then
// VEO_CONCURRENCY per-process remains the weak link.
const {
  concurrency: CONC,
  submitSpacingMsForModel,
  isGrokModel
} = require('./concurrency');
const SUBMIT_SPACING_MS = CONC.ATLAS_SUBMIT_SPACING_MS;

const _modelSubmitGate = new Map();
const _modelLastSubmitAt = new Map();

/** Run `fn` serialized + rate-spaced against other submits for the SAME model, process-wide. */
function pacedModelSubmit(model, fn) {
  const spacingMs = submitSpacingMsForModel(model);
  const run = async () => {
    if (spacingMs > 0) {
      const last = _modelLastSubmitAt.get(model);
      const wait = last == null ? 0 : last + spacingMs - Date.now();
      if (wait > 0) {
        console.log(`   ⏱️  atlasVideo: pacing submit for ${model} — waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    // Stamp BEFORE the call so spacing is start-to-start: a slow submit must not
    // let the next one fire the instant it returns.
    _modelLastSubmitAt.set(model, Date.now());
    return fn();
  };
  // Chain after the previous submit for this model to serialize the bucket. The
  // stored tail swallows the outcome so one failure never wedges the chain, while
  // the caller still sees `next` reject. Keyed by model slug — Omni and Grok
  // never share a gate.
  const next = (_modelSubmitGate.get(model) || Promise.resolve()).then(run);
  _modelSubmitGate.set(model, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Poll an Atlas prediction to completion.
 *
 * @param {string} predictionId
 * @param {{ shouldCancel?: Function, adId?: any, stagePrefix?: string }} [opts]
 *   stagePrefix — when set with adId, each poll tick fire-and-forget-writes
 *   `"${stagePrefix} — polling 4m10s (17)"` so the activity board shows motion
 *   without a new timer. Defaults to no stage write (reframe / non-ad callers).
 */
/**
 * SINGLE-SHOT prediction status check. Free — a GET, never a submit.
 *
 * pollPrediction blocks up to MAX_POLL_MS (10 min), which is right inside a
 * render and wrong at boot: recovery must not hold startup open, and an ad that
 * is still processing simply gets checked again on the next sweep.
 *
 * Returns one of:
 *   { state: 'done',       videoUrl }        terminal, asset available
 *   { state: 'processing' }                  still running — leave it alone
 *   { state: 'failed',     message, policy } terminal, classified
 *   { state: 'unknown',    message }         we could not tell; DO NOT act
 *
 * 'unknown' is deliberately distinct from 'failed'. A transport error tells us
 * nothing about the prediction, and treating it as failure is how a paid asset
 * gets written off — or worse, re-submitted.
 */
async function peekPrediction(predictionId) {
  if (!predictionId) return { state: 'unknown', message: 'no prediction id' };
  if (!apiKey()) return { state: 'unknown', message: 'ATLAS_API_KEY not configured' };
  let res;
  try {
    res = await axios.get(`${BASE_URL}/model/prediction/${predictionId}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      timeout: 20_000,
      validateStatus: () => true
    });
  } catch (err) {
    return { state: 'unknown', message: err.message };
  }
  const data = res.data?.data || {};
  const status = String(data.status || '').toLowerCase();
  // Bail on a non-2xx ONLY when it carries no verdict. A failed Atlas video
  // prediction is served as HTTP 500 with a complete `data.status:'failed'`
  // body (verified live 2026-08-10, 5/5 failed predictions), and the old
  // status-first guard returned 'unknown' for every one of them — so recovery
  // could never settle a confirmed-failed video and its charge state stayed
  // permanently unresolved. 'unknown' must mean "we could not tell", not "we
  // did not look".
  if (res.status !== 200 && !SETTLED_POLL_STATUSES.has(status)) {
    return { state: 'unknown', message: `HTTP ${res.status}` };
  }
  if (TERMINAL_OK_STATUSES.has(status)) {
    const raw = data.outputs ?? data.output ?? [];
    const url = Array.isArray(raw) ? raw[0] : raw;
    // Completed WITHOUT an output is the genuine "paid for nothing" case and is
    // classified as such rather than silently treated as still-running.
    return url
      ? { state: 'done', videoUrl: url }
      : { state: 'failed', message: 'completed with no output url', policy: 'completedNoOutput' };
  }
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    const providerMsg = data.error || status;
    const policy = classify({
      predictionStatus: 'failed', msg: providerMsg, nsfw: data.has_nsfw_contents ?? null
    });
    return {
      state: 'failed',
      message: `${policy.label || 'atlasVideo: prediction failed'}: ${providerMsg}`,
      policy: policy.name,
      ...confirmedCharge(data)
    };
  }
  return { state: 'processing' };
}

/**
 * The CONFIRMED charge for a settled prediction, read from Atlas's own record.
 *
 * `data.price` is the authority — costTracker/atlasImageService already treat it
 * that way, and §4's owner rule is that a charge may only be asserted from a
 * CONFIRMED price on the settled prediction. Measured live 2026-08-10 on ten
 * real video predictions:
 *
 *   succeeded → price "0.75" (full-length) / "0.08" (short)   5 of 5
 *   failed    → price ABSENT ENTIRELY                          5 of 5
 *
 * which matches Atlas's documented behaviour and the note already in
 * atlasImageService: "Atlas refunds the reservation on a failed task and never
 * bills a rejection".
 *
 * Returns the TRI-STATE, never a guess:
 *   charged:true  — a positive price is present. Real money. Never retry.
 *   charged:false — the prediction is settled AND carries no price. Safe to retry.
 *   charged:null  — we could not read a settled record. UNKNOWN; treat as charged
 *                   for any spend decision. Absence of evidence is not evidence.
 */
/**
 * MAY WE SPEND AGAIN? Isolated from the render flow so every combination can be
 * exercised offline — this one boolean is the difference between recovering a
 * lost video and double-billing for it.
 *
 * ALL THREE must hold:
 *   policyRetryable === true   the failure class is non-deterministic. Excludes
 *                              moderationBlocked (action:'give-up'), which would
 *                              be blocked identically on a resubmit.
 *   chargeConfirmed === false  Atlas's settled record confirms NO price. Strict
 *                              `=== false`: `null` means we could not read the
 *                              record, and unknown is treated as CHARGED.
 *   attempt < maxAttempts      the policy's own ceiling (predictionFailed: 3).
 */
function mayRetryAfterFailure({ policyRetryable, chargeConfirmed, attempt, maxAttempts }) {
  return policyRetryable === true
    && chargeConfirmed === false
    && Number(attempt) < Number(maxAttempts || 1);
}

function confirmedCharge(data) {
  const status = String(data?.status || '').toLowerCase();
  if (!SETTLED_POLL_STATUSES.has(status)) return { charged: null, priceUsd: null };
  const raw = data.price;
  if (raw === undefined || raw === null || raw === '') return { charged: false, priceUsd: 0 };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { charged: null, priceUsd: null };
  return { charged: n > 0, priceUsd: n };
}

/**
 * Defensive parse of Atlas's settled prediction `price`.
 *
 * Atlas returns the figure as a STRING (measured: `"0.9"`, `"0.75"`). A bad
 * value must NEVER overwrite a ledger estimate with 0 — an unusable price
 * leaves the estimate in place for a later re-poll (or forever).
 *
 * Returns a finite positive number, or null when the value is unusable.
 * Exported for scripts/verifyVideoCostReconcile.js.
 */
function parseAtlasSettledPrice(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Re-poll a settled prediction and upgrade its CostLog row from estimate →
 * actual. Fire-and-forget: a finished video must never wait on telemetry.
 *
 * Mirrors atlasImageService.scheduleCostReconcile. Same delay budget — the
 * GET is free, unref'd, and cannot delay or fail a render. Image path needs
 * this often (price usually lands after the image returns); video path
 * usually has the price on the terminal poll (measured 2026-08-11 on Omni
 * developer) and only falls through here when that value is absent.
 *
 * Uses reconcileCost (not finalizeFlatCost) so a late/duplicate call cannot
 * overwrite a row already marked actual, and a missing row is left missing
 * rather than inventing spend.
 */
function scheduleVideoCostReconcile(predictionId, attempt = 0) {
  if (!predictionId) return;
  const delays = [3000, 10_000, 30_000, 60_000, 120_000, 300_000];
  if (attempt >= delays.length) {
    console.warn(
      `   ⚠️  atlasVideo: cost for ${predictionId} never published after ${delays.length} reads — ` +
      `row stays estimated (MODEL_CAPS formula; Omni developer 10s is ~33% HIGH vs settled $0.90 — do not treat as spend)`
    );
    return;
  }
  setTimeout(async () => {
    try {
      const res = await axios.get(`${BASE_URL}/model/prediction/${predictionId}`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
        timeout: 15_000,
        validateStatus: () => true
      });
      const price = parseAtlasSettledPrice(res.data?.data?.price);
      if (price != null) {
        await reconcileCost({ providerRequestId: predictionId, costUsd: price });
        return;
      }
      scheduleVideoCostReconcile(predictionId, attempt + 1);
    } catch (err) {
      console.warn(`   ⚠️  atlasVideo: cost reconcile read failed for ${predictionId}: ${err.message}`);
      scheduleVideoCostReconcile(predictionId, attempt + 1);
    }
  }, delays[attempt]).unref?.();
}

/**
 * Upgrade the charge-point CostLog row to Atlas's settled price once the
 * prediction is terminal-ok.
 *
 * IMPORTANT MEASURED DIFFERENCE vs images (2026-08-11): for VIDEO the price
 * appears to be published AT completion — both live 10s 1080p 16:9 Omni
 * developer predictions carried `price:"0.9"` on the terminal poll. Images
 * usually publish later (7/38 had price at completion). So: if the terminal
 * payload already carries a usable price, finalize IMMEDIATELY and do not
 * schedule a re-poll. Only fall back to scheduleVideoCostReconcile when the
 * terminal response has no usable price.
 *
 * Fire-and-forget by contract: callers MUST NOT await this. The helper never
 * throws into the render path (finalize failures are swallowed).
 *
 * Uses finalizeFlatCost keyed on providerRequestId so the charge-point row is
 * UPDATED in place — a second recordFlatCost would double-count spend.
 * costSource:'actual' matches the image path's settled-price marking.
 *
 * deps is for offline harness injection only (no DB/network).
 *
 * Returns a small decision object for harnesses:
 *   { action: 'immediate', costUsd, scheduled: false }
 *   { action: 'scheduled', costUsd: null, scheduled: true }
 */
function reconcileVideoCostFromTerminal(predictionId, terminalData = {}, deps = {}) {
  if (!predictionId) return { action: 'noop', costUsd: null, scheduled: false };
  const costUsd = parseAtlasSettledPrice(terminalData?.price);
  if (costUsd != null) {
    // Immediate path — terminal poll already has the settled figure.
    const finalize = deps.finalizeFlatCost || finalizeFlatCost;
    try {
      const ret = finalize({
        providerRequestId: predictionId,
        costUsd,
        costSource: 'actual',
        // Charge-point wrote status:'submitted'; a successful delivery is 'ok'
        // (matches atlasImageService's completed branch).
        status: deps.status || 'ok',
      });
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => {
          console.warn(
            `   ⚠️  atlasVideo: cost finalize failed for ${predictionId}: ${err?.message || err}`
          );
        });
      }
    } catch (err) {
      console.warn(
        `   ⚠️  atlasVideo: cost finalize threw for ${predictionId}: ${err?.message || err}`
      );
    }
    return { action: 'immediate', costUsd, scheduled: false };
  }
  // No usable price on the terminal payload — schedule the image-shaped
  // re-poll. Leave the estimate untouched until a real figure lands.
  const schedule = deps.schedule || scheduleVideoCostReconcile;
  try {
    schedule(predictionId);
  } catch (err) {
    console.warn(
      `   ⚠️  atlasVideo: could not schedule cost reconcile for ${predictionId}: ${err?.message || err}`
    );
  }
  return { action: 'scheduled', costUsd: null, scheduled: true };
}

/**
 * RESUME a video generation from its spend receipt (Ad.veoPredictionId).
 *
 * THIS FUNCTION MUST NEVER SUBMIT. That is its entire reason to exist: the
 * receipt means the provider already charged us, so the only correct move is to
 * collect what we paid for. A submit here would double-bill, which is precisely
 * the hole services/spendReceipt.js documents. scripts/verifyVideoResume.js
 * asserts on this function's source that it contains no submit call.
 */
async function resumeForAd({ ad } = {}) {
  const predictionId = ad?.veoPredictionId || null;
  if (!predictionId) return { resumed: false, state: 'no-receipt' };
  const peek = await peekPrediction(predictionId);
  return { resumed: peek.state === 'done', predictionId, ...peek };
}

async function pollPrediction(predictionId, { shouldCancel = null, adId = null, stagePrefix = null } = {}) {
  const t0 = Date.now();
  let pollCount = 0;
  let consecutiveErrors = 0;
  let consecutiveRateLimits = 0;
  let lastError = null;
  const writePollStage = () => {
    // Fire-and-forget, never awaited. Throttled inside adStage.
    if (adId && stagePrefix) {
      adStage(adId, `${stagePrefix} — polling ${formatElapsed(Date.now() - t0)} (${pollCount})`);
    }
  };
  writePollStage();
  while (Date.now() - t0 < MAX_POLL_MS) {
    // Jitter the poll interval by 0–3s so concurrent jobs desync — without
    // this, N workers with the same POLL_INTERVAL burn through Grok's 1 RPS
    // budget in lockstep, converting every poll cycle into a rate-limit
    // burst even before the submission traffic weighs in.
    const jitter = Math.floor(Math.random() * 3000);
    await new Promise(r => setTimeout(r, POLL_INTERVAL + jitter));
    // Cooperative cancel: stop WAITING on the provider job (it may still
    // complete server-side — no provider cancel API assumed) and let the
    // caller mark its run cancelled.
    if (shouldCancel && await shouldCancel()) {
      const e = new Error('video poll cancelled by operator');
      e.code = 'CANCELLED';
      throw e;
    }
    pollCount++;
    writePollStage();
    let res;
    try {
      res = await axios.get(`${BASE_URL}/model/prediction/${predictionId}`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
        timeout: 30000
      });
      consecutiveErrors = 0;   // reset on any successful HTTP response
      consecutiveRateLimits = 0;
      lastError = null;
    } catch (err) {
      const summary = summarizeAxiosError(err);
      lastError = summary;
      const status = summary.status;

      // Rate limit (either 429 direct or 5xx wrapping a 429 body from the
      // upstream provider). Doesn't count against consecutiveErrors — just
      // back off and keep polling. Grok's 1 RPS ceiling routinely trips
      // this when VEO_CONCURRENCY > 1 or when submissions collide with
      // an in-flight burst of polls.
      if (isRateLimit(summary)) {
        consecutiveRateLimits++;
        const backoffMs = RATE_LIMIT_BACKOFF_MS[Math.min(consecutiveRateLimits - 1, RATE_LIMIT_BACKOFF_MS.length - 1)];
        console.warn(
          `   ⏳ atlasVideo: poll #${pollCount} rate-limited ` +
          `(hit #${consecutiveRateLimits}, backing off ${backoffMs / 1000}s): ${summary.body || summary.message}`
        );
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      // A non-2xx that CARRIES A SETTLED VERDICT is the task's outcome, not a
      // transport blip. Promote the error response onto the normal path so the
      // completed/failed branches below classify it exactly as they would a 200.
      //
      // Without this, Atlas's HTTP-500-with-`data.status:'failed'` fell into the
      // generic branch below and was retried MAX_CONSECUTIVE_ERRORS times —
      // observed in production 2026-08-10, prediction cec47abe…: 12 polls over
      // 3 minutes against a prediction that had already failed, then a
      // "12 consecutive poll failures" error that reads like an Atlas outage
      // instead of naming the real failure class. It also discarded the
      // classification, so a moderation block arriving in a 500 would never be
      // named and would be pointlessly retried.
      const settled = err.response?.data?.data;
      const settledStatus = String(settled?.status || '').toLowerCase();
      if (!SETTLED_POLL_STATUSES.has(settledStatus)) {
        // 4xx (non-429) is a hard failure — bad predictionId / bad auth / etc.
        // Retrying won't help, and the body has the real diagnosis.
        if (status && status >= 400 && status < 500) {
          throw new Error(`atlasVideo: poll returned ${status} (id=${predictionId}): ${summary.body || summary.message}`);
        }

        consecutiveErrors++;
        consecutiveRateLimits = 0;
        console.warn(
          `   ⚠️  atlasVideo: poll #${pollCount} error ${status || 'network'} ` +
          `(${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS} consecutive): ${summary.body || summary.message}`
        );

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(
            `atlasVideo: ${MAX_CONSECUTIVE_ERRORS} consecutive poll failures (id=${predictionId}). ` +
            `Last error: ${status || 'network'} ${summary.body || summary.message}`
          );
        }
        continue;
      }

      console.warn(
        `   ↳ atlasVideo: poll #${pollCount} HTTP ${status} carries a settled verdict ` +
        `(status=${settledStatus}) — reading it as the outcome, not a transport blip`
      );
      res = err.response;
      consecutiveErrors = 0;
      consecutiveRateLimits = 0;
      lastError = null;
    }
    const data = res.data?.data || {};
    const status = data.status;
    if (TERMINAL_OK_STATUSES.has(status)) {
      // Providers vary the result field: `outputs` (array) is the
      // common case, but some return `output` as a string or array —
      // accept both (mirrors Atlas's own reference client).
      const raw = data.outputs ?? data.output ?? [];
      const url = Array.isArray(raw) ? raw[0] : raw;
      if (!url) throw new Error(`atlasVideo: ${status} but no output url (predictionId=${predictionId})`);
      const elapsedSec = Math.round((Date.now() - t0) / 1000);
      console.log(`🎬 atlasVideo: ${predictionId} done after ${elapsedSec}s (${pollCount} polls)`);
      // Return the settled `price` alongside the URL so the caller can
      // reconcile the charge-point CostLog row WITHOUT a second GET when
      // Atlas already published the figure (the common video case —
      // measured 2026-08-11). Shape is { url, price }; price may be
      // absent/null — reconcileVideoCostFromTerminal handles that.
      return { url, price: data.price ?? null };
    }
    if (TERMINAL_FAILURE_STATUSES.has(status)) {
      // Classify before throwing. The image path has routed failures through
      // atlasErrorPolicy since it was written; this one never did, so a safety
      // rejection surfaced to the operator as a bare "prediction failed" and
      // read as a transient fault. Real example, 2026-08-04:
      //   "Your input or generated content was blocked by safety review."
      // A moderation block is deterministic — the same prompt and reference
      // will be blocked again — so it must be NAMED, not retried behind
      // generic prose. `label` is null for every other class, which keeps the
      // provider's own wording for anything we have not classified.
      const providerMsg = data.error || 'unknown';
      const policy = classify({
        predictionStatus: status,
        msg: providerMsg,
        nsfw: data.has_nsfw_contents ?? null
      });
      const heading = policy.label || 'atlasVideo: prediction failed';
      const err = new Error(`${heading}: ${providerMsg} (id=${predictionId})`);
      err.atlasPolicy = policy.name;
      err.terminal    = policy.terminal;
      // Carry the retry decision to the caller. A retry means a NEW billable
      // submit, so it cannot be decided here (this function only polls) — but
      // everything needed to decide it is known here and nowhere else.
      // `chargeConfirmed` is read from Atlas's own settled record, not inferred
      // from the policy: the policy says what SHOULD happen, the price says what
      // DID. generateForAd requires both to agree before it spends again.
      err.predictionId    = predictionId;
      err.policyRetryable = policy.retryable === true;
      err.policyMaxAttempts = policy.maxAttempts || 1;
      // The policy owns the wait between attempts. Carried here because
      // generateForAd is the only place that can act on it, and re-classifying
      // there would rebuild the policy from an error shape it no longer has.
      // `n` is 0-BASED, matching backoffFor's contract and the image path's
      // call convention — generateForAd's loop is 1-based and converts.
      err.policyBackoffFor = (n) => policy.backoffFor(n);
      const charge = confirmedCharge(data);
      err.chargeConfirmed = charge.charged;   // true | false | null(unknown)
      err.chargePriceUsd  = charge.priceUsd;
      throw err;
    }
    const elapsedSec   = Math.round((Date.now() - t0) / 1000);
    const remainingSec = Math.round((MAX_POLL_MS - (Date.now() - t0)) / 1000);
    console.log(`🎬 atlasVideo: polling ${predictionId} — status=${status} (elapsed=${elapsedSec}s, remaining=${remainingSec}s, poll #${pollCount})`);
  }
  const tail = lastError ? ` Last error: ${lastError.status || 'network'} ${lastError.body || lastError.message}` : '';
  throw new Error(`atlasVideo: prediction timed out after ${MAX_POLL_MS / 1000}s (id=${predictionId}).${tail}`);
}

// ── Submission ────────────────────────────────────────────────────────

// Pure body construction — kept side-effect free so the dry-run script
// (scripts/dryRunVideoSubmit.js) and unit tests can exercise the exact
// request shape without POSTing.
// durationSec is expected already clamped by resolveDurationSec — each
// paramShape still applies model-specific bounds (enum snap, ends≤10,
// maxDuration) as a defensive floor, but callers should not rely on
// that path for operator-facing validation.
// Which of the assembled reference images this model shape ACTUALLY receives.
//
// Single source of truth for two consumers that must never disagree: the request
// body below, and the audit record persisted as Ad.veoReferenceImages and shown
// in the generation inspector. Previously the inspector was handed the full
// assembled stack while several shapes submit less than that — so on a
// 1-reference model (grok-imagine i2v, veo3.1) the inspector displayed three
// images when exactly one was sent, with nothing indicating the difference. An
// audit surface that overstates what a paid call received is worse than no audit
// surface, because it is trusted.
//
// Keep this switch EXHAUSTIVE against buildSubmissionBody's cases.
function submittedImageUrls(imageUrls, caps) {
  const urls = Array.isArray(imageUrls) ? imageUrls : [];
  switch (caps?.paramShape) {
    case 'gemini-omni':     return urls;                                        // images: full stack
    case 'gemini-omni-r2v': return urls.slice(0, caps.maxReferenceImages || 5);  // images: clamped
    case 'grok':            return urls;                                        // image_urls: full stack
    case 'grok-i2v':                                                            // image_url: single frame
    case 'veo':                                                                 // image_url: single frame
    default:                return urls.slice(0, 1);                            // generic: single frame
  }
}

function buildSubmissionBody({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl = null, durationSec = null }) {
  switch (caps.paramShape) {
    case 'gemini-omni':
      // duration MUST be sent explicitly (Atlas enum 4|6|8|10) — the 8s
      // output is a downstream contract (brand scripts assume 8s @ 24fps).
      return {
        model,
        prompt,
        images: submittedImageUrls(imageUrls, caps),
        duration: durationSec || caps.defaultDuration || 8,
        aspect_ratio: aspectRatio,
        resolution: process.env.ATLAS_VIDEO_RESOLUTION || caps.defaultResolution || '720p'
      };
    case 'gemini-omni-r2v': {
      // Schema requires video_clips: [{url, start, ends}] with a ≤10s
      // trimmed window. The Cloudinary segment URL is already trimmed
      // (du_N), so start/ends restate the same window for the API;
      // when the seed isn't a Cloudinary asset we send the raw URL and
      // let start/ends do the trim server-side.
      const duration = durationSec || caps.defaultDuration || 8;
      return {
        model,
        prompt,
        video_clips: [{ url: videoClipUrl, start: 0, ends: Math.min(10, duration) }],
        images: submittedImageUrls(imageUrls, caps),
        duration,
        aspect_ratio: aspectRatio,
        resolution: process.env.ATLAS_VIDEO_RESOLUTION || caps.defaultResolution || '720p'
      };
    }
    case 'grok':
      return {
        model,
        prompt,
        image_urls: submittedImageUrls(imageUrls, caps),
        duration: Math.min(caps.maxDuration, durationSec || 8),
        resolution: '720p',
        aspect_ratio: aspectRatio
      };
    case 'grok-i2v':
      // Single starting frame (schema: image_url is one string). The
      // position-0 reference is the pre-cropped seed composition, so
      // the frame already matches the canvas aspect. durationSec is
      // already clamped by resolveDurationSec at the call site.
      return {
        model,
        prompt,
        image_url: submittedImageUrls(imageUrls, caps)[0],
        duration: durationSec || caps.defaultDuration || 8,
        resolution: caps.defaultResolution || '720p',
        aspect_ratio: aspectRatio
      };
    case 'veo':
      return {
        model,
        prompt,
        image_url: submittedImageUrls(imageUrls, caps)[0],
        aspect_ratio: aspectRatio
      };
    default:
      return {
        model,
        prompt,
        image_url: submittedImageUrls(imageUrls, caps)[0]
      };
  }
}

async function submitGeneration({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl = null, durationSec = null }) {
  const body = buildSubmissionBody({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl, durationSec });

  // refs= reports what the model RECEIVES, and names the assembled count too
  // when the shape takes fewer. Reading "refs=3" for a 1-reference model was
  // misleading in exactly the place you would check it — and it hid the fact
  // that two of those reframes had been paid for and then discarded.
  const sentRefs = submittedImageUrls(imageUrls, caps);
  const refsLabel = sentRefs.length === imageUrls.length
    ? `refs=${sentRefs.length}`
    : `refs=${sentRefs.length} (of ${imageUrls.length} assembled — ${caps.paramShape} accepts fewer)`;
  console.log(
    `🎬 atlasVideo.submit: model=${model} aspect=${aspectRatio} ${refsLabel} ` +
    `paramShape=${caps.paramShape} promptChars=${prompt.length} promptBytes=${Buffer.byteLength(prompt, 'utf8')} promptProfile=${promptProfileFor(caps)}`
  );



  // Bounded retry on a STRUCTURED 429 only — see isDefinite429. Pacing above
  // (pacedModelSubmit) is the primary defence: it spaces same-model submits so the
  // per-(team,model) RPS ceiling is not breached in the first place. This retry is
  // the residual safety net for a 429 we did not manage to avoid, and it fires only
  // when the response proves the request was rejected before any generation began.
  //
  // Everything else — client timeouts, connection resets, 5xx with no explicit 429
  // marker, loose "rate limit" prose — throws on the first attempt. A POST that may
  // have landed is NEVER replayed: there is no prediction id to reconcile against,
  // so a replay risks paying twice for one ad.
  // Cap of 4 attempts (1 initial + 3 backoffs).
  const maxAttempts = 4;
  let consecutiveRateLimits = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await pacedModelSubmit(model, () => axios.post(
        `${BASE_URL}/model/generateVideo`,
        body,
        {
          headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
          timeout: 60000,
          // maxRedirects: 0 — axios defaults to 5 and RE-SENDS the request body on a
          // 307/308, which on a billable endpoint is a silent double submit inside a
          // single call (invisible to the retry logic below, which never sees it). A
          // generation endpoint has no legitimate reason to redirect, so treat any 3xx
          // as an error: axios then rejects, the catch runs, no 429 marker matches, and
          // we surface it instead of paying twice.
          maxRedirects: 0
        }
      ));
      const predictionId = res.data?.data?.id;
      if (!predictionId) throw new Error(`atlasVideo: no prediction id in response: ${JSON.stringify(res.data).slice(0, 300)}`);
      return predictionId;
    } catch (err) {
      // "no prediction id" is a successful HTTP response with a bad body —
      // not a rate-limit; rethrow immediately. NB this is also the one case where
      // a billable generation may exist without us holding its id.
      if (err.message && err.message.startsWith('atlasVideo: no prediction id')) throw err;

      const summary = summarizeAxiosError(err);
      const decision = submitRetryDecision(summary, attempt, maxAttempts);
      if (decision === 'retry') {
        consecutiveRateLimits++;
        const backoffMs = RATE_LIMIT_BACKOFF_MS[Math.min(consecutiveRateLimits - 1, RATE_LIMIT_BACKOFF_MS.length - 1)];
        console.warn(
          `   ⏳ atlasVideo: submit rate-limited ` +
          `(hit #${consecutiveRateLimits}, attempt ${attempt}/${maxAttempts}, backing off ${backoffMs / 1000}s): ${summary.body || summary.message}`
        );
        // NOTE: after this sleep the retry re-enters pacedModelSubmit and therefore
        // joins the BACK of the model's queue — pacing wait stacks on top of the
        // backoff. Bounded by maxAttempts, but a deep same-model backlog makes the
        // submit phase noticeably slower than backoff alone suggests. Accepted:
        // arriving late beats arriving twice.
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      // Exhausted retries on a proven 429 — distinct message so the two cases stay
      // legible in the logs.
      if (decision === 'throw-429') {
        throw new Error(
          `atlasVideo: submit rate-limited after ${maxAttempts} attempts: ${summary.body || summary.message}`
        );
      }
      // Rate-limit-ISH but without structured proof: not replayed by design.
      if (decision === 'throw-maybe-429') {
        throw new Error(
          `atlasVideo: submit failed with a possible rate-limit but no explicit 429 marker — ` +
          `not retried (a replay could double-bill): ${summary.body || summary.message}`
        );
      }
      const status = summary.status;
      throw new Error(
        `atlasVideo: submit failed${status ? ` (${status})` : ''}: ${summary.body || summary.message}`
      );
    }
  }
  // Unreachable — loop either returns or throws — kept for clarity.
  throw new Error('atlasVideo: submit failed after retries');
}

// ── Public API ────────────────────────────────────────────────────────

// Rebuild the LayoutInputArtifact when it's missing OR stale — built
// against an older INPUT_SCHEMA_VERSION than layoutInputService emits
// today. Only emptiness used to gate a rebuild at both call sites below,
// so a stale-but-populated artifact was served forever: 722 of 738
// production artifacts predate the 4.1 quote-provenance stamp, and the
// render-time provenance gate (quoteProvenance.js) silently WITHHOLDS
// any customer quote that isn't stamped with today's provenance fields —
// which is why customer quotes were disappearing from videos even
// though the underlying reviews existed. This helper defers the actual
// staleness decision to buildLayoutInput's own cache lookup (a
// schemaVersion mismatch is already treated as a cache MISS there, see
// layoutInputService.js ~282-293) rather than re-deriving that rule a
// third time here — the lpStale check below is only a cheap guard so we
// don't call buildLayoutInput at all when the artifact is already
// current. Shared by prepareStoryboard and generateForAd, which both
// call it with the same shape of already-loaded docs. Preserves exactly:
// the non-fatal try/catch, the noteRenderIssue({...}) call, the timing
// log ("derived in Nms"), and the post-build re-read keyed on
// {mediaId, productId}.
async function refreshStaleLayoutInput({ layoutInput, ad, media, brand, product, categories, campaign, targetAspect }) {
  const lpEmpty = !layoutInput?.input || Object.keys(layoutInput.input || {}).length === 0;
  const lpStale = !lpEmpty && layoutInput.schemaVersion !== INPUT_SCHEMA_VERSION;
  if ((lpEmpty || lpStale) && ad.productId) {
    const tmpl = resolveTitleTemplate({ brand, product, categories });
    try {
      console.log(`📐 layoutInput[ad=${ad._id}]: deriving (template=${tmpl}, aspect=${targetAspect}, product=${ad.productId})...`);
      const t0 = Date.now();
      const quoteAssembly = await resolveQuoteAssemblyOptions(ad);
      await buildLayoutInput({
        mediaId:     media._id,
        template:    tmpl,
        aspectRatio: targetAspect,
        options: {
          campaignKind:  campaign?.kind || 'product',
          variantKind:   'product_image',
          productId:     ad.productId,
          paletteSource: 'media',
          // QUOTE_STAGE_AWARE: same funnelStage + concept-angle
          // threading as the static derive path. Flag-off ignored.
          funnelStage:   quoteAssembly.funnelStage,
          conceptAngle:  quoteAssembly.conceptAngle
        }
      });
      console.log(`📐 layoutInput[ad=${ad._id}]: derived in ${Date.now() - t0}ms`);
      layoutInput = await LayoutInputArtifact
        .findOne({ mediaId: media._id, productId: ad.productId })
        .sort({ createdAt: -1 }).lean();
    } catch (err) {
      console.warn(`⚠️  layoutInput[ad=${ad._id}]: derivation failed (non-fatal) — ${err.message}`);
      noteRenderIssue(ad._id, {
        message: `layoutInput derivation failed: ${err.message}`,
        stage: 'layoutInput'
      });
    }
  }
  // QUOTE_STAGE_AWARE: re-pick from the stored pool. Video masters
  // historically have funnelStage=null, so this is a no-op there.
  // Concept-driven statics that share this helper (none today) and
  // any future staged master would honour the stage without a
  // cache-key partition. Titling (buildMetaForAd) is the path that
  // actually prints a quote on funnel retitles.
  if (layoutInput?.input) {
    try {
      const { applyStagedQuotePick } = require('./layoutInputService');
      const quoteAssembly = await resolveQuoteAssemblyOptions(ad);
      const staged = applyStagedQuotePick(layoutInput.input, quoteAssembly);
      if (staged !== layoutInput.input) {
        layoutInput = { ...layoutInput, input: staged };
      }
    } catch { /* pick is an enhancement */ }
  }
  return layoutInput;
}

// Prepare the storyboard for an ad — context load + GPT storyboard
// generation, no video generation. Used by the orchestrator to produce
// the storyboard once before dispatching Grok and chrome in parallel.
// Returns { storyboard, aspectRatio } so the caller can stamp it on
// the Ad doc and pass it to both renderers.
async function prepareStoryboard({ ad, operatorPrompt = null, modelOverride = null }) {
  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

  const [brand, product, layoutInputInitial, campaign] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean(),
    ad.campaignId ? Campaign.findById(ad.campaignId).select('kind').lean() : null
  ]);
  const categories = product ? await loadCategoryChainForProduct(product) : [];

  // Model resolution needs the brand + product docs, and aspect
  // resolution needs the model's supportedAspectRatios — so this block
  // must come after the loads. Shared with generateForAd so both stages
  // of one ad agree on model + aspect (incl. the Grok aspect fallback).
  const platformAspect = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const { model, renderAspect, targetAspect, aspectRatio, fallback } = resolveModelAndAspect({
    brand, product, categories, canvasKeys: [ad.platformFormat, platformAspect],
    platformAspect, modelOverride, hasVideoSeed: media.fileType === 'video'
  });
  logResolution(ad._id, model, renderAspect, targetAspect, fallback);

  // Derive layoutInput if missing OR stale (schemaVersion !== the
  // current INPUT_SCHEMA_VERSION) — the brand-script overlay downstream
  // reads its copy/proof/product/theme fields directly, INCLUDING the
  // provenance-stamped primary_quote. A stale-but-populated artifact
  // used to be served forever because only the empty check gated a
  // rebuild; see refreshStaleLayoutInput() above for why that silently
  // withholds customer quotes at render time. The overlay is sized to
  // the FINAL canvas (targetAspect), so derivation runs at the platform
  // aspect, NOT the render aspect. Passing renderAspect here was the
  // source of the "template ai_brand_led does not support aspect ratio
  // 3:4" warnings on 4:5 ads — the template supports 4:5 fine; it was
  // being asked about the Grok fallback aspect.
  let layoutInput = layoutInputInitial;
  layoutInput = await refreshStaleLayoutInput({
    layoutInput, ad, media, brand, product, categories, campaign, targetAspect
  });

  // Storyboard retired on the Atlas path: the Ken Burns prompt fully
  // specifies camera + timeline for every registered model, so the GPT
  // storyboard stage adds nothing here (the Vertex provider keeps its
  // own). This function's remaining jobs are warming the layoutInput
  // cache (the brand-script overlay reads it downstream) and resolving
  // the per-ad model + aspect for the orchestrator.
  return { storyboard: null, aspectRatio, model };
}

async function generateForAd({ ad, operatorPrompt = null, storyboard: precomputedStoryboard = null, modelOverride = null }) {
  if (!enabled()) return { skipped: true, reason: 'VIDEO_PROVIDER != atlas or ATLAS_API_KEY missing' };

  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

  const [brand, product, layoutInputInitial, campaign, catalogMedias] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean(),
    ad.campaignId ? Campaign.findById(ad.campaignId).select('kind').lean() : null,
    ad.productId
      ? Media.find({
          source: 'catalog-product',
          'metadata.catalogProductId': ad.productId
        }).select('_id fileUrl classification adSuitability metadata width height createdAt')
          // width/height feed the reframe already-correct skip guard. Order
          // is applied below in JS — see sortCatalogMediasForReferenceStack —
          // because it is conditional on CATALOG_FEED_ORDER_SEEDING.
          .lean()
          .then(sortCatalogMediasForReferenceStack)
      : []
  ]);
  const categories = product ? await loadCategoryChainForProduct(product) : [];

  // Model resolution needs the brand + product docs (per-canvas /
  // per-product / per-brand overrides), and aspect resolution needs the
  // resolved model's supportedAspectRatios — so this block must come
  // after the loads. resolveModelAndAspect additionally applies the
  // per-run override, the r2v video-seed degrade, and the Omni → Grok
  // aspect fallback (shared with prepareStoryboard).
  const platformAspect = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const { model, caps, renderAspect, targetAspect, aspectRatio, fallback } = resolveModelAndAspect({
    brand, product, categories, canvasKeys: [ad.platformFormat, platformAspect],
    platformAspect, modelOverride, hasVideoSeed: media.fileType === 'video'
  });
  logResolution(ad._id, model, renderAspect, targetAspect, fallback);
  // Per-ad render length — wizard-stamped Ad.videoDurationSec (or the
  // standard 8s), clamped/enum-snapped to the resolved model's caps.
  const durationSec = resolveDurationSec(ad.videoDurationSec, caps);

  // Video pipeline previously skipped layoutInput derivation, so
  // products that hadn't been through the image-gen pipeline arrived
  // here with no derived rating/price/benefits/badges/proof data.
  // Trigger derivation now if the artifact is missing OR stale
  // (schemaVersion !== INPUT_SCHEMA_VERSION), using the CANONICAL
  // template (or the brand/product Title Studio override) — the
  // creative director no longer influences it. Staleness matters as
  // much as emptiness: 722 of 738 production artifacts predate the 4.1
  // quote-provenance stamp, and a stale-but-populated artifact used to
  // be served forever (only the empty check gated a rebuild) — its
  // UNSTAMPED customer quotes then get silently withheld by the
  // render-time provenance gate, which is why customer quotes were
  // disappearing from videos. See refreshStaleLayoutInput() above: it
  // defers to buildLayoutInput's own cache, which already treats a
  // schemaVersion mismatch as a MISS and rebuilds (layoutInputService.js
  // ~282-293), rather than duplicating that rule here. The builder
  // caches per (mediaId, template, aspectRatio, productId, variantKind,
  // campaignContextHash) — so subsequent runs hit the cache instead of
  // re-deriving. Derivation runs at the TARGET (platform) aspect since
  // the derived layout describes chrome sized to the final canvas, not
  // the raw video render aspect. Non-fatal on failure.
  let layoutInput = layoutInputInitial;
  layoutInput = await refreshStaleLayoutInput({
    layoutInput, ad, media, brand, product, categories, campaign, targetAspect
  });

  const lpInput    = layoutInput?.input || null;
  const lpSrcMedia = lpInput?.source_media || null;

  // Storyboard retired on the Atlas path — the Ken Burns prompt fully
  // specifies camera + timeline, so nothing is generated here. A
  // caller-supplied storyboard (legacy orchestrators) still flows
  // through to the result / Ad doc for debugging continuity, but the
  // prompt builder ignores it.
  const storyboard = precomputedStoryboard || null;

  // Build the reference stack first so buildVeoPrompt knows whether a
  // product-fidelity anchor actually landed (rare gap: no product_only
  // catalog Media AND no CatalogProduct.imageUrl). Capped at the
  // operator-selected reference count (default 3) AND the model's
  // maxReferenceImages, so hasProductAnchor is truthful for every
  // paramShape — including 1-ref models where nothing beyond the seed
  // is actually transmitted.
  //
  // Phase 3 — when ad.referenceMediaIds is non-empty, load those Media
  // in exact pick order and pass as orderedReferenceMedia (skips the
  // default seed+catalog assembly). ad.mediaId already equals
  // referenceMediaIds[0], so no double-add.
  let orderedReferenceMedia = null;
  if (Array.isArray(ad.referenceMediaIds) && ad.referenceMediaIds.length) {
    const orderedIds = ad.referenceMediaIds.map(String);
    const docs = await Media.find({ _id: { $in: ad.referenceMediaIds } }).lean();
    const byId = new Map(docs.map(d => [String(d._id), d]));
    orderedReferenceMedia = orderedIds
      .map(id => byId.get(id))
      .filter(Boolean);
    if (orderedReferenceMedia.length < orderedIds.length) {
      console.warn(
        `⚠️  atlasVideo[ad=${ad._id}]: referenceMediaIds missing ` +
        `${orderedIds.length - orderedReferenceMedia.length} Media doc(s) — using ${orderedReferenceMedia.length} found`
      );
    }
  }
  // Lifestyle video (VIDEO_LIFESTYLE_PROMPT): one seed reference only —
  // multi-ref is a packshot fidelity device and melts people under motion.
  // Trigger matches static preserve: lifestyle seed OR ugc variantKind.
  // Flag-off / non-lifestyle product_image ⇒ today's resolveReferenceImageCount.
  // Plan is the single source of effective ref count — do not re-derive.
  const { resolveSeedStyle } = require('./imageShotHeuristicService');
  const seedStyle = resolveSeedStyle(media);
  const baseReferenceCount = resolveReferenceImageCount({ brand, product });
  const lifestylePlan = resolveLifestyleVideoRefPlan({
    baseReferenceCount,
    seedStyle,
    variantKind: ad.variantKind || null
  });
  const lifestyleVideo = lifestylePlan.lifestyleVideo;
  const referenceCount = lifestylePlan.referenceCount;
  // Operator ordered stacks on lifestyle still get capped to 1 distinct ref
  // by buildReferenceImages(referenceCount=1); log when we discard extras.
  if (lifestylePlan.forceSeedOnly && Array.isArray(orderedReferenceMedia) && orderedReferenceMedia.length > 1) {
    console.warn(
      `⚠️  atlasVideo[ad=${ad._id}]: lifestyle video path caps references to 1 ` +
      `(seed only; ${orderedReferenceMedia.length} operator picks reduced)`
    );
  }
  adStage(ad._id, `reference reframe (${aspectRatio})`);
  const imageUrls = await buildReferenceImages({
    media, product, catalogMedias, aspectRatio, caps,
    // Effective count from the plan — never pass baseReferenceCount here.
    referenceCount,
    brand,
    // Lifestyle: ignore multi-pick ordered stacks — seed only (media at pos 0).
    orderedReferenceMedia: lifestylePlan.forceSeedOnly ? null : orderedReferenceMedia
  });
  if (!imageUrls.length) throw new Error(`atlasVideo[ad=${ad._id}]: no reference images available`);

  // Does the stack actually contain CATALOG imagery for this product, beyond
  // just having more than one image?
  //
  // WHY THIS IS NOT `imageUrls.length >= 2` ANY MORE (2026-08-05). That count
  // was a safe proxy only because the operator-pick path GUARANTEED a catalog
  // image: when none of the picks was a catalog mirror, expandDeterministicVideo
  // appended one. VIDEO_OPERATOR_STACK_ONLY removed that append at owner
  // instruction, so an operator can now ship three lifestyle/UGC picks and the
  // count proxy would still say "product anchor present".
  //
  // That matters because hasProductReference gates a prompt sentence asserting
  // "All supplied images show the exact catalog SKU — the rest are additional
  // views of the same product" (veoPromptBuilder). On an all-UGC stack that is
  // simply FALSE, and it is asserted to the model as the source of truth for
  // shape, colour and label on a billable render. The honest branch (seed-only
  // fidelity wording) is the correct one there.
  //
  // Auto-assembly is unaffected: refs 1..n are catalog mirrors by construction,
  // so this still resolves true exactly as the count did.
  const productOidStr = ad.productId ? String(ad.productId) : null;
  const isCatalogRefFor = (doc) => {
    const direct = doc?.metadata?.catalogProductId;
    return productOidStr != null && direct != null && String(direct) === productOidStr;
  };
  const stackHasCatalogRef = Array.isArray(orderedReferenceMedia) && orderedReferenceMedia.length
    // Operator-ordered stack: only what they actually picked is in it.
    ? orderedReferenceMedia.some(isCatalogRefFor)
    // Auto assembly: seed + this product's catalog mirrors.
    : true;
  const hasProductAnchor = imageUrls.length >= 2 && stackHasCatalogRef;
  if (!hasProductAnchor) {
    console.warn(
      `⚠️  atlasVideo[ad=${ad._id}]: no product reference beyond the seed ` +
      `(refs=${imageUrls.length}, catalogRefInStack=${stackHasCatalogRef}; ` +
      `product imageUrl/additionalImages missing, model caps at 1 ref, or an ` +
      `operator stack with no catalog image) — shipping seed-only fidelity wording`
    );
  }
  console.log(
    `🎬 atlasVideo[ad=${ad._id}]: model=${model} aspect=${aspectRatio} ` +
    `refs=${imageUrls.length} (seed${hasProductAnchor ? ' + product refs' : ', no product anchor'}) submitting...`
  );

  // Camera-only prompt — the canonical brand-script overlay composites
  // all on-screen text downstream from ad.copy + LayoutInputArtifact.
  // Priority: (1) explicit operatorPrompt param (regenerate) → buildVeoPrompt
  // prepend; (2) ad.videoPromptRaw → full replacement, bypass buildVeoPrompt;
  // (3) guidance cascade → buildVeoPrompt prepend.
  const seedHasText = Array.isArray(media.text) && media.text.length > 0;
  const promptArgs = {
    brand, product, media,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    aspectRatio,
    seedHasText,
    // Lifestyle path always ships 1 ref → seed-only fidelity wording.
    hasProductReference: lifestylePlan.forceSeedOnly ? false : hasProductAnchor,
    storyboard,
    caps,
    durationSec,
    // Destination for prompt-profile selection (PMax → PMAX_DIRECTIVES).
    // Meta / absent → Omni/Grok path unchanged (byte-identical).
    platformFormat: ad.platformFormat || null,
    // Lifestyle sibling directive set (VIDEO_LIFESTYLE_PROMPT). Absent /
    // non-lifestyle leaves the packshot path byte-identical (B14).
    // variantKind matches static preserve trigger (ugc OR lifestyle seed).
    seedStyle,
    variantKind: ad.variantKind || null
  };
  // Whitespace-only operatorPrompt must NOT count as an override — trim-gate
  // branch 1 so it falls through to raw/guidance like an empty refinement.
  const opTrim = typeof operatorPrompt === 'string' ? operatorPrompt.trim() : null;
  let prompt;
  if (opTrim) {
    prompt = buildVeoPrompt({ ...promptArgs, operatorPrompt: opTrim });
  } else if (typeof ad.videoPromptRaw === 'string' && ad.videoPromptRaw.trim()) {
    prompt = enforceRawByteCap(ad.videoPromptRaw, caps);
    console.warn(`⚠️ atlasVideo[ad=${ad._id}]: RAW prompt override — canonical directives bypassed`);
  } else {
    let effectiveGuidance = resolvePromptGuidance({ ad, product, categories, brand });
    // Lifestyle Director creative room: when the cascade is empty, inject
    // the intent×lifestyle snippet so mood/pacing can shape the animation
    // without contradicting LIFESTYLE_DIRECTIVES. Never invents copy/offers
    // (titling stays Remotion from ad.copy — untouched here).
    if (!effectiveGuidance && lifestyleVideo) {
      const intentKey = lifestyleIntentFromTemplate(ad.template);
      effectiveGuidance = lifestyleVideoGuidanceForIntent(intentKey);
    }
    prompt = buildVeoPrompt({ ...promptArgs, operatorPrompt: effectiveGuidance });
  }

  // Omni reference-to-video consumes the seed VIDEO itself (trimmed to
  // the render window via the existing Cloudinary segment builder);
  // resolveModelAndAspect guarantees hasVideoSeed for this paramShape.
  const videoClipUrl = caps.paramShape === 'gemini-omni-r2v'
    ? (buildVideoSegmentUrl(media.fileUrl, aspectRatio, durationSec) || media.fileUrl)
    : null;

  // Resolution the submission body will actually request — computed BEFORE the submit
  // because the cost estimate is now ledgered at the charge point, not on success.
  const renderResolution = String(caps.paramShape || '').startsWith('gemini-omni')
    ? (process.env.ATLAS_VIDEO_RESOLUTION || caps.defaultResolution || '720p')
    : (caps.defaultResolution || '720p');
  const costUsd = estimateRenderCostUsd({ model, durationSec, resolution: renderResolution });

  const t0 = Date.now();
  const stagePrefix = `master video generation (${aspectRatio})`;
  let predictionId;
  let remoteVideoUrl;
  // Settled Atlas price from the terminal poll (string or null). Used to
  // upgrade the charge-point estimate → actual without a re-poll when present.
  let terminalSettledPrice = null;

  // ── PROVIDER-FAULT RETRY ──────────────────────────────────────────────────
  // Atlas's video model intermittently accepts a job and then fails it without
  // rendering a frame: `generation_failed`, `executionTime: 0`, `outputs: null`.
  // Measured 2026-08-10 — 6 failures across ~23 submits in one day, ~26%.
  //
  // The `predictionFailed` policy has ALWAYS said `action:'retry'`,
  // `charged:false` ("reservation refunded, so a reattempt
  // costs nothing extra"). Nothing on the video path ever read it — the poll
  // classified the failure and threw — so each of those became a dead ad and
  // ~$0.75 of value the operator asked for and never got.
  //
  // THE MONEY GATE. A retry is a NEW BILLABLE SUBMIT, so it is allowed only when
  // Atlas's OWN SETTLED RECORD confirms the failed attempt carried no price
  // (`chargeConfirmed === false`, read from `data.price` — see confirmedCharge).
  // Verified live 2026-08-10: failed predictions carry NO price field (5/5),
  // succeeded ones carry "0.75"/"0.08" (5/5).
  //
  // `chargeConfirmed === null` (we could not read a settled record) does NOT
  // retry. §4's owner rule is that a charge may only be asserted from a
  // confirmed price; the converse binds equally — a NON-charge may only be
  // asserted from a confirmed price, so unknown is treated as charged. The
  // policy says what SHOULD happen, the price says what DID, and both must
  // agree before this spends again.
  //
  // Deterministic failures are excluded even though they are also unbilled:
  // moderationBlocked is `action:'give-up'`, so `policyRetryable` is false and
  // the same prompt is never resubmitted to be blocked a second time.
  for (let attempt = 1; ; attempt++) {
    const submitT0 = Date.now();
    // Fire-and-forget stage: never awaited on this billable path.
    adStage(ad._id, `master video submit (${aspectRatio})${attempt > 1 ? ` — retry ${attempt - 1}` : ''}`);
    predictionId = await submitGeneration({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl, durationSec });
    const submitMs = Date.now() - submitT0;
    console.log(`🎬 atlasVideo[ad=${ad._id}]: prediction=${predictionId} polling...`);

    // ── CHARGE POINT ──────────────────────────────────────────────────────────
    // The submit returned an id, so the provider has accepted a billable job. Money is
    // committed HERE, whatever happens to the poll, the download, or the Cloudinary
    // mirror. Both writes below therefore happen now rather than at the end:
    //
    //   1. veoPredictionId — the spend receipt. Without it a crash mid-poll loses the
    //      only handle to work we have paid for, and the reaper re-queues the ad into a
    //      second submit. See models/Ad.js for the full reasoning.
    //   2. the CostLog row — previously written only after poll + download + upload
    //      succeeded, so a timeout or a failed upload spent ~$1.00 and recorded $0.
    //
    // ONE row per billable submit, deliberately. Outcome lives on the Ad (status,
    // renderUrl); CostLog records SPEND, and spend happened. The trade-off is that
    // durationMs here is submit latency rather than end-to-end render time — the full
    // elapsed time is logged on completion below instead of creating a second row that
    // would double-count the charge.
    //
    // Both are non-fatal: a telemetry or bookkeeping failure must never fail a
    // generation post-payment, because the caller would then never store videoUrl and a
    // retry would double-bill.
    try {
      await Ad.updateOne({ _id: ad._id }, { $set: { veoPredictionId: predictionId, updatedAt: new Date() } });
    } catch (err) {
      console.warn(`   ⚠️  atlasVideo: could not persist veoPredictionId=${predictionId} (${err.message}) — orphan would be unreconcilable`);
    }
    try {
      await recordFlatCost({
        stage:      'atlas_video_render',
        provider:   'atlas',
        model,
        // THE KEY THAT MAKES THIS ROW CORRECTABLE. Without it, the retry path's
        // finalizeFlatCost({providerRequestId}) matches nothing, falls back to
        // an INSERT, and the failed attempt's ~$0.75 estimate survives beside
        // the retry's — $1.50 booked for one delivered video. It also lets
        // reconcileCost swap the estimate for Atlas's confirmed price later.
        providerRequestId: predictionId,
        purposeTag: caps.paramShape,
        brandId:    media.brandId || null,
        campaignId: ad.campaignId || null,
        adId:       ad._id || null,
        mediaId:    media._id || null,
        productId:  ad.productId || null,
        costUsd:    costUsd || 0,
        durationMs: submitMs,
        status:     'submitted'
      });
    } catch (err) {
      console.warn(`   ⚠️  atlasVideo: charge-point cost record failed (${err.message}) — spend of ~$${(costUsd ?? 0).toFixed(2)} is UNLEDGERED`);
    }

    try {
      const pollOut = await pollPrediction(predictionId, {
        adId: ad._id,
        stagePrefix
      });
      // pollPrediction returns { url, price } so we can reconcile from the
      // terminal payload when Atlas already published the settled figure.
      remoteVideoUrl = pollOut && typeof pollOut === 'object' ? pollOut.url : pollOut;
      terminalSettledPrice = pollOut && typeof pollOut === 'object' ? pollOut.price : null;
      break;
    } catch (err) {
      const maxAttempts = err.policyMaxAttempts || 1;
      const mayRetry = mayRetryAfterFailure({
        policyRetryable: err.policyRetryable,
        chargeConfirmed: err.chargeConfirmed,
        attempt,
        maxAttempts
      });

      if (!mayRetry) {
        // Say WHY, in the operator's terms. "Failed" without the reason is how
        // the last two incidents stayed invisible for days.
        const because =
          err.policyRetryable !== true ? `policy ${err.atlasPolicy || 'unknown'} is not retryable`
          : err.chargeConfirmed === true ? `attempt was CHARGED $${err.chargePriceUsd} — not resubmitting`
          : err.chargeConfirmed == null  ? 'charge state UNKNOWN — treating as charged, not resubmitting'
          : `exhausted ${maxAttempts} attempt(s)`;
        console.warn(`   ⛔ atlasVideo[ad=${ad._id}]: not retrying — ${because}`);
        throw err;
      }

      // Correct the ledger BEFORE spending again. The charge-point row above was
      // written from an ESTIMATE at submit; Atlas has now confirmed this
      // prediction carried no price, so the row is overstated. Leaving it and
      // adding a second submit row would book ~$1.50 for one delivered video.
      // Keyed on providerRequestId, so it updates this attempt's row in place and
      // the retry's own charge-point row is a separate, correct one.
      await finalizeFlatCost({
        stage:      'atlas_video_render',
        provider:   'atlas',
        model,
        providerRequestId: predictionId,
        costUsd:    0,
        // 'none' — not 'actual'/'estimated'. Atlas confirmed there is no price
        // to record. Mirrors atlasImageService's `charged ? 'estimated' : 'none'`
        // and is one of CostLog's three legal costSource values; update
        // validators are OFF by default, so an invented value would have been
        // written straight past the enum.
        costSource: 'none',
        status:     'failed',
        errorMessage: err.message || null
      }).catch((e) => console.warn(`   ⚠️  atlasVideo: could not zero the unbilled cost row for ${predictionId} — ${e.message}`));

      // The POLICY owns this wait, not a constant here. Until 2026-08-11 this
      // was a hardcoded `1000 * attempt`, so predictionFailed resubmitted an
      // identical payload to the same model one second later — measured 3 of 3
      // retries firing and 0 of 3 rescuing an ad. `policyBackoffFor` is stamped
      // by pollPrediction and also honours a Retry-After header.
      // attempt is 1-based here; backoffFor is 0-based. Off by one and the
      // first wait silently becomes the second step of the curve.
      const backoffMs = typeof err.policyBackoffFor === 'function'
        ? err.policyBackoffFor(attempt - 1)
        : 1000 * attempt;
      console.warn(
        `   ↻ atlasVideo[ad=${ad._id}]: ${err.atlasPolicy} on ${predictionId} and Atlas confirms NO charge ` +
        `— resubmitting (attempt ${attempt + 1}/${maxAttempts}) after ${Math.round(backoffMs / 1000)}s`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  // ── COST RECONCILE (fire-and-forget) ────────────────────────────────────
  // Charge-point wrote an ESTIMATE from MODEL_CAPS (Omni developer 10s →
  // $1.20). Measured settled price on that model is $0.90 — the estimate is
  // ~33% HIGH, so every unreconciled video row over-reports spend.
  //
  // NEVER await. Telemetry must not delay download/upload or fail a render
  // after payment. When the terminal poll already carries a usable price
  // (common for video; measured 2026-08-11), finalize immediately; otherwise
  // schedule a re-poll. See reconcileVideoCostFromTerminal.
  reconcileVideoCostFromTerminal(predictionId, { price: terminalSettledPrice });

  adStage(ad._id, `downloading master video (${aspectRatio})`);
  const videoBuffer = await downloadToBuffer(remoteVideoUrl);

  // Mirror to Cloudinary. NO eager transform.
  //
  // There used to be one here, pre-generating a `c_fill,<ar>,g_auto` derivative whenever the
  // model's rendered aspect differed from the canvas aspect. Nothing fetches it. The only
  // emitter of a c_fill/g_auto video URL is videoCompositeService.js:145, whose sole in-repo
  // caller is aiOverlayPolishService.js:196 — gated off by AI_OVERLAY_POLISH_ENABLED=false
  // (config/defaults.env) and additionally hard-nulled at renderService.js:207. The LIVE
  // cropper is services/videoCropUrl.js, which builds an explicit c_scale/c_crop chain with no
  // gravity at all, so it never touches this derivative.
  //
  // So it was a real transcode of a 1080x1920 clip, billed in Cloudinary transformation
  // credits, for an asset nobody requests — on every render where the model's rendered aspect
  // differed from the canvas aspect, which the square-flip work made a strictly larger share
  // of production (Omni now renders 9:16 for platform 1:1 AND 4:5).
  //
  // Accepted trade-off: the eager also warmed the per-asset g_auto tracking-crop analysis that
  // the composite would have shared (docs/CLOUDINARY-VIDEO.md). An operator who later flips
  // AI_OVERLAY_POLISH_ENABLED=true therefore gets a colder first request — acceptable, because
  // that path is dead twice over (renderService.js:252 fires only for ad.kind === 'video', and
  // video ads return at routes/ads.js:830 without ever reaching renderCreative).
  adStage(ad._id, `mirror upload (${aspectRatio})`);
  const uploaded = await uploadBufferToCloudinary(videoBuffer, {
    folder:       `liquidretail/atlas_renders/${model.replace(/\//g, '_')}`,
    resourceType: 'video',
    format:       'mp4'
  });

  const elapsedMs = Date.now() - t0;

  // NO cost record here. The charge was ledgered at the CHARGE POINT above, right after
  // the submit returned a prediction id. Writing a second row on success would
  // double-count every completed render, and — worse — would restore the original bug
  // by implication: that spend is only real once the whole chain succeeds. It isn't.
  // The provider bills the submit. Everything after it is delivery.
  //
  // End-to-end timing therefore lives in this log line rather than CostLog.durationMs
  // (which holds submit latency). If per-render duration is ever needed in reports,
  // update the existing row by adId + predictionId — do not create a new one.
  console.log(
    `🎬 atlasVideo[ad=${ad._id}]: done — model=${model} aspect=${aspectRatio} ` +
    `took=${Math.round(elapsedMs / 1000)}s cost≈$${(costUsd ?? 0).toFixed(2)}`
  );

  return {
    videoUrl:           uploaded.secure_url,
    cloudinaryPublicId: uploaded.public_id,
    operationName:      predictionId,
    aspectRatio,
    track:              media.fileType === 'video' ? 1 : 2,
    prompt,
    storyboard,
    // The images the model ACTUALLY received, per its param shape — not the
    // full assembled stack. Several shapes submit fewer (r2v clamps to
    // maxReferenceImages; grok-i2v/veo/generic take a single frame), so
    // reporting imageUrls here overstated what a paid call was given. Position 0
    // is the seed, then product hero + alts. Feeds Ad.veoReferenceImages and the
    // generation inspector.
    referenceImages:    submittedImageUrls(imageUrls, caps),
    elapsedMs,
    model,
    modelFallback:      fallback,
    costUsd
  };
}

async function downloadToBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout:      120000,
    maxContentLength: 200 * 1024 * 1024   // 200MB
  });
  return Buffer.from(res.data);
}

// Scaffold for the Advanced "raw prompt" editor: resolve model + aspect
// + duration for the given brand/product/format, then return the
// canonical buildVeoPrompt string (media=null, placeholder product when
// none supplied). Used by GET /api/ads/veo-prompt-scaffold.
async function buildPromptScaffold({
  brand,
  product = null,
  categories = [],
  platformFormat = null,
  durationSec = null
} = {}) {
  const aspect = aspectRatioForPlatformFormat(platformFormat) || '9:16';
  const { model, caps, aspectRatio } = resolveModelAndAspect({
    brand,
    product,
    categories,
    canvasKeys: [platformFormat, aspect],
    platformAspect: aspect,
    hasVideoSeed: false
  });
  const resolvedDuration = resolveDurationSec(durationSec, caps);
  const productForPrompt = product || { title: '{{PRODUCT_TITLE}}' };
  const prompt = buildVeoPrompt({
    brand,
    product: productForPrompt,
    media: null,
    aspectRatio,
    seedHasText: false,
    hasProductReference: true,
    operatorPrompt: null,
    caps,
    durationSec: resolvedDuration,
    // Same destination selector as generateForAd — scaffold for a PMax
    // format must preview the PMax profile, not the Meta/Omni default.
    platformFormat: platformFormat || null
  });
  return {
    prompt,
    model,
    aspectRatio,
    durationSec: resolvedDuration,
    byteCap: caps?.promptByteCap || 4096,
    // Reference-stack limits for the seed picker. maxReferenceImages is a HARD
    // per-model API limit and varies wildly (gemini-omni i2v: 7, omni r2v: 5,
    // grok-imagine i2v and veo3.1: 1), so the UI must read it from the resolved
    // model rather than assume 7 — otherwise it offers slots the model will
    // silently drop. defaultReferenceCount is how many get used when the
    // operator picks nothing.
    maxReferenceImages:    caps?.maxReferenceImages || MAX_REFERENCE_IMAGE_COUNT,
    defaultReferenceCount: resolveReferenceImageCount({ brand, product }),

    // Default-stack POLICY for both rails, so the Step 2 picker pre-picks what
    // this backend would pick on its own. Served here because the picker already
    // calls this endpoint — which keeps config/defaults.env the single source of
    // truth and means changing a default needs no Netlify rebuild. The static
    // count in particular was hardcoded in the frontend as
    // IMAGE_QUEUE_DEFAULT_COUNT before this.
    //
    // The video block carries NO count on purpose. `defaultReferenceCount` above
    // is the one authoritative video count (the full per-product → per-brand →
    // env cascade); serving a second one invited the picker to advertise a
    // number generation would not actually use.
    referenceDefaults: {
      video: { shotTypes: referenceDefaultsService.videoReferenceDefaults().shotTypes },
      image: referenceDefaultsService.imageReferenceDefaults()
    }
  };
}

module.exports = {
  generateForAd,
  // exposed for verify harnesses (Claude-5-era provider-fault retry gate)
  mayRetryAfterFailure,
  confirmedCharge,
  SETTLED_POLL_STATUSES,
  TERMINAL_FAILURE_STATUSES,

  prepareStoryboard,
  enabled,
  MODEL_CAPS,
  BUILT_IN_DEFAULT_MODEL,
  DEFAULT_REFERENCE_IMAGE_COUNT,
  MAX_REFERENCE_IMAGE_COUNT,
  REPEAT_PRIMARY_TOTAL_CAP,
  MAX_DISTINCT_REFERENCES,
  capsFor,
  resolveVideoModel,
  resolveModelAndAspect,
  ASPECT_FALLBACK_MODEL,
  resolveReferenceImageCount,
  // Seed pad-vs-crop rule — scripts/verifyNoVisibleSeedPad.js.
  seedPadDecision,
  // Split-stage seed prep — scripts/verifyPmaxSplitSeedPad.js.
  reframeOutpaintPrompt,
  reframePromptForSplitAspect,
  padSolidBuffer,
  // Lifestyle video ref-count gate — scripts/verifyLifestylePreserve.js.
  resolveLifestyleVideoRefCount,
  resolveLifestyleVideoRefPlan,
  shouldUseLifestyleVideoPrompt,
  lifestyleIntentFromTemplate,
  resolveDurationSec,
  estimateRenderCostUsd,
  // Cost reconcile — scripts/verifyVideoCostReconcile.js (offline).
  parseAtlasSettledPrice,
  reconcileVideoCostFromTerminal,
  scheduleVideoCostReconcile,
  validateVideoSettings,
  buildSubmissionBody,
  imageDimsForAspect,
  cropImageUrlForAspect,
  buildVideoSegmentUrl,
  buildReferenceImages,
  // Feed-order reference stack ordering — scripts/verifyCatalogFeedOrderSeeding.js.
  sortCatalogMediasForReferenceStack,
  // Pure helpers for scripts/verifyPrimaryReferenceRepeat.js (offline).
  isRepeatPrimaryReferenceEnabled,
  appendPrimaryReferenceRepeat,
  referenceStackBudget,
  pickProductOnlyUrl,
  buildPromptScaffold,
  // Exported for scripts/verifyReframePromptHardening.js — the prompt
  // is the load-bearing artifact and the offline harness inspects the
  // string it emits under both flag values + a fixture matrix.
  reframeOutpaintPrompt,
  reframePromptContext,
  hasEdgeClippedSubjects,
  // Billable-submit replay guard. Exported for scripts/verifySubmitGuard.js —
  // these decide whether a charged POST is repeated, so they are tested directly
  // rather than through a mocked axios.
  isRateLimit,
  isDefinite429,
  submitRetryDecision,
  summarizeAxiosError,
  // Per-model submit gate — exported for scripts/verifyConcurrencyConfig.js
  // so the harness can prove Grok stays <=1 RPS under raised VEO_CONCURRENCY.
  pacedModelSubmit,
  SUBMIT_SPACING_MS,
  isGrokModel,
  // Cloudinary upload ceiling — exported for scripts/verifyReframeUploadCeiling.js
  // so the harness can prove a >20 MiB 4K outpaint is refitted rather than lost.
  fitBufferForCloudinary,
  CLOUDINARY_MAX_UPLOAD_BYTES,
  // Resume-from-receipt. Exported for scripts/verifyVideoResume.js, which pins
  // that neither of these can ever submit.
  peekPrediction,
  resumeForAd,
  // BILLABLE. Exported for scripts/rpd (rapid product development harness) so
  // model/prompt A-B runs reuse THIS submit path — pacedModelSubmit spacing,
  // structured-429-only retry, maxRedirects:0 — instead of re-implementing a
  // second billable POST. Any new caller must hold its own budget gate before
  // calling (rpd's is --live + --max-usd; see scripts/verifyRpdHarness.js).
  submitGeneration
};
