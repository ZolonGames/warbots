const express = require('express');
const { db } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { generateMap } = require('../services/mapGenerator');

const router = express.Router();

// Import broadcast function (will be available after api.js initializes)
let broadcastToGame = null;
setTimeout(() => {
  broadcastToGame = require('./api').broadcastToGame;
}, 0);

// 15 preset empire colors
const EMPIRE_COLORS = [
  '#FF0000', // Red
  '#0000FF', // Blue
  '#008000', // Green
  '#FFFF00', // Yellow
  '#FFFFFF', // White
  '#808080', // Gray
  '#800080', // Purple
  '#FFA500', // Orange
  '#FFC0CB', // Pink
  '#00FFFF', // Cyan
  '#6DFD4C', // Lime
  '#FF0181', // Magenta
  '#900DFF', // Violet
  '#C00000', // Dark Red
  '#0000C0'  // Dark Blue
];

// All routes require authentication
router.use(requireAuth);

// Get all open games (waiting for players, excluding games user is already in)
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
        AND g.id NOT IN (SELECT game_id FROM game_players WHERE user_id = ?)
      ORDER BY g.created_at DESC
    `).all(req.user.id);

    res.json(games);
  } catch (error) {
    console.error('Failed to get games:', error);
    res.status(500).json({ error: 'Failed to get games' });
  }
});

// Get user's games (active, waiting, or finished)
router.get('/mine', (req, res) => {
  try {
    const games = db.prepare(`
      SELECT
        g.*,
        u.display_name as host_name,
        (SELECT COUNT(*) FROM game_players WHERE game_id = g.id) as player_count,
        (g.host_id = ?) as is_host,
        gp.empire_name,
        gp.empire_color,
        gp.credits,
        gp.id as player_id,
        gp.is_eliminated,
        (g.winner_id = gp.user_id) as is_victor,
        (SELECT COUNT(*) FROM planets WHERE game_id = g.id AND owner_id = gp.id) as planet_count,
        (SELECT COUNT(*) FROM mechs WHERE game_id = g.id AND owner_id = gp.id) as mech_count,
        (
          SELECT COALESCE(SUM(p.base_income + COALESCE(
            (SELECT COUNT(*) FROM buildings WHERE planet_id = p.id AND type = 'mining'), 0
          )), 0)
          FROM planets p WHERE p.game_id = g.id AND p.owner_id = gp.id
        ) as income
      FROM games g
      JOIN users u ON g.host_id = u.id
      JOIN game_players gp ON gp.game_id = g.id
      WHERE gp.user_id = ?
      ORDER BY
        CASE
          WHEN g.status = 'active' THEN 0
          WHEN g.status = 'waiting' THEN 1
          ELSE 2
        END,
        g.created_at DESC
    `).all(req.user.id, req.user.id);

    res.json(games);
  } catch (error) {
    console.error('Failed to get user games:', error);
    res.status(500).json({ error: 'Failed to get your games' });
  }
});

// Create a new game
router.post('/', (req, res) => {
  const { name, gridSize, maxPlayers, turnTimer, empireName, empireColor } = req.body;

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

  // Validate empire name
  if (!empireName || empireName.trim().length < 1 || empireName.trim().length > 30) {
    return res.status(400).json({ error: 'Empire name must be 1-30 characters' });
  }

  // Validate empire color
  if (!empireColor || !EMPIRE_COLORS.includes(empireColor)) {
    return res.status(400).json({ error: 'Invalid empire color' });
  }

  try {
    // Create the game
    const result = db.prepare(`
      INSERT INTO games (name, host_id, grid_size, max_players, turn_timer, status)
      VALUES (?, ?, ?, ?, ?, 'waiting')
    `).run(name, req.user.id, gridSize, maxPlayers, turnTimer);

    const gameId = Number(result.lastInsertRowid);

    // Add the host as player 1 with empire info
    db.prepare(`
      INSERT INTO game_players (game_id, user_id, player_number, credits, empire_name, empire_color)
      VALUES (?, ?, 1, 10, ?, ?)
    `).run(gameId, req.user.id, empireName.trim(), empireColor);

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    console.log('Created game with status:', game?.status);
    res.status(201).json(game);
  } catch (error) {
    console.error('Failed to create game:', error);
    res.status(500).json({ error: 'Failed to create game' });
  }
});

// Get available colors for a game
router.get('/:id/colors', (req, res) => {
  try {
    const gameId = parseInt(req.params.id);

    // Get colors already taken by players in this game
    const takenColors = db.prepare(`
      SELECT empire_color FROM game_players
      WHERE game_id = ? AND empire_color IS NOT NULL
    `).all(gameId).map(p => p.empire_color);

    // Filter out taken colors
    const availableColors = EMPIRE_COLORS.filter(c => !takenColors.includes(c));

    res.json({ colors: availableColors, allColors: EMPIRE_COLORS });
  } catch (error) {
    console.error('Failed to get available colors:', error);
    res.status(500).json({ error: 'Failed to get available colors' });
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
    const { empireName, empireColor } = req.body;
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    if (game.status !== 'waiting') {
      return res.status(400).json({ error: 'Game has already started' });
    }

    // Validate empire name
    if (!empireName || empireName.trim().length < 1 || empireName.trim().length > 30) {
      return res.status(400).json({ error: 'Empire name must be 1-30 characters' });
    }

    // Validate empire color
    if (!empireColor || !EMPIRE_COLORS.includes(empireColor)) {
      return res.status(400).json({ error: 'Invalid empire color' });
    }

    // Check if user is already in the game
    const existingPlayer = db.prepare(`
      SELECT * FROM game_players WHERE game_id = ? AND user_id = ?
    `).get(game.id, req.user.id);

    if (existingPlayer) {
      return res.status(400).json({ error: 'You are already in this game' });
    }

    // Check if color is already taken
    const colorTaken = db.prepare(`
      SELECT id FROM game_players WHERE game_id = ? AND empire_color = ?
    `).get(game.id, empireColor);

    if (colorTaken) {
      return res.status(400).json({ error: 'This color has already been taken by another player' });
    }

    // Get current player count
    const playerCount = db.prepare(`
      SELECT COUNT(*) as count FROM game_players WHERE game_id = ?
    `).get(game.id).count;

    if (playerCount >= game.max_players) {
      return res.status(400).json({ error: 'Game is full' });
    }

    // Add player with empire info
    const playerNumber = playerCount + 1;
    db.prepare(`
      INSERT INTO game_players (game_id, user_id, player_number, credits, empire_name, empire_color)
      VALUES (?, ?, ?, 10, ?, ?)
    `).run(game.id, req.user.id, playerNumber, empireName.trim(), empireColor);

    // Broadcast player joined event
    if (broadcastToGame) {
      broadcastToGame(game.id, { type: 'player_joined', playerNumber });
    }

    res.json({ success: true, playerNumber });
  } catch (error) {
    console.error('Failed to join game:', error);
    res.status(500).json({ error: 'Failed to join game' });
  }
});

// Update empire info (for color conflict resolution)
router.post('/:id/empire', (req, res) => {
  try {
    const gameId = parseInt(req.params.id);
    const { empireColor } = req.body;

    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    if (game.status !== 'waiting') {
      return res.status(400).json({ error: 'Cannot change empire after game has started' });
    }

    // Validate empire color
    if (!empireColor || !EMPIRE_COLORS.includes(empireColor)) {
      return res.status(400).json({ error: 'Invalid empire color' });
    }

    // Get player record
    const player = db.prepare(`
      SELECT * FROM game_players WHERE game_id = ? AND user_id = ?
    `).get(gameId, req.user.id);

    if (!player) {
      return res.status(403).json({ error: 'You are not in this game' });
    }

    // Check if color is already taken by someone else
    const colorTaken = db.prepare(`
      SELECT id FROM game_players WHERE game_id = ? AND empire_color = ? AND user_id != ?
    `).get(gameId, empireColor, req.user.id);

    if (colorTaken) {
      return res.status(400).json({ error: 'This color has already been taken by another player' });
    }

    // Update empire color
    db.prepare(`
      UPDATE game_players SET empire_color = ? WHERE id = ?
    `).run(empireColor, player.id);

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update empire:', error);
    res.status(500).json({ error: 'Failed to update empire' });
  }
});

// Check for duplicate colors in a game
router.get('/:id/color-conflicts', (req, res) => {
  try {
    const gameId = parseInt(req.params.id);

    // Find colors that are used by multiple players
    const conflicts = db.prepare(`
      SELECT empire_color, GROUP_CONCAT(user_id) as user_ids, COUNT(*) as count
      FROM game_players
      WHERE game_id = ? AND empire_color IS NOT NULL
      GROUP BY empire_color
      HAVING count > 1
    `).all(gameId);

    // For each conflict, find who joined most recently (highest id = most recent)
    const playersToChange = [];
    for (const conflict of conflicts) {
      const userIds = conflict.user_ids.split(',').map(id => parseInt(id));
      // Get all players with this color, ordered by id descending
      const players = db.prepare(`
        SELECT gp.id, gp.user_id, u.display_name
        FROM game_players gp
        JOIN users u ON gp.user_id = u.id
        WHERE gp.game_id = ? AND gp.empire_color = ?
        ORDER BY gp.id DESC
      `).all(gameId, conflict.empire_color);

      // All except the first one (oldest) need to change
      for (let i = 0; i < players.length - 1; i++) {
        playersToChange.push({
          odlplayerId: players[i].id,
          userId: players[i].user_id,
          displayName: players[i].display_name,
          conflictingColor: conflict.empire_color
        });
      }
    }

    res.json({ conflicts: playersToChange });
  } catch (error) {
    console.error('Failed to check color conflicts:', error);
    res.status(500).json({ error: 'Failed to check color conflicts' });
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

    // Check for duplicate colors
    const colorConflicts = db.prepare(`
      SELECT empire_color, COUNT(*) as count
      FROM game_players
      WHERE game_id = ? AND empire_color IS NOT NULL
      GROUP BY empire_color
      HAVING count > 1
    `).all(game.id);

    if (colorConflicts.length > 0) {
      return res.status(400).json({ error: 'Some players have duplicate colors. Please resolve before starting.' });
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

    // Broadcast game started event to all players
    if (broadcastToGame) {
      broadcastToGame(game.id, { type: 'game_started' });
    }

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
