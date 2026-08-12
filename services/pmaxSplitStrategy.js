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


// ── Density gate (Stage 3) ───────────────────────────────────────────────────
// Lives in this module, not its own file, because it is the same decision
// layer: chooseSubjectSide picks WHICH half carries copy, isCopyHalfCalm
// judges whether that half is fit to. Both are pure, both are consumed by the
// same split orchestrator, and keeping the panel-rect convention (east =>
// product right => panel left) in ONE place is what stops the two halves
// drifting into opposite definitions of a side.


// ── Thresholds (exported so the harness pins them, never re-literals) ──
//
// Density is 0 = empty/calm, 1 = busy (overlayZoneService densityGrid).
// Calm continued background from a well-behaved outfill sits ~0.0–0.2;
// clutter, a second product, or high-frequency detail push cells up.
//
// MEAN alone is not enough: a panel can average calm while one dense
// corner wrecks a line of type (the adversarial case the harness pins).
// PEAK (max cell in the panel) closes that hole. p90 was considered and
// rejected — on a ~24-cell half-panel a single 1.0 cell leaves p90 at the
// calm floor, so percentile-only would silently pass the adversarial case.
const COPY_HALF_MEAN_MAX = 0.32;
const COPY_HALF_PEAK_MAX = 0.55;

// Restriction overlap. rectPct is fractional over the whole frame; 0.005
// ≈ 0.5% of frame area. A product/face peeking into the copy half at that
// size is already enough to collide with type; smaller is noise/rounding.
const RESTRICTION_OVERLAP_MIN_AREA = 0.005;
// Non-hard classifications only fire above this strictness. product/face
// are hard regardless (they are the subjects type must never cover).
const RESTRICTION_STRICTNESS_MIN = 0.5;
const HARD_RESTRICTION_CLASSES = Object.freeze(['product', 'face']);

const DEFAULT_THRESHOLDS = Object.freeze({
  COPY_HALF_MEAN_MAX,
  COPY_HALF_PEAK_MAX,
  RESTRICTION_OVERLAP_MIN_AREA,
  RESTRICTION_STRICTNESS_MIN
});

/**
 * Copy-panel rect for a given subject side, in the same fractional
 * coordinate space as densityGrid / rectPct ((0,0) top-left → (1,1)
 * bottom-right — see overlayZoneService prompt contract).
 *
 * subjectSide is where the PRODUCT sits; the copy half is the opposite.
 * east → product right → panel left; west → product left → panel right.
 */
function copyPanelRectForSubjectSide(subjectSide) {
  if (subjectSide === 'east') return { x1: 0, y1: 0, x2: 0.5, y2: 1 };
  if (subjectSide === 'west') return { x1: 0.5, y1: 0, x2: 1, y2: 1 };
  return null;
}

/**
 * Is the panel half calm enough to carry composited copy without a scrim?
 *
 * Returns:
 *   { calm: true, mean, peak }
 *   { calm: false, reason, worstCell | offendingClassification, ... }
 *   { calm: null, reason }  — undecidable; caller degrades to the safe
 *                             brand_panel. NEVER silently "calm".
 *
 * Asymmetry (load-bearing): a false "calm" ships unreadable copy on a
 * ~$1 master; a false "not calm" only downgrades to the deterministic
 * brand-colour panel. Prefer the safe direction on any ambiguity.
 *
 * Total function: never throws.
 */
function isCopyHalfCalm(input) {
  try {
    // Default-param `= {}` does not catch an explicit null — destructuring
    // null throws, which would violate the total-function contract the
    // call site relies on (a $0.01 advisory must never kill the run).
    if (input == null || typeof input !== 'object') {
      return { calm: null, reason: 'malformed-input' };
    }
    const { densityGrid, restrictions, panelRectPct, thresholds } = input;
    const t = resolveThresholds(thresholds);
    const panel = normalizeRect(panelRectPct);
    // No usable panel geometry → cannot judge. Undecidable, not calm:
    // inventing a full-frame default would average the (busy, correct)
    // product half into the verdict — the exact bug this gate exists to
    // prevent.
    if (!panel) return { calm: null, reason: 'malformed-panel-rect' };

    // Restrictions first: a product/face rect in the copy half is a hard
    // no even when the density grid happens to look calm around it.
    const restrictionHit = findOffendingRestriction(restrictions, panel, t);
    if (restrictionHit) return restrictionHit;

    const sampled = samplePanelCellValues(densityGrid, panel);
    if (sampled == null) return { calm: null, reason: 'no-usable-grid' };
    if (sampled.length === 0) return { calm: null, reason: 'panel-covers-no-cells' };

    let sum = 0;
    let peak = 0;
    let peakRow = 0;
    let peakCol = 0;
    for (const cell of sampled) {
      if (!Number.isFinite(cell.value)) {
        // Non-finite density is not "0" and not "calm" — refuse to invent.
        return { calm: null, reason: 'non-finite-density' };
      }
      sum += cell.value;
      if (cell.value > peak) {
        peak = cell.value;
        peakRow = cell.row;
        peakCol = cell.col;
      }
    }
    const mean = sum / sampled.length;

    // Peak before mean: the adversarial "averages calm, locally busy"
    // case must fail even when mean is well under the mean cap.
    if (peak > t.COPY_HALF_PEAK_MAX) {
      return {
        calm: false,
        reason: 'peak-density',
        worstCell: { row: peakRow, col: peakCol, value: peak },
        mean,
        peak
      };
    }
    if (mean > t.COPY_HALF_MEAN_MAX) {
      return {
        calm: false,
        reason: 'mean-density',
        worstCell: { row: peakRow, col: peakCol, value: peak },
        mean,
        peak
      };
    }
    return { calm: true, mean, peak };
  } catch {
    return { calm: null, reason: 'decision-threw' };
  }
}

function resolveThresholds(overrides) {
  if (!overrides || typeof overrides !== 'object') return DEFAULT_THRESHOLDS;
  return {
    COPY_HALF_MEAN_MAX: numOr(overrides.COPY_HALF_MEAN_MAX, COPY_HALF_MEAN_MAX),
    COPY_HALF_PEAK_MAX: numOr(overrides.COPY_HALF_PEAK_MAX, COPY_HALF_PEAK_MAX),
    RESTRICTION_OVERLAP_MIN_AREA: numOr(
      overrides.RESTRICTION_OVERLAP_MIN_AREA, RESTRICTION_OVERLAP_MIN_AREA
    ),
    RESTRICTION_STRICTNESS_MIN: numOr(
      overrides.RESTRICTION_STRICTNESS_MIN, RESTRICTION_STRICTNESS_MIN
    )
  };
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRect(r) {
  if (!r || typeof r !== 'object') return null;
  const x1 = Number(r.x1);
  const y1 = Number(r.y1);
  const x2 = Number(r.x2);
  const y2 = Number(r.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  // Inverted / zero-area rects are malformed, not empty-calm.
  if (!(x2 > x1) || !(y2 > y1)) return null;
  return { x1, y1, x2, y2 };
}

function overlapArea(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (!(x2 > x1) || !(y2 > y1)) return 0;
  return (x2 - x1) * (y2 - y1);
}

/**
 * Sample density cells that intersect the panel.
 *
 * Grid orientation (must match overlayZoneService / computeBrightnessGrid):
 *   cells[row][col] — row 0 = top, col 0 = left
 *   cell (r,c) covers x∈[c/cols,(c+1)/cols], y∈[r/rows,(r+1)/rows]
 * Getting rows/cols backwards silently inverts the whole gate (a right
 * panel would read the left half's density).
 *
 * Returns null when the grid is unusable; [] when usable but no overlap.
 */
function samplePanelCellValues(densityGrid, panel) {
  if (!densityGrid || typeof densityGrid !== 'object') return null;
  const cells = densityGrid.cells;
  if (!Array.isArray(cells) || cells.length === 0) return null;

  // Prefer declared dims; fall back to the nested-array shape the service
  // actually emits. A mismatch is undecidable, not "trust the longer one".
  const rows = Number(densityGrid.rows) || cells.length;
  const cols = Number(densityGrid.cols) || (Array.isArray(cells[0]) ? cells[0].length : 0);
  if (!(rows > 0) || !(cols > 0)) return null;
  if (cells.length < rows) return null;

  const nested = Array.isArray(cells[0]);
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellRect = {
        x1: c / cols,
        y1: r / rows,
        x2: (c + 1) / cols,
        y2: (r + 1) / rows
      };
      // Any positive overlap counts the cell — edge cells that only
      // graze the panel midline still contribute density under type.
      if (overlapArea(panel, cellRect) <= 0) continue;
      let value;
      if (nested) {
        if (!Array.isArray(cells[r]) || cells[r].length < cols) return null;
        value = Number(cells[r][c]);
      } else {
        // Flat row-major fallback — same layout as brightness raw buffer.
        value = Number(cells[r * cols + c]);
      }
      out.push({ row: r, col: c, value });
    }
  }
  return out;
}

function findOffendingRestriction(restrictions, panel, t) {
  if (restrictions == null) return null;
  if (!Array.isArray(restrictions)) {
    // Malformed container — undecidable rather than "no restrictions".
    // Caller of isCopyHalfCalm will only see this if we return a calm:null
    // shape; surface it that way.
    return { calm: null, reason: 'malformed-restrictions' };
  }
  for (const r of restrictions) {
    if (!r || typeof r !== 'object') continue;
    const rr = normalizeRect(r.rectPct);
    if (!rr) continue; // skip one bad rect; do not fail the whole list
    const area = overlapArea(panel, rr);
    if (area < t.RESTRICTION_OVERLAP_MIN_AREA) continue;

    const cls = typeof r.classification === 'string' ? r.classification : 'other';
    const hard = HARD_RESTRICTION_CLASSES.includes(cls);
    if (hard) {
      return {
        calm: false,
        reason: 'restriction-overlap',
        offendingClassification: cls
      };
    }
    const strict = Number(r.strictness);
    if (Number.isFinite(strict) && strict >= t.RESTRICTION_STRICTNESS_MIN) {
      return {
        calm: false,
        reason: 'restriction-overlap',
        offendingClassification: cls
      };
    }
  }
  return null;
}

module.exports = {
  chooseSubjectSide,
  // Exported so the harness asserts against the same constants this module
  // actually uses, rather than hardcoding a duplicate that can drift.
  DEAD_ZONE_WIDTH,
  MAX_SUBJECT_WIDTH_FRACTION,
  // Density gate — scripts/verifyPmaxSplitDensityGate.js
  isCopyHalfCalm,
  copyPanelRectForSubjectSide,
  COPY_HALF_MEAN_MAX,
  COPY_HALF_PEAK_MAX,
  RESTRICTION_OVERLAP_MIN_AREA,
  RESTRICTION_STRICTNESS_MIN,
  HARD_RESTRICTION_CLASSES,
  DEFAULT_THRESHOLDS
};
