// Platform-agnostic creative → CatalogProduct matcher.
//
// The cascade is the same for Meta and Google (and any future ad
// platform): given an extracted creative {title, body, linkUrl}, walk
// the index of catalog products and resolve to one or more SKUs via
// URL match → collection-URL fallback → text similarity. Per-platform
// adapters are thin wrappers that fetch + extract the creative
// content into the common shape, then call the helpers here.
//
// The deriveCampaignKind helper is also platform-agnostic — it walks
// adSets[*].ads[*].matchMethod plus adSets[*].productSetId to label
// the campaign as 'product' / 'collection' / 'brand'.

const STOPWORDS = new Set([
  'a','an','the','and','or','of','to','for','in','on','at','by','with',
  'is','are','was','were','be','been','being','this','that','these','those',
  'it','its','as','our','your','their','my','we','you','i','from','up','out',
  'shop','now','buy','get','new','sale','off','only','today'
]);

const TEXT_SCORE_THRESHOLD = 0.40;

// URL path segments indicating a collection / category page rather
// than a single SKU. Matched anywhere in the path.
const COLLECTION_PATH_PATTERNS = [
  /\/collections?\//i,
  /\/category\//i,
  /\/categories\//i,
  /\/shop\//i,
  /\/c\//i,
  /\/department\//i,
  /\/browse\//i
];

// Brand-awareness campaign objectives (Meta-flavored — Google's
// advertising_channel_type is too coarse to bucket reliably; Google
// campaigns fall through to 'brand' by default when nothing matches).
const BRAND_OBJECTIVES = new Set([
  'OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT',
  'BRAND_AWARENESS', 'REACH', 'VIDEO_VIEWS', 'POST_ENGAGEMENT',
  'PAGE_LIKES', 'EVENT_RESPONSES', 'MESSAGES'
]);

// ── Tokenization + URL normalization ────────────────────────────────

function tokenize(text) {
  if (!text) return new Set();
  const toks = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length >= 3 && !STOPWORDS.has(t));
  return new Set(toks);
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

function isCollectionPath(parsedUrl) {
  const path = parsedUrl.pathname || '';
  return COLLECTION_PATH_PATTERNS.some(rx => rx.test(path));
}

function extractCollectionSlug(parsedUrl) {
  const path = parsedUrl.pathname || '';
  for (const rx of COLLECTION_PATH_PATTERNS) {
    const m = path.match(new RegExp(rx.source + '([^/?#]+)', 'i'));
    if (m && m[1]) return decodeURIComponent(m[1]).replace(/[-_+]/g, ' ').toLowerCase();
  }
  return null;
}

// ── Index builders ──────────────────────────────────────────────────

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
  // CatalogProduct.externalId — the merchant's SKU, matched against
  // platform-specific identifiers (Meta retailer_id, Google offer_id).
  const byExternalId = new Map();
  for (const p of products) {
    if (p.externalId) byExternalId.set(String(p.externalId), p);
  }
  return byExternalId;
}

function buildCategoryIndex(products) {
  const byCategory = new Map();
  for (const p of products) {
    const cat = (p.category || '').toLowerCase().trim();
    if (!cat) continue;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(p);
  }
  return byCategory;
}

function buildIndices(products) {
  return {
    urlIndex:  buildUrlIndex(products),
    skuIndex:  buildSkuIndex(products),
    catIndex:  buildCategoryIndex(products),
    textIndex: products.map(p => ({
      product:        p,
      haystackTokens: tokenize(`${p.title || ''} ${p.description || ''}`)
    }))
  };
}

// ── URL match (Tier 2 + 2b) ─────────────────────────────────────────

function matchByUrl(creativeUrl, { urlIndex, catIndex, unwrapFn = (x) => x }) {
  const direct = unwrapFn(creativeUrl);
  if (!direct) return null;

  let parsed;
  try { parsed = new URL(direct); } catch { return null; }

  const key = normalizeUrlKey(direct);
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
        const dedup = Array.from(new Set(ids.map(String))).map(s => ids.find(i => String(i) === s));
        return { productIds: dedup, method: 'collection' };
      }
    }
  }
  return null;
}

// ── Text match (Tier 3) ─────────────────────────────────────────────

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

// ── Per-ad cascade ──────────────────────────────────────────────────

function matchOne(extracted, indices) {
  const url = extracted.linkUrl ? matchByUrl(extracted.linkUrl, indices) : null;
  if (url && url.method === 'url') {
    const txt = matchByText(extracted, indices.textIndex);
    return {
      productIds: url.productIds,
      method:     txt && String(txt.productIds[0]) === String(url.productIds[0]) ? 'mixed' : 'url'
    };
  }
  if (url && url.method === 'collection') return url;
  const txt = matchByText(extracted, indices.textIndex);
  if (txt) return { productIds: txt.productIds, method: 'text' };
  return null;
}

// ── Campaign kind derivation ────────────────────────────────────────

function deriveCampaignKind(campaign) {
  const methods = new Set();
  let hasProductSet = false;
  for (const set of (campaign.adSets || [])) {
    if (set.productSetId) hasProductSet = true;
    for (const ad of (set.ads || [])) {
      if (ad.matchMethod) methods.add(ad.matchMethod);
    }
  }
  if (methods.has('product-set') || methods.has('url') || methods.has('mixed') || methods.has('text')) {
    return 'product';
  }
  // Platform-resolved product set with no per-ad creative match —
  // typical for Google PMax / Shopping where the listing-group naming
  // is Merchant-Center-side and we haven't expanded to SKUs yet.
  if (hasProductSet) return 'product';
  if (methods.has('collection')) return 'collection';
  const obj = String(campaign.objective || '').toUpperCase();
  if (BRAND_OBJECTIVES.has(obj)) return 'brand';
  return 'brand';
}

module.exports = {
  STOPWORDS,
  TEXT_SCORE_THRESHOLD,
  BRAND_OBJECTIVES,
  COLLECTION_PATH_PATTERNS,
  tokenize,
  normalizeUrlKey,
  isCollectionPath,
  extractCollectionSlug,
  buildUrlIndex,
  buildSkuIndex,
  buildCategoryIndex,
  buildIndices,
  matchByUrl,
  matchByText,
  matchOne,
  deriveCampaignKind
};
