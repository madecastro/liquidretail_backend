// Best-effort headless-shell pre-warm for Remotion, at BUILD time.
//
// WHY THIS FILE EXISTS — the postinstall step it replaces could never work.
// package.json ran:
//
//     npx remotion browser ensure || true
//
// and `remotion`'s vendored package has NO `bin` field, while `@remotion/cli`
// (which owns the `remotion` executable) is not installed at all. So `npx` had
// no local binary to resolve and would either fail outright or reach out to the
// registry for a copy — and `|| true` swallowed whichever happened, silently.
// The symptom was a fresh instance downloading ~92MB of Chrome at its FIRST
// render instead of at build time, paying that latency on a user-visible render.
//
// Confirmed on the live box before writing this: `.cache/puppeteer` does not
// exist, `node_modules/.puppeteer-cache` holds only puppeteer's full `chrome`
// (not a headless shell), and the shell Remotion actually uses had been
// downloaded at runtime to `node_modules/.remotion/chrome-headless-shell`.
//
// The fix is to call the API directly. `@remotion/renderer` IS installed and
// exports `ensureBrowser()` — the same function the render path falls back to
// (see remotionRenderService's ensureBrowserReady). Calling it here means the
// download lands in the build artifact instead of on the first request.
//
// SOFT-FAIL, deliberately, matching scripts/ensurePuppeteerChrome.js: this
// always exits 0. A failed pre-warm costs latency on the first render, which the
// runtime fallback still recovers from; a hard exit would brick the whole deploy
// over a transient network blip. But it prints a LOUD warning rather than the
// silent `|| true` that hid this for as long as it did.

'use strict';

(async () => {
  const t0 = Date.now();
  try {
    const { ensureBrowser } = require('@remotion/renderer');
    if (typeof ensureBrowser !== 'function') {
      console.warn(
        '⚠️  remotion pre-warm: @remotion/renderer does not export ensureBrowser() — ' +
        'skipping. The first render will download the headless shell instead.'
      );
      process.exit(0);
    }
    console.log('🌐 remotion pre-warm: ensuring the headless shell is present…');
    await ensureBrowser();
    console.log(`✅ remotion pre-warm: headless shell ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    // Loud, but non-fatal. If this is failing on every build, the first render
    // of every fresh instance is paying a ~92MB download — worth fixing, not
    // worth blocking a deploy over.
    console.warn(
      `⚠️  remotion pre-warm FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err && err.message}. ` +
      'Deploy continues; the first render will download the headless shell at runtime.'
    );
  }
  process.exit(0);
})();
