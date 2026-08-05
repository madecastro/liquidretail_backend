// Executor for capability brand.voice.patch (Tier 1, brand scope).
//
// Manual override of Brand.derivedVoice. Set to null to clear (a
// subsequent auto-refresh will re-derive automatically); set to an
// object to override the AI-derived voice profile. Stamps
// derivedVoiceAt so the sweep treats it as recent.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }

  const incoming = args?.voice;
  if (incoming !== null && (typeof incoming !== 'object' || Array.isArray(incoming))) {
    return { ok: false, error: 'voice must be an object or null' };
  }

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name derivedVoice derivedVoiceAt');
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const priorVoice = brand.derivedVoice || null;

  brand.derivedVoice   = incoming;
  brand.derivedVoiceAt = incoming === null ? null : new Date();
  brand.markModified('derivedVoice');
  await brand.save();

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id: String(brand._id),
      name: brand.name,
      voice: brand.derivedVoice,
      derivedVoiceAt: brand.derivedVoiceAt,
      priorVoice
    }
  };
}

module.exports = { run };
