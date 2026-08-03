// Brand token access for compositions. Tokens arrive fully resolved in
// inputProps (built server-side by titleSpecService.buildBrandTokens);
// these helpers only do lookup + last-resort defaults so a partial token
// object can never crash a render.

const COLOR_DEFAULTS = {
  primary: '#0B0F14',
  secondary: '#DCDCDC',
  accent: '#F5B70A',
  ctaBg: '#46783E',
  ctaText: '#FFF8EF',
  scrim: '#0C0906',
  textPrimary: '#FFFFFF',
  textSecondary: '#DCDCDC',
  stars: '#F5B70A',
  badgeBg: '#BEC282',
  badgeText: '#1F2219',
  promoBg: '#F5B70A',
  promoText: '#16161A',
  // Contrast flips applied when plate intelligence reports a light band
  // under a text slot (no scrims — dark type IS the legibility strategy).
  textOnLight: '#16181D',
  textSecondaryOnLight: '#3A4048',
};

// Plate-hint contrast flip: text color tokens swap to their on-light
// variants when the band under the slot is bright. Non-text tokens
// (pills, CTA, stars) keep their brand colors.
export function contrastToken(tokens, key, bandIsLight) {
  if (!bandIsLight) return key;
  if (key === 'textPrimary') return 'textOnLight';
  if (key === 'textSecondary') return 'textSecondaryOnLight';
  return key;
}

export function tokenColor(tokens, key) {
  const c = tokens?.colors?.[key];
  return typeof c === 'string' && c ? c : COLOR_DEFAULTS[key] || '#FFFFFF';
}

export function hexToRgba(hex, alpha = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const FONT_DEFAULTS = {
  heading: { family: 'Playfair Display', fallback: 'serif', weight: 700 },
  body: { family: 'Inter', fallback: 'sans-serif', weight: 500 },
  quote: { family: 'Lora', fallback: 'serif', weight: 400 },
};

export function tokenFont(tokens, role) {
  const f = tokens?.fonts?.[role];
  const d = FONT_DEFAULTS[role] || FONT_DEFAULTS.body;
  if (!f || !f.family) return d;
  return { family: f.family, fallback: f.fallback || d.fallback, weight: f.weight || d.weight, url: f.url || null, style: f.style || 'normal' };
}

export function fontFamilyCss(font) {
  return `"${font.family}", ${font.fallback}`;
}

// Shadow recipes (treatment.shadow). With the no-scrim standard these are
// the ONLY thing separating type from arbitrary footage — layered starts
// with a tight contour pass (reads on light plates) before the cinematic
// falloff; soft carries a contour too, just lighter.
export const TEXT_SHADOWS = {
  layered: '0 0 2px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.55), 0 6px 16px rgba(0,0,0,0.4), 0 20px 48px rgba(0,0,0,0.35)',
  soft: '0 0 1px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.35)',
  none: 'none',
};

// LIGHT-INK COUNTERPARTS. Same geometry, inverted polarity.
//
// Every shadow above is BLACK, which silently assumed white type on dark
// footage. The plate-intel contrast flip means the opposite happens routinely:
// on a light plate the ink flips DARK, and a black shadow behind dark text adds
// nothing at all. Measured on a delivered Vuori ad — dark type over a mid-tone
// face, black shadow, unreadable. A light halo is what separates dark ink from
// a mid-tone background, so the polarity has to follow the ink.
export const TEXT_SHADOWS_ON_LIGHT = {
  layered: '0 0 2px rgba(255,255,255,0.85), 0 2px 5px rgba(255,255,255,0.7), 0 6px 18px rgba(255,255,255,0.55)',
  soft: '0 0 2px rgba(255,255,255,0.8), 0 1px 4px rgba(255,255,255,0.65), 0 4px 14px rgba(255,255,255,0.5)',
  none: 'none',
};

/** Relative luminance (0..1) of a #rrggbb / #rgb string. Null when unparseable. */
export function hexLuminance(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Pick the shadow whose polarity actually separates this ink from its backdrop:
 * dark ink → light halo, light ink → the original dark shadow.
 * Unparseable colour falls back to the dark table (previous behaviour).
 */
export function textShadowFor(name, inkHex) {
  const key = name in TEXT_SHADOWS ? name : 'soft';
  if (key === 'none') return 'none';
  const lum = hexLuminance(inkHex);
  return lum != null && lum < 0.5 ? TEXT_SHADOWS_ON_LIGHT[key] : TEXT_SHADOWS[key];
}

export const BOX_SHADOWS = {
  layered: '0 2px 6px rgba(0,0,0,0.25), 0 12px 36px rgba(0,0,0,0.28)',
  soft: '0 4px 14px rgba(0,0,0,0.20)',
  none: 'none',
};

export function applyCasing(text, casing) {
  if (text == null) return text;
  const s = String(text);
  if (casing === 'upper') return s.toUpperCase();
  if (casing === 'title') {
    return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  }
  return s;
}

export function clampPx(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}
