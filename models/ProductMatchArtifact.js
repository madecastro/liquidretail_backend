// Stage 4 artifact: per-run evidence record for one refined product's match.
// Snapshot of providers + reasoner identification + decision-tree outcome.
//
// Phase 2e — snapshot copies of normalized data have been removed. Consumers
// resolve the canonical state via FK joins (catalogProductId → CatalogProduct,
// categoryId → Category, brandId → Brand) using productMatchHydration.
// Removed fields:
//   brandCategory     → derived from Category.breadcrumb / Category.url
//   brandReviews      → Brand.brandReviews
//   productReviews    → CatalogProduct.productReviews
//   categoryReviews   → Category.categoryReviews
//   identification.details → CatalogProduct (rating, reviews, sellers, …)
//
// Pre-Phase-2e artifacts retain their snapshots in the DB; hydrateMatch
// falls back to those when the FK target is missing.

const mongoose = require('mongoose');

const productMatchArtifactSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      index: true, default: null },
  mediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media',     required: true, index: true },
  runId:   { type: mongoose.Schema.Types.ObjectId, ref: 'DetectRun', required: true, index: true },

  // Phase 1.7 — multiple ProductMatchArtifact docs per detect run, one per
  // refined product detection. productIndex is the index into the
  // DetectionArtifact.refinedProducts[] array (or yoloProducts[] when
  // Phase 1.6 refinement fell back) that this match represents. Null on
  // legacy artifacts that pre-date the per-product split.
  productIndex: { type: mongoose.Schema.Types.Mixed, default: null },
  // Combined catalog match score (max of text + visual). Persisted so
  // consumers can rank matches without re-deriving. Null on non-catalog
  // outcomes.
  catalogCombinedScore: { type: Number, default: null },
  // Visual catalog match score from visualCatalogMatchService (Gemini
  // Vision similarity between the refined crop and the catalog candidate's
  // imageUrl). Null when not run.
  catalogVisualScore: { type: Number, default: null },
  // Phase 1.7b — three-tier per-match enrichment surface:
  //   tier 1 'sku'      — productDetails + productReviews fired (product_match outcomes)
  //   tier 2 'category' — productCategory ran (product_match OR product_category outcomes; can fire alongside tier 1)
  //   tier 3 'brand'    — brandReviews fired (product_category OR brand_match outcomes)
  //   Multiple tiers can apply; stored as an array.
  enrichmentTiers: { type: [String], default: [] },
  // Phase 1.7b — recommended products surfaced for category-confirmed matches.
  // When outcome='product_category', the per-match enrichment queries the
  // brand's CatalogProduct collection for siblings in the same category and
  // attaches up to 5 here. Lets the layout/template generator surface
  // "recommended for you" content even when SKU-level identification missed.
  recommendedProducts: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Phase 2a — FK to the matched leaf Category row (when brandCategory
  // breadcrumb resolved). Consumers join through to Category for
  // breadcrumb / url / categoryReviews instead of reading snapshots.
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },

  query:        mongoose.Schema.Types.Mixed,
  // { brand, category, caption, primarySubject, textDetected[] }

  providers:    { type: mongoose.Schema.Types.Mixed, default: {} },
  errors:       { type: mongoose.Schema.Types.Mixed, default: {} },
  totalMatches: Number,

  // Identification evidence — { productName, brand, certainty,
  // certaintyLabel, reasoning, primaryUrl, primaryRetailer, primaryThumbnail,
  // evidenceUrls[] }. Phase 2e dropped the nested `details` block; its
  // commerce fields (rating, reviews, sellers, specs, …) live on the linked
  // CatalogProduct row.
  identification: mongoose.Schema.Types.Mixed,

  // Decision-tree outputs.
  outcome:          { type: String, index: true },
  outcomeReasoning: String,
  winner:           String,        // 'yolo' | 'gemini' | 'agree' | 'catalog' | null

  // ── Catalog provenance ──
  matchSource:      { type: String, index: true },   // 'ig-catalog' | 'gemini-search' | 'both' | null
  catalogProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null },
  // Snapshot of the matched catalog candidate at run time (title +
  // matchScore) — kept as evidence of WHY this row won. Distinct from
  // catalogProductId which points at the live row.
  catalogMatch:     mongoose.Schema.Types.Mixed,

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProductMatchArtifact', productMatchArtifactSchema);
