// Executor for capability detect.rematchCatalogProduct (Tier 2, brand scope).
//
// Companion to detect.rematch. That capability refuses catalog-product
// wrapper Media on the grounds that "catalog wrappers are pipeline-
// internal" — which was correct at the time it was written but was
// invalidated by the 2026-08-13 finding that catalog-source runs
// account for 62% of detect traffic AND account for 100% of the
// yoloFailed=true rows (23% failure rate). Rerunning them from the
// agent is the operator's only lever to recover from a YOLO timeout
// on a catalog SKU.
//
// Kept Tier 2 — this IS a paid pipeline pass (YOLO + Gemini identify
// on the vision path), so spendGuard bookkeeping applies through the
// per-image detect billing.

'use strict';

const mongoose = require('mongoose');
const Media = require('../../models/Media');
const DetectRun = require('../../models/DetectRun');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawMediaId = args?.mediaId;
  if (!rawMediaId) return { ok: false, error: 'mediaId required' };
  if (!mongoose.isValidObjectId(rawMediaId)) {
    return { ok: false, error: `mediaId "${rawMediaId}" is not a valid ObjectId` };
  }

  const media = await Media.findOne({ _id: rawMediaId, advertiserId: req.advertiserId })
    .select('_id brandId fileType source deletedAt fileName metadata')
    .lean();
  if (!media) return { ok: false, error: `media ${rawMediaId} not found` };
  if (media.source !== 'catalog-product') {
    return { ok: false, error: `media source is "${media.source}" — use detect.rematch instead (this capability is specifically for catalog-product wrappers)` };
  }
  if (media.deletedAt) {
    return { ok: false, error: 'media is soft-deleted — restore first before rematch' };
  }

  // Guard against duplicate in-flight runs. The DetectRun partial
  // unique index on {mediaId} where status ∈ {queued,processing} will
  // raise E11000; we handle it explicitly so the agent gets a clean
  // "already in flight" reply instead of a Mongo error string.
  try {
    const detectRun = await DetectRun.create({
      advertiserId: req.advertiserId,
      brandId:      media.brandId || null,
      mediaId:      media._id,
      status:       'queued',
      stage:        'queued',
      trigger:      'manual-rematch',
      priority:     1
    });
    return {
      ok: true,
      kind: 'detectRun',
      data: {
        runId:            String(detectRun._id),
        mediaId:          String(media._id),
        brandId:          media.brandId ? String(media.brandId) : null,
        catalogProductId: media.metadata?.catalogProductId ? String(media.metadata.catalogProductId) : null,
        fileType:         media.fileType,
        status:           'queued',
        priority:         1,
        note: 'Catalog-product rematch enqueued at priority 1. YOLO + subjects/text + crops re-run; skips identify (catalog is source-of-truth for SKU).'
      }
    };
  } catch (err) {
    if (err?.code === 11000) {
      return { ok: false, error: 'another DetectRun for this Media is already queued or processing — wait for it to complete before rematching' };
    }
    throw err;
  }
}

module.exports = { run };
