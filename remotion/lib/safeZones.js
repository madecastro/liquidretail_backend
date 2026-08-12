// Per-format safe zones (fractions of W/H) and anchor geometry.
//
// vertical (9:16 Reels/Shorts/Stories): Meta Reels community-consensus clear
// zones — top 14%, bottom 35% (sides 7.5%). Official Meta guidance is
// qualitative + the Ads Manager on-canvas guardrail; the disclaimer/legal
// text rule is bottom 40%. Bottom-anchored stacks end at ~65% height
// (1 - 0.35) — intended. feed (4:5/1:1) and landscape (16:9) mirror the
// canvas canonicals' padding.
//
// Canvas format keys (vertical/feed/square/landscape) are ALSO composition
// ids and titleStyleSpec cascade keys — do NOT overload them with YT zones.
// Google PMax VIDEO surfaces select verticalYt/landscapeYt/squareYt via
// resolveSafeZoneKey({ format, platformFormat }) and thread that key as a
// prop separate from `format`.
export const SAFE_ZONES = {
  vertical: { top: 0.14, bottom: 0.35, left: 0.075, right: 0.075 },
  feed: { top: 0.06, bottom: 0.06, left: 0.065, right: 0.06 },
  // square (1:1, 1080x1080) — same surface as feed, same width, so the same
  // padding. Stated explicitly rather than leaning on the `|| SAFE_ZONES.feed`
  // fallback below, so that a future tuning pass has an obvious place to land and
  // so a typo'd format never silently inherits feed's zones.
  square: { top: 0.06, bottom: 0.06, left: 0.065, right: 0.06 },
  landscape: { top: 0.1, bottom: 0.1, left: 0.075, right: 0.075 },
  // YouTube / PMax video zones. Selected only when platformFormat is a Google
  // PMax VIDEO surface (see resolveSafeZoneKey). Unknown keys still fall
  // through to SAFE_ZONES.feed — these additions are additive and cannot
  // change existing format lookups that pass canvas format alone.
  //
  // verticalYt: Shorts / vertical YouTube — top clears channel chip + search;
  // bottom clears player scrubber + title; right clears the engagement rail
  // (like / comment / share / subscribe).
  verticalYt:  { top: 0.14, bottom: 0.35, left: 0.075, right: 0.15 },
  // landscapeYt: YouTube landscape / in-stream. Measured 2026-08-12 from
  // Google's official horizontal template
  // https://services.google.com/fh/files/blogs/ytsafezoneoverlay-horizontal.png
  // (1920×1080 PNG): fully blocked above y=39 and below y=692 → bottom band
  // 1080−692 = 388px = 35.9% (ship 0.36). Mid-row clear span x=38..1758
  // (left≈2.0%, right≈8.4%); right stays 0.15 (more conservative). Upper-row
  // title/skip intrusions (clear only x≈496..1444 at y≈100) are a separate
  // concern — do not widen left/right for them here. WHY: text in the old 20%
  // bottom band sits under player/ad chrome and is partially or fully
  // occluded. BLAST: PMAX_VIDEO_SAFE_ZONE_KEY maps every pmax_video_16_9
  // render here — unconditional prod landscape titling change, shipped alone
  // (no feature flag) so the clamp can be A/B'd without bundling other work.
  landscapeYt: { top: 0.10, bottom: 0.36, left: 0.075, right: 0.15 },
  // squareYt: square Discovery / in-feed YouTube — balanced inset; bottom
  // clears compact player controls, sides clear card chrome.
  squareYt:    { top: 0.10, bottom: 0.10, left: 0.10,  right: 0.10 },

  // ── Meta 9:16, split per surface (2026-08-11) ────────────────────────
  // `vertical` above is, by its own header comment, the META REELS clear
  // zone — bottom 35% for the caption + action rail. Stories was riding on it
  // too, which was wrong in two ways at once:
  //
  //   1. Stories reserves ~250/1778 = 14% top and bottom (PLATFORM_FORMATS
  //      meta_stories_9_16.safeArea), not 35% at the bottom. A measured
  //      Stories render put its lowest text at 0.3875 of frame height against
  //      an allowed 0.65 — 26% of the frame unusable for no reason.
  //   2. It made Stories and Reels render IDENTICALLY. Once Reels is minted as
  //      a free retitle of the Stories master, "identical" means a duplicate
  //      ad — the derivation would add a row and no creative.
  //
  // So Stories gets its own, looser band and Reels keeps the tighter one it
  // always needed. Both are stated as fractions of frame height, converted
  // from the canvas-pixel safeArea already declared in platformFormats.
  //
  // ⚠️ These are OUR recorded spec, not a fresh reading of Meta's published
  // guidance, which is qualitative plus an on-canvas guardrail in Ads Manager.
  // Sides stay at the existing 7.5% for both. If Meta publishes hard numbers,
  // reconcile HERE and in PLATFORM_FORMATS together — they are two encodings
  // of one fact and drifting them is how the duplicate above happened.
  //
  // stories: 250/1778 top and bottom. Profile row + close button at the top,
  // the reply/CTA rail at the bottom.
  stories: { top: 0.14, bottom: 0.14, left: 0.075, right: 0.075 },
};

// platformFormat → safe-zone key, for any surface whose reserved bands are NOT
// simply its canvas format's. Anything absent keeps the canvas-format zone via
// the fallback in resolveSafeZoneKey — still the common case (every static
// surface, Meta Reels, Meta feed/square). Exported so harnesses can pin the
// surface → zone wiring without re-parsing source text.
//
// ⚠️ THE NAME IS NOW NARROWER THAN THE CONTENTS — Meta Stories has an entry
// below, so this is no longer PMax-only. Deliberately NOT renamed: it is an
// exported symbol that harnesses and the landscapeYt BLAST note both reference
// by name, and it is owned by the in-flight PMax safe-zone work. Renaming it
// from here would break a symbol another change is actively building on, for a
// cosmetic gain. Rename it there, if at all.
export const PMAX_VIDEO_SAFE_ZONE_KEY = {
  pmax_video_9_16: 'verticalYt',
  pmax_video_16_9: 'landscapeYt',
  pmax_video_1_1: 'squareYt',
  // Meta Stories takes its own band; Reels keeps `vertical` (which IS the
  // Reels zone) via the canvas-format fallback below. Without this entry both
  // 9:16 Meta surfaces resolve to the same zone and render identically — which
  // is only visible once Reels is minted as a derivation of Stories.
  meta_stories_9_16: 'stories',
};

/**
 * Resolve which SAFE_ZONES key to use for layout clamps.
 * Canvas `format` (vertical|feed|square|landscape) stays the composition
 * id and titleStyleSpec cascade key; only the safe-zone lookup may switch
 * to a surface-specific variant (PMax YouTube zones, Meta Stories) when the
 * platformFormat has its own entry. Unknown/absent platformFormat →
 * SAFE_ZONES[format] || feed (today).
 */
export function resolveSafeZoneKey({ format, platformFormat } = {}) {
  const pf = String(platformFormat || '').toLowerCase().trim();
  if (pf && PMAX_VIDEO_SAFE_ZONE_KEY[pf]) return PMAX_VIDEO_SAFE_ZONE_KEY[pf];
  if (format && SAFE_ZONES[format]) return format;
  return 'feed';
}

/** Zone object for stackContainerStyle. Fail-closed to feed on unknown. */
export function resolveSafeZone({ format, platformFormat, safeZoneKey } = {}) {
  const key = safeZoneKey || resolveSafeZoneKey({ format, platformFormat });
  return SAFE_ZONES[key] || SAFE_ZONES.feed;
}

// Vertical placement of each anchor's stack container, as a fraction of H
// for the container's top edge. 'bottom' is handled with flex-end instead
// (its top value is where the bottom-anchored zone begins).
// lowerThird 0.54 remains above the vertical bottom safe band (0.35 →
// content ends by 0.65); ANCHOR_TOP + stackContainerStyle clamps still hold.
export const ANCHOR_TOP = {
  top: null, // = safe.top
  upperThird: 0.135, // canvas top_scrim_editorial contentTop
  center: null, // centered via flexbox
  lowerThird: 0.54, // canvas feed canonical bottom-flow start
  bottom: null, // flex-end against safe.bottom
};

export function clampFrac(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Container CSS for a (anchor, align) stack group within the safe area.
 * offsetX/offsetY (fractions) are applied then clamped so content cannot
 * leave the safe area.
 *
 * Safe zone: prefer explicit `safeZoneKey` (resolved server-side for PMax
 * video), else resolve from `{ format, platformFormat }`, else format alone.
 * Non-PMax ads with only `format` stay byte-identical to pre-wiring.
 */
export function stackContainerStyle({ format, safeZoneKey, platformFormat, anchor, offsetX, offsetY, width, height }) {
  const safe = resolveSafeZone({ format, platformFormat, safeZoneKey });
  const left = clampFrac(safe.left + offsetX, 0.02, 0.9);
  const right = clampFrac(safe.right - offsetX, 0.02, 0.9);
  const base = {
    position: 'absolute',
    left: left * width,
    right: right * width,
    display: 'flex',
    flexDirection: 'column',
  };
  const topFor = (frac) => clampFrac(frac + offsetY, safe.top, 1 - safe.bottom - 0.05) * height;

  // THE FLOOR (2026-08-12). A top-anchored stack used to set `top` and NOTHING
  // ELSE, so the box had no bottom edge and the flex column simply grew
  // downward — straight through the platform's blocked band.
  //
  // MEASURED on a delivered PMax landscape ad (Marine Layer, run
  // run_1786526271150_7d498862): landscapeYt blocks the bottom 36%, i.e.
  // everything below y=691 of 1080. The quote landed at y=647..684 — safe —
  // and the rating/review lines beneath it at y=774..795, a full 100px INSIDE
  // the band that YouTube paints its player chrome over.
  //
  // topFor() looks like it protects this and does not: it clamps where the
  // stack STARTS (never below 1 - bottom - 0.05), which says nothing about how
  // far the stack EXTENDS. A three-line group starting at the last legal top
  // clears the floor easily.
  //
  // So the file's own documented invariant — "no spec offset can push content
  // under platform UI" — held for exactly two of five anchors: `bottom` and
  // `center` set a bottom inset, the three top-anchored ones did not.
  //
  // overflow:hidden is deliberate and is a trade, not an oversight. Given a
  // group too tall for its band the choices are: paint under the chrome
  // (illegible AND against platform guidance), or clip at the boundary. Clipping
  // is the lesser harm, and it is now unlikely rather than routine — the
  // format-aware character caps (slotContent.js deriveCharCap) size copy to the
  // box it actually renders into, so the overflow this guards against should be
  // the exception it was always assumed to be.
  const floor = { bottom: safe.bottom * height, overflow: 'hidden' };

  switch (anchor) {
    case 'top':
      return { ...base, ...floor, top: topFor(safe.top) };
    case 'upperThird':
      return { ...base, ...floor, top: topFor(ANCHOR_TOP.upperThird) };
    case 'center':
      return {
        ...base,
        // Both insets clamped: an offset shifts the centering window but
        // can never push it outside the safe area.
        top: clampFrac(safe.top + offsetY, safe.top, 0.7) * height,
        bottom: clampFrac(safe.bottom - offsetY, safe.bottom, 0.7) * height,
        justifyContent: 'center',
      };
    case 'lowerThird':
      // lowerThird is the worst offender and gets the strongest treatment: it
      // is MEANT to sit low, so it grows UPWARD from the safe floor instead of
      // downward from a line near it. Anchoring it by `top` is what let the
      // measured rating/review overflow happen — starting low and growing
      // down has nowhere to go but under the chrome.
      return {
        ...base,
        ...floor,
        top: topFor(ANCHOR_TOP.lowerThird),
        justifyContent: 'flex-end',
      };
    case 'bottom':
    default:
      return {
        ...base,
        // Floor at the safe band — the documented invariant is that no
        // spec offset can push content under platform UI.
        bottom: clampFrac(safe.bottom - offsetY, safe.bottom, 0.9) * height,
        justifyContent: 'flex-end',
      };
  }
}

// ── PMax 16:9 split-stage reserved copy column ─────────────────────────────
//
// THE PROBLEM (2026-08-12). titleSpecValidator ANCHORS are purely vertical
// (top/upperThird/center/lowerThird/bottom); ALIGNS is text-align INSIDE a
// box, not a reserved column. stackContainerStyle always spans full width
// between left/right safe insets. The landscape preset's align:'left' +
// maxWidthPct:0.46 is a STATIC hint with no coupling to where the subject
// actually is — it is NOT a solved column. Split-stage needs a real
// horizontal placement axis: product anchored in one half, copy in the
// other (generatively extended) half.
//
// WIDTH FRACTION. Landscape maxWidthPct:0.46 is the max TEXT width inside a
// full-width stack, not a column width. A column of 0.46 of frame on the
// west side would end at 0.075+0.46=0.535 and cross the midline into the
// subject half. So the cap is min(0.46, half − gutter/2 − outer safe inset).
// At landscapeYt (left 0.075, gutter 0.04): west = 0.5−0.02−0.075 = **0.405**
// of frame. East is tighter (~0.33) because right chrome is 0.15 — that is
// correct, not a bug. PANEL_COLUMN_WIDTH_CAP_FRAC keeps the 0.46 precedent
// as the hard ceiling when a zone has a smaller outer inset.
//
// MEASURED CHROME (same Google horizontal template as landscapeYt.bottom,
// 2026-08-12, 1920×1080 PNG): mid-row clear span x=38..1758; upper-row
// (y≈100) clear only x≈496..1444 (title treatment left, skip/ad chrome
// right). A column that runs to the TOP of the safe zone therefore collides
// with chrome on BOTH sides. panelColumnStyle still exposes the full safe
// vertical box so stackContainerStyle anchors keep working; the copy STACK
// must prefer mid-band anchors — do not "fix" upper collision by widening
// the column or raising top past the safe inset.
//
// NO SCRIM. Owner reaffirmed 2026-08-12: legibility is worst-case ink +
// upstream gates, never a shade behind the type. This style has no
// background / backdrop-filter by construction.
//
// TOTAL / PURE. Unknown zoneKey, missing dims, or a bad panelSide → null
// (caller falls back to full-width stack). Never throw, never emit NaN —
// a NaN in a style paints over the whole frame.

/** Center gutter between subject half and copy column (fraction of W). ~77px @1920. */
export const PANEL_CENTER_GUTTER_FRAC = 0.04;
/** Hard ceiling on column width — landscape maxWidthPct precedent (see block above). */
export const PANEL_COLUMN_WIDTH_CAP_FRAC = 0.46;
/** Valid panelSide values: 'west' = copy LEFT, 'east' = copy RIGHT. */
export const PANEL_SIDES = ['west', 'east'];

/**
 * CSS box for a reserved copy column on one half of a landscape frame,
 * intersected with the platform safe zone on all four sides.
 *
 * @param {{ zoneKey?: string, panelSide?: string, dims?: { width: number, height: number } }} opts
 * @returns {{ position: string, left: number, right: number, top: number, bottom: number }|null}
 */
export function panelColumnStyle({ zoneKey, panelSide, dims } = {}) {
  if (!dims || typeof dims !== 'object') return null;
  const W = dims.width;
  const H = dims.height;
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return null;
  if (panelSide !== 'west' && panelSide !== 'east') return null;
  if (!zoneKey || typeof zoneKey !== 'string' || !SAFE_ZONES[zoneKey]) return null;

  const safe = SAFE_ZONES[zoneKey];
  const st = safe.top;
  const sb = safe.bottom;
  const sl = safe.left;
  const sr = safe.right;
  if (![st, sb, sl, sr].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;

  // Vertical: full safe band. Content ends at y = (1-sb)*H — never into bottom chrome.
  const top = st * H;
  const bottom = sb * H;

  const mid = 0.5;
  const halfGutter = PANEL_CENTER_GUTTER_FRAC / 2;
  let leftFrac;
  let rightEdgeFrac; // x of column's right edge as fraction of W (from left)

  if (panelSide === 'west') {
    leftFrac = sl;
    const maxRight = mid - halfGutter;
    const widthFrac = Math.min(PANEL_COLUMN_WIDTH_CAP_FRAC, maxRight - leftFrac);
    if (!(widthFrac > 0) || !Number.isFinite(widthFrac)) return null;
    rightEdgeFrac = leftFrac + widthFrac;
  } else {
    // east — hug the right safe edge; width may shrink under the heavier right chrome
    rightEdgeFrac = 1 - sr;
    const minLeft = mid + halfGutter;
    const widthFrac = Math.min(PANEL_COLUMN_WIDTH_CAP_FRAC, rightEdgeFrac - minLeft);
    if (!(widthFrac > 0) || !Number.isFinite(widthFrac)) return null;
    leftFrac = rightEdgeFrac - widthFrac;
    // Fail closed if half+gutter still cannot fit (should not happen on shipped zones)
    if (leftFrac < minLeft - 1e-9) return null;
  }

  const left = leftFrac * W;
  const right = (1 - rightEdgeFrac) * W; // CSS right inset from frame's right edge

  // Reject any non-finite so a bad zone cannot paint NaN styles.
  if (![left, right, top, bottom].every((n) => Number.isFinite(n))) return null;
  if (left < 0 || right < 0 || top < 0 || bottom < 0) return null;
  // Column must have positive interior
  if (left + right >= W || top + bottom >= H) return null;

  return {
    position: 'absolute',
    left,
    right,
    top,
    bottom,
    // Deliberately no background / backgroundColor / backdropFilter —
    // standing no-scrim rule (owner 2026-08-12).
  };
}
