// Executor for capability media.classifyImage (Tier 1, brand scope).
//
// Targets Media docs directly — the UGC counterpart to
// catalog.classifyImages. Runs the same free (sharp-only) shot-style
// classifier and writes Media.technicalInsights.
//
// Two shapes:
//   { mediaId }                       single row
//   { brandId, mediaIds: [...] }      bulk (up to 500)
//
// force:true bypasses shouldApplyStoredShot's first-write-only guard:
// by default a Media that already carries technicalInsights.shotStyle
// is skipped (the ingest-time doctrine — a URL is stable, heuristics
// don't shift). force is the "no really, reclassify this" opt-in.

'use strict';

const mongoose = require('mongoose');
const Media = require('../../models/Media');
const Brand = require('../../models/Brand');
const ingestShotClassify = require('../ingestShotClassifyService');

const MAX_MEDIA_PER_CALL = 500;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  if (!ingestShotClassify.isEnabled()) {
    return { ok: false, error: 'CATALOG_INGEST_SHOT_CLASSIFY_ENABLED=false — classifier disabled at the env level' };
  }
  const force = args?.force === true;

  // Two-shape input handling.
  let mediaIds;
  if (args?.mediaId) {
    if (!mongoose.isValidObjectId(args.mediaId)) {
      return { ok: false, error: `mediaId "${args.mediaId}" is not a valid ObjectId` };
    }
    mediaIds = [args.mediaId];
  } else if (Array.isArray(args?.mediaIds)) {
    const invalid = args.mediaIds.filter(id => !mongoose.isValidObjectId(id));
    if (invalid.length) {
      return { ok: false, error: `${invalid.length} mediaId(s) invalid — first: "${String(invalid[0]).slice(0, 40)}"` };
    }
    if (args.mediaIds.length === 0) return { ok: false, error: 'mediaIds[] must be non-empty' };
    if (args.mediaIds.length > MAX_MEDIA_PER_CALL) {
      return { ok: false, error: `mediaIds[] too large (${args.mediaIds.length} > ${MAX_MEDIA_PER_CALL})` };
    }
    mediaIds = args.mediaIds;
  } else {
    return { ok: false, error: 'either mediaId or mediaIds[] required' };
  }

  // Optional brand scope check for the bulk shape — helps operators
  // catch mistakes ("meant to classify Gymshark media, but a Vuori id
  // slipped in") before we run the classifier.
  const brandFilter = args?.brandId ? { brandId: args.brandId } : {};
  if (args?.brandId) {
    if (!mongoose.isValidObjectId(args.brandId)) {
      return { ok: false, error: `brandId "${args.brandId}" is not a valid ObjectId` };
    }
    const brand = await Brand.findOne({ _id: args.brandId, advertiserId: req.advertiserId })
      .select('_id name').lean();
    if (!brand) return { ok: false, error: `brand ${args.brandId} not found` };
  }

  // Tenant scope on the read — same rule the other executors apply.
  const rows = await Media.find({
    _id:          { $in: mediaIds.map(id => new mongoose.Types.ObjectId(String(id))) },
    advertiserId: req.advertiserId,
    ...brandFilter
  }).select('_id brandId fileUrl fileType technicalInsights deletedAt').lean();

  if (rows.length === 0) {
    return { ok: false, error: 'no media found in tenant / brand scope' };
  }

  // Session with the same concurrency + budget defaults ingest uses.
  const session = ingestShotClassify.createSession();
  session.beginClassifyPhase();

  const rollup = {
    considered:      0,
    classified:      0,
    skippedExisting: 0,
    skippedGuard:    0,   // shouldApplyStoredShot said no (not force)
    skippedNoUrl:    0,
    skippedNotImage: 0,
    failed:          0
  };
  const perMedia = [];

  for (const m of rows) {
    if (m.deletedAt) {
      rollup.skippedGuard++;
      perMedia.push({ mediaId: String(m._id), skipped: 'soft-deleted' });
      continue;
    }
    if (m.fileType && m.fileType !== 'image') {
      rollup.skippedNotImage++;
      perMedia.push({ mediaId: String(m._id), skipped: `fileType=${m.fileType}` });
      continue;
    }
    if (!m.fileUrl) {
      rollup.skippedNoUrl++;
      perMedia.push({ mediaId: String(m._id), skipped: 'no fileUrl' });
      continue;
    }

    let result;
    try {
      // Empty existingEntries so classifyUrls always fetches — Media's
      // storage lives on Media.technicalInsights, not in the
      // URL-keyed CatalogProduct.imageShotStyles map, so the "existing"
      // hit shape doesn't apply.
      result = await session.classifyUrls([m.fileUrl], []);
    } catch (err) {
      rollup.failed++;
      perMedia.push({ mediaId: String(m._id), error: err.message });
      continue;
    }
    for (const k of Object.keys(rollup)) {
      if (typeof result.stats?.[k] === 'number') rollup[k] += result.stats[k];
    }
    const fresh = (result.fresh || []).find(e => e.url === m.fileUrl);
    if (!fresh) {
      perMedia.push({ mediaId: String(m._id), skipped: 'classifier returned no entry' });
      continue;
    }

    // First-write-only guard bypassed by force:true.
    const storedShot = ingestShotClassify.technicalInsightsFromStored(fresh);
    if (!force && !ingestShotClassify.shouldApplyStoredShot(m.technicalInsights, storedShot)) {
      rollup.skippedGuard++;
      perMedia.push({ mediaId: String(m._id), skipped: 'already carries shotStyle (use force:true to overwrite)' });
      continue;
    }

    try {
      await Media.updateOne(
        { _id: m._id, advertiserId: req.advertiserId },
        { $set: {
            'technicalInsights.shotStyle':           storedShot.shotStyle,
            'technicalInsights.shotStyleConfidence': storedShot.shotStyleConfidence,
            'technicalInsights.shotStyleMetrics':    storedShot.shotStyleMetrics,
            'technicalInsights.updatedAt':           storedShot.updatedAt
        } }
      );
      perMedia.push({
        mediaId:            String(m._id),
        shotStyle:          storedShot.shotStyle,
        confidence:         storedShot.shotStyleConfidence
      });
    } catch (err) {
      rollup.failed++;
      perMedia.push({ mediaId: String(m._id), error: `write failed: ${err.message}` });
    }
  }

  return {
    ok: true,
    kind: 'mediaClassifyImage',
    data: {
      requested:  mediaIds.length,
      resolved:   rows.length,
      force,
      rollup,
      perMedia:   perMedia.slice(0, 100),
      perMediaTruncated: perMedia.length > 100 ? perMedia.length - 100 : 0
    }
  };
}

module.exports = { run };
