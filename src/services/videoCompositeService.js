// V1 video render composition.
//
// Builds a single Cloudinary video URL that composites:
//
//   - the source .mp4 (cropped to the smart-crop bbox)
//   - positioned within the canvas at the template's media-slot rect
//   - with a transparent-media-slot overlay PNG layered on top
//
// Transform chain (left to right = applied in order):
//
//   c_crop,w_<sW>,h_<sH>,x_<sX>,y_<sY>            — crop source video to the
//                                                   subject-aware smart-crop bbox
//                                                   (so the cropped clip is the
//                                                   "good" framing of the subject)
//   c_scale,w_<slotW>,h_<slotH>                    — resize the cropped clip to the
//                                                   media-slot dims
//   c_lpad,w_<canvasW>,h_<canvasH>,g_north_west,   — pad to the full canvas size,
//        x_<slotX>,y_<slotY>,b_black                positioning the resized clip
//                                                   at the slot's top-left corner
//   l_fetch:<base64 overlay url>,fl_layer_apply,   — overlay the static panel/text PNG
//        w_<canvasW>,h_<canvasH>                    full-canvas; transparent slot
//                                                   area lets the video show through
//
// Output is always .mp4. Cloudinary transcodes on first hit (~5-10s)
// and caches at the CDN edge for subsequent reads.
//
// Inputs are picked from existing artifacts:
//   sourceVideoUrl    Media.fileUrl (already a Cloudinary /video/upload/ URL after
//                     postSyncService mirrors IG → Cloudinary)
//   smartCropBbox     CropArtifact.smartCrops[<ratio>][judge.winnerId] — same shape
//                     we use for cropped-clip playback in the ribbon
//   slotRect          rsSocialProof.canvas.v1.json variant.zones[product.hero_media].rect
//   canvasDims        rsSocialProof.canvas.v1.json variant.canvas.{width,height}
//   overlayImageUrl   Cloudinary image URL of the rendered transparent-slot overlay
//                     (uploaded by the renderer's upload stage)

// Cloudinary's l_fetch: takes a base64url-encoded URL — so the overlay
// asset doesn't need to live in the same Cloudinary cloud or have a
// public_id at all. We just hand it any reachable HTTPS URL.
function base64UrlEncode(s) {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Same-cloud overlay reference. Cloudinary expects path slashes
// replaced with colons in the layer arg: an upload at
// ads/abc/def/foo.png is referenced as l_ads:abc:def:foo (no
// extension, no version). Empirically l_fetch against the same
// cloud's URL silently fails to composite (returns base video
// un-overlaid), so when we have a public_id we use this form.
function buildLayerArg(publicId) {
  if (!publicId) return null;
  return `l_${publicId.replace(/\//g, ':')}`;
}

// Build the composite URL. Returns null if any required input is missing
// or the source isn't a Cloudinary video URL we can transform.
//
// overlayPublicId is preferred (same-cloud reference via l_<id>);
// overlayImageUrl is the l_fetch fallback for cross-cloud / external
// URLs and the diagnostic preview endpoint.
function buildVideoCompositeUrl({
  sourceVideoUrl,
  overlayPublicId,   // preferred — Cloudinary public_id of the overlay PNG
  overlayImageUrl,   // fallback — full HTTPS URL (uses l_fetch)
  canvasDims,        // { w, h } in source-image pixel space (canvas template uses normalized_1000)
  slotRect,          // { x, y, w, h } in same canvas pixel space — kept for compat; not used in v2 chain since SPEC v2.11.0 mandates media zone covers the full canvas
  smartCropBbox,     // { x1, y1, x2, y2 } in SOURCE VIDEO pixel space — kept for compat; UNUSED in v2 chain. See COORD-SPACE MISMATCH comment below.
  sourceDims         // { w, h } from Media.width / Media.height — used to cap the working dimension so it doesn't exceed source resolution
}) {
  if (!sourceVideoUrl)                 return null;
  if (!sourceVideoUrl.includes('/video/upload/')) return null;
  if (!overlayPublicId && !overlayImageUrl) return null;
  if (!canvasDims?.w || !canvasDims?.h) return null;
  if (!slotRect?.w   || !slotRect?.h)   return null;

  const cw = Math.round(canvasDims.w);
  const ch = Math.round(canvasDims.h);

  // COORD-SPACE MISMATCH (why the v1 c_crop+c_lpad+smartCropBbox chain
  // was retired):
  //
  // The smart-crop pipeline computes bboxes in the SOURCE UPLOAD pixel
  // space — for a 2268×4032 portrait video upload, a 1:1 smart-crop
  // bbox might be 2268×2268. That's geometrically correct.
  //
  // BUT Cloudinary's video transformation pipeline doesn't operate at
  // the full upload resolution — it caps at a delivery threshold
  // (account-dependent, typically ~1080p / 1440p / etc). When the
  // chain asked for c_crop,w_2268,h_2268 against an upload that
  // Cloudinary delivers at 1206-wide, Cloudinary silently clipped the
  // crop to what it could deliver, then c_lpad,w_2268,h_2268,b_black
  // padded the missing pixels with BLACK to reach the declared output
  // dimensions. Result: a 2268×2268 declared mp4 with content only in
  // the top-left 1206×1206 region and black filling the rest. That's
  // what was producing the persistent black bars on video composites
  // even after the canvas-aspect smart-crop (ae79285), missing-crop
  // fallback (3c0bb8c), and bbox in-bounds validation (bbca5be) fixes.
  // None of those caught it because the bbox WAS in bounds of the
  // upload dims — the upload dims just weren't the transform pipeline
  // dims.
  //
  // v2 chain: drop the bbox-driven c_crop entirely. Use c_fill,ar,
  // g_auto instead — Cloudinary handles cropping at the delivery
  // resolution it can actually serve, content-aware via saliency
  // gravity. Lose smart-crop subject framing in exchange for never
  // having a coord-space mismatch.
  //
  // Working dim is bounded by:
  //   1. canvas dims (don't deliver bigger than design intent)
  //   2. source dims when known (Cloudinary won't upscale video, and
  //      if delivered smaller than overlay-requested dim, chrome
  //      clips at edges)
  //   3. MAX_VIDEO_OUTPUT_DIM = 1080 — conservative cap below typical
  //      Cloudinary video delivery thresholds
  const MAX_VIDEO_OUTPUT_DIM = 1080;
  const srcMin = sourceDims?.w && sourceDims?.h
    ? Math.min(Number(sourceDims.w), Number(sourceDims.h))
    : MAX_VIDEO_OUTPUT_DIM;
  const canvasAspect = cw / ch;
  let workW, workH;
  if (canvasAspect >= 1) {
    // square / landscape — height-bound by the smaller of the three caps
    workH = Math.min(ch, srcMin, MAX_VIDEO_OUTPUT_DIM);
    workW = Math.round(workH * canvasAspect);
  } else {
    // portrait — width-bound
    workW = Math.min(cw, srcMin, MAX_VIDEO_OUTPUT_DIM);
    workH = Math.round(workW / canvasAspect);
  }

  const transforms = [];

  // 1. Crop the source to canvas aspect at the working dimensions,
  //    using Cloudinary's content-aware gravity (g_auto). For a
  //    portrait source on a square canvas, this is roughly the same
  //    framing the smart-crop service would have produced — saliency-
  //    based subject framing. The crucial difference: Cloudinary picks
  //    the crop at its actual delivery resolution, so output is
  //    guaranteed to match the declared dimensions. No clipping, no
  //    padding, no black bars from the composite chain.
  transforms.push(`c_fill,w_${workW},h_${workH},g_auto`);

  // 2. Apply the overlay PNG, scaled to match the video output dims.
  //    Image pipeline DOES upscale, so the 1000×1000 Puppeteer overlay
  //    scales cleanly to workW × workH. Cloudinary syntax requires the
  //    overlay's own transforms (l_<id>,<dims>) and fl_layer_apply to
  //    live in SEPARATE comma-groups — same constraint as v1.
  //
  //    Prefer same-cloud public_id (l_<id>) over l_fetch — empirically
  //    l_fetch against a URL pointing back at the same cloud returns
  //    the base video un-overlaid even when syntax is correct.
  const overlayLayerArg = overlayPublicId
    ? buildLayerArg(overlayPublicId)
    : `l_fetch:${base64UrlEncode(overlayImageUrl)}`;
  transforms.push(`${overlayLayerArg},w_${workW},h_${workH}`);
  transforms.push(`fl_layer_apply,g_north_west,x_0,y_0`);

  // Splice the transform chain into the source URL right after /video/upload/.
  const compositeChain = transforms.join('/');
  return sourceVideoUrl.replace('/video/upload/', `/video/upload/${compositeChain}/`);
}

module.exports = { buildVideoCompositeUrl };
