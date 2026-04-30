// Canonical input entity. Every media item the detect pipeline operates on
// has exactly one Media doc — manual uploads, future Meta / TikTok / IG
// webhooks, and any other ingestion route all upsert into this collection.
//
// Idempotent on (source, externalId): re-ingesting the same TikTok post never
// creates a duplicate. For manual uploads, externalId is generated locally
// (e.g. `manual_<ts>_<rand>`).
//
// `latestArtifacts` always points to the most recent successful artifact per
// stage so consumers (UI, future ad-layout service) can read with one extra
// hop instead of scanning the artifact collections by createdAt.

const mongoose = require('mongoose');

const mediaSchema = new mongoose.Schema({
  // Tenant scope.
  advertiserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  // Brand scope. Set on upload from the active brand picker (or
  // from form override). Nullable for legacy Media — frontend can
  // still surface those by leaving the brandId filter off.
  brandId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', index: true, default: null },

  externalId:    { type: String, required: true },
  source:        {
    type: String,
    required: true,
    enum: ['meta', 'tiktok', 'instagram', 'youtube', 'manual_upload', 'other']
  },
  sourceUrl:     String,                   // original platform URL, if known

  fileType:      { type: String, required: true, enum: ['image', 'video'] },
  fileUrl:       { type: String, required: true },   // our Cloudinary mirror
  fileMimeType:  String,
  fileName:      String,

  width:         Number,
  height:        Number,
  durationSec:   Number,                   // video only

  metadata:      { type: mongoose.Schema.Types.Mixed, default: {} },
  // Examples of what goes in metadata:
  //   { brand, category, caption, postedAt, accountId, postType, hashtags[] }

  platformStats: {
    views:      Number,
    likes:      Number,
    comments:   Number,
    shares:     Number,
    saves:      Number,
    fetchedAt:  Date
  },

  latestArtifacts: {
    detection:    { type: mongoose.Schema.Types.ObjectId, ref: 'DetectionArtifact' },
    crops:        { type: mongoose.Schema.Types.ObjectId, ref: 'CropArtifact' },
    extended:     { type: mongoose.Schema.Types.ObjectId, ref: 'ExtendedCropArtifact' },
    match:        { type: mongoose.Schema.Types.ObjectId, ref: 'ProductMatchArtifact' },
    overlayZones: { type: mongoose.Schema.Types.ObjectId, ref: 'OverlayZoneArtifact' }
  },

  // Computed downstream from artifacts; cached here so "find ad-suitable
  // media" is one indexed query instead of an aggregation across artifacts.
  adSuitability: {
    score:     Number,
    reasons:   [String],
    updatedAt: Date
  },

  // Creator / platform rights approval. Set via the detect review UI for
  // now; will move to a dedicated rights-management screen later. The
  // layout generator refuses to populate `ugc.rights_approved = true` on
  // creative inputs unless `rights.approved === true`.
  rights: {
    approved:   { type: Boolean, default: false },
    approvedBy: String,                  // user id / email who toggled
    approvedAt: Date,
    notes:      String                   // optional context / license source
  },

  // Two-axis classification — stable on every Media so the canonical
  // input shape and template selector can branch honestly.
  //
  //   socialPostType — provenance / origin (HOW this entered the system):
  //     'brand_produced' — IG sync from /me/media (brand's own account); not UGC
  //     'ugc'            — IG sync from /me/tags or branded-content (true creator
  //                        content about the brand); future tag-pull flow (backlog #69)
  //                        is the data source — until that ships, no Media should
  //                        receive this value in production
  //     'manual_upload'  — uploaded via the Upload form; no platform context
  //     'other'          — legacy / unclassified default
  //
  //   detectSummary — what the detect pipeline found in the Media (filled in
  //                   at end of detect; 'pending' until then):
  //     outcome:
  //       'own_product'   — match winner's brand matches the active brand context
  //       'competitor'    — match winner's brand differs from the active brand
  //       'category'      — no specific product but a category was inferred
  //       'no_products'   — detect found nothing identifiable
  //       'pending'       — detect hasn't completed yet
  //     matchedProducts:   plain-text identifiers for now (debug-friendly);
  //                        later: ObjectId refs to CatalogProduct
  //     matchedCategories: category strings (apparel, electronics, ...)
  //     detectedAt:        when the summary was last computed
  classification: {
    socialPostType: {
      type: String,
      enum: ['brand_produced', 'ugc', 'manual_upload', 'other'],
      default: 'other'
    },
    detectSummary: {
      outcome: {
        type: String,
        enum: ['own_product', 'competitor', 'category', 'no_products', 'pending'],
        default: 'pending'
      },
      matchedProducts: [{
        name:      String,
        brand:     String,
        certainty: Number,
        _id: false
      }],
      matchedCategories: [String],
      detectedAt: Date
    }
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

mediaSchema.index({ source: 1, externalId: 1 }, { unique: true });
mediaSchema.pre('save', function(next) { this.updatedAt = Date.now(); next(); });

module.exports = mongoose.model('Media', mediaSchema);
