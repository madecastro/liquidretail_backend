// Executor for capability onboarding.dispatchSyncs (Tier 1, brand scope).
//
// Wraps the same fan-out that POST /api/onboarding/dispatch-syncs
// runs after an operator completes the connect step: for any
// integration credential on the brand (IG, Meta Ads, Google Ads), fire
// the matching sync via setImmediate so the calls survive client
// navigation. Debounces catalog + posts syncs within a 5-minute
// window because the IG picker's own auto-fire already does most of
// the work on the connect page.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const IntegrationCredential = require('../../models/IntegrationCredential');

const RECENT_SYNC_WINDOW_MS = 5 * 60 * 1000;

function isFresh(timestamp) {
  if (!timestamp) return false;
  return (Date.now() - new Date(timestamp).getTime()) < RECENT_SYNC_WINDOW_MS;
}

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

  const [igCred, metaCred, googleCred] = await Promise.all([
    IntegrationCredential.findOne({ brandId: brand._id, type: 'instagram',  status: { $in: ['active', 'pending'] } })
      .select('_id status lastCatalogSyncAt lastPostsSyncAt').lean(),
    IntegrationCredential.findOne({ brandId: brand._id, type: 'meta-ads',   status: { $in: ['active', 'pending'] } })
      .select('_id status').lean(),
    IntegrationCredential.findOne({ brandId: brand._id, type: 'google-ads', status: { $in: ['active', 'pending'] } })
      .select('_id status').lean()
  ]);

  const catalogFresh = isFresh(igCred?.lastCatalogSyncAt);
  const postsFresh   = isFresh(igCred?.lastPostsSyncAt);
  const dispatched = [];
  const skipped   = [];

  if (igCred && !catalogFresh) {
    dispatched.push('catalog');
    setImmediate(async () => {
      try {
        const { syncCatalog } = require('../catalogSyncService');
        const r = await syncCatalog(String(brand._id), {});
        console.log(`📦 [agent] dispatched catalog sync: ok=${r?.ok} fetched=${r?.fetched || 0}`);
      } catch (err) { console.warn(`[agent] catalog sync failed: ${err.message}`); }
      try {
        const { rematchAfterCatalogDetect } = require('../postRematchAfterCatalogService');
        await rematchAfterCatalogDetect({ brandId: String(brand._id) });
      } catch (err) { console.warn(`[agent] rematch-after-catalog failed: ${err.message}`); }
    });
  } else if (igCred && catalogFresh) {
    skipped.push({ kind: 'catalog', reason: 'debounced — synced within last 5 min' });
  }
  if (igCred && !postsFresh) {
    dispatched.push('posts');
    setImmediate(async () => {
      try {
        const { syncPosts } = require('../postSyncService');
        const r = await syncPosts(String(brand._id), {});
        console.log(`📸 [agent] dispatched post sync: ok=${r?.ok} ingested=${r?.ingested || 0}`);
      } catch (err) { console.warn(`[agent] post sync failed: ${err.message}`); }
    });
  } else if (igCred && postsFresh) {
    skipped.push({ kind: 'posts', reason: 'debounced — synced within last 5 min' });
  }
  if (metaCred) {
    dispatched.push('meta-campaigns');
    setImmediate(async () => {
      try {
        const { syncCampaigns } = require('../campaignSyncService');
        const r = await syncCampaigns({ brandId: String(brand._id), platform: 'meta-ads' });
        console.log(`📣 [agent] dispatched meta-ads sync: upserted=${r?.upserted || 0}`);
      } catch (err) { console.warn(`[agent] meta-ads sync failed: ${err.message}`); }
    });
  }
  if (googleCred) {
    dispatched.push('google-campaigns');
    setImmediate(async () => {
      try {
        const { syncCampaigns } = require('../campaignSyncService');
        const r = await syncCampaigns({ brandId: String(brand._id), platform: 'google-ads' });
        console.log(`📣 [agent] dispatched google-ads sync: upserted=${r?.upserted || 0}`);
      } catch (err) { console.warn(`[agent] google-ads sync failed: ${err.message}`); }
    });
  }

  return {
    ok: true,
    kind: 'syncDispatch',
    data: {
      brandId: String(brand._id),
      brandName: brand.name,
      dispatched,
      skipped,
      credentials: {
        instagram: igCred ? igCred.status : null,
        metaAds:   metaCred ? metaCred.status : null,
        googleAds: googleCred ? googleCred.status : null
      },
      note: dispatched.length
        ? 'Syncs are running in the background via setImmediate. Fetched counts + insertions appear in Slack alerts + server logs; poll run.status if you need a runId.'
        : 'Nothing to dispatch — no active integration credentials, or every sync was fresh within the 5-min debounce window.'
    }
  };
}

module.exports = { run };
