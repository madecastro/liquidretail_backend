// Pin Puppeteer's browser cache to a project-relative path.
//
// Render's free tier wipes ~/.cache between build and runtime
// (which is where puppeteer defaults — /opt/render/.cache/puppeteer),
// but anything inside the project tree persists. Pointing
// cacheDirectory at server/.cache/puppeteer means the Chromium that
// `puppeteer browsers install chrome` downloads during the
// postinstall hook is still there when puppeteer.launch() looks for
// it at runtime.
//
// Both the install CLI and the runtime launcher honour this file.

const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer')
};
