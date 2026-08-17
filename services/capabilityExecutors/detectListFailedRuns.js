// Executor for capability detect.listFailedRuns (Tier 0, brand scope).
//
// Enumerate DetectRuns that produced a bad outcome so the agent can
// then feed them into detect.rematch / .rematchCatalogProduct /
// match.rescoreOnly. Read-only.
//
// kind filters (default 'all-failures'):
//   'yolo-failed'   — flags.yoloFailed === true (the 23% failure mode
//                     from the 2026-08-13 sample)
//   'error'         — run.error present OR status='failed'
//   'no-strong-match' — completed run but zero product_match /
//                       product_category outcomes across all
//                       ProductMatchArtifacts for the run
//   'all-failures'  — union of the three
//
// Tenant scope: DetectRun.advertiserId === req.advertiserId. Brand
// scope: DetectRun.brandId === args.brandId (verified against
// advertiser).

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const DetectRun = require('../../models/DetectRun');
const ProductMatchArtifact = require('../../models/ProductMatchArtifact');
const Media = require('../../models/Media');

const MAX_LIMIT   = 200;
const DEFAULT_LIMIT = 50;

const KINDS = new Set(['yolo-failed', 'error', 'no-strong-match', 'all-failures']);

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const kind = args?.kind || 'all-failures';
  if (!KINDS.has(kind)) {
    return { ok: false, error: `kind must be one of: ${[...KINDS].join(', ')}` };
  }

  const sinceHours = Math.max(1, Math.min(24 * 90, parseInt(args?.sinceHours, 10) || 24 * 7));
  const limit      = Math.max(1, Math.min(MAX_LIMIT, parseInt(args?.limit, 10) || DEFAULT_LIMIT));
  const since      = new Date(Date.now() - sinceHours * 3600 * 1000);

  const baseQuery = {
    advertiserId: req.advertiserId,
    brandId:      brand._id,
    createdAt:    { $gte: since }
  };

  // Direct-hit filters
  const yoloFailedQuery = { ...baseQuery, 'flags.yoloFailed': true };
  const errorQuery      = { ...baseQuery, $or: [
    { error: { $exists: true, $ne: null } },
    { status: 'failed' }
  ] };

  let runs = [];
  if (kind === 'yolo-failed') {
    runs = await DetectRun.find(yoloFailedQuery).sort({ createdAt: -1 }).limit(limit).lean();
  } else if (kind === 'error') {
    runs = await DetectRun.find(errorQuery).sort({ createdAt: -1 }).limit(limit).lean();
  } else if (kind === 'no-strong-match' || kind === 'all-failures') {
    // For no-strong-match / all-failures, we need to look at completed
    // runs and filter by whether any ProductMatchArtifact has outcome
    // in {product_match, product_category}. Pull a candidate window
    // wider than `limit` because the strong-match filter is applied
    // post-load.
    const candidateWindow = Math.min(MAX_LIMIT * 3, limit * 5);
    const q = kind === 'all-failures'
      ? { ...baseQuery, $or: [
          { 'flags.yoloFailed': true },
          { error: { $exists: true, $ne: null } },
          { status: 'failed' },
          { status: 'completed' }   // completed runs subject to no-strong-match filter below
        ] }
      : { ...baseQuery, status: 'completed' };
    const candidates = await DetectRun.find(q).sort({ createdAt: -1 }).limit(candidateWindow).lean();

    // Look up strong matches per candidate
    const candidateIds = candidates.map(r => r._id);
    const strong = await ProductMatchArtifact.find({
      runId: { $in: candidateIds },
      outcome: { $in: ['product_match', 'product_category'] }
    }).select('runId').lean();
    const strongByRun = new Set(strong.map(m => String(m.runId)));

    const filtered = candidates.filter(r => {
      if (kind === 'no-strong-match') {
        return r.status === 'completed' && !strongByRun.has(String(r._id));
      }
      // all-failures — include yoloFailed/error/failed unconditionally,
      // completed only if no strong match
      if (r.flags?.yoloFailed || r.error || r.status === 'failed') return true;
      if (r.status === 'completed' && !strongByRun.has(String(r._id))) return true;
      return false;
    });
    runs = filtered.slice(0, limit);
  }

  // Enrich with media source/fileType so the caller can pick the right
  // rematch executor (detect.rematch vs detect.rematchCatalogProduct)
  // without a second lookup.
  const mediaIds = runs.map(r => r.mediaId).filter(Boolean);
  const medias = mediaIds.length
    ? await Media.find({ _id: { $in: mediaIds } }).select('_id source fileType metadata').lean()
    : [];
  const byMedia = new Map(medias.map(m => [String(m._id), m]));

  return {
    ok:   true,
    kind: 'detectFailedRuns',
    data: {
      brandId:   String(brand._id),
      brandName: brand.name,
      kind,
      sinceHours,
      count:     runs.length,
      hitLimit:  runs.length >= limit,
      runs: runs.map(r => {
        const m = byMedia.get(String(r.mediaId));
        return {
          runId:     String(r._id),
          mediaId:   String(r.mediaId),
          status:    r.status,
          trigger:   r.trigger,
          createdAt: r.createdAt,
          completedAt: r.completedAt || null,
          flags: {
            yoloFailed:       !!r.flags?.yoloFailed,
            yoloError:        r.flags?.yoloError || null,
            yoloErrorKind:    r.flags?.yoloErrorKind || null,
            yoloFallbackSynth: !!r.flags?.yoloFallbackSynth,
            yoloDownscaled:   r.flags?.yoloDownscaled || null
          },
          error:      r.error || null,
          errorStage: r.errorStage || null,
          media: m ? {
            source:   m.source,
            fileType: m.fileType,
            catalogProductId: m.metadata?.catalogProductId ? String(m.metadata.catalogProductId) : null,
            // Which rematch executor the agent should call for this row.
            recommendedRematchCapability:
              m.source === 'catalog-product' ? 'detect.rematchCatalogProduct' : 'detect.rematch'
          } : null
        };
      }),
      note: 'Use the returned runId with detect.inspect for full artifact detail, mediaId with detect.rematch / detect.rematchCatalogProduct for a full rerun, or match.rescoreOnly for a cheap match-only rerun (skips YOLO — 10× cheaper).'
    }
  };
}

module.exports = { run };
