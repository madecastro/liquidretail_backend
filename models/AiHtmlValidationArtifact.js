// Phase 6.0 — Validation outcomes for HTML-output Layout Generator
// candidates. One row per (aiCanvasArtifactId, candidateIndex). The
// Pre-Judge filter reads `hardViolations` to drop non-renderable
// candidates before the Judge picks a winner; the spec preview reads
// `warnings` to surface contrast / image probe / overflow details.
//
// Conforms to schemas/contracts/ai_canvas_validation.v1.json.

const mongoose = require('mongoose');

const aiHtmlValidationArtifactSchema = new mongoose.Schema({
  aiCanvasArtifactId: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'AiCanvasArtifact',
    required: true,
    index: true
  },
  candidateIndex: { type: Number, default: 0 },

  // Hard failure markers — drive Pre-Judge filter
  parseOk:        { type: Boolean, required: true },
  hardViolations: { type: [String], default: [] },

  // Soft outcomes — diagnostic
  warnings: {
    type: [{
      severity: { type: String, enum: ['low', 'medium', 'high'] },
      code:     { type: String },
      message:  { type: String },
      locator:  { type: String, default: null }
    }],
    default: []
  },

  // Image probe — parallel HEAD requests on every <img src>
  imageProbe: {
    tested: { type: Number, default: 0 },
    ok:     { type: Number, default: 0 },
    failed: { type: [String], default: [] }
  },

  // WCAG contrast checks — every parsed text+background color pair
  contrastChecks: {
    type: [{
      selector: String,
      fg:       String,
      bg:       String,
      ratio:    Number,
      passAA:   Boolean
    }],
    default: []
  },

  // Post-render measurement (when Puppeteer runs the validation pass)
  computedDimensions: {
    width:    { type: Number, default: null },
    height:   { type: Number, default: null },
    overflow: { type: Boolean, default: false }
  },

  createdAt: { type: Date, default: Date.now }
});

// One row per (canvas artifact, candidate index). Replace on re-run
// rather than creating duplicates.
aiHtmlValidationArtifactSchema.index(
  { aiCanvasArtifactId: 1, candidateIndex: 1 },
  { unique: true }
);

module.exports = mongoose.model('AiHtmlValidationArtifact', aiHtmlValidationArtifactSchema);
