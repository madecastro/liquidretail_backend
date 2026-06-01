// Campaign → Queue expansion. Single entry point: the Generate Ads
// wizard. Takes operator selections + the chosen campaign, expands
// to ALL viable (product × media × template × ratio × variant)
// combinations, and persists each as a queued Ad doc.
//
// The render run then picks the top N from the queued inventory by
// readinessScore — leftover queued ads stay for subsequent
// "render more from this campaign" passes.
//
// Seed rules (per operator pick):
//
//   1. No picks (brand-only):
//      → every brand_match media (capped by BRAND_ONLY_MEDIA_LIMIT)
//        emits a `ugc` variant seed with productId:null and
//        matchTier='brand_only'.
//
//   2. mediaIds (media-driven, library entry):
//      → for each media, dispatch by ProductMatchArtifact.outcome:
//          product_match    → one ugc seed featuring match.catalogProductId,
//                             matchTier='product_match'
//          product_category → one ugc seed per recommendedProduct,
//                             matchTier='product_category'
//          brand_match      → one ugc seed with productId:null,
//                             matchTier='brand_match'
//          (no PMA)         → fall back to brand_match
//
//   3. productIds (product-driven, catalog entry):
//      → for each productId, gather EVERY matched media:
//          all product_match media   → ugc seeds, matchTier='product_match'
//          all product_category media (where this product is in
//             recommendedProducts) → ugc seeds, matchTier='product_category'
//          all brand_match media (productId attached for tracking)
//                                  → ugc seeds, matchTier='brand_match'
//        Plus ONE product_image seed per product — uses the catalog
//        product's hero Media doc as the media slot, productId set,
//        matchTier inherits 'product_match' (the product IS the SKU).
//
// Cartesian expansion across seeds × allowedTemplates × ratios is
// then bulk-inserted; per-campaign unique index on identityDigest
// rejects duplicates so this is idempotent (re-running with the
// same picks doesn't double-queue).

const crypto = require('crypto');
const mongoose = require('mongoose');

const Campaign              = require('../models/Campaign');
const Media                 = require('../models/Media');
const CatalogProduct        = require('../models/CatalogProduct');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const Ad                    = require('../models/Ad');
const registry              = require('./templateRegistry');

// Cast a string/ObjectId to ObjectId. Required when querying
// metadata.catalogProductId (Mixed type) — Mongoose doesn't auto-cast
// inside Mixed, so string from req.body won't match the stored ObjectId.
function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;
}

const SUPPORTED_TEMPLATES = new Set([
  'testimonial_spotlight',
  'ugc_split_screen',
  'testimonial_overlay',
  'product_overlay',
  'ai_brand_led'                  // Phase 1c — LLM-emitted canvas spec at render time
]);

// Per-template variant whitelist. Some templates are inherently UGC
// (the design IS a creator quote over a real-world photo) and don't
// make sense for a catalog hero shot; others work for either source.
// Cartesian is filtered by this map so we don't queue combos that
// will look obviously wrong.
const TEMPLATE_SUPPORTS_VARIANT = {
  testimonial_spotlight: new Set(['ugc', 'product_image']),
  ugc_split_screen:      new Set(['ugc', 'product_image']),
  testimonial_overlay:   new Set(['ugc']),                       // creator quote over UGC photo — needs UGC source
  product_overlay:       new Set(['ugc', 'product_image']),
  ai_brand_led:          new Set(['ugc', 'product_image'])
};

// Aspect ratios we're shipping ad output for in V1.
const SHIPPING_RATIOS = new Set(['1:1', '9:16', '16:9']);

// Brand-only inventory cap. Without picks, this limits how many of
// the brand's brand_match media get pulled into the queue.
const BRAND_ONLY_MEDIA_LIMIT = 25;

// Readiness scoring weights — match tier carries the lion's share of
// signal. adSuitability is per-media quality; tier weight is per-
// (media,product) match quality. Combined multiplicatively.
const TIER_WEIGHTS = {
  product_match:    1.0,
  product_category: 0.8,
  brand_match:      0.6,
  brand_only:       0.5
};

// Catalog product images don't carry a meaningful Media.adSuitability
// (the score is tuned for UGC composition signals — face/subject
// quality, scene density, etc.). Use a fixed quality assumption.
const PRODUCT_IMAGE_QUALITY = 0.7;

// Cap on cross-product expansion per single post seed. When the
// operator picks a media that's product_category-matched (or only
// brand_matched), the post pairs with the top-K products in the
// category or catalog by popularityScore. Bounds the cartesian to
// stay manageable on large catalogs.
const EXPANSION_PRODUCTS_PER_POST = Math.max(1, parseInt(process.env.EXPANSION_PRODUCTS_PER_POST, 10) || 25);

// After cartesian expansion, queue at most this many Ad payloads per
// generation run. Sorted by readinessScore desc before trim so the
// strongest combinations land. Re-running the wizard for the same
// picks queues additional combinations (idempotent dedup at insert).
const MAX_ADS_PER_GENERATION_RUN = Math.max(1, parseInt(process.env.MAX_ADS_PER_GENERATION_RUN, 10) || 200);

// Composite product popularity. Primary signal: how many UGC posts
// have matched this product (genuine popularity proxy on the brand's
// own social inventory). Secondary signal: catalog review strength
// (rating × log(reviewCount)). Capped at 1.0 so a product can't
// outrun the readinessScore math via popularity alone.
//
// log10(matchedMedia.length + 1) / 2 — 0→0, 9→0.5, 99→1.0
// (rating/5) × log10(reviewCount+1) / 3 — 5★/100 reviews → 0.67
function productPopularityScore(catalogProduct) {
  if (!catalogProduct) return 0;
  const ugcCount    = Array.isArray(catalogProduct.matchedMedia) ? catalogProduct.matchedMedia.length : 0;
  const rating      = typeof catalogProduct.rating === 'number' ? catalogProduct.rating : 0;
  const reviewCount = Array.isArray(catalogProduct.reviews) ? catalogProduct.reviews.length : 0;
  const ugcSig    = Math.log10(ugcCount + 1) / 2;
  const reviewSig = (rating / 5) * (Math.log10(reviewCount + 1) / 3);
  return Math.min(1, ugcSig + reviewSig);
}

// Engagement-weighted score from platformStats. Saves and shares are
// higher-intent than likes; comments express deeper engagement than a
// passive like. Weighted raw → log-normalized to 0-1 so a viral post
// doesn't dwarf the rest of the queue (an order-of-magnitude jump is
// worth ~0.25 score). Returns null when no engagement signal is
// available; callers blend a 0.5 default in.
function engagementScore(platformStats) {
  if (!platformStats || typeof platformStats !== 'object') return null;
  const likes    = Number(platformStats.likes)    || 0;
  const comments = Number(platformStats.comments) || 0;
  const saves    = Number(platformStats.saves)    || 0;
  const shares   = Number(platformStats.shares)   || 0;
  const raw = likes + (2 * comments) + (2 * saves) + (3 * shares);
  if (raw <= 0) return null;
  // log10(raw+1) / 4 — 10 ≈ 0.26, 100 ≈ 0.50, 1000 ≈ 0.75, 10000 ≈ 1.0
  return Math.min(1, Math.log10(raw + 1) / 4);
}

// UGC readiness = tier × quality, where quality blends engagement
// (60%) with adSuitability (40%). Engagement captures audience pull;
// adSuitability captures composition (focus / brightness / density).
// Mixing both means a blurry viral post still ranks below a sharp
// viral post, and a stunning low-engagement post still ranks below a
// solid mid-engagement post. Null-side falls back to a 0.5 default
// so single-signal media isn't penalized into oblivion.
// Videos participate at parity with images — engagement on Reels is
// often higher than feed photos for the same brand, and the static
// renderer composites video poster frames cleanly.
function readinessScoreFor(matchTier, fileType, adSuitabilityScore, platformStats) {
  const tier = TIER_WEIGHTS[matchTier] ?? 0.5;
  const eng  = engagementScore(platformStats);
  const ads  = (typeof adSuitabilityScore === 'number') ? adSuitabilityScore : null;
  const engPart = eng ?? 0.5;
  const adsPart = ads ?? 0.5;
  const quality = (0.6 * engPart) + (0.4 * adsPart);
  return Number((tier * quality).toFixed(4));
}

function readinessScoreForProductImage(matchTier) {
  const tier = TIER_WEIGHTS[matchTier] ?? 0.5;
  return Number((tier * PRODUCT_IMAGE_QUALITY).toFixed(4));
}

// sha256 over the identity inputs that uniquely define an Ad in the
// queue. Same digest on the same campaign = same Ad = unique index
// rejects the duplicate insert. paletteSource doubles the identity
// space so media-palette and brand-palette renders for the same
// (media, product, template, ratio, variant) coexist as separate Ads.
function computeIdentityDigest({ campaignId, productId, mediaId, template, aspectRatio, variantKind, paletteSource, ctaText, ctaUrl, ctaUrlParams, rafflePrizeMediaId }) {
  const payload = JSON.stringify({
    campaignId:    String(campaignId),
    productId:     productId ? String(productId) : null,
    mediaId:       String(mediaId),
    template,
    aspectRatio,
    variantKind,
    paletteSource: paletteSource || 'media',
    ctaText:       String(ctaText || ''),
    ctaUrl:        String(ctaUrl  || ''),
    ctaUrlParams:  String(ctaUrlParams || ''),
    // Per-prize raffle variants — without this, multiple prize media
    // would dedupe to a single ad and the cartesian wouldn't actually
    // produce per-prize takes.
    rafflePrizeMediaId: rafflePrizeMediaId ? String(rafflePrizeMediaId) : null
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ── Public API ───────────────────────────────────────────────────────

// Expand the wizard payload into queued Ad docs.
// Returns:
//   {
//     campaignId, brandId, campaignKind,
//     queuedCount,        — total Ad docs in this campaign with status='queued' after this call
//     newlyQueued,        — number of new docs inserted by THIS call
//     alreadyQueued,      — number of combinations that were already queued
//     newAdIds            — ObjectIds of the docs newly inserted (for immediate selection)
//   }
async function expandWizardJob({
  campaignId,
  productIds   = [],
  mediaIds     = [],
  templateIds  = [],
  cta          = {},
  urlParams    = '',
  requestedBy  = null,
  // [{ productId, mediaId }] — globally drop these (productId, mediaId)
  // tuples from the cartesian. The wizard's Step 2 picker collects
  // these as the operator clicks the X on individual related-tile
  // pairings; passed through here so brand_match seeds (productId=null)
  // can also be excluded when mediaId matches.
  excludePairings = [],
  // Tier expansion toggles for product-kind picks. Default false so a
  // product campaign only includes product_match (strict tier 1) UGC
  // unless the operator opted in via the wizard's "Include category-
  // matched" / "Include brand-matched" expand buttons in Step 2.
  // Brand-only and media-driven seed paths ignore these flags.
  includeCategoryMatched = false,
  includeBrandMatched    = false
}) {
  if (!campaignId) throw new Error('campaignId required');

  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

  const brandId      = String(campaign.brandId);
  // Default to 'product' for kind-less campaigns. The legacy default
  // was 'promotional' but with our new derivation-prompt branching,
  // 'promotional' implies operator-supplied offer details; defaulting
  // to it for legacy rows would mis-route the derivation. 'product'
  // matches existing composition behavior (the prompt's product-mode
  // path) for any campaign whose kind wasn't explicitly set.
  const campaignKind = campaign.kind || 'product';
  const promotionalDetails = campaign.promotionalDetails || null;
  const allowedTemplates = templateIds.filter(t => SUPPORTED_TEMPLATES.has(t));
  if (!allowedTemplates.length) {
    throw new Error(`No supported templates in selection. V1 supports: ${Array.from(SUPPORTED_TEMPLATES).join(', ')}`);
  }

  const ctaText      = String(cta.text || '');
  const ctaUrl       = String(cta.url  || '');
  let   ctaUrlParams = String(urlParams || '').replace(/^[?&]/, '');

  // Auto-stamp the discount code onto the landing URL for promotional
  // campaigns. Without this, operators have to manually paste the code
  // into urlParams on every ad-gen run, and it tends to drift out of
  // sync with the campaign's promotionalDetails.discountCode value.
  // Skipped when the operator already supplied `code=` in their params
  // (per-channel overrides win) — we don't want to override a tracking-
  // specific code with the campaign default.
  const promoDiscountCode = (campaign.promotionalDetails?.discountCode || '').trim();
  if (promoDiscountCode && !/[?&]?\bcode=/i.test(ctaUrlParams)) {
    const encoded = encodeURIComponent(promoDiscountCode);
    ctaUrlParams = ctaUrlParams ? `${ctaUrlParams}&code=${encoded}` : `code=${encoded}`;
    console.log(`📦 expandWizardJob: stamped discount code "${promoDiscountCode}" onto ctaUrlParams`);
  }

  // ── 1. Build seeds — flat list of {productId, mediaId, matchTier, variantKind, suitabilityScore, fileType} ──
  const useBrandOnly = productIds.length === 0 && mediaIds.length === 0;
  let seeds = [];

  if (useBrandOnly) {
    seeds = await seedFromBrandOnly(brandId, BRAND_ONLY_MEDIA_LIMIT);
  } else {
    for (const mediaId of mediaIds) {
      const mediaSeeds = await seedsFromMedia(brandId, mediaId);
      seeds.push(...mediaSeeds);
    }
    for (const productId of productIds) {
      const productSeeds = await seedsFromProduct(brandId, productId, {
        includeCategoryMatched,
        includeBrandMatched
      });
      seeds.push(...productSeeds);
    }
  }

  // Apply operator exclusions BEFORE dedup so the dedup keys aren't
  // reused by an excluded pair (defensive — dedup compares whole tuple
  // including productId, so this is belt+braces).
  if (excludePairings.length) {
    const excludeKeys = new Set(
      excludePairings.map(p => `${p.productId ? String(p.productId) : 'NULL'}|${String(p.mediaId)}`)
    );
    const before = seeds.length;
    seeds = seeds.filter(s => {
      const key = `${s.productId ? String(s.productId) : 'NULL'}|${String(s.mediaId)}`;
      return !excludeKeys.has(key);
    });
    if (before !== seeds.length) {
      console.log(`📦 expandWizardJob: excludePairings dropped ${before - seeds.length} seed(s) (${excludePairings.length} exclusions configured)`);
    }
  }

  // Dedup by (productId|null, mediaId, variantKind) — picking the
  // same product via both library + catalog paths shouldn't queue
  // it twice in this pass. (Cross-pass dedup is handled by the
  // unique index at insert time.)
  seeds = dedupeSeeds(seeds);

  // ── 2. Cartesian: seeds × allowedTemplates × (template ratios ∩ SHIPPING_RATIOS) ──
  const grid = [];
  for (const templateId of allowedTemplates) {
    const tpl = registry.getNormalized(templateId);
    if (!tpl) continue;
    const ratios = (tpl.aspect_ratios?.supported || [])
      .filter(r => SHIPPING_RATIOS.has(r));
    for (const aspectRatio of ratios) {
      grid.push({ templateId, aspectRatio });
    }
  }

  // Each seed × template × ratio expands across TWO paletteSource
  // variants (media / brand). The 'media' variant draws style bindings
  // from the hero media's palette (palette_dominant / palette_vibrant
  // etc.); the 'brand' variant overrides those to brand.primaryColor /
  // accentColor / secondaryColor. Identical visual composition, two
  // colorways. Doubles the cartesian — the trim below caps total
  // payloads at MAX_ADS_PER_GENERATION_RUN.
  const PALETTE_SOURCES = ['media', 'brand'];

  // Raffle prize media — when the campaign has multiple prize media,
  // each one becomes its own ad variant per (template × ratio × palette
  // source). Non-raffle campaigns use a single-element [null] so the
  // outer loop is identical and the per-ad rafflePrizeMediaId stays
  // null. The first selected id is the "canonical" prize (non-rendered
  // contexts pick that one for thumbnails / banners).
  const rafflePrizeIds = (campaign.kind === 'promotional'
    && campaign.promotionalDetails?.discountType === 'raffle'
    && Array.isArray(campaign.promotionalDetails?.rafflePrizeMediaIds)
    && campaign.promotionalDetails.rafflePrizeMediaIds.length)
    ? campaign.promotionalDetails.rafflePrizeMediaIds.map(String)
    : [null];

  let payloads = [];
  for (const seed of seeds) {
    for (const cell of grid) {
      // Drop combos where the seed's variantKind isn't supported by the
      // template. e.g. testimonial_overlay is UGC-only — product_image
      // seeds for it would queue and then fail/look wrong at render.
      const supports = TEMPLATE_SUPPORTS_VARIANT[cell.templateId];
      if (supports && !supports.has(seed.variantKind)) continue;
      for (const paletteSource of PALETTE_SOURCES) {
        for (const rafflePrizeMediaId of rafflePrizeIds) {
          const identityDigest = computeIdentityDigest({
            campaignId,
            productId:     seed.productId,
            mediaId:       seed.mediaId,
            template:      cell.templateId,
            aspectRatio:   cell.aspectRatio,
            variantKind:   seed.variantKind,
            paletteSource,
            ctaText, ctaUrl, ctaUrlParams,
            rafflePrizeMediaId
          });
          const readinessScore = seed.variantKind === 'product_image'
            ? readinessScoreForProductImage(seed.matchTier)
            : readinessScoreFor(seed.matchTier, seed.fileType, seed.suitabilityScore, seed.platformStats);
          payloads.push({
            brandId,
            campaignId,
            campaignRunIds: [],
            mediaId:        seed.mediaId,
            productId:      seed.productId,
            template:       cell.templateId,
            aspectRatio:    cell.aspectRatio,
            campaignKind,
            matchTier:      seed.matchTier,
            variantKind:    seed.variantKind,
            paletteSource,
            rafflePrizeMediaId,
            readinessScore,
            status:         'queued',
            identityDigest,
            ctaText, ctaUrl, ctaUrlParams,
            queuedAt:       new Date(),
            generatedAt:    new Date()
          });
        }
      }
    }
  }

  // Cartesian limiter — bound per-run inventory growth. Sort by
  // readinessScore desc (videos with null sort last automatically),
  // trim to MAX_ADS_PER_GENERATION_RUN. Re-running the wizard with
  // the same picks queues the next batch (identityDigest dedup catches
  // any duplicates from the prior run).
  if (payloads.length > MAX_ADS_PER_GENERATION_RUN) {
    payloads.sort((a, b) => (b.readinessScore ?? -1) - (a.readinessScore ?? -1));
    const before = payloads.length;
    payloads = payloads.slice(0, MAX_ADS_PER_GENERATION_RUN);
    console.log(`📦 expandWizardJob: cartesian trim ${before} → ${payloads.length} (cap=${MAX_ADS_PER_GENERATION_RUN})`);
  }

  if (!payloads.length) {
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      queuedCount: await Ad.countDocuments({ campaignId, status: 'queued' }),
      newlyQueued: 0, alreadyQueued: 0, newAdIds: []
    };
  }

  // ── 3. Bulk insert — { ordered: false } so dup-key errors per
  // (campaignId, identityDigest) don't abort the rest of the batch.
  let inserted = [];
  try {
    inserted = await Ad.insertMany(payloads, { ordered: false });
  } catch (err) {
    // BulkWriteError carries successful inserts in result.insertedIds
    // alongside writeErrors[]. Extract the successes and continue.
    if (err.writeErrors && err.result?.insertedIds) {
      const insertedIds = err.result.insertedIds || {};
      inserted = Object.values(insertedIds);
      // Re-fetch to get full docs (insertedIds is just IDs, not docs)
      if (inserted.length) {
        inserted = await Ad.find({ _id: { $in: inserted } }).lean();
      }
    } else if (err.code === 11000) {
      // Single-doc dup — nothing inserted
      inserted = [];
    } else {
      throw err;
    }
  }

  const newAdIds = inserted.map(d => String(d._id || d));
  const alreadyQueued = payloads.length - newAdIds.length;
  const queuedCount = await Ad.countDocuments({ campaignId, status: 'queued' });

  console.log(
    `📦 expandWizardJob: campaign=${campaignId} seeds=${seeds.length} cartesian=${payloads.length} ` +
    `newlyQueued=${newAdIds.length} alreadyQueued=${alreadyQueued} totalQueued=${queuedCount}`
  );

  return {
    campaignId: String(campaignId),
    brandId,
    campaignKind,
    promotionalDetails,
    queuedCount,
    newlyQueued: newAdIds.length,
    alreadyQueued,
    newAdIds,
    cta: { text: ctaText, url: ctaUrl, params: ctaUrlParams },
    requestedBy
  };
}

// Selection — "next N queued ads for this campaign, ranked by
// readinessScore desc (videos with null score sort last, FIFO by
// queuedAt as tiebreaker)." Returns Ad IDs (strings).
async function selectAdsForRun({ campaignId, limit }) {
  const rows = await Ad.find({ campaignId, status: 'queued' })
    .sort({ readinessScore: -1, queuedAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();
  return rows.map(r => String(r._id));
}

// ── Seed builders ────────────────────────────────────────────────────

// Brand-only mode — pull all brand_match media for this brand, rank
// by suitability, take top N. productId stays null.
async function seedFromBrandOnly(brandId, topN) {
  const matches = await ProductMatchArtifact.find({
    brandId,
    outcome: 'brand_match'
  }).select('mediaId').lean();
  if (!matches.length) return [];
  const mediaIds = Array.from(new Set(matches.map(m => String(m.mediaId))));
  const medias = await loadMediasForScoring(mediaIds);
  // Rank the brand-only pool by the SAME blended quality that drives
  // readinessScore so the cap (BRAND_ONLY_MEDIA_LIMIT) keeps the best
  // posts. Pre-cap by composition-blended engagement so a slot-25
  // post isn't a sharp-but-dead photo while a sharp-AND-popular post
  // gets cut.
  // brand_only gate — pairs a brand-context post with no seed product
  // attribution. Visible products still risk a caption/text mismatch
  // (the LLM will surface a generic brand line, but a viewer sees a
  // specific jar). Apply the same filter as the Tier 3 brand_match
  // path in seedsFromProduct so the brand-only inventory is curated
  // to truly product-free brand moments.
  const ranked = medias
    .filter(isMediaEligibleByContentNature)
    .filter(m => !hasIdentifiedSpecificProduct(m) && !hasVisibleUnmatchedProduct(m))
    .map(m => ({
      m,
      score: readinessScoreFor('brand_only', m.fileType, m.adSuitability?.score, m.platformStats)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(({ m }) => m);
  return ranked.map(m => ({
    productId:        null,
    mediaId:          String(m._id),
    matchTier:        'brand_only',
    variantKind:      'ugc',
    fileType:         m.fileType,
    suitabilityScore: m.adSuitability?.score ?? null,
    platformStats:    m.platformStats || null
  }));
}

// Media-driven (library entry). Operator picked a specific media —
// iterate Media.matchedProducts to emit ONE seed per matched product
// (across ALL match tiers — not just the latest PMA's product). When
// the media has no product matches at all (or none with a catalog
// FK), fall back to a single brand_match seed so the operator's
// explicit pick still produces an ad.
// Operator picked a specific post (mediaId). Expand to (post, product)
// seeds following the detect outcome:
//
//   product_match    → 1 seed per matched product, tier='product_match'
//                      (post pairs with the SKU it actually featured)
//   product_category → top-K products in the matched category,
//                      tier='product_category' (synthetic pairing — the
//                      post matched the class, not the specific item)
//   brand_match      → top-K products in the brand's catalog,
//                      tier='brand_match' (weakest pairing — the post
//                      is brand-only content with no product signal)
//
// Post is ALWAYS the hero (variantKind='ugc'). Never emit
// variantKind='product_image' from a post seed — the post drives the
// ad's visual identity, the catalog product rides in the product panel
// via product.image / product.lifestyle_image / product.product_image.
//
// Operator-driven path: the post passed the operator's eyeball, so the
// content-nature gate (promotional / announcement filter) is bypassed.
// Inventory-pull paths (brand_only, brand_match fallback in
// seedsFromProduct) still apply the gate.
async function seedsFromMedia(brandId, mediaId) {
  const media = await Media.findById(mediaId)
    .select('matchedProducts matchedCategories adSuitability fileType classification platformStats')
    .lean();
  if (!media) return [];
  const baseSeed = {
    mediaId:          String(mediaId),
    variantKind:      'ugc',
    fileType:         media.fileType,
    suitabilityScore: media.adSuitability?.score ?? null,
    platformStats:    media.platformStats || null
  };

  // Case 1 — at least one refined product is a product_match.
  // matchedProducts captures BOTH product_match AND product_category
  // outcomes; partition by outcome.
  const productMatches = (media.matchedProducts || []).filter(mp => mp.catalogProductId);
  const trueProductMatches = productMatches.filter(mp => mp.outcome === 'product_match');
  if (trueProductMatches.length) {
    const seeds = trueProductMatches.map(mp => ({
      ...baseSeed,
      productId: String(mp.catalogProductId),
      matchTier: 'product_match'
    }));

    // Tier 0 alt expansion — for each matched product, emit one
    // product_image seed per catalog Media (hero + ranked alts) so
    // the catalog imagery fans out alongside the ugc seeds. Mirrors
    // seedsFromProduct's product_image emission; reuses the same
    // ranking helper. Note: this multiplies the cartesian — see
    // backlog 'Cartesian enumeration cap for alt-expanded runs'.
    for (const mp of trueProductMatches) {
      const productOid = toObjectId(mp.catalogProductId);
      if (!productOid) continue;
      const catalogMedias = await Media.find({
        source: 'catalog-product',
        'metadata.catalogProductId': productOid
      }).select('_id fileType adSuitability classification metadata.imageRole').lean();
      const ranked = rankCatalogMediasForHero(catalogMedias);
      for (const cm of ranked) {
        seeds.push({
          productId:        String(mp.catalogProductId),
          mediaId:          String(cm._id),
          matchTier:        'product_match',
          variantKind:      'product_image',
          fileType:         cm.fileType,
          suitabilityScore: cm.adSuitability?.score ?? null
        });
      }
    }

    return seeds;
  }

  // Case 2 — only product_category matches. Expand to top-K products
  // in the matched categories (Media.matchedCategories carries the
  // categoryId), ranked by popularity.
  const categoryIds = Array.from(new Set(
    (media.matchedCategories || []).map(mc => mc.categoryId).filter(Boolean).map(String)
  ));
  if (categoryIds.length) {
    const products = await loadTopProductsByPopularity({
      brandId,
      categoryIds,
      limit: EXPANSION_PRODUCTS_PER_POST
    });
    if (products.length) {
      return products.map(p => ({
        ...baseSeed,
        productId: String(p._id),
        matchTier: 'product_category'
      }));
    }
  }

  // Case 3 — brand_match (or no product signal). Expand to top-K
  // products in the brand's catalog, ranked by popularity.
  const products = await loadTopProductsByPopularity({
    brandId,
    categoryIds: null,
    limit: EXPANSION_PRODUCTS_PER_POST
  });
  return products.map(p => ({
    ...baseSeed,
    productId: String(p._id),
    matchTier: 'brand_match'
  }));
}

// Load CatalogProducts ranked by productPopularityScore, capped at
// `limit`. When categoryIds is set, filter to products whose
// categoryRef matches any (leaf-equality — broader subtree expansion
// is a follow-up). Always excludes drafts and non-primary variants.
async function loadTopProductsByPopularity({ brandId, categoryIds, limit }) {
  const filter = {
    brandId,
    draft:            { $ne: true },
    isPrimaryVariant: { $ne: false }
  };
  if (categoryIds && categoryIds.length) {
    filter.categoryRef = { $in: categoryIds.map(id => new mongoose.Types.ObjectId(id)) };
  }
  const products = await CatalogProduct.find(filter)
    .select('_id matchedMedia rating reviews categoryRef')
    .lean();
  if (!products.length) return [];
  const scored = products.map(p => ({ p, score: productPopularityScore(p) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.p);
}

// Product-driven (catalog entry / wizard Step 2). Operator picked a
// productId. Pulls matched media from CatalogProduct.matchedMedia[]
// (the denormalized mirror written by detect), optionally unions in
// brand_match media for the brand, and emits product_image seeds for
// EVERY catalog media (hero + alts), ranked.
//
// Tier inclusion is opt-in for non-product_match tiers. The wizard's
// Step 2 product-kind view exposes "Include category-matched" and
// "Include brand-matched" expand buttons; the campaign-generate
// endpoint forwards the toggles into opts here. Defaults are TRUE
// for backwards-compat with callers that don't pass the flags.
async function seedsFromProduct(brandId, productId, opts = {}) {
  const includeCategoryMatched = opts.includeCategoryMatched !== false;
  const includeBrandMatched    = opts.includeBrandMatched    !== false;

  const seeds = [];

  const product = await CatalogProduct.findById(productId)
    .select('matchedMedia')
    .lean();

  // Tiers 1 + 2 — product_match (always) + product_category (opt-in)
  // from the denormalized mirror. Bulk-load the referenced Media docs
  // so we can score by adSuitability + grab fileType. Content-nature
  // filter excludes promotional / announcement UGC (sale-of-the-week,
  // "coming soon" teasers) — they read as stale ad inserts once the
  // offer/date passes.
  if (product?.matchedMedia?.length) {
    const mediaIds = Array.from(new Set(product.matchedMedia.map(mm => String(mm.mediaId))));
    const medias = await loadMediasForScoring(mediaIds);
    const mediaById = new Map(medias.map(m => [String(m._id), m]));
    for (const mm of product.matchedMedia) {
      if (mm.matchTier === 'product_category' && !includeCategoryMatched) continue;
      const media = mediaById.get(String(mm.mediaId));
      if (!media) continue;
      if (!isMediaEligibleByContentNature(media)) continue;
      // Tier 2 gate — if this post arrived via product_category (the
      // post matched the class, not the SKU) but ALSO has a concrete
      // product_match to some OTHER specific SKU, the post would
      // visually contradict the seed. Skip. Tier 1 (product_match)
      // posts are unaffected — they wouldn't appear under a different
      // product's matchedMedia at that tier.
      if (mm.matchTier === 'product_category' && hasIdentifiedSpecificProduct(media)) continue;
      seeds.push({
        productId:        String(productId),
        mediaId:          String(mm.mediaId),
        matchTier:        mm.matchTier,
        variantKind:      'ugc',
        fileType:         media.fileType,
        suitabilityScore: media.adSuitability?.score ?? null,
        platformStats:    media.platformStats || null
      });
    }
  }

  // Tier 3 — brand_match fallback (opt-in). Tags the productId onto
  // brand media so the ad is still attributed for CTA/tracking. Not
  // denormalized on CatalogProduct (would require writing every
  // brand_match media to every product in the brand), so this stays
  // a PMA query.
  if (includeBrandMatched) {
    const brandMatches = await ProductMatchArtifact.find({
      brandId,
      outcome: 'brand_match'
    }).select('mediaId').lean();
    const brandMatchMediaIds = Array.from(new Set(brandMatches.map(m => String(m.mediaId))));
    if (brandMatchMediaIds.length) {
      const medias = await loadMediasForScoring(brandMatchMediaIds);
      for (const m of medias) {
        if (!isMediaEligibleByContentNature(m)) continue;
        // Tier 3 gate — brand_match pairs an unmatched-by-product post
        // with a seed SKU. If the post visibly contains ANY product
        // (identified to another SKU, or unidentified but YOLO-visible),
        // the pairing risks showing the wrong jar/label next to the
        // seed's name. Exclude both cases.
        if (hasIdentifiedSpecificProduct(m) || hasVisibleUnmatchedProduct(m)) continue;
        seeds.push({
          productId:        String(productId),
          mediaId:          String(m._id),
          matchTier:        'brand_match',
          variantKind:      'ugc',
          fileType:         m.fileType,
          suitabilityScore: m.adSuitability?.score ?? null,
          platformStats:    m.platformStats || null
        });
      }
    }
  }

  // Tier 0 — product_image: emit ONE seed per catalog Media (hero +
  // alts), ranked so the best hero candidate becomes the first /
  // highest-priority seed. Previously this only emitted the single
  // top-ranked Media; alts had artifacts but never made it into the
  // cartesian. With the alt expansion, a product with 4 alts produces
  // 5 product_image seeds (one per catalog media), each its own
  // visual-hero variant. MAX_ADS_PER_GENERATION_RUN still clips the
  // total run; smarter per-seed prioritization is a follow-up.
  const productOid = toObjectId(productId);
  const catalogMedias = productOid ? await Media.find({
    source: 'catalog-product',
    'metadata.catalogProductId': productOid
  }).select('_id fileType adSuitability classification metadata.imageRole').lean() : [];
  const rankedCatalogMedias = rankCatalogMediasForHero(catalogMedias);
  for (const m of rankedCatalogMedias) {
    seeds.push({
      productId:        String(productId),
      mediaId:          String(m._id),
      matchTier:        'product_match',     // the product IS the SKU here
      variantKind:      'product_image',
      fileType:         m.fileType,
      suitabilityScore: m.adSuitability?.score ?? null
    });
  }

  return seeds;
}

// Rank catalog Media for use as a product_image ad's visual hero.
// Preference order:
//   1. lifestyle      product in real-world context (story-friendly)
//   2. on_model       human element draws engagement
//   3. flat_lay       contextual but flatter than lifestyle
//   4. unknown / no classification — assume hero candidate
//   5. product_only   clean studio shot — works but reads as catalog
//   6. detail         close-up / partial product
//   7. packaging      worst for hero
// Within a rank, prefer imageRole='hero' (the merchant's primary
// listing). Returns a sorted array (best first); empty when input is.
function rankCatalogMediasForHero(medias) {
  if (!Array.isArray(medias) || !medias.length) return [];
  const RANK = {
    lifestyle:    1,
    on_model:     2,
    flat_lay:     3,
    unknown:      4,
    product_only: 5,
    detail:       6,
    packaging:    7
  };
  return medias.slice().sort((a, b) => {
    const ra = RANK[a.classification?.shotType] ?? RANK.unknown;
    const rb = RANK[b.classification?.shotType] ?? RANK.unknown;
    if (ra !== rb) return ra - rb;
    // Tiebreak: merchant's primary listing wins
    const ahero = (a.metadata?.imageRole === 'hero') ? 0 : 1;
    const bhero = (b.metadata?.imageRole === 'hero') ? 0 : 1;
    return ahero - bhero;
  });
}

// Back-compat shim — older callers (if any survive) still call
// pickProductImageHero expecting a single Media. New flow ranks the
// whole set; this returns the top of the rank.
function pickProductImageHero(medias) {
  const ranked = rankCatalogMediasForHero(medias);
  return ranked[0] || null;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function loadMediasForScoring(mediaIds) {
  if (!mediaIds.length) return [];
  return Media.find({ _id: { $in: mediaIds } })
    .select('_id adSuitability fileType classification platformStats matchedProducts refinedProducts')
    .lean();
}

// CPG cross-product mismatch guards. A post that visibly shows a
// specific identified SKU should NOT be paired with a different seed
// product just because both fall in the same category (Tier 2) or
// because the brand matches (Tier 3 / brand_only). The catalog match
// would override the visible jar/label in the photo, reading as a bait-
// and-switch. Apparel tolerates this (a "tee" reads as a tee regardless
// of which exact SKU is on the model); CPG doesn't.
//
//   hasIdentifiedSpecificProduct — Phase 1.6 + 2d landed a concrete
//     catalog FK on this media via product_match. The visible product
//     is known to be SKU X; never pair with seed SKU Y.
//   hasVisibleUnmatchedProduct  — YOLO detected products on this media
//     but identification didn't land a catalog FK. The jar is visible
//     but the label/caption signal wasn't strong enough to claim a SKU.
//     Still risky for brand-context pairings — the visible product might
//     contradict the seed in the caption/text overlay.
function hasIdentifiedSpecificProduct(media) {
  return Array.isArray(media?.matchedProducts) && media.matchedProducts.some(
    mp => mp && mp.outcome === 'product_match' && mp.catalogProductId
  );
}
function hasVisibleUnmatchedProduct(media) {
  if (!Array.isArray(media?.refinedProducts) || media.refinedProducts.length === 0) return false;
  return !hasIdentifiedSpecificProduct(media);
}

// Time-bound posts (sale-of-the-week, "coming soon" teasers, holiday
// promos) make terrible evergreen ad inserts — they reference dates
// or offers that have passed by the time the ad runs. subjectTextService
// classifies each Media into evergreen / promotional / announcement /
// unknown; this gate excludes promotional + announcement when the
// classifier is confident enough. unknown + low-confidence calls fall
// through to inclusion so a flaky classifier doesn't starve the queue.
const CONTENT_NATURE_BLOCK_THRESHOLD = 0.7;
function isMediaEligibleByContentNature(media) {
  const nature = media?.classification?.contentNature;
  if (!nature || nature === 'evergreen' || nature === 'unknown') return true;
  const conf = media?.classification?.contentNatureConfidence;
  if (typeof conf === 'number' && conf >= CONTENT_NATURE_BLOCK_THRESHOLD) {
    return false;
  }
  return true;
}

function dedupeSeeds(seeds) {
  const seen = new Set();
  const out = [];
  for (const s of seeds) {
    const key = `${s.productId || 'NULL'}|${s.mediaId}|${s.variantKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

module.exports = {
  expandWizardJob,
  selectAdsForRun,
  computeIdentityDigest,
  SUPPORTED_TEMPLATES,
  // Exposed so picker endpoints can apply the same content-nature
  // gate the seed expansion uses — otherwise the picker shows posts
  // that would be silently dropped at expansion time.
  isMediaEligibleByContentNature
};
