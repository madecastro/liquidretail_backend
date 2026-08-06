// Executor for capability team.member.delete (Tier 3, advertiser scope).
//
// Revoke an active membership. Mirrors DELETE /api/members/:userId —
// soft-deletes (status='revoked' + revokedAt/By) so the audit trail
// stays intact. Refuses to remove the only owner. A user CAN revoke
// their own membership (resign) — the route allows self-removal.
//
// Tier 3 phrase gate "REMOVE MEMBER" per coverage plan §D3:
// re-inviting + accepting is a full round-trip, so removal is
// treated as hard-to-reverse.

'use strict';

const mongoose = require('mongoose');
const AdvertiserMembership = require('../../models/AdvertiserMembership');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawUserId = args?.userId;
  if (!rawUserId) return { ok: false, error: 'userId required' };
  if (!mongoose.isValidObjectId(rawUserId)) {
    return { ok: false, error: `userId "${rawUserId}" is not a valid ObjectId` };
  }

  const target = await AdvertiserMembership.findOne({
    advertiserId: req.advertiserId,
    userId:       rawUserId,
    status:       'active'
  });
  if (!target) return { ok: false, error: 'member not found' };

  if (target.role === 'owner') {
    const ownerCount = await AdvertiserMembership.countDocuments({
      advertiserId: req.advertiserId,
      status:       'active',
      role:         'owner'
    });
    if (ownerCount <= 1) {
      return {
        ok: false,
        error: 'cannot remove the only owner — promote someone else to owner first',
        code:  'LAST_OWNER'
      };
    }
  }

  target.status    = 'revoked';
  target.revokedAt = new Date();
  target.revokedBy = req.user?.userId || null;
  await target.save();

  return {
    ok: true,
    kind: 'memberUpdate',
    data: {
      membershipId: String(target._id),
      userId:       String(target.userId),
      email:        target.email,
      priorRole:    target.role,
      status:       'revoked',
      revokedAt:    target.revokedAt,
      note: 'Membership revoked. The user loses access to this advertiser immediately. Re-invite via team.invite.create if needed.'
    }
  };
}

module.exports = { run };
