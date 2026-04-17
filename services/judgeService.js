const OpenAI = require('openai');
const JSON5 = require('json5');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function judgeDetections({ imageUrl, products, subjects, text, crops }) {
  const payload = {
    products: products.map(p => ({ id: p.id, className: p.className, confidence: p.confidence, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 })),
    subjects,
    text,
    crops
  };

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: `You are an expert visual content judge for an e-commerce inventory platform. Given an image and detection data, return a JSON object with these keys:

"products": { "winnerIds": ["p1",...], "reasoning": "..." }
  Pick the product detections most likely to be real sellable inventory items.

"subjects": { "primaryId": "s1"|null, "reasoning": "..." }
  Which subject is the main product to sell?

"text": { "treatment": "include"|"exclude"|"subject", "affectedIds": ["t1",...], "reasoning": "..." }
  Should detected text be overlaid, hidden, or treated as the subject (e.g. a labeled box)?

"crop_5_4": { "winnerId": "5:4-1"|"5:4-2"|"5:4-3", "reasoning": "..." }
"crop_1_1": { "winnerId": "1:1-1"|"1:1-2"|"1:1-3", "reasoning": "..." }
"crop_4_5": { "winnerId": "4:5-1"|"4:5-2"|"4:5-3", "reasoning": "..." }
  Which crop best frames the main subject for e-commerce use?

Return ONLY valid JSON. No markdown, no explanation outside the JSON.`
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Detection data:\n${JSON.stringify(payload, null, 2)}\n\nJudge this image for e-commerce use:`
          },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ],
    max_tokens: 1500,
    temperature: 0.3
  });

  const raw = response.choices[0].message.content.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('GPT judge returned no JSON');

  const result = JSON5.parse(match[0]);

  return {
    products:  result.products  || { winnerIds: [], reasoning: '' },
    subjects:  result.subjects  || { primaryId: null, reasoning: '' },
    text:      result.text      || { treatment: 'include', affectedIds: [], reasoning: '' },
    crop_5_4:  result.crop_5_4  || { winnerId: '5:4-1', reasoning: '' },
    crop_1_1:  result.crop_1_1  || { winnerId: '1:1-1', reasoning: '' },
    crop_4_5:  result.crop_4_5  || { winnerId: '4:5-1', reasoning: '' }
  };
}

module.exports = { judgeDetections };
