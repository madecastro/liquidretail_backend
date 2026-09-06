'use strict';
//
// Single reader for META_VIDEO_DURATION_SEC so crop / QC / cost-estimate /
// Cloudinary-segment fallbacks cannot drift from mint-time
// resolveVideoDurationForFormat (campaignAdsGenerationService.js).
//
// Owner 2026-08-11 / 2026-08-18: Meta (and PMax) standardise on 10s.
// That is a render-length change, NOT a re-mint — Meta identity digests
// still omit duration. Kill switch: META_VIDEO_DURATION_SEC empty or 0
// restores the Atlas provider default (Omni/Grok 8s).
//
// Distinct from Remotion title-timing, which is STILL authored on an 8s
// grid and stretched onto the real plate via remotion/lib/timing.js
// timeScale (10s → 1.25). Do not "fix" those 8s literals.
//
const DEFAULT_META_VIDEO_DURATION_SEC = 10;
const PROVIDER_DEFAULT_DURATION_SEC = 8;

function metaVideoDurationSec() {
  const raw = process.env.META_VIDEO_DURATION_SEC;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_META_VIDEO_DURATION_SEC;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function fallbackVideoDurationSec() {
  const n = metaVideoDurationSec();
  return n != null ? n : PROVIDER_DEFAULT_DURATION_SEC;
}

function resolveAdVideoDurationSec(ad) {
  const n = Number(ad && ad.videoDurationSec);
  if (Number.isFinite(n) && n > 0) return n;
  return fallbackVideoDurationSec();
}

module.exports = {
  DEFAULT_META_VIDEO_DURATION_SEC,
  PROVIDER_DEFAULT_DURATION_SEC,
  metaVideoDurationSec,
  fallbackVideoDurationSec,
  resolveAdVideoDurationSec,
};
