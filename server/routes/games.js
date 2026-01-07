const express = require('express');
const { db } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { generateMap } = require('../services/mapGenerator');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// Get all open games (waiting for players)
router.get('/', (req, res) => {
  try {
    const games = db.prepare(`
      SELECT
        g.*,
        u.display_name as host_name,
        (SELECT COUNT(*) FROM game_players WHERE game_id = g.id) as player_count
      FROM games g
      JOIN users u ON g.host_id = u.id
      WHERE g.status = 'waiting'
      ORDER BY g.created_at DESC
    `).all();

    res.json(games);
  } catch (error) {
    console.error('Failed to get games:', error);
    res.status(500).json({ error: 'Failed to get games' });
  }
});

// Get user's games (active or waiting)
router.get('/mine', (req, res) => {
  try {
    const games = db.prepare(`
      SELECT
        g.*,
        u.display_name as host_name,
        (SELECT COUNT(*) FROM game_players WHERE game_id = g.id) as player_count,
        (g.host_id = ?) as is_host
      FROM games g
      JOIN users u ON g.host_id = u.id
      JOIN game_players gp ON gp.game_id = g.id
      WHERE gp.user_id = ? AND g.status != 'finished'
      ORDER BY g.created_at DESC
    `).all(req.user.id, req.user.id);

    res.json(games);
  } catch (error) {
    console.error('Failed to get user games:', error);
    res.status(500).json({ error: 'Failed to get your games' });
  }
});

// Create a new game
router.post('/', (req, res) => {
  const { name, gridSize, maxPlayers, turnTimer } = req.body;

  // Validate input
  if (!name || name.length < 1 || name.length > 50) {
    return res.status(400).json({ error: 'Game name must be 1-50 characters' });
  }

  if (![25, 50, 100].includes(gridSize)) {
    return res.status(400).json({ error: 'Grid size must be 25, 50, or 100' });
  }

  if (maxPlayers < 2 || maxPlayers > 8) {
    return res.status(400).json({ error: 'Max players must be 2-8' });
  }

  if (turnTimer < 30 || turnTimer > 604800) { // 30 seconds to 1 week
    return res.status(400).json({ error: 'Turn timer must be 30 seconds to 1 week' });
  }

  try {
    // Create the game
    const result = db.prepare(`
      INSERT INTO games (name, host_id, grid_size, max_players, turn_timer)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, req.user.id, gridSize, maxPlayers, turnTimer);

    const gameId = result.lastInsertRowid;

    // Add the host as player 1
    db.prepare(`
      INSERT INTO game_players (game_id, user_id, player_number, credits)
      VALUES (?, ?, 1, 10)
    `).run(gameId, req.user.id);

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    res.status(201).json(game);
  } catch (error) {
    console.error('Failed to create game:', error);
    res.status(500).json({ error: 'Failed to create game' });
  }
});

// Get game details
router.get('/:id', (req, res) => {
  try {
    const game = db.prepare(`
      SELECT
        g.*,
        u.display_name as host_name
      FROM games g
      JOIN users u ON g.host_id = u.id
      WHERE g.id = ?
    `).get(req.params.id);

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Get players
    const players = db.prepare(`
      SELECT
        gp.*,
        u.display_name
      FROM game_players gp
      JOIN users u ON gp.user_id = u.id
      WHERE gp.game_id = ?
      ORDER BY gp.player_number
    `).all(req.params.id);

    res.json({ ...game, players });
  } catch (error) {
    console.error('Failed to get game:', error);
    res.status(500).json({ error: 'Failed to get game' });
  }
});

// Join a game
router.post('/:id/join', (req, res) => {
  try {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    if (game.status !== 'waiting') {
      return res.status(400).json({ error: 'Game has already started' });
    }

    // Check if user is already in the game
    const existingPlayer = db.prepare(`
      SELECT * FROM game_players WHERE game_id = ? AND user_id = ?
    `).get(game.id, req.user.id);

    if (existingPlayer) {
      return res.status(400).json({ error: 'You are already in this game' });
    }

    // Get current player count
    const playerCount = db.prepare(`
      SELECT COUNT(*) as count FROM game_players WHERE game_id = ?
    `).get(game.id).count;

    if (playerCount >= game.max_players) {
      return res.status(400).json({ error: 'Game is full' });
    }

    // Add player
    const playerNumber = playerCount + 1;
    db.prepare(`
      INSERT INTO game_players (game_id, user_id, player_number, credits)
      VALUES (?, ?, ?, 10)
    `).run(game.id, req.user.id, playerNumber);

    res.json({ success: true, playerNumber });
  } catch (error) {
    console.error('Failed to join game:', error);
    res.status(500).json({ error: 'Failed to join game' });
  }
});

// Start the game (host only)
router.post('/:id/start', (req, res) => {
  try {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    if (game.host_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can start the game' });
    }

    if (game.status !== 'waiting') {
      return res.status(400).json({ error: 'Game has already started' });
    }

    // Get players
    const players = db.prepare(`
      SELECT * FROM game_players WHERE game_id = ? ORDER BY player_number
    `).all(game.id);

    if (players.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 players to start' });
    }

    // Generate the map
    generateMap(game.id, game.grid_size, players);

    // Calculate turn deadline
    const turnDeadline = new Date(Date.now() + game.turn_timer * 1000).toISOString();

    // Update game status
    db.prepare(`
      UPDATE games
      SET status = 'active', current_turn = 1, turn_deadline = ?
      WHERE id = ?
    `).run(turnDeadline, game.id);

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to start game:', error);
    res.status(500).json({ error: 'Failed to start game' });
  }
});

// Delete a game (host only)
router.delete('/:id', (req, res) => {
  try {
    const gameId = parseInt(req.params.id);
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    if (game.host_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can delete the game' });
    }

    // Delete all associated data in the correct order (foreign key dependencies)
    // 1. Delete combat logs
    db.prepare('DELETE FROM combat_logs WHERE game_id = ?').run(gameId);

    // 2. Delete turns
    db.prepare('DELETE FROM turns WHERE game_id = ?').run(gameId);

    // 3. Delete mechs
    db.prepare('DELETE FROM mechs WHERE game_id = ?').run(gameId);

    // 4. Delete buildings (via planets)
    db.prepare(`
      DELETE FROM buildings WHERE planet_id IN (
        SELECT id FROM planets WHERE game_id = ?
      )
    `).run(gameId);

    // 5. Delete planets
    db.prepare('DELETE FROM planets WHERE game_id = ?').run(gameId);

    // 6. Delete game_players
    db.prepare('DELETE FROM game_players WHERE game_id = ?').run(gameId);

    // 7. Delete the game itself
    db.prepare('DELETE FROM games WHERE id = ?').run(gameId);

    console.log(`Game ${gameId} deleted by host ${req.user.id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete game:', error);
    res.status(500).json({ error: 'Failed to delete game' });
  }
});

module.exports = router;
