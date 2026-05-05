// Creative → CatalogProduct matcher for synced Meta Ads campaigns.
//
// Layered cascade — each tier falls through to the next when it can't
// resolve:
//
//   Tier 1 — product_set_id expansion.
//     DPA / Advantage+ ad sets carry a product_set_id; we hit Meta's
//     /{product_set_id}/products endpoint and map each returned SKU
//     back to CatalogProduct via retailer_id (→ externalId) or
//     normalized url (→ productUrl). Highest confidence — Meta has
//     done the matching for us.
//
//   Tier 2 — URL match.
//     Per-ad creative.linkUrl → unwrap l.facebook.com / l.instagram.com
//     redirects → exact + suffix match against CatalogProduct.productUrl.
//     Falls through to Tier 2b (collection match) when the URL points
//     at a category / collection page rather than a SKU.
//
//   Tier 2b — collection / category URL.
//     URLs like /collections/summer-sale, /category/men, /shop/sale
//     are resolved against CatalogProduct.category as a substring
//     match. Returns every product in that category — wider net than
//     a SKU match but still campaign-relevant.
//
//   Tier 3 — text similarity.
//     Weighted token overlap of creative.title + body against each
//     candidate's title + description, threshold 0.40.
//
//   Tier 4 — image similarity.
//     Future. Schema reserves space; not yet implemented.
//
//   Fallback — campaignKind='brand'.
//     When no tier resolves AND the campaign objective is awareness /
//     traffic / engagement / video_views, the matcher returns nothing
//     and the wizard's Step 2 surfaces a "brand-awareness campaign —
//     pick products manually" empty state.
//
// Public entry: matchCampaignCreatives({ brandId, token, campaign })
//   Mutates campaign.adSets[*].ads[*] in place and returns the deduped
//   campaign-level matchedProductIds.
// Public helper: deriveCampaignKind({ campaign, matchedAny })
//   Returns 'product' | 'collection' | 'brand' for the schema field.

const axios = require('axios');
const CatalogProduct = require('../models/CatalogProduct');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

const STOPWORDS = new Set([
  'a','an','the','and','or','of','to','for','in','on','at','by','with',
  'is','are','was','were','be','been','being','this','that','these','those',
  'it','its','as','our','your','their','my','we','you','i','from','up','out',
  'shop','now','buy','get','new','sale','off','only','today'
]);

const TEXT_SCORE_THRESHOLD  = 0.40;

// Common URL path segments that indicate a collection / category page
// rather than a single product. Matches anywhere in the path.
const COLLECTION_PATH_PATTERNS = [
  /\/collections?\//i,
  /\/category\//i,
  /\/categories\//i,
  /\/shop\//i,
  /\/c\//i,
  /\/department\//i,
  /\/browse\//i
];

// Brand-awareness objectives where we shouldn't expect SKU resolution.
const BRAND_OBJECTIVES = new Set([
  'OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT',
  'BRAND_AWARENESS', 'REACH', 'VIDEO_VIEWS', 'POST_ENGAGEMENT',
  'PAGE_LIKES', 'EVENT_RESPONSES', 'MESSAGES'
]);

// ── Public entry ─────────────────────────────────────────────────────

async function matchCampaignCreatives({ brandId, token, campaign }) {
  if (!brandId || !token || !campaign) return [];

  // Pull the brand's catalog once. Limited projection keeps memory
  // bounded for large catalogs.
  const products = await CatalogProduct
    .find({ brandId, draft: { $ne: true } })
    .select('title description productUrl externalId imageUrl category')
    .lean();
  if (products.length === 0) return [];

  // Pre-compute search indices once per sync.
  const urlIndex   = buildUrlIndex(products);
  const skuIndex   = buildSkuIndex(products);
  const catIndex   = buildCategoryIndex(products);
  const textIndex  = products.map(p => ({
    product:    p,
    haystackTokens: tokenize(`${p.title || ''} ${p.description || ''}`)
  }));

  // ── Tier 1 — expand product_set_id (DPA / Advantage+ campaigns) ──
  // Each ad set may name one product set; resolve each unique id to
  // a list of CatalogProduct._id once per sync.
  const productSetIds = new Set();
  for (const set of (campaign.adSets || [])) {
    if (set.productSetId) productSetIds.add(set.productSetId);
  }
  const productSetMap = productSetIds.size > 0
    ? await expandProductSets(Array.from(productSetIds), token, { urlIndex, skuIndex })
    : new Map();

  // ── Tier 2/3 — fetch creative content for ads without a productSet ──
  const creativeIds = new Set();
  for (const set of (campaign.adSets || [])) {
    // Skip creative fetch for ads under an ad set whose productSet
    // already resolved — Tier 1 alone is authoritative for them.
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

  // ── Per-ad resolution ─────────────────────────────────────────────
  const aggregated = new Set();

  for (const set of (campaign.adSets || [])) {
    const productSetProducts = set.productSetId ? (productSetMap.get(set.productSetId) || []) : [];

    for (const ad of (set.ads || [])) {
      // Tier 1 — product set wins outright when present.
      if (productSetProducts.length > 0) {
        ad.matchedProductIds = productSetProducts;
        ad.matchMethod       = 'product-set';
        for (const id of productSetProducts) aggregated.add(String(id));
        // Still snapshot the creative so the UI can show the ad's
        // image/caption alongside its matched products.
        const cid = ad.creativeRef?.creativeId;
        const cre = cid ? creativeMap.get(String(cid)) : null;
        if (cre) ad.creative = creativeFields(extractCreativeContent(cre));
        continue;
      }

      // Tier 2/3 — creative-driven matching.
      const cid = ad.creativeRef?.creativeId;
      const cre = cid ? creativeMap.get(String(cid)) : null;
      if (!cre) {
        ad.matchedProductIds = [];
        ad.matchMethod       = null;
        continue;
      }

      const extracted = extractCreativeContent(cre);
      ad.creative = creativeFields(extracted);

      const match = matchOne(extracted, { urlIndex, catIndex, textIndex });
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

// ── Campaign kind derivation ─────────────────────────────────────────

function deriveCampaignKind(campaign) {
  // Walk every ad's matchMethod to figure out the dominant resolution
  // tier. URL / product-set / text → 'product'; collection → 'collection';
  // nothing → 'brand' if objective hints at brand awareness, else 'brand'
  // as a safe default that surfaces the operator-pick fallback.
  const methods = new Set();
  for (const set of (campaign.adSets || [])) {
    for (const ad of (set.ads || [])) {
      if (ad.matchMethod) methods.add(ad.matchMethod);
    }
  }
  if (methods.has('product-set') || methods.has('url') || methods.has('mixed') || methods.has('text')) {
    return 'product';
  }
  if (methods.has('collection')) return 'collection';
  // No matches resolved. Lean on objective to label brand-awareness.
  const obj = String(campaign.objective || '').toUpperCase();
  if (BRAND_OBJECTIVES.has(obj)) return 'brand';
  return 'brand';
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
    while (url && pages < 10) {     // hard cap — 1000 SKUs per product set
      let res;
      try {
        res = await axios.get(url, { params, timeout: 25000 });
      } catch (err) {
        const detail = err.response?.data?.error?.message || err.message;
        const code   = err.response?.data?.error?.code;
        // 100 / 803 = invalid id or no permission. Insufficient scope
        // (catalog_management) is common — skip the set quietly so
        // creative-level matching can still take over.
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
    // Dedupe — Meta sometimes returns the same SKU twice across pages.
    out.set(id, Array.from(new Set(matched.map(String))).map(s => matched.find(m => String(m) === s)));
  }));

  return out;
}

function resolveCatalogProduct(row, { urlIndex, skuIndex }) {
  // retailer_id → CatalogProduct.externalId is the most reliable map
  // (Meta carries through the merchant's SKU id when the catalog was
  // ingested via feed / pixel).
  if (row.retailer_id && skuIndex.has(String(row.retailer_id))) {
    return skuIndex.get(String(row.retailer_id))._id;
  }
  // Fallback to url match.
  if (row.url) {
    const key = normalizeUrlKey(row.url);
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
  const linkData = cre.object_story_spec?.link_data || {};
  const videoData = cre.object_story_spec?.video_data || {};
  const photoData = cre.object_story_spec?.photo_data || {};
  const feed = cre.asset_feed_spec || {};

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

// ── URL / SKU / category indices ─────────────────────────────────────

function buildUrlIndex(products) {
  const byHostPath = new Map();
  for (const p of products) {
    if (!p.productUrl) continue;
    const key = normalizeUrlKey(p.productUrl);
    if (!key) continue;
    if (!byHostPath.has(key)) byHostPath.set(key, p);
  }
  return byHostPath;
}

function buildSkuIndex(products) {
  // CatalogProduct.externalId is the merchant's SKU id, matched
  // against Meta's product.retailer_id during product-set expansion.
  const byExternalId = new Map();
  for (const p of products) {
    if (p.externalId) byExternalId.set(String(p.externalId), p);
  }
  return byExternalId;
}

function buildCategoryIndex(products) {
  // Lowercase normalized category → list of CatalogProducts in it.
  // Used by collection-URL fallback.
  const byCategory = new Map();
  for (const p of products) {
    const cat = (p.category || '').toLowerCase().trim();
    if (!cat) continue;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(p);
  }
  return byCategory;
}

function normalizeUrlKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return path ? `${host}${path}` : host;
  } catch {
    return null;
  }
}

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

// ── URL matching (Tier 2 + 2b) ───────────────────────────────────────

function isCollectionPath(parsedUrl) {
  const path = parsedUrl.pathname || '';
  return COLLECTION_PATH_PATTERNS.some(rx => rx.test(path));
}

function extractCollectionSlug(parsedUrl) {
  // Take the path segment AFTER the collection-indicator and treat it
  // as the slug. /collections/summer-sale → 'summer-sale';
  // /shop/men/hats → 'men' (first segment after the marker).
  const path = parsedUrl.pathname || '';
  for (const rx of COLLECTION_PATH_PATTERNS) {
    const m = path.match(new RegExp(rx.source + '([^/?#]+)', 'i'));
    if (m && m[1]) return decodeURIComponent(m[1]).replace(/[-_+]/g, ' ').toLowerCase();
  }
  return null;
}

function matchByUrl(creativeUrl, { urlIndex, catIndex }) {
  const direct = unwrapMetaLink(creativeUrl);
  if (!direct) return null;

  let parsed;
  try { parsed = new URL(direct); } catch { return null; }

  const key = normalizeUrlKey(direct);
  // Tier 2 — exact + suffix SKU match.
  if (key) {
    if (urlIndex.has(key)) {
      return { productIds: [urlIndex.get(key)._id], method: 'url' };
    }
    for (const [productKey, product] of urlIndex.entries()) {
      if (key.endsWith(productKey) || productKey.endsWith(key)) {
        return { productIds: [product._id], method: 'url' };
      }
    }
  }
  // Tier 2b — collection / category URL → return everything in that
  // category.
  if (isCollectionPath(parsed)) {
    const slug = extractCollectionSlug(parsed);
    if (slug) {
      const ids = [];
      for (const [cat, list] of catIndex.entries()) {
        if (cat.includes(slug) || slug.includes(cat)) {
          for (const p of list) ids.push(p._id);
        }
      }
      if (ids.length > 0) {
        return { productIds: Array.from(new Set(ids.map(String))).map(s => ids.find(i => String(i) === s)), method: 'collection' };
      }
    }
  }
  return null;
}

// ── Text matching (Tier 3) ───────────────────────────────────────────

function tokenize(text) {
  if (!text) return new Set();
  const toks = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length >= 3 && !STOPWORDS.has(t));
  return new Set(toks);
}

function matchByText(extracted, textIndex) {
  const haystack = `${extracted.title || ''} ${extracted.body || ''}`;
  const queryTokens = tokenize(haystack);
  if (queryTokens.size < 2) return null;

  let best = null;
  for (const { product, haystackTokens } of textIndex) {
    if (!haystackTokens.size) continue;
    let shared = 0;
    for (const t of queryTokens) if (haystackTokens.has(t)) shared++;
    const score = shared / queryTokens.size;
    if (score >= TEXT_SCORE_THRESHOLD && (!best || score > best.score)) {
      best = { score, productId: product._id };
    }
  }
  return best ? { productIds: [best.productId], method: 'text', score: best.score } : null;
}

// ── Per-ad cascade ───────────────────────────────────────────────────

function matchOne(extracted, indices) {
  // Tier 2/2b — URL match (SKU, then collection fallback).
  const url = extracted.linkUrl ? matchByUrl(extracted.linkUrl, indices) : null;
  if (url && url.method === 'url') {
    const txt = matchByText(extracted, indices.textIndex);
    return {
      productIds: url.productIds,
      method:     txt && String(txt.productIds[0]) === String(url.productIds[0]) ? 'mixed' : 'url'
    };
  }
  if (url && url.method === 'collection') return url;

  // Tier 3 — text match.
  const txt = matchByText(extracted, indices.textIndex);
  if (txt) return { productIds: txt.productIds, method: 'text' };
  return null;
}

module.exports = {
  matchCampaignCreatives,
  deriveCampaignKind,
  // exported for tests / future reuse
  unwrapMetaLink,
  normalizeUrlKey,
  tokenize,
  isCollectionPath,
  extractCollectionSlug,
  TEXT_SCORE_THRESHOLD,
  BRAND_OBJECTIVES
};
