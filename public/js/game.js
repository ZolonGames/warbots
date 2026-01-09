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

// Helper functions for persisting orders across page refreshes
function getOrdersStorageKey(gameId, turnNumber) {
  return `warbots_orders_${gameId}_${turnNumber}`;
}

function saveOrdersToStorage(gameId, turnNumber) {
  const key = getOrdersStorageKey(gameId, turnNumber);
  localStorage.setItem(key, JSON.stringify(pendingOrders));
}

function loadOrdersFromStorage(gameId, turnNumber) {
  const key = getOrdersStorageKey(gameId, turnNumber);
  const saved = localStorage.getItem(key);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.moves && parsed.builds) {
        return parsed;
      }
    } catch (e) {
      console.error('Failed to parse saved orders:', e);
    }
  }
  return null;
}

function clearOrdersFromStorage(gameId, turnNumber) {
  const key = getOrdersStorageKey(gameId, turnNumber);
  localStorage.removeItem(key);
}

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

    // Load saved orders for this turn (if any)
    if (gameState.status === 'active' && !gameState.isObserver) {
      const savedOrders = loadOrdersFromStorage(gameId, gameState.currentTurn);
      if (savedOrders) {
        pendingOrders = savedOrders;
        // Recalculate displayed credits based on saved build orders
        for (const order of pendingOrders.builds) {
          if (order.cost) {
            displayedCredits -= order.cost;
          }
        }
        updateCreditsDisplay();
        updateOrdersList();
        updateMovementArrows();
      }
    }

    // Check game status and show appropriate UI
    if (gameState.status === 'waiting') {
      showWaitingForPlayers(true);
      showLobbyPanel(true);
      updateLobbyPanel();
    } else if (gameState.isObserver) {
      // Player is eliminated or winner - enter observer mode
      enterObserverMode();
    } else if (gameState.hasSubmittedTurn) {
      showWaitingIndicator(true);
    }

    // Start turn timer (only for active games)
    if (gameState.turnDeadline && gameState.status === 'active') {
      startTurnTimer(new Date(gameState.turnDeadline));
    }

    // Check if player missed a turn and should see turn summary
    if (gameState.status === 'active' && !gameState.isObserver && gameState.currentTurn > 1) {
      const lastSeenTurn = parseInt(localStorage.getItem(`warbots_lastSeenTurn_${gameId}`)) || 0;
      if (gameState.currentTurn > lastSeenTurn) {
        // Player hasn't seen the current turn yet - show summary for the turn that resolved
        showTurnSummary(gameState.currentTurn - 1, 'turn');
      }
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

  // Update income breakdown and net income display
  if (gameState.incomeBreakdown) {
    const breakdown = gameState.incomeBreakdown;
    document.getElementById('breakdown-planets').textContent = breakdown.planetIncome;
    document.getElementById('breakdown-mining').textContent = breakdown.miningIncome;
    document.getElementById('breakdown-maintenance').textContent = breakdown.maintenanceCost;

    // Display net income (planets + mining - maintenance)
    const netIncome = breakdown.netIncome;
    const incomeEl = document.getElementById('player-income');
    incomeEl.textContent = netIncome;

    // Update net income display color based on positive/negative
    const incomeDisplay = document.getElementById('player-income-display');
    if (netIncome < 0) {
      incomeDisplay.classList.add('negative');
      incomeDisplay.classList.remove('positive');
    } else {
      incomeDisplay.classList.remove('negative');
      incomeDisplay.classList.add('positive');
    }
  } else {
    // Fallback to old income if breakdown not available
    document.getElementById('player-income').textContent = gameState.income;
  }

  // Style credits in red if negative
  const creditsElement = document.getElementById('player-credits');
  if (displayedCredits < 0) {
    creditsElement.classList.add('negative');
  } else {
    creditsElement.classList.remove('negative');
  }

  // Update empire name display
  const currentPlayer = gameState.players.find(p => p.id === playerId);
  if (currentPlayer) {
    const empireDisplay = document.getElementById('empire-name-display');
    empireDisplay.textContent = currentPlayer.empire_name || `Player ${currentPlayer.player_number}`;
    empireDisplay.style.color = currentPlayer.empire_color || '#4a9eff';
  }

  // Update empire stats
  const ownedPlanets = gameState.planets.filter(p => p.owner_id === playerId);
  const ownedMechs = gameState.mechs.filter(m => m.owner_id === playerId);

  document.getElementById('empire-planets').textContent = ownedPlanets.length;
  document.getElementById('empire-mechs').textContent = ownedMechs.length;

  // Count mechs by type
  const mechCounts = { light: 0, medium: 0, heavy: 0, assault: 0 };
  for (const mech of ownedMechs) {
    if (mechCounts.hasOwnProperty(mech.type)) {
      mechCounts[mech.type]++;
    }
  }
  document.getElementById('mech-count-light').textContent = mechCounts.light;
  document.getElementById('mech-count-medium').textContent = mechCounts.medium;
  document.getElementById('mech-count-heavy').textContent = mechCounts.heavy;
  document.getElementById('mech-count-assault').textContent = mechCounts.assault;
}

function toggleMechBreakdown() {
  const breakdown = document.getElementById('mech-breakdown');
  const expandIcon = document.getElementById('mech-expand-icon');
  if (breakdown.style.display === 'none') {
    breakdown.style.display = 'block';
    expandIcon.textContent = '▼';
  } else {
    breakdown.style.display = 'none';
    expandIcon.textContent = '▶';
  }
}

function toggleIncomeBreakdown() {
  const breakdown = document.getElementById('income-breakdown');
  const expandIcon = document.getElementById('income-expand-icon');
  if (breakdown.style.display === 'none') {
    breakdown.style.display = 'block';
    expandIcon.textContent = '▼';
  } else {
    breakdown.style.display = 'none';
    expandIcon.textContent = '▶';
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
    const maintenanceEvents = turnEvents.filter(log => log.logType === 'maintenance');
    const maintenanceFailureEvents = turnEvents.filter(log => log.logType === 'maintenance_failure');
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

    // Maintenance events
    if (maintenanceEvents.length > 0) {
      html += '<div class="log-section-header">Maintenance</div>';
      for (const log of maintenanceEvents) {
        html += formatEventLog(log);
      }
    }

    // Maintenance failure events (critical - shows mech damage)
    if (maintenanceFailureEvents.length > 0) {
      html += '<div class="log-section-header warning-header">Critical Maintenance Report</div>';
      for (const log of maintenanceFailureEvents) {
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
    case 'defeat':
      return formatDefeatEvent(log);
    case 'victory':
      return formatVictoryEvent(log);
    case 'player_defeated':
      return formatPlayerDefeatedEvent(log);
    case 'game_won':
      return formatGameWonEvent(log);
    case 'maintenance':
      return formatMaintenanceEvent(log);
    case 'maintenance_failure':
      return formatMaintenanceFailureEvent(log);
    default:
      return '';
  }
}

// Helper to create log icon img tag
function logIcon(iconPath) {
  return `<img src="/assets/${iconPath}" class="stat-icon log-icon-img" alt="">`;
}

function formatIncomeEvent(log) {
  const amount = log.detailedLog?.amount || 0;
  return `<div class="log-entry log-income">
    <span class="log-icon">${logIcon('Credit.png')}</span>
    Earned <span class="credits-amount">+${amount} credits</span> from your empire
  </div>`;
}

function formatBuildMechEvent(log) {
  const data = log.detailedLog || {};
  const mechType = data.mechType ? (data.mechType.charAt(0).toUpperCase() + data.mechType.slice(1)) : 'Unknown';
  const designation = data.designation || mechType;
  const planetName = data.planetName || 'Unknown Planet';
  const coords = `(${data.x}, ${data.y})`;

  const mechIcons = { light: 'Light.png', medium: 'Medium.png', heavy: 'Heavy.png', assault: 'Assault.png' };
  const icon = mechIcons[data.mechType] || 'Mech.png';

  return `<div class="log-entry log-build">
    <span class="log-icon">${logIcon(icon)}</span>
    Built <span class="mech-name">${designation}</span> at <span class="planet-name">${planetName}</span> ${coords}
  </div>`;
}

function formatBuildBuildingEvent(log) {
  const data = log.detailedLog || {};
  const planetName = data.planetName || 'Unknown Planet';
  const coords = `(${data.x}, ${data.y})`;

  // Map building types to display names
  const buildingNames = {
    mining: 'Mining Colony',
    factory: 'Factory',
    fortification: 'Fortification'
  };
  const buildingName = buildingNames[data.buildingType] || 'Unknown Building';

  const buildingIcons = { mining: 'Mining Colony.png', factory: 'Factory.png', fortification: 'Defenses.png' };
  const icon = buildingIcons[data.buildingType] || 'Icon-Planet.png';

  return `<div class="log-entry log-build">
    <span class="log-icon">${logIcon(icon)}</span>
    Built <span class="building-name">${buildingName}</span> at <span class="planet-name">${planetName}</span> ${coords}
  </div>`;
}

function formatCaptureEvent(log, planet) {
  const locationText = formatLocationWithPlanet(log.x, log.y, planet);
  const data = log.detailedLog || {};
  const previousOwnerId = data.previousOwnerId || log.defenderId;

  let captureText = `${coloredPlayerName(log.winnerId)} captured ${locationText}`;
  if (previousOwnerId) {
    captureText += ` from ${coloredPlayerName(previousOwnerId)}`;
  }

  return `<div class="log-entry log-capture">
    <span class="log-icon">${logIcon('Icon-Planet.png')}</span>
    ${captureText}
  </div>`;
}

function formatPlanetLostEvent(log) {
  const data = log.detailedLog || {};
  const planetName = data.planetName || 'Unknown Planet';
  const coords = `(${data.x}, ${data.y})`;
  const capturedBy = data.capturedBy;

  return `<div class="log-entry log-lost">
    <span class="log-icon">${logIcon('Icon-Planet.png')}</span>
    Lost <span class="planet-name">${planetName}</span> ${coords} to ${coloredPlayerName(capturedBy)}
  </div>`;
}

function formatRepairEvent(log) {
  const data = log.detailedLog || {};
  const repairs = data.repairs || [];

  if (repairs.length === 0) return '';

  const mechIcons = { light: 'Light.png', medium: 'Medium.png', heavy: 'Heavy.png', assault: 'Assault.png' };

  let html = '';
  for (const repair of repairs) {
    const designation = repair.designation || repair.mechType;
    const planetName = repair.planetName || 'Unknown';
    const icon = mechIcons[repair.mechType] || 'Mech.png';

    if (repair.fullyRepaired) {
      html += `<div class="log-entry log-repair">
        <span class="log-icon">${logIcon(icon)}</span>
        <span class="mech-name">${designation}</span> fully repaired at <span class="planet-name">${planetName}</span>
      </div>`;
    } else {
      html += `<div class="log-entry log-repair">
        <span class="log-icon">${logIcon(icon)}</span>
        <span class="mech-name">${designation}</span> repaired +${repair.hpGained} HP (${repair.hpAfter}/${repair.maxHp}) at <span class="planet-name">${planetName}</span>
      </div>`;
    }
  }

  return html;
}

function formatDefeatEvent(log) {
  const data = log.detailedLog || {};
  return `<div class="log-entry log-defeat">
    <span class="log-icon">💀</span>
    <span style="color: ${data.empireColor || '#ff4a4a'}; font-weight: bold;">${data.empireName || 'Your empire'}</span> has been defeated!
  </div>`;
}

function formatVictoryEvent(log) {
  const data = log.detailedLog || {};
  return `<div class="log-entry log-victory">
    <span class="log-icon">👑</span>
    <span style="color: ${data.empireColor || '#4aff4a'}; font-weight: bold;">${data.empireName || 'Your empire'}</span> is victorious!
  </div>`;
}

function formatPlayerDefeatedEvent(log) {
  const data = log.detailedLog || {};
  return `<div class="log-entry log-player-defeated">
    <span class="log-icon">☠️</span>
    <span style="color: ${data.defeatedEmpireColor || '#ff4a4a'}; font-weight: bold;">${data.defeatedEmpireName || 'An empire'}</span> has been eliminated!
  </div>`;
}

function formatGameWonEvent(log) {
  const data = log.detailedLog || {};
  return `<div class="log-entry log-game-won">
    <span class="log-icon">🏆</span>
    <span style="color: ${data.winnerEmpireColor || '#4aff4a'}; font-weight: bold;">${data.winnerEmpireName || 'An empire'}</span> has won the game!
  </div>`;
}

function formatMaintenanceEvent(log) {
  const data = log.detailedLog || {};
  const cost = data.cost || 0;
  const mechCounts = data.mechCounts || {};

  // Build breakdown of mech counts
  const breakdown = [];
  if (mechCounts.light > 0) breakdown.push(`${mechCounts.light} Light`);
  if (mechCounts.medium > 0) breakdown.push(`${mechCounts.medium} Medium`);
  if (mechCounts.heavy > 0) breakdown.push(`${mechCounts.heavy} Heavy`);
  if (mechCounts.assault > 0) breakdown.push(`${mechCounts.assault} Assault`);

  const breakdownText = breakdown.length > 0 ? ` (${breakdown.join(', ')})` : '';

  return `<div class="log-entry log-maintenance">
    <span class="log-icon">${logIcon('MaintenanceMinus.png')}</span>
    Maintenance costs: <span class="credits-amount">-${cost} credits</span>${breakdownText}
  </div>`;
}

function formatMaintenanceFailureEvent(log) {
  const data = log.detailedLog || {};
  const mechStatusReport = data.mechStatusReport || [];
  const creditsAfter = data.creditsAfter || 0;

  const mechIcons = { light: 'Light.png', medium: 'Medium.png', heavy: 'Heavy.png', assault: 'Assault.png' };

  let html = `<div class="log-entry log-maintenance-failure">
    <span class="log-icon">${logIcon('MaintenanceMinus.png')}</span>
    <span class="warning-text">CRITICAL: Maintenance failure! All mechs took 1 damage.</span>
  </div>`;

  // Show individual mech status
  for (const mech of mechStatusReport) {
    const icon = mechIcons[mech.mechType] || 'Mech.png';
    const statusText = mech.destroyed
      ? `<span class="destroyed-text">${mech.designation} destroyed!</span>`
      : `${mech.designation}: ${mech.hpAfter}/${mech.maxHp} HP`;

    html += `<div class="log-entry log-maintenance-damage">
      <span class="log-icon">${logIcon(icon)}</span>
      ${statusText}
    </div>`;
  }

  return html;
}

// Get maintenance failure as array of reveal items for line-by-line animation
function getMaintenanceFailureRevealItems(log) {
  const items = [];
  const data = log.detailedLog || {};
  const mechStatusReport = data.mechStatusReport || [];

  // Add the warning header
  items.push({
    type: 'event',
    html: `<div class="log-entry log-maintenance-failure">
      <span class="log-icon">⚠️</span>
      <span class="warning-text">CRITICAL: Maintenance failure! All mechs took 1 damage.</span>
    </div>`
  });

  // Add each mech status as a separate item for reveal animation
  for (const mech of mechStatusReport) {
    const statusIcon = mech.destroyed ? '💀' : '⚡';
    const statusText = mech.destroyed
      ? `<span class="destroyed-text">${mech.designation} destroyed!</span>`
      : `${mech.designation}: ${mech.hpAfter}/${mech.maxHp} HP`;

    items.push({
      type: 'detail',
      html: `<div class="log-entry log-maintenance-damage">
        <span class="log-icon">${statusIcon}</span>
        ${statusText}
      </div>`
    });
  }

  return items;
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

  // Status reports for each faction
  if (log.isParticipant) {
    html += formatBattleStatusReports(log);
  }

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

  return `<div class="log-entry log-outcome">
    ${winnerName} was victorious!
  </div>`;
}

// Format status reports for each faction after battle
function formatBattleStatusReports(log) {
  let html = '';

  // Get battles array from detailedLog
  const battles = log.detailedLog?.battles || log.detailedLog || [];
  if (!Array.isArray(battles) || battles.length === 0) return '';

  // Use finalMechStatus if available (aggregated across all battles), otherwise fall back to first battle
  const mechStatus = log.detailedLog?.finalMechStatus || battles[0]?.mechStatus;
  if (!mechStatus) return '';

  const participants = log.participants || [];
  // Use finalFortificationStatus if available, otherwise fall back to first battle
  const fortStatus = log.detailedLog?.finalFortificationStatus || battles[0]?.fortificationStatus;

  for (const playerId of participants) {
    const playerName = getPlayerName(playerId);
    const playerColor = getPlayerColor(playerId);
    const isWinner = playerId === log.winnerId;
    const reportTitle = isWinner ? 'Status Report' : 'Casualty Report';

    const mechList = mechStatus[playerId] || [];
    // Check if this player had the fortification
    const hadFort = fortStatus && fortStatus.defenderId === playerId;

    if (mechList.length === 0 && !hadFort) continue;

    html += `<div class="log-status-report">`;
    html += `<div class="status-report-header" style="color: ${playerColor};">${playerName} ${reportTitle}:</div>`;
    html += `<div class="status-report-divider">----</div>`;

    // Show fortification first if this player had one
    if (hadFort) {
      if (fortStatus.destroyed) {
        html += `<div class="status-report-line destroyed">- <span style="color: ${playerColor};">Fortification</span> was destroyed!</div>`;
      } else {
        const hpPercent = fortStatus.hp / fortStatus.maxHp;
        let hpClass = 'hp-high';
        if (hpPercent <= 0.25) hpClass = 'hp-low';
        else if (hpPercent <= 0.5) hpClass = 'hp-medium';

        html += `<div class="status-report-line">- <span style="color: ${playerColor};">Fortification</span> <span class="${hpClass}">${fortStatus.hp}/${fortStatus.maxHp}</span></div>`;
      }
    }

    for (const mech of mechList) {
      if (mech.destroyed) {
        html += `<div class="status-report-line destroyed">- <span style="color: ${playerColor};">${mech.name}</span> was destroyed!</div>`;
      } else {
        // Ensure maxHp has a valid value (fallback based on type)
        const typeMaxHp = { light: 5, medium: 10, heavy: 20, assault: 40 };
        const maxHp = mech.maxHp || typeMaxHp[(mech.type || '').toLowerCase()] || 10;
        const hp = typeof mech.hp === 'number' ? mech.hp : maxHp;
        const hpPercent = hp / maxHp;
        let hpClass = 'hp-high';
        if (hpPercent <= 0.25) hpClass = 'hp-low';
        else if (hpPercent <= 0.5) hpClass = 'hp-medium';

        html += `<div class="status-report-line">- <span style="color: ${playerColor};">${mech.name}</span> <span class="${hpClass}">${hp}/${maxHp}</span></div>`;
      }
    }

    html += `</div>`;
  }

  return html;
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

  // Status reports for each faction
  if (log.isParticipant) {
    const statusReportItems = getBattleStatusReportItems(log);
    for (const item of statusReportItems) {
      items.push(item);
    }
  }

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

// Get status report items for line-by-line reveal
function getBattleStatusReportItems(log) {
  const items = [];

  // Get battles array from detailedLog
  const battles = log.detailedLog?.battles || log.detailedLog || [];
  if (!Array.isArray(battles) || battles.length === 0) return items;

  // Use finalMechStatus if available (aggregated across all battles), otherwise fall back to first battle
  const mechStatus = log.detailedLog?.finalMechStatus || battles[0]?.mechStatus;
  if (!mechStatus) return items;

  const participants = log.participants || [];
  // Use finalFortificationStatus if available, otherwise fall back to first battle
  const fortStatus = log.detailedLog?.finalFortificationStatus || battles[0]?.fortificationStatus;

  for (const playerId of participants) {
    const playerName = getPlayerName(playerId);
    const playerColor = getPlayerColor(playerId);
    const isWinner = playerId === log.winnerId;
    const reportTitle = isWinner ? 'Status Report' : 'Casualty Report';

    const mechList = mechStatus[playerId] || [];
    // Check if this player had the fortification
    const hadFort = fortStatus && fortStatus.defenderId === playerId;

    if (mechList.length === 0 && !hadFort) continue;

    // Header
    items.push({
      type: 'detail',
      html: `<div class="status-report-header" style="color: ${playerColor};">${playerName} ${reportTitle}:</div>`
    });

    items.push({
      type: 'detail',
      html: `<div class="status-report-divider">----</div>`
    });

    // Show fortification first if this player had one
    if (hadFort) {
      let fortHtml;
      if (fortStatus.destroyed) {
        fortHtml = `<div class="status-report-line destroyed">- <span style="color: ${playerColor};">Fortification</span> was destroyed!</div>`;
      } else {
        const hpPercent = fortStatus.hp / fortStatus.maxHp;
        let hpClass = 'hp-high';
        if (hpPercent <= 0.25) hpClass = 'hp-low';
        else if (hpPercent <= 0.5) hpClass = 'hp-medium';

        fortHtml = `<div class="status-report-line">- <span style="color: ${playerColor};">Fortification</span> <span class="${hpClass}">${fortStatus.hp}/${fortStatus.maxHp}</span></div>`;
      }

      items.push({
        type: 'detail',
        html: fortHtml
      });
    }

    // Each mech status
    for (const mech of mechList) {
      let mechHtml;
      if (mech.destroyed) {
        mechHtml = `<div class="status-report-line destroyed">- <span style="color: ${playerColor};">${mech.name}</span> was destroyed!</div>`;
      } else {
        // Ensure maxHp has a valid value (fallback based on type)
        const typeMaxHp = { light: 5, medium: 10, heavy: 20, assault: 40 };
        const maxHp = mech.maxHp || typeMaxHp[(mech.type || '').toLowerCase()] || 10;
        const hp = typeof mech.hp === 'number' ? mech.hp : maxHp;
        const hpPercent = hp / maxHp;
        let hpClass = 'hp-high';
        if (hpPercent <= 0.25) hpClass = 'hp-low';
        else if (hpPercent <= 0.5) hpClass = 'hp-medium';

        mechHtml = `<div class="status-report-line">- <span style="color: ${playerColor};">${mech.name}</span> <span class="${hpClass}">${hp}/${maxHp}</span></div>`;
      }

      items.push({
        type: 'detail',
        html: mechHtml
      });
    }
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
        // New format: <Mech Name> fires at <Target> and deals <x> damage!
        const attackerColor = getPlayerColor(entry.attackerPlayerId);
        const targetColor = getPlayerColor(entry.targetPlayerId);
        const attackerName = entry.attackerName || entry.attackerType;
        const targetName = entry.targetName || entry.targetType;

        html = `<div class="log-detail-item log-attack-line">` +
          `<span style="color: ${attackerColor}; font-weight: bold;">${attackerName}</span> ` +
          `fires at <span style="color: ${targetColor}; font-weight: bold;">${targetName}</span> ` +
          `and deals <span class="damage-amount">${entry.roll}</span> damage!</div>`;
      } else if (entry.type === 'damage') {
        // Status line: <Mech> has <HP>/<MaxHP> HP!
        const mechColor = getPlayerColor(entry.playerId);
        const mechName = entry.mechName || entry.mechType;
        const hpRemaining = entry.hpRemaining;
        // Determine maxHp based on type if not provided
        const typeMaxHp = { light: 5, medium: 10, heavy: 20, assault: 40, fortification: 30 };
        const maxHp = entry.maxHp || typeMaxHp[(entry.mechType || '').toLowerCase()] || 10;

        if (hpRemaining > 0) {
          const hpPercent = hpRemaining / maxHp;
          let hpClass = 'hp-high';
          if (hpPercent <= 0.25) hpClass = 'hp-low';
          else if (hpPercent <= 0.5) hpClass = 'hp-medium';

          html = `<div class="log-detail-item log-status">` +
            `<span style="color: ${mechColor}; font-weight: bold;">${mechName}</span> has ` +
            `<span class="${hpClass}">${hpRemaining}/${maxHp} HP</span>!</div>`;
        }
      } else if (entry.type === 'destroyed') {
        // Destroyed line: <Mech> was destroyed!
        const mechColor = getPlayerColor(entry.playerId);
        const mechName = entry.mechName || entry.mechType;

        html = `<div class="log-detail-item log-destroyed">` +
          `<span style="color: ${mechColor}; font-weight: bold;">${mechName}</span> was destroyed!</div>`;
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
    const data = log.detailedLog || {};
    const previousOwnerId = data.previousOwnerId || log.defenderId;
    let captureText = `${coloredPlayerName(log.winnerId)} captured ${locationText}`;
    if (previousOwnerId) {
      captureText += ` from ${coloredPlayerName(previousOwnerId)}`;
    }
    html += `<div class="log-entry log-capture">`;
    html += captureText;
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
        // New format: <Mech Name> fires at <Target> and deals <x> damage!
        const attackerColor = getPlayerColor(entry.attackerPlayerId);
        const targetColor = getPlayerColor(entry.targetPlayerId);
        const attackerName = entry.attackerName || entry.attackerType;
        const targetName = entry.targetName || entry.targetType;

        html += `<div class="log-attack-line">` +
          `<span style="color: ${attackerColor}; font-weight: bold;">${attackerName}</span> ` +
          `fires at <span style="color: ${targetColor}; font-weight: bold;">${targetName}</span> ` +
          `and deals <span class="damage-amount">${entry.roll}</span> damage!</div>`;
      } else if (entry.type === 'damage') {
        // Status line: <Mech> has <HP>/<MaxHP> HP! (or skip if destroyed)
        const mechColor = getPlayerColor(entry.playerId);
        const mechName = entry.mechName || entry.mechType;
        const hpRemaining = entry.hpRemaining;
        // Determine maxHp based on type if not provided
        const typeMaxHp = { light: 5, medium: 10, heavy: 20, assault: 40, fortification: 30 };
        const maxHp = entry.maxHp || typeMaxHp[(entry.mechType || '').toLowerCase()] || 10;

        if (hpRemaining > 0) {
          const hpPercent = hpRemaining / maxHp;
          let hpClass = 'hp-high';
          if (hpPercent <= 0.25) hpClass = 'hp-low';
          else if (hpPercent <= 0.5) hpClass = 'hp-medium';

          html += `<div class="log-status">` +
            `<span style="color: ${mechColor}; font-weight: bold;">${mechName}</span> has ` +
            `<span class="${hpClass}">${hpRemaining}/${maxHp} HP</span>!</div>`;
        }
      } else if (entry.type === 'destroyed') {
        // Destroyed line
        const mechColor = getPlayerColor(entry.playerId);
        const mechName = entry.mechName || entry.mechType;

        html += `<div class="log-destroyed">` +
          `<span style="color: ${mechColor}; font-weight: bold;">${mechName}</span> was destroyed!</div>`;
      }
    }
  }

  html += '</div>';
  return html;
}

function updateCreditsDisplay() {
  const creditsElement = document.getElementById('player-credits');
  creditsElement.textContent = displayedCredits;

  // Style credits in red if negative
  if (displayedCredits < 0) {
    creditsElement.classList.add('negative');
  } else {
    creditsElement.classList.remove('negative');
  }

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
    // Show owner with colored empire name directly under planet name
    if (planet.owner_id !== null) {
      html += `${coloredPlayerName(planet.owner_id)}<br>`;
    } else {
      html += `<span style="color: #888;">Neutral</span><br>`;
    }
    html += `${planet.is_homeworld ? 'Homeworld' : 'Planet'} - Income: ${planet.base_income}<br>`;
    // Only show buildings for planets you own
    if (planet.owner_id === playerId && planet.buildings && planet.buildings.length > 0) {
      const buildingIcons = {
        mining: '/assets/Mining Colony.png',
        factory: '/assets/Factory.png',
        fortification: '/assets/Defenses.png'
      };
      const iconHtml = planet.buildings.map(b =>
        `<img src="${buildingIcons[b.type] || '/assets/Icon-Planet.png'}" class="stat-icon" alt="${b.type}" title="${b.type}">`
      ).join(' ');
      html += iconHtml;
    }
  }

  if (mechs.length > 0) {
    if (planet) html += '<br>';
    // Group mechs by owner and show with colored empire names
    const mechsByOwner = {};
    for (const mech of mechs) {
      if (!mechsByOwner[mech.owner_id]) {
        mechsByOwner[mech.owner_id] = 0;
      }
      mechsByOwner[mech.owner_id]++;
    }

    const ownerIds = Object.keys(mechsByOwner);
    if (ownerIds.length === 1) {
      // Single owner - show count then empire name on next line
      const ownerId = parseInt(ownerIds[0]);
      html += `<strong>Mechs:</strong> ${mechs.length}<br>`;
      html += `${coloredPlayerName(ownerId)}`;
    } else {
      // Multiple owners - show each with count
      html += `<strong>Mechs:</strong><br>`;
      for (const ownerId of ownerIds) {
        html += `${coloredPlayerName(parseInt(ownerId))}: ${mechsByOwner[ownerId]}<br>`;
      }
    }
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

    // Select planet icon based on type/value
    let planetIcon;
    if (planet.is_homeworld) {
      planetIcon = '/assets/Planet-5.png';
    } else {
      const income = planet.base_income || 1;
      if (income >= 3) {
        planetIcon = '/assets/Planet-3.png';
      } else if (income === 2) {
        planetIcon = '/assets/Planet-2.png';
      } else {
        planetIcon = '/assets/Planet-1.png';
      }
    }
    html += `<p class="planet-type"><img src="${planetIcon}" class="stat-icon" alt="">${planet.is_homeworld ? 'Homeworld' : 'Planet'}</p>`;
    html += `<p><img src="/assets/IncomePlus.png" class="stat-icon" alt="">Income: ${planet.base_income}</p>`;
    html += `<p>Owner: ${isOwned ? 'You' : (planet.owner_id ? 'Enemy' : 'Neutral')}</p>`;

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
    html += '<p><strong><img src="/assets/Mech.png" class="stat-icon" alt="">Mechs:</strong></p><ul>';
    const mechCounts = {};
    for (const mech of mechs) {
      const key = `${mech.type}-${mech.owner_id === playerId ? 'own' : 'enemy'}`;
      mechCounts[key] = (mechCounts[key] || 0) + 1;
    }
    const mechIcons = {
      light: '/assets/Light.png',
      medium: '/assets/Medium.png',
      heavy: '/assets/Heavy.png',
      assault: '/assets/Assault.png'
    };
    for (const [key, count] of Object.entries(mechCounts)) {
      const [type, owner] = key.split('-');
      const icon = mechIcons[type] || '/assets/Mech.png';
      html += `<li><img src="${icon}" class="stat-icon" alt="">${count}x ${type} (${owner === 'own' ? 'yours' : 'enemy'})</li>`;
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
  const hasMining = planet.buildings && planet.buildings.some(b => b.type === 'mining');
  const fortification = planet.buildings && planet.buildings.find(b => b.type === 'fortification');
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

        // Show specific status based on building type
        if (buildType === 'mining') {
          statusEl.innerHTML = '<span class="building-active">+2 Credits/Turn</span>';
        } else if (buildType === 'factory') {
          // Check if mech is queued for manufacturing
          if (queuedMech) {
            statusEl.innerHTML = '<span class="building-manufacturing">Manufacturing in Progress</span>';
          } else {
            statusEl.innerHTML = '<span class="building-active">Factory Ready</span>';
          }
        } else if (buildType === 'fortification' && fortification) {
          // Show HP with color coding and damage range
          const hp = fortification.hp;
          const maxHp = 30;
          const hpPercent = hp / maxHp;
          let hpClass;
          if (hpPercent > 0.5) {
            hpClass = 'hp-high';
          } else if (hpPercent > 0.25) {
            hpClass = 'hp-medium';
          } else {
            hpClass = 'hp-low';
          }
          statusEl.innerHTML = `<span class="${hpClass}">${hp}/${maxHp} HP</span><br><span class="fort-damage">Damage: 1-10</span>`;
        }
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
      // Mech buttons use .build-cost instead of .build-status
      const costEl = btn.querySelector('.build-cost');
      // Mech buttons are only shown when factory exists (no-factory state handled above)
      if (displayedCredits < cost) {
        btn.disabled = true;
        btn.classList.add('no-credits');
        if (costEl) costEl.textContent = `(${cost})`;
      } else {
        if (costEl) costEl.textContent = `(${cost})`;
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

  // Start game button (for host in waiting state)
  document.getElementById('start-game-btn').addEventListener('click', startGame);

  // Add AI button
  document.getElementById('add-ai-btn').addEventListener('click', openAIModal);

  // AI modal form
  document.getElementById('ai-form').addEventListener('submit', submitAIPlayer);
  document.getElementById('generate-ai-name').addEventListener('click', generateAIName);

  // Close AI modal when clicking overlay background
  document.getElementById('ai-modal').addEventListener('click', (e) => {
    if (e.target.id === 'ai-modal') {
      closeAIModal();
    }
  });

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

  // Save orders to localStorage for persistence
  const gameId = new URLSearchParams(window.location.search).get('id');
  saveOrdersToStorage(gameId, gameState.currentTurn);
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
  updateMovementArrows();

  // Save orders to localStorage for persistence
  const gameId = new URLSearchParams(window.location.search).get('id');
  saveOrdersToStorage(gameId, gameState.currentTurn);
}

function updateMovementArrows() {
  if (gameMap) {
    gameMap.setMovementOrders(pendingOrders.moves);
  }
}

function cancelMoveOrder(mechId) {
  pendingOrders.moves = pendingOrders.moves.filter(m => m.mechId !== mechId);
  updateOrdersList();
  refreshMechsPanel();
  updateMovementArrows();

  // Save orders to localStorage for persistence
  const gameId = new URLSearchParams(window.location.search).get('id');
  saveOrdersToStorage(gameId, gameState.currentTurn);
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

  // Refresh mechs panel and arrows if a move order was removed
  if (type === 'moves') {
    refreshMechsPanel();
    updateMovementArrows();
  }

  // Save orders to localStorage for persistence
  const gameId = new URLSearchParams(window.location.search).get('id');
  saveOrdersToStorage(gameId, gameState.currentTurn);
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
  updateMovementArrows();

  // Clear from localStorage
  const gameId = new URLSearchParams(window.location.search).get('id');
  clearOrdersFromStorage(gameId, gameState.currentTurn);
}

async function submitTurn() {
  const gameId = new URLSearchParams(window.location.search).get('id');

  try {
    await api.submitTurn(gameId, pendingOrders);
    // Keep orders visible until turn resolves - don't clear them
    // They will be cleared when the turn advances in refreshGameState
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

function showLobbyPanel(show) {
  const lobbyPanel = document.getElementById('lobby-panel');
  const ordersPanel = document.getElementById('orders-panel');

  if (show) {
    lobbyPanel.style.display = 'block';
    ordersPanel.style.display = 'none';
  } else {
    lobbyPanel.style.display = 'none';
    ordersPanel.style.display = 'block';
  }
}

function updateLobbyPanel() {
  const playersList = document.getElementById('players-list');
  const startBtn = document.getElementById('start-game-btn');
  const addAIBtn = document.getElementById('add-ai-btn');
  const maxPlayers = gameState.maxPlayers;
  const players = gameState.players || [];
  const isHost = gameState.userId === gameState.hostId;

  // Build players list HTML
  let html = '';
  for (let i = 0; i < maxPlayers; i++) {
    const player = players[i];
    if (player) {
      const color = player.empire_color || '#888';
      const aiTag = player.is_ai ? ' <span class="ai-tag">[AI]</span>' : '';
      html += `
        <div class="lobby-player joined">
          <span class="player-color" style="background-color: ${color};"></span>
          <span class="player-name" style="color: ${color};">${escapeHtml(player.empire_name || player.display_name)}${aiTag}</span>
        </div>
      `;
    } else {
      html += `
        <div class="lobby-player empty">
          <span class="player-color"></span>
          <span class="player-name">Waiting for player...</span>
        </div>
      `;
    }
  }
  playersList.innerHTML = html;

  // Show start and add AI buttons for host
  if (isHost) {
    startBtn.style.display = 'block';
    const canStart = players.length >= maxPlayers;
    startBtn.disabled = !canStart;
    startBtn.textContent = canStart ? 'Start Game' : `Need ${maxPlayers} players (${players.length}/${maxPlayers})`;

    // Show Add AI button - disable and change text when full
    addAIBtn.style.display = 'block';
    if (players.length < maxPlayers) {
      addAIBtn.disabled = false;
      addAIBtn.textContent = 'Add AI';
    } else {
      addAIBtn.disabled = true;
      addAIBtn.textContent = 'Game Full';
    }
  } else {
    startBtn.style.display = 'none';
    addAIBtn.style.display = 'none';
  }
}

async function startGame() {
  const startBtn = document.getElementById('start-game-btn');
  startBtn.disabled = true;
  startBtn.textContent = 'Starting...';

  try {
    await api.startGame(gameState.gameId);
    // Game will start and SSE will notify us
  } catch (error) {
    alert('Failed to start game: ' + error.message);
    startBtn.disabled = false;
    startBtn.textContent = 'Start Game';
  }
}

// AI name generation data (loaded from server)
let aiNameData = null;

async function loadAINameData() {
  if (aiNameData) return aiNameData;
  try {
    const response = await fetch('/api/ai/names');
    aiNameData = await response.json();
    return aiNameData;
  } catch (error) {
    console.error('Failed to load AI name data:', error);
    // Fallback data
    return {
      prefixes: ['Cybernetic', 'Terran', 'Martian', 'Grey', 'Eternal'],
      suffixes: ['Collective', 'Alliance', 'Federation', 'Empire', 'Hive']
    };
  }
}

async function openAIModal() {
  const modal = document.getElementById('ai-modal');
  const colorPicker = document.getElementById('ai-color-picker');

  // Generate a random name
  await generateAIName();

  // Fetch available colors from the API (same as human player color picker)
  try {
    const colorData = await api.getAvailableColors(gameState.gameId);
    const availableColors = colorData.colors || [];

    colorPicker.innerHTML = '';
    for (const color of availableColors) {
      const colorEl = document.createElement('div');
      colorEl.className = 'color-option';
      colorEl.style.backgroundColor = color;
      colorEl.dataset.color = color;
      colorEl.addEventListener('click', () => selectAIColor(color));
      colorPicker.appendChild(colorEl);
    }

    // Auto-select first available color
    if (availableColors.length > 0) {
      selectAIColor(availableColors[0]);
    }
  } catch (error) {
    console.error('Failed to load available colors:', error);
  }

  modal.style.display = 'flex';
}

function closeAIModal() {
  document.getElementById('ai-modal').style.display = 'none';
}

function selectAIColor(color) {
  document.getElementById('ai-selected-color').value = color;

  // Update visual selection
  document.querySelectorAll('#ai-color-picker .color-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.color === color);
  });
}

async function generateAIName() {
  const nameData = await loadAINameData();
  const prefix = nameData.prefixes[Math.floor(Math.random() * nameData.prefixes.length)];
  const suffix = nameData.suffixes[Math.floor(Math.random() * nameData.suffixes.length)];
  document.getElementById('ai-name').value = `The ${prefix} ${suffix}`;
}

async function submitAIPlayer(e) {
  e.preventDefault();

  const name = document.getElementById('ai-name').value.trim();
  const color = document.getElementById('ai-selected-color').value;
  const difficulty = document.getElementById('ai-difficulty').value;

  if (!name || !color) {
    alert('Please enter a name and select a color');
    return;
  }

  try {
    await api.addAIPlayer(gameState.gameId, {
      name,
      color,
      difficulty
    });

    closeAIModal();

    // Refresh game state to show new AI player
    const gameId = new URLSearchParams(window.location.search).get('id');
    gameState = await api.getGameState(gameId);
    updateLobbyPanel();
  } catch (error) {
    alert('Failed to add AI player: ' + error.message);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showTurnAnnouncement(turnNumber, transitionType = 'turn') {
  const overlay = document.getElementById('turn-overlay');
  const announcement = document.getElementById('turn-announcement');
  const turnNumberEl = document.getElementById('turn-announce-number');

  // Set announcement text based on transition type
  if (transitionType === 'defeat') {
    announcement.innerHTML = 'DEFEAT';
    announcement.style.color = '#ff4a4a'; // Red
  } else if (transitionType === 'victory') {
    announcement.innerHTML = 'VICTORY';
    announcement.style.color = '#4aff4a'; // Lime green
  } else {
    // Normal turn transition
    announcement.innerHTML = `Turn <span id="turn-announce-number">${turnNumber}</span>`;
    // Set faction color from player's empire color
    const currentPlayer = gameState.players.find(p => p.id === playerId);
    const factionColor = currentPlayer?.empire_color || '#4a9eff';
    announcement.style.color = factionColor;
  }

  // Trigger animation
  overlay.classList.add('active');

  // Remove after animation completes, then show turn summary
  setTimeout(() => {
    overlay.classList.remove('active');

    // For observers (defeated/victor), check if we should skip turn summary on subsequent turns
    if (gameState.isObserver && transitionType === 'turn') {
      // Already in observer mode - skip turn summary
      return;
    }

    // Start the animated turn summary after turn announcement
    // When game ends (defeat/victory), the turn doesn't advance, so show current turn's events
    // For normal turns, show the previous turn that just resolved
    const summaryTurn = (transitionType === 'defeat' || transitionType === 'victory')
      ? turnNumber
      : turnNumber - 1;
    showTurnSummary(summaryTurn, transitionType);
  }, 2500);
}

// Animated event log reveal system
let eventRevealQueue = [];
let isRevealingEvents = false;

function showTurnSummary(turnNumber, transitionType = 'turn') {
  // Don't show turn summary for game start (turn 0 doesn't exist)
  if (turnNumber <= 0) {
    return;
  }

  // Get events for this specific turn (the turn that just resolved)
  const turnEvents = (gameState.combatLogs || []).filter(log =>
    log.turnNumber === turnNumber && log.logType !== 'turn_start'
  );

  // Open the turn summary popup
  const overlay = document.getElementById('turn-summary-overlay');
  overlay.style.display = 'flex';

  // Update stats in the header
  const ownedPlanets = gameState.planets.filter(p => p.owner_id === playerId).length;
  const ownedMechs = gameState.mechs.filter(m => m.owner_id === playerId).length;
  document.getElementById('summary-planets').textContent = ownedPlanets;
  document.getElementById('summary-mechs').textContent = ownedMechs;
  const summaryCreditsEl = document.getElementById('summary-credits');
  summaryCreditsEl.textContent = gameState.credits;
  if (gameState.credits < 0) {
    summaryCreditsEl.classList.add('negative');
  } else {
    summaryCreditsEl.classList.remove('negative');
  }
  const summaryIncomeEl = document.getElementById('summary-income');
  const netIncome = gameState.incomeBreakdown ? gameState.incomeBreakdown.netIncome : gameState.income;
  summaryIncomeEl.textContent = netIncome;
  if (netIncome < 0) {
    summaryIncomeEl.classList.add('negative');
  } else {
    summaryIncomeEl.classList.remove('negative');
  }

  // Update the Start Turn button text based on transition type
  const startBtn = document.getElementById('start-turn-btn');
  if (transitionType === 'defeat') {
    startBtn.textContent = 'Observe';
    startBtn.dataset.transitionType = 'defeat';
  } else if (transitionType === 'victory') {
    startBtn.textContent = 'Survey your Domain';
    startBtn.dataset.transitionType = 'victory';
  } else {
    startBtn.textContent = `Start Turn ${turnNumber + 1}`;
    startBtn.dataset.transitionType = 'turn';
  }

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
  const maintenanceEvents = turnEvents.filter(log => log.logType === 'maintenance');
  const maintenanceFailureEvents = turnEvents.filter(log => log.logType === 'maintenance_failure');
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
  const separatorText = (transitionType === 'defeat' || transitionType === 'victory')
    ? 'Game Over'
    : `Start of Turn ${turnNumber + 1}`;
  eventRevealQueue.push({ type: 'separator', html: `<div class="log-separator">${separatorText}</div>` });

  // Add income section
  if (incomeEvents.length > 0) {
    eventRevealQueue.push({ type: 'header', html: '<div class="log-section-header">Income</div>' });
    for (const log of incomeEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
  }

  // Add maintenance section
  if (maintenanceEvents.length > 0) {
    eventRevealQueue.push({ type: 'header', html: '<div class="log-section-header">Maintenance</div>' });
    for (const log of maintenanceEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
  }

  // Add critical maintenance failure section (with line-by-line mech damage reveal)
  if (maintenanceFailureEvents.length > 0) {
    eventRevealQueue.push({ type: 'header', html: '<div class="log-section-header warning-header">Critical Maintenance Report</div>' });
    for (const log of maintenanceFailureEvents) {
      const failureItems = getMaintenanceFailureRevealItems(log);
      for (const item of failureItems) {
        eventRevealQueue.push(item);
      }
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

  // Add game-ending events (defeat, victory, eliminations)
  const defeatEvents = turnEvents.filter(log => log.logType === 'defeat');
  const victoryEvents = turnEvents.filter(log => log.logType === 'victory');
  const playerDefeatedEvents = turnEvents.filter(log => log.logType === 'player_defeated');
  const gameWonEvents = turnEvents.filter(log => log.logType === 'game_won');

  if (defeatEvents.length > 0 || victoryEvents.length > 0 || playerDefeatedEvents.length > 0 || gameWonEvents.length > 0) {
    eventRevealQueue.push({ type: 'header', html: '<div class="log-section-header">Game Status</div>' });
    for (const log of playerDefeatedEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
    for (const log of defeatEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
    for (const log of gameWonEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
    for (const log of victoryEvents) {
      eventRevealQueue.push({ type: 'event', html: formatEventLog(log) });
    }
  }

  // If no events occurred, show a message
  if (turnEvents.length === 0) {
    eventRevealQueue.push({ type: 'event', html: '<div class="log-entry log-empty">No important events occurred.</div>' });
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

  // Save current turn to localStorage so we don't show summary again
  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('id');
  if (gameId && gameState) {
    localStorage.setItem(`warbots_lastSeenTurn_${gameId}`, gameState.currentTurn);
  }

  // Check if we should enter observer mode
  const startBtn = document.getElementById('start-turn-btn');
  const transitionType = startBtn.dataset.transitionType;
  if (transitionType === 'defeat' || transitionType === 'victory') {
    enterObserverMode();
  }
}

// Enter observer mode - replace orders panel with player list, disable actions
function enterObserverMode() {
  // Stop the turn timer - game is over for this player
  stopTurnTimer();

  // Hide orders panel, show observer panel
  document.getElementById('orders-panel').style.display = 'none';
  document.getElementById('observer-panel').style.display = 'block';

  // Hide mechs panel (no dragging in observer mode)
  document.getElementById('mechs-panel').style.display = 'none';

  // Hide build panel
  document.querySelector('.build-panel').style.display = 'none';

  // Hide submit turn / waiting indicators
  document.getElementById('submit-turn').style.display = 'none';
  document.getElementById('waiting-indicator').style.display = 'none';
  document.getElementById('waiting-for-players').style.display = 'none';

  // Update observer player list
  updateObserverPanel();

  // Update empire name to show status
  const empireDisplay = document.getElementById('empire-name-display');
  const currentPlayer = gameState.players.find(p => p.id === playerId);
  if (currentPlayer) {
    const statusText = gameState.isVictor ? ' - VICTOR' : ' - DEFEATED';
    const statusColor = gameState.isVictor ? '#4aff4a' : '#ff4a4a';
    empireDisplay.innerHTML = `${currentPlayer.empire_name || `Player ${currentPlayer.player_number}`}<span style="color: ${statusColor};">${statusText}</span>`;
    empireDisplay.style.color = currentPlayer.empire_color || '#4a9eff';
  }
}

function updateObserverPanel() {
  const container = document.getElementById('observer-players-list');
  if (!container || !gameState.players) return;

  let html = '';
  for (const player of gameState.players) {
    const isVictor = gameState.winnerId === player.id;
    const isDefeated = player.is_eliminated === 1;

    let statusHtml = '';
    if (isVictor) {
      statusHtml = '<span class="player-status victor">VICTOR</span>';
    } else if (isDefeated) {
      statusHtml = '<span class="player-status defeated">DEFEATED</span>';
    } else {
      statusHtml = '<span class="player-status active">ACTIVE</span>';
    }

    html += `
      <div class="observer-player-item" style="border-left: 3px solid ${player.empire_color};">
        <div class="observer-player-name" style="color: ${player.empire_color};">
          ${player.empire_name || player.display_name}
          ${statusHtml}
        </div>
        <div class="observer-player-stats">
          <span class="stat-planets"><img src="/assets/Icon-Planet.png" class="stat-icon" alt="">Planets: ${player.planet_count || 0}</span>
          <span class="stat-mechs"><img src="/assets/Mech.png" class="stat-icon" alt="">Mechs: ${player.mech_count || 0}</span>
          <span class="stat-credits"><img src="/assets/Credit.png" class="stat-icon" alt="">Credits: ${player.credits || 0}</span>
          <span class="stat-income"><img src="/assets/IncomePlus.png" class="stat-icon" alt="">Income: ${player.income || 0}</span>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

let turnTimerFrameId = null;

function startTurnTimer(deadline) {
  // Cancel any existing timer
  if (turnTimerFrameId) {
    cancelAnimationFrame(turnTimerFrameId);
    turnTimerFrameId = null;
  }

  const timerEl = document.getElementById('turn-timer');

  function update() {
    const now = new Date();
    const diff = deadline - now;

    if (diff <= 0) {
      timerEl.textContent = '00:00';
      turnTimerFrameId = null;

      // Auto-submit pending orders if player hasn't submitted yet
      if (!gameState.hasSubmittedTurn && gameState.status === 'active') {
        console.log('Timer expired - auto-submitting pending orders');
        submitTurn();
      }
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

    turnTimerFrameId = requestAnimationFrame(update);
  }

  update();
}

function stopTurnTimer() {
  if (turnTimerFrameId) {
    cancelAnimationFrame(turnTimerFrameId);
    turnTimerFrameId = null;
  }
  const timerEl = document.getElementById('turn-timer');
  timerEl.textContent = '--:--';
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
      // Refresh to update players list
      refreshGameState(gameId);
    } else if (data.type === 'game_started') {
      // Game has started - refresh and show turn 1
      handleGameStarted(gameId);
    }
  };

  eventSource.onerror = () => {
    console.log('SSE connection error, will retry...');
  };
}

async function refreshGameState(gameId) {
  try {
    const previousTurn = gameState?.currentTurn;
    const previousStatus = gameState?.status;
    const wasEliminated = gameState?.isEliminated;
    const wasObserver = gameState?.isObserver;
    gameState = await api.getGameState(gameId);

    document.getElementById('turn-number').textContent = gameState.currentTurn;
    updatePlayerInfo();
    updateMapState();
    updateEventLog();
    refreshMechsPanel();

    // Update lobby panel if still waiting
    if (gameState.status === 'waiting') {
      updateLobbyPanel();
      showWaitingForPlayers(true);
    } else {
      // Hide waiting indicators on new turn / game start
      showWaitingIndicator(false);
      showWaitingForPlayers(false);
    }

    // Show turn announcement if turn changed OR game just ended
    // (When game ends with a winner, the turn doesn't advance, so we also check status change)
    const turnChanged = previousTurn !== null && previousTurn !== undefined && gameState.currentTurn !== previousTurn;
    const gameJustEnded = previousStatus !== 'finished' && gameState.status === 'finished';

    // Clear pending orders when turn advances (they've been processed)
    if (turnChanged) {
      // Clear orders from previous turn's storage
      clearOrdersFromStorage(gameId, previousTurn);
      // Reset pending orders
      pendingOrders = { moves: [], builds: [] };
      updateOrdersList();
      updateMovementArrows();
    }

    if (turnChanged || gameJustEnded) {
      // Check if player was just eliminated this turn
      if (!wasEliminated && gameState.isEliminated) {
        showTurnAnnouncement(gameState.currentTurn, 'defeat');
      }
      // Check if player just won
      else if (gameState.isVictor && previousStatus !== 'finished') {
        showTurnAnnouncement(gameState.currentTurn, 'victory');
      }
      // Already in observer mode - simpler transition
      else if (gameState.isObserver) {
        showTurnAnnouncement(gameState.currentTurn, 'turn');
      }
      // Normal turn
      else {
        showTurnAnnouncement(gameState.currentTurn);
      }
    }

    // If already in observer mode on page load, enter observer mode
    if (gameState.isObserver && !wasObserver) {
      enterObserverMode();
    }

    // Update turn timer (only for active games)
    if (gameState.turnDeadline && gameState.status === 'active') {
      startTurnTimer(new Date(gameState.turnDeadline));
    } else if (gameState.status === 'finished') {
      stopTurnTimer();
    }
  } catch (error) {
    console.error('Failed to refresh game state:', error);
  }
}

async function handleGameStarted(gameId) {
  try {
    gameState = await api.getGameState(gameId);

    document.getElementById('turn-number').textContent = gameState.currentTurn;
    updatePlayerInfo();
    updateMapState();
    updateEventLog();
    refreshMechsPanel();

    // Hide lobby panel and show orders panel
    showLobbyPanel(false);
    showWaitingForPlayers(false);

    // Show turn 1 announcement
    showTurnAnnouncement(1);

    if (gameState.turnDeadline) {
      startTurnTimer(new Date(gameState.turnDeadline));
    }
  } catch (error) {
    console.error('Failed to handle game start:', error);
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
    const moveContainer = document.createElement('div');
    moveContainer.className = 'mech-move-container';

    const moveText = document.createElement('span');
    moveText.className = 'mech-move-text';
    moveText.textContent = `Moving to (${moveOrder.toX}, ${moveOrder.toY})`;
    moveContainer.appendChild(moveText);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mech-cancel-btn';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Cancel movement order';
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cancelMoveOrder(mech.id);
    });
    moveContainer.appendChild(cancelBtn);

    infoContainer.appendChild(moveContainer);
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
