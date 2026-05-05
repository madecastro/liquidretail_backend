const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { FRONTEND_URL, validateFrontendOrigin } = require('../services/frontendOriginValidator');

// Local alias kept for readability inside this file's flow.
const validateRedirect = validateFrontendOrigin;

// /auth/google — start OAuth. Optional ?redirect=<origin> tells the
// callback where to bounce (allowlist-validated). The validated URL
// is round-tripped through the OAuth `state` parameter so callback
// can read it without sessions.
router.get('/google', (req, res, next) => {
  const target = validateRedirect(req.query.redirect);
  const state = target
    ? Buffer.from(JSON.stringify({ r: target })).toString('base64url')
    : undefined;
  passport.authenticate('google', { scope: ['profile', 'email'], state })(req, res, next);
});

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: `${FRONTEND_URL}/login.html?error=1` }),
  (req, res) => {
    const token = jwt.sign(
      {
        id:     req.user.id,         // Google profile id (legacy, kept for compat)
        userId: req.user.userId,     // persisted User._id — requireAuth re-fetches for fresh advertiserId
        email:  req.user.email,
        name:   req.user.name,
        photo:  req.user.photo
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    // Decode the OAuth state to recover the originating frontend (set
    // by /auth/google when ?redirect= was supplied + allowlisted).
    // Falls back to the default FRONTEND_URL when state is absent or
    // tampered with.
    let target = FRONTEND_URL;
    try {
      const raw = req.query.state;
      if (raw) {
        const decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
        const validated = validateRedirect(decoded?.r);
        if (validated) target = validated;
      }
    } catch { /* keep FRONTEND_URL fallback */ }

    // Email is included so the frontend can store it for the
    // invite-acceptance flow (compares signed-in email against the
    // invite's email-bound recipient before showing accept).
    res.redirect(
      `${target}/#token=${token}` +
      `&user=${encodeURIComponent(req.user.name)}` +
      `&email=${encodeURIComponent(req.user.email)}`
    );
  }
);

router.get('/logout', (req, res) => {
  res.redirect(`${FRONTEND_URL}/login.html`);
});

module.exports = router;
