const fs = require('fs');
const path = require('path');

// Log file path
const LOG_FILE = path.join(__dirname, '../../data/ai.log');

// Maximum lines to keep in log file
const MAX_LOG_LINES = 10000;

// Ensure data directory exists
const dataDir = path.dirname(LOG_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Cull log file to keep only the most recent lines
 * Removes older entries beyond MAX_LOG_LINES
 */
function cullLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;

    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n');

    // Only cull if we exceed the limit
    if (lines.length <= MAX_LOG_LINES) return;

    // Keep only the most recent lines
    const recentLines = lines.slice(-MAX_LOG_LINES);
    fs.writeFileSync(LOG_FILE, recentLines.join('\n'));
  } catch (error) {
    console.error('Failed to cull AI log:', error);
  }
}

/**
 * Format timestamp for log entries
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Write a log entry to ai.log
 * @param {string} message - The message to log
 */
function log(message) {
  const entry = `[${getTimestamp()}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, entry);
}

/**
 * Log separator for readability
 */
function logSeparator() {
  fs.appendFileSync(LOG_FILE, '─'.repeat(60) + '\n');
}

/**
 * Log new turn start
 * @param {number} gameId - Game ID
 * @param {number} turnNumber - Turn number
 */
function logTurnStart(gameId, turnNumber) {
  // Cull old log entries periodically
  cullLog();

  logSeparator();
  log(`NEW TURN: Game ${gameId}, Turn ${turnNumber}`);
  logSeparator();
}

/**
 * Log AI beginning to process
 * @param {string} empireName - AI empire name
 * @param {number} playerId - Player ID
 * @param {number} gameId - Game ID
 */
function logAIProcessingStart(empireName, playerId, gameId) {
  log(`AI PROCESSING: "${empireName}" (Player ${playerId}) in Game ${gameId}`);
}

/**
 * Log AI move action
 * @param {string} empireName - AI empire name
 * @param {string} unitDesignation - Mech designation
 * @param {string} unitType - Mech type
 * @param {number} fromX - Origin X
 * @param {number} fromY - Origin Y
 * @param {number} toX - Destination X
 * @param {number} toY - Destination Y
 */
function logMove(empireName, unitDesignation, unitType, fromX, fromY, toX, toY) {
  log(`  MOVE: ${empireName} moves ${unitDesignation} (${unitType}) from (${fromX}, ${fromY}) to (${toX}, ${toY})`);
}

/**
 * Log AI build mech action
 * @param {string} empireName - AI empire name
 * @param {string} mechType - Type of mech being built
 * @param {string} planetName - Planet name
 * @param {number} x - Planet X
 * @param {number} y - Planet Y
 */
function logBuildMech(empireName, mechType, planetName, x, y) {
  log(`  BUILD: ${empireName} builds ${mechType} mech on ${planetName} (${x}, ${y})`);
}

/**
 * Log AI build building action
 * @param {string} empireName - AI empire name
 * @param {string} buildingType - Type of building
 * @param {string} planetName - Planet name
 * @param {number} x - Planet X
 * @param {number} y - Planet Y
 */
function logBuildBuilding(empireName, buildingType, planetName, x, y) {
  log(`  BUILD: ${empireName} builds ${buildingType} on ${planetName} (${x}, ${y})`);
}

/**
 * Log AI turn submission
 * @param {string} empireName - AI empire name
 * @param {number} moveCount - Number of moves
 * @param {number} buildCount - Number of builds
 */
function logTurnSubmit(empireName, moveCount, buildCount) {
  log(`AI SUBMIT: "${empireName}" submitted turn with ${moveCount} moves and ${buildCount} builds`);
}

/**
 * Log AI analysis summary
 * @param {string} empireName - AI empire name
 * @param {Object} analysis - Analysis object from AI decision
 */
function logAnalysis(empireName, analysis) {
  log(`  ANALYSIS: ${empireName}`);
  log(`    - Phase: ${analysis.isEarlyGame ? 'Early Game' : 'Mid/Late Game'}`);
  log(`    - Income: ${analysis.income}/turn`);
  log(`    - Total Mechs: ${analysis.totalMechs}`);
  log(`    - Combat Mechs: ${analysis.combatMechs}`);
  log(`    - Under Threat: ${analysis.underThreat ? 'YES' : 'No'}`);
  log(`    - Preferred Mech Type: ${analysis.preferredMechType}`);
  log(`    - Can Attack Fortified: ${analysis.canAttackFortified ? 'Yes' : 'No'}`);
  if (analysis.isDominating) {
    log(`    - DOMINATING: Aggressive mode enabled`);
  }
  if (analysis.hasWeakEnemy) {
    log(`    - WEAK ENEMY DETECTED: Finishing blow mode - ${analysis.weakEnemies.length} weak enemies`);
  }
  if (analysis.needsToReclaimHomeworld) {
    log(`    - HOMEWORLD LOST: Needs reclaim`);
    log(`    - Reclaim Ready: ${analysis.canReclaimHomeworldNow ? 'YES - attacking' : 'No - building forces'}`);
  }
}

/**
 * Log error
 * @param {string} empireName - AI empire name
 * @param {string} error - Error message
 */
function logError(empireName, error) {
  log(`  ERROR: ${empireName} - ${error}`);
}

module.exports = {
  log,
  logSeparator,
  logTurnStart,
  logAIProcessingStart,
  logMove,
  logBuildMech,
  logBuildBuilding,
  logTurnSubmit,
  logAnalysis,
  logError,
  cullLog
};
