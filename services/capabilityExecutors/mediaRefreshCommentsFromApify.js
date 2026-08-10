// Executor for capability media.refreshCommentsFromApify (Tier 4, brand scope).
//
// Comment refresh for apify-ig Media rows via the SAME apify/instagram-
// scraper actor used to pull posts, but with resultsType='comments'
// per post permalink. One Apify run per post; preview shows the expected
// total cost and target count before execution.
//
// COST — corrected 2026-08-10. This comment used to claim the actor
// "bills per run + per record". That was factually wrong on both halves:
// apify/instagram-scraper is PAY_PER_EVENT with exactly ONE charge event
// ('result', each dataset row) and NO per-run charge at all (verified
// live against the actor's own pricing entry, and against a settled run
// whose chargedEventCounts {result:10} matched usageTotalUsd $0.023).
// The old flat $0.02-per-POST estimate therefore priced a fee that does
// not exist while ignoring the one variable that actually drives the
// bill — how many comments each run is asked for. At BRONZE, 100 posts
// × 50 comments really costs ~$11.50, not the $2.00 the operator saw.
// See services/apifyCostModel.js for the arithmetic and the receipts.
//
// This is the parallel path to media.refreshInsightsForBrand (which
// handles source='instagram' OAuth media). Comments-only — no post
// metadata refresh; the Apify pull captures that at ingest time.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Media = require('../../models/Media');
const { syncBrandInstagramCommentsApify } = require('../apifyIngestService');
const progressService = require('../progressService');
const costModel = require('../apifyCostModel');

// LEGACY per-post constant. Still read so an operator who pinned
// APIFY_COMMENTS_PER_UNIT_USD keeps their number (see estimateBasis
// 'per-post-override' below) and so the v2 kill switch has something to
// fall back to. Not the default any more.
const PER_UNIT_ESTIMATE_USD = Number(process.env.APIFY_COMMENTS_PER_UNIT_USD || 0.02);
const MAX_STEPS_PER_RUN = costModel.MAX_POSTS_PER_RUN;

// Kill switch. Default ON. APIFY_COST_ESTIMATE_V2=false restores the old
// COST FIELDS exactly — perUnitUsd + estimateUsd on the legacy flat
// $/post math, and none of the new keys — so flipping it is a true revert
// of the estimate contract.
//
// Scope note, so the switch isn't mistaken for more than it is: the one
// other preview change, `note` no longer saying "sync-run", is
// unconditional. That wording described the TRANSPORT, which is governed
// by APIFY_COST_READBACK in apifyPullService, not by this switch.
function costEstimateV2Enabled() {
  return String(process.env.APIFY_COST_ESTIMATE_V2 ?? 'true').trim().toLowerCase() !== 'false';
}

// The preview's cost fields, and the single place the number is derived.
function buildCostBlock(posts) {
  if (!costEstimateV2Enabled()) {
    return {
      perUnitUsd:  PER_UNIT_ESTIMATE_USD,
      estimateUsd: Math.round(posts * PER_UNIT_ESTIMATE_USD * 100) / 100
    };
  }
  const est = costModel.estimateCommentPullUsd({
    posts,
    commentLimit:       costModel.resolveCommentLimit(),
    perResultUsd:       costModel.resolvePerResultUsd(),
    perPostOverrideUsd: costModel.resolvePerPostOverrideUsd()
  });
  return {
    perUnitUsd:    est.perUnitUsd,
    estimateUsd:   est.estimateUsd,
    // The two drivers behind the number, surfaced so an operator can see
    // WHY the gate says what it says — and so a limit change is visible.
    commentLimit:  est.commentLimit,
    perResultUsd:  est.perResultUsd,
    estimateBasis: est.estimateBasis
  };
}

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
  const cost = buildCostBlock(capped);

  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId: 'media.refreshCommentsFromApify',
      brand: { _id: String(brand._id), name: brand.name },
      totalApifyMedia: targets,
      totalSteps:      capped,
      capped:          targets > MAX_STEPS_PER_RUN,
      ...cost,
      estimateWallMs:  capped * 8_000,   // rough Apify run latency
      reversible:      false,
      summary:         `Pull IG comments for ${capped} apify-ig Media row(s) under ${brand.name} via the same Apify actor used at ingest (resultsType='comments'). Upserts Comment docs by (mediaId, externalId).`,
      note:            'Each post is a separate Apify actor run. Comments already stored are updated in place (likeCount / replyCount / text). Post metadata itself is not touched — that lives on the Media row.'
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

  // Progress row — also the operator-findable home for the MEASURED
  // spend. OperationRun.meta is Mixed and is the established place for a
  // per-run summary (progressService writes it from handle.succeed), so
  // no new collection. startRun never throws; on any DB/tenant problem it
  // hands back a no-op handle and the pull proceeds unchanged.
  const run = await progressService.startRun({
    kind:    'apify-comment-refresh',
    req,
    brandId: brand._id,
    label:   `Refresh IG comments — ${brand.name}`
  });

  let result;
  try {
    // Same cap the preview quoted. Without it the operator approves
    // `totalSteps: min(targets, 100)` and then pays for every eligible
    // post the brand has.
    result = await syncBrandInstagramCommentsApify(brand._id, {
      concurrency: 2,
      limit: MAX_STEPS_PER_RUN
    });
  } catch (err) {
    // Nothing billable ran — syncBrandInstagramCommentsApify only throws
    // before the fan-out (brand lookup). Per-post failures come back in
    // `result`, with their cost, on the success path below.
    await run.fail(err);
    return {
      ok: false,
      kind: 'workflowResult',
      error: `apify comment sync failed: ${err.message}`,
      data: { workflowId: 'media.refreshCommentsFromApify', brand: { _id: String(brand._id), name: brand.name }, durationMs: Date.now() - started }
    };
  }

  // MEASURED, not estimated: summed from each Apify run's own
  // usageTotalUsd. Null when the readback is off or Apify reported
  // nothing — never silently substituted with a rate-card guess.
  const cost = {
    usageTotalUsd:     result?.usageTotalUsd ?? null,
    chargedResults:    result?.chargedResults ?? null,
    costMeasuredSteps: result?.costMeasuredSteps ?? 0,
    costSource:        Number.isFinite(result?.usageTotalUsd) ? 'measured' : 'unavailable'
  };

  await run.succeed({
    workflowId: 'media.refreshCommentsFromApify',
    brandId:    String(brand._id),
    totalSteps: result?.total || 0,
    succeeded:  result?.succeeded || 0,
    failed:     result?.failed || 0,
    commentsFetched:  result?.fetched  || 0,
    commentsUpserted: result?.upserted || 0,
    durationMs: Date.now() - started,
    ...cost
  });

  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'media.refreshCommentsFromApify',
      brand: { _id: String(brand._id), name: brand.name },
      operationRunId: run.id || null,
      totalSteps: result?.total || 0,
      succeeded:  result?.succeeded || 0,
      failed:     result?.failed || 0,
      commentsFetched:  result?.fetched  || 0,
      commentsUpserted: result?.upserted || 0,
      ...cost,
      durationMs: Date.now() - started,
      note: (result?.failed || 0) === 0
        ? 'All posts refreshed successfully.'
        : `${result.failed} post(s) failed — usually a private account, deleted post, or Apify rate-limit. Check the run logs on the Apify dashboard for the exact reason.`
    }
  };
}

module.exports = {
  preview,
  execute,
  buildCostBlock,
  costEstimateV2Enabled,
  PER_UNIT_ESTIMATE_USD,
  MAX_STEPS_PER_RUN
};
