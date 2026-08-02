// Single sanctioned way to read a Creative Director concept on any render path.
//
// THE DEFECT (2026-08-01, live on gpt-image-2):
//   conceptLook() in directImageRenderService fell through
//     concept.art_direction || concept.rationale || …
//   but art_direction was NEVER emitted by any Director schema — only the
//   fallback site referenced it. So the arm was taken 100% of the time and
//   the Director's PRIVATE reasoning ("No proof signal exists… so per the
//   honesty rule this concept leans on bold brand-voice typography…") became
//   the art brief. The model treated a refusal-to-fabricate note as visual
//   direction. emotional_hook (purchase-objection name, not mood) and the
//   permanently-null layoutInput.brand.visual_style were concatenated in too.
//
// RULE: absent means absent. Never invent a visual world from voice words or
// honesty notes. No export from this module may return rationale / reasoning.

'use strict';

/**
 * Copy-ready strings the renderer may typeset. Dual-reads v3 `copy` and
 * legacy v2 `copy_picks` so existing CreativeDirectionArtifact rows keep
 * working for at least one deploy after the schema nest.
 */
function renderableCopy(concept) {
  const src = (concept && (concept.copy || concept.copy_picks)) || {};
  const one = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
  };
  return {
    headline:    one(src.headline),
    subheadline: one(src.subheadline),
    eyebrow:     one(src.eyebrow),
    cta:         one(src.cta)
  };
}

/**
 * Visual world string for the image prompt, or null.
 *
 * Reads ONLY concept.art_direction:
 *   - bare legacy string → trimmed string or null
 *   - v3 nested { look, palette_hint, typography_hint } → joined visual prose
 *
 * NEVER rationale. NEVER emotional_hook. NEVER Brand.tone / visual_style.
 * When the Director gave no art direction, return null so the prompt sentence
 * "The brand's world is: …" is omitted entirely (staticAdIntents already
 * does that when product.look is falsy).
 */
function artDirectionLook(concept) {
  const ad = concept == null ? null : concept.art_direction;
  if (ad == null) return null;

  if (typeof ad === 'string') {
    const s = ad.trim();
    return s ? s.slice(0, 600) : null;
  }

  if (typeof ad === 'object' && !Array.isArray(ad)) {
    const parts = [ad.look, ad.palette_hint, ad.typography_hint]
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => String(v).trim());
    if (!parts.length) return null;
    return parts.join(' ').slice(0, 600);
  }

  return null;
}

/**
 * Project a concept for any render path. Reasoning is omitted at every depth
 * so a caller physically cannot pass rationale into an image/HTML prompt by
 * reading fields off this object.
 *
 * Dual-reads flat v2 rows and nested v3 rows into one flat, strategy-safe
 * shape. copy and copy_picks both point at the same projected copy so
 * dual-read call sites do not have to change overnight.
 */
function conceptForRender(concept) {
  if (!concept || typeof concept !== 'object') return null;

  const r = (concept.routing && typeof concept.routing === 'object')
    ? concept.routing
    : {};
  const copy = renderableCopy(concept);
  const look = artDirectionLook(concept);

  // Art direction only as visual prose the image path already understands.
  // Nested hints that produced a look string stay as { look }; bare absence
  // stays null. Never re-attach the raw object if look resolved null but
  // rationale-shaped fields somehow lived under art_direction.
  const art_direction = look ? { look } : null;

  return {
    concept_id:             concept.concept_id ?? null,
    name:                   concept.name ?? null,
    archetype:              r.archetype ?? concept.archetype ?? null,
    layout_family:          r.layout_family ?? concept.layout_family ?? null,
    emotional_hook:         r.emotional_hook ?? concept.emotional_hook ?? null,
    social_proof_type:      r.social_proof_type ?? concept.social_proof_type ?? null,
    product_priority:       r.product_priority ?? concept.product_priority ?? null,
    ugc_priority:           r.ugc_priority ?? concept.ugc_priority ?? null,
    comment_priority:       r.comment_priority ?? concept.comment_priority ?? null,
    stat_priority:          r.stat_priority ?? concept.stat_priority ?? null,
    cta_emphasis:           r.cta_emphasis ?? concept.cta_emphasis ?? null,
    creative_style:         r.creative_style ?? concept.creative_style ?? null,
    recommended_components: r.recommended_components ?? concept.recommended_components ?? null,
    media_picks:            r.media_picks ?? concept.media_picks ?? null,
    output_shape:           r.output_shape ?? concept.output_shape ?? null,
    // Dual-compat: both names are the same projected object.
    copy,
    copy_picks:             copy,
    art_direction
    // rationale / reasoning deliberately absent — do not re-add.
  };
}

module.exports = {
  renderableCopy,
  artDirectionLook,
  conceptForRender
};
