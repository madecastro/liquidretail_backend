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
  // Logo provenance and ingest audit. Website logos are discovered from
  // structured data, header/nav markup, manifests and rendered storefronts,
  // then mirrored to Cloudinary before this URL is stored.
  logoSource:      { type: String, default: null },
  logoOriginalUrl: { type: String, default: null },
  logoIngestedAt:  { type: Date, default: null },
  logoIngestError: { type: String, default: null },
  primaryColor:   String,
  secondaryColor: String,
  accentColor:    String,
  // Page/surface background captured from the brand's own website
  // (hex like '#FFFFFF'). Used to flatten transparent product imagery
  // onto a real brand surface before AI seed transforms (Cloudinary
  // b_rgb). Nullable — absent brands default to white at transform time.
  // NEVER inferred from meta theme-color (that is brand accent, not surface).
  websiteBackground: String,
  // Brand's canonical text/font color — what they use for body and
  // headline copy on their own site. Captured from Brandfetch's
  // `text`-type color when present; GPT-suggested otherwise.
  fontColor:      String,
  fontFamily:     String,
  // Provenance of fontFamily — drives the "(suggested)" UI hint and
  // lets curation distinguish a real brand font from an approximation.
  // 'tailwind'    — read out of the site's Tailwind config / CSS custom props
  // 'brandfetch'  — pulled from Brandfetch's brand-kit API
  // 'scraped'     — parsed from a Google Fonts <link> on the homepage
  // 'website'     — promoted from a face brandFontIngestService actually
  //                 ingested and mirrored (the strongest signal: we hold the
  //                 file). Set by brandFontPersistenceService.
  // 'shopify-theme'— promoted from a face shopifyThemeFontService ingested
  //                 from the brand's Shopify THEME (added 2026-08-31) —
  //                 also a real mirrored file, just sourced from the
  //                 storefront's theme CSS/Admin API instead of a marketing
  //                 homepage. Set by
  //                 brandFontPersistenceService.applyShopifyFontIngestResult,
  //                 which deliberately never overrides an existing
  //                 'website' fontSource — see that function's header.
  // 'meta-ads'    — identified by a vision model in the brand's own Meta ad
  //                 creatives (metaAdsFontService). A NAME, not a file.
  // 'suggested'   — GPT-4.1 derived from brand tone/summary (best-effort)
  // 'tone-default'— hardcoded tone→font safety net when GPT also failed
  // 'curated'     — set explicitly by a human via PATCH /api/brand/:id
  // null is included in the enum so brands that pre-date this field
  // (or rows where every enrichment tier returned no font) pass
  // validation. Mongoose's enum check rejects null even on non-
  // required fields when a default isn't matched, so we explicitly
  // allow it here.
  fontSource:     { type: String, enum: ['tailwind', 'website', 'shopify-theme', 'meta-ads', 'brandfetch', 'scraped', 'suggested', 'tone-default', 'curated', null], default: null },
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
  // backfill. Values: 'tailwind' | 'brandfetch' | 'scraped' | 'gpt' |
  // 'brand-reviews'.
  // Resets when curation explicitly removes a field, when the
  // websiteUrl changes, or via /refresh-enrichment.
  enrichmentSources: [String],

  // Public Tailwind theme signals recovered from a brand's published site.
  // A real tailwind.config file is rarely exposed, so this stores only
  // confidence-gated inline config or generated-CSS variables; never a
  // guessed reconstruction. Automatic precedence is Tailwind > Brandfetch
  // > scrape/GPT, while curated fields always win.
  tailwindTheme: { type: mongoose.Schema.Types.Mixed, default: null },

  // Currently-running enrichment tier name, or null when nothing is
  // running. Updated incrementally by enrichBrandFromUrl so the brand
  // page can poll and show "Detecting brand kit (Brandfetch)…" etc.
  // Values mirror enrichmentSources entries: 'tailwind' | 'brandfetch' |
  // 'scraped' | 'gpt' | 'brand-reviews' | null.
  enrichmentStage:    { type: String, default: null },

  // Diagnostic breadcrumb for "enrichment could not run" — previously a
  // SILENT no-op (return value discarded by every fire-and-forget caller,
  // nothing written to the doc). Set whenever enrichBrandFromUrl declines
  // to run (today: missing websiteUrl) so a starved brand is queryable
  // instead of indistinguishable from "never tried". Cleared the moment
  // enrichment is attempted again — a stale reason must not outlive the
  // condition that caused it (e.g. websiteUrl gets backfilled by catalog
  // ingest and enrichment then actually runs). This does NOT change
  // control flow: enrichment still declines gracefully rather than
  // throwing, preserving every existing fire-and-forget caller's contract.
  enrichmentSkipReason: { type: String, default: null },
  enrichmentSkippedAt:  { type: Date,   default: null },

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
    postsCadenceHours:    { type: Number,  default: 1 },
    // Ad Platforms Phase B-5 — how often the scheduler resyncs Meta /
    // Google Ads campaigns (and re-runs the creative matcher). 6h is
    // the default; campaigns mutate less than IG posts but more than
    // a brand's catalog.
    campaignCadenceHours: { type: Number,  default: 6 }
  },

  // Scheduled re-sync of Shopify-direct / generic-sitemap / Apify catalogs
  // (scheduledSyncService.runDueCatalogResyncs). Distinct from
  // IntegrationCredential.lastCatalogSyncAt (IG/Meta catalog). Strict
  // schema — undeclared paths are dropped. Stamped on SUCCESS only so a
  // deploy-killed in-flight run is retried on the next due tick (no resume).
  lastCatalogResyncAt: { type: Date, default: null },

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

  // Per-brand (per-client) video-generation settings. Mixed so the
  // per-canvas override map can use aspect-ratio keys like '1.91:1'
  // (dots are illegal in Mongoose Map keys). Shape:
  //   { model:               '<atlasVideoService.MODEL_CAPS slug>' | null,
  //     modelByCanvas:       { '<platformFormat or aspectRatio>': '<slug>' } | null,
  //     referenceImageCount: 1–7 | null,    // default 3 (primary + 2 alts)
  //     titlingEngine:       'canvas' | 'remotion' | null,
  //     titlePlacementMode:  'canonical' | 'content' | null }
  // Resolution chain (most specific wins): CatalogProduct.videoSettings
  // → Brand.videoSettings → ATLAS_VIDEO_MODEL env → built-in default.
  // Slugs are validated against MODEL_CAPS on PATCH and again at render
  // time (unknown slugs warn + fall through). titlingEngine picks the
  // title compositor per brand (chain: custom styleScript forces canvas →
  // brand titlingEngine → TITLING_ENGINE env → 'remotion'); validated in
  // atlasVideoService.validateVideoSettings. titlePlacementMode: request >
  // brand > 'canonical' (TITLE_PLATE_SCAN=off forces canonical). Mixed
  // field — route handlers must markModified('videoSettings') on writes.
  videoSettings: { type: mongoose.Schema.Types.Mixed, default: null },

  // Runtime-selectable static-ad renderer. This is intentionally stored on
  // the Brand, not in a deploy-time environment variable: operators can
  // switch the next concept-driven static render from the application.
  //
  // 2026-07-31 — 'direct_overlay' RETIRED at owner instruction ("kill the direct
  // image with overlay path, it was never used and nobody liked it"). That mode
  // asked the image model for a deliberately text-free plate and then composited
  // every headline, rating, quote and CTA locally as SVG. It is replaced by
  // 'direct_image', where the model typesets the copy itself from the proven
  // intent prompts (services/staticAdIntents.js). The brand LOGO is still
  // composited locally and is never sent to the model — owner-specified, and the
  // one deliberate exception to "the model renders everything".
  //
  // 2026-08-02 Stage 1 — 'html' REMOVED from the writeable enum. Zero brands
  // used it. The brand write route rejects it with 400. resolveStaticPipeline()
  // still reads a stored 'html' safely (legacy), but nothing can SET it now.
  //
  // NO BACKFILL (house rule: forward-only). Brands still holding the retired
  // 'direct_overlay' string are not migrated; resolveStaticPipeline() treats
  // anything that is not exactly 'html' as the direct path, so those rows
  // land on 'direct_image' by themselves and nothing throws on read.
  staticImagePipeline: {
    type: String,
    enum: ['direct_image'],
    default: 'direct_image'
  },

  // Per-brand overrides of the meta-field cascades (services/metaCascadeConfig.js).
  // Sparse map of `field → source[]`. A field present here REPLACES the
  // default cascade for that field entirely (simpler mental model than
  // merge semantics). Fields absent from this object inherit the shipped
  // default. Validated on PATCH via metaCascadeResolver.validateBrandOverrides.
  // Mixed — route handlers must markModified('metaCascades') on writes.
  metaCascades: { type: mongoose.Schema.Types.Mixed, default: null },

  // Sales demo brand. Owned by the "Sales Demos" Advertiser and
  // populated via Apify scraping (public IG posts + Shopify products)
  // instead of OAuth ingest. Filtered out of normal customer-facing
  // brand lists. Ingest limits live in server .env (APIFY_IG_LIMIT,
  // APIFY_SHOPIFY_LIMIT); Apify token is server-wide (APIFY_TOKEN).
  isDemo:    { type: Boolean, default: false, index: true },
  apifyDemo: {
    igHandle:      { type: String, default: null },  // '@' stripped, lowercase
    // Catalog/store URL for ingestion. Named 'shopifyUrl' for historical
    // reasons but reused as the generic target URL for the
    // 'generic-sitemap' method too (non-Shopify sites — it's a plain
    // string with no Shopify-specific validation). e.g. 'https://store.example.com'
    shopifyUrl:    { type: String, default: null },
    lastSyncedAt:  { type: Date,   default: null },
    // Catalog ingest method: 'shopify-direct' (free, documented public
    // Shopify endpoints — default when shopifyUrl is set) | 'apify' (paid
    // actor) | 'generic-sitemap' (client-agnostic XML-sitemap + schema.org
    // JSON-LD scraper for non-Shopify server-rendered stores; uses
    // shopifyUrl as the target). IG posts ride Apify in all modes. Typed
    // subdoc — a value missing from this schema is silently dropped by
    // strict mode, so keep this field list in sync with
    // salesDemosService.normalizeMethod.
    // `null` is explicitly in the enum so brand docs with an unset
    // method (all non-demo brands + demo brands that haven't picked
    // yet) pass full-doc validation on save. Without null here, any
    // PATCH that triggers brand.save() (Title Studio, Content Sources,
    // Video Model, etc.) errors: "null is not a valid enum value for
    // path `apifyDemo.method`". The default:null intent stays intact.
    method:        { type: String, enum: ['shopify-direct', 'apify', 'generic-sitemap', null], default: null },
    // Cooperative cancellation flag. /abort sets true; the ingest
    // service resets it to false at the start of every sync and
    // checks it between records, bailing early when flipped mid-run.
    aborted:       { type: Boolean, default: false },
    // Atomic lock for the user-actuated "Enrich" run (paid SerpAPI/Gemini).
    // Set via a conditional findOneAndUpdate so two concurrent POST
    // /brands/:id/enrich can't both start a run + double-spend; cleared
    // when the enrichment finishes.
    enrichInFlight: { type: Boolean, default: false }
  },

  // Per-brand video-chrome style overrides. Mirrors the shape of the
  // services/brandStyles/*.js modules (role_layout, fonts, colors,
  // fontSizes, cornerInset, centerMaxWidthRatio). When set, wins over
  // the JS-file style for this brand. When null, brand falls back to
  // the JS file (if a slug alias matches) or renderer defaults.
  // Mixed so the shape can evolve without a schema migration — the
  // renderer's own defaults absorb any missing keys.
  styleOverrides: { type: mongoose.Schema.Types.Mixed, default: null },

  // Per-brand canvas overlay script for FEED formats (4:5, 1:1). Raw
  // JS source exporting a renderFrame(frameIndex, ctx, plate, meta, h)
  // function. Run in a sandboxed child process by
  // services/brandScriptExecutor.js after the base video finishes.
  // Escape hatch for brands that want a fully bespoke feed renderer —
  // most brands opt into styleTheme + shared canonical instead.
  //
  // Per-format executor priority (feed):
  //   styleScript → (canonical feed + styleTheme) → no chrome
  styleScript: { type: String, default: null },

  // Per-brand canvas overlay script for VERTICAL formats (9:16 — Reels,
  // Shorts, Stories). Same shape as styleScript. Separate slot because
  // vertical and feed have distinct design constraints and typical
  // brands may customize one without the other.
  //
  // Per-format executor priority (vertical):
  //   styleScriptVertical → (canonical vertical + styleTheme) → no chrome
  styleScriptVertical: { type: String, default: null },

  // Per-brand canvas overlay script for LANDSCAPE formats (16:9 — Google
  // Performance Max, YouTube pre-roll, Meta feed 16:9). Same shape as
  // styleScript. Uses the local-scrim editorial layout by default —
  // content pinned to the left column with per-element scrims instead
  // of a single large gradient scrim.
  //
  // Per-format executor priority (landscape):
  //   styleScriptLandscape → (canonical landscape + styleTheme) → no chrome
  styleScriptLandscape: { type: String, default: null },

  // Per-brand theme JSON consumed by the shared canonical brand-script
  // renderer (services/brandScripts/canonical.script.js or the DB
  // SystemConfig override). Colors, font families, and specific text
  // overrides — layout and animation stay fixed in the canonical.
  // Passed into meta.theme at render time.
  styleTheme: { type: mongoose.Schema.Types.Mixed, default: null },

  // Remotion titling engine — per-format declarative style specs. Shape:
  //   { vertical?: <spec>, feed?: <spec>, landscape?: <spec> }
  // where <spec> follows services/titleSpecValidator.js (phases, slots
  // with position/timing/transition/treatment, tokenOverrides). Written
  // by the operator style-modification flow (LLM emits a full updated
  // spec → validated → previewed → saved). Wins over titleStylePreset
  // and the shipped canonical preset for its format. Mixed — validated
  // by validateTitleStyleSpecDoc on PATCH, never trusted at render time
  // either (titleSpecService re-validates and falls back on invalid).
  titleStyleSpec: { type: mongoose.Schema.Types.Mixed, default: null },

  // Named preset from remotion/presets/*.json this brand renders with
  // when it has no titleStyleSpec override for a format (e.g.
  // 'babyboo-main-character'). Null → shipped canonical.
  titleStylePreset: { type: String, default: null },

  // Font files ingested from the brand's own website by
  // brandFontIngestService (the "titling must use the brand's real
  // fonts" pipeline). Entries:
  //   { family, weight, style, format ('woff2'|'woff'|'ttf'|'otf'),
  //     url (Cloudinary raw mirror — null when flagged),
  //     sourceUrl, source: 'website',
  //     license: 'google'|'open'|'commercial'|'unknown',
  //     needsLicense, ingestedAt }
  // Commercial-foundry faces (Typekit/Adobe Fonts etc.) are ALWAYS
  // classified license:'commercial', but whether the file is actually
  // downloaded and mirrored to Cloudinary depends on
  // BRAND_FONT_ASSUME_LICENSED (services/brandFontIngestService.js;
  // config/defaults.env, default true): flag ON (the shipped default)
  // downloads and mirrors it like any other face, `url` populated,
  // `needsLicense:false`; flag OFF is the "recorded but never
  // downloaded, client must supply licensed files" behavior this
  // comment used to describe unconditionally — CORRECTED 2026-08-19,
  // it was describing only the non-default arm. Every download is
  // magic-byte-validated before mirroring (downloadFontFile / isFontMagic)
  // regardless of license class, so a failed/blocked fetch (e.g. a
  // foundry CDN 400 without the right Referer) is flagged
  // `{url:null, needsLicense:true}`, never a false success — an entry
  // with a real `url` here has already been byte-verified as a real
  // font file. fontResolverService prefers these over Google Fonts when
  // families match (services/fontResolverService.js `familyKey()`
  // normalizes both sides, so e.g. Brandfetch's "Aktiv Grotesk" and a
  // scraped CSS "aktiv-grotesk" resolve to the same entry).
  customFonts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Font roles observed in the customer's own CSS during font ingest.
  // Shape: { heading?, body?, button?, evidence: [{ family, role, selector }] }.
  // This lets the resolver choose the website's actual heading/body face
  // when the site declares several @font-face families.
  websiteFontUsage: { type: mongoose.Schema.Types.Mixed, default: null },
  // Successful or attempted automatic website-font scan. A timestamp is
  // recorded even when the site exposes no reusable faces so render-time
  // resolution does not repeatedly crawl the storefront. CORRECTED
  // 2026-08-31: it is NOT recorded on a fetch/parse EXCEPTION (see
  // brandEnrichmentService.js's website-fonts catch) — this scan is a plain
  // free HTTP fetch, so a transient 404/DNS blip must stay retryable rather
  // than permanently disabling the scan for that brand.
  fontIngestedAt: { type: Date, default: null },
  fontIngestError: { type: String, default: null },

  // Typefaces IDENTIFIED (not downloaded) in the brand's own Meta ad creatives
  // by metaAdsFontService — the second source for brands whose website hides
  // its font behind a 403ing foundry CDN or a JS-injected stack.
  // Shape: { heading, body: { family, confidence: 'high'|'medium'|'low',
  //          closestGoogle } | null,
  //          evidence: [{ family, role, confidence, closestGoogle, creativeId,
  //          via: 'campaign-docs'|'connected'|'adlibrary', usableForExact }] }
  // THIS IS A NAME, NEVER A FILE — a raster creative embeds no font. Only a
  // 'high'-confidence entry may outrank a curated theme, and then only when the
  // name resolves to an actual file; see buildFontLadders.
  metaAdsFontUsage: { type: mongoose.Schema.Types.Mixed, default: null },
  // A MONEY-GATED attempt stamp, not a plain "we looked" mark — CORRECTED
  // 2026-08-31, this comment previously said it was set even when no
  // creative was found, full stop, which was true and also the bug: it
  // stamped on a config-absence non-run (no Meta Ads credential connected,
  // APIFY_ADLIB_ACTOR unset) exactly the same as on a genuine paid miss,
  // permanently disabling the scan for a brand that had never actually been
  // looked at. It is set only when a billable call actually ran (a vision
  // call, or an Apify actor submit) — see
  // metaAdsFontService.identifyBrandAdFonts's `billableAttempted` and
  // brandFontPersistenceService.applyMetaFontsResult. All 9 production
  // brands were found stamped from the config-absence branch on
  // 2026-08-31; scripts/clearConfigAbsentMetaFontStamps.js is the one-off
  // remediation for rows stamped before this fix.
  metaFontsIngestedAt: { type: Date, default: null },
  metaFontsIngestError: { type: String, default: null },

  // Successful or attempted automatic SHOPIFY THEME font scan
  // (services/shopifyThemeFontService.js, added 2026-08-31) — a SIBLING
  // stamp to fontIngestedAt above, not a reuse of it: this scans the
  // brand's Shopify storefront theme (with its own myshopify-headless
  // discovery ladder and an optional Admin-API path), which is a genuinely
  // different origin/mechanism from the marketing-homepage scan and needs
  // its own independent retry gate — see
  // brandFontPersistenceService.applyShopifyFontIngestResult's header for
  // why conflating the two stamps would be wrong. Faces it finds land in
  // the SAME Brand.customFonts / websiteFontUsage fields as the website
  // scan (tagged `source:'shopify-theme'` per-entry for audit), so
  // fontResolverService needs no changes.
  // Like fontIngestedAt, this is FREE (plain HTTP, or an Admin API call
  // billed to the merchant's own Shopify plan, never to us) — a fetch/parse
  // failure must stay retryable, so this is NEVER stamped on failure (see
  // brandEnrichmentService.js's shopify-theme-fonts tier: only the success
  // branch calls applyShopifyFontIngestResult).
  shopifyFontsIngestedAt: { type: Date, default: null },
  shopifyFontsIngestError: { type: String, default: null },

  // Derived voice — structured profile extracted by
  // brandVoiceDerivationService from the brand's existing Meta/Google
  // ad creatives, performance-weighted by Campaign.insights so winners
  // dominate the signal. Threaded into aiCreativeDirectorService as
  // EXISTING BRAND VOICE context so new ads mirror what's already
  // working. Refreshed manually via POST /api/brands/:id/derive-voice
  // and on a nightly cron when older than the TTL.
  //
  // Shape (Mixed so we can evolve without migrations):
  //   { tone:           [String],
  //     value_props:    [String],
  //     hooks:          [String],            // 'problem-solution', 'social-proof', 'urgency', ...
  //     cta_patterns:   [{ text, frequency }],
  //     common_phrases: [String],
  //     audience_pitch: [{ segment, pitch_style }],
  //     voice_summary:  String,
  //     evidence_count: Number,              // ads analyzed
  //     weighted:       Boolean,             // whether insights were used to weight the corpus
  //     model:          String,
  //     promptVersion:  String }
  derivedVoice:   { type: mongoose.Schema.Types.Mixed, default: null },
  derivedVoiceAt: { type: Date, default: null },

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
