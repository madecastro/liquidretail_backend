// Executor for capability ad.patch (Tier 1, ad scope).
//
// Edit Ad.copy.* fields (headline, cta_text, quote, productName,
// productPrice). Refuses synced-to-Meta ads. Returns priorCopy so the
// operator can undo. Mirrors PATCH /api/ads/:id copy semantics.
//
// Cache note: like adUpdateCta, changing Ad.copy DOES NOT re-render.
// The rendered PNG/MP4 still carries the OLD text until a regenerate.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');

const COPY_KEYS = ['headline', 'cta_text', 'quote', 'productName', 'productPrice'];
const MAX_FIELD_LEN = 300;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawAdId = args?.adId;
  if (!rawAdId) return { ok: false, error: 'adId required' };
  if (!mongoose.isValidObjectId(rawAdId)) {
    return { ok: false, error: `adId "${rawAdId}" is not a valid ObjectId` };
  }

  const copy = args?.copy;
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    return { ok: false, error: 'copy required (object of allowed keys)' };
  }

  // Validate keys + values.
  const set = { updatedAt: new Date() };
  const requestedKeys = Object.keys(copy);
  if (requestedKeys.length === 0) {
    return { ok: false, error: 'copy must contain at least one field' };
  }
  for (const key of requestedKeys) {
    if (!COPY_KEYS.includes(key)) {
      return { ok: false, error: `copy: unknown key '${key}' — allowed: ${COPY_KEYS.join(', ')}` };
    }
    const v = copy[key];
    if (v === null) {
      set[`copy.${key}`] = null;
    } else if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length > MAX_FIELD_LEN) {
        return { ok: false, error: `copy.${key} too long (${trimmed.length} > ${MAX_FIELD_LEN} chars)` };
      }
      set[`copy.${key}`] = trimmed.length === 0 ? null : trimmed;
    } else {
      return { ok: false, error: `copy.${key} must be a string or null` };
    }
  }

  const ad = await Ad.findById(rawAdId)
    .select('_id brandId copy metaSyncStatus').lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };
  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  if (ad.metaSyncStatus === 'synced') {
    return { ok: false, error: 'ad has been synced to Meta — copy changes here would drift from the canonical Meta record. Regenerate + republish instead.' };
  }

  // Capture prior values for revert.
  const priorCopy = {};
  for (const key of requestedKeys) {
    priorCopy[key] = ad.copy?.[key] ?? null;
  }

  await Ad.updateOne({ _id: ad._id }, { $set: set });

  const nextCopy = {};
  for (const key of requestedKeys) {
    nextCopy[key] = set[`copy.${key}`];
  }

  return {
    ok: true,
    kind: 'adUpdate',
    data: {
      _id: String(ad._id),
      brand: { _id: String(brand._id), name: brand.name },
      copy: nextCopy,
      priorCopy,
      cacheNote: 'The already-rendered asset still shows the OLD copy. Regenerate the ad to see the new copy in the rendered PNG/MP4.'
    }
  };
}

module.exports = { run };
