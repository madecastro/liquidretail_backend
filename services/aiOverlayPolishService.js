// Polish-the-overlay shadow for video ads.
//
// The video composite chain layers a Puppeteer-screenshotted overlay
// PNG (transparent at the media slot) over the source video. The
// Puppeteer render is faithful to the LLM HTML but the panel/text/CTA
// chrome looks computer-rendered — sharp edges, flat shadows, no
// photoreal finishing. This service polishes the overlay PNG via
// Gemini 2.5 Flash Image (Nano Banana), enforces the transparent
// slot rect with sharp (defense against the model painting over it),
// and rebuilds the composite URL so the playback shows the polished
// chrome layered over the playing video.
//
// Triggered as setImmediate from renderService after persistStage when
// ad.kind === 'video' AND AI_OVERLAY_POLISH_ENABLED=true. Fire-and-
// forget; the initial composite (raw overlay) is already on the Ad
// when the operator first lands on the page, and Ad.renderUrl swaps
// to the polished composite when this shadow completes.

const sharp = require('sharp');
const Ad                  = require('../models/Ad');
const Media               = require('../models/Media');
const AiCanvasArtifact    = require('../models/AiCanvasArtifact');
const gemini              = require('./geminiImageService');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { trackLlmCall }    = require('./costTracker');

function enabled() {
  return String(process.env.AI_OVERLAY_POLISH_ENABLED || '').toLowerCase() === 'true'
    && gemini.isEnabled();
}

// Build the Cloudinary delivery URL for an image publicId. Mirrors the
// pattern used elsewhere in the codebase — we don't need transforms,
// just the canonical https://res.cloudinary.com/.../upload/<publicId>.
function buildCloudinaryImageUrl(publicId) {
  if (!publicId) return null;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud) return null;
  return `https://res.cloudinary.com/${cloud}/image/upload/${publicId}`;
}

function buildPolishPrompt(rect) {
  return [
    `Polish this video-ad overlay into a photoreal version. The overlay shows panels, text, CTAs, badges, and other ad chrome that sits on top of a playing video.`,
    ``,
    `PRESERVE every visual element exactly:`,
    `- All text content, font weights, kerning, colors`,
    `- Zone positions and rect geometry — every element stays where it is`,
    `- The chosen color palette and brand chrome`,
    ``,
    `REFINE only photographic quality:`,
    `- Smooth lighting and natural shadows under panels and CTAs`,
    `- Crisper typography anti-aliasing`,
    `- Subtle background gradients refined to photoreal quality`,
    ``,
    `CRITICAL — TRANSPARENT SLOT:`,
    `The image has a TRANSPARENT rectangular region at x:${rect.x}, y:${rect.y}, width:${rect.w}, height:${rect.h} pixels. This is intentional — the video plays through this slot. DO NOT fill in this transparent rect with any imagery, color, or visual content. KEEP IT TRANSPARENT in the output. The polished image MUST have full alpha transparency in this exact region.`,
    ``,
    `Treat this as photoreal polish of an existing ad layer, NOT a redesign.`
  ].join('\n');
}

// Defense-in-depth — enforce transparency at the slot rect via sharp.
// Nano Banana may not reliably preserve alpha; punching the rect out
// in post guarantees the composite has somewhere for the video to
// show through. SVG mask: opaque everywhere except the rect, then
// dest-in keeps polished pixels only where the mask is opaque.
// Defense-in-depth — enforce transparency at the slot rect via sharp.
// dest-out keeps the destination where the source is TRANSPARENT and
// clears it where the source is OPAQUE. So compositing an opaque slot-
// shaped buffer at the slot's coordinates punches a transparent hole
// in the polished overlay at exactly those pixels — independent of
// what Nano Banana actually painted there.
//
// The previous implementation tried to use an SVG mask with dest-in
// (white = keep, black = clear) but in SVG both fill colors have
// alpha=1, so the mask was fully opaque and dest-in was effectively a
// no-op — the polish "punch" never punched. With dest-out + an opaque
// rect at slot coords the semantics are explicit and correct.
async function punchTransparentSlot(pngBuffer, rect, width, height) {
  // Clamp the slot to the canvas bounds — Nano Banana sometimes returns
  // an image slightly different from the input dims, in which case an
  // out-of-bounds composite would throw.
  const x = Math.max(0, Math.min(width  - 1, Math.round(rect.x || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y || 0)));
  const w = Math.max(1, Math.min(width  - x, Math.round(rect.w)));
  const h = Math.max(1, Math.min(height - y, Math.round(rect.h)));

  const slotMask = await sharp({
    create: {
      width:  w,
      height: h,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  }).png().toBuffer();

  return await sharp(pngBuffer)
    .ensureAlpha()
    .composite([{ input: slotMask, left: x, top: y, blend: 'dest-out' }])
    .png()
    .toBuffer();
}

async function polishOverlayForAd({ adId }) {
  if (!enabled()) return { skipped: true, reason: 'AI_OVERLAY_POLISH_ENABLED=false or Gemini not configured' };
  if (!adId)      throw new Error('adId required');

  const ad = await Ad.findById(adId)
    .select('_id brandId kind renderUrl cloudinaryPublicId mediaId productId template aspectRatio aiCanvasArtifactId')
    .lean();
  if (!ad)                              return { skipped: true, reason: 'Ad not found' };
  if (ad.kind !== 'video')              return { skipped: true, reason: 'Ad is not video' };
  if (!ad.aiCanvasArtifactId)           return { skipped: true, reason: 'no aiCanvasArtifactId — V1 or non-eager-prime path' };
  if (!ad.cloudinaryPublicId)           return { skipped: true, reason: 'no cloudinaryPublicId — cannot locate overlay PNG' };

  // Resolve the media zone rect from the canvas spec. Same loose
  // filter the composite path uses — any kind:'media' zone with a
  // rect counts, alt-crop slots excluded.
  const canvas = await AiCanvasArtifact.findById(ad.aiCanvasArtifactId)
    .select('canvasSpec.zones canvasSpec.canvas')
    .lean();
  const zones = canvas?.canvasSpec?.zones || [];
  const candidates = zones.filter(z => {
    if (z.kind !== 'media' || !z.rect) return false;
    const slot = z.slot || '';
    if (typeof slot === 'string' && slot.startsWith('product.hero_media.crops.')) return false;
    return true;
  });
  if (!candidates.length) return { skipped: true, reason: 'no media zone in canvas spec' };
  const heroSlotted = candidates.find(z => z.slot === 'product.hero_media');
  const slotZone = heroSlotted || candidates.sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h))[0];
  const slotRect = slotZone.rect;
  const canvasW = canvas.canvasSpec?.canvas?.width  || 1000;
  const canvasH = canvas.canvasSpec?.canvas?.height || 1000;

  // Pull the overlay PNG via its Cloudinary URL and hand it to Nano Banana.
  const overlayUrl = buildCloudinaryImageUrl(ad.cloudinaryPublicId);
  if (!overlayUrl) return { skipped: true, reason: 'CLOUDINARY_CLOUD_NAME not set' };

  const prompt = buildPolishPrompt(slotRect);
  const t0 = Date.now();
  let polishedPng;
  try {
    polishedPng = await trackLlmCall(
      {
        stage:      'overlay_polish',
        provider:   'gemini',
        model:      'gemini-2.5-flash-image',
        purposeTag: 'overlay_polish',
        brandId:    ad.brandId,
        mediaId:    ad.mediaId,
        productId:  ad.productId,
        cacheKey:   String(ad._id),
        visionImages: 1
      },
      () => gemini.polishImage(prompt, overlayUrl)
    );
  } catch (err) {
    console.warn(`   ⚠️  overlay-polish gemini call failed for ad=${adId}: ${err.message}`);
    return { skipped: true, reason: `gemini polish failed: ${err.message}` };
  }

  // Enforce transparency at the slot regardless of what Nano Banana
  // produced. If it preserved alpha, this is a no-op for those
  // pixels; if it painted over the slot, sharp re-cuts the hole.
  let punchedPng;
  try {
    punchedPng = await punchTransparentSlot(polishedPng, slotRect, canvasW, canvasH);
  } catch (err) {
    console.warn(`   ⚠️  overlay-polish sharp punch failed for ad=${adId}: ${err.message}`);
    return { skipped: true, reason: `sharp post-process failed: ${err.message}` };
  }

  // Upload polished overlay → get a new publicId for the composite.
  let uploaded;
  try {
    uploaded = await uploadBufferToCloudinary(punchedPng, {
      folder: 'liquidretail/ai_overlay_polished'
    });
  } catch (err) {
    console.warn(`   ⚠️  overlay-polish upload failed for ad=${adId}: ${err.message}`);
    return { skipped: true, reason: `cloudinary upload failed: ${err.message}` };
  }

  // Rebuild the composite URL with the polished overlay. Reuses
  // renderService.composeVideoOutput so the chain (source video →
  // smart-crop → c_fill → overlay) stays identical except for the
  // overlay publicId.
  const sourceMedia = await Media.findById(ad.mediaId)
    .select('fileType fileUrl latestArtifacts')
    .lean();
  if (!sourceMedia) return { skipped: true, reason: 'source Media not found' };

  const renderService = require('./renderService');
  const composite = await renderService.composeVideoOutput({
    media:              sourceMedia,
    template:           ad.template,
    aspectRatio:        ad.aspectRatio,
    overlayUrl:         uploaded.secure_url,
    overlayPublicId:    uploaded.public_id,
    aiCanvasArtifactId: String(ad.aiCanvasArtifactId)
  });
  if (!composite?.compositeUrl) return { skipped: true, reason: 'composeVideoOutput returned null' };

  await Ad.updateOne(
    { _id: ad._id },
    { $set: { renderUrl: composite.compositeUrl, updatedAt: new Date() } }
  );

  const elapsedMs = Date.now() - t0;
  console.log(
    `🎨 overlay-polish ad=${ad._id} ` +
    `slot=${slotRect.x},${slotRect.y},${slotRect.w}×${slotRect.h} ` +
    `new_composite_len=${composite.compositeUrl.length} took=${elapsedMs}ms`
  );

  return { ok: true, renderUrl: composite.compositeUrl, elapsedMs };
}

(function logConfig() {
  console.log(
    `🎨 aiOverlayPolishService config — ` +
    `enabled=${enabled()} ` +
    `gemini=${gemini.isEnabled()}`
  );
})();

module.exports = { polishOverlayForAd, enabled };
