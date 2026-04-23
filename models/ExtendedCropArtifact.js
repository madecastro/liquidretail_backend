// Stage 3 artifact: AI-extended ratios (9:16, 1.91:1) — OpenAI + Gemini
// extension + generation candidates, the extended-judge results, and the
// final selected winner per ratio (which may be a forced override, e.g. the
// current "always pick Gemini extension" stopgap until judge bias is fixed).

const mongoose = require('mongoose');

const extendedCropArtifactSchema = new mongoose.Schema({
  mediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media',     required: true, index: true },
  runId:   { type: mongoose.Schema.Types.ObjectId, ref: 'DetectRun', required: true, index: true },

  candidates: { type: mongoose.Schema.Types.Mixed, default: {} },
  // shape: { '9:16': [candidate,...], '1.91:1': [candidate,...] }

  errors:     { type: mongoose.Schema.Types.Mixed, default: {} },
  // shape: { '9:16': [{label, provider, variant, error},...], '1.91:1': [...] }

  judge:      { type: mongoose.Schema.Types.Mixed, default: {} },
  // per-ratio winnerId / reasoning / scores

  selectedWinners: { type: mongoose.Schema.Types.Mixed, default: {} },
  // shape: { '9:16': { candidateId, source: 'judge'|'override' }, '1.91:1': {...} }

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ExtendedCropArtifact', extendedCropArtifactSchema);
