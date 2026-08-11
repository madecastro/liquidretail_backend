// Executor for capability team.member.patch (Tier 1, advertiser scope).
//
// Change a member's role. Mirrors PATCH /api/members/:userId. Refuses
// to demote the only owner — every Advertiser must have at least one
// owner. Returns the prior role so the operator can revert if needed.

'use strict';

const mongoose = require('mongoose');
const AdvertiserMembership = require('../../models/AdvertiserMembership');

const VALID_ROLES = ['owner', 'admin', 'editor', 'viewer'];

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawUserId = args?.userId;
  if (!rawUserId) return { ok: false, error: 'userId required' };
  if (!mongoose.isValidObjectId(rawUserId)) {
    return { ok: false, error: `userId "${rawUserId}" is not a valid ObjectId` };
  }
  const role = String(args?.role || '').toLowerCase();
  if (!VALID_ROLES.includes(role)) {
    return { ok: false, error: `role must be one of: ${VALID_ROLES.join(', ')}` };
  }

  const target = await AdvertiserMembership.findOne({
    advertiserId: req.advertiserId,
    userId:       rawUserId,
    status:       'active'
  });
  if (!target) return { ok: false, error: 'member not found' };

  const priorRole = target.role;
  if (priorRole === role) {
    return {
      ok: true,
      kind: 'memberUpdate',
      data: {
        membershipId: String(target._id),
        userId:       String(target.userId),
        email:        target.email,
        role,
        priorRole,
        noop: true,
        note: 'Member already had this role — no change.'
      }
    };
  }

  // Last-owner guard.
  if (priorRole === 'owner' && role !== 'owner') {
    const ownerCount = await AdvertiserMembership.countDocuments({
      advertiserId: req.advertiserId,
      status:       'active',
      role:         'owner'
    });
    if (ownerCount <= 1) {
      return {
        ok: false,
        error: 'cannot demote the only owner — promote someone else first',
        code:  'LAST_OWNER'
      };
    }
  }

  target.role = role;
  await target.save();

  return {
    ok: true,
    kind: 'memberUpdate',
    data: {
      membershipId: String(target._id),
      userId:       String(target.userId),
      email:        target.email,
      role,
      priorRole,
      note: 'Role updated. Call again with priorRole to revert.'
    }
  };
}

module.exports = { run };
