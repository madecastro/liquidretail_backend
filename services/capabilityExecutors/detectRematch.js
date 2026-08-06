// Executor for capability detect.rematch (Tier 1, brand scope).
//
// Same shape as detect.process but stamps trigger='manual-rematch' +
// priority:1 so the worker jumps this run ahead of routine catalog/ig-
// sync runs. Meant to be used when an operator inspects an existing
// DetectRun and decides the outcome was wrong — a "retry, but with
// urgency" signal.
//
// Kept as Tier 1 per the backlog contract: the pipeline may or may
// not re-run YOLO depending on whether artifacts exist; the operator's
// explicit rematch intent implies acceptance of a potential cost hit.
// The daily-cap defense stays via the per-image detect billing that
// lands on OTHER spendGuard rows.

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
    .select('_id brandId fileType source deletedAt fileName')
    .lean();
  if (!media) return { ok: false, error: `media ${rawMediaId} not found` };
  if (media.source === 'catalog-product') {
    return { ok: false, error: 'refusing to rematch a catalog-product wrapper Media' };
  }
  if (media.deletedAt) {
    return { ok: false, error: 'media is soft-deleted — restore first before rematch' };
  }

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
      runId:    String(detectRun._id),
      mediaId:  String(media._id),
      brandId:  media.brandId ? String(media.brandId) : null,
      fileType: media.fileType,
      status:   'queued',
      priority: 1,
      note: 'Rematch enqueued at priority 1 — worker picks it up ahead of routine runs. Poll run.status to watch progress.'
    }
  };
}

module.exports = { run };
