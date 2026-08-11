// Executor for capability aiLayouts.getSession (Tier 0, brand scope).
//
// Poll an AiLayoutSession by id. Read-only companion to
// aiLayouts.generate — the LLM calls it after kicking off a session
// to check status + surface completed reference images. Tenant-scoped
// via advertiserId on the session.

'use strict';

const mongoose = require('mongoose');
const AiLayoutSession = require('../../models/AiLayoutSession');

const REFERENCE_CAP = 20;   // hard cap on references[] length in the response payload

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawSessionId = args?.sessionId;
  if (!rawSessionId) return { ok: false, error: 'sessionId required' };
  if (!mongoose.isValidObjectId(rawSessionId)) {
    return { ok: false, error: `sessionId "${rawSessionId}" is not a valid ObjectId` };
  }

  const session = await AiLayoutSession.findOne({
    _id: rawSessionId,
    advertiserId: req.advertiserId
  }).lean();
  if (!session) return { ok: false, error: `session ${rawSessionId} not found` };

  const references = Array.isArray(session.references)
    ? session.references.slice(0, REFERENCE_CAP)
    : [];

  return {
    ok: true,
    kind: 'layoutSession',
    data: {
      sessionId:    String(session._id),
      mediaId:      session.mediaId ? String(session.mediaId) : null,
      brandId:      session.brandId ? String(session.brandId) : null,
      brandName:    session.brandName || null,
      productName:  session.productName || null,
      quality:      session.quality,
      status:       session.status,
      totalCombos:  session.totalCombos,
      references,
      referencesTruncated: (session.references?.length || 0) > REFERENCE_CAP,
      error:        session.error || null,
      startedAt:    session.startedAt   || null,
      completedAt:  session.completedAt || null,
      createdAt:    session.createdAt
    }
  };
}

module.exports = { run };
