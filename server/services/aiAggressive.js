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

// Constants for aggressive AI
const MAX_SCOUTS = 5; // Fewer scouts than expansionist - focus on combat
const FACTORY_PER_PLANETS = 3; // More factories for faster production
const ATTACK_GROUP_SIZE = 3; // Smaller attack groups, more of them

/**
 * Generate orders for aggressive AI
 * @param {number} gameId - The game ID
 * @param {Object} aiPlayer - The AI player record
 * @returns {Object} Orders object with moves and builds arrays
 */
function generateAggressiveOrders(gameId, aiPlayer) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const playerId = aiPlayer.id;
  const gridSize = game.grid_size;

  // Get game state
  const gameState = getAggressiveGameState(gameId, playerId, gridSize);

  // Analyze the situation
  const analysis = analyzeAggressiveState(gameState, aiPlayer);

  // Log analysis
  logAggressiveAnalysis(aiPlayer.empire_name, analysis);

  const orders = {
    moves: [],
    builds: []
  };

  // Generate build orders first
  orders.builds = generateAggressiveBuilds(gameState, aiPlayer, analysis);

  // Log builds
  for (const build of orders.builds) {
    const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(build.planetId);
    if (build.type === 'mech') {
      aiLogger.logBuildMech(aiPlayer.empire_name, build.mechType, planet?.name || 'Unknown', planet?.x || 0, planet?.y || 0);
    } else {
      aiLogger.logBuildBuilding(aiPlayer.empire_name, build.buildingType, planet?.name || 'Unknown', planet?.x || 0, planet?.y || 0);
    }
  }

  // Generate move orders
  orders.moves = generateAggressiveMoves(gameState, aiPlayer, analysis);

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
function getAggressiveGameState(gameId, playerId, gridSize) {
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

  for (const planet of visibleNeutralPlanets) {
    planet.buildings = db.prepare(`
      SELECT type, hp FROM buildings WHERE planet_id = ?
    `).all(planet.id);
  }

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
 * Analyze the game state for aggressive AI
 */
function analyzeAggressiveState(gameState, aiPlayer) {
  const { ownedPlanets, ownedMechs, visibleEnemyPlanets, visibleEnemyMechs, visibleNeutralPlanets } = gameState;

  // Count mechs by type
  const scoutCount = ownedMechs.filter(m => m.type === 'light').length;
  const mediumCount = ownedMechs.filter(m => m.type === 'medium').length;
  const heavyCount = ownedMechs.filter(m => m.type === 'heavy').length;
  const assaultCount = ownedMechs.filter(m => m.type === 'assault').length;
  const combatMechCount = mediumCount + heavyCount + assaultCount;

  // Calculate income
  const income = calculateIncome(gameState.gameId, gameState.playerId) || 0;

  // Count factories
  const factoryCount = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'factory')
  ).length;

  // Planets without mining colonies
  const planetsNeedingMining = ownedPlanets.filter(p =>
    !p.buildings || !p.buildings.some(b => b.type === 'mining')
  );

  // Factories needed: 1 per 3 planets (more aggressive production)
  const factoriesNeeded = Math.ceil(ownedPlanets.length / FACTORY_PER_PLANETS);
  const needMoreFactories = factoryCount < factoriesNeeded;

  // Find undefended enemy planets (no mechs on them)
  const undefendedEnemyPlanets = visibleEnemyPlanets.filter(p => {
    const mechsOnPlanet = visibleEnemyMechs.filter(m => m.x === p.x && m.y === p.y);
    return mechsOnPlanet.length === 0;
  });

  // Check if we have overwhelming force
  const hasOverwhelmingForce = combatMechCount >= 8 && combatMechCount >= visibleEnemyMechs.length * 2;

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
    needMoreFactories,
    factoriesNeeded,
    planetsNeedingMining,
    ownedPlanetCount: ownedPlanets.length,
    visibleEnemyCount: visibleEnemyMechs.length,
    undefendedEnemyPlanets,
    hasOverwhelmingForce
  };
}

/**
 * Generate build orders for aggressive AI
 */
function generateAggressiveBuilds(gameState, aiPlayer, analysis) {
  const builds = [];
  let availableCredits = aiPlayer.credits;
  const { ownedPlanets } = gameState;

  // Get planets with factories for mech building
  const planetsWithFactory = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'factory')
  );
  const usedFactories = new Set();

  // Priority 1: Build some scouts for exploration (up to 5)
  if (analysis.needMoreScouts && planetsWithFactory.length > 0) {
    for (const planet of planetsWithFactory) {
      if (analysis.scoutCount + builds.filter(b => b.mechType === 'light').length >= MAX_SCOUTS) break;
      if (usedFactories.has(planet.id)) continue;
      if (availableCredits < MECH_COSTS.light) break;

      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'light'
      });
      availableCredits -= MECH_COSTS.light;
      usedFactories.add(planet.id);
    }
  }

  // Priority 2: Build combat mechs - prefer heavy for aggression
  for (const planet of planetsWithFactory) {
    if (usedFactories.has(planet.id)) continue;

    // Build heavy mechs primarily, with some assault mixed in
    const currentHeavy = analysis.heavyCount + builds.filter(b => b.mechType === 'heavy').length;
    const currentAssault = analysis.assaultCount + builds.filter(b => b.mechType === 'assault').length;

    // Build assault every 4th combat mech
    if (currentAssault < Math.floor((currentHeavy + currentAssault) / 4) + 1 && availableCredits >= MECH_COSTS.assault) {
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'assault'
      });
      availableCredits -= MECH_COSTS.assault;
      usedFactories.add(planet.id);
    } else if (availableCredits >= MECH_COSTS.heavy) {
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'heavy'
      });
      availableCredits -= MECH_COSTS.heavy;
      usedFactories.add(planet.id);
    } else if (availableCredits >= MECH_COSTS.medium) {
      // Fall back to medium if we can't afford heavy
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'medium'
      });
      availableCredits -= MECH_COSTS.medium;
      usedFactories.add(planet.id);
    }
  }

  // Priority 3: Build factories if needed (1 per 3 planets)
  if (analysis.needMoreFactories && availableCredits >= BUILDING_COSTS.factory) {
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

  // Priority 4: Build mining colonies
  if (analysis.planetsNeedingMining.length > 0 && availableCredits >= BUILDING_COSTS.mining) {
    const planet = analysis.planetsNeedingMining[0];
    builds.push({
      planetId: planet.id,
      type: 'building',
      buildingType: 'mining'
    });
    availableCredits -= BUILDING_COSTS.mining;
  }

  return builds;
}

/**
 * Generate move orders for aggressive AI
 */
function generateAggressiveMoves(gameState, aiPlayer, analysis) {
  const moves = [];
  const assignedMechs = new Set();
  const { gridSize, ownedPlanets, ownedMechs, visibleNeutralPlanets, visibleEnemyPlanets, visibleEnemyMechs, visibleTiles } = gameState;

  // All mechs can be used for claiming and attacking
  const scouts = ownedMechs.filter(m => m.type === 'light');
  const combatMechs = ownedMechs.filter(m => m.type !== 'light');

  // Find all claimable planets (neutral or undefended enemy)
  const claimablePlanets = [
    ...visibleNeutralPlanets,
    ...analysis.undefendedEnemyPlanets
  ];

  // === CLAIM NEUTRAL/UNDEFENDED PLANETS ===
  // Send scouts first, then any available mech
  const claimedTargets = new Set();

  // Scouts claim first
  for (const scout of scouts) {
    if (assignedMechs.has(scout.id)) continue;

    let bestTarget = null;
    let bestDist = Infinity;

    for (const planet of claimablePlanets) {
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

  // Remaining scouts explore
  for (const scout of scouts) {
    if (assignedMechs.has(scout.id)) continue;

    const exploreTarget = findExploreTarget(scout, visibleTiles, gridSize, ownedMechs, assignedMechs);
    if (exploreTarget) {
      const move = moveToward(scout.x, scout.y, exploreTarget.x, exploreTarget.y, gridSize);
      if (move) {
        moves.push({ mechId: scout.id, toX: move.x, toY: move.y });
        assignedMechs.add(scout.id);
      }
    }
  }

  // === COMBAT MECH LOGIC ===
  // Group combat mechs by location
  const mechsByLocation = new Map();
  for (const mech of combatMechs) {
    const key = `${mech.x},${mech.y}`;
    if (!mechsByLocation.has(key)) {
      mechsByLocation.set(key, []);
    }
    mechsByLocation.get(key).push(mech);
  }

  // Build target list - prioritize enemy planets, then enemy mechs
  const targets = [];

  // Priority 1: Undefended enemy planets (easy wins)
  for (const planet of analysis.undefendedEnemyPlanets) {
    targets.push({
      x: planet.x,
      y: planet.y,
      priority: 1,
      type: 'undefended_planet'
    });
  }

  // Priority 2: Defended enemy planets
  for (const planet of visibleEnemyPlanets) {
    if (analysis.undefendedEnemyPlanets.some(p => p.id === planet.id)) continue;
    targets.push({
      x: planet.x,
      y: planet.y,
      priority: 2,
      type: 'defended_planet'
    });
  }

  // Priority 3: Enemy mechs
  for (const mech of visibleEnemyMechs) {
    // Skip if already targeting this location
    if (targets.some(t => t.x === mech.x && t.y === mech.y)) continue;
    targets.push({
      x: mech.x,
      y: mech.y,
      priority: 3,
      type: 'enemy_mech'
    });
  }

  // Sort by priority
  targets.sort((a, b) => a.priority - b.priority);

  // Send attack groups to targets
  const assignedTargets = new Set();

  for (const [locKey, mechs] of mechsByLocation) {
    if (mechs.length === 0) continue;

    // Find best target for this group
    let bestTarget = null;
    let bestDist = Infinity;

    for (const target of targets) {
      const targetKey = `${target.x},${target.y}`;
      if (assignedTargets.has(targetKey)) continue;

      const [x, y] = locKey.split(',').map(Number);
      const dist = Math.abs(x - target.x) + Math.abs(y - target.y);

      // For undefended planets, send even single mechs
      // For defended targets, prefer groups of 3+
      if (target.type === 'undefended_planet' || mechs.length >= ATTACK_GROUP_SIZE || analysis.hasOverwhelmingForce) {
        if (dist < bestDist) {
          bestDist = dist;
          bestTarget = target;
        }
      }
    }

    if (bestTarget) {
      // Move all mechs in this group toward target
      for (const mech of mechs) {
        if (assignedMechs.has(mech.id)) continue;
        const move = moveToward(mech.x, mech.y, bestTarget.x, bestTarget.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
        }
      }
      assignedTargets.add(`${bestTarget.x},${bestTarget.y}`);
    }
  }

  // Unassigned combat mechs rally toward the nearest group or enemy
  for (const mech of combatMechs) {
    if (assignedMechs.has(mech.id)) continue;

    // If there are visible enemies, move toward closest one
    if (visibleEnemyPlanets.length > 0) {
      let closest = null;
      let closestDist = Infinity;

      for (const planet of visibleEnemyPlanets) {
        const dist = Math.abs(mech.x - planet.x) + Math.abs(mech.y - planet.y);
        if (dist < closestDist) {
          closestDist = dist;
          closest = planet;
        }
      }

      if (closest) {
        const move = moveToward(mech.x, mech.y, closest.x, closest.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
        }
      }
    } else {
      // No visible enemies - explore toward center of map
      const centerX = Math.floor(gridSize / 2);
      const centerY = Math.floor(gridSize / 2);
      const move = moveToward(mech.x, mech.y, centerX, centerY, gridSize);
      if (move) {
        moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
        assignedMechs.add(mech.id);
      }
    }
  }

  return moves;
}

/**
 * Find an unexplored area to send a scout toward
 */
function findExploreTarget(scout, visibleTiles, gridSize, allMechs, assignedMechs) {
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
  let bestUnexploredCount = 0;

  for (const dir of directions) {
    let unexploredCount = 0;
    for (let dist = 1; dist <= 5; dist++) {
      const checkX = scout.x + dir.dx * dist;
      const checkY = scout.y + dir.dy * dist;

      if (checkX < 0 || checkX >= gridSize || checkY < 0 || checkY >= gridSize) break;

      if (!visibleTiles.has(`${checkX},${checkY}`)) {
        unexploredCount++;
      }
    }

    const targetX = scout.x + dir.dx;
    const targetY = scout.y + dir.dy;
    const mechAtTarget = allMechs.some(m =>
      m.id !== scout.id && m.x === targetX && m.y === targetY
    );

    if (!mechAtTarget && unexploredCount > bestUnexploredCount) {
      bestUnexploredCount = unexploredCount;
      bestDir = dir;
    }
  }

  if (bestDir) {
    return {
      x: Math.max(0, Math.min(gridSize - 1, scout.x + bestDir.dx * 5)),
      y: Math.max(0, Math.min(gridSize - 1, scout.y + bestDir.dy * 5))
    };
  }

  // Move toward center if no unexplored areas
  const centerX = Math.floor(gridSize / 2);
  const centerY = Math.floor(gridSize / 2);
  return { x: centerX, y: centerY };
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
 * Log analysis for aggressive AI
 */
function logAggressiveAnalysis(empireName, analysis) {
  aiLogger.log(`  ANALYSIS (Aggressive): ${empireName}`);
  aiLogger.log(`    - Scouts: ${analysis.scoutCount}/${MAX_SCOUTS}`);
  aiLogger.log(`    - Combat Mechs: ${analysis.combatMechCount} (${analysis.mediumCount}M/${analysis.heavyCount}H/${analysis.assaultCount}A)`);
  aiLogger.log(`    - Factories: ${analysis.factoryCount}/${analysis.factoriesNeeded} needed`);
  aiLogger.log(`    - Credits: ${analysis.credits}`);
  aiLogger.log(`    - Visible Enemies: ${analysis.visibleEnemyCount} mechs`);
  aiLogger.log(`    - Undefended Enemy Planets: ${analysis.undefendedEnemyPlanets.length}`);
  if (analysis.hasOverwhelmingForce) {
    aiLogger.log(`    - OVERWHELMING FORCE: All-out attack mode`);
  }
}

module.exports = {
  generateAggressiveOrders
};
