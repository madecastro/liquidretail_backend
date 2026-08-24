// Phase 4 — style-aware copy derivation.
//
// Produces 3-5 candidate strings per slot (headline / subheadline /
// eyebrow / cta_micro_copy) for a given (brandId, productId, creativeStyle),
// cached in CopyCandidatesArtifact. The Generator's existing copy_picks
// mechanism (1d-c) picks an index from each array — finally with real
// signal because the arrays now contain N candidates instead of one.
//
// Cost design:
//   - Model: gpt-4.1-mini (~$0.40/$1.60 per M tokens). Short generation;
//     the brand + product context fits in <1K input tokens. Per call cost
//     ~$0.005. (Lever 2 — small model for small work.)
//   - Cached per (brand × product × style). Five styles × N products
//     = limited per-campaign cost regardless of cartesian ad count.
//     (Lever 1 — caching at the right axis.)

const crypto = require('crypto');

const Brand                   = require('../models/Brand');
const CatalogProduct          = require('../models/CatalogProduct');
const CopyCandidatesArtifact  = require('../models/CopyCandidatesArtifact');
const { recordCacheHit } = require('./costTracker');
const { chatCompletion } = require('./atlasLlmService');

const DEFAULT_MODEL = process.env.COPY_DERIVATION_MODEL || 'gpt-4.1-mini';
const TEMPERATURE   = 0.85;     // need real per-slot variety
const MAX_TOKENS    = 1200;
const PER_SLOT_MIN  = 3;
const PER_SLOT_MAX  = 5;

// Per-style voice + length guidance. Drives the system prompt; same
// brand + product produces different copy across these.
const STYLE_GUIDANCE = Object.freeze({
  brand_led: {
    voice:    'Short. Punchy. Brand-voice — leans on the brand\'s tone words (tone[]). Ownable phrases. Avoid generic adjectives.',
    headline_words:    [4, 6],
    subheadline_words: [4, 7],
    eyebrow_words:     [2, 4]
  },
  ugc_led: {
    voice:    'Casual. Creator-voice. Reads like a real person\'s caption. Slight informality OK; no marketing-speak. Use first-person or imperative ("I tried this," "Tap to shop"). Avoid hashtags.',
    headline_words:    [5, 9],
    subheadline_words: [6, 12],
    eyebrow_words:     [2, 5]
  },
  social_proof_led: {
    voice:    'Quote-driven. Anchored in third-party validation — testimonial voice or social-stat voice. Headlines often paraphrase the strongest review or numeric proof.',
    headline_words:    [6, 12],
    subheadline_words: [6, 12],
    eyebrow_words:     [2, 4]
  },
  editorial: {
    voice:    'Long-form editorial / magazine display. Considered phrasing. Allows compound clauses. Restrained vocabulary; one specific verb beats two adjectives.',
    headline_words:    [7, 14],
    subheadline_words: [10, 18],
    eyebrow_words:     [3, 6]
  },
  promotional: {
    voice:    'Action-oriented. Urgency + offer-led. Verbs first. Numbers visible. Avoid soft language.',
    headline_words:    [4, 7],
    subheadline_words: [4, 8],
    eyebrow_words:     [2, 4]
  }
});

// ── Public API ───────────────────────────────────────────────────────

async function deriveCopy({
  brandId,
  productId       = null,
  creativeStyle,
  refresh         = false
}) {
  if (!brandId)        throw badRequest('brandId required');
  if (!creativeStyle)  throw badRequest('creativeStyle required');
  if (!STYLE_GUIDANCE[creativeStyle]) {
    throw badRequest(`unknown creativeStyle: ${creativeStyle}. Known: ${Object.keys(STYLE_GUIDANCE).join(', ')}`);
  }
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY not set'); e.status = 500; throw e;
  }

  const filter = {
    brandId,
    productId: productId || null,
    creativeStyle
  };
  const cacheKey = JSON.stringify({
    brandId: String(brandId),
    productId: productId ? String(productId) : null,
    creativeStyle
  });

  if (!refresh) {
    const cached = await CopyCandidatesArtifact.findOne(filter).lean();
    if (cached) {
      recordCacheHit({
        stage:    'copy_derivation',
        provider: 'openai',
        model:    DEFAULT_MODEL,
        brandId, productId,
        cacheKey
      }).catch(() => {});
      return { artifact: cached, cached: true };
    }
  }

  const [brand, product] = await Promise.all([
    Brand.findById(brandId).lean(),
    productId ? CatalogProduct.findById(productId).lean() : null
  ]);

  const { system, user } = buildPrompt({ brand, product, creativeStyle });
  const promptHash = sha256(system + '\n' + user);
  const responseSchema = buildResponseSchema();

  const t0 = Date.now();
  // Atlas gateway (direct-OpenAI fallback inside) — chatCompletion owns
  // the trackLlmCall wrap; ledger fields pass through in meta.
  const completion = await chatCompletion(
    {
      stage:      'copy_derivation',
      service:    'copyDerivationService',
      purposeTag: creativeStyle,
      brandId, productId,
      visionImages: 0,
      cacheKey
    },
    {
      model:           DEFAULT_MODEL,
      response_format: { type: 'json_schema', json_schema: responseSchema },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: TEMPERATURE,
      max_tokens:  MAX_TOKENS
    }
  );
  const durationMs = Date.now() - t0;

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('copy derivation returned no content');

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`copy derivation response not JSON: ${err.message}`); }

  const candidates = normalize(parsed);

  console.log(
    `✏️  copyDerivation[${creativeStyle}]: brand=${brandId} product=${productId || '-'} ` +
    `hd=${candidates.headlines.length} sh=${candidates.subheadlines.length} ` +
    `eb=${candidates.eyebrows.length} cta=${candidates.cta_micro_copy.length} took=${durationMs}ms`
  );

  const usage = completion.usage || {};
  const artifact = await CopyCandidatesArtifact.findOneAndReplace(
    filter,
    {
      ...filter,
      contractVersion: '1.0',
      candidates,
      provider:    'openai',
      modelId:     DEFAULT_MODEL,
      promptHash,
      promptSystem: system,
      promptUser:   user,
      rawResponse:  raw,
      inputTokens:  usage.prompt_tokens     || 0,
      outputTokens: usage.completion_tokens || 0,
      durationMs,
      createdAt:    new Date()
    },
    { upsert: true, new: true, includeResultMetadata: false }
  );

  return { artifact: artifact.toObject ? artifact.toObject() : artifact, cached: false };
}

// Fetch-if-cached helper — used by the lazy lookup path in
// aiCanvasInputBuilder so the Generator can read the candidates
// without triggering a derive when the eager wizard pass missed it.
async function loadCached({ brandId, productId, creativeStyle }) {
  if (!brandId || !creativeStyle) return null;
  const filter = { brandId, productId: productId || null, creativeStyle };
  return CopyCandidatesArtifact.findOne(filter).lean();
}

// ── Prompt construction ──────────────────────────────────────────────

function buildPrompt({ brand, product, creativeStyle }) {
  const g = STYLE_GUIDANCE[creativeStyle];

  const brandTone = Array.isArray(brand?.tone) ? brand.tone.slice(0, 6).join(', ') : '';
  const brandSummary = {
    name:    brand?.name || null,
    tagline: brand?.tagline || null,
    tone:    brandTone || null,
    category_hint: brand?.summary?.slice?.(0, 200) || null
  };
  const productSummary = product ? {
    name:           product.title || null,
    category:       product.category || null,
    description:    typeof product.description === 'string'
      ? product.description.slice(0, 400)
      : null,
    short_benefits: Array.isArray(product.shortBenefits) ? product.shortBenefits.slice(0, 5) : [],
    price:          product.price?.display || product.price?.value || null,
    rating:         typeof product.rating === 'number' ? product.rating : null
  } : null;

  const system = [
    `You are a copywriter producing AD COPY CANDIDATES that a downstream layout system will pick from.`,
    ``,
    `STYLE: ${creativeStyle}`,
    `Voice: ${g.voice}`,
    ``,
    `OUTPUT REQUIREMENTS:`,
    `- Emit ${PER_SLOT_MIN}-${PER_SLOT_MAX} candidates per slot (headlines, subheadlines, eyebrows, cta_micro_copy).`,
    `- Candidates MUST be distinct — different angles, hooks, or phrasings. No paraphrases of the same line.`,
    `- Word counts (loose targets, not hard caps):`,
    `    headline:     ${g.headline_words[0]}-${g.headline_words[1]} words`,
    `    subheadline:  ${g.subheadline_words[0]}-${g.subheadline_words[1]} words`,
    `    eyebrow:      ${g.eyebrow_words[0]}-${g.eyebrow_words[1]} words`,
    `    cta_micro_copy: 1-4 words (button text — "Shop Now", "Try It", etc.)`,
    `- NO emoji. NO hashtags. NO trailing punctuation except periods.`,
    `- Brand-safe: align with the brand's tone words listed in the input.`,
    `- Plain text strings (no markdown, no quotes around values).`
  ].join('\n');

  const userLines = [
    `BRAND:`,
    '```json',
    JSON.stringify(brandSummary, null, 2),
    '```',
    ``
  ];
  if (productSummary) {
    userLines.push(`PRODUCT:`);
    userLines.push('```json');
    userLines.push(JSON.stringify(productSummary, null, 2));
    userLines.push('```');
    userLines.push('');
  }
  userLines.push(`Emit the candidates now. Make each one earn its slot — no filler.`);

  return { system, user: userLines.join('\n') };
}

// ── Response schema ──────────────────────────────────────────────────

function buildResponseSchema() {
  const slotProps = {
    type: 'array',
    minItems: PER_SLOT_MIN,
    maxItems: PER_SLOT_MAX,
    items: { type: 'string' }
  };
  return {
    name: 'copy_candidates',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['headlines', 'subheadlines', 'eyebrows', 'cta_micro_copy'],
      properties: {
        headlines:      slotProps,
        subheadlines:   slotProps,
        eyebrows:       slotProps,
        cta_micro_copy: {
          type: 'array', minItems: PER_SLOT_MIN, maxItems: PER_SLOT_MAX, items: { type: 'string' }
        }
      }
    },
    strict: true
  };
}

function normalize(parsed) {
  const cleanStr = (s) => typeof s === 'string' ? s.trim() : '';
  const cleanArr = (arr) => Array.isArray(arr)
    ? Array.from(new Set(arr.map(cleanStr).filter(Boolean))).slice(0, PER_SLOT_MAX)
    : [];
  return {
    headlines:      cleanArr(parsed.headlines),
    subheadlines:   cleanArr(parsed.subheadlines),
    eyebrows:       cleanArr(parsed.eyebrows),
    cta_micro_copy: cleanArr(parsed.cta_micro_copy)
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

module.exports = {
  deriveCopy,
  loadCached,
  STYLE_GUIDANCE,
  DEFAULT_MODEL
};
