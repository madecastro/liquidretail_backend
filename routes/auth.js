const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const router = express.Router();

const FRONTEND_URL = 'https://liquidretail.netlify.app';

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

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
    // Email is included so the frontend can store it for the
    // invite-acceptance flow (compares signed-in email against the
    // invite's email-bound recipient before showing accept).
    res.redirect(
      `${FRONTEND_URL}/#token=${token}` +
      `&user=${encodeURIComponent(req.user.name)}` +
      `&email=${encodeURIComponent(req.user.email)}`
    );
  }
);

router.get('/logout', (req, res) => {
  res.redirect(`${FRONTEND_URL}/login.html`);
});

module.exports = router;
