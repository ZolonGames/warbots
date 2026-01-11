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

// Constants for balanced AI
const MAX_SCOUTS = 7; // Moderate scouts - balance between exploration and combat
const FACTORY_PER_PLANETS = 4; // Balanced factory production
const MIN_COMBAT_MECHS_TO_ATTACK = 4; // Wait for a decent force before attacking
const DEFENSE_RESERVE_CREDITS = 15; // Keep some credits for emergencies

/**
 * Generate orders for balanced AI
 * @param {number} gameId - The game ID
 * @param {Object} aiPlayer - The AI player record
 * @returns {Object} Orders object with moves and builds arrays
 */
function generateBalancedOrders(gameId, aiPlayer) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const playerId = aiPlayer.id;
  const gridSize = game.grid_size;

  // Get game state
  const gameState = getBalancedGameState(gameId, playerId, gridSize);

  // Analyze the situation
  const analysis = analyzeBalancedState(gameState, aiPlayer);

  // Log analysis
  logBalancedAnalysis(aiPlayer.empire_name, analysis);

  const orders = {
    moves: [],
    builds: []
  };

  // Generate build orders first
  orders.builds = generateBalancedBuilds(gameState, aiPlayer, analysis);

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
  orders.moves = generateBalancedMoves(gameState, aiPlayer, analysis);

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
function getBalancedGameState(gameId, playerId, gridSize) {
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
 * Analyze the game state for balanced AI
 */
function analyzeBalancedState(gameState, aiPlayer) {
  const { ownedPlanets, ownedMechs, visibleEnemyPlanets, visibleEnemyMechs, visibleNeutralPlanets } = gameState;

  // Count mechs by type
  const scoutCount = ownedMechs.filter(m => m.type === 'light').length;
  const mediumCount = ownedMechs.filter(m => m.type === 'medium').length;
  const heavyCount = ownedMechs.filter(m => m.type === 'heavy').length;
  const assaultCount = ownedMechs.filter(m => m.type === 'assault').length;
  const combatMechCount = mediumCount + heavyCount + assaultCount;

  // Check if we've encountered enemies
  const hasEncounteredEnemy = visibleEnemyPlanets.length > 0 || visibleEnemyMechs.length > 0;

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

  // Planets without defenses (consider after encountering enemy)
  const planetsNeedingDefense = hasEncounteredEnemy ? ownedPlanets.filter(p =>
    !p.buildings || !p.buildings.some(b => b.type === 'fortification')
  ) : [];

  // Factories needed: 1 per 4 planets
  const factoriesNeeded = Math.ceil(ownedPlanets.length / FACTORY_PER_PLANETS);
  const needMoreFactories = factoryCount < factoriesNeeded;

  // Find undefended enemy planets
  const undefendedEnemyPlanets = visibleEnemyPlanets.filter(p => {
    const mechsOnPlanet = visibleEnemyMechs.filter(m => m.x === p.x && m.y === p.y);
    return mechsOnPlanet.length === 0;
  });

  // Check threat level - enemies near our planets
  const threatenedPlanets = ownedPlanets.filter(p => {
    return visibleEnemyMechs.some(m =>
      Math.abs(m.x - p.x) + Math.abs(m.y - p.y) <= 3
    );
  });

  // Ready to attack if we have enough combat mechs
  const readyToAttack = combatMechCount >= MIN_COMBAT_MECHS_TO_ATTACK;

  // Overwhelming force check
  const hasOverwhelmingForce = combatMechCount >= 10 && combatMechCount >= visibleEnemyMechs.length * 2;

  return {
    scoutCount,
    mediumCount,
    heavyCount,
    assaultCount,
    combatMechCount,
    needMoreScouts: scoutCount < MAX_SCOUTS,
    hasEncounteredEnemy,
    income,
    credits: aiPlayer.credits,
    factoryCount,
    needMoreFactories,
    factoriesNeeded,
    planetsNeedingMining,
    planetsNeedingDefense,
    ownedPlanetCount: ownedPlanets.length,
    visibleEnemyCount: visibleEnemyMechs.length,
    undefendedEnemyPlanets,
    threatenedPlanets,
    readyToAttack,
    hasOverwhelmingForce
  };
}

/**
 * Generate build orders for balanced AI
 */
function generateBalancedBuilds(gameState, aiPlayer, analysis) {
  const builds = [];
  let availableCredits = aiPlayer.credits;
  const { ownedPlanets } = gameState;

  // Reserve credits if we've encountered enemies
  const reserveCredits = analysis.hasEncounteredEnemy ? DEFENSE_RESERVE_CREDITS : 0;

  // Get planets with factories for mech building
  const planetsWithFactory = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'factory')
  );
  const usedFactories = new Set();

  // Priority 1: Build scouts for exploration (up to 7)
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

  // Priority 2: Build balanced combat force - mix of medium, heavy, assault
  for (const planet of planetsWithFactory) {
    if (usedFactories.has(planet.id)) continue;
    if (availableCredits - reserveCredits < MECH_COSTS.medium) break;

    const currentMedium = analysis.mediumCount + builds.filter(b => b.mechType === 'medium').length;
    const currentHeavy = analysis.heavyCount + builds.filter(b => b.mechType === 'heavy').length;
    const currentAssault = analysis.assaultCount + builds.filter(b => b.mechType === 'assault').length;
    const totalCombat = currentMedium + currentHeavy + currentAssault;

    // Balanced composition: 2 medium : 2 heavy : 1 assault ratio
    // Build assault every 5th mech
    if (currentAssault < Math.floor(totalCombat / 5) + 1 && availableCredits - reserveCredits >= MECH_COSTS.assault) {
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'assault'
      });
      availableCredits -= MECH_COSTS.assault;
      usedFactories.add(planet.id);
    }
    // Build heavy if we have more mediums
    else if (currentHeavy < currentMedium && availableCredits - reserveCredits >= MECH_COSTS.heavy) {
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'heavy'
      });
      availableCredits -= MECH_COSTS.heavy;
      usedFactories.add(planet.id);
    }
    // Build medium otherwise
    else if (availableCredits - reserveCredits >= MECH_COSTS.medium) {
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'medium'
      });
      availableCredits -= MECH_COSTS.medium;
      usedFactories.add(planet.id);
    }
  }

  // Priority 3: Build mining colonies
  if (analysis.planetsNeedingMining.length > 0 && availableCredits - reserveCredits >= BUILDING_COSTS.mining) {
    const planet = analysis.planetsNeedingMining[0];
    builds.push({
      planetId: planet.id,
      type: 'building',
      buildingType: 'mining'
    });
    availableCredits -= BUILDING_COSTS.mining;
  }

  // Priority 4: Build factories if needed
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

  // Priority 5: Build defenses on threatened planets
  if (analysis.threatenedPlanets.length > 0 && analysis.planetsNeedingDefense.length > 0) {
    const threatenedNeedingDefense = analysis.planetsNeedingDefense.filter(p =>
      analysis.threatenedPlanets.some(t => t.id === p.id)
    );
    if (threatenedNeedingDefense.length > 0 && availableCredits >= BUILDING_COSTS.fortification) {
      builds.push({
        planetId: threatenedNeedingDefense[0].id,
        type: 'building',
        buildingType: 'fortification'
      });
      availableCredits -= BUILDING_COSTS.fortification;
    }
  }

  return builds;
}

/**
 * Generate move orders for balanced AI
 */
function generateBalancedMoves(gameState, aiPlayer, analysis) {
  const moves = [];
  const assignedMechs = new Set();
  const { gridSize, ownedPlanets, ownedMechs, visibleNeutralPlanets, visibleEnemyPlanets, visibleEnemyMechs, visibleTiles } = gameState;

  const scouts = ownedMechs.filter(m => m.type === 'light');
  const combatMechs = ownedMechs.filter(m => m.type !== 'light');

  // Find claimable planets
  const claimablePlanets = [
    ...visibleNeutralPlanets,
    ...analysis.undefendedEnemyPlanets
  ];

  // === SCOUT LOGIC ===
  const claimedTargets = new Set();

  // Scouts claim neutral/undefended planets
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

  // First, handle defense - intercept enemies near our planets
  if (analysis.threatenedPlanets.length > 0) {
    for (const planet of analysis.threatenedPlanets) {
      // Find nearby enemies
      const nearbyEnemies = visibleEnemyMechs.filter(m =>
        Math.abs(m.x - planet.x) + Math.abs(m.y - planet.y) <= 3
      );

      if (nearbyEnemies.length > 0) {
        // Send combat mechs to intercept
        const availableCombat = combatMechs.filter(m => !assignedMechs.has(m.id));
        const defender = availableCombat.sort((a, b) => {
          const distA = Math.abs(a.x - planet.x) + Math.abs(a.y - planet.y);
          const distB = Math.abs(b.x - planet.x) + Math.abs(b.y - planet.y);
          return distA - distB;
        })[0];

        if (defender) {
          const enemy = nearbyEnemies[0];
          const move = moveToward(defender.x, defender.y, enemy.x, enemy.y, gridSize);
          if (move) {
            moves.push({ mechId: defender.id, toX: move.x, toY: move.y });
            assignedMechs.add(defender.id);
          }
        }
      }
    }
  }

  // Group remaining combat mechs by location
  const mechsByLocation = new Map();
  for (const mech of combatMechs) {
    if (assignedMechs.has(mech.id)) continue;
    const key = `${mech.x},${mech.y}`;
    if (!mechsByLocation.has(key)) {
      mechsByLocation.set(key, []);
    }
    mechsByLocation.get(key).push(mech);
  }

  // Build target list
  const targets = [];

  // Undefended enemy planets first
  for (const planet of analysis.undefendedEnemyPlanets) {
    targets.push({ x: planet.x, y: planet.y, priority: 1, type: 'undefended' });
  }

  // Then defended enemy planets
  for (const planet of visibleEnemyPlanets) {
    if (analysis.undefendedEnemyPlanets.some(p => p.id === planet.id)) continue;
    targets.push({ x: planet.x, y: planet.y, priority: 2, type: 'defended' });
  }

  // Then enemy mechs
  for (const mech of visibleEnemyMechs) {
    if (targets.some(t => t.x === mech.x && t.y === mech.y)) continue;
    targets.push({ x: mech.x, y: mech.y, priority: 3, type: 'mech' });
  }

  targets.sort((a, b) => a.priority - b.priority);

  // Send groups to attack if ready
  const assignedTargets = new Set();

  if (analysis.readyToAttack || analysis.hasOverwhelmingForce) {
    for (const [locKey, mechs] of mechsByLocation) {
      if (mechs.length === 0) continue;

      let bestTarget = null;
      let bestDist = Infinity;

      for (const target of targets) {
        const targetKey = `${target.x},${target.y}`;
        if (assignedTargets.has(targetKey)) continue;

        const [x, y] = locKey.split(',').map(Number);
        const dist = Math.abs(x - target.x) + Math.abs(y - target.y);

        // For undefended, send any size group
        // For defended, want at least 3 mechs or overwhelming force
        if (target.type === 'undefended' || mechs.length >= 3 || analysis.hasOverwhelmingForce) {
          if (dist < bestDist) {
            bestDist = dist;
            bestTarget = target;
          }
        }
      }

      if (bestTarget) {
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
  }

  // Unassigned combat mechs - rally toward other combat mechs or explore
  for (const mech of combatMechs) {
    if (assignedMechs.has(mech.id)) continue;

    // Find largest group of friendly combat mechs to rally to
    let bestRallyPoint = null;
    let bestGroupSize = 0;

    for (const [locKey, mechs] of mechsByLocation) {
      if (mechs.length > bestGroupSize) {
        const [x, y] = locKey.split(',').map(Number);
        if (x !== mech.x || y !== mech.y) {
          bestGroupSize = mechs.length;
          bestRallyPoint = { x, y };
        }
      }
    }

    if (bestRallyPoint) {
      const move = moveToward(mech.x, mech.y, bestRallyPoint.x, bestRallyPoint.y, gridSize);
      if (move) {
        moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
        assignedMechs.add(mech.id);
      }
    } else {
      // No rally point - move toward center to find action
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
 * Log analysis for balanced AI
 */
function logBalancedAnalysis(empireName, analysis) {
  aiLogger.log(`  ANALYSIS (Balanced): ${empireName}`);
  aiLogger.log(`    - Scouts: ${analysis.scoutCount}/${MAX_SCOUTS}`);
  aiLogger.log(`    - Combat Mechs: ${analysis.combatMechCount} (${analysis.mediumCount}M/${analysis.heavyCount}H/${analysis.assaultCount}A)`);
  aiLogger.log(`    - Ready to Attack: ${analysis.readyToAttack ? 'YES' : 'No (need ' + MIN_COMBAT_MECHS_TO_ATTACK + ')'}`);
  aiLogger.log(`    - Factories: ${analysis.factoryCount}/${analysis.factoriesNeeded} needed`);
  aiLogger.log(`    - Credits: ${analysis.credits}`);
  aiLogger.log(`    - Threatened Planets: ${analysis.threatenedPlanets.length}`);
  aiLogger.log(`    - Visible Enemies: ${analysis.visibleEnemyCount} mechs`);
  if (analysis.hasOverwhelmingForce) {
    aiLogger.log(`    - OVERWHELMING FORCE: Full attack mode`);
  }
}

module.exports = {
  generateBalancedOrders
};
