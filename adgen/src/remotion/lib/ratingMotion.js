// Pure timing/math for RatingSlot micro-animations (stars pop + reviews
// count-up). Kept free of React/Remotion so offline harnesses can drive the
// same numbers the composition uses. All durations are wall-clock seconds;
// callers convert via fps (never hardcode frame indices).

/** Stagger between successive star pops (left → right). */
export const STAR_STAGGER_SEC = 0.09;

/**
 * Approximate settle window of one star spring. Used to schedule the count-up
 * start ("after the last star lands") and to ramp partial fill 0 → target
 * during the pop. The visual scale itself comes from remotion `spring()`.
 */
export const STAR_POP_SEC = 0.22;

/** Reviews count roll 0 → N ease-out. */
export const COUNT_DUR_SEC = 0.9;

/** Attribution/suffix fade occupies the final portion of the count window. */
export const SUFFIX_FADE_SEC = 0.3;

export const STAR_COUNT = 5;

export function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

/**
 * Local frame relative to the slot's enter (time-scaled). Negative before enter.
 * Mirrors slotEnvelope's enterStart math for the enterAtSec * timeScale * fps point.
 */
export function ratingLocalFrame(frame, fps, enterAtSec, timeScale = 1) {
  const enterStart = Math.round((enterAtSec || 0) * timeScale * fps);
  return frame - enterStart;
}

/** Absolute seconds from slot enter when star `index` (0..4) begins its pop. */
export function starStartSec(index, staggerSec = STAR_STAGGER_SEC) {
  return Math.max(0, index) * staggerSec;
}

/**
 * Target fill fraction for star `index` given a 0–5 rating.
 * e.g. 4.6 → [1,1,1,1,0.6]; 3 → [1,1,1,0,0].
 */
export function starTargetFill(rating, index) {
  const r = Number(rating);
  if (!Number.isFinite(r) || r <= 0) return 0;
  const clamped = Math.min(STAR_COUNT, Math.max(0, r));
  if (index < Math.floor(clamped)) return 1;
  if (index > Math.floor(clamped)) return 0;
  return clamped - Math.floor(clamped);
}

/**
 * Animated fill fraction during the star's own pop window (0 → target).
 * Pure ease-out ramp over STAR_POP_SEC; independent of spring overshoot so
 * fill never exceeds target when scale bounces past 1.
 */
export function starFillAt(localFrame, fps, rating, index, {
  staggerSec = STAR_STAGGER_SEC,
  popSec = STAR_POP_SEC,
} = {}) {
  const target = starTargetFill(rating, index);
  if (target <= 0) return 0;
  const startF = Math.round(starStartSec(index, staggerSec) * fps);
  const durF = Math.max(1, Math.round(popSec * fps));
  if (localFrame <= startF) return 0;
  if (localFrame >= startF + durF) return target;
  return target * easeOutCubic((localFrame - startF) / durF);
}

/** Seconds from slot enter when the last star's pop window ends. */
export function lastStarLandSec({
  starCount = STAR_COUNT,
  staggerSec = STAR_STAGGER_SEC,
  popSec = STAR_POP_SEC,
} = {}) {
  return starStartSec(starCount - 1, staggerSec) + popSec;
}

/**
 * Parse a leading integer (optional en-US thousands commas) from reviewsText.
 * Returns null when there is no leading integer — caller should fade the line
 * instead of counting up.
 *
 *   "15,545 reviews · vuoriclothing.com" → { target: 15545, suffix: " reviews · vuoriclothing.com" }
 *   "41000 reviews · gymshark.com"       → { target: 41000, suffix: " reviews · gymshark.com" }
 *   "Trusted by thousands" → null
 *
 * The pattern is `\d+` FIRST, then optional comma groups — not
 * `\d{1,3}(?:,\d{3})*|\d+`. Alternation is ordered, so that older pattern let
 * branch one win on an UNCOMMAED run of digits: "41000" matched just "410"
 * (`\d{1,3}` greedy, then zero comma groups), yielding target 410 and suffix
 * "00 reviews · …". The count then rolled 0→410 while the leftover "00" sat
 * beside it, so mid-animation frames read fabricated totals like "18800
 * reviews" — only the settled frame looked right, which is exactly why a
 * post-settle contact sheet never caught it. Any count ≥1000 without commas
 * was affected ("8343" → 834 + "3 reviews"), and reviewsText is built
 * uncommaed by services/ratingDisplay.js.
 */
export function parseReviewsLeadingNumber(reviewsText) {
  const s = String(reviewsText ?? '');
  const m = s.match(/^(\d+(?:,\d{3})*)/);
  if (!m) return null;
  const target = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(target)) return null;
  return { target, raw: m[1], suffix: s.slice(m[0].length) };
}

/**
 * Integer count-up 0 → target over durationSec ease-out, starting at startSec
 * (both relative to slot enter, in wall-clock seconds). Monotonic non-decreasing
 * via Math.round of the eased value, clamped at the endpoints.
 *
 *   localFrame <= start  → 0
 *   localFrame >= settle → target
 */
export function countUpValue(localFrame, fps, target, {
  startSec = 0,
  durationSec = COUNT_DUR_SEC,
} = {}) {
  const n = Number(target);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const startF = Math.round(startSec * fps);
  const durF = Math.max(1, Math.round(durationSec * fps));
  if (localFrame <= startF) return 0;
  if (localFrame >= startF + durF) return n;
  const eased = easeOutCubic((localFrame - startF) / durF);
  // round keeps the sequence integer + monotonic for increasing eased t.
  return Math.min(n, Math.round(n * eased));
}

/** en-US thousands separators, reapplied each frame so width stays tabular. */
export function formatReviewsCount(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * Suffix/attribution opacity: 0 until the final fadeSec of the count window,
 * then ease 0 → 1. When there is no count (fade-only path), treat startSec as
 * the fade start and durationSec as the fade length.
 */
export function suffixOpacityAt(localFrame, fps, {
  startSec = 0,
  durationSec = COUNT_DUR_SEC,
  fadeSec = SUFFIX_FADE_SEC,
} = {}) {
  const fadeStart = startSec + Math.max(0, durationSec - fadeSec);
  const startF = Math.round(fadeStart * fps);
  const durF = Math.max(1, Math.round(fadeSec * fps));
  if (localFrame <= startF) return 0;
  if (localFrame >= startF + durF) return 1;
  return easeOutCubic((localFrame - startF) / durF);
}

/**
 * Whole-line fade when reviewsText has no leading integer.
 * Starts when the count would have started (after last star lands).
 */
export function lineFadeOpacityAt(localFrame, fps, {
  startSec = 0,
  durationSec = SUFFIX_FADE_SEC,
} = {}) {
  const startF = Math.round(startSec * fps);
  const durF = Math.max(1, Math.round(durationSec * fps));
  if (localFrame <= startF) return 0;
  if (localFrame >= startF + durF) return 1;
  return easeOutCubic((localFrame - startF) / durF);
}
