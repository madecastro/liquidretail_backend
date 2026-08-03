// Pure plate-hint helpers shared by Canonical.jsx (render) and offline
// harnesses. No React, no I/O. ESM (remotion/ is "type":"module").

/**
 * Global ink decision from band votes.
 *
 * Majority of slot-weighted light/dark votes wins. On a TIE only, break
 * toward the plate's global median band luma (threshold 0.55): near-white
 * studio walls that split 3/3 no longer fall through to brand-default
 * light type (white-on-white). Non-tie paths unchanged.
 *
 * @param {number} lightWeight
 * @param {number} darkWeight
 * @param {{ samples?: Array<{ bands?: Record<string, { lum?: number }> }> }|null} plateHints
 * @returns {{ onLight: boolean, globalLum: number|null, tied: boolean }}
 */
export function decideInkOnLight(lightWeight, darkWeight, plateHints) {
  const lw = Number(lightWeight) || 0;
  const dw = Number(darkWeight) || 0;
  if (lw > dw) return { onLight: true, globalLum: null, tied: false };
  if (dw > lw) return { onLight: false, globalLum: null, tied: false };
  // Tie (including 0/0): median luma across ALL sampled text-band readings.
  const globalLum = medianBandLuma(plateHints);
  if (globalLum == null) return { onLight: false, globalLum: null, tied: true };
  return { onLight: globalLum > 0.55, globalLum, tied: true };
}

/** Median of every band.lum across every sample, or null when none. */
export function medianBandLuma(plateHints) {
  const vals = [];
  for (const s of plateHints?.samples || []) {
    for (const band of Object.values(s.bands || {})) {
      if (band && typeof band.lum === 'number' && Number.isFinite(band.lum)) {
        vals.push(band.lum);
      }
    }
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}
