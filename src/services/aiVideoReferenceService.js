// Vertex AI Veo 3 video generation for Reels ads, authenticated via
// GEMINI_API_KEY (same key used by the rest of the Gemini pipeline).
//
// Two tracks, both use image-to-video mode:
//   Track 1 (video seed): derives a first-frame JPEG from the source
//     video via Cloudinary so_0 transform and uses it as the reference.
//   Track 2 (image seed): crops the source image to the target aspect
//     via Cloudinary c_fill and uses it as the reference directly.
//
// Flow: submit predictLongRunning → poll operation → decode base64 video
//   → upload to Cloudinary → return videoUrl.
//
// Gated by AI_VEO_REELS=true. Off by default.

const axios = require('axios');

const Media                     = require('../models/Media');
const Brand                     = require('../models/Brand');
const CatalogProduct            = require('../models/CatalogProduct');
const LayoutInputArtifact       = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { buildVeoPrompt, resolveSubject, aspectRatioForPlatformFormat } = require('./veoPromptBuilder');
const { generateStoryboard } = require('./veoStoryboardService');

const MODEL_ID      = process.env.VEO_MODEL_ID       || 'veo-3.1-generate-preview';
const POLL_INTERVAL = parseInt(process.env.VEO_POLL_INTERVAL_MS, 10) || 15000;
const MAX_POLL_MS   = parseInt(process.env.VEO_TIMEOUT_MS, 10)       || 600000; // 10 min

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function enabled() {
  return String(process.env.AI_VEO_REELS || '').toLowerCase() === 'true';
}

function apiKey() {
  return process.env.GEMINI_API_KEY || '';
}

(async function logConfig() {
  console.log(
    `🎬 aiVideoReferenceService config — ` +
    `enabled=${enabled()} ` +
    `model=${MODEL_ID} ` +
    `keyPresent=${!!apiKey()}`
  );
  if (!apiKey()) return;
  try {
    const res = await axios.get(
      `${API_BASE}/models?key=${apiKey()}`,
      { timeout: 10000 }
    );
    const veoModels = (res.data?.models || [])
      .filter(m => m.name?.toLowerCase().includes('veo'))
      .map(m => `${m.name} [${(m.supportedGenerationMethods || []).join(',')}]`);
    console.log(`🎬 veo models available: ${veoModels.length ? veoModels.join(' | ') : 'none'}`);
  } catch (err) {
    console.warn(`🎬 veo model list unavailable: ${err.message}`);
  }
})();

// ── Reference image derivation ─────────────────────────────────────────

// Track 1: first-frame JPEG from a Cloudinary video URL.
function deriveFirstFrameUrl(videoUrl, aspectRatio) {
  if (!videoUrl?.includes('/video/upload/')) return null;
  const arParam =
    aspectRatio === '9:16'   ? 'ar_9:16'    :
    aspectRatio === '16:9'   ? 'ar_16:9'    :
    aspectRatio === '4:5'    ? 'ar_4:5'     :
    aspectRatio === '1.91:1' ? 'ar_191:100' :
                               'ar_1:1';
  return videoUrl
    .replace('/video/upload/', `/video/upload/so_0,c_fill,${arParam},w_1024,f_jpg,q_auto:good/`)
    .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
}

// Track 2: aspect-cropped image from a Cloudinary image URL.
// FLAG: b_rgb only bakes the background when Cloudinary flattens to a
// non-alpha output (or pads). f_jpg forces that flatten so b_rgb actually
// applies; URL extension can stay as-is (f_jpg wins). Order is
// flatten-then-resize (b_rgb before c_fill) to avoid edge halos / baked-in
// black. brandOrHex: Brand-like object or raw color; defaults to white.
function deriveAspectCroppedImageUrl(imageUrl, aspectRatio, brandOrHex = null) {
  if (!imageUrl?.includes('/image/upload/')) return imageUrl;
  const { websiteBackgroundHex } = require('../utils/websiteBackground');
  const bg = websiteBackgroundHex(brandOrHex);
  const arParam =
    aspectRatio === '9:16' ? 'ar_9:16' :
    aspectRatio === '16:9' ? 'ar_16:9' :
    aspectRatio === '4:5'  ? 'ar_4:5'  :
                             'ar_1:1';
  return imageUrl.replace(
    '/image/upload/',
    `/image/upload/b_rgb:${bg},c_fill,${arParam},w_1024,f_jpg,q_auto:good/`
  );
}

// Fetches a URL and returns { base64, mimeType, bytes }. Validates that
// the response is a recognized image content-type — Cloudinary transforms
// can quietly return an HTML error page for malformed transform strings
// or expired assets, and Veo will silently 400 on the resulting "JPEG"
// because the bytes aren't an image. Throws a descriptive error so the
// caller log shows the actual fetch problem instead of a generic
// "Unsupported video generation request" downstream.
async function fetchAsImage(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const ct  = String(res.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('image/')) {
    const preview = Buffer.from(res.data).slice(0, 80).toString('utf8').replace(/\s+/g, ' ');
    throw new Error(`fetchAsImage(${url}): unexpected content-type "${ct}" (preview: "${preview}")`);
  }
  return {
    base64:   Buffer.from(res.data).toString('base64'),
    mimeType: ct.split(';')[0].trim(),
    bytes:    res.data.byteLength || res.data.length
  };
}

// Back-compat alias for older call sites that only need the base64 string.
async function fetchAsBase64(url) {
  return (await fetchAsImage(url)).base64;
}

// ── Gemini API calls ───────────────────────────────────────────────────

// Veo 3.1's referenceImages parameter holds asset appearance steady through
// motion — BUT the preview API rejects the combination of an image seed +
// referenceImages with "Unsupported video generation request" (same pattern
// as enhancePrompt / durationSeconds when they weren't accepted). Image-to-
// video and ingredients-to-video are distinct modes; you can't mix them.
//
// Default OFF. Operator can flip to true via VEO_USE_REFERENCE_IMAGES=true
// to experiment once Veo's API supports the combo (or once we switch to
// pure ingredients-to-video by dropping the seed `image` field).
function referenceImagesEnabled() {
  const v = String(process.env.VEO_USE_REFERENCE_IMAGES ?? 'false').toLowerCase();
  return v === 'true' || v === '1';
}

// imageMimeType defaults to image/jpeg for back-compat; pass the real
// content-type when fetchAsImage gave you one (some Cloudinary transforms
// emit image/png even though the .jpg extension says otherwise).
// Veo 3.1's preview API only accepts 16:9 + 9:16. We map every other
// canvas aspect to one of those at request time, and Stage 3 ffmpeg
// crops the resulting video back to canvas dims (existing scale +
// crop with force_original_aspect_ratio=increase behavior).
//
// Mapping rule:
//   '9:16', '16:9' → exact (no crop loss)
//   '1:1', '4:5'   → '9:16' (prefer portrait source; products are
//                    typically framed vertically, so cropping
//                    top/bottom is safer than cropping the sides
//                    of a 16:9 source)
//   anything else  → '9:16' (defensive default)
function veoAspectForCanvas(canvasAspect) {
  const a = String(canvasAspect || '');
  if (a === '9:16' || a === '16:9') return a;
  return '9:16';
}

async function submitVeoJob({ prompt, imageBase64, imageMimeType = 'image/jpeg', aspectRatio, referenceImages = [] }) {
  const VEO_SUPPORTED = new Set(['16:9', '9:16']);
  const veoAspect     = VEO_SUPPORTED.has(aspectRatio) ? aspectRatio : '9:16';

  const instance = {
    prompt,
    image: { bytesBase64Encoded: imageBase64, mimeType: imageMimeType }
  };
  // Defense-in-depth: caller is expected to honor referenceImagesEnabled()
  // before populating the array (so the fetch can be skipped), but enforce
  // the gate again here so a misbehaving caller can't slip refs through.
  const willSendRefs = referenceImages.length > 0 && referenceImagesEnabled();
  if (willSendRefs) {
    instance.referenceImages = referenceImages.map(r => ({
      image:         { bytesBase64Encoded: r.base64, mimeType: r.mimeType || 'image/jpeg' },
      referenceType: r.referenceType || 'asset'
    }));
  }

  const body = {
    instances: [instance],
    parameters: {
      aspectRatio:      veoAspect,
      sampleCount:      1,
      personGeneration: 'allow_adult'
    }
  };

  // Diagnostic — logs the shape of the request without the base64
  // bodies. Helps narrow misleading 400s when the model rejects the
  // call: are we sending a recognized aspect, the right MIME, refs on
  // or off, etc.
  console.log(
    `🎬 veoReference.submit: model=${MODEL_ID} aspect=${veoAspect} ` +
    `seedMime=${imageMimeType} seedBytes≈${Math.round((imageBase64.length * 3) / 4)} ` +
    `refImages=${willSendRefs ? referenceImages.length : 0}` +
    (referenceImages.length && !willSendRefs ? ' (gated off via VEO_USE_REFERENCE_IMAGES)' : '')
  );

  let res;
  try {
    res = await axios.post(
      `${API_BASE}/models/${MODEL_ID}:predictLongRunning?key=${apiKey()}`,
      body,
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    );
  } catch (err) {
    const status = err.response?.status;
    const detail = JSON.stringify(err.response?.data || err.message);
    throw new Error(`Veo submit failed (HTTP ${status}): ${detail}`);
  }
  return res.data.name; // operation resource name
}

async function pollOperation(operationName) {
  const startedAt = Date.now();
  const deadline  = startedAt + MAX_POLL_MS;
  let pollCount = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    pollCount += 1;

    const res = await axios.get(
      `${API_BASE}/${operationName}?key=${apiKey()}`,
      { timeout: 30000 }
    );
    const op = res.data;
    const elapsedSec  = Math.round((Date.now() - startedAt) / 1000);
    if (op.done) {
      if (op.error) throw new Error(`Veo operation failed after ${elapsedSec}s: ${JSON.stringify(op.error)}`);
      console.log(`🎬 veoReference: ${operationName} done after ${elapsedSec}s (${pollCount} polls)`);
      return op.response;
    }
    const remainingSec = Math.round((deadline - Date.now()) / 1000);
    console.log(`🎬 veoReference: polling ${operationName} — not done yet (elapsed=${elapsedSec}s, remaining=${remainingSec}s, poll #${pollCount})`);
  }
  throw new Error(`Veo operation timed out after ${MAX_POLL_MS / 1000}s: ${operationName}`);
}

// veo-2.0: response.predictions[0].bytesBase64Encoded (inline base64)
// veo-3.x: response.generateVideoResponse.generatedSamples[0].video.uri (download URI)
async function extractVideoBuffer(response) {
  // veo-3.x URI path
  const uri = response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (uri) {
    const sep = uri.includes('?') ? '&' : '?';
    const res = await axios.get(`${uri}${sep}key=${apiKey()}`, {
      responseType: 'arraybuffer',
      timeout: 120000
    });
    return Buffer.from(res.data);
  }
  // veo-2.0 inline base64 path
  const b64 = response?.predictions?.[0]?.bytesBase64Encoded;
  if (b64) return Buffer.from(b64, 'base64');
  throw new Error(`Veo response missing video bytes: ${JSON.stringify(response)}`);
}

// ── Public API ─────────────────────────────────────────────────────────

async function generateForAd({ ad, operatorPrompt = null }) {
  if (!enabled())  return { skipped: true, reason: 'AI_VEO_REELS not enabled' };
  if (!apiKey())   return { skipped: true, reason: 'GEMINI_API_KEY not set' };

  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

  const aspectRatio = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  // Veo only accepts 9:16 + 16:9. For other canvases (1:1 / 4:5) we
  // request Veo at the closest supported aspect and let Stage 3 ffmpeg
  // crop the video to the canvas dims (existing scale + crop behavior).
  // Seed image is cropped to the Veo aspect too — Veo expects the seed
  // to match the requested output aspect.
  const veoAspect = veoAspectForCanvas(aspectRatio);
  const track     = media.fileType === 'video' ? 1 : 2;

  // Brand needed before image-seed crop so transparent PNGs flatten onto
  // websiteBackground (video-seed first-frame path has no alpha).
  const [brand, product, layoutInput] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean()
  ]);

  const refUrl = track === 1
    ? deriveFirstFrameUrl(media.fileUrl, veoAspect)
    : deriveAspectCroppedImageUrl(media.fileUrl, veoAspect, brand);

  if (!refUrl) throw new Error(`Cannot derive reference image for ad ${ad._id} (fileType=${media.fileType})`);

  let concept = null;
  if (ad.conceptId && ad.conceptArtifactId) {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    concept = direction?.concepts?.find(c => c.concept_id === ad.conceptId) || null;
  }

  // OCR text the detect pipeline found on this seed. Non-empty means the
  // seed has burned-in captions / stickers / watermarks that Veo's
  // image-to-video mode will faithfully animate into the output — we
  // can't remove them after the fact. Tell Veo to ignore overlay text.
  const seedHasText = Array.isArray(media.text) && media.text.length > 0;

  // hasProductReference reflects what we'll ACTUALLY send — gated by
  // referenceImagesEnabled() (default false because Veo 3.1's preview
  // rejects seed + refImages together). When off, the prompt falls
  // back to "preserve the seed product" wording instead of pointing
  // at a separate reference image.
  const willSendRefs = referenceImagesEnabled() && !!product?.imageUrl;

  // GPT-composed storyboard (camera + per-beat motion + audio). Gated
  // by VEO_USE_GPT_STORYBOARD; returns null when the flag is off or the
  // GPT call fails, and buildVeoPrompt falls back to the hardcoded
  // 3-beat template.
  const lpInput     = layoutInput?.input || null;
  const lpSrcMedia  = lpInput?.source_media || null;
  const subject     = resolveSubject({ layoutInput: lpInput, sourceMedia: lpSrcMedia, media });
  const storyboard  = await generateStoryboard({
    concept, brand, product,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    subject,
    aspectRatio,
    operatorPrompt,
    brandId:   media.brandId,
    productId: ad.productId || null
  });

  const prompt = buildVeoPrompt({
    concept, brand, product, media,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    aspectRatio,
    seedHasText,
    hasProductReference: willSendRefs,
    operatorPrompt,
    storyboard
  });

  const t0 = Date.now();
  const aspectLabel = aspectRatio === veoAspect
    ? `aspect=${aspectRatio}`
    : `aspect=${aspectRatio} (veo=${veoAspect}, will crop)`;
  console.log(
    `🎬 veoReference[ad=${ad._id}]: track=${track} ${aspectLabel} ` +
    `media=${media._id} (${media.fileType})${seedHasText ? ` seedHasText=true (${media.text.length} regions)` : ''} submitting...`
  );

  // fetchAsImage validates content-type so a Cloudinary transform that
  // quietly returns an HTML error page fails LOUDLY here instead of
  // surfacing as Veo's misleading "Unsupported video generation
  // request" downstream.
  const seedImage = await fetchAsImage(refUrl);

  // Veo 3.1 referenceImages — asset-type references hold the product's
  // appearance steady through motion. Off by default (Veo's preview
  // rejects seed+refs together with a 400). Skip the fetch entirely
  // when disabled so we don't pay for bandwidth on a payload that
  // submitVeoJob will drop. Flip VEO_USE_REFERENCE_IMAGES=true to
  // experiment once Veo accepts the combo (or once we switch to pure
  // ingredients-to-video and drop the seed image).
  const referenceImages = [];
  if (referenceImagesEnabled() && product?.imageUrl) {
    try {
      const productImage = await fetchAsImage(product.imageUrl);
      referenceImages.push({
        base64:        productImage.base64,
        mimeType:      productImage.mimeType,
        referenceType: 'asset'
      });
    } catch (err) {
      console.warn(`   ⚠️  veoReference[ad=${ad._id}]: product reference fetch failed (${err.message}) — proceeding without it`);
    }
  }

  const operationName = await submitVeoJob({
    prompt,
    imageBase64:   seedImage.base64,
    imageMimeType: seedImage.mimeType,
    aspectRatio:   veoAspect,        // map to a Veo-supported aspect; ffmpeg crops downstream
    referenceImages
  });
  console.log(`🎬 veoReference[ad=${ad._id}]: operation started — ${operationName}${referenceImages.length ? ` (refs=${referenceImages.length})` : ''}`);

  const response    = await pollOperation(operationName);
  const videoBuffer = await extractVideoBuffer(response);

  const uploaded = await uploadBufferToCloudinary(videoBuffer, {
    folder:       'liquidretail/veo_renders',
    resourceType: 'video',
    format:       'mp4'
  });

  const elapsedMs = Date.now() - t0;
  console.log(
    `🎬 veoReference[ad=${ad._id}]: done — ` +
    `track=${track} aspect=${aspectRatio} took=${Math.round(elapsedMs / 1000)}s`
  );

  return {
    videoUrl:           uploaded.secure_url,
    cloudinaryPublicId: uploaded.public_id,
    operationName,
    aspectRatio,
    track,
    prompt,
    storyboard,
    elapsedMs
  };
}

module.exports = { generateForAd, enabled };
