// Load the Category ancestor chain for a CatalogProduct, ordered leaf→root.
// Used by the video-settings / title-style cascades so category-tier
// overrides sit between product and brand (most-specific wins).
//
// Strategy (2 queries, no recursion):
//   1. Load the leaf by product.categoryRef.
//   2. Build cumulative prefixes of leaf.breadcrumbKey (separator '>') and
//      fetch every ancestor+self in one $in query, sorted by depth DESC.
//
// Returns [] when the product has no categoryRef or the leaf is missing.

'use strict';

const Category = require('../models/Category');

/**
 * @param {object|null} product — CatalogProduct (or lean) with categoryRef
 * @returns {Promise<object[]>} lean Category docs ordered leaf → root
 */
async function loadCategoryChainForProduct(product) {
  if (!product?.categoryRef) return [];

  const leaf = await Category.findById(product.categoryRef).lean();
  if (!leaf) return [];

  const key = String(leaf.breadcrumbKey || '');
  if (!key) return [leaf];

  // e.g. 'a>b>c' → ['a', 'a>b', 'a>b>c']
  const segments = key.split('>').filter(Boolean);
  if (!segments.length) return [leaf]; // malformed key → at least apply the leaf's own settings

  const prefixes = [];
  for (let i = 0; i < segments.length; i++) {
    prefixes.push(segments.slice(0, i + 1).join('>'));
  }

  const rows = await Category.find({
    brandId: leaf.brandId,
    breadcrumbKey: { $in: prefixes }
  }).lean();
  if (!rows.length) return [leaf]; // ancestor query returned nothing → keep the loaded leaf

  // Order leaf → root by breadcrumbKey SEGMENT COUNT desc. Uses the key's own
  // segment count (always present + correct) rather than the stored `depth`
  // field, so ordering can't invert on a stale/missing depth. Nodes in one
  // chain are nested prefixes → segment counts are all distinct (no ties).
  const segCount = (c) => String(c?.breadcrumbKey || '').split('>').filter(Boolean).length;
  rows.sort((a, b) => segCount(b) - segCount(a));

  return rows;
}

module.exports = {
  loadCategoryChainForProduct
};
