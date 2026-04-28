// Product → brand-collection enrichment via OpenAI GPT-4.1.
//
// Every identified product (and every category-fallback outcome) gets
// run through this so the canonical input always carries a brand
// collection / category page URL — useful as the CTA destination when
// a SKU 404s, and useful for downstream "shop the look" navigation.
//
// Today this is a pure GPT-4.1 prediction based on what the model knows
// about the brand's site. It's a placeholder until product-feed
// integration lands; the API surface is designed so the eventual feed-
// based lookup can be a drop-in replacement.

const OpenAI = require('openai');
const JSON5  = require('json5');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function isEnabled() { return !!process.env.OPENAI_API_KEY; }

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    breadcrumb:  { type: 'string', description: 'Top > Sub > Specific' },
    url:         { type: 'string', description: 'Full URL on the brand site, e.g. https://pelagicgear.com/collections/mens-performance-shirts' },
    confidence:  { type: 'number', description: '0.0 to 1.0' },
    reasoning:   { type: 'string', description: 'one sentence on how you decided' }
  },
  required: ['breadcrumb', 'confidence']
};

// Resolve a product to the brand's most likely collection page.
//
// Inputs:
//   brandName   — string, e.g. "Pelagic"
//   brandUrl    — string, e.g. "https://pelagicgear.com"
//   productLabel — what we know about the product (e.g. "men's long-sleeve performance shirt")
//   productCategory — coarse category from YOLO+GPT (e.g. "apparel")
//   productDescription — optional one-line description
//
// Returns { breadcrumb, url, confidence, reasoning } or null on failure.
async function enrichProductCategory({ brandName, brandUrl, productLabel, productCategory, productDescription }) {
  if (!isEnabled()) return null;
  if (!productLabel && !productDescription) return null;

  const t0 = Date.now();
  const prompt =
    `Given the brand "${brandName || 'unknown'}" (${brandUrl || 'no URL'}), predict the most likely category / collection page on the brand's website that this product belongs to.\n\n` +
    `Walk the brand's likely navigation taxonomy (e.g. "Mens > Tops > Performance Shirts") rather than guessing a specific SKU URL. Return a URL pattern that would be a reasonable collection page on the brand's domain.\n\n` +
    `Product:\n` +
    `  Label: ${productLabel || '(none)'}\n` +
    (productDescription ? `  Description: ${productDescription}\n` : '') +
    `  Category hint: ${productCategory || '(none)'}\n\n` +
    `Respond in JSON only:\n` +
    `{\n` +
    `  "breadcrumb":  "Top > Sub > Specific",\n` +
    `  "url":         "https://<brand-domain>/collections/<slug>" or similar,\n` +
    `  "confidence":  0.0-1.0,\n` +
    `  "reasoning":   "one sentence"\n` +
    `}`;

  let res;
  try {
    res = await openai.chat.completions.create({
      model: 'gpt-4.1',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.2
    });
  } catch (err) {
    console.warn(`   ⚠️  product-category enrichment failed: ${err.message}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON5.parse(res.choices[0].message.content);
  } catch (err) {
    console.warn(`   ⚠️  product-category JSON parse failed: ${err.message}`);
    return null;
  }

  const result = {
    breadcrumb: typeof parsed.breadcrumb === 'string' ? parsed.breadcrumb.trim() : null,
    url:        typeof parsed.url === 'string' && /^https?:\/\//.test(parsed.url) ? parsed.url.trim() : null,
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    reasoning:  typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
    source:     'openai-gpt-4.1'
  };
  console.log(`   ✓ product-category: "${productLabel || '?'}" → ${result.breadcrumb || '(no breadcrumb)'} (${(result.confidence * 100).toFixed(0)}%, ${Date.now() - t0}ms)`);
  return result;
}

module.exports = { enrichProductCategory, isEnabled };
