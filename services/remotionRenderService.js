// Remotion SSR render service for the video titling engine.
//
// Lifecycle: bundle() the remotion/ island once per process (warmed at boot,
// lazily on first render otherwise), keep a single headless browser, and run
// renders through a bounded pool (REMOTION_QUEUE_CONCURRENCY, default 4).
// Renders are memory-heavy, so the pool — not the caller's permit — is the real
// limit; see the note above `enqueue`.
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
const { FONTS_DIR } = require('./fontLoader');

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
  // DELIBERATELY NO CANDIDATE for Remotion's own cache — it resolves that itself.
  //
  // What used to be here was a glob of `<repo>/.cache/puppeteer/chrome-headless-shell`
  // whose comment claimed .puppeteerrc.cjs pinned the puppeteer cache there. It
  // does not, and has not since f89e30b moved the cache to
  // `node_modules/.puppeteer-cache` precisely BECAUSE Render loses `.cache/`
  // between the build and serve containers (see .puppeteerrc.cjs's header). So
  // that candidate could never match, and this was not a cosmetic wart: it was
  // why every fresh instance fell through to ensureBrowser() below and downloaded
  // ~92MB of headless shell on its FIRST render, on a user-visible request.
  //
  // Verified on the live box before removing it: `.cache/puppeteer` does not
  // exist at all, and `node_modules/.puppeteer-cache` holds only puppeteer's full
  // `chrome` — not a headless shell, so it is not a candidate for Remotion either.
  //
  // The fix is NOT a replacement glob. Remotion's cache nests three levels deep
  // and platform-specifically
  // (`node_modules/.remotion/chrome-headless-shell/<platform>/chrome-headless-shell-<platform>/chrome-headless-shell`),
  // so hand-rolling that path here would be brittle for no benefit —
  // ensureBrowser() already finds its own cache correctly. The actual fix is
  // scripts/ensureRemotionBrowser.js, which pre-warms that cache at BUILD time so
  // the download lands in the artifact and the runtime fallback becomes a no-op.
  // Keep the Playwright candidate above: that one is a genuinely external browser
  // this code could not otherwise discover.
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
//             /fonts/<file>         → FONT_CACHE_DIR/<file>   (google/custom cache)
//             /libfonts/<file>      → FONTS_DIR/<file>        (library-match TTFs)
//
// Two font directories exist: fontResolverService library-match writes under
// FONTS_DIR (fontLoader.js), while Google/custom downloads land in
// FONT_CACHE_DIR (webfonts/). Mapping every /fonts/* hit to FONT_CACHE_DIR
// 404s library-match files (and, pre-fix, that 404 lacked CORS so FontFace
// reported "A network error occurred" → @remotion/fonts cancelRender).
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
  } else if (head === 'libfonts') {
    base = FONTS_DIR;
    rel = rest.join(path.sep);
  } else {
    return null;
  }
  const abs = path.join(base, rel);
  // TRAVERSAL GUARD — human review: identical shape for EVERY base (jobs,
  // fonts, libfonts). Rejects abs that escapes base via .. segments after
  // path.join. Do not weaken to a bare includes() check.
  if (!abs.startsWith(base + path.sep)) return null;
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
          // FontFace fetches from the bundle origin are CORS-enforced
          // (media elements are not) — allow all, we only serve loopback.
          // CORS on 404 too: a miss must surface as a clean network/404 error,
          // not an opaque CORS failure that masks the real problem.
          if (!stat || !stat.isFile()) {
            res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
            res.end('not found');
            return;
          }
          const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
          res.setHeader('Access-Control-Allow-Origin', '*');
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
          if (range && (range[1] !== '' || range[2] !== '')) {
            const start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
            const end = range[2] === '' || range[1] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
            if (start > end || start >= stat.size) {
              res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Access-Control-Allow-Origin': '*' });
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
          res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
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

// ── render queue ───────────────────────────────────────────────────────────
//
// THIS IS THE REAL TITLING BOTTLENECK, and for a long time it was invisible.
//
// The queue was a promise CHAIN — `queueTail.then(task)` — which is
// concurrency 1 by construction. Meanwhile routes/ads.js wrapped every titling
// call in a VEO_TITLING_CONCURRENCY permit (4), whose own config note described
// it as "simultaneous Remotion titling renders". It was not: four permit
// holders arrived here and three of them waited. Raising the permit changed
// nothing, which is why the measured tail on a 20-ad run was 926s and 83% idle
// — 13 renders running strictly back to back at ~70s each.
//
// So the permit bounded the CHEAP half (Mongo reads, the copy cascade) and the
// expensive half was serial. This makes the queue a real bounded pool, so the
// concurrency number finally means what it says.
//
// MEMORY IS THE CONSTRAINT AND IT IS NOT MEASURED. Each slot is a headless
// Chrome page plus an ffmpeg 1080p encode inside the web process. The documented
// failure mode is not a provider 429 — it is RSS exhaustion, Render replacing
// the instance, and a paid Omni master stranded mid-titling. Default is
// therefore deliberately modest and the ceiling is env-driven: raise
// REMOTION_QUEUE_CONCURRENCY only against an observed RSS number, one step at a
// time, watching the web service's memory graph across a full run.
const QUEUE_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.REMOTION_QUEUE_CONCURRENCY, 10) || 4
);

let activeRenders = 0;
const waiting = [];

function pump() {
  while (activeRenders < QUEUE_CONCURRENCY && waiting.length) {
    const job = waiting.shift();
    activeRenders += 1;
    // settle() runs in a finally so a THROWN task still frees its slot. The old
    // chain got this free (`.then(task, task)` kept the chain alive after a
    // failure); a pool has to do it explicitly or one bad render permanently
    // shrinks the pool until nothing renders at all.
    Promise.resolve()
      .then(job.taskFn)
      .then(job.resolve, job.reject)
      .finally(() => { activeRenders -= 1; pump(); });
  }
}

function enqueue(taskFn) {
  return new Promise((resolve, reject) => {
    waiting.push({ taskFn, resolve, reject });
    pump();
  });
}

// Exposed for the harness and for operator telemetry — "how many are actually
// rendering vs waiting" is the number that explains a slow run, and it was not
// observable before.
function renderQueueStats() {
  return { concurrency: QUEUE_CONCURRENCY, active: activeRenders, waiting: waiting.length };
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

/**
 * Choose asset-server route for a resolved font localPath (which is stashed
 * on the token as `url` by resolveBrandFonts — still a filesystem path until
 * fontsToUrls rewrites it).
 *
 * library-match → FONTS_DIR → /libfonts/
 * google/custom → FONT_CACHE_DIR → /fonts/
 * unknown path  → /fonts/ (legacy default; will 404 cleanly if missing)
 */
function fontRouteForLocalPath(localPath) {
  if (!localPath || typeof localPath !== 'string') return 'fonts';
  const abs = path.resolve(localPath);
  // Same membership test shape as the assetPathFor traversal guard.
  if (abs === FONTS_DIR || abs.startsWith(FONTS_DIR + path.sep)) return 'libfonts';
  if (abs === FONT_CACHE_DIR || abs.startsWith(FONT_CACHE_DIR + path.sep)) return 'fonts';
  return 'fonts';
}

// Rewrite resolved font local paths into asset-server URLs the browser can load.
// Called at both renderTitles (:410) and renderPreview (:543) inputProps sites.
function fontsToUrls(fonts, base) {
  const out = {};
  for (const [role, f] of Object.entries(fonts || {})) {
    if (!f) continue;
    const route = fontRouteForLocalPath(f.url);
    out[role] = {
      ...f,
      url: f.url ? `${base}/${route}/${encodeURIComponent(path.basename(f.url))}` : null,
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
async function renderTitles({ videoUrl, meta, spec, tokens, format, brandName = null, adId = null, placementMode = null, brand = null, faceKeepOut = null, platformFormat = null, safeZoneKey = null }) {
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

      // Placement: 'canonical' keeps static title positions; 'content' also
      // uses the scan for placement. The plate scan itself now runs for BOTH
      // placements: Canonical.jsx's ink contrast flip (plateIsLightGlobal ->
      // on-light text tokens) consumes plateHints, and with hints null the
      // flip can never fire -- which shipped WHITE text on a near-white
      // studio plate (found live 2026-08-04, "this is hard to read"). The
      // scan was wired to the placement feature; legibility needs it always.
      // Kill switch TITLE_PLATE_SCAN=off still disables the scan entirely
      // via resolveTitlePlacementMode + the explicit check below.
      const { analyzePlate, resolveTitlePlacementMode, applyFaceKeepOut } = require('./plateIntelService');
      const placement = resolveTitlePlacementMode({ placementMode, brand });
      timings.placementMode = placement;
      t = Date.now();
      let plateHints = null;
      if (String(process.env.TITLE_PLATE_SCAN || '').toLowerCase() !== 'off') {
        try {
          // safeZoneKey: sample the luma/busy strips where THIS surface's copy
          // actually paints. Absent -> plateIntel's BANDS literals (inert).
          plateHints = await analyzePlate(platePath, { durationSec: probe.durationSec, safeZoneKey });
        } catch (err) {
          // Legibility intelligence must never fail a render; null keeps the
          // pre-fix behaviour (brand default ink).
          console.warn(`🎬 remotion[ad=${adId || '?'}]: plate scan failed (${err.message}) — ink flip unavailable`);
        }
      }
      // Face keep-out: map cached (or freshly-detected) face boxes onto band
      // avoid flags. faceKeepOut comes from brandScriptExecutor after
      // ensureFaceDetectionForKeepOut — both ad + plateHints exist here.
      // Failures leave plateHints unchanged (pre-keep-out behaviour).
      if (plateHints && faceKeepOut?.faceSamples?.length) {
        try {
          plateHints = applyFaceKeepOut(plateHints, faceKeepOut.faceSamples, {
            cropRect: faceKeepOut.cropRect || null,
            sourceW: faceKeepOut.sourceW || null,
            sourceH: faceKeepOut.sourceH || null,
            // Test the band the copy actually occupies on this surface. Without
            // it, a face below 0.65 on stories/feed/square never flags `avoid`.
            safeZoneKey,
          });
        } catch (err) {
          console.warn(`🎬 remotion[ad=${adId || '?'}]: face keep-out failed (${err.message}) — bands unflagged`);
        }
      }
      timings.plateScanMs = Date.now() - t;
      // Safe-zone selection is independent of composition id (`format`).
      // PMax VIDEO platformFormats → YT keys (resolved in Canonical via
      // resolveSafeZoneKey); Meta / absent / unknown → canvas format zones.
      // Pass both so a pre-resolved key OR a raw platformFormat works.
      console.log(
        `🎬 remotion[ad=${adId || '?'}]: placement=${placement} format=${format}` +
        (platformFormat ? ` platformFormat=${platformFormat}` : '') +
        (safeZoneKey ? ` safeZone=${safeZoneKey}` : '')
      );

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
        // YT safe-zone selection (PMax video). Composition id stays `format`.
        safeZoneKey: safeZoneKey || null,
        platformFormat: platformFormat || null,
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
async function renderPreview({ meta, spec, tokens, format, plateImagePath = null, plateVideoPath = null, plateColor = '#3D3D3D', scale = 0.5, durationSec = 8, stillTimesSec = null, includeVideo = true, placementMode = null, brand = null, platformFormat = null, safeZoneKey = null }) {
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
        // Scan for BOTH placements (same rationale as renderTitles): the ink
        // contrast flip needs hints, and preview must match production.
        if (String(process.env.TITLE_PLATE_SCAN || '').toLowerCase() !== 'off') {
          try {
            plateHints = await analyzePlate(target, { durationSec: probe.durationSec, safeZoneKey });
          } catch (err) {
            console.warn(`🎬 remotion preview: plate scan failed (${err.message}) — ink flip unavailable`);
          }
        }
      } else if (plateImagePath) {
        const ext = path.extname(plateImagePath) || '.jpg';
        const target = path.join(jobDir, `plate${ext}`);
        await fsp.copyFile(plateImagePath, target);
        plate = { imageUrl: `${base}/jobs/${jobId}/plate${ext}` };
        if (String(process.env.TITLE_PLATE_SCAN || '').toLowerCase() !== 'off') {
          try {
            plateHints = await analyzePlate(plateImagePath, { isImage: true, safeZoneKey });
          } catch (err) {
            console.warn(`🎬 remotion preview: plate scan failed (${err.message}) — ink flip unavailable`);
          }
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
        safeZoneKey: safeZoneKey || null,
        platformFormat: platformFormat || null,
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
  // test surface for scripts/verifyFontServing.js (pure helpers)
  assetPathFor,
  fontRouteForLocalPath,
  fontsToUrls,
  // Pool internals — exported so scripts/verifyTitlingQueueParallel.js can
  // prove the pool actually overlaps work instead of regexing for the word
  // "concurrency". A serial queue and a parallel one look identical in source.
  enqueue,
  renderQueueStats,
};
