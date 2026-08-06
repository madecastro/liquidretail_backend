// Executor for capability team.invite.accept (Tier 1, advertiser scope).
//
// Accept a pending invitation by token. Mirrors POST
// /api/invitations/by-token/:token/accept — flips status to active,
// binds userId, stamps acceptedAt. Refuses when the invitation
// email does not match the calling user's email (invitations are
// email-bound; can't be redirected).
//
// The current-user context matters here: the caller must have
// req.user.email + req.user.userId (populated by requireAuth). Note
// this capability accepts an invite to potentially a DIFFERENT
// advertiser than the caller's current req.advertiserId — that is
// the whole point of accepting an invite. The membership tenant
// resolves from the invitation, not req.advertiserId.

'use strict';

const AdvertiserMembership = require('../../models/AdvertiserMembership');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  if (!req.user?.userId || !req.user?.email) {
    return { ok: false, error: 'no user context on request — auth middleware did not run' };
  }
  const token = String(args?.token || '').trim();
  if (!token) return { ok: false, error: 'token required' };
  if (token.length > 500) return { ok: false, error: 'token too long' };

  const inv = await AdvertiserMembership.findOne({
    inviteToken: token,
    status:      'pending'
  });
  if (!inv) return { ok: false, error: 'invitation not found or already accepted' };

  const callerEmail = String(req.user.email || '').toLowerCase();
  const inviteEmail = String(inv.email || '').toLowerCase();
  if (inviteEmail !== callerEmail) {
    return {
      ok: false,
      error: `this invitation was sent to ${inv.email}; you are signed in as ${req.user.email}`,
      code:  'INVITE_EMAIL_MISMATCH'
    };
  }

  inv.userId     = req.user.userId;
  inv.status     = 'active';
  inv.acceptedAt = new Date();
  await inv.save();

  return {
    ok: true,
    kind: 'memberUpdate',
    data: {
      membershipId: String(inv._id),
      advertiserId: String(inv.advertiserId),
      email:        inv.email,
      role:         inv.role,
      status:       'active',
      acceptedAt:   inv.acceptedAt,
      note: 'Invitation accepted. Refresh your workspace list to see this advertiser; the next requireAuth session may need X-Advertiser-Id to pick this one over your existing memberships.'
    }
  };
}

module.exports = { run };
