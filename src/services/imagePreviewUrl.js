'use strict';
/**
 * imagePreviewUrl — build a smaller Cloudinary delivery URL for grid/thumbnail
 * static-ad tiles, so a ~150-300px ad-grid tile doesn't stream the same
 * full-resolution PNG/JPEG master the detail view uses.
 *
 * Pure string building. No I/O, no Mongo, no network. Mirrors the shape of
 * services/videoPreviewUrl.js (video's equivalent) and the guard style of
 * services/videoCropUrl.js — just against `/image/upload/` instead of
 * `/video/upload/`. There is no imageCropUrl.js sibling to import a shared
 * constant from, so the marker + guard are defined locally here, same as
 * videoCropUrl.js defines VIDEO_UPLOAD_MARKER for its own module.
 *
 * WHY c_scale AND NOT c_fill/h_ — static ad renders exist at several
 * distinct aspect ratios (1:1, 4:5, 9:16, 1.91:1, plus flat 1200x1200
 * square exports). c_fill needs a gravity mode to decide what to crop away,
 * and a fixed h_ alongside w_ would force exactly that crop (or a letterbox)
 * on every non-square format. c_scale with width only resizes
 * proportionally, so every aspect ratio keeps its own shape at tile size —
 * same reasoning videoPreviewUrl.js's header gives for video.
 *
 * q_auto (auto quality) and f_auto (auto format — serves WebP/AVIF to a
 * browser that supports either, vs. the fixed PNG/JPEG the master was
 * uploaded as) are the same two additive, synchronous, no-gravity-dependency
 * levers videoPreviewUrl.js already stacks on top of c_scale.
 *
 * Whole image, not a crop — grid tiles show the complete ad, just smaller
 * and lighter, exactly the same contract as the video tile variant.
 */

/** Cloudinary image delivery URLs all carry this segment; anything else we cannot transform. */
const IMAGE_UPLOAD_MARKER = '/image/upload/';

/**
 * Target width (px) for the grid/thumbnail-tier image variant.
 *
 * Wider than video's 480: a static tile IS the primary visual (no play
 * button or poster frame to lean on while it loads), and every surface that
 * renders this grid (pages/Ads, pages/ProductAds, pages/UgcAds,
 * pages/CampaignDetail) caps out at a 4-column SimpleGrid inside a
 * roughly 1200-1280px content width — a CSS tile around 280-300px wide.
 * At a common 2x device pixel ratio that's ~560-600px of physical pixels,
 * so 640 covers it with a little headroom while remaining a small fraction
 * of the 2000-4000px-wide masters actually being served today (measured:
 * 1.5-4.3MB per PNG at full size).
 */
const GRID_PREVIEW_WIDTH_PX = 640;

/**
 * Is this a Cloudinary image delivery URL we can splice a transform into?
 * Deliberately strict: a non-Cloudinary host, a /video/upload/ URL, or a
 * non-string all return false so a caller falls back rather than emitting a
 * broken URL.
 */
function isTransformableImageUrl(url) {
  return typeof url === 'string' && url.length > 0 && url.includes(IMAGE_UPLOAD_MARKER);
}

/**
 * Build a downscaled, auto-quality/format delivery URL for grid/thumbnail use.
 *
 * @param {string|null|undefined} renderUrl  Ad.renderUrl (a Cloudinary
 *   /image/upload/ delivery URL) or any other string.
 * @param {object} [opts]
 * @param {number} [opts.width=GRID_PREVIEW_WIDTH_PX]
 * @returns {string|null} the transformed URL, or the original `renderUrl`
 *   (falling back rather than emitting a broken link) when it isn't a
 *   transformable Cloudinary image URL — including `null`/`undefined` in,
 *   `null` out.
 */
function buildGridPreviewImageUrl(renderUrl, opts = {}) {
  if (!isTransformableImageUrl(renderUrl)) return renderUrl || null;
  const width = opts.width || GRID_PREVIEW_WIDTH_PX;
  const transform = `c_scale,w_${width},q_auto,f_auto`;
  return renderUrl.replace(IMAGE_UPLOAD_MARKER, `${IMAGE_UPLOAD_MARKER}${transform}/`);
}

module.exports = {
  buildGridPreviewImageUrl,
  isTransformableImageUrl,
  IMAGE_UPLOAD_MARKER,
  GRID_PREVIEW_WIDTH_PX,
};
