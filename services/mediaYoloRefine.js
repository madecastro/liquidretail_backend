// Per-Media YOLO+refine helper.
//
// Populates Media.refinedProducts[] from YOLO service detections. Two paths,
// forked on media.source, both writing the SAME shape so downstream consumers
// (reframeStrategyChooser, videoProductAnchor, pmaxSplitStrategy,
// quoteProvenance) don't care which fired:
//
//   catalog-product  → sends a PROMPT (built from CatalogProduct.category
//     + title) to yolo_microservice, which routes through Grounding DINO
//     (open-vocab detection). Eval showed 100% detection + 100% correct
//     labels vs COCO's 78%/22%. If detections hit → SYNTHESIZE with
//     product.title as the label ($0, no paid refine). If open-vocab
//     returned empty → PAID GPT-4.1 Vision refine (~$0.03/media) as
//     fallback, though this branch fires rarely at Grounding DINO's
//     recall rate.
//
//   any other source (UGC, etc.)     → No prompt; yolo_microservice runs
//     YOLOv8x-COCO + OpenCV + OAI (existing pipeline). Then PAID GPT-4.1
//     Vision refine — UGC identification is the whole point of refine on
//     those paths.
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

// yolo_microservice slot-level codes that mean the SOURCE is bad and no
// number of retries will change that. Must match the single-call
// PERMANENT_YOLO_CODES set in services/yoloService.js so batch and
// single paths mark Media identically. Any code the microservice can
// emit that requires human data-cleanup should live in BOTH sets.
const PERMANENT_SLOT_CODES = new Set([
  'unidentified-image',
  'decode-error',
  'empty-body',
  'missing-image'
]);

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

// Build a Grounding DINO prompt from CatalogProduct metadata. Period-
// separated class strings ("shoe. sneaker. espadrille.") — that's what
// Grounding DINO expects. Prioritizes category (most reliable signal),
// then trailing tokens from title (usually noun-ish), then generic
// fallbacks so the model always has something to work with.
//
// Pure — no I/O. Exported for the verify harness so it can pin the
// heuristic on fixtures.
function buildOpenVocabPrompt({ title, category, brand } = {}) {
  const parts = [];
  if (category && typeof category === 'string') {
    parts.push(
      ...category.split(/[>|/,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    );
  }
  if (title && typeof title === 'string') {
    const tokens = title.toLowerCase().match(/[a-z]+/g) || [];
    if (tokens.length) {
      parts.push(tokens[tokens.length - 1]);
      if (tokens.length >= 2) parts.push(tokens.slice(-2).join(' '));
    }
  }
  parts.push('product', 'object');
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const norm = (p || '').trim().toLowerCase();
    if (norm && !seen.has(norm) && norm.length <= 30) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out.slice(0, 8).join('. ') + '.';
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

  const isCatalog = media.source === 'catalog-product';

  // For catalog Media: load CatalogProduct FIRST so we can:
  //   (a) build the open-vocab prompt from category/title
  //   (b) synthesize refinedProducts with product.title as label if
  //       Grounding DINO returns hits
  // For UGC/other: skip the product load, skip the prompt — yolo_service
  // will run the existing COCO+rects+OAI pipeline and we fall through to
  // paid refine (unchanged behaviour).
  let product = null;
  let openVocabPrompt = null;
  if (isCatalog) {
    const productId = media.metadata?.catalogProductId || media.productId || null;
    if (productId) {
      product = await CatalogProduct.findById(productId).select('title brand category').lean();
    }
    openVocabPrompt = buildOpenVocabPrompt({
      title:    product?.title,
      category: product?.category,
      brand:    product?.brand,
    });
  }

  const buffer = await downloadImageBuffer(media.fileUrl);
  let yolo;
  try {
    yolo = await yoloService.detectMultipleProducts(buffer, {
      prompt: openVocabPrompt,   // null / omitted for UGC = existing behaviour
    });
  } catch (err) {
    // Permanent yolo failures — bad image bytes, HTML error page from
    // Cloudinary at media.fileUrl, decode error — must not roll around
    // next backfill tick. Stamp yoloDetectedAt + yoloFailReason so the
    // worker's yoloBackfillTick query (filters on yoloDetectedAt:null)
    // excludes this Media from now on. refinedProducts stays empty —
    // downstream consumers already treat empty as "no detections".
    // Transient errors (ECONNRESET, timeout) re-throw so caller /
    // backfill sees them as retryable and picks the Media up again.
    if (err && err.permanent) {
      await Media.updateOne(
        { _id: media._id },
        { $set: {
            yoloDetectedAt: new Date(),
            yoloFailReason: err.yoloCode || err.yoloKind || 'permanent-failure'
        } }
      );
      console.warn(`⚠️  detectYoloForMedia[${media._id}]: PERMANENT ${err.yoloCode || err.yoloKind} — stamped, will not re-queue`);
      return { status: 'skipped', reason: err.yoloCode || 'permanent-failure' };
    }
    throw err;
  }
  const yoloDetections = yolo?.detections || [];

  // Fork on media.source + YOLO signal.
  let refined = [];
  let path;
  if (isCatalog && yoloDetections.length > 0) {
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

/**
 * BATCH variant of detectYoloForMedia — shares one HTTP call to
 * yolo_microservice /detect-batch across N Media, then applies the SAME
 * per-Media fork (synthesize on catalog+hit; paid refine on
 * catalog-empty or UGC) and persists each result independently. Callers
 * are expected to group by product (catalog Media of one product share
 * one Grounding DINO prompt); mixing products is legal but wastes the
 * batch's prompt-parallelism benefit.
 *
 * Amortizes the fixed HTTP + Flask + Python overhead over N images.
 * Measured ~30% wall reduction per image on the microservice CPU box
 * plus a further ~10-15% when Grounding DINO can batch model.forward().
 *
 * @param {Array} mediaList  — array of Media docs (lean or full)
 * @param {object} opts
 * @param {object} [opts.product]  — CatalogProduct for the group (all
 *   `catalog-product` Media in mediaList must belong to this product).
 *   UGC Media in the batch are unaffected — their slot gets no prompt.
 * @param {'ingest'|'backfill'} [opts.trigger='ingest']
 * @returns {Promise<Array<{mediaId, status, refinedCount?, path?, reason?}>>}
 */
async function detectYoloForMediaBatch(mediaList, { product = null, trigger = 'ingest' } = {}) {
  const inList = Array.isArray(mediaList) ? mediaList : [];
  if (!inList.length) return [];

  // Filter skip-cases upfront so the batch only carries real work.
  // Preserve the input Media order in `results` — callers rely on that
  // to correlate back to their own state.
  const results = new Array(inList.length);
  const eligibleIndexes = [];
  for (let i = 0; i < inList.length; i++) {
    const media = inList[i];
    if (!media || !media._id) {
      results[i] = { mediaId: null, status: 'skipped', reason: 'no-media' };
      continue;
    }
    if (Array.isArray(media.refinedProducts) && media.refinedProducts.length > 0) {
      results[i] = { mediaId: media._id, status: 'skipped', reason: 'already-refined' };
      continue;
    }
    if (!media.fileUrl) {
      results[i] = { mediaId: media._id, status: 'skipped', reason: 'no-fileUrl' };
      continue;
    }
    eligibleIndexes.push(i);
  }
  if (!eligibleIndexes.length) return results;

  // Build the Grounding DINO prompt ONCE for the whole product — every
  // catalog-product Media in the batch shares it. UGC Media get a null
  // prompt (routes their slot through the COCO+rects+OAI path).
  const groupPrompt = product
    ? buildOpenVocabPrompt({
        title:    product.title,
        category: product.category,
        brand:    product.brand
      })
    : null;

  // Download in parallel — network dominates and buffers stay per-Media.
  const buffers = await Promise.all(eligibleIndexes.map(async (idx) => {
    try {
      return await downloadImageBuffer(inList[idx].fileUrl);
    } catch (err) {
      return { __error: err };
    }
  }));

  // Split into a real batch (successful downloads) and per-Media errors.
  const batchItems = [];
  const batchToIdx = [];
  for (let k = 0; k < eligibleIndexes.length; k++) {
    const idx = eligibleIndexes[k];
    const buf = buffers[k];
    if (buf && buf.__error) {
      results[idx] = { mediaId: inList[idx]._id, status: 'failed', reason: 'download-failed', error: buf.__error.message };
      continue;
    }
    const media = inList[idx];
    const isCatalog = media.source === 'catalog-product';
    batchItems.push({
      buffer: buf,
      prompt: isCatalog ? groupPrompt : null
    });
    batchToIdx.push(idx);
  }
  if (!batchItems.length) return results;

  let yoloResults;
  try {
    ({ results: yoloResults } = await yoloService.detectBatch(batchItems));
  } catch (err) {
    // Whole-batch permanent failure — bubble up so the orchestrator counts
    // each target as failed. Whole-batch transient failures are already
    // handled by yoloService.detectBatch's retry loop; if that exhausted,
    // let the caller retry the whole product on the next backfill tick.
    throw err;
  }

  // Per-Media fork on the returned slots. Three cases:
  //   (a) slot carries a PERMANENT code — mark that Media as bad-source,
  //       do NOT let it re-queue (yoloDetectedAt stamp + yoloFailReason).
  //   (b) slot has detections — fork on media.source (catalog synthesize
  //       or paid refine).
  //   (c) slot has no detections + no code — treated as legitimate empty,
  //       falls through to catalog synthesize (fallback bbox) or paid
  //       refine on UGC. Existing behaviour.
  await Promise.all(batchToIdx.map(async (idx, k) => {
    const media = inList[idx];
    const yolo = yoloResults[k] || { detections: [] };
    const slotCode = yolo.code || null;
    // Per-slot permanent failure — must not re-queue on the next
    // backfill tick. Kept out of the persist branch below because we
    // set yoloFailReason and skip refinedProducts entirely.
    if (slotCode && PERMANENT_SLOT_CODES.has(slotCode)) {
      try {
        await Media.updateOne(
          { _id: media._id },
          { $set: {
              yoloDetectedAt: new Date(),
              yoloFailReason: slotCode
          } }
        );
        console.warn(`⚠️  detectYoloForMediaBatch[${media._id}]: PERMANENT ${slotCode} — stamped, will not re-queue`);
        results[idx] = { mediaId: media._id, status: 'skipped', reason: slotCode };
      } catch (err) {
        results[idx] = { mediaId: media._id, status: 'failed', reason: 'persist-failed', error: err.message };
      }
      return;
    }
    const yoloDetections = yolo.detections || [];
    const isCatalog = media.source === 'catalog-product';

    let refined = [];
    let path;
    try {
      if (isCatalog && yoloDetections.length > 0) {
        refined = synthesizeRefinedFromCatalog({ yolo, media, product });
        path = 'synthesized';
        if (trigger === 'backfill') refined = refined.map((r) => ({ ...r, source: 'backfill' }));
      } else {
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

      await Media.updateOne(
        { _id: media._id },
        { $set: {
            yoloProducts:    yoloDetections,
            refinedProducts: refined,
            yoloDetectedAt:  new Date()
        } }
      );
      results[idx] = { mediaId: media._id, status: 'ok', refinedCount: refined.length, path };
    } catch (err) {
      results[idx] = { mediaId: media._id, status: 'failed', reason: 'persist-failed', error: err.message };
    }
  }));

  return results;
}

module.exports = {
  detectYoloForMedia,
  detectYoloForMediaBatch,
  buildOpenVocabPrompt,
  // Exported for the verify harness — pure helpers so fixtures can
  // exercise the fork without HTTP.
  __test: {
    pickBestDetection,
    buildCloudinaryCropUrl,
    synthesizeRefinedFromCatalog,
    stampGptRefineSource,
    buildOpenVocabPrompt
  }
};
