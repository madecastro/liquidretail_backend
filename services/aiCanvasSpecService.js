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
const { buildAiCanvasContext } = require('./aiCanvasInputBuilder');
const { loadContext } = require('./layoutInputService');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID = 'gpt-4.1';
const SPEC_SCHEMA_VERSION = '2.1.0';   // 2.1: optional clipPolygon per zone (renderer applies CSS clip-path)

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
  // Binding names the renderer maps to CSS custom properties. Each
  // binding becomes --tp-style-<kebab-name> at render time. Names
  // here must match the CSS the renderer reads (see ads.html *.tp-zone
  // rules + the var() fallbacks). Adding a new binding here lets the
  // LLM set it; the rendering side already reads it.
  const STYLE_BINDING_NAMES = [
    'card_bg', 'card_text_color', 'panel_bg', 'panel_text_color',
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
        'aspect_ratio', 'canvas', 'safe_areas', 'zones', 'zone_scalers', 'style_bindings',
        'copy_picks'
      ],
      properties: {
        creative_style:   { type: 'string', enum: Object.keys(CREATIVE_STYLES) },
        rationale:        { type: 'string' },
        elements_used:    { type: 'array', items: { type: 'string' } },
        elements_skipped: { type: 'array', items: { type: 'string' } },
        aspect_ratio:     { type: 'string', enum: [aspectRatio] },
        // Picks reference indices into the corresponding
        // copy_candidates arrays from the input. null means "skip
        // this copy zone." Backend resolves picks → strings before
        // returning to the renderer so the slot path stays uniform.
        copy_picks: {
          type: 'object',
          additionalProperties: false,
          required: ['headline_pick', 'subheadline_pick', 'eyebrow_pick'],
          properties: {
            headline_pick:    { type: ['integer', 'null'], minimum: 0 },
            subheadline_pick: { type: ['integer', 'null'], minimum: 0 },
            eyebrow_pick:     { type: ['integer', 'null'], minimum: 0 }
          }
        },
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
            required: ['id', 'kind', 'slot', 'rect', 'layer', 'style_variant', 'max_lines', 'fit', 'radius', 'clipPolygon'],
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
              radius:    { type: ['integer', 'null'], minimum: 0 },
              // Optional clip path applied AFTER the zone is positioned.
              // Points are in canvas coords (0-1000); renderer converts
              // to zone-relative percentages for CSS clip-path. Use for
              // carving media zones around copy regions, creating
              // angled panels, or non-rectangular shapes. null = no
              // clip (renderer falls back to the rect's natural box).
              clipPolygon: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'array',
                    minItems: 3,
                    maxItems: 16,
                    items: { $ref: '#/$defs/point' }
                  }
                ]
              }
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
        },
        point: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: {
            x: { type: 'integer', minimum: 0, maximum: 1000 },
            y: { type: 'integer', minimum: 0, maximum: 1000 }
          }
        }
      }
    },
    strict: true
  };
}

// ── Prompt construction ─────────────────────────────────────────────
function buildPrompt({ input, template, aspectRatio, creativeStyle, richContext }) {
  const styleSpec = CREATIVE_STYLES[creativeStyle];
  if (!styleSpec) throw new Error(`Unknown creativeStyle: ${creativeStyle}`);

  const { width, height } = parseRatio(aspectRatio);

  // Rich context — the structured payload from aiCanvasInputBuilder.
  // Fall back to a minimal text-only block when richContext isn't
  // present so the unit tests (and any legacy callers) still work.
  const ctx = richContext?.text || null;
  const images = richContext?.images || [];

  const system = [
    `You are a senior ad designer. You output a JSON canvas spec the deterministic renderer draws. You do not write pixels.`,
    ``,
    `Coordinate system: normalized 0–1000 along BOTH axes. Width=${width}, Height=${height}. All rect.x + rect.w must stay <= width and rect.y + rect.h <= height.`,
    `Every zone gets a rect, a kind, a layer, and (when it carries content) a slot path the renderer resolves against the input data.`,
    ``,
    `ZONE PALETTE (pick what serves the creative — none are mandatory): logo, cta, headline, support_media, panel, eyebrow_rules, proof_bar, quote_card, product_card, badge_row, text.`,
    `Compose freely — an editorial frame can skip the logo, a pure hero-quote can skip the product_card, a typographic ad can skip support_media. Choose the zone set that makes the strongest creative for this brand + product + media.`,
    ``,
    `Slot paths must come from the allowed set. If a slot expects an array (e.g. product_card), pass an array of paths in slot.`,
    ``,
    `REQUIRED style_variant values (the renderer falls back to a placeholder if these are missing or wrong — DO NOT omit):`,
    `  headline      → "display_script"        (script editorial display)`,
    `  product_card  → "with_thumbnail"        (image + name + price)`,
    `  quote_card    → "with_thumbnail"        (quote + author + photo)`,
    `  proof_bar     → "with_verified_buyers"  (rating + verified buyers chip)`,
    `  eyebrow_rules, badge_row, logo, cta, panel, support_media, text → leave style_variant null`,
    ``,
    `SLOT SHAPES — pass the exact path(s) the renderer expects:`,
    `  logo          → "brand.logo"`,
    `  headline      → "copy.headline"`,
    `  eyebrow_rules → ["copy.subheadline", "brand.tagline"]   (array)`,
    `  proof_bar     → ["social_proof.rating_value", "social_proof.review_count"]   (array)`,
    `  product_card  → ["product.image", "product.name", "product.price"]   (array, exactly this order)`,
    `  quote_card    → "social_proof.primary_quote"`,
    `  support_media → "product.hero_media"`,
    `  cta           → "cta"`,
    `  panel         → null`,
    ``,
    `STYLE BINDINGS — surfaces use brand color PATHS; text colors on top of those surfaces must be EXPLICIT HEX values so the rendered text is readable. The renderer has NO contrast guard for AI templates, so null means "fall through to CSS default" which may not contrast with whatever surface the text sits on.`,
    ``,
    `CRITICAL: text zones do NOT get their own background. The headline text sits directly on whatever surface its rect overlaps with — typically panel_bg, or the support_media image if it overlaps that zone. Do not create panel zones with kind='panel' behind a headline as a "scrim." If you want a darker reading surface for text, use kind='panel' explicitly in the spec with its own slot=null and rect, and pick the panel's background via the canvas.background.style + panel_bg. Then position the headline rect inside that panel.`,
    ``,
    `For brand-led direction (panel_bg is brand.primary_color — typically a saturated brand color, usually dark or mid-tone):`,
    `  panel_bg            → "brand.primary_color"     (dominant brand surface — the colored panel)`,
    `  panel_text_color    → "#FFFFFF"                 (eyebrow + panel-level text on brand panel)`,
    `  headline_text_color → "#FFFFFF"                 (display headline on brand panel)`,
    `  card_bg             → "#FFFFFF"                 (product/quote cards as clean WHITE cards floating on the brand panel — best brand-led look)`,
    `  card_text_color     → "#0A0A0A"                 (card text on white card)`,
    `  cta_button_bg       → "brand.accent_color"      (CTA pops against the panel)`,
    `  cta_text_color      → "#FFFFFF"                 (text on accent-colored CTA)`,
    `  accent_border_color → "brand.primary_color"     (IMPORTANT: this binding is also the product-card price color — must contrast with card_bg=#FFFFFF; brand.accent_color is typically too light. Use brand.primary_color or a literal dark hex like "#0A0A0A".)`,
    `  font_family_body    → null`,
    `  font_family_display → null`,
    ``,
    `If you choose a WHITE-panel direction instead (panel_bg: "#FFFFFF"):`,
    `  panel_bg            → "#FFFFFF"`,
    `  panel_text_color    → "#0A0A0A"  (eyebrow becomes dark on white)`,
    `  headline_text_color → "#0A0A0A"  (display headline becomes dark on white)`,
    `  card_bg             → "brand.primary_color"  (cards become the brand color now)`,
    `  card_text_color     → "#FFFFFF"`,
    `  cta_button_bg       → "brand.accent_color"`,
    `  cta_text_color      → "#0A0A0A" if accent is light, else "#FFFFFF"`,
    `  accent_border_color → "brand.primary_color"   (still must contrast with card_bg — brand.primary now provides it on the dark card)`,
    `Don't leave text colors null — the AI-template path has no auto-contrast.`,
    ``,
    `CANVAS BACKGROUND.STYLE — pick based on whether support_media spans the full frame:`,
    `  full-bleed hero            → "solid" with panel_bg null (let media cover)`,
    `  split panel (half-frame)   → "split_panel"`,
    `  brand-color dominated      → "brand_fill"`,
    `  gradient between two brand colors → "gradient"`,
    ``,
    `POLYGON CLIPPING (zone.clipPolygon) — every zone has an optional clipPolygon: an array of {x, y} points in canvas coords (0-1000) that clips the zone's visible region to a polygon AFTER rect placement. Use cases:`,
    `  - Carve a full-bleed support_media around copy regions: set support_media rect to the full canvas, then clipPolygon defines an L-shape or angled cut that exposes a copy panel underneath.`,
    `  - Diagonal panel splits instead of horizontal/vertical 50/50.`,
    `  - Polygon-shaped product callouts (hexagons, parallelograms).`,
    `  - Carve around source_media.subjects bboxes so faces / hero products read clean.`,
    `Pass null when you want a plain rectangular zone (default). When you DO set clipPolygon: 3-16 points, all within the canvas, ordered clockwise OR counter-clockwise. Renderer converts to CSS clip-path; the rect still drives positioning + the zone's "click target" / collision area.`,
    ``,
    `Return creative_style + rationale + elements_used + elements_skipped so the validator can verify your picks are coherent.`
  ].join('\n');

  // Rich-context user payload. JSON-formatted so the LLM can read
  // arrays + nested fields cleanly. References image[N] for vision
  // inputs supplied as separate message parts.
  const userLines = [
    `CREATIVE STYLE: ${creativeStyle}`,
    `INTENT: ${styleSpec.intent}`,
    `Typical zones for this style: ${styleSpec.typical_zones.join(', ')}.`,
    `De-emphasized zones: ${styleSpec.de_emphasized.join(', ')}.`,
    ``,
    `TARGET CANVAS: aspect_ratio=${aspectRatio}, width=${width}, height=${height}.`,
    ``
  ];

  if (images.length) {
    userLines.push(`VISION INPUTS (attached as image parts in this message, in order):`);
    images.forEach((img, i) => userLines.push(`  image[${i}] — ${img.role}: ${img.label || ''}`));
    userLines.push(``);
    userLines.push(`Use the actual images to inform composition: where the subject sits in the hero, which regions are visually safe for text overlays, whether the brand color reads correctly against the photo's tones. Reference image[N] by role in your rationale.`);
    userLines.push(``);
  }

  if (ctx) {
    userLines.push(`FULL CONTEXT (structured JSON):`);
    userLines.push('```json');
    userLines.push(JSON.stringify(ctx, null, 2));
    userLines.push('```');
    userLines.push('');
    userLines.push(`PICK COPY FROM CANDIDATES. The "copy_candidates" object holds arrays — choose by index (headline_pick, subheadline_pick, eyebrow_pick). The backend resolves the index to the actual string before rendering, so the operator-approved copy is what ships. Use null when you don't want that element.`);
    userLines.push(``);
    userLines.push(`USE source_media.safe_overlay_zones to position text overlays — those rects are pre-computed regions where text won't collide with subjects in the photo. Match a headline / eyebrow / cta rect to one of these zones whenever a zone overlaps the source_hero image.`);
    userLines.push(``);
    userLines.push(`USE source_media.subjects bboxes when carving the support_media via clipPolygon — avoid clipping over a subject. Conversely, when you DO want product/face to read through, keep that subject's bbox inside the visible region.`);
    userLines.push(``);
  } else {
    // Minimal fallback for legacy callers (no rich context).
    userLines.push(`BRAND: ${JSON.stringify(input.brand || {})}`);
    userLines.push(`PRODUCT: ${JSON.stringify(input.product || {})}`);
    userLines.push(`COPY: ${JSON.stringify(input.copy || {})}`);
    userLines.push(``);
  }

  userLines.push(`Emit the canvas spec now. Skip elements that don't serve the chosen creative_style — record those in elements_skipped with brief reasons in rationale.`);

  const user = userLines.join('\n');
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

    // Polygon — when present, every point must be inside the canvas
    // (CSS clip-path tolerates out-of-rect points, but out-of-canvas
    // is almost always a bug).
    if (Array.isArray(z.clipPolygon) && z.clipPolygon.length) {
      if (z.clipPolygon.length < 3) {
        warnings.push(`zone ${z.id}: clipPolygon needs ≥3 points (got ${z.clipPolygon.length})`);
      }
      for (const [i, pt] of z.clipPolygon.entries()) {
        if (pt.x < 0 || pt.x > width || pt.y < 0 || pt.y > height) {
          warnings.push(`zone ${z.id}: clipPolygon[${i}] (${pt.x},${pt.y}) outside canvas`);
        }
      }
    }

    if (['headline', 'product_card', 'quote_card'].includes(z.kind) || z.id === 'headline') {
      hasCopyZone = true;
    }
  }
  // No hard-required zones — the LLM composes freely. Surface absences
  // as warnings so downstream tooling / the judge can weigh "this ad has
  // no CTA" against the creative intent without us throwing.
  if (!ids.has('logo')) warnings.push('no logo zone — verify brand attribution is intentional');
  if (!ids.has('cta'))  warnings.push('no cta zone — verify this is an awareness/editorial frame');
  if (!hasCopyZone)     warnings.push('no copy-bearing zone (headline / product_card / quote_card) — verify the creative reads without copy');

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

// Resolve the spec's copy_picks against the input's copy_candidates.
// Mutates a SHALLOW COPY of the input — original stays untouched so
// callers that hold a reference don't get surprised. Returns the
// mutated copy. The renderer reads input.copy.headline / .subheadline
// / .eyebrow as it does today; no renderer change needed.
function applyCopyPicks(input, spec) {
  if (!spec || !spec.copy_picks) return input;
  const picks = spec.copy_picks;
  const next = { ...input, copy: { ...(input.copy || {}) } };
  const candidates = input.copy_candidates || {};

  const pickOne = (arr, idx) => (
    Array.isArray(arr) && idx != null && idx >= 0 && idx < arr.length
      ? arr[idx]
      : null
  );

  if (picks.headline_pick != null) {
    const v = pickOne(candidates.headlines || [input.copy?.headline], picks.headline_pick);
    if (v != null) next.copy.headline = v;
  }
  if (picks.subheadline_pick != null) {
    const v = pickOne(candidates.subheadlines || [input.copy?.subheadline], picks.subheadline_pick);
    if (v != null) next.copy.subheadline = v;
  }
  if (picks.eyebrow_pick != null) {
    const v = pickOne(candidates.eyebrows || [input.copy?.eyebrow], picks.eyebrow_pick);
    if (v != null) next.copy.eyebrow = v;
  }
  return next;
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

  // Build the rich context FIRST (regardless of cache) so we have
  // copy_candidates available for applyCopyPicks. Candidates come from
  // the current input — they're not part of the cached spec, and stale
  // candidates would mean picks resolve against text the operator no
  // longer sees.
  let richContext = null;
  try {
    const ctx = await loadContext(mediaId, {
      productId, variantKind, paletteSource
    });
    if (ctx) richContext = await buildAiCanvasContext({ ctx, layoutInput: input, aspectRatio });
  } catch (err) {
    console.warn(`   ⚠️  aiCanvasSpec rich-context build failed (using minimal fallback): ${err.message}`);
  }
  // Stamp candidates onto the working input so applyCopyPicks (and
  // any downstream caller) can resolve picks against the same input.
  const inputWithCandidates = richContext?.text?.copy_candidates
    ? { ...input, copy_candidates: richContext.text.copy_candidates }
    : input;

  if (!refresh) {
    const cached = await AiCanvasArtifact.findOne(filter).lean();
    if (cached && cached.specSchemaVersion === SPEC_SCHEMA_VERSION) {
      const resolvedInput = applyCopyPicks(inputWithCandidates, cached.canvasSpec);
      return {
        spec:          cached.canvasSpec,
        cached:        true,
        artifactId:    String(cached._id),
        warnings:      cached.validationWarnings || [],
        resolvedInput
      };
    }
  }

  const { system, user } = buildPrompt({ input, template, aspectRatio, creativeStyle, richContext });
  const responseSchema = buildResponseSchema(aspectRatio);
  const promptHash = crypto.createHash('sha256').update(system + '\n' + user).digest('hex');

  // Multi-part user content when we have vision attachments — OpenAI
  // takes images alongside text via { type: 'image_url' } parts.
  const images = richContext?.images || [];
  const userContent = images.length
    ? [
        { type: 'text', text: user },
        ...images.map(img => ({ type: 'image_url', image_url: { url: img.url } }))
      ]
    : user;

  const t0 = Date.now();
  const completion = await openai.chat.completions.create({
    model: MODEL_ID,
    response_format: { type: 'json_schema', json_schema: responseSchema },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: userContent }
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

  const resolvedInput = applyCopyPicks(inputWithCandidates, spec);
  return { spec, cached: false, artifactId: String(artifact._id), warnings, resolvedInput };
}

module.exports = {
  getOrGenerate,
  applyCopyPicks,
  CREATIVE_STYLES,
  ALLOWED_ZONE_KINDS,
  ALLOWED_SLOTS,
  SPEC_SCHEMA_VERSION,
  // exposed for testing
  buildPrompt,
  validateSpec
};
