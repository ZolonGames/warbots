const { db } = require('../config/database');
const { PLANET_NAMES } = require('../data/planetNames');

// Mech type definitions
const MECH_TYPES = {
  light: { hp: 5, cost: 2 },
  medium: { hp: 10, cost: 5 },
  heavy: { hp: 20, cost: 12 },
  assault: { hp: 40, cost: 20 }
};

/**
 * Shuffle an array in place using Fisher-Yates algorithm
 */
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

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
  const MIN_PLANET_DISTANCE = 4.5; // Planets must be 4-5 squares apart
  const PLANET_DENSITY = 0.10; // 10% of tiles are planets (fewer will place due to spacing)

  // Calculate target number of planets (excluding homeworlds)
  const totalTiles = gridSize * gridSize;
  const targetPlanets = Math.floor(totalTiles * PLANET_DENSITY) - players.length;

  // Shuffle planet names for random assignment
  const shuffledNames = shuffleArray(PLANET_NAMES);
  let nameIndex = 0;

  // Helper to get next planet name (with fallback for large maps)
  function getNextPlanetName() {
    if (nameIndex < shuffledNames.length) {
      return shuffledNames[nameIndex++];
    }
    // Fallback: generate a name if we run out
    return `Planet-${nameIndex++}`;
  }

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
  const insertHomeworld = db.prepare(`
    INSERT INTO planets (game_id, x, y, base_income, owner_id, is_homeworld, name, original_owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPlanet = db.prepare(`
    INSERT INTO planets (game_id, x, y, base_income, owner_id, is_homeworld, name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertBuilding = db.prepare(`
    INSERT INTO buildings (planet_id, type, hp)
    VALUES (?, ?, ?)
  `);

  const insertMech = db.prepare(`
    INSERT INTO mechs (game_id, owner_id, type, hp, max_hp, x, y, designation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Insert homeworlds (with original_owner_id to track who it belonged to)
  for (const hw of homeworlds) {
    const homeworldName = getNextPlanetName();
    const result = insertHomeworld.run(gameId, hw.x, hw.y, 5, hw.playerId, 1, homeworldName, hw.playerId);
    const planetId = result.lastInsertRowid;

    // Add starting factory
    insertBuilding.run(planetId, 'factory', 10);

    // Add starting mechs (2 light mechs) with designations
    insertMech.run(gameId, hw.playerId, 'light', MECH_TYPES.light.hp, MECH_TYPES.light.hp, hw.x, hw.y, 'Light-0001');
    insertMech.run(gameId, hw.playerId, 'light', MECH_TYPES.light.hp, MECH_TYPES.light.hp, hw.x, hw.y, 'Light-0002');
  }

  // Insert regular planets
  for (const planet of planets) {
    const planetName = getNextPlanetName();
    insertPlanet.run(gameId, planet.x, planet.y, planet.income, null, 0, planetName);
  }

  console.log(`Generated map for game ${gameId}: ${homeworlds.length} homeworlds, ${planets.length} planets`);
}

module.exports = { generateMap, MECH_TYPES };
