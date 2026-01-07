const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'warbots.sqlite');

let db = null;

async function initializeDatabase() {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Games table
  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host_id INTEGER NOT NULL,
      grid_size INTEGER NOT NULL CHECK (grid_size IN (25, 50, 100)),
      max_players INTEGER NOT NULL CHECK (max_players >= 2 AND max_players <= 8),
      turn_timer INTEGER NOT NULL,
      current_turn INTEGER DEFAULT 0,
      status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'finished')),
      turn_deadline DATETIME,
      winner_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (host_id) REFERENCES users(id),
      FOREIGN KEY (winner_id) REFERENCES users(id)
    )
  `);

  // Game players table
  db.run(`
    CREATE TABLE IF NOT EXISTS game_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      player_number INTEGER NOT NULL,
      credits INTEGER DEFAULT 10,
      is_eliminated INTEGER DEFAULT 0,
      has_submitted_turn INTEGER DEFAULT 0,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE (game_id, user_id),
      UNIQUE (game_id, player_number)
    )
  `);

  // Planets table
  db.run(`
    CREATE TABLE IF NOT EXISTS planets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      base_income INTEGER NOT NULL CHECK (base_income >= 1 AND base_income <= 5),
      owner_id INTEGER,
      is_homeworld INTEGER DEFAULT 0,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES game_players(id),
      UNIQUE (game_id, x, y)
    )
  `);

  // Buildings table
  db.run(`
    CREATE TABLE IF NOT EXISTS buildings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planet_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('mining', 'factory', 'fortification')),
      hp INTEGER DEFAULT 10,
      FOREIGN KEY (planet_id) REFERENCES planets(id) ON DELETE CASCADE
    )
  `);

  // Mechs table
  db.run(`
    CREATE TABLE IF NOT EXISTS mechs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('light', 'medium', 'heavy', 'assault')),
      hp INTEGER NOT NULL,
      max_hp INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES game_players(id)
    )
  `);

  // Turns table
  db.run(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      turn_number INTEGER NOT NULL,
      orders TEXT NOT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES game_players(id),
      UNIQUE (game_id, player_id, turn_number)
    )
  `);

  // Create indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_planets_game ON planets(game_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_mechs_game ON mechs(game_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_mechs_owner ON mechs(owner_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_buildings_planet ON buildings(planet_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_game ON turns(game_id, turn_number)');

  // Save to disk
  saveDatabase();

  console.log('Database initialized successfully');
}

// Save database to disk
function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

// Wrapper to provide better-sqlite3-like API
const dbWrapper = {
  prepare(sql) {
    return {
      run(...params) {
        db.run(sql, params);
        saveDatabase();
        return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] };
      },
      get(...params) {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return undefined;
      },
      all(...params) {
        const results = [];
        const stmt = db.prepare(sql);
        stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      }
    };
  },
  exec(sql) {
    db.run(sql);
    saveDatabase();
  },
  transaction(fn) {
    return () => {
      db.run('BEGIN TRANSACTION');
      try {
        fn();
        db.run('COMMIT');
        saveDatabase();
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    };
  }
};

module.exports = { db: dbWrapper, initializeDatabase };
