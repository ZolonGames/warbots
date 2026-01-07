const express = require('express');
const { db } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const {
  calculateVisibility,
  getVisiblePlanets,
  getVisibleMechs,
  calculateIncome
} = require('../services/visibilityCalc');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// Get game state for a player (with fog of war applied)
router.get('/games/:id/state', (req, res) => {
  try {
    const gameId = parseInt(req.params.id);

    // Get game details
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Get player's record in this game
    const player = db.prepare(`
      SELECT * FROM game_players WHERE game_id = ? AND user_id = ?
    `).get(gameId, req.user.id);

    if (!player) {
      return res.status(403).json({ error: 'You are not in this game' });
    }

    // Calculate visibility
    const visibleTiles = calculateVisibility(gameId, player.id, game.grid_size);

    // Get visible planets and mechs
    const planets = getVisiblePlanets(gameId, player.id, visibleTiles);
    const mechs = getVisibleMechs(gameId, player.id, visibleTiles);

    // Calculate income
    const income = calculateIncome(gameId, player.id);

    // Get all players for display
    const players = db.prepare(`
      SELECT gp.id, gp.player_number, gp.is_eliminated, u.display_name
      FROM game_players gp
      JOIN users u ON gp.user_id = u.id
      WHERE gp.game_id = ?
      ORDER BY gp.player_number
    `).all(gameId);

    res.json({
      gameId: game.id,
      name: game.name,
      gridSize: game.grid_size,
      currentTurn: game.current_turn,
      status: game.status,
      turnDeadline: game.turn_deadline,
      playerId: player.id,
      playerNumber: player.player_number,
      credits: player.credits,
      income,
      hasSubmittedTurn: player.has_submitted_turn,
      isEliminated: player.is_eliminated,
      players,
      planets,
      mechs,
      visibleTiles: Array.from(visibleTiles)
    });
  } catch (error) {
    console.error('Failed to get game state:', error);
    res.status(500).json({ error: 'Failed to get game state' });
  }
});

// SSE endpoint for real-time updates
const gameClients = new Map(); // gameId -> Set of response objects

router.get('/games/:id/events', (req, res) => {
  const gameId = parseInt(req.params.id);

  // Verify player is in game
  const player = db.prepare(`
    SELECT * FROM game_players WHERE game_id = ? AND user_id = ?
  `).get(gameId, req.user.id);

  if (!player) {
    return res.status(403).json({ error: 'You are not in this game' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Add this client to the game's client set
  if (!gameClients.has(gameId)) {
    gameClients.set(gameId, new Set());
  }
  gameClients.get(gameId).add(res);

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = gameClients.get(gameId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        gameClients.delete(gameId);
      }
    }
  });
});

// Broadcast to all clients in a game
function broadcastToGame(gameId, event) {
  const clients = gameClients.get(gameId);
  if (clients) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      client.write(data);
    }
  }
}

// Export for use in turn processor
module.exports = router;
module.exports.broadcastToGame = broadcastToGame;
