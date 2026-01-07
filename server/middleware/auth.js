// Middleware to require authentication
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

// Middleware to optionally load user (doesn't require auth)
function loadUser(req, res, next) {
  // User is already loaded by passport if authenticated
  next();
}

module.exports = { requireAuth, loadUser };
