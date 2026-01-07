// Map rendering with Canvas - with zoom and pan support

class GameMap {
  constructor(canvas, gridSize) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.gridSize = gridSize;
    this.baseTileSize = 20;

    // View state
    this.scale = 1;
    this.minScale = 0.3;
    this.maxScale = 8;
    this.panX = 0;
    this.panY = 0;

    // Drag state
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragStartPanX = 0;
    this.dragStartPanY = 0;

    // Touch state
    this.lastTouchDistance = 0;
    this.lastTouchCenter = null;

    // Colors
    this.colors = {
      space: '#0a0a0f',
      grid: '#1a1a25',
      planet: '#4a4a5a',
      planetOwned: ['#4a9eff', '#4aff9e', '#ff4a4a', '#ffcc4a', '#ff4aff', '#4affff', '#ffaa4a', '#aa4aff'],
      homeworld: '#ffd700',
      mech: '#ffffff',
      fog: 'rgba(40, 40, 50, 0.85)'
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

    // Calculate base tile size to fit grid initially
    const maxTileWidth = this.canvas.width / this.gridSize;
    const maxTileHeight = this.canvas.height / this.gridSize;
    this.baseTileSize = Math.max(8, Math.min(40, Math.floor(Math.min(maxTileWidth, maxTileHeight))));

    // Center the view initially
    this.centerView();
    this.render();
  }

  centerView() {
    const gridWidth = this.gridSize * this.baseTileSize * this.scale;
    const gridHeight = this.gridSize * this.baseTileSize * this.scale;
    this.panX = (this.canvas.width - gridWidth) / 2;
    this.panY = (this.canvas.height - gridHeight) / 2;
  }

  get tileSize() {
    return this.baseTileSize * this.scale;
  }

  setupEvents() {
    // Mouse events
    this.canvas.addEventListener('click', (e) => this.handleClick(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());
    this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    this.canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
    this.canvas.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

    // Touch events
    this.canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', (e) => this.handleTouchEnd(e));

    // Prevent context menu on right-click
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Mouse handlers
  handleMouseDown(e) {
    if (e.button === 0 || e.button === 1 || e.button === 2) {
      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragStartPanX = this.panX;
      this.dragStartPanY = this.panY;
      this.canvas.style.cursor = 'grabbing';
    }
  }

  handleMouseUp(e) {
    const wasDragging = this.isDragging;
    const dragDistance = Math.sqrt(
      Math.pow(e.clientX - this.dragStartX, 2) +
      Math.pow(e.clientY - this.dragStartY, 2)
    );

    this.isDragging = false;
    this.canvas.style.cursor = 'default';

    // Only trigger click if we didn't drag significantly
    if (wasDragging && dragDistance < 5) {
      // This was a click, not a drag - handled by handleClick
    }
  }

  handleMouseMove(e) {
    if (this.isDragging) {
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      this.panX = this.dragStartPanX + dx;
      this.panY = this.dragStartPanY + dy;
      this.render();
    } else {
      const tile = this.getTileFromMouse(e);
      if (tile && this.onTileHover) {
        this.hoveredTile = tile;
        this.onTileHover(tile, e);
        this.render();
      }
    }
  }

  handleMouseLeave() {
    this.isDragging = false;
    this.hoveredTile = null;
    this.canvas.style.cursor = 'default';
    this.render();
  }

  handleWheel(e) {
    e.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Calculate zoom
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * zoomFactor));

    if (newScale !== this.scale) {
      // Zoom towards mouse position
      const scaleChange = newScale / this.scale;
      this.panX = mouseX - (mouseX - this.panX) * scaleChange;
      this.panY = mouseY - (mouseY - this.panY) * scaleChange;
      this.scale = newScale;
      this.render();
    }
  }

  handleClick(e) {
    // Only handle click if we didn't drag
    const dragDistance = Math.sqrt(
      Math.pow(e.clientX - this.dragStartX, 2) +
      Math.pow(e.clientY - this.dragStartY, 2)
    );

    if (dragDistance < 5) {
      const tile = this.getTileFromMouse(e);
      if (tile && this.onTileClick) {
        this.selectedTile = tile;
        this.onTileClick(tile);
        this.render();
      }
    }
  }

  // Touch handlers
  handleTouchStart(e) {
    e.preventDefault();

    if (e.touches.length === 1) {
      // Single touch - start drag
      this.isDragging = true;
      this.dragStartX = e.touches[0].clientX;
      this.dragStartY = e.touches[0].clientY;
      this.dragStartPanX = this.panX;
      this.dragStartPanY = this.panY;
    } else if (e.touches.length === 2) {
      // Two touches - start pinch zoom
      this.isDragging = false;
      this.lastTouchDistance = this.getTouchDistance(e.touches);
      this.lastTouchCenter = this.getTouchCenter(e.touches);
    }
  }

  handleTouchMove(e) {
    e.preventDefault();

    if (e.touches.length === 1 && this.isDragging) {
      // Single touch drag
      const dx = e.touches[0].clientX - this.dragStartX;
      const dy = e.touches[0].clientY - this.dragStartY;
      this.panX = this.dragStartPanX + dx;
      this.panY = this.dragStartPanY + dy;
      this.render();
    } else if (e.touches.length === 2) {
      // Pinch zoom
      const distance = this.getTouchDistance(e.touches);
      const center = this.getTouchCenter(e.touches);

      if (this.lastTouchDistance > 0) {
        const zoomFactor = distance / this.lastTouchDistance;
        const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * zoomFactor));

        if (newScale !== this.scale) {
          const rect = this.canvas.getBoundingClientRect();
          const centerX = center.x - rect.left;
          const centerY = center.y - rect.top;

          const scaleChange = newScale / this.scale;
          this.panX = centerX - (centerX - this.panX) * scaleChange;
          this.panY = centerY - (centerY - this.panY) * scaleChange;
          this.scale = newScale;
        }
      }

      // Also pan with two fingers
      if (this.lastTouchCenter) {
        this.panX += center.x - this.lastTouchCenter.x;
        this.panY += center.y - this.lastTouchCenter.y;
      }

      this.lastTouchDistance = distance;
      this.lastTouchCenter = center;
      this.render();
    }
  }

  handleTouchEnd(e) {
    if (e.touches.length === 0) {
      // Check if it was a tap (not a drag)
      if (this.isDragging) {
        const touch = e.changedTouches[0];
        const dragDistance = Math.sqrt(
          Math.pow(touch.clientX - this.dragStartX, 2) +
          Math.pow(touch.clientY - this.dragStartY, 2)
        );

        if (dragDistance < 10) {
          // This was a tap
          const tile = this.getTileFromTouch(touch);
          if (tile && this.onTileClick) {
            this.selectedTile = tile;
            this.onTileClick(tile);
            this.render();
          }
        }
      }
      this.isDragging = false;
      this.lastTouchDistance = 0;
      this.lastTouchCenter = null;
    } else if (e.touches.length === 1) {
      // One finger lifted - switch back to drag mode
      this.isDragging = true;
      this.dragStartX = e.touches[0].clientX;
      this.dragStartY = e.touches[0].clientY;
      this.dragStartPanX = this.panX;
      this.dragStartPanY = this.panY;
      this.lastTouchDistance = 0;
      this.lastTouchCenter = null;
    }
  }

  getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  getTouchCenter(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2
    };
  }

  getTileFromMouse(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - this.panX) / this.tileSize;
    const y = (e.clientY - rect.top - this.panY) / this.tileSize;

    const tileX = Math.floor(x);
    const tileY = Math.floor(y);

    if (tileX >= 0 && tileX < this.gridSize && tileY >= 0 && tileY < this.gridSize) {
      return { x: tileX, y: tileY };
    }
    return null;
  }

  getTileFromTouch(touch) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (touch.clientX - rect.left - this.panX) / this.tileSize;
    const y = (touch.clientY - rect.top - this.panY) / this.tileSize;

    const tileX = Math.floor(x);
    const tileY = Math.floor(y);

    if (tileX >= 0 && tileX < this.gridSize && tileY >= 0 && tileY < this.gridSize) {
      return { x: tileX, y: tileY };
    }
    return null;
  }

  setGameState(state) {
    this.planets = state.planets || [];
    this.mechs = state.mechs || [];
    this.visibleTiles = new Set(state.visibleTiles || []);
    this.render();
  }

  // Zoom controls (can be called from UI buttons)
  zoomIn() {
    const newScale = Math.min(this.maxScale, this.scale * 1.2);
    this.zoomTo(newScale, this.canvas.width / 2, this.canvas.height / 2);
  }

  zoomOut() {
    const newScale = Math.max(this.minScale, this.scale / 1.2);
    this.zoomTo(newScale, this.canvas.width / 2, this.canvas.height / 2);
  }

  zoomTo(newScale, centerX, centerY) {
    const scaleChange = newScale / this.scale;
    this.panX = centerX - (centerX - this.panX) * scaleChange;
    this.panY = centerY - (centerY - this.panY) * scaleChange;
    this.scale = newScale;
    this.render();
  }

  resetView() {
    this.scale = 1;
    this.centerView();
    this.render();
  }

  render() {
    const ctx = this.ctx;
    const tileSize = this.tileSize;

    // Clear canvas
    ctx.fillStyle = this.colors.space;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Calculate visible range for optimization
    const startX = Math.max(0, Math.floor(-this.panX / tileSize));
    const startY = Math.max(0, Math.floor(-this.panY / tileSize));
    const endX = Math.min(this.gridSize, Math.ceil((this.canvas.width - this.panX) / tileSize));
    const endY = Math.min(this.gridSize, Math.ceil((this.canvas.height - this.panY) / tileSize));

    // Draw grid lines (only visible area)
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 0.5;

    for (let x = startX; x <= endX; x++) {
      const px = this.panX + x * tileSize;
      ctx.beginPath();
      ctx.moveTo(px, Math.max(0, this.panY));
      ctx.lineTo(px, Math.min(this.canvas.height, this.panY + this.gridSize * tileSize));
      ctx.stroke();
    }

    for (let y = startY; y <= endY; y++) {
      const py = this.panY + y * tileSize;
      ctx.beginPath();
      ctx.moveTo(Math.max(0, this.panX), py);
      ctx.lineTo(Math.min(this.canvas.width, this.panX + this.gridSize * tileSize), py);
      ctx.stroke();
    }

    // Draw planets
    for (const planet of this.planets) {
      if (planet.x >= startX && planet.x < endX && planet.y >= startY && planet.y < endY) {
        this.drawPlanet(planet);
      }
    }

    // Draw mechs
    for (const mech of this.mechs) {
      if (mech.x >= startX && mech.x < endX && mech.y >= startY && mech.y < endY) {
        this.drawMech(mech);
      }
    }

    // Draw fog of war (only visible area)
    for (let x = startX; x < endX; x++) {
      for (let y = startY; y < endY; y++) {
        const key = `${x},${y}`;
        if (!this.visibleTiles.has(key)) {
          const px = this.panX + x * tileSize;
          const py = this.panY + y * tileSize;
          ctx.fillStyle = this.colors.fog;
          ctx.fillRect(px, py, tileSize, tileSize);
        }
      }
    }

    // Draw selection highlight
    if (this.selectedTile) {
      const px = this.panX + this.selectedTile.x * tileSize;
      const py = this.panY + this.selectedTile.y * tileSize;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
    }

    // Draw hover highlight
    if (this.hoveredTile && (!this.selectedTile ||
        this.hoveredTile.x !== this.selectedTile.x ||
        this.hoveredTile.y !== this.selectedTile.y)) {
      const px = this.panX + this.hoveredTile.x * tileSize;
      const py = this.panY + this.hoveredTile.y * tileSize;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
    }
  }

  drawPlanet(planet) {
    const ctx = this.ctx;
    const tileSize = this.tileSize;
    const px = this.panX + planet.x * tileSize + tileSize / 2;
    const py = this.panY + planet.y * tileSize + tileSize / 2;
    const radius = tileSize * 0.35;

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

    // Draw income indicator (small dots) - only when zoomed in enough
    if (tileSize >= 16) {
      const income = planet.base_income;
      const dotRadius = Math.max(1, tileSize * 0.08);
      const startAngle = -Math.PI / 2;

      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < income; i++) {
        const angle = startAngle + (i / income) * Math.PI * 2;
        const dx = Math.cos(angle) * (radius + dotRadius * 2);
        const dy = Math.sin(angle) * (radius + dotRadius * 2);
        ctx.beginPath();
        ctx.arc(px + dx, py + dy, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawMech(mech) {
    const ctx = this.ctx;
    const tileSize = this.tileSize;
    const px = this.panX + mech.x * tileSize;
    const py = this.panY + mech.y * tileSize;

    // Mech indicator in corner
    const size = tileSize * 0.3;
    const color = this.colors.planetOwned[mech.owner_id % this.colors.planetOwned.length];

    ctx.fillStyle = color;
    ctx.fillRect(px + 2, py + 2, size, size);

    // Show mech count if multiple - only when zoomed in enough
    if (mech.count > 1 && tileSize >= 16) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.floor(tileSize * 0.4)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(mech.count.toString(), px + tileSize / 2, py + tileSize - 3);
    }
  }
}
