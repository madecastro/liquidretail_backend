const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// Override via GEMINI_IMAGE_MODEL if you want to lock to a specific model name.
// Otherwise we probe ListModels at startup and pick the first image-capable one.
const USER_OVERRIDE = process.env.GEMINI_IMAGE_MODEL;

// Known-good model names tried in order as a secondary fallback after ListModels.
const KNOWN_MODELS = [
  'gemini-2.5-flash-image-preview',
  'gemini-2.5-flash-image',
  'gemini-2.0-flash-exp-image-generation',
  'gemini-2.0-flash-preview-image-generation'
];

// Fingerprint the key so we can tell from logs whether the env var is actually
// arriving (without ever logging the key itself).
const _rawKey = process.env.GEMINI_API_KEY || '';
const _trimmedKey = _rawKey.trim().replace(/^['"]|['"]$/g, ''); // strip accidental quotes/whitespace
if (_rawKey) {
  const fp = _trimmedKey.length > 8
    ? `${_trimmedKey.slice(0, 4)}…${_trimmedKey.slice(-4)}`
    : '<too short>';
  console.log(`🔑 Gemini key: length=${_trimmedKey.length} fingerprint=${fp}${_rawKey !== _trimmedKey ? ' (stripped surrounding quotes/whitespace)' : ''}`);
} else {
  console.log('🔑 Gemini key: NOT SET (GEMINI_API_KEY env var empty)');
}

const genAI = _trimmedKey ? new GoogleGenerativeAI(_trimmedKey) : null;

let cachedWorkingModel = null;
let discoveredCandidates = null; // populated by probe on first use

function isEnabled() { return !!genAI; }

// Discover every model this API key can see (ListModels via REST — the SDK
// doesn't expose this directly). Filter to anything plausibly image-generation
// capable: name mentions image OR it's a gemini-*-flash variant.
async function discoverModels() {
  if (discoveredCandidates !== null) return discoveredCandidates;
  if (!_trimmedKey) { discoveredCandidates = []; return []; }

  try {
    const res = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(_trimmedKey)}`,
      { timeout: 15000 }
    );
    const all = (res.data?.models || []).map(m => ({
      name: (m.name || '').replace(/^models\//, ''),
      methods: m.supportedGenerationMethods || []
    }));

    const supportsGen = m => m.methods.includes('generateContent');
    // Must have "image" or "imagen" in the name to actually output images.
    // Older regex matched any "2.X-flash" which pulled in text-only models
    // like gemini-2.5-flash and caused 400 "only supports text output" errors.
    const nameMatches = n => /(^|-)imag(e|en)(-|$)/i.test(n);

    const imgCapable = all.filter(m => supportsGen(m) && nameMatches(m.name)).map(m => m.name);
    const allGen     = all.filter(supportsGen).map(m => m.name);

    console.log(`🔎 Gemini ListModels: ${all.length} total, ${allGen.length} support generateContent, ${imgCapable.length} look image-capable`);
    if (imgCapable.length) console.log(`   image-capable: ${imgCapable.join(', ')}`);
    if (allGen.length && !imgCapable.length) console.log(`   (none matched image-name regex — all generate-capable: ${allGen.join(', ')})`);

    discoveredCandidates = imgCapable;
    return discoveredCandidates;
  } catch (err) {
    console.warn('⚠️  Gemini ListModels failed:', err.response?.data || err.message);
    discoveredCandidates = [];
    return [];
  }
}

// Build the ordered list of model names to try for this call.
async function candidateModels() {
  const ordered = [];
  if (USER_OVERRIDE) ordered.push(USER_OVERRIDE);
  if (cachedWorkingModel && !ordered.includes(cachedWorkingModel)) ordered.push(cachedWorkingModel);

  const discovered = await discoverModels();
  for (const n of discovered) if (!ordered.includes(n)) ordered.push(n);
  for (const n of KNOWN_MODELS) if (!ordered.includes(n)) ordered.push(n);

  return ordered;
}

async function extendImage(sourceUrl, baseCrop, targetRatio, subjectDescription) {
  if (!genAI) throw new Error('GEMINI_API_KEY not set');
  const cropUrl = buildCropUrl(sourceUrl, baseCrop);

  const prompt =
    `Extend this product photograph naturally to a ${targetRatio} aspect ratio canvas. ` +
    `Preserve the subject${subjectDescription ? ` (${subjectDescription})` : ''} exactly — same identity, shape, proportion, and position. ` +
    `Extend the existing background outward, matching lighting, color palette, texture, and style. ` +
    `Do not introduce new objects. Output a single image at ${targetRatio} aspect ratio.`;

  return Buffer.from(await runImageGen(prompt, cropUrl), 'base64');
}

async function generateFresh(sourceUrl, baseCrop, targetRatio, subjectDescription) {
  if (!genAI) throw new Error('GEMINI_API_KEY not set');
  const cropUrl = buildCropUrl(sourceUrl, baseCrop);

  const prompt =
    `Create a new professional e-commerce product photograph at ${targetRatio} aspect ratio. ` +
    `Use the subject${subjectDescription ? ` (${subjectDescription})` : ''} from the reference image — ` +
    `preserve its identity, shape, material, and approximate pose. Replace the background with a clean, ` +
    `modern, brand-neutral studio or lifestyle scene appropriate for marketing. ` +
    `Use soft professional lighting with the subject as the clear focal point. ` +
    `Output a single image at ${targetRatio} aspect ratio.`;

  return Buffer.from(await runImageGen(prompt, cropUrl), 'base64');
}

async function runImageGen(prompt, sourceUrl) {
  const sourceBuffer = await fetchBuffer(sourceUrl);
  const sourceBase64 = sourceBuffer.toString('base64');
  const candidates = await candidateModels();

  if (!candidates.length) {
    throw new Error('No Gemini models available for this API key. Check Gemini API access in your Google Cloud project.');
  }

  let lastErr = null;
  for (const modelName of candidates) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
      });
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: 'image/png', data: sourceBase64 } }
      ]);
      const parts = result?.response?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          if (cachedWorkingModel !== modelName) {
            cachedWorkingModel = modelName;
            console.log(`✅ Gemini cached working model: ${modelName}`);
          }
          return part.inlineData.data;
        }
      }
      lastErr = new Error(`${modelName}: no image data in response (text-only model)`);
    } catch (err) {
      lastErr = err;
      // Keep trying next candidate on: 404, unknown method, text-only (wrong modality),
      // unsupported arguments. Stop on auth/quota so we don't hammer the API.
      const msg = err.message || '';
      const skippable = /404|not found|not supported|only supports text|modalit|unsupported/i;
      if (!skippable.test(msg)) break;
    }
  }
  throw lastErr || new Error('Gemini image generation failed (no model succeeded)');
}

function buildCropUrl(sourceUrl, baseCrop) {
  if (!sourceUrl || !sourceUrl.includes('/upload/')) return sourceUrl;
  const cw = Math.max(1, baseCrop.x2 - baseCrop.x1);
  const ch = Math.max(1, baseCrop.y2 - baseCrop.y1);
  const crop = `c_crop,w_${cw},h_${ch},x_${baseCrop.x1},y_${baseCrop.y1}`;
  if (/\/v\d+\//.test(sourceUrl)) return sourceUrl.replace(/\/(v\d+\/)/, `/${crop}/$1`);
  return sourceUrl.replace('/upload/', `/upload/${crop}/`);
}

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(res.data);
}

// Probe once at module load so the Render log tells us what's available.
if (genAI) discoverModels();

module.exports = { extendImage, generateFresh, isEnabled, discoverModels };
