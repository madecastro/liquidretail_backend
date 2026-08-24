// Executor for capability team.member.patch (Tier 1, advertiser scope).
//
// Change a member's role. Mirrors PATCH /api/members/:userId. Refuses
// to demote the only owner — every Advertiser must have at least one
// owner. Returns the prior role so the operator can revert if needed.
//
// AUTHZ — mirrors the route's caller-role gate, which this executor
// previously omitted entirely (see _teamAuthzCommon.js for the full
// writeup). /api/agent is mounted behind requireAuth ONLY, so without
// these three checks any active member — including a `viewer` — could
// dispatch team__member__patch with {userId: <self>, role: 'owner'} and
// self-promote, walking straight around the guard on routes/members.js:
//   1. manager gate — owner|admin only. There is deliberately NO
//      self-target carve-out here (unlike team.member.delete): a
//      viewer/editor must not reach this executor even against their own
//      userId, because self-targeting IS the self-promotion vector.
//   2. canActOnRole — may not modify a member who outranks you.
//   3. canGrantRole — may not grant above your own rank.
// The last-owner guard below is NOT an authorization check: it only fires
// when DEMOTING an owner, so it never stood between a caller and GRANTING
// owner to themselves.

'use strict';

const mongoose = require('mongoose');
const AdvertiserMembership = require('../../models/AdvertiserMembership');
const { requireManagerRole, requireCanActOn, requireCanGrant } = require('./_teamAuthzCommon');

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

  // Manager gate: after shape validation (which touches no data and leaks
  // nothing), but BEFORE the membership lookup below — an unauthorized
  // caller must not be able to probe which userIds are members here.
  const notManager = requireManagerRole(req);
  if (notManager) return notManager;

  const target = await AdvertiserMembership.findOne({
    advertiserId: req.advertiserId,
    userId:       rawUserId,
    status:       'active'
  });
  if (!target) return { ok: false, error: 'member not found' };

  // Rank checks, now that the target's CURRENT role is known and came off a
  // persisted doc (the validated-input precondition both helpers document).
  // These run BEFORE the no-op shortcut below on purpose: an admin naming an
  // owner with role:'owner' mutates nothing, but answering ok:true would
  // still confirm that owner's existence and email to a caller who is not
  // allowed to act on them. The route has no shortcut and would 403.
  const cannotAct = requireCanActOn(req, target.role, 'modify');
  if (cannotAct) return cannotAct;
  const cannotGrant = requireCanGrant(req, role);
  if (cannotGrant) return cannotGrant;

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
