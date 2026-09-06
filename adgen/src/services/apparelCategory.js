'use strict';
// Apparel category detection — shared helper.
//
// WHY THIS EXISTS. OpenAI's gpt-image-2/edit safety filter is famously
// trigger-happy on catalog photography of apparel — especially swimwear,
// activewear, and lingerie. MEASURED 2026-08-25 on
// run_1787684512013_e5feaf12 (Pelagic "Key West Top", 9 swimwear ads): 4
// ads returned `safety_violations=[sexual]` from OpenAI moderation on
// perfectly ordinary retailer product photography.
//
// These are false positives — legitimate merchant catalog imagery for a
// legitimate retailer. But the model doesn't know that from the prompt or
// the reference alone. Downstream fixes (moderation-fast-fail landed
// separately) recover the SECONDS wasted on retries, but they don't fix
// the underlying rejection.
//
// This helper is one half of a pair of category-aware mitigations:
//   1. Prompt-side (staticAdIntents.buildPrompt): when the product is
//      apparel, prepend an editorial/product-catalog framing to the role
//      preamble so the model reads the request as commercial retailer
//      photography rather than lifestyle content.
//   2. Reference-side (opt-in via APPAREL_SAFE_SEED): prefer flat_lay /
//      product_only shot types over lifestyle / on_model for apparel
//      products, so the reference itself carries less moderation risk.
//      Wired through the existing SHOT_TYPE_RANK infrastructure — see
//      shotTypeRank.APPAREL_SHOT_TYPE_RANK.
//
// DETECTION.  The `category` field on CatalogProduct is freeform text from
// the merchant feed — Meta's taxonomy strings, Shopify product types,
// custom brand categories. We match by keyword rather than by structured
// hierarchy because the taxonomy really does vary that much between
// sources.
//
// The keyword list is broad on purpose. A false positive (matching a
// non-apparel product) just gets a slightly editorial preamble that reads
// fine in context. A false negative (missing apparel) leaves the current
// baseline behaviour unchanged. Erring toward "more apparel context" is
// the safe direction.

// Tokens that indicate apparel. Word-boundary matched, case-insensitive.
// Grouped by intent for readability — the union is one big regex.
const APPAREL_TOKENS = [
  // Category-level
  'apparel', 'clothing', 'garment', 'wearable',
  // Bodywear
  'swim', 'swimwear', 'bikini', 'trunks', 'lingerie', 'underwear',
  'undergarment', 'bra', 'panties',
  // Outerwear
  'activewear', 'sportswear', 'athleisure', 'outerwear', 'jacket',
  'coat', 'vest', 'hoodie', 'sweater', 'cardigan',
  // Tops
  'shirt', 'top', 'blouse', 'tee', 't-shirt', 'tshirt', 'polo',
  'tank', 'jersey',
  // Bottoms
  'pants', 'trousers', 'shorts', 'leggings', 'joggers', 'skirt',
  'jeans', 'denim',
  // Dresses / one-piece
  'dress', 'gown', 'romper', 'jumpsuit', 'onesie', 'onepiece',
  // Fishing / outdoor apparel (Pelagic's own copy uses "fishing shirt",
  // "performance apparel" — pattern is common in outdoor brands)
  'fishing shirt', 'fishing top', 'performance apparel', 'performance shirt',
  'performance top', 'sunshirt', 'sun shirt',
];

// Build ONCE at module load. Word-boundary + case-insensitive.
const APPAREL_REGEX = new RegExp(
  `\\b(${APPAREL_TOKENS.map(escapeRegex).join('|')})\\b`,
  'i'
);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does this product read as apparel by category/type text?
 *
 * @param {string|null|undefined} category  freeform category string, typically
 *                                          CatalogProduct.category
 * @returns {boolean}
 */
function isApparelCategory(category) {
  if (!category || typeof category !== 'string') return false;
  return APPAREL_REGEX.test(category);
}

/**
 * Env-gated opt-in for the reference-image shift. Default OFF so a deploy
 * of this change does not silently swap the seed policy for existing runs;
 * enabling requires setting APPAREL_SAFE_SEED=true in the environment.
 *
 * Reason for the gate: prefering flat_lay over lifestyle changes CREATIVE
 * output for apparel — a valid A/B decision that deserves owner sign-off
 * per generation batch, not a global shift on the merge of this PR.
 */
function isApparelSafeSeedEnabled() {
  return String(process.env.APPAREL_SAFE_SEED || '').toLowerCase() === 'true';
}

module.exports = {
  isApparelCategory,
  isApparelSafeSeedEnabled,
  // Exported for the harness so it can pin the token list against
  // regressions.
  APPAREL_TOKENS,
};
