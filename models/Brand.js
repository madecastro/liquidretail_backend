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

const demographicSchema = new mongoose.Schema({
  name:         { type: String, required: true },   // e.g. "Saltwater Joe"
  description:  String,                              // one-line persona
  interests:    [String],                            // what they care about
  painPoints:   [String],                            // what they worry about
  toneHint:     String,                              // how they speak
  avatarUrl:    String                               // optional, future — generated avatar image
}, { _id: false });

const brandSchema = new mongoose.Schema({
  nameNormalized: { type: String, required: true, unique: true, index: true },
  name:           { type: String, required: true },

  websiteUrl:     String,                            // user-supplied on upload; seed for enrichment
  tagline:        String,
  logoUrl:        String,
  primaryColor:   String,
  secondaryColor: String,
  accentColor:    String,
  fontFamily:     String,
  tone:           [String],
  demographics:   [demographicSchema],               // key target personas for notional quotes

  // Provenance. stub = auto-created from detect with minimal data.
  // enriched = brandEnrichmentService successfully filled in fields from
  // the websiteUrl. curated = a human edited it; never overwritten.
  source:         { type: String, enum: ['stub', 'enriched', 'curated'], default: 'stub' },
  enrichedAt:     Date,

  // Per-field curation lock. Listed field names are protected from
  // auto-enrichment overwrite even when source='stub'/'enriched'. Lets a
  // user upload one curated asset (e.g. logoUrl) without losing the
  // benefit of automated enrichment for the rest. Field names match
  // schema property names exactly: 'logoUrl', 'primaryColor', etc.
  curatedFields:  [String],

  // If stub, which Media was the first to surface this brand — useful for
  // auditing where a brand came from.
  firstSeenMediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

brandSchema.pre('save', function(next) { this.updatedAt = Date.now(); next(); });

module.exports = mongoose.model('Brand', brandSchema);
module.exports.normalizeBrandName = normalizeBrandName;
