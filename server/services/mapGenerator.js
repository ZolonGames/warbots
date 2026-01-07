const { db } = require('../config/database');

// Mech type definitions
const MECH_TYPES = {
  light: { hp: 4, cost: 1 },
  medium: { hp: 8, cost: 2 },
  heavy: { hp: 12, cost: 4 },
  assault: { hp: 20, cost: 8 }
};

/**
 * Generate a game map with planets and starting positions
 * @param {number} gameId - The game ID
 * @param {number} gridSize - Size of the grid (25, 50, or 100)
 * @param {Array} players - Array of game_players records
 */
function generateMap(gameId, gridSize, players) {
  const planets = [];
  const homeworlds = [];

  // Constants
  const MIN_HOMEWORLD_DISTANCE = 10;
  const MIN_PLANET_DISTANCE = 3;
  const PLANET_DENSITY = 0.10; // 10% of tiles are planets

  // Calculate target number of planets (excluding homeworlds)
  const totalTiles = gridSize * gridSize;
  const targetPlanets = Math.floor(totalTiles * PLANET_DENSITY) - players.length;

  // Helper function to calculate distance between two points
  function distance(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }

  // Helper function to check if a position is valid for a new planet
  function isValidPlanetPosition(x, y, existingPlanets, minDistance) {
    for (const planet of existingPlanets) {
      if (distance(x, y, planet.x, planet.y) < minDistance) {
        return false;
      }
    }
    return true;
  }

  // Place homeworlds for each player
  // Try to space them evenly around the map edges
  const margin = Math.floor(gridSize * 0.1); // 10% margin from edges
  const attempts = 1000;

  for (let i = 0; i < players.length; i++) {
    let placed = false;

    for (let attempt = 0; attempt < attempts && !placed; attempt++) {
      // Generate position, preferring edges for more interesting starts
      let x, y;

      if (attempt < attempts / 2) {
        // First half of attempts: try edges
        const edge = Math.floor(Math.random() * 4);
        switch (edge) {
          case 0: // Top
            x = margin + Math.floor(Math.random() * (gridSize - 2 * margin));
            y = margin;
            break;
          case 1: // Right
            x = gridSize - margin - 1;
            y = margin + Math.floor(Math.random() * (gridSize - 2 * margin));
            break;
          case 2: // Bottom
            x = margin + Math.floor(Math.random() * (gridSize - 2 * margin));
            y = gridSize - margin - 1;
            break;
          case 3: // Left
            x = margin;
            y = margin + Math.floor(Math.random() * (gridSize - 2 * margin));
            break;
        }
      } else {
        // Second half: try anywhere
        x = margin + Math.floor(Math.random() * (gridSize - 2 * margin));
        y = margin + Math.floor(Math.random() * (gridSize - 2 * margin));
      }

      // Check distance from other homeworlds
      if (isValidPlanetPosition(x, y, homeworlds, MIN_HOMEWORLD_DISTANCE)) {
        homeworlds.push({ x, y, playerId: players[i].id, playerNumber: players[i].player_number });
        placed = true;
      }
    }

    if (!placed) {
      throw new Error(`Could not place homeworld for player ${i + 1}. Try a larger map or fewer players.`);
    }
  }

  // Place regular planets
  let placedPlanets = 0;
  let planetAttempts = 0;
  const maxPlanetAttempts = targetPlanets * 100;

  while (placedPlanets < targetPlanets && planetAttempts < maxPlanetAttempts) {
    planetAttempts++;

    const x = Math.floor(Math.random() * gridSize);
    const y = Math.floor(Math.random() * gridSize);

    // Check distance from homeworlds and other planets
    const allPlanets = [...homeworlds, ...planets];
    if (isValidPlanetPosition(x, y, allPlanets, MIN_PLANET_DISTANCE)) {
      // Random income between 1 and 3
      const income = Math.floor(Math.random() * 3) + 1;
      planets.push({ x, y, income });
      placedPlanets++;
    }
  }

  // Insert homeworlds into database
  const insertPlanet = db.prepare(`
    INSERT INTO planets (game_id, x, y, base_income, owner_id, is_homeworld)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertBuilding = db.prepare(`
    INSERT INTO buildings (planet_id, type, hp)
    VALUES (?, ?, ?)
  `);

  const insertMech = db.prepare(`
    INSERT INTO mechs (game_id, owner_id, type, hp, max_hp, x, y)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Insert homeworlds
  for (const hw of homeworlds) {
    const result = insertPlanet.run(gameId, hw.x, hw.y, 5, hw.playerId, 1);
    const planetId = result.lastInsertRowid;

    // Add starting factory
    insertBuilding.run(planetId, 'factory', 10);

    // Add starting mechs (2 light mechs)
    insertMech.run(gameId, hw.playerId, 'light', MECH_TYPES.light.hp, MECH_TYPES.light.hp, hw.x, hw.y);
    insertMech.run(gameId, hw.playerId, 'light', MECH_TYPES.light.hp, MECH_TYPES.light.hp, hw.x, hw.y);
  }

  // Insert regular planets
  for (const planet of planets) {
    insertPlanet.run(gameId, planet.x, planet.y, planet.income, null, 0);
  }

  console.log(`Generated map for game ${gameId}: ${homeworlds.length} homeworlds, ${planets.length} planets`);
}

module.exports = { generateMap, MECH_TYPES };
