// Executor for capability detect.process (Tier 2, brand scope).
//
// Enqueue a fresh DetectRun for one Media. The worker picks it up and
// runs YOLO → subjects/text → smart-crops → product-match → overlay
// zones asynchronously. Refuses catalog-product wrapper Media (those
// are pipeline-internal) and soft-deleted Media.
//
// Cost: ~$0.05 per image on the YOLO microservice + Gemini identify.
// spendGuard reserves the estimate against the daily cap before the
// DetectRun is queued. The pipeline may re-use existing artifacts
// where the Media hasn't changed (crops, detection), so real cost
// varies below the estimate; we book the upper bound.

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
    .select('_id brandId fileType source deletedAt fileName externalId')
    .lean();
  if (!media) return { ok: false, error: `media ${rawMediaId} not found` };
  if (media.source === 'catalog-product') {
    return { ok: false, error: 'refusing to detect a catalog-product wrapper Media — those are pipeline-internal' };
  }
  if (media.deletedAt) {
    return { ok: false, error: 'media is soft-deleted — restore first before running detect' };
  }

  const detectRun = await DetectRun.create({
    advertiserId: req.advertiserId,
    brandId:      media.brandId || null,
    mediaId:      media._id,
    status:       'queued',
    stage:        'queued',
    trigger:      'manual'
  });

  return {
    ok: true,
    kind: 'detectRun',
    data: {
      runId:    String(detectRun._id),
      mediaId:  String(media._id),
      brandId:  media.brandId ? String(media.brandId) : null,
      fileType: media.fileType,
      fileName: media.fileName || null,
      status:   'queued',
      note: 'DetectRun enqueued. Worker picks it up next tick; poll run.status to watch progress. Typical run time: ~8s image / ~30-60s video.'
    }
  };
}

module.exports = { run };
