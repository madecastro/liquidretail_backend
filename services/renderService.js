// renderService — turns one creative entry from a RenderCampaignJob
// into a rendered Ad doc. Single function entry: renderCreative(req).
//
// Pipeline (5 stages, each with its own error.stage label):
//
//   derive    → buildLayoutInput / load LayoutInputArtifact
//   validate  → templateRegistry.validateInputAgainstTemplate
//   render    → Puppeteer screenshot of /ads.html?...&renderMode=1
//   upload    → Cloudinary, folder ads/{brandId}/{campaignId}
//   persist   → Ad.create + de-dupe by derivationDigest
//
// V1 simplifications (matching the deferred render-service plan):
//   - kind is always 'image' — even for video-source media, we render
//     a static PNG using the source's poster frame as the rendered
//     background. Phase 2 adds true video output (MP4 via FFmpeg
//     composite of source video + overlay PNG).
//   - render + upload stages are STUBBED with Phase-1A placeholders
//     so the contract + persistence path can ship and be exercised
//     end-to-end before the Puppeteer/Cloudinary heavy lifting lands.
//   - Pre-flight via templateRegistry.validateInputAgainstTemplate;
//     skipped renders never touch Cloudinary.
//
// derivationDigest is sha256 of a canonical-form payload of
// {copy, cta, mediaId, template, aspectRatio} so re-rendering with
// identical inputs returns the existing Ad rather than uploading a
// duplicate to Cloudinary.

const crypto = require('crypto');

const Ad                    = require('../models/Ad');
const Media                 = require('../models/Media');
const CatalogProduct        = require('../models/CatalogProduct');
const LayoutInputArtifact   = require('../models/LayoutInputArtifact');
const registry              = require('./templateRegistry');
const { buildLayoutInput }  = require('./layoutInputService');

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

// ── Public API ───────────────────────────────────────────────────────

async function renderCreative(req) {
  const jobId = req.jobId || crypto.randomBytes(8).toString('hex');

  // 1. derive — build / load the LayoutInputArtifact
  let input, layoutInputArtifactId;
  try {
    const r = await deriveStage(req);
    input = r.input;
    layoutInputArtifactId = r.layoutInputArtifactId;
  } catch (err) {
    return failed(jobId, 'derive', err);
  }

  // 2. validate — pre-flight against the template's normalized validation
  const validation = registry.validateInputAgainstTemplate(input, req.creative.template);
  if (!validation.ok) {
    const reasons = [];
    if (validation.missing?.length)         reasons.push(`missing=${validation.missing.join(',')}`);
    if (validation.anyOfFailures?.length)   reasons.push(`anyOf failed=${validation.anyOfFailures.length}`);
    if (validation.minCountFailures && Object.keys(validation.minCountFailures).length) {
      reasons.push(`minCount=${Object.keys(validation.minCountFailures).join(',')}`);
    }
    return { jobId, status: 'skipped', skipReason: `template validation: ${reasons.join('; ') || 'unknown'}` };
  }

  // 3. de-dupe — has this exact creative been rendered before?
  const derivationDigest = computeDerivationDigest(input, req);
  const existing = await Ad.findOne({
    campaignId: req.campaignId,
    derivationDigest
  }).lean();
  if (existing) {
    return success(jobId, existing);
  }

  // 4. render — Puppeteer screenshot (STUBBED in Phase 1A)
  let renderOutput;
  try {
    renderOutput = await renderStage({
      layoutInputArtifactId,
      template:    req.creative.template,
      aspectRatio: req.creative.aspectRatio,
      expectedKind: req.creative.expectedKind
    });
  } catch (err) {
    return failed(jobId, 'render', err);
  }

  // 5. upload — Cloudinary (STUBBED in Phase 1A)
  let upload;
  try {
    upload = await uploadStage(renderOutput, {
      brandId:    req.brandId,
      campaignId: req.campaignId,
      mediaId:    req.creative.mediaId,
      template:   req.creative.template,
      aspectRatio: req.creative.aspectRatio
    });
  } catch (err) {
    return failed(jobId, 'upload', err);
  }

  // 6. persist — Ad doc
  let ad;
  try {
    ad = await persistStage({
      req,
      input,
      layoutInputArtifactId,
      derivationDigest,
      renderOutput,
      upload
    });
  } catch (err) {
    return failed(jobId, 'persist', err);
  }

  return success(jobId, ad.toObject ? ad.toObject() : ad);
}

// ── Stages ───────────────────────────────────────────────────────────

async function deriveStage(req) {
  const { mediaId, template, aspectRatio } = req.creative;
  // buildLayoutInput is the canonical entry — handles cache hit /
  // re-derive based on INPUT_SCHEMA_VERSION + the refresh option.
  // Threads campaignKind + cta into derivation options so the prompt
  // can flip to brand-mode copy or compose a CTA-aware imperative.
  const input = await buildLayoutInput({
    mediaId,
    template,
    aspectRatio,
    refresh: !!req.options?.refresh,
    options: {
      campaignKind: req.campaignKind || null,
      ctaText:      req.cta?.text     || null,
      ctaUrl:       req.cta?.url      || null
    }
  });

  // Look up the artifact id so the Ad doc can FK back to it without
  // having to re-find it later. buildLayoutInput upserts the artifact
  // by (mediaId, template, aspectRatio) so this find is a single hit.
  const artifact = await LayoutInputArtifact
    .findOne({ mediaId, template, aspectRatio })
    .select('_id')
    .lean();

  return { input, layoutInputArtifactId: artifact?._id || null };
}

// PHASE-1A STUB. Real implementation: spin up Puppeteer, navigate to
// /ads.html?media=X&template=Y&ratio=Z&renderMode=1, wait for the
// renderer's "ready" signal (window.__tpRenderReady === true), screenshot
// the #tpStage element. For video-source media, the rendered HTML
// already paints the source video as background via <video autoplay
// loop>; the screenshot captures one frame as the static V1 ad.
async function renderStage({ layoutInputArtifactId, template, aspectRatio, expectedKind }) {
  const dims = CANVAS_DIMS[aspectRatio] || { w: 1000, h: 1000 };
  // Placeholder: 1×1 transparent PNG. Production swap-in is a real
  // Puppeteer screenshot at canvas dims; everything downstream
  // (upload + persist) consumes the buffer through the same shape.
  const buffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
    'base64'
  );
  return {
    buffer,
    contentType: 'image/png',
    width:  dims.w,
    height: dims.h,
    bytes:  buffer.length,
    kind:   'image'   // V1 always image; Phase 2 may set 'video'
  };
}

// PHASE-1A STUB. Real implementation: cloudinary.uploader.upload_stream
// with options { folder, public_id, resource_type, overwrite: true }.
// Public ID format keeps duplicates trivially diff-able.
async function uploadStage(renderOutput, ctx) {
  const folder = `ads/${ctx.brandId}/${ctx.campaignId}`;
  const shortMedia = String(ctx.mediaId).slice(-8);
  const publicId = `${ctx.aspectRatio.replace(/[:.]/g, '_')}-${ctx.template}-${shortMedia}`;
  const fakeUrl = `https://res.cloudinary.com/PLACEHOLDER/image/upload/${folder}/${publicId}.png`;
  return {
    cloudinaryPublicId: `${folder}/${publicId}`,
    renderUrl: fakeUrl,
    posterUrl: null,
    bytes:     renderOutput.bytes,
    width:     renderOutput.width,
    height:    renderOutput.height,
    durationMs: null
  };
}

async function persistStage({ req, input, layoutInputArtifactId, derivationDigest, renderOutput, upload }) {
  const copy = extractCopySnapshot(input);
  return Ad.create({
    brandId:               req.brandId,
    campaignId:            req.campaignId,
    campaignRunId:         req.campaignRunId,
    layoutInputArtifactId,
    mediaId:               req.creative.mediaId,
    productId:             req.creative.productId || null,
    template:              req.creative.template,
    aspectRatio:           req.creative.aspectRatio,
    mediaSource:           req.creative.mediaSource,
    campaignKind:          req.campaignKind || null,
    kind:                  renderOutput.kind || 'image',
    renderUrl:             upload.renderUrl,
    posterUrl:             upload.posterUrl,
    cloudinaryPublicId:    upload.cloudinaryPublicId,
    width:                 upload.width,
    height:                upload.height,
    bytes:                 upload.bytes,
    durationMs:            upload.durationMs,
    copy,
    ctaUrl:                req.cta?.url    || '',
    ctaUrlParams:          req.cta?.params || '',
    status:                'draft',
    derivationDigest,
    generatedAt:           new Date()
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

// Stable canonical-form sha256 over the inputs that determine the
// rendered output. Two creatives with the same digest = same render,
// so we skip and return the existing Ad doc.
function computeDerivationDigest(input, req) {
  const payload = {
    mediaId:     req.creative.mediaId,
    template:    req.creative.template,
    aspectRatio: req.creative.aspectRatio,
    cta: {
      text:   req.cta?.text   || '',
      url:    req.cta?.url    || '',
      params: req.cta?.params || ''
    },
    copy: {
      headline:      input?.copy?.headline       || '',
      headline_lead: input?.copy?.headline_lead  || '',
      headline_main: input?.copy?.headline_main  || '',
      subheadline:   input?.copy?.subheadline    || '',
      eyebrow:       input?.copy?.eyebrow        || '',
      quote:         input?.social_proof?.primary_quote?.text || '',
      cta_text:      input?.cta?.text            || ''
    },
    product: {
      name:  input?.product?.name  || '',
      price: input?.product?.price || ''
    }
  };
  const json = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 32);
}

function extractCopySnapshot(input) {
  const price = input?.product?.price;
  const priceStr = typeof price === 'string' ? price
                : typeof price === 'number'   ? `$${price.toFixed(2)}`
                : (price?.display || '');
  return {
    headline:     input?.copy?.headline                    || '',
    cta_text:     input?.cta?.text                         || '',
    quote:        input?.social_proof?.primary_quote?.text || '',
    productName:  input?.product?.name                     || '',
    productPrice: priceStr
  };
}

function failed(jobId, stage, err) {
  return {
    jobId,
    status: 'failed',
    error: {
      stage,
      message:   err.message || String(err),
      retryable: stage !== 'validate'   // validate failures are surfaced as 'skipped' separately
    }
  };
}

function success(jobId, ad) {
  return {
    jobId,
    status: 'success',
    ad: {
      id:                    String(ad._id),
      layoutInputArtifactId: ad.layoutInputArtifactId ? String(ad.layoutInputArtifactId) : null,
      cloudinaryPublicId:    ad.cloudinaryPublicId,
      renderUrl:             ad.renderUrl,
      posterUrl:             ad.posterUrl,
      kind:                  ad.kind,
      width:                 ad.width,
      height:                ad.height,
      bytes:                 ad.bytes,
      durationMs:            ad.durationMs,
      derivationDigest:      ad.derivationDigest
    }
  };
}

module.exports = { renderCreative };
