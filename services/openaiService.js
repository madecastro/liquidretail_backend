const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function processImage(imageUrl) {
  const prompt = `
You are an expert product analyst. Analyze the image and return a JSON object with the following:

- product_name (short noun phrase)
- product_title (short marketing title)
- category (broad > subcategory format)
- description (one short sentence)
- condition (new, lightly used, used, unserviceable)
- confidence (float 0–1 on how certain you are about the product match)
- price_estimate (in USD)
- marketing_images (array of 2 relevant URLs, optional or placeholders)

Only return a JSON object. Do not include commentary.
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4-vision-preview',
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

  const jsonMatch = response.choices[0]?.message?.content?.match(/{[\s\S]+}/);
  const result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

  if (!result) throw new Error('Unable to parse product result from OpenAI');

  return result;
}

module.exports = { processImage };
