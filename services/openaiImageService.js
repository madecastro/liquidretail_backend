const OpenAI = require('openai');
const { toFile } = require('openai');
const axios = require('axios');
const sharp = require('sharp');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// gpt-image-1 supports 1024x1024, 1024x1536, 1536x1024 only.
const RATIO_TO_SIZE = {
  '9:16':   '1024x1536',
  '1.91:1': '1536x1024'
};

// Outpainting: source image centered on a transparent-padded canvas, PLUS an
// explicit mask where the source region is opaque and the padding is transparent.
// gpt-image-1 repaints ONLY the mask's transparent areas, preserving the source
// byte-for-byte. Without a mask it frequently regenerates the whole scene.
async function extendImage(sourceUrl, baseCrop, targetRatio, subjectDescription) {
  const size = RATIO_TO_SIZE[targetRatio];
  if (!size) throw new Error(`Unsupported ratio ${targetRatio}`);
  const [canvasW, canvasH] = size.split('x').map(Number);

  // Source crop dimensions in original image pixels
  const sourceW = Math.max(1, baseCrop.x2 - baseCrop.x1);
  const sourceH = Math.max(1, baseCrop.y2 - baseCrop.y1);
  // Cloudinary c_pad fits the source inside the canvas preserving aspect ratio.
  const scale = Math.min(canvasW / sourceW, canvasH / sourceH);
  const placedW = Math.round(sourceW * scale);
  const placedH = Math.round(sourceH * scale);
  const placedX = Math.floor((canvasW - placedW) / 2);
  const placedY = Math.floor((canvasH - placedH) / 2);

  const paddedUrl = buildCropAndPadUrl(sourceUrl, baseCrop, canvasW, canvasH);
  const paddedPng = await fetchBuffer(paddedUrl);
  const maskPng   = await buildOutpaintMask(placedX, placedY, placedW, placedH, canvasW, canvasH);

  const prompt =
    `Outpaint this image. The central opaque region contains a product photograph that you MUST preserve byte-for-byte — do not modify, redraw, or regenerate any of its pixels. Generate new content ONLY in the transparent padded regions. Extend the existing background naturally from the edges of the preserved region: match lighting direction, color palette, perspective, and surface texture. Do not add new objects. The output should feel like a seamlessly wider/taller version of the same photograph.` +
    (subjectDescription ? ` The preserved subject is: ${subjectDescription}.` : '');

  const res = await openai.images.edit({
    model: 'gpt-image-1',
    image: await toFile(paddedPng, 'source.png', { type: 'image/png' }),
    mask:  await toFile(maskPng,   'mask.png',   { type: 'image/png' }),
    prompt,
    size,
    n: 1
  });
  return base64ToBuffer(res.data[0].b64_json);
}

// Fresh generation: take the source crop, regenerate the background around the
// subject at the new aspect ratio. No mask — model has latitude to change bg.
async function generateFresh(sourceUrl, baseCrop, targetRatio, subjectDescription) {
  const size = RATIO_TO_SIZE[targetRatio];
  if (!size) throw new Error(`Unsupported ratio ${targetRatio}`);

  const cropUrl = buildCropUrl(sourceUrl, baseCrop);
  const sourcePng = await fetchBuffer(cropUrl);

  const prompt =
    `Create a new professional e-commerce product photograph at ${targetRatio} aspect ratio. ` +
    `Feature the subject${subjectDescription ? ` (${subjectDescription})` : ''} from the reference image — ` +
    `preserve its identity, shape, material, and approximate pose. ` +
    `Place it against a clean, modern, brand-neutral studio or lifestyle scene appropriate for marketing. ` +
    `Use soft professional lighting. The subject must be the clear focal point.`;

  const res = await openai.images.edit({
    model: 'gpt-image-1',
    image: await toFile(sourcePng, 'source.png', { type: 'image/png' }),
    prompt,
    size,
    n: 1
  });
  return base64ToBuffer(res.data[0].b64_json);
}

// ── Cloudinary URL builders ──

// Build a URL that first crops the source to the base rect, then pads with
// transparent pixels to the target canvas. Transforms are applied left-to-right
// so order is CRITICAL. Inserting before /v<num>/ puts them in the right spot.
function buildCropAndPadUrl(sourceUrl, baseCrop, canvasW, canvasH) {
  if (!sourceUrl || !sourceUrl.includes('/upload/')) return sourceUrl;
  const cw = Math.max(1, baseCrop.x2 - baseCrop.x1);
  const ch = Math.max(1, baseCrop.y2 - baseCrop.y1);
  const crop = `c_crop,w_${cw},h_${ch},x_${baseCrop.x1},y_${baseCrop.y1}`;
  const pad  = `c_pad,w_${canvasW},h_${canvasH},b_transparent`;
  let url = sourceUrl.replace(/\.(jpg|jpeg|webp)(\?|$)/i, '.png$2');
  if (!/\.png(\?|$)/i.test(url)) url += '.png';
  // Insert crop+pad as two sequential transforms before /v<num>/
  if (/\/v\d+\//.test(url)) {
    return url.replace(/\/(v\d+\/)/, `/${crop}/${pad}/$1`);
  }
  return url.replace('/upload/', `/upload/${crop}/${pad}/`);
}

function buildCropUrl(sourceUrl, baseCrop) {
  if (!sourceUrl || !sourceUrl.includes('/upload/')) return sourceUrl;
  const cw = Math.max(1, baseCrop.x2 - baseCrop.x1);
  const ch = Math.max(1, baseCrop.y2 - baseCrop.y1);
  const crop = `c_crop,w_${cw},h_${ch},x_${baseCrop.x1},y_${baseCrop.y1}`;
  if (/\/v\d+\//.test(sourceUrl)) return sourceUrl.replace(/\/(v\d+\/)/, `/${crop}/$1`);
  return sourceUrl.replace('/upload/', `/upload/${crop}/`);
}

// ── Mask helpers ──
// Build a PNG mask sized canvasW × canvasH where the placed source region is
// OPAQUE (black) and the padded regions are TRANSPARENT. gpt-image-1 repaints
// only the transparent regions, preserving the opaque source exactly.
async function buildOutpaintMask(x, y, w, h, canvasW, canvasH) {
  const overlay = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
  }).png().toBuffer();
  return await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: overlay, top: y, left: x }])
    .png()
    .toBuffer();
}

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(res.data);
}

function base64ToBuffer(b64) { return Buffer.from(b64, 'base64'); }

module.exports = { extendImage, generateFresh };
