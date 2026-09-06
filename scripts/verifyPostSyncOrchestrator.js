#!/usr/bin/env node
'use strict';
/**
 * verifyPostSyncOrchestrator — pins for the resilient materialize+YOLO
 * chain orchestrator (services/catalogPostSyncOrchestrator.js) and the
 * periodic reconcile tick that recovers stranded brands.
 *
 * Root problem (measured on Pelagic Gear 4 Demos, 2026-09-01):
 *   The 4 catalog sync services each pushed a fire-and-forget try/try
 *   block calling materialize + yolo-detect. When either downstream
 *   failed (yolo microservice WORKER TIMEOUT loop, SIGTERM mid-work,
 *   Cloudinary rate-limit), the block caught the error, console.warn'd,
 *   and moved on — no persistent signal, no retry. Result: 0/53 catalog
 *   Media had yoloDetectedAt stamped on that brand, and every ad-gen
 *   run paid the ~$0.16 reframe outpaint tax because refinedProducts
 *   were populated by cropRefineService fallback (generic 'object')
 *   rather than Grounding DINO (product labels).
 *
 * Invariants pinned here:
 *   A. Orchestrator exports both runPostSyncChain + sweepIncompleteBrands.
 *   B. All 4 sync services import and CALL runPostSyncChain — no
 *      residual inline try/try block that could silently absorb failure.
 *   C. Runs are wrapped in OperationRun(kind='catalog-post-sync') so the
 *      reconcile tick has a persistent signal to query.
 *   D. worker.js declares the reconcile tick, leader-gated, with the
 *      env-var kill switch shape mirroring yoloBackfillTick.
 *   E. Env defaults exist in config/defaults.env so a dashboard-only
 *      rollout can't silently disable it (dotenv precedence, §4a trap).
 *
 * Offline: no DB, no network, no API keys.
 *   node scripts/verifyPostSyncOrchestrator.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

let pass = 0;
const failures = [];
function check(id, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id}`); }
  else {
    const msg = detail ? `${id} — ${detail}` : id;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

// ── A: orchestrator exports ──
try {
  const mod = require('../services/catalogPostSyncOrchestrator');
  check('A1: runPostSyncChain exported',
    typeof mod.runPostSyncChain === 'function',
    'catalogPostSyncOrchestrator.runPostSyncChain missing');
  check('A2: sweepIncompleteBrands exported',
    typeof mod.sweepIncompleteBrands === 'function',
    'catalogPostSyncOrchestrator.sweepIncompleteBrands missing');
} catch (err) {
  check('A0: orchestrator module loads', false, err.message);
}

// ── B: 4 sync services CALL runPostSyncChain, no residual try/try ──
const SYNC_FILES = [
  'services/catalogSyncService.js',
  'services/shopifyPublicIngestService.js',
  'services/apifyIngestService.js',
  'services/genericCatalogIngestService.js'
];
for (const [i, rel] of SYNC_FILES.entries()) {
  const src = read(rel);
  const usesOrchestrator = /catalogPostSyncOrchestrator[\s\S]{0,80}runPostSyncChain/.test(src);
  check(`B${i + 1}a: ${rel} calls runPostSyncChain`,
    usesOrchestrator,
    'sync service must delegate the materialize+yolo chain to the orchestrator');

  // Residual-detection: the OLD inline try/try block had this shape.
  // If a merge conflict or a partial revert leaves it back in, the
  // silent-failure regression returns — pin its absence.
  const hasOldPatternMaterialize =
    /await require\(['"]\.\/catalogMediaMaterializeService['"]\)\.ensureBrandCatalogMediaMaterialized/.test(src);
  const hasOldPatternYolo =
    /await require\(['"]\.\/catalogYoloDetectionService['"]\)\.enqueueBrandProductYoloDetection/.test(src);
  check(`B${i + 1}b: ${rel} has NO direct await of ensureBrandCatalogMediaMaterialized`,
    !hasOldPatternMaterialize,
    'residual inline try/try block still present — orchestrator was added but old code not removed');
  check(`B${i + 1}c: ${rel} has NO direct await of enqueueBrandProductYoloDetection`,
    !hasOldPatternYolo,
    'residual inline try/try block still present — orchestrator was added but old code not removed');
}

// ── C: OperationRun kind marker ──
const orchSrc = read('services/catalogPostSyncOrchestrator.js');
check('C1: orchestrator uses kind=\'catalog-post-sync\'',
  /kind:\s*['"]catalog-post-sync['"]/.test(orchSrc),
  'without the persistent kind marker the reconcile tick has no query surface');
// The sweeper must query the SAME kind (drift-prevention).
check('C2: sweepIncompleteBrands queries kind=\'catalog-post-sync\'',
  (orchSrc.match(/kind:\s*['"]catalog-post-sync['"]/g) || []).length >= 2,
  'orchestrator writes and reads must agree on the kind marker');

// ── D: worker.js tick ──
const workerSrc = read('worker.js');
check('D1: worker.js declares postSyncReconcileTick',
  /postSyncReconcileTick/.test(workerSrc),
  'worker.js is where the periodic recovery lives');
check('D2: reconcile tick is leader-gated',
  /postSyncReconcileTick[\s\S]{0,400}housekeepingLease\.holds\(\)/.test(workerSrc),
  'without the lease check every worker instance would fire the sweep simultaneously');
check('D3: reconcile tick is env-gated (POST_SYNC_RECONCILE_ENABLED)',
  /POST_SYNC_RECONCILE_ENABLED/.test(workerSrc),
  'must be flippable off at dashboard without a code deploy — same pattern as CATALOG_YOLO_BACKFILL_ENABLED');
check('D4: reconcile tick calls sweepIncompleteBrands',
  /sweepIncompleteBrands\(/.test(workerSrc),
  'wire the tick to the actual sweeper');

// ── E: env defaults present ──
const envSrc = read('config/defaults.env');
for (const key of [
  'POST_SYNC_RECONCILE_ENABLED=',
  'POST_SYNC_RECONCILE_INTERVAL_MIN=',
  'POST_SYNC_RECONCILE_BATCH_SIZE=',
  'POST_SYNC_RECONCILE_STALE_MIN=',
  'POST_SYNC_MAX_INFLIGHT_CHAINS=',
  'POST_SYNC_CHAIN_HEARTBEAT_STALE_MIN=',
  'CATALOG_YOLO_BREAKER_THRESHOLD=',
  'CATALOG_YOLO_BREAKER_COOLDOWN_MS=',
  'CATALOG_YOLO_BACKOFF_BASE_MS=',
  'CATALOG_YOLO_BACKOFF_CAP_MS='
]) {
  check(`E: ${key.slice(0, -1)} in defaults.env`,
    envSrc.split('\n').some((line) => line.startsWith(key)),
    'without a defaults.env row, a fresh Render service with no dashboard override runs with a code-path default and drift is invisible');
}

if (failures.length) {
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
