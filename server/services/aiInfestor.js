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

// Constants for infestor AI - swarm tactics
const FACTORY_PER_PLANETS = 2; // Lots of factories for mass production
const LIGHT_TO_MEDIUM_RATIO = 2; // Build 2 lights for every 1 medium
const NO_HEAVY_MECHS = true; // Don't build expensive mechs

/**
 * Generate orders for infestor AI - swarm expansion strategy
 * @param {number} gameId - The game ID
 * @param {Object} aiPlayer - The AI player record
 * @returns {Object} Orders object with moves and builds arrays
 */
function generateInfestorOrders(gameId, aiPlayer) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const playerId = aiPlayer.id;
  const gridSize = game.grid_size;

  // Get game state
  const gameState = getInfestorGameState(gameId, playerId, gridSize);

  // Analyze the situation
  const analysis = analyzeInfestorState(gameState, aiPlayer);

  // Log analysis
  logInfestorAnalysis(aiPlayer.empire_name, analysis);

  const orders = {
    moves: [],
    builds: []
  };

  // Generate build orders first - prioritize economy and mass production
  orders.builds = generateInfestorBuilds(gameState, aiPlayer, analysis);

  // Log builds
  for (const build of orders.builds) {
    const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(build.planetId);
    if (build.type === 'mech') {
      aiLogger.logBuildMech(aiPlayer.empire_name, build.mechType, planet?.name || 'Unknown', planet?.x || 0, planet?.y || 0);
    } else {
      aiLogger.logBuildBuilding(aiPlayer.empire_name, build.buildingType, planet?.name || 'Unknown', planet?.x || 0, planet?.y || 0);
    }
  }

  // Generate move orders - spread out and claim everything
  orders.moves = generateInfestorMoves(gameState, aiPlayer, analysis);

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
function getInfestorGameState(gameId, playerId, gridSize) {
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
 * Analyze the game state for infestor AI
 */
function analyzeInfestorState(gameState, aiPlayer) {
  const { ownedPlanets, ownedMechs, visibleEnemyPlanets, visibleEnemyMechs, visibleNeutralPlanets } = gameState;

  // Count mechs by type
  const lightCount = ownedMechs.filter(m => m.type === 'light').length;
  const mediumCount = ownedMechs.filter(m => m.type === 'medium').length;
  const heavyCount = ownedMechs.filter(m => m.type === 'heavy').length;
  const assaultCount = ownedMechs.filter(m => m.type === 'assault').length;
  const totalMechs = ownedMechs.length;

  // Calculate income
  const income = calculateIncome(gameState.gameId, gameState.playerId) || 0;

  // Count factories and mining colonies
  const factoryCount = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'factory')
  ).length;

  const miningCount = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'mining')
  ).length;

  // Planets without mining colonies - priority for economy
  const planetsNeedingMining = ownedPlanets.filter(p =>
    !p.buildings || !p.buildings.some(b => b.type === 'mining')
  );

  // Planets without factories
  const planetsNeedingFactory = ownedPlanets.filter(p =>
    !p.buildings || !p.buildings.some(b => b.type === 'factory')
  );

  // Factories needed: 1 per 2 planets (lots of production)
  const factoriesNeeded = Math.ceil(ownedPlanets.length / FACTORY_PER_PLANETS);
  const needMoreFactories = factoryCount < factoriesNeeded;

  // Find all claimable planets
  const undefendedEnemyPlanets = visibleEnemyPlanets.filter(p => {
    const mechsOnPlanet = visibleEnemyMechs.filter(m => m.x === p.x && m.y === p.y);
    return mechsOnPlanet.length === 0;
  });

  // Need more lights for exploration?
  const needMoreLights = lightCount < mediumCount * LIGHT_TO_MEDIUM_RATIO;

  return {
    lightCount,
    mediumCount,
    heavyCount,
    assaultCount,
    totalMechs,
    income,
    credits: aiPlayer.credits,
    factoryCount,
    miningCount,
    needMoreFactories,
    factoriesNeeded,
    planetsNeedingMining,
    planetsNeedingFactory,
    ownedPlanetCount: ownedPlanets.length,
    visibleNeutralCount: visibleNeutralPlanets.length,
    undefendedEnemyPlanets,
    needMoreLights
  };
}

/**
 * Generate build orders for infestor AI - prioritize economy and swarm
 */
function generateInfestorBuilds(gameState, aiPlayer, analysis) {
  const builds = [];
  let availableCredits = aiPlayer.credits;
  const { ownedPlanets } = gameState;

  // Get planets with factories for mech building
  const planetsWithFactory = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'factory')
  );
  const usedFactories = new Set();

  // Priority 1: Build mining colonies on ALL planets - economy first
  for (const planet of analysis.planetsNeedingMining) {
    if (availableCredits < BUILDING_COSTS.mining) break;

    builds.push({
      planetId: planet.id,
      type: 'building',
      buildingType: 'mining'
    });
    availableCredits -= BUILDING_COSTS.mining;
  }

  // Priority 2: Build factories - need production capacity
  if (analysis.needMoreFactories) {
    for (const planet of analysis.planetsNeedingFactory) {
      if (availableCredits < BUILDING_COSTS.factory) break;
      if (builds.filter(b => b.buildingType === 'factory').length >= 2) break; // Max 2 factories per turn

      builds.push({
        planetId: planet.id,
        type: 'building',
        buildingType: 'factory'
      });
      availableCredits -= BUILDING_COSTS.factory;
    }
  }

  // Priority 3: Mass produce cheap mechs - lights and mediums only
  for (const planet of planetsWithFactory) {
    if (usedFactories.has(planet.id)) continue;
    if (availableCredits < MECH_COSTS.light) break;

    // Build lights for exploration/claiming, mediums for combat
    const currentLights = analysis.lightCount + builds.filter(b => b.mechType === 'light').length;
    const currentMediums = analysis.mediumCount + builds.filter(b => b.mechType === 'medium').length;

    // Maintain 2:1 light to medium ratio
    if (currentLights < currentMediums * LIGHT_TO_MEDIUM_RATIO || currentLights < 5) {
      // Build light
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'light'
      });
      availableCredits -= MECH_COSTS.light;
      usedFactories.add(planet.id);
    } else if (availableCredits >= MECH_COSTS.medium) {
      // Build medium
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'medium'
      });
      availableCredits -= MECH_COSTS.medium;
      usedFactories.add(planet.id);
    } else {
      // Can only afford light
      builds.push({
        planetId: planet.id,
        type: 'mech',
        mechType: 'light'
      });
      availableCredits -= MECH_COSTS.light;
      usedFactories.add(planet.id);
    }
  }

  return builds;
}

/**
 * Generate move orders for infestor AI - spread out and claim everything
 */
function generateInfestorMoves(gameState, aiPlayer, analysis) {
  const moves = [];
  const assignedMechs = new Set();
  const { gridSize, ownedPlanets, ownedMechs, visibleNeutralPlanets, visibleEnemyPlanets, visibleEnemyMechs, visibleTiles } = gameState;

  // All mechs participate in expansion
  const allMechs = [...ownedMechs];

  // Find all claimable planets - neutral and undefended enemy
  const claimablePlanets = [
    ...visibleNeutralPlanets,
    ...analysis.undefendedEnemyPlanets
  ];

  // Track which planets are being claimed
  const claimedTargets = new Set();

  // === CLAIM ALL VISIBLE PLANETS ===
  // Send any available mech to claim planets - spread the swarm
  for (const mech of allMechs) {
    if (assignedMechs.has(mech.id)) continue;

    // Find nearest unclaimed planet
    let bestTarget = null;
    let bestDist = Infinity;

    for (const planet of claimablePlanets) {
      const key = `${planet.x},${planet.y}`;
      if (claimedTargets.has(key)) continue;

      const dist = Math.abs(mech.x - planet.x) + Math.abs(mech.y - planet.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestTarget = planet;
      }
    }

    if (bestTarget) {
      const move = moveToward(mech.x, mech.y, bestTarget.x, bestTarget.y, gridSize);
      if (move) {
        moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
        assignedMechs.add(mech.id);
        claimedTargets.add(`${bestTarget.x},${bestTarget.y}`);
      }
    }
  }

  // === EXPLORE WITH REMAINING MECHS ===
  // Spread out to find more planets
  for (const mech of allMechs) {
    if (assignedMechs.has(mech.id)) continue;

    // Light mechs explore, others attack enemy planets if visible
    if (mech.type === 'light') {
      const exploreTarget = findExploreTarget(mech, visibleTiles, gridSize, ownedMechs, assignedMechs);
      if (exploreTarget) {
        const move = moveToward(mech.x, mech.y, exploreTarget.x, exploreTarget.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
        }
      }
    } else {
      // Combat mechs (medium) - attack defended enemy planets
      const defendedEnemyPlanets = visibleEnemyPlanets.filter(p =>
        !analysis.undefendedEnemyPlanets.some(u => u.id === p.id)
      );

      if (defendedEnemyPlanets.length > 0) {
        // Find nearest defended enemy planet
        let nearestEnemy = null;
        let nearestDist = Infinity;

        for (const planet of defendedEnemyPlanets) {
          const dist = Math.abs(mech.x - planet.x) + Math.abs(mech.y - planet.y);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestEnemy = planet;
          }
        }

        if (nearestEnemy) {
          const move = moveToward(mech.x, mech.y, nearestEnemy.x, nearestEnemy.y, gridSize);
          if (move) {
            moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
            assignedMechs.add(mech.id);
          }
        }
      } else if (visibleEnemyMechs.length > 0) {
        // No enemy planets visible - hunt enemy mechs
        let nearestMech = null;
        let nearestDist = Infinity;

        for (const enemy of visibleEnemyMechs) {
          const dist = Math.abs(mech.x - enemy.x) + Math.abs(mech.y - enemy.y);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestMech = enemy;
          }
        }

        if (nearestMech) {
          const move = moveToward(mech.x, mech.y, nearestMech.x, nearestMech.y, gridSize);
          if (move) {
            moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
            assignedMechs.add(mech.id);
          }
        }
      } else {
        // Nothing to attack - explore
        const exploreTarget = findExploreTarget(mech, visibleTiles, gridSize, ownedMechs, assignedMechs);
        if (exploreTarget) {
          const move = moveToward(mech.x, mech.y, exploreTarget.x, exploreTarget.y, gridSize);
          if (move) {
            moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
            assignedMechs.add(mech.id);
          }
        }
      }
    }
  }

  return moves;
}

/**
 * Find an unexplored area to send a mech toward - spread out maximally
 */
function findExploreTarget(mech, visibleTiles, gridSize, allMechs, assignedMechs) {
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

  // Shuffle for variety - spreads mechs in different directions
  for (let i = directions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [directions[i], directions[j]] = [directions[j], directions[i]];
  }

  let bestDir = null;
  let bestScore = -Infinity;

  for (const dir of directions) {
    let unexploredCount = 0;
    let distanceFromOthers = 0;

    // Count unexplored tiles in this direction
    for (let dist = 1; dist <= 5; dist++) {
      const checkX = mech.x + dir.dx * dist;
      const checkY = mech.y + dir.dy * dist;

      if (checkX < 0 || checkX >= gridSize || checkY < 0 || checkY >= gridSize) break;

      if (!visibleTiles.has(`${checkX},${checkY}`)) {
        unexploredCount++;
      }
    }

    // Bonus for moving away from other mechs (spread out)
    const targetX = mech.x + dir.dx;
    const targetY = mech.y + dir.dy;

    for (const other of allMechs) {
      if (other.id === mech.id) continue;
      const dist = Math.abs(other.x - targetX) + Math.abs(other.y - targetY);
      distanceFromOthers += dist;
    }

    // Check if another mech is at target
    const mechAtTarget = allMechs.some(m =>
      m.id !== mech.id && m.x === targetX && m.y === targetY
    );

    if (!mechAtTarget) {
      // Score based on unexplored tiles and distance from others
      const score = unexploredCount * 10 + distanceFromOthers;
      if (score > bestScore) {
        bestScore = score;
        bestDir = dir;
      }
    }
  }

  if (bestDir) {
    return {
      x: Math.max(0, Math.min(gridSize - 1, mech.x + bestDir.dx * 5)),
      y: Math.max(0, Math.min(gridSize - 1, mech.y + bestDir.dy * 5))
    };
  }

  // If stuck, move toward a random edge
  const edges = [
    { x: 0, y: mech.y },
    { x: gridSize - 1, y: mech.y },
    { x: mech.x, y: 0 },
    { x: mech.x, y: gridSize - 1 }
  ];
  const randomEdge = edges[Math.floor(Math.random() * edges.length)];
  return randomEdge;
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
 * Log analysis for infestor AI
 */
function logInfestorAnalysis(empireName, analysis) {
  aiLogger.log(`  ANALYSIS (Infestor): ${empireName}`);
  aiLogger.log(`    - Mechs: ${analysis.totalMechs} total (${analysis.lightCount}L/${analysis.mediumCount}M)`);
  aiLogger.log(`    - Planets: ${analysis.ownedPlanetCount} owned`);
  aiLogger.log(`    - Economy: ${analysis.miningCount} mining, ${analysis.factoryCount}/${analysis.factoriesNeeded} factories`);
  aiLogger.log(`    - Credits: ${analysis.credits}, Income: ${analysis.income}/turn`);
  aiLogger.log(`    - Visible Neutral Planets: ${analysis.visibleNeutralCount}`);
  aiLogger.log(`    - Undefended Enemy Planets: ${analysis.undefendedEnemyPlanets.length}`);
  if (analysis.planetsNeedingMining.length > 0) {
    aiLogger.log(`    - Planets needing mining: ${analysis.planetsNeedingMining.length}`);
  }
}

module.exports = {
  generateInfestorOrders
};
