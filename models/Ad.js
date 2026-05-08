// Ad — a single rendered creative produced by the render service.
//
// Backed by the Generate Ads wizard flow:
//   campaign → campaignAdsGenerationService.expandWizardJob()
//            → for each creative entry: renderService.renderCreative()
//            → Ad.create({...})
//
// The Ad doc captures EVERYTHING the ads page needs to render its
// row + thumbnail without joining back to the LayoutInputArtifact:
// the URL, the copy snapshot, the linkage to the source media /
// product / template / canvas ratio, and the lifecycle state.
//
// derivationDigest is a sha256 over the resolved copy + cta + slot
// keys; re-rendering an identical (mediaId, template, aspectRatio,
// copy, cta) tuple produces the same digest, which the render
// service uses to skip and return the existing Ad rather than
// burning Cloudinary on duplicate output.

const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
  // ── Tenancy + grouping ───────────────────────────────────────────
  brandId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',    required: true, index: true },
  // Nullable so ads can be unlinked from a campaign via the
  // campaign detail page's "Remove ad" action. Orphans still
  // appear in the brand-scoped /api/ads gallery; only the
  // per-campaign filter excludes them.
  campaignId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },
  // Groups all creatives produced by one click of the Generate Ads
  // button. Lets the ads page show "this batch was generated together"
  // and supports re-running a campaign without losing the audit trail.
  campaignRunId: { type: String, required: true, index: true },

  // ── Source linkage ───────────────────────────────────────────────
  layoutInputArtifactId: { type: mongoose.Schema.Types.ObjectId, ref: 'LayoutInputArtifact' },
  mediaId:               { type: mongoose.Schema.Types.ObjectId, ref: 'Media',  required: true, index: true },
  productId:             { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null, index: true },

  // ── Generation context ───────────────────────────────────────────
  template:       { type: String, required: true, index: true },
  aspectRatio:    { type: String, required: true },
  mediaSource:    { type: String, enum: ['product_match', 'product_category', 'brand_match'], required: true },
  campaignKind:   { type: String },                     // 'brand' | 'promotional' | 'product' | 'collection' (mirrors campaign.kind, null treated as 'promotional')

  // ── Render output ────────────────────────────────────────────────
  kind:               { type: String, enum: ['image', 'video'], default: 'image' },  // V1 always 'image'
  renderUrl:          { type: String, required: true },                              // primary URL — PNG in V1
  posterUrl:          { type: String, default: null },                               // video poster — null in V1
  cloudinaryPublicId: { type: String, required: true, index: true },
  width:              { type: Number, required: true },                              // px
  height:             { type: Number, required: true },                              // px
  bytes:              { type: Number, default: null },
  durationMs:         { type: Number, default: null },                               // video only

  // ── Copy snapshot ────────────────────────────────────────────────
  // Read-time convenience for the ads page list / detail card so we
  // don't have to round-trip the LayoutInputArtifact for every row.
  // Resolved at render time from the canonical input.
  copy: {
    headline:     String,
    cta_text:     String,
    quote:        String,
    productName:  String,
    productPrice: String
  },

  // ── CTA (operator-provided) ──────────────────────────────────────
  ctaUrl:       { type: String },
  ctaUrlParams: { type: String, default: '' },

  // ── Lifecycle ────────────────────────────────────────────────────
  status:           { type: String, enum: ['draft', 'live', 'archived'], default: 'draft', index: true },
  derivationDigest: { type: String, required: true, index: true },                   // sha256 — de-dupe key

  generatedAt: { type: Date, default: Date.now },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
}, {
  timestamps: false   // explicit createdAt/updatedAt above
});

// De-dupe lookup. Same (campaignId, derivationDigest) pair = same
// rendered creative; render service uses this to skip duplicate work.
adSchema.index({ campaignId: 1, derivationDigest: 1 });

// Ads-page filtered listings. brandId + status is the primary query
// (e.g., "show me all live ads for this brand"); add campaignId for
// campaign-scoped views.
adSchema.index({ brandId: 1, status: 1, generatedAt: -1 });
adSchema.index({ campaignId: 1, generatedAt: -1 });

adSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Ad', adSchema);
