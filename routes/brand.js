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
    res.json({
      brands: brands.map(b => ({
        id:           String(b._id),
        name:         b.name,
        slug:         b.nameNormalized,
        logoUrl:      b.logoUrl || null,
        websiteUrl:   b.websiteUrl || null,
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
                      'fontFamily', 'tone', 'hashtags', 'tags', 'demographics',
                      'brandSafety'];
    const fontTouched = Object.prototype.hasOwnProperty.call(req.body || {}, 'fontFamily');
    const fontCleared = fontTouched && (req.body.fontFamily == null || req.body.fontFamily === '');
    const before = { websiteUrl: brand.websiteUrl };
    const curatedSet = new Set(brand.curatedFields || []);

    for (const k of editable) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) {
        const v = req.body[k];
        const isEmpty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
        brand[k] = isEmpty ? (Array.isArray(v) ? [] : null) : v;
        // Clearing a field is a request to RE-enrich it, not lock the
        // empty value as curated. Setting a value is curation.
        if (isEmpty) curatedSet.delete(k);
        else         curatedSet.add(k);
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
    await brand.save();

    // Re-enrich when the websiteUrl actually changed (new domain →
    // Brandfetch may now hit; existing one → no value).
    if (before.websiteUrl !== brand.websiteUrl) {
      // Reset enrichmentSources so all tiers re-attempt against the new URL.
      brand.enrichmentSources = [];
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
    websiteUrl:   b.websiteUrl || null,
    primaryColor: b.primaryColor || null,
    secondaryColor: b.secondaryColor || null,
    accentColor:  b.accentColor || null,
    fontColor:    b.fontColor || null,
    fontFamily:   b.fontFamily || null,
    fontSource:   b.fontSource || null,
    tone:         b.tone || [],
    hashtags:     b.hashtags || [],
    tags:         b.tags || [],
    source:       b.source,
    enrichmentSources: b.enrichmentSources || [],
    curatedFields:     b.curatedFields || []
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
