// Caller-role authorization for the team.* capability executors.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────
// routes/members.js and routes/invitations.js are gated by
// middleware/requireMembershipRole.js. The agent path is NOT gated by it:
// index.js mounts `app.use('/api/agent', requireAuth, agentRoutes)` with no
// role middleware, and POST /api/agent/chat dispatches capability tool-calls
// straight to executors in this directory. Four of those executors
// (teamMemberPatch, teamMemberDelete, teamInviteCreate, teamInviteDelete)
// each say "Mirrors <the HTTP route>" in their header comment — and mirrored
// the route's BEHAVIOUR while omitting its AUTHORIZATION. So every guard
// added to the routes was reachable-around via the agent, and a `viewer`
// could invoke team__member__patch with {userId: <self>, role: 'owner'} and
// self-promote. Express middleware cannot help here: an executor is a plain
// `run({req, args})` function, not a route layer.
//
// ── WHY THE HELPERS ARE IMPORTED, NOT REIMPLEMENTED ───────────────────
// The rank order (viewer=0 < editor=1 < admin=2 < owner=3) and both rank
// comparisons live in ONE place — middleware/requireMembershipRole.js — and
// are imported below. This file adds no rank logic of its own; it only
// adapts those helpers to the executor result contract
// ({ ok:false, error, code }) instead of an Express 403. A per-caller copy
// of a guard is this repo's single most-repeated way of reopening a hole
// (resolveDeriveFromMaster / receiptFree / isHookFirstVideoPromptEnabled —
// see CLAUDE.md), and this would have been the third copy of the rank table.
//
// ── THE MATRIX (identical to the HTTP routes, deliberately) ───────────
//   team.member.patch   → manager gate (owner|admin, NO self carve-out)
//                         + canActOnRole(caller, target.role)
//                         + canGrantRole(caller, requestedRole)
//   team.member.delete  → self-target (resign) allowed for ANY role;
//                         otherwise manager gate + canActOnRole
//   team.invite.create  → manager gate + canGrantRole(caller, role)
//   team.invite.delete  → manager gate only (a pending invitation has
//                         granted nobody any access yet, so revoking one
//                         cannot be an escalation at any rank)
//
// ── ORDERING IS LOAD-BEARING ──────────────────────────────────────────
// requireMembershipRole.js documents, twice, that canActOnRole and
// canGrantRole do NOT validate their role arguments: an unrecognised role
// ranks -Infinity, so canGrantRole(anyRealRole, 'garbage') returns TRUE.
// Callers must therefore validate first. Both conditions hold at every call
// site here and must keep holding:
//   - targetRole is always read off a persisted AdvertiserMembership doc
//     (schema enum), never from caller-supplied args.
//   - requestedRole is always checked against the executor's own VALID_ROLES
//     BEFORE requireCanGrant() is reached.

'use strict';

const requireMembershipRole = require('../../middleware/requireMembershipRole');
const { canActOnRole, canGrantRole } = requireMembershipRole;

// Roles permitted to manage team membership at all. Mirrors the
// `requireMembershipRole(['owner', 'admin'])` argument used on every
// mutating members/invitations route.
const MANAGE_ROLES = Object.freeze(['owner', 'admin']);

// Each helper returns NULL when the action is permitted, or a ready-to-return
// executor error result when it is not. Call sites read as:
//     const denied = requireManagerRole(req);
//     if (denied) return denied;
// A missing/unrecognised req.user.role fails CLOSED: it is not in
// MANAGE_ROLES, and roleRank() ranks it -Infinity so no rank comparison can
// succeed for it either.

function callerRoleOf(req) {
  return req && req.user ? req.user.role : undefined;
}

// Coarse gate: may this caller manage team membership at all?
function requireManagerRole(req) {
  const role = callerRoleOf(req);
  if (!role || !MANAGE_ROLES.includes(role)) {
    return {
      ok: false,
      error: `this action requires role: ${MANAGE_ROLES.join(' or ')} (you are ${role || 'unauthenticated'})`,
      code: 'ROLE_FORBIDDEN'
    };
  }
  return null;
}

// Rank gate on the TARGET's current role — stops an admin from modifying or
// revoking an owner ("escalation-by-deletion"). `targetRole` MUST come from a
// persisted membership document; see the ordering note above.
function requireCanActOn(req, targetRole, verb = 'modify') {
  const role = callerRoleOf(req);
  if (!canActOnRole(role, targetRole)) {
    return {
      ok: false,
      error: `cannot ${verb} a member with a higher role than your own`,
      code: 'ROLE_FORBIDDEN'
    };
  }
  return null;
}

// Rank gate on the REQUESTED role — blocks granting above your own rank
// (self-promotion, and an admin minting an owner). `requestedRole` MUST
// already have passed the executor's VALID_ROLES check; see the ordering
// note above.
function requireCanGrant(req, requestedRole) {
  const role = callerRoleOf(req);
  if (!canGrantRole(role, requestedRole)) {
    return {
      ok: false,
      error: `only a role at or below your own (${role}) can be granted`,
      code: 'ROLE_FORBIDDEN'
    };
  }
  return null;
}

// Is this call targeting the caller's own membership? Used ONLY by
// team.member.delete, mirroring the route's
// `allowSelfTargetParam: 'userId'` carve-out — a member of any role may
// resign. Deliberately NOT used by team.member.patch: self-targeting there
// is exactly the self-promotion vector.
function isSelfTarget(req, userId) {
  const callerUserId = req && req.user ? req.user.userId : null;
  return Boolean(callerUserId && userId && String(callerUserId) === String(userId));
}

module.exports = {
  MANAGE_ROLES,
  requireManagerRole,
  requireCanActOn,
  requireCanGrant,
  isSelfTarget
};
