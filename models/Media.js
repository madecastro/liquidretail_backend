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
    enum: ['meta', 'tiktok', 'instagram', 'youtube', 'manual_upload', 'catalog-product', 'other']
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
    views:      Number,    // IG: impressions (image) or plays (video/reel)
    likes:      Number,
    comments:   Number,
    shares:     Number,
    saves:      Number,
    reach:      Number,    // unique accounts reached — distinct from views
    engagement: Number,    // total interactions (IG insights aggregate)
    fetchedAt:  Date
  },

  latestArtifacts: {
    detection:    { type: mongoose.Schema.Types.ObjectId, ref: 'DetectionArtifact' },
    crops:        { type: mongoose.Schema.Types.ObjectId, ref: 'CropArtifact' },
    extended:     { type: mongoose.Schema.Types.ObjectId, ref: 'ExtendedCropArtifact' },

    // Phase 1.7 — match becomes per-product (one ProductMatchArtifact per
    // refined detection). `match` (singular) stays as the PRIMARY match
    // pointer (highest combined-score; catalog-winners outrank otherwise)
    // so existing readers keep working without change. `matches` is the
    // full list — readers that want all per-product matches read this.
    match:        { type: mongoose.Schema.Types.ObjectId, ref: 'ProductMatchArtifact' },
    matches:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'ProductMatchArtifact' }],

    overlayZones: { type: mongoose.Schema.Types.ObjectId, ref: 'OverlayZoneArtifact' }
  },

  // Phase 2c — vision analysis promoted onto Media as denormalized cache
  // of the LATEST run's output. DetectionArtifact stays as the per-run
  // audit record (cross-run diffs queryable there). Consumers that want
  // "what's in this Media right now" read directly from Media without
  // joining through DetectionArtifact.
  //
  // Updated atomically with latestArtifacts.detection at end of detect-
  // fanout phase. Stale only if a run failed mid-flight; cleared on next
  // successful run.
  subjects:           { type: [mongoose.Schema.Types.Mixed], default: [] },
  text:               { type: [mongoose.Schema.Types.Mixed], default: [] },
  background:         mongoose.Schema.Types.Mixed,
  primarySubjectId:   String,
  primarySubjectDesc: String,
  safeRect:           mongoose.Schema.Types.Mixed,
  // Refined products are the per-product tight crops produced by Phase 1.6
  // (image-only). Carries source-image bbox + Cloudinary c_crop URL +
  // label + category. Consumers iterate to get "what specific products
  // are in this Media."
  refinedProducts:    { type: [mongoose.Schema.Types.Mixed], default: [] },
  lastDetectedAt:     Date,

  // Phase 2d — relational match results denormalized for fast reads. The
  // source of truth is ProductMatchArtifact (per-run audit), but these
  // arrays are the LATEST current state. Consumers wanting "what products
  // / categories does this Media match right now" read these directly.
  //
  // matchedProducts[] — one entry per refined product that produced a
  //   confident outcome (product_match or product_category). Catalog
  //   winners include the catalogProductId FK; competitor matches and
  //   no-match-no-category outcomes are omitted from this array.
  matchedProducts: [{
    refinedProductId:        String,                                                           // 'r1', 'r2', ...
    catalogProductId:        { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct' },  // null when match was inferred but ensure-skipped (competitor) or below floor
    matchKind:               String,                                                           // 'catalog' | 'detect-identified' | 'inferred-no-row'
    outcome:                 String,                                                           // 'product_match' | 'product_category'
    confidence:              Number,                                                           // catalogCombinedScore || identification.certainty
    matchEvidenceArtifactId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductMatchArtifact' },
    _id: false
  }],
  // matchedCategories[] — one entry per refined product that resolved a
  //   category leaf (via productCategoryService → findOrCreateCategoryTree).
  //   Replaces the per-match brandCategory snapshot for "what categories
  //   does this Media touch" reads.
  matchedCategories: [{
    categoryId:              { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    refinedProductId:        String,
    confidence:              Number,
    matchEvidenceArtifactId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductMatchArtifact' },
    _id: false
  }],

  // Phase A-0 — concise derived display fields used by the Media Library
  // page so the UI doesn't have to recompute them from artifacts on every
  // render. Populated at the end of detect by the finalize-stage derivation
  // pass (subjectTextService extension + adSuitabilityService +
  // imageQualityService).
  primarySubjectLabel:   String,                                              // e.g. "Person (Runner)"
  secondaryElementsTags: { type: [String], default: [] },                      // e.g. ["Mountain", "Trees", "Trail"]
  technicalInsights: {
    brightnessAvg:  Number,                                                    // 0..1, mean of overlay-zone brightness grid
    densityAvg:     Number,                                                    // 0..1, mean of overlay-zone density grid
    focusScore:     Number,                                                    // raw Laplacian variance
    focusBucket:    String,                                                    // 'Soft' | 'Acceptable' | 'Sharp'
    updatedAt:      Date
  },

  // Phase A-0 — Ad Readiness composite score + typed reason bullets. The
  // Media Library Summary tab renders this directly. `reasons` carries
  // {kind, label, severity} objects (severity ∈ positive | caution | negative)
  // — broader than the prior [String] shape, so consumers should read the
  // object form. Old String entries are tolerated but unused.
  adSuitability: {
    score:     Number,                                                          // 0..10 composite, 1 decimal
    reasons:   { type: [mongoose.Schema.Types.Mixed], default: [] },            // [{kind, label, severity}, ...]
    metrics:   mongoose.Schema.Types.Mixed,                                     // raw signals consumed by the score (debug)
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
        // 'mixed'      — own-product AND competitor signals on the same Media
        //                (e.g. UGC frame with multiple brands). Treated as
        //                competitor by adSuitabilityService.
        // 'do_not_use' — brand-safety hard-stop or multi-brand block from
        //                productMatchService. Not currently emitted into
        //                detectSummary today, but reserved.
        enum: ['own_product', 'competitor', 'mixed', 'category', 'no_products', 'do_not_use', 'pending'],
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
mediaSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  // Capture insert-vs-update so the post('save') hook below can
  // fire only on new inserts. `isNew` is reset to false by Mongoose
  // before post hooks run, so we have to stash it ourselves.
  this._wasNew = this.isNew;
  next();
});

// Post-save event-trigger — when a new Instagram Media lands,
// kick off mediaInsightsService.fetchCommentsForMedia in the
// background. Same "lambda when record lands" pattern: zero
// coupling to the caller (post-sync / webhook / future routes
// all benefit), fire-and-forget so the save itself isn't slowed
// down. Brand-safety eval inside the detect pipeline reads from
// the Comment collection so populating it before the DetectRun
// gets to its product-match phase tightens UGC matching quality.
//
// Guards:
//   - IG only (V1 — TikTok/Meta have different comment APIs)
//   - Image only (video comment ingest deferred — different
//     pagination + lower payoff)
//   - Inserts only (skip on every plain field update)
mediaSchema.post('save', function(doc) {
  if (!doc._wasNew) return;
  if (doc.source !== 'instagram') return;
  if (doc.fileType !== 'image') return;
  setImmediate(() => {
    try {
      const { fetchCommentsForMedia } = require('../services/mediaInsightsService');
      fetchCommentsForMedia(doc._id)
        .then(r => {
          if (r?.ok) console.log(`💬 auto-fetched ${r.upserted || 0} comment(s) for media ${doc._id}`);
        })
        .catch(err => console.warn(`   ⚠️  auto-comment-fetch failed for media ${doc._id}: ${err.message}`));
    } catch (err) {
      console.warn(`   ⚠️  auto-comment-fetch dispatch failed: ${err.message}`);
    }
  });
});

module.exports = mongoose.model('Media', mediaSchema);
