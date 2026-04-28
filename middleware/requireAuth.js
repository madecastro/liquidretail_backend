// Auth middleware. Verifies the bearer JWT, then re-fetches the User
// doc from the DB so req.advertiserId is always fresh (catches
// changes from the backfill migration, future onboarding flows, or
// admin-driven Advertiser reassignments without forcing re-login).
//
// Failure modes:
//   401 — missing / invalid / expired token
//   401 — user no longer exists (deleted account)
//   403 — user exists but has no advertiserId yet (pre-backfill, or
//          new signup before onboarding). Frontend should route to
//          the onboarding / "create your advertiser" flow.

const jwt = require('jsonwebtoken');
const User = require('../models/User');

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

  // Locate the persisted User row. Prefer the new userId claim (issued
  // post-Phase-1); fall back to googleId for tokens that predate the
  // claim (24h TTL, so existing sessions naturally migrate within a day).
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
  if (!user.advertiserId) {
    return res.status(403).json({
      error: 'No advertiser context — complete onboarding to continue',
      code:  'NO_ADVERTISER'
    });
  }

  // req.user keeps the lightweight session shape downstream code
  // already expects + adds the persisted record fields.
  req.user = {
    id:           payload.id,
    userId:       String(user._id),
    email:        user.email,
    name:         user.displayName || payload.name,
    photo:        user.photoUrl || payload.photo,
    advertiserId: String(user.advertiserId),
    role:         user.role
  };
  req.advertiserId = String(user.advertiserId);
  next();
}

module.exports = requireAuth;
