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
    const [advertiser, brands] = await Promise.all([
      Advertiser.findById(req.advertiserId).lean(),
      Brand.find({ advertiserId: req.advertiserId })
        .select('name nameNormalized logoUrl websiteUrl source enrichmentSources curatedFields')
        .sort({ name: 1 })
        .lean()
    ]);

    res.json({
      user: {
        userId: req.user.userId,
        email:  req.user.email,
        name:   req.user.name,
        photo:  req.user.photo,
        role:   req.user.role
      },
      advertiser: advertiser ? {
        id:    String(advertiser._id),
        name:  advertiser.name,
        slug:  advertiser.slug,
        plan:  advertiser.plan,
        status: advertiser.status
      } : null,
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

module.exports = router;
