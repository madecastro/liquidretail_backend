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

// FEED_TRUTH_CATEGORIES kill switch. DEFAULT ON. When on, catalogSync-
// Service uses resolveFeedCategoryRef below as its primary categoryRef
// source and downstream inferred paths (JSON-LD scrape, GPT-4.1 brand-
// nav) only fill in when categoryRef is still null. OFF restores the
// pre-change behaviour: coarse enum at sync + inferred overwrite at
// match time. Same fail-open shape as the other UGC-ads switches.
function isFeedTruthCategoriesEnabled() {
  const raw = process.env.FEED_TRUTH_CATEGORIES;
  if (raw == null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// Resolve the brand's Category leaf directly from the merchant feed's
// category string, WITHOUT going through the 9-bucket coarse enum. This
// is the "feed truth as default" path — whatever the merchant published
// (Google Product Taxonomy breadcrumbs, Shopify product_type singles,
// or hand-authored strings) becomes the leaf.
//
// Two shapes supported:
//   • Rich breadcrumb: "Apparel & Accessories > Clothing > Shirts" →
//     multi-level tree via findOrCreateCategoryTree (segments split on
//     '>'). Common for Meta feeds populated from google_product_category.
//   • Single term: "Shirts" → depth-0 leaf. Common for Shopify
//     product_type. Still preserves the merchant's own naming — a
//     brand-scoped "Shirts" leaf is more useful than a 9-bucket
//     "Apparel" bucket that flattens everything.
//
// Returns { categoryId, source } or null when feedCategory is empty
// (caller falls through to the coarse-enum path).
async function resolveFeedCategoryRef({ brandId, advertiserId = null, feedCategory }) {
  if (!brandId) return null;
  const cleaned = String(feedCategory || '').trim();
  if (!cleaned) return null;
  const categoryId = await findOrCreateCategoryTree({
    brandId,
    advertiserId,
    breadcrumb: cleaned
  });
  if (!categoryId) return null;
  const source = cleaned.includes('>') ? 'feed-breadcrumb' : 'feed-single';
  return { categoryId, source };
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

// Unified categoryRef stamper — same policy every ingest path applies
// on upsert: feed truth first when enabled, coarse enum as fallback.
// Returns { categoryId, source } on success or null when neither path
// resolves. Never throws — a stamp failure at any tier returns null
// and the caller logs + moves on (matches the historical best-effort
// pattern in catalogSyncService).
//
// USAGE:
//   const ref = await stampFeedTruthCategoryRef({
//     brandId, advertiserId, feedCategory: row.category, title: row.title
//   });
//   if (ref) {
//     await CatalogProduct.updateOne(
//       { _id: doc._id, $or: [{ categoryRef: null }, { categoryRef: { $exists: false } }] },
//       { $set: { categoryRef: ref.categoryId } }
//     );
//   }
//
// The null-guard on the update is what makes this idempotent across
// re-syncs — an inferred stamp (JSON-LD scrape, GPT-4.1 brand-nav)
// that landed between syncs stays authoritative, matching the owner
// rule that feed truth is the DEFAULT but doesn't clobber a later
// higher-signal inference. If you WANT to overwrite (e.g. a
// dedicated backfill), skip the null-guard.
async function stampFeedTruthCategoryRef({ brandId, advertiserId = null, feedCategory, title }) {
  if (!brandId) return null;
  // Tier 1 — feed truth from the raw feed string (rich breadcrumb or
  // single term). Gated by FEED_TRUTH_CATEGORIES so ops can revert.
  if (isFeedTruthCategoriesEnabled()) {
    const feedRef = await resolveFeedCategoryRef({ brandId, advertiserId, feedCategory });
    if (feedRef) return feedRef;
  }
  // Tier 2 — 9-bucket coarse enum. Historic behaviour when the feed
  // string doesn't parse into anything; still useful for search + the
  // pre-match filter's subtree scan.
  const enumCategory = inferCoarseEnum(feedCategory, title);
  if (enumCategory) {
    const coarseRef = await resolveCoarseCategoryRef({ brandId, advertiserId, enumCategory });
    if (coarseRef) return { categoryId: coarseRef, source: 'coarse-enum' };
  }
  return null;
}

// Apply a resolved feed-truth stamp to a CatalogProduct row. Handles
// three cases in one call so the ingest paths don't have to reimplement
// rename detection:
//
//   INSERT   — product.categoryRef is null/missing → stamp
//   NOOP     — product.categoryRef already points at feed truth OR at
//              a Category whose breadcrumbKey matches (no change needed)
//   RENAME   — product.categoryRef points at a DIFFERENT Category from
//              the current feed-truth resolution → overwrite with the
//              new leaf id
//
// The rename case is what makes re-sync propagate a merchant's rename
// (e.g. "Shirts" → "Tops") without a separate backfill: the ingest
// loop already calls stampFeedTruthCategoryRef every pass, and this
// helper now diverts to overwrite when the current ref has drifted.
//
// Callers pass the product row (already loaded post-upsert) so we
// don't re-read it. If the caller has only the id, they can pass
// { _id, categoryRef } and it still works.
//
// Best-effort like the surrounding stamping code — never throws.
// Returns { action, from?, to?, categoryId? } for the caller to log.
async function applyFeedTruthStamp(product, stamp) {
  if (!product || !stamp?.categoryId) return { action: 'no-stamp' };
  const CatalogProduct = require('../models/CatalogProduct');
  const Category = require('../models/Category');

  // INSERT — no existing ref. Guarded write in case a concurrent
  // process set the ref between load and update.
  if (!product.categoryRef) {
    try {
      await CatalogProduct.updateOne(
        { _id: product._id, $or: [{ categoryRef: null }, { categoryRef: { $exists: false } }] },
        { $set: { categoryRef: stamp.categoryId } }
      );
      return { action: 'inserted', to: String(stamp.categoryId) };
    } catch (err) {
      return { action: 'error', error: err.message };
    }
  }

  // Fast NOOP path — same id, no read needed.
  if (String(product.categoryRef) === String(stamp.categoryId)) {
    return { action: 'noop', reason: 'ref-matches' };
  }

  // Rename detection — compare breadcrumbKeys. Two ids can point at
  // the SAME normalized path in rare race cases (e.g. cascade-delete
  // + re-insert while the sync is running); treat those as noop too.
  try {
    const [currentCat, newCat] = await Promise.all([
      Category.findById(product.categoryRef).select('breadcrumbKey deletedAt').lean(),
      Category.findById(stamp.categoryId).select('breadcrumbKey').lean()
    ]);
    if (!newCat) return { action: 'noop', reason: 'new-category-missing' };
    // If the current ref is tombstoned OR the keys differ, overwrite.
    // Same-key + non-tombstoned = true noop.
    const isTombstoned = !!currentCat?.deletedAt;
    const keysDiffer   = currentCat?.breadcrumbKey !== newCat.breadcrumbKey;
    if (!isTombstoned && !keysDiffer) {
      return { action: 'noop', reason: 'key-matches' };
    }
    await CatalogProduct.updateOne(
      { _id: product._id },
      { $set: { categoryRef: stamp.categoryId } }
    );
    return {
      action: isTombstoned ? 'rehomed-from-tombstone' : 'renamed',
      from:   currentCat?.breadcrumbKey || null,
      to:     newCat.breadcrumbKey,
      categoryId: String(stamp.categoryId)
    };
  } catch (err) {
    return { action: 'error', error: err.message };
  }
}

module.exports = {
  ENUM_TO_COARSE_BREADCRUMB,
  inferCoarseEnum,
  resolveCoarseCategoryRef,
  resolveFeedCategoryRef,
  stampFeedTruthCategoryRef,
  applyFeedTruthStamp,
  isFeedTruthCategoriesEnabled,
  getCoarseBreadcrumb,
  getCoarseSubtreeIds
};
