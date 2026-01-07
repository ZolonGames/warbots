// Map rendering with Canvas

class GameMap {
  constructor(canvas, gridSize) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.gridSize = gridSize;
    this.tileSize = 20;
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 1;

    // Colors
    this.colors = {
      space: '#0a0a0f',
      grid: '#1a1a25',
      planet: '#4a4a5a',
      planetOwned: ['#4a9eff', '#4aff9e', '#ff4a4a', '#ffcc4a', '#ff4aff', '#4affff', '#ffaa4a', '#aa4aff'],
      homeworld: '#ffd700',
      mech: '#ffffff',
      fog: 'rgba(0, 0, 0, 0.7)'
    };

    // State
    this.planets = [];
    this.mechs = [];
    this.visibleTiles = new Set();
    this.selectedTile = null;
    this.hoveredTile = null;

    // Event handlers
    this.onTileClick = null;
    this.onTileHover = null;

    this.setupCanvas();
    this.setupEvents();
  }

  setupCanvas() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const container = this.canvas.parentElement;
    this.canvas.width = container.clientWidth;
    this.canvas.height = container.clientHeight;

    // Calculate tile size to fit grid
    const maxTileWidth = this.canvas.width / this.gridSize;
    const maxTileHeight = this.canvas.height / this.gridSize;
    this.tileSize = Math.max(8, Math.min(40, Math.floor(Math.min(maxTileWidth, maxTileHeight))));

    // Center the grid
    const gridWidth = this.gridSize * this.tileSize;
    const gridHeight = this.gridSize * this.tileSize;
    this.offsetX = Math.floor((this.canvas.width - gridWidth) / 2);
    this.offsetY = Math.floor((this.canvas.height - gridHeight) / 2);

    this.render();
  }

  setupEvents() {
    this.canvas.addEventListener('click', (e) => this.handleClick(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());
  }

  getTileFromMouse(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - this.offsetX;
    const y = e.clientY - rect.top - this.offsetY;

    const tileX = Math.floor(x / this.tileSize);
    const tileY = Math.floor(y / this.tileSize);

    if (tileX >= 0 && tileX < this.gridSize && tileY >= 0 && tileY < this.gridSize) {
      return { x: tileX, y: tileY };
    }
    return null;
  }

  handleClick(e) {
    const tile = this.getTileFromMouse(e);
    if (tile && this.onTileClick) {
      this.selectedTile = tile;
      this.onTileClick(tile);
      this.render();
    }
  }

  handleMouseMove(e) {
    const tile = this.getTileFromMouse(e);
    if (tile && this.onTileHover) {
      this.hoveredTile = tile;
      this.onTileHover(tile, e);
      this.render();
    }
  }

  handleMouseLeave() {
    this.hoveredTile = null;
    this.render();
  }

  setGameState(state) {
    this.planets = state.planets || [];
    this.mechs = state.mechs || [];
    this.visibleTiles = new Set(state.visibleTiles || []);
    this.render();
  }

  render() {
    const ctx = this.ctx;

    // Clear canvas
    ctx.fillStyle = this.colors.space;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw grid
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 0.5;

    for (let x = 0; x <= this.gridSize; x++) {
      const px = this.offsetX + x * this.tileSize;
      ctx.beginPath();
      ctx.moveTo(px, this.offsetY);
      ctx.lineTo(px, this.offsetY + this.gridSize * this.tileSize);
      ctx.stroke();
    }

    for (let y = 0; y <= this.gridSize; y++) {
      const py = this.offsetY + y * this.tileSize;
      ctx.beginPath();
      ctx.moveTo(this.offsetX, py);
      ctx.lineTo(this.offsetX + this.gridSize * this.tileSize, py);
      ctx.stroke();
    }

    // Draw planets
    for (const planet of this.planets) {
      this.drawPlanet(planet);
    }

    // Draw mechs
    for (const mech of this.mechs) {
      this.drawMech(mech);
    }

    // Draw fog of war
    for (let x = 0; x < this.gridSize; x++) {
      for (let y = 0; y < this.gridSize; y++) {
        const key = `${x},${y}`;
        if (!this.visibleTiles.has(key)) {
          const px = this.offsetX + x * this.tileSize;
          const py = this.offsetY + y * this.tileSize;
          ctx.fillStyle = this.colors.fog;
          ctx.fillRect(px, py, this.tileSize, this.tileSize);
        }
      }
    }

    // Draw selection highlight
    if (this.selectedTile) {
      const px = this.offsetX + this.selectedTile.x * this.tileSize;
      const py = this.offsetY + this.selectedTile.y * this.tileSize;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, this.tileSize - 2, this.tileSize - 2);
    }

    // Draw hover highlight
    if (this.hoveredTile && (!this.selectedTile ||
        this.hoveredTile.x !== this.selectedTile.x ||
        this.hoveredTile.y !== this.selectedTile.y)) {
      const px = this.offsetX + this.hoveredTile.x * this.tileSize;
      const py = this.offsetY + this.hoveredTile.y * this.tileSize;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 1, py + 1, this.tileSize - 2, this.tileSize - 2);
    }
  }

  drawPlanet(planet) {
    const ctx = this.ctx;
    const px = this.offsetX + planet.x * this.tileSize + this.tileSize / 2;
    const py = this.offsetY + planet.y * this.tileSize + this.tileSize / 2;
    const radius = this.tileSize * 0.35;

    // Planet color based on owner
    if (planet.is_homeworld) {
      ctx.fillStyle = this.colors.homeworld;
    } else if (planet.owner_id !== null) {
      ctx.fillStyle = this.colors.planetOwned[planet.owner_id % this.colors.planetOwned.length];
    } else {
      ctx.fillStyle = this.colors.planet;
    }

    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();

    // Draw income indicator (small dots)
    if (this.tileSize >= 16) {
      const income = planet.base_income;
      const dotRadius = 2;
      const startAngle = -Math.PI / 2;

      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < income; i++) {
        const angle = startAngle + (i / income) * Math.PI * 2;
        const dx = Math.cos(angle) * (radius + 4);
        const dy = Math.sin(angle) * (radius + 4);
        ctx.beginPath();
        ctx.arc(px + dx, py + dy, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawMech(mech) {
    const ctx = this.ctx;
    const px = this.offsetX + mech.x * this.tileSize;
    const py = this.offsetY + mech.y * this.tileSize;

    // Mech indicator in corner
    const size = this.tileSize * 0.3;
    const color = this.colors.planetOwned[mech.owner_id % this.colors.planetOwned.length];

    ctx.fillStyle = color;
    ctx.fillRect(px + 2, py + 2, size, size);

    // Show mech count if multiple
    if (mech.count > 1 && this.tileSize >= 16) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.floor(this.tileSize * 0.4)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(mech.count.toString(), px + this.tileSize / 2, py + this.tileSize - 3);
    }
  }
}
