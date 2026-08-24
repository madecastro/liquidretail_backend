'use strict';
// Pins the pre-built Remotion bundle path.
//
// SHIPPED 2026-08-24. Prebuild lives in scripts/prebuildRemotionBundle.js
// and is invoked at Docker BUILD time by Dockerfile. Every renderer child
// then reads that bundle in ~1ms instead of paying the 30-60s webpack cost
// on cold start (measured 54.6s locally on the first prebuild). Fast path
// is env-free — the runtime detects the bundle by existence check on
// <repo>/.remotion-bundle/index.html.
//
// Load-bearing invariants proven here:
//  - the prebuild script exists and points at src/remotion/index.jsx
//  - Dockerfile invokes the prebuild AFTER `COPY src/`, so a stale
//    bundle can't ship
//  - remotionRenderService.getServeUrl() has a check on
//    <repo>/.remotion-bundle/index.html that returns that path
//  - the on-the-fly bundle() fallback is preserved (dev / older images)
//  - index.html is used as the detector, not the directory (partial
//    output from a killed prebuild can't be mistaken for a complete one)
//
// Revert-prove: back the fast-path lines out of remotionRenderService.js
// and the "using pre-built bundle" branch check below fails.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const failures = [];
const passes = [];

function check(name, cond, detail) {
  if (cond) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// A. Prebuild script exists and is well-formed.
const prebuildPath = path.join(REPO, 'scripts', 'prebuildRemotionBundle.js');
const hasPrebuild = fs.existsSync(prebuildPath);
check('A1 prebuild script exists', hasPrebuild, prebuildPath);
const prebuildSrc = hasPrebuild ? fs.readFileSync(prebuildPath, 'utf8') : '';
check('A2 prebuild calls @remotion/bundler.bundle', /require\(['"]@remotion\/bundler['"]\)/.test(prebuildSrc) && /\bbundle\s*\(/.test(prebuildSrc));
check('A3 prebuild targets src/remotion/index.jsx',
  /['"]src['"]\s*,\s*['"]remotion['"]\s*,\s*['"]index\.jsx['"]/.test(prebuildSrc) ||
  /src\/remotion\/index\.jsx/.test(prebuildSrc));
check('A4 prebuild writes to <repo>/.remotion-bundle',
  /['"]\.remotion-bundle['"]/.test(prebuildSrc) || /\.remotion-bundle/.test(prebuildSrc));
check('A5 prebuild fails process on error',
  /process\.exit\(1\)/.test(prebuildSrc));

// B. Dockerfile invokes the prebuild AFTER copying src.
const dockerfilePath = path.join(REPO, 'Dockerfile');
const dockerfile = fs.existsSync(dockerfilePath) ? fs.readFileSync(dockerfilePath, 'utf8') : '';
check('B1 Dockerfile exists', dockerfile.length > 0);
// Line-based: extract the ordered list of relevant instructions.
const lines = dockerfile.split(/\r?\n/);
const copySrcIdx = lines.findIndex((l) => /^\s*COPY\s+src\/\s+/.test(l));
const copyScriptsIdx = lines.findIndex((l) => /^\s*COPY\s+scripts\/\s+/.test(l));
const runPrebuildIdx = lines.findIndex((l) => /^\s*RUN\s+node\s+scripts\/prebuildRemotionBundle\.js\s*$/.test(l));
check('B2 Dockerfile copies src/', copySrcIdx >= 0);
check('B3 Dockerfile copies scripts/', copyScriptsIdx >= 0);
check('B4 Dockerfile runs prebuild', runPrebuildIdx >= 0);
check('B5 prebuild runs AFTER src/ copy', copySrcIdx >= 0 && runPrebuildIdx > copySrcIdx,
  `copySrcIdx=${copySrcIdx} runPrebuildIdx=${runPrebuildIdx}`);
check('B6 prebuild runs AFTER scripts/ copy', copyScriptsIdx >= 0 && runPrebuildIdx > copyScriptsIdx,
  `copyScriptsIdx=${copyScriptsIdx} runPrebuildIdx=${runPrebuildIdx}`);

// C. Runtime fast path is wired in remotionRenderService.
const svcPath = path.join(REPO, 'src', 'services', 'remotionRenderService.js');
const svc = fs.readFileSync(svcPath, 'utf8');
check('C1 declares PREBUILT_BUNDLE_DIR', /PREBUILT_BUNDLE_DIR\s*=\s*path\.join\(/.test(svc));
check('C2 PREBUILT_BUNDLE_DIR resolves to <repo>/.remotion-bundle',
  /PREBUILT_BUNDLE_DIR\s*=\s*path\.join\([^;]*['"]\.remotion-bundle['"]/.test(svc),
  'must derive from __dirname to survive relocation'
);
check('C3 fast path detects via index.html',
  /fs\.existsSync\(\s*path\.join\(\s*PREBUILT_BUNDLE_DIR\s*,\s*['"]index\.html['"]\s*\)\s*\)/.test(svc));
check('C4 fast path returns PREBUILT_BUNDLE_DIR',
  /bundlePromise\s*=\s*Promise\.resolve\(\s*PREBUILT_BUNDLE_DIR\s*\)/.test(svc));
// D. On-the-fly bundle() fallback is preserved.
check('D1 fallback still calls bundle()',
  /require\(['"]@remotion\/bundler['"]\)\s*;?\s*\n?\s*bundlePromise\s*=\s*bundle\(/m.test(svc) ||
  /const\s*\{\s*bundle\s*\}\s*=\s*require\(['"]@remotion\/bundler['"]\)/.test(svc));
check('D2 fallback still clears on error',
  /bundlePromise\s*=\s*null;\s*\/\/[^\n]*retry/i.test(svc));

// E. Ignore rules: build artifact never leaks into git.
const gi = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
check('E1 .gitignore ignores .remotion-bundle', /(^|\n)\.remotion-bundle\/?(\n|$)/.test(gi));

// ── report
console.log(`\nverifyRemotionPrebuild: ${passes.length} pass, ${failures.length} fail`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ all pre-bundle wiring in place');
