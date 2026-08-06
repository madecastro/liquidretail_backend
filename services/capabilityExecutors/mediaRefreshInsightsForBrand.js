// Executor for capability media.refreshInsightsForBrand (Tier 4, brand scope).
//
// Bulk-refresh insights + comments for every OAuth-sourced Media
// (source='instagram') on a brand. Same underlying pair mediaRefresh-
// Insights uses per-Media (refreshInsightsForMedia + fetchCommentsFor-
// Media), fanned out at bounded concurrency.
//
// DOES NOT handle apify-ig media — the Meta Graph API refuses non-
// OAuth external ids. Apify-ingested Media has a separate path:
// media.refreshCommentsFromApify. This cap's preview reports whether
// the brand has any OAuth media at all, and the plan / error result
// steers to the Apify path when appropriate.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Media = require('../../models/Media');

const MAX_STEPS_PER_RUN = 100;
const CONCURRENCY = 3;

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

  // Aggregate the brand's media by source so we can name what's
  // refreshable vs. what isn't. Runs on the base object regardless of
  // whether any OAuth media exists — the LLM needs the full picture.
  const sourceBreakdown = await Media.aggregate([
    { $match: {
        brandId: new mongoose.Types.ObjectId(brand._id),
        source: { $ne: 'catalog-product' },
        deletedAt: null
      }
    },
    { $group: { _id: '$source', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  const sourceCounts = Object.fromEntries((sourceBreakdown || []).map((r) => [r._id, r.count]));
  const oauthCount = sourceCounts['instagram'] || 0;

  if (oauthCount === 0) {
    const apifyCount = sourceCounts['apify-ig'] || 0;
    return {
      ok: false,
      error: apifyCount
        ? `brand has 0 OAuth-sourced (source='instagram') Media rows but ${apifyCount} apify-ig row(s). media.refreshInsightsForBrand only handles the OAuth path — invoke media.refreshCommentsFromApify for the Apify path, OR invoke integrations.instagram.connectUrl + posts.syncFromInstagram to bring in OAuth-sourced Media first.`
        : `brand has 0 Media rows the Meta Graph API can refresh (need source='instagram'). Existing sources: ${JSON.stringify(sourceCounts)}. Connect Instagram via integrations.instagram.connectUrl + sync via posts.syncFromInstagram first.`,
      sourceCounts
    };
  }

  const capped = Math.min(oauthCount, MAX_STEPS_PER_RUN);
  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'media.refreshInsightsForBrand',
      brand: { _id: String(brand._id), name: brand.name },
      totalOauthMedia:  oauthCount,
      totalSteps:       capped,
      capped:           oauthCount > MAX_STEPS_PER_RUN,
      sourceCounts,
      summary: `Refresh Meta Graph insights + comments for ${capped} OAuth-sourced (source='instagram') Media rows under ${brand.name}${oauthCount > MAX_STEPS_PER_RUN ? ` (${oauthCount} exist; capped at ${MAX_STEPS_PER_RUN})` : ''}. Each call is a Meta Graph request; free at reasonable volumes but bounded by IG token budget.`,
      estimateUsd:      0,
      estimateWallMs:   Math.round(capped * 3000 / CONCURRENCY),
      reversible:       false,
      note: `Only source='instagram' media refresh; ${sourceCounts['apify-ig'] || 0} apify-ig row(s) skipped — use media.refreshCommentsFromApify for those.`
    }
  };
}

async function execute({ req, args, onProgress }) {
  const scope = await resolveScope({ req, args });
  if (!scope.ok) return scope;
  const { brand } = scope;
  const started = Date.now();

  const targets = await Media.find({
    brandId: brand._id,
    source: 'instagram',
    deletedAt: null,
    externalId: { $exists: true, $ne: null }
  })
    .sort({ createdAt: -1 })
    .limit(MAX_STEPS_PER_RUN)
    .select('_id externalId')
    .lean();

  if (!targets.length) {
    return {
      ok: true,
      kind: 'workflowResult',
      data: {
        workflowId: 'media.refreshInsightsForBrand',
        brand: { _id: String(brand._id), name: brand.name },
        totalSteps: 0,
        note: 'no OAuth-sourced (source=\'instagram\') Media on this brand'
      }
    };
  }

  const { refreshInsightsForMedia, fetchCommentsForMedia } = require('../mediaInsightsService');
  const perStep = [];
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const idx = cursor++;
      const m = targets[idx];
      const t0 = Date.now();
      try {
        const [stats, comments] = await Promise.all([
          refreshInsightsForMedia(m._id),
          fetchCommentsForMedia(m._id)
        ]);
        perStep.push({
          mediaId: String(m._id),
          statsOk: !!stats?.ok,
          statsError: stats?.ok ? null : (stats?.reason || null),
          commentsFetched:  comments?.fetched  || 0,
          commentsUpserted: comments?.upserted || 0,
          commentsError:    comments?.ok ? null : (comments?.reason || null),
          tookMs: Date.now() - t0
        });
      } catch (err) {
        perStep.push({ mediaId: String(m._id), ok: false, reason: err.message, tookMs: Date.now() - t0 });
      }
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            step: idx + 1,
            totalSteps: targets.length,
            mediaId: String(m._id),
            outcome: perStep[perStep.length - 1].statsOk ? 'ok' : 'partial'
          });
        } catch (_) { /* ignore */ }
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(workers);

  const statsSucceeded = perStep.filter((r) => r.statsOk).length;
  const totalCommentsFetched  = perStep.reduce((s, r) => s + (r.commentsFetched  || 0), 0);
  const totalCommentsUpserted = perStep.reduce((s, r) => s + (r.commentsUpserted || 0), 0);

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'media.refreshInsightsForBrand',
      brand: { _id: String(brand._id), name: brand.name },
      totalSteps: targets.length,
      statsSucceeded,
      totalCommentsFetched,
      totalCommentsUpserted,
      durationMs: Date.now() - started,
      note: statsSucceeded === targets.length
        ? 'All posts refreshed successfully.'
        : `${targets.length - statsSucceeded} post(s) had partial failures — check perStep for reasons (usually a Meta Graph rate limit or a post that has been deleted upstream).`
    }
  };
}

module.exports = { preview, execute, MAX_STEPS_PER_RUN };
