// Executor for capability media.refreshInsights (Tier 2, brand scope).
//
// Manually refresh Media.platformStats + Comments for one Instagram
// Media. Wraps mediaInsightsService.refreshInsightsForMedia and
// fetchCommentsForMedia — same pair the POST /api/media/:id/refresh-
// insights route triggers.
//
// Tier 2 with estimateUsd=0. IG Graph API calls carry no per-call
// dollar cost, but the spend gate still applies as a rate-limiter so a
// runaway agent can't burn the app's daily IG token budget. Refuses
// non-Instagram Media (other sources have no analytics endpoint).

'use strict';

const mongoose = require('mongoose');
const Media = require('../../models/Media');

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
    .select('_id brandId source externalId fileType')
    .lean();
  if (!media) return { ok: false, error: `media ${rawMediaId} not found` };
  if (media.source !== 'instagram') {
    return { ok: false, error: `media source is "${media.source}" — refresh only supports Instagram-sourced Media` };
  }
  if (!media.externalId) {
    return { ok: false, error: 'media has no externalId — cannot address Meta Graph without it' };
  }

  const { refreshInsightsForMedia, fetchCommentsForMedia } = require('../mediaInsightsService');
  const [statsResult, commentsResult] = await Promise.all([
    refreshInsightsForMedia(media._id),
    fetchCommentsForMedia(media._id)
  ]);

  return {
    ok: true,
    kind: 'mediaUpdate',
    data: {
      _id: String(media._id),
      brandId: media.brandId ? String(media.brandId) : null,
      stats: statsResult?.ok ? statsResult.stats : null,
      statsError: statsResult?.ok ? null : (statsResult?.reason || 'unknown'),
      comments: commentsResult?.ok
        ? {
            fetched:     commentsResult.fetched     || 0,
            upserted:    commentsResult.upserted    || 0,
            totalStored: commentsResult.totalStored || 0
          }
        : null,
      commentsError: commentsResult?.ok ? null : (commentsResult?.reason || 'unknown')
    }
  };
}

module.exports = { run };
