// Unified campaign model across ad platforms (Meta + Google). Each
// row represents one platform-side campaign and embeds its ad sets +
// ads (they always travel together; most campaigns have < 50 ads, so
// the doc stays small).
//
// The matching key into our content side is `productSetIds` — Meta's
// product_set_id and Google's Performance Max listing_group filter
// both reference subsets of the brand's product catalog (which we've
// already synced into CatalogProduct). Phase C joins this collection
// to Media via ProductMatchArtifact.catalogProductId to filter the
// ad-generation media picker by the active campaign's products.
//
// Idempotency: (brandId, platform, externalId) is the natural key.
// Re-syncing the same campaign upserts in place.

const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
  externalId:    { type: String, required: true },
  name:          String,
  status:        String,                       // ACTIVE | PAUSED | DELETED | ARCHIVED
  // Reference to the platform's creative object so Phase D can ship
  // a render to it. Shape is platform-specific:
  //   meta:    { creativeId, creativeName? }
  //   google:  { adGroupAdResourceName, adType }
  creativeRef:   mongoose.Schema.Types.Mixed,

  // Snapshot of the creative content extracted from the platform —
  // populated for Meta by metaAdsCreativeMatcher. Drives the URL +
  // text matching against CatalogProduct that fills matchedProductIds
  // below. Empty for ads whose creative we couldn't fetch.
  creative: {
    imageUrl:     String,
    thumbnailUrl: String,
    linkUrl:      String,
    title:        String,
    body:         String,
    callToAction: String
  },
  // CatalogProducts this ad's creative is promoting, resolved at
  // sync time. matchMethod records how each match was found so the
  // UI can show confidence: 'url' (high — link unwrapped to a known
  // CatalogProduct.productUrl), 'text' (token overlap on title/desc),
  // 'mixed' (both fired), null when no match.
  matchedProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct' }],
  matchMethod:       String
}, { _id: false });

const adSetSchema = new mongoose.Schema({
  externalId:    { type: String, required: true },
  name:          String,
  status:        String,
  // Subset-of-catalog the ad set targets. Filled when the platform
  // ad set carries one (Meta DPA / Google PMax). Null for non-product
  // ad sets (brand-awareness creative, etc.).
  productSetId:  String,
  ads:           [adSchema]
}, { _id: false });

const campaignSchema = new mongoose.Schema({
  advertiserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },
  brandId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      required: true, index: true },
  // Which IntegrationCredential this campaign was pulled through.
  // Lets sync re-resolve the right token without re-querying every
  // active credential per platform. Not required for reach-social
  // campaigns — those originate in our app, no external credential.
  credentialId:  {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IntegrationCredential',
    required: function() { return this.platform !== 'reach-social'; },
    index: true
  },

  // 'reach-social' = campaign created inside our app via the quick
  // campaign builder. No external sync; treated as the source of
  // truth for its name/kind/products. Phase 2 may add an opt-in
  // "publish to Meta/Google" path that mirrors this row to the
  // platform side and switches credentialId on.
  platform:      { type: String, enum: ['meta-ads', 'google-ads', 'reach-social'], required: true, index: true },
  // For platform-synced campaigns this is the platform's id. For
  // reach-social campaigns we synthesize one at create time
  // (`rs_<ObjectId>`) so the (brandId, platform, externalId) unique
  // index still has a value to enforce.
  externalId:    {
    type: String,
    required: function() { return this.platform !== 'reach-social'; }
  },

  name:          { type: String, required: true },
  status:        String,
  objective:     String,
  // Native budget shape — Meta uses daily_budget / lifetime_budget in
  // the ad-account currency's smallest unit (cents); Google uses a
  // budget resource. Adapters normalize both into:
  //   { dailyMicros, lifetimeMicros, currency, sharedBudgetId? }
  budget:        mongoose.Schema.Types.Mixed,

  schedule: {
    start: Date,
    end:   Date
  },

  // Targeting normalized across platforms — adapters fill what they
  // can. Free-form so each platform's deeper specifics are preserved
  // under .platformExtras for audit / future use.
  targeting: {
    geo:           [String],   // ['US', 'CA-ON', ...]
    ageMin:        Number,
    ageMax:        Number,
    interests:     [String],
    audiences:     [String],   // saved-audience names / ids
    devices:       [String],
    platformExtras: mongoose.Schema.Types.Mixed
  },

  // Catalog product subsets this campaign promotes. Aggregated across
  // every ad set so Phase C can filter Media in one IN-query without
  // walking nested ads. Empty when the campaign isn't product-driven.
  productSetIds: [String],

  // Embedded ad sets + their ads.
  adSets:        [adSetSchema],

  // Aggregated matched products across every ad in this campaign,
  // deduped. Filled at sync time from each ad's creative-level match
  // (URL / text / product-set / collection). The Generate Ads wizard
  // reads this directly to pre-select products in Step 2 without
  // walking the nested ads.
  matchedProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct', index: true }],

  // Per-platform performance insights — populated by the adapters
  // (Meta /insights or Google GAQL metrics.*) and refreshed every
  // campaign sync. All currency-style fields are stored in micros
  // (account-currency × 1e6) to match the budget block. ctr is a
  // fraction (0–1); the UI multiplies for display. rangeDays records
  // the time window the metrics cover ('lifetime' is null).
  insights: {
    impressions:           Number,
    reach:                 Number,    // Meta-only; Google leaves null
    clicks:                Number,
    ctr:                   Number,    // 0–1 fraction
    cpcMicros:             Number,
    cpmMicros:             Number,
    spendMicros:           Number,
    frequency:             Number,    // Meta-only
    conversions:           Number,
    conversionValueMicros: Number,
    videoViews:            Number,
    currency:              String,
    rangeDays:             Number,    // null = lifetime
    fetchedAt:             Date
  },

  // What this campaign is actually promoting, derived from the match
  // results + campaign objective. Drives Step 2 of the Generate Ads
  // wizard:
  //   'product'    — at least one ad resolves to a specific SKU
  //                  (URL match, product-set expansion, or text match)
  //   'collection' — only collection / category-level URLs resolved
  //                  (e.g. /collections/summer-sale → all SKUs in that
  //                  collection). Only set by platform sync today; the
  //                  in-app quick builder doesn't expose 'collection'
  //                  yet (re-introduce when we ship Shopify-style
  //                  collection imports).
  //   'brand'      — no SKU/collection resolution AND objective is
  //                  awareness / traffic / video views — operator
  //                  picks products manually from the full catalog
  //   null         — unknown (legacy rows pre-derivation)
  kind:          { type: String, enum: ['product', 'collection', 'brand', null], default: null },

  // Full raw payload from the platform — capped to ~16KB worth of
  // JSON. Useful for debugging and for fields we haven't mapped yet.
  rawData:       mongoose.Schema.Types.Mixed,

  firstSeenAt:   { type: Date, default: Date.now },
  lastSyncedAt:  { type: Date, default: Date.now }
});

// Idempotent natural key.
campaignSchema.index({ brandId: 1, platform: 1, externalId: 1 }, { unique: true });
// Status filter on the brand page list.
campaignSchema.index({ brandId: 1, status: 1 });
// Phase C filter — find campaigns by their product-set membership.
campaignSchema.index({ brandId: 1, productSetIds: 1 });

module.exports = mongoose.model('Campaign', campaignSchema);
