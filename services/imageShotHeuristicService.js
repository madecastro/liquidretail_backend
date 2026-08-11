// Zero-cost packshot-vs-lifestyle classifier for catalog / Media-library images.
//
// Uses only `sharp` on a buffer already held in memory — no LLM, no network,
// no Cloudinary transform, no billable anything. Target: well under ~20ms per
// image on a downscaled working copy.
//
// Mirrors imageQualityService.computeFocus contract:
//   - returns a result object on success
//   - returns null on any failure (never throws)
//   - best-effort; a miss must never fail a DetectRun
//
// Persistence lives under Media.technicalInsights (shotStyle / Confidence /
// Metrics). This is deliberately SEPARATE from classification.shotType, which
// is LLM-written by subjectTextService and already consumed by seed ranking
// and the Director. Keeping them independent is what makes calibration
// (scripts/calibrateShotHeuristic.js) possible.
//
// Downstream callers should use resolveSeedStyle(media) rather than re-deciding
// precedence: LLM classification.shotType wins when present and not 'unknown';
// else the heuristic; else 'unknown'.

'use strict';

const sharp = require('sharp');

// ── Thresholds ──────────────────────────────────────────────────────────────
// INITIAL, UNTUNED starting points — not measured against production labels.
// Tune via scripts/calibrateShotHeuristic.js (read-only agreement matrix +
// metric distributions on disagreements). Do not overclaim accuracy.
//
// Rationale for the rough magnitudes (intuition only, not validation):
//   - borderStdev is the dominant signal. A seamless white/grey/solid studio
//     backdrop has near-zero border variance; a real scene does not.
//   - entropy from sharp.stats() is corroborating: solid backdrops are low-
//     entropy; busy scenes are higher. Verified present on sharp@0.33.5 as
//     a top-level `stats().entropy` number (Shannon-ish, roughly 0..~8 for
//     8-bit images). If a future sharp drops the field we fall back gracefully.
//   - centre-vs-border ratio catches the "product on empty field" shape even
//     when the border is not pure white.
//   - bright border is a BOOST only — solid black/coloured packshots must
//     still classify as packshot (polarity trap).
const SHOT_STYLE_THRESHOLDS = {
  // Working-copy max width. Full-res is noise-dominated and slow.
  WORK_WIDTH: 256,
  // Outer ring as a fraction of min(w,h). ~12% captures the classic seamless
  // studio edge without swallowing the product on tight product-only crops.
  BORDER_FRAC: 0.12,
  // Centre square as a fraction of each axis (centred).
  CENTRE_FRAC: 0.50,

  // Greyscale border stdev (0..255). Below PACKSHOT → strong packshot pull;
  // at/above LIFESTYLE → strong lifestyle pull. Between = soft.
  BORDER_STDEV_PACKSHOT: 12,
  BORDER_STDEV_LIFESTYLE: 35,

  // sharp.stats().entropy corroboration. Low → packshot-ish.
  ENTROPY_PACKSHOT: 4.5,
  ENTROPY_LIFESTYLE: 7.0,

  // centreStdev / max(borderStdev, eps). Packshots concentrate detail
  // centrally against an empty border; lifestyle has busy borders too.
  CENTRE_BORDER_RATIO_PACKSHOT: 3.0,

  // Bright seamless (white sweep) corroborating boost — NOT a requirement.
  BORDER_MEAN_BRIGHT: 200, // 0..255
  BRIGHT_BOOST: 0.08,

  // Combined score cut-points. score ∈ [0,1], higher = more packshot-like.
  // Between LIFESTYLE and PACKSHOT → 'ambiguous' (the real middle band:
  // product on a wooden table, textured backdrop, etc.).
  SCORE_PACKSHOT: 0.62,
  SCORE_LIFESTYLE: 0.38,

  // Weights — border uniformity is the dominant signal by design.
  W_BORDER: 0.55,
  W_ENTROPY: 0.25,
  W_RATIO: 0.20
};

// LLM shotType → coarse seed style. Used only by resolveSeedStyle.
const LLM_LIFESTYLE = new Set(['lifestyle', 'on_model']);
const LLM_PACKSHOT  = new Set(['product_only', 'flat_lay', 'detail', 'packaging']);

// Default ON: free, non-billable sharp work. Only an explicit string 'false'
// (case-insensitive) disables — strict-string convention used across the repo
// for default-true flags (see titlingResumeService / metaAdsFontService).
function isEnabled() {
  return String(process.env.CATALOG_SHOT_HEURISTIC_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Classify a product image as packshot / lifestyle / ambiguous from a buffer.
 * Returns null on any failure (never throws) — mirrors computeFocus.
 *
 * @param {Buffer} buffer
 * @returns {Promise<null | {
 *   style: 'packshot'|'lifestyle'|'ambiguous',
 *   confidence: number,
 *   metrics: object
 * }>}
 */
async function classifyShotStyle(buffer) {
  if (!buffer || !buffer.length) return null;
  try {
    const T = SHOT_STYLE_THRESHOLDS;
    const base = sharp(buffer)
      .rotate() // honour EXIF orientation so border bands match visual edges
      .resize({ width: T.WORK_WIDTH, withoutEnlargement: true })
      .removeAlpha();

    // stats() + greyscale raw on the same working copy. clone() so both arms
    // share the decode/resize without a second full pipeline from the input.
    const [stats, grey] = await Promise.all([
      base.clone().stats(),
      base.clone().greyscale().raw().toBuffer({ resolveWithObject: true })
    ]);

    const { data, info } = grey;
    const w = info.width | 0;
    const h = info.height | 0;
    const n = w * h;
    if (!n || data.length < n) return null;

    const borderPx = Math.max(1, Math.round(Math.min(w, h) * T.BORDER_FRAC));
    const centreW  = Math.max(1, Math.round(w * T.CENTRE_FRAC));
    const centreH  = Math.max(1, Math.round(h * T.CENTRE_FRAC));
    const cx0 = Math.floor((w - centreW) / 2);
    const cy0 = Math.floor((h - centreH) / 2);
    const cx1 = cx0 + centreW;
    const cy1 = cy0 + centreH;

    // Single pass: Welford mean+variance for border and centre luminance.
    let bCount = 0, bMean = 0, bM2 = 0;
    let cCount = 0, cMean = 0, cM2 = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const onBorderY = y < borderPx || y >= h - borderPx;
      for (let x = 0; x < w; x++) {
        const v = data[row + x];
        const onBorder = onBorderY || x < borderPx || x >= w - borderPx;
        if (onBorder) {
          bCount++;
          const d = v - bMean;
          bMean += d / bCount;
          bM2 += d * (v - bMean);
        }
        if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
          cCount++;
          const d = v - cMean;
          cMean += d / cCount;
          cM2 += d * (v - cMean);
        }
      }
    }
    if (bCount < 8 || cCount < 8) return null;

    const borderStdev = Math.sqrt(bM2 / bCount);
    const centreStdev = Math.sqrt(cM2 / cCount);
    const borderMean  = bMean;
    const centreMean  = cMean;
    const eps = 1e-3;
    const centreBorderRatio = centreStdev / Math.max(borderStdev, eps);

    // sharp@0.33.5 exposes top-level `entropy`. Guard the field so a future
    // sharp that drops/renames it does not break the classifier — we just
    // reweight without the entropy term.
    const entropy = (stats && typeof stats.entropy === 'number' && Number.isFinite(stats.entropy))
      ? stats.entropy
      : null;

    // ── Per-signal packshot-likeness in [0,1] ────────────────────────────
    // Border uniformity (dominant): 1 at stdev=0, 0 at/above LIFESTYLE thr.
    const borderUniform = clamp01(1 - borderStdev / T.BORDER_STDEV_LIFESTYLE);

    // Entropy: low → packshot. Soft-linear between PACKSHOT and LIFESTYLE thr.
    let entropyPack = 0.5; // neutral when unavailable
    let entropyAvailable = false;
    if (entropy != null) {
      entropyAvailable = true;
      const span = Math.max(T.ENTROPY_LIFESTYLE - T.ENTROPY_PACKSHOT, eps);
      entropyPack = clamp01((T.ENTROPY_LIFESTYLE - entropy) / span);
    }

    // Centre-vs-border: ratio ≥ PACKSHOT thr → 1; ratio ≤ 1 → 0.
    const ratioSpan = Math.max(T.CENTRE_BORDER_RATIO_PACKSHOT - 1, eps);
    const ratioPack = clamp01((centreBorderRatio - 1) / ratioSpan);

    // Weighted blend. When entropy is missing, fold its weight into border
    // so the dominant signal still drives the decision.
    let wBorder = T.W_BORDER;
    let wEntropy = T.W_ENTROPY;
    let wRatio = T.W_RATIO;
    if (!entropyAvailable) {
      wBorder += wEntropy;
      wEntropy = 0;
    }
    let packshotScore = wBorder * borderUniform + wEntropy * entropyPack + wRatio * ratioPack;

    // Bright border is a corroborating BOOST only — applied when the border
    // is already fairly uniform. Solid black/coloured packshots stay packshot
    // without it (polarity trap).
    const brightBoostApplied =
      borderUniform >= 0.7 && borderMean >= T.BORDER_MEAN_BRIGHT;
    if (brightBoostApplied) {
      packshotScore = clamp01(packshotScore + T.BRIGHT_BOOST);
    } else {
      packshotScore = clamp01(packshotScore);
    }

    let style;
    if (packshotScore >= T.SCORE_PACKSHOT) style = 'packshot';
    else if (packshotScore <= T.SCORE_LIFESTYLE) style = 'lifestyle';
    else style = 'ambiguous';

    // Confidence: how far the score sits from the ambiguous mid-band.
    // Clear packshot/lifestyle → high; mid-band → low.
    const mid = (T.SCORE_PACKSHOT + T.SCORE_LIFESTYLE) / 2;
    const halfBand = Math.max((T.SCORE_PACKSHOT - T.SCORE_LIFESTYLE) / 2, eps);
    // Distance past the nearer cut-point, scaled into ~0.5..1 for decisive
    // labels and ~0..0.5 inside the ambiguous band.
    let confidence;
    if (style === 'ambiguous') {
      confidence = clamp01(0.5 - Math.abs(packshotScore - mid) / (2 * halfBand) * 0.5);
      // Keep a floor so ambiguous is never "zero confidence, no signal".
      confidence = Math.max(0.15, Math.min(0.55, confidence));
    } else {
      const cut = style === 'packshot' ? T.SCORE_PACKSHOT : T.SCORE_LIFESTYLE;
      const beyond = Math.abs(packshotScore - cut);
      const room = style === 'packshot'
        ? Math.max(1 - T.SCORE_PACKSHOT, eps)
        : Math.max(T.SCORE_LIFESTYLE, eps);
      confidence = clamp01(0.55 + 0.45 * (beyond / room));
    }

    return {
      style,
      confidence: round4(confidence),
      metrics: {
        borderMean: round4(borderMean),
        borderStdev: round4(borderStdev),
        centreMean: round4(centreMean),
        centreStdev: round4(centreStdev),
        centreBorderRatio: round4(centreBorderRatio),
        entropy: entropy == null ? null : round4(entropy),
        entropyAvailable,
        borderUniform: round4(borderUniform),
        entropyPack: round4(entropyPack),
        ratioPack: round4(ratioPack),
        packshotScore: round4(packshotScore),
        brightBoostApplied,
        workWidth: w,
        workHeight: h,
        borderPx,
        borderSampleCount: bCount,
        centreSampleCount: cCount
      }
    };
  } catch (err) {
    console.warn(`   ⚠️  imageShotHeuristic.classifyShotStyle failed: ${err.message}`);
    return null;
  }
}

/**
 * Single source of truth for seed-style consumers.
 *
 * Precedence (documented, load-bearing for calibration) — UNCHANGED for
 * the Media form; product form only adds a pre-Media fallback:
 *   1. LLM classification.shotType wins when present and not 'unknown'
 *      (semantic signal already trusted by shotTypeRank / Director).
 *      Map: lifestyle|on_model → 'lifestyle';
 *           product_only|flat_lay|detail|packaging → 'packshot'.
 *   2. Else heuristic Media.technicalInsights.shotStyle when present.
 *   3. Else CatalogProduct.imageShotStyles entry for the given URL
 *      (ingest-time sharp; URL-keyed — see ingestShotClassifyService).
 *   4. Else 'unknown'.
 *
 * Overloads:
 *   resolveSeedStyle(media)
 *   resolveSeedStyle(product, imageUrl)
 *   resolveSeedStyle({ media, product, url })
 *
 * The heuristic's job is to cover gaps (Media that never got a DetectRun /
 * subject-text classification) and to be calibrated AGAINST the LLM label —
 * not to override it.
 *
 * @returns {'lifestyle'|'packshot'|'ambiguous'|'unknown'}
 */
function resolveSeedStyle(arg, maybeUrl) {
  let media = null;
  let product = null;
  let url = null;

  if (arg != null && typeof arg === 'object' && !Array.isArray(arg)) {
    // Named-object form: { media, product, url }
    if (
      Object.prototype.hasOwnProperty.call(arg, 'media') ||
      (Object.prototype.hasOwnProperty.call(arg, 'product') &&
        Object.prototype.hasOwnProperty.call(arg, 'url'))
    ) {
      media = arg.media || null;
      product = arg.product || null;
      url = arg.url || maybeUrl || null;
    } else if (typeof maybeUrl === 'string') {
      // product + url form (CatalogProduct has imageShotStyles / imageUrl)
      product = arg;
      url = maybeUrl;
      // Defensive: if the first arg is actually a Media doc, still honour LLM.
      media = arg;
    } else {
      // Media form (legacy)
      media = arg;
    }
  }

  // 1–2. Media path (LLM → technicalInsights heuristic)
  const fromMedia = resolveFromMedia(media);
  if (fromMedia !== 'unknown') return fromMedia;

  // 3. CatalogProduct URL-keyed ingest styles (pre-Media seed selection)
  if (product && url) {
    const entries = product.imageShotStyles;
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (e && e.url === url && (e.style === 'packshot' || e.style === 'lifestyle' || e.style === 'ambiguous')) {
          return e.style;
        }
      }
    }
  }

  return 'unknown';
}

function resolveFromMedia(media) {
  if (!media) return 'unknown';
  const shotType = media?.classification?.shotType;
  if (typeof shotType === 'string' && shotType && shotType !== 'unknown') {
    if (LLM_LIFESTYLE.has(shotType)) return 'lifestyle';
    if (LLM_PACKSHOT.has(shotType)) return 'packshot';
    // Unrecognised non-unknown value: do not invent a mapping; fall through.
  }
  const hs = media?.technicalInsights?.shotStyle;
  if (hs === 'packshot' || hs === 'lifestyle' || hs === 'ambiguous') return hs;
  return 'unknown';
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = {
  classifyShotStyle,
  resolveSeedStyle,
  isEnabled,
  SHOT_STYLE_THRESHOLDS
};
