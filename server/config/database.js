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
      name TEXT,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES game_players(id),
      UNIQUE (game_id, x, y)
    )
  `);

  // Migration: Add name column to planets if it doesn't exist
  try {
    const planetTableInfo = db.exec("PRAGMA table_info(planets)");
    if (planetTableInfo.length > 0) {
      const columns = planetTableInfo[0].values.map(row => row[1]);
      if (!columns.includes('name')) {
        db.run('ALTER TABLE planets ADD COLUMN name TEXT');
        console.log('Added name column to planets table');
      }
    }
  } catch (e) {
    // Column might already exist or table doesn't exist yet
  }

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
      designation TEXT,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES game_players(id)
    )
  `);

  // Migration: Add designation column if it doesn't exist
  try {
    const mechTableInfo = db.exec("PRAGMA table_info(mechs)");
    if (mechTableInfo.length > 0) {
      const columns = mechTableInfo[0].values.map(row => row[1]);
      if (!columns.includes('designation')) {
        db.run('ALTER TABLE mechs ADD COLUMN designation TEXT');
        console.log('Added designation column to mechs table');
      }
    }
  } catch (e) {
    // Column might already exist or table doesn't exist yet
  }

  // Migration: Add empire_name and empire_color columns to game_players
  try {
    const gamePlayersInfo = db.exec("PRAGMA table_info(game_players)");
    if (gamePlayersInfo.length > 0) {
      const columns = gamePlayersInfo[0].values.map(row => row[1]);
      if (!columns.includes('empire_name')) {
        db.run('ALTER TABLE game_players ADD COLUMN empire_name TEXT');
        console.log('Added empire_name column to game_players table');
      }
      if (!columns.includes('empire_color')) {
        db.run('ALTER TABLE game_players ADD COLUMN empire_color TEXT');
        console.log('Added empire_color column to game_players table');
      }
    }
  } catch (e) {
    // Columns might already exist or table doesn't exist yet
  }

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

  // Combat logs table - stores full battle data
  // Drop old table if it exists with wrong schema and recreate
  try {
    // Check if table has the new schema by looking for participants column
    const tableInfo = db.exec("PRAGMA table_info(combat_logs)");
    if (tableInfo.length > 0) {
      const columns = tableInfo[0].values.map(row => row[1]);
      if (!columns.includes('participants')) {
        // Old schema - drop and recreate
        db.run('DROP TABLE IF EXISTS combat_logs');
        console.log('Dropped old combat_logs table to apply new schema');
      }
    }
  } catch (e) {
    // Table doesn't exist, which is fine
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS combat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      turn_number INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      log_type TEXT NOT NULL,
      participants TEXT NOT NULL,
      winner_id INTEGER,
      attacker_id INTEGER,
      defender_id INTEGER,
      attacker_casualties INTEGER DEFAULT 0,
      defender_casualties INTEGER DEFAULT 0,
      detailed_log TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Create indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_planets_game ON planets(game_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_mechs_game ON mechs(game_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_mechs_owner ON mechs(owner_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_buildings_planet ON buildings(planet_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_game ON turns(game_id, turn_number)');
  db.run('CREATE INDEX IF NOT EXISTS idx_combat_logs_game ON combat_logs(game_id, turn_number)');

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

// Helper to get last insert rowid
function getLastInsertRowid() {
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const result = stmt.getAsObject();
  stmt.free();
  return result.id;
}

// Wrapper to provide better-sqlite3-like API
const dbWrapper = {
  prepare(sql) {
    return {
      run(...params) {
        db.run(sql, params);
        const lastId = getLastInsertRowid();
        saveDatabase();
        return { lastInsertRowid: lastId };
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
    // Note: sql.js handles transactions differently than better-sqlite3
    // We avoid explicit transactions here as they can cause issues with sql.js
    // Instead, we just run the function and save after each operation
    return () => {
      try {
        fn();
        saveDatabase();
      } catch (error) {
        // sql.js auto-saves are handled per operation, so just re-throw
        throw error;
      }
    };
  }
};

module.exports = { db: dbWrapper, initializeDatabase };
