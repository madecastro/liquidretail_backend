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

// ── CONTOUR STROKE, for bands where even the better ink is below AA ────────
//
// THIS IS NOT THE HALO THAT WAS REJECTED. The owner's "the halo is way too much
// the copy doesn't look crisp" was about a WIDE, HIGH-ALPHA BLURRED SPREAD
// (3px at 0.92 plus a 14px diffuse layer) painted BEHIND the glyph: blur has no
// edge, so it fogs the counters and reads as a milky outline. This is the
// opposite construction — a hard, unblurred stroke on the glyph's own outline,
// the technique broadcast captions use, which sharpens the letterform instead of
// softening it.
//
// `paint-order: stroke fill` is the load-bearing part and is NOT optional.
// Without it, -webkit-text-stroke centres the stroke ON the outline, so half of
// it eats INWARD into the glyph — thinning the letter and closing up counters at
// exactly the sizes where legibility is already marginal. With it, the stroke is
// painted first and the fill lands on top, so only the outer half survives: the
// letterform keeps its full weight and gains a clean edge. Chromium (what
// Remotion renders in) honours paint-order on HTML text.
//
// Width tracks font size (2.2%) rather than being fixed: a fixed 2px is a
// hairline on a 73px quote and a slab on a 22px delivery line. Clamped to >=1px
// so it never rounds away to nothing, and capped so a huge headline cannot turn
// into an outline-drawn poster.
//
// Polarity follows the INK, exactly like textShadowFor: dark type gets a light
// contour, light type gets a dark one. Getting this backwards paints a black
// edge around black text and separates nothing — the same bug the shadow table
// had before TEXT_SHADOWS_ON_LIGHT existed.
// 0.028em: ~2px on a 68-73px headline/quote, ~1px on the small rating lines.
// Raised from an initial 0.022 after measuring the result — the stroke now only
// fires as a LAST RESORT (marginal contrast that placement could not escape), so
// it has to actually register; at 0.022 it moved 53 pixels of a 2M-pixel frame.
// Still a hairline by construction, and still clamped below.
export const STROKE_WIDTH_EM = 0.028;
export const STROKE_WIDTH_MAX_PX = 3;
export const STROKE_ON_DARK_INK = 'rgba(0,0,0,0.85)';   // light type -> dark contour
export const STROKE_ON_LIGHT_INK = 'rgba(255,255,255,0.92)'; // dark type -> light contour

/**
 * Style fragment adding a contour stroke to text. Returns an EMPTY object when
 * `enabled` is false, so every existing caller spreads nothing and is
 * byte-identical to before this existed.
 *
 * @param {boolean} enabled   only true on a band flagged MARGINAL (sub-AA contrast).
 *                          NOT the busy/texture escalation — a contour separates ink from a
 *                          backdrop of similar LUMINANCE and does little for high-contrast
 *                          type on merely textured footage.
 * @param {string}  inkHex    the resolved ink, for polarity
 * @param {number}  fontPx    rendered font size, for width scaling
 */
export function textStrokeStyle(enabled, inkHex, fontPx) {
  if (!enabled) return {};
  const lum = hexLuminance(inkHex);
  // Unparseable ink → assume light type on dark footage, matching textShadowFor's
  // own fallback, rather than guessing the inverse and painting the wrong edge.
  const inkIsDark = lum != null && lum < 0.5;
  const px = Math.min(
    STROKE_WIDTH_MAX_PX,
    Math.max(1, Math.round((Number(fontPx) || 24) * STROKE_WIDTH_EM))
  );
  return {
    WebkitTextStrokeWidth: `${px}px`,
    WebkitTextStrokeColor: inkIsDark ? STROKE_ON_LIGHT_INK : STROKE_ON_DARK_INK,
    paintOrder: 'stroke fill',
  };
}

/**
 * Padding that keeps a contour stroke from being clipped by the SAME element's
 * own `overflow: hidden`.
 *
 * MEASURED, NOT THEORISED (2026-08-31). `paint-order: stroke fill` paints the
 * stroke's outer half OUTSIDE the glyph outline, so on an element that also
 * clips (textCoreStyle's `-webkit-box` + `-webkit-line-clamp` + `overflow:hidden`,
 * and DeliverySlot's nowrap-ellipsis span) the contour can be shaved off at the
 * box edge. Proved by rendering identical CSS in the very chrome-headless-shell
 * binary Remotion uses, production config vs. an `overflow:visible` control:
 *   - horizontally, a line wrapping flush to the box width lost 2px of contour
 *     at the left edge (ink started at x=40 clipped vs x=38 unclipped);
 *   - vertically there is 11-14px of leading slack above the ascender (never at
 *     risk), but only 1-2px below the last baseline — enough that Verdana-700
 *     measurably lost 1px, while Arial and Georgia only just survived.
 * Content-dependent, so it does not fire on every render — which is exactly why
 * eyeballing one still frame was not sufficient evidence either way.
 *
 * The fix is padding to make room, plus an equal NEGATIVE MARGIN so the element
 * occupies the same space in its flex column as before and the layout does not
 * shift. `boxSizing: 'border-box'` keeps the padding inside the declared width.
 *
 * COSTS, stated honestly and bounded (both <= 2*strokePx, i.e. <= 6px):
 *   - the rendered box grows slightly taller than stackFit's arithmetic estimate
 *     (which models `lines * fontPx * lineHeight` and has never accounted for DOM
 *     padding), eating a little of its existing safety cushion;
 *   - with border-box the content area narrows slightly versus what deriveCharCap
 *     assumed, so a line could clamp one word earlier.
 * Both are smaller than the weight bump's already-accepted char-cap blindness,
 * and both only occur on a band already judged marginal.
 *
 * Returns {} when disabled, so every caller is byte-identical without a stroke.
 */
export function strokeClipGuard(enabled, fontPx) {
  if (!enabled) return {};
  const px = Math.min(
    STROKE_WIDTH_MAX_PX,
    Math.max(1, Math.round((Number(fontPx) || 24) * STROKE_WIDTH_EM))
  );
  return { padding: `${px}px`, margin: `-${px}px`, boxSizing: 'border-box' };
}

/**
 * Horizontal padding on the GROUP CONTAINER (Canonical.jsx's `stackContainerStyle`
 * box) so a contour stroke's outward bleed is not clipped by THAT box's OWN
 * `overflow:hidden` — a SECOND, OUTER clipping boundary, separate from the one
 * `strokeClipGuard` fixes above.
 *
 * WHY THIS EXISTS (found on retroactive review of the stroke feature, then
 * MEASURED, not theorised — 2026-08-31, same method as strokeClipGuard's own
 * proof: identical CSS in production vs. an `overflow:visible` control on the
 * real chrome-headless-shell binary Remotion renders with). `strokeClipGuard`
 * reserves room inside the TEXT element's own box so its own line-clamp
 * `overflow:hidden` does not shave the stroke. But `stackContainerStyle`
 * (safeZones.js) ALSO sets `overflow:hidden` on the GROUP box, for every anchor
 * except `center` — and an `align:'left'`/`align:'right'` slot renders flush
 * against that group box's own edge with ZERO gap (`alignSelf:'flex-start'`/
 * `'flex-end'`, no margin). `strokeClipGuard`'s padding+negative-margin trick
 * deliberately leaves the flex item's occupied space (margin-box) UNCHANGED —
 * that is what keeps sibling layout from shifting — which means it cannot, by
 * construction, push this SECOND boundary outward. Measured on a real render
 * (headline, `upperThird`, `align:'left'`, marginal contrast, stroke active):
 * production (group `overflow:hidden` in place) clips the contour to a flat
 * background at the group's left edge; an identical render with only that one
 * `overflow` value flipped to `visible` shows the same contour's anti-aliased
 * bleed extending ~3-4px further left, confirming the group boundary — not
 * just the text element's own — was eating real, already-painted pixels.
 *
 * FIX: the same padding+negative-margin+border-box trick, one level up. Per
 * the same box-model identity strokeClipGuard relies on (padding P and margin
 * -P cancel in the CONTENT-width equation regardless of what determines that
 * width — here `stackContainerStyle`'s own `left`/`right` position offsets,
 * not shrink-to-fit), the group's CONTENT width (and therefore every
 * safe-zone-derived measurement taken from it — `deriveCharCap`'s
 * `usableWidthPx`, the panel column math, etc.) is UNCHANGED. Only the
 * `overflow:hidden` PADDING-BOX — what the clip actually measures against —
 * moves outward, borrowing a few px from the safe-zone margin outside it
 * (generous: 6-15% of frame width) rather than from the group's own content.
 *
 * Deliberately HORIZONTAL ONLY (`paddingLeft`/`paddingRight`, not top/bottom):
 * the vertical `overflow:hidden` on `top`/`upperThird`/`lowerThird`/`bottom` is
 * a documented, load-bearing safety net against platform UI overlap (see
 * `stackContainerStyle`'s "THE FLOOR" comment) — unrelated to this stroke bleed
 * and not to be loosened by it.
 *
 * Uses the WORST-CASE stroke width (`STROKE_WIDTH_MAX_PX`), not a per-slot
 * value: this runs before the group's slots are resolved (before per-slot
 * `fontPx` is known), and the safe-zone margin it borrows from is large enough
 * that reserving the max (3px) rather than the exact value costs nothing
 * observable. Gate on whether ANY slot in the group could have an active
 * stroke (i.e. the same `escalationInk.marginal` check Canonical.jsx already
 * makes) — applying it when no stroke is active, or to a `center`-anchored
 * group with no clip boundary at all, is a harmless no-op (content width is
 * unchanged either way), so no extra branching on anchor/align is needed here.
 *
 * Returns {} when disabled, so every existing group is byte-identical.
 */
export function containerStrokeBleedGuard(enabled) {
  if (!enabled) return {};
  const px = STROKE_WIDTH_MAX_PX;
  return {
    paddingLeft: `${px}px`,
    paddingRight: `${px}px`,
    marginLeft: `-${px}px`,
    marginRight: `-${px}px`,
    boxSizing: 'border-box',
  };
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
