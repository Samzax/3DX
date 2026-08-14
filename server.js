const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const {
  pointInsidePointyHex,
  segmentIntersectsPointyHex,
  axisAlignedBoxIntersectsPointyHex,
  sampleCentripetalCatmullRom
} = require('./lib/terrain-region.cjs');

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
// Tests/secondary instances can opt into an isolated directory without touching
// the live saves. Relative overrides are resolved from the process cwd.
const DATA_DIR_OVERRIDE = process.env.THREEDX_DATA_DIR;
const DATA_DIR = path.resolve(DATA_DIR_OVERRIDE || path.join(__dirname, 'data', 'saves'));
const MAX_USERNAME_LENGTH = 40;
const MAX_CHARACTERS_PER_OWNER = 100;
const MAX_CHARACTER_BYTES = 64 * 1024;
const MAX_MONSTER_BYTES = 48 * 1024;
const MAX_OBJECT_BYTES = 96 * 1024;
const MAX_MAP_OBJECTS = 5000;
const MAX_PLAYER_CHARACTER_INSTANCES = 100;
const MAX_RULERS = 1000;
const MAX_RULER_POINTS = 512;
const MAX_TERRAIN_CHUNKS_PER_UPDATE = 64;
const MAX_TERRAIN_LAYER_BYTES = 128 * 1024;
const MAX_TERRAIN_UPDATE_BYTES = 2 * 1024 * 1024;
const WORLD_COORD_LIMIT = 100 * 1000 * 1000;
const MAP_KEY_LIMIT = 160;
const BUILD_LEVEL_MIN = -5;
const BUILD_LEVEL_MAX = 8;
const MAX_STRUCTURE_BATCH = 256;
const STRUCTURE_ID_LIMIT = 96;
const OBJECT_TYPES = new Set([
  'token', 'cube', 'sphere', 'character', 'cave', 'arch', 'portal',
  'wall', 'floor', 'stair', 'roof'
]);
const WALL_CELL_LIMIT = 48;
const WALL_SEGMENT_KINDS = new Set(['door', 'window', 'gap', 'solid']);
const STRUCTURE_TILE_LIMIT = 48;
const STRUCTURE_TILE_KINDS = new Set(['gap', 'solid']);
const STRUCTURE_TYPES = new Set(['wall', 'floor', 'stair', 'roof']);
const STRUCTURE_ID_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_STRUCTURE_LEVEL_HEIGHT = 2;
const STRUCTURE_ALIGNMENT_TOLERANCE = 0.001;
const CHARACTER_ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const CHARACTER_REFERENCE_RE = /^[A-Za-z0-9_-]+$/;
const CHARACTER_COLOR_RE = /^#[0-9a-f]{6}$/i;
const CHARACTER_APPEARANCE_DEFAULTS = {
  height: 1, build: 1, headSize: 1, armLength: 1, legLength: 1
};
const CHARACTER_COLOR_DEFAULTS = {
  skin: '#c68642', hair: '#3b2716', torso: '#2f6e56',
  legs: '#3a3f4a', eyes: '#1a1a1a'
};
const CHARACTER_ABILITY_METHODS = new Set(['point-buy', 'standard-array', 'manual']);
const HOMEBREW_CASTER_TYPES = new Set(['none', 'full', 'half']);
const HOMEBREW_SPELL_LISTS = new Set([
  'bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard'
]);
const MONSTER_SIZES = new Set(['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan']);
const MONSTER_ATTACK_TYPES = new Set(['melee', 'ranged']);
const SRD_MONSTER_PATH = path.join(__dirname, 'data', 'srd', 'monsters.json');
const SRD_MONSTER_CATALOG = Object.create(null);
try {
  const records = JSON.parse(fs.readFileSync(SRD_MONSTER_PATH, 'utf8'));
  if (!Array.isArray(records)) throw new Error('expected a JSON array');
  for (const record of records) {
    const index = record && typeof record.index === 'string' && CHARACTER_REFERENCE_RE.test(record.index)
      ? record.index : null;
    if (index) SRD_MONSTER_CATALOG[index] = record;
  }
} catch (error) {
  console.error(`[SRD] Could not load monster catalog: ${error.message}`);
}

// Structure grid cells are one world unit. New walls may store an orthogonal
// relative path; sanitize it here so saved/broadcast records stay bounded even
// when a client bypasses the normal build UI. Legacy bx/bz walls remain valid.
function sanitizeWallPath(raw) {
  if (!Array.isArray(raw)) return null;
  const points = [{ x: 0, z: 0 }];
  let used = 0;
  const appendLeg = (axis, target) => {
    if (used >= WALL_CELL_LIMIT) return;
    const here = points[points.length - 1];
    const delta = target[axis] - here[axis];
    const cells = Math.min(Math.abs(delta), WALL_CELL_LIMIT - used);
    if (!cells) return;
    const next = { ...here, [axis]: here[axis] + Math.sign(delta) * cells };
    points.push(next);
    used += cells;
  };
  for (let i = 0; i < raw.length && i <= WALL_CELL_LIMIT; i++) {
    const point = raw[i];
    if (used >= WALL_CELL_LIMIT) break;
    if (!point) continue;
    const x = Number(point.x), z = Number(point.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const target = { x: Math.round(x), z: Math.round(z) };
    appendLeg('x', target);
    appendLeg('z', target);
  }
  return points;
}

function wallCellCount(data) {
  const path = sanitizeWallPath(data && data.path);
  if (path) {
    let count = 0;
    for (let i = 1; i < path.length; i++) {
      count += Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].z - path[i - 1].z);
    }
    return Math.min(WALL_CELL_LIMIT, count);
  }
  const bx = Number.isFinite(Number(data && data.bx)) ? Number(data.bx) : 0;
  const bz = Number.isFinite(Number(data && data.bz)) ? Number(data.bz) : 0;
  return Math.min(WALL_CELL_LIMIT, Math.max(0, Math.round(Math.abs(bx) + Math.abs(bz))));
}

function structureTileCount(data) {
  const dimension = (value) => Math.max(1, Math.min(STRUCTURE_TILE_LIMIT, Number(value) | 0));
  return dimension(data && data.cols) * dimension(data && data.rows);
}

function sanitizeStructureTiles(data, raw) {
  const count = structureTileCount(data);
  return Array.from({ length: count }, (_, i) =>
    STRUCTURE_TILE_KINDS.has(raw[i]) ? raw[i] : null);
}

function sanitizeStructureIdentity(value) {
  const id = boundedText(value, STRUCTURE_ID_LIMIT);
  return id && STRUCTURE_ID_RE.test(id) ? id : null;
}

function structureStoreyLevel(data) {
  const level = Math.round(boundedNumber(data && data.level, -20, 50, 0));
  if (!data || data.type !== 'roof') return level;
  return Math.round(boundedNumber(data.coversLevel, -20, 50, level - 1));
}

function structureLevel(data) {
  const level = Number(data && data.level);
  return Number.isFinite(level) ? Math.round(level) : 0;
}

function structureLevelHeight(data) {
  const levelHeight = Number(data && data.levelHeight);
  return Number.isFinite(levelHeight) && levelHeight > 0
    ? levelHeight : DEFAULT_STRUCTURE_LEVEL_HEIGHT;
}

function structureStairRiseCompatible(data, expectedLevelHeight) {
  if (!data || data.type !== 'stair') return true;
  // Match the renderer's legacy fallback: an absent rise is a two-unit stair,
  // not an arbitrary stair that silently inherits a different building rise.
  const rise = hasOwn(data, 'rise') ? Number(data.rise) : DEFAULT_STRUCTURE_LEVEL_HEIGHT;
  const expected = Number(expectedLevelHeight);
  const direction = Math.sign(rise);
  const level = structureLevel(data);
  const toLevel = hasOwn(data, 'toLevel') ? Number(data.toLevel) : level + direction;
  return Number.isFinite(rise) && Number.isFinite(expected) &&
    Number.isFinite(toLevel) && direction !== 0 && Math.round(toLevel) === level + direction &&
    Math.abs(rise) > STRUCTURE_ALIGNMENT_TOLERANCE &&
    Math.abs(Math.abs(rise) - expected) <= STRUCTURE_ALIGNMENT_TOLERANCE;
}

function structureRoofLevelCompatible(data) {
  if (!data || data.type !== 'roof') return true;
  const level = structureLevel(data);
  const coversLevel = hasOwn(data, 'coversLevel') ? Number(data.coversLevel) : level - 1;
  return Number.isFinite(coversLevel) && Math.round(coversLevel) === level - 1;
}

function structureHeightModeCompatible(data) {
  if (!data || data.heightMode !== 'terrain') return true;
  return structureLevel(data) === 0 && (data.type === 'wall' || data.type === 'floor');
}

function explicitStructureDatum(data) {
  const raw = data && data.buildingDatumY;
  if (raw == null || raw === '') return null;
  const datum = Number(raw);
  return Number.isFinite(datum) ? datum : null;
}

// Keep the server-side adoption gate aligned with the shared
// structure rules. Legacy terrain-following pieces on level 0 may have an
// anchor displaced from the building datum; all other pieces must already be
// aligned before adopting them can persist a building identity.
function structureDatumCompatible(data, buildingDatumY) {
  if (buildingDatumY == null || buildingDatumY === '') return false;
  const expected = Number(buildingDatumY);
  if (!Number.isFinite(expected)) return false;
  const explicit = explicitStructureDatum(data);
  if (explicit != null && Math.abs(explicit - expected) > STRUCTURE_ALIGNMENT_TOLERANCE) return false;
  if (structureLevel(data) === 0 && data && data.heightMode === 'terrain') return true;
  const positionY = Number(data && data.position && data.position.y);
  const derivedDatum = (Number.isFinite(positionY) ? positionY : 0) -
    structureLevel(data) * structureLevelHeight(data);
  return Math.abs(derivedDatum - expected) <= STRUCTURE_ALIGNMENT_TOLERANCE;
}

function serializedBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch (_) { return Infinity; }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record, key) {
  return !!record && Object.prototype.hasOwnProperty.call(record, key);
}

function ownValue(record, key) {
  return hasOwn(record, key) ? record[key] : null;
}

function boundedText(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function boundedNumber(value, min, max, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function boundedInteger(value, min, max, fallback = null) {
  const number = boundedNumber(value, min, max, fallback);
  return number == null ? fallback : Math.floor(number);
}

// Form controls can legitimately serialize numbers as strings, but null,
// booleans and objects must not silently coerce to 0 or 1 in persisted sheets.
function boundedScalarNumber(value, min, max, fallback = null) {
  if (typeof value !== 'number' &&
      !(typeof value === 'string' && value.trim() !== '')) return fallback;
  return boundedNumber(value, min, max, fallback);
}

function boundedScalarInteger(value, min, max, fallback = null) {
  const number = boundedScalarNumber(value, min, max, fallback);
  return number == null ? fallback : Math.floor(number);
}

function boundedString(value, maxLength) {
  return typeof value === 'string' ? boundedText(value, maxLength) : '';
}

function sanitizeReference(value, maxLength = 96) {
  const reference = boundedString(value, maxLength);
  return reference && CHARACTER_REFERENCE_RE.test(reference) ? reference : null;
}

function sanitizeReferenceArray(raw, maxItems = 64, maxLength = 96) {
  if (!Array.isArray(raw)) return [];
  const values = [];
  const seen = new Set();
  for (const candidate of raw.slice(0, maxItems)) {
    const reference = sanitizeReference(candidate, maxLength);
    if (!reference || seen.has(reference)) continue;
    seen.add(reference);
    values.push(reference);
  }
  return values;
}

function sanitizeColor(value, fallback) {
  return typeof value === 'string' && CHARACTER_COLOR_RE.test(value) ? value : fallback;
}

function sanitizePosition(raw) {
  if (!isRecord(raw)) return null;
  const x = boundedNumber(raw.x, -WORLD_COORD_LIMIT, WORLD_COORD_LIMIT);
  const y = boundedNumber(raw.y, -WORLD_COORD_LIMIT, WORLD_COORD_LIMIT);
  const z = boundedNumber(raw.z, -WORLD_COORD_LIMIT, WORLD_COORD_LIMIT);
  return x == null || y == null || z == null ? null : { x, y, z };
}

function sanitizeXZ(raw) {
  if (!isRecord(raw)) return null;
  const x = boundedNumber(raw.x, -WORLD_COORD_LIMIT, WORLD_COORD_LIMIT);
  const z = boundedNumber(raw.z, -WORLD_COORD_LIMIT, WORLD_COORD_LIMIT);
  return x == null || z == null ? null : { x, z };
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)){
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error("Error creating data folder:", e); }
}

// One-time migration: saves used to live directly in data/. An explicitly
// isolated data directory must never move the live legacy files into itself.
if (!DATA_DIR_OVERRIDE) {
  for (const f of ['characters.json', 'map_state.json', 'homebrew.json']) {
    const oldPath = path.join(__dirname, 'data', f);
    const newPath = path.join(DATA_DIR, f);
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      try { fs.renameSync(oldPath, newPath); } catch (e) { console.error(`Error migrating ${f}:`, e); }
    }
  }
}

// File helper functions
function readJSONFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) throw new Error('file is empty');
  return { data: JSON.parse(raw), raw };
}

function tempPathFor(filePath) {
  return `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

// Write beside the destination and rename into place. The rename is the commit
// point, so a crash cannot leave a partially written JSON document at filePath.
function atomicWriteFile(filePath, contents) {
  const tempPath = tempPathFor(filePath);
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) { /* best-effort cleanup */ }
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { /* best-effort cleanup */ }
    throw e;
  }
}

function loadJSON(filename, defaultValue, validate = () => true) {
  const filePath = path.join(DATA_DIR, filename);
  const backupPath = filePath + '.bak';
  if (fs.existsSync(filePath)) {
    try {
      const primary = readJSONFile(filePath);
      if (!validate(primary.data)) throw new Error('file has an invalid data shape');
      return primary.data;
    } catch (e) {
      console.error(`Error loading ${filename}:`, e);
    }
  }
  if (fs.existsSync(backupPath)) {
    try {
      const recovered = readJSONFile(backupPath);
      if (!validate(recovered.data)) throw new Error('backup has an invalid data shape');
      console.warn(`[RECOVER] Loading ${filename} from ${path.basename(backupPath)}.`);
      try { atomicWriteFile(filePath, recovered.raw); }
      catch (e) { console.error(`Error restoring ${filename} from backup:`, e); }
      return recovered.data;
    } catch (e) {
      console.error(`Error loading backup for ${filename}:`, e);
    }
  }
  return defaultValue;
}

function validMapSaveData(value) {
  if (!isRecord(value) || !isRecord(value.maps)) return false;
  return Object.values(value.maps).every(map =>
    isRecord(map) &&
    (!hasOwn(map, 'objects') || isRecord(map.objects)) &&
    (!hasOwn(map, 'rulers') || isRecord(map.rulers)) &&
    (!hasOwn(map, 'hexes') || isRecord(map.hexes)) &&
    (!hasOwn(map, 'fog') || isRecord(map.fog)) &&
    (!hasOwn(map, 'terrain') || isRecord(map.terrain)) &&
    (!hasOwn(map, 'meta') || isRecord(map.meta)) &&
    (!hasOwn(map, 'combat') || isRecord(map.combat))
  );
}

function validHomebrewSaveData(value) {
  return isRecord(value) &&
    (!hasOwn(value, 'races') || isRecord(value.races)) &&
    (!hasOwn(value, 'classes') || isRecord(value.classes)) &&
    (!hasOwn(value, 'monsters') || isRecord(value.monsters));
}

function validatorForSave(filename) {
  if (filename === 'map_state.json') return validMapSaveData;
  if (filename === 'characters.json') return isRecord;
  if (filename === 'homebrew.json') return validHomebrewSaveData;
  return () => true;
}

function saveJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  const backupPath = filePath + '.bak';
  try {
    const contents = JSON.stringify(data, null, 2) + '\n';
    // Rotate only a parseable primary. A corrupt/partial primary must never
    // replace the last known-good backup during recovery.
    if (fs.existsSync(filePath)) {
      try {
        const current = readJSONFile(filePath);
        if (!validatorForSave(filename)(current.data)) {
          throw new Error('file has an invalid data shape');
        }
        atomicWriteFile(backupPath, current.raw);
      } catch (e) {
        console.warn(`[SAVE] Not rotating invalid ${filename} into its backup: ${e.message}`);
      }
    }
    atomicWriteFile(filePath, contents);
    return true;
  } catch (e) {
    console.error(`Error saving ${filename}:`, e);
    return false;
  }
}

// Compensation runs after a related file failed to commit. The current
// primary may contain the rejected half of that transaction, so rotating it
// would poison the last-known-good backup. Rewrite only the primary and leave
// the existing backup untouched for crash/corruption recovery.
function rewriteJSONPrimary(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (!validatorForSave(filename)(data)) throw new Error('data has an invalid shape');
    atomicWriteFile(filePath, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch (e) {
    console.error(`Error restoring ${filename}:`, e);
    return false;
  }
}

// Cross-file HP/combat commits need recovery copies from the same logical
// generation. A normal save keeps the previous primary as `.bak`, which is
// useful for one-file edits but would let one corrupt primary roll only half
// of an HP transaction back. Refresh both backups after both primaries commit.
function rewriteJSONBackup(filename, data) {
  const backupPath = path.join(DATA_DIR, filename) + '.bak';
  try {
    if (!validatorForSave(filename)(data)) throw new Error('data has an invalid shape');
    atomicWriteFile(backupPath, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch (e) {
    console.error(`Error refreshing backup for ${filename}:`, e);
    return false;
  }
}

// Load state (per-map: { maps: { [key]: { objects, rulers } } })
let mapData = loadJSON('map_state.json', { maps: {} }, validMapSaveData);
const maps = mapData.maps;
for (const map of Object.values(maps)) {
  if (!map.objects) map.objects = {};
  if (!map.rulers) map.rulers = {};
}

// Get (or lazily create) a single map's state by its path key (e.g. "world", "world/2,-1")
function getMap(key) {
  if (!maps[key]) maps[key] = { objects: {}, rulers: {} };
  return maps[key];
}

// Joining a world lens is navigation, not authorization to grow the persisted
// map database. Unknown lenses can be rendered from this empty read view; a GM
// materializes one only when authoring it.
function mapForRead(key) {
  return ownValue(maps, key) || { objects: {}, rulers: {} };
}

function saveMaps() {
  return saveJSON('map_state.json', { maps });
}

// Map mutators update the in-memory record first because persistence is
// synchronous. Keep small, field-level snapshots so a failed atomic write can
// restore memory before the handler reports the failure or emits canonical
// state to any client.
function snapshotField(record, field) {
  return {
    existed: hasOwn(record, field),
    value: hasOwn(record, field) ? structuredClone(record[field]) : undefined
  };
}

function restoreField(record, field, snapshot) {
  if (snapshot.existed) record[field] = snapshot.value;
  else delete record[field];
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

// Regional terrain reset is keyed by the tactical province the GM actually
// joined, never by client-supplied coordinates. Keep this boundary test
// bit-identical to shared/hexworld.js hexEdgeDistance(2, ..., 0, 0).
function pointInsideProvince(key, x, z) {
  if (!isTacticalPath(key) || !Number.isFinite(x) || !Number.isFinite(z)) return false;
  const center = provinceWorldCenter(key);
  return pointInsidePointyHex({ x: x - center.x, z: z - center.z }, TIER_WIDTH[2]);
}

function waterBodyTouchesProvince(body, key) {
  if (!isRecord(body) || !isTacticalPath(key)) return false;
  const center = provinceWorldCenter(key);
  const localPoint = point => isRecord(point)
    ? { x: Number(point.x) - center.x, z: Number(point.z) - center.z }
    : null;
  if (body.kind === 'lake') {
    if (!isRecord(body.seed) || !Number.isFinite(Number(body.seed.x)) ||
        !Number.isFinite(Number(body.seed.z))) return false;
    // Lake flood containment is Chebyshev distance over one-unit cells, not a
    // circle. This is the exact outer AABB those cells may occupy (terrain.js
    // stops before a cell whose index distance reaches maxRadius).
    const radiusCells = Math.max(1, Math.ceil(Number(body.maxRadius) || 96));
    const reach = radiusCells - 1;
    const seedCellX = Math.floor(Number(body.seed.x));
    const seedCellZ = Math.floor(Number(body.seed.z));
    return axisAlignedBoxIntersectsPointyHex({
      minX: seedCellX - reach - center.x,
      maxX: seedCellX + reach + 1 - center.x,
      minZ: seedCellZ - reach - center.z,
      maxZ: seedCellZ + reach + 1 - center.z
    }, TIER_WIDTH[2]);
  }
  if (body.kind !== 'river' || !Array.isArray(body.points)) return false;
  const authoredWidth = Number(body.width);
  const halfWidth = (Number.isFinite(authoredWidth) && authoredWidth > 0
    ? authoredWidth : 2.5) / 2;
  const curve = sampleCentripetalCatmullRom(body.points);
  for (let i = 1; i < curve.length; i++) {
    if (segmentIntersectsPointyHex(
      localPoint(curve[i - 1]),
      localPoint(curve[i]),
      TIER_WIDTH[2],
      halfWidth
    )) return true;
  }
  return false;
}
// Hex-tier layers of the world tree (depth 0-2): zoom lenses over the world.
function isWorldHexPath(key) { return /^world(\/-?\d+,-?\d+){0,2}$/.test(key); }
// Rooms that render the one continuous world (tactical store + hex lenses).
function isUnifiedKey(key) { return key === WORLD_KEY || isWorldHexPath(key); }

function validWorldNavigationKey(key) {
  if (key === WORLD_KEY) return true;
  const segments = key.split('/');
  if (segments[0] !== 'world' || segments.length > 4) return false;
  return segments.slice(1).every(segment => {
    if (!/^-?\d+,-?\d+$/.test(segment)) return false;
    const [q, r] = segment.split(',').map(Number);
    return Number.isSafeInteger(q) && Number.isSafeInteger(r) && Math.abs(q) <= 20000 && Math.abs(r) <= 20000;
  });
}

// New world lens keys are valid on demand. Pocket/legacy keys must already
// exist, preventing join-map requests from manufacturing unbounded save stores.
function knownMapKey(raw, fallback = null) {
  const key = boundedText(raw, MAP_KEY_LIMIT);
  if (!key) return fallback;
  if (validWorldNavigationKey(key)) return key;
  return Object.prototype.hasOwnProperty.call(maps, key) ? key : fallback;
}

// ===== Fog of war (U4, docs/unified-world-design.md) =====
// Players free-roam the camera but only RECEIVE content inside regions the GM
// has revealed. The mask is a set of hexes on a GLOBAL province-pitch lattice
// centered on the world origin (deliberately not the nested navigation
// lattice, which re-ids the same ground under different parents). It persists
// at maps[WORLD_KEY].fog as { "q,r": 1 }. Math mirrors shared/fog.js —
// keep bit-identical: the server decides what each player is sent.
const FOG_TIER = 2;
function fogHexKeyAt(x, z) {
  const R = TIER_WIDTH[FOG_TIER] / SQRT3;
  const qf = (SQRT3 / 3 * x - 1 / 3 * z) / R;
  const rf = (2 / 3 * z) / R;
  let rq = Math.round(qf), ry = Math.round(-qf - rf), rr = Math.round(rf);
  const dq = Math.abs(rq - qf), dy = Math.abs(ry - (-qf - rf)), dr = Math.abs(rr - rf);
  if (dq > dy && dq > dr) rq = -ry - rr;
  else if (dy <= dr) rr = -rq - ry;
  return rq + ',' + rr;
}
// Fog hex containing a terrain chunk ("cx,cz"), classified by chunk center.
function chunkFogHexKey(chunkKey) {
  const [cx, cz] = chunkKey.split(',').map(Number);
  return fogHexKeyAt((cx + 0.5) * CHUNK_CELLS, (cz + 0.5) * CHUNK_CELLS);
}
function worldFog() {
  const w = getMap(WORLD_KEY);
  if (!w.fog) w.fog = {};
  return w.fog;
}
function isRevealedAt(x, z) {
  return !!worldFog()[fogHexKeyAt(Number(x) || 0, Number(z) || 0)];
}
// A player always sees their own characters — losing your own token to fog
// would strand the HUD/combat panel, and "where am I" is never a GM secret.
function ownsObject(username, obj) {
  return !!(username && obj && obj.type === 'character' &&
    obj.characterData && obj.characterData.owner === username);
}
function objectVisibleTo(username, obj) {
  if (isGM(username)) return true;
  if (ownsObject(username, obj)) return true;
  const p = obj.position || {};
  return isRevealedAt(p.x, p.z);
}

// Character tokens need enough sheet-derived appearance data to render for
// everyone, but their complete saved sheets belong only to their owner and the
// GM. Keep this projection centralized so map-state and every live reveal use
// the same boundary.
function publicCharacterProjection(raw) {
  const source = isRecord(raw) ? raw : {};
  const topLevelColor = sanitizeColor(source.color, CHARACTER_COLOR_DEFAULTS.torso);
  const appearance = sanitizeCharacterAppearance(source.appearance, topLevelColor);
  const equipment = isRecord(source.equipment) ? source.equipment : {};
  return {
    name: boundedString(source.name, 80) || 'Adventurer',
    owner: boundedString(source.owner, MAX_USERNAME_LENGTH),
    race: sanitizeReference(source.race, 80) || 'human',
    appearance,
    equipment: {
      armor: sanitizeReference(equipment.armor, 96),
      shield: equipment.shield === true,
      weapons: sanitizeReferenceArray(equipment.weapons, 1, 96)
    },
    color: appearance.colors.torso
  };
}

// Creature rules are GM material. Players only need the public identity and
// footprint needed to render a token; encounter state separately exposes the
// table-facing HP/AC information appropriate to combat.
function publicMonsterProjection(raw) {
  const source = isRecord(raw) ? raw : {};
  return {
    name: boundedString(source.name, 80) || 'Creature',
    size: MONSTER_SIZES.has(source.size) ? source.size : 'Medium',
    type: boundedString(source.type, 40) || 'creature',
    color: sanitizeColor(source.color, '#b45309'),
    custom: source.custom === true,
    source: source.source === 'srd-5.1' ? 'srd-5.1' : 'homebrew',
    public: true
  };
}

function projectObjectFor(username, object) {
  if (!object || isGM(username)) return object;
  if (object.type === 'character' && isRecord(object.characterData)) {
    if (object.characterData.owner === username) return object;
    return { ...object, characterData: publicCharacterProjection(object.characterData) };
  }
  if (object.type === 'token' && isRecord(object.monsterData)) {
    return { ...object, monsterData: publicMonsterProjection(object.monsterData) };
  }
  return object;
}
// Terrain as a player may see it: only chunks inside revealed fog hexes.
// (The base procedural ground regenerates client-side either way — what fog
// actually protects is GM-authored edits: carved entrances, sculpted lairs.)
function filterTerrainForPlayer(t) {
  if (!t || !t.chunks) return t;
  const chunks = {};
  for (const k of Object.keys(t.chunks)) {
    if (worldFog()[chunkFogHexKey(k)]) chunks[k] = t.chunks[k];
  }
  return { ...t, chunks };
}
// Per-socket emit to a room (fog filtering needs to know WHO receives).
function emitToRoom(key, exceptSocket, fn) {
  const room = io.sockets.adapter.rooms.get(key);
  if (!room) return;
  for (const sid of room) {
    if (exceptSocket && sid === exceptSocket.id) continue;
    const sock = io.sockets.sockets.get(sid);
    if (sock) fn(sock);
  }
}

// The unified world is ONE logical map: every zoom lens (world, world/q,r,
// world/q,r/q,r) and the tactical store share WORLD_KEY's objects + combat.
// Pockets keep their own store.
function stateKey(key) { return isUnifiedKey(key) ? WORLD_KEY : key; }

// Emit to every socket currently viewing the unified world (any lens), not just
// one room. Per-socket so fog filtering can decide what each player receives.
function emitToUnified(exceptSocket, fn) {
  for (const sock of io.sockets.sockets.values()) {
    if (exceptSocket && sock.id === exceptSocket.id) continue;
    if (!sock.username) continue;
    if (!isUnifiedKey(sock.currentMapKey || '')) continue;
    fn(sock);
  }
}

// Presence roster: every logged-in socket and where it is. Broadcast to the
// whole server (usernames aren't secret); the GM View tool uses it to list
// live players it can steer. Fired on login, join-map and disconnect.
function broadcastPresence() {
  const players = [];
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.username) continue;
    players.push({
      username: sock.username,
      mapKey: sock.currentMapKey || 'world',
      isGM: isGM(sock.username)
    });
  }
  io.emit('players-updated', { players });
}

// Character-instance index (player right-menu "Instances" tab): every placed
// character token across every map — where it sits and who spawned it. Players
// get only their own characters (own tokens are never fog-hidden, so this
// leaks nothing new); the GM gets everything.
function characterInstancesFor(username) {
  const instances = [];
  for (const key of Object.keys(maps)) {
    for (const obj of Object.values(maps[key].objects || {})) {
      if (obj.type !== 'character' || !obj.characterData) continue;
      if (!isGM(username) && obj.characterData.owner !== username) continue;
      const meta = maps[key].meta || {};
      instances.push({
        id: obj.id,
        mapKey: key,
        mapName: meta.kind === 'pocket' ? (meta.name || 'Pocket') : 'World',
        charId: obj.characterData.id || null,
        charName: obj.characterData.name || 'Unnamed',
        color: obj.characterData.color || null,
        owner: obj.characterData.owner || null,
        addedBy: obj.addedBy || null,
        position: obj.position || { x: 0, y: 0, z: 0 }
      });
    }
  }
  return instances;
}
// Live refresh: whenever a character token is added/moved/deleted anywhere,
// every logged-in socket gets its (personalized) instance list again.
function pushCharacterInstances() {
  for (const sock of io.sockets.sockets.values()) {
    if (sock.username) sock.emit('character-instances', { instances: characterInstancesFor(sock.username) });
  }
}

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

// One-time migration: hex-lens rooms (world, world/q,r, world/q,r/q,r) used to
// keep their own objects; the unified world now holds ALL objects on WORLD_KEY.
// Fold any stragglers in verbatim (already at true world coords — no offset),
// then clear the lens store. Idempotent.
function migrateUnifiedLensObjects() {
  const world = getMap(WORLD_KEY);
  let moved = 0;
  let changed = false;
  for (const key of Object.keys(maps)) {
    if (key === WORLD_KEY || !isUnifiedKey(key)) continue;
    const m = maps[key];
    const objectIds = Object.keys(m.objects || {});
    for (const oid of objectIds) {
      if (!world.objects[oid]) { world.objects[oid] = m.objects[oid]; moved++; }
    }
    if (objectIds.length) changed = true;
    m.objects = {};
    if (m.combat && !world.combat) {
      world.combat = m.combat; // a stray lens combat joins the world
      changed = true;
    }
    if (m.combat) {
      delete m.combat;
      changed = true;
    }
  }
  if (changed) {
    saveMaps();
    console.log(`[MIGRATE] Folded ${moved} lens object(s) and legacy combat state into ${WORLD_KEY}.`);
  }
}
migrateUnifiedLensObjects();

const loadedCharactersDB = loadJSON('characters.json', {}, isRecord);
let charactersDB = {};
for (const [storedId, rawCharacter] of Object.entries(loadedCharactersDB)) {
  const character = sanitizeCharacterPayload(rawCharacter);
  const id = sanitizeReference(rawCharacter && rawCharacter.id, 80) ||
    sanitizeReference(storedId, 80);
  if (!character || !id) continue;
  character.id = id;
  character.owner = boundedString(rawCharacter.owner, MAX_USERNAME_LENGTH) || 'gm';
  charactersDB[id] = character;
}

// Custom races/classes are table-shared. Monster definitions are scoped below
// so players do not receive every GM-authored stat block over the socket.
const loadedHomebrewDB = loadJSON(
  'homebrew.json', { races: {}, classes: {}, monsters: {} }, validHomebrewSaveData
);
let homebrewDB = { races: {}, classes: {}, monsters: {} };
for (const type of ['race', 'class', 'monster']) {
  const collection = type === 'race' ? 'races' : (type === 'class' ? 'classes' : 'monsters');
  const source = loadedHomebrewDB[collection];
  const destination = homebrewDB[collection];
  for (const [storedIndex, rawHomebrew] of Object.entries(source || {})) {
    const data = sanitizeHomebrewPayload(type, rawHomebrew);
    const index = sanitizeReference(rawHomebrew && rawHomebrew.index, 96) ||
      sanitizeReference(storedIndex, 96);
    if (!data || !index) continue;
    data.index = index;
    data.owner = boundedString(rawHomebrew.owner, MAX_USERNAME_LENGTH) || 'gm';
    data.custom = true;
    if (type === 'monster') data.source = 'homebrew';
    destination[index] = data;
  }
}

// Serve the client (HTML shells, CSS, JS modules) and the read-only SRD data.
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use('/data/srd', express.static(path.join(__dirname, 'data', 'srd')));

// Routes. root+relative (not one absolute path) so sendFile's dotfile check
// doesn't reject the whole app when the repo lives under a dot-directory
// (e.g. a git worktree inside a hidden folder).
app.get('/', (req, res) => res.sendFile('creator.html', { root: PUBLIC_DIR }));
app.get('/gm', (req, res) => res.sendFile('gm.html', { root: PUBLIC_DIR }));
app.get('/player', (req, res) => res.sendFile('player.html', { root: PUBLIC_DIR }));
app.get('/homebrew', (req, res) => res.sendFile('homebrew.html', { root: PUBLIC_DIR }));

// Helper: Check if user is GM. Mutations below enforce this role and ownership,
// but login itself is unauthenticated (the client supplies its username), so
// deployment still assumes a trusted table rather than hostile internet users.
function isGM(username) {
  return username && username.toLowerCase() === 'gm';
}

function homebrewPayloadFor(username) {
  const monsters = Object.values(homebrewDB.monsters);
  return {
    races: Object.values(homebrewDB.races),
    classes: Object.values(homebrewDB.classes),
    monsters: isGM(username) ? monsters : monsters.filter(monster => monster.owner === username)
  };
}

// Helper: Check if user can access character
function canAccessCharacter(username, character) {
  if (!username || !character) return false;
  return isGM(username) || character.owner === username;
}

// Character lists are role-scoped in one place so every request path gives the
// GM the complete roster while players only receive their own characters.
function charactersAccessibleTo(username) {
  const characters = Object.values(charactersDB);
  return isGM(username) ? characters : characters.filter(char =>
    canAccessCharacter(username, char)
  );
}

function sanitizeAbilityRecord(raw, fallback = 8) {
  const source = isRecord(raw) ? raw : {};
  const abilities = {};
  for (const ability of CHARACTER_ABILITIES) {
    abilities[ability] = boundedScalarInteger(source[ability], 1, 30, fallback);
  }
  return abilities;
}

function sanitizeCharacterClasses(raw) {
  const source = Array.isArray(raw) ? raw.slice(0, 3) : [];
  const classes = [];
  for (const entry of source) {
    if (!isRecord(entry)) continue;
    // Older sheets sometimes stored a class name instead of its index. Keep
    // that shape loadable by deriving the same lowercase index the creator did.
    const legacyName = boundedString(entry.name, 80);
    const legacyIndex = legacyName
      ? sanitizeReference(legacyName.toLowerCase().replace(/\s+/g, '-'), 80)
      : null;
    const classIndex = sanitizeReference(entry.class, 80) || legacyIndex;
    if (!classIndex) continue;
    classes.push({
      class: classIndex,
      subclass: sanitizeReference(entry.subclass, 80),
      level: boundedScalarInteger(entry.level, 1, 20, 1)
    });
  }
  return classes.length ? classes : [{ class: 'fighter', subclass: null, level: 1 }];
}

function sanitizeCharacterAppearance(raw, fallbackColor) {
  const source = isRecord(raw) ? raw : {};
  const rawColors = isRecord(source.colors) ? source.colors : {};
  const colors = {};
  for (const [key, fallback] of Object.entries(CHARACTER_COLOR_DEFAULTS)) {
    colors[key] = sanitizeColor(rawColors[key], key === 'torso' ? fallbackColor : fallback);
  }
  const appearance = { colors };
  for (const [key, fallback] of Object.entries(CHARACTER_APPEARANCE_DEFAULTS)) {
    appearance[key] = boundedScalarNumber(source[key], 0.5, 2, fallback);
  }
  return appearance;
}

// Character sheets are copied into map tokens and consumed by both the creator
// and combat rules. Build a canonical record rather than cloning arbitrary
// nested client data into every save and broadcast.
function sanitizeCharacterPayload(raw) {
  if (!isRecord(raw) || serializedBytes(raw) > MAX_CHARACTER_BYTES) return null;
  const name = boundedString(raw.name, 80);
  if (!name) return null;

  const requestedId = sanitizeReference(raw.id, 80);
  const race = sanitizeReference(raw.race, 80) || 'human';
  const topLevelColor = sanitizeColor(raw.color, CHARACTER_COLOR_DEFAULTS.torso);
  const abilitiesSource = isRecord(raw.abilities) ? raw.abilities : raw.stats;
  const abilities = sanitizeAbilityRecord(abilitiesSource);
  const appearance = sanitizeCharacterAppearance(raw.appearance, topLevelColor);
  const character = {
    name,
    schemaVersion: boundedScalarInteger(raw.schemaVersion, 1, 99, 2),
    race,
    subrace: sanitizeReference(raw.subrace, 80),
    background: sanitizeReference(raw.background, 80) || 'acolyte',
    alignment: sanitizeReference(raw.alignment, 80),
    classes: sanitizeCharacterClasses(raw.classes || (
      raw.class ? [{ class: raw.class, level: raw.level }] : null
    )),
    abilityMethod: CHARACTER_ABILITY_METHODS.has(raw.abilityMethod)
      ? raw.abilityMethod : 'manual',
    abilities,
    racialChoice: sanitizeReferenceArray(raw.racialChoice, CHARACTER_ABILITIES.length, 8)
      .filter(value => CHARACTER_ABILITIES.includes(value)),
    skills: sanitizeReferenceArray(raw.skills, 64, 96),
    appearance,
    equipment: {
      armor: isRecord(raw.equipment) ? sanitizeReference(raw.equipment.armor, 96) : null,
      shield: isRecord(raw.equipment) && raw.equipment.shield === true,
      weapons: isRecord(raw.equipment)
        ? sanitizeReferenceArray(raw.equipment.weapons, 64, 96) : [],
      items: isRecord(raw.equipment)
        ? sanitizeReferenceArray(raw.equipment.items, 128, 96) : []
    },
    spells: sanitizeReferenceArray(raw.spells, 256, 96),
    color: appearance.colors.torso,
    // stats is the schema-v1/token-renderer alias retained by creator v2.
    stats: { ...abilities }
  };
  if (requestedId) character.id = requestedId;
  if (isRecord(raw.hp)) {
    const current = boundedScalarInteger(raw.hp.current, 0, 999, null);
    if (current != null) character.hp = { current };
  }
  return character;
}

function sanitizeHomebrewReferenceRecord(raw, allowed = null) {
  if (!isRecord(raw)) return null;
  const index = sanitizeReference(raw.index, 96);
  if (!index || (allowed && !allowed.has(index))) return null;
  const record = { index };
  const name = boundedString(raw.name, 120);
  if (name) record.name = name;
  return record;
}

function sanitizeMonsterTextArray(raw, maxItems = 32, maxLength = 100) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, maxItems).map(value => boundedString(value, maxLength)).filter(Boolean);
}

function sanitizeMonsterAction(raw) {
  if (!isRecord(raw)) return null;
  const name = boundedString(raw.name, 120);
  if (!name) return null;
  const action = { name, desc: boundedString(raw.desc, 4000) };
  const attackBonus = boundedScalarInteger(raw.attack_bonus, -10, 30, null);
  if (attackBonus != null) action.attack_bonus = attackBonus;
  if (MONSTER_ATTACK_TYPES.has(raw.attack_type)) action.attack_type = raw.attack_type;
  const rangeFt = boundedScalarInteger(raw.range_ft, 5, 600, null);
  if (rangeFt != null) action.range_ft = rangeFt;
  if (Array.isArray(raw.damage)) {
    action.damage = raw.damage.slice(0, 4).map(rawEntry => {
      if (!isRecord(rawEntry)) return null;
      const alternatives = isRecord(rawEntry.from) && Array.isArray(rawEntry.from.options)
        ? rawEntry.from.options : [];
      const entry = rawEntry.damage_dice ? rawEntry : alternatives.map(option =>
        isRecord(option && option.item) ? option.item : option
      ).find(option => isRecord(option) && option.damage_dice);
      if (!isRecord(entry)) return null;
      const damageDice = boundedString(entry.damage_dice, 30);
      if (!damageDice || !/^\s*(?:\d+\s*d\s*\d+|\d+)(?:\s*[+-]\s*\d+)?\s*$/i.test(damageDice)) {
        return null;
      }
      const rawType = isRecord(entry.damage_type) ? entry.damage_type : {};
      const typeName = boundedString(rawType.name, 60);
      const typeIndex = sanitizeReference(rawType.index, 40) || (typeName
        ? sanitizeReference(typeName.toLowerCase().replace(/\s+/g, '-'), 40) : null);
      if (!typeIndex) return null;
      return {
        damage_dice: damageDice.replace(/\s+/g, ''),
        damage_type: { index: typeIndex, name: typeName || typeIndex }
      };
    }).filter(Boolean);
    if (!action.damage.length) delete action.damage;
  }
  if (isRecord(raw.dc)) {
    const ability = isRecord(raw.dc.dc_type)
      ? sanitizeReference(raw.dc.dc_type.index, 8) : null;
    const value = boundedScalarInteger(raw.dc.dc_value, 1, 40, null);
    if (CHARACTER_ABILITIES.includes(ability) && value != null) {
      action.dc = {
        dc_type: { index: ability, name: ability.toUpperCase() },
        dc_value: value,
        success_type: raw.dc.success_type === 'half' ? 'half' : 'none'
      };
    }
  }
  return action;
}

// SRD and user-authored creatures share this canonical, bounded shape. Placed
// tokens keep a snapshot, so later edits/deletions cannot mutate an encounter.
function sanitizeMonsterPayload(raw) {
  if (!isRecord(raw) || serializedBytes(raw) > MAX_MONSTER_BYTES) return null;
  const name = boundedString(raw.name, 80);
  if (!name) return null;
  const monster = {
    name,
    size: MONSTER_SIZES.has(raw.size) ? raw.size : 'Medium',
    type: boundedString(raw.type, 40) || 'monstrosity',
    alignment: boundedString(raw.alignment, 80),
    color: sanitizeColor(raw.color, '#b45309'),
    armor_class: [],
    hit_points: boundedScalarInteger(raw.hit_points, 1, 999, 1),
    hit_dice: boundedString(raw.hit_dice, 30) || '1d8',
    speed: {},
    challenge_rating: boundedScalarNumber(raw.challenge_rating, 0, 30, 0),
    xp: boundedScalarInteger(raw.xp, 0, 1_000_000, 0),
    languages: boundedString(raw.languages, 500),
    proficiencies: [],
    damage_vulnerabilities: sanitizeMonsterTextArray(raw.damage_vulnerabilities),
    damage_resistances: sanitizeMonsterTextArray(raw.damage_resistances),
    damage_immunities: sanitizeMonsterTextArray(raw.damage_immunities),
    condition_immunities: [],
    senses: {},
    special_abilities: [],
    actions: [],
    reactions: [],
    legendary_actions: []
  };
  const requestedIndex = sanitizeReference(raw.index, 96);
  if (requestedIndex) monster.index = requestedIndex;
  const source = boundedString(raw.source, 20);
  if (source === 'srd-5.1' || source === 'homebrew') monster.source = source;

  const armor = Array.isArray(raw.armor_class) ? raw.armor_class : [raw.armor_class];
  for (const entry of armor.slice(0, 4)) {
    const value = boundedScalarInteger(isRecord(entry) ? entry.value : entry, 1, 30, null);
    if (value == null) continue;
    const canonical = { type: isRecord(entry) ? (boundedString(entry.type, 30) || 'natural') : 'natural', value };
    const condition = isRecord(entry) ? boundedString(entry.condition, 300) : '';
    if (condition) canonical.condition = condition;
    monster.armor_class.push(canonical);
  }
  if (!monster.armor_class.length) monster.armor_class.push({ type: 'natural', value: 10 });

  const rawSpeed = isRecord(raw.speed) ? raw.speed : { walk: raw.speed };
  for (const [rawKind, rawValue] of Object.entries(rawSpeed).slice(0, 8)) {
    const kind = sanitizeReference(rawKind, 20);
    if (!kind) continue;
    if (typeof rawValue === 'number') {
      const speed = boundedScalarInteger(rawValue, 0, 120, null);
      if (speed != null) monster.speed[kind] = `${speed} ft.`;
    } else {
      const speedText = boundedString(rawValue, 40);
      const match = /(-?\d+(?:\.\d+)?)\s*ft\.?/i.exec(speedText);
      if (match) {
        const speed = boundedScalarInteger(match[1], 0, 120, null);
        if (speed != null) monster.speed[kind] = speedText.replace(match[0], `${speed} ft.`);
      } else if (speedText) {
        monster.speed[kind] = speedText;
      }
    }
  }
  if (!Object.keys(monster.speed).length) monster.speed.walk = '30 ft.';

  const abilityFields = {
    strength: 'str', dexterity: 'dex', constitution: 'con',
    intelligence: 'int', wisdom: 'wis', charisma: 'cha'
  };
  for (const [field, short] of Object.entries(abilityFields)) {
    monster[field] = boundedScalarInteger(raw[field], 1, 30,
      boundedScalarInteger(raw.abilities && raw.abilities[short], 1, 30, 10));
  }
  const defaultPB = 2 + Math.floor((Math.max(1, monster.challenge_rating) - 1) / 4);
  monster.proficiency_bonus = boundedScalarInteger(raw.proficiency_bonus, 0, 12, defaultPB);

  if (Array.isArray(raw.proficiencies)) {
    monster.proficiencies = raw.proficiencies.slice(0, 32).map(entry => {
      if (!isRecord(entry)) return null;
      const rawReference = isRecord(entry.proficiency) ? entry.proficiency : entry;
      const reference = sanitizeHomebrewReferenceRecord(rawReference);
      const value = boundedScalarInteger(entry.value, -20, 30, null);
      return reference && value != null ? { value, proficiency: reference } : null;
    }).filter(Boolean);
  }
  if (Array.isArray(raw.condition_immunities)) {
    monster.condition_immunities = raw.condition_immunities.slice(0, 32).map(entry => {
      if (typeof entry === 'string') {
        const name = boundedString(entry, 120);
        const index = name && sanitizeReference(name.toLowerCase().replace(/\s+/g, '-'), 80);
        return index ? { index, name } : null;
      }
      return sanitizeHomebrewReferenceRecord(entry);
    }).filter(Boolean);
  }
  if (isRecord(raw.senses)) {
    for (const [rawKind, rawValue] of Object.entries(raw.senses).slice(0, 16)) {
      const kind = sanitizeReference(rawKind, 40);
      if (!kind) continue;
      const numeric = typeof rawValue === 'number'
        ? boundedScalarInteger(rawValue, 0, 1000, null) : null;
      const value = numeric == null ? boundedString(rawValue, 120) : numeric;
      if (value !== '') monster.senses[kind] = value;
    }
  }
  for (const field of ['special_abilities', 'actions', 'reactions', 'legendary_actions']) {
    monster[field] = Array.isArray(raw[field])
      ? raw[field].slice(0, field === 'actions' ? 32 : 16).map(sanitizeMonsterAction).filter(Boolean)
      : [];
  }
  return monster;
}

function sanitizeHomebrewPayload(type, raw) {
  if (type === 'monster') return sanitizeMonsterPayload(raw);
  if (!isRecord(raw) || serializedBytes(raw) > 20_000) return null;
  const name = boundedString(raw.name, 60);
  if (!name) return null;
  const data = { name };
  const requestedIndex = sanitizeReference(raw.index, 96);
  if (requestedIndex) data.index = requestedIndex;

  if (type === 'race') {
    const size = boundedString(raw.size, 20);
    data.size = ['Tiny', 'Small', 'Medium', 'Large'].includes(size) ? size : 'Medium';
    data.speed = boundedScalarInteger(raw.speed, 0, 120, 30);
    data.ability_bonuses = [];
    if (Array.isArray(raw.ability_bonuses)) {
      for (const entry of raw.ability_bonuses.slice(0, CHARACTER_ABILITIES.length)) {
        if (!isRecord(entry)) continue;
        const ability = sanitizeHomebrewReferenceRecord(
          entry.ability_score, new Set(CHARACTER_ABILITIES)
        );
        const bonus = boundedScalarInteger(entry.bonus, -5, 10, null);
        if (ability && bonus != null) {
          ability.name = ability.index.toUpperCase();
          data.ability_bonuses.push({ ability_score: ability, bonus });
        }
      }
    }
    data.starting_proficiencies = Array.isArray(raw.starting_proficiencies)
      ? raw.starting_proficiencies.slice(0, 32)
        .map(entry => sanitizeHomebrewReferenceRecord(entry)).filter(Boolean)
      : [];
    data.traits = Array.isArray(raw.traits)
      ? raw.traits.slice(0, 64).map((entry) => {
        const traitName = isRecord(entry) ? boundedString(entry.name, 160) : '';
        return traitName ? { name: traitName } : null;
      }).filter(Boolean)
      : [];
    // The current homebrew form emits these arrays empty. Keep their public
    // schema for backward compatibility without persisting arbitrary objects.
    data.subraces = [];
    data.languages = [];
    return data;
  }

  if (type !== 'class') return null;
  data.hit_die = boundedScalarInteger(raw.hit_die, 4, 20, 8);
  data.saving_throws = Array.isArray(raw.saving_throws)
    ? raw.saving_throws.slice(0, 6)
      .map(entry => sanitizeHomebrewReferenceRecord(entry, new Set(CHARACTER_ABILITIES)))
      .filter(Boolean)
      .map(entry => ({ ...entry, name: entry.index.toUpperCase() }))
    : [];
  data.proficiencies = Array.isArray(raw.proficiencies)
    ? raw.proficiencies.slice(0, 64)
      .map(entry => sanitizeHomebrewReferenceRecord(entry)).filter(Boolean)
    : [];
  data.proficiency_choices = [];
  if (Array.isArray(raw.proficiency_choices)) {
    for (const group of raw.proficiency_choices.slice(0, 8)) {
      if (!isRecord(group) || !isRecord(group.from) || !Array.isArray(group.from.options)) continue;
      const options = group.from.options.slice(0, 64).map((option) => {
        if (!isRecord(option)) return null;
        const item = sanitizeHomebrewReferenceRecord(option.item);
        return item ? { option_type: 'reference', item } : null;
      }).filter(Boolean);
      const choose = boundedScalarInteger(group.choose, 0, options.length, 0);
      if (choose > 0 && options.length) {
        data.proficiency_choices.push({
          choose,
          type: 'proficiencies',
          from: { option_set_type: 'options_array', options }
        });
      }
    }
  }
  data.subclasses = [];
  const caster = boundedString(raw.caster, 12);
  data.caster = HOMEBREW_CASTER_TYPES.has(caster) ? caster : 'none';
  const spellAbility = isRecord(raw.spellcasting) &&
    isRecord(raw.spellcasting.spellcasting_ability)
    ? sanitizeHomebrewReferenceRecord(
      raw.spellcasting.spellcasting_ability, new Set(CHARACTER_ABILITIES)
    ) : null;
  data.spellcasting = data.caster !== 'none' && spellAbility
    ? { spellcasting_ability: { ...spellAbility, name: spellAbility.index.toUpperCase() } }
    : null;
  const spellList = sanitizeReference(raw.spellList, 32);
  data.spellList = data.caster !== 'none' && HOMEBREW_SPELL_LISTS.has(spellList)
    ? spellList : null;
  data.customFeatures = Array.isArray(raw.customFeatures)
    ? raw.customFeatures.slice(0, 100).map((entry) => {
      if (!isRecord(entry)) return null;
      const featureName = boundedString(entry.name, 120);
      if (!featureName) return null;
      return {
        level: boundedScalarInteger(entry.level, 1, 20, 1),
        name: featureName,
        desc: boundedString(entry.desc, 2000)
      };
    }).filter(Boolean)
    : [];
  return data;
}

function emitCharacterChange(event, payload, owner) {
  for (const sock of io.sockets.sockets.values()) {
    if (isGM(sock.username) || sock.username === owner) sock.emit(event, payload);
  }
}

function playerCharacterInstanceCount(username) {
  let count = 0;
  for (const map of Object.values(maps)) {
    for (const obj of Object.values(map.objects || {})) {
      if (ownsObject(username, obj)) count++;
    }
  }
  return count;
}

function sanitizeNewObject(raw, username) {
  if (!isRecord(raw) || serializedBytes(raw) > MAX_OBJECT_BYTES) {
    return { error: 'Invalid or oversized object' };
  }
  const type = String(raw.type || '');
  if (!OBJECT_TYPES.has(type)) return { error: 'Unknown object type' };
  if (!isGM(username) && type !== 'character') return { error: 'GM only' };
  const position = sanitizePosition(raw.position);
  if (!position) return { error: 'Invalid object position' };

  let object;
  try { object = cloneJSON(raw); } catch (_) { return { error: 'Invalid object' }; }
  delete object.id;
  delete object.addedBy;
  object.type = type;
  object.position = position;

  if (type === 'character') {
    const charId = boundedText(object.characterData && object.characterData.id, 80);
    const character = charId && ownValue(charactersDB, charId);
    if (!character || !canAccessCharacter(username, character)) {
      return { error: 'You can only place an accessible saved character' };
    }
    if (!isGM(username) && playerCharacterInstanceCount(username) >= MAX_PLAYER_CHARACTER_INSTANCES) {
      return { error: `Character instance limit reached (${MAX_PLAYER_CHARACTER_INSTANCES})` };
    }
    object.characterData = cloneJSON(character);
  }

  if (type === 'token' && object.monsterData != null) {
    const requested = sanitizeMonsterPayload(object.monsterData);
    if (!requested) return { error: 'Invalid or oversized monster' };
    const saved = requested.index && ownValue(homebrewDB.monsters, requested.index);
    if (saved) {
      object.monsterData = cloneJSON(saved);
    } else if (requested.source === 'srd-5.1') {
      const source = requested.index && ownValue(SRD_MONSTER_CATALOG, requested.index);
      const canonical = source && sanitizeMonsterPayload(source);
      if (!canonical) return { error: 'Unknown SRD monster' };
      canonical.source = 'srd-5.1';
      delete canonical.custom;
      delete canonical.owner;
      object.monsterData = canonical;
    } else {
      // Keep the snapshot usable even when its custom definition was deleted;
      // otherwise the only exposed library source is the vendored SRD catalog.
      object.monsterData = requested;
      object.monsterData.source = 'homebrew';
      object.monsterData.custom = true;
      delete object.monsterData.owner;
    }
    if (object.name == null) object.name = object.monsterData.name;
    if (object.color == null) object.color = object.monsterData.color;
  } else if (type !== 'token') {
    delete object.monsterData;
  }

  if (object.name != null) object.name = boundedText(object.name, 40);
  if (object.color != null) {
    if (typeof object.color === 'number' && Number.isFinite(object.color)) {
      object.color = Math.max(0, Math.min(0xffffff, Math.round(object.color)));
    } else if (/^#[0-9a-f]{6}$/i.test(String(object.color))) {
      object.color = String(object.color);
    } else {
      delete object.color;
    }
  }
  if (type === 'portal') {
    const target = knownMapKey(object.target);
    if (!target) return { error: 'Unknown portal target' };
    object.target = target;
    object.name = object.name || boundedText(target, 40) || 'Portal';
  }

  if (type === 'wall' || type === 'floor' || type === 'stair' || type === 'roof') {
    const buildingId = sanitizeStructureIdentity(object.buildingId);
    const structureId = sanitizeStructureIdentity(object.structureId);
    if (object.buildingId != null && !buildingId) return { error: 'Invalid building id' };
    if (object.structureId != null && !structureId) return { error: 'Invalid structure id' };
    object.structureId = structureId || `structure-${crypto.randomUUID()}`;
    if (buildingId) {
      const datum = boundedNumber(object.buildingDatumY, -WORLD_COORD_LIMIT, WORLD_COORD_LIMIT, null);
      if (datum == null) return { error: 'Grouped structures require a valid building datum' };
      object.buildingId = buildingId;
      object.buildingDatumY = datum;
    } else {
      delete object.buildingId;
      delete object.buildingDatumY;
    }
    object.style = ['stone', 'wood', 'plaster'].includes(object.style) ? object.style : 'stone';
    object.scruffy = !!object.scruffy;
    object.seed = Math.round(boundedNumber(object.seed, -0x7fffffff, 0x7fffffff, 1));
    object.level = Math.round(boundedNumber(object.level, -20, 50, 0));
    object.levelHeight = boundedNumber(object.levelHeight, 0.5, 20, 2);
    object.heightMode = object.heightMode === 'terrain' ? 'terrain' : 'flat';
  }
  if (type === 'wall') {
    object.wallHeight = boundedNumber(object.wallHeight, 0.4, 20, 2);
    object.bx = Math.round(boundedNumber(object.bx, -WALL_CELL_LIMIT, WALL_CELL_LIMIT, 0));
    object.bz = Math.round(boundedNumber(object.bz, -WALL_CELL_LIMIT, WALL_CELL_LIMIT, 0));
  }
  if (type === 'floor' || type === 'roof') {
    object.cols = Math.max(1, Math.min(STRUCTURE_TILE_LIMIT, Number(object.cols) | 0));
    object.rows = Math.max(1, Math.min(STRUCTURE_TILE_LIMIT, Number(object.rows) | 0));
    const count = structureTileCount(object);
    if (Array.isArray(object.ys)) {
      object.ys = Array.from({ length: count }, (_, i) =>
        boundedNumber(object.ys[i], -10000, 10000, 0));
    }
  }
  if (type === 'stair') {
    object.bx = Math.round(boundedNumber(object.bx, -WALL_CELL_LIMIT, WALL_CELL_LIMIT, 0));
    object.bz = Math.round(boundedNumber(object.bz, -WALL_CELL_LIMIT, WALL_CELL_LIMIT, 0));
    object.toLevel = Math.round(boundedNumber(object.toLevel, -20, 50, object.level + 1));
    object.rise = boundedNumber(object.rise, -20, 20, object.levelHeight);
    object.width = boundedNumber(object.width, 0.5, 8, 0.9);
  }
  if (type === 'roof') {
    object.coversLevel = Math.round(boundedNumber(object.coversLevel, -20, 50, object.level - 1));
    object.roofShape = ['flat', 'gable-x', 'gable-z', 'hip'].includes(object.roofShape)
      ? object.roofShape : 'gable-x';
    object.pitch = boundedNumber(object.pitch, 0.1, 1, 0.5);
  }
  return { object };
}

function finalizeStructureObject(object) {
  if (!object || !STRUCTURE_TYPES.has(object.type)) return object;
  if (object.type === 'wall' && Array.isArray(object.path)) {
    object.path = sanitizeWallPath(object.path);
    const end = object.path[object.path.length - 1] || { x: 0, z: 0 };
    object.bx = end.x;
    object.bz = end.z;
    const count = wallCellCount(object);
    if (Array.isArray(object.ys)) {
      object.ys = Array.from({ length: count }, (_, i) =>
        boundedNumber(object.ys[i], -10000, 10000, 0));
    }
    if (Array.isArray(object.segments)) {
      object.segments = Array.from({ length: count }, (_, i) =>
        WALL_SEGMENT_KINDS.has(object.segments[i]) ? object.segments[i] : null);
    }
  }
  if ((object.type === 'floor' || object.type === 'roof') && Array.isArray(object.tiles)) {
    object.tiles = sanitizeStructureTiles(object, object.tiles);
  }
  return object;
}

function duplicateStructureToStorey(source, destinationLevel, buildingId, buildingDatumY) {
  if (!source || !STRUCTURE_TYPES.has(source.type)) return null;
  const destination = Math.round(Number(destinationLevel));
  const fromStorey = structureStoreyLevel(source);
  const delta = destination - fromStorey;
  if (!Number.isFinite(destination) || !delta) return null;
  const levelHeight = boundedNumber(source.levelHeight, 0.5, 20, 2);
  const storedLevel = source.type === 'roof' ? destination + 1 : destination;
  const clone = cloneJSON(source);
  delete clone.id;
  delete clone.addedBy;
  clone.buildingId = buildingId;
  clone.structureId = `structure-${crypto.randomUUID()}`;
  clone.buildingDatumY = buildingDatumY;
  clone.heightMode = 'flat';
  clone.position = {
    x: Number(source.position && source.position.x) || 0,
    y: buildingDatumY + storedLevel * levelHeight,
    z: Number(source.position && source.position.z) || 0
  };
  if (Array.isArray(source.path)) clone.path = source.path.map(point => ({ ...point }));
  if (Array.isArray(source.ys)) clone.ys = source.ys.map(() => 0);
  if (Array.isArray(source.segments)) clone.segments = source.segments.slice();
  if (Array.isArray(source.tiles)) clone.tiles = source.tiles.slice();
  if (source.type === 'roof') {
    clone.coversLevel = destination;
    clone.level = destination + 1;
  } else {
    clone.level = destination;
    if (source.type === 'stair') {
      const sourceToLevel = Math.round(boundedNumber(
        source.toLevel, -20, 50, fromStorey + Math.sign(Number(source.rise) || 1)
      ));
      clone.toLevel = sourceToLevel + delta;
    }
  }
  return clone;
}

function sanitizeWaterData(raw) {
  if (!isRecord(raw)) return null;
  if (Array.isArray(raw.bodies)) {
    const bodies = [];
    for (const candidate of raw.bodies.slice(0, 64)) {
      if (!isRecord(candidate)) continue;
      const id = boundedText(candidate.id, 40) || ('w' + crypto.randomUUID().slice(0, 8));
      if (candidate.kind === 'lake') {
        const seed = sanitizeXZ(candidate.seed);
        const level = boundedNumber(candidate.level, -10000, 10000, null);
        if (!seed || level == null) continue;
        bodies.push({
          id, kind: 'lake', seed, level,
          maxRadius: boundedNumber(candidate.maxRadius, 1, 1024, 96)
        });
      } else if (candidate.kind === 'river' && Array.isArray(candidate.points)) {
        const points = candidate.points.slice(0, 256).map(sanitizeXZ).filter(Boolean);
        if (points.length < 2) continue;
        bodies.push({
          id, kind: 'river', points,
          width: boundedNumber(candidate.width, 0.5, 16, 2.5),
          speed: boundedNumber(candidate.speed, -20, 20, 1)
        });
      }
    }
    return { bodies };
  }
  return {
    enabled: !!raw.enabled,
    level: boundedNumber(raw.level, -50, 50, 0)
  };
}

function validBase64Layer(value) {
  return typeof value === 'string' && value.length <= MAX_TERRAIN_LAYER_BYTES &&
    value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
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

// Roll a saving throw for a target combatant vs a DC. Reusable primitive.
function rollSave(target, ability, dc) {
  const die = rollDie(20);
  const mod = (target.saves && typeof target.saves[ability] === 'number') ? target.saves[ability] : 0;
  const total = die + mod;
  return { d20: [die], used: die, mod, total, vs: dc, success: total >= dc };
}

// Apply damage to a combatant, mirroring the attack branch's HP write-back exactly.
function applyDamageToTarget(target, amount, stagedCharacterHP = null) {
  const cur = (target.hp && typeof target.hp.current === 'number') ? target.hp.current : target.maxHP;
  const next = Math.max(0, cur - amount);
  if (target.kind === 'character' && target.charId && hasOwn(charactersDB, target.charId)) {
    if (Array.isArray(stagedCharacterHP)) {
      const stage = stageCharacterHP(target.charId, next);
      if (!stage) return null;
      stagedCharacterHP.push(stage);
      setCombatantHP(target, stage.current);
    } else {
      applyCharacterHP(target.charId, next); // immediate path used outside a combat transaction
    }
  } else {
    setCombatantHP(target, next);
  }
  return next;
}

function fmtSigned(n) { return (n < 0 ? '- ' : '+ ') + Math.abs(n); }

// Conditions a combatant can carry. auto:true effects (from Dash/Dodge/
// Disengage) are stripped at the start of that combatant's next turn.
const CONDITION_LABELS = {
  dodging: 'Dodge', disengaged: 'Disengage', dashed: 'Dash', down: 'Down',
  prone: 'Prone', poisoned: 'Poisoned', restrained: 'Restrained', stunned: 'Stunned',
  blinded: 'Blinded', frightened: 'Frightened', grappled: 'Grappled', invisible: 'Invisible'
};

// Early versions persisted combat state before the socket boundary had a
// complete nested schema. Repair those parseable legacy records on load so a
// null effect, object-valued order/log, or string numeric cannot crash either
// the server rules engine or a client tracker.
function normalizePersistedCombat(raw) {
  if (!isRecord(raw) || !isRecord(raw.combatants)) return null;
  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
  };
  const abilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const combatants = {};
  for (const [rawId, value] of Object.entries(raw.combatants).slice(0, MAX_MAP_OBJECTS)) {
    if (!isRecord(value)) continue;
    const id = boundedText(rawId, 80) || boundedText(value.id, 80);
    if (!id || hasOwn(combatants, id)) continue;
    const kind = value.kind === 'character' ? 'character' : 'token';
    const saves = {};
    for (const ability of abilities) saves[ability] = clamp(value.saves && value.saves[ability], -20, 30, 0);
    const slots = {};
    for (let level = 1; level <= 9; level++) slots[level] = clamp(value.slots && value.slots[level], 0, 20, 0);
    const effects = [];
    const seenEffects = new Set();
    for (const effect of (Array.isArray(value.effects) ? value.effects : []).slice(0, 32)) {
      const key = isRecord(effect) ? boundedText(effect.key, 24) : '';
      if (!CONDITION_LABELS[key] || seenEffects.has(key)) continue;
      seenEffects.add(key);
      effects.push({ key, label: CONDITION_LABELS[key], auto: effect.auto === true });
    }
    const attacks = (Array.isArray(value.attacks) ? value.attacks : []).slice(0, 8).map(attack => {
      const normalized = {
        name: boundedString(attack && attack.name, 30) || 'Attack',
        attack: clamp(attack && attack.attack, -10, 30, 0),
        damage: boundedString(attack && attack.damage, 20) || '1',
        damageType: boundedString(attack && attack.damageType, 20),
        ranged: !!(attack && attack.ranged),
        rangeFt: clamp(attack && attack.rangeFt, 5, 600, 5)
      };
      const parts = (Array.isArray(attack && attack.damageParts) ? attack.damageParts : [])
        .slice(0, 4).map(part => ({
          damage: boundedString(part && part.damage, 20) || '1',
          damageType: boundedString(part && part.damageType, 20)
        }));
      if (parts.length > 1) normalized.damageParts = parts;
      return normalized;
    });
    const spells = (Array.isArray(value.spells) ? value.spells : []).slice(0, 20).map((spell, index) => {
      const normalized = {
        name: boundedString(spell && spell.name, 40) || 'Spell',
        level: clamp(spell && spell.level, 0, 9, 0),
        damage: boundedString(spell && spell.damage, 20) || '1d4',
        damageType: boundedString(spell && spell.damageType, 20),
        spellIndex: index
      };
      if (spell && spell.saveAbility) {
        normalized.saveAbility = abilities.includes(spell.saveAbility) ? spell.saveAbility : 'dex';
        normalized.saveSuccess = spell.saveSuccess === 'none' ? 'none' : 'half';
      } else {
        normalized.attackType = spell && spell.attackType === 'melee' ? 'melee' : 'ranged';
      }
      return normalized;
    });
    const maxHP = clamp(value.maxHP, 1, 999, 10);
    const hp = isRecord(value.hp)
      ? { current: clamp(value.hp.current, 0, 999, maxHP) }
      : null;
    let color;
    if (typeof value.color === 'number' && Number.isFinite(value.color)) {
      color = Math.max(0, Math.min(0xffffff, Math.round(value.color)));
    } else {
      color = sanitizeColor(value.color, '#dd4444');
    }
    combatants[id] = {
      id,
      kind,
      name: boundedString(value.name, 40) || (kind === 'character' ? 'Adventurer' : 'Token'),
      color,
      charId: kind === 'character' ? (boundedText(value.charId, 80) || null) : null,
      owner: kind === 'character' ? (boundedText(value.owner, MAX_USERNAME_LENGTH) || null) : null,
      statsPending: value.statsPending === true,
      ac: clamp(value.ac, 1, 30, 10),
      speedFeet: clamp(value.speedFeet, 0, 120, 30),
      initMod: clamp(value.initMod, -10, 20, 0),
      initiative: value.initiative == null ? null : clamp(value.initiative, -100, 100, null),
      maxHP,
      hp,
      movementUsedFeet: clamp(value.movementUsedFeet, 0, 1000000, 0),
      dashFeet: clamp(value.dashFeet, 0, 1000000, 0),
      actionUsed: value.actionUsed === true,
      effects,
      attacks,
      saves,
      spellAtk: clamp(value.spellAtk, -10, 30, 0),
      spellDC: clamp(value.spellDC, 1, 40, 8),
      slots,
      spells
    };
  }
  const order = [];
  const seenOrder = new Set();
  for (const candidate of (Array.isArray(raw.order) ? raw.order : [])) {
    const id = boundedText(candidate, 80);
    if (!hasOwn(combatants, id) || seenOrder.has(id)) continue;
    seenOrder.add(id);
    order.push(id);
  }
  if (raw.started === true) {
    for (const id of Object.keys(combatants)) {
      if (!seenOrder.has(id)) order.push(id);
    }
  }
  const log = (Array.isArray(raw.log) ? raw.log : []).filter(isRecord).slice(-100).map((entry, index) => ({
    id: boundedText(entry.id, 24) || `legacy-${index}`,
    ts: boundedNumber(entry.ts, 0, Number.MAX_SAFE_INTEGER, 0),
    round: clamp(entry.round, 0, 1000000, 0),
    kind: boundedString(entry.kind, 24) || 'info',
    actorName: boundedString(entry.actorName, 80),
    targetName: boundedString(entry.targetName, 80),
    spellName: boundedString(entry.spellName, 80),
    text: boundedString(entry.text, 1000)
  }));
  const requestedActiveId = boundedText(raw.activeId, 80);
  const activeId = hasOwn(combatants, requestedActiveId)
    ? requestedActiveId
    : (raw.started === true ? (order[0] || null) : null);
  return {
    active: true,
    started: raw.started === true,
    round: raw.started === true ? clamp(raw.round, 1, 1000000, 1) : 0,
    activeId,
    order,
    combatants,
    log
  };
}

for (const [key, map] of Object.entries(maps)) {
  if (!hasOwn(map, 'combat')) continue;
  const normalized = normalizePersistedCombat(map.combat);
  if (normalized) map.combat = normalized;
  else {
    console.warn(`[COMBAT] Dropping malformed persisted combat on ${key}.`);
    delete map.combat;
  }
}

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
function stageCharacterHP(id, current) {
  const char = ownValue(charactersDB, id);
  if (!char) return null;
  const v = Math.floor(boundedNumber(current, 0, 999, 0));
  const stage = { id, current: v, previousHpSnapshot: snapshotField(char, 'hp') };
  char.hp = { current: v };
  return stage;
}

function restoreCharacterHP(stage) {
  if (!stage) return;
  const char = ownValue(charactersDB, stage.id);
  if (char) restoreField(char, 'hp', stage.previousHpSnapshot);
}

function emitCharacterHP(stage) {
  if (!stage) return;
  const character = ownValue(charactersDB, stage.id);
  if (!character) return;
  emitCharacterChange(
    'hp-updated',
    { id: stage.id, current: stage.current },
    character.owner
  );
}

// A saved character can have several token instances in several simultaneous
// combats. Collapse repeated stages to their final value, snapshot each combat
// map once, then update every mirror before the single map-state commit.
function stageCharacterCombatMirrors(stages, existingSnapshots = new Map()) {
  const finalStagesById = new Map();
  for (const stage of stages) {
    if (stage) finalStagesById.set(stage.id, stage);
  }
  const touchedByKey = new Map(existingSnapshots);
  for (const [key, map] of Object.entries(maps)) {
    if (!map.combat || !isRecord(map.combat.combatants)) continue;
    const mirrors = Object.values(map.combat.combatants)
      .filter(combatant => finalStagesById.has(combatant.charId));
    if (!mirrors.length) continue;
    if (!touchedByKey.has(key)) {
      touchedByKey.set(key, { key, map, previousCombat: snapshotField(map, 'combat') });
    }
    for (const combatant of mirrors) {
      setCombatantHP(combatant, finalStagesById.get(combatant.charId).current);
    }
  }
  return {
    finalStages: [...finalStagesById.values()],
    touchedCombats: [...touchedByKey.values()]
  };
}

function refreshHPRecoverySnapshots() {
  const results = [
    rewriteJSONBackup('characters.json', charactersDB),
    rewriteJSONBackup('map_state.json', { maps })
  ];
  return results.every(Boolean);
}

// Called only after transaction memory has been restored. Attempt every write
// (without short-circuiting) so a failed recovery target cannot prevent the
// other primary/backup from returning to the same pre-transaction generation.
function restoreHPTransactionStorage() {
  const results = [
    rewriteJSONPrimary('characters.json', charactersDB),
    rewriteJSONPrimary('map_state.json', { maps }),
    rewriteJSONBackup('characters.json', charactersDB),
    rewriteJSONBackup('map_state.json', { maps })
  ];
  return results.every(Boolean);
}

function applyCharacterHP(id, current) {
  const stage = stageCharacterHP(id, current);
  if (!stage) return null;
  const { finalStages, touchedCombats } = stageCharacterCombatMirrors([stage]);
  if (!saveJSON('characters.json', charactersDB)) {
    restoreCharacterHP(stage);
    for (const touched of touchedCombats) {
      restoreCombatField(touched.map, touched.previousCombat);
    }
    return null;
  }
  if (touchedCombats.length) {
    if (!saveMaps()) {
      for (const touched of touchedCombats) {
        restoreCombatField(touched.map, touched.previousCombat);
      }
      restoreCharacterHP(stage);
      if (!rewriteJSONPrimary('characters.json', charactersDB)) {
        console.error('[HP] Could not compensate character HP after a failed map save.');
      }
      return null;
    }
    if (!refreshHPRecoverySnapshots()) {
      for (const touched of touchedCombats) {
        restoreCombatField(touched.map, touched.previousCombat);
      }
      restoreCharacterHP(stage);
      if (!restoreHPTransactionStorage()) {
        console.error('[HP] Could not restore a matched recovery snapshot.');
      }
      return null;
    }
  }
  for (const finalStage of finalStages) emitCharacterHP(finalStage);
  for (const touched of touchedCombats) emitCombatState(touched.key);
  return stage.current;
}

// Combat log entries are queued until the same atomic map save succeeds. This
// prevents clients from observing a turn/action that only exists in memory
// after a persistence failure.
const pendingCombatLogs = new WeakMap();
function pushLog(key, combat, entry) {
  entry.id = crypto.randomUUID().slice(0, 8);
  entry.ts = Date.now();
  entry.round = combat.round;
  combat.log.push(entry);
  if (combat.log.length > 100) combat.log.splice(0, combat.log.length - 100);
  const pending = pendingCombatLogs.get(combat) || [];
  pending.push({ key, entry });
  pendingCombatLogs.set(combat, pending);
  return entry;
}

function discardPendingCombatLogs(combat) {
  if (combat) pendingCombatLogs.delete(combat);
}

function restoreCombatField(map, snapshot) {
  discardPendingCombatLogs(map.combat);
  restoreField(map, 'combat', snapshot);
}

const PUBLIC_COMBATANT_FIELDS = [
  'id', 'kind', 'name', 'color', 'owner', 'statsPending', 'initiative',
  'ac', 'speedFeet', 'maxHP', 'hp', 'movementUsedFeet', 'dashFeet',
  'actionUsed', 'effects'
];

// Encounter-facing status is shared at the table, but a character's sheet
// choices and stable character id remain private to its owner and the GM.
function projectCombatFor(username, combat) {
  if (!combat || isGM(username) || !isRecord(combat.combatants)) return combat;
  const combatants = {};
  for (const [id, combatant] of Object.entries(combat.combatants)) {
    if (!isRecord(combatant) || combatant.owner === username) {
      combatants[id] = combatant;
      continue;
    }
    const projected = {};
    for (const field of PUBLIC_COMBATANT_FIELDS) {
      if (hasOwn(combatant, field)) projected[field] = combatant[field];
    }
    combatants[id] = projected;
  }
  const log = (Array.isArray(combat.log) ? combat.log : []).map(entry => {
    if (!isRecord(entry)) return null;
    const projected = {};
    for (const field of [
      'id', 'ts', 'round', 'kind', 'actorName', 'targetName', 'spellName',
      'text', 'roll', 'dmg', 'save'
    ]) {
      if (hasOwn(entry, field)) projected[field] = entry[field];
    }
    return projected;
  }).filter(Boolean);
  return {
    active: combat.active === true,
    started: combat.started === true,
    round: combat.round,
    activeId: combat.activeId,
    order: Array.isArray(combat.order) ? combat.order : [],
    combatants,
    log
  };
}

function emitCombatState(key) {
  const state = (maps[key] && maps[key].combat) || null;
  const pending = state ? (pendingCombatLogs.get(state) || []) : [];
  discardPendingCombatLogs(state);
  for (const queued of pending) {
    if (isUnifiedKey(queued.key)) emitToUnified(null, (sock) => sock.emit('combat-log', queued.entry));
    else io.to(queued.key).emit('combat-log', queued.entry);
  }
  if (isUnifiedKey(key)) {
    emitToUnified(null, (sock) => sock.emit('combat-updated', projectCombatFor(sock.username, state)));
  } else {
    emitToRoom(key, null, (sock) => sock.emit('combat-updated', projectCombatFor(sock.username, state)));
  }
}

// Build a combatant from a map object. Characters join with statsPending until
// an owning client sends SRD-derived stats; plain tokens get editable defaults.
function monsterAbilityMod(monster, field) {
  const score = boundedScalarInteger(monster && monster[field], 1, 30, 10);
  return Math.floor((score - 10) / 2);
}

function monsterSpeedFeet(monster) {
  const speed = isRecord(monster && monster.speed) ? monster.speed : {};
  const values = hasOwn(speed, 'walk')
    ? [speed.walk, ...Object.values(speed).filter(value => value !== speed.walk)]
    : Object.values(speed);
  let stationary = null;
  for (const value of values) {
    const match = /(-?\d+(?:\.\d+)?)\s*ft\.?/i.exec(String(value || ''));
    if (!match) continue;
    const parsed = boundedScalarInteger(match[1], 0, 120, 30);
    if (parsed > 0) return parsed;
    stationary = 0;
  }
  return stationary ?? 30;
}

function monsterAttackRange(action, ranged) {
  const explicit = boundedScalarInteger(action && action.range_ft, 5, 600, null);
  if (explicit != null) return explicit;
  const description = String(action && action.desc || '');
  const pattern = ranged
    ? /range\s+(\d+)(?:\s*\/\s*\d+)?\s*ft\.?/i
    : /reach\s+(\d+)\s*ft\.?/i;
  const match = pattern.exec(description);
  return match ? boundedScalarInteger(match[1], 5, 600, ranged ? 30 : 5) : (ranged ? 30 : 5);
}

function monsterCombatSeed(monster) {
  const canonical = sanitizeMonsterPayload(monster);
  if (!canonical) return null;
  const abilityFields = {
    str: 'strength', dex: 'dexterity', con: 'constitution',
    int: 'intelligence', wis: 'wisdom', cha: 'charisma'
  };
  const saves = {};
  for (const [ability, field] of Object.entries(abilityFields)) {
    saves[ability] = monsterAbilityMod(canonical, field);
  }
  for (const entry of canonical.proficiencies) {
    const match = /^saving-throw-(str|dex|con|int|wis|cha)$/.exec(
      String(entry && entry.proficiency && entry.proficiency.index || '')
    );
    if (match) saves[match[1]] = boundedScalarInteger(entry.value, -20, 30, saves[match[1]]);
  }
  const attacks = [];
  for (const action of canonical.actions) {
    if (action.attack_bonus == null || !Array.isArray(action.damage)) continue;
    const damageEntries = action.damage.filter(entry => entry && entry.damage_dice);
    const damage = damageEntries[0];
    if (!damage) continue;
    const description = String(action.desc || '');
    const ranged = action.attack_type === 'ranged' || /Ranged (?:Weapon|Spell) Attack/i.test(description);
    const attack = {
      name: String(action.name || 'Attack').slice(0, 30),
      attack: boundedScalarInteger(action.attack_bonus, -10, 30, 0),
      damage: String(damage.damage_dice || '1').replace(/\s+/g, '').slice(0, 20),
      damageType: String(damage.damage_type && (
        damage.damage_type.index || damage.damage_type.name
      ) || '').slice(0, 20),
      ranged,
      rangeFt: monsterAttackRange(action, ranged)
    };
    if (damageEntries.length > 1) {
      attack.damageParts = damageEntries.slice(0, 4).map(entry => ({
        damage: String(entry.damage_dice || '1').replace(/\s+/g, '').slice(0, 20),
        damageType: String(entry.damage_type && (
          entry.damage_type.index || entry.damage_type.name
        ) || '').slice(0, 20)
      }));
    }
    attacks.push(attack);
    if (attacks.length >= 8) break;
  }
  const armor = canonical.armor_class.find(entry => entry && Number.isFinite(Number(entry.value)));
  return {
    canonical,
    ac: boundedScalarInteger(armor && armor.value, 1, 30, 10),
    speedFeet: monsterSpeedFeet(canonical),
    initMod: monsterAbilityMod(canonical, 'dexterity'),
    maxHP: boundedScalarInteger(canonical.hit_points, 1, 999, 1),
    saves,
    attacks
  };
}

function seedCombatant(obj) {
  const base = {
    id: obj.id, initiative: null,
    movementUsedFeet: 0, dashFeet: 0, actionUsed: false, effects: [],
    saves: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    spellAtk: 0,
    spellDC: 8,
    slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
    spells: []
  };
  if (obj.type === 'character' && obj.characterData) {
    const cd = obj.characterData;
    const live = cd.id && ownValue(charactersDB, cd.id);
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
    const monster = obj.monsterData && monsterCombatSeed(obj.monsterData);
    if (monster) {
      return {
        ...base, kind: 'token',
        name: String(obj.name || monster.canonical.name || 'Monster').slice(0, 40),
        color: obj.color || monster.canonical.color || 0xb45309,
        charId: null, owner: null, statsPending: false,
        ac: monster.ac, speedFeet: monster.speedFeet, initMod: monster.initMod,
        maxHP: monster.maxHP, hp: { current: monster.maxHP },
        saves: monster.saves, attacks: monster.attacks
      };
    }
    return {
      ...base, kind: 'token', name: String(obj.name || 'Token').slice(0, 40), color: obj.color || 0xdd4444,
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
  if (!hasOwn(combat.combatants, id)) return;
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
    if (typeof username !== 'string') {
      socket.emit('error', 'Invalid username');
      return;
    }
    const normalizedUsername = boundedText(username, MAX_USERNAME_LENGTH);
    if (!normalizedUsername) {
      socket.emit('error', 'Invalid username');
      return;
    }

    socket.username = normalizedUsername;
    console.log(`[LOGIN] ${socket.username} (${socket.id})`);

    // Send login success with role
    socket.emit('login-success', {
      username: socket.username,
      isGM: isGM(socket.username)
    });

    // Send accessible characters
    socket.emit('load-user-characters', charactersAccessibleTo(socket.username));

    // Seed the Instances tab (kept live by pushCharacterInstances afterwards).
    socket.emit('character-instances', { instances: characterInstancesFor(socket.username) });

    // Races/classes are shared content; monster rules are GM/author scoped.
    socket.emit('load-homebrew', homebrewPayloadFor(socket.username));

    // Send the first map snapshot only after the role is known. The GM gets the
    // unfiltered world; players get fog filtering plus their owned-token pass.
    if (socket.currentMapKey) sendMapState(socket.currentMapKey, socket.contextMapKey);
    broadcastPresence();
  });

  // Get characters (filtered by permission)
  socket.on('get-characters', () => {
    if (!socket.username) {
      socket.emit('error', 'Not logged in');
      return;
    }

    socket.emit('load-user-characters', charactersAccessibleTo(socket.username));
  });

  // Save character
  socket.on('save-character', (payload) => {
    if (!socket.username) {
      socket.emit('error', 'Not logged in');
      return;
    }

    const rawCharacter = isRecord(payload) && isRecord(payload.charData) ? payload.charData : payload;
    const charData = sanitizeCharacterPayload(rawCharacter);
    if (!charData) {
      socket.emit('error', 'Invalid character');
      return;
    }
    const requestedId = charData.id || '';

    // If character exists, verify permission to edit
    if (requestedId && hasOwn(charactersDB, requestedId)) {
      const existing = charactersDB[requestedId];
      if (!canAccessCharacter(socket.username, existing)) {
        socket.emit('error', 'Permission denied');
        return;
      }
      charData.id = requestedId;
      // Editing never silently transfers ownership (the creator has no explicit
      // transfer control); GM access still permits editing every record.
      charData.owner = existing.owner;
      // Sheet edits never mutate live HP. HP has its own transaction path so
      // every active combat mirror, event, primary and recovery copy move as
      // one logical update—even if a stale or crafted creator payload includes
      // an hp field.
      if (hasOwn(existing, 'hp')) charData.hp = cloneJSON(existing.hp);
      else delete charData.hp;
    } else {
      if (Object.values(charactersDB).filter(char => char.owner === socket.username).length >= MAX_CHARACTERS_PER_OWNER) {
        socket.emit('error', `Character limit reached (${MAX_CHARACTERS_PER_OWNER} per user)`);
        return;
      }
      // Unknown/client-chosen ids are never trusted as new record keys.
      charData.id = crypto.randomUUID();
      charData.owner = socket.username;
    }

    console.log(`[SAVE] ${charData.name} by ${socket.username} (owner: ${charData.owner})`);
    
    const previousCharacter = snapshotField(charactersDB, charData.id);
    charactersDB[charData.id] = charData;
    if (!saveJSON('characters.json', charactersDB)) {
      restoreField(charactersDB, charData.id, previousCharacter);
      socket.emit('error', 'Could not save the character');
      return;
    }
    
    socket.emit('character-saved-success', charData);

    // Send updated character list
    socket.emit('load-user-characters', charactersAccessibleTo(socket.username));

    // Character sheets are private to their owner; the GM can access all.
    emitCharacterChange('character-updated', charData, charData.owner);
  });

  // Delete character
  socket.on('delete-character', (payload) => {
    if (!socket.username) {
      socket.emit('error', 'Not logged in');
      return;
    }

    const charId = typeof payload === 'string'
      ? boundedText(payload, 80)
      : (isRecord(payload) ? boundedText(payload.charId, 80) : '');
    if (!charId) {
      socket.emit('error', 'Invalid character id');
      return;
    }
    const char = ownValue(charactersDB, charId);

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
    const previousCharacter = snapshotField(charactersDB, charId);
    delete charactersDB[charId];
    if (!saveJSON('characters.json', charactersDB)) {
      restoreField(charactersDB, charId, previousCharacter);
      socket.emit('error', 'Could not delete the character');
      return;
    }

    // Send updated list
    socket.emit('load-user-characters', charactersAccessibleTo(socket.username));

    // Notify only clients who could access this character before deletion.
    emitCharacterChange('character-deleted', charId, char.owner);
  });

  // Update a character's current HP (live, persisted, broadcast to everyone).
  socket.on('update-hp', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const id = isRecord(payload) ? sanitizeReference(payload.id, 80) : null;
    const char = id && ownValue(charactersDB, id);
    if (!char) { socket.emit('error', 'Character not found'); return; }
    if (!canAccessCharacter(socket.username, char)) { socket.emit('error', 'Permission denied'); return; }
    const nextHP = boundedScalarInteger(payload.current, 0, 999, null);
    if (nextHP == null) { socket.emit('error', 'Invalid HP'); return; }
    if (applyCharacterHP(id, nextHP) == null) {
      socket.emit('error', 'Could not update character HP');
    }
  });

  // --- Homebrew (custom races/classes) — shared content ---
  function broadcastHomebrew() {
    for (const recipient of io.sockets.sockets.values()) {
      if (recipient.username) recipient.emit('load-homebrew', homebrewPayloadFor(recipient.username));
    }
  }

  socket.on('get-homebrew', () => {
    socket.emit('load-homebrew', homebrewPayloadFor(socket.username));
  });

  socket.on('save-homebrew', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const type = payload && payload.type;
    const data = sanitizeHomebrewPayload(type, payload && payload.data);
    if (!data) {
      socket.emit('error', 'Invalid homebrew');
      return;
    }
    const store = type === 'race' ? homebrewDB.races
      : (type === 'class' ? homebrewDB.classes : (type === 'monster' ? homebrewDB.monsters : null));
    if (!store) {
      socket.emit('error', 'Invalid homebrew type');
      return;
    }
    const isNew = !(data.index && hasOwn(store, data.index));
    if (isNew && Object.values(store).filter(e => e.owner === socket.username).length >= 100) {
      socket.emit('error', 'Homebrew limit reached (100 per user)');
      return;
    }
    if (data.index && hasOwn(store, data.index)) {
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
    if (type === 'monster') data.source = 'homebrew';
    const previousHomebrew = snapshotField(store, data.index);
    store[data.index] = data;
    if (!saveJSON('homebrew.json', homebrewDB)) {
      restoreField(store, data.index, previousHomebrew);
      socket.emit('error', 'Could not save homebrew');
      return;
    }
    console.log(`[HOMEBREW] ${type} "${data.name}" by ${socket.username}`);
    socket.emit('homebrew-saved-success', { type, data });
    broadcastHomebrew();
  });

  socket.on('delete-homebrew', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const type = payload && payload.type;
    const index = payload && sanitizeReference(payload.index, 96);
    const store = type === 'race' ? homebrewDB.races
      : (type === 'class' ? homebrewDB.classes : (type === 'monster' ? homebrewDB.monsters : null));
    if (!store || !hasOwn(store, index)) { socket.emit('error', 'Homebrew not found'); return; }
    if (!isGM(socket.username) && store[index].owner !== socket.username) {
      socket.emit('error', 'Permission denied');
      return;
    }
    const previousHomebrew = snapshotField(store, index);
    delete store[index];
    if (!saveJSON('homebrew.json', homebrewDB)) {
      restoreField(store, index, previousHomebrew);
      socket.emit('error', 'Could not delete homebrew');
      return;
    }
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
    const m = isGM(socket.username) ? getMap(roomKey) : mapForRead(roomKey);
    const ctx = contextKey || roomKey;
    const extra = {};
    const gm = isGM(socket.username);
    const unified = isUnifiedKey(roomKey);
    if (unified) {
      extra.worldCenter = provinceWorldCenter(ctx);
      extra.unified = true;
      extra.hexTree = collectHexTree();
      // The revealed set (the mask itself isn't secret — clients render it).
      extra.fog = Object.keys(worldFog());
      const wt = ensureWorld().terrain;
      if (roomKey !== WORLD_KEY) extra.terrain = gm ? wt : filterTerrainForPlayer(wt);
    }
    // Fog of war: players only receive objects and terrain edits inside
    // revealed regions of the unified world (pockets are never fogged).
    let objectsOut = Object.values(unified ? getMap(WORLD_KEY).objects : m.objects);
    let terrainOut = m.terrain || null;
    if (unified && !gm) {
      objectsOut = objectsOut.filter(o => objectVisibleTo(socket.username, o));
      terrainOut = filterTerrainForPlayer(terrainOut);
    }
    objectsOut = objectsOut.map(object => projectObjectFor(socket.username, object));
    socket.emit('map-state', {
      key: ctx,
      objects: objectsOut,
      rulers: Object.values(m.rulers),
      terrain: terrainOut,
      meta: m.meta || null,
      hexes: m.hexes || {},
      biome: resolveBiome(ctx),
      combat: projectCombatFor(socket.username, (unified ? getMap(WORLD_KEY).combat : m.combat) || null),
      ...extra
    });
  }

  // Establish the default room on transport connect, but do not send a
  // fog-filtered anonymous snapshot. Login sends the first authoritative
  // role-aware map-state below.
  socket.currentMapKey = DEFAULT_MAP_KEY;
  socket.contextMapKey = DEFAULT_MAP_KEY;
  socket.join(DEFAULT_MAP_KEY);

  // Switch this socket to a different map. Tactical paths are routed to the one
  // continuous world (WORLD_KEY) so provinces share terrain; hex tiers and
  // pockets keep their own rooms.
  socket.on('join-map', (payload) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const requestedKey = payload && payload.key != null ? payload.key : DEFAULT_MAP_KEY;
    const reqKey = knownMapKey(requestedKey);
    if (!reqKey) { socket.emit('error', 'Unknown map'); return; }
    const roomKey = isTacticalPath(reqKey) ? WORLD_KEY : reqKey;
    if (socket.currentMapKey && socket.currentMapKey !== roomKey) {
      socket.leave(socket.currentMapKey);
    }
    socket.currentMapKey = roomKey;
    socket.contextMapKey = reqKey;
    socket.join(roomKey);
    if (isGM(socket.username) || hasOwn(maps, roomKey)) getMap(roomKey);
    if (roomKey === WORLD_KEY) ensureWorld();
    console.log(`[MAP] ${socket.username || socket.id} -> ${reqKey}${roomKey !== reqKey ? ' [' + roomKey + ']' : ''}`);
    sendMapState(roomKey, reqKey);
    if (socket.username) broadcastPresence();
  });

  // Tag a hex on the current (hex-layer) map with a biome; null clears the tag.
  // Tags color the hex on the GM screen and seed new tactical maps beneath it.
  const BIOME_KEYS = ['plains', 'forest', 'mountains', 'desert', 'swamp', 'coast'];
  socket.on('update-hex', (payload) => {
    if (!isGM(socket.username)) { socket.emit('error', 'GM only'); return; }
    const q = Math.round(Number(payload && payload.q)), r = Math.round(Number(payload && payload.r));
    if (!isFinite(q) || !isFinite(r) || Math.abs(q) > 64 || Math.abs(r) > 64) return;
    const biome = payload.biome == null ? null : String(payload.biome);
    if (biome !== null && !BIOME_KEYS.includes(biome)) return;
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    if (!isWorldHexPath(key)) return; // tags live on hex-tier layers only
    const map = getMap(key);
    const previousHexes = snapshotField(map, 'hexes');
    map.hexes = map.hexes || {};
    const hk = q + ',' + r;
    if (biome === null) delete map.hexes[hk];
    else map.hexes[hk] = { biome };
    if (!saveMaps()) {
      restoreField(map, 'hexes', previousHexes);
      socket.emit('error', 'Could not save the hex update');
      return;
    }
    // Global broadcast (not just the layer's room): painted biomes override
    // terrain generation, so every client rendering the world needs the change.
    io.emit('hex-updated', { key, hex: hk, biome });
  });

  // Create a pocket map (dungeon/cave/room): its own map key outside the hex tree,
  // entered through portal objects. Ships with an exit portal back to the parent.
  socket.on('create-pocket-map', (payload) => {
    if (!isGM(socket.username)) { socket.emit('error', 'GM only'); return; }
    const name = String((payload && payload.name) || 'Pocket').trim().slice(0, 40) || 'Pocket';
    const clampDim = (v) => Math.max(4, Math.min(256, Math.floor(Number(v) || 24)));
    const width = clampDim(payload && payload.width);
    const height = clampDim(payload && payload.height);
    const requestedParent = payload && payload.parentKey != null
      ? payload.parentKey : (socket.currentMapKey || DEFAULT_MAP_KEY);
    const parentKey = knownMapKey(requestedParent);
    if (!parentKey) { socket.emit('error', 'Unknown parent map'); return; }
    const key = 'pocket/' + crypto.randomUUID().slice(0, 8);
    const exitId = crypto.randomUUID();
    maps[key] = {
      objects: {
        [exitId]: { id: exitId, type: 'portal', target: parentKey, name: 'Exit', position: { x: 0, y: 0, z: 0 } }
      },
      rulers: {},
      meta: { kind: 'pocket', name, width, height, parentKey }
    };
    if (!saveMaps()) {
      delete maps[key];
      socket.emit('error', 'Could not save the pocket map');
      return;
    }
    console.log(`[POCKET] "${name}" (${width}x${height}) -> ${key} by ${socket.username}`);
    socket.emit('pocket-created', { key, name });
  });

  socket.on('add-object', (data) => {
    if (!socket.username) { socket.emit('error', 'Not logged in'); return; }
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    if (Object.keys(map.objects).length >= MAX_MAP_OBJECTS) {
      socket.emit('error', `Object limit reached (${MAX_MAP_OBJECTS} per map)`);
      return;
    }
    const sanitized = sanitizeNewObject(data, socket.username);
    if (!sanitized.object) { socket.emit('error', sanitized.error || 'Invalid object'); return; }
    const id = crypto.randomUUID();
    // addedBy is server-stamped (never trusted from the client): the Instances
    // tab shows who actually spawned each token.
    const newObject = finalizeStructureObject({ ...sanitized.object, id, addedBy: socket.username });
    if (STRUCTURE_TYPES.has(newObject.type) && newObject.buildingId) {
      const grouped = Object.values(map.objects).filter(object =>
        STRUCTURE_TYPES.has(object.type) && object.buildingId === newObject.buildingId
      );
      const commonRise = structureLevelHeight(grouped[0] || newObject);
      for (const object of [...grouped, newObject]) {
        if (Math.abs(structureLevelHeight(object) - commonRise) > STRUCTURE_ALIGNMENT_TOLERANCE) {
          socket.emit('error', 'The active building has an inconsistent storey rise');
          return;
        }
        if (!structureStairRiseCompatible(object, commonRise)) {
          socket.emit('error', 'The active building has an inconsistent stair rise');
          return;
        }
        if (!structureRoofLevelCompatible(object)) {
          socket.emit('error', 'The active building has an inconsistent roof level');
          return;
        }
        if (!structureHeightModeCompatible(object)) {
          socket.emit('error', 'The active building has an invalid terrain-following storey');
          return;
        }
        if (!structureDatumCompatible(object, newObject.buildingDatumY)) {
          socket.emit('error', 'The active building has an inconsistent datum');
          return;
        }
      }
    }
    const previousCombat = snapshotField(map, 'combat');
    let combatChanged = false;
    map.objects[id] = newObject;
    // A character/token dropped onto a map with a combat joins the fight —
    // players place their own character and roll initiative themselves.
    const combat = map.combat;
    if (combat && !combat.combatants[id]) {
      const c = seedCombatant(newObject);
      if (c) {
        combat.combatants[c.id] = c;
        if (combat.started) combat.order.push(c.id); // end of round until initiative is rolled
        pushLog(key, combat, { kind: 'info', actorName: c.name, text: `${c.name} joins the fight` });
        combatChanged = true;
      }
    }
    if (!saveMaps()) {
      delete map.objects[id];
      if (combatChanged) restoreCombatField(map, previousCombat);
      socket.emit('error', 'Could not save the object');
      return;
    }
    if (combatChanged && !refreshHPRecoverySnapshots()) {
      delete map.objects[id];
      restoreCombatField(map, previousCombat);
      if (!restoreHPTransactionStorage()) {
        console.error('[OBJECT] Could not restore matched combat recovery data.');
      }
      socket.emit('error', 'Could not establish combat recovery data');
      return;
    }
    if (!isUnifiedKey(key)) {
      emitToRoom(key, null, recipient => {
        recipient.emit('object-added', projectObjectFor(recipient.username, newObject));
      });
    } else {
      // Fog of war: only players who can see the spot learn the object exists.
      emitToUnified(null, recipient => {
        if (objectVisibleTo(recipient.username, newObject)) {
          recipient.emit('object-added', projectObjectFor(recipient.username, newObject));
        }
      });
    }
    if (newObject.type === 'character') pushCharacterInstances();
    if (combatChanged) emitCombatState(key);
  });

  // Atomic whole-building operations. The client names a stable building and
  // supplies the exact source ids it observed; the server re-derives that set,
  // transforms every piece, persists once, then sends one canonical result.
  socket.on('structure-batch', (payload) => {
    const requestId = sanitizeStructureIdentity(payload && payload.requestId);
    const reject = (reason) => socket.emit('structure-batch-rejected', { requestId, reason });
    if (!isGM(socket.username)) { reject('GM only'); return; }
    if (!isRecord(payload) || serializedBytes(payload) > MAX_OBJECT_BYTES) {
      reject('Invalid or oversized building edit');
      return;
    }
    if (!requestId) { reject('Invalid request id'); return; }

    const action = payload.action;
    if (action !== 'adopt' && action !== 'duplicate-storey') {
      reject('Unknown building edit');
      return;
    }
    const buildingId = sanitizeStructureIdentity(payload.buildingId);
    const buildingDatumY = boundedNumber(
      payload.buildingDatumY, -WORLD_COORD_LIMIT, WORLD_COORD_LIMIT, null
    );
    if (!buildingId || buildingDatumY == null) {
      reject('Invalid building identity or datum');
      return;
    }

    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    const normalizedIds = (raw, label, { allowEmpty = false } = {}) => {
      if (!Array.isArray(raw) || raw.length > MAX_STRUCTURE_BATCH || (!allowEmpty && !raw.length)) {
        return { error: `${label} is invalid` };
      }
      const ids = raw.map(value => boundedText(value, 80));
      if (ids.some((id, index) => !id || id !== String(raw[index])) || new Set(ids).size !== ids.length) {
        return { error: `${label} contains invalid ids` };
      }
      return { ids: ids.sort() };
    };
    const emitApplied = (result, updatedObjects = new Map()) => {
      const send = (recipient) => {
        let created = result.created;
        let updated = result.updated;
        if (key === WORLD_KEY && !isGM(recipient.username)) {
          created = created.filter(object => objectVisibleTo(recipient.username, object));
          updated = updated.filter(entry => {
            const object = updatedObjects.get(entry.id) || ownValue(map.objects, entry.id);
            return object && objectVisibleTo(recipient.username, object);
          });
        }
        if (!created.length && !updated.length && recipient.id !== socket.id) return;
        recipient.emit('structure-batch-applied', {
          ...result,
          key: recipient.contextMapKey || recipient.currentMapKey || key,
          created,
          updated
        });
      };
      if (key === WORLD_KEY) emitToUnified(null, send);
      else emitToRoom(key, null, send);
    };

    if (action === 'adopt') {
      const normalized = normalizedIds(payload.objectIds, 'Object list');
      if (normalized.error) { reject(normalized.error); return; }
      const targets = [];
      for (const id of normalized.ids) {
        const object = ownValue(map.objects, id);
        if (!object || !STRUCTURE_TYPES.has(object.type)) {
          reject('Every adopted id must name a structure on the current map');
          return;
        }
        targets.push(object);
      }
      const grouped = Object.values(map.objects).filter(object =>
        STRUCTURE_TYPES.has(object.type) && object.buildingId === buildingId
      );
      const reference = grouped[0] || targets[0];
      const referenceRise = structureLevelHeight(reference);
      for (const object of grouped) {
        if (Math.abs(structureLevelHeight(object) - referenceRise) > STRUCTURE_ALIGNMENT_TOLERANCE) {
          reject('The active building has an inconsistent storey rise');
          return;
        }
        if (!structureStairRiseCompatible(object, referenceRise)) {
          reject('The active building has an inconsistent stair rise');
          return;
        }
        if (!structureRoofLevelCompatible(object)) {
          reject('The active building has an inconsistent roof level');
          return;
        }
        if (!structureHeightModeCompatible(object)) {
          reject('The active building has an invalid terrain-following storey');
          return;
        }
        if (!structureDatumCompatible(object, buildingDatumY)) {
          reject('The building datum changed; pick the building again');
          return;
        }
      }
      for (const object of targets) {
        if (Math.abs(structureLevelHeight(object) - referenceRise) > STRUCTURE_ALIGNMENT_TOLERANCE) {
          reject('The selected piece uses an incompatible storey rise');
          return;
        }
        if (!structureStairRiseCompatible(object, referenceRise)) {
          reject('The selected stair uses an incompatible rise');
          return;
        }
        if (!structureRoofLevelCompatible(object)) {
          reject('The selected roof covers an incompatible storey');
          return;
        }
        if (!structureHeightModeCompatible(object)) {
          reject('The selected piece uses an invalid terrain-following storey');
          return;
        }
        if (!structureDatumCompatible(object, buildingDatumY)) {
          reject('The selected piece uses an incompatible building datum');
          return;
        }
      }
      const previous = targets.map(object => ({
        object,
        buildingId: object.buildingId,
        buildingDatumY: object.buildingDatumY,
        structureId: object.structureId
      }));
      const updatedObjects = new Map();
      const updated = targets.map(object => {
        const patch = {
          buildingId,
          buildingDatumY,
          structureId: sanitizeStructureIdentity(object.structureId) || `structure-${crypto.randomUUID()}`
        };
        Object.assign(object, patch);
        updatedObjects.set(object.id, object);
        return { id: object.id, patch };
      });
      if (!saveMaps()) {
        for (const entry of previous) {
          for (const field of ['buildingId', 'buildingDatumY', 'structureId']) {
            if (entry[field] === undefined) delete entry.object[field];
            else entry.object[field] = entry[field];
          }
        }
        reject('Could not save the building edit');
        return;
      }
      emitApplied({ requestId, action, buildingId, created: [], updated, deleted: [] }, updatedObjects);
      return;
    }

    const sourceLevel = Math.round(Number(payload.sourceLevel));
    const destinationLevel = Math.round(Number(payload.destinationLevel));
    if (!Number.isFinite(sourceLevel) || !Number.isFinite(destinationLevel) ||
        sourceLevel < BUILD_LEVEL_MIN || sourceLevel > BUILD_LEVEL_MAX ||
        destinationLevel < BUILD_LEVEL_MIN || destinationLevel > BUILD_LEVEL_MAX ||
        sourceLevel === destinationLevel) {
      reject('Invalid source or destination storey');
      return;
    }
    const expectedSource = normalizedIds(payload.expectedSourceIds, 'Source storey');
    const expectedDestination = normalizedIds(
      payload.expectedDestinationIds || [], 'Destination storey', { allowEmpty: true }
    );
    if (expectedSource.error || expectedDestination.error) {
      reject(expectedSource.error || expectedDestination.error);
      return;
    }
    const sourceObjects = Object.values(map.objects).filter(object =>
      STRUCTURE_TYPES.has(object.type) && object.buildingId === buildingId &&
      structureStoreyLevel(object) === sourceLevel
    );
    const destinationObjects = Object.values(map.objects).filter(object =>
      STRUCTURE_TYPES.has(object.type) && object.buildingId === buildingId &&
      structureStoreyLevel(object) === destinationLevel
    );
    const actualSourceIds = sourceObjects.map(object => object.id).sort();
    const actualDestinationIds = destinationObjects.map(object => object.id).sort();
    if (JSON.stringify(actualSourceIds) !== JSON.stringify(expectedSource.ids)) {
      reject('The source storey changed; refresh and try again');
      return;
    }
    if (JSON.stringify(actualDestinationIds) !== JSON.stringify(expectedDestination.ids)) {
      reject('The destination storey changed; refresh and try again');
      return;
    }
    if (destinationObjects.length && payload.allowOccupiedDestination !== true) {
      reject('The destination storey is not empty');
      return;
    }
    if (!sourceObjects.length || sourceObjects.length > MAX_STRUCTURE_BATCH ||
        Object.keys(map.objects).length + sourceObjects.length > MAX_MAP_OBJECTS) {
      reject('The source storey is empty or too large to duplicate');
      return;
    }
    const groupedObjects = Object.values(map.objects).filter(object =>
      STRUCTURE_TYPES.has(object.type) && object.buildingId === buildingId
    );
    const commonRise = structureLevelHeight(sourceObjects[0]);
    for (const object of groupedObjects) {
      if (Math.abs(structureLevelHeight(object) - commonRise) > STRUCTURE_ALIGNMENT_TOLERANCE) {
        reject('The active building has an inconsistent storey rise');
        return;
      }
      if (!structureStairRiseCompatible(object, commonRise)) {
        reject('The active building has an inconsistent stair rise');
        return;
      }
      if (!structureRoofLevelCompatible(object)) {
        reject('The active building has an inconsistent roof level');
        return;
      }
      if (!structureHeightModeCompatible(object)) {
        reject('The active building has an invalid terrain-following storey');
        return;
      }
      if (!structureDatumCompatible(object, buildingDatumY)) {
        reject('The building datum changed; pick the building again');
        return;
      }
    }

    const created = [];
    for (const source of sourceObjects) {
      const rawClone = duplicateStructureToStorey(
        source, destinationLevel, buildingId, buildingDatumY
      );
      const sanitized = sanitizeNewObject(rawClone, socket.username);
      if (!sanitized.object) {
        reject(sanitized.error || 'A source piece could not be duplicated');
        return;
      }
      const id = crypto.randomUUID();
      created.push(finalizeStructureObject({
        ...sanitized.object,
        id,
        addedBy: socket.username
      }));
    }
    for (const object of created) map.objects[object.id] = object;
    if (!saveMaps()) {
      for (const object of created) delete map.objects[object.id];
      reject('Could not save the duplicated storey');
      return;
    }
    emitApplied({
      requestId,
      action,
      buildingId,
      sourceLevel,
      destinationLevel,
      created,
      updated: [],
      deleted: []
    });
  });

  // Player right-menu "Instances" tab: on-demand refresh of this user's placed
  // character tokens across all maps (GM: everyone's), with location + spawner.
  socket.on('get-character-instances', () => {
    if (!socket.username) return;
    socket.emit('character-instances', { instances: characterInstancesFor(socket.username) });
  });

  // Remove a character token from the Instances tab. Unlike delete-object,
  // this accepts the token's map key so it can remove a token without first
  // navigating to that map. Players may remove only their own tokens; the GM
  // may remove any character token.
  socket.on('delete-character-instance', (payload) => {
    if (!socket.username || !payload || !payload.id) return;
    const requestedKey = knownMapKey(payload.mapKey != null ? payload.mapKey : (socket.currentMapKey || DEFAULT_MAP_KEY));
    if (!requestedKey) return;
    const key = stateKey(requestedKey);
    const map = maps[key];
    if (!map) return;
    const id = boundedText(payload.id, 80);
    const obj = ownValue(map.objects, id);
    if (!obj || obj.type !== 'character' || (!isGM(socket.username) && !ownsObject(socket.username, obj))) {
      return;
    }
    const previousCombat = snapshotField(map, 'combat');
    let combatChanged = false;
    delete map.objects[id];
    // A deleted token leaves the fight too.
    if (map.combat && hasOwn(map.combat.combatants, id)) {
      const name = map.combat.combatants[id].name;
      removeCombatant(key, map.combat, id);
      pushLog(key, map.combat, { kind: 'info', actorName: name, text: `${name} was removed from the map` });
      combatChanged = true;
    }
    if (!saveMaps()) {
      map.objects[id] = obj;
      if (combatChanged) restoreCombatField(map, previousCombat);
      socket.emit('error', 'Could not save the character-instance deletion');
      return;
    }
    if (combatChanged && !refreshHPRecoverySnapshots()) {
      map.objects[id] = obj;
      restoreCombatField(map, previousCombat);
      if (!restoreHPTransactionStorage()) {
        console.error('[OBJECT] Could not restore matched combat recovery data.');
      }
      socket.emit('error', 'Could not establish combat recovery data');
      return;
    }
    const event = { id };
    if (isUnifiedKey(key)) emitToUnified(null, (sock) => sock.emit('object-deleted', event));
    else io.to(key).emit('object-deleted', event);
    pushCharacterInstances();
    if (combatChanged) emitCombatState(key);
  });

  // Context-inspector presentation edits plus the build tool's bounded,
  // per-cell wall-opening and floor/roof tile geometry patches.
  socket.on('update-object', (payload) => {
    if (!isGM(socket.username)) return;
    if (!isRecord(payload) || serializedBytes(payload) > MAX_OBJECT_BYTES) return;
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    const id = boundedText(payload.id, 80);
    const obj = id && ownValue(map.objects, id);
    if (!obj) return;
    const requested = payload.patch || {};
    const patch = {};
    if (requested.name != null) {
      const name = String(requested.name).trim().slice(0, 40);
      if (name) patch.name = name;
    }
    if (requested.color != null) {
      const raw = requested.color;
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        patch.color = Math.max(0, Math.min(0xffffff, Math.round(raw)));
      } else if (/^#[0-9a-f]{6}$/i.test(String(raw))) {
        patch.color = String(raw);
      }
    }
    if (obj.type === 'wall' && Array.isArray(requested.segments)) {
      const count = wallCellCount(obj);
      if (count) {
        patch.segments = Array.from({ length: count }, (_, i) =>
          WALL_SEGMENT_KINDS.has(requested.segments[i]) ? requested.segments[i] : null);
      }
    }
    if ((obj.type === 'floor' || obj.type === 'roof') && Array.isArray(requested.tiles)) {
      patch.tiles = sanitizeStructureTiles(obj, requested.tiles);
    }
    if (!Object.keys(patch).length) return;
    const previousObject = structuredClone(obj);
    const combatant = map.combat && ownValue(map.combat.combatants, obj.id);
    const previousCombat = combatant ? snapshotField(map, 'combat') : null;
    Object.assign(obj, patch);
    if (combatant) {
      if (patch.name != null) combatant.name = patch.name;
      if (patch.color != null) combatant.color = patch.color;
    }
    if (!saveMaps()) {
      map.objects[id] = previousObject;
      if (previousCombat) restoreCombatField(map, previousCombat);
      socket.emit('error', 'Could not save the object update');
      return;
    }
    if (combatant && !refreshHPRecoverySnapshots()) {
      map.objects[id] = previousObject;
      restoreCombatField(map, previousCombat);
      if (!restoreHPTransactionStorage()) {
        console.error('[OBJECT] Could not restore matched combat recovery data.');
      }
      socket.emit('error', 'Could not establish combat recovery data');
      return;
    }
    const event = { id: obj.id, patch };
    if (isUnifiedKey(key)) {
      emitToUnified(null, (sock) => {
        if (objectVisibleTo(sock.username, obj)) sock.emit('object-updated', event);
      });
    } else {
      io.to(key).emit('object-updated', event);
    }
    if (combatant) emitCombatState(key);
  });

  socket.on('move-object', (data) => {
    if (!socket.username || !isRecord(data)) return;
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    const id = boundedText(data.id, 80);
    const position = sanitizePosition(data.position);
    const controlledObject = id && ownValue(map.objects, id);
    if (!id || !position || !controlledObject) return;
    const event = { id, position };
    // Players manipulate only their own character instances. The GM remains
    // authoritative for generic tokens, creatures, props and structures.
    if (!isGM(socket.username) && !ownsObject(socket.username, controlledObject)) {
      // Correct a visible object's optimistic client move, but do not disclose
      // the current position of an object that fog has removed from this player.
      if (!isUnifiedKey(key) || objectVisibleTo(socket.username, controlledObject)) {
        socket.emit('object-moved', { id, position: controlledObject.position });
      }
      socket.emit('combat-denied', { reason: 'You can only move your own character' });
      return;
    }
    if (STRUCTURE_TYPES.has(controlledObject.type) && controlledObject.buildingId) {
      const movedStructure = { ...controlledObject, position };
      const currentY = Number(controlledObject.position && controlledObject.position.y) || 0;
      const movedVertically = Math.abs(position.y - currentY) > STRUCTURE_ALIGNMENT_TOLERANCE;
      if (movedVertically || !structureDatumCompatible(movedStructure, controlledObject.buildingDatumY)) {
        socket.emit('object-moved', { id, position: controlledObject.position });
        socket.emit('error', 'Grouped structures must stay aligned to their building storeys');
        return;
      }
    }
    const previousObject = structuredClone(controlledObject);
    const previousCombat = snapshotField(map, 'combat');
    // In a started combat, combatant tokens move only on their turn, only by
    // their owner (GM excepted), and only within the turn's movement budget.
    const combat = map.combat;
    const c = combat && combat.started && ownValue(combat.combatants, id);
    if (c) {
      const old = sanitizePosition(controlledObject.position) || { x: 0, y: 0, z: 0 };
      const gm = isGM(socket.username);
      const isTheirTurn = combat.activeId === id && c.owner === socket.username;
      if (!gm && (!isTheirTurn || hasEffect(c, 'down'))) {
        socket.emit('object-moved', { id, position: old });
        socket.emit('combat-denied', { reason: hasEffect(c, 'down') ? `${c.name} is down` : "Not this token's turn" });
        return;
      }
      if (combat.activeId === id) {
        // XZ euclidean, matching the ruler: 1 world unit = 1 cell = 5 ft.
        const feet = Math.hypot(position.x - old.x, position.z - old.z) * 5;
        const remaining = c.speedFeet + c.dashFeet - c.movementUsedFeet;
        if (!gm && feet > remaining + 0.5) {
          socket.emit('object-moved', { id, position: old });
          socket.emit('combat-denied', { reason: `Too far: ${Math.round(feet)} ft (${Math.max(0, Math.round(remaining))} ft left)` });
          return;
        }
        c.movementUsedFeet += feet;
      }
    }
    const obj = controlledObject;
    const oldPos = { ...(obj.position || {}) };
    obj.position = position;
    if (!saveMaps()) {
      map.objects[id] = previousObject;
      restoreCombatField(map, previousCombat);
      socket.emit('object-moved', { id, position: oldPos });
      socket.emit('error', 'Could not save the object move');
      return;
    }
    if (c && !refreshHPRecoverySnapshots()) {
      map.objects[id] = previousObject;
      restoreCombatField(map, previousCombat);
      if (!restoreHPTransactionStorage()) {
        console.error('[OBJECT] Could not restore matched combat recovery data.');
      }
      socket.emit('object-moved', { id, position: oldPos });
      socket.emit('error', 'Could not establish combat recovery data');
      return;
    }
    if (!isUnifiedKey(key)) {
      socket.to(key).emit('object-moved', event);
    } else {
      // Fog of war: an object crossing the reveal boundary pops into (full
      // object) or out of (delete) existence for players — hidden objects
      // simply don't exist on their side.
      emitToUnified(socket, (sock) => {
        if (isGM(sock.username) || ownsObject(sock.username, obj)) {
          sock.emit('object-moved', event);
          return;
        }
        const was = isRevealedAt(oldPos.x, oldPos.z);
        const now = isRevealedAt(obj.position && obj.position.x, obj.position && obj.position.z);
        if (was && now) sock.emit('object-moved', event);
        else if (!was && now) sock.emit('object-added', projectObjectFor(sock.username, obj));
        else if (was && !now) sock.emit('object-deleted', { id: obj.id });
      });
    }
    // Moves are click-to-drop (not per-frame drags), so a live location
    // refresh for the Instances tab is cheap.
    if (obj.type === 'character') pushCharacterInstances();
    if (c) emitCombatState(key);
  });

  socket.on('delete-object', (data) => {
    if (!socket.username) return;
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    const id = data && data.id ? boundedText(data.id, 80) : '';
    const obj = id ? ownValue(map.objects, id) : null;
    if (obj && (isGM(socket.username) || ownsObject(socket.username, obj))) {
      const wasCharacter = obj.type === 'character';
      const previousCombat = snapshotField(map, 'combat');
      let combatChanged = false;
      delete map.objects[id];
      // A deleted token leaves the fight too.
      if (map.combat && hasOwn(map.combat.combatants, id)) {
        const name = map.combat.combatants[id].name;
        removeCombatant(key, map.combat, id);
        pushLog(key, map.combat, { kind: 'info', actorName: name, text: `${name} was removed from the map` });
        combatChanged = true;
      }
      if (!saveMaps()) {
        map.objects[id] = obj;
        if (combatChanged) restoreCombatField(map, previousCombat);
        socket.emit('error', 'Could not save the object deletion');
        return;
      }
      if (combatChanged && !refreshHPRecoverySnapshots()) {
        map.objects[id] = obj;
        restoreCombatField(map, previousCombat);
        if (!restoreHPTransactionStorage()) {
          console.error('[OBJECT] Could not restore matched combat recovery data.');
        }
        socket.emit('error', 'Could not establish combat recovery data');
        return;
      }
      const event = { id };
      if (isUnifiedKey(key)) emitToUnified(null, (sock) => sock.emit('object-deleted', event));
      else io.to(key).emit('object-deleted', event);
      if (wasCharacter) pushCharacterInstances();
      if (combatChanged) emitCombatState(key);
    }
  });

  // --- Combat handlers. All act on the current room's combat; failed checks
  // answer only the offending socket with combat-denied (never 'error': the
  // player client routes that to the login modal). ---
  function combatDeny(reason) { socket.emit('combat-denied', { reason }); }
  function persistCombat(key, previousCombat, stagedCharacterHP = []) {
    const map = getMap(key);
    const { finalStages, touchedCombats } = stageCharacterCombatMirrors(
      stagedCharacterHP,
      new Map([[key, { key, map, previousCombat }]])
    );
    const restoreTransaction = () => {
      for (let i = stagedCharacterHP.length - 1; i >= 0; i--) {
        restoreCharacterHP(stagedCharacterHP[i]);
      }
      for (const touched of touchedCombats) {
        restoreCombatField(touched.map, touched.previousCombat);
      }
    };
    if (stagedCharacterHP.length && !saveJSON('characters.json', charactersDB)) {
      restoreTransaction();
      combatDeny('Could not save the character HP update');
      return false;
    }
    if (saveMaps()) {
      if (!refreshHPRecoverySnapshots()) {
        restoreTransaction();
        if (!restoreHPTransactionStorage()) {
          console.error('[COMBAT] Could not restore a matched recovery snapshot.');
        }
        combatDeny('Could not establish combat recovery data');
        return false;
      }
      for (const stage of finalStages) emitCharacterHP(stage);
      for (const touched of touchedCombats) emitCombatState(touched.key);
      return true;
    }
    restoreTransaction();
    if (stagedCharacterHP.length) {
      if (!rewriteJSONPrimary('characters.json', charactersDB)) {
        console.error('[COMBAT] Could not compensate character HP after a failed map save.');
      }
    }
    combatDeny('Could not save the combat update');
    return false;
  }
  function canControl(c) { return isGM(socket.username) || (!!c.owner && c.owner === socket.username); }
  const clampInt = (v, min, max, dflt) => {
    v = Number(v);
    return isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : dflt;
  };

  socket.on('combat-start', () => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    if (map.combat) return combatDeny('Combat already running');
    const previousCombat = snapshotField(map, 'combat');
    const combat = map.combat = {
      active: true, started: false, round: 0, activeId: null,
      order: [], combatants: {}, log: []
    };
    for (const obj of Object.values(getMap(stateKey(key)).objects)) {
      const c = seedCombatant(obj);
      if (c) combat.combatants[c.id] = c;
    }
    pushLog(key, combat, { kind: 'info', actorName: 'GM', text: 'Combat! Roll initiative.' });
    persistCombat(key, previousCombat);
  });

  socket.on('combat-end', () => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const map = getMap(key);
    if (!map.combat) return;
    const previousCombat = snapshotField(map, 'combat');
    delete map.combat;
    persistCombat(key, previousCombat); // emits null → clients tear down
  });

  // Owning client (or GM) answers a character's statsPending with SRD-derived
  // numbers. Strictly first write wins — later edits go through
  // combat-update-combatant. (Accepting repeats would echo forever: every
  // broadcast triggers the clients' auto-fill pass again.)
  socket.on('combat-set-stats', (payload) => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && payload && ownValue(combat.combatants, payload.combatantId);
    if (!c || !canControl(c)) return;
    if (!c.statsPending) return;
    const previousCombat = snapshotField(getMap(key), 'combat');
    c.ac = clampInt(payload.ac, 1, 30, c.ac);
    c.speedFeet = clampInt(payload.speedFeet, 0, 120, c.speedFeet);
    c.initMod = clampInt(payload.initMod, -10, 20, c.initMod);
    c.maxHP = clampInt(payload.maxHP, 1, 999, c.maxHP);
    if (Array.isArray(payload.attacks)) {
      c.attacks = payload.attacks.slice(0, 8).map(a => {
        const attack = {
          name: String((a && a.name) || 'Attack').slice(0, 30),
          attack: clampInt(a && a.attack, -10, 30, 0),
          damage: String((a && a.damage) || '1').slice(0, 20),
          damageType: String((a && a.damageType) || '').slice(0, 20),
          ranged: !!(a && a.ranged),
          rangeFt: clampInt(a && a.rangeFt, 5, 600, 5)
        };
        const parts = (Array.isArray(a && a.damageParts) ? a.damageParts : [])
          .slice(0, 4).map(part => ({
            damage: String((part && part.damage) || '1').slice(0, 20),
            damageType: String((part && part.damageType) || '').slice(0, 20)
          }));
        if (parts.length > 1) attack.damageParts = parts;
        return attack;
      });
    }
    const ABILS = ['str','dex','con','int','wis','cha'];
    c.saves = {};
    for (const a of ABILS) c.saves[a] = clampInt(payload.saves && payload.saves[a], -20, 30, 0);
    c.spellAtk = clampInt(payload.spellAtk, -10, 30, 0);
    c.spellDC  = clampInt(payload.spellDC, 1, 40, 8);
    c.slots = {};
    for (let l = 1; l <= 9; l++) c.slots[l] = clampInt(payload.slots && payload.slots[l], 0, 20, 0);
    if (Array.isArray(payload.spells)) {
      c.spells = payload.spells.slice(0, 20).map((s, i) => {
        const base = {
          name: String((s && s.name) || 'Spell').slice(0, 40),
          level: clampInt(s && s.level, 0, 9, 0),
          damage: String((s && s.damage) || '1d4').slice(0, 20),
          damageType: String((s && s.damageType) || '').slice(0, 20),
          spellIndex: i
        };
        if (s && s.saveAbility) return { ...base, saveAbility: ABILS.includes(s.saveAbility) ? s.saveAbility : 'dex', saveSuccess: s.saveSuccess === 'none' ? 'none' : 'half' };
        return { ...base, attackType: (s && s.attackType === 'melee') ? 'melee' : 'ranged' };
      });
    }
    if (!c.hp) c.hp = { current: c.maxHP };
    c.statsPending = false;
    persistCombat(key, previousCombat);
  });

  socket.on('combat-roll-initiative', (payload) => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && payload && ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    if (!canControl(c)) return combatDeny('Not your combatant');
    if (c.initiative != null && !isGM(socket.username)) return combatDeny('Initiative already rolled');
    const previousCombat = snapshotField(getMap(key), 'combat');
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
    persistCombat(key, previousCombat);
  });

  socket.on('combat-begin', () => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    if (!combat || combat.started) return;
    if (!Object.keys(combat.combatants).length) return combatDeny('No combatants');
    const previousCombat = snapshotField(getMap(key), 'combat');
    beginCombat(key, combat);
    persistCombat(key, previousCombat);
  });

  socket.on('combat-action', (payload) => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    if (!combat || !combat.started || !payload) return;
    const c = ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    if (!canControl(c)) return combatDeny('Not your combatant');
    if (combat.activeId !== c.id) return combatDeny("Not this combatant's turn");
    if (c.actionUsed) return combatDeny('Action already used this turn');
    if (hasEffect(c, 'down')) return combatDeny(`${c.name} is down`);
    const previousCombat = snapshotField(getMap(key), 'combat');
    const stagedCharacterHP = [];
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
      const target = ownValue(combat.combatants, payload.targetId);
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
        const damageParts = Array.isArray(atk.damageParts) && atk.damageParts.length > 1
          ? atk.damageParts
          : [{ damage: atk.damage, damageType: atk.damageType }];
        const rolledParts = damageParts.map(part => ({
          ...rollDamage(part.damage, crit),
          damageType: boundedString(part.damageType, 20)
        }));
        const damageTotal = rolledParts.reduce((sum, part) => sum + part.total, 0);
        entry.dmg = rolledParts.length === 1
          ? rolledParts[0]
          : {
              expr: rolledParts.map(part => part.expr).join(' + '),
              rolls: rolledParts.flatMap(part => part.rolls),
              total: damageTotal,
              parts: rolledParts
            };
        const damageText = rolledParts.map(part =>
          `${part.expr} → ${part.total}${part.damageType ? ' ' + part.damageType : ''}`
        ).join(' + ');
        text += ` · ${damageText}${crit ? ' (crit ×2 dice)' : ''}`;
        if (rolledParts.length > 1) text += ` · ${damageTotal} total`;
        const next = applyDamageToTarget(target, damageTotal, stagedCharacterHP);
        if (next === 0) text += ` — ${target.name} drops to 0 HP!`;
      }
      entry.text = text;
      pushLog(key, combat, entry);
    } else if (kind === 'cast') {
      const spell = c.spells && c.spells[clampInt(payload.spellIndex, 0, 19, -1)];
      if (!spell) return combatDeny('No such spell');
      const target = ownValue(combat.combatants, payload.targetId);
      if (!target) return combatDeny('No such target');
      if (target.id === c.id) return combatDeny("Can't target yourself");
      if (hasEffect(target, 'down')) return combatDeny(`${target.name} is down`);
      if (spell.level > 0) {
        if (!c.slots || (c.slots[spell.level] || 0) < 1) return combatDeny(`No level ${spell.level} spell slots left`);
        c.slots[spell.level] -= 1; // a miss still spends the slot (5e)
      }
      if (spell.attackType) { // attack-roll spell (spellAtk vs AC)
        const disadvantage = hasEffect(target, 'dodging');
        const d20 = [rollDie(20)]; if (disadvantage) d20.push(rollDie(20));
        const used = disadvantage ? Math.min(d20[0], d20[1]) : d20[0];
        const crit = used === 20;
        const total = used + c.spellAtk;
        const hit = used !== 1 && (crit || total >= target.ac);
        const dieTxt = disadvantage ? `[${d20.join(', ')}] → ${used}` : `${used}`;
        let text = `${c.name} casts ${spell.name} at ${target.name}: d20 ${dieTxt} ${fmtSigned(c.spellAtk)} = ${total} vs AC ${target.ac} — ${crit ? 'CRIT!' : hit ? 'HIT' : 'MISS'}`;
        const entry = { kind: 'cast', actorName: c.name, targetName: target.name, spellName: spell.name, roll: { d20, used, mod: c.spellAtk, total, vs: target.ac, hit, crit, disadvantage } };
        if (hit) {
          const dmg = rollDamage(spell.damage, crit);
          entry.dmg = dmg;
          text += ` · ${dmg.expr}${crit ? ' (crit ×2 dice)' : ''} → ${dmg.total}${spell.damageType ? ' ' + spell.damageType : ''}`;
          const next = applyDamageToTarget(target, dmg.total, stagedCharacterHP);
          if (next === 0) text += ` — ${target.name} drops to 0 HP!`;
        }
        entry.text = text; pushLog(key, combat, entry);
      } else { // save-for-half/none spell
        const save = rollSave(target, spell.saveAbility, c.spellDC);
        const raw = rollDamage(spell.damage, false);
        const dealt = save.success ? (spell.saveSuccess === 'half' ? Math.floor(raw.total / 2) : 0) : raw.total;
        let text = `${c.name} casts ${spell.name} at ${target.name} (DC ${c.spellDC} ${spell.saveAbility.toUpperCase()}): ${target.name} d20 ${save.used} ${fmtSigned(save.mod)} = ${save.total} — ${save.success ? 'SAVE' : 'FAIL'} · ${raw.expr} → ${dealt}${spell.damageType ? ' ' + spell.damageType : ''}${save.success && spell.saveSuccess === 'half' ? ' (half)' : ''}`;
        const entry = { kind: 'cast', actorName: c.name, targetName: target.name, spellName: spell.name, save: { d20: save.d20, used: save.used, mod: save.mod, total: save.total, vs: save.vs, ability: spell.saveAbility, success: save.success }, dmg: { expr: raw.expr, rolls: raw.rolls, total: dealt } };
        const next = applyDamageToTarget(target, dealt, stagedCharacterHP);
        if (next === 0) text += ` — ${target.name} drops to 0 HP!`;
        entry.text = text; pushLog(key, combat, entry);
      }
    } else {
      return;
    }
    c.actionUsed = true;
    persistCombat(key, previousCombat, stagedCharacterHP);
  });

  socket.on('combat-end-turn', () => {
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    if (!combat || !combat.started) return;
    const active = combat.activeId && ownValue(combat.combatants, combat.activeId);
    if (!isGM(socket.username) && !(active && active.owner === socket.username)) return combatDeny('Not your turn');
    const previousCombat = snapshotField(getMap(key), 'combat');
    advanceTurn(key, combat);
    persistCombat(key, previousCombat);
  });

  socket.on('combat-set-turn', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && combat.started && payload && ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    const previousCombat = snapshotField(getMap(key), 'combat');
    startTurn(key, combat, c.id);
    persistCombat(key, previousCombat);
  });

  socket.on('combat-update-combatant', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && payload && ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    const previousCombat = snapshotField(getMap(key), 'combat');
    const stagedCharacterHP = [];
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
      if (c.kind === 'character' && c.charId && hasOwn(charactersDB, c.charId)) {
        const stage = stageCharacterHP(c.charId, v);
        if (stage) {
          stagedCharacterHP.push(stage);
          setCombatantHP(c, stage.current);
        }
      } else {
        setCombatantHP(c, v);
      }
    }
    c.statsPending = false;
    persistCombat(key, previousCombat, stagedCharacterHP);
  });

  socket.on('combat-set-order', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    if (!combat || !payload || !Array.isArray(payload.order)) return;
    const cur = [...combat.order].sort().join('\0');
    const req = payload.order.map(String).sort().join('\0');
    if (cur !== req) return; // must be a permutation of the current order
    const previousCombat = snapshotField(getMap(key), 'combat');
    combat.order = payload.order.map(String);
    persistCombat(key, previousCombat);
  });

  socket.on('combat-remove-combatant', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && payload && ownValue(combat.combatants, payload.combatantId);
    if (!c) return;
    const previousCombat = snapshotField(getMap(key), 'combat');
    removeCombatant(key, combat, c.id);
    pushLog(key, combat, { kind: 'info', actorName: c.name, text: `${c.name} leaves the fight` });
    persistCombat(key, previousCombat);
  });

  socket.on('combat-add-combatant', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const map = getMap(key);
    const obj = combat && payload && ownValue(getMap(stateKey(key)).objects, payload.objectId);
    if (!obj || hasOwn(combat.combatants, obj.id)) return;
    const c = seedCombatant(obj);
    if (!c) return combatDeny('Only tokens and characters can fight');
    const previousCombat = snapshotField(map, 'combat');
    combat.combatants[c.id] = c;
    if (combat.started) combat.order.push(c.id); // end of round until initiative is rolled
    pushLog(key, combat, { kind: 'info', actorName: c.name, text: `${c.name} joins the fight` });
    persistCombat(key, previousCombat);
  });

  socket.on('combat-effect', (payload) => {
    if (!isGM(socket.username)) return combatDeny('GM only');
    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const combat = getCombat(key);
    const c = combat && payload && ownValue(combat.combatants, payload.combatantId);
    const effKey = payload && String(payload.key || '');
    if (!c || !CONDITION_LABELS[effKey]) return;
    const previousCombat = snapshotField(getMap(key), 'combat');
    if (payload.add) addEffect(c, effKey, false);
    else removeEffect(c, effKey);
    persistCombat(key, previousCombat);
  });

  socket.on('add-ruler', (data) => {
    if (!socket.username || !isRecord(data) || !Array.isArray(data.points)) return;
    if (data.points.length < 2 || data.points.length > MAX_RULER_POINTS || serializedBytes(data) > 64 * 1024) return;
    const points = data.points.map(sanitizePosition);
    if (points.some(point => !point)) return;
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = ownValue(maps, key) || (isGM(socket.username) ? getMap(key) : null);
    if (!map) return;
    if (Object.keys(map.rulers).length >= MAX_RULERS) return;
    const id = crypto.randomUUID();
    const newRuler = {
      id,
      points,
      mode: data.mode === 'curved' ? 'curved' : 'straight',
      color: Math.round(boundedNumber(data.color, 0, 0xffffff, 0x00ffff))
    };
    map.rulers[id] = newRuler;
    if (!saveMaps()) {
      delete map.rulers[id];
      socket.emit('error', 'Could not save the ruler');
      return;
    }
    io.to(key).emit('ruler-added', newRuler);
  });

  socket.on('clear-rulers', () => {
    if (!socket.username) return;
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = ownValue(maps, key) || (isGM(socket.username) ? getMap(key) : null);
    if (!map) return;
    const previousRulers = snapshotField(map, 'rulers');
    map.rulers = {};
    if (!saveMaps()) {
      restoreField(map, 'rulers', previousRulers);
      socket.emit('error', 'Could not clear the rulers');
      return;
    }
    io.to(key).emit('rulers-cleared');
  });

  // Terrain edits (GM-authored), chunked format v2:
  //   { chunks?: { "cx,cz": { heights?, splat? } | null }, water?, clear? }
  // heights/splat are opaque base64 strings here — only the clients en/decode
  // them. null deletes a chunk; clear wipes all chunks (GM reset). Legacy v1
  // stored terrain ({res:128, heights, splat}) is replaced wholesale the first
  // time a GM client sends v2 chunks (the client migrates and re-uploads).
  const CHUNK_KEY_RE = /^-?\d+,-?\d+$/;

  // Reset is a distinct, server-authoritative transaction. In the unified
  // world the server derives the province from socket.contextMapKey, removes
  // its chunks and intersecting water together, persists exactly once, and
  // only then publishes the canonical result. Pocket clears use the same
  // request/ack path, so the requesting GM never has to optimistically clear a
  // local half of the state while another save is still outstanding.
  socket.on('reset-terrain', (payload) => {
    const requestId = sanitizeStructureIdentity(payload && payload.requestId);
    const reject = (reason) => socket.emit('terrain-reset-rejected', { requestId, reason });
    if (!isGM(socket.username)) { reject('GM only'); return; }
    if (!isRecord(payload) || serializedBytes(payload) > 1024 || !requestId) {
      reject('Invalid terrain reset request');
      return;
    }

    const key = stateKey(socket.currentMapKey || DEFAULT_MAP_KEY);
    const contextKey = socket.contextMapKey || socket.currentMapKey || DEFAULT_MAP_KEY;
    const map = getMap(key);
    const previousTerrain = snapshotField(map, 'terrain');
    let result;

    if (key === WORLD_KEY) {
      if (!isTacticalPath(contextKey)) {
        reject('Enter a tactical province before resetting regional terrain');
        return;
      }
      const terrain = map.terrain;
      if (!isRecord(terrain) || terrain.format !== 2 || !isRecord(terrain.chunks) ||
          !isRecord(terrain.water) || !Array.isArray(terrain.water.bodies)) {
        reject('Terrain must finish migrating before a regional reset');
        return;
      }

      const chunks = {};
      for (const chunkKey of Object.keys(terrain.chunks)) {
        if (!CHUNK_KEY_RE.test(chunkKey)) continue;
        const [cx, cz] = chunkKey.split(',').map(Number);
        if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz)) continue;
        if (!pointInsideProvince(
          contextKey,
          (cx + 0.5) * CHUNK_CELLS,
          (cz + 0.5) * CHUNK_CELLS
        )) continue;
        delete terrain.chunks[chunkKey];
        chunks[chunkKey] = null;
      }
      terrain.water = {
        bodies: terrain.water.bodies.filter(body => !waterBodyTouchesProvince(body, contextKey))
      };
      result = {
        requestId,
        scope: 'province',
        contextKey,
        chunks,
        water: cloneJSON(terrain.water)
      };
    } else {
      const previous = isRecord(map.terrain) ? map.terrain : null;
      if (previous && previous.format === 2) {
        previous.chunks = {};
        previous.water = { bodies: [] };
      } else {
        map.terrain = {
          format: 2,
          chunkCells: CHUNK_CELLS,
          vertexSpacing: 0.5,
          water: { bodies: [] },
          chunks: {}
        };
      }
      // The canonical clear flag makes every client discard its local copy
      // even when the map previously had no persisted terrain.
      result = {
        requestId,
        scope: 'map',
        contextKey,
        clear: true,
        water: { bodies: [] }
      };
    }

    if (!saveMaps()) {
      restoreField(map, 'terrain', previousTerrain);
      reject('Could not save the terrain reset');
      return;
    }

    if (key !== WORLD_KEY) {
      io.to(key).emit('terrain-reset-applied', result);
      return;
    }
    emitToUnified(null, (recipient) => {
      if (isGM(recipient.username)) {
        recipient.emit('terrain-reset-applied', result);
        return;
      }
      const filtered = { ...result, chunks: {} };
      for (const chunkKey of Object.keys(result.chunks)) {
        if (worldFog()[chunkFogHexKey(chunkKey)]) filtered.chunks[chunkKey] = null;
      }
      recipient.emit('terrain-reset-applied', filtered);
    });
  });

  socket.on('update-terrain', (data) => {
    if (!isGM(socket.username)) { socket.emit('error', 'GM only'); return; }
    if (!isRecord(data) || serializedBytes(data) > MAX_TERRAIN_UPDATE_BYTES) return;
    const key = socket.currentMapKey || DEFAULT_MAP_KEY;
    const accepted = {};
    if (data.clear) {
      if (key === WORLD_KEY) {
        socket.emit('error', 'Reset the current province from the latest GM client');
        return;
      }
      accepted.clear = true;
    }
    if (isRecord(data.chunks)) {
      const chunks = {};
      for (const k of Object.keys(data.chunks).slice(0, MAX_TERRAIN_CHUNKS_PER_UPDATE)) {
        if (!CHUNK_KEY_RE.test(k) || k.length > 40) continue;
        const [cx, cz] = k.split(',').map(Number);
        if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz) ||
            Math.abs(cx) > 3125000 || Math.abs(cz) > 3125000) continue;
        const value = data.chunks[k];
        if (value === null) { chunks[k] = null; continue; }
        if (!isRecord(value)) continue;
        const chunk = {};
        if (validBase64Layer(value.heights)) chunk.heights = value.heights;
        if (validBase64Layer(value.splat)) chunk.splat = value.splat;
        if (Object.keys(chunk).length) chunks[k] = chunk;
      }
      if (Object.keys(chunks).length) accepted.chunks = chunks;
    }
    if (data.water != null) {
      const water = sanitizeWaterData(data.water);
      if (water) accepted.water = water;
    }
    if (!Object.keys(accepted).length) return;
    const map = getMap(key);
    const previousTerrain = snapshotField(map, 'terrain');
    let t = map.terrain;
    if (!t || t.format !== 2) {
      t = map.terrain = {
        format: 2, chunkCells: 32, vertexSpacing: 0.5,
        water: (t && t.water) ? t.water : { bodies: [] },
        chunks: {}
      };
    }
    if (accepted.clear) t.chunks = {};
    if (accepted.chunks) {
      for (const k of Object.keys(accepted.chunks)) {
        const v = accepted.chunks[k];
        if (v === null) { delete t.chunks[k]; continue; }
        const c = t.chunks[k] || (t.chunks[k] = {});
        if (typeof v.heights === 'string') c.heights = v.heights;
        if (typeof v.splat === 'string') c.splat = v.splat;
      }
    }
    if (accepted.water) {
      if (Array.isArray(accepted.water.bodies)) {
        // Water v2: authored bodies (lakes/rivers); footprints are computed
        // client-side from the terrain, so this stays small and opaque.
        t.water = accepted.water;
      } else {
        // Legacy global sheet (old clients); new clients migrate it on load.
        t.water = accepted.water;
      }
    }
    if (!saveMaps()) {
      restoreField(map, 'terrain', previousTerrain);
      socket.emit('error', 'Could not save the terrain update');
      return;
    }
    if (!isUnifiedKey(key)) {
      socket.to(key).emit('terrain-updated', accepted);
      return;
    }
    // Fog of war: players only receive chunk edits inside revealed hexes.
    emitToRoom(key, socket, (sock) => {
      if (isGM(sock.username)) { sock.emit('terrain-updated', accepted); return; }
      const out = { ...accepted };
      if (out.chunks) {
        const chunks = {};
        for (const k of Object.keys(out.chunks)) {
          if (CHUNK_KEY_RE.test(k) && worldFog()[chunkFogHexKey(k)]) chunks[k] = out.chunks[k];
        }
        if (Object.keys(chunks).length) out.chunks = chunks;
        else delete out.chunks;
      }
      if (out.chunks || out.water || out.clear) sock.emit('terrain-updated', out);
    });
  });

  // --- Fog of war (U4): the GM reveals/hides fog hexes; players get the mask
  // plus the content that just became visible (or lose what was hidden).
  const FOG_HEX_RE = /^-?\d+,-?\d+$/;
  socket.on('update-fog', (payload) => {
    if (!isGM(socket.username)) return;
    if (!payload || !Array.isArray(payload.hexes)) return;
    const revealed = !!payload.revealed;
    const world = ensureWorld();
    const previousFog = snapshotField(world, 'fog');
    const fog = worldFog();
    const changed = [];
    for (const raw of payload.hexes.slice(0, 1024)) {
      const hk = String(raw);
      if (!FOG_HEX_RE.test(hk)) continue;
      const [q, r] = hk.split(',').map(Number);
      if (Math.abs(q) > 20000 || Math.abs(r) > 20000) continue;
      if (!!fog[hk] === revealed) continue;
      if (revealed) fog[hk] = 1;
      else delete fog[hk];
      changed.push(hk);
    }
    if (!changed.length) {
      if (!previousFog.existed) delete world.fog;
      return;
    }
    if (!saveMaps()) {
      restoreField(world, 'fog', previousFog);
      socket.emit('error', 'Could not save the fog update');
      return;
    }
    // Global broadcast (like hex-updated): every client rendering the unified
    // world keeps the mask, whichever room it currently sits in.
    io.emit('fog-updated', { hexes: changed, revealed });
    // Content delta for players in unified rooms: what the toggle uncovered
    // (full objects + terrain chunks) or swallowed (object deletes; the client
    // drops its own chunks for hidden hexes — it knows the mask).
    const changedSet = new Set(changed);
    let chunkDelta = null;
    if (revealed) {
      const wt = maps[WORLD_KEY] && maps[WORLD_KEY].terrain;
      if (wt && wt.chunks) {
        for (const ck of Object.keys(wt.chunks)) {
          if (changedSet.has(chunkFogHexKey(ck))) {
            (chunkDelta = chunkDelta || {})[ck] = wt.chunks[ck];
          }
        }
      }
    }
    for (const sock of io.sockets.sockets.values()) {
      if (!sock.username || isGM(sock.username) || !isUnifiedKey(sock.currentMapKey || '')) continue;
      const m = getMap(WORLD_KEY);
      for (const obj of Object.values(m.objects)) {
        if (ownsObject(sock.username, obj)) continue; // visible either way
        const p = obj.position || {};
        if (!changedSet.has(fogHexKeyAt(Number(p.x) || 0, Number(p.z) || 0))) continue;
        if (revealed) sock.emit('object-added', projectObjectFor(sock.username, obj));
        else sock.emit('object-deleted', { id: obj.id });
      }
      if (chunkDelta) sock.emit('terrain-updated', { chunks: chunkDelta });
    }
  });

  // --- GM-directed player cameras (View control): thin, GM-authorized relay.
  // The GM aims a world-space camera pose at chosen players; the server fans it
  // out as 'camera-goto' (optionally locking their controls until
  // 'camera-release' → 'camera-unlock'). Nothing persists — camera state is
  // ephemeral. Target matching goes by SPACE, not raw room: a GM on any unified
  // key (hex tiers keep their own Socket.IO rooms but show the same one world)
  // reaches every player on a unified key; a GM inside a pocket reaches only
  // that pocket's players.
  const finitePoint = (p) => p && ['x', 'y', 'z'].every(k => Number.isFinite(Number(p[k])));
  const numPoint = (p) => ({ x: Number(p.x), y: Number(p.y), z: Number(p.z) });
  function forEachCameraTarget(target, crossSpace, fn) {
    const gmKey = socket.currentMapKey || DEFAULT_MAP_KEY;
    const unified = isUnifiedKey(gmKey);
    for (const sock of io.sockets.sockets.values()) {
      if (sock === socket || !sock.username || isGM(sock.username)) continue;
      // Relocating commands (Bring to my view) carry a mapKey and reach the
      // target wherever they are; framing/release commands only touch players
      // already sharing the GM's space.
      if (!crossSpace) {
        const key = sock.currentMapKey || DEFAULT_MAP_KEY;
        if (unified ? !isUnifiedKey(key) : key !== gmKey) continue;
      }
      if (target !== 'all' && sock.username.toLowerCase() !== target) continue;
      fn(sock);
    }
  }
  socket.on('camera-command', (payload) => {
    if (!isGM(socket.username)) return;
    const pose = payload && payload.pose;
    if (!pose || !finitePoint(pose.pos) || !finitePoint(pose.look)) return;
    // A relocating command carries the GM's mapKey: the player joins that map
    // (crossing spaces, e.g. into a pocket) before landing on the pose.
    const mapKey = payload.mapKey ? String(payload.mapKey) : null;
    const msg = {
      pose: { pos: numPoint(pose.pos), look: numPoint(pose.look) },
      mode: payload.mode === 'snap' ? 'snap' : 'fly',
      lock: !!payload.lock
    };
    if (mapKey) msg.mapKey = mapKey;
    forEachCameraTarget(String(payload.target || 'all').toLowerCase(), !!mapKey,
      (sock) => sock.emit('camera-goto', msg));
  });
  socket.on('camera-release', (payload) => {
    if (!isGM(socket.username)) return;
    forEachCameraTarget(String((payload && payload.target) || 'all').toLowerCase(), true,
      (sock) => sock.emit('camera-unlock'));
  });

  socket.on('disconnect', () => {
    console.log(`[-] Client disconnected: ${socket.id} (${socket.username || 'unknown'})`);
    if (socket.username) broadcastPresence();
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
