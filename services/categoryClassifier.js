// Coarse category classifier — bridges the YOLO/Gemini identify enum
// space (apparel, food_beverage, …) and the Category tree.
//
// Why this exists: the detect pipeline's pre-match candidate filter
// (productMatchService.findCatalogMatchByText) needs to narrow the
// CatalogProduct set to "plausibly the right kind of thing" before
// running the visual matcher. Refined products from YOLO/Gemini carry
// a coarse `category` enum; CatalogProducts get a fine-grained
// `categoryRef` only AFTER they've been successfully matched once and
// productCategoryService has run GPT-4.1 to derive a breadcrumb.
//
// To make the filter useful on freshly-synced rows that haven't been
// matched yet, catalogSyncService stamps a COARSE categoryRef at sync
// time by:
//   1. Inferring the enum from Meta's `category` string + product title
//      via inferCoarseEnum().
//   2. Resolving (or creating) the brand's coarse Category leaf via
//      resolveCoarseCategoryRef().
//   3. Setting CatalogProduct.categoryRef to that leaf when null.
//
// At match time, productMatchService prepends the coarse breadcrumb to
// the GPT-derived fine breadcrumb so the fine leaf becomes a descendant
// of the coarse root, e.g. "Food & Beverage > Pasta". The pre-match
// filter then collects every Category whose breadcrumbKey starts with
// the coarse key and filters by `categoryRef ∈ subtreeIds`. Both
// coarse-stamped-not-yet-matched rows AND fine-stamped-after-match
// rows land in the same subtree.

const Category = require('../models/Category');
const { findOrCreateCategoryTree, breadcrumbToKey } = Category;

// Enum → human-readable coarse breadcrumb. The breadcrumbs are the
// depth-0 names that all fine-grained leaves get prefixed with.
// `other` intentionally maps to null so unclassifiable products don't
// get bucketed into a misleading parent.
const ENUM_TO_COARSE_BREADCRUMB = {
  apparel:       'Apparel',
  electronics:   'Electronics',
  food_beverage: 'Food & Beverage',
  home:          'Home',
  toys:          'Toys',
  tools:         'Tools',
  beauty:        'Beauty',
  sports:        'Sports',
  accessories:   'Accessories'
};

// Keyword sets per bucket. Matching is case-insensitive substring; the
// first bucket that matches wins. Order matters when keywords overlap:
// apparel/beauty/accessories before food_beverage so a "salt body
// scrub" reads as beauty, not food. For brand catalogs heavy in one
// vertical, mis-bucketing the long tail is acceptable — even a
// coarse-but-wrong filter still falls back to the full catalog via the
// `<3 candidates` guard in findCatalogMatchByText.
const ENUM_KEYWORDS = {
  apparel: [
    'shirt', 'tee', 't-shirt', 't shirt', 'hoodie', 'hat', 'cap',
    'beanie', 'jacket', 'coat', 'pants', 'jeans', 'shorts', 'dress',
    'skirt', 'sock', 'socks', 'sweater', 'polo', 'scarf', 'apparel',
    'clothing', 'wear', 'jersey', 'uniform'
  ],
  beauty: [
    'makeup', 'lipstick', 'perfume', 'cologne', 'cosmetic', 'skincare',
    'shampoo', 'conditioner', 'cream', 'lotion', 'serum', 'mascara',
    'foundation', 'concealer', 'beauty'
  ],
  accessories: [
    'watch', 'wallet', 'jewelry', 'sunglasses', 'belt', 'necklace',
    'ring', 'bracelet', 'earring', 'handbag', 'purse', 'backpack',
    'tote', 'accessories', 'accessory'
  ],
  electronics: [
    'phone', 'laptop', 'charger', 'cable', 'headphone', 'earbud',
    'speaker', 'camera', 'tablet', 'electronic', 'battery', 'monitor',
    'console'
  ],
  food_beverage: [
    'food', 'beverage', 'drink', 'snack', 'condiment', 'spice', 'salt',
    'seasoning', 'jam', 'jelly', 'syrup', 'cheese', 'milk', 'coffee',
    'tea', 'wine', 'beer', 'pasta', 'oil', 'sauce', 'chili', 'honey',
    'soda', 'juice', 'candy', 'chocolate', 'cookie', 'bar', 'crisp',
    'crispy', 'crispies', 'hot sauce', 'olive oil', 'salsa', 'rub',
    'marinade', 'broth', 'soup'
  ],
  home: [
    'pillow', 'blanket', 'candle', 'decor', 'lamp', 'towel', 'sheet',
    'rug', 'vase', 'furniture', 'cookware', 'plate', 'cup', 'bowl',
    'mug', 'glassware', 'cutting board', 'kitchen'
  ],
  tools: [
    'wrench', 'hammer', 'drill', 'knife', 'blade', 'saw', 'pliers',
    'screwdriver', 'toolkit'
  ],
  toys: [
    'toy', 'plush', 'doll', 'puzzle', 'lego', 'board game'
  ],
  sports: [
    'ball', 'racket', 'racquet', 'helmet', 'bike', 'bicycle', 'fitness',
    'yoga', 'gym', 'running', 'cleat', 'snowboard', 'surfboard',
    'skateboard'
  ]
};

// Order to try enum buckets in. apparel/beauty/accessories first so
// product names that incidentally contain food words (e.g. "salt body
// scrub") still bucket correctly. Iteration order is preserved by
// JavaScript objects so this is just the spec we read off in
// inferCoarseEnum.
const ENUM_PRIORITY = [
  'apparel', 'beauty', 'accessories', 'electronics',
  'food_beverage', 'home', 'tools', 'toys', 'sports'
];

// Infer the coarse enum from Meta's free-form category string + the
// product title. Returns one of ENUM_PRIORITY or null when nothing
// hits. Caller treats null as "leave categoryRef unstamped" — the
// pre-match filter then falls back to the full catalog for these.
function inferCoarseEnum(metaCategory, title) {
  const combined = `${metaCategory || ''} ${title || ''}`.toLowerCase();
  if (!combined.trim()) return null;
  for (const bucket of ENUM_PRIORITY) {
    const kws = ENUM_KEYWORDS[bucket];
    for (const k of kws) {
      // Word-boundary-ish check: surround keyword with non-letter
      // markers so "oil" doesn't match "toilet" or "boil". Simple
      // and good enough for product names.
      const pattern = new RegExp(`(^|[^a-z])${escapeRegExp(k.toLowerCase())}([^a-z]|$)`);
      if (pattern.test(combined)) return bucket;
    }
  }
  return null;
}

// Resolve (or create) the brand's coarse Category leaf for an enum.
// Returns the leaf Category._id, or null when the enum doesn't map
// (e.g. 'other' or an unrecognized value).
async function resolveCoarseCategoryRef({ brandId, advertiserId = null, enumCategory }) {
  const breadcrumb = ENUM_TO_COARSE_BREADCRUMB[enumCategory];
  if (!brandId || !breadcrumb) return null;
  return await findOrCreateCategoryTree({ brandId, advertiserId, breadcrumb });
}

// Return the coarse breadcrumb name for an enum (e.g. 'food_beverage'
// → 'Food & Beverage'), or null when the enum is unmapped. Used by
// productMatchService to prefix fine breadcrumbs.
function getCoarseBreadcrumb(enumCategory) {
  return ENUM_TO_COARSE_BREADCRUMB[enumCategory] || null;
}

// Collect every Category._id whose breadcrumb is the coarse root or a
// descendant. The implementation uses breadcrumbKey prefix matching
// rather than parentId BFS: each Category's breadcrumbKey is the full
// normalized path ("food & beverage>pasta"), so descendants always
// start with `<coarseKey>>`. Single query, no recursion.
async function getCoarseSubtreeIds({ brandId, enumCategory }) {
  const coarseBreadcrumb = ENUM_TO_COARSE_BREADCRUMB[enumCategory];
  if (!brandId || !coarseBreadcrumb) return [];
  const coarseKey = breadcrumbToKey(coarseBreadcrumb);
  const rows = await Category.find({
    brandId,
    $or: [
      { breadcrumbKey: coarseKey },
      { breadcrumbKey: { $regex: `^${escapeRegExp(coarseKey)}>` } }
    ]
  }).select('_id').lean();
  return rows.map(r => r._id);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  ENUM_TO_COARSE_BREADCRUMB,
  inferCoarseEnum,
  resolveCoarseCategoryRef,
  getCoarseBreadcrumb,
  getCoarseSubtreeIds
};
