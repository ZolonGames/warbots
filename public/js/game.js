// Main game logic

let gameMap;
let gameState = null;
let playerId = null;
let pendingOrders = {
  moves: [],
  builds: []
};

// Drag state
let dragState = {
  isDragging: false,
  mech: null,
  startTile: null,
  ghost: null
};

// Player colors (matching map.js)
const playerColors = ['#4a9eff', '#4aff9e', '#ff4a4a', '#ffcc4a', '#ff4aff', '#4affff', '#ffaa4a', '#aa4aff'];

// Build costs
const COSTS = {
  buildings: {
    mining: 10,
    factory: 30,
    fortification: 25
  },
  mechs: {
    light: 2,
    medium: 5,
    heavy: 12,
    assault: 20
  }
};

// Track displayed credits (may differ from server due to pending orders)
let displayedCredits = 0;

document.addEventListener('DOMContentLoaded', async () => {
  // Get game ID from URL
  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('id');

  if (!gameId) {
    alert('No game ID provided');
    window.location.href = '/lobby.html';
    return;
  }

  // Check auth
  const authData = await api.getMe();
  if (!authData.authenticated) {
    window.location.href = '/';
    return;
  }

  // Initialize the game
  await initGame(gameId);
});

async function initGame(gameId) {
  try {
    // Fetch initial game state
    gameState = await api.getGameState(gameId);
    playerId = gameState.playerId;

    // Update header info
    document.getElementById('game-name').textContent = gameState.name;
    document.getElementById('turn-number').textContent = gameState.currentTurn;
    updatePlayerInfo();

    // Initialize map
    const canvas = document.getElementById('game-map');
    gameMap = new GameMap(canvas, gameState.gridSize);
    gameMap.playerId = playerId; // Set player ID for mech detection
    gameMap.onTileClick = handleTileClick;
    gameMap.onTileHover = handleTileHover;
    gameMap.onMechDragStart = handleMapMechDragStart;
    gameMap.onMechDragEnd = handleMapMechDragEnd;

    // Set initial state
    updateMapState();
    updateEventLog();

    // Set up UI handlers
    setupUIHandlers();

    // Check game status and show appropriate indicator
    if (gameState.status === 'waiting') {
      showWaitingForPlayers(true);
    } else if (gameState.hasSubmittedTurn) {
      showWaitingIndicator(true);
    }

    // Start turn timer
    if (gameState.turnDeadline) {
      startTurnTimer(new Date(gameState.turnDeadline));
    }

    // Set up SSE for real-time updates
    setupEventSource(gameId);

  } catch (error) {
    console.error('Failed to initialize game:', error);
    alert('Failed to load game: ' + error.message);
  }
}

function updateMapState() {
  gameMap.setGameState({
    planets: gameState.planets,
    mechs: gameState.mechs,
    players: gameState.players,
    visibleTiles: gameState.visibleTiles
  });
}

function updatePlayerInfo() {
  displayedCredits = gameState.credits;
  document.getElementById('player-credits').textContent = displayedCredits;
  document.getElementById('player-income').textContent = gameState.income;

  // Update empire name display
  const currentPlayer = gameState.players.find(p => p.id === playerId);
  if (currentPlayer) {
    const empireDisplay = document.getElementById('empire-name-display');
    empireDisplay.textContent = currentPlayer.empire_name || `Player ${currentPlayer.player_number}`;
    empireDisplay.style.color = currentPlayer.empire_color || '#4a9eff';
  }
}

function updateEventLog() {
  const logContainer = document.getElementById('log-entries');
  const popoutContainer = document.getElementById('popout-log-entries');

  if (!gameState.combatLogs || gameState.combatLogs.length === 0) {
    const emptyHtml = '<div class="log-entry log-empty">No events yet</div>';
    logContainer.innerHTML = emptyHtml;
    if (popoutContainer) popoutContainer.innerHTML = emptyHtml;
    return;
  }

  // Group events by turn number (excluding turn_start events)
  const eventsByTurn = {};
  for (const log of gameState.combatLogs) {
    if (log.logType === 'turn_start') continue; // Skip turn_start markers

    const turn = log.turnNumber;
    if (!eventsByTurn[turn]) {
      eventsByTurn[turn] = [];
    }
    eventsByTurn[turn].push(log);
  }

  // Get turns sorted in descending order (most recent first)
  const turns = Object.keys(eventsByTurn).map(Number).sort((a, b) => b - a);

  let html = '';

  for (const turnNumber of turns) {
    const turnEvents = eventsByTurn[turnNumber];

    // Group events by type for this turn
    const buildEvents = turnEvents.filter(log => log.logType === 'build_mech' || log.logType === 'build_building');
    const incomeEvents = turnEvents.filter(log => log.logType === 'income');
    const captureEvents = turnEvents.filter(log => log.logType === 'capture');
    const lostEvents = turnEvents.filter(log => log.logType === 'planet_lost');
    const battleEvents = turnEvents.filter(log => log.logType === 'battle');
    const repairEvents = turnEvents.filter(log => log.logType === 'repair');

    // Combat events first (before turn summary)
    if (battleEvents.length > 0) {
      html += '<div class="log-section-header">Combat Results</div>';
      for (const log of battleEvents) {
        html += formatEventLog(log);
      }
    }

    // Turn summary separator
    html += `<div class="log-separator">Start of Turn ${turnNumber + 1}</div>`;

    // Income events
    if (incomeEvents.length > 0) {
      html += '<div class="log-section-header">Income</div>';
      for (const log of incomeEvents) {
        html += formatEventLog(log);
      }
    }

    // Build events
    if (buildEvents.length > 0) {
      html += '<div class="log-section-header">Construction</div>';
      for (const log of buildEvents) {
        html += formatEventLog(log);
      }
    }

    // Repair events
    if (repairEvents.length > 0) {
      html += '<div class="log-section-header">Repairs</div>';
      for (const log of repairEvents) {
        html += formatEventLog(log);
      }
    }

    // Territory changes (peaceful captures and losses)
    if (captureEvents.length > 0 || lostEvents.length > 0) {
      html += '<div class="log-section-header">Territory Changes</div>';
      for (const log of captureEvents) {
        html += formatEventLog(log);
      }
      for (const log of lostEvents) {
        html += formatEventLog(log);
      }
    }
  }

  // If no events after filtering, show empty message
  if (html === '') {
    html = '<div class="log-entry log-empty">No events yet</div>';
  }

  logContainer.innerHTML = html;
  // Only update popout if not currently revealing events
  if (popoutContainer && !isRevealingEvents) {
    popoutContainer.innerHTML = html;
  }
}

// Pop-out event log functionality
function openEventLogPopout() {
  const popout = document.getElementById('log-popout');
  popout.style.display = 'flex';
  // Sync content
  const logContent = document.getElementById('log-entries').innerHTML;
  document.getElementById('popout-log-entries').innerHTML = logContent;
}

function closeEventLogPopout() {
  document.getElementById('log-popout').style.display = 'none';
}

function getPlayerName(playerId) {
  const player = gameState.players.find(p => p.id === playerId);
  if (player) {
    // Use empire name if available, otherwise fall back to "Player X"
    return player.empire_name || `Player ${player.player_number}`;
  }
  return 'Unknown';
}

function getPlayerColor(playerId) {
  const player = gameState.players.find(p => p.id === playerId);
  if (player) {
    // Use empire color if available, otherwise fall back to default colors
    return player.empire_color || playerColors[(player.player_number - 1) % playerColors.length];
  }
  return '#888888';
}

function coloredPlayerName(playerId) {
  const name = getPlayerName(playerId);
  const color = getPlayerColor(playerId);
  return `<span style="color: ${color}; font-weight: bold;">${name}</span>`;
}

function formatLocationWithPlanet(x, y, planet) {
  if (planet && planet.name) {
    // Get owner color for the planet name
    let planetColor = '#888888'; // Default gray for neutral
    if (planet.owner_id) {
      planetColor = getPlayerColor(planet.owner_id);
    }
    return `<span style="color: ${planetColor}; font-weight: bold;">${planet.name}</span> (${x}, ${y})`;
  }
  // No planet at this location, just show coordinates
  return `(${x}, ${y})`;
}

function formatEventLog(log) {
  // Find the planet at this location (if any)
  const planet = gameState.planets.find(p => p.x === log.x && p.y === log.y);

  switch (log.logType) {
    case 'income':
      return formatIncomeEvent(log);
    case 'build_mech':
      return formatBuildMechEvent(log);
    case 'build_building':
      return formatBuildBuildingEvent(log);
    case 'capture':
      return formatCaptureEvent(log, planet);
    case 'planet_lost':
      return formatPlanetLostEvent(log);
    case 'battle':
      return formatBattleEvent(log, planet);
    case 'repair':
      return formatRepairEvent(log);
    default:
      return '';
  }
}

function formatIncomeEvent(log) {
  const amount = log.detailedLog?.amount || 0;
  return `<div class="log-entry log-income">
    <span class="log-icon">💰</span>
    Earned <span class="credits-amount">+${amount} credits</span> from your empire
  </div>`;
}

function formatBuildMechEvent(log) {
  const data = log.detailedLog || {};
  const mechType = data.mechType ? (data.mechType.charAt(0).toUpperCase() + data.mechType.slice(1)) : 'Unknown';
  const designation = data.designation || mechType;
  const planetName = data.planetName || 'Unknown Planet';
  const coords = `(${data.x}, ${data.y})`;

  return `<div class="log-entry log-build">
    <span class="log-icon">🤖</span>
    Built <span class="mech-name">${designation}</span> at <span class="planet-name">${planetName}</span> ${coords}
  </div>`;
}

function formatBuildBuildingEvent(log) {
  const data = log.detailedLog || {};
  const buildingType = data.buildingType ? (data.buildingType.charAt(0).toUpperCase() + data.buildingType.slice(1)) : 'Unknown';
  const planetName = data.planetName || 'Unknown Planet';
  const coords = `(${data.x}, ${data.y})`;

  let icon = '🏗️';
  if (data.buildingType === 'mining') icon = '⛏️';
  else if (data.buildingType === 'factory') icon = '🏭';
  else if (data.buildingType === 'fortification') icon = '🏰';

  return `<div class="log-entry log-build">
    <span class="log-icon">${icon}</span>
    Built <span class="building-name">${buildingType}</span> at <span class="planet-name">${planetName}</span> ${coords}
  </div>`;
}

function formatCaptureEvent(log, planet) {
  const locationText = formatLocationWithPlanet(log.x, log.y, planet);
  return `<div class="log-entry log-capture">
    <span class="log-icon">🚩</span>
    ${coloredPlayerName(log.winnerId)} captured ${locationText}
  </div>`;
}

function formatPlanetLostEvent(log) {
  const data = log.detailedLog || {};
  const planetName = data.planetName || 'Unknown Planet';
  const coords = `(${data.x}, ${data.y})`;
  const capturedBy = data.capturedBy;

  return `<div class="log-entry log-lost">
    <span class="log-icon">⚠️</span>
    Lost <span class="planet-name">${planetName}</span> ${coords} to ${coloredPlayerName(capturedBy)}
  </div>`;
}

function formatRepairEvent(log) {
  const data = log.detailedLog || {};
  const repairs = data.repairs || [];

  if (repairs.length === 0) return '';

  let html = '';
  for (const repair of repairs) {
    const designation = repair.designation || repair.mechType;
    const planetName = repair.planetName || 'Unknown';

    if (repair.fullyRepaired) {
      html += `<div class="log-entry log-repair">
        <span class="log-icon">🔧</span>
        <span class="mech-name">${designation}</span> fully repaired at <span class="planet-name">${planetName}</span>
      </div>`;
    } else {
      html += `<div class="log-entry log-repair">
        <span class="log-icon">🔧</span>
        <span class="mech-name">${designation}</span> repaired +${repair.hpGained} HP (${repair.hpAfter}/${repair.maxHp}) at <span class="planet-name">${planetName}</span>
      </div>`;
    }
  }

  return html;
}

// Get repair event as array of reveal items for line-by-line animation
function getRepairRevealItems(log) {
  const items = [];
  const data = log.detailedLog || {};
  const repairs = data.repairs || [];

  for (const repair of repairs) {
    const designation = repair.designation || repair.mechType;
    const planetName = repair.planetName || 'Unknown';

    let html;
    if (repair.fullyRepaired) {
      html = `<div class="log-entry log-repair">
        <span class="log-icon">🔧</span>
        <span class="mech-name">${designation}</span> fully repaired at <span class="planet-name">${planetName}</span>
      </div>`;
    } else {
      html = `<div class="log-entry log-repair">
        <span class="log-icon">🔧</span>
        <span class="mech-name">${designation}</span> repaired +${repair.hpGained} HP (${repair.hpAfter}/${repair.maxHp}) at <span class="planet-name">${planetName}</span>
      </div>`;
    }

    items.push({
      type: 'event',
      html: html
    });
  }

  return items;
}

function formatBattleEvent(log, planet) {
  const locationText = formatLocationWithPlanet(log.x, log.y, planet);
  const combatants = getBattleCombatantNames(log);

  let html = `<div class="log-entry log-attack">
    <span class="log-icon">⚔️</span>
    Battle at ${locationText} between ${combatants.name1} and ${combatants.name2}
  </div>`;

  // Detailed log for participants - handle new format with captureInfo
  if (log.isParticipant && log.detailedLog) {
    const battles = log.detailedLog.battles || log.detailedLog; // Support both old and new format
    html += formatDetailedBattleLog(battles);
  }

  // Outcome summary
  html += formatBattleOutcome(log);

  // Planet capture during battle
  const captureHtml = formatBattleCapture(log);
  if (captureHtml) {
    html += captureHtml;
  }

  return html;
}

// Get casualties for each participant in a battle
function getBattleCasualties(log) {
  // Determine which participant lost how many mechs
  // attackerCasualties = mechs lost by attackerId
  // defenderCasualties = mechs lost by defenderId
  const attackerId = log.attackerId;
  const defenderId = log.defenderId;
  const winnerId = log.winnerId;

  const casualties = {};

  // Map attacker casualties to attackerId
  if (attackerId != null) {
    casualties[attackerId] = log.attackerCasualties || 0;
  }

  // Map defender casualties to defenderId
  if (defenderId != null) {
    casualties[defenderId] = log.defenderCasualties || 0;
  }

  return casualties;
}

function formatBattleOutcome(log) {
  const winnerName = coloredPlayerName(log.winnerId);
  const loserIds = log.participants.filter(id => id != log.winnerId);
  const loserId = loserIds[0];
  const loserName = loserId != null ? coloredPlayerName(loserId) : '<span style="color: #888;">Neutral forces</span>';

  // Get casualties per participant
  const casualties = getBattleCasualties(log);

  // Winner's casualties
  const winnerCasualties = casualties[log.winnerId] || 0;

  // Loser's casualties
  const loserCasualties = loserId != null ? (casualties[loserId] || 0) : 0;

  return `<div class="log-entry log-outcome">
    ${winnerName} was victorious!
    ${winnerName} suffered ${winnerCasualties} casualt${winnerCasualties === 1 ? 'y' : 'ies'},
    and ${loserName} suffered ${loserCasualties} casualt${loserCasualties === 1 ? 'y' : 'ies'}!
  </div>`;
}

function formatBattleCapture(log) {
  const captureInfo = log.detailedLog?.captureInfo;
  if (!captureInfo) return null;

  const capturerName = coloredPlayerName(captureInfo.newOwner);
  const previousOwnerName = captureInfo.previousOwner
    ? coloredPlayerName(captureInfo.previousOwner)
    : '<span style="color: #888;">Neutral forces</span>';

  return `<div class="log-entry log-capture-battle">
    <span class="log-icon">🏴</span>
    ${capturerName} has taken <span class="planet-name">${captureInfo.planetName}</span> from ${previousOwnerName}!
  </div>`;
}

// Get the two combatant names from a battle log
function getBattleCombatantNames(log) {
  // If we have both attacker and defender IDs, use those
  if (log.attackerId != null && log.defenderId != null) {
    return {
      name1: coloredPlayerName(log.attackerId),
      name2: coloredPlayerName(log.defenderId)
    };
  }

  // Otherwise, use participants list to determine combatants
  if (log.participants && log.participants.length >= 2) {
    return {
      name1: coloredPlayerName(log.participants[0]),
      name2: coloredPlayerName(log.participants[1])
    };
  }

  // Fallback
  const attackerName = log.attackerId != null ? coloredPlayerName(log.attackerId) : '<span style="color: #888;">Unknown</span>';
  const defenderName = log.defenderId != null ? coloredPlayerName(log.defenderId) : '<span style="color: #888;">Neutral</span>';
  return { name1: attackerName, name2: defenderName };
}

// Get battle event as array of reveal items for line-by-line animation
function getBattleRevealItems(log) {
  const items = [];
  const planet = gameState.planets.find(p => p.x === log.x && p.y === log.y);
  const locationText = formatLocationWithPlanet(log.x, log.y, planet);
  const combatants = getBattleCombatantNames(log);

  // Battle header
  const headerHtml = `<div class="log-entry log-attack">
      <span class="log-icon">⚔️</span>
      Battle at ${locationText} between ${combatants.name1} and ${combatants.name2}
    </div>`;
  items.push({
    type: 'event',
    html: headerHtml
  });

  // Detailed battle log for participants (die rolls, damage, etc.)
  if (log.isParticipant && log.detailedLog) {
    const battles = log.detailedLog.battles || log.detailedLog;
    const detailItems = getDetailedBattleRevealItems(battles);
    for (const item of detailItems) {
      items.push(item);
    }
  }

  // Outcome
  const outcomeHtml = formatBattleOutcome(log);
  items.push({
    type: 'event',
    html: outcomeHtml
  });

  // Planet capture (if any)
  const captureHtml = formatBattleCapture(log);
  if (captureHtml) {
    items.push({
      type: 'event',
      html: captureHtml
    });
  }

  return items;
}

// Get detailed battle log entries as individual reveal items
function getDetailedBattleRevealItems(battles) {
  const items = [];

  for (const battle of battles) {
    if (!battle.detailedLog) continue;

    for (const entry of battle.detailedLog) {
      let html = '';

      if (entry.type === 'round') {
        html = `<div class="log-detail-item log-round">--- Round ${entry.round} ---</div>`;
      } else if (entry.type === 'attack') {
        const attackerType = entry.attackerType || 'unknown';
        const targetType = entry.targetType || 'unknown';
        const attackerName = coloredPlayerName(entry.attackerPlayerId);
        const attackerTypeName = attackerType.charAt(0).toUpperCase() + attackerType.slice(1);
        const targetName = targetType === 'fortification' ? 'Fortification' : coloredPlayerName(entry.targetPlayerId);
        const targetTypeName = targetType.charAt(0).toUpperCase() + targetType.slice(1);

        if (attackerType === 'fortification') {
          html = `<div class="log-detail-item log-roll">Fortification attacks ${targetName}'s ${targetTypeName} → rolls ${entry.roll}</div>`;
        } else if (targetType === 'fortification') {
          html = `<div class="log-detail-item log-roll">${attackerName}'s ${attackerTypeName} attacks Fortification → rolls ${entry.roll}</div>`;
        } else {
          html = `<div class="log-detail-item log-roll">${attackerName}'s ${attackerTypeName} attacks ${targetName}'s ${targetTypeName} → rolls ${entry.roll}</div>`;
        }
      } else if (entry.type === 'roll') {
        // Legacy roll format
        const mechType = entry.mechType || 'unknown';
        const playerName = coloredPlayerName(entry.playerId);
        const mechName = mechType.charAt(0).toUpperCase() + mechType.slice(1);
        html = `<div class="log-detail-item log-roll">${playerName}'s ${mechName} rolls ${entry.roll}</div>`;
      } else if (entry.type === 'damage') {
        const mechType = entry.mechType || entry.target || 'unknown';
        if (mechType === 'fortification') {
          html = `<div class="log-detail-item log-damage">Fortification takes ${entry.damage} damage (${entry.hpRemaining} HP left)</div>`;
        } else {
          const playerName = coloredPlayerName(entry.playerId);
          const mechName = mechType.charAt(0).toUpperCase() + mechType.slice(1);
          html = `<div class="log-detail-item log-damage">${playerName}'s ${mechName} takes ${entry.damage} damage (${entry.hpRemaining} HP left)</div>`;
        }
      } else if (entry.type === 'destroyed') {
        const mechType = entry.mechType || entry.target || 'unknown';
        if (mechType === 'fortification') {
          html = `<div class="log-detail-item log-destroyed">Fortification destroyed!</div>`;
        } else {
          const playerName = coloredPlayerName(entry.playerId);
          const mechName = mechType.charAt(0).toUpperCase() + mechType.slice(1);
          html = `<div class="log-detail-item log-destroyed">${playerName}'s ${mechName} destroyed!</div>`;
        }
      }

      if (html) {
        items.push({
          type: 'detail',
          html: html
        });
      }
    }
  }

  return items;
}

function formatCombatLog(log) {
  let html = '';

  // Find the planet at this location (if any)
  const planet = gameState.planets.find(p => p.x === log.x && p.y === log.y);
  const locationText = formatLocationWithPlanet(log.x, log.y, planet);

  if (log.logType === 'capture') {
    // Peaceful capture
    html += `<div class="log-entry log-capture">`;
    html += `${coloredPlayerName(log.winnerId)} captured ${locationText}`;
    html += `</div>`;
  } else if (log.logType === 'battle') {
    // Battle occurred
    const attackerName = coloredPlayerName(log.attackerId);
    const defenderName = log.defenderId ? coloredPlayerName(log.defenderId) : '<span style="color: #888;">Neutral</span>';

    html += `<div class="log-entry log-attack">`;
    html += `A battle occurred at ${locationText} between ${attackerName} and ${defenderName}`;
    html += `</div>`;

    // Detailed log for participants
    if (log.isParticipant && log.detailedLog) {
      html += formatDetailedBattleLog(log.detailedLog);
    }

    // Outcome summary (always shown)
    const winnerName = coloredPlayerName(log.winnerId);
    const loserIds = log.participants.filter(id => id !== log.winnerId);
    const loserId = loserIds[0];
    const loserName = loserId ? coloredPlayerName(loserId) : '<span style="color: #888;">Neutral forces</span>';

    const winnerCasualties = log.winnerId === log.attackerId ? log.attackerCasualties : log.defenderCasualties;
    const loserCasualties = log.winnerId === log.attackerId ? log.defenderCasualties : log.attackerCasualties;

    html += `<div class="log-entry log-outcome">`;
    html += `${winnerName} was victorious! `;
    html += `${winnerName} suffered ${winnerCasualties} casualt${winnerCasualties === 1 ? 'y' : 'ies'}, `;
    html += `and ${loserName} suffered ${loserCasualties} casualt${loserCasualties === 1 ? 'y' : 'ies'}!`;
    html += `</div>`;
  }

  return html;
}

function formatDetailedBattleLog(battles) {
  let html = '<div class="log-detailed">';

  for (const battle of battles) {
    if (!battle.detailedLog) continue;

    for (const entry of battle.detailedLog) {
      if (entry.type === 'round') {
        html += `<div class="log-round">--- Round ${entry.round} ---</div>`;
      } else if (entry.type === 'attack') {
        // New attack format: shows attacker, target, and roll
        const attackerType = entry.attackerType || 'unknown';
        const targetType = entry.targetType || 'unknown';
        const attackerName = coloredPlayerName(entry.attackerPlayerId);
        const attackerTypeName = attackerType.charAt(0).toUpperCase() + attackerType.slice(1);
        const targetName = targetType === 'fortification' ? 'Fortification' : coloredPlayerName(entry.targetPlayerId);
        const targetTypeName = targetType.charAt(0).toUpperCase() + targetType.slice(1);

        if (attackerType === 'fortification') {
          html += `<div class="log-roll">Fortification attacks ${targetName}'s ${targetTypeName} → rolls ${entry.roll}</div>`;
        } else if (targetType === 'fortification') {
          html += `<div class="log-roll">${attackerName}'s ${attackerTypeName} attacks Fortification → rolls ${entry.roll}</div>`;
        } else {
          html += `<div class="log-roll">${attackerName}'s ${attackerTypeName} attacks ${targetName}'s ${targetTypeName} → rolls ${entry.roll}</div>`;
        }
      } else if (entry.type === 'roll') {
        // Legacy roll format (kept for backwards compatibility)
        const mechType = entry.mechType || 'unknown';
        const playerName = coloredPlayerName(entry.playerId);
        const mechName = mechType.charAt(0).toUpperCase() + mechType.slice(1);
        html += `<div class="log-roll">${playerName}'s ${mechName} rolls ${entry.roll}</div>`;
      } else if (entry.type === 'damage') {
        const mechType = entry.mechType || entry.target || 'unknown';
        if (mechType === 'fortification') {
          html += `<div class="log-damage">Fortification takes ${entry.damage} damage (${entry.hpRemaining} HP left)</div>`;
        } else {
          const playerName = coloredPlayerName(entry.playerId);
          const mechName = mechType.charAt(0).toUpperCase() + mechType.slice(1);
          html += `<div class="log-damage">${playerName}'s ${mechName} takes ${entry.damage} damage (${entry.hpRemaining} HP left)</div>`;
        }
      } else if (entry.type === 'destroyed') {
        const mechType = entry.mechType || entry.target || 'unknown';
        if (mechType === 'fortification') {
          html += `<div class="log-destroyed">Fortification destroyed!</div>`;
        } else {
          const playerName = coloredPlayerName(entry.playerId);
          const mechName = mechType.charAt(0).toUpperCase() + mechType.slice(1);
          html += `<div class="log-destroyed">${playerName}'s ${mechName} destroyed!</div>`;
        }
      }
    }
  }

  html += '</div>';
  return html;
}

function updateCreditsDisplay() {
  document.getElementById('player-credits').textContent = displayedCredits;

  // Also update build buttons if a planet is selected
  if (gameMap && gameMap.selectedTile) {
    const planet = gameState.planets.find(
      p => p.x === gameMap.selectedTile.x && p.y === gameMap.selectedTile.y
    );
    if (planet && planet.owner_id === playerId) {
      updateBuildButtons(planet);
    }
  }
}

function getCost(type, buildType) {
  if (type === 'building') {
    return COSTS.buildings[buildType] || 0;
  } else if (type === 'mech') {
    return COSTS.mechs[buildType] || 0;
  }
  return 0;
}

function handleTileClick(tile) {
  const key = `${tile.x},${tile.y}`;

  // Check if tile is visible
  if (!gameState.visibleTiles.includes(key)) {
    updateSelectionPanel(null);
    updateMechsPanel(null);
    return;
  }

  // Find planet at this location
  const planet = gameState.planets.find(p => p.x === tile.x && p.y === tile.y);

  // Find mechs at this location
  const mechs = gameState.mechs.filter(m => m.x === tile.x && m.y === tile.y);

  updateSelectionPanel({ tile, planet, mechs });

  // Update mechs panel with your mechs at this tile
  const yourMechs = mechs.filter(m => m.owner_id === playerId);
  updateMechsPanel(yourMechs.length > 0 ? { tile, mechs: yourMechs } : null);
}

function handleTileHover(tile, event) {
  const tooltip = document.getElementById('map-tooltip');
  const key = `${tile.x},${tile.y}`;

  if (!gameState.visibleTiles.includes(key)) {
    tooltip.style.display = 'none';
    return;
  }

  const planet = gameState.planets.find(p => p.x === tile.x && p.y === tile.y);
  const mechs = gameState.mechs.filter(m => m.x === tile.x && m.y === tile.y);

  if (!planet && mechs.length === 0) {
    tooltip.style.display = 'none';
    return;
  }

  let html = '';
  if (planet) {
    const planetName = planet.name || (planet.is_homeworld ? 'Homeworld' : 'Planet');
    html += `<strong>${planetName}</strong><br>`;
    html += `${planet.is_homeworld ? 'Homeworld' : 'Planet'} - Income: ${planet.base_income}<br>`;
    if (planet.buildings && planet.buildings.length > 0) {
      html += `Buildings: ${planet.buildings.map(b => b.type).join(', ')}`;
    }
  }

  if (mechs.length > 0) {
    if (planet) html += '<br>';
    html += `<strong>Mechs:</strong> ${mechs.length}`;
  }

  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  tooltip.style.left = (event.clientX + 10) + 'px';
  tooltip.style.top = (event.clientY + 10) + 'px';
}

function updateSelectionPanel(selection) {
  const panel = document.getElementById('selection-info');
  const buildPanel = document.querySelector('.build-panel');

  if (!selection) {
    panel.innerHTML = '<p class="empty">Click a tile to select</p>';
    buildPanel.style.display = 'none';
    return;
  }

  const { tile, planet, mechs } = selection;
  let html = `<p><strong>Position:</strong> (${tile.x}, ${tile.y})</p>`;

  if (planet) {
    // Planet name with rename option for owned planets
    const planetName = planet.name || (planet.is_homeworld ? 'Homeworld' : 'Unknown Planet');
    const isOwned = planet.owner_id === playerId;

    if (isOwned) {
      html += `<div class="planet-name-container">`;
      html += `<p class="planet-name"><strong>${planetName}</strong></p>`;
      html += `<button class="rename-btn" onclick="showRenameDialog(${planet.id}, '${planetName.replace(/'/g, "\\'")}')">Rename</button>`;
      html += `</div>`;
    } else {
      html += `<p class="planet-name"><strong>${planetName}</strong></p>`;
    }

    html += `<p class="planet-type">${planet.is_homeworld ? 'Homeworld' : 'Planet'}</p>`;
    html += `<p>Income: ${planet.base_income}</p>`;
    html += `<p>Owner: ${isOwned ? 'You' : (planet.owner_id ? 'Enemy' : 'Neutral')}</p>`;

    if (planet.buildings && planet.buildings.length > 0) {
      html += '<p><strong>Buildings:</strong></p><ul>';
      for (const building of planet.buildings) {
        html += `<li>${building.type}${building.type === 'fortification' ? ` (${building.hp} HP)` : ''}</li>`;
      }
      html += '</ul>';
    }

    // Show build panel if we own this planet
    if (isOwned) {
      buildPanel.style.display = 'block';
      updateBuildButtons(planet);
    } else {
      buildPanel.style.display = 'none';
    }
  } else {
    buildPanel.style.display = 'none';
  }

  if (mechs.length > 0) {
    html += '<p><strong>Mechs:</strong></p><ul>';
    const mechCounts = {};
    for (const mech of mechs) {
      const key = `${mech.type}-${mech.owner_id === playerId ? 'own' : 'enemy'}`;
      mechCounts[key] = (mechCounts[key] || 0) + 1;
    }
    for (const [key, count] of Object.entries(mechCounts)) {
      const [type, owner] = key.split('-');
      html += `<li>${count}x ${type} (${owner === 'own' ? 'yours' : 'enemy'})</li>`;
    }
    html += '</ul>';
  }

  panel.innerHTML = html;
}

// Show rename dialog for a planet
function showRenameDialog(planetId, currentName) {
  const newName = prompt('Enter new name for this planet:', currentName);
  if (newName !== null && newName.trim() !== '' && newName.trim() !== currentName) {
    renamePlanet(planetId, newName.trim());
  }
}

// Rename a planet via API
async function renamePlanet(planetId, newName) {
  try {
    await api.renamePlanet(planetId, newName);

    // Update the planet name in local game state
    const planet = gameState.planets.find(p => p.id === planetId);
    if (planet) {
      planet.name = newName;
    }

    // Refresh the selection panel
    if (gameMap && gameMap.selectedTile) {
      const tile = gameMap.selectedTile;
      const selectedPlanet = gameState.planets.find(p => p.x === tile.x && p.y === tile.y);
      const mechs = gameState.mechs.filter(m => m.x === tile.x && m.y === tile.y);
      updateSelectionPanel({ tile, planet: selectedPlanet, mechs });
    }
  } catch (error) {
    alert('Failed to rename planet: ' + error.message);
  }
}

function updateBuildButtons(planet) {
  const hasFactory = planet.buildings && planet.buildings.some(b => b.type === 'factory');
  const existingBuildings = new Set((planet.buildings || []).map(b => b.type));

  // Check which buildings are already queued for this planet
  const queuedBuildings = new Set(
    pendingOrders.builds
      .filter(b => b.planetId === planet.id && b.type === 'building')
      .map(b => b.buildingType)
  );

  // Check if a mech is already queued for this planet (factories can only build 1 mech per turn)
  const queuedMech = pendingOrders.builds.find(
    b => b.planetId === planet.id && b.type === 'mech'
  );

  // Handle mech manufacturing display
  const mechButtonsContainer = document.getElementById('mech-buttons');
  const manufacturingBtn = document.getElementById('mech-manufacturing');
  const noFactoryBtn = document.getElementById('mech-no-factory');

  if (!hasFactory) {
    // No factory - show "build a factory" message
    mechButtonsContainer.style.display = 'none';
    manufacturingBtn.style.display = 'none';
    noFactoryBtn.style.display = 'flex';
  } else if (queuedMech) {
    // Show manufacturing button, hide individual mech buttons
    mechButtonsContainer.style.display = 'none';
    manufacturingBtn.style.display = 'flex';
    noFactoryBtn.style.display = 'none';
    const mechType = queuedMech.mechType.charAt(0).toUpperCase() + queuedMech.mechType.slice(1);
    manufacturingBtn.querySelector('.build-name').textContent = `Manufacturing ${mechType} Mech`;
  } else {
    // Show individual mech buttons, hide other states
    mechButtonsContainer.style.display = 'block';
    manufacturingBtn.style.display = 'none';
    noFactoryBtn.style.display = 'none';
  }

  document.querySelectorAll('.build-btn').forEach(btn => {
    const type = btn.dataset.type;
    const buildType = btn.dataset.build;
    const cost = parseInt(btn.dataset.cost, 10);
    const statusEl = btn.querySelector('.build-status');

    // Skip the manufacturing button (it has no dataset)
    if (!type) return;

    // Reset classes
    btn.classList.remove('already-built', 'no-credits', 'no-factory', 'queued');
    btn.disabled = false;

    if (type === 'building') {
      // Check if building already exists on this planet
      if (existingBuildings.has(buildType)) {
        btn.disabled = true;
        btn.classList.add('already-built');
        statusEl.textContent = 'Already built';
      } else if (queuedBuildings.has(buildType)) {
        btn.disabled = true;
        btn.classList.add('queued');
        statusEl.textContent = 'Queued';
      } else if (displayedCredits < cost) {
        btn.disabled = true;
        btn.classList.add('no-credits');
        statusEl.textContent = 'Not enough credits!';
      } else {
        statusEl.textContent = `(${cost})`;
      }
    } else if (type === 'mech') {
      // Mech buttons are only shown when factory exists (no-factory state handled above)
      if (displayedCredits < cost) {
        btn.disabled = true;
        btn.classList.add('no-credits');
        statusEl.textContent = 'Not enough credits!';
      } else {
        statusEl.textContent = `(${cost})`;
      }
    }
  });
}

function setupUIHandlers() {
  // Build buttons
  document.querySelectorAll('.build-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;

      const type = btn.dataset.type;
      const buildType = btn.dataset.build;

      if (!gameMap.selectedTile) return;

      const planet = gameState.planets.find(
        p => p.x === gameMap.selectedTile.x && p.y === gameMap.selectedTile.y
      );

      if (!planet || planet.owner_id !== playerId) return;

      addBuildOrder(planet.id, type, buildType);
    });
  });

  // Submit turn button
  document.getElementById('submit-turn').addEventListener('click', submitTurn);

  // Clear orders button
  document.getElementById('clear-orders').addEventListener('click', clearOrders);

  // Map controls
  document.getElementById('zoom-in').addEventListener('click', () => gameMap.zoomIn());
  document.getElementById('zoom-out').addEventListener('click', () => gameMap.zoomOut());
  document.getElementById('reset-view').addEventListener('click', () => gameMap.resetView());

  // Event log pop-out
  document.getElementById('popout-log').addEventListener('click', openEventLogPopout);
  document.getElementById('close-popout').addEventListener('click', closeEventLogPopout);

  // Close popout when clicking overlay background
  document.getElementById('log-popout').addEventListener('click', (e) => {
    if (e.target.id === 'log-popout') {
      closeEventLogPopout();
    }
  });

  // Turn Summary handlers
  document.getElementById('start-turn-btn').addEventListener('click', closeTurnSummary);
  document.getElementById('turn-summary-entries').addEventListener('click', () => {
    skipEventReveal();
  });

  // Set up drag-and-drop for mechs from sidebar
  setupMapDropZone();
}

function addBuildOrder(planetId, type, buildType) {
  const cost = getCost(type, buildType);

  // Check if player has enough credits (button should be disabled, but double-check)
  if (displayedCredits < cost) {
    return;
  }

  // Deduct credits
  displayedCredits -= cost;

  // Add order first, then update displays so button states reflect the new order
  pendingOrders.builds.push({
    planetId,
    type,
    [type === 'mech' ? 'mechType' : 'buildingType']: buildType,
    cost // Store cost for refund
  });

  updateCreditsDisplay();
  updateOrdersList();
}

function addMoveOrder(mechId, toX, toY) {
  // Remove any existing move order for this mech
  pendingOrders.moves = pendingOrders.moves.filter(m => m.mechId !== mechId);

  // Find the mech to get its current position
  const mech = gameState.mechs.find(m => m.id === mechId);
  const fromX = mech ? mech.x : 0;
  const fromY = mech ? mech.y : 0;

  pendingOrders.moves.push({ mechId, toX, toY, fromX, fromY });
  updateOrdersList();
  refreshMechsPanel();
}

function refreshMechsPanel() {
  // Refresh mechs panel to show updated move orders
  if (gameMap && gameMap.selectedTile) {
    const tile = gameMap.selectedTile;
    const mechs = gameState.mechs.filter(m => m.x === tile.x && m.y === tile.y);
    const yourMechs = mechs.filter(m => m.owner_id === playerId);
    updateMechsPanel(yourMechs.length > 0 ? { tile, mechs: yourMechs } : null);
  }
}

function updateOrdersList() {
  const container = document.getElementById('orders-list');

  if (pendingOrders.moves.length === 0 && pendingOrders.builds.length === 0) {
    container.innerHTML = '<p class="empty">No orders queued</p>';
    return;
  }

  let html = '';

  for (let i = 0; i < pendingOrders.moves.length; i++) {
    const order = pendingOrders.moves[i];
    const orderText = formatMoveOrder(order);
    html += `
      <div class="order-item">
        <span>${orderText}</span>
        <button class="order-remove" onclick="removeOrder('moves', ${i})">×</button>
      </div>
    `;
  }

  for (let i = 0; i < pendingOrders.builds.length; i++) {
    const order = pendingOrders.builds[i];
    const orderText = formatBuildOrder(order);
    html += `
      <div class="order-item">
        <span>${orderText}</span>
        <button class="order-remove" onclick="removeOrder('builds', ${i})">×</button>
      </div>
    `;
  }

  container.innerHTML = html;
}

// Format a move order with mech name and location details
function formatMoveOrder(order) {
  // Find the mech
  const mech = gameState.mechs.find(m => m.id === order.mechId);
  const mechName = mech ? (mech.designation || mech.type) : 'Mech';

  // Check for planets at source and destination
  const fromPlanet = gameState.planets.find(p => p.x === order.fromX && p.y === order.fromY);
  const toPlanet = gameState.planets.find(p => p.x === order.toX && p.y === order.toY);

  // Format source location
  let fromText;
  if (fromPlanet && fromPlanet.name) {
    fromText = `${fromPlanet.name} (${order.fromX}, ${order.fromY})`;
  } else {
    fromText = `(${order.fromX}, ${order.fromY})`;
  }

  // Format destination location
  let toText;
  if (toPlanet && toPlanet.name) {
    toText = `${toPlanet.name} (${order.toX}, ${order.toY})`;
  } else {
    toText = `(${order.toX}, ${order.toY})`;
  }

  return `Moving ${mechName} from ${fromText} to ${toText}`;
}

// Format a build order with planet name
function formatBuildOrder(order) {
  // Find the planet
  const planet = gameState.planets.find(p => p.id === order.planetId);
  const planetName = planet ? (planet.name || 'Unknown') : 'Unknown';
  const coords = planet ? `(${planet.x}, ${planet.y})` : '';

  if (order.type === 'mech') {
    const mechType = order.mechType.charAt(0).toUpperCase() + order.mechType.slice(1);
    return `Manufacturing ${mechType} Mech on ${planetName} ${coords}`;
  } else {
    const buildingType = order.buildingType.charAt(0).toUpperCase() + order.buildingType.slice(1);
    return `Building ${buildingType} on ${planetName} ${coords}`;
  }
}

function removeOrder(type, index) {
  // Refund credits if removing a build order
  let refundAmount = 0;
  if (type === 'builds' && pendingOrders.builds[index]) {
    const order = pendingOrders.builds[index];
    if (order.cost) {
      refundAmount = order.cost;
    }
  }

  // Remove order first, then update displays so button states reflect the removal
  pendingOrders[type].splice(index, 1);

  if (refundAmount > 0) {
    displayedCredits += refundAmount;
    updateCreditsDisplay();
  }

  updateOrdersList();

  // Refresh mechs panel if a move order was removed
  if (type === 'moves') {
    refreshMechsPanel();
  }
}

function clearOrders() {
  // Refund all pending build orders
  for (const order of pendingOrders.builds) {
    if (order.cost) {
      displayedCredits += order.cost;
    }
  }
  updateCreditsDisplay();

  pendingOrders = { moves: [], builds: [] };
  updateOrdersList();
  refreshMechsPanel();
}

async function submitTurn() {
  const gameId = new URLSearchParams(window.location.search).get('id');

  try {
    await api.submitTurn(gameId, pendingOrders);
    clearOrders();
    showWaitingIndicator(true);
  } catch (error) {
    alert('Failed to submit turn: ' + error.message);
  }
}

function showWaitingIndicator(show) {
  const indicator = document.getElementById('waiting-indicator');
  const submitBtn = document.getElementById('submit-turn');

  if (show) {
    indicator.style.display = 'flex';
    submitBtn.style.display = 'none';
  } else {
    indicator.style.display = 'none';
    submitBtn.style.display = 'inline-flex';
  }
}

function showWaitingForPlayers(show) {
  const indicator = document.getElementById('waiting-for-players');
  const submitBtn = document.getElementById('submit-turn');

  if (show) {
    indicator.style.display = 'flex';
    submitBtn.style.display = 'none';
  } else {
    indicator.style.display = 'none';
    submitBtn.style.display = 'inline-flex';
  }
}

function showTurnAnnouncement(turnNumber) {
  const overlay = document.getElementById('turn-overlay');
  const announcement = document.getElementById('turn-announcement');
  const turnNumberEl = document.getElementById('turn-announce-number');

  // Set turn number
  turnNumberEl.textContent = turnNumber;

  // Set faction color
  const factionColor = playerColors[playerId % playerColors.length] || '#4a9eff';
  announcement.style.color = factionColor;

  // Trigger animation
  overlay.classList.add('active');

  // Remove after animation completes, then show turn summary
  setTimeout(() => {
    overlay.classList.remove('active');
    // Start the animated turn summary after turn announcement
    showTurnSummary(turnNumber - 1); // Show events from the previous turn that just resolved
  }, 2500);
}

// Animated event log reveal system
let eventRevealQueue = [];
let isRevealingEvents = false;

function showTurnSummary(turnNumber) {
  if (!gameState.combatLogs || gameState.combatLogs.length === 0) {
    return;
  }

  // Get events for this specific turn (the turn that just resolved)
  const turnEvents = gameState.combatLogs.filter(log =>
    log.turnNumber === turnNumber && log.logType !== 'turn_start'
  );

  if (turnEvents.length === 0) {
    return;
  }

  // Open the turn summary popup
  const overlay = document.getElementById('turn-summary-overlay');
  overlay.style.display = 'flex';

  // Update the Start Turn button text
  const startBtn = document.getElementById('start-turn-btn');
  startBtn.textContent = `Start Turn ${turnNumber + 1}`;

  // Clear the summary content for fresh reveal
  const summaryContainer = document.getElementById('turn-summary-entries');
  summaryContainer.innerHTML = '';
  summaryContainer.classList.add('revealing');

  // Build the event queue in the correct order:
  // 1. Combat events first
  // 2. "Start of Turn X" separator
  // 3. Income, Construction, Territory Changes (peaceful captures)
  eventRevealQueue = [];

  const battleEvents = turnEvents.filter(log => log.logType === 'battle');
  const incomeEvents = turnEvents.filter(log => log.logType === 'income');
  const buildEvents = turnEvents.filter(log => log.logType === 'build_mech' || log.logType === 'build_building');
  const repairEvents = turnEvents.filter(log => log.logType === 'repair');
  const captureEvents = turnEvents.filter(log => log.logType === 'capture');
  const lostEvents = turnEvents.filter(log => log.logType === 'planet_lost');

  // Add combat section - each battle line-by-line
  if (battleEvents.length > 0) {
    eventRevealQueue.push({ type: 'header', html: '<div class="log-section-header">Combat Results</div>' });
    for (const log of battleEvents) {
      // Get battle items for line-by-line reveal
      const battleItems = getBattleRevealItems(log);
      for (const item of battleItems) {
        eventRevealQueue.push(item);
      }
    }
  }

  // Add turn summary separator
  eventRevealQueue.push({ type: 'separator', html: `<div class="log-separator">Start of Turn ${turnNumber + 1}</div>` });

  // Add income section
  if (incomeEvents.length > 0) {
    eventRevealQueue.push({ type: 'header', html: '<div class="log-section-header">Income</div>' });
    for (const log of incomeEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
  }

  // Add construction section
  if (buildEvents.length > 0) {
    eventRevealQueue.push({ type: 'header', html: '<div class="log-section-header">Construction</div>' });
    for (const log of buildEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
  }

  // Add repairs section - each repair line by line
  if (repairEvents.length > 0) {
    eventRevealQueue.push({ type: 'header', html: '<div class="log-section-header">Repairs</div>' });
    for (const log of repairEvents) {
      const repairItems = getRepairRevealItems(log);
      for (const item of repairItems) {
        eventRevealQueue.push(item);
      }
    }
  }

  // Add territory changes (peaceful captures and losses)
  if (captureEvents.length > 0 || lostEvents.length > 0) {
    eventRevealQueue.push({ type: 'header', html: '<div class="log-section-header">Territory Changes</div>' });
    for (const log of captureEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
    for (const log of lostEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
  }

  // Start revealing events
  isRevealingEvents = true;
  revealNextEvent();
}

function revealNextEvent() {
  if (eventRevealQueue.length === 0) {
    isRevealingEvents = false;
    const summaryContainer = document.getElementById('turn-summary-entries');
    summaryContainer.classList.remove('revealing');
    // Also update the main event log (non-animated)
    updateEventLog();
    return;
  }

  const summaryContainer = document.getElementById('turn-summary-entries');
  const item = eventRevealQueue.shift();

  // Create a wrapper div for animation
  const wrapper = document.createElement('div');
  wrapper.className = 'reveal-item';
  wrapper.innerHTML = item.html;
  summaryContainer.appendChild(wrapper);

  // Scroll to bottom
  summaryContainer.scrollTop = summaryContainer.scrollHeight;

  // Trigger fade-in animation
  requestAnimationFrame(() => {
    wrapper.classList.add('revealed');
  });

  // Determine delay based on item type
  let delay = 300; // Default for headers
  if (item.type === 'event') {
    delay = 800; // Pause for actual events
  } else if (item.type === 'separator') {
    delay = 800; // Pause for separators
  } else if (item.type === 'detail') {
    delay = 800; // Battle details (die rolls, damage, etc.)
  }

  setTimeout(revealNextEvent, delay);
}

function skipEventReveal() {
  if (!isRevealingEvents) return;

  // Clear the queue and show all remaining events at once
  const summaryContainer = document.getElementById('turn-summary-entries');

  for (const item of eventRevealQueue) {
    const wrapper = document.createElement('div');
    wrapper.className = 'reveal-item revealed';
    wrapper.innerHTML = item.html;
    summaryContainer.appendChild(wrapper);
  }

  eventRevealQueue = [];
  isRevealingEvents = false;
  summaryContainer.classList.remove('revealing');
  summaryContainer.scrollTop = summaryContainer.scrollHeight;

  // Update the main event log
  updateEventLog();
}

function closeTurnSummary() {
  const overlay = document.getElementById('turn-summary-overlay');
  overlay.style.display = 'none';
  // Skip any remaining reveal
  if (isRevealingEvents) {
    skipEventReveal();
  }
}

function startTurnTimer(deadline) {
  const timerEl = document.getElementById('turn-timer');

  function update() {
    const now = new Date();
    const diff = deadline - now;

    if (diff <= 0) {
      timerEl.textContent = '00:00';
      return;
    }

    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    if (hours > 0) {
      timerEl.textContent = `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
      timerEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    requestAnimationFrame(update);
  }

  update();
}

function setupEventSource(gameId) {
  // SSE for real-time updates
  const eventSource = new EventSource(`/api/games/${gameId}/events`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'turn_resolved') {
      // Refresh game state
      refreshGameState(gameId);
    } else if (data.type === 'player_joined') {
      // Could show notification
    }
  };

  eventSource.onerror = () => {
    console.log('SSE connection error, will retry...');
  };
}

async function refreshGameState(gameId) {
  try {
    const previousTurn = gameState?.currentTurn;
    gameState = await api.getGameState(gameId);

    document.getElementById('turn-number').textContent = gameState.currentTurn;
    updatePlayerInfo();
    updateMapState();
    updateEventLog();
    refreshMechsPanel();

    // Hide waiting indicators on new turn / game start
    showWaitingIndicator(false);
    showWaitingForPlayers(false);

    // Show turn announcement if turn changed
    if (previousTurn !== null && previousTurn !== undefined && gameState.currentTurn !== previousTurn) {
      showTurnAnnouncement(gameState.currentTurn);
    }

    if (gameState.turnDeadline) {
      startTurnTimer(new Date(gameState.turnDeadline));
    }
  } catch (error) {
    console.error('Failed to refresh game state:', error);
  }
}

// Mech panel functions
function updateMechsPanel(selection) {
  const panel = document.getElementById('mechs-panel');
  const list = document.getElementById('mechs-list');

  if (!selection || !selection.mechs || selection.mechs.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  list.innerHTML = '';

  for (const mech of selection.mechs) {
    const item = createMechItem(mech, selection.tile);
    list.appendChild(item);
  }
}

function createMechItem(mech, tile) {
  const item = document.createElement('div');
  item.className = 'mech-item';
  item.dataset.mechId = mech.id;
  item.dataset.tileX = tile.x;
  item.dataset.tileY = tile.y;

  // Create small canvas for mech icon
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');

  // Draw mech icon
  const color = playerColors[mech.owner_id % playerColors.length];
  drawMechIconSmall(ctx, 16, 16, 12, color);

  item.appendChild(canvas);

  // Info container (type + HP)
  const infoContainer = document.createElement('div');
  infoContainer.className = 'mech-info';

  // Designation label (e.g., "Light-0001")
  const typeLabel = document.createElement('span');
  typeLabel.className = 'mech-type';
  typeLabel.textContent = mech.designation || (mech.type.charAt(0).toUpperCase() + mech.type.slice(1));
  infoContainer.appendChild(typeLabel);

  // HP text
  const hpPercent = mech.hp / mech.max_hp;
  let hpColor;
  if (hpPercent > 0.5) {
    hpColor = 'var(--accent-green)';
  } else if (hpPercent > 0.25) {
    hpColor = 'var(--accent-yellow)';
  } else {
    hpColor = 'var(--accent-red)';
  }

  const hpText = document.createElement('span');
  hpText.className = 'mech-hp-text';
  hpText.textContent = `HP: ${mech.hp}/${mech.max_hp}`;
  hpText.style.color = hpColor;
  infoContainer.appendChild(hpText);

  // Health bar
  const healthBar = document.createElement('div');
  healthBar.className = 'mech-health-bar';

  const healthFill = document.createElement('div');
  healthFill.className = 'mech-health-fill';
  healthFill.style.width = `${hpPercent * 100}%`;
  healthFill.style.backgroundColor = hpColor;

  const healthLost = document.createElement('div');
  healthLost.className = 'mech-health-lost';
  healthLost.style.width = `${(1 - hpPercent) * 100}%`;

  healthBar.appendChild(healthFill);
  healthBar.appendChild(healthLost);
  infoContainer.appendChild(healthBar);

  // Check for pending move order
  const moveOrder = pendingOrders.moves.find(m => m.mechId === mech.id);
  if (moveOrder) {
    const moveText = document.createElement('span');
    moveText.className = 'mech-move-text';
    moveText.textContent = `Moving to (${moveOrder.toX}, ${moveOrder.toY})`;
    infoContainer.appendChild(moveText);
  }

  item.appendChild(infoContainer);

  // Set up drag events
  item.draggable = true;
  item.addEventListener('dragstart', (e) => handleMechDragStart(e, mech, tile));
  item.addEventListener('dragend', (e) => handleMechDragEnd(e));

  return item;
}

function drawMechIconSmall(ctx, centerX, centerY, size, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;

  // Robot body
  const bodyWidth = size * 0.7;
  const bodyHeight = size * 0.8;
  const bodyX = centerX - bodyWidth / 2;
  const bodyY = centerY - bodyHeight / 2 + size * 0.1;

  // Main body (rounded rect)
  ctx.beginPath();
  const radius = size * 0.15;
  ctx.moveTo(bodyX + radius, bodyY);
  ctx.lineTo(bodyX + bodyWidth - radius, bodyY);
  ctx.quadraticCurveTo(bodyX + bodyWidth, bodyY, bodyX + bodyWidth, bodyY + radius);
  ctx.lineTo(bodyX + bodyWidth, bodyY + bodyHeight - radius);
  ctx.quadraticCurveTo(bodyX + bodyWidth, bodyY + bodyHeight, bodyX + bodyWidth - radius, bodyY + bodyHeight);
  ctx.lineTo(bodyX + radius, bodyY + bodyHeight);
  ctx.quadraticCurveTo(bodyX, bodyY + bodyHeight, bodyX, bodyY + bodyHeight - radius);
  ctx.lineTo(bodyX, bodyY + radius);
  ctx.quadraticCurveTo(bodyX, bodyY, bodyX + radius, bodyY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Head
  const headWidth = bodyWidth * 0.6;
  const headHeight = size * 0.3;
  const headX = centerX - headWidth / 2;
  const headY = bodyY - headHeight * 0.7;

  ctx.beginPath();
  ctx.roundRect(headX, headY, headWidth, headHeight, radius * 0.5);
  ctx.fill();
  ctx.stroke();

  // Eyes (visor)
  ctx.fillStyle = '#00ffff';
  const eyeWidth = headWidth * 0.7;
  const eyeHeight = headHeight * 0.35;
  ctx.fillRect(centerX - eyeWidth / 2, headY + headHeight * 0.3, eyeWidth, eyeHeight);
}

// Drag and drop handlers
function handleMechDragStart(e, mech, tile) {
  dragState.isDragging = true;
  dragState.mech = mech;
  dragState.startTile = tile;

  // Set drag data
  e.dataTransfer.setData('text/plain', JSON.stringify({ mechId: mech.id, fromX: tile.x, fromY: tile.y }));
  e.dataTransfer.effectAllowed = 'move';

  // Calculate valid moves (adjacent tiles)
  const validMoves = getValidMoves(tile.x, tile.y);
  gameMap.setDragState(true, [mech], validMoves);

  // Add class to dragged item
  e.target.classList.add('dragging');

  // Show drop zone on map
  document.querySelector('.map-container').classList.add('drop-active');
}

function handleMechDragEnd(e) {
  dragState.isDragging = false;
  dragState.mech = null;
  dragState.startTile = null;

  // Reset map drag state
  gameMap.setDragState(false);

  // Remove classes
  e.target.classList.remove('dragging');
  document.querySelector('.map-container').classList.remove('drop-active');
}

function getValidMoves(fromX, fromY) {
  const moves = [];
  const directions = [
    { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
    { dx: -1, dy: 0 },                      { dx: 1, dy: 0 },
    { dx: -1, dy: 1 },  { dx: 0, dy: 1 },  { dx: 1, dy: 1 }
  ];

  for (const dir of directions) {
    const newX = fromX + dir.dx;
    const newY = fromY + dir.dy;

    // Check bounds
    if (newX >= 0 && newX < gameState.gridSize && newY >= 0 && newY < gameState.gridSize) {
      moves.push({ x: newX, y: newY });
    }
  }

  return moves;
}

// Set up map drop zone
function setupMapDropZone() {
  const mapContainer = document.querySelector('.map-container');
  const canvas = document.getElementById('game-map');

  mapContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  mapContainer.addEventListener('drop', (e) => {
    e.preventDefault();

    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));

      // Get tile from mouse position
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - gameMap.panX) / gameMap.tileSize;
      const y = (e.clientY - rect.top - gameMap.panY) / gameMap.tileSize;
      const toX = Math.floor(x);
      const toY = Math.floor(y);

      // Check if valid move
      const validMoves = getValidMoves(data.fromX, data.fromY);
      const isValid = validMoves.some(m => m.x === toX && m.y === toY);

      if (isValid) {
        addMoveOrder(data.mechId, toX, toY);
      }
    } catch (err) {
      console.error('Drop error:', err);
    }

    // Clean up
    document.querySelector('.map-container').classList.remove('drop-active');
  });
}

// Map mech drag handlers (called by map.js)
function handleMapMechDragStart(tile, mechs) {
  // Calculate valid moves and show highlights
  const validMoves = getValidMoves(tile.x, tile.y);
  gameMap.setDragState(true, mechs, validMoves);
}

function handleMapMechDragEnd(fromTile, toTile, mechs) {
  // Check if valid move
  const validMoves = getValidMoves(fromTile.x, fromTile.y);
  const isValid = validMoves.some(m => m.x === toTile.x && m.y === toTile.y);

  if (isValid && (toTile.x !== fromTile.x || toTile.y !== fromTile.y)) {
    // Move all mechs in the group
    for (const mech of mechs) {
      addMoveOrder(mech.id, toTile.x, toTile.y);
    }
  }
}
