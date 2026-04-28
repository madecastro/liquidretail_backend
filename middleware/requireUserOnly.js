// Lighter-weight auth middleware: verifies the JWT and resolves the
// User doc, but does NOT require an advertiserId. Used only by the
// onboarding endpoint where the user is, by definition, in the act
// of getting their first Advertiser. Every other authenticated
// route should use middleware/requireAuth which DOES require an
// advertiser.

const jwt = require('jsonwebtoken');
const User = require('../models/User');

async function requireUserOnly(req, res, next) {
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
    user = await User.findById(payload.userId);
  }
  if (!user && payload.id) {
    user = await User.findOne({ googleId: payload.id });
  }
  if (!user) {
    return res.status(401).json({ error: 'User not found — please sign in again' });
  }

  req.user = {
    id:           payload.id,
    userId:       String(user._id),
    email:        user.email,
    name:         user.displayName || payload.name,
    photo:        user.photoUrl || payload.photo,
    advertiserId: user.advertiserId ? String(user.advertiserId) : null,
    role:         user.role
  };
  // Hand the live mongoose doc to the route so it can mutate + save.
  req.userDoc = user;
  next();
}

module.exports = requireUserOnly;
