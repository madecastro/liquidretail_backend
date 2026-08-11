// Slot animation envelopes. A slot always occupies its place in the stack
// (layout is static — matching the canvas canonicals); entrance/exit only
// animate opacity/transform/clip so staggered slots never reflow neighbors.

import { interpolate, spring } from 'remotion';

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Compute the animation state of a slot at `frame`.
 * timing: { enterAtSec, exitAtSec|null, enterDurationSec, exitDurationSec }
 * transition: { type, direction, spring }
 * timeScale rescales spec-authored times onto the real plate length, in
 * either direction (see specTimeScale below for why it must be symmetric):
 * specs are authored for a nominal 8s clip; a 6s Cloudinary segment gets
 * timeScale 0.75 so the choreography — including the CTA — still lands,
 * and a 10s segment gets timeScale 1.25 so authored beats keep landing on
 * the camera cuts instead of freezing at the 8s-grid seconds.
 * Entrances are additionally clamped inside the clip so no slot can be
 * scheduled past the last frame; durations stay absolute so motion feel
 * doesn't change with plate length.
 * Returns { opacity, transform, clipPath } (CSS-ready).
 */
export function slotEnvelope({ frame, fps, timing, transition, durationInFrames, timeScale = 1 }) {
  const enterDur = Math.max(1, Math.round(timing.enterDurationSec * fps));
  const enterStart = Math.max(
    0,
    Math.min(Math.round(timing.enterAtSec * timeScale * fps), durationInFrames - enterDur - 1)
  );
  const exitStart = timing.exitAtSec == null
    ? null
    : Math.min(
        Math.max(Math.round(timing.exitAtSec * timeScale * fps), enterStart + enterDur + 1),
        durationInFrames - 1
      );
  const exitDur = Math.max(1, Math.round(timing.exitDurationSec * fps));

  // Entrance progress 0→1
  let pIn;
  if (transition.type === 'pop' || (transition.type === 'slide' && transition.spring)) {
    pIn = spring({
      frame: frame - enterStart,
      fps,
      config: transition.spring || { damping: 14, stiffness: 160, mass: 1 },
      durationInFrames: Math.max(enterDur * 2, 12),
    });
    if (frame < enterStart) pIn = 0;
  } else {
    pIn = easeOutCubic(
      interpolate(frame, [enterStart, enterStart + enterDur], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    );
  }

  // Exit progress 0→1 (0 = fully shown)
  const pOut = exitStart == null
    ? 0
    : interpolate(frame, [exitStart, exitStart + exitDur], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });

  const shown = Math.min(pIn, 1) * (1 - pOut);

  const style = { opacity: shown, transform: 'none', clipPath: 'none' };

  const dist = 24; // px travel for slide entrances (canvas canonicals used 14–20)
  const dir = transition.direction || 'up';
  const dx = dir === 'left' ? dist : dir === 'right' ? -dist : 0;
  const dy = dir === 'up' ? dist : dir === 'down' ? -dist : 0;

  switch (transition.type) {
    case 'slide': {
      const rem = 1 - Math.min(pIn, 1);
      style.transform = `translate(${dx * rem}px, ${dy * rem}px)`;
      break;
    }
    case 'pop': {
      const s = 0.6 + 0.4 * Math.min(pIn, 1.15);
      style.transform = `scale(${s})`;
      break;
    }
    case 'wipe': {
      const rem = (1 - Math.min(pIn, 1)) * 100;
      // reveal in the direction of travel
      if (dir === 'left') style.clipPath = `inset(0 0 0 ${rem}% )`;
      else if (dir === 'right') style.clipPath = `inset(0 ${rem}% 0 0)`;
      else if (dir === 'down') style.clipPath = `inset(0 0 ${rem}% 0)`;
      else style.clipPath = `inset(${rem}% 0 0 0)`;
      break;
    }
    case 'fade':
    case 'none':
    default:
      if (transition.type === 'none') style.opacity = frame >= enterStart && (exitStart == null || frame < exitStart) ? 1 : 0;
      break;
  }

  return style;
}

/** Progress 0→1 of a slot's own visible window — drives accent animations. */
export function slotProgress({ frame, fps, timing, durationInFrames, timeScale = 1 }) {
  const start = Math.max(0, Math.min(Math.round(timing.enterAtSec * timeScale * fps), durationInFrames - 2));
  const end = timing.exitAtSec == null ? durationInFrames : Math.round(timing.exitAtSec * timeScale * fps);
  return interpolate(frame, [start, Math.max(start + 1, end)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

/**
 * Scale factor mapping spec-authored seconds onto the real clip length.
 *
 * Symmetric by design: stretches on longer plates as well as compressing on
 * shorter ones. Presets are authored on a nominal grid (e.g. 8s) with text
 * cuts placed deliberately ON the Omni camera-beat marks — the camera prompt
 * (services/veoPromptBuilder.js) places its own cuts at dur/3 and 0.64*dur,
 * which SCALE WITH THE ACTUAL CLIP LENGTH. If text timing only ever
 * compressed, a longer plate (e.g. an 8s-authored preset rendered at 10s)
 * would leave text cuts frozen at the 8s marks while the camera cuts moved
 * out to dur/3 and 0.64*dur — the cut points would no longer line up and the
 * choreography would visibly desync from the shot. Scaling proportionally in
 * both directions keeps every authored beat at the same extent-relative
 * position (cutSec/extent) of the plate at any length — so a preset authored
 * to land its cuts near dur/3 and 0.64*dur at its nominal extent (see
 * remotion/presets/canonical.json, whose 2.7s/5.1s cuts approximate dur/3
 * and 0.64*dur for its 8s extent) keeps tracking veoPromptBuilder's camera
 * beats at ANY clip length, not just the authored one.
 *
 * Guarded against degenerate inputs: extent<=0, no phases, or fps<=0 all
 * fall back to scale 1 rather than producing NaN/Infinity. An exact match
 * (clipSec === extent) always returns precisely 1 so already-aligned configs
 * (current Meta 8s-on-8s-preset, current PMax 10s-on-10s-preset) stay
 * byte-identical.
 */
export function specTimeScale(spec, durationInFrames, fps) {
  const extent = Math.max(0, ...(spec?.phases || []).map((p) => p.endSec || 0));
  if (!(extent > 0) || !(fps > 0)) return 1;
  const clipSec = durationInFrames / fps;
  if (clipSec === extent) return 1;
  return clipSec / extent;
}
