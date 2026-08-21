// Plate intelligence — looks at the ACTUAL rendered video before titles
// go on, so type color/placement react to the footage instead of hoping.
//
// Two tiers, controlled by TITLE_PLATE_SCAN ('basic' default | 'gemini' | 'off'):
//   basic  — sharp-based luminance/busyness stats per title band (top /
//            middle / bottom within safe zones) at sampled times. Free,
//            deterministic, always safe to run.
//   gemini — adds a Gemini vision pass over the sampled frames marking
//            keep-out bands (faces, the product, busy focal areas). Falls
//            back to basic silently on any failure.
//
// Output (inputProps.plateHints):
//   { samples: [{ atSec, bands: { top|middle|bottom: { lum 0..1, busy 0..1, avoid } } }] }
// The composition maps each slot group's anchor+enter time to the nearest
// sample band: light band → dark type (textOnLight tokens); avoid → nudge.

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const FFMPEG = (() => {
  try {
    return require('ffmpeg-static');
  } catch {
    return null;
  }
})();

const BAND_FOR_ANCHOR = {
  top: 'top',
  upperThird: 'top',
  center: 'middle',
  lowerThird: 'bottom',
  bottom: 'bottom',
};

// Vertical extents of each band (fractions of H) — MUST match where
// remotion stacks actually paint, not crude frame-thirds.
//
// Anchor geometry (remotion/lib/safeZones.js ANCHOR_TOP + SAFE_ZONES.vertical):
//   top / upperThird stack top ≈ 0.14 / 0.135; a rating+headline group is
//   ~2–3 lines ≈ 0.12 H tall → sample strip [0.14, 0.28].
//   center is flex-centered in the safe window → mid strip [0.40, 0.55].
//   lowerThird top = 0.54; bottom-anchored content ends by 0.65 (1 - 0.35)
//   → sample strip [0.52, 0.65].
//
// Prior rects top:[0.14,0.40] / bottom:[0.40,0.65] swallowed the subject
// torso/face mid-frame; mean luma then voted "dark" while text sat on a
// light wall above the face (Vuori contact-sheet failure).
const BANDS = {
  top: [0.14, 0.28],
  middle: [0.40, 0.55],
  bottom: [0.52, 0.65],
};

// ── SURFACE-AWARE BANDS. The literals above are DERIVED FROM ONE SURFACE.
//
// Read the comment block above again: it derives the strips from
// `SAFE_ZONES.vertical` and states the contract as "MUST match where remotion
// stacks actually paint". `vertical` has bottom inset 0.35, so bottom-anchored
// content ends at 1-0.35 = 0.65 and [0.52, 0.65] is exactly right — for that
// surface. It is WRONG for every surface whose bottom inset differs, and the
// strips were applied to all of them:
//
//   zone         bottom inset   copy paints to   strip ends   UNTESTED
//   vertical         0.35           0.65           0.65        —
//   reels            0.35           0.65           0.65        —
//   verticalYt       0.35           0.65           0.65        —
//   landscapeYt      0.36           0.64           0.65        —
//   stories          0.14           0.86           0.65        0.65-0.86  (21% of H)
//   squareYt         0.10           0.90           0.65        0.65-0.90  (25%)
//   feed             0.06           0.94           0.65        0.65-0.94  (29%)
//   square           0.06           0.94           0.65        0.65-0.94  (29%)
//
// On a 12-ad Meta video run that is NINE ads sampling a strip the copy does not
// sit in: 3 stories, 3 meta_feed_1_1 (-> square), 3 meta_feed_4_5 (-> feed).
// Only the three reels rows were ever measured where their text lands.
//
// WHY THIS MATTERS THREE TIMES OVER, since all three read these strips:
//   1. FACE KEEP-OUT   — a face below 0.65 on stories/feed never flags `avoid`.
//   2. BUSY / TEXTURE   — the score that moves copy off a printed garment
//      wordmark (see Canonical.jsx resolveGroupAnchor: "wordmark printed across
//      the garment. Measured: bottom busy 0.199, top 0.144"). Measured on the
//      wrong strip, a caption lands on the product's logo and nothing objects.
//      This is the mechanism behind the 2026-08-21 `layout_safe_box` QC
//      failures ("the caption overlay is placed directly on top of the primary
//      back logo, obscuring the brand name").
//   3. MEDIAN LUMA      — the dark-vs-light ink vote. Sampling where the text is
//      NOT is the very failure the tightened geometry above was written to fix
//      (the Vuori note). So correcting the strips makes the ink vote MORE
//      correct, not riskier.
//
// INERTNESS CONTRACT, and it is the reason this is safe to land: with
// `safeZoneKey` absent, or on any surface whose insets are vertical's, this
// returns values BYTE-IDENTICAL to BANDS above. It can only change a surface
// that provably violates the stated contract. Pinned by
// scripts/verifyKeepOutBandGeometry.js.
//
// Insets are MIRRORED, not imported, for the same reason as
// PANEL_CENTER_GUTTER_FRAC below and LOGO_SAFE_MARGIN_PCT in
// directImageRenderService: plateIntel is CJS and safeZones is the ESM remotion
// island, with no shared module graph. The harness pins every value equal to
// SAFE_ZONES, so a drift fails loudly instead of silently mis-sampling.
const SURFACE_INSETS = {
  vertical:    { top: 0.14, bottom: 0.35 },
  feed:        { top: 0.06, bottom: 0.06 },
  square:      { top: 0.06, bottom: 0.06 },
  landscape:   { top: 0.10, bottom: 0.10 },
  stories:     { top: 0.14, bottom: 0.14 },
  reels:       { top: 0.14, bottom: 0.35 },
  verticalYt:  { top: 0.14, bottom: 0.35 },
  landscapeYt: { top: 0.10, bottom: 0.36 },
  squareYt:    { top: 0.10, bottom: 0.10 },
};

// remotion/lib/safeZones.js ANCHOR_TOP.lowerThird. The 0.02 lead-in reproduces
// today's 0.52 literal (0.54 - 0.02) so the bottom strip starts a touch above
// the stack's top edge, catching content that rides right at the boundary.
const LOWER_THIRD_TOP = 0.54;
const BAND_LEAD_IN = 0.02;
// SCOPE, deliberately narrow. Only the BOTTOM strip is derived here.
//
// The `top` strip is left at its literal on every surface, because
// BAND_FOR_ANCHOR maps BOTH `top` and `upperThird` onto it and those two
// anchors do NOT share an origin: `top` starts at the surface's own safe.top,
// while `upperThird` is the fixed ANCHOR_TOP.upperThird = 0.135 regardless of
// surface. Deriving the strip from safe.top alone would give feed/square
// [0.06, 0.20] and miss the lower half of an upperThird group. Whether the top
// strip needs its own per-surface treatment is a real question, but this change
// has no evidence for it — every surface measured as defective differs in
// `bottom` — so it is left exactly as it is rather than changed on a guess.
//
// `middle` is flex-centred inside the safe window and tied to neither inset.

/**
 * Band strips for a surface, derived from that surface's own safe zone so the
 * SAMPLED rect is the PAINTED rect by construction.
 *
 * Pure, total, never throws. Unknown / absent key -> BANDS verbatim.
 *
 * @param {string|null} safeZoneKey a SAFE_ZONES key (see resolveSafeZoneKey)
 */
// Fractions are compared against SAFE_ZONES by the harness, so keep them free
// of float dust (1 - 0.06 = 0.9399999999999999 without this).
function round4(v) { return Math.round(v * 1e4) / 1e4; }

function bandsFor(safeZoneKey) {
  const z = SURFACE_INSETS[String(safeZoneKey || '').trim()];
  if (!z) return BANDS;
  const bottomEnd = round4(1 - z.bottom);
  const bottomStart = round4(LOWER_THIRD_TOP - BAND_LEAD_IN);
  // A surface whose safe zone leaves no room below lowerThird would invert the
  // strip; fall back rather than emit a negative-height rect.
  if (!(bottomEnd > bottomStart)) return BANDS;
  return {
    top: BANDS.top.slice(),
    middle: BANDS.middle.slice(),
    bottom: [bottomStart, bottomEnd],
  };
}

async function extractFrames(platePath, times, outDir) {
  if (!FFMPEG) throw new Error('ffmpeg-static unavailable');
  const frames = [];
  for (const t of times) {
    // Per-frame failures (seek past a slightly-short stream, decode
    // hiccup) drop that sample only — the surviving samples still hint.
    try {
      const out = path.join(outDir, `scan_${String(t).replace('.', '_')}.png`);
      await execFileP(FFMPEG, ['-y', '-v', 'quiet', '-ss', String(t), '-i', platePath, '-frames:v', '1', out]);
      const stat = await fsp.stat(out).catch(() => null);
      if (stat && stat.size > 100) frames.push({ atSec: t, path: out });
    } catch (e) {
      console.warn(`🔎 plateIntel: frame @${t}s failed (${e.message}) — skipping sample`);
    }
  }
  return frames;
}

// Horizontal span of text stacks — default full-width sample (mirrors
// stackContainerStyle safe left/right ~0.075). Split-stage may narrow this
// via resolveBandXRange so ink is scored on the panel the copy actually sits
// on, not diluted by the product half.
const BAND_X0 = 0.08;
const BAND_X1 = 0.92;
// Must match remotion/lib/safeZones.js PANEL_CENTER_GUTTER_FRAC — duplicated
// (not imported) because plateIntel is CJS and safeZones is the ESM remotion
// island. Harness pins both stay equal.
const PANEL_CENTER_GUTTER_FRAC = 0.04;

/**
 * Horizontal sample range for band luminance/busyness.
 *
 * Absent / null / unknown panelSide → [BAND_X0, BAND_X1] byte-identical to
 * the pre-split loop bounds (inertness contract for non-split ads).
 * west → left half only; east → right half only (each trimmed by half the
 * center gutter so the sample stays inside the reserved copy column).
 *
 * Pure / total: never throws; bad input falls back to the full-width range
 * rather than inventing a column (fail-open on the sampling path — wrong-half
 * ink is worse than a slightly diluted full-width read only when the prop
 * is malformed, which should not reach here).
 *
 * @param {{ panelSide?: string|null, xRange?: [number, number]|null }} [opts]
 * @returns {{ x0: number, x1: number }}
 */
function resolveBandXRange(opts = {}) {
  // Explicit xRange wins (fractions 0..1) — for callers that already resolved
  // a column box. Must be finite and ordered or we ignore it.
  const xr = opts.xRange;
  if (Array.isArray(xr) && xr.length === 2
      && Number.isFinite(xr[0]) && Number.isFinite(xr[1])
      && xr[1] > xr[0]) {
    return { x0: Math.max(0, xr[0]), x1: Math.min(1, xr[1]) };
  }
  const side = opts.panelSide;
  if (side === 'west') {
    // Copy column is left of mid − half gutter. Still inset from the outer
    // edge by BAND_X0 so we do not sample the extreme left chrome strip.
    return { x0: BAND_X0, x1: Math.min(BAND_X1, 0.5 - PANEL_CENTER_GUTTER_FRAC / 2) };
  }
  if (side === 'east') {
    return { x0: Math.max(BAND_X0, 0.5 + PANEL_CENTER_GUTTER_FRAC / 2), x1: BAND_X1 };
  }
  // Absent, null, '', 'up', etc. → full-width (today's path).
  return { x0: BAND_X0, x1: BAND_X1 };
}

async function analyzeFrameBands(framePath, opts = {}) {
  const sharp = require('sharp');
  // 160px tall keeps band strips ≥ ~20 rows after the tightened BANDS
  // geometry (top band is only 0.14 of H); 96 left too few rows for a
  // stable median.
  const img = sharp(framePath).greyscale().resize(96, 160, { fit: 'fill' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const H = info.height;
  const W = info.width;
  // Default full width; panelSide / xRange narrows to the copy column so a
  // split-stage product half cannot dilute the ink vote (2026-08-12).
  const { x0, x1 } = resolveBandXRange(opts);
  const xLo = Math.floor(W * x0);
  const xHi = Math.ceil(W * x1);
  const bands = {};
  for (const [band, [y0, y1]] of Object.entries(bandsFor(opts.safeZoneKey))) {
    const rows = [Math.floor(y0 * H), Math.ceil(y1 * H)];
    const values = [];
    let sum = 0;
    let sumSq = 0;
    for (let y = rows[0]; y < rows[1]; y++) {
      for (let x = xLo; x < xHi; x++) {
        const v = data[y * W + x] / 255;
        values.push(v);
        sum += v;
        sumSq += v * v;
      }
    }
    const n = values.length;
    // MEDIAN luma — a dark face/product that occupies a minority of the
    // text strip no longer drags mean below the light threshold (the
    // Vuori wall failure: mean dark, text on light wall).
    let lum = 0.5;
    if (n) {
      values.sort((a, b) => a - b);
      const mid = Math.floor(n / 2);
      lum = n % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    }
    const mean = n ? sum / n : 0.5;
    const busy = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;
    bands[band] = { lum: Number(lum.toFixed(3)), busy: Number(Math.min(1, busy * 3).toFixed(3)), avoid: false };
  }
  return bands;
}

async function semanticScan(frames, hints) {
  // Atlas gateway (Gemini served OpenAI-compatible; direct Google
  // OpenAI-compat endpoint as fallback inside the transport).
  const { chatCompletion } = require('./atlasLlmService');

  const content = [{
    type: 'text',
    text: `These are frames from a product video ad, in time order (${frames.map((f) => f.atSec + 's').join(', ')}). Title text will be overlaid in horizontal bands: top (upper third), middle, bottom (lower third). For EACH frame, mark bands that titles must AVOID because they would cover a face, the product itself, or the visual focal point. Respond as JSON: {"frames":[{"atSec":<n>,"avoid":["top"|"middle"|"bottom", ...]}]} — empty avoid array when everything is clear.`,
  }];
  for (const f of frames) {
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${(await fsp.readFile(f.path)).toString('base64')}` } });
  }
  const res = await chatCompletion(
    { stage: 'title_plate_scan', service: 'plateIntelService', visionImages: frames.length },
    {
      model: process.env.TITLE_SCAN_MODEL || 'gemini-2.5-flash',
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 1024,
    }
  );
  const parsed = JSON.parse(res.choices[0].message.content);
  for (const fr of parsed.frames || []) {
    const sample = hints.samples.find((s) => Math.abs(s.atSec - Number(fr.atSec)) < 0.6);
    if (!sample) continue;
    for (const band of fr.avoid || []) {
      if (sample.bands[band]) sample.bands[band].avoid = true;
    }
  }
  return hints;
}

/**
 * Resolve title placement mode.
 * Precedence: per-request placementMode > brand.videoSettings.titlePlacementMode > 'canonical'.
 * TITLE_PLATE_SCAN='off' forces canonical globally (kill switch — no plate scan).
 * In 'content' mode, scan depth still comes from TITLE_PLATE_SCAN ('basic'|'gemini').
 */
function resolveTitlePlacementMode({ placementMode = null, brand = null } = {}) {
  if ((process.env.TITLE_PLATE_SCAN || 'basic').toLowerCase() === 'off') return 'canonical';
  if (placementMode === 'canonical' || placementMode === 'content') return placementMode;
  const brandMode = brand?.videoSettings?.titlePlacementMode;
  if (brandMode === 'canonical' || brandMode === 'content') return brandMode;
  return 'canonical';
}

/**
 * Analyze a plate (video file or single image) and return plateHints.
 * Never throws — titling must render even when analysis fails.
 *
 * Called unconditionally by both placement modes (fixed 2026-08-04 — this
 * docstring used to say "only called when placement mode is 'content'",
 * which was already false at every call site: remotionRenderService.js
 * gates the call on `TITLE_PLATE_SCAN !== 'off'` only, never on the
 * resolved placement mode. That mismatch wasn't cosmetic — 'canonical' is
 * the default, and Canonical.jsx's global ink flip (plateIsLightGlobal)
 * needs real plateHints to ever flip off the default dark ink. Skipping
 * the scan in canonical mode left plateHints permanently null there,
 * so the flip could never fire and a near-white studio plate shipped
 * white-on-white title text. Scan depth (not whether it runs at all)
 * is controlled by TITLE_PLATE_SCAN ('basic' default | 'gemini' | 'off').
 */
async function analyzePlate(platePath, { durationSec = 8, isImage = false, panelSide = null, xRange = null, safeZoneKey = null } = {}) {
  const mode = (process.env.TITLE_PLATE_SCAN || 'basic').toLowerCase();
  if (mode === 'off') return null;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'platescan_'));
  try {
    // Sample times clamped inside the known duration (probe fallback can
    // overstate it; seeking past EOF would just drop samples).
    // Denser than the old 3-point grid so enter windows of hook / proof /
    // close (canonical cuts ~0.5 / 2.7 / 5.1 on an 8s plate) each land
    // near a real sample — nearest-sample in bandStateFor otherwise voted
    // on a frame seconds away from where text is visible.
    const maxT = Math.max(0.2, durationSec - 0.3);
    const times = isImage
      ? [0]
      : [...new Set(
          [0.5, 1.5, durationSec * 0.35, durationSec * 0.55, durationSec * 0.75]
            .map((t) => Number(Math.min(Math.max(t, 0.2), maxT).toFixed(2)))
        )];
    const frames = isImage
      ? [{ atSec: 0, path: platePath }]
      : await extractFrames(platePath, times, tmpDir);
    if (!frames.length) return null;

    // panelSide / xRange optional — absent keeps full-width sampling (inert).
    // safeZoneKey optional — absent keeps the BANDS literals (inert), see bandsFor.
    const bandOpts = { panelSide, xRange, safeZoneKey };
    const hints = { samples: [] };
    for (const f of frames) {
      try {
        hints.samples.push({ atSec: f.atSec, bands: await analyzeFrameBands(f.path, bandOpts) });
      } catch (e) {
        console.warn(`🔎 plateIntel: band analysis @${f.atSec}s failed (${e.message})`);
      }
    }
    if (!hints.samples.length) return null;

    if (mode === 'gemini') {
      try {
        await semanticScan(frames, hints);
      } catch (e) {
        console.warn(`🔎 plateIntel: gemini scan failed (${e.message}) — using basic hints`);
      }
    }
    return hints;
  } catch (e) {
    console.warn(`🔎 plateIntel: analysis failed (${e.message}) — rendering without hints`);
    return null;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Face keep-out (title-band avoid flags from cached vision boxes) ─────────
//
// Detection boxes (basePlateCropService.detectClipBoxes) are NORMALIZED
// FRACTIONS 0..1 of the SOURCE frame — the vision prompt returns left/top/
// right/bottom as fractions, not pixels of the 640-wide still.
// plateHints bands are also fractions of the PLATE (Remotion's canvas).
//
// When the plate IS the source (full-frame 9:16, or raw-plate retry):
//   plateFrac = sourceFrac   (identity)
// When the plate is a face-safe crop of the source (rect in SOURCE PIXELS):
//   plateX = (sourceFracX * sourceW - rect.cx) / rect.cw
//   plateY = (sourceFracY * sourceH - rect.cy) / rect.ch
// (see mapSourceFaceToPlate)

/** Fraction of band area a face must cover before the band is flagged avoid. */
const FACE_BAND_OVERLAP_THRESHOLD = 0.20;

/**
 * Intersection area of two axis-aligned rects, as a fraction of `band`'s area.
 * Both rects: { left, top, right, bottom } in the same fraction space.
 */
function bandFaceOverlapFrac(band, face) {
  if (!band || !face) return 0;
  const nums = [band.left, band.top, band.right, band.bottom, face.left, face.top, face.right, face.bottom];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return 0;
  const ix0 = Math.max(band.left, face.left);
  const iy0 = Math.max(band.top, face.top);
  const ix1 = Math.min(band.right, face.right);
  const iy1 = Math.min(band.bottom, face.bottom);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const bandArea = (band.right - band.left) * (band.bottom - band.top);
  if (!(bandArea > 0)) return 0;
  return inter / bandArea;
}

/** Union of normalized face boxes (same shape as faceSafeCrop.unionBoxes). */
function unionFaceBoxes(boxes) {
  const usable = (boxes || []).filter(
    (b) => b && [b.left, b.top, b.right, b.bottom].every((n) => typeof n === 'number' && Number.isFinite(n))
      && b.right > b.left && b.bottom > b.top
  );
  if (!usable.length) return null;
  return {
    left: Math.min(...usable.map((b) => b.left)),
    top: Math.min(...usable.map((b) => b.top)),
    right: Math.max(...usable.map((b) => b.right)),
    bottom: Math.max(...usable.map((b) => b.bottom)),
  };
}

/**
 * Map a SOURCE-fraction face box into PLATE-fraction space.
 *
 * Coord conversion (explicit):
 *   source: face.{left,top,right,bottom} ∈ [0,1] of sourceW×sourceH
 *   crop:   rect.{cx,cy,cw,ch} in SOURCE PIXELS (faceSafeCrop CropRect)
 *   plate:  full canvas of the cropped delivery = rect window
 *   plateLeft = (face.left * sourceW - rect.cx) / rect.cw
 *   …same for top/right/bottom
 * Uncropped (no rect / missing dims): identity.
 */
function mapSourceFaceToPlate(face, { cropRect = null, sourceW = null, sourceH = null } = {}) {
  if (!face) return null;
  if (
    !cropRect
    || !Number.isFinite(sourceW) || sourceW < 1
    || !Number.isFinite(sourceH) || sourceH < 1
    || ![cropRect.cx, cropRect.cy, cropRect.cw, cropRect.ch].every((n) => Number.isFinite(n))
    || !(cropRect.cw > 0) || !(cropRect.ch > 0)
  ) {
    return { left: face.left, top: face.top, right: face.right, bottom: face.bottom };
  }
  const toPlate = (fx, fy) => ({
    x: (fx * sourceW - cropRect.cx) / cropRect.cw,
    y: (fy * sourceH - cropRect.cy) / cropRect.ch,
  });
  const tl = toPlate(face.left, face.top);
  const br = toPlate(face.right, face.bottom);
  return {
    left: Math.min(tl.x, br.x),
    top: Math.min(tl.y, br.y),
    right: Math.max(tl.x, br.x),
    bottom: Math.max(tl.y, br.y),
  };
}

function bandRect(bandKey, safeZoneKey = null) {
  const extent = bandsFor(safeZoneKey)[bandKey];
  if (!extent) return null;
  return { left: BAND_X0, top: extent[0], right: BAND_X1, bottom: extent[1] };
}

/**
 * Flag plateHints bands `avoid:true` where a face covers > FACE_BAND_OVERLAP_THRESHOLD
 * of the band area. Pure — mutates a shallow copy of samples/bands, never throws.
 *
 * faceSamples: [{ atSec, face }] — atSec null → apply to ALL plate samples
 * (envelope fallback). Each timed sample maps to the nearest plateHints
 * sample; when equidistant, both get the face (conservative).
 *
 * Multiple faces at one sample time are UNIONED before the overlap test.
 *
 * @returns {object|null} new plateHints (or null input unchanged)
 */
function applyFaceKeepOut(plateHints, faceSamples, opts = {}) {
  if (!plateHints?.samples?.length) return plateHints;
  const samplesIn = Array.isArray(faceSamples) ? faceSamples : [];
  if (!samplesIn.length) return plateHints;
  const threshold = typeof opts.overlapThreshold === 'number'
    ? opts.overlapThreshold
    : FACE_BAND_OVERLAP_THRESHOLD;

  // Deep-enough copy so we don't mutate the analyzePlate object in place.
  const out = {
    samples: plateHints.samples.map((s) => ({
      atSec: s.atSec,
      bands: Object.fromEntries(
        Object.entries(s.bands || {}).map(([k, v]) => [k, { ...v }])
      ),
    })),
  };

  // face index → list of plate sample indices it applies to
  const facesByPlateIdx = out.samples.map(() => []);

  for (const fs of samplesIn) {
    if (!fs?.face) continue;
    const plateFace = mapSourceFaceToPlate(fs.face, opts);
    if (!plateFace) continue;

    if (fs.atSec == null || !Number.isFinite(fs.atSec)) {
      // Envelope / untimed: cover every sample (conservative).
      for (let i = 0; i < out.samples.length; i++) facesByPlateIdx[i].push(plateFace);
      continue;
    }

    // Nearest plateHints sample; ties → all minima (conservative).
    let bestDist = Infinity;
    const winners = [];
    for (let i = 0; i < out.samples.length; i++) {
      const d = Math.abs(out.samples[i].atSec - fs.atSec);
      if (d < bestDist - 1e-9) {
        bestDist = d;
        winners.length = 0;
        winners.push(i);
      } else if (Math.abs(d - bestDist) <= 1e-9) {
        winners.push(i);
      }
    }
    for (const i of winners) facesByPlateIdx[i].push(plateFace);
  }

  let flagged = 0;
  for (let i = 0; i < out.samples.length; i++) {
    const union = unionFaceBoxes(facesByPlateIdx[i]);
    if (!union) continue;
    const bands = out.samples[i].bands;
    for (const bandKey of Object.keys(BANDS)) {
      if (!bands[bandKey]) continue;
      const br = bandRect(bandKey, opts.safeZoneKey || null);
      const overlap = bandFaceOverlapFrac(br, union);
      if (overlap > threshold) {
        bands[bandKey].avoid = true;
        flagged += 1;
      }
    }
  }
  if (flagged) {
    console.log(`🔎 plateIntel: face keep-out flagged ${flagged} band-sample(s) (threshold=${threshold})`);
  }
  return out;
}

module.exports = {
  analyzePlate,
  resolveTitlePlacementMode,
  BAND_FOR_ANCHOR,
  BANDS,
  bandsFor,
  bandRect,
  SURFACE_INSETS,
  BAND_X0,
  BAND_X1,
  resolveBandXRange,
  applyFaceKeepOut,
  bandFaceOverlapFrac,
  mapSourceFaceToPlate,
  unionFaceBoxes,
  FACE_BAND_OVERLAP_THRESHOLD,
};
