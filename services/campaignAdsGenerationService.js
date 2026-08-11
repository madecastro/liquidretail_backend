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
const {
  REASON: PER_PRODUCT_REASON,
  WARNING: PER_PRODUCT_WARNING,
  normalizePerProductList,
  summarizeEmptyExpansion
} = require('./perProductReasons');
const { conceptField, conceptMediaPicks } = require('./conceptProjection');
const alertService = require('./alertService');

// Cast a string/ObjectId to ObjectId. Required when querying
// metadata.catalogProductId (Mixed type) — Mongoose doesn't auto-cast
// inside Mixed, so string from req.body won't match the stored ObjectId.
function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;
}

// Queueable templates ONLY. Stage 1 (2026-08-02): the 7 non-ai_* legacy
// templates (creator_endorsement, product_overlay, results_proof,
// review_collage, testimonial_overlay, testimonial_spotlight,
// ugc_split_screen) are removed from this set so the cartesian can never
// queue one. They route to renderViaSpec which cannot render (CLAUDE.md §1).
// Existing Ads that already reference them keep their template string —
// inspector / board / labels still resolve via templateRegistry. Do not
// delete the registry entries.
const SUPPORTED_TEMPLATES = new Set([
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
// will look obviously wrong. Legacy keys kept for read-safety if any
// code path still consults the map for an existing Ad's template.
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
const {
  PLATFORM_FORMATS,
  LIVE_PLATFORM_FORMAT_KEYS,
  resolvePreset,
  assertGeneratablePlatformFormat,
  // Interface contract (platformFormats lane): masters for google_video /
  // google_all. Fall back to the contracted list when the export has not
  // landed yet so this file can merge independently.
  GOOGLE_VIDEO_MASTERS: _GOOGLE_VIDEO_MASTERS_EXPORT
} = require('./platformFormats');
// Only live surfaces contribute shipping ratios — coming_soon aspects (e.g.
// 1.91:1 Demand Gen) must not unlock billable legacy-cartesian work.
const SHIPPING_RATIOS = new Set(
  Object.values(PLATFORM_FORMATS)
    .filter((f) => f.status === 'live')
    .map(f => f.aspectRatio)
    .filter(Boolean)
);

// ── Google PMax video masters / derive-only (Phase A) ─────────────────
// BILLABLE: GOOGLE_VIDEO_MASTERS only (9:16 + 16:9 Omni submits).
// FREE:     PMAX_VIDEO_DERIVE_ONLY (1:1) is crop+retitle from the 9:16
//           master — NEVER an Omni submit (see routes/ads.js derive path).
// Meta presets keep videoFormats length === 1; iterating masters is
// byte-equivalent to today's [0]-only path for Meta (see expandWizardJob).
const GOOGLE_VIDEO_MASTERS = Array.isArray(_GOOGLE_VIDEO_MASTERS_EXPORT) && _GOOGLE_VIDEO_MASTERS_EXPORT.length
  ? _GOOGLE_VIDEO_MASTERS_EXPORT.slice()
  : ['pmax_video_9_16', 'pmax_video_16_9'];
const GOOGLE_VIDEO_MASTER_SET = new Set(GOOGLE_VIDEO_MASTERS);
// Derive-only square surface — free crop of the 9:16 master.
const PMAX_VIDEO_DERIVE_ONLY = 'pmax_video_1_1';
// Source master for the 1:1 derive. Portrait master is the crop source
// (centre/face crop 9:16 → 1:1); landscape master is a separate billable.
const PMAX_VIDEO_DERIVE_SOURCE = 'pmax_video_9_16';
// PMax floor per Google spec (Omni ceiling is also 10s). Meta default
// stays provider-default (8s via Omni caps) — 8→10 Meta ships separately.
const GOOGLE_PMAX_VIDEO_DURATION_SEC = 10;
// Meta's default clip length, owner decision 2026-08-11 (was the provider
// default of 8s). See resolveVideoDurationForFormat for why this is NOT a
// re-mint and how to revert it without a deploy.
const DEFAULT_META_VIDEO_DURATION_SEC = 10;
// Schema field name for the derive-only marker.
// Declared on models/Ad.js (deriveFromMaster). The render path ALSO keys
// on platformFormat === PMAX_VIDEO_DERIVE_ONLY and on funnelStage set, so
// a dropped marker can never re-open a billable submit on a free surface.
const DERIVE_FROM_MASTER_FIELD = 'deriveFromMaster';
// Funnel-stage field (models/Ad.js). When set, the Ad is a free Remotion
// re-title of an already-paid plate — never its own Omni generation.
const FUNNEL_STAGE_FIELD = 'funnelStage';
const PMAX_FUNNEL_STAGES = Object.freeze(['awareness', 'consideration', 'conversion']);
const PMAX_FUNNEL_STAGE_SET = new Set(PMAX_FUNNEL_STAGES);

/**
 * Kill switch for free funnel-titled variants on Google PMax video.
 * Default ON (owner chose 3 variants). Flag off ⇒ no variant ads minted,
 * byte-identical to pre-change (2 masters + 1 derive-only 1:1).
 */
function isPmaxFunnelVariantsEnabled() {
  const v = process.env.PMAX_FUNNEL_VARIANTS;
  if (v == null || v === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

/**
 * Map Ad.funnelStage → remotion preset name for PMax video, or null.
 * Absent/unknown stage or non-PMax format → null (today's cascade).
 */
function resolveFunnelPresetOverride(ad) {
  if (!ad) return null;
  const stage = ad[FUNNEL_STAGE_FIELD] || ad.funnelStage;
  if (!stage || !PMAX_FUNNEL_STAGE_SET.has(String(stage))) return null;
  if (!isGooglePmaxVideoFormat(ad.platformFormat)) return null;
  return `canonical-${stage}-pmax10`;
}

/**
 * Master formats for deterministic video expansion.
 *
 * MONEY:
 *   - Meta (meta_video / meta_all): presetVideoFormats = [META_VIDEO_MASTER]
 *     length 1 → iterating is equivalent to today's videoFormats[0] only.
 *   - Google (google_video / google_all): masters = live-filtered
 *     GOOGLE_VIDEO_MASTERS (two entries when live) → TWO billable Omni
 *     submits per product. pmax_video_1_1 is NEVER a master (stripped even
 *     if a stale resolvePreset still returns the full fan-out).
 */
function resolveDeterministicVideoMasterFormats(presetVideoFormats, fallbackFormat) {
  const list = Array.isArray(presetVideoFormats) && presetVideoFormats.length
    ? presetVideoFormats.slice()
    : (fallbackFormat ? [fallbackFormat] : []);
  // If any entry is a known Google master, treat as a Google run and keep
  // only masters — never queue derive-only or Shorts as billable masters.
  const googleMasters = list.filter((f) => GOOGLE_VIDEO_MASTER_SET.has(f));
  if (googleMasters.length) return googleMasters;
  // Meta / single: return the list as-is (typically length 1).
  return list.filter((f) => f && f !== PMAX_VIDEO_DERIVE_ONLY);
}

/**
 * THE shared derive-only gate. Returns the master platformFormat a
 * derive-only / funnel-variant video Ad must crop (or re-title) from, or
 * null for a normal billable ad.
 *
 * ⚠️ MONEY — EVERY code path that can reach a billable video submit MUST
 * consult this before submitting. It lives here, next to the constants,
 * precisely so it cannot drift between callers: the render loop
 * (routes/ads.js) and the regenerate path (services/adRegenerateService.js)
 * both import it. A per-caller copy is how the regenerate hole opened —
 * regenerate reached veoService.generateForAd for a derive-only 1:1 ad and
 * billed a full Omni generation ($1.20 at 10s, and up to $5.00 if the
 * square falls through to the per-second aspect-fallback model) on the one
 * surface the product sells as free derivation.
 *
 * FAIL-CLOSED on three signals (any one is sufficient):
 *   1. explicit `deriveFromMaster` marker
 *   2. `platformFormat === pmax_video_1_1` (always derive-only by design)
 *   3. `funnelStage` set to a known stage — a funnel-variant ad is ALWAYS
 *      a free re-title of an already-paid plate; a dropped marker must
 *      never re-open Omni on that row (pinned by verifyPmaxFunnelVariants)
 */
function resolveDeriveFromMaster(ad) {
  if (!ad) return null;
  const explicit = ad[DERIVE_FROM_MASTER_FIELD];
  if (typeof explicit === 'string' && explicit) return explicit;
  if (ad.platformFormat === PMAX_VIDEO_DERIVE_ONLY) return PMAX_VIDEO_DERIVE_SOURCE;
  // Funnel-variant fail-closed: retitle of the same-format master plate.
  // Without this, a dropped deriveFromMaster on a 9:16/16:9 funnel ad
  // would fall through to the billable Omni path.
  const stage = ad[FUNNEL_STAGE_FIELD] || ad.funnelStage;
  if (stage && PMAX_FUNNEL_STAGE_SET.has(String(stage))) {
    if (GOOGLE_VIDEO_MASTER_SET.has(ad.platformFormat)) return ad.platformFormat;
    if (ad.platformFormat === PMAX_VIDEO_DERIVE_ONLY) return PMAX_VIDEO_DERIVE_SOURCE;
  }
  return null;
}

/**
 * True for the Phase A Google PMax VIDEO surfaces (two billable masters +
 * the derive-only square). Used to scope digest inputs: see the money note
 * on computeDeterministicVideoDigest — these formats have no history, so
 * new digest parts are safe here and NOWHERE else.
 */
function isGooglePmaxVideoFormat(platformFormat) {
  return GOOGLE_VIDEO_MASTER_SET.has(platformFormat)
    || platformFormat === PMAX_VIDEO_DERIVE_ONLY;
}

/**
 * True only when this run generates the derive SOURCE master, so the free
 * 1:1 crop has something to crop from.
 *
 * ⚠️ Requiring the SOURCE (not merely "every entry is some Google master")
 * is load-bearing. A single-format run — e.g. the legacy `single` preset
 * with platformFormat `pmax_video_16_9`, which is now a live selectable
 * surface — resolves to masters `['pmax_video_16_9']`. Under an
 * "every entry is a master" test that reads as a Google run and mints a
 * derive-only 1:1 whose 9:16 source is never generated: the ad can only
 * wait, exhaust its bounded retries and fail. Pinned by
 * scripts/verifyPmaxVideoExpansion.js.
 */
function isGoogleVideoMasterRun(masterFormats) {
  return Array.isArray(masterFormats)
    && masterFormats.length > 0
    && masterFormats.every((f) => GOOGLE_VIDEO_MASTER_SET.has(f))
    && masterFormats.includes(PMAX_VIDEO_DERIVE_SOURCE);
}

/**
 * Pin Google PMax video duration to 10s when the wizard left it unset.
 * MONEY-adjacent: duration is on the Omni submit and now on the identity
 * digest — a later duration change must mint a new ad, not reuse a shorter
 * master. Meta leaves null (provider default 8s) unchanged in this phase.
 */
function resolveVideoDurationForFormat(platformFormat, videoDurationSec) {
  const isGooglePmaxVideo = GOOGLE_VIDEO_MASTER_SET.has(platformFormat)
    || platformFormat === PMAX_VIDEO_DERIVE_ONLY;

  if (videoDurationSec != null && videoDurationSec !== '') {
    const n = Number(videoDurationSec);
    if (Number.isFinite(n)) {
      // ⚠️ PMAX 10s IS A PLATFORM FLOOR, NOT A DEFAULT — an operator value may
      // not go under it. Google rejects PMax video below 10 seconds, so an 8s
      // master is a PAID render ($0.90) that cannot be used as an asset.
      //
      // This is reachable by the ordinary path, not an edge case: the wizard's
      // Video Length control has no "auto" option and posts `8` on every run
      // (its default is literally labelled "8s (standard)"), so BEFORE this
      // clamp every PMax video generated through the UI would have been born
      // unusable. Found by opening the real wizard, not by reading the code.
      //
      // Above the floor the operator still wins; Omni's own enum [4,6,8,10]
      // clamps the top end downstream, so asking for 12 or 15 lands on 10.
      if (isGooglePmaxVideo && n < GOOGLE_PMAX_VIDEO_DURATION_SEC) {
        return GOOGLE_PMAX_VIDEO_DURATION_SEC;
      }
      return n;
    }
  }
  if (GOOGLE_VIDEO_MASTER_SET.has(platformFormat) || platformFormat === PMAX_VIDEO_DERIVE_ONLY) {
    // PMAX floor per Google spec (also Omni ceiling).
    return GOOGLE_PMAX_VIDEO_DURATION_SEC;
  }
  // META default duration (owner decision 2026-08-11: standardise on 10s).
  //
  // Industry guidance puts Stories — the current Meta master surface — at
  // 6-10s and Reels/feed higher, so 10s is at worst neutral and generally
  // better on every Meta placement; 10 is also Omni's ceiling, so this is the
  // longest master available.
  //
  // NOT a re-mint. `computeDeterministicVideoDigest` includes duration ONLY
  // for Google PMax video formats, so every EXISTING Meta ad keeps its stored
  // digest: a repeat Generate still dedupes and re-renders nothing. What
  // changes is future renders — longer clip, and a proportionally larger
  // per-master charge (measured: 10s settles at $0.90 on the developer model).
  //
  // Reversible with no deploy: set META_VIDEO_DURATION_SEC empty or 0 to fall
  // back to `null`, i.e. the provider default (8s via Omni caps).
  const metaDefault = metaVideoDurationSec();
  if (metaDefault != null && isMetaVideoFormat(platformFormat)) return metaDefault;
  return videoDurationSec == null || videoDurationSec === '' ? null : Number(videoDurationSec);
}

/** Meta video surfaces (video-capable meta_* keys). */
function isMetaVideoFormat(platformFormat) {
  return typeof platformFormat === 'string' && platformFormat.startsWith('meta_');
}

/**
 * Meta's default clip length when the wizard didn't specify one.
 * Blank / 0 / negative / unparseable → null → provider default (today's 8s),
 * which is the documented kill switch. Same blank-is-not-zero care as the
 * PMax proof thresholds: `Number('')` is 0, not NaN.
 */
function metaVideoDurationSec() {
  const raw = process.env.META_VIDEO_DURATION_SEC;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_META_VIDEO_DURATION_SEC;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

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
// How many candidate images the Director sees when the operator picked none.
//
// DEFAULT IS 1. Owner 2026-08-02: "we are supposed to be defaulting to one
// image sent to the director, the hero image." That quote is the REQUIREMENT;
// this constant only delivers the "one image" half. **It does not pick the
// hero** — the earlier version of this comment said "DEFAULT IS 1 (hero only)"
// and was wrong for as long as it stood. buildSeededUniverse ranks a merged
// catalog+UGC pool by classification.shotType first and treats
// metadata.imageRole==='hero' as a within-tier tiebreak, so trimming to 1
// yields the top lifestyle candidate (a catalog ALT, or a UGC post). What
// actually pins the catalog's first image is `preferFirstCatalogImage`,
// passed from runConceptDrivenExpansion (see the buildSeededUniverse call)
// and implemented in seededUniverseService.promoteFirstCatalogImage.
//
// One-image means the composition matches the reference exactly. Multi-image
// support stays fully wired — the ceiling is 10 and the window is expected to
// widen later by raising this one value (or DIRECTOR_UNIVERSE_TOP_N in env).
// Do NOT delete multi-pick code when the default is 1; it is dormant, not
// dead.
//
// Explicit operator picks still widen the universe:
//   operatorPickedMedia ? Math.max(mediaIds.length, DIRECTOR_UNIVERSE_TOP_N)
// so pinning 3 images with TOP_N=1 yields max(3,1)=3.
//
// The renderer honours the Director's full pick list (renderService threads
// Ad.mediaIds through when there is no explicit operator stack), so a wider
// universe genuinely produces multi-reference ads instead of silently
// discarding every pick past the first.
const DIRECTOR_UNIVERSE_TOP_N = Math.max(1, parseInt(process.env.DIRECTOR_UNIVERSE_TOP_N, 10) || 1);
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
function computeIdentityDigest({ campaignId, productId, mediaId, template, aspectRatio, variantKind, paletteSource, ctaText, ctaUrl, ctaUrlParams, rafflePrizeMediaId, kind, generationRunId }) {
  const payload = JSON.stringify({
    // SCOPED TO ONE RUN, by owner instruction: "there should be no limitation on
    // creating new ads that may be duplicates since generative ads always have
    // new seeds". Two Generate clicks on the same product/template/ratio are two
    // different images, so refusing the second is wrong.
    //
    // The unique index still does its real job, because this is the RUN id, not
    // a random value: within a run the digest is stable, so a genuine
    // double-insert inside one expansion still collides. Across runs it differs,
    // so a fresh click produces fresh ads.
    //
    // What this does NOT protect against, stated plainly because an earlier
    // draft of this comment claimed otherwise: the worker reaper does not
    // re-expand (worker.js only flips rendering->queued), and expand runs once
    // per POST with no retry — so there is no requeue path for the index to
    // catch here. The real remaining exposure is two rapid Generates minting
    // two runIds and therefore two billable sets, which needs a concurrency
    // guard on the route, not a digest change.
    //
    // Serialized as undefined when absent, which JSON.stringify OMITS — so the
    // payload for any caller that does not pass it is byte-identical to the
    // pre-2026-08-01 payload and their digests are unchanged.
    // STATIC ONLY, enforced HERE rather than at the call site. The two kinds
    // have opposite owner instructions — static is "no limitation on creating
    // new ads that may be duplicates", video is "veo should only generate a
    // video once for each product unless it is revised" — and a video digest
    // that varied by run would re-bill a Veo master on every Generate. That is
    // the expensive kind, so the rule belongs inside the function where no
    // future caller can forget the ternary.
    generationRunId: (generationRunId && String(kind || 'image') !== 'video')
      ? String(generationRunId)
      : undefined,
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
  // Wizard format PRESET. Superset of the three-knob API (platformFormat +
  // kinds + expandStaticFormats). Default 'single' reproduces prior behaviour
  // byte-identically from those knobs. Named presets:
  //   meta_static   — 3 billable image gens per concept (Meta static fan-out)
  //   meta_video    — 1 billable Veo submit per product (9:16 master ONLY)
  //   meta_all      — both
  //   google_static / google_video / google_all — empty while Google is coming_soon
  preset = 'single',
  // Operator MULTI-SELECT surfaces — preset 'explicit' ONLY (ignored by every
  // named preset and by 'single'). The wizard's size cards are checkboxes, so
  // the request names a set of surfaces instead of one platformFormat.
  //
  // MONEY: each surviving staticFormats entry is its own billable image
  // generation per concept. videoFormats is CLAMPED to at most one entry inside
  // resolvePreset — one video Ad per ticked aspect is a measured money bug
  // (CLAUDE.md §2), and the clamp deliberately lives in the resolver so no
  // caller can route around it.
  staticFormats = [],
  videoFormats = [],
  // Operator opted into "All static formats" in the wizard. When true, every
  // image concept is emitted once per Meta static surface
  // (staticFanoutForPlatformFormat) instead of once for platformFormat alone.
  // Default false: a caller that doesn't pass this gets EXACTLY prior
  // behavior — one format, one generation per concept. Video is untouched by
  // this flag; it has its own (not yet built) companion-crop story.
  // Ignored when preset is a named preset other than 'single'.
  expandStaticFormats = false,
  // The CampaignRun this expansion belongs to. Mixed into the static
  // identityDigest so a second Generate on the same campaign produces new ads
  // rather than colliding with the first run's and silently expanding to
  // nothing — see computeIdentityDigest. Optional: when omitted the digest is
  // byte-identical to the pre-2026-08-01 one, so the preview endpoint and any
  // other caller keep their existing behaviour.
  generationRunId = null,
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
  dryRun = false,
  // UGC-ads Phase 3. Wizard-picked UGC that must land at seed index 0.
  // Threaded straight through to buildSeededUniverse; the service handles
  // both the pool-hoist and the kill switch. Absent / null = byte-identical
  // to the pre-Phase-3 call for every other caller.
  preferUgcMediaId = null
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
  //
  // Status is the gate: a request that NAMES a coming_soon format
  // (preset 'single' path) is REFUSED, not silently empty / fall-through.
  // Named presets ignore platformFormat for their format lists, so we only
  // assert when the operator actually supplied a format (or campaign is used).
  // Allowlist for successful resolution is LIVE_PLATFORM_FORMAT_KEYS.
  const presetName = preset || 'single';
  if (platformFormat) {
    // Explicit wizard override — refuse coming_soon with a clear error.
    assertGeneratablePlatformFormat(platformFormat);
  } else if (presetName === 'single' && campaign.platformFormat) {
    // Legacy single path with no override: campaign field is the effective
    // choice. Refuse if it is coming_soon so we don't quietly fall back to
    // meta_feed_1_1 and bill the wrong surface.
    assertGeneratablePlatformFormat(campaign.platformFormat);
  }
  const wizardFormat = platformFormat && LIVE_PLATFORM_FORMAT_KEYS.includes(platformFormat)
    ? platformFormat
    : null;
  const campaignFormat = campaign.platformFormat && LIVE_PLATFORM_FORMAT_KEYS.includes(campaign.platformFormat)
    ? campaign.platformFormat
    : null;
  const effectivePlatformFormat = wizardFormat
    || campaignFormat
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
  // 'image' so legacy callers get the previous behavior.
  // Defaults to STATIC, not 'both'. The product has two separate presets and
  // the operator always picks one, so an unset value means "the wizard didn't
  // say", never "make me one of each" — and 'both' made every static run also
  // queue a Veo video, the most expensive kind, unasked. Measured 2026-08-01:
  // 27 of 127 campaigns have adKinds unset and so took this path, and campaign
  // 6a6a52cd carries 23 video drafts alongside its 63 image drafts as a result.
  // A caller that genuinely wants both still passes 'both' explicitly.
  const requestedKinds = kinds || campaign.adKinds || 'image';

  // PRESET resolution. 'single' (default) is byte-identical to the old
  // three-knob path. Named presets own their format lists and kinds.
  // MONEY: meta_video → videoFormats length === 1 (the 9:16 master). Queueing
  // four video Ads for META_VIDEO_FANOUT would be four billable Veo submits;
  // resolvePreset refuses that. Phase 3 derives the other sizes after the
  // master lands.
  const resolvedPreset = resolvePreset(preset || 'single', effectivePlatformFormat, {
    kinds: requestedKinds,
    expandStaticFormats: !!expandStaticFormats,
    staticFormats,
    videoFormats
  });
  let resolvedKinds = [...resolvedPreset.kinds];
  // Static surfaces each image concept is emitted for. Empty means "use the
  // run platformFormat alone" for the single/no-fanout path; named presets
  // always populate this explicitly.
  const presetStaticFormats = resolvedPreset.staticFormats || [];
  // Video masters the deterministic path will queue.
  //   meta_video / meta_all → [META_VIDEO_MASTER] length 1
  //   google_video / google_all → live-filtered GOOGLE_VIDEO_MASTERS (2 when live)
  // Empty → no video. MONEY: length of the *master* list (not full fan-out)
  // is the billable Omni submit count per product for deterministic video.
  const presetVideoFormats = resolvedPreset.videoFormats || [];
  // Platform format stamped on video Ad rows and used for Veo gating.
  // Prefer the preset's first video master when present so meta_video always
  // queues against the 9:16 master regardless of campaign.platformFormat.
  // (Multi-master Google expansion iterates the full master list below.)
  const videoPlatformFormat = presetVideoFormats[0] || effectivePlatformFormat;
  // Master formats for deterministic expansion. Meta: length 1 (≡ [0]).
  // Google: the two PMax masters. Derive-only (pmax_video_1_1) never appears.
  const detVideoMasterFormats = resolveDeterministicVideoMasterFormats(
    presetVideoFormats,
    videoPlatformFormat
  );
  // Platform format for image director / legacy path when static list is set.
  const imagePlatformFormat = presetStaticFormats[0] || effectivePlatformFormat;
  // Run-level format for seeds / logs / director when mixed or single.
  const runPlatformFormat = resolvedKinds.includes('video') && !resolvedKinds.includes('image')
    ? videoPlatformFormat
    : resolvedKinds.includes('image') && !resolvedKinds.includes('video')
      ? imagePlatformFormat
      : effectivePlatformFormat;

  // Drop 'video' if Veo isn't enabled for this format. AI_VEO_REELS gates
  // Reels (9:16); AI_VEO_FEED gates everything else. If the operator asked
  // for video-only on a format with Veo disabled, this leaves resolvedKinds
  // empty and the early-return below short-circuits with zero queued.
  const veoFlag = videoPlatformFormat === 'meta_reels_9_16'
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
  // Multi-format static lists (meta_static / meta_all / expandStaticFormats) only
  // fan out inside runConceptDrivenExpansion. Force the concept image path when
  // more than one static surface is requested so the fan-out cannot silently
  // collapse to a single legacy-cartesian format.
  const conceptImage       = wantsImage && (
    aiConceptDriven || wantsVideo || presetStaticFormats.length > 1
  );
  const deterministicVideo = wantsVideo && productIds.length > 0;
  const conceptVideo       = wantsVideo && (productIds.length === 0 || directorVariants === true);

  if (!dryRun && (deterministicVideo || conceptImage || conceptVideo)) {
    let detResult = null;
    let conceptResult = null;

    if (deterministicVideo) {
      // MONEY — billable Omni submit decisions live here:
      //
      //   Meta (meta_video / meta_all): detVideoMasterFormats length === 1
      //     (the 9:16 master). Iterating is byte-equivalent to the prior
      //     videoFormats[0]-only call — one Ad per product, one Omni submit.
      //     Other Meta video sizes remain Phase 3 derivations (not queued).
      //
      //   Google (google_video / google_all): detVideoMasterFormats =
      //     live GOOGLE_VIDEO_MASTERS (pmax_video_9_16 + pmax_video_16_9)
      //     → TWO billable Omni submits per product. platformFormat is in
      //     computeDeterministicVideoDigest so the two masters do not
      //     collide on (campaignId, identityDigest).
      //
      //   Derive-only 1:1 (google only): queued AFTER masters with
      //     deriveFromMaster='pmax_video_9_16'. ZERO Omni submits by
      //     construction — routes/ads.js derive path never calls
      //     atlasVideoService.generateForAd / veoGenerateForAd.
      // ⚠️ MONEY: the fallback must never reinstate the derive-only
      // surface as a BILLABLE master. `single` + platformFormat
      // `pmax_video_1_1` resolves videoFormats to ['pmax_video_1_1'];
      // resolveDeterministicVideoMasterFormats strips it, leaving an empty
      // list, and a bare `[videoPlatformFormat]` fallback would put it
      // straight back — turning the free crop surface into a paid Omni
      // submit. Filter the fallback through the same strip.
      const masterFormats = detVideoMasterFormats.length
        ? detVideoMasterFormats
        : [videoPlatformFormat].filter((f) => f && f !== PMAX_VIDEO_DERIVE_ONLY);
      const googleRun = isGoogleVideoMasterRun(masterFormats);
      const detParts = [];
      for (const fmt of masterFormats) {
        // WHY this is billable: each master format is a distinct Omni
        // native aspect (9:16 or 16:9). Cannot free-crop one from the
        // other without losing the full frame the placement requires.
        detParts.push(await expandDeterministicVideo({
          campaignId, brandId, campaignKind, productIds,
          seedMediaIds,
          seedPicks,
          ctaText, ctaUrl, ctaUrlParams,
          platformFormat: fmt,
          // PMax floor 10s when wizard left duration unset; Meta unchanged.
          videoDurationSec: resolveVideoDurationForFormat(fmt, videoDurationSec),
          videoPromptGuidance, videoPromptRaw,
          excludePairings
        }));
      }
      if (googleRun) {
        // WHY this is NOT billable: pmax_video_1_1 is face-safe crop +
        // Remotion retitle of the paid 9:16 master. Hidden Omni submit
        // here would be a ~$0.75–$1.20 double charge per product.
        detParts.push(await expandDeterministicVideo({
          campaignId, brandId, campaignKind, productIds,
          seedMediaIds,
          seedPicks,
          ctaText, ctaUrl, ctaUrlParams,
          platformFormat: PMAX_VIDEO_DERIVE_ONLY,
          videoDurationSec: resolveVideoDurationForFormat(
            PMAX_VIDEO_DERIVE_ONLY, videoDurationSec
          ),
          videoPromptGuidance, videoPromptRaw,
          excludePairings,
          // Marker: source master format. Render path also keys on
          // platformFormat === PMAX_VIDEO_DERIVE_ONLY (fail-closed).
          deriveFromMaster: PMAX_VIDEO_DERIVE_SOURCE
        }));

        // ── FREE funnel-titled variants (PMAX_FUNNEL_VARIANTS) ────────
        // Remotion is self-hosted and free. For each already-paid master
        // plate (and the free 1:1 crop, for surface consistency) mint 3
        // titling-only Ads — awareness / consideration / conversion —
        // each carrying deriveFromMaster + funnelStage so they route
        // through renderDeriveOnlyVideoAd and NEVER reach Omni.
        // Flag off ⇒ skip entirely (byte-identical to pre-change mint).
        // Ad-count ON: 2 masters + 6 master-variants + 1 base 1:1 + 3
        // 1:1-variants = 12 video ads/product; still 2 billable submits.
        if (isPmaxFunnelVariantsEnabled()) {
          for (const fmt of masterFormats) {
            for (const stage of PMAX_FUNNEL_STAGES) {
              detParts.push(await expandDeterministicVideo({
                campaignId, brandId, campaignKind, productIds,
                seedMediaIds,
                seedPicks,
                ctaText, ctaUrl, ctaUrlParams,
                platformFormat: fmt,
                videoDurationSec: resolveVideoDurationForFormat(fmt, videoDurationSec),
                videoPromptGuidance, videoPromptRaw,
                excludePairings,
                // Same-format retitle of the paid master plate.
                deriveFromMaster: fmt,
                funnelStage: stage
              }));
            }
          }
          // 1:1 also gets 3 funnel variants (consistency: Google benefits
          // from variants on every surface). Still free — crop+retitle of
          // the 9:16 master, never Omni.
          for (const stage of PMAX_FUNNEL_STAGES) {
            detParts.push(await expandDeterministicVideo({
              campaignId, brandId, campaignKind, productIds,
              seedMediaIds,
              seedPicks,
              ctaText, ctaUrl, ctaUrlParams,
              platformFormat: PMAX_VIDEO_DERIVE_ONLY,
              videoDurationSec: resolveVideoDurationForFormat(
                PMAX_VIDEO_DERIVE_ONLY, videoDurationSec
              ),
              videoPromptGuidance, videoPromptRaw,
              excludePairings,
              deriveFromMaster: PMAX_VIDEO_DERIVE_SOURCE,
              funnelStage: stage
            }));
          }
        }
      }
      detResult = detParts.reduce(
        (acc, part) => mergeExpansionResults(acc, part),
        null
      );
    }

    const conceptKinds = [
      ...(conceptImage ? ['image'] : []),
      ...(conceptVideo ? ['video'] : [])
    ];
    // Static fan-out list for image concepts.
    // Named presets (meta_static / meta_all) always supply presetStaticFormats
    // (the 3 Meta static sizes). 'single' with expandStaticFormats:true supplies
    // the same list via resolvePreset. 'single' with the flag off leaves the
    // list empty so runConceptDrivenExpansion falls through to [platformFormat]
    // — byte-identical to pre-preset behaviour.
    const staticFanout = conceptImage ? presetStaticFormats : [];
    // Director / concept video stamp: use image primary when image is in the
    // run (so concept digests key off a static surface), else the video master.
    const conceptPlatformFormat = conceptImage
      ? (presetStaticFormats[0] || imagePlatformFormat)
      : videoPlatformFormat;
    if (conceptKinds.length) {
      conceptResult = await runConceptDrivenExpansion({
        campaignId, brandId, campaignKind, productIds,
        mediaIds,   // operator-picked UGC seeds — restricts the Director's universe when non-empty
        ctaText, ctaUrl, ctaUrlParams,
        platformFormat: conceptPlatformFormat,
        staticFormats: staticFanout,
        // When conceptVideo is on, video rows use platformFormat above — which
        // for meta_video is the single 9:16 master. Never pass the full
        // META_VIDEO_FANOUT as staticFormats-style expansion for video.
        kinds: conceptKinds,
        includeCategoryMatched, includeBrandMatched,
        excludePairings, creativeIntent: null,
        videoDurationSec,
        videoPromptGuidance, videoPromptRaw,
        generationRunId,
        preferUgcMediaId
      });
    }

    if (detResult || conceptResult) {
      return mergeExpansionResults(detResult, conceptResult);
    }
    // Both returned null/empty — fall through to legacy image path.
  }

  // Dry-run estimate for deterministic + concept paths (no Director LLM).
  // Deterministic:
  //   Meta  → 1 video ad/product (master only)
  //   Google → masters (2) + derive-only 1:1 (1) = 3 ads/product
  //            of which 2 are billable Omni submits
  // Director: VEO_ADS_PER_PRODUCT_CAP when on.
  // Image: conceptImage → min(3, ADS_PER_PRODUCT_CAP); else fall through
  // to legacy cartesian below.
  if (dryRun && (deterministicVideo || conceptImage || conceptVideo)) {
    // Group seedMediaIds by product for labeling (cheap; Media load once).
    const estimateProducts = productIds.length > 0 ? productIds : [null];
    // How many static surfaces each image concept will be emitted for. Mirrors
    // the live path's staticFanout exactly. Named presets and expandStaticFormats
    // both land in presetStaticFormats; empty list → 1 (single-format path).
    const staticFanoutCount = conceptImage
      ? Math.max(1, presetStaticFormats.length || 1)
      : 1;
    // Deterministic ads per product: one per master format, plus one
    // derive-only 1:1 on Google multi-master runs, plus 3 funnel variants
    // per surface (masters + 1:1) when PMAX_FUNNEL_VARIANTS is on. Meta
    // stays 1. Same derive-only strip as the live path above, so the
    // dry-run count can never advertise a billable master the live path
    // refuses to queue.
    const dryMasterFormats = detVideoMasterFormats.length
      ? detVideoMasterFormats
      : [videoPlatformFormat].filter((f) => f && f !== PMAX_VIDEO_DERIVE_ONLY);
    const dryGoogle = isGoogleVideoMasterRun(dryMasterFormats);
    // base: masters + (1 derive-only 1:1 when Google)
    // variants ON: + 3 per master + 3 for the 1:1 = +3*(masters+1)
    let dryDetPerProduct = dryMasterFormats.length + (dryGoogle ? 1 : 0);
    if (dryGoogle && isPmaxFunnelVariantsEnabled()) {
      dryDetPerProduct += PMAX_FUNNEL_STAGES.length * (dryMasterFormats.length + 1);
    }
    const byProduct = {};
    let detTotal = 0;
    let dirTotal = 0;
    let imgTotal = 0;

    for (const pid of estimateProducts) {
      const key = pid ? String(pid) : 'NULL';
      let n = 0;
      if (deterministicVideo && pid) {
        n += dryDetPerProduct;
        detTotal += dryDetPerProduct;
      }
      if (conceptVideo) {
        n += VEO_ADS_PER_PRODUCT_CAP;
        dirTotal += VEO_ADS_PER_PRODUCT_CAP;
      }
      if (conceptImage) {
        // Multiply by the static fan-out. The cap is applied per
        // (product, kind, platformFormat), so N concepts survive PER SIZE and
        // the real billable count is concepts x sizes.
        //
        // This estimate is the number the wizard shows before the operator
        // commits, and every image in it is a separate billable Atlas submit —
        // if it ignored the fan-out it would quietly under-quote by 3x on an
        // "All static formats" run, which is the one case where the operator
        // most needs an honest number.
        const imgN = Math.min(3, ADS_PER_PRODUCT_CAP) * Math.max(1, staticFanoutCount);
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
  if (runPlatformFormat === 'meta_reels_9_16' && !veoEnabled) {
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
  const platformAspect = aspectRatioForPlatformFormat(runPlatformFormat) || null;
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
              // Passed unconditionally; computeIdentityDigest drops it for
              // video so a Veo master is not re-billed on every Generate.
              generationRunId,
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
              platformFormat: runPlatformFormat,
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
      platformFormat: runPlatformFormat
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
        // Media existence, not run creation — see the note at the sibling
        // call in expandDeterministicVideo. Reading enqueued.hero here left
        // catalogMedias empty and lost the operator's pick.
        const heroMediaId = out?.heroMediaId || out?.enqueued?.hero?.mediaId;
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
function computeV2IdentityDigest({
  campaignId, productId, conceptId, platformFormat, kind,
  ctaText, ctaUrl, ctaUrlParams, generationRunId,
  // Duration is identity for VIDEO only (static ignores it). Existing
  // rows keep their stored digests; the (campaignId, identityDigest)
  // unique index only bites on same-campaign re-runs, where a changed
  // duration SHOULD mint a new ad rather than collide with a shorter/
  // longer prior master and skip a billable (or free-derive) render.
  videoDurationSec
}) {
  const isVideo = String(kind || 'image') === 'video';
  const parts = [
    String(campaignId),
    productId ? String(productId) : 'NULL',
    // Run-scoped for STATIC, so a second Generate produces a second set of ads
    // instead of colliding with the first on the (campaignId, identityDigest)
    // unique index. Owner: "there should be no limitation on creating new ads
    // that may be duplicates since generative ads always have new seeds."
    //
    // conceptId ALONE could never carry that, and the comment further down this
    // file claiming fresh concept_ids make collisions "rare" is wrong:
    // aiCreativeDirectorService asks the model for a "short slug (must be unique
    // within this round)", so slugs like cd_quote_lead recur across rounds by
    // design. That reuse is exactly what made two Generates in a row produce
    // nothing on 2026-08-01.
    //
    // Video is excluded — "veo should only generate a video once for each
    // product unless it is revised" — so a video digest stays run-independent
    // and a repeat Generate cannot re-bill a Veo master.
    (generationRunId && !isVideo) ? String(generationRunId) : '',
    String(conceptId || ''),
    String(platformFormat || ''),
    String(kind || 'image'),                       // kind distinguishes image vs video variants of the same concept
    String(ctaText || ''),
    String(ctaUrl  || ''),
    String(ctaUrlParams || '')
  ];
  // Duration slot for GOOGLE PMAX VIDEO ONLY — same money rule as
  // computeDeterministicVideoDigest (read the note there before widening
  // this). Concept-video rows already exist for Meta formats, and their
  // digests are likewise the only guard against a re-billed Omni master,
  // so Meta and static identities must stay byte-identical.
  if (isVideo && isGooglePmaxVideoFormat(platformFormat)) {
    parts.push(videoDurationSec == null || videoDurationSec === ''
      ? ''
      : String(videoDurationSec));
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// Deterministic-video identity. Namespaced with 'det-video:v1' so it
// cannot collide with V1 (JSON hash) or V2 (pipe-joined, no prefix)
// digests. referenceMediaIds order is load-bearing — a different pick
// order is a different ad. When referenceMediaIds is empty the seed
// mediaId alone stands in (hero default path). platformFormat is
// load-bearing too: Google queues two masters (9:16 + 16:9) plus a
// derive-only 1:1; each needs a distinct digest on the unique index.
//
// ⚠️ MONEY — WHY DURATION IS SCOPED TO GOOGLE FORMATS AND THE PREFIX IS
// STILL v1. The `(campaignId, identityDigest)` unique index is the ONLY
// thing stopping a repeat Generate from re-billing an Omni master
// (`computeDeterministicVideoDigest` deliberately omits generationRunId —
// see CLAUDE.md §2 "The index protects video, not this gate"). ANY change
// to the digest inputs for an EXISTING format changes every stored Meta
// digest, so the next Generate on any existing campaign stops colliding,
// mints a fresh ad per product and pays Omni again (~$1.00–1.20 each).
// Measured during Phase A: appending an unconditional duration slot (and
// bumping the prefix to v2) changed the Meta digest for the ordinary
// duration-unset case. So the duration part is appended ONLY for the
// Google PMax video formats, which have zero history and therefore cannot
// collide with anything. Meta digests stay byte-identical to pre-Phase-A.
// If the Meta 8s→10s standardization later wants duration identity there
// too, that is a deliberate one-time re-mint and must be costed and
// flagged explicitly — do not fold it in silently here.
function computeDeterministicVideoDigest({
  campaignId, productId, referenceMediaIds, mediaId,
  platformFormat, ctaText, ctaUrl, ctaUrlParams,
  videoPromptGuidance, videoPromptRaw,
  videoDurationSec,
  // Funnel-stage retitle only. ONLY appended when non-empty so master /
  // derive-only digests (and every Meta digest) stay byte-identical to
  // pre-funnel-variant code. Three variants of the same surface MUST
  // carry distinct stages or the unique index collapses them to one.
  funnelStage = null
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
  // Duration joins the key for GOOGLE PMAX VIDEO FORMATS ONLY (see the
  // money note above). Those surfaces are new in Phase A, so adding a part
  // cannot change any stored digest; every pre-existing format keeps the
  // exact pre-Phase-A part list and therefore the exact same hash.
  if (isGooglePmaxVideoFormat(platformFormat)) {
    parts.push(videoDurationSec == null || videoDurationSec === ''
      ? ''
      : String(videoDurationSec));
  }
  // Funnel stage joins ONLY for Google PMax video formats, and only when
  // present. A master / base 1:1 (no stage) keeps the exact pre-funnel part
  // list, so an empty string is never pushed — that alone would shift every
  // existing Google digest and re-mint.
  //
  // ⚠️ THE FORMAT SCOPE IS THE MONEY GUARD, not decoration. Without it, ANY
  // ad carrying a funnelStage hashes differently — and the Director already
  // emits `routing.funnel_stage` on PMax rounds, so the field is one wiring
  // change away from reaching a Meta video ad. The moment it did, every
  // stored Meta digest would stop matching, the (campaignId, identityDigest)
  // unique index would stop colliding, and the next Generate would re-bill an
  // Omni master for every product on the campaign. Same failure this function
  // already survived once with videoDurationSec above; scoped identically.
  if (isGooglePmaxVideoFormat(platformFormat)
      && funnelStage != null && String(funnelStage) !== '') {
    parts.push(String(funnelStage));
  }
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

// Look up product titles for the UI. Scoped to brandId so a run payload
// cannot carry another advertiser's product names even if an id leaked
// into the expansion. Never throws — reporting must not fail generation.
async function attachProductNames(perProduct, brandId) {
  if (!Array.isArray(perProduct) || !perProduct.length) return perProduct || [];
  try {
    const ids = [...new Set(
      perProduct
        .map(r => (r && r.productId != null ? String(r.productId) : null))
        .filter(Boolean)
    )];
    if (!ids.length) return normalizePerProductList(perProduct);
    const oids = ids.map(toObjectId).filter(Boolean);
    if (!oids.length) return normalizePerProductList(perProduct);
    const filter = { _id: { $in: oids } };
    // brandId is the tenant scope for CatalogProduct rows.
    if (brandId && mongoose.isValidObjectId(brandId)) {
      filter.brandId = toObjectId(brandId);
    }
    const docs = await CatalogProduct.find(filter).select('title').lean();
    const nameById = {};
    for (const d of docs) {
      if (d && d._id && d.title) nameById[String(d._id)] = String(d.title);
    }
    return normalizePerProductList(perProduct, nameById);
  } catch (err) {
    console.warn(`   ⚠️  attachProductNames failed (continuing without names): ${err.message}`);
    return normalizePerProductList(perProduct);
  }
}

// VIDEO SEED = THE FIRST CATALOG IMAGE IN FEED ORDER. Never the 'hero' stamp.
//
// Owner, 2026-08-03: *"the default video behaviour should be the first three
// images, not the 'hero' image, especially since we don't know how that is
// determined."*
//
// The stamp was NOT a reliable stand-in for "the feed's first image":
// `metadata.imageRole:'hero'` is written by catalogProductDetectService off
// `CatalogProduct.imageUrl`, so it depends on that materialisation having
// happened and having succeeded. When the stamp is missing the old cascade fell
// through to earliest-createdAt anyway, which means the SAME product could seed
// from a different image depending on whether an ingest step ran — exactly the
// opacity the owner is objecting to. Dropping the tier makes the rule one thing:
// earliest-createdAt catalog Media, which is the order ingest materialises the
// feed in (imageUrl first, then additionalImages).
//
// This only decides POSITION 0. The reference stack was already feed-ordered
// (`.sort({createdAt: 1})` in atlasVideoService's catalogMedias load, no
// hero-first ranking), so seed + mirrors now give "the first three images" with
// no further change.
//
// MONEY: this changes WHICH image seeds the video, never how many submits
// happen — still one Omni submit per product (CLAUDE.md §2).
//
// KILL SWITCH: VIDEO_SEED_FEED_ORDER, DEFAULT ON. It changes what a billable
// generation is seeded with, so it must be reversible without a deploy.
// SUPERSEDED as the primary switch by CATALOG_FEED_ORDER_SEEDING below —
// this one only still matters when that new switch is turned off.
function isVideoSeedFeedOrderEnabled() {
  const raw = process.env.VIDEO_SEED_FEED_ORDER;
  if (raw == null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// KILL SWITCH: CATALOG_FEED_ORDER_SEEDING, DEFAULT ON. Owner directive
// 2026-08-05: the video seed (and the static default seed, see
// seededUniverseService.promoteFirstCatalogImage) should be the merchant
// feed's actual image order — primary first, then additionalImages in feed
// order — not a stamp, a shot-type rank, or createdAt. OFF restores the
// pre-2026-08-05 cascade below byte-for-byte, including VIDEO_SEED_FEED_ORDER
// and the subject-dominance guard.
function isCatalogFeedOrderSeedingEnabled() {
  const raw = process.env.CATALOG_FEED_ORDER_SEEDING;
  if (raw == null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// KILL SWITCH: VIDEO_OPERATOR_STACK_ONLY, DEFAULT ON. Owner directive
// 2026-08-05: when the operator picks non-catalog images for deterministic
// video, do NOT silently append a catalog anchor they never chose — signal
// them instead and generate from their selection only. OFF restores the
// pre-change append behaviour byte-for-byte.
// MONEY: computeDeterministicVideoDigest hashes referenceMediaIds
// (order-significant). Dropping the append CHANGES the digest for stacks
// that previously got one — a re-Generate with the same non-catalog picks
// will NOT collide with the old [...picks, anchor] ad; it mints a NEW ad
// and can bill once more. Does NOT double-bill within a single expansion
// (still one payload per product). Identical post-change stacks still
// dedupe normally. Correct: a different stack IS a different creative.
function isVideoOperatorStackOnlyEnabled() {
  const raw = process.env.VIDEO_OPERATOR_STACK_ONLY;
  if (raw == null || raw === '') return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

/**
 * The product's first catalog image in feed order.
 *
 * With CATALOG_FEED_ORDER_SEEDING on (default): the merchant feed's primary
 * image, unconditionally — no shot-type rank, no createdAt tiebreak, no
 * subject-dominance guard. Owner, 2026-08-05: "the primary image as defined
 * by the merchant feed is the main image that should be used for ... video
 * ... The Hero stamp is not relevant."
 *
 * Two tiers, both naming the same image: CatalogProduct.imageMediaId (the
 * live pointer) then metadata.feedIndex===0 (the ingest stamp). See the
 * inline comments for why the pointer is checked FIRST — a stale stamp
 * outranking it would seed a billable render from a retired product photo.
 * Returns null only when neither exists, which is also the only case the
 * caller's lazy-materialize path can recover (enqueueProductDetect
 * early-returns whenever imageMediaId is already set).
 *
 * With the flag OFF, the pre-2026-08-05 cascade below runs unchanged: with
 * VIDEO_SEED_FEED_ORDER ON this is purely earliest-createdAt plus the
 * subject-dominance guard; with it OFF the historical hero-stamp-first
 * cascade is restored verbatim.
 */
/**
 * Skip a first image whose subject fills the frame, because the product cannot
 * survive the crop.
 *
 * Owner: *"I just don't want text directly on the face, and I don't want it to
 * zoom so close into a face that I can't see the actual product."*
 *
 * WHY THE SEED AND NOT THE CROP: measured on the ad that prompted this — the
 * master's face envelope spanned 0.035→0.558 of a 1080x1920 frame, i.e. a head
 * 1,004px tall. A 1:1 delivery crops a 1080px window, so NO crop offset can hold
 * that head and still leave room for the garment or a title band. faceSafeCrop
 * already pushes the head as high as its margins allow (that is what
 * FACE_TOP_MARGIN_FRAC is for) and it had nothing left to give. The only lever
 * that changes the outcome is which image Omni animates.
 *
 * SIGNAL, and it costs nothing: adSuitabilityService already derives
 * `metrics.primarySubjectAreaFraction` from the overlay-zone geometry and stores
 * it on every Media. No vision call, no ingest change.
 *
 * THRESHOLD: measured across 600 catalog images — median 0.57, p90 0.87. The
 * failing seed measured 0.65, which the STATIC scorer rates as *positive*
 * (its good band is 0.10–0.65, because a big subject flatters a still). Video
 * that gets cropped needs its own line, so this does not touch that scoring.
 *
 * FEED ORDER IS PRESERVED: candidates stay in createdAt order and the FIRST
 * acceptable one wins — this only skips past images that would bury the product.
 * If every candidate is subject-dominant it returns the first anyway, so a
 * product can never lose its video for want of a wider photo.
 */
const VIDEO_SEED_MAX_SUBJECT_FRACTION = (() => {
  const n = Number(process.env.VIDEO_SEED_MAX_SUBJECT_FRACTION);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.6;
})();

async function firstCatalogMediaForProduct(productOid) {
  if (isCatalogFeedOrderSeedingEnabled()) {
    // Merchant feed's primary image, unconditional — no shot-type rank, no
    // subject-dominance guard, no exceptions (owner directive 2026-08-05).
    // A tie (should not happen — feedIndex:0 is meant to be unique per
    // product) breaks on earliest createdAt for determinism.
    // TIER 1 — CatalogProduct.imageMediaId. This is the LIVE pointer to the
    // merchant feed's primary image, rewritten by catalogProductDetectService
    // every time the product is (re-)detected (`:97`).
    //
    // IT IS DELIBERATELY CHECKED BEFORE THE feedIndex STAMP, and the order
    // matters for money. metadata.feedIndex is a DENORMALISED stamp on the
    // Media doc; nothing clears it when a merchant changes their primary
    // image. Re-detect (operator clears imageMediaId) materialises a NEW
    // Media under a new externalId — so the retired image keeps its
    // feedIndex:0 and a stamp-first cascade would seed a billable Omni
    // render from a product photo the merchant has REPLACED. imageMediaId
    // cannot go stale that way: it is a single pointer that is overwritten,
    // not accumulated. Found in adversarial review before deploy.
    //
    // Scoped to source + this product (not just _id) so a corrupted or
    // hand-edited imageMediaId cannot pull in another product's media, and
    // fileType-guarded so it can never hand a VIDEO to an image-to-video
    // seed slot.
    const product = await CatalogProduct.findById(productOid)
      .select('imageMediaId')
      .lean();
    if (product?.imageMediaId) {
      const primary = await Media.findOne({
        _id: product.imageMediaId,
        source: 'catalog-product',
        'metadata.catalogProductId': productOid,
        fileType: { $ne: 'video' }
      })
        .select('_id')
        .lean();
      if (primary) return primary;
    }

    // TIER 2 — the ingest-time feedIndex stamp. Reached when imageMediaId is
    // unset (non-primary variant, or a product whose detect never completed)
    // or points at something unusable. A tie breaks on earliest createdAt
    // for determinism; feedIndex:0 is meant to be unique per product, so a
    // tie already means a stale duplicate is present.
    return await Media.findOne({
      source: 'catalog-product',
      'metadata.catalogProductId': productOid,
      'metadata.feedIndex': 0,
      fileType: { $ne: 'video' }
    })
      .sort({ createdAt: 1 })
      .select('_id')
      .lean();
  }

  if (!isVideoSeedFeedOrderEnabled()) {
    const stamped = await Media.findOne({
      source: 'catalog-product',
      'metadata.catalogProductId': productOid,
      'metadata.imageRole': 'hero'
    }).select('_id').lean();
    if (stamped) return stamped;
  }

  // Feed order, with the suitability metric alongside so the guard needs no
  // second query. Bounded: a product's catalog set is small.
  // NO limit(): a cap here is a silent wrong-seed generator. With limit(24), a
  // product whose first 24 images are all subject-dominant and whose 25th is the
  // wide shot would never load the wide shot and would keep the dominant image —
  // the exact failure this guard exists to prevent, hidden behind a number.
  // Catalog sets are small and this selects two fields.
  //
  // fileType EXCLUDES VIDEO. Unmeasured media counts as acceptable, and a catalog
  // VIDEO carries no adSuitability, so without this filter skipping a dominant
  // still could land on a video and silently switch Omni to its image-to-video
  // seed track. The regenerate path already guards this; this helper did not.
  const candidates = await Media.find({
    source: 'catalog-product',
    'metadata.catalogProductId': productOid,
    fileType: { $ne: 'video' }
  })
    .sort({ createdAt: 1 })
    .select('_id adSuitability.metrics.primarySubjectAreaFraction')
    .lean();

  if (!candidates.length) return null;

  const fractionOf = (m) => {
    const v = m?.adSuitability?.metrics?.primarySubjectAreaFraction;
    return Number.isFinite(v) ? v : null;
  };
  // Unmeasured media is treated as ACCEPTABLE, not rejected — absent data must
  // never reorder the feed.
  const acceptable = candidates.find((m) => {
    const f = fractionOf(m);
    return f == null || f <= VIDEO_SEED_MAX_SUBJECT_FRACTION;
  });

  if (acceptable && String(acceptable._id) !== String(candidates[0]._id)) {
    console.log(
      `🎬 videoSeed: skipped ${candidates[0]._id} (primary subject ` +
      `${(fractionOf(candidates[0]) ?? 0).toFixed(2)} of frame > ${VIDEO_SEED_MAX_SUBJECT_FRACTION}) ` +
      `-> ${acceptable._id} (${(fractionOf(acceptable) ?? 0).toFixed(2)}); product would not survive the crop`
    );
  } else if (!acceptable) {
    console.log(
      `🎬 videoSeed: every catalog image for ${productOid} is subject-dominant ` +
      `(first ${(fractionOf(candidates[0]) ?? 0).toFixed(2)}) — keeping feed order`
    );
  }
  return acceptable || candidates[0];
}

// Deterministic video expansion: one video Ad per product *per call*,
// seeded on operator-ordered catalog picks (or the first catalog image
// in feed order when there are no picks).
//
// expandWizardJob calls this ONCE PER MASTER format (and once more for
// the Google derive-only 1:1). Meta still ends up with one call (one
// master) — see resolveDeterministicVideoMasterFormats.
// seedMediaIds is ORDER-SIGNIFICANT. No VEO_ADS_PER_PRODUCT_CAP — always
// exactly one ad per product that has a resolvable seed, per format call.
//
// @param {string|null} [deriveFromMaster]  when set, this Ad is a free
//   crop/retitle of that master platformFormat (no Omni submit). Stamped
//   onto DERIVE_FROM_MASTER_FIELD. Render path also keys on
//   platformFormat === PMAX_VIDEO_DERIVE_ONLY and on funnelStage set.
// @param {string|null} [funnelStage]  awareness|consideration|conversion
//   for free funnel-titled variants. Joins the identity digest ONLY when
//   set so master digests stay byte-identical.
async function expandDeterministicVideo({
  campaignId, brandId, campaignKind, productIds,
  seedMediaIds = [],
  seedPicks = null,
  ctaText, ctaUrl, ctaUrlParams,
  platformFormat,
  videoDurationSec,
  videoPromptGuidance = null,
  videoPromptRaw = null,
  excludePairings = [],
  deriveFromMaster = null,
  funnelStage = null
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
  // Pin duration for Google formats when unset (PMax floor). Caller may
  // already have resolved this; re-resolve is idempotent.
  const effectiveDurationSec = resolveVideoDurationForFormat(
    platformFormat, videoDurationSec
  );
  // Derive-only marker value. Prefer explicit arg; fall back when the
  // format itself is the known derive-only surface. Funnel-stage ads of
  // a master format also derive from that same format (retitle only).
  const normalizedFunnelStage = (funnelStage && PMAX_FUNNEL_STAGE_SET.has(String(funnelStage)))
    ? String(funnelStage)
    : null;
  const deriveFrom = deriveFromMaster
    || (platformFormat === PMAX_VIDEO_DERIVE_ONLY ? PMAX_VIDEO_DERIVE_SOURCE : null)
    || (normalizedFunnelStage && GOOGLE_VIDEO_MASTER_SET.has(platformFormat)
      ? platformFormat
      : null);
  const payloads = [];
  const perProduct = [];

  for (const productId of productIds) {
    const pidStr = String(productId);
    const productOid = toObjectId(productId);
    if (!productOid) {
      perProduct.push({ productId: pidStr, skipped: PER_PRODUCT_REASON.INVALID_PRODUCT_ID });
      continue;
    }

    let mediaId = null;
    let referenceMediaIds = [];
    // Non-skip advisory for the success perProduct row (WARNING enum). Never
    // a skip reason — the product still queues.
    let productWarning = null;
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
      // Pre-2026-08-05 behaviour (VIDEO_OPERATOR_STACK_ONLY off): if none of
      // the picks is a catalog mirror for this product, append the catalog
      // hero after them — position 0 stays theirs, model still gets a product
      // anchor. Owner 2026-08-05, verbatim: "let's also address the extra
      // image being appended, if it doesn't have a catalog image just signal
      // the user there is no catalog image and if they choose to override
      // that is at their discretion." Flag ON (default): NEVER append;
      // referenceMediaIds stays exactly picks.slice(). Still probe
      // firstCatalogMediaForProduct — but ONLY to decide WHICH warning to
      // emit, never to mutate the stack. Product STILL QUEUES.
      //
      // MONEY: computeDeterministicVideoDigest hashes referenceMediaIds
      // (order-significant). Dropping the append CHANGES the digest for any
      // stack that previously got one — a re-Generate with the same non-
      // catalog picks will NOT collide with the old [...picks, anchor] ad;
      // it mints a NEW ad and can bill once more. Does NOT double-bill
      // within a single expansion (still one payload per product). Identical
      // post-change stacks still dedupe normally. Correct: different stack
      // IS a different creative — do not try to "fix" the digest shift.
      const hasCatalogAnchor = picks.some(id => {
        const doc = seedById.get(String(id));
        const direct = doc?.metadata?.catalogProductId;
        return direct != null && String(direct) === pidStr;
      });
      if (!hasCatalogAnchor) {
        // Same feed-order rule as the default seed — the anchor is the product's
        // first catalog image, not whatever carries the 'hero' stamp.
        const anchor = await firstCatalogMediaForProduct(productOid);
        if (isVideoOperatorStackOnlyEnabled()) {
          // Flag ON: stack stays exactly the operator's picks. Probe was only
          // for the warning code. Do not skip the product.
          if (anchor?._id) {
            productWarning = PER_PRODUCT_WARNING.NO_CATALOG_IN_PICKS;
            console.log(
              `📦 expandDeterministicVideo[${pidStr}]: picks are all non-catalog — ` +
              `catalog image ${anchor._id} exists but was NOT appended ` +
              `(VIDEO_OPERATOR_STACK_ONLY); stack stays ${picks.length} operator pick(s)`
            );
          } else {
            productWarning = PER_PRODUCT_WARNING.NO_CATALOG_IMAGE;
            console.warn(
              `📦 expandDeterministicVideo[${pidStr}]: picks are all non-catalog and no ` +
              `catalog Media exists — stack NOT modified; shipping operator picks only ` +
              `(VIDEO_OPERATOR_STACK_ONLY)`
            );
          }
        } else if (anchor?._id && !referenceMediaIds.some(x => String(x) === String(anchor._id))) {
          // Flag OFF: byte-identical pre-change append behaviour.
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
      // FEED ORDER: the product's first catalog image → lazy materialize.
      // The 'hero'-stamp tier was removed at owner instruction — see
      // firstCatalogMediaForProduct.
      let hero = await firstCatalogMediaForProduct(productOid);

      if (!hero) {
        // Lazy materialize — same pattern as seedsFromProduct ~:1133-1155.
        try {
          const fullProduct = await CatalogProduct.findById(productOid)
            .select('_id brandId advertiserId imageUrl additionalImages imageMediaId')
            .lean();
          if (fullProduct?.imageUrl) {
            const detectSvc = require('./catalogProductDetectService');
            const out = await detectSvc.enqueueProductDetect(fullProduct);
            // `heroMediaId` is media EXISTENCE; `enqueued.hero` additionally
            // requires that a DetectRun was created. Reading only the latter
            // discarded a perfectly good Media whenever run creation returned
            // null, and this product then fell through to NO_HERO_MEDIA — a
            // silently dropped video ad. Keep the old field as the fallback so
            // a caller on an older service build still resolves.
            const heroMediaId = out?.heroMediaId || out?.enqueued?.hero?.mediaId;
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
        perProduct.push({ productId: pidStr, skipped: PER_PRODUCT_REASON.NO_HERO_MEDIA });
        continue;
      }
      mediaId = hero._id;
      referenceMediaIds = []; // render derives hero+alt1+alt2
    }

    // excludePairings on (productId, mediaId) — mirror V2 filterUniverseForProduct.
    const pairKey = `${pidStr}|${String(mediaId)}`;
    if (excludeSet.has(pairKey)) {
      perProduct.push({ productId: pidStr, skipped: PER_PRODUCT_REASON.EXCLUDED_PAIRING, mediaId: String(mediaId) });
      continue;
    }

    const refForMediaIds = referenceMediaIds.length
      ? referenceMediaIds.map(id => new mongoose.Types.ObjectId(String(id)))
      : [new mongoose.Types.ObjectId(String(mediaId))];
    const mediaIdOid = new mongoose.Types.ObjectId(String(mediaId));

    const payload = {
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
      videoDurationSec:    effectiveDurationSec,
      matchTier:           'product_match',
      variantKind:         'product_image',
      paletteSource:       'media',
      rafflePrizeMediaId:  null,
      readinessScore:      null,
      status:              'queued',
      videoPromptGuidance: videoPromptGuidance || null,
      videoPromptRaw:      videoPromptRaw || null,
      // platformFormat differentiates masters + derive-only on the unique
      // index; duration is identity so an 8s→10s re-run mints a new ad;
      // funnelStage (when set) differentiates the 3 free retitles.
      identityDigest: computeDeterministicVideoDigest({
        campaignId,
        productId: pidStr,
        referenceMediaIds,
        mediaId: mediaIdOid,
        platformFormat,
        ctaText, ctaUrl, ctaUrlParams,
        videoPromptGuidance, videoPromptRaw,
        videoDurationSec: effectiveDurationSec,
        funnelStage: normalizedFunnelStage
      }),
      ctaText, ctaUrl, ctaUrlParams,
      queuedAt:    new Date(),
      generatedAt: new Date()
    };
    // Derive-only / funnel-variant marker. MONEY: render path must NEVER
    // Omni-submit when this is set (or when platformFormat ===
    // PMAX_VIDEO_DERIVE_ONLY, or when funnelStage is set — fail-closed).
    if (deriveFrom) {
      payload[DERIVE_FROM_MASTER_FIELD] = deriveFrom;
    }
    if (normalizedFunnelStage) {
      payload[FUNNEL_STAGE_FIELD] = normalizedFunnelStage;
    }
    payloads.push(payload);
    const successRow = {
      productId: pidStr,
      mediaId: String(mediaId),
      referenceMediaIds: referenceMediaIds.map(String),
      platformFormat,
      payloads: 1
    };
    if (deriveFrom) successRow.deriveFromMaster = deriveFrom;
    if (normalizedFunnelStage) successRow.funnelStage = normalizedFunnelStage;
    // Advisory only — product queued. Do NOT stamp as `reason` (that would
    // mark skipped:true and overwrite the "Queued N creative(s)." message).
    if (productWarning) successRow.warning = productWarning;
    perProduct.push(successRow);
  }

  // Normalise before return so routes/CampaignRun never see raw payload
  // objects or skip codes without human messages.
  const perProductNorm = await attachProductNames(perProduct, brandId);

  if (!payloads.length) {
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      queuedCount: await Ad.countDocuments({ campaignId, status: 'queued' }),
      newlyQueued: 0, alreadyQueued: 0, newAdIds: [], total: 0,
      byProduct: {}, perProduct: perProductNorm, byMode: { deterministic: 0 }
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
    `fmt=${platformFormat}${deriveFrom ? ` deriveFrom=${deriveFrom}` : ''} ` +
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
    perProduct: perProductNorm,
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
  // Static surfaces each image concept is emitted for. Defaults to just the
  // requested platformFormat so any caller that doesn't opt in behaves exactly
  // as before. Every entry is a separate billable generation — see
  // staticFanoutForPlatformFormat in services/platformFormats.js for why these
  // cannot be cheap crops of one master any more.
  staticFormats = [],
  kinds,                                            // [] of 'image'|'video' — what pipelines to emit per concept
  includeCategoryMatched, includeBrandMatched,
  excludePairings, creativeIntent,
  videoDurationSec = null,                          // wizard-requested video length (sec); null = standard 8s
  videoPromptGuidance = null,                       // run-level guidance — stamped on video Ad rows
  videoPromptRaw = null,                            // run-level raw override — stamped on video Ad rows
  // The CampaignRun this expansion belongs to. Mixed into the STATIC V2 digest
  // so a repeat Generate makes new ads rather than colliding with the previous
  // run's. Optional: omitting it reproduces the pre-2026-08-01 digest exactly.
  generationRunId = null,
  // UGC-ads Phase 3. Read unconditionally at the buildSeededUniverse call below,
  // so it must be bound here even when no caller supplies it. Default null is
  // byte-identical to the pre-Phase-3 call — buildSeededUniverse coerces it and
  // gates it behind isUgcFirstSeedingEnabled().
  preferUgcMediaId = null
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
      // Universe size. Operator picks, when present, ARE the universe —
      // restrictToMediaIds constrains the pool to exactly what they chose and
      // topN widens to fit, so a 5-image selection is never truncated to 1.
      //
      // Absent picks, the Director sees DIRECTOR_UNIVERSE_TOP_N candidates
      // (default 1). TOP_N=1 is a COUNT, not a choice of image — see
      // preferFirstCatalogImage below. Operator multi-select widens via max().
      const operatorPickedMedia = Array.isArray(mediaIds) && mediaIds.length > 0;
      const universeTopN = operatorPickedMedia
        ? Math.max(mediaIds.length, DIRECTOR_UNIVERSE_TOP_N)
        : DIRECTOR_UNIVERSE_TOP_N;
      const { universe, seedUniverseHash, counts } =
        await seededUniverseSvc.buildSeededUniverse(brandId, productId, {
          includeCategoryMatched, includeBrandMatched,
          topN: universeTopN,
          wantsVideo: resolvedKinds.includes('video'),
          restrictToMediaIds: operatorPickedMedia ? mediaIds : null,
          // Owner rule, 2026-08-03, verbatim: "I actually just want to use
          // the first image that comes from the catalog not the 'hero' image
          // since that may also come from social media or UGC?"
          //
          // DIRECTOR_UNIVERSE_TOP_N=1 does NOT deliver that on its own, which
          // is what every doc in this repo used to claim.
          // buildSeededUniverse ranks catalog media and product_match UGC in
          // ONE merged pool by classification.shotType first (lifestyle →
          // on_model → … → unknown) and only breaks within-tier ties on
          // metadata.imageRole==='hero'. So `.slice(0, 1)` of that ranking
          // routinely returned a lifestyle catalog ALT — or a UGC post — and
          // no catalog image was guaranteed to reach the Director.
          // preferFirstCatalogImage pins the catalog's FIRST image at index 0
          // before the trim, via a cascade that can only ever select
          // role==='catalog' media: imageRole==='hero' (the stamp
          // catalogProductDetectService writes on CatalogProduct.imageUrl),
          // else the earliest-createdAt catalog entry, else nothing. Tier 2
          // is what closes the hole — when the stamp is missing the old
          // tier-1-only rule fell back to the shotType ranking over that
          // merged pool, which is exactly how a UGC post became the default.
          //
          // The !operatorPickedMedia term is redundant with the service-side
          // gate (restrictToMediaIds returns before the promotion runs) and is
          // kept anyway so the override reads at the CALL SITE: an operator
          // multi-select is the "unless the user overrides it" half of the
          // rule, and it still widens the window via
          // universeTopN = Math.max(mediaIds.length, DIRECTOR_UNIVERSE_TOP_N)
          // rather than being re-ordered or truncated to 1.
          //
          // Image-only: the deterministic video rail runs the SAME cascade
          // directly against Mongo (imageRole==='hero' → earliest createdAt →
          // lazy materialize, `:2085`) and builds its own reference stack, so
          // it never needs this. A mixed image+video concept run does opt in —
          // a burned-text catalog image is still promoted there, which is the
          // intended precedence (owner rule over the wantsVideo burned-text
          // tiebreak).
          preferFirstCatalogImage: !operatorPickedMedia && resolvedKinds.includes('image'),
          // UGC-ads Phase 3 — hoists the wizard-picked UGC to seed index 0.
          // Threaded to every product iteration so a multi-product wizard run
          // (Phase 7 batch, or the current Phase 2 wizard with N products
          // attached to one UGC) plants the same UGC across all of them.
          // Kill-switch-gated inside buildSeededUniverse; null / flag OFF is
          // byte-identical to the pre-Phase-3 call.
          preferUgcMediaId
        });
      const filtered = filterUniverseForProduct(productId, universe);
      if (!filtered.length) {
        console.log(`📦 conceptDriven[${productTag}]: empty universe after excludePairings — skipping`);
        return { productId, payloads: [], skipped: PER_PRODUCT_REASON.EMPTY_UNIVERSE };
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
        return { productId, payloads: [], skipped: PER_PRODUCT_REASON.NO_CONCEPTS };
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

      // 4. Map concepts → Ad payloads.
      // Dual-read routing.media_picks (v3) and concept.media_picks (v2) —
      // the producer nests under routing; a flat-only read discarded every
      // concept and produced zero ads after a paid Director round.
      // conceptSkips used to be console-only and could silently reduce a
      // 3-concept expansion to zero creatives with no operator-visible
      // reason. Record every drop; the zero-payload case becomes a real
      // per-product reason + Slack alert below.
      const universeById = new Map(filtered.map(u => [String(u.mediaId), u]));
      const payloads = [];
      const conceptSkips = [];
      for (const concept of concepts) {
        const mp = conceptMediaPicks(concept);
        if (!mp.length) {
          console.warn(`   ⛔ concept ${concept.concept_id}: no media_picks — skipping`);
          conceptSkips.push({
            conceptId: concept.concept_id,
            reason: 'no_media_picks'
          });
          continue;
        }
        const primaryId = String(mp[0].media_id);
        const primaryUniverseEntry = universeById.get(primaryId);
        if (!primaryUniverseEntry) {
          console.warn(`   ⛔ concept ${concept.concept_id}: media_pick[0]="${primaryId}" not in filtered universe — skipping`);
          conceptSkips.push({
            conceptId: concept.concept_id,
            reason: 'media_outside_universe',
            mediaId: primaryId
          });
          continue;
        }
        const mediaIdObjs = mp
          .map(p => p.media_id)
          .filter(id => universeById.has(String(id)))
          .map(id => new mongoose.Types.ObjectId(String(id)));
        if (!mediaIdObjs.length) {
          conceptSkips.push({
            conceptId: concept.concept_id,
            reason: 'media_outside_universe',
            mediaId: primaryId
          });
          continue;
        }

        const score = scoreByConcept.get(concept.concept_id) || {};
        const creativeStyle = conceptField(concept, 'creative_style');
        const template = CREATIVE_STYLE_TO_TEMPLATE[creativeStyle] || 'ai_brand_led';
        const role = primaryUniverseEntry.role;

        // One payload per requested kind — and, for image, per STATIC SURFACE.
        //
        // identityDigest includes both kind and platformFormat, so
        // image+video variants and the three static sizes of one concept all
        // land as distinct rows on the (campaignId, identityDigest) unique
        // index rather than colliding.
        //
        // The Director ran ONCE per product, and the same concepts feed every
        // size. That is deliberate: an advertiser wants one campaign idea
        // delivered in three sizes, not three unrelated ideas. Format
        // correctness lives where it actually matters — the per-surface safe
        // box and geometry block in the image prompt (services/staticAdIntents.js)
        // — so re-running the Director per format would triple its cost
        // (~$0.11/product/round) and buy nothing but drift between sizes.
        for (const kind of resolvedKinds) {
          // Video ships only the operator's chosen format; there is no
          // cheap-crop story for video and no owner request to fan it out.
          const formatsForKind = kind === 'image'
            ? (staticFormats.length ? staticFormats : [platformFormat])
            : [platformFormat];
          for (const fmt of formatsForKind) {
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
              // Per-FORMAT, not per-run: these three lines are the whole point
              // of the fan-out. aspectRatio drives the delivery crop and
              // platformFormat drives the safe box the model typesets inside,
              // so both must describe `fmt` and not the format the operator
              // happened to click.
              aspectRatio:       aspectRatioForPlatformFormat(fmt) || '1:1',
              campaignKind,
              platformFormat:    fmt,
              videoDurationSec:  kind === 'video' ? (videoDurationSec || null) : null,
              videoPromptGuidance: kind === 'video' ? (videoPromptGuidance || null) : null,
              videoPromptRaw:      kind === 'video' ? (videoPromptRaw || null) : null,
              matchTier:         matchTierForUniverseRole(role),
              variantKind:       variantKindForUniverseRole(role),
              paletteSource:     'media',
              rafflePrizeMediaId: null,
              readinessScore:    score.judgeScore ?? null,
              status:            'queued',
              // fmt (not platformFormat) is what keeps the three sizes of one
              // concept from colliding on the unique index — passing the run's
              // format here would silently collapse the fan-out to one ad.
              identityDigest:    computeV2IdentityDigest({
                campaignId, productId,
                conceptId: concept.concept_id,
                platformFormat: fmt,
                kind,
                ctaText, ctaUrl, ctaUrlParams,
                // Dropped for video inside computeV2IdentityDigest.
                generationRunId,
                // Duration is identity for video only (see digest fn).
                videoDurationSec: kind === 'video' ? (videoDurationSec || null) : null
              }),
              ctaText, ctaUrl, ctaUrlParams,
              queuedAt:          new Date(),
              generatedAt:       new Date()
            });
          }
        }
      }

      console.log(
        `📦 conceptDriven[${productTag}]: round=${roundIndex} ` +
        `universe=${filtered.length} (catalog=${counts.catalog || (counts.catalog_hero + counts.catalog_alt)} ` +
        `ugc=${counts.ugc_product_match + counts.ugc_product_category + counts.ugc_brand_match}) ` +
        `concepts=${concepts.length} payloads=${payloads.length} ` +
        `conceptSkips=${conceptSkips.length} ` +
        `dirWarnings=${dirWarnings.length} judge=${judgeArtifactId ? 'ok' : 'skipped'}`
      );

      // Concepts returned but every one was discarded (missing picks or
      // picks outside the universe). Distinct from NO_CONCEPTS — the
      // Director was paid and produced output that was thrown away.
      // That must never be console-only again: surface a real reason AND
      // fire a Slack error so the pathological case is operationally visible.
      if (!payloads.length && concepts.length > 0) {
        const skipSummary = conceptSkips
          .slice(0, 10)
          .map(s => `${s.conceptId || '?'}:${s.reason || '?'}`)
          .join(', ');
        try {
          alertService.error(
            'Director concepts discarded — zero payloads',
            {
              detail:
                `product=${productId} concepts=${concepts.length} payloads=0 ` +
                `conceptSkips=${conceptSkips.length}` +
                (skipSummary ? ` [${skipSummary}]` : ''),
              fields: {
                productId:    String(productId),
                concepts:     String(concepts.length),
                payloads:     '0',
                conceptSkips: String(conceptSkips.length),
                reason:       PER_PRODUCT_REASON.CONCEPTS_NO_USABLE_MEDIA
              },
              key: `director-zero-payloads:${productId}`
            }
          );
        } catch (_) { /* alert path must never throw into expansion */ }

        return {
          productId,
          payloads: [],
          skipped: PER_PRODUCT_REASON.CONCEPTS_NO_USABLE_MEDIA,
          conceptCount: concepts.length,
          conceptSkips,
          roundIndex,
          conceptArtifactId: String(artifact._id),
          judgeArtifactId:   judgeArtifactId ? String(judgeArtifactId) : null,
          batchRationale
        };
      }

      return {
        productId, payloads,
        conceptCount: concepts.length,
        conceptSkips,
        roundIndex,
        conceptArtifactId: String(artifact._id),
        judgeArtifactId:   judgeArtifactId ? String(judgeArtifactId) : null,
        batchRationale
      };
    } catch (err) {
      // Carry the error CLASS as well as the message. A ReferenceError thrown
      // inside the Director used to arrive at the operator as "Nothing to
      // render", because the route could not distinguish a thrown product from
      // an empty selection — see the errorEntries branch in routes/ads.js.
      //
      // Still return rather than rethrow: one product blowing up must not abort
      // the siblings mid-Promise.all, which would change who gets billed.
      console.error(`📦 conceptDriven[${productTag}]: failed (${err.message})`);
      return {
        productId,
        payloads: [],
        skipped: PER_PRODUCT_REASON.ERROR,
        error: err && err.message ? err.message : String(err),
        errorName: (err && err.constructor && err.constructor.name) || 'Error'
      };
    }
  }));

  // Per-(product, kind, PLATFORM FORMAT) caps. Video is expensive
  // (~$1.75/Veo call) so it caps at VEO_ADS_PER_PRODUCT_CAP (1); image uses
  // ADS_PER_PRODUCT_CAP (3). Judge already ranked concepts (judgeRank=1=best);
  // sort ascending and take the top N within each bucket.
  //
  // FORMAT IS PART OF THE BUCKET KEY, and that is load-bearing. It used to
  // bucket by kind alone, which was correct only while one run produced one
  // format. With the static fan-out on, one concept emits three image payloads
  // (1:1, 4:5, Stories) — so a kind-only bucket made the three SIZES of one
  // concept compete for the same 3 slots as the other concepts. 3 concepts x 3
  // formats = 9 payloads sliced to 3, and because the loop is concept-major the
  // survivors were all one concept: the operator paid the Director for three
  // concepts and got the sizes of the top-ranked one, with concepts 2 and 3
  // silently discarded. Caught by adversarial review, confirmed by simulation
  // before this fix.
  //
  // Keyed by format, the cap means what it reads like: up to N concepts PER
  // SIZE. Behaviour with fan-out off is unchanged — every payload of a kind
  // shares one format, so there is exactly one bucket, exactly as before.
  //
  // Cap discards used to be console-only. Fold them into perProduct so the
  // operator can see why a lower-ranked concept never queued. Behaviour of
  // the slice itself is unchanged.
  const CAP_BY_KIND = { video: VEO_ADS_PER_PRODUCT_CAP, image: ADS_PER_PRODUCT_CAP };
  const payloads = [];
  const perProductAfterCap = perProductResults.map(r => {
    if (!r.payloads || !r.payloads.length) {
      return r;
    }
    const byBucket = new Map();
    for (const p of r.payloads) {
      const k = p.kind || 'image';
      const bucket = `${k}|${p.platformFormat || ''}`;
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push(p);
    }
    const kept = [];
    const capped = [];
    const payloadsBeforeCap = r.payloads.length;
    for (const [bucket, list] of byBucket.entries()) {
      const [kind, fmt] = bucket.split('|');
      const cap = CAP_BY_KIND[kind] ?? Infinity;
      const sorted = list.slice().sort((a, b) => (a.judgeRank ?? 999) - (b.judgeRank ?? 999));
      const slice  = isFinite(cap) ? sorted.slice(0, cap) : sorted;
      if (slice.length < list.length) {
        const tag = r.productId ? `product=${r.productId}` : 'brand-only';
        console.log(`📦 conceptDriven[${tag}]: capped ${list.length} → ${slice.length} ${kind} payload(s) for ${fmt} (cap=${cap})`);
        capped.push({
          kind,
          format: fmt,
          before: list.length,
          after: slice.length,
          dropped: list.length - slice.length
        });
      }
      kept.push(...slice);
    }
    payloads.push(...kept);
    return {
      ...r,
      payloads: kept,
      payloadsBeforeCap,
      capped: capped.length ? capped : undefined
    };
  });
  // Prefer post-cap rows for the returned perProduct (counts match what
  // actually queued). Names attached below — never throws.
  let perProductFinal;
  try {
    perProductFinal = await attachProductNames(perProductAfterCap, brandId);
  } catch (_) {
    perProductFinal = normalizePerProductList(perProductAfterCap);
  }

  if (!payloads.length) {
    return {
      campaignId: String(campaignId), brandId, campaignKind,
      queuedCount: await Ad.countDocuments({ campaignId, status: 'queued' }),
      newlyQueued: 0, alreadyQueued: 0, newAdIds: [], total: 0, byProduct: {},
      conceptDriven: true,
      perProduct: perProductFinal,
      byMode: { director: 0 }
    };
  }

  // Bulk insert — ordered: false swallows dup-key per (campaignId,
  // identityDigest) so one expansion cannot double-queue the same concept.
  //
  // This used to claim "each Generate press creates a NEW round with NEW
  // concept_ids, so dup-key only hits ... (rare)". That was false, and it is
  // why static generation silently produced nothing. aiCreativeDirectorService
  // asks the model for a "short slug (must be unique within this round)" — so
  // slugs like cd_quote_lead recur across rounds BY DESIGN, and a second
  // Generate collided on essentially every concept. Three runs on 2026-08-01
  // ended done/total:0 for exactly this reason. The V2 digest is now scoped to
  // the CampaignRun for static, so cross-run collision no longer happens and
  // dup-key here is once again what the comment always said it was: a
  // within-expansion safety net.
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
    perProduct: perProductFinal,
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
  attachProductNames,
  SUPPORTED_TEMPLATES,
  // Exposed so picker endpoints can apply the same content-nature
  // gate the seed expansion uses — otherwise the picker shows posts
  // that would be silently dropped at expansion time.
  isMediaEligibleByContentNature,
  // Offline harness + routes re-use the pure reason helpers.
  summarizeEmptyExpansion,
  PER_PRODUCT_REASON,
  // Exported for scripts/verifyCatalogFeedOrderSeeding.js (offline, mocked
  // Media model — see that harness for how it stubs Media.findOne).
  firstCatalogMediaForProduct,
  isCatalogFeedOrderSeedingEnabled,
  isVideoOperatorStackOnlyEnabled,
  isVideoSeedFeedOrderEnabled,
  // Google PMax multi-master / derive-only helpers (Phase A) — harnesses +
  // routes/ads.js derive path share these constants.
  GOOGLE_VIDEO_MASTERS,
  PMAX_VIDEO_DERIVE_ONLY,
  PMAX_VIDEO_DERIVE_SOURCE,
  DERIVE_FROM_MASTER_FIELD,
  FUNNEL_STAGE_FIELD,
  PMAX_FUNNEL_STAGES,
  GOOGLE_PMAX_VIDEO_DURATION_SEC,
  resolveDeterministicVideoMasterFormats,
  resolveVideoDurationForFormat,
  isGoogleVideoMasterRun,
  isPmaxFunnelVariantsEnabled,
  resolveFunnelPresetOverride,
  // THE shared derive-only gate — every path that can reach a billable
  // video submit imports this one (render loop + regenerate). See its
  // doc comment: a per-caller copy is how the regenerate hole opened.
  // Also covers funnel-variant ads (fail-closed on funnelStage).
  resolveDeriveFromMaster
};
