// API wrapper for making requests to the backend

const api = {
  async get(url) {
    const response = await fetch(url);
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }
    return response.json();
  },

  async post(url, data) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }
    return response.json();
  },

  async delete(url) {
    const response = await fetch(url, {
      method: 'DELETE'
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }
    return response.json();
  },

  // Auth endpoints
  async getMe() {
    return this.get('/auth/me');
  },

  // Game endpoints
  async getGames() {
    return this.get('/api/games');
  },

  async getMyGames() {
    return this.get('/api/games/mine');
  },

  async createGame(data) {
    return this.post('/api/games', data);
  },

  async joinGame(gameId) {
    return this.post(`/api/games/${gameId}/join`);
  },

  async startGame(gameId) {
    return this.post(`/api/games/${gameId}/start`);
  },

  async getGameState(gameId) {
    return this.get(`/api/games/${gameId}/state`);
  },

  async submitTurn(gameId, orders) {
    return this.post(`/api/games/${gameId}/turns`, { orders });
  }
};
