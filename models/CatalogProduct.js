// Brand-scoped catalog product, populated from third-party inventory
// sources (V1: Instagram Commerce / Meta Catalog). Distinct from the
// legacy `Product` model which is the truck/Shopify inventory path —
// this one is brand catalog data the matching service consults at
// detect time.
//
// Idempotency: (brandId, externalId) is the natural key. Re-syncs
// upsert in place so reruns don't multiply rows.

const mongoose = require('mongoose');
const { normalizeTitle } = require('../utils/titleNormalize');

const catalogProductSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      required: true, index: true },

  // External identity. `source` lets us add TikTok / Shopify catalogs
  // later without a second model. `externalId` is whatever the source
  // calls its product ID (Meta's product_item id, the merchant's
  // retailer_id, etc). 'manual-upload' is for products users add
  // directly via the Upload tab; 'detect-identified' is for drafts
  // auto-created from confident detect matches when the brand has
  // opted in.
  source:       {
    type: String,
    enum: ['ig-catalog', 'manual-upload', 'detect-identified'],
    required: true,
    index: true
  },
  externalId:   { type: String, required: true, index: true },
  retailerId:   String,    // merchant SKU when distinct from externalId

  // Meta's variant-grouping signal. Shopify-via-Meta sets this to a
  // shared id across size/color/scent variants of the same parent
  // product (e.g. all 8 sizes of "HCO Original" share one
  // item_group_id). We use it to collapse the detect fanout: only the
  // primary variant of each group runs the full pipeline; siblings
  // skip enqueue because they share imagery anyway.
  //
  // Sparse — merchants that don't set up product groups in Meta will
  // have this null, in which case enqueueBrandProductDetects falls
  // back to grouping by nameNormalized.
  itemGroupId:  { type: String, index: true, sparse: true },

  // Primary-of-group marker set by enqueueBrandProductDetects when it
  // resolves which variant runs detect. True for one row per
  // (brandId, itemGroupId || nameNormalized) group; false for the
  // rest. The match service can filter to primaries to avoid scoring
  // the same image 8 times across variants.
  isPrimaryVariant: { type: Boolean, default: false, index: true },

  // Pointer to the variant family's primary CatalogProduct. Null on
  // primaries (and on rows that don't belong to any variant family).
  // Non-primaries set this to their family's primary._id at variant-
  // collapse time so downstream consumers (matchedMedia inheritance,
  // catalog browser matchCount $lookup, etc.) can resolve to the
  // primary's data without rebuilding the grouping logic at read time.
  primaryProductId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CatalogProduct',
    default: null,
    index: true
  },

  // Draft state — true when the row was auto-created from detect or
  // a partial manual upload and is missing commerce-required fields
  // (price, productUrl). The catalog browser filters drafts into a
  // separate completion queue. Flip false once the user fills in
  // the missing fields.
  draft:        { type: Boolean, default: false, index: true },

  // Back-pointer to the Media that triggered detect-identified
  // creation. Lets the drafts UI deep-link "see this product in the
  // detect view." Null for ig-catalog and manual-upload rows.
  detectedFromMediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null },

  // V3 #2 — universal product identifiers used to dedup the same SKU
  // across tenants. gtin = EAN/UPC barcode (the most reliable signal);
  // mpn = manufacturer part number (fallback). Both indexed sparsely
  // because Meta only fills them when the brand provides them.
  gtin:         { type: String, index: true, sparse: true },
  mpn:          { type: String, index: true, sparse: true },

  // Display + commerce
  title:        { type: String, required: true },
  // Lowercased, promo-stripped, separator-flattened form of `title`,
  // computed in the pre-save hook below. Used as the match key by
  // productMatchService.ensureCatalogProductForMatch so that promo
  // suffixes ("Subscribe and Save 30% Off applied") and separator
  // variants ("-", "—", ":") don't spawn phantom detect-identified
  // rows for the same SKU. Indexed for fast (brandId, normalizedTitle)
  // lookups.
  normalizedTitle: { type: String, default: null, index: true },
  description:  String,
  brand:        String,    // Meta's "brand" field (often the brand name)
  category:     String,    // Meta's category string (taxonomy varies)
  price:        Number,    // numeric only — currency stored separately
  currency:     String,
  availability: String,    // "in stock" | "out of stock" | etc.

  // Imagery
  imageUrl:        String,    // primary image (hero)
  additionalImages: [String], // alt views — capped at 4 by the
                              // product-path detect trigger so a
                              // long-tail of look-alike alts doesn't
                              // multiply pipeline cost without value.

  // Wrapper Media docs created by catalogProductDetectService when
  // the catalog sync triggers the product-path detect pipeline.
  // imageMediaId points at the hero's Media (full artifact set);
  // additionalImageMediaIds[] points at the alt wrappers (crops +
  // palette only). Empty/absent until the first product-path run
  // completes for this product.
  imageMediaId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Media', default: null },
  additionalImageMediaIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Media' }],

  // Destination
  productUrl:   String,

  // Provenance + raw payload for debugging / future field unlocks.
  // Limited to ~8KB so a chatty source doesn't bloat the doc.
  rawData:      mongoose.Schema.Types.Mixed,

  // Lazy-fetched product-level review snapshot. Populated the first
  // time this row wins a product_match outcome via Gemini grounded
  // search, then served from cache for ~30 days. Same shape as
  // Brand.brandReviews so consumers can reuse the same render code.
  //   { quotes: [{ text, author, source }],
  //     rating: 0-5 | null,
  //     reviewCount: number | null,
  //     summary: string | null,
  //     fetchedAt: Date }
  productReviews: mongoose.Schema.Types.Mixed,

  // ── Phase 2f — Immersive Product fields owned here (was on match artifact) ──
  //
  // CatalogProduct is the canonical home for product-page data. The
  // match artifact references this row via FK; consumers join in to get
  // commerce + review data in their authoritative form.
  //
  // Populated by productDetailsService.fetchProductDetails when called
  // with this catalogProductId; refreshed every 30 days. Idempotent
  // write-through.
  rating:              Number,                            // 0-5 from Immersive product_results.rating
  ratingDistribution:  { type: [mongoose.Schema.Types.Mixed], default: [] },  // [{stars, count}, ...] from Immersive
  reviews:             { type: [mongoose.Schema.Types.Mixed], default: [] },  // individual review rows (top 10) from Immersive
  specs:               { type: mongoose.Schema.Types.Mixed, default: null },  // Immersive product_results.specifications
  sellers:             { type: [mongoose.Schema.Types.Mixed], default: [] },  // Aggregated google_shopping shopping_results
  reviewSummary:       mongoose.Schema.Types.Mixed,                            // Gemini narrative — distinct from productReviews.summary
  detailsRefreshedAt:  Date,                                                    // 30-day TTL marker for the four Immersive fields above

  // Phase 2a — FK to the leaf Category row this product belongs to
  // (e.g. the "Mens > Tops > Performance Shirts" leaf). Replaces the
  // freeform `category` string above as the relational link; the
  // string field stays for legacy + raw-source debugging. Resolved
  // by findOrCreateCategoryTree at match time when productCategory
  // service produces a breadcrumb.
  categoryRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },

  // Bidirectional match denormalization — mirror of Media.matchedProducts.
  // Populated by detect after each DetectRun completes the match phase.
  // matchTier:
  //   product_match     — Media's PMA pointed exactly at this product
  //   product_category  — this product was in the PMA's recommendedProducts[]
  // brand_match is NOT mirrored here — it isn't per-product (would require
  // writing every brand_match media to every product in the brand). Brand-
  // tier seeds stay a query at expansion time.
  //
  // Idempotency: dedup on (mediaId, matchEvidenceArtifactId) at write time
  // via $pull + $addToSet, so re-running detect for the same media replaces
  // the prior entry rather than accumulating duplicates.
  matchedMedia: [{
    mediaId:                 { type: mongoose.Schema.Types.ObjectId, ref: 'Media' },
    matchTier:               String,   // 'product_match' | 'product_category'
    confidence:              Number,
    refinedProductId:        String,
    matchEvidenceArtifactId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductMatchArtifact' },
    matchedAt:               Date,
    _id: false
  }],

  firstSeenAt:  { type: Date, default: Date.now },
  lastSyncedAt: { type: Date, default: Date.now }
});

// Natural key: one row per (brand, externalId).
catalogProductSchema.index({ brandId: 1, externalId: 1 }, { unique: true });
// Match-service lookups: by brand + category and by brand + text.
catalogProductSchema.index({ brandId: 1, category: 1 });
// Drafts queue — fast filter for catalog-browser drafts tab.
catalogProductSchema.index({ brandId: 1, draft: 1 });
// Inverse-lookup for "what products did this media match" reads —
// matchedMedia.mediaId is the natural key for the per-product seed pass.
catalogProductSchema.index({ 'matchedMedia.mediaId': 1 });
// Tenant-scoped normalized-title lookup for ensureCatalogProductForMatch
// step 2 (find before create).
catalogProductSchema.index({ brandId: 1, normalizedTitle: 1 });

catalogProductSchema.pre('save', function(next) {
  if (this.isModified('title') || this.normalizedTitle == null) {
    this.normalizedTitle = normalizeTitle(this.title);
  }
  next();
});

// findOneAndUpdate / updateOne paths bypass the save hook; recompute
// normalizedTitle when title is being set in an update operation so the
// field stays consistent regardless of write style.
catalogProductSchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate() || {};
  const set = update.$set || update;
  if (set && typeof set.title === 'string') {
    if (update.$set) update.$set.normalizedTitle = normalizeTitle(set.title);
    else update.normalizedTitle = normalizeTitle(set.title);
  }
  next();
});

module.exports = mongoose.model('CatalogProduct', catalogProductSchema);
