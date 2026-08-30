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
// CATALOG_YOLO_CONCURRENCY (~= 6) concurrent calls, since only one Media
// per product is in-flight at a time.
//
// Money: forked in services/mediaYoloRefine.js — catalog + YOLO-hits is
// $0 (synthesized from CatalogProduct metadata); catalog + YOLO-empty
// falls to paid GPT-4.1 refine (~$0.03/media); UGC is always paid refine.
// See mediaYoloRefine's header for the full argument.

'use strict';

const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');
const progressService = require('./progressService');
const { detectYoloForMedia } = require('./mediaYoloRefine');

const { concurrency: CONC } = require('./concurrency');
const CONCURRENCY = CONC.CATALOG_YOLO_CONCURRENCY;
const MAX_PER_RUN = Math.max(1, parseInt(process.env.CATALOG_YOLO_MAX_PER_RUN, 10) || 500);
const ALT_LIMIT = Math.max(0, parseInt(process.env.CATALOG_YOLO_ALT_LIMIT, 10) || 7);

(function logConfig() {
  console.log(
    `🎯 catalogYoloDetectionService config — ` +
    `concurrency=${CONCURRENCY} maxPerRun=${MAX_PER_RUN} altLimit=${ALT_LIMIT}`
  );
})();

// AUTO-path gate: a product needs YOLO detection when at least one of its
// hero + top-N alts has empty refinedProducts. Products fully covered are
// skipped; the mixed case fires per-Media inside detectYoloForOne (which
// short-circuits per-Media in mediaYoloRefine).
function needsYoloDetection(media) {
  return !Array.isArray(media?.refinedProducts) || media.refinedProducts.length === 0;
}

// Per-product driver. Enumerates hero + top-N alts, runs YOLO on each Media
// that lacks refinedProducts. Never throws — per-Media failures are logged
// and counted; product row completes so the outer queue can move on.
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

  let detected = 0, failed = 0;
  let synthesized = 0, gptRefined = 0;
  for (const media of targets) {
    try {
      const r = await detectYoloForMedia(media, { trigger: 'ingest' });
      if (r.status === 'ok') {
        detected++;
        if (r.path === 'synthesized') synthesized++;
        else if (r.path === 'gpt-refine') gptRefined++;
      }
    } catch (err) {
      failed++;
      console.warn(`   ⚠️  yolo-detect ${label} media=${media._id}: ${err.message}`);
    }
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
    failed
  };
}

// Concurrency-capped queue. Copy of enrichment's processQueue shape so the
// two remain reviewable side-by-side.
async function processQueue(products, { onDone = null, isCancelled = null } = {}) {
  let next = 0, inflight = 0, processed = 0, stopped = false;
  await new Promise((resolve) => {
    const pump = () => {
      if ((next >= products.length || stopped) && inflight === 0) { resolve(); return; }
      while (!stopped && inflight < CONCURRENCY && next < products.length) {
        const p = products[next++];
        inflight++;
        detectYoloForOne(p)
          .catch((err) => console.warn(`   ⚠️  yolo-detect crash for ${p._id}: ${err.message}`))
          .finally(async () => {
            inflight--;
            processed++;
            if (onDone) { try { await onDone(processed, products.length); } catch { /* ignore */ } }
            if (isCancelled && !stopped) { try { if (await isCancelled()) stopped = true; } catch { /* ignore */ } }
            pump();
          });
      }
    };
    pump();
  });
  return { processed, cancelled: stopped };
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
    // empty refinedProducts array. We do this with a $lookup-free filter:
    // fetch the productIds of catalog-product Media that lack refined, then
    // intersect with our row set.
    const missingProductIds = await Media.distinct('metadata.catalogProductId', {
      brandId,
      source: 'catalog-product',
      $or: [
        { refinedProducts: { $exists: false } },
        { refinedProducts: { $size: 0 } }
      ]
    });
    const missingSet = new Set(missingProductIds.map(String));
    candidates = rows.filter((r) => missingSet.has(String(r._id)));
  }
  const targets = candidates.slice(0, MAX_PER_RUN);

  console.log(
    `🎯 catalogYoloDetection[brand=${brandId}]: ${label} — ` +
    `${rows.length} products, ${targets.length} target(s) ` +
    `(onlyGaps=${!!onlyGaps} cap=${MAX_PER_RUN}, concurrency=${CONCURRENCY}, altLimit=${ALT_LIMIT})`
  );
  if (!targets.length) {
    return { ok: true, total: rows.length, detected: 0, skipped: rows.length, durationMs: Date.now() - t0 };
  }

  const advertiserId = targets[0]?.advertiserId || rows[0]?.advertiserId || null;
  const run = await progressService.startRun({
    kind:        'yolo-detect',
    advertiserId,
    brandId,
    total:       targets.length,
    cancellable: true,
    label
  });

  let cancelledByRun = false;
  const { processed, cancelled } = await processQueue(targets, {
    onDone: async (n, total) => {
      run.tick(n, total, `detected ${n}/${total}`);
      if (!cancelledByRun) {
        try { await run.checkpoint(); } catch { cancelledByRun = true; }
      }
    },
    isCancelled: () => cancelledByRun
  });

  const durationMs = Date.now() - t0;
  if (cancelledByRun || cancelled) {
    run.markCancelled?.('Cancelled — partial detection kept');
    console.log(
      `🎯 catalogYoloDetection[brand=${brandId}]: ${label} CANCELLED after ${processed}/${targets.length} ` +
      `in ${Math.round(durationMs / 1000)}s`
    );
    return { ok: true, cancelled: true, total: rows.length, detected: processed, durationMs };
  }

  await run.succeed({ detected: processed });
  console.log(
    `🎯 catalogYoloDetection[brand=${brandId}]: ${label} done — ` +
    `detected=${processed} skipped=${rows.length - targets.length} in ${Math.round(durationMs / 1000)}s`
  );
  return { ok: true, total: rows.length, detected: processed, skipped: rows.length - targets.length, durationMs };
}

// AUTO — called after catalog sync. Gap-fill: only products with at least one
// Media having empty refinedProducts.
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
  needsYoloDetection
};
