const OpenAI = require('openai');
const JSON5 = require('json5');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
//  Main judge — products, subjects, text treatment, and base-ratio crops
//  (5:4, 1:1, 4:5). Uses a structured rubric so decisions are consistent and
//  the scores are exposed to the UI for spot-checking.
// ─────────────────────────────────────────────────────────────────────────────
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
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are an expert visual content judge for an e-commerce inventory platform.
Score every candidate on a 0–10 rubric, then pick a winner from non-rejected entries.

RETURN THIS EXACT JSON SHAPE — no prose outside it:

{
  "products": { "winnerIds": ["p1",...], "reasoning": "..." },
  "subjects": { "primaryId": "s1" | null, "reasoning": "..." },
  "text":     { "treatment": "include" | "exclude" | "subject", "affectedIds": ["t1",...], "reasoning": "..." },
  "crop_5_4": { "winnerId": "5:4-1", "reasoning": "...", "scores": { "5:4-1": { "total": 0, "dimensions": {...}, "rejected": null }, ... } },
  "crop_1_1": { ...same shape as crop_5_4 for all 1:1-* candidates... },
  "crop_4_5": { ...same shape... }
}

CROP SCORING RUBRIC (each 0–10, integers):
  - subject_containment : is the safe envelope fully inside the crop rect? Hard penalty if clipped.
  - subject_prominence  : does the subject occupy a meaningful portion of frame, rule-of-thirds friendly?
  - margin_quality      : breathing room around subject without wasted empty space.
  - text_preservation   : detected labels/brand text remain fully visible and readable.
  - aesthetic_balance   : composition, negative space, not lopsided.

HARD-REJECT (set "rejected" to a short reason string, still fill dimensions with low scores):
  - Safe envelope clipped at any edge  →  "clips subject"
  - Subject <10% of frame area         →  "subject too small"
  - Critical label text cut            →  "label cut"
If at least one candidate in a ratio is NOT rejected, the winner MUST come from the
non-rejected set. Only rank-among-rejected if all are rejected.

TOTAL = sum of dimensions. Winner = highest total; tie-break on subject_containment,
then subject_prominence. Put numeric "total" on the winner and every other candidate.

PRODUCTS: pick the detections most likely to be real sellable inventory items — not
background noise, incidental people, or duplicates.

SUBJECTS: the one that tells the product story. Null if none clearly primary.

TEXT TREATMENT:
  include  — overlay the text in the final listing (e.g. brand badge)
  exclude  — hide/blur it (noise, watermark, off-topic)
  subject  — the text IS the product (labels, signage, posters)`
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Detection data:\n${JSON.stringify(payload, null, 2)}\n\nJudge this image for e-commerce use.`
          },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ],
    max_tokens: 3000,
    temperature: 0.2
  });

  const raw = response.choices[0].message.content.trim();
  const result = safeParseJSON(raw);

  return {
    products:  result.products  || { winnerIds: [], reasoning: '' },
    subjects:  result.subjects  || { primaryId: null, reasoning: '' },
    text:      result.text      || { treatment: 'include', affectedIds: [], reasoning: '' },
    crop_5_4:  normalizeCropJudgement(result.crop_5_4, crops['5:4']),
    crop_1_1:  normalizeCropJudgement(result.crop_1_1, crops['1:1']),
    crop_4_5:  normalizeCropJudgement(result.crop_4_5, crops['4:5'])
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Extended-ratio judge — 9:16, 1.91:1. Each candidate is a fully-rendered
//  image from a different provider/variant. Scoring is stricter here because
//  AI-generated outputs have specific failure modes (artifacts, subject drift).
// ─────────────────────────────────────────────────────────────────────────────
async function judgeExtendedCrops(extendedCrops) {
  const ratios = Object.keys(extendedCrops).filter(r => extendedCrops[r].length > 0);
  if (ratios.length === 0) return {};

  const imageParts = [];
  const indexLines = [];
  for (const ratio of ratios) {
    for (const c of extendedCrops[ratio]) {
      indexLines.push(`[${ratio}] ${c.id} — ${c.label} (provider=${c.provider}, variant=${c.variant})`);
      imageParts.push({ type: 'image_url', image_url: { url: c.imageUrl } });
    }
  }

  const schemaLines = ratios
    .map(r => `"${r}": { "winnerId": "...", "reasoning": "...", "scores": { "<id>": { "total": 0, "dimensions": {...}, "rejected": null | "reason" }, ... } }`)
    .join(',\n  ');

  const prompt =
    `Below are candidate outputs for extended aspect ratios. Each candidate is identified ` +
    `by id of the form "<ratio>-<variant>-<provider>" (or "<ratio>-blurred" for Cloudinary ` +
    `blurred-pad variants).\n\n` +
    `Candidates (in the same order as the images that follow):\n${indexLines.join('\n')}\n\n` +
    `SCORING RUBRIC — rate every candidate on 5 dimensions (0–10 integers):\n` +
    `  - subject_fidelity      : identity / shape / material preserved vs the source product.\n` +
    `  - artifact_freedom      : no warping, seam lines, repeated textures, garbled text, extra limbs, color shifts.\n` +
    `  - lighting_consistency  : light direction, color temperature, shadows cohere across the frame.\n` +
    `  - background_cohesion   : palette, texture, style match; no awkward transitions or mismatched content.\n` +
    `  - aspect_compliance     : fills the target ratio cleanly — not stretched, squeezed, or letterboxed.\n\n` +
    `HARD-REJECT RULES (set "rejected" to a short reason; still provide low dimension scores):\n` +
    `  - variant="extension" with subject_fidelity < 9    → "extension altered subject"\n` +
    `  - variant="generation" with subject_fidelity < 6   → "generation unrecognizable"\n` +
    `  - any visible seam line, garbled label, or duplicate/ghost subject → "visible artifact"\n` +
    `  - aspect_compliance < 5 (letterboxed/stretched)    → "aspect broken"\n\n` +
    `TOTAL = sum of dimensions. Winner = highest total among NON-rejected candidates for that ratio. ` +
    `Only pick from rejected set if every candidate was rejected; note this in reasoning.\n\n` +
    `Return ONLY JSON matching this exact shape (no prose outside):\n` +
    `{\n  ${schemaLines}\n}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, ...imageParts]
    }],
    max_tokens: 2500,
    temperature: 0.2
  });

  const raw = response.choices[0].message.content.trim();
  const parsed = safeParseJSON(raw);

  const out = {};
  for (const ratio of ratios) {
    out[ratio] = normalizeCropJudgement(parsed[ratio], extendedCrops[ratio]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
function safeParseJSON(raw) {
  // With response_format: json_object, the raw is usually valid JSON. Fall back
  // to regex extraction if somehow wrapped in prose.
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Judge returned no parseable JSON');
  return JSON5.parse(match[0]);
}

// Ensure the judge's ratio-level judgment has a winnerId, reasoning, and a
// complete scores map keyed by candidate id (filling in gaps so the UI never
// crashes on missing entries).
function normalizeCropJudgement(raw, candidates) {
  const list = candidates || [];
  const emptyScore = { total: 0, dimensions: {}, rejected: null };

  const scores = {};
  for (const c of list) {
    const s = raw?.scores?.[c.id];
    if (s) {
      scores[c.id] = {
        total: Number(s.total) || sumDimensions(s.dimensions),
        dimensions: s.dimensions || {},
        rejected: s.rejected || null
      };
    } else {
      scores[c.id] = { ...emptyScore };
    }
  }

  // Winner: prefer judge's pick if it exists in candidates; otherwise highest
  // non-rejected total; otherwise first.
  let winnerId = raw?.winnerId;
  if (!winnerId || !list.find(c => c.id === winnerId)) {
    const ranked = Object.entries(scores)
      .filter(([_, s]) => !s.rejected)
      .sort((a, b) => b[1].total - a[1].total);
    winnerId = ranked[0]?.[0] || list[0]?.id || null;
  }

  return {
    winnerId,
    reasoning: raw?.reasoning || '',
    scores
  };
}

function sumDimensions(dims) {
  if (!dims || typeof dims !== 'object') return 0;
  return Object.values(dims).reduce((a, n) => a + (Number(n) || 0), 0);
}

module.exports = { judgeDetections, judgeExtendedCrops };
