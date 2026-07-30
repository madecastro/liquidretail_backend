// Editable meta-field cascade config for the titling pipeline.
//
// Every field in the meta blob buildMetaForAd emits is defined here as an
// ordered list of "sources". The resolver walks each cascade top-to-bottom
// and returns the first source whose extracted value is non-empty.
//
// Brands can override any cascade via Brand.metaCascades[field] — a per-field
// override REPLACES the full default (simpler than merge semantics). Brands
// that don't set metaCascades at all produce byte-identical output to the
// prior hardcoded logic in buildMetaForAd.
//
// Source shape:
//   { type: 'doc',     doc: 'ad'|'brand'|'catalogProduct'|'layoutInput'|
//                          'catalogMediaProductOnly'|'igCredential',
//                      path: 'dot.notation.with.[0]-array-indexes',
//                      prefix?: string,     // e.g. '@' for social handles
//                      suffix?: string }
//   { type: 'literal', value: <any> }        // constant fallback
//
// The whitelist of `doc` names is enforced at runtime; unknown docs
// return undefined (the source is skipped as if empty). No eval, no
// function references — safe to persist as JSON on Brand.metaCascades.

'use strict';

const DEFAULT_META_CASCADES = {
  // ── Identity ─────────────────────────────────────────────────────
  brandName: [
    { type: 'doc', doc: 'brand',        path: 'name' },
    { type: 'doc', doc: 'igCredential', path: 'igUsername',        prefix: '@' },
    { type: 'doc', doc: 'brand',        path: 'apifyDemo.igHandle', prefix: '@' },
  ],
  brandTagline: [
    { type: 'doc', doc: 'brand', path: 'tagline' },
  ],
  brandWebsiteUrl: [
    { type: 'doc', doc: 'brand', path: 'websiteUrl' },
  ],
  brandLogoUrl: [
    { type: 'doc', doc: 'brand', path: 'logoUrl' },
  ],

  // ── Copy (headline / quote / CTA / offer) ────────────────────────
  headline: [
    { type: 'doc', doc: 'ad',          path: 'copy.headline' },
    { type: 'doc', doc: 'layoutInput', path: 'input.copy.headline' },
    { type: 'doc', doc: 'brand',       path: 'tagline' },
  ],
  quote: [
    { type: 'doc', doc: 'ad',          path: 'copy.quote' },
    { type: 'doc', doc: 'layoutInput', path: 'input.social_proof.primary_quote.text' },
  ],
  quoteSnippet: [
    { type: 'doc', doc: 'layoutInput', path: 'input.social_proof.primary_quote.snippet' },
    { type: 'doc', doc: 'layoutInput', path: 'input.social_proof.primary_quote.text' },
  ],
  reviewer: [
    { type: 'doc', doc: 'layoutInput', path: 'input.social_proof.primary_quote.author_name' },
    { type: 'doc', doc: 'layoutInput', path: 'input.social_proof.primary_quote.author' },
    { type: 'literal', value: 'Verified customer' },
  ],
  ctaText: [
    { type: 'doc', doc: 'ad',          path: 'copy.cta_text' },
    { type: 'doc', doc: 'layoutInput', path: 'input.cta.text' },
    { type: 'doc', doc: 'layoutInput', path: 'input.copy.cta_text' },
    { type: 'literal', value: 'SHOP NOW' },
  ],
  // Renders in the lower third beside the CTA, with a truck icon
  // (slotRenderers.DeliverySlot) — it is a shipping reassurance, not a
  // general copy slot. It used to read copy.offer_text / cta.offer_text
  // first, which put the OFFER here: "Only $28" rendered next to a delivery
  // truck as though $28 were the shipping terms, and painted a second time
  // as the promo pill, since promoText draws from the same two sources.
  // The offer now renders once, through promoText alone.
  // No literal fallback, and no brand tagline: this slot is drawn with a
  // delivery truck, so whatever lands in it reads as a shipping promise.
  // 'Ships free' was a hardcoded default asserting free shipping for every
  // brand on the platform, true or not — it was simply invisible before,
  // because offer_text outranked it on any ad with an offer. A tagline next
  // to a truck is nonsense for the same reason. Null now means the slot is
  // skipped, which is the honest outcome when we hold no delivery terms.
  deliveryLine: [
    { type: 'doc', doc: 'layoutInput', path: 'input.product.badges[1]' },
  ],
  promoText: [
    { type: 'doc', doc: 'ad',          path: 'copy.offer_text' },
    { type: 'doc', doc: 'layoutInput', path: 'input.cta.offer_text' },
    { type: 'doc', doc: 'layoutInput', path: 'input.copy.highlight_text' },
    // No literal fallback — null lets the renderer skip the promo pill.
  ],

  // ── Product ──────────────────────────────────────────────────────
  productName: [
    { type: 'doc', doc: 'catalogProduct', path: 'title' },
    { type: 'doc', doc: 'layoutInput',    path: 'input.product.name' },
    { type: 'doc', doc: 'ad',             path: 'copy.productName' },
  ],
  productDescription: [
    { type: 'doc', doc: 'layoutInput',    path: 'input.product.description' },
    { type: 'doc', doc: 'catalogProduct', path: 'description' },
  ],
  price: [
    { type: 'doc', doc: 'catalogProduct', path: 'price' },
    { type: 'doc', doc: 'layoutInput',    path: 'input.product.price' },
    { type: 'doc', doc: 'ad',             path: 'copy.productPrice' },
  ],
  badgeText: [
    { type: 'doc', doc: 'layoutInput', path: 'input.product.badges[0]' },
    { type: 'literal', value: 'Bestseller' },
  ],
  badges: [
    { type: 'doc', doc: 'layoutInput', path: 'input.product.badges' },
    { type: 'literal', value: [] },
  ],
  benefits: [
    { type: 'doc', doc: 'layoutInput', path: 'input.product.short_benefits' },
    { type: 'doc', doc: 'layoutInput', path: 'input.product.benefits' },
    { type: 'literal', value: [] },
  ],
  productOnlyImageUrl: [
    // catalogMediaProductOnly is pre-picked before resolution: the first
    // Media with classification.shotType === 'product_only'. Overridable
    // by pointing at a different catalogProduct field.
    { type: 'doc', doc: 'catalogMediaProductOnly', path: 'fileUrl' },
    { type: 'doc', doc: 'catalogProduct',          path: 'imageUrl' },
  ],

  // ── Social proof (numeric) ───────────────────────────────────────
  rating: [
    { type: 'doc', doc: 'layoutInput',    path: 'input.social_proof.rating_value' },
    { type: 'doc', doc: 'catalogProduct', path: 'rating' },
    { type: 'doc', doc: 'brand',          path: 'brandReviews.rating' },
  ],
  reviewCount: [
    { type: 'doc', doc: 'layoutInput',    path: 'input.social_proof.review_count' },
    { type: 'doc', doc: 'catalogProduct', path: 'reviewCount' },
    { type: 'doc', doc: 'brand',          path: 'brandReviews.reviewCount' },
  ],
  likes: [
    { type: 'doc', doc: 'layoutInput', path: 'input.performance.engagement.likes' },
    { type: 'literal', value: 572 },
  ],
};

// Alphabetized sort for stable UI listings.
const CASCADED_FIELDS = Object.keys(DEFAULT_META_CASCADES).sort();

// Whitelist of context-doc names the resolver honors. Unknown docs are
// skipped rather than erroring, so an override written against a future
// doc name won't crash rendering — it just falls through to the next
// source.
const CONTEXT_DOC_NAMES = new Set([
  'ad',
  'brand',
  'catalogProduct',
  'layoutInput',
  'catalogMediaProductOnly',
  'igCredential',
]);

// Human labels for the operator UI. Kept alongside the config so a new
// field lands one edit — the label surfaces in a card row without a
// second file change.
const FIELD_LABELS = {
  brandName:            'Brand name',
  brandTagline:         'Brand tagline',
  brandWebsiteUrl:      'Brand website URL',
  brandLogoUrl:         'Brand logo URL',
  headline:             'Headline (hook)',
  quote:                'Quote (full)',
  quoteSnippet:         'Quote snippet (≤50 chars)',
  reviewer:             'Reviewer attribution',
  ctaText:              'CTA text',
  deliveryLine:         'Delivery / offer line',
  promoText:            'Promo callout',
  productName:          'Product name',
  productDescription:   'Product description',
  price:                'Product price',
  badgeText:            'Primary badge',
  badges:               'Badges (array)',
  benefits:             'Benefits (array)',
  productOnlyImageUrl:  'Product-only image URL',
  rating:               'Rating value',
  reviewCount:          'Review count',
  likes:                'Likes (engagement)',
};

module.exports = {
  DEFAULT_META_CASCADES,
  CASCADED_FIELDS,
  CONTEXT_DOC_NAMES,
  FIELD_LABELS,
};
