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
  if (brand)    hintLines.push(`- Expected brand for this scene: ${brand}`);
  if (category) hintLines.push(`- Expected category for this scene: ${category}`);
  // Hints are framed as a SANITY CHECK, not a prior. The previous wording
  // ("User states the BRAND visible is: X") leaked as truth and caused GPT
  // to confabulate brand-shaped product labels on non-product crops (e.g.
  // an IG carousel scroll arrow getting labeled as "Pelagic Gear leggings").
  const hintBlock = hintLines.length
    ? `\n\nUser-provided context (use as a SANITY CHECK only — if a crop clearly does not match these hints, mark it non-product or set brand=null with lower confidence rather than forcing a label to fit):\n${hintLines.join('\n')}`
    : '';

  // Build the image list. Each detection's cropBuffer is a PNG/JPEG buffer;
  // encode inline so we don't need a round-trip to Cloudinary for transient
  // recognition work. Label each image by its sequential prompt index
  // (1..N for the images actually sent), and keep a separate map back to
  // the original chunk position so a detection without cropBuffer doesn't
  // cause prompt-index drift — the prior code used i+1 as the prompt index
  // even when an earlier item was skipped, which would tell GPT "indices are
  // 1, 2, 4, 5" and risk mismapping if GPT renumbered visually as 1..N.
  const imageParts = [];
  const indexLines = [];
  const promptIndexToChunk = [];   // promptIndex (1-based) → original chunk index
  chunk.forEach((det, i) => {
    if (!det.cropBuffer) return;
    const promptIndex = imageParts.length + 1;
    promptIndexToChunk[promptIndex] = i;
    const dataUrl = `data:image/jpeg;base64,${det.cropBuffer.toString('base64')}`;
    imageParts.push({ type: 'image_url', image_url: { url: dataUrl } });
    indexLines.push(`#${promptIndex} — YOLO class "${det.className || 'unknown'}" (conf=${(det.confidence ?? 0).toFixed(2)})`);
  });

  if (imageParts.length === 0) return [];

  if (chunk.length !== imageParts.length) {
    console.warn(`   ⚠️  yolo-identify: ${chunk.length - imageParts.length} of ${chunk.length} detection(s) lacked cropBuffer; sending ${imageParts.length} image(s) with sequential prompt indices 1..${imageParts.length}. Skipped slots will be marked non-product by the fill-in-blanks fallback.`);
  }

  const prompt =
    `You will see ${imageParts.length} crops from a piece of social-media content. For each crop, ` +
    `identify the specific product IF ONE IS CLEARLY VISIBLE. Crops are produced by a multi-stage ` +
    `bounding-box proposer (YOLO + OpenCV contours + GPT-4o-mini) that does NOT filter for ` +
    `product-ness — many crops will be UI chrome (scroll arrows, IG carousel indicators, ` +
    `navigation icons), watermarks, partial human limbs, blank/blurry regions, or screenshot ` +
    `artifacts. Mark those non-products explicitly. DO NOT confabulate a product label from the ` +
    `brand/category context when the crop doesn't actually show a product.\n\n` +
    `Images (in order):\n${indexLines.join('\n')}${hintBlock}\n\n` +
    `Return JSON:\n` +
    `{ "items": [ { "index": 1, "label": "...", "description": "...", "brand": "..." | null, "category": "apparel|electronics|food_beverage|home|toys|tools|beauty|sports|accessories|non-product|other", "confidence": 0.0-1.0 }, ... ] }\n\n` +
    `Guidance:\n` +
    `- "label" is short (3-8 words), e.g. "Pelagic Exo-Tech hooded fishing shirt"\n` +
    `- "description" is 1 sentence including material / color / notable features for product search\n` +
    `- "brand" is only set when a brand name is VISIBLY identifiable on the crop itself; null otherwise (do not infer from context)\n` +
    `- "confidence" reflects how certain you are of the SPECIFIC IDENTIFICATION (not just that something is there). A crop that "might be" a brand-X product but lacks a visible label should be 0.4-0.5, not 0.8.\n` +
    `- IF THE CROP DOES NOT SHOW A RECOGNIZABLE RETAIL PRODUCT (UI overlay, scroll arrow, navigation chrome, IG carousel indicator, watermark, partial limb, blank/blurry area, screenshot artifact, decorative graphic), return: label="non-product", description="", brand=null, category="non-product", confidence=0.0. Do NOT invent a plausible-sounding label that fits the brand/category hints.\n` +
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
    const promptIdx = Number(item.index);
    // Resolve the prompt index back through promptIndexToChunk. This is the
    // critical step — GPT returns indices that match the prompt's #N labels
    // (which are sequential 1..imageParts.length). The lookup map ensures
    // chunk slots that were skipped (no cropBuffer) never receive an
    // identification meant for a different detection.
    if (!promptIdx || promptIdx < 1 || promptIdx > imageParts.length) continue;
    const chunkIdx = promptIndexToChunk[promptIdx];
    if (chunkIdx == null) continue;
    const det = chunk[chunkIdx];
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

  // Fill in blanks for any detection the model skipped. Treat as non-product
  // (matches the prompt's escape-hatch contract) so downstream filters drop
  // them rather than letting a YOLO class name like 'frisbee' stand in as
  // the product label.
  chunk.forEach((det, i) => {
    if (!det.identification) {
      det.identification = {
        label:       'non-product',
        description: '',
        brand:       null,
        category:    'non-product',
        confidence:  0
      };
      summary.push({ id: det.id, ...det.identification });
    }
  });

  return summary;
}

module.exports = { identifyYoloDetections };
