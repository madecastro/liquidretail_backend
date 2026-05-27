// AI Layout Studio — exploration tool that asks gpt-image-1 to generate 9
// ad layouts (3 content variants × 3 aspect ratios) for a given Media's
// brand/product, then runs each through gpt-4.1 Vision to extract a
// structured zone map (role + rectPct + contrast + confidence).
//
// Purpose: test whether the hallucination-prone AI outputs can still serve
// as good LAYOUT references — we never use the AI pixels as final ad output;
// the deterministic renderer uses the extracted zone geometry with our real
// text/logo/data drawn in.
//
// Not cached, not persisted — minimum-scope concept explorer. If results
// prove viable the next step is a BrandCanvasVariant model that promotes
// user-approved extractions into the template registry.

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const Media                = require('../models/Media');
const DetectionArtifact    = require('../models/DetectionArtifact');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const AiLayoutSession      = require('../models/AiLayoutSession');
const { findBrandByName }  = require('./brandCatalogService');
const { uploadBufferToCloudinary } = require('./cloudinaryService');

const DEFAULT_VARIANTS       = ['brand', 'product', 'social'];
const DEFAULT_ASPECT_RATIOS  = ['1:1', '9:16', '1.91:1'];

// gpt-image-1 native sizes. 1.91:1 isn't exact; 1536×1024 is the closest
// landscape option, renderer can crop to 1.91:1 on the frontend side.
const RATIO_TO_SIZE = {
  '1:1':    '1024x1024',
  '9:16':   '1024x1536',
  '1.91:1': '1536x1024'
};

// Default to low quality for a cheap exploration session (~$0.11 for 9
// images). Callers can override to 'medium' / 'high' when an extraction
// looks promising enough to want a high-fidelity reference.
const DEFAULT_QUALITY = 'low';

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    zones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role:       { type: 'string', enum: ['logo', 'hero_media', 'product_media', 'creator_media', 'quote_card', 'cta', 'rating_bar', 'product_meta', 'headline', 'subheadline', 'badge_row', 'background', 'other'] },
          rectPct:    {
            type: 'object',
            properties: {
              x1: { type: 'number' }, y1: { type: 'number' },
              x2: { type: 'number' }, y2: { type: 'number' }
            },
            required: ['x1', 'y1', 'x2', 'y2']
          },
          contrastBg: { type: 'string', enum: ['dark', 'light', 'mixed'] },
          confidence: { type: 'number' },
          notes:      { type: 'string' }
        },
        required: ['role', 'rectPct', 'contrastBg', 'confidence']
      }
    },
    overallStyle:    { type: 'string', enum: ['clean', 'editorial', 'bold', 'playful', 'luxury', 'minimalist', 'social-native', 'other'] },
    dominantColors:  { type: 'array', items: { type: 'string' } }
  },
  required: ['zones', 'overallStyle']
};

async function generateAiLayouts({ mediaId, variants, aspectRatios, quality }) {
  if (!process.env.OPENAI_API_KEY) throw badRequest('OPENAI_API_KEY not set');

  const ctx = await loadContext(mediaId);
  if (!ctx) throw notFound(`Media ${mediaId} not found`);

  const vSet = (Array.isArray(variants) && variants.length ? variants : DEFAULT_VARIANTS)
    .filter(v => DEFAULT_VARIANTS.includes(v));
  const rSet = (Array.isArray(aspectRatios) && aspectRatios.length ? aspectRatios : DEFAULT_ASPECT_RATIOS)
    .filter(r => RATIO_TO_SIZE[r]);
  const q = ['low', 'medium', 'high'].includes(quality) ? quality : DEFAULT_QUALITY;

  const combos = [];
  for (const v of vSet) for (const r of rSet) combos.push({ variant: v, aspectRatio: r });

  const t0 = Date.now();
  console.log(`🎨 ai-layouts: generating ${combos.length} references for media=${mediaId} (quality=${q})`);

  // Run in parallel — wall time limited by the slowest generation.
  // Per-combo failure is non-fatal (one bad generation doesn't block the rest).
  const references = await Promise.all(combos.map(async (c) => {
    try {
      const imageUrl = await generateReferenceImage(ctx, c.variant, c.aspectRatio, q);
      let extractedCanvas = null;
      try { extractedCanvas = await extractLayoutFromImage(imageUrl); }
      catch (err) { console.warn(`   ⚠️  ai-layouts[${c.variant}/${c.aspectRatio}] extraction failed: ${err.message}`); }
      return { ...c, imageUrl, extractedCanvas, status: 'ok' };
    } catch (err) {
      console.warn(`   ⚠️  ai-layouts[${c.variant}/${c.aspectRatio}] generation failed: ${err.message}`);
      return { ...c, status: 'error', error: err.message };
    }
  }));

  const ok = references.filter(r => r.status === 'ok').length;
  console.log(`🎨 ai-layouts: ${ok}/${combos.length} references ready in ${Date.now() - t0}ms`);

  return {
    mediaId,
    brandName: ctx.brand?.name || ctx.media.metadata?.brand || null,
    productName: ctx.match?.identification?.productName || null,
    quality: q,
    generatedAt: new Date(),
    references
  };
}

async function loadContext(mediaId) {
  const media = await Media.findById(mediaId).lean();
  if (!media) return null;
  const [detection, match] = await Promise.all([
    media.latestArtifacts?.detection ? DetectionArtifact.findById(media.latestArtifacts.detection).lean() : null,
    media.latestArtifacts?.match     ? ProductMatchArtifact.findById(media.latestArtifacts.match).lean()   : null
  ]);
  const brandName = match?.identification?.brand || media.metadata?.brand || null;
  const brand = brandName
    ? await findBrandByName(brandName).then(b => b?.toObject?.() || b).catch(() => null)
    : null;
  return { media, detection, match, brand };
}

// ──────────────────────────────────────────────────────────────
//  Generation
// ──────────────────────────────────────────────────────────────
async function generateReferenceImage(ctx, variant, aspectRatio, quality) {
  const prompt = buildGenerationPrompt(ctx, variant, aspectRatio);
  const size = RATIO_TO_SIZE[aspectRatio];

  const res = await openai.images.generate({
    model:  'gpt-image-1',
    prompt,
    size,
    quality,
    n: 1
  });

  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error('gpt-image-1 returned no image');

  const buf = Buffer.from(b64, 'base64');
  const up = await uploadBufferToCloudinary(buf, { resourceType: 'image' });
  return up.secure_url;
}

function buildGenerationPrompt(ctx, variant, aspectRatio) {
  const brand = ctx.brand || {};
  const ident = ctx.match?.identification || {};
  const details = ident.details || {};
  const media = ctx.media;
  const detection = ctx.detection;

  const brandName  = brand.name || ident.brand || media.metadata?.brand || 'the brand';
  const tone       = Array.isArray(brand.tone) && brand.tone.length ? brand.tone.join(', ') : 'modern, trustworthy';
  const primary    = brand.primaryColor   || '#1f2937';
  const accent     = brand.accentColor    || '#ef4444';
  const secondary  = brand.secondaryColor || '';
  const category   = media.metadata?.category || 'consumer product';
  const productName = ident.productName || 'the product';
  const price      = details.price?.display || '';
  const rating     = typeof details.rating === 'number' ? `${details.rating}★` : '';
  const reviewCnt  = typeof details.reviewCount === 'number' ? details.reviewCount : null;

  const variantGuidance = {
    brand: `BRAND-LED composition. The brand's visual identity is the hero. Large hero image or brand-color gradient dominates, with a prominent brand wordmark area (large but not filling the whole frame — leave room for layout). Tagline or short headline. Product appears in a supporting position. Prominent CTA button.`,
    product: `PRODUCT-LED composition. A clear photograph of ${productName} dominates the composition. Include a small name/price caption near the product, a small trust badge or rating chip, and a prominent CTA button in the bottom third. Minimal decoration.`,
    social: `SOCIAL-PROOF composition. Prominent quote card (white or light background, rectangular) with short testimonial text. Star rating graphic with ${rating || 'rating stars'}${reviewCnt ? ` and "${reviewCnt.toLocaleString()} reviews" text` : ''}. Product image in a supporting position. Creator handle chip optional. CTA button in the bottom third.`
  };

  return [
    `Create a ${aspectRatio} social-media ad layout for ${brandName}, a ${category} brand.`,
    `Tone: ${tone}.`,
    `Brand colors: primary ${primary}, accent ${accent}${secondary ? `, secondary ${secondary}` : ''}.`,
    ``,
    `FOCUS — ${variant}:`,
    variantGuidance[variant] || variantGuidance.social,
    ``,
    `CRITICAL LAYOUT REQUIREMENTS (these make the layout reusable — we extract zone geometry from this image):`,
    `  1. Use DISTINCT RECTANGULAR ZONES with clear visual separation. Avoid overlapping or free-floating elements.`,
    `  2. Logo slot: reserve a small rectangular area in a corner (a placeholder mark or solid shape is fine — actual logo will be rendered separately).`,
    `  3. CTA button: a colored rounded-rectangle in the bottom third of the frame. Short imperative label.`,
    `  4. Text zones: any text sits on solid or semi-transparent rectangles (cards, chips, bars). Not overlaid directly on complex photography.`,
    `  5. Hero media region: distinct edges — visibly a separate rectangular panel from copy areas.`,
    `  6. Use the brand colors prominently.`,
    ``,
    `Style: clean, professional, mobile-first social-feed aesthetic. Photography-led, not illustrated.`,
    `The goal is a layout that is easy for an automated system to decompose into zone rectangles.`
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────
//  Extraction
// ──────────────────────────────────────────────────────────────
async function extractLayoutFromImage(imageUrl) {
  const prompt = [
    `You are analyzing a social-media ad layout. Decompose it into rectangular zones and return JSON matching the schema.`,
    ``,
    `For each zone, emit:`,
    `  - role: what the zone is functionally (logo, hero_media, product_media, creator_media, quote_card, cta, rating_bar, product_meta, headline, subheadline, badge_row, background, other)`,
    `  - rectPct: normalized coordinates where (0,0) is top-left and (1,1) is bottom-right. x2 > x1 and y2 > y1, all within [0,1].`,
    `  - contrastBg: the BACKGROUND under this zone — dark, light, or mixed.`,
    `  - confidence: 0-1 how sure you are this is a real, distinct zone.`,
    `  - notes: short description of the zone's visible content (garbled text is OK — describe what you see).`,
    ``,
    `Also emit overallStyle (clean / editorial / bold / playful / luxury / minimalist / social-native / other) and dominantColors as 2-5 hex strings.`,
    ``,
    `Identify 4-8 distinct zones. Focus on structural layout — don't try to read garbled AI text. Use tight bounding rectangles (no extra padding).`
  ].join('\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }],
    max_tokens: 2000,
    temperature: 0.2
  });

  const raw = response.choices[0].message.content.trim();
  const parsed = JSON.parse(raw);

  // Lightweight validation — drop malformed zones.
  const zones = (parsed.zones || []).filter(z => {
    const r = z.rectPct;
    return r && typeof r.x1 === 'number' && typeof r.x2 === 'number'
        && typeof r.y1 === 'number' && typeof r.y2 === 'number'
        && r.x2 > r.x1 && r.y2 > r.y1;
  }).map((z, i) => ({
    id: `z${i + 1}`,
    role: z.role || 'other',
    rectPct: {
      x1: clamp01(z.rectPct.x1),
      y1: clamp01(z.rectPct.y1),
      x2: clamp01(z.rectPct.x2),
      y2: clamp01(z.rectPct.y2)
    },
    contrastBg: z.contrastBg || 'mixed',
    confidence: Math.max(0, Math.min(1, Number(z.confidence) || 0)),
    notes: z.notes || ''
  }));

  return {
    zones,
    overallStyle: parsed.overallStyle || 'other',
    dominantColors: Array.isArray(parsed.dominantColors) ? parsed.dominantColors.slice(0, 5) : []
  };
}

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function notFound(msg)   { const e = new Error(msg); e.status = 404; return e; }

// ──────────────────────────────────────────────────────────────
//  Session-based runner (background-job pattern)
// ──────────────────────────────────────────────────────────────
// Called via setImmediate from the route handler. Never throws to
// the caller; all errors are captured on the session doc so the
// polling client can surface them. Writes each reference as it
// settles so the client sees progress on every poll.
async function runSession(sessionId) {
  let session;
  try {
    session = await AiLayoutSession.findById(sessionId);
  } catch (err) {
    console.warn(`🎨 ai-layouts.runSession(${sessionId}): session load failed — ${err.message}`);
    return;
  }
  if (!session) {
    console.warn(`🎨 ai-layouts.runSession(${sessionId}): session not found`);
    return;
  }

  try {
    const ctx = await loadContext(session.mediaId);
    if (!ctx) {
      session.status = 'failed';
      session.error = `Media ${session.mediaId} not found`;
      session.completedAt = new Date();
      await session.save();
      return;
    }

    // Stamp display context + transition to running so the client's
    // first poll sees brand/product name and progress info.
    session.brandName   = ctx.brand?.name || ctx.media.metadata?.brand || null;
    session.productName = ctx.match?.identification?.productName || null;
    session.status      = 'running';
    session.startedAt   = new Date();
    await session.save();

    const q = ['low', 'medium', 'high'].includes(session.quality) ? session.quality : DEFAULT_QUALITY;
    const vSet = session.variants?.length     ? session.variants     : DEFAULT_VARIANTS;
    const rSet = session.aspectRatios?.length ? session.aspectRatios : DEFAULT_ASPECT_RATIOS;
    const combos = [];
    for (const v of vSet) for (const r of rSet) combos.push({ variant: v, aspectRatio: r });

    const t0 = Date.now();
    console.log(`🎨 ai-layouts.runSession(${sessionId}): generating ${combos.length} refs (quality=${q})`);

    // Per-combo: generate + extract + push to session.references[].
    // Wrapped individually so one combo's failure can't reject the
    // Promise.all and short-circuit the rest.
    await Promise.all(combos.map(async (c) => {
      let ref;
      try {
        const imageUrl = await generateReferenceImage(ctx, c.variant, c.aspectRatio, q);
        let extractedCanvas = null;
        try { extractedCanvas = await extractLayoutFromImage(imageUrl); }
        catch (err) { console.warn(`   ⚠️  ai-layouts[${c.variant}/${c.aspectRatio}] extraction failed: ${err.message}`); }
        ref = { ...c, imageUrl, extractedCanvas, status: 'ok' };
      } catch (err) {
        console.warn(`   ⚠️  ai-layouts[${c.variant}/${c.aspectRatio}] generation failed: ${err.message}`);
        ref = { ...c, status: 'error', error: err.message };
      }
      // $push so each reference appears on the next client poll.
      // Doesn't conflict with the final status update — that's a
      // separate $set after Promise.all settles.
      try {
        await AiLayoutSession.updateOne(
          { _id: sessionId },
          { $push: { references: ref } }
        );
      } catch (err) {
        console.warn(`   ⚠️  ai-layouts session push failed for ${c.variant}/${c.aspectRatio}: ${err.message}`);
      }
    }));

    await AiLayoutSession.updateOne(
      { _id: sessionId },
      { $set: { status: 'completed', completedAt: new Date() } }
    );
    console.log(`🎨 ai-layouts.runSession(${sessionId}): completed in ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`🎨 ai-layouts.runSession(${sessionId}): top-level failure — ${err.message}`);
    try {
      await AiLayoutSession.updateOne(
        { _id: sessionId },
        { $set: { status: 'failed', error: err.message || 'unknown error', completedAt: new Date() } }
      );
    } catch (_) { /* nothing else to do */ }
  }
}

module.exports = { generateAiLayouts, runSession, DEFAULT_VARIANTS, DEFAULT_ASPECT_RATIOS };
