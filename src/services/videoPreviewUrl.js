'use strict';
/**
 * videoPreviewUrl — build a smaller Cloudinary delivery URL for grid/thumbnail
 * video tiles, so a ~150px ad-grid tile doesn't stream the same 1080p master
 * as the full detail view.
 *
 * Pure string building. No I/O, no Mongo, no network. Mirrors the conventions
 * in services/videoCropUrl.js.
 *
 * WHY c_scale AND NOT c_fill — same reasoning as videoCropUrl.js's header:
 * c_fill needs a gravity mode to decide what to crop, and g_auto/g_face/
 * g_xy_center are exactly the transforms docs/CLOUDINARY-VIDEO.md documents
 * as unsupported or async for video on this account. Ad renders are already
 * produced at the exact target canvas aspect ratio (Root.jsx compositions),
 * so a grid tile needs only a proportional downscale, not a re-crop — c_scale
 * is a single-dimension, aspect-preserving, synchronous transform with no
 * gravity dependency, so it sidesteps that whole failure class.
 *
 * q_auto (auto bitrate/quality) and f_auto (auto codec/container per
 * requesting browser) are both additive on-the-fly levers on top of c_scale.
 *
 * Full length, no duration change — grid tiles show the complete ad, just
 * smaller and lighter, not a truncated loop.
 */

const { isTransformableVideoUrl, VIDEO_UPLOAD_MARKER } = require('./videoCropUrl');

/** Target width (px) for the grid/thumbnail-tier video variant. */
const GRID_PREVIEW_WIDTH_PX = 480;

/**
 * Build a downscaled, auto-quality/format delivery URL for grid/thumbnail use.
 *
 * @param {string|null|undefined} renderUrl  Ad.renderUrl (a Cloudinary
 *   /video/upload/ delivery URL) or any other string.
 * @param {object} [opts]
 * @param {number} [opts.width=GRID_PREVIEW_WIDTH_PX]
 * @returns {string|null} the transformed URL, or the original `renderUrl`
 *   (falling back rather than emitting a broken link) when it isn't a
 *   transformable Cloudinary video URL — including `null`/`undefined` in,
 *   `null` out.
 */
function buildGridPreviewVideoUrl(renderUrl, opts = {}) {
  if (!isTransformableVideoUrl(renderUrl)) return renderUrl || null;
  const width = opts.width || GRID_PREVIEW_WIDTH_PX;
  const transform = `c_scale,w_${width},q_auto,f_auto`;
  return renderUrl.replace(VIDEO_UPLOAD_MARKER, `${VIDEO_UPLOAD_MARKER}${transform}/`);
}

module.exports = {
  buildGridPreviewVideoUrl,
  GRID_PREVIEW_WIDTH_PX,
};
