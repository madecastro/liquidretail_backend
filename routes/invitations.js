// Invitation routes — invite teammates to the current Advertiser
// and accept invitations from elsewhere.
//
// Mounted in two places by index.js:
//   - /api/invitations (under requireAuth)        — manage your own
//   - /api/invitations/public (no auth)           — preview by token
//
// The accept flow is mounted under /api/invitations as well, but
// uses requireUserOnly internally (the accepter must be logged in
// but may not yet have an active membership).

const express = require('express');
const router  = express.Router();

const Advertiser = require('../models/Advertiser');
const User       = require('../models/User');
const AdvertiserMembership = require('../models/AdvertiserMembership');
const { generateInviteToken } = require('../models/AdvertiserMembership');
const requireUserOnly = require('../middleware/requireUserOnly');

const VALID_ROLES = ['admin', 'editor', 'viewer'];   // owner can't be invited; only first user gets owner

// ──────────────────────────────────────────────────────────────
//  Authenticated routes (mounted under requireAuth in index.js)
// ──────────────────────────────────────────────────────────────

// POST /api/invitations
// Body: { email: string, role?: 'admin'|'editor'|'viewer' }
// Creates a pending membership row + returns the invite URL the
// caller can copy/email to the invitee.
router.post('/', express.json(), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role  = String(req.body?.role || 'editor').toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'valid email required' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${VALID_ROLES.join(', ')}` });
    }

    // If this email already has an ACTIVE membership for this
    // advertiser, refuse to send a duplicate invite.
    const existingActive = await AdvertiserMembership.findOne({
      advertiserId: req.advertiserId,
      email,
      status: 'active'
    }).lean();
    if (existingActive) {
      return res.status(409).json({
        error: `${email} is already a member`,
        membership: { id: String(existingActive._id), role: existingActive.role }
      });
    }

    // If a pending invite already exists, return it (idempotent
    // resend — caller can re-copy the URL without spamming new rows).
    const existingPending = await AdvertiserMembership.findOne({
      advertiserId: req.advertiserId,
      email,
      status: 'pending'
    });
    if (existingPending) {
      return res.json({
        invitation: serializePending(existingPending, req)
      });
    }

    // Fresh invite. If the invitee has a User row already, bind
    // userId now so accept-flow can short-circuit.
    const existingUser = await User.findOne({ email }).select('_id').lean();
    const inv = await AdvertiserMembership.create({
      advertiserId: req.advertiserId,
      userId:       existingUser?._id || null,
      email,
      role,
      status:       'pending',
      inviteToken:  generateInviteToken(),
      invitedBy:    req.user.userId,
      invitedAt:    new Date()
    });

    res.status(201).json({ invitation: serializePending(inv, req) });
  } catch (err) {
    console.error('invitation create failed:', err);
    res.status(500).json({ error: err.message || 'invitation create failed' });
  }
});

// GET /api/invitations
// List pending invitations for the current Advertiser. Active
// memberships are surfaced via /api/members (different route).
router.get('/', async (req, res) => {
  try {
    const pending = await AdvertiserMembership.find({
      advertiserId: req.advertiserId,
      status:       'pending'
    }).sort({ invitedAt: -1 }).lean();
    res.json({ invitations: pending.map(p => serializePending(p, req)) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'invitation list failed' });
  }
});

// DELETE /api/invitations/:id
// Revoke a pending invite. Active memberships go through
// DELETE /api/members/:userId instead.
router.delete('/:id', async (req, res) => {
  try {
    const inv = await AdvertiserMembership.findOne({
      _id:          req.params.id,
      advertiserId: req.advertiserId,
      status:       'pending'
    });
    if (!inv) return res.status(404).json({ error: 'pending invitation not found' });
    inv.status = 'revoked';
    inv.revokedAt = new Date();
    inv.revokedBy = req.user.userId;
    await inv.save();
    res.json({ ok: true, id: String(inv._id) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'invitation revoke failed' });
  }
});

// ──────────────────────────────────────────────────────────────
//  Mixed-auth routes (mounted under /api/invitations as well in
//  index.js, but uses requireUserOnly so users without a
//  membership can still accept).
// ──────────────────────────────────────────────────────────────

// GET /api/invitations/by-token/:token (public — token IS the auth)
// Returns enough metadata for the invite-acceptance page to render
// "you've been invited to <Advertiser> as <role>". No PII beyond
// what the token-holder already implicitly knows.
router.get('/by-token/:token', async (req, res) => {
  try {
    const inv = await AdvertiserMembership.findOne({
      inviteToken: req.params.token,
      status:      'pending'
    }).lean();
    if (!inv) return res.status(404).json({ error: 'invitation not found or already accepted' });
    const advertiser = await Advertiser.findById(inv.advertiserId).select('name slug').lean();
    if (!advertiser) return res.status(404).json({ error: 'advertiser no longer exists' });
    let invitedByName = null;
    if (inv.invitedBy) {
      const inviter = await User.findById(inv.invitedBy).select('displayName email').lean();
      invitedByName = inviter?.displayName || inviter?.email || null;
    }
    res.json({
      invitation: {
        email:         inv.email,
        role:          inv.role,
        invitedAt:     inv.invitedAt,
        invitedByName,
        advertiser: {
          id:   String(advertiser._id),
          name: advertiser.name,
          slug: advertiser.slug
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'invitation preview failed' });
  }
});

// POST /api/invitations/by-token/:token/accept
// Auth-required (requireUserOnly — no advertiser context needed).
// Email-bound: only the invitee can accept. Flips status active,
// binds userId, stamps acceptedAt.
router.post('/by-token/:token/accept', requireUserOnly, async (req, res) => {
  try {
    const inv = await AdvertiserMembership.findOne({
      inviteToken: req.params.token,
      status:      'pending'
    });
    if (!inv) return res.status(404).json({ error: 'invitation not found or already accepted' });

    if (inv.email !== req.userDoc.email.toLowerCase()) {
      return res.status(403).json({
        error: `This invitation was sent to ${inv.email}; you are signed in as ${req.userDoc.email}`,
        code:  'INVITE_EMAIL_MISMATCH'
      });
    }

    inv.userId     = req.userDoc._id;
    inv.status     = 'active';
    inv.acceptedAt = new Date();
    await inv.save();

    // If the user had no advertiser previously (User.advertiserId
    // null), set this one as their default so requireAuth resolves
    // it on the next request without explicit X-Advertiser-Id.
    if (!req.userDoc.advertiserId) {
      req.userDoc.advertiserId = inv.advertiserId;
      await req.userDoc.save();
    }

    res.json({
      ok: true,
      advertiserId: String(inv.advertiserId),
      role: inv.role
    });
  } catch (err) {
    console.error('invitation accept failed:', err);
    res.status(500).json({ error: err.message || 'invitation accept failed' });
  }
});

function serializePending(inv, req) {
  // Frontend stitches this into the full URL itself (origin known
  // client-side). We expose the token so the inviter can copy.
  return {
    id:        String(inv._id),
    email:     inv.email,
    role:      inv.role,
    status:    inv.status,
    token:     inv.inviteToken,
    invitedAt: inv.invitedAt,
    invitedBy: inv.invitedBy ? String(inv.invitedBy) : null
  };
}

module.exports = router;
