// Executor for capability team.invite.delete (Tier 1, advertiser scope).
//
// Revoke a pending AdvertiserMembership. Mirrors DELETE
// /api/invitations/:id — sets status='revoked' + audit fields. Refuses
// non-pending invitations (a revoked invitation cannot be re-revoked;
// an active member goes through team.member.delete).
//
// AUTHZ — mirrors the route's caller-role gate, previously omitted here
// (see _teamAuthzCommon.js). Without it any active member, including a
// `viewer`, could cancel any pending invitation on the advertiser —
// enough to quietly block a workspace from onboarding anyone new.
// Manager gate ONLY: unlike team.member.patch/delete there is no
// rank-vs-target comparison, because a pending invitation has not granted
// anyone access yet, so revoking one cannot be an escalation regardless of
// the role it was offered at. Same reasoning as the route.

'use strict';

const mongoose = require('mongoose');
const AdvertiserMembership = require('../../models/AdvertiserMembership');
const { requireManagerRole } = require('./_teamAuthzCommon');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawInvitationId = args?.invitationId;
  if (!rawInvitationId) return { ok: false, error: 'invitationId required' };
  if (!mongoose.isValidObjectId(rawInvitationId)) {
    return { ok: false, error: `invitationId "${rawInvitationId}" is not a valid ObjectId` };
  }

  // Manager gate: after shape validation (which touches no data), but BEFORE
  // the lookup below — an unauthorized caller must not be able to probe which
  // invitation ids exist on this advertiser.
  const notManager = requireManagerRole(req);
  if (notManager) return notManager;

  const inv = await AdvertiserMembership.findOne({
    _id: rawInvitationId,
    advertiserId: req.advertiserId,
    status: 'pending'
  });
  if (!inv) return { ok: false, error: 'pending invitation not found' };

  inv.status    = 'revoked';
  inv.revokedAt = new Date();
  inv.revokedBy = req.user?.userId || null;
  await inv.save();

  return {
    ok: true,
    kind: 'invitationUpdate',
    data: {
      id:        String(inv._id),
      email:     inv.email,
      role:      inv.role,
      status:    'revoked',
      revokedAt: inv.revokedAt,
      note: 'Invitation revoked. The token is invalidated — the invitee can no longer accept.'
    }
  };
}

module.exports = { run };
