// Executor for capability media.refreshCommentsFromApify (Tier 4, brand scope).
//
// Comment refresh for apify-ig Media rows via the SAME apify/instagram-
// scraper actor used to pull posts, but with resultsType='comments'
// per post permalink. Runs one Apify sync-run per post — costs per
// run — so preview shows the expected total cost and target count
// before execution.
//
// This is the parallel path to media.refreshInsightsForBrand (which
// handles source='instagram' OAuth media). Comments-only — no post
// metadata refresh; the Apify pull captures that at ingest time.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Media = require('../../models/Media');
const { syncBrandInstagramCommentsApify } = require('../apifyIngestService');

// Rough per-post estimate. The actor bills per run + per record so
// 50 comments/post at ~$0.02/run is a reasonable upper bound. Env
// override so operators can tune without a deploy.
const PER_UNIT_ESTIMATE_USD = Number(process.env.APIFY_COMMENTS_PER_UNIT_USD || 0.02);
const MAX_STEPS_PER_RUN = 100;

async function resolveScope({ req, args }) {
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
  return { ok: true, brand };
}

async function preview({ req, args }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;

  const targets = await Media.countDocuments({
    brandId: brand._id,
    source: 'apify-ig',
    deletedAt: null,
    'metadata.permalink': { $exists: true, $ne: null }
  });

  if (targets === 0) {
    // Steer to the right path if the brand has media but not apify-ig.
    const alt = await Media.aggregate([
      { $match: {
          brandId: new mongoose.Types.ObjectId(brand._id),
          source: { $ne: 'catalog-product' },
          deletedAt: null
        }
      },
      { $group: { _id: '$source', count: { $sum: 1 } } }
    ]);
    const sourceCounts = Object.fromEntries((alt || []).map((r) => [r._id, r.count]));
    return {
      ok: false,
      error: `brand has 0 apify-ig Media rows with a permalink. media.refreshCommentsFromApify only handles the Apify-scraped IG path. Existing sources: ${JSON.stringify(sourceCounts)}. For source='instagram' (OAuth) rows, use media.refreshInsightsForBrand.`,
      sourceCounts
    };
  }

  const capped = Math.min(targets, MAX_STEPS_PER_RUN);
  const estimateUsd = Math.round(capped * PER_UNIT_ESTIMATE_USD * 100) / 100;

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'media.refreshCommentsFromApify',
      brand: { _id: String(brand._id), name: brand.name },
      totalApifyMedia: targets,
      totalSteps:      capped,
      capped:          targets > MAX_STEPS_PER_RUN,
      perUnitUsd:      PER_UNIT_ESTIMATE_USD,
      estimateUsd,
      estimateWallMs:  capped * 8_000,   // rough Apify sync-run latency
      reversible:      false,
      summary:         `Pull IG comments for ${capped} apify-ig Media row(s) under ${brand.name} via the same Apify actor used at ingest (resultsType='comments'). Upserts Comment docs by (mediaId, externalId).`,
      note:            'Each post is a separate Apify sync-run. Comments already stored are updated in place (likeCount / replyCount / text). Post metadata itself is not touched — that lives on the Media row.'
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();

  if (typeof onProgress === 'function') {
    try { onProgress({ step: 1, totalSteps: null, stage: 'starting apify comment pull', outcome: 'running' }); }
    catch (_) { /* ignore */ }
  }

  let result;
  try {
    result = await syncBrandInstagramCommentsApify(brand._id, { concurrency: 2 });
  } catch (err) {
    return {
      ok: false,
      kind: 'workflowResult',
      error: `apify comment sync failed: ${err.message}`,
      data: { workflowId: 'media.refreshCommentsFromApify', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'media.refreshCommentsFromApify',
      brand: { _id: String(brand._id), name: brand.name },
      totalSteps: result?.total || 0,
      succeeded:  result?.succeeded || 0,
      failed:     result?.failed || 0,
      commentsFetched:  result?.fetched  || 0,
      commentsUpserted: result?.upserted || 0,
      durationMs: Date.now() - started,
      note: (result?.failed || 0) === 0
        ? 'All posts refreshed successfully.'
        : `${result.failed} post(s) failed — usually a private account, deleted post, or Apify rate-limit. Check the sync-run logs on the Apify dashboard for the exact reason.`
    }
  };
}

module.exports = { preview, execute, PER_UNIT_ESTIMATE_USD, MAX_STEPS_PER_RUN };
