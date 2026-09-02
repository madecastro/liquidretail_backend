// DINO-derived overlay zone analysis — reproject the already-computed
// YOLO/Grounding-DINO bboxes from Media.refinedProducts into each crop's
// local coordinate space and emit an OverlayZoneArtifact-shape output
// WITHOUT the Gemini vision call.
//
// Why this exists: overlayZoneService.analyzeOverlayZones was the single
// largest cost line during ingest — measured 2026-09-02 on Pelagic Gear
// resync as $143 (64% of the $223 total ingest spend) across 3641
// gemini-2.5-pro calls averaging 49.8s each. The Gemini pass takes the
// already-cropped image and re-detects subjects; the DINO pass has
// already detected the same subjects on the source (that's what YOLO +
// Grounding DINO run during detect's earlier stages). Everything Gemini
// tells us about `restrictions[]` is derivable from DINO bboxes plus a
// classification mapping — for $0.
//
// Design constraints:
//   1. PURE MATH + one sharp brightnessGrid call. No axios fetch, no
//      LLM, no external services. Only I/O is the image buffer for
//      brightnessGrid (reused from the Gemini path via computeBrightness
//      Grid, injected by the caller so this file has zero sharp deps).
//   2. OUTPUT SHAPE identical to overlayZoneService's analyzeOverlayZones
//      response: { schemaVersion, imageWidth, imageHeight, densityGrid,
//      brightnessGrid, restrictions[], primarySubjectRectPct }. Downstream
//      consumers (aiCanvasInputBuilder, adSuitabilityService) read that
//      shape without knowing which provider produced it. Only the
//      schemaVersion differs so an audit can tell them apart.
//   3. FAIL-CLOSED to null. Missing refinedProducts, missing crop rect,
//      or downstream error → returns null. The caller treats null as
//      "no overlay signal" the same way it does a Gemini call failure.
//
// What we lose vs Gemini:
//   - On-product text detection (woven labels, hang tags, embossed
//     logos). Add-back path: hybrid mode running a cheap OCR (Tesseract
//     local) alongside this — deferred, not this file's job.
//   - Fine density smoothness. Gemini's density reads texture "busy-ness"
//     even in cells without a bbox; DINO's density is boxier because it
//     comes purely from bbox coverage. Acceptable for the vast majority
//     of layouts — the ad overlay usually lands outside product bboxes
//     regardless of the density smoothness.
//   - Background scene text (signage in the frame). Same OCR add-back.

'use strict';

const SCHEMA_VERSION = '3.0-dino';
const RESTRICTION_CLASSES = ['product', 'face', 'secondary_subject', 'text', 'object', 'other'];

// Default grid dimensions matching the Gemini prompt's guidance:
//   "8×6 for landscape, 6×8 for portrait, 6×10 for very tall (9:16)"
// Callers may override via the `grid` param.
function pickGridDims(ratio) {
  const r = String(ratio || '').trim();
  if (r === '9:16' || r === '4:5' || r === '3:4') return { cols: 6, rows: 10 };
  if (r === '1:1') return { cols: 6, rows: 6 };
  return { cols: 8, rows: 6 };
}

// DINO label classification — maps a raw label to {classification,
// strictness}. The primary subject (product) is set by the CALLER via
// isPrimarySubject rather than string matching, since DINO's product
// labels are open-vocabulary (e.g. "PELAGIC Freespool", "hooded fishing
// shirt") and matching against a canonical taxonomy here would be brittle.
//
// The pattern set below handles the common non-product cases YOLO
// (default COCO enum) surfaces:
//   - face → strictness 0.9 (protect faces from overlay)
//   - person / human / body → 0.7 (secondary subject)
//   - text markers ("label", "logo", "tag", "sign") → 0.5
//   - everything else → 0.3 (object)
//
// Order matters — earlier entries win. A DINO label like "person's face"
// would match the face pattern before the person pattern.
const LABEL_PATTERNS = [
  { re: /\b(face|eye|eyes|head)\b/i,                                   cls: 'face',              strictness: 0.9 },
  { re: /\b(person|human|man|woman|body|torso|people|kid|child|baby)\b/i, cls: 'secondary_subject', strictness: 0.7 },
  { re: /\b(text|label|logo|tag|writing|sign|badge|emblem)\b/i,        cls: 'text',              strictness: 0.5 }
];

function classifyDinoLabel(rawLabel) {
  const label = String(rawLabel || '').trim();
  if (!label) return { cls: 'object', strictness: 0.3 };
  for (const p of LABEL_PATTERNS) {
    if (p.re.test(label)) return { cls: p.cls, strictness: p.strictness };
  }
  return { cls: 'object', strictness: 0.3 };
}

// Reproject a source-coord bbox to fractional (0..1) crop coordinates.
//
// bbox: { x1, y1, x2, y2 } in source pixels
// cropRect: { x1, y1, x2, y2 } in source pixels — the crop rectangle
//   inside the source image (top-left inclusive, bottom-right exclusive).
//
// Returns { x1, y1, x2, y2 } in [0..1] crop-local fractions, or null
// when the bbox is entirely outside the crop OR the intersection is
// degenerate. Callers filter out the null slots — a null-intersection
// bbox has nothing to overlay-restrict inside the crop anyway.
function reprojectBboxToCrop(bbox, cropRect) {
  if (!bbox || !cropRect) return null;
  const cropX = Math.min(cropRect.x1, cropRect.x2);
  const cropY = Math.min(cropRect.y1, cropRect.y2);
  const cropW = Math.abs(cropRect.x2 - cropRect.x1);
  const cropH = Math.abs(cropRect.y2 - cropRect.y1);
  if (!(cropW > 0 && cropH > 0)) return null;

  // Intersect the source-space bbox with the crop rect
  const ix1 = Math.max(bbox.x1, cropX);
  const iy1 = Math.max(bbox.y1, cropY);
  const ix2 = Math.min(bbox.x2, cropX + cropW);
  const iy2 = Math.min(bbox.y2, cropY + cropH);
  if (ix2 <= ix1 || iy2 <= iy1) return null;

  // Translate to crop-local coords, normalize to [0..1].
  return {
    x1: clamp01((ix1 - cropX) / cropW),
    y1: clamp01((iy1 - cropY) / cropH),
    x2: clamp01((ix2 - cropX) / cropW),
    y2: clamp01((iy2 - cropY) / cropH)
  };
}

// Build a density grid from a set of already-crop-normalized bboxes.
// Each cell's value = fraction of the cell area covered by ANY bbox,
// capped at 1.0 (overlapping bboxes don't stack).
function buildDensityGrid(bboxesPct, cols, rows) {
  if (!(cols > 0 && rows > 0)) return { cols: 0, rows: 0, cells: [] };
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  const cellArea = cellW * cellH;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const rowCells = [];
    const cellY1 = r * cellH;
    const cellY2 = cellY1 + cellH;
    for (let c = 0; c < cols; c++) {
      const cellX1 = c * cellW;
      const cellX2 = cellX1 + cellW;
      let covered = 0;
      for (const b of bboxesPct) {
        const ix1 = Math.max(b.x1, cellX1), iy1 = Math.max(b.y1, cellY1);
        const ix2 = Math.min(b.x2, cellX2), iy2 = Math.min(b.y2, cellY2);
        if (ix2 > ix1 && iy2 > iy1) covered += (ix2 - ix1) * (iy2 - iy1);
      }
      // 1-decimal precision, matching the Gemini prompt's "0.0 to 1.0 rounded to 1 decimal"
      rowCells.push(Math.round(Math.min(1, covered / cellArea) * 10) / 10);
    }
    cells.push(rowCells);
  }
  return { cols, rows, cells };
}

// Extract the primary-subject rect for the artifact's hot-path field.
// The prompt contract with the Gemini path guarantees exactly one
// restriction with classification='product' and strictness=1.0 covering
// the primary product. DINO path preserves the same guarantee by having
// the caller pass primarySubjectId; every non-primary bbox is
// classified by label pattern above.
function derivePrimarySubjectRectPct(restrictions) {
  const products = (restrictions || [])
    .filter((r) => r.classification === 'product')
    .sort((a, b) => (b.strictness || 0) - (a.strictness || 0));
  return products[0]?.rectPct || null;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Analyze overlay zones for one crop using DINO-derived bboxes.
 *
 * Inputs:
 *   refinedProducts — Media.refinedProducts[], per-detection bboxes in
 *                     SOURCE-image pixel coordinates. May include a
 *                     `label` (string) and optional `id` field the
 *                     caller uses to identify the primary subject.
 *   cropRect        — { x1, y1, x2, y2 } in SOURCE pixels — the crop
 *                     rectangle this analysis covers. Comes from the
 *                     judge-picked smart-crop winner for the ratio.
 *   primarySubjectId — the refinedProducts entry (by .id) that
 *                     represents the primary product — always emitted
 *                     as classification='product' strictness=1.0.
 *                     When null, the LARGEST bbox is treated as primary.
 *   ratio           — target aspect string (e.g. '5:4'). Drives default
 *                     grid dimensions unless `grid` is passed explicitly.
 *   grid            — optional { cols, rows } override.
 *   brightnessGrid  — the { cols, rows, cells } result from
 *                     overlayZoneService.computeBrightnessGrid on the
 *                     crop's image buffer. Injected by the caller so
 *                     this file has no sharp dependency.
 *   forbiddenRectsPct — same shape as the Gemini path. Injected as
 *                     hard-rule (strictness=1.0) restrictions before
 *                     bbox-derived ones.
 *   imageWidth / imageHeight — from the crop image's own dimensions;
 *                     forwarded to the artifact so consumers can compute
 *                     pixel-exact overlap math without a second sharp
 *                     probe.
 *
 * Returns the same shape overlayZoneService.analyzeOverlayZones returns,
 * or null on inputs missing enough signal (no refinedProducts, no
 * cropRect, degenerate crop).
 */
function analyzeFromRefinedProducts({
  refinedProducts,
  cropRect,
  primarySubjectId = null,
  ratio,
  grid = null,
  brightnessGrid = null,
  forbiddenRectsPct = null,
  imageWidth = null,
  imageHeight = null,
  label = 'dino'
}) {
  if (!Array.isArray(refinedProducts) || !refinedProducts.length) {
    return null;
  }
  if (!cropRect || !Number.isFinite(cropRect.x1) || !Number.isFinite(cropRect.x2)) {
    return null;
  }

  const t0 = Date.now();

  // Pick the primary subject id — passed explicitly, or fall back to
  // the largest bbox by source-pixel area. "Largest" is a heuristic
  // that matches the Gemini prompt's contract ("the primary product or
  // primary subject") in the common single-product frame.
  let effectivePrimaryId = primarySubjectId;
  if (!effectivePrimaryId) {
    let largest = null, largestArea = 0;
    for (const rp of refinedProducts) {
      if (!Number.isFinite(rp?.x1)) continue;
      const w = Math.max(0, (rp.x2 || 0) - rp.x1);
      const h = Math.max(0, (rp.y2 || 0) - rp.y1);
      const area = w * h;
      if (area > largestArea) { largestArea = area; largest = rp; }
    }
    effectivePrimaryId = largest?.id || null;
  }

  const restrictions = [];
  const bboxesPct = [];

  // Caller-supplied forbidden rects (video cross-frame motion,
  // platform UI bands). Emit first so they anchor the top of the list
  // — same ordering the Gemini path produces via prompt.
  if (Array.isArray(forbiddenRectsPct) && forbiddenRectsPct.length) {
    for (const r of forbiddenRectsPct) {
      if (!Number.isFinite(r?.x1)) continue;
      const rect = {
        x1: clamp01(r.x1), y1: clamp01(r.y1),
        x2: clamp01(r.x2), y2: clamp01(r.y2)
      };
      if (rect.x2 <= rect.x1 || rect.y2 <= rect.y1) continue;
      restrictions.push({
        rectPct:        rect,
        classification: 'other',
        strictness:     1.0,
        reason:         r.reason || 'caller-supplied forbidden region'
      });
      bboxesPct.push(rect);
    }
  }

  // Reproject each DINO bbox to crop coords and classify.
  for (const rp of refinedProducts) {
    if (!Number.isFinite(rp?.x1)) continue;
    const rectPct = reprojectBboxToCrop(rp, cropRect);
    if (!rectPct) continue;

    const isPrimary = effectivePrimaryId && rp.id === effectivePrimaryId;
    const { cls, strictness } = isPrimary
      ? { cls: 'product', strictness: 1.0 }
      : classifyDinoLabel(rp.label);

    const reasonBase = isPrimary
      ? `primary subject: DINO detected "${rp.label || 'product'}"`
      : `DINO detected "${rp.label || 'object'}"`;
    const conf = Number(rp.confidence);
    const reason = Number.isFinite(conf)
      ? `${reasonBase} (confidence ${conf.toFixed(2)})`
      : reasonBase;

    restrictions.push({ rectPct, classification: cls, strictness, reason });
    bboxesPct.push(rectPct);
  }

  // Grid dims: caller override wins; else infer from ratio.
  const dims = grid && grid.cols > 0 && grid.rows > 0
    ? { cols: grid.cols, rows: grid.rows }
    : pickGridDims(ratio);
  const densityGrid = buildDensityGrid(bboxesPct, dims.cols, dims.rows);

  // brightnessGrid falls back to an empty grid of the right shape when
  // the caller couldn't compute one (no image buffer available). Same
  // shape the Gemini path emits on brightness failure.
  const brightness = brightnessGrid && brightnessGrid.cells && brightnessGrid.cells.length
    ? brightnessGrid
    : { cols: dims.cols, rows: dims.rows, cells: [] };

  const stamped = {
    schemaVersion:         SCHEMA_VERSION,
    imageWidth,
    imageHeight,
    densityGrid,
    brightnessGrid: brightness,
    restrictions,
    primarySubjectRectPct: derivePrimarySubjectRectPct(restrictions)
  };

  const hard = restrictions.filter((r) => r.strictness >= 0.9).length;
  console.log(
    `   ✓ overlay-zones[${label}] (dino): ${restrictions.length} restriction(s) (${hard} hard) ` +
    `${imageWidth || '?'}x${imageHeight || '?'} density-grid ${dims.cols}x${dims.rows} in ${Date.now() - t0}ms`
  );
  return stamped;
}

module.exports = {
  analyzeFromRefinedProducts,
  // Exported for scripts/verifyDinoOverlayZones.js — pure helpers so the
  // harness can drive them with fixtures instead of a full Media context.
  __test: {
    reprojectBboxToCrop,
    buildDensityGrid,
    classifyDinoLabel,
    pickGridDims,
    derivePrimarySubjectRectPct,
    SCHEMA_VERSION,
    RESTRICTION_CLASSES,
    LABEL_PATTERNS
  }
};
