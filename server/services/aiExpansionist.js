const { db } = require('../config/database');
const { calculateVisibility, calculateIncome } = require('./visibilityCalc');
const { MECH_TYPES } = require('./mapGenerator');
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

// Constants for expansionist AI
const MAX_SCOUTS = 10;
const ATTACK_FORCE_COMPOSITION = { heavy: 3, assault: 1 };
const ATTACK_FORCE_SIZE = 4; // 3 heavy + 1 assault
const MAX_MECHS_PER_PLANET = 4; // Max mechs to station on any planet
const ENEMY_RESERVE_CREDITS = 25;
const FACTORY_PER_PLANETS = 5;

/**
 * Generate orders for expansionist AI
 * @param {number} gameId - The game ID
 * @param {Object} aiPlayer - The AI player record
 * @returns {Object} Orders object with moves and builds arrays
 */
function generateExpansionistOrders(gameId, aiPlayer) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  const playerId = aiPlayer.id;
  const gridSize = game.grid_size;

  // Get game state
  const gameState = getExpansionistGameState(gameId, playerId, gridSize);

  // Analyze the situation
  const analysis = analyzeExpansionistState(gameState, aiPlayer);

  // Log analysis
  logExpansionistAnalysis(aiPlayer.empire_name, analysis);

  const orders = {
    moves: [],
    builds: []
  };

  // Generate build orders first
  orders.builds = generateExpansionistBuilds(gameState, aiPlayer, analysis);

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
  orders.moves = generateExpansionistMoves(gameState, aiPlayer, analysis);

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
function getExpansionistGameState(gameId, playerId, gridSize) {
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
 * Analyze the game state for expansionist AI
 */
function analyzeExpansionistState(gameState, aiPlayer) {
  const { ownedPlanets, ownedMechs, visibleEnemyPlanets, visibleEnemyMechs, visibleNeutralPlanets } = gameState;

  // Count mechs by type
  const scoutCount = ownedMechs.filter(m => m.type === 'light').length;
  const heavyCount = ownedMechs.filter(m => m.type === 'heavy').length;
  const assaultCount = ownedMechs.filter(m => m.type === 'assault').length;

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

  // Planets without defenses (only relevant after encountering enemy)
  const planetsNeedingDefense = hasEncounteredEnemy ? ownedPlanets.filter(p =>
    !p.buildings || !p.buildings.some(b => b.type === 'fortification')
  ) : [];

  // Sort planets needing defense by proximity to nearest enemy
  if (hasEncounteredEnemy && planetsNeedingDefense.length > 0) {
    const allEnemyPositions = [
      ...visibleEnemyPlanets.map(p => ({ x: p.x, y: p.y })),
      ...visibleEnemyMechs.map(m => ({ x: m.x, y: m.y }))
    ];

    if (allEnemyPositions.length > 0) {
      planetsNeedingDefense.sort((a, b) => {
        const distA = Math.min(...allEnemyPositions.map(e =>
          Math.abs(a.x - e.x) + Math.abs(a.y - e.y)
        ));
        const distB = Math.min(...allEnemyPositions.map(e =>
          Math.abs(b.x - e.x) + Math.abs(b.y - e.y)
        ));
        return distA - distB;
      });
    }
  }

  // Calculate how many complete attack forces we have
  const completeAttackForces = Math.min(
    Math.floor(heavyCount / ATTACK_FORCE_COMPOSITION.heavy),
    Math.floor(assaultCount / ATTACK_FORCE_COMPOSITION.assault)
  );

  // Identify attack force mechs (grouped)
  const attackForceMechs = identifyAttackForces(ownedMechs);

  // Factories needed: 1 per 5 planets
  const factoriesNeeded = Math.ceil(ownedPlanets.length / FACTORY_PER_PLANETS);
  const needMoreFactories = factoryCount < factoriesNeeded;

  // Count attack mechs on each planet to check if we're at capacity
  const attackMechCount = heavyCount + assaultCount;
  const maxAttackMechCapacity = ownedPlanets.length * MAX_MECHS_PER_PLANET;
  const allPlanetsCovered = attackMechCount >= maxAttackMechCapacity;

  return {
    scoutCount,
    heavyCount,
    assaultCount,
    needMoreScouts: scoutCount < MAX_SCOUTS,
    hasEncounteredEnemy,
    income,
    credits: aiPlayer.credits,
    factoryCount,
    needMoreFactories,
    factoriesNeeded,
    planetsNeedingMining,
    planetsNeedingDefense,
    completeAttackForces,
    attackForceMechs,
    ownedPlanetCount: ownedPlanets.length,
    allPlanetsCovered,
    attackMechCount,
    maxAttackMechCapacity
  };
}

/**
 * Identify attack forces - groups of 3 heavy + 1 assault at the same location
 */
function identifyAttackForces(ownedMechs) {
  // Group mechs by location
  const mechsByLocation = {};
  for (const mech of ownedMechs) {
    if (mech.type !== 'heavy' && mech.type !== 'assault') continue;
    const key = `${mech.x},${mech.y}`;
    if (!mechsByLocation[key]) {
      mechsByLocation[key] = { heavies: [], assaults: [] };
    }
    if (mech.type === 'heavy') {
      mechsByLocation[key].heavies.push(mech);
    } else {
      mechsByLocation[key].assaults.push(mech);
    }
  }

  // Find complete attack forces
  const attackForces = [];
  for (const [loc, mechs] of Object.entries(mechsByLocation)) {
    while (mechs.heavies.length >= 3 && mechs.assaults.length >= 1) {
      const [x, y] = loc.split(',').map(Number);
      attackForces.push({
        x, y,
        mechs: [
          ...mechs.heavies.splice(0, 3),
          ...mechs.assaults.splice(0, 1)
        ]
      });
    }
  }

  return attackForces;
}

/**
 * Generate build orders for expansionist AI
 */
function generateExpansionistBuilds(gameState, aiPlayer, analysis) {
  const builds = [];
  let availableCredits = aiPlayer.credits;
  const { ownedPlanets, visibleEnemyPlanets, visibleEnemyMechs } = gameState;

  // Reserve credits for defense if we've seen enemies
  const reserveCredits = analysis.hasEncounteredEnemy ? ENEMY_RESERVE_CREDITS : 0;

  // Get planets with factories for mech building
  const planetsWithFactory = ownedPlanets.filter(p =>
    p.buildings && p.buildings.some(b => b.type === 'factory')
  );
  const usedFactories = new Set();

  // Priority 1: Build scouts if we need them (up to 10)
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

  // Priority 2: Build attack force mechs (after 10 scouts, only if not at capacity)
  if (!analysis.needMoreScouts && planetsWithFactory.length > 0 && !analysis.allPlanetsCovered) {
    // Determine what we need for the next attack force
    const currentHeavies = analysis.heavyCount;
    const currentAssaults = analysis.assaultCount;
    const pendingHeavies = builds.filter(b => b.mechType === 'heavy').length;
    const pendingAssaults = builds.filter(b => b.mechType === 'assault').length;

    // Build assault first if we need one, then heavies
    const needAssault = (currentAssaults + pendingAssaults) < Math.ceil((currentHeavies + pendingHeavies + 1) / 3);

    for (const planet of planetsWithFactory) {
      if (usedFactories.has(planet.id)) continue;

      // Check if we'd still be under capacity with this build
      const currentAttackCount = analysis.attackMechCount + builds.filter(b => b.mechType === 'heavy' || b.mechType === 'assault').length;
      if (currentAttackCount >= analysis.maxAttackMechCapacity) break;

      if (needAssault && availableCredits - reserveCredits >= MECH_COSTS.assault) {
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
  }

  // Priority 3: Build mining colonies on planets without them
  if (analysis.planetsNeedingMining.length > 0 && availableCredits - reserveCredits >= BUILDING_COSTS.mining) {
    const planet = analysis.planetsNeedingMining[0];
    builds.push({
      planetId: planet.id,
      type: 'building',
      buildingType: 'mining'
    });
    availableCredits -= BUILDING_COSTS.mining;
  }

  // Priority 4: Build factories if needed (1 per 5 planets)
  if (analysis.needMoreFactories && availableCredits - reserveCredits >= BUILDING_COSTS.factory) {
    // Find a planet without a factory
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

  // Priority 5: Build defenses after encountering enemy (use reserve credits)
  if (analysis.hasEncounteredEnemy && analysis.planetsNeedingDefense.length > 0) {
    if (availableCredits >= BUILDING_COSTS.fortification) {
      const planet = analysis.planetsNeedingDefense[0];
      builds.push({
        planetId: planet.id,
        type: 'building',
        buildingType: 'fortification'
      });
      availableCredits -= BUILDING_COSTS.fortification;
    }
  }

  return builds;
}

/**
 * Generate move orders for expansionist AI
 */
function generateExpansionistMoves(gameState, aiPlayer, analysis) {
  const moves = [];
  const assignedMechs = new Set();
  const { gridSize, ownedPlanets, ownedMechs, visibleNeutralPlanets, visibleEnemyPlanets, visibleEnemyMechs, visibleTiles } = gameState;

  // Separate scouts from attack force mechs
  const scouts = ownedMechs.filter(m => m.type === 'light');
  const attackMechs = ownedMechs.filter(m => m.type === 'heavy' || m.type === 'assault');

  // === SCOUT LOGIC ===
  // Scouts explore and claim undefended planets

  // Find claimable planets (neutral or enemy with no mechs on them)
  const claimablePlanets = [
    ...visibleNeutralPlanets,
    ...visibleEnemyPlanets.filter(p => {
      const mechsOnPlanet = visibleEnemyMechs.filter(m => m.x === p.x && m.y === p.y);
      return mechsOnPlanet.length === 0;
    })
  ];

  // Assign scouts to claim nearby planets first
  const claimedTargets = new Set();
  for (const scout of scouts) {
    if (assignedMechs.has(scout.id)) continue;

    // Check if there's a claimable planet within range
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

  // Remaining scouts explore unexplored areas
  for (const scout of scouts) {
    if (assignedMechs.has(scout.id)) continue;

    const exploreTarget = findExploreTarget(scout, visibleTiles, gridSize, ownedMechs, assignedMechs, ownedPlanets);
    if (exploreTarget) {
      const move = moveToward(scout.x, scout.y, exploreTarget.x, exploreTarget.y, gridSize);
      if (move) {
        moves.push({ mechId: scout.id, toX: move.x, toY: move.y });
        assignedMechs.add(scout.id);
      }
    }
  }

  // === ATTACK FORCE LOGIC ===
  const hasEnemies = visibleEnemyPlanets.length > 0 || visibleEnemyMechs.length > 0;

  // Count attack mechs on each planet
  const mechsPerPlanet = new Map();
  for (const planet of ownedPlanets) {
    const key = `${planet.x},${planet.y}`;
    mechsPerPlanet.set(key, []);
  }
  for (const mech of attackMechs) {
    const key = `${mech.x},${mech.y}`;
    if (mechsPerPlanet.has(key)) {
      mechsPerPlanet.get(key).push(mech);
    }
  }

  // Find planets that need mechs (under limit) and planets with excess
  const planetsNeedingMechs = ownedPlanets.filter(p => {
    const key = `${p.x},${p.y}`;
    return mechsPerPlanet.get(key).length < MAX_MECHS_PER_PLANET;
  });

  if (hasEnemies) {
    // Build target list with priorities
    const targets = buildTargetList(gameState, ownedPlanets);

    // Get attack forces (groups of mechs at same location)
    const attackForces = identifyAttackForces(attackMechs.filter(m => !assignedMechs.has(m.id)));

    // Assign attack forces to targets (no doubling up)
    const assignedTargets = new Set();

    for (const target of targets) {
      if (attackForces.length === 0) break;

      const targetKey = `${target.x},${target.y}`;
      if (assignedTargets.has(targetKey)) continue;

      // Find closest attack force to this target
      let closestForce = null;
      let closestDist = Infinity;
      let closestIdx = -1;

      for (let i = 0; i < attackForces.length; i++) {
        const force = attackForces[i];
        const dist = Math.abs(force.x - target.x) + Math.abs(force.y - target.y);
        if (dist < closestDist) {
          closestDist = dist;
          closestForce = force;
          closestIdx = i;
        }
      }

      if (closestForce) {
        // Move all mechs in this force toward the target
        for (const mech of closestForce.mechs) {
          if (assignedMechs.has(mech.id)) continue;
          const move = moveToward(mech.x, mech.y, target.x, target.y, gridSize);
          if (move) {
            moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
            assignedMechs.add(mech.id);
          }
        }

        assignedTargets.add(targetKey);
        attackForces.splice(closestIdx, 1);
      }
    }

    // Move excess mechs from overcrowded planets to planets that need them
    for (const planet of ownedPlanets) {
      const key = `${planet.x},${planet.y}`;
      const mechsHere = mechsPerPlanet.get(key).filter(m => !assignedMechs.has(m.id));

      if (mechsHere.length > MAX_MECHS_PER_PLANET) {
        const excess = mechsHere.slice(MAX_MECHS_PER_PLANET);

        for (const mech of excess) {
          if (assignedMechs.has(mech.id)) continue;

          // Find nearest planet that needs mechs
          let bestPlanet = null;
          let bestDist = Infinity;

          for (const targetPlanet of planetsNeedingMechs) {
            const targetKey = `${targetPlanet.x},${targetPlanet.y}`;
            if (targetKey === key) continue;

            const currentCount = mechsPerPlanet.get(targetKey).length;
            if (currentCount >= MAX_MECHS_PER_PLANET) continue;

            const dist = Math.abs(mech.x - targetPlanet.x) + Math.abs(mech.y - targetPlanet.y);
            if (dist < bestDist) {
              bestDist = dist;
              bestPlanet = targetPlanet;
            }
          }

          if (bestPlanet) {
            const move = moveToward(mech.x, mech.y, bestPlanet.x, bestPlanet.y, gridSize);
            if (move) {
              moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
              assignedMechs.add(mech.id);
              mechsPerPlanet.get(`${bestPlanet.x},${bestPlanet.y}`).push(mech);
            }
          }
        }
      }
    }

    // Unassigned attack mechs move toward nearest planet that needs mechs
    for (const mech of attackMechs) {
      if (assignedMechs.has(mech.id)) continue;

      // Find nearest planet that could use more mechs
      let nearestPlanet = null;
      let nearestDist = Infinity;

      for (const planet of ownedPlanets) {
        const key = `${planet.x},${planet.y}`;
        const currentCount = mechsPerPlanet.get(key)?.length || 0;
        if (currentCount >= MAX_MECHS_PER_PLANET) continue;

        const dist = Math.abs(mech.x - planet.x) + Math.abs(mech.y - planet.y);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestPlanet = planet;
        }
      }

      if (nearestPlanet) {
        const move = moveToward(mech.x, mech.y, nearestPlanet.x, nearestPlanet.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
        }
      }
    }
  } else {
    // No enemies visible - distribute mechs across planets (max 4 per planet)

    // Move mechs from overcrowded planets first
    for (const planet of ownedPlanets) {
      const key = `${planet.x},${planet.y}`;
      const mechsHere = mechsPerPlanet.get(key).filter(m => !assignedMechs.has(m.id));

      if (mechsHere.length > MAX_MECHS_PER_PLANET) {
        const excess = mechsHere.slice(MAX_MECHS_PER_PLANET);

        for (const mech of excess) {
          if (assignedMechs.has(mech.id)) continue;

          // Find nearest planet that needs mechs
          let bestPlanet = null;
          let bestDist = Infinity;

          for (const targetPlanet of planetsNeedingMechs) {
            const targetKey = `${targetPlanet.x},${targetPlanet.y}`;
            if (targetKey === key) continue;

            const currentCount = mechsPerPlanet.get(targetKey).length;
            if (currentCount >= MAX_MECHS_PER_PLANET) continue;

            const dist = Math.abs(mech.x - targetPlanet.x) + Math.abs(mech.y - targetPlanet.y);
            if (dist < bestDist) {
              bestDist = dist;
              bestPlanet = targetPlanet;
            }
          }

          if (bestPlanet) {
            const move = moveToward(mech.x, mech.y, bestPlanet.x, bestPlanet.y, gridSize);
            if (move) {
              moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
              assignedMechs.add(mech.id);
              mechsPerPlanet.get(`${bestPlanet.x},${bestPlanet.y}`).push(mech);
            }
          }
        }
      }
    }

    // Move unstationed mechs (in space) to planets that need them
    for (const mech of attackMechs) {
      if (assignedMechs.has(mech.id)) continue;

      // Check if already on a planet
      const onPlanet = ownedPlanets.find(p => p.x === mech.x && p.y === mech.y);
      if (onPlanet) {
        const key = `${onPlanet.x},${onPlanet.y}`;
        const count = mechsPerPlanet.get(key)?.length || 0;
        if (count <= MAX_MECHS_PER_PLANET) {
          assignedMechs.add(mech.id);
          continue;
        }
      }

      // Find nearest planet that needs mechs
      let nearestPlanet = null;
      let nearestDist = Infinity;

      for (const planet of ownedPlanets) {
        const key = `${planet.x},${planet.y}`;
        const currentCount = mechsPerPlanet.get(key)?.length || 0;
        if (currentCount >= MAX_MECHS_PER_PLANET) continue;

        const dist = Math.abs(mech.x - planet.x) + Math.abs(mech.y - planet.y);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestPlanet = planet;
        }
      }

      if (nearestPlanet) {
        const move = moveToward(mech.x, mech.y, nearestPlanet.x, nearestPlanet.y, gridSize);
        if (move) {
          moves.push({ mechId: mech.id, toX: move.x, toY: move.y });
          assignedMechs.add(mech.id);
          mechsPerPlanet.get(`${nearestPlanet.x},${nearestPlanet.y}`).push(mech);
        }
      }
    }
  }

  return moves;
}

/**
 * Build prioritized target list for attack forces
 * Priority: 1. Enemy mechs within 3 squares of own planet
 *           2. Enemy planets
 *           3. Enemy mechs in open space
 */
function buildTargetList(gameState, ownedPlanets) {
  const { visibleEnemyPlanets, visibleEnemyMechs } = gameState;
  const targets = [];

  // Priority 1: Enemy mechs within 3 squares of our planets
  for (const mech of visibleEnemyMechs) {
    const nearOwnPlanet = ownedPlanets.some(p =>
      Math.abs(p.x - mech.x) + Math.abs(p.y - mech.y) <= 3
    );
    if (nearOwnPlanet) {
      targets.push({
        x: mech.x,
        y: mech.y,
        priority: 1,
        type: 'mech_threat'
      });
    }
  }

  // Priority 2: Enemy planets
  for (const planet of visibleEnemyPlanets) {
    targets.push({
      x: planet.x,
      y: planet.y,
      priority: 2,
      type: 'enemy_planet'
    });
  }

  // Priority 3: Enemy mechs in open space (not near our planets)
  for (const mech of visibleEnemyMechs) {
    const nearOwnPlanet = ownedPlanets.some(p =>
      Math.abs(p.x - mech.x) + Math.abs(p.y - mech.y) <= 3
    );
    if (!nearOwnPlanet) {
      targets.push({
        x: mech.x,
        y: mech.y,
        priority: 3,
        type: 'mech_open'
      });
    }
  }

  // Sort by priority
  targets.sort((a, b) => a.priority - b.priority);

  // Deduplicate by location
  const seen = new Set();
  return targets.filter(t => {
    const key = `${t.x},${t.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Find an unexplored area to send a scout toward
 */
function findExploreTarget(scout, visibleTiles, gridSize, allMechs, assignedMechs, ownedPlanets) {
  // Find tiles that are NOT visible (unexplored)
  // Pick a direction that leads toward unexplored territory

  const directions = [
    { dx: 0, dy: -1 },  // up
    { dx: 0, dy: 1 },   // down
    { dx: -1, dy: 0 },  // left
    { dx: 1, dy: 0 },   // right
    { dx: -1, dy: -1 }, // up-left
    { dx: 1, dy: -1 },  // up-right
    { dx: -1, dy: 1 },  // down-left
    { dx: 1, dy: 1 }    // down-right
  ];

  // Shuffle directions to add variety
  for (let i = directions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [directions[i], directions[j]] = [directions[j], directions[i]];
  }

  let bestDir = null;
  let bestUnexploredCount = 0;

  for (const dir of directions) {
    // Look 5 tiles in this direction and count unexplored tiles
    let unexploredCount = 0;
    for (let dist = 1; dist <= 5; dist++) {
      const checkX = scout.x + dir.dx * dist;
      const checkY = scout.y + dir.dy * dist;

      if (checkX < 0 || checkX >= gridSize || checkY < 0 || checkY >= gridSize) break;

      if (!visibleTiles.has(`${checkX},${checkY}`)) {
        unexploredCount++;
      }
    }

    // Check if another mech is already heading this direction
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

  // If no unexplored areas, move toward map center if not already there
  const centerX = Math.floor(gridSize / 2);
  const centerY = Math.floor(gridSize / 2);
  const distToCenter = Math.abs(scout.x - centerX) + Math.abs(scout.y - centerY);

  if (distToCenter > 3) {
    return { x: centerX, y: centerY };
  }

  // Already near center - find any valid direction to keep moving (patrol behavior)
  for (const dir of directions) {
    const newX = scout.x + dir.dx;
    const newY = scout.y + dir.dy;

    if (newX < 0 || newX >= gridSize || newY < 0 || newY >= gridSize) continue;

    // Don't pile up on other mechs
    const mechAtTarget = allMechs.some(m =>
      m.id !== scout.id && m.x === newX && m.y === newY
    );

    if (!mechAtTarget) {
      return { x: newX, y: newY };
    }
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

  // Bounds check
  if (newX < 0 || newX >= gridSize || newY < 0 || newY >= gridSize) {
    // Try moving in just one axis
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
 * Log analysis for expansionist AI
 */
function logExpansionistAnalysis(empireName, analysis) {
  aiLogger.log(`  ANALYSIS (Expansionist): ${empireName}`);
  aiLogger.log(`    - Scouts: ${analysis.scoutCount}/${MAX_SCOUTS}`);
  aiLogger.log(`    - Attack Mechs: ${analysis.attackMechCount}/${analysis.maxAttackMechCapacity} capacity (${analysis.heavyCount}H/${analysis.assaultCount}A)`);
  aiLogger.log(`    - All Planets Covered: ${analysis.allPlanetsCovered ? 'YES - stopping production' : 'No'}`);
  aiLogger.log(`    - Factories: ${analysis.factoryCount}/${analysis.factoriesNeeded} needed`);
  aiLogger.log(`    - Credits: ${analysis.credits} (reserve: ${analysis.hasEncounteredEnemy ? ENEMY_RESERVE_CREDITS : 0})`);
  aiLogger.log(`    - Enemy Encountered: ${analysis.hasEncounteredEnemy ? 'YES' : 'No'}`);
  if (analysis.planetsNeedingMining.length > 0) {
    aiLogger.log(`    - Planets needing mining: ${analysis.planetsNeedingMining.length}`);
  }
  if (analysis.planetsNeedingDefense.length > 0) {
    aiLogger.log(`    - Planets needing defense: ${analysis.planetsNeedingDefense.length}`);
  }
}

module.exports = {
  generateExpansionistOrders
};
