// Gemini grounded search — text-based product discovery via Google Search tool.
// Given brand/category/subject-description, Gemini formulates a query, hits Google,
// and returns retailer URLs + snippets grounded in real web results.

const axios = require('axios');

const MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const PROVIDER_NAME = 'gemini-search';

function isEnabled() { return !!process.env.GEMINI_API_KEY; }

async function match({ brand, category, caption, primarySubject, textDetected = [] }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');

  const queryParts = [];
  if (brand)          queryParts.push(`brand: ${brand}`);
  if (category)       queryParts.push(`category: ${category}`);
  if (primarySubject) queryParts.push(`product description: ${primarySubject}`);
  if (caption)        queryParts.push(`caption: "${caption}"`);
  if (textDetected.length) queryParts.push(`text visible on product: ${textDetected.map(t => `"${t}"`).join(', ')}`);

  const prompt =
    `You are a product-matching assistant. Using Google Search, find where the following product is sold online. ` +
    `Return up to 8 distinct matches, preferring major retailers and the brand's own site.\n\n` +
    `Product details:\n${queryParts.join('\n')}\n\n` +
    `Return ONLY valid JSON (no markdown, no prose) in this exact shape:\n` +
    `{\n` +
    `  "reasoning": "one-sentence explanation of how you interpreted the query",\n` +
    `  "query_used": "the actual search query text you issued to Google",\n` +
    `  "matches": [\n` +
    `    { "title": "...", "url": "...", "retailer": "domain.com", "price": "optional string like '$49.00'", "snippet": "brief description" }\n` +
    `  ]\n` +
    `}`;

  const t0 = Date.now();
  const res = await axios.post(
    `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2000 }
    },
    { timeout: 30000 }
  );

  const candidates = res.data?.candidates || [];
  const parts = candidates[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('\n');
  const groundingMeta = candidates[0]?.groundingMetadata || null;

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini search returned no JSON');
  const parsed = JSON.parse(jsonMatch[0]);

  const matches = (parsed.matches || []).map(m => ({
    title: m.title || '',
    url: m.url || '',
    retailer: m.retailer || extractDomain(m.url),
    priceHint: m.price || null,
    snippet: m.snippet || '',
    thumbnail: null,
    source: PROVIDER_NAME
  })).filter(m => m.url);

  console.log(`   ✓ ${PROVIDER_NAME}: ${matches.length} match(es) in ${Date.now() - t0}ms`);

  return {
    provider: PROVIDER_NAME,
    reasoning: parsed.reasoning || '',
    queryUsed: parsed.query_used || queryParts.join(' | '),
    matches,
    groundingUrls: (groundingMeta?.groundingChunks || [])
      .map(c => c.web?.uri).filter(Boolean).slice(0, 10)
  };
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

module.exports = { match, isEnabled, PROVIDER_NAME };
