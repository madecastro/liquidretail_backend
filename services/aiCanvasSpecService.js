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
const SPEC_SCHEMA_VERSION = '2.3.0';   // 2.3: shadow hierarchy_spec (strategy + layout intent, no rects) — persisted for vocabulary analysis, renderer ignores

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
// the canonical-input schema keys at layoutInputService output + the
// grafted social_context / campaign nodes that getOrGenerate injects
// from richContext before passing input to the renderer.
const ALLOWED_SLOTS = [
  // Brand
  'brand.logo', 'brand.name', 'brand.tagline',
  // Copy (with picks already applied at this point)
  'copy.headline', 'copy.subheadline', 'copy.eyebrow', 'copy.cta_text',
  'copy.headline_lead', 'copy.headline_main',
  // CTA
  'cta.text', 'cta.url', 'cta',
  // Product (canonical input.product)
  'product.name', 'product.price', 'product.description', 'product.category',
  'product.image',
  'product.hero_media', 'product.lifestyle_image', 'product.product_image',
  'product.badges', 'product.short_benefits',
  'product.rating', 'product.review_count', 'product.review_summary',
  'product.reviews.0.text', 'product.reviews.0.author', 'product.reviews.0.rating',
  // Social proof (canonical)
  'social_proof.primary_quote', 'social_proof.primary_quote.text',
  'social_proof.primary_quote.author_name',
  'social_proof.rating_value', 'social_proof.review_count',
  'social_proof.secondary_quotes.0.text',
  'social_proof.secondary_quotes.0.author_name',
  // Social context (grafted from richContext at render time — likes,
  // creator handle, top comments, caption: all real UGC signal the LLM
  // sees in the prompt and can now place on the canvas)
  'social_context.caption', 'social_context.permalink', 'social_context.posted_at',
  'social_context.creator.handle', 'social_context.creator.platform',
  'social_context.creator.follower_count',
  'social_context.stats.likes', 'social_context.stats.comments',
  'social_context.stats.shares', 'social_context.stats.saves',
  'social_context.stats.reach', 'social_context.stats.engagement',
  'social_context.top_comments.0.text', 'social_context.top_comments.0.author',
  'social_context.top_comments.0.likes',
  'social_context.top_comments.1.text', 'social_context.top_comments.1.author',
  'social_context.top_comments.2.text', 'social_context.top_comments.2.author',
  // Trust
  'trust.trusted_by_text',
  // Campaign
  'campaign.offer', 'campaign.kind'
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
  // font is a MULTIPLIER (1.0 = baseline, 1.5 = 150%). Clamp to [0.5, 3.0]
  // at the schema layer so an out-of-range value can't silently torch a
  // zone's text size at render time. Validator also warns + clamps as
  // a belt-and-braces guard for cached specs from older models.
  const zoneScalerProps = Object.fromEntries(ZONE_SCALER_NAMES.map(n => [n, {
    type: ['object', 'null'],
    additionalProperties: false,
    required: ['font'],
    properties: { font: { type: ['number', 'null'], minimum: 0.5, maximum: 3.0 } }
  }]));

  return {
    name: 'ai_canvas_spec',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'creative_style', 'rationale', 'elements_used', 'elements_skipped',
        'aspect_ratio', 'canvas', 'safe_areas', 'zones', 'zone_scalers', 'style_bindings',
        'copy_picks', 'hierarchy_spec'
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
        },
        // Higher-level "design intent" pass — strategy + layout family +
        // visual direction + per-role hierarchy, no coordinates. Runs
        // in SHADOW today: persisted on the artifact for vocabulary
        // analysis but the renderer still reads zones[] (rects) above.
        // Goal is to observe what layout_family / emotional_hook /
        // comment_style / etc. strings the LLM converges on across
        // 50–100 generations, then formalize enums + wire a constraint
        // solver in a later slice that translates hierarchy → rects.
        hierarchy_spec: {
          type: 'object',
          additionalProperties: false,
          required: ['strategy', 'layout'],
          properties: {
            strategy: {
              type: 'object',
              additionalProperties: false,
              required: [
                'emotional_hook', 'social_proof_type',
                'product_priority', 'ugc_priority', 'comment_priority',
                'stat_priority', 'cta_emphasis'
              ],
              properties: {
                emotional_hook:     { type: 'string' },
                social_proof_type:  { type: 'string' },
                product_priority:   { type: 'string' },
                ugc_priority:       { type: 'string' },
                comment_priority:   { type: 'string' },
                stat_priority:      { type: 'string' },
                cta_emphasis:       { type: 'string' }
              }
            },
            layout: {
              type: 'object',
              additionalProperties: false,
              required: ['layout_family', 'visual_direction', 'zones'],
              properties: {
                layout_family: { type: 'string' },
                visual_direction: {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'density', 'visual_energy', 'contrast',
                    'corner_radius', 'shadow_depth', 'glass_level'
                  ],
                  properties: {
                    density:        { type: 'string' },
                    visual_energy:  { type: 'string' },
                    contrast:       { type: 'string' },
                    corner_radius:  { type: 'string' },
                    shadow_depth:   { type: 'string' },
                    glass_level:    { type: 'string' }
                  }
                },
                zones: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['role', 'priority', 'anchor', 'weight', 'component_style'],
                    properties: {
                      role:            { type: 'string' },   // hero_media | product | comment | quote | stat | rating | cta | offer | eyebrow | headline | logo | creator
                      priority:        { type: 'string' },   // high | medium | low
                      anchor:          { type: 'string' },   // top_left | top_right | center | bottom_left | bottom_right | leading | trailing | full
                      weight:          { type: 'number', minimum: 0, maximum: 1 },
                      component_style: { type: 'string' }    // e.g. floating_glass / featured_testimonial / caption_strip / pill_button / sticker / stat_hero / etc.
                    }
                  }
                }
              }
            }
          }
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
    `Compose freely — an editorial frame can skip the logo, a pure hero-quote can skip the product_card, a typographic ad can skip support_media.`,
    ``,
    `COMPOSITION ARCHETYPES — pick (or mix) one that suits the brand voice, hero image, and the rest of the FULL CONTEXT below. Do NOT default to the same archetype every time; vary based on which strongest signal the data offers (great photo? lead with hero. great quote? lead with quote. high engagement? lead with the stat).`,
    `  A) FULL-BLEED HERO + BOTTOM PANEL — support_media fills canvas; headline sits on a brand-color panel band along the bottom 25–35%. Safe default, works for any photo.`,
    `  B) VERTICAL SPLIT — image and brand panel each take ~50%, side-by-side. Strong for product reveals.`,
    `  C) DIAGONAL CARVE — use clipPolygon to split the canvas at an angle. Hero on one side, brand panel on the other. Energetic, magazine-like.`,
    `  D) TYPOGRAPHIC DOMINANT — headline is the hero (covers 50%+ of canvas), support_media reduced to a small inset or omitted. For category-creation / brand-voice messaging.`,
    `  E) HERO QUOTE OVERLAY — full-bleed hero image, a quote_card overlaid on a safe_overlay_zone. UGC + creator quote leads; product details minimal. Best when social_context.top_comments or social_proof.primary_quote is rich.`,
    `  F) MAGAZINE / EDITORIAL — eyebrow_rules + headline + body text stacked vertically over a solid panel, image inset bottom-right. Reads like print.`,
    `  G) STAT-LED SOCIAL PROOF — a numeric stat (rating, follower count, comment count, likes, engagement) rendered as the hero element via a text zone with a slot like social_context.stats.likes. Headline secondary. Use when the social signal is the strongest selling point.`,
    `  H) PRODUCT-CARD GRID — multiple product_card / media zones in a 2×2 or 1×3 arrangement for catalog/collection ads.`,
    `Within an archetype: vary panel position (top/bottom/left/right/diagonal), color emphasis (brand_fill vs gradient vs split), and which zones lead. Name the archetype + your variation in your rationale.`,
    ``,
    `SLOT PATHS (single string or array). The renderer reads these from the resolved input. Pick freely; don't limit yourself to the brand+headline+cta minimum.`,
    `  Brand    → brand.logo, brand.name, brand.tagline`,
    `  Copy     → copy.headline, copy.subheadline, copy.eyebrow, copy.cta_text, copy.headline_lead, copy.headline_main`,
    `  CTA      → "cta" (full object) or cta.text / cta.url`,
    `  Product  → product.name, product.price, product.description, product.category,`,
    `             product.image, product.hero_media, product.lifestyle_image, product.product_image,`,
    `             product.badges, product.short_benefits, product.rating, product.review_count,`,
    `             product.review_summary, product.reviews.0.text, product.reviews.0.author`,
    `  Social   → social_proof.primary_quote(.text/.author_name), social_proof.rating_value,`,
    `             social_proof.review_count, social_proof.secondary_quotes.0.text,`,
    `             social_context.caption, social_context.permalink,`,
    `             social_context.creator.handle, social_context.creator.follower_count,`,
    `             social_context.stats.likes, social_context.stats.comments, social_context.stats.shares,`,
    `             social_context.stats.engagement,`,
    `             social_context.top_comments.0.text/.0.author (also .1 and .2)`,
    `  Trust    → trust.trusted_by_text`,
    `  Campaign → campaign.offer, campaign.kind`,
    ``,
    `SLOT SHAPES — these are the only zones with a fixed array shape; everything else takes a single path:`,
    `  product_card  → ["product.image", "product.name", "product.price"]   (array, exactly this order)`,
    `  eyebrow_rules → ["copy.subheadline", "brand.tagline"]   (array — renderer picks the first that resolves)`,
    `  proof_bar     → ["social_proof.rating_value", "social_proof.review_count"]   (array)`,
    ``,
    `STYLE_VARIANT (shape hint, per zone). These exist for the renderer's enriched modes — leave null when you want plain text/image rendering:`,
    `  text / headline   → "display_script" (script editorial) | null (plain large type — picks the brand font)`,
    `  product_card      → "with_thumbnail" (image left + name+price right)`,
    `  quote_card        → "with_thumbnail" (quote + author + photo)`,
    `  proof_bar         → "with_verified_buyers" (rating + verified buyers chip)`,
    `  Everything else   → null`,
    ``,
    `ZONE_SCALERS — multipliers, NOT pixel sizes. 1.0 = baseline (the canvas-spec default). 1.5 = 150%, 0.8 = 80%. Hard range [0.5, 3.0]. Use sparingly to amplify ONE zone for emphasis. Default to null when you don't need to scale.`,
    ``,
    `STYLE BINDINGS — surfaces should use brand color PATHS so the rendered ad inherits the actual brand identity. Text colors must be EXPLICIT HEX values picked for contrast (the AI-template path has no contrast guard, so null falls through to the CSS default).`,
    `  Surface bindings (paths preferred):`,
    `    panel_bg, card_bg     → "brand.primary_color" | "brand.secondary_color" | "#FFFFFF" | "#0A0A0A"`,
    `    cta_button_bg         → "brand.accent_color" | "brand.primary_color"`,
    `    accent_border_color   → "brand.primary_color" (used as product-card price color too — must contrast with card_bg)`,
    `    font_family_body / font_family_display → "brand.font_family" when present, else null`,
    `  Text bindings (explicit hex):`,
    `    panel_text_color, headline_text_color, card_text_color, cta_text_color → "#FFFFFF" / "#0A0A0A" / etc.`,
    ``,
    `DO NOT invent a "brand-feeling" hex for panel_bg. The brand has a primary_color in the FULL CONTEXT — use the PATH "brand.primary_color" so the rendered ad matches the real brand identity. Picking a literal hex from the photo (cream, yellow, etc.) is almost always wrong.`,
    ``,
    `CANVAS BACKGROUND.STYLE — pick based on the chosen archetype:`,
    `  full-bleed hero (A/E)              → "solid" with panel_bg null (let media cover)`,
    `  split panel (B/F)                  → "split_panel"`,
    `  brand-color dominated (D/G)        → "brand_fill"`,
    `  diagonal carve (C)                 → "solid" (clipPolygon does the work)`,
    `  gradient between two brand colors  → "gradient"`,
    ``,
    `POLYGON CLIPPING (zone.clipPolygon) — array of {x,y} points in canvas coords (0–1000) that clips the zone's visible region AFTER rect placement. 3–16 points, all in-canvas. Use cases:`,
    `  - Carve a full-bleed support_media around copy regions (archetype C, sometimes A).`,
    `  - Diagonal panel splits.`,
    `  - Polygon-shaped product callouts.`,
    `  - Avoid source_media.subjects bboxes when carving.`,
    `Pass null for plain rectangular zones (most zones don't need a polygon).`,
    ``,
    `CRITICAL: text zones (kind=text, headline, eyebrow_rules, etc.) do NOT get their own background. Text sits directly on whatever surface its rect overlaps. If you want a darker reading surface, add an explicit kind='panel' zone with its own rect + panel_bg, then position the text rect INSIDE that panel.`,
    ``,
    `Return creative_style + rationale + elements_used + elements_skipped. In rationale, name the chosen archetype (A–H) + why the FULL CONTEXT pointed to it.`,
    ``,
    `── HIERARCHY SPEC (additional output, shadow today) ──`,
    `Alongside the canvas spec, also emit a hierarchy_spec describing the SAME ad at a higher level of abstraction. Think of it as your design notes — what you'd hand a designer if they were doing the geometry themselves. No coordinates here; just strategy + visual intent + per-role hierarchy.`,
    ``,
    `OPEN VOCABULARY: pick the value that best describes your decision. The example values below are anchors, NOT enums — if you need a new term that fits better, use it. We're collecting the vocabulary you naturally pick.`,
    ``,
    `  strategy:`,
    `    emotional_hook       — what this ad triggers. examples: trust / authenticity / performance / urgency / aspiration / value / discovery / curiosity / belonging / craftsmanship`,
    `    social_proof_type    — which proof leads. examples: testimonial / stat / creator / review / rating / press / awards / none`,
    `    product_priority     — how prominent the product is. examples: high / medium / low / absent`,
    `    ugc_priority         — how prominent the source UGC photo is. examples: high / medium / low / absent`,
    `    comment_priority     — how prominent a comment overlay is. examples: high / medium / low / absent`,
    `    stat_priority        — how prominent a numeric stat (likes, rating count, etc.) is. examples: high / medium / low / absent`,
    `    cta_emphasis         — how dominant the CTA is. examples: primary / secondary / minimal / absent`,
    ``,
    `  layout:`,
    `    layout_family        — high-level composition family. examples: asymmetric_split / vertical_split / hero_product / hero_quote / stat_dominant / typographic / magazine / review_grid / mosaic / diagonal_carve`,
    `    visual_direction:`,
    `      density            — examples: airy / medium / dense / editorial`,
    `      visual_energy      — examples: calm / balanced / high / electric`,
    `      contrast           — examples: soft / strong / extreme`,
    `      corner_radius      — examples: sharp / small / medium / large / pill`,
    `      shadow_depth       — examples: none / minimal / soft / pronounced / dramatic`,
    `      glass_level        — examples: none / light / medium / heavy   (frosted/blur surfaces over media)`,
    `    zones[]              — one entry per visible role in the ad`,
    `      role               — examples: hero_media / product / comment / quote / stat / rating / cta / offer / eyebrow / headline / logo / creator`,
    `      priority           — high / medium / low`,
    `      anchor             — examples: top_left / top_right / center / bottom_left / bottom_right / leading / trailing / full`,
    `      weight             — 0.0–1.0, the visual share of canvas this role occupies (all weights together can sum to more than 1.0 when zones overlap, e.g. text on a hero)`,
    `      component_style    — which visual treatment for this role. examples: floating_glass / featured_testimonial / caption_strip / pill_button / solid_primary / outlined / sticker / stat_hero / stat_row / star_burst / extended_card / compact_card / handle_chip / creator_card / discount_badge / offer_ribbon / display_script / sans_caps / slab_serif`,
    ``,
    `This output runs in shadow today — the renderer consumes zones[] (rects) above. The hierarchy_spec is collected so we can formalize the vocabulary you converge on, then wire a constraint solver later that translates hierarchy → rects. Pick what feels right; don't over-think alignment with the canvas spec.`
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

  // zone_scalers belt-and-braces: schema already restricts font to
  // [0.5, 3.0] but cached older specs (2.1.0) may carry pixel-size
  // values. Clamp + warn so the renderer never sees a runaway scaler.
  for (const [name, entry] of Object.entries(spec.zone_scalers || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.font === 'number' && (entry.font < 0.5 || entry.font > 3.0)) {
      warnings.push(`zone_scaler ${name}.font ${entry.font} out of range — clamped to [0.5, 3.0]`);
      entry.font = Math.max(0.5, Math.min(3.0, entry.font));
    }
  }

  // Brand-identity sanity: panel_bg / card_bg as a literal hex when a
  // brand color path is available almost always means the LLM cherry-
  // picked a "brand-feeling" color from the photo instead of using
  // the actual brand identity. Warn so the judge / operator can see it.
  // The check is style-binding only — we don't know what brand.* is
  // here, so we just flag literal hex picks on the dominant surfaces.
  const sb = spec.style_bindings || {};
  for (const k of ['panel_bg', 'card_bg']) {
    const v = sb[k];
    if (typeof v === 'string' && v.startsWith('#') && !['#FFFFFF', '#FFF', '#000', '#000000', '#0A0A0A', '#F5F5F5'].includes(v.toUpperCase())) {
      warnings.push(`${k} is a non-neutral literal hex "${v}" — prefer a brand.* path so the surface inherits brand identity`);
    }
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
  // Stamp candidates + social/campaign extras onto the working input
  // so applyCopyPicks AND the renderer can resolve slot paths like
  // social_context.stats.likes / campaign.offer / social_context.top_comments.0.text
  // that the canonical layoutInput shape doesn't normally carry.
  // Canonical input.product wins over richContext.text.product for any
  // overlapping keys (canonical has hero_media / image / lifestyle_image
  // objects the LLM expects; richContext flattens those to *_present flags).
  const rcText = richContext?.text || {};
  const inputWithCandidates = {
    ...input,
    copy_candidates: rcText.copy_candidates || input.copy_candidates,
    social_context:  rcText.social_context  || input.social_context || null,
    campaign:        { ...(rcText.campaign || {}), ...(input.campaign || {}) },
    product:         { ...(rcText.product  || {}), ...(input.product  || {}) }
  };

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
      hierarchySpec:     spec.hierarchy_spec || null,
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
