// Meta Marketing API → Campaign sync adapter (Phase B-2).
//
// Pulls campaigns + ad sets + ads from /act_<id>/campaigns using
// nested field expansion so one paginated call returns everything;
// no N+1 per-campaign hits. Maps Meta's targeting spec into the
// unified Campaign.targeting shape (geo / age / interests / audiences)
// and captures product_set_id per ad set for the Phase C matcher.
//
// Plugged into campaignSyncService.ADAPTERS['meta-ads'] — the
// orchestrator handles credential resolution, upsert via the natural
// (brandId, platform, externalId) key, and lastCampaignSyncAt
// timestamping.

const axios = require('axios');
const { decrypt } = require('./integrationCryptoService');
const { matchCampaignCreatives, deriveCampaignKind } = require('./metaAdsCreativeMatcher');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// Caps to keep a single sync bounded. A brand with > 200 campaigns
// or > 100 ad sets per campaign is rare in practice; if hit, increase
// or move sync to background.
const MAX_CAMPAIGNS    = 200;
const ADSETS_PER_CAMP  = 100;
const ADS_PER_ADSET    = 50;

function buildFields() {
  const adFields = ['id', 'name', 'status', 'effective_status', 'creative{id,name}'].join(',');
  const adSetFields = [
    'id', 'name', 'status', 'effective_status',
    'daily_budget', 'lifetime_budget', 'start_time', 'end_time',
    'targeting', 'promoted_object', 'product_set_id',
    `ads.limit(${ADS_PER_ADSET}){${adFields}}`
  ].join(',');
  return [
    'id', 'name', 'status', 'effective_status', 'objective',
    'daily_budget', 'lifetime_budget',
    'start_time', 'stop_time',
    'special_ad_categories', 'configured_status',
    `adsets.limit(${ADSETS_PER_CAMP}){${adSetFields}}`
  ].join(',');
}

// ── Adapter entry point ──────────────────────────────────────────────
async function syncForCredential(cred) {
  const adAccountId = cred?.platformData?.adAccountId;
  if (!adAccountId) return { ok: false, reason: 'credential has no adAccountId — re-finalize via the picker' };

  let token;
  try { token = decrypt(cred.accessTokenEnc); }
  catch (err) { return { ok: false, reason: `token decrypt failed: ${err.message}` }; }

  const fields   = buildFields();
  const currency = cred.platformData?.currency || null;

  const t0 = Date.now();
  console.log(`📣 Meta campaign sync starting: cred=${cred._id} adAccount=${adAccountId}`);

  const campaigns = [];
  const errors = [];
  let url = `${META_GRAPH_ROOT}/${adAccountId}/campaigns`;
  let params = { fields, access_token: token, limit: 50 };

  while (url && campaigns.length < MAX_CAMPAIGNS) {
    let res;
    try {
      res = await axios.get(url, { params, timeout: 30000 });
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      const code   = err.response?.data?.error?.code;
      // Auth failures are fatal — token revoked or scope missing.
      if (code === 190 || code === 200 || code === 100) {
        return { ok: false, reason: `Meta auth/permission error: ${detail}`, campaigns, errors };
      }
      console.warn(`   ⚠️  Meta campaigns page failed: ${detail}`);
      errors.push({ scope: 'page', reason: detail });
      break;
    }

    for (const raw of (res.data?.data || [])) {
      try {
        campaigns.push(normalizeCampaign(raw, { currency }));
      } catch (err) {
        errors.push({ externalId: raw.id, reason: err.message });
      }
    }

    const next = res.data?.paging?.next;
    if (next && campaigns.length < MAX_CAMPAIGNS) {
      url = next;
      params = null; // next URL already includes all params
    } else {
      url = null;
    }
  }

  // Creative-level enrichment + product matching. Fetches each ad's
  // creative content (caption / image / link) from the Graph API and
  // resolves it to CatalogProduct rows via URL + text similarity.
  // Mutates the in-memory normalized campaigns in place; the
  // orchestrator's upsert then persists ad.creative, ad.matchedProductIds,
  // and the top-level campaign.matchedProductIds aggregate.
  const matchT0 = Date.now();
  let totalMatched = 0;
  for (const c of campaigns) {
    try {
      const matchedIds = await matchCampaignCreatives({
        brandId: cred.brandId,
        token,
        campaign: c
      });
      c.matchedProductIds = matchedIds;
      c.kind              = deriveCampaignKind(c);
      totalMatched += matchedIds.length;
    } catch (err) {
      console.warn(`   ⚠️  creative-match failed for campaign ${c.externalId}: ${err.message}`);
      errors.push({ externalId: c.externalId, scope: 'creative-match', reason: err.message });
      c.kind = deriveCampaignKind(c);    // still derive — likely 'brand'
    }
  }
  console.log(`🔗 Meta creative match: ${totalMatched} product association(s) across ${campaigns.length} campaign(s) in ${Date.now() - matchT0}ms`);

  console.log(`📣 Meta campaign sync done: cred=${cred._id} campaigns=${campaigns.length} errors=${errors.length} in ${Date.now() - t0}ms`);
  return { ok: true, campaigns, errors };
}

// ── Normalization helpers ────────────────────────────────────────────

function normalizeCampaign(c, ctx) {
  const rawAdSets = c.adsets?.data || [];
  const adSets    = rawAdSets.map(normalizeAdSet);
  const targeting = aggregateTargeting(rawAdSets, c);

  return {
    externalId: String(c.id),
    name:       c.name || '(unnamed)',
    status:     c.effective_status || c.status || c.configured_status || null,
    objective:  c.objective || null,
    budget: {
      dailyMicros:    metaBudgetToMicros(c.daily_budget),
      lifetimeMicros: metaBudgetToMicros(c.lifetime_budget),
      currency:       ctx.currency || null,
      sharedBudgetId: null
    },
    schedule: {
      start: c.start_time ? new Date(c.start_time) : null,
      end:   c.stop_time  ? new Date(c.stop_time)  : null
    },
    targeting,
    adSets,
    rawData: c
  };
}

function normalizeAdSet(s) {
  // Meta exposes product_set_id in two places depending on the
  // campaign's objective:
  //   - DPA (PRODUCT_CATALOG_SALES) → on the ad set: s.product_set_id
  //   - Advantage+ Shopping         → in promoted_object.product_set_id
  // Try both; either path is authoritative when present.
  const productSetId = s.product_set_id
                    || s.promoted_object?.product_set_id
                    || null;

  return {
    externalId:   String(s.id),
    name:         s.name || '(unnamed)',
    status:       s.effective_status || s.status || null,
    productSetId,
    ads: (s.ads?.data || []).map(a => ({
      externalId: String(a.id),
      name:       a.name || '(unnamed)',
      status:     a.effective_status || a.status || null,
      creativeRef: a.creative
        ? { creativeId: a.creative.id, creativeName: a.creative.name || null }
        : null
    }))
  };
}

// Combine per-ad-set targeting into a campaign-level summary. Geo
// and interest sets unioned across ad sets; age range widened to the
// union [minOfMins, maxOfMaxes]. Reads the RAW ad-set objects (with
// the original Meta `targeting` blob) — the normalized adSet shape
// drops it to keep the embedded doc small.
function aggregateTargeting(rawAdSets, c) {
  const geo       = new Set();
  const interests = new Set();
  const audiences = new Set();
  const devices   = new Set();
  let ageMin = null, ageMax = null;
  const adSetTargetings = [];

  for (const s of rawAdSets) {
    const t = s.targeting;
    if (!t) continue;
    adSetTargetings.push({ adSetId: s.id, targeting: t });

    if (t.geo_locations) {
      for (const k of ['countries', 'country_groups']) {
        for (const v of (t.geo_locations[k] || [])) geo.add(v);
      }
      for (const r of (t.geo_locations.regions || [])) {
        if (r.name)     geo.add(r.name);
        else if (r.key) geo.add(String(r.key));
      }
      for (const ct of (t.geo_locations.cities || [])) {
        if (ct.name) geo.add(ct.name);
      }
    }
    if (Array.isArray(t.interests)) for (const i of t.interests) if (i.name) interests.add(i.name);
    if (Array.isArray(t.flexible_spec)) {
      for (const flex of t.flexible_spec) {
        for (const i of (flex.interests || [])) if (i.name) interests.add(i.name);
      }
    }
    if (Array.isArray(t.custom_audiences))    for (const a of t.custom_audiences)    if (a.id) audiences.add(String(a.id));
    if (Array.isArray(t.user_device))         for (const d of t.user_device)         devices.add(d);
    if (Array.isArray(t.publisher_platforms)) for (const p of t.publisher_platforms) devices.add(p);

    if (typeof t.age_min === 'number') ageMin = ageMin == null ? t.age_min : Math.min(ageMin, t.age_min);
    if (typeof t.age_max === 'number') ageMax = ageMax == null ? t.age_max : Math.max(ageMax, t.age_max);
  }

  return {
    geo:        [...geo],
    ageMin,
    ageMax,
    interests:  [...interests],
    audiences:  [...audiences],
    devices:    [...devices],
    platformExtras: {
      specialAdCategories: c.special_ad_categories || [],
      adSetTargetings
    }
  };
}

// Meta budgets are strings in the account currency's smallest unit
// (cents for USD). Multiply by 10_000 to convert cents → micros so
// our unified Campaign.budget shape matches Google's micros convention.
function metaBudgetToMicros(raw) {
  if (raw == null || raw === '') return null;
  const cents = Number(raw);
  if (!Number.isFinite(cents)) return null;
  return cents * 10000;
}

module.exports = { syncForCredential };
