// AI canvas spec generator. Takes a canonical layoutInput payload
// (assembled by layoutInputService) plus (template, aspectRatio,
// creativeStyle) and returns a validated canvas spec the renderer
// can consume verbatim.
//
// Phase 1a scope:
//   templates:     ai_brand_led (more styles next)
//   ratios:        1:1 (more ratios next)
//   media kind:    image only (video next)
//   single creative; no carousels; no external_text_assets
//
// Output shape mirrors per-ratio variant entries in
// rsSocialProof.canvas.v1.json:
//
//   {
//     creative_style:   'brand_led' | ...,
//     rationale:        '...',
//     elements_used:    [...],
//     elements_skipped: [...],
//     aspect_ratio:     '1:1',
//     canvas:           { width: 1000, height: 1000, background: { style: ... } },
//     safe_areas:       { outer, text_primary, ..., logo_safe, no_obstruction },
//     zones:            [ { id, kind, slot, rect, layer, style_variant?, max_lines?, fit? } ],
//     zone_scalers:     {},
//     style_bindings:   {}
//   }
//
// Caching: AiCanvasArtifact, keyed on the same cartesian dimensions
// as LayoutInputArtifact plus creativeStyle. Caller passes refresh=true
// to bypass.

const crypto = require('crypto');
const OpenAI = require('openai');

const AiCanvasArtifact = require('../models/AiCanvasArtifact');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID = 'gpt-4.1';
const SPEC_SCHEMA_VERSION = '1.1.0';   // bumped when the response_format schema changed shape for strict mode

// Creative style menu. Each entry is a short guidance block injected
// into the prompt. Add styles here as they come online.
const CREATIVE_STYLES = {
  brand_led: {
    intent:
      "Brand visual identity is the hero. Brand colors dominate the panel. " +
      "Logo is prominent. A short, punchy headline carries the brand voice. " +
      "Product appears in a supporting position (small product card or inset). " +
      "Hero media (lifestyle / on-model shot) covers most of the frame.",
    typical_zones:    ['logo', 'headline', 'eyebrow_rules', 'support_media', 'panel', 'product_card', 'cta'],
    de_emphasized:    ['quote_card', 'proof_bar', 'badge_row']
  }
  // Phase 1b adds: product_led, social_proof_led, editorial, ugc_led, promotional.
};

// Allowed zone kinds the renderer knows how to draw.
const ALLOWED_ZONE_KINDS = [
  'media', 'panel', 'text', 'cta', 'logo', 'product_card',
  'quote_card', 'proof_bar', 'badge_row', 'eyebrow_rules'
];

// Allowed slot paths the renderer's slot_adapter can resolve. Match
// the canonical-input schema keys at layoutInputService output.
const ALLOWED_SLOTS = [
  'brand.logo', 'brand.name', 'brand.tagline',
  'copy.headline', 'copy.subheadline', 'copy.eyebrow', 'copy.cta_text',
  'cta.text', 'cta.url', 'cta',
  'product.name', 'product.price', 'product.image',
  'product.hero_media', 'product.lifestyle_image', 'product.product_image',
  'product.badges',
  'social_proof.primary_quote', 'social_proof.primary_quote.text',
  'social_proof.primary_quote.author_name',
  'social_proof.rating_value', 'social_proof.review_count',
  'trust.trusted_by_text'
];

// JSON Schema we hand OpenAI via response_format. Constrains zone
// kinds + slot paths + rect bounds so the model can't invent
// arbitrary zone types the renderer wouldn't know what to do with.
function buildResponseSchema(aspectRatio) {
  // OpenAI strict mode requires every property declared in `properties`
  // to ALSO appear in `required`. Optional fields are modeled as
  // nullable (type: [..., 'null']) and the model emits null when not
  // applicable. additionalProperties must be false at every level.
  // additionalProperties: { ... } syntax is NOT allowed in strict —
  // safe_areas + style_bindings + zone_scalers therefore use fixed
  // property maps with nullable rect/string values instead of an
  // open additionalProperties shape.
  const SAFE_AREA_NAMES = ['outer', 'text_primary', 'text_secondary', 'cta_safe', 'logo_safe', 'no_obstruction'];
  const STYLE_BINDING_NAMES = [
    'card_bg', 'card_text_color', 'panel_bg',
    'headline_text_color', 'accent_border_color',
    'cta_button_bg', 'cta_text_color',
    'font_family_body', 'font_family_display'
  ];
  const ZONE_SCALER_NAMES = ['headline', 'eyebrow_rules', 'proof_bar', 'product_meta', 'quote_card'];

  const safeAreaProps = Object.fromEntries(SAFE_AREA_NAMES.map(n => [n, { anyOf: [{ $ref: '#/$defs/rect' }, { type: 'null' }] }]));
  const styleBindingProps = Object.fromEntries(STYLE_BINDING_NAMES.map(n => [n, { type: ['string', 'null'] }]));
  const zoneScalerProps = Object.fromEntries(ZONE_SCALER_NAMES.map(n => [n, {
    type: ['object', 'null'],
    additionalProperties: false,
    required: ['font'],
    properties: { font: { type: ['number', 'null'] } }
  }]));

  return {
    name: 'ai_canvas_spec',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'creative_style', 'rationale', 'elements_used', 'elements_skipped',
        'aspect_ratio', 'canvas', 'safe_areas', 'zones', 'zone_scalers', 'style_bindings'
      ],
      properties: {
        creative_style:   { type: 'string', enum: Object.keys(CREATIVE_STYLES) },
        rationale:        { type: 'string' },
        elements_used:    { type: 'array', items: { type: 'string' } },
        elements_skipped: { type: 'array', items: { type: 'string' } },
        aspect_ratio:     { type: 'string', enum: [aspectRatio] },
        canvas: {
          type: 'object',
          additionalProperties: false,
          required: ['width', 'height', 'background'],
          properties: {
            width:  { type: 'integer' },
            height: { type: 'integer' },
            background: {
              type: 'object',
              additionalProperties: false,
              required: ['style'],
              properties: {
                style: { type: 'string', enum: ['split_panel', 'solid', 'gradient', 'brand_fill'] }
              }
            }
          }
        },
        safe_areas: {
          type: 'object',
          additionalProperties: false,
          required: SAFE_AREA_NAMES,
          properties: safeAreaProps
        },
        zones: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'kind', 'slot', 'rect', 'layer', 'style_variant', 'max_lines', 'fit', 'radius'],
            properties: {
              id:        { type: 'string' },
              kind:      { type: 'string', enum: ALLOWED_ZONE_KINDS },
              slot: {
                anyOf: [
                  { type: 'string', enum: ALLOWED_SLOTS },
                  { type: 'array', items: { type: 'string', enum: ALLOWED_SLOTS } },
                  { type: 'null' }
                ]
              },
              rect:      { $ref: '#/$defs/rect' },
              layer:     { type: 'string', enum: ['media', 'background', 'copy', 'proof', 'cta', 'chrome'] },
              style_variant: { type: ['string', 'null'] },
              max_lines: { type: ['integer', 'null'], minimum: 1 },
              fit:       { anyOf: [
                { type: 'string', enum: ['subject_preserve', 'cover', 'contain'] },
                { type: 'null' }
              ] },
              radius:    { type: ['integer', 'null'], minimum: 0 }
            }
          }
        },
        zone_scalers: {
          type: 'object',
          additionalProperties: false,
          required: ZONE_SCALER_NAMES,
          properties: zoneScalerProps
        },
        style_bindings: {
          type: 'object',
          additionalProperties: false,
          required: STYLE_BINDING_NAMES,
          properties: styleBindingProps
        }
      },
      $defs: {
        rect: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'w', 'h'],
          properties: {
            x: { type: 'integer', minimum: 0, maximum: 1000 },
            y: { type: 'integer', minimum: 0, maximum: 1000 },
            w: { type: 'integer', minimum: 1, maximum: 1000 },
            h: { type: 'integer', minimum: 1, maximum: 1000 }
          }
        }
      }
    },
    strict: true
  };
}

// ── Prompt construction ─────────────────────────────────────────────
function buildPrompt({ input, template, aspectRatio, creativeStyle }) {
  const styleSpec = CREATIVE_STYLES[creativeStyle];
  if (!styleSpec) throw new Error(`Unknown creativeStyle: ${creativeStyle}`);

  const { width, height } = parseRatio(aspectRatio);

  const system = [
    `You are a senior ad designer. You output a JSON canvas spec the deterministic renderer draws. You do not write pixels.`,
    ``,
    `Coordinate system: normalized 0–1000 along BOTH axes. Width=${width}, Height=${height}. All rect.x + rect.w must stay <= width and rect.y + rect.h <= height.`,
    `Every zone gets a rect, a kind, a layer, and (when it carries content) a slot path the renderer resolves against the input data.`,
    ``,
    `Required zones (must appear): logo, cta, and AT LEAST one copy zone (headline OR product_card OR quote_card).`,
    `Optional zones (pick if they serve the creative direction): support_media, panel, eyebrow_rules, proof_bar, quote_card, product_card, badge_row.`,
    ``,
    `Slot paths must come from the allowed set. If a slot expects an array (e.g. product_card), pass an array of paths in slot.`,
    ``,
    `style_bindings names: card_bg, card_text_color, headline_text_color, accent_border_color, panel_bg, cta_button_bg, font_family_body, font_family_display. Map to data-driven values like "brand.primary_color", "brand.accent_color", "media.palette_dominant", or a literal hex "#RRGGBB". Leave unset to use renderer defaults.`,
    ``,
    `Return creative_style + rationale + elements_used + elements_skipped so the validator can verify your picks are coherent.`
  ].join('\n');

  const user = [
    `CREATIVE STYLE: ${creativeStyle}`,
    `INTENT: ${styleSpec.intent}`,
    `Typical zones for this style: ${styleSpec.typical_zones.join(', ')}.`,
    `De-emphasized zones: ${styleSpec.de_emphasized.join(', ')}.`,
    ``,
    `TARGET CANVAS:`,
    `  aspect_ratio: ${aspectRatio}`,
    `  width:  ${width}`,
    `  height: ${height}`,
    ``,
    `BRAND:`,
    `  name:      ${JSON.stringify(input.brand?.name || null)}`,
    `  tagline:   ${JSON.stringify(input.brand?.tagline || null)}`,
    `  logo:      ${input.brand?.logo ? 'present' : 'none'}`,
    `  colors:    primary=${input.brand?.primary_color || '?'}, secondary=${input.brand?.secondary_color || '?'}, accent=${input.brand?.accent_color || '?'}`,
    `  tone:      ${JSON.stringify(input.brand?.tone || null)}`,
    ``,
    `PRODUCT:`,
    `  name:      ${JSON.stringify(input.product?.name || null)}`,
    `  price:     ${input.product?.price ?? 'n/a'} ${input.product?.currency || ''}`,
    `  hero image: ${input.product?.hero_media?.image ? 'present' : (input.product?.image ? 'present (catalog)' : 'none')}`,
    `  badges:    ${JSON.stringify(input.product?.badges || [])}`,
    `  category:  ${JSON.stringify(input.product?.category || null)}`,
    ``,
    `COPY (LLM-derived):`,
    `  headline:    ${JSON.stringify(input.copy?.headline || null)}`,
    `  subheadline: ${JSON.stringify(input.copy?.subheadline || null)}`,
    `  eyebrow:     ${JSON.stringify(input.copy?.eyebrow || null)}`,
    `  cta_text:    ${JSON.stringify(input.cta?.text || input.copy?.cta_text || 'Shop now')}`,
    ``,
    `SOCIAL PROOF:`,
    `  primary_quote: ${JSON.stringify(input.social_proof?.primary_quote?.text || null)}`,
    `  rating:        ${input.social_proof?.rating_value ?? 'n/a'}`,
    `  reviews:       ${input.social_proof?.review_count ?? 'n/a'}`,
    ``,
    `SOURCE MEDIA (background scene context):`,
    `  setting:    ${input.media?.background?.setting || 'n/a'}`,
    `  scene_type: ${input.media?.background?.sceneType || 'n/a'}`,
    `  palette:    ${JSON.stringify(input.media?.background?.palette || [])}`,
    `  mood:       ${JSON.stringify(input.media?.background?.mood || [])}`,
    `  primary_subject: ${JSON.stringify(input.primarySubjectLabel || null)}`,
    ``,
    `Emit the canvas spec now. Skip elements that don't serve the chosen creative_style — record those in elements_skipped with brief reasons in rationale.`
  ].join('\n');

  return { system, user };
}

function parseRatio(ar) {
  // Phase 1a: 1:1 only; future ratios add to this map.
  const map = {
    '1:1':    { width: 1000, height: 1000 },
    '4:5':    { width: 1000, height: 1250 },
    '9:16':   { width: 1000, height: 1778 },
    '16:9':   { width: 1000, height: 563 },
    '1.91:1': { width: 1000, height: 524 }
  };
  return map[ar] || { width: 1000, height: 1000 };
}

// ── Validator ───────────────────────────────────────────────────────
// Hard failures throw (the spec is unusable). Soft warnings are
// collected in `warnings` and stored on the artifact so we can see
// what the LLM tends to get wrong without blocking the render.
function validateSpec(spec, aspectRatio) {
  const warnings = [];
  const { width, height } = parseRatio(aspectRatio);

  if (!spec || typeof spec !== 'object') throw new Error('spec is not an object');
  if (!Array.isArray(spec.zones)) throw new Error('spec.zones missing');
  if (spec.aspect_ratio !== aspectRatio) {
    throw new Error(`aspect_ratio mismatch: got ${spec.aspect_ratio}, want ${aspectRatio}`);
  }
  if (!spec.canvas || spec.canvas.width !== width || spec.canvas.height !== height) {
    warnings.push(`canvas dims drifted: spec=${spec.canvas?.width}x${spec.canvas?.height}, want=${width}x${height}`);
  }

  // Required zones.
  const ids = new Set();
  let hasCopyZone = false;
  for (const z of spec.zones) {
    if (!z.id || !z.kind || !z.rect) throw new Error(`zone missing required fields: ${JSON.stringify(z)}`);
    if (ids.has(z.id)) warnings.push(`duplicate zone id: ${z.id}`);
    ids.add(z.id);
    if (!ALLOWED_ZONE_KINDS.includes(z.kind)) throw new Error(`unknown zone kind: ${z.kind}`);

    // Slot whitelist.
    if (z.slot) {
      const slots = Array.isArray(z.slot) ? z.slot : [z.slot];
      for (const s of slots) {
        if (!ALLOWED_SLOTS.includes(s)) warnings.push(`zone ${z.id}: unknown slot path "${s}"`);
      }
    }

    // Bounds.
    const { x, y, w, h } = z.rect;
    if (x < 0 || y < 0 || x + w > width || y + h > height) {
      warnings.push(`zone ${z.id}: rect ${x},${y},${w}x${h} extends beyond canvas ${width}x${height}`);
    }

    if (['headline', 'product_card', 'quote_card'].includes(z.kind) || z.id === 'headline') {
      hasCopyZone = true;
    }
  }
  if (!ids.has('logo')) throw new Error('required zone missing: logo');
  if (!ids.has('cta'))  throw new Error('required zone missing: cta');
  if (!hasCopyZone)     throw new Error('required: at least one of headline / product_card / quote_card');

  // elements_used should match the actual zone id set.
  const declared = new Set(spec.elements_used || []);
  for (const id of ids) {
    if (!declared.has(id)) warnings.push(`elements_used missing actual zone id: ${id}`);
  }
  for (const id of declared) {
    if (!ids.has(id)) warnings.push(`elements_used names a zone not in spec.zones: ${id}`);
  }

  return warnings;
}

// ── Public API ──────────────────────────────────────────────────────
async function getOrGenerate({
  input,
  template,
  aspectRatio,
  creativeStyle,
  mediaId,
  productId        = null,
  variantKind      = null,
  campaignContextHash = null,
  paletteSource    = 'media',
  advertiserId     = null,
  brandId          = null,
  refresh          = false
}) {
  if (!input)         throw new Error('input required');
  if (!template)      throw new Error('template required');
  if (!aspectRatio)   throw new Error('aspectRatio required');
  if (!creativeStyle) throw new Error('creativeStyle required');
  if (!mediaId)       throw new Error('mediaId required');
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY not set'); e.status = 500; throw e;
  }

  const filter = {
    mediaId, template, aspectRatio, productId, variantKind,
    campaignContextHash, paletteSource, creativeStyle
  };

  if (!refresh) {
    const cached = await AiCanvasArtifact.findOne(filter).lean();
    if (cached && cached.specSchemaVersion === SPEC_SCHEMA_VERSION) {
      return { spec: cached.canvasSpec, cached: true, artifactId: String(cached._id), warnings: cached.validationWarnings || [] };
    }
  }

  const { system, user } = buildPrompt({ input, template, aspectRatio, creativeStyle });
  const responseSchema = buildResponseSchema(aspectRatio);
  const promptHash = crypto.createHash('sha256').update(system + '\n' + user).digest('hex');

  const t0 = Date.now();
  const completion = await openai.chat.completions.create({
    model: MODEL_ID,
    response_format: { type: 'json_schema', json_schema: responseSchema },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user }
    ],
    temperature: 0.3,
    max_tokens: 4000
  });
  const elapsedMs = Date.now() - t0;

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned no content');
  let spec;
  try { spec = JSON.parse(raw); }
  catch (err) { throw new Error(`OpenAI response not JSON: ${err.message}`); }

  const warnings = validateSpec(spec, aspectRatio);

  console.log(
    `🎨 aiCanvasSpec[${template}/${aspectRatio}/${creativeStyle}]: ` +
    `media=${mediaId} product=${productId || '-'} variant=${variantKind || '-'} ` +
    `took=${elapsedMs}ms warnings=${warnings.length}`
  );

  // Persist. Replace any prior entry under the same key (refresh=true
  // path or schema-version mismatch from the cache check above).
  const artifact = await AiCanvasArtifact.findOneAndReplace(
    filter,
    {
      ...filter,
      advertiserId,
      brandId,
      canvasSpec:        spec,
      validationWarnings: warnings,
      modelId:           MODEL_ID,
      promptHash,
      rawResponse:       raw,
      rationale:         spec.rationale || null,
      elementsUsed:      spec.elements_used  || [],
      elementsSkipped:   spec.elements_skipped || [],
      specSchemaVersion: SPEC_SCHEMA_VERSION,
      createdAt:         new Date()
    },
    { upsert: true, new: true, includeResultMetadata: false }
  );

  return { spec, cached: false, artifactId: String(artifact._id), warnings };
}

module.exports = {
  getOrGenerate,
  CREATIVE_STYLES,
  ALLOWED_ZONE_KINDS,
  ALLOWED_SLOTS,
  SPEC_SCHEMA_VERSION,
  // exposed for testing
  buildPrompt,
  validateSpec
};
