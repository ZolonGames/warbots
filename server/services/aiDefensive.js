const { db } = require('../config/database');
const { calculateVisibility, calculateIncome } = require('./visibilityCalc');
const aiLogger = require('./aiLogger');

// Building costs
const BUILDING_COSTS = {
  mining: 10,
  factory: 30,
  fortification: 25
};

// Mech costs
const MECH_COSTS = {
  light: 2,
  medium: 5,
  heavy: 12,
  assault: 20
};

// Constants for defensive AI
const MAX_SCOUTS = 5; // Limited scouts - focus on defense
const FACTORY_PER_PLANETS = 5; // Conservative factory building
const DEFENSE_RESERVE_CREDITS = 30; // Keep reserves for fortifications
const MIN_FORCE_TO_ATTACK = 6; // Only attack with significant force
const DEFENDER_RATIO = 0.6; // Keep 60% of combat mechs on defense

/**
 * Generate orders for defensive AI
 * @param {number} gameId - The game ID
 * @param {Object} aiPlayer - The AI player record
 * @returns {Object} Orders object with moves and builds arrays
 */
function generateDefensiveOrders(gameId, aiPlayer) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const playerId = aiPlayer.id;
  const gridSize = game.grid_size;

  // Get game state
  const gameState = getDefensiveGameState(gameId, playerId, gridSize);

  // Analyze the situation
  const analysis = analyzeDefensiveState(gameState, aiPlayer);

  // Log analysis
  logDefensiveAnalysis(aiPlayer.empire_name, analysis);

  const orders = {
    moves: [],
    builds: []
  };

  // Generate build orders - prioritize defense
  orders.builds = generateDefensiveBuilds(gameState, aiPlayer, analysis);

  // Log builds
  for (const build of orders.builds) {
    const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(build.planetId);
    if (build.type === 'mech') {
      aiLogger.logBuildMech(aiPlayer.empire_name, build.mechType, planet?.name || 'Unknown', planet?.x || 0, planet?.y || 0);
    } else {
      aiLogger.logBuildBuilding(aiPlayer.empire_name, build.buildingType, planet?.name || 'Unknown', planet?.x || 0, planet?.y || 0);
    }
  }

  // Generate move orders - defensive posture
  orders.moves = generateDefensiveMoves(gameState, aiPlayer, analysis);

  // Log moves
  for (const move of orders.moves) {
    const mech = db.prepare('SELECT * FROM mechs WHERE id = ?').get(move.mechId);
    if (mech) {
      aiLogger.logMove(aiPlayer.empire_name, mech.designation, mech.type, mech.x, mech.y, move.toX, move.toY);
    }
  }

  return orders;
}

/**
 * Get AI's view of the game state
 */
function getDefensiveGameState(gameId, playerId, gridSize) {
  const visibleTiles = calculateVisibility(gameId, playerId, gridSize);

  // Get owned planets with buildings
  const ownedPlanets = db.prepare(`
    SELECT p.* FROM planets p WHERE p.game_id = ? AND p.owner_id = ?
  `).all(gameId, playerId);

  for (const planet of ownedPlanets) {
    planet.buildings = db.prepare(`
      SELECT type, hp FROM buildings WHERE planet_id = ?
    `).all(planet.id);
  }

  // Get owned mechs
  const ownedMechs = db.prepare(`
    SELECT * FROM mechs WHERE game_id = ? AND owner_id = ?
  `).all(gameId, playerId);

  // Get visible neutral planets
  const visibleNeutralPlanets = db.prepare(`
    SELECT p.* FROM planets p WHERE p.game_id = ? AND p.owner_id IS NULL
  `).all(gameId).filter(p => visibleTiles.has(`${p.x},${p.y}`));

  // Get visible enemy planets
  const visibleEnemyPlanets = db.prepare(`
    SELECT p.* FROM planets p WHERE p.game_id = ? AND p.owner_id IS NOT NULL AND p.owner_id != ?
  `).all(gameId, playerId).filter(p => visibleTiles.has(`${p.x},${p.y}`));

  for (const planet of visibleEnemyPlanets) {
    planet.buildings = db.prepare(`
      SELECT type, hp FROM buildings WHERE planet_id = ?
    `).all(planet.id);
  }

  // Get visible enemy mechs
  const visibleEnemyMechs = db.prepare(`
    SELECT m.* FROM mechs m WHERE m.game_id = ? AND m.owner_id != ?
  `).all(gameId, playerId).filter(m => visibleTiles.has(`${m.x},${m.y}`));

  return {
    gameId,
    playerId,
    gridSize,
    visibleTiles,
    ownedPlanets,
    ownedMechs,
    visibleNeutralPlanets,
    visibleEnemyPlanets,
    visibleEnemyMechs
  };
}

/**
 * Analyze the game state for defensive AI
 */
function analyzeDefensiveState(gameState, aiPlayer) {
  const { ownedPlanets, ownedMechs, visibleEnemyPlanets, visibleEnemyMechs, visibleNeutralPlanets } = gameState;

  // Count mechs by type
  const scoutCount = ownedMechs.filter(m => m.type === 'light').length;
  const mediumCount = ownedMechs.filter(m => m.type === 'medium').length;
  const heavyCount = ownedMechs.filter(m => m.type === 'heavy').length;
  const assaultCount = ownedMechs.filter(m => m.type === 'assault').length;
  const combatMechCount = mediumCount + heavyCount + assaultCount;

  // Calculate income
  const income = calculateIncome(gameState.gameId, gameState.playerId) || 0;

  // Count buildings
  const factoryCount = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'factory')
  ).length;

  const fortifiedCount = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'fortification')
  ).length;

  // Planets needing buildings
  const planetsNeedingMining = ownedPlanets.filter(p =>
    !p.buildings || !p.buildings.some(b => b.type === 'mining')
  );

  const planetsNeedingFortification = ownedPlanets.filter(p =>
    !p.buildings || !p.buildings.some(b => b.type === 'fortification')
  );

  // Factories needed
  const factoriesNeeded = Math.ceil(ownedPlanets.length / FACTORY_PER_PLANETS);
  const needMoreFactories = factoryCount < factoriesNeeded;

  // Find undefended enemy planets (safe to capture)
  const undefendedEnemyPlanets = visibleEnemyPlanets.filter(p => {
    const mechsOnPlanet = visibleEnemyMechs.filter(m => m.x === p.x && m.y === p.y);
    return mechsOnPlanet.length === 0;
  });

  // Identify threatened planets (enemies within 4 tiles)
  const threatenedPlanets = ownedPlanets.filter(p => {
    return visibleEnemyMechs.some(m =>
      Math.abs(m.x - p.x) + Math.abs(m.y - p.y) <= 4
    );
  });

  // Planets without defenders
  const undefendedOwnPlanets = ownedPlanets.filter(p => {
    const mechsOnPlanet = ownedMechs.filter(m => m.x === p.x && m.y === p.y && m.type !== 'light');
    return mechsOnPlanet.length === 0;
  });

  // Calculate how many mechs to keep for defense
  const defendersNeeded = Math.ceil(combatMechCount * DEFENDER_RATIO);
  const attackersAvailable = combatMechCount - defendersNeeded;

  // Only attack with significant force advantage
  const canAttack = attackersAvailable >= MIN_FORCE_TO_ATTACK;

  return {
    scoutCount,
    mediumCount,
    heavyCount,
    assaultCount,
    combatMechCount,
    needMoreScouts: scoutCount < MAX_SCOUTS,
    income,
    credits: aiPlayer.credits,
    factoryCount,
    fortifiedCount,
    needMoreFactories,
    planetsNeedingMining,
    planetsNeedingFortification,
    ownedPlanetCount: ownedPlanets.length,
    undefendedEnemyPlanets,
    threatenedPlanets,
    undefendedOwnPlanets,
    defendersNeeded,
    attackersAvailable,
    canAttack,
    visibleEnemyCount: visibleEnemyMechs.length
  };
}

/**
 * Generate build orders for defensive AI - prioritize fortifications
 */
function generateDefensiveBuilds(gameState, aiPlayer, analysis) {
  const builds = [];
  let availableCredits = aiPlayer.credits;
  const { ownedPlanets } = gameState;

  // Always keep reserves for fortifications
  const reserveCredits = DEFENSE_RESERVE_CREDITS;

  // Get planets with factories
  const planetsWithFactory = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'factory')
  );
  const usedFactories = new Set();

  // Priority 1: Build fortifications on all planets (most important!)
  for (const planet of analysis.planetsNeedingFortification) {
    if (availableCredits < BUILDING_COSTS.fortification) break;

    // Prioritize threatened planets
    const isThreatened = analysis.threatenedPlanets.some(t => t.id === planet.id);
    if (isThreatened || analysis.planetsNeedingFortification.length <= 3) {
      builds.push({
        planetId: planet.id,
        type: 'building',
        buildingType: 'fortification'
      });
      availableCredits -= BUILDING_COSTS.fortification;
    }
  }

  // Priority 2: Build mining colonies
  for (const planet of analysis.planetsNeedingMining) {
    if (availableCredits - reserveCredits < BUILDING_COSTS.mining) break;

    builds.push({
      planetId: planet.id,
      type: 'building',
      buildingType: 'mining'
    });
    availableCredits -= BUILDING_COSTS.mining;
  }

  // Priority 3: Build factories if needed
  if (analysis.needMoreFactories && availableCredits - reserveCredits >= BUILDING_COSTS.factory) {
    const planetForFactory = ownedPlanets.find(p =>
      !p.buildings || !p.buildings.some(b => b.type === 'factory')
    );
    if (planetForFactory) {
      builds.push({
        planetId: planetForFactory.id,
        type: 'building',
        buildingType: 'factory'
      });
      availableCredits -= BUILDING_COSTS.factory;
    }
  }

  // Priority 4: Build scouts for exploration (limited)
  if (analysis.needMoreScouts && planetsWithFactory.length > 0) {
    for (const planet of planetsWithFactory) {
      if (analysis.scoutCount + builds.filter(b => b.mechType === 'light').length >= MAX_SCOUTS) break;
      if (usedFactories.has(planet.id)) continue;
      if (availableCredits - reserveCredits < MECH_COSTS.light) break;

      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'light'
      });
      availableCredits -= MECH_COSTS.light;
      usedFactories.add(planet.id);
    }
  }

  // Priority 5: Build combat mechs - prefer heavy for defense
  for (const planet of planetsWithFactory) {
    if (usedFactories.has(planet.id)) continue;
    if (availableCredits - reserveCredits < MECH_COSTS.medium) break;

    // Defensive composition: more heavy and assault for holding positions
    const currentHeavy = analysis.heavyCount + builds.filter(b => b.mechType === 'heavy').length;
    const currentAssault = analysis.assaultCount + builds.filter(b => b.mechType === 'assault').length;
    const totalDefensive = currentHeavy + currentAssault;

    // Build assault every 3rd defensive mech
    if (currentAssault < Math.floor(totalDefensive / 3) + 1 && availableCredits - reserveCredits >= MECH_COSTS.assault) {
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'assault'
      });
      availableCredits -= MECH_COSTS.assault;
      usedFactories.add(planet.id);
    } else if (availableCredits - reserveCredits >= MECH_COSTS.heavy) {
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'heavy'
      });
      availableCredits -= MECH_COSTS.heavy;
      usedFactories.add(planet.id);
    }
  }

  return builds;
}

/**
 * Generate move orders for defensive AI - keep mechs near planets
 */
function generateDefensiveMoves(gameState, aiPlayer, analysis) {
  const moves = [];
  const assignedMechs = new Set();
  const { gridSize, ownedPlanets, ownedMechs, visibleNeutralPlanets, visibleEnemyPlanets, visibleEnemyMechs, visibleTiles } = gameState;

  const scouts = ownedMechs.filter(m => m.type === 'light');
  const combatMechs = ownedMechs.filter(m => m.type !== 'light');

  // === SCOUT LOGIC ===
  // Scouts explore and claim neutral planets only
  const claimedTargets = new Set();

  for (const scout of scouts) {
    if (assignedMechs.has(scout.id)) continue;

    // Only go for neutral planets (safer)
    let bestTarget = null;
    let bestDist = Infinity;

    for (const planet of visibleNeutralPlanets) {
      if (claimedTargets.has(`${planet.x},${planet.y}`)) continue;

      const dist = Math.abs(scout.x - planet.x) + Math.abs(scout.y - planet.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestTarget = planet;
      }
    }

    if (bestTarget) {
      const move = moveToward(scout.x, scout.y, bestTarget.x, bestTarget.y, gridSize);
      if (move) {
        moves.push({ mechId: scout.id, toX: move.x, toY: move.y });
        assignedMechs.add(scout.id);
        claimedTargets.add(`${bestTarget.x},${bestTarget.y}`);
      }
    }
  }

  // Remaining scouts explore carefully
  for (const scout of scouts) {
    if (assignedMechs.has(scout.id)) continue;

    const exploreTarget = findSafeExploreTarget(scout, visibleTiles, gridSize, ownedMechs, ownedPlanets);
    if (exploreTarget) {
      const move = moveToward(scout.x, scout.y, exploreTarget.x, exploreTarget.y, gridSize);
      if (move) {
        moves.push({ mechId: scout.id, toX: move.x, toY: move.y });
        assignedMechs.add(scout.id);
      }
    }
  }

  // === COMBAT MECH LOGIC - DEFENSIVE POSTURE ===

  // First priority: Defend threatened planets
  for (const planet of analysis.threatenedPlanets) {
    const nearbyEnemies = visibleEnemyMechs.filter(m =>
      Math.abs(m.x - planet.x) + Math.abs(m.y - planet.y) <= 4
    );

    // Send mechs to intercept
    for (const enemy of nearbyEnemies) {
      const availableMechs = combatMechs.filter(m => !assignedMechs.has(m.id));
      if (availableMechs.length === 0) break;

      // Find closest combat mech
      const defender = availableMechs.sort((a, b) => {
        const distA = Math.abs(a.x - enemy.x) + Math.abs(a.y - enemy.y);
        const distB = Math.abs(b.x - enemy.x) + Math.abs(b.y - enemy.y);
        return distA - distB;
      })[0];

      if (defender) {
        const move = moveToward(defender.x, defender.y, enemy.x, enemy.y, gridSize);
        if (move) {
          moves.push({ mechId: defender.id, toX: move.x, toY: move.y });
          assignedMechs.add(defender.id);
        }
      }
    }
  }

  // Second priority: Station defenders on undefended planets
  for (const planet of analysis.undefendedOwnPlanets) {
    const availableMechs = combatMechs.filter(m => !assignedMechs.has(m.id));
    if (availableMechs.length === 0) break;

    // Find closest mech to station
    const defender = availableMechs.sort((a, b) => {
      const distA = Math.abs(a.x - planet.x) + Math.abs(a.y - planet.y);
      const distB = Math.abs(b.x - planet.x) + Math.abs(b.y - planet.y);
      return distA - distB;
    })[0];

    if (defender) {
      const dist = Math.abs(defender.x - planet.x) + Math.abs(defender.y - planet.y);
      if (dist > 0) {
        const move = moveToward(defender.x, defender.y, planet.x, planet.y, gridSize);
        if (move) {
          moves.push({ mechId: defender.id, toX: move.x, toY: move.y });
          assignedMechs.add(defender.id);
        }
      } else {
        assignedMechs.add(defender.id); // Already on planet
      }
    }
  }

  // Third priority: Attack only if we can (enough forces and targets)
  if (analysis.canAttack && analysis.undefendedEnemyPlanets.length > 0) {
    // Send attack force to undefended enemy planets only
    const attackers = combatMechs.filter(m => !assignedMechs.has(m.id));
    const attackForce = attackers.slice(0, Math.min(attackers.length, analysis.attackersAvailable));

    if (attackForce.length >= MIN_FORCE_TO_ATTACK) {
      const target = analysis.undefendedEnemyPlanets[0];

      for (const mech of attackForce) {
        const move = moveToward(mech.x, mech.y, target.x, target.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
        }
      }
    }
  }

  // Remaining combat mechs: stay near owned planets (patrol)
  for (const mech of combatMechs) {
    if (assignedMechs.has(mech.id)) continue;

    // Find nearest owned planet
    let nearestPlanet = null;
    let nearestDist = Infinity;

    for (const planet of ownedPlanets) {
      const dist = Math.abs(mech.x - planet.x) + Math.abs(mech.y - planet.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestPlanet = planet;
      }
    }

    // If more than 2 tiles away from a planet, move closer
    if (nearestPlanet && nearestDist > 2) {
      const move = moveToward(mech.x, mech.y, nearestPlanet.x, nearestPlanet.y, gridSize);
      if (move) {
        moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
        assignedMechs.add(mech.id);
      }
    }
  }

  return moves;
}

/**
 * Find a safe exploration target - stay near owned territory
 */
function findSafeExploreTarget(scout, visibleTiles, gridSize, allMechs, ownedPlanets) {
  const directions = [
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -1, dy: -1 },
    { dx: 1, dy: -1 },
    { dx: -1, dy: 1 },
    { dx: 1, dy: 1 }
  ];

  // Shuffle for variety
  for (let i = directions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [directions[i], directions[j]] = [directions[j], directions[i]];
  }

  let bestDir = null;
  let bestScore = -Infinity;

  for (const dir of directions) {
    let unexploredCount = 0;

    for (let dist = 1; dist <= 4; dist++) {
      const checkX = scout.x + dir.dx * dist;
      const checkY = scout.y + dir.dy * dist;

      if (checkX < 0 || checkX >= gridSize || checkY < 0 || checkY >= gridSize) break;

      if (!visibleTiles.has(`${checkX},${checkY}`)) {
        unexploredCount++;
      }
    }

    // Calculate distance to nearest owned planet (prefer staying close)
    const targetX = scout.x + dir.dx * 3;
    const targetY = scout.y + dir.dy * 3;
    let minPlanetDist = Infinity;
    for (const planet of ownedPlanets) {
      const dist = Math.abs(targetX - planet.x) + Math.abs(targetY - planet.y);
      if (dist < minPlanetDist) minPlanetDist = dist;
    }

    // Check if another mech is at target
    const immediateTarget = { x: scout.x + dir.dx, y: scout.y + dir.dy };
    const mechAtTarget = allMechs.some(m =>
      m.id !== scout.id && m.x === immediateTarget.x && m.y === immediateTarget.y
    );

    if (!mechAtTarget) {
      // Score: unexplored is good, but penalize distance from planets
      const score = unexploredCount * 10 - minPlanetDist;
      if (score > bestScore) {
        bestScore = score;
        bestDir = dir;
      }
    }
  }

  if (bestDir) {
    return {
      x: Math.max(0, Math.min(gridSize - 1, scout.x + bestDir.dx * 3)),
      y: Math.max(0, Math.min(gridSize - 1, scout.y + bestDir.dy * 3))
    };
  }

  return null;
}

/**
 * Calculate move toward a target (one tile at a time)
 */
function moveToward(fromX, fromY, toX, toY, gridSize) {
  if (fromX === toX && fromY === toY) return null;

  let dx = Math.sign(toX - fromX);
  let dy = Math.sign(toY - fromY);

  let newX = fromX + dx;
  let newY = fromY + dy;

  if (newX < 0 || newX >= gridSize || newY < 0 || newY >= gridSize) {
    if (dx !== 0) {
      newX = fromX + dx;
      newY = fromY;
      if (newX >= 0 && newX < gridSize) {
        return { x: newX, y: newY };
      }
    }
    if (dy !== 0) {
      newX = fromX;
      newY = fromY + dy;
      if (newY >= 0 && newY < gridSize) {
        return { x: newX, y: newY };
      }
    }
    return null;
  }

  return { x: newX, y: newY };
}

/**
 * Log analysis for defensive AI
 */
function logDefensiveAnalysis(empireName, analysis) {
  aiLogger.log(`  ANALYSIS (Defensive): ${empireName}`);
  aiLogger.log(`    - Scouts: ${analysis.scoutCount}/${MAX_SCOUTS}`);
  aiLogger.log(`    - Combat Mechs: ${analysis.combatMechCount} (${analysis.heavyCount}H/${analysis.assaultCount}A)`);
  aiLogger.log(`    - Fortified: ${analysis.fortifiedCount}/${analysis.ownedPlanetCount} planets`);
  aiLogger.log(`    - Defenders Needed: ${analysis.defendersNeeded}, Attackers Available: ${analysis.attackersAvailable}`);
  aiLogger.log(`    - Can Attack: ${analysis.canAttack ? 'YES' : 'No (need ' + MIN_FORCE_TO_ATTACK + ')'}`);
  aiLogger.log(`    - Threatened Planets: ${analysis.threatenedPlanets.length}`);
  aiLogger.log(`    - Credits: ${analysis.credits} (reserve: ${DEFENSE_RESERVE_CREDITS})`);
}

module.exports = {
  generateDefensiveOrders
};
