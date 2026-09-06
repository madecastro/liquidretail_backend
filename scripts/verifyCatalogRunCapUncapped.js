// Pins that catalog enrichment + YOLO-detect + materialize per-run
// ceilings default to uncapped (owner 2026-09-05). A live catalog had
// 787 review-less CatalogProduct rows sitting behind
// CATALOG_ENRICHMENT_MAX_PER_RUN=500.
//
// Scope is the three per-run product-count ceilings:
//   CATALOG_ENRICHMENT_MAX_PER_RUN  (catalogProductEnrichmentService)
//   CATALOG_YOLO_MAX_PER_RUN        (catalogYoloDetectionService AND
//                                    catalogMediaMaterializeService —
//                                    same env, same parser, so the two
//                                    peer post-sync phases cannot disagree)
// CATALOG_YOLO_ALT_LIMIT, CATALOG_INGEST_LIMIT, and the CONCURRENCY
// knobs are a different kind of bound and must stay untouched.
//
// Offline: no Mongo, no HTTP. Exercises the exported parse/apply helpers
// plus a source scan so a silent return of `slice(0, 500)` fails.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RESULTS = { pass: 0, fail: 0 };
function pass(id, msg) { RESULTS.pass++; console.log(`✓  ${id.padEnd(6)} ${msg}`); }
function fail(id, msg) { RESULTS.fail++; console.log(`✗  ${id.padEnd(6)} ${msg}`); }

function check(id, fn) {
  try { fn(); pass(id, fn._label || id); }
  catch (e) { fail(id, e.message); }
}

function readFile(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const enrich = require('../services/catalogProductEnrichmentService');
const yolo = require('../services/catalogYoloDetectionService');
const materialize = require('../services/catalogMediaMaterializeService');

const SVCS = [
  ['enrichment', enrich],
  ['yolo', yolo],
  ['materialize', materialize]
];

const BIG = Array.from({ length: 600 }, (_, i) => i);
const UNSET_CASES = [undefined, null, '', '0', '-1', 'unlimited', 'nope'];

// ── A: parser default is genuinely uncapped ──
for (const [svcName, svc] of SVCS) {
  if (typeof svc.parseMaxPerRun !== 'function') {
    fail(`A0-${svcName}`, `${svcName}.parseMaxPerRun not exported`);
    continue;
  }
  if (typeof svc.applyRunCap !== 'function') {
    fail(`A0b-${svcName}`, `${svcName}.applyRunCap not exported`);
    continue;
  }
  for (const raw of UNSET_CASES) {
    check(`A1-${svcName}-${String(raw)}`, () => {
      assert.strictEqual(svc.parseMaxPerRun(raw), Infinity,
        `${svcName}.parseMaxPerRun(${JSON.stringify(raw)}) must be Infinity (uncapped), got ${svc.parseMaxPerRun(raw)}`);
    });
  }
  check(`A2-${svcName}-positive`, () => {
    assert.strictEqual(svc.parseMaxPerRun('500'), 500);
    assert.strictEqual(svc.parseMaxPerRun('12'), 12);
  });
}

// ── B: a 600-row candidate list is NOT truncated at the default ──
for (const [svcName, svc] of SVCS) {
  if (typeof svc.applyRunCap !== 'function' || typeof svc.parseMaxPerRun !== 'function') continue;
  check(`B1-${svcName}-uncapped-keeps-600`, () => {
    const cap = svc.parseMaxPerRun(undefined);
    const out = svc.applyRunCap(BIG, cap);
    assert.strictEqual(out.length, 600,
      `${svcName} truncated ${BIG.length} candidates to ${out.length} under the default (must keep all 600, not 500)`);
    assert.strictEqual(out[599], 599);
  });
  check(`B2-${svcName}-zero-keeps-600`, () => {
    const out = svc.applyRunCap(BIG, svc.parseMaxPerRun('0'));
    assert.strictEqual(out.length, 600,
      `${svcName} with env=0 must stay uncapped; got length ${out.length}`);
  });
  check(`B3-${svcName}-positive-still-caps`, () => {
    const out = svc.applyRunCap(BIG, svc.parseMaxPerRun('500'));
    assert.strictEqual(out.length, 500,
      `${svcName} must still honour a positive CATALOG_*_MAX_PER_RUN override`);
  });
}

// ── C: defaults.env file default is 0, not 500 ──
{
  const envSrc = readFile('config/defaults.env');
  for (const [i, key] of ['CATALOG_ENRICHMENT_MAX_PER_RUN', 'CATALOG_YOLO_MAX_PER_RUN'].entries()) {
    const line = envSrc.split('\n').find((l) => l.startsWith(`${key}=`));
    check(`C${i + 1}-${key}`, () => {
      assert.ok(line, `${key} missing from defaults.env`);
      const val = line.slice(key.length + 1).trim();
      assert.ok(val === '0' || val === '',
        `${key} file default must be 0/empty (uncapped), got ${JSON.stringify(val)}`);
    });
  }
}

// ── D: the old `|| 500` fallback is gone from all three consumers ──
{
  const enrichSrc = readFile('services/catalogProductEnrichmentService.js');
  const yoloSrc = readFile('services/catalogYoloDetectionService.js');
  check('D1-enrichment-no-500-fallback', () => {
    assert.ok(!/parseInt\(\s*process\.env\.CATALOG_ENRICHMENT_MAX_PER_RUN[\s\S]{0,60}\|\|\s*500/.test(enrichSrc),
      'catalogProductEnrichmentService still has the old parseInt(...) || 500 hard cap');
    assert.ok(/applyRunCap\(candidates\)/.test(enrichSrc),
      'runEnrichment must call applyRunCap(candidates), not candidates.slice(0, MAX_PER_RUN) directly');
  });
  check('D2-yolo-detect-no-500-fallback', () => {
    assert.ok(!/parseInt\(\s*process\.env\.CATALOG_YOLO_MAX_PER_RUN[\s\S]{0,60}\|\|\s*500/.test(yoloSrc),
      'catalogYoloDetectionService still has the old parseInt(...) || 500 hard cap');
    assert.ok(/applyRunCap\(candidates\)/.test(yoloSrc),
      'runYoloDetection must call applyRunCap(candidates), not candidates.slice(0, MAX_PER_RUN) directly');
  });
  const matSrc = readFile('services/catalogMediaMaterializeService.js');
  check('D3-materialize-no-500-fallback', () => {
    assert.ok(!/parseInt\(\s*process\.env\.CATALOG_YOLO_MAX_PER_RUN[\s\S]{0,60}\|\|\s*500/.test(matSrc),
      'catalogMediaMaterializeService still has the old parseInt(...) || 500 hard cap');
    assert.ok(/applyRunCap\(rows\)/.test(matSrc),
      'ensureBrandCatalogMediaMaterialized must call applyRunCap(rows), not rows.slice(0, MAX_PER_RUN) directly');
  });
}

// ── E: logConfig must not print a 500-shaped default ──
{
  const enrichSrc = readFile('services/catalogProductEnrichmentService.js');
  const yoloSrc = readFile('services/catalogYoloDetectionService.js');
  const matSrc = readFile('services/catalogMediaMaterializeService.js');
  check('E1-enrichment-log-uncapped-label', () => {
    assert.ok(/maxLabel/.test(enrichSrc) && /uncapped/.test(enrichSrc),
      'enrichment logConfig must print maxPerRun=uncapped when the cap is Infinity, not the number Infinity or 500');
  });
  check('E2-yolo-log-uncapped-label', () => {
    assert.ok(/maxLabel/.test(yoloSrc) && /uncapped/.test(yoloSrc),
      'yolo-detect logConfig must print maxPerRun=uncapped when the cap is Infinity');
  });
  check('E3-materialize-log-uncapped-label', () => {
    assert.ok(/maxLabel/.test(matSrc) && /uncapped/.test(matSrc),
      'materialize logConfig must print maxPerRun=uncapped when the cap is Infinity');
  });
}

console.log(`\n──── ${RESULTS.pass} pass, ${RESULTS.fail} fail ────`);
process.exit(RESULTS.fail > 0 ? 1 : 0);
