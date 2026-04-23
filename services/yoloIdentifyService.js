// YOLO identification — batched GPT-4.1 Vision call that takes the in-memory
// product crops from YOLO and attaches a short identification to each. Runs
// after YOLO (image or video) and before subject-text so downstream stages
// (subject-text, judge, matching) can see what's already been recognized.
//
// One batched call per job — 20-30 crops fit comfortably in a single Vision
// request. Each detection gets:
//   identification: {
//     label:       "short human-readable product name",
//     description: "short sentence describing the item for product search",
//     brand:       "brand if visible on the crop, else null",
//     category:    "apparel" | "electronics" | "food_beverage" | "home" | "toys" |
//                  "tools" | "beauty" | "sports" | "accessories" | "other",
//     confidence:  0.0-1.0
//   }
//
// Design goal — feed the downstream matching/layout stages a structured
// per-product anchor that's trustworthy for "how many products are in this
// media and are any of them useful as ad subjects." The YOLO class label
// alone is too coarse ("bottle" vs "Pelagic Gear 16oz stainless water bottle").

const OpenAI = require('openai');
const JSON5 = require('json5');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_DETECTIONS_PER_CALL = 24;

// Identify an array of YOLO detections in a single batched Vision call.
// Mutates `detections[i].identification` in place and also returns the list
// of identifications keyed by detection id for logging/debugging.
async function identifyYoloDetections(detections, hints = {}) {
  if (!Array.isArray(detections) || detections.length === 0) return [];

  // Process in chunks so we never exceed a sensible per-request image count.
  const all = [];
  for (let offset = 0; offset < detections.length; offset += MAX_DETECTIONS_PER_CALL) {
    const chunk = detections.slice(offset, offset + MAX_DETECTIONS_PER_CALL);
    const batchResults = await identifyChunk(chunk, hints, offset);
    all.push(...batchResults);
  }
  return all;
}

async function identifyChunk(chunk, hints, offset) {
  const { brand, category } = hints;
  const hintLines = [];
  if (brand)    hintLines.push(`- User states the BRAND visible is: ${brand}`);
  if (category) hintLines.push(`- User states the overall CATEGORY is: ${category}`);
  const hintBlock = hintLines.length ? `\n\nUser-provided context:\n${hintLines.join('\n')}` : '';

  // Build the image list. Each detection's cropBuffer is a PNG/JPEG buffer;
  // encode inline so we don't need a round-trip to Cloudinary for transient
  // recognition work. Label each image by its positional index so the model
  // can reference it without ambiguity.
  const imageParts = [];
  const indexLines = [];
  chunk.forEach((det, i) => {
    if (!det.cropBuffer) return;
    const dataUrl = `data:image/jpeg;base64,${det.cropBuffer.toString('base64')}`;
    imageParts.push({ type: 'image_url', image_url: { url: dataUrl } });
    indexLines.push(`#${i + 1} — YOLO class "${det.className || 'unknown'}" (conf=${(det.confidence ?? 0).toFixed(2)})`);
  });

  if (imageParts.length === 0) return [];

  const prompt =
    `You will see ${imageParts.length} product crops from a piece of social-media content. For each, identify the specific product.\n\n` +
    `Images (in order):\n${indexLines.join('\n')}${hintBlock}\n\n` +
    `Return JSON:\n` +
    `{ "items": [ { "index": 1, "label": "...", "description": "...", "brand": "..." | null, "category": "apparel|electronics|food_beverage|home|toys|tools|beauty|sports|accessories|other", "confidence": 0.0-1.0 }, ... ] }\n\n` +
    `Guidance:\n` +
    `- "label" is short (3-8 words), e.g. "Pelagic Exo-Tech hooded fishing shirt"\n` +
    `- "description" is 1 sentence and should include material / color / notable features suitable for a product search\n` +
    `- "brand" is only set if a brand name is visible or obvious; null otherwise\n` +
    `- "confidence" reflects how certain you are of the specific identification (not just the class)\n` +
    `- If a crop is unreadable or ambiguous, return the YOLO class name as the label and confidence < 0.3\n` +
    `- Return items ONLY for crops you can see. Always include an entry for every index 1..${imageParts.length}.\n` +
    `Return ONLY valid JSON — no prose outside.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, ...imageParts]
    }],
    max_tokens: 1800,
    temperature: 0.2
  });

  const raw = response.choices[0].message.content.trim();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = JSON5.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}'); }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const summary = [];

  for (const item of items) {
    const idx = Number(item.index);
    if (!idx || idx < 1 || idx > chunk.length) continue;
    const det = chunk[idx - 1];
    const identification = {
      label:       typeof item.label === 'string' ? item.label : (det.className || ''),
      description: typeof item.description === 'string' ? item.description : '',
      brand:       typeof item.brand === 'string' && item.brand.trim() ? item.brand.trim() : null,
      category:    typeof item.category === 'string' ? item.category : 'other',
      confidence:  Math.max(0, Math.min(1, Number(item.confidence) || 0))
    };
    det.identification = identification;
    summary.push({ id: det.id, ...identification });
  }

  // Fill in blanks for any detection the model skipped.
  chunk.forEach((det, i) => {
    if (!det.identification) {
      det.identification = {
        label: det.className || 'unknown',
        description: '',
        brand: null,
        category: 'other',
        confidence: 0
      };
      summary.push({ id: det.id, ...det.identification });
    }
  });

  return summary;
}

module.exports = { identifyYoloDetections };
