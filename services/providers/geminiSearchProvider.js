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

module.exports = { match, isEnabled, PROVIDER_NAME };
