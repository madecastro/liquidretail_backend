const express = require('express');
const router = express.Router();
const Brand = require('../models/Brand');
const { normalizeBrandName } = require('../models/Brand');
const { tenantFilter } = require('../middleware/tenantHelpers');
const DetectRun = require('../models/DetectRun');
const Media = require('../models/Media');
const CatalogProduct = require('../models/CatalogProduct');
const Campaign = require('../models/Campaign');
const IntegrationCredential = require('../models/IntegrationCredential');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const { validateVideoSettings } = require('../services/atlasVideoService');
const { normalizeStaticPipelineInput, resolveStaticPipeline, STATIC_PIPELINES } = require('../services/staticPipeline');
// Single source of truth for titling format ids — was duplicated as a literal
// ['vertical','feed','landscape'] in five places in this file, which is how adding
// 'square' nearly shipped as a silent fall-through to 'feed'. Import it; do not
// re-list it. Order and membership live in services/titleSpecValidator.js.
const { FORMATS: TITLING_FORMATS } = require('../services/titleSpecValidator');
// format id -> the aspectRatio a synthetic ad must carry for
// brandScriptExecutor.classifyFormat to classify it back to that same format.
// Every entry here MUST round-trip; scripts/verifyTitlingFormats.js asserts it.
const ASPECT_BY_TITLING_FORMAT = {
  vertical:  '9:16',
  feed:      '4:5',
  square:    '1:1',
  landscape: '16:9'
};

// ── Preview plate resolver ─────────────────────────────────────────
//
// Previews render against a real photograph so the operator sees how
// overlays sit on realistic texture. Resolution ladder:
//   1. Brand's own most-recent lifestyle / on_model / any image Media
//      (classification.shotType-ranked). Downloaded fresh per preview
//      (Cloudinary is fast; skips cache-invalidation headaches when
//      brand adds new media).
//   2. Fallback: a deterministic picsum stock image per format,
//      cached to disk after first fetch.
//   3. If both fail: the executor falls back to a solid brand-primary
//      fill.

const SHOT_TYPE_PRIORITY = ['lifestyle', 'on_model', 'flat_lay'];

async function pickBrandPreviewMediaUrl(brandId) {
  const Media = require('../models/Media');
  for (const shot of SHOT_TYPE_PRIORITY) {
    const m = await Media.findOne({
      brandId,
      fileType: 'image',
      'classification.shotType': shot
    })
      .sort({ createdAt: -1 })
      .select('fileUrl')
      .lean();
    if (m?.fileUrl) return { url: m.fileUrl, shotType: shot };
  }
  // No shot-typed lifestyle image — accept any image Media for this brand.
  const any = await Media.findOne({ brandId, fileType: 'image' })
    .sort({ createdAt: -1 })
    .select('fileUrl')
    .lean();
  if (any?.fileUrl) return { url: any.fileUrl, shotType: 'unclassified' };
  return null;
}

// Downloads a URL to a fresh temp file. Caller owns cleanup.
async function downloadUrlToTemp(url, extHint = '.jpg') {
  const os      = require('os');
  const fs      = require('fs');
  const path    = require('path');
  const crypto  = require('crypto');
  const axios   = require('axios');
  const runId   = crypto.randomBytes(6).toString('hex');
  const file    = path.join(os.tmpdir(), `plate_${runId}${extHint}`);
  const res     = await axios.get(url, { responseType: 'stream', timeout: 20_000, maxRedirects: 5 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    // A mid-body failure rejects before the caller ever learns the path —
    // unlink the partial file here or it leaks in tmpdir forever.
    const fail = (err) => fs.promises.unlink(file).catch(() => {}).then(() => reject(err));
    res.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', fail);
    res.data.on('error', fail);
  });
  return file;
}

const SAMPLE_PLATE_URLS = {
  feed:      'https://picsum.photos/seed/reachsocial-feed/1080/1350',
  vertical:  'https://picsum.photos/seed/reachsocial-vertical/1080/1920',
  landscape: 'https://picsum.photos/seed/reachsocial-landscape/1920/1080'
};

async function ensureSamplePlate(format) {
  const fs   = require('fs');
  const path = require('path');
  const dir  = path.join(__dirname, '..', 'services', 'brandScripts', 'assets', 'samples');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${format}.jpg`);
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > 1024) return file;
  } catch { /* fall through to download */ }

  const url = SAMPLE_PLATE_URLS[format];
  if (!url) return null;
  const axios = require('axios');
  try {
    const res = await axios.get(url, { responseType: 'stream', timeout: 15_000, maxRedirects: 5 });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      res.data.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      res.data.on('error', reject);
    });
    return file;
  } catch (err) {
    console.warn(`⚠️  sample plate fetch failed for ${format} (${err.message}) — preview will use solid color`);
    return null;
  }
}

// Fire-and-forget enrichment trigger. Imported lazily to avoid the
// circular require that originally pushed enrichment scheduling into
// brandCatalogService — same dance, but now the user (not detect)
// drives it. No-ops cleanly when there's no websiteUrl or no
// missing tier (Brandfetch / scrape / GPT) to add.
function triggerEnrichment(brand, reason) {
  if (!brand?.websiteUrl) return;
  console.log(`🌐 enrichment queued for "${brand.name}" (${reason})`);
  const { enrichBrandFromUrl } = require('../services/brandEnrichmentService');
  enrichBrandFromUrl(brand._id).catch(err =>
    console.warn(`   ⚠️  enrichment fire-and-forget failed for "${brand.name}": ${err.message}`)
  );
}

// GET /api/brand/by-name/:name
// Returns the full Brand catalog document for a given brand name (case
// and punctuation insensitive — uses normalizeBrandName to look up).
// Used by the ad-generation preview's Brand Object tab to render every
// field stored, not just the subset that ships on the layout-input.
router.get('/by-name/:name', async (req, res) => {
  try {
    const normalized = normalizeBrandName(req.params.name);
    if (!normalized) return res.status(400).json({ error: 'invalid brand name' });
    const brand = await Brand.findOne(tenantFilter(req, { nameNormalized: normalized })).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found', searched: normalized });
    res.json({ brand });
  } catch (err) {
    res.status(500).json({ error: err.message || 'brand lookup failed' });
  }
});

// GET /api/brand
// List every Brand owned by the current Advertiser. Sorted by name.
// Used by the nav brand-picker dropdown on every page.
router.get('/', async (req, res) => {
  try {
    const brands = await Brand.find(tenantFilter(req))
      .select('name nameNormalized logoUrl websiteUrl primaryColor fontFamily fontSource source enrichmentSources curatedFields createdAt')
      .sort({ name: 1 })
      .lean();

    // Connected IG handle per brand — identity for the ad-preview
    // placement chrome (Instagram Reels/Stories/Feed mockups) on the
    // frontend. One batched query for the whole list rather than a
    // lookup per brand. Best-effort: a brand with no active Instagram
    // credential just has no handle and the UI slugs its name.
    const igHandleByBrand = new Map();
    try {
      const creds = await IntegrationCredential
        .find({ brandId: { $in: brands.map(b => b._id) }, type: 'instagram', status: 'active' })
        .select('brandId igUsername')
        .lean();
      for (const c of creds) {
        if (c.igUsername && !igHandleByBrand.has(String(c.brandId))) {
          igHandleByBrand.set(String(c.brandId), c.igUsername);
        }
      }
    } catch { /* optional enrichment — never fail the brand list over it */ }

    res.json({
      brands: brands.map(b => ({
        id:           String(b._id),
        name:         b.name,
        slug:         b.nameNormalized,
        logoUrl:      b.logoUrl || null,
        websiteUrl:   b.websiteUrl || null,
        igHandle:     igHandleByBrand.get(String(b._id)) || null,
        primaryColor: b.primaryColor || null,
        source:       b.source,
        enrichmentSources: b.enrichmentSources || [],
        curatedFields:     b.curatedFields || [],
        createdAt:    b.createdAt
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'brand list failed' });
  }
});

// POST /api/brand
// Body: { name: string (required), websiteUrl?: string, primaryColor?: string }
// Create a new Brand under the current Advertiser. nameNormalized
// is derived; the (advertiserId, nameNormalized) compound unique
// catches duplicates and 409s.
router.post('/', express.json(), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const normalized = normalizeBrandName(name);
    if (!normalized) return res.status(400).json({ error: 'name produces empty slug' });

    const exists = await Brand.findOne(tenantFilter(req, { nameNormalized: normalized })).lean();
    if (exists) {
      return res.status(409).json({
        error: 'Brand already exists for this advertiser',
        brand: { id: String(exists._id), name: exists.name, slug: exists.nameNormalized }
      });
    }

    const brand = await Brand.create({
      advertiserId:   req.advertiserId,
      name,
      nameNormalized: normalized,
      websiteUrl:     req.body?.websiteUrl || null,
      primaryColor:   req.body?.primaryColor || null,
      source:         'curated',
      curatedFields:  ['name']
    });

    // Trigger enrichment if a website URL was provided. Fire-and-forget;
    // route response doesn't wait. Brandfetch + scrape + GPT all run in
    // the background and the brand object updates as each tier returns.
    triggerEnrichment(brand, 'create');

    res.status(201).json({
      brand: {
        id:        String(brand._id),
        name:      brand.name,
        slug:      brand.nameNormalized,
        websiteUrl: brand.websiteUrl,
        primaryColor: brand.primaryColor,
        source:    brand.source
      }
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Brand already exists' });
    }
    console.error('brand create failed:', err);
    res.status(500).json({ error: err.message || 'brand create failed' });
  }
});

// GET /api/brand/:id
// Full Brand catalog doc by ObjectId, scoped to the current
// Advertiser. Used by the Brand details page (brand.html) to
// hydrate the edit form.
router.get('/:id', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    res.json({ brand });
  } catch (err) {
    res.status(500).json({ error: err.message || 'brand fetch failed' });
  }
});

// PATCH /api/brand/:id
// Partial update for editable brand fields. Curated-aware — any
// field set explicitly here is added to brand.curatedFields so
// future auto-enrichment leaves it alone. Triggers enrichment
// when the websiteUrl changes (fresh tiers may now apply).
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const editable = ['name', 'websiteUrl', 'tagline', 'summary', 'logoUrl',
                      'primaryColor', 'secondaryColor', 'accentColor', 'fontColor',
                      'websiteBackground',
                      'fontFamily', 'tone', 'hashtags', 'tags', 'demographics',
                      'brandSafety', 'styleOverrides', 'styleScript',
                      'styleScriptVertical', 'styleScriptLandscape', 'styleTheme',
                      'videoSettings', 'titleStyleSpec', 'titleStylePreset',
                      'metaCascades', 'staticImagePipeline'];

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'staticImagePipeline')) {
      // Normalised through the one canonical resolver rather than a local list, so
      // this route, the Brand enum and the renderer cannot drift. It also absorbs
      // the retired 'direct_overlay' from a frontend build that predates the
      // rename, storing it as 'direct_image' instead of 400-ing a working client.
      // 'html' is rejected: the HTML/Puppeteer static path is no longer opt-in
      // (Stage 1 catalog pipeline exclusive, 2026-08-02).
      const rawPipeline = req.body.staticImagePipeline;
      if (String(rawPipeline == null ? '' : rawPipeline).trim().toLowerCase() === 'html') {
        return res.status(400).json({
          error: "staticImagePipeline 'html' is retired — catalog product ads render via direct_image only. Allowed: " +
            STATIC_PIPELINES.join(', ')
        });
      }
      const pipeline = normalizeStaticPipelineInput(rawPipeline);
      if (!pipeline) {
        return res.status(400).json({
          error: `staticImagePipeline must be one of: ${STATIC_PIPELINES.join(', ')}`
        });
      }
      req.body.staticImagePipeline = pipeline;
    }

    // videoSettings carries model slugs consumed at render time — reject
    // unknown slugs here (nicer UX than the render-time warn-and-fall-
    // through in resolveVideoModel). Shape: { model, modelByCanvas,
    // referenceImageCount, titlingEngine } — see models/Brand.js.
    // Validate the INCOMING object before the shallow-merge write below.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'videoSettings') && req.body.videoSettings != null) {
      const err = validateVideoSettings(req.body.videoSettings);
      if (err) return res.status(400).json({ error: err });
    }

    // titleStyleSpec is rendered by the Remotion engine — schema-validate
    // at write time so a bad LLM edit can never be persisted. Render time
    // re-validates and falls back to the canonical preset regardless.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'titleStyleSpec') && req.body.titleStyleSpec != null) {
      const { validateTitleStyleSpecDoc } = require('../services/titleSpecValidator');
      const specRes = validateTitleStyleSpecDoc(req.body.titleStyleSpec);
      if (!specRes.ok) return res.status(400).json({ error: `titleStyleSpec invalid: ${specRes.errors.slice(0, 5).join('; ')}` });
      req.body.titleStyleSpec = specRes.normalized;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'titleStylePreset') && req.body.titleStylePreset != null && req.body.titleStylePreset !== '') {
      const { loadPresetFile } = require('../services/titleSpecService');
      if (!loadPresetFile(req.body.titleStylePreset)) {
        return res.status(400).json({ error: `unknown titleStylePreset '${req.body.titleStylePreset}'` });
      }
    }

    // metaCascades: brand-level overrides of the meta-field resolver's
    // default cascades. Validated + normalized before persist so a
    // typo'd doc name or malformed source can't corrupt render-time
    // meta. See services/metaCascadeResolver.validateBrandOverrides.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'metaCascades') && req.body.metaCascades != null) {
      const { validateBrandOverrides } = require('../services/metaCascadeResolver');
      const check = validateBrandOverrides(req.body.metaCascades);
      if (!check.ok) return res.status(400).json({ error: `metaCascades invalid: ${check.errors.slice(0, 5).join('; ')}` });
      req.body.metaCascades = check.normalized;
    }

    // websiteBackground: normalize to '#RRGGBB' when non-empty; invalid → 400.
    // Empty/null still clears via the isEmpty path below.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'websiteBackground')
        && req.body.websiteBackground != null
        && req.body.websiteBackground !== '') {
      const { normalizeWebsiteBackgroundHex } = require('../utils/websiteBackground');
      const normalized = normalizeWebsiteBackgroundHex(req.body.websiteBackground);
      if (!normalized) {
        return res.status(400).json({
          error: 'websiteBackground must be a valid hex color (#RGB or #RRGGBB)',
        });
      }
      req.body.websiteBackground = normalized;
    }

    // Entry log for style-related mutations so we can trace why a
    // Clear button isn't sticking. Non-noisy: only fires when one of
    // the style fields is present in the body.
    const stylePayload = ['styleOverrides', 'styleScript', 'styleScriptVertical', 'styleScriptLandscape', 'styleTheme']
      .filter(k => Object.prototype.hasOwnProperty.call(req.body || {}, k))
      .map(k => {
        const v = req.body[k];
        if (v == null) return `${k}=null`;
        if (typeof v === 'string') return `${k}=<${v.length} chars>`;
        if (typeof v === 'object') return `${k}=<${Object.keys(v).length} keys>`;
        return `${k}=<${typeof v}>`;
      });
    if (stylePayload.length) {
      console.log(`✏️  brand PATCH ${req.params.id}: ${stylePayload.join(', ')}`);
    }
    const fontTouched = Object.prototype.hasOwnProperty.call(req.body || {}, 'fontFamily');
    const fontCleared = fontTouched && (req.body.fontFamily == null || req.body.fontFamily === '');
    const logoTouched = Object.prototype.hasOwnProperty.call(req.body || {}, 'logoUrl');
    const logoCleared = logoTouched && (req.body.logoUrl == null || req.body.logoUrl === '');
    const before = { websiteUrl: brand.websiteUrl };
    const curatedSet = new Set(brand.curatedFields || []);

    // Mongoose Mixed fields don't auto-detect deep mutations —
    // markModified is required to guarantee the change persists,
    // ESPECIALLY when clearing to null. Applies to any field the
    // Brand schema declares as mongoose.Schema.Types.Mixed.
    const MIXED_FIELDS = new Set(['styleOverrides', 'styleTheme', 'brandSafety', 'videoSettings', 'titleStyleSpec', 'metaCascades']);
    const RUNTIME_SETTINGS = new Set(['staticImagePipeline']);

    for (const k of editable) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) {
        const v = req.body[k];
        const isEmpty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
        if (isEmpty) {
          brand[k] = Array.isArray(v) ? [] : null;
        } else if (
          // SHALLOW MERGE for videoSettings: multiple UI cards
          // (VideoModelCard, TitleStudioCard) each PATCH with their own
          // possibly-stale copy; replace semantics silently drops keys
          // saved by the other card. Explicit nulls in v still overwrite;
          // whole-field null/empty still clears via the isEmpty path.
          k === 'videoSettings'
          && v && typeof v === 'object' && !Array.isArray(v)
          && brand.videoSettings && typeof brand.videoSettings === 'object'
          && !Array.isArray(brand.videoSettings)
        ) {
          brand.videoSettings = { ...(brand.videoSettings || {}), ...v };
        } else {
          brand[k] = v;
        }
        if (MIXED_FIELDS.has(k)) brand.markModified(k);
        // Clearing a field is a request to RE-enrich it, not lock the
        // empty value as curated. Setting a value is curation.
        if (!RUNTIME_SETTINGS.has(k)) {
          if (isEmpty) curatedSet.delete(k);
          else         curatedSet.add(k);
        }
      }
    }
    // Renormalize the slug if name changed.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
      brand.nameNormalized = normalizeBrandName(brand.name);
    }
    brand.curatedFields = [...curatedSet];
    // Font provenance: setting a value = 'curated'; clearing = null so
    // the next enrichment can re-attribute it to whichever tier wins.
    if (fontTouched) brand.fontSource = fontCleared ? null : 'curated';
    if (logoTouched) {
      brand.logoSource = logoCleared ? null : 'curated';
      brand.logoOriginalUrl = logoCleared ? null : brand.logoUrl;
      brand.logoIngestedAt = logoCleared ? null : new Date();
      brand.logoIngestError = null;
    }
    await brand.save();

    // Re-enrich when the websiteUrl actually changed (new domain →
    // Brandfetch may now hit; existing one → no value).
    if (before.websiteUrl !== brand.websiteUrl) {
      // Reset enrichmentSources so all tiers re-attempt against the new URL.
      brand.enrichmentSources = [];
      // Website fonts belong to the old domain and must never leak into
      // renders for the replacement storefront.
      brand.customFonts = [];
      brand.websiteFontUsage = null;
      brand.fontIngestedAt = null;
      brand.fontIngestError = null;
      brand.logoIngestedAt = null;
      brand.logoIngestError = null;
      brand.logoOriginalUrl = null;
      if (!brand.curatedFields?.includes('logoUrl')) {
        brand.logoUrl = null;
        brand.logoSource = null;
      }
      brand.markModified('customFonts');
      brand.markModified('websiteFontUsage');
      await brand.save();
      triggerEnrichment(brand, 'website-url changed');
    }

    res.json({ brand: serializeBrand(brand) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Brand name conflicts with another brand in this advertiser' });
    }
    console.error('brand update failed:', err);
    res.status(500).json({ error: err.message || 'brand update failed' });
  }
});

// POST /api/brand/:id/render-script
// Manual one-shot: run the brand's styleScript against a specific
// ad's Grok base video and produce a final MP4. Uploads to Cloudinary,
// updates Ad.renderUrl. Used to preview + debug scripts before we
// auto-wire the executor into the ad pipeline. Body: { adId }.
router.post('/:id/render-script', express.json(), async (req, res) => {
  const started = Date.now();
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const { adId } = req.body || {};
    if (!adId) return res.status(400).json({ error: 'adId is required in body' });

    const Ad    = require('../models/Ad');
    const Media = require('../models/Media');
    const ad = await Ad.findById(adId);
    if (!ad) return res.status(404).json({ error: 'ad not found' });
    // Ownership: ad → media → brand. Reject cross-brand requests.
    const media = await Media.findById(ad.mediaId).select('brandId').lean();
    if (!media || String(media.brandId) !== String(brand._id)) {
      return res.status(403).json({ error: 'ad does not belong to this brand' });
    }

    const { renderBrandScriptAndSave } = require('../services/brandScriptExecutor');
    const result = await renderBrandScriptAndSave({ ad, brand });

    res.json({
      ok:        true,
      renderUrl: result.renderUrl,
      timings:   result.timings,
      totalMs:   Date.now() - started
    });
  } catch (err) {
    console.error('render-script failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'render-script failed' });
  }
});

// In-memory async job store for batch re-title. Same Netlify ~26s proxy
// cap that forces preview-script async: live re-title takes tens of
// seconds per ad, so POST returns 202+jobId and the client polls GET
// /:id/retitle-videos/:jobId. dryRun stays synchronous (selection only).
// Auto-cleaned 5 min after done/failed so the map doesn't grow.
const retitleJobs = new Map();
const RETITLE_JOB_TTL_MS = 5 * 60 * 1000;
// Cost/RAM guard — remotion renders are ~1.5-3GB peak and Cloudinary
// uploads are billable. When adIds is omitted, clamp eligible set to
// this cap (oldest-first) and report truncated+totalMatched.
const MAX_RETITLE_BATCH = 500;

function reapRetitleJob(jobId) {
  setTimeout(() => retitleJobs.delete(jobId), RETITLE_JOB_TTL_MS);
}

// Concurrency-capped pool runner. Writes progress into retitleJobs so
// the poller sees {done,total} and accumulating results/errors. Per-ad
// failures never abort the batch; only a thrown outer error → failed.
async function runRetitleJob(jobId, brand, eligible, concurrency, seedErrors) {
  const Ad = require('../models/Ad');
  const { renderBrandScriptAndSave } = require('../services/brandScriptExecutor');
  const results = [];
  const errors = seedErrors ? seedErrors.slice() : [];
  let cursor = 0;
  let done = 0;
  const total = eligible.length;

  const prev0 = retitleJobs.get(jobId) || {};
  retitleJobs.set(jobId, {
    ...prev0,
    status:   'running',
    progress: { done: 0, total },
    results,
    errors: errors.length ? errors : undefined,
  });

  try {
    async function worker() {
      while (cursor < eligible.length) {
        const i = cursor++;
        const adDoc = eligible[i];
        const id = String(adDoc._id);
        console.log(`🎬 retitle-videos[brand=${brand._id}]: (${i + 1}/${eligible.length}) ad=${id} starting`);
        try {
          // Re-load as a Mongoose doc so updateOne in the save path works
          // cleanly, and renderBrandScriptAndSave can read fields.
          const ad = await Ad.findById(adDoc._id);
          if (!ad) {
            results.push({ id, ok: false, error: 'ad disappeared' });
          } else {
            const result = await renderBrandScriptAndSave({ ad, brand });
            if (result?.skipped) {
              results.push({ id, ok: true, skipped: true, renderUrl: ad.renderUrl || null });
              console.log(`🎬 retitle-videos[brand=${brand._id}]: ad=${id} skipped (${result.reason || 'no-chrome'})`);
            } else {
              results.push({ id, ok: true, renderUrl: result.renderUrl || null });
              console.log(`🎬 retitle-videos[brand=${brand._id}]: ad=${id} ok`);
            }
          }
        } catch (err) {
          results.push({ id, ok: false, error: err.message || String(err) });
          console.warn(`🎬 retitle-videos[brand=${brand._id}]: ad=${id} failed (${err.message})`);
        }
        done += 1;
        const prev = retitleJobs.get(jobId) || {};
        retitleJobs.set(jobId, {
          ...prev,
          status:   'running',
          progress: { done, total },
          results:  results.slice(),
          errors:   errors.length ? errors : undefined,
        });
      }
    }

    const poolSize = Math.min(concurrency, Math.max(1, eligible.length));
    // Empty eligible: still mark done (count=0) without spinning workers.
    if (eligible.length > 0) {
      await Promise.all(Array.from({ length: poolSize }, () => worker()));
    }

    const prev = retitleJobs.get(jobId) || {};
    retitleJobs.set(jobId, {
      ...prev,
      status:      'done',
      progress:    { done: total, total },
      results,
      errors:      errors.length ? errors : undefined,
      completedAt: Date.now(),
    });
    reapRetitleJob(jobId);
    console.log(`🎬 retitle-videos[${jobId}]: DONE brand=${brand._id} ${done}/${total}`);
  } catch (err) {
    console.error(`🎬 retitle-videos[${jobId}]: FAILED — ${err.message}`);
    const prev = retitleJobs.get(jobId) || {};
    retitleJobs.set(jobId, {
      ...prev,
      status:      'failed',
      error:       err.message || 'retitle-videos failed',
      progress:    { done, total },
      results,
      errors:      errors.length ? errors : undefined,
      completedAt: Date.now(),
    });
    reapRetitleJob(jobId);
  }
}

// POST /api/brand/:id/retitle-videos
// Batch re-title: run the brand's titling path over each video ad's
// veoVideoUrl (untitled base) and stamp Ad.renderUrl. Same tenant +
// ownership pattern as render-script. One failure never aborts the batch.
// Body: { adIds?: string[], dryRun?: boolean=false, concurrency?: number=2 (1..4) }
// dryRun → sync response. Live → 202 + jobId; poll GET /:id/retitle-videos/:jobId.
router.post('/:id/retitle-videos', express.json(), async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const body = req.body || {};
    const dryRun = body.dryRun === true;
    let concurrency = Number(body.concurrency);
    if (!Number.isFinite(concurrency)) concurrency = 2;
    concurrency = Math.min(4, Math.max(1, Math.floor(concurrency)));

    const Ad = require('../models/Ad');
    const Media = require('../models/Media');
    const mongoose = require('mongoose');

    // Eligible set: this brand's video ads with a retained base plate.
    const baseFilter = {
      brandId: brand._id,
      kind: 'video',
      veoVideoUrl: { $nin: [null, ''] },
    };

    const errors = [];
    let ads;
    if (body.adIds != null) {
      if (!Array.isArray(body.adIds)) {
        return res.status(400).json({ error: 'adIds must be an array of strings' });
      }
      const requested = body.adIds.map((id) => String(id));
      const validIds = requested.filter((id) => mongoose.isValidObjectId(id));
      for (const id of requested) {
        if (!mongoose.isValidObjectId(id)) {
          errors.push({ id, error: 'invalid id' });
        }
      }
      ads = validIds.length
        ? await Ad.find({ ...baseFilter, _id: { $in: validIds } }).lean()
        : [];
      const found = new Set(ads.map((a) => String(a._id)));
      for (const id of validIds) {
        if (found.has(id)) continue;
        // Unknown, wrong kind, no plate, or foreign brand — verify ownership
        // so we can report accurately.
        const foreign = await Ad.findById(id).select('_id brandId kind veoVideoUrl mediaId').lean();
        if (!foreign) {
          errors.push({ id, error: 'ad not found' });
          continue;
        }
        if (String(foreign.brandId) !== String(brand._id)) {
          // ad→media→brand ownership check for cross-brand ids
          const media = foreign.mediaId
            ? await Media.findById(foreign.mediaId).select('brandId').lean()
            : null;
          if (!media || String(media.brandId) !== String(brand._id)) {
            errors.push({ id, error: 'ad does not belong to this brand' });
            continue;
          }
        }
        if (foreign.kind !== 'video') {
          errors.push({ id, error: 'ad is not kind=video' });
          continue;
        }
        if (!foreign.veoVideoUrl) {
          errors.push({ id, error: 'ad has no veoVideoUrl' });
          continue;
        }
        errors.push({ id, error: 'ad not eligible' });
      }
    } else {
      // Oldest-first for stable truncate order when the batch is capped.
      ads = await Ad.find(baseFilter).sort({ createdAt: 1, _id: 1 }).lean();
    }

    // Ownership belt-and-suspenders: ad → media → brand must match.
    let eligible = [];
    for (const ad of ads) {
      const media = await Media.findById(ad.mediaId).select('brandId').lean();
      if (!media || String(media.brandId) !== String(brand._id)) {
        errors.push({ id: String(ad._id), error: 'ad does not belong to this brand' });
        continue;
      }
      eligible.push(ad);
    }

    // When adIds is omitted, clamp to MAX_RETITLE_BATCH (cost/RAM guard).
    // Oldest-first is already the query order above; re-sort for safety
    // if ownership filtering reordered nothing but the set was large.
    let truncated = false;
    let totalMatched = eligible.length;
    if (body.adIds == null && eligible.length > MAX_RETITLE_BATCH) {
      eligible = eligible
        .slice()
        .sort((a, b) => {
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          if (ta !== tb) return ta - tb;
          return String(a._id).localeCompare(String(b._id));
        })
        .slice(0, MAX_RETITLE_BATCH);
      truncated = true;
    }

    if (dryRun) {
      return res.json({
        count: eligible.length,
        ads: eligible.map((a) => ({
          id: String(a._id),
          createdAt: a.createdAt || null,
          renderUrl: a.renderUrl || null,
          veoVideoUrl: a.veoVideoUrl || null,
        })),
        errors: errors.length ? errors : undefined,
        ...(truncated ? { truncated: true, totalMatched } : {}),
      });
    }

    // Live path is async — re-title is tens of seconds per ad and
    // Netlify's proxy caps responses at ~26s (same reason as preview-script).
    const crypto = require('crypto');
    const jobId = crypto.randomBytes(6).toString('hex');
    retitleJobs.set(jobId, {
      status:    'pending',
      startedAt: Date.now(),
      brand:     String(brand._id),
      count:     eligible.length,
      progress:  { done: 0, total: eligible.length },
      results:   [],
      errors:    errors.length ? errors : undefined,
    });
    console.log(`🎬 retitle-videos[${jobId}]: brand=${brand._id} count=${eligible.length} concurrency=${concurrency}${truncated ? ` truncated from ${totalMatched}` : ''}`);

    // Fire-and-forget. Runner flips the job to done/failed; per-ad errors
    // land in results, never crash the process.
    runRetitleJob(jobId, brand, eligible, concurrency, errors);

    res.status(202).json({
      ok: true,
      jobId,
      status: 'pending',
      count: eligible.length,
      ...(truncated ? { truncated: true, totalMatched } : {}),
    });
  } catch (err) {
    console.error('retitle-videos failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'retitle-videos failed' });
  }
});

// GET /api/brand/:id/retitle-videos/:jobId — poll target for the async
// batch kicked off by POST. Returns:
//   { status: 'pending'|'running'|'done'|'failed',
//     count?, progress?: {done,total}, results?, errors?, error?, elapsedMs }
// 404 when the brand is not tenant-owned, the job doesn't exist, was
// reaped after 5 min, or brand mismatch.
router.get('/:id/retitle-videos/:jobId', async (req, res) => {
  try {
    // Tenant-scoped first so a leaked jobId cannot be polled cross-tenant.
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).select('_id').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const job = retitleJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'retitle job not found or expired' });
    // Cross-brand safety: reject reads for the wrong brand id.
    if (job.brand && String(job.brand) !== String(brand._id)) {
      return res.status(404).json({ error: 'retitle job not found' });
    }
    res.json({
      status:    job.status,
      count:     job.count,
      progress:  job.progress,
      results:   job.results,
      errors:    job.errors,
      error:     job.error,
      elapsedMs: Date.now() - (job.startedAt || Date.now()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'retitle job poll failed' });
  }
});

// In-memory async job store for preview renders. Netlify's proxy caps
// responses at ~26s; render + encode routinely runs 15-40s (varies with
// script complexity and Render CPU pressure). So the POST kicks off a
// background render and returns 202+jobId; the frontend polls GET
// /:id/preview-script/:jobId until status transitions.
// Auto-cleaned 5 min after done/failed so the map doesn't grow.
const previewJobs = new Map();
const PREVIEW_JOB_TTL_MS = 5 * 60 * 1000;

function reapPreviewJob(jobId) {
  setTimeout(() => previewJobs.delete(jobId), PREVIEW_JOB_TTL_MS);
}

// Runs the actual render off the request thread. Writes progress into
// previewJobs.set so the poller sees each state transition. Any thrown
// error is captured into { status: 'failed', error }.
async function runPreviewRender(jobId, brand, opts) {
  const { styleScript, useCanonical, canonicalFormat, meta, dims, totalFrames, engine, spec, tokens, placementMode } = opts;
  let brandPlateTempPath = null;
  try {
    // Plate resolution — brand image first, then picsum sample.
    let plateImagePath = null;
    let plateSource    = 'solid';
    const brandPick = await pickBrandPreviewMediaUrl(brand._id).catch(() => null);
    if (brandPick?.url) {
      try {
        brandPlateTempPath = await downloadUrlToTemp(brandPick.url);
        plateImagePath = brandPlateTempPath;
        plateSource    = `brand-media (${brandPick.shotType})`;
      } catch (err) {
        console.warn(`⚠️  preview-script[${jobId}]: brand media download failed (${err.message}) — falling back to sample`);
      }
    }
    if (!plateImagePath) {
      const sampleFile = await ensureSamplePlate(canonicalFormat);
      if (sampleFile) {
        plateImagePath = sampleFile;
        plateSource    = 'sample';
      }
    }

    let result;
    if (engine === 'remotion') {
      // Remotion preview: same spec/tokens pipeline as production, static
      // plate, half-scale. Returns the identical videoDataUrl contract.
      const { renderPreview } = require('../services/remotionRenderService');
      result = await renderPreview({
        meta,
        spec,
        tokens,
        format:         canonicalFormat,
        plateImagePath,
        plateColor:     brand.primaryColor || '#3D3D3D',
        scale:          0.5,
        durationSec:    totalFrames / 24,
        placementMode,
        brand,
      });
    } else {
      const { previewBrandScriptAsVideo } = require('../services/brandScriptExecutor');
      result = await previewBrandScriptAsVideo({
        styleScript,
        useCanonical,
        canonicalFormat,
        meta,
        width:           dims.width,
        height:          dims.height,
        totalFrames,
        plateImagePath,
        plateBackground: brand.primaryColor || '#3D3D3D',
        brandName:       brand.name
      });
    }

    const prev = previewJobs.get(jobId) || {};
    previewJobs.set(jobId, {
      ...prev,
      status:       'done',
      videoDataUrl: result.videoDataUrl,
      width:        dims.width,
      height:       dims.height,
      sizeBytes:    result.sizeBytes,
      plateSource,
      timings:      result.timings,
      completedAt:  Date.now()
    });
    reapPreviewJob(jobId);
    console.log(`🎬 preview-script[${jobId}]: DONE in ${Date.now() - (prev.startedAt || Date.now())}ms plate=${plateSource} bytes=${result.sizeBytes}`);
  } catch (err) {
    console.error(`🎬 preview-script[${jobId}]: FAILED — ${err.message}`);
    const prev = previewJobs.get(jobId) || {};
    previewJobs.set(jobId, {
      ...prev,
      status:      'failed',
      error:       err.message || 'preview failed',
      completedAt: Date.now()
    });
    reapPreviewJob(jobId);
  } finally {
    if (brandPlateTempPath) {
      const fs = require('fs');
      fs.promises.unlink(brandPlateTempPath).catch(() => {});
    }
  }
}

// Representative sample meta for previews — every slot fed so operators
// see the full composition. themeForPreview only matters to the canvas
// engine (meta.theme); the Remotion engine styles via tokens/spec.
//
// Multi-value fields (badges, benefits) get realistic populated arrays
// so a generated script referencing `meta.badges[]` shows something in
// preview instead of a hollow layout. Image URLs (productImageUrl,
// brandLogoUrl) point at brand assets when available so image slots
// and canvas endcard imagery render.
function buildPreviewSampleMeta(brand, themeForPreview) {
  return {
    brandName:          brand.name,
    badgeText:          'Customer Favorite',
    productName:        'Signature Product',
    productDescription: 'Crafted for daily wear. Made with premium materials that last.',
    price:              '$48',
    headline:           brand.tagline || 'Made better.',
    cta:                'SHOP NOW',
    ctaText:            'SHOP NOW',
    quote:              'Highly rated for comfort, durability, and standout style.',
    quoteSnippet:       'Highly rated for comfort and style',
    reviewer:           'Verified customer',
    deliveryLine:       'Ships free — arrives in 2-3 days',
    promoText:          'FREE SHIPPING',
    // Populated arrays so multi-value slots (badges, benefits) preview
    // realistically. Empty arrays would make BadgesSlot / BenefitsSlot
    // skip rendering, hiding whatever the operator's script is trying
    // to demonstrate.
    badges:             ['Bestseller', 'Free shipping', 'New arrival', 'Editor\'s pick'],
    benefits:           ['Premium materials', 'Made to last', 'Fits true to size', 'Machine washable'],
    rating:             4.6,
    reviewCount:        128,
    reviewsText:        '128 reviews',
    likes:              572,
    endcardMode:        'product',
    brandTagline:       brand.tagline || null,
    brandWebsiteUrl:    brand.websiteUrl || null,
    brandLogoUrl:       brand.logoUrl || null,
    // productImageUrl alias — same as productOnlyImageUrl (populated by
    // buildMetaForAd at real render time). Left null in preview; the
    // preview route fills it in from the brand's picked lifestyle plate.
    productImageUrl:    null,
    theme:              themeForPreview || {}
  };
}

// Disk cache for preview plates so the fast still loop doesn't re-download
// the brand's lifestyle image on every nudge. TTL'd; keyed by brand.
const previewPlateCache = new Map(); // brandId|format (stand-in) or ad:adId (real footage) → { path, source, at, temp, video? }
const PREVIEW_PLATE_TTL_MS = 10 * 60 * 1000;
async function getCachedPreviewPlate(brand, format) {
  const key = `${brand._id}|${format}`;
  sweepPreviewPlateCache();
  const hit = previewPlateCache.get(key);
  if (hit && Date.now() - hit.at < PREVIEW_PLATE_TTL_MS) return hit;
  let entry = null;
  const brandPick = await pickBrandPreviewMediaUrl(brand._id).catch(() => null);
  if (brandPick?.url) {
    try {
      const p = await downloadUrlToTemp(brandPick.url);
      entry = { path: p, source: `brand-media (${brandPick.shotType})`, at: Date.now(), temp: true };
    } catch {}
  }
  if (!entry) {
    const sampleFile = await ensureSamplePlate(format).catch(() => null);
    if (sampleFile) entry = { path: sampleFile, source: 'sample', at: Date.now(), temp: false };
  }
  if (!entry) entry = { path: null, source: 'solid', at: Date.now(), temp: false };
  // Replacing a downloaded temp plate: unlink the stale file (samples are
  // shared disk-cached assets and stay).
  if (hit?.temp && hit.path && hit.path !== entry.path) {
    require('fs').promises.unlink(hit.path).catch(() => {});
  }
  previewPlateCache.set(key, entry);
  return entry;
}

// Drop expired entries and unlink their temp files. Keyed-replacement
// alone can't do this: an ad plate whose veoVideoUrl changed lands under
// a NEW key, and idle brand/ad entries would otherwise pin full mp4s in
// tmpdir for the process lifetime. A 60s grace past the TTL keeps a
// just-fetched entry's file alive through any in-flight render copy.
function sweepPreviewPlateCache() {
  const now = Date.now();
  for (const [k, v] of previewPlateCache) {
    if (!v || v.promise || now - v.at < PREVIEW_PLATE_TTL_MS + 60_000) continue;
    previewPlateCache.delete(k);
    if (v.temp && v.path) require('fs').promises.unlink(v.path).catch(() => {});
  }
}

// Ad-footage plates: stills render over the ad's REAL base video, so what
// the operator refines against is exactly what the visibility scan judges.
// Keyed by adId + veoVideoUrl — a regenerated base video must never serve
// the previous cut's frames/scan. Concurrent misses share one in-flight
// download (promise sentinel) so multi-tab refinement can't orphan losing
// temp files. Rejects on download failure — caller falls back to the
// brand plate.
async function getCachedAdPlate(ad) {
  const key = `ad:${ad._id}|${ad.veoVideoUrl}`;
  sweepPreviewPlateCache();
  const hit = previewPlateCache.get(key);
  if (hit?.promise) return hit.promise;
  if (hit && Date.now() - hit.at < PREVIEW_PLATE_TTL_MS) return hit;
  // Replacing an expired entry: unlink its file NOW — overwriting the Map
  // slot with the promise sentinel would otherwise drop the only reference.
  if (hit?.temp && hit.path) require('fs').promises.unlink(hit.path).catch(() => {});
  const promise = (async () => {
    const p = await downloadUrlToTemp(ad.veoVideoUrl, '.mp4');
    const entry = { path: p, source: 'ad-video', at: Date.now(), temp: true, video: true };
    previewPlateCache.set(key, entry);
    return entry;
  })().catch((e) => {
    previewPlateCache.delete(key);
    throw e;
  });
  previewPlateCache.set(key, { promise, at: Date.now() });
  return promise;
}

// POST /api/brand/:id/title-still — the FAST refinement loop for the
// Remotion engine. Synchronous: renders 1-4 still frames (no video
// encode) from a spec — pass the spec being tweaked in the body, get
// frames back in ~1-3s warm. Powers /title-playground.
// Body: { format?, spec?, frames?: [seconds], scale? (0.2-1), meta? (overrides),
//         placementMode?: 'canonical'|'content', adId? }
router.post('/:id/title-still', express.json({ limit: '1mb' }), async (req, res) => {
  const t0 = Date.now();
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const rawFormat = String(req.body?.format || 'vertical').toLowerCase();
    if (!TITLING_FORMATS.includes(rawFormat)) {
      return res.status(400).json({ error: `unknown format '${rawFormat}'` });
    }

    let requestPlacement = null;
    if (req.body?.placementMode != null && String(req.body.placementMode).trim() !== '') {
      requestPlacement = String(req.body.placementMode).trim();
      if (!['canonical', 'content'].includes(requestPlacement)) {
        return res.status(400).json({ error: "placementMode must be 'canonical' or 'content'" });
      }
    }

    // Optional ad-footage mode: stills render over this ad's actual base
    // video — the same frames the visibility scan analyzes — instead of a
    // stand-in brand plate. Brand is already tenant-scoped and Ad.brandId
    // is a required ref, so the brandId match completes the tenancy check.
    let ad = null;
    if (req.body?.adId != null && String(req.body.adId).trim() !== '') {
      const adId = String(req.body.adId).trim();
      if (!require('mongoose').isValidObjectId(adId)) return res.status(400).json({ error: 'invalid adId' });
      const Ad = require('../models/Ad');
      ad = await Ad.findOne({ _id: adId, brandId: brand._id }).lean();
      if (!ad) return res.status(404).json({ error: 'ad not found' });
      if (!ad.veoVideoUrl) return res.status(400).json({ error: 'ad has no base video' });
    }

    const { resolveSpecForBrand, buildBrandTokens } = require('../services/titleSpecService');
    const { validateTitleSpec } = require('../services/titleSpecValidator');

    let spec;
    if (req.body?.spec != null) {
      const check = validateTitleSpec(req.body.spec, { format: rawFormat });
      if (!check.ok) return res.status(400).json({ error: `spec invalid: ${check.errors.slice(0, 5).join('; ')}`, errors: check.errors });
      spec = check.normalized;
    } else {
      spec = resolveSpecForBrand(brand, rawFormat).spec;
    }

    const frames = (Array.isArray(req.body?.frames) ? req.body.frames : [1.5])
      .map(Number).filter((s) => Number.isFinite(s) && s >= 0 && s <= 14).slice(0, 4);
    if (!frames.length) return res.status(400).json({ error: 'frames must contain 1-4 timestamps in seconds' });
    const scale = Math.min(1, Math.max(0.2, Number(req.body?.scale) || 0.5));

    // Only text fields may be overridden — asset URLs/paths from the body
    // would let a caller render arbitrary server-readable files.
    const META_TEXT_FIELDS = new Set(['headline', 'quote', 'quoteSnippet', 'reviewer', 'badgeText', 'productName', 'price', 'deliveryLine', 'ctaText', 'cta', 'promoText', 'brandName', 'brandTagline', 'reviewsText', 'rating', 'reviewCount', 'endcardMode']);
    const metaOverrides = {};
    if (req.body?.meta && typeof req.body.meta === 'object') {
      for (const [k, v] of Object.entries(req.body.meta)) {
        if (META_TEXT_FIELDS.has(k) && (v == null || typeof v === 'string' || typeof v === 'number')) metaOverrides[k] = v;
      }
    }
    // Ad mode uses the ad's REAL production meta (same builder the render
    // pipeline uses) so the preview text matches what would actually ship;
    // body overrides still win on top.
    let baseMeta;
    if (ad) {
      const { buildMetaForAd } = require('../services/brandScriptExecutor');
      baseMeta = await buildMetaForAd(ad, brand);
    } else {
      baseMeta = buildPreviewSampleMeta(brand, null);
    }
    const meta = { ...baseMeta, ...metaOverrides };
    const tokens = await buildBrandTokens(brand, { specFontOverrides: spec.tokenOverrides?.fonts || {} });

    let plate = null;
    if (ad) {
      try {
        plate = await getCachedAdPlate(ad);
      } catch (e) {
        console.warn(`title-still: ad plate download failed (${e.message}) — falling back to brand plate`);
      }
    }
    if (!plate) {
      const fallback = await getCachedPreviewPlate(brand, rawFormat);
      plate = ad ? { ...fallback, source: `${fallback.source} (ad-video failed)` } : fallback;
    }

    const { renderPreview } = require('../services/remotionRenderService');
    const result = await renderPreview({
      meta,
      spec,
      tokens,
      format:         rawFormat,
      plateVideoPath: plate.video ? plate.path : null,
      plateImagePath: plate.video ? null : plate.path,
      plateColor:     brand.primaryColor || '#3D3D3D',
      scale,
      durationSec:    8,
      stillTimesSec:  frames,
      includeVideo:   false,
      placementMode:  requestPlacement,
      brand,
    });

    res.json({
      ok:               true,
      format:           rawFormat,
      plateSource:      plate.source,
      frames:           result.frames,
      fps:              result.fps ?? null,
      plateDurationSec: result.durationSec ?? null,
      plateHints:       result.plateHints ?? null,
      placementMode:    result.placementMode ?? null,
      scanSampleTimes:  (result.plateHints?.samples || []).map((s) => s.atSec),
      tookMs:           Date.now() - t0
    });
  } catch (err) {
    console.error('title-still failed:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'title-still failed', tookMs: Date.now() - t0 });
  }
});

// POST /api/brand/:id/preview-script
// Kicks off an async render, returns 202 + jobId immediately. Poll
// GET /:id/preview-script/:jobId for status transitions.
//
// Body:
//   { script?: string, theme?: object, format?: 'vertical'|'feed'|'landscape' }
//
// Selection ladder:
//   - explicit body.script wins
//   - else explicit body.theme → canonical for the requested format
//   - else brand.styleScript / styleScriptVertical / styleScriptLandscape (per format)
//   - else brand.styleTheme → canonical for the requested format
//   - else 400
//
// Plate resolution ladder:
//   - brand's own lifestyle/on_model image (most recent) → downloaded fresh
//   - fallback picsum sample per format (cached to disk after first hit)
//   - fallback solid brand-primary fill (via executor)
router.post('/:id/preview-script', express.json(), async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const bodyScript = req.body?.script ? String(req.body.script).trim() : null;
    const bodyTheme  = req.body?.theme && typeof req.body.theme === 'object' ? req.body.theme : null;
    const rawFormat  = String(req.body?.format || '').toLowerCase();
    const format     = TITLING_FORMATS.includes(rawFormat) ? rawFormat : 'feed';
    const brandScriptField = ({
      vertical:  'styleScriptVertical',
      landscape: 'styleScriptLandscape',
      // square has no dedicated brand field — it shares feed's custom script, the
      // same way it shares feed's canonical. Adding styleScriptSquare later means a
      // row here plus one in brandScriptExecutor.BRAND_SCRIPT_FIELD.
      square:    'styleScript',
      feed:      'styleScript'
    })[format];

    // Engine: previews honor the production dispatch chain (custom script
    // forces canvas), with an explicit body.engine escape hatch and
    // body.spec for previewing an unsaved LLM-modified spec.
    const { resolveTitlingEngine } = require('../services/brandScriptExecutor');
    const bodyEngine = ['canvas', 'remotion'].includes(req.body?.engine) ? req.body.engine : null;
    // classifyFormat keys off platformFormat regexes / aspectRatio — the
    // synthetic ad must use an aspectRatio it actually recognizes.
    const fakeAd = { aspectRatio: ASPECT_BY_TITLING_FORMAT[format] };
    let engine = bodyScript
      ? 'canvas'
      : bodyEngine || resolveTitlingEngine(brand, fakeAd).engine;

    let requestPlacement = null;
    if (req.body?.placementMode != null && String(req.body.placementMode).trim() !== '') {
      requestPlacement = String(req.body.placementMode).trim();
      if (!['canonical', 'content'].includes(requestPlacement)) {
        return res.status(400).json({ error: "placementMode must be 'canonical' or 'content'" });
      }
    }

    let styleScript = null;
    let themeForPreview = null;
    let useCanonical = false;
    let previewSpec = null;
    let previewTokens = null;
    if (engine === 'remotion') {
      const { resolveSpecForBrand, buildBrandTokens } = require('../services/titleSpecService');
      const { validateTitleSpec } = require('../services/titleSpecValidator');
      if (req.body?.spec != null) {
        const specRes = validateTitleSpec(req.body.spec, { format });
        if (!specRes.ok) return res.status(400).json({ error: `spec invalid: ${specRes.errors.slice(0, 5).join('; ')}` });
        previewSpec = specRes.normalized;
      } else {
        previewSpec = resolveSpecForBrand(brand, format).spec;
      }
      previewTokens = await buildBrandTokens(brand, { specFontOverrides: previewSpec.tokenOverrides?.fonts || {} });
    } else if (bodyScript) {
      styleScript = bodyScript;
    } else if (bodyTheme) {
      useCanonical = true;
      themeForPreview = bodyTheme;
    } else if (brand[brandScriptField] && String(brand[brandScriptField]).trim()) {
      styleScript = brand[brandScriptField];
    } else if (brand.styleTheme && Object.keys(brand.styleTheme).length > 0) {
      useCanonical = true;
      themeForPreview = brand.styleTheme;
    } else {
      return res.status(400).json({ error: 'no script or theme — pass one in the body or save the brand first' });
    }

    // Canvas dims — preview renders at HALF the production ad size so
    // each frame's PNG encode is 4x cheaper (linear in pixel count).
    //   feed      → 540×675  (4:5 preview, real 1080×1350)
    //   vertical  → 540×960  (9:16 preview, real 1080×1920)
    //   landscape → 960×540  (16:9 preview, real 1920×1080)
    const dims = ({
      vertical:  { width: 540,  height: 960  },
      landscape: { width: 960,  height: 540  },
      feed:      { width: 540,  height: 675  }
    })[format];

    const totalFrames = 192; // 8s @ 24fps — matches canonical timing convention.

    const meta = buildPreviewSampleMeta(brand, themeForPreview);

    const crypto = require('crypto');
    const jobId = crypto.randomBytes(6).toString('hex');
    previewJobs.set(jobId, {
      status:    'pending',
      startedAt: Date.now(),
      brand:     String(brand._id),
      format
    });
    console.log(`🎬 preview-script[${jobId}]: brand="${brand.name}" format=${format} engine=${engine} scriptChars=${styleScript?.length || 0} themeMode=${useCanonical}`);

    // Fire-and-forget. The runner flips the job to done/failed when it
    // finishes; errors are captured into the job entry, never crash.
    runPreviewRender(jobId, brand, {
      styleScript, useCanonical, canonicalFormat: format, meta, dims, totalFrames,
      engine, spec: previewSpec, tokens: previewTokens, placementMode: requestPlacement,
    });

    res.status(202).json({ ok: true, jobId, status: 'pending', format, engine });
  } catch (err) {
    console.error('preview-script kick failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'preview-script failed' });
  }
});

// GET /api/brand/:id/preview-script/:jobId — poll target for the async
// render kicked off by POST. Returns:
//   { status: 'pending' | 'done' | 'failed',
//     videoDataUrl?, plateSource?, width?, height?, sizeBytes?,
//     error?, elapsedMs }
// 404 when the job doesn't exist OR was reaped after 5 min.
router.get('/:id/preview-script/:jobId', async (req, res) => {
  try {
    const job = previewJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'preview job not found or expired' });
    // Cross-brand safety: reject reads for the wrong brand id.
    if (job.brand && String(job.brand) !== String(req.params.id)) {
      return res.status(404).json({ error: 'preview job not found' });
    }
    res.json({
      status:       job.status,
      format:       job.format,
      videoDataUrl: job.videoDataUrl,
      plateSource:  job.plateSource,
      width:        job.width,
      height:       job.height,
      sizeBytes:    job.sizeBytes,
      error:        job.error,
      timings:      job.timings,
      elapsedMs:    Date.now() - (job.startedAt || Date.now())
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'preview status lookup failed' });
  }
});

// POST /api/brand/:id/ingest-fonts — pull the brand website's actual
// font files (the "titling must use the brand's real fonts" scan).
// Synchronous (a site fetch + a few font downloads — seconds, not
// minutes). OFL/Google/self-hosted faces are mirrored to Cloudinary and
// upserted into brand.customFonts; commercial-foundry faces are recorded
// flagged-only (needsLicense) and never downloaded.
router.post('/:id/ingest-fonts', express.json(), async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    if (!brand.websiteUrl) return res.status(400).json({ error: 'brand has no websiteUrl to scan' });

    const { ingestBrandFonts } = require('../services/brandFontIngestService');
    const result = await ingestBrandFonts(brand);
    const { ingested, flagged, errors } = result;
    const { applyFontIngestResult } = require('../services/brandFontPersistenceService');
    applyFontIngestResult(brand, result);
    await brand.save();

    console.log(`🔤 ingest-fonts[${brand.name}]: ${ingested.length} ingested, ${flagged.length} flagged, ${errors.length} errors`);
    res.json({ ok: true, ingested, flagged, errors, usage: result.usage, customFonts: brand.customFonts });
  } catch (err) {
    console.error('ingest-fonts failed:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'font ingest failed' });
  }
});

// GET /api/brand/:id/meta-cascades — every meta field the titling
// engine consumes, with its effective source cascade (brand overrides
// merged over shipped defaults) and a human label for each field.
// Feeds the operator UI's cascade editor: shows what the value would
// resolve from, in order, for the current brand + a chosen fixture.
// PATCH /api/brand/:id { metaCascades: { <field>: source[] } } to save
// a per-field override.
router.get('/:id/meta-cascades', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).select('metaCascades').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    const {
      DEFAULT_META_CASCADES,
      mergeCascades,
    } = require('../services/metaCascadeResolver');
    const {
      CASCADED_FIELDS,
      CONTEXT_DOC_NAMES,
      FIELD_LABELS,
    } = require('../services/metaCascadeConfig');
    const brandOverrides = brand.metaCascades || {};
    const effective = mergeCascades(DEFAULT_META_CASCADES, brandOverrides);
    // Per-field payload: label, effective cascade (merged), default
    // cascade (for "reset" affordance), and whether the brand has
    // overridden this field (drives the UI's "customized" indicator).
    const fields = CASCADED_FIELDS.map((field) => ({
      field,
      label:        FIELD_LABELS[field] || field,
      effective:    effective[field] || [],
      default:      DEFAULT_META_CASCADES[field] || [],
      isOverridden: Array.isArray(brandOverrides[field]) && brandOverrides[field].length > 0,
    }));
    res.json({
      fields,
      // Enum-ish helpers so the UI can populate its dropdowns without
      // duplicating the vocabulary. contextDocs are the whitelisted
      // `doc` names a doc-typed source can point at.
      contextDocs: [...CONTEXT_DOC_NAMES],
    });
  } catch (err) {
    console.error('meta-cascades lookup failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'meta-cascades lookup failed' });
  }
});

// GET /api/brand/:id/title-spec — the Remotion titling state for the
// operator UI: the brand's saved per-format overrides, the resolved
// effective spec per format (with its source), available presets, and
// the resolved brand tokens (colors + fonts) the specs render with.
router.get('/:id/title-spec', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const { resolveSpecForBrand, buildBrandTokens, hydrateAllSlotKeys, PRESET_DIR } = require('../services/titleSpecService');
    const resolved = {};
    for (const format of TITLING_FORMATS) {
      try {
        const { spec, source } = resolveSpecForBrand(brand, format);
        // Hydrate stub entries for every SLOT_KEYS not present so the
        // Title Studio dropdown surfaces every available slot (all
        // visible: false — operator flips them on as needed). Doesn't
        // affect what renders.
        const hydrated = hydrateAllSlotKeys(spec);
        const fmtTokens = await buildBrandTokens(brand, { specFontOverrides: spec.tokenOverrides?.fonts || {} });
        const fonts = Object.fromEntries(Object.entries(fmtTokens.fonts).map(([r, f]) => [r, { family: f.family, weight: f.weight, source: f.source, url: f.remoteUrl || null, fallback: f.fallback }]));
        resolved[format] = { spec: hydrated, source, fonts };
      } catch (e) {
        resolved[format] = { spec: null, source: `error: ${e.message}` };
      }
    }
    const fs = require('fs');
    const presets = fs.readdirSync(PRESET_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
    const tokens = await buildBrandTokens(brand, {});

    // Identity for preview chrome (Meta-style placement overlays): the
    // connected IG account's real handle when one exists, else a slug of
    // the brand name.
    let igHandle = null;
    try {
      const cred = await IntegrationCredential.findOne({ brandId: brand._id, type: 'instagram', status: 'active' })
        .select('igUsername').lean();
      igHandle = cred?.igUsername || null;
    } catch { /* optional */ }
    const brandInfo = {
      name: brand.name,
      handle: igHandle || String(brand.name || 'brand').toLowerCase().replace(/[^a-z0-9._]+/g, ''),
      logoUrl: brand.logoUrl || null,
    };
    // Local font-file paths are server internals; url here is the
    // browser-loadable origin (gstatic/Cloudinary) for the frontend
    // @remotion/player live preview.
    const fonts = Object.fromEntries(Object.entries(tokens.fonts).map(([r, f]) => [r, { family: f.family, weight: f.weight, source: f.source, url: f.remoteUrl || null, fallback: f.fallback }]));

    const { resolveTitlePlacementMode } = require('../services/plateIntelService');
    res.json({
      titleStyleSpec: brand.titleStyleSpec || null,
      titleStylePreset: brand.titleStylePreset || null,
      // keep in sync with resolveTitlingEngine default
      titlingEngine: brand.videoSettings?.titlingEngine || process.env.TITLING_ENGINE || 'remotion',
      titlePlacementMode: resolveTitlePlacementMode({ brand }),
      brand: brandInfo,
      resolved,
      presets,
      tokens: { colors: tokens.colors, fonts },
      customFonts: brand.customFonts || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'title-spec lookup failed' });
  }
});

// In-memory job store for async title-spec modification (same
// pattern/TTL as scriptJobs below — Netlify's proxy timeout forces the
// 202+poll shape for anything that waits on Atlas).
const specJobs = new Map();
const SPEC_JOB_TTL_MS = 5 * 60 * 1000;
function reapSpecJob(jobId) {
  setTimeout(() => specJobs.delete(jobId), SPEC_JOB_TTL_MS).unref?.();
}

// Compact schema reference the LLM edits against — generated from the
// validator's own vocabulary so prompt and validation can't drift. Slot
// semantic descriptions (below) let the LLM understand what each key
// represents so operators can write natural-language requests like
// "show the badges in a cascade" or "reveal the product image at 5s".
function titleSpecSchemaPrompt() {
  const V = require('../services/titleSpecValidator');
  const SLOT_DOCS = {
    // Existing text
    headline:           'text — the ad\'s hook headline (bound from meta.headline)',
    quote:              'text — customer quote snippet (bound from meta.quoteSnippet → quote)',
    reviewer:           'text — attribution line under the quote (meta.reviewer)',
    rating:             'composite — 5-star row + rating value + review count (no bind chain)',
    badge:              'text — the primary product badge, e.g. "Bestseller" (meta.badgeText)',
    brandPill:          'text|image — brand mark: renders logo image when available, text pill otherwise (meta.brandName + meta.brandLogoUrl)',
    productName:        'text — the product title (meta.productName)',
    price:              'text — product price, currency-prefixed if bare number (meta.price)',
    deliveryLine:       'text — shipping / offer callout (meta.deliveryLine)',
    cta:                'text — call-to-action button label (meta.ctaText)',
    promo:              'text — promotional pill, e.g. "FREE SHIPPING" (meta.promoText — null skips the pill)',
    // Added text slots
    productDescription: 'text — 1–2-sentence product summary (meta.productDescription)',
    tagline:            'text — brand tagline / hero line (meta.brandTagline)',
    website:            'text — brand website domain compact form, e.g. "brand.com" (meta.brandWebsiteDomain)',
    likes:              'text — engagement count, formatted with heart icon, e.g. "1.2k likes" (meta.likes)',
    reviewCount:        'text — review count formatted, e.g. "128 reviews" (meta.reviewCount)',
    // Multi-value slots
    badges:             'multi — the full badges array; renders each as a pill/chip/bullet in a row/stack/grid; supports staggered cascade entrance (meta.badges[])',
    benefits:           'multi — short product benefits array, e.g. ["Vegan", "SPF 30", "Fragrance-free"]; typically bullet stack (meta.benefits[])',
    // Image slots
    productImage:       'image — the product-only catalog image, rendered as <img> with fit/size/radius (meta.productImageUrl)',
    brandLogo:          'image — the brand logo as a standalone slot (meta.brandLogoUrl)',
  };
  const slotSummary = V.SLOT_KEYS.map((k) => `  ${k}: ${SLOT_DOCS[k] || 'text'}`).join('\n');

  return [
    'TITLE STYLE SPEC SCHEMA (v1) — a per-format JSON document:',
    '{ "version": 1,',
    '  "phases": [{ "key": str, "startSec": num, "endSec": num }],  // 1-4 phases, 0..15s',
    '  "stack": { "rowGapPct": 0..0.08 },                            // optional',
    '  "tokenOverrides": {                                           // optional',
    `    "colors": { <${V.TOKEN_COLOR_KEYS.join('|')}>: "#RRGGBB" },`,
    '    "fonts": { "heading"|"body"|"quote": { "family": str, "weight": 100-900 } } },',
    '  "slots": [{',
    `    "key": one of the SLOT KEYS listed below,               // unique per spec`,
    '    "visible": bool,                                            // set false to keep the slot in the spec but not render it',
    `    "bind": [meta fields — TEXT slots use ${V.BINDABLE_META_FIELDS.join(', ')};`,
    `                            MULTI slots use ${V.BINDABLE_MULTI_META_FIELDS.join(', ')};`,
    `                            IMAGE slots use ${V.BINDABLE_IMAGE_META_FIELDS.join(', ')};`,
    '                            first non-empty value in the chain wins]',
    '    "phase": str,                                               // must reference a phase key',
    `    "position": { "anchor": ${V.ANCHORS.join('|')}, "align": ${V.ALIGNS.join('|')},`,
    '                  "offsetX": -0.25..0.25, "offsetY": -0.25..0.25, "maxWidthPct": 0.2..1, "row": str|null },',
    '    "timing": { "enterAtSec": num, "exitAtSec": num|null (null = hold to end), "enterDurationSec": 0..2, "exitDurationSec": 0..2 },',
    `    "transition": { "type": ${V.TRANSITIONS.join('|')}, "direction": up|down|left|right, "spring": { "damping", "stiffness", "mass" }|null },`,
    `    "treatment": { "scrim": ${V.SCRIMS.join('|')}, "scrimOpacity": 0..1, "scrimColorToken": color token,`,
    `                   "shadow": ${V.SHADOWS.join('|')}, "casing": ${V.CASINGS.join('|')}, "fontRole": heading|body|quote,`,
    '                   "weight": 100-900, "sizeScale": 0.5..2, "maxLines": 1-4, "trackingPx": 0..8,',
    '                   "colorToken": color token, "accent": { "type": underline|bar|none, "colorToken": color token, "animate": bool },',
    `                   // MULTI slots only: "itemLayout": ${V.ITEM_LAYOUTS.join('|')}, "itemStyle": ${V.ITEM_STYLES.join('|')}, "itemDelaySec": 0..2 (stagger between items), "itemGap": 0..0.05, "maxItems": 1..8`,
    `                   // IMAGE slots only: "fit": ${V.IMAGE_FITS.join('|')}, "sizePct": 0.05..0.9 (fraction of canvas short edge), "radiusPct": 0..0.5, "borderWidthPct": 0..0.02, "borderColorToken": color token`,
    '                 }',
    '  }]',
    '}',
    '',
    'SLOT KEYS (semantic reference — bind chain, type, and content source):',
    slotSummary,
    '',
    'RENDERING RULES:',
    '- Slots sharing (phase, anchor) stack top-to-bottom in array order; a shared position.row renders side by side.',
    '- Positions are safe-zone clamped at render time. Slots whose bound meta value is empty (or null / empty array) are skipped automatically.',
    '- MULTI slots iterate their bound array; use itemDelaySec > 0 to cascade item entrances one after the other.',
    '- IMAGE slots draw a single <img> — sizePct is a fraction of the canvas short edge; radiusPct rounds the corners.',
    '- Set visible:true to enable a slot the current spec has hidden; the operator may reference any slot key from the SLOT KEYS list.',
  ].join('\n');
}

// Format the client-provided chat history for the LLM prompt. History is
// an ordered array of { role: 'user'|'assistant', content: string } — we
// compact it into a plain-text block prefixed to the current user
// message so the LLM has multi-turn continuity ("earlier the operator
// asked X, you did Y") without needing atlasTextService's messages API.
// Capped at the last 10 turns to bound token spend on long sessions.
function formatChatHistoryForPrompt(history) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const capped = history.slice(-10);
  const lines = ['CONVERSATION HISTORY (oldest first, most recent last):'];
  for (const turn of capped) {
    if (!turn || typeof turn !== 'object') continue;
    const role = turn.role === 'user' ? 'Operator' : 'You';
    const content = String(turn.content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (content) lines.push(`- ${role}: ${content}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

async function runModifyTitleSpec(jobId, brand, { format, currentSpec, request, history = [] }) {
  const { validateTitleSpec } = require('../services/titleSpecValidator');
  const { buildBrandTokens } = require('../services/titleSpecService');
  const { generate } = require('../services/atlasTextService');
  try {
    const tokens = await buildBrandTokens(brand, {});
    const system = [
      'You are a video-ad title stylist. You edit a declarative "title style spec" that a rendering engine consumes.',
      'Apply the operator\'s requested modifications to the CURRENT SPEC and return the result as raw JSON.',
      '',
      'RESPONSE SHAPE — return a single JSON object with exactly these keys:',
      '  {',
      '    "spec":    <the COMPLETE updated title style spec>,',
      '    "summary": "<one short sentence (≤160 chars) describing what you changed in plain English>"',
      '  }',
      'Rules: return ONLY the JSON object (no markdown fences, no commentary outside the object). Keep every part of',
      'the current spec the operator did not ask to change. Stay strictly inside the schema and its bounds. Colors are',
      '#RRGGBB. Fonts should be Google Fonts families or the brand\'s ingested families. The clip is nominally 8 seconds.',
      'Summary examples: "Enabled the badges slot as a cascade row at 3s with 4 items." · "Warmed accent color to',
      '#E89258; kept the CTA text unchanged."',
      '',
      titleSpecSchemaPrompt(),
    ].join('\n');
    const historyBlock = formatChatHistoryForPrompt(history);
    const userMsg = (extra) => [
      `FORMAT: ${format}`,
      `BRAND TOKENS (defaults the spec inherits — override via tokenOverrides only when asked): ${JSON.stringify({ colors: tokens.colors, fonts: Object.fromEntries(Object.entries(tokens.fonts).map(([r, f]) => [r, f.family])) })}`,
      historyBlock,   // empty string when no history — filter(Boolean) below drops it
      `CURRENT SPEC:\n${JSON.stringify(currentSpec, null, 2)}`,
      `OPERATOR REQUEST: ${request}`,
      extra || '',
    ].filter(Boolean).join('\n\n');

    // Parse the LLM response into { spec, summary }. Tolerant to both the
    // new envelope shape and the legacy bare-spec response, so a temporary
    // regression in the LLM's format compliance doesn't break the flow.
    const parseResponse = (text) => {
      const cleaned = String(text).replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      let obj;
      try { obj = JSON.parse(cleaned); }
      catch {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('no JSON object in response');
        obj = require('json5').parse(m[0]);
      }
      // New envelope: { spec, summary }
      if (obj && typeof obj === 'object' && obj.spec && typeof obj.spec === 'object' && !Array.isArray(obj.spec)) {
        return { spec: obj.spec, summary: typeof obj.summary === 'string' ? obj.summary.slice(0, 400) : null };
      }
      // Legacy bare spec — infer.
      return { spec: obj, summary: null };
    };

    let lastErrors = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const extra = lastErrors
        ? `YOUR PREVIOUS ATTEMPT FAILED VALIDATION with these errors — fix them and return the corrected full spec:\n${lastErrors.join('\n')}`
        : '';
      const result = await generate({ system, user: userMsg(extra), temperature: 0.3, maxTokens: 8000 });
      let parsed;
      try {
        parsed = parseResponse(result.text);
      } catch (e) {
        lastErrors = [`response was not parseable JSON: ${e.message}`];
        continue;
      }
      const check = validateTitleSpec(parsed.spec, { format });
      if (check.ok) {
        const prev = specJobs.get(jobId) || {};
        specJobs.set(jobId, {
          ...prev,
          status: 'done',
          spec: check.normalized,
          summary: parsed.summary,
          model: result.model,
          usage: result.usage,
          attempts: attempt,
          completedAt: Date.now(),
        });
        reapSpecJob(jobId);
        console.log(`🎨 modify-title-spec[${jobId}]: DONE (attempt ${attempt}) summary="${(parsed.summary || '').slice(0, 60)}"`);
        return;
      }
      lastErrors = check.errors.slice(0, 10);
      console.warn(`🎨 modify-title-spec[${jobId}]: attempt ${attempt} invalid — ${lastErrors[0]}`);
    }
    throw new Error(`spec failed validation after retry: ${lastErrors.join('; ')}`);
  } catch (err) {
    const prev = specJobs.get(jobId) || {};
    specJobs.set(jobId, { ...prev, status: 'failed', error: err.message, completedAt: Date.now() });
    reapSpecJob(jobId);
    console.error(`🎨 modify-title-spec[${jobId}]: FAILED — ${err.message}`);
  }
}

// POST /api/brand/:id/title-spec/modify — natural-language spec editing.
// Body: { request: string, format?: 'vertical'|'feed'|'landscape' (default vertical) }
// The LLM receives the schema + the brand's current effective spec +
// tokens and returns a full updated spec; it is validated (one repair
// retry) but NOT persisted — the operator previews it (POST
// /preview-script with body.spec) and saves via PATCH titleStyleSpec.
router.post('/:id/title-spec/modify', express.json(), async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    const request = String(req.body?.request || '').trim();
    if (!request) return res.status(400).json({ error: 'request text required' });
    if (request.length > 2000) return res.status(400).json({ error: 'request too long (2000 chars max)' });
    const rawFormat = String(req.body?.format || 'vertical').toLowerCase();
    if (!TITLING_FORMATS.includes(rawFormat)) {
      return res.status(400).json({ error: `unknown format '${rawFormat}'` });
    }
    // Optional chat history for multi-turn context. Client-side chats
    // pass their prior turns here so the LLM sees the running thread.
    // Sanitized: only role + content survive, and only 'user'/'assistant'
    // roles are honored — anything else is dropped rather than errored.
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const history = rawHistory
      .filter((t) => t && typeof t === 'object' && (t.role === 'user' || t.role === 'assistant'))
      .map((t) => ({ role: t.role, content: String(t.content || '').slice(0, 1000) }))
      .filter((t) => t.content);

    // Optional client-supplied base spec — lets the chat resume from a
    // reverted turn's snapshot instead of the brand's currently-saved
    // spec. Falls back to the resolved brand cascade when absent.
    // Validated + hydrated the same way as the resolver output.
    const { resolveSpecForBrand, hydrateAllSlotKeys } = require('../services/titleSpecService');
    const { validateTitleSpec } = require('../services/titleSpecValidator');
    let baseSpec, source;
    if (req.body?.baseSpec && typeof req.body.baseSpec === 'object' && !Array.isArray(req.body.baseSpec)) {
      const check = validateTitleSpec(req.body.baseSpec, { format: rawFormat });
      if (!check.ok) return res.status(400).json({ error: `baseSpec invalid: ${check.errors.slice(0, 3).join('; ')}` });
      baseSpec = check.normalized;
      source = 'client';
    } else {
      const resolved = resolveSpecForBrand(brand, rawFormat);
      baseSpec = resolved.spec;
      source = resolved.source;
    }
    // Hydrate the spec so the LLM sees every possible slot in CURRENT
    // SPEC. Requests like "cascade the badges" now work even when the
    // brand's saved spec doesn't yet include a `badges` slot — the stub
    // (visible:false) is in the current-spec payload, and Claude can
    // flip visible + tune the timing.
    const currentSpec = hydrateAllSlotKeys(baseSpec);

    const crypto = require('crypto');
    const jobId = crypto.randomBytes(6).toString('hex');
    specJobs.set(jobId, { status: 'pending', startedAt: Date.now(), brand: String(brand._id), format: rawFormat, baseSource: source });
    console.log(`🎨 modify-title-spec[${jobId}]: brand="${brand.name}" format=${rawFormat} base=${source} history=${history.length} request="${request.slice(0, 80)}"`);

    runModifyTitleSpec(jobId, brand, { format: rawFormat, currentSpec, request, history });
    res.status(202).json({ ok: true, jobId, status: 'pending', format: rawFormat, baseSource: source });
  } catch (err) {
    console.error('modify-title-spec kick failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'modify-title-spec failed' });
  }
});

// Poll target for the modify job. On done: { status:'done', spec, ... } —
// preview it via POST /:id/preview-script { spec, format, engine:'remotion' },
// persist via PATCH /:id { titleStyleSpec: { [format]: spec } }.
router.get('/:id/title-spec/modify/:jobId', async (req, res) => {
  const job = specJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'spec job not found or expired' });
  if (job.brand && String(job.brand) !== String(req.params.id)) {
    return res.status(404).json({ error: 'spec job not found' });
  }
  // Tenant scope: the jobId alone must not leak results across advertisers.
  const owned = await Brand.exists(tenantFilter(req, { _id: req.params.id })).catch(() => null);
  if (!owned) return res.status(404).json({ error: 'spec job not found' });
  res.json({
    status: job.status,
    format: job.format,
    baseSource: job.baseSource,
    spec: job.spec,
    summary: job.summary,           // one-sentence AI explanation of the change (chat panel display)
    error: job.error,
    model: job.model,
    usage: job.usage,
    attempts: job.attempts,
    elapsedMs: Date.now() - (job.startedAt || Date.now())
  });
});

// In-memory job store for async script generation. Claude can take
// 30-90s per script; Netlify's ~26s proxy timeout would 504 the
// browser long before Atlas responds if we awaited inline. So the
// POST kicks off a promise and returns 202 immediately; the frontend
// polls GET /generate-script/:jobId until status transitions.
// Auto-cleaned after DONE/FAILED + 5 min so the map doesn't grow.
const scriptJobs = new Map(); // jobId → { status, startedAt, script?, error?, model?, usage?, finishReason?, brand? }
const SCRIPT_JOB_TTL_MS = 5 * 60 * 1000;

function reapJob(jobId) {
  setTimeout(() => scriptJobs.delete(jobId), SCRIPT_JOB_TTL_MS);
}

// Reference theme — Claude studies this to understand the schema.
// Camelback Flowers, hand-tuned. Emphasises earthy, botanical palette
// so Claude has a concrete example of thoughtful color pairing.
const REFERENCE_THEME = {
  sansFontFamily:    'Inter',
  serifFontFamily:   'Lora',
  productFontFamily: 'Cormorant Garamond',
  productFontWeight: 600,
  quoteFontFamily:   'Lora',
  badgeBgColor:      [194, 209, 173],
  badgeTextColor:    [66, 94, 54],
  ctaBgColor:        [70, 120, 62],
  ctaTextColor:      [255, 248, 239],
  ctaStrokeColor:    [225, 222, 209],
  textPrimary:       [250, 244, 236],
  textSecondary:     [224, 214, 202],
  textMuted:         [201, 189, 175],
  accentGold:        [214, 171, 83],
  ratingBarStart:    [201, 128, 130],
  ratingBarMid:      [216, 169, 81],
  ratingBarEnd:      [120, 144, 95],
  dividerColor:      [213, 199, 183],
  brandPillStroke:   [255, 247, 239],
  brandPillText:     [255, 247, 239]
};

async function runGenerateScript(jobId, brand, direction) {
  try {
    const system = [
      'You are picking a THEME for a per-brand canvas overlay in a video ad pipeline.',
      '',
      'Layout, animation, and which elements appear are FIXED by a shared renderer. Your ONLY job is to pick colors + font families that fit the brand. Return a single JSON object matching this exact shape (all keys required, all arrays are [R, G, B] with values 0-255):',
      '',
      '{',
      '  "sansFontFamily":    "Inter",',
      '  "serifFontFamily":   "Lora",',
      '  "productFontFamily": "Cormorant Garamond",',
      '  "productFontWeight": 600,',
      '  "quoteFontFamily":   "Lora",',
      '  "badgeBgColor":      [R, G, B],   // small pastel pill behind badgeText ("Customer Favorite")',
      '  "badgeTextColor":    [R, G, B],   // text inside the badge pill — high contrast vs badgeBg',
      '  "ctaBgColor":        [R, G, B],   // primary CTA button fill',
      '  "ctaTextColor":      [R, G, B],   // CTA label — high contrast vs ctaBg',
      '  "ctaStrokeColor":    [R, G, B],   // thin stroke around CTA',
      '  "textPrimary":       [R, G, B],   // product name + top of quote — usually near white',
      '  "textSecondary":     [R, G, B],   // reviewer, delivery line, secondary meta',
      '  "textMuted":         [R, G, B],   // supporting labels',
      '  "accentGold":        [R, G, B],   // 5-star row + accent moments',
      '  "ratingBarStart":    [R, G, B],   // left end of the 5-star fill gradient',
      '  "ratingBarMid":      [R, G, B],',
      '  "ratingBarEnd":      [R, G, B],',
      '  "dividerColor":      [R, G, B],',
      '  "brandPillStroke":   [R, G, B],   // stroke of the top brand pill',
      '  "brandPillText":     [R, G, B]',
      '}',
      '',
      'FONT FAMILY RULES:',
      '- Pick from families bundled in assets/fonts: Inter, Montserrat, Great Vibes, Cormorant Garamond, Lora, Playfair Display, DM Sans, Antonio.',
      '- sansFontFamily should be a clean modern sans (Inter, DM Sans, Montserrat).',
      '- productFontFamily is the hero — pick something that matches the brand vibe (Cormorant Garamond for elegant, Antonio for bold, Playfair Display for editorial).',
      '- quoteFontFamily should read well in italic — Lora, Playfair Display, Cormorant Garamond.',
      '',
      'COLOR RULES:',
      '- Palette must feel cohesive — pick 2-3 base hues and lean into their neighbours.',
      '- Every text color pairs with its background at ≥4.5:1 contrast.',
      '- The rating bar gradient (start → mid → end) should read as a warm cross-color arc.',
      '- Video plates behind the overlay may be any color, so text colors should hold up on both light AND dark plates (a soft scrim already gives 40-70% dark backdrop for text zones — pick text colors that read against ~30% grey).',
      '',
      'OUTPUT: return ONLY the raw JSON object. No markdown fences, no commentary, no leading prose. The response must parse cleanly with JSON.parse().'
    ].join('\n');

    const brandContextLines = [
      `Brand name: ${brand.name}`,
      brand.tagline           ? `Tagline: ${brand.tagline}` : null,
      brand.summary           ? `Summary: ${brand.summary}` : null,
      brand.tone?.length      ? `Tone: ${brand.tone.join(', ')}` : null,
      brand.primaryColor      ? `Primary color: ${brand.primaryColor}` : null,
      brand.secondaryColor    ? `Secondary color: ${brand.secondaryColor}` : null,
      brand.accentColor       ? `Accent color: ${brand.accentColor}` : null,
      brand.fontColor         ? `Font color: ${brand.fontColor}` : null,
      brand.fontFamily        ? `Preferred font family: ${brand.fontFamily}` : null,
      brand.hashtags?.length  ? `Hashtags: ${brand.hashtags.join(' ')}` : null
    ].filter(Boolean);

    const user = [
      `Pick a theme JSON tailored to this brand:`,
      '',
      brandContextLines.join('\n'),
      '',
      direction ? `Operator direction: ${direction}` : '',
      '',
      '── Reference theme (Camelback Flowers — earthy botanical). Study the structure, then produce a distinctly different palette for the brand above:',
      '```json',
      JSON.stringify(REFERENCE_THEME, null, 2),
      '```',
      '',
      `Now write the ${brand.name} theme.`
    ].filter(Boolean).join('\n');

    const { generate } = require('../services/atlasTextService');
    const result = await generate({ system, user, temperature: 0.4, maxTokens: 1500 });

    // Strip accidental markdown fences (Claude sometimes wraps despite
    // the instruction).
    const cleaned = result.text
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();

    // Validate as JSON — if the LLM's response isn't parseable, that's
    // a hard failure the operator needs to see.
    let theme;
    try {
      theme = JSON.parse(cleaned);
    } catch (parseErr) {
      throw new Error(`Claude returned invalid JSON: ${parseErr.message}\nRaw response:\n${cleaned.slice(0, 500)}`);
    }
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
      throw new Error('Claude returned non-object JSON — expected a theme object');
    }

    const job = scriptJobs.get(jobId) || {};
    scriptJobs.set(jobId, {
      ...job,
      status:       'done',
      theme,
      model:        result.model,
      usage:        result.usage,
      finishReason: result.finishReason,
      completedAt:  Date.now()
    });
    reapJob(jobId);
    console.log(`🧠 generate-script: job=${jobId} DONE in ${Date.now() - (job.startedAt || Date.now())}ms themeKeys=${Object.keys(theme).length}`);
  } catch (err) {
    console.error(`🧠 generate-script: job=${jobId} FAILED — ${err.message}`);
    const job = scriptJobs.get(jobId) || {};
    scriptJobs.set(jobId, {
      ...job,
      status:      'failed',
      error:       err.message || 'generate failed',
      completedAt: Date.now()
    });
    reapJob(jobId);
  }
}

// ── Script-mode generator ──────────────────────────────────────────
//
// Alternate to the theme-mode generator above. Instead of picking
// colors + fonts (JSON), Claude authors a FULL canvas overlay script
// matching the runtime interface — a per-brand replacement for the
// shipped canonical scripts. Reuses the same scriptJobs map + polling
// route; job.script holds the JS string when done.
//
// Iteration model:
//   - No baseScript in body  → fresh generation from the format's
//                              shipped canonical as few-shot reference.
//   - baseScript in body     → tweak mode. Claude gets the current
//                              script + a change directive and returns
//                              a revised full module.

const CANONICAL_FILE_BY_FORMAT = {
  feed:      'canonical.script.js',
  vertical:  'canonical_dr_v1_vertical.script.js',
  landscape: 'local_scrim_landscape.script.js'
};

// Fed to the script-generation LLM prompt, so these strings are load-bearing:
// feed's aspect used to read '4:5 (also serves 1:1)', which was true only because
// 1:1 was mis-bucketed into feed. Square now has its own composition and canonical.
const DIMS_BY_FORMAT = {
  feed:      { width: 1080, height: 1350, aspect: '4:5' },
  square:    { width: 1080, height: 1080, aspect: '1:1' },
  vertical:  { width: 1080, height: 1920, aspect: '9:16' },
  landscape: { width: 1920, height: 1080, aspect: '16:9' }
};

// Google Fonts registered at server boot (services/fontLoader.js).
// Kept as a string constant so the prompt stays in sync when the
// loader's font list changes.
const REGISTERED_FONTS_LIST =
  'Inter, Playfair Display, Lora, Cormorant, Cormorant Garamond, Antonio, ' +
  'Montserrat, Great Vibes, DM Sans, Bebas Neue, Anton, Oswald, IBM Plex Sans, ' +
  'Poppins, Nunito, Quicksand';

async function runGenerateFullScript(jobId, brand, direction, format, baseScript, history = []) {
  try {
    const fs   = require('fs');
    const path = require('path');
    const canonicalFile = CANONICAL_FILE_BY_FORMAT[format];
    if (!canonicalFile) throw new Error(`unknown format "${format}" — expected feed|vertical|landscape`);
    const canonicalPath   = path.join(__dirname, '..', 'services', 'brandScripts', canonicalFile);
    const canonicalSource = fs.readFileSync(canonicalPath, 'utf8');
    const dims = DIMS_BY_FORMAT[format];

    const system = [
      'You author custom canvas overlay scripts for a video ad rendering pipeline built on @napi-rs/canvas.',
      'Your script runs in a sandboxed child process — no `require`, no `fs`, no `process`, no globals besides what is passed in.',
      '',
      'INTERFACE (must match exactly):',
      '',
      '  module.exports = {',
      '    renderFrame: async (frameIndex, ctx, plate, meta, h) => {',
      '      // Draw base plate then overlays for THIS frame only.',
      '    }',
      '  };',
      '',
      'PARAMETERS:',
      '  frameIndex — integer 0..191 (24fps, 8-second video).',
      '  ctx        — CanvasRenderingContext2D. Full 2D API.',
      '  plate      — @napi-rs/canvas Image (base lifestyle frame at this time).',
      '  meta       — object with text + theme data (shape below).',
      '  h          — helpers: { clamp, t01, eoc, eob, smooth, rgba }.',
      '',
      'META SHAPE (all fields optional — always guard for null/undefined):',
      '  brandName, badgeText, productName, productDescription, price,',
      '  headline, quote, quoteSnippet, reviewer, deliveryLine,',
      '  ctaText / cta,',
      '  rating (float), reviewCount (int), reviewsText, likes (number),',
      '  promoText (nullable — skip pill when null),',
      '  endcardMode ("product" | "brand"),',
      '  brandTagline, brandWebsiteUrl,',
      '  // Multi-value arrays — iterate to render pills / bullets / cascades.',
      '  //   Any empty/missing → skip that section entirely.',
      '  badges: string[]     — trust signals (e.g. "Bestseller", "Free shipping"). Typical usage: pill row with per-item stagger, e.g. cascade in 4 across 0.6s.',
      '  benefits: string[]   — short product benefit phrases (e.g. "Vegan formula", "SPF 30"). Typical usage: bullet stack on the endcard.',
      '  // Local image file paths — call canvas.loadImage(path) to draw.',
      '  //   Cache the returned promise across frames; both are undefined',
      '  //   for brands without imagery, so always null-guard.',
      '  productOnlyImagePath  — the product-only catalog image (product endcard hero),',
      '  brandLogoPath         — the brand logo (brand endcard hero, footer marks),',
      '  theme: {',
      '    textPrimary [R,G,B], textSecondary [R,G,B], textMuted [R,G,B],',
      '    scrimColor [R,G,B], endcardBgColor [R,G,B],',
      '    accentColor [R,G,B], starColor [R,G,B],',
      '    badgeBgColor [R,G,B], badgeTextColor [R,G,B],',
      '    ctaBgColor [R,G,B], ctaTextColor [R,G,B],',
      '    promoBgColor [R,G,B], promoTextColor [R,G,B],',
      '    headingFontFamily, bodyFontFamily, quoteFontFamily, productFontFamily',
      '  }',
      '',
      `CANVAS DIMENSIONS: ${dims.width}×${dims.height} (${dims.aspect}).`,
      '',
      'TIMING: 24fps. t (seconds) = frameIndex / 24. Video length: 8s (192 frames).',
      '',
      'COMPOSITION RULES:',
      '- ALWAYS draw the base plate first: ctx.drawImage(plate, 0, 0, W, H).',
      '- Wrap each draw sequence in ctx.save() / ctx.restore().',
      '- Prefer LOCAL scrims (rounded rectangles behind text blocks) over full-frame gradient washes — the lifestyle plate should breathe through.',
      '- 9:16 (Reels/Shorts/Stories): ~10.6% top + ~10.6% bottom is reserved for IG chrome. Keep text out of those bands.',
      '- 16:9: anchor content to the lower half (letterbox-style overlays work well).',
      '- 4:5 / 1:1: bottom-anchored composition is the shipped convention.',
      `- Available fonts (registered at boot): ${REGISTERED_FONTS_LIST}.`,
      '- Fall back to "Inter" / "PlayfairDisplay" / "Lora" if a font name might be missing.',
      '',
      'ENDCARD (last 2 seconds, t >= 6): dispatch on meta.endcardMode:',
      '- "product": product image dominant + product name + ★★★★★ proof bar + optional promo pill.',
      '- "brand":   brand logo dominant + tagline + website footer.',
      '',
      'IMAGE LOADING: to draw meta.productOnlyImagePath or meta.brandLogoPath, use `canvas.loadImage(path)` — the `canvas` namespace is in closure scope. Cache the promise across frames (see the reference implementation).',
      '',
      'OUTPUT LENGTH BUDGET: Target 200-350 lines total. Skip verbose comment blocks — one short line max per function is enough. Do NOT restate the interface spec in comments. Skip defensive fallbacks for meta fields that already have safe defaults in the sample. Prefer inline expressions over separate helper functions where a helper is only called once. The reference below is intentionally long for coverage; your output should be TIGHTER.',
      '',
      'SUMMARY HEADER: begin your response with exactly one comment line in this shape (≤160 chars, one plain English sentence describing what you changed vs the current script):',
      '  // SUMMARY: <one sentence>',
      'That line is parsed off the response and shown to the operator as your chat reply. The rest of the file is the module.',
      '',
      'OUTPUT: return ONLY the raw JavaScript module beginning with the SUMMARY comment. No markdown fences, no commentary outside the file. The second character onwards should form a valid JavaScript module.'
    ].join('\n');

    // Compact prior chat turns into a CONVERSATION HISTORY block prefixed
    // to the user message. Same shape as the title-spec chat: role +
    // content, capped at the last 10 turns for token budget. Empty when
    // history is [] — the block is filtered out by filter(Boolean) below.
    const historyBlock = (Array.isArray(history) && history.length > 0)
      ? [
          'CONVERSATION HISTORY (oldest first, most recent last):',
          ...history.slice(-10).map((t) => {
            const role = t?.role === 'user' ? 'Operator' : 'You';
            const content = String(t?.content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
            return content ? `- ${role}: ${content}` : null;
          }).filter(Boolean),
        ].join('\n')
      : '';

    const brandContextLines = [
      `Brand name: ${brand.name}`,
      brand.tagline           ? `Tagline: ${brand.tagline}` : null,
      brand.summary           ? `Summary: ${brand.summary}` : null,
      brand.tone?.length      ? `Tone: ${brand.tone.join(', ')}` : null,
      brand.primaryColor      ? `Primary color: ${brand.primaryColor}` : null,
      brand.secondaryColor    ? `Secondary color: ${brand.secondaryColor}` : null,
      brand.accentColor       ? `Accent color: ${brand.accentColor}` : null,
      brand.fontFamily        ? `Preferred font: ${brand.fontFamily}` : null
    ].filter(Boolean).join('\n');

    // Concrete sample meta blob — matches the preview endpoint's meta
    // shape so what Claude designs against is what previewBrandScript
    // renders. If these two drift, previews stop reflecting what the
    // script will see at real ad-render time.
    const sampleMeta = {
      brandName: brand.name || 'Sample Brand',
      badgeText: 'Customer Favorite',
      productName: 'Signature Product',
      productDescription: 'Crafted for daily wear. Made with premium materials that last.',
      price: '$48',
      headline: brand.tagline || 'Made better.',
      quote: 'Highly rated for comfort, durability, and standout style.',
      quoteSnippet: 'Highly rated for comfort.',
      reviewer: 'Verified customer',
      deliveryLine: 'Ships free — arrives in 2-3 days',
      ctaText: 'SHOP NOW',
      cta: 'SHOP NOW',
      rating: 4.6,
      reviewCount: 128,
      reviewsText: '128 reviews',
      likes: 572,
      promoText: 'FREE SHIPPING',
      endcardMode: 'product',
      brandTagline: brand.tagline || 'Made better.',
      brandWebsiteUrl: brand.websiteUrl || 'brand.com',
      // Realistic array values so scripts referencing meta.badges / meta.benefits
      // demonstrate correctly in preview. Runtime arrays are typically 3-4 items;
      // scripts should cap their own item count (Math.min(meta.badges.length, 4)).
      badges: ['Bestseller', 'Free shipping', 'New arrival', 'Editor\'s pick'],
      benefits: ['Premium materials', 'Made to last', 'Fits true to size', 'Machine washable'],
      // Present as sample paths (won't exist on disk in preview — the
      // preview endpoint fills real paths in when it can). Scripts must
      // null-guard before calling canvas.loadImage.
      productOnlyImagePath: null,
      brandLogoPath: null,
      theme: {
        textPrimary: [255, 255, 255],
        textSecondary: [220, 220, 220],
        scrimColor: [0, 0, 0],
        endcardBgColor: [8, 8, 10],
        starColor: [245, 183, 10],
        headingFontFamily: 'Playfair Display',
        bodyFontFamily: 'Inter',
        quoteFontFamily: 'Lora'
      }
    };

    // Two user-prompt shapes: fresh generate (start from shipped
    // canonical as reference) vs tweak (start from operator's current
    // script and apply the directive). Both interleave chat history
    // (optional) so multi-turn requests build on each other.
    let user;
    if (baseScript && String(baseScript).trim()) {
      user = [
        `Modify the ${format} (${dims.aspect}) overlay script below for brand "${brand.name}".`,
        'Apply the operator direction carefully. Preserve the interface, the general structure, and any working composition patterns — change ONLY what the direction requires.',
        '',
        brandContextLines,
        '',
        historyBlock,
        direction
          ? `OPERATOR REQUEST: ${direction}`
          : 'OPERATOR REQUEST: (none — polish typography and composition without shifting the overall design)',
        '',
        '── Sample meta blob that will be passed to renderFrame at runtime:',
        '```json',
        JSON.stringify(sampleMeta, null, 2),
        '```',
        '',
        '── Current script to modify:',
        '```javascript',
        String(baseScript),
        '```',
        '',
        'Output: begin with the SUMMARY comment header, then the FULL revised JS module. Raw JS only — no fences.'
      ].filter(Boolean).join('\n');
    } else {
      user = [
        `Write a ${format} (${dims.aspect}) canvas overlay script tailored to this brand:`,
        '',
        brandContextLines,
        '',
        historyBlock,
        direction
          ? `OPERATOR REQUEST: ${direction}`
          : 'OPERATOR REQUEST: (none — pick a strong editorial composition that fits the brand)',
        '',
        '── Sample meta blob that will be passed to renderFrame at runtime:',
        '```json',
        JSON.stringify(sampleMeta, null, 2),
        '```',
        '',
        '── Reference implementation (the currently shipped canonical for this format). Study its structure and interface conventions, then write a DIFFERENT composition that fits the brand above. Do NOT copy verbatim — vary layout, typography, timing, or endcard treatment based on brand personality.',
        '',
        '```javascript',
        canonicalSource,
        '```',
        '',
        `Now write the ${brand.name} ${format} script. Begin with the SUMMARY comment header, then raw JS.`
      ].filter(Boolean).join('\n');
    }

    // Output budget — sized for compact scripts (200-350 lines, per
    // system prompt). 8192 was truncating on the fatter drafts; 32000
    // was inviting Claude to keep going past the Atlas gateway's ~120s
    // Cloudflare timeout. 12000 hits the sweet spot: enough headroom
    // for tight canonical replacements, not so much that verbosity
    // wanders past the timeout.
    const { generate } = require('../services/atlasTextService');
    const result = await generate({ system, user, temperature: 0.5, maxTokens: 12000 });

    // Truncation guard — if the model stopped because it hit the token
    // budget (not a natural end), the tail of the script is missing and
    // the sandbox will fail to parse. Surface a clear error instead of
    // shipping broken JS to Preview.
    const finish = String(result.finishReason || '').toLowerCase();
    const truncated = finish === 'length' || finish === 'max_tokens';
    if (truncated) {
      throw new Error(
        `Generation was cut off by the token budget (finishReason=${result.finishReason}). ` +
        `Ask Claude for a more compact composition (e.g. add "keep the script under 400 lines" ` +
        `to the direction) and try again.`
      );
    }

    // Strip markdown fences if Claude wrapped despite the instruction.
    let cleaned = result.text
      .replace(/^```(?:javascript|js)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();

    // Extract the SUMMARY header (first line, `// SUMMARY: <text>`)
    // as the chat-panel reply. The comment stays in the script — it's
    // harmless and documents the change for future readers. Falls back
    // to null when the LLM skipped the header; the chat UI shows a
    // generic "Applied your requested changes" in that case.
    let summary = null;
    const summaryMatch = cleaned.match(/^\/\/\s*SUMMARY:\s*(.+?)\s*$/im);
    if (summaryMatch) summary = summaryMatch[1].slice(0, 400);

    // Structural validation. Cheap — catches most malformed responses
    // before the operator hits Preview.
    if (!/module\.exports\s*=/.test(cleaned)) {
      throw new Error(`Generated script is missing "module.exports". First 300 chars:\n${cleaned.slice(0, 300)}`);
    }
    if (!/renderFrame\s*[:=]/.test(cleaned)) {
      throw new Error(`Generated script is missing "renderFrame". First 300 chars:\n${cleaned.slice(0, 300)}`);
    }
    // Balanced-brace sanity check — a truncated tail can still pass the
    // structural regex above if the cutoff happened after `module.exports
    // = { renderFrame: ...`. Compare braces and parens; mismatches mean
    // the script is incomplete even if finishReason wasn't 'length'.
    const braceDelta = (cleaned.match(/\{/g)?.length || 0) - (cleaned.match(/\}/g)?.length || 0);
    const parenDelta = (cleaned.match(/\(/g)?.length || 0) - (cleaned.match(/\)/g)?.length || 0);
    if (braceDelta !== 0 || parenDelta !== 0) {
      throw new Error(
        `Generated script is unbalanced (braces off by ${braceDelta}, parens off by ${parenDelta}). ` +
        `Likely truncated mid-body — try again.`
      );
    }

    const job = scriptJobs.get(jobId) || {};
    scriptJobs.set(jobId, {
      ...job,
      status:       'done',
      script:       cleaned,
      summary,                    // one-sentence chat-panel reply (null if the LLM skipped the header)
      format,
      model:        result.model,
      usage:        result.usage,
      finishReason: result.finishReason,
      completedAt:  Date.now()
    });
    reapJob(jobId);
    console.log(`🧠 generate-script[full]: job=${jobId} DONE in ${Date.now() - (job.startedAt || Date.now())}ms format=${format} chars=${cleaned.length} summary="${(summary || '').slice(0, 60)}"`);
  } catch (err) {
    console.error(`🧠 generate-script[full]: job=${jobId} FAILED — ${err.message}`);
    const job = scriptJobs.get(jobId) || {};
    scriptJobs.set(jobId, {
      ...job,
      status:      'failed',
      error:       err.message || 'generate failed',
      completedAt: Date.now()
    });
    reapJob(jobId);
  }
}

// POST /api/brand/:id/generate-script
// Kicks off a Claude-via-Atlas script generation in the background
// and returns a jobId. Poll GET /generate-script/:jobId for status.
// Body:
//   { mode?: 'theme'|'script',   // default 'theme' for back-compat
//     format?: 'feed'|'vertical'|'landscape', // script mode only, default 'feed'
//     direction?: string,        // optional operator nudge
//     baseScript?: string        // script mode only — tweak instead of fresh
//   }
router.post('/:id/generate-script', express.json(), async (req, res) => {
  console.log(`🧠 generate-script: entry brandId=${req.params.id}`);
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const direction   = String(req.body?.direction || '').trim();
    const rawMode     = String(req.body?.mode || 'theme').toLowerCase();
    const mode        = rawMode === 'script' ? 'script' : 'theme';
    const rawFormat   = String(req.body?.format || '').toLowerCase();
    const format      = ['feed', 'vertical', 'landscape'].includes(rawFormat) ? rawFormat : 'feed';
    const baseScript  = req.body?.baseScript ? String(req.body.baseScript) : null;
    // Optional chat history for multi-turn script authoring. Same shape
    // as the title-spec chat path: sanitized to { role: 'user'|'assistant',
    // content: string }[], capped and role-filtered before the runner
    // sees it.
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const history = rawHistory
      .filter((t) => t && typeof t === 'object' && (t.role === 'user' || t.role === 'assistant'))
      .map((t) => ({ role: t.role, content: String(t.content || '').slice(0, 1000) }))
      .filter((t) => t.content);

    const crypto = require('crypto');
    const jobId = crypto.randomBytes(6).toString('hex');
    console.log(`🧠 generate-script: brand="${brand.name}" mode=${mode}${mode === 'script' ? ` format=${format}${baseScript ? ' (tweak)' : ' (fresh)'} history=${history.length}` : ''} directionChars=${direction.length} job=${jobId}`);

    scriptJobs.set(jobId, {
      status:      'pending',
      startedAt:   Date.now(),
      brand:       String(brand._id),
      mode
    });
    // Fire-and-forget. The runner flips the job to done/failed when
    // Atlas returns; errors are logged and never crash the process.
    if (mode === 'script') {
      runGenerateFullScript(jobId, brand, direction, format, baseScript, history);
    } else {
      runGenerateScript(jobId, brand, direction);
    }

    res.status(202).json({
      ok:    true,
      jobId,
      mode,
      format: mode === 'script' ? format : undefined,
      status: 'pending'
    });
  } catch (err) {
    console.error('generate-script failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'generate-script failed' });
  }
});

// GET /api/brand/:id/generate-script/:jobId — poll target for the
// async generation kicked off by POST. Returns the job state:
//   { status: 'pending' | 'done' | 'failed', script?, error?,
//     model?, usage?, finishReason?, elapsedMs }
// 404 when the job doesn't exist OR was reaped after 5 min.
router.get('/:id/generate-script/:jobId', async (req, res) => {
  try {
    const job = scriptJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job not found or expired' });
    // Cross-brand safety: reject reads for the wrong brand id.
    if (job.brand && String(job.brand) !== String(req.params.id)) {
      return res.status(404).json({ error: 'job not found' });
    }
    res.json({
      status:       job.status,
      mode:         job.mode || 'theme',
      format:       job.format,      // set for mode='script' only
      theme:        job.theme,       // set for mode='theme'
      script:       job.script,      // set for mode='script'
      summary:      job.summary,     // chat-panel reply for mode='script' (parsed from // SUMMARY: header)
      error:        job.error,
      model:        job.model,
      usage:        job.usage,
      finishReason: job.finishReason,
      elapsedMs:    Date.now() - (job.startedAt || Date.now())
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'status lookup failed' });
  }
});

// GET /api/brand/:id/style
// Returns the current per-brand video style state, tracked by format so
// the video card can render a tab per script slot:
//   - overrides        — Brand.styleOverrides (JSON layout, enum-based)
//   - fileStyle        — services/brandStyles/*.js (file-based enum layout)
//   - script           — Brand.styleScript (feed / 4:5,1:1)
//   - scriptVertical   — Brand.styleScriptVertical (vertical / 9:16 Reels/Shorts/Stories)
//   - scriptLandscape  — Brand.styleScriptLandscape (landscape / 16:9 pmax/YouTube)
//   - theme            — Brand.styleTheme (shared palette + fonts for canonicals)
//   - scriptTemplates  — { <name>: <source> } seed scripts from
//                         services/brandScripts/*.script.js so the UI
//                         can offer "Load template" without a second
//                         round-trip.
router.get('/:id/style', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    const { getFileStyle } = require('../services/brandStyles');

    // Read shipped script templates. Cheap; only ~5 files max and the
    // Brand page is not a hot path. Falls through to empty map when
    // the dir doesn't exist (in-progress deployments).
    const fs   = require('fs');
    const path = require('path');
    const scriptsDir = path.join(__dirname, '..', 'services', 'brandScripts');
    const scriptTemplates = {};
    try {
      for (const name of fs.readdirSync(scriptsDir)) {
        if (!name.endsWith('.script.js')) continue;
        const key = name.replace(/\.script\.js$/, '');
        scriptTemplates[key] = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
      }
    } catch { /* dir missing — no templates */ }

    // Preview plate — brand's own lifestyle image (or on_model, or
    // any image) so the phone-chrome mockup on the frontend can render
    // a representative background even before the operator clicks
    // Preview. Same picker the /preview-script route uses for the
    // actual render, so the visible plate matches the render plate.
    const previewPickPromise = pickBrandPreviewMediaUrl(brand._id).catch(() => null);
    const previewPick = await previewPickPromise;
    const { resolveTitlePlacementMode } = require('../services/plateIntelService');

    res.json({
      overrides:        brand.styleOverrides || null,
      fileStyle:        getFileStyle(brand),
      script:           brand.styleScript || null,
      scriptVertical:   brand.styleScriptVertical || null,
      scriptLandscape:  brand.styleScriptLandscape || null,
      theme:            brand.styleTheme || null,
      scriptTemplates,
      previewPlate:     previewPick ? { url: previewPick.url, source: `brand-media (${previewPick.shotType})` } : null,
      // Remotion titling engine state (full detail via GET /:id/title-spec)
      titleStyleSpec:   brand.titleStyleSpec || null,
      titleStylePreset: brand.titleStylePreset || null,
      customFonts:      brand.customFonts || [],
      // keep in sync with resolveTitlingEngine default
      titlingEngine:    brand.videoSettings?.titlingEngine || process.env.TITLING_ENGINE || 'remotion',
      titlePlacementMode: resolveTitlePlacementMode({ brand }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'style lookup failed' });
  }
});

// POST /api/brand/:id/refresh-enrichment
// Manually re-trigger enrichment for an existing brand. Resets
// enrichmentSources so every tier re-attempts (useful when a new
// API key was added, or when the user wants the latest brand-kit
// data after a brand refresh on Brandfetch's side). Curated fields
// remain protected.
router.post('/:id/refresh-enrichment', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    if (!brand.websiteUrl) {
      return res.status(400).json({ error: 'brand has no websiteUrl — set one via PATCH first' });
    }
    brand.enrichmentSources = [];
    if (!(brand.curatedFields || []).includes('logoUrl')) {
      brand.logoIngestedAt = null;
      brand.logoIngestError = null;
    }
    // Auto-unlock any field that's currently empty. A curated lock on an
    // empty value defeats the user's intent — they cleared it because
    // they want enrichment to fill it. Non-empty curated fields stay
    // protected.
    const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
    const unlocked = [];
    brand.curatedFields = (brand.curatedFields || []).filter(k => {
      if (isEmpty(brand[k])) { unlocked.push(k); return false; }
      return true;
    });
    if (unlocked.includes('fontFamily')) brand.fontSource = null;
    if (unlocked.includes('logoUrl')) {
      brand.logoSource = null;
      brand.logoOriginalUrl = null;
      brand.logoIngestedAt = null;
      brand.logoIngestError = null;
    }
    if (unlocked.length) {
      console.log(`   · refresh: unlocked empty curated fields for "${brand.name}": ${unlocked.join(', ')}`);
    }
    await brand.save();
    triggerEnrichment(brand, 'manual refresh');
    res.json({ ok: true, queued: true, unlocked });
  } catch (err) {
    res.status(500).json({ error: err.message || 'refresh failed' });
  }
});

// PATCH /api/brand/:id/voice
// Body: { voice: { ...overrides } }
// → { ok, voice }
//
// Operator override of the derived voice profile. Replaces Brand.derivedVoice
// with the provided object and stamps a fresh derivedVoiceAt so the
// auto-refresh sweep treats it as recent. Use null to clear and re-derive.
router.patch('/:id/voice', express.json(), async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).select('_id derivedVoice');
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const incoming = req.body?.voice;
    if (incoming !== null && (typeof incoming !== 'object' || Array.isArray(incoming))) {
      return res.status(400).json({ error: 'voice must be an object or null' });
    }
    brand.derivedVoice   = incoming;
    brand.derivedVoiceAt = incoming === null ? null : new Date();
    await brand.save();
    res.json({ ok: true, voice: brand.derivedVoice, derivedVoiceAt: brand.derivedVoiceAt });
  } catch (err) {
    console.error(`❌ PATCH /api/brand/:id/voice: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/brand/:id/derive-voice?force=true
// → { ok, voice, evidenceCount, elapsedMs } | { skipped, reason }
//
// Runs brandVoiceDerivationService against the brand's existing Meta /
// Google ad campaigns. Returns the structured voice profile and stamps
// Brand.derivedVoice + Brand.derivedVoiceAt. Respects 7-day TTL by
// default; pass force=true to re-derive immediately.
router.post('/:id/derive-voice', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).select('_id').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const force = String(req.query.force || '').toLowerCase() === 'true';
    const { deriveBrandVoice } = require('../services/brandVoiceDerivationService');
    const result = await deriveBrandVoice(brand._id, { force });
    res.json(result);
  } catch (err) {
    console.error(`❌ POST /api/brand/:id/derive-voice: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/brand/:id — full cascade. Body must include
// { confirmName: <exact brand name> } as a type-to-confirm safety
// gate against accidental deletion.
router.delete('/:id', express.json(), async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const confirmName = (req.body?.confirmName || '').trim();
    if (confirmName !== brand.name) {
      return res.status(400).json({
        error: 'confirmName must match the brand name exactly to delete',
        expected: brand.name
      });
    }

    const { cascadeDeleteBrand } = require('../services/cascadeDeleteService');
    const result = await cascadeDeleteBrand(brand._id);
    if (!result.ok) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    console.error('brand delete failed:', err);
    res.status(500).json({ error: err.message || 'brand delete failed' });
  }
});

// ── Upload-6: per-brand auto-create toggle ──────────────────────────
// uploadSettings.autoCreateFromDetect controls whether confident
// detect matches auto-write draft CatalogProduct rows (Upload-4).
// Off by default — drafts pile up if the user isn't actively
// completing them in the catalog browser drafts tab (Upload-5).
router.get('/:id/upload-settings', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id }))
      .select('uploadSettings').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    res.json({
      uploadSettings: brand.uploadSettings || { autoCreateFromDetect: false }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'upload-settings fetch failed' });
  }
});

router.patch('/:id/upload-settings', express.json(), async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const body = req.body || {};
    const settings = brand.uploadSettings || {};
    if (typeof body.autoCreateFromDetect === 'boolean') {
      settings.autoCreateFromDetect = body.autoCreateFromDetect;
    }
    brand.uploadSettings = settings;
    brand.markModified('uploadSettings');
    await brand.save();

    res.json({ uploadSettings: brand.uploadSettings });
  } catch (err) {
    console.error('upload-settings update failed:', err);
    res.status(500).json({ error: err.message || 'upload-settings update failed' });
  }
});

// ── Phase 4 follow-up #6 — Persona avatar generation ───────────────
// Generates a portrait illustration for brand.demographics[index] via
// gpt-image-1, uploads it to Cloudinary, and patches avatarUrl onto
// the persona row. Returns the updated persona so the frontend can
// drop in the new tile without a second round-trip.
router.post('/:id/personas/:index/avatar', express.json(), async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const idx = Number(req.params.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (brand.demographics?.length || 0)) {
      return res.status(400).json({ error: 'persona index out of range' });
    }
    const persona = brand.demographics[idx];
    if (!persona?.name && !persona?.description) {
      return res.status(400).json({ error: 'persona must have at least a name or description' });
    }

    const { generateAvatarForPersona } = require('../services/personaAvatarService');
    const result = await generateAvatarForPersona(persona, {
      category: brand.brandSafety?.category || null
    });

    brand.demographics[idx].avatarUrl = result.url;
    brand.markModified('demographics');
    await brand.save();

    res.json({
      index:   idx,
      persona: brand.demographics[idx],
      avatarUrl: result.url
    });
  } catch (err) {
    console.error('persona avatar generation failed:', err);
    res.status(500).json({ error: err.message || 'avatar generation failed' });
  }
});

function serializeBrand(b) {
  return {
    // Both id and _id are returned for frontend compat — GET /api/brand/:id
    // uses .lean() and returns the doc with _id; this serialized response
    // gets used after PATCH and the brand page does fetches keyed on
    // either form.
    id:           String(b._id),
    _id:          String(b._id),
    name:         b.name,
    slug:         b.nameNormalized,
    tagline:      b.tagline || null,
    summary:      b.summary || null,
    logoUrl:      b.logoUrl || null,
    logoSource:   b.logoSource || null,
    logoOriginalUrl: b.logoOriginalUrl || null,
    logoIngestedAt: b.logoIngestedAt || null,
    logoIngestError: b.logoIngestError || null,
    websiteUrl:   b.websiteUrl || null,
    primaryColor: b.primaryColor || null,
    secondaryColor: b.secondaryColor || null,
    accentColor:  b.accentColor || null,
    fontColor:    b.fontColor || null,
    websiteBackground: b.websiteBackground || null,
    fontFamily:   b.fontFamily || null,
    fontSource:   b.fontSource || null,
    staticImagePipeline: resolveStaticPipeline(b.staticImagePipeline),
    tone:         b.tone || [],
    hashtags:     b.hashtags || [],
    tags:         b.tags || [],
    source:       b.source,
    enrichmentSources: b.enrichmentSources || [],
    curatedFields:     b.curatedFields || [],
    tailwindTheme:     b.tailwindTheme || null,
    websiteFontUsage:  b.websiteFontUsage || null,
    fontIngestedAt:    b.fontIngestedAt || null,
    fontIngestError:   b.fontIngestError || null,
    // Per-brand video-generation overrides — included so the PATCH
    // response confirms a videoSettings save (GET already returns the
    // raw lean doc, which carries it).
    videoSettings: b.videoSettings || null
  };
}

// GET /api/brand/:id/onboarding-status
// Aggregates per-pipeline progress for the post-onboarding status
// panel: enrichment, catalog sync, product-path detect, IG sync,
// media-path detect, campaign sync. All counts are scoped to the
// brand. Cheap — six small queries, no fan-out. The frontend polls
// this until everything's terminal.
router.get('/:id/onboarding-status', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    // Enrichment derives from Brand fields populating in waves.
    const enrichment = {
      stage: brand.enrichmentStage || (brand.tone ? 'done' : 'pending'),
      hasLogo:        !!brand.logoUrl,
      hasColors:      !!(brand.primaryColor || brand.accentColor),
      hasTone:        !!(brand.tone && brand.tone.length > 0),
      hasPersonas:    !!(brand.demographics && brand.demographics.length > 0),
      hasSummary:     !!brand.summary,
      hasReviews:     !!(brand.brandReviews?.summary || (brand.brandReviews?.quotes || []).length > 0)
    };

    // Catalog sync state — connection + product count.
    const catalogCred = await IntegrationCredential.findOne({
      brandId: brand._id, type: 'instagram', status: 'active'
    }).select('catalogId lastCatalogSyncAt').lean();
    // Raw row count — each SKU (size / color / pack-size variant) is
    // ad-targetable and counts as its own product. Matches what the
    // catalog browser shows now that the variant-collapse default was
    // removed (routes/catalog.js).
    const productCount = await CatalogProduct.countDocuments({ brandId: brand._id });

    // Detect-run rollups, split by source so the panel can show
    // catalog-product runs distinctly from media-path runs.
    const productMediaIds = await Media.find({ brandId: brand._id, source: 'catalog-product' })
      .select('_id').lean();
    const productMediaIdSet = productMediaIds.map(m => m._id);
    const [productRuns, mediaRuns] = await Promise.all([
      bucketRunsByStatus(productMediaIdSet, true),
      bucketRunsByStatus(productMediaIdSet, false, brand._id)
    ]);

    // IG posts state — credential + post count.
    const postCount = await Media.countDocuments({ brandId: brand._id, source: 'instagram' });

    // Campaigns sync state — count by platform.
    const [metaCampaigns, googleCampaigns, reachCampaigns] = await Promise.all([
      Campaign.countDocuments({ brandId: brand._id, platform: 'meta-ads' }),
      Campaign.countDocuments({ brandId: brand._id, platform: 'google-ads' }),
      Campaign.countDocuments({ brandId: brand._id, platform: 'reach-social' })
    ]);

    // Live activity — what the system is "doing right now" for this
    // brand. Drives the floating ActivityBar at the top of the app
    // shell. Resolution order:
    //   1. Most-recent DetectRun in 'processing' (real-time stage info)
    //   2. Brand enrichment in flight (no tone yet AND created recently)
    //   3. Catalog/post/campaign sync running (no persistent signal —
    //      handwave via the queue tail when nothing else is in flight)
    const liveActivity = await deriveLiveActivity(brand, productMediaIdSet, productRuns, mediaRuns);

    res.json({
      enrichment,
      catalog: {
        connected:        !!catalogCred?.catalogId,
        lastSyncedAt:     catalogCred?.lastCatalogSyncAt || null,
        productCount
      },
      productDetect: productRuns,
      social: {
        connected:        !!catalogCred,
        postCount
      },
      mediaDetect: mediaRuns,
      campaigns: {
        meta:         metaCampaigns,
        google:       googleCampaigns,
        reachSocial:  reachCampaigns,
        total:        metaCampaigns + googleCampaigns + reachCampaigns
      },
      liveActivity
    });
  } catch (err) {
    console.error('onboarding-status failed:', err);
    res.status(500).json({ error: err.message || 'onboarding-status failed' });
  }
});

// Brand-wide brand_match listings for the wizard's Step 2 picker.
// brand_match PMAs are not tied to a specific catalog product — they
// represent posts that registered as brand-fit without identifying a
// SKU. The picker shows them as a separate "Brand-only posts" section
// alongside the per-product/per-media match ribbons so operators can
// individually exclude any of them from the cartesian.
//
// Returns one row per Media (latest brand_match PMA wins on dupes),
// sorted by readiness signals — engagement first, then ad-suitability.
// Capped to a generous default; the picker is meant for browsing not
// pagination.
router.get('/:id/brand-matches', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).select('_id').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const artifacts = await ProductMatchArtifact.find({
      brandId: brand._id,
      outcome: 'brand_match'
    })
      .sort({ createdAt: -1 })
      .select('mediaId outcome outcomeReasoning winner matchSource identification createdAt')
      .limit(500)
      .lean();

    // Latest-per-media dedupe — a media that appears in multiple runs
    // shows once with the most recent evidence.
    const seen = new Set();
    const ordered = [];
    for (const a of artifacts) {
      const key = String(a.mediaId);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(a);
    }
    if (!ordered.length) return res.json({ matches: [] });

    const mediaIds = ordered.map(a => a.mediaId);
    const medias = await Media.find({ _id: { $in: mediaIds }, brandId: brand._id })
      .select('externalId fileType fileUrl source metadata classification platformStats adSuitability createdAt')
      .lean();
    const mediaById = new Map(medias.map(m => [String(m._id), m]));

    // Mirror the seed expansion's content-nature gate so the picker
    // doesn't surface promotional / announcement posts that the
    // cartesian would silently drop.
    const { isMediaEligibleByContentNature } = require('../services/campaignAdsGenerationService');

    const matches = ordered
      .map(a => {
        const m = mediaById.get(String(a.mediaId));
        if (!m) return null;
        if (!isMediaEligibleByContentNature(m)) return null;
        return {
          mediaId:   String(a.mediaId),
          matchTier: 'brand_match',
          outcome:   a.outcome || null,
          outcomeReasoning: a.outcomeReasoning || null,
          winner:    a.winner       || null,
          matchSource: a.matchSource || null,
          confidence: a.identification?.certainty ?? null,
          media: {
            externalId:    m.externalId,
            fileType:      m.fileType,
            fileUrl:       m.fileUrl,
            source:        m.source,
            permalink:     m.metadata?.permalink     || null,
            creatorHandle: m.metadata?.creatorHandle || null,
            postedAt:      m.metadata?.postedAt      || null,
            likes:         m.platformStats?.likes      ?? null,
            comments:      m.platformStats?.comments   ?? null,
            saves:         m.platformStats?.saves      ?? null,
            engagement:    m.platformStats?.engagement ?? null,
            postType:      m.metadata?.postType        || null,
            shotType:      m.classification?.shotType      || null,
            contentNature: m.classification?.contentNature || null,
            adReadiness:   m.adSuitability?.score    ?? null,
            adSuitability: m.adSuitability?.score    ?? null,   // legacy field name retained for callers
            createdAt:     m.createdAt
          }
        };
      })
      .filter(Boolean)
      .slice(0, limit);

    res.json({ matches });
  } catch (err) {
    console.error('brand-matches lookup failed:', err);
    res.status(500).json({ error: err.message || 'brand-matches lookup failed' });
  }
});

// Lifestyle-eligible media IDs for the brand. Returns the Set of
// Media IDs whose classification.shotType is in {lifestyle, on_model,
// unknown} OR is unset/null — the wider "brand-campaign-appropriate
// imagery" net the Generate Ads wizard applies under campaign
// kind='brand' to keep product_only / packaging / detail studio
// shots out of the picker. Hero / studio shots stay clear of
// brand-led ads; lifestyle + on_model + unclassified slip through.
//
// Returns the IDs only (not Media docs) so the picker can build a
// fast Set and apply membership-style filtering across the unified
// ribbon + recommended tiles in a single pass.
router.get('/:id/lifestyle-eligible-media-ids', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).select('_id').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    const Media = require('../models/Media');
    const allowed = ['lifestyle', 'on_model', 'unknown'];
    const rows = await Media.find({
      brandId: brand._id,
      $or: [
        { 'classification.shotType': { $in: allowed } },
        { 'classification.shotType': { $exists: false } },
        { 'classification.shotType': null }
      ]
    }).select('_id').limit(10000).lean();
    res.json({ mediaIds: rows.map(r => String(r._id)) });
  } catch (err) {
    console.error('lifestyle-eligible-media-ids failed:', err);
    res.status(500).json({ error: err.message || 'lookup failed' });
  }
});

// Ad-readiness gate — same signals as the onboarding panel, condensed
// into a yes/no the wizard can disable buttons on. Strictest bar:
// every connected source has ≥1 completed DetectRun AND zero in-flight
// runs. Returns 200 with { ready, reason, blockers[] } even when not
// ready — the frontend renders the blockers as a tooltip / banner.
router.get('/:id/ad-readiness', async (req, res) => {
  try {
    const brand = await Brand.findOne(tenantFilter(req, { _id: req.params.id })).select('_id').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });
    const { getAdReadiness } = require('../services/adReadinessService');
    const readiness = await getAdReadiness(brand._id);
    res.json(readiness);
  } catch (err) {
    console.error('ad-readiness failed:', err);
    res.status(500).json({ error: err.message || 'ad-readiness failed' });
  }
});

// Friendly stage names for the ActivityBar. DetectRun.stage is the
// pipeline phase (set via setRunPhase in pipelines/detect.js); we
// flatten + humanize so the bar reads naturally rather than leaking
// implementation labels.
const STAGE_LABELS = {
  'queued':         'Queued',
  'image-meta':     'Reading image',
  'detect-fanout':  'Detecting products',
  'crop-judge':     'AI cropping',
  'enrich-fanout':  'AI matching media to products',
  'finalize':       'Finalizing'
};

async function deriveLiveActivity(brand, productMediaIdSet, productRuns, mediaRuns) {
  // 1. Active DetectRun? Look for the most-recent processing run scoped
  //    to this brand. Catalog-product runs are joined by mediaId set;
  //    for everything else we filter by brandId directly.
  const activeRun = await DetectRun.findOne({
    status: 'processing',
    $or: [
      { mediaId: { $in: productMediaIdSet } },
      { brandId: brand._id, mediaId: { $nin: productMediaIdSet } }
    ]
  }).sort({ startedAt: -1 }).select('stage mediaId').lean();

  if (activeRun) {
    const isProductPath = productMediaIdSet.some(id => String(id) === String(activeRun.mediaId));
    const stageLabel    = STAGE_LABELS[activeRun.stage] || 'Processing';
    return {
      active: true,
      stage:  stageLabel,
      sub:    isProductPath ? 'Catalog product' : 'Customer post'
    };
  }

  // 2. Brand enrichment in flight — no tone yet, and the brand was
  //    created in the last 10 minutes (older brands without tone are
  //    enrichment failures, not in-flight runs).
  const enrichmentRecent = brand.firstSeenAt && (Date.now() - new Date(brand.firstSeenAt).getTime() < 10 * 60 * 1000);
  if (enrichmentRecent && (!brand.tone || brand.tone.length === 0)) {
    return { active: true, stage: 'Deriving brand details', sub: brand.name };
  }

  // 3. Anything queued (about to start) — surface so the bar isn't
  //    immediately blank between dispatches.
  if (productRuns.queued > 0) {
    return { active: true, stage: 'Queued: catalog product detect', sub: `${productRuns.queued} pending` };
  }
  if (mediaRuns.queued > 0) {
    return { active: true, stage: 'Queued: post detect', sub: `${mediaRuns.queued} pending` };
  }

  return { active: false, stage: null, sub: null };
}

// Helper — group DetectRuns by status for either catalog-product
// media (when productPath=true) or everything else under the brand.
async function bucketRunsByStatus(productMediaIdSet, productPath, brandId) {
  const filter = productPath
    ? { mediaId: { $in: productMediaIdSet } }
    : { brandId, mediaId: { $nin: productMediaIdSet } };
  const rows = await DetectRun.aggregate([
    { $match: filter },
    { $group: { _id: '$status', n: { $sum: 1 } } }
  ]);
  const out = { queued: 0, processing: 0, completed: 0, failed: 0 };
  for (const r of rows) if (out[r._id] !== undefined) out[r._id] = r.n;
  return out;
}

module.exports = router;
