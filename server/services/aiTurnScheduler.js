const { db } = require('../config/database');
const { generateAIOrders } = require('./aiDecision');
const { processTurn } = require('./turnProcessor');

// Store scheduled AI turns to prevent duplicates
const scheduledAITurns = new Map(); // gameId -> Set of aiPlayerIds

// AI turn delay in milliseconds (20 seconds)
const AI_TURN_DELAY = 20000;

// Get broadcast function (will be set after api.js loads)
let broadcastToGame = null;
function setBroadcastFunction(fn) {
  broadcastToGame = fn;
}

/**
 * Schedule AI turns for all AI players in a game
 * @param {number} gameId - The game ID
 */
function scheduleAITurns(gameId) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game || game.status !== 'active') {
    return;
  }

  // Get all non-eliminated AI players who haven't submitted their turn
  const aiPlayers = db.prepare(`
    SELECT * FROM game_players
    WHERE game_id = ? AND is_ai = 1 AND is_eliminated = 0 AND has_submitted_turn = 0
  `).all(gameId);

  if (aiPlayers.length === 0) {
    return;
  }

  // Initialize scheduled set for this game if needed
  if (!scheduledAITurns.has(gameId)) {
    scheduledAITurns.set(gameId, new Set());
  }
  const scheduledSet = scheduledAITurns.get(gameId);

  for (const aiPlayer of aiPlayers) {
    // Skip if already scheduled
    if (scheduledSet.has(aiPlayer.id)) {
      continue;
    }

    scheduledSet.add(aiPlayer.id);
    console.log(`Scheduling AI turn for player ${aiPlayer.id} (${aiPlayer.empire_name}) in game ${gameId} in ${AI_TURN_DELAY/1000}s`);

    // Schedule the turn submission
    setTimeout(() => {
      submitAITurn(gameId, aiPlayer.id);
      scheduledSet.delete(aiPlayer.id);
    }, AI_TURN_DELAY);
  }
}

/**
 * Submit turn for an AI player
 * @param {number} gameId - The game ID
 * @param {number} aiPlayerId - The AI player's game_players.id
 */
function submitAITurn(gameId, aiPlayerId) {
  try {
    // Re-fetch game and player to ensure they're still valid
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!game || game.status !== 'active') {
      console.log(`AI turn cancelled: game ${gameId} is no longer active`);
      return;
    }

    const aiPlayer = db.prepare('SELECT * FROM game_players WHERE id = ?').get(aiPlayerId);
    if (!aiPlayer || aiPlayer.is_eliminated || aiPlayer.has_submitted_turn) {
      console.log(`AI turn cancelled: player ${aiPlayerId} is eliminated or already submitted`);
      return;
    }

    // Generate AI orders
    console.log(`AI ${aiPlayer.empire_name} generating orders for turn ${game.current_turn}...`);
    const orders = generateAIOrders(gameId, aiPlayer);

    // Validate orders (simplified validation for AI)
    const validationResult = validateAIOrders(orders, aiPlayer, game);
    if (!validationResult.valid) {
      console.error(`AI orders validation failed: ${validationResult.error}`);
      // Submit empty orders if validation fails
      orders.moves = [];
      orders.builds = [];
    }

    // Save turn orders
    db.prepare(`
      INSERT INTO turns (game_id, player_id, turn_number, orders)
      VALUES (?, ?, ?, ?)
    `).run(gameId, aiPlayer.id, game.current_turn, JSON.stringify(orders));

    // Mark player as having submitted
    db.prepare(`
      UPDATE game_players SET has_submitted_turn = 1 WHERE id = ?
    `).run(aiPlayer.id);

    console.log(`AI ${aiPlayer.empire_name} submitted turn with ${orders.moves?.length || 0} moves and ${orders.builds?.length || 0} builds`);

    // Check if all players have submitted
    const pendingPlayers = db.prepare(`
      SELECT COUNT(*) as count
      FROM game_players
      WHERE game_id = ? AND is_eliminated = 0 AND has_submitted_turn = 0
    `).get(gameId).count;

    if (pendingPlayers === 0) {
      // All players submitted - process the turn
      console.log(`All players submitted for game ${gameId}, processing turn...`);
      processTurn(gameId);

      // Broadcast turn resolved
      if (broadcastToGame) {
        broadcastToGame(gameId, { type: 'turn_resolved', turn: game.current_turn + 1 });
      }

      // Schedule next AI turns after a small delay
      setTimeout(() => {
        scheduleAITurns(gameId);
      }, 1000);
    }
  } catch (error) {
    console.error(`Error submitting AI turn for player ${aiPlayerId}:`, error);
  }
}

/**
 * Validate AI orders (simplified validation)
 */
function validateAIOrders(orders, player, game) {
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
      return { valid: false, error: `Mech ${move.mechId} not found or not owned` };
    }

    // Check destination is adjacent
    const dx = Math.abs(move.toX - mech.x);
    const dy = Math.abs(move.toY - mech.y);
    if (dx > 1 || dy > 1) {
      return { valid: false, error: `Invalid move destination for mech ${move.mechId}` };
    }

    // Check destination is in bounds
    if (move.toX < 0 || move.toX >= game.grid_size || move.toY < 0 || move.toY >= game.grid_size) {
      return { valid: false, error: 'Move destination out of bounds' };
    }
  }

  // Calculate total build cost
  const COSTS = {
    mining: 10,
    factory: 30,
    fortification: 25,
    light: 2,
    medium: 5,
    heavy: 12,
    assault: 20
  };

  let totalCost = 0;
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
      return { valid: false, error: `Planet ${build.planetId} not found or not owned` };
    }

    if (build.type === 'mech') {
      // Check factory exists on planet
      const factory = db.prepare(`
        SELECT * FROM buildings WHERE planet_id = ? AND type = 'factory'
      `).get(build.planetId);

      if (!factory) {
        return { valid: false, error: 'Cannot build mechs without a factory' };
      }

      // Check one mech per factory per turn
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

      // Check if building already exists
      const existingBuilding = db.prepare(`
        SELECT * FROM buildings WHERE planet_id = ? AND type = ?
      `).get(build.planetId, buildingType);

      if (existingBuilding) {
        return { valid: false, error: `${buildingType} already exists on this planet` };
      }

      totalCost += COSTS[buildingType];
    }
  }

  // Check player has enough credits
  if (totalCost > 0 && totalCost > player.credits) {
    return { valid: false, error: `Insufficient credits (need ${totalCost}, have ${player.credits})` };
  }

  return { valid: true };
}

/**
 * Clear scheduled AI turns for a game (call when game ends)
 * @param {number} gameId - The game ID
 */
function clearScheduledAITurns(gameId) {
  scheduledAITurns.delete(gameId);
}

module.exports = {
  scheduleAITurns,
  clearScheduledAITurns,
  setBroadcastFunction
};
