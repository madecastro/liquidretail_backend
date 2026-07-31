// Pure JSON-LD breadcrumb parser — no axios / network / DB deps.
//
// Extracted from productCategoryInferenceService so BOTH it and the
// catalog scanner (genericCatalogResolver) can parse a PDP's category
// breadcrumb from HTML that's already in hand, without the resolver (or
// its no-network unit tests) having to pull in axios transitively.

'use strict';

// Breadcrumb names come out of a <script> block, so character references
// are still encoded — "Table &#x2B; Buffet Lamps", and separators
// themselves ("&#x203A;" for ›) which the Product.category split below
// depends on seeing as real characters.
const { cleanScrapedText } = require('../utils/htmlEntities');

// Top-level breadcrumb segments that are navigation chrome, not real
// categories. Filtered out so "Home > Mens > Tops" becomes "Mens > Tops".
const BREADCRUMB_SKIP = new Set([
  'home', 'shop', 'all', 'products', 'all products',
  'catalog', 'store', 'browse', 'main', 'index'
]);

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch {
      // Some sites wrap JSON-LD in HTML comments or have trailing commas.
      // Skip rather than try to repair — we'll still find structured data
      // in other blocks on the same page.
    }
  }
  return blocks;
}

// Recursively walk a JSON-LD node looking for objects of the given @type.
// Handles @graph wrappers (Yoast / Shopify use them) and Arrays.
function findByType(node, type, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) {
    for (const item of node) findByType(item, type, acc);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  const t = node['@type'];
  if (t === type || (Array.isArray(t) && t.includes(type))) acc.push(node);
  if (node['@graph']) findByType(node['@graph'], type, acc);
  return acc;
}

function normalizeBreadcrumb(items) {
  if (!Array.isArray(items)) return null;
  const names = items
    .map(it => {
      if (typeof it === 'string') return cleanScrapedText(it);
      // BreadcrumbList items can be: { name } or { item: { name } } or { item: "...", name: "..." }
      const n = it?.name || it?.item?.name || null;
      return cleanScrapedText(n);
    })
    .filter(Boolean)
    .filter(n => !BREADCRUMB_SKIP.has(n.toLowerCase()));
  if (!names.length) return null;
  return names;
}

// Main parser. Tries BreadcrumbList first (most accurate); falls back to
// Product.category (often "Apparel > Mens > Tops" style strings).
function extractBreadcrumb(html) {
  const blocks = extractJsonLdBlocks(html);
  if (!blocks.length) return null;

  // BreadcrumbList — preferred.
  for (const block of blocks) {
    const lists = findByType(block, 'BreadcrumbList');
    for (const list of lists) {
      const names = normalizeBreadcrumb(list.itemListElement);
      if (names && names.length >= 1) return { breadcrumb: names, source: 'breadcrumbList' };
    }
  }

  // Product.category — fallback.
  for (const block of blocks) {
    const products = findByType(block, 'Product');
    for (const p of products) {
      if (!p.category) continue;
      const raw = cleanScrapedText(p.category) || '';
      // Common separators: > / › → →
      const names = raw.split(/[>/›→]+/).map(s => s.trim()).filter(Boolean)
        .filter(n => !BREADCRUMB_SKIP.has(n.toLowerCase()));
      if (names.length) return { breadcrumb: names, source: 'productCategory' };
    }
  }

  return null;
}

module.exports = {
  BREADCRUMB_SKIP,
  extractJsonLdBlocks,
  findByType,
  normalizeBreadcrumb,
  extractBreadcrumb
};
