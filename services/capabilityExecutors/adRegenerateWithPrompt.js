// Executor for capability ad.regenerateWithPrompt (Tier 2, ad scope).
//
// Billable — one gpt-image-2/edit call ≈ $0.15 (see PLATE_QUALITY in
// directImageRenderService; measured 2026-07-31). The Tier 2 gate
// (routes/agent.js + services/spendGuard) prevents dispatch until BOTH
// the operator confirms AND the advertiser's daily cap has room.
//
// This executor kicks the regenerate job via setImmediate and returns
// early with `regenerationStarted:true` — the actual render happens
// asynchronously and takes 30-90s. The agent tells the operator to
// poll ad.inspect for progress. Same pattern as the existing
// POST /api/ads/:id/regenerate route (routes/ads.js) — we call the
// preflight + service directly instead of self-HTTP.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');
const regen = require('../adRegenerateService');

const MAX_OVERRIDE_LEN = 40_000;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawAdId = args?.adId;
  if (!rawAdId) return { ok: false, error: 'adId required' };
  if (!mongoose.isValidObjectId(rawAdId)) {
    return { ok: false, error: `adId "${rawAdId}" is not a valid ObjectId` };
  }

  // Validate promptOverride shape. Two accepted shapes matching the
  // /:id/regenerate route: { system, user } object OR a single string
  // (verbatim replacement). The agent's tool schema exposes only the
  // object form; string form retained for future flexibility.
  const raw = args?.promptOverride;
  if (!raw) return { ok: false, error: 'promptOverride required — {system, user} object' };
  let promptOverride;
  if (typeof raw === 'object') {
    const sys = String(raw.system || '').trim();
    const usr = String(raw.user   || '').trim();
    if (!sys || !usr) return { ok: false, error: 'promptOverride requires both system and user text' };
    if (sys.length > MAX_OVERRIDE_LEN || usr.length > MAX_OVERRIDE_LEN) {
      return { ok: false, error: `promptOverride text too long (max ${MAX_OVERRIDE_LEN} chars each)` };
    }
    promptOverride = { system: sys, user: usr };
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return { ok: false, error: 'promptOverride string cannot be empty' };
    if (s.length > MAX_OVERRIDE_LEN) return { ok: false, error: `promptOverride too long (max ${MAX_OVERRIDE_LEN} chars)` };
    promptOverride = s;
  } else {
    return { ok: false, error: 'promptOverride must be an object {system, user} or a string' };
  }

  // Tenant guard — the ad must belong to a brand under this advertiser.
  const ad = await Ad.findById(rawAdId).select('_id brandId kind status regenerating metaSyncStatus').lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };
  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  // Only image ads support prompt-override regen — video regen uses a
  // separate path (veo storyboard, not gpt-image-2 prompt).
  if (ad.kind !== 'image') {
    return { ok: false, error: `ad.regenerateWithPrompt is image-only (this ad is kind=${ad.kind})` };
  }

  // Preflight: not-exported, not-regenerating, under per-ad daily cap.
  // Different cap from spendGuard — spendGuard is USD across the whole
  // advertiser; this cap is regenerations-per-ad-per-24h (REGENERATE_
  // DAILY_CAP, default 10). Both gates apply.
  try {
    await regen.preflight(ad._id, ad.brandId);
  } catch (err) {
    return { ok: false, error: err.message, status: err.status || 400 };
  }

  const requestedBy = req.user?.userId || req.user?.email || 'agent';
  // Kick the render loop in the background — same shape as the route
  // handler. We don't await; the operator polls ad.inspect for status.
  setImmediate(() => {
    regen.regenerateAd({
      ad,
      prompt: '',                // refinement-note path unused
      mode: 'full',              // image regen ignores mode; kept for symmetry
      requestedBy,
      videoModel: null,
      promptOverride
    }).catch((err) => {
      console.error(`❌ ad.regenerateWithPrompt background crash: ${err.message}`);
    });
  });

  return {
    ok: true,
    kind: 'adRegenerationStarted',
    data: {
      _id: String(ad._id),
      brand: { _id: String(brand._id), name: brand.name },
      regenerating: true,
      startedBy: requestedBy,
      note: 'Regeneration kicked off in the background. Poll ad.inspect (or wait ~30-90s) — regenerationStage / lastRegeneration.status will surface the outcome.'
    }
  };
}

module.exports = { run };
