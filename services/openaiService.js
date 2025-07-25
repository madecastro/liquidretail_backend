const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function processImage(imageUrl) {
  try {
    // Step 1: Vision analysis with GPT-4o
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

    // Extract JSON block from message
    const jsonStart = message.indexOf('{');
    const jsonEnd = message.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('No JSON found in OpenAI response');
    }

    const jsonText = message.slice(jsonStart, jsonEnd + 1);
    const productData = JSON.parse(jsonText);

    // Step 2: Generate marketing images with DALL·E
    const dalleRes = await openai.images.generate({
      model: 'dall-e-3',
      prompt: `Professional e-commerce marketing photo of a ${productData.product_title || productData.product_name}`,
      n: 2,
      size: '1024x1024'
    });

    productData.marketing_images = dalleRes.data.map(img => img.url);

    return productData;
  } catch (err) {
    console.error('🛑 OpenAI error:', err);
    throw new Error('Failed to parse OpenAI response');
  }
}

module.exports = { processImage };
