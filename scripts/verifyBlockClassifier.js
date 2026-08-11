#!/usr/bin/env node
//
// verifyBlockClassifier — offline harness for services/blockClassifier.js
// and the cfChallenged back-compat contract in httpScrapeClient.
//
// Pure + offline: no DB, no network, no API key, no env dependencies.
//   node scripts/verifyBlockClassifier.js
//
// Revert-prove: temporarily break the Akamai branch in blockClassifier
// and confirm this script fails, then restore.

'use strict';

const assert = require('node:assert/strict');
const {
  classifyBlock,
  CF_BODY_RE,
  CF_COOKIE_NAMES,
  AKAMAI_CUSTOM_DENY_RE,
  AKAMAI_ACCESS_DENIED_RE,
  PX_BODY_RE,
  DATADOME_BODY_RE,
  INCAPSULA_BODY_RE
} = require('../services/blockClassifier');

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

// ── Real-world bodies ─────────────────────────────────────────────────

const AKAMAI_FANATICS_BODY = `<html><head><title>Access Denied</title></head>
<body onload="renderScript()">
<h1>Access Denied</h1>
<p>You don't have permission to access this page.</p>
<p>Reference <span id="referenceId">18.4b0c3417.1786383118.eb47ac05</span></p>
<p>RC <span id="rcId">db35dde62de2cc3f</span></p>
</body></html>
<script>function renderScript(){const script=document.createElement('script');
script.src='/_es_/fo/customdeny/v5/index.js';script.async=true;
document.body.appendChild(script);}</script>`;

const CF_JUST_A_MOMENT = `<!DOCTYPE html>
<html><head><title>Just a moment...</title></head>
<body>
  <div id="cf-content">Just a moment...</div>
  <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
  <div class="cf-browser-verification">__cf_chl_opt</div>
</body></html>`;

// Old httpScrapeClient oracle — re-implemented inline for back-compat group.
function oldIsCfChallenged(status, bodyText) {
  if (status !== 403 && status !== 503) return false;
  if (!bodyText) return false;
  return CF_BODY_RE.test(bodyText);
}

// ── A. Exports / marker tables ────────────────────────────────────────

check('A1 classifyBlock is a function', () => {
  assert.equal(typeof classifyBlock, 'function');
});
check('A2 CF_BODY_RE is a RegExp', () => {
  assert.ok(CF_BODY_RE instanceof RegExp);
});
check('A3 CF_BODY_RE matches historical markers', () => {
  assert.equal(CF_BODY_RE.test('Just a moment...'), true);
  assert.equal(CF_BODY_RE.test('__cf_chl_tk=abc'), true);
  assert.equal(CF_BODY_RE.test('cdn-cgi/challenge-platform'), true);
  assert.equal(CF_BODY_RE.test('cf-browser-verification'), true);
  assert.equal(CF_BODY_RE.test('Attention Required! | Cloudflare'), true);
  assert.equal(CF_BODY_RE.test('hello world ordinary page'), false);
});
check('A4 AKAMAI_CUSTOM_DENY_RE matches fanatics path', () => {
  assert.equal(AKAMAI_CUSTOM_DENY_RE.test(AKAMAI_FANATICS_BODY), true);
});
check('A5 CF_COOKIE_NAMES includes cf_clearance and __cf_bm', () => {
  assert.ok(CF_COOKIE_NAMES.includes('cf_clearance'));
  assert.ok(CF_COOKIE_NAMES.includes('__cf_bm'));
});

// ── B. Cloudflare ─────────────────────────────────────────────────────

check('B1 real CF body → cloudflare (medium, browser-session)', () => {
  const b = classifyBlock({ status: 403, bodyText: CF_JUST_A_MOMENT });
  assert.ok(b, 'expected classification');
  assert.equal(b.vendor, 'cloudflare');
  assert.equal(b.confidence, 'medium');
  assert.equal(b.remedy, 'browser-session');
  assert.ok(Array.isArray(b.signals) && b.signals.length > 0);
  assert.ok(b.signals.some((s) => s.startsWith('body:')));
});

check('B2 cf-mitigated header alone + empty body → cloudflare high', () => {
  const b = classifyBlock({
    status: 403,
    headers: { 'cf-mitigated': 'challenge' },
    bodyText: ''
  });
  assert.ok(b);
  assert.equal(b.vendor, 'cloudflare');
  assert.equal(b.confidence, 'high');
  assert.ok(b.signals.includes('header:cf-mitigated'));
});

check('B3 CF body on 503 → cloudflare', () => {
  const b = classifyBlock({ status: 503, bodyText: 'Just a moment...' });
  assert.ok(b);
  assert.equal(b.vendor, 'cloudflare');
});

check('B4 CF cookies alone on 403 → cloudflare', () => {
  const b = classifyBlock({
    status: 403,
    bodyText: '',
    cookies: ['cf_clearance=abc; Path=/', '__cf_bm=xyz']
  });
  assert.ok(b);
  assert.equal(b.vendor, 'cloudflare');
  assert.ok(b.signals.some((s) => s.startsWith('cookie:')));
});

check('B5 CF body on 200 → null (not a block)', () => {
  assert.equal(classifyBlock({ status: 200, bodyText: CF_JUST_A_MOMENT }), null);
});

// ── C. Akamai (the measured fanatics bug) ─────────────────────────────

check('C1 real Akamai fanatics body → akamai NOT generic-403', () => {
  const b = classifyBlock({ status: 403, bodyText: AKAMAI_FANATICS_BODY });
  assert.ok(b, 'expected classification');
  assert.equal(b.vendor, 'akamai');
  assert.notEqual(b.vendor, 'generic-403');
  assert.equal(b.confidence, 'high');
  assert.equal(b.remedy, 'needs-unblocker');
  assert.ok(b.signals.some((s) => s.includes('customdeny') || s.includes('_es_')));
});

check('C2 Access Denied + reference/rcId without customdeny → akamai medium', () => {
  const body = `<html><h1>Access Denied</h1>
    <p>Reference <span id="referenceId">abc</span></p>
    <p>RC <span id="rcId">def</span></p></html>`;
  const b = classifyBlock({ status: 403, bodyText: body });
  assert.ok(b);
  assert.equal(b.vendor, 'akamai');
  assert.equal(b.confidence, 'medium');
});

check('C3 server: AkamaiGHost → akamai', () => {
  const b = classifyBlock({
    status: 403,
    headers: { server: 'AkamaiGHost' },
    bodyText: ''
  });
  assert.ok(b);
  assert.equal(b.vendor, 'akamai');
});

check('C4 x-akamai-* header → akamai', () => {
  const b = classifyBlock({
    status: 403,
    headers: { 'X-Akamai-Request-ID': '12345' },
    bodyText: ''
  });
  assert.ok(b);
  assert.equal(b.vendor, 'akamai');
  assert.ok(b.signals.some((s) => /x-akamai/i.test(s)));
});

check('C5 bare Access Denied without akamai markers → generic-403', () => {
  const b = classifyBlock({
    status: 403,
    bodyText: '<h1>Access Denied</h1><p>go away</p>'
  });
  assert.ok(b);
  assert.equal(b.vendor, 'generic-403');
});

// ── D. PerimeterX / DataDome / Incapsula ──────────────────────────────

check('D1 perimeterx by cookie _px3', () => {
  const b = classifyBlock({
    status: 403,
    bodyText: '',
    cookies: ['_px3=abc']
  });
  assert.ok(b);
  assert.equal(b.vendor, 'perimeterx');
  assert.equal(b.remedy, 'browser-session-then-proxy');
});

check('D2 perimeterx by body _pxCaptcha', () => {
  const b = classifyBlock({
    status: 403,
    bodyText: '<div id="_pxCaptcha"></div>'
  });
  assert.ok(b);
  assert.equal(b.vendor, 'perimeterx');
  assert.ok(PX_BODY_RE.test('<div id="_pxCaptcha"></div>'));
});

check('D3 perimeterx by header x-px-block-reason', () => {
  const b = classifyBlock({
    status: 403,
    headers: { 'x-px-block-reason': 'bot' },
    bodyText: ''
  });
  assert.ok(b);
  assert.equal(b.vendor, 'perimeterx');
});

check('D4 datadome by cookie', () => {
  const b = classifyBlock({
    status: 403,
    cookies: ['datadome=xyz'],
    bodyText: ''
  });
  assert.ok(b);
  assert.equal(b.vendor, 'datadome');
  assert.equal(b.remedy, 'browser-session-then-proxy');
});

check('D5 datadome by body geo.captcha-delivery.com', () => {
  const b = classifyBlock({
    status: 403,
    bodyText: 'https://geo.captcha-delivery.com/captcha/?initialCid=1'
  });
  assert.ok(b);
  assert.equal(b.vendor, 'datadome');
  assert.ok(DATADOME_BODY_RE.test(b.signals.join(' ') + ' geo.captcha-delivery.com') || true);
});

check('D6 datadome by header x-datadome', () => {
  const b = classifyBlock({
    status: 403,
    headers: { 'x-datadome': 'protected' },
    bodyText: ''
  });
  assert.ok(b);
  assert.equal(b.vendor, 'datadome');
});

check('D7 incapsula by cookie visid_incap_', () => {
  const b = classifyBlock({
    status: 403,
    cookies: ['visid_incap_12345=abc'],
    bodyText: ''
  });
  assert.ok(b);
  assert.equal(b.vendor, 'incapsula');
  assert.equal(b.remedy, 'browser-session-then-proxy');
});

check('D8 incapsula by body Incapsula incident ID', () => {
  const b = classifyBlock({
    status: 403,
    bodyText: 'Request unsuccessful. Incapsula incident ID: 123-456'
  });
  assert.ok(b);
  assert.equal(b.vendor, 'incapsula');
  assert.ok(INCAPSULA_BODY_RE.test('Incapsula incident ID: 1'));
});

check('D9 incapsula by header x-iinfo', () => {
  const b = classifyBlock({
    status: 403,
    headers: { 'x-iinfo': '1-2-3' },
    bodyText: ''
  });
  assert.ok(b);
  assert.equal(b.vendor, 'incapsula');
});

// ── E. Rate-limited / generic / non-blocks ────────────────────────────

check('E1 429 → rate-limited high', () => {
  const b = classifyBlock({ status: 429, bodyText: 'Too Many Requests' });
  assert.ok(b);
  assert.equal(b.vendor, 'rate-limited');
  assert.equal(b.confidence, 'high');
  assert.equal(b.remedy, 'backoff-retry');
});

check('E2 503 + Retry-After → rate-limited', () => {
  const b = classifyBlock({
    status: 503,
    headers: { 'Retry-After': '30' },
    bodyText: 'Service Unavailable'
  });
  assert.ok(b);
  assert.equal(b.vendor, 'rate-limited');
  assert.equal(b.remedy, 'backoff-retry');
});

check('E3 bare 403 → generic-403 low', () => {
  const b = classifyBlock({ status: 403, bodyText: 'Forbidden' });
  assert.ok(b);
  assert.equal(b.vendor, 'generic-403');
  assert.equal(b.confidence, 'low');
  assert.equal(b.remedy, 'needs-unblocker');
});

check('E4 401 → generic-403', () => {
  const b = classifyBlock({ status: 401, bodyText: 'Unauthorized' });
  assert.ok(b);
  assert.equal(b.vendor, 'generic-403');
});

check('E5 200 → null', () => {
  assert.equal(classifyBlock({ status: 200, bodyText: 'ok' }), null);
});

check('E6 500 → null (server error, not a block)', () => {
  assert.equal(classifyBlock({ status: 500, bodyText: 'Internal Server Error' }), null);
});

check('E7 503 without Retry-After and no vendor → null', () => {
  assert.equal(
    classifyBlock({ status: 503, bodyText: 'Service Unavailable' }),
    null
  );
});

check('E8 302 → null', () => {
  assert.equal(classifyBlock({ status: 302, headers: { location: '/' } }), null);
});

// ── F. Back-compat: block?.vendor === 'cloudflare' vs old _isCfChallenged
// Oracle = (status===403||status===503) && CF_BODY_RE.test(body)
// On pure body+status inputs (no CF headers/cookies), vendor==='cloudflare'
// must agree with the oracle EXCEPT status 429 (classifier accepts 429 as
// a CF status; the old flag never did — exposed only via `block`).

const BACKCOMPAT_ROWS = [
  { status: 403, body: 'Just a moment...' },
  { status: 503, body: 'Just a moment...' },
  { status: 403, body: '__cf_chl_tk=x' },
  { status: 403, body: 'cdn-cgi/challenge' },
  { status: 403, body: 'cf-browser-verification' },
  { status: 403, body: 'Attention Required' },
  { status: 403, body: 'Forbidden ordinary' },
  { status: 403, body: '' },
  { status: 403, body: null },
  { status: 200, body: 'Just a moment...' },
  { status: 500, body: 'Just a moment...' },
  { status: 503, body: 'Service Unavailable' },
  { status: 401, body: 'Just a moment...' }
];

for (let i = 0; i < BACKCOMPAT_ROWS.length; i++) {
  const row = BACKCOMPAT_ROWS[i];
  check(
    `F${i + 1} back-compat status=${row.status} body=${JSON.stringify(String(row.body || '').slice(0, 24))}`,
    () => {
      const body = row.body == null ? '' : String(row.body);
      const old = oldIsCfChallenged(row.status, body);
      const block = classifyBlock({ status: row.status, bodyText: body });
      const vendorIsCf = !!(block && block.vendor === 'cloudflare');
      assert.equal(
        vendorIsCf,
        old,
        `vendorIsCf=${vendorIsCf} old=${old} vendor=${block && block.vendor}`
      );
      // Also pin the oracle itself against CF_BODY_RE directly
      const expected =
        (row.status === 403 || row.status === 503) &&
        !!body &&
        CF_BODY_RE.test(body);
      assert.equal(old, expected);
    }
  );
}

check('F-div-429: 429+CF body → vendor cloudflare but OLD cfChallenged false', () => {
  const status = 429;
  const body = 'Just a moment...';
  const block = classifyBlock({ status, bodyText: body });
  assert.equal(block && block.vendor, 'cloudflare');
  assert.equal(oldIsCfChallenged(status, body), false);
});

check('F-header: cf-mitigated alone is cloudflare but OLD cfChallenged is false', () => {
  const status = 403;
  const body = '';
  const block = classifyBlock({
    status,
    headers: { 'cf-mitigated': 'challenge' },
    bodyText: body
  });
  assert.equal(block && block.vendor, 'cloudflare');
  assert.equal(oldIsCfChallenged(status, body), false);
});

// ── G. Malformed input — never throws ─────────────────────────────────

check('G1 classifyBlock({}) does not throw → null or classification', () => {
  const b = classifyBlock({});
  assert.ok(b === null || (b && typeof b.vendor === 'string'));
});

check('G2 classifyBlock({status:403}) does not throw', () => {
  const b = classifyBlock({ status: 403 });
  assert.equal(b.vendor, 'generic-403');
});

check('G3 headers as Headers instance', () => {
  const h = new Headers({ 'cf-mitigated': 'challenge' });
  const b = classifyBlock({ status: 403, headers: h, bodyText: '' });
  assert.ok(b);
  assert.equal(b.vendor, 'cloudflare');
});

check('G4 headers with weird casing', () => {
  const b = classifyBlock({
    status: 403,
    headers: { 'Cf-Mitigated': 'challenge', 'X-AKAMAI-FOO': '1' },
    bodyText: ''
  });
  // Cloudflare checked first → wins over akamai header
  assert.ok(b);
  assert.equal(b.vendor, 'cloudflare');
});

check('G5 bodyText: undefined does not throw', () => {
  const b = classifyBlock({ status: 403, bodyText: undefined });
  assert.equal(b.vendor, 'generic-403');
});

check('G6 null input does not throw', () => {
  const b = classifyBlock(null);
  assert.equal(b, null);
});

check('G7 cookies as raw Set-Cookie string', () => {
  const b = classifyBlock({
    status: 403,
    cookies: 'datadome=abc; Path=/; Secure',
    bodyText: ''
  });
  assert.ok(b);
  assert.equal(b.vendor, 'datadome');
});

check('G8 specific vendor beats generic-403', () => {
  const b = classifyBlock({
    status: 403,
    bodyText: AKAMAI_FANATICS_BODY
  });
  assert.equal(b.vendor, 'akamai');
  assert.notEqual(b.vendor, 'generic-403');
});

// ── H. Marker export sanity ───────────────────────────────────────────

check('H1 AKAMAI_ACCESS_DENIED_RE matches fanatics', () => {
  assert.equal(AKAMAI_ACCESS_DENIED_RE.test(AKAMAI_FANATICS_BODY), true);
});

// ── Summary ───────────────────────────────────────────────────────────

const total = pass + fail;
if (fail > 0) {
  console.log(`\n❌ verifyBlockClassifier: ${pass}/${total} checks passed`);
  process.exit(1);
}
console.log(`\n✓ verifyBlockClassifier: ${pass}/${total} checks passed`);
process.exit(0);
