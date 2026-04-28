// Auth middleware. Verifies the bearer JWT, then resolves the
// active Advertiser via the AdvertiserMembership join table.
//
// Active-Advertiser resolution:
//   1. If the request includes an X-Advertiser-Id header AND the
//      user has an active membership for that Advertiser, use it.
//   2. Else fall back to the user's first active membership (in
//      acceptedAt order — most-recently joined wins ties).
//   3. If the user has zero active memberships, 403 NO_ADVERTISER
//      so the frontend routes to onboarding.
//
// req.user.role reflects the role on the SELECTED membership, so
// permission checks downstream can branch on it (Phase 4.4 will
// add per-route role guards; for now every authenticated role
// retains current full access).
//
// Failure modes:
//   401 — missing/invalid/expired token, or user gone
//   403 NO_ADVERTISER — user has no active memberships yet
//   403 ADVERTISER_FORBIDDEN — explicit X-Advertiser-Id header
//        but user has no active membership there

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AdvertiserMembership = require('../models/AdvertiserMembership');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let payload;
  try {
    payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  let user = null;
  if (payload.userId) {
    user = await User.findById(payload.userId).lean();
  }
  if (!user && payload.id) {
    user = await User.findOne({ googleId: payload.id }).lean();
  }
  if (!user) {
    return res.status(401).json({ error: 'User not found — please sign in again' });
  }

  // Pull all active memberships for this user — used for both the
  // active-advertiser resolution AND so /api/me can surface the
  // workspace switcher options without a second query.
  let memberships = await AdvertiserMembership.find({
    userId: user._id,
    status: 'active'
  }).sort({ acceptedAt: -1 }).lean();

  // Self-heal: legacy users from Phase 1 have User.advertiserId set
  // but no AdvertiserMembership row (Phase 4 migration may not have
  // been run yet on this environment). Create the missing membership
  // on first authenticated request so the user can proceed without
  // a manual migration step. Idempotent — the (advertiserId, userId)
  // partial unique index catches any race.
  if (memberships.length === 0 && user.advertiserId) {
    try {
      await AdvertiserMembership.create({
        advertiserId: user.advertiserId,
        userId:       user._id,
        email:        user.email,
        role:         'owner',
        status:       'active',
        acceptedAt:   user.createdAt || new Date()
      });
      console.log(`✓ self-heal: created owner membership for ${user.email} → ${user.advertiserId}`);
    } catch (err) {
      // Race or duplicate — re-fetch and continue.
      console.warn(`· self-heal membership create soft-failed for ${user.email}: ${err.message}`);
    }
    memberships = await AdvertiserMembership.find({
      userId: user._id,
      status: 'active'
    }).sort({ acceptedAt: -1 }).lean();
  }

  if (memberships.length === 0) {
    return res.status(403).json({
      error: 'No advertiser context — complete onboarding to continue',
      code:  'NO_ADVERTISER'
    });
  }

  // Pick active membership: explicit header > first by recency.
  const requestedAdvertiserId = req.headers['x-advertiser-id'];
  let active = null;
  if (requestedAdvertiserId) {
    active = memberships.find(m => String(m.advertiserId) === String(requestedAdvertiserId));
    if (!active) {
      return res.status(403).json({
        error: 'You are not a member of the requested advertiser',
        code:  'ADVERTISER_FORBIDDEN'
      });
    }
  } else {
    active = memberships[0];
  }

  req.user = {
    id:           payload.id,
    userId:       String(user._id),
    email:        user.email,
    name:         user.displayName || payload.name,
    photo:        user.photoUrl || payload.photo,
    advertiserId: String(active.advertiserId),
    role:         active.role
  };
  req.advertiserId = String(active.advertiserId);
  req.membership   = active;
  // Memberships list available for /api/me without re-query.
  req.allMemberships = memberships;
  next();
}

module.exports = requireAuth;
