// Phase 1.5c — Gemini Vision identification, parallel companion to
// yoloIdentifyService. Same input (the cropBuffer per detection), same
// output shape (per-detection products[] array), different vision engine.
// enrichmentReconciler.js merges this with the GPT output to produce
// det.engines.reconciled.products[].
//
// Each detection ends up with:
//   det.engines.gemini = { products: [{ label, description, brand, category, confidence }, ...] }
//
// Empty products array marks the crop as non-product (UI chrome, watermark,
// blank/blurry region, etc.). Same semantics as yoloIdentifyService.
//
// Failure mode: any error returns det.engines.gemini = null on every
// detection — reconciler treats this as "no Gemini signal" and falls back
// to GPT-only identifications with a single-engine confidence penalty.

const axios = require('axios');
const JSON5 = require('json5');

const MODEL    = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const MAX_DETECTIONS_PER_CALL = 16;   // smaller than GPT (24) — Gemini Vision is more sensitive to large multi-image batches

function isEnabled() { return !!process.env.GEMINI_API_KEY; }

async function identifyYoloDetectionsGemini(detections, hints = {}) {
  if (!Array.isArray(detections) || detections.length === 0) return [];
  if (!isEnabled()) {
    console.warn('   ⚠️  gemini-identify: GEMINI_API_KEY not set; setting engines.gemini=null');
    detections.forEach(d => { d.engines = d.engines || {}; d.engines.gemini = null; });
    return [];
  }

  const all = [];
  for (let offset = 0; offset < detections.length; offset += MAX_DETECTIONS_PER_CALL) {
    const chunk = detections.slice(offset, offset + MAX_DETECTIONS_PER_CALL);
    const batchResults = await identifyChunkGemini(chunk, hints);
    all.push(...batchResults);
  }
  return all;
}

async function identifyChunkGemini(chunk, hints) {
  const { brand, category } = hints;
  const hintLines = [];
  if (brand)    hintLines.push(`- Expected brand for this scene: ${brand}`);
  if (category) hintLines.push(`- Expected category for this scene: ${category}`);
  // Same sanity-check framing as yoloIdentifyService — hints are not assumed truth.
  const hintBlock = hintLines.length
    ? `\n\nUser-provided context (use as a SANITY CHECK only — if a crop clearly does not match these hints, return an empty products array or set brand=null with lower confidence rather than forcing a label to fit):\n${hintLines.join('\n')}`
    : '';

  // Defensive prompt-index alignment (mirrors yoloIdentifyService) — a
  // detection without cropBuffer must not cause prompt-index drift.
  const imageParts = [];
  const indexLines = [];
  const promptIndexToChunk = [];
  chunk.forEach((det, i) => {
    if (!det.cropBuffer) return;
    const promptIndex = imageParts.length + 1;
    promptIndexToChunk[promptIndex] = i;
    imageParts.push({
      inlineData: { mimeType: 'image/jpeg', data: det.cropBuffer.toString('base64') }
    });
    indexLines.push(`#${promptIndex} — YOLO class "${det.className || 'unknown'}" (conf=${(det.confidence ?? 0).toFixed(2)})`);
  });

  if (imageParts.length === 0) return [];

  const prompt =
    `You will see ${imageParts.length} crops from a piece of social-media content. For each crop, ` +
    `list EVERY DISTINGUISHABLE retail product visible — a single crop may contain multiple products ` +
    `(e.g. a torso/person crop showing a shirt AND a hat, or a flat-lay showing several items). ` +
    `Crops are produced by a multi-stage bounding-box proposer that does NOT filter for product-ness ` +
    `— many crops will be UI chrome (scroll arrows, IG carousel indicators, navigation icons), ` +
    `watermarks, partial human limbs, blank/blurry regions, or screenshot artifacts. For those, ` +
    `return an EMPTY products array. DO NOT confabulate a product label from brand/category context ` +
    `when the crop doesn't actually show a product.\n\n` +
    `Images are attached in order, indexed 1..${imageParts.length}:\n${indexLines.join('\n')}${hintBlock}\n\n` +
    `Return JSON:\n` +
    `{ "items": [\n` +
    `  { "index": 1, "products": [\n` +
    `    { "label": "Pelagic Gear bikini top", "description": "blue and white camo print bikini top", "brand": "Pelagic Gear", "category": "apparel", "confidence": 0.85 },\n` +
    `    { "label": "Pelagic Gear trucker cap", "description": "gray mesh-back trucker cap", "brand": "Pelagic Gear", "category": "apparel", "confidence": 0.7 }\n` +
    `  ]},\n` +
    `  { "index": 2, "products": [] }\n` +
    `]}\n\n` +
    `Guidance per product entry:\n` +
    `- "label" is short (3-8 words), e.g. "Pelagic Exo-Tech hooded fishing shirt"\n` +
    `- "description" is 1 sentence including OBSERVED material / color / notable features (true to pixels — do not assert "quick-dry stretch fabric" if you can't see it)\n` +
    `- "brand" only set when a brand name is VISIBLY identifiable on the crop itself; null otherwise (do not infer from context)\n` +
    `- "category" from enum: apparel | electronics | food_beverage | home | toys | tools | beauty | sports | accessories | other\n` +
    `- "confidence" reflects how certain you are of the SPECIFIC IDENTIFICATION (not just that something is there). 0.4-0.5 for "might be" without visible label.\n\n` +
    `Per-crop rules:\n` +
    `- products: [] when the crop is non-product (UI chrome, watermark, blurry region, partial limb, screenshot artifact, decorative graphic).\n` +
    `- products: [single entry] when the crop tightly shows ONE identifiable product.\n` +
    `- products: [multiple entries] when the crop contains 2+ distinguishable retail products. List each separately.\n` +
    `- Return one item entry for every index 1..${imageParts.length}, even if products is [].\n` +
    `Return ONLY valid JSON — no prose outside.`;

  let parsed;
  try {
    const res = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{
          role: 'user',
          parts: [{ text: prompt }, ...imageParts]
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2000,
          responseMimeType: 'application/json'
        }
      },
      { timeout: 45000 }
    );
    const text = (res.data?.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '').join('').trim();
    try { parsed = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON5.parse(m[0]);
    }
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  gemini-identify failed: ${detail}`);
    chunk.forEach(det => {
      det.engines = det.engines || {};
      det.engines.gemini = null;        // signals reconciler that Gemini didn't run
    });
    return [];
  }

  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const summary = [];

  for (const item of items) {
    const promptIdx = Number(item.index);
    if (!promptIdx || promptIdx < 1 || promptIdx > imageParts.length) continue;
    const chunkIdx = promptIndexToChunk[promptIdx];
    if (chunkIdx == null) continue;
    const det = chunk[chunkIdx];

    const rawProducts = Array.isArray(item.products) ? item.products : [];
    const products = rawProducts.map(p => normalizeProduct(p)).filter(Boolean);

    det.engines = det.engines || {};
    det.engines.gemini = { products };

    summary.push({
      id: det.id,
      productCount: products.length,
      products: products.map(p => ({ label: p.label, brand: p.brand, confidence: p.confidence }))
    });
  }

  // Fill in blanks for any detection Gemini didn't return — distinct from
  // "Gemini call failed entirely" (engines.gemini=null above). A skipped
  // index gets engines.gemini = { products: [] } meaning "Gemini saw no
  // products in this crop."
  chunk.forEach((det) => {
    if (!det.engines) det.engines = {};
    if (det.engines.gemini === undefined) {
      det.engines.gemini = { products: [] };
      summary.push({ id: det.id, productCount: 0, products: [] });
    }
  });

  return summary;
}

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

module.exports = { identifyYoloDetectionsGemini, isEnabled };
