const { db } = require('../config/database');

// Vision ranges
const PLANET_VISION_RANGE = 3;
const MECH_VISION_RANGE = 2;

/**
 * Add tiles within a given range to the visible set
 * @param {Set<string>} visibleTiles - Set to add visible tiles to
 * @param {number} centerX - Center X coordinate
 * @param {number} centerY - Center Y coordinate
 * @param {number} range - Vision range
 * @param {number} gridSize - Size of the grid
 */
function addVisibleTilesInRange(visibleTiles, centerX, centerY, range, gridSize) {
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      const newX = centerX + dx;
      const newY = centerY + dy;

      // Check bounds
      if (newX >= 0 && newX < gridSize && newY >= 0 && newY < gridSize) {
        visibleTiles.add(`${newX},${newY}`);
      }
    }
  }
}

/**
 * Calculate which tiles are visible to a player
 * @param {number} gameId - The game ID
 * @param {number} playerId - The game_players ID
 * @param {number} gridSize - Size of the grid
 * @returns {Set<string>} Set of visible tile keys in "x,y" format
 */
function calculateVisibility(gameId, playerId, gridSize) {
  const visibleTiles = new Set();

  // Get all planets owned by the player - vision range 3
  const ownedPlanets = db.prepare(`
    SELECT x, y FROM planets WHERE game_id = ? AND owner_id = ?
  `).all(gameId, playerId);

  for (const planet of ownedPlanets) {
    addVisibleTilesInRange(visibleTiles, planet.x, planet.y, PLANET_VISION_RANGE, gridSize);
  }

  // Get all mechs owned by the player - vision range 2
  const ownedMechs = db.prepare(`
    SELECT DISTINCT x, y FROM mechs WHERE game_id = ? AND owner_id = ?
  `).all(gameId, playerId);

  for (const mech of ownedMechs) {
    addVisibleTilesInRange(visibleTiles, mech.x, mech.y, MECH_VISION_RANGE, gridSize);
  }

  return visibleTiles;
}

/**
 * Get visible planets for a player
 * @param {number} gameId - The game ID
 * @param {number} playerId - The game_players ID
 * @param {Set<string>} visibleTiles - Set of visible tile keys
 * @returns {Array} Array of visible planets with buildings
 */
function getVisiblePlanets(gameId, playerId, visibleTiles) {
  // Get all planets in the game
  const allPlanets = db.prepare(`
    SELECT p.*,
           CASE WHEN p.owner_id = ? THEN 1 ELSE 0 END as is_owned
    FROM planets p
    WHERE p.game_id = ?
  `).all(playerId, gameId);

  // Get all buildings for all planets in one query (fixes N+1 pattern)
  const allBuildings = db.prepare(`
    SELECT b.planet_id, b.type, b.hp,
           CASE WHEN b.type = 'fortification' THEN 30 ELSE 10 END as max_hp
    FROM buildings b
    JOIN planets p ON b.planet_id = p.id
    WHERE p.game_id = ?
  `).all(gameId);

  // Group buildings by planet_id for fast lookup
  const buildingsByPlanet = new Map();
  for (const building of allBuildings) {
    if (!buildingsByPlanet.has(building.planet_id)) {
      buildingsByPlanet.set(building.planet_id, []);
    }
    buildingsByPlanet.get(building.planet_id).push({
      type: building.type,
      hp: building.hp,
      max_hp: building.max_hp
    });
  }

  // Filter to visible planets and add buildings
  const visiblePlanets = [];

  for (const planet of allPlanets) {
    const key = `${planet.x},${planet.y}`;
    if (visibleTiles.has(key)) {
      visiblePlanets.push({
        id: planet.id,
        x: planet.x,
        y: planet.y,
        base_income: planet.base_income,
        owner_id: planet.owner_id,
        is_homeworld: planet.is_homeworld,
        is_owned: planet.is_owned,
        name: planet.name,
        buildings: buildingsByPlanet.get(planet.id) || []
      });
    }
  }

  return visiblePlanets;
}

/**
 * Get visible mechs for a player
 * @param {number} gameId - The game ID
 * @param {number} playerId - The game_players ID
 * @param {Set<string>} visibleTiles - Set of visible tile keys
 * @returns {Array} Array of visible mechs (grouped by tile)
 */
function getVisibleMechs(gameId, playerId, visibleTiles) {
  // Get all mechs in visible tiles
  const allMechs = db.prepare(`
    SELECT m.*,
           CASE WHEN m.owner_id = ? THEN 1 ELSE 0 END as is_owned
    FROM mechs m
    WHERE m.game_id = ?
  `).all(playerId, gameId);

  // Filter to visible mechs
  const visibleMechs = [];

  for (const mech of allMechs) {
    const key = `${mech.x},${mech.y}`;
    if (visibleTiles.has(key)) {
      visibleMechs.push({
        id: mech.id,
        x: mech.x,
        y: mech.y,
        type: mech.type,
        hp: mech.hp,
        max_hp: mech.max_hp,
        owner_id: mech.owner_id,
        is_owned: mech.is_owned,
        designation: mech.designation
      });
    }
  }

  return visibleMechs;
}

/**
 * Calculate player's income
 * @param {number} gameId - The game ID
 * @param {number} playerId - The game_players ID
 * @returns {number} Total income per turn
 */
function calculateIncome(gameId, playerId) {
  // Sum of base income from owned planets
  const baseIncome = db.prepare(`
    SELECT COALESCE(SUM(base_income), 0) as total
    FROM planets
    WHERE game_id = ? AND owner_id = ?
  `).get(gameId, playerId).total;

  // Add mining colony bonuses (+2 per colony)
  const miningBonus = db.prepare(`
    SELECT COUNT(*) * 2 as bonus
    FROM buildings b
    JOIN planets p ON b.planet_id = p.id
    WHERE p.game_id = ? AND p.owner_id = ? AND b.type = 'mining'
  `).get(gameId, playerId).bonus;

  return baseIncome + miningBonus;
}

// Mech maintenance costs per turn (must match turnProcessor.js)
const MAINTENANCE_COSTS = {
  light: 1,
  medium: 2,
  heavy: 3,
  assault: 4
};

/**
 * Calculate detailed income breakdown for a player
 * @param {number} gameId - Game ID
 * @param {number} playerId - Player ID (game_players.id)
 * @returns {Object} Income breakdown with planets, mining, maintenance, and net
 */
function calculateIncomeBreakdown(gameId, playerId) {
  // Sum of base income from owned planets
  const planetIncome = db.prepare(`
    SELECT COALESCE(SUM(base_income), 0) as total
    FROM planets
    WHERE game_id = ? AND owner_id = ?
  `).get(gameId, playerId).total;

  // Mining colony bonuses (+2 per colony)
  const miningCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM buildings b
    JOIN planets p ON b.planet_id = p.id
    WHERE p.game_id = ? AND p.owner_id = ? AND b.type = 'mining'
  `).get(gameId, playerId).count;
  const miningIncome = miningCount * 2;

  // Calculate maintenance costs
  const mechs = db.prepare(`
    SELECT type, COUNT(*) as count
    FROM mechs
    WHERE game_id = ? AND owner_id = ?
    GROUP BY type
  `).all(gameId, playerId);

  let maintenanceCost = 0;
  const mechCounts = { light: 0, medium: 0, heavy: 0, assault: 0 };
  for (const mech of mechs) {
    maintenanceCost += (MAINTENANCE_COSTS[mech.type] || 0) * mech.count;
    mechCounts[mech.type] = mech.count;
  }

  const netIncome = planetIncome + miningIncome - maintenanceCost;

  return {
    planetIncome,
    miningIncome,
    miningCount,
    maintenanceCost,
    mechCounts,
    netIncome
  };
}

module.exports = {
  calculateVisibility,
  getVisiblePlanets,
  getVisibleMechs,
  calculateIncome,
  calculateIncomeBreakdown
};
