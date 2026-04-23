// Stage 4 artifact: provider matches (Gemini grounded search, Google Lens,
// future providers) + GPT-4.1 reasoner identification + SerpAPI shopping
// details + Gemini-synthesized review summary.

const mongoose = require('mongoose');

const productMatchArtifactSchema = new mongoose.Schema({
  mediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media',     required: true, index: true },
  runId:   { type: mongoose.Schema.Types.ObjectId, ref: 'DetectRun', required: true, index: true },

  query:        mongoose.Schema.Types.Mixed,
  // { brand, category, caption, primarySubject, textDetected[] }

  providers:    { type: mongoose.Schema.Types.Mixed, default: {} },
  errors:       { type: mongoose.Schema.Types.Mixed, default: {} },
  totalMatches: Number,

  identification: mongoose.Schema.Types.Mixed,
  // { productName, brand, certainty, certaintyLabel, details: { ...SerpAPI... + reviewSummary } }

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProductMatchArtifact', productMatchArtifactSchema);
