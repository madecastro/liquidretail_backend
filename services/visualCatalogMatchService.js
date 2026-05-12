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

const MODEL    = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Compare ONE crop to ONE catalog candidate. Returns
//   { isMatch: bool, score: 0..1, reasoning: string }
// or null if the call failed or inputs were missing.
async function compareCropToCandidate({ cropImageUrl, candidate }) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('   ⚠️  visualCatalogMatch: GEMINI_API_KEY not set');
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
    titleLine +
    `Return JSON only — no prose:\n` +
    `{\n` +
    `  "isMatch":   true | false,\n` +
    `  "score":     0.0 to 1.0,    // how confident the candidate is the same SKU\n` +
    `  "reasoning": "1 sentence citing visible features that drove the decision"\n` +
    `}`;

  let res;
  try {
    res = await axios.post(
      `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt + '\n\nTARGET:' },
            { inlineData: { mimeType: 'image/jpeg', data: cropBuf.toString('base64') } },
            { text: '\nCATALOG CANDIDATE:' },
            { inlineData: { mimeType: 'image/jpeg', data: candidateBuf.toString('base64') } },
            { text: '\nReturn JSON only.' }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          // Bumped from 400 — verbose reasoning was occasionally
          // truncating the JSON mid-string and hitting the
          // unparseable-response branch. Reasoning is one sentence
          // by prompt, so 800 is comfortable headroom.
          maxOutputTokens: 800,
          responseMimeType: 'application/json',
          // Schema-enforced output. Without this, Gemini sometimes
          // returns prose with embedded JSON, malformed JSON missing
          // a closing brace, or fields wrapped in markdown — all of
          // which surfaced as "unparseable response" warnings.
          // responseSchema forces a structurally valid JSON match
          // for our exact field set; the parser below becomes
          // belt-and-braces rather than load-bearing.
          responseSchema: {
            type: 'object',
            properties: {
              isMatch:   { type: 'boolean' },
              score:     { type: 'number' },
              reasoning: { type: 'string' }
            },
            required: ['isMatch', 'score', 'reasoning']
          }
        }
      },
      { timeout: 30000 }
    );
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`   ⚠️  visualCatalogMatch failed in ${Date.now() - t0}ms: ${detail}`);
    return null;
  }

  const respCandidate = res.data?.candidates?.[0];
  const finishReason = respCandidate?.finishReason || null;
  const text = (respCandidate?.content?.parts || [])
    .map(p => p.text || '').join('').trim();
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
