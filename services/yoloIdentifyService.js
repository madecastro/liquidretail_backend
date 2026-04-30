// YOLO identification — batched GPT-4.1 Vision call that takes the in-memory
// product crops from YOLO and attaches structured identifications to each.
// Runs in parallel with geminiIdentifyService (Phase 1.5c dual-engine
// enrichment); enrichmentReconciler then merges the two engine outputs.
//
// MULTI-PRODUCT PER CROP (Phase 1.5c) — each crop can contain MULTIPLE
// distinguishable retail products. A YOLO 'person' bbox is the common case
// — a single crop containing both a shirt and a hat. Output shape per
// detection now carries a products[] array, not a single identification:
//
//   det.engines.gpt = {
//     products: [
//       { label, description, brand, category, confidence },
//       { label, description, brand, category, confidence },   // multi-product
//       ...
//     ]
//   }
//
// Empty products array marks the crop as non-product (UI chrome, watermark,
// etc.) — replaces the former label="non-product" sentinel.
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
    `list EVERY DISTINGUISHABLE retail product visible — a single crop may contain multiple products ` +
    `(e.g. a torso/person crop showing a shirt AND a hat, or a flat-lay showing several items). ` +
    `Crops are produced by a multi-stage bounding-box proposer (YOLO + OpenCV contours + ` +
    `GPT-4o-mini) that does NOT filter for product-ness — many crops will be UI chrome ` +
    `(scroll arrows, IG carousel indicators, navigation icons), watermarks, partial human limbs, ` +
    `blank/blurry regions, or screenshot artifacts. For those, return an EMPTY products array. ` +
    `DO NOT confabulate a product label from brand/category context when the crop doesn't ` +
    `actually show a product.\n\n` +
    `Images (in order):\n${indexLines.join('\n')}${hintBlock}\n\n` +
    `Return JSON:\n` +
    `{ "items": [\n` +
    `  { "index": 1, "products": [\n` +
    `    { "label": "Pelagic Gear bikini top", "description": "blue and white camo print bikini top", "brand": "Pelagic Gear", "category": "apparel", "confidence": 0.85 },\n` +
    `    { "label": "Pelagic Gear trucker cap", "description": "gray mesh-back trucker cap", "brand": "Pelagic Gear", "category": "apparel", "confidence": 0.7 }\n` +
    `  ]},\n` +
    `  { "index": 2, "products": [] },\n` +
    `  ...\n` +
    `]}\n\n` +
    `Guidance per product entry:\n` +
    `- "label" is short (3-8 words), e.g. "Pelagic Exo-Tech hooded fishing shirt"\n` +
    `- "description" is 1 sentence including OBSERVED material / color / notable features (true to pixels — do not assert "quick-dry stretch fabric" if you can't see it)\n` +
    `- "brand" is only set when a brand name is VISIBLY identifiable on the crop itself; null otherwise (do not infer from context)\n` +
    `- "category" is from the enum: apparel | electronics | food_beverage | home | toys | tools | beauty | sports | accessories | other\n` +
    `- "confidence" reflects how certain you are of the SPECIFIC IDENTIFICATION (not just that something is there). A crop that "might be" a brand-X product but lacks a visible label should be 0.4-0.5, not 0.8.\n\n` +
    `Per-crop rules:\n` +
    `- products: [] (EMPTY ARRAY) when the crop is non-product: UI overlay, scroll arrow, navigation chrome, IG carousel indicator, watermark, partial limb, blank/blurry area, screenshot artifact, decorative graphic.\n` +
    `- products: [single entry] when the crop tightly shows ONE identifiable product.\n` +
    `- products: [multiple entries] when the crop contains 2+ distinguishable retail products. List each separately. Confidence per product reflects that specific item, not the crop overall.\n` +
    `- Return one item entry for every index 1..${imageParts.length}, even if products is [].\n` +
    `Return ONLY valid JSON — no prose outside.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, ...imageParts]
    }],
    // Multi-product per-crop output: each product entry is ~150 chars; a
    // 24-crop chunk × 2-3 products each can run 8k+ chars. 1800 was tight;
    // 3500 covers worst case while still bounded.
    max_tokens: 3500,
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

    // Phase 1.5c — multi-product output. Each crop yields products[] (0+).
    const rawProducts = Array.isArray(item.products) ? item.products : [];
    const products = rawProducts.map(p => normalizeProduct(p)).filter(Boolean);

    det.engines = det.engines || {};
    det.engines.gpt = { products };

    // Backward-compat alias — set det.identification to the highest-confidence
    // product (or non-product fallback). Reconciler may overwrite this with
    // the merged primary product after Gemini results land.
    det.identification = aliasFromProducts(products);

    summary.push({
      id: det.id,
      productCount: products.length,
      products: products.map(p => ({ label: p.label, brand: p.brand, confidence: p.confidence }))
    });
  }

  // Fill in blanks for any detection the model skipped. Treat as non-product
  // (empty products array) — replaces the legacy label='non-product' sentinel
  // so the new schema is consistent across all paths.
  chunk.forEach((det) => {
    if (!det.engines || !det.engines.gpt) {
      det.engines = det.engines || {};
      det.engines.gpt = { products: [] };
      det.identification = nonProductIdentification();
      summary.push({ id: det.id, productCount: 0, products: [] });
    }
  });

  return summary;
}

// Normalize a single product entry from the GPT response into the canonical
// shape. Returns null on entries that fail validation (missing label, etc.).
function normalizeProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const label = typeof p.label === 'string' ? p.label.trim() : '';
  if (!label) return null;
  return {
    label,
    description: typeof p.description === 'string' ? p.description : '',
    brand:       typeof p.brand === 'string' && p.brand.trim() ? p.brand.trim() : null,
    category:    typeof p.category === 'string' ? p.category : 'other',
    confidence:  Math.max(0, Math.min(1, Number(p.confidence) || 0))
  };
}

// Pick the primary product for the legacy `det.identification` alias.
// Highest-confidence wins; non-product fallback when products is empty.
function aliasFromProducts(products) {
  if (!products || !products.length) return nonProductIdentification();
  const best = products.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
  return { ...best };
}

function nonProductIdentification() {
  return {
    label:       'non-product',
    description: '',
    brand:       null,
    category:    'non-product',
    confidence:  0
  };
}

module.exports = { identifyYoloDetections };
