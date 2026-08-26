// Remotion SSR render service for the video titling engine.
//
// Lifecycle: the PARENT process owns a bounded pool (REMOTION_QUEUE_CONCURRENCY)
// and spawns one child per production renderTitles call. The child bundles the
// remotion/ island, runs headless Chrome + ffmpeg, writes the titled MP4 to a
// temp path, prints a JSON report, and exits so the OS reclaims RSS. A Chrome/
// ffmpeg OOM kills the child, not the parent holding the other claimed ads.
// renderPreview stays in-process (operator stills; not the production RSS path).
// See remotionChildSupervisor.js + remotionRender.child.js.
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
const {
  RENDER_TIMEOUT_MS,
  CHILD_TIMEOUT_MS,
  superviseRemotionChild
} = require('./remotionChildSupervisor');

const COMPOSITION_BY_FORMAT = {
  vertical: 'CanonicalVertical',
  feed: 'CanonicalFeed',
  square: 'CanonicalSquare',   // 1080x1080 Meta Feed 1:1 — see remotion/Root.jsx
  landscape: 'CanonicalLandscape',
};

const ENTRY_POINT = path.join(__dirname, '..', 'remotion', 'index.jsx');
const ASSET_ROOT = path.join(os.tmpdir(), 'remotion_assets');
const CHILD_PATH = path.join(__dirname, 'remotionRender.child.js');
// Pre-bundle path — scripts/prebuildRemotionBundle.js writes here at Docker
// build time. When present, getServeUrl() skips the ~5-15s webpack bundle.
const PREBUILT_BUNDLE_DIR = path.join(__dirname, '..', '..', '.remotion-bundle');

// ── bundle cache ───────────────────────────────────────────────────────────

let bundlePromise = null;

function getServeUrl() {
  if (!bundlePromise) {
    // Fast path: use the deploy-time bundle if it exists. Detected by the
    // presence of index.html at the root — webpack writes it last, so a
    // partial bundle from a killed prebuild step is not misread as complete.
    if (fs.existsSync(path.join(PREBUILT_BUNDLE_DIR, 'index.html'))) {
      console.log(`🎬 remotion: using pre-built bundle at ${PREBUILT_BUNDLE_DIR}`);
      bundlePromise = Promise.resolve(PREBUILT_BUNDLE_DIR);
      return bundlePromise;
    }
    // Slow path: on-the-fly bundle (dev, tests, older images). Unchanged.
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
  // What used to be here was a glob of `<repo>/.cache/puppeteer/chrome-headless-shell`,
  // justified by a comment claiming a `.puppeteerrc.cjs` in THIS repo pinned
  // the puppeteer cache there. CORRECTION (2026-08-26): `.puppeteerrc.cjs`
  // has never existed anywhere in this repo's git history (`git log --all --
  // .puppeteerrc.cjs` is empty) — that file, and the commit hash the old
  // comment cited, belong to a similarly-named concern in the SIBLING
  // liquidretail_backend repo (see that repo's scripts/ensurePuppeteerChrome.js),
  // not here. Whatever the original intent, the candidate could never match
  // in THIS repo: `.cache/puppeteer` does not exist at all on the live box,
  // and `node_modules/.puppeteer-cache` (this repo's actual puppeteer
  // postinstall target) holds puppeteer's full `chrome` binary, not a
  // headless shell — not a candidate for Remotion either way. So every fresh
  // instance fell through to ensureBrowser() below and downloaded ~92MB of
  // headless shell on its FIRST render, on a user-visible request — and,
  // worse, N children doing that close together raced @remotion/renderer's
  // own install/reinstall logic on ONE shared path (see
  // scripts/ensureRemotionBrowser.js's header for the full incident trace).
  //
  // The fix is NOT a replacement glob. Remotion's cache nests three levels
  // deep and platform-specifically — verified against @remotion/renderer
  // 4.0.495's own source (BrowserFetcher.ts), not assumed:
  // `node_modules/.remotion/chrome-headless-shell/<platform>/chrome-headless-shell-<platform>/chrome-headless-shell`.
  // Hand-rolling that path here would be brittle for no benefit. The actual
  // fix is scripts/ensureRemotionBrowser.js, which pre-warms that cache at
  // Docker BUILD time and the Dockerfile then bakes REMOTION_BROWSER_EXECUTABLE
  // pointing straight at the verified binary — so in production this
  // function returns at the very first line, above, and everything below
  // this comment (including ensureBrowser() in ensureBrowserReady()) is
  // unreached. It stays here as the correct fallback for local/dev runs and
  // as defense-in-depth (see withInstallLock, below) if that env var is ever
  // missing. Keep the Playwright candidate above: that one is a genuinely
  // external browser this code could not otherwise discover.
  return firstExisting(candidates.filter(Boolean));
}

// ── cross-process install lock (defense-in-depth, NOT the primary fix) ─────
// The primary fix is baking the browser at Docker build time and setting
// REMOTION_BROWSER_EXECUTABLE (scripts/ensureRemotionBrowser.js + Dockerfile)
// — with that in place resolveBrowserExecutable() returns non-null on its
// FIRST check, above, and the ensureBrowser() branch below is unreachable in
// production. This lock exists only for the case where that env var is ever
// unset at runtime (a local/dev run outside the Docker build, or a
// misconfigured deploy that dropped the ENV). In that fallback case, EVERY
// SIBLING CHILD PROCESS spawned close together would otherwise independently
// call @remotion/renderer's ensureBrowser() and race its
// download/verify/reinstall dance on the ONE SHARED on-disk cache directory
// — ensureBrowser()'s own serialization (`currentEnsureBrowserOperation` in
// its ensure-browser.ts) is a per-process Promise chain, so it protects
// nothing across processes. That race is exactly what produced adgen-titler's
// 2026-08-26 ETXTBSY/ENOENT/ENOTEMPTY "No browser found" incident — see
// scripts/ensureRemotionBrowser.js's header for the full trace against
// @remotion/renderer@4.0.495's actual source.
//
// fs.mkdirSync on a not-yet-existing path is atomic on POSIX filesystems (one
// caller wins EEXIST, the rest lose it) — a dependency-free mutex. A lock
// older than LOCK_STALE_MS is presumed abandoned (its holder crashed/was
// SIGKILLed, e.g. an OOM) and is busted rather than wedging every future
// render behind a corpse.
const REMOTION_INSTALL_LOCK_DIR = path.join(os.tmpdir(), 'remotion-browser-install.lock');
const LOCK_POLL_MS = 500;
const LOCK_STALE_MS = 120_000;   // generous vs. a real download+extract (~seconds); a lock older than this means its holder is dead
const LOCK_WAIT_DEADLINE_MS = 180_000; // give up waiting and proceed unlocked rather than hang a render forever

async function withInstallLock(fn) {
  const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(REMOTION_INSTALL_LOCK_DIR);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(REMOTION_INSTALL_LOCK_DIR).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmdirSync(REMOTION_INSTALL_LOCK_DIR);
          continue; // retry acquiring immediately — do not sleep after busting a stale lock
        }
      } catch {
        // stat/rmdir raced a concurrent release — harmless, just retry below.
      }
      if (Date.now() > deadline) {
        console.warn(`🎬 remotion: install lock wait exceeded ${LOCK_WAIT_DEADLINE_MS}ms — proceeding WITHOUT it (best effort; this is the pre-fix race, not a new risk)`);
        break; // acquired stays false — never release a lock we do not own
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try { fs.rmdirSync(REMOTION_INSTALL_LOCK_DIR); } catch { /* best effort */ }
    }
  }
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
      : withInstallLock(() => ensureBrowser()).then(() => {
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
// Chrome page plus an ffmpeg 1080p encode, now in a dedicated child process
// so an OOM kills the child rather than the parent (which may be holding
// ADGEN_MAX_INFLIGHT=32 claims). The documented failure mode is not a
// provider 429 — it is RSS exhaustion. Default is therefore deliberately
// modest and the ceiling is env-driven: raise REMOTION_QUEUE_CONCURRENCY
// only against an observed RSS number, one step at a time. The queue still
// lives in THIS process; isolation changes WHERE each slot runs, not HOW MANY.
//
// Fallback `|| 2` matches config/defaults.env's committed default (see that
// file's long derivation) — this branch only fires if dotenv somehow failed
// to load defaults.env at all, so it should be dead code in practice. It
// used to say `|| 4`, a THIRD number silently disagreeing with both the file
// default and any dashboard override; see config/defaults.env for why 4 is
// the exact concurrency that OOM-killed adgen-titler three times in 44h.
const QUEUE_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.REMOTION_QUEUE_CONCURRENCY, 10) || 2
);

// ── boot-time memory sanity check (loud, not fatal) ─────────────────────────
// Refusing to boot on a bad concurrency knob risks taking the whole titling
// pipeline down over a config typo — worse than the problem it prevents. So:
// warn loudly, at require time, if the configured concurrency's estimated
// peak RSS looks unsafe against this instance's memory budget. The measured
// per-slot figure (~1.97 GiB, corroborated independently on both renderer
// AND titler — see config/defaults.env's 2026-08-21 and 2026-08-26 sections)
// and the pro_plus instance size (8 GiB) are both env-overridable so this
// check can follow a real instance-size change without a code edit.
// AUTOSCALE_TRIGGER_PCT (60) matters because an autoscaled service (titler)
// that sits above the memory autoscale trigger doesn't just risk OOM on ITS
// OWN — it triggers Render to add MORE instances that each run into the same
// per-instance ceiling, which is the exact mechanism that turned one bad
// concurrency value into three separate OOM kills. A non-autoscaled service
// (renderer, currently) only needs to clear the hard OOM ceiling.
function checkRemotionMemoryBudget() {
  const perSlotMb = Number(process.env.REMOTION_MEASURED_MB_PER_SLOT || 2016); // ~1.97 GiB
  const instanceMb = Number(process.env.REMOTION_INSTANCE_MEMORY_MB || 8192);  // pro_plus 8 GiB
  const autoscaleTriggerPct = Number(process.env.REMOTION_AUTOSCALE_TRIGGER_PCT || 60);
  if (!(perSlotMb > 0) || !(instanceMb > 0)) return; // misconfigured override — don't crash on it, just skip the check

  const estimatedPeakMb = QUEUE_CONCURRENCY * perSlotMb;
  const pctOfInstance = (estimatedPeakMb / instanceMb) * 100;

  if (pctOfInstance >= 90) {
    console.error(
      `🚨 remotion: REMOTION_QUEUE_CONCURRENCY=${QUEUE_CONCURRENCY} × ~${perSlotMb}MB/slot ≈ ` +
      `${(estimatedPeakMb / 1024).toFixed(1)}GiB (${pctOfInstance.toFixed(0)}% of the ` +
      `${(instanceMb / 1024).toFixed(1)}GiB instance) — this is OOM territory (the exact ` +
      `math behind adgen-titler's three 2026-08-26 OOM kills at concurrency=4). Lower ` +
      `REMOTION_QUEUE_CONCURRENCY or raise the instance size before this ships real traffic.`
    );
  } else if (pctOfInstance >= autoscaleTriggerPct) {
    console.warn(
      `⚠️  remotion: REMOTION_QUEUE_CONCURRENCY=${QUEUE_CONCURRENCY} × ~${perSlotMb}MB/slot ≈ ` +
      `${(estimatedPeakMb / 1024).toFixed(1)}GiB (${pctOfInstance.toFixed(0)}% of the ` +
      `${(instanceMb / 1024).toFixed(1)}GiB instance) — at or above the ${autoscaleTriggerPct}% ` +
      `autoscale memory trigger. Safe on a service with autoscaling DISABLED (verify in the ` +
      `Render dashboard); on an AUTOSCALED service this can make Render pile on more instances ` +
      `that each hit the same per-instance ceiling instead of relieving it — see ` +
      `config/defaults.env's 2026-08-26 section for the incident this describes.`
    );
  }
}
checkRemotionMemoryBudget();

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

// ObjectId-shaped values (a mongoose.Types.ObjectId, or any bson ObjectId)
// must never cross the IPC boundary raw. bson >=6 (this repo's mongoose 8.x)
// stores the 12-byte id on an OWN, ENUMERABLE instance property literally
// named `buffer`, backed by a real Node Buffer on this platform (see
// node_byte_utils.js's toLocalBufferType — every branch returns Buffer.from
// or Buffer.alloc). assertNoBuffers walks Object.keys() before JSON.stringify
// ever runs, so it finds that property and throws
// "remotion child IPC forbids buffers (key=buffer); pass a path" — a real,
// reproduced crash (not a false positive), because bson 5.x (this repo's
// backend sibling, mongoose 7.x) hid the same bytes behind a Symbol key and
// never tripped this. `adId` already gets this right below (`String(ad._id)`
// at the call site); brandId/productId/campaignRunId did not when they were
// threaded through here (#43) — coerce them the same way, defensively, at
// this single choke point so no future caller can reintroduce a raw id.
function toPlainId(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : String(value);
}

function payloadForChild(args) {
  // Explicit allow-list. Brand is reduced to the one field
  // resolveTitlePlacementMode reads — a mongoose lean() doc must not cross
  // the IPC boundary whole (it can carry buffers / circular-ish trees).
  return {
    videoUrl: args.videoUrl,
    meta: stripHeavyMeta(args.meta),
    spec: args.spec,
    tokens: args.tokens,
    format: args.format,
    brandName: args.brandName || null,
    adId: toPlainId(args.adId),
    brandId: toPlainId(args.brandId),
    productId: toPlainId(args.productId),
    campaignRunId: toPlainId(args.campaignRunId),
    placementMode: args.placementMode || null,
    brand: args.brand
      ? { videoSettings: { titlePlacementMode: args.brand.videoSettings && args.brand.videoSettings.titlePlacementMode || null } }
      : null,
    faceKeepOut: args.faceKeepOut || null,
    platformFormat: args.platformFormat || null,
    safeZoneKey: args.safeZoneKey || null
  };
}

/**
 * In-process render body (no queue, no spawn). The child process calls this
 * via renderTitles once REMOTION_IN_CHILD=1. The parent never runs it for
 * production titles — only renderPreview stays in-process.
 */
async function renderTitlesJob({ videoUrl, meta, spec, tokens, format, brandName = null, adId = null, brandId = null, productId = null, campaignRunId = null, placementMode = null, brand = null, faceKeepOut = null, platformFormat = null, safeZoneKey = null }) {
    const compositionId = COMPOSITION_BY_FORMAT[format];
    if (!compositionId) throw new Error(`renderTitles: unknown format '${format}'`);
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
          plateHints = await analyzePlate(platePath, { durationSec: probe.durationSec, brandId, productId, adId, campaignRunId, safeZoneKey });
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
        // Drop the ffmpeg prestitcher's extra RSS. Chrome already serializes
        // frames (REMOTION_CONCURRENCY pinned to 1); parallel encode is the
        // second memory spike on the same 8 GiB box.
        disallowParallelEncoding: true,
        // Opt-in memory levers (2026-08-26 reliability pass), both undefined
        // — Remotion's own default — unless explicitly set, so this is a
        // zero-behavior-change no-op until the orchestrator chooses to tune
        // it. offthreadVideoCacheSizeInBytes caps how much decoded base-plate
        // frame data OffthreadVideo (BasePlate.jsx's video layer — the one
        // real per-frame video-decode consumer in this composition) keeps
        // resident; lower = less RSS, more re-decode CPU. NOT changed by
        // default because there is no production RSS breakdown isolating
        // OffthreadVideo's own share of the measured ~1.97 GiB/slot from
        // Chrome's baseline — tune against a real measurement, same rule as
        // REMOTION_QUEUE_CONCURRENCY (see config/defaults.env), not a guess.
        offthreadVideoCacheSizeInBytes: process.env.REMOTION_OFFTHREAD_VIDEO_CACHE_BYTES
          ? Number(process.env.REMOTION_OFFTHREAD_VIDEO_CACHE_BYTES) : undefined,
        offthreadVideoThreads: process.env.REMOTION_OFFTHREAD_VIDEO_THREADS
          ? Number(process.env.REMOTION_OFFTHREAD_VIDEO_THREADS) : undefined,
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
}

/**
 * Render titles over the ad's base video. Mirrors renderBrandScript's
 * contract: returns { finalPath, tempDir, timings } — the caller uploads
 * finalPath and removes tempDir.
 *
 * Parent: enqueue() then spawn remotionRender.child.js (queue semantics
 * unchanged). Child (REMOTION_IN_CHILD=1): run the job in-process and exit.
 */
async function renderTitles(args) {
  if (!args || !args.videoUrl) throw new Error('renderTitles: videoUrl required');
  if (!args.spec) throw new Error('renderTitles: spec required');
  const compositionId = COMPOSITION_BY_FORMAT[args.format];
  if (!compositionId) throw new Error(`renderTitles: unknown format '${args.format}'`);

  if (process.env.REMOTION_IN_CHILD === '1') {
    return renderTitlesJob(args);
  }
  return enqueue(() => superviseRemotionChild({
    runnerPath: CHILD_PATH,
    payload: payloadForChild(args),
    timeoutMs: CHILD_TIMEOUT_MS
  }));
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
  renderTitlesJob,
  renderPreview,
  COMPOSITION_BY_FORMAT,
  // test surface for scripts/verifyFontServing.js (pure helpers)
  assetPathFor,
  fontRouteForLocalPath,
  fontsToUrls,
  payloadForChild,
  CHILD_PATH,
  RENDER_TIMEOUT_MS,
  CHILD_TIMEOUT_MS,
  // Pool internals — exported so scripts/verifyTitlingQueueParallel.js can
  // prove the pool actually overlaps work instead of regexing for the word
  // "concurrency". A serial queue and a parallel one look identical in source.
  enqueue,
  renderQueueStats,
  // Browser resolution/lock internals — exported for
  // scripts/verifyRemotionBrowserPrewarm.js, which drives resolveBrowserExecutable
  // and withInstallLock directly (execution, not just regex on source text).
  resolveBrowserExecutable,
  withInstallLock,
  REMOTION_INSTALL_LOCK_DIR,
};
