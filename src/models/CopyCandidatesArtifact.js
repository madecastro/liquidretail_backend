// Phase 4 — style-aware copy candidates.
//
// Caches the LLM-generated headline / subheadline / eyebrow / CTA-micro
// copy arrays per (brandId, productId, creativeStyle). One small LLM
// call (gpt-4.1-mini) produces 3-5 candidates per slot tailored to the
// style's voice + length budget. Subsequent Generator runs against the
// same (brand × product × style) cell read these candidates and pick
// by index via the existing copy_picks mechanism — finally giving
// real signal to the pick-from-candidates feature shipped in 1d-c.
//
// Cache rationale: voice + length is a function of (brand × style),
// content anchors are a function of product. Once derived, every Ad
// in the cartesian for that combination reuses the same candidates.
// A campaign with 4 products × 5 styles enabled = 20 derivation calls
// total, regardless of how many media + ratios fan out.

const mongoose = require('mongoose');

const copyCandidatesArtifactSchema = new mongoose.Schema({
  brandId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
  productId:     { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null, index: true },
  creativeStyle: { type: String, required: true, index: true },

  contractVersion: { type: String, default: '1.0' },

  candidates: {
    headlines:      { type: [String], default: [] },
    subheadlines:   { type: [String], default: [] },
    eyebrows:       { type: [String], default: [] },
    cta_micro_copy: { type: [String], default: [] }
  },

  // Provenance
  provider:     { type: String, default: 'openai' },
  modelId:      { type: String, required: true },
  promptHash:   { type: String, default: null },
  promptSystem: { type: String, default: null },
  promptUser:   { type: String, default: null },
  rawResponse:  { type: mongoose.Schema.Types.Mixed, default: null },

  // Telemetry rollup
  inputTokens:  { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  costUsd:      { type: Number, default: 0 },
  durationMs:   { type: Number, default: 0 },

  createdAt:    { type: Date, default: Date.now }
});

copyCandidatesArtifactSchema.index(
  { brandId: 1, productId: 1, creativeStyle: 1 },
  { unique: true }
);

module.exports = mongoose.model('CopyCandidatesArtifact', copyCandidatesArtifactSchema);
