// Phase X.1 (shadow experiment) — AI Image Reference.
//
// For each AiCanvasArtifact we generate, also fire a single gpt-image-1
// call that synthesizes a complete ad from the SAME Director concept +
// brand/product context. The output is persisted as AiFullRenderArtifact
// and surfaced side-by-side with the deterministic render in the spec
// preview, so we can eyeball the gap between "what our layout pipeline
// can compose" vs "what raw image gen produces from the same brief."
//
// Opt-in: set AI_IMAGE_REFERENCE_ENABLED=true to enable. Off by default
// because image gen runs $0.042/call medium quality 1024² — a 24-ad
// batch is ~$1 of image-gen cost on top of the LLM spend.
//
// Shadow only — no caller relies on the result for the render path.

const crypto       = require('crypto');
const OpenAI       = require('openai');

const Brand                     = require('../models/Brand');
const CatalogProduct            = require('../models/CatalogProduct');
const AiCanvasArtifact          = require('../models/AiCanvasArtifact');
const AiFullRenderArtifact      = require('../models/AiFullRenderArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { trackLlmCall, recordCacheHit } = require('./costTracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID = 'gpt-image-1';
const QUALITY  = 'medium';     // low=$0.011 / medium=$0.042 / high=$0.167 (1024²)

// gpt-image-1 only supports these three sizes.
function sizeForRatio(aspectRatio) {
  switch (String(aspectRatio || '').trim()) {
    case '9:16':
    case '4:5':   return { size: '1024x1536', width: 1024, height: 1536 };
    case '1.91:1':
    case '5:4':   return { size: '1536x1024', width: 1536, height: 1024 };
    case '1:1':
    default:      return { size: '1024x1024', width: 1024, height: 1024 };
  }
}

// Per-call USD estimate (medium tier). Keeps cost telemetry comparable
// to the LLM stages; not authoritative for billing.
function estimateCostUsd(size) {
  if (size === '1024x1024') return 0.042;
  return 0.063;
}

function enabled() {
  return String(process.env.AI_IMAGE_REFERENCE_ENABLED || '').toLowerCase() === 'true';
}

// ── Public API ───────────────────────────────────────────────────────

async function generateForArtifact({ aiCanvasArtifactId, refresh = false }) {
  if (!enabled() && !refresh) {
    return { skipped: true, reason: 'AI_IMAGE_REFERENCE_ENABLED=false' };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { skipped: true, reason: 'OPENAI_API_KEY not set' };
  }

  const canvas = await AiCanvasArtifact.findById(aiCanvasArtifactId).lean();
  if (!canvas) throw new Error(`AiCanvasArtifact ${aiCanvasArtifactId} not found`);

  const filter = {
    mediaId:             canvas.mediaId,
    template:            canvas.template,
    aspectRatio:         canvas.aspectRatio,
    productId:           canvas.productId,
    variantKind:         canvas.variantKind,
    campaignContextHash: canvas.campaignContextHash,
    paletteSource:       canvas.paletteSource,
    creativeStyle:       canvas.creativeStyle
  };

  if (!refresh) {
    const cached = await AiFullRenderArtifact.findOne(filter).lean();
    if (cached) {
      recordCacheHit({
        stage:    'image_reference',
        provider: 'openai',
        model:    MODEL_ID,
        brandId:  canvas.brandId,
        productId: canvas.productId,
        mediaId:  canvas.mediaId,
        cacheKey: JSON.stringify(filter)
      }).catch(() => {});
      return { artifact: cached, cached: true };
    }
  }

  // Pull the source brand + product + Director concept that drove this
  // canvas. Brand/product give the visual identity; concept gives the
  // archetype + emotional hook + recommended treatment.
  const [brand, product, direction] = await Promise.all([
    canvas.brandId             ? Brand.findById(canvas.brandId).lean() : null,
    canvas.productId           ? CatalogProduct.findById(canvas.productId).lean() : null,
    canvas.directionArtifactId ? CreativeDirectionArtifact.findById(canvas.directionArtifactId).lean() : null
  ]);

  const concept = direction?.concepts?.find(c => c.concept_id === canvas.directionConceptId) || null;

  const prompt = buildPrompt({
    brand, product, concept,
    aspectRatio:   canvas.aspectRatio,
    creativeStyle: canvas.creativeStyle,
    canvasSpec:    canvas.canvasSpec
  });
  const promptHash = sha256(prompt);
  const { size, width, height } = sizeForRatio(canvas.aspectRatio);

  const t0 = Date.now();
  const res = await trackLlmCall(
    {
      stage:      'image_reference',
      provider:   'openai',
      model:      MODEL_ID,
      purposeTag: canvas.template || 'untagged',
      brandId:    canvas.brandId,
      productId:  canvas.productId,
      mediaId:    canvas.mediaId,
      cacheKey:   JSON.stringify(filter),
      visionImages: 0
    },
    () => openai.images.generate({
      model:   MODEL_ID,
      prompt,
      size,
      quality: QUALITY,
      n:       1
    })
  );
  const elapsedMs = Date.now() - t0;

  const b64 = res?.data?.[0]?.b64_json;
  if (!b64) throw new Error('gpt-image-1 returned no image data');
  const buf = Buffer.from(b64, 'base64');

  const uploaded = await uploadBufferToCloudinary(buf, {
    folder: 'liquidretail/ai_image_reference'
  });

  const artifact = await AiFullRenderArtifact.findOneAndReplace(
    filter,
    {
      ...filter,
      advertiserId:       canvas.advertiserId || null,
      brandId:            canvas.brandId      || null,
      imageUrl:           uploaded.secure_url,
      cloudinaryPublicId: uploaded.public_id,
      modelId:            MODEL_ID,
      promptHash,
      promptText:         prompt,
      width, height,
      costEstimateUsd:    estimateCostUsd(size),
      elapsedMs,
      createdAt:          new Date()
    },
    { upsert: true, new: true, includeResultMetadata: false }
  );

  console.log(
    `🖼  imageReference[${canvas.template}/${canvas.aspectRatio}/${canvas.creativeStyle}]: ` +
    `media=${canvas.mediaId} product=${canvas.productId || '-'} ` +
    `concept=${canvas.directionConceptId || '-'} size=${size} took=${elapsedMs}ms`
  );

  return { artifact: artifact.toObject ? artifact.toObject() : artifact, cached: false };
}

// ── Prompt construction ──────────────────────────────────────────────
// We're asking gpt-image-1 to produce a complete social ad — composition,
// typography, brand color, product/UGC integration. Give it the same
// strategic brief the Layout Generator works from, plus the actual copy
// the canvas picked (so headline/CTA wording matches).

function buildPrompt({ brand, product, concept, aspectRatio, creativeStyle, canvasSpec }) {
  const brandName    = brand?.name || 'the brand';
  const brandTone    = Array.isArray(brand?.tone) && brand.tone.length ? brand.tone.slice(0, 4).join(', ') : null;
  const primary      = brand?.primaryColor   || null;
  const secondary    = brand?.secondaryColor || null;

  const productName  = product?.title    || null;
  const category     = product?.category || null;

  // Pull whatever copy the canvas picked so the gen-image headline
  // matches what the deterministic render would show.
  const picked = pickCopyFromSpec(canvasSpec) || {};

  const lines = [];
  lines.push(`A polished social-media advertisement at ${aspectRatio} aspect ratio.`);
  lines.push(`Brand: ${brandName}${brandTone ? ` (tone: ${brandTone})` : ''}.`);
  if (productName) lines.push(`Featured product: ${productName}${category ? ` — ${category}` : ''}.`);
  if (primary || secondary) {
    lines.push(`Brand palette: ${[primary, secondary].filter(Boolean).join(' and ')}. Use these as accent colors, not necessarily as solid fills.`);
  }
  lines.push(`Creative style: ${creativeStyle}.`);

  if (concept) {
    lines.push(``);
    lines.push(`Strategy from creative director:`);
    if (concept.archetype)        lines.push(`- Archetype: ${humanArchetype(concept.archetype)}`);
    if (concept.layout_family)    lines.push(`- Layout family: ${concept.layout_family}`);
    if (concept.emotional_hook)   lines.push(`- Emotional hook: ${concept.emotional_hook}`);
    if (concept.social_proof_type && concept.social_proof_type !== 'none') {
      lines.push(`- Social proof type: ${concept.social_proof_type} (include a visible proof element matching this)`);
    }
    if (concept.cta_emphasis)     lines.push(`- CTA emphasis: ${concept.cta_emphasis}`);
    if (concept.rationale)        lines.push(`- Rationale: ${concept.rationale}`);
  }

  if (picked.headline || picked.cta || picked.eyebrow) {
    lines.push(``);
    lines.push(`Render the following copy LEGIBLY (typeset, well-kerned, not garbled):`);
    if (picked.eyebrow)  lines.push(`- Eyebrow: "${picked.eyebrow}"`);
    if (picked.headline) lines.push(`- Headline: "${picked.headline}"`);
    if (picked.cta)      lines.push(`- CTA button: "${picked.cta}"`);
  }

  lines.push(``);
  lines.push(
    `Production notes: photoreal where photographic, typographically sharp, no watermarks, no Lorem Ipsum, no placeholder text. ` +
    `If the strategy calls for social proof you must surface a believable testimonial/stat/rating with real-looking attribution. ` +
    `Compose for the chosen archetype — do not default to "centered product on neutral background."`
  );

  return lines.join('\n');
}

function pickCopyFromSpec(spec) {
  if (!spec || !Array.isArray(spec.zones)) return null;
  const out = {};
  for (const z of spec.zones) {
    const slot = z?.slot || '';
    const text = z?.text || z?.copy || null;
    if (!text) continue;
    if (/headline/i.test(slot) && !out.headline) out.headline = String(text).slice(0, 140);
    if (/cta/i.test(slot)      && !out.cta)      out.cta      = String(text).slice(0, 40);
    if (/eyebrow/i.test(slot)  && !out.eyebrow)  out.eyebrow  = String(text).slice(0, 60);
  }
  return out;
}

function humanArchetype(slug) {
  return String(slug || '').replace(/_/g, ' ');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

module.exports = {
  generateForArtifact,
  enabled,
  MODEL_ID,
  QUALITY
};
