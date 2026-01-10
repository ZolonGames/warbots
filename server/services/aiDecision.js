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

  // Check if we're dominating - have significantly more planets/mechs than visible enemies
  // This is used to trigger more aggressive behavior
  const isDominating = planetCount >= 8 && visibleEnemyCount > 0 && planetCount >= visibleEnemyCount * 2;

  // Check if any enemy is weak (1-3 visible planets) - these should be finished off
  const enemyPlanetsByOwner = {};
  for (const planet of visibleEnemyPlanets) {
    enemyPlanetsByOwner[planet.owner_id] = (enemyPlanetsByOwner[planet.owner_id] || 0) + 1;
  }
  const weakEnemies = Object.entries(enemyPlanetsByOwner)
    .filter(([ownerId, count]) => count <= 3)
    .map(([ownerId]) => parseInt(ownerId));
  const hasWeakEnemy = weakEnemies.length > 0;

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
    canReclaimHomeworldNow,
    isDominating,
    hasWeakEnemy,
    weakEnemies
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
  // Build a mix of combat mechs and scouts (light mechs for exploration)
  const usedFactories = new Set();

  // Count current light mechs - need at least 2-3 for scouting
  const lightMechCount = analysis.mechCounts.light || 0;
  const needScouts = lightMechCount < 3;

  for (const factoryPlanet of analysis.planetsWithFactory) {
    if (usedFactories.has(factoryPlanet.id)) continue;

    // Determine best mech to build based on budget and needs
    let mechType = analysis.preferredMechType;

    // If we need scouts, build a light mech from the first available factory
    if (needScouts && usedFactories.size === 0 && budget >= MECH_TYPES.light.cost) {
      mechType = 'light';
    } else {
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

  // FINISHING BLOW: If enemy has only 1-2 planets visible, send ALL available mechs to attack
  // This ensures we don't let weak enemies survive indefinitely
  if (analysis.hasWeakEnemy && visibleEnemyPlanets.length > 0) {
    // Find planets belonging to weak enemies (1-3 planets)
    const weakEnemyPlanets = visibleEnemyPlanets.filter(p =>
      analysis.weakEnemies.includes(p.owner_id)
    );

    if (weakEnemyPlanets.length > 0 && weakEnemyPlanets.length <= 2) {
      // Very weak enemy - send everyone to finish them off!
      // Sort by unfortified first
      weakEnemyPlanets.sort((a, b) => {
        const aHasFort = a.buildings && a.buildings.some(b => b.type === 'fortification');
        const bHasFort = b.buildings && b.buildings.some(b => b.type === 'fortification');
        if (aHasFort !== bHasFort) return aHasFort ? 1 : -1;
        return 0;
      });

      const targetPlanet = weakEnemyPlanets[0];

      // Send ALL unassigned mechs to attack this target
      for (const mech of ownedMechs) {
        if (assignedMechs.has(mech.id)) continue;

        // Skip mechs that are the sole garrison of a fortified planet (keep 1 defender)
        const isOnFortifiedPlanet = defendedPlanets.some(dp =>
          mech.x === dp.planet.x && mech.y === dp.planet.y
        );
        if (isOnFortifiedPlanet) {
          const dp = defendedPlanets.find(d => mech.x === d.planet.x && mech.y === d.planet.y);
          const mechsHere = dp.mechs.filter(m => !assignedMechs.has(m.id));
          if (mechsHere.length <= 1) continue; // Keep at least 1 garrison
        }

        const move = moveToward(mech.x, mech.y, targetPlanet.x, targetPlanet.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
        }
      }
    }
  }

  // SCOUTING/RAIDING: Categorize enemy planets by defense level and send appropriate forces
  // - Undefended (no mechs, no fort): send 1 light mech to capture
  // - Fortified only (no mechs, has fort): send 3-4 mechs
  // - Defended (has mechs): use normal attack rules
  if (visibleEnemyPlanets.length > 0) {
    // Check each enemy planet for defenders
    for (const enemyPlanet of visibleEnemyPlanets) {
      const hasFort = enemyPlanet.buildings && enemyPlanet.buildings.some(b => b.type === 'fortification');
      const enemyMechsOnPlanet = visibleEnemyMechs.filter(m =>
        m.x === enemyPlanet.x && m.y === enemyPlanet.y
      );
      const hasMechDefenders = enemyMechsOnPlanet.length > 0;

      if (!hasMechDefenders && !hasFort) {
        // UNDEFENDED: Send 1 light mech to capture (or any mech if no light available)
        let scoutMech = null;
        let bestDist = Infinity;

        for (const mech of ownedMechs) {
          if (assignedMechs.has(mech.id)) continue;

          const dist = Math.sqrt(
            (mech.x - enemyPlanet.x) ** 2 + (mech.y - enemyPlanet.y) ** 2
          );

          // Strongly prefer light mechs (halve their effective distance)
          const effectiveDist = mech.type === 'light' ? dist * 0.3 : dist;

          if (effectiveDist < bestDist) {
            bestDist = effectiveDist;
            scoutMech = mech;
          }
        }

        if (scoutMech) {
          const move = moveToward(scoutMech.x, scoutMech.y, enemyPlanet.x, enemyPlanet.y, gridSize);
          if (move) {
            moves.push({ mechId: scoutMech.id, toX: move.x, toY: move.y });
            assignedMechs.add(scoutMech.id);
          }
        }
      } else if (!hasMechDefenders && hasFort) {
        // FORTIFIED BUT UNGARRISONED: Send 3-4 mechs to overwhelm the fortification
        const FORT_RAID_MIN = 3;
        const FORT_RAID_MAX = 4;

        // Find nearby unassigned mechs
        const nearbyMechs = ownedMechs
          .filter(m => !assignedMechs.has(m.id))
          .map(m => ({
            mech: m,
            dist: Math.sqrt((m.x - enemyPlanet.x) ** 2 + (m.y - enemyPlanet.y) ** 2)
          }))
          .sort((a, b) => a.dist - b.dist);

        // Only proceed if we have enough mechs available
        if (nearbyMechs.length >= FORT_RAID_MIN) {
          const raidGroup = nearbyMechs.slice(0, FORT_RAID_MAX);

          for (const { mech } of raidGroup) {
            const move = moveToward(mech.x, mech.y, enemyPlanet.x, enemyPlanet.y, gridSize);
            if (move) {
              moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
              assignedMechs.add(mech.id);
            }
          }
        }
      }
      // Planets with mech defenders will be handled by normal attack logic below
    }
  }

  // Priority 1: ATTACK enemy planets with grouped forces (for mech-defended planets)
  // When dominating or facing weak enemies, be more aggressive (smaller groups attack)
  const MIN_ATTACK_GROUP = (analysis.isDominating || analysis.hasWeakEnemy) ? 2 : 4;
  const MAX_ATTACK_GROUP = 8;
  const IDEAL_ATTACK_GROUP = 4;

  if (visibleEnemyPlanets.length > 0) {
    // Filter to only mech-defended planets (undefended/fort-only handled above)
    const mechDefendedPlanets = visibleEnemyPlanets.filter(p => {
      const enemyMechsOnPlanet = visibleEnemyMechs.filter(m => m.x === p.x && m.y === p.y);
      return enemyMechsOnPlanet.length > 0;
    });

    // Sort enemy planets by priority:
    // 1. Weak enemy planets first (finish them off!)
    // 2. Unfortified planets
    // 3. Closest planets
    const sortedEnemyPlanets = [...mechDefendedPlanets].sort((a, b) => {
      // Prioritize weak enemy planets
      const aIsWeakEnemy = analysis.weakEnemies.includes(a.owner_id);
      const bIsWeakEnemy = analysis.weakEnemies.includes(b.owner_id);
      if (aIsWeakEnemy !== bIsWeakEnemy) return aIsWeakEnemy ? -1 : 1;

      const aHasFort = a.buildings && a.buildings.some(b => b.type === 'fortification');
      const bHasFort = b.buildings && b.buildings.some(b => b.type === 'fortification');
      if (aHasFort !== bHasFort) return aHasFort ? 1 : -1;

      if (ownedPlanets.length === 0) return 0;
      const distA = Math.min(...ownedPlanets.map(p =>
        Math.sqrt((a.x - p.x) ** 2 + (a.y - p.y) ** 2)
      ));
      const distB = Math.min(...ownedPlanets.map(p =>
        Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2)
      ));
      return distA - distB;
    });

    // Find all locations with grouped mechs (4+ at same tile)
    for (const [loc, mechs] of Object.entries(mechsByLocation)) {
      const availableMechs = mechs.filter(m => !assignedMechs.has(m.id));
      if (availableMechs.length >= MIN_ATTACK_GROUP) {
        const [x, y] = loc.split(',').map(Number);

        // Find nearest enemy planet to this group
        let nearestEnemy = null;
        let nearestDist = Infinity;

        for (const enemyPlanet of sortedEnemyPlanets) {
          const dist = Math.sqrt((x - enemyPlanet.x) ** 2 + (y - enemyPlanet.y) ** 2);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestEnemy = enemyPlanet;
          }
        }

        if (nearestEnemy) {
          // Send up to MAX_ATTACK_GROUP mechs to attack, leave rest for next group
          const attackGroup = availableMechs.slice(0, MAX_ATTACK_GROUP);

          for (const mech of attackGroup) {
            const move = moveToward(mech.x, mech.y, nearestEnemy.x, nearestEnemy.y, gridSize);
            if (move) {
              moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
              assignedMechs.add(mech.id);
            }
          }
        }
      }
    }
  }

  // HIGH PRIORITY: Always claim neutral planets with light mechs
  // This should happen BEFORE attack grouping to ensure expansion happens
  if (neutralPlanets.length > 0) {
    // Sort neutral planets by distance from nearest mech
    const sortedNeutrals = [...neutralPlanets].sort((a, b) => {
      const distA = Math.min(...ownedMechs.filter(m => !assignedMechs.has(m.id)).map(m =>
        Math.sqrt((a.x - m.x) ** 2 + (a.y - m.y) ** 2)
      ) || [Infinity]);
      const distB = Math.min(...ownedMechs.filter(m => !assignedMechs.has(m.id)).map(m =>
        Math.sqrt((b.x - m.x) ** 2 + (b.y - m.y) ** 2)
      ) || [Infinity]);
      return distA - distB;
    });

    // Claim ALL visible neutral planets - send one light mech to each
    for (const neutralPlanet of sortedNeutrals) {
      // Find nearest unassigned LIGHT mech first, then any mech if no lights available
      let nearestLightMech = null;
      let nearestLightDist = Infinity;
      let nearestAnyMech = null;
      let nearestAnyDist = Infinity;

      for (const mech of ownedMechs) {
        if (assignedMechs.has(mech.id)) continue;

        const dist = Math.sqrt(
          (mech.x - neutralPlanet.x) ** 2 +
          (mech.y - neutralPlanet.y) ** 2
        );

        if (mech.type === 'light' && dist < nearestLightDist) {
          nearestLightDist = dist;
          nearestLightMech = mech;
        }
        if (dist < nearestAnyDist) {
          nearestAnyDist = dist;
          nearestAnyMech = mech;
        }
      }

      // Prefer light mech, but use any mech if no lights available
      const selectedMech = nearestLightMech || nearestAnyMech;

      if (selectedMech) {
        const move = moveToward(selectedMech.x, selectedMech.y, neutralPlanet.x, neutralPlanet.y, gridSize);
        if (move) {
          moves.push({ mechId: selectedMech.id, toX: move.x, toY: move.y });
          assignedMechs.add(selectedMech.id);
        }
      }
    }
  }

  // EXPLORATION: Send light mechs to unexplored areas to discover new planets
  // Always explore, not just in early game
  const explorationTargets = generateExplorationTargets(gameState, ownedMechs, assignedMechs);

  // Send light mechs to explore (more in early game)
  const maxExplorers = analysis.isEarlyGame ? 4 : 2;
  let explorersSent = 0;

  for (const target of explorationTargets) {
    if (explorersSent >= maxExplorers) break;

    // Find nearest unassigned light mech
    let bestMech = null;
    let bestDist = Infinity;

    for (const mech of ownedMechs) {
      if (assignedMechs.has(mech.id)) continue;
      if (mech.type !== 'light') continue; // Only use light mechs for exploration

      const dist = Math.sqrt(
        (mech.x - target.x) ** 2 +
        (mech.y - target.y) ** 2
      );

      if (dist < bestDist) {
        bestDist = dist;
        bestMech = mech;
      }
    }

    if (bestMech) {
      const move = moveToward(bestMech.x, bestMech.y, target.x, target.y, gridSize);
      if (move) {
        moves.push({ mechId: bestMech.id, toX: move.x, toY: move.y });
        assignedMechs.add(bestMech.id);
        explorersSent++;
      }
    }
  }

  // Priority 2: Form attack groups - consolidate mechs to LIMITED rally points
  // Key fix: Only use TOP 2 rally points to force consolidation, not every mech location
  const unassignedMechs = ownedMechs.filter(m => !assignedMechs.has(m.id));

  if (unassignedMechs.length >= 1) {
    // Group unassigned mechs by location
    const unassignedByLocation = {};
    for (const mech of unassignedMechs) {
      const key = `${mech.x},${mech.y}`;
      if (!unassignedByLocation[key]) {
        unassignedByLocation[key] = { x: mech.x, y: mech.y, mechs: [] };
      }
      unassignedByLocation[key].mechs.push(mech);
    }

    // Create candidate rally points from mech locations and fortified planets
    const candidateRallyPoints = [];

    for (const loc of Object.values(unassignedByLocation)) {
      candidateRallyPoints.push(loc);
    }

    // Add fortified planets as candidates
    for (const dp of defendedPlanets) {
      const key = `${dp.planet.x},${dp.planet.y}`;
      if (!unassignedByLocation[key]) {
        candidateRallyPoints.push({ x: dp.planet.x, y: dp.planet.y, mechs: [], isFortified: true });
      } else {
        // Mark existing location as fortified
        unassignedByLocation[key].isFortified = true;
      }
    }

    // Sort: most mechs first, then fortified, then closest to enemies
    candidateRallyPoints.sort((a, b) => {
      if (a.mechs.length !== b.mechs.length) return b.mechs.length - a.mechs.length;
      if (a.isFortified && !b.isFortified) return -1;
      if (!a.isFortified && b.isFortified) return 1;
      // Prefer locations closer to enemy planets
      if (visibleEnemyPlanets.length > 0) {
        const distA = Math.min(...visibleEnemyPlanets.map(e =>
          Math.sqrt((a.x - e.x) ** 2 + (a.y - e.y) ** 2)
        ));
        const distB = Math.min(...visibleEnemyPlanets.map(e =>
          Math.sqrt((b.x - e.x) ** 2 + (b.y - e.y) ** 2)
        ));
        return distA - distB;
      }
      return 0;
    });

    // ONLY use top 2 rally points to force consolidation
    // This prevents mechs from spreading across many small groups
    const MAX_RALLY_POINTS = 2;
    const rallyPoints = candidateRallyPoints.slice(0, MAX_RALLY_POINTS);

    // If we have no rally points but have fortified planets, use one
    if (rallyPoints.length === 0 && defendedPlanets.length > 0) {
      const dp = defendedPlanets[0];
      rallyPoints.push({ x: dp.planet.x, y: dp.planet.y, mechs: [], isFortified: true });
    }

    // Send ALL unassigned mechs to these limited rally points
    for (const mech of unassignedMechs) {
      if (assignedMechs.has(mech.id)) continue;

      // Find best rally point (prefer ones with more mechs, cap at MAX_ATTACK_GROUP)
      let bestRally = null;
      let bestScore = -Infinity;

      for (const rp of rallyPoints) {
        // Skip if already at this rally point
        if (mech.x === rp.x && mech.y === rp.y) continue;

        // Skip if this rally point is full
        if (rp.mechs.length >= MAX_ATTACK_GROUP) continue;

        const dist = Math.sqrt((mech.x - rp.x) ** 2 + (mech.y - rp.y) ** 2);

        // Score: heavily prefer rally points with more mechs (faster to form attack group)
        // mechs.length * 10 gives strong preference to nearly-complete groups
        const score = (rp.mechs.length * 10) - dist;

        if (score > bestScore) {
          bestScore = score;
          bestRally = rp;
        }
      }

      if (bestRally) {
        const move = moveToward(mech.x, mech.y, bestRally.x, bestRally.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
          bestRally.mechs.push(mech);
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
 * Generate exploration targets for discovering new areas of the map
 * Returns array of {x, y} coordinates in unexplored areas, prioritized by distance from owned planets
 */
function generateExplorationTargets(gameState, ownedMechs, assignedMechs) {
  const { visibleTiles, ownedPlanets, gridSize } = gameState;
  const targets = [];

  // Find the bounding box of our territory
  let minX = gridSize, maxX = 0, minY = gridSize, maxY = 0;
  for (const planet of ownedPlanets) {
    minX = Math.min(minX, planet.x);
    maxX = Math.max(maxX, planet.x);
    minY = Math.min(minY, planet.y);
    maxY = Math.max(maxY, planet.y);
  }

  // Also consider mech positions for exploration range
  for (const mech of ownedMechs) {
    minX = Math.min(minX, mech.x);
    maxX = Math.max(maxX, mech.x);
    minY = Math.min(minY, mech.y);
    maxY = Math.max(maxY, mech.y);
  }

  // Generate exploration targets at the edges of our visibility
  // Look for tiles that are just outside our current vision
  const explorationRadius = 8; // How far to look for exploration targets
  const candidateTargets = [];

  // Expand search area beyond our current territory
  const searchMinX = Math.max(0, minX - explorationRadius);
  const searchMaxX = Math.min(gridSize - 1, maxX + explorationRadius);
  const searchMinY = Math.max(0, minY - explorationRadius);
  const searchMaxY = Math.min(gridSize - 1, maxY + explorationRadius);

  // Sample potential exploration points at regular intervals
  const step = 4; // Check every 4 tiles
  for (let x = searchMinX; x <= searchMaxX; x += step) {
    for (let y = searchMinY; y <= searchMaxY; y += step) {
      const key = `${x},${y}`;

      // Skip if already visible
      if (visibleTiles.has(key)) continue;

      // Check if this unexplored tile is adjacent to visible tiles (frontier)
      let isNearVisible = false;
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          const neighborKey = `${x + dx},${y + dy}`;
          if (visibleTiles.has(neighborKey)) {
            isNearVisible = true;
            break;
          }
        }
        if (isNearVisible) break;
      }

      if (isNearVisible) {
        // Calculate distance from nearest owned planet
        let nearestDist = Infinity;
        for (const planet of ownedPlanets) {
          const dist = Math.sqrt((x - planet.x) ** 2 + (y - planet.y) ** 2);
          nearestDist = Math.min(nearestDist, dist);
        }

        candidateTargets.push({ x, y, dist: nearestDist });
      }
    }
  }

  // Sort by distance (closest unexplored areas first)
  candidateTargets.sort((a, b) => a.dist - b.dist);

  // Return top exploration targets
  return candidateTargets.slice(0, 6).map(t => ({ x: t.x, y: t.y }));
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
