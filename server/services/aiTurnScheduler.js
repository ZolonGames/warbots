const { db } = require('../config/database');
const { generateAIOrders } = require('./aiDecision');
const { processTurn } = require('./turnProcessor');
const aiLogger = require('./aiLogger');

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
  // Exclude Pirates (they don't move, just hold retired player assets)
  const aiPlayers = db.prepare(`
    SELECT * FROM game_players
    WHERE game_id = ? AND is_ai = 1 AND is_eliminated = 0 AND has_submitted_turn = 0
      AND empire_name != 'Pirates'
  `).all(gameId);

  if (aiPlayers.length === 0) {
    return;
  }

  // Log new turn start for AI players
  aiLogger.logTurnStart(gameId, game.current_turn);

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

    // Log AI processing start
    aiLogger.logAIProcessingStart(aiPlayer.empire_name, aiPlayerId, gameId);

    // Generate AI orders
    console.log(`AI ${aiPlayer.empire_name} generating orders for turn ${game.current_turn}...`);
    const orders = generateAIOrders(gameId, aiPlayer);

    // Filter out any invalid orders (keeps valid ones instead of rejecting all)
    const filteredOrders = filterValidAIOrders(orders, aiPlayer, game);
    orders.moves = filteredOrders.moves;
    orders.builds = filteredOrders.builds;

    if (filteredOrders.errors.length > 0) {
      for (const error of filteredOrders.errors) {
        console.warn(`AI order filtered: ${error}`);
        aiLogger.logError(aiPlayer.empire_name, error);
      }
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
    aiLogger.logTurnSubmit(aiPlayer.empire_name, orders.moves?.length || 0, orders.builds?.length || 0);

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
 * Filter AI orders - keeps valid orders, removes invalid ones
 * Returns filtered orders and list of errors for logging
 */
function filterValidAIOrders(orders, player, game) {
  const moves = orders.moves || [];
  const builds = orders.builds || [];
  const validMoves = [];
  const validBuilds = [];
  const errors = [];

  const COSTS = {
    mining: 10,
    factory: 30,
    fortification: 25,
    light: 2,
    medium: 5,
    heavy: 12,
    assault: 20
  };

  // Filter moves - keep only valid ones
  for (const move of moves) {
    if (!move.mechId || move.toX === undefined || move.toY === undefined) {
      errors.push('Invalid move order format');
      continue;
    }

    const mech = db.prepare(`
      SELECT * FROM mechs WHERE id = ? AND owner_id = ?
    `).get(move.mechId, player.id);

    if (!mech) {
      errors.push(`Mech ${move.mechId} not found or not owned`);
      continue;
    }

    const dx = Math.abs(move.toX - mech.x);
    const dy = Math.abs(move.toY - mech.y);
    if (dx > 1 || dy > 1) {
      errors.push(`Invalid move destination for mech ${move.mechId}`);
      continue;
    }

    if (move.toX < 0 || move.toX >= game.grid_size || move.toY < 0 || move.toY >= game.grid_size) {
      errors.push('Move destination out of bounds');
      continue;
    }

    validMoves.push(move);
  }

  // Filter builds - keep only valid ones within budget
  let totalCost = 0;
  const planetsWithMechOrder = new Set();

  for (const build of builds) {
    if (!build.planetId || !build.type) {
      errors.push('Invalid build order format');
      continue;
    }

    const planet = db.prepare(`
      SELECT * FROM planets WHERE id = ? AND owner_id = ?
    `).get(build.planetId, player.id);

    if (!planet) {
      errors.push(`Planet ${build.planetId} not found or not owned`);
      continue;
    }

    if (build.type === 'mech') {
      const factory = db.prepare(`
        SELECT * FROM buildings WHERE planet_id = ? AND type = 'factory'
      `).get(build.planetId);

      if (!factory) {
        errors.push('Cannot build mechs without a factory');
        continue;
      }

      if (planetsWithMechOrder.has(build.planetId)) {
        errors.push('Each factory can only produce 1 mech per turn');
        continue;
      }

      const mechType = build.mechType;
      if (!['light', 'medium', 'heavy', 'assault'].includes(mechType)) {
        errors.push(`Invalid mech type: ${mechType}`);
        continue;
      }

      const cost = COSTS[mechType];
      if (totalCost + cost > player.credits) {
        errors.push(`Insufficient credits for ${mechType} mech`);
        continue;
      }

      totalCost += cost;
      planetsWithMechOrder.add(build.planetId);
      validBuilds.push(build);

    } else if (build.type === 'building') {
      const buildingType = build.buildingType;
      if (!['mining', 'factory', 'fortification'].includes(buildingType)) {
        errors.push(`Invalid building type: ${buildingType}`);
        continue;
      }

      const existingBuilding = db.prepare(`
        SELECT * FROM buildings WHERE planet_id = ? AND type = ?
      `).get(build.planetId, buildingType);

      if (existingBuilding) {
        errors.push(`${buildingType} already exists on this planet`);
        continue;
      }

      const cost = COSTS[buildingType];
      if (totalCost + cost > player.credits) {
        errors.push(`Insufficient credits for ${buildingType}`);
        continue;
      }

      totalCost += cost;
      validBuilds.push(build);
    }
  }

  return { moves: validMoves, builds: validBuilds, errors };
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
