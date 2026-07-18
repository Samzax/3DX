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

// ===== Unified continuous world (docs/unified-world-design.md) =====
// All tactical content lives in ONE store (WORLD_KEY) in world coordinates, so
// adjacent provinces are continuous instead of separate islands. Hex tiers are
// zoom lenses over this one ground; a tactical join is routed to WORLD_KEY.
const WORLD_KEY = '@world';                 // reserved; not a valid hex path
const CHUNK_CELLS = 32;                     // must match client terrain CHUNK_VERTS/2
// Hex pitch (flat-to-flat, world cells) per tier: Province 1mi=1056, Kingdom 6mi, Continent 60mi.
const TIER_WIDTH = [63360, 6336, 1056];     // depth 0,1,2 (continent, kingdom, province)
const SQRT3 = Math.sqrt(3);
// Pointy-top axial hex center (world cells) for a hex (q,r) at a given tier depth.
function hexCenterAtTier(depth, q, r) {
  const R = TIER_WIDTH[depth] / SQRT3;      // circumradius from flat-to-flat width
  return { x: R * SQRT3 * (q + r / 2), z: R * 1.5 * r };
}
// World center (cells) of a tactical province path "world/qc,rc/qk,rk/qp,rp".
function provinceWorldCenter(key) {
  const segs = key.split('/');
  let x = 0, z = 0;
  for (let d = 1; d < segs.length && d <= 3; d++) {
    const [q, r] = segs[d].split(',').map(Number);
    const c = hexCenterAtTier(d - 1, q, r);
    x += c.x; z += c.z;
  }
  return { x, z };
}
function isTacticalPath(key) { return /^world(\/-?\d+,-?\d+){3}$/.test(key); }
// Hex-tier layers of the world tree (depth 0-2): zoom lenses over the world.
function isWorldHexPath(key) { return /^world(\/-?\d+,-?\d+){0,2}$/.test(key); }

// One-time migration: fold legacy per-province tactical islands into WORLD_KEY at
// their composed world position (chunk-aligned), so the tactical layer becomes one
// continuous world. Each island's chunk keys are relabeled by its chunk offset and
// its objects shifted by the same amount; the old per-key terrain is then dropped.
function migrateTacticalToWorld() {
  const legacy = Object.keys(maps).filter(k => isTacticalPath(k) && maps[k] && maps[k].terrain &&
    maps[k].terrain.chunks && Object.keys(maps[k].terrain.chunks).length);
  if (!legacy.length) return;
  const world = maps[WORLD_KEY] || (maps[WORLD_KEY] = {
    objects: {}, rulers: {}, meta: { kind: 'world' },
    terrain: { format: 2, chunkCells: CHUNK_CELLS, vertexSpacing: 0.5, water: { bodies: [] }, chunks: {} }
  });
  const wt = world.terrain;
  for (const key of legacy) {
    const center = provinceWorldCenter(key);
    const offX = Math.round(center.x / CHUNK_CELLS), offZ = Math.round(center.z / CHUNK_CELLS);
    const src = maps[key].terrain;
    for (const ck of Object.keys(src.chunks || {})) {
      const [cx, cz] = ck.split(',').map(Number);
      wt.chunks[(cx + offX) + ',' + (cz + offZ)] = src.chunks[ck];
    }
    // Water bodies shift by the world offset (cells).
    const ox = offX * CHUNK_CELLS, oz = offZ * CHUNK_CELLS;
    if (src.water && Array.isArray(src.water.bodies)) {
      for (const b of src.water.bodies) {
        if (b.kind === 'lake' && b.seed) { b.seed.x += ox; b.seed.z += oz; }
        if (b.kind === 'river' && Array.isArray(b.points)) b.points.forEach(p => { p.x += ox; p.z += oz; });
        wt.water.bodies.push(b);
      }
    }
    // Objects move into the world at the offset position.
    for (const oid of Object.keys(maps[key].objects || {})) {
      const o = maps[key].objects[oid];
      if (o.position) { o.position.x += ox; o.position.z += oz; }
      world.objects[oid] = o;
    }
    delete maps[key].terrain;
    maps[key].objects = {};
  }
  saveMaps();
  console.log(`[MIGRATE] Folded ${legacy.length} tactical island(s) into the unified world (${WORLD_KEY}).`);
}
migrateTacticalToWorld();

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

// ===== Combat (turn-based encounters) =====
// Combat state lives at maps[roomKey].combat and persists with the map. The
// server is the single source of truth: it rolls every die and enforces turn
// order, the one-action economy and per-turn movement budgets. Clients render
// and (per the advisory trust model) supply SRD-derived character stats.

function rollDie(sides) { return crypto.randomInt(1, sides + 1); }

// Roll a damage expression like "2d6+3" (or a flat number); crits double the dice.
function rollDamage(expr, crit) {
  const m = /^\s*(\d+)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/.exec(String(expr || ''));
  if (!m) {
    const flat = Math.max(0, Math.floor(Number(expr) || 0));
    return { expr: String(expr || flat), rolls: [flat], total: flat };
  }
  const count = Math.min(40, Number(m[1])) * (crit ? 2 : 1);
  const sides = Math.max(2, Math.min(1000, Number(m[2])));
  const mod = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(rollDie(sides));
  return { expr: String(expr), rolls, total: Math.max(0, rolls.reduce((a, b) => a + b, 0) + mod) };
}

function fmtSigned(n) { return (n < 0 ? '- ' : '+ ') + Math.abs(n); }

// Conditions a combatant can carry. auto:true effects (from Dash/Dodge/
// Disengage) are stripped at the start of that combatant's next turn.
const CONDITION_LABELS = {
  dodging: 'Dodge', disengaged: 'Disengage', dashed: 'Dash', down: 'Down',
  prone: 'Prone', poisoned: 'Poisoned', restrained: 'Restrained', stunned: 'Stunned',
  blinded: 'Blinded', frightened: 'Frightened', grappled: 'Grappled', invisible: 'Invisible'
};

function getCombat(key) { return maps[key] && maps[key].combat; }
function hasEffect(c, key) { return (c.effects || []).some(e => e.key === key); }
function addEffect(c, key, auto) {
  if (!CONDITION_LABELS[key] || hasEffect(c, key)) return;
  c.effects.push({ key, label: CONDITION_LABELS[key], auto: !!auto });
}
function removeEffect(c, key) { c.effects = (c.effects || []).filter(e => e.key !== key); }

// Set a combatant's tracked HP and keep the 'down' condition in sync.
function setCombatantHP(c, v) {
  c.hp = { current: v };
  if (v <= 0) addEffect(c, 'down', false);
  else removeEffect(c, 'down');
}

// Set a character's live HP (clamped), persist, broadcast — shared by the
// update-hp handler and combat damage. Also refreshes the HP mirror on any
// combat tracker that includes this character.
function applyCharacterHP(id, current) {
  const char = charactersDB[id];
  if (!char) return null;
  const v = Math.max(0, Math.floor(Number(current) || 0));
  char.hp = { current: v };
  saveJSON('characters.json', charactersDB);
  io.emit('hp-updated', { id, current: v });
  for (const [key, m] of Object.entries(maps)) {
    if (!m.combat) continue;
    let touched = false;
    for (const c of Object.values(m.combat.combatants)) {
      if (c.charId === id) { setCombatantHP(c, v); touched = true; }
    }
    if (touched) broadcastCombat(key);
  }
  return v;
}

// Append a log entry (capped at 100 for joiners) and stream it to the room.
function pushLog(key, combat, entry) {
  entry.id = crypto.randomUUID().slice(0, 8);
  entry.ts = Date.now();
  entry.round = combat.round;
  combat.log.push(entry);
  if (combat.log.length > 100) combat.log.splice(0, combat.log.length - 100);
  io.to(key).emit('combat-log', entry);
  return entry;
}

function broadcastCombat(key) {
  saveMaps();
  io.to(key).emit('combat-updated', (maps[key] && maps[key].combat) || null);
}

// Build a combatant from a map object. Characters join with statsPending until
// an owning client sends SRD-derived stats; plain tokens get editable defaults.
function seedCombatant(obj) {
  const base = {
    id: obj.id, initiative: null,
    movementUsedFeet: 0, dashFeet: 0, actionUsed: false, effects: []
  };
  if (obj.type === 'character' && obj.characterData) {
    const cd = obj.characterData;
    const live = cd.id && charactersDB[cd.id];
    return {
      ...base, kind: 'character',
      name: String(cd.name || 'Adventurer').slice(0, 40),
      color: cd.color || '#dd4444',
      charId: cd.id || null, owner: cd.owner || null,
      statsPending: true, ac: 10, speedFeet: 30, initMod: 0, maxHP: 10,
      hp: (live && live.hp && typeof live.hp.current === 'number') ? { current: live.hp.current } : null,
      attacks: []
    };
  }
  if (obj.type === 'token') {
    return {
      ...base, kind: 'token', name: 'Token', color: obj.color || 0xdd4444,
      charId: null, owner: null, statsPending: false,
      ac: 12, speedFeet: 30, initMod: 0, maxHP: 10, hp: { current: 10 },
      attacks: [{ name: 'Strike', attack: 2, damage: '1d6', damageType: 'bludgeoning', ranged: false, rangeFt: 5 }]
    };
  }
  return null;
}

// Sort the turn order: initiative desc, tiebreak initMod desc, then name.
// Un-rolled combatants (mid-combat additions) sink to the end.
function sortOrder(combat) {
  const cs = combat.combatants;
  combat.order = Object.keys(cs).sort((a, b) =>
    ((cs[b].initiative ?? -Infinity) - (cs[a].initiative ?? -Infinity)) ||
    (cs[b].initMod - cs[a].initMod) ||
    String(cs[a].name).localeCompare(String(cs[b].name)));
}

function startTurn(key, combat, id) {
  combat.activeId = id || null;
  const c = id && combat.combatants[id];
  if (!c) return;
  c.movementUsedFeet = 0;
  c.dashFeet = 0;
  c.actionUsed = false;
  c.effects = (c.effects || []).filter(e => !e.auto);
  pushLog(key, combat, { kind: 'turn', actorName: c.name, text: `Round ${combat.round} — ${c.name}'s turn` });
}

function advanceTurn(key, combat) {
  if (!combat.order.length) { combat.activeId = null; return; }
  const idx = combat.order.indexOf(combat.activeId);
  const next = (idx + 1) % combat.order.length;
  if (idx >= 0 && next === 0) combat.round++;
  startTurn(key, combat, combat.order[next]);
}

// Begin the fight: auto-roll any missing initiative, sort, round 1, first turn.
function beginCombat(key, combat) {
  for (const c of Object.values(combat.combatants)) {
    if (c.initiative == null) {
      const die = rollDie(20);
      c.initiative = die + c.initMod;
      pushLog(key, combat, {
        kind: 'initiative', actorName: c.name,
        text: `${c.name} rolls initiative: d20 ${die} ${fmtSigned(c.initMod)} = ${c.initiative}`,
        roll: { d20: [die], used: die, mod: c.initMod, total: c.initiative }
      });
    }
  }
  sortOrder(combat);
  combat.started = true;
  combat.round = 1;
  startTurn(key, combat, combat.order[0]);
}

// Drop a combatant from the fight (token deleted or GM removal). If it was
// their turn, the turn passes first so activeId stays valid.
function removeCombatant(key, combat, id) {
  if (!combat.combatants[id]) return;
  if (combat.activeId === id) {
    if (combat.order.length > 1) advanceTurn(key, combat);
    else combat.activeId = null;
  }
  delete combat.combatants[id];
  combat.order = combat.order.filter(x => x !== id);
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
    applyCharacterHP(id, payload.current);
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

  // Ensure the unified world store has a terrain scaffold.
  function ensureWorld() {
    const w = getMap(WORLD_KEY);
    if (!w.terrain) w.terrain = { format: 2, chunkCells: CHUNK_CELLS, vertexSpacing: 0.5, water: { bodies: [] }, chunks: {} };
    if (!w.meta) w.meta = { kind: 'world' };
    return w;
  }

  // All biome hex tags across the world tree, keyed by hex-layer map key.
  // Clients feed this to the terrain generator (painted biomes override
  // generation), so every client needs the whole (tiny) tree, not just the
  // tags of the map it is looking at.
  function collectHexTree() {
    const tree = {};
    for (const key of Object.keys(maps)) {
      if (!isWorldHexPath(key)) continue;
      const hexes = maps[key].hexes;
      if (hexes && Object.keys(hexes).length) tree[key] = hexes;
    }
    return tree;
  }

  // Send a room's state. For the unified world the emitted `key` is the province
  // path the client asked for (so its own map-state guard accepts it) while the
  // payload carries the shared world terrain/objects + where to fly (worldCenter).
  // Hex-tier layers are zoom lenses over the same world: they keep their own
  // room (objects/rulers/tags) but also carry the world terrain + center.
  function sendMapState(roomKey, contextKey) {
    const m = getMap(roomKey);
    const ctx = contextKey || roomKey;
    const extra = {};
    if (roomKey === WORLD_KEY || isWorldHexPath(roomKey)) {
      extra.worldCenter = provinceWorldCenter(ctx);
      extra.unified = true;
      extra.hexTree = collectHexTree();
      if (roomKey !== WORLD_KEY) extra.terrain = ensureWorld().terrain;
      else ensureWorld();
    }
    socket.emit('map-state', {
      key: ctx,
      objects: Object.values(m.objects),
      rulers: Object.values(m.rulers),
      terrain: m.terrain || null,
      meta: m.meta || null,
      hexes: m.hexes || {},
      biome: resolveBiome(ctx),
      combat: m.combat || null,
      ...extra
    });
  }

  // Auto-join the world map on connect (also keeps older clients working)
  socket.currentMapKey = DEFAULT_MAP_KEY;
  socket.join(DEFAULT_MAP_KEY);
  sendMapState(DEFAULT_MAP_KEY);

  // Switch this socket to a different map. Tactical paths are routed to the one
  // continuous world (WORLD_KEY) so provinces share terrain; hex tiers and
  // pockets keep their own rooms.
  socket.on('join-map', (payload) => {
    const reqKey = (payload && payload.key) ? String(payload.key) : DEFAULT_MAP_KEY;
    const roomKey = isTacticalPath(reqKey) ? WORLD_KEY : reqKey;
    if (socket.currentMapKey && socket.currentMapKey !== roomKey) {
      socket.leave(socket.currentMapKey);
    }
    socket.currentMapKey = roomKey;
    socket.join(roomKey);
    getMap(roomKey);
    if (roomKey === WORLD_KEY) ensureWorld();
    console.log(`[MAP] ${socket.username || socket.id} -> ${reqKey}${roomKey !== reqKey ? ' [' + roomKey + ']' : ''}`);
    sendMapState(roomKey, reqKey);
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
    if (!isWorldHexPath(key)) return; // tags live on hex-tier layers only
    const map = getMap(key);
    map.hexes = map.hexes || {};
    const hk = q + ',' + r;
    if (biome === null) delete map.hexes[hk];
    else map.hexes[hk] = { biome };
    saveMaps();
    // Global broadcast (not just the layer's room): painted biomes override
    // terrain generation, so every client rendering the world needs the change.
    io.emit('hex-updated', { key, hex: hk, biome });
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
    if (!map.objects[data.id]) return;
    // In a started combat, combatant tokens move only on their turn, only by
    // their owner (GM excepted), and only within the turn's movement budget.
    const combat = map.combat;
    const c = combat && combat.started && combat.combatants[data.id];
    if (c) {
      const old = { ...map.objects[data.id].position };
      const gm = isGM(socket.username);
      const isTheirTurn = combat.activeId === data.id && c.owner === socket.username;
      if (!gm && (!isTheirTurn || hasEffect(c, 'down'))) {
        socket.emit('object-moved', { id: data.id, position: old });
        socket.emit('combat-denied', { reason: hasEffect(c, 'down') ? `${c.name} is down` : "Not this token's turn" });
        return;
      }
      if (combat.activeId === data.id && data.position) {
        // XZ euclidean, matching the ruler: 1 world unit = 1 cell = 5 ft.
        const feet = Math.hypot((Number(data.position.x) || 0) - old.x, (Number(data.position.z) || 0) - old.z) * 5;
        const remaining = c.speedFeet + c.dashFeet - c.movementUsedFeet;
        if (!gm && feet > remaining + 0.5) {
          socket.emit('object-moved', { id: data.id, position: old });
          socket.emit('combat-denied', { reason: `Too far: ${Math.round(feet)} ft (${Math.max(0, Math.round(remaining))} ft left)` });
          return;
        }
        c.movementUsedFeet += feet;
      }
    }
    map.objects[data.id].position = data.position;
    saveMaps();
    socket.to(key).emit('object-moved', data);
    if (c) broadcastCombat(key);
  });

  socket.on('delete-object', (data) => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    if (map.objects[data.id]) {
      delete map.objects[data.id];
      saveMaps();
      io.to(key).emit('object-deleted', data);
      // A deleted token leaves the fight too.
      if (map.combat && map.combat.combatants[data.id]) {
        const name = map.combat.combatants[data.id].name;
        removeCombatant(key, map.combat, data.id);
        pushLog(key, map.combat, { kind: 'info', actorName: name, text: `${name} was removed from the map` });
        broadcastCombat(key);
      }
    }
  });

  // --- Combat handlers. All act on the current room's combat; failed checks
  // answer only the offending socket with combat-denied (never 'error': the
  // player client routes that to the login modal). ---
  function combatDeny(reason) { socket.emit('combat-denied', { reason }); }
  function canControl(c) { return isGM(socket.username) || (!!c.owner && c.owner === socket.username); }
  const clampInt = (v, min, max, dflt) => {
    v = Number(v);
    return isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : dflt;
  };

  socket.on('combat-start', () => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    if (map.combat) return combatDeny('Combat already running');
    const combat = map.combat = {
      active: true, started: false, round: 0, activeId: null,
      order: [], combatants: {}, log: []
    };
    for (const obj of Object.values(map.objects)) {
      const c = seedCombatant(obj);
      if (c) combat.combatants[c.id] = c;
    }
    pushLog(key, combat, { kind: 'info', actorName: 'GM', text: 'Combat! Roll initiative.' });
    broadcastCombat(key);
  });

  socket.on('combat-end', () => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    if (!getCombat(key)) return;
    delete maps[key].combat;
    broadcastCombat(key); // emits null → clients tear down
  });

  // Owning client (or GM) answers a character's statsPending with SRD-derived
  // numbers. Strictly first write wins — later edits go through
  // combat-update-combatant. (Accepting repeats would echo forever: every
  // broadcast triggers the clients' auto-fill pass again.)
  socket.on('combat-set-stats', (payload) => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    const c = combat && payload && combat.combatants[payload.combatantId];
    if (!c || !canControl(c)) return;
    if (!c.statsPending) return;
    c.ac = clampInt(payload.ac, 1, 30, c.ac);
    c.speedFeet = clampInt(payload.speedFeet, 0, 120, c.speedFeet);
    c.initMod = clampInt(payload.initMod, -10, 20, c.initMod);
    c.maxHP = clampInt(payload.maxHP, 1, 999, c.maxHP);
    if (Array.isArray(payload.attacks)) {
      c.attacks = payload.attacks.slice(0, 8).map(a => ({
        name: String((a && a.name) || 'Attack').slice(0, 30),
        attack: clampInt(a && a.attack, -10, 30, 0),
        damage: String((a && a.damage) || '1').slice(0, 20),
        damageType: String((a && a.damageType) || '').slice(0, 20),
        ranged: !!(a && a.ranged),
        rangeFt: clampInt(a && a.rangeFt, 5, 600, 5)
      }));
    }
    if (!c.hp) c.hp = { current: c.maxHP };
    c.statsPending = false;
    broadcastCombat(key);
  });

  socket.on('combat-roll-initiative', (payload) => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    const c = combat && payload && combat.combatants[payload.combatantId];
    if (!c) return;
    if (!canControl(c)) return combatDeny('Not your combatant');
    if (c.initiative != null && !isGM(socket.username)) return combatDeny('Initiative already rolled');
    const die = rollDie(20);
    c.initiative = die + c.initMod;
    pushLog(key, combat, {
      kind: 'initiative', actorName: c.name,
      text: `${c.name} rolls initiative: d20 ${die} ${fmtSigned(c.initMod)} = ${c.initiative}`,
      roll: { d20: [die], used: die, mod: c.initMod, total: c.initiative }
    });
    if (!combat.started) {
      if (Object.values(combat.combatants).every(x => x.initiative != null)) beginCombat(key, combat);
    } else {
      sortOrder(combat); // mid-combat addition slots into the order
    }
    broadcastCombat(key);
  });

  socket.on('combat-begin', () => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    if (!combat || combat.started) return;
    if (!Object.keys(combat.combatants).length) return combatDeny('No combatants');
    beginCombat(key, combat);
    broadcastCombat(key);
  });

  socket.on('combat-action', (payload) => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    if (!combat || !combat.started || !payload) return;
    const c = combat.combatants[payload.combatantId];
    if (!c) return;
    if (!canControl(c)) return combatDeny('Not your combatant');
    if (combat.activeId !== c.id) return combatDeny("Not this combatant's turn");
    if (c.actionUsed) return combatDeny('Action already used this turn');
    if (hasEffect(c, 'down')) return combatDeny(`${c.name} is down`);
    const kind = String(payload.kind || '');
    if (kind === 'dash') {
      c.dashFeet += c.speedFeet;
      addEffect(c, 'dashed', true);
      pushLog(key, combat, { kind: 'action', actorName: c.name, text: `${c.name} dashes (+${c.speedFeet} ft movement)` });
    } else if (kind === 'dodge') {
      addEffect(c, 'dodging', true);
      pushLog(key, combat, { kind: 'action', actorName: c.name, text: `${c.name} takes the Dodge action (attacks against them at disadvantage)` });
    } else if (kind === 'disengage') {
      addEffect(c, 'disengaged', true);
      pushLog(key, combat, { kind: 'action', actorName: c.name, text: `${c.name} disengages` });
    } else if (kind === 'attack') {
      const target = combat.combatants[payload.targetId];
      if (!target) return combatDeny('No such target');
      if (target.id === c.id) return combatDeny("Can't target yourself");
      const atk = c.attacks[clampInt(payload.attackIndex, 0, 99, -1)];
      if (!atk) return combatDeny('No such attack');
      const disadvantage = hasEffect(target, 'dodging');
      const d20 = [rollDie(20)];
      if (disadvantage) d20.push(rollDie(20));
      const used = disadvantage ? Math.min(d20[0], d20[1]) : d20[0];
      const crit = used === 20;
      const total = used + atk.attack;
      const hit = used !== 1 && (crit || total >= target.ac);
      const dieTxt = disadvantage ? `[${d20.join(', ')}] → ${used}` : `${used}`;
      let text = `${c.name} attacks ${target.name} (${atk.name}): d20 ${dieTxt} ${fmtSigned(atk.attack)} = ${total} vs AC ${target.ac} — ${crit ? 'CRIT!' : hit ? 'HIT' : 'MISS'}`;
      const entry = {
        kind: 'attack', actorName: c.name, targetName: target.name,
        roll: { d20, used, mod: atk.attack, total, vs: target.ac, hit, crit, disadvantage }
      };
      if (hit) {
        const dmg = rollDamage(atk.damage, crit);
        entry.dmg = dmg;
        text += ` · ${dmg.expr}${crit ? ' (crit ×2 dice)' : ''} → ${dmg.total}${atk.damageType ? ' ' + atk.damageType : ''}`;
        const cur = (target.hp && typeof target.hp.current === 'number') ? target.hp.current : target.maxHP;
        const next = Math.max(0, cur - dmg.total);
        if (target.kind === 'character' && target.charId && charactersDB[target.charId]) {
          applyCharacterHP(target.charId, next); // mirrors into target.hp too
        } else {
          setCombatantHP(target, next);
        }
        if (next === 0) text += ` — ${target.name} drops to 0 HP!`;
      }
      entry.text = text;
      pushLog(key, combat, entry);
    } else {
      return;
    }
    c.actionUsed = true;
    broadcastCombat(key);
  });

  socket.on('combat-end-turn', () => {
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    if (!combat || !combat.started) return;
    const active = combat.activeId && combat.combatants[combat.activeId];
    if (!isGM(socket.username) && !(active && active.owner === socket.username)) return combatDeny('Not your turn');
    advanceTurn(key, combat);
    broadcastCombat(key);
  });

  socket.on('combat-set-turn', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    const c = combat && combat.started && payload && combat.combatants[payload.combatantId];
    if (!c) return;
    startTurn(key, combat, c.id);
    broadcastCombat(key);
  });

  socket.on('combat-update-combatant', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    const c = combat && payload && combat.combatants[payload.combatantId];
    if (!c) return;
    const patch = payload.patch || {};
    if (patch.name != null) c.name = String(patch.name).slice(0, 40) || c.name;
    if (patch.ac != null) c.ac = clampInt(patch.ac, 1, 30, c.ac);
    if (patch.speedFeet != null) c.speedFeet = clampInt(patch.speedFeet, 0, 120, c.speedFeet);
    if (patch.initMod != null) c.initMod = clampInt(patch.initMod, -10, 20, c.initMod);
    if (patch.maxHP != null) c.maxHP = clampInt(patch.maxHP, 1, 999, c.maxHP);
    if (patch.initiative != null) {
      c.initiative = clampInt(patch.initiative, -20, 60, c.initiative);
      if (combat.started) sortOrder(combat); // activeId is id-based, stays valid
    }
    if (patch.hpCurrent != null) {
      const v = clampInt(patch.hpCurrent, 0, 999, 0);
      if (c.kind === 'character' && c.charId && charactersDB[c.charId]) applyCharacterHP(c.charId, v);
      else setCombatantHP(c, v);
    }
    c.statsPending = false;
    broadcastCombat(key);
  });

  socket.on('combat-set-order', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    if (!combat || !payload || !Array.isArray(payload.order)) return;
    const cur = [...combat.order].sort().join(' ');
    const req = payload.order.map(String).sort().join(' ');
    if (cur !== req) return; // must be a permutation of the current order
    combat.order = payload.order.map(String);
    broadcastCombat(key);
  });

  socket.on('combat-remove-combatant', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    const c = combat && payload && combat.combatants[payload.combatantId];
    if (!c) return;
    removeCombatant(key, combat, c.id);
    pushLog(key, combat, { kind: 'info', actorName: c.name, text: `${c.name} leaves the fight` });
    broadcastCombat(key);
  });

  socket.on('combat-add-combatant', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    const map = getMap(key);
    const obj = combat && payload && map.objects[payload.objectId];
    if (!obj || combat.combatants[obj.id]) return;
    const c = seedCombatant(obj);
    if (!c) return combatDeny('Only tokens and characters can fight');
    combat.combatants[c.id] = c;
    if (combat.started) combat.order.push(c.id); // end of round until initiative is rolled
    pushLog(key, combat, { kind: 'info', actorName: c.name, text: `${c.name} joins the fight` });
    broadcastCombat(key);
  });

  socket.on('combat-effect', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const combat = getCombat(key);
    const c = combat && payload && combat.combatants[payload.combatantId];
    const effKey = payload && String(payload.key || '');
    if (!c || !CONDITION_LABELS[effKey]) return;
    if (payload.add) addEffect(c, effKey, false);
    else removeEffect(c, effKey);
    broadcastCombat(key);
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
    // Guard: never let a "reset" wipe the entire shared world (the button was
    // written for per-province islands). Region-scoped reset is a later brick.
    if (data.clear && key !== WORLD_KEY) t.chunks = {};
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
