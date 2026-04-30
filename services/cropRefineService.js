// Phase 1.6 — bounding-box refinement.
//
// After yoloIdentifyService labels each detection (and Phase 1.5 marks
// non-products), this service does ONE batched GPT-4.1 Vision call to
// return tight per-product bboxes. A single input crop can yield 1+
// refined bboxes — a YOLO 'person' container often contains a bikini
// top + bottoms + accessories, all distinguishable products that should
// match against the catalog independently.
//
// Coordinates: GPT returns [0,1] normalized (relative to the input crop).
// The service translates back to source-image pixel coords so consumers
// can crop the original directly. Each refined product also carries a
// Cloudinary `c_crop` transform URL (no re-upload needed — the source
// image already lives on Cloudinary; the transform produces the tight
// crop on demand).
//
// Failure mode: any error returns []; the detect pipeline falls back to
// the original yoloProducts bboxes for downstream matching. Refinement
// is an enhancement, not a hard dependency.

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_DETECTIONS_PER_CALL = 16;   // smaller than yoloIdentify (24) — refinement prompt is heavier per item

async function refineDetectionCrops(detections, sourceImageUrl) {
  if (!Array.isArray(detections) || !detections.length) return [];

  // Batch in chunks if many detections survived the non-product filter.
  const all = [];
  for (let offset = 0; offset < detections.length; offset += MAX_DETECTIONS_PER_CALL) {
    const chunk = detections.slice(offset, offset + MAX_DETECTIONS_PER_CALL);
    const refined = await refineChunk(chunk, sourceImageUrl, offset);
    all.push(...refined);
  }
  return all;
}

async function refineChunk(chunk, sourceImageUrl, idOffset) {
  // Defensive index alignment (same pattern as yoloIdentifyService) — only
  // detections with a cropBuffer go to GPT; the promptIndexToChunk map
  // preserves the link back so a missing crop can't cause GPT's response
  // indices to mismap onto neighboring detections.
  const imageParts = [];
  const indexLines = [];
  const promptIndexToChunk = [];
  chunk.forEach((det, i) => {
    if (!det.cropBuffer) return;
    const promptIndex = imageParts.length + 1;
    promptIndexToChunk[promptIndex] = i;
    const dataUrl = `data:image/jpeg;base64,${det.cropBuffer.toString('base64')}`;
    imageParts.push({ type: 'image_url', image_url: { url: dataUrl } });
    const label = det.identification?.label || det.className || 'product';
    const cat   = det.identification?.category || 'other';
    indexLines.push(`#${promptIndex} — labeled "${label}" (${cat})`);
  });

  if (imageParts.length === 0) return [];

  const prompt =
    `You will see ${imageParts.length} product crop(s). For each crop, return tight ` +
    `bounding box(es) — NORMALIZED to [0.0, 1.0] relative to the crop's own dimensions ` +
    `— covering JUST the labeled product. A single crop may show MULTIPLE distinguishable ` +
    `products (e.g., a 'person' crop may contain both a bikini top and bikini bottoms — ` +
    `return one box per item).\n\n` +
    `Crops:\n${indexLines.join('\n')}\n\n` +
    `Return JSON:\n` +
    `{ "items": [\n` +
    `  { "index": 1, "boxes": [ { "x1": 0.12, "y1": 0.05, "x2": 0.85, "y2": 0.45, "label": "bikini top", "confidence": 0.9 } ] },\n` +
    `  { "index": 2, "boxes": [\n` +
    `    { "x1": 0.10, "y1": 0.05, "x2": 0.90, "y2": 0.45, "label": "bikini top", "confidence": 0.85 },\n` +
    `    { "x1": 0.20, "y1": 0.55, "x2": 0.85, "y2": 0.95, "label": "bikini bottom", "confidence": 0.80 }\n` +
    `  ] }\n` +
    `]}\n\n` +
    `Guidance:\n` +
    `- Coordinates MUST be in [0, 1] relative to the input crop dimensions (0,0 = top-left)\n` +
    `- "label" should be the specific product type (e.g., "bikini top", "leggings", "trucker hat") — refine the input label when possible\n` +
    `- "confidence" reflects how cleanly the box isolates the labeled product\n` +
    `- If the crop already tightly shows ONLY the labeled product, return one box at ~{x1:0.05, y1:0.05, x2:0.95, y2:0.95}\n` +
    `- If the crop is unsuitable (too blurry, too small, no clear product, or shows only background after Phase 1.5 filtering somehow let it through), return an empty "boxes" array for that index\n` +
    `- Return one item for every index 1..${imageParts.length}\n` +
    `- Do NOT confabulate products that aren't visibly present\n` +
    `Return ONLY valid JSON — no prose outside.`;

  let parsed;
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt }, ...imageParts]
      }],
      max_tokens: 1500,
      temperature: 0.2
    });
    const raw = response.choices[0].message.content.trim();
    try { parsed = JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else throw new Error('refine response not parseable as JSON');
    }
  } catch (err) {
    console.warn(`   ⚠️  crop-refine call failed: ${err.message}`);
    return [];
  }

  const refined = [];
  let counter = idOffset + 1;
  for (const item of parsed.items || []) {
    const promptIdx = Number(item.index);
    if (!promptIdx || promptIdx < 1 || promptIdx > imageParts.length) continue;
    const chunkIdx = promptIndexToChunk[promptIdx];
    if (chunkIdx == null) continue;
    const det = chunk[chunkIdx];

    const cropW = (det.x2 - det.x1) || 0;
    const cropH = (det.y2 - det.y1) || 0;
    if (cropW <= 0 || cropH <= 0) continue;

    for (const box of (item.boxes || [])) {
      const bx1 = clampUnit(Number(box.x1));
      const by1 = clampUnit(Number(box.y1));
      const bx2 = clampUnit(Number(box.x2));
      const by2 = clampUnit(Number(box.y2));
      if (!(bx2 > bx1) || !(by2 > by1)) continue;

      const sx1 = Math.round(det.x1 + bx1 * cropW);
      const sy1 = Math.round(det.y1 + by1 * cropH);
      const sx2 = Math.round(det.x1 + bx2 * cropW);
      const sy2 = Math.round(det.y1 + by2 * cropH);
      const w = sx2 - sx1;
      const h = sy2 - sy1;
      if (w <= 0 || h <= 0) continue;

      refined.push({
        id:                `r${counter++}`,
        sourceDetectionId: det.id,
        x1:                sx1,
        y1:                sy1,
        x2:                sx2,
        y2:                sy2,
        label:             typeof box.label === 'string' && box.label.trim() ? box.label.trim() : (det.identification?.label || ''),
        // Phase 1.7 — carry the upstream reconciled identification's category +
        // brand + categoryLabel through. Catalog-first matching uses category
        // for hard scoping the candidate pool, and categoryLabel as a
        // fallback text query when the specific label doesn't catalog-match.
        category:          det.identification?.category || null,
        brand:             det.identification?.brand || null,
        categoryLabel:     det.engines?.reconciled?.products?.[0]?.categoryLabel || null,
        confidence:        clampUnit(Number(box.confidence)),
        croppedImageUrl:   buildCloudinaryCropUrl(sourceImageUrl, sx1, sy1, sx2, sy2)
      });
    }
  }

  console.log(`   ✓ crop-refine: ${refined.length} refined product(s) from ${imageParts.length} input crop(s)`);
  return refined;
}

function clampUnit(n) {
  if (typeof n !== 'number' || !isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Build a Cloudinary `c_crop` transform URL that returns the tight crop
// of the source image — no re-upload, just a transform. Used downstream
// by visualCatalogMatchService and (eventually) preview consumers that
// want the per-product image.
function buildCloudinaryCropUrl(sourceUrl, x1, y1, x2, y2) {
  if (!sourceUrl || !sourceUrl.includes('/upload/')) return null;
  const w = Math.max(1, Math.round(x2 - x1));
  const h = Math.max(1, Math.round(y2 - y1));
  const x = Math.max(0, Math.round(x1));
  const y = Math.max(0, Math.round(y1));
  const transform = `c_crop,w_${w},h_${h},x_${x},y_${y}`;
  if (/\/v\d+\//.test(sourceUrl)) {
    return sourceUrl.replace(/\/(v\d+\/)/, `/${transform}/$1`);
  }
  return sourceUrl.replace('/upload/', `/upload/${transform}/`);
}

module.exports = { refineDetectionCrops };
