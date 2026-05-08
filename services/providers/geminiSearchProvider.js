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

async function match({ brand, category, caption, primarySubject, textDetected = [], cropImageUrl = null }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');

  const queryParts = [];
  if (brand)          queryParts.push(`Brand: ${brand}`);
  if (category)       queryParts.push(`Category: ${category}`);
  if (primarySubject) queryParts.push(`Product description: ${primarySubject}`);
  if (caption)        queryParts.push(`Caption: "${caption}"`);
  if (textDetected.length) queryParts.push(`Text visible on product: ${textDetected.map(t => `"${t}"`).join(', ')}`);

  // Phase 1.8 — multimodal grounded search. When the caller provides a tight
  // per-product crop URL (Phase 1.6 refinement output), download it + send as
  // inlineData so Gemini's grounded search sees the product visually instead
  // of relying solely on the scene-level primarySubject text. The image
  // grounds the query in actual visual evidence — eliminates the scene-leakage
  // failure mode where Gemini picks a similar-looking product because the
  // text seed described the broader scene.
  let imagePart = null;
  if (cropImageUrl) {
    try {
      const imgRes = await axios.get(cropImageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const buf = Buffer.from(imgRes.data);
      imagePart = { inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } };
    } catch (err) {
      console.warn(`   ⚠️  ${PROVIDER_NAME}: cropImageUrl download failed (${err.message}); falling back to text-only`);
    }
  }

  const prompt = imagePart
    ? `Use Google Search to find where the SPECIFIC product shown in the attached image is sold ` +
      `online — focus on the central product visible in the image, not surrounding context. ` +
      `Prefer the brand's own site and major retailers. Return a concise one-paragraph summary ` +
      `explaining which product you identified and which retailers carry it. Cite every retailer ` +
      `with a link.\n\n` +
      `Product details (use as a sanity check on what's visible):\n${queryParts.join('\n')}`
    : `Use Google Search to find where this product is sold online. Prefer the brand's own site ` +
      `and major retailers. Return a concise one-paragraph summary explaining which product you ` +
      `identified and which retailers carry it. Cite every retailer with a link so I can browse them.\n\n` +
      `Product details:\n${queryParts.join('\n')}`;

  const parts = [{ text: prompt }];
  if (imagePart) parts.push(imagePart);

  const t0 = Date.now();
  const res = await axios.post(
    `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      contents: [{ role: 'user', parts }],
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
// Two-pass: grounded-search Gemini returns prose (it ignores JSON
// formatting requests when the google_search tool is enabled), so we
// run a second plain call with responseMimeType: application/json to
// structure the narrative into typed fields.
async function lookupBrandReviews({ brandName, brandUrl }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');
  if (!brandName) return null;

  const t0 = Date.now();

  // ── Pass 1: grounded narrative ──
  const searchPrompt =
    `Use Google Search to find what real customers say about the BRAND ${brandName}` +
    (brandUrl ? ` (${brandUrl})` : '') +
    `. Surface 4-6 SPECIFIC, DIRECT customer quotes (verbatim, in quotation marks) from review ` +
    `aggregators (Trustpilot, Sitejabber, BBB), Reddit threads, and brand-site testimonials. ` +
    `For each quote, name the source platform and the author/handle if visible. Also note the ` +
    `overall average star rating (0-5) and approximate total review count if you can see them, ` +
    `plus a one-sentence summary of the brand's reputation. Write naturally — do not format as JSON.`;

  let searchRes;
  try {
    searchRes = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1500 }
      },
      { timeout: 30000 }
    );
  } catch (err) {
    console.warn(`   ⚠️  brand-reviews search failed: ${err.message}`);
    return null;
  }

  const searchCand = searchRes.data?.candidates?.[0];
  const narrative = (searchCand?.content?.parts || []).map(p => p.text || '').join(' ').trim();
  const sourceDomains = (searchCand?.groundingMetadata?.groundingChunks || [])
    .map(c => c.web?.uri && extractDomain(c.web.uri))
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i)
    .slice(0, 10);

  if (!narrative || narrative.length < 100) {
    console.warn(`   · brand-reviews: search returned no narrative for ${brandName}`);
    return { quotes: [], rating: null, reviewCount: null, summary: null, source: PROVIDER_NAME };
  }

  // ── Pass 2: structure as JSON ──
  // Plain Gemini call (no tools) with JSON mime — reliably honors
  // formatting when there's no google_search tool muddying things.
  const structurePrompt =
    `Convert the following brand-review narrative into structured JSON.\n\n` +
    `Brand: ${brandName}\n` +
    (sourceDomains.length ? `Sources cited: ${sourceDomains.join(', ')}\n` : '') +
    `\nNarrative:\n"""\n${narrative}\n"""\n\n` +
    `Return EXACTLY this shape (no commentary, no markdown):\n` +
    `{\n` +
    `  "quotes":      [ { "text": "...", "author": "name or null", "source": "domain or platform or null" }, 3-6 entries ],\n` +
    `  "rating":      <number 0-5 or null>,\n` +
    `  "reviewCount": <integer or null>,\n` +
    `  "summary":     "one sentence on overall brand sentiment"\n` +
    `}\n` +
    `Use direct quotes verbatim from the narrative; do NOT paraphrase or invent quotes that aren't present.`;

  let structRes;
  try {
    structRes = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: structurePrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1200,
          responseMimeType: 'application/json',
          // Same schema as product-reviews below — Gemini's freeform
          // JSON output is unreliable enough that the parser fallback
          // was firing often. Constrains the response shape.
          responseSchema: {
            type: 'object',
            properties: {
              quotes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text:   { type: 'string' },
                    author: { type: 'string', nullable: true },
                    source: { type: 'string', nullable: true }
                  },
                  required: ['text']
                }
              },
              rating:      { type: 'number',  nullable: true },
              reviewCount: { type: 'integer', nullable: true },
              summary:     { type: 'string',  nullable: true }
            },
            required: ['quotes']
          }
        }
      },
      { timeout: 30000 }
    );
  } catch (err) {
    console.warn(`   ⚠️  brand-reviews structuring failed: ${err.message}`);
    return { quotes: [], rating: null, reviewCount: null, summary: narrative.slice(0, 200), source: PROVIDER_NAME };
  }

  const structCand = structRes.data?.candidates?.[0];
  const jsonText = (structCand?.content?.parts || []).map(p => p.text || '').join('').trim();

  let parsed = null;
  try { parsed = JSON.parse(jsonText); } catch (_) {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed) {
    console.warn(`   · brand-reviews: structuring produced no parsable JSON for ${brandName}`);
    return { quotes: [], rating: null, reviewCount: null, summary: narrative.slice(0, 200), source: PROVIDER_NAME };
  }

  const result = {
    quotes:      Array.isArray(parsed.quotes) ? parsed.quotes.slice(0, 6).filter(q => q && q.text) : [],
    rating:      typeof parsed.rating === 'number' ? parsed.rating : null,
    reviewCount: typeof parsed.reviewCount === 'number' ? parsed.reviewCount : null,
    summary:     parsed.summary || null,
    source:      PROVIDER_NAME
  };
  console.log(`   ✓ brand-reviews: ${result.quotes.length} quote(s)${result.rating != null ? ` · ${result.rating.toFixed(1)}★` : ''}${result.reviewCount != null ? ` · ${result.reviewCount.toLocaleString()} reviews` : ''} (${Date.now() - t0}ms, two-pass)`);
  return result;
}

// Product-level reviews lookup. Same two-pass approach as
// lookupBrandReviews — pass 1 grounded search returns prose, pass 2
// plain Gemini call structures it as JSON. Shape mirrors
// lookupBrandReviews so caller code can use identical render logic.
async function lookupProductReviews({ productName, brandName, productUrl }) {
  if (!isEnabled()) throw new Error('GEMINI_API_KEY not set');
  if (!productName) return null;

  const t0 = Date.now();
  const productLabel = brandName ? `${brandName}'s "${productName}"` : `"${productName}"`;

  // ── Pass 1: grounded narrative ──
  const searchPrompt =
    `Use Google Search to find what real customers say about the PRODUCT ${productLabel}` +
    (productUrl ? ` (${productUrl})` : '') +
    `. Surface 4-6 SPECIFIC, DIRECT customer quotes (verbatim, in quotation marks) — what reviewers ` +
    `consistently call out about this exact product. Pull from retailer review sections, Reddit ` +
    `discussions, YouTube review videos, and dedicated review sites. For each quote, name the ` +
    `source platform and the author/handle if visible. Also note the average star rating (0-5) ` +
    `and approximate review count if visible, plus a one-sentence summary of how reviewers feel ` +
    `about this specific product. Write naturally — do not format as JSON.`;

  let searchRes;
  try {
    searchRes = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1500 }
      },
      { timeout: 30000 }
    );
  } catch (err) {
    console.warn(`   ⚠️  product-reviews search failed: ${err.message}`);
    return null;
  }

  const searchCand = searchRes.data?.candidates?.[0];
  const narrative = (searchCand?.content?.parts || []).map(p => p.text || '').join(' ').trim();
  const sourceDomains = (searchCand?.groundingMetadata?.groundingChunks || [])
    .map(c => c.web?.uri && extractDomain(c.web.uri))
    .filter(Boolean)
    .filter((d, i, a) => a.indexOf(d) === i)
    .slice(0, 10);

  if (!narrative || narrative.length < 100) {
    console.warn(`   · product-reviews: search returned no narrative for ${productLabel}`);
    return { quotes: [], rating: null, reviewCount: null, summary: null, source: PROVIDER_NAME };
  }

  // ── Pass 2: structure as JSON ──
  const structurePrompt =
    `Convert the following product-review narrative into structured JSON.\n\n` +
    `Product: ${productName}${brandName ? ` (brand: ${brandName})` : ''}\n` +
    (sourceDomains.length ? `Sources cited: ${sourceDomains.join(', ')}\n` : '') +
    `\nNarrative:\n"""\n${narrative}\n"""\n\n` +
    `Return EXACTLY this shape (no commentary, no markdown):\n` +
    `{\n` +
    `  "quotes":      [ { "text": "...", "author": "name or null", "source": "domain or platform or null" }, 3-6 entries ],\n` +
    `  "rating":      <number 0-5 or null>,\n` +
    `  "reviewCount": <integer or null>,\n` +
    `  "summary":     "one sentence on overall product sentiment"\n` +
    `}\n` +
    `Use direct quotes verbatim from the narrative; do NOT paraphrase or invent quotes that aren't present.`;

  let structRes;
  try {
    structRes = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{ role: 'user', parts: [{ text: structurePrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1200,
          responseMimeType: 'application/json',
          // Schema-enforced output to eliminate "structuring produced
          // no parsable JSON" warnings — Gemini was returning markdown-
          // wrapped JSON, prose with embedded JSON, or fields with
          // wrong types. responseSchema constrains output to exactly
          // our shape; the parser below becomes a safety net.
          responseSchema: {
            type: 'object',
            properties: {
              quotes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text:   { type: 'string' },
                    author: { type: 'string', nullable: true },
                    source: { type: 'string', nullable: true }
                  },
                  required: ['text']
                }
              },
              rating:      { type: 'number',  nullable: true },
              reviewCount: { type: 'integer', nullable: true },
              summary:     { type: 'string',  nullable: true }
            },
            required: ['quotes']
          }
        }
      },
      { timeout: 30000 }
    );
  } catch (err) {
    console.warn(`   ⚠️  product-reviews structuring failed: ${err.message}`);
    return { quotes: [], rating: null, reviewCount: null, summary: narrative.slice(0, 200), source: PROVIDER_NAME };
  }

  const structCand = structRes.data?.candidates?.[0];
  const jsonText = (structCand?.content?.parts || []).map(p => p.text || '').join('').trim();

  let parsed = null;
  try { parsed = JSON.parse(jsonText); } catch (_) {
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed) {
    console.warn(`   · product-reviews: structuring produced no parsable JSON for ${productLabel}`);
    return { quotes: [], rating: null, reviewCount: null, summary: narrative.slice(0, 200), source: PROVIDER_NAME };
  }

  const result = {
    quotes:      Array.isArray(parsed.quotes) ? parsed.quotes.slice(0, 6).filter(q => q && q.text) : [],
    rating:      typeof parsed.rating === 'number' ? parsed.rating : null,
    reviewCount: typeof parsed.reviewCount === 'number' ? parsed.reviewCount : null,
    summary:     parsed.summary || null,
    source:      PROVIDER_NAME
  };
  console.log(`   ✓ product-reviews: ${result.quotes.length} quote(s)${result.rating != null ? ` · ${result.rating.toFixed(1)}★` : ''}${result.reviewCount != null ? ` · ${result.reviewCount.toLocaleString()} reviews` : ''} (${Date.now() - t0}ms, two-pass)`);
  return result;
}

module.exports = {
  match,
  isEnabled,
  PROVIDER_NAME,
  lookupBrandCategoryUrl,
  lookupBrandReviews,
  lookupProductReviews
};
