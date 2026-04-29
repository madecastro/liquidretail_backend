// Google Ads API → Campaign sync adapter (Phase B-3).
//
// Mints a fresh access token from the stored refresh_token, then runs
// four GAQL queries via /customers/{id}/googleAds:search to assemble
// the campaign tree:
//
//   1. campaigns          — id, name, status, channel type, budget, schedule
//   2. ad_group_ads       — campaign → ad_group → ad nesting
//   3. campaign_criterion — geo / age / audience targeting (positive only)
//   4. listing groups     — Shopping (ad_group_listing_group_filter) +
//                            Performance Max (asset_group_listing_group_filter)
//
// Joins via in-memory Map keyed on campaign.id; we don't try to JOIN
// in GAQL because GAQL has no JOIN operator. Pagination via pageToken.
//
// Plugged into campaignSyncService.ADAPTERS['google-ads'] — the
// orchestrator handles credential resolution + idempotent upsert.

const axios = require('axios');
const { decrypt } = require('./integrationCryptoService');
const googleAds = require('./googleAdsOAuthService');

const ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v19';
const ADS_API_ROOT    = `https://googleads.googleapis.com/${ADS_API_VERSION}`;

const MAX_CAMPAIGNS = 200;

async function syncForCredential(cred) {
  const customerId = cred?.platformData?.customerId;
  if (!customerId) return { ok: false, reason: 'credential has no customerId — re-finalize via the picker' };
  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    return { ok: false, reason: 'GOOGLE_ADS_DEVELOPER_TOKEN not set' };
  }

  // Decrypt the refresh_token, mint a short-lived access token.
  let refreshToken;
  try { refreshToken = decrypt(cred.accessTokenEnc); }
  catch (err) { return { ok: false, reason: `token decrypt failed: ${err.message}` }; }

  let accessToken;
  try {
    const minted = await googleAds.refreshAccessToken(refreshToken);
    accessToken = minted?.access_token;
    if (!accessToken) throw new Error('refresh returned no access_token');
  } catch (err) {
    const detail = err.response?.data?.error_description || err.message;
    return { ok: false, reason: `access-token refresh failed: ${detail}` };
  }

  const ctx = {
    customerId,
    managerCustomerId: cred.platformData?.managerCustomerId || null,
    accessToken,
    currency:          cred.platformData?.currencyCode || null
  };

  const t0 = Date.now();
  console.log(`📣 Google campaign sync starting: cred=${cred._id} customer=${customerId}`);

  // ── 1. Campaigns ──
  let campaignRows;
  try {
    campaignRows = await runGAQL(ctx, `
      SELECT
        campaign.id, campaign.name, campaign.status,
        campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
        campaign.start_date, campaign.end_date,
        campaign.bidding_strategy_type,
        campaign_budget.amount_micros, campaign_budget.resource_name
      FROM campaign
      WHERE campaign.status != 'REMOVED'
      LIMIT ${MAX_CAMPAIGNS}
    `);
  } catch (err) {
    return { ok: false, reason: `campaigns query: ${gaqlError(err)}`, errors: [] };
  }

  const campaignMap = new Map();
  for (const r of campaignRows) {
    const c = r.campaign;
    if (!c?.id) continue;
    if (campaignMap.has(c.id)) continue;
    campaignMap.set(c.id, {
      externalId: String(c.id),
      name:       c.name || '(unnamed)',
      status:     c.status || null,
      objective:  c.advertisingChannelType || null,
      budget: {
        dailyMicros:    r.campaignBudget?.amountMicros ? Number(r.campaignBudget.amountMicros) : null,
        lifetimeMicros: null,
        currency:       ctx.currency || null,
        sharedBudgetId: r.campaignBudget?.resourceName || null
      },
      schedule: {
        // Google date format: YYYY-MM-DD. Build ISO at noon UTC to
        // dodge timezone-shift surprises in display code.
        start: c.startDate ? new Date(`${c.startDate}T12:00:00Z`) : null,
        end:   c.endDate   ? new Date(`${c.endDate}T12:00:00Z`)   : null
      },
      targeting: {
        geo: [], ageMin: null, ageMax: null,
        interests: [], audiences: [], devices: [],
        platformExtras: {
          channelSubType:      c.advertisingChannelSubType || null,
          biddingStrategyType: c.biddingStrategyType || null
        }
      },
      adSets:  [],
      rawData: r
    });
  }

  const errors = [];

  // ── 2. Ad groups + ads (one query, denormalized) ──
  try {
    const rows = await runGAQL(ctx, `
      SELECT
        campaign.id,
        ad_group.id, ad_group.name, ad_group.status, ad_group.type,
        ad_group_ad.status, ad_group_ad.resource_name,
        ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type
      FROM ad_group_ad
      WHERE campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND ad_group_ad.status != 'REMOVED'
      LIMIT 5000
    `);
    for (const r of rows) {
      const camp = campaignMap.get(r.campaign?.id);
      if (!camp) continue;
      const adSetId = String(r.adGroup?.id || '');
      if (!adSetId) continue;
      let adSet = camp.adSets.find(a => a.externalId === adSetId);
      if (!adSet) {
        adSet = {
          externalId:   adSetId,
          name:         r.adGroup?.name || '(unnamed)',
          status:       r.adGroup?.status || null,
          // For Shopping campaigns we'll set this from the listing-
          // group query below. For Search/Display it stays null.
          productSetId: null,
          ads:          []
        };
        camp.adSets.push(adSet);
      }
      const ad = r.adGroupAd?.ad;
      if (ad?.id) {
        adSet.ads.push({
          externalId: String(ad.id),
          name:       ad.name || '(unnamed)',
          status:     r.adGroupAd?.status || null,
          creativeRef: {
            adGroupAdResourceName: r.adGroupAd?.resourceName || null,
            adType:                ad.type || null
          }
        });
      }
    }
  } catch (err) {
    console.warn(`   · ad_group_ad query failed: ${gaqlError(err)}`);
    errors.push({ scope: 'ad_group_ad', reason: gaqlError(err) });
  }

  // ── 3. Targeting (positive criteria only) ──
  try {
    const rows = await runGAQL(ctx, `
      SELECT
        campaign.id,
        campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative,
        campaign_criterion.location.geo_target_constant,
        campaign_criterion.age_range.type,
        campaign_criterion.user_list.user_list
      FROM campaign_criterion
      WHERE campaign.status != 'REMOVED' AND campaign_criterion.negative = FALSE
      LIMIT 5000
    `);
    for (const r of rows) {
      const camp = campaignMap.get(r.campaign?.id);
      if (!camp) continue;
      const cc = r.campaignCriterion;
      if (!cc) continue;
      switch (cc.type) {
        case 'LOCATION':
          if (cc.location?.geoTargetConstant) camp.targeting.geo.push(cc.location.geoTargetConstant);
          break;
        case 'AGE_RANGE': {
          // Google enum: AGE_RANGE_18_24, AGE_RANGE_25_34, ... AGE_RANGE_65_UP
          const m = String(cc.ageRange?.type || '').match(/AGE_RANGE_(\d+)_(\d+|UP)/);
          if (m) {
            const min = Number(m[1]);
            const max = m[2] === 'UP' ? 99 : Number(m[2]);
            camp.targeting.ageMin = camp.targeting.ageMin == null ? min : Math.min(camp.targeting.ageMin, min);
            camp.targeting.ageMax = camp.targeting.ageMax == null ? max : Math.max(camp.targeting.ageMax, max);
          }
          break;
        }
        case 'USER_LIST':
          if (cc.userList?.userList) camp.targeting.audiences.push(cc.userList.userList);
          break;
        default: break;
      }
    }
  } catch (err) {
    console.warn(`   · campaign_criterion query failed: ${gaqlError(err)}`);
    errors.push({ scope: 'campaign_criterion', reason: gaqlError(err) });
  }

  // ── 4. Listing groups — Shopping (ad_group level) ──
  // Each ad_group_listing_group_filter narrows products by some
  // dimension. For V1 we just record the AD GROUP RESOURCE NAME as
  // the productSetId for any Shopping ad group that has at least one
  // listing filter — Phase C resolves to actual Merchant Center
  // product IDs via a separate sync.
  try {
    const rows = await runGAQL(ctx, `
      SELECT
        campaign.id,
        ad_group.id, ad_group.resource_name,
        ad_group_listing_group_filter.id
      FROM ad_group_listing_group_filter
      LIMIT 2000
    `);
    for (const r of rows) {
      const camp = campaignMap.get(r.campaign?.id);
      if (!camp) continue;
      const adSetId = String(r.adGroup?.id || '');
      const adSet = camp.adSets.find(a => a.externalId === adSetId);
      if (adSet && !adSet.productSetId) {
        adSet.productSetId = r.adGroup?.resourceName || `customers/${ctx.customerId}/adGroups/${adSetId}`;
      }
    }
  } catch (err) {
    // ad_group_listing_group_filter is unavailable on accounts with
    // no Shopping campaigns — that's an empty/permissions error, not
    // a hard failure. Log and continue.
    console.warn(`   · ad_group listing groups: ${gaqlError(err)}`);
  }

  // ── 4b. Listing groups — Performance Max (asset_group level) ──
  // PMax has no ad_groups; assets are organized into asset_groups.
  // We add each asset_group as an "ad set" on its parent campaign so
  // the unified shape stays consistent.
  try {
    const rows = await runGAQL(ctx, `
      SELECT
        campaign.id,
        asset_group.id, asset_group.name, asset_group.status, asset_group.resource_name,
        asset_group_listing_group_filter.id
      FROM asset_group_listing_group_filter
      LIMIT 2000
    `);
    for (const r of rows) {
      const camp = campaignMap.get(r.campaign?.id);
      if (!camp) continue;
      const groupId = String(r.assetGroup?.id || '');
      if (!groupId) continue;
      let adSet = camp.adSets.find(a => a.externalId === groupId);
      if (!adSet) {
        adSet = {
          externalId:   groupId,
          name:         r.assetGroup?.name || '(unnamed asset group)',
          status:       r.assetGroup?.status || null,
          productSetId: r.assetGroup?.resourceName || `customers/${ctx.customerId}/assetGroups/${groupId}`,
          ads:          []
        };
        camp.adSets.push(adSet);
      } else if (!adSet.productSetId) {
        adSet.productSetId = r.assetGroup?.resourceName || null;
      }
    }
  } catch (err) {
    console.warn(`   · asset_group listing groups: ${gaqlError(err)}`);
  }

  const campaigns = [...campaignMap.values()];
  console.log(`📣 Google campaign sync done: cred=${cred._id} campaigns=${campaigns.length} errors=${errors.length} in ${Date.now() - t0}ms`);
  return { ok: true, campaigns, errors };
}

// ── GAQL execution helper ────────────────────────────────────────────
//
// POSTs the query to /customers/{id}/googleAds:search with paging.
// login-customer-id header is required when querying a child customer
// from an MCC (manager) account.
async function runGAQL(ctx, query) {
  const url = `${ADS_API_ROOT}/customers/${encodeURIComponent(ctx.customerId)}/googleAds:search`;
  const headers = {
    'Authorization':   `Bearer ${ctx.accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type':    'application/json'
  };
  if (ctx.managerCustomerId) {
    headers['login-customer-id'] = String(ctx.managerCustomerId).replace(/-/g, '');
  }

  const results = [];
  let pageToken = null;
  // Hard ceiling so a runaway query can't fetch unbounded rows.
  const ROW_HARD_CAP = 20000;
  for (let safety = 0; safety < 50 && results.length < ROW_HARD_CAP; safety++) {
    const body = { query: query.trim(), pageSize: 1000 };
    if (pageToken) body.pageToken = pageToken;
    const res = await axios.post(url, body, { headers, timeout: 30000 });
    if (Array.isArray(res.data?.results)) results.push(...res.data.results);
    pageToken = res.data?.nextPageToken;
    if (!pageToken) break;
  }
  return results;
}

// Normalize Google API errors into a short string for logging.
function gaqlError(err) {
  if (!err) return 'unknown';
  if (err.response?.data?.error?.message) return err.response.data.error.message;
  if (err.response?.data?.error)          return JSON.stringify(err.response.data.error).slice(0, 200);
  return err.message || String(err);
}

module.exports = { syncForCredential };
