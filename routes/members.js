// Member-management routes for the current Advertiser. Mounted
// under requireAuth in index.js — every operation is implicitly
// scoped to req.advertiserId.
//
// Active members live in AdvertiserMembership (status='active');
// pending invites are managed via /api/invitations.

const express = require('express');
const router  = express.Router();

const User = require('../models/User');
const AdvertiserMembership = require('../models/AdvertiserMembership');
const requireMembershipRole = require('../middleware/requireMembershipRole');
const { canActOnRole, canGrantRole } = requireMembershipRole;

const VALID_ROLES = ['owner', 'admin', 'editor', 'viewer'];

// GET /api/members
// List active members of the current Advertiser. Hydrates each
// row with the user's display name + photo so the UI can render
// faces without a second fetch.
router.get('/', async (req, res) => {
  try {
    const memberships = await AdvertiserMembership.find({
      advertiserId: req.advertiserId,
      status:       'active'
    }).sort({ acceptedAt: 1 }).lean();

    const userIds = memberships.map(m => m.userId).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } })
      .select('email displayName photoUrl lastLoginAt')
      .lean();
    const userById = new Map(users.map(u => [String(u._id), u]));

    res.json({
      members: memberships.map(m => {
        const u = userById.get(String(m.userId));
        return {
          membershipId: String(m._id),
          userId:       String(m.userId),
          email:        m.email,
          name:         u?.displayName || m.email,
          photoUrl:     u?.photoUrl || null,
          role:         m.role,
          acceptedAt:   m.acceptedAt,
          lastLoginAt:  u?.lastLoginAt || null,
          isYou:        String(m.userId) === req.user.userId
        };
      })
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'member list failed' });
  }
});

// PATCH /api/members/:userId
// Body: { role: 'owner' | 'admin' | 'editor' | 'viewer' }
// Promote / demote a member. Refuses to demote the last owner —
// every Advertiser must have at least one owner.
//
// AUTHZ (caller-role gate, added — see middleware/requireMembershipRole.js
// for the full rationale): only owner/admin may call this route at all
// (no self-target carve-out here, unlike DELETE below — self-promotion
// must still be blocked, so a viewer/editor can never reach this handler
// even against their own userId). Two further checks inside the handler,
// once the target's CURRENT role is known:
//   - canActOnRole: caller may not touch a member whose current role
//     outranks the caller's own (an admin may not modify an owner).
//   - canGrantRole: caller may not GRANT a role that outranks their own
//     (blocks self-promotion, and blocks an admin from granting 'owner' —
//     escalation-laundering via a role change is the same hole as via an
//     invitation). Lowering one's own role is allowed by this check; the
//     last-owner guard below still protects against removing the only
//     owner.
router.patch('/:userId', requireMembershipRole(['owner', 'admin']), express.json(), async (req, res) => {
  try {
    const role = String(req.body?.role || '').toLowerCase();
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${VALID_ROLES.join(', ')}` });
    }

    const target = await AdvertiserMembership.findOne({
      advertiserId: req.advertiserId,
      userId:       req.params.userId,
      status:       'active'
    });
    if (!target) return res.status(404).json({ error: 'member not found' });

    if (!canActOnRole(req.user.role, target.role)) {
      return res.status(403).json({
        error: 'cannot modify a member with a higher role than your own',
        code:  'ROLE_FORBIDDEN'
      });
    }
    if (!canGrantRole(req.user.role, role)) {
      return res.status(403).json({
        error: `only a role at or below your own (${req.user.role}) can be granted`,
        code:  'ROLE_FORBIDDEN'
      });
    }

    // Last-owner guard: don't allow demoting the only owner.
    if (target.role === 'owner' && role !== 'owner') {
      const ownerCount = await AdvertiserMembership.countDocuments({
        advertiserId: req.advertiserId,
        status:       'active',
        role:         'owner'
      });
      if (ownerCount <= 1) {
        return res.status(409).json({
          error: 'cannot demote the only owner — promote someone else first',
          code:  'LAST_OWNER'
        });
      }
    }

    target.role = role;
    await target.save();
    res.json({ ok: true, membership: { id: String(target._id), role: target.role } });
  } catch (err) {
    res.status(500).json({ error: err.message || 'member role update failed' });
  }
});

// DELETE /api/members/:userId
// Revoke an active membership. Soft-deletes (status='revoked' +
// audit fields) rather than hard-deleting so we keep an audit
// trail. Last-owner guard applies. A user CAN revoke their own
// membership (resign) regardless of role — that legitimate case is why
// requireMembershipRole is called with allowSelfTargetParam: 'userId'
// below, so a viewer resigning is never blocked by the owner/admin gate.
//
// AUTHZ: a NON-self revoke requires owner/admin (route-level gate) AND
// canActOnRole — caller rank must be >= the target's CURRENT role, so an
// admin can never revoke an owner ("escalation-by-deletion"). Self-revoke
// bypasses both, by design.
router.delete('/:userId', requireMembershipRole(['owner', 'admin'], { allowSelfTargetParam: 'userId' }), async (req, res) => {
  try {
    const target = await AdvertiserMembership.findOne({
      advertiserId: req.advertiserId,
      userId:       req.params.userId,
      status:       'active'
    });
    if (!target) return res.status(404).json({ error: 'member not found' });

    const isSelf = String(target.userId) === String(req.user.userId);
    if (!isSelf && !canActOnRole(req.user.role, target.role)) {
      return res.status(403).json({
        error: 'cannot revoke a member with a higher role than your own',
        code:  'ROLE_FORBIDDEN'
      });
    }

    if (target.role === 'owner') {
      const ownerCount = await AdvertiserMembership.countDocuments({
        advertiserId: req.advertiserId,
        status:       'active',
        role:         'owner'
      });
      if (ownerCount <= 1) {
        return res.status(409).json({
          error: 'cannot remove the only owner — promote someone else to owner first',
          code:  'LAST_OWNER'
        });
      }
    }

    target.status    = 'revoked';
    target.revokedAt = new Date();
    target.revokedBy = req.user.userId;
    await target.save();
    res.json({ ok: true, id: String(target._id) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'member revoke failed' });
  }
});

module.exports = router;
