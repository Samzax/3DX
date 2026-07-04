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
  // Terrain chunk batches (esp. legacy-map migration) can reach a few hundred KB.
  maxHttpBufferSize: 4 * 1024 * 1024
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

// One-time migration: the hex ladder gained a layer (Continent 60mi > Kingdom 6mi
// > Province 1mi > Tactical). Old depth-2 tactical maps (world/q,r/q,r) become
// Province hex layers, so their content moves to the center sub-hex (.../0,0).
// Portal targets and pocket parent links pointing at moved keys are rewritten.
{
  const renames = {};
  for (const key of Object.keys(maps)) {
    const m = maps[key];
    const hasContent = m && (m.terrain || Object.keys(m.objects || {}).length || Object.keys(m.rulers || {}).length);
    if (/^world(\/-?\d+,-?\d+){2}$/.test(key) && hasContent && !maps[key + '/0,0']) {
      renames[key] = key + '/0,0';
    }
  }
  if (Object.keys(renames).length) {
    for (const [oldKey, newKey] of Object.entries(renames)) {
      maps[newKey] = maps[oldKey];
      delete maps[oldKey];
    }
    for (const m of Object.values(maps)) {
      if (m.meta && renames[m.meta.parentKey]) m.meta.parentKey = renames[m.meta.parentKey];
      for (const obj of Object.values(m.objects || {})) {
        if (obj.type === 'portal' && renames[obj.target]) obj.target = renames[obj.target];
      }
    }
    saveMaps();
    console.log(`[MIGRATE] Moved ${Object.keys(renames).length} tactical map(s) down one hex layer:`, Object.values(renames).join(', '));
  }
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

  // A tactical map inherits its biome from the nearest tagged ancestor hex:
  // province tag beats kingdom tag beats continent tag.
  function resolveBiome(key) {
    const segs = key.split('/');
    if (segs[0] !== 'world') return null;
    let biome = null;
    for (let d = 1; d < segs.length; d++) {
      const parent = maps[segs.slice(0, d).join('/')];
      const tag = parent && parent.hexes && parent.hexes[segs[d]];
      if (tag && tag.biome) biome = tag.biome;
    }
    return biome;
  }

  function sendMapState(key) {
    const m = getMap(key);
    socket.emit('map-state', {
      key,
      objects: Object.values(m.objects),
      rulers: Object.values(m.rulers),
      terrain: m.terrain || null,
      meta: m.meta || null,
      hexes: m.hexes || {},
      biome: resolveBiome(key)
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

  // Tag a hex on the current (hex-layer) map with a biome; null clears the tag.
  // Tags color the hex on the GM screen and seed new tactical maps beneath it.
  const BIOME_KEYS = ['plains', 'forest', 'mountains', 'desert', 'swamp', 'coast'];
  socket.on('update-hex', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const q = Math.round(Number(payload && payload.q)), r = Math.round(Number(payload && payload.r));
    if (!isFinite(q) || !isFinite(r) || Math.abs(q) > 64 || Math.abs(r) > 64) return;
    const biome = payload.biome == null ? null : String(payload.biome);
    if (biome !== null && !BIOME_KEYS.includes(biome)) return;
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    map.hexes = map.hexes || {};
    const hk = q + ',' + r;
    if (biome === null) delete map.hexes[hk];
    else map.hexes[hk] = { biome };
    saveMaps();
    io.to(key).emit('hex-updated', { hex: hk, biome });
  });

  // Create a pocket map (dungeon/cave/room): its own map key outside the hex tree,
  // entered through portal objects. Ships with an exit portal back to the parent.
  socket.on('create-pocket-map', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const name = String((payload && payload.name) || 'Pocket').trim().slice(0, 40) || 'Pocket';
    const clampDim = (v) => Math.max(4, Math.min(256, Math.floor(Number(v) || 24)));
    const width = clampDim(payload && payload.width);
    const height = clampDim(payload && payload.height);
    const parentKey = String((payload && payload.parentKey) || DEFAULT_MAP_KEY);
    const key = 'pocket/' + crypto.randomUUID().slice(0, 8);
    const exitId = crypto.randomUUID();
    maps[key] = {
      objects: {
        [exitId]: { id: exitId, type: 'portal', target: parentKey, name: 'Exit', position: { x: 0, y: 0, z: 0 } }
      },
      rulers: {},
      meta: { kind: 'pocket', name, width, height, parentKey }
    };
    saveMaps();
    console.log(`[POCKET] "${name}" (${width}x${height}) -> ${key} by ${socket.username}`);
    socket.emit('pocket-created', { key, name });
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

  // Terrain edits (GM-authored), chunked format v2:
  //   { chunks?: { "cx,cz": { heights?, splat? } | null }, water?, clear? }
  // heights/splat are opaque base64 strings here — only the clients en/decode
  // them. null deletes a chunk; clear wipes all chunks (GM reset). Legacy v1
  // stored terrain ({res:128, heights, splat}) is replaced wholesale the first
  // time a GM client sends v2 chunks (the client migrates and re-uploads).
  const CHUNK_KEY_RE = /^-?\d+,-?\d+$/;
  socket.on('update-terrain', (data) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    if (!data || typeof data !== 'object') return;
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    let t = map.terrain;
    if (!t || t.format !== 2) {
      t = map.terrain = {
        format: 2, chunkCells: 32, vertexSpacing: 0.5,
        water: (t && t.water) ? t.water : { bodies: [] },
        chunks: {}
      };
    }
    if (data.clear) t.chunks = {};
    if (data.chunks && typeof data.chunks === 'object') {
      for (const k of Object.keys(data.chunks)) {
        if (!CHUNK_KEY_RE.test(k)) continue;
        const v = data.chunks[k];
        if (v === null) { delete t.chunks[k]; continue; }
        if (typeof v !== 'object') continue;
        const c = t.chunks[k] || (t.chunks[k] = {});
        if (typeof v.heights === 'string') c.heights = v.heights;
        if (typeof v.splat === 'string') c.splat = v.splat;
      }
    }
    if (data.water && typeof data.water === 'object') {
      if (Array.isArray(data.water.bodies)) {
        // Water v2: authored bodies (lakes/rivers); footprints are computed
        // client-side from the terrain, so this stays small and opaque.
        t.water = { bodies: data.water.bodies.slice(0, 64).filter(b => b && typeof b === 'object') };
      } else {
        // Legacy global sheet (old clients); new clients migrate it on load.
        t.water = {
          enabled: !!data.water.enabled,
          level: Math.max(-50, Math.min(50, Number(data.water.level) || 0))
        };
      }
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
