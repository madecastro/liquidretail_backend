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
// Model tier: '-developer' is a BILLING variant, not a quality tier. Verified
// against the live Atlas catalogue (2026-07-24): it carries the same
// price.origin.base_price ($0.08) as plain /edit and differs only by a 50%
// discount factor; `profile` text is verbatim identical and the readmes are
// byte-identical. The same pattern holds across all 12 '-developer' variants,
// while a genuine quality up-tier (nano-banana-pro/edit-ultra) gets its own
// higher list price. Distillation is the separate '-lite' axis, which composes
// independently. So: half price, no evidenced fidelity cost.
const REFRAME_OUTPAINT_MODEL = () => process.env.REFRAME_OUTPAINT_MODEL || 'google/nano-banana-2/edit-developer';
// 1k is the schema default for both variants (enum 1k|2k|4k). Deliberately NOT
// 4k: no Atlas model exposes a mask or pixel-passthrough, so the whole canvas
// is re-synthesised every call — at 4k the decoder must commit to letterforms
// and logo strokes it can only guess, which is the artifact we were seeing.
// And the reframed reference is never consumed at 4k anyway: it feeds a 720p
// video render (~9x area downsample). Raise ATLAS_VIDEO_RESOLUTION, not this,
// if you want more resolution where viewers actually see it.
const REFRAME_RESOLUTION = () => process.env.REFRAME_RESOLUTION || '1k';
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
  return Number.isFinite(n) && n >= 0 ? n : 0.04;
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
// Ladder id persisted on Media.metadata.reframes[*] so we can distinguish
// assets produced by this uncrop process from older outpaint-only entries.
const REFRAME_LADDER_VERSION = 'uncrop-v1';

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
      timeout: 60000
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

// Reframe sourceUrl to aspectRatio via generative uncrop outpaint (or exact-fit
// skip / $0 pad). NEVER throws — any failure degrades to deterministic Cloudinary
// crop so the ad pipeline keeps moving. Successful reframes (incl. exact / pad)
// are persisted on Media.metadata.reframes[aspectKey] for reuse.
async function reframeReferenceForAspect({ media, sourceUrl, aspectRatio, brand }) {
  const fallback = () => cropImageUrlForAspect(sourceUrl, aspectRatio, brand);
  try {
    // 1. Kill-switch / Atlas unconfigured / missing source → crop only.
    if (!REFRAME_ENABLED() || !enabled() || !sourceUrl) return fallback();

    // 2. Mongo-safe aspect key: alphanumeric+underscore only, so ':' AND
    //    '.' are removed ('9:16'→'9_16', '1.91:1'→'1_91_1'). A raw dot would
    //    make the $set path nest and permanently miss the flat-key read.
    const aspectKey = String(aspectRatio).replace(/[^a-z0-9]+/gi, '_');

    // 3. PERSISTENT CACHE HIT — no spend, no submit (survives restarts).
    const cached = media?.metadata?.reframes?.[aspectKey]?.url;
    if (typeof cached === 'string' && cached.trim()) return cached;

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
      try {
        const fresh = await Media.findById(media._id).select(`metadata.reframes.${aspectKey}`).lean();
        const freshUrl = fresh?.metadata?.reframes?.[aspectKey]?.url;
        if (typeof freshUrl === 'string' && freshUrl.trim()) return freshUrl;
      } catch { /* fall through and compute */ }

      // 5. ALREADY-CORRECT guard — source aspect within threshold of target.
      if (media.width > 0 && media.height > 0) {
        const sr = media.width / media.height;
        const tr = wr / hr;
        const retained = Math.min(sr, tr) / Math.max(sr, tr);
        if (retained >= REFRAME_SKIP_THRESHOLD()) {
          const exactUrl = fallback();
          // Persist exact-fit too so every aspect is on file for reuse.
          await persistReframe(media, aspectKey, aspectRatio, exactUrl, 'exact');
          return exactUrl;
        }
      }

      // 6. NORMALIZE → OUTPAINT → VALIDATE → PAD. Ported from the LLM
      //    Expander's runSafeZoneReframe (media.ts:1117-1227). `billed` flips
      //    true as soon as the billable POST is away and is NEVER cleared, so
      //    the ledger records the charge on EVERY subsequent path — a rejected
      //    output, a failed download, a poll timeout, or a fall-through to the
      //    $0 pad. An unledgered charge is invisible; that's the failure mode
      //    this ordering exists to prevent.
      const { w: W, h: H } = imageDimsForAspect(aspectRatio);
      let billed    = false;
      let resultUrl = null;
      let method    = null;

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
          prompt: uncropPromptForAspect(aspectRatio),
          aspectRatio,
          resolution: REFRAME_RESOLUTION()
        });
        // Charge point. submitImageGeneration's own contract is "NO retry (POST
        // is charged)", so the money is committed HERE — before the poll, not
        // after it. Setting `billed` at terminal-ok instead would lose the
        // charge whenever polling times out on a prediction Atlas later
        // completes and bills. Worst case this over-attributes a genuinely
        // failed prediction, which is the safe direction: an overstated ledger
        // is visible and correctable, an understated one is neither.
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
        // err.charged: the POST resolved (Atlas accepted, and may have billed)
        // but the response carried no prediction id, so we can't poll for it.
        // Still record the spend rather than lose it.
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
          const padBuf = await padToRatioBuffer(srcNorm.buffer, W, H);
          if (padBuf) {
            const up = await uploadBufferToCloudinary(padBuf, { folder: 'liquidretail/reframes' });
            const url = up.secure_url || up.url;
            if (url) { resultUrl = url; method = 'pad-fallback'; }
          }
        } catch (err) {
          console.warn(`⚠️  reframeReferenceForAspect[${aspectKey}]: pad fallback failed — ${err.message}`);
        }
      }

      // 7. Ledger the spend EXACTLY ONCE if Atlas billed us — on every path,
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
      //    stop a second POST for an asset we already paid for.
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

      // Billed, but nothing usable came out of it (pad build AND upload failed).
      // Persist the deterministic crop so the next render can't charge us a
      // second time for this media+aspect. Labelled honestly so a targeted
      // invalidation can find these later via method + ladderVersion.
      const cropUrl = fallback();
      if (billed && cropUrl) {
        await persistReframe(media, aspectKey, aspectRatio, cropUrl, 'crop-after-bill');
      }
      return cropUrl;
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

// method: 'exact' | 'outpaint' | 'pad-fallback' | 'crop-after-bill'
// ladderVersion lets a future change invalidate $0 tiers selectively without
// re-spending on entries that cost real money.
async function persistReframe(media, aspectKey, aspectRatio, finalUrl, method) {
  if (!finalUrl) return;
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
  if (!media?._id) return;
  try {
    await Media.updateOne(
      { _id: media._id },
      { $set: { [`metadata.reframes.${aspectKey}`]: entry } }
    );
  } catch (err) {
    console.warn(`⚠️  reframeReferenceForAspect: persist failed (url kept) — ${err.message}`);
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
  const capped = ids.slice(0, maxImages);

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
  return /(\bcode\b\s*[:=]\s*429|\bstatus\b\s*[:=]\s*429|http status code:\s*429|rate[- ]?limit|too many requests)/i.test(body);
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
function buildSubmissionBody({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl = null, durationSec = null }) {
  switch (caps.paramShape) {
    case 'gemini-omni':
      // duration MUST be sent explicitly (Atlas enum 4|6|8|10) — the 8s
      // output is a downstream contract (brand scripts assume 8s @ 24fps).
      return {
        model,
        prompt,
        images: imageUrls,
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
        images: imageUrls.slice(0, caps.maxReferenceImages || 5),
        duration,
        aspect_ratio: aspectRatio,
        resolution: process.env.ATLAS_VIDEO_RESOLUTION || caps.defaultResolution || '720p'
      };
    }
    case 'grok':
      return {
        model,
        prompt,
        image_urls: imageUrls,
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
        image_url: imageUrls[0],
        duration: durationSec || caps.defaultDuration || 8,
        resolution: caps.defaultResolution || '720p',
        aspect_ratio: aspectRatio
      };
    case 'veo':
      return {
        model,
        prompt,
        image_url: imageUrls[0],
        aspect_ratio: aspectRatio
      };
    default:
      return {
        model,
        prompt,
        image_url: imageUrls[0]
      };
  }
}

async function submitGeneration({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl = null, durationSec = null }) {
  const body = buildSubmissionBody({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl, durationSec });

  console.log(
    `🎬 atlasVideo.submit: model=${model} aspect=${aspectRatio} refs=${imageUrls.length} ` +
    `paramShape=${caps.paramShape} promptChars=${prompt.length} promptBytes=${Buffer.byteLength(prompt, 'utf8')} promptProfile=${promptProfileFor(caps)}`
  );



  // Bounded rate-limit retry — same isRateLimit detection + RATE_LIMIT_BACKOFF_MS
  // schedule as pollPrediction. Under VEO_CONCURRENCY > 1 the provider 429s
  // (sometimes wrapped in an Atlas 500) on submit; without this the ad fails
  // before any prediction id exists. Non-rate-limit errors still throw
  // immediately. Cap of 4 attempts (1 initial + 3 backoffs).
  const maxAttempts = 4;
  let consecutiveRateLimits = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.post(
        `${BASE_URL}/model/generateVideo`,
        body,
        {
          headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
          timeout: 60000
        }
      );
      const predictionId = res.data?.data?.id;
      if (!predictionId) throw new Error(`atlasVideo: no prediction id in response: ${JSON.stringify(res.data).slice(0, 300)}`);
      return predictionId;
    } catch (err) {
      // "no prediction id" is a successful HTTP response with a bad body —
      // not a rate-limit; rethrow immediately.
      if (err.message && err.message.startsWith('atlasVideo: no prediction id')) throw err;

      const summary = summarizeAxiosError(err);
      if (isRateLimit(summary) && attempt < maxAttempts) {
        consecutiveRateLimits++;
        const backoffMs = RATE_LIMIT_BACKOFF_MS[Math.min(consecutiveRateLimits - 1, RATE_LIMIT_BACKOFF_MS.length - 1)];
        console.warn(
          `   ⏳ atlasVideo: submit rate-limited ` +
          `(hit #${consecutiveRateLimits}, attempt ${attempt}/${maxAttempts}, backing off ${backoffMs / 1000}s): ${summary.body || summary.message}`
        );
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      // Exhausted retries, or a non-rate-limit error — surface immediately.
      if (isRateLimit(summary)) {
        throw new Error(
          `atlasVideo: submit rate-limited after ${maxAttempts} attempts: ${summary.body || summary.message}`
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

  const t0 = Date.now();
  const predictionId = await submitGeneration({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl, durationSec });
  console.log(`🎬 atlasVideo[ad=${ad._id}]: prediction=${predictionId} polling...`);

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

  // Cost telemetry — flat per-render estimate from the registry's
  // pricing entry, mirroring the duration/resolution the submission
  // body requested. Lands in CostLog alongside the pipeline's LLM
  // entries so per-brand/per-campaign rollups include video spend.
  const renderResolution = String(caps.paramShape || '').startsWith('gemini-omni')
    ? (process.env.ATLAS_VIDEO_RESOLUTION || caps.defaultResolution || '720p')
    : (caps.defaultResolution || '720p');
  const costUsd = estimateRenderCostUsd({
    model,
    durationSec,
    resolution:  renderResolution
  });
  // Non-fatal: render + Cloudinary mirror already succeeded. A telemetry
  // rejection here must not fail generateForAd post-payment — the caller
  // would never store videoUrl, and a retry would double-bill the provider.
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
      durationMs: elapsedMs
    });
  } catch (err) {
    console.warn('⚠️ atlasVideo cost telemetry failed (non-fatal): ' + err.message);
  }

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
    referenceImages:    imageUrls,   // the exact stack sent to the model (pos 0 = seed, then product hero + alts) — for the generation inspector
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
    byteCap: caps?.promptByteCap || 4096
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
  buildPromptScaffold
};
