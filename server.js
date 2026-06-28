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
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)){
  try { fs.mkdirSync(DATA_DIR); } catch (e) { console.error("Error creating data folder:", e); }
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

// Serve static files
app.use(express.static(path.join(__dirname)));

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'character_creator.html')));
app.get('/gm', (req, res) => res.sendFile(path.join(__dirname, '3d_tabletop.html')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'player_Screen.html')));

// Helper: Check if user is GM
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

  // --- Map synchronization (per-map, scoped by Socket.IO rooms) ---
  const DEFAULT_MAP_KEY = 'world';

  function sendMapState(key) {
    const m = getMap(key);
    socket.emit('map-state', {
      key,
      objects: Object.values(m.objects),
      rulers: Object.values(m.rulers)
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
