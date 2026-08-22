// Per-brand deterministic style overrides for video ad chrome.
//
// Each brand can have its own module in this directory (u_beauty.js,
// camelbackflowers.js, etc.) that exports partial overrides for the
// chrome renderer's lookup tables:
//
//   fonts:      map from font_style enum → { importFragment, fontFamily, weight }
//   colors:     map from color_hint enum → hex value
//   fontSizes:  map from scale enum → base px (for the reference 1000×1778 canvas)
//   cornerInset: number, px inset for corner_* positions (default 48)
//   centerMaxWidthRatio: number, 0–1 (default 0.80)
//   cornerMaxWidthRatio: number, 0–1 (default 0.30)
//
// All overrides are partial — each brand's values merge over the
// module's own defaults, so a brand can override just one enum value
// if that's all it needs.
//
// Lookup by brand.name (slugified: lowercase, non-alphanumeric → _).
// Multiple aliases per style are supported so different brand-name
// variants (camelbackflowers.com, Camelback Flowers, etc.) resolve
// to the same style module.
//
// To add a new brand:
//   1. Copy one of the existing brand style files (e.g. u_beauty.js)
//   2. Adjust fonts/colors/sizes to the brand's visual identity
//   3. Register in the STYLES map below with all name aliases

const uBeautyStyle          = require('./u_beauty');
const camelbackFlowersStyle = require('./camelback_flowers');

// Map slugified brand-name → style module. Multiple aliases resolve to
// the same style so different DB spellings work.
const STYLES = {
  'u_beauty':  uBeautyStyle,
  'ubeauty':   uBeautyStyle,
  'u_beauty_':  uBeautyStyle,  // trailing punctuation fallback

  // Camelback Flowers — florist. Multiple aliases cover DB spellings
  // (with and without spaces, .com domain form).
  'camelback_flowers':     camelbackFlowersStyle,
  'camelbackflowers':      camelbackFlowersStyle,
  'camelbackflowers_com':  camelbackFlowersStyle,
  'camelback_flowers_com': camelbackFlowersStyle
};

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Returns the brand's style overrides object, or null if no per-brand
// style is registered. Renderer falls back to its own defaults for any
// field the brand style doesn't override.
//
// Priority order (first hit wins):
//   1. brand.styleOverrides   — DB-editable per-brand overrides (set
//                                via the Brand page's Style card)
//   2. STYLES[slugify(name)]  — JS-file style module (u_beauty.js etc.)
//   3. null                   — renderer uses its bare defaults
//
// The DB override wins so an operator can iterate on a style without
// waiting for a redeploy; the JS file remains the seed / template.
function getBrandStyle(brand) {
  if (!brand) return null;
  if (brand.styleOverrides && typeof brand.styleOverrides === 'object' && Object.keys(brand.styleOverrides).length > 0) {
    return brand.styleOverrides;
  }
  if (!brand.name) return null;
  const key = slugify(brand.name);
  return STYLES[key] || null;
}

// Returns the JS-file style for a brand, ignoring any DB override.
// Used by the Brand page's Style card to seed the editor with the
// file default when the operator clicks "Load defaults".
function getFileStyle(brand) {
  if (!brand?.name) return null;
  const key = slugify(brand.name);
  return STYLES[key] || null;
}

module.exports = { getBrandStyle, getFileStyle, slugify };
