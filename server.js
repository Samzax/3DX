const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// CORS configuration for socket.io
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 512 * 1024
});

const PORT = process.env.PORT || 3000;
// Runtime save state lives in data/saves/ (gitignored); data/srd/ is read-only reference data.
const DATA_DIR = path.join(__dirname, 'data', 'saves');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)){
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error("Error creating data folder:", e); }
}

// One-time migration: saves used to live directly in data/
for (const f of ['characters.json', 'map_state.json', 'homebrew.json']) {
  const oldPath = path.join(__dirname, 'data', f);
  const newPath = path.join(DATA_DIR, f);
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    try { fs.renameSync(oldPath, newPath); } catch (e) { console.error(`Error migrating ${f}:`, e); }
  }
}

// File helper functions
function loadJSON(filename, defaultValue) {
  const filePath = path.join(DATA_DIR, filename);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return raw.trim() ? JSON.parse(raw) : defaultValue;
    } catch (e) { 
      console.error(`Error loading ${filename}:`, e);
      return defaultValue; 
    }
  }
  return defaultValue;
}

function saveJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try { 
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); 
  } catch (e) { 
    console.error(`Error saving ${filename}:`, e); 
  }
}

// Load state (per-map: { maps: { [key]: { objects, rulers } } })
let mapData = loadJSON('map_state.json', { maps: {} });
if (!mapData || !mapData.maps) mapData = { maps: {} };
const maps = mapData.maps;

// Get (or lazily create) a single map's state by its path key (e.g. "world", "world/2,-1")
function getMap(key) {
  if (!maps[key]) maps[key] = { objects: {}, rulers: {} };
  return maps[key];
}

function saveMaps() {
  saveJSON('map_state.json', { maps });
}

let charactersDB = loadJSON('characters.json', {});

// Custom homebrew content (shared): { races: {index:..}, classes: {index:..} }
let homebrewDB = loadJSON('homebrew.json', { races: {}, classes: {} });
if (!homebrewDB.races) homebrewDB.races = {};
if (!homebrewDB.classes) homebrewDB.classes = {};

// Serve the client (HTML shells, CSS, JS modules) and the read-only SRD data.
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use('/data/srd', express.static(path.join(__dirname, 'data', 'srd')));

// Routes
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'creator.html')));
app.get('/gm', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'gm.html')));
app.get('/player', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'player.html')));
app.get('/homebrew', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'homebrew.html')));

// Helper: Check if user is GM. NOTE: login is unauthenticated (the client supplies its
// own username), so isGM and owner checks are advisory conveniences, not a security boundary.
function isGM(username) {
  return username && username.toLowerCase() === 'gm';
}

// Helper: Check if user can access character
function canAccessCharacter(username, character) {
  if (!username || !character) return false;
  return isGM(username) || character.owner === username;
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`[+] Client connected: ${socket.id}`);

  // Login event
  socket.on('login', (username) => {
    if (!username || username.trim() === '') {
      socket.emit('error', 'Invalid username');
      return;
    }

    socket.username = username.trim();
    console.log(`[LOGIN] ${socket.username} (${socket.id})`);

    // Send login success with role
    socket.emit('login-success', {
      username: socket.username,
      isGM: isGM(socket.username)
    });

    // Send accessible characters
    const accessibleChars = Object.values(charactersDB).filter(char => 
      canAccessCharacter(socket.username, char)
    );
    socket.emit('load-user-characters', accessibleChars);

    // Send all homebrew (custom races/classes are shared content)
    socket.emit('load-homebrew', {
      races: Object.values(homebrewDB.races),
      classes: Object.values(homebrewDB.classes)
    });
  });

  // Get characters (filtered by permission)
  socket.on('get-characters', () => {
    if (!socket.username) {
      socket.emit('error', 'Not logged in');
      return;
    }

    const accessibleChars = Object.values(charactersDB).filter(char => 
      canAccessCharacter(socket.username, char)
    );
    socket.emit('load-user-characters', accessibleChars);
  });

  // Save character
  socket.on('save-character', (payload) => {
    if (!socket.username) {
      socket.emit('error', 'Not logged in');
      return;
    }

    const charData = payload.charData || payload;
    const requestedOwner = payload.username || socket.username;

    // If character exists, verify permission to edit
    if (charData.id && charactersDB[charData.id]) {
      const existing = charactersDB[charData.id];
      if (!canAccessCharacter(socket.username, existing)) {
        socket.emit('error', 'Permission denied');
        return;
      }
      // Preserve original owner unless GM is changing it
      charData.owner = isGM(socket.username) ? requestedOwner : existing.owner;
      // Preserve live HP across creator edits (the creator doesn't send it).
      if (charData.hp == null && existing.hp != null) charData.hp = existing.hp;
    } else {
      // New character - set owner
      charData.owner = requestedOwner;
      if (!charData.id) {
        charData.id = crypto.randomUUID();
      }
    }

    console.log(`[SAVE] ${charData.name} by ${socket.username} (owner: ${charData.owner})`);
    
    charactersDB[charData.id] = charData;
    saveJSON('characters.json', charactersDB);
    
    socket.emit('character-saved-success', charData);

    // Send updated character list
    const accessibleChars = Object.values(charactersDB).filter(char => 
      canAccessCharacter(socket.username, char)
    );
    socket.emit('load-user-characters', accessibleChars);

    // Notify all clients about character update (for GM/player screens)
    io.emit('character-updated', charData);
  });

  // Delete character
  socket.on('delete-character', (payload) => {
    if (!socket.username) {
      socket.emit('error', 'Not logged in');
      return;
    }

    const charId = (typeof payload === 'string') ? payload : payload.charId;
    const char = charactersDB[charId];

    if (!char) {
      socket.emit('error', 'Character not found');
      return;
    }

    // Check permission
    if (!canAccessCharacter(socket.username, char)) {
      socket.emit('error', 'Permission denied');
      return;
    }

    console.log(`[DELETE] ${char.name} by ${socket.username}`);
    delete charactersDB[charId];
    saveJSON('characters.json', charactersDB);

    // Send updated list
    const accessibleChars = Object.values(charactersDB).filter(c => 
      canAccessCharacter(socket.username, c)
    );
    socket.emit('load-user-characters', accessibleChars);

    // Notify all clients
    io.emit('character-deleted', charId);
  });

  // Update a character's current HP (live, persisted, broadcast to everyone).
  socket.on('update-hp', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const id = payload && payload.id;
    const char = id && charactersDB[id];
    if (!char) { socket.emit('error', 'Character not found'); return; }
    if (!canAccessCharacter(socket.username, char)) { socket.emit('error', 'Permission denied'); return; }
    const current = Math.max(0, Math.floor(Number(payload.current) || 0));
    char.hp = { current };
    saveJSON('characters.json', charactersDB);
    io.emit('hp-updated', { id, current });
  });

  // --- Homebrew (custom races/classes) — shared content ---
  function broadcastHomebrew() {
    io.emit('load-homebrew', {
      races: Object.values(homebrewDB.races),
      classes: Object.values(homebrewDB.classes)
    });
  }

  socket.on('get-homebrew', () => {
    socket.emit('load-homebrew', {
      races: Object.values(homebrewDB.races),
      classes: Object.values(homebrewDB.classes)
    });
  });

  socket.on('save-homebrew', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const type = payload && payload.type;
    const data = payload && payload.data;
    if ((type !== 'race' && type !== 'class') || !data || typeof data.name !== 'string' || !data.name.trim()) {
      socket.emit('error', 'Invalid homebrew');
      return;
    }
    data.name = data.name.trim().slice(0, 60);
    if (JSON.stringify(data).length > 20000) { socket.emit('error', 'Homebrew too large'); return; }
    const store = type === 'race' ? homebrewDB.races : homebrewDB.classes;
    const isNew = !(data.index && store[data.index]);
    if (isNew && Object.values(store).filter(e => e.owner === socket.username).length >= 100) {
      socket.emit('error', 'Homebrew limit reached (100 per user)');
      return;
    }
    if (data.index && store[data.index]) {
      if (!isGM(socket.username) && store[data.index].owner !== socket.username) {
        socket.emit('error', 'Permission denied');
        return;
      }
      data.owner = store[data.index].owner;
    } else {
      data.index = 'hb-' + type + '-' + crypto.randomUUID().slice(0, 8);
      data.owner = socket.username;
    }
    data.custom = true;
    store[data.index] = data;
    saveJSON('homebrew.json', homebrewDB);
    console.log(`[HOMEBREW] ${type} "${data.name}" by ${socket.username}`);
    socket.emit('homebrew-saved-success', { type, data });
    broadcastHomebrew();
  });

  socket.on('delete-homebrew', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const type = payload && payload.type;
    const index = payload && payload.index;
    const store = type === 'race' ? homebrewDB.races : (type === 'class' ? homebrewDB.classes : null);
    if (!store || !store[index]) { socket.emit('error', 'Homebrew not found'); return; }
    if (!isGM(socket.username) && store[index].owner !== socket.username) {
      socket.emit('error', 'Permission denied');
      return;
    }
    delete store[index];
    saveJSON('homebrew.json', homebrewDB);
    broadcastHomebrew();
  });

  // --- Map synchronization (per-map, scoped by Socket.IO rooms) ---
  const DEFAULT_MAP_KEY = 'world';

  function sendMapState(key) {
    const m = getMap(key);
    socket.emit('map-state', {
      key,
      objects: Object.values(m.objects),
      rulers: Object.values(m.rulers),
      terrain: m.terrain || null
    });
  }

  // Auto-join the world map on connect (also keeps older clients working)
  socket.currentMapKey = DEFAULT_MAP_KEY;
  socket.join(DEFAULT_MAP_KEY);
  sendMapState(DEFAULT_MAP_KEY);

  // Switch this socket to a different map (drill-down navigation)
  socket.on('join-map', (payload) => {
    const key = (payload && payload.key) ? String(payload.key) : DEFAULT_MAP_KEY;
    if (socket.currentMapKey && socket.currentMapKey !== key) {
      socket.leave(socket.currentMapKey);
    }
    socket.currentMapKey = key;
    socket.join(key);
    getMap(key);
    console.log(`[MAP] ${socket.username || socket.id} -> ${key}`);
    sendMapState(key);
  });

  socket.on('add-object', (data) => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    const id = data.id || crypto.randomUUID();
    const newObject = { ...data, id: id };
    map.objects[id] = newObject;
    saveMaps();
    io.to(key).emit('object-added', newObject);
  });

  socket.on('move-object', (data) => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    if (map.objects[data.id]) {
      map.objects[data.id].position = data.position;
      saveMaps();
      socket.to(key).emit('object-moved', data);
    }
  });

  socket.on('delete-object', (data) => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    if (map.objects[data.id]) {
      delete map.objects[data.id];
      saveMaps();
      io.to(key).emit('object-deleted', data);
    }
  });

  socket.on('add-ruler', (data) => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    const id = crypto.randomUUID();
    const newRuler = { ...data, id: id };
    map.rulers[id] = newRuler;
    saveMaps();
    io.to(key).emit('ruler-added', newRuler);
  });

  socket.on('clear-rulers', () => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    map.rulers = {};
    saveMaps();
    io.to(key).emit('rulers-cleared');
  });

  // Terrain edits (GM-authored). Partial blobs ({heights?, splat?, water?}) are
  // merged into the map's stored terrain and relayed to everyone else in the room.
  // heights/splat are opaque base64 strings here — only the clients en/decode them.
  socket.on('update-terrain', (data) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    const t = map.terrain || (map.terrain = { res: 128, size: 100, water: { enabled: false, level: 0 } });
    if (typeof data.heights === 'string') t.heights = data.heights;
    if (typeof data.splat === 'string') t.splat = data.splat;
    if (data.water && typeof data.water === 'object') {
      t.water = {
        enabled: !!data.water.enabled,
        level: Math.max(-50, Math.min(50, Number(data.water.level) || 0))
      };
    }
    saveMaps();
    socket.to(key).emit('terrain-updated', data);
  });

  socket.on('disconnect', () => {
    console.log(`[-] Client disconnected: ${socket.id} (${socket.username || 'unknown'})`);
  });
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log(`========================================`);
  console.log(`VTT Server Running`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Network: http://${localIP}:${PORT}`);
  console.log(`========================================`);
  console.log(`Character Creator: /`);
  console.log(`GM Screen: /gm`);
  console.log(`Player Screen: /player`);
  console.log(`========================================`);
});
