// Brand-script child renderer.
//
// This process is spawned by services/brandScriptExecutor.js with a
// scrubbed env (no secrets) for every ad render. Reads a config JSON
// blob on stdin, loads the brand's untrusted styleScript into a
// sandboxed scope, and calls the exported renderFrame() once per
// plate frame. Draws happen via @napi-rs/canvas; result PNGs are
// written to outDir/f%04d.png. Parent picks them up and encodes.
//
// The brand script contract:
//
//   module.exports = {
//     renderFrame: async (frameIndex, ctx, plate, meta, helpers) => {
//       // ctx    — CanvasRenderingContext2D (2D). Canvas is already
//       //          sized to the plate. Plate is NOT pre-drawn — the
//       //          script does ctx.drawImage(plate, 0, 0) first if
//       //          it wants the base as background.
//       // plate  — @napi-rs/canvas Image of the current base frame.
//       // meta   — { quote, cta, brandName, reviewsText, likes, ... }
//       //          text vars from the LLM copy bundle.
//       // helpers — { clamp, t01, eoc, eob, smooth, colors } — math
//       //           + easing utilities so scripts don't reimplement.
//     }
//   };
//
// The brand script never sees `require`, `process`, `fs`, or global.
// Anything it needs comes in via the parameters above or the
// canvas / sharp / colors / helpers closures embedded in the sandbox.

const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');
const vm   = require('vm');
const canvasLib = require('@napi-rs/canvas');

async function main() {
  const config = await readConfigFromStdin();
  const {
    styleScript, meta, plateDir, outDir, fontsDir,
    width, height, totalFrames, brandName, adId,
    previewIndices,
    // When true, load a single plate once and reuse it for `totalFrames`
    // renders. Used by the animated inline preview: the "video" is a
    // static image with time-driven overlays. Avoids duplicating 192
    // plate files on disk and skips re-reading the same PNG from disk
    // 192 times.
    singlePlateForAllFrames
  } = config;

  const isPreview     = Array.isArray(previewIndices) && previewIndices.length > 0;
  const isSinglePlate = singlePlateForAllFrames === true && !isPreview;
  progress(
    `starting brand=${brandName || '?'} ad=${adId || '?'} ` +
    (isPreview     ? `preview[${previewIndices.join(',')}]`   :
     isSinglePlate ? `singlePlate frames=${totalFrames}`      :
                     `frames=${totalFrames}`) +
    ` ${width}×${height}`
  );

  // Register any TTF/OTF in the fonts dir. Family name = file stem.
  await registerFontsFromDir(fontsDir);

  // Load the brand script into a controlled scope. The script sees
  // ONLY: canvas (namespace), sharp (image ops), helpers (easings +
  // math), colors (constants). No require, process, fs, global.
  const brandModule = loadBrandScript(styleScript);
  if (typeof brandModule?.renderFrame !== 'function') {
    throw new Error('brand styleScript must export a `renderFrame` function');
  }

  // Render frames.
  const plateFiles = (await fsp.readdir(plateDir)).filter(f => f.endsWith('.png')).sort();
  let framesProduced = 0;

  // Renders one frame using a pre-loaded plate. Split from disk-loading
  // so the single-plate + preview paths can share one Image object
  // across all frames (avoids 192 identical disk reads).
  const drawFrame = async (i, plate) => {
    const canvas = canvasLib.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    try {
      await brandModule.renderFrame(i, ctx, plate, meta || {}, HELPERS);
    } catch (err) {
      throw new Error(`brand renderFrame(${i}) threw: ${err.message}\n${err.stack}`);
    }
    const buf = await canvas.encode('png');
    const outPath = path.join(outDir, `f${String(i).padStart(4, '0')}.png`);
    await fsp.writeFile(outPath, buf);
    framesProduced++;
  };

  if (isPreview) {
    // Preview mode — render only the requested frame indices against
    // plate[0]. The frameIndex value passed to renderFrame is the
    // REQUESTED index so time-based animations show the correct
    // state at each preview moment (t=0, mid, end typically).
    if (plateFiles.length === 0) throw new Error('preview needs at least one plate file');
    const plate = await canvasLib.loadImage(path.join(plateDir, plateFiles[0]));
    for (const i of previewIndices) {
      await drawFrame(i, plate);
      progress(`preview frame ${i} rendered`);
    }
  } else if (isSinglePlate) {
    // Single-plate animated mode — one plate, N frames. Plate loads
    // once; canvas resets per frame. Overlay time envelopes still
    // resolve against frameIndex/FPS so animations hit their marks.
    if (plateFiles.length === 0) throw new Error('single-plate render needs a plate file');
    const plate = await canvasLib.loadImage(path.join(plateDir, plateFiles[0]));
    const n = Number(totalFrames) || 192;
    for (let i = 0; i < n; i++) {
      await drawFrame(i, plate);
      if (i > 0 && i % 24 === 0) progress(`rendered frame ${i}/${n}`);
    }
  } else {
    // Full-render mode — one plate file per frame (the Grok video path).
    const frameCount = Math.min(totalFrames || plateFiles.length, plateFiles.length);
    for (let i = 0; i < frameCount; i++) {
      const plate = await canvasLib.loadImage(path.join(plateDir, plateFiles[i]));
      await drawFrame(i, plate);
      if (i > 0 && i % 24 === 0) progress(`rendered frame ${i}/${frameCount}`);
    }
  }

  // Last line of stdout is the report JSON — parent parses it.
  process.stdout.write(JSON.stringify({ ok: true, framesProduced }) + '\n');
}

// ── Sandbox loader ─────────────────────────────────────────────────

function loadBrandScript(source) {
  const brandModule = { exports: {} };
  // vm.compileFunction has the same sandboxing property as new Function
  // (the compiled function only sees what we pass in via `params`),
  // but it also gives syntax errors WITH file+line+column info instead
  // of a bare "Unexpected token X" — critical when the script is
  // LLM-generated and needs debugging.
  let fn;
  try {
    fn = vm.compileFunction(
      source,
      ['module', 'exports', 'canvas', 'sharp', 'helpers', 'colors'],
      { filename: 'brand-script.js' }
    );
  } catch (err) {
    // Syntax error — dump a line-numbered slice around the offending
    // location so the parent can surface it to the operator.
    const loc = extractLocation(err);
    const context = renderSourceContext(source, loc.line, 4);
    process.stderr.write(`\n── brand script parse error ──\n${err.message}\n\n${context}\n\n`);
    const e = new Error(`brand styleScript syntax error: ${err.message}${loc.line ? ` (line ${loc.line}${loc.column ? `, col ${loc.column}` : ''})` : ''}`);
    e.parseError = true;
    e.line = loc.line;
    e.column = loc.column;
    e.context = context;
    throw e;
  }

  try {
    fn(brandModule, brandModule.exports, canvasLib, require('sharp'), HELPERS, COLORS);
  } catch (err) {
    throw new Error(`brand styleScript failed to load: ${err.message}\n${err.stack}`);
  }
  return brandModule.exports;
}

// Pull line + column from a Node SyntaxError. compileFunction stacks
// include "brand-script.js:LINE:COL" — regex that out. Returns
// { line: number|null, column: number|null }.
function extractLocation(err) {
  const stack = err.stack || '';
  const m = stack.match(/brand-script\.js:(\d+)(?::(\d+))?/);
  if (m) return { line: Number(m[1]), column: m[2] ? Number(m[2]) : null };
  return { line: null, column: null };
}

// Render a small window of source lines around the error, prefixed by
// line numbers with a marker on the offending row. Makes it obvious
// where the parse failed when the operator reviews the textarea.
function renderSourceContext(source, targetLine, span = 3) {
  if (!targetLine) return source.split('\n').slice(0, 10).map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n');
  const lines = source.split('\n');
  const start = Math.max(0, targetLine - span - 1);
  const end   = Math.min(lines.length, targetLine + span);
  const out = [];
  for (let i = start; i < end; i++) {
    const marker = (i + 1) === targetLine ? '>' : ' ';
    out.push(`${marker} ${String(i + 1).padStart(4)} | ${lines[i]}`);
  }
  return out.join('\n');
}

// ── Helper library available to brand scripts ──────────────────────

const HELPERS = {
  clamp: (x, a = 0, b = 1) => Math.max(a, Math.min(b, x)),
  // Normalize a frame time to 0..1 given a start frame and duration.
  t01: (frame, start, duration) => {
    if (duration <= 0) return frame >= start ? 1 : 0;
    return Math.max(0, Math.min(1, (frame - start) / duration));
  },
  // ease-out cubic
  eoc: (x) => {
    const t = Math.max(0, Math.min(1, x));
    return 1 - Math.pow(1 - t, 3);
  },
  // ease-out back (slight overshoot)
  eob: (x) => {
    const t = Math.max(0, Math.min(1, x));
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  // smoothstep
  smooth: (x) => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  },
  // rgba helper for fillStyle
  rgba: ([r, g, b], a = 1) => `rgba(${r},${g},${b},${a})`
};

// Palette constants. Brand scripts can override locally but having
// these available cuts boilerplate for the common cases.
const COLORS = {
  WHITE: [255, 255, 255],
  BLACK: [0, 0, 0],
  NAVY:  [11, 42, 74],
  GOLD:  [245, 183, 10],
  HEART: [232, 84, 46],
  SOFT:  [232, 238, 244]
};

// ── Fonts ──────────────────────────────────────────────────────────

// Explicit filename → family-name map. Downloaded TTFs use compact
// filenames (e.g., PlayfairDisplay.ttf) but need to register under
// both the compact form (matches canonical scripts' historical
// default fallbacks) AND the canonical Google Fonts specimen name
// (matches brand.fontFamily values scraped from brand websites).
// Unknown filenames fall through to filename-stem registration —
// preserves the old convention for any custom TTFs an operator
// drops in manually.
const FONT_FILE_MAP = {
  'Inter.ttf':              { family: 'Inter',              aliases: [] },
  'PlayfairDisplay.ttf':    { family: 'Playfair Display',   aliases: ['PlayfairDisplay'] },
  'Lora.ttf':               { family: 'Lora',               aliases: [] },
  'Cormorant.ttf':          { family: 'Cormorant',          aliases: [] },
  'CormorantGaramond.ttf':  { family: 'Cormorant Garamond', aliases: ['CormorantGaramond'] },
  'Antonio.ttf':            { family: 'Antonio',            aliases: [] },
  'Montserrat.ttf':         { family: 'Montserrat',         aliases: [] },
  'GreatVibes.ttf':         { family: 'Great Vibes',        aliases: ['GreatVibes', 'Great-Vibes-Regular'] },
  'DMSans.ttf':             { family: 'DM Sans',            aliases: ['DMSans'] },
  'BebasNeue.ttf':          { family: 'Bebas Neue',         aliases: ['BebasNeue'] },
  'Anton.ttf':              { family: 'Anton',              aliases: [] },
  'Oswald.ttf':             { family: 'Oswald',             aliases: [] },
  'IBMPlexSans.ttf':        { family: 'IBM Plex Sans',      aliases: ['IBMPlexSans'] },
  'Poppins.ttf':            { family: 'Poppins',            aliases: [] },
  'Nunito.ttf':             { family: 'Nunito',             aliases: [] },
  'Quicksand.ttf':          { family: 'Quicksand',          aliases: [] }
};

async function registerFontsFromDir(fontsDir) {
  try {
    const entries = await fsp.readdir(fontsDir);
    let registered = 0;
    let names = [];
    for (const name of entries) {
      if (!/\.(ttf|otf)$/i.test(name)) continue;
      const full = path.join(fontsDir, name);
      const mapEntry = FONT_FILE_MAP[name];
      // Primary registration — Google Fonts canonical name when known,
      // else filename stem for backward compatibility.
      const primary = mapEntry?.family || name.replace(/\.(ttf|otf)$/i, '');
      canvasLib.GlobalFonts.registerFromPath(full, primary);
      registered++;
      names.push(primary);
      // Aliases — the same TTF re-registered under alternate names so
      // canonical scripts referencing the compact form (e.g.,
      // 'PlayfairDisplay' as a default fallback) still resolve.
      for (const alias of (mapEntry?.aliases || [])) {
        canvasLib.GlobalFonts.registerFromPath(full, alias);
        names.push(alias);
      }
    }
    if (registered) progress(`registered ${registered} font${registered === 1 ? '' : 's'} (${names.length} name${names.length === 1 ? '' : 's'}) from ${fontsDir}`);
    else            progress(`no fonts found in ${fontsDir} (scripts will fall back to system defaults)`);
  } catch (err) {
    progress(`font registration warning: ${err.message}`);
  }
}

// ── I/O ────────────────────────────────────────────────────────────

function readConfigFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch (err) {
        reject(new Error(`stdin was not valid JSON: ${err.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

function progress(msg) {
  // Prefix so the parent can filter progress lines out of stdout when
  // parsing the final report JSON.
  process.stdout.write(`:: ${msg}\n`);
}

main().catch(err => {
  process.stderr.write(`${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
