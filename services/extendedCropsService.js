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
// For video jobs, every candidate shares the same video URL: the source video
// cropped to the subject bbox, then padded to the target aspect ratio with a
// blurred background. The distinguishing part of each candidate is the STILL
// image (AI-generated background, or blurred pad of the hero frame). We
// explicitly do NOT try to composite the source video onto the AI-generated
// still — Cloudinary image-typed assets can't be used as the base of a
// /video/upload/ URL, so that kind of composite is unreliable with the public
// Cloudinary transform API alone.
async function generateExtendedCrops({ sourceImageUrl, sourceVideoUrl, smartCrops, judge, primarySubject, isVideo }) {
  const output = { '9:16': [], '1.91:1': [] };
  const errors = { '9:16': [], '1.91:1': [] };

  for (const [newRatio, { baseRatio, cloudinaryAr }] of Object.entries(NEW_RATIOS)) {
    const judgeKey = 'crop_' + baseRatio.replace(':', '_');
    const winnerId = judge?.[judgeKey]?.winnerId;
    const baseCandidates = smartCrops?.[baseRatio] || [];
    const baseCrop = baseCandidates.find(c => c.id === winnerId) || baseCandidates[0];
    if (!baseCrop) { console.warn(`⚠️  No base ${baseRatio} crop available for ${newRatio}`); continue; }

    // Shared video URL for every candidate on a video job:
    //   source video  →  crop to subject bbox  →  pad to target ratio w/ blurred bars
    const sharedVideoUrl = (isVideo && sourceVideoUrl)
      ? buildBlurredPadVideoUrl(buildCropUrl(sourceVideoUrl, baseCrop, 'video'), cloudinaryAr)
      : null;

    const tasks = [];

    // AI providers receive sourceUrl + baseCrop and build their own transform URLs.
    tasks.push(makeProviderCandidate({
      id: `${newRatio}-ext-openai`, label: 'OpenAI extension', provider: 'openai', variant: 'extension',
      generator: () => openaiImg.extendImage(sourceImageUrl, baseCrop, newRatio, primarySubject),
      newRatio, cloudinaryAr, sharedVideoUrl
    }));
    tasks.push(makeProviderCandidate({
      id: `${newRatio}-gen-openai`, label: 'OpenAI generation', provider: 'openai', variant: 'generation',
      generator: () => openaiImg.generateFresh(sourceImageUrl, baseCrop, newRatio, primarySubject),
      newRatio, cloudinaryAr, sharedVideoUrl
    }));
    if (geminiImg.isEnabled()) {
      tasks.push(makeProviderCandidate({
        id: `${newRatio}-ext-gemini`, label: 'Gemini extension', provider: 'gemini', variant: 'extension',
        generator: () => geminiImg.extendImage(sourceImageUrl, baseCrop, newRatio, primarySubject),
        newRatio, cloudinaryAr, sharedVideoUrl
      }));
      tasks.push(makeProviderCandidate({
        id: `${newRatio}-gen-gemini`, label: 'Gemini generation', provider: 'gemini', variant: 'generation',
        generator: () => geminiImg.generateFresh(sourceImageUrl, baseCrop, newRatio, primarySubject),
        newRatio, cloudinaryAr, sharedVideoUrl
      }));
    }

    // Video-only: blurred-pad candidate. Its still is the hero frame padded with
    // blurred bars; its video is the same sharedVideoUrl every other variant uses
    // (consistent playback, different still preview).
    if (isVideo && sharedVideoUrl) {
      output[newRatio].push({
        id: `${newRatio}-blurred`,
        label: 'Blurred pad',
        provider: 'cloudinary',
        variant: 'extension',
        imageUrl: buildBlurredPadImageUrl(sourceImageUrl, cloudinaryAr),
        videoUrl: sharedVideoUrl
      });
    }

    const settled = await Promise.allSettled(tasks);
    settled.forEach(s => {
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

async function makeProviderCandidate({ id, label, provider, variant, generator, newRatio, cloudinaryAr, sharedVideoUrl }) {
  const t0 = Date.now();
  try {
    const imgBuffer = await generator();
    const up = await uploadBufferToCloudinary(imgBuffer, { resourceType: 'image' });
    const imageUrl = buildExactArUrl(up.secure_url, cloudinaryAr);
    console.log(`   ✓ ${label} [${newRatio}] ready in ${Date.now() - t0}ms → ${imageUrl}`);
    return { id, label, provider, variant, imageUrl, videoUrl: sharedVideoUrl || null };
  } catch (err) {
    console.warn(`   ✗ ${label} [${newRatio}] failed in ${Date.now() - t0}ms: ${err.message}`);
    return { _error: { id, label, provider, variant, error: err.message } };
  }
}

// ── Cloudinary URL builders ──
//
// Cloudinary applies transforms left-to-right in the URL path. When a URL
// already has a transform (e.g. c_crop from buildCropUrl) and we're adding
// another (e.g. c_pad), we MUST insert the new transform AFTER the existing
// ones, not at the front. The /v\d+/ version segment is a stable anchor —
// every Cloudinary secure_url from an upload has it.

function insertTransform(url, transform) {
  if (!url || !url.includes('/upload/')) return url;
  if (/\/v\d+\//.test(url)) {
    return url.replace(/\/(v\d+\/)/, `/${transform}/$1`);
  }
  // Fallback for URLs without a version segment — append as the only transform
  return url.replace('/upload/', `/upload/${transform}/`);
}

function buildCropUrl(sourceUrl, baseCrop, kind) {
  if (!sourceUrl || !sourceUrl.includes('/upload/')) return sourceUrl;
  const w = Math.max(1, baseCrop.x2 - baseCrop.x1);
  const h = Math.max(1, baseCrop.y2 - baseCrop.y1);
  let url = insertTransform(sourceUrl, `c_crop,w_${w},h_${h},x_${baseCrop.x1},y_${baseCrop.y1}`);
  if (kind === 'image' && !/\.(jpg|jpeg|png|webp)$/i.test(url)) url += '.jpg';
  return url;
}

function buildExactArUrl(imageUrl, ar) {
  return insertTransform(imageUrl, `c_fill,ar_${ar},g_auto`);
}

function buildBlurredPadImageUrl(sourceUrl, ar) {
  return insertTransform(sourceUrl, `c_pad,ar_${ar},b_blurred`);
}

function buildBlurredPadVideoUrl(videoUrl, ar) {
  return insertTransform(videoUrl, `c_pad,ar_${ar},b_blurred`);
}

module.exports = { generateExtendedCrops, NEW_RATIOS };
