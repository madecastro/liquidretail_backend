// Layout generator input artifact. Cached output of
// services/layoutInputService.buildLayoutInput.
//
// Keyed by (mediaId, template, aspectRatio). Re-requests return the cached
// doc by default; callers pass refresh=true to bypass cache. Cache is
// conceptually invalidated when Brand is curated or detect artifacts are
// re-run — we don't auto-invalidate, callers re-request with refresh.
//
// input: the validated JSON object that matches the RS Social Proof Creative
//   Input schema. Consumed verbatim by the downstream renderer/template.
// derivation: raw LLM output from the single derivation call — kept so we can
//   debug / re-assemble without re-LLMing.

const mongoose = require('mongoose');

const layoutInputArtifactSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  brandId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      index: true, default: null },
  mediaId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Media', required: true, index: true },
  runId:       { type: mongoose.Schema.Types.ObjectId, ref: 'DetectRun' },   // which run's artifacts fed this
  template:    { type: String, required: true },
  aspectRatio: { type: String, required: true },

  // Semver of the input shape. Bump when the canonical path structure
  // changes (e.g. v1 → v2 moved hero_image_url → hero_media.image, split
  // creator out of ugc). buildLayoutInput refuses to serve a cached doc
  // whose schemaVersion doesn't match the current INPUT_SCHEMA_VERSION,
  // forcing a re-derivation.
  schemaVersion: { type: String },

  input:       { type: mongoose.Schema.Types.Mixed, required: true },
  derivation:  { type: mongoose.Schema.Types.Mixed },

  createdAt:   { type: Date, default: Date.now }
});

// One cached input per unique combination. Re-running deletes the prior one
// via findOneAndReplace in the service.
layoutInputArtifactSchema.index(
  { mediaId: 1, template: 1, aspectRatio: 1 },
  { unique: true }
);

module.exports = mongoose.model('LayoutInputArtifact', layoutInputArtifactSchema);
