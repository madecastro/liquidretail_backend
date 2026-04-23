// Stage 5 artifact: layout preprocessing — Gemini Vision overlay-zone
// analysis on the winning crop images. This is the artifact a downstream
// ad-layout generator service will consume by mediaId.

const mongoose = require('mongoose');

const overlayZoneArtifactSchema = new mongoose.Schema({
  mediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media',     required: true, index: true },
  runId:   { type: mongoose.Schema.Types.ObjectId, ref: 'DetectRun', required: true, index: true },

  zones:     { type: mongoose.Schema.Types.Mixed, default: {} },
  // shape: { '<ratio>': { '<variantKey>': { candidateId, imageUrl, analysis: {...} } } }

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('OverlayZoneArtifact', overlayZoneArtifactSchema);
