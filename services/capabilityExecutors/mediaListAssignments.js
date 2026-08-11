// Executor for capability media.listAssignments (Tier 0, brand scope).
//
// Read-only enumeration of every attachment on a Media: products,
// categories, branding, promotional. Includes both DETECT-derived
// (auto) and OPERATOR-added entries, so the UI can render the
// "auto-matched" vs "you attached this" distinction.

'use strict';

const mongoose = require('mongoose');
const svc = require('../mediaAssignmentService');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawMediaId = args?.mediaId;
  if (!rawMediaId) return { ok: false, error: 'mediaId required' };
  if (!mongoose.isValidObjectId(rawMediaId)) {
    return { ok: false, error: `mediaId "${rawMediaId}" is not a valid ObjectId` };
  }

  const result = await svc.listAssignments({ mediaId: rawMediaId, advertiserId: req.advertiserId });
  if (!result.ok) return result;

  return {
    ok: true,
    kind: 'mediaAssignmentList',
    data: {
      media:       result.media,
      products:    result.products,
      categories:  result.categories,
      branding:    result.branding,
      promotional: result.promotional,
      counts:      result.counts,
      note: 'Attachments include both detect-derived (auto-matched) and operator-added entries. The `source` field on each row distinguishes them.'
    }
  };
}

module.exports = { run };
