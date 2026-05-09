// Color contrast utilities — true WCAG 2.x relative luminance
// (sRGB → linear gamma corrected) and contrast ratio.
//
// Used server-side by:
//   - layoutInputService post-resolution contrast guard
//     (canvas-zone templates: spotlight, ugc_split_screen)
//   - overlayPlacementService brightness-grid sampling
//     (overlay templates: testimonial_overlay, product_overlay)
//
// The renderer (templatePreview.js) keeps its own simplified inline
// luminance (tpRelLum / tpReadableOn) — that path already works and
// changing its math would shift tuning of pickHeadlineColor /
// pickCtaFillColor thresholds. This util is the source of truth for
// new server-side contrast decisions; the renderer renders what it's told.

const HEX_RE = /^#[0-9a-f]{6}$/i;

function isHex(s) {
  return typeof s === 'string' && HEX_RE.test(s);
}

function hexToRgb(hex) {
  if (!isHex(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// sRGB channel (0..255) → linear (0..1) per WCAG 2.x.
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// WCAG 2.x relative luminance (0..1). Returns 0.5 for malformed input
// so consumers don't blow up — they'll get a neutral mid-tone fallback.
function relLum(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG contrast ratio (1.0..21.0). Symmetric — order of args doesn't matter.
function contrast(hexA, hexB) {
  const La = relLum(hexA);
  const Lb = relLum(hexB);
  const hi = Math.max(La, Lb);
  const lo = Math.min(La, Lb);
  return (hi + 0.05) / (lo + 0.05);
}

// Pick a readable foreground (#FFFFFF or #0A0A0A) for text on a given bg.
// Threshold at L=0.5 because at that luminance a white foreground gives
// contrast ~3.95 and black gives ~5.74 — black wins. Below 0.5, white wins.
function readableOn(bgHex) {
  if (!isHex(bgHex)) return '#FFFFFF';
  return relLum(bgHex) > 0.5 ? '#0A0A0A' : '#FFFFFF';
}

// WCAG AA thresholds:
//   4.5 — normal body text
//   3.0 — large text (≥18pt or ≥14pt bold) and graphical UI components
const WCAG_AA_NORMAL = 4.5;
const WCAG_AA_LARGE  = 3.0;

module.exports = {
  isHex,
  hexToRgb,
  relLum,
  contrast,
  readableOn,
  WCAG_AA_NORMAL,
  WCAG_AA_LARGE
};
