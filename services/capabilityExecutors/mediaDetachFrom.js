// Executor for capability media.detachFrom (Tier 1, brand scope).
//
// Remove an operator-added attachment from a UGC Media. Only touches
// source:'operator' entries — detect-derived matches survive because
// they're the auto-computed baseline. If the operator wants to
// suppress a detect match, that's a different capability (not yet
// built).

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

  let result;
  if (targetType === 'product') {
    const targetId = args?.targetId;
    if (!targetId) return { ok: false, error: 'targetId required for product detach' };
    if (!mongoose.isValidObjectId(targetId)) {
      return { ok: false, error: `targetId "${targetId}" is not a valid ObjectId` };
    }
    result = await svc.detachProduct({ mediaId: rawMediaId, productId: targetId, advertiserId: req.advertiserId });
  } else if (targetType === 'category') {
    const targetId = args?.targetId;
    if (!targetId) return { ok: false, error: 'targetId required for category detach' };
    if (!mongoose.isValidObjectId(targetId)) {
      return { ok: false, error: `targetId "${targetId}" is not a valid ObjectId` };
    }
    result = await svc.detachCategory({ mediaId: rawMediaId, categoryId: targetId, advertiserId: req.advertiserId });
  } else if (targetType === 'branding') {
    result = await svc.detachBranding({ mediaId: rawMediaId, advertiserId: req.advertiserId });
  } else {
    result = await svc.detachPromotional({ mediaId: rawMediaId, advertiserId: req.advertiserId });
  }

  if (!result.ok) return result;
  return {
    ok: true,
    kind: 'mediaAssignmentUpdate',
    data: {
      mediaId:    result.mediaId,
      targetType,
      productId:  result.productId || null,
      categoryId: result.categoryId || null,
      modified:   result.modified ?? (result.mediaModified || result.productModified) ?? false,
      note: 'Operator attachment removed. Any detect-derived match for this target still stands.'
    }
  };
}

module.exports = { run };
