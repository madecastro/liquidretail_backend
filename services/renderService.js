// renderService — renders one queued Ad doc. Single function entry:
// renderCreative(req). req.adId references an Ad with status='queued'
// (just transitioned to 'rendering' by the run loop); the service
// updates the SAME doc in place rather than creating a new one.
//
// Pipeline (5 stages, each with its own error.stage label):
//
//   derive    → buildLayoutInput / load LayoutInputArtifact
//   validate  → templateRegistry.validateInputAgainstTemplate
//   render    → Puppeteer screenshot of /ads.html?...&renderMode=1
//   upload    → Cloudinary, folder ads/{brandId}/{campaignId}
//   persist   → Ad.findByIdAndUpdate — backfill renderUrl, cloudinaryPublicId,
//               copy snapshot, dimensions; flip status → 'draft'
//
// Dedup: handled at queue time via the (campaignId, identityDigest)
// unique index on Ad. The render service no longer dedupes — by the
// time a queued Ad reaches us, it's already been verified unique.

const crypto = require('crypto');
const puppeteer = require('puppeteer');

const Ad                    = require('../models/Ad');
const Media                 = require('../models/Media');
const CatalogProduct        = require('../models/CatalogProduct');
const CropArtifact          = require('../models/CropArtifact');
const LayoutInputArtifact   = require('../models/LayoutInputArtifact');
const registry              = require('./templateRegistry');
const { buildLayoutInput }  = require('./layoutInputService');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { buildVideoCompositeUrl } = require('./videoCompositeService');

// Templates whose canvas variants have a clean media slot (kind:'media',
// slot:'product.hero_media'). Only these templates render as video in V1
// — full-bleed templates (testimonial_overlay, product_overlay) would
// need transparent pixels in the foreground and are deferred.
//
// AI templates (ai_*): composeVideoOutput resolves their canvas spec
// dynamically from AiCanvasArtifact (the LLM emits geometry per ad,
// not a static schema entry). If the LLM-emitted spec has a media
// zone slotting product.hero_media we composite that rect; otherwise
// composeVideoOutput returns null and the pipeline falls through to
// the static PNG.
const VIDEO_TEMPLATES = new Set([
  'ugc_split_screen',
  'testimonial_spotlight',
  'ai_brand_led',
  'ai_ugc_led',
  'ai_social_proof_led',
  'ai_editorial',
  'ai_promotional'
]);

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
  const { template, aspectRatio, mediaId } = req.creative || {};
  const tag = `[render ${req.campaignRunId || '-'}#${jobId}]`;

  // Load the queued Ad doc up front. identityDigest is needed for the
  // upload filename so re-renders of the same (campaign, identity)
  // overwrite the existing Cloudinary asset rather than orphaning.
  const adDoc = req.adId ? await Ad.findById(req.adId).select('identityDigest').lean() : null;
  const identityDigest = adDoc?.identityDigest || null;
  const stages = {};
  const t0 = Date.now();

  console.log(`🎬 ${tag} start — ${template}/${aspectRatio} media=${mediaId} product=${req.creative?.productId || '-'}`);

  // 1. derive — build / load the LayoutInputArtifact
  let input, layoutInputArtifactId;
  try {
    const t = Date.now();
    const r = await deriveStage(req);
    input = r.input;
    layoutInputArtifactId = r.layoutInputArtifactId;
    stages.derive = Date.now() - t;
    console.log(`   📐 ${tag} derive ok in ${stages.derive}ms (artifact=${layoutInputArtifactId || 'none'})`);
  } catch (err) {
    console.error(`   ❌ ${tag} derive: ${err.message || err}`);
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
    const reason = `template validation: ${reasons.join('; ') || 'unknown'}`;
    console.log(`   ⏭️  ${tag} skipped — ${reason}`);
    return { jobId, status: 'skipped', skipReason: reason };
  }

  // Dedup is handled at queue time via the (campaignId, identityDigest)
  // unique index — same inputs never produce two queued Ad docs in the
  // first place. No per-render dedup check needed.

  // Decide image vs video branch. Video requires (a) source Media is
  // a video, (b) the template has a media slot we can punch through.
  // When (a) is true but (b) isn't, fall back to the static-image path
  // — runVideoPipeline already populated layoutInput with a hero-frame
  // image, so the static render produces a valid (still) creative.
  const sourceMedia = await Media.findById(req.creative.mediaId).select('fileType fileUrl latestArtifacts').lean();
  const isVideoSource = sourceMedia?.fileType === 'video';
  const supportsVideoTemplate = VIDEO_TEMPLATES.has(req.creative.template);
  const useVideoBranch = isVideoSource && supportsVideoTemplate && sourceMedia?.fileUrl?.includes('/video/upload/');

  // Phase 2 V2 flag — look up the campaign to see whether to dispatch
  // through the new Director-driven Generator. Cheap select; no LLM.
  let aiCreativeV2 = false;
  let creativeIntent = null;
  let campaignKind = null;
  if (req.campaignId) {
    try {
      const Campaign = require('../models/Campaign');
      const camp = await Campaign.findById(req.campaignId).select('aiCreativeV2Enabled creativeIntent kind').lean();
      aiCreativeV2   = !!camp?.aiCreativeV2Enabled;
      creativeIntent = camp?.creativeIntent || null;
      campaignKind   = camp?.kind || null;
    } catch (_) { /* default to V1 path */ }
  }

  // 4. render — Puppeteer screenshot
  let renderOutput;
  try {
    const t = Date.now();
    renderOutput = await renderStage({
      layoutInputArtifactId,
      template:     req.creative.template,
      aspectRatio:  req.creative.aspectRatio,
      expectedKind: req.creative.expectedKind,
      mediaId:      req.creative.mediaId,
      brandId:      req.brandId,
      authToken:    req.authToken || null,
      renderMode:   useVideoBranch ? 'video-overlay' : 'static',
      // V2 routing — only set when the campaign opted in. The legacy
      // pipeline is unaffected for unflagged campaigns.
      aiCreativeV2,
      creativeIntent,
      campaignKind,
      productId:    req.creative.productId || null,
      // Phase 6.5 — campaign run id mixed into pickConceptForCell's
      // hash downstream so concept rotates batch-over-batch.
      campaignRunId: req.campaignRunId || null
    });
    stages.render = Date.now() - t;
    console.log(`   🖼️  ${tag} render ok in ${stages.render}ms (${renderOutput.width}×${renderOutput.height}, ${Math.round(renderOutput.bytes/1024)}KB, mode=${useVideoBranch ? 'video-overlay' : 'static'})`);
  } catch (err) {
    console.error(`   ❌ ${tag} render: ${err.message || err}`);
    return failed(jobId, 'render', err);
  }

  // 5. upload — Cloudinary. For video, the uploaded PNG is the OVERLAY
  // (transparent in the media slot); we then build a Cloudinary video
  // composite URL that layers it over the cropped source video.
  let upload;
  try {
    const t = Date.now();
    upload = await uploadStage(renderOutput, {
      brandId:          req.brandId,
      campaignId:       req.campaignId,
      mediaId:          req.creative.mediaId,
      template:         req.creative.template,
      aspectRatio:      req.creative.aspectRatio,
      identityDigest,
      isOverlay:        useVideoBranch
    });
    stages.upload = Date.now() - t;
    console.log(`   ☁️  ${tag} upload ok in ${stages.upload}ms (publicId=${upload.cloudinaryPublicId})`);
  } catch (err) {
    console.error(`   ❌ ${tag} upload: ${err.message || err}`);
    return failed(jobId, 'upload', err);
  }

  // 5b. video composite — chain Cloudinary transforms to overlay the
  // PNG on the source video. Failure here falls through to the static
  // PNG output (the renderUrl just stays the PNG, kind stays 'image')
  // so video doesn't completely block the run.
  let videoComposite = null;
  if (useVideoBranch) {
    try {
      videoComposite = await composeVideoOutput({
        media:            sourceMedia,
        template:         req.creative.template,
        aspectRatio:      req.creative.aspectRatio,
        overlayUrl:       upload.renderUrl,
        overlayPublicId:  upload.cloudinaryPublicId,
        // Cartesian keys — needed for AI templates so we can find the
        // exact AiCanvasArtifact whose spec drove this render. Without
        // these we'd pick "most recent" and risk grabbing a stale spec
        // from a different variant.
        productId:           req.creative.productId           || null,
        variantKind:         req.creative.variantKind         || null,
        paletteSource:       req.creative.paletteSource       || 'media',
        creativeStyle:       req.creative.creativeStyle       || null,
        campaignContextHash: req.creative.campaignContextHash || null
      });
      if (videoComposite) {
        console.log(`   🎞️  ${tag} video composite ok (${videoComposite.compositeUrl.length} chars)`);
      } else {
        console.warn(`   ⚠️  ${tag} video composite returned null — falling back to static PNG`);
      }
    } catch (err) {
      console.warn(`   ⚠️  ${tag} video composite failed: ${err.message} — falling back to static PNG`);
      videoComposite = null;
    }
  }

  // 6. persist — Ad doc
  let ad;
  try {
    const t = Date.now();
    ad = await persistStage({
      req,
      input,
      layoutInputArtifactId,
      renderOutput,
      upload,
      videoComposite
    });
    stages.persist = Date.now() - t;
    console.log(`   💾 ${tag} persist ok in ${stages.persist}ms (Ad ${ad._id})`);
  } catch (err) {
    console.error(`   ❌ ${tag} persist: ${err.message || err}`);
    return failed(jobId, 'persist', err);
  }

  const totalMs = Date.now() - t0;
  console.log(`🎉 ${tag} done in ${totalMs}ms (derive=${stages.derive||0} render=${stages.render||0} upload=${stages.upload||0} persist=${stages.persist||0})`);
  return success(jobId, ad.toObject ? ad.toObject() : ad);
}

// ── Stages ───────────────────────────────────────────────────────────

async function deriveStage(req) {
  const { mediaId, template, aspectRatio } = req.creative;
  // buildLayoutInput is the canonical entry — handles cache hit /
  // re-derive based on INPUT_SCHEMA_VERSION + the refresh option.
  // Threads campaignKind + cta into derivation options so the prompt
  // can flip to brand-mode copy or compose a CTA-aware imperative.
  // variantKind + productId from the queued Ad drive the slot
  // assembly: variantKind='product_image' uses the catalog product
  // directly as the source of product info AND silences UGC-only
  // slots (creator, ugc, engagement).
  const input = await buildLayoutInput({
    mediaId,
    template,
    aspectRatio,
    refresh: !!req.options?.refresh,
    options: {
      campaignKind:       req.campaignKind        || null,
      promotionalDetails: req.promotionalDetails  || null,
      ctaText:            req.cta?.text           || null,
      ctaUrl:             req.cta?.url            || null,
      variantKind:        req.variantKind         || 'ugc',
      productId:          req.productId           || null,
      paletteSource:      req.paletteSource       || 'media',
      // Per-ad raffle prize — when the campaign has multiple prize
      // media, this stamps which one this specific render should use
      // as the hero. Threaded into the cache key via campaignContextHash
      // so each prize variant gets its own LayoutInputArtifact.
      rafflePrizeMediaId: req.rafflePrizeMediaId   || null
    }
  });

  // Look up the artifact id so the Ad doc can FK back to it without
  // having to re-find it later. The cache key now includes
  // productId + variantKind to partition the cache properly.
  const artifact = await LayoutInputArtifact
    .findOne({
      mediaId, template, aspectRatio,
      productId:   req.productId   || null,
      variantKind: req.variantKind || 'ugc'
    })
    .select('_id')
    .lean();

  return { input, layoutInputArtifactId: artifact?._id || null };
}

// Spin up Puppeteer, navigate to /ads.html?media=X&template=Y&ratio=Z
// &renderMode=1, wait for the renderer's "ready" signal
// (window.__tpRenderReady === true), screenshot the #tpStage element.
// For video-source media the rendered HTML paints the source video as
// background via <video autoplay loop>; the screenshot captures one
// frame as the static V1 ad.
//
// Tunables come from env so the deploy can swap between local
// (FRONTEND_URL=http://localhost:5173) and Render (FRONTEND_URL set
// to the Netlify URL) without code changes. PUPPETEER_EXECUTABLE_PATH
// + headless flags also driven by env so a custom Chromium binary
// can be slotted in (Render free tier doesn't have Chrome OOTB).
// Resolution order: FRONTEND_URL → first entry of FRONTEND_URLS →
// localhost dev fallback. The plural var is the canonical OAuth
// allowlist (frontendOriginValidator), so deployments that only set
// FRONTEND_URLS still get the renderer pointed at the legacy site
// (which publishes ads.html) without an extra env var.
const FRONTEND_URL = process.env.FRONTEND_URL
  || (process.env.FRONTEND_URLS || '').split(',').map(s => s.trim()).filter(Boolean)[0]
  || 'http://localhost:5173';
const RENDER_AUTH_TOKEN  = process.env.RENDER_AUTH_TOKEN  || null;
// 60s default — covers cold-start backend + image fetch from
// Cloudinary/IG CDN + double-RAF settle, with headroom for tail-of-
// run renders where Chromium memory pressure slows asset fetches.
// Override via env if a specific deploy needs more (heavy templates)
// or less (tight CI).
const RENDER_TIMEOUT_MS  = parseInt(process.env.RENDER_TIMEOUT_MS  || '60000', 10);

// Phase 5b.3 — when true, append useResolved=1 to the headless URL so
// templatePreview.js draws via the ResolvedLayoutArtifact (post-Resolver
// fallbacks, computed font sizes, role downgrades) instead of the
// legacy CSS-driven canvas-spec render. Default off; flip per-deploy
// once the spec preview A/B toggle confirms parity for the batch you
// care about. Easy rollback by flipping the env back to false.
const RENDER_USE_RESOLVED = String(process.env.RENDER_USE_RESOLVED || '').toLowerCase() === 'true';

// Phase 6.3 — when true, the renderer prefers the HTML output path
// (page.setContent → screenshot) over the legacy /ads.html bootstrap
// for AI templates that have a validated outputHtml on the AiCanvas-
// Artifact. Cold cells (no outputHtml yet) still fall back to the
// spec path automatically; HTML accumulates in the background via
// the Phase 6.1 shadow so subsequent renders of the same cell use it.
// Easy rollback by flipping the env back to false.
const RENDER_USE_HTML = String(process.env.RENDER_USE_HTML || '').toLowerCase() === 'true';

// Decode the token's payload (without verifying) so the boot log can
// surface exp + user identity. Helps an operator confirm at a glance
// whether the env-stamped JWT is still valid before kicking a render
// run that would otherwise 401 silently. JWT secret rotation on the
// API side would still produce 401s — those need a real verify.
function decodeTokenPayload(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

(function logRenderConfig() {
  const payload = decodeTokenPayload(RENDER_AUTH_TOKEN);
  let tokenSummary = 'MISSING';
  if (RENDER_AUTH_TOKEN) {
    if (payload) {
      const exp = payload.exp ? new Date(payload.exp * 1000) : null;
      const expiredAlready = exp ? Date.now() > exp.getTime() : false;
      const expLabel = exp ? exp.toISOString() : 'no-exp';
      const userBit = payload.userId || payload.id || 'no-user';
      tokenSummary =
        `set(${RENDER_AUTH_TOKEN.length} chars, user=${String(userBit).slice(0, 8)}, ` +
        `exp=${expLabel}${expiredAlready ? ' EXPIRED' : ''})`;
    } else {
      tokenSummary = `set(${RENDER_AUTH_TOKEN.length} chars, undecodable)`;
    }
  }
  console.log(
    `🎬 renderService config — ` +
    `FRONTEND_URL=${FRONTEND_URL} ` +
    `RENDER_AUTH_TOKEN=${tokenSummary} ` +
    `RENDER_TIMEOUT_MS=${RENDER_TIMEOUT_MS} ` +
    `RENDER_USE_RESOLVED=${RENDER_USE_RESOLVED} ` +
    `RENDER_USE_HTML=${RENDER_USE_HTML}`
  );
})();

async function renderStage(args) {
  const { layoutInputArtifactId, template, aspectRatio, mediaId, productId, renderMode = 'static' } = args;
  const dims = CANVAS_DIMS[aspectRatio] || { w: 1000, h: 1000 };

  // Phase 6.5.1 — eager prime so the first wave of a fresh batch
  // actually uses the HTML path. Without this, the spec-path shadow
  // populates outputHtml AFTER the renderer has already screenshot
  // the legacy /ads.html, so the very first render of every cold cell
  // ships as the spec render. Cache-keyed inside both services, so on
  // warm cells this returns in milliseconds.
  if (RENDER_USE_HTML && template && String(template).startsWith('ai_') && args.aiCreativeV2) {
    try {
      await ensureCanvasAndHtml({
        layoutInputArtifactId,
        template,
        aspectRatio,
        mediaId,
        productId,
        brandId:        args.brandId,
        creativeIntent: args.creativeIntent,
        campaignKind:   args.campaignKind,
        campaignRunId:  args.campaignRunId
      });
    } catch (err) {
      console.warn(`   ⚠️  [render eager] ensureCanvasAndHtml failed: ${err.message} — falling back to lazy path`);
    }
  }

  // Phase 6.3 — HTML render path. Eligible only for AI templates
  // (ai_*), only when the env flag is on, and only when an HTML
  // candidate is present on the AiCanvasArtifact for this cell with
  // zero hard validation violations. After Phase 6.5.1 the eager prime
  // above means cold cells reach this check with outputHtml already
  // populated; spec-path fallback only fires when (a) eager prime
  // skipped (no Director / no v2 / disabled) or (b) html-gen returned
  // hard violations.
  if (RENDER_USE_HTML && template && String(template).startsWith('ai_')) {
    try {
      const htmlCandidate = await lookupHtmlCandidate({
        layoutInputArtifactId, template, aspectRatio, mediaId, productId
      });
      if (htmlCandidate?.outputHtml && !htmlCandidate.hasHardViolations) {
        console.log(
          `   🌐 [render] HTML path — artifact=${htmlCandidate.artifactId} ` +
          `html_len=${htmlCandidate.outputHtml.length}`
        );
        return await renderViaHtml({
          outputHtml: htmlCandidate.outputHtml,
          dims,
          renderMode
        });
      }
      if (htmlCandidate?.outputHtml && htmlCandidate.hasHardViolations) {
        console.warn(
          `   ⚠️  [render] HTML available but has hard violations — ` +
          `falling back to spec path (artifact=${htmlCandidate.artifactId})`
        );
      }
    } catch (err) {
      console.warn(`   ⚠️  [render] HTML eligibility check failed: ${err.message} — falling back to spec path`);
    }
  }

  return await renderViaSpec(args);
}

// Phase 6.5.1 — eager AiCanvasArtifact + outputHtml prime. Mirrors the
// Director-concept resolution + getOrGenerate call that routes/layout.js
// makes when the headless renderer hits /api/layout-input/by-id/:id,
// then invokes html-gen synchronously so the subsequent lookupHtmlCandidate
// returns the freshly generated HTML rather than null. No-ops on:
//   - non-AI templates
//   - V1 campaigns (no Director concept → html-gen would skip anyway)
//   - missing layoutInputArtifactId
//   - missing Director artifact (no concepts to pick from)
//   - AI_HTML_LAYOUT_ENABLED=false
// Failure is non-fatal — the caller catches and falls through to the
// legacy spec render path so a flaky LLM never blocks a render.
async function ensureCanvasAndHtml({
  layoutInputArtifactId, template, aspectRatio, mediaId, productId,
  brandId, creativeIntent, campaignKind, campaignRunId
}) {
  const htmlGen = require('./aiCanvasHtmlGeneratorService');
  if (!htmlGen.enabled()) return;

  const layoutInput = await LayoutInputArtifact.findById(layoutInputArtifactId).lean();
  if (!layoutInput) return;

  const aiNorm = registry.getNormalized(template);
  const creativeStyle = aiNorm?.creativeStyle || 'brand_led';

  // Director concept lookup — same filter shape as routes/layout.js by-id.
  let directionArtifactId = null;
  let directionConcept    = null;
  try {
    const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
    const { pickConceptForCell }    = require('./aiCreativeV2Helpers');
    const direction = await CreativeDirectionArtifact.findOne({
      brandId:        brandId || layoutInput.brandId || null,
      productId:      layoutInput.productId || productId || null,
      campaignKind:   campaignKind   || null,
      creativeIntent: creativeIntent || null
    }).lean();
    if (direction?.concepts?.length) {
      directionArtifactId = String(direction._id);
      const cellKey = `${layoutInput.mediaId}|${layoutInput.paletteSource || ''}|${layoutInput.variantKind || ''}`;
      directionConcept = pickConceptForCell({
        concepts: direction.concepts,
        cellKey,
        runId:    campaignRunId || null
      });
    }
  } catch (err) {
    console.warn(`   ⚠️  [render eager] director lookup failed: ${err.message}`);
  }
  if (!directionConcept) return;  // no V2 path → spec render takes over

  // Prime the AiCanvasArtifact. Cache-hits when already generated for
  // this cell (same 8-field key); cold-call triggers the JSON Generator.
  const aiSvc = require('./aiCanvasSpecService');
  let canvasResult;
  try {
    canvasResult = await aiSvc.getOrGenerate({
      input:               layoutInput.input,
      template,
      aspectRatio,
      creativeStyle,
      mediaId,
      productId:           layoutInput.productId,
      variantKind:         layoutInput.variantKind,
      campaignContextHash: layoutInput.campaignContextHash,
      paletteSource:       layoutInput.paletteSource,
      advertiserId:        layoutInput.advertiserId,
      brandId:             layoutInput.brandId,
      refresh:             false,
      directionArtifactId,
      directionConcept,
      nCandidates:         3,
      previewMode:         false
    });
  } catch (err) {
    console.warn(`   ⚠️  [render eager] canvas prime failed: ${err.message}`);
    return;
  }
  if (!canvasResult?.artifactId) return;

  // Prime the HTML output. Cache-hits when the AiCanvasArtifact already
  // has outputHtml at the current schema version. Awaiting here is the
  // whole point of Phase 6.5.1 — without it the renderer races the
  // setImmediate shadow and almost always loses on the first wave.
  try {
    const out = await htmlGen.generateForArtifact({ aiCanvasArtifactId: canvasResult.artifactId });
    if (out?.skipped) {
      console.log(`   🌐 [render eager] html-gen SKIPPED: artifact=${canvasResult.artifactId} reason=${out.reason}`);
    } else {
      console.log(
        `   🌐 [render eager] html-gen READY: artifact=${canvasResult.artifactId} ` +
        `cands=${out.candidateCount} winner=${out.winnerIndex} html_len=${out.htmlLength}`
      );
    }
  } catch (err) {
    console.warn(`   ⚠️  [render eager] html-gen failed: ${err.message}`);
  }
}

// Look up the HTML candidate for a given cell. Returns null when:
//   - layoutInputArtifactId missing
//   - LayoutInputArtifact not found
//   - AiCanvasArtifact not found for the cell (cold cell — first render)
//   - outputHtml not populated yet (HTML Gen shadow hasn't completed)
// Returns { artifactId, outputHtml, hasHardViolations } when present.
async function lookupHtmlCandidate({ layoutInputArtifactId, template, aspectRatio, mediaId, productId }) {
  if (!layoutInputArtifactId) return null;
  const LayoutInputArtifact      = require('../models/LayoutInputArtifact');
  const AiCanvasArtifact         = require('../models/AiCanvasArtifact');
  const AiHtmlValidationArtifact = require('../models/AiHtmlValidationArtifact');
  const registry                 = require('./templateRegistry');

  const layoutInput = await LayoutInputArtifact
    .findById(layoutInputArtifactId)
    .select('variantKind campaignContextHash paletteSource')
    .lean();
  if (!layoutInput) return null;

  const aiNorm = registry.getNormalized(template);
  const creativeStyle = aiNorm?.creativeStyle || 'brand_led';

  const canvas = await AiCanvasArtifact.findOne({
    mediaId,
    template,
    aspectRatio,
    productId:           productId           || null,
    variantKind:         layoutInput.variantKind         ?? null,
    campaignContextHash: layoutInput.campaignContextHash ?? null,
    paletteSource:       layoutInput.paletteSource       || 'media',
    creativeStyle
  }).select('_id outputHtml htmlValidationId').lean();
  if (!canvas?.outputHtml) return null;

  let hasHardViolations = false;
  if (canvas.htmlValidationId) {
    const v = await AiHtmlValidationArtifact
      .findById(canvas.htmlValidationId)
      .select('hardViolations')
      .lean();
    hasHardViolations = !!(v?.hardViolations?.length);
  }

  return {
    artifactId:        String(canvas._id),
    outputHtml:        canvas.outputHtml,
    hasHardViolations
  };
}

// HTML render path — page.setContent + screenshot. Self-contained:
// no auth tokens, no localStorage seeding, no /ads.html bootstrap, no
// waitForFunction __tpRenderReady. Renderer hits exactly the viewport
// the HTML was authored for via setViewport.
async function renderViaHtml({ outputHtml, dims, renderMode }) {
  const isVideoOverlay = renderMode === 'video-overlay';
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: dims.w, height: dims.h, deviceScaleFactor: 1 });

    // Same diagnostic capture as the spec path — surfaces page console
    // errors / failed requests if the HTML itself is broken.
    const pageEvents = [];
    const push = (s) => { if (pageEvents.length < 60) pageEvents.push(s); };
    page.on('console',       (msg) => push(`[console.${msg.type()}] ${msg.text()}`));
    page.on('pageerror',     (err) => push(`[pageerror] ${err.message}`));
    page.on('requestfailed', (req) => push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText || 'unknown'}`));
    page.on('response',      (res) => { const s = res.status(); if (s >= 400) push(`[response ${s}] ${res.url()}`); });

    await page.setContent(outputHtml, { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS });

    // Belt-and-braces wait for web fonts (system font stack is the
    // norm in our HTML output but custom fonts may slip through).
    await page.waitForFunction('document.fonts ? document.fonts.ready : true', { timeout: 5000 }).catch(() => {});

    // Sanity: log body dimensions + image count so blank captures
    // surface in the worker log with diagnostic context.
    const bodyInfo = await page.evaluate(() => {
      const b = document.body;
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return {
        rect:     { x: r.x, y: r.y, w: r.width, h: r.height },
        imgCount: b.querySelectorAll('img').length,
        innerLen: b.innerHTML.length
      };
    });
    if (!bodyInfo) {
      const tail = pageEvents.length
        ? `\n  page signals (last ${pageEvents.length}):\n    ${pageEvents.join('\n    ')}`
        : '';
      throw new Error(`HTML render: <body> not found in setContent output${tail}`);
    }
    if (!bodyInfo.rect.w || !bodyInfo.rect.h) {
      throw new Error(`HTML render: <body> has zero size — diagnostic: ${JSON.stringify(bodyInfo)}`);
    }
    console.log(
      `   🔬 [render html] body imgs=${bodyInfo.imgCount} ` +
      `innerLen=${bodyInfo.innerLen} (${Math.round(bodyInfo.rect.w)}×${Math.round(bodyInfo.rect.h)})`
    );

    // Full-viewport screenshot. omitBackground only fires in video-
    // overlay mode (HTML must opt-in by setting body { background:
    // transparent } to leverage it).
    const buffer = await page.screenshot({
      type: 'png',
      omitBackground: isVideoOverlay,
      clip: { x: 0, y: 0, width: dims.w, height: dims.h }
    });
    return {
      buffer,
      contentType: 'image/png',
      width:  dims.w,
      height: dims.h,
      bytes:  buffer.length,
      kind:   'image'
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Legacy /ads.html + templatePreview.js rendering path. Unchanged from
// pre-Phase-6 behavior — extracted into a helper so renderStage can
// branch cleanly. Still used for: non-AI templates always; AI templates
// when RENDER_USE_HTML is off OR no HTML candidate is available.
async function renderViaSpec({ layoutInputArtifactId, template, aspectRatio, expectedKind, mediaId, brandId, authToken: reqAuthToken, renderMode = 'static', aiCreativeV2 = false, campaignKind = null, creativeIntent = null, productId = null, campaignRunId = null }) {
  const dims = CANVAS_DIMS[aspectRatio] || { w: 1000, h: 1000 };
  const url = new URL(`${FRONTEND_URL}/ads.html`);
  // renderMode = 'static' → opaque PNG of full canvas (image media or
  // image fallback for video). renderMode = 'video-overlay' → transparent
  // -slot PNG that Cloudinary composites onto a cropped source video.
  const renderModeParam = renderMode === 'video-overlay' ? 'video-overlay' : '1';
  url.searchParams.set('renderMode', renderModeParam);
  url.searchParams.set('media', mediaId);
  url.searchParams.set('template', template);
  url.searchParams.set('ratio', aspectRatio);
  // Pass the artifact ID directly so the page fetches by FK rather
  // than rebuilding via the cache-keyed POST. Earlier attempt threaded
  // productId/paletteSource/variantKind through URL params, but the
  // 8-field cache key also includes campaignContextHash (derived from
  // campaignKind + promotionalDetails + ctaText + ctaUrl) — those
  // don't fit cleanly in URL params, and any drift forced a full
  // re-derive that timed out at the 30s Netlify gateway. Fetching the
  // artifact by id eliminates the entire cache-miss class.
  if (layoutInputArtifactId) url.searchParams.set('layoutInputArtifactId', String(layoutInputArtifactId));
  // Phase 2 — when the campaign opts into V2, signal the by-id route to
  // dispatch through aiCanvasSpecService's V2 path (Director-driven
  // Generator). campaignKind + creativeIntent + productId let the route
  // look up the matching CreativeDirectionArtifact.
  if (aiCreativeV2) {
    url.searchParams.set('v2', '1');
    if (campaignKind)   url.searchParams.set('campaignKind',   campaignKind);
    if (creativeIntent) url.searchParams.set('creativeIntent', creativeIntent);
    if (productId)      url.searchParams.set('productId',      String(productId));
    // Phase 6.5 — runId rotates concept picks batch-over-batch.
    if (campaignRunId)  url.searchParams.set('runId',          String(campaignRunId));
  }
  // Phase 5b.3 — flip headless renders onto the Resolver path. The
  // by-id route reads ?useResolved=1 and returns the ResolvedLayoutArtifact
  // alongside the canvas spec; templatePreview.js then draws using the
  // post-fallback bindings. Only meaningful for ai_* templates (legacy
  // templates have no Resolver artifact).
  if (RENDER_USE_RESOLVED) url.searchParams.set('useResolved', '1');
  const isVideoOverlay = renderMode === 'video-overlay';

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: dims.w, height: dims.h, deviceScaleFactor: 1 });

    // Capture every signal the headless page emits so a 20s timeout
    // surfaces *why* — empty hang vs apiFetch 401 vs JS exception
    // vs CSP block. Cap each list to keep error messages bounded.
    const pageEvents = [];
    const push = (s) => { if (pageEvents.length < 60) pageEvents.push(s); };
    page.on('console',       (msg) => push(`[console.${msg.type()}] ${msg.text()}`));
    page.on('pageerror',     (err) => push(`[pageerror] ${err.message}`));
    page.on('requestfailed', (req) => push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText || 'unknown'}`));
    page.on('response',      (res) => {
      const s = res.status();
      if (s >= 400) push(`[response ${s}] ${res.url()}`);
    });

    // Auth: legacy /ads.html bootstraps via auth.js, which reads
    // localStorage.auth_token (NOT a cookie) and redirects to
    // /login.html when missing. Seed localStorage on the about:blank
    // origin BEFORE navigation so the value is visible by the time
    // ads.html's auth.js runs. brand_id is similarly read from
    // localStorage and forwarded as X-Brand-Id; advertiser is
    // resolved server-side via the JWT's membership lookup, so we
    // don't need to seed advertiser_id.
    // Prefer the per-request authToken (signed by routes/ads.js per
    // generate call, ~1h TTL) over the static RENDER_AUTH_TOKEN env
    // var. Env stays as a fallback for ad-hoc/local invocations that
    // don't carry a per-request token, but the production path no
    // longer depends on it.
    const authToken = (typeof reqAuthToken !== 'undefined' && reqAuthToken) || RENDER_AUTH_TOKEN;
    if (authToken) {
      await page.evaluateOnNewDocument((token, bId) => {
        try {
          if (token) localStorage.setItem('auth_token', token);
          if (bId)   localStorage.setItem('brand_id',   bId);
        } catch (_) { /* localStorage may be sandboxed pre-navigation; will retry post-goto */ }
      }, authToken, brandId || '');
    }

    // waitUntil: 'domcontentloaded' rather than 'networkidle0' — the
    // renderer signals readiness via window.__tpRenderReady (waited
    // for below), which already implies all assets it needed have
    // loaded. networkidle0 was a redundant double-wait that stalled
    // tail-of-run renders when Chromium memory pressure slowed
    // background fetches enough to never reach the 0-in-flight gate.
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
    try {
      await page.waitForFunction(
        'window.__tpRenderReady === true || typeof window.__tpRenderError === "string"',
        { timeout: RENDER_TIMEOUT_MS }
      );
    } catch (waitErr) {
      // Re-throw with the captured page signals appended so the
      // CampaignRun.errors[] entry tells us what actually happened.
      const tail = pageEvents.length
        ? `\n  page signals (last ${pageEvents.length}):\n    ${pageEvents.join('\n    ')}`
        : '\n  (no page signals captured — page likely never executed JS)';
      throw new Error(`${waitErr.message}${tail}`);
    }
    const renderError = await page.evaluate(() => window.__tpRenderError || null);
    if (renderError) {
      const tail = pageEvents.length
        ? `\n  page signals (last ${pageEvents.length}):\n    ${pageEvents.join('\n    ')}`
        : '';
      throw new Error(`render-mode bootstrap failed: ${renderError}${tail}`);
    }

    // Read the stage's actual layout state — capturing this before
    // screenshot lets us throw a useful diagnostic when the canvas
    // didn't size, instead of the opaque "Node has 0 width" error
    // from elementHandle.screenshot.
    const stageInfo = await page.evaluate(() => {
      const el = document.getElementById('tpStage');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const ancestorChain = [];
      let cur = el.parentElement;
      while (cur && cur !== document.body && ancestorChain.length < 8) {
        const acs = window.getComputedStyle(cur);
        const ar = cur.getBoundingClientRect();
        ancestorChain.push({
          tag: cur.tagName.toLowerCase(),
          id: cur.id || null,
          cls: cur.className || null,
          display: acs.display,
          width: Math.round(ar.width),
          height: Math.round(ar.height)
        });
        cur = cur.parentElement;
      }
      return {
        rect:     { x: r.x, y: r.y, w: r.width, h: r.height },
        inline:   { width: el.style.width, height: el.style.height, transform: el.style.transform },
        computed: { width: cs.width, height: cs.height, display: cs.display, position: cs.position, transform: cs.transform },
        innerLen: el.innerHTML.length,
        innerHead: el.innerHTML.slice(0, 250),
        zoneCount: el.querySelectorAll('.tp-zone').length,
        imgCount:  el.querySelectorAll('img').length,
        ancestors: ancestorChain
      };
    });
    if (!stageInfo) throw new Error('#tpStage not found in rendered page');
    if (!stageInfo.rect.w || !stageInfo.rect.h) {
      throw new Error(`#tpStage has zero size — diagnostic: ${JSON.stringify(stageInfo)}`);
    }
    // Sanity log every render — easy to spot blank captures at a glance.
    console.log(
      `   🔬 [render] stage zones=${stageInfo.zoneCount} imgs=${stageInfo.imgCount} ` +
      `innerLen=${stageInfo.innerLen} (${stageInfo.rect.w}×${stageInfo.rect.h})`
    );

    // Clip-based screenshot via page.screenshot rather than the
    // elementHandle.screenshot path — sidesteps Puppeteer's ancestor-
    // visibility check and works as long as the rect is non-empty.
    const buffer = await page.screenshot({
      type: 'png',
      // omitBackground only emits transparent pixels in video-overlay
      // mode (where the renderer leaves canvas + media slot transparent
      // by design). Static renders keep the default opaque background
      // so brand fills / gradients reach the PNG.
      omitBackground: isVideoOverlay,
      clip: {
        x:      stageInfo.rect.x,
        y:      stageInfo.rect.y,
        width:  stageInfo.rect.w,
        height: stageInfo.rect.h
      }
    });

    return {
      buffer,
      contentType: 'image/png',
      width:  dims.w,
      height: dims.h,
      bytes:  buffer.length,
      kind:   'image'
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Upload the rendered PNG buffer to Cloudinary. Folder per
// (brand, campaign) so the ads page can prefix-list / soft-delete
// per campaign. Public ID is deterministic on inputs + a short
// derivation hash so re-renders of the same combo overwrite the
// previous asset rather than orphaning it. The caller (renderService)
// already short-circuits identical renders via derivationDigest so
// in normal operation each call here uploads exactly once.
async function uploadStage(renderOutput, ctx) {
  const folder = `ads/${ctx.brandId}/${ctx.campaignId}${ctx.isOverlay ? '/overlay' : ''}`;
  const shortMedia = String(ctx.mediaId).slice(-8);
  const shortDigest = (ctx.identityDigest || '').slice(0, 8) || crypto.randomBytes(4).toString('hex');
  const overlaySuffix = ctx.isOverlay ? '-overlay' : '';
  const publicId = `${ctx.aspectRatio.replace(/[:.]/g, '_')}-${ctx.template}-${shortMedia}-${shortDigest}${overlaySuffix}`;

  const result = await uploadBufferToCloudinary(renderOutput.buffer, {
    folder,
    publicId,
    resourceType: 'image',
    overwrite:    true
  });

  return {
    cloudinaryPublicId: result.public_id,
    renderUrl:          result.secure_url || result.url,
    posterUrl:          null,
    bytes:              result.bytes  || renderOutput.bytes,
    width:              result.width  || renderOutput.width,
    height:             result.height || renderOutput.height,
    durationMs:         null
  };
}

async function persistStage({ req, input, layoutInputArtifactId, renderOutput, upload, videoComposite }) {
  const copy = extractCopySnapshot(input);
  const isVideo = !!videoComposite;
  // Update the existing queued Ad doc (status='rendering' was stamped
  // when the run loop selected it). Backfill all the render-output
  // fields and flip status → 'draft'. The Ad's identity fields
  // (campaignId, mediaId, productId, template, aspectRatio, matchTier,
  // variantKind, identityDigest) stay as they were at queue time.
  if (!req.adId) {
    throw new Error('persistStage: req.adId required (the queued Ad to update)');
  }
  const update = {
    $set: {
      layoutInputArtifactId,
      kind:               isVideo ? 'video' : (renderOutput.kind || 'image'),
      renderUrl:          isVideo ? videoComposite.compositeUrl : upload.renderUrl,
      posterUrl:          isVideo ? upload.renderUrl : upload.posterUrl,
      cloudinaryPublicId: upload.cloudinaryPublicId,
      width:              upload.width,
      height:             upload.height,
      bytes:              upload.bytes,
      durationMs:         upload.durationMs,
      copy,
      status:             'draft',
      renderedAt:         new Date(),
      updatedAt:          new Date()
    },
    $inc: { renderAttempts: 1 }
  };
  const ad = await Ad.findByIdAndUpdate(req.adId, update, { new: true }).lean();
  if (!ad) throw new Error(`persistStage: Ad ${req.adId} not found`);
  return ad;
}

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
  mediaId, template, aspectRatio,
  productId, variantKind, paletteSource, creativeStyle, campaignContextHash
}) {
  const AiCanvasArtifact = require('../models/AiCanvasArtifact');
  // Build the cache key the way aiCanvasSpecService.getOrGenerate does.
  // creativeStyle defaults: if the wizard didn't pass one, the registry
  // shim derives it from the template id (ai_brand_led → brand_led, etc.).
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
  const artifact = await AiCanvasArtifact.findOne(filter).lean();
  if (!artifact?.canvasSpec) return null;

  const spec = artifact.canvasSpec;
  const canvasDims = {
    w: spec.canvas?.width  || CANVAS_DIMS[aspectRatio]?.w || 1000,
    h: spec.canvas?.height || CANVAS_DIMS[aspectRatio]?.h || 1000
  };
  // Filter zones to those that slot the source media's hero (alt-crop
  // slots like product.hero_media.crops.1_91_1 use a still image, no
  // video twin, so they don't get the composite treatment).
  const candidates = (spec.zones || []).filter(z =>
    z.kind === 'media' && z.slot === 'product.hero_media' && z.rect
  );
  if (!candidates.length) return null;
  // Pick the largest by area — when the LLM emits multiple media
  // zones we want the dominant one for video.
  const slotZone = candidates.sort((a, b) =>
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
  productId, variantKind, paletteSource, creativeStyle, campaignContextHash
}) {
  // Resolve canvas dims + the hero-media slot rect. Hand-authored
  // templates have these in registry.CANVAS; AI templates emit them
  // per-ad — we read back the AiCanvasArtifact this render used.
  let canvasDims, slotZone;
  if (registry.isAi(template)) {
    const aiPick = await pickHeroMediaZoneFromAiArtifact({
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
  const slotRatio = _pickClosestBaseRatio(slotZone.rect);
  const winnerId = cropDoc?.winners?.[slotRatio] || null;
  const list = cropDoc?.smartCrops?.[slotRatio] || [];
  const winner = list.find(c => c.id === winnerId) || list[0] || null;
  const smartCropBbox = winner ? {
    x1: Number(winner.x1), y1: Number(winner.y1),
    x2: Number(winner.x2), y2: Number(winner.y2)
  } : null;

  const compositeUrl = buildVideoCompositeUrl({
    sourceVideoUrl:  media.fileUrl,
    overlayPublicId,
    overlayImageUrl: overlayUrl,
    canvasDims,
    slotRect: slotZone.rect,
    smartCropBbox
  });
  if (!compositeUrl) return null;
  return { compositeUrl, slotRect: slotZone.rect, canvasDims, smartCropBbox };
}

// ── Helpers ──────────────────────────────────────────────────────────

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
      identityDigest:        ad.identityDigest
    }
  };
}

module.exports = { renderCreative };
