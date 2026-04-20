const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');

const GEMINI_MODEL = 'gemini-2.5-flash-image-preview';
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

function isEnabled() { return !!ai; }

async function extendImage(sourceUrl, targetRatio, subjectDescription) {
  if (!ai) throw new Error('GEMINI_API_KEY not set');

  const prompt =
    `Extend this product photograph naturally to a ${targetRatio} aspect ratio canvas. ` +
    `Preserve the subject${subjectDescription ? ` (${subjectDescription})` : ''} exactly — same identity, shape, proportion, and position. ` +
    `Extend the existing background outward, matching lighting, color palette, texture, and style. ` +
    `Do not introduce new objects. Output a single image at ${targetRatio} aspect ratio.`;

  const base64 = await runImageGen(prompt, sourceUrl);
  return Buffer.from(base64, 'base64');
}

async function generateFresh(sourceUrl, targetRatio, subjectDescription) {
  if (!ai) throw new Error('GEMINI_API_KEY not set');

  const prompt =
    `Create a new professional e-commerce product photograph at ${targetRatio} aspect ratio. ` +
    `Use the subject${subjectDescription ? ` (${subjectDescription})` : ''} from the reference image — ` +
    `preserve its identity, shape, material, and approximate pose. Replace the background with a clean, ` +
    `modern, brand-neutral studio or lifestyle scene appropriate for marketing. ` +
    `Use soft professional lighting with the subject as the clear focal point. ` +
    `Output a single image at ${targetRatio} aspect ratio.`;

  const base64 = await runImageGen(prompt, sourceUrl);
  return Buffer.from(base64, 'base64');
}

async function runImageGen(prompt, sourceUrl) {
  const sourceBuffer = await fetchBuffer(sourceUrl);
  const sourceBase64 = sourceBuffer.toString('base64');

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'image/png', data: sourceBase64 } }
      ]
    }]
  });

  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) return part.inlineData.data;
  }
  throw new Error('Gemini returned no image data');
}

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(res.data);
}

module.exports = { extendImage, generateFresh, isEnabled };
