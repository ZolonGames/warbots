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

    // Get all players for display (with empire info)
    const players = db.prepare(`
      SELECT gp.id, gp.player_number, gp.is_eliminated, gp.empire_name, gp.empire_color, u.display_name
      FROM game_players gp
      JOIN users u ON gp.user_id = u.id
      WHERE gp.game_id = ?
      ORDER BY gp.player_number
    `).all(gameId);

    // Get all combat logs for the game (all turns), ordered by turn desc then id asc
    const rawCombatLogs = db.prepare(`
      SELECT * FROM combat_logs
      WHERE game_id = ? AND turn_number < ?
      ORDER BY turn_number DESC, id ASC
    `).all(gameId, game.current_turn);

    // Player-specific event types (only visible to that player, never to others)
    const playerOnlyEvents = ['turn_start', 'build_mech', 'build_building', 'income', 'planet_lost', 'repair'];

    // Filter and format combat logs based on visibility and participation
    const combatLogs = rawCombatLogs
      .filter(log => {
        const participants = JSON.parse(log.participants || '[]');
        const isParticipant = participants.includes(player.id);

        // Player-only events: only show to the player who owns them
        if (playerOnlyEvents.includes(log.log_type)) {
          return isParticipant;
        }

        // Battles: show if participant OR tile is visible
        // (participant always sees their battles, even if they lost visibility after losing)
        if (log.log_type === 'battle') {
          if (isParticipant) return true;
        }

        // Other events (captures) require visible tiles or participation
        const key = `${log.x},${log.y}`;
        return visibleTiles.has(key);
      })
      .map(log => {
        const participants = JSON.parse(log.participants || '[]');
        const isParticipant = participants.includes(player.id);

        // Parse detailed log if participant or if it's a player-only event
        let detailedLog = null;
        if ((isParticipant || playerOnlyEvents.includes(log.log_type)) && log.detailed_log) {
          detailedLog = JSON.parse(log.detailed_log);
        }

        return {
          id: log.id,
          turnNumber: log.turn_number,
          x: log.x,
          y: log.y,
          logType: log.log_type,
          participants,
          winnerId: log.winner_id,
          attackerId: log.attacker_id,
          defenderId: log.defender_id,
          attackerCasualties: log.attacker_casualties,
          defenderCasualties: log.defender_casualties,
          isParticipant,
          detailedLog
        };
      });

    res.json({
      gameId: game.id,
      name: game.name,
      gridSize: game.grid_size,
      currentTurn: game.current_turn,
      status: game.status,
      turnDeadline: game.turn_deadline,
      hostId: game.host_id,
      maxPlayers: game.max_players,
      playerId: player.id,
      playerNumber: player.player_number,
      userId: req.user.id,
      credits: player.credits,
      income,
      hasSubmittedTurn: player.has_submitted_turn,
      isEliminated: player.is_eliminated,
      players,
      planets,
      mechs,
      visibleTiles: Array.from(visibleTiles),
      combatLogs
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

// Rename a planet (must be owner)
router.post('/planets/:id/rename', (req, res) => {
  try {
    const planetId = parseInt(req.params.id);
    const { name } = req.body;

    // Validate name
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }

    if (trimmedName.length > 30) {
      return res.status(400).json({ error: 'Name cannot exceed 30 characters' });
    }

    // Get the planet
    const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(planetId);
    if (!planet) {
      return res.status(404).json({ error: 'Planet not found' });
    }

    // Get the player's record in this game
    const player = db.prepare(`
      SELECT * FROM game_players WHERE game_id = ? AND user_id = ?
    `).get(planet.game_id, req.user.id);

    if (!player) {
      return res.status(403).json({ error: 'You are not in this game' });
    }

    // Check ownership
    if (planet.owner_id !== player.id) {
      return res.status(403).json({ error: 'You do not own this planet' });
    }

    // Update the name
    db.prepare('UPDATE planets SET name = ? WHERE id = ?').run(trimmedName, planetId);

    res.json({ success: true, name: trimmedName });
  } catch (error) {
    console.error('Failed to rename planet:', error);
    res.status(500).json({ error: 'Failed to rename planet' });
  }
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
