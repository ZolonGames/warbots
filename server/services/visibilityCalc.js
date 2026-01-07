const { db } = require('../config/database');

/**
 * Calculate which tiles are visible to a player
 * @param {number} gameId - The game ID
 * @param {number} playerId - The game_players ID
 * @param {number} gridSize - Size of the grid
 * @returns {Set<string>} Set of visible tile keys in "x,y" format
 */
function calculateVisibility(gameId, playerId, gridSize) {
  const visibleTiles = new Set();

  // Get all planets owned by the player
  const ownedPlanets = db.prepare(`
    SELECT x, y FROM planets WHERE game_id = ? AND owner_id = ?
  `).all(gameId, playerId);

  // Get all mechs owned by the player
  const ownedMechs = db.prepare(`
    SELECT DISTINCT x, y FROM mechs WHERE game_id = ? AND owner_id = ?
  `).all(gameId, playerId);

  // Combine all positions that grant visibility
  const visionSources = [...ownedPlanets, ...ownedMechs];

  // Each vision source reveals adjacent tiles (including diagonals)
  for (const source of visionSources) {
    // Reveal the source tile itself
    visibleTiles.add(`${source.x},${source.y}`);

    // Reveal adjacent tiles (8 directions)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const newX = source.x + dx;
        const newY = source.y + dy;

        // Check bounds
        if (newX >= 0 && newX < gridSize && newY >= 0 && newY < gridSize) {
          visibleTiles.add(`${newX},${newY}`);
        }
      }
    }
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

  // Filter to visible planets and add buildings
  const visiblePlanets = [];

  for (const planet of allPlanets) {
    const key = `${planet.x},${planet.y}`;
    if (visibleTiles.has(key)) {
      // Get buildings for this planet
      const buildings = db.prepare(`
        SELECT type, hp FROM buildings WHERE planet_id = ?
      `).all(planet.id);

      visiblePlanets.push({
        id: planet.id,
        x: planet.x,
        y: planet.y,
        base_income: planet.base_income,
        owner_id: planet.owner_id,
        is_homeworld: planet.is_homeworld,
        is_owned: planet.is_owned,
        buildings
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
        is_owned: mech.is_owned
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

module.exports = {
  calculateVisibility,
  getVisiblePlanets,
  getVisibleMechs,
  calculateIncome
};
