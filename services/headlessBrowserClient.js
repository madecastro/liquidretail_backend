// services/headlessBrowserClient.js
//
// Shared Puppeteer browser lifecycle for scrape/ingest paths that need a
// real Chrome (Cloudflare interstitials, JS storefronts, review capture).
//
// ONE singleton Chrome and ONE mutex for the whole process — a memory-
// constrained dyno cannot afford a second resident browser from a future
// rung. Extracted from headlessScrapeService so the generic catalog path
// and the Shopify SHOPIFY_HEADLESS_RENDER path share the same pool.
//
// Stealth is hand-rolled (no puppeteer-extra): node_modules is partly
// tracked and incomplete, so new deps are out of scope. Authorization
// context: target sites are production clients whose public catalogs we
// ingest with permission; a realistic fingerprint is in scope.
//
// NODE 18+, puppeteer ^24 already installed. No new deps.

'use strict';

const puppeteer = require('puppeteer');
const { classifyBlock } = require('./blockClassifier');

const LOG = '🕷';
const NAV_TIMEOUT = 45000;
// Hard ceiling on puppeteer.launch(). See the comment at the race in
// getBrowser() for why an unbounded launch is not survivable by the caller's
// wall-clock budget. Env-tunable so a slow cold dyno can be given more room.
const BROWSER_LAUNCH_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.HEADLESS_LAUNCH_TIMEOUT_MS, 10) || 60000
);

// Stable desktop Chrome UA — Cloudflare partly binds clearance to UA, so
// anything that harvests a session MUST replay this string verbatim on the
// cheap HTTP path (see scrapeSession + httpScrapeClient session pin).
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

// Headless-only interstitial phrase historically matched by CF_RE but
// not in the shared CF_BODY_RE — keep so detectCfChallenge stays at
// least as sensitive as before the extraction.
const CF_HEADLESS_EXTRA_RE = /checking your browser/i;

// ── Sec-CH-UA derived from the SAME Chrome major as the UA ─────────
// A mismatch between UA and client hints is itself a bot signal.
// Do NOT hardcode a major independent of DESKTOP_UA.

function chromeMajorFromUa(ua) {
  const m = String(ua || '').match(/Chrome\/(\d+)/i);
  return m ? m[1] : '131';
}

function clientHintHeaders(ua) {
  const major = chromeMajorFromUa(ua);
  // Match DESKTOP_UA platform (Windows). Mobile is never true for this UA.
  return {
    'Sec-CH-UA': `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="24"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"'
  };
}

function stealthEnabled() {
  // Default ON — flag-off restores bare Puppeteer fingerprint.
  return String(process.env.HEADLESS_STEALTH_ENABLED || 'true').toLowerCase() !== 'false';
}

// ── browser lifecycle (lazy singleton) ─────────────────────────────

let _browser = null;
let _browserLaunching = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  if (_browserLaunching) return _browserLaunching;

  _browserLaunching = (async () => {
    console.log(`   · ${LOG}  launching headless Chrome (bundled)`);
    // BOUNDED LAUNCH. puppeteer.launch() has no built-in timeout, and a wedged
    // launch cannot be rescued by the caller's wall-clock budget — that budget
    // is CHECKED BETWEEN steps and cannot interrupt an in-flight await. Measured
    // 2026-08-10: a launch that never resolved outlived a 300s total budget by
    // more than 300s. Real failure modes this covers on the dyno: a missing or
    // half-installed Chrome, OOM during spawn, or a profile/singleton-lock
    // collision. Fail fast and let the rung fall through honestly instead.
    const launch = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      // Puppeteer's own protocol/launch timeout — belt to the race's braces.
      timeout: BROWSER_LAUNCH_TIMEOUT_MS
    });
    let launchTimer = null;
    const browser = await Promise.race([
      launch,
      new Promise((_, reject) => {
        launchTimer = setTimeout(
          () => reject(new Error(`headless Chrome launch timed out after ${BROWSER_LAUNCH_TIMEOUT_MS}ms`)),
          BROWSER_LAUNCH_TIMEOUT_MS
        );
      })
    ]).finally(() => { if (launchTimer) clearTimeout(launchTimer); });
    // If the race rejected but the launch later succeeds, that browser would be
    // orphaned — close it rather than leaking a Chrome process on the dyno.
    launch.then(
      b => { if (b !== browser) { try { b.close(); } catch { /* best effort */ } } },
      () => { /* already surfaced */ }
    );
    _browser = browser;
    _browserLaunching = null;
    browser.on('disconnected', () => {
      if (_browser === browser) _browser = null;
    });
    return browser;
  })();

  try {
    return await _browserLaunching;
  } catch (err) {
    _browserLaunching = null;
    throw err;
  }
}

async function closeBrowser() {
  const b = _browser;
  _browser = null;
  _browserLaunching = null;
  if (!b) return;
  try {
    await b.close();
  } catch (err) {
    console.warn(`   ⚠️  ${LOG}  closeBrowser: ${err.message}`);
  }
}

// ── simple promise-chain mutex (serialize page work on small dynos) ─

let _mutexTail = Promise.resolve();

function withMutex(fn) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const prev = _mutexTail;
  _mutexTail = prev.then(() => gate, () => gate);
  return prev.then(fn, fn).finally(() => { release(); });
}

// ── stealth injection (hand-rolled, no puppeteer-extra) ────────────

function buildStealthInitScript() {
  // Runs in the page world before any document script.
  return () => {
    /* eslint-disable no-undef */
    try {
      // Puppeteer headless:'new' reports navigator.webdriver === true;
      // the real Chrome that clears CF on ubeauty reports false.
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => undefined,
        configurable: true
      });
    } catch { /* ignore */ }

    try {
      if (!window.chrome) {
        window.chrome = {
          runtime: {},
          loadTimes: function loadTimes() { return {}; },
          csi: function csi() { return {}; },
          app: { isInstalled: false }
        };
      }
    } catch { /* ignore */ }

    try {
      // Non-empty plugins / mimeTypes — headless defaults to [].
      const fakePlugin = {
        name: 'Chrome PDF Plugin',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        length: 1,
        0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
      };
      const pluginArray = [fakePlugin];
      pluginArray.item = (i) => pluginArray[i] || null;
      pluginArray.namedItem = (n) => (n === fakePlugin.name ? fakePlugin : null);
      pluginArray.refresh = () => {};
      Object.defineProperty(Navigator.prototype, 'plugins', {
        get: () => pluginArray,
        configurable: true
      });

      const mime = {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
        enabledPlugin: fakePlugin
      };
      const mimeArray = [mime];
      mimeArray.item = (i) => mimeArray[i] || null;
      mimeArray.namedItem = (n) => (n === mime.type ? mime : null);
      Object.defineProperty(Navigator.prototype, 'mimeTypes', {
        get: () => mimeArray,
        configurable: true
      });
    } catch { /* ignore */ }

    try {
      Object.defineProperty(Navigator.prototype, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true
      });
    } catch { /* ignore */ }

    try {
      // permissions.query for notifications must agree with Notification.permission
      // (a common CF/bot check: inconsistent resolution = automation).
      const original = navigator.permissions && navigator.permissions.query
        ? navigator.permissions.query.bind(navigator.permissions)
        : null;
      if (original) {
        navigator.permissions.query = (parameters) => {
          if (parameters && parameters.name === 'notifications') {
            const state =
              typeof Notification !== 'undefined' ? Notification.permission : 'default';
            return Promise.resolve({ state, onchange: null });
          }
          return original(parameters);
        };
      }
    } catch { /* ignore */ }
    /* eslint-enable no-undef */
  };
}

// ── page helpers ───────────────────────────────────────────────────

/**
 * setupPage(page, { blockFontsWhileChallenge }?)
 *
 * Sets UA, viewport, realistic headers (Sec-CH-UA derived from UA),
 * optional stealth init script, and request interception.
 *
 * Fonts: DO NOT abort while a CF challenge may still be pending — the
 * managed challenge loads webfonts and aborting them can stall clear.
 * Keep blocking image/media (where the bandwidth actually is).
 * After the challenge clears, callers may set page.__scrapeChallengePending
 * = false; fonts stay allowed either way (cheap vs. re-challenge risk).
 */
async function setupPage(page) {
  await page.setUserAgent(DESKTOP_UA);
  await page.setViewport({ width: 1366, height: 900 });

  const hints = clientHintHeaders(DESKTOP_UA);
  await page.setExtraHTTPHeaders({
    'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    ...hints
  });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  if (stealthEnabled()) {
    await page.evaluateOnNewDocument(buildStealthInitScript());
  }

  // Mark challenge pending until gotoWithCf clears it — request handler
  // never aborts fonts either way (see comment above).
  page.__scrapeChallengePending = true;

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    // Always allow fonts (challenge + storefront). Block image/media only.
    if (t === 'image' || t === 'media') {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}

async function detectCfChallenge(page) {
  try {
    const info = await page.evaluate(() => {
      const title = document.title || '';
      const body = document.body ? (document.body.innerText || '').slice(0, 2000) : '';
      return { title, body };
    });
    const blob = `${info.title}\n${info.body}`;
    // Boolean contract preserved: true when shared CF markers fire (via
    // classifier at status 403) OR the headless-only interstitial phrase.
    const block = classifyBlock({ status: 403, bodyText: blob });
    if (block && block.vendor === 'cloudflare') return true;
    return CF_HEADLESS_EXTRA_RE.test(blob);
  } catch {
    return false;
  }
}

/**
 * gotoWithCf(page, url, errors) → boolean
 * Navigate and wait once for a CF interstitial to clear. Returns false
 * if the challenge is still present after the wait.
 */
async function gotoWithCf(page, url, errors) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  } catch (err) {
    // tolerate navigation timeout — page may still be usable
    if (!/timeout/i.test(err.message)) {
      errors.push(`goto ${url}: ${err.message}`);
    }
  }

  if (await detectCfChallenge(page)) {
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 });
    } catch {
      // one wait only
    }
    if (await detectCfChallenge(page)) {
      errors.push(`CF challenge still present after wait: ${url}`);
      return false;
    }
  }
  try { page.__scrapeChallengePending = false; } catch { /* ignore */ }
  return true;
}

module.exports = {
  getBrowser,
  closeBrowser,
  withMutex,
  setupPage,
  gotoWithCf,
  detectCfChallenge,
  DESKTOP_UA,
  DEFAULT_ACCEPT_LANGUAGE,
  NAV_TIMEOUT,
  chromeMajorFromUa,
  clientHintHeaders,
  stealthEnabled,
  CF_HEADLESS_EXTRA_RE
};
