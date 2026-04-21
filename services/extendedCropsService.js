const { uploadBufferToCloudinary } = require('./cloudinaryService');
const openaiImg = require('./openaiImageService');
const geminiImg = require('./geminiImageService');

// The new ratios and which existing smart-crop ratio they extend from.
const NEW_RATIOS = {
  '9:16':   { baseRatio: '4:5', cloudinaryAr: '9:16' },
  '1.91:1': { baseRatio: '5:4', cloudinaryAr: '191:100' }
};

// Generate candidate outputs for each new ratio.
//
// Inputs:
//   sourceImageUrl    — Cloudinary URL of the hero frame (video) or the source image
//   sourceVideoUrl    — Cloudinary URL of the source video (for composite video candidates)
//   smartCrops        — the existing crops.{ '5:4': [...], '1:1': [...], '4:5': [...] }
//   judge             — existing judge output (to find the winning base-ratio crop)
//   primarySubject    — description string or null
//   isVideo           — bool
//
// Returns: { candidates: { '9:16': [...], '1.91:1': [...] }, errors: { '9:16': [...], '1.91:1': [...] } }
async function generateExtendedCrops({ sourceImageUrl, sourceVideoUrl, smartCrops, judge, primarySubject, isVideo }) {
  const output = { '9:16': [], '1.91:1': [] };
  const errors = { '9:16': [], '1.91:1': [] };

  for (const [newRatio, { baseRatio, cloudinaryAr }] of Object.entries(NEW_RATIOS)) {
    const judgeKey = 'crop_' + baseRatio.replace(':', '_');
    const winnerId = judge?.[judgeKey]?.winnerId;
    const baseCandidates = smartCrops?.[baseRatio] || [];
    const baseCrop = baseCandidates.find(c => c.id === winnerId) || baseCandidates[0];
    if (!baseCrop) { console.warn(`⚠️  No base ${baseRatio} crop available for ${newRatio}`); continue; }

    const baseCropVideoUrl = isVideo ? buildCropUrl(sourceVideoUrl, baseCrop, 'video') : null;

    const tasks = [];

    // AI providers receive sourceUrl + baseCrop and build their own transform URLs.
    // This lets openaiImageService construct crop→pad in the correct Cloudinary order
    // and build a matching mask for outpainting.
    tasks.push(makeProviderCandidate({
      id: `${newRatio}-ext-openai`, label: 'OpenAI extension', provider: 'openai', variant: 'extension',
      generator: () => openaiImg.extendImage(sourceImageUrl, baseCrop, newRatio, primarySubject),
      newRatio, cloudinaryAr, isVideo, sourceVideoUrl, baseCrop
    }));
    tasks.push(makeProviderCandidate({
      id: `${newRatio}-gen-openai`, label: 'OpenAI generation', provider: 'openai', variant: 'generation',
      generator: () => openaiImg.generateFresh(sourceImageUrl, baseCrop, newRatio, primarySubject),
      newRatio, cloudinaryAr, isVideo, sourceVideoUrl, baseCrop
    }));
    if (geminiImg.isEnabled()) {
      tasks.push(makeProviderCandidate({
        id: `${newRatio}-ext-gemini`, label: 'Gemini extension', provider: 'gemini', variant: 'extension',
        generator: () => geminiImg.extendImage(sourceImageUrl, baseCrop, newRatio, primarySubject),
        newRatio, cloudinaryAr, isVideo, sourceVideoUrl, baseCrop
      }));
      tasks.push(makeProviderCandidate({
        id: `${newRatio}-gen-gemini`, label: 'Gemini generation', provider: 'gemini', variant: 'generation',
        generator: () => geminiImg.generateFresh(sourceImageUrl, baseCrop, newRatio, primarySubject),
        newRatio, cloudinaryAr, isVideo, sourceVideoUrl, baseCrop
      }));
    }

    // Video-only: blurred-pad candidate (instant, no AI)
    if (isVideo && baseCropVideoUrl) {
      output[newRatio].push({
        id: `${newRatio}-blurred`,
        label: 'Blurred pad',
        provider: 'cloudinary',
        variant: 'extension',
        imageUrl: buildBlurredPadImageUrl(sourceImageUrl, cloudinaryAr),
        videoUrl: buildBlurredPadVideoUrl(baseCropVideoUrl, cloudinaryAr)
      });
    }

    const settled = await Promise.allSettled(tasks);
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled' && s.value?.imageUrl) output[newRatio].push(s.value);
      else if (s.status === 'fulfilled' && s.value?._error) errors[newRatio].push(s.value._error);
      else if (s.status === 'rejected') {
        errors[newRatio].push({ label: 'Unknown', provider: 'unknown', variant: 'unknown', error: s.reason?.message || String(s.reason) });
        console.warn(`⚠️  Candidate rejected: ${s.reason?.message || s.reason}`);
      }
    });
  }

  return { candidates: output, errors };
}

async function makeProviderCandidate({ id, label, provider, variant, generator, newRatio, cloudinaryAr, isVideo, sourceVideoUrl, baseCrop }) {
  const t0 = Date.now();
  try {
    const imgBuffer = await generator();
    const up = await uploadBufferToCloudinary(imgBuffer, { resourceType: 'image' });
    const imageUrl = buildExactArUrl(up.secure_url, cloudinaryAr);
    let videoUrl = null;
    if (isVideo && sourceVideoUrl) {
      videoUrl = buildBackgroundCompositeVideoUrl(up.public_id, sourceVideoUrl, baseCrop, cloudinaryAr);
    }
    console.log(`   ✓ ${label} [${newRatio}] ready in ${Date.now() - t0}ms`);
    return { id, label, provider, variant, imageUrl, videoUrl };
  } catch (err) {
    console.warn(`   ✗ ${label} [${newRatio}] failed in ${Date.now() - t0}ms: ${err.message}`);
    return { _error: { id, label, provider, variant, error: err.message } };
  }
}

// ── Cloudinary URL builders ──
function buildCropUrl(sourceUrl, baseCrop, kind) {
  if (!sourceUrl || !sourceUrl.includes('/upload/')) return sourceUrl;
  const w = Math.max(1, baseCrop.x2 - baseCrop.x1);
  const h = Math.max(1, baseCrop.y2 - baseCrop.y1);
  const transform = `c_crop,w_${w},h_${h},x_${baseCrop.x1},y_${baseCrop.y1}`;
  let url = sourceUrl.replace('/upload/', `/upload/${transform}/`);
  if (kind === 'image' && !/\.(jpg|jpeg|png|webp)$/i.test(url)) url += '.jpg';
  return url;
}

function buildExactArUrl(imageUrl, ar) {
  return imageUrl.replace('/upload/', `/upload/c_fill,ar_${ar},g_auto/`);
}

function buildBlurredPadImageUrl(sourceUrl, ar) {
  return sourceUrl.replace('/upload/', `/upload/c_pad,ar_${ar},b_blurred/`);
}

function buildBlurredPadVideoUrl(videoUrl, ar) {
  return videoUrl.replace('/upload/', `/upload/c_pad,ar_${ar},b_blurred/`);
}

// Composite video: the AI-generated image as the canvas; the original video
// centered on top, padded to its original aspect ratio.
// Cloudinary syntax: source is the IMAGE, overlay is the video.
function buildBackgroundCompositeVideoUrl(bgPublicId, videoUrl, baseCrop, ar) {
  if (!videoUrl || !videoUrl.includes('/upload/')) return null;
  // Extract video public_id from videoUrl (assumes standard /upload/.../publicId.ext shape)
  const m = videoUrl.match(/\/upload\/(?:[^/]+\/)*v\d+\/([^?]+?)(?:\.[a-z0-9]+)?$/i);
  const videoPublicId = m ? m[1] : null;
  if (!videoPublicId) return null;
  const encodedVid = videoPublicId.replace(/\//g, ':');
  const cropW = baseCrop.x2 - baseCrop.x1;
  const cropH = baseCrop.y2 - baseCrop.y1;
  // Source = the bg image. Overlay = video cropped, resized to fit roughly half the canvas height.
  const bgUrlBase = videoUrl.split('/upload/')[0] + '/image/upload';
  // Construct full URL from parts
  return `${bgUrlBase}/c_fill,ar_${ar},g_auto/l_video:${encodedVid}/c_crop,w_${cropW},h_${cropH},x_${baseCrop.x1},y_${baseCrop.y1}/fl_layer_apply,g_center,fl_relative,w_0.6/${bgPublicId}.mp4`;
}

module.exports = { generateExtendedCrops, NEW_RATIOS };
