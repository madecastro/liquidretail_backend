// Phase 5 — Resolver / Constraint-Solver output. Matches the contract
// at schemas/contracts/resolved_layout.v1.json.
//
// Cache key: (aiCanvasArtifactId, layoutInputArtifactId). The unique
// index participates with null so V1 specs (no layoutInputArtifactId
// captured) still upsert cleanly during the migration. Phase 5b will
// flip the renderer over to consume this artifact; Phase 5c removes
// the inline-resolution code path.

const mongoose = require('mongoose');

const resolvedLayoutArtifactSchema = new mongoose.Schema({
  // Provenance — links back to the inputs the Resolver consumed
  aiCanvasArtifactId:    { type: mongoose.Schema.Types.ObjectId, ref: 'AiCanvasArtifact',   required: true, index: true },
  layoutInputArtifactId: { type: mongoose.Schema.Types.ObjectId, ref: 'LayoutInputArtifact', default: null, index: true },
  brandId:               { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',              default: null, index: true },
  campaignId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign',           default: null, index: true },

  contractType:    { type: String, default: 'resolved_layout' },
  contractVersion: { type: String, default: '1.0' },

  canvas: {
    width:        { type: Number, required: true },
    height:       { type: Number, required: true },
    aspect_ratio: { type: String, required: true }
  },

  resolutionStatus: {
    type: String,
    enum: ['resolved', 'resolved_with_fallbacks', 'partial', 'failed'],
    default: 'resolved'
  },

  // resolved_data.slots is an open-shape map; we just store as Mixed.
  resolvedData: { type: mongoose.Schema.Types.Mixed, default: { slots: {} } },

  // resolved_zones[] — per-zone result (rect, role, component_style,
  // css_class, computed styles, adjustments). Phase 5a leaves
  // `computed` minimal; Phase 5b lifts the CSS clamp/calc math into JS.
  resolvedZones: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // validation outcomes
  validation: {
    bounds_check:    { type: String, enum: ['pass', 'fail'],         default: 'pass' },
    overlap_check:   { type: String, enum: ['pass', 'fail', 'warn'], default: 'pass' },
    slot_resolution: { type: String, enum: ['pass', 'fail', 'partial'], default: 'pass' },
    contrast_check:  { type: String, enum: ['pass', 'fail', 'warn'], default: 'pass' },
    safe_area_check: { type: String, enum: ['pass', 'fail', 'warn'], default: 'pass' },
    missing_assets:  { type: [String], default: [] }
  },

  // fallback records — { zone_id, role, from_component_style, to_component_style, reason }
  fallbacksUsed: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // warnings — { severity, message, zone_id? }
  warnings: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Telemetry
  durationMs: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now }
});

resolvedLayoutArtifactSchema.index(
  { aiCanvasArtifactId: 1, layoutInputArtifactId: 1 },
  { unique: true }
);

module.exports = mongoose.model('ResolvedLayoutArtifact', resolvedLayoutArtifactSchema);
