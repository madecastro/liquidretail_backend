// Polish-a-video-poster shadow.
//
// gpt-image-1/2 don't produce video and the existing image-ref path
// skips video sources entirely. This service fills the gap: extracts
// the first frame of a video Ad's Cloudinary composite, polishes it
// via Gemini 2.5 Flash Image (Nano Banana), and stamps the polished
// URL on Ad.posterUrl so platforms that show a poster image before
// playback (Meta Ads Manager, the Ads page tile while paused) get a
// photoreal still instead of the raw composite frame.
//
// Triggered as setImmediate from renderService after persistStage when
// ad.kind === 'video'. Fire-and-forget — the Ad's renderUrl (the
// playable composite) is already correct; this only upgrades the
// poster surface.
//
// Env gating:
//   AI_VIDEO_POSTER_ENABLED=true   — required for the service to fire
//
// Output:
//   Ad.posterUrl is overwritten with the Nano-Banana-polished URL.
//   If anything fails the existing posterUrl (the deterministic
//   overlay PNG) stays put.

const Ad             = require('../models/Ad');
const gemini         = require('./geminiImageService');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { trackLlmCall } = require('./costTracker');

function enabled() {
  return String(process.env.AI_VIDEO_POSTER_ENABLED || '').toLowerCase() === 'true'
    && gemini.isEnabled();
}

// Build the first-frame URL of a Cloudinary video composite. The
// composite URL points at the source video; inserting `so_0` after
// `/video/upload/` and changing the extension to `.jpg` returns the
// frame at second 0 as a still image. Works for both raw video URLs
// and composite (l_*) URLs.
function buildFirstFrameUrl(compositeUrl) {
  if (!compositeUrl || typeof compositeUrl !== 'string') return null;
  if (!compositeUrl.includes('/video/upload/')) return null;
  // Prepend so_0 to the transform chain; replace .mp4/.mov/.webm/.m4v
  // with .jpg so Cloudinary delivers a JPEG still rather than a 1-frame
  // video. so_0 already exists in the chain? Cloudinary handles dup.
  return compositeUrl
    .replace('/video/upload/', '/video/upload/so_0/')
    .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
}

// Photoreal polish prompt. The composite frame already has the LLM's
// design baked in over a real video frame — we want Nano Banana to
// refine the photographic quality (lighting, shadows, color grading)
// without redesigning the composition.
function buildPolishPrompt() {
  return [
    'Polish this advertising composition into a photoreal version.',
    '',
    'PRESERVE everything exactly:',
    '- The composition, layout, and zone positions',
    '- Every text element, font, and color',
    '- The product photography and any subject in the image — same shape, same identity, same packaging',
    '- The color palette and brand chrome',
    '',
    'REFINE only the photographic quality:',
    '- Smooth lighting and natural shadows under existing elements',
    '- Crisper typography rendering and anti-aliasing',
    '- Photoreal finishing on backgrounds and gradients',
    '- Overall image fidelity (sharper than the source)',
    '',
    'The composition is FINAL. Treat this as photoreal polish of an existing ad, NOT a starting point to redesign.'
  ].join('\n');
}

// Entry point. Fire from setImmediate after the Ad doc is persisted.
// Idempotent — re-fires for the same Ad just overwrite posterUrl with
// a fresh polish, no harm done. We don't cache because the input
// composite changes if the canvas spec is regenerated.
async function generatePosterForAd({ adId }) {
  if (!enabled()) return { skipped: true, reason: 'AI_VIDEO_POSTER_ENABLED=false or Gemini not configured' };
  if (!adId)      throw new Error('adId required');

  const ad = await Ad.findById(adId)
    .select('_id brandId kind renderUrl posterUrl mediaId productId')
    .lean();
  if (!ad)                         return { skipped: true, reason: 'Ad not found' };
  if (ad.kind !== 'video')         return { skipped: true, reason: 'Ad is not video' };
  const firstFrameUrl = buildFirstFrameUrl(ad.renderUrl);
  if (!firstFrameUrl)              return { skipped: true, reason: 'cannot derive first-frame URL from renderUrl' };

  const prompt = buildPolishPrompt();
  const t0 = Date.now();
  let polishedPng;
  try {
    polishedPng = await trackLlmCall(
      {
        stage:      'video_poster',
        provider:   'gemini',
        model:      'gemini-2.5-flash-image',
        purposeTag: 'video_poster',
        brandId:    ad.brandId,
        mediaId:    ad.mediaId,
        productId:  ad.productId,
        cacheKey:   String(ad._id),
        visionImages: 1
      },
      () => gemini.polishImage(prompt, firstFrameUrl)
    );
  } catch (err) {
    console.warn(`   ⚠️  video-poster polish failed for ad=${adId}: ${err.message}`);
    return { skipped: true, reason: `gemini polish failed: ${err.message}` };
  }
  const elapsedMs = Date.now() - t0;

  let uploaded;
  try {
    uploaded = await uploadBufferToCloudinary(polishedPng, {
      folder: 'liquidretail/ai_video_poster'
    });
  } catch (err) {
    console.warn(`   ⚠️  video-poster upload failed for ad=${adId}: ${err.message}`);
    return { skipped: true, reason: `cloudinary upload failed: ${err.message}` };
  }

  await Ad.updateOne(
    { _id: ad._id },
    { $set: { posterUrl: uploaded.secure_url, updatedAt: new Date() } }
  );

  console.log(
    `🎞️  video-poster polished ad=${ad._id} ` +
    `frame_in=${firstFrameUrl.length}chars poster=${uploaded.secure_url} took=${elapsedMs}ms`
  );

  return { ok: true, posterUrl: uploaded.secure_url, elapsedMs };
}

(function logConfig() {
  console.log(
    `🎞️  aiVideoPosterService config — ` +
    `enabled=${enabled()} ` +
    `gemini=${gemini.isEnabled()}`
  );
})();

module.exports = { generatePosterForAd, enabled };
