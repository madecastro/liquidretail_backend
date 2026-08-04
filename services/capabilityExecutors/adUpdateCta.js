// Executor for capability ad.updateCta (Tier 1, ad scope).
//
// Sets Ad.ctaText / Ad.ctaUrl / Ad.ctaUrlParams. Reversible via a
// second call with the previous values (returned as priorCta so the
// operator can undo). Tenant-guarded; refuses ads that have been
// synced to Meta (metaSyncStatus === 'synced' means the ad is
// canonical in Meta's system and mutating it locally would drift).
//
// Cache note: cta text/url flows into LayoutInputArtifact at derive
// time and gets typeset into the render at generation time. Changing
// CTA on an already-rendered ad DOES NOT re-render — the rendered
// PNG/MP4 still shows the old text. This is intentional; a fresh
// regenerate is required to see the new CTA in the rendered asset.
// We surface a cache-note so the LLM tells the operator.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');

const MAX_TEXT_LEN = 60;      // Meta CTA button caps around 20-30 chars; 60 leaves headroom
const MAX_URL_LEN  = 2000;
const MAX_PARAMS_LEN = 500;

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawAdId = args?.adId;
  if (!rawAdId) return { ok: false, error: 'adId required' };
  if (!mongoose.isValidObjectId(rawAdId)) {
    return { ok: false, error: `adId "${rawAdId}" is not a valid ObjectId` };
  }

  // At least one field must be provided. All three optional but at
  // least one meaningful change required (calling with no CTA fields
  // is a no-op waste).
  const hasText   = typeof args?.ctaText === 'string';
  const hasUrl    = typeof args?.ctaUrl === 'string';
  const hasParams = typeof args?.ctaUrlParams === 'string';
  if (!hasText && !hasUrl && !hasParams) {
    return { ok: false, error: 'at least one of ctaText / ctaUrl / ctaUrlParams required' };
  }

  // Trim + length guards.
  const ctaText   = hasText   ? String(args.ctaText).trim()       : null;
  const ctaUrl    = hasUrl    ? String(args.ctaUrl).trim()        : null;
  const ctaParams = hasParams ? String(args.ctaUrlParams).trim() : null;
  if (ctaText   != null && ctaText.length   > MAX_TEXT_LEN)   return { ok: false, error: `ctaText too long (max ${MAX_TEXT_LEN} chars)` };
  if (ctaUrl    != null && ctaUrl.length    > MAX_URL_LEN)    return { ok: false, error: `ctaUrl too long (max ${MAX_URL_LEN} chars)` };
  if (ctaParams != null && ctaParams.length > MAX_PARAMS_LEN) return { ok: false, error: `ctaUrlParams too long (max ${MAX_PARAMS_LEN} chars)` };
  if (ctaUrl != null && ctaUrl.length > 0 && !/^https?:\/\//i.test(ctaUrl)) {
    return { ok: false, error: `ctaUrl must start with http:// or https:// (got "${ctaUrl.slice(0, 60)}")` };
  }

  const ad = await Ad.findById(rawAdId).select('_id brandId ctaText ctaUrl ctaUrlParams metaSyncStatus status').lean();
  if (!ad) return { ok: false, error: `ad ${rawAdId} not found` };
  const brand = await Brand.findOne({ _id: ad.brandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `ad ${rawAdId} not found` };

  // Refuse synced-to-Meta ads. Local mutation would drift from the
  // canonical Meta record. Operator wanting a new CTA on a synced ad
  // must regenerate + republish.
  if (ad.metaSyncStatus === 'synced') {
    return { ok: false, error: 'ad has been synced to Meta — CTA changes here would drift from the canonical Meta record. Regenerate + republish instead.' };
  }

  const priorCta = {
    ctaText:      ad.ctaText      || '',
    ctaUrl:       ad.ctaUrl       || '',
    ctaUrlParams: ad.ctaUrlParams || ''
  };
  const set = { updatedAt: new Date() };
  if (hasText)   set.ctaText      = ctaText;
  if (hasUrl)    set.ctaUrl       = ctaUrl;
  if (hasParams) set.ctaUrlParams = ctaParams;

  // No-op guard.
  const willChange =
    (hasText   && ctaText   !== priorCta.ctaText)   ||
    (hasUrl    && ctaUrl    !== priorCta.ctaUrl)    ||
    (hasParams && ctaParams !== priorCta.ctaUrlParams);
  if (!willChange) {
    return {
      ok: true,
      kind: 'adUpdate',
      data: {
        _id: String(ad._id),
        brand: { _id: String(brand._id), name: brand.name },
        cta: priorCta,
        priorCta,
        noop: true,
        note: 'CTA fields unchanged'
      }
    };
  }

  await Ad.updateOne({ _id: ad._id }, { $set: set });

  return {
    ok: true,
    kind: 'adUpdate',
    data: {
      _id: String(ad._id),
      brand: { _id: String(brand._id), name: brand.name },
      cta: {
        ctaText:      hasText   ? ctaText   : priorCta.ctaText,
        ctaUrl:       hasUrl    ? ctaUrl    : priorCta.ctaUrl,
        ctaUrlParams: hasParams ? ctaParams : priorCta.ctaUrlParams
      },
      priorCta,
      cacheNote: 'The already-rendered asset still shows the OLD CTA text. Regenerate the ad to see the new CTA in the rendered PNG/MP4.'
    }
  };
}

module.exports = { run };
