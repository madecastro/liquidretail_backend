const OpenAI = require('openai');
const { toFile } = require('openai');
const axios = require('axios');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// gpt-image-1 accepts these sizes only; we map new ratios to the closest
// supported size then post-crop to exact ratio via Cloudinary downstream.
const RATIO_TO_SIZE = {
  '9:16':   '1024x1536',
  '1.91:1': '1536x1024'
};

// Outpainting: send the source image sitting on a transparent canvas shaped to
// the target aspect ratio, with a prompt telling the model to extend the scene.
// We construct the padded canvas via Cloudinary (no local image library needed).
async function extendImage(sourceUrl, targetRatio, subjectDescription) {
  const size = RATIO_TO_SIZE[targetRatio];
  if (!size) throw new Error(`Unsupported ratio ${targetRatio}`);

  const [w, h] = size.split('x').map(Number);
  const paddedUrl = buildPaddedTransparentUrl(sourceUrl, w, h);
  const paddedPng = await fetchBuffer(paddedUrl);

  const prompt =
    `Extend this product photograph outward to fill the full canvas. ` +
    `Keep the existing subject${subjectDescription ? ` (${subjectDescription})` : ''} completely unchanged — same identity, shape, proportion, and position. ` +
    `Naturally extend the existing background, matching lighting, color palette, texture, and style. ` +
    `Do not add new objects. The result should be a seamless wider/taller version of the same scene, suitable for e-commerce listings.`;

  const res = await openai.images.edit({
    model: 'gpt-image-1',
    image: await toFile(paddedPng, 'source.png', { type: 'image/png' }),
    prompt,
    size,
    n: 1
  });
  return base64ToBuffer(res.data[0].b64_json);
}

// Generation: use the source image as reference, ask the model to produce a
// fresh product shot at the target ratio, keeping subject identity but replacing
// background with a new e-commerce-appropriate scene.
async function generateFresh(sourceUrl, targetRatio, subjectDescription) {
  const size = RATIO_TO_SIZE[targetRatio];
  if (!size) throw new Error(`Unsupported ratio ${targetRatio}`);

  const sourcePng = await fetchBuffer(sourceUrl);
  const prompt =
    `Create a new professional e-commerce product photograph at ${targetRatio} aspect ratio. ` +
    `Feature the subject${subjectDescription ? ` (${subjectDescription})` : ''} from the reference image — ` +
    `keep its identity, shape, material, and approximate pose unchanged. ` +
    `Place it against a clean, modern, brand-neutral studio or lifestyle background appropriate for marketing. ` +
    `Use soft, professional lighting. The subject should be the clear focal point.`;

  const res = await openai.images.edit({
    model: 'gpt-image-1',
    image: await toFile(sourcePng, 'source.png', { type: 'image/png' }),
    prompt,
    size,
    n: 1
  });
  return base64ToBuffer(res.data[0].b64_json);
}

// ── Helpers ──
function buildPaddedTransparentUrl(url, w, h) {
  if (!url.includes('/upload/')) return url;
  const base = url.replace(/\.(jpg|jpeg|png|webp)$/i, '.png');
  return base.replace('/upload/', `/upload/c_pad,w_${w},h_${h},b_transparent/`);
}

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(res.data);
}

function base64ToBuffer(b64) { return Buffer.from(b64, 'base64'); }

module.exports = { extendImage, generateFresh };
