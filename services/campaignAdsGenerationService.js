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
const registry                       = require('./templateRegistry');
const { aspectRatioForPlatformFormat } = require('./veoPromptBuilder');
const { rankByShotType }              = require('./shotTypeRank');

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
  // AI templates — each maps 1:1 to a creativeStyle in aiCanvasSpecService.
  // Operator enables one or more; cartesian fans across them so a 3-style
  // pick on 4 media = 12 ads in 3 directions instead of one safe default.
  'ai_brand_led',
  'ai_ugc_led',
  'ai_social_proof_led',
  'ai_editorial',
  'ai_promotional'
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
  ai_brand_led:          new Set(['ugc', 'product_image']),
  // ugc_led is by definition UGC-source only — the creator photo IS the ad.
  ai_ugc_led:            new Set(['ugc']),
  // social_proof leans on real comments/stats; both sources OK but UGC has more signal.
  ai_social_proof_led:   new Set(['ugc', 'product_image']),
  ai_editorial:          new Set(['ugc', 'product_image']),
  ai_promotional:        new Set(['ugc', 'product_image'])
};

// Aspect ratios we ship ad output for — derived from the platformFormats
// table so this stays aligned with product ads (concept-driven path
// sets aspectRatio directly from platformFormat, no gate). Brand ads
// route through the legacy cartesian and hit this filter; keeping it
// dynamic means any new platformFormat addition auto-unlocks the same
// aspect for brand campaigns.
const { PLATFORM_FORMATS } = require('./platformFormats');
const SHIPPING_RATIOS = new Set(
  Object.values(PLATFORM_FORMATS).map(f => f.aspectRatio).filter(Boolean)
);

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

// Per-product hard cap — independent of the global run cap. Keeps a
// 1-product wizard run tight (3 ads) while a 10-product brand campaign
// still produces 30 ads. Top picks by readinessScore within each
// productId group; brand-only seeds (productId=null) form one group.
const ADS_PER_PRODUCT_CAP     = Math.max(1, parseInt(process.env.ADS_PER_PRODUCT_CAP,     10) || 3);
const VEO_ADS_PER_PRODUCT_CAP = Math.max(1, parseInt(process.env.VEO_ADS_PER_PRODUCT_CAP, 10) || 1);

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
function computeIdentityDigest({ campaignId, productId, mediaId, template, aspectRatio, variantKind, paletteSource, ctaText, ctaUrl, ctaUrlParams, rafflePrizeMediaId, kind }) {
  const payload = JSON.stringify({
    campaignId:    String(campaignId),
    productId:     productId ? String(productId) : null,
    mediaId:       String(mediaId),
    template,
    aspectRatio,
    variantKind,
    paletteSource: paletteSource || 'media',
    // kind separates image+video variants of the same (seed × template ×
    // ratio) so they don't collide on the (campaignId, identityDigest)
    // unique index. Absent kind serializes as 'image' — matches legacy
    // behavior for older payloads that didn't set the field.
    kind:          String(kind || 'image'),
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
  // Phase 2 wizard platform-format override. null/undefined → use
  // campaign.platformFormat (defaults to meta_feed_1_1). Operator-
  // supplied value (from the wizard Step 1 picker) wins so a campaign
  // tagged for Feed can still run a one-off Reels batch without
  // mutating Campaign.platformFormat.
  platformFormat = null,
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
  includeBrandMatched    = false,
  // Operator's per-run ad-kind preference. 'both' = generate both image
  // (HTML Gen) and video (Veo) for the selected format, 'image' or
  // 'video' restricts to a single pipeline. Constrained by the format's
  // declared kinds (services/platformFormats.js) — picking 'image' on
  // Reels falls back to 'video'. null defers to campaign.adKinds.
  kinds = null,
  // Wizard format-selection stage: requested video length in seconds
  // (integer 1–15). null = standard 8s. Stamped on video Ad payloads
  // only; not part of identityDigest.
  videoDurationSec = null,
  // Phase 3 — deterministic video + optional director variants.
  // directorVariants: when true, ALSO queue concept-driven video variants
  // (in addition to the deterministic per-product ad). Default OFF.
  directorVariants = false,
  // Catalog-product Media ids in operator pick ORDER (position 0 =
  // primary seed). Grouped by metadata.catalogProductId inside
  // expandDeterministicVideo; order is preserved end-to-end.
  seedMediaIds = [],
  seedPicks = null,
  // Run-level video prompt overrides (stamped on every video Ad).
  // Guidance merges via resolvePromptGuidance → operatorPrompt prepend;
  // raw fully replaces the canonical prompt at render time.
  videoPromptGuidance = null,
  videoPromptRaw = null,
  // Dry-run mode — runs the entire seed assembly + cartesian + caps
  // but skips the Ad.insertMany. Returns the would-be payload counts
  // grouped by productId so the wizard can show "this will produce N
  // ads" before the operator hits Generate. Use sparingly — still
  // costs LLM-free DB reads (matchedMedia, ProductMatchArtifact, etc.).
  dryRun = false
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
  // Platform-format-aware ad generation. Phase 1 plumbed Campaign.
  // platformFormat through. Phase 2 (wizard picker) overrides per-run
  // via the platformFormat function parameter — operator selects on
  // Step 1 of the wizard. Wizard override wins; campaign field is the
  // fallback for sources that don't pass it (e.g. legacy callers).
  const ALLOWED_PLATFORM_FORMATS = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16', 'meta_stories_9_16', 'pmax_16_9'];
  const wizardFormat = platformFormat && ALLOWED_PLATFORM_FORMATS.includes(platformFormat)
    ? platformFormat
    : null;
  const effectivePlatformFormat = wizardFormat
    || campaign.platformFormat
    || 'meta_feed_1_1';
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

  // ── On-demand catalog detect (detect is deferred at sync time) ────
  // Ensure the products this run will actually use have their catalog-
  // product Media (so product_image seeds emit) + overlay-zone artifacts
  // (so placement / ad-readiness work). Covers explicit product picks +
  // the products matched to the selected media. Bounded wait; on timeout
  // we proceed and the render path degrades gracefully. Skipped in dryRun.
  if (!dryRun) {
    try {
      const { ensureDetectForProducts } = require('./catalogProductDetectService');
      const ensureIds = new Set(productIds.map(String));
      if (mediaIds.length) {
        const pickedMedia = await Media.find({ _id: { $in: mediaIds.map(toObjectId).filter(Boolean) } })
          .select('matchedProducts').lean();
        for (const m of pickedMedia) {
          for (const mp of (m.matchedProducts || [])) {
            if (mp.catalogProductId && mp.outcome === 'product_match') ensureIds.add(String(mp.catalogProductId));
          }
        }
      }
      if (ensureIds.size) {
        await ensureDetectForProducts([...ensureIds], {
          advertiserId: campaign.advertiserId,
          brandId
        });
      }
    } catch (err) {
      console.warn(`   ⚠️  on-demand detect prep failed (continuing): ${err.message}`);
    }
  }

  // ── Phase A5a — concept-driven V2 branch (AI_CONCEPT_DRIVEN flag) ─
  // When the flag is on AND format=Feed AND the operator picked at
  // least one product, take the V2 branch: per-product, build a seeded
  // universe → Director round (3 concepts) → Judge → insert 3 Ad rows.
  // Skip the legacy cartesian (seeds × templates × ratios) entirely.
  //
  // Flag off OR any precondition unmet → fall through to legacy path
  // below; V2 code is dead.
  //
  // Brand-only runs (productIds.length === 0) stay legacy — the
  // concept-driven path is product-scoped.
  // Resolve operator-requested kinds against the format's allowed kinds.
  // Wizard input (kinds param) wins over campaign.adKinds; falls back to
  // 'both' so legacy callers get the previous behavior.
  const requestedKinds = kinds || campaign.adKinds || 'both';
  const { resolveKinds } = require('./platformFormats');
  let resolvedKinds = resolveKinds(effectivePlatformFormat, requestedKinds);

  // Drop 'video' if Veo isn't enabled for this format. AI_VEO_REELS gates
  // Reels (9:16); AI_VEO_FEED gates everything else. If the operator asked
  // for video-only on a format with Veo disabled, this leaves resolvedKinds
  // empty and the early-return below short-circuits with zero queued.
  const veoFlag = effectivePlatformFormat === 'meta_reels_9_16'
    ? process.env.AI_VEO_REELS
    : process.env.AI_VEO_FEED;
  const veoEnabled = String(veoFlag || '').toLowerCase() === 'true';
  if (!veoEnabled && resolvedKinds.includes('video')) {
    resolvedKinds = resolvedKinds.filter(k => k !== 'video');
  }

  // Phase 3 routing — deterministic video by default; director opt-in.
  //   conceptImage       — image via Director when AI_CONCEPT_DRIVEN is on
  //   deterministicVideo — one video ad/product (hero or ordered picks)
  //   conceptVideo       — director video variants: brand campaigns always,
  //                        product campaigns only when directorVariants=true
  // Legacy cartesian is reachable ONLY for wantsImage && !AI_CONCEPT_DRIVEN,
  // with 'video' stripped so video never double-queues.
  const wantsVideo = resolvedKinds.includes('video');
  const wantsImage = resolvedKinds.includes('image');
  // Image → Director when AI_CONCEPT_DRIVEN is on OR the run also produces
  // video. The `|| wantsVideo` preserves pre-Phase-3 behavior: the 1:1-only
  // legacy cartesian was always bypassed once a video was in the run, so a
  // mixed image+video run with the flag OFF must still route image through
  // the Director rather than silently dropping it.
  const aiConceptDriven    = String(process.env.AI_CONCEPT_DRIVEN || '').toLowerCase() === 'true';
  const conceptImage       = wantsImage && (aiConceptDriven || wantsVideo);
  const deterministicVideo = wantsVideo && productIds.length > 0;
  const conceptVideo       = wantsVideo && (productIds.length === 0 || directorVariants === true);

  if (!dryRun && (deterministicVideo || conceptImage || conceptVideo)) {
    let detResult = null;
    let conceptResult = null;

    if (deterministicVideo) {
      detResult = await expandDeterministicVideo({
        campaignId, brandId, campaignKind, productIds,
        seedMediaIds,
        seedPicks,
        ctaText, ctaUrl, ctaUrlParams,
        platformFormat: effectivePlatformFormat,
        videoDurationSec,
        videoPromptGuidance, videoPromptRaw,
        excludePairings
      });
    }

    const conceptKinds = [
      ...(conceptImage ? ['image'] : []),
      ...(conceptVideo ? ['video'] : [])
    ];
    if (conceptKinds.length) {
      conceptResult = await runConceptDrivenExpansion({
        campaignId, brandId, campaignKind, productIds,
        mediaIds,   // operator-picked UGC seeds — restricts the Director's universe when non-empty
        ctaText, ctaUrl, ctaUrlParams,
        platformFormat: effectivePlatformFormat,
        kinds: conceptKinds,
        includeCategoryMatched, includeBrandMatched,
        excludePairings, creativeIntent: null,
        videoDurationSec,
        videoPromptGuidance, videoPromptRaw
      });
    }

    if (detResult || conceptResult) {
      return mergeExpansionResults(detResult, conceptResult);
    }
    // Both returned null/empty — fall through to legacy image path.
  }

  // Dry-run estimate for deterministic + concept paths (no Director LLM).
  // Deterministic: exactly 1 video ad per product (ordered picks compose
  // one ad, not one-per-pick). Director: VEO_ADS_PER_PRODUCT_CAP when on.
  // Image: conceptImage → min(3, ADS_PER_PRODUCT_CAP); else fall through
  // to legacy cartesian below.
  if (dryRun && (deterministicVideo || conceptImage || conceptVideo)) {
    // Group seedMediaIds by product for labeling (cheap; Media load once).
    // Estimate itself is always 1 det ad/product regardless of pick count.
    const estimateProducts = productIds.length > 0 ? productIds : [null];
    const byProduct = {};
    let detTotal = 0;
    let dirTotal = 0;
    let imgTotal = 0;

    for (const pid of estimateProducts) {
      const key = pid ? String(pid) : 'NULL';
      let n = 0;
      if (deterministicVideo && pid) {
        n += 1; // one ordered-stack (or hero) ad per product
        detTotal += 1;
      }
      if (conceptVideo) {
        n += VEO_ADS_PER_PRODUCT_CAP;
        dirTotal += VEO_ADS_PER_PRODUCT_CAP;
      }
      if (conceptImage) {
        const imgN = Math.min(3, ADS_PER_PRODUCT_CAP);
        n += imgN;
        imgTotal += imgN;
      }
      byProduct[key] = n;
    }

    // Brand-only (no productIds): no deterministic; conceptVideo covers video.
    if (!productIds.length && conceptVideo) {
      // estimateProducts is [null] — already counted above
    }

    const total = detTotal + dirTotal + imgTotal;
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      dryRun: true,
      total,
      byProduct,
      byMode: { deterministic: detTotal, director: dirTotal },
      byVariantKind: { ugc: 0, product_image: 0 },
      seedCount:    0,
      productCount: estimateProducts.length
    };
  }

  // Legacy cartesian path — image only. Strip 'video' so video can never
  // double-queue via this path (guard even though today video always
  // took the concept/deterministic branch above).
  resolvedKinds = resolvedKinds.filter(k => k !== 'video');
  if (!resolvedKinds.length) {
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      queuedCount: dryRun ? 0 : await Ad.countDocuments({ campaignId, status: 'queued' }),
      newlyQueued: 0, alreadyQueued: 0, newAdIds: [], total: 0, byProduct: {},
      byVariantKind: { ugc: 0, product_image: 0 },
      byMode: { deterministic: 0, director: 0 }
    };
  }

  // ── 1. Build seeds — flat list of {productId, mediaId, matchTier, variantKind, suitabilityScore, fileType} ──
  const useBrandOnly = productIds.length === 0 && mediaIds.length === 0;
  let seeds = [];

  if (useBrandOnly) {
    seeds = await seedFromBrandOnly(brandId, BRAND_ONLY_MEDIA_LIMIT);
  } else {
    for (const mediaId of mediaIds) {
      const mediaSeeds = await seedsFromMedia(brandId, mediaId, { campaignKind });
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

  // Platform-format-aware seed filter for Reels. When AI_VEO_REELS is on,
  // Veo handles both tracks — video seeds (Track 1, video-to-video) and
  // image seeds (Track 2, image-to-video) — so all fileTypes are valid.
  // Without AI_VEO_REELS, image-only seeds produce a still-on-video which
  // looks bad on a motion-expected surface, so we drop them.
  if (effectivePlatformFormat === 'meta_reels_9_16' && !veoEnabled) {
    const before = seeds.length;
    seeds = seeds.filter(s => s.fileType === 'video' && s.variantKind !== 'product_image');
    const dropped = before - seeds.length;
    if (dropped > 0) {
      console.log(`📦 expandWizardJob: Reels image-only filter dropped ${dropped} seed(s) (${seeds.length} video seed(s) remain)`);
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

  // ── 2. Cartesian: seeds × allowedTemplates × (template ratios ∩ SHIPPING_RATIOS ∩ platformFormat aspect) ──
  //
  // Grid ratios are filtered to the campaign's platformFormat aspect
  // when one is set. Without this filter a Reels (9:16) brand campaign
  // would queue 1:1 payloads whenever the template supported 1:1 —
  // aspectRatio and platformFormat drift apart and the Grok-skip path
  // downstream builds a 1:1 Cloudinary segment for a Reels ad. Concept-
  // driven expansion already sets aspectRatio directly from
  // platformFormat (line 1427); this brings the legacy cartesian into
  // parity for brand campaigns (which have no productIds and never
  // reach the concept-driven path).
  const platformAspect = aspectRatioForPlatformFormat(effectivePlatformFormat) || null;
  const grid = [];
  for (const templateId of allowedTemplates) {
    const tpl = registry.getNormalized(templateId);
    if (!tpl) continue;
    let ratios = (tpl.aspect_ratios?.supported || [])
      .filter(r => SHIPPING_RATIOS.has(r));
    if (platformAspect) ratios = ratios.filter(r => r === platformAspect);
    for (const aspectRatio of ratios) {
      grid.push({ templateId, aspectRatio });
    }
  }

  // paletteSource doubling removed — that was the legacy CSS-render
  // path where style_bindings interpolated different hex values per
  // (media|brand) source. The HTML Layout Generator now picks its own
  // palette per the prompt's PALETTE DERIVATION section, so the
  // second colorway just duplicated identical ads. Field stays in the
  // cache key for backward compat; we just emit a single value.
  const PALETTE_SOURCES = ['media'];

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

  const { renderRouteForKind } = require('./platformFormats');
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
          // One payload per requested kind (image / video / both). Mirrors
          // the concept-driven expansion at line 1409 so brand campaigns
          // — which route through this legacy cartesian since they have
          // no productIds — actually produce video variants when the
          // operator asks for them. Image + video variants of the same
          // (seed × template × ratio) get distinct identityDigests via
          // the kind field in the hash.
          for (const kind of resolvedKinds) {
            const identityDigest = computeIdentityDigest({
              campaignId,
              productId:     seed.productId,
              mediaId:       seed.mediaId,
              template:      cell.templateId,
              aspectRatio:   cell.aspectRatio,
              variantKind:   seed.variantKind,
              paletteSource,
              kind,
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
              platformFormat: effectivePlatformFormat,
              videoDurationSec: kind === 'video' ? (videoDurationSec || null) : null,
              matchTier:      seed.matchTier,
              variantKind:    seed.variantKind,
              paletteSource,
              rafflePrizeMediaId,
              readinessScore,
              status:         'queued',
              identityDigest,
              kind,
              renderRoute:    renderRouteForKind(kind),
              ctaText, ctaUrl, ctaUrlParams,
              queuedAt:       new Date(),
              generatedAt:    new Date()
            });
          }
        }
      }
    }
  }

  // Per-(product, kind) cap. Video is the expensive kind (≈$1.00 per
  // 8s/720p render on the Gemini Omni default, ≈$4.00 on the Grok
  // override — see atlasVideoService.estimateRenderCostUsd — or ~$0
  // for the video-seed Cloudinary segment path) so it caps at
  // VEO_ADS_PER_PRODUCT_CAP (1); image uses ADS_PER_PRODUCT_CAP (3).
  // Brand-only seeds (productId null) form one product group per kind
  // — so brand + meta feed + both nets 3 image + 1 video rather than
  // 3 image + 0 video (the pre-kind-multiplier bug). Applied BEFORE
  // the global MAX_ADS cap so N-product wizards don't have one
  // popular product hog the budget while others render zero ads.
  if (payloads.length) {
    const groupKey = (p) => `${p.productId ? String(p.productId) : 'NULL'}|${p.kind || 'image'}`;
    const byGroup = new Map();
    for (const p of payloads) {
      const k = groupKey(p);
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(p);
    }
    const capForKind = (kind) => kind === 'video' ? VEO_ADS_PER_PRODUCT_CAP : ADS_PER_PRODUCT_CAP;
    const trimmed = [];
    let perGroupDropped = 0;
    for (const [key, group] of byGroup.entries()) {
      const kind = key.split('|')[1] || 'image';
      const cap  = capForKind(kind);
      group.sort((a, b) => (b.readinessScore ?? -1) - (a.readinessScore ?? -1));
      if (group.length > cap) perGroupDropped += group.length - cap;
      trimmed.push(...group.slice(0, cap));
    }
    if (perGroupDropped > 0) {
      console.log(`📦 expandWizardJob: per-(product,kind) trim dropped ${perGroupDropped} payload(s) (image cap=${ADS_PER_PRODUCT_CAP}, video cap=${VEO_ADS_PER_PRODUCT_CAP}, across ${byGroup.size} group(s))`);
    }
    payloads = trimmed;
  }

  // Global cap — last-resort backstop. With ADS_PER_PRODUCT_CAP=3 and
  // typical product counts, this almost never fires. Kept so a brand
  // campaign with 100+ products doesn't accidentally queue 300 ads.
  if (payloads.length > MAX_ADS_PER_GENERATION_RUN) {
    payloads.sort((a, b) => (b.readinessScore ?? -1) - (a.readinessScore ?? -1));
    const before = payloads.length;
    payloads = payloads.slice(0, MAX_ADS_PER_GENERATION_RUN);
    console.log(`📦 expandWizardJob: global cap trim ${before} → ${payloads.length} (cap=${MAX_ADS_PER_GENERATION_RUN})`);
  }

  if (!payloads.length) {
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      queuedCount: dryRun ? 0 : await Ad.countDocuments({ campaignId, status: 'queued' }),
      newlyQueued: 0, alreadyQueued: 0, newAdIds: [], total: 0, byProduct: {},
      byVariantKind: { ugc: 0, product_image: 0 }
    };
  }

  // Dry-run — skip DB writes, summarize counts so the wizard can
  // show the operator the expansion math before commit.
  if (dryRun) {
    const byProduct = {};
    const byVariantKind = { ugc: 0, product_image: 0 };
    for (const p of payloads) {
      const k = p.productId ? String(p.productId) : 'NULL';
      byProduct[k] = (byProduct[k] || 0) + 1;
      if (p.variantKind in byVariantKind) byVariantKind[p.variantKind]++;
    }
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      dryRun: true,
      total:        payloads.length,
      byProduct,
      byVariantKind,
      seedCount:    seeds.length,
      productCount: Object.keys(byProduct).length
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

  // Upstream LLM dependencies — Director concepts + Copy candidates are
  // now part of the Generator's contract (V2 path requires a Director
  // concept; HTML Generator can't materialize without one). Awaiting
  // both before returning means the worker can NEVER pick an Ad whose
  // upstream artifacts haven't landed yet — closes the race that used
  // to silently degrade V2 → V1 when the fire-and-forget calls hadn't
  // finished.
  //
  // Parallelized via Promise.allSettled so:
  //   - Director and Copy run concurrently (typical batch 10-15s)
  //   - A failure in one doesn't block the other
  //   - A failure in EITHER doesn't block the campaign from queueing
  //     (downstream Ads can still fall back to V1 — degraded but
  //     non-empty output)
  const upstreamT0 = Date.now();
  const uniqueProductIds = Array.from(new Set(payloads.map(p => p.productId).filter(Boolean)));
  const [directorRes, copyRes] = await Promise.allSettled([
    runCreativeDirectorShadow({
      brandId,
      productIds:     uniqueProductIds,
      campaignKind,
      creativeIntent: null,  // Phase 9 UX adds an operator hint here
      platformFormat: effectivePlatformFormat
    }),
    runCopyDerivationEager({
      brandId,
      productStylePairs: derivePayloadProductStylePairs(payloads)
    })
  ]);
  if (directorRes.status === 'rejected') {
    console.warn(`   ⚠️  creative-director eager failed (campaign continues with V1 fallback): ${directorRes.reason?.message || directorRes.reason}`);
  }
  if (copyRes.status === 'rejected') {
    console.warn(`   ⚠️  copy-derivation eager failed (campaign continues with single-string fallback): ${copyRes.reason?.message || copyRes.reason}`);
  }
  console.log(`⏳ upstream LLM deps ready in ${Date.now() - upstreamT0}ms (${uniqueProductIds.length} products)`);

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
async function selectAdsForRun({ campaignId, limit, productIds = null }) {
  // productIds (optional) SCOPES the selection to those products.
  //
  // Without it this selects on { campaignId, status:'queued' } alone, and tier
  // 0 sorts queuedAt ASCENDING — so pressing Generate for one product renders
  // the OLDEST queued ads on the campaign, which routinely belong to a
  // DIFFERENT product from an earlier session. One product yields ~1-5 ads, so
  // a 20-slot run fills the remaining ~15 from that backlog and the operator
  // watches an unrelated product render as "1 of 20".
  //
  // Scoping by product rather than by the ids expandWizardJob just inserted is
  // deliberate: the unique index on (campaignId, identityDigest) means a repeat
  // Generate for the same product inserts NOTHING (newAdIds comes back empty)
  // while that product's ads sit in 'queued' from the earlier press. Selecting
  // on productId picks up both the new rows and those.
  const asked = Array.isArray(productIds) ? productIds.filter(v => v != null && v !== '') : [];
  const scoped = asked.map(toObjectId).filter(Boolean);
  // FAIL CLOSED. An empty/absent list means "no scoping" (brand-only ads carry
  // productId:null and must still be selectable). But a NON-EMPTY list whose
  // ids are all malformed means the caller asked to scope and we could not —
  // widening to the whole campaign there would re-create the exact bug this
  // parameter exists to fix, silently and while spending money.
  const productScope = scoped.length
    ? { productId: { $in: scoped } }
    : (asked.length ? { _id: { $in: [] } } : {});
  if (asked.length && !scoped.length) {
    console.warn(`⚠️  selectAdsForRun: ${asked.length} productId(s) supplied but none were valid ObjectIds — selecting nothing rather than the whole campaign`);
  }

  // Tier 0 — DETERMINISTIC baseline video ads (Phase 3) drain FIRST so the
  // guaranteed per-product standard video always renders before optional
  // director variants / concept images can fill the run cap. Discriminator:
  // no concept (conceptId null) + unjudged (judgeRank null) + video route.
  // Concept video carries a conceptId; the legacy image cartesian is
  // renderRoute 'html_gen' — so this set is exactly the deterministic videos
  // (plus any pre-Phase-3 legacy veo ads, which rendering first is harmless).
  const det = await Ad.find({
    campaignId, status: 'queued',
    conceptId: null, judgeRank: null, renderRoute: 'veo',
    ...productScope
  })
    .sort({ queuedAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();
  const detIds = det.map(r => String(r._id));
  if (detIds.length >= limit) return detIds;

  // Phase A5b — concept-driven Ads (judgeRank != null) drain NEXT by
  // judgeRank ASC (1 = best). Legacy Ads (judgeRank null) fill any
  // remaining slots by readinessScore. Separate queries because MongoDB
  // sorts nulls before non-nulls in ASC order.
  const afterDet = limit - detIds.length;
  const v2 = await Ad.find({ campaignId, status: 'queued', judgeRank: { $ne: null }, ...productScope })
    .sort({ judgeRank: 1, queuedAt: 1 })
    .limit(afterDet)
    .select('_id')
    .lean();
  const v2Ids = v2.map(r => String(r._id));
  if (detIds.length + v2Ids.length >= limit) return [...detIds, ...v2Ids];

  // Legacy tier — judgeRank null, EXCLUDING the deterministic ads already
  // taken in tier 0 (they share judgeRank null), by readinessScore.
  const remaining = limit - detIds.length - v2Ids.length;
  const detOids = det.map(r => r._id);
  const v1 = await Ad.find({
    campaignId, status: 'queued', judgeRank: null,
    _id: { $nin: detOids },
    ...productScope
  })
    .sort({ readinessScore: -1, queuedAt: 1 })
    .limit(remaining)
    .select('_id')
    .lean();
  return [...detIds, ...v2Ids, ...v1.map(r => String(r._id))];
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
async function seedsFromMedia(brandId, mediaId, opts = {}) {
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

  // Brand-campaign short-circuit. For campaignKind='brand' the
  // operator picked the media because they want THAT visual to be
  // the ad — not a fanout pairing that visual with every plausible
  // product. Emit exactly one seed:
  //   - if the media has a top product_match → attach that productId
  //   - otherwise → productId:null, matchTier:'brand_only' (the
  //     brand-only path that brand-led copy uses already)
  if (opts.campaignKind === 'brand') {
    const productMatches = (media.matchedProducts || []).filter(mp => mp.catalogProductId);
    const top = productMatches.find(mp => mp.outcome === 'product_match')
              || productMatches.find(mp => mp.outcome === 'product_category')
              || null;
    if (top) {
      return [{
        ...baseSeed,
        productId: String(top.catalogProductId),
        matchTier: top.outcome === 'product_match' ? 'product_match' : 'product_category'
      }];
    }
    return [{
      ...baseSeed,
      productId: null,
      matchTier: 'brand_only'
    }];
  }

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
  let catalogMedias = productOid ? await Media.find({
    source: 'catalog-product',
    'metadata.catalogProductId': productOid
  }).select('_id fileType adSuitability classification metadata.imageRole').lean() : [];

  // Tier 0 fallback — detect-identified products (and any product that
  // Shopify-sync didn't enqueue for some reason) have an imageUrl on
  // the CatalogProduct row but NO catalog-product Media doc yet. The
  // three tiers above return empty, so the campaign would queue zero
  // Ads. Lazily materialize the hero Media now so the operator's pick
  // still produces a renderable ad. The detect run kicked off here
  // populates crops + scene background in the background for subsequent
  // renders; the immediate render hits the band-aid in layoutInput-
  // Service.loadContext that synthesizes productHero from raw imageUrl.
  if (!catalogMedias.length && productOid && !seeds.length) {
    try {
      const fullProduct = await CatalogProduct.findById(productOid)
        .select('_id brandId advertiserId imageUrl additionalImages imageMediaId')
        .lean();
      if (fullProduct?.imageUrl) {
        const detectSvc = require('./catalogProductDetectService');
        const out = await detectSvc.enqueueProductDetect(fullProduct);
        const heroMediaId = out?.enqueued?.hero?.mediaId;
        if (heroMediaId) {
          catalogMedias = await Media.find({
            _id: heroMediaId
          }).select('_id fileType adSuitability classification metadata.imageRole').lean();
          console.log(
            `   · seedsFromProduct[${productId}]: lazy-materialized catalog-product Media ` +
            `${heroMediaId} from product.imageUrl (detect-identified or unprocessed product)`
          );
        }
      }
    } catch (err) {
      console.warn(`   ⚠️  seedsFromProduct[${productId}]: lazy materialize failed: ${err.message}`);
    }
  }

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
  return rankByShotType(medias);
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

// Phase 4 helper — extract the set of (productId, creativeStyle)
// pairs the cartesian touches. creativeStyle is resolved from the
// template id via the registry (AI templates 1:1 map to a style;
// non-AI templates map to null and are skipped for derivation).
function derivePayloadProductStylePairs(payloads) {
  const pairs = new Map();   // key → { productId, creativeStyle }
  for (const p of payloads) {
    const tpl = registry.getNormalized(p.template);
    const style = tpl?.creativeStyle || null;
    if (!style) continue;   // non-AI templates use the static schema, no derivation
    const productKey = p.productId ? String(p.productId) : 'null';
    const k = `${productKey}|${style}`;
    if (!pairs.has(k)) pairs.set(k, { productId: p.productId || null, creativeStyle: style });
  }
  return Array.from(pairs.values());
}

// Phase 4 EAGER: derive style-aware copy candidates per (brand × product
// × style). Each pair is cache-keyed; reruns are cheap. Errors are
// swallowed — failures fall back to the legacy single-string copy at
// render time via aiCanvasInputBuilder's lazy lookup.
async function runCopyDerivationEager({ brandId, productStylePairs }) {
  if (!brandId || !Array.isArray(productStylePairs) || !productStylePairs.length) return;
  const copyDerivation = require('./copyDerivationService');
  console.log(`✏️  copy-derivation eager: ${productStylePairs.length} (product × style) pairs for brand=${brandId}`);
  await Promise.all(productStylePairs.map(async ({ productId, creativeStyle }) => {
    try {
      const { artifact, cached } = await copyDerivation.deriveCopy({ brandId, productId, creativeStyle });
      const c = artifact?.candidates || {};
      console.log(
        `✏️  copy-derivation ${cached ? 'CACHE-HIT' : 'GENERATED'} ` +
        `brand=${brandId} product=${productId || '-'} style=${creativeStyle} ` +
        `hd=${(c.headlines || []).length} sh=${(c.subheadlines || []).length} ` +
        `eb=${(c.eyebrows || []).length} cta=${(c.cta_micro_copy || []).length}`
      );
    } catch (err) {
      console.warn(`   ⚠️  copy-derivation[product=${productId || '-'},style=${creativeStyle}]: ${err.message}`);
    }
  }));
}

// Phase 1 SHADOW: run the Creative Director once per unique product in
// the cartesian. Director is cache-keyed on (brandId, productId,
// campaignKind, creativeIntent) so repeat calls are cheap. Errors are
// swallowed — telemetry-only stage; legacy render path is unaffected.
async function runCreativeDirectorShadow({ brandId, productIds, campaignKind, creativeIntent, platformFormat = 'meta_feed_1_1' }) {
  if (!brandId || !Array.isArray(productIds)) return;
  const director = require('./aiCreativeDirectorService');
  const uniq = Array.from(new Set(productIds.map(String)));
  // Include the productId-null case for brand campaigns where the
  // cartesian fans out with no specific product (rare today but the
  // contract supports it).
  if (!uniq.length) uniq.push(null);

  // Run in parallel — small fanout (≤ ~5 unique products per campaign).
  await Promise.all(uniq.map(async (pid) => {
    try {
      const { artifact, cached } = await director.directConcepts({
        brandId,
        productId:      pid,
        campaignKind,
        creativeIntent,
        platformFormat
      });
      console.log(
        `🎭 creative-director shadow ${cached ? 'CACHE-HIT' : 'GENERATED'} ` +
        `brand=${brandId} product=${pid || '-'} kind=${campaignKind || '-'} ` +
        `concepts=${(artifact.concepts || []).length}`
      );
    } catch (err) {
      console.warn(`   ⚠️  director[product=${pid || '-'}]: ${err.message}`);
    }
  }));
}

// ════════════════════════════════════════════════════════════════════
// Phase A5a — Concept-driven V2 expansion (AI_CONCEPT_DRIVEN flag)
// ════════════════════════════════════════════════════════════════════
//
// Per product: seededUniverse → directConceptsRound → judgeConcepts-
// Round → Ad.insertMany (3 rows per product). Skips the legacy
// cartesian (seeds × templates × ratios) entirely. Each Ad row carries
// conceptId + conceptArtifactId + mediaIds + judgeRank + judgeScore +
// renderRoute='html_gen' so the renderer (Phase A5b) can materialize
// the declared concept.
//
// Template field stays populated for back-compat with downstream readers
// that branch on it — mapped from concept.creative_style. The 5 AI
// templates collapse to one rendering target under the concept-driven
// model; template here is effectively a vestigial style label.

const CREATIVE_STYLE_TO_TEMPLATE = {
  brand_led:        'ai_brand_led',
  ugc_led:          'ai_ugc_led',
  social_proof_led: 'ai_social_proof_led',
  editorial:        'ai_editorial',
  promotional:      'ai_promotional'
};

// Per-concept identity. campaignId scopes uniqueness; conceptId +
// productId + platformFormat distinguish within campaign. Independent
// of media/template since the concept declares its own media + style.
function computeV2IdentityDigest({ campaignId, productId, conceptId, platformFormat, kind, ctaText, ctaUrl, ctaUrlParams }) {
  const parts = [
    String(campaignId),
    productId ? String(productId) : 'NULL',
    String(conceptId || ''),
    String(platformFormat || ''),
    String(kind || 'image'),                       // kind distinguishes image vs video variants of the same concept
    String(ctaText || ''),
    String(ctaUrl  || ''),
    String(ctaUrlParams || '')
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// Deterministic-video identity. Namespaced with 'det-video:v1' so it
// cannot collide with V1 (JSON hash) or V2 (pipe-joined, no prefix)
// digests. referenceMediaIds order is load-bearing — a different pick
// order is a different ad. When referenceMediaIds is empty the seed
// mediaId alone stands in (hero default path).
function computeDeterministicVideoDigest({
  campaignId, productId, referenceMediaIds, mediaId,
  platformFormat, ctaText, ctaUrl, ctaUrlParams,
  videoPromptGuidance, videoPromptRaw
}) {
  const refKey = (Array.isArray(referenceMediaIds) && referenceMediaIds.length
    ? referenceMediaIds
    : [mediaId]
  ).map(String).join(',');
  const parts = [
    'det-video:v1',
    String(campaignId),
    String(productId),
    refKey,
    String(platformFormat || ''),
    'video',
    String(ctaText || ''),
    String(ctaUrl || ''),
    String(ctaUrlParams || ''),
    String(videoPromptGuidance || ''),
    String(videoPromptRaw || '')
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// Merge two expansion result objects (deterministic first, then concept).
// newAdIds / perProduct keep deterministic entries first. queuedCount is
// absolute (countDocuments snapshot) so we take max, not sum.
function mergeExpansionResults(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const sum = (x, y) => (Number(x) || 0) + (Number(y) || 0);
  const byProduct = { ...(a.byProduct || {}) };
  for (const [k, v] of Object.entries(b.byProduct || {})) {
    byProduct[k] = sum(byProduct[k], v);
  }
  const byMode = {};
  const modeKeys = new Set([
    ...Object.keys(a.byMode || {}),
    ...Object.keys(b.byMode || {})
  ]);
  for (const k of modeKeys) {
    byMode[k] = sum(a.byMode?.[k], b.byMode?.[k]);
  }
  return {
    campaignId:   a.campaignId || b.campaignId,
    brandId:      a.brandId || b.brandId,
    campaignKind: a.campaignKind || b.campaignKind,
    queuedCount:  Math.max(a.queuedCount || 0, b.queuedCount || 0),
    newlyQueued:  sum(a.newlyQueued, b.newlyQueued),
    alreadyQueued: sum(a.alreadyQueued, b.alreadyQueued),
    total:        sum(a.total, b.total),
    // Deterministic first so selection/render order prefers standard ads.
    newAdIds:     [...(a.newAdIds || []), ...(b.newAdIds || [])],
    byProduct,
    perProduct:   [...(a.perProduct || []), ...(b.perProduct || [])],
    byMode,
    conceptDriven: !!(a.conceptDriven || b.conceptDriven)
  };
}

// Deterministic video expansion: one video Ad per product, seeded on
// operator-ordered catalog picks (or the feed-order hero when no picks).
// seedMediaIds is ORDER-SIGNIFICANT. No VEO_ADS_PER_PRODUCT_CAP — always
// exactly one ad per product that has a resolvable seed.
async function expandDeterministicVideo({
  campaignId, brandId, campaignKind, productIds,
  seedMediaIds = [],
  seedPicks = null,
  ctaText, ctaUrl, ctaUrlParams,
  platformFormat,
  videoDurationSec,
  videoPromptGuidance = null,
  videoPromptRaw = null,
  excludePairings = []
}) {
  if (!productIds || !productIds.length) {
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      queuedCount: await Ad.countDocuments({ campaignId, status: 'queued' }),
      newlyQueued: 0, alreadyQueued: 0, newAdIds: [], total: 0,
      byProduct: {}, perProduct: [], byMode: { deterministic: 0 }
    };
  }

  // excludePairings shape: [{ productId, mediaId }] — same as V1/V2.
  const excludeSet = new Set(
    (excludePairings || []).map(p =>
      `${p.productId ? String(p.productId) : 'NULL'}|${String(p.mediaId)}`
    )
  );

  // Which product does this seed pick belong to? Returns a productId string
  // that is present in `productIdSet`, or null when the media has no usable
  // association with anything in this run.
  //
  // Two sources, in priority order:
  //   1. metadata.catalogProductId — set on catalog mirrors (hero + alts). This
  //      is authoritative: the Media exists BECAUSE it is that product's image.
  //   2. matchedProducts[] — written by detect when a post is matched to a SKU.
  //      This is what makes a lifestyle/social shot usable as a seed.
  //
  // A post can legitimately match several products (a flat-lay with three SKUs),
  // so when more than one candidate falls inside this run we rank rather than
  // taking the first: a direct 'product_match' beats a looser
  // 'product_category', then higher confidence wins. Picking arbitrarily would
  // attach the seed to a different product on different runs for the same
  // input, which would also change the ad's identity digest.
  // Does this Media genuinely belong to `productId`? Same evidence
  // resolveSeedProductId accepts, asked about ONE product instead of ranking a
  // set. Used to validate explicit seedPicks pairs.
  function mediaAssociatesWithProduct(doc, productId) {
    const pid = String(productId);
    const direct = doc?.metadata?.catalogProductId;
    if (direct != null && String(direct) === pid) return true;
    return (Array.isArray(doc?.matchedProducts) ? doc.matchedProducts : []).some(m =>
      m?.catalogProductId != null &&
      String(m.catalogProductId) === pid &&
      m.outcome === 'product_match');
  }

  function resolveSeedProductId(doc, allowed) {
    const direct = doc?.metadata?.catalogProductId != null
      ? String(doc.metadata.catalogProductId)
      : null;
    if (direct && allowed.has(direct)) return direct;

    // Only outcome:'product_match' counts. 'product_category' means detect
    // placed the media in the same CATEGORY as the SKU, which is not evidence
    // that this image depicts THIS product — seeding a product video from it
    // would ship ~$1 of creative showing something else. Category-only picks
    // are dropped (and logged by the caller) rather than quietly promoted.
    const candidates = (Array.isArray(doc?.matchedProducts) ? doc.matchedProducts : [])
      .filter(m =>
        m?.catalogProductId != null &&
        allowed.has(String(m.catalogProductId)) &&
        m.outcome === 'product_match')
      .map(m => ({
        id:   String(m.catalogProductId),
        // Missing/NaN confidence sorts LAST rather than tying at 0, so a scored
        // match always beats an unscored one instead of winning on id order.
        conf: Number.isFinite(m.confidence) ? m.confidence : -1
      }));
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.conf - a.conf) || a.id.localeCompare(b.id));
    return candidates[0].id;
  }

  // Load picked Media once; group by product PRESERVING pick order.
  //
  // Deliberately NOT restricted to source:'catalog-product' any more. That
  // filter silently discarded every related-media pick — an operator who chose
  // a lifestyle/social shot as the seed got no video from it and no explanation.
  // Related media IS product-associated: catalog mirrors carry
  // metadata.catalogProductId, and posts matched during detect carry
  // matchedProducts[].catalogProductId. resolveSeedProductId below uses both.
  const productIdSet = new Set(productIds.map(String));
  // Load the UNION of both sources. Loading only the authoritative one breaks
  // two things: a client sending only seedPicks would load nothing under the old
  // code and have every pick dropped as "not found", and the merge below — which
  // fills products seedPicks never mentioned from the legacy list — needs those
  // legacy docs present to resolve them.
  const seedIdSource = [
    ...(Array.isArray(seedPicks) ? seedPicks.map(p => p?.mediaId) : []),
    ...(seedMediaIds || [])
  ].filter(Boolean);
  const seedOids = [...new Set(seedIdSource.map(String))].map(toObjectId).filter(Boolean);
  // brandId scoping is explicit now. The dropped source:'catalog-product' filter
  // was never a security control, but it did incidentally narrow what an
  // arbitrary seedMediaId could load. Since these ids come straight off the
  // request body (parsePhase3WizardFields only validates ObjectId shape), scope
  // the query to this brand rather than relying on the downstream productIdSet
  // check to be the only thing standing between a foreign id and a load.
  const seedBrandOid = toObjectId(brandId);
  const seedDocs = seedOids.length
    ? await Media.find({
        _id: { $in: seedOids },
        ...(seedBrandOid ? { brandId: seedBrandOid } : {})
      })
        .select('_id metadata fileType source matchedProducts')
        .lean()
    : [];
  const seedById = new Map(seedDocs.map(d => [String(d._id), d]));

  // EXPLICIT (productId, mediaId) pairs are authoritative when present. They
  // remove the guesswork entirely: no matchedProducts ranking, so the product a
  // seed belongs to cannot flip when detect rewrites its scores, and the same
  // media can legitimately seed TWO products' videos — neither of which a flat
  // mediaId list can express. `seedMediaIds` remains the fallback for links and
  // clients minted before seedPicks existed.
  /** @type {Map<string, mongoose.Types.ObjectId[]>} */
  const picksByProduct = new Map();
  const explicitPairs = Array.isArray(seedPicks) && seedPicks.length
    ? seedPicks
    : null;
  const walk = explicitPairs
    ? explicitPairs.map(p => ({ idStr: String(p.mediaId), assigned: String(p.productId) }))
    : (seedMediaIds || []).map(id => ({ idStr: String(id), assigned: null }));

  for (const { idStr, assigned } of walk) {
    const doc = seedById.get(idStr);
    if (!doc) {
      console.warn(
        `📦 expandDeterministicVideo: seedMediaId=${idStr} not found for this brand — dropped`
      );
      continue;
    }
    // An explicit pair DISAMBIGUATES among associations the media genuinely
    // has; it does not get to invent one. Membership in productIds is not
    // sufficient: without the association check, a body could assign product
    // A's catalog hero to product B and B's video would be seeded — and billed
    // ~$1 — showing the wrong SKU. This also means a productId belonging to
    // another brand cannot be used, since the media load is brand-scoped and a
    // foreign product will have no association with an in-brand Media.
    const cpid = assigned
      ? (productIdSet.has(assigned) && mediaAssociatesWithProduct(doc, assigned) ? assigned : null)
      : resolveSeedProductId(doc, productIdSet);
    if (!cpid) {
      console.warn(
        assigned
          ? `📦 expandDeterministicVideo: seedPick mediaId=${idStr} names productId=${assigned} ` +
            `which is not in this run's productIds — dropped`
          : `📦 expandDeterministicVideo: seedMediaId=${idStr} (source=${doc.source}) has no ` +
            `product association inside this run's productIds — dropped`
      );
      continue;
    }
    if (!picksByProduct.has(cpid)) picksByProduct.set(cpid, []);
    const list = picksByProduct.get(cpid);
    // Preserve first occurrence only (re-picks of the same id ignored).
    if (!list.some(x => String(x) === idStr)) {
      list.push(doc._id);
    }
  }

  // MERGE, don't silence. seedPicks is authoritative only for the products it
  // actually mentions. A payload carrying both — a partial pick list plus a
  // fuller legacy seedMediaIds, or a pick list whose every pair got dropped —
  // would otherwise send the unmentioned products down the hero path, produce a
  // different identityDigest than the seed-based ad already queued for them, and
  // insert a SECOND ad: double video spend for one operator intent.
  if (explicitPairs && (seedMediaIds || []).length) {
    for (const rawId of seedMediaIds) {
      const idStr = String(rawId);
      const doc = seedById.get(idStr);
      if (!doc) continue;
      const cpid = resolveSeedProductId(doc, productIdSet);
      // Only fill products the explicit list said nothing about.
      if (!cpid || picksByProduct.has(cpid)) continue;
      if (!picksByProduct.has(cpid)) picksByProduct.set(cpid, []);
      const list = picksByProduct.get(cpid);
      if (!list.some(x => String(x) === idStr)) {
        list.push(doc._id);
        console.log(
          `📦 expandDeterministicVideo: product ${cpid} not covered by seedPicks — ` +
          `filled from legacy seedMediaIds (${idStr})`
        );
      }
    }
  }

  const aspectRatio = aspectRatioForPlatformFormat(platformFormat) || '1:1';
  const payloads = [];
  const perProduct = [];

  for (const productId of productIds) {
    const pidStr = String(productId);
    const productOid = toObjectId(productId);
    if (!productOid) {
      perProduct.push({ productId: pidStr, skipped: 'invalid_product_id' });
      continue;
    }

    let mediaId = null;
    let referenceMediaIds = [];
    const picks = picksByProduct.get(pidStr) || [];

    if (picks.length) {
      // ONE ad with the ordered reference stack; position 0 = primary seed.
      referenceMediaIds = picks.slice();
      mediaId = picks[0];

      // PRODUCT ANCHOR. A non-empty referenceMediaIds makes buildReferenceImages
      // take the ordered-only path, which SKIPS seed+catalog assembly entirely.
      // That is correct when the picks are catalog imagery, but when every pick
      // is related/social media it would hand the model a lifestyle frame and
      // nothing else — worse product fidelity than the old behaviour, where the
      // pick was silently dropped and the ad fell back to hero+alts. Paying ~$1
      // for a weaker stack than we had before is not a fix.
      //
      // So: an operator picking a lifestyle shot means "make this the PRIMARY
      // seed", not "discard the product imagery". If none of the picks is a
      // catalog mirror for this product, append the catalog hero after them —
      // position 0 stays theirs, and the model still gets a product anchor.
      const hasCatalogAnchor = picks.some(id => {
        const doc = seedById.get(String(id));
        const direct = doc?.metadata?.catalogProductId;
        return direct != null && String(direct) === pidStr;
      });
      if (!hasCatalogAnchor) {
        const anchor = await Media.findOne({
          source: 'catalog-product',
          'metadata.catalogProductId': productOid,
          'metadata.imageRole': 'hero'
        }).select('_id').lean()
          || await Media.findOne({
            source: 'catalog-product',
            'metadata.catalogProductId': productOid
          }).sort({ createdAt: 1 }).select('_id').lean();
        if (anchor?._id && !referenceMediaIds.some(x => String(x) === String(anchor._id))) {
          referenceMediaIds.push(anchor._id);
          console.log(
            `📦 expandDeterministicVideo[${pidStr}]: picks are all non-catalog — appended ` +
            `catalog anchor ${anchor._id} after ${picks.length} operator pick(s)`
          );
        } else if (!anchor?._id) {
          console.warn(
            `📦 expandDeterministicVideo[${pidStr}]: picks are all non-catalog and no catalog ` +
            `Media exists to anchor them — shipping seed-only stack`
          );
        }
      }
    } else {
      // Feed-order hero: imageRole hero → earliest createdAt → lazy materialize.
      let hero = await Media.findOne({
        source: 'catalog-product',
        'metadata.catalogProductId': productOid,
        'metadata.imageRole': 'hero'
      }).select('_id').lean();

      if (!hero) {
        hero = await Media.findOne({
          source: 'catalog-product',
          'metadata.catalogProductId': productOid
        }).sort({ createdAt: 1 }).select('_id').lean();
      }

      if (!hero) {
        // Lazy materialize — same pattern as seedsFromProduct ~:1133-1155.
        try {
          const fullProduct = await CatalogProduct.findById(productOid)
            .select('_id brandId advertiserId imageUrl additionalImages imageMediaId')
            .lean();
          if (fullProduct?.imageUrl) {
            const detectSvc = require('./catalogProductDetectService');
            const out = await detectSvc.enqueueProductDetect(fullProduct);
            const heroMediaId = out?.enqueued?.hero?.mediaId;
            if (heroMediaId) {
              hero = await Media.findById(heroMediaId).select('_id').lean();
              console.log(
                `📦 expandDeterministicVideo[${pidStr}]: lazy-materialized catalog-product Media ` +
                `${heroMediaId} from product.imageUrl`
              );
            }
          }
        } catch (err) {
          console.warn(
            `   ⚠️  expandDeterministicVideo[${pidStr}]: lazy materialize failed: ${err.message}`
          );
        }
      }

      if (!hero) {
        perProduct.push({ productId: pidStr, skipped: 'no_hero_media' });
        continue;
      }
      mediaId = hero._id;
      referenceMediaIds = []; // render derives hero+alt1+alt2
    }

    // excludePairings on (productId, mediaId) — mirror V2 filterUniverseForProduct.
    const pairKey = `${pidStr}|${String(mediaId)}`;
    if (excludeSet.has(pairKey)) {
      perProduct.push({ productId: pidStr, skipped: 'excluded_pairing', mediaId: String(mediaId) });
      continue;
    }

    const refForMediaIds = referenceMediaIds.length
      ? referenceMediaIds.map(id => new mongoose.Types.ObjectId(String(id)))
      : [new mongoose.Types.ObjectId(String(mediaId))];
    const mediaIdOid = new mongoose.Types.ObjectId(String(mediaId));

    payloads.push({
      brandId,
      campaignId,
      campaignRunIds: [],
      mediaId:             mediaIdOid,
      productId:           productOid,
      // No concept — deterministic path.
      conceptId:           null,
      conceptArtifactId:   null,
      mediaIds:            refForMediaIds,
      referenceMediaIds:   referenceMediaIds.length
        ? referenceMediaIds.map(id => new mongoose.Types.ObjectId(String(id)))
        : [],
      judgeRank:           null,
      judgeScore:          null,
      generationOrder:     null,
      renderRoute:         'veo',
      kind:                'video',
      template:            'ai_brand_led',
      aspectRatio,
      campaignKind,
      platformFormat,
      videoDurationSec:    videoDurationSec || null,
      matchTier:           'product_match',
      variantKind:         'product_image',
      paletteSource:       'media',
      rafflePrizeMediaId:  null,
      readinessScore:      null,
      status:              'queued',
      videoPromptGuidance: videoPromptGuidance || null,
      videoPromptRaw:      videoPromptRaw || null,
      identityDigest: computeDeterministicVideoDigest({
        campaignId,
        productId: pidStr,
        referenceMediaIds,
        mediaId: mediaIdOid,
        platformFormat,
        ctaText, ctaUrl, ctaUrlParams,
        videoPromptGuidance, videoPromptRaw
      }),
      ctaText, ctaUrl, ctaUrlParams,
      queuedAt:    new Date(),
      generatedAt: new Date()
    });
    perProduct.push({
      productId: pidStr,
      mediaId: String(mediaId),
      referenceMediaIds: referenceMediaIds.map(String),
      payloads: 1
    });
  }

  if (!payloads.length) {
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      queuedCount: await Ad.countDocuments({ campaignId, status: 'queued' }),
      newlyQueued: 0, alreadyQueued: 0, newAdIds: [], total: 0,
      byProduct: {}, perProduct, byMode: { deterministic: 0 }
    };
  }

  // Bulk insert — same dup-key(11000) swallow as runConceptDrivenExpansion.
  let inserted = [];
  try {
    inserted = await Ad.insertMany(payloads, { ordered: false });
  } catch (err) {
    if (err.writeErrors && err.result?.insertedIds) {
      const insertedIds = err.result.insertedIds || {};
      inserted = Object.values(insertedIds);
      if (inserted.length) inserted = await Ad.find({ _id: { $in: inserted } }).lean();
    } else if (err.code === 11000) {
      inserted = [];
    } else {
      throw err;
    }
  }

  const newAdIds = inserted.map(d => String(d._id || d));
  const alreadyQueued = payloads.length - newAdIds.length;
  const queuedCount = await Ad.countDocuments({ campaignId, status: 'queued' });

  console.log(
    `📦 expandDeterministicVideo: campaign=${campaignId} products=${productIds.length} ` +
    `payloads=${payloads.length} newlyQueued=${newAdIds.length} ` +
    `alreadyQueued=${alreadyQueued} totalQueued=${queuedCount}`
  );

  return {
    campaignId: String(campaignId), brandId, campaignKind,
    queuedCount, newlyQueued: newAdIds.length, alreadyQueued,
    newAdIds, total: payloads.length,
    byProduct: payloads.reduce((acc, p) => {
      const k = p.productId ? String(p.productId) : 'NULL';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    perProduct,
    byMode: { deterministic: payloads.length }
  };
}

// Derive matchTier from the primary media's universe role. Catalog
// (hero/alt) → 'product_match' (the product IS the SKU). UGC tiers
// keep their semantic tier so readinessScore math stays consistent.
function matchTierForUniverseRole(role) {
  switch (role) {
    case 'catalog':
    case 'catalog_hero':
    case 'catalog_alt':
      return 'product_match';
    case 'ugc_product_match':
      return 'product_match';
    case 'ugc_product_category':
      return 'product_category';
    case 'ugc_brand_match':
      return 'brand_match';
    default:
      return 'product_match';   // safe fallback
  }
}

// variantKind from the primary media's universe role. catalog_* roles
// are catalog product photography ('product_image'); UGC roles surface
// as 'ugc'. Used by downstream readers that gate on this enum.
function variantKindForUniverseRole(role) {
  return (role === 'catalog' || role === 'catalog_hero' || role === 'catalog_alt') ? 'product_image' : 'ugc';
}

async function runConceptDrivenExpansion({
  campaignId, brandId, campaignKind, productIds,
  mediaIds = [],                                    // operator-picked seed media — when non-empty, restricts the Director's universe to just those IDs
  ctaText, ctaUrl, ctaUrlParams,
  platformFormat,
  kinds,                                            // [] of 'image'|'video' — what pipelines to emit per concept
  includeCategoryMatched, includeBrandMatched,
  excludePairings, creativeIntent,
  videoDurationSec = null,                          // wizard-requested video length (sec); null = standard 8s
  videoPromptGuidance = null,                       // run-level guidance — stamped on video Ad rows
  videoPromptRaw = null                             // run-level raw override — stamped on video Ad rows
}) {
  const { resolveKinds, renderRouteForKind } = require('./platformFormats');
  const resolvedKinds = (Array.isArray(kinds) && kinds.length)
    ? kinds
    : resolveKinds(platformFormat, 'both');
  const seededUniverseSvc = require('./seededUniverseService');
  const director          = require('./aiCreativeDirectorService');
  const judge             = require('./aiJudgeService');

  // excludePairings is keyed by (productId, mediaId) and lets the
  // operator drop specific seed-product pairings the wizard showed.
  // Apply per-product by filtering the seeded universe before the
  // Director sees it.
  const excludeSet = new Set(
    (excludePairings || []).map(p =>
      `${p.productId ? String(p.productId) : 'NULL'}|${String(p.mediaId)}`
    )
  );
  function filterUniverseForProduct(productId, universe) {
    if (!excludeSet.size) return universe;
    const productKey = productId ? String(productId) : 'NULL';
    return universe.filter(u => !excludeSet.has(`${productKey}|${String(u.mediaId)}`));
  }

  // Brand-only runs (no productIds) iterate a single [null] product —
  // seededUniverseService and the Director both accept productId=null
  // and switch to brand-scoped signals (all brand catalog media +
  // brand_match UGC).
  const productIterations = productIds.length > 0 ? productIds : [null];

  const perProductResults = await Promise.all(productIterations.map(async productId => {
    const productTag = productId ? `product=${productId}` : `brand-only`;
    try {
      // 1. Seeded universe. wantsVideo flips a ranking bias inside the
      // universe service — text-burned-in candidates get deprioritized
      // because Veo's image-to-video mode bakes overlay text into the
      // generated video (which we can't remove later). Text-free seeds
      // ranked first; text-burned only used if nothing else exists.
      const { universe, seedUniverseHash, counts } =
        await seededUniverseSvc.buildSeededUniverse(brandId, productId, {
          includeCategoryMatched, includeBrandMatched, topN: 10,
          wantsVideo: resolvedKinds.includes('video'),
          restrictToMediaIds: Array.isArray(mediaIds) && mediaIds.length ? mediaIds : null
        });
      const filtered = filterUniverseForProduct(productId, universe);
      if (!filtered.length) {
        console.log(`📦 conceptDriven[${productTag}]: empty universe after excludePairings — skipping`);
        return { productId, payloads: [], skipped: 'empty_universe' };
      }

      // 2. Director round (3 concepts). campaignId threaded so the
      // Director can load Campaign.creativeBrief for this specific
      // campaign and render it as a CAMPAIGN BRIEF block in the prompt
      // (Phase 2 of the voice/brief cascade).
      const { artifact, concepts, roundIndex, warnings: dirWarnings } =
        await director.directConceptsRound({
          brandId, productId, platformFormat, campaignKind, campaignId,
          creativeIntent, seededUniverse: filtered, seedUniverseHash
        });
      if (!concepts.length) {
        console.warn(`📦 conceptDriven[${productTag}]: Director returned no concepts — skipping`);
        return { productId, payloads: [], skipped: 'no_concepts' };
      }

      // 3. Judge — score + rank all concepts (no culling)
      let conceptScores = [];
      let judgeArtifactId = null;
      let batchRationale = null;
      try {
        const judged = await judge.judgeConceptsRound({
          concepts,
          conceptArtifactId: artifact._id,
          roundIndex,
          inputSummary:  artifact.inputSummary,
          brandSignal:   artifact.inputSummary?.brand_signal,
          seededUniverse: filtered,
          brandId, productId, campaignId
        });
        conceptScores  = judged.conceptScores;
        judgeArtifactId = judged.judgeResultArtifactId;
        batchRationale  = judged.batchRationale;
      } catch (err) {
        // Judge failure is non-fatal — emit unscored Ads in input order.
        console.warn(`📦 conceptDriven[${productTag}]: Judge failed (${err.message}) — queueing unscored`);
        conceptScores = concepts.map((c, i) => ({
          conceptId: c.concept_id, judgeScore: null, judgeRank: i + 1,
          criteriaScores: {}, hardViolations: []
        }));
      }
      const scoreByConcept = new Map(conceptScores.map(s => [s.conceptId, s]));

      // 4. Map concepts → Ad payloads
      const universeById = new Map(filtered.map(u => [String(u.mediaId), u]));
      const payloads = [];
      for (const concept of concepts) {
        const mp = Array.isArray(concept.media_picks) ? concept.media_picks : [];
        if (!mp.length) {
          console.warn(`   ⛔ concept ${concept.concept_id}: no media_picks — skipping`);
          continue;
        }
        const primaryId = String(mp[0].media_id);
        const primaryUniverseEntry = universeById.get(primaryId);
        if (!primaryUniverseEntry) {
          console.warn(`   ⛔ concept ${concept.concept_id}: media_pick[0]="${primaryId}" not in filtered universe — skipping`);
          continue;
        }
        const mediaIdObjs = mp
          .map(p => p.media_id)
          .filter(id => universeById.has(String(id)))
          .map(id => new mongoose.Types.ObjectId(String(id)));
        if (!mediaIdObjs.length) continue;

        const score = scoreByConcept.get(concept.concept_id) || {};
        const template = CREATIVE_STYLE_TO_TEMPLATE[concept.creative_style] || 'ai_brand_led';
        const role = primaryUniverseEntry.role;

        // One payload per requested kind. Image → html_gen, video → veo.
        // identityDigest includes kind so image+video variants of the same
        // concept don't collide on the (campaignId, identityDigest) unique
        // index.
        for (const kind of resolvedKinds) {
          payloads.push({
            brandId,
            campaignId,
            campaignRunIds: [],
            mediaId:        new mongoose.Types.ObjectId(primaryId),
            productId:      toObjectId(productId),
            // Concept-driven fields (A1 schema)
            conceptId:         concept.concept_id,
            conceptArtifactId: artifact._id,
            mediaIds:          mediaIdObjs,
            judgeRank:         score.judgeRank ?? null,
            judgeScore:        score.judgeScore ?? null,
            generationOrder:   null,
            renderRoute:       renderRouteForKind(kind),
            kind,
            // Legacy required fields kept populated for back-compat
            template,
            aspectRatio:       aspectRatioForPlatformFormat(platformFormat) || '1:1',
            campaignKind,
            platformFormat,
            videoDurationSec:  kind === 'video' ? (videoDurationSec || null) : null,
            videoPromptGuidance: kind === 'video' ? (videoPromptGuidance || null) : null,
            videoPromptRaw:      kind === 'video' ? (videoPromptRaw || null) : null,
            matchTier:         matchTierForUniverseRole(role),
            variantKind:       variantKindForUniverseRole(role),
            paletteSource:     'media',
            rafflePrizeMediaId: null,
            readinessScore:    score.judgeScore ?? null,
            status:            'queued',
            identityDigest:    computeV2IdentityDigest({
              campaignId, productId,
              conceptId: concept.concept_id,
              platformFormat,
              kind,
              ctaText, ctaUrl, ctaUrlParams
            }),
            ctaText, ctaUrl, ctaUrlParams,
            queuedAt:          new Date(),
            generatedAt:       new Date()
          });
        }
      }

      console.log(
        `📦 conceptDriven[${productTag}]: round=${roundIndex} ` +
        `universe=${filtered.length} (catalog=${counts.catalog || (counts.catalog_hero + counts.catalog_alt)} ` +
        `ugc=${counts.ugc_product_match + counts.ugc_product_category + counts.ugc_brand_match}) ` +
        `concepts=${concepts.length} payloads=${payloads.length} ` +
        `dirWarnings=${dirWarnings.length} judge=${judgeArtifactId ? 'ok' : 'skipped'}`
      );

      return {
        productId, payloads,
        roundIndex,
        conceptArtifactId: String(artifact._id),
        judgeArtifactId:   judgeArtifactId ? String(judgeArtifactId) : null,
        batchRationale
      };
    } catch (err) {
      console.error(`📦 conceptDriven[${productTag}]: failed (${err.message})`);
      return { productId, payloads: [], skipped: 'error', error: err.message };
    }
  }));

  // Per-(product, kind) caps. Video is expensive (~$1.75/Veo call) so it
  // caps at VEO_ADS_PER_PRODUCT_CAP (1); image uses ADS_PER_PRODUCT_CAP (3).
  // Judge already ranked concepts (judgeRank=1=best); sort ascending and
  // take the top N within each kind bucket.
  const CAP_BY_KIND = { video: VEO_ADS_PER_PRODUCT_CAP, image: ADS_PER_PRODUCT_CAP };
  const payloads = perProductResults.flatMap(r => {
    if (!r.payloads.length) return [];
    const byKind = new Map();
    for (const p of r.payloads) {
      const k = p.kind || 'image';
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(p);
    }
    const kept = [];
    for (const [kind, list] of byKind.entries()) {
      const cap = CAP_BY_KIND[kind] ?? Infinity;
      const sorted = list.slice().sort((a, b) => (a.judgeRank ?? 999) - (b.judgeRank ?? 999));
      const slice  = isFinite(cap) ? sorted.slice(0, cap) : sorted;
      if (slice.length < list.length) {
        const tag = r.productId ? `product=${r.productId}` : 'brand-only';
        console.log(`📦 conceptDriven[${tag}]: capped ${list.length} → ${slice.length} ${kind} payload(s) (cap=${cap})`);
      }
      kept.push(...slice);
    }
    return kept;
  });
  if (!payloads.length) {
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      queuedCount: await Ad.countDocuments({ campaignId, status: 'queued' }),
      newlyQueued: 0, alreadyQueued: 0, newAdIds: [], total: 0, byProduct: {},
      conceptDriven: true,
      perProduct: perProductResults,
      byMode: { director: 0 }
    };
  }

  // Bulk insert — ordered: false swallows dup-key per (campaignId,
  // identityDigest) so re-running the wizard with the same product
  // picks doesn't double-queue the same concepts. Note: each Generate
  // press creates a NEW round with NEW concept_ids, so dup-key only
  // hits when the operator re-runs without changing state and the
  // Director happens to produce an identically-id'd concept (rare).
  let inserted = [];
  try {
    inserted = await Ad.insertMany(payloads, { ordered: false });
  } catch (err) {
    if (err.writeErrors && err.result?.insertedIds) {
      const insertedIds = err.result.insertedIds || {};
      inserted = Object.values(insertedIds);
      if (inserted.length) inserted = await Ad.find({ _id: { $in: inserted } }).lean();
    } else if (err.code === 11000) {
      inserted = [];
    } else {
      throw err;
    }
  }

  const newAdIds = inserted.map(d => String(d._id || d));
  const alreadyQueued = payloads.length - newAdIds.length;
  const queuedCount = await Ad.countDocuments({ campaignId, status: 'queued' });

  console.log(
    `📦 conceptDriven: campaign=${campaignId} products=${productIds.length} ` +
    `concepts=${payloads.length} newlyQueued=${newAdIds.length} ` +
    `alreadyQueued=${alreadyQueued} totalQueued=${queuedCount}`
  );

  // byProduct from POST-CAP payloads (the array passed to insertMany) —
  // r.payloads is pre-cap and would over-report vs what actually queued.
  const byProduct = payloads.reduce((acc, p) => {
    const k = p.productId ? String(p.productId) : 'NULL';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  // Director-mode count for byMode merge (video payloads only).
  const directorCount = payloads.filter(p => p.kind === 'video').length;
  return {
    campaignId: String(campaignId), brandId, campaignKind,
    queuedCount, newlyQueued: newAdIds.length, alreadyQueued,
    newAdIds, total: payloads.length,
    byProduct,
    conceptDriven: true,
    perProduct: perProductResults,
    byMode: { director: directorCount }
  };
}

module.exports = {
  expandWizardJob,
  selectAdsForRun,
  computeIdentityDigest,
  computeV2IdentityDigest,
  computeDeterministicVideoDigest,
  expandDeterministicVideo,
  mergeExpansionResults,
  runConceptDrivenExpansion,
  SUPPORTED_TEMPLATES,
  // Exposed so picker endpoints can apply the same content-nature
  // gate the seed expansion uses — otherwise the picker shows posts
  // that would be silently dropped at expansion time.
  isMediaEligibleByContentNature
};
