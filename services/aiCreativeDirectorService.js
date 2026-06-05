// Phase 1 — AI Creative Director.
//
// Picks creative concepts (strategy + hierarchy + recommended components,
// NO coordinates) per (brandId, productId, campaignKind, creativeIntent).
//
// Caching: one CreativeDirectionArtifact per cache key. A 24-ad batch
// using 4 products produces 4 Director calls regardless of how many
// templates, ratios, or palettes the cartesian fans out to. (Lever 1
// from the cost-savings plan — biggest single $/ad reduction.)
//
// Shadow mode through Phase 1: artifacts are persisted but the render
// pipeline still uses the legacy aiCanvasSpec path. Phase 2 wires the
// Generator to read concepts from here.

const crypto = require('crypto');
const OpenAI = require('openai');

const Brand                 = require('../models/Brand');
const CatalogProduct        = require('../models/CatalogProduct');
const Media                 = require('../models/Media');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');

const { ROLES, COMPONENT_STYLE_BY_ROLE } = require('./aiVocabulary');
const { trackLlmCall, recordCacheHit } = require('./costTracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Tunables ─────────────────────────────────────────────────────────

const MODEL_ID    = 'gpt-4.1';
const TEMPERATURE = 0.7;          // creative direction wants nuance, not wild variance
const N_CONCEPTS  = 2;            // two distinct concepts per call (cheaper than running twice)
const MAX_TOKENS  = 2000;

// Canonical archetype enum (the 8 we've been using, with descriptive
// names matching the contract). Director picks from these; Generator
// must materialize.
const AVAILABLE_ARCHETYPES = Object.freeze([
  'full_bleed_hero_bottom_panel',  // A — classic safe default
  'vertical_split',                // B — image + brand panel side-by-side
  'diagonal_carve',                // C — angled clipPolygon split
  'typographic_dominant',          // D — headline IS the hero
  'hero_quote_overlay',            // E — full-bleed photo + overlaid testimonial
  'magazine_editorial',            // F — print-spread aesthetic
  'stat_led_social_proof',         // G — numeric stat is the visual anchor
  'product_card_grid'              // H — multi-product mosaic
]);

const CREATIVE_RULES = Object.freeze({
  do_not_generate_coordinates:    true,
  produce_distinct_concepts:      true,
  prioritize_strongest_signal:    true,
  avoid_repeating_same_archetype: true
});

// ── Public API ───────────────────────────────────────────────────────

async function directConcepts({
  brandId,
  productId      = null,
  campaignKind   = null,
  creativeIntent = null,
  refresh        = false
}) {
  if (!brandId) throw badRequest('brandId required');
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY not set'); e.status = 500; throw e;
  }

  const filter = {
    brandId,
    productId:      productId      || null,
    campaignKind:   campaignKind   || null,
    creativeIntent: creativeIntent || null
  };
  const cacheKey = JSON.stringify({
    brandId: String(brandId),
    productId: productId ? String(productId) : null,
    campaignKind, creativeIntent
  });

  if (!refresh) {
    const cached = await CreativeDirectionArtifact.findOne(filter).lean();
    if (cached) {
      recordCacheHit({
        stage:    'creative_director',
        provider: 'openai',
        model:    MODEL_ID,
        brandId, productId,
        cacheKey
      }).catch(() => {});
      return { artifact: cached, cached: true };
    }
  }

  // Build the input_summary from the actual data
  const inputSummary = await assembleSignals({ brandId, productId, campaignKind });
  const { system, user } = buildPrompt({ inputSummary, creativeIntent });
  const promptHash = sha256(system + '\n' + user);

  // OpenAI strict JSON schema constrains the output to N concepts with
  // the shape the contract spells out. We only ask the LLM for concepts;
  // input_summary / available_archetypes / creative_rules are added
  // server-side.
  const responseSchema = buildResponseSchema();

  const t0 = Date.now();
  const completion = await trackLlmCall(
    {
      stage:      'creative_director',
      provider:   'openai',
      model:      MODEL_ID,
      purposeTag: campaignKind || 'untagged',
      brandId, productId,
      visionImages: 0,
      cacheKey
    },
    () => openai.chat.completions.create({
      model: MODEL_ID,
      response_format: { type: 'json_schema', json_schema: responseSchema },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: TEMPERATURE,
      max_tokens:  MAX_TOKENS
    })
  );
  const elapsedMs = Date.now() - t0;

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Director returned no content');

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`Director response not JSON: ${err.message}`); }

  const warnings = validateConcepts(parsed.concepts || []);

  console.log(
    `🎭 creativeDirector[${campaignKind || '-'}]: ` +
    `brand=${brandId} product=${productId || '-'} intent=${creativeIntent || '-'} ` +
    `concepts=${(parsed.concepts || []).length} took=${elapsedMs}ms warnings=${warnings.length}`
  );

  const artifact = await CreativeDirectionArtifact.findOneAndReplace(
    filter,
    {
      ...filter,
      contractVersion:    '1.0',
      contractSchemaId:   'creative_direction.v1',
      inputSummary,
      availableArchetypes:     [...AVAILABLE_ARCHETYPES],
      availableComponentRoles: [...ROLES],
      creativeRules:           { ...CREATIVE_RULES },
      concepts:                parsed.concepts || [],
      provider:    'openai',
      modelId:     MODEL_ID,
      promptHash,
      promptSystem: system,
      promptUser:   user,
      rawResponse:  raw,
      validationWarnings: warnings,
      createdAt:    new Date()
    },
    { upsert: true, new: true, includeResultMetadata: false }
  );

  return { artifact: artifact.toObject ? artifact.toObject() : artifact, cached: false };
}

// ── Signal assembly ──────────────────────────────────────────────────
// Walks Brand + CatalogProduct + the product's matched-media to build
// the input_summary block. Deterministic (no LLM) — just bucket counts
// into high/medium/low strength labels.

async function assembleSignals({ brandId, productId, campaignKind }) {
  const [brand, product] = await Promise.all([
    Brand.findById(brandId).lean(),
    productId ? CatalogProduct.findById(productId).lean() : null
  ]);

  const matchedMediaIds = product?.matchedMedia
    ? product.matchedMedia.map(mm => mm.mediaId).filter(Boolean).slice(0, 10)
    : [];

  // Load representative media for stat aggregation.
  let medias = [];
  if (matchedMediaIds.length) {
    medias = await Media.find({ _id: { $in: matchedMediaIds } })
      .select('source platformStats metadata.caption fileType')
      .lean();
  }

  // ── Brand signal ──
  // Brand colors + font intentionally OMITTED — letting the downstream
  // Generator pick a palette from the photo + tone produces better
  // composition than hard-binding the literal brand hex values, which
  // routinely created dark panels covering media and forced unreadable
  // contrast. Tone stays as a stylistic cue.
  const brandSignal = {
    name:            brand?.name || null,
    tone:            Array.isArray(brand?.tone) ? brand.tone.slice(0, 6) : []
  };

  // ── Product signal ──
  // Priority — explicit if campaignKind === 'product', medium for brand
  // campaigns (product is supporting), absent for productId-null cases.
  const productSignal = {
    name:     product?.title || null,
    category: product?.category || null,
    priority: !productId ? 'absent' :
              campaignKind === 'product' ? 'high' :
              campaignKind === 'brand'   ? 'medium' :
              'medium'
  };

  // ── UGC signal — aggregate across matched media ──
  const ugcMedias    = medias.filter(m => m.source === 'instagram' || m.source === 'tiktok');
  const ugcMediaCount= ugcMedias.length;
  const ugcPlatform  = ugcMedias.find(m => m.source)?.source || null;
  const mediaStrength= ugcMediaCount >= 3 ? 'high' :
                        ugcMediaCount >= 1 ? 'medium' :
                        'absent';
  const rightsApproved = ugcMedias.some(m => m.platformStats?.rights_approved) || null;

  const ugcSignal = {
    platform:        ugcPlatform,
    media_strength:  mediaStrength,
    rights_approved: rightsApproved
  };

  // ── Social proof signal ──
  const hasRating         = typeof product?.rating === 'number' && product.rating > 0;
  const hasTopComments    = ugcMediaCount > 0;     // proxy — we don't have per-product top-comment count here
  const hasPrimaryQuote   = Array.isArray(product?.reviews) && product.reviews.some(r => typeof r.text === 'string' && r.text.length > 30);
  const strongestSignal   = hasPrimaryQuote ? 'testimonial' :
                             hasRating ? 'rating' :
                             hasTopComments ? 'creator' :
                             null;

  const socialProofSignal = {
    has_primary_quote: !!hasPrimaryQuote,
    has_top_comments:  !!hasTopComments,
    has_rating:        !!hasRating,
    strongest_signal:  strongestSignal
  };

  // ── Performance signal ──
  const totalLikes    = ugcMedias.reduce((s, m) => s + (m.platformStats?.likes    || 0), 0);
  const totalComments = ugcMedias.reduce((s, m) => s + (m.platformStats?.comments || 0), 0);
  const performanceStrength = totalLikes >= 5000 || totalComments >= 200 ? 'high' :
                              totalLikes >= 500  || totalComments >= 20  ? 'medium' :
                              totalLikes > 0     || totalComments > 0    ? 'low' :
                              'absent';

  const performanceSignal = {
    likes:    totalLikes    || null,
    comments: totalComments || null,
    strength: performanceStrength
  };

  return {
    brand_signal:        brandSignal,
    product_signal:      productSignal,
    ugc_signal:          ugcSignal,
    social_proof_signal: socialProofSignal,
    performance_signal:  performanceSignal
  };
}

// ── Prompt construction ──────────────────────────────────────────────

function buildPrompt({ inputSummary, creativeIntent }) {
  const system = [
    `You are a creative director planning social-media ad creative for a brand.`,
    ``,
    `Your job: pick ${N_CONCEPTS} distinct creative concepts that match the signals below. You make STRATEGY decisions — archetype, hierarchy, recommended components — NOT coordinates. A downstream Layout Generator materializes each concept into pixels.`,
    ``,
    `RULES:`,
    `- DO NOT generate coordinates, rects, or pixel positions.`,
    `- The ${N_CONCEPTS} concepts MUST be meaningfully different — different archetype OR different emotional_hook OR different social_proof_type. Avoid two concepts that read the same.`,
    `- Lead with the STRONGEST signal in the data. If social_proof_signal.strongest_signal is "testimonial" and performance is low, lean into the testimonial — don't pick a stat_led archetype.`,
    `- If a signal is "absent", do not build a concept around it.`,
    `- HONESTY RULE: if social_proof_signal.strongest_signal is null AND has_primary_quote=false AND has_top_comments=false AND has_rating=false, you MUST set social_proof_type="none" on EVERY concept. Do not promise proof the data can't back. In that case, also avoid the stat_led_social_proof and hero_quote_overlay archetypes — there is nothing to surface. Lean on brand voice (typographic_dominant, magazine_editorial) or the photo itself (full_bleed_hero_bottom_panel, vertical_split, diagonal_carve).`,
    ``,
    `AVAILABLE ARCHETYPES (pick one per concept):`,
    AVAILABLE_ARCHETYPES.map(a => `  ${a}`).join('\n'),
    ``,
    `AVAILABLE ROLES (used in recommended_components — map of role → component_style):`,
    ROLES.map(r => `  ${r}: [${(COMPONENT_STYLE_BY_ROLE[r] || []).join(', ')}]`).join('\n'),
    ``,
    `For each concept, recommend ONE component_style per role you want featured. You don't have to fill every role — only the ones the strategy calls for. Generator will fill the rest.`,
    ``,
    `Output JSON matching the schema. Per concept emit:`,
    `  concept_id          — short slug (e.g. "cd_quote_lead", "cd_brand_typo")`,
    `  name                — human-readable concept name`,
    `  archetype           — one of the available archetypes`,
    `  layout_family       — short alias (hero_quote, vertical_split, etc.)`,
    `  emotional_hook      — what the ad triggers (trust, authenticity, urgency, etc.)`,
    `  social_proof_type   — testimonial / stat / creator / review / rating / none`,
    `  *_priority          — high/medium/low/absent for product, ugc, comment, stat`,
    `  cta_emphasis        — primary/secondary/minimal/absent`,
    `  recommended_components — map of role → component_style`,
    `  rationale           — 1-2 sentences explaining why this concept matches the signals`
  ].join('\n');

  const user = [
    `INPUT SUMMARY (signals you're directing for):`,
    '```json',
    JSON.stringify(inputSummary, null, 2),
    '```',
    ``,
    creativeIntent ? `OPERATOR HINT: ${creativeIntent}` : `OPERATOR HINT: none — you decide.`,
    ``,
    `Emit ${N_CONCEPTS} distinct concepts. Make them genuinely different.`
  ].join('\n');

  return { system, user };
}

// ── Response schema (OpenAI strict) ──────────────────────────────────

function buildResponseSchema() {
  return {
    name: 'creative_director_concepts',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['concepts'],
      properties: {
        concepts: {
          type: 'array',
          minItems: N_CONCEPTS,
          maxItems: N_CONCEPTS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'concept_id', 'name', 'archetype', 'layout_family',
              'emotional_hook', 'social_proof_type',
              'product_priority', 'ugc_priority', 'comment_priority', 'stat_priority', 'cta_emphasis',
              'recommended_components', 'rationale'
            ],
            properties: {
              concept_id:        { type: 'string' },
              name:              { type: 'string' },
              archetype:         { type: 'string', enum: AVAILABLE_ARCHETYPES },
              layout_family:     { type: 'string' },
              emotional_hook:    { type: 'string' },
              social_proof_type: { type: 'string' },
              product_priority:  { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
              ugc_priority:      { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
              comment_priority:  { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
              stat_priority:     { type: 'string', enum: ['high', 'medium', 'low', 'absent'] },
              cta_emphasis:      { type: 'string', enum: ['primary', 'secondary', 'minimal', 'absent'] },
              // OpenAI strict mode doesn't allow open-ended objects with
              // additionalProperties:true. We constrain to the fixed
              // ROLE set, each value nullable so the Director can leave
              // most roles unrecommended.
              recommended_components: {
                type: 'object',
                additionalProperties: false,
                required: [...ROLES],
                properties: Object.fromEntries(
                  ROLES.map(r => [r, { type: ['string', 'null'] }])
                )
              },
              rationale: { type: 'string' }
            }
          }
        }
      }
    },
    strict: true
  };
}

// ── Validator ────────────────────────────────────────────────────────
// Soft-warning only — concept failures don't break the pipeline.

function validateConcepts(concepts) {
  const warnings = [];
  if (!Array.isArray(concepts) || !concepts.length) {
    warnings.push('no concepts emitted');
    return warnings;
  }

  // Distinctness: the N concepts should differ on at least one of
  // (archetype, emotional_hook, social_proof_type).
  if (concepts.length >= 2) {
    const fingerprints = concepts.map(c =>
      `${c.archetype}|${c.emotional_hook}|${c.social_proof_type}`
    );
    if (new Set(fingerprints).size < concepts.length) {
      warnings.push(`concepts are not distinct — fingerprints: ${fingerprints.join(' / ')}`);
    }
  }

  // Validate recommended component styles against the vocabulary.
  for (const c of concepts) {
    if (!c?.recommended_components) continue;
    for (const [role, style] of Object.entries(c.recommended_components)) {
      if (style == null) continue;
      const allowed = COMPONENT_STYLE_BY_ROLE[role];
      if (!allowed) {
        warnings.push(`concept ${c.concept_id}: unknown role "${role}" in recommended_components`);
      } else if (!allowed.includes(style)) {
        warnings.push(`concept ${c.concept_id}: role "${role}" picked unknown component_style "${style}" (allowed: ${allowed.join(', ')})`);
      }
    }
  }

  return warnings;
}

// ── Helpers ──────────────────────────────────────────────────────────

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

module.exports = {
  directConcepts,
  assembleSignals,
  AVAILABLE_ARCHETYPES,
  CREATIVE_RULES,
  MODEL_ID
};
