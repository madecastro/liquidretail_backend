// Phase 1 — AI Creative Director output.
//
// Caches N creative concepts per (brandId, productId, campaignKind,
// creativeIntent). Concepts are STRATEGY decisions (archetype, hierarchy
// priorities, recommended components) — NOT coordinates. The Generator
// stage (Phase 2) consumes a concept_id and materializes a canvas spec
// from it.
//
// Cache key rationale: strategy is a function of WHAT we're selling
// (brand+product), WHY (campaignKind = product / brand / promotional),
// and any operator hint (creativeIntent). It does NOT depend on which
// specific media post is the seed — that's the Generator's problem.
// One Director call serves every Ad in the cartesian for that
// (brand, product, kind, intent) combination.
//
// Shadow mode: through Phase 1, the artifact is persisted but not yet
// consumed by the rendering pipeline. Phase 2 wires the Generator to
// read it.

const mongoose = require('mongoose');

const creativeDirectionArtifactSchema = new mongoose.Schema({
  // ── Cache key dimensions (unique compound index below) ──────────
  brandId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',          required: true, index: true },
  productId:      { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null, index: true },
  campaignKind:   { type: String, default: null },     // 'product' | 'brand' | 'promotional' | null
  creativeIntent: { type: String, default: null },     // null = "AI decides"; future: "lean editorial" etc.

  // ── Contract metadata ──────────────────────────────────────────
  contractVersion:    { type: String, default: '1.0' },
  contractSchemaId:   { type: String, default: 'creative_direction.v1' },

  // Bumped when assembleSignals' shape changes — the cache check in
  // directConcepts only serves rows whose signalsVersion matches the
  // current code so older summaries don't stay frozen. Mirrors the
  // SPEC_SCHEMA_VERSION pattern in aiCanvasArtifact.
  signalsVersion:     { type: String, default: '1.0.0' },

  // ── Input snapshot (the signals the Director saw) ──────────────
  // Persisted verbatim so we can audit what strategy was made against
  // what signal — useful when concept variety drifts.
  inputSummary: { type: mongoose.Schema.Types.Mixed, required: true },

  // ── Direction output ───────────────────────────────────────────
  availableArchetypes:      { type: [String], default: [] },
  availableComponentRoles:  { type: [String], default: [] },
  creativeRules:            { type: mongoose.Schema.Types.Mixed, default: {} },
  concepts:                 { type: [mongoose.Schema.Types.Mixed], required: true },

  // ── Provenance ─────────────────────────────────────────────────
  provider:       { type: String, default: 'openai' },
  modelId:        { type: String, required: true },
  promptHash:     { type: String, required: true },
  promptSystem:   { type: String, default: null },
  promptUser:     { type: String, default: null },
  rawResponse:    { type: mongoose.Schema.Types.Mixed, default: null },

  // ── Validation outcomes ────────────────────────────────────────
  validationWarnings: { type: [String], default: [] },

  createdAt:    { type: Date, default: Date.now }
});

// Cache key — one artifact per unique (brand, product, campaignKind,
// creativeIntent). Null values participate in uniqueness so a "no
// product" brand-led concept is its own entry.
creativeDirectionArtifactSchema.index(
  { brandId: 1, productId: 1, campaignKind: 1, creativeIntent: 1 },
  { unique: true }
);

module.exports = mongoose.model('CreativeDirectionArtifact', creativeDirectionArtifactSchema);
