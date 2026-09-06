// Website surface-background helpers.
//
// brand.websiteBackground is the page/surface color scraped from the
// brand's homepage (not theme-color / brand accent). AI seed transforms
// flatten transparent product PNGs onto this color via Cloudinary
// `b_rgb:<hex>` BEFORE any resize/crop (flatten-then-resize).

// Accepts '#RGB', '#RRGGBB', 'RGB', 'RRGGBB', rgb()/rgba() with opaque alpha.
// Returns normalized '#RRGGBB' or null (invalid / transparent / non-color).
function normalizeWebsiteBackgroundHex(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;
  if (/^(transparent|none|inherit|initial|unset|currentcolor)$/i.test(s)) return null;

  // #RGB / #RRGGBB or bare RGB / RRGGBB
  let m = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    let h = m[1].toUpperCase();
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    return `#${h}`;
  }

  // rgb(r,g,b) / rgba(r,g,b,a) — only accept near-opaque alphas as a
  // real surface color (semi-transparent is not a flatten target).
  m = s.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+%?))?\s*\)$/i
  );
  if (m) {
    let a = 1;
    if (m[4] != null) {
      const rawA = m[4];
      a = rawA.endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
    }
    if (!Number.isFinite(a) || a < 0.99) return null;
    const clamp = (n) => Math.max(0, Math.min(255, parseInt(n, 10) || 0));
    const r = clamp(m[1]);
    const g = clamp(m[2]);
    const b = clamp(m[3]);
    const hex = ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
    return `#${hex}`;
  }

  return null;
}

// Cloudinary `b_rgb:` wants RRGGBB with no '#'. Defaults to white when
// brand.websiteBackground is absent/invalid so transparent PNGs never
// bake in as product-on-black under AI models that drop alpha as black.
//
// Accepts a Brand-like object `{ websiteBackground }` or a raw color string.
function websiteBackgroundHex(brandOrColor) {
  const raw = brandOrColor && typeof brandOrColor === 'object'
    ? brandOrColor.websiteBackground
    : brandOrColor;
  const normalized = normalizeWebsiteBackgroundHex(raw);
  return normalized ? normalized.slice(1) : 'FFFFFF';
}

module.exports = {
  websiteBackgroundHex,
  normalizeWebsiteBackgroundHex
};
