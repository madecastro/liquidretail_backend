// Phase 2a — Category collection.
//
// Normalized owner of category-level data within a brand. Replaces the
// denormalized Brand.categoryReviews[] subarray (kept as a deprecated
// read fallback during migration) and the snapshot copies on
// ProductMatchArtifact.brandCategory / categoryReviews.
//
// PARENT/CHILD TREE — categories are stored as a tree, one row per
// segment of a breadcrumb path. "Mens > Tops > Performance Shirts"
// produces three Category rows linked via parentId:
//
//   Mens                       (depth=0, parentId=null)
//     └ Tops                   (depth=1, parentId=Mens._id)
//         └ Performance Shirts (depth=2, parentId=Tops._id)  ← leaf
//
// Media and CatalogProduct reference the LEAF row. Aggregations across
// the tree (e.g., "all Mens products") work via parentId traversal.
//
// breadcrumbKey is the FULL normalized path (e.g., "mens>tops>performance shirts"),
// unique within a brand. So "Mens > Tops > Performance Shirts" on
// Pelagic Gear differs from the same breadcrumb on Patagonia.
//
// OWNED DATA:
//   categoryReviews — Gemini grounded reviews scoped to this category
//     (was: Brand.categoryReviews[<breadcrumbHash>])
//   url             — collection page URL on the brand's domain
//                     (was: ProductMatchArtifact.brandCategory.url snapshot)
//   description     — optional Gemini-derived or curated description
//
// RELATIONSHIPS (denormalized FK lists for read speed):
//   relatedProducts[] — CatalogProducts whose categoryRef points here
//   relatedMedia[]    — Medias matched at this category (matchedCategories[])
// These are caches; the source of truth is the FK on the related row.

const mongoose = require('mongoose');

// Normalize a breadcrumb string into a stable lookup key.
// "Mens > Tops > Performance Shirts" → "mens>tops>performance shirts"
function breadcrumbToKey(breadcrumb) {
  return String(breadcrumb || '').toLowerCase()
    .replace(/[^a-z0-9>]+/g, ' ')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split a breadcrumb path into ordered segments for tree-building.
function breadcrumbSegments(breadcrumb) {
  return String(breadcrumb || '')
    .split('>')
    .map(s => s.trim())
    .filter(Boolean);
}

const categorySchema = new mongoose.Schema({
  // Tenant scope.
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

  // Tree position
  parentId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
  depth:        { type: Number, default: 0 },

  // Category identity
  name:         { type: String, required: true },     // leaf segment, e.g. "Performance Shirts"
  breadcrumb:   { type: String, required: true },     // human-readable path, e.g. "Mens > Tops > Performance Shirts"
  breadcrumbKey:{ type: String, required: true, index: true }, // normalized for uniqueness

  // Brand-site collection page (where the brand sells this category)
  url:          String,
  // Optional category-level description (Gemini-derived or curated)
  description:  String,

  // Phase 2a — owned category-level reviews (Gemini grounded search snapshot).
  // Cache-aware via fetchedAt; 30-day TTL matches productReviews/brandReviews.
  // Shape: { quotes: [{text, author, source}], rating, reviewCount, summary, sources[], fetchedAt }
  categoryReviews: { type: mongoose.Schema.Types.Mixed, default: null },

  // Denormalized FK caches — relatedProducts list comes from
  // CatalogProduct.categoryRef pointing at this row; relatedMedia from
  // Media.matchedCategories[]. Maintained on best-effort basis; consumers
  // that need authoritative joins should still query by FK.
  relatedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct' }],
  relatedMedia:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Media' }],

  // Audit — first Media that surfaced this category (useful for "where did
  // this category come from").
  firstSeenMediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media' },
  firstSeenAt:      Date,
  lastSeenAt:       Date,

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// One Category row per breadcrumbKey per brand.
categorySchema.index({ brandId: 1, breadcrumbKey: 1 }, { unique: true });
// Tree-traversal helpers
categorySchema.index({ brandId: 1, parentId: 1 });
categorySchema.index({ brandId: 1, depth: 1 });

categorySchema.pre('save', function(next) { this.updatedAt = Date.now(); next(); });

const Category = mongoose.model('Category', categorySchema);

// Find-or-create the Category tree for a given breadcrumb. Creates the
// parent chain (top-down) when missing; returns the LEAF Category._id.
//
// Usage:
//   const leafId = await findOrCreateCategoryTree({
//     brandId,
//     advertiserId,
//     breadcrumb: 'Mens > Tops > Performance Shirts',
//     url: 'https://pelagicgear.com/collections/mens-performance',  // assigned to leaf only
//     firstSeenMediaId
//   });
//
// Defensive — invalid breadcrumb returns null. Each segment is upserted
// individually; race-safe via the unique (brandId, breadcrumbKey) index.
async function findOrCreateCategoryTree({
  brandId, advertiserId,
  breadcrumb,
  url = null,
  firstSeenMediaId = null
}) {
  if (!brandId || !breadcrumb) return null;
  const segments = breadcrumbSegments(breadcrumb);
  if (!segments.length) return null;

  let parentId = null;
  let lastId = null;
  let cumulative = '';
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i];
    cumulative = cumulative ? `${cumulative} > ${name}` : name;
    const key = breadcrumbToKey(cumulative);
    const isLeaf = (i === segments.length - 1);

    const update = {
      $setOnInsert: {
        brandId,
        advertiserId: advertiserId || null,
        parentId,
        depth: i,
        name,
        breadcrumb: cumulative,
        breadcrumbKey: key,
        firstSeenMediaId: isLeaf ? firstSeenMediaId : null,
        firstSeenAt: new Date()
      },
      $set: {
        lastSeenAt: new Date(),
        // Only the leaf gets the URL — parents are container nodes
        ...(isLeaf && url ? { url } : {})
      }
    };

    const row = await Category.findOneAndUpdate(
      { brandId, breadcrumbKey: key },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    lastId = row._id;
    parentId = row._id;
  }
  return lastId;
}

module.exports = Category;
module.exports.findOrCreateCategoryTree = findOrCreateCategoryTree;
module.exports.breadcrumbToKey = breadcrumbToKey;
module.exports.breadcrumbSegments = breadcrumbSegments;
