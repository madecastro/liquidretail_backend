// Executor for capability ads.publishToMeta (Tier 3, brand scope).
//
// Pushes a batch of ads to a specific Meta Ads adset. Tier 3 = external
// / hard-to-reverse: once published, Meta may start serving the ad to
// real users depending on adset status. The gate applies TWO layers
// beyond confirmation:
//   1. Standard confirmation gate (Tier 1+ machinery, PR #3).
//   2. "Type YES" phrase (Tier 3+ machinery, PR #5) — the operator
//      must type the exact string declared on the capability's
//      explicitConfirmation field before dispatch. Enforced in the
//      endpoint, not this executor — so this file only sees the
//      "cleared" arguments.
//
// The push itself is a wrapper around the existing metaAdsPushService.
// We do NOT reimplement Meta API interaction; every push here goes
// through pushAdsBatch (same code path as the UI's push button).
//
// Runs synchronously — pushAdsBatch waits for every ad in the batch to
// finish. Batches of 5-20 ads take 10-60s. The agent's SSE stream
// stays open the whole time; the response summarises per-ad outcomes.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');
const metaAds = require('../metaAdsPushService');

const MAX_BATCH = 20;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  const rawAdsetId = args?.adsetId;
  const rawAdIds = args?.adIds;

  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!rawAdsetId) return { ok: false, error: 'adsetId required (Meta Ads adset external id)' };
  if (!Array.isArray(rawAdIds) || !rawAdIds.length) {
    return { ok: false, error: 'adIds required — non-empty array of Ad ObjectIds' };
  }
  if (rawAdIds.length > MAX_BATCH) {
    return { ok: false, error: `too many ads in one push (max ${MAX_BATCH}, got ${rawAdIds.length}) — split into smaller batches` };
  }
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  for (const [i, id] of rawAdIds.entries()) {
    if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) {
      return { ok: false, error: `adIds[${i}] "${id}" is not a valid ObjectId` };
    }
  }

  // Tenant guard — brand must belong to this advertiser.
  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  // Every ad in the batch must belong to this brand. A cross-brand id
  // here is either a hallucination or a leak attempt — refuse the whole
  // batch rather than partial-push.
  const ads = await Ad.find({ _id: { $in: rawAdIds }, brandId: brand._id })
    .select('_id status kind renderUrl metaSyncStatus').lean();
  if (ads.length !== rawAdIds.length) {
    const foundIds = new Set(ads.map((a) => String(a._id)));
    const missing = rawAdIds.filter((id) => !foundIds.has(String(id)));
    return {
      ok: false,
      error: `${missing.length} ad(s) not found under brand ${brand.name}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`
    };
  }

  // Structural pre-checks the Meta path would fail on anyway — cheaper
  // to reject up front than to fire a batch and count failures.
  const alreadySynced = ads.filter((a) => a.metaSyncStatus === 'synced').map((a) => String(a._id));
  const noRender = ads.filter((a) => !a.renderUrl).map((a) => String(a._id));
  if (alreadySynced.length) {
    return {
      ok: false,
      error: `${alreadySynced.length} ad(s) already synced to Meta (cannot re-publish): ${alreadySynced.slice(0, 5).join(', ')}${alreadySynced.length > 5 ? '…' : ''}`
    };
  }
  if (noRender.length) {
    return {
      ok: false,
      error: `${noRender.length} ad(s) have no renderUrl (not yet rendered): ${noRender.slice(0, 5).join(', ')}${noRender.length > 5 ? '…' : ''}`
    };
  }

  const requestedBy = req.user?.userId || req.user?.email || 'agent';

  // Fire the batch. pushAdsBatch handles Meta creds resolution, page
  // lookup, per-ad upload + creative + ad creation, and marks each
  // Ad.metaSyncStatus='synced'|'failed'.
  let result;
  try {
    result = await metaAds.pushAdsBatch({
      adIds: rawAdIds,
      adsetId: rawAdsetId,
      brandId: brand._id,
      requestedBy
    });
  } catch (err) {
    return {
      ok: false,
      error: `Meta push batch crashed: ${err.message}`
    };
  }

  return {
    ok: true,
    kind: 'metaPushBatch',
    data: {
      brand:   { _id: String(brand._id), name: brand.name },
      adsetId: rawAdsetId,
      pushed:  result.pushed,
      failed:  result.failed,
      requestedBy,
      perAd: result.perAd.map((r) => ({
        adId:  String(r.adId),
        ok:    !!r.ok,
        error: r.error || null,
        metaAdId: r.metaAdId || null
      }))
    }
  };
}

module.exports = { run };
