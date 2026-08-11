#!/usr/bin/env node
//
// verifyScrapeSession — offline harness for the browser-session rung:
//   services/scrapeSession.js
//   services/headlessBrowserClient.js (Sec-CH-UA derivation)
//   services/httpScrapeClient.js (session pin / flag-off)
//   services/headlessScrapeService.js (page.cookies harvest — source shape)
//
// Pure + offline: no DB, no network, no Puppeteer launch, no API key.
//   node scripts/verifyScrapeSession.js
//
// Revert-prove:
//   (i)  swap page.cookies for document.cookie in harvest → trap checks FAIL
//   (ii) remove UA-pinning branch in httpScrapeClient → that check FAIL

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const scrapeSession = require('../services/scrapeSession');
const {
  ScrapeSession,
  originKey,
  getSession,
  putSession,
  clearSession,
  hasClearanceCookies,
  sessionReuseEnabled,
  DEFAULT_TTL_MS
} = scrapeSession;

const {
  chromeMajorFromUa,
  clientHintHeaders,
  DESKTOP_UA
} = require('../services/headlessBrowserClient');

const httpScrape = require('../services/httpScrapeClient');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    fail += 1;
    const msg = err && err.message ? err.message : String(err);
    console.log(`❌ ${label}: ${msg}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    fail += 1;
    const msg = err && err.message ? err.message : String(err);
    console.log(`❌ ${label}: ${msg}`);
  }
}

// ── fixtures ───────────────────────────────────────────────────────

const CLEARANCE_COOKIE =
  'cf_clearance=abc123.def; __cf_bm=botmgmt; session_id=plain';
const DOC_COOKIE_TRAP =
  // Measured shape: many names, neither HttpOnly clearance cookie.
  'locale=en; cart=xyz; _ga=GA1.1; _fbp=fb.1; _gcl_au=1.1; ' +
  'shopify_y=abc; shopify_s=def; secure_customer_sig=ghi; ' +
  'keep_alive=yes; localization=US; cart_currency=USD';
const PINNED_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── A. origin keying (per-HOST, not eTLD+1) ────────────────────────

check('A1 originKey strips path/query', () => {
  assert.equal(originKey('https://www.fanatics.com/sitemap.xml'), 'https://www.fanatics.com');
});
check('A2 www.fanatics.com !== portal.fanatics.com (measured fanatics case)', () => {
  const a = originKey('https://www.fanatics.com/');
  const b = originKey('https://portal.fanatics.com/products/1');
  assert.equal(a, 'https://www.fanatics.com');
  assert.equal(b, 'https://portal.fanatics.com');
  assert.notEqual(a, b);
});
check('A3 no eTLD+1 widening — subdomains stay distinct', () => {
  assert.notEqual(
    originKey('https://a.example.com'),
    originKey('https://b.example.com')
  );
});
check('A4 port is part of the key', () => {
  assert.notEqual(
    originKey('https://shop.example.com'),
    originKey('https://shop.example.com:8443')
  );
});

// ── B. clearance cookie gate (document.cookie trap) ────────────────

check('B1 hasClearanceCookies true for cf_clearance', () => {
  assert.equal(hasClearanceCookies('cf_clearance=x; other=y'), true);
});
check('B2 hasClearanceCookies true for __cf_bm alone', () => {
  assert.equal(hasClearanceCookies('__cf_bm=z'), true);
});
check('B3 document.cookie trap harvest is NOT usable', () => {
  assert.equal(hasClearanceCookies(DOC_COOKIE_TRAP), false);
});
check('B4 putSession rejects harvest missing clearance cookies', () => {
  clearSession();
  const s = putSession({
    origin: 'https://ubeauty.com',
    cookieHeader: DOC_COOKIE_TRAP,
    userAgent: PINNED_UA,
    vendor: 'cloudflare'
  });
  assert.equal(s, null, 'must not cache document.cookie trap');
  assert.equal(getSession('https://ubeauty.com'), null);
});
check('B5 putSession accepts real clearance harvest', () => {
  clearSession();
  const s = putSession({
    origin: 'https://ubeauty.com',
    cookieHeader: CLEARANCE_COOKIE,
    userAgent: PINNED_UA,
    vendor: 'cloudflare'
  });
  assert.ok(s);
  assert.equal(s.isValid(), true);
  assert.ok(getSession('https://ubeauty.com'));
});
check('B6 ScrapeSession.isValid false without clearance (CF vendor)', () => {
  const s = new ScrapeSession({
    origin: 'https://example.com',
    cookieHeader: DOC_COOKIE_TRAP,
    userAgent: PINNED_UA,
    vendor: 'cloudflare'
  });
  assert.equal(s.isValid(), false);
});
check('B7 ScrapeSession.isValid false with empty cookie', () => {
  const s = new ScrapeSession({
    origin: 'https://example.com',
    cookieHeader: '',
    userAgent: PINNED_UA,
    vendor: 'cloudflare'
  });
  assert.equal(s.isValid(), false);
});

// ── C. TTL with injectable clock ───────────────────────────────────

check('C1 TTL expiry with injected clock', () => {
  let now = 1_000_000;
  const s = new ScrapeSession({
    origin: 'https://ttl.example.com',
    cookieHeader: CLEARANCE_COOKIE,
    userAgent: PINNED_UA,
    capturedAt: now,
    now: () => now
  });
  assert.equal(s.isValid(), true);
  now += DEFAULT_TTL_MS - 1;
  assert.equal(s.isValid(), true, 'still valid just under TTL');
  now += 2;
  assert.equal(s.isValid(), false, 'expired past TTL');
});
check('C2 expired session is dropped from cache on get', () => {
  clearSession();
  let now = 5_000_000;
  const s = new ScrapeSession({
    origin: 'https://drop.example.com',
    cookieHeader: CLEARANCE_COOKIE,
    userAgent: PINNED_UA,
    capturedAt: now,
    now: () => now
  });
  // putSession builds its own session without custom clock — inject via cache
  // by constructing and storing manually through putSession then mutate.
  const put = putSession({
    origin: 'https://drop.example.com',
    cookieHeader: CLEARANCE_COOKIE,
    userAgent: PINNED_UA,
    capturedAt: Date.now() - DEFAULT_TTL_MS - 1000
  });
  // putSession rejects if already invalid at put time
  assert.equal(put, null);
  assert.equal(getSession('https://drop.example.com'), null);
  void s;
});

// ── D. refreshInFlight de-dupe + refreshCount cap ──────────────────

async function runRefreshTests() {
  await checkAsync('D1 refreshInFlight de-dupes N concurrent refreshes into ONE call', async () => {
    clearSession();
    let calls = 0;
    const s = new ScrapeSession({
      origin: 'https://dedupe.example.com',
      cookieHeader: CLEARANCE_COOKIE,
      userAgent: PINNED_UA
    });
    const harvestFn = async () => {
      calls += 1;
      await new Promise(r => setTimeout(r, 40));
      return {
        cookieHeader: 'cf_clearance=refreshed; __cf_bm=new',
        userAgent: PINNED_UA,
        vendor: 'cloudflare'
      };
    };
    const results = await Promise.all([
      s.refresh(harvestFn),
      s.refresh(harvestFn),
      s.refresh(harvestFn),
      s.refresh(harvestFn)
    ]);
    assert.equal(calls, 1, `expected 1 harvest call, got ${calls}`);
    assert.ok(results.every(Boolean), 'all waiters get true');
    assert.equal(s.refreshCount, 1);
    assert.ok(s.cookieHeader.includes('cf_clearance=refreshed'));
  });

  await checkAsync('D2 refreshCount cap stops runaway relaunches', async () => {
    const s = new ScrapeSession({
      origin: 'https://cap.example.com',
      cookieHeader: CLEARANCE_COOKIE,
      userAgent: PINNED_UA
    });
    // Force max refresh already used
    const max = scrapeSession.sessionMaxRefresh();
    s.refreshCount = max;
    let calls = 0;
    const ok = await s.refresh(async () => {
      calls += 1;
      return { cookieHeader: CLEARANCE_COOKIE, userAgent: PINNED_UA };
    });
    assert.equal(ok, false);
    assert.equal(calls, 0, 'must not call harvest when cap hit');
  });

  await checkAsync('D3 failed harvest (trap cookies) does not bump refreshCount', async () => {
    const s = new ScrapeSession({
      origin: 'https://fail.example.com',
      cookieHeader: CLEARANCE_COOKIE,
      userAgent: PINNED_UA
    });
    const before = s.refreshCount;
    const ok = await s.refresh(async () => ({
      cookieHeader: DOC_COOKIE_TRAP,
      userAgent: PINNED_UA
    }));
    assert.equal(ok, false);
    assert.equal(s.refreshCount, before);
    // original clearance still present
    assert.ok(hasClearanceCookies(s.cookieHeader));
  });
}

// ── E. per-host cache isolation ────────────────────────────────────

check('E1 separate sessions for www vs portal fanatics', () => {
  clearSession();
  const a = putSession({
    origin: 'https://www.fanatics.com',
    cookieHeader: 'cf_clearance=www; __cf_bm=1',
    userAgent: PINNED_UA
  });
  const b = putSession({
    origin: 'https://portal.fanatics.com',
    cookieHeader: 'cf_clearance=portal; __cf_bm=2',
    userAgent: PINNED_UA
  });
  assert.ok(a && b);
  assert.notEqual(a.cookieHeader, b.cookieHeader);
  assert.ok(a.cookieHeader.includes('cf_clearance=www'));
  assert.ok(b.cookieHeader.includes('cf_clearance=portal'));
  assert.equal(getSession('https://www.fanatics.com').cookieHeader, a.cookieHeader);
  assert.equal(getSession('https://portal.fanatics.com').cookieHeader, b.cookieHeader);
});

// ── F. harvest source shape: page.cookies, NOT document.cookie ─────

check('F1 headlessScrapeService harvest uses page.cookies(', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../services/headlessScrapeService.js'),
    'utf8'
  );
  // Isolate the harvestSession function body
  const m = src.match(/async function harvestSession\([\s\S]*?\n\}/);
  assert.ok(m, 'harvestSession function must exist');
  const body = m[0];
  assert.ok(
    /page\.cookies\s*\(/.test(body),
    'harvestSession must call page.cookies( — HttpOnly-safe CDP path'
  );
  // Strip comments before the document.cookie ban — the trap is
  // documented in comments on purpose; the ban is on executable code.
  const codeOnly = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !/document\.cookie/.test(codeOnly),
    'harvestSession must NOT use document.cookie (HttpOnly trap)'
  );
});
check('F2 headlessScrapeService source comments document the trap', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../services/headlessScrapeService.js'),
    'utf8'
  );
  assert.ok(/HttpOnly/i.test(src));
  assert.ok(/page\.cookies/.test(src));
});

// ── G. Sec-CH-UA major derived from UA ─────────────────────────────

check('G1 chromeMajorFromUa reads major from UA string', () => {
  assert.equal(chromeMajorFromUa(PINNED_UA), '131');
  assert.equal(chromeMajorFromUa('Chrome/120.0.0.0 Safari/537.36'), '120');
});
check('G2 clientHintHeaders Sec-CH-UA major matches UA (not independent hardcode)', () => {
  const ua120 =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const h131 = clientHintHeaders(PINNED_UA);
  const h120 = clientHintHeaders(ua120);
  assert.ok(h131['Sec-CH-UA'].includes('v="131"'), h131['Sec-CH-UA']);
  assert.ok(h120['Sec-CH-UA'].includes('v="120"'), h120['Sec-CH-UA']);
  assert.notEqual(h131['Sec-CH-UA'], h120['Sec-CH-UA']);
  // Same major as DESKTOP_UA export
  const fromDesktop = clientHintHeaders(DESKTOP_UA);
  assert.ok(fromDesktop['Sec-CH-UA'].includes(`v="${chromeMajorFromUa(DESKTOP_UA)}"`));
});
check('G3 Sec-CH-UA-Mobile and Platform present', () => {
  const h = clientHintHeaders(DESKTOP_UA);
  assert.equal(h['Sec-CH-UA-Mobile'], '?0');
  assert.ok(h['Sec-CH-UA-Platform']);
});

// ── H. httpScrapeClient session UA pin + flag-off ──────────────────

check('H1 httpScrapeClient source pins session.userAgent (suppresses pickUA)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../services/httpScrapeClient.js'),
    'utf8'
  );
  // Must have a branch that uses session.userAgent when session is valid
  assert.ok(
    /session\.userAgent/.test(src),
    'must assign User-Agent from session.userAgent'
  );
  // pickUA must not be the only path when session is supplied
  assert.ok(
    /useSession|sessionReuseEnabled|session\.isValid/.test(src),
    'must gate session application'
  );
});
check('H2 SCRAPE_SESSION_REUSE_ENABLED default is true', () => {
  const prev = process.env.SCRAPE_SESSION_REUSE_ENABLED;
  delete process.env.SCRAPE_SESSION_REUSE_ENABLED;
  try {
    assert.equal(httpScrape.sessionReuseEnabled(), true);
    assert.equal(sessionReuseEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.SCRAPE_SESSION_REUSE_ENABLED;
    else process.env.SCRAPE_SESSION_REUSE_ENABLED = prev;
  }
});
check('H3 flag-off SCRAPE_SESSION_REUSE_ENABLED=false → session never applied', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../services/httpScrapeClient.js'),
    'utf8'
  );
  // Behavioural: when flag is false, useSession is false even if session valid
  const prev = process.env.SCRAPE_SESSION_REUSE_ENABLED;
  process.env.SCRAPE_SESSION_REUSE_ENABLED = 'false';
  try {
    assert.equal(httpScrape.sessionReuseEnabled(), false);
    // Source must consult the flag before applying session headers
    assert.ok(/sessionReuseEnabled\s*\(/.test(src) || /SCRAPE_SESSION_REUSE_ENABLED/.test(src));
  } finally {
    if (prev === undefined) delete process.env.SCRAPE_SESSION_REUSE_ENABLED;
    else process.env.SCRAPE_SESSION_REUSE_ENABLED = prev;
  }
});
check('H4 toHeaders returns Cookie + Accept-Language only (UA set by client)', () => {
  const s = new ScrapeSession({
    origin: 'https://example.com',
    cookieHeader: CLEARANCE_COOKIE,
    userAgent: PINNED_UA,
    acceptLanguage: 'en-GB,en;q=0.8'
  });
  const h = s.toHeaders();
  assert.equal(h.Cookie, CLEARANCE_COOKIE);
  assert.equal(h['Accept-Language'], 'en-GB,en;q=0.8');
  assert.equal(h['User-Agent'], undefined, 'UA must be applied by httpScrapeClient, not toHeaders');
});

// ── I. headlessBrowserClient extraction surface ────────────────────

check('I1 headlessScrapeService re-exports getBrowser/closeBrowser from client', () => {
  const hs = require('../services/headlessScrapeService');
  const bc = require('../services/headlessBrowserClient');
  assert.equal(typeof hs.getBrowser, 'function');
  assert.equal(typeof hs.closeBrowser, 'function');
  assert.equal(hs.getBrowser, bc.getBrowser);
  assert.equal(hs.closeBrowser, bc.closeBrowser);
});
check('I2 headlessScrapeService exports harvestSession + renderKnownUrls', () => {
  const hs = require('../services/headlessScrapeService');
  assert.equal(typeof hs.harvestSession, 'function');
  assert.equal(typeof hs.renderKnownUrls, 'function');
  assert.equal(typeof hs.clearChallengeAndHarvest, 'function');
  assert.equal(typeof hs.fetchProductsJsonInPage, 'function');
});
check('I3 products.json pagination constants present', () => {
  const hs = require('../services/headlessScrapeService');
  assert.equal(hs.PRODUCTS_JSON_PAGE, 250);
  assert.ok(hs.PRODUCTS_JSON_MAX_PAGES >= 2);
});
check('I4 stealth / font policy present in headlessBrowserClient source', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../services/headlessBrowserClient.js'),
    'utf8'
  );
  assert.ok(/webdriver/.test(src));
  assert.ok(/evaluateOnNewDocument/.test(src));
  // fonts must NOT be aborted (challenge needs them)
  assert.ok(
    !/t === 'font'|t === "font"|=== 'font'/.test(src) ||
      /DO NOT abort|never abort fonts|Always allow fonts/i.test(src),
    'must not abort fonts the way the old image/media/font triple did'
  );
  // image/media still blocked
  assert.ok(/image/.test(src) && /media/.test(src));
});

// ── J. genericCatalogResolver stats keys + gate ────────────────────

check('J1 genericCatalogResolver references browser stats + tryBrowserSessionRung', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../services/genericCatalogResolver.js'),
    'utf8'
  );
  assert.ok(/browserAttempted/.test(src));
  assert.ok(/sessionHarvested/.test(src));
  assert.ok(/sessionReused/.test(src));
  assert.ok(/browserProductCount/.test(src));
  assert.ok(/tryBrowserSessionRung/.test(src));
  assert.ok(/RENDER_GENERIC_ENABLED/.test(src));
  // source stamps stay on the enum
  assert.ok(/shopify-direct/.test(src));
  assert.ok(/sitemap-jsonld/.test(src));
});

// ── T. the browser rung must be BOUNDED IN TIME ───────────────────────
// MEASURED 2026-08-10: a wedged Chrome launch outlived a 300s total budget by
// more than 300s and the resolve never returned. The wall-clock budget is
// CHECKED BETWEEN steps and cannot interrupt an in-flight await, and the
// per-step timeouts (45s goto / 15s challenge wait) do not cover launch. The
// older headless path already had this protection via its own Promise.race;
// the new rung must not be the one place that can hang a request forever.
{
  const resolverSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'genericCatalogResolver.js'),
    'utf8'
  );
  const browserClientSrc = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'headlessBrowserClient.js'),
    'utf8'
  );

  check('T browser rung races a deadline (Promise.race in the wrapper)', () => {
    assert.ok(
      /BROWSER_RUNG_TIMEOUT_MS/.test(resolverSrc) && /Promise\.race\(/.test(resolverSrc),
      'genericCatalogResolver must race tryBrowserSessionRung against a timeout'
    );
  });
  check('T the rung deadline is clamped to the remaining budget', () => {
    assert.ok(
      /Math\.min\(\s*BROWSER_RUNG_TIMEOUT_MS\s*,\s*remaining\s*\)/.test(resolverSrc),
      'the rung must never be given more time than the run has left'
    );
  });
  check('T a rung timeout is recorded, not swallowed', () => {
    assert.ok(/browserTimedOut/.test(resolverSrc), 'stats.browserTimedOut must be set on timeout');
  });
  check('T puppeteer.launch is bounded', () => {
    assert.ok(
      /BROWSER_LAUNCH_TIMEOUT_MS/.test(browserClientSrc) && /Promise\.race\(/.test(browserClientSrc),
      'getBrowser must race puppeteer.launch against a timeout'
    );
  });
  check('T an orphaned late launch is closed, not leaked', () => {
    assert.ok(
      /b\.close\(\)/.test(browserClientSrc),
      'a launch that resolves after the race must close its browser'
    );
  });
}

// ── run async suite then tally ─────────────────────────────────────

(async () => {
  await runRefreshTests();

  const total = pass + fail;
  console.log('');
  console.log(`${pass}/${total} checks passed`);
  if (fail > 0) {
    console.log(`${fail} failed`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
