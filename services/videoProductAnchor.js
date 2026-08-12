'use strict';
/**
 * videoProductAnchor — named product-region grounding for lifestyle video.
 *
 * Live defect (UGC lifestyle): a full-body seed with the product on the
 * lower half (track pants / sneakers) generated a face-seeking push-in
 * that cropped the product out. "The camera finds and holds the product"
 * is verbal only; video models default to faces.
 *
 * This module is the PROMPT-ANCHOR half only:
 *   1. Pick the detect box whose label matches the ad's product
 *      (matchedProducts FK with refinedProductId, else stemmed token
 *      overlap; ties → largest). Person-like boxes are never fallback
 *      candidates. A box covering >80% of the frame is rejected.
 *   2. Name that box as a coarse region ("lower half", "upper left third")
 *      — never raw pixel coords — for the lifestyle prompt.
 *
 * Crop-chooser wiring (seed-image boxes applied to generated-video dims)
 * is DEFERRED to its own change with explicit seed→video coordinate
 * mapping. chooseProductFirstCrop stays as a pure helper; basePlateCropService
 * is byte-identical to HEAD and does not consult this module.
 *
 * Kill switch VIDEO_PRODUCT_ANCHOR (default OFF). Flag-off is a no-op:
 * no prompt block. OMNI/GROK packshot prompts stay byte-identical
 * (B14 unmodified).
 *
 * Detect shapes used (verified 2026-08-12):
 *   Media.subjects[]          GPT: {id, role, description, x1,y1,x2,y2} 0..1
 *   Media.refinedProducts[]   YOLO refine: {id:'r1', label, confidence,
 *                             x1,y1,x2,y2} SOURCE PIXELS
 *   Media.matchedProducts[]   {refinedProductId, catalogProductId, outcome,
 *                             confidence, matchEvidenceArtifactId, source}
 */

const { centerOnBox, windowFor, unionBoxes } = require('./faceSafeCrop');

const ANCHOR_BLOCK_MAX_CHARS = 400;

function isVideoProductAnchorEnabled() {
  return process.env.VIDEO_PRODUCT_ANCHOR === 'true';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'and', 'for', 'with', 'from', 'this', 'that',
  'our', 'your', 'their', 'its', 'are', 'was', 'were', 'has', 'have', 'had',
  'but', 'not', 'you', 'all', 'any', 'can', 'men', 'mens', "men's", 'women',
  'womens', "women's", 'kids', 'size', 'new'
]);

const PERSON_RE = /\b(person|people|human|model|man|woman|face|body)\b/i;
const FULL_FRAME_AREA = 0.80;

function stemToken(t) {
  // Strip ONE trailing 's' from alphanumeric tokens >3 chars so
  // "pants"↔"pant" and "leggings"↔"legging" overlap.
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function tokenize(s) {
  // Hyphens split ("wide-leg" → wide, leg). Stopwords (incl. women's /
  // mens / men's / womens) are dropped on the raw token before stemming.
  const out = new Set();
  const parts = String(s || '')
    .toLowerCase()
    .replace(/-/g, ' ')
    .split(/\s+/);
  for (const part of parts) {
    if (!part || STOPWORDS.has(part)) continue;
    const alnum = part.replace(/[^a-z0-9]/g, '');
    if (!alnum || alnum.length <= 2 || STOPWORDS.has(alnum)) continue;
    out.add(stemToken(alnum));
  }
  return out;
}

function tokenOverlapScore(title, label) {
  const a = tokenize(title);
  const b = tokenize(label);
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of b) if (a.has(t)) n += 1;
  return n;
}

function boxArea(box) {
  if (!box) return 0;
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  return w > 0 && h > 0 ? w * h : 0;
}

function usableNormBox(b) {
  if (!b) return null;
  if (![b.left, b.top, b.right, b.bottom].every(Number.isFinite)) return null;
  if (b.right <= b.left || b.bottom <= b.top) return null;
  return {
    left: clamp01(b.left),
    top: clamp01(b.top),
    right: clamp01(b.right),
    bottom: clamp01(b.bottom)
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Normalize a detect box into {left,top,right,bottom} 0..1.
 * Accepts:
 *   - GPT subjects: x1,y1,x2,y2 already 0..1
 *   - refinedProducts / YOLO: x1,y1,x2,y2 in source pixels (needs media w/h)
 *   - bbox_pct: {x,y,w,h} 0..1
 *   - already-normalized {left,top,right,bottom}
 * Returns null when the box is unusable.
 */
function normalizeBbox(obj, media) {
  if (!obj || typeof obj !== 'object') return null;

  if (obj.bbox_pct && typeof obj.bbox_pct === 'object') {
    const p = obj.bbox_pct;
    const x = Number(p.x);
    const y = Number(p.y);
    const w = Number(p.w);
    const h = Number(p.h);
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
      return usableNormBox({ left: x, top: y, right: x + w, bottom: y + h });
    }
  }

  if ([obj.left, obj.top, obj.right, obj.bottom].every(Number.isFinite)) {
    return usableNormBox(obj);
  }

  const x1 = Number(obj.x1);
  const y1 = Number(obj.y1);
  const x2 = Number(obj.x2);
  const y2 = Number(obj.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;

  // Heuristic: values within ~[0, 1.05] are already normalized (GPT subjects).
  // Anything larger is source-pixel (refinedProducts / YOLO).
  const looksNormalized = x2 <= 1.05 && y2 <= 1.05 && x1 >= -0.05 && y1 >= -0.05;
  if (looksNormalized) {
    return usableNormBox({ left: x1, top: y1, right: x2, bottom: y2 });
  }

  const mw = Number(media?.width);
  const mh = Number(media?.height);
  if (!(mw > 0 && mh > 0)) return null;
  return usableNormBox({
    left: x1 / mw,
    top: y1 / mh,
    right: x2 / mw,
    bottom: y2 / mh
  });
}

/**
 * Coarse named region from a normalized box.
 * Halves when the box covers a substantial slice of one half;
 * otherwise the 3×3 centroid cell ("upper left third", "center", …).
 * Never returns pixel coordinates.
 */
function namedRegionFromBbox(boxIn, media) {
  const box = normalizeBbox(boxIn, media) || usableNormBox(boxIn);
  if (!box) return null;
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;

  const coversHorizHalf = w >= 0.5;
  const coversVertHalf = h >= 0.5;
  // Named-region halves require a decisive centroid (cy>=0.55 lower /
  // cy<=0.45 upper, same for cx). The 0.45–0.55 band falls through to
  // the thirds-based name — a box sitting on the midline is not a half.
  if (coversHorizHalf && cy >= 0.55) return 'lower half';
  if (coversHorizHalf && cy <= 0.45) return 'upper half';
  if (coversVertHalf && cx <= 0.45) return 'left half';
  if (coversVertHalf && cx >= 0.55) return 'right half';

  const row = cy < 1 / 3 ? 'upper' : cy > 2 / 3 ? 'lower' : null;
  const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : null;
  if (!row && !col) return 'center';
  if (row && !col) return `${row} third`;
  if (!row && col) return `${col} third`;
  return `${row} ${col} third`;
}

function candidateLabel(obj) {
  const raw = obj?.label || obj?.identification?.label || obj?.description || '';
  const s = String(raw).trim();
  return s || null;
}

function isPersonLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const fields = [obj.label, obj.identification && obj.identification.label, obj.description];
  return fields.some((f) => f != null && PERSON_RE.test(String(f)));
}

function collectCandidates(media, opts = {}) {
  const excludePerson = opts.excludePerson === true;
  const out = [];
  const refined = Array.isArray(media?.refinedProducts) ? media.refinedProducts : [];
  for (const rp of refined) {
    if (excludePerson && isPersonLike(rp)) continue;
    const box = normalizeBbox(rp, media);
    const label = candidateLabel(rp);
    if (!box || !label) continue;
    out.push({
      id: rp.id || null,
      label,
      box,
      source: 'refined',
      area: boxArea(box)
    });
  }
  const subjects = Array.isArray(media?.subjects) ? media.subjects : [];
  for (const s of subjects) {
    if (excludePerson && isPersonLike(s)) continue;
    const box = normalizeBbox(s, media);
    const label = candidateLabel(s);
    if (!box || !label) continue;
    out.push({
      id: s.id || null,
      label,
      box,
      source: 'subject',
      area: boxArea(box)
    });
  }
  return out;
}

function productIdOf({ ad, product }) {
  const raw = product?._id || ad?.productId || null;
  if (raw == null) return null;
  const s = String(raw);
  if (!s || s === 'undefined' || s === 'null') return null;
  return s;
}

/**
 * Prefer the detect pipeline's already-linked box when Media.matchedProducts
 * points this CatalogProduct at a refinedProductId.
 */
function exactMatchCandidate({ ad, product, media }, candidates) {
  const pid = productIdOf({ ad, product });
  if (!pid) return null;
  const matches = Array.isArray(media?.matchedProducts) ? media.matchedProducts : [];
  // Never .find() the first catalogProductId row blind — operator rows
  // often land first with refinedProductId: null and would swallow the
  // detect link sitting behind them.
  const hits = matches.filter((m) => m
    && m.refinedProductId != null
    && m.catalogProductId != null
    && String(m.catalogProductId) === pid);
  if (!hits.length) return null;
  const refined = Array.isArray(media?.refinedProducts) ? media.refinedProducts : [];
  for (const hit of hits) {
    const rpId = hit.refinedProductId;
    const fromList = candidates.find((c) => c.source === 'refined' && c.id === rpId);
    if (fromList) return fromList;
    const rp = refined.find((r) => r && r.id === rpId);
    if (!rp) continue;
    const box = normalizeBbox(rp, media);
    const label = candidateLabel(rp) || String(product?.title || '').trim() || null;
    if (!box || !label) continue;
    return { id: rp.id, label, box, source: 'match', area: boxArea(box) };
  }
  return null;
}

function bestOverlapCandidate(title, candidates) {
  const t = String(title || '').trim();
  if (!t || !candidates.length) return null;
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = tokenOverlapScore(t, c.label);
    if (score <= 0) continue;
    if (
      score > bestScore
      || (score === bestScore && best && c.area > best.area)
      || (score === bestScore && !best)
    ) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * Pure. Pick the subject/refined box for this ad's product.
 * @returns {{ label: string, region: string, box: object } | null}
 */
function productRegionForAd({ ad, product, media } = {}) {
  const title = String(product?.title || ad?.productTitle || '').trim();
  const all = collectCandidates(media);
  const fallback = collectCandidates(media, { excludePerson: true });
  const exact = exactMatchCandidate({ ad, product, media }, all);
  const winner = exact || bestOverlapCandidate(title, fallback);
  if (!winner) return null;
  // Full-frame guard: an anchor to "center" that covers the whole plate
  // reinforces nothing.
  if (boxArea(winner.box) > FULL_FRAME_AREA) return null;
  const region = namedRegionFromBbox(winner.box, media);
  if (!region) return null;
  // Guard: never leak a digit-looking coord into the named region.
  if (/\d/.test(region) && /px|coord|,/.test(region)) return null;
  return {
    label: sanitizeLabel(winner.label),
    region,
    box: winner.box
  };
}

function sanitizeLabel(label) {
  const s = String(label || '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'the product';
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/**
 * ONE lifestyle-prompt block. ≤400 chars. No pixel coords.
 */
function buildProductAnchorBlock({ label, region } = {}) {
  const lab = sanitizeLabel(label);
  const reg = String(region || '').trim();
  if (!reg || /\d{2,}/.test(reg)) return null;
  const block =
    `PRODUCT FRAME ANCHOR: The featured product is ${lab} at the ${reg}. ` +
    `It must remain fully in frame for the entire duration. ` +
    `Any push-in moves TOWARD it, never away. ` +
    `Faces may leave the frame; the product may not.`;
  if (block.length > ANCHOR_BLOCK_MAX_CHARS) return block.slice(0, ANCHOR_BLOCK_MAX_CHARS);
  return block;
}

function unionFitsWindow(union, win, sw, sh) {
  if (!union || !win) return false;
  const uw = (union.right - union.left) * sw;
  const uh = (union.bottom - union.top) * sh;
  return uw <= win.cw && uh <= win.ch;
}

/**
 * Product-first crop chooser (pure).
 *   product ∪ face when both fit the window;
 *   product box wins on conflict;
 *   product alone when there is no face;
 *   null when there is no usable product box (caller falls through to face-safe).
 *
 * @returns {{ cx, cy, cw, ch, anchorY: 'product'|'product-union' } | null}
 */
function chooseProductFirstCrop({
  sourceW, sourceH, wr, hr, productBox, faceBox
} = {}) {
  const product = usableNormBox(productBox);
  if (!product) return null;
  if (![sourceW, sourceH, wr, hr].every(Number.isFinite)
    || sourceW < 1 || sourceH < 1 || wr < 1 || hr < 1) {
    return null;
  }
  const win = windowFor(sourceW, sourceH, wr, hr);
  if (!win) return null;

  const face = usableNormBox(faceBox);
  if (face) {
    const union = unionBoxes([product, face]);
    if (union && unionFitsWindow(union, win, sourceW, sourceH)) {
      const rect = centerOnBox(sourceW, sourceH, wr, hr, union);
      if (rect) return { ...rect, anchorY: 'product-union' };
    }
  }
  const rect = centerOnBox(sourceW, sourceH, wr, hr, product);
  if (!rect) return null;
  return { ...rect, anchorY: 'product' };
}

module.exports = {
  isVideoProductAnchorEnabled,
  productRegionForAd,
  namedRegionFromBbox,
  normalizeBbox,
  tokenize,
  tokenOverlapScore,
  buildProductAnchorBlock,
  chooseProductFirstCrop,
  isPersonLike,
  ANCHOR_BLOCK_MAX_CHARS,
  FULL_FRAME_AREA
};
