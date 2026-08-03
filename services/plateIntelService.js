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

async function analyzeFrameBands(framePath) {
  const sharp = require('sharp');
  // 160px tall keeps band strips ≥ ~20 rows after the tightened BANDS
  // geometry (top band is only 0.14 of H); 96 left too few rows for a
  // stable median.
  const img = sharp(framePath).greyscale().resize(96, 160, { fit: 'fill' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const H = info.height;
  const W = info.width;
  const bands = {};
  for (const [band, [y0, y1]] of Object.entries(BANDS)) {
    const rows = [Math.floor(y0 * H), Math.ceil(y1 * H)];
    const values = [];
    let sum = 0;
    let sumSq = 0;
    for (let y = rows[0]; y < rows[1]; y++) {
      // Horizontal span mirrors stackContainerStyle safe left/right (~0.075).
      for (let x = Math.floor(W * 0.08); x < Math.ceil(W * 0.92); x++) {
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
 * Only called when placement mode is 'content'; scan depth via TITLE_PLATE_SCAN.
 */
async function analyzePlate(platePath, { durationSec = 8, isImage = false } = {}) {
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

    const hints = { samples: [] };
    for (const f of frames) {
      try {
        hints.samples.push({ atSec: f.atSec, bands: await analyzeFrameBands(f.path) });
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

module.exports = { analyzePlate, resolveTitlePlacementMode, BAND_FOR_ANCHOR };
