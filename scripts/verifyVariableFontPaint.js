#!/usr/bin/env node
'use strict';
/**
 * verifyVariableFontPaint — Chromium paint proof that Pelagic ArchivoV
 * instantiates wght=700 (not faux-bold off the file's default instance of 600).
 *
 * Companion to verifyVariableFontAxis.js C4, which proves the JS gate
 * (Number.isFinite(weightMin/Max) → effectiveWeight 700). C4 never constructs
 * FontFace and never opens a browser. This script does.
 *
 * Loads the public Pelagic Archivo-Variable woff2 (the same file ingest
 * mirrors; origin CDN, zero-cost re-fetch, no re-ingest) via FontFace at
 * descriptor '700' and separately at '400', paints "PELAGIC" at each, and
 * asserts the 700 render is BOLDER: greater ink coverage AND greater (or
 * equal) advance width. "Different" alone is not enough — faux-smoothing
 * can also produce a delta.
 *
 * If this fails, Pelagic headlines are still faux-bold today regardless of
 * the FontFace range-descriptor fix, and that is the real P0.
 *
 *   node scripts/verifyVariableFontPaint.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const FONT_URL = 'https://pelagicgear.com/cdn/shop/t/590/assets/Archivo-Variable.woff2?v=89468337642350734871787592875';
const CACHE = path.join(os.tmpdir(), 'pelagic-archivo-variable.woff2');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  ✗ ${name}`); }
}

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} → ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('font download timed out')); });
  });
}

async function resolveChrome() {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch { /* no puppeteer */ }
  if (!puppeteer) {
    try { puppeteer = require('puppeteer-core'); } catch { /* none */ }
  }
  if (!puppeteer) return null;
  const guesses = [];
  try {
    if (typeof puppeteer.executablePath === 'function') guesses.push(puppeteer.executablePath());
  } catch { /* bundled chrome not installed */ }
  guesses.push(
    process.env.PUPPETEER_EXECUTABLE_PATH,
    path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(__dirname, '..', 'node_modules', '.remotion', 'chrome-headless-shell', 'mac-arm64', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
    '/Volumes/Sayulita/Projects/RS/liquidretail_backend/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  );
  for (const g of guesses) {
    if (g && fs.existsSync(g)) return { puppeteer, executablePath: g };
  }
  return null;
}

async function paintWithPuppeteer(buf, chrome) {
  const b64 = buf.toString('base64');
  const dataUrl = `data:font/woff2;base64,${b64}`;
  const browser = await chrome.puppeteer.launch({
    headless: true,
    executablePath: chrome.executablePath,
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 260, deviceScaleFactor: 1 });
    /* global FontFace, document */
    // The callback below is stringified by Puppeteer and executed inside the
    // headless Chrome page, not this Node process — FontFace/document are
    // real globals THERE, not here. ESLint's no-undef can't see across that
    // boundary, hence the directive above (narrowly scoped to this function).
    return await page.evaluate(async (dataUrl) => {
      async function render(cssWeight, family) {
        const face = new FontFace(family, `url(${JSON.stringify(dataUrl)})`, {
          weight: String(cssWeight),
          style: 'normal',
        });
        await face.load();
        document.fonts.add(face);
        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 240;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000000';
        ctx.font = `${cssWeight} 140px ${family}`;
        ctx.textBaseline = 'top';
        ctx.fillText('PELAGIC', 24, 32);
        const metrics = ctx.measureText('PELAGIC');
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let ink = 0;
        for (let i = 0; i < image.data.length; i += 4) {
          ink += (255 - image.data[i]) + (255 - image.data[i + 1]) + (255 - image.data[i + 2]);
        }
        return { width: metrics.width, ink };
      }
      const at400 = await render(400, 'ArchivoVPaint400');
      const at700 = await render(700, 'ArchivoVPaint700');
      return { at400, at700 };
    }, dataUrl);
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log('\nverifyVariableFontPaint — Chromium wght=700 vs 400 on Pelagic ArchivoV\n');
  console.log(`  font: ${FONT_URL}\n`);

  let buf;
  try {
    if (fs.existsSync(CACHE) && fs.statSync(CACHE).size > 20_000) {
      buf = fs.readFileSync(CACHE);
    } else {
      buf = await download(FONT_URL);
      fs.writeFileSync(CACHE, buf);
    }
  } catch (err) {
    check('P0 downloaded Pelagic Archivo-Variable woff2', () => {
      throw new Error(`could not fetch font: ${err.message}`);
    });
  }

  if (buf) {
    check('P0 woff2 magic and non-trivial size', () => {
      assert.ok(buf.length > 20_000, `file too small (${buf.length} bytes)`);
      const magic = buf.slice(0, 4).toString('ascii');
      assert.ok(magic === 'wOF2' || magic === 'wOFF' || magic === 'OTTO' || buf.readUInt32BE(0) === 0x00010000,
        `unrecognised font magic ${JSON.stringify(magic)}`);
    });
  }

  const chrome = await resolveChrome();
  check('P1 Chromium executable is available', () => {
    assert.ok(chrome && chrome.puppeteer, 'no Chromium (puppeteer chrome install was blocked in this worktree and no system Chrome found)');
  });

  if (buf && chrome && chrome.puppeteer) {
    let painted;
    try {
      painted = await paintWithPuppeteer(buf, chrome);
    } catch (err) {
      check('P2 FontFace load + canvas paint', () => {
        throw new Error(err.message);
      });
    }
    if (painted) {
      console.log(`  400: ink=${painted.at400.ink} width=${painted.at400.width.toFixed(2)}`);
      console.log(`  700: ink=${painted.at700.ink} width=${painted.at700.width.toFixed(2)}`);
      check('P2 700 ink coverage is greater than 400 (bold direction, not merely different)', () => {
        assert.ok(painted.at700.ink > painted.at400.ink,
          `700 ink ${painted.at700.ink} was not greater than 400 ink ${painted.at400.ink} — Chromium did not instantiate wght=700`);
        // Require a meaningful delta so a 1-bit raster jitter cannot pass.
        const ratio = painted.at700.ink / painted.at400.ink;
        assert.ok(ratio >= 1.08, `700/400 ink ratio ${ratio.toFixed(3)} < 1.08 — likely faux-bold of the default 600 instance, not a real axis`);
      });
      check('P3 700 advance width is greater than 400 (bold direction)', () => {
        assert.ok(painted.at700.width > painted.at400.width,
          `700 width ${painted.at700.width} was not greater than 400 width ${painted.at400.width}`);
      });
    }
  }

  console.log('');
  if (failures.length) {
    console.log(`❌ verifyVariableFontPaint: ${failures.length} of ${pass + failures.length} checks FAILED`);
    for (const f of failures) console.log(`  • ${f.name}\n     ${f.message}`);
    console.log('\n  If P2/P3 failed: Pelagic headlines are still faux-bold today');
    console.log('  regardless of the FontFace range-descriptor fix. That is the real P0.');
    process.exit(1);
  }
  console.log(`✅ verifyVariableFontPaint: ${pass}/${pass} checks passed`);
  console.log('  Chromium instantiated wght=700 vs wght=400 in the bold direction.');
})().catch((err) => {
  console.error('verifyVariableFontPaint crashed:', err);
  process.exit(1);
});
