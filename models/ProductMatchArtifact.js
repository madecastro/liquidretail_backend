// Stage 4 artifact: provider matches (Gemini grounded search, Google Lens,
// future providers) + GPT-4.1 reasoner identification + SerpAPI shopping
// details + Gemini-synthesized review summary.

const mongoose = require('mongoose');

const productMatchArtifactSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  mediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media',     required: true, index: true },
  runId:   { type: mongoose.Schema.Types.ObjectId, ref: 'DetectRun', required: true, index: true },

  query:        mongoose.Schema.Types.Mixed,
  // { brand, category, caption, primarySubject, textDetected[] }

  providers:    { type: mongoose.Schema.Types.Mixed, default: {} },
  errors:       { type: mongoose.Schema.Types.Mixed, default: {} },
  totalMatches: Number,

  identification: mongoose.Schema.Types.Mixed,
  // { productName, brand, certainty, certaintyLabel, details: { ...SerpAPI... + reviewSummary } }

  // Decision-tree outputs from productMatchService — additive over the
  // legacy `identification` field above so older consumers don't break.
  // outcome ∈ { 'confirmed', 'lookup_from_yolo', 'lookup_from_gemini',
  //             'category', 'branding', 'do_not_use' }
  outcome:          { type: String, index: true },
  outcomeReasoning: String,
  winner:           String,        // 'yolo' | 'gemini' | 'agree' | null
  // Brand-level fallback collection page (filled when outcome='category')
  brandCategory:    mongoose.Schema.Types.Mixed,
  // Brand-level reviews (filled when outcome='branding')
  brandReviews:     mongoose.Schema.Types.Mixed,

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProductMatchArtifact', productMatchArtifactSchema);
