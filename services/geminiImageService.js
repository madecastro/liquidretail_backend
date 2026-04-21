const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// Image-gen model naming has churned. We try an ordered list until one works,
// then cache the winner for the rest of the process.
const MODEL_FALLBACKS = [
  process.env.GEMINI_IMAGE_MODEL,                          // user override, if set
  'gemini-2.5-flash-image-preview',
  'gemini-2.0-flash-exp-image-generation',
  'gemini-2.0-flash-preview-image-generation'
].filter(Boolean);

let cachedWorkingModel = null;

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

function isEnabled() { return !!genAI; }

// List all models the API key can see. Useful for debugging 404s —
// run on first failure so the Render logs show the actual available names.
async function listAvailableImageModels() {
  try {
    const res = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`,
      { timeout: 15000 }
    );
    const all = res.data?.models || [];
    return all.filter(m =>
      (m.supportedGenerationMethods || []).includes('generateContent') &&
      /(image|vision|imagen|2\.\d-flash)/i.test(m.name)
    ).map(m => m.name.replace(/^models\//, ''));
  } catch (err) {
    console.warn('ListModels probe failed:', err.message);
    return [];
  }
}

async function extendImage(sourceUrl, baseCrop, targetRatio, subjectDescription) {
  if (!genAI) throw new Error('GEMINI_API_KEY not set');
  const cropUrl = buildCropUrl(sourceUrl, baseCrop);

  const prompt =
    `Extend this product photograph naturally to a ${targetRatio} aspect ratio canvas. ` +
    `Preserve the subject${subjectDescription ? ` (${subjectDescription})` : ''} exactly — same identity, shape, proportion, and position. ` +
    `Extend the existing background outward, matching lighting, color palette, texture, and style. ` +
    `Do not introduce new objects. Output a single image at ${targetRatio} aspect ratio.`;

  const base64 = await runImageGen(prompt, cropUrl);
  return Buffer.from(base64, 'base64');
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

  const base64 = await runImageGen(prompt, cropUrl);
  return Buffer.from(base64, 'base64');
}

function buildCropUrl(sourceUrl, baseCrop) {
  if (!sourceUrl || !sourceUrl.includes('/upload/')) return sourceUrl;
  const cw = Math.max(1, baseCrop.x2 - baseCrop.x1);
  const ch = Math.max(1, baseCrop.y2 - baseCrop.y1);
  const crop = `c_crop,w_${cw},h_${ch},x_${baseCrop.x1},y_${baseCrop.y1}`;
  if (/\/v\d+\//.test(sourceUrl)) return sourceUrl.replace(/\/(v\d+\/)/, `/${crop}/$1`);
  return sourceUrl.replace('/upload/', `/upload/${crop}/`);
}

async function runImageGen(prompt, sourceUrl) {
  const sourceBuffer = await fetchBuffer(sourceUrl);
  const sourceBase64 = sourceBuffer.toString('base64');

  // If we already know a working model, try it first.
  const candidates = cachedWorkingModel
    ? [cachedWorkingModel, ...MODEL_FALLBACKS.filter(m => m !== cachedWorkingModel)]
    : [...MODEL_FALLBACKS];

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
            console.log(`✅ Gemini image model: ${modelName} (cached)`);
          }
          return part.inlineData.data;
        }
      }
      lastErr = new Error(`${modelName}: no image data in response`);
    } catch (err) {
      lastErr = err;
      // 404 = wrong name → try next. Anything else (403/429/etc.) → surface immediately.
      if (!/404/.test(err.message)) break;
    }
  }

  // On complete failure, probe ListModels once so the Render logs show available model names
  if (!cachedWorkingModel) {
    const available = await listAvailableImageModels();
    if (available.length) {
      console.warn(`ℹ️   Available image-capable Gemini models for this key: ${available.join(', ')}`);
      console.warn(`     Set GEMINI_IMAGE_MODEL=<name> to use one.`);
    } else {
      console.warn(`ℹ️   No image-capable Gemini models returned by ListModels for this key.`);
    }
  }

  throw lastErr || new Error('Gemini image generation failed (no model succeeded)');
}

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(res.data);
}

module.exports = { extendImage, generateFresh, isEnabled };
