// Pure decision helper for the video-reference reframe path. Given a Media
// doc + a target aspect ratio, returns the cheapest strategy that preserves
// product fidelity:
//
//   'skip'      — source aspect already matches target within threshold;
//                 the caller should serve the source URL unchanged
//   'crop'      — YOLO subject bboxes (Media.refinedProducts[]) fit in a
//                 target-aspect crop window centered on the subject union
//                 centroid; emits a deterministic Cloudinary c_crop URL
//                 that adds no invented pixels
//   'defer'     — no cheap alternative; caller should fall through to the
//                 existing generative outpaint path
//
// Why this exists: the generative reframe (google/nano-banana-2/edit) is the
// only outpainter Atlas exposes and it re-synthesises the WHOLE canvas — on
// subject-dominant or multi-subject sources with subjects near the extended
// edges, it fabricates. This chooser gives the codebase a $0, deterministic
// path for the common case where the source is simply wider (or taller) than
// the target and the subject fits inside the crop window.
//
// Design constraints:
//   1. PURE — no I/O, no DB, no fetch. Every input flows in on the args
//      object; every output is on the return. This lets the harness at
//      scripts/verifyReframeStrategy.js prove behaviour on fixtures without
//      standing up MongoDB, YOLO, or Cloudinary.
//   2. FAIL-CLOSED to defer. Any ambiguity — unknown source dims, missing
//      YOLO output, unparseable aspect, non-Cloudinary source URL — returns
//      { action: 'defer' } so the caller's existing outpaint path handles
//      it. A wrong 'crop' would ship a mis-framed reference; a wrong
//      'defer' just wastes an outpaint call.
//   3. KILL-SWITCHED. REFRAME_STRATEGY=crop-first turns this on;
//      any other value (including the default 'outpaint-only') returns
//      { action: 'defer' } unconditionally so the current pipeline is
//      byte-identical.
//
// Not this file's job:
//   - Deciding product_only → pad. That lives in atlasVideoService's
//     REFRAME_PRODUCT_ONLY_PAD branch, upstream of this chooser.
//   - Persisting the result. The reframe worker in atlasVideoService owns
//     Media.metadata.reframes[<aspect>] writes; this chooser only computes
//     the URL.
//   - Choosing a "primary" subject when multiple detections exist. We union
//     ALL of them and require the union to fit — a defensive rule that
//     defers to outpaint on multi-model lifestyle shots rather than
//     silently cropping people out.

'use strict';

// Matches atlasVideoService REFRAME_SKIP_THRESHOLD default. Kept in sync so
// the "already correct" gate here and there agree on when a reframe is
// unnecessary.
const ASPECT_MATCH_THRESHOLD = 0.985;

// Require this many pixels of visual breathing room on every side of the
// subject union before we're willing to crop. Prevents a crop that lands
// exactly on the subject's edge, which would clip an eyebrow or a shoe
// point that YOLO's box slightly under-measured.
const CROP_SAFETY_MARGIN_PX = 8;

function isCropFirstEnabled() {
  const v = String(process.env.REFRAME_STRATEGY || 'outpaint-only').toLowerCase().trim();
  return v === 'crop-first';
}

function parseAspect(a) {
  const m = String(a || '').trim().match(/^([\d.]+)\s*:\s*([\d.]+)$/);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!(w > 0 && h > 0)) return null;
  return w / h;
}

// YOLO output lands on Media.refinedProducts[] with per-detection {x1,y1,x2,y2}
// in source pixel coordinates (see yoloService._callYolo). We union every
// confident detection rather than picking a "primary" — undercounting subjects
// is how outpaints slip through unnoticed.
function subjectUnionBbox(media) {
  const refined = Array.isArray(media?.refinedProducts) ? media.refinedProducts : [];
  const valid = refined.filter((r) =>
    Number.isFinite(r?.x1) && Number.isFinite(r?.y1) &&
    Number.isFinite(r?.x2) && Number.isFinite(r?.y2) &&
    r.x2 > r.x1 && r.y2 > r.y1
  );
  if (!valid.length) return null;
  return {
    x1: Math.min(...valid.map((r) => r.x1)),
    y1: Math.min(...valid.map((r) => r.y1)),
    x2: Math.max(...valid.map((r) => r.x2)),
    y2: Math.max(...valid.map((r) => r.y2)),
    count: valid.length
  };
}

// Cloudinary c_crop with explicit top-left + width/height. f_jpg + q_auto:good
// match the pad path's output profile so the caller downstream (Omni ref
// upload, buildReferenceImages) sees a consistent asset shape regardless of
// which strategy fired.
function buildCloudinaryCropUrl(sourceUrl, { x, y, w, h }) {
  if (!sourceUrl || typeof sourceUrl !== 'string') return null;
  if (!sourceUrl.includes('/image/upload/')) return null;
  return sourceUrl.replace(
    '/image/upload/',
    `/image/upload/c_crop,w_${Math.round(w)},h_${Math.round(h)},x_${Math.round(x)},y_${Math.round(y)},f_jpg,q_auto:good/`
  );
}

// Compute a target-aspect crop window that contains the subject union with
// CROP_SAFETY_MARGIN_PX breathing room, centered on the subject centroid,
// clamped to source bounds. Returns null when the subject won't fit — that
// includes the multi-subject lifestyle case where the union spans more of
// the abundant dimension than a target-aspect window has room for.
function computeCropRect({ sourceW, sourceH, targetAspect, subject }) {
  const sourceAspect = sourceW / sourceH;

  // Aspects match — no crop needed. Caller should have hit the 'skip' branch
  // upstream; guard here anyway so we don't emit a degenerate rect.
  if (Math.abs(sourceAspect - targetAspect) < 1e-9) return null;

  // Pick the abundant dimension: if the source is wider than the target, we
  // have surplus width to spend and keep source height; if it's taller, the
  // opposite. Both cases lose pixels rather than invent them.
  let cropW, cropH;
  if (sourceAspect > targetAspect) {
    cropH = sourceH;
    cropW = Math.round(sourceH * targetAspect);
  } else {
    cropW = sourceW;
    cropH = Math.round(sourceW / targetAspect);
  }

  // Sanity — the computed window must be smaller than the source in at
  // least the direction we're cropping (otherwise we'd need to invent).
  if (cropW > sourceW || cropH > sourceH) return null;

  // Expand the subject bbox by the safety margin, clamped to source.
  const sX1 = Math.max(0, subject.x1 - CROP_SAFETY_MARGIN_PX);
  const sY1 = Math.max(0, subject.y1 - CROP_SAFETY_MARGIN_PX);
  const sX2 = Math.min(sourceW, subject.x2 + CROP_SAFETY_MARGIN_PX);
  const sY2 = Math.min(sourceH, subject.y2 + CROP_SAFETY_MARGIN_PX);
  const subjW = sX2 - sX1;
  const subjH = sY2 - sY1;

  // Reject when the target-aspect window can't contain the padded subject
  // union in EITHER dimension. This is the b13-style failure mode: 4
  // people spanning 1370px horizontally cannot fit a 1135px-wide crop.
  if (cropW < subjW || cropH < subjH) return null;

  // Center the window on the subject centroid, clamp to source. Clamping is
  // load-bearing when the subject sits near a source edge — a naive centre
  // would emit a rect that extends beyond the image.
  const subjCenterX = (sX1 + sX2) / 2;
  const subjCenterY = (sY1 + sY2) / 2;
  let x = Math.round(subjCenterX - cropW / 2);
  let y = Math.round(subjCenterY - cropH / 2);
  x = Math.max(0, Math.min(sourceW - cropW, x));
  y = Math.max(0, Math.min(sourceH - cropH, y));

  return { x, y, w: cropW, h: cropH };
}

function chooseStrategy({ media, aspectRatio, sourceUrl }) {
  if (!isCropFirstEnabled()) {
    return { action: 'defer', reason: 'REFRAME_STRATEGY!=crop-first' };
  }

  const targetAspect = parseAspect(aspectRatio);
  if (!targetAspect) {
    return { action: 'defer', reason: `invalid target aspect '${aspectRatio}'` };
  }

  const sourceW = Number(media?.width);
  const sourceH = Number(media?.height);
  if (!(sourceW > 0 && sourceH > 0)) {
    return { action: 'defer', reason: 'source dims unknown' };
  }

  const sourceAspect = sourceW / sourceH;
  const retained = Math.min(sourceAspect, targetAspect) / Math.max(sourceAspect, targetAspect);

  if (retained >= ASPECT_MATCH_THRESHOLD) {
    return { action: 'skip', reason: `aspect match (retained=${retained.toFixed(3)})` };
  }

  const subject = subjectUnionBbox(media);
  if (!subject) {
    return { action: 'defer', reason: 'no YOLO subject bbox on media.refinedProducts[]' };
  }

  const rect = computeCropRect({ sourceW, sourceH, targetAspect, subject });
  if (!rect) {
    const subjW = subject.x2 - subject.x1;
    const subjH = subject.y2 - subject.y1;
    return {
      action: 'defer',
      reason: `subject union (${subject.count} bbox, ${subjW}×${subjH}) doesn't fit target-aspect crop window`,
      subjectUnion: subject
    };
  }

  const url = buildCloudinaryCropUrl(sourceUrl, rect);
  if (!url) {
    return { action: 'defer', reason: 'source URL not a Cloudinary /image/upload/ asset' };
  }

  return {
    action: 'crop',
    reason: `bbox-guided crop (${subject.count} detection${subject.count > 1 ? 's' : ''}, window ${rect.w}×${rect.h})`,
    rect,
    url,
    method: 'yolo-crop'
  };
}

module.exports = {
  chooseStrategy,
  isCropFirstEnabled,
  // Promoted from __test-only to a real consumer-facing export: the PMax
  // split-stage video decision layer (services/pmaxSplitStrategy.js) needs
  // the same YOLO subject-union math to decide which side of the frame the
  // product occupies, and re-deriving it there would let the two paths
  // silently disagree about what counts as "the subject" on the same Media
  // doc. __test.subjectUnionBbox below is left in place, unchanged, so
  // scripts/verifyReframeStrategy.js keeps working without modification.
  subjectUnionBbox,
  // Exported for scripts/verifyReframeStrategy.js — pure helpers so the
  // harness can drive them with fixtures rather than mock Mongoose.
  __test: {
    parseAspect,
    subjectUnionBbox,
    computeCropRect,
    buildCloudinaryCropUrl,
    ASPECT_MATCH_THRESHOLD,
    CROP_SAFETY_MARGIN_PX
  }
};
