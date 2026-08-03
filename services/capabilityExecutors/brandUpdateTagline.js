// Executor for capability brand.updateTagline (Tier 1, brand scope).
//
// Sets Brand.tagline. Cross-tenant guarded: the brand must belong to
// req.advertiserId. Returns the previous value so the operator can
// paste it back if they change their mind.
//
// Downstream cache invalidation: brand tagline flows into
// LayoutInputArtifact.input.brand.tagline at derive time. Existing
// cached LayoutInputArtifact rows still carry the OLD tagline until
// they naturally re-derive (schema-version bump or refresh:true).
// This executor does NOT invalidate the cache — a change-log entry
// mentions it so the operator can decide whether to force a regen.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');

const MAX_TAGLINE_LEN = 200;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const tagline = String(args?.tagline || '').trim();
  if (!tagline) return { ok: false, error: 'tagline required (non-empty)' };
  if (tagline.length > MAX_TAGLINE_LEN) {
    return { ok: false, error: `tagline too long (${tagline.length} > ${MAX_TAGLINE_LEN} chars)` };
  }

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name tagline').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const priorTagline = brand.tagline || null;
  if (priorTagline === tagline) {
    return {
      ok: true,
      kind: 'brandUpdate',
      data: {
        _id: String(brand._id),
        name: brand.name,
        tagline,
        priorTagline,
        noop: true,
        note: 'tagline unchanged'
      }
    };
  }

  await Brand.updateOne({ _id: brand._id }, { $set: { tagline, updatedAt: new Date() } });

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id: String(brand._id),
      name: brand.name,
      tagline,
      priorTagline,
      // Callout so the LLM can inform the operator about the cache
      // decoupling from ads currently in flight or already rendered.
      cacheNote: 'Existing LayoutInputArtifact rows still carry the old tagline until they re-derive. Regenerate affected ads to see the new tagline reflected.'
    }
  };
}

module.exports = { run };
