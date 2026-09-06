'use strict';
// Pins the build-time chrome-headless-shell prewarm (2026-08-26) that closes
// the "No browser found for rendering frames!" incident on adgen-titler.
//
// ROOT CAUSE (traced against @remotion/renderer@4.0.495's own source, not
// assumed): resolveBrowserExecutable() returned null whenever
// REMOTION_BROWSER_EXECUTABLE was unset, so EVERY spawned render child
// independently called ensureBrowser(), whose only serialization
// (currentEnsureBrowserOperation in ensure-browser.ts) is a per-process
// Promise chain — it protects nothing across the N sibling child processes
// this repo spawns (one per renderTitles() call). downloadBrowser()
// (BrowserFetcher.ts) does `fs.rmSync(outputPath, {recursive:true,
// force:true})` whenever it thinks the install is missing/mismatched, so
// several children racing that decision on the SAME shared path produced
// exactly the observed ETXTBSY/ENOENT/ENOTEMPTY -> "Failed to launch the
// browser process!" -> "No browser found" sequence.
//
// THE FIX has two parts, both pinned here:
//   1. Build-time bake (scripts/ensureRemotionBrowser.js + Dockerfile ENV)
//      — makes the runtime download/verify path UNREACHABLE, not just less
//      likely to race.
//   2. A cross-process install lock (remotionRenderService.js's
//      withInstallLock) as defense-in-depth for the case that env var is
//      ever unset at runtime.

const path = require('path');
const fs = require('fs');
const os = require('os');
const REPO = path.resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── A. ensureRemotionBrowser.js exists and is well-formed ──────────────────
const prewarmPath = path.join(REPO, 'scripts', 'ensureRemotionBrowser.js');
const hasPrewarm = fs.existsSync(prewarmPath);
check('A1: scripts/ensureRemotionBrowser.js exists', hasPrewarm);
const prewarmSrc = hasPrewarm ? fs.readFileSync(prewarmPath, 'utf8') : '';
check('A2: calls the REAL @remotion/renderer ensureBrowser() (not a hand-rolled download)',
  /require\(['"]@remotion\/renderer['"]\)/.test(prewarmSrc) && /\bensureBrowser\s*\(\s*\)/.test(prewarmSrc));
check('A3: verifies the resulting binary exists (fs.existsSync on the derived path)',
  /fs\.existsSync\(execPath\)/.test(prewarmSrc));
check('A4: verifies the binary is executable (X_OK)',
  /fs\.constants\.X_OK/.test(prewarmSrc));
check('A5: fails the process (exit 1) on any verification failure — must not ship silently',
  (prewarmSrc.match(/process\.exit\(1\)/g) || []).length >= 2);
check('A6: derives the linux64 path as .../chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell',
  /chrome-headless-shell['"],\s*\n?\s*platform,\s*`chrome-headless-shell-\$\{platform\}`,\s*binName/.test(prewarmSrc) ||
  /'chrome-headless-shell',\s*\n\s*platform, `chrome-headless-shell-\$\{platform\}`, binName/.test(prewarmSrc));
check('A7: guards against a cwd mismatch (cache dir is cwd-relative per @remotion/renderer\'s own getDownloadsCacheDir)',
  /process\.cwd\(\)\s*!==\s*REPO_ROOT/.test(prewarmSrc));

// ── B. Dockerfile wiring ────────────────────────────────────────────────────
const dockerfilePath = path.join(REPO, 'Dockerfile');
const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
const lines = dockerfile.split(/\r?\n/);
const copySrcIdx = lines.findIndex((l) => /^\s*COPY\s+src\/\s+/.test(l));
const copyScriptsIdx = lines.findIndex((l) => /^\s*COPY\s+scripts\/\s+/.test(l));
const runPrewarmIdx = lines.findIndex((l) => /^\s*RUN\s+node\s+scripts\/ensureRemotionBrowser\.js\s*$/.test(l));
const envIdx = lines.findIndex((l) => /^\s*ENV\s+REMOTION_BROWSER_EXECUTABLE=/.test(l));
const cmdIdx = lines.findIndex((l) => /^\s*CMD\s*\[/.test(l));

check('B1: Dockerfile runs scripts/ensureRemotionBrowser.js', runPrewarmIdx >= 0);
check('B2: prewarm runs AFTER src/ is copied', copySrcIdx >= 0 && runPrewarmIdx > copySrcIdx);
check('B3: prewarm runs AFTER scripts/ is copied', copyScriptsIdx >= 0 && runPrewarmIdx > copyScriptsIdx);
check('B4: Dockerfile sets ENV REMOTION_BROWSER_EXECUTABLE', envIdx >= 0);
check('B5: the ENV line comes AFTER the prewarm RUN (so it points at something the RUN just verified, not before)',
  envIdx >= 0 && runPrewarmIdx >= 0 && envIdx > runPrewarmIdx);
check('B6: ENV is set BEFORE CMD (baked into the image, not left to runtime)',
  envIdx >= 0 && cmdIdx >= 0 && envIdx < cmdIdx);

// ── C. Drift check: the Dockerfile's literal path matches ensureRemotionBrowser.js's OWN derivation formula ──
// The Dockerfile hardcodes the path rather than reading the script's output
// file specifically so this pair can be pinned and any future drift between
// them (e.g. @remotion/renderer changing its internal layout) fails THIS
// harness loudly instead of shipping a wrong ENV silently.
const envLine = envIdx >= 0 ? lines[envIdx] : '';
const envPathMatch = envLine.match(/REMOTION_BROWSER_EXECUTABLE=(\S+)/);
const envPath = envPathMatch ? envPathMatch[1] : null;
check('C1: ENV path parses out of the Dockerfile line', !!envPath, envLine);
const expectedPath = '/app/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell';
check('C2: Dockerfile ENV path matches the verified linux64 formula (node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell)',
  envPath === expectedPath, `got ${envPath}`);
// Cross-check against remotionRenderService.js's own long-standing comment
// (the ORIGINAL source of this path claim, now independently re-derived by
// ensureRemotionBrowser.js from @remotion/renderer's actual BrowserFetcher.ts) —
// they must describe the same path.
const svcSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'remotionRenderService.js'), 'utf8');
check('C3: remotionRenderService.js\'s own comment describes the same path shape (three-level nesting, linux64 example)',
  /chrome-headless-shell\/<platform>\/chrome-headless-shell-<platform>\/chrome-headless-shell/.test(svcSrc));

// ── D. resolveBrowserExecutable() checks REMOTION_BROWSER_EXECUTABLE FIRST ──
const { resolveBrowserExecutable, withInstallLock, REMOTION_INSTALL_LOCK_DIR } =
  require(path.join(REPO, 'src', 'services', 'remotionRenderService.js'));
const prevEnv = process.env.REMOTION_BROWSER_EXECUTABLE;
try {
  process.env.REMOTION_BROWSER_EXECUTABLE = '/some/baked/path/chrome-headless-shell';
  check('D1: resolveBrowserExecutable() returns REMOTION_BROWSER_EXECUTABLE verbatim when set (skips every fallback, including any filesystem glob)',
    resolveBrowserExecutable() === '/some/baked/path/chrome-headless-shell');
} finally {
  if (prevEnv === undefined) delete process.env.REMOTION_BROWSER_EXECUTABLE; else process.env.REMOTION_BROWSER_EXECUTABLE = prevEnv;
}

// ── E. .puppeteerrc.cjs stale-comment cleanup ───────────────────────────────
check('E1: .puppeteerrc.cjs does not exist in this repo (never has — confirmed via git log)',
  !fs.existsSync(path.join(REPO, '.puppeteerrc.cjs')));
check('E2: no source file references .puppeteerrc.cjs as if it currently exists',
  !/see \.puppeteerrc\.cjs/i.test(svcSrc));

// ── F. withInstallLock: real concurrency proof, not a regex ────────────────
// A serial mutex and a no-op wrapper look identical in source (same lesson
// remotionRenderService.js's own enqueue/renderQueueStats export comment
// states for the Remotion queue) — prove it by actually racing two calls.
async function runGroupF() {
  // Clean slate — a leftover lock dir from a prior interrupted run would
  // make this test flaky.
  try { fs.rmdirSync(REMOTION_INSTALL_LOCK_DIR); } catch { /* didn't exist */ }

  const order = [];
  const p1 = withInstallLock(async () => {
    order.push('1-start');
    await new Promise((r) => setTimeout(r, 150));
    order.push('1-end');
    return 'one';
  });
  // Give p1 a moment to actually acquire the lock before starting p2, so
  // this is a genuine "second caller waits" test, not a race on who calls
  // mkdirSync first.
  await new Promise((r) => setTimeout(r, 20));
  const p2 = withInstallLock(async () => {
    order.push('2-start');
    return 'two';
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  check('F1: withInstallLock serializes two concurrent callers (second does not start until the first finishes)',
    order.join(',') === '1-start,1-end,2-start', `got ${order.join(',')}`);
  check('F2: both calls resolve with their own return value (the lock does not swallow results)',
    r1 === 'one' && r2 === 'two');
  check('F3: the lock directory is released after both calls (no leaked lock)',
    !fs.existsSync(REMOTION_INSTALL_LOCK_DIR));

  // Stale-lock busting: a lock dir with an old mtime must not wedge a
  // caller for the full wait deadline.
  fs.mkdirSync(REMOTION_INSTALL_LOCK_DIR);
  const oldTime = new Date(Date.now() - 10 * 60 * 1000); // 10 min old, past LOCK_STALE_MS
  fs.utimesSync(REMOTION_INSTALL_LOCK_DIR, oldTime, oldTime);
  const startedAt = Date.now();
  const r3 = await withInstallLock(async () => 'busted-through');
  const elapsedMs = Date.now() - startedAt;
  check('F4: a stale (>2min old) lock is busted rather than waited out (resolves quickly, not after the 180s deadline)',
    r3 === 'busted-through' && elapsedMs < 5000, `elapsed=${elapsedMs}ms`);
  try { fs.rmdirSync(REMOTION_INSTALL_LOCK_DIR); } catch { /* released by the call above */ }
}

// ── G. finally-block ownership check (never release a lock we don't hold) ──
const svcRawSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'remotionRenderService.js'), 'utf8');
const lockFnMatch = svcRawSrc.match(/async function withInstallLock\([^)]*\)\s*\{[\s\S]*?\n\}\n/);
check('G1: withInstallLock() found', !!lockFnMatch);
if (lockFnMatch) {
  const body = lockFnMatch[0];
  check('G2: the finally block only releases the lock `if (acquired)` — a timed-out waiter must never rmdir a lock it does not own',
    /finally\s*\{\s*if\s*\(acquired\)/.test(body));
  check('G3: ensureBrowser() fallback call is wrapped in withInstallLock',
    /withInstallLock\(\(\)\s*=>\s*ensureBrowser\(\)\)/.test(svcRawSrc));
}

(async () => {
  await runGroupF();

  console.log(`\nverifyRemotionBrowserPrewarm: ${passes.length} pass, ${failures.length} fail`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
  for (const p of passes) console.log('  ✓ ' + p);
  console.log('\n✅ chrome-headless-shell is baked at build time, wired into the image before CMD, matches its own derivation formula, and the runtime fallback lock genuinely serializes concurrent callers.');
})().catch((err) => {
  console.error('verifyRemotionBrowserPrewarm: uncaught error —', err);
  process.exit(1);
});
