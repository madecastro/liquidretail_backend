// Executor for capability media.attachTo (Tier 1, brand scope).
//
// Attach one UGC Media to a target: product, category, branding, or
// promotional. Wraps mediaAssignmentService — every write is stamped
// source:'operator' so detect re-runs cannot clobber the attachment
// (see the detect-write filter fix in pipelines/detect.js + verifier
// §34).

'use strict';

const mongoose = require('mongoose');
const svc = require('../mediaAssignmentService');

const VALID_TARGET_TYPES = new Set(['product', 'category', 'branding', 'promotional']);

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawMediaId = args?.mediaId;
  if (!rawMediaId) return { ok: false, error: 'mediaId required' };
  if (!mongoose.isValidObjectId(rawMediaId)) {
    return { ok: false, error: `mediaId "${rawMediaId}" is not a valid ObjectId` };
  }
  const targetType = args?.targetType;
  if (!VALID_TARGET_TYPES.has(targetType)) {
    return { ok: false, error: `targetType must be one of: ${[...VALID_TARGET_TYPES].join(', ')}` };
  }
  const assignedBy = req.user?.email || req.user?.userId || 'agent';

  let result;
  if (targetType === 'product') {
    const targetId = args?.targetId;
    if (!targetId) return { ok: false, error: 'targetId required for product attachment' };
    if (!mongoose.isValidObjectId(targetId)) {
      return { ok: false, error: `targetId "${targetId}" is not a valid ObjectId` };
    }
    result = await svc.attachProduct({ mediaId: rawMediaId, productId: targetId, advertiserId: req.advertiserId, assignedBy });
  } else if (targetType === 'category') {
    const targetId = args?.targetId;
    if (!targetId) return { ok: false, error: 'targetId required for category attachment' };
    if (!mongoose.isValidObjectId(targetId)) {
      return { ok: false, error: `targetId "${targetId}" is not a valid ObjectId` };
    }
    result = await svc.attachCategory({ mediaId: rawMediaId, categoryId: targetId, advertiserId: req.advertiserId, assignedBy });
  } else if (targetType === 'branding') {
    result = await svc.attachBranding({ mediaId: rawMediaId, advertiserId: req.advertiserId, assignedBy });
  } else {
    const productIds = Array.isArray(args?.productIds) ? args.productIds : [];
    if (productIds.length > 50) {
      return { ok: false, error: 'promotional attachment supports up to 50 product callouts per Media' };
    }
    result = await svc.attachPromotional({ mediaId: rawMediaId, productIds, advertiserId: req.advertiserId, assignedBy });
  }

  if (!result.ok) return result;
  return {
    ok: true,
    kind: 'mediaAssignment',
    data: {
      mediaId:   result.mediaId,
      targetType,
      productId:      result.productId || null,
      productTitle:   result.productTitle || null,
      categoryId:     result.categoryId || null,
      categoryName:   result.categoryName || null,
      breadcrumbKey:  result.breadcrumbKey || null,
      productIds:     result.productIds || null,   // promotional callouts
      assignedAt:     result.assignedAt,
      note: `Attached UGC media to ${targetType}. Attachment survives detect re-runs. Use media.listAssignments to enumerate all attachments.`
    }
  };
}

module.exports = { run };
