// Per-format safe zones (fractions of W/H) and anchor geometry.
//
// vertical (9:16 Reels/Shorts/Stories): Meta Reels community-consensus clear
// zones — top 14%, bottom 35% (sides 7.5%). Official Meta guidance is
// qualitative + the Ads Manager on-canvas guardrail; the disclaimer/legal
// text rule is bottom 40%. Bottom-anchored stacks end at ~65% height
// (1 - 0.35) — intended. feed (4:5/1:1) and landscape (16:9) mirror the
// canvas canonicals' padding.
export const SAFE_ZONES = {
  vertical: { top: 0.14, bottom: 0.35, left: 0.075, right: 0.075 },
  feed: { top: 0.06, bottom: 0.06, left: 0.065, right: 0.06 },
  // square (1:1, 1080x1080) — same surface as feed, same width, so the same
  // padding. Stated explicitly rather than leaning on the `|| SAFE_ZONES.feed`
  // fallback below, so that a future tuning pass has an obvious place to land and
  // so a typo'd format never silently inherits feed's zones.
  square: { top: 0.06, bottom: 0.06, left: 0.065, right: 0.06 },
  landscape: { top: 0.1, bottom: 0.1, left: 0.075, right: 0.075 },
};

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
 */
export function stackContainerStyle({ format, anchor, offsetX, offsetY, width, height }) {
  const safe = SAFE_ZONES[format] || SAFE_ZONES.feed;
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
