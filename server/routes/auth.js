const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { db } = require('../config/database');

const router = express.Router();

// Configure Google OAuth strategy (only if credentials are provided)
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.BASE_URL || 'http://localhost:3000'}/auth/google/callback`
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user exists
        let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);

        if (!user) {
          // Create new user
          const result = db.prepare(`
            INSERT INTO users (google_id, email, display_name)
            VALUES (?, ?, ?)
          `).run(profile.id, profile.emails[0].value, profile.displayName);

          user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
        }

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  ));
} else {
  console.warn('Google OAuth credentials not configured - authentication disabled');
}

// Serialize user to session
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// Deserialize user from session
passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, user || null);
  } catch (error) {
    done(error, null);
  }
});

// Start Google OAuth flow
router.get('/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.redirect('/?error=oauth_not_configured');
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

// Google OAuth callback
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    res.redirect('/lobby.html');
  }
);

// Get current user
router.get('/me', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      authenticated: true,
      user: {
        id: req.user.id,
        displayName: req.user.display_name,
        email: req.user.email
      }
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout
router.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.redirect('/');
  });
});

module.exports = router;
