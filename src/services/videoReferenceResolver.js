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
// tiny, single-source contract every video-ref builder should call:
//
//   1. If Media.metadata.reframes[<aspectKey>].url exists → return it.
//      The cache already carries the DINO decision (pad, yolo-crop,
//      yolo-crop-forced, or the legacy composite-outpaint) at the target
//      aspect. Nothing here re-decides.
//   2. Otherwise, fall back to `cropImageUrlForAspect(media.fileUrl,
//      aspectRatio, brand)` — the deterministic `c_fill,g_auto` Cloudinary
//      transform that used to be everyone's default. Zero cost, zero
//      hallucination, but Cloudinary's saliency model decides what's
//      centred instead of DINO's bboxes.
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
// where source is 'reframe-cache' on a hit or 'c-fill-fallback' on a miss,
// and method + ladderVersion mirror the persisted entry when the cache
// serves. `null` url is possible when the source URL is falsy AND
// cropImageUrlForAspect returns null (defensive: keep the caller unchanged
// if it already handles null).
//
// Options:
//   preferReframe (default true) — when false, skip the cache read
//     entirely and always return the c-fill fallback. Reserved for
//     debugging / A/B; production paths should keep it true.
function resolveVideoReferenceForMedia({ media, aspectRatio, brand, preferReframe = true } = {}) {
  const aspectKey = mediaAspectKey(aspectRatio);
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
  const url = cropImageUrlForAspect(media && media.fileUrl, aspectRatio, brand);
  return { url, source: 'c-fill-fallback', aspectKey, method: null, ladderVersion: null };
}

module.exports = {
  resolveVideoReferenceForMedia,
  mediaAspectKey
};
