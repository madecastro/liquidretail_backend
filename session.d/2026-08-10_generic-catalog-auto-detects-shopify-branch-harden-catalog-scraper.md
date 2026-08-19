## 2026-08-10 — Generic catalog auto-detects Shopify (branch `harden/catalog-scraper`)

**Defect (prod sweep):** brands on `apifyDemo.method=generic-sitemap` that are actually
Shopify stored **zero alt images** (PB5Star 100/0, Fellow 9/0). Shopify JSON-LD
`Product.image` is a single featured image; `/products.json` has the full gallery
(pb5star mean 7.91). Living Spaces (not Shopify) was fine on sitemap+JSON-LD.

**Fix (UNCOMMITTED on this worktree):** pure `siteFingerprintService` +
`GENERIC_CATALOG_AUTODETECT` (default true) inside `resolveGenericCatalog` delegates
to existing `shopifyAccessResolver` ladder; shared `mapShopifyNormalizedToFlat`;
`CatalogProduct.source` stamped `'shopify-direct'` when the ladder wins. Flag-off =
byte-identical prior path. Harness `scripts/verifySiteFingerprint.js` 29/29;
full gate was **78 pass / 0 fail** (now 79 with browser-session harness). Live
PB5Star / Living Spaces re-runs NOT done here — reviewer should sync those brands.

