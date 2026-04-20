const OpenAI = require('openai');
const JSON5 = require('json5');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function judgeDetections({ imageUrl, products, subjects, text, crops, safeRect }) {
  const payload = {
    products: products.map(p => ({ id: p.id, className: p.className, confidence: p.confidence, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 })),
    subjects,
    text,
    crops,
    ...(safeRect ? { safeRect } : {})
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
  If "safeRect" is present, it is the union bounding box of the subject across
  all sampled video frames — prefer crops that fully contain it so the subject
  stays in frame throughout the clip.

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

// Judge extended-ratio crops (9:16 and 1.91:1). Each candidate is a fully-
// rendered image URL produced by a different provider/strategy. We pass the
// URLs directly to GPT-4.1 as image inputs and ask for one winner per ratio.
async function judgeExtendedCrops(extendedCrops) {
  const ratios = Object.keys(extendedCrops).filter(r => extendedCrops[r].length > 0);
  if (ratios.length === 0) return {};

  // Build multi-image content
  const imageParts = [];
  const indexLines = [];
  for (const ratio of ratios) {
    for (const c of extendedCrops[ratio]) {
      indexLines.push(`[${ratio}] ${c.id} — ${c.label} (${c.provider}, ${c.variant})`);
      imageParts.push({ type: 'image_url', image_url: { url: c.imageUrl } });
    }
  }

  const prompt =
    `Below are candidate outputs for additional aspect ratios. Each candidate is identified by an id of the form ` +
    `"<ratio>-<variant>-<provider>" (plus "<ratio>-blurred" for Cloudinary blurred-pad variants).\n\n` +
    `Candidates:\n${indexLines.join('\n')}\n\n` +
    `Evaluate each ratio group independently. For each ratio, pick the single best candidate for e-commerce ` +
    `marketing use — consider subject fidelity (identity/shape preserved), background quality, overall ` +
    `composition, and absence of artifacts. Return ONLY JSON in this shape:\n` +
    `{ "${ratios.join('": { "winnerId": "...", "reasoning": "..." }, "')}": { "winnerId": "...", "reasoning": "..." } }`;

  const OpenAI = require('openai');
  const localOpenai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await localOpenai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, ...imageParts]
    }],
    max_tokens: 1000,
    temperature: 0.3
  });

  const raw = response.choices[0].message.content.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Extended-crops judge returned no JSON');

  const parsed = JSON5.parse(match[0]);
  const out = {};
  for (const ratio of ratios) {
    out[ratio] = parsed[ratio] || { winnerId: extendedCrops[ratio][0].id, reasoning: '' };
  }
  return out;
}

module.exports = { judgeDetections, judgeExtendedCrops };
