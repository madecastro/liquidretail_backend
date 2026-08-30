// Per-Media YOLO+refine helper.
//
// Populates Media.refinedProducts[] from raw YOLO detections. Two paths,
// forked on media.source, both writing the SAME shape so downstream consumers
// (reframeStrategyChooser, videoProductAnchor, pmaxSplitStrategy,
// quoteProvenance) don't care which fired:
//
//   catalog-product + YOLO detected  → SYNTHESIZE from CatalogProduct
//     metadata ($0, label = product.title which is more specific than
//     GPT-4.1 Vision's generic "shoe"/"handbag").
//   catalog-product + YOLO empty     → PAID GPT-4.1 Vision refine
//     (~$0.03/media). YOLOv8x's COCO classes miss fashion / beauty /
//     jewelry SKUs; refine's vision model can find them, and paying
//     is preferable to synthesizing whole-image which degrades geometric
//     consumers (pmaxSplitStrategy centroid, reframe crop-first fit).
//   any other source (UGC, etc.)     → PAID GPT-4.1 Vision refine.
//     UGC identification is the whole point of refine on those paths.
//
// Every refined entry carries a `source` field ('synthesized' | 'gpt-refine' |
// 'backfill') so a future audit can tell how each bbox was produced without
// re-deriving.
//
// MONEY: this is where the paid vision call lives (refineDetectionCrops →
// GPT-4.1 Vision via atlasLlmService). No other paid step in this module.
//
// Idempotency: refinedProducts.length > 0 → skip. Caller (backfill /
// orchestrator) enforces the same predicate up-front to avoid downloading
// bytes we won't use.

'use strict';

const axios = require('axios');
const Media = require('../models/Media');
const CatalogProduct = require('../models/CatalogProduct');
const yoloService = require('./yoloService');
const { refineDetectionCrops } = require('./cropRefineService');

// Bytes-fetch timeout for the source URL. Long enough for a slow Cloudinary
// origin, short enough to fail loud when the URL is dead.
const IMAGE_FETCH_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.MEDIA_YOLO_IMAGE_FETCH_TIMEOUT_MS, 10) || 60_000
);

// Refuse to buffer huge assets — YOLO service has its own limit but a wild
// upstream file can OOM this process's HTTP client before we even reach the
// microservice. Matches ingestShotClassifyService.maxBytes shape.
const IMAGE_FETCH_MAX_BYTES = Math.max(
  64_000,
  parseInt(process.env.MEDIA_YOLO_IMAGE_FETCH_MAX_BYTES, 10) || 20_000_000
);

async function downloadImageBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout:      IMAGE_FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    maxContentLength: IMAGE_FETCH_MAX_BYTES,
    maxBodyLength:    IMAGE_FETCH_MAX_BYTES,
    // treat any 2xx as ok; let axios throw otherwise
    validateStatus: (s) => s >= 200 && s < 300
  });
  return Buffer.from(res.data);
}

// Pick YOLO's best detection to represent the whole catalog product:
// highest confidence with a plausible-size bbox. Filter tiny junk (< 4% of
// image area) so a single-pixel spurious detection doesn't become the
// "product bbox".
function pickBestDetection(detections, imgW, imgH) {
  if (!Array.isArray(detections) || !detections.length) return null;
  if (!(imgW > 0 && imgH > 0)) return detections[0];
  const minArea = imgW * imgH * 0.04;
  const sizeable = detections.filter((d) => {
    const a = Math.max(0, (d.x2 - d.x1)) * Math.max(0, (d.y2 - d.y1));
    return a >= minArea;
  });
  const pool = sizeable.length ? sizeable : detections;
  return pool.reduce((best, d) => ((d.confidence || 0) > (best.confidence || 0) ? d : best), pool[0]);
}

function buildCloudinaryCropUrl(sourceUrl, { x1, y1, x2, y2 }) {
  if (!sourceUrl || typeof sourceUrl !== 'string') return null;
  if (!sourceUrl.includes('/image/upload/')) return null;
  const w = Math.round(x2 - x1);
  const h = Math.round(y2 - y1);
  const x = Math.round(x1);
  const y = Math.round(y1);
  return sourceUrl.replace(
    '/image/upload/',
    `/image/upload/c_crop,w_${w},h_${h},x_${x},y_${y},f_jpg,q_auto:good/`
  );
}

// Synthesize a single refinedProducts entry for a catalog-product Media
// from CatalogProduct metadata + YOLO's best detection (or whole-image
// fallback). Pure — no I/O; caller supplies product doc + yolo result.
function synthesizeRefinedFromCatalog({ yolo, media, product }) {
  const imgW = yolo?.width  || media?.width  || 0;
  const imgH = yolo?.height || media?.height || 0;
  const best = pickBestDetection(yolo?.detections || [], imgW, imgH);
  const bbox = best
    ? { x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 }
    : (imgW > 0 && imgH > 0
        ? { x1: 0, y1: 0, x2: imgW, y2: imgH }
        : null);
  if (!bbox) return [];
  return [{
    id:         'r1',
    label:      product?.title || null,
    brand:      product?.brand || null,
    category:   product?.category || null,
    confidence: best ? Number(best.confidence) || 0.5 : 0.5,
    className:  best?.className || null,
    x1: bbox.x1, y1: bbox.y1, x2: bbox.x2, y2: bbox.y2,
    imgWidth:  imgW,
    imgHeight: imgH,
    cropUrl:   buildCloudinaryCropUrl(media.fileUrl, bbox),
    source:    best ? 'synthesized' : 'synthesized-fallback'
  }];
}

// Tag every refined entry produced by GPT-4.1 refine with source='gpt-refine'
// so downstream audits can tell how a bbox was produced. refineDetectionCrops
// returns its own shape; we don't alter fields, just annotate.
function stampGptRefineSource(refined) {
  if (!Array.isArray(refined)) return [];
  return refined.map((r) => ({ ...r, source: 'gpt-refine' }));
}

/**
 * Detect YOLO on ONE Media doc and write refinedProducts + yoloProducts +
 * yoloDetectedAt. Idempotent — short-circuits when refinedProducts is
 * already populated.
 *
 * @param {object} media  — the Media doc (lean or full)
 * @param {object} opts
 * @param {'ingest'|'backfill'} [opts.trigger='ingest']  — labels the
 *   'source' field on synthesized entries so we can trace which pass
 *   populated a given row (also written to Media meta).
 * @returns {Promise<{status:'ok'|'skipped', reason?:string, refinedCount?:number, path?:string}>}
 */
async function detectYoloForMedia(media, { trigger = 'ingest' } = {}) {
  if (!media || !media._id) {
    return { status: 'skipped', reason: 'no-media' };
  }
  if (Array.isArray(media.refinedProducts) && media.refinedProducts.length > 0) {
    return { status: 'skipped', reason: 'already-refined' };
  }
  if (!media.fileUrl) {
    return { status: 'skipped', reason: 'no-fileUrl' };
  }

  const buffer = await downloadImageBuffer(media.fileUrl);
  const yolo   = await yoloService.detectMultipleProducts(buffer);
  const yoloDetections = yolo?.detections || [];

  // Fork on media.source + YOLO signal.
  let refined = [];
  let path;
  const isCatalog = media.source === 'catalog-product';
  if (isCatalog && yoloDetections.length > 0) {
    const productId = media.metadata?.catalogProductId || media.productId || null;
    const product = productId ? await CatalogProduct.findById(productId).select('title brand category').lean() : null;
    refined = synthesizeRefinedFromCatalog({ yolo, media, product });
    path = 'synthesized';
    // Backfill trigger overrides so audits can distinguish backfill drainage
    // from ingest-time synthesis, even though the math is identical.
    if (trigger === 'backfill') {
      refined = refined.map((r) => ({ ...r, source: 'backfill' }));
    }
  } else {
    // Catalog-empty OR any non-catalog source → paid GPT-4.1 refine.
    // Yolo detections carry per-detection cropBuffers; refineDetectionCrops
    // expects the same shape as pipelines/detect.js passes it.
    const refinedRaw = await refineDetectionCrops(yoloDetections, media.fileUrl, {
      brandId:   media.brandId,
      productId: media.metadata?.catalogProductId || media.productId || null
    });
    refined = stampGptRefineSource(refinedRaw);
    path = 'gpt-refine';
    if (trigger === 'backfill') {
      refined = refined.map((r) => ({ ...r, source: r.source ? `backfill:${r.source}` : 'backfill' }));
    }
  }

  // Persist. yoloProducts stores the raw YOLO output so a future consumer
  // can re-derive without another YOLO call; refinedProducts is what most
  // consumers read.
  await Media.updateOne(
    { _id: media._id },
    { $set: {
        yoloProducts:    yoloDetections,
        refinedProducts: refined,
        yoloDetectedAt:  new Date()
    } }
  );

  return { status: 'ok', refinedCount: refined.length, path };
}

module.exports = {
  detectYoloForMedia,
  // Exported for the verify harness — pure helpers so fixtures can
  // exercise the fork without HTTP.
  __test: {
    pickBestDetection,
    buildCloudinaryCropUrl,
    synthesizeRefinedFromCatalog,
    stampGptRefineSource
  }
};
