'use strict';
// Pre-build the Remotion webpack bundle at Docker BUILD time so runtime
// children skip the 5-15s webpack step on every render.
//
// Runtime read path: remotionRenderService.getServeUrl() checks for
// <repo>/.remotion-bundle/index.html; when present it uses the pre-built
// directory verbatim and no longer calls @remotion/bundler.bundle() at all.
// When absent (dev, tests, older images), the on-the-fly bundle path stays
// active — this script is purely additive, no runtime dependency.
//
// Bundle output is deterministic given the source under src/remotion/, so
// Docker's layer cache invalidates it correctly when compositions change.

const path = require('path');
const fs = require('fs');
const { bundle } = require('@remotion/bundler');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'src', 'remotion', 'index.jsx');
const OUT_DIR = path.join(REPO_ROOT, '.remotion-bundle');

(async () => {
  if (!fs.existsSync(ENTRY)) {
    console.error(`entry point not found: ${ENTRY}`);
    process.exit(1);
  }
  const t0 = Date.now();
  const dir = await bundle({
    entryPoint: ENTRY,
    outDir: OUT_DIR,
    onProgress: () => {}
  });
  const elapsed = Date.now() - t0;
  const sizeBytes = fs.readdirSync(dir).reduce((acc, name) => {
    try { return acc + fs.statSync(path.join(dir, name)).size; } catch { return acc; }
  }, 0);
  console.log(`✓ remotion pre-bundle: ${elapsed}ms → ${dir} (${(sizeBytes / 1024 / 1024).toFixed(1)}MB)`);
})().catch((err) => {
  console.error(`✗ remotion pre-bundle failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
