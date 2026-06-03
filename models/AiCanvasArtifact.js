// Persisted cache of LLM-generated canvas specs for AI templates.
//
// Same cartesian partition as LayoutInputArtifact:
//   (mediaId, template, aspectRatio, productId, variantKind,
//    campaignContextHash, paletteSource, creativeStyle)
//
// We add `creativeStyle` to the key so the operator can pick multiple
// AI styles in Step 3 (ai_brand_led + ai_social_proof_led, say) and
// each one gets its own cached spec for the same media + product +
// ratio combo. Without that dimension, the second style would read
// the first one's cache.
//
// canvasSpec is the validated JSON canvas spec — same shape the
// renderer reads from rsSocialProof.canvas.v1.json's per-ratio
// `variants` entries. drawTpCanvas consumes it directly.
//
// rawResponse is the raw OpenAI completion text — kept so we can
// debug prompt drift / re-validate without re-LLMing if the
// validator gets stricter.

const mongoose = require('mongoose');

const aiCanvasArtifactSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      index: true, default: null },
  mediaId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Media', required: true, index: true },

  template:     { type: String, required: true },   // e.g. 'ai_brand_led'
  creativeStyle:{ type: String, required: true },   // e.g. 'brand_led' — the LLM's own picked style, also part of the cache key
  aspectRatio:  { type: String, required: true },

  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null, index: true },
  variantKind: { type: String, default: null },

  campaignContextHash: { type: String, default: null },
  paletteSource:       { type: String, default: 'media' },

  // Validated canvas spec — the actual rendering payload.
  canvasSpec:   { type: mongoose.Schema.Types.Mixed, required: true },

  // Validation outcomes recorded for diagnostics. Empty array on a
  // clean validation. Populated with soft-warnings when zones drift
  // outside safe areas, slots reference unknown paths, etc. Hard
  // failures don't reach this stage — the service throws and nothing
  // gets persisted.
  validationWarnings: { type: [String], default: [] },

  // LLM provenance.
  modelId:      { type: String },         // e.g. 'gpt-4.1'
  promptHash:   { type: String },         // sha256 of the prompt text for drift detection
  // Full prompt text, persisted for diagnostic visibility. promptSystem
  // is the system instructions block (zone palette, archetypes, schema
  // guidance, etc.); promptUser is the per-request body including the
  // FULL CONTEXT JSON, vision-input role list, and per-style intent.
  // promptImages is the parallel list of {role, url, label} entries
  // attached as image_url parts to OpenAI (the LLM sees these as
  // separate vision inputs; we keep the URLs so the preview can show
  // exactly which images flowed in). Stored as plain strings — no PII
  // concerns since the brand/product context is operator-supplied.
  promptSystem: { type: String, default: null },
  promptUser:   { type: String, default: null },
  promptImages: { type: [mongoose.Schema.Types.Mixed], default: [] },
  rawResponse:  { type: mongoose.Schema.Types.Mixed },

  // What the LLM declared about its own pick. elements_used /
  // elements_skipped / rationale come straight off the response.
  rationale:        { type: String,   default: null },
  elementsUsed:     { type: [String], default: [] },
  elementsSkipped:  { type: [String], default: [] },

  // Shadow hierarchy spec (2.3+). Strategy + layout intent at a
  // higher abstraction than zones[]. Renderer ignores; persisted
  // for vocabulary analysis so we can formalize layout_family /
  // component_style / emotional_hook enums based on what the LLM
  // empirically converges on across many generations.
  hierarchySpec:    { type: mongoose.Schema.Types.Mixed, default: null },

  // Semver of the AI-spec schema (the JSON Schema we feed to OpenAI).
  // Bump when the response schema changes — old cached docs become
  // unusable; service re-generates on miss.
  specSchemaVersion: { type: String },

  createdAt:    { type: Date, default: Date.now }
});

aiCanvasArtifactSchema.index(
  { mediaId: 1, template: 1, aspectRatio: 1, productId: 1, variantKind: 1, campaignContextHash: 1, paletteSource: 1, creativeStyle: 1 },
  { unique: true }
);

module.exports = mongoose.model('AiCanvasArtifact', aiCanvasArtifactSchema);
