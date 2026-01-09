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

  // Check if original homeworld is lost
  let lostHomeworld = null;
  const originalHomeworld = db.prepare(`
    SELECT p.*,
           (SELECT GROUP_CONCAT(type) FROM buildings WHERE planet_id = p.id) as building_types
    FROM planets p
    WHERE p.game_id = ? AND p.original_owner_id = ? AND p.is_homeworld = 1
  `).get(gameId, playerId);

  if (originalHomeworld && originalHomeworld.owner_id !== playerId) {
    // Homeworld is lost - get more info about it
    originalHomeworld.buildings = db.prepare(`
      SELECT * FROM buildings WHERE planet_id = ?
    `).all(originalHomeworld.id);

    // Check for enemy mechs on the homeworld
    const mechsOnHomeworld = db.prepare(`
      SELECT * FROM mechs WHERE game_id = ? AND x = ? AND y = ?
    `).all(gameId, originalHomeworld.x, originalHomeworld.y);

    const enemyMechsOnHomeworld = mechsOnHomeworld.filter(m => m.owner_id !== playerId);
    const hasFortification = originalHomeworld.buildings &&
      originalHomeworld.buildings.some(b => b.type === 'fortification');

    lostHomeworld = {
      ...originalHomeworld,
      enemyMechCount: enemyMechsOnHomeworld.length,
      hasFortification,
      isUndefended: enemyMechsOnHomeworld.length === 0 && !hasFortification
    };
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
    visibleEnemyMechs,
    lostHomeworld
  };
}

/**
 * Analyze the game state to determine AI strategy
 */
function analyzeGameState(gameState, aiPlayer) {
  const { ownedPlanets, visibleEnemyPlanets, neutralPlanets, ownedMechs, visibleEnemyMechs, lostHomeworld } = gameState;

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

  // Homeworld reclaim priority
  let needsToReclaimHomeworld = false;
  let canReclaimHomeworldNow = false;

  if (lostHomeworld) {
    needsToReclaimHomeworld = true;

    if (lostHomeworld.isUndefended) {
      // Undefended - can reclaim with any forces
      canReclaimHomeworldNow = ownedMechs.length > 0;
    } else {
      // Defended - need 4+ combat mechs
      canReclaimHomeworldNow = combatMechs.length >= 4;
    }

    // If we need to build up forces, prioritize medium/heavy/assault
    if (!canReclaimHomeworldNow && !lostHomeworld.isUndefended) {
      preferredMechType = 'medium';
      if (income >= 20) preferredMechType = 'heavy';
      if (income >= 40) preferredMechType = 'assault';
    }
  }

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
    canAttackFortified: combatMechs.length >= 4,
    lostHomeworld,
    needsToReclaimHomeworld,
    canReclaimHomeworldNow
  };
}

/**
 * Generate build orders for AI
 * Strategy: Establish fortified bases quickly, then pump out combat mechs
 */
function generateBuildOrders(gameState, aiPlayer, analysis) {
  const { ownedPlanets, visibleEnemyPlanets } = gameState;
  const builds = [];

  // Calculate budget (spend aggressively - 85% normally, 95% if under threat)
  const spendRatio = analysis.underThreat ? 0.95 : 0.85;
  let budget = Math.floor(aiPlayer.credits * spendRatio);

  // Count how many fortified planets we have
  const fortifiedPlanets = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'fortification')
  );

  // Priority 1: Build fortification on homeworld ALWAYS if missing
  if (analysis.homeworld) {
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

  // Priority 2: Build fortifications on factory planets (protect production)
  for (const factoryPlanet of analysis.planetsWithFactory) {
    const hasFort = factoryPlanet.buildings &&
      factoryPlanet.buildings.some(b => b.type === 'fortification');

    if (!hasFort && budget >= BUILDING_COSTS.fortification) {
      builds.push({
        planetId: factoryPlanet.id,
        type: 'building',
        buildingType: 'fortification'
      });
      budget -= BUILDING_COSTS.fortification;
    }
  }

  // Priority 3: Build factory if we have none (or only one and have lots of planets)
  if (analysis.planetsWithFactory.length === 0 ||
      (analysis.planetsWithFactory.length === 1 && ownedPlanets.length >= 5)) {
    // Find safest planet for factory (furthest from enemies, or has fort already)
    const planetsWithoutFactory = ownedPlanets.filter(p =>
      !p.buildings || !p.buildings.some(b => b.type === 'factory')
    );

    if (planetsWithoutFactory.length > 0 && budget >= BUILDING_COSTS.factory) {
      // Prefer planets that already have fortification
      planetsWithoutFactory.sort((a, b) => {
        const aHasFort = a.buildings && a.buildings.some(b => b.type === 'fortification');
        const bHasFort = b.buildings && b.buildings.some(b => b.type === 'fortification');
        if (aHasFort !== bHasFort) return bHasFort ? 1 : -1;

        // Then by distance to nearest enemy (furthest first)
        if (visibleEnemyPlanets.length > 0) {
          const distA = Math.min(...visibleEnemyPlanets.map(e =>
            Math.sqrt((a.x - e.x) ** 2 + (a.y - e.y) ** 2)
          ));
          const distB = Math.min(...visibleEnemyPlanets.map(e =>
            Math.sqrt((b.x - e.x) ** 2 + (b.y - e.y) ** 2)
          ));
          return distB - distA;
        }
        return 0;
      });

      builds.push({
        planetId: planetsWithoutFactory[0].id,
        type: 'building',
        buildingType: 'factory'
      });
      budget -= BUILDING_COSTS.factory;
    }
  }

  // Priority 4: Build 1-2 more fortifications if we have few
  if (fortifiedPlanets.length < 3 && ownedPlanets.length >= 3) {
    const unfortifiedPlanets = ownedPlanets.filter(p =>
      !p.buildings || !p.buildings.some(b => b.type === 'fortification')
    );

    // Sort by strategic value (homeworld first, then factories, then income)
    unfortifiedPlanets.sort((a, b) => {
      if (a.is_homeworld) return -1;
      if (b.is_homeworld) return 1;

      const aHasFactory = a.buildings && a.buildings.some(b => b.type === 'factory');
      const bHasFactory = b.buildings && b.buildings.some(b => b.type === 'factory');
      if (aHasFactory !== bHasFactory) return bHasFactory ? 1 : -1;

      return (b.base_income || 1) - (a.base_income || 1);
    });

    const fortsToAdd = Math.min(2, unfortifiedPlanets.length);
    for (let i = 0; i < fortsToAdd; i++) {
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

  // Priority 5: Build mining colonies on high-income planets
  const planetsWithoutMining = ownedPlanets.filter(p =>
    !p.buildings || !p.buildings.some(b => b.type === 'mining')
  );

  // Sort by income (highest first)
  planetsWithoutMining.sort((a, b) => (b.base_income || 1) - (a.base_income || 1));

  for (const planet of planetsWithoutMining.slice(0, 2)) {
    if (budget >= BUILDING_COSTS.mining && planet.base_income >= 2) {
      builds.push({
        planetId: planet.id,
        type: 'building',
        buildingType: 'mining'
      });
      budget -= BUILDING_COSTS.mining;
    }
  }

  // Priority 6: Build mechs with remaining budget (ONE mech per factory per turn)
  // Prefer combat mechs (medium/heavy) over light
  const usedFactories = new Set();

  for (const factoryPlanet of analysis.planetsWithFactory) {
    if (usedFactories.has(factoryPlanet.id)) continue;

    // Determine best mech to build based on budget
    let mechType = analysis.preferredMechType;

    // If we can't afford preferred, try to get the best we can
    const costs = [
      { type: 'assault', cost: MECH_TYPES.assault.cost },
      { type: 'heavy', cost: MECH_TYPES.heavy.cost },
      { type: 'medium', cost: MECH_TYPES.medium.cost },
      { type: 'light', cost: MECH_TYPES.light.cost }
    ];

    // Find the best affordable mech (prefer combat mechs)
    for (const { type, cost } of costs) {
      if (budget >= cost) {
        mechType = type;
        break;
      }
    }

    const mechCost = MECH_TYPES[mechType]?.cost || 2;
    if (budget >= mechCost) {
      builds.push({
        planetId: factoryPlanet.id,
        type: 'mech',
        mechType: mechType
      });
      budget -= mechCost;
      usedFactories.add(factoryPlanet.id);
    }
  }

  return builds;
}

/**
 * Generate move orders for AI
 * Strategy: Keep mechs in groups of 3-4, attack enemy worlds when own planets are defended
 */
function generateMoveOrders(gameState, aiPlayer, analysis) {
  const { ownedPlanets, neutralPlanets, visibleEnemyPlanets, ownedMechs, visibleEnemyMechs, gridSize, lostHomeworld } = gameState;
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

  // Determine which planets are "sufficiently defended" (fortification + at least 1 mech)
  const defendedPlanets = [];
  const undefendedPlanets = [];

  for (const planet of ownedPlanets) {
    const hasFort = planet.buildings && planet.buildings.some(b => b.type === 'fortification');
    const mechsOnPlanet = ownedMechs.filter(m => m.x === planet.x && m.y === planet.y);

    if (hasFort && mechsOnPlanet.length >= 1) {
      defendedPlanets.push({ planet, mechs: mechsOnPlanet });
    } else {
      undefendedPlanets.push({ planet, mechs: mechsOnPlanet, hasFort });
    }
  }

  // Count available mechs for offense (not needed for defense)
  const mechsForOffense = [];
  const mechsForDefense = [];

  for (const mech of ownedMechs) {
    const isOnDefendedPlanet = defendedPlanets.some(dp =>
      mech.x === dp.planet.x && mech.y === dp.planet.y
    );

    if (isOnDefendedPlanet) {
      // Keep 1 mech for garrison, rest can attack
      const dp = defendedPlanets.find(d => mech.x === d.planet.x && mech.y === d.planet.y);
      const mechsHere = dp.mechs;
      const mechIndex = mechsHere.findIndex(m => m.id === mech.id);

      if (mechIndex === 0) {
        // First mech stays for garrison
        mechsForDefense.push(mech);
      } else {
        // Additional mechs can attack
        mechsForOffense.push(mech);
      }
    } else {
      // Mechs not on defended planets - check if needed for defense
      const nearestUndefended = undefendedPlanets.find(up =>
        mech.x === up.planet.x && mech.y === up.planet.y
      );

      if (nearestUndefended && nearestUndefended.hasFort && nearestUndefended.mechs.length === 0) {
        // Planet has fort but no mech - this mech should garrison
        mechsForDefense.push(mech);
      } else {
        mechsForOffense.push(mech);
      }
    }
  }

  // HIGHEST PRIORITY: Reclaim lost homeworld
  if (analysis.needsToReclaimHomeworld && analysis.canReclaimHomeworldNow && lostHomeworld) {
    if (lostHomeworld.isUndefended) {
      // Send ANY available mech to reclaim undefended homeworld
      for (const mech of ownedMechs) {
        if (assignedMechs.has(mech.id)) continue;

        const move = moveToward(mech.x, mech.y, lostHomeworld.x, lostHomeworld.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
          break; // Only need one mech for undefended
        }
      }
    } else {
      // Send combat mechs (medium/heavy/assault) to reclaim defended homeworld
      const combatMechs = ownedMechs.filter(m => m.type !== 'light');
      for (const mech of combatMechs) {
        if (assignedMechs.has(mech.id)) continue;

        const move = moveToward(mech.x, mech.y, lostHomeworld.x, lostHomeworld.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
        }
      }
    }
  }

  // Priority 1: ATTACK enemy planets aggressively
  // Form attack groups of 3-4 mechs and send them to enemy planets
  if (visibleEnemyPlanets.length > 0) {
    // Sort enemy planets by priority (unfortified first, then closest)
    const sortedEnemyPlanets = [...visibleEnemyPlanets].sort((a, b) => {
      const aHasFort = a.buildings && a.buildings.some(b => b.type === 'fortification');
      const bHasFort = b.buildings && b.buildings.some(b => b.type === 'fortification');
      if (aHasFort !== bHasFort) return aHasFort ? 1 : -1;

      // Then by distance to nearest owned planet
      const distA = Math.min(...ownedPlanets.map(p =>
        Math.sqrt((a.x - p.x) ** 2 + (a.y - p.y) ** 2)
      ));
      const distB = Math.min(...ownedPlanets.map(p =>
        Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2)
      ));
      return distA - distB;
    });

    // For each enemy planet, try to form and send an attack group
    for (const targetPlanet of sortedEnemyPlanets) {
      const targetHasFort = targetPlanet.buildings &&
        targetPlanet.buildings.some(b => b.type === 'fortification');

      // Determine required group size
      const requiredSize = targetHasFort ? 4 : 3;

      // Find unassigned mechs that can form a group toward this target
      // Prefer combat mechs (non-light) for fortified targets
      const availableMechs = ownedMechs.filter(m => {
        if (assignedMechs.has(m.id)) return false;
        if (targetHasFort && m.type === 'light') return false;
        return true;
      });

      // Sort by distance to target
      availableMechs.sort((a, b) => {
        const distA = Math.sqrt((a.x - targetPlanet.x) ** 2 + (a.y - targetPlanet.y) ** 2);
        const distB = Math.sqrt((b.x - targetPlanet.x) ** 2 + (b.y - targetPlanet.y) ** 2);
        return distA - distB;
      });

      // Take up to requiredSize mechs for this attack group
      const attackGroup = availableMechs.slice(0, requiredSize);

      // Only send if we have at least 3 mechs (or 2 for unfortified)
      const minSize = targetHasFort ? 3 : 2;
      if (attackGroup.length >= minSize) {
        for (const mech of attackGroup) {
          const move = moveToward(mech.x, mech.y, targetPlanet.x, targetPlanet.y, gridSize);
          if (move) {
            moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
            assignedMechs.add(mech.id);
          }
        }
      }
    }
  }

  // Priority 2: Rally unassigned mechs to form groups
  // Find mechs that aren't in groups of 3+ and move them toward each other
  const unassignedMechs = ownedMechs.filter(m => !assignedMechs.has(m.id));

  if (unassignedMechs.length >= 2) {
    // Find the largest group of unassigned mechs
    const unassignedByLocation = {};
    for (const mech of unassignedMechs) {
      const key = `${mech.x},${mech.y}`;
      if (!unassignedByLocation[key]) {
        unassignedByLocation[key] = [];
      }
      unassignedByLocation[key].push(mech);
    }

    // Find rally point (location with most unassigned mechs, or nearest owned planet)
    let rallyPoint = null;
    let maxCount = 0;

    for (const [loc, mechs] of Object.entries(unassignedByLocation)) {
      if (mechs.length > maxCount) {
        maxCount = mechs.length;
        const [x, y] = loc.split(',').map(Number);
        rallyPoint = { x, y };
      }
    }

    // If no good rally point, use the nearest fortified planet
    if (maxCount < 2 && defendedPlanets.length > 0) {
      rallyPoint = { x: defendedPlanets[0].planet.x, y: defendedPlanets[0].planet.y };
    }

    if (rallyPoint) {
      // Move scattered mechs toward rally point (but not mechs already there)
      for (const mech of unassignedMechs) {
        if (assignedMechs.has(mech.id)) continue;
        if (mech.x === rallyPoint.x && mech.y === rallyPoint.y) continue;

        const move = moveToward(mech.x, mech.y, rallyPoint.x, rallyPoint.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
        }
      }
    }
  }

  // Priority 3: Expand to neutral planets (use light mechs or small groups)
  if (neutralPlanets.length > 0) {
    // Sort neutral planets by distance
    const sortedNeutrals = [...neutralPlanets].sort((a, b) => {
      if (ownedPlanets.length === 0) return 0;
      const distA = Math.min(...ownedPlanets.map(p =>
        Math.sqrt((a.x - p.x) ** 2 + (a.y - p.y) ** 2)
      ));
      const distB = Math.min(...ownedPlanets.map(p =>
        Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2)
      ));
      return distA - distB;
    });

    // Send 1 mech to each nearby neutral (prefer light mechs)
    for (const neutralPlanet of sortedNeutrals.slice(0, 2)) {
      // Find nearest unassigned mech (prefer light)
      let nearestMech = null;
      let nearestDist = Infinity;

      for (const mech of ownedMechs) {
        if (assignedMechs.has(mech.id)) continue;

        const dist = Math.sqrt(
          (mech.x - neutralPlanet.x) ** 2 +
          (mech.y - neutralPlanet.y) ** 2
        );

        // Prefer light mechs with a distance bonus
        const adjustedDist = mech.type === 'light' ? dist * 0.5 : dist;

        if (adjustedDist < nearestDist) {
          nearestDist = adjustedDist;
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

  // Priority 4: Garrison undefended planets that have fortifications
  for (const { planet, hasFort } of undefendedPlanets) {
    if (!hasFort) continue; // Only prioritize planets with forts

    const mechsOnPlanet = ownedMechs.filter(m =>
      m.x === planet.x && m.y === planet.y && !assignedMechs.has(m.id)
    );

    if (mechsOnPlanet.length > 0) continue; // Already has garrison

    // Find nearest unassigned mech
    let nearestMech = null;
    let nearestDist = Infinity;

    for (const mech of ownedMechs) {
      if (assignedMechs.has(mech.id)) continue;

      const dist = Math.sqrt(
        (mech.x - planet.x) ** 2 +
        (mech.y - planet.y) ** 2
      );
      if (dist < nearestDist && dist > 0) {
        nearestDist = dist;
        nearestMech = mech;
      }
    }

    if (nearestMech) {
      const move = moveToward(nearestMech.x, nearestMech.y, planet.x, planet.y, gridSize);
      if (move) {
        moves.push({ mechId: nearestMech.id, toX: move.x, toY: move.y });
        assignedMechs.add(nearestMech.id);
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
