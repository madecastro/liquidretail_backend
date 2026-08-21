const JSON5 = require('json5');
// Atlas gateway transport (direct-OpenAI fallback inside) — request and
// response shapes are unchanged OpenAI chat.completions.
const { chatCompletion } = require('./atlasLlmService');

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

  const response = await chatCompletion({ stage: 'judge_detections', service: 'judgeService', visionImages: 1 }, {
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
//  AI-generated outputs have specific failure modes (artifacts, subject drift,
//  and — most commercially dangerous — garbled labels and logos).
//
//  Call signature accepts either the old shape (extendedCrops map) for back-
//  compat, or the new shape ({candidates, sourceImageUrl, text, primarySubject})
//  which gives the judge the reference material it needs to actually evaluate
//  label/logo fidelity.
//
//  TODO — in priority order:
//    1. Defects-list pass. Make the judge enumerate per-candidate observed
//       defects vs the source (garbled chars in "<text>", logo shape changed,
//       size/volume marking missing, etc.) BEFORE scoring. Forces detection
//       of subtle mutations a holistic score glosses over.
//    2. Cross-provider judge. Run Gemini 2.5 Pro as a second judge in parallel;
//       only declare a winner when both models agree. On disagreement, fall
//       back to the label_logo_fidelity leader. Costs one extra API call per
//       job but eliminates self-preference structurally.
//    3. OCR verification of source text. We already detect text on the source
//       (`text` param). Run OCR on each candidate, exact-match each source
//       token; any missing token auto-rejects that candidate. Objective, and
//       catches cases the VLM is "seeing" but misremembering.
// ─────────────────────────────────────────────────────────────────────────────
async function judgeExtendedCrops(arg) {
  const extendedCrops = arg?.candidates || arg;
  const sourceImageUrl = arg?.sourceImageUrl || null;
  const detectedText = Array.isArray(arg?.text) ? arg.text : [];
  const primarySubject = arg?.primarySubject || null;

  const ratios = Object.keys(extendedCrops).filter(r => extendedCrops[r].length > 0);
  if (ratios.length === 0) return {};

  // Build reference material the judge needs to evaluate label/logo fidelity
  const textStrings = detectedText
    .filter(t => t.content && t.confidence > 0.5)
    .slice(0, 20)
    .map(t => `"${t.content}" (${t.type || 'text'})`)
    .join(', ');
  const referenceBlock = [];
  if (sourceImageUrl) referenceBlock.push('The FIRST image below is the SOURCE (ground truth for labels, logos, subject identity).');
  if (primarySubject) referenceBlock.push(`Primary subject: ${primarySubject}.`);
  if (textStrings) referenceBlock.push(`Text/labels visible on the source that MUST be preserved exactly in candidates: ${textStrings}.`);

  // Blind the judge to provider identity. GPT-4.1 judging gpt-image-1 vs Gemini
  // shows strong self-preference — every winner came out OpenAI-made even when
  // Gemini preserved labels better. We present candidates with neutral slot
  // letters in a shuffled order per ratio and map back to real ids afterward.
  // Variant (extension/generation) IS still exposed because per-variant
  // rejection rules depend on it.
  const slotPlans = {}; // ratio -> [{ slot, candidate }]
  for (const ratio of ratios) {
    const shuffled = extendedCrops[ratio].slice().sort(() => Math.random() - 0.5);
    slotPlans[ratio] = shuffled.map((c, i) => ({ slot: SLOT_LETTERS[i], candidate: c }));
  }

  // Build image list: source first (if available), then candidates in slot order per ratio.
  const imageParts = [];
  const indexLines = [];
  if (sourceImageUrl) {
    imageParts.push({ type: 'image_url', image_url: { url: sourceImageUrl } });
  }
  for (const ratio of ratios) {
    for (const { slot, candidate: c } of slotPlans[ratio]) {
      indexLines.push(`[${ratio}] slot ${slot} — variant=${c.variant}`);
      imageParts.push({ type: 'image_url', image_url: { url: c.imageUrl } });
    }
  }

  const schemaLines = ratios
    .map(r => `"${r}": { "winnerSlot": "A", "reasoning": "...", "scores": { "A": { "dimensions": {...}, "rejected": null | "reason" }, ... } }`)
    .join(',\n  ');

  const prompt =
    (referenceBlock.length ? referenceBlock.join('\n') + '\n\n' : '') +
    `Candidates (in the same order as the images that follow the source reference):\n${indexLines.join('\n')}\n\n` +
    `SCORING RUBRIC — rate every candidate on 6 dimensions (0–10 integers). ` +
    `Each dimension has a WEIGHT. Final score = Σ(dimension × weight), max ${EXTENDED_MAX_TOTAL}. ` +
    `LABEL/LOGO FIDELITY and SUBJECT FIDELITY are the commercial dealbreakers and are weighted 3× each — ` +
    `a candidate that LOOKS prettier but mangles labels or mutates the subject must lose.\n\n` +
    `  - label_logo_fidelity  (×3): every label, brand mark, product name, size/volume, and logo on the source must appear in the candidate UNCHANGED — identical text spelling, identical typography, correct logo shape and proportion. Garbled letters, swapped characters, warped logos, misaligned brand marks, or missing labels are FATAL.\n` +
    `  - subject_fidelity     (×3): overall identity / shape / material of the product preserved vs the source.\n` +
    `  - artifact_freedom     (×2): no warping, seam lines, repeated textures, extra limbs, color shifts.\n` +
    `  - lighting_consistency (×1): light direction, color temperature, shadows cohere across the frame.\n` +
    `  - background_cohesion  (×1): palette, texture, style match; no awkward transitions or mismatched content.\n` +
    `  - aspect_compliance    (×1): fills the target ratio cleanly — not stretched, squeezed, or letterboxed.\n\n` +
    `HARD-REJECT RULES (set "rejected" to a short reason; still provide dimension scores):\n` +
    `  - label_logo_fidelity < 9 when the source has any labels/logos   → "label/logo degraded"\n` +
    `  - variant="extension"  with subject_fidelity < 9                 → "extension altered subject"\n` +
    `  - variant="generation" with subject_fidelity < 8                 → "generation unrecognizable"\n` +
    `  - artifact_freedom < 7                                           → "visible artifact"\n` +
    `  - aspect_compliance < 5 (letterboxed/stretched)                  → "aspect broken"\n\n` +
    `Winner = highest weighted total among NON-rejected candidates. If every candidate is rejected, pick the least-bad one and say so in reasoning.\n` +
    `Tie-breaker priority: label_logo_fidelity > subject_fidelity > artifact_freedom > others.\n\n` +
    `Return ONLY JSON matching this exact shape (no prose outside). Use slot letters as keys — do NOT reference provider names:\n` +
    `{\n  ${schemaLines}\n}`;

  // OpenAI's vision endpoint occasionally 400s with "Timeout while
  // downloading <cloudinary-url>" right after we've uploaded the
  // candidate images — Cloudinary CDN edge propagation hasn't caught
  // up by the time OpenAI's fetcher hits it. Retry once after a
  // brief delay; the URL is almost always live by then.
  const response = await callOpenAIWithCloudinaryRetry({
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

  // Remap slot-keyed judgement back to real-candidate-id keyed judgement.
  const out = {};
  for (const ratio of ratios) {
    const plan = slotPlans[ratio];
    const ratioRaw = parsed[ratio] || {};
    const rekeyedScores = {};
    for (const { slot, candidate: c } of plan) {
      if (ratioRaw.scores?.[slot]) rekeyedScores[c.id] = ratioRaw.scores[slot];
    }
    const winnerId = plan.find(p => p.slot === ratioRaw.winnerSlot)?.candidate?.id;
    out[ratio] = normalizeCropJudgement(
      { winnerId, reasoning: ratioRaw.reasoning, scores: rekeyedScores },
      extendedCrops[ratio],
      weightedTotalExtended
    );
  }
  return out;
}

// Extended-ratio dimension weights. Label/logo fidelity and subject fidelity
// are the commercial dealbreakers (3× each); artifact freedom is 2×; aesthetic
// dimensions are 1×. Max total = (3+3+2+1+1+1) × 10 = 110.
const EXTENDED_WEIGHTS = {
  label_logo_fidelity:  3,
  subject_fidelity:     3,
  artifact_freedom:     2,
  lighting_consistency: 1,
  background_cohesion:  1,
  aspect_compliance:    1
};
const EXTENDED_MAX_TOTAL = 110;
const SLOT_LETTERS = 'ABCDEFGHIJKL';

function weightedTotalExtended(dims) {
  if (!dims || typeof dims !== 'object') return 0;
  let sum = 0;
  for (const [k, w] of Object.entries(EXTENDED_WEIGHTS)) {
    sum += (Number(dims[k]) || 0) * w;
  }
  return sum;
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
// crashes on missing entries). `totalFn` lets the extended rubric inject a
// weighted total; base ratios fall back to a plain dimension sum.
function normalizeCropJudgement(raw, candidates, totalFn) {
  const list = candidates || [];
  const computeTotal = totalFn || sumDimensions;
  const emptyScore = { total: 0, dimensions: {}, rejected: null };

  const scores = {};
  for (const c of list) {
    const s = raw?.scores?.[c.id];
    if (s) {
      scores[c.id] = {
        total: computeTotal(s.dimensions || {}),
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

// Retry helper for the judge-extended OpenAI call. Cloudinary CDN
// edge propagation on transformed URLs can take 3–5s under load —
// OpenAI's vision fetcher hits the URL before it's live and 400s
// with "Timeout while downloading". Two retries with growing
// backoff (1.5s, 4s) covers the slowest propagation we've observed
// without holding the run hostage.
async function callOpenAIWithCloudinaryRetry(payload) {
  const delays = [1500, 4000];   // ms before each retry
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await chatCompletion({ stage: 'judge_extended_crops', service: 'judgeService', visionImages: 1 }, payload);
    } catch (err) {
      lastErr = err;
      const isCloudinaryRace =
        err?.status === 400 &&
        /Timeout while downloading/i.test(err?.message || '');
      if (!isCloudinaryRace) throw err;
      if (attempt === delays.length) break;   // out of retries
      console.log(`   ↻ judge-extended retry ${attempt + 1}/${delays.length} after Cloudinary CDN race`);
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
  throw lastErr;
}

module.exports = { judgeDetections, judgeExtendedCrops };
