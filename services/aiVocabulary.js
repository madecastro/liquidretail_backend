// Phase 0 — locked vocabulary for the new AI creative pipeline.
//
// Source of truth for:
//   - ROLES               the 15 semantic roles a zone can play
//   - ZONE_KINDS          layout-primitive kinds (1:1 with roles in v1)
//   - COMPONENT_STYLE_BY_ROLE  the visual variants the renderer ships CSS for
//   - LEGACY_KIND_ALIASES backward compat for old AiCanvasArtifact specs
//   - ROLE_FALLBACK_CHAINS resolver downgrade order when constraints fail
//   - REQUIRED_PROPS_BY_ROLE_VARIANT  what data each variant needs to render
//
// Renderer derives CSS class names as `rs-<role>-<component_style>`. The
// LLM's Generator output uses `role` + `component_style`; everything else
// (zone_kind, CSS class) is derived deterministically downstream.

// ── Roles ─────────────────────────────────────────────────────────────
// 15 semantic roles. A zone has exactly one role.
const ROLES = Object.freeze([
  'headline',
  'hero_media',
  'quote',
  'comment',
  'stat',
  'rating',
  'cta',
  'offer',
  'eyebrow',
  'logo',
  'creator',
  'badges',
  'panel',
  'scrim',
  'product_card'
]);

// ── Zone kinds ────────────────────────────────────────────────────────
// v1: zone_kind = role. Kept as a separate constant so a future split
// (e.g., role=stat could allow kind=metrics_row OR kind=mini_stat_grid)
// has a clear extension point without breaking the contract.
const ZONE_KINDS = Object.freeze([...ROLES]);

// ── Component styles per role ─────────────────────────────────────────
// Each role lists its allowed component_style values. The Generator's
// JSON-schema response_format constrains zone.component_style to these
// (per role). New variants land by adding to this map + shipping the
// matching `.rs-<role>-<variant>` CSS rule.
const COMPONENT_STYLE_BY_ROLE = Object.freeze({
  headline: [
    'display_script',
    'section_header',
    'stacked_impact',
    'editorial_serif',
    'social_caption_headline'
  ],
  hero_media: [
    'raw_media',
    'rounded_story_frame',
    'full_bleed_editorial',
    'polaroid_stack',
    'split_product_scene'
  ],
  quote: [
    'base',
    'with_author_photo',
    'featured_testimonial',
    'receipt_review',
    'review_stack'
  ],
  comment: [
    'ig',
    'tiktok',
    'chat_bubble',
    'creator_reply',
    'comment_overlay_chip'
  ],
  stat: [
    'metrics_row',
    'metric_chips',
    'proof_counter',
    'mini_stat_grid'
  ],
  rating: [
    'with_verified_buyers',
    'star_row',
    'rating_pill',
    'review_score_card'
  ],
  cta: [
    'pill_button',
    'floating_shop_chip',
    'full_width_action_bar',
    'editorial_link',
    'commerce_button_with_price'
  ],
  offer: [
    'offer_pill',
    'corner_tag',
    'discount_burst',
    'ribbon_banner'
  ],
  eyebrow: [
    'bookend_rules',
    'capsule_label',
    'overline',
    'platform_kicker'
  ],
  logo: [
    'base_logo',
    'logo_pill',
    'watermark',
    'brand_lockup_card'
  ],
  creator: [
    'identity_row',
    'creator_chip',
    'creator_footer',
    'ugc_byline'
  ],
  badges: [
    'base',
    'callouts',
    'trust_badges',
    'category_badges',
    'platform_badges'
  ],
  panel: [
    'solid_surface',
    'glass_panel',
    'editorial_card',
    'gradient_panel',
    'border_only_panel'
  ],
  scrim: [
    'linear_gradient_scrim',
    'radial_spotlight_scrim',
    'edge_fade_scrim',
    'solid_tint_scrim'
  ],
  product_card: [
    'with_thumbnail_stacked',
    'floating_product_card',
    'catalog_tile',
    'hero_cutout',
    'compact_inline_product'
  ]
});

// ── Legacy kind aliases ───────────────────────────────────────────────
// Existing AiCanvasArtifacts (specSchemaVersion 2.x) use the old kind
// names. Renderer falls back to these mappings when it sees an old kind.
// Phase 8 removes the legacy path; until then, both vocabularies render.
const LEGACY_KIND_ALIASES = Object.freeze({
  media:         'hero_media',
  text:          'headline',       // text + style_variant: display_script → headline
  quote_card:    'quote',
  comment_card:  'comment',
  proof_bar:     'rating',
  badge_row:     'badges',
  eyebrow_rules: 'eyebrow',
  metrics_row:   'stat',
  identity_row:  'creator',
  review_stack:  'quote'           // component_style: review_stack
  // 'panel', 'logo', 'cta', 'product_card' map unchanged → no entry
});

// ── Resolver fallback chains ──────────────────────────────────────────
// When a chosen role+variant fails constraint checks (missing prop,
// not enough space, contrast fail, ratio incompatible) the Resolver
// walks this chain. Each entry is either another component_style for
// the same role, or 'remove' (drop the zone).
//
// Example: featured_testimonial needs an author and ~5 lines of text.
// If no author present → fall to 'base' (works without author).
// If space is too small → fall to comment_overlay_chip.
// If no quote text at all → 'remove'.
const ROLE_FALLBACK_CHAINS = Object.freeze({
  quote: {
    featured_testimonial: ['base', 'comment_overlay_chip', 'remove'],
    with_author_photo:    ['base', 'comment_overlay_chip', 'remove'],
    receipt_review:       ['base', 'remove'],
    review_stack:         ['base', 'remove'],
    base:                 ['remove']
  },
  comment: {
    creator_reply:        ['ig', 'comment_overlay_chip', 'remove'],
    chat_bubble:          ['ig', 'comment_overlay_chip', 'remove'],
    tiktok:               ['ig', 'remove'],
    ig:                   ['comment_overlay_chip', 'remove'],
    comment_overlay_chip: ['remove']
  },
  cta: {
    commerce_button_with_price: ['pill_button', 'remove'],
    floating_shop_chip:         ['pill_button', 'remove'],
    full_width_action_bar:      ['pill_button', 'remove'],
    editorial_link:             ['pill_button', 'remove'],
    pill_button:                ['remove']
  },
  rating: {
    review_score_card:    ['with_verified_buyers', 'star_row', 'rating_pill', 'remove'],
    with_verified_buyers: ['star_row', 'rating_pill', 'remove'],
    star_row:             ['rating_pill', 'remove'],
    rating_pill:          ['remove']
  },
  stat: {
    proof_counter:  ['metric_chips', 'metrics_row', 'remove'],
    metrics_row:    ['metric_chips', 'remove'],
    mini_stat_grid: ['metric_chips', 'remove'],
    metric_chips:   ['remove']
  },
  product_card: {
    catalog_tile:           ['with_thumbnail_stacked', 'compact_inline_product', 'remove'],
    floating_product_card:  ['with_thumbnail_stacked', 'compact_inline_product', 'remove'],
    hero_cutout:            ['with_thumbnail_stacked', 'remove'],
    with_thumbnail_stacked: ['compact_inline_product', 'remove'],
    compact_inline_product: ['remove']
  }
  // Roles with no chain default to 'remove' on failure (handled in
  // resolveFallback below).
});

// ── Required props per role+variant ───────────────────────────────────
// Resolver checks these against the resolved input. A required prop
// missing triggers fallback chain walk.
const REQUIRED_PROPS_BY_ROLE_VARIANT = Object.freeze({
  headline: {
    display_script:          ['text'],
    section_header:          ['text'],
    stacked_impact:          ['text'],
    editorial_serif:         ['text'],
    social_caption_headline: ['text']
  },
  hero_media: {
    raw_media:             ['mediaUrl'],
    rounded_story_frame:   ['mediaUrl'],
    full_bleed_editorial:  ['mediaUrl'],
    polaroid_stack:        ['mediaItems'],      // array
    split_product_scene:   ['productMediaUrl', 'postMediaUrl']
  },
  quote: {
    base:                 ['text'],
    with_author_photo:    ['text', 'author'],
    featured_testimonial: ['text', 'author'],
    receipt_review:       ['text', 'author'],
    review_stack:         ['reviews']           // array of {text, author?}
  },
  comment: {
    ig:                   ['text', 'authorHandle'],
    tiktok:               ['text', 'authorHandle'],
    chat_bubble:          ['text'],
    creator_reply:        ['text', 'authorHandle'],
    comment_overlay_chip: ['text']
  },
  stat: {
    metrics_row:    ['metrics'],
    metric_chips:   ['metrics'],
    proof_counter:  ['value', 'label'],
    mini_stat_grid: ['metrics']
  },
  rating: {
    with_verified_buyers: ['rating'],
    star_row:             ['rating'],
    rating_pill:          ['rating'],
    review_score_card:    ['rating', 'reviewCount']
  },
  cta: {
    pill_button:                ['text'],
    floating_shop_chip:         ['text'],
    full_width_action_bar:      ['text'],
    editorial_link:             ['text'],
    commerce_button_with_price: ['text', 'price']
  },
  offer: {
    offer_pill:       ['label'],
    corner_tag:       ['label'],
    discount_burst:   ['label'],
    ribbon_banner:    ['label']
  },
  eyebrow: {
    bookend_rules:    ['text'],
    capsule_label:    ['text'],
    overline:         ['text'],
    platform_kicker:  ['text']
  },
  logo: {
    base_logo:         ['logoUrl'],
    logo_pill:         ['logoUrl'],
    watermark:         ['logoUrl'],
    brand_lockup_card: ['logoUrl', 'brandName']
  },
  creator: {
    identity_row:  ['handle'],
    creator_chip:  ['handle'],
    creator_footer:['handle'],
    ugc_byline:    ['handle']
  },
  badges: {
    base:            ['badges'],
    callouts:        ['badges'],
    trust_badges:    ['badges'],
    category_badges: ['badges'],
    platform_badges: ['platforms']
  },
  panel: {
    solid_surface:     [],
    glass_panel:       [],
    editorial_card:    [],
    gradient_panel:    [],
    border_only_panel: []
  },
  scrim: {
    linear_gradient_scrim:  [],
    radial_spotlight_scrim: [],
    edge_fade_scrim:        [],
    solid_tint_scrim:       []
  },
  product_card: {
    with_thumbnail_stacked: ['imageUrl', 'name'],
    floating_product_card:  ['imageUrl', 'name'],
    catalog_tile:           ['imageUrl', 'name', 'price'],
    hero_cutout:            ['imageUrl'],
    compact_inline_product: ['name']
  }
});

// ── Helpers ───────────────────────────────────────────────────────────

function isValidRole(role) {
  return ROLES.includes(role);
}

function isValidComponentStyle(role, componentStyle) {
  const list = COMPONENT_STYLE_BY_ROLE[role];
  return Array.isArray(list) && list.includes(componentStyle);
}

// Map an old (pre-vocabulary-lock) zone kind to the new role. Used by
// the renderer when reading legacy AiCanvasArtifacts. Returns null when
// no mapping exists (unknown kind).
function legacyKindToRole(legacyKind) {
  return LEGACY_KIND_ALIASES[legacyKind] || null;
}

// CSS class name the renderer paints: `rs-<role>-<component_style>`.
// (Plus the legacy `tp-zone kind-<kind>.style-<variant>` classes are
// kept on the same element for backward CSS compat through Phase 5.)
function cssClassFor(role, componentStyle) {
  if (!role || !componentStyle) return '';
  return `rs-${role.replace(/_/g, '-')}-${componentStyle.replace(/_/g, '-')}`;
}

// Walk the role's fallback chain looking for a variant whose required
// props are all present. Returns { componentStyle, downgraded: boolean }
// — when no chain entry resolves, returns { componentStyle: null,
// downgraded: true, removed: true }.
function resolveFallback({ role, componentStyle, resolvedProps }) {
  // Initial pass — does the chosen variant work?
  if (hasRequiredProps(role, componentStyle, resolvedProps)) {
    return { componentStyle, downgraded: false };
  }
  // Walk the chain.
  const chain = ROLE_FALLBACK_CHAINS[role]?.[componentStyle] || ['remove'];
  for (const step of chain) {
    if (step === 'remove') return { componentStyle: null, downgraded: true, removed: true };
    if (hasRequiredProps(role, step, resolvedProps)) {
      return { componentStyle: step, downgraded: true };
    }
  }
  return { componentStyle: null, downgraded: true, removed: true };
}

function hasRequiredProps(role, componentStyle, resolvedProps) {
  const required = REQUIRED_PROPS_BY_ROLE_VARIANT[role]?.[componentStyle];
  if (!Array.isArray(required)) return true;   // unknown role/variant → permissive
  for (const prop of required) {
    const v = resolvedProps?.[prop];
    if (v == null) return false;
    if (typeof v === 'string' && v.trim() === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
  }
  return true;
}

module.exports = {
  ROLES,
  ZONE_KINDS,
  COMPONENT_STYLE_BY_ROLE,
  LEGACY_KIND_ALIASES,
  ROLE_FALLBACK_CHAINS,
  REQUIRED_PROPS_BY_ROLE_VARIANT,
  isValidRole,
  isValidComponentStyle,
  legacyKindToRole,
  cssClassFor,
  resolveFallback,
  hasRequiredProps
};
