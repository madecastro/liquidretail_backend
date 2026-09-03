// Video reference prewarm — wizard-triggered 9:16 reframe warm for catalog products.
//
// When the wizard has video format + products selected (before the paid
// /generate run), the SPA POSTs /api/ads/video-ref-prewarm. This service
// walks the SAME seed → catalogMedias → resolveModelAndAspect →
// buildReferenceImages path that generateForAd uses for META_VIDEO_MASTER
// (meta_stories_9_16), so reframes land in the persistent cache and the
// later run hits cache instead of waiting cold outpaints (~5 min).
//
// MONEY INVARIANTS:
//   - The ONLY billable work reachable from here is the reframe ladder
//     inside buildReferenceImages → reframeReferenceForAspect (cache +
//     claim already guard double-spend). No master submit, no detect
//     enqueue, no image generation, no new axios POST in this file.
//   - Do NOT wrap buildReferenceImages in retries.
//   - Do NOT lazy-materialize catalog media (detect is billable vision).
//   - Foreign productIds must never warm another tenant's images.
//
// Products are processed SEQUENTIALLY on purpose: buildReferenceImages
// already Promise.all's up to ~3 reframes, and the outpaint tier serializes
// upstream. Parallel products would only raise memory + submit pressure.
//
// KNOWN LIMITS (measured / by design — do not "fix" without reading these):
//   - Warms the FEED-ORDER HERO stack only. A run whose Ad carries explicit
//     referenceMediaIds (operator seed picks) takes buildReferenceImages'
//     ordered path and may still cold-reframe a lifestyle primary we never
//     warmed. Prewarm then helped only the catalog anchor. Accepting seedPicks
//     here would close that gap.
//   - No-op for products with only CatalogProduct.imageUrl and no
//     catalog-product Media yet: materializing one means enqueueProductDetect,
//     which is billable vision work, and prewarm must not spend outside the
//     reframe ladder. Those products cold-reframe on the run as before.
//   - Non-Omni model overrides / SQUARE_VIA_OMNI_CROP=false can resolve a
//     non-9:16 render aspect, which this 9:16 warm would miss.

'use strict';

const Media          = require('../models/Media');
const Brand          = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const {
  resolveModelAndAspect,
  resolveReferenceImageCount,
  buildReferenceImages
} = require('./atlasVideoService');
const { loadCategoryChainForProduct } = require('./categoryChainService');
const {
  META_VIDEO_MASTER,
  aspectRatioForPlatformFormat
} = require('./platformFormats');

// Cap accepted productIds (route slices here too). Silent drop beyond this.
const PREWARM_MAX_PRODUCTS = 12;

// In-process TTL memo — skip products warmed recently by THIS process.
// Real cross-process dedupe is reframeReferenceForAspect's persistent
// cache + claims; this only avoids re-loading Mongo + re-entering the
// ladder for a double-click / remount within one web instance.
const PREWARM_MEMO_TTL_MS = 10 * 60 * 1000;
const prewarmMemo = new Map(); // `${brandId}|${productId}` → timestamp ms
// Bound the memo so a long-lived instance cannot grow it without limit
// (entries otherwise only drop when the same key is asked about again).
// Insertion-ordered Map → the first keys out are the oldest.
const PREWARM_MEMO_MAX_ENTRIES = 5000;

// SPEND CEILING — the guard that makes an unauthenticated-by-intent trigger
// safe to expose. The route is behind requireAuth, but a runaway client effect
// or a deliberate loop could otherwise POST fresh product sets forever: each
// cold product is up to ~3 outpaints, so nothing but this bounds a wizard into
// warming an entire catalog. Blocking a prewarm is ALWAYS safe — the run does
// the same work itself on demand — so this errs toward refusing.
// Per (brand, process), rolling 1h window, counting products actually handed to
// buildReferenceImages (cache hits included; we cannot see from here whether a
// product was already warm, and over-counting is the safe direction).
const PREWARM_BRAND_WINDOW_MS = 60 * 60 * 1000;
const PREWARM_BRAND_WINDOW_CAP = (() => {
  const n = Number(process.env.VIDEO_REF_PREWARM_BRAND_HOURLY_CAP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 24;
})();
const brandWarmWindow = new Map(); // brandId → number[] (timestamps ms)

// Returns true when this brand still has room in the rolling window, and
// records the warm. Prunes expired timestamps on every call.
function claimBrandBudget(brandId) {
  const key = String(brandId);
  const now = Date.now();
  const stamps = (brandWarmWindow.get(key) || [])
    .filter(ts => now - ts < PREWARM_BRAND_WINDOW_MS);
  if (stamps.length >= PREWARM_BRAND_WINDOW_CAP) {
    brandWarmWindow.set(key, stamps);
    return false;
  }
  stamps.push(now);
  brandWarmWindow.set(key, stamps);
  return true;
}

function memoKey(brandId, productId) {
  return `${String(brandId)}|${String(productId)}`;
}

function wasRecentlyWarmed(brandId, productId) {
  const ts = prewarmMemo.get(memoKey(brandId, productId));
  if (ts == null) return false;
  if (Date.now() - ts < PREWARM_MEMO_TTL_MS) return true;
  prewarmMemo.delete(memoKey(brandId, productId));
  return false;
}

function markWarmed(brandId, productId) {
  prewarmMemo.set(memoKey(brandId, productId), Date.now());
  if (prewarmMemo.size > PREWARM_MEMO_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, ts] of prewarmMemo) {
      if (now - ts >= PREWARM_MEMO_TTL_MS) prewarmMemo.delete(k);
    }
    // Still over after dropping every expired entry → evict oldest-first.
    for (const k of prewarmMemo.keys()) {
      if (prewarmMemo.size <= PREWARM_MEMO_MAX_ENTRIES) break;
      prewarmMemo.delete(k);
    }
  }
}

/**
 * Fire-and-forget body for POST /api/ads/video-ref-prewarm.
 * Per-product failures are logged and skipped — never stop the loop.
 *
 * @param {{ brandId: string, productIds: string[] }} args
 */
async function prewarmVideoRefsForProducts({ brandId, productIds }) {
  const ids = Array.isArray(productIds) ? productIds.map(String) : [];
  const capped = ids.slice(0, PREWARM_MAX_PRODUCTS);
  const t0 = Date.now();
  let warmed = 0;

  for (const pid of capped) {
    const pStart = Date.now();
    try {
      if (wasRecentlyWarmed(brandId, pid)) {
        console.log(`🔥 prewarm[${pid}]: memo hit (<${PREWARM_MEMO_TTL_MS}ms) — skipped`);
        continue;
      }

      const product = await CatalogProduct.findById(pid).lean();
      if (!product) {
        console.warn(`⚠️  prewarm[${pid}]: product missing — skipped`);
        continue;
      }
      // Tenancy: a foreign productId must never trigger spend on another
      // tenant's images, even if the route already asserted brandId.
      if (String(product.brandId) !== String(brandId)) {
        console.warn(
          `⚠️  prewarm[${pid}]: brandId mismatch ` +
          `(product.brandId=${product.brandId} requested=${brandId}) — skipped`
        );
        continue;
      }

      const productOid = product._id;

      // Seed pick — MIRROR expandDeterministicVideo feed-order hero EXACTLY
      // (campaignAdsGenerationService.js:2076-2086). Do NOT lazy-materialize
      // (detect enqueues billable vision work; run path will do it on miss).
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
        console.log(
          `🔥 prewarm[${pid}]: no catalog media — skipped (run will lazy-materialize)`
        );
        continue;
      }

      // Full seed doc — width/height feed reframe already-correct skip.
      const media = await Media.findById(hero._id).lean();
      if (!media?.fileUrl) {
        console.warn(`⚠️  prewarm[${pid}]: seed Media ${hero._id} missing fileUrl — skipped`);
        continue;
      }

      // SAME catalogMedias query as generateForAd (atlasVideoService.js
      // generateForAd load block) — incl. width/height for the skip guard
      // and refinedProducts for the DINO-derived crop path in
      // reframeStrategyChooser.subjectUnionBbox. Dropping refinedProducts
      // silently forces every alt through paid nano-banana outpaint even
      // though the DINO bboxes are already on the Media doc; Mongoose
      // `.select()` of an unrequested field returns undefined without a
      // warning, and `Array.isArray(undefined)` is false, so
      // subjectUnionBbox returns null → chooseStrategy defers → outpaint.
      // Fix restores the DINO → crop path 7758b32+da22486 shipped.
      const catalogMedias = await Media.find({
        source: 'catalog-product',
        'metadata.catalogProductId': productOid
      })
        .select('_id fileUrl classification adSuitability metadata width height refinedProducts')
        .sort({ createdAt: 1 })
        .lean();

      const brand = await Brand.findById(product.brandId).lean();
      const categories = await loadCategoryChainForProduct(product);

      // Same model+aspect resolution as generateForAd for the live video
      // master surface (META_VIDEO_MASTER = meta_stories_9_16 → 9:16).
      const platformFormat = META_VIDEO_MASTER;
      const platformAspect = aspectRatioForPlatformFormat(platformFormat) || '9:16';
      const { caps, aspectRatio } = resolveModelAndAspect({
        brand,
        product,
        categories,
        canvasKeys: [platformFormat, platformAspect],
        platformAspect,
        modelOverride: null,
        hasVideoSeed: media.fileType === 'video'
      });

      const referenceCount = resolveReferenceImageCount({ brand, product });

      // SPEND CEILING — checked here, immediately before the only billable
      // call, so the cheap DB reads above never consume budget and a skipped
      // product is never marked warm. Exhausted → stop the whole loop: the
      // remaining products would each want the same budget, and logging 12
      // identical refusals is noise.
      if (!claimBrandBudget(brandId)) {
        console.warn(
          `⚠️  prewarm: brand ${brandId} hit the rolling cap ` +
          `(${PREWARM_BRAND_WINDOW_CAP} products/h) — skipping remaining ` +
          `${capped.length - warmed} product(s); the run will reframe on demand`
        );
        break;
      }

      // Discard URLs — only the reframe side-effects (persistent cache)
      // matter for prewarm. Capture length for the summary line.
      const imageUrls = await buildReferenceImages({
        media,
        product,
        catalogMedias,
        aspectRatio,
        caps,
        referenceCount,
        brand,
        orderedReferenceMedia: null
      });

      markWarmed(brandId, pid);
      warmed += 1;
      console.log(
        `🔥 prewarm[${pid}]: warmed ${imageUrls.length} refs (${Date.now() - pStart}ms)`
      );
    } catch (err) {
      console.warn(
        `⚠️  prewarm[${pid}]: failed — ${err && err.message ? err.message : err}`
      );
    }
  }

  console.log(
    `🔥 prewarm: done ${warmed}/${capped.length} products in ${Date.now() - t0}ms`
  );
  return { warmed, total: capped.length };
}

module.exports = {
  prewarmVideoRefsForProducts,
  PREWARM_MAX_PRODUCTS,
  PREWARM_MEMO_TTL_MS,
  PREWARM_BRAND_WINDOW_CAP,
  PREWARM_BRAND_WINDOW_MS
};
