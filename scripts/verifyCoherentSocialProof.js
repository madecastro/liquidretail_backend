#!/usr/bin/env node
'use strict';

/**
 * verifyCoherentSocialProof — offline pins for the tier-coherence chokepoint.
 *
 * WHY THIS EXISTS
 * resolveAtomicRatingPair cannot see the quote. Its brand-star fallback is
 * correct for a quote-unaware resolver, but live call sites that pass both
 * product and brand pairs can print brand stars next to a product quote when
 * the product rating fails >4.5 (R1 hole). resolveCoherentSocialProof closes
 * that by withholding the ineligible side before delegating, and adds:
 *   - QUOTE_TIER_NUMBER_SIDE (category → brand; comment → product)
 *   - product volume exception (displayed >4.19 AND count >5000)
 *   - product-count / brand-count outcomes (require quote on frame)
 *
 * Nothing calls the chokepoint yet (wiring is a later change). This harness
 * pins the pure decision so wiring cannot silently re-open R1.
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyCoherentSocialProof.js
 */

const {
  RATING_STAR_MIN,
  RATING_STAR_VOLUME_MIN,
  RATING_STAR_VOLUME_COUNT_MIN,
  BRAND_VOLUME_EXCEPTION_ENABLED,
  QUOTE_TIER_NUMBER_SIDE,
  formatDisplayRating,
  normalizeReviewCount,
  resolveAtomicRatingPair,
  resolveCoherentSocialProof,
} = require('../services/ratingDisplay');

let pass = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `${msg || 'eq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function q(tier, text = 'Great product.', snippet = null) {
  const o = { text, tier, origin: 'scraped' };
  if (snippet != null) o.snippet = snippet;
  return o;
}

function product(rating, reviewCount) {
  return { rating, reviewCount };
}

function brand(rating, reviewCount) {
  return { rating, reviewCount };
}

/**
 * A WELL-BEHAVED CALLER. `resolveCoherentSocialProof` requires the caller to state
 * which line actually renders before it will authorise any number beside a quote —
 * omitting `renderedQuoteText` withholds numbers by design (see the fail-closed
 * block in the chokepoint). Every policy case below is about tier pairing, not about
 * that obligation, so this helper supplies what a correct caller would: the snippet
 * if there is one, else the full text.
 *
 * The obligation itself is pinned separately by the N-group, which calls
 * resolveCoherentSocialProof DIRECTLY so it can omit or corrupt that argument.
 */
function proof(opts = {}) {
  const { quote } = opts;
  if (!quote || opts.renderedQuoteText !== undefined) {
    return resolveCoherentSocialProof(opts);
  }
  const rendered = quote.snippet != null && String(quote.snippet).trim()
    ? quote.snippet
    : quote.text;
  return resolveCoherentSocialProof({ ...opts, renderedQuoteText: rendered });
}

const ATTR = 'gymshark.com';

console.log('\nverifyCoherentSocialProof\n');

// ── C0 constants / table ───────────────────────────────────────────────

check('C0 RATING_STAR_MIN is 4.5', () => {
  assertEq(RATING_STAR_MIN, 4.5);
});

check('C0 RATING_STAR_VOLUME_MIN is 4.19', () => {
  assertEq(RATING_STAR_VOLUME_MIN, 4.19);
});

check('C0 RATING_STAR_VOLUME_COUNT_MIN is 5000', () => {
  assertEq(RATING_STAR_VOLUME_COUNT_MIN, 5000);
});

check('C0 brand volume exception is OFF by default', () => {
  assertEq(BRAND_VOLUME_EXCEPTION_ENABLED, false);
});

check('C0 QUOTE_TIER_NUMBER_SIDE maps product/comment → product', () => {
  assertEq(QUOTE_TIER_NUMBER_SIDE.product, 'product');
  assertEq(QUOTE_TIER_NUMBER_SIDE.comment, 'product');
});

check('C0 QUOTE_TIER_NUMBER_SIDE maps category/brand → brand (owner 2026-08-03)', () => {
  assertEq(QUOTE_TIER_NUMBER_SIDE.category, 'brand');
  assertEq(QUOTE_TIER_NUMBER_SIDE.brand, 'brand');
});

// ── C1 tier pairing (R1) ───────────────────────────────────────────────

check('C1 category quote + brand count → ALLOWED (source brand-count)', () => {
  const r = proof({
    quote: q('category', 'Best in the category.'),
    product: product(4.8, 120),
    brand: brand(3.3, 41000),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'brand-count');
  assertEq(r.rating, null, 'stars withheld under >4.5');
  assertEq(r.reviewCount, 41000);
  assertEq(r.quoteTier, 'category');
  assert(r.reviewsText && r.reviewsText.includes(ATTR), 'brand count must be attributed');
  assert(r.reviewsText && !r.reviewsText.includes('120'), 'product count must not leak');
});

check('C1 category quote + brand stars → ALLOWED (source brand)', () => {
  const r = proof({
    quote: q('category'),
    product: product(4.8, 120),
    brand: brand(4.7, 8900),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'brand');
  assertEq(r.rating, '4.7');
  assertEq(r.reviewCount, 8900);
  assert(r.reviewsText && !String(r.reviewsText).includes('120'), 'product count must not leak');
});

check('C1 category quote must NOT unlock product numbers alone', () => {
  const r = proof({
    quote: q('category'),
    product: product(4.8, 120),
    brand: null,
    brandAttribution: ATTR,
  });
  assertEq(r.source, null);
  assertEq(r.rating, null);
  assertEq(r.reviewCount, null);
});

check('C1 comment quote + brand stars → REFUSED', () => {
  const r = proof({
    quote: q('comment', 'Love these!'),
    product: product(3.2, null),
    brand: brand(4.7, 8900),
    brandAttribution: ATTR,
  });
  assert(r.source !== 'brand' && r.source !== 'brand-count',
    `comment must not unlock brand numbers, got source=${r.source}`);
  assertEq(r.rating, null);
  assert(r.reviewCount !== 8900, 'brand count must not print beside comment quote');
});

check('C1 product quote + brand stars → REFUSED (closes live R1 hole)', () => {
  // Live resolveAtomicRatingPair with both sides present would return brand
  // stars when product fails. Chokepoint must withhold brand.
  const r = proof({
    quote: q('product'),
    product: product(3.9, 120),
    brand: brand(4.7, 8900),
    brandAttribution: ATTR,
  });
  assert(r.source !== 'brand' && r.source !== 'brand-count',
    `product quote must not unlock brand, got source=${r.source}`);
  assertEq(r.source, 'product-count', 'product count-only when stars fail');
  assertEq(r.rating, null);
  assertEq(r.reviewCount, 120);
});

check('C1 brand quote + product numbers → REFUSED', () => {
  const r = proof({
    quote: q('brand', 'Brand is solid.'),
    product: product(4.8, 120),
    brand: brand(3.0, null),
    brandAttribution: ATTR,
  });
  assert(r.source !== 'product' && r.source !== 'product-count',
    `brand quote must not unlock product numbers, got source=${r.source}`);
  assertEq(r.rating, null);
  assertEq(r.reviewCount, null);
});

check('C1 product quote + product stars still wins with product count', () => {
  const r = proof({
    quote: q('product'),
    product: product(4.8, 120),
    brand: brand(4.9, 41000),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'product');
  assertEq(r.rating, '4.8');
  assertEq(r.reviewCount, 120);
  assertEq(r.reviewsText, '120 reviews');
  assert(r.reviewsText && !r.reviewsText.includes(ATTR), 'product path has no brand attribution');
});

// ── C2 volume exception (product only; displayed values) ───────────────

check('C2 displayed 4.2 with count 6000 → stars ALLOWED via volume exception', () => {
  // Pin DISPLAYED 4.2, not raw 4.19 (raw 4.19 also displays as 4.2 and would pass).
  const r = proof({
    quote: q('product'),
    product: product(4.2, 6000),
    brand: brand(4.9, 100),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'product');
  assertEq(r.rating, '4.2');
  assertEq(r.reviewCount, 6000);
});

check('C2 displayed 4.2 with count 4000 → stars REFUSED, product-count only', () => {
  const r = proof({
    quote: q('product'),
    product: product(4.2, 4000),
    brand: brand(4.9, 100),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'product-count');
  assertEq(r.rating, null);
  assertEq(r.reviewCount, 4000);
});

check('C2 displayed 4.1 with any count → stars REFUSED', () => {
  // raw 4.14 → displayed 4.1; 4.1 > 4.19 is false.
  const r = proof({
    quote: q('product'),
    product: product(4.14, 9999),
    brand: brand(4.9, 100),
    brandAttribution: ATTR,
  });
  assertEq(r.rating, null, 'displayed 4.1 must not clear volume floor');
  assertEq(r.source, 'product-count');
  assertEq(r.reviewCount, 9999);
});

check('C2 displayed 4.6 with count 12 → ALLOWED via original >4.5 rule', () => {
  const r = proof({
    quote: q('product'),
    product: product(4.6, 12),
    brand: brand(3.3, 41000),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'product');
  assertEq(r.rating, '4.6');
  assertEq(r.reviewCount, 12);
});

check('C2 brand displayed 4.3 with count 41000 → stars REFUSED (no brand volume exception)', () => {
  const r = proof({
    quote: q('brand'),
    product: product(4.8, 120),
    brand: brand(4.3, 41000),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'brand-count');
  assertEq(r.rating, null, 'brand must not earn stars via volume exception');
  assertEq(r.reviewCount, 41000);
});

check('C2 volume count boundary: exactly 5000 does NOT unlock stars', () => {
  const r = proof({
    quote: q('product'),
    product: product(4.2, 5000),
    brand: null,
  });
  assertEq(r.source, 'product-count');
  assertEq(r.rating, null);
  assertEq(r.reviewCount, 5000);
});

check('C2 formatDisplayRating default floor still withholds 4.2', () => {
  // Without volume floor, classic path refuses 4.2 (4.2 > 4.5 is false).
  assertEq(formatDisplayRating(4.2), undefined);
  assertEq(formatDisplayRating(4.2, RATING_STAR_VOLUME_MIN), '4.2');
  assertEq(formatDisplayRating(4.14, RATING_STAR_VOLUME_MIN), undefined);
  // ROUNDING DOC: raw 4.19 displays as 4.2 and therefore PASSES volume floor.
  assertEq(formatDisplayRating(4.19, RATING_STAR_VOLUME_MIN), '4.2');
});

// ── C3 count edge cases ────────────────────────────────────────────────

check('C3 count 0 → slot empty, never "0 reviews"', () => {
  const r = proof({
    quote: q('product'),
    product: product(3.0, 0),
    brand: null,
  });
  assertEq(r.source, null);
  assertEq(r.reviewCount, null);
  assertEq(r.reviewsText, null);
  assertEq(normalizeReviewCount(0), null);
});

check('C3 count absent → slot empty', () => {
  const r = proof({
    quote: q('product'),
    product: product(3.0, null),
    brand: null,
  });
  assertEq(r.source, null);
  assertEq(r.reviewCount, null);
  assertEq(r.reviewsText, null);
});

check('C3 brand-count with count 0 stays empty', () => {
  const r = proof({
    quote: q('brand'),
    product: null,
    brand: brand(3.3, 0),
    brandAttribution: ATTR,
  });
  assertEq(r.source, null);
  assertEq(r.reviewsText, null);
});

// ── C4 bad rating shapes ───────────────────────────────────────────────

check('C4 rating as a string never becomes a star value', () => {
  const r = proof({
    quote: q('product'),
    product: product('4.8', 120),
    brand: null,
  });
  assertEq(r.rating, null);
  // Count still usable for product-count.
  assertEq(r.source, 'product-count');
  assertEq(r.reviewCount, 120);
});

check('C4 rating on a 0–100 scale never becomes a star value', () => {
  const r = proof({
    quote: q('product'),
    product: product(87, 500),
    brand: null,
  });
  assertEq(r.rating, null, '87 must never print as stars');
  assertEq(r.source, 'product-count');
  assertEq(r.reviewCount, 500);

  const b = proof({
    quote: q('brand'),
    product: null,
    brand: brand(87, 500),
    brandAttribution: ATTR,
  });
  assertEq(b.rating, null);
  assertEq(b.source, 'brand-count');
});

// ── C5 no quote on frame ───────────────────────────────────────────────

check('C5 no quote → neither count-only outcome unlocks', () => {
  const r = proof({
    quote: null,
    product: product(3.2, 41000),
    brand: brand(3.3, 41000),
    brandAttribution: ATTR,
  });
  assert(r.source !== 'product-count' && r.source !== 'brand-count',
    `count-only forbidden without quote, got source=${r.source}`);
  assertEq(r.source, null);
  assertEq(r.rating, null);
  assertEq(r.reviewCount, null);
});

check('C5 no quote → product stars still allowed', () => {
  const r = proof({
    quote: null,
    product: product(4.8, 120),
    brand: brand(4.9, 41000),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'product');
  assertEq(r.rating, '4.8');
  assertEq(r.reviewCount, 120);
});

check('C5 no quote → brand stars when product fails (rating-only fallback)', () => {
  const r = proof({
    quote: null,
    product: product(3.9, 120),
    brand: brand(4.7, 8343),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'brand');
  assertEq(r.rating, '4.7');
  assertEq(r.reviewCount, 8343);
});

check('C5 no quote → product volume exception still applies for stars', () => {
  const r = proof({
    quote: null,
    product: product(4.2, 6000),
    brand: brand(4.9, 100),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'product');
  assertEq(r.rating, '4.2');
});

// ── C6 presentation strings are pure functions of the same numbers ─────

check('C6 reviewsText / reviewsTextShort match the same count (product)', () => {
  const r = proof({
    quote: q('product'),
    product: product(4.8, 120),
    brand: null,
  });
  assertEq(r.reviewsText, '120 reviews');
  assertEq(r.reviewsTextShort, '120 reviews');
});

check('C6 reviewsTextShort compact form for brand-count', () => {
  const r = proof({
    quote: q('brand'),
    product: null,
    brand: brand(3.3, 41000),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'brand-count');
  assertEq(r.reviewsText, `41000 reviews · ${ATTR}`);
  assertEq(r.reviewsTextShort, `41k reviews · ${ATTR}`);
});

// ── C7 existing resolver contract unchanged (additive) ─────────────────

check('C7 resolveAtomicRatingPair R1 product still wins without quote awareness', () => {
  const r = resolveAtomicRatingPair({
    productRating: 4.8, productReviewCount: 120,
    brandRating: 3.3, brandReviewCount: 41000, brandAttribution: ATTR,
  });
  assertEq(r.source, 'product');
  assertEq(r.rating, '4.8');
  assertEq(r.reviewCount, 120);
});

check('C7 resolveAtomicRatingPair R2 brand still wins when product fails (quote-unaware)', () => {
  const r = resolveAtomicRatingPair({
    productRating: 3.9, productReviewCount: 120,
    brandRating: 4.7, brandReviewCount: 8343, brandAttribution: ATTR,
  });
  assertEq(r.source, 'brand');
  assertEq(r.rating, '4.7');
});

check('C7 resolveAtomicRatingPair R3 default still null when both fail', () => {
  const r = resolveAtomicRatingPair({
    productRating: 3.9, productReviewCount: 120,
    brandRating: 3.3, brandReviewCount: 41000, brandAttribution: ATTR,
  });
  assertEq(r.source, null);
});

check('C7 formatDisplayRating one-arg call matches today (4.51 withheld, 4.6 passes)', () => {
  assertEq(formatDisplayRating(4.51), undefined);
  assertEq(formatDisplayRating(4.6), '4.6');
  assertEq(formatDisplayRating(4.5), undefined);
  assertEq(formatDisplayRating('4.8'), undefined);
  assertEq(formatDisplayRating(87), undefined);
});

// ── N: the caller must PROVE which line renders (the F4 obligation) ────
//
// These call resolveCoherentSocialProof DIRECTLY, bypassing the well-behaved-caller
// helper, so they can omit or corrupt `renderedQuoteText`. Every one of them failed
// against the first draft of the chokepoint, which defaulted the rendered text to the
// quote's own text and therefore compared a value against itself.

check('N1 quote supplied but renderedQuoteText OMITTED → numbers withheld', () => {
  const r = resolveCoherentSocialProof({
    quote: q('brand', 'Brand is solid.'),
    product: product(4.8, 120),
    brand: brand(4.7, 8900),
    brandAttribution: ATTR,
    // renderedQuoteText deliberately absent — the caller cannot prove what prints.
  });
  assertEq(r.source, null, 'silence is not proof');
  assertEq(r.rating, null);
  assertEq(r.reviewCount, null);
});

check('N2 rendered text differs from the quote (metaCascades override) → withheld', () => {
  const r = resolveCoherentSocialProof({
    quote: q('brand', 'Brand is solid.'),
    product: product(4.8, 120),
    brand: brand(4.7, 8900),
    brandAttribution: ATTR,
    renderedQuoteText: 'A completely different line the cascade substituted.',
  });
  assertEq(r.source, null, 'a substituted line must not authorise brand numbers');
  assertEq(r.reviewCount, null);
});

check('N3 REGRESSION — a mismatch must not FALL THROUGH to brand stars', () => {
  // The bug this pins: on a mismatch `onFrame` goes false, and without the
  // fail-closed guard control reached the rating-only branch, which passes BOTH
  // sides to the resolver. A product-tier quote whose rendered line had been
  // substituted could then print beside brand stars — R1, reopened through the
  // very path that exists to close it.
  const r = resolveCoherentSocialProof({
    quote: q('product', 'Fits perfectly.'),
    product: product(3.9, null),   // product stars fail, no product count
    brand: brand(4.7, 8900),       // brand stars available and tempting
    brandAttribution: ATTR,
    renderedQuoteText: 'Substituted by a Brand.metaCascades.quoteSnippet override.',
  });
  assert(r.source !== 'brand' && r.source !== 'brand-count',
    `mismatch must not reach brand numbers, got source=${r.source}`);
  assertEq(r.source, null);
  assertEq(r.rating, null, 'brand stars must not appear beside an unverified quote');
});

check('N4 renderedQuoteText matching the SNIPPET authorises (snippet is what prints)', () => {
  const quote = q('brand', 'The full untrimmed brand testimonial, quite long.', 'Trimmed snippet.');
  const r = resolveCoherentSocialProof({
    quote,
    product: null,
    brand: brand(4.7, 8900),
    brandAttribution: ATTR,
    renderedQuoteText: 'Trimmed snippet.',
  });
  assertEq(r.source, 'brand', 'the snippet is a legitimate rendered form of the quote');
  assertEq(r.rating, '4.7');
});

check('N5 no quote at all still allows rating-only stars (not a false positive)', () => {
  // The fail-closed guard must distinguish "no quote" from "unverified quote".
  // Rating-only social proof is legitimate — there is no tier to cohere with.
  const r = resolveCoherentSocialProof({
    quote: null,
    product: product(4.8, 120),
    brand: brand(4.9, 41000),
    brandAttribution: ATTR,
  });
  assertEq(r.source, 'product', 'no quote must not withhold rating-only proof');
  assertEq(r.rating, '4.8');
});

check('N6 no quote → neither count-only outcome unlocks', () => {
  const r = resolveCoherentSocialProof({
    quote: null,
    product: product(3.9, 120),    // stars fail, count exists
    brand: brand(3.3, 41000),      // stars fail, count exists
    brandAttribution: ATTR,
  });
  assertEq(r.source, null, 'a count needs a coherent quote beside it');
  assertEq(r.reviewCount, null);
});

// ── G: both layers of the tier guard exist in SOURCE ───────────────────
//
// WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. The chokepoint defends the tier
// invariant twice — it withholds the ineligible side's inputs before delegating,
// AND it whitelists the returned `pair.source`. A revert-proof pass showed the two
// layers MASK EACH OTHER: with the withholding intact the resolver can never return
// the ineligible side, so widening the whitelist changes nothing; with the whitelist
// intact, a leaked brand result is discarded anyway, so removing the withholding
// changes nothing. Each layer is individually unobservable, so neither can be pinned
// behaviourally without breaking both at once — which would prove nothing about
// either.
//
// So: assert both are PRESENT, tightly. This repo has precedent for source pins, and
// also a recorded lesson about them — a bare regex once matched a comment ~80 chars
// from the real guard and stayed green while the guard was gone. Hence the proximity
// requirement below rather than a naked `.includes()`.

const CHOKEPOINT_SRC = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'services', 'ratingDisplay.js'), 'utf8'
);

// Region boundaries are the two branch heads, so each slice covers EXACTLY one
// branch. A fixed byte window is what broke the first version of these checks: 1400
// chars from the product branch head ran past its closing brace into the brand
// branch, so G2's negative assertion tripped on the brand branch's own perfectly
// legitimate `pair.source === 'brand'` whitelist — a false failure in the baseline.
const PRODUCT_BRANCH_AT = CHOKEPOINT_SRC.indexOf("if (side === 'product')");
const BRAND_BRANCH_AT = CHOKEPOINT_SRC.indexOf("if (side === 'brand')");
const PRODUCT_BRANCH = PRODUCT_BRANCH_AT > 0 && BRAND_BRANCH_AT > PRODUCT_BRANCH_AT
  ? CHOKEPOINT_SRC.slice(PRODUCT_BRANCH_AT, BRAND_BRANCH_AT) : '';
const BRAND_BRANCH = BRAND_BRANCH_AT > 0
  ? CHOKEPOINT_SRC.slice(BRAND_BRANCH_AT, BRAND_BRANCH_AT + 1400) : '';

check('G0 both branch regions were located and are disjoint', () => {
  assert(PRODUCT_BRANCH_AT > 0, "product branch not found — was the chokepoint restructured?");
  assert(BRAND_BRANCH_AT > PRODUCT_BRANCH_AT, 'brand branch must follow the product branch');
  assert(PRODUCT_BRANCH.length > 200, 'product branch region looks too small to be real');
});

check('G1 product branch WITHHOLDS brand inputs (defence in depth)', () => {
  assert(/brandRating:\s*null/.test(PRODUCT_BRANCH), 'brandRating must be nulled in the product branch');
  assert(/brandReviewCount:\s*null/.test(PRODUCT_BRANCH), 'brandReviewCount must be nulled in the product branch');
  assert(/allowBrandCountWithoutStars:\s*false/.test(PRODUCT_BRANCH),
    'product branch must never allow a brand count');
});

check('G2 product branch WHITELISTS the returned source (the load-bearing guard)', () => {
  assert(/pair\.source\s*===\s*'product'/.test(PRODUCT_BRANCH),
    "the whitelist must accept ONLY 'product' — widening it re-admits brand numbers");
  assert(!/pair\.source\s*===\s*'brand'/.test(PRODUCT_BRANCH),
    "the product branch must not accept a brand source under any name");
});

check('G3 brand branch WITHHOLDS product inputs', () => {
  assert(/productRating:\s*null/.test(BRAND_BRANCH), 'productRating must be nulled in the brand branch');
  assert(/productReviewCount:\s*null/.test(BRAND_BRANCH), 'productReviewCount must be nulled in the brand branch');
});

check('G4 brand branch whitelists only brand sources', () => {
  assert(/pair\.source\s*===\s*'brand'/.test(BRAND_BRANCH), 'brand whitelist missing');
  assert(!/pair\.source\s*===\s*'product'\s*\|\|/.test(BRAND_BRANCH),
    'the brand branch must not accept a product source');
});

check('G5 the fail-closed guard for an unverified quote is present', () => {
  // Pinned by proximity to its own condition, not by a loose substring: this is the
  // guard whose absence let a substituted quote fall through to brand stars.
  assert(/if\s*\(quote\s*&&\s*\(!onFrame\s*\|\|\s*!quoteTier\s*\|\|\s*!side\)\)/.test(CHOKEPOINT_SRC),
    'the unverified-quote guard must withhold numbers rather than fall through');
});

check('G6 quotePrintsOnFrame requires an explicit rendered text', () => {
  const i = CHOKEPOINT_SRC.indexOf('function quotePrintsOnFrame');
  assert(i > 0, 'quotePrintsOnFrame not found');
  const region = CHOKEPOINT_SRC.slice(i, i + 900);
  assert(/renderedQuoteText\s*==\s*null\)\s*return false/.test(region),
    'omitting renderedQuoteText must return false — no defaulting to the quote itself');
});

// ── summary ────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('OK\n');
process.exit(0);

/*
 * ═══════════════════════════════════════════════════════════════════════
 * REVERT-PROOF PLAN
 * For each invariant, the one-line edit that backs it out and the named
 * checks that must go red. A green suite after the edit means the pin is dead.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * INV-1  category → brand side (QUOTE_TIER_NUMBER_SIDE.category = 'brand')
 *   Back out: change QUOTE_TIER_NUMBER_SIDE.category to 'product' (or delete key).
 *   Must go red: C0 QUOTE_TIER_NUMBER_SIDE maps category/brand → brand;
 *                C1 category quote + brand count → ALLOWED;
 *                C1 category quote + brand stars → ALLOWED;
 *                C1 category quote must NOT unlock product numbers alone.
 *
 * INV-2  product/comment quote never unlocks brand numbers (R1)
 *   Back out: in resolveCoherentSocialProof product branch, pass brandRating /
 *             brandReviewCount through to resolveAtomicRatingPair instead of null.
 *   Must go red: C1 product quote + brand stars → REFUSED;
 *                C1 comment quote + brand stars → REFUSED.
 *
 * INV-3  brand/category quote never unlocks product numbers
 *   Back out: in brand branch, pass productRating / productReviewCount through.
 *   Must go red: C1 brand quote + product numbers → REFUSED.
 *
 * INV-4  product volume exception (displayed >4.19 AND count >5000)
 *   Back out: productStarFloorForCount always returns RATING_STAR_MIN
 *             (or delete the volume branch).
 *   Must go red: C2 displayed 4.2 with count 6000 → stars ALLOWED;
 *                C5 no quote → product volume exception still applies for stars.
 *   (C2 displayed 4.2 with count 4000 / C2 volume count boundary stay green —
 *    they assert the refuse path.)
 *
 * INV-5  displayed 4.1 refuses volume floor (rounding gate on viewer value)
 *   Back out: gate on raw instead of displayed, or lower floor to 4.0.
 *   Must go red: C2 displayed 4.1 with any count → stars REFUSED;
 *                C2 formatDisplayRating default floor still withholds 4.2
 *                (the formatDisplayRating(4.14, VOLUME_MIN) === undefined pin).
 *
 * INV-6  brand has NO volume exception
 *   Back out: set BRAND_VOLUME_EXCEPTION_ENABLED = true.
 *   Must go red: C0 brand volume exception is OFF by default;
 *                C2 brand displayed 4.3 with count 41000 → stars REFUSED.
 *
 * INV-7  count-only requires quote on frame
 *   Back out: set allowBrandCountWithoutStars true (and product-count) on the
 *             no-quote path in resolveCoherentSocialProof.
 *   Must go red: C5 no quote → neither count-only outcome unlocks.
 *
 * INV-8  count 0 / absent never prints "0 reviews"
 *   Back out: normalizeReviewCount allows n === 0 (return 0 instead of null).
 *   Must go red: C3 count 0 → slot empty; C3 brand-count with count 0 stays empty.
 *
 * INV-9  string / 0–100 ratings never become stars
 *   Back out: coerce String ratings via Number(), or drop displayed <= 5 bound.
 *   Must go red: C4 rating as a string; C4 rating on a 0–100 scale;
 *                C7 formatDisplayRating one-arg call (87 / string rows).
 *
 * INV-10 existing resolveAtomicRatingPair contract preserved for current callers
 *   Back out: remove brand fallback when product fails, or change default floors.
 *   Must go red: C7 R1 / R2 / R3 checks (and verifyProofBeat R1/R2/R3 +
 *                verifyPostPilotBatch A1–A6 when run in the full suite).
 */
