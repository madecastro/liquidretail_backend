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
// The TIGHT radius does the work. A 1px/0.5-alpha ring cannot separate a glyph
// contour from detailed footage — it only darkens what is already dark. These
// were tuned against flat studio plates; on a printed garment or skin they gave
// up. Widened to 2-3px and raised in alpha so the contour reads before the
// diffuse layers do, which is what keeps type legible without a scrim box.
export const TEXT_SHADOWS = {
  layered: '0 0 1.5px rgba(0,0,0,0.8), 0 1px 3px rgba(0,0,0,0.6), 0 4px 14px rgba(0,0,0,0.42), 0 18px 44px rgba(0,0,0,0.3)',
  soft: '0 0 1.5px rgba(0,0,0,0.75), 0 1px 3px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.38)',
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
// TIGHT CONTOUR, NOT A GLOW. Owner, on the first version: *"the halo is way too
// much the copy doesn't look crisp."* Correct — a wide, high-alpha white spread
// (3px at 0.92, plus a 14px diffuse layer) fogs the counters of the letterforms
// and reads as a milky outline rather than clean type.
//
// What actually separates dark ink from a mid-tone plate is a 1px ring at high
// alpha: enough to draw the glyph edge, too small to bloom. The diffuse layer is
// deliberately dropped here — on light ground it contributed haze and no
// separation. Legibility no longer leans on this anyway: the reviews line that
// prompted the whole thing now uses PRIMARY ink (6.87:1 rather than 3.35:1), so
// the shadow's job is edge definition only.
export const TEXT_SHADOWS_ON_LIGHT = {
  layered: '0 0 1px rgba(255,255,255,0.95), 0 1px 2px rgba(255,255,255,0.6), 0 2px 6px rgba(255,255,255,0.32)',
  soft: '0 0 1px rgba(255,255,255,0.92), 0 1px 2px rgba(255,255,255,0.55)',
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
