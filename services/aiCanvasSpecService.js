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
const { trackLlmCall, recordCacheHit } = require('./costTracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID = 'gpt-4.1';
const SPEC_SCHEMA_VERSION = '2.7.0';   // 2.7: Phase 5c.2 — enriched Generator signal payload (brand description, commerce sellers/specs/availability, rating distribution, cross-media distributions). 2.6: real spatial analysis per crop ratio.

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
  },

  ugc_led: {
    intent:
      "The source UGC photo IS the ad — full bleed, the photo's atmosphere and authenticity are the entire creative. " +
      "Brand presence is minimal: small logo chip, no large brand panel. " +
      "Creator attribution is visible (handle, platform, maybe follower count). " +
      "Copy is short and overlay-style on a safe zone — no panel scrims unless legibility demands it. " +
      "CTA is secondary or minimal — the photo + creator do the selling.",
    typical_zones:    ['support_media', 'logo', 'creator', 'headline', 'cta'],
    de_emphasized:    ['panel', 'product_card', 'badge_row', 'proof_bar']
  },

  social_proof_led: {
    intent:
      "Real social signal is the hero element. The strongest piece of data the FULL CONTEXT carries (a glowing comment, a high rating, a big follower/engagement number, a featured testimonial) becomes the visual anchor — placed center, large, the first thing the eye reads. " +
      "Product is supporting; brand panel is small or absent. " +
      "If social_context.top_comments has rich entries, surface one as a quote_card or floating comment. " +
      "If social_context.stats.likes / .engagement is high, surface it as a stat_hero. " +
      "If social_proof.rating_value is strong, surface it as a star rating with the review count beside it.",
    typical_zones:    ['quote_card', 'proof_bar', 'support_media', 'headline', 'cta', 'logo'],
    de_emphasized:    ['eyebrow_rules', 'badge_row']
  },

  editorial: {
    intent:
      "Magazine-spread aesthetic. Typography is the hero — large display headline, optional eyebrow with rule, body-copy block (product.description or short_benefits). " +
      "Image is inset or framed (not full-bleed). " +
      "Generous negative space. " +
      "Color palette restrained — one accent against neutrals. " +
      "Reads like a feature article, not a sales ad.",
    typical_zones:    ['eyebrow_rules', 'headline', 'text', 'support_media', 'logo', 'cta'],
    de_emphasized:    ['proof_bar', 'badge_row', 'quote_card']
  },

  promotional: {
    intent:
      "Offer-first. The discount / sale / bundle is the visual hero — a sticker badge, ribbon, or large numeric callout dominates. " +
      "Product image present and clearly tied to the offer. " +
      "Urgency cues (limited time, save X%) read at a glance. " +
      "Bright contrast, attention-grabbing CTA. " +
      "Bind campaign.offer to a prominent zone.",
    typical_zones:    ['offer', 'product_card', 'cta', 'support_media', 'badge_row', 'logo', 'headline'],
    de_emphasized:    ['quote_card', 'text', 'eyebrow_rules']
  }
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
  // Per-ratio crop variants of the hero source — let the LLM pick a
  // different aspect than the canvas (panoramic strip on 1:1, vertical
  // inset, story-aspect band, etc.) instead of being forced into the
  // canvas-ratio winner crop for every media slot.
  'product.hero_media.crops.1_1',
  'product.hero_media.crops.4_5',
  'product.hero_media.crops.5_4',
  'product.hero_media.crops.9_16',
  'product.hero_media.crops.1_91_1',
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
      // ORDER MATTERS: LLMs emit properties left-to-right. hierarchy_spec
      // comes FIRST so the model commits to strategy + layout_family
      // BEFORE drawing zones — otherwise hierarchy becomes post-hoc
      // commentary on whatever the model already drew, and every ad
      // collapses to hero_product. (Confirmed empirically: 2.3.0 with
      // hierarchy_spec last → 16/16 hero_product.)
      required: [
        'hierarchy_spec',
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
            required: ['id', 'kind', 'slot', 'rect', 'layer', 'style_variant', 'max_lines', 'fit', 'radius', 'clipPolygon', 'visual_direction'],
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
              },
              // Per-zone visual_direction override (2.5+). Same shape
              // as hierarchy_spec.layout.visual_direction but every
              // field is independently nullable — null inherits the
              // stage-level default, non-null overrides. Use for ONE
              // focal element (a hero quote card with heavy glass and
              // dramatic shadow while the rest of the ad stays solid).
              visual_direction: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['density', 'visual_energy', 'contrast', 'corner_radius', 'shadow_depth', 'glass_level'],
                    properties: {
                      density:        { type: ['string', 'null'] },
                      visual_energy:  { type: ['string', 'null'] },
                      contrast:       { type: ['string', 'null'] },
                      corner_radius:  { type: ['string', 'null'] },
                      shadow_depth:   { type: ['string', 'null'] },
                      glass_level:    { type: ['string', 'null'] }
                    }
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
function buildPrompt({ input, template, aspectRatio, creativeStyle, richContext, directionConcept = null }) {
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
    `  A) FULL-BLEED HERO + BOTTOM PANEL — support_media fills canvas; headline sits on a colored panel band along the bottom 25–35% (pick a hex that complements the photo). Safe default, works for any photo.`,
    `  B) VERTICAL SPLIT — image and brand panel each take ~50%, side-by-side. Strong for product reveals.`,
    `  C) DIAGONAL CARVE — use clipPolygon to split the canvas at an angle. Hero on one side, brand panel on the other. Energetic, magazine-like.`,
    `  D) TYPOGRAPHIC DOMINANT — headline is the hero (covers 50%+ of canvas), support_media reduced to a small inset or omitted. For category-creation / brand-voice messaging.`,
    `  E) HERO QUOTE OVERLAY — full-bleed hero image, a quote_card overlaid on a safe_overlay_zone. UGC + creator quote leads; product details minimal. Best when social_context.top_comments or social_proof.primary_quote is rich.`,
    `  F) MAGAZINE / EDITORIAL — eyebrow_rules + headline + body text stacked vertically over a solid panel, image inset bottom-right. Reads like print.`,
    `  G) STAT-LED SOCIAL PROOF — a numeric stat (rating, follower count, comment count, likes, engagement) rendered as the hero element via a text zone with a slot like social_context.stats.likes. Headline secondary. Use when the social signal is the strongest selling point.`,
    `  H) PRODUCT-CARD GRID — multiple product_card / media zones in a 2×2 or 1×3 arrangement for catalog/collection ads.`,
    `Within an archetype: vary panel position (top/bottom/left/right/diagonal), color emphasis (solid block vs gradient vs split), and which zones lead. Name the archetype + your variation in your rationale.`,
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
    `HERO CROP RATIOS — every source has crops at multiple aspect ratios available via product.hero_media.crops.* (1_1, 4_5, 5_4, 9_16, 1_91_1). The DEFAULT product.hero_media.image is the canvas-ratio winner. Use an alt crop when the composition calls for a different aspect than the canvas — e.g. on a 1:1 canvas:`,
    `  - slot a 1.91:1 crop (product.hero_media.crops.1_91_1) as a panoramic strip across the middle`,
    `  - slot a 9:16 crop (product.hero_media.crops.9_16) as a tall vertical inset`,
    `  - slot a 4:5 crop (product.hero_media.crops.4_5) as a portrait product card`,
    `Check source_media.alt_crops in the FULL CONTEXT to see which ratios actually exist for THIS media (some media only ship some crops). Vision attachments include the most aspect-different alt crops so you can see how the alts frame the subject.`,
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
    `STYLE BINDINGS — every color is an EXPLICIT HEX value YOU pick. No "brand.primary_color" / "brand.secondary_color" / "brand.accent_color" paths — the brand object no longer carries colors, so paths resolve to null. Choose a cohesive palette (2–3 working colors plus near-white / near-black for text) that complements the source photo's tones and matches the brand TONE (energetic, premium, playful, etc.). Aim for high contrast on text surfaces; the AI-template path has no contrast guard.`,
    `  Surface bindings (explicit hex):`,
    `    panel_bg, card_bg     → "#A52A2A" / "#FFF8E7" / "#0A0A0A" / etc. — pick to read against media, support the mood`,
    `    cta_button_bg         → high-contrast accent hex (often complementary to panel_bg)`,
    `    accent_border_color   → product-card price color too — must contrast with card_bg`,
    `    font_family_body / font_family_display → null (use renderer defaults — do NOT invent font names)`,
    `  Text bindings (explicit hex):`,
    `    panel_text_color, headline_text_color, card_text_color, cta_text_color → "#FFFFFF" / "#0A0A0A" / etc., picked for contrast against the surface beneath`,
    ``,
    `PALETTE DERIVATION — How to pick:`,
    `  1. Look at the source photo's dominant tones (food photography → warm browns/golds; outdoor lifestyle → earth + sky; product-only → background neutral).`,
    `  2. Pick a panel/card color that sits cleanly against those tones (avoid clashing hue, avoid matching so closely the photo bleeds into the panel).`,
    `  3. Pick a CTA color that's the visual hot-spot — usually high-chroma, often complementary to the panel.`,
    `  4. Match the brand's TONE: a "premium / minimal" brand wants restrained near-monochrome; an "energetic / playful" brand wants saturated + bold.`,
    `  5. Don't pull arbitrary photo-sampled pastels with no relationship to mood; aim for an intentional 2–3 color story.`,
    ``,
    `CANVAS BACKGROUND.STYLE — pick based on the chosen archetype:`,
    `  full-bleed hero (A/E)              → "solid" with panel_bg null (let media cover)`,
    `  split panel (B/F)                  → "split_panel"`,
    `  bold typographic / color-block (D/G) → "solid" with a strong panel_bg hex you picked`,
    `  diagonal carve (C)                 → "solid" (clipPolygon does the work)`,
    `  gradient between two palette colors → "gradient" (the two colors come from your picked palette)`,
    ``,
    `PER-ZONE VISUAL_DIRECTION OVERRIDES (zone.visual_direction) — every zone has an optional visual_direction with the same shape as hierarchy_spec.layout.visual_direction. Null inherits the stage default; non-null fields override on that zone only. Use when ONE focal element wants different treatment from the rest of the ad — a hero quote_card with glass_level: "heavy" + shadow_depth: "dramatic" while the rest stays solid, or a comment card with corner_radius: "pill" inside an otherwise sharp-cornered layout. Default to null when the zone matches the stage direction (most zones).`,
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
    `CRITICAL: panel zones sit ON TOP of media zones (z-index by layer: media=0, background=1, copy=3). Do NOT emit a panel whose rect covers (or substantially overlaps) the media zone — that BLANKS the photo. A panel is a TEXT-SURFACE element, sized to the text region. Patterns that work:`,
    `  - Bottom band panel — rect.y ≥ 600, height 200-400, behind headline + cta. Photo shows in top 60-70%.`,
    `  - Side strip panel — half-width vertical, behind a stack of text. Photo shows in the other half.`,
    `  - Card panel — small rect behind a quote or stat. Photo shows around it.`,
    `Patterns that BLANK the photo (forbidden):`,
    `  - Panel with rect 0,0 1000x1000 + dark panel_bg → covers entire media.`,
    `  - Panel covering >60% of the media zone's area with non-transparent bg → renderer applies an opacity guard but the layout still reads broken.`,
    `If you want a tinted/scrim effect across the whole photo, use canvas.background.style: "gradient" or "solid" with your picked panel_bg (which the renderer applies as a background fill, NOT as an overlay zone). Or set visual_direction.glass_level on the panel for translucency.`,
    ``,
    `CRITICAL: if hierarchy_spec.strategy.social_proof_type is anything OTHER than "none" / "absent" / empty, your zones[] MUST include at least one zone that actually surfaces that proof. Concrete: testimonial → kind='quote' or 'quote_card' with slot in social_proof.* (primary_quote / featured_review); creator → kind='comment' or 'creator_card' with slot in social_proof.top_comments.* or creator/handle; stat → kind='stat' with slot in performance.* or social_proof.rating.*; rating → kind='rating' with slot in social_proof.rating.*; review → kind='quote_card' with slot in social_proof.featured_review.*. A concept declaring social_proof_type: "testimonial" without a quote-bearing zone is broken — the renderer will surface a hierarchy_consistency warning and the LLM Judge will down-rank it. Conversely, if you have no proof data to bind to, set strategy.social_proof_type="none" and skip the proof zone entirely. Do NOT fake it with a generic CTA chip or eyebrow.`,
    ``,
    `Return creative_style + rationale + elements_used + elements_skipped. In rationale, name the chosen archetype (A–H) + why the FULL CONTEXT pointed to it.`,
    ``,
    `── HIERARCHY SPEC (decide this FIRST) ──`,
    `Before drawing any zones, decide the hierarchy_spec — strategy + layout_family + visual_direction + per-role hierarchy. Then draw zones[] to SATISFY that hierarchy. The schema's required order puts hierarchy_spec first for exactly this reason; commit to the strategy, then build the canvas to express it.`,
    ``,
    `IMPORTANT: do not default to "brand-led / hero_product / panel-at-bottom / pill CTA / no social proof" every time. Look at the FULL CONTEXT — if it has rich comments, lead with comments. If it has high engagement stats, lead with the stat. If the photo is the strongest signal, lead with the photo. If the brand voice is the strongest signal, lead with typography. The variety should come from MATCHING the strategy to the data, not from picking one safe default.`,
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

  // Phase 2 V2 — when the Creative Director supplied a concept, inject
  // it as a directive at the TOP of the user message. The system prompt
  // still has the archetype menu (for legacy V1 callers) but the LLM is
  // told to MATERIALIZE this concept rather than invent a strategy.
  // Hierarchy_spec the LLM emits should match the concept's archetype
  // and priorities — that's checked by the V2 consistency validator.
  if (directionConcept) {
    userLines.push(`── CREATIVE DIRECTION (from the Director — MATERIALIZE THIS CONCEPT) ──`);
    userLines.push('```json');
    userLines.push(JSON.stringify({
      concept_id:             directionConcept.concept_id,
      name:                   directionConcept.name,
      archetype:              directionConcept.archetype,
      layout_family:          directionConcept.layout_family,
      emotional_hook:         directionConcept.emotional_hook,
      social_proof_type:      directionConcept.social_proof_type,
      product_priority:       directionConcept.product_priority,
      ugc_priority:           directionConcept.ugc_priority,
      comment_priority:       directionConcept.comment_priority,
      stat_priority:          directionConcept.stat_priority,
      cta_emphasis:           directionConcept.cta_emphasis,
      recommended_components: directionConcept.recommended_components || {},
      rationale:              directionConcept.rationale
    }, null, 2));
    userLines.push('```');
    userLines.push(``);
    userLines.push(`Your hierarchy_spec MUST match the concept's archetype, layout_family, emotional_hook, social_proof_type, *_priority, and cta_emphasis VERBATIM. Your zones[] MUST satisfy each high/medium priority role. Use the recommended_components map as the default per-zone style_variant pick — override only when a constraint demands it (missing prop, no space, etc.) and note the override in rationale.`);
    userLines.push(``);
    userLines.push(`Do not invent a different archetype or alternative strategy. The strategy is GIVEN.`);
    userLines.push(``);
  }

  if (images.length) {
    userLines.push(`VISION INPUTS (attached as image parts in this message, in order):`);
    images.forEach((img, i) => userLines.push(`  image[${i}] — ${img.role}: ${img.label || ''}`));
    userLines.push(``);
    userLines.push(`Use the actual images to inform composition: where the subject sits in the hero, which regions are visually safe for text overlays, what palette you'll pick to complement the photo's tones. Reference image[N] by role in your rationale.`);
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
    userLines.push(`SPATIAL ANALYSIS (source_media.spatial_analysis) — per-crop intelligence. For each available crop ratio (canvas + every alt ratio you can slot via product.hero_media.crops.*), you get four signals computed from the actual cropped image:`);
    userLines.push(`  density_grid       — 0–1 per cell, top→bottom rows. 0 = empty/uniform (SAFE to place text). 1 = visually busy / subject / detailed texture (AVOID). Pick zone rects that overlap LOW-density cells.`);
    userLines.push(`  brightness_grid    — 0–1 per cell. 0 = dark (use WHITE text). 1 = light (use DARK text). Read the cells your text-zone rect overlaps to pick the headline/cta text color that will read.`);
    userLines.push(`  keep_out_zones     — explicit subject / face / text / product restrictions (already in canvas 0..1000 coords). Strictness ≥ 0.9 = hard rule (NEVER cover). Lower = softer guidance.`);
    userLines.push(`  primary_subject_rect — the dominant subject. Keep visible; don't fully cover with panels or text.`);
    userLines.push(`When you slot an alt-ratio crop (product.hero_media.crops.1_91_1 etc.) READ THE GRID FOR THAT RATIO via spatial_analysis.by_ratio.<ratio_key> — the canvas-ratio grid does NOT match what's in the alt crop frame.`);
    userLines.push(``);
    userLines.push(`USE source_media.subjects bboxes when carving the support_media via clipPolygon — avoid clipping over a subject. Conversely, when you DO want product/face to read through, keep that subject's bbox inside the visible region.`);
    userLines.push(``);
    userLines.push(`ENRICHED SIGNALS — use these to make non-obvious composition / copy decisions:`);
    userLines.push(`  brand.description / brand.brand_reviews_summary — actual brand voice. Drives color/typography mood beyond the tone words. A "small-batch artisan oil" brand wants warmer tones + serif-leaning type vs a "high-performance training gear" brand wanting cool tones + condensed sans.`);
    userLines.push(`  product.commerce.sellers — if Walmart + Amazon both stock it at similar prices, the product is mass-distributed (lean accessible/value); if listed by 1-2 specialty sellers at higher prices, lean premium/aspirational. Sellers list can also justify a "Sold at: [logos]" badge row.`);
    userLines.push(`  product.commerce.specs — surface 1-2 standout specs in a tight callout when typographic-dominant (e.g. "100% Cotton · Pre-shrunk" under a t-shirt headline).`);
    userLines.push(`  product.commerce.availability — if "out of stock" / "preorder", DROP the CTA or downgrade to "Notify me" rather than "Shop Now" (don't promise what can't be bought).`);
    userLines.push(`  product.rating_distribution — when 80%+ of reviews are 5-star, you can lean stat_led with "92% love it" instead of the bare rating. Skewed distributions = more compelling than averages.`);
    userLines.push(`  signals.cross_media — this product has matched UGC beyond just the source photo. Distributions tell you what the rest LOOKS like:`);
    userLines.push(`    shot_type_distribution mostly lifestyle/on_model → ugc_led + photo-led composition; mostly product_only → typographic_dominant / strong color blocks`);
    userLines.push(`    content_nature_distribution mostly evergreen → quote/stat composition is safe; mostly promotional → archetype should sidestep the dated feel`);
    userLines.push(`    avg_ad_readiness high (>0.7) = photo-led works; low (<0.4) = lean typographic or brand-color-led to avoid weak imagery`);
    userLines.push(`    avg_engagement_rate high (>0.05) = social-proof-led is justified; low = brand-voice-led safer`);
    userLines.push(`  These signals are SUPPORTING, not authoritative — the Director concept's archetype + emotional_hook + social_proof_type are the contract. Use the signals to choose colors, copy, layout details that REINFORCE the concept, not to invent a different one.`);
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

  // (Brand-identity hex-vs-path warning removed — the brand object no
  // longer carries colors, so explicit hex IS the only valid path and
  // doesn't need a "verify rationale" flag.)

  // Panel-over-media safety check (post z-index fix). Any panel zone
  // covering >60% of a media zone's area gets dampened to opacity 0.35
  // at render time, but the spec is still broken — the LLM intended a
  // backdrop and got an obscuring overlay. Warn so the operator (and
  // future judge) can de-rank.
  const mediaRects = spec.zones.filter(z =>
    (z.kind === 'media' || z.role === 'hero_media' || z.role === 'support_media') && z.rect
  );
  for (const z of spec.zones) {
    const isPanel = z.kind === 'panel' || z.role === 'panel' || z.role === 'scrim';
    if (!isPanel || !z.rect) continue;
    const pArea = (z.rect.w || 0) * (z.rect.h || 0);
    if (!pArea) continue;
    for (const m of mediaRects) {
      const mArea = (m.rect.w || 0) * (m.rect.h || 0);
      if (!mArea) continue;
      const x1 = Math.max(z.rect.x, m.rect.x);
      const y1 = Math.max(z.rect.y, m.rect.y);
      const x2 = Math.min(z.rect.x + z.rect.w, m.rect.x + m.rect.w);
      const y2 = Math.min(z.rect.y + z.rect.h, m.rect.y + m.rect.h);
      const overlap = (x2 <= x1 || y2 <= y1) ? 0 : (x2 - x1) * (y2 - y1);
      const pctOfMedia = overlap / mArea;
      if (pctOfMedia > 0.6) {
        warnings.push(`panel zone "${z.id}" covers ${Math.round(pctOfMedia * 100)}% of media zone "${m.id}" — renderer will auto-dampen opacity. Resize the panel to the text region (bottom band, side strip, or card sized to copy).`);
        break;
      }
    }
  }

  // ── Hierarchy ↔ canvas consistency (1d-f) ─────────────────────
  // The LLM emits hierarchy_spec FIRST (post-1d-e.1 reorder) but
  // nothing forces the canvas zones to actually express what
  // hierarchy declared. When they drift — strategy says "lead with
  // a comment" but no comment zone exists — the rendered ad doesn't
  // match its own intent. These warnings make that drift visible so
  // the judge (or operator review) can de-rank inconsistent specs.
  warnings.push(...checkHierarchyConsistency(spec));

  return warnings;
}

// Map a hierarchy role to a predicate that matches a canvas zone.
// Fuzzy match: a "comment" role can be either a quote_card OR a
// text zone whose slot points at social_context.top_comments.* —
// we check kind + slot together. Returns true when the canvas
// satisfies the role; the consistency walker uses this per
// hierarchy_spec.layout.zones entry.
function canvasZoneSatisfiesRole(role, zone) {
  const slot = Array.isArray(zone.slot) ? zone.slot.join(' ') : (zone.slot || '');
  const r = String(role || '').toLowerCase();
  switch (r) {
    case 'hero_media':
    case 'support_media':
    case 'media':
      return zone.kind === 'media';
    case 'product':
      return zone.kind === 'product_card'
          || (zone.kind === 'media' && /product\./.test(slot));
    case 'comment':
      return /social_context\.(top_comments|caption)/.test(slot);
    case 'quote':
    case 'testimonial':
      return zone.kind === 'quote_card'
          || /social_proof\.(primary_quote|secondary_quotes)/.test(slot);
    case 'stat':
      return /social_context\.stats|social_proof\.(rating_value|review_count)/.test(slot);
    case 'rating':
      return zone.kind === 'proof_bar'
          || /social_proof\.(rating_value|review_count)/.test(slot);
    case 'cta':
      return zone.kind === 'cta';
    case 'offer':
    case 'discount':
    case 'promo':
      return /campaign\.offer/.test(slot);
    case 'eyebrow':
      return zone.kind === 'eyebrow_rules'
          || (/copy\.(eyebrow|subheadline)/.test(slot));
    case 'headline':
      return (zone.kind === 'text' || zone.kind === 'headline')
          && /copy\.headline/.test(slot);
    case 'logo':
    case 'brand':
      return zone.kind === 'logo';
    case 'creator':
    case 'creator_attribution':
      return /social_context\.creator/.test(slot);
    default:
      // Unknown role — don't warn; LLM may have invented a vocabulary
      // term we haven't mapped yet. Vocabulary analysis will surface
      // it through the aggregation queries.
      return null;
  }
}

// Hard-violation check used both by the soft validator (emits a warning)
// and by the pre-Judge candidate filter (drops the candidate). Returns
// true when hierarchy_spec.strategy.social_proof_type is non-none AND
// no zone in zones[] surfaces actual proof data — i.e. the candidate
// declared a proof strategy it didn't follow through on. The Generator
// has been ignoring this rule even when the prompt spells it out, so we
// pull non-compliant candidates out of the Judge's candidate pool to
// force compliance via selection pressure.
function specViolatesProofStrategy(spec) {
  const hs = spec?.hierarchy_spec;
  if (!hs) return false;
  const proofType = String(hs.strategy?.social_proof_type || '').toLowerCase();
  if (!proofType || ['none', 'absent', ''].includes(proofType)) return false;
  const cvZones = spec.zones || [];
  return !cvZones.some(z => {
    const slot = Array.isArray(z.slot) ? z.slot.join(' ') : (z.slot || '');
    return /social_proof\.|social_context\.(top_comments|stats|caption|creator)/.test(slot)
        || z.kind === 'proof_bar' || z.kind === 'quote_card';
  });
}

function checkHierarchyConsistency(spec) {
  const out = [];
  const hs = spec.hierarchy_spec;
  if (!hs || !hs.layout || !Array.isArray(hs.layout.zones)) return out;

  const hsZones = hs.layout.zones;
  const cvZones = spec.zones || [];

  // Forward check: every high/medium-priority hierarchy role should
  // have at least one matching canvas zone. Low-priority roles get a
  // pass — the LLM may have declared them aspirationally without
  // committing canvas to them.
  for (const hz of hsZones) {
    const priority = String(hz.priority || '').toLowerCase();
    if (priority !== 'high' && priority !== 'medium') continue;
    const matched = cvZones.some(z => canvasZoneSatisfiesRole(hz.role, z));
    if (matched === false) {
      out.push(`hierarchy declares role="${hz.role}" priority=${priority} but no canvas zone matches — canvas talks past hierarchy`);
    }
    // matched === null means unknown role; skip warning.
  }

  // Strategy-level proof check: if social_proof_type is non-empty
  // (testimonial / stat / creator / review / rating / etc.) but no
  // canvas zone surfaces ANY proof data, the strategy is empty.
  if (specViolatesProofStrategy(spec)) {
    const proofType = String(hs.strategy?.social_proof_type || '').toLowerCase();
    out.push(`strategy.social_proof_type="${proofType}" but no canvas zone surfaces social proof — declared strategy unsupported`);
  }

  // Strategy-level CTA check: if cta_emphasis is primary/secondary but
  // no canvas CTA zone exists, the CTA declaration is empty.
  const ctaEmph = String(hs.strategy?.cta_emphasis || '').toLowerCase();
  if (ctaEmph && !['none', 'absent', 'minimal', ''].includes(ctaEmph)) {
    const hasCta = cvZones.some(z => z.kind === 'cta');
    if (!hasCta) {
      out.push(`strategy.cta_emphasis="${ctaEmph}" but no canvas cta zone — CTA emphasis declared with no CTA to emphasize`);
    }
  }

  return out;
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
  refresh          = false,
  // Phase 2 V2 — when supplied, the Director's concept fills in the
  // strategy + recommended_components and the prompt drops the
  // archetype menu / "decide first" instructions. Generator's job
  // becomes materialization, not strategy invention.
  directionArtifactId = null,
  directionConcept    = null,   // the concept object itself (not just its id)
  // Phase 3 — multi-candidate generation. nCandidates > 1 only fires
  // when directionConcept is supplied (V2 path); preview mode passes 1.
  // Generator runs N concurrent OpenAI calls then dispatches to the
  // Judge to pick the winner.
  nCandidates         = 1,
  previewMode         = false
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
    if (ctx) richContext = await buildAiCanvasContext({
      ctx, layoutInput: input, aspectRatio,
      // Phase 4 — the input builder uses these to look up the
      // style-aware copy candidates artifact (cache-keyed on
      // brandId+productId+creativeStyle).
      brandId, productId, creativeStyle
    });
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
  const cropMaps = richContext?.cropMaps || {};
  const inputWithCandidates = {
    ...input,
    copy_candidates: rcText.copy_candidates || input.copy_candidates,
    social_context:  rcText.social_context  || input.social_context || null,
    campaign:        { ...(rcText.campaign || {}), ...(input.campaign || {}) },
    product: {
      ...(rcText.product  || {}),
      ...(input.product  || {}),
      // Graft all-ratio crop maps so slot paths like
      // product.hero_media.crops.1_91_1 resolve to the wide
      // panoramic URL even when the canvas is 1:1.
      hero_media: {
        ...(input.product?.hero_media || {}),
        crops: cropMaps.hero || (input.product?.hero_media?.crops || {})
      },
      lifestyle_image: {
        ...(input.product?.lifestyle_image || {}),
        crops: cropMaps.lifestyle || (input.product?.lifestyle_image?.crops || {})
      },
      product_image: {
        ...(input.product?.product_image || {}),
        crops: cropMaps.product_only || (input.product?.product_image?.crops || {})
      }
    }
  };

  // Cache key serialized for cost-log grouping. Includes every cartesian
  // dimension the AiCanvasArtifact unique index covers.
  const costCacheKey = JSON.stringify({
    mediaId: String(mediaId), template, aspectRatio,
    productId: productId ? String(productId) : null,
    variantKind, campaignContextHash, paletteSource, creativeStyle
  });

  // V2 cache discipline: when a Director concept is supplied, only
  // serve cached entries whose directionConceptId matches. A legacy
  // V1 entry (directionConceptId: null) cached at the same cartesian
  // key must NOT serve a V2 request — and vice versa. The unique
  // index doesn't include directionConceptId yet (Phase 8 cleanup),
  // so the cache CHECK enforces the separation here.
  const isV2 = !!directionConcept;
  const v2ConceptId = directionConcept?.concept_id || null;

  if (!refresh) {
    const cached = await AiCanvasArtifact.findOne(filter).lean();
    const cachedMatchesMode = cached && (
      (isV2  && cached.directionConceptId === v2ConceptId) ||
      (!isV2 && (cached.directionConceptId == null))
    );
    if (cached && cachedMatchesMode && cached.specSchemaVersion === SPEC_SCHEMA_VERSION) {
      // Log the cache hit (0-cost) so per-(stage, cacheKey) hit-rate
      // metrics are accurate. Fire-and-forget — don't await; telemetry
      // can't block the render path.
      recordCacheHit({
        stage:       isV2 ? 'layout_generator' : 'legacy_ai_canvas_spec',
        provider:    'openai',
        model:       MODEL_ID,
        purposeTag:  template,
        brandId, mediaId, productId,
        cacheKey:    costCacheKey
      }).catch(() => {});
      // Phase 5a lazy backfill — when a render hits a cached AiCanvasArtifact
      // that doesn't yet have a ResolvedLayoutArtifact (pre-Phase-5a specs,
      // or shadows that failed on first generation), fire the Resolver
      // fire-and-forget. The resolver itself is also cache-keyed on
      // aiCanvasArtifactId so the second call hits cache instead of
      // re-resolving. Setting `refresh: false` (the default) means already
      // resolved specs are no-op.
      setImmediate(() => {
        const resolver = require('./layoutResolverService');
        resolver.resolveLayout({ aiCanvasArtifactId: cached._id })
          .then(({ cached: rCached }) => {
            if (!rCached) {
              console.log(`🧩 resolver backfill: aiCanvasArtifact=${cached._id}`);
            }
          })
          .catch(err => {
            console.warn(`   ⚠️  resolver backfill failed: ${err.message}`);
          });
      });
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

  // Phase 2 — when V2 (directionConcept provided), compress vision
  // attachments to 512×512 max via Cloudinary q_auto:eco transforms.
  // Cuts vision tokens ~70% (Lever 3) without measurable quality loss
  // for composition decisions.
  if (directionConcept && richContext?.images?.length) {
    const { compressVisionAttachments } = require('./aiCreativeV2Helpers');
    richContext = { ...richContext, images: compressVisionAttachments(richContext.images, 512) };
  }

  const { system, user } = buildPrompt({ input, template, aspectRatio, creativeStyle, richContext, directionConcept });
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

  // Phase 3 — multi-candidate generation. N=3 in V2 production, N=1 in
  // preview / V1. Run concurrently — wall-time is bounded by the slowest
  // call, not the sum. Temperature 0.9 + concurrent sampling gives real
  // variance across candidates.
  const effectiveN = isV2 && !previewMode ? Math.max(1, nCandidates) : 1;

  const oneGeneration = async (genIndex) => {
    const t0 = Date.now();
    const completion = await trackLlmCall(
      {
        stage:       isV2 ? 'layout_generator' : 'legacy_ai_canvas_spec',
        provider:    'openai',
        model:       MODEL_ID,
        purposeTag:  isV2 ? `v2:${v2ConceptId || 'unknown'}:cand${genIndex}` : template,
        brandId, mediaId, productId,
        visionImages: images.length,
        cacheKey:    costCacheKey
      },
      () => openai.chat.completions.create({
        model: MODEL_ID,
        response_format: { type: 'json_schema', json_schema: responseSchema },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: userContent }
        ],
        temperature: 0.9,
        max_tokens:  4000
      })
    );
    const elapsedMs = Date.now() - t0;
    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error(`OpenAI returned no content (cand ${genIndex})`);
    let spec;
    try { spec = JSON.parse(raw); }
    catch (err) { throw new Error(`OpenAI response not JSON (cand ${genIndex}): ${err.message}`); }
    const warnings = validateSpec(spec, aspectRatio);
    return { spec, raw, warnings, elapsedMs };
  };

  // Run candidates concurrently. Partial failures are tolerated when
  // effectiveN > 1 (the surviving candidates still get judged); single-
  // candidate failures rethrow as today.
  const results = await Promise.allSettled(
    Array.from({ length: effectiveN }, (_, i) => oneGeneration(i))
  );
  const successes = results.map((r, i) => ({ r, i })).filter(x => x.r.status === 'fulfilled');
  if (!successes.length) {
    // Every candidate failed — propagate the first error.
    const firstReject = results.find(r => r.status === 'rejected');
    throw firstReject?.reason || new Error('all candidate generations failed');
  }
  let candidates        = successes.map(s => s.r.value.spec);
  let candidateWarnings = successes.map(s => s.r.value.warnings);
  let candidateRaws     = successes.map(s => s.r.value.raw);
  const totalElapsedMs  = successes.reduce((m, s) => Math.max(m, s.r.value.elapsedMs), 0);

  // Pre-Judge hard-violation filter — drop candidates that declared a
  // social_proof_type strategy but emitted no proof-bearing zone. The
  // Generator has been ignoring the prompt-level CRITICAL rule for this
  // (Fix B), so we enforce it via selection pressure: the Judge never
  // sees the violators. If ALL candidates violate, we keep the full
  // pool (don't return empty) — better to render an imperfect ad than
  // none at all — but log loudly so we can see how often the prompt
  // alone fails to hold.
  if (candidates.length > 1) {
    const violationFlags = candidates.map(specViolatesProofStrategy);
    const violatorCount  = violationFlags.filter(Boolean).length;
    if (violatorCount > 0 && violatorCount < candidates.length) {
      const keepIdx = violationFlags.map((v, i) => v ? null : i).filter(i => i != null);
      console.log(
        `   ⛔ pre-Judge filter dropped ${violatorCount}/${candidates.length} candidates ` +
        `for proof-strategy violation (kept indices: ${keepIdx.join(',')})`
      );
      candidates        = keepIdx.map(i => candidates[i]);
      candidateWarnings = keepIdx.map(i => candidateWarnings[i]);
      candidateRaws     = keepIdx.map(i => candidateRaws[i]);
    } else if (violatorCount === candidates.length) {
      console.warn(
        `   ⚠️  pre-Judge filter: ALL ${candidates.length} candidates violate proof-strategy rule — ` +
        `keeping all (Judge will pick the least-bad). Generator prompt is failing this batch.`
      );
    }
  }

  // Phase 3 — Judge picks the winner among candidates. Single-candidate
  // mode auto-selects index 0 without an LLM call.
  let judgeOutcome = { winnerIndex: 0, rationale: null, confidence: null, judgeResultArtifactId: null, criteriaScores: [] };
  if (candidates.length > 1) {
    try {
      const judge = require('./aiJudgeService');
      // Pass the Director's input_summary + concept along so the Judge
      // can score strategy_fit + hierarchy_consistency against intent.
      let conceptForJudge   = directionConcept || null;
      let brandSignal       = null;
      let inputSummary      = null;
      if (directionArtifactId) {
        try {
          const dir = await CreativeDirectionArtifactSafe()?.findById(directionArtifactId).lean();
          if (dir) {
            inputSummary = dir.inputSummary || null;
            brandSignal  = dir.inputSummary?.brand_signal || null;
            if (!conceptForJudge && Array.isArray(dir.concepts)) {
              conceptForJudge = dir.concepts.find(c => c.concept_id === directionConcept?.concept_id) || dir.concepts[0];
            }
          }
        } catch (_) { /* judge can run without it */ }
      }
      judgeOutcome = await judge.judgeCandidates({
        candidates,
        concept:      conceptForJudge,
        inputSummary,
        brandSignal,
        brandId, productId,
        adId:         null  // Phase 3.1 will batch by adId
      });
    } catch (err) {
      console.warn(`   ⚠️  judge failed (${err.message}) — defaulting to candidate 0`);
    }
  }

  const winner          = candidates[judgeOutcome.winnerIndex] || candidates[0];
  const winnerWarnings  = candidateWarnings[judgeOutcome.winnerIndex] || candidateWarnings[0] || [];
  const winnerRaw       = candidateRaws[judgeOutcome.winnerIndex] || candidateRaws[0] || '';

  console.log(
    `🎨 aiCanvasSpec[${template}/${aspectRatio}/${creativeStyle}]: ` +
    `media=${mediaId} product=${productId || '-'} variant=${variantKind || '-'} ` +
    `cands=${candidates.length} winner=${judgeOutcome.winnerIndex} ` +
    `took=${totalElapsedMs}ms warnings=${winnerWarnings.length}`
  );

  // Persist. Replace any prior entry under the same key (refresh=true
  // path or schema-version mismatch from the cache check above).
  const artifact = await AiCanvasArtifact.findOneAndReplace(
    filter,
    {
      ...filter,
      advertiserId,
      brandId,
      canvasSpec:        winner,
      validationWarnings: winnerWarnings,
      modelId:           MODEL_ID,
      promptHash,
      promptSystem:      system,
      promptUser:        user,
      promptImages:      images.map(img => ({ role: img.role, url: img.url, label: img.label || null })),
      rawResponse:       winnerRaw,
      rationale:         winner.rationale || null,
      elementsUsed:      winner.elements_used  || [],
      elementsSkipped:   winner.elements_skipped || [],
      hierarchySpec:     winner.hierarchy_spec || null,
      directionArtifactId: directionArtifactId || null,
      directionConceptId:  directionConcept?.concept_id || null,
      // Phase 3 — store every candidate + winner pointer + judge link.
      candidates:        candidates.length > 1 ? candidates : [],
      candidateCount:    candidates.length,
      winnerSpecIndex:   judgeOutcome.winnerIndex,
      judgeResultId:    judgeOutcome.judgeResultArtifactId,
      judgeRationale:   judgeOutcome.rationale,
      judgeConfidence:  judgeOutcome.confidence,
      specSchemaVersion: SPEC_SCHEMA_VERSION,
      createdAt:         new Date()
    },
    { upsert: true, new: true, includeResultMetadata: false }
  );

  const resolvedInput = applyCopyPicks(inputWithCandidates, winner);

  // Phase 5a SHADOW — run the Resolver in the background. Persists a
  // ResolvedLayoutArtifact for this AiCanvasArtifact; renderer doesn't
  // consume it yet. Useful immediately as a diagnostic: spec preview
  // surfaces slot resolution + fallback chain decisions.
  // Fire-and-forget; failures don't affect the render path.
  setImmediate(() => {
    const resolver = require('./layoutResolverService');
    resolver.resolveLayout({ aiCanvasArtifactId: artifact._id })
      .then(({ artifact: rla, cached: rcCached }) => {
        const fbCount = (rla.fallbacksUsed || []).length;
        const wCount  = (rla.warnings      || []).length;
        console.log(
          `🧩 resolver shadow ${rcCached ? 'CACHE-HIT' : 'RESOLVED'}: ` +
          `aiCanvasArtifact=${artifact._id} status=${rla.resolutionStatus} ` +
          `fallbacks=${fbCount} warnings=${wCount}`
        );
      })
      .catch(err => {
        console.warn(`   ⚠️  resolver shadow failed: ${err.message}`);
      });
  });

  // Phase X.1 SHADOW — gpt-image-1 reference render. Opt-in via
  // AI_IMAGE_REFERENCE_ENABLED=true. Fires per AiCanvasArtifact;
  // dedup is handled inside the service (AiFullRenderArtifact's unique
  // index matches AiCanvasArtifact's). Renderer never reads this.
  setImmediate(() => {
    const imgRef = require('./aiImageReferenceService');
    if (!imgRef.enabled()) return;
    imgRef.generateForArtifact({ aiCanvasArtifactId: artifact._id })
      .then(out => {
        if (out.skipped) return;
        console.log(
          `🖼  image-ref shadow ${out.cached ? 'CACHE-HIT' : 'GENERATED'}: ` +
          `aiCanvasArtifact=${artifact._id}` +
          (out.artifact?.imageUrl ? ` url=${out.artifact.imageUrl}` : '')
        );
      })
      .catch(err => {
        console.warn(`   ⚠️  image-ref shadow failed: ${err.message}`);
      });
  });

  // Phase 6.1 / 6.5.1 — HTML Layout Generator is now driven eagerly by
  // renderService.ensureCanvasAndHtml before the renderer makes the
  // spec-vs-html branch decision. Removing the setImmediate shadow here
  // avoids a duplicate fire (eager call + setImmediate race) and the
  // associated CACHE-HIT logspam on warm cells. Non-render callers that
  // generate canvas specs without going through renderService (preview
  // page, spec preview UI) won't get HTML output via this path — they
  // already call generateForArtifact explicitly when they need it.

  return { spec: winner, cached: false, artifactId: String(artifact._id), warnings: winnerWarnings, resolvedInput };
}

// Lazy require — avoids circular dependency between
// aiCanvasSpecService and CreativeDirectionArtifact model load order.
function CreativeDirectionArtifactSafe() {
  try { return require('../models/CreativeDirectionArtifact'); }
  catch (_) { return null; }
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
