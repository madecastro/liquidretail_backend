// Best-effort Chrome install for Puppeteer.
//
// Render's build → deploy transition has bitten us: the `puppeteer
// browsers install chrome` step in postinstall would "succeed" (exit 0)
// but leave nothing at puppeteer.launch()'s resolved cache dir, producing
// the runtime error:
//
//   Could not find Chrome (ver. 148.0.7778.97). This can occur if either
//   1. you did not perform an installation before running the script …
//   2. your cache path is incorrectly configured (which is: /opt/render/
//      project/src/.cache/puppeteer).
//
// What this script does:
//   1. Resolves the SAME cache dir .puppeteerrc.cjs points to (from
//      __dirname — no reliance on npm's cwd during postinstall).
//   2. Sets PUPPETEER_CACHE_DIR explicitly so puppeteer honours it
//      regardless of whether .puppeteerrc.cjs was picked up.
//   3. Runs `puppeteer browsers install chrome` as a subprocess.
//   4. Enumerates the resulting chrome/<build>/ subdirectories (ONLY
//      directories — puppeteer's install leaves the source .zip
//      alongside the extracted dir, and readdir-ing a .zip explodes
//      with ENOTDIR).
//   5. Logs everything to the build log.
//
// Soft-fail policy: this script ALWAYS exits 0 as long as it managed
// to run. A failed Chrome install prints a loud warning but doesn't
// abort the deploy — image ads will fail at render time (surfaced by
// the puppeteer probe in index.js on boot) but video ads and the
// rest of the backend still work. A hard-exit here previously
// bricked entire deploys on unrelated install glitches.

'use strict';

const path       = require('path');
const fs         = require('fs');
const { spawnSync } = require('child_process');

// Same resolution .puppeteerrc.cjs performs. Kept in sync manually —
// if the .puppeteerrc moves, update this too.
const CACHE_DIR = path.join(__dirname, '..', 'node_modules', '.puppeteer-cache');

console.log(`[ensurePuppeteerChrome] target cache dir: ${CACHE_DIR}`);

try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch (err) {
  console.warn(`[ensurePuppeteerChrome] mkdir failed: ${err.message} — proceeding anyway`);
}

// Runtime env for the install subprocess. PUPPETEER_CACHE_DIR is
// puppeteer's highest-priority resolver, higher than the .puppeteerrc
// file. Belt-and-suspenders.
const env = { ...process.env, PUPPETEER_CACHE_DIR: CACHE_DIR };

const install = spawnSync('npx', ['puppeteer', 'browsers', 'install', 'chrome'], {
  stdio:  'inherit',
  env,
  shell:  true,           // Windows dev machines need this; Linux ignores it
});

if (install.error) {
  console.warn(`[ensurePuppeteerChrome] install spawn failed: ${install.error.message}`);
} else if (install.status !== 0) {
  console.warn(`[ensurePuppeteerChrome] install exited ${install.status}`);
}

// Verify — count only DIRECTORIES under chrome/, ignoring stray files
// puppeteer's install leaves behind (e.g. the source .zip). A missing
// or empty chrome/ dir is a warning, not a build failure — the runtime
// probe in index.js will surface the same signal on boot.
const chromeDir = path.join(CACHE_DIR, 'chrome');
if (!fs.existsSync(chromeDir)) {
  console.warn(`[ensurePuppeteerChrome] no ${chromeDir} — image ads will fail at render time (video ads unaffected)`);
  process.exit(0);
}

const entries = fs.readdirSync(chromeDir, { withFileTypes: true });
const builds  = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
const strays  = entries.filter((e) => !e.isDirectory()).map((e) => e.name);

if (strays.length > 0) {
  console.log(`[ensurePuppeteerChrome] non-directory entries alongside builds (harmless, keeping): ${strays.join(', ')}`);
}

if (builds.length === 0) {
  console.warn(`[ensurePuppeteerChrome] ${chromeDir} has no build directories — image ads will fail at render time (video ads unaffected)`);
  process.exit(0);
}

console.log(`[ensurePuppeteerChrome] verified — ${builds.length} build directory(ies):`);
for (const b of builds) {
  const buildPath = path.join(chromeDir, b.name);
  try {
    const files = fs.readdirSync(buildPath).slice(0, 5);
    console.log(`  ${b.name}/ (${files.join(', ')}${files.length === 5 ? ', …' : ''})`);
  } catch (err) {
    // Non-fatal — an unreadable build dir doesn't invalidate the others.
    console.log(`  ${b.name}/ (readdir failed: ${err.message})`);
  }
}

console.log('[ensurePuppeteerChrome] done');
