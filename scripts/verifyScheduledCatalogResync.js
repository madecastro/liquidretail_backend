#!/usr/bin/env node
'use strict';
/**
 * verifyScheduledCatalogResync — DATA-PATH-AUDIT §9 item 12.
 *
 *   A. Flag parser === 'true' + file default true; flag-off is IG-only.
 *   B. Interval / spacing parsers (blank/negative → shipped default).
 *   C. Due-check: null last → due; recent → skip; aged → due.
 *   D. Each non-IG method has a resolver arm (shopify-direct, generic,
 *      apify) plus demo brands reuse resolveCatalogMethod.
 *   E. Serial: selectDueCatalogResyncCandidate returns ONE brand;
 *      spacing skip; in-progress skip.
 *   F. imageUrl null-heal / no-clobber (catalogImageUrlGuard).
 *   G. Structural: lastCatalogResyncAt declared; skipInstagram on demo
 *      dispatch; IG loop still type:'instagram'; writers use assignImageUrl.
 *   RP. Mutation-prove the load-bearing pins.
 *
 * Run: node scripts/verifyScheduledCatalogResync.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SVC_PATH = path.join(ROOT, 'services/scheduledSyncService.js');
const GUARD_PATH = path.join(ROOT, 'services/catalogImageUrlGuard.js');
const BRAND_PATH = path.join(ROOT, 'models/Brand.js');
const DEFAULTS_ENV = path.join(ROOT, 'config/defaults.env');

const ORIG = {
  enabled: process.env.CATALOG_SCHEDULED_RESYNC_ENABLED,
  interval: process.env.CATALOG_RESYNC_INTERVAL_H,
  spacing: process.env.CATALOG_RESYNC_SPACING_MS,
};

function restoreEnv() {
  for (const [key, val] of [
    ['CATALOG_SCHEDULED_RESYNC_ENABLED', ORIG.enabled],
    ['CATALOG_RESYNC_INTERVAL_H', ORIG.interval],
    ['CATALOG_RESYNC_SPACING_MS', ORIG.spacing],
  ]) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function withTempMutation(filePath, find, replace, runCheck) {
  const original = fs.readFileSync(filePath, 'utf8');
  assert.ok(original.includes(find), `mutate target not found: ${find.slice(0, 80)}`);
  const mutated = original.replace(find, replace);
  const tmp = path.join(
    os.tmpdir(),
    `verifyScheduledCatalogResync-${path.basename(filePath)}-${process.pid}-${Date.now()}.js`
  );
  fs.writeFileSync(tmp, mutated);
  try { runCheck(fs.readFileSync(tmp, 'utf8')); }
  finally { try { fs.unlinkSync(tmp); } catch (_) { /* tmp cleanup */ } }
  assert.strictEqual(
    fs.readFileSync(filePath, 'utf8'),
    original,
    'real file was modified — mutation must target the temp copy only'
  );
}

process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'true';
process.env.CATALOG_RESYNC_INTERVAL_H = '24';
process.env.CATALOG_RESYNC_SPACING_MS = '180000';

const svc = require('../services/scheduledSyncService');
const { imageUrlPatch, assignImageUrl } = require('../services/catalogImageUrlGuard');

const HOUR = 3600 * 1000;
const now = Date.UTC(2026, 8, 4, 12, 0, 0);

function runParsers() {
  const envSrc = fs.readFileSync(DEFAULTS_ENV, 'utf8');
  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');

  check('A1 CATALOG_SCHEDULED_RESYNC_ENABLED=true in defaults.env',
    /^CATALOG_SCHEDULED_RESYNC_ENABLED=true$/m.test(envSrc));
  check('A2 CATALOG_RESYNC_INTERVAL_H=24 in defaults.env',
    /^CATALOG_RESYNC_INTERVAL_H=24$/m.test(envSrc));
  check('A3 CATALOG_RESYNC_SPACING_MS=180000 in defaults.env',
    /^CATALOG_RESYNC_SPACING_MS=180000$/m.test(envSrc));
  check('A4 parser is strictly === \'true\'',
    /process\.env\.CATALOG_SCHEDULED_RESYNC_ENABLED === 'true'/.test(svcSrc));

  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'true';
  check('A5 === true → enabled', svc.isCatalogScheduledResyncEnabled() === true);
  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'TRUE';
  check('A6 TRUE → disabled (strict parser)', svc.isCatalogScheduledResyncEnabled() === false);
  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'false';
  check('A7 false → disabled', svc.isCatalogScheduledResyncEnabled() === false);
  delete process.env.CATALOG_SCHEDULED_RESYNC_ENABLED;
  check('A8 unset → disabled', svc.isCatalogScheduledResyncEnabled() === false);
  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'true';

  process.env.CATALOG_RESYNC_INTERVAL_H = '24';
  check('B1 interval 24h → 24 hours in ms',
    svc.catalogResyncIntervalMs() === 24 * HOUR);
  process.env.CATALOG_RESYNC_INTERVAL_H = '0';
  check('B2 interval 0 → default 24h',
    svc.catalogResyncIntervalMs() === 24 * HOUR);
  process.env.CATALOG_RESYNC_INTERVAL_H = '-3';
  check('B3 interval negative → default 24h',
    svc.catalogResyncIntervalMs() === 24 * HOUR);
  delete process.env.CATALOG_RESYNC_INTERVAL_H;
  check('B4 interval unset → default 24h',
    svc.catalogResyncIntervalMs() === 24 * HOUR);
  process.env.CATALOG_RESYNC_INTERVAL_H = '24';

  process.env.CATALOG_RESYNC_SPACING_MS = '180000';
  check('B5 spacing 180000 → 3 minutes',
    svc.catalogResyncSpacingMs() === 180000);
  process.env.CATALOG_RESYNC_SPACING_MS = '-1';
  check('B6 spacing negative → default 180000',
    svc.catalogResyncSpacingMs() === 180000);
  delete process.env.CATALOG_RESYNC_SPACING_MS;
  check('B7 spacing unset → default 180000',
    svc.catalogResyncSpacingMs() === 180000);
  process.env.CATALOG_RESYNC_SPACING_MS = '180000';
}

function runDueCheck() {
  const interval = 24 * HOUR;
  check('C1 null lastCatalogResyncAt → due',
    svc.isCatalogResyncDue({ lastCatalogResyncAt: null }, now, interval) === true);
  check('C2 missing field → due',
    svc.isCatalogResyncDue({}, now, interval) === true);
  check('C3 recent (1h ago) → not due',
    svc.isCatalogResyncDue({ lastCatalogResyncAt: new Date(now - HOUR) }, now, interval) === false);
  check('C4 aged (25h ago) → due',
    svc.isCatalogResyncDue({ lastCatalogResyncAt: new Date(now - 25 * HOUR) }, now, interval) === true);
  check('C5 exact interval boundary → due',
    svc.isCatalogResyncDue({ lastCatalogResyncAt: new Date(now - interval) }, now, interval) === true);
  check('C6 null brand → not due',
    svc.isCatalogResyncDue(null, now, interval) === false);
}

function runMethodResolver() {
  check('D1 demo + shopifyUrl + method shopify-direct',
    svc.resolveScheduledCatalogMethod(
      { isDemo: true, apifyDemo: { shopifyUrl: 'https://store.example.com', method: 'shopify-direct' } },
      new Set()
    ) === 'shopify-direct');
  check('D2 demo + method generic-sitemap',
    svc.resolveScheduledCatalogMethod(
      { isDemo: true, apifyDemo: { shopifyUrl: 'https://store.example.com', method: 'generic-sitemap' } },
      new Set()
    ) === 'generic-sitemap');
  check('D3 demo + method apify',
    svc.resolveScheduledCatalogMethod(
      { isDemo: true, apifyDemo: { shopifyUrl: 'https://store.example.com', method: 'apify' } },
      new Set()
    ) === 'apify');
  check('D4 demo + method null + shopifyUrl → shopify-direct (resolveCatalogMethod default)',
    svc.resolveScheduledCatalogMethod(
      { isDemo: true, apifyDemo: { shopifyUrl: 'https://store.example.com', method: null } },
      new Set()
    ) === 'shopify-direct');
  check('D5 non-demo + source shopify-direct',
    svc.resolveScheduledCatalogMethod(
      { isDemo: false, websiteUrl: 'https://x.com' },
      new Set(['shopify-direct'])
    ) === 'shopify-direct');
  check('D6 non-demo + source sitemap-jsonld',
    svc.resolveScheduledCatalogMethod(
      { isDemo: false, websiteUrl: 'https://x.com' },
      new Set(['sitemap-jsonld'])
    ) === 'generic-sitemap');
  check('D7 non-demo + source apify-shopify',
    svc.resolveScheduledCatalogMethod(
      { isDemo: false },
      new Set(['apify-shopify'])
    ) === 'apify');
  check('D8 no source, no origin → null (no invented method)',
    svc.resolveScheduledCatalogMethod({ isDemo: false }, new Set()) === null);
  check('D9 non-demo + websiteUrl origin, no products → shopify-direct',
    svc.resolveScheduledCatalogMethod(
      { isDemo: false, websiteUrl: 'https://shop.example.com' },
      new Set()
    ) === 'shopify-direct');
}

function runSerialAndSkip() {
  const interval = 24 * HOUR;
  const a = {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    lastCatalogResyncAt: new Date(now - 48 * HOUR),
    websiteUrl: 'https://a.example.com',
  };
  const b = {
    _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    lastCatalogResyncAt: new Date(now - 36 * HOUR),
    websiteUrl: 'https://b.example.com',
  };
  const sources = new Map([
    [String(a._id), new Set(['shopify-direct'])],
    [String(b._id), new Set(['sitemap-jsonld'])],
  ]);
  const picked = svc.selectDueCatalogResyncCandidate([a, b], sources, now, interval);
  check('E1 serial: one candidate from two due brands',
    !!picked && String(picked.brand._id) === String(a._id),
    picked ? `got ${picked.brand._id} method=${picked.method}` : 'null');
  check('E2 oldest lastCatalogResyncAt wins (a is older)',
    picked && picked.method === 'shopify-direct');

  const recent = {
    _id: 'cccccccccccccccccccccccc',
    lastCatalogResyncAt: new Date(now - HOUR),
    websiteUrl: 'https://c.example.com',
  };
  const recentMap = new Map([[String(recent._id), new Set(['shopify-direct'])]]);
  check('E3 recent lastCatalogResyncAt → no candidate',
    svc.selectDueCatalogResyncCandidate([recent], recentMap, now, interval) === null);

  const noMethod = { _id: 'dddddddddddddddddddddddd', lastCatalogResyncAt: null };
  check('E4 due but no catalog method → no candidate',
    svc.selectDueCatalogResyncCandidate([noMethod], new Map(), now, interval) === null);
}

function runImageUrl() {
  check('F1 null incoming → empty patch (no clobber)',
    Object.keys(imageUrlPatch(null)).length === 0);
  check('F2 empty string → empty patch',
    Object.keys(imageUrlPatch('')).length === 0
      && Object.keys(imageUrlPatch('   ')).length === 0);
  check('F3 url → { imageUrl } (heal)',
    imageUrlPatch('https://cdn.example.com/hero.jpg').imageUrl === 'https://cdn.example.com/hero.jpg');
  check('F4 trimmed url',
    imageUrlPatch('  https://cdn.example.com/hero.jpg  ').imageUrl === 'https://cdn.example.com/hero.jpg');

  const heal = { title: 'X' };
  assignImageUrl(heal, 'https://cdn.example.com/new.jpg');
  check('F5 assignImageUrl heals null→url by writing imageUrl',
    heal.imageUrl === 'https://cdn.example.com/new.jpg');

  const keep = { title: 'X' };
  assignImageUrl(keep, null);
  check('F6 assignImageUrl on null does not write imageUrl (no clobber)',
    !Object.prototype.hasOwnProperty.call(keep, 'imageUrl'));
}

async function runFlagOffBehavioral() {
  const Brand = require('../models/Brand');
  const origFind = Brand.find;
  let findCalls = 0;
  Brand.find = function catalogResyncMustNotQuery() {
    findCalls += 1;
    throw new Error('Brand.find must not run when flag is off');
  };
  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'false';
  svc._resetCatalogResyncSpacingForTest();
  try {
    const summary = { errors: [] };
    const out = await svc.runDueCatalogResyncs(summary, now);
    check('G1 flag-off runDueCatalogResyncs is a no-op (no Brand.find)',
      findCalls === 0 && out === summary && !out.catalogsResynced);
  } catch (err) {
    check('G1 flag-off runDueCatalogResyncs is a no-op (no Brand.find)',
      false, err.message);
  } finally {
    Brand.find = origFind;
    process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'true';
  }
}

function runStructural() {
  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');
  const brandSrc = fs.readFileSync(BRAND_PATH, 'utf8');
  const guardSrc = fs.readFileSync(GUARD_PATH, 'utf8');
  const code = stripCommentsAndStrings(svcSrc);

  check('H1 Brand schema declares lastCatalogResyncAt',
    /lastCatalogResyncAt:\s*\{\s*type:\s*Date,\s*default:\s*null\s*\}/.test(brandSrc));
  check('H2 demo dispatch passes skipInstagram: true',
    /syncBrandApify\(\s*brand\._id\s*,\s*\{\s*skipInstagram:\s*true\s*\}\s*\)/.test(svcSrc));
  check('H3 IG loop still queries type:\'instagram\'',
    /type:\s*'instagram'/.test(svcSrc));
  check('H4 flag-off gate is first statement of runDueCatalogResyncs',
    /async function runDueCatalogResyncs[\s\S]{0,200}if\s*\(\s*!isCatalogScheduledResyncEnabled\(\)\s*\)\s*return/.test(svcSrc));
  check('H5 in-progress kinds are catalog-sync + demo-sync',
    Array.isArray(svc.CATALOG_RESYNC_IN_PROGRESS_KINDS)
      && svc.CATALOG_RESYNC_IN_PROGRESS_KINDS.includes('catalog-sync')
      && svc.CATALOG_RESYNC_IN_PROGRESS_KINDS.includes('demo-sync'));
  check('H6 one brand per tick: selectDueCatalogResyncCandidate returns due[0]',
    /return due\[0\] \|\| null/.test(svcSrc));
  check('H7 spacing compared against lastCatalogResyncTickAt',
    /lastCatalogResyncTickAt/.test(code) && /catalogResyncSpacingMs\(/.test(code));
  check('H8 success-only stamp of lastCatalogResyncAt',
    /\$set:\s*\{\s*lastCatalogResyncAt:/.test(svcSrc));
  check('H9 catalogImageUrlGuard omits null (no `{ imageUrl: null }`)',
    /return \{\}/.test(guardSrc) && !/imageUrl:\s*null/.test(stripCommentsAndStrings(guardSrc)));

  const writers = [
    'services/shopifyPublicIngestService.js',
    'services/apifyIngestService.js',
    'services/genericCatalogIngestService.js',
    'services/catalogSyncService.js',
  ];
  for (const rel of writers) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const stripped = stripCommentsAndStrings(src);
    check(`H10 ${rel} calls assignImageUrl`,
      /assignImageUrl/.test(stripped));
    check(`H11 ${rel} still applies CATALOG_INGEST_LIMIT via catalogIngestLimit`,
      /catalogIngestLimit/.test(stripped));
  }

  check('H12 runDueSyncs still calls syncCatalog for IG',
    /syncCatalog\(cred\.brandId/.test(svcSrc));
  check('H13 dispatch reuses syncBrandShopifyDirect / syncBrandGenericCatalog / syncBrandApify',
    /syncBrandShopifyDirect/.test(code)
      && /syncBrandGenericCatalog/.test(code)
      && /syncBrandApify/.test(code));
  check('H14 in-progress skip is before dispatch',
    /if \(await hasCatalogSyncInProgress\(picked\.brand\._id\)\)/.test(svcSrc));
  check('H15 in-progress query uses running/cancelling',
    /status:\s*\{\s*\$in:\s*\['running',\s*'cancelling'\]\s*\}/.test(svcSrc)
      || /status:\s*\{\s*\$in:\s*\[\s*'running'\s*,\s*'cancelling'\s*\]/.test(svcSrc));
}

function runMutations() {
  {
    let failedAsExpected = false;
    withTempMutation(
      SVC_PATH,
      "  return process.env.CATALOG_SCHEDULED_RESYNC_ENABLED === 'true';",
      "  return process.env.CATALOG_SCHEDULED_RESYNC_ENABLED !== 'false';",
      (mutSrc) => {
        failedAsExpected = !/CATALOG_SCHEDULED_RESYNC_ENABLED === 'true'/.test(mutSrc);
      }
    );
    check('RP1 [REVERT-PROOF] loosening the flag parser to !== false is detectable (A4)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      GUARD_PATH,
      '    if (trimmed) return { imageUrl: trimmed };\n    return {};',
      '    if (trimmed) return { imageUrl: trimmed };\n    return { imageUrl: null };',
      (mutSrc) => {
        failedAsExpected = /imageUrl:\s*null/.test(stripCommentsAndStrings(mutSrc));
      }
    );
    check('RP2 [REVERT-PROOF] returning { imageUrl: null } on empty is detectable (F1/H9)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      SVC_PATH,
      '  return due[0] || null;',
      '  return due;',
      (mutSrc) => {
        failedAsExpected = !/return due\[0\] \|\| null/.test(mutSrc);
      }
    );
    check('RP3 [REVERT-PROOF] returning the whole due list (not one brand) is detectable (H6)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      SVC_PATH,
      '    return require(\'./apifyIngestService\').syncBrandApify(brand._id, { skipInstagram: true });',
      '    return require(\'./apifyIngestService\').syncBrandApify(brand._id);',
      (mutSrc) => {
        failedAsExpected = !/skipInstagram:\s*true/.test(mutSrc);
      }
    );
    check('RP4 [REVERT-PROOF] dropping skipInstagram on demo dispatch is detectable (H2)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      BRAND_PATH,
      '  lastCatalogResyncAt: { type: Date, default: null },',
      '  // lastCatalogResyncAt dropped',
      (mutSrc) => {
        failedAsExpected = !/lastCatalogResyncAt:\s*\{\s*type:\s*Date,\s*default:\s*null\s*\}/.test(mutSrc);
      }
    );
    check('RP5 [REVERT-PROOF] undeclaring lastCatalogResyncAt fails H1 (strict mode would drop the stamp)',
      failedAsExpected);
  }
}

(async () => {
  try {
    runParsers();
    runDueCheck();
    runMethodResolver();
    runSerialAndSkip();
    runImageUrl();
    await runFlagOffBehavioral();
    runStructural();
    runMutations();
  } catch (err) {
    failures.push(`THREW: ${err && err.stack ? err.stack : err}`);
  } finally {
    restoreEnv();
    try { svc._resetCatalogResyncSpacingForTest(); } catch (_) { /* ignore */ }
  }

  if (failures.length) {
    console.error(`\n❌ scheduled catalog resync: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ scheduled catalog resync: ${pass} checks passed`);
})();
