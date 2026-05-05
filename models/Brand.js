// Brand catalog. A Brand doc is upserted opportunistically during the detect
// pipeline's product-match stage — first time we see a brand name on an
// identified product, we create a stub with the best signal we have (the
// source scene's palette as fallback colors). Ops can later enrich the stub
// manually via a curation UI (logo upload, canonical colors, tagline, font).
//
// Layout generator reads Brand by nameNormalized at creative-input assembly
// time. Missing or stub-only fields are passed through as null — templates
// must gracefully handle absent brand data.

const mongoose = require('mongoose');

function normalizeBrandName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')      // strip trademark symbols
    .replace(/[^a-z0-9]+/g, ' ') // collapse punctuation to spaces
    .trim()
    .replace(/\s+/g, ' ');
}

const demographicSchema = new mongoose.Schema({
  name:         { type: String, required: true },   // e.g. "Saltwater Joe"
  description:  String,                              // one-line persona
  interests:    [String],                            // what they care about
  painPoints:   [String],                            // what they worry about
  toneHint:     String,                              // how they speak
  avatarUrl:    String                               // optional, future — generated avatar image
}, { _id: false });

const brandSchema = new mongoose.Schema({
  // Tenant scope. Nullable until the Phase 1.4 backfill assigns
  // existing rows to a default Advertiser. After the backfill we
  // enforce non-null at the application layer; the unique index
  // below is compound (advertiserId + nameNormalized) so two
  // Advertisers can each have their own "Pelagic".
  advertiserId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },

  // Normalized lookup key — unique PER ADVERTISER (see compound index
  // below). The legacy global-unique constraint was replaced; if both
  // exist, the migration script drops the old one.
  nameNormalized: { type: String, required: true, index: true },
  name:           { type: String, required: true },

  websiteUrl:     String,                            // user-supplied on upload; seed for enrichment
  tagline:        String,                            // one-liner positioning (≤ 12 words)
  summary:        String,                            // 2-4 sentence verbose brand description
  logoUrl:        String,
  primaryColor:   String,
  secondaryColor: String,
  accentColor:    String,
  // Brand's canonical text/font color — what they use for body and
  // headline copy on their own site. Captured from Brandfetch's
  // `text`-type color when present; GPT-suggested otherwise.
  fontColor:      String,
  fontFamily:     String,
  // Provenance of fontFamily — drives the "(suggested)" UI hint and
  // lets curation distinguish a real brand font from an approximation.
  // 'brandfetch'  — pulled from Brandfetch's brand-kit API
  // 'scraped'     — parsed from a Google Fonts <link> on the homepage
  // 'suggested'   — GPT-4.1 derived from brand tone/summary (best-effort)
  // 'tone-default'— hardcoded tone→font safety net when GPT also failed
  // 'curated'     — set explicitly by a human via PATCH /api/brand/:id
  // null is included in the enum so brands that pre-date this field
  // (or rows where every enrichment tier returned no font) pass
  // validation. Mongoose's enum check rejects null even on non-
  // required fields when a default isn't matched, so we explicitly
  // allow it here.
  fontSource:     { type: String, enum: ['brandfetch', 'scraped', 'suggested', 'tone-default', 'curated', null], default: null },
  tone:           [String],                          // single-word voice descriptors ('rugged','technical','playful')
  hashtags:       [String],                          // commonly used social hashtags WITH the # ('#pelagic','#offshore')
  tags:           [String],                          // lowercase keyword tags WITHOUT the # ('fishing','performance')
  demographics:   [demographicSchema],               // key target personas for notional quotes

  // Provenance. stub = auto-created from detect with minimal data.
  // enriched = brandEnrichmentService successfully filled in fields from
  // the websiteUrl. curated = a human edited it; never overwritten.
  source:         { type: String, enum: ['stub', 'enriched', 'curated'], default: 'stub' },
  enrichedAt:     Date,

  // Per-field curation lock. Listed field names are protected from
  // auto-enrichment overwrite even when source='stub'/'enriched'. Lets a
  // user upload one curated asset (e.g. logoUrl) without losing the
  // benefit of automated enrichment for the rest. Field names match
  // schema property names exactly: 'logoUrl', 'primaryColor', etc.
  curatedFields:  [String],

  // Which auto-enrichment sources have been ATTEMPTED on this brand
  // (regardless of whether each returned data). Drives re-enrichment
  // logic — if a tier is missing, we re-run enrichment so it can
  // backfill. Values: 'brandfetch' | 'scraped' | 'gpt' | 'brand-reviews'.
  // Resets when curation explicitly removes a field, when the
  // websiteUrl changes, or via /refresh-enrichment.
  enrichmentSources: [String],

  // Currently-running enrichment tier name, or null when nothing is
  // running. Updated incrementally by enrichBrandFromUrl so the brand
  // page can poll and show "Detecting brand kit (Brandfetch)…" etc.
  // Values mirror enrichmentSources entries: 'brandfetch' | 'scraped'
  // | 'gpt' | 'brand-reviews' | null.
  enrichmentStage:    { type: String, default: null },

  // Brand-level review snapshot. Populated by enrichBrandFromUrl
  // (Tier 4 — Gemini grounded search for "<brand> reviews"). Cached
  // on Brand so per-Media brand_match outcomes share one fetch
  // rather than re-querying Gemini every detect run. Refreshed via
  // POST /api/brand/:id/refresh-enrichment or when stale (TTL
  // checked at consumer side).
  // Shape:
  //   { quotes: [{ text, author, source }],
  //     rating: 0-5 | null,
  //     reviewCount: number | null,
  //     summary: string | null,
  //     fetchedAt: Date }
  brandReviews:    mongoose.Schema.Types.Mixed,

  // Phase 1.7c — category-level reviews keyed by breadcrumb (e.g. "Mens >
  // Tops > Performance Shirts"). Each entry is a Gemini grounded-search
  // snapshot for THAT category on THIS brand. Used by category-level
  // comments and as a fallback quote source when SKU-level productReviews
  // are missing.
  //   [
  //     { categoryKey: <hashed breadcrumb>,
  //       breadcrumb: 'Mens > Tops > Performance Shirts',
  //       summary, quotes: [{ text, author, source }],
  //       rating, reviewCount, sources, fetchedAt }
  //   ]
  categoryReviews: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // If stub, which Media was the first to surface this brand — useful for
  // auditing where a brand came from.
  firstSeenMediaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Media' },

  // Phase 4d — Brand Safety configuration. Composite risk score (0–100)
  // surfaced on the Brand page; category narrows the auto-suggested
  // blocked-topic list; blockedTopics[] is the operator-curated list
  // of topics that should NOT appear in this brand's ads or matched
  // media. The renderer / matcher are expected to consult these once
  // wired (separate ticket — for now this is just a config surface).
  // Risk score is computed from (a) blockedTopic violation rate seen
  // across the brand's matched media and (b) category default risk
  // weights. Operators can override via the Adjust Settings modal.
  brandSafety: {
    riskScore:    { type: Number, min: 0, max: 100, default: null },
    category:     { type: String, default: null },          // 'Food & CPG' | 'Apparel' | etc.
    blockedTopics: { type: [String], default: [] },         // ['Alcohol','Gambling','Guns','Hate Speech',...]
    adjustedAt:   { type: Date,   default: null },
    adjustedBy:   { type: String, default: null }           // userId/email of last editor
  },

  // Phase V2 #4 — auto-sync settings for connected integrations. When
  // autoSyncEnabled is true, the worker's scheduled sweep pulls catalog
  // (~daily) and posts (~hourly) for any active credential under this
  // brand. dailyDetectRunCap throttles the post sync so a single brand
  // can't burn through compute by posting frequently.
  syncSettings: {
    autoSyncEnabled:      { type: Boolean, default: false },
    dailyDetectRunCap:    { type: Number,  default: 50 },
    catalogCadenceHours:  { type: Number,  default: 24 },
    postsCadenceHours:    { type: Number,  default: 1 }
  },

  // V3 #3 — auto-reply with a comment on IG-sourced posts when detect
  // produces a confident product_match. Per-brand opt-in. Phase 1.7c
  // expanded to support three comment types matching the three review
  // tiers: product (SKU-level), category (collection-level), brand
  // (brand-level).
  //
  // Each template supports a different variable set:
  //   templateProduct  — {productName, productUrl, brandName, productQuote}
  //   templateCategory — {breadcrumb, categoryUrl, brandName, categoryQuote}
  //   templateBrand    — {brandName, brandUrl, brandQuote}
  //
  // Fallback chain (when a template's quote source is empty):
  //   product_match  → product comment with productReviews quote
  //                  → fallback to category comment with categoryReviews quote
  //                  → fallback to brand comment with brandReviews quote
  //   product_category → category comment with categoryReviews quote
  //                    → fallback to brand comment with brandReviews quote
  //   brand_match    → brand comment with brandReviews quote (no further fallback)
  //
  // Legacy `template` field is kept and read as a fallback for templateProduct
  // when the new field is unset, so existing brands keep working.
  commentReply: {
    enabled:           { type: Boolean, default: false },
    template:          { type: String,  default: 'Shop this look: {productUrl}' },   // legacy; back-compat alias for templateProduct
    templateProduct:   { type: String,  default: '"{productQuote}" · Shop the {productName} → {productUrl}' },
    templateCategory:  { type: String,  default: '"{categoryQuote}" · Shop {breadcrumb} → {categoryUrl}' },
    templateBrand:     { type: String,  default: '"{brandQuote}" · Discover {brandName} → {brandUrl}' },
    dailyCap:          { type: Number,  default: 25 },                                // total comments per UTC day
    perMediaCap:       { type: Number,  default: 3 },                                 // max comments per single Media
    fallbackToCategory:{ type: Boolean, default: true },                              // product → category fallback
    fallbackToBrand:   { type: Boolean, default: true }                               // category → brand fallback
  },

  // Upload Consolidation — per-brand controls for the unified upload
  // flow. autoCreateFromDetect: when true, confident product_match
  // outcomes auto-write draft CatalogProduct rows. Off by default so
  // brands opt in deliberately (drafts need price + productUrl filled
  // in before they're matchable).
  uploadSettings: {
    autoCreateFromDetect: { type: Boolean, default: false }
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

brandSchema.pre('save', function(next) { this.updatedAt = Date.now(); next(); });

// Compound unique key — one "Pelagic" per Advertiser, but multiple
// Advertisers can each have their own. The migration script drops
// the legacy single-field unique index on nameNormalized and
// creates this compound one in its place.
brandSchema.index({ advertiserId: 1, nameNormalized: 1 }, { unique: true });

module.exports = mongoose.model('Brand', brandSchema);
module.exports.normalizeBrandName = normalizeBrandName;
