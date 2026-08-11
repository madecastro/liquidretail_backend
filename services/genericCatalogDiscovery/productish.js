// Pure product-URL heuristic for sitemap ranking.
// No requires, no I/O — higher score = more likely a product detail page.
// isProductish is the back-compat boolean: scoreProductish(loc) > 0.

'use strict';

// Positive signals. Each contributes at most once (cap per signal).
// products? covers Shopify /products/… as well as singular "product".
const WORD_PRODUCT = /\bproducts?\b/i;
const WORD_PDP = /\bpdp\b/i;
const WORD_ITEM = /\bitem\b/i;
const WORD_CATALOG = /\bcatalog\b/i;
const WORD_SHOP = /\bshop\b/i;
const WORD_STORE = /\bstore\b/i;
// Product-id segment: fanatics `+p-12345678`, `/p123`, `/p-123`, `p_12345`.
const PRODUCT_ID_SEG = /(?:^|[+/_\-])p[-_]?\d{3,}(?:[+/?#]|$)/i;
// Trailing numeric slug id: `foo-bar-12345` / `...-98765?x=1`.
const TRAILING_NUMERIC = /-\d{5,}(?:[/?#]|$)/;
// Listing / nav / utility path segments (strong demotion).
const LISTING_SEG = /\/(collections?|categor(?:y|ies)|search|cart|account|checkout|blogs?|pages?|policies|sitemap|login|wishlist)(\/|$)/i;

/**
 * scoreProductish(loc) → signed number. Higher = more product-detail-like.
 * Null / empty / non-string coerce safely; unremarkable URLs score 0.
 */
function scoreProductish(loc) {
  if (loc == null) return 0;
  const s = String(loc);
  if (!s) return 0;

  let score = 0;

  // Positive (+2 each, once). Tracked separately: a STRONG signal means the
  // URL names a product detail page, which suppresses the listing demotion
  // below.
  let strong = false;
  if (WORD_PRODUCT.test(s)) { score += 2; strong = true; }
  if (WORD_PDP.test(s)) { score += 2; strong = true; }
  if (WORD_ITEM.test(s)) { score += 2; strong = true; }
  if (PRODUCT_ID_SEG.test(s)) { score += 2; strong = true; }

  // Positive (+1 each, once)
  if (TRAILING_NUMERIC.test(s)) score += 1;
  if (WORD_CATALOG.test(s)) score += 1;
  if (WORD_SHOP.test(s)) score += 1;
  if (WORD_STORE.test(s)) score += 1;

  // Negative (−3 once if any listing/nav segment matches) — but ONLY when no
  // strong product signal fired. Shopify legitimately serves collection-scoped
  // PDPs at /collections/<c>/products/<handle>: those carry BOTH a listing
  // segment and a product segment, and the old boolean PRODUCTISH_RE ranked
  // them product-ish. Demoting them would sort real PDPs to the back of the
  // queue and drop them on any store that hits MAX_SITEMAP_URLS or the cap.
  if (!strong && LISTING_SEG.test(s)) score -= 3;

  return score;
}

/** Back-compat: true iff scoreProductish(loc) > 0. */
function isProductish(loc) {
  return scoreProductish(loc) > 0;
}

module.exports = { scoreProductish, isProductish };
