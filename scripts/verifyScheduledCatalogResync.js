#!/usr/bin/env node
'use strict';
/**
 * verifyScheduledCatalogResync — nightly uncapped all-brands catalog re-sync.
 *
 *   A. Flag parser === 'true' + file default true; nightly knobs.
 *   B. Nightly hour / window / concurrency parsers (blank/garbage → shipped default).
 *   C. Due-check is per-window: last < windowStart → due; last >= start → skip.
 *   D. Each non-IG method has a resolver arm (shopify-direct, generic,
 *      apify) plus demo brands reuse resolveCatalogMethod.
 *   E. Multi-brand: selectDueCatalogResyncCandidates returns ALL due,
 *      oldest first; in-window / out-of-window; DST boundaries.
 *   F. imageUrl null-heal / no-clobber (catalogImageUrlGuard).
 *   G. Behavioral: flag-off and outside-window are no-ops (no Brand.find).
 *   H. Structural: lastCatalogResyncAt; skipInstagram+uncapped on demo
 *      dispatch; all-brands pool; persist-cap override wiring.
 *   I. Uncapped override actually uncaps and does not leak to other callers.
 *   RP. Mutation-prove the load-bearing (money) pins.
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
const INGEST_LIMITS_PATH = path.join(ROOT, 'services/ingestLimits.js');
const SHOPIFY_PATH = path.join(ROOT, 'services/shopifyPublicIngestService.js');
const GENERIC_PATH = path.join(ROOT, 'services/genericCatalogIngestService.js');
const APIFY_PATH = path.join(ROOT, 'services/apifyIngestService.js');
const CATALOG_SYNC_PATH = path.join(ROOT, 'services/catalogSyncService.js');

const ORIG = {
  enabled: process.env.CATALOG_SCHEDULED_RESYNC_ENABLED,
  hour: process.env.CATALOG_NIGHTLY_HOUR,
  windowH: process.env.CATALOG_NIGHTLY_WINDOW_H,
  concurrency: process.env.CATALOG_NIGHTLY_CONCURRENCY,
  ingestLimit: process.env.CATALOG_INGEST_LIMIT,
};

function restoreEnv() {
  for (const [key, val] of [
    ['CATALOG_SCHEDULED_RESYNC_ENABLED', ORIG.enabled],
    ['CATALOG_NIGHTLY_HOUR', ORIG.hour],
    ['CATALOG_NIGHTLY_WINDOW_H', ORIG.windowH],
    ['CATALOG_NIGHTLY_CONCURRENCY', ORIG.concurrency],
    ['CATALOG_INGEST_LIMIT', ORIG.ingestLimit],
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
process.env.CATALOG_NIGHTLY_HOUR = '2';
process.env.CATALOG_NIGHTLY_WINDOW_H = '8';
process.env.CATALOG_NIGHTLY_CONCURRENCY = '3';

const svc = require('../services/scheduledSyncService');
const { catalogIngestLimit } = require('../services/ingestLimits');
const { imageUrlPatch, assignImageUrl } = require('../services/catalogImageUrlGuard');

const HOUR = 3600 * 1000;
const WINDOW_MS = 8 * HOUR;

function runParsers() {
  const envSrc = fs.readFileSync(DEFAULTS_ENV, 'utf8');
  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');

  check('A1 CATALOG_SCHEDULED_RESYNC_ENABLED=true in defaults.env',
    /^CATALOG_SCHEDULED_RESYNC_ENABLED=true$/m.test(envSrc));
  check('A2 CATALOG_NIGHTLY_HOUR=2 in defaults.env',
    /^CATALOG_NIGHTLY_HOUR=2$/m.test(envSrc));
  check('A3 CATALOG_NIGHTLY_WINDOW_H=8 in defaults.env',
    /^CATALOG_NIGHTLY_WINDOW_H=8$/m.test(envSrc));
  check('A3b CATALOG_NIGHTLY_CONCURRENCY=3 in defaults.env',
    /^CATALOG_NIGHTLY_CONCURRENCY=3$/m.test(envSrc));
  check('A4 parser is strictly === \'true\'',
    /process\.env\.CATALOG_SCHEDULED_RESYNC_ENABLED === 'true'/.test(svcSrc));
  check('A4b TZ is America/Los_Angeles (IANA, not a UTC offset)',
    /America\/Los_Angeles/.test(svcSrc) && svc.NIGHTLY_TZ === 'America/Los_Angeles');

  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'true';
  check('A5 === true → enabled', svc.isCatalogScheduledResyncEnabled() === true);
  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'TRUE';
  check('A6 TRUE → disabled (strict parser)', svc.isCatalogScheduledResyncEnabled() === false);
  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'false';
  check('A7 false → disabled', svc.isCatalogScheduledResyncEnabled() === false);
  delete process.env.CATALOG_SCHEDULED_RESYNC_ENABLED;
  check('A8 unset → disabled', svc.isCatalogScheduledResyncEnabled() === false);
  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'true';
}

function runNightlyParsers() {
  process.env.CATALOG_NIGHTLY_HOUR = '2';
  check('B1 hour 2 → 2', svc.catalogNightlyHour() === 2);
  process.env.CATALOG_NIGHTLY_HOUR = '0';
  check('B2 hour 0 (midnight) is valid', svc.catalogNightlyHour() === 0);
  process.env.CATALOG_NIGHTLY_HOUR = '24';
  check('B3 hour 24 → default 2', svc.catalogNightlyHour() === 2);
  process.env.CATALOG_NIGHTLY_HOUR = '-1';
  check('B4 hour negative → default 2', svc.catalogNightlyHour() === 2);
  process.env.CATALOG_NIGHTLY_HOUR = '2.5';
  check('B5 hour fractional → default 2', svc.catalogNightlyHour() === 2);
  delete process.env.CATALOG_NIGHTLY_HOUR;
  check('B6 hour unset → default 2', svc.catalogNightlyHour() === 2);
  process.env.CATALOG_NIGHTLY_HOUR = '';
  check('B6b hour blank → default 2 (not midnight)', svc.catalogNightlyHour() === 2);
  process.env.CATALOG_NIGHTLY_HOUR = '2';

  process.env.CATALOG_NIGHTLY_WINDOW_H = '8';
  check('B7 window 8h → 8 hours in ms', svc.catalogNightlyWindowMs() === 8 * HOUR);
  process.env.CATALOG_NIGHTLY_WINDOW_H = '0';
  check('B8 window 0 → default 8h', svc.catalogNightlyWindowMs() === 8 * HOUR);
  process.env.CATALOG_NIGHTLY_WINDOW_H = '-3';
  check('B9 window negative → default 8h', svc.catalogNightlyWindowMs() === 8 * HOUR);
  process.env.CATALOG_NIGHTLY_WINDOW_H = '30';
  check('B10 window >24 → clamp 24h', svc.catalogNightlyWindowMs() === 24 * HOUR);
  delete process.env.CATALOG_NIGHTLY_WINDOW_H;
  check('B11 window unset → default 8h', svc.catalogNightlyWindowMs() === 8 * HOUR);
  process.env.CATALOG_NIGHTLY_WINDOW_H = '8';

  process.env.CATALOG_NIGHTLY_CONCURRENCY = '3';
  check('B12 concurrency 3 → 3', svc.catalogNightlyConcurrency() === 3);
  process.env.CATALOG_NIGHTLY_CONCURRENCY = '1';
  check('B13 concurrency 1 is valid', svc.catalogNightlyConcurrency() === 1);
  process.env.CATALOG_NIGHTLY_CONCURRENCY = '0';
  check('B14 concurrency 0 → default 3', svc.catalogNightlyConcurrency() === 3);
  process.env.CATALOG_NIGHTLY_CONCURRENCY = '99';
  check('B15 concurrency 99 → ceiling 8', svc.catalogNightlyConcurrency() === 8);
  delete process.env.CATALOG_NIGHTLY_CONCURRENCY;
  check('B16 concurrency unset → default 3', svc.catalogNightlyConcurrency() === 3);
  process.env.CATALOG_NIGHTLY_CONCURRENCY = '3';
}

function runPacificWindow() {
  // PST: 2026-01-15 02:00 = 10:00Z. Window 8h → 10:00Z–18:00Z.
  const jan2am = Date.UTC(2026, 0, 15, 10, 0, 0);
  check('C-TZ1 Jan 15 2am PST window start is 10:00Z',
    svc.zonedUtcMs('America/Los_Angeles', 2026, 1, 15, 2) === jan2am);
  check('C-TZ2 Jan 15 10:00Z is in window',
    svc.isInCatalogNightlyWindow(jan2am, { windowMs: WINDOW_MS }) === true);
  check('C-TZ3 Jan 15 09:59Z (1:59am PST) is NOT in window',
    svc.isInCatalogNightlyWindow(jan2am - 1000, { windowMs: WINDOW_MS }) === false);
  check('C-TZ4 Jan 15 17:59Z (9:59am PST) is in window',
    svc.isInCatalogNightlyWindow(jan2am + 8 * HOUR - 1000, { windowMs: WINDOW_MS }) === true);
  check('C-TZ5 Jan 15 18:00Z (10:00am PST) is NOT in window',
    svc.isInCatalogNightlyWindow(jan2am + 8 * HOUR, { windowMs: WINDOW_MS }) === false);
  check('C-TZ6 Jan 15 window start at 5am PST is still today 2am',
    svc.currentNightlyWindowStartMs(jan2am + 3 * HOUR) === jan2am);

  // PDT: 2026-07-15 02:00 = 09:00Z.
  const jul2am = Date.UTC(2026, 6, 15, 9, 0, 0);
  check('C-TZ7 Jul 15 2am PDT window start is 09:00Z',
    svc.zonedUtcMs('America/Los_Angeles', 2026, 7, 15, 2) === jul2am);
  check('C-TZ8 Jul 15 09:00Z is in window',
    svc.isInCatalogNightlyWindow(jul2am, { windowMs: WINDOW_MS }) === true);
  check('C-TZ9 Jul 15 08:59Z is NOT in window',
    svc.isInCatalogNightlyWindow(jul2am - 1000, { windowMs: WINDOW_MS }) === false);

  // Spring-forward 2026-03-08: 2:00 AM Pacific is skipped (01:59 PST → 03:00 PDT).
  // Requesting 02:00 lands on 03:00 PDT = 10:00Z — first valid instant ≥ 2am.
  const marStart = Date.UTC(2026, 2, 8, 10, 0, 0);
  check('C-DST-spring: 2am on 2026-03-08 maps to 03:00 PDT (10:00Z)',
    svc.zonedUtcMs('America/Los_Angeles', 2026, 3, 8, 2) === marStart);
  check('C-DST-spring: 09:59Z (1:59am PST) is NOT in the new window',
    svc.isInCatalogNightlyWindow(marStart - 1000, { windowMs: WINDOW_MS }) === false);
  check('C-DST-spring: 10:00Z (3:00am PDT) IS in window',
    svc.isInCatalogNightlyWindow(marStart, { windowMs: WINDOW_MS }) === true);
  const marParts = svc.pacificParts(new Date(marStart));
  check('C-DST-spring: wall clock at window start is hour=3 (skipped 2)',
    marParts.hour === 3 && marParts.day === 8 && marParts.month === 3);

  // Fall-back 2026-11-01: 2:00 AM exists once (PST) = 10:00Z.
  const novStart = Date.UTC(2026, 10, 1, 10, 0, 0);
  check('C-DST-fall: 2am on 2026-11-01 is 10:00Z (PST, unique)',
    svc.zonedUtcMs('America/Los_Angeles', 2026, 11, 1, 2) === novStart);
  check('C-DST-fall: 09:59Z is NOT in window',
    svc.isInCatalogNightlyWindow(novStart - 1000, { windowMs: WINDOW_MS }) === false);
  check('C-DST-fall: 10:00Z IS in window',
    svc.isInCatalogNightlyWindow(novStart, { windowMs: WINDOW_MS }) === true);
}

function runDueCheck() {
  const windowStart = Date.UTC(2026, 0, 15, 10, 0, 0); // 2am PST
  const now = windowStart + 3 * HOUR; // 5am PST, in window
  check('C1 null lastCatalogResyncAt → due',
    svc.isCatalogResyncDue({ lastCatalogResyncAt: null }, now, windowStart) === true);
  check('C2 missing field → due',
    svc.isCatalogResyncDue({}, now, windowStart) === true);
  check('C3 stamped this window (1h after start) → not due',
    svc.isCatalogResyncDue({ lastCatalogResyncAt: new Date(windowStart + HOUR) }, now, windowStart) === false);
  check('C4 stamped before this window (25h ago) → due',
    svc.isCatalogResyncDue({ lastCatalogResyncAt: new Date(windowStart - HOUR) }, now, windowStart) === true);
  check('C5 stamped exactly at window start → not due (already swept)',
    svc.isCatalogResyncDue({ lastCatalogResyncAt: new Date(windowStart) }, now, windowStart) === false);
  check('C6 null brand → not due',
    svc.isCatalogResyncDue(null, now, windowStart) === false);
  check('C7 restart mid-window: last just before now but after start → skip (no re-trigger)',
    svc.isCatalogResyncDue({ lastCatalogResyncAt: new Date(now - 60 * 1000) }, now, windowStart) === false);
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

function runMultiBrand() {
  const windowStart = Date.UTC(2026, 0, 15, 10, 0, 0);
  const now = windowStart + 3 * HOUR;
  const a = {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    lastCatalogResyncAt: new Date(windowStart - 48 * HOUR),
    websiteUrl: 'https://a.example.com',
  };
  const b = {
    _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    lastCatalogResyncAt: new Date(windowStart - 36 * HOUR),
    websiteUrl: 'https://b.example.com',
  };
  const alreadySwept = {
    _id: 'cccccccccccccccccccccccc',
    lastCatalogResyncAt: new Date(windowStart + HOUR),
    websiteUrl: 'https://c.example.com',
  };
  const sources = new Map([
    [String(a._id), new Set(['shopify-direct'])],
    [String(b._id), new Set(['sitemap-jsonld'])],
    [String(alreadySwept._id), new Set(['shopify-direct'])],
  ]);
  const due = svc.selectDueCatalogResyncCandidates([a, b, alreadySwept], sources, now, windowStart);
  check('E1 multi: two due brands (not one)', due.length === 2,
    `got ${due.length}`);
  check('E2 oldest lastCatalogResyncAt first (a then b)',
    due.length === 2
      && String(due[0].brand._id) === String(a._id)
      && String(due[1].brand._id) === String(b._id)
      && due[0].method === 'shopify-direct'
      && due[1].method === 'generic-sitemap');
  check('E3 already-swept this window is excluded',
    !due.some((d) => String(d.brand._id) === String(alreadySwept._id)));

  const noMethod = { _id: 'dddddddddddddddddddddddd', lastCatalogResyncAt: null };
  check('E4 due but no catalog method → empty list',
    svc.selectDueCatalogResyncCandidates([noMethod], new Map(), now, windowStart).length === 0);

  check('E5 concurrency default is 3 (more than one brand per tick)',
    svc.DEFAULT_NIGHTLY_CONCURRENCY === 3 && svc.catalogNightlyConcurrency() === 3);
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

async function runFlagAndWindowBehavioral() {
  const Brand = require('../models/Brand');
  const origFind = Brand.find;
  let findCalls = 0;
  Brand.find = function catalogResyncMustNotQuery() {
    findCalls += 1;
    throw new Error('Brand.find must not run when gated off');
  };

  process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'false';
  try {
    const summary = { errors: [] };
    const out = await svc.runDueCatalogResyncs(summary, Date.UTC(2026, 0, 15, 10, 0, 0));
    check('G1 flag-off runDueCatalogResyncs is a no-op (no Brand.find)',
      findCalls === 0 && out === summary && !out.catalogsResynced);
  } catch (err) {
    check('G1 flag-off runDueCatalogResyncs is a no-op (no Brand.find)',
      false, err.message);
  } finally {
    process.env.CATALOG_SCHEDULED_RESYNC_ENABLED = 'true';
  }

  findCalls = 0;
  try {
    // 1:00 PM Pacific Jan 15 2026 = 21:00Z — outside the 2am–10am window.
    const summary = { errors: [] };
    const out = await svc.runDueCatalogResyncs(summary, Date.UTC(2026, 0, 15, 21, 0, 0));
    check('G2 outside nightly window is a no-op (no Brand.find)',
      findCalls === 0 && out === summary && !out.catalogsResynced);
  } catch (err) {
    check('G2 outside nightly window is a no-op (no Brand.find)',
      false, err.message);
  } finally {
    Brand.find = origFind;
  }
}

function runUncappedOverride() {
  const prior = process.env.CATALOG_INGEST_LIMIT;
  try {
    process.env.CATALOG_INGEST_LIMIT = '10';
    check('I1 catalogIngestLimit() with no opts still returns env 10',
      catalogIngestLimit() === 10);
    check('I2 catalogIngestLimit({uncapped:true}) returns null (no persist cap)',
      catalogIngestLimit({ uncapped: true }) === null);
    check('I3 catalogIngestLimit({uncapped:false}) still 10',
      catalogIngestLimit({ uncapped: false }) === 10);
    check('I4 catalogIngestLimit({uncapped:\'true\'}) does NOT uncap',
      catalogIngestLimit({ uncapped: 'true' }) === 10);
  } finally {
    if (prior === undefined) delete process.env.CATALOG_INGEST_LIMIT;
    else process.env.CATALOG_INGEST_LIMIT = prior;
  }

  const shopifySrc = fs.readFileSync(SHOPIFY_PATH, 'utf8');
  const genericSrc = fs.readFileSync(GENERIC_PATH, 'utf8');
  const apifySrc = fs.readFileSync(APIFY_PATH, 'utf8');
  const catalogSyncSrc = fs.readFileSync(CATALOG_SYNC_PATH, 'utf8');
  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');

  check('I5 shopify-direct persist cap honors uncapped override',
    /catalogIngestLimit\(\s*\{\s*uncapped:\s*uncappedRun\s*\}\s*\)/.test(shopifySrc));
  check('I6 generic persist cap honors uncapped override',
    /catalogIngestLimit\(\s*\{\s*uncapped:\s*uncappedRun\s*\}\s*\)/.test(genericSrc));
  check('I7 apify-shopify persist cap honors uncapped override',
    /catalogIngestLimit\(\s*\{\s*uncapped:\s*uncapped\s*===\s*true\s*\}\s*\)/.test(apifySrc));
  check('I8 IG catalogSyncService still calls catalogIngestLimit() with no override',
    /catalogIngestLimit\(\s*\)/.test(catalogSyncSrc)
      && !/catalogIngestLimit\(\s*\{/.test(catalogSyncSrc));
  check('I9 dispatch passes uncapped:true to syncBrandApify with skipInstagram',
    /syncBrandApify\(\s*brand\._id\s*,\s*\{\s*skipInstagram:\s*true\s*,\s*uncapped:\s*true\s*\}\s*\)/.test(svcSrc));
  check('I10 dispatch passes uncapped:true to generic + shopify-direct',
    /syncBrandGenericCatalog\([\s\S]{0,220}?uncapped:\s*true/.test(svcSrc)
      && /syncBrandShopifyDirect\([\s\S]{0,220}?uncapped:\s*true/.test(svcSrc));
  check('I11 apify forwards uncapped onto nested generic/shopify-direct/apify-shopify',
    /syncBrandGenericCatalog\(brand,\s*run,\s*\{\s*isBrandAborted,\s*uncapped:\s*uncapped\s*===\s*true\s*\}\)/.test(apifySrc)
      && /syncBrandShopifyDirect\(brand,\s*run,\s*\{\s*isBrandAborted,\s*uncapped:\s*uncapped\s*===\s*true\s*\}\)/.test(apifySrc)
      && /syncBrandShopify\(brand,\s*run,\s*\{\s*uncapped:\s*uncapped\s*===\s*true\s*\}\)/.test(apifySrc));
}

function runStructural() {
  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');
  const brandSrc = fs.readFileSync(BRAND_PATH, 'utf8');
  const guardSrc = fs.readFileSync(GUARD_PATH, 'utf8');
  const code = stripCommentsAndStrings(svcSrc);

  check('H1 Brand schema declares lastCatalogResyncAt',
    /lastCatalogResyncAt:\s*\{\s*type:\s*Date,\s*default:\s*null\s*\}/.test(brandSrc));
  check('H2 demo dispatch passes skipInstagram: true AND uncapped: true',
    /syncBrandApify\(\s*brand\._id\s*,\s*\{\s*skipInstagram:\s*true\s*,\s*uncapped:\s*true\s*\}\s*\)/.test(svcSrc));
  check('H3 IG loop still queries type:\'instagram\'',
    /type:\s*'instagram'/.test(svcSrc));
  check('H4 flag-off gate is first statement of runDueCatalogResyncs',
    /async function runDueCatalogResyncs[\s\S]{0,200}if\s*\(\s*!isCatalogScheduledResyncEnabled\(\)\s*\)\s*return/.test(svcSrc));
  check('H5 in-progress kinds are catalog-sync + demo-sync',
    Array.isArray(svc.CATALOG_RESYNC_IN_PROGRESS_KINDS)
      && svc.CATALOG_RESYNC_IN_PROGRESS_KINDS.includes('catalog-sync')
      && svc.CATALOG_RESYNC_IN_PROGRESS_KINDS.includes('demo-sync'));
  check('H6 candidates helper returns the full due list (not due[0])',
    /function selectDueCatalogResyncCandidates[\s\S]*?return due;/.test(svcSrc)
      && !/return due\[0\] \|\| null/.test(svcSrc));
  check('H7 nightly window gate sits before Brand.find',
    /if\s*\(\s*!isInCatalogNightlyWindow\(\s*now\s*\)\s*\)\s*return/.test(svcSrc));
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
    /hasCatalogSyncInProgress\(picked\.brand\._id\)/.test(svcSrc)
      && svcSrc.indexOf('hasCatalogSyncInProgress') < svcSrc.indexOf('dispatchCatalogResync(hydrated'));
  check('H15 in-progress query uses running/cancelling',
    /status:\s*\{\s*\$in:\s*\['running',\s*'cancelling'\]\s*\}/.test(svcSrc)
      || /status:\s*\{\s*\$in:\s*\[\s*'running'\s*,\s*'cancelling'\s*\]/.test(svcSrc));
  check('H16 all-brands pool: runDueCatalogResyncs Brand.find is unfiltered',
    /Brand\.find\(\s*\{\s*\}\s*\)/.test(svcSrc));
  {
    const fn = stripCommentsAndStrings(svcSrc).match(/async function runDueCatalogResyncs[\s\S]*?const AD_PLATFORMS/);
    check('H17 all-brands pool does not re-gate on autoSyncEnabled / isDemo',
      !!fn && !/autoSyncEnabled/.test(fn[0]) && !/isDemo:\s*true/.test(fn[0]));
  }
  check('H18 IG auto-sync Brand.find still keys on autoSyncEnabled',
    /Brand\.find\(\s*\{\s*'syncSettings\.autoSyncEnabled':\s*true\s*\}\s*\)/.test(svcSrc));
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
      '    return require(\'./apifyIngestService\').syncBrandApify(brand._id, { skipInstagram: true, uncapped: true });',
      '    return require(\'./apifyIngestService\').syncBrandApify(brand._id);',
      (mutSrc) => {
        failedAsExpected = !/skipInstagram:\s*true/.test(mutSrc);
      }
    );
    check('RP3 [REVERT-PROOF] dropping skipInstagram on demo dispatch is detectable (H2)',
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
    check('RP4 [REVERT-PROOF] undeclaring lastCatalogResyncAt fails H1 (strict mode would drop the stamp)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      INGEST_LIMITS_PATH,
      '  if (opts && typeof opts === \'object\' && opts.uncapped === true) return null;',
      '  if (opts && typeof opts === \'object\' && opts.uncapped === true) return readLimit(\'CATALOG_INGEST_LIMIT\');',
      (mutSrc) => {
        failedAsExpected = !/opts\.uncapped === true\) return null/.test(mutSrc);
      }
    );
    check('RP5 [REVERT-PROOF] ignoring uncapped (still reading env) is detectable (I2)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      SVC_PATH,
      '    return require(\'./apifyIngestService\').syncBrandApify(brand._id, { skipInstagram: true, uncapped: true });',
      '    return require(\'./apifyIngestService\').syncBrandApify(brand._id, { skipInstagram: true });',
      (mutSrc) => {
        failedAsExpected = !/skipInstagram:\s*true\s*,\s*uncapped:\s*true/.test(mutSrc);
      }
    );
    check('RP6 [REVERT-PROOF] dropping uncapped:true on demo dispatch is detectable (I9)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      SHOPIFY_PATH,
      '  const ingestCap = catalogIngestLimit({ uncapped: uncappedRun });',
      '  const ingestCap = catalogIngestLimit();',
      (mutSrc) => {
        failedAsExpected = !/catalogIngestLimit\(\s*\{\s*uncapped:\s*uncappedRun\s*\}\s*\)/.test(mutSrc);
      }
    );
    check('RP7 [REVERT-PROOF] shopify-direct calling catalogIngestLimit() without override is detectable (I5)',
      failedAsExpected);
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      SVC_PATH,
      "  const brands = await Brand.find({})",
      "  const brands = await Brand.find({ $or: [{ 'syncSettings.autoSyncEnabled': true }, { isDemo: true }] })",
      (mutSrc) => {
        failedAsExpected = !/Brand\.find\(\s*\{\s*\}\s*\)/.test(mutSrc);
      }
    );
    check('RP8 [REVERT-PROOF] restoring autoSyncEnabled/isDemo brand-pool gate is detectable (H16)',
      failedAsExpected);
  }
}

(async () => {
  try {
    runParsers();
    runNightlyParsers();
    runPacificWindow();
    runDueCheck();
    runMethodResolver();
    runMultiBrand();
    runImageUrl();
    await runFlagAndWindowBehavioral();
    runUncappedOverride();
    runStructural();
    runMutations();
  } catch (err) {
    failures.push(`THREW: ${err && err.stack ? err.stack : err}`);
  } finally {
    restoreEnv();
  }

  if (failures.length) {
    console.error(`\n❌ scheduled catalog resync: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ scheduled catalog resync: ${pass} checks passed`);
})();
