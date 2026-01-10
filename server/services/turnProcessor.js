const { db } = require('../config/database');
const { resolveMultiCombat } = require('./combatResolver');
const { calculateIncome } = require('./visibilityCalc');
const { MECH_TYPES } = require('./mapGenerator');

// Import AI scheduler and broadcast function (will be used after turn processing)
let scheduleAITurns = null;
let broadcastToGame = null;
setTimeout(() => {
  scheduleAITurns = require('./aiTurnScheduler').scheduleAITurns;
  broadcastToGame = require('../routes/api').broadcastToGame;
}, 0);

// Building costs
const BUILDING_COSTS = {
  mining: 10,
  factory: 30,
  fortification: 25
};

// Mech maintenance costs per turn
const MAINTENANCE_COSTS = {
  light: 1,
  medium: 2,
  heavy: 3,
  assault: 4
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

  // Get all turn orders for this turn (submitted orders)
  const turnOrders = db.prepare(`
    SELECT * FROM turns WHERE game_id = ? AND turn_number = ?
  `).all(gameId, turnNumber);

  // Parse orders by player - first from submitted turns
  const ordersByPlayer = {};
  for (const turn of turnOrders) {
    ordersByPlayer[turn.player_id] = JSON.parse(turn.orders);
  }

  // For players who haven't submitted, use their pending orders
  for (const player of players) {
    if (!ordersByPlayer[player.id] && player.pending_orders) {
      try {
        const pendingOrders = JSON.parse(player.pending_orders);
        ordersByPlayer[player.id] = pendingOrders;
        console.log(`Using pending orders for player ${player.id} (not submitted)`);
      } catch (e) {
        console.warn(`Failed to parse pending orders for player ${player.id}:`, e);
      }
    }
  }

  // Clear pending orders for all players after collecting them
  db.prepare(`
    UPDATE game_players SET pending_orders = NULL WHERE game_id = ?
  `).run(gameId);

  // Log turn start for all players
  for (const player of players) {
    addEventLog(gameId, turnNumber, 'turn_start', player.id, { turn: turnNumber });
  }

  // 0. Reset negative credits to 0 (debt forgiveness to prevent unrecoverable situations)
  for (const player of players) {
    if (player.credits < 0) {
      db.prepare(`UPDATE game_players SET credits = 0 WHERE id = ?`).run(player.id);
      player.credits = 0; // Update local reference too
    }
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

  // 6. Apply maintenance costs and handle negative credits
  const playersWithNegativeCredits = applyMaintenance(gameId, turnNumber, players);

  // 7. Heal mechs on planets (with logging) - skip players with negative credits
  healMechs(gameId, turnNumber, playersWithNegativeCredits);

  // 8. Check for eliminated players
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

    // Schedule AI turns for the new turn
    if (scheduleAITurns) {
      setTimeout(() => {
        scheduleAITurns(gameId);
      }, 1000);
    }
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

      // Destroy ALL buildings on the captured planet
      db.prepare(`
        DELETE FROM buildings WHERE planet_id = ?
      `).run(planet.id);
    } else if (planet && fortification) {
      // Planet not captured - just update or remove fortification
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

  // Include capture info and final status in the detailed log
  const detailedLogData = {
    battles: result.battles,
    captureInfo: captureInfo,
    finalMechStatus: result.finalMechStatus,
    finalFortificationStatus: result.finalFortificationStatus
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
function addCaptureLog(gameId, turnNumber, x, y, newOwnerId, previousOwnerId, planetName) {
  const detailedLog = JSON.stringify({
    previousOwnerId: previousOwnerId,
    planetName: planetName
  });

  db.prepare(`
    INSERT INTO combat_logs (game_id, turn_number, x, y, log_type, participants, winner_id, attacker_id, defender_id, attacker_casualties, defender_casualties, detailed_log)
    VALUES (?, ?, ?, ?, 'capture', ?, ?, ?, ?, 0, 0, ?)
  `).run(gameId, turnNumber, x, y, JSON.stringify([newOwnerId]), newOwnerId, newOwnerId, previousOwnerId, detailedLog);
}

/**
 * Capture undefended planets (or planets defended only by fortifications)
 * When mechs occupy a planet with no opposing mechs, they may need to destroy fortifications first
 */
function capturePlanets(gameId) {
  const game = db.prepare('SELECT current_turn FROM games WHERE id = ?').get(gameId);
  const turnNumber = game.current_turn;

  // Get all planets in the game
  const planets = db.prepare('SELECT * FROM planets WHERE game_id = ?').all(gameId);

  for (const planet of planets) {
    // Get all mechs on this planet
    const mechsOnPlanet = db.prepare(`
      SELECT * FROM mechs WHERE game_id = ? AND x = ? AND y = ?
    `).all(gameId, planet.x, planet.y);

    // Get unique owners
    const ownerIds = [...new Set(mechsOnPlanet.map(m => m.owner_id))];

    // If there are mechs and they all belong to the same owner
    if (ownerIds.length === 1) {
      const newOwnerId = ownerIds[0];

      // If the owner is different from current planet owner, attempt capture
      if (newOwnerId !== planet.owner_id) {
        // Check if there's a fortification defending
        const fortification = db.prepare(`
          SELECT * FROM buildings WHERE planet_id = ? AND type = 'fortification'
        `).get(planet.id);

        if (fortification) {
          // Fortification defends! Must resolve combat first
          const forcesByOwner = {
            [newOwnerId]: { mechs: mechsOnPlanet }
          };

          // Resolve combat with just fortification defending (no mechs)
          const result = resolveMultiCombat(forcesByOwner, fortification, planet.owner_id);

          // Determine if planet was captured during battle
          const planetCaptured = result.finalOwner !== null && result.finalOwner !== planet.owner_id;
          const captureInfo = planetCaptured ? {
            planetId: planet.id,
            planetName: planet.name,
            previousOwner: planet.owner_id,
            newOwner: result.finalOwner
          } : null;

          // Store detailed battle log
          addBattleLog(gameId, turnNumber, planet.x, planet.y, result, captureInfo);

          // Remove all destroyed mechs at this tile
          db.prepare(`
            DELETE FROM mechs WHERE game_id = ? AND x = ? AND y = ?
          `).run(gameId, planet.x, planet.y);

          // Add back surviving mechs with updated HP
          const insertMech = db.prepare(`
            INSERT INTO mechs (game_id, owner_id, type, hp, max_hp, x, y, designation)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const mech of result.survivingMechs) {
            insertMech.run(gameId, mech.owner_id, mech.type, mech.hp, mech.max_hp, planet.x, planet.y, mech.designation);
          }

          // Update or remove fortification
          if (result.fortification && result.fortification.hp > 0) {
            db.prepare(`
              UPDATE buildings SET hp = ? WHERE id = ?
            `).run(result.fortification.hp, fortification.id);
          } else {
            db.prepare(`
              DELETE FROM buildings WHERE id = ?
            `).run(fortification.id);
          }

          // If attackers won, capture planet and destroy ALL buildings
          if (planetCaptured) {
            const previousOwnerId = planet.owner_id;

            db.prepare(`
              UPDATE planets SET owner_id = ? WHERE id = ?
            `).run(result.finalOwner, planet.id);

            // Destroy ALL buildings on the captured planet
            db.prepare(`
              DELETE FROM buildings WHERE planet_id = ?
            `).run(planet.id);

            // Log planet_lost for previous owner
            if (previousOwnerId) {
              addEventLog(gameId, turnNumber, 'planet_lost', previousOwnerId, {
                x: planet.x,
                y: planet.y,
                planetId: planet.id,
                planetName: planet.name,
                capturedBy: result.finalOwner
              });
            }

            console.log(`Planet at (${planet.x}, ${planet.y}) captured by player ${result.finalOwner} after destroying fortification`);
          }
        } else {
          // No fortification - peaceful capture
          const previousOwnerId = planet.owner_id;

          db.prepare(`
            UPDATE planets SET owner_id = ? WHERE id = ?
          `).run(newOwnerId, planet.id);

          // Destroy ALL buildings on the captured planet
          db.prepare(`
            DELETE FROM buildings WHERE planet_id = ?
          `).run(planet.id);

          addCaptureLog(gameId, turnNumber, planet.x, planet.y, newOwnerId, previousOwnerId, planet.name);

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
    }
    // If ownerIds.length === 0, no mechs present - keep current owner
    // If ownerIds.length > 1, multiple owners - contested, handled by combat
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
          `).run(planet.id, buildingType, buildingType === 'fortification' ? 30 : 0);
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
      console.log(`Deducting ${totalCost} credits from player ${player.id} (had ${player.credits})`);
      db.prepare(`
        UPDATE game_players SET credits = credits - ? WHERE id = ?
      `).run(totalCost, player.id);

      // Verify the deduction
      const updated = db.prepare('SELECT credits FROM game_players WHERE id = ?').get(player.id);
      console.log(`Player ${player.id} now has ${updated?.credits} credits`);
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
 * Apply maintenance costs and handle negative credits
 * Returns array of player IDs with negative credits (who won't get repairs)
 */
function applyMaintenance(gameId, turnNumber, players) {
  const playersWithNegativeCredits = new Set();

  for (const player of players) {
    // Get all mechs owned by this player
    const mechs = db.prepare(`
      SELECT * FROM mechs WHERE game_id = ? AND owner_id = ?
    `).all(gameId, player.id);

    // Calculate total maintenance cost
    let totalMaintenance = 0;
    const mechCounts = { light: 0, medium: 0, heavy: 0, assault: 0 };
    for (const mech of mechs) {
      totalMaintenance += MAINTENANCE_COSTS[mech.type] || 0;
      mechCounts[mech.type] = (mechCounts[mech.type] || 0) + 1;
    }

    if (totalMaintenance > 0) {
      // Deduct maintenance from credits
      db.prepare(`
        UPDATE game_players SET credits = credits - ? WHERE id = ?
      `).run(totalMaintenance, player.id);

      // Get updated credits to check if negative
      const updatedPlayer = db.prepare(`
        SELECT credits FROM game_players WHERE id = ?
      `).get(player.id);

      const isNegative = updatedPlayer.credits < 0;

      // Log maintenance event
      addEventLog(gameId, turnNumber, 'maintenance', player.id, {
        cost: totalMaintenance,
        mechCounts: mechCounts,
        creditsAfter: updatedPlayer.credits,
        isNegative: isNegative
      });

      if (isNegative) {
        playersWithNegativeCredits.add(player.id);

        // Damage all mechs by 1 HP due to maintenance failure
        const mechStatusReport = [];
        for (const mech of mechs) {
          const newHp = mech.hp - 1;
          const destroyed = newHp <= 0;

          mechStatusReport.push({
            mechId: mech.id,
            designation: mech.designation,
            mechType: mech.type,
            hpBefore: mech.hp,
            hpAfter: Math.max(0, newHp),
            maxHp: mech.max_hp,
            destroyed: destroyed
          });

          if (destroyed) {
            // Delete the mech
            db.prepare(`DELETE FROM mechs WHERE id = ?`).run(mech.id);
          } else {
            // Update HP
            db.prepare(`UPDATE mechs SET hp = ? WHERE id = ?`).run(newHp, mech.id);
          }
        }

        // Log maintenance failure event
        addEventLog(gameId, turnNumber, 'maintenance_failure', player.id, {
          mechStatusReport: mechStatusReport,
          creditsAfter: updatedPlayer.credits
        });
      }
    }
  }

  return playersWithNegativeCredits;
}

/**
 * Heal mechs and fortifications on planets and log repairs
 */
function healMechs(gameId, turnNumber, playersWithNegativeCredits = new Set()) {
  const FORT_MAX_HP = 30; // Must match combatResolver.js
  const FORT_REPAIR_RATE = 5;
  const MECH_REPAIR_RATE = 2;

  // Get all planets in the game
  const planets = db.prepare('SELECT * FROM planets WHERE game_id = ?').all(gameId);

  // Track repairs by player
  const repairsByPlayer = {};

  for (const planet of planets) {
    // Get damaged mechs at this planet before healing (excluding players with negative credits)
    const damagedMechs = db.prepare(`
      SELECT * FROM mechs
      WHERE game_id = ? AND x = ? AND y = ? AND hp < max_hp
    `).all(gameId, planet.x, planet.y);

    for (const mech of damagedMechs) {
      // Skip healing for players with negative credits
      if (playersWithNegativeCredits.has(mech.owner_id)) {
        continue;
      }

      const hpBefore = mech.hp;
      const hpAfter = Math.min(mech.hp + MECH_REPAIR_RATE, mech.max_hp);
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

        // Heal this specific mech
        db.prepare(`
          UPDATE mechs SET hp = ? WHERE id = ?
        `).run(hpAfter, mech.id);
      }
    }

    // Heal fortifications at this planet (if owned and owner doesn't have negative credits)
    if (planet.owner_id && !playersWithNegativeCredits.has(planet.owner_id)) {
      const fortification = db.prepare(`
        SELECT b.* FROM buildings b
        WHERE b.planet_id = ? AND b.type = 'fortification' AND b.hp < ?
      `).get(planet.id, FORT_MAX_HP);

      if (fortification) {
        const hpBefore = fortification.hp;
        const hpAfter = Math.min(fortification.hp + FORT_REPAIR_RATE, FORT_MAX_HP);
        const hpGained = hpAfter - hpBefore;

        if (hpGained > 0) {
          // Track fortification repair for the planet owner
          if (!repairsByPlayer[planet.owner_id]) {
            repairsByPlayer[planet.owner_id] = [];
          }
          repairsByPlayer[planet.owner_id].push({
            mechId: null,
            designation: 'Fortification',
            mechType: 'fortification',
            hpGained: hpGained,
            hpAfter: hpAfter,
            maxHp: FORT_MAX_HP,
            fullyRepaired: hpAfter === FORT_MAX_HP,
            x: planet.x,
            y: planet.y,
            planetName: planet.name
          });

          // Update the fortification HP
          db.prepare(`
            UPDATE buildings SET hp = ? WHERE id = ?
          `).run(hpAfter, fortification.id);
        }
      }
    }
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
  const game = db.prepare('SELECT current_turn FROM games WHERE id = ?').get(gameId);
  const turnNumber = game.current_turn;

  // Players with no planets and no mechs are eliminated
  // But players with mechs but no planets can respawn

  const players = db.prepare(`
    SELECT gp.*,
           (SELECT COUNT(*) FROM planets WHERE game_id = gp.game_id AND owner_id = gp.id) as planet_count,
           (SELECT COUNT(*) FROM mechs WHERE game_id = gp.game_id AND owner_id = gp.id) as mech_count
    FROM game_players gp
    WHERE gp.game_id = ? AND gp.is_eliminated = 0
  `).all(gameId);

  // Get all players for broadcasting defeat message
  const allPlayers = db.prepare(`
    SELECT id FROM game_players WHERE game_id = ?
  `).all(gameId);

  for (const player of players) {
    if (player.planet_count === 0 && player.mech_count === 0) {
      // Truly eliminated - no planets and no mechs
      db.prepare(`
        UPDATE game_players SET is_eliminated = 1 WHERE id = ?
      `).run(player.id);

      // Log defeat event for the eliminated player
      addEventLog(gameId, turnNumber, 'defeat', player.id, {
        empireColor: player.empire_color,
        empireName: player.empire_name
      });

      // Log defeat announcement for ALL players
      for (const p of allPlayers) {
        if (p.id !== player.id) {
          addEventLog(gameId, turnNumber, 'player_defeated', p.id, {
            defeatedPlayerId: player.id,
            defeatedEmpireName: player.empire_name,
            defeatedEmpireColor: player.empire_color
          });
        }
      }

      console.log(`Player ${player.id} (${player.empire_name}) has been eliminated`);
    }
    // If player has mechs but no planets, they can still respawn by capturing a planet
  }
}

/**
 * Check if game has a winner
 */
function checkWinCondition(gameId) {
  const game = db.prepare('SELECT current_turn FROM games WHERE id = ?').get(gameId);
  const turnNumber = game.current_turn;

  // Count remaining non-eliminated players (LEFT JOIN to handle AI players)
  const remainingPlayers = db.prepare(`
    SELECT gp.*, COALESCE(u.display_name, gp.empire_name) as display_name
    FROM game_players gp
    LEFT JOIN users u ON gp.user_id = u.id
    WHERE gp.game_id = ? AND gp.is_eliminated = 0
  `).all(gameId);

  if (remainingPlayers.length === 1) {
    const winner = remainingPlayers[0];

    // Log victory event for the winner
    addEventLog(gameId, turnNumber, 'victory', winner.id, {
      empireColor: winner.empire_color,
      empireName: winner.empire_name
    });

    // Log victory announcement for all defeated players (so they see it in observer mode)
    const defeatedPlayers = db.prepare(`
      SELECT id FROM game_players WHERE game_id = ? AND is_eliminated = 1
    `).all(gameId);

    for (const p of defeatedPlayers) {
      addEventLog(gameId, turnNumber, 'game_won', p.id, {
        winnerPlayerId: winner.id,
        winnerEmpireName: winner.empire_name,
        winnerEmpireColor: winner.empire_color
      });
    }

    return winner;
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

    // Broadcast turn resolved to all clients
    if (broadcastToGame) {
      // Get updated game to get new turn number
      const updatedGame = db.prepare('SELECT current_turn, status FROM games WHERE id = ?').get(game.id);
      if (updatedGame && updatedGame.status === 'active') {
        broadcastToGame(game.id, { type: 'turn_resolved', turn: updatedGame.current_turn });
      } else if (updatedGame && updatedGame.status === 'finished') {
        broadcastToGame(game.id, { type: 'game_finished' });
      }
    }
  }
}

module.exports = {
  processTurn,
  checkTurnTimers
};
