// Executor for capability brand.ingestFonts (Tier 2, brand scope).
//
// Scans the brand's website for its custom typefaces via
// brandFontIngestService (Brandfetch + scrape). Persists resolved
// font files into Brand.customFonts and updates Brand.fontFamily.
//
// Billable (~$0.05 aggregate: Brandfetch API + scrape). Runs
// synchronously.

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
  if (!brand.websiteUrl) {
    return { ok: false, error: 'brand has no websiteUrl to scan — set one via brand.patch first' };
  }

  const { ingestBrandFonts } = require('../brandFontIngestService');
  const { applyFontIngestResult } = require('../brandFontPersistenceService');

  let result;
  try {
    result = await ingestBrandFonts(brand);
    applyFontIngestResult(brand, result);
    await brand.save();
  } catch (err) {
    return { ok: false, error: err?.message || 'font ingest failed' };
  }

  const { ingested = [], flagged = [], errors = [] } = result || {};

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id:  String(brand._id),
      name: brand.name,
      ingestedCount: ingested.length,
      flaggedCount:  flagged.length,
      errorCount:    errors.length,
      ingested:      ingested.map((f) => ({ family: f.family, source: f.source, url: f.url })),
      flagged:       flagged.map((f)  => ({ family: f.family, reason: f.reason })),
      errors:        errors.slice(0, 5).map((e) => (typeof e === 'string' ? e : e?.message || 'unknown')),
      customFonts:   (brand.customFonts || []).map((f) => ({ family: f.family, source: f.source }))
    }
  };
}

module.exports = { run };
