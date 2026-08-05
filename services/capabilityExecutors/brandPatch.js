// Executor for capability brand.patch (Tier 1, brand scope).
//
// Partial update for editable brand fields. Curated-aware — any field
// set explicitly here is added to Brand.curatedFields so future auto-
// enrichment leaves it alone. Only exposes safe/simple fields via the
// agent — colour, tagline, summary, websiteUrl, fontFamily, tone. The
// route accepts more (styleScript, videoSettings, etc.) but those need
// their own validated capabilities before the agent should touch them.
//
// Voice edits go through brand.voice.patch (dedicated endpoint).
// Upload settings go through brand.uploadSettings.patch.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');

const ALLOWED_FIELDS = new Set([
  'name', 'websiteUrl', 'tagline', 'summary', 'logoUrl',
  'primaryColor', 'secondaryColor', 'accentColor', 'fontColor',
  'websiteBackground', 'fontFamily', 'tone', 'hashtags', 'tags'
]);

const MAX_STR_LEN = 500;   // summary can run a few sentences
const MAX_ARRAY_ITEMS = 20;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const updates = args?.updates;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { ok: false, error: 'updates required (object of allowed keys)' };
  }
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: false, error: 'updates must contain at least one field' };

  // Reject unknown keys — the agent shouldn't be able to sneak in a
  // videoSettings mutation via this generic patch.
  for (const key of keys) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, error: `unknown field "${key}" — allowed: ${[...ALLOWED_FIELDS].join(', ')}` };
    }
    const v = updates[key];
    if (v === null) continue;   // clear is fine
    if (['hashtags', 'tags'].includes(key)) {
      if (!Array.isArray(v)) {
        return { ok: false, error: `${key} must be an array of strings or null` };
      }
      if (v.length > MAX_ARRAY_ITEMS) {
        return { ok: false, error: `${key} too many items (${v.length} > ${MAX_ARRAY_ITEMS})` };
      }
      for (const item of v) {
        if (typeof item !== 'string') {
          return { ok: false, error: `${key} items must be strings` };
        }
      }
    } else {
      if (typeof v !== 'string') {
        return { ok: false, error: `${key} must be a string or null` };
      }
      if (v.length > MAX_STR_LEN) {
        return { ok: false, error: `${key} too long (${v.length} > ${MAX_STR_LEN} chars)` };
      }
    }
  }

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId });
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const changed = {};
  const prior = {};
  const curatedFields = new Set(brand.curatedFields || []);
  const priorWebsite = brand.websiteUrl || null;

  for (const key of keys) {
    const v = updates[key] === null ? null
            : typeof updates[key] === 'string' ? updates[key].trim()
            : updates[key];
    if (JSON.stringify(brand[key] ?? null) === JSON.stringify(v ?? null)) continue;
    prior[key] = brand[key] ?? null;
    changed[key] = v;
    brand[key] = v;
    if (v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      curatedFields.add(key);
    } else {
      curatedFields.delete(key);
    }
  }

  if (Object.keys(changed).length === 0) {
    return {
      ok: true,
      kind: 'brandUpdate',
      data: { _id: String(brand._id), name: brand.name, noop: true, note: 'no changes to apply' }
    };
  }

  brand.curatedFields = [...curatedFields];
  await brand.save();

  // If websiteUrl changed to a non-empty value, retrigger enrichment.
  let enrichmentQueued = false;
  if (changed.websiteUrl && changed.websiteUrl !== priorWebsite) {
    try {
      const { enrichBrandFromUrl } = require('../brandEnrichmentService');
      enrichBrandFromUrl(brand._id).catch((err) =>
        console.warn(`brand.patch: enrichment fire-and-forget failed for "${brand.name}": ${err.message}`)
      );
      enrichmentQueued = true;
    } catch (_) { /* non-fatal */ }
  }

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id: String(brand._id),
      name: brand.name,
      changed,
      prior,
      enrichmentQueued,
      cacheNote: 'LayoutInputArtifact rows may still carry the OLD field values until they re-derive. Regenerate affected ads to see the new fields reflected.'
    }
  };
}

module.exports = { run };
