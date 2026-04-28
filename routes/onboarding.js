// Onboarding — first-time setup for users who hit 403 NO_ADVERTISER.
// Creates a brand-new Advertiser, attaches it to the requesting
// User, and (optionally) creates a starter Brand under it.
//
// All routes here use requireUserOnly (NOT requireAuth) since by
// definition these users don't yet have an advertiserId.

const express = require('express');
const router  = express.Router();

const Advertiser = require('../models/Advertiser');
const Brand      = require('../models/Brand');
const AdvertiserMembership = require('../models/AdvertiserMembership');
const requireUserOnly = require('../middleware/requireUserOnly');

// POST /api/onboarding/advertiser
// Body: { name: string, brandName?: string, brandWebsiteUrl?: string }
//
// Creates an Advertiser owned by the current user. If brandName is
// provided, also stubs out the user's first Brand under it so they
// land in a usable state with one click.
//
// Idempotent on the user: if they already have an advertiserId,
// returns 409 with the existing advertiser. Use POST /api/me to
// re-fetch state.
router.post('/advertiser', requireUserOnly, express.json(), async (req, res) => {
  try {
    if (req.userDoc.advertiserId) {
      const existing = await Advertiser.findById(req.userDoc.advertiserId).lean();
      return res.status(409).json({
        error: 'User already has an advertiser',
        advertiser: existing ? { id: String(existing._id), name: existing.name, slug: existing.slug } : null
      });
    }

    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });

    // Ensure unique slug — append a counter if the desired slug is
    // taken. Cheap enough to do in-line; no race protection because
    // collision on signup is extremely rare and the unique index
    // catches it as a fallback.
    let slug = Advertiser.slugify(name);
    let suffix = 0;
    while (await Advertiser.findOne({ slug }).lean()) {
      suffix += 1;
      slug = `${Advertiser.slugify(name)}-${suffix}`;
    }

    const advertiser = await Advertiser.create({
      name,
      slug,
      ownerEmail: req.userDoc.email,
      plan: 'free',
      status: 'active'
    });

    // Optional starter Brand. Lets the onboarding form become a
    // "create account + first brand" combo so the user lands ready
    // to upload media.
    let brand = null;
    const brandName = String(req.body?.brandName || '').trim();
    if (brandName) {
      const { normalizeBrandName } = Brand;
      brand = await Brand.create({
        advertiserId:    advertiser._id,
        name:            brandName,
        nameNormalized:  normalizeBrandName(brandName),
        websiteUrl:      req.body?.brandWebsiteUrl || null,
        source:          'stub',
        firstSeenMediaId: null
      });
    }

    // Attach the advertiser to the user's record (Phase 1 backward
    // compat — the field is still consulted in some legacy paths)
    // AND create the AdvertiserMembership row that requireAuth (Phase
    // 4) actually uses to resolve the active advertiser.
    req.userDoc.advertiserId = advertiser._id;
    await req.userDoc.save();
    await AdvertiserMembership.create({
      advertiserId: advertiser._id,
      userId:       req.userDoc._id,
      email:        req.userDoc.email,
      role:         'owner',
      status:       'active',
      acceptedAt:   new Date()
    });

    res.status(201).json({
      advertiser: {
        id:    String(advertiser._id),
        name:  advertiser.name,
        slug:  advertiser.slug,
        plan:  advertiser.plan,
        status: advertiser.status
      },
      brand: brand ? {
        id:        String(brand._id),
        name:      brand.name,
        slug:      brand.nameNormalized,
        websiteUrl: brand.websiteUrl
      } : null
    });
  } catch (err) {
    console.error('onboarding/advertiser failed:', err);
    res.status(500).json({ error: err.message || 'Onboarding failed' });
  }
});

module.exports = router;
