// PMax 16:9 split-stage video — subject-side decision layer.
//
// Stage 1 of the split-stage unit: the product is anchored to one side of a
// 16:9 frame and the OTHER side is generatively extended to carry copy.
// Before any pixel gets generated, something has to decide WHICH side the
// product already occupies — the extension must land on the side the
// product has actually vacated. Get it backwards and the "extension" paints
// over the product instead of empty space; get it wrong on a near-centered
// subject and the same product photo can flip which side gets the panel
// between otherwise-identical runs, which reads as a bug even though
// nothing about the source image changed.
//
// This module answers ONLY that question. It does not render, crop, call
// Atlas, or touch Mongo — see "Design constraints" below. Stage 1 ships
// this pure decision layer + a Director field (aiCreativeDirectorService's
// routing.panelTreatment) behind PMAX_SPLIT_VIDEO (default false); nothing
// in this file is wired into a live render path yet, so there is
// deliberately no env-flag check here — that belongs to whichever stage
// wires chooseSubjectSide into an actual pipeline and starts spending money
// on the generative extension.
//
// Design constraints:
//   1. PURE — no I/O, no DB, no fetch, no require of anything with side
//      effects. reframeStrategyChooser is required for subjectUnionBbox
//      ONLY, which is itself pure (see that module's own header). Every
//      input arrives on the args object; every output is on the return.
//      This lets scripts/verifyPmaxSplitSide.js pin behaviour on fixtures
//      with zero DB, zero YOLO, zero spend — the same posture
//      reframeStrategyChooser established for the reframe path.
//   2. FAIL-CLOSED to defer. Unknown/zero source dims, a missing YOLO
//      union, a degenerate bbox, or a subject that leaves no usable empty
//      half all return { side: null, panelSide: null, reason }. The caller
//      is expected to fall back to a centered-product treatment — a wrong
//      side choice ships a copy panel drawn over the product; a wrong
//      defer just forfeits the split-stage treatment for that asset.
//   3. TOTAL — chooseSubjectSide never throws. A malformed Media-shaped
//      object degrades to a deferral, not an exception, because this
//      function sits upstream of a render path that should not fall over
//      because one product's detection payload was empty or malformed.

'use strict';

const { subjectUnionBbox } = require('./reframeStrategyChooser');

// Centroid inside [0.5 - DEAD_ZONE_WIDTH/2, 0.5 + DEAD_ZONE_WIDTH/2] defers
// rather than picking a side. Two independent reasons:
//   1. STABILITY — a near-centered subject sits on a knife's edge where
//      ordinary YOLO box jitter between two runs of the SAME product photo
//      (re-detection after a re-crop, a model version bump, etc.) can tip
//      the centroid a few px either side of 0.5 and flip which half gets
//      the copy panel. Shipping visibly different creative for the same
//      product across runs reads as a bug even though nothing about the
//      product changed.
//   2. GEOMETRY — a subject straddling the centerline has no half of the
//      frame it has cleanly vacated; forcing a side would still require
//      the generative extension to paint through part of the subject's
//      own footprint on the "vacated" side.
// 0.10 total width (±0.05 around center) is deliberately narrow: it only
// needs to catch "basically centered", not "off to one side". A wider band
// would defer product photography that is genuinely off-center and forfeit
// real split-stage wins for no jitter-safety benefit.
const DEAD_ZONE_WIDTH = 0.10;

// A subject spanning more than this fraction of source width leaves no
// contiguous empty half to extend into — the "extension" would have to
// paint over real product pixels, which is the exact failure mode this
// unit exists to avoid (see reframeStrategyChooser's analogous
// CROP_SAFETY_MARGIN_PX / union-doesn't-fit deferral for the same family
// of failure on the reframe path). 0.55 rather than 0.50 gives a small
// margin: a subject that fills slightly over half the frame but is still
// clearly off-center (its own bbox isn't straddling the centerline) can
// still leave one side usable, but past ~55% there isn't enough
// contiguous room on either side to read as a panel rather than a sliver.
const MAX_SUBJECT_WIDTH_FRACTION = 0.55;

/**
 * Decide which side of a 16:9 frame the subject occupies.
 *
 * @param {object} opts
 * @param {object} opts.media — Media-doc-shaped object. Needs numeric
 *   width/height (source pixel dims, used to normalise the bbox into
 *   0..1 space) and refinedProducts[] (YOLO detections) for
 *   subjectUnionBbox to union into a single subject bbox.
 * @param {number} [opts.deadZone] — override DEAD_ZONE_WIDTH. Exists for
 *   the harness to assert the exact boundary math against a value it also
 *   controls; production callers should omit it and take the default.
 * @returns {{side:'east', panelSide:'west', centroidX:number}
 *         | {side:'west', panelSide:'east', centroidX:number}
 *         | {side:null,   panelSide:null,   reason:string}}
 *   `side` is where the SUBJECT ends up anchored. `panelSide` is always the
 *   OPPOSITE side — the vacated half where the generative extension and
 *   copy render. These are easy to invert; do not read them as the same
 *   thing under different names.
 */
function chooseSubjectSide(opts) {
  try {
    // Destructuring INSIDE the try, not in the parameter list: a bare
    // `{ media } = opts` parameter default only rescues a missing argument
    // (`chooseSubjectSide()`), not an explicit `null`/non-object one
    // (`chooseSubjectSide(null)`) — that form throws before the function
    // body, and therefore before the try/catch, ever runs. Total-function
    // callers can and do pass garbage; `opts || {}` here is what actually
    // makes every shape below fall through to the catch/defer paths instead
    // of throwing.
    const { media, deadZone = DEAD_ZONE_WIDTH } = opts || {};
    const width = Number(media?.width);
    const height = Number(media?.height);
    if (!(width > 0 && height > 0)) {
      return { side: null, panelSide: null, reason: 'source dims unknown or zero' };
    }

    // subjectUnionBbox is null-safe on a missing/malformed `media` and on
    // an empty/absent refinedProducts[] — see reframeStrategyChooser.js.
    const bbox = subjectUnionBbox(media);
    if (!bbox) {
      return { side: null, panelSide: null, reason: 'no YOLO subject bbox on media.refinedProducts[]' };
    }

    const { x1, x2 } = bbox;
    if (!(Number.isFinite(x1) && Number.isFinite(x2) && x2 > x1)) {
      return { side: null, panelSide: null, reason: 'degenerate subject bbox' };
    }

    const centroidX = ((x1 + x2) / 2) / width;

    const half = Number(deadZone) / 2;
    const deadZoneLo = 0.5 - half;
    const deadZoneHi = 0.5 + half;
    // Inclusive on both edges — a subject sitting EXACTLY on the boundary
    // is the case the margin exists to catch, not a coin flip to resolve.
    if (centroidX >= deadZoneLo && centroidX <= deadZoneHi) {
      return {
        side: null,
        panelSide: null,
        reason: `subject centroid ${centroidX.toFixed(3)} inside dead zone [${deadZoneLo.toFixed(3)}, ${deadZoneHi.toFixed(3)}] — near-centered subject would flip sides on detection jitter, and can't cleanly vacate either half`
      };
    }

    const subjectWidthFraction = (x2 - x1) / width;
    if (subjectWidthFraction > MAX_SUBJECT_WIDTH_FRACTION) {
      return {
        side: null,
        panelSide: null,
        reason: `subject spans ${(subjectWidthFraction * 100).toFixed(1)}% of source width, over the ${(MAX_SUBJECT_WIDTH_FRACTION * 100).toFixed(0)}% cap — no usable empty half to extend into`
      };
    }

    // Subject right of center → anchor it EAST; the vacated WEST half gets
    // the copy panel. Left of center is the mirror image. (Easy to invert:
    // `side` is the SUBJECT's side, `panelSide` is the OTHER one.)
    if (centroidX > 0.5) {
      return { side: 'east', panelSide: 'west', centroidX };
    }
    return { side: 'west', panelSide: 'east', centroidX };
  } catch (err) {
    // Total function — never throws. A malformed upstream Media doc must
    // fall back to the caller's centered-product treatment, not take down
    // whatever render path calls this.
    return { side: null, panelSide: null, reason: `chooseSubjectSide threw: ${err.message}` };
  }
}

module.exports = {
  chooseSubjectSide,
  // Exported so the harness asserts against the same constants this module
  // actually uses, rather than hardcoding a duplicate that can drift.
  DEAD_ZONE_WIDTH,
  MAX_SUBJECT_WIDTH_FRACTION
};
