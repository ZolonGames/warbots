const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const {
  calculateVisibility,
  getVisiblePlanets,
  getVisibleMechs,
  calculateIncome,
  calculateIncomeBreakdown
} = require('../services/visibilityCalc');
const { setBroadcastFunction } = require('../services/aiTurnScheduler');

const router = express.Router();

// Public endpoint for AI name generation data (no auth required)
router.get('/ai/names', (req, res) => {
  try {
    const namesPath = path.join(__dirname, '../data/ai-names.json');
    const namesData = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
    res.json(namesData);
  } catch (error) {
    console.error('Failed to load AI names:', error);
    // Return fallback data if file fails to load
    res.json({
      prefixes: ['Cybernetic', 'Terran', 'Martian', 'Grey', 'Eternal'],
      suffixes: ['Collective', 'Alliance', 'Federation', 'Empire', 'Hive']
    });
  }
});

// All routes below require authentication
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

    // Check if player is in observer mode (eliminated or game finished)
    const isObserver = player.is_eliminated === 1 || game.status === 'finished';

    // Calculate visibility - observers see everything
    let visibleTiles;
    if (isObserver) {
      // Generate all tiles as visible for observers
      visibleTiles = new Set();
      for (let x = 0; x < game.grid_size; x++) {
        for (let y = 0; y < game.grid_size; y++) {
          visibleTiles.add(`${x},${y}`);
        }
      }
    } else {
      visibleTiles = calculateVisibility(gameId, player.id, game.grid_size);
    }

    // Get visible planets and mechs (observers see all)
    const planets = isObserver
      ? db.prepare(`
          SELECT p.*,
            (SELECT json_group_array(json_object('id', b.id, 'type', b.type, 'hp', b.hp, 'max_hp', CASE WHEN b.type = 'fortification' THEN 30 ELSE 10 END))
             FROM buildings b WHERE b.planet_id = p.id) as buildings_json
          FROM planets p WHERE p.game_id = ?
        `).all(gameId).map(p => ({
          ...p,
          buildings: JSON.parse(p.buildings_json || '[]').filter(b => b.id !== null)
        }))
      : getVisiblePlanets(gameId, player.id, visibleTiles);

    const mechs = isObserver
      ? db.prepare('SELECT * FROM mechs WHERE game_id = ?').all(gameId)
      : getVisibleMechs(gameId, player.id, visibleTiles);

    // Calculate income and breakdown
    const income = calculateIncome(gameId, player.id);
    const incomeBreakdown = calculateIncomeBreakdown(gameId, player.id);

    // Get all players for display (with empire info and stats)
    // Use LEFT JOIN to handle AI players (negative user_ids with no user record)
    // Include Pirates but mark them with is_pirates flag (for color lookups, excluded from Star Empires)
    const players = db.prepare(`
      SELECT gp.id, gp.player_number, gp.is_eliminated, gp.empire_name, gp.empire_color, gp.credits, gp.user_id,
             gp.is_ai, gp.has_submitted_turn,
             COALESCE(u.display_name, gp.empire_name) as display_name,
             (SELECT COUNT(*) FROM planets WHERE game_id = gp.game_id AND owner_id = gp.id) as planet_count,
             (SELECT COUNT(*) FROM mechs WHERE game_id = gp.game_id AND owner_id = gp.id) as mech_count,
             (SELECT COALESCE(SUM(p.base_income + COALESCE(
               (SELECT COUNT(*) FROM buildings WHERE planet_id = p.id AND type = 'mining'), 0
             )), 0) FROM planets p WHERE p.game_id = gp.game_id AND p.owner_id = gp.id) as income,
             CASE WHEN gp.empire_name = 'Pirates' THEN 1 ELSE 0 END as is_pirates
      FROM game_players gp
      LEFT JOIN users u ON gp.user_id = u.id
      WHERE gp.game_id = ?
      ORDER BY gp.player_number
    `).all(gameId);

    // Get all combat logs for the game (all turns), ordered by turn desc then id asc
    // For finished games or eliminated players, include current turn (they need to see what happened)
    // For active players, exclude current turn (not yet resolved)
    const includeCurrentTurn = game.status === 'finished' || player.is_eliminated === 1;
    const maxTurn = includeCurrentTurn ? game.current_turn + 1 : game.current_turn;
    const rawCombatLogs = db.prepare(`
      SELECT * FROM combat_logs
      WHERE game_id = ? AND turn_number < ?
      ORDER BY turn_number DESC, id ASC
    `).all(gameId, maxTurn);

    // Player-specific event types (only visible to that player, never to others)
    const playerOnlyEvents = ['turn_start', 'build_mech', 'build_building', 'income', 'maintenance', 'maintenance_failure', 'planet_lost', 'repair', 'defeat', 'victory', 'player_defeated', 'game_won'];

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

    // Get winner player id (game_players.id, not user_id)
    let winnerPlayerId = null;
    if (game.winner_id) {
      const winnerPlayer = db.prepare(`
        SELECT id FROM game_players WHERE game_id = ? AND user_id = ?
      `).get(gameId, game.winner_id);
      winnerPlayerId = winnerPlayer?.id || null;
    }

    res.json({
      gameId: game.id,
      name: game.name,
      gridSize: game.grid_size,
      currentTurn: game.current_turn,
      status: game.status,
      turnDeadline: game.turn_deadline,
      hostId: game.host_id,
      maxPlayers: game.max_players,
      winnerId: winnerPlayerId,
      playerId: player.id,
      playerNumber: player.player_number,
      userId: req.user.id,
      credits: player.credits,
      income,
      incomeBreakdown,
      hasSubmittedTurn: player.has_submitted_turn,
      isEliminated: player.is_eliminated === 1,
      isObserver,
      isVictor: game.status === 'finished' && game.winner_id === player.user_id,
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

// Set broadcast function for AI scheduler
setBroadcastFunction(broadcastToGame);

// Export for use in turn processor
module.exports = router;
module.exports.broadcastToGame = broadcastToGame;
