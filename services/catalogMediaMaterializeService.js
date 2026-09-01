// Catalog Media materialization at ingest.
//
// Fires from all 4 catalog sync paths AFTER products are upserted, BEFORE
// enrichment + YOLO detection enqueue. Ensures every non-draft product has
// Media docs materialized for hero + top-N alts so downstream consumers
// (catalogYoloDetectionService, ad-gen reference stack) can rely on Media
// existing.
//
// WHY THIS EXISTS as a peer of catalogProductDetectService.enqueueProductDetect:
// enqueueProductDetect materializes AND creates DetectRun docs. The DetectRun
// path runs the paid 6-stage detect pipeline via a separate worker. Ingest
// doesn't want to pay for that — subjects-text and product-match are UGC-
// oriented; catalog products get shot classification for free from
// ingestShotClassifyService and identity for free from CatalogProduct
// metadata (via mediaYoloRefine's synthesis fork).
//
// So this service:
//   - Materializes hero + top-N alts via the same materializeImage primitive
//     enqueueProductDetect uses.
//   - Does NOT create DetectRun docs (subjects-text stays lazy).
//   - Does write imageMediaId + additionalImageMediaIds pointers on
//     CatalogProduct so operator/UI reads find the Media without waiting.
//
// Money: bandwidth-only. Cloudinary uploads of the source imageUrl and top-
// N additionalImages URLs. No LLM, no vision service. Free-ish (already-
// paid Cloudinary tier).
//
// Progress: wrapped in OperationRun(kind:'materialize') so the ActivityBar
// dock shows "Materializing catalog media 45/100" alongside enrichment and
// yolo-detect for the same brand sync.
//
// Idempotent by construction: materializeImage skips products with existing
// pointers via its own createDetectRunIfAbsent-adjacent guard, and this
// service also skips products whose imageMediaId + top-N altMediaIds are
// already populated on the CatalogProduct doc.

'use strict';

const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');
const progressService = require('./progressService');
const { materializeImage } = require('./catalogProductDetectService');

const { concurrency: CONC } = require('./concurrency');
const CONCURRENCY = CONC.CATALOG_YOLO_CONCURRENCY;  // reuse the same knob — same bandwidth ceiling

const DEFAULT_ALT_LIMIT = Math.max(0, parseInt(process.env.CATALOG_YOLO_ALT_LIMIT, 10) || 7);
const MAX_PER_RUN = Math.max(1, parseInt(process.env.CATALOG_YOLO_MAX_PER_RUN, 10) || 500);

(function logConfig() {
  console.log(
    `🖼️  catalogMediaMaterializeService config — ` +
    `concurrency=${CONCURRENCY} maxPerRun=${MAX_PER_RUN} altLimit=${DEFAULT_ALT_LIMIT}`
  );
})();

// Per-product driver. Skips products where hero + at least ALT_LIMIT alts are
// already pointed at Media (idempotent). Otherwise materializes hero (if
// missing) and the first N alts that don't have pointers yet.
async function materializeOne(product, { altLimit = DEFAULT_ALT_LIMIT } = {}) {
  const id = String(product._id);
  const label = `"${(product.title || '').slice(0, 40) || '(untitled)'}"`;
  const t0 = Date.now();

  const existingAlts = Array.isArray(product.additionalImageMediaIds) ? product.additionalImageMediaIds : [];
  const heroDone = !!product.imageMediaId;
  const altsWanted = Math.min(altLimit, (product.additionalImages || []).length);

  if (heroDone && existingAlts.filter(Boolean).length >= altsWanted) {
    return { productId: id, hero: 'skipped', alts: 0, skipped: 1 + altsWanted };
  }

  let heroMediaId = product.imageMediaId ? String(product.imageMediaId) : null;
  const altMediaIds = existingAlts.map((v) => v ? String(v) : null);
  let materialized = 0;
  let failed = 0;

  // Hero (feedIndex=0). Only materialize if missing.
  if (!heroDone && product.imageUrl) {
    try {
      const media = await materializeImage({
        sourceUrl: product.imageUrl,
        product,
        imageRole: 'hero',
        feedIndex: 0
      });
      if (media?._id) {
        heroMediaId = String(media._id);
        materialized++;
      }
    } catch (err) {
      failed++;
      console.warn(`   ⚠️  materialize[${label}] hero: ${err.message}`);
    }
  }

  // Alts (feedIndex 1..N). Only fill positions that lack pointers.
  const altUrls = (Array.isArray(product.additionalImages) ? product.additionalImages : [])
    .filter((u) => u && u !== product.imageUrl)
    .slice(0, altLimit);
  for (let i = 0; i < altUrls.length; i++) {
    if (altMediaIds[i]) continue;  // already have a pointer at this position
    try {
      const media = await materializeImage({
        sourceUrl: altUrls[i],
        product,
        imageRole: 'alt',
        feedIndex: i + 1
      });
      if (media?._id) {
        altMediaIds[i] = String(media._id);
        materialized++;
      }
    } catch (err) {
      failed++;
      console.warn(`   ⚠️  materialize[${label}] alt[${i + 1}]: ${err.message}`);
    }
  }

  // Persist pointers. Guarded: never null out existing values (materialize
  // failures leave holes rather than wiping the good pointers).
  const update = {};
  if (heroMediaId && String(product.imageMediaId || '') !== heroMediaId) update.imageMediaId = heroMediaId;
  const nextAlts = altMediaIds.slice(0, altLimit).filter(Boolean);
  if (nextAlts.length && JSON.stringify(nextAlts) !== JSON.stringify(existingAlts.filter(Boolean))) {
    update.additionalImageMediaIds = nextAlts;
  }
  if (Object.keys(update).length) {
    await CatalogProduct.updateOne({ _id: product._id }, { $set: update });
  }

  const ms = Date.now() - t0;
  if (materialized > 0 || failed > 0) {
    console.log(
      `   ✓ materialize ${label} in ${ms}ms — ` +
      `newMedia=${materialized} failed=${failed} total=${1 + altUrls.length}`
    );
  }
  return { productId: id, materialized, failed };
}

// Concurrency-capped queue, mirrors catalogProductEnrichmentService.
async function processQueue(products, { altLimit, onDone = null, isCancelled = null } = {}) {
  let next = 0, inflight = 0, processed = 0, stopped = false;
  await new Promise((resolve) => {
    const pump = () => {
      if ((next >= products.length || stopped) && inflight === 0) { resolve(); return; }
      while (!stopped && inflight < CONCURRENCY && next < products.length) {
        const p = products[next++];
        inflight++;
        materializeOne(p, { altLimit })
          .catch((err) => console.warn(`   ⚠️  materialize crash for ${p._id}: ${err.message}`))
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

/**
 * Public entry — call from each catalog sync path AFTER products are
 * upserted, BEFORE enrichment / YOLO detection enqueue. Awaited so the
 * hero + alt Media exist by the time the fire-and-forget peers start.
 *
 * @param {ObjectId|string} brandId
 * @param {object} [opts]
 * @param {number} [opts.altLimit]  — override CATALOG_YOLO_ALT_LIMIT
 */
async function ensureBrandCatalogMediaMaterialized(brandId, opts = {}) {
  if (!brandId) return { skipped: true, reason: 'no brandId' };
  const t0 = Date.now();
  const altLimit = Math.max(0, opts.altLimit != null ? opts.altLimit : DEFAULT_ALT_LIMIT);

  // brandId is REQUIRED in the projection — materializeImage reads
  // product.brandId when building the Media doc, and Mongoose's strict
  // schema does NOT default a missing brandId to null-safe behavior:
  // the created Media just has brandId=null. Measured 2026-09-01 on
  // Pelagic Gear 4 Demos: 928 of 981 newly-created catalog Media had
  // brandId=null, invisible to every brand-scoped read (backfill query,
  // reconcile sweep, adReadinessService, ad-gen reference stack). Same
  // ".select() silently drops a required field" trap CLAUDE.md §4a
  // records for the shopifyUrl and description cases.
  const rows = await CatalogProduct.find({ brandId, draft: { $ne: true } })
    .select('_id brandId advertiserId title imageUrl additionalImages imageMediaId additionalImageMediaIds')
    .lean();

  const targets = rows.slice(0, MAX_PER_RUN);
  console.log(
    `🖼️  catalogMediaMaterialize[brand=${brandId}]: ` +
    `${rows.length} products, ${targets.length} target(s) (altLimit=${altLimit}, ` +
    `cap=${MAX_PER_RUN}, concurrency=${CONCURRENCY})`
  );
  if (!targets.length) {
    return { ok: true, total: rows.length, materialized: 0, durationMs: Date.now() - t0 };
  }

  const advertiserId = targets[0]?.advertiserId || rows[0]?.advertiserId || null;
  const run = await progressService.startRun({
    kind: 'materialize',
    advertiserId,
    brandId,
    total: targets.length,
    cancellable: true,
    label: 'Materializing catalog media'
  });

  let cancelledByRun = false;
  const { processed, cancelled } = await processQueue(targets, {
    altLimit,
    onDone: async (n, total) => {
      run.tick(n, total, `materialized ${n}/${total}`);
      if (!cancelledByRun) {
        try { await run.checkpoint(); } catch { cancelledByRun = true; }
      }
    },
    isCancelled: () => cancelledByRun
  });

  const durationMs = Date.now() - t0;
  if (cancelledByRun || cancelled) {
    run.markCancelled?.('Cancelled — partial materialization kept');
    console.log(
      `🖼️  catalogMediaMaterialize[brand=${brandId}]: CANCELLED after ${processed}/${targets.length} ` +
      `in ${Math.round(durationMs / 1000)}s`
    );
    return { ok: true, cancelled: true, total: rows.length, materialized: processed, durationMs };
  }

  await run.succeed({ materialized: processed });
  console.log(
    `🖼️  catalogMediaMaterialize[brand=${brandId}]: done — ` +
    `products=${processed} in ${Math.round(durationMs / 1000)}s`
  );
  return { ok: true, total: rows.length, materialized: processed, durationMs };
}

module.exports = {
  ensureBrandCatalogMediaMaterialized,
  // Exported for tests / verify harness / one-off scripts.
  materializeOne
};
