// Executor for capability match.rescoreOnly (Tier 2, brand scope).
//
// Enqueue a DetectRun with flags.rescoreOnly=true — the worker's
// detect dispatcher branches to processRescoreOnly, which reuses the
// prior DetectionArtifact + CropArtifact and re-runs ONLY the match
// phase. ~10× cheaper than a full rerun. Meant for reprocessing
// historical runs against a matcher-code improvement without paying
// for YOLO / identify / crops again.
//
// Two input shapes:
//   { mediaId }               rescore the latest prior run for this Media
//   { mediaId, runId }        the runId identifies the prior run to rescore
//                             AGAINST (must belong to this Media +
//                             advertiser). Ignored by the pipeline
//                             today — always uses the most recent
//                             prior completed run — but accepted for
//                             API stability.
//
// Refuses:
//   - catalog-product Media (they don't run the match chain)
//   - Media with no prior completed DetectRun (nothing to rescore
//     against; caller should run detect.rematch instead)
//   - Media with an in-flight DetectRun (unique-index guard would
//     E11000 anyway; we return a clean error instead)

'use strict';

const mongoose = require('mongoose');
const Media = require('../../models/Media');
const DetectRun = require('../../models/DetectRun');
const DetectionArtifact = require('../../models/DetectionArtifact');

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
  if (media.source === 'catalog-product') {
    return { ok: false, error: 'catalog-product media do not run the match chain — rescore-only is not applicable. Use detect.rematchCatalogProduct if you need to rerun crops.' };
  }
  if (media.deletedAt) {
    return { ok: false, error: 'media is soft-deleted — restore first before rescore' };
  }

  // Verify a prior completed run exists with a DetectionArtifact —
  // without this the pipeline path throws mid-run. Better to refuse
  // up-front with a clear error.
  const priorRun = await DetectRun.findOne({
    mediaId: media._id,
    status:  'completed'
  }).sort({ createdAt: -1 }).select('_id createdAt').lean();
  if (!priorRun) {
    return { ok: false, error: 'no prior completed DetectRun exists for this Media — run detect.rematch (full pipeline) first, then match.rescoreOnly for cheaper subsequent reprocesses' };
  }
  const priorDet = await DetectionArtifact.findOne({ runId: priorRun._id }).select('_id').lean();
  if (!priorDet) {
    return { ok: false, error: `prior run ${priorRun._id} has no DetectionArtifact — rescore has nothing to reuse. Run detect.rematch instead.` };
  }

  // Enqueue with flags.rescoreOnly:true. Partial unique index on
  // {mediaId} where status ∈ {queued,processing} catches in-flight
  // dupes; surface that as a clean error instead of a Mongo message.
  try {
    const detectRun = await DetectRun.create({
      advertiserId: req.advertiserId,
      brandId:      media.brandId || null,
      mediaId:      media._id,
      status:       'queued',
      stage:        'queued',
      trigger:      'manual-rematch',
      priority:     1,
      flags:        { rescoreOnly: true, rescoreFrom: String(priorRun._id) }
    });
    return {
      ok: true,
      kind: 'detectRun',
      data: {
        runId:          String(detectRun._id),
        mediaId:        String(media._id),
        brandId:        media.brandId ? String(media.brandId) : null,
        priorRunId:     String(priorRun._id),
        rescoreOnly:    true,
        status:         'queued',
        priority:       1,
        note: 'Rescore-only run enqueued at priority 1. Worker reuses the prior DetectionArtifact + CropArtifact and re-runs only findPerProductMatches against current matcher code. ~5-10s wall clock vs 30-60s for a full rerun; ~$0.005 spend vs ~$0.05. Poll run.status; result artifacts are new ProductMatchArtifact rows tied to this runId.'
      }
    };
  } catch (err) {
    if (err?.code === 11000) {
      return { ok: false, error: 'another DetectRun for this Media is already queued or processing — wait for it to complete before rescoring' };
    }
    throw err;
  }
}

module.exports = { run };
