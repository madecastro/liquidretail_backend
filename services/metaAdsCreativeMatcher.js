// Meta Ads platform adapter for the creative-matcher cascade.
//
// Platform-specific:
//   - fetchCreativeBatch — Meta Graph API call for caption/title/link/image
//   - extractCreativeContent — pulls fields from Meta's creative shape
//     (object_story_spec.link_data / video_data / photo_data,
//     asset_feed_spec, top-level image_url)
//   - expandProductSets — Tier 1 DPA / Advantage+ product_set_id →
//     CatalogProduct via /{id}/products endpoint
//   - unwrapMetaLink — l.facebook.com / l.instagram.com redirect unwrap
//
// Platform-agnostic logic (URL match, collection fallback, text
// similarity, per-ad cascade, campaign kind derivation) lives in
// creativeMatcherCore.

const axios = require('axios');
const CatalogProduct = require('../models/CatalogProduct');
const core = require('./creativeMatcherCore');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// ── Public entry ─────────────────────────────────────────────────────

async function matchCampaignCreatives({ brandId, token, campaign }) {
  if (!brandId || !token || !campaign) return [];

  const products = await CatalogProduct
    .find({ brandId, draft: { $ne: true } })
    .select('title description productUrl externalId imageUrl category')
    .lean();
  if (products.length === 0) return [];

  const indices = core.buildIndices(products);
  const matchIndices = { ...indices, unwrapFn: unwrapMetaLink };

  // ── Tier 1 — expand product_set_id (DPA / Advantage+ campaigns) ──
  const productSetIds = new Set();
  for (const set of (campaign.adSets || [])) {
    if (set.productSetId) productSetIds.add(set.productSetId);
  }
  const productSetMap = productSetIds.size > 0
    ? await expandProductSets(Array.from(productSetIds), token, indices)
    : new Map();

  // ── Tier 2/3 — fetch creative content for ads not covered by Tier 1 ──
  const creativeIds = new Set();
  for (const set of (campaign.adSets || [])) {
    const setHasResolvedProductSet = set.productSetId && (productSetMap.get(set.productSetId)?.length || 0) > 0;
    if (setHasResolvedProductSet) continue;
    for (const ad of (set.ads || [])) {
      const cid = ad.creativeRef?.creativeId;
      if (cid) creativeIds.add(String(cid));
    }
  }
  const creativeMap = creativeIds.size > 0
    ? await fetchCreativeBatch(Array.from(creativeIds), token)
    : new Map();

  const aggregated = new Set();
  for (const set of (campaign.adSets || [])) {
    const productSetProducts = set.productSetId ? (productSetMap.get(set.productSetId) || []) : [];

    for (const ad of (set.ads || [])) {
      // Tier 1 — product set wins outright when present.
      if (productSetProducts.length > 0) {
        ad.matchedProductIds = productSetProducts;
        ad.matchMethod       = 'product-set';
        for (const id of productSetProducts) aggregated.add(String(id));
        const cid = ad.creativeRef?.creativeId;
        const cre = cid ? creativeMap.get(String(cid)) : null;
        if (cre) ad.creative = creativeFields(extractCreativeContent(cre));
        continue;
      }

      const cid = ad.creativeRef?.creativeId;
      const cre = cid ? creativeMap.get(String(cid)) : null;
      if (!cre) {
        ad.matchedProductIds = [];
        ad.matchMethod       = null;
        continue;
      }

      const extracted = extractCreativeContent(cre);
      ad.creative = creativeFields(extracted);

      const match = core.matchOne(extracted, matchIndices);
      if (match) {
        ad.matchedProductIds = match.productIds;
        ad.matchMethod       = match.method;
        for (const id of match.productIds) aggregated.add(String(id));
      } else {
        ad.matchedProductIds = [];
        ad.matchMethod       = null;
      }
    }
  }

  return Array.from(aggregated);
}

// ── Tier 1 — product set expansion ───────────────────────────────────

async function expandProductSets(productSetIds, token, { urlIndex, skuIndex }) {
  const fields = ['id','retailer_id','name','url'].join(',');
  const out = new Map();

  await Promise.all(productSetIds.map(async id => {
    const matched = [];
    let url = `${META_GRAPH_ROOT}/${id}/products`;
    let params = { fields, access_token: token, limit: 100 };
    let pages = 0;
    while (url && pages < 10) {
      let res;
      try {
        res = await axios.get(url, { params, timeout: 25000 });
      } catch (err) {
        const detail = err.response?.data?.error?.message || err.message;
        const code   = err.response?.data?.error?.code;
        if (code === 100 || code === 803 || code === 200 || code === 190) {
          if (pages === 0) {
            console.log(`   · product set ${id} unreadable (${detail}) — falling through to creative match`);
          }
          break;
        }
        console.warn(`   ⚠️  product set ${id} fetch failed: ${detail}`);
        break;
      }
      for (const row of (res.data?.data || [])) {
        const productId = resolveCatalogProduct(row, { urlIndex, skuIndex });
        if (productId) matched.push(productId);
      }
      const next = res.data?.paging?.next;
      url = next || null;
      params = next ? null : params;
      pages++;
    }
    out.set(id, Array.from(new Set(matched.map(String))).map(s => matched.find(m => String(m) === s)));
  }));

  return out;
}

function resolveCatalogProduct(row, { urlIndex, skuIndex }) {
  if (row.retailer_id && skuIndex.has(String(row.retailer_id))) {
    return skuIndex.get(String(row.retailer_id))._id;
  }
  if (row.url) {
    const key = core.normalizeUrlKey(row.url);
    if (key && urlIndex.has(key)) {
      return urlIndex.get(key)._id;
    }
  }
  return null;
}

// ── Creative fetch ───────────────────────────────────────────────────

async function fetchCreativeBatch(creativeIds, token) {
  const fields = [
    'id','name',
    'image_url','thumbnail_url',
    'object_story_spec',
    'asset_feed_spec',
    'effective_object_story_id'
  ].join(',');

  const map = new Map();

  if (creativeIds.length <= 4) {
    await Promise.all(creativeIds.map(async id => {
      try {
        const res = await axios.get(`${META_GRAPH_ROOT}/${id}`, {
          params: { fields, access_token: token },
          timeout: 20000
        });
        if (res.data) map.set(String(id), res.data);
      } catch (err) {
        console.warn(`   ⚠️  creative ${id} fetch failed: ${err.response?.data?.error?.message || err.message}`);
      }
    }));
    return map;
  }

  for (let i = 0; i < creativeIds.length; i += 50) {
    const slice = creativeIds.slice(i, i + 50);
    const batch = slice.map(id => ({
      method:       'GET',
      relative_url: `${id}?fields=${encodeURIComponent(fields)}`
    }));
    try {
      const res = await axios.post(META_GRAPH_ROOT, null, {
        params:  { access_token: token, batch: JSON.stringify(batch) },
        timeout: 30000
      });
      for (let j = 0; j < slice.length; j++) {
        const op = res.data?.[j];
        if (!op || op.code !== 200 || !op.body) continue;
        try {
          const body = JSON.parse(op.body);
          if (body?.id) map.set(String(body.id), body);
        } catch { /* skip malformed */ }
      }
    } catch (err) {
      console.warn(`   ⚠️  creative batch failed: ${err.response?.data?.error?.message || err.message}`);
    }
  }
  return map;
}

// ── Creative content extraction ──────────────────────────────────────

function extractCreativeContent(cre) {
  const linkData  = cre.object_story_spec?.link_data  || {};
  const videoData = cre.object_story_spec?.video_data || {};
  const photoData = cre.object_story_spec?.photo_data || {};
  const feed      = cre.asset_feed_spec || {};

  const title = linkData.name || videoData.title || feed.titles?.[0]?.text || cre.name || null;
  const body  = linkData.message || videoData.message || photoData.caption || feed.bodies?.[0]?.text || null;
  const linkUrl = linkData.link
                || videoData.call_to_action?.value?.link
                || feed.link_urls?.[0]?.website_url
                || null;
  const imageUrl     = cre.image_url || linkData.picture || feed.images?.[0]?.url || null;
  const thumbnailUrl = cre.thumbnail_url || feed.images?.[0]?.url || null;
  const callToAction = linkData.call_to_action?.type
                    || videoData.call_to_action?.type
                    || feed.call_to_action_types?.[0]
                    || null;

  return { title, body, linkUrl, imageUrl, thumbnailUrl, callToAction };
}

function creativeFields(extracted) {
  return {
    imageUrl:     extracted.imageUrl     || null,
    thumbnailUrl: extracted.thumbnailUrl || null,
    linkUrl:      extracted.linkUrl      || null,
    title:        extracted.title        || null,
    body:         extracted.body         || null,
    callToAction: extracted.callToAction || null
  };
}

// Meta wraps outbound URLs through l.facebook.com/l.php?u=ENCODED or
// l.instagram.com/?u=ENCODED. Unwrap to the underlying destination
// before URL matching. Plain URLs that don't need unwrapping pass through.
function unwrapMetaLink(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(rawUrl);
    if (/(^|\.)l\.facebook\.com$/i.test(u.hostname) ||
        /(^|\.)l\.instagram\.com$/i.test(u.hostname) ||
        /(^|\.)lm\.facebook\.com$/i.test(u.hostname)) {
      const target = u.searchParams.get('u');
      if (target) return decodeURIComponent(target);
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

module.exports = {
  matchCampaignCreatives,
  // Re-exports from core for callers that previously imported these
  // off the Meta matcher (productMatchService, etc.).
  deriveCampaignKind: core.deriveCampaignKind,
  tokenize:           core.tokenize,
  normalizeUrlKey:    core.normalizeUrlKey,
  isCollectionPath:   core.isCollectionPath,
  extractCollectionSlug: core.extractCollectionSlug,
  TEXT_SCORE_THRESHOLD:  core.TEXT_SCORE_THRESHOLD,
  BRAND_OBJECTIVES:      core.BRAND_OBJECTIVES,
  // Meta-specific
  unwrapMetaLink
};
