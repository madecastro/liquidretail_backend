const express = require('express');
const router = express.Router();
const Brand = require('../models/Brand');
const { normalizeBrandName } = require('../models/Brand');
const { tenantFilter } = require('../middleware/tenantHelpers');

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
                      'fontFamily', 'tone', 'hashtags', 'tags'];
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

module.exports = router;
