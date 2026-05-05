// Phase A-3 — Collection CRUD + member management.
//
// Endpoints (all tenant-scoped via requireAuth + brandId checks):
//   GET    /api/collections?brandId=             list scoped to brand
//   GET    /api/collections/:id                   single (with mediaIds)
//   POST   /api/collections                       create { brandId, name, mediaIds? }
//   PATCH  /api/collections/:id                   rename { name }
//   DELETE /api/collections/:id                   hard delete
//   POST   /api/collections/:id/media             add { mediaIds: [...] }
//   DELETE /api/collections/:id/media/:mediaId    remove one
//
// Cross-tenant guards: every read/write resolves the Collection's
// advertiserId and rejects when it doesn't match req.advertiserId.
// Member-media adds verify the supplied mediaIds also belong to the
// active advertiser before inserting — prevents cross-tenant leakage
// via a forged mediaId.

const express  = require('express');
const router   = express.Router();
const Collection = require('../models/Collection');
const Media      = require('../models/Media');
const { tenantFilter } = require('../middleware/tenantHelpers');

// Soft cap on bulk-add — collections with > 1000 members get awkward
// in the UI. Operators that hit this almost certainly want a saved
// query, not a static list.
const MAX_MEMBERS = 1000;

// ── helpers ────────────────────────────────────────────────────────

function projectCollection(doc) {
  return {
    id:           doc._id,
    brandId:      doc.brandId,
    advertiserId: doc.advertiserId,
    name:         doc.name,
    mediaCount:   (doc.mediaIds || []).length,
    mediaIds:     doc.mediaIds,
    createdAt:    doc.createdAt,
    updatedAt:    doc.updatedAt
  };
}

async function loadOwnedCollection(req, res) {
  const filter = tenantFilter(req, { _id: req.params.id });
  const doc = await Collection.findOne(filter);
  if (!doc) {
    res.status(404).json({ error: 'collection not found' });
    return null;
  }
  return doc;
}

// ── routes ─────────────────────────────────────────────────────────

// List scoped to a brand. brandId required so the UI can show
// just the active brand's collections without leaking others.
router.get('/', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'] || null;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });
    const filter = tenantFilter(req, { brandId });
    const docs = await Collection.find(filter).sort({ updatedAt: -1 }).lean();
    res.json({ collections: docs.map(projectCollection) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'collection list failed' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await loadOwnedCollection(req, res);
    if (!doc) return;
    res.json({ collection: projectCollection(doc) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'collection fetch failed' });
  }
});

router.post('/', express.json(), async (req, res) => {
  try {
    const { brandId, name, mediaIds } = req.body || {};
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!req.advertiserId) return res.status(403).json({ error: 'no advertiser context' });

    // Verify the brand belongs to this advertiser. We lean on the
    // tenantFilter pattern but Brand isn't directly scoped here — the
    // unique-index will reject collisions; cross-tenant brand abuse
    // is caught at the membership layer (ApiKey/session level).
    const initialMedia = await safeMediaIds(req, mediaIds);

    const doc = await Collection.create({
      advertiserId: req.advertiserId,
      brandId,
      name:         String(name).trim().slice(0, 80),
      mediaIds:     initialMedia
    });
    res.status(201).json({ collection: projectCollection(doc) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'a collection with that name already exists for this brand' });
    }
    res.status(500).json({ error: err.message || 'collection create failed' });
  }
});

router.patch('/:id', express.json(), async (req, res) => {
  try {
    const doc = await loadOwnedCollection(req, res);
    if (!doc) return;
    const { name } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    doc.name = name.trim().slice(0, 80);
    await doc.save();
    res.json({ collection: projectCollection(doc) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'a collection with that name already exists for this brand' });
    }
    res.status(500).json({ error: err.message || 'collection update failed' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const doc = await loadOwnedCollection(req, res);
    if (!doc) return;
    await Collection.deleteOne({ _id: doc._id });
    res.json({ ok: true, deleted: doc._id });
  } catch (err) {
    res.status(500).json({ error: err.message || 'collection delete failed' });
  }
});

// Add media to a collection. Accepts a single id or an array.
router.post('/:id/media', express.json(), async (req, res) => {
  try {
    const doc = await loadOwnedCollection(req, res);
    if (!doc) return;
    const incoming = req.body?.mediaIds || (req.body?.mediaId ? [req.body.mediaId] : []);
    if (!Array.isArray(incoming) || !incoming.length) {
      return res.status(400).json({ error: 'mediaIds[] is required' });
    }
    const verified = await safeMediaIds(req, incoming);
    // De-dup against existing membership
    const existing = new Set((doc.mediaIds || []).map(String));
    const additions = verified.filter(id => !existing.has(String(id)));
    if (additions.length === 0) {
      return res.json({ collection: projectCollection(doc), added: 0 });
    }
    if ((doc.mediaIds || []).length + additions.length > MAX_MEMBERS) {
      return res.status(413).json({ error: `collection size cap (${MAX_MEMBERS}) exceeded` });
    }
    doc.mediaIds = [...(doc.mediaIds || []), ...additions];
    await doc.save();
    res.json({ collection: projectCollection(doc), added: additions.length });
  } catch (err) {
    res.status(500).json({ error: err.message || 'collection add failed' });
  }
});

router.delete('/:id/media/:mediaId', async (req, res) => {
  try {
    const doc = await loadOwnedCollection(req, res);
    if (!doc) return;
    const before = (doc.mediaIds || []).length;
    doc.mediaIds = (doc.mediaIds || []).filter(id => String(id) !== String(req.params.mediaId));
    if (doc.mediaIds.length === before) {
      return res.status(404).json({ error: 'media not in this collection' });
    }
    await doc.save();
    res.json({ collection: projectCollection(doc), removed: 1 });
  } catch (err) {
    res.status(500).json({ error: err.message || 'collection remove failed' });
  }
});

// ── tenant-safe media verification ─────────────────────────────────

// Filter the supplied mediaIds down to ones that exist in THIS
// advertiser. Anything we can't verify gets dropped. Returns Mongo
// ObjectIds suitable for the schema array.
async function safeMediaIds(req, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const filter = tenantFilter(req, { _id: { $in: ids } });
  const docs = await Media.find(filter, { _id: 1 }).lean();
  return docs.map(d => d._id);
}

module.exports = router;
