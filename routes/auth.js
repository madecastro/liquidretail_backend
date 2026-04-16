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
      { id: req.user.id, email: req.user.email, name: req.user.name, photo: req.user.photo },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.redirect(`${FRONTEND_URL}/#token=${token}&user=${encodeURIComponent(req.user.name)}`);
  }
);

router.get('/logout', (req, res) => {
  res.redirect(`${FRONTEND_URL}/login.html`);
});

module.exports = router;
