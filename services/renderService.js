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
const puppeteer = require('puppeteer');

const Ad                    = require('../models/Ad');
const Media                 = require('../models/Media');
const CatalogProduct        = require('../models/CatalogProduct');
const LayoutInputArtifact   = require('../models/LayoutInputArtifact');
const registry              = require('./templateRegistry');
const { buildLayoutInput }  = require('./layoutInputService');
const { uploadBufferToCloudinary } = require('./cloudinaryService');

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

  // 3. de-dupe — has this exact creative been rendered before?
  const derivationDigest = computeDerivationDigest(input, req);
  const existing = await Ad.findOne({
    campaignId: req.campaignId,
    derivationDigest
  }).lean();
  if (existing) {
    console.log(`   ♻️  ${tag} dedupe hit — reusing Ad ${existing._id} (digest=${derivationDigest.slice(0,8)})`);
    return success(jobId, existing);
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
      brandId:      req.brandId
    });
    stages.render = Date.now() - t;
    console.log(`   🖼️  ${tag} render ok in ${stages.render}ms (${renderOutput.width}×${renderOutput.height}, ${Math.round(renderOutput.bytes/1024)}KB)`);
  } catch (err) {
    console.error(`   ❌ ${tag} render: ${err.message || err}`);
    return failed(jobId, 'render', err);
  }

  // 5. upload — Cloudinary
  let upload;
  try {
    const t = Date.now();
    upload = await uploadStage(renderOutput, {
      brandId:          req.brandId,
      campaignId:       req.campaignId,
      mediaId:          req.creative.mediaId,
      template:         req.creative.template,
      aspectRatio:      req.creative.aspectRatio,
      derivationDigest
    });
    stages.upload = Date.now() - t;
    console.log(`   ☁️  ${tag} upload ok in ${stages.upload}ms (publicId=${upload.cloudinaryPublicId})`);
  } catch (err) {
    console.error(`   ❌ ${tag} upload: ${err.message || err}`);
    return failed(jobId, 'upload', err);
  }

  // 6. persist — Ad doc
  let ad;
  try {
    const t = Date.now();
    ad = await persistStage({
      req,
      input,
      layoutInputArtifactId,
      derivationDigest,
      renderOutput,
      upload
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
// 35s default — covers cold-start backend + image fetch from
// Cloudinary/IG CDN + double-RAF settle. Override via env if a
// specific deploy needs more (heavy templates) or less (tight CI).
const RENDER_TIMEOUT_MS  = parseInt(process.env.RENDER_TIMEOUT_MS  || '35000', 10);

console.log(
  `🎬 renderService config — ` +
  `FRONTEND_URL=${FRONTEND_URL} ` +
  `RENDER_AUTH_TOKEN=${RENDER_AUTH_TOKEN ? `set(${RENDER_AUTH_TOKEN.length} chars)` : 'MISSING'} ` +
  `RENDER_TIMEOUT_MS=${RENDER_TIMEOUT_MS}`
);

async function renderStage({ layoutInputArtifactId, template, aspectRatio, expectedKind, mediaId, brandId }) {
  const dims = CANVAS_DIMS[aspectRatio] || { w: 1000, h: 1000 };
  const url = new URL(`${FRONTEND_URL}/ads.html`);
  url.searchParams.set('renderMode', '1');
  url.searchParams.set('media', mediaId);
  url.searchParams.set('template', template);
  url.searchParams.set('ratio', aspectRatio);

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
    if (RENDER_AUTH_TOKEN) {
      await page.evaluateOnNewDocument((token, bId) => {
        try {
          if (token) localStorage.setItem('auth_token', token);
          if (bId)   localStorage.setItem('brand_id',   bId);
        } catch (_) { /* localStorage may be sandboxed pre-navigation; will retry post-goto */ }
      }, RENDER_AUTH_TOKEN, brandId || '');
    }

    await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS });
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
        ancestors: ancestorChain
      };
    });
    if (!stageInfo) throw new Error('#tpStage not found in rendered page');
    if (!stageInfo.rect.w || !stageInfo.rect.h) {
      throw new Error(`#tpStage has zero size — diagnostic: ${JSON.stringify(stageInfo)}`);
    }

    // Clip-based screenshot via page.screenshot rather than the
    // elementHandle.screenshot path — sidesteps Puppeteer's ancestor-
    // visibility check and works as long as the rect is non-empty.
    const buffer = await page.screenshot({
      type: 'png',
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
  const folder = `ads/${ctx.brandId}/${ctx.campaignId}`;
  const shortMedia = String(ctx.mediaId).slice(-8);
  const shortDigest = (ctx.derivationDigest || '').slice(0, 8) || crypto.randomBytes(4).toString('hex');
  const publicId = `${ctx.aspectRatio.replace(/[:.]/g, '_')}-${ctx.template}-${shortMedia}-${shortDigest}`;

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
