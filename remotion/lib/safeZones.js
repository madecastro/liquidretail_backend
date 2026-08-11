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
  // landscapeYt: YouTube landscape / pre-roll — top clears title + channel;
  // bottom clears player controls + progress bar; right clears end-screen /
  // next-up chrome margin.
  landscapeYt: { top: 0.10, bottom: 0.20, left: 0.075, right: 0.15 },
  // squareYt: square Discovery / in-feed YouTube — balanced inset; bottom
  // clears compact player controls, sides clear card chrome.
  squareYt:    { top: 0.10, bottom: 0.10, left: 0.10,  right: 0.10 },
};

// PMax VIDEO platformFormat → YT safe-zone key. Canvas formats (Meta +
// static PMax image keys) intentionally absent — they keep Meta/canvas
// zones via the format fallback below.
const PMAX_VIDEO_SAFE_ZONE_KEY = {
  pmax_video_9_16: 'verticalYt',
  pmax_video_16_9: 'landscapeYt',
  pmax_video_1_1: 'squareYt',
};

/**
 * Resolve which SAFE_ZONES key to use for layout clamps.
 * Canvas `format` (vertical|feed|square|landscape) stays the composition
 * id and titleStyleSpec cascade key; only the safe-zone lookup may switch
 * to a YT variant when platformFormat is a Google PMax VIDEO surface.
 * Unknown/absent platformFormat → SAFE_ZONES[format] || feed (today).
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
  switch (anchor) {
    case 'top':
      return { ...base, top: topFor(safe.top) };
    case 'upperThird':
      return { ...base, top: topFor(ANCHOR_TOP.upperThird) };
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
      return { ...base, top: topFor(ANCHOR_TOP.lowerThird) };
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
