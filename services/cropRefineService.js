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
  // Dedup pass — overlapping YOLO detections (e.g. a person bbox and a
  // whole-image object bbox both containing the same glove) yield
  // duplicate refined products after multi-product surfacing. Collapse
  // them by spatial overlap + same brand/category, keeping the highest
  // confidence and re-IDing sequentially.
  return dedupRefinedProducts(all);
}

// IoU-based dedup. Two refined products are duplicates when they share
// brand + category AND either (a) IoU ≥ 0.5 or (b) one bbox is contained
// ≥80% inside the other. Brand match uses loose normalize (so "Pelagic"
// and "Pelagic Gear" merge); category requires exact match (apparel vs
// sports stays distinct so we don't collapse a glove and a fishing belt).
function dedupRefinedProducts(refined) {
  if (!Array.isArray(refined) || refined.length <= 1) return refined;
  const sorted = refined.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const kept = [];
  let dropped = 0;
  for (const r of sorted) {
    const dup = kept.find(k => areDuplicateRefined(r, k));
    if (dup) {
      dropped++;
      continue;
    }
    kept.push(r);
  }
  if (dropped > 0) {
    console.log(`   · crop-refine dedup: dropped ${dropped} duplicate refined product(s) (${kept.length} kept of ${refined.length})`);
  }
  // Re-id sequentially so the visible IDs stay r1..rN with no gaps.
  return kept.map((r, i) => ({ ...r, id: `r${i + 1}` }));
}

function areDuplicateRefined(a, b) {
  if (!sameBrandLoose(a.brand, b.brand)) return false;
  if ((a.category || null) !== (b.category || null)) return false;
  if (computeIoU(a, b) >= 0.5) return true;
  // Containment — small glove bbox inside a whole-image object bbox.
  // Use the smaller of the two as the "small" half and check what
  // fraction of it lies inside the larger.
  const aArea = bboxArea(a);
  const bArea = bboxArea(b);
  const [small, large] = aArea <= bArea ? [a, b] : [b, a];
  return containmentRatio(small, large) >= 0.80;
}

function computeIoU(a, b) {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const union = bboxArea(a) + bboxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

function containmentRatio(small, large) {
  const ix1 = Math.max(small.x1, large.x1);
  const iy1 = Math.max(small.y1, large.y1);
  const ix2 = Math.min(small.x2, large.x2);
  const iy2 = Math.min(small.y2, large.y2);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const smallA = bboxArea(small);
  return smallA > 0 ? inter / smallA : 0;
}

function bboxArea(b) {
  const w = Math.max(0, (b.x2 || 0) - (b.x1 || 0));
  const h = Math.max(0, (b.y2 || 0) - (b.y1 || 0));
  return w * h;
}

function sameBrandLoose(a, b) {
  const na = normalizeBrandKey(a);
  const nb = normalizeBrandKey(b);
  if (!na && !nb) return true;     // both null/empty → treat as equal
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Whole-token prefix tolerance (≥4 chars on the shorter side) so
  // "Pelagic" matches "Pelagic Gear" — same logic as productMatchService.
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  if (shorter.length < 4) return false;
  return longer.startsWith(shorter + ' ');
}

function normalizeBrandKey(s) {
  return String(s || '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\b(inc|co|llc|ltd|corp|corporation)\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

    // List ALL reconciled products for this crop (not just the primary).
    // The upstream dual-engine reconciler often identifies multiple products
    // inside a single YOLO bbox (e.g. a 'person' crop containing glove +
    // cap + shirt + fighting belt). The LLM needs to know about all of
    // them to produce one box per product.
    const reconciled = det.engines?.reconciled?.products || [];
    const products = reconciled.length
      ? reconciled
      : [{ label: det.identification?.label || det.className || 'product', category: det.identification?.category || 'other', brand: det.identification?.brand || null, confidence: det.identification?.confidence ?? null }];

    const productLines = products.map((p, idx) => {
      const conf = (typeof p.confidence === 'number') ? ` · ${(p.confidence * 100).toFixed(0)}%` : '';
      const brand = p.brand ? ` · ${p.brand}` : '';
      return `    ${idx + 1}. "${p.label}" (${p.category || 'other'})${brand}${conf}`;
    }).join('\n');
    indexLines.push(`#${promptIndex} — ${products.length} identified product(s):\n${productLines}`);
  });

  if (imageParts.length === 0) return [];

  const prompt =
    `You will see ${imageParts.length} crop image(s). For EACH crop, the upstream ` +
    `vision pipeline has already identified one or more products inside it. Your job is ` +
    `to return a tight bounding box for EACH identified product — NORMALIZED to [0.0, 1.0] ` +
    `relative to the crop's own dimensions.\n\n` +
    `Crops and their identified products:\n${indexLines.join('\n')}\n\n` +
    `Return JSON:\n` +
    `{ "items": [\n` +
    `  { "index": 1, "boxes": [\n` +
    `    { "x1": 0.10, "y1": 0.05, "x2": 0.90, "y2": 0.45, "label": "bikini top", "confidence": 0.9 },\n` +
    `    { "x1": 0.20, "y1": 0.55, "x2": 0.85, "y2": 0.95, "label": "bikini bottom", "confidence": 0.85 }\n` +
    `  ] }\n` +
    `]}\n\n` +
    `Guidance:\n` +
    `- Coordinates MUST be in [0, 1] relative to the input crop dimensions (0,0 = top-left)\n` +
    `- Return ONE box for EACH identified product listed for the crop. The "label" you return MUST closely match one of the identified product labels (verbatim or near-verbatim) so we can pair the box back to the source identification.\n` +
    `- If a listed product is NOT actually visible in the crop, omit its box (don't fabricate one).\n` +
    `- "confidence" reflects how cleanly your box isolates the labeled product (independent from the upstream identification confidence — both will be combined downstream).\n` +
    `- If the entire crop tightly shows ONE product, return ~{x1:0.05, y1:0.05, x2:0.95, y2:0.95} for that label.\n` +
    `- If the crop is unsuitable (too blurry, no products visible), return an empty "boxes" array.\n` +
    `- Return one item for every index 1..${imageParts.length}\n` +
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

      // Match the LLM-returned box to the SPECIFIC reconciled product it
      // refers to (not just det.identification[0] which is only the primary).
      // The LLM was told to return labels matching one of the identified
      // products; we pair by token-overlap so each refined product carries
      // its own brand / category / categoryLabel / source confidence.
      const reconciled = det.engines?.reconciled?.products || [];
      const matched = matchBoxToReconciled(box.label, reconciled) || null;

      // Confidence clamp: refined.confidence ≤ matched reconciled product's
      // confidence (or det.identification.confidence as fallback). The LLM
      // box.confidence describes how tight the bbox is; the upstream
      // reconciled confidence describes how sure we are the product is
      // there. Take the min so refined never out-confidences its source.
      const upstreamConf = (matched?.confidence != null
        ? clampUnit(Number(matched.confidence))
        : (det.identification?.confidence != null
          ? clampUnit(Number(det.identification.confidence))
          : 1));
      const boxConf = clampUnit(Number(box.confidence));
      const refinedConfidence = Math.min(boxConf, upstreamConf);

      refined.push({
        id:                `r${counter++}`,
        sourceDetectionId: det.id,
        x1:                sx1,
        y1:                sy1,
        x2:                sx2,
        y2:                sy2,
        label:             matched?.label || (typeof box.label === 'string' && box.label.trim() ? box.label.trim() : (det.identification?.label || '')),
        // Phase 1.7 — carry the matched reconciled product's category +
        // brand + categoryLabel. Catalog-first matching uses category
        // for hard scoping the candidate pool, and categoryLabel as a
        // fallback text query when the specific label doesn't catalog-match.
        category:          matched?.category || det.identification?.category || null,
        brand:             matched?.brand || det.identification?.brand || null,
        categoryLabel:     matched?.categoryLabel || null,
        agreement:         matched?.agreement || null,
        confidence:        refinedConfidence,
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

// Pair an LLM-returned box label to one of the reconciled products
// identified for the source crop. Token-Jaccard over normalized labels;
// returns the highest-overlap reconciled entry, falling back to null when
// none cross a soft threshold (caller treats null as "use det defaults").
function matchBoxToReconciled(boxLabel, reconciledProducts) {
  if (!boxLabel || !Array.isArray(reconciledProducts) || !reconciledProducts.length) return null;
  const boxTokens = tokenize(boxLabel);
  if (!boxTokens.size) return reconciledProducts[0] || null;
  let best = null;
  let bestScore = 0;
  for (const r of reconciledProducts) {
    const rTokens = tokenize(r.label || '');
    if (!rTokens.size) continue;
    const inter = [...boxTokens].filter(t => rTokens.has(t)).length;
    const union = new Set([...boxTokens, ...rTokens]).size;
    const score = union ? inter / union : 0;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  // Soft threshold: 0.25 Jaccard catches "fishing glove" ↔ "Pelagic Gear
  // fishing glove" without matching unrelated labels. Below threshold,
  // fall back to the highest-confidence reconciled product as a safer
  // default than nothing.
  if (bestScore >= 0.25) return best;
  return reconciledProducts[0] || null;
}

function tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)        // drop "a", "of", "the"
  );
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
