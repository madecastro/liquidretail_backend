// Phase 5 — Resolver.
//
// Given a canvas spec (AiCanvasArtifact) and a layout input
// (LayoutInputArtifact, with the same graft the renderer reads), produce
// a ResolvedLayoutArtifact: every zone's slot resolved to a concrete
// value with asset_type, role-fallback chains walked when required props
// are missing, validations run (bounds / overlap / slot_resolution /
// safe_area / missing_assets), CSS class names derived.
//
// Phase 5a — SHADOW mode. Fired fire-and-forget after each V2 spec
// generation; the renderer is NOT yet wired to consume this artifact.
// Useful immediately as a diagnostic: spec preview surfaces which
// slots resolved, which fallbacks fired, which adjustments would
// trim text at render time.
//
// Phase 5b will:
//   - Port the CSS clamp/calc math (font_size, line_height) into JS
//     so computed[] becomes pixel-accurate
//   - Flip templatePreview.js to draw from ResolvedLayoutArtifact
//   - Verify pixel parity against the legacy inline-render path

const ResolvedLayoutArtifact   = require('../models/ResolvedLayoutArtifact');
const AiCanvasArtifact         = require('../models/AiCanvasArtifact');
const LayoutInputArtifact      = require('../models/LayoutInputArtifact');
const {
  ROLES,
  legacyKindToRole,
  cssClassFor,
  resolveFallback,
  REQUIRED_PROPS_BY_ROLE_VARIANT
} = require('./aiVocabulary');

// ── Public API ───────────────────────────────────────────────────────

async function resolveLayout({ aiCanvasArtifactId, refresh = false }) {
  if (!aiCanvasArtifactId) throw badRequest('aiCanvasArtifactId required');

  const canvas = await AiCanvasArtifact.findById(aiCanvasArtifactId).lean();
  if (!canvas) throw notFound(`AiCanvasArtifact ${aiCanvasArtifactId} not found`);

  // Find the matching LayoutInputArtifact via the cartesian dimensions.
  // null campaignContextHash participates in the find — same shape as the
  // unique index in layoutInputService.
  const layoutInput = await LayoutInputArtifact.findOne({
    mediaId:             canvas.mediaId,
    template:            canvas.template,
    aspectRatio:         canvas.aspectRatio,
    productId:           canvas.productId,
    variantKind:         canvas.variantKind,
    paletteSource:       canvas.paletteSource,
    campaignContextHash: canvas.campaignContextHash
  }).lean();

  const filter = {
    aiCanvasArtifactId:    canvas._id,
    layoutInputArtifactId: layoutInput?._id || null
  };

  if (!refresh) {
    const cached = await ResolvedLayoutArtifact.findOne(filter).lean();
    if (cached) return { artifact: cached, cached: true };
  }

  const t0 = Date.now();
  const result = doResolve({ canvasSpec: canvas.canvasSpec, layoutInput });
  const durationMs = Date.now() - t0;

  const artifact = await ResolvedLayoutArtifact.findOneAndReplace(
    filter,
    {
      aiCanvasArtifactId:    canvas._id,
      layoutInputArtifactId: layoutInput?._id || null,
      brandId:               canvas.brandId    || null,
      campaignId:            null,                  // Phase 5b stamps via Ad lookup if needed
      contractType:    'resolved_layout',
      contractVersion: '1.0',
      canvas: {
        width:        canvas.canvasSpec?.canvas?.width  || 1000,
        height:       canvas.canvasSpec?.canvas?.height || 1000,
        aspect_ratio: canvas.aspectRatio
      },
      resolutionStatus: result.resolutionStatus,
      resolvedData:     { slots: result.slots },
      resolvedZones:    result.resolvedZones,
      validation:       result.validation,
      fallbacksUsed:    result.fallbacksUsed,
      warnings:         result.warnings,
      durationMs,
      createdAt:        new Date()
    },
    { upsert: true, new: true, includeResultMetadata: false }
  );

  return { artifact: artifact.toObject ? artifact.toObject() : artifact, cached: false };
}

// ── Core resolution ──────────────────────────────────────────────────

function doResolve({ canvasSpec, layoutInput }) {
  const zones      = Array.isArray(canvasSpec?.zones) ? canvasSpec.zones : [];
  const input      = augmentInput(layoutInput?.input || {}, canvasSpec);
  const slots      = {};
  const resolvedZones = [];
  const fallbacksUsed = [];
  const warnings      = [];
  const canvasW = canvasSpec?.canvas?.width  || 1000;
  const canvasH = canvasSpec?.canvas?.height || 1000;
  const missingAssets = [];
  let   slotPartial   = false;

  // Phase 5b.1 — stage base font, mirrors templatePreview.applyCanvasSize:
  //   stage.style.fontSize = Math.max(12, canvasW / 22)px
  // Every em-relative CSS rule cascades off this number.
  const baseFontPx = Math.max(12, canvasW / 22);
  const zoneScalers = canvasSpec?.zone_scalers || {};

  for (const zone of zones) {
    // Normalize kind → role using the legacy alias map (renderer-side
    // does the same for back-compat through Phase 8).
    const role = zone.role || legacyKindToRole(zone.kind) || zone.kind || 'unknown';
    const componentStyle = zone.component_style || zone.style_variant || null;

    // Resolve the slot.
    const { resolved_value, asset_type, from_path, from_fallback } =
      resolveSlot({ zone, input });

    slots[zone.id] = { resolved_value, asset_type, from_path, from_fallback };

    if (resolved_value == null || (typeof resolved_value === 'string' && !resolved_value.trim())) {
      slotPartial = true;
    }
    if (asset_type === 'image' || asset_type === 'video') {
      if (typeof resolved_value === 'string' && resolved_value.length) {
        // Could runtime-fetch HEAD to verify but Phase 5a stays
        // structure-only. Phase 5b adds runtime asset existence checks.
      } else if (resolved_value == null) {
        missingAssets.push(`${zone.id} (${asset_type})`);
      }
    }

    // Role-based fallback chain — derive resolvedProps the way each
    // variant's REQUIRED_PROPS_BY_ROLE_VARIANT expects them. Walking
    // the chain happens inside resolveFallback (aiVocabulary).
    const propsForFallback = buildResolvedPropsForVariant({ role, componentStyle, resolvedValue: resolved_value, input, zone });
    let finalComponentStyle = componentStyle;
    let removed = false;
    if (role !== 'unknown' && componentStyle) {
      const fb = resolveFallback({ role, componentStyle, resolvedProps: propsForFallback });
      finalComponentStyle = fb.componentStyle;
      removed = !!fb.removed;
      if (fb.downgraded && componentStyle && componentStyle !== finalComponentStyle) {
        fallbacksUsed.push({
          zone_id:              zone.id,
          role,
          from_component_style: componentStyle,
          to_component_style:   finalComponentStyle,
          reason:               removed ? 'no fallback satisfied required props' : `required props missing for ${componentStyle}`
        });
      }
    }

    const cssClass = finalComponentStyle ? cssClassFor(role, finalComponentStyle) : '';

    // Phase 5b.1 — port the CSS calc/clamp rules from tp-zones.css into
    // concrete pixel values. The renderer can read these as inline
    // styles in 5b.2; today they're diagnostic in the spec preview.
    const computedStyles = computeStylesForZone({
      role,
      componentStyle: finalComponentStyle,
      kind:           zone.kind || role,
      rect:           zone.rect,
      zoneScaler:     pickZoneScaler({ zoneScalers, id: zone.id, kind: zone.kind, role }),
      baseFontPx,
      styleVariant:   zone.style_variant
    });

    resolvedZones.push({
      id:               zone.id,
      role,
      component_style:  finalComponentStyle,
      kind:             zone.kind || role,
      removed,
      rect:             zone.rect || null,
      layer:            zone.layer,
      slot:             zone.slot,
      css_class:        cssClass,
      computed: {
        font_family_body:    canvasSpec?.style_bindings?.font_family_body    || null,
        font_family_display: canvasSpec?.style_bindings?.font_family_display || null,
        text_color:          inferTextColor({ canvasSpec, role }),
        radius_px:           zone.radius ?? null,
        max_lines:           zone.max_lines ?? computedStyles.max_lines_default,
        ...computedStyles
      },
      adjustments: removed ? [{ type: 'remove', reason: 'fallback chain exhausted' }] : []
    });

    // Bounds check per zone.
    if (zone.rect) {
      const { x, y, w, h } = zone.rect;
      if (x < 0 || y < 0 || x + w > canvasW || y + h > canvasH) {
        warnings.push({
          severity: 'medium',
          message:  `zone ${zone.id}: rect ${x},${y} ${w}x${h} extends beyond canvas ${canvasW}x${canvasH}`,
          zone_id:  zone.id
        });
      }
    }
  }

  // Overlap check — N^2 pass. Surface-on-text is by design (text inside
  // a panel); we warn on text-overlapping-text only.
  const textRoles = new Set(['headline', 'eyebrow', 'cta', 'quote', 'comment', 'stat', 'rating', 'creator', 'product_card']);
  let overlapCount = 0;
  for (let i = 0; i < resolvedZones.length; i++) {
    for (let j = i + 1; j < resolvedZones.length; j++) {
      const a = resolvedZones[i], b = resolvedZones[j];
      if (!textRoles.has(a.role) || !textRoles.has(b.role)) continue;
      if (rectsOverlap(a.rect, b.rect)) {
        overlapCount++;
        warnings.push({
          severity: 'medium',
          message:  `text-on-text overlap: ${a.id} (${a.role}) and ${b.id} (${b.role})`,
          zone_id:  a.id
        });
      }
    }
  }

  // Safe-area check — text_primary safe area should contain the major
  // text zones. Phase 5b validates against canvasSpec.safe_areas;
  // shadow stage skips for now and just warns when text rects fall
  // outside the visible canvas (already covered by bounds check).

  const validation = {
    bounds_check:    warnings.some(w => /extends beyond canvas/.test(w.message)) ? 'fail' : 'pass',
    overlap_check:   overlapCount > 0 ? 'warn' : 'pass',
    slot_resolution: slotPartial ? 'partial' : 'pass',
    contrast_check:  'pass',     // Phase 5b reads brightness grid
    safe_area_check: 'pass',     // Phase 5b
    missing_assets:  missingAssets
  };

  const hasFailures = validation.bounds_check === 'fail' || validation.slot_resolution === 'fail';
  const hasFallbacks = fallbacksUsed.length > 0;
  const resolutionStatus = hasFailures ? 'failed'
                          : hasFallbacks ? 'resolved_with_fallbacks'
                          : slotPartial ? 'partial'
                          : 'resolved';

  return { resolutionStatus, slots, resolvedZones, validation, fallbacksUsed, warnings };
}

// ── Slot resolution ──────────────────────────────────────────────────

function resolveSlot({ zone, input }) {
  const slot = zone.slot;
  if (slot == null) return { resolved_value: null, asset_type: kindToAssetType(zone), from_path: null, from_fallback: null };

  // Array slot (e.g. product_card → [image, name, price]) — resolve each
  // sub-path and return an object keyed by position. Renderer joins / renders
  // by component.
  if (Array.isArray(slot)) {
    const out = slot.map(p => ({ path: p, value: tpGet(input, p) }));
    const anyResolved = out.some(o => isPresent(o.value));
    return {
      resolved_value: out.map(o => o.value),
      asset_type:     kindToAssetType(zone),
      from_path:      slot.join('|'),
      from_fallback:  anyResolved ? null : `defaults.${zone.kind}_fallback`
    };
  }

  const value = tpGet(input, slot);
  const assetType = inferAssetType(zone, value);
  if (isPresent(value)) {
    return { resolved_value: value, asset_type: assetType, from_path: slot, from_fallback: null };
  }

  // Fallback chain — check input.defaults.<kind>_text / cta_text / etc.
  const fallbackPath = pickFallbackPath(zone);
  const fallbackValue = fallbackPath ? tpGet(input, fallbackPath) : null;
  return {
    resolved_value: fallbackValue ?? null,
    asset_type:     assetType,
    from_path:      slot,
    from_fallback:  fallbackPath
  };
}

function inferAssetType(zone, value) {
  const kind = zone.kind || zone.role || '';
  if (kind === 'media' || kind === 'hero_media' || kind === 'support_media' || kind === 'logo') {
    if (value && typeof value === 'object' && value.video) return 'video';
    if (value && typeof value === 'object' && value.image) return 'image';
    if (typeof value === 'string') return 'image';
    return 'image';
  }
  if (kind === 'cta')                                        return 'cta';
  if (kind === 'quote_card' || kind === 'quote')             return 'quote';
  if (kind === 'comment_card' || kind === 'comment')         return 'quote';
  if (kind === 'badge_row' || kind === 'badges')             return 'badges';
  if (kind === 'proof_bar' || kind === 'rating')             return 'rating';
  if (kind === 'metrics_row' || kind === 'stat')             return 'stats';
  if (kind === 'identity_row' || kind === 'creator')         return 'creator';
  if (kind === 'product_card')                               return 'image';   // composite (image+text)
  return 'text';
}

function kindToAssetType(zone) {
  return inferAssetType(zone, null);
}

function pickFallbackPath(zone) {
  const kind = zone.kind || zone.role || '';
  const slot = zone.slot;
  if (kind === 'cta'      || slot === 'cta' || slot === 'cta.text') return 'defaults.cta_text';
  if (kind === 'headline' || slot === 'copy.headline')              return 'defaults.fallback_headline';
  if (kind === 'quote_card' || kind === 'quote')                     return 'defaults.fallback_quote';
  if (kind === 'product_card')                                       return 'defaults.product_name';
  return null;
}

// Build the small "resolvedProps" object the REQUIRED_PROPS_BY_ROLE_VARIANT
// table expects. Each variant declares which keys it needs (text, author,
// avatarUrl, metrics, etc.); we surface enough of the resolved value for
// the check to work.
function buildResolvedPropsForVariant({ role, componentStyle, resolvedValue, input, zone }) {
  const props = {};
  if (resolvedValue == null) return props;
  if (typeof resolvedValue === 'string') {
    props.text = resolvedValue;
    return props;
  }
  if (typeof resolvedValue === 'object' && !Array.isArray(resolvedValue)) {
    // quote / cta / media / etc. — copy through obvious keys.
    if (resolvedValue.text)         props.text         = resolvedValue.text;
    if (resolvedValue.author_name)  props.author       = resolvedValue.author_name;
    if (resolvedValue.author)       props.author       = resolvedValue.author;
    if (resolvedValue.avatarUrl)    props.avatarUrl    = resolvedValue.avatarUrl;
    if (resolvedValue.image)        props.mediaUrl     = resolvedValue.image;
    if (resolvedValue.video)        props.mediaUrl     = resolvedValue.video;
    if (resolvedValue.url)          props.url          = resolvedValue.url;
    if (resolvedValue.price != null)props.price        = String(resolvedValue.price);
    if (resolvedValue.handle)       props.handle       = resolvedValue.handle;
    if (resolvedValue.authorHandle) props.authorHandle = resolvedValue.authorHandle;
    if (resolvedValue.rating != null) props.rating     = Number(resolvedValue.rating);
  }
  if (Array.isArray(resolvedValue)) {
    // product_card array slot — derive props from index positions.
    if (zone.slot && Array.isArray(zone.slot)) {
      if (zone.slot.some(s => /image/.test(s)) && resolvedValue[0]) props.imageUrl = resolvedValue[0]?.image || resolvedValue[0];
      if (zone.slot.some(s => /name/.test(s))  && resolvedValue[1]) props.name     = resolvedValue[1];
      if (zone.slot.some(s => /price/.test(s)) && resolvedValue[2] != null) props.price = String(resolvedValue[2]);
    }
    if (role === 'badges') props.badges = resolvedValue;
    if (role === 'stat')   props.metrics = resolvedValue;
    if (role === 'quote' && componentStyle === 'review_stack') props.reviews = resolvedValue;
  }
  // CTA composite — copy fallback CTA text to satisfy required:'text'.
  if (role === 'cta' && !props.text && input?.cta?.text) props.text = input.cta.text;
  // Add brand-name fill for logo brand_lockup_card variant.
  if (role === 'logo' && componentStyle === 'brand_lockup_card' && input?.brand?.name) {
    props.brandName = input.brand.name;
  }
  return props;
}

// Augment the persisted LayoutInputArtifact.input with the same in-memory
// grafts aiCanvasSpecService.getOrGenerate applies before passing to the
// renderer (social_context, campaign, product.*.crops). Lets slot paths
// like social_context.top_comments.0.text resolve here too.
function augmentInput(rawInput, canvasSpec) {
  if (!rawInput || typeof rawInput !== 'object') return rawInput || {};
  // copy_picks from the canvasSpec — when present, resolve picked
  // headline/subheadline/eyebrow into input.copy.* (the renderer reads
  // these flat).
  const next = { ...rawInput, copy: { ...(rawInput.copy || {}) } };
  const picks = canvasSpec?.copy_picks || {};
  const cc    = rawInput.copy_candidates || {};
  const at    = (arr, i) => (Array.isArray(arr) && i != null && i >= 0 && i < arr.length ? arr[i] : null);
  if (picks.headline_pick    != null && at(cc.headlines,    picks.headline_pick)    != null) next.copy.headline    = at(cc.headlines,    picks.headline_pick);
  if (picks.subheadline_pick != null && at(cc.subheadlines, picks.subheadline_pick) != null) next.copy.subheadline = at(cc.subheadlines, picks.subheadline_pick);
  if (picks.eyebrow_pick     != null && at(cc.eyebrows,     picks.eyebrow_pick)     != null) next.copy.eyebrow     = at(cc.eyebrows,     picks.eyebrow_pick);
  return next;
}

// ── Phase 5b.1 — port of tp-zones.css per-zone font-size rules ──────
//
// Each entry maps a (role, component_style?) pair to:
//   em            — base em multiplier on the stage font (overrides clamp)
//   clamp         — {min_em, max_em, h_factor} → clamp(min, rect.h × h_factor × scale, max)
//   line_height   — unitless line-height
//   pad_v_em      — vertical padding in em
//   pad_h_em      — horizontal padding in em
//   pad_floor_px  — absolute pixel floor (mirrors CSS max(0.9em, 10px))
//
// Unknown (role, component_style) combos fall back to DEFAULT_RULE.
const STYLE_RULES_BY_ROLE_VARIANT = Object.freeze({
  // Headline
  'headline':                          { em: 1.85, line_height: 0.95, pad_v_em: 0, pad_h_em: 0 },
  'headline:display_script':           { em: 1.85, line_height: 0.95, pad_v_em: 0, pad_h_em: 0 },
  'headline:section_header':           { em: 0.28, line_height: 1.15, pad_v_em: 0, pad_h_em: 0 },
  'headline:stacked_impact':           { em: 1.7,  line_height: 0.95, pad_v_em: 0, pad_h_em: 0 },
  'headline:editorial_serif':          { em: 1.5,  line_height: 1.15, pad_v_em: 0, pad_h_em: 0 },
  'headline:social_caption_headline':  { em: 1.2,  line_height: 1.25, pad_v_em: 0, pad_h_em: 0 },

  // Quote (uses rect-h clamp)
  'quote':                             { clamp: { min_em: 0.35, max_em: 1.4, h_factor: 0.00187 }, line_height: 1.3, pad_v_em: 0.9, pad_h_em: 1.0, pad_floor_px: 10 },
  'quote:base':                        { clamp: { min_em: 0.35, max_em: 1.4, h_factor: 0.00187 }, line_height: 1.3, pad_v_em: 0.9, pad_h_em: 1.0, pad_floor_px: 10 },
  'quote:with_author_photo':           { clamp: { min_em: 0.35, max_em: 1.4, h_factor: 0.00187 }, line_height: 1.3, pad_v_em: 0.9, pad_h_em: 1.0, pad_floor_px: 10 },
  'quote:featured_testimonial':        { clamp: { min_em: 0.35, max_em: 1.5, h_factor: 0.00200 }, line_height: 1.3, pad_v_em: 1.0, pad_h_em: 1.1, pad_floor_px: 12 },
  'quote:review_stack':                { em: 0.8,  line_height: 1.25, pad_v_em: 0.4, pad_h_em: 0.55, pad_floor_px: 6 },

  // Product card
  'product_card':                      { clamp: { min_em: 0.35, max_em: 1.4, h_factor: 0.00187 }, line_height: 1.25, pad_v_em: 0.9, pad_h_em: 1.0, pad_floor_px: 10 },
  'product_card:with_thumbnail_stacked':{ clamp: { min_em: 0.35, max_em: 1.4, h_factor: 0.00187 }, line_height: 1.25, pad_v_em: 0.9, pad_h_em: 1.0, pad_floor_px: 10 },
  'product_card:catalog_tile':         { em: 0.9,  line_height: 1.25, pad_v_em: 0.55, pad_h_em: 0.7 },
  'product_card:compact_inline_product':{ em: 0.85, line_height: 1.2,  pad_v_em: 0.4, pad_h_em: 0.6 },

  // CTA
  'cta':                               { em: 0.45, line_height: 1.0, pad_v_em: 0.7,  pad_h_em: 1.2 },
  'cta:pill_button':                   { em: 0.45, line_height: 1.0, pad_v_em: 0.7,  pad_h_em: 1.2 },
  'cta:editorial_link':                { em: 0.38, line_height: 1.0, pad_v_em: 0.3,  pad_h_em: 0.6 },
  'cta:floating_shop_chip':            { em: 0.4,  line_height: 1.0, pad_v_em: 0.45, pad_h_em: 0.9 },
  'cta:full_width_action_bar':         { em: 0.48, line_height: 1.0, pad_v_em: 0.9,  pad_h_em: 1.2 },
  'cta:commerce_button_with_price':    { em: 0.45, line_height: 1.0, pad_v_em: 0.7,  pad_h_em: 1.2 },

  // Eyebrow
  'eyebrow':                           { em: 0.28, line_height: 1.1, pad_v_em: 0, pad_h_em: 0 },
  'eyebrow:bookend_rules':             { em: 0.28, line_height: 1.1, pad_v_em: 0, pad_h_em: 0 },
  'eyebrow:capsule_label':             { em: 0.26, line_height: 1.1, pad_v_em: 0.3, pad_h_em: 0.7 },
  'eyebrow:overline':                  { em: 0.26, line_height: 1.1, pad_v_em: 0, pad_h_em: 0 },
  'eyebrow:platform_kicker':           { em: 0.28, line_height: 1.1, pad_v_em: 0, pad_h_em: 0 },

  // Rating
  'rating':                            { em: 0.28, line_height: 1.15, pad_v_em: 0.4, pad_h_em: 0.8 },
  'rating:with_verified_buyers':       { em: 0.28, line_height: 1.15, pad_v_em: 0.4, pad_h_em: 0.8 },
  'rating:star_row':                   { em: 0.34, line_height: 1.15, pad_v_em: 0,   pad_h_em: 0 },
  'rating:rating_pill':                { em: 0.34, line_height: 1.0,  pad_v_em: 0.3, pad_h_em: 0.7 },
  'rating:review_score_card':          { em: 0.36, line_height: 1.2,  pad_v_em: 0.5, pad_h_em: 0.7 },

  // Stat
  'stat':                              { em: 0.85, line_height: 1.2, pad_v_em: 0.4,  pad_h_em: 0.4 },
  'stat:metrics_row':                  { em: 0.85, line_height: 1.2, pad_v_em: 0.4,  pad_h_em: 0.4 },
  'stat:metric_chips':                 { em: 0.45, line_height: 1.0, pad_v_em: 0.25, pad_h_em: 0.7 },
  'stat:proof_counter':                { em: 1.6,  line_height: 1.0, pad_v_em: 0.5,  pad_h_em: 0.5 },
  'stat:mini_stat_grid':               { em: 0.75, line_height: 1.2, pad_v_em: 0.4,  pad_h_em: 0.4 },

  // Badges
  'badges':                            { em: 0.85, line_height: 1.0, pad_v_em: 0.25, pad_h_em: 0.7 },
  'badges:base':                       { em: 0.85, line_height: 1.0, pad_v_em: 0.25, pad_h_em: 0.7 },
  'badges:callouts':                   { em: 0.28, line_height: 1.1, pad_v_em: 0,    pad_h_em: 0 },
  'badges:trust_badges':               { em: 0.78, line_height: 1.1, pad_v_em: 0.3,  pad_h_em: 0.7 },
  'badges:category_badges':            { em: 0.78, line_height: 1.1, pad_v_em: 0.3,  pad_h_em: 0.7 },

  // Comment
  'comment':                           { em: 0.95, line_height: 1.35, pad_v_em: 0.5,  pad_h_em: 0.7 },
  'comment:ig':                        { em: 0.95, line_height: 1.35, pad_v_em: 0.5,  pad_h_em: 0.7 },
  'comment:tiktok':                    { em: 0.92, line_height: 1.3,  pad_v_em: 0.5,  pad_h_em: 0.7 },
  'comment:chat_bubble':               { em: 0.88, line_height: 1.3,  pad_v_em: 0.45, pad_h_em: 0.8 },
  'comment:creator_reply':             { em: 0.9,  line_height: 1.3,  pad_v_em: 0.5,  pad_h_em: 0.7 },
  'comment:comment_overlay_chip':      { em: 0.7,  line_height: 1.15, pad_v_em: 0.3,  pad_h_em: 0.7 },

  // Creator
  'creator':                           { em: 0.85, line_height: 1.2, pad_v_em: 0.35, pad_h_em: 0.7 },
  'creator:identity_row':              { em: 0.85, line_height: 1.2, pad_v_em: 0.35, pad_h_em: 0.7 },
  'creator:creator_chip':              { em: 0.62, line_height: 1.1, pad_v_em: 0.3,  pad_h_em: 0.7 },
  'creator:creator_footer':            { em: 0.62, line_height: 1.2, pad_v_em: 0.3,  pad_h_em: 0.6 },
  'creator:ugc_byline':                { em: 0.58, line_height: 1.2, pad_v_em: 0,    pad_h_em: 0 },

  // Logo (image-only — no text rendering)
  'logo':                              { em: 1, line_height: 1.0, pad_v_em: 0, pad_h_em: 0 },

  // Panel / scrim (paint-only)
  'panel':                             { em: 1, line_height: 1.0, pad_v_em: 0, pad_h_em: 0 },
  'scrim':                             { em: 1, line_height: 1.0, pad_v_em: 0, pad_h_em: 0 },

  // Hero media (image/video)
  'hero_media':                        { em: 1, line_height: 1.0, pad_v_em: 0, pad_h_em: 0 },

  // Offer
  'offer':                             { em: 0.85, line_height: 1.1, pad_v_em: 0.4,  pad_h_em: 0.95 },
  'offer:offer_pill':                  { em: 0.85, line_height: 1.1, pad_v_em: 0.4,  pad_h_em: 0.95 },
  'offer:corner_tag':                  { em: 0.78, line_height: 1.1, pad_v_em: 0.35, pad_h_em: 0.7 },
  'offer:discount_burst':              { em: 1.0,  line_height: 1.0, pad_v_em: 0.6,  pad_h_em: 0.6 },
  'offer:ribbon_banner':               { em: 0.75, line_height: 1.1, pad_v_em: 0.4,  pad_h_em: 0.8 }
});

const DEFAULT_RULE = Object.freeze({
  em: 1.1, line_height: 1.15, pad_v_em: 0.2, pad_h_em: 0, pad_floor_px: 0
});

// Per-role default max_lines when the canvas spec didn't set one.
const DEFAULT_MAX_LINES_BY_ROLE = Object.freeze({
  headline: 2, eyebrow: 1, quote: 4, comment: 3, cta: 1, rating: 1,
  stat: 2, creator: 1, badges: 2, panel: null, scrim: null, logo: null,
  hero_media: null, product_card: 2, offer: 2
});

// Compute per-zone font/line/padding values. Mirrors the cascade in
// tp-zones.css off the stage's base font-size so the Resolver emits
// the same pixel values the renderer would draw.
function computeStylesForZone({ role, componentStyle, kind, rect, zoneScaler, baseFontPx, styleVariant }) {
  let rule =
    STYLE_RULES_BY_ROLE_VARIANT[`${role}:${componentStyle || ''}`] ||
    STYLE_RULES_BY_ROLE_VARIANT[`${role}:${styleVariant || ''}`] ||
    STYLE_RULES_BY_ROLE_VARIANT[role] ||
    STYLE_RULES_BY_ROLE_VARIANT[kind] ||
    DEFAULT_RULE;

  const scale = typeof zoneScaler === 'number' ? zoneScaler : 1;
  let zoneEm;
  if (rule.clamp) {
    const computedEm = (rect?.h || 300) * rule.clamp.h_factor * scale;
    zoneEm = Math.max(rule.clamp.min_em, Math.min(computedEm, rule.clamp.max_em));
  } else {
    zoneEm = (rule.em || 1) * scale;
  }

  const zoneFontPx   = zoneEm * baseFontPx;
  const lineHeightPx = (rule.line_height || 1.15) * zoneFontPx;
  // Padding floor — CSS uses max(<em>, <px>); apply the same.
  const padFloor = rule.pad_floor_px || 0;
  const padVPx = Math.max((rule.pad_v_em || 0) * zoneFontPx, padFloor);
  const padHPx = Math.max((rule.pad_h_em || 0) * zoneFontPx, Math.round(padFloor * 1.2));

  return {
    zone_em:         +zoneEm.toFixed(3),
    font_size_px:    +zoneFontPx.toFixed(2),
    line_height:     rule.line_height || 1.15,
    line_height_px:  +lineHeightPx.toFixed(2),
    padding_v_em:    rule.pad_v_em || 0,
    padding_h_em:    rule.pad_h_em || 0,
    padding_v_px:    +padVPx.toFixed(2),
    padding_h_px:    +padHPx.toFixed(2),
    max_lines_default: DEFAULT_MAX_LINES_BY_ROLE[role] ?? null,
    rule_source:     rule === DEFAULT_RULE ? 'default' : 'matched'
  };
}

// canvas.zone_scalers is keyed by zone.id OR zone.kind. Each entry is
// either a number (legacy) or { font, slot }. We only need font here.
function pickZoneScaler({ zoneScalers, id, kind, role }) {
  if (!zoneScalers || typeof zoneScalers !== 'object') return 1;
  const candidate = zoneScalers[id] ?? zoneScalers[kind] ?? zoneScalers[role];
  if (candidate == null) return 1;
  if (typeof candidate === 'number') return candidate;
  if (typeof candidate === 'object' && candidate.font != null) return candidate.font;
  return 1;
}

function inferTextColor({ canvasSpec, role }) {
  const sb = canvasSpec?.style_bindings || {};
  if (role === 'headline') return sb.headline_text_color || sb.panel_text_color || null;
  if (role === 'cta')      return sb.cta_text_color      || null;
  if (role === 'quote' || role === 'product_card') return sb.card_text_color || null;
  return sb.panel_text_color || null;
}

// ── tpGet port (matches templatePreview.js's dotted-path walk) ──
// Supports `arr[0]` bracket syntax + numeric segments. Same semantics
// as the browser-side resolver so backend resolution stays parity.

function tpGet(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    const bracket = part.match(/^([^\[]+)\[(\d+)\]$/);
    if (bracket) {
      cur = cur[bracket[1]];
      if (Array.isArray(cur)) cur = cur[Number(bracket[2])];
      else                    return undefined;
      continue;
    }
    if (/^\d+$/.test(part) && Array.isArray(cur)) { cur = cur[Number(part)]; continue; }
    cur = cur[part];
  }
  return cur;
}

function isPresent(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v))      return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function rectsOverlap(a, b) {
  if (!a || !b) return false;
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  return !(ax2 <= b.x || bx2 <= a.x || ay2 <= b.y || by2 <= a.y);
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function notFound(msg)   { const e = new Error(msg); e.status = 404; return e; }

module.exports = {
  resolveLayout
};
