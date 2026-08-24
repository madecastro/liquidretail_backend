// Executor for capability team.invite.create (Tier 3, advertiser scope).
//
// Mirrors POST /api/invitations — creates a pending AdvertiserMembership
// with an inviteToken the operator shares with the invitee. Idempotent
// on (advertiserId, email, status='pending'): a fresh call with the
// same email returns the existing pending invitation instead of
// creating a duplicate. Refuses if the email already has an ACTIVE
// membership on the advertiser.
//
// Tier 3 with phrase gate "INVITE MEMBER" per coverage plan §D3: an
// invitation is externally visible state (shows in members UI, may
// later drive email dispatch), and revoking is a separate step. That
// phrase is caller-supplied UX friction, NOT an authorization control.
//
// AUTHZ — mirrors the route's caller-role gate, previously omitted here
// (see _teamAuthzCommon.js). Without it any active member, including a
// `viewer`, could mint invitations at any role in VALID_ROLES:
//   - manager gate — owner|admin only.
//   - canGrantRole — cap the invited role by the inviter's own rank.
// canGrantRole is a no-op against the CURRENT VALID_ROLES (its maximum,
// admin=2, is already dominated by both owner=3 and admin=2), exactly as
// on the route. It is enforced explicitly anyway because VALID_ROLES is a
// static list that could grow: if 'owner' were ever added, an admin
// minting an owner would be escalation laundering.

'use strict';

const AdvertiserMembership = require('../../models/AdvertiserMembership');
const { generateInviteToken } = require('../../models/AdvertiserMembership');
const User = require('../../models/User');
const { requireManagerRole, requireCanGrant } = require('./_teamAuthzCommon');

const VALID_ROLES = ['admin', 'editor', 'viewer'];   // owner never invited — first user only

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const email = String(args?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { ok: false, error: 'valid email required' };
  }
  if (email.length > 200) return { ok: false, error: 'email too long (max 200 chars)' };
  const role = String(args?.role || 'editor').toLowerCase();
  if (!VALID_ROLES.includes(role)) {
    return { ok: false, error: `role must be one of: ${VALID_ROLES.join(', ')}` };
  }
  // Manager gate: after shape validation (which touches no data), but BEFORE
  // the membership lookups below — an unauthorized caller must not be able to
  // probe which emails are already members of this advertiser.
  const notManager = requireManagerRole(req);
  if (notManager) return notManager;
  // AFTER the VALID_ROLES check, never before — canGrantRole ranks an
  // unrecognised role -Infinity and would wave a garbage string through.
  const cannotGrant = requireCanGrant(req, role);
  if (cannotGrant) return cannotGrant;

  // Active-member guard.
  const existingActive = await AdvertiserMembership.findOne({
    advertiserId: req.advertiserId,
    email,
    status: 'active'
  }).lean();
  if (existingActive) {
    return {
      ok: false,
      error: `${email} is already a member`,
      code: 'already-member',
      membership: { id: String(existingActive._id), role: existingActive.role }
    };
  }

  // Idempotent resend.
  const existingPending = await AdvertiserMembership.findOne({
    advertiserId: req.advertiserId,
    email,
    status: 'pending'
  }).lean();
  if (existingPending) {
    return {
      ok: true,
      kind: 'invitation',
      data: {
        id:        String(existingPending._id),
        email:     existingPending.email,
        role:      existingPending.role,
        status:    'pending',
        token:     existingPending.inviteToken,
        invitedAt: existingPending.invitedAt,
        idempotent: true,
        note: 'A pending invitation for this email already existed — returned it verbatim rather than creating a duplicate.'
      }
    };
  }

  const existingUser = await User.findOne({ email }).select('_id').lean();
  const inv = await AdvertiserMembership.create({
    advertiserId: req.advertiserId,
    userId:       existingUser?._id || null,
    email,
    role,
    status:       'pending',
    inviteToken:  generateInviteToken(),
    invitedBy:    req.user?.userId || null,
    invitedAt:    new Date()
  });

  return {
    ok: true,
    kind: 'invitation',
    data: {
      id:        String(inv._id),
      email:     inv.email,
      role:      inv.role,
      status:    'pending',
      token:     inv.inviteToken,
      invitedAt: inv.invitedAt,
      note: 'Pending invitation created. Share the token (or the invite URL the frontend builds from it) with the invitee. Revoke via team.invite.delete.'
    }
  };
}

module.exports = { run };
