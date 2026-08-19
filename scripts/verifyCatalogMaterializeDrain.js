#!/usr/bin/env node
'use strict';
/**
 * verifyCatalogMaterializeDrain — fence for the "826 of 831 products
 * unpickable" fix (2026-08-19, Pelagic Gear onboarding QA).
 *
 * Root cause: nothing at ingest time calls materializeMissingHero — the
 * CATALOG_DETECT_PRECOMPUTE deferral (enqueueBrandProductDetects returns
 * `deferred` before it ever materializes anything) means `imageMediaId`
 * stays null on every CatalogProduct row until an operator happens to open
 * THAT one product's own detail page (the pre-existing per-product lazy
 * backfill in routes/catalog.js). services/catalogMaterializeDrainService.js
 * runs the SAME $0 mirror proactively, bounded, resumable, observable,
 * across a whole brand.
 *
 * Asserts:
 *   A. Module shape — the drain calls materializeMissingHero (the $0,
 *      no-DetectRun cost fence), never enqueueProductDetect / a full detect
 *      path, and candidateFilter's query shape is exactly imageMediaId:null
 *      + deletedAt:null + a usable imageUrl.
 *   B. Idempotency — findActiveMaterializeDrain is checked BEFORE a new
 *      OperationRun is created, so a retried/overlapping trigger can never
 *      stack two sweeps over the same brand.
 *   C. Resumability — every pass re-queries the live imageMediaId:null
 *      filter (no persisted offset/cursor to go stale), and the stop
 *      condition is a per-PASS delta (passDone), not a hardcoded iteration
 *      cap that could quit early while real candidates remain.
 *   D. Cost/denominator honesty — known-unusable seeds (bad/missing
 *      imageUrl) are excluded from the candidate count and tallied
 *      separately, and skipped (not billed as a "failed" materialize
 *      attempt) inside the loop.
 *   E. Bounded concurrency — reads CATALOG_MATERIALIZE_CONCURRENCY from
 *      the shared services/concurrency.js knob table, not a literal.
 *   F. Progress — 'catalog-materialize' is a cancellable OperationRun kind
 *      (services/progressService.js), so GET /api/progress/active and
 *      POST /api/progress/:runId/cancel already work for it with no new
 *      route.
 *   G. Route — POST /api/catalog/materialize is registered BEFORE the
 *      generic '/:id' route, tenant-checks the brand, and validates
 *      brandId.
 *   H. Auto-trigger — all four ingest paths (Shopify-direct, generic
 *      sitemap, Apify Shopify, Meta/IG catalog) fire the drain
 *      fire-and-forget (never awaited — ingest must not block on it) once
 *      products actually landed, never unconditionally.
 *
 * Offline: no DB, no network, no API keys.
 *   node scripts/verifyCatalogMaterializeDrain.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const read = (...p) => {
  const f = path.join(ROOT, ...p);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

function functionBody(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  const parenOpen = src.indexOf('(', start);
  if (parenOpen < 0) return '';
  let pdepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { parenClose = i; break; } }
  }
  if (parenClose < 0) return '';
  const open = src.indexOf('{', parenClose);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

const drainSrc    = read('services', 'catalogMaterializeDrainService.js');
const catalogSrc  = read('routes', 'catalog.js');
const progressSrc = read('services', 'progressService.js');
const concSrc     = read('services', 'concurrency.js');
const shopifySrc  = read('services', 'shopifyPublicIngestService.js');
const genericSrc  = read('services', 'genericCatalogIngestService.js');
const apifySrc    = read('services', 'apifyIngestService.js');
const metaSrc     = read('services', 'catalogSyncService.js');
const brandRouteSrc = read('routes', 'brand.js');

console.log('=== catalogMaterializeDrain fence ===\n');

// ── A. Module shape / cost fence ─────────────────────────────────────
console.log('A. Module shape — $0 cost fence');
check('A1 requires materializeMissingHero from catalogProductDetectService',
  /materializeMissingHero\s*}\s*=\s*require\(['"]\.\/catalogProductDetectService['"]\)/.test(drainSrc));
check('A2 does NOT call enqueueProductDetect (would reopen per-product vision spend)',
  !drainSrc.includes('enqueueProductDetect('));
check('A3 does NOT create/require DetectRun (no detect spend rides on this path)',
  !/require\(['"]\.\.\/models\/DetectRun['"]\)/.test(drainSrc) && !drainSrc.includes('DetectRun.create'));
{
  const { candidateFilter } = require(path.join(ROOT, 'services', 'catalogMaterializeDrainService'));
  const f = candidateFilter('BRAND_X');
  check('A4 candidateFilter targets exactly imageMediaId:null + deletedAt:null + usable imageUrl',
    f.brandId === 'BRAND_X' &&
    f.deletedAt === null &&
    f.imageMediaId === null &&
    Array.isArray(f.imageUrl.$nin) && f.imageUrl.$nin.includes(null) && f.imageUrl.$nin.includes(''),
    JSON.stringify(f));
}

// ── B. Idempotency ────────────────────────────────────────────────────
console.log('\nB. Idempotency — no stacked sweeps');
{
  const startFn = functionBody(drainSrc, 'startCatalogMaterializeDrain');
  const idxFind  = startFn.indexOf('findActiveMaterializeDrain(');
  const idxRun   = startFn.indexOf('progressService.startRun(');
  check('B1 startCatalogMaterializeDrain calls findActiveMaterializeDrain', idxFind >= 0);
  check('B2 findActiveMaterializeDrain is checked BEFORE progressService.startRun (order matters — an idempotency check written AFTER the run already exists is not a guard)',
    idxFind >= 0 && idxRun >= 0 && idxFind < idxRun);
  const findFn = functionBody(drainSrc, 'findActiveMaterializeDrain');
  check('B3 findActiveMaterializeDrain scopes by kind:"catalog-materialize" AND running/cancelling status (not just brandId)',
    findFn.includes("kind: 'catalog-materialize'") && /status:\s*{\s*\$in:\s*\[['"]running['"],\s*['"]cancelling['"]\]/.test(findFn));
}

// ── C. Resumability ───────────────────────────────────────────────────
console.log('\nC. Resumability — no persisted cursor, per-pass stop condition');
{
  const loopFn = functionBody(drainSrc, 'drainLoop');
  check('C1 drainLoop re-queries candidateFilter fresh every pass (CatalogProduct.find(candidateFilter(',
    loopFn.includes('CatalogProduct.find(candidateFilter(brandId))'));
  check('C2 stop condition is a per-PASS delta (passDone), not a hardcoded max-iterations cap',
    loopFn.includes('let passDone = 0') && loopFn.includes('if (passDone === 0) break'));
  check('C3 checkpoint() is awaited inside the loop (cooperative cancel mid-sweep, not just at the top)',
    (loopFn.match(/await handle\.checkpoint\(\)/g) || []).length >= 2);
  check('C4 a CancelledError leaves partial progress intact (no rollback / no delete of already-materialized rows)',
    loopFn.includes("err.code === 'CANCELLED'") && !/CatalogProduct\.(deleteMany|updateMany)\(/.test(functionBody(drainSrc, 'drainLoop')));
}

// ── D. Cost/denominator honesty ───────────────────────────────────────
console.log('\nD. Excluded-unusable accounting — never billed as failed, never in the denominator');
{
  const countFn = functionBody(drainSrc, 'countMaterializeCandidates');
  check('D1 countMaterializeCandidates splits candidates vs excludedUnusable via isUnusableThumbnailUrl',
    countFn.includes('isUnusableThumbnailUrl(') && countFn.includes('excludedUnusable++') && countFn.includes('candidates++'));
  const loopFn = functionBody(drainSrc, 'drainLoop');
  check('D2 drainLoop skips a known-unusable seed BEFORE calling materializeMissingHero (never spends a Cloudinary attempt on it)',
    (() => {
      const skipIdx = loopFn.indexOf('skippedUnusable++');
      const callIdx = loopFn.indexOf('materializeMissingHero(');
      return skipIdx >= 0 && callIdx >= 0 && skipIdx < callIdx;
    })());
  check('D3 a skipped-unusable row increments skippedUnusable, NOT failed',
    /if \(isUnusableThumbnailUrl\(product\.imageUrl\)\) {\s*skippedUnusable\+\+;\s*continue;/.test(loopFn));
}

// ── E. Bounded concurrency ────────────────────────────────────────────
console.log('\nE. Bounded concurrency — shared knob table, not a literal');
check('E1 concurrency.js declares CATALOG_MATERIALIZE_CONCURRENCY',
  /CATALOG_MATERIALIZE_CONCURRENCY:\s*{/.test(concSrc));
check('E2 CATALOG_MATERIALIZE_CONCURRENCY is SELF-IMPOSED (tunable, not a hard provider ceiling misrepresented as ours)',
  /CATALOG_MATERIALIZE_CONCURRENCY:\s*{[^}]*ceiling:\s*'SELF-IMPOSED'/.test(concSrc));
check('E3 drainLoop reads concurrency from CONC.CATALOG_MATERIALIZE_CONCURRENCY, not a hardcoded number',
  functionBody(drainSrc, 'drainLoop').includes('CONC.CATALOG_MATERIALIZE_CONCURRENCY'));
check('E4 config/defaults.env sets a default (env is the source of non-secret defaults per CLAUDE.md §4a)',
  /^CATALOG_MATERIALIZE_CONCURRENCY=\d+$/m.test(read('config', 'defaults.env')));

// ── F. Progress surface reuse ─────────────────────────────────────────
console.log('\nF. Progress — reuses the existing generic surface, no new route needed');
check("F1 'catalog-materialize' is a CANCELLABLE_KINDS entry in progressService.js",
  /CANCELLABLE_KINDS\s*=\s*new Set\(\[[^\]]*'catalog-materialize'/s.test(progressSrc));
check('F2 drain uses progressService.startRun (the shared OperationRun lifecycle), not a bespoke progress model',
  drainSrc.includes('progressService.startRun('));

// ── G. Route ───────────────────────────────────────────────────────────
console.log('\nG. POST /api/catalog/materialize');
{
  const idxMaterialize = catalogSrc.indexOf("router.post('/materialize'");
  const idxIdRoute     = catalogSrc.indexOf("router.get('/:id'");
  check('G1 POST /materialize is registered', idxMaterialize >= 0);
  check('G2 POST /materialize is registered BEFORE the generic GET /:id catch-all (Express matches registration order)',
    idxMaterialize >= 0 && idxIdRoute >= 0 && idxMaterialize < idxIdRoute);
  const routeFn = catalogSrc.slice(idxMaterialize, catalogSrc.indexOf("router.get('/ads-summary'"));
  check('G3 validates brandId is present and a valid ObjectId before doing anything',
    routeFn.includes('brandId is required') && routeFn.includes('mongoose.isValidObjectId(brandId)'));
  check('G4 tenant-checks the brand via tenantFilter before starting a drain (no cross-tenant trigger)',
    routeFn.includes('tenantFilter(req, { _id: brandId })'));
  check('G5 calls startCatalogMaterializeDrain (not a re-implemented inline sweep)',
    routeFn.includes('startCatalogMaterializeDrain('));
}

// ── H. Auto-trigger at ingest completion (all four paths) ────────────
console.log('\nH. Auto-trigger — fire-and-forget on every ingest path, gated on real upserts');
function checkIngestHook(label, src, gateNeedle) {
  const idx = src.indexOf('startCatalogMaterializeDrain(');
  check(`${label}: calls startCatalogMaterializeDrain`, idx >= 0);
  if (idx < 0) return;
  const windowBefore = src.slice(Math.max(0, idx - 400), idx);
  const windowAfter  = src.slice(idx, idx + 200);
  check(`${label}: gated on "${gateNeedle}" (never fires on a zero-product/failed sync)`,
    windowBefore.includes(gateNeedle));
  check(`${label}: NOT awaited (ingest must not block on the materialize sweep)`,
    !/await\s+require\([^)]*catalogMaterializeDrainService[^)]*\)\s*\n?\s*\.startCatalogMaterializeDrain/.test(src.slice(Math.max(0, idx - 60), idx + 40)));
  check(`${label}: has a .catch( so a rejected drain-start can't become an unhandled rejection`,
    windowAfter.includes('.catch('));
}
checkIngestHook('H1 shopifyPublicIngestService (Shopify-direct)', shopifySrc, 'productsUpserted > 0');
checkIngestHook('H2 genericCatalogIngestService (generic sitemap)', genericSrc, 'productsUpserted > 0');
checkIngestHook('H3 apifyIngestService (Apify Shopify)', apifySrc, 'summary.added + summary.updated');
checkIngestHook('H4 catalogSyncService (Meta / IG catalog)', metaSrc, 'added + updated');

// ── I. Onboarding-status surface (operator-visible progress) ─────────
console.log('\nI. GET /api/brand/:id/onboarding-status exposes catalogMaterialize');
{
  const idx = brandRouteSrc.indexOf("router.get('/:id/onboarding-status'");
  check('I1 onboarding-status route exists', idx >= 0);
  const routeFn = brandRouteSrc.slice(idx, brandRouteSrc.indexOf('module.exports', idx) > idx
    ? Math.min(idx + 6000, brandRouteSrc.length) : brandRouteSrc.length);
  check('I2 calls countMaterializeCandidates + findActiveMaterializeDrain (reuses the drain service, no re-implemented count query)',
    routeFn.includes('countMaterializeCandidates') && routeFn.includes('findActiveMaterializeDrain'));
  check('I3 response includes a catalogMaterialize field with ready/pending/excludedUnusable/running',
    routeFn.includes('ready, pending, excludedUnusable') && routeFn.includes('running: !!activeRun'));
  check('I4 a bucket-computation failure does not 500 the whole endpoint (try/catch, catalogMaterialize left null)',
    /let catalogMaterialize = null;[\s\S]{0,900}catch \(err\) {/.test(routeFn));
}

console.log(`\n${pass} pass / ${failures.length} fail`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
