#!/usr/bin/env node
//
// dryRunVideoSubmit.js — build everything a video generation WOULD send
// to Atlas for an ad (resolved model, reference-image stack, Ken Burns
// prompt, request body, cost estimate) and print it instead of POSTing.
// Zero API spend; needs only MongoDB access.
//
// Usage:
//   node scripts/dryRunVideoSubmit.js <adId> [--prompt "operator refinement"] [--model <slug>]
//
// Checks worth eyeballing in the output:
//   - model: reflects the CatalogProduct/Brand videoSettings overrides
//     (per-canvas first), optional --model override, and falls back to the
//     Gemini Omni default; formats outside an Omni model's 16:9/9:16 route
//     to the Grok 1.5 fallback; r2v needs a video seed
//   - images: 1–7 entries, seed first, then product hero + alts in
//     stored order (default count 3)
//   - body.duration === 8 for the gemini-omni paramShape
//   - prompt bytes < the model's promptByteCap
//   - estimated costUsd matches expectations for the model/resolution

require('dotenv').config();
const mongoose = require('mongoose');

const Ad             = require('../models/Ad');
const Media          = require('../models/Media');
const Brand          = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const {
  resolveModelAndAspect,
  resolveReferenceImageCount,
  resolveDurationSec,
  estimateRenderCostUsd,
  buildSubmissionBody,
  buildReferenceImages,
  buildVideoSegmentUrl
} = require('../services/atlasVideoService');
const { buildVeoPrompt, aspectRatioForPlatformFormat, promptProfileFor } = require('../services/veoPromptBuilder');

(async () => {
  const args = process.argv.slice(2);
  const adId = args[0];
  const promptFlagIdx = args.indexOf('--prompt');
  const operatorPrompt = promptFlagIdx >= 0 ? (args[promptFlagIdx + 1] || null) : null;
  const modelFlagIdx = args.indexOf('--model');
  const modelOverride = modelFlagIdx >= 0 ? (args[modelFlagIdx + 1] || null) : null;
  if (!adId) { console.error('Usage: node scripts/dryRunVideoSubmit.js <adId> [--prompt "refinement"] [--model <slug>]'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);

  const ad = await Ad.findById(adId).lean();
  if (!ad) { console.error(`Ad ${adId} not found`); await mongoose.disconnect(); process.exit(1); }

  const media = await Media.findById(ad.mediaId).lean();
  if (!media) { console.error(`Media ${ad.mediaId} not found`); await mongoose.disconnect(); process.exit(1); }

  const [brand, product, catalogMedias] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    ad.productId
      ? Media.find({ source: 'catalog-product', 'metadata.catalogProductId': ad.productId })
          .select('_id fileUrl classification metadata width height').sort({ createdAt: 1 }).lean()
      : []
  ]);

  // Same resolution sequence as atlasVideoService.generateForAd.
  const platformAspect = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const { model, caps, aspectRatio, fallback } = resolveModelAndAspect({
    brand, product, canvasKeys: [ad.platformFormat, platformAspect],
    platformAspect, modelOverride, hasVideoSeed: media.fileType === 'video'
  });

  const referenceCount = resolveReferenceImageCount({ brand, product });
  // Dry run must never spend: force the generative reframe OFF so the async
  // builder returns deterministic Cloudinary crops (no billable outpaint).
  process.env.REFRAME_ENABLED = 'false';
  const imageUrls = await buildReferenceImages({ media, product, catalogMedias, aspectRatio, caps, referenceCount, brand });
  const hasProductAnchor = imageUrls.length >= 2;
  const seedHasText = Array.isArray(media.text) && media.text.length > 0;

  // Same per-ad duration resolution as generateForAd (wizard-stamped
  // Ad.videoDurationSec, clamped/enum-snapped to the model's caps).
  const durationSec = resolveDurationSec(ad.videoDurationSec, caps);

  const prompt = buildVeoPrompt({
    concept: null, brand, product, media,
    aspectRatio, seedHasText,
    hasProductReference: hasProductAnchor,
    operatorPrompt, storyboard: null, caps, durationSec
  });

  const videoClipUrl = caps.paramShape === 'gemini-omni-r2v'
    ? (buildVideoSegmentUrl(media.fileUrl, aspectRatio, durationSec) || media.fileUrl)
    : undefined;
  const body = buildSubmissionBody({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl, durationSec });
  const costUsd = estimateRenderCostUsd({
    model,
    durationSec: body.duration || caps.defaultDuration || 8,
    resolution:  body.resolution || caps.defaultResolution || '720p'
  });

  console.log('=== Resolution ===');
  console.log(JSON.stringify({
    adId: ad._id,
    platformFormat: ad.platformFormat || null,
    requestedAspect: platformAspect,
    resolvedAspect: aspectRatio,
    model,
    modelOverride,
    fallback: fallback || null,
    paramShape: caps.paramShape,
    // MUST pass the destination. promptProfileFor(caps) alone ignores it and
    // would report 'gemini-omni' for a Meta or PMax ad whose real submit uses
    // 'hook_first' — a diagnostic that lies about the live path is worse than
    // no diagnostic. Mirrors generateForAd's `platformFormat: ad.platformFormat`.
    promptProfile: promptProfileFor(caps, { platformFormat: ad.platformFormat || null }),
    brandOverride: brand?.videoSettings || null,
    productOverride: product?.videoSettings || null,
    referenceCount,
    estCostUsd: costUsd
  }, null, 2));

  console.log(`\n=== Reference images (${imageUrls.length}) ===`);
  imageUrls.forEach((u, i) => console.log(`  [${i}] ${u}`));

  if (videoClipUrl) {
    console.log(`\n=== Video clip URL ===`);
    console.log(videoClipUrl);
  }

  const bytes = Buffer.byteLength(prompt, 'utf8');
  console.log(`\n=== Prompt (chars=${prompt.length} bytes=${bytes} cap=${caps.promptByteCap || 4096} ${bytes < (caps.promptByteCap || 4096) ? 'OK' : 'OVER CAP'}) ===`);
  console.log(prompt);

  console.log('\n=== Request body (NOT sent) ===');
  console.log(JSON.stringify(body, null, 2));

  await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
