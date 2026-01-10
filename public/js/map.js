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
    this.players = []; // Player info including empire colors
    this.visibleTiles = new Set();
    this.selectedTile = null;
    this.hoveredTile = null;
    this.playerId = null; // Set by game.js to identify player's mechs
    this.movementOrders = []; // Movement orders to draw arrows for
    this.waypoints = []; // Long-distance waypoints to draw
    this.dragSourceTile = null; // Source tile during drag for turn calculation

    // Event handlers
    this.onTileClick = null;
    this.onTileHover = null;
    this.onMechDragStart = null; // Called when starting to drag mechs on map
    this.onMechDragEnd = null;   // Called when ending mech drag

    // Load images
    this.images = {};
    this.imagesLoaded = false;
    this.loadImages();

    this.setupCanvas();
    this.setupEvents();
  }

  loadImages() {
    const cacheVersion = Date.now(); // Use timestamp to always bust cache
    const imagePaths = {
      planet1: `/assets/Planet-1.png?${cacheVersion}`,
      planet2: `/assets/Planet-2.png?${cacheVersion}`,
      planet3: `/assets/Planet-3.png?${cacheVersion}`,
      planet5: `/assets/Planet-5.png?${cacheVersion}`, // Homeworld
      ship: `/assets/Ship.png?${cacheVersion}`
    };

    let loadedCount = 0;
    const totalImages = Object.keys(imagePaths).length;

    for (const [key, path] of Object.entries(imagePaths)) {
      const img = new Image();
      img.onload = () => {
        loadedCount++;
        if (loadedCount === totalImages) {
          this.imagesLoaded = true;
          this.render();
        }
      };
      img.onerror = () => {
        console.warn(`Failed to load image: ${path}`);
        loadedCount++;
        if (loadedCount === totalImages) {
          this.imagesLoaded = true;
          this.render();
        }
      };
      img.src = path;
      this.images[key] = img;
    }
  }

  setupCanvas() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    // Use the canvas's own computed dimensions (after CSS flex layout)
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;

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

  centerOnTile(x, y) {
    // Center the canvas view on a specific tile
    const tileSize = this.tileSize;
    const tileCenterX = (x + 0.5) * tileSize;
    const tileCenterY = (y + 0.5) * tileSize;
    const canvasCenterX = this.canvas.width / 2;
    const canvasCenterY = this.canvas.height / 2;
    this.panX = canvasCenterX - tileCenterX;
    this.panY = canvasCenterY - tileCenterY;
    this.render();
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
    if (e.button === 0) { // Left click only for mech drag check
      const tile = this.getTileFromMouse(e);

      // Check if clicking on player's mechs
      if (tile && this.playerId !== null) {
        const playerMechs = this.mechs.filter(m =>
          m.x === tile.x && m.y === tile.y && m.owner_id === this.playerId
        );

        if (playerMechs.length > 0) {
          // Start mech drag instead of pan
          this.isDraggingMechOnMap = true;
          this.mechDragStartTile = tile;
          this.mechDragMechs = playerMechs;
          this.dragStartX = e.clientX;
          this.dragStartY = e.clientY;

          // Notify game.js
          if (this.onMechDragStart) {
            this.onMechDragStart(tile, playerMechs);
          }

          this.canvas.style.cursor = 'grabbing';
          return; // Don't start pan drag
        }
      }
    }

    // Default: pan drag
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
    // Handle mech drag end
    if (this.isDraggingMechOnMap) {
      const tile = this.getTileFromMouse(e);
      const dragDistance = Math.sqrt(
        Math.pow(e.clientX - this.dragStartX, 2) +
        Math.pow(e.clientY - this.dragStartY, 2)
      );

      // Only complete drag if moved significantly
      if (tile && dragDistance >= 5 && this.onMechDragEnd) {
        this.onMechDragEnd(this.mechDragStartTile, tile, this.mechDragMechs);
      }

      this.isDraggingMechOnMap = false;
      this.mechDragStartTile = null;
      this.mechDragMechs = null;
      this.setDragState(false);
      this.canvas.style.cursor = 'default';
      return;
    }

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
    // Handle mech drag movement - update hovered tile for highlighting
    if (this.isDraggingMechOnMap) {
      const tile = this.getTileFromMouse(e);
      if (tile) {
        this.hoveredTile = tile;
        this.render();
      }
      return;
    }

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

    // Cancel mech drag if leaving canvas
    if (this.isDraggingMechOnMap) {
      this.isDraggingMechOnMap = false;
      this.mechDragStartTile = null;
      this.mechDragMechs = null;
      this.setDragState(false);
    }

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
    this.players = state.players || [];
    this.visibleTiles = new Set(state.visibleTiles || []);
    this.render();
  }

  // Get player color by owner_id, using empire color if available
  getOwnerColor(ownerId) {
    const player = this.players.find(p => p.id === ownerId);
    if (player && player.empire_color) {
      return player.empire_color;
    }
    // Fallback to default colors
    return this.colors.planetOwned[ownerId % this.colors.planetOwned.length];
  }

  // Set movement orders to display arrows
  setMovementOrders(orders, waypoints = []) {
    this.movementOrders = orders || [];
    this.waypoints = waypoints || [];
    this.render();
  }

  // Draw arrows for pending movement orders
  drawMovementArrows() {
    const ctx = this.ctx;
    const tileSize = this.tileSize;

    // Draw waypoint arrows first (underneath regular move arrows)
    if (this.waypoints && this.waypoints.length > 0) {
      for (const waypoint of this.waypoints) {
        // Find the mech to get its owner color
        const mech = this.mechs.find(m => m.id === waypoint.mechId);
        if (!mech) continue;

        const color = this.getOwnerColor(mech.owner_id);

        // Calculate center positions - from mech's current position to waypoint target
        const fromX = this.panX + mech.x * tileSize + tileSize / 2;
        const fromY = this.panY + mech.y * tileSize + tileSize / 2;
        const toX = this.panX + waypoint.targetX * tileSize + tileSize / 2;
        const toY = this.panY + waypoint.targetY * tileSize + tileSize / 2;

        // Draw dashed line for waypoint path
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, tileSize * 0.08);
        ctx.lineCap = 'round';
        ctx.setLineDash([tileSize * 0.2, tileSize * 0.1]);

        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();

        ctx.setLineDash([]); // Reset dash

        // Draw arrowhead at destination
        const angle = Math.atan2(toY - fromY, toX - fromX);
        const arrowSize = Math.max(8, tileSize * 0.3);

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(
          toX - arrowSize * Math.cos(angle - Math.PI / 6),
          toY - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          toX - arrowSize * Math.cos(angle + Math.PI / 6),
          toY - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();

        // Draw target marker (circle at destination)
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(toX, toY, tileSize * 0.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Draw regular movement order arrows (solid, on top)
    // Skip mechs that have waypoints - they already show the destination arrow
    const mechsWithWaypoints = new Set((this.waypoints || []).map(w => w.mechId));

    if (this.movementOrders && this.movementOrders.length > 0) {
      for (const order of this.movementOrders) {
        // Skip if this mech has a waypoint - only show the waypoint arrow
        if (mechsWithWaypoints.has(order.mechId)) continue;

        // Find the mech to get its owner color
        const mech = this.mechs.find(m => m.id === order.mechId);
        if (!mech) continue;

        const color = this.getOwnerColor(mech.owner_id);

        // Calculate center positions
        const fromX = this.panX + order.fromX * tileSize + tileSize / 2;
        const fromY = this.panY + order.fromY * tileSize + tileSize / 2;
        const toX = this.panX + order.toX * tileSize + tileSize / 2;
        const toY = this.panY + order.toY * tileSize + tileSize / 2;

        // Draw arrow line
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, tileSize * 0.1);
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();

        // Draw arrowhead
        const angle = Math.atan2(toY - fromY, toX - fromX);
        const arrowSize = Math.max(8, tileSize * 0.3);

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(
          toX - arrowSize * Math.cos(angle - Math.PI / 6),
          toY - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          toX - arrowSize * Math.cos(angle + Math.PI / 6),
          toY - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
      }
    }
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

    // Draw move highlights during mech drag
    this.drawMoveHighlights();

    // Draw movement order arrows
    this.drawMovementArrows();

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
    const px = this.panX + planet.x * tileSize;
    const py = this.panY + planet.y * tileSize;

    // Select image based on planet type
    let img;
    if (planet.is_homeworld) {
      img = this.images.planet5;
    } else {
      const income = planet.base_income || 1;
      if (income >= 3) {
        img = this.images.planet3;
      } else if (income === 2) {
        img = this.images.planet2;
      } else {
        img = this.images.planet1;
      }
    }

    // Draw the planet image
    if (img && img.complete && img.naturalWidth > 0) {
      const imgSize = tileSize * 0.85;
      const offset = (tileSize - imgSize) / 2;
      ctx.drawImage(img, px + offset, py + offset, imgSize, imgSize);

      // Draw owner color indicator (small colored dot in corner, like ships)
      if (planet.owner_id !== null) {
        const dotRadius = Math.max(3, tileSize * 0.12);
        const dotX = px + tileSize * 0.8;
        const dotY = py + tileSize * 0.2;

        ctx.fillStyle = this.getOwnerColor(planet.owner_id);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    } else {
      // Fallback to old circle rendering if image not loaded
      const centerX = px + tileSize / 2;
      const centerY = py + tileSize / 2;
      const radius = tileSize * 0.35;

      if (planet.owner_id !== null) {
        ctx.fillStyle = this.getOwnerColor(planet.owner_id);
      } else {
        ctx.fillStyle = this.colors.planet;
      }

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fill();

      if (planet.is_homeworld && tileSize >= 12) {
        ctx.strokeStyle = this.colors.homeworld;
        ctx.lineWidth = Math.max(1, tileSize * 0.06);
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius + tileSize * 0.08, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  drawMech(mech) {
    const ctx = this.ctx;
    const tileSize = this.tileSize;
    const px = this.panX + mech.x * tileSize;
    const py = this.panY + mech.y * tileSize;

    const color = this.getOwnerColor(mech.owner_id);
    const img = this.images.ship;

    // Draw ship image with color tinting
    if (img && img.complete && img.naturalWidth > 0) {
      const imgSize = tileSize * 0.7;
      const offset = (tileSize - imgSize) / 2;

      // Draw the ship image
      ctx.drawImage(img, px + offset, py + offset, imgSize, imgSize);

      // Draw owner color indicator (small colored dot in corner)
      const dotRadius = Math.max(3, tileSize * 0.12);
      const dotX = px + tileSize * 0.8;
      const dotY = py + tileSize * 0.2;

      ctx.fillStyle = color;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      // Fallback to old robot rendering
      this.drawMechIcon(ctx, px + tileSize * 0.5, py + tileSize * 0.5, tileSize * 0.35, color);
    }

    // Show mech count if multiple - only when zoomed in enough
    if (mech.count > 1 && tileSize >= 16) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.font = `bold ${Math.floor(tileSize * 0.35)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Draw count badge
      const badgeX = px + tileSize * 0.8;
      const badgeY = py + tileSize * 0.2;
      const badgeRadius = tileSize * 0.18;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(mech.count.toString(), badgeX, badgeY);
    }
  }

  drawMechIcon(ctx, centerX, centerY, size, color) {
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(1, size * 0.08);

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

  // Drag and drop state
  setDragState(isDragging, dragMechs = null, validMoves = null, sourceTile = null) {
    this.isDraggingMech = isDragging;
    this.dragMechs = dragMechs;
    this.validMoves = validMoves ? new Set(validMoves.map(m => `${m.x},${m.y}`)) : null;
    this.dragSourceTile = sourceTile;
    this.render();
  }

  // Draw move highlights and preview arrow during drag
  drawMoveHighlights() {
    if (!this.isDraggingMech || !this.dragSourceTile) return;

    const ctx = this.ctx;
    const tileSize = this.tileSize;

    // Only draw if we have a hovered tile that's different from source
    if (!this.hoveredTile ||
        (this.hoveredTile.x === this.dragSourceTile.x && this.hoveredTile.y === this.dragSourceTile.y)) {
      return;
    }

    const destX = this.hoveredTile.x;
    const destY = this.hoveredTile.y;

    // Check if destination is in bounds
    if (destX < 0 || destX >= this.gridSize || destY < 0 || destY >= this.gridSize) {
      return;
    }

    // Calculate turns to destination (Chebyshev distance)
    const turns = Math.max(
      Math.abs(destX - this.dragSourceTile.x),
      Math.abs(destY - this.dragSourceTile.y)
    );

    // Get mech color (use first dragged mech's owner color)
    let color = '#4a9eff';
    if (this.dragMechs && this.dragMechs.length > 0) {
      color = this.getOwnerColor(this.dragMechs[0].owner_id);
    }

    // Calculate center positions
    const fromX = this.panX + this.dragSourceTile.x * tileSize + tileSize / 2;
    const fromY = this.panY + this.dragSourceTile.y * tileSize + tileSize / 2;
    const toX = this.panX + destX * tileSize + tileSize / 2;
    const toY = this.panY + destY * tileSize + tileSize / 2;

    // Draw arrow line (dashed for multi-turn, solid for 1 turn)
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, tileSize * 0.12);
    ctx.lineCap = 'round';

    if (turns > 1) {
      ctx.setLineDash([tileSize * 0.2, tileSize * 0.1]);
    } else {
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    ctx.setLineDash([]); // Reset dash

    // Draw arrowhead at destination
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const arrowSize = Math.max(10, tileSize * 0.35);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - arrowSize * Math.cos(angle - Math.PI / 6),
      toY - arrowSize * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      toX - arrowSize * Math.cos(angle + Math.PI / 6),
      toY - arrowSize * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();

    // Draw turn count label
    const turnText = turns === 1 ? '1 turn' : `${turns} turns`;

    // Position label at midpoint of the line
    const midX = (fromX + toX) / 2;
    const midY = (fromY + toY) / 2;

    // Draw background for text
    const fontSize = Math.max(12, tileSize * 0.5);
    ctx.font = `bold ${fontSize}px sans-serif`;
    const textMetrics = ctx.measureText(turnText);
    const padding = 6;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(
      midX - textMetrics.width / 2 - padding,
      midY - fontSize / 2 - padding,
      textMetrics.width + padding * 2,
      fontSize + padding * 2
    );

    // Draw text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(turnText, midX, midY);

    // Draw destination highlight
    const px = this.panX + destX * tileSize;
    const py = this.panY + destY * tileSize;

    if (turns === 1) {
      // Adjacent - blue highlight
      ctx.fillStyle = 'rgba(74, 158, 255, 0.4)';
      ctx.strokeStyle = 'rgba(74, 158, 255, 0.9)';
    } else {
      // Waypoint - yellow highlight
      ctx.fillStyle = 'rgba(255, 200, 74, 0.4)';
      ctx.strokeStyle = 'rgba(255, 200, 74, 0.9)';
    }

    ctx.fillRect(px, py, tileSize, tileSize);
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
  }

  // Get mechs at a specific tile (for selection)
  getMechsAtTile(x, y) {
    return this.mechs.filter(m => m.x === x && m.y === y);
  }
}
