// Brand-scoped catalog product, populated from third-party inventory
// sources (V1: Instagram Commerce / Meta Catalog). Distinct from the
// legacy `Product` model which is the truck/Shopify inventory path —
// this one is brand catalog data the matching service consults at
// detect time.
//
// Idempotency: (brandId, externalId) is the natural key. Re-syncs
// upsert in place so reruns don't multiply rows.

const mongoose = require('mongoose');

const catalogProductSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      required: true, index: true },

  // External identity. `source` lets us add TikTok / Shopify catalogs
  // later without a second model. `externalId` is whatever the source
  // calls its product ID (Meta's product_item id, the merchant's
  // retailer_id, etc).
  source:       { type: String, enum: ['ig-catalog'], required: true, index: true },
  externalId:   { type: String, required: true, index: true },
  retailerId:   String,    // merchant SKU when distinct from externalId

  // V3 #2 — universal product identifiers used to dedup the same SKU
  // across tenants. gtin = EAN/UPC barcode (the most reliable signal);
  // mpn = manufacturer part number (fallback). Both indexed sparsely
  // because Meta only fills them when the brand provides them.
  gtin:         { type: String, index: true, sparse: true },
  mpn:          { type: String, index: true, sparse: true },

  // Display + commerce
  title:        { type: String, required: true },
  description:  String,
  brand:        String,    // Meta's "brand" field (often the brand name)
  category:     String,    // Meta's category string (taxonomy varies)
  price:        Number,    // numeric only — currency stored separately
  currency:     String,
  availability: String,    // "in stock" | "out of stock" | etc.

  // Imagery
  imageUrl:        String,    // primary image
  additionalImages: [String], // up to N alt views

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

  firstSeenAt:  { type: Date, default: Date.now },
  lastSyncedAt: { type: Date, default: Date.now }
});

// Natural key: one row per (brand, externalId).
catalogProductSchema.index({ brandId: 1, externalId: 1 }, { unique: true });
// Match-service lookups: by brand + category and by brand + text.
catalogProductSchema.index({ brandId: 1, category: 1 });

module.exports = mongoose.model('CatalogProduct', catalogProductSchema);
