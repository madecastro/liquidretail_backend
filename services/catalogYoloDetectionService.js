// Catalog YOLO detection at ingest — peer of catalogProductEnrichmentService
// and ingestShotClassifyService.
//
// Three ingest-time jobs run after every catalog sync completes:
//   ingestShotClassifyService       → Media.classification.shotStyle (free, Sharp)
//   catalogProductEnrichmentService → CatalogProduct.productReviews/.rating
//   this service                    → Media.refinedProducts[] via mediaYoloRefine
//
// Populating refinedProducts[] at ingest eliminates the ad-time paid
// nano-banana outpaint (~$0.08 + 54s per master) that fires when reframe
// falls to tier-3 outpaint on YOLO-empty Media. Consumers:
//   reframeStrategyChooser  (tier-1 crop-first geometry)
//   videoProductAnchor      (product-anchor prompt line for lifestyle)
//   pmaxSplitStrategy       (PMax 16:9 subject-side placement)
//   quoteProvenance         (label-scope filter for quote selection)
//
// Structure mirrors catalogProductEnrichmentService exactly:
//   - Two entry points (AUTO gap-fill + USER-ACTUATED full)
//   - Shared runYoloDetection driver with options
//   - Concurrency-capped processQueue over products
//   - OperationRun(kind:'yolo-detect') for visibility + cancel
//
// Work granularity is PRODUCT for progress tracking (matches enrichment's
// ActivityBar UX). Inside each product, media are processed serially by
// detectYoloForOne. Effective HTTP load on yolo_microservice is
// CATALOG_YOLO_CONCURRENCY (~= 6) concurrent `/detect-batch` calls (one
// per in-flight product), bounded process-wide by yoloLoadLimiter so
// overlapping chains cannot stack 6N. Live DetectRun / UGC `/detect`
// does NOT go through the limiter.
//
// Money: forked in services/mediaYoloRefine.js — catalog + YOLO-hits is
// $0 (synthesized from CatalogProduct metadata); catalog + YOLO-empty
// falls to paid GPT-4.1 refine (~$0.03/media); UGC is always paid refine.
// See mediaYoloRefine's header for the full argument.

'use strict';

const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');
const progressService = require('./progressService');
const { detectYoloForMediaBatch } = require('./mediaYoloRefine');
const { classifyYoloError } = require('./yoloService');
const yoloLoadLimiter = require('./yoloLoadLimiter');

const { concurrency: CONC } = require('./concurrency');
const CONCURRENCY = CONC.CATALOG_YOLO_CONCURRENCY;
// Per-run ceiling. Unset / 0 / negative / NaN → uncapped. A positive
// integer re-caps one brand run. Default is uncapped so an operator who
// does nothing gets no ceiling (owner 2026-09-05). Shared with
// catalogMediaMaterializeService via the same env name and parser.
function parseMaxPerRun(raw) {
  const n = Number(raw);
  return n > 0 ? n : Infinity;
}
const MAX_PER_RUN = parseMaxPerRun(process.env.CATALOG_YOLO_MAX_PER_RUN);
function applyRunCap(candidates, cap = MAX_PER_RUN) {
  if (!Array.isArray(candidates)) return [];
  return Number.isFinite(cap) ? candidates.slice(0, cap) : candidates;
}
const ALT_LIMIT = Math.max(0, parseInt(process.env.CATALOG_YOLO_ALT_LIMIT, 10) || 7);

let _startRun = null;
let _workerOverride = null;

(function logConfig() {
  const maxLabel = Number.isFinite(MAX_PER_RUN) ? MAX_PER_RUN : 'uncapped';
  console.log(
    `🎯 catalogYoloDetectionService config — ` +
    `concurrency=${CONCURRENCY} maxPerRun=${maxLabel} altLimit=${ALT_LIMIT}`
  );
})();

// AUTO-path gate: a product needs YOLO detection when at least one of its
// hero + top-N alts has empty refinedProducts AND has never completed a
// detect (yoloDetectedAt null). A legit-empty result is persisted with
// refinedProducts:[] AND yoloDetectedAt set — re-targeting those is $0
// but pure YOLO load. Matches yoloBackfillTick's predicate (worker.js).
function needsYoloDetection(media) {
  if (media?.yoloDetectedAt) return false;
  return !Array.isArray(media?.refinedProducts) || media.refinedProducts.length === 0;
}

function classifyDetectFailure(err) {
  const yoloKind = err?.yoloKind || (err ? classifyYoloError(err) : 'unknown');
  const transient = yoloLoadLimiter.isTransientForBreaker(yoloKind);
  return { yoloKind, transient };
}

// Per-product driver. Enumerates hero + top-N alts, then submits them as
// ONE batch to yolo_microservice /detect-batch (via detectYoloForMediaBatch).
// Amortizes HTTP + Flask + Python overhead across a product's Media set
// (~30% wall reduction per image measured on the microservice CPU box).
// Loads the CatalogProduct once and passes it into the batch so the
// Grounding DINO prompt is built a single time per product. Never throws —
// batch-level failures are logged and counted; product row completes so
// the outer queue can move on.
async function detectYoloForOne(product) {
  const id = String(product._id);
  const label = `"${(product.title || '').slice(0, 40) || '(untitled)'}"`;
  const t0 = Date.now();

  // Hero + first ALT_LIMIT alts. If pointers are missing, materialize should
  // have run first (see ensureBrandCatalogMediaMaterialized peer) — we don't
  // materialize here, we DETECT what's already there.
  const rawMediaIds = [
    product.imageMediaId,
    ...(Array.isArray(product.additionalImageMediaIds) ? product.additionalImageMediaIds : []).slice(0, ALT_LIMIT)
  ].filter(Boolean).map(String);
  if (!rawMediaIds.length) {
    return { productId: id, mediaTotal: 0, detected: 0, skipped: 0, failed: 0, noMedia: true };
  }

  const mediaDocs = await Media.find({ _id: { $in: rawMediaIds } }).lean();
  const targets = mediaDocs.filter(needsYoloDetection);

  if (!targets.length) {
    return { productId: id, mediaTotal: mediaDocs.length, detected: 0, skipped: mediaDocs.length, failed: 0 };
  }

  // Load the CatalogProduct once — the batch helper reuses it for every
  // catalog-product Media in the batch to build the Grounding DINO prompt.
  // Skip if the whole product target set is UGC (rare for this orchestrator,
  // but safe).
  const anyCatalog = targets.some((m) => m.source === 'catalog-product');
  const productDoc = anyCatalog
    ? await CatalogProduct.findById(product._id).select('title brand category').lean()
    : null;

  let detected = 0, failed = 0;
  let synthesized = 0, gptRefined = 0;
  try {
    const results = await detectYoloForMediaBatch(targets, {
      product: productDoc,
      trigger: 'ingest'
    });
    for (const r of results) {
      if (r.status === 'ok') {
        detected++;
        if (r.path === 'synthesized') synthesized++;
        else if (r.path === 'gpt-refine') gptRefined++;
      } else if (r.status === 'failed') {
        failed++;
        console.warn(`   ⚠️  yolo-detect ${label} media=${r.mediaId}: ${r.reason || 'unknown'} ${r.error || ''}`);
      }
    }
  } catch (err) {
    // Whole-batch failure (e.g. YOLO service down after retries). Count
    // every target as failed so counters stay accurate. Attach transient
    // + yoloKind so the process-wide breaker can trip on 5xx as well as
    // conn-reset — isTransientYoloError is conn-only.
    failed = targets.length;
    const { yoloKind, transient } = classifyDetectFailure(err);
    console.warn(`   ⚠️  yolo-detect ${label} batch failed: ${err.message} kind=${yoloKind} transient=${transient}`);
    const ms = Date.now() - t0;
    console.log(
      `   ✓ yolo-detect ${label} in ${ms}ms — ` +
      `detected=${detected}/${targets.length} ` +
      `(synthesized=${synthesized} gpt-refined=${gptRefined}) ` +
      `skipped=${mediaDocs.length - targets.length} failed=${failed}`
    );
    return {
      productId: id,
      mediaTotal: mediaDocs.length,
      detected, synthesized, gptRefined,
      skipped: mediaDocs.length - targets.length,
      failed,
      transient,
      yoloKind
    };
  }

  const ms = Date.now() - t0;
  console.log(
    `   ✓ yolo-detect ${label} in ${ms}ms — ` +
    `detected=${detected}/${targets.length} ` +
    `(synthesized=${synthesized} gpt-refined=${gptRefined}) ` +
    `skipped=${mediaDocs.length - targets.length} failed=${failed}`
  );
  return {
    productId: id,
    mediaTotal: mediaDocs.length,
    detected, synthesized, gptRefined,
    skipped: mediaDocs.length - targets.length,
    failed,
    transient: false
  };
}

// Concurrency-capped queue. Per-chain `inflight < CONCURRENCY` is a
// courtesy cap; yoloLoadLimiter.acquire() is the process-wide bound so
// two chains at 6 each cannot exceed occupancy 6.
async function processQueue(products, { onDone = null, isCancelled = null, worker = null, brandId = null } = {}) {
  const runOne = worker || _workerOverride || detectYoloForOne;
  let next = 0, inflight = 0, processed = 0, stopped = false;
  let abortReason = null;
  await new Promise((resolve) => {
    const pump = () => {
      if ((next >= products.length || stopped) && inflight === 0) { resolve(); return; }
      while (!stopped && inflight < CONCURRENCY && next < products.length) {
        if (yoloLoadLimiter.isOpen()) {
          stopped = true;
          abortReason = 'yolo-circuit-open';
          break;
        }
        const p = products[next++];
        inflight++;
        let outcome = null;
        (async () => {
          await yoloLoadLimiter.acquire();
          try {
            if (yoloLoadLimiter.isOpen()) {
              return { aborted: true, skipped: true };
            }
            return await runOne(p);
          } finally {
            yoloLoadLimiter.release();
          }
        })()
          .catch((err) => {
            console.warn(`   ⚠️  yolo-detect crash for ${p._id}: ${err.message}`);
            return { failed: 1, transient: yoloLoadLimiter.isTransientForBreaker(err && err.yoloKind) };
          })
          .then((result) => {
            outcome = result;
            if (result && result.aborted) return result;
            if (result && result.transient) {
              yoloLoadLimiter.recordOutcome({
                transient: true,
                brandId,
                remaining: Math.max(0, products.length - next)
              });
            } else if (result) {
              yoloLoadLimiter.recordOutcome({ transient: false });
            }
            if (yoloLoadLimiter.isOpen()) {
              stopped = true;
              abortReason = 'yolo-circuit-open';
            }
            return result;
          })
          .finally(async () => {
            inflight--;
            // Aborted/skipped-due-to-breaker-open must NOT count as detected.
            if (!(outcome && outcome.aborted)) processed++;
            if (onDone) { try { await onDone(processed, products.length); } catch { /* ignore */ } }
            if (isCancelled && !stopped) { try { if (await isCancelled()) { stopped = true; abortReason = abortReason || 'cancelled'; } } catch { /* ignore */ } }
            pump();
          });
      }
    };
    pump();
  });
  return {
    processed,
    cancelled: abortReason === 'cancelled',
    aborted: abortReason === 'yolo-circuit-open' || yoloLoadLimiter.isOpen(),
    abortReason
  };
}

async function startYoloRun(args) {
  if (_startRun) return _startRun(args);
  return progressService.startRun(args);
}

// Shared driver — same shape as catalogProductEnrichmentService.runEnrichment.
async function runYoloDetection(brandId, { onlyGaps, label }) {
  if (!brandId) return { skipped: true, reason: 'no brandId' };
  const t0 = Date.now();

  const rows = await CatalogProduct.find({ brandId, draft: { $ne: true } })
    .select('_id advertiserId title imageMediaId additionalImageMediaIds')
    .lean();

  let candidates = rows;
  if (onlyGaps) {
    // A product qualifies as a "gap" if ANY of its referenced Media has an
    // empty refinedProducts array AND has never completed a detect
    // (yoloDetectedAt: null). Legit-empty results stamp yoloDetectedAt
    // and must not re-enter. Matches yoloBackfillTick.
    const missingProductIds = await Media.distinct('metadata.catalogProductId', {
      brandId,
      source: 'catalog-product',
      yoloDetectedAt: null,
      $or: [
        { refinedProducts: { $exists: false } },
        { refinedProducts: { $size: 0 } }
      ]
    });
    const missingSet = new Set(missingProductIds.map(String));
    candidates = rows.filter((r) => missingSet.has(String(r._id)));
  }
  const targets = applyRunCap(candidates);

  const occ = yoloLoadLimiter.occupancyNow();
  const lim = yoloLoadLimiter.getLimit();
  const breaker = yoloLoadLimiter.isOpen() ? 'open' : 'closed';
  console.log(
    `🎯 catalogYoloDetection[brand=${brandId}]: ${label} — ` +
    `${rows.length} products, ${targets.length} target(s) ` +
    `(onlyGaps=${!!onlyGaps} cap=${Number.isFinite(MAX_PER_RUN) ? MAX_PER_RUN : 'uncapped'} ` +
    `occupancy=${occ}/${lim} breaker=${breaker} consecutiveTransient=${yoloLoadLimiter.consecutiveTransientNow()}, ` +
    `concurrency=${CONCURRENCY}, altLimit=${ALT_LIMIT})`
  );
  if (!targets.length) {
    return { ok: true, total: rows.length, detected: 0, skipped: rows.length, durationMs: Date.now() - t0 };
  }

  return runYoloDetectionOnTargets(targets, {
    brandId,
    label,
    advertiserId: targets[0]?.advertiserId || rows[0]?.advertiserId || null,
    rowsTotal: rows.length,
    t0
  });
}

async function runYoloDetectionOnTargets(targets, {
  brandId,
  label = 'YOLO detect',
  advertiserId = null,
  rowsTotal = null,
  worker = null,
  t0 = Date.now()
} = {}) {
  const totalRows = rowsTotal == null ? targets.length : rowsTotal;
  const run = await startYoloRun({
    kind:        'yolo-detect',
    advertiserId,
    brandId,
    total:       targets.length,
    cancellable: true,
    label
  });

  let cancelledByRun = false;
  const { processed, cancelled, aborted } = await processQueue(targets, {
    worker,
    brandId,
    onDone: async (n, total) => {
      run.tick(n, total, `detected ${n}/${total}`);
      if (brandId) {
        try {
          const { touchChainHeartbeat } = require('./catalogPostSyncOrchestrator');
          await touchChainHeartbeat(brandId);
        } catch { /* never fail the queue on a heartbeat write */ }
      }
      if (!cancelledByRun) {
        try { await run.checkpoint(); } catch { cancelledByRun = true; }
      }
    },
    isCancelled: () => cancelledByRun
  });

  const durationMs = Date.now() - t0;
  const remaining = Math.max(0, targets.length - processed);
  if (aborted || yoloLoadLimiter.isOpen()) {
    console.log(
      `🛑 catalogYoloDetection[brand=${brandId}]: circuit open after ` +
      `${yoloLoadLimiter.consecutiveTransientNow()} consecutive transient batches ` +
      `(threshold ${yoloLoadLimiter.threshold()} is a floor; first wave may run up to concurrency=${CONCURRENCY}) ` +
      `— aborting remaining ${remaining} target(s)`
    );
    try {
      await run.fail(new Error('yolo-circuit-open'), {
        reason: 'yolo-circuit-open',
        detected: processed,
        remaining
      });
    } catch { /* ignore */ }
    return {
      ok: false,
      reason: 'yolo-circuit-open',
      detected: processed,
      failed: processed,
      remaining,
      total: totalRows,
      durationMs
    };
  }
  if (cancelledByRun || cancelled) {
    run.markCancelled?.('Cancelled — partial detection kept');
    console.log(
      `🎯 catalogYoloDetection[brand=${brandId}]: ${label} CANCELLED after ${processed}/${targets.length} ` +
      `in ${Math.round(durationMs / 1000)}s`
    );
    return { ok: true, cancelled: true, total: totalRows, detected: processed, durationMs };
  }

  await run.succeed({ detected: processed });
  console.log(
    `🎯 catalogYoloDetection[brand=${brandId}]: ${label} done — ` +
    `detected=${processed} skipped=${totalRows - targets.length} in ${Math.round(durationMs / 1000)}s`
  );
  return { ok: true, total: totalRows, detected: processed, skipped: totalRows - targets.length, durationMs };
}

// AUTO — called after catalog sync. Gap-fill: only products with at least one
// Media having empty refinedProducts and yoloDetectedAt:null.
async function enqueueBrandProductYoloDetection(brandId) {
  return runYoloDetection(brandId, {
    onlyGaps: true,
    label:    'YOLO detect (gap-fill)'
  });
}

// USER-ACTUATED — force full re-detection on every non-draft product regardless
// of current refinedProducts state. Not wired to a route in this PR; provided
// for admin panel + one-off scripts.
async function detectBrandYolo(brandId) {
  return runYoloDetection(brandId, {
    onlyGaps: false,
    label:    'YOLO detect (full)'
  });
}

module.exports = {
  enqueueBrandProductYoloDetection,
  detectBrandYolo,
  // Exported for tests + one-off scripts.
  detectYoloForOne,
  needsYoloDetection,
  parseMaxPerRun,
  applyRunCap,
  processQueue,
  runYoloDetectionOnTargets,
  classifyDetectFailure,
  __test: {
    processQueue,
    runYoloDetectionOnTargets,
    setStartRun(fn) { _startRun = fn; },
    setWorker(fn) { _workerOverride = fn; },
    reset() { _startRun = null; _workerOverride = null; }
  }
};
