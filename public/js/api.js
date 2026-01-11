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

  async put(url, data) {
    const response = await fetch(url, {
      method: 'PUT',
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

  async getObservableGames() {
    return this.get('/api/games/observable');
  },

  async createGame(data) {
    return this.post('/api/games', data);
  },

  async joinGame(gameId, data = {}) {
    return this.post(`/api/games/${gameId}/join`, data);
  },

  async startGame(gameId) {
    return this.post(`/api/games/${gameId}/start`);
  },

  async getGameState(gameId, observe = false) {
    const url = observe ? `/api/games/${gameId}/state?observe=1` : `/api/games/${gameId}/state`;
    return this.get(url);
  },

  async submitTurn(gameId, orders) {
    return this.post(`/api/games/${gameId}/turns`, { orders });
  },

  async renamePlanet(planetId, name) {
    return this.post(`/api/planets/${planetId}/rename`, { name });
  },

  async deleteGame(gameId) {
    return this.delete(`/api/games/${gameId}`);
  },

  async getAvailableColors(gameId) {
    return this.get(`/api/games/${gameId}/colors`);
  },

  async updateEmpireColor(gameId, empireColor) {
    return this.post(`/api/games/${gameId}/empire`, { empireColor });
  },

  async getColorConflicts(gameId) {
    return this.get(`/api/games/${gameId}/color-conflicts`);
  },

  async addAIPlayer(gameId, data) {
    return this.post(`/api/games/${gameId}/ai`, data);
  },

  // Pending orders (server-side storage)
  async savePendingOrders(gameId, orders) {
    return this.put(`/api/games/${gameId}/orders`, { orders });
  },

  async getPendingOrders(gameId) {
    return this.get(`/api/games/${gameId}/orders`);
  }
};
