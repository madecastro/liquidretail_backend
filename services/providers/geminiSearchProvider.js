// Gemini grounded search — text-based product discovery via Google Search tool.
// Given brand/category/subject-description, Gemini formulates a query, hits Google,
// and returns retailer URLs grounded in real web results.
//
// Key detail: when the google_search tool is enabled, Gemini produces free-form
// text with inline citations — it does NOT reliably honor a "return JSON" prompt.
// So we pull match URLs/titles directly from response.groundingMetadata
// (the authoritative source list) and use the text body as the reasoning.

const axios = require('axios');

const MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const PROVIDER_NAME = 'gemini-search';

function isEnabled() { return !!process.env.GEMINI_API_KEY; }

async function match({ brand, category, caption, primarySubject, textDetected = [] }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');

  const queryParts = [];
  if (brand)          queryParts.push(`Brand: ${brand}`);
  if (category)       queryParts.push(`Category: ${category}`);
  if (primarySubject) queryParts.push(`Product description: ${primarySubject}`);
  if (caption)        queryParts.push(`Caption: "${caption}"`);
  if (textDetected.length) queryParts.push(`Text visible on product: ${textDetected.map(t => `"${t}"`).join(', ')}`);

  const prompt =
    `Use Google Search to find where this product is sold online. Prefer the brand's own site ` +
    `and major retailers. Return a concise one-paragraph summary explaining which product you ` +
    `identified and which retailers carry it. Cite every retailer with a link so I can browse them.\n\n` +
    `Product details:\n${queryParts.join('\n')}`;

  const t0 = Date.now();
  const res = await axios.post(
    `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1200 }
    },
    { timeout: 30000 }
  );

  const candidate = res.data?.candidates?.[0];
  const reasoningText = (candidate?.content?.parts || [])
    .map(p => p.text || '')
    .join(' ')
    .trim();

  // Pull matches directly from grounding metadata — this is the authoritative
  // URL list that Google returned for this search, not something we parse from prose.
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const matches = [];
  for (const chunk of chunks) {
    const uri = chunk?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    matches.push({
      title: chunk.web?.title || extractDomain(uri),
      url: uri,
      retailer: extractDomain(uri),
      priceHint: null,           // not available from grounding chunks
      snippet: '',               // ditto; could derive from groundingSupports if desired
      thumbnail: null,
      source: PROVIDER_NAME
    });
    if (matches.length >= 10) break;
  }

  // queryUsed: Gemini doesn't expose the literal query it issued, but the
  // web search queries are sometimes in groundingMetadata.webSearchQueries.
  const searchQueries = candidate?.groundingMetadata?.webSearchQueries || [];

  console.log(`   ✓ ${PROVIDER_NAME}: ${matches.length} match(es) in ${Date.now() - t0}ms (queries: ${searchQueries.join(' | ') || 'n/a'})`);

  return {
    provider: PROVIDER_NAME,
    reasoning: reasoningText || 'Grounded Google Search returned no narrative text.',
    queryUsed: searchQueries[0] || queryParts.join(' | '),
    matches,
    groundingUrls: chunks.map(c => c.web?.uri).filter(Boolean).slice(0, 10)
  };
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Brand-category lookup. Asks Gemini grounded search to find the brand's
// own collection / category page that best matches a generic product
// label + category. Returns { breadcrumb, url, confidence, reasoning }
// for downstream use as a fallback CTA destination when no specific SKU
// match was confident enough.
//
// e.g. for { brandUrl: 'pelagicgear.com', label: 'sun shirt', category: 'apparel' }
// → { breadcrumb: 'Mens > Performance Shirts > Long Sleeve',
//     url: 'https://pelagicgear.com/collections/mens-long-sleeve-performance' }
async function lookupBrandCategoryUrl({ brandUrl, brandName, label, category }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');
  if (!brandUrl && !brandName) return null;

  const t0 = Date.now();
  const prompt =
    `Use Google Search to find the BEST matching collection / category page on ` +
    `the brand's own website for the product described below. Walk the brand's ` +
    `navigation taxonomy (e.g. "Mens > Tops > Performance Shirts") rather than ` +
    `linking to a specific SKU.\n\n` +
    `Brand: ${brandName || brandUrl}\n` +
    (brandUrl ? `Brand site: ${brandUrl}\n` : '') +
    `Product label: ${label || '(unspecified)'}\n` +
    `Product category: ${category || '(unspecified)'}\n\n` +
    `Respond as:\n` +
    `BREADCRUMB: <Top > Sub > Specific>\n` +
    `URL: <full URL on the brand's domain>\n` +
    `CONFIDENCE: <0-100, how certain you are this is the best matching collection page>\n` +
    `Then one sentence explaining how you decided.`;

  let res;
  try {
    res = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 600 }
      },
      { timeout: 30000 }
    );
  } catch (err) {
    console.warn(`   ⚠️  brand-category lookup failed: ${err.message}`);
    return null;
  }

  const candidate = res.data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(p => p.text || '').join(' ').trim();

  const breadcrumbMatch = text.match(/BREADCRUMB:\s*([^\n]+)/i);
  const urlMatch        = text.match(/URL:\s*(https?:\/\/[^\s]+)/i);
  const confMatch       = text.match(/CONFIDENCE:\s*(\d+)/i);

  if (!urlMatch && !breadcrumbMatch) {
    console.warn(`   · brand-category lookup: no parsable result for ${brandName || brandUrl}`);
    return null;
  }

  const result = {
    breadcrumb: breadcrumbMatch?.[1]?.trim() || null,
    url:        urlMatch?.[1]?.trim() || null,
    confidence: confMatch ? Math.max(0, Math.min(1, Number(confMatch[1]) / 100)) : 0.5,
    reasoning:  text,
    source:     PROVIDER_NAME
  };
  console.log(`   ✓ brand-category: ${result.breadcrumb || '(no breadcrumb)'} → ${result.url || '(no url)'} (${(result.confidence * 100).toFixed(0)}%, ${Date.now() - t0}ms)`);
  return result;
}

// Brand-level reviews lookup. Used in the "branding" outcome where no
// specific product was identifiable — surfaces overall brand sentiment
// quotes that downstream templates can use in place of product reviews.
// Returns { quotes: [{ text, author?, source? }], rating?, reviewCount?, reasoning }.
async function lookupBrandReviews({ brandName, brandUrl }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');
  if (!brandName) return null;

  const t0 = Date.now();
  const prompt =
    `Use Google Search to find what real customers say about the BRAND ${brandName}` +
    (brandUrl ? ` (${brandUrl})` : '') +
    `. We're not looking for a specific product — we want the brand's overall ` +
    `reputation: what people consistently praise, common quotes from review aggregators ` +
    `(Trustpilot, Sitejabber, Better Business Bureau, Reddit, brand site testimonials).\n\n` +
    `Respond as JSON only (no preamble):\n` +
    `{\n` +
    `  "quotes":     [ { "text": "...", "author": "name or handle if known", "source": "domain or platform" }, ... 3 to 6 ],\n` +
    `  "rating":     <average star rating across sources, 0-5, or null>,\n` +
    `  "reviewCount":<approximate total review count seen, or null>,\n` +
    `  "summary":    "one sentence on overall brand sentiment"\n` +
    `}`;

  let res;
  try {
    res = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1200 }
      },
      { timeout: 30000 }
    );
  } catch (err) {
    console.warn(`   ⚠️  brand-reviews lookup failed: ${err.message}`);
    return null;
  }

  const candidate = res.data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(p => p.text || '').join(' ').trim();

  // Find the JSON object in the response (Gemini sometimes wraps it in
  // markdown despite the prompt).
  let parsed = null;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch (_) { /* fall through */ }
  }
  if (!parsed) {
    console.warn(`   · brand-reviews: no parsable JSON for ${brandName}`);
    return { quotes: [], rating: null, reviewCount: null, summary: text.slice(0, 200), source: PROVIDER_NAME };
  }

  const result = {
    quotes:      Array.isArray(parsed.quotes) ? parsed.quotes.slice(0, 6).filter(q => q && q.text) : [],
    rating:      typeof parsed.rating === 'number' ? parsed.rating : null,
    reviewCount: typeof parsed.reviewCount === 'number' ? parsed.reviewCount : null,
    summary:     parsed.summary || null,
    source:      PROVIDER_NAME
  };
  console.log(`   ✓ brand-reviews: ${result.quotes.length} quote(s)${result.rating != null ? ` · ${result.rating.toFixed(1)}★` : ''}${result.reviewCount != null ? ` · ${result.reviewCount.toLocaleString()} reviews` : ''} (${Date.now() - t0}ms)`);
  return result;
}

module.exports = {
  match,
  isEnabled,
  PROVIDER_NAME,
  lookupBrandCategoryUrl,
  lookupBrandReviews
};
