// renderService — the video-composite helper for AI-template video ads.
//
// This used to be a single-entry render pipeline (renderCreative → derive /
// validate / render (Puppeteer) / upload / persist) that rendered a queued
// Ad doc directly, plus a legacy HTML/spec fallback (renderViaSpec /
// renderViaHtml) fetching a frontend `/ads.html` page. Both are deleted —
// adgen owns rendering unconditionally now; nothing in this repo still
// dispatches a static or video render in-process. See session.d/ for the
// removal.
//
// What remains is composeVideoOutput: given an already-rendered overlay PNG
// and a source video Media doc, build the Cloudinary video-composite URL
// that layers the overlay over a smart-cropped clip of the source. Its one
// live caller is services/aiOverlayPolishService.js (itself gated off by
// AI_OVERLAY_POLISH_ENABLED, a separate and unrelated flag — see CLAUDE.md
// §1 "Cloudinary video compositing").

const CropArtifact          = require('../models/CropArtifact');
const registry              = require('./templateRegistry');
const { buildVideoCompositeUrl } = require('./videoCompositeService');

// ── Tunables ─────────────────────────────────────────────────────────

// Canvas dimensions per ratio — must match templatePreview.applyCanvasSize.
// Phase 1A render stage delivers these as the screenshot dimensions.
const CANVAS_DIMS = {
  '1:1':    { w: 1000, h: 1000 },
  '4:5':    { w: 1000, h: 1250 },
  '9:16':   { w: 1000, h: 1778 },
  '16:9':   { w: 1000, h: 563  },
  '1.91:1': { w: 1000, h: 524  }
};


// ── Video composite helper ───────────────────────────────────────────

// For AI templates the canvas spec is emitted per-ad by the LLM.
// Read the matching AiCanvasArtifact (same cartesian key the render
// pipeline used) and find the zone that should be punched through
// for the source video. Picks the LARGEST media zone whose slot
// resolves to product.hero_media (the only slot whose URL has a
// video twin — alt-crop slots are image-only). Returns canvasDims
// + slotZone, or null when no eligible zone is present (LLM emitted
// no media zone, or only alt-crop media — composite path bails and
// the static PNG ships).
async function pickHeroMediaZoneFromAiArtifact({
  aiCanvasArtifactId,
  mediaId, template, aspectRatio,
  productId, variantKind, paletteSource, creativeStyle, campaignContextHash
}) {
  const AiCanvasArtifact = require('../models/AiCanvasArtifact');
  // Two-pass lookup. Pass 1 — direct FK when renderStage captured the
  // canvas id during the eager prime. Pass 2 — legacy 8-field cartesian
  // reconstruction for paths that don't carry the FK (V1 ads, non-
  // eager-prime renders). Pass 1 fixes the silent under-match where
  // creativeStyle and campaignContextHash aren't reliably populated
  // on the render request (computed at queue time, not stored on the
  // Ad doc).
  let artifact = null;
  if (aiCanvasArtifactId) {
    artifact = await AiCanvasArtifact.findById(aiCanvasArtifactId).lean();
  }
  if (!artifact) {
    let resolvedCreativeStyle = creativeStyle;
    if (!resolvedCreativeStyle) {
      const aiNorm = registry.getNormalized(template);
      resolvedCreativeStyle = aiNorm?.creativeStyle || null;
    }
    const filter = {
      mediaId, template, aspectRatio,
      productId:           productId           || null,
      variantKind:         variantKind         || null,
      paletteSource:       paletteSource       || 'media',
      creativeStyle:       resolvedCreativeStyle,
      campaignContextHash: campaignContextHash || null
    };
    artifact = await AiCanvasArtifact.findOne(filter).lean();
  }
  if (!artifact?.canvasSpec) return null;

  const spec = artifact.canvasSpec;
  const canvasDims = {
    w: spec.canvas?.width  || CANVAS_DIMS[aspectRatio]?.w || 1000,
    h: spec.canvas?.height || CANVAS_DIMS[aspectRatio]?.h || 1000
  };
  // Filter zones to those that slot the source media's hero (alt-crop
  // slots like product.hero_media.crops.1_91_1 use a still image, no
  // video twin, so they don't get the composite treatment).
  //
  // Slot filter is intentionally loose. Brand campaigns (no productId)
  // produce specs where the LLM picks slot 'source_media.fileUrl' or
  // leaves slot null while still emitting a kind:'media' zone with a
  // rect — the composite just needs a rectangular media region to
  // position the source video, the slot path itself doesn't matter
  // for layered composition. Excludes only alt-crop slots
  // (product.hero_media.crops.*) which point at still-image variants
  // that have no video twin.
  const candidates = (spec.zones || []).filter(z => {
    if (z.kind !== 'media' || !z.rect) return false;
    const slot = z.slot || '';
    if (typeof slot === 'string' && slot.startsWith('product.hero_media.crops.')) return false;
    return true;
  });
  if (!candidates.length) return null;
  // Prefer a hero-slotted zone when present; otherwise the largest by
  // area. Brand campaigns typically have a single media zone so this
  // picks it; product campaigns with hero + alts get the hero.
  const heroSlotted = candidates.find(z => z.slot === 'product.hero_media');
  const slotZone = heroSlotted || candidates.sort((a, b) =>
    (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h)
  )[0];
  return { canvasDims, slotZone };
}

// Pick the base smart-crop ratio (5:4 / 1:1 / 4:5) closest to the
// slot's shape. Mirrors layoutInputService.pickHeroSourceRatio so the
// cropped clip matches the source crop the layout input was built
// against. Returns '1:1' as a sane default when the rect is missing.
function _pickClosestBaseRatio(rect) {
  if (!rect?.w || !rect?.h) return '1:1';
  const target = rect.w / rect.h;
  const opts = [
    { name: '5:4', value: 5/4 },
    { name: '1:1', value: 1   },
    { name: '4:5', value: 4/5 }
  ];
  let best = opts[0], bestDiff = Math.abs(opts[0].value - target);
  for (const o of opts) {
    const d = Math.abs(o.value - target);
    if (d < bestDiff) { bestDiff = d; best = o; }
  }
  return best.name;
}

async function composeVideoOutput({
  media, template, aspectRatio, overlayUrl, overlayPublicId,
  aiCanvasArtifactId,
  productId, variantKind, paletteSource, creativeStyle, campaignContextHash
}) {
  // Resolve canvas dims + the hero-media slot rect. Hand-authored
  // templates have these in registry.CANVAS; AI templates emit them
  // per-ad — we read back the AiCanvasArtifact this render used.
  let canvasDims, slotZone;
  if (registry.isAi(template)) {
    const aiPick = await pickHeroMediaZoneFromAiArtifact({
      aiCanvasArtifactId,
      mediaId:             media._id,
      template,
      aspectRatio,
      productId,
      variantKind,
      paletteSource,
      creativeStyle,
      campaignContextHash
    });
    if (!aiPick) return null;
    canvasDims = aiPick.canvasDims;
    slotZone   = aiPick.slotZone;
  } else {
    const canvasVariant = registry.CANVAS?.templates?.[template]?.variants?.[aspectRatio];
    if (!canvasVariant) return null;
    canvasDims = { w: canvasVariant.canvas?.width, h: canvasVariant.canvas?.height };
    slotZone = (canvasVariant.zones || []).find(z =>
      z.kind === 'media' && z.slot === 'product.hero_media');
  }
  if (!slotZone?.rect) return null;

  const cropDoc = media.latestArtifacts?.crops
    ? await CropArtifact.findById(media.latestArtifacts.crops).lean()
    : null;
  // Pick the smart-crop ratio that matches the CANVAS aspect, not the
  // slot rect's aspect. Cloudinary's video composite output dimensions
  // equal the smart-crop bbox dims (it won't upscale), and the
  // <video> element displays the resulting MP4 in a canvas-aspect
  // container. Slot-aspect smart crops produce off-aspect MP4s that
  // get pillarboxed / letterboxed in the player. Canvas-aspect crops
  // produce MP4s that fill the player without bars; the slot rect's
  // role becomes purely positioning the chrome in the overlay PNG
  // (the chrome's transparent region matches where the slot lands on
  // canvas, so the visible video portion still aligns with the slot).
  const slotRatio = _pickClosestBaseRatio({ w: canvasDims.w, h: canvasDims.h });
  const winnerId = cropDoc?.winners?.[slotRatio] || null;
  const list = cropDoc?.smartCrops?.[slotRatio] || [];
  const winner = list.find(c => c.id === winnerId) || list[0] || null;
  let smartCropBbox = winner ? {
    x1: Number(winner.x1), y1: Number(winner.y1),
    x2: Number(winner.x2), y2: Number(winner.y2)
  } : null;

  // Validate the smart-crop bbox against the actual source dimensions.
  // If the bbox exceeds source bounds Cloudinary's c_crop silently
  // clips the requested region to the available area — output is
  // smaller than requested — and the downstream c_lpad,w_X,h_X,b_black
  // pads the missing pixels with BLACK. That's exactly the right-side
  // (or bottom) black-bar pattern that's been showing up on video ads
  // even after the canvas-aspect smart-crop fix (ae79285). Root cause
  // is a coordinate-space mismatch: the smart-crop service produced
  // bbox values in a space that doesn't match Cloudinary's served
  // video resolution (could be normalized coords misinterpreted as
  // pixels, or computed on a max-res version when Cloudinary serves
  // a downscaled stream). Discard out-of-bounds bboxes and let the
  // geometric centered-crop fallback below handle it instead.
  if (smartCropBbox && media?.width && media?.height) {
    const srcW = Number(media.width);
    const srcH = Number(media.height);
    const inBounds =
      smartCropBbox.x1 >= 0 && smartCropBbox.y1 >= 0 &&
      smartCropBbox.x2 <= srcW && smartCropBbox.y2 <= srcH &&
      smartCropBbox.x2 > smartCropBbox.x1 &&
      smartCropBbox.y2 > smartCropBbox.y1;
    if (!inBounds) {
      console.log(
        `   📐 composeVideoOutput: smart-crop bbox ` +
        `${smartCropBbox.x1},${smartCropBbox.y1}→${smartCropBbox.x2},${smartCropBbox.y2} ` +
        `exceeds source ${srcW}×${srcH} for media=${media._id} — discarding, will use geometric centered crop`
      );
      smartCropBbox = null;
    }
  }

  // Fallback when the smart-crop pipeline didn't produce a crop for the
  // canvas ratio (cropDoc missing entirely OR smartCrops[slotRatio]
  // empty) OR the bbox we got was out-of-bounds and got discarded above.
  // Without this, videoCompositeService skips c_crop and falls through
  // to c_lpad against the SOURCE video at canvas dims — which for a
  // portrait 9:16 source on a 1:1 canvas produces black side bars
  // because the source aspect doesn't match. Compute a centered canvas-
  // aspect bbox from media.width / media.height so the video output is
  // square regardless of source orientation. Same intent the smart-crop
  // service would produce, just without subject-aware framing.
  if (!smartCropBbox && media?.width && media?.height) {
    const srcW = Number(media.width);
    const srcH = Number(media.height);
    const targetRatio = canvasDims.w / canvasDims.h;
    let bbW, bbH;
    if (srcW / srcH > targetRatio) {
      // Source is wider than target — crop horizontally
      bbH = srcH;
      bbW = Math.round(srcH * targetRatio);
    } else {
      // Source is taller than target — crop vertically
      bbW = srcW;
      bbH = Math.round(srcW / targetRatio);
    }
    const bbX = Math.round((srcW - bbW) / 2);
    const bbY = Math.round((srcH - bbH) / 2);
    smartCropBbox = { x1: bbX, y1: bbY, x2: bbX + bbW, y2: bbY + bbH };
    console.log(
      `   📐 composeVideoOutput: no smart-crop for ratio ${slotRatio} on media=${media._id} — ` +
      `falling back to centered canvas-aspect bbox ${bbW}×${bbH} from source ${srcW}×${srcH}`
    );
  }

  const compositeUrl = buildVideoCompositeUrl({
    sourceVideoUrl:  media.fileUrl,
    overlayPublicId,
    overlayImageUrl: overlayUrl,
    canvasDims,
    slotRect: slotZone.rect,
    smartCropBbox,
    sourceDims: media?.width && media?.height
      ? { w: media.width, h: media.height }
      : null
  });
  if (!compositeUrl) return null;
  return { compositeUrl, slotRect: slotZone.rect, canvasDims, smartCropBbox };
}

module.exports = {
  composeVideoOutput
};
