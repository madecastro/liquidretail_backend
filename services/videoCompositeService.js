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
  slotRect,          // { x, y, w, h } in same canvas pixel space
  smartCropBbox      // { x1, y1, x2, y2 } in SOURCE VIDEO pixel space
}) {
  if (!sourceVideoUrl)                 return null;
  if (!sourceVideoUrl.includes('/video/upload/')) return null;
  if (!overlayPublicId && !overlayImageUrl) return null;
  if (!canvasDims?.w || !canvasDims?.h) return null;
  if (!slotRect?.w   || !slotRect?.h)   return null;

  const cw = Math.round(canvasDims.w);
  const ch = Math.round(canvasDims.h);

  const slotX = Math.max(0, Math.round(slotRect.x || 0));
  const slotY = Math.max(0, Math.round(slotRect.y || 0));
  const slotW = Math.round(slotRect.w);
  const slotH = Math.round(slotRect.h);

  const transforms = [];

  // 1. Crop source video to smart-crop bbox if provided. Skipped when
  //    no bbox — the video plays from its native frame.
  if (smartCropBbox && smartCropBbox.x2 > smartCropBbox.x1 && smartCropBbox.y2 > smartCropBbox.y1) {
    const sW = Math.max(1, Math.round(smartCropBbox.x2 - smartCropBbox.x1));
    const sH = Math.max(1, Math.round(smartCropBbox.y2 - smartCropBbox.y1));
    const sX = Math.max(0, Math.round(smartCropBbox.x1));
    const sY = Math.max(0, Math.round(smartCropBbox.y1));
    transforms.push(`c_crop,w_${sW},h_${sH},x_${sX},y_${sY}`);
  }

  // 2. Scale to slot dimensions so the next pad-to-canvas step places
  //    the clip at exactly the slot's size. c_fill keeps subject-aware
  //    fit when slot ratio ≠ source ratio (still-sane fallback when
  //    smart-crop bbox is missing).
  transforms.push(`c_fill,w_${slotW},h_${slotH},g_auto`);

  // 3. Letterbox-pad to full canvas dims, positioning the slotted clip
  //    at the slot's top-left corner. b_black is hidden by the overlay,
  //    so it's only visible in transparent areas (which shouldn't happen
  //    once the overlay lands).
  transforms.push(`c_lpad,w_${cw},h_${ch},g_north_west,x_${slotX},y_${slotY},b_black`);

  // 4. Apply the canvas-sized overlay PNG. Cloudinary syntax for
  //    overlays is two slash-separated groups:
  //      Group A: l_<id>,<overlay's own transforms>   → sizes the overlay
  //      Group B: fl_layer_apply,<positioning>         → composites it
  //    Putting fl_layer_apply in the SAME comma-group as the overlay's
  //    w/h silently breaks the layer apply — the response either 404s
  //    or returns the base asset un-overlaid.
  //
  //    Prefer same-cloud public_id (l_<id>) over l_fetch — empirically
  //    l_fetch against a URL pointing back at the same cloud returns
  //    the base video un-overlaid even when syntax is correct.
  const overlayLayerArg = overlayPublicId
    ? buildLayerArg(overlayPublicId)
    : `l_fetch:${base64UrlEncode(overlayImageUrl)}`;
  transforms.push(`${overlayLayerArg},w_${cw},h_${ch}`);
  transforms.push(`fl_layer_apply,g_north_west,x_0,y_0`);

  // Splice the transform chain into the source URL right after /video/upload/.
  const compositeChain = transforms.join('/');
  return sourceVideoUrl.replace('/video/upload/', `/video/upload/${compositeChain}/`);
}

module.exports = { buildVideoCompositeUrl };
