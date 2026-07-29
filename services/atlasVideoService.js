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
const { recordFlatCost } = require('./costTracker');
const { buildVeoPrompt, aspectRatioForPlatformFormat, promptProfileFor, enforceRawByteCap } = require('./veoPromptBuilder');
const { loadCategoryChainForProduct } = require('./categoryChainService');

const { buildLayoutInput }   = require('./layoutInputService');

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
// Cloudinary ar_ param mapping for the eager transform on upload.
// The downstream brand-script composite requests this derivative URL;
// pre-generating it at upload time saves a transcode round-trip on the
// first read.
function arParamForAspect(aspectRatio) {
  const a = String(aspectRatio || '').trim();
  if (a === '9:16')   return 'ar_9:16';
  if (a === '16:9')   return 'ar_16:9';
  if (a === '4:5')    return 'ar_4:5';
  if (a === '1.91:1') return 'ar_191:100';
  return 'ar_1:1';
}

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

// ── Model + aspect resolution (shared) ────────────────────────────────
//
// The single decision point both prepareStoryboard and generateForAd go
// through, so the two stages of one ad always agree. Order:
//   1. modelOverride (per-run, e.g. the regenerate dropdown) beats the
//      persisted chain; unknown slugs warn and fall through to it.
//   2. requiresVideoSeed degrade: Omni reference-to-video transforms an
//      existing clip — an image-seeded ad can't feed it, so it degrades
//      to the built-in i2v default rather than failing the render.
//   3. Aspect fallback: Omni models only render 16:9/9:16. Any other
//      canvas routes to ASPECT_FALLBACK_MODEL (Grok 1.5), whose refs are
//      already pre-cropped to the canvas by the existing resize system.
//      Explicitly-selected Grok/Veo models never "fall back".
//   4. resolveAspectRatioForModel runs against the FINAL model's caps
//      (formats even Grok lacks — 4:5, 5:4, 1.91:1 — keep the
//      closest-aspect render + Cloudinary eager re-crop path).
//
// Returns { model, caps, aspectRatio, fallback } where fallback is
// null or { from, reason } for logging / the Ad doc.
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
    fallback = { from: model, reason: 'model requires a video seed; ad is image-seeded' };
    model = BUILT_IN_DEFAULT_MODEL;
    caps = capsFor(model);
  }

  const isOmni = String(caps.paramShape || '').startsWith('gemini-omni');
  if (isOmni && platformAspect && !(caps.supportedAspectRatios || []).includes(platformAspect)) {
    fallback = { from: model, reason: `aspect ${platformAspect} unsupported (${(caps.supportedAspectRatios || []).join('/')})` };
    model = ASPECT_FALLBACK_MODEL;
    caps = capsFor(model);
  }

  const aspectRatio = resolveAspectRatioForModel(platformAspect, caps);
  return { model, caps, aspectRatio, fallback };
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

// Same most-specific-wins chain as resolveVideoModel. Non-numeric and
// out-of-range values warn and fall through; the result is additionally
// clamped to the resolved model's maxReferenceImages by
// buildReferenceImages.
function resolveReferenceImageCount({ brand = null, product = null } = {}) {
  const chain = [
    ['CatalogProduct.videoSettings.referenceImageCount', product?.videoSettings?.referenceImageCount],
    ['Brand.videoSettings.referenceImageCount',          brand?.videoSettings?.referenceImageCount],
    ['ATLAS_REFERENCE_IMAGE_COUNT env',                  process.env.ATLAS_REFERENCE_IMAGE_COUNT]
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
function reframePromptForAspect(aspectRatio) {
  const [wr, hr] = String(aspectRatio).split(':').map(Number);
  const orient = wr > hr ? 'horizontal (landscape)' : wr < hr ? 'vertical (portrait)' : 'square';
  return `Reframe this image into a ${orient} ${wr}:${hr} composition. Keep the ENTIRE subject and all text fully visible and uncropped. Naturally extend the existing background, colors and scene to fill the new areas — do not add new objects, people or text. Seamless, photorealistic, matching the original style, lighting and palette.`;
}

function reframeOutpaintPrompt(aspectRatio) {
  return REFRAME_PROMPT_STYLE() === 'uncrop'
    ? uncropPromptForAspect(aspectRatio)
    : reframePromptForAspect(aspectRatio);
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

    if (!hasAlpha && !needsOrient) {
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
async function padSolidBuffer(srcBuffer, W, H, hex) {
  try {
    const fg = await sharp(srcBuffer).rotate().resize(W, H, { fit: 'inside' }).toBuffer();
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return await sharp({ create: { width: W, height: H, channels: 3, background: { r, g, b } } })
      .composite([{ input: fg, gravity: 'center' }])
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

// Loser wait: a couple of short re-reads for the winner's url. Generation can
// take minutes, so this usually returns null and the caller crops — never
// spends. Next render hits the persistent cache once the winner persists.
// Deliberately accepts a STALE url too: during a re-derive the older asset is
// still a real, correctly-shaped image, so serving it to a concurrent render
// beats a destructive crop and costs nothing.
async function waitForReframeUrl(mediaId, aspectKey, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    try {
      const fresh = await Media.findById(mediaId).select(`metadata.reframes.${aspectKey}`).lean();
      const url = fresh?.metadata?.reframes?.[aspectKey]?.url;
      if (typeof url === 'string' && url.trim()) return url;
    } catch { /* retry / fall through */ }
  }
  return null;
}

// Reframe sourceUrl to aspectRatio via generative uncrop outpaint (or exact-fit
// skip / $0 pad). NEVER throws — any failure degrades to deterministic Cloudinary
// crop so the ad pipeline keeps moving. Successful reframes (incl. exact / pad)
// are persisted on Media.metadata.reframes[aspectKey] for reuse.
async function reframeReferenceForAspect({ media, sourceUrl, aspectRatio, brand }) {
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
    const aspectKey = String(aspectRatio).replace(/[^a-z0-9]+/gi, '_');

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
        // Only claim an exact colour match when the edges really are flat;
        // otherwise let Cloudinary derive a gradient from the border itself.
        const hex = fill.uniform ? fill.hex : null;

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
            `   ⏳ reframe[${aspectKey}]: claim held by another process — waiting briefly, no spend`
          );
          const winnerUrl = await waitForReframeUrl(media._id, aspectKey);
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
            prompt: reframeOutpaintPrompt(aspectRatio),
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

          const outUrl = await pollPrediction(id);

          // Retried (free, idempotent) — see fetchOutpaintOutput. A single blip
          // here used to discard a generation we had already paid for.
          const outBuf = await fetchOutpaintOutput(outUrl);
          if (outBuf.length >= 512 && await outputRatioOk(outBuf, wr, hr)) {
            const up = await uploadBufferToCloudinary(outBuf, { folder: 'liquidretail/reframes' });
            const url = up.secure_url || up.url;
            if (url) { resultUrl = url; method = 'outpaint'; }
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
        //     source. Nothing is cropped or lost; the whole subject stays visible.
        if (!resultUrl) {
          try {
            // Prefer a sampled SOLID fill when the extended edges are flat. The
            // blurred cover is a scaled-up copy of the frame, so on a uniform
            // studio background it smears product colour (and hair) into the
            // bands — visibly worse than matching the backdrop exactly. Blur is
            // the right call only when the background genuinely has content.
            const srcRatio = media.width > 0 && media.height > 0 ? media.width / media.height : null;
            const fill = srcRatio
              ? await detectBorderFill(srcNorm.buffer, srcRatio, wr / hr)
              : { uniform: false, hex: null };
            const padBuf = fill.uniform
              ? (await padSolidBuffer(srcNorm.buffer, W, H, fill.hex)) || (await padToRatioBuffer(srcNorm.buffer, W, H))
              : await padToRatioBuffer(srcNorm.buffer, W, H);
            if (padBuf) {
              const up = await uploadBufferToCloudinary(padBuf, { folder: 'liquidretail/reframes' });
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

    // Catalog mirrors (hero-first / createdAt asc), skip seed id.
    for (const cm of (catalogMedias || [])) {
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
  const effectiveMax = usedOrdered
    ? Math.min(ids.length, caps?.maxReferenceImages || MAX_REFERENCE_IMAGE_COUNT)
    : maxImages;
  const capped = ids.slice(0, effectiveMax);
  if (usedOrdered && ids.length > effectiveMax) {
    console.warn(
      `⚠️  buildReferenceImages: ${ids.length} operator picks exceed the model's ` +
      `maxReferenceImages (${effectiveMax}) — using the first ${effectiveMax} in pick order`
    );
  }

  // Reframe all in parallel; preserve order.
  const reframed = await Promise.all(
    capped.map(id => reframeReferenceForAspect({
      media: id.mediaDoc,
      sourceUrl: id.sourceUrl,
      aspectRatio,
      brand
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
  return out;
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
// serialized and spaced >= SUBMIT_SPACING_MS apart (start-to-start), while
// different models run in parallel as independent buckets.
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
// VEO_CONCURRENCY per-process remains the weak link (routes/ads.js:144).
const SUBMIT_SPACING_MS = (() => {
  const n = Number(process.env.ATLAS_SUBMIT_SPACING_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
})();

const _modelSubmitGate = new Map();
const _modelLastSubmitAt = new Map();

/** Run `fn` serialized + rate-spaced against other submits for the SAME model, process-wide. */
function pacedModelSubmit(model, fn) {
  const run = async () => {
    if (SUBMIT_SPACING_MS > 0) {
      const last = _modelLastSubmitAt.get(model);
      const wait = last == null ? 0 : last + SUBMIT_SPACING_MS - Date.now();
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
  // the caller still sees `next` reject.
  const next = (_modelSubmitGate.get(model) || Promise.resolve()).then(run);
  _modelSubmitGate.set(model, next.then(() => undefined, () => undefined));
  return next;
}

async function pollPrediction(predictionId, { shouldCancel = null } = {}) {
  const t0 = Date.now();
  let pollCount = 0;
  let consecutiveErrors = 0;
  let consecutiveRateLimits = 0;
  let lastError = null;
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
    const data = res.data?.data || {};
    const status = data.status;
    if (status === 'completed' || status === 'succeeded') {
      // Providers vary the result field: `outputs` (array) is the
      // common case, but some return `output` as a string or array —
      // accept both (mirrors Atlas's own reference client).
      const raw = data.outputs ?? data.output ?? [];
      const url = Array.isArray(raw) ? raw[0] : raw;
      if (!url) throw new Error(`atlasVideo: ${status} but no output url (predictionId=${predictionId})`);
      const elapsedSec = Math.round((Date.now() - t0) / 1000);
      console.log(`🎬 atlasVideo: ${predictionId} done after ${elapsedSec}s (${pollCount} polls)`);
      return url;
    }
    if (status === 'failed') {
      throw new Error(`atlasVideo: prediction failed: ${data.error || 'unknown'} (id=${predictionId})`);
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
  const { model, aspectRatio, fallback } = resolveModelAndAspect({
    brand, product, categories, canvasKeys: [ad.platformFormat, platformAspect],
    platformAspect, modelOverride, hasVideoSeed: media.fileType === 'video'
  });
  if (fallback) {
    console.log(`🎬 atlasVideo[ad=${ad._id}]: model fallback ${fallback.from} → ${model} (${fallback.reason})`);
  }

  // Derive layoutInput if missing — the brand-script overlay downstream
  // reads its copy/proof/product/theme fields directly. Cached per
  // (mediaId, template, aspectRatio, productId, variantKind,
  // campaignContextHash). Non-fatal on failure.
  let layoutInput = layoutInputInitial;
  const lpEmpty = !layoutInput?.input || Object.keys(layoutInput.input || {}).length === 0;
  if (lpEmpty && ad.productId) {
    const tmpl = resolveTitleTemplate({ brand, product, categories });
    try {
      console.log(`📐 layoutInput[ad=${ad._id}]: deriving (template=${tmpl}, aspect=${aspectRatio}, product=${ad.productId})...`);
      const t0 = Date.now();
      await buildLayoutInput({
        mediaId:     media._id,
        template:    tmpl,
        aspectRatio,
        options: {
          campaignKind:  campaign?.kind || 'product',
          variantKind:   'product_image',
          productId:     ad.productId,
          paletteSource: 'media'
        }
      });
      console.log(`📐 layoutInput[ad=${ad._id}]: derived in ${Date.now() - t0}ms`);
      layoutInput = await LayoutInputArtifact
        .findOne({ mediaId: media._id, productId: ad.productId })
        .sort({ createdAt: -1 }).lean();
    } catch (err) {
      console.warn(`⚠️  layoutInput[ad=${ad._id}]: derivation failed (non-fatal) — ${err.message}`);
    }
  }

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
        }).select('_id fileUrl classification adSuitability metadata width height')
          // Deterministic order for the reference stack: hero materializes
          // before alts, so createdAt asc ≈ hero-first, alts in stored order.
          // width/height feed the reframe already-correct skip guard.
          .sort({ createdAt: 1 })
          .lean()
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
  const { model, caps, aspectRatio, fallback } = resolveModelAndAspect({
    brand, product, categories, canvasKeys: [ad.platformFormat, platformAspect],
    platformAspect, modelOverride, hasVideoSeed: media.fileType === 'video'
  });
  if (fallback) {
    console.log(`🎬 atlasVideo[ad=${ad._id}]: model fallback ${fallback.from} → ${model} (${fallback.reason})`);
  }
  if (aspectRatio !== platformAspect) {
    console.log(
      `🎬 atlasVideo[ad=${ad._id}]: remapped aspect ${platformAspect} → ${aspectRatio} ` +
      `(unsupported by ${model}; closest of ${caps.supportedAspectRatios.join(', ')})`
    );
  }
  // Per-ad render length — wizard-stamped Ad.videoDurationSec (or the
  // standard 8s), clamped/enum-snapped to the resolved model's caps.
  const durationSec = resolveDurationSec(ad.videoDurationSec, caps);

  // Video pipeline previously skipped layoutInput derivation, so
  // products that hadn't been through the image-gen pipeline arrived
  // here with no derived rating/price/benefits/badges/proof data.
  // Trigger derivation now if the artifact is missing or empty, using the
  // CANONICAL template (or the brand/product Title Studio override) — the
  // creative director no longer influences it. The builder caches per
  // (mediaId, template, aspectRatio, productId, variantKind,
  // campaignContextHash) — so subsequent runs hit the cache instead of
  // re-deriving. Non-fatal: if derivation fails (e.g. Gemini credits
  // exhausted), we fall back to whatever data was already on the artifact
  // / CatalogProduct.
  let layoutInput = layoutInputInitial;
  const lpEmpty = !layoutInput?.input || Object.keys(layoutInput.input || {}).length === 0;
  if (lpEmpty && ad.productId) {
    const tmpl = resolveTitleTemplate({ brand, product, categories });
    try {
      console.log(`📐 layoutInput[ad=${ad._id}]: deriving (template=${tmpl}, aspect=${aspectRatio}, product=${ad.productId})...`);
      const t0 = Date.now();
      await buildLayoutInput({
        mediaId:     media._id,
        template:    tmpl,
        aspectRatio,
        options: {
          campaignKind:  campaign?.kind || 'product',
          variantKind:   'product_image',
          productId:     ad.productId,
          paletteSource: 'media'
        }
      });
      console.log(`📐 layoutInput[ad=${ad._id}]: derived in ${Date.now() - t0}ms`);
      layoutInput = await LayoutInputArtifact
        .findOne({ mediaId: media._id, productId: ad.productId })
        .sort({ createdAt: -1 }).lean();
    } catch (err) {
      console.warn(`⚠️  layoutInput[ad=${ad._id}]: derivation failed (non-fatal) — ${err.message}`);
    }
  }

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
  const referenceCount = resolveReferenceImageCount({ brand, product });
  const imageUrls = await buildReferenceImages({
    media, product, catalogMedias, aspectRatio, caps, referenceCount, brand,
    orderedReferenceMedia
  });
  if (!imageUrls.length) throw new Error(`atlasVideo[ad=${ad._id}]: no reference images available`);

  const hasProductAnchor = imageUrls.length >= 2;
  if (!hasProductAnchor) {
    console.warn(
      `⚠️  atlasVideo[ad=${ad._id}]: no product reference beyond the seed ` +
      `(product imageUrl/additionalImages missing, or model caps at 1 ref) — shipping with seed only`
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
    hasProductReference: hasProductAnchor,
    storyboard,
    caps,
    durationSec
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
    const effectiveGuidance = resolvePromptGuidance({ ad, product, categories, brand });
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
  const predictionId = await submitGeneration({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl, durationSec });
  const submitMs = Date.now() - t0;
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

  const remoteVideoUrl = await pollPrediction(predictionId);
  const videoBuffer = await downloadToBuffer(remoteVideoUrl);

  // Mirror to Cloudinary. The eager transform pre-generates the
  // canvas-aspect saliency-crop derivative at upload time — but ONLY
  // when the model's rendered aspect differs from the canvas (i.e. we
  // had to remap because the model didn't support the canvas aspect
  // natively — common on the Gemini Omni default, which only renders
  // 16:9/9:16). When they match, the composite skips the transform
  // entirely, so pre-generating it would be pointless work that
  // triggers a transcode 423 race for no reason.
  const aspectsMatch = (() => {
    const parse = (s) => {
      const m = String(s || '').match(/^([\d.]+)\s*:\s*([\d.]+)$/);
      return m ? parseFloat(m[1]) / parseFloat(m[2]) : null;
    };
    const a = parse(aspectRatio); const b = parse(platformAspect);
    return a != null && b != null && Math.abs(a - b) < 0.01;
  })();
  const uploadOpts = {
    folder:       `liquidretail/atlas_renders/${model.replace(/\//g, '_')}`,
    resourceType: 'video',
    format:       'mp4'
  };
  if (!aspectsMatch) {
    uploadOpts.eager = [{ raw_transformation: `c_fill,${arParamForAspect(platformAspect)},g_auto` }];
  }
  const uploaded = await uploadBufferToCloudinary(videoBuffer, uploadOpts);

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
    durationSec: resolvedDuration
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
    defaultReferenceCount: resolveReferenceImageCount({ brand, product })
  };
}

module.exports = {
  generateForAd,
  prepareStoryboard,
  enabled,
  MODEL_CAPS,
  BUILT_IN_DEFAULT_MODEL,
  DEFAULT_REFERENCE_IMAGE_COUNT,
  MAX_REFERENCE_IMAGE_COUNT,
  capsFor,
  resolveVideoModel,
  resolveModelAndAspect,
  ASPECT_FALLBACK_MODEL,
  resolveReferenceImageCount,
  resolveDurationSec,
  estimateRenderCostUsd,
  validateVideoSettings,
  buildSubmissionBody,
  imageDimsForAspect,
  cropImageUrlForAspect,
  buildVideoSegmentUrl,
  buildReferenceImages,
  pickProductOnlyUrl,
  buildPromptScaffold,
  // Billable-submit replay guard. Exported for scripts/verifySubmitGuard.js —
  // these decide whether a charged POST is repeated, so they are tested directly
  // rather than through a mocked axios.
  isRateLimit,
  isDefinite429,
  submitRetryDecision,
  summarizeAxiosError
};
