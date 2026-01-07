const { db } = require('../config/database');
const { resolveMultiCombat } = require('./combatResolver');
const { calculateIncome } = require('./visibilityCalc');
const { MECH_TYPES } = require('./mapGenerator');

// Building costs
const BUILDING_COSTS = {
  mining: 5,
  factory: 10,
  fortification: 8
};

/**
 * Add an event to the event log
 */
function addEventLog(gameId, turnNumber, logType, playerId, data = {}) {
  const participants = JSON.stringify(playerId ? [playerId] : []);
  const detailedLog = JSON.stringify(data);

  db.prepare(`
    INSERT INTO combat_logs (game_id, turn_number, x, y, log_type, participants, winner_id, attacker_id, defender_id, attacker_casualties, defender_casualties, detailed_log)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
  `).run(
    gameId,
    turnNumber,
    data.x || 0,
    data.y || 0,
    logType,
    participants,
    playerId,
    null,
    null,
    detailedLog
  );
}

/**
 * Generate the next designation for a mech type for a player
 * Format: "<Type>-XXXX" where XXXX starts at 0001 and increments
 * @param {number} gameId - The game ID
 * @param {number} ownerId - The player's game_players.id
 * @param {string} mechType - The mech type (light, medium, heavy, assault)
 * @returns {string} The next designation (e.g., "Light-0003")
 */
function generateMechDesignation(gameId, ownerId, mechType) {
  // Get the highest serial number for this type for this player
  const typePrefix = mechType.charAt(0).toUpperCase() + mechType.slice(1);
  const pattern = `${typePrefix}-%`;

  const result = db.prepare(`
    SELECT designation FROM mechs
    WHERE game_id = ? AND owner_id = ? AND designation LIKE ?
    ORDER BY designation DESC
    LIMIT 1
  `).get(gameId, ownerId, pattern);

  let nextNumber = 1;

  if (result && result.designation) {
    // Extract the number from the designation (e.g., "Light-0023" -> 23)
    const match = result.designation.match(/-(\d+)$/);
    if (match) {
      nextNumber = parseInt(match[1], 10) + 1;
    }
  }

  // Determine padding - minimum 4 digits, expand if needed
  const digits = Math.max(4, nextNumber.toString().length);
  const paddedNumber = nextNumber.toString().padStart(digits, '0');

  return `${typePrefix}-${paddedNumber}`;
}

/**
 * Process a complete turn for a game
 * @param {number} gameId - The game ID
 */
function processTurn(gameId) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game || game.status !== 'active') {
    throw new Error('Invalid game state');
  }

  console.log(`Processing turn ${game.current_turn} for game ${gameId}`);
  const turnNumber = game.current_turn;

  // Get all players
  const players = db.prepare(`
    SELECT * FROM game_players WHERE game_id = ? AND is_eliminated = 0
  `).all(gameId);

  // Get all turn orders for this turn
  const turnOrders = db.prepare(`
    SELECT * FROM turns WHERE game_id = ? AND turn_number = ?
  `).all(gameId, turnNumber);

  // Parse orders by player
  const ordersByPlayer = {};
  for (const turn of turnOrders) {
    ordersByPlayer[turn.player_id] = JSON.parse(turn.orders);
  }

  // Log turn start for all players
  for (const player of players) {
    addEventLog(gameId, turnNumber, 'turn_start', player.id, { turn: turnNumber });
  }

  // 1. Process movements (simultaneously)
  processMovements(gameId, ordersByPlayer);

  // 2. Detect and resolve combats
  resolveCombats(gameId);

  // 3. Capture undefended planets
  capturePlanets(gameId);

  // 4. Process builds (with logging)
  processBuilds(gameId, turnNumber, ordersByPlayer, players);

  // 5. Calculate and apply income (with logging)
  applyIncome(gameId, turnNumber, players);

  // 6. Heal mechs on planets (with logging)
  healMechs(gameId, turnNumber);

  // 7. Check for eliminated players
  checkEliminations(gameId);

  // 8. Check win condition
  const winner = checkWinCondition(gameId);

  // 9. Advance turn or end game
  if (winner) {
    db.prepare(`
      UPDATE games SET status = 'finished', winner_id = ? WHERE id = ?
    `).run(winner.user_id, gameId);
  } else {
    // Reset turn submission flags
    db.prepare(`
      UPDATE game_players SET has_submitted_turn = 0 WHERE game_id = ?
    `).run(gameId);

    // Advance turn counter and set new deadline
    const turnDeadline = new Date(Date.now() + game.turn_timer * 1000).toISOString();
    db.prepare(`
      UPDATE games SET current_turn = current_turn + 1, turn_deadline = ? WHERE id = ?
    `).run(turnDeadline, gameId);
  }

  console.log(`Turn ${game.current_turn} processed for game ${gameId}`);
}

/**
 * Process all movement orders
 */
function processMovements(gameId, ordersByPlayer) {
  for (const [playerId, orders] of Object.entries(ordersByPlayer)) {
    const moves = orders.moves || [];

    for (const move of moves) {
      // Verify mech still exists and belongs to player
      const mech = db.prepare(`
        SELECT * FROM mechs WHERE id = ? AND owner_id = ? AND game_id = ?
      `).get(move.mechId, playerId, gameId);

      if (!mech) continue;

      // Move the mech
      db.prepare(`
        UPDATE mechs SET x = ?, y = ? WHERE id = ?
      `).run(move.toX, move.toY, mech.id);
    }
  }
}

/**
 * Detect and resolve all combats
 */
function resolveCombats(gameId) {
  const game = db.prepare('SELECT current_turn FROM games WHERE id = ?').get(gameId);
  const turnNumber = game.current_turn;

  // Find all tiles with opposing forces
  const conflictTiles = db.prepare(`
    SELECT x, y, COUNT(DISTINCT owner_id) as owner_count
    FROM mechs
    WHERE game_id = ?
    GROUP BY x, y
    HAVING owner_count > 1
  `).all(gameId);

  for (const tile of conflictTiles) {
    // Get the planet at this location (if any)
    const planet = db.prepare(`
      SELECT * FROM planets WHERE game_id = ? AND x = ? AND y = ?
    `).get(gameId, tile.x, tile.y);

    // Get fortification if on a planet
    let fortification = null;
    if (planet) {
      fortification = db.prepare(`
        SELECT * FROM buildings WHERE planet_id = ? AND type = 'fortification'
      `).get(planet.id);
    }

    // Get all mechs at this tile
    const mechs = db.prepare(`
      SELECT * FROM mechs WHERE game_id = ? AND x = ? AND y = ?
    `).all(gameId, tile.x, tile.y);

    // Group mechs by owner
    const forcesByOwner = {};
    for (const mech of mechs) {
      if (!forcesByOwner[mech.owner_id]) {
        forcesByOwner[mech.owner_id] = { mechs: [] };
      }
      forcesByOwner[mech.owner_id].mechs.push(mech);
    }

    // Determine defender (owner of planet, or null if in space)
    const defenderId = planet?.owner_id || null;

    // Resolve combat
    const result = resolveMultiCombat(forcesByOwner, fortification, defenderId);

    // Determine if planet was captured during battle
    const planetCaptured = planet && result.finalOwner !== planet.owner_id;
    const captureInfo = planetCaptured ? {
      planetId: planet.id,
      planetName: planet.name,
      previousOwner: planet.owner_id,
      newOwner: result.finalOwner
    } : null;

    // Store detailed battle log
    addBattleLog(gameId, turnNumber, tile.x, tile.y, result, captureInfo);

    // Update database with results

    // Remove all destroyed mechs at this tile
    db.prepare(`
      DELETE FROM mechs WHERE game_id = ? AND x = ? AND y = ?
    `).run(gameId, tile.x, tile.y);

    // Add back surviving mechs with updated HP (preserving designation)
    const insertMech = db.prepare(`
      INSERT INTO mechs (game_id, owner_id, type, hp, max_hp, x, y, designation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const mech of result.survivingMechs) {
      insertMech.run(gameId, mech.owner_id, mech.type, mech.hp, mech.max_hp, tile.x, tile.y, mech.designation);
    }

    // Update planet ownership if changed
    if (planet && result.finalOwner !== planet.owner_id) {
      db.prepare(`
        UPDATE planets SET owner_id = ? WHERE id = ?
      `).run(result.finalOwner, planet.id);
    }

    // Update or remove fortification
    if (planet && fortification) {
      if (result.fortification && result.fortification.hp > 0) {
        db.prepare(`
          UPDATE buildings SET hp = ? WHERE id = ?
        `).run(result.fortification.hp, fortification.id);
      } else {
        db.prepare(`
          DELETE FROM buildings WHERE id = ?
        `).run(fortification.id);
      }
    }
  }
}

/**
 * Add a battle log entry with full details
 */
function addBattleLog(gameId, turnNumber, x, y, result, captureInfo = null) {
  const participants = JSON.stringify(result.participants);

  // Include capture info in the detailed log
  const detailedLogData = {
    battles: result.battles,
    captureInfo: captureInfo
  };
  const detailedLog = JSON.stringify(detailedLogData);

  // Find the actual battle with combat (has a real defender, not null)
  // On neutral planets, the first "battle" may be against empty space
  let battle = result.battles.find(b => b.defenderId != null) || result.battles[0];

  // Get attacker and defender - for 2-player battles, use participants if defender is null
  let attackerId = battle?.attackerId || null;
  let defenderId = battle?.defenderId || null;

  // If defender is still null but we have 2 participants, use the other participant
  if (defenderId == null && result.participants.length === 2) {
    defenderId = result.participants.find(id => id !== attackerId) || null;
  }

  // Use casualties from the actual battle
  const attackerCasualties = battle?.attackerCasualties || 0;
  const defenderCasualties = battle?.defenderCasualties || 0;

  db.prepare(`
    INSERT INTO combat_logs (game_id, turn_number, x, y, log_type, participants, winner_id, attacker_id, defender_id, attacker_casualties, defender_casualties, detailed_log)
    VALUES (?, ?, ?, ?, 'battle', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    gameId, turnNumber, x, y,
    participants,
    result.winnerId,
    attackerId,
    defenderId,
    attackerCasualties,
    defenderCasualties,
    detailedLog
  );
}

/**
 * Add a capture log entry (for peaceful captures)
 */
function addCaptureLog(gameId, turnNumber, x, y, newOwnerId) {
  db.prepare(`
    INSERT INTO combat_logs (game_id, turn_number, x, y, log_type, participants, winner_id, attacker_id, defender_id, attacker_casualties, defender_casualties, detailed_log)
    VALUES (?, ?, ?, ?, 'capture', ?, ?, ?, NULL, 0, 0, NULL)
  `).run(gameId, turnNumber, x, y, JSON.stringify([newOwnerId]), newOwnerId, newOwnerId);
}

/**
 * Capture undefended planets
 * When mechs occupy a planet with no opposing forces, they capture it
 */
function capturePlanets(gameId) {
  const game = db.prepare('SELECT current_turn FROM games WHERE id = ?').get(gameId);
  const turnNumber = game.current_turn;

  // Get all planets in the game
  const planets = db.prepare('SELECT * FROM planets WHERE game_id = ?').all(gameId);

  for (const planet of planets) {
    // Get all mechs on this planet
    const mechsOnPlanet = db.prepare(`
      SELECT DISTINCT owner_id FROM mechs WHERE game_id = ? AND x = ? AND y = ?
    `).all(gameId, planet.x, planet.y);

    // If there are mechs and they all belong to the same owner
    if (mechsOnPlanet.length === 1) {
      const newOwnerId = mechsOnPlanet[0].owner_id;

      // If the owner is different from current planet owner, capture it
      if (newOwnerId !== planet.owner_id) {
        const previousOwnerId = planet.owner_id;

        db.prepare(`
          UPDATE planets SET owner_id = ? WHERE id = ?
        `).run(newOwnerId, planet.id);

        addCaptureLog(gameId, turnNumber, planet.x, planet.y, newOwnerId);

        // Log planet_lost for previous owner (if there was one)
        if (previousOwnerId) {
          addEventLog(gameId, turnNumber, 'planet_lost', previousOwnerId, {
            x: planet.x,
            y: planet.y,
            planetId: planet.id,
            planetName: planet.name,
            capturedBy: newOwnerId
          });
        }

        console.log(`Planet at (${planet.x}, ${planet.y}) captured by player ${newOwnerId}`);
      }
    }
    // If mechsOnPlanet.length === 0, no mechs present - keep current owner
    // If mechsOnPlanet.length > 1, multiple owners - contested, handled by combat
  }
}

/**
 * Process all build orders
 */
function processBuilds(gameId, turnNumber, ordersByPlayer, players) {
  for (const player of players) {
    const orders = ordersByPlayer[player.id] || {};
    const builds = orders.builds || [];

    let totalCost = 0;

    for (const build of builds) {
      // Verify planet still belongs to player
      const planet = db.prepare(`
        SELECT * FROM planets WHERE id = ? AND owner_id = ?
      `).get(build.planetId, player.id);

      if (!planet) continue;

      if (build.type === 'mech') {
        // Check factory exists
        const factory = db.prepare(`
          SELECT * FROM buildings WHERE planet_id = ? AND type = 'factory'
        `).get(planet.id);

        if (!factory) continue;

        const mechType = build.mechType;
        const cost = MECH_TYPES[mechType]?.cost || 0;

        if (cost > 0 && player.credits - totalCost >= cost) {
          const designation = generateMechDesignation(gameId, player.id, mechType);
          db.prepare(`
            INSERT INTO mechs (game_id, owner_id, type, hp, max_hp, x, y, designation)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            gameId,
            player.id,
            mechType,
            MECH_TYPES[mechType].hp,
            MECH_TYPES[mechType].hp,
            planet.x,
            planet.y,
            designation
          );
          totalCost += cost;

          // Log mech build event
          addEventLog(gameId, turnNumber, 'build_mech', player.id, {
            x: planet.x,
            y: planet.y,
            planetId: planet.id,
            planetName: planet.name,
            mechType: mechType,
            designation: designation
          });
        }
      } else if (build.type === 'building') {
        const buildingType = build.buildingType;
        const cost = BUILDING_COSTS[buildingType] || 0;

        if (cost > 0 && player.credits - totalCost >= cost) {
          db.prepare(`
            INSERT INTO buildings (planet_id, type, hp)
            VALUES (?, ?, ?)
          `).run(planet.id, buildingType, buildingType === 'fortification' ? 10 : 0);
          totalCost += cost;

          // Log building build event
          addEventLog(gameId, turnNumber, 'build_building', player.id, {
            x: planet.x,
            y: planet.y,
            planetId: planet.id,
            planetName: planet.name,
            buildingType: buildingType
          });
        }
      }
    }

    // Deduct total cost from player
    if (totalCost > 0) {
      db.prepare(`
        UPDATE game_players SET credits = credits - ? WHERE id = ?
      `).run(totalCost, player.id);
    }
  }
}

/**
 * Apply income to all players
 */
function applyIncome(gameId, turnNumber, players) {
  for (const player of players) {
    const income = calculateIncome(gameId, player.id);

    db.prepare(`
      UPDATE game_players SET credits = credits + ? WHERE id = ?
    `).run(income, player.id);

    // Log income event
    if (income > 0) {
      addEventLog(gameId, turnNumber, 'income', player.id, {
        amount: income
      });
    }
  }
}

/**
 * Heal mechs on planets and log repairs
 */
function healMechs(gameId, turnNumber) {
  // Get all planets in the game
  const planets = db.prepare('SELECT * FROM planets WHERE game_id = ?').all(gameId);

  // Track repairs by player
  const repairsByPlayer = {};

  for (const planet of planets) {
    // Get damaged mechs at this planet before healing
    const damagedMechs = db.prepare(`
      SELECT * FROM mechs
      WHERE game_id = ? AND x = ? AND y = ? AND hp < max_hp
    `).all(gameId, planet.x, planet.y);

    for (const mech of damagedMechs) {
      const hpBefore = mech.hp;
      const hpAfter = Math.min(mech.hp + 2, mech.max_hp);
      const hpGained = hpAfter - hpBefore;

      if (hpGained > 0) {
        // Track this repair for the player
        if (!repairsByPlayer[mech.owner_id]) {
          repairsByPlayer[mech.owner_id] = [];
        }
        repairsByPlayer[mech.owner_id].push({
          mechId: mech.id,
          designation: mech.designation,
          mechType: mech.type,
          hpGained: hpGained,
          hpAfter: hpAfter,
          maxHp: mech.max_hp,
          fullyRepaired: hpAfter === mech.max_hp,
          x: planet.x,
          y: planet.y,
          planetName: planet.name
        });
      }
    }

    // Heal mechs at this planet by 2 HP (up to max)
    db.prepare(`
      UPDATE mechs
      SET hp = MIN(hp + 2, max_hp)
      WHERE game_id = ? AND x = ? AND y = ?
    `).run(gameId, planet.x, planet.y);
  }

  // Log repair events for each player
  for (const [playerId, repairs] of Object.entries(repairsByPlayer)) {
    if (repairs.length > 0) {
      addEventLog(gameId, turnNumber, 'repair', parseInt(playerId), {
        repairs: repairs
      });
    }
  }
}

/**
 * Check and mark eliminated players
 */
function checkEliminations(gameId) {
  // Players with no planets and no mechs are eliminated
  // But players with mechs but no planets can respawn

  const players = db.prepare(`
    SELECT gp.*,
           (SELECT COUNT(*) FROM planets WHERE game_id = gp.game_id AND owner_id = gp.id) as planet_count,
           (SELECT COUNT(*) FROM mechs WHERE game_id = gp.game_id AND owner_id = gp.id) as mech_count
    FROM game_players gp
    WHERE gp.game_id = ? AND gp.is_eliminated = 0
  `).all(gameId);

  for (const player of players) {
    if (player.planet_count === 0 && player.mech_count === 0) {
      // Truly eliminated - no planets and no mechs
      db.prepare(`
        UPDATE game_players SET is_eliminated = 1 WHERE id = ?
      `).run(player.id);
    }
    // If player has mechs but no planets, they can still respawn by capturing a planet
  }
}

/**
 * Check if game has a winner
 */
function checkWinCondition(gameId) {
  // Count remaining non-eliminated players
  const remainingPlayers = db.prepare(`
    SELECT gp.*, u.display_name
    FROM game_players gp
    JOIN users u ON gp.user_id = u.id
    WHERE gp.game_id = ? AND gp.is_eliminated = 0
  `).all(gameId);

  if (remainingPlayers.length === 1) {
    return remainingPlayers[0];
  }

  return null;
}

/**
 * Check if turn timer has expired and process if needed
 * Called by a timer/cron job
 */
function checkTurnTimers() {
  const now = new Date().toISOString();

  const expiredGames = db.prepare(`
    SELECT * FROM games
    WHERE status = 'active' AND turn_deadline <= ?
  `).all(now);

  for (const game of expiredGames) {
    console.log(`Turn timer expired for game ${game.id}, processing turn...`);
    processTurn(game.id);
  }
}

module.exports = {
  processTurn,
  checkTurnTimers
};
