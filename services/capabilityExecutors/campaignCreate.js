// Executor for capability campaign.create (Tier 1, brand scope).
//
// Creates a reach-social campaign under the caller's brand. Mirrors
// POST /api/campaigns behavior: applies ad-readiness gate, validates
// product/media ids belong to the same brand, and stamps a synthetic
// externalId (`rs_<ObjectId>`) so the (brandId, platform, externalId)
// unique index holds. Only creates reach-social campaigns; platform-
// synced ones (meta-ads, google-ads) originate on the platform side.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Campaign = require('../../models/Campaign');
const CatalogProduct = require('../../models/CatalogProduct');
const Media = require('../../models/Media');
const { getAdReadiness } = require('../adReadinessService');

const VALID_KINDS = new Set(['brand', 'product', 'promotional']);

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

  const name = String(args?.name || '').trim();
  if (!name) return { ok: false, error: 'name required (non-empty)' };
  if (name.length > 200) return { ok: false, error: `name too long (${name.length} > 200 chars)` };

  const kind = args?.kind;
  if (!VALID_KINDS.has(kind)) {
    return { ok: false, error: `kind must be one of ${[...VALID_KINDS].join(', ')}` };
  }

  const productIds = Array.isArray(args?.productIds) ? args.productIds : [];
  const mediaIds   = Array.isArray(args?.mediaIds)   ? args.mediaIds   : [];

  // Ad-readiness gate — matches the route handler's behavior. Blocks
  // campaign creation until every connected source has completed at
  // least one DetectRun.
  const readiness = await getAdReadiness(brand._id);
  if (!readiness.ready) {
    return {
      ok: false,
      error: readiness.reason || 'account setup incomplete',
      code: 'account-setup-incomplete',
      blockers: readiness.blockers || []
    };
  }

  // Tenant-scoped product/media validation. Drop any that don't belong
  // to this brand rather than 400-ing — mirrors the route handler.
  const validProducts = productIds.length === 0
    ? []
    : await CatalogProduct.find({ _id: { $in: productIds }, brandId: brand._id })
        .select('_id').lean();
  const validProductIds = validProducts.map((p) => p._id);
  const validMedia = mediaIds.length === 0
    ? []
    : await Media.find({ _id: { $in: mediaIds }, brandId: brand._id })
        .select('_id').lean();
  const validMediaIds = validMedia.map((m) => m._id);

  const _id = new mongoose.Types.ObjectId();
  const externalId = `rs_${_id.toString()}`;

  let promo = null;
  if (kind === 'promotional' && args?.promotionalDetails && typeof args.promotionalDetails === 'object') {
    promo = { ...args.promotionalDetails };
    if (promo.startsAt) promo.startsAt = new Date(promo.startsAt);
    if (promo.endsAt)   promo.endsAt   = new Date(promo.endsAt);
  }

  const campaign = await Campaign.create({
    _id,
    advertiserId: req.advertiserId,
    brandId:      brand._id,
    platform:     'reach-social',
    externalId,
    name,
    kind,
    status:       'ACTIVE',
    matchedProductIds: validProductIds,
    mediaIds:          validMediaIds,
    promotionalDetails: promo,
    adSets:       []
  });

  return {
    ok: true,
    kind: 'campaign',
    data: {
      _id:               String(campaign._id),
      brandId:           String(brand._id),
      brandName:         brand.name,
      platform:          campaign.platform,
      externalId:        campaign.externalId,
      name:              campaign.name,
      campaignKind:      campaign.kind,
      status:            campaign.status,
      matchedProductCount: validProductIds.length,
      mediaCount:        validMediaIds.length,
      // Report any dropped ids so the operator knows the mismatch —
      // the agent can then say "3 of 5 products added; 2 did not belong
      // to this brand and were skipped."
      droppedProductIds: productIds.filter((id) => !validProductIds.map(String).includes(String(id))),
      droppedMediaIds:   mediaIds.filter((id) => !validMediaIds.map(String).includes(String(id)))
    }
  };
}

module.exports = { run };
