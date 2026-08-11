// Executor for capability ad.regenerate (Tier 2, ad scope).
//
// Retry a failed (or otherwise re-generable) ad AS-IS — no prompt
// override, no model swap. Wraps adRegenerateService.regenerateAd,
// same service the POST /api/ads/:id/regenerate route uses. Works for
// BOTH image and video ads (video-only regen uses runVideoFull inside
// the service; image regen uses runImage). Contrast with
// ad.regenerateWithPrompt which is image-only + requires a new
// {system, user} prompt pair.
//
// COST: variable by kind. Static estimate lives on the registry entry
// as a function that reads ad.kind before spendGuard admits the call.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');
const regen = require('../adRegenerateService');

const MAX_NOTE_LEN = 4000;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawAdId = args?.adId;
  if (!rawAdId) return { ok: false, error: 'adId required' };
  if (!mongoose.isValidObjectId(rawAdId)) {
    return { ok: false, error: `adId "${rawAdId}" is not a valid ObjectId` };
  }
  const note = args?.note != null ? String(args.note).trim() : '';
  if (note.length > MAX_NOTE_LEN) {
    return { ok: false, error: `note too long (${note.length} > ${MAX_NOTE_LEN} chars)` };
  }
  const rawMode = args?.mode || 'full';
  if (!['full', 'video-only', 'title-only'].includes(rawMode)) {
    return { ok: false, error: `mode must be one of: full, video-only, title-only` };
  }

  // Tenant guard.
  const ad = await Ad.findById(rawAdId).select('_id brandId kind status regenerating metaSyncStatus').lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };
  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  // Preflight: not exported, not already regenerating, under per-ad
  // daily cap (REGENERATE_DAILY_CAP). Same as adRegenerateWithPrompt.
  try {
    await regen.preflight(ad._id, ad.brandId);
  } catch (err) {
    return { ok: false, error: err.message, status: err.status || 400 };
  }

  const requestedBy = req.user?.userId || req.user?.email || 'agent';
  setImmediate(() => {
    regen.regenerateAd({
      ad,
      prompt: note,       // refinement note surfaced to the renderer; empty is fine
      mode: rawMode,
      requestedBy,
      videoModel: null,
      promptOverride: null
    }).catch((err) => {
      console.error(`❌ ad.regenerate background crash: ${err.message}`);
    });
  });

  return {
    ok: true,
    kind: 'adRegenerationStarted',
    data: {
      _id: String(ad._id),
      brand: { _id: String(brand._id), name: brand.name },
      kind: ad.kind,
      mode: rawMode,
      priorStatus: ad.status || null,
      regenerating: true,
      startedBy: requestedBy,
      note: 'Regeneration kicked off in the background. Poll ad.inspect (or wait ~30-90s image / ~2-5min video) — regenerationStage / lastRegeneration.status will surface the outcome.'
    }
  };
}

// Cost estimator called by spendGuard BEFORE dispatch. Hits the DB
// once per gate check — necessary because per-kind pricing differs by
// ~20x (image ≈ $0.15 gpt-image-2/edit; video ≈ $3.00 Omni master
// upper-bound). Static single-value estimate would either under-
// reserve video (money bug) or over-reserve image (blocks 20+ image
// iterations/day against a $10 cap). Fails closed — a DB error or
// missing ad returns the upper bound so we never under-reserve.
async function estimateUsd(args) {
  const rawAdId = args?.adId;
  if (!rawAdId || !mongoose.isValidObjectId(rawAdId)) return 3.00;
  try {
    const ad = await Ad.findById(rawAdId).select('kind').lean();
    if (!ad) return 3.00;
    return ad.kind === 'video' ? 3.00 : 0.15;
  } catch {
    return 3.00;
  }
}

module.exports = { run, estimateUsd };
