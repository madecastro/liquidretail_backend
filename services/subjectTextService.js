const OpenAI = require('openai');
const JSON5 = require('json5');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Single GPT-4.1 call: returns both subjects and text regions with normalized coords
async function detectSubjectsAndText(imageUrl) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: `You are a computer vision assistant. Analyze the image and return a JSON object with two keys:

"subjects": array of visual subjects/objects you see. Each item:
  { "id": "s1", "role": "primary"|"secondary"|"background", "description": "...", "x1": 0.0, "y1": 0.0, "x2": 1.0, "y2": 1.0 }
  Coordinates are normalized 0-1 (x=left→right, y=top→bottom).

"text": array of readable text regions. Each item:
  { "id": "t1", "content": "exact text", "type": "product_label"|"brand"|"serial"|"warning"|"general", "x1": 0.0, "y1": 0.0, "x2": 1.0, "y2": 1.0, "confidence": 0.0-1.0 }
  Coordinates are normalized 0-1.

Return ONLY valid JSON, no markdown, no explanation.`
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ],
    max_tokens: 2000,
    temperature: 0.2
  });

  const raw = response.choices[0].message.content.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('GPT returned no JSON for subject/text detection');

  const parsed = JSON5.parse(match[0]);

  const subjects = (parsed.subjects || []).map((s, i) => ({
    id: s.id || `s${i + 1}`,
    role: s.role || 'secondary',
    description: s.description || '',
    x1: clamp(s.x1), y1: clamp(s.y1), x2: clamp(s.x2), y2: clamp(s.y2)
  }));

  const text = (parsed.text || []).map((t, i) => ({
    id: t.id || `t${i + 1}`,
    content: t.content || '',
    type: t.type || 'general',
    x1: clamp(t.x1), y1: clamp(t.y1), x2: clamp(t.x2), y2: clamp(t.y2),
    confidence: Math.min(1, Math.max(0, parseFloat(t.confidence) || 0.8))
  }));

  return { subjects, text };
}

function clamp(v) {
  return Math.min(1, Math.max(0, parseFloat(v) || 0));
}

module.exports = { detectSubjectsAndText };
