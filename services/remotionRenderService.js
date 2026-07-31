// Remotion SSR render service for the video titling engine.
//
// Lifecycle: bundle() the remotion/ island once per process (warmed at boot,
// lazily on first render otherwise), keep a single headless browser, and
// run renders through a concurrency-1 promise queue (renders are memory-
// heavy — same spirit as VEO_CONCURRENCY).
//
// Asset delivery: the render browser must fetch the plate video and font
// files. Instead of relying on egress from headless Chrome, everything is
// downloaded server-side (axios, which honors the app's proxy env) into a
// per-job directory and served over a loopback HTTP server with Range
// support. The browser only ever talks to 127.0.0.1.
//
// fps/duration: probed from the actual plate with @remotion/media-parser —
// never assumed. The canvas engine's hardcoded 24fps caused duration drift
// on non-24fps sources; here composition fps follows the source (clamped
// 12..60) and durationInFrames = round(durationSec × fps).

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const crypto = require('crypto');
const axios = require('axios');

const { FONT_CACHE_DIR } = require('./fontResolverService');

const COMPOSITION_BY_FORMAT = {
  vertical: 'CanonicalVertical',
  feed: 'CanonicalFeed',
  square: 'CanonicalSquare',   // 1080x1080 Meta Feed 1:1 — see remotion/Root.jsx
  landscape: 'CanonicalLandscape',
};

const ENTRY_POINT = path.join(__dirname, '..', 'remotion', 'index.jsx');
const ASSET_ROOT = path.join(os.tmpdir(), 'remotion_assets');
const RENDER_TIMEOUT_MS = Number(process.env.REMOTION_TIMEOUT_MS || 180_000);

// ── bundle cache ───────────────────────────────────────────────────────────

let bundlePromise = null;

function getServeUrl() {
  if (!bundlePromise) {
    const started = Date.now();
    const { bundle } = require('@remotion/bundler');
    bundlePromise = bundle({ entryPoint: ENTRY_POINT, onProgress: () => {} })
      .then((dir) => {
        console.log(`🎬 remotion: bundle ready in ${Date.now() - started}ms (${dir})`);
        return dir;
      })
      .catch((e) => {
        bundlePromise = null; // allow retry on next render
        throw e;
      });
  }
  return bundlePromise;
}

// ── browser ────────────────────────────────────────────────────────────────

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function resolveBrowserExecutable() {
  if (process.env.REMOTION_BROWSER_EXECUTABLE) return process.env.REMOTION_BROWSER_EXECUTABLE;
  // Remotion needs old-headless — i.e. a chrome-headless-shell binary.
  // Modern full-Chrome binaries (≥132) removed that mode, so plain `chrome`
  // executables are NOT candidates here; when nothing matches we return null
  // and ensureBrowser() downloads Remotion's own headless shell.
  const candidates = [];
  const globDir = (root, entryToPath) => {
    try {
      for (const entry of fs.readdirSync(root)) candidates.push(entryToPath(root, entry));
    } catch {}
  };
  // Playwright-managed containers
  globDir('/opt/pw-browsers', (root, e) =>
    e.startsWith('chromium_headless_shell') ? path.join(root, e, 'chrome-linux', 'headless_shell') : null
  );
  // Render.com: puppeteer cache pinned to <repo>/.cache/puppeteer (.puppeteerrc.cjs)
  globDir(path.join(__dirname, '..', '.cache', 'puppeteer', 'chrome-headless-shell'), (root, e) =>
    path.join(root, e, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
  );
  return firstExisting(candidates.filter(Boolean));
}

let browserReadyPromise = null;

function ensureBrowserReady() {
  if (!browserReadyPromise) {
    const { ensureBrowser } = require('@remotion/renderer');
    const local = resolveBrowserExecutable();
    browserReadyPromise = local
      ? Promise.resolve(local).then((p) => {
          console.log(`🎬 remotion: using browser at ${p}`);
          return p;
        })
      : ensureBrowser().then(() => {
          console.log('🎬 remotion: headless shell downloaded via ensureBrowser()');
          return null; // renderer resolves its own download
        });
    browserReadyPromise.catch((e) => {
      browserReadyPromise = null;
      console.warn(`🎬 remotion: browser preparation failed (${e.message})`);
    });
  }
  return browserReadyPromise;
}

// ── loopback asset server (Range-capable) ──────────────────────────────────

let assetServerPromise = null;

const MIME = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml', // brand logos are frequently SVG; Chrome refuses octet-stream SVGs
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

// URL space:  /jobs/<jobId>/<file>  → ASSET_ROOT/<jobId>/<file>
//             /fonts/<file>        → FONT_CACHE_DIR/<file>
function assetPathFor(urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^\/+/, '');
  const [head, ...rest] = clean.split(path.sep);
  if (!rest.length) return null;
  let base = null;
  let rel = null;
  if (head === 'jobs') {
    base = ASSET_ROOT;
    rel = rest.join(path.sep);
  } else if (head === 'fonts') {
    base = FONT_CACHE_DIR;
    rel = rest.join(path.sep);
  } else {
    return null;
  }
  const abs = path.join(base, rel);
  if (!abs.startsWith(base + path.sep)) return null; // traversal guard
  return abs;
}

function getAssetServer() {
  if (!assetServerPromise) {
    assetServerPromise = (async () => {
      await fsp.mkdir(ASSET_ROOT, { recursive: true });
      const server = http.createServer(async (req, res) => {
        try {
          const abs = assetPathFor(new URL(req.url, 'http://x').pathname);
          const stat = abs ? await fsp.stat(abs).catch(() => null) : null;
          if (!stat || !stat.isFile()) {
            res.writeHead(404);
            res.end('not found');
            return;
          }
          const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
          // FontFace fetches from the bundle origin are CORS-enforced
          // (media elements are not) — allow all, we only serve loopback.
          res.setHeader('Access-Control-Allow-Origin', '*');
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
          if (range && (range[1] !== '' || range[2] !== '')) {
            const start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
            const end = range[2] === '' || range[1] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
            if (start > end || start >= stat.size) {
              res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
              res.end();
              return;
            }
            res.writeHead(206, {
              'Content-Type': type,
              'Accept-Ranges': 'bytes',
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Content-Length': end - start + 1,
            });
            fs.createReadStream(abs, { start, end }).pipe(res);
          } else {
            res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
            fs.createReadStream(abs).pipe(res);
          }
        } catch (e) {
          res.writeHead(500);
          res.end(String(e.message));
        }
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      server.unref();
      const base = `http://127.0.0.1:${server.address().port}`;
      console.log(`🎬 remotion: asset server on ${base}`);
      return { server, base };
    })().catch((e) => {
      assetServerPromise = null;
      throw e;
    });
  }
  return assetServerPromise;
}

// ── render queue (concurrency 1) ───────────────────────────────────────────

let queueTail = Promise.resolve();

function enqueue(taskFn) {
  const run = queueTail.then(taskFn, taskFn); // keep queue alive after failures
  queueTail = run.catch(() => {});
  return run;
}

// Fast lane for stills-only previews (the operator refinement loop):
// a still takes ~1-3s but would otherwise wait behind a multi-minute
// production render in the main queue — past the frontend proxy timeout.
// Chrome handles a second concurrent page fine; stills at preview scale
// add little memory.
let stillsQueueTail = Promise.resolve();

function enqueueStill(taskFn) {
  const run = stillsQueueTail.then(taskFn, taskFn);
  stillsQueueTail = run.catch(() => {});
  return run;
}

// ── helpers ────────────────────────────────────────────────────────────────

async function downloadToFile(url, filePath) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 60_000 });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filePath);
    // axios's timeout only covers up to response headers — a stream that
    // stalls mid-body would otherwise hang the render queue forever.
    let watchdog = null;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        res.data.destroy(new Error(`download stalled (no data for 45s): ${url}`));
      }, 45_000);
    };
    arm();
    res.data.on('data', arm);
    const done = (fn) => (arg) => {
      clearTimeout(watchdog);
      fn(arg);
    };
    res.data.on('error', done(reject));
    w.on('error', done(reject));
    w.on('finish', done(resolve));
    res.data.pipe(w);
  });
  return filePath;
}

async function probePlate(filePath) {
  const { parseMedia } = require('@remotion/media-parser');
  const { nodeReader } = require('@remotion/media-parser/node');
  const { fps, slowDurationInSeconds, dimensions } = await parseMedia({
    src: filePath,
    reader: nodeReader,
    fields: { fps: true, slowDurationInSeconds: true, dimensions: true },
    acknowledgeRemotionLicense: true,
  });
  const safeFps = Number.isFinite(fps) && fps > 0 ? Math.min(60, Math.max(12, Math.round(fps))) : 24;
  const durationSec = Number.isFinite(slowDurationInSeconds) && slowDurationInSeconds > 0 ? slowDurationInSeconds : 8;
  return { fps: safeFps, durationSec, width: dimensions?.width, height: dimensions?.height };
}

// Rewrite resolved font local paths into asset-server URLs the browser can load.
function fontsToUrls(fonts, base) {
  const out = {};
  for (const [role, f] of Object.entries(fonts || {})) {
    if (!f) continue;
    out[role] = {
      ...f,
      url: f.url ? `${base}/fonts/${encodeURIComponent(path.basename(f.url))}` : null,
    };
  }
  return out;
}

function stripHeavyMeta(meta) {
  // theme is the canvas engine's concern; local file paths are meaningless
  // inside the render browser.
  const { theme, productOnlyImagePath, brandLogoPath, ...rest } = meta || {};
  return rest;
}

function websiteDomain(url) {
  return String(url || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '') || null;
}

const chromiumOptions = { enableMultiProcessOnLinux: true };

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Warm the bundle + browser + asset server at boot (non-blocking caller-side).
 */
async function warmup() {
  await Promise.all([getServeUrl(), ensureBrowserReady(), getAssetServer()]);
}

/**
 * Render titles over the ad's base video. Mirrors renderBrandScript's
 * contract: returns { finalPath, tempDir, timings } — the caller uploads
 * finalPath and removes tempDir.
 */
async function renderTitles({ videoUrl, meta, spec, tokens, format, brandName = null, adId = null, placementMode = null, brand = null }) {
  if (!videoUrl) throw new Error('renderTitles: videoUrl required');
  if (!spec) throw new Error('renderTitles: spec required');
  const compositionId = COMPOSITION_BY_FORMAT[format];
  if (!compositionId) throw new Error(`renderTitles: unknown format '${format}'`);

  return enqueue(async () => {
    const timings = {};
    let t = Date.now();

    const [serveUrl, browserExecutable, { base }] = await Promise.all([
      getServeUrl(),
      ensureBrowserReady(),
      getAssetServer(),
    ]);
    timings.warmMs = Date.now() - t;

    const jobId = crypto.randomBytes(6).toString('hex');
    const jobDir = path.join(ASSET_ROOT, jobId);
    await fsp.mkdir(jobDir, { recursive: true });

    try {
      // 1. plate download + probe (local paths supported for tests/previews)
      t = Date.now();
      const platePath = path.join(jobDir, 'plate.mp4');
      if (/^https?:\/\//i.test(videoUrl)) {
        await downloadToFile(videoUrl, platePath);
      } else {
        await fsp.copyFile(videoUrl.replace(/^file:\/\//, ''), platePath);
      }
      const probe = await probePlate(platePath);
      timings.downloadMs = Date.now() - t;

      const fps = probe.fps;
      const durationInFrames = Math.max(1, Math.round(probe.durationSec * fps));

      // Placement: 'canonical' skips plate scan (static titles); 'content'
      // runs analyzePlate (TITLE_PLATE_SCAN depth). Kill switch TITLE_PLATE_SCAN=off
      // forces canonical via resolveTitlePlacementMode.
      const { analyzePlate, resolveTitlePlacementMode } = require('./plateIntelService');
      const placement = resolveTitlePlacementMode({ placementMode, brand });
      timings.placementMode = placement;
      t = Date.now();
      let plateHints = null;
      if (placement === 'content') {
        plateHints = await analyzePlate(platePath, { durationSec: probe.durationSec });
      }
      timings.plateScanMs = Date.now() - t;
      console.log(`🎬 remotion[ad=${adId || '?'}]: placement=${placement} format=${format}`);

      // Brand logo: served to the render browser from the asset server
      // (the browser has no external egress).
      const cleanMeta = { ...stripHeavyMeta(meta), brandWebsiteDomain: websiteDomain(meta?.brandWebsiteUrl) };
      if (cleanMeta.brandLogoUrl && /^https?:\/\//i.test(cleanMeta.brandLogoUrl)) {
        try {
          const ext = (path.extname(new URL(cleanMeta.brandLogoUrl).pathname) || '.png').slice(0, 6);
          await downloadToFile(cleanMeta.brandLogoUrl, path.join(jobDir, `logo${ext}`));
          cleanMeta.brandLogoUrl = `${base}/jobs/${jobId}/logo${ext}`;
        } catch (e) {
          console.warn(`🎬 remotion[ad=${adId || '?'}]: logo download failed (${e.message}) — text pill fallback`);
          cleanMeta.brandLogoUrl = null;
        }
      }
      // Product image: same asset-server pattern so the productImage slot
      // (title-spec bind chain: ['productImageUrl']) can render without
      // relying on external egress from the render browser.
      if (cleanMeta.productImageUrl && /^https?:\/\//i.test(cleanMeta.productImageUrl)) {
        try {
          const ext = (path.extname(new URL(cleanMeta.productImageUrl).pathname) || '.jpg').slice(0, 6);
          await downloadToFile(cleanMeta.productImageUrl, path.join(jobDir, `product${ext}`));
          cleanMeta.productImageUrl = `${base}/jobs/${jobId}/product${ext}`;
        } catch (e) {
          console.warn(`🎬 remotion[ad=${adId || '?'}]: product image download failed (${e.message}) — productImage slot will be skipped`);
          cleanMeta.productImageUrl = null;
        }
      }

      const inputProps = {
        format,
        fps,
        durationInFrames,
        plate: { videoUrl: `${base}/jobs/${jobId}/plate.mp4` },
        meta: cleanMeta,
        tokens: { ...tokens, fonts: fontsToUrls(tokens?.fonts, base) },
        spec,
        plateHints,
      };

      // 2. select + render
      t = Date.now();
      const { selectComposition, renderMedia } = require('@remotion/renderer');
      const composition = await selectComposition({
        serveUrl,
        id: compositionId,
        inputProps,
        browserExecutable,
        chromiumOptions,
        timeoutInMilliseconds: RENDER_TIMEOUT_MS,
      });
      timings.selectMs = Date.now() - t;

      t = Date.now();
      const finalPath = path.join(jobDir, 'out.mp4');
      let lastLogged = 0;
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        audioCodec: 'aac',
        outputLocation: finalPath,
        inputProps,
        browserExecutable,
        chromiumOptions,
        timeoutInMilliseconds: RENDER_TIMEOUT_MS,
        concurrency: process.env.REMOTION_CONCURRENCY ? Number(process.env.REMOTION_CONCURRENCY) : null,
        onProgress: ({ progress }) => {
          const pct = Math.round(progress * 100);
          if (pct >= lastLogged + 25) {
            lastLogged = pct;
            console.log(`🎬 remotion[ad=${adId || '?'}]: render ${pct}%`);
          }
        },
      });
      timings.renderMs = Date.now() - t;
      timings.fps = fps;
      timings.durationInFrames = durationInFrames;

      return { finalPath, tempDir: jobDir, timings };
    } catch (e) {
      await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  });
}

/**
 * Preview renders for the operator UI. Same spec/tokens pipeline but over a
 * static plate image, a real plate VIDEO (plateVideoPath — probed fps/
 * duration, exact source frames under every still), or a flat color;
 * half-resolution, no audio. Returns { videoDataUrl, sizeBytes, timings,
 * plateHints, fps, durationSec } to preserve the existing preview contract,
 * and optionally still frames.
 */
async function renderPreview({ meta, spec, tokens, format, plateImagePath = null, plateVideoPath = null, plateColor = '#3D3D3D', scale = 0.5, durationSec = 8, stillTimesSec = null, includeVideo = true, placementMode = null, brand = null }) {
  const compositionId = COMPOSITION_BY_FORMAT[format];
  if (!compositionId) throw new Error(`renderPreview: unknown format '${format}'`);

  const lane = includeVideo ? enqueue : enqueueStill;
  return lane(async () => {
    const timings = {};
    let t = Date.now();
    const [serveUrl, browserExecutable, { base }] = await Promise.all([
      getServeUrl(),
      ensureBrowserReady(),
      getAssetServer(),
    ]);
    timings.warmMs = Date.now() - t;

    const jobId = crypto.randomBytes(6).toString('hex');
    const jobDir = path.join(ASSET_ROOT, jobId);
    await fsp.mkdir(jobDir, { recursive: true });

    try {
      let fps = 24;
      let plate = { color: plateColor };
      let plateHints = null;
      const { analyzePlate, resolveTitlePlacementMode } = require('./plateIntelService');
      const placement = resolveTitlePlacementMode({ placementMode, brand });
      timings.placementMode = placement;
      if (plateVideoPath) {
        // Real footage: renderStill + OffthreadVideo composites titles onto
        // the exact source frame at each timestamp, fps/duration follow the
        // probe (so specTimeScale previews true pacing). Content mode runs
        // the visibility scan on the same plate production would.
        const target = path.join(jobDir, 'plate.mp4');
        await fsp.copyFile(plateVideoPath, target);
        const probe = await probePlate(target);
        fps = probe.fps;
        durationSec = probe.durationSec;
        plate = { videoUrl: `${base}/jobs/${jobId}/plate.mp4` };
        if (placement === 'content') {
          plateHints = await analyzePlate(target, { durationSec: probe.durationSec });
        }
      } else if (plateImagePath) {
        const ext = path.extname(plateImagePath) || '.jpg';
        const target = path.join(jobDir, `plate${ext}`);
        await fsp.copyFile(plateImagePath, target);
        plate = { imageUrl: `${base}/jobs/${jobId}/plate${ext}` };
        if (placement === 'content') {
          plateHints = await analyzePlate(plateImagePath, { isImage: true });
        }
      }
      const durationInFrames = Math.max(1, Math.round(durationSec * fps));

      const cleanMeta = { ...stripHeavyMeta(meta), brandWebsiteDomain: websiteDomain(meta?.brandWebsiteUrl) };
      if (cleanMeta.brandLogoUrl && /^https?:\/\//i.test(cleanMeta.brandLogoUrl)) {
        try {
          const ext = (path.extname(new URL(cleanMeta.brandLogoUrl).pathname) || '.png').slice(0, 6);
          await downloadToFile(cleanMeta.brandLogoUrl, path.join(jobDir, `logo${ext}`));
          cleanMeta.brandLogoUrl = `${base}/jobs/${jobId}/logo${ext}`;
        } catch {
          cleanMeta.brandLogoUrl = null;
        }
      } else if (cleanMeta.brandLogoUrl && fs.existsSync(cleanMeta.brandLogoUrl)) {
        // Local logo path (tests, cached assets) — serve it like the plate.
        const ext = path.extname(cleanMeta.brandLogoUrl) || '.png';
        await fsp.copyFile(cleanMeta.brandLogoUrl, path.join(jobDir, `logo${ext}`));
        cleanMeta.brandLogoUrl = `${base}/jobs/${jobId}/logo${ext}`;
      }

      const inputProps = {
        format,
        fps,
        durationInFrames,
        plate,
        meta: cleanMeta,
        tokens: { ...tokens, fonts: fontsToUrls(tokens?.fonts, base) },
        spec,
        plateHints,
      };

      const { selectComposition, renderMedia, renderStill } = require('@remotion/renderer');
      const composition = await selectComposition({
        serveUrl,
        id: compositionId,
        inputProps,
        browserExecutable,
        chromiumOptions,
        timeoutInMilliseconds: RENDER_TIMEOUT_MS,
      });

      // plateHints/fps/durationSec/placementMode ride along so callers
      // (title-still) can hand scan data + mode to the operator UI.
      const result = { timings, plateHints, fps, durationSec, placementMode: placement };

      if (stillTimesSec && stillTimesSec.length) {
        t = Date.now();
        result.frames = [];
        for (const sec of stillTimesSec) {
          const frame = Math.min(durationInFrames - 1, Math.max(0, Math.round(sec * fps)));
          const stillPath = path.join(jobDir, `still_${frame}.png`);
          await renderStill({
            composition,
            serveUrl,
            output: stillPath,
            inputProps,
            frame,
            browserExecutable,
            chromiumOptions,
            scale,
            timeoutInMilliseconds: RENDER_TIMEOUT_MS,
          });
          const buf = await fsp.readFile(stillPath);
          result.frames.push({ index: frame, dataUrl: `data:image/png;base64,${buf.toString('base64')}` });
        }
        timings.stillsMs = Date.now() - t;
      }

      // Stills-only mode: the fast refinement loop (title-still endpoint /
      // playground) skips the video encode entirely — a warm still is
      // ~1-3s vs ~40s for the full preview clip.
      if (!includeVideo) return result;

      t = Date.now();
      const outPath = path.join(jobDir, 'preview.mp4');
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: outPath,
        inputProps,
        browserExecutable,
        chromiumOptions,
        scale,
        timeoutInMilliseconds: RENDER_TIMEOUT_MS,
        concurrency: process.env.REMOTION_CONCURRENCY ? Number(process.env.REMOTION_CONCURRENCY) : null,
      });
      const buf = await fsp.readFile(outPath);
      result.videoDataUrl = `data:video/mp4;base64,${buf.toString('base64')}`;
      result.sizeBytes = buf.length;
      timings.renderMs = Date.now() - t;

      return result;
    } finally {
      await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

module.exports = {
  warmup,
  renderTitles,
  renderPreview,
  COMPOSITION_BY_FORMAT,
};
