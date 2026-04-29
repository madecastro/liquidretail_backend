const { uploadBufferToCloudinary } = require('./cloudinaryService');
const providers = require('./extendedCropsProviders');

// The new ratios and which existing smart-crop ratio they extend from.
const NEW_RATIOS = {
  '9:16':   { baseRatio: '4:5', cloudinaryAr: '9:16' },
  '1.91:1': { baseRatio: '5:4', cloudinaryAr: '191:100' }
};

// Generate candidate outputs for each new ratio.
//
// For video jobs, every candidate shares the same video URL: the TikTok-style
// self-underlay — a blurred, filled-to-target-AR copy of the source video sits
// behind an unmodified (letterboxed) copy of the same video. Same source,
// different transform layers. The distinguishing part of each candidate is the
// STILL image (AI-generated background, or soft-pad of the hero frame). We
// explicitly do NOT composite the source video onto the AI-generated still —
// Cloudinary image-typed assets can't be used as the base of a /video/upload/
// URL, so that kind of composite is unreliable with the public Cloudinary
// transform API alone.
//
// AI providers come from extendedCropsProviders.js — add or disable them
// there. The orchestrator only knows about (provider, variant) tuples; it
// hands each one the same input bundle and uploads whatever buffer comes
// back to Cloudinary with the per-ratio AR-fit transform.
async function generateExtendedCrops({ sourceImageUrl, sourceVideoUrl, smartCrops, judge, primarySubject, background, isVideo }) {
  const output = {};
  const errors = {};
  for (const r of Object.keys(NEW_RATIOS)) { output[r] = []; errors[r] = []; }

  const enabled = providers.filter(p => p.isEnabled());
  if (!enabled.length) {
    console.warn('⚠️  No extended-crop AI providers enabled — only Cloudinary blurred-pad will be produced (video only).');
  }

  for (const [newRatio, { baseRatio, cloudinaryAr }] of Object.entries(NEW_RATIOS)) {
    const judgeKey = 'crop_' + baseRatio.replace(':', '_');
    const winnerId = judge?.[judgeKey]?.winnerId;
    const baseCandidates = smartCrops?.[baseRatio] || [];
    const baseCrop = baseCandidates.find(c => c.id === winnerId) || baseCandidates[0];
    if (!baseCrop) { console.warn(`⚠️  No base ${baseRatio} crop available for ${newRatio}`); continue; }

    // Shared video URL for every candidate on a video job:
    //   blurred self-fill as background + unmodified source letterboxed on top.
    // The subject stays in its original frame position; the bars are a moving,
    // heavily-blurred copy of the same clip (TikTok / Reels reformat look).
    const sharedVideoUrl = (isVideo && sourceVideoUrl)
      ? buildSelfUnderlayVideoUrl(sourceVideoUrl, cloudinaryAr)
      : null;

    // AI providers receive sourceUrl + baseCrop + subject + background and
    // produce an image Buffer. `background` (from subjectTextService) carries
    // scene style/palette/lighting so providers can preserve or extend it.
    const tasks = enabled.map(p => makeProviderCandidate({
      id:        `${newRatio}-${p.idSlug}-${p.provider}`,
      label:     `${capitalize(p.provider)} ${p.variant}`,
      provider:  p.provider,
      variant:   p.variant,
      generator: () => p.generate({ sourceImageUrl, baseCrop, newRatio, primarySubject, background }),
      newRatio, cloudinaryAr, sharedVideoUrl
    }));

    // Video-only: blurred-pad candidate. Its still is the hero frame padded with
    // blurred bars; its video is the same sharedVideoUrl every other variant uses
    // (consistent playback, different still preview). Lives outside the provider
    // registry because it has no AI generator — pure Cloudinary transform.
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

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

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
// Cloudinary applies transforms left-to-right in the URL path. insertTransform
// anchors on the /v\d+/ version segment (present on every secure_url from an
// upload), so chained transforms stay in the order they were added.

function insertTransform(url, transform) {
  if (!url || !url.includes('/upload/')) return url;
  if (/\/v\d+\//.test(url)) {
    return url.replace(/\/(v\d+\/)/, `/${transform}/$1`);
  }
  // Fallback for URLs without a version segment — append as the only transform
  return url.replace('/upload/', `/upload/${transform}/`);
}

function buildExactArUrl(imageUrl, ar) {
  return insertTransform(imageUrl, `c_fill,ar_${ar},g_auto`);
}

// b_blurred requires a Cloudinary add-on that isn't on our plan (returns 400
// "Invalid color name blurred"). b_auto:predominant_gradient is always-available
// and produces a visually similar soft-color pad for still images.
function buildBlurredPadImageUrl(sourceUrl, ar) {
  return insertTransform(sourceUrl, `c_pad,ar_${ar},b_auto:predominant_gradient`);
}

// TikTok / Reels reformat pattern:
//   base:    source video filled to target AR + heavy blur  → the "bars"
//   overlay: SAME source video fit inside the canvas, AR preserved → crisp subject
// Cloudinary references the overlay by public_id with slashes → colons, e.g.
// `liquidretail/foo-bar` becomes `liquidretail:foo-bar`. `fl_relative,w_1.0,h_1.0`
// sizes the overlay to 100% of the base canvas; `c_fit` then shrinks it to
// preserve its own AR (letterboxing), exposing the blurred bars behind.
function buildSelfUnderlayVideoUrl(sourceVideoUrl, ar) {
  if (!sourceVideoUrl || !sourceVideoUrl.includes('/upload/')) return sourceVideoUrl;
  const publicId = extractCloudinaryPublicId(sourceVideoUrl);
  if (!publicId) return sourceVideoUrl;
  const overlayRef = publicId.replace(/\//g, ':');
  const transform = [
    `c_fill,ar_${ar},e_blur:1500`,
    `l_video:${overlayRef},c_fit,fl_relative,w_1.0,h_1.0`,
    `fl_layer_apply`
  ].join('/');
  return insertTransform(sourceVideoUrl, transform);
}

function extractCloudinaryPublicId(url) {
  const m = url.match(/\/v\d+\/(.+?)\.[a-z0-9]+(?:\?|$)/i);
  return m ? m[1] : null;
}

module.exports = { generateExtendedCrops, NEW_RATIOS };
