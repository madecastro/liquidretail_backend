// Self-context endpoints: who am I, what's my Advertiser, what
// Brands do I own, and onboarding for users who haven't been
// assigned an Advertiser yet (e.g. fresh signup post-Phase-1).

const express = require('express');
const router = express.Router();

const User       = require('../models/User');
const Advertiser = require('../models/Advertiser');
const Brand      = require('../models/Brand');

// GET /api/me
// Returns the current user, their Advertiser, and the Brands the
// Advertiser owns. Used by the frontend to populate the nav, drive
// the brand picker, and decide whether onboarding is required.
router.get('/', async (req, res) => {
  try {
    // Hydrate every Advertiser the user belongs to so the workspace
    // switcher can render names/slugs without an N+1 fetch.
    const allAdvertiserIds = (req.allMemberships || []).map(m => m.advertiserId);
    const [activeAdvertiser, brands, allAdvertisers] = await Promise.all([
      Advertiser.findById(req.advertiserId).lean(),
      Brand.find({ advertiserId: req.advertiserId })
        .select('name nameNormalized logoUrl websiteUrl source enrichmentSources curatedFields')
        .sort({ name: 1 })
        .lean(),
      Advertiser.find({ _id: { $in: allAdvertiserIds } }).select('name slug plan status').lean()
    ]);
    const advByid = new Map(allAdvertisers.map(a => [String(a._id), a]));

    res.json({
      user: {
        userId: req.user.userId,
        email:  req.user.email,
        name:   req.user.name,
        photo:  req.user.photo,
        role:   req.user.role
      },
      advertiser: activeAdvertiser ? {
        id:    String(activeAdvertiser._id),
        name:  activeAdvertiser.name,
        slug:  activeAdvertiser.slug,
        plan:  activeAdvertiser.plan,
        status: activeAdvertiser.status
      } : null,
      // Memberships drive the workspace switcher (Phase 4.3 UI).
      memberships: (req.allMemberships || []).map(m => {
        const a = advByid.get(String(m.advertiserId));
        return {
          advertiserId: String(m.advertiserId),
          name:         a?.name || '(deleted)',
          slug:         a?.slug || null,
          role:         m.role,
          isActive:     String(m.advertiserId) === req.advertiserId
        };
      }),
      brands: (brands || []).map(b => ({
        id:        String(b._id),
        name:      b.name,
        slug:      b.nameNormalized,
        logoUrl:   b.logoUrl || null,
        websiteUrl: b.websiteUrl || null,
        source:    b.source
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load /me' });
  }
});

// GET /api/me/deletion-preview
// Dry-run the account-deletion plan so the UI can show the user what
// will happen before they type their email to confirm. Returns
// canDelete=false when the user is the sole owner of any advertiser
// that has other active members — they have to promote a new owner
// or remove those members first.
router.get('/deletion-preview', async (req, res) => {
  try {
    const { planAccountDeletion } = require('../services/accountDeletionService');
    const plan = await planAccountDeletion(req.user.userId);
    res.json(plan);
  } catch (err) {
    console.error('account deletion preview failed:', err);
    res.status(500).json({ error: err.message || 'preview failed' });
  }
});

// DELETE /api/me
// Permanently delete the current user. Body must include
// { confirmEmail: <user's email> } as a type-to-confirm gate (the UI
// uses the same UX as the brand DangerZone).
//
// Cascades:
//   - Advertisers where the user is the sole member → full brand
//     cascade for every brand, then memberships, then the advertiser.
//   - Advertisers where other members exist → user's membership is
//     soft-revoked (preserves audit trail).
//   - The User row itself is hard-deleted.
//
// Sign-out is client-side (JWT in localStorage); the frontend clears
// auth and redirects after a 200.
router.delete('/', express.json(), async (req, res) => {
  try {
    const confirmEmail = String(req.body?.confirmEmail || '').trim().toLowerCase();
    const myEmail      = String(req.user.email || '').trim().toLowerCase();
    if (!confirmEmail || confirmEmail !== myEmail) {
      return res.status(400).json({
        error:    'confirmEmail must match your email exactly',
        expected: myEmail
      });
    }
    const { executeAccountDeletion } = require('../services/accountDeletionService');
    const result = await executeAccountDeletion(req.user.userId);
    res.json(result);
  } catch (err) {
    if (err.code === 'SOLE_OWNER_BLOCKED') {
      return res.status(409).json({
        error:    err.message,
        code:     err.code,
        blockers: err.blockers
      });
    }
    console.error('account delete failed:', err);
    res.status(500).json({ error: err.message || 'account delete failed' });
  }
});

module.exports = router;
