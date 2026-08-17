// Executor for capability detect.rematchByProduct (Tier 2, brand scope).
//
// Given a CatalogProduct, enqueue rematches on every Media that is
// either:
//   - the catalog wrapper itself (source='catalog-product' with
//     metadata.catalogProductId = target), if includeCatalogSource
//   - matched TO it (Media.matchedProducts.catalogProductId = target),
//     regardless of media source
//
// Priority 1, trigger='manual-rematch'. The DetectRun partial unique
// index on {mediaId} where status ∈ {queued,processing} naturally
// dedupes against runs already in flight; those are counted as
// 'skipped-in-flight' in the response.
//
// Fan-out capped at maxMedia (default 25, hard cap 100). Two-phase
// via the T2 confirmation gate on the capability itself.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const CatalogProduct = require('../../models/CatalogProduct');
const Media = require('../../models/Media');
const DetectRun = require('../../models/DetectRun');

const HARD_CAP = 100;
const DEFAULT_CAP = 25;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawId = args?.catalogProductId;
  if (!rawId) return { ok: false, error: 'catalogProductId required' };
  if (!mongoose.isValidObjectId(rawId)) {
    return { ok: false, error: `catalogProductId "${rawId}" is not a valid ObjectId` };
  }

  const product = await CatalogProduct.findById(rawId).select('_id title brandId advertiserId').lean();
  if (!product) return { ok: false, error: `catalogProduct ${rawId} not found` };

  // Tenant guard — product's brand must belong to caller's advertiser.
  const brand = await Brand.findOne({ _id: product.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `catalogProduct ${rawId} not found` };

  const includeCatalogSource = args?.includeCatalogSource !== false;   // default true
  const maxMedia = Math.max(1, Math.min(HARD_CAP, parseInt(args?.maxMedia, 10) || DEFAULT_CAP));

  const productOid = new mongoose.Types.ObjectId(String(product._id));

  // Two disjoint Media sets:
  //   (a) catalog wrappers whose metadata points at this product
  //   (b) any Media whose matchedProducts includes this product
  // Union deduped by _id. deletedAt-guarded on both.
  const orClauses = [
    { 'matchedProducts.catalogProductId': productOid }
  ];
  if (includeCatalogSource) {
    orClauses.push({
      source: 'catalog-product',
      'metadata.catalogProductId': productOid
    });
  }

  const medias = await Media.find({
    advertiserId: req.advertiserId,
    brandId:      brand._id,
    deletedAt:    null,
    $or:          orClauses
  })
  .select('_id source fileType metadata deletedAt')
  .limit(HARD_CAP + 1)   // one extra so we can detect "cap exceeded"
  .lean();

  if (!medias.length) {
    return {
      ok: true,
      kind: 'detectRematchByProduct',
      data: {
        catalogProductId: String(product._id),
        productTitle:     product.title,
        brandId:          String(brand._id),
        brandName:        brand.name,
        matched:          0,
        note:             'no media found for this product — nothing to rematch'
      }
    };
  }

  if (medias.length > maxMedia) {
    return {
      ok: false,
      error: `${medias.length} media match this product (> maxMedia=${maxMedia}). Narrow scope by setting includeCatalogSource=false, or raise maxMedia (hard cap ${HARD_CAP}).`,
      count: medias.length
    };
  }

  // Enqueue. Handle the in-flight uniqueness index gracefully — a Media
  // that already has a queued/processing run should be counted as
  // 'skipped-in-flight', not treated as an error.
  const enqueued = [];
  const skipped  = [];
  for (const m of medias) {
    try {
      const dr = await DetectRun.create({
        advertiserId: req.advertiserId,
        brandId:      brand._id,
        mediaId:      m._id,
        status:       'queued',
        stage:        'queued',
        trigger:      'manual-rematch',
        priority:     1
      });
      enqueued.push({
        runId:   String(dr._id),
        mediaId: String(m._id),
        source:  m.source,
        fileType: m.fileType
      });
    } catch (err) {
      if (err?.code === 11000) {
        skipped.push({ mediaId: String(m._id), reason: 'in-flight run already exists (queued or processing)' });
      } else {
        skipped.push({ mediaId: String(m._id), reason: `enqueue failed: ${err.message}` });
      }
    }
  }

  return {
    ok: true,
    kind: 'detectRematchByProduct',
    data: {
      catalogProductId: String(product._id),
      productTitle:     product.title,
      brandId:          String(brand._id),
      brandName:        brand.name,
      matched:          medias.length,
      enqueued:         enqueued.length,
      skipped:          skipped.length,
      runs:             enqueued.slice(0, 100),
      skips:            skipped.slice(0, 100),
      note: 'Rematches queued at priority 1 (jumps ahead of routine catalog / IG-sync runs). Each fires a full DetectRun — YOLO + identify + subjects/text + crops + match. If you only need re-matching (fixes shipped in adbadba), use match.rescoreOnly for ~10× cheaper reruns that skip YOLO.'
    }
  };
}

module.exports = { run };
