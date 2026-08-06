// Executor for capability aiLayouts.generate (Tier 2, brand scope).
//
// Kicks off an AiLayoutSession — an async LLM-driven layout studio
// pass across N variants × M aspect ratios. Mirrors POST /api/ai-
// layouts/generate: creates the session doc, fires runSession via
// setImmediate, returns the sessionId immediately. Client polls
// aiLayouts.getSession for status + references[].
//
// Cost: each combo runs gpt-image-1 at the requested quality.
// low ~$0.02/combo, medium ~$0.05, high ~$0.15. Default is 3 variants
// × 3 aspect ratios × low = ~$0.20. estimateUsd sizes for the upper
// bound at low quality; higher quality is opt-in and priced separately
// (declared here to keep the reservation simple).

'use strict';

const mongoose = require('mongoose');
const Media = require('../../models/Media');
const AiLayoutSession = require('../../models/AiLayoutSession');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawMediaId = args?.mediaId;
  if (!rawMediaId) return { ok: false, error: 'mediaId required' };
  if (!mongoose.isValidObjectId(rawMediaId)) {
    return { ok: false, error: `mediaId "${rawMediaId}" is not a valid ObjectId` };
  }
  const quality = args?.quality || 'low';
  if (!['low', 'medium', 'high'].includes(quality)) {
    return { ok: false, error: `quality must be one of: low, medium, high` };
  }

  const media = await Media.findOne({ _id: rawMediaId, advertiserId: req.advertiserId })
    .select('_id brandId advertiserId deletedAt')
    .lean();
  if (!media) return { ok: false, error: `media ${rawMediaId} not found` };
  if (media.deletedAt) return { ok: false, error: 'media is soft-deleted' };

  // Resolve the studio's default variants/aspectRatios at run time so
  // an out-of-tree schema drift doesn't ship a broken enum.
  const { DEFAULT_VARIANTS, DEFAULT_ASPECT_RATIOS } = require('../aiLayoutStudioService');
  const variants = Array.isArray(args?.variants) && args.variants.length
    ? args.variants.filter((v) => DEFAULT_VARIANTS.includes(v))
    : DEFAULT_VARIANTS;
  const aspectRatios = Array.isArray(args?.aspectRatios) && args.aspectRatios.length
    ? args.aspectRatios.filter((r) => DEFAULT_ASPECT_RATIOS.includes(r))
    : DEFAULT_ASPECT_RATIOS;
  if (!variants.length) {
    return { ok: false, error: `no valid variants — allowed: ${DEFAULT_VARIANTS.join(', ')}` };
  }
  if (!aspectRatios.length) {
    return { ok: false, error: `no valid aspectRatios — allowed: ${DEFAULT_ASPECT_RATIOS.join(', ')}` };
  }

  const session = await AiLayoutSession.create({
    advertiserId: req.advertiserId,
    brandId:      media.brandId || null,
    userId:       req.user?.userId || null,
    mediaId:      media._id,
    variants,
    aspectRatios,
    quality,
    status:       'queued',
    totalCombos:  variants.length * aspectRatios.length
  });

  // Fire-and-forget. The async worker writes back to the session doc.
  setImmediate(() => {
    try {
      const { runSession } = require('../aiLayoutStudioService');
      runSession(session._id);
    } catch (err) {
      console.warn(`aiLayouts.generate: runSession dispatch failed: ${err.message}`);
    }
  });

  return {
    ok: true,
    kind: 'layoutSession',
    data: {
      sessionId:    String(session._id),
      mediaId:      String(media._id),
      brandId:      media.brandId ? String(media.brandId) : null,
      variants,
      aspectRatios,
      quality,
      totalCombos:  session.totalCombos,
      status:       'queued',
      note: `Session queued. Poll aiLayouts.getSession with sessionId="${session._id}" to watch progress. Typical wall time: ~${session.totalCombos * 12}s at quality=${quality}.`
    }
  };
}

module.exports = { run };
