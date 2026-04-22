// Product details enrichment — given an identified product, fetch structured
// price, specs, and Google reviews via SerpAPI's Google Shopping + Google
// Product engines. Runs AFTER the reasoner has committed to a product name,
// so the query is precise.
//
// Two API calls per product:
//   1. google_shopping: price comparison across sellers (cheap, reliable)
//   2. google_product:  full details + reviews for the top product_id
// Second call only fires if the first returns a product_id.

const axios = require('axios');

const ENDPOINT = 'https://serpapi.com/search.json';
const COUNTRY  = process.env.SERPAPI_COUNTRY || 'us';

const _rawKey = process.env.SERPAPI_API_KEY || '';
const _key    = _rawKey.trim().replace(/^['"]|['"]$/g, '');

function isEnabled() { return !!_key; }

async function fetchProductDetails(identification) {
  if (!isEnabled()) throw new Error('SERPAPI_API_KEY not set');
  if (!identification?.productName) return null;

  const t0 = Date.now();
  const query = [identification.brand, identification.productName, identification.variant]
    .filter(Boolean).join(' ').trim();

  // ── 1. Google Shopping: price + seller comparison ──
  const shopping = await serp({
    engine: 'google_shopping',
    q: query,
    gl: COUNTRY
  });
  const shoppingResults = shopping?.shopping_results || [];
  if (!shoppingResults.length) {
    console.log(`   ○ product-details: no google_shopping results for "${query}" in ${Date.now() - t0}ms`);
    return null;
  }

  const top = shoppingResults[0];

  // ── 2. Google Product (only if we got a product_id) ──
  let productData = null, reviewsBlock = null;
  if (top.product_id) {
    try {
      const prodRes = await serp({
        engine: 'google_product',
        product_id: top.product_id,
        gl: COUNTRY
      });
      productData  = prodRes?.product_results || null;
      reviewsBlock = prodRes?.reviews_results || null;
    } catch (err) {
      console.warn(`   ⚠️  google_product(${top.product_id}) failed: ${err.message}`);
    }
  }

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

  // Reviews: normalize SerpAPI's shape into our own
  const reviews = (reviewsBlock?.reviews || []).slice(0, 10).map(r => ({
    rating: r.rating || null,
    title:  r.title || '',
    text:   r.text || r.snippet || '',
    author: r.author || r.name || '',
    date:   r.date || '',
    source: r.source || ''
  }));

  const ratingDistribution = (reviewsBlock?.ratings || []).map(r => ({
    stars:  r.stars || 0,
    count:  r.amount || r.count || 0
  }));

  const result = {
    title:        productData?.title || top.title || identification.productName,
    description:  productData?.description || top.description || null,
    thumbnail:    productData?.media?.[0]?.link || top.thumbnail || identification.primaryThumbnail || null,
    price: {
      display:     top.price || (productData?.prices && productData.prices[0]) || null,
      value:       typeof top.extracted_price === 'number' ? top.extracted_price : null,
      currency:    top.currency || 'USD'
    },
    rating:       typeof (productData?.rating) === 'number' ? productData.rating
                  : typeof top.rating === 'number' ? top.rating : null,
    reviewCount:  productData?.reviews || top.reviews || 0,
    ratingDistribution,
    reviews,
    sellers,
    specs:        productData?.specifications || productData?.specs || {},
    productId:    top.product_id || null,
    source:       'serpapi-shopping+product'
  };

  console.log(`   ✓ product-details: ${sellers.length} seller(s), ${reviews.length} review(s), rating=${result.rating ?? 'n/a'}, price=${result.price.display ?? 'n/a'} in ${Date.now() - t0}ms`);
  return result;
}

async function serp(params) {
  const res = await axios.get(ENDPOINT, {
    params: { ...params, api_key: _key },
    timeout: 30000
  });
  return res.data;
}

module.exports = { fetchProductDetails, isEnabled };
