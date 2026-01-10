// List of planet names for random assignment during map generation
// Loaded from JSON file for easy maintenance

const planetData = require('./planet-names.json');
const PLANET_NAMES = planetData.names;

module.exports = { PLANET_NAMES };
