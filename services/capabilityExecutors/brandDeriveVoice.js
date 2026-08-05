// Executor for capability brand.deriveVoice (Tier 2, brand scope).
//
// Kicks off brandVoiceDerivationService — an LLM call against the
// brand's existing Meta/Google ad creatives to extract a structured
// voice profile (tone descriptors, voice principles, disallowed
// phrases, etc.). Threads into the Director. Billable (~$0.02,
// Sonnet). Respects a 7-day TTL by default; pass force=true to
// re-derive immediately.

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
  const force = !!args?.force;

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const { deriveBrandVoice } = require('../brandVoiceDerivationService');
  let result;
  try {
    result = await deriveBrandVoice(brand._id, { force });
  } catch (err) {
    return { ok: false, error: err?.message || 'voice derivation failed' };
  }

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id: String(brand._id),
      name: brand.name,
      derived:    result?.ok !== false,
      skipped:    !!result?.skipped,
      skipReason: result?.reason || null,
      voice:      result?.voice || null,
      evidenceCount: result?.evidenceCount ?? null,
      elapsedMs:  result?.elapsedMs ?? null
    }
  };
}

module.exports = { run };
