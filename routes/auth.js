const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const router = express.Router();

// Where to bounce the user after OAuth callbacks. Override via env
// to point at a dev / staging frontend; falls back to prod when
// unset so existing deploys behave unchanged.
const FRONTEND_URL  = process.env.FRONTEND_URL  || 'https://liquidretail.netlify.app';
// Allowlist of origins that can request a per-request redirect via
// ?redirect= on /auth/google. Cohabitation use-case: the new Chakra
// app on rsvite.netlify.app needs to receive the OAuth bounce on its
// own origin while the legacy app at liquidretail.netlify.app keeps
// working unchanged. Comma-separated list; falls back to FRONTEND_URL.
const FRONTEND_URLS = (process.env.FRONTEND_URLS || FRONTEND_URL)
  .split(',').map(s => s.trim()).filter(Boolean);

// Validate a candidate redirect URL against the allowlist by ORIGIN
// (scheme + host + port). Returns the bare origin when valid, null
// otherwise. Path/query are stripped — we always bounce to the root.
function validateRedirect(candidate) {
  if (!candidate) return null;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  for (const allowed of FRONTEND_URLS) {
    try {
      if (new URL(allowed).origin === url.origin) return url.origin;
    } catch {}
  }
  return null;
}

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
