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
const VIDEO_TEMPLATES = new Set(['ugc_split_screen', 'testimonial_spotlight']);

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
      renderMode:   useVideoBranch ? 'video-overlay' : 'static'
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
        overlayPublicId:  upload.cloudinaryPublicId
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
    `RENDER_TIMEOUT_MS=${RENDER_TIMEOUT_MS}`
  );
})();

async function renderStage({ layoutInputArtifactId, template, aspectRatio, expectedKind, mediaId, brandId, authToken: reqAuthToken, renderMode = 'static' }) {
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

async function composeVideoOutput({ media, template, aspectRatio, overlayUrl, overlayPublicId }) {
  const canvasVariant = registry.CANVAS?.templates?.[template]?.variants?.[aspectRatio];
  if (!canvasVariant) return null;
  const canvasDims = { w: canvasVariant.canvas?.width, h: canvasVariant.canvas?.height };
  const slotZone = (canvasVariant.zones || []).find(z =>
    z.kind === 'media' && z.slot === 'product.hero_media');
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
