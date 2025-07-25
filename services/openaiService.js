const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function processImage(imageUrl) {
  const prompt = `
You are an expert product analyst. Analyze the image and return a JSON object with the following fields:

- product_name
- product_title
- category
- description
- condition (new, lightly used, used, unserviceable)
- confidence (0.0–1.0)
- price_estimate (in USD)
- marketing_images (optional placeholder URLs)

Only return valid JSON — no commentary or explanation.
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 400,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant that returns structured JSON product data.'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ]
  });

  const jsonMatch = response.choices[0]?.message?.content?.match(/{[\\s\\S]+}/);
  const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

  if (!result) throw new Error('Failed to parse OpenAI response');
  return result;
}

module.exports = { processImage };
