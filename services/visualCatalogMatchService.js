// Phase 1.7 — visual catalog match.
//
// Given a refined product crop (Cloudinary URL) and a candidate
// CatalogProduct row (with its imageUrl + title), ask Gemini Vision
// whether they show the SAME specific SKU. Used as the second layer of
// catalog matching after the text scorer (productMatchService.findCatalogMatch)
// has nominated a top candidate.
//
// Combination rule lives in productMatchService:
//     combined = max(textScore, visualScore)
//     combined >= 0.80 → catalog-winner, providers skipped run-scoped
//
// Inputs are URLs (not buffers). The service downloads + base64-encodes
// to satisfy Gemini's inlineData requirement. Both source and candidate
// are usually Cloudinary-hosted (and the source is even a c_crop transform
// — no re-upload needed for the per-product crop).
//
// Failure mode: returns null on any error or missing key. Caller treats
// null as "no visual signal" and falls back to text-only matching.

const axios = require('axios');
// Atlas gateway (Gemini served OpenAI-compatible; Google's OpenAI-compat
// endpoint as the direct fallback inside the transport).
const { chatCompletion, isConfigured } = require('./atlasLlmService');

const MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';

// Compare ONE crop to ONE catalog candidate. Returns
//   { isMatch: bool, score: 0..1, reasoning: string }
// or null if the call failed or inputs were missing.
async function compareCropToCandidate({ cropImageUrl, candidate, brandId = null, productId = null }) {
  if (!isConfigured() && !process.env.GEMINI_API_KEY) {
    console.warn('   ⚠️  visualCatalogMatch: neither ATLAS_API_KEY nor GEMINI_API_KEY set');
    return null;
  }
  if (!cropImageUrl || !candidate?.imageUrl) return null;

  const t0 = Date.now();
  const [cropBuf, candidateBuf] = await Promise.all([
    downloadImage(cropImageUrl),
    downloadImage(candidate.imageUrl)
  ]);
  if (!cropBuf || !candidateBuf) return null;

  const titleLine = candidate.title ? `Candidate title: "${candidate.title}"\n` : '';
  const prompt =
    `You will see a TARGET product crop followed by a CATALOG CANDIDATE image. ` +
    `Decide whether the candidate shows the SAME specific SKU as the target — same ` +
    `brand line, same color/pattern, same size/cut/style. Variations within the same ` +
    `product family that are clearly different SKUs (e.g. different colorways) should ` +
    `be marked NOT a match.\n\n` +
    // V1 (2026-08-17) — category-class guard. Measured live: Gemini
    // returned isMatch:true score:0.95 comparing a blue-jeans crop to
    // an Allbirds sneaker product image. The prompt asked "same SKU?"
    // in isolation, so the model wandered when neither image matched
    // any known SKU. Add an explicit categorical reject.
    `HARD REJECT — before deciding same-SKU, verify the two images depict ` +
    `the SAME PRODUCT CLASS. If the target shows one class (e.g. footwear, ` +
    `apparel, bag, headwear, accessory, food/beverage, skincare, makeup, ` +
    `hardware) and the candidate shows a different class, return isMatch=false ` +
    `and score<=0.2 REGARDLESS of any visual similarity in shape, color, or ` +
    `background. A sneaker is not a pair of jeans; a bag is not a hat; a ` +
    `bottle is not a jar. Only within-class comparisons are eligible for a ` +
    `positive match. Cite the target's class and the candidate's class in ` +
    `your reasoning when they differ.\n\n` +
    titleLine +
    `Return JSON only — no prose:\n` +
    `{\n` +
    `  "isMatch":   true | false,\n` +
    `  "score":     0.0 to 1.0,    // how confident the candidate is the same SKU\n` +
    `  "reasoning": "1 sentence citing visible features that drove the decision"\n` +
    `}`;

  let res;
  try {
    // No thinkingBudget knob on the OpenAI-compat path — Gemini's hidden
    // reasoning spends from max_tokens instead, so the 800-token cap of
    // the raw-API era is raised and the transport adds its own reserve.
    // Schema-enforced output (strict json_schema — probed working on the
    // Atlas gemini routes) keeps the parser belt-and-braces rather than
    // load-bearing.
    res = await chatCompletion(
      { stage: 'visual_catalog_match', service: 'visualCatalogMatchService', visionImages: 2, brandId, productId },
      {
        model: MODEL,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt + '\n\nTARGET:' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${cropBuf.toString('base64')}` } },
          { type: 'text', text: '\nCATALOG CANDIDATE:' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${candidateBuf.toString('base64')}` } },
          { type: 'text', text: '\nReturn JSON only.' }
        ] }],
        temperature: 0.1,
        max_tokens: 800,
        response_format: { type: 'json_schema', json_schema: { name: 'sku_match', strict: true, schema: {
          type: 'object',
          properties: {
            isMatch:   { type: 'boolean' },
            score:     { type: 'number' },
            reasoning: { type: 'string' }
          },
          required: ['isMatch', 'score', 'reasoning'],
          additionalProperties: false
        } } }
      }
    );
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  visualCatalogMatch failed in ${Date.now() - t0}ms: ${detail}`);
    return null;
  }

  const choice = res.choices?.[0];
  const finishReason = choice?.finish_reason || null;
  const text = String(choice?.message?.content || '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed) {
    // Capture enough detail to diagnose without spamming the log.
    // finishReason is the most useful signal — STOP/MAX_TOKENS/SAFETY/
    // RECITATION map to distinct failure modes. text preview helps
    // when the body is non-JSON prose despite responseSchema.
    const preview = text ? text.slice(0, 200).replace(/\s+/g, ' ') : '<empty>';
    const blockReason = res.data?.promptFeedback?.blockReason || null;
    console.warn(
      `   ⚠️  visualCatalogMatch: unparseable response in ${Date.now() - t0}ms ` +
      `(finishReason=${finishReason || 'none'}${blockReason ? `, blockReason=${blockReason}` : ''}, ` +
      `textLen=${text.length}, preview="${preview}")`
    );
    return null;
  }

  const score = clampUnit(Number(parsed.score));
  const result = {
    isMatch:   !!parsed.isMatch,
    score,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : ''
  };
  console.log(`   ✓ visualCatalogMatch: ${result.isMatch ? 'MATCH' : 'no-match'} score=${score.toFixed(2)} (${Date.now() - t0}ms)`);
  return result;
}

async function downloadImage(url) {
  try {
    // Shopify CDN (cdn.shopify.com) returns errors to header-less
    // axios calls — sometimes 403, sometimes empty bodies, sometimes
    // CORS-shaped failures. A real-looking User-Agent + Accept header
    // gets through cleanly. Same shape for any other CDN that's
    // sensitive to bot signatures.
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout:      15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReachSocial/1.0; +https://reachsocial.io)',
        'Accept':     'image/*,*/*;q=0.8'
      }
    });
    return Buffer.from(res.data);
  } catch (err) {
    const status = err.response?.status;
    const reason = status ? `HTTP ${status}` : (err.code || err.message || 'unknown');
    console.warn(`   ⚠️  visualCatalogMatch: failed to download ${url} (${reason})`);
    return null;
  }
}

function clampUnit(n) {
  if (typeof n !== 'number' || !isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

module.exports = { compareCropToCandidate };
