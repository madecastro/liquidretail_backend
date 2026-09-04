// src/services/videoReferenceResolver.js — shared cache-first video reference
// URL resolution for EVERY video model's reference-image parameter.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Multiple video models coexist in the pipeline (Atlas gemini-omni-flash,
// direct-Gemini gemini-omni-1.1-flash, Veo 3.1 preview, and any future
// image-to-video / reference-to-video endpoint). Each has its own submit
// path that needs a public HTTP URL for every reference image it wants to
// hand the model.
//
// The DINO-derived reframe work — source-native c_pad on product_only heros,
// c_crop on within-tolerance on_model / detail alts, and c_crop of the
// forced bbox-centered rect on beyond-tolerance subject unions — lives in
// Media.metadata.reframes[<aspectKey>]. `reframeReferenceForAspect` in
// atlasVideoService reads and writes that cache for the Atlas Omni path.
//
// But other video-model paths (the direct-Gemini gemini-omni-1.1-flash
// path that stamps veoReferenceImages of the form
// `b_rgb:FFFFFF,c_fill,w_720,h_1280,g_auto,f_jpg,q_auto:good/...`
// on production ad rows — see run 6a99d793 Lure Flag master
// 2026-09-03 20:24Z as an in-prod example) bypass the cache entirely and
// pipe every catalog Media through `cropImageUrlForAspect` directly. Result:
// same source medias that just paid $0 for a DINO-preserved crop on the
// Atlas path get Cloudinary's saliency-aware g_auto crop on the direct
// path, throwing away the subject-preservation guarantee we spent an
// entire evening wiring up.
//
// ── WHAT THIS DOES ────────────────────────────────────────────────────────
// `resolveVideoReferenceForMedia({ media, aspectRatio, brand })` is the
// tiny, single-source contract every video-ref builder should call. Three
// fallbacks in strict order, EACH ONE deterministic and $0:
//
//   1. reframe-cache — Media.metadata.reframes[<aspectKey>].url is a URL
//      the reframe pipeline already persisted (prewarm, an earlier render,
//      or reframeReferenceForAspect on the Atlas path). Carries the DINO
//      decision (pad, yolo-crop, yolo-crop-forced) at the target aspect.
//      Cheapest — one map read, no compute.
//
//   2. on-demand-yolo — cache missed, but the media still has DINO bboxes
//      on refinedProducts[]. Call reframeStrategyChooser.chooseStrategy
//      directly and use its yolo-crop / yolo-crop-forced URL. Same $0
//      c_crop URL the prewarm would have persisted — just computed at
//      request time instead of read from cache. Exists because the
//      prewarm's seed selection (rank-based, top-3) can diverge from the
//      render's seed selection (operator picks, or a different rank), and
//      the cache MUST NOT be the only path to a subject-centred crop —
//      otherwise a miss silently collapses fidelity to Cloudinary's own
//      saliency model. Read-only: does not persist. The persist belongs to
//      reframeReferenceForAspect / the prewarm; masking their gaps with a
//      resolver-side write would hide the coordination bug this branch
//      exists to work around, not fix it.
//
//   3. c-fill-fallback — the media has no cache entry, no usable bboxes,
//      and no dims we can trust. Only reachable when the DINO signal is
//      genuinely absent (fresh ingest, non-Cloudinary source, product-only
//      shot with borders detect failed, etc.). Emits `cropImageUrlForAspect`
//      — Cloudinary's own `c_fill,g_auto`, which does subject-blind
//      saliency detection. Not a good fallback for on-model shots but the
//      only $0 option when we have nothing else to work with.
//
// The aspect key is the SAME normalisation as
// atlasVideoService.reframeReferenceForAspect (`':' → '_'`, `'.' → '_'`)
// so a resolver-side lookup keys the exact field the reframe writer set.
// Mismatched keys would silently miss every cache entry — a defect this
// helper exists to make impossible.
//
// ── FAIL-CLOSED, NEVER THROWS ─────────────────────────────────────────────
// A malformed aspect string, an absent media, an already-transformed
// fileUrl — every degenerate input returns the fall-through URL from
// `cropImageUrlForAspect`, which itself never throws (returns the input
// URL untouched on non-Cloudinary sources). Callers see a URL or `null`,
// never a rejection. The reference stack must not crash the render loop.
//
// ── ADGEN PORT ────────────────────────────────────────────────────────────
// Hand-synced with the backend copy at
// liquidretail_backend/services/videoReferenceResolver.js. Do not diverge
// without also updating the backend — the two file-name pointer field
// (Media.metadata.reframes[<aspectKey>]) is the SAME Mongo doc for both
// sides, and a key-normalisation mismatch on ONE side silently misses
// every cache entry the OTHER side wrote.
//
// ── NOT THIS FILE'S JOB ───────────────────────────────────────────────────
//   - Computing new reframes. `reframeReferenceForAspect` owns writes.
//   - Deciding pad vs crop vs outpaint. `reframeStrategyChooser` owns that.
//   - Cache invalidation. `REFRAME_LADDER_VERSION` + REFRAME_REDERIVE_STALE
//     handle it inside reframeReferenceForAspect.
//   - Uploading anything. This helper is READ-ONLY over the cache.

'use strict';

const { cropImageUrlForAspect } = require('./atlasVideoService');
const { chooseStrategy } = require('./reframeStrategyChooser');

// Mongo-safe aspect key. Bytewise-identical to the normalisation in
// reframeReferenceForAspect at atlasVideoService.js — `':' AND '.' are
// removed (via a single [^a-z0-9]+ replace-with-underscore). Kept as a
// standalone exported helper so callers can log the key alongside the
// URL without re-implementing the rule (and drifting from it).
function mediaAspectKey(aspectRatio) {
  return String(aspectRatio || '').replace(/[^a-z0-9]+/gi, '_');
}

// Resolve a single Media doc + target aspect to a public HTTP URL suitable
// for any video model's reference-image parameter. Returns:
//   { url, source, aspectKey, method, ladderVersion }
// where `source` is one of 'reframe-cache' / 'on-demand-yolo' /
// 'c-fill-fallback' (see the three-tier header above), `method` mirrors
// the persisted or computed strategy (pad-product-only, yolo-crop,
// yolo-crop-forced, or null on c-fill), and `ladderVersion` is populated
// only for cache hits (on-demand is computed live off the current
// reframeStrategyChooser code). `null` url is possible when the source
// URL is falsy AND cropImageUrlForAspect returns null (defensive — keep
// the caller unchanged if it already handles null).
//
// Options:
//   preferReframe (default true) — when false, skip BOTH the cache read
//     AND the on-demand DINO compute, and always return the c-fill
//     fallback. Reserved for debugging / A/B; production paths keep it
//     true.
function resolveVideoReferenceForMedia({ media, aspectRatio, brand, preferReframe = true } = {}) {
  const aspectKey = mediaAspectKey(aspectRatio);

  // Tier 1: persistent cache. Deterministic $0 URL the reframe pipeline
  // wrote previously. One field read, no compute.
  if (preferReframe && media && media._id != null && aspectKey) {
    const entry = media.metadata && media.metadata.reframes
      ? media.metadata.reframes[aspectKey]
      : null;
    const cached = entry && typeof entry.url === 'string' ? entry.url.trim() : '';
    if (cached) {
      return {
        url: cached,
        source: 'reframe-cache',
        aspectKey,
        method: entry.method || null,
        ladderVersion: entry.ladderVersion || null
      };
    }
  }

  // Tier 2: on-demand DINO crop. The cache didn't have this (media, aspect)
  // — either the prewarm's rank-based top-3 didn't include this seed, or an
  // operator pick landed on a seed the prewarm skipped. chooseStrategy is
  // pure (no I/O) and returns action:'crop' with a subject-centred c_crop
  // URL when refinedProducts + width/height allow one. That URL is BYTE-
  // IDENTICAL to what reframeReferenceForAspect would have persisted, so
  // this branch preserves the DINO decision the master paid for. Read-only:
  // the write belongs to the persist path, not here.
  //
  // Only 'crop' resolves — 'skip'/'defer'/'composite-mask' means we can't
  // build a $0 subject-centred URL (no bboxes, unknown dims, non-Cloudinary
  // source, or the strategy would need a paid outpaint). All of those fall
  // through to tier 3 rather than triggering spend from the resolver.
  //
  // Try/catch even though chooseStrategy is documented pure: a resolver
  // that ships a URL beats a resolver that throws, since callers use the
  // returned URL to build a paid submit body downstream. A throw here
  // would drop the ref entirely.
  if (preferReframe && media && media._id != null && media.fileUrl && aspectRatio) {
    try {
      const strategy = chooseStrategy({ media, aspectRatio, sourceUrl: media.fileUrl });
      if (strategy && strategy.action === 'crop' && typeof strategy.url === 'string' && strategy.url.trim()) {
        return {
          url: strategy.url.trim(),
          source: 'on-demand-yolo',
          aspectKey,
          method: strategy.method || 'yolo-crop',
          ladderVersion: null
        };
      }
    } catch {
      // Fall through to tier 3.
    }
  }

  // Tier 3: c_fill,g_auto fallback. No cache, no bboxes we can crop from,
  // no source dims. Subject-blind saliency crop from Cloudinary — better
  // than nothing but throws away the fidelity guarantee. If this fires on
  // a seed that has refinedProducts populated, that's a bug in the tier-2
  // guard (e.g. missing width/height on the Media doc); the operator sees
  // it in the `on-demand-yolo` vs `c-fill-fallback` split logged by
  // assembleReferences.
  const url = cropImageUrlForAspect(media && media.fileUrl, aspectRatio, brand);
  return { url, source: 'c-fill-fallback', aspectKey, method: null, ladderVersion: null };
}

module.exports = {
  resolveVideoReferenceForMedia,
  mediaAspectKey
};
