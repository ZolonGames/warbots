// Lobby page functionality

// All 15 empire colors
const ALL_COLORS = [
  '#FF0000', '#0000FF', '#008000', '#FFFF00', '#FFFFFF',
  '#808080', '#800080', '#FFA500', '#FFC0CB', '#00FFFF',
  '#6DFD4C', '#FF0181', '#900DFF', '#C00000', '#0000C0'
];

// State for empire modal
let empireModalCallback = null;
let empireModalGameId = null;
let availableColors = [...ALL_COLORS];

document.addEventListener('DOMContentLoaded', async () => {
  // Check if user is authenticated
  const authData = await api.getMe();
  if (!authData.authenticated) {
    window.location.href = '/';
    return;
  }

  // Display user name
  document.getElementById('user-name').textContent = authData.user.displayName;

  // Load games
  await Promise.all([loadAvailableGames(), loadMyGames(), loadFinishedGames()]);

  // Set up create game form
  document.getElementById('create-game-form').addEventListener('submit', handleCreateGame);

  // Set up empire form
  document.getElementById('empire-form').addEventListener('submit', handleEmpireSubmit);
});

async function loadAvailableGames() {
  const container = document.getElementById('games-container');

  try {
    const games = await api.getGames();

    if (games.length === 0) {
      container.innerHTML = '<p class="empty">No open games available. Create one!</p>';
      return;
    }

    container.innerHTML = games.map(game => `
      <div class="game-card">
        <div class="game-card-info">
          <h4>${escapeHtml(game.name)}</h4>
          <p>
            ${game.grid_size}x${game.grid_size} map |
            <span class="players">${game.player_count}/${game.max_players} players</span> |
            ${formatTimer(game.turn_timer)}
          </p>
        </div>
        <button class="btn btn-primary btn-small" onclick="joinGame(${game.id})">
          Join
        </button>
      </div>
    `).join('');
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load games: ${error.message}</p>`;
  }
}

async function refreshAvailableGames() {
  const btn = document.getElementById('refresh-games');
  btn.disabled = true;
  btn.textContent = 'Refreshing...';

  try {
    await loadAvailableGames();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
}

async function loadMyGames() {
  const container = document.getElementById('my-games-container');

  try {
    const allGames = await api.getMyGames();
    // Filter to only active games (not finished)
    const games = allGames.filter(g => g.status !== 'finished');

    if (games.length === 0) {
      container.innerHTML = '<p class="empty">You\'re not in any active games.</p>';
      return;
    }

    container.innerHTML = games.map(game => renderGameCard(game)).join('');
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load your games: ${error.message}</p>`;
  }
}

async function loadFinishedGames() {
  const container = document.getElementById('finished-games-container');

  try {
    const allGames = await api.getMyGames();
    // Filter to only finished games
    const games = allGames.filter(g => g.status === 'finished');

    if (games.length === 0) {
      container.innerHTML = '<p class="empty">No finished games.</p>';
      return;
    }

    container.innerHTML = games.map(game => renderGameCard(game)).join('');
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load finished games: ${error.message}</p>`;
  }
}

function renderGameCard(game) {
  // Determine status badge
  let statusBadge = '';
  if (game.is_victor) {
    statusBadge = '<span class="game-status-badge victor">Victor</span>';
  } else if (game.is_eliminated) {
    statusBadge = '<span class="game-status-badge defeated">Defeated</span>';
  } else if (game.status === 'finished') {
    statusBadge = '<span class="game-status-badge finished">Finished</span>';
  }

  // Determine status text
  let statusText;
  if (game.status === 'waiting') {
    statusText = 'Waiting for players';
  } else if (game.status === 'finished') {
    statusText = 'Game Over';
  } else {
    statusText = 'In progress';
  }

  // Determine button text
  let buttonText;
  if (game.status === 'waiting') {
    buttonText = 'View';
  } else if (game.status === 'finished' || game.is_eliminated || game.is_victor) {
    buttonText = 'Observe';
  } else {
    buttonText = 'Play';
  }

  return `
    <div class="game-card">
      <div class="game-card-info">
        <h4>${escapeHtml(game.name)}${statusBadge}</h4>
        <p class="empire-info" style="color: ${game.empire_color || '#888'}">
          ${escapeHtml(game.empire_name || 'Unknown Empire')}
        </p>
        <p>
          Turn ${game.current_turn} |
          ${statusText} |
          <span class="players">${game.status === 'active' ? `${game.remaining_players}/${game.player_count} Players Remaining` : `${game.player_count}/${game.max_players} players`}</span> |
          ${formatTimer(game.turn_timer)}
        </p>
        ${game.status !== 'waiting' ? `
          <p class="game-stats">
            <span class="stat-planets">${game.planet_count} planets</span> |
            <span class="stat-mechs">${game.mech_count} mechs</span> |
            <span class="stat-credits${game.credits < 0 ? ' negative' : ''}">${game.credits} credits</span> |
            <span class="stat-income${game.income < 0 ? ' negative' : ''}">${game.income >= 0 ? '+' : ''}${game.income}/turn</span>
          </p>
        ` : ''}
      </div>
      <div class="game-card-actions">
        ${game.status === 'waiting' && game.is_host ?
          `<button class="btn btn-small" onclick="startGame(${game.id})"
            ${game.player_count < 2 ? 'disabled title="Need at least 2 players"' : ''}>
            Start
          </button>` : ''
        }
        <a href="/game.html?id=${game.id}" class="btn btn-primary btn-small">
          ${buttonText}
        </a>
        ${game.is_host ?
          `<button class="btn btn-danger btn-small" onclick="confirmDeleteGame(${game.id}, '${escapeHtml(game.name).replace(/'/g, "\\'")}')">
            Delete
          </button>` : ''
        }
      </div>
    </div>
  `;
}

async function handleCreateGame(e) {
  e.preventDefault();

  // Store the game settings and show empire modal
  const gameSettings = {
    name: document.getElementById('game-name').value,
    gridSize: parseInt(document.getElementById('grid-size').value),
    maxPlayers: parseInt(document.getElementById('max-players').value),
    turnTimer: parseInt(document.getElementById('turn-timer').value)
  };

  // For create, all colors are available
  availableColors = [...ALL_COLORS];
  empireModalGameId = null;

  showEmpireModal('Set Up Your Empire', async (empireName, empireColor) => {
    const submitBtn = document.querySelector('#create-game-form button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    try {
      const game = await api.createGame({
        ...gameSettings,
        empireName,
        empireColor
      });

      // Redirect to the game
      window.location.href = `/game.html?id=${game.id}`;
    } catch (error) {
      alert('Failed to create game: ' + error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Game';
    }
  });
}

async function joinGame(gameId) {
  try {
    // Fetch available colors for this game
    const colorData = await api.getAvailableColors(gameId);
    availableColors = colorData.colors;
    empireModalGameId = gameId;

    if (availableColors.length === 0) {
      alert('No colors available for this game.');
      return;
    }

    showEmpireModal('Join Game - Set Up Your Empire', async (empireName, empireColor) => {
      try {
        await api.joinGame(gameId, { empireName, empireColor });
        window.location.href = `/game.html?id=${gameId}`;
      } catch (error) {
        alert('Failed to join game: ' + error.message);
      }
    });
  } catch (error) {
    alert('Failed to join game: ' + error.message);
  }
}

function showEmpireModal(title, callback) {
  empireModalCallback = callback;

  document.getElementById('empire-modal-title').textContent = title;
  document.getElementById('empire-name').value = '';
  document.getElementById('selected-color').value = '';

  // Build color picker
  const picker = document.getElementById('color-picker');
  picker.innerHTML = ALL_COLORS.map(color => {
    const isAvailable = availableColors.includes(color);
    return `
      <div class="color-option ${isAvailable ? '' : 'taken'}"
           style="background-color: ${color};"
           data-color="${color}"
           ${isAvailable ? `onclick="selectColor('${color}')"` : ''}
           title="${isAvailable ? color : 'Already taken'}">
      </div>
    `;
  }).join('');

  document.getElementById('empire-modal').style.display = 'flex';
}

function closeEmpireModal() {
  document.getElementById('empire-modal').style.display = 'none';
  empireModalCallback = null;
}

function selectColor(color) {
  // Remove selection from all
  document.querySelectorAll('.color-option').forEach(el => {
    el.classList.remove('selected');
  });

  // Add selection to clicked one
  const selected = document.querySelector(`.color-option[data-color="${color}"]`);
  if (selected) {
    selected.classList.add('selected');
  }

  document.getElementById('selected-color').value = color;
}

function handleEmpireSubmit(e) {
  e.preventDefault();

  const empireName = document.getElementById('empire-name').value.trim();
  const empireColor = document.getElementById('selected-color').value;

  if (!empireName) {
    alert('Please enter an empire name.');
    return;
  }

  if (!empireColor) {
    alert('Please select a color.');
    return;
  }

  if (empireModalCallback) {
    // Save callback before closing (closeEmpireModal sets it to null)
    const callback = empireModalCallback;
    closeEmpireModal();
    callback(empireName, empireColor);
  }
}

async function startGame(gameId) {
  try {
    await api.startGame(gameId);
    window.location.href = `/game.html?id=${gameId}`;
  } catch (error) {
    alert('Failed to start game: ' + error.message);
  }
}

function confirmDeleteGame(gameId, gameName) {
  if (confirm(`Are you sure you want to delete "${gameName}"?\n\nThis will permanently remove all game data and cannot be undone.`)) {
    deleteGame(gameId);
  }
}

async function deleteGame(gameId) {
  try {
    await api.deleteGame(gameId);
    // Reload the games lists
    await Promise.all([loadAvailableGames(), loadMyGames(), loadFinishedGames()]);
  } catch (error) {
    alert('Failed to delete game: ' + error.message);
  }
}

function formatTimer(seconds) {
  if (seconds < 60) return `${seconds}s turns`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m turns`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h turns`;
  return `${Math.floor(seconds / 86400)}d turns`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Patch Notes Data
const PATCH_NOTES = [
  {
    version: '1.4.0',
    title: 'Waypoint Navigation',
    changes: [
      'Drag mechs beyond adjacent tiles to set waypoint destinations',
      'Mechs automatically move toward waypoints at 1 tile per turn',
      'Dashed arrows show path to waypoint with turn count labels',
      'Waypoints persist across turns until destination is reached',
      'Adjacent tiles highlighted in blue, distant tiles in yellow during drag',
      'Orders panel shows waypoint routes with remaining turn count',
      'Increased planet spacing to 4-5 tiles apart for more strategic map',
      'Added 500 unique planet names loaded from JSON'
    ]
  },
  {
    version: '1.3.8',
    changes: [
      'Added Patch Notes modal - click version number to view',
      'Major versions display with gold headings and titles',
      'Minor versions display with blue headings',
      'Hotfixes display with smaller grey headings'
    ]
  },
  {
    version: '1.3.7',
    changes: [
      'Fixed observer mode UI - submit button no longer reappears on turn refresh',
      'Hidden Planet Management and Mech Management buttons in observer mode',
      'Star Empires list now updates on turn refresh when modal is open'
    ]
  },
  {
    version: '1.3.6',
    changes: [
      'Fixed lobby player counts to exclude Pirates faction',
      'Active games now show "X/Y Players Remaining" format',
      'Added remaining_players count for active games'
    ]
  },
  {
    version: '1.3.5',
    changes: [
      'Fixed Retire feature - Pirates now properly excluded from turn submissions',
      'Pirates no longer appear in Star Empires list or observer panel',
      'Fixed confirmRetire calling non-existent function'
    ]
  },
  {
    version: '1.3.4',
    changes: [
      'Added Retire button to surrender your empire to Pirates',
      'Pirates faction created - dark grey neutral faction that takes over retired empires',
      'Retired players enter observer mode to watch the rest of the game'
    ]
  },
  {
    version: '1.3.3',
    changes: [
      'Improved AI exploration - AI now actively scouts the map',
      'AI claims neutral planets with light mechs',
      'AI builds scout mechs when low on explorers',
      'Added AI log culling to keep only 10,000 most recent lines'
    ]
  },
  {
    version: '1.3.2',
    changes: [
      'Server-side order storage implemented',
      'Orders now persist across page refreshes',
      'Fixed various order synchronization issues'
    ]
  },
  {
    version: '1.3.0',
    title: 'Star Empires Update',
    changes: [
      'Added Star Empires panel showing all players and their status',
      'Empire colors and names displayed throughout the game',
      'Turn submission status visible for all players',
      'Added Mech Management panel for organizing your forces'
    ]
  },
  {
    version: '1.2.0',
    title: 'The AI Awakens',
    changes: [
      'Added AI players to fill empty slots',
      'AI makes strategic decisions for movement and building',
      'AI aggressively pursues enemy planets and defends its own',
      'Improved combat resolution and balance'
    ]
  },
  {
    version: '1.1.0',
    title: 'Fog of War',
    changes: [
      'Added fog of war - only see tiles near your planets and mechs',
      'Visibility range: 3 tiles from planets, 2 tiles from mechs',
      'Enemy movements hidden until they enter your visibility',
      'Strategic scouting now required for map awareness'
    ]
  },
  {
    version: '1.0.0',
    title: 'Initial Release',
    changes: [
      'Core gameplay: planets, mechs, buildings, and combat',
      'Turn-based multiplayer with configurable timers',
      'Four mech types: Light, Medium, Heavy, and Assault',
      'Three building types: Mining Colony, Factory, and Fortification',
      'Google OAuth authentication',
      'Real-time turn notifications via SSE'
    ]
  }
];

function openPatchNotes() {
  const container = document.getElementById('patch-notes-content');
  container.innerHTML = renderPatchNotes();
  document.getElementById('patch-notes-modal').style.display = 'flex';
}

function closePatchNotes() {
  document.getElementById('patch-notes-modal').style.display = 'none';
}

function renderPatchNotes() {
  // Show latest 10 versions
  const notesToShow = PATCH_NOTES.slice(0, 10);

  return notesToShow.map(note => {
    const [major, minor, patch] = note.version.split('.').map(Number);

    let headingClass, headingTag;
    if (patch === 0 && minor === 0) {
      // Major version (X.0.0)
      headingClass = 'patch-major';
      headingTag = 'h2';
    } else if (patch === 0) {
      // Minor version (x.Y.0)
      headingClass = 'patch-minor';
      headingTag = 'h3';
    } else {
      // Hotfix (x.y.Z)
      headingClass = 'patch-hotfix';
      headingTag = 'h4';
    }

    const versionText = note.title
      ? `v${note.version} - ${note.title}`
      : `v${note.version}`;

    return `
      <div class="patch-entry ${headingClass}">
        <${headingTag} class="patch-version">${escapeHtml(versionText)}</${headingTag}>
        <ul class="patch-changes">
          ${note.changes.map(change => `<li>${escapeHtml(change)}</li>`).join('')}
        </ul>
      </div>
    `;
  }).join('');
}
