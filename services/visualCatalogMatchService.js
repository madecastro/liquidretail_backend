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

// Kill switch reader for the batch API. Split from the caller so a future
// refactor doesn't drift the two comparison paths' env reads.
function isBatchEnabled() {
  const raw = String(process.env.SKU_VISUAL_MATCH_BATCH_ENABLED || 'true')
    .toLowerCase().trim();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

// Compare ONE crop to N catalog candidate images in a single Gemini call.
// Returns
//   [{ key, isMatch, score, reasoning, matchedAgainst }, …]  same order as input
// or null if the whole batch failed (caller treats as "no visual signal"
// and falls back to text-only matching, same as compareCropToCandidate).
//
// Batching amortises the per-call HTTP overhead + Gemini queue wait —
// measured 2026-09-02 as the single largest per-call time sink in
// productMatchService.compareUgcCropToCatalogProduct's 1.2m-avg product-
// match stage. Serial equivalent: N × ~1-2.5s in a Promise.all with
// max(latency) dominating; batch: 1 × ~2-4s regardless of N.
//
// candidates: array of { key, imageUrl, title? }. `key` is opaque to the
// service and used to correlate the model's answer back to the caller's
// candidate identity — usually the imageUrl itself. `title` is optional
// and shown to the model to disambiguate when multiple SKUs from the same
// product family share visuals.
//
// Kill switch: SKU_VISUAL_MATCH_BATCH_ENABLED=false routes callers back
// to N serial compareCropToCandidate calls (isBatchEnabled() returns
// false — the caller enforces the fallback, this function still batches
// whatever it's given). Structural pin — the switch is read at the
// caller boundary so failed batches can be swapped for serial without a
// service edit.
async function compareCropToCandidatesBatch({ cropImageUrl, candidates, brandId = null, productId = null }) {
  if (!isConfigured() && !process.env.GEMINI_API_KEY) {
    console.warn('   ⚠️  visualCatalogMatch(batch): neither ATLAS_API_KEY nor GEMINI_API_KEY set');
    return null;
  }
  if (!cropImageUrl) return null;
  if (!Array.isArray(candidates) || !candidates.length) return null;

  // Filter out candidates missing an imageUrl; keep the ORIGINAL indices
  // so we can rehydrate a null slot in the result for the caller. This is
  // symmetric with the single-call path returning null on missing input.
  const usable = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c && typeof c.imageUrl === 'string' && c.imageUrl) {
      usable.push({ inputIdx: i, key: c.key ?? c.imageUrl, imageUrl: c.imageUrl, title: c.title || null });
    }
  }
  if (!usable.length) return null;

  const t0 = Date.now();
  // Parallel download — same shape as compareCropToCandidate's crop+candidate
  // fetch, just N-ary. If any single candidate image fails to download it's
  // dropped from the batch payload (caller sees a null at that key rather
  // than a synthetic 0).
  const cropBufPromise = downloadImage(cropImageUrl);
  const candidateBufPromises = usable.map((c) => downloadImage(c.imageUrl));
  const [cropBuf, ...candidateBufs] = await Promise.all([cropBufPromise, ...candidateBufPromises]);
  if (!cropBuf) return null;

  // Compact the usable/buf lists to the subset that successfully
  // downloaded — batching a null buffer would corrupt the prompt.
  const scored = [];
  for (let i = 0; i < usable.length; i++) {
    if (candidateBufs[i]) scored.push({ ...usable[i], buf: candidateBufs[i] });
  }
  if (!scored.length) return null;

  const N = scored.length;
  const titleLines = scored
    .map((c, i) => c.title ? `  Candidate ${i + 1} title: "${c.title}"` : `  Candidate ${i + 1}: (no title)`)
    .join('\n');
  const prompt =
    `You will see one TARGET product crop followed by ${N} CATALOG CANDIDATE image${N === 1 ? '' : 's'}. ` +
    `For EACH candidate, decide whether it shows the SAME specific SKU as the target — same ` +
    `brand line, same color/pattern, same size/cut/style. Variations within the same ` +
    `product family that are clearly different SKUs (e.g. different colorways) should ` +
    `be marked NOT a match.\n\n` +
    // V1 (2026-08-17) — category-class guard. Same reasoning as the single-
    // comparison prompt: without an explicit categorical reject, Gemini
    // returned isMatch:true score:0.95 on a blue-jeans crop vs a sneaker
    // image. The rule applies per candidate.
    `HARD REJECT — before deciding same-SKU, verify each candidate depicts ` +
    `the SAME PRODUCT CLASS as the target. If the target shows one class (e.g. footwear, ` +
    `apparel, bag, headwear, accessory, food/beverage, skincare, makeup, ` +
    `hardware) and a candidate shows a different class, return isMatch=false ` +
    `and score<=0.2 for THAT candidate REGARDLESS of any visual similarity in shape, ` +
    `color, or background. A sneaker is not a pair of jeans; a bag is not a hat; a ` +
    `bottle is not a jar. Only within-class comparisons are eligible for a ` +
    `positive match.\n\n` +
    titleLines + `\n\n` +
    `Return JSON only — no prose:\n` +
    `{\n` +
    `  "results": [\n` +
    `    { "candidate": 1, "isMatch": true | false, "score": 0.0..1.0, "reasoning": "1 sentence" },\n` +
    `    …one entry per candidate, ${N} total, in order…\n` +
    `  ]\n` +
    `}`;

  // Assemble the message content: prompt → target → for each candidate a
  // label + the image. Same {type:'image_url', image_url:{url:'data:…'}} shape
  // the single-comparison path uses (works on Atlas's Gemini routes).
  const content = [
    { type: 'text', text: prompt + '\n\nTARGET:' },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${cropBuf.toString('base64')}` } }
  ];
  scored.forEach((c, i) => {
    content.push({ type: 'text', text: `\nCANDIDATE ${i + 1}:` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${c.buf.toString('base64')}` } });
  });
  content.push({ type: 'text', text: '\nReturn JSON only.' });

  // Response schema — array of length N with tightly-typed fields. Strict
  // json_schema means the parser never sees prose sneaking in around the
  // JSON body. `candidate` is a 1-indexed int so a future reader can
  // cross-check the model didn't skip a slot on batch prompts it was
  // uncomfortable with.
  const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate: { type: 'integer' },
            isMatch:   { type: 'boolean' },
            score:     { type: 'number' },
            reasoning: { type: 'string' }
          },
          required: ['candidate', 'isMatch', 'score', 'reasoning'],
          additionalProperties: false
        }
      }
    },
    required: ['results'],
    additionalProperties: false
  };

  let res;
  try {
    res = await chatCompletion(
      // visionImages count matters for the CostLog — 1 target + N candidates.
      { stage: 'visual_catalog_match_batch', service: 'visualCatalogMatchService', visionImages: 1 + N, brandId, productId },
      {
        model: MODEL,
        messages: [{ role: 'user', content }],
        temperature: 0.1,
        // Bounded per-candidate: 800 tokens per comparison (matches the
        // single-call path's cap) with a modest reserve so N=5 doesn't
        // clip the last entry's reasoning.
        max_tokens: 400 + (400 * N),
        response_format: { type: 'json_schema', json_schema: { name: 'sku_match_batch', strict: true, schema: RESPONSE_SCHEMA } }
      }
    );
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  visualCatalogMatch(batch): failed in ${Date.now() - t0}ms for N=${N}: ${detail}`);
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
  if (!parsed?.results) {
    const preview = text ? text.slice(0, 200).replace(/\s+/g, ' ') : '<empty>';
    console.warn(
      `   ⚠️  visualCatalogMatch(batch): unparseable response in ${Date.now() - t0}ms N=${N} ` +
      `(finishReason=${finishReason || 'none'}, textLen=${text.length}, preview="${preview}")`
    );
    return null;
  }

  // Build the output array in the ORIGINAL candidates-input order — every
  // input index gets a slot (null for candidates dropped due to download
  // failure or a model that skipped its entry). This is what makes the
  // caller's iteration stable regardless of batch drop-outs.
  const out = new Array(candidates.length).fill(null);
  const byCandidateIdx = new Map();
  for (const r of parsed.results) {
    if (!r || typeof r.candidate !== 'number') continue;
    // Model uses 1-indexed candidate numbers — remap to 0-indexed into
    // the `scored` (post-download-filter) list.
    const scoredIdx = r.candidate - 1;
    if (scoredIdx < 0 || scoredIdx >= scored.length) continue;
    byCandidateIdx.set(scoredIdx, r);
  }
  for (let i = 0; i < scored.length; i++) {
    const r = byCandidateIdx.get(i);
    if (!r) continue;
    const s = clampUnit(Number(r.score));
    out[scored[i].inputIdx] = {
      key:            scored[i].key,
      matchedAgainst: scored[i].imageUrl,
      isMatch:        !!r.isMatch,
      score:          s,
      reasoning:      typeof r.reasoning === 'string' ? r.reasoning : ''
    };
  }
  const nonNull = out.filter(Boolean).length;
  console.log(
    `   ✓ visualCatalogMatch(batch): N=${N} → ${nonNull} result(s) in ${Date.now() - t0}ms ` +
    `(bestScore=${Math.max(0, ...out.filter(Boolean).map(r => r.score)).toFixed(2)})`
  );
  return out;
}

module.exports = {
  compareCropToCandidate,
  compareCropToCandidatesBatch,
  isBatchEnabled
};
