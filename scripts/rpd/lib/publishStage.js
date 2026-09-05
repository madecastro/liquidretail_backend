// scripts/rpd/lib/publishStage.js — the ONE definition of what a published
// gallery may contain, plus a staging copy for publishers that can only take a
// directory (the Netlify and wrangler CLIs have no per-file exclude).
//
// WHY THIS EXISTS: the exclusion started life inside the Netlify API module, so
// the CLI path happily published manifest.json — caught live, with the ledger
// (prompts, prediction ids, settled costs) served 200 from a public URL while a
// comment two files away claimed it was excluded. One definition, used by every
// path, is the only version of this that stays true.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The run's ledger. index.html does not reference it, so publishing it puts
// internals on a public URL for no benefit.
const EXCLUDE = new Set(['manifest.json']);

function shouldPublish(absPath) {
  return !EXCLUDE.has(path.basename(absPath));
}

// Copy runDir into a temp dir, dropping excluded files. Returns { dir, cleanup }.
// Callers MUST cleanup() in a finally.
function stageForPublish(runDir) {
  const root = path.resolve(runDir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpd-publish-'));
  let copied = 0;
  (function walk(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) { walk(src, dst); continue; }
      if (!shouldPublish(src)) continue;
      fs.copyFileSync(src, dst);
      copied++;
    }
  })(root, dir);
  if (!copied) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`rpd: nothing publishable in ${root}`);
  }
  return { dir, copied, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { EXCLUDE, shouldPublish, stageForPublish };
