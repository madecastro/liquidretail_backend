const JSON5 = require('json5');
const { chatCompletion } = require('./atlasLlmService');

// Extract named entities (products, brands, model numbers, etc.) from a
// Whisper transcript, tagged with the time range they appear in.
async function extractEntities(transcript) {
  if (!transcript || !transcript.segments?.length) return [];

  const segmentLines = transcript.segments
    .map(s => `[${s.start.toFixed(1)}s–${s.end.toFixed(1)}s] ${s.text}`)
    .join('\n');

  // Atlas gateway (direct-OpenAI fallback inside); model id mapped by
  // atlasModelMap. This call was previously untracked — now ledgered.
  const response = await chatCompletion({ stage: 'ner_extraction', service: 'nerService' }, {
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: `You extract named entities from a time-stamped transcript of a warehouse/truck inventory walkthrough.

For each product, brand, model number, part number, tool, vehicle, or quantity mentioned, return an object:
  { "text": "...", "type": "product"|"brand"|"model"|"part_number"|"quantity"|"location"|"other", "startSec": 0.0, "endSec": 0.0 }

Rules:
- startSec/endSec must come from the bracketed timestamps in the segment where the entity is said.
- If an entity is mentioned multiple times, emit it each time with its correct timestamps.
- Skip filler words, greetings, and irrelevant speech.

Return ONLY a JSON object: { "entities": [...] }. No markdown.`
      },
      { role: 'user', content: segmentLines }
    ],
    max_tokens: 2000,
    temperature: 0.2
  });

  const raw = response.choices[0].message.content.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];

  try {
    const parsed = JSON5.parse(match[0]);
    return (parsed.entities || []).map((e, i) => ({
      id: `e${i + 1}`,
      text: e.text || '',
      type: e.type || 'other',
      startSec: parseFloat(e.startSec) || 0,
      endSec: parseFloat(e.endSec) || 0
    }));
  } catch (err) {
    console.warn('NER parse failed:', err.message);
    return [];
  }
}

module.exports = { extractEntities };
