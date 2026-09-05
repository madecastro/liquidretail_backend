#!/usr/bin/env node
//
// testRemotionTitles.js — side-by-side verification of BOTH titling
// engines (canvas brand-script vs Remotion) over the same plate video,
// with ffprobe assertions on every output. No DB required: the canvas
// canonical falls back to its bundled script FILE when mongoose isn't
// connected, and meta/brand are self-contained fixtures.
//
// Usage:
//   node scripts/testRemotionTitles.js \
//     [--media <url-or-path>]               # default: synthesized fixture
//     [--format vertical|feed|landscape]    # default: vertical
//     [--preset <name>]                     # remotion titleStylePreset pin
//     [--engine both|canvas|remotion]       # default: both
//     [--keep]                              # retain temp dirs for post-mortem
//
// The default fixture is a solid-color plate encoded at 25fps ON
// PURPOSE: both engines historically assumed 24fps, and the Remotion
// engine now probes fps from the source — a 25/1 output stream proves
// the probe actually drove the composition instead of an assumption.
//
// Assertions per output (±0.15s of the expected duration, h264 video,
// an audio stream, exact WxH; Remotion additionally must emit 25/1
// when the fixture plate is used). Exit 0 only if every check passes.

require('dotenv').config();

const fs     = require('fs');
const fsp    = fs.promises;
const path   = require('path');
const os     = require('os');
const http   = require('http');
const axios  = require('axios');
const { spawn } = require('child_process');

const ffmpegPath  = require('ffmpeg-static');
const FFPROBE     = path.join(__dirname, '..', 'node_modules', '@remotion', 'compositor-linux-x64-gnu', 'ffprobe');
const OUT_DIR     = path.join(__dirname, 'out');
const FIXTURE_DURATION_SEC = 8;
const FIXTURE_FPS = 25;

// Output canvas dimensions per platform format bucket.
const DIMS = {
  vertical:  { width: 1080, height: 1920 },
  feed:      { width: 1080, height: 1350 },
  landscape: { width: 1920, height: 1080 },
};

// ── Fixtures ───────────────────────────────────────────────────────
//
// Pelagic-ish brand: deep-ocean primary, sand accent, a real Google
// Fonts family so the Remotion font resolver exercises its live path
// (falls back to defaults with a logged warning when offline).
function fixtureBrand(preset) {
  return {
    _id: 'fixture-brand',
    name: 'Pelagic Test Fixture',
    primaryColor:   '#0B2545',
    secondaryColor: '#8DA9C4',
    accentColor:    '#F2C14E',
    fontFamily:     'Barlow Condensed',
    tagline:        'Built for blue water',
    websiteUrl:     'https://pelagic-fixture.example.com',
    logoUrl:        null,
    titleStylePreset: preset || null,
  };
}

// Every slot both canonicals read is fed, so a blank region in the
// output means a rendering bug, not missing data. theme mirrors what
// brandScriptExecutor.deriveTheme would produce for this brand (the
// canvas child consumes [r,g,b] arrays, not hex).
function fixtureMeta(brand) {
  return {
    brandName:    brand.name,
    headline:     'Gear that goes deeper',
    quote:        'The fit and finish blew me away — this is the first hoodie that survives a full season offshore.',
    quoteSnippet: 'First hoodie that survives offshore',
    reviewer:     'Dana M.',
    badgeText:    'Bestseller',
    productName:  'Aquatek Pro Hoodie',
    price:        '$59',
    deliveryLine: 'Free 2-day shipping',
    ctaText:      'SHOP NOW',
    cta:          'SHOP NOW', // legacy alias some canvas scripts still read
    rating:       4.9,
    reviewCount:  395,
    reviewsText:  '395 reviews',
    promoText:    null,       // no promo signal → DR-v1 pill must be skipped
    endcardMode:  'product',
    brandTagline:    brand.tagline,
    brandWebsiteUrl: brand.websiteUrl,
    theme: {
      textPrimary:    [255, 255, 255],
      textSecondary:  [141, 169, 196], // #8DA9C4
      scrimColor:     [0, 0, 0],
      endcardBgColor: [11, 37, 69],    // #0B2545
      accentColor:    [242, 193, 78],  // #F2C14E
      promoBgColor:   [242, 193, 78],
      starColor:      [245, 183, 10],
      promoTextColor: [22, 22, 26],
      headingFontFamily: brand.fontFamily,
      bodyFontFamily:    brand.fontFamily,
      quoteFontFamily:   'Lora',
    },
  };
}

// ── Arg parsing ────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { media: null, format: 'vertical', preset: null, engine: 'both', keep: false };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) die(`Unexpected argument: ${argv[i]}`);
    const key = m[1];
    const val = m[2] !== undefined ? m[2] : argv[++i];
    if (key === 'keep') { out.keep = true; if (m[2] === undefined) i--; continue; }
    if (!(key in out)) die(`Unknown flag: --${key}`);
    if (val === undefined) die(`--${key} needs a value`);
    out[key] = val;
  }
  if (!DIMS[out.format]) die(`--format must be one of: ${Object.keys(DIMS).join('|')}`);
  if (!['both', 'canvas', 'remotion'].includes(out.engine)) die('--engine must be both|canvas|remotion');
  return out;
}

function die(msg) {
  console.error(`❌ ${msg}`);
  console.error('Usage: node scripts/testRemotionTitles.js [--media <url-or-path>] [--format vertical|feed|landscape] [--preset <name>] [--engine both|canvas|remotion] [--keep]');
  process.exit(1);
}

// ── Process helpers ────────────────────────────────────────────────

function runBin(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code, signal) => {
      if (code === 0) return resolve(stdout);
      const tail = stderr.split('\n').filter(l => l.trim()).slice(-20).join('\n');
      reject(new Error(`${path.basename(bin)} exited code=${code} signal=${signal || 'none'}\n${tail}`));
    });
    proc.on('error', reject);
  });
}

async function ffprobe(file) {
  const out = await runBin(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    file,
  ]);
  return JSON.parse(out);
}

// ── Fixture plate synthesis ────────────────────────────────────────
//
// sharp solid PNG → ffmpeg loop + lavfi sine. The bundled ffmpeg-static
// is a slim build: no drawtext/testsrc fanciness, but -loop/-f lavfi
// sine/libx264/aac all work. 25fps + AAC tone so fps probing and
// audio-passthrough are both exercised.
async function buildFixture(format, workDir) {
  const { width, height } = DIMS[format];
  const sharp = require('sharp');
  const platePath = path.join(workDir, 'plate.png');
  await sharp({
    create: { width, height, channels: 3, background: { r: 11, g: 37, b: 69 } }, // brand primary #0B2545
  }).png().toFile(platePath);

  const fixturePath = path.join(workDir, `fixture_${format}.mp4`);
  await runBin(ffmpegPath, [
    '-y',
    '-loop', '1', '-i', platePath,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${FIXTURE_DURATION_SEC}`,
    '-t', String(FIXTURE_DURATION_SEC),
    '-r', String(FIXTURE_FPS),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    fixturePath,
  ]);
  console.log(`🎞  fixture plate: ${width}x${height} @ ${FIXTURE_FPS}fps, ${FIXTURE_DURATION_SEC}s sine audio → ${fixturePath}`);
  return fixturePath;
}

// ── Loopback file server ───────────────────────────────────────────
//
// renderBrandScript downloads its videoUrl via axios, so a local
// fixture must be served over HTTP. Full-body 200 is enough — axios
// never sends Range for a plain stream download.
function serveFile(filePath) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      fs.stat(filePath, (err, stat) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size });
        fs.createReadStream(filePath).pipe(res);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/plate.mp4`,
        close: () => server.close(),
      });
    });
  });
}

async function downloadToFile(url, filePath) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 60_000 });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filePath);
    res.data.pipe(w);
    res.data.on('error', reject);
    w.on('error', reject);
    w.on('finish', resolve);
  });
  return filePath;
}

// ── Canonical canvas script resolution (DB-free) ───────────────────
//
// systemConfigService.getCanonicalScript*() hit SystemConfig via
// mongoose, which BUFFERS (then times out) when no connection exists.
// This script never connects, so mirror loadCanonical's file-fallback
// leg directly using the service's exported path constants — same
// files, same env-driven vertical selection (CANONICAL_DR_V1), no DB.
async function loadCanonicalScript(format) {
  const mongoose = require('mongoose');
  const sysCfg = require('../services/systemConfigService');
  if (mongoose.connection.readyState === 1) {
    const getter = {
      feed:      sysCfg.getCanonicalScript,
      vertical:  sysCfg.getCanonicalScriptVertical,
      landscape: sysCfg.getCanonicalScriptLandscape,
    }[format];
    const got = await getter();
    if (!got?.script) {
      die('canvas canonical retired (no DB script; file fallback removed) — use --engine remotion');
    }
    console.log(`🔤 canvas canonical (${format}): source=${got.source}`);
    return got.script;
  }
  die('canvas canonical file fallback removed — connect Mongo with a DB script or use --engine remotion');
}

// ── Engine runners ─────────────────────────────────────────────────
//
// Both return renderBrandScript's contract: { finalPath, tempDir, timings }.

async function runCanvas({ mediaPath, format, meta, brandName }) {
  const { renderBrandScript } = require('../services/brandScriptExecutor');
  const styleScript = await loadCanonicalScript(format);
  const served = await serveFile(mediaPath);
  try {
    console.log('🎨 canvas: rendering frame-by-frame (child streams :: progress lines; may take a few minutes)...');
    return await renderBrandScript({
      videoUrl:  served.url,
      styleScript,
      meta,
      adId:      'titles-test',
      brandName,
    });
  } finally {
    served.close();
  }
}

async function runRemotion({ mediaPath, format, meta, brand }) {
  const { resolveSpecForBrand, buildBrandTokens } = require('../services/titleSpecService');
  const { renderTitles } = require('../services/remotionRenderService');
  const { spec, source } = resolveSpecForBrand(brand, format);
  const tokens = await buildBrandTokens(brand, { specFontOverrides: spec.tokenOverrides?.fonts || {} });
  console.log(`🎬 remotion: spec=${source} fonts=${['heading', 'body', 'quote'].map(r => `${r}:${tokens.fonts[r].family}(${tokens.fonts[r].source})`).join(' ')}`);
  return renderTitles({
    videoUrl:  mediaPath, // renderTitles copies local paths itself
    meta,
    spec,
    tokens,
    format,
    brandName: brand.name,
    adId:      'titles-test',
  });
}

// ── Assertions ─────────────────────────────────────────────────────

function parseFrameRate(rate) {
  const m = /^(\d+)\/(\d+)$/.exec(String(rate || ''));
  if (!m || Number(m[2]) === 0) return null;
  return Number(m[1]) / Number(m[2]);
}

function checkOutput({ probe, engine, expected, fixtureUsed }) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });
  const v = (probe.streams || []).find(s => s.codec_type === 'video');
  const a = (probe.streams || []).find(s => s.codec_type === 'audio');
  const duration = Number(probe.format?.duration);

  push('duration',
    Number.isFinite(duration) && Math.abs(duration - expected.durationSec) <= 0.15,
    `${Number.isFinite(duration) ? duration.toFixed(3) : '?'}s (expected ${expected.durationSec.toFixed(2)}s ±0.15)`);
  push('video codec h264', v?.codec_name === 'h264', `codec=${v?.codec_name || 'none'}`);
  push('audio stream present', !!a, a ? `codec=${a.codec_name}` : 'no audio stream');
  push('dimensions',
    v?.width === expected.width && v?.height === expected.height,
    `${v?.width}x${v?.height} (expected ${expected.width}x${expected.height})`);
  // Only the Remotion engine promises source-fps fidelity; the canvas
  // engine hardcodes 24fps (that drift is WHY the probe exists).
  if (engine === 'remotion' && fixtureUsed) {
    const fps = parseFrameRate(v?.r_frame_rate);
    push('fps 25/1 (probed from fixture)', v?.r_frame_rate === '25/1' || fps === FIXTURE_FPS, `r_frame_rate=${v?.r_frame_rate || '?'}`);
  }
  return checks;
}

// ── Main ───────────────────────────────────────────────────────────

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const format = args.format;
  const brand = fixtureBrand(args.preset);
  const meta = fixtureMeta(brand);
  const engines = args.engine === 'both' ? ['canvas', 'remotion'] : [args.engine];

  await fsp.mkdir(OUT_DIR, { recursive: true });
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'titles_test_'));

  // Resolve the plate: fixture synthesis, local path, or URL download.
  // A URL is downloaded once so both engines see identical bytes and
  // the source can be probed for expected duration/dimensions.
  let mediaPath;
  let fixtureUsed = false;
  if (!args.media) {
    fixtureUsed = true;
    mediaPath = await buildFixture(format, workDir);
  } else if (/^https?:\/\//i.test(args.media)) {
    mediaPath = path.join(workDir, 'source.mp4');
    console.log(`🎞  downloading media: ${args.media}`);
    await downloadToFile(args.media, mediaPath);
  } else {
    mediaPath = path.resolve(args.media);
    if (!fs.existsSync(mediaPath)) die(`--media file not found: ${mediaPath}`);
  }

  // Expected values: fixed for the fixture; probed from the source for
  // operator-supplied media (both engines preserve source dims, and
  // duration must track the source within mux tolerance).
  let expected;
  if (fixtureUsed) {
    expected = { durationSec: FIXTURE_DURATION_SEC, ...DIMS[format] };
  } else {
    const src = await ffprobe(mediaPath);
    const v = (src.streams || []).find(s => s.codec_type === 'video');
    if (!v) die(`--media has no video stream: ${mediaPath}`);
    expected = { durationSec: Number(src.format?.duration) || FIXTURE_DURATION_SEC, width: v.width, height: v.height };
    console.log(`🎞  source media: ${v.width}x${v.height}, ${expected.durationSec.toFixed(2)}s, r_frame_rate=${v.r_frame_rate}`);
  }

  console.log(`\n=== Run plan ===`);
  console.log(JSON.stringify({
    engines, format, preset: args.preset || '(canonical)',
    media: fixtureUsed ? 'fixture' : args.media,
    expected, keep: args.keep,
  }, null, 2));

  const results = [];
  for (const engine of engines) {
    console.log(`\n${'─'.repeat(72)}\n▶ engine=${engine} format=${format}\n${'─'.repeat(72)}`);
    const t0 = Date.now();
    const destPath = path.join(OUT_DIR, `titles_${engine}_${format}.mp4`);
    try {
      const render = engine === 'canvas'
        ? await runCanvas({ mediaPath, format, meta, brandName: brand.name })
        : await runRemotion({ mediaPath, format, meta, brand });

      await fsp.copyFile(render.finalPath, destPath);
      if (args.keep) {
        console.log(`   tempDir retained: ${render.tempDir}`);
      } else {
        await fsp.rm(render.tempDir, { recursive: true, force: true }).catch(() => {});
      }

      const probe = await ffprobe(destPath);
      const checks = checkOutput({ probe, engine, expected, fixtureUsed });
      console.log(`\n🔎 ${engine} assertions (${destPath}):`);
      for (const c of checks) console.log(`   ${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`);
      results.push({ engine, destPath, checks, timings: render.timings, ms: Date.now() - t0, error: null });
    } catch (err) {
      console.error(`❌ ${engine} render failed: ${err.message}`);
      results.push({ engine, destPath: null, checks: [], timings: null, ms: Date.now() - t0, error: err });
    }
  }

  // Upload only when Cloudinary is fully configured; local paths are
  // the deliverable otherwise (dev containers rarely carry the keys).
  const haveCloudinary = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;
  if (haveCloudinary) {
    const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
    for (const r of results) {
      if (!r.destPath) continue;
      const buffer = await fsp.readFile(r.destPath);
      const uploaded = await uploadBufferToCloudinary(buffer, {
        folder:       'liquidretail/brand_script_test',
        resourceType: 'video',
        overwrite:    true,
      });
      r.secureUrl = uploaded.secure_url;
      console.log(`☁️  ${r.engine} → ${uploaded.secure_url}`);
    }
  } else {
    console.log('\n☁️  CLOUDINARY_* not configured — outputs stay local:');
    for (const r of results) if (r.destPath) console.log(`   ${r.engine}: ${r.destPath}`);
  }

  if (!args.keep) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  else console.log(`\n🎞  fixture workDir retained: ${workDir}`);

  const allPass = results.length > 0
    && results.every(r => !r.error && r.checks.length > 0 && r.checks.every(c => c.ok));

  console.log(`\n${'─'.repeat(72)}\n  SUMMARY\n${'─'.repeat(72)}`);
  for (const r of results) {
    const passed = r.checks.filter(c => c.ok).length;
    const status = r.error ? `💥 ${r.error.message.split('\n')[0]}` : `${passed === r.checks.length ? '✅' : '❌'} ${passed}/${r.checks.length} checks`;
    console.log(`  ${r.engine.padEnd(9)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${status}`);
    if (r.secureUrl) console.log(`  ${' '.repeat(9)} ${r.secureUrl}`);
  }
  console.log('─'.repeat(72));
  console.log(allPass ? '✅ all assertions passed' : '❌ some assertions failed — see above');
  process.exit(allPass ? 0 : 1);
})().catch(err => {
  console.error('❌ testRemotionTitles failed:', err.message);
  console.error(err.stack);
  process.exit(99);
});
