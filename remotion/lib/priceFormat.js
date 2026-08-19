// Pure price-formatting helper shared by remotion/components/slotRenderers.jsx
// (PriceSlot). Kept in its own plain module — no JSX, no React import — so it
// can be `require()`'d directly by an offline verify harness the same way
// remotion/lib/ratingMotion.js already is (Node 22 CJS-require-of-ESM; this
// directory's package.json declares "type":"module").
//
// WHY THIS EXISTS — see models/CatalogProduct.js's price unit-contract
// comment and services/shopifyAccessResolver.js's verifyStoreCurrencyUsd for
// the full incident writeup (Pelagic Gear catalog products carried a
// mislabeled foreign-currency number under CatalogProduct.price). Every
// ingestion path + cascade tier feeding PriceSlot is documented to hand it a
// USD-major-units number (150 means $150.00). This function is the LAST
// LINE OF DEFENCE before that number reaches a rendered pixel: it must never
// blindly string-concatenate a "$" onto an untrusted value — that is exactly
// how a bad upstream number (wrong currency, stray cents, NaN, negative)
// would have painted "$2999" on a $150 product.
//
// Renders nothing (returns null) rather than a number it cannot vouch for —
// same doctrine this file's caller already applies to the removed
// "Bestseller" badge literal: on-brand and true, or absent.

/**
 * @param {string|number} raw - a BARE numeric price with no currency marker
 *   already present (PriceSlot checks for a marker before calling this).
 * @returns {string|null} a formatted USD string ("$2,999.00") or null when
 *   `raw` cannot be trusted as a price (non-finite, negative).
 */
function formatBarePriceUsd(raw) {
  const trimmed = String(raw).replace(/,/g, '').trim();
  // Number('') === 0 — an empty/whitespace-only value is missing data, not
  // a legitimate free-item price, so reject it explicitly before it is
  // indistinguishable from a real $0.00.
  if (trimmed === '') return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(numeric);
}

export { formatBarePriceUsd };
