// Stage 4 artifact: provider matches (Gemini grounded search, Google Lens,
// future providers) + GPT-4.1 reasoner identification + SerpAPI shopping
// details + Gemini-synthesized review summary.

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

  // Phase 1.7c — category-level reviews snapshot for THIS specific category
  // (keyed by brandCategory.breadcrumb). Distinct from brandReviews
  // (overall brand sentiment) and productReviews (specific SKU sentiment).
  // Fed by categoryReviewsService — cache-aware, may be null on first hit
  // (background fetch lands on next run). Used by Phase 1.7c category-level
  // comments and as a fallback quote source for product-level comments.
  categoryReviews: mongoose.Schema.Types.Mixed,

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
  winner:           String,        // 'yolo' | 'gemini' | 'agree' | 'catalog' | null
  // Brand-level fallback collection page (filled when outcome='category')
  brandCategory:    mongoose.Schema.Types.Mixed,
  // Brand-level reviews (filled when outcome='branding')
  brandReviews:     mongoose.Schema.Types.Mixed,

  // ── Catalog provenance (Phase C) ──
  // matchSource: where the canonical product came from — 'ig-catalog'
  // when a brand-catalog row won the match, 'gemini-search' when the
  // remote provider chain won, 'both' when catalog + remote agreed.
  // null for brand_match / do_not_use (no specific product picked).
  matchSource:      { type: String, index: true },
  // Ref to the matched CatalogProduct row when matchSource includes
  // 'ig-catalog'. Lets downstream templates pull canonical title /
  // imageUrl / productUrl directly from the brand's authoritative
  // catalog instead of re-deriving from prose.
  catalogProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', default: null },
  // Snapshot of the matched catalog row + its match score, for audit
  // without requiring a join. Cleared on subsequent runs.
  catalogMatch:     mongoose.Schema.Types.Mixed,
  // Product-level reviews snapshot — present only on cache HITS at
  // match time. Misses fire-and-forget and the value lands on the
  // CatalogProduct for next time, so artifacts created before the
  // background fetch finished will read null here.
  productReviews:   mongoose.Schema.Types.Mixed,

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProductMatchArtifact', productMatchArtifactSchema);
