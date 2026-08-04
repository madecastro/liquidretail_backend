// Executor for capability ad.inspect (Tier 0, ad scope).
//
// Returns a compact snapshot of a single ad's generation state — the
// fields most useful for an operator asking "what happened with this
// ad?" via the agent. NOT the full generation-inspector payload from
// GET /api/ads/:id/generation-inspector — that route surfaces a much
// wider surface (reference stacks, artifact prompts, HTML dumps) sized
// for the modal, not for LLM context. If the LLM wants more, later
// capabilities (ad.getFullInspector) can layer on top.
//
// Tenant-scoped via req.advertiserId + Ad.brandId ∈ advertiser's brands.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawAdId = args?.adId;
  if (!rawAdId) return { ok: false, error: 'adId required' };
  if (!mongoose.isValidObjectId(rawAdId)) {
    return { ok: false, error: `adId "${rawAdId}" is not a valid ObjectId` };
  }

  const ad = await Ad.findById(rawAdId).lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };

  // Verify the ad's brand belongs to this advertiser. Returning "not
  // found" for cross-tenant matches the ads route's own guard.
  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  // Compact regen state.
  const regenHistory = Array.isArray(ad.regenerationHistory) ? ad.regenerationHistory : [];
  const lastRegen = regenHistory.length ? regenHistory[regenHistory.length - 1] : null;

  return {
    ok: true,
    kind: 'ad',
    data: {
      _id:         String(ad._id),
      brand:       { _id: String(brand._id), name: brand.name },
      productId:   ad.productId ? String(ad.productId) : null,
      kind:        ad.kind,
      template:    ad.template,
      aspectRatio: ad.aspectRatio,
      platformFormat: ad.platformFormat,
      status:      ad.status,
      renderRoute: ad.renderRoute,
      renderUrl:   ad.renderUrl || null,
      generatedAt: ad.renderedAt || ad.generatedAt || ad.createdAt || null,
      updatedAt:   ad.updatedAt || null,

      // Regeneration state — mirrors what the Generation Details modal
      // polls for. Enough for the agent to answer "is a regen running?"
      // and "did the last regen succeed?" without a second call.
      regenerating:      !!ad.regenerating,
      regenerationStage: ad.regenerationStage || null,
      lastRegeneration:  lastRegen
        ? { status: lastRegen.status, error: lastRegen.error || null, at: lastRegen.at || null, mode: lastRegen.mode || null }
        : null,

      // Provider hooks — enough for the agent to answer "which model
      // rendered this?" and "what was the prompt?" without a follow-up.
      // Video ads carry veo* fields (Omni-family — legacy name); image
      // ads carry imageGeneration (direct-image path).
      video: ad.kind === 'video' ? {
        model:       ad.veoModel || null,
        aspectRatio: ad.veoAspectRatio || null,
        prompt:      ad.veoPrompt || null,
        videoUrl:    ad.veoVideoUrl || null
      } : null,
      image: ad.kind === 'image' ? {
        model:            ad.imageGeneration?.model || null,
        pipeline:         ad.imageGeneration?.pipeline || null,
        promptPreview:    typeof ad.imageGeneration?.prompt === 'string'
                            ? ad.imageGeneration.prompt.slice(0, 400)
                            : null,
        renderUrl:        ad.renderUrl || null,
        intentResolution: ad.imageGeneration?.intentResolution || null
      } : null,

      // Meta sync — matters for the agent to know when the ad is
      // read-only (exported ads shouldn't be regenerated).
      metaSyncStatus: ad.metaSyncStatus || null,

      // Regeneration history counter (not the payload — the payload can
      // be huge, and the agent rarely needs it).
      regenerationCount: regenHistory.length
    }
  };
}

module.exports = { run };
