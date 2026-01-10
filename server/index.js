require('dotenv').config();

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const passport = require('passport');
const path = require('path');
const fs = require('fs');

// Ensure sessions directory exists
const sessionsDir = path.join(__dirname, '../data/sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const { initializeDatabase } = require('./config/database');
const authRoutes = require('./routes/auth');
const gamesRoutes = require('./routes/games');
const apiRoutes = require('./routes/api');
const turnsRoutes = require('./routes/turns');
const { checkTurnTimers } = require('./services/turnProcessor');
const { checkPendingAITurns } = require('./services/aiTurnScheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Start server after database is initialized
async function startServer() {
  // Initialize database
  await initializeDatabase();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Session configuration
  app.use(session({
    store: new FileStore({
      path: path.join(__dirname, '../data/sessions'),
      ttl: 7 * 24 * 60 * 60 // 7 days in seconds
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
  }));

  // Passport initialization
  app.use(passport.initialize());
  app.use(passport.session());

  // Static files
  app.use(express.static(path.join(__dirname, '../public')));
  app.use('/assets', express.static(path.join(__dirname, '../data/assets/icons')));

  // Routes
  app.use('/auth', authRoutes);
  app.use('/api/games', gamesRoutes);
  app.use('/api', apiRoutes);
  app.use('/api', turnsRoutes);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve index.html for root
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  // Start server
  app.listen(PORT, () => {
    console.log(`Warbots server running on http://localhost:${PORT}`);

    // Check turn timers every 30 seconds
    setInterval(checkTurnTimers, 30000);

    // Check for any AI turns that need to be submitted (recovery from restart)
    checkPendingAITurns();
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
