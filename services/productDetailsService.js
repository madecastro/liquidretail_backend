// Product details enrichment — given an identified product, fetch structured
// price, seller, description, review, and spec data.
//
// HISTORY: The old pipeline used SerpAPI's `google_product` engine for
// description, full specs, rating distribution, and individual review text.
// Google retired that engine. SerpApi published the Google Immersive Product
// API as the official replacement for those exact fields, and Phase 1.9
// wires it back in. The Gemini-generated narrative review summary stays —
// it pulls from a broader source pool (Reddit, YouTube, Trustpilot, etc.)
// than Immersive's Google-curated review rows, and the two complement each
// other (narrative for hero copy; rows for review-collage UI variants).
//
// Pipeline:
//   1. google_shopping  (SerpAPI) — price / sellers / rating / review-count + immersive token
//   2. gemini-reviews   (grounded) — narrative review summary + cited sources
//      (1 + 2 run in parallel)
//   3. google_immersive_product (SerpAPI, Phase 1.9) — chained AFTER #1 returns
//      using top.immersive_product_page_token. Provides:
//        - description (manufacturer text)
//        - rating_distribution (5-star breakdown)
//        - reviews (individual review rows)
//        - specifications (structured spec table)
//      Skipped (logged) when the top shopping result has no immersive token.

const axios = require('axios');
const CatalogProduct = require('../models/CatalogProduct');

const ENDPOINT = 'https://serpapi.com/search.json';
const COUNTRY  = process.env.SERPAPI_COUNTRY || 'us';
const GEMINI_MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash';
const TTL_MS   = 30 * 24 * 60 * 60 * 1000;   // 30 days — matches productReviews/brandReviews

const _rawKey = process.env.SERPAPI_API_KEY || '';
const _key    = _rawKey.trim().replace(/^['"]|['"]$/g, '');

function isEnabled() { return !!_key; }

// Phase 2f — accepts optional catalogProductId. When provided:
//   1. If the CatalogProduct row has fresh detailsRefreshedAt (< 30 days),
//      return the cached fields directly from the row (zero API cost).
//   2. Otherwise fetch fresh + WRITE-THROUGH to the CatalogProduct row
//      (rating, ratingDistribution, reviews[], specs, sellers[],
//      reviewSummary, detailsRefreshedAt). Subsequent matches on the
//      same SKU read from cache.
//
// Without a catalogProductId, behavior is unchanged from Phase 1.9 —
// always fetches fresh, returns the merged result, no persistence.
async function fetchProductDetails(identification, catalogProductId = null) {
  if (!isEnabled()) throw new Error('SERPAPI_API_KEY not set');
  if (!identification?.productName) return null;

  // Cache read — skip the API calls entirely if the catalog row is fresh.
  if (catalogProductId) {
    const cached = await readFromCatalogCache(catalogProductId);
    if (cached) {
      console.log(`   ✓ product-details: cache hit on CatalogProduct ${catalogProductId} (refreshed ${Math.round((Date.now() - new Date(cached.detailsRefreshedAt).getTime()) / 86400000)}d ago)`);
      return cached;
    }
  }

  const t0 = Date.now();
  const query = [identification.brand, identification.productName, identification.variant]
    .filter(Boolean).join(' ').trim();

  // Run shopping search and Gemini review summary in parallel — independent inputs.
  const [shoppingSettled, reviewSummarySettled] = await Promise.allSettled([
    serp({ engine: 'google_shopping', q: query, gl: COUNTRY }),
    fetchReviewSummary({
      productName: identification.productName,
      brand:       identification.brand,
      variant:     identification.variant
    })
  ]);

  if (shoppingSettled.status !== 'fulfilled') {
    console.warn(`   ⚠️  google_shopping failed in ${Date.now() - t0}ms: ${shoppingSettled.reason?.message || shoppingSettled.reason}`);
    return null;
  }
  const shoppingResults = shoppingSettled.value?.shopping_results || [];
  if (!shoppingResults.length) {
    console.log(`   ○ product-details: no google_shopping results for "${query}" in ${Date.now() - t0}ms`);
    return null;
  }

  const top = shoppingResults[0];
  const reviewSummary = reviewSummarySettled.status === 'fulfilled' ? reviewSummarySettled.value : null;

  // Phase 1.9 — Google Immersive Product API for description/reviews/specs/
  // ratingDistribution. Token comes from the top shopping result; absence
  // is logged so we know how often it's missing in production.
  const immersiveToken = top.immersive_product_page_token
                      || top.serpapi_immersive_product_api
                      || null;
  let immersive = null;
  if (immersiveToken) {
    immersive = await fetchImmersiveProduct(immersiveToken).catch(err => {
      console.warn(`   ⚠️  google_immersive_product failed: ${err.message}`);
      return null;
    });
  } else {
    console.log(`   ○ no immersive_product_page_token on top shopping result for "${query}" — description/specs/reviews fields will be null`);
  }
  const ip = immersive?.product_results || {};
  const ipReviews = immersive?.reviews_results?.reviews || immersive?.user_reviews || [];

  // Aggregate sellers across top 8 shopping results so the user sees a real
  // price-comparison table.
  const sellers = shoppingResults.slice(0, 8).map(r => ({
    name:           r.source || r.seller || '',
    price:          r.price || null,
    extractedPrice: typeof r.extracted_price === 'number' ? r.extracted_price : null,
    link:           r.link || r.product_link || null,
    shipping:       r.shipping || null,
    thumbnail:      r.thumbnail || null,
    rating:         r.rating || null,
    reviewCount:    r.reviews || null
  })).filter(s => s.link);

  const result = {
    title:        ip.title       || top.title       || identification.productName,
    description:  ip.description || null,                                          // Phase 1.9 — RECOVERED via Immersive
    thumbnail:    (Array.isArray(ip.images) && ip.images[0]) || top.thumbnail || identification.primaryThumbnail || null,
    price: {
      display:     top.price || null,
      value:       typeof top.extracted_price === 'number' ? top.extracted_price : null,
      currency:    top.currency || 'USD'
    },
    rating:       typeof ip.rating === 'number'  ? ip.rating  : (typeof top.rating === 'number' ? top.rating : null),
    reviewCount:  typeof ip.reviews === 'number' ? ip.reviews : (top.reviews || 0),
    ratingDistribution: ip.rating_distribution || [],                              // Phase 1.9 — RECOVERED
    reviews:      Array.isArray(ipReviews) ? ipReviews.slice(0, 10) : [],          // Phase 1.9 — RECOVERED individual rows
    reviewSummary,                                                                  // Gemini narrative — kept (broader source pool than Immersive's Google-curated rows)
    sellers,
    specs:        ip.specifications || ip.specs || {},                             // Phase 1.9 — RECOVERED
    productId:    top.product_id || ip.product_id || null,
    source:       immersive ? 'serpapi-shopping+immersive+gemini-reviews' : 'serpapi-shopping+gemini-reviews'
  };

  console.log(`   ✓ product-details: ${sellers.length} seller(s)${immersive ? ` + immersive (desc=${result.description ? '✓' : '∅'}, ${result.reviews.length} review row(s), ${Object.keys(result.specs).length} spec(s))` : ''}, reviewSummary=${reviewSummary ? `${reviewSummary.sources.length} src` : 'no'}, rating=${result.rating ?? 'n/a'}, price=${result.price.display ?? 'n/a'} in ${Date.now() - t0}ms`);

  // Phase 2f — write-through to CatalogProduct row when a catalogProductId
  // was provided. Persists the Immersive + commerce + Gemini fields onto
  // the row as the canonical owner; future calls on the same SKU read
  // from cache.
  if (catalogProductId) {
    try { await writeThroughToCatalogProduct(catalogProductId, result); }
    catch (err) { console.warn(`   ⚠️  CatalogProduct write-through failed: ${err.message}`); }
  }

  return result;
}

// Read cached Immersive + Gemini fields from a CatalogProduct row when
// fresh (< TTL_MS old). Returns the same shape fetchProductDetails would
// return, sourced from the row instead of the live APIs.
async function readFromCatalogCache(catalogProductId) {
  const cp = await CatalogProduct.findById(catalogProductId)
    .select('title description imageUrl productUrl price currency rating ratingDistribution reviews specs sellers reviewSummary detailsRefreshedAt productReviews')
    .lean();
  if (!cp) return null;
  const refreshedAt = cp.detailsRefreshedAt ? new Date(cp.detailsRefreshedAt).getTime() : 0;
  if (!refreshedAt || Date.now() - refreshedAt > TTL_MS) return null;
  return {
    title:        cp.title,
    description:  cp.description || null,
    thumbnail:    cp.imageUrl || null,
    price: {
      display:    null,                           // computed display strings aren't cached; consumers can format from value/currency
      value:      typeof cp.price === 'number' ? cp.price : null,
      currency:   cp.currency || 'USD'
    },
    rating:             typeof cp.rating === 'number' ? cp.rating : null,
    reviewCount:        cp.productReviews?.reviewCount ?? null,
    ratingDistribution: cp.ratingDistribution || [],
    reviews:            cp.reviews || [],
    reviewSummary:      cp.reviewSummary || null,
    sellers:            cp.sellers || [],
    specs:              cp.specs || {},
    productId:          null,
    source:             'catalog-cache',
    cachedFromCatalog:  true,
    catalogProductId
  };
}

// Persist the fetched product details onto the CatalogProduct row.
// Uses $set with conditional inserts so authoritative fields (description,
// imageUrl, productUrl) don't overwrite values the brand has explicitly
// curated — only fills gaps. The Immersive fields (rating distribution,
// reviews, specs, sellers, reviewSummary) refresh in place every call.
async function writeThroughToCatalogProduct(catalogProductId, fetched) {
  if (!fetched) return;
  const cp = await CatalogProduct.findById(catalogProductId)
    .select('description imageUrl price currency')
    .lean();
  if (!cp) return;

  const setOps = {
    rating:             fetched.rating ?? null,
    ratingDistribution: fetched.ratingDistribution || [],
    reviews:            fetched.reviews || [],
    specs:              fetched.specs || {},
    sellers:            fetched.sellers || [],
    reviewSummary:      fetched.reviewSummary || null,
    detailsRefreshedAt: new Date()
  };
  // Fill commerce gaps only — never overwrite curated brand data
  if (!cp.description && fetched.description) setOps.description = fetched.description;
  if (!cp.imageUrl    && fetched.thumbnail)   setOps.imageUrl    = fetched.thumbnail;
  if (cp.price == null && typeof fetched.price?.value === 'number') {
    setOps.price    = fetched.price.value;
    setOps.currency = fetched.price.currency || 'USD';
  }

  await CatalogProduct.updateOne({ _id: catalogProductId }, { $set: setOps });
}

// Phase 1.9 — Google Immersive Product API call. Replaces the lost
// google_product engine. Takes the immersive_product_page_token returned
// on a google_shopping top result and resolves the full product page
// (description / reviews / specs / rating distribution).
async function fetchImmersiveProduct(pageToken) {
  return serp({
    engine:     'google_immersive_product',
    page_token: pageToken,
    gl:         COUNTRY
  });
}

// Gemini grounded search → narrative review summary. Returns
// { summary, sources, queries } or null if Gemini isn't configured or the call
// fails. Mirrors the grounded-search pattern used in geminiSearchProvider.js:
// text body is taken from response content parts, cited sources come from
// groundingMetadata.groundingChunks (authoritative URL list, not prose parsing).
async function fetchReviewSummary({ productName, brand, variant }) {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!productName) return null;

  const descriptor = [brand, productName, variant].filter(Boolean).join(' ');
  const prompt =
    `Using Google Search, find recent online reviews of "${descriptor}" and write a concise, ` +
    `balanced review summary (150–250 words). Cover in natural prose:\n` +
    `  • what buyers consistently praise\n` +
    `  • common complaints or concerns\n` +
    `  • notes on durability, quality, or fit/sizing\n` +
    `  • typical use cases the product excels at\n` +
    `  • value-for-money impressions\n\n` +
    `Weight recent reviews higher. Synthesize trends — do NOT include individual review quotes or star ratings. ` +
    `If the product has very limited reviews, say so plainly.`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const t0 = Date.now();
  try {
    const res = await axios.post(
      `${endpoint}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.2,
          // 700 tokens was truncating summaries mid-sentence once the
          // 150–250 word body + any thinking overhead exceeded the ceiling.
          // Raised to leave a comfortable margin for well-reviewed products
          // where the model wants to run the full 250 words.
          maxOutputTokens: 2000,
          // Cap thinking so it never starves the actual output. Flash's
          // thinking is lighter than Pro but this guards against regressions
          // if GEMINI_SEARCH_MODEL is pointed at Pro later.
          thinkingConfig: { thinkingBudget: 512 }
        }
      },
      { timeout: 45000 }
    );

    const candidate = res.data?.candidates?.[0];
    const finishReason = candidate?.finishReason || 'unknown';
    const summary = (candidate?.content?.parts || [])
      .map(p => p.text || '')
      .join(' ')
      .trim();
    if (!summary) {
      const usage = res.data?.usageMetadata || {};
      console.log(`   ○ gemini-reviews: empty summary for "${descriptor}" (finishReason=${finishReason}, tokens out=${usage.candidatesTokenCount || 0} thought=${usage.thoughtsTokenCount || 0}) in ${Date.now() - t0}ms`);
      return null;
    }
    // Surface truncation so we notice immediately in logs rather than only
    // when a user complains the summary ends mid-word.
    if (finishReason === 'MAX_TOKENS') {
      const usage = res.data?.usageMetadata || {};
      console.warn(`   ⚠️  gemini-reviews: hit MAX_TOKENS for "${descriptor}" (out=${usage.candidatesTokenCount || 0} thought=${usage.thoughtsTokenCount || 0}) — summary may be truncated`);
    }

    const seen = new Set();
    const sources = [];
    for (const chunk of (candidate?.groundingMetadata?.groundingChunks || [])) {
      const uri = chunk?.web?.uri;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      sources.push({
        url: uri,
        title: chunk.web?.title || extractDomain(uri),
        domain: extractDomain(uri)
      });
      if (sources.length >= 8) break;
    }
    const queries = candidate?.groundingMetadata?.webSearchQueries || [];

    console.log(`   ✓ gemini-reviews: ${summary.length}ch summary, ${sources.length} source(s) in ${Date.now() - t0}ms`);
    return { summary, sources, queries };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  gemini-reviews failed in ${Date.now() - t0}ms: ${detail}`);
    return null;
  }
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

async function serp(params) {
  const res = await axios.get(ENDPOINT, {
    params: { ...params, api_key: _key },
    timeout: 30000
  });
  return res.data;
}

module.exports = { fetchProductDetails, isEnabled };
