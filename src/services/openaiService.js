// Chat goes through the Atlas gateway; the OpenAI client below remains
// ONLY for images.generate/edit until atlasImageService lands (M3).
const { chatCompletion } = require('./atlasLlmService');
const JSON5 = require('json5');

// Identify a product from a cropped image via GPT-4.1 vision. DALL-E marketing
// image generation is a *best-effort* follow-up — if it fails (rate limit,
// content policy, org verification delay), we still return the identification
// so the product can be saved.
async function processImage(imageUrl) {
  let productData;

  // ── 1. Identification (required) ──
  try {
    const response = await chatCompletion({ stage: 'inventory_identify', service: 'openaiService' }, {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: `You are a product recognition assistant. Given an image URL, return structured JSON describing the product including:
- product_name
- product_title
- category
- description
- condition (used, lightly used, unserviceable, new)
- confidence (0 to 1)
- price_estimate

Return ONLY the JSON object. No markdown fences, no prose before or after.`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this product image and return JSON:' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ],
      max_tokens: 1000,
      temperature: 0.4
    });

    const message = response.choices[0].message.content;

    // Greedy match so nested JSON (e.g. attributes, dimensions) is captured in full.
    const match = message.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON block found in GPT response');
    productData = JSON5.parse(match[0]);

    // Normalize types
    if (typeof productData.price_estimate === 'string') {
      const n = productData.price_estimate.match(/\d+/);
      productData.price_estimate = n ? parseInt(n[0], 10) : 0;
    }
    productData.confidence   = Math.min(1, Math.max(0, parseFloat(productData.confidence) || 0.5));
    productData.product_name = productData.product_name || 'Unknown Product';
    productData.product_title = productData.product_title || productData.product_name;
  } catch (err) {
    console.error('🛑 OpenAI identify failed:', err.status || '', err.code || '', err.message || err);
    throw new Error(`Product identification failed: ${err.message || err}`);
  }

  // ── 2. DALL-E marketing image (best-effort, failures don't abort) ──
  productData.marketing_images = [];
  try {
    // Atlas gateway (direct dall-e-3 fallback inside). b64 result is kept
    // as a data URL — legacy consumers treated these URLs as opaque.
    const atlasImage = require('./atlasImageService');
    const dalleRes = await atlasImage.generateImage({
      prompt: `Professional e-commerce marketing photo of a ${productData.product_title}`,
      size: '1024x1024',
      fallbackModel: 'dall-e-3',
      meta: { stage: 'inventory_marketing_image', service: 'openaiService' }
    });
    productData.marketing_images = dalleRes.url ? [dalleRes.url] : dalleRes.data.map(img => `data:image/png;base64,${img.b64_json}`);
  } catch (err) {
    console.warn(`⚠️  DALL-E marketing image failed (${err.status || ''} ${err.code || ''}): ${err.message || err} — saving product without marketing image`);
  }

  return productData;
}

module.exports = { processImage };
