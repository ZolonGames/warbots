// Lobby page functionality

// All 20 empire colors (sorted by hex value)
const ALL_COLORS = [
  '#1E90FF', '#2E8B57', '#4169E1', '#4682B4', '#556B2F',
  '#6A5ACD', '#708090', '#8B0000', '#8B4513', '#9400D3',
  '#B22222', '#CD853F', '#D2691E', '#DAA520', '#DC143C',
  '#FF4500', '#FF6347', '#FF8C00', '#FFD700', '#FF69B4'
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
  await Promise.all([loadAvailableGames(), loadMyGames()]);

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

async function loadMyGames() {
  const container = document.getElementById('my-games-container');

  try {
    const games = await api.getMyGames();

    if (games.length === 0) {
      container.innerHTML = '<p class="empty">You\'re not in any games yet.</p>';
      return;
    }

    container.innerHTML = games.map(game => `
      <div class="game-card">
        <div class="game-card-info">
          <h4>${escapeHtml(game.name)}</h4>
          <p>
            Turn ${game.current_turn} |
            ${game.status === 'waiting' ? 'Waiting for players' : 'In progress'} |
            <span class="players">${game.player_count}/${game.max_players} players</span>
          </p>
        </div>
        <div class="game-card-actions">
          ${game.status === 'waiting' && game.is_host ?
            `<button class="btn btn-small" onclick="startGame(${game.id})"
              ${game.player_count < 2 ? 'disabled title="Need at least 2 players"' : ''}>
              Start
            </button>` : ''
          }
          <a href="/game.html?id=${game.id}" class="btn btn-primary btn-small">
            ${game.status === 'waiting' ? 'View' : 'Play'}
          </a>
          ${game.is_host ?
            `<button class="btn btn-danger btn-small" onclick="confirmDeleteGame(${game.id}, '${escapeHtml(game.name).replace(/'/g, "\\'")}')">
              Delete
            </button>` : ''
          }
        </div>
      </div>
    `).join('');
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load your games: ${error.message}</p>`;
  }
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
    closeEmpireModal();
    empireModalCallback(empireName, empireColor);
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
    await Promise.all([loadAvailableGames(), loadMyGames()]);
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
