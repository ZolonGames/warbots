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

    // Set up UI handlers
    setupUIHandlers();

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
    visibleTiles: gameState.visibleTiles
  });
}

function updatePlayerInfo() {
  document.getElementById('player-credits').textContent = gameState.credits;
  document.getElementById('player-income').textContent = gameState.income;
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
    html += `<strong>${planet.is_homeworld ? 'Homeworld' : 'Planet'}</strong><br>`;
    html += `Income: ${planet.base_income}<br>`;
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
    html += `<p><strong>${planet.is_homeworld ? 'Homeworld' : 'Planet'}</strong></p>`;
    html += `<p>Income: ${planet.base_income}</p>`;
    html += `<p>Owner: ${planet.owner_id === playerId ? 'You' : (planet.owner_id ? 'Enemy' : 'Neutral')}</p>`;

    if (planet.buildings && planet.buildings.length > 0) {
      html += '<p><strong>Buildings:</strong></p><ul>';
      for (const building of planet.buildings) {
        html += `<li>${building.type}${building.type === 'fortification' ? ` (${building.hp} HP)` : ''}</li>`;
      }
      html += '</ul>';
    }

    // Show build panel if we own this planet
    if (planet.owner_id === playerId) {
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

function updateBuildButtons(planet) {
  const hasFactory = planet.buildings && planet.buildings.some(b => b.type === 'factory');
  const existingBuildings = new Set((planet.buildings || []).map(b => b.type));

  document.querySelectorAll('.build-btn').forEach(btn => {
    const type = btn.dataset.type;
    const buildType = btn.dataset.build;

    if (type === 'building') {
      // Check if building already exists on this planet
      if (existingBuildings.has(buildType)) {
        btn.disabled = true;
        btn.title = 'Already built on this planet';
      } else {
        btn.disabled = false;
        btn.title = '';
      }
    } else if (type === 'mech') {
      // Mechs require a factory
      if (!hasFactory) {
        btn.disabled = true;
        btn.title = 'Requires a Factory';
      } else {
        btn.disabled = false;
        btn.title = '';
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

  // Set up drag-and-drop for mechs from sidebar
  setupMapDropZone();
}

function addBuildOrder(planetId, type, buildType) {
  pendingOrders.builds.push({
    planetId,
    type,
    [type === 'mech' ? 'mechType' : 'buildingType']: buildType
  });
  updateOrdersList();
}

function addMoveOrder(mechId, toX, toY) {
  // Remove any existing move order for this mech
  pendingOrders.moves = pendingOrders.moves.filter(m => m.mechId !== mechId);
  pendingOrders.moves.push({ mechId, toX, toY });
  updateOrdersList();
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
    html += `
      <div class="order-item">
        <span>Move mech to (${order.toX}, ${order.toY})</span>
        <button class="order-remove" onclick="removeOrder('moves', ${i})">×</button>
      </div>
    `;
  }

  for (let i = 0; i < pendingOrders.builds.length; i++) {
    const order = pendingOrders.builds[i];
    const buildName = order.mechType || order.buildingType;
    html += `
      <div class="order-item">
        <span>Build ${buildName}</span>
        <button class="order-remove" onclick="removeOrder('builds', ${i})">×</button>
      </div>
    `;
  }

  container.innerHTML = html;
}

function removeOrder(type, index) {
  pendingOrders[type].splice(index, 1);
  updateOrdersList();
}

function clearOrders() {
  pendingOrders = { moves: [], builds: [] };
  updateOrdersList();
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
    gameState = await api.getGameState(gameId);
    document.getElementById('turn-number').textContent = gameState.currentTurn;
    updatePlayerInfo();
    updateMapState();

    // Hide waiting indicator on new turn
    showWaitingIndicator(false);

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

  // Type label
  const typeLabel = document.createElement('span');
  typeLabel.className = 'mech-type';
  typeLabel.textContent = mech.type.charAt(0).toUpperCase();
  item.appendChild(typeLabel);

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
