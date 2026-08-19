// Seed fallback for image-model moderation rejections. Added 2026-08-19.
//
// THE INCIDENT THIS EXISTS FOR
// run_1787136860887_654ed621 (Vuori 2, "Everything" preset, 39 creatives):
// all 18 statics failed, every one with atlasErrorPolicy's `moderationBlocked`
// classification (safety_violations=[sexual]) against the SAME single catalog
// seed photo (an ordinary e-commerce shot: a woman in an open denim jacket
// over a bralette, bare midriff — normal apparel/activewear catalog imagery,
// not an edge case). Zero renderUrls, ~$0 billed (moderation rejections are
// unbilled per atlasErrorPolicy), but zero deliverable ads either.
//
// WHY A SEED SWAP AND NOT JUST "RETRY": atlasErrorPolicy's moderationBlocked
// policy is `action:'give-up', maxAttempts:1` — correctly, because retrying
// the IDENTICAL image+prompt cannot change the classifier's verdict. But
// `campaignAdsGenerationService.js`'s DIRECTOR_UNIVERSE_TOP_N=1 default means
// every one of a product's ~18 static payloads (3 concepts x 6 surfaces)
// shares exactly ONE seed image — so one flagged photo currently zeroes the
// entire product's static output, even though most catalog products ship
// several images (this one had 7) and most brands sell apparel where
// midriff/swim/intimates photography is completely ordinary. Swapping to a
// DIFFERENT catalog image is not "retrying the same input" — it changes the
// one thing the classifier is actually judging.
//
// VERIFIED LIVE (2026-08-19, 3 real submits against openai/gpt-image-2/edit,
// $0.084104 each, $0.252312 total settled — see PR description): the exact
// flagged hero photo rendered successfully with a shorter test prompt (twice,
// with and without an explicit `moderation:'low'` parameter — Atlas's own
// schema already defaults that parameter to 'low', so setting it explicitly
// changed nothing), AND a different, skin-free catalog image of the SAME
// product (a back-of-jacket detail shot) also rendered successfully. Both
// findings matter: the moderation call is sensitive to more than just "does
// the reference show skin" (prompt content plainly matters too — see the PR
// description's prompt-vs-image writeup), but a skin-free alternate seed is a
// reliable, low-risk way to keep the product sellable when the *chosen*
// seed trips the filter, regardless of why it tripped.
//
// COST DISCIPLINE: bounded per render call, not per product. Each candidate
// tried is one full billable submit (~$0.06-0.09). The FIRST creative to hit
// a moderation block for a product "discovers" the fix and records it on
// CampaignRun.seedFallbacks (best-effort — see below); every LATER creative
// for the same product reads that record and goes straight to the known-good
// seed on its first attempt, at ORDINARY single-submit cost. Coordination is
// opportunistic, not required for correctness: a read/write failure here only
// costs one more wasted primary-seed attempt on some later creative, which is
// exactly what happens today with the mitigation disabled.
//
// VISIBILITY, per the "never silently downgrade quality" requirement: a
// successful fallback is stamped onto Ad.imageGeneration.seedFallback
// (services/directImageRenderService.js), never hidden — an operator (or a
// script) can always tell which ads rendered from the product's chosen seed
// and which fell back, and to which image.
'use strict';

const CampaignRun = require('../models/CampaignRun');

// Kill switch — flip to 'false' with no deploy to fully restore pre-fallback
// behaviour (single seed, give up on moderationBlocked exactly as today).
function isEnabled() {
  return process.env.STATIC_MODERATION_SEED_FALLBACK !== 'false';
}

// How many ADDITIONAL catalog images (beyond the primary/starting seed) a
// single render call may try before giving up. Bounds worst-case spend per
// creative at (1 + this) submits, regardless of run coordination state.
function maxFallbackCandidates() {
  const n = Number(process.env.STATIC_MODERATION_SEED_FALLBACK_MAX_CANDIDATES);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

/**
 * Pure. The product's catalog images in merchant-feed order: the primary
 * (`imageMediaId`) first, then `additionalImageMediaIds` in their stored
 * order (the same order `docs/PIPELINES.md`'s feed-order seeding cascade
 * uses elsewhere in this pipeline). Does not touch Mongo — `product` is
 * whatever the caller already loaded (must have selected these two fields).
 */
function orderedCatalogMediaIds(product) {
  const ids = [];
  if (product?.imageMediaId) ids.push(String(product.imageMediaId));
  const extra = Array.isArray(product?.additionalImageMediaIds) ? product.additionalImageMediaIds : [];
  for (const id of extra) {
    if (id) ids.push(String(id));
  }
  return ids;
}

/**
 * Pure. Up to `limit` catalog media ids for `product` not present in
 * `excludeMediaIds`, in feed order. Used to build the fresh-candidate tail
 * once the primary seed and any already-known-blocked/resolved ids are
 * accounted for by the caller.
 */
function nextCandidateIds(product, { excludeMediaIds = [], limit } = {}) {
  const cap = Number.isFinite(limit) ? limit : maxFallbackCandidates();
  const seen = new Set(excludeMediaIds.filter(Boolean).map(String));
  const out = [];
  for (const id of orderedCatalogMediaIds(product)) {
    // Checked BEFORE pushing, not after: a post-push check let `limit: 0`
    // through with one candidate anyway (push, THEN see length 1 >= 0 and
    // stop) — `cap: 0` must mean zero, not "at least one no matter what".
    if (out.length >= cap) break;
    if (seen.has(id)) continue;
    out.push(id);
    seen.add(id);
  }
  return out;
}

/**
 * Pure. Whether a render call is eligible for moderation seed fallback at
 * all — true only when there is AT MOST ONE reference in play, never a
 * genuine multi-image stack (2+), which is a deliberate, ordered pick
 * (operator or Director) this feature must never silently rewrite.
 *
 * `orderedIds.length === 1` covers the single most common live shape and is
 * NOT an edge case: renderService.js forwards Ad.mediaIds whenever
 * Ad.referenceMediaIds is empty, and every concept-driven static mint writes
 * exactly one id into Ad.mediaIds (DIRECTOR_UNIVERSE_TOP_N=1) — so the
 * concept-driven static path, the exact path the 2026-08-19 incident
 * happened on, ALWAYS arrives here with length 1, never 0. A prior version
 * of this check was `!orderedIds.length` (true only for length 0), which
 * made the whole fallback mechanism dead code on that path — confirmed
 * against the real incident's own Ad documents (mediaIds.length===1,
 * referenceMediaIds.length===0 on the Ad, which renderService.js turns into
 * a 1-element array here) and against an independent adversarial review
 * that traced the same gap. `<= 1` treats "the Director's single pick,
 * surfaced through that plumbing" the same as "no explicit pick at all" —
 * both resolve to the exact same single seed either way — while still
 * excluding any real 2+ stack.
 *
 * @param {Array} orderedIds  the caller's `referenceMediaIds`, as strings
 */
function isSingleSeedEligible(orderedIds) {
  return (Array.isArray(orderedIds) ? orderedIds.length : 0) <= 1;
}


/**
 * Read-only. What has this run already learned about seed fallback for this
 * product? Never throws — a lookup failure degrades to "nothing learned yet",
 * which is exactly the pre-fallback behaviour for this call (the caller still
 * tries its own primary seed first).
 *
 * @returns {Promise<{resolvedMediaId: string|null, blockedMediaIds: string[]}>}
 */
async function readRunSeedState(campaignRunId, productId) {
  if (!campaignRunId || !productId) return { resolvedMediaId: null, blockedMediaIds: [] };
  try {
    const run = await CampaignRun.findOne({ runId: String(campaignRunId) })
      .select('seedFallbacks')
      .lean();
    const entries = (run?.seedFallbacks || []).filter((e) => String(e.productId) === String(productId));
    const resolvedMediaId = entries.find((e) => e.resolvedMediaId)?.resolvedMediaId || null;
    const blockedMediaIds = [...new Set(entries.flatMap((e) => e.blocked || []).map(String))];
    return { resolvedMediaId, blockedMediaIds };
  } catch (err) {
    console.warn(`   ⚠️  moderationSeedFallback: readRunSeedState failed (degrading to "nothing learned") — ${err.message}`);
    return { resolvedMediaId: null, blockedMediaIds: [] };
  }
}

/**
 * Best-effort write. Records that `resolvedMediaId` clears moderation for this
 * (run, product), and/or that `blockedMediaId` does not. Fire-and-forget by
 * design — callers must not await this on the render's critical path in a way
 * that would fail the render if the write fails; wrap in .catch(() => {}) at
 * the call site if awaiting for ordering, and never let a rejection here
 * propagate as a render failure. The mitigation still works with zero
 * coordination (see module header) — this only makes it cheaper for later
 * creatives.
 */
async function recordSeedOutcome(campaignRunId, productId, { originalMediaId = null, resolvedMediaId = null, blockedMediaId = null } = {}) {
  if (!campaignRunId || !productId || (!resolvedMediaId && !blockedMediaId)) return;
  const runId = String(campaignRunId);
  const pid = String(productId);
  try {
    const existing = await CampaignRun.findOne({ runId, 'seedFallbacks.productId': pid }).select('_id').lean();
    if (existing) {
      const update = {};
      if (resolvedMediaId) update.$set = { 'seedFallbacks.$.resolvedMediaId': String(resolvedMediaId) };
      if (blockedMediaId) update.$addToSet = { 'seedFallbacks.$.blocked': String(blockedMediaId) };
      if (Object.keys(update).length) {
        await CampaignRun.updateOne({ runId, 'seedFallbacks.productId': pid }, update);
      }
    } else {
      await CampaignRun.updateOne(
        { runId },
        {
          $push: {
            seedFallbacks: {
              productId: pid,
              originalMediaId: originalMediaId ? String(originalMediaId) : null,
              resolvedMediaId: resolvedMediaId ? String(resolvedMediaId) : null,
              blocked: blockedMediaId ? [String(blockedMediaId)] : [],
              at: new Date()
            }
          }
        }
      );
    }
  } catch (err) {
    // A duplicate entry from a lost race (two creatives both saw "no existing
    // row" and both $push'd) is harmless — readRunSeedState merges across all
    // entries for a productId. Anything else just means this run learns
    // nothing from this attempt, which is the pre-fallback baseline.
    console.warn(`   ⚠️  moderationSeedFallback: recordSeedOutcome failed (non-fatal) — ${err.message}`);
  }
}

module.exports = {
  isEnabled,
  maxFallbackCandidates,
  orderedCatalogMediaIds,
  nextCandidateIds,
  isSingleSeedEligible,
  readRunSeedState,
  recordSeedOutcome
};
