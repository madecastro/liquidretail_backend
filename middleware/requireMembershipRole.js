// Caller-role gate for the members/invitations routes.
//
// requireAuth (middleware/requireAuth.js) proves the caller has an ACTIVE
// membership in SOME Advertiser and populates req.user.role / req.membership
// / req.advertiserId — but it never restricts what that role is allowed to
// DO. Before this file existed, routes/members.js and routes/invitations.js
// mounted behind requireAuth ONLY and never read req.user.role at all, so
// any active member of any role (including 'viewer') could:
//   - PATCH their own userId to role:'owner' (self-promotion)
//   - DELETE any other member, including an owner (arbitrary revoke)
//   - POST an invitation at admin/editor/viewer (uncontrolled invites)
// This is the ONE shared, exported gate for all of that. Do not re-implement
// a per-route role check — a per-caller copy is exactly how this repo's
// `resolveDeriveFromMaster` / `receiptFree` holes reopened (see CLAUDE.md).
//
// Mount AFTER requireAuth — this reads req.user.role, which requireAuth sets.
//
// ── The role hierarchy ──────────────────────────────────────────────────
// Ranks below are a STRICT total order over AdvertiserMembership.role
// (models/AdvertiserMembership.js). Higher rank = more privilege.
const ROLE_RANK = Object.freeze({
  viewer: 0,
  editor: 1,
  admin:  2,
  owner:  3
});

// Safe accessor — an unrecognised/missing role ranks BELOW viewer (fails
// closed: an unknown role can never satisfy a >= comparison against any
// real role).
function roleRank(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, role) ? ROLE_RANK[role] : -Infinity;
}

// Can `callerRole` act on (PATCH the role of, or DELETE) a member whose
// CURRENT role is `targetRole`? Requires caller rank >= target's current
// rank. This is what stops an admin from touching an owner's membership at
// all — "an admin revoking [or demoting] an owner is escalation-by-deletion"
// (owner directive). A peer (admin acting on admin, owner acting on owner)
// IS allowed — this is a deliberate design choice, not an oversight: nothing
// in the brief asks same-rank peers to be walled off from each other, and
// walling them off would leave a lone owner unable to get help managing
// other owners.
//
// ⚠️ CALLER MUST VALIDATE `targetRole` FIRST (adversarial review finding).
// An unrecognised targetRole ranks -Infinity, so canActOnRole(anyRealRole,
// 'garbage') is always true — this function alone cannot tell "a lower-
// privileged real role" apart from "not a real role at all". That is safe
// on the routes in this PR because target.role always comes off a real
// AdvertiserMembership document (schema enum: owner/admin/editor/viewer —
// see models/AdvertiserMembership.js), never caller-supplied. Any NEW
// caller of this function (e.g. an agent/tool-call executor that mirrors
// these routes) must load targetRole the same way — from a persisted
// membership doc, not from unvalidated input — or must validate it against
// the real enum itself before calling this.
function canActOnRole(callerRole, targetRole) {
  return roleRank(callerRole) >= roleRank(targetRole);
}

// Can `callerRole` GRANT `requestedRole` (to anyone, including themselves)?
// Requires the requested role's rank <= the caller's own rank. This single
// rule implements two requirements at once:
//   - "who may grant owner specifically" -> only an owner (rank 3) can ever
//     satisfy requestedRank(3) <= callerRank, since admin's rank is 2.
//   - "nobody can raise their own role" -> when target === caller, this is
//     the check that blocks it; canActOnRole above is trivially true for
//     self (rank == rank) and does not gate self-promotion by itself.
// Lowering one's own role is NOT blocked by this function — a caller
// requesting a role at or below their own rank always passes.
//
// ⚠️ CALLER MUST VALIDATE `requestedRole` FIRST — same caveat as
// canActOnRole above, mirrored: an unrecognised requestedRole ranks
// -Infinity, so canGrantRole(anyRealRole, 'garbage') is always true. Both
// call sites in this PR (routes/members.js PATCH, routes/invitations.js
// POST) already run `VALID_ROLES.includes(role)` and 400 before ever
// calling canGrantRole, so a garbage string never reaches it in practice.
// Any new caller must keep that ordering (validate against the real role
// enum, THEN call canGrantRole) rather than relying on this function to
// reject nonsense roles — it does not.
function canGrantRole(callerRole, requestedRole) {
  return roleRank(requestedRole) <= roleRank(callerRole);
}

// Express middleware factory: 403s unless req.user.role is in allowedRoles.
//
// opts.allowSelfTargetParam: if set (e.g. 'userId'), a request whose
// req.params[that name] equals the caller's own req.user.userId bypasses
// the allowlist entirely and is passed through unconditionally. This is the
// ONLY carve-out and it exists for exactly one legitimate case: a member of
// ANY role may resign their own membership (DELETE /api/members/:userId on
// themselves) — that has been true since this route was written ("A user
// CAN revoke their own membership (resign)") and this gate must not break
// it. Do not add this option to a route where self-targeting should be
// blocked (e.g. PATCH, where self-targeting must still be rank-checked by
// canGrantRole to prevent self-promotion) — it is opt-in per call site for
// that reason.
//
// SUPERADMIN BYPASS SEAM — deliberately NOT implemented here.
// req.user.isSuperAdmin is populated by requireAuth (middleware/requireAuth.js)
// but is NOT consulted anywhere in this file. A separate workstream is
// designing a super-admin bypass; this guard must not structurally prevent
// wiring one in later (e.g. as the first line of the returned middleware:
// `if (req.user?.isSuperAdmin) return next();`, or a new `opts.bypassSuperAdmin`
// flag) — but this PR does not grant super-admins anything new. Do not add
// that line here without a separate, explicit decision.
function requireMembershipRole(allowedRoles, opts = {}) {
  const allowed = new Set(allowedRoles);
  const selfParam = opts.allowSelfTargetParam || null;

  return function requireMembershipRoleMiddleware(req, res, next) {
    if (selfParam) {
      const targetUserId = req.params && req.params[selfParam];
      const callerUserId = req.user && req.user.userId;
      if (targetUserId && callerUserId && String(targetUserId) === String(callerUserId)) {
        return next();
      }
    }

    const role = req.user && req.user.role;
    if (!role || !allowed.has(role)) {
      return res.status(403).json({
        error: `this action requires role: ${allowedRoles.join(' or ')}`,
        code:  'ROLE_FORBIDDEN'
      });
    }
    return next();
  };
}

module.exports = requireMembershipRole;
module.exports.ROLE_RANK = ROLE_RANK;
module.exports.roleRank = roleRank;
module.exports.canActOnRole = canActOnRole;
module.exports.canGrantRole = canGrantRole;
