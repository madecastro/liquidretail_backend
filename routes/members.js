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
router.patch('/:userId', express.json(), async (req, res) => {
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
// membership (resign).
router.delete('/:userId', async (req, res) => {
  try {
    const target = await AdvertiserMembership.findOne({
      advertiserId: req.advertiserId,
      userId:       req.params.userId,
      status:       'active'
    });
    if (!target) return res.status(404).json({ error: 'member not found' });

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
