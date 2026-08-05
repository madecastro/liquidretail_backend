// Executor for capability brand.delete (Tier 3, brand scope).
//
// FULL cascade delete via cascadeDeleteService — removes the brand
// and everything downstream: Media, CatalogProduct, Ad, Campaign,
// CampaignRun, IntegrationCredential, LayoutInputArtifact,
// AiCanvasArtifact, and every other brand-keyed collection. Also
// destroys Cloudinary assets best-effort.
//
// IRREVERSIBLE. Requires the explicit phrase "DELETE BRAND" typed in
// the confirmation UI. In addition, the caller must pass confirmName
// exactly equal to the brand's current name — mirrors the route
// handler's belt-and-braces safety gate (see routes/brand.js:2609).

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

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const confirmName = String(args?.confirmName || '').trim();
  if (confirmName !== brand.name) {
    return {
      ok: false,
      error: 'confirmName must match the brand name exactly to delete',
      expected: brand.name,
      code: 'confirmName-mismatch'
    };
  }

  const { cascadeDeleteBrand } = require('../cascadeDeleteService');
  let result;
  try {
    result = await cascadeDeleteBrand(brand._id);
  } catch (err) {
    return { ok: false, error: err?.message || 'cascade delete failed' };
  }
  if (!result?.ok) {
    return { ok: false, error: result?.reason || 'cascade delete failed' };
  }

  return {
    ok: true,
    kind: 'brandDelete',
    data: {
      _id:      String(brand._id),
      name:     brand.name,
      cascaded: {
        mediaDeleted:              result.mediaDeleted              ?? null,
        productsDeleted:           result.productsDeleted           ?? null,
        adsDeleted:                result.adsDeleted                ?? null,
        campaignsDeleted:          result.campaignsDeleted          ?? null,
        runsDeleted:               result.runsDeleted               ?? null,
        integrationsDisconnected:  result.integrationsDisconnected  ?? null,
        artifactsDeleted:          result.artifactsDeleted          ?? null,
        cloudinaryAssetsRemoved:   result.cloudinaryAssetsRemoved   ?? null
      },
      note: 'Brand + all descendants gone. Cloudinary asset removal is best-effort — orphaned assets may remain.'
    }
  };
}

module.exports = { run };
