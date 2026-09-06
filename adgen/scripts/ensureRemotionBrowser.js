'use strict';
// Pre-warm @remotion/renderer's chrome-headless-shell cache at Docker BUILD
// time, so every runtime render sees an already-complete, version-matched
// install and never calls @remotion/renderer's own download/verify path.
//
// WHY THIS EXISTS (incident 2026-08-26). resolveBrowserExecutable() in
// remotionRenderService.js returns null unless REMOTION_BROWSER_EXECUTABLE is
// set or a Playwright cache is present, and ensureBrowserReady() then falls
// through to @remotion/renderer's ensureBrowser(). That is called from
// renderTitlesJob() — which runs INSIDE EVERY SPAWNED CHILD PROCESS
// (remotionRender.child.js requires remotionRenderService and calls
// renderTitles() with REMOTION_IN_CHILD=1, which routes straight to
// renderTitlesJob(); see remotionRenderService.js:504-506). One child is
// spawned per renderTitles() call, so N children spawned close together each
// independently call ensureBrowser().
//
// ensureBrowser()'s only serialization is a module-level Promise chain
// (`currentEnsureBrowserOperation` in @remotion/renderer's ensure-browser.ts)
// — that's PER-PROCESS. A fresh child process gets a fresh, empty chain, so
// it does nothing to protect the ONE SHARED on-disk cache directory
// (node_modules/.remotion/chrome-headless-shell/...) that every child on the
// box reads and writes. Traced against the actual @remotion/renderer@4.0.495
// source (packages/renderer/src/browser/BrowserFetcher.ts, downloadBrowser()):
// when the install looks missing OR its VERSION file doesn't match the
// version this package expects, it does
//   fs.rmSync(outputPath, { recursive: true, force: true })
// then re-downloads and extracts into the same path. With several sibling
// children each independently deciding "not installed, reinstall" at close
// to the same moment, one child's rmSync/rename lands mid-read/mid-exec of a
// sibling — exactly the production symptom (adgen-titler logs, 2026-08-26):
//   ETXTBSY   "Text file busy" — execing a binary a sibling is mid-overwrite
//   ENOENT    stat() on a path a sibling just rm -rf'd out from under it
//   ENOTEMPTY rmdir() racing a sibling's own in-flight rmSync
//   -> "Failed to launch the browser process! ... Closed with 126 signal: null"
//   -> "No browser found for rendering frames!"
// (11 deferred + 9 terminal "titling FAILED after 3 attempt(s)" in one
// window). The binary was never actually absent in steady state — this is a
// concurrent reinstall race on a shared path, not a missing download.
//
// THE FIX: install once, correctly, at build time (this script) so the
// runtime install/verify/reinstall dance never fires at all. Concretely:
//  1. Call the REAL @remotion/renderer ensureBrowser() (not a hand-rolled
//     download) so the VERSION file this exact installed package writes is
//     guaranteed to match what getBrowserStatus() checks for at runtime.
//  2. Verify the resulting binary exists and is executable.
//  3. Fail the DOCKER BUILD loudly if anything about that doesn't hold —
//     silently shipping an image without a working browser is strictly worse
//     than a build that never completes.
// The Dockerfile then bakes REMOTION_BROWSER_EXECUTABLE as a real image ENV
// pointing straight at the verified path. resolveBrowserExecutable() checks
// that env var FIRST (remotionRenderService.js:96) and returns immediately —
// so with this wired, no child EVER calls ensureBrowser()/getBrowserStatus()/
// downloadBrowser() at runtime. Not "less likely to race" — unreachable.
//
// CACHE LOCATION — verified against @remotion/renderer@4.0.495's own source
// (get-download-destination.ts), not trusted from an old comment:
//   getDownloadsCacheDir() walks UP from process.cwd() to the nearest
//   ancestor directory containing package.json, then resolves
//   <that dir>/node_modules/.remotion (pnp/yarn variants aside — this repo
//   uses neither). That means the resolved path is CWD-RELATIVE, not fixed
//   relative to where @remotion/renderer itself is installed. Two facts make
//   it line up here:
//     - Docker WORKDIR is /app, where this repo's package.json lives, so
//       this script (invoked by the Dockerfile) resolves to /app/node_modules/.remotion.
//     - remotionChildSupervisor.js's spawn() call explicitly pins the child's
//       cwd to REPO_ROOT (`cwd: cwd || REPO_ROOT`), so every runtime child
//       resolves the SAME directory this script warms — not "probably", a
//       verified match on both sides.
//   For headless-shell/linux64 the resolved executable is
//     node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell
//   — confirmed by walking getDownloadsFolder -> getFolderPath ->
//   getExecutablePath in BrowserFetcher.ts line by line, and it matches the
//   path recorded live in adgen-titler's own crash logs byte-for-byte.
//
// SURVIVAL ACROSS RENDER'S BUILD -> SERVE TRANSITION. render.yaml's four
// services all set `dockerfilePath: ./Dockerfile` — real Docker deploys, not
// Render's native buildpack. This Dockerfile is single-stage (no
// `COPY --from=builder`), so every RUN layer — including this script's
// writes under node_modules/.remotion — is baked into the final image and is
// bit-for-bit present in every runtime container started from it. This is a
// DIFFERENT mechanism from Puppeteer's `.cache/puppeteer` (a $HOME-relative
// path outside node_modules, already known and documented not to survive) —
// deliberately verified separately rather than assumed to share that fate.

const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');

function resolvePlatform() {
  if (os.platform() !== 'linux') {
    return null; // this image is always linux; anything else is a dev-machine no-op
  }
  return os.arch() === 'arm64' ? 'linux-arm64' : 'linux64';
}

function expectedExecutablePath(platform) {
  // Mirrors BrowserFetcher.ts getExecutablePath() for chromeMode:'headless-shell'.
  const binName = platform === 'linux-arm64' ? 'headless_shell' : 'chrome-headless-shell';
  return path.join(
    REPO_ROOT, 'node_modules', '.remotion', 'chrome-headless-shell',
    platform, `chrome-headless-shell-${platform}`, binName
  );
}

async function main() {
  // Cache dir is cwd-relative (see header) — fail loudly instead of quietly
  // warming a directory nothing at runtime will ever look at.
  if (process.cwd() !== REPO_ROOT) {
    console.error(`ensureRemotionBrowser: must run with cwd=${REPO_ROOT} (got ${process.cwd()}) — the Docker RUN step must not override WORKDIR`);
    process.exit(1);
  }

  const platform = resolvePlatform();
  if (!platform) {
    console.log(`🎬 ensureRemotionBrowser: platform ${os.platform()}/${os.arch()} is not this image's target (linux) — skipping (dev-machine no-op)`);
    return;
  }
  if (platform === 'linux-arm64') {
    // Documented for completeness (see header's platform table) but this
    // Dockerfile builds on linux64 today. Loud, not fatal — Render infra may
    // add arm64 workers later, at which point this script should still work
    // (ensureBrowser() itself is platform-aware); the divergent binary name
    // just needs to be exercised for real before being trusted blind.
    console.warn('⚠️  ensureRemotionBrowser: linux-arm64 target — binary name differs (headless_shell). Not exercised in production; verify manually if this image ever targets arm64.');
  }

  console.log('🎬 ensureRemotionBrowser: pre-warming chrome-headless-shell at build time...');
  const { ensureBrowser } = require('@remotion/renderer');
  const t0 = Date.now();
  const status = await ensureBrowser();
  console.log(`🎬 ensureRemotionBrowser: ensureBrowser() -> ${JSON.stringify(status)} (${Date.now() - t0}ms)`);

  const execPath = expectedExecutablePath(platform);
  if (!fs.existsSync(execPath)) {
    console.error(`ensureRemotionBrowser: FAILED — expected binary not found at ${execPath} after ensureBrowser() returned ${JSON.stringify(status)}`);
    console.error('This means either the resolved cache path formula has drifted from @remotion/renderer\'s actual layout, or ensureBrowser() did not actually install anything — either way the build must not ship silently.');
    process.exit(1);
  }
  try {
    fs.accessSync(execPath, fs.constants.X_OK);
  } catch (err) {
    console.error(`ensureRemotionBrowser: FAILED — binary at ${execPath} is not executable (${err.message})`);
    process.exit(1);
  }
  console.log(`🎬 ensureRemotionBrowser: verified executable at ${execPath}`);

  // Written for humans/tooling that want the resolved path without
  // re-deriving it (the Dockerfile bakes it as a literal ENV instead of
  // reading this file, precisely so a drift between the two FAILS the build
  // rather than silently trusting whichever one is stale — see
  // scripts/verifyRemotionBrowserPrewarm.js Group C).
  const hintFile = path.join(REPO_ROOT, '.remotion-browser-path');
  fs.writeFileSync(hintFile, execPath + '\n');
  console.log(`🎬 ensureRemotionBrowser: wrote resolved path to ${hintFile}`);
}

main().catch((err) => {
  console.error(`ensureRemotionBrowser: FAILED — ${(err && err.stack) || err}`);
  process.exit(1);
});
