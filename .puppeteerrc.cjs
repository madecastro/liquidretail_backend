// Pin Puppeteer's browser cache inside node_modules/ so Chrome ships
// with the build artifact.
//
// Prior version pointed at `<project>/.cache/puppeteer`. That works
// on machines where the entire project tree is transported build →
// runtime intact, but Render (native runtime, not Docker) has been
// observed to lose `.cache/` between the build container and the
// serve container — puppeteer.launch() then errors:
//
//   Could not find Chrome (ver. X.Y.Z). This can occur if either
//   1. you did not perform an installation before running the script …
//   2. your cache path is incorrectly configured (which is: /opt/render/
//      project/src/.cache/puppeteer).
//
// node_modules/ ALWAYS ships with the deploy artifact — it's what
// makes the Node app runnable on the serve container. Pointing the
// puppeteer cache into that tree guarantees Chrome travels with it.
//
// Both the install CLI (scripts/ensurePuppeteerChrome.js) and the
// runtime launcher honour this file.

const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, 'node_modules', '.puppeteer-cache')
};
