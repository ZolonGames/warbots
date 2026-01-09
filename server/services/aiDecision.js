const { db } = require('../config/database');
const { calculateVisibility, calculateIncome, calculateIncomeBreakdown } = require('./visibilityCalc');
const { MECH_TYPES } = require('./mapGenerator');
const aiLogger = require('./aiLogger');

// Building costs
const BUILDING_COSTS = {
  mining: 10,
  factory: 30,
  fortification: 25
};

// Mech maintenance costs
const MAINTENANCE_COSTS = {
  light: 1,
  medium: 2,
  heavy: 3,
  assault: 4
};

/**
 * Generate AI orders for a turn
 * @param {number} gameId - The game ID
 * @param {Object} aiPlayer - The AI player record from game_players
 * @returns {Object} Orders object with moves and builds arrays
 */
function generateAIOrders(gameId, aiPlayer) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const playerId = aiPlayer.id;

  // Get game state for AI
  const gameState = getAIGameState(gameId, playerId, game.grid_size);

  // Analyze the situation
  const analysis = analyzeGameState(gameState, aiPlayer);

  // Log analysis
  aiLogger.logAnalysis(aiPlayer.empire_name, analysis);

  const orders = {
    moves: [],
    builds: []
  };

  // Generate build orders first (so we know what credits we'll have left)
  const buildOrders = generateBuildOrders(gameState, aiPlayer, analysis);
  orders.builds = buildOrders;

  // Log each build order
  for (const build of buildOrders) {
    const planet = db.prepare('SELECT * FROM planets WHERE id = ?').get(build.planetId);
    if (build.type === 'mech') {
      aiLogger.logBuildMech(aiPlayer.empire_name, build.mechType, planet?.name || 'Unknown', planet?.x || 0, planet?.y || 0);
    } else {
      aiLogger.logBuildBuilding(aiPlayer.empire_name, build.buildingType, planet?.name || 'Unknown', planet?.x || 0, planet?.y || 0);
    }
  }

  // Calculate remaining credits after builds
  let buildCost = 0;
  for (const build of buildOrders) {
    if (build.type === 'mech') {
      buildCost += MECH_TYPES[build.mechType]?.cost || 0;
    } else {
      buildCost += BUILDING_COSTS[build.buildingType] || 0;
    }
  }

  // Generate move orders
  const moveOrders = generateMoveOrders(gameState, aiPlayer, analysis);
  orders.moves = moveOrders;

  // Log each move order
  for (const move of moveOrders) {
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
function getAIGameState(gameId, playerId, gridSize) {
  // Calculate visibility
  const visibleTiles = calculateVisibility(gameId, playerId, gridSize);

  // Get all owned planets
  const ownedPlanets = db.prepare(`
    SELECT p.*,
           (SELECT GROUP_CONCAT(type) FROM buildings WHERE planet_id = p.id) as building_types
    FROM planets p
    WHERE p.game_id = ? AND p.owner_id = ?
  `).all(gameId, playerId);

  // Get buildings for owned planets
  for (const planet of ownedPlanets) {
    planet.buildings = db.prepare(`
      SELECT * FROM buildings WHERE planet_id = ?
    `).all(planet.id);
  }

  // Get visible enemy planets
  const visibleEnemyPlanets = [];
  const allPlanets = db.prepare(`
    SELECT p.*,
           (SELECT GROUP_CONCAT(type) FROM buildings WHERE planet_id = p.id) as building_types
    FROM planets p
    WHERE p.game_id = ? AND p.owner_id IS NOT NULL AND p.owner_id != ?
  `).all(gameId, playerId);

  for (const planet of allPlanets) {
    const key = `${planet.x},${planet.y}`;
    if (visibleTiles.has(key)) {
      planet.buildings = db.prepare(`
        SELECT * FROM buildings WHERE planet_id = ?
      `).all(planet.id);
      visibleEnemyPlanets.push(planet);
    }
  }

  // Get neutral planets in visibility
  const neutralPlanets = [];
  const allNeutralPlanets = db.prepare(`
    SELECT * FROM planets WHERE game_id = ? AND owner_id IS NULL
  `).all(gameId);

  for (const planet of allNeutralPlanets) {
    const key = `${planet.x},${planet.y}`;
    if (visibleTiles.has(key)) {
      neutralPlanets.push(planet);
    }
  }

  // Get all owned mechs
  const ownedMechs = db.prepare(`
    SELECT * FROM mechs WHERE game_id = ? AND owner_id = ?
  `).all(gameId, playerId);

  // Get visible enemy mechs
  const visibleEnemyMechs = [];
  const allEnemyMechs = db.prepare(`
    SELECT * FROM mechs WHERE game_id = ? AND owner_id != ?
  `).all(gameId, playerId);

  for (const mech of allEnemyMechs) {
    const key = `${mech.x},${mech.y}`;
    if (visibleTiles.has(key)) {
      visibleEnemyMechs.push(mech);
    }
  }

  return {
    gameId,
    playerId,
    gridSize,
    visibleTiles,
    ownedPlanets,
    visibleEnemyPlanets,
    neutralPlanets,
    ownedMechs,
    visibleEnemyMechs
  };
}

/**
 * Analyze the game state to determine AI strategy
 */
function analyzeGameState(gameState, aiPlayer) {
  const { ownedPlanets, visibleEnemyPlanets, neutralPlanets, ownedMechs, visibleEnemyMechs } = gameState;

  // Calculate income
  const income = calculateIncome(gameState.gameId, gameState.playerId);

  // Count mech types
  const mechCounts = { light: 0, medium: 0, heavy: 0, assault: 0 };
  for (const mech of ownedMechs) {
    mechCounts[mech.type] = (mechCounts[mech.type] || 0) + 1;
  }

  // Find homeworld
  const homeworld = ownedPlanets.find(p => p.is_homeworld === 1);

  // Check for factories
  const planetsWithFactory = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'factory')
  );

  // Check for fortifications
  const planetsWithFort = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'fortification')
  );

  // Determine game phase
  const planetCount = ownedPlanets.length;
  const visibleEnemyCount = visibleEnemyPlanets.length;

  // Early game: < 6 planets AND < 3 enemy planets visible
  // Mid game: 6+ planets OR 3+ enemy planets visible
  const isEarlyGame = planetCount < 6 && visibleEnemyCount < 3;
  const isMidGame = planetCount >= 6 || visibleEnemyCount >= 3;

  // Check threat level (3+ enemy mechs in visibility)
  const underThreat = visibleEnemyMechs.length >= 3;

  // Determine which mech type to build
  let preferredMechType = 'light';

  if (isMidGame || planetCount >= 5) {
    preferredMechType = 'medium';
  }

  // Check if any enemy has significant force
  const enemyMechsByOwner = {};
  for (const mech of visibleEnemyMechs) {
    enemyMechsByOwner[mech.owner_id] = (enemyMechsByOwner[mech.owner_id] || 0) + 1;
  }
  const maxEnemyMechs = Math.max(0, ...Object.values(enemyMechsByOwner));

  // Income 40+/turn OR enemy with 4+ mechs -> assault mechs
  if (income >= 40 || maxEnemyMechs >= 4) {
    preferredMechType = 'assault';
  } else if (maxEnemyMechs >= 2) {
    preferredMechType = 'heavy';
  }

  // Calculate total mech strength for attack decisions
  const totalMechStrength = ownedMechs.length;
  const combatMechs = ownedMechs.filter(m => m.type !== 'light');

  return {
    income,
    mechCounts,
    totalMechs: ownedMechs.length,
    homeworld,
    planetsWithFactory,
    planetsWithFort,
    isEarlyGame,
    isMidGame,
    underThreat,
    preferredMechType,
    maxEnemyMechs,
    combatMechs: combatMechs.length,
    canAttackFortified: combatMechs.length >= 4
  };
}

/**
 * Generate build orders for AI
 */
function generateBuildOrders(gameState, aiPlayer, analysis) {
  const { ownedPlanets, visibleEnemyPlanets } = gameState;
  const builds = [];

  // Calculate budget (spend ~75% of credits, more if under threat)
  const spendRatio = analysis.underThreat ? 0.9 : 0.75;
  let budget = Math.floor(aiPlayer.credits * spendRatio);

  // Priority 1: Build fortification on homeworld if under threat and missing
  if (analysis.underThreat && analysis.homeworld) {
    const homeworldHasFort = analysis.homeworld.buildings &&
      analysis.homeworld.buildings.some(b => b.type === 'fortification');

    if (!homeworldHasFort && budget >= BUILDING_COSTS.fortification) {
      builds.push({
        planetId: analysis.homeworld.id,
        type: 'building',
        buildingType: 'fortification'
      });
      budget -= BUILDING_COSTS.fortification;
    }
  }

  // Priority 2: In mid game, build fortifications on planets closest to enemies
  if (analysis.isMidGame && visibleEnemyPlanets.length > 0) {
    // Find unfortified planets
    const unfortifiedPlanets = ownedPlanets.filter(p =>
      !p.buildings || !p.buildings.some(b => b.type === 'fortification')
    );

    // Sort by distance to nearest enemy
    unfortifiedPlanets.sort((a, b) => {
      const distA = Math.min(...visibleEnemyPlanets.map(e =>
        Math.sqrt((a.x - e.x) ** 2 + (a.y - e.y) ** 2)
      ));
      const distB = Math.min(...visibleEnemyPlanets.map(e =>
        Math.sqrt((b.x - e.x) ** 2 + (b.y - e.y) ** 2)
      ));
      return distA - distB;
    });

    // Fortify closest 2 planets
    for (let i = 0; i < Math.min(2, unfortifiedPlanets.length); i++) {
      if (budget >= BUILDING_COSTS.fortification) {
        builds.push({
          planetId: unfortifiedPlanets[i].id,
          type: 'building',
          buildingType: 'fortification'
        });
        budget -= BUILDING_COSTS.fortification;
      }
    }
  }

  // Priority 3: Build factory if we have none (or only one and have lots of planets)
  if (analysis.planetsWithFactory.length === 0 ||
      (analysis.planetsWithFactory.length === 1 && ownedPlanets.length >= 5)) {
    // Find safest planet for factory (furthest from enemies)
    const planetsWithoutFactory = ownedPlanets.filter(p =>
      !p.buildings || !p.buildings.some(b => b.type === 'factory')
    );

    if (planetsWithoutFactory.length > 0 && budget >= BUILDING_COSTS.factory) {
      // Sort by distance to nearest enemy (furthest first)
      let safestPlanet = planetsWithoutFactory[0];

      if (visibleEnemyPlanets.length > 0) {
        planetsWithoutFactory.sort((a, b) => {
          const distA = Math.min(...visibleEnemyPlanets.map(e =>
            Math.sqrt((a.x - e.x) ** 2 + (a.y - e.y) ** 2)
          ));
          const distB = Math.min(...visibleEnemyPlanets.map(e =>
            Math.sqrt((b.x - e.x) ** 2 + (b.y - e.y) ** 2)
          ));
          return distB - distA; // Furthest first
        });
        safestPlanet = planetsWithoutFactory[0];
      }

      builds.push({
        planetId: safestPlanet.id,
        type: 'building',
        buildingType: 'factory'
      });
      budget -= BUILDING_COSTS.factory;
    }
  }

  // Priority 4: Build mining colonies in early game
  if (analysis.isEarlyGame) {
    const planetsWithoutMining = ownedPlanets.filter(p =>
      !p.buildings || !p.buildings.some(b => b.type === 'mining')
    );

    for (const planet of planetsWithoutMining) {
      if (budget >= BUILDING_COSTS.mining) {
        builds.push({
          planetId: planet.id,
          type: 'building',
          buildingType: 'mining'
        });
        budget -= BUILDING_COSTS.mining;
      }
    }
  }

  // Priority 5: Build mechs with remaining budget
  if (analysis.planetsWithFactory.length > 0) {
    const mechCost = MECH_TYPES[analysis.preferredMechType]?.cost || 2;
    const factoryPlanet = analysis.planetsWithFactory[0];

    while (budget >= mechCost) {
      builds.push({
        planetId: factoryPlanet.id,
        type: 'mech',
        mechType: analysis.preferredMechType
      });
      budget -= mechCost;
    }

    // If we can't afford preferred type, try cheaper types
    if (budget >= MECH_TYPES.light.cost && analysis.preferredMechType !== 'light') {
      while (budget >= MECH_TYPES.light.cost) {
        builds.push({
          planetId: factoryPlanet.id,
          type: 'mech',
          mechType: 'light'
        });
        budget -= MECH_TYPES.light.cost;
      }
    }
  }

  return builds;
}

/**
 * Generate move orders for AI
 */
function generateMoveOrders(gameState, aiPlayer, analysis) {
  const { ownedPlanets, neutralPlanets, visibleEnemyPlanets, ownedMechs, visibleEnemyMechs, gridSize } = gameState;
  const moves = [];
  const assignedMechs = new Set();

  // Group mechs by location
  const mechsByLocation = {};
  for (const mech of ownedMechs) {
    const key = `${mech.x},${mech.y}`;
    if (!mechsByLocation[key]) {
      mechsByLocation[key] = [];
    }
    mechsByLocation[key].push(mech);
  }

  // Priority 1: If under threat, concentrate forces
  if (analysis.underThreat) {
    // Find the main threat location
    const threatGroups = {};
    for (const enemy of visibleEnemyMechs) {
      const key = `${enemy.x},${enemy.y}`;
      threatGroups[key] = (threatGroups[key] || 0) + 1;
    }

    let mainThreatLocation = null;
    let maxThreat = 0;
    for (const [loc, count] of Object.entries(threatGroups)) {
      if (count > maxThreat) {
        maxThreat = count;
        mainThreatLocation = loc.split(',').map(Number);
      }
    }

    if (mainThreatLocation) {
      // Find nearest owned planet to defend
      let nearestPlanet = null;
      let nearestDist = Infinity;

      for (const planet of ownedPlanets) {
        const dist = Math.sqrt(
          (planet.x - mainThreatLocation[0]) ** 2 +
          (planet.y - mainThreatLocation[1]) ** 2
        );
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestPlanet = planet;
        }
      }

      if (nearestPlanet) {
        // Move mechs toward the threatened planet (but leave some light mechs for expansion)
        let lightMechsLeft = 2; // Keep 2 lights for expansion

        for (const mech of ownedMechs) {
          if (assignedMechs.has(mech.id)) continue;

          // Keep some lights for expansion
          if (mech.type === 'light' && lightMechsLeft > 0) {
            lightMechsLeft--;
            continue;
          }

          // Move toward the nearest threatened planet
          const move = moveToward(mech.x, mech.y, nearestPlanet.x, nearestPlanet.y, gridSize);
          if (move) {
            moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
            assignedMechs.add(mech.id);
          }
        }
      }
    }
  }

  // Priority 2: Attack enemy planets if we have enough force
  if (analysis.canAttackFortified && visibleEnemyPlanets.length > 0) {
    // Find weakest enemy planet
    const targetPlanet = visibleEnemyPlanets.sort((a, b) => {
      // Prefer planets without fortifications
      const aHasFort = a.buildings && a.buildings.some(b => b.type === 'fortification');
      const bHasFort = b.buildings && b.buildings.some(b => b.type === 'fortification');
      if (aHasFort !== bHasFort) return aHasFort ? 1 : -1;
      return 0;
    })[0];

    if (targetPlanet) {
      // Send combat mechs toward target
      for (const mech of ownedMechs) {
        if (assignedMechs.has(mech.id)) continue;
        if (mech.type === 'light') continue; // Don't send lights to attack forts

        const move = moveToward(mech.x, mech.y, targetPlanet.x, targetPlanet.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
        }
      }
    }
  }

  // Priority 3: Expand to neutral planets
  if (neutralPlanets.length > 0) {
    // Sort neutral planets by distance to nearest owned planet
    const sortedNeutrals = neutralPlanets.sort((a, b) => {
      const distA = Math.min(...ownedPlanets.map(p =>
        Math.sqrt((a.x - p.x) ** 2 + (a.y - p.y) ** 2)
      ));
      const distB = Math.min(...ownedPlanets.map(p =>
        Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2)
      ));
      return distA - distB;
    });

    // Send light mechs to capture
    for (const neutralPlanet of sortedNeutrals) {
      // Find nearest unassigned light mech
      let nearestMech = null;
      let nearestDist = Infinity;

      for (const mech of ownedMechs) {
        if (assignedMechs.has(mech.id)) continue;
        if (mech.type !== 'light' && !analysis.isEarlyGame) continue; // Use lights for expansion

        const dist = Math.sqrt(
          (mech.x - neutralPlanet.x) ** 2 +
          (mech.y - neutralPlanet.y) ** 2
        );
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestMech = mech;
        }
      }

      if (nearestMech) {
        const move = moveToward(nearestMech.x, nearestMech.y, neutralPlanet.x, neutralPlanet.y, gridSize);
        if (move) {
          moves.push({ mechId: nearestMech.id, toX: move.x, toY: move.y });
          assignedMechs.add(nearestMech.id);
        }
      }
    }
  }

  // Priority 4: Ensure garrison on owned planets (at least move toward them)
  for (const planet of ownedPlanets) {
    // Check if planet has a mech
    const mechsOnPlanet = ownedMechs.filter(m => m.x === planet.x && m.y === planet.y);

    if (mechsOnPlanet.length === 0) {
      // Find nearest unassigned mech to garrison
      let nearestMech = null;
      let nearestDist = Infinity;

      for (const mech of ownedMechs) {
        if (assignedMechs.has(mech.id)) continue;

        const dist = Math.sqrt(
          (mech.x - planet.x) ** 2 +
          (mech.y - planet.y) ** 2
        );
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestMech = mech;
        }
      }

      if (nearestMech && nearestDist > 0) {
        const move = moveToward(nearestMech.x, nearestMech.y, planet.x, planet.y, gridSize);
        if (move) {
          moves.push({ mechId: nearestMech.id, toX: move.x, toY: move.y });
          assignedMechs.add(nearestMech.id);
        }
      }
    }
  }

  // Priority 5: Scout - send unassigned mechs to explore
  for (const mech of ownedMechs) {
    if (assignedMechs.has(mech.id)) continue;

    // Move toward center of unexplored area (simple heuristic: move toward map center if far from it)
    const centerX = Math.floor(gridSize / 2);
    const centerY = Math.floor(gridSize / 2);

    const distToCenter = Math.sqrt((mech.x - centerX) ** 2 + (mech.y - centerY) ** 2);

    if (distToCenter > gridSize / 4) {
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
 * Calculate one step movement toward a target
 */
function moveToward(fromX, fromY, toX, toY, gridSize) {
  if (fromX === toX && fromY === toY) {
    return null; // Already at target
  }

  // Calculate direction
  const dx = toX - fromX;
  const dy = toY - fromY;

  // Move one step in the dominant direction
  let newX = fromX;
  let newY = fromY;

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Move horizontally
    newX = fromX + Math.sign(dx);
  } else {
    // Move vertically
    newY = fromY + Math.sign(dy);
  }

  // Clamp to grid bounds
  newX = Math.max(0, Math.min(gridSize - 1, newX));
  newY = Math.max(0, Math.min(gridSize - 1, newY));

  if (newX === fromX && newY === fromY) {
    return null; // Can't move
  }

  return { x: newX, y: newY };
}

module.exports = {
  generateAIOrders
};
