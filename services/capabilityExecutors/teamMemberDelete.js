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
//
// NOTE: that phrase gate is NOT an authorization control. The phrase is
// supplied by the caller in the request body (explicitConfirmations), is
// compared only against the capability manifest, and has no relationship
// to who is asking — any authenticated caller can type "REMOVE MEMBER".
// It is UX friction against an accident, not a permission check.
//
// AUTHZ — mirrors the route's caller-role gate, previously omitted here
// (see _teamAuthzCommon.js). Without it any active member, including a
// `viewer`, could dispatch team__member__delete and revoke anyone up to
// and including an owner:
//   - self-target (resign) is allowed for ANY role, mirroring the route's
//     `allowSelfTargetParam: 'userId'` carve-out.
//   - any OTHER target requires owner|admin AND canActOnRole, so an admin
//     can never revoke an owner ("escalation-by-deletion").
// The last-owner guard below is not a substitute: it only protects the
// FINAL owner, so with two owners either could be revoked by a viewer.

'use strict';

const mongoose = require('mongoose');
const AdvertiserMembership = require('../../models/AdvertiserMembership');
const { requireManagerRole, requireCanActOn, isSelfTarget } = require('./_teamAuthzCommon');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawUserId = args?.userId;
  if (!rawUserId) return { ok: false, error: 'userId required' };
  if (!mongoose.isValidObjectId(rawUserId)) {
    return { ok: false, error: `userId "${rawUserId}" is not a valid ObjectId` };
  }

  // Manager gate, unless this is a self-resign. Checked against the RAW arg
  // before the lookup, mirroring the route where allowSelfTargetParam
  // compares req.params.userId and short-circuits ahead of the handler.
  const selfResign = isSelfTarget(req, rawUserId);
  if (!selfResign) {
    const notManager = requireManagerRole(req);
    if (notManager) return notManager;
  }

  const target = await AdvertiserMembership.findOne({
    advertiserId: req.advertiserId,
    userId:       rawUserId,
    status:       'active'
  });
  if (!target) return { ok: false, error: 'member not found' };

  // Rank check on the target's CURRENT role (persisted doc). Re-derived from
  // target.userId rather than reusing selfResign above — same comparison the
  // route makes, and it keeps this check correct on its own terms even if the
  // lookup above ever stops filtering by the raw userId.
  const isSelf = isSelfTarget(req, target.userId);
  if (!isSelf) {
    const cannotAct = requireCanActOn(req, target.role, 'revoke');
    if (cannotAct) return cannotAct;
  }

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
