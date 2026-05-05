// Creative → CatalogProduct matcher for synced Meta Ads campaigns.
//
// For each ad in a synced campaign, we extract the creative content
// (caption, title, image, link) from Meta's Graph API, then match
// against the brand's CatalogProduct rows by:
//
//   1. URL matching — unwrap Meta's l.facebook.com / l.instagram.com
//      shim and compare hostname + path against CatalogProduct.productUrl.
//      High confidence; one URL ≈ one product.
//   2. Text similarity — weighted token overlap of the creative's
//      title + body + link description against each candidate's
//      title + description. Picks the top match above the 0.40
//      threshold; reuses the same scoring shape as
//      productMatchService.findCatalogMatchByText so the two paths
//      stay calibrated.
//   3. Image similarity — future. The schema reserves space for it
//      but the matcher only runs URL + text today.
//
// Public entry: matchCampaignCreatives({ brandId, token, campaign })
//   Mutates campaign.adSets[*].ads[*] in place with creative + match
//   fields, returns the deduped matchedProductIds for the campaign.

const axios = require('axios');
const CatalogProduct = require('../models/CatalogProduct');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// Minimal stopword list — same shape as productMatchService.tokenize.
const STOPWORDS = new Set([
  'a','an','the','and','or','of','to','for','in','on','at','by','with',
  'is','are','was','were','be','been','being','this','that','these','those',
  'it','its','as','our','your','their','my','we','you','i','from','up','out',
  'shop','now','buy','get','new','sale','off','only','today'
]);

const URL_MATCH_CONFIDENCE  = 1.0;
const TEXT_SCORE_THRESHOLD  = 0.40;

// ── Public entry ─────────────────────────────────────────────────────

async function matchCampaignCreatives({ brandId, token, campaign }) {
  if (!brandId || !token || !campaign) return [];
  // One pass to collect every distinct creativeId across the campaign.
  const creativeIds = new Set();
  for (const set of (campaign.adSets || [])) {
    for (const ad of (set.ads || [])) {
      const cid = ad.creativeRef?.creativeId;
      if (cid) creativeIds.add(String(cid));
    }
  }
  if (creativeIds.size === 0) return [];

  // Pull every creative's content in parallel. Meta tolerates this
  // for a brand-sized fan-out; rate-limit handling stays simple.
  const creativeMap = await fetchCreativeBatch(Array.from(creativeIds), token);

  // Pull the brand's catalog once. Limited projection keeps memory
  // reasonable even for large catalogs (50 fields × ~10K rows ≈ MB-scale).
  const products = await CatalogProduct
    .find({ brandId, draft: { $ne: true } })
    .select('title description productUrl externalId imageUrl')
    .lean();

  if (products.length === 0) return [];

  // Pre-compute search indices once per sync.
  const urlIndex  = buildUrlIndex(products);
  const textIndex = products.map(p => ({
    product:    p,
    haystackTokens: tokenize(`${p.title || ''} ${p.description || ''}`)
  }));

  const aggregated = new Set();

  for (const set of (campaign.adSets || [])) {
    for (const ad of (set.ads || [])) {
      const cid = ad.creativeRef?.creativeId;
      const cre = cid ? creativeMap.get(String(cid)) : null;
      if (!cre) continue;

      const extracted = extractCreativeContent(cre);
      ad.creative = {
        imageUrl:     extracted.imageUrl     || null,
        thumbnailUrl: extracted.thumbnailUrl || null,
        linkUrl:      extracted.linkUrl      || null,
        title:        extracted.title        || null,
        body:         extracted.body         || null,
        callToAction: extracted.callToAction || null
      };

      const match = matchOne(extracted, urlIndex, textIndex);
      if (match) {
        ad.matchedProductIds = [match.productId];
        ad.matchMethod       = match.method;
        aggregated.add(String(match.productId));
      } else {
        ad.matchedProductIds = [];
        ad.matchMethod       = null;
      }
    }
  }

  return Array.from(aggregated);
}

// ── Creative fetch ───────────────────────────────────────────────────

async function fetchCreativeBatch(creativeIds, token) {
  // Meta's batch API supports up to 50 ops per request and each op is
  // an arbitrary GET. Cheaper than N parallel HTTP calls when we have
  // > 5 creatives to fetch. For < 5 we fall back to parallel singles.
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

  // Batch path. Meta accepts the batch as a JSON-string POST param.
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

// Different Meta creative shapes put the same data in different
// places. Page-post link ads use object_story_spec.link_data; dynamic
// product ads use asset_feed_spec; image ads put image_url at the top
// level. Pull from each, prefer the most specific.
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

// ── URL matching ─────────────────────────────────────────────────────

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

// Meta wraps outbound URLs through l.facebook.com/l.php?u=ENCODED or
// l.instagram.com/?u=ENCODED. Unwrap to the underlying destination.
// Also handles plain URLs that don't need unwrapping.
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

function matchByUrl(creativeUrl, urlIndex) {
  const direct = unwrapMetaLink(creativeUrl);
  const key = normalizeUrlKey(direct);
  if (!key) return null;

  // Exact host+path hit.
  if (urlIndex.has(key)) {
    return { productId: urlIndex.get(key)._id, method: 'url' };
  }
  // Prefix hit — the creative URL deep-links into a section that
  // contains the product page (e.g. /collections/x/products/y vs
  // /products/y). Match if the product's normalized URL is a suffix.
  for (const [productKey, product] of urlIndex.entries()) {
    if (key.endsWith(productKey) || productKey.endsWith(key)) {
      return { productId: product._id, method: 'url' };
    }
  }
  return null;
}

// ── Text matching ────────────────────────────────────────────────────

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
  if (queryTokens.size < 2) return null;     // not enough signal

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
  return best ? { productId: best.productId, method: 'text', score: best.score } : null;
}

// ── Per-ad match ─────────────────────────────────────────────────────

function matchOne(extracted, urlIndex, textIndex) {
  const url = extracted.linkUrl ? matchByUrl(extracted.linkUrl, urlIndex) : null;
  if (url) {
    const txt = matchByText(extracted, textIndex);
    return {
      productId: url.productId,
      method:    txt && String(txt.productId) === String(url.productId) ? 'mixed' : 'url'
    };
  }
  const txt = matchByText(extracted, textIndex);
  if (txt) return { productId: txt.productId, method: 'text' };
  return null;
}

module.exports = {
  matchCampaignCreatives,
  // exported for tests / future reuse
  unwrapMetaLink,
  normalizeUrlKey,
  tokenize,
  URL_MATCH_CONFIDENCE,
  TEXT_SCORE_THRESHOLD
};
