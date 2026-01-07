// Lobby page functionality

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
        <div>
          ${game.status === 'waiting' && game.is_host ?
            `<button class="btn btn-small" onclick="startGame(${game.id})"
              ${game.player_count < 2 ? 'disabled title="Need at least 2 players"' : ''}>
              Start
            </button>` : ''
          }
          <a href="/game.html?id=${game.id}" class="btn btn-primary btn-small">
            ${game.status === 'waiting' ? 'View' : 'Play'}
          </a>
        </div>
      </div>
    `).join('');
  } catch (error) {
    container.innerHTML = `<p class="error">Failed to load your games: ${error.message}</p>`;
  }
}

async function handleCreateGame(e) {
  e.preventDefault();

  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating...';

  try {
    const game = await api.createGame({
      name: document.getElementById('game-name').value,
      gridSize: parseInt(document.getElementById('grid-size').value),
      maxPlayers: parseInt(document.getElementById('max-players').value),
      turnTimer: parseInt(document.getElementById('turn-timer').value)
    });

    // Redirect to the game
    window.location.href = `/game.html?id=${game.id}`;
  } catch (error) {
    alert('Failed to create game: ' + error.message);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Game';
  }
}

async function joinGame(gameId) {
  try {
    await api.joinGame(gameId);
    window.location.href = `/game.html?id=${gameId}`;
  } catch (error) {
    alert('Failed to join game: ' + error.message);
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
