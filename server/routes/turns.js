const express = require('express');
const { db } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { processTurn } = require('../services/turnProcessor');
const { broadcastToGame } = require('./api');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// Submit turn orders
router.post('/games/:id/turns', (req, res) => {
  try {
    const gameId = parseInt(req.params.id);
    const { orders } = req.body;

    // Validate orders structure
    if (!orders || typeof orders !== 'object') {
      return res.status(400).json({ error: 'Invalid orders format' });
    }

    // Get game
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    if (game.status !== 'active') {
      return res.status(400).json({ error: 'Game is not active' });
    }

    // Get player
    const player = db.prepare(`
      SELECT * FROM game_players WHERE game_id = ? AND user_id = ?
    `).get(gameId, req.user.id);

    if (!player) {
      return res.status(403).json({ error: 'You are not in this game' });
    }

    if (player.is_eliminated) {
      return res.status(400).json({ error: 'You have been eliminated' });
    }

    if (player.has_submitted_turn) {
      return res.status(400).json({ error: 'You have already submitted your turn' });
    }

    // Validate orders
    const validationResult = validateOrders(orders, player, game);
    if (!validationResult.valid) {
      return res.status(400).json({ error: validationResult.error });
    }

    // Save turn orders
    db.prepare(`
      INSERT INTO turns (game_id, player_id, turn_number, orders)
      VALUES (?, ?, ?, ?)
    `).run(gameId, player.id, game.current_turn, JSON.stringify(orders));

    // Mark player as having submitted
    db.prepare(`
      UPDATE game_players SET has_submitted_turn = 1 WHERE id = ?
    `).run(player.id);

    // Check if all players have submitted
    const pendingPlayers = db.prepare(`
      SELECT COUNT(*) as count
      FROM game_players
      WHERE game_id = ? AND is_eliminated = 0 AND has_submitted_turn = 0
    `).get(gameId).count;

    if (pendingPlayers === 0) {
      // All players submitted - process the turn
      processTurn(gameId);
      broadcastToGame(gameId, { type: 'turn_resolved', turn: game.current_turn + 1 });
    }

    res.json({ success: true, allSubmitted: pendingPlayers === 0 });
  } catch (error) {
    console.error('Failed to submit turn:', error);
    res.status(500).json({ error: 'Failed to submit turn' });
  }
});

// Get turn submission status
router.get('/games/:id/turns/status', (req, res) => {
  try {
    const gameId = parseInt(req.params.id);

    const players = db.prepare(`
      SELECT gp.player_number, gp.has_submitted_turn, gp.is_eliminated, u.display_name
      FROM game_players gp
      JOIN users u ON gp.user_id = u.id
      WHERE gp.game_id = ?
      ORDER BY gp.player_number
    `).all(gameId);

    res.json(players);
  } catch (error) {
    console.error('Failed to get turn status:', error);
    res.status(500).json({ error: 'Failed to get turn status' });
  }
});

// Validate orders
function validateOrders(orders, player, game) {
  const moves = orders.moves || [];
  const builds = orders.builds || [];

  // Validate moves
  for (const move of moves) {
    if (!move.mechId || move.toX === undefined || move.toY === undefined) {
      return { valid: false, error: 'Invalid move order format' };
    }

    // Check mech belongs to player
    const mech = db.prepare(`
      SELECT * FROM mechs WHERE id = ? AND owner_id = ?
    `).get(move.mechId, player.id);

    if (!mech) {
      return { valid: false, error: `Mech ${move.mechId} not found or not owned by you` };
    }

    // Check destination is adjacent (distance of 1)
    const dx = Math.abs(move.toX - mech.x);
    const dy = Math.abs(move.toY - mech.y);
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
      return { valid: false, error: `Invalid move destination for mech ${move.mechId}` };
    }

    // Check destination is in bounds
    if (move.toX < 0 || move.toX >= game.grid_size || move.toY < 0 || move.toY >= game.grid_size) {
      return { valid: false, error: 'Move destination out of bounds' };
    }
  }

  // Calculate total build cost
  let totalCost = 0;
  const COSTS = {
    mining: 10,
    factory: 30,
    fortification: 25,
    light: 2,
    medium: 5,
    heavy: 12,
    assault: 20
  };

  // Track planets that already have a mech order (1 mech per factory per turn)
  const planetsWithMechOrder = new Set();

  for (const build of builds) {
    if (!build.planetId || !build.type) {
      return { valid: false, error: 'Invalid build order format' };
    }

    // Check planet belongs to player
    const planet = db.prepare(`
      SELECT * FROM planets WHERE id = ? AND owner_id = ?
    `).get(build.planetId, player.id);

    if (!planet) {
      return { valid: false, error: `Planet ${build.planetId} not found or not owned by you` };
    }

    if (build.type === 'mech') {
      // Check factory exists on planet
      const factory = db.prepare(`
        SELECT * FROM buildings WHERE planet_id = ? AND type = 'factory'
      `).get(build.planetId);

      if (!factory) {
        return { valid: false, error: 'Cannot build mechs without a factory' };
      }

      // Check if this planet already has a mech order (1 mech per factory per turn)
      if (planetsWithMechOrder.has(build.planetId)) {
        return { valid: false, error: 'Each factory can only produce 1 mech per turn' };
      }
      planetsWithMechOrder.add(build.planetId);

      const mechType = build.mechType;
      if (!['light', 'medium', 'heavy', 'assault'].includes(mechType)) {
        return { valid: false, error: `Invalid mech type: ${mechType}` };
      }

      totalCost += COSTS[mechType];
    } else if (build.type === 'building') {
      const buildingType = build.buildingType;
      if (!['mining', 'factory', 'fortification'].includes(buildingType)) {
        return { valid: false, error: `Invalid building type: ${buildingType}` };
      }

      // Check if building already exists on this planet
      const existingBuilding = db.prepare(`
        SELECT * FROM buildings WHERE planet_id = ? AND type = ?
      `).get(build.planetId, buildingType);

      if (existingBuilding) {
        return { valid: false, error: `${buildingType} already exists on this planet` };
      }

      totalCost += COSTS[buildingType];
    } else {
      return { valid: false, error: `Invalid build type: ${build.type}` };
    }
  }

  // Check player has enough credits for build orders (only if there are builds)
  // Players with negative credits can still submit turns with no builds
  if (totalCost > 0 && totalCost > player.credits) {
    return { valid: false, error: `Insufficient credits (need ${totalCost}, have ${player.credits})` };
  }

  return { valid: true };
}

module.exports = router;
