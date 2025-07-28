const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function processImage(imageUrl) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
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
- price_estimate`
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

    // ✅ Robust JSON extraction
    const match = message.match(/\{[\s\S]*?\}/);
    if (!match) {
      throw new Error('No valid JSON block found in OpenAI response');
    }
    const productData = JSON.parse(match[0]);

    // 🧼 Ensure numeric price
    if (typeof productData.price_estimate === 'string') {
      const match = productData.price_estimate.match(/\d+/);
      productData.price_estimate = match ? parseInt(match[0], 10) : 0;
    }

    // 🧠 Normalize confidence
    productData.confidence = Math.min(1, Math.max(0, parseFloat(productData.confidence || 0.5)));

    // 🛡️ Default titles if missing
    productData.product_name = productData.product_name || 'Unknown Product';
    productData.product_title = productData.product_title || productData.product_name;

    // 🎨 Generate marketing images
    const dalleRes = await openai.images.generate({
      model: 'dall-e-3',
      prompt: `Professional e-commerce marketing photo of a ${productData.product_title}`,
      n: 1,
      size: '1024x1024'
    });

    productData.marketing_images = dalleRes.data.map(img => img.url);

    return productData;
  } catch (err) {
    console.error('🛑 OpenAI error:', err);
    throw new Error('Failed to process image with OpenAI');
  }
}

module.exports = { processImage };
