// Brand catalog. A Brand doc is upserted opportunistically during the detect
// pipeline's product-match stage — first time we see a brand name on an
// identified product, we create a stub with the best signal we have (the
// source scene's palette as fallback colors). Ops can later enrich the stub
// manually via a curation UI (logo upload, canonical colors, tagline, font).
//
// Layout generator reads Brand by nameNormalized at creative-input assembly
// time. Missing or stub-only fields are passed through as null — templates
// must gracefully handle absent brand data.

const mongoose = require('mongoose');

function normalizeBrandName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')      // strip trademark symbols
    .replace(/[^a-z0-9]+/g, ' ') // collapse punctuation to spaces
    .trim()
    .replace(/\s+/g, ' ');
}

const brandSchema = new mongoose.Schema({
  nameNormalized: { type: String, required: true, unique: true, index: true },
  name:           { type: String, required: true },

  tagline:        String,
  logoUrl:        String,
  primaryColor:   String,
  secondaryColor: String,
  accentColor:    String,
  fontFamily:     String,
  tone:           [String],

  // Provenance: how did this Brand doc first get created? Stub = auto from
  // detect pipeline. Curated = an ops user has manually enriched it.
  source:         { type: String, enum: ['stub', 'curated'], default: 'stub' },

  // If stub, which Media was the first to surface this brand — useful for
  // auditing where a brand came from.
  firstSeenMediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

brandSchema.pre('save', function(next) { this.updatedAt = Date.now(); next(); });

module.exports = mongoose.model('Brand', brandSchema);
module.exports.normalizeBrandName = normalizeBrandName;
