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
  // No literal tail, deliberately. 'Verified customer' asserted a purchase by a
  // person this pipeline could not name, and it fired precisely when the real
  // byline was missing — so the cascade manufactured proof exactly in the case
  // where there was none. layoutInputService stopped inventing bylines on
  // 2026-07-31 (it used to substitute the quote's SOURCE, which is how
  // "vertexaisearch.cloud.google.com" reached 80 live artifacts as a customer
  // name); leaving this literal here would have re-created the same claim one
  // layer down. An unattributed real quote is honest — resolve to nothing and
  // let the surface render no byline.
  reviewer: [
    { type: 'doc', doc: 'layoutInput', path: 'input.social_proof.primary_quote.author_name' },
    { type: 'doc', doc: 'layoutInput', path: 'input.social_proof.primary_quote.author' },
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
  //
  // REMOVED 2026-08-20 — this cascade still read
  // `input.product.badges[1]` (the SECOND item of the same array
  // `badgeText` reads badges[0] from, above), so this slot printed a second
  // generic merchandising claim ("Best seller", "New Arrival", "Premium
  // Cotton", …) beside the CTA on every ad whose badges array had ≥2
  // entries. `DeliverySlot`'s `DELIVERY_CLAIM` regex already suppresses the
  // TRUCK ICON for non-shipping text (owner, on seeing it: "I am seeing
  // the shipping car show back up") — but that fix only hid the icon, not
  // the text, so the claim kept rendering naked next to the CTA. On video
  // it additionally duplicates `badge` — both slots hold visible for the
  // whole clip on landscape/feed/square (single un-staged phase, no
  // `exitAtSec` on either), so "Top rated" (badge) and "Best seller"
  // (deliveryLine) print stacked/simultaneously — the "two proof badges"
  // defect. This slot is a shipping reassurance with no real data source
  // today (no genuine delivery/shipping field exists anywhere in
  // LayoutInputArtifact); an empty cascade always resolves to `null`, and
  // Canonical.jsx already handles the empty case cleanly (row wrapper
  // falls back to a lone CTA column — see the 2026-07-30 commit that first
  // established the "null renders nothing" contract this cascade is now
  // actually honouring).
  deliveryLine: [],
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
  // REMOVED 2026-08-11 (owner: "The bestseller badge should be removed").
  //
  // This literal printed "Bestseller" on any ad whose product had no real
  // badge — i.e. it fired precisely when there was NO evidence for the claim.
  // Unlike a CTA label ("Shop Now") or a proof format ("4.8 ★"), "Bestseller"
  // is a factual superlative about commercial performance: unearned, it is a
  // false advertising claim, and it was the highest-frequency templated string
  // still reaching video creative.
  //
  // No replacement literal. An absent badge resolves to nothing and the slot
  // renders nothing, the same doctrine now applied to headlines and quotes:
  // on-brand and true, or absent. If a "bestseller" badge is ever wanted it
  // must come from real data on input.product.badges, earned per product.
  badgeText: [
    { type: 'doc', doc: 'layoutInput', path: 'input.product.badges[0]' },
  ],
  badges: [
    { type: 'doc', doc: 'layoutInput', path: 'input.product.badges' },
    { type: 'literal', value: [] },
  ],
  benefits: [
    // CatalogProduct.shortBenefits is the same source the static Director
    // reads (assembleSignals). LayoutInput is a fallback for historical
    // artifacts derived before the catalog field existed.
    { type: 'doc', doc: 'catalogProduct', path: 'shortBenefits' },
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
  // Product-tier sources only in the cascade. Brand-level fallback is NOT
  // a cascade tier — it is an ATOMIC pair resolved in buildMetaForAd via
  // resolveAtomicRatingPair (ratingDisplay.js) from Brand.brandReviews.
  // HISTORY: a cascade tier that read Brand.brandReviews mixed sources —
  // a product's 41,000-review count printed next to the brand's 3.3 rating.
  // Do not re-add brand fields here; the pair resolver is the only safe path.
  rating: [
    { type: 'doc', doc: 'layoutInput',    path: 'input.social_proof.rating_value' },
    { type: 'doc', doc: 'catalogProduct', path: 'rating' },
  ],
  reviewCount: [
    { type: 'doc', doc: 'layoutInput',    path: 'input.social_proof.review_count' },
    { type: 'doc', doc: 'catalogProduct', path: 'reviewCount' },
  ],
  // No literal fallback. `572` was a hardcoded number rendered as this post's
  // like count on any ad without real engagement data — invented social proof,
  // the same class as the '53 reviews' and 'Ships free' defaults. Null means
  // the slot is skipped.
  likes: [
    { type: 'doc', doc: 'layoutInput', path: 'input.performance.engagement.likes' },
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
