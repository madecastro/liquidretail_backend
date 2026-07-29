'use strict';
/**
 * videoCropUrl — build a Cloudinary delivery URL that crops a video to an explicit pixel rect.
 *
 * Pure string building. No I/O, no Mongo, no network. Covered offline by
 * scripts/verifyVideoCropUrl.js.
 *
 * WHY EXPLICIT c_crop AND NOT g_auto — all live-probed 2026-07-29 against reach-social-prod
 * (full matrix in docs/CLOUDINARY-VIDEO.md):
 *   g_face        -> 400 "Gravity face not supported for video"
 *   g_xy_center   -> 400 "not supported for video"
 *   fl_relative   -> 400 "resize marked as relative but not performed on a layer" (layers only)
 *   g_auto        -> WORKS, but ASYNC per asset: the first request returns 423 "Video
 *                    tracking-crop is pending" with an image/gif placeholder, resolving to 200
 *                    later. Every generated ad is a new asset composited once, so in production
 *                    the cold path IS the normal path.
 *   explicit c_crop -> 200, synchronous, exact. 1080x1920 -> 540x540 verified.
 * So an explicit rect is the only mechanism that is both face-aware and synchronous.
 *
 * WHY THE c_scale PREFIX — this is the part that is easy to get wrong and expensive to debug.
 * videoCompositeService.js:83-110 documents why the v1 bbox chain was retired: crop coordinates
 * were computed in the SOURCE UPLOAD pixel space, but Cloudinary's video pipeline delivers at a
 * capped resolution. Asking for c_crop,w_2268,h_2268 against an upload Cloudinary served at
 * 1206-wide silently clipped the crop, and the following c_lpad black-padded the difference.
 * Three prior fixes missed it because the bbox WAS in bounds of the upload dims — the upload dims
 * just are not the transform pipeline's dims.
 *
 * Prefixing c_scale,w_<sourceW> pins the coordinate space BEFORE cropping: whatever the upload is,
 * the frame the crop applies to is exactly sourceW wide, so a rect computed against sourceW x
 * sourceH is exact by construction.
 *
 * HONEST LIMIT: the chain form was proven to work and to return byte-identical output to a bare
 * c_crop (379,643 b, synchronous) — but the probe asset was 1080x1920, already inside the delivery
 * cap, so c_scale was a no-op on it and the oversized-upload failure mode was NOT reproduced.
 * Treat the fix as well-grounded, not verified, until it is tested against something like
 * 2268x4032. See docs/CLOUDINARY-VIDEO.md.
 */

/** Cloudinary video delivery URLs all carry this segment; anything else we cannot transform. */
const VIDEO_UPLOAD_MARKER = '/video/upload/';

/**
 * Is this a Cloudinary video delivery URL we can splice a transform into?
 * Deliberately strict: a non-Cloudinary host, an /image/upload/ URL, or a non-string all return
 * false so a caller falls back rather than emitting a broken URL.
 */
function isTransformableVideoUrl(url) {
  return typeof url === 'string' && url.length > 0 && url.includes(VIDEO_UPLOAD_MARKER);
}

/**
 * Does this URL already carry a crop/resize transform?
 *
 * Guards against DOUBLE-CROPPING, which is the failure this module is most likely to cause in
 * practice: the source may already have been through buildVideoSegmentUrl (c_fill,ar_) or an eager
 * transform, and cropping a crop silently compounds the loss. Only inspects the transform segment
 * between /video/upload/ and the version/public_id, so a public_id that happens to contain "c_"
 * cannot trigger a false positive.
 */
function hasExistingCropTransform(url) {
  if (!isTransformableVideoUrl(url)) return false;
  const after = url.slice(url.indexOf(VIDEO_UPLOAD_MARKER) + VIDEO_UPLOAD_MARKER.length);
  // Transform components precede the version (v123...) or the folder/public_id. Cloudinary allows
  // several slash-separated transform groups, so scan every leading group that looks like one.
  for (const seg of after.split('/')) {
    if (/^v\d+$/.test(seg)) break;             // reached the version — transforms are done
    if (!/(^|,)[a-z]{1,3}_/.test(seg)) break;  // not a transform group — reached the public_id
    if (/(^|,)(c_(fill|crop|scale|pad|lpad|limit|thumb|fit))/.test(seg)) return true;
  }
  return false;
}

/**
 * Build a delivery URL cropping `sourceUrl` to `rect`, in `sourceW x sourceH` coordinate space.
 *
 * @param {object} args
 * @param {string} args.sourceUrl  Cloudinary /video/upload/ delivery URL
 * @param {{cx:number,cy:number,cw:number,ch:number}} args.rect  pixel rect from faceSafeCrop
 * @param {number} args.sourceW    width the rect was computed against
 * @param {number} args.sourceH    height the rect was computed against
 * @param {boolean} [args.allowDoubleCrop=false]  opt out of the existing-transform guard
 * @returns {string|null} the URL, or null when the input is unusable (caller falls back)
 */
function buildVideoCropUrl({ sourceUrl, rect, sourceW, sourceH, allowDoubleCrop = false }) {
  if (!isTransformableVideoUrl(sourceUrl)) return null;
  if (!rect) return null;

  const { cx, cy, cw, ch } = rect;
  // Integers only. Cloudinary rejects fractional crop args, and a NaN here would produce a URL
  // that 400s at delivery time — i.e. a broken ad rather than a loud failure.
  if (![cx, cy, cw, ch, sourceW, sourceH].every(Number.isInteger)) return null;
  if (cw < 1 || ch < 1 || sourceW < 1 || sourceH < 1) return null;
  // The rect must fit the space it was computed in, or Cloudinary clips and pads — the exact v1
  // black-bar bug.
  if (cx < 0 || cy < 0 || cx + cw > sourceW || cy + ch > sourceH) return null;

  if (!allowDoubleCrop && hasExistingCropTransform(sourceUrl)) return null;

  // A crop covering the whole frame is a no-op; skip the transform entirely rather than paying a
  // transcode and inviting a cache miss for nothing.
  if (cx === 0 && cy === 0 && cw === sourceW && ch === sourceH) return sourceUrl;

  // Two transform groups, order load-bearing:
  //   1. c_scale,w_<sourceW> — pin the coordinate space (see the header note)
  //   2. c_crop,w_,h_,x_,y_  — the explicit rect, synchronous and exact
  const chain = `c_scale,w_${sourceW}/c_crop,w_${cw},h_${ch},x_${cx},y_${cy}`;
  return sourceUrl.replace(VIDEO_UPLOAD_MARKER, `${VIDEO_UPLOAD_MARKER}${chain}/`);
}

module.exports = {
  buildVideoCropUrl,
  isTransformableVideoUrl,
  hasExistingCropTransform,
  VIDEO_UPLOAD_MARKER,
};
