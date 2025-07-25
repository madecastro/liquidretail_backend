const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function processImage(imageUrl) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a product recognition assistant. Given an image URL, return JSON describing the products in the photo, including:
- product_name
- product_title
- category
- description
- condition (used, lightly used, unserviceable, new)
- confidence (0-1)
- price_estimate
- marketing_images (array of URLs)`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Please analyze this product image and return the JSON:' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ],
      max_tokens: 1000,
      temperature: 0.4
    });

    const message = response.choices[0].message.content;

    // Find the first JSON block in the text
    const jsonStart = message.indexOf('{');
    const jsonEnd = message.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('No JSON found in OpenAI response');
    }

    const jsonText = message.slice(jsonStart, jsonEnd + 1);
    return JSON.parse(jsonText);
  } catch (err) {
    console.error('🛑 OpenAI Vision error:', err);
    throw new Error('Failed to parse OpenAI response');
  }
}

module.exports = { processImage };
