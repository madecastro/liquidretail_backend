// Offline verify harness for the ingest-time catalog YOLO detection pipeline.
//
// Groups:
//   A. exported symbols on the three new services
//   B. concurrency SPEC entry + defaults.env presence
//   C. sync-path hooks — 4 files call materialize + YOLO chain
//   D. money-safe patterns — fork on media.source, source-stamps
//   E. idempotency — refinedProducts short-circuit
//   F. failure isolation — one Media failing does not kill queue
//   G. Media schema — yoloDetectedAt declared
//   H. backfill wiring — worker.js tick
//   I. run-time: mediaYoloRefine synthesizer pure fixtures
//
// This harness NEVER calls Mongo, HTTP, YOLO, or GPT. Each check either
// reads source text (regex) or executes a pure helper on fixtures.

'use strict';

const fs = require('fs');
const path = require('path');

const RESULTS = { pass: 0, fail: 0, info: 0 };
function pass(id, msg) { RESULTS.pass++; console.log(`✓  ${id.padEnd(6)} ${msg}`); }
function fail(id, msg) { RESULTS.fail++; console.log(`✗  ${id.padEnd(6)} ${msg}`); }
function info(id, msg) { RESULTS.info++; console.log(`ℹ  ${id.padEnd(6)} ${msg}`); }

function readFile(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

// ── A: exports ──
try {
  const mod = require('../services/mediaYoloRefine');
  if (typeof mod.detectYoloForMedia === 'function') pass('A1', 'mediaYoloRefine.detectYoloForMedia exported');
  else fail('A1', 'mediaYoloRefine.detectYoloForMedia MISSING');
  if (mod.__test && typeof mod.__test.synthesizeRefinedFromCatalog === 'function') pass('A2', 'mediaYoloRefine.__test.synthesizeRefinedFromCatalog exported');
  else fail('A2', 'mediaYoloRefine.__test.synthesizeRefinedFromCatalog MISSING');
} catch (e) { fail('A1', `require mediaYoloRefine threw: ${e.message}`); }

try {
  const mod = require('../services/catalogMediaMaterializeService');
  if (typeof mod.ensureBrandCatalogMediaMaterialized === 'function') pass('A3', 'catalogMediaMaterialize.ensureBrandCatalogMediaMaterialized exported');
  else fail('A3', 'catalogMediaMaterialize.ensureBrandCatalogMediaMaterialized MISSING');
} catch (e) { fail('A3', `require catalogMediaMaterialize threw: ${e.message}`); }

try {
  const mod = require('../services/catalogYoloDetectionService');
  const needs = ['enqueueBrandProductYoloDetection', 'detectBrandYolo', 'detectYoloForOne', 'needsYoloDetection'];
  for (const [i, k] of needs.entries()) {
    if (typeof mod[k] === 'function') pass(`A${4 + i}`, `catalogYoloDetectionService.${k} exported`);
    else fail(`A${4 + i}`, `catalogYoloDetectionService.${k} MISSING`);
  }
} catch (e) { fail('A4', `require catalogYoloDetectionService threw: ${e.message}`); }

// ── B: SPEC + defaults.env ──
const concurrencySrc = readFile('services/concurrency.js');
if (/CATALOG_YOLO_CONCURRENCY:\s*\{/.test(concurrencySrc)) pass('B1', 'CATALOG_YOLO_CONCURRENCY declared in services/concurrency.js SPEC');
else fail('B1', 'CATALOG_YOLO_CONCURRENCY MISSING from services/concurrency.js SPEC');

const envSrc = readFile('config/defaults.env');
const needsEnv = ['CATALOG_YOLO_CONCURRENCY=', 'CATALOG_YOLO_MAX_PER_RUN=', 'CATALOG_YOLO_ALT_LIMIT=', 'CATALOG_YOLO_BACKFILL_ENABLED=', 'CATALOG_YOLO_BACKFILL_INTERVAL_MIN=', 'CATALOG_YOLO_BACKFILL_BATCH_SIZE='];
for (const [i, key] of needsEnv.entries()) {
  if (envSrc.split('\n').some((line) => line.startsWith(key))) pass(`B${2 + i}`, `${key} present in defaults.env`);
  else fail(`B${2 + i}`, `${key} missing from defaults.env`);
}

// ── C: sync-path hooks — 4 files ──
const syncFiles = [
  'services/catalogSyncService.js',
  'services/shopifyPublicIngestService.js',
  'services/apifyIngestService.js',
  'services/genericCatalogIngestService.js'
];
for (const [i, rel] of syncFiles.entries()) {
  const src = readFile(rel);
  const hasMat = /catalogMediaMaterializeService[\s\S]{0,200}ensureBrandCatalogMediaMaterialized/.test(src);
  const hasYolo = /catalogYoloDetectionService[\s\S]{0,200}enqueueBrandProductYoloDetection/.test(src);
  if (hasMat && hasYolo) pass(`C${1 + i}`, `${rel} wires materialize + YOLO detect`);
  else fail(`C${1 + i}`, `${rel} MISSING materialize=${hasMat} yolo=${hasYolo}`);
}

// ── D: money-safe fork on media.source ──
const refineSrc = readFile('services/mediaYoloRefine.js');
if (/media\.source === 'catalog-product'/.test(refineSrc) || /isCatalog\s*=\s*media\.source === 'catalog-product'/.test(refineSrc)) {
  pass('D1', 'mediaYoloRefine forks on media.source === "catalog-product"');
} else {
  fail('D1', 'mediaYoloRefine does not fork on media.source — refine will fire for catalog + YOLO hits (paid path)');
}
if (/refineDetectionCrops/.test(refineSrc)) pass('D2', 'mediaYoloRefine imports refineDetectionCrops for the paid path');
else fail('D2', 'mediaYoloRefine missing refineDetectionCrops import — paid refine unreachable');
// Match the literal source string values (may appear inside a ternary or
// via stampGptRefineSource); presence of both strings anywhere in the file
// is sufficient — the mapping helpers are exercised behaviorally in group I.
if (/'synthesized'/.test(refineSrc) && /'gpt-refine'/.test(refineSrc)) pass('D3', 'mediaYoloRefine stamps source: synthesized|gpt-refine on refined entries');
else fail('D3', 'mediaYoloRefine missing source stamps on refined entries');

// ── E: idempotency ──
if (/refinedProducts\.length\s*>\s*0/.test(refineSrc) && /already-refined/.test(refineSrc)) {
  pass('E1', 'detectYoloForMedia short-circuits when refinedProducts.length > 0');
} else {
  fail('E1', 'detectYoloForMedia missing already-refined short-circuit');
}

const orchSrc = readFile('services/catalogYoloDetectionService.js');
if (/needsYoloDetection\s*=\s*\(media\)|function needsYoloDetection/.test(orchSrc)) {
  pass('E2', 'catalogYoloDetectionService.needsYoloDetection defined');
} else {
  fail('E2', 'needsYoloDetection MISSING');
}

// ── F: per-Media failure isolation ──
// The per-Media try/catch is what isolates failures. Look for the pattern
// try{...detectYoloForMedia...}catch — allowing up to ~600 chars between
// the call and the catch (the block does a bit of accounting on success).
if (/try\s*\{[\s\S]{0,300}detectYoloForMedia[\s\S]{0,600}catch/.test(orchSrc)) {
  pass('F1', 'detectYoloForOne wraps detectYoloForMedia in try/catch (per-Media failure isolated)');
} else {
  fail('F1', 'detectYoloForOne missing per-Media try/catch');
}

// ── G: Media schema ──
const mediaSrc = readFile('models/Media.js');
if (/yoloDetectedAt:\s*\{/.test(mediaSrc)) pass('G1', 'Media.yoloDetectedAt declared');
else fail('G1', 'Media.yoloDetectedAt MISSING from schema — stamps will be silently dropped by strict schema');

// ── H: worker.js backfill wiring ──
const workerSrc = readFile('worker.js');
if (/yoloBackfillTick/.test(workerSrc) && /CATALOG_YOLO_BACKFILL_ENABLED/.test(workerSrc)) {
  pass('H1', 'worker.js declares yoloBackfillTick + CATALOG_YOLO_BACKFILL_ENABLED gate');
} else {
  fail('H1', 'worker.js MISSING backfill tick');
}
if (/mediaYoloRefine[\s\S]{0,200}detectYoloForMedia/.test(workerSrc)) pass('H2', 'worker.js backfill tick calls detectYoloForMedia');
else fail('H2', 'worker.js backfill tick does not call detectYoloForMedia');
if (/refinedProducts:\s*\{\s*\$size:\s*0\s*\}/.test(workerSrc)) pass('H3', 'worker.js backfill query filters on refinedProducts empty');
else fail('H3', 'worker.js backfill query missing refinedProducts $size:0 filter');

// ── I: run-time fixture on synthesizer ──
try {
  const { __test } = require('../services/mediaYoloRefine');
  const { synthesizeRefinedFromCatalog, pickBestDetection, buildCloudinaryCropUrl } = __test;
  {
    // pickBestDetection prefers highest confidence among sizeable boxes.
    const detections = [
      { x1: 0, y1: 0, x2: 10, y2: 10, confidence: 0.99, className: 'noise' },      // too small
      { x1: 50, y1: 50, x2: 950, y2: 950, confidence: 0.60, className: 'shoe' },   // sizeable
      { x1: 100, y1: 100, x2: 900, y2: 900, confidence: 0.85, className: 'shoe' } // sizeable, higher conf
    ];
    const best = pickBestDetection(detections, 1000, 1000);
    if (best && best.confidence === 0.85) pass('I1', 'pickBestDetection filters tiny detections and picks highest-confidence sizeable box');
    else fail('I1', `pickBestDetection unexpected best: ${JSON.stringify(best)}`);
  }
  {
    const bbox = { x1: 100, y1: 200, x2: 500, y2: 600 };
    const url = buildCloudinaryCropUrl('https://res.cloudinary.com/x/image/upload/v1/foo/bar.jpg', bbox);
    if (url && url.includes('c_crop,w_400,h_400,x_100,y_200,f_jpg,q_auto:good')) pass('I2', 'buildCloudinaryCropUrl emits correct c_crop transform');
    else fail('I2', `buildCloudinaryCropUrl unexpected: ${url}`);
  }
  {
    const url = buildCloudinaryCropUrl('https://example.com/not-cloudinary.jpg', { x1: 0, y1: 0, x2: 10, y2: 10 });
    if (url === null) pass('I3', 'buildCloudinaryCropUrl returns null for non-Cloudinary source');
    else fail('I3', `buildCloudinaryCropUrl should return null for non-Cloudinary source, got: ${url}`);
  }
  {
    // Synthesizer with YOLO hit + product metadata.
    const media = { fileUrl: 'https://res.cloudinary.com/x/image/upload/v1/x.jpg', width: 1000, height: 1000 };
    const product = { title: 'Marseille Wedge Espadrille', brand: 'Soludos', category: 'shoes' };
    const yolo = { width: 1000, height: 1000, detections: [{ x1: 100, y1: 100, x2: 900, y2: 900, confidence: 0.8, className: 'shoe' }] };
    const refined = synthesizeRefinedFromCatalog({ yolo, media, product });
    if (refined.length === 1 && refined[0].label === 'Marseille Wedge Espadrille' && refined[0].source === 'synthesized') {
      pass('I4', 'synthesizeRefinedFromCatalog returns product.title as label + source:synthesized');
    } else {
      fail('I4', `synthesizer unexpected: ${JSON.stringify(refined[0])}`);
    }
  }
  {
    // Synthesizer with no YOLO detection → whole-image fallback.
    const media = { fileUrl: 'https://res.cloudinary.com/x/image/upload/v1/x.jpg', width: 1000, height: 1000 };
    const product = { title: 'Marseille', brand: 'Soludos', category: 'shoes' };
    const yolo = { width: 1000, height: 1000, detections: [] };
    const refined = synthesizeRefinedFromCatalog({ yolo, media, product });
    if (refined.length === 1 && refined[0].x1 === 0 && refined[0].y1 === 0 && refined[0].x2 === 1000 && refined[0].source === 'synthesized-fallback') {
      pass('I5', 'synthesizer falls back to whole-image bbox with source:synthesized-fallback when YOLO empty');
    } else {
      fail('I5', `whole-image fallback unexpected: ${JSON.stringify(refined[0])}`);
    }
  }
  {
    // Synthesizer with no image dims → returns empty (guard against emitting a degenerate rect).
    const media = { fileUrl: 'https://res.cloudinary.com/x/image/upload/v1/x.jpg' };
    const yolo = { detections: [] };
    const refined = synthesizeRefinedFromCatalog({ yolo, media, product: null });
    if (refined.length === 0) pass('I6', 'synthesizer emits [] when neither YOLO nor image dims are available');
    else fail('I6', `synthesizer should emit [] on missing dims, got: ${JSON.stringify(refined)}`);
  }
} catch (e) {
  fail('I', `synthesizer fixture threw: ${e.stack || e.message}`);
}

// ── J: no accidental paid path on catalog + YOLO-hit ──
// The intent of the fork: catalog + YOLO-hit MUST go through synthesize, not
// through refineDetectionCrops. This is money-critical (each unnecessary
// refine call costs ~$0.03). Structural check: the synthesize branch must
// come BEFORE the refine branch and be reachable via media.source ===
// 'catalog-product' + yoloDetections.length > 0.
{
  const synthesizeIdx = refineSrc.indexOf('synthesizeRefinedFromCatalog({');
  const refineIdx = refineSrc.indexOf('refineDetectionCrops(');
  if (synthesizeIdx > 0 && refineIdx > synthesizeIdx) {
    pass('J1', 'synthesize branch precedes refine branch (catalog+YOLO-hit gets synthesize path)');
  } else if (synthesizeIdx < 0) {
    fail('J1', 'synthesizeRefinedFromCatalog call NOT FOUND — catalog + YOLO-hit will hit paid refine');
  } else if (refineIdx < 0) {
    info('J1', 'refineDetectionCrops call not found — check if UGC path still works');
  } else {
    fail('J1', 'refine branch comes BEFORE synthesize — money leak on catalog + YOLO-hit');
  }
}

// ── Summary ──
console.log(`\n──── ${RESULTS.pass} pass, ${RESULTS.fail} fail, ${RESULTS.info} info ────`);
process.exit(RESULTS.fail > 0 ? 1 : 0);
