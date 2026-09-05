// Executor for capability brand.refreshEnrichment (Tier 2, brand scope).
//
// Manually re-triggers the brand-enrichment pipeline: Brandfetch (logo,
// colors, fonts) → website scrape (background, meta) → LLM enrichment
// (tagline, summary, tone, hashtags, tags, demographics). Resets
// enrichmentSources so every tier re-attempts, and unlocks curated
// fields that are currently empty (so the operator's intent to
// re-populate is respected).
//
// Billable (~$0.15 aggregate: Brandfetch API + one LLM call). Runs
// synchronously here rather than fire-and-forget so the agent can
// report back what was actually updated.
//
// Website-dependent tiers still need brand.websiteUrl; missing URL is
// recorded as enrichmentSkipReason and Meta-ads / Shopify-theme font
// ingest still run.

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

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId });
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };
  // Reset enrichment sources + unlock empty curated fields — mirrors
  // the route handler at routes/brand.js:2518.
  const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const unlocked = [];
  brand.enrichmentSources = [];
  if (!(brand.curatedFields || []).includes('logoUrl')) {
    brand.logoIngestedAt = null;
    brand.logoIngestError = null;
  }
  brand.curatedFields = (brand.curatedFields || []).filter((k) => {
    if (isEmpty(brand[k])) { unlocked.push(k); return false; }
    return true;
  });
  if (unlocked.includes('fontFamily')) brand.fontSource = null;
  if (unlocked.includes('logoUrl')) {
    brand.logoSource = null;
    brand.logoOriginalUrl = null;
    brand.logoIngestedAt = null;
    brand.logoIngestError = null;
  }
  await brand.save();

  const { enrichBrandFromUrl } = require('../brandEnrichmentService');
  let result;
  try {
    // Run to completion here (not fire-and-forget). The agent's SSE
    // stream stays open for the duration (~30-90s).
    result = await enrichBrandFromUrl(brand._id);
  } catch (err) {
    return { ok: false, error: err?.message || 'enrichment failed' };
  }

  // Reload the brand to report the actual post-enrichment state.
  const fresh = await Brand.findById(brand._id).select('_id name tagline summary logoUrl primaryColor tone hashtags tags fontFamily').lean();

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id:      String(brand._id),
      name:     brand.name,
      unlocked,
      enrichmentResult: result || null,
      current: {
        tagline:      fresh?.tagline      || null,
        summary:      fresh?.summary      || null,
        logoUrl:      fresh?.logoUrl      || null,
        primaryColor: fresh?.primaryColor || null,
        tone:         fresh?.tone         || null,
        hashtags:     fresh?.hashtags     || [],
        tags:         fresh?.tags         || [],
        fontFamily:   fresh?.fontFamily   || null
      },
      cacheNote: 'CreativeDirectionArtifact rows keyed on Brand.summary + Brand.logoUrl remain until they re-derive. If you want Director signals to reflect the new enrichment immediately, ask an engineer to bump DIRECTOR_SIGNALS_VERSION.'
    }
  };
}

module.exports = { run };
