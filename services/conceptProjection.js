// Single sanctioned way to read a Creative Director concept on any path.
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
// THE CONTRACT DEFECT (2026-08-02, live on concept-driven generation):
//   Director schema v3 nests strategy fields under concept.routing
//   (media_picks, archetype, creative_style, output_shape, …). The
//   producer's own validator dual-reads flat v2 and nested v3, but the
//   expansion consumer only read concept.media_picks (flat). Every v3
//   concept was discarded as "no media_picks" and paid Director rounds
//   produced zero ads. conceptField() is the single dual-read helper so
//   the next schema move is one edit, not a hunt across consumers.
//
// RULE: absent means absent. Never invent a visual world from voice words or
// honesty notes. No export from this module may return rationale / reasoning
// into a render projection (conceptForRender). conceptField itself is a
// structural dual-read and does not invent values.

'use strict';

// Fields the Director nests under `routing` in schema v3. Listed so the
// next reader knows what moved — conceptField dual-reads ANY name the same
// way (routing first, then flat), but these are the ones that actually
// nest today.
const ROUTING_NESTED_FIELDS = Object.freeze([
  'archetype',
  'layout_family',
  'emotional_hook',
  'social_proof_type',
  'product_priority',
  'ugc_priority',
  'comment_priority',
  'stat_priority',
  'cta_emphasis',
  'creative_style',
  'recommended_components',
  'media_picks',
  'output_shape'
]);

/**
 * Dual-read one field from a Director concept: prefer nested v3
 * `concept.routing[name]`, fall back to flat v2 `concept[name]`.
 *
 * Nullish nested values (`null` / `undefined`) fall through to flat so a
 * partial nest does not blank a legacy flat sibling. Falsy-but-present
 * nested values (`''`, `0`, `false`) win — same as `!= null`, not `||`.
 *
 * media_picks is special: use conceptMediaPicks, which preserves the
 * producer's Array.isArray order (nested array wins including empty;
 * non-array nested falls through to a flat array).
 *
 * @param {object|null|undefined} concept
 * @param {string} name
 * @returns {*}
 */
function conceptField(concept, name) {
  if (!concept || typeof concept !== 'object' || !name) return undefined;
  const r = (concept.routing && typeof concept.routing === 'object')
    ? concept.routing
    : null;
  if (r && r[name] != null) return r[name];
  return concept[name];
}

/**
 * media_picks as an array, dual-reading nested v3 and flat v2.
 *
 * True Array.isArray ordering (matches the pre-helper producer):
 *   1. nested array wins — including empty [] (nested-present means nested)
 *   2. non-array nested value falls through to a flat array when present
 *   3. otherwise []
 *
 * Do NOT route this through conceptField then coerce non-arrays to []:
 * that drops the flat sibling when routing.media_picks is a non-array
 * non-null (`{}`, `"bad"`, `false`, `0`, `''`) and reintroduces the
 * no_media_picks outage in a narrower case.
 *
 * @param {object|null|undefined} concept
 * @returns {Array}
 */
function conceptMediaPicks(concept) {
  if (!concept || typeof concept !== 'object') return [];
  const r = (concept.routing && typeof concept.routing === 'object')
    ? concept.routing
    : null;
  if (r && Array.isArray(r.media_picks)) return r.media_picks;
  if (Array.isArray(concept.media_picks)) return concept.media_picks;
  return [];
}

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
 * shape via conceptField. copy and copy_picks both point at the same
 * projected copy so dual-read call sites do not have to change overnight.
 */
function conceptForRender(concept) {
  if (!concept || typeof concept !== 'object') return null;

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
    archetype:              conceptField(concept, 'archetype') ?? null,
    layout_family:          conceptField(concept, 'layout_family') ?? null,
    emotional_hook:         conceptField(concept, 'emotional_hook') ?? null,
    social_proof_type:      conceptField(concept, 'social_proof_type') ?? null,
    product_priority:       conceptField(concept, 'product_priority') ?? null,
    ugc_priority:           conceptField(concept, 'ugc_priority') ?? null,
    comment_priority:       conceptField(concept, 'comment_priority') ?? null,
    stat_priority:          conceptField(concept, 'stat_priority') ?? null,
    cta_emphasis:           conceptField(concept, 'cta_emphasis') ?? null,
    creative_style:         conceptField(concept, 'creative_style') ?? null,
    recommended_components: conceptField(concept, 'recommended_components') ?? null,
    media_picks:            conceptMediaPicks(concept),
    output_shape:           conceptField(concept, 'output_shape') ?? null,
    // Dual-compat: both names are the same projected object.
    copy,
    copy_picks:             copy,
    art_direction
    // rationale / reasoning deliberately absent — do not re-add.
  };
}

module.exports = {
  ROUTING_NESTED_FIELDS,
  conceptField,
  conceptMediaPicks,
  renderableCopy,
  artDirectionLook,
  conceptForRender
};
