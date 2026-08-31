#!/usr/bin/env node
'use strict';
/**
 * verifyShopifyThemeFontIngest — offline guards for the Shopify theme font
 * ingest path (services/shopifyThemeFontService.js, added 2026-08-31).
 *
 * WHY THIS EXISTS
 * A third font source, alongside the marketing-homepage scan
 * (brandFontIngestService) and the meta-ads vision NAME scan
 * (metaAdsFontService). Money/correctness properties that matter here and
 * are not visible from the happy path:
 *   · FREE — like the website scan, a failure must NEVER permanently stamp
 *     Brand.shopifyFontsIngestedAt (unlike the billable meta-ads path).
 *   · REUSE, NOT REINVENT — the module must share brandFontIngestService's
 *     actual validation/download/licence-gate/Cloudinary-mirror code
 *     (mirrorDiscoveredFace) rather than a second, divergent copy.
 *   · LICENSING — a face served from Shopify's own font-library CDN
 *     (fonts.shopifycdn.com) must be treated as commercial/merchant-
 *     licensed, gated the same way an existing commercial foundry is,
 *     never silently mirrored.
 *   · AUTHED-FIRST, PUBLIC-FALLBACK — an Admin API credential (when one
 *     resolves) is tried before the public storefront-HTML fetch; either
 *     one working independently must be enough to get real files.
 *   · MYSHOPIFY FALLBACK — a headless custom domain that yields nothing
 *     must fall back to the discovered myshopify.com backend, the same
 *     discovery shopifyAccessResolver already does for catalog sync.
 *
 * REVERT MAP (which checks fail if each part is undone):
 *   (1) shared face-mirror code, not a copy               → R1-R3
 *   (2) Shopify font-library CDN classified commercial     → L1-L3
 *   (3) commercial+unlicensed gate never downloads         → G1
 *   (4) Admin credential never cross-brand                 → A1-A3
 *   (5) authed tried before public; public still standalone→ O1-O3
 *   (6) myshopify fallback wired                           → M1
 *   (7) real @font-face parsed from a Shopify-shaped sheet  → P1-P2
 *   (8) shopifyFontsIngestedAt stamped ONLY on success,
 *       enrichment tier gated on shopifyUrl not method/isDemo → S1-S4
 *   (9) applyShopifyFontIngestResult never downgrades a
 *       better existing websiteFontUsage / 'website' fontSource → E1-E3
 *
 * No DB, no network egress except ONE deliberate loopback connect-refused
 * (127.0.0.1:1) used to exercise a real download failure fast and
 * deterministically without leaving the machine. Safe in CI.
 *   node scripts/verifyShopifyThemeFontIngest.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
const queue = [];
function check(label, fn) {
  queue.push(async () => {
    try { await fn(); pass++; }
    catch (err) { failures.push(`${label}: ${err.message}`); }
  });
}

const svc = require('../services/shopifyThemeFontService');
const {
  ingestShopifyThemeFonts,
  classifyShopifyFontSource,
  resolveShopifyAdminCred,
  extractShopifyPickerFontNames,
  SHOPIFY_FONT_LIBRARY_HOSTS,
} = svc;
const {
  mirrorDiscoveredFace,
  parseFontFacesFromCss,
  aggregateFontUsageAcrossSheets,
} = require('../services/brandFontIngestService');
const { applyShopifyFontIngestResult } = require('../services/brandFontPersistenceService');

const SVC_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'shopifyThemeFontService.js'), 'utf8');
const ENRICH_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'brandEnrichmentService.js'), 'utf8');

// A bare substring test is fooled by a comment documenting the very field it
// checks ("// NEVER stamp shopifyFontsIngestedAt here" contains the field
// name) — this repo's CLAUDE.md flags exactly this trap elsewhere. Strip
// `//` line comments before any structural source check below, and require
// ASSIGNMENT syntax (`field =` / `field:`) rather than a bare mention, so a
// prose comment can never satisfy the check.
function stripLineComments(src) {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}
function assignsField(src, field) {
  return new RegExp(`\\b${field}\\s*[:=]`).test(stripLineComments(src));
}

console.log('\nverifyShopifyThemeFontIngest — Shopify theme font ingest: reuse, licensing, authed/public, retryability\n');

// ── R. Shared code, not a second copy. Fails if (1) is reverted. ──────────
check('R1 requires mirrorDiscoveredFace from brandFontIngestService (not reimplemented)', () => {
  assert.ok(/mirrorDiscoveredFace/.test(SVC_SRC), 'must reuse the shared face-mirror function');
  assert.ok(/require\(['"]\.\/brandFontIngestService['"]\)/.test(SVC_SRC), 'must require it from brandFontIngestService');
});
check('R2 requires parseFontFacesFromCss / collectStylesheets / dedupeFaces / aggregateFontUsageAcrossSheets (shared CSS pipeline)', () => {
  for (const name of ['parseFontFacesFromCss', 'collectStylesheets', 'dedupeFaces', 'aggregateFontUsageAcrossSheets']) {
    assert.ok(SVC_SRC.includes(name), `must reuse ${name} rather than re-implement CSS parsing`);
  }
});
check('R3 does NOT re-declare its own font magic-byte / download-failure classifier', () => {
  assert.ok(!/FONT_MAGIC_SIGNATURES/.test(SVC_SRC), 'must not duplicate the magic-byte table');
  assert.ok(!/function\s+downloadFontFile/.test(SVC_SRC), 'must not duplicate the downloader — call mirrorDiscoveredFace instead');
});

// ── L. Shopify font-library licensing gate. Fails if (2) is reverted. ─────
check('L1 fonts.shopifycdn.com classifies commercial', () => {
  assert.strictEqual(classifyShopifyFontSource('https://fonts.shopifycdn.com/inter/v1/inter.woff2'), 'commercial');
});
check('L2 a subdomain of the library host also classifies commercial (defensive suffix match)', () => {
  assert.strictEqual(classifyShopifyFontSource('https://eu.fonts.shopifycdn.com/x.woff2'), 'commercial');
});
check('L3 a merchant self-hosted theme asset (cdn/shop/t/.../assets/*.woff) is NOT the library host', () => {
  const result = classifyShopifyFontSource('https://apparel.example.com/cdn/shop/t/345/assets/inter_n4.woff');
  assert.strictEqual(result, 'unknown', 'self-hosted theme assets fall through to the base classifier, not commercial-by-association');
});
check('L4 SHOPIFY_FONT_LIBRARY_HOSTS is exported and non-empty (audit surface)', () => {
  assert.ok(Array.isArray(SHOPIFY_FONT_LIBRARY_HOSTS) && SHOPIFY_FONT_LIBRARY_HOSTS.length > 0);
});

// ── G. Commercial+unlicensed never downloads. Fails if (3) is reverted. ───
check('G1 fonts.shopifycdn.com face is FLAGGED not downloaded when BRAND_FONT_ASSUME_LICENSED=false', async () => {
  const prev = process.env.BRAND_FONT_ASSUME_LICENSED;
  process.env.BRAND_FONT_ASSUME_LICENSED = 'false';
  try {
    const face = { family: 'Shopify Sans', weight: 400, style: 'normal', format: 'woff2', url: 'https://fonts.shopifycdn.com/shopify-sans/v1/x.woff2' };
    const res = await mirrorDiscoveredFace(face, {
      pageUrl: 'https://example.com/',
      brandId: 'b1',
      mirrorCounts: {},
      source: 'shopify-theme',
      classify: classifyShopifyFontSource,
    });
    assert.strictEqual(res.ingested, null, 'must never mirror an unlicensed commercial face');
    assert.ok(res.flagged, 'must flag it instead');
    assert.strictEqual(res.flagged.url, null);
    assert.strictEqual(res.flagged.needsLicense, true);
    assert.strictEqual(res.flagged.license, 'commercial');
  } finally {
    if (prev === undefined) delete process.env.BRAND_FONT_ASSUME_LICENSED;
    else process.env.BRAND_FONT_ASSUME_LICENSED = prev;
  }
});

// ── A. Admin credential resolution never cross-brand. Fails if (4) is reverted. ──
check('A1 no credential when SHOPIFY_ACCESS_TOKEN/SHOPIFY_STORE_DOMAIN unset', () => {
  const prevD = process.env.SHOPIFY_STORE_DOMAIN, prevT = process.env.SHOPIFY_ACCESS_TOKEN;
  delete process.env.SHOPIFY_STORE_DOMAIN; delete process.env.SHOPIFY_ACCESS_TOKEN;
  try {
    assert.strictEqual(resolveShopifyAdminCred('shop.myshopify.com'), null);
  } finally {
    if (prevD !== undefined) process.env.SHOPIFY_STORE_DOMAIN = prevD;
    if (prevT !== undefined) process.env.SHOPIFY_ACCESS_TOKEN = prevT;
  }
});
check('A2 configured token is NEVER used against a DIFFERENT brand\'s store host', () => {
  const prevD = process.env.SHOPIFY_STORE_DOMAIN, prevT = process.env.SHOPIFY_ACCESS_TOKEN;
  process.env.SHOPIFY_STORE_DOMAIN = 'configured-shop.myshopify.com';
  process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_test_token';
  try {
    assert.strictEqual(resolveShopifyAdminCred('someone-elses-shop.myshopify.com'), null,
      'a single configured admin token must not be replayed against an arbitrary brand\'s store');
  } finally {
    if (prevD === undefined) delete process.env.SHOPIFY_STORE_DOMAIN; else process.env.SHOPIFY_STORE_DOMAIN = prevD;
    if (prevT === undefined) delete process.env.SHOPIFY_ACCESS_TOKEN; else process.env.SHOPIFY_ACCESS_TOKEN = prevT;
  }
});
check('A3 configured token IS used when the host matches exactly', () => {
  const prevD = process.env.SHOPIFY_STORE_DOMAIN, prevT = process.env.SHOPIFY_ACCESS_TOKEN;
  process.env.SHOPIFY_STORE_DOMAIN = 'configured-shop.myshopify.com';
  process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_test_token';
  try {
    const cred = resolveShopifyAdminCred('configured-shop.myshopify.com');
    assert.ok(cred, 'must resolve for the exact configured host');
    assert.strictEqual(cred.token, 'shpat_test_token');
    assert.ok(cred.apiVersion, 'must default an API version');
  } finally {
    if (prevD === undefined) delete process.env.SHOPIFY_STORE_DOMAIN; else process.env.SHOPIFY_STORE_DOMAIN = prevD;
    if (prevT === undefined) delete process.env.SHOPIFY_ACCESS_TOKEN; else process.env.SHOPIFY_ACCESS_TOKEN = prevT;
  }
});

// ── P. @font-face parsing on a realistic Shopify theme.css shape. ─────────
// Fixture modeled on a REAL captured Shopify Dawn-family theme's inline
// <style> block (verified live 2026-08-31 against a real production brand's
// storefront — see the PR description for the unredacted capture). Confirms
// the shared parser (not reimplemented — see R2) recognises Shopify's own
// font_face-filter output, not just a generic textbook @font-face block.
const SHOPIFY_INLINE_STYLE_FIXTURE = `
  @font-face {
  font-family: Inter;
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  src: url("//example.myshopify.com/cdn/shop/t/345/assets/inter_n4.abc123.woff2") format("woff2"),
       url("//example.myshopify.com/cdn/shop/t/345/assets/inter_n4.abc123.woff") format("woff");
  }
  @font-face {
  font-family: Inter;
  font-weight: 700;
  font-style: normal;
  font-display: swap;
  src: url("//example.myshopify.com/cdn/shop/t/345/assets/inter_n7.def456.woff2") format("woff2");
  }
  h1, h2, h3 { font-family: Inter, sans-serif; }
`;
check('P1 parses BOTH weight cuts of a Shopify font_face-filter inline style block', () => {
  const faces = parseFontFacesFromCss(SHOPIFY_INLINE_STYLE_FIXTURE, 'https://example.myshopify.com/');
  assert.strictEqual(faces.length, 2, 'must find both the 400 and 700 cuts');
  assert.ok(faces.every((f) => f.family === 'Inter'));
  assert.ok(faces.some((f) => f.weight === 400) && faces.some((f) => f.weight === 700));
  assert.ok(faces.every((f) => f.format === 'woff2'), 'woff2 must outrank woff by format rank');
  assert.ok(faces.every((f) => /^https:\/\/example\.myshopify\.com\/cdn\/shop\/t\//.test(f.url)),
    'protocol-relative src must resolve to an absolute https url against the theme origin');
});
check('P2 aggregateFontUsageAcrossSheets identifies Inter as the heading family', () => {
  const usage = aggregateFontUsageAcrossSheets([SHOPIFY_INLINE_STYLE_FIXTURE]);
  assert.strictEqual(usage.heading, 'Inter');
});

// ── O / M / S. Orchestration: authed-first, public fallback, myshopify
// fallback, retryable failure. All via injected deps — no real network
// except one deliberate fast loopback refusal for the download-failure case.
const REFUSED_FONT_URL = 'http://127.0.0.1:1/unreachable.woff2'; // nothing listens here — fast ECONNREFUSED, stays on loopback

function htmlWithInlineFontFace(family = 'Public Sans') {
  return `<html><head><style>@font-face{font-family:${family};font-weight:400;font-style:normal;src:url(${REFUSED_FONT_URL}) format("woff2");}</style></head><body></body></html>`;
}

check('O1 PUBLIC path works standalone with no admin credential configured', async () => {
  const brand = { _id: 'pub1', name: 'PublicOnly', apifyDemo: { shopifyUrl: 'https://public-shop.example.com' } };
  const res = await ingestShopifyThemeFonts(brand, {
    resolveShopifyAdminCred: () => null,
    fetchHomepage: async (origin) => ({ html: htmlWithInlineFontFace('Public Sans'), pageUrl: origin }),
  });
  assert.strictEqual(res.via, 'public');
  assert.ok(res.errors.some((e) => /ingest failed for "Public Sans"/.test(e)), 'the refused download must surface as a retryable error, not a throw');
});

check('O2 AUTHED path is tried first and used when it yields a CSS asset with @font-face', async () => {
  const brand = { _id: 'auth1', name: 'AuthedShop', apifyDemo: { shopifyUrl: 'https://authed-shop.example.com' } };
  let adminCalls = 0, publicCalls = 0;
  const res = await ingestShopifyThemeFonts(brand, {
    resolveShopifyAdminCred: (host) => ({ token: 'tok', apiVersion: '2023-07' }),
    adminGet: async (url) => {
      adminCalls++;
      const assetKey = (() => {
        const m = url.match(/[?&]asset(?:%5B|\[)key(?:%5D|\])=([^&]+)/);
        return m ? decodeURIComponent(m[1]) : null;
      })();
      if (url.endsWith('/themes.json')) return { data: { themes: [{ id: 999, role: 'main' }] } };
      if (!assetKey && url.includes('/themes/999/assets.json')) {
        return { data: { assets: [{ key: 'assets/theme.css' }, { key: 'config/settings_data.json' }] } };
      }
      if (assetKey === 'assets/theme.css') {
        return { data: { asset: { value: `@font-face{font-family:AdminFace;font-weight:400;font-style:normal;src:url(${REFUSED_FONT_URL}) format("woff2");}` } } };
      }
      if (assetKey === 'config/settings_data.json') {
        return { data: { asset: { value: JSON.stringify({ current: { type_header_font: 'admin_n4' } }) } } };
      }
      throw new Error(`unexpected admin url in fixture: ${url}`);
    },
    fetchHomepage: async () => { publicCalls++; return { html: '<html></html>', pageUrl: 'https://authed-shop.example.com/' }; },
  });
  assert.strictEqual(res.via, 'authed', 'admin CSS asset had @font-face — must not fall through to public');
  assert.ok(adminCalls >= 3, 'must call themes.json, assets.json listing, and at least one asset fetch');
  assert.strictEqual(publicCalls, 0, 'authed success must not also hit the public path');
});

check('O3 AUTHED credential resolves but the API call throws → falls back to PUBLIC (never surfaces as a hard failure)', async () => {
  const brand = { _id: 'auth2', name: 'AuthedButBroken', apifyDemo: { shopifyUrl: 'https://broken-admin.example.com' } };
  const res = await ingestShopifyThemeFonts(brand, {
    resolveShopifyAdminCred: () => ({ token: 'bad', apiVersion: '2023-07' }),
    adminGet: async () => { throw new Error('401 Unauthorized'); },
    fetchHomepage: async (origin) => ({ html: htmlWithInlineFontFace('Fallback Sans'), pageUrl: origin }),
  });
  assert.strictEqual(res.via, 'public', 'a broken admin credential must fall back to the free public path, not throw');
  assert.ok(res.errors.some((e) => /authed:/.test(e)), 'the admin failure must still be recorded for ops visibility');
});

check('M1 myshopify-backend fallback fires when the custom domain yields nothing', async () => {
  const brand = { _id: 'headless1', name: 'HeadlessStore', apifyDemo: { shopifyUrl: 'https://headless.example.com' } };
  const calls = [];
  const res = await ingestShopifyThemeFonts(brand, {
    resolveShopifyAdminCred: () => null,
    fetchHomepage: async (origin) => {
      calls.push(origin);
      if (origin === 'https://headless.example.com') {
        // No usable stylesheet, but DOES reveal the real Shopify backend —
        // the exact discovery shopifyAccessResolver's catalog-sync ladder
        // already performs; font ingest reuses it (see the module header
        // and shopifyThemeFontService's discoverMyshopifyDomain call site).
        return { html: '<html><script>Shopify.shop = "headless-backend.myshopify.com";</script></html>', pageUrl: origin };
      }
      if (origin === 'https://headless-backend.myshopify.com') {
        return { html: htmlWithInlineFontFace('Backend Sans'), pageUrl: origin };
      }
      throw new Error(`unexpected origin in fixture: ${origin}`);
    },
  });
  assert.ok(calls.includes('https://headless.example.com') && calls.includes('https://headless-backend.myshopify.com'),
    'must try the custom domain first, then the discovered myshopify backend');
  assert.ok(String(res.via).includes('myshopify-fallback'), `via should record the fallback, got: ${res.via}`);
});

// ── S. Retryability: never stamp shopifyFontsIngestedAt on failure. ───────
// Fails if (8) is reverted.
check('S1 ingestShopifyThemeFonts throws when brand has no shopify URL at all (caller decides retry policy)', async () => {
  await assert.rejects(() => ingestShopifyThemeFonts({ _id: 'nourl', name: 'NoUrl' }), /no shopifyUrl configured/);
});
check('S2 brandEnrichmentService: the shopify-theme-fonts tier only stamps shopifyFontsIngestedAt via applyShopifyFontIngestResult (success path), never in its own catch', () => {
  const tierMatch = ENRICH_SRC.match(/if \(wantShopifyFonts\) \{[\s\S]*?\n  \}\n/);
  assert.ok(tierMatch, 'must find the wantShopifyFonts tier block in brandEnrichmentService.js');
  const block = tierMatch[0];
  const catchMatch = block.match(/\} catch \(err\) \{[\s\S]*$/);
  assert.ok(catchMatch, 'tier must have a catch block');
  assert.ok(!assignsField(catchMatch[0], 'shopifyFontsIngestedAt'),
    'the catch branch must NEVER stamp shopifyFontsIngestedAt — this path is free and must stay retryable on failure');
  assert.ok(assignsField(catchMatch[0], 'shopifyFontsIngestError'), 'the catch branch should still record the error for ops visibility');
  assert.ok(/applyShopifyFontIngestResult/.test(block), 'the success branch must persist via applyShopifyFontIngestResult');
});
check('S3 wantShopifyFonts is gated on apifyDemo.shopifyUrl presence, NOT on apifyDemo.method or isDemo', () => {
  const line = ENRICH_SRC.match(/const wantShopifyFonts\s*=\s*[^\n]+/);
  assert.ok(line, 'must find the wantShopifyFonts declaration');
  assert.ok(/shopifyUrl/.test(line[0]), 'must key off shopifyUrl');
  assert.ok(!/apifyDemo\.method/.test(line[0]), 'must NOT gate on apifyDemo.method — owner directive: any ingest method, or none');
  assert.ok(!/isDemo/.test(line[0]), 'must NOT gate on isDemo — owner directive: demo brands are not special-cased');
});
check('S4 routes/brand.js ingest-shopify-fonts route never stamps shopifyFontsIngestedAt in its catch', () => {
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'brand.js'), 'utf8');
  const routeMatch = routeSrc.match(/router\.post\('\/:id\/ingest-shopify-fonts'[\s\S]*?\n\}\);\n/);
  assert.ok(routeMatch, 'must find the ingest-shopify-fonts route');
  const catchMatch = routeMatch[0].match(/\} catch \(err\) \{[\s\S]*$/);
  assert.ok(catchMatch, 'route must have a catch block');
  assert.ok(!assignsField(catchMatch[0], 'shopifyFontsIngestedAt'), 'the route catch must never stamp shopifyFontsIngestedAt — matches the free website-path contract, not the billable meta-ads route');
});

// ── E. Persistence: shared fields, never downgrades a better existing value. ──
// Fails if (9) is reverted.
check('E1 applyShopifyFontIngestResult merges into the SAME Brand.customFonts field (no new storage field)', () => {
  const brand = { customFonts: [], websiteFontUsage: null, curatedFields: [] };
  applyShopifyFontIngestResult(brand, {
    ingested: [{ family: 'Inter', weight: 400, style: 'normal', format: 'woff2', url: 'https://res.cloudinary.com/x/inter.woff2', source: 'shopify-theme', license: 'unknown', needsLicense: false }],
    flagged: [],
    usage: { heading: 'Inter', body: 'Inter', evidence: [] },
    errors: [],
  });
  assert.strictEqual(brand.customFonts.length, 1);
  assert.strictEqual(brand.customFonts[0].source, 'shopify-theme');
  assert.ok(brand.shopifyFontsIngestedAt instanceof Date, 'must stamp on the call (this function is only ever called from the success branch)');
  assert.strictEqual(brand.fontFamily, 'Inter');
  assert.strictEqual(brand.fontSource, 'shopify-theme');
});
check('E2 never overwrites an existing website-scraped fontSource', () => {
  const brand = {
    customFonts: [{ family: 'Inter', weight: 400, style: 'normal', url: 'https://res.cloudinary.com/x/inter.woff2', license: 'unknown', needsLicense: false }],
    websiteFontUsage: { heading: 'Marketing Serif', body: 'Marketing Serif' },
    fontFamily: 'Marketing Serif',
    fontSource: 'website',
    curatedFields: [],
  };
  applyShopifyFontIngestResult(brand, {
    ingested: [{ family: 'Inter', weight: 400, style: 'normal', format: 'woff2', url: 'https://res.cloudinary.com/x/inter.woff2', source: 'shopify-theme', license: 'unknown', needsLicense: false }],
    flagged: [],
    usage: { heading: 'Inter', body: 'Inter', evidence: [] },
    errors: [],
  });
  assert.strictEqual(brand.fontFamily, 'Marketing Serif', 'an existing website-sourced fontFamily must not be overridden by a Shopify-theme find');
  assert.strictEqual(brand.fontSource, 'website');
});
check('E3 does not clobber a better existing websiteFontUsage with an empty Shopify-theme scan', () => {
  const brand = {
    customFonts: [],
    websiteFontUsage: { heading: 'Good Serif', body: 'Good Serif', evidence: [{ family: 'Good Serif', role: 'heading', selector: 'h1', score: 4 }] },
    curatedFields: [],
  };
  applyShopifyFontIngestResult(brand, { ingested: [], flagged: [], usage: { heading: null, body: null, evidence: [] }, errors: ['no ad creatives found'] });
  assert.strictEqual(brand.websiteFontUsage.heading, 'Good Serif', 'an empty later scan must not erase a real earlier signal in the SHARED field');
  assert.ok(brand.shopifyFontsIngestedAt instanceof Date, 'the attempt itself is still recorded (this brand genuinely has no theme fonts to add)');
});

(async () => {
  for (const run of queue) await run();
  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  ❌ ${f}`);
    process.exit(1);
  }
  console.log('  ✅ verifyShopifyThemeFontIngest green\n');
})();
