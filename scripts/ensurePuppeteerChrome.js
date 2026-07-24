// Bulletproof Chrome install for Puppeteer.
//
// Render's build → deploy transition has bitten us: the `puppeteer
// browsers install chrome` step in postinstall would "succeed" (exit 0)
// but leave nothing in the cache dir puppeteer.launch() looks at,
// producing the runtime error:
//
//   Could not find Chrome (ver. 148.0.7778.97). This can occur if either
//   1. you did not perform an installation before running the script …
//   2. your cache path is incorrectly configured (which is: /opt/render/
//      project/src/.cache/puppeteer).
//
// This script:
//   1. Resolves the SAME cache dir .puppeteerrc.cjs points to (so
//      install-time and runtime-time never diverge, even if PWD wanders
//      during npm postinstall).
//   2. Sets PUPPETEER_CACHE_DIR explicitly so puppeteer honours it
//      regardless of whether .puppeteerrc.cjs was picked up.
//   3. Runs `puppeteer browsers install chrome` as a subprocess.
//   4. VERIFIES a chrome build directory exists after install; throws
//      (non-zero exit) if not — makes the build fail visibly instead
//      of shipping a broken image ad renderer.
//   5. Logs the resolved path + files list so Render build logs show
//      exactly what landed.

'use strict';

const path       = require('path');
const fs         = require('fs');
const { execSync, spawnSync } = require('child_process');

// Same resolution .puppeteerrc.cjs performs.
const CACHE_DIR = path.join(__dirname, '..', '.cache', 'puppeteer');

console.log(`[ensurePuppeteerChrome] target cache dir: ${CACHE_DIR}`);

// Pre-create so an install failure at least leaves a probe-able dir.
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Runtime env for the install subprocess. PUPPETEER_CACHE_DIR is
// puppeteer's highest-priority resolver, higher than the .puppeteerrc
// file. Belt-and-suspenders.
const env = { ...process.env, PUPPETEER_CACHE_DIR: CACHE_DIR };

// Use `npx puppeteer browsers install chrome` — works both when the
// puppeteer binary is on PATH and when it needs to be pulled from
// node_modules/.bin via npx's resolution.
const result = spawnSync('npx', ['puppeteer', 'browsers', 'install', 'chrome'], {
  stdio:  'inherit',
  env,
  shell:  true,           // Windows dev machines need this; Linux ignores it
});

if (result.error) {
  console.error(`[ensurePuppeteerChrome] spawn failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[ensurePuppeteerChrome] install exited ${result.status}`);
  process.exit(result.status || 1);
}

// Verify: at least one chrome/<platform-version>/ directory must exist.
const chromeDir = path.join(CACHE_DIR, 'chrome');
if (!fs.existsSync(chromeDir)) {
  console.error(`[ensurePuppeteerChrome] install exited 0 but ${chromeDir} does not exist — Render will fail at render time`);
  process.exit(1);
}

const builds = fs.readdirSync(chromeDir).filter((n) => !n.startsWith('.'));
if (builds.length === 0) {
  console.error(`[ensurePuppeteerChrome] ${chromeDir} is empty — install claimed success but produced no build directory`);
  process.exit(1);
}

console.log(`[ensurePuppeteerChrome] verified — ${builds.length} build(s) present:`);
for (const b of builds) {
  const buildPath = path.join(chromeDir, b);
  const files = fs.readdirSync(buildPath).slice(0, 5);
  console.log(`  ${b}/ (${files.join(', ')}${files.length === 5 ? ', …' : ''})`);
}

console.log('[ensurePuppeteerChrome] done');
